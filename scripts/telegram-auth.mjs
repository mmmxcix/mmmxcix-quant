// telegram-auth.mjs — ONE-TIME login to produce a Telegram session string for
// the MTProto poller. Run it yourself in a terminal (it needs your phone + the
// login code Telegram sends you):
//
//   1. Get an API app at https://my.telegram.org → "API development tools"
//      (gives you an api_id and api_hash).
//   2. Run:
//        set TG_API_ID=123456          (Windows cmd)   — or  $env:TG_API_ID=123456  (PowerShell)
//        set TG_API_HASH=abcdef...      (Windows cmd)
//        node scripts/telegram-auth.mjs
//   3. Enter your phone (+41…), the code Telegram sends, and your 2FA password
//      (if you have one). It prints a SESSION STRING.
//   4. Keep that string SECRET and set it as TG_SESSION for the poller.
//
// The session logs in as YOU — it can read the public channels you can read.

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const apiId = +(process.env.TG_API_ID || 0);
const apiHash = process.env.TG_API_HASH || "";
if (!apiId || !apiHash) {
  console.error("Set TG_API_ID and TG_API_HASH first (from https://my.telegram.org → API development tools).");
  process.exit(1);
}

const rl = readline.createInterface({ input, output });
const ask = (q) => rl.question(q);

const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3 });
try {
  await client.start({
    phoneNumber: async () => (await ask("Phone number (e.g. +41791234567): ")).trim(),
    password: async () => (await ask("2FA password (leave blank if none): ")).trim(),
    phoneCode: async () => (await ask("Login code Telegram just sent you: ")).trim(),
    onError: (e) => console.error("auth error:", e?.message || e),
  });
  console.log("\n✅ Logged in. Your SESSION STRING (keep it SECRET) — set it as TG_SESSION:\n");
  console.log(client.session.save());
  console.log("\nThen run the poller with TG_API_ID, TG_API_HASH, TG_SESSION and LAB_TOKEN set.");
  await client.disconnect();
} catch (e) {
  console.error("failed:", e?.message || e);
} finally {
  rl.close();
  process.exit(0);
}
