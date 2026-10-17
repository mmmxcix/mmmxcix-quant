import { test } from "node:test";
import assert from "node:assert/strict";
import { onRequest as telegram } from "../functions/api/telegram.js";
import { onRequest as news } from "../functions/api/news.js";

// An all-failed aggregate is a fact about the next few seconds, not minutes.
// Both endpoints used to hand it out with their full success TTL (120 s / 90 s).

const maxAge = (res) => Number(/max-age=(\d+)/.exec(res.headers.get("cache-control"))?.[1]);
const ctx = (url) => ({ request: new Request(url), env: {}, waitUntil() {} });

async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test("telegram: every channel failing is cached ≤30 s and says so", async () => {
  const res = await withFetch(async () => new Response("down", { status: 503 }),
    () => telegram(ctx("https://quant.test/api/telegram")));
  const body = await res.json();
  assert.equal(body.items.length, 0);
  assert.equal(body.error, "channels_unavailable");
  assert.ok(maxAge(res) >= 15 && maxAge(res) <= 30, `max-age was ${maxAge(res)}`);
});

test("telegram: a normal result keeps the 120 s TTL", async () => {
  const page = `<div class="tgme_widget_message_text js-message_text">Hello world post</div>
    <a class="tgme_widget_message_date" href="https://t.me/x/1"><time datetime="2026-10-17T10:00:00+00:00"></time></a>`;
  const res = await withFetch(async () => new Response(page),
    () => telegram(ctx("https://quant.test/api/telegram")));
  assert.ok((await res.json()).items.length > 0);
  assert.equal(maxAge(res), 120);
});

test("news: every feed failing is cached ≤30 s, not 90 s", async () => {
  const res = await withFetch(async () => new Response("down", { status: 503 }),
    () => news(ctx("https://quant.test/api/news")));
  const body = await res.json();
  assert.equal(body.error, "feeds_unavailable");
  assert.ok(maxAge(res) >= 15 && maxAge(res) <= 30, `max-age was ${maxAge(res)}`);
});

test("news: a working feed keeps the 90 s TTL", async () => {
  const rss = `<rss><channel><item><title>Fed holds rates</title><link>https://x/1</link>
    <pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;
  const res = await withFetch(async () => new Response(rss),
    () => news(ctx("https://quant.test/api/news")));
  assert.ok((await res.json()).items.length > 0);
  assert.equal(maxAge(res), 90);
});
