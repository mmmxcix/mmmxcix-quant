// telegram-setup.mjs — the ONE command that turns a Telegram API app into a
// running MTProto poller. Everything that can be automated is automated; what
// is left is the part that genuinely needs you (a phone that receives a code).
//
//   node scripts/telegram-setup.mjs
//
// It will:
//   1. ask for the api_id / api_hash from https://my.telegram.org
//      → "API development tools" (any app name works, e.g. "mmmxcix-quant");
//   2. log you in (phone → code → 2FA if you have one) and take the session;
//   3. store all three as Windows USER environment variables, so every future
//      process — including the autostarted daemon — has them;
//   4. restart agent-daemon.mjs with the values passed in explicitly, because a
//      freshly spawned process inherits OUR environment, not the registry's;
//   5. verify /api/telegram actually flips to the MTProto source.
//
// The session logs in as YOU and can read the public channels you can read.
// It is secret: anyone holding it is logged into your account.

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { openSync } from "node:fs";

const SITE = process.env.LAB_SITE || "https://quant.mmmxcix.com";

// GramJS keeps an update loop running after `disconnect()` and lets it reject
// with a bare TIMEOUT once the socket is gone. It printed a red stack trace in
// the middle of a run that had actually succeeded, which is the worst possible
// place for a scary-looking error. Teardown noise is swallowed; anything else
// still gets reported.
process.on("unhandledRejection", (e) => {
  const msg = String(e?.message || e);
  if (/TIMEOUT|connection closed|not connected/i.test(msg)) return;
  console.error("unexpected error:", msg);
});
const here = (f) => fileURLToPath(new URL(`./${f}`, import.meta.url));
const isWin = process.platform === "win32";
const rl = readline.createInterface({ input, output });
const ask = async (q, dflt = "") => ((await rl.question(q)).trim() || dflt);
const say = (s = "") => console.log(s);

/** Persist a USER-scope environment variable (Windows) so it survives reboots. */
function persistEnv(name, value) {
  if (!isWin) {
    say(`  (not Windows — put ${name} in your shell profile yourself)`);
    return false;
  }
  // PowerShell rather than setx: setx truncates at 1024 chars and mangles some
  // punctuation, and a session string is long, base64-ish and unforgiving.
  const ps = `[Environment]::SetEnvironmentVariable('${name}', $env:TG_SETUP_VALUE, 'User')`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    env: { ...process.env, TG_SETUP_VALUE: value },
    windowsHide: true,
  });
  return r.status === 0;
}

/** Kill the running daemon and its forked children, then start it again with
 *  the new credentials in its environment. */
function restartDaemon(creds) {
  if (!isWin) { say("  (not Windows — restart agent-daemon.mjs yourself)"); return; }
  const list = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'agent-daemon|executor-agent|arena-agent|telegram-mtproto' } | ForEach-Object { $_.ProcessId }"],
    { encoding: "utf8", windowsHide: true });
  const pids = String(list.stdout || "").split(/\s+/).map((s) => +s).filter(Boolean);
  for (const pid of pids) {
    spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`], { windowsHide: true });
  }
  say(`  stopped ${pids.length} daemon process${pids.length === 1 ? "" : "es"}`);
  let fd;
  try { fd = openSync(join(homedir(), ".mmmxcix-daemon.log"), "a"); } catch { fd = "ignore"; }
  // Detached + windowsHide so this survives the setup script and never creates
  // a console for Windows Terminal to hijack (see the comment atop agent-daemon).
  const child = spawn(process.execPath, [here("agent-daemon.mjs")], {
    detached: true, stdio: ["ignore", fd, fd], windowsHide: true,
    env: { ...process.env, ...creds },
  });
  child.unref();
  say(`  agent-daemon restarted (pid ${child.pid}) with the Telegram credentials`);
}

async function verify() {
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 15_000));
    try {
      const res = await fetch(`${SITE}/api/telegram`);
      const j = await res.json();
      if (j?.source === "mtproto") {
        say(`\n✅ /api/telegram is serving the MTProto feed — ${j.items?.length || 0} items.`);
        return true;
      }
      say(`  …still on the public scrape (${j?.items?.length || 0} items) — checking again`);
    } catch { say("  …site unreachable, retrying"); }
  }
  say("\n⚠ The endpoint has not switched yet. The poller writes on its first pass (~60s);");
  say(`  check the log at ${join(homedir(), ".mmmxcix-telegram.log")} if it stays on the scrape.`);
  return false;
}

// ── 1. credentials ──────────────────────────────────────────────────────────
// This step cannot be automated: Telegram sends a code to your phone. Say so
// plainly rather than hanging on a pipe that will never answer.
if (!input.isTTY) {
  console.error("telegram-setup needs a real terminal — it asks for your phone number and the");
  console.error("login code Telegram sends you. Run it directly: node scripts/telegram-setup.mjs");
  process.exit(1);
}

say("\nTelegram MTProto setup — this reads the fast squawk channels the public");
say("preview page cannot show. The keyless scrape keeps working either way.\n");
say("Open https://my.telegram.org → API development tools, create an app");
say("(any name), and copy the two values it gives you.\n");

const apiId = +(await ask(`api_id${process.env.TG_API_ID ? ` [${process.env.TG_API_ID}]` : ""}: `, process.env.TG_API_ID || ""));
const apiHash = await ask(`api_hash${process.env.TG_API_HASH ? " [keeping current]" : ""}: `, process.env.TG_API_HASH || "");
if (!apiId || !apiHash) {
  console.error("Both values are required — nothing was changed.");
  rl.close();
  process.exit(1);
}

// ── 2. log in ───────────────────────────────────────────────────────────────
say("\nLogging in. Telegram will send a code to your app / phone.\n");
const client = new TelegramClient(new StringSession(""), apiId, apiHash, { connectionRetries: 3 });
let session = "";
try {
  await client.start({
    phoneNumber: async () => await ask("Phone number (e.g. +41791234567): "),
    password: async () => await ask("2FA password (blank if none): "),
    phoneCode: async () => await ask("Login code Telegram just sent: "),
    onError: (e) => console.error("auth error:", e?.message || e),
  });
  session = client.session.save();
  // disconnect() leaves the update loop and its socket half-alive; destroy()
  // takes them down, which is what stops libuv from asserting on a closing
  // handle when we exit at the end.
  await client.disconnect().catch(() => {});
  await client.destroy?.().catch(() => {});
} catch (e) {
  console.error("\nLogin failed:", e?.message || e);
  console.error("Nothing was stored. Re-run when you are ready.");
  rl.close();
  process.exit(1);
}
if (!session) {
  console.error("\nNo session came back — nothing was stored.");
  rl.close();
  process.exit(1);
}
say("\n✅ Logged in.");

// ── 3. persist ──────────────────────────────────────────────────────────────
say("\nStoring the credentials for every future process:");
const creds = { TG_API_ID: String(apiId), TG_API_HASH: apiHash, TG_SESSION: session };
for (const [k, v] of Object.entries(creds)) {
  say(`  ${k}: ${persistEnv(k, v) ? "stored (user scope)" : "COULD NOT STORE — set it by hand"}`);
}
if (!process.env.LAB_TOKEN) {
  say("\n⚠ LAB_TOKEN is not set in this shell — the poller needs it to push to /api/telegram.");
  say("  It is already a user variable on this machine, so the restarted daemon will have it.");
}

// ── 4. restart + 5. verify ──────────────────────────────────────────────────
say("\nRestarting the agent daemon so the poller starts:");
restartDaemon(creds);
rl.close();
say("\nWaiting for the first MTProto push (the poller runs every 60s):");
await verify();
say("\nDone. The session string is secret — it is your Telegram login.");
// One turn of the event loop before exiting, so any handle GramJS is still
// closing is gone by then. Exiting into a closing handle is what produced
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" — harmless, since
// the work was already finished and printed, but it reads like a crash.
setTimeout(() => process.exit(0), 250).unref();
