// telegram-mtproto.mjs — poll OSINT/finance channels via Telegram's native
// MTProto protocol (GramJS) and push them to /api/telegram. Unlike the t.me/s/
// scrape, MTProto reads EVERYTHING — including the fast image-caption market
// tickers (FirstSquawk, DeItaone, Walter Bloomberg…) the preview page can't show.
//
// Needs TG_API_ID, TG_API_HASH, TG_SESSION (from telegram-auth.mjs) and LAB_TOKEN.
// Run persistently: node scripts/telegram-mtproto.mjs  (polls every 60s).

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const apiId = +(process.env.TG_API_ID || 0);
const apiHash = process.env.TG_API_HASH || "";
const session = process.env.TG_SESSION || "";
const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";
const TOKEN = process.env.LAB_TOKEN;
const POLL_MS = +(process.env.TG_POLL_MS || 60_000);

// channel:tag pairs — the fast market tickers first, then breaking + geopolitics.
const CHANNELS = (process.env.TG_CHANNELS ||
  "FirstSquawk:finance,DeItaone:finance,financialjuice:finance,WatcherGuru:crypto,cointelegraph:crypto,disclosetv:breaking,insiderpaper:breaking,clashreport:geopolitics,WarMonitors:geopolitics,sentdefender:osint"
).split(",").map((s) => { const [user, tag] = s.split(":"); return { user: user.trim(), tag: (tag || "osint").trim() }; }).filter((c) => c.user);

if (!apiId || !apiHash || !session) { console.error("Set TG_API_ID, TG_API_HASH and TG_SESSION (run telegram-auth.mjs first)."); process.exit(1); }
if (!TOKEN) { console.error("LAB_TOKEN is not set."); process.exit(1); }

const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 5 });
await client.connect();
console.log(`[${new Date().toISOString()}] tg-mtproto connected — ${CHANNELS.length} channels, ${POLL_MS / 1000}s poll`);

async function poll() {
  const items = [];
  for (const { user, tag } of CHANNELS) {
    try {
      const msgs = await client.getMessages(user, { limit: 8 });
      for (const m of msgs) {
        const text = String(m.message || "").trim();
        if (text.length < 4) continue; // skip pure-media / service messages
        items.push({ channel: user, tag, text: text.slice(0, 500), url: `https://t.me/${user}/${m.id}`, time: (m.date || 0) * 1000 });
      }
    } catch (e) { console.error(`  ${user}: ${String(e?.message || e).slice(0, 60)}`); }
  }
  items.sort((a, b) => b.time - a.time);
  try {
    const r = await fetch(`${SITE}/api/telegram`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN, items: items.slice(0, 150) }),
    });
    console.log(`[${new Date().toISOString()}] tg-mtproto: pushed ${items.length} items (HTTP ${r.status})`);
  } catch (e) { console.error(`push failed: ${e?.message || e}`); }
}

await poll();
setInterval(poll, POLL_MS);
