// The transport under the event channel. Every "llm unavailable (empty
// response)" line in the agent's history came from two lines that nothing could
// reach: OmniRoute answers with an SSE stream even when the request says
// `stream: false`, and the caller went straight to res.json(). A working model
// failed in exactly the same way as a dead one, which is why the channel looked
// flaky for weeks instead of broken.
import test from "node:test";
import assert from "node:assert/strict";

import { readCompletion, parseTheses } from "../src/lib/argus/llm.js";

const sse = (...chunks) =>
  chunks.map((c) => `data: ${JSON.stringify(c)}`).join("\n") + "\ndata: [DONE]\n";

test("a plain JSON completion still reads", () => {
  const out = readCompletion('{"model":"openai/gpt-oss-20b","choices":[{"message":{"content":"hello"}}]}');
  assert.deepEqual(out, { content: "hello", model: "openai/gpt-oss-20b" });
});

test("an SSE stream is joined back into one message — the actual bug", () => {
  const body = sse(
    { model: "openai/gpt-oss-20b", choices: [{ delta: { content: '[{"symbol":"USO"' } }] },
    { choices: [{ delta: { content: ',"side":"long"}]' } }] },
  );
  const out = readCompletion(body);
  assert.equal(out.content, '[{"symbol":"USO","side":"long"}]');
  assert.equal(out.model, "openai/gpt-oss-20b", "the SERVED model is reported, not the requested one");
  // And it survives the parser the agent actually uses.
  assert.deepEqual(parseTheses(out.content).map((t) => [t.symbol, t.side]), [["USO", "long"]]);
});

test("a chunk split mid-JSON is skipped, not treated as a failure", () => {
  const body = 'data: {"choices":[{"delta":{"content":"a"}}]}\ndata: {"choices":[{"delt\ndata: {"choices":[{"delta":{"content":"b"}}]}\ndata: [DONE]\n';
  assert.equal(readCompletion(body).content, "ab");
});

test("an error payload surfaces its message instead of reading as empty", () => {
  // This is the difference between "the model is gone" and "empty response" —
  // the decommissioned groq default 404s, and that has to be legible in the log.
  assert.throws(() => readCompletion('{"error":{"message":"The model `llama-3.3-70b-versatile` has been decommissioned"}}'),
    /decommissioned/);
  assert.throws(() => readCompletion(sse({ error: { message: "upstream refused" } })), /upstream refused/);
});

test("a non-JSON body is named as such rather than silently empty", () => {
  assert.throws(() => readCompletion("<html>502 Bad Gateway</html>"), /unparseable/);
});

test("an empty or contentless body returns empty rather than throwing", () => {
  // A reasoning model that spends its whole ceiling on `reasoning` returns a
  // structurally valid reply with no content; the caller turns that into
  // "empty response" and falls through to the next model, which is correct.
  assert.equal(readCompletion('{"choices":[{"message":{"reasoning":"thinking…"}}]}').content, "");
  // An SSE body with no content chunks is a real, empty answer.
  assert.equal(readCompletion(sse({ choices: [{ delta: {} }] })).content, "");
  // A truly empty body is a broken response, and saying so beats reporting "".
  assert.throws(() => readCompletion(""), /unparseable/);
});
