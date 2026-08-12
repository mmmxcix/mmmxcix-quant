// cli-llm-shim.mjs — expose a local coding CLI (that runs on YOUR Claude
// subscription, e.g. `claude -p`) as an OpenAI-compatible endpoint, so the
// Backtest builder can use it WITHOUT an API bill.
//
// Why a separate endpoint from OmniRoute: the builder has its own config, so you
// point ONLY the builder here. Argus and the Cortex agents keep their own
// OmniRoute — your subscription limit is never burned by background work.
//
// Run it:
//   node scripts/cli-llm-shim.mjs
// then in Backtest → AI panel enable "CLI (subscription)" (default URL below).
//
// Configure the CLI it drives:
//   CLI_SHIM_CMD   the binary (default "claude")
//   CLI_SHIM_ARGS  its args   (default "-p" — Claude Code's non-interactive print
//                  mode; add e.g. "--model claude-opus-5" for a specific model)
//   CLI_SHIM_PORT  listen port (default 8899)
//   CLI_SHIM_ORIGIN allowed CORS origin (default "*")

import http from "node:http";
import { spawn } from "node:child_process";

const PORT = +(process.env.CLI_SHIM_PORT || 8899);
const CLI = process.env.CLI_SHIM_CMD || "claude";
const CLI_ARGS = (process.env.CLI_SHIM_ARGS || "-p").split(" ").filter(Boolean);
const ORIGIN = process.env.CLI_SHIM_ORIGIN || "*";
const TIMEOUT_MS = +(process.env.CLI_SHIM_TIMEOUT_MS || 120000);

function cors(res) {
  res.setHeader("access-control-allow-origin", ORIGIN);
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, authorization");
}

// Drive the CLI once with the prompt on stdin; return its stdout. Bounded so a
// hung CLI can't wedge the shim.
function runCli(prompt) {
  return new Promise((resolve, reject) => {
    // windowsHide keeps the CLI from flashing a console window on every call.
    const child = spawn(CLI, CLI_ARGS, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("CLI timed out")); }, TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(err.slice(0, 400) || `CLI exited ${code} with no output`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

const server = http.createServer((req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Reachability probe (the builder pings /models before using an endpoint).
  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "cli", object: "model" }] }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const { messages = [] } = JSON.parse(body || "{}");
        // Flatten the OpenAI messages into one prompt for the CLI's print mode.
        const prompt = messages
          .map((m) => `${m.role === "system" ? "[SYSTEM]" : m.role === "assistant" ? "[ASSISTANT]" : "[USER]"}\n${m.content}`)
          .join("\n\n");
        const content = await runCli(prompt);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "cli-" + Date.now(), object: "chat.completion", model: "cli",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        }));
      } catch (e) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`CLI LLM shim → http://localhost:${PORT}/v1   (drives: ${CLI} ${CLI_ARGS.join(" ")})`);
  console.log(`Point the Backtest builder's "CLI (subscription)" URL here. Only the builder uses it.`);
});
