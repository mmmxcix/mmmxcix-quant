// Statements → themes → baskets → what happened next.
//
// The properties that would make a RESULT wrong, not merely ugly:
//
//   · entry is the first OPEN after the statement, and the reaction session is
//     the first CLOSE after it — a statement made at 14:00 cannot be traded at
//     that morning's open, and a study that lets it produces the same kind of
//     fiction the Form 4 project already paid for once
//   · a statement is a person committing to something, not a market fact
//   · a theme refuses rather than guesses: too few events, or a basket too small
//     to be a basket, is a stated refusal and never a median
//   · the placebo finds nothing when there is nothing, and something when there is

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractStatements, fingerprint, parseStatement, SPEAKERS } from "../src/lib/statements/parse.js";
import { allTickers, assignThemes, THEMES, themesFor } from "../src/lib/statements/themes.js";
import { parseJson, parseRound1, parseRound2, reconcile } from "../src/lib/statements/extract.js";
import {
  buildCalendar, entryIndexFor, indexCandles, median, placeboShift, priceEvent,
  quantile, reactionIndexFor, studyTheme, summarise,
} from "../src/lib/statements/study.js";

const SEC_DAY = 86_400;
// A US session opens 13:30 UTC and closes 20:00 — the convention the whole
// entry/reaction distinction rests on.
const OPEN = Date.UTC(2024, 0, 2, 13, 30) / 1000;

function series({ days = 400, start = 50, drift = 0, t0 = OPEN, volume = 200_000 } = {}) {
  const out = [];
  let px = start;
  for (let i = 0; i < days; i++) {
    const open = px;
    px *= 1 + drift;
    out.push({ time: t0 + i * SEC_DAY, open, high: Math.max(open, px), low: Math.min(open, px), close: px, volume });
  }
  return out;
}

// ── parsing ─────────────────────────────────────────────────────────────────

test("the caps house style parses into speaker, subject and quote", () => {
  const s = parseStatement("TRUMP ON IRAN: PRETTY SOON I'LL BE DECLARING HORMUZ STRAIT A TERRITORY OF THE UNITED STATES (@WalterBloomberg)");
  assert.equal(s.speakerId, "trump");
  assert.equal(s.subject, "IRAN");
  assert.equal(s.form, "colon");
  assert.match(s.quote, /^PRETTY SOON/);
  assert.doesNotMatch(s.quote, /WalterBloomberg/, "the channel signature is stripped, not quoted");
});

test("a title before the name still resolves to the speaker", () => {
  const s = parseStatement("U.S. DEFENSE SECRETARY HEGSETH ON IRAN: U.S. CAN HOLD BLOCKADE AS LONG AS NEEDED");
  assert.equal(s.speakerId, "hegseth");
  assert.equal(s.subject, "IRAN");
});

test("the reported style is recognised too", () => {
  const s = parseStatement("Ukraine's military strikes Russian missile factory in Samara, Zelenskiy says|FJ");
  assert.equal(s.speakerId, "zelensky");
  assert.equal(s.form, "reported");
  assert.doesNotMatch(s.quote, /\|FJ/);
});

test("a market fact is not a statement, even with a name in it", () => {
  assert.equal(parseStatement("$AMD - AMD EYES $5 BILLION DEBT SALE FOR AI EXPANSION"), null);
  assert.equal(parseStatement("DIESEL CRACKS RISE ABOVE $98.00, AN ALL-TIME HIGH"), null);
  assert.equal(parseStatement("GOLD FALLS BELOW 3000"), null);
  // A speaker name with no reporting verb and no colon is a mention, not a quote.
  assert.equal(parseStatement("MARKETS AWAIT THE POWELL TESTIMONY LATER THIS WEEK"), null);
});

test("a colon far into a sentence does not fake the house style", () => {
  const long = "TRUMP SPOKE FOR AN HOUR ABOUT MANY THINGS AND THEN THE REPORTER ASKED A QUESTION ABOUT POLICY: WHAT NOW";
  const s = parseStatement(long);
  // It may still parse via a reporting verb, but never as the caps colon form
  // with a 100-character "speaker segment".
  assert.ok(!s || s.form !== "colon");
});

test("a repost of the same line inside the window counts once, at the earliest time", () => {
  const t = Date.UTC(2026, 0, 5, 12, 0);
  const st = extractStatements([
    // The fuller write-up, seconds later, with a verb changed — the real shape.
    { time: t + 60_000, text: "TRUMP ON OIL: WE ARE GOING TO DRILL BABY DRILL AND CUT PRICES", channel: "a" },
    { time: t, text: "TRUMP ON OIL: WE WILL DRILL BABY DRILL AND CUT PRICES", channel: "a" },
    // Hours later it is a fresh statement again, not a repost.
    { time: t + 3 * 3600_000, text: "TRUMP ON OIL: WE WILL DRILL BABY DRILL AND CUT PRICES", channel: "a" },
    // A different statement in the same minute must NOT be swallowed.
    { time: t + 90_000, text: "TRUMP ON CHINA: TARIFFS ON EVERY SEMICONDUCTOR THEY SHIP", channel: "a" },
  ]);
  assert.equal(st.length, 3, "the near-instant reword collapses; the later repeat and the other topic do not");
  assert.equal(st[0].at, t, "the earliest occurrence is the one that survives");
  assert.deepEqual(fingerprint("TRUMP: WE WILL DRILL, BABY!").sort(), ["BABY", "DRILL", "TRUMP"]);
});

test("every speaker pattern is anchored enough not to fire on ordinary prose", () => {
  const prose = "THE MARKET CLOSED MIXED ON THURSDAY AFTER A QUIET SESSION WITH NO CATALYST";
  for (const sp of SPEAKERS) assert.ok(!sp.match.test(prose), `${sp.id} matched ordinary prose`);
});

// ── themes ──────────────────────────────────────────────────────────────────

test("a theme matches on the mechanism, and the veto keeps weapons out of the fuel basket", () => {
  const fuel = themesFor({ quote: "WE WILL BUILD SMALL MODULAR REACTORS ACROSS THE COUNTRY", subject: null });
  assert.ok(fuel.includes("nuclear"));
  const weapons = themesFor({ quote: "WE DO NOT NEED A DEAL WITH IRAN TO GET THEIR ENRICHED URANIUM", subject: null });
  assert.ok(!weapons.includes("nuclear"), "non-proliferation is not uranium demand");
});

test("a statement may belong to several themes, and most belong to none", () => {
  const many = themesFor({ quote: "WE WILL PUT TARIFFS ON CHINESE CHIPS", subject: null });
  assert.ok(many.includes("semis") && many.includes("china_adrs") && many.includes("tariff_retail"));
  assert.deepEqual(themesFor({ quote: "I HAD A VERY GOOD CALL WITH THE PRIME MINISTER", subject: null }), []);
  assert.equal(assignThemes([{ quote: "NOTHING INVESTABLE HERE", subject: null }]).length, 0);
});

test("every theme is well formed and every basket is US tickers", () => {
  const ids = new Set();
  for (const t of THEMES) {
    assert.ok(!ids.has(t.id), `duplicate theme id ${t.id}`);
    ids.add(t.id);
    assert.ok(t.why && t.why.length > 10, `${t.id} has no stated mechanism`);
    assert.ok(t.basket.length >= 2, `${t.id} basket is empty`);
    for (const s of t.basket) assert.match(s, /^[A-Z][A-Z.\-]{0,5}$/, `${t.id}: ${s} is not a ticker`);
    assert.equal(new Set(t.basket).size, t.basket.length, `${t.id} repeats a ticker`);
  }
  assert.ok(allTickers().length > 100);
});

// ── the entry rule ──────────────────────────────────────────────────────────

test("a statement made mid-session is NOT tradeable at that session's open", () => {
  const cal = buildCalendar(series({ days: 10 }));
  const dayIdx = 4;
  const openMs = cal.times[dayIdx] * 1000;

  // 06:00 UTC, hours before the bell: tradeable at THAT day's open.
  assert.equal(entryIndexFor(cal, openMs - 7.5 * 3600_000), dayIdx);
  // 14:00 UTC, half an hour after the bell: the open has gone, entry is tomorrow.
  assert.equal(entryIndexFor(cal, openMs + 0.5 * 3600_000), dayIdx + 1);
  // Both of them were absorbed by THAT day's session — its close is later still.
  assert.equal(reactionIndexFor(cal, openMs - 7.5 * 3600_000), dayIdx);
  assert.equal(reactionIndexFor(cal, openMs + 0.5 * 3600_000), dayIdx);
  // After the close, both roll to the next session.
  const afterClose = openMs + 7 * 3600_000;
  assert.equal(entryIndexFor(cal, afterClose), dayIdx + 1);
  assert.equal(reactionIndexFor(cal, afterClose), dayIdx + 1);
});

test("no bar left is refused rather than clamped to the last one", () => {
  const cal = buildCalendar(series({ days: 5 }));
  assert.equal(entryIndexFor(cal, cal.times[4] * 1000 + 86_400_000), -1);
});

// ── pricing an event ────────────────────────────────────────────────────────

function priceBook(symbols, opts) {
  const out = {};
  for (const s of symbols) out[s] = indexCandles(series(opts));
  return out;
}

test("an event is refused when the basket cannot field enough priceable names", () => {
  const cal = buildCalendar(series({ days: 60 }));
  const prices = priceBook(["A", "B"], { days: 60 });
  const ev = priceEvent({ at: cal.times[30] * 1000 - 3600_000, basket: ["A", "B", "C", "D"], prices, cal, horizons: [5], minNames: 4 });
  assert.equal(ev, null, "two names is not a basket, and a partial one is not a substitute");
});

test("a basket that rises after the statement shows up, net of costs", () => {
  const cal = buildCalendar(series({ days: 120, drift: 0 }));
  const prices = priceBook(["A", "B", "C", "D", "E"], { days: 120, drift: 0.01 });
  const ev = priceEvent({ at: cal.times[60] * 1000 - 3600_000, basket: ["A", "B", "C", "D", "E"], prices, cal, horizons: [5], feeBps: 10, minNames: 4 });
  assert.equal(ev.names, 5);
  assert.equal(ev.sameSession, true, "a pre-open statement is tradeable in the session that absorbs it");
  // Five days of 1% compounding, less a 20 bp round trip, against a flat bench.
  assert.ok(Math.abs(ev.perHorizon[5].excessPct - (Math.pow(1.01, 5) * (1 - 0.002) - 1) * 100) < 0.05);
  assert.ok(ev.perHorizon[5].dispersionPct < 1e-6, "identical names have no cross-sectional spread");
});

test("the illiquid and the cheap are screened out before the basket is formed", () => {
  const cal = buildCalendar(series({ days: 60 }));
  const prices = {
    ...priceBook(["A", "B"], { days: 60 }),
    ...priceBook(["C", "D"], { days: 60, start: 0.4 }),        // sub-dollar
    ...priceBook(["E", "F"], { days: 60, volume: 100 }),       // ~$5k a day
  };
  const at = cal.times[30] * 1000 - 3600_000;
  const basket = ["A", "B", "C", "D", "E", "F"];
  assert.equal(priceEvent({ at, basket, prices, cal, horizons: [5], minNames: 4, universe: { minPrice: 5, minDollarVol: 1e6 } }), null);
  assert.ok(priceEvent({ at, basket, prices, cal, horizons: [5], minNames: 4, universe: { minPrice: 0, minDollarVol: 0 } }));
});

// ── summarising and refusing ────────────────────────────────────────────────

test("the summary leads with the median and reports the spread around it", () => {
  const ev = (x) => ({ perHorizon: { 5: { excessPct: x } }, reactionExcessPct: null, sameSession: false });
  const s = summarise([ev(-1), ev(0), ev(1), ev(2), ev(40)], [5]).horizons[5];
  assert.equal(s.n, 5);
  assert.equal(s.medianPct, 1, "one 40% outlier must not become the headline");
  assert.equal(s.meanPct, 8.4);
  assert.equal(s.hitRate, 0.6);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 3);
});

test("a theme with a two-name basket is unmeasurable, not merely quiet", () => {
  const cal = buildCalendar(series({ days: 120 }));
  const prices = priceBook(["GEO", "CXW"], { days: 120 });
  const statements = Array.from({ length: 100 }, (_, i) => ({ at: cal.times[10 + i] * 1000 - 3600_000 }));
  const r = studyTheme({ themeId: "immigration", statements, prices, cal, minNames: 4 });
  assert.equal(r.events, 0);
  assert.equal(r.basketPriceable, 2);
  assert.match(r.verdict.reason, /unmeasurable/);
  assert.equal(r.verdict.finding, false);
});

test("below the event floor the median is computed but never called a finding", () => {
  const cal = buildCalendar(series({ days: 200 }));
  const prices = priceBook(["CCJ", "LEU", "UEC", "BWXT", "SMR"], { days: 200, drift: 0.02 });
  const statements = Array.from({ length: 5 }, (_, i) => ({ at: cal.times[50 + i * 10] * 1000 - 3600_000 }));
  const r = studyTheme({ themeId: "nuclear", statements, prices, cal, minNames: 4, minEvents: 30, placeboRuns: 10 });
  assert.equal(r.events, 5);
  assert.ok(r.summary.horizons[5].medianPct > 0, "the number exists");
  assert.equal(r.verdict.enough, false, "…and is refused anyway");
  assert.equal(r.verdict.finding, false);
  assert.equal(r.placebo, null, "no placebo is even run below the floor");
});

// ── the placebo ─────────────────────────────────────────────────────────────

test("a basket that always drifts up is NOT a finding — the shift reproduces it", () => {
  const cal = buildCalendar(series({ days: 600, drift: 0 }));
  const basket = ["A", "B", "C", "D", "E"];
  const prices = priceBook(basket, { days: 600, drift: 0.001 });   // a steady tailwind, no timing
  const statements = Array.from({ length: 40 }, (_, i) => ({ at: cal.times[100 + i * 5] * 1000 - 3600_000 }));
  const real = median(statements
    .map((s) => priceEvent({ at: s.at, basket, prices, cal, horizons: [5], feeBps: 0, minNames: 4 })?.perHorizon[5]?.excessPct)
    .filter((x) => x != null));
  const p = placeboShift({ statements, basket, prices, cal, horizon: 5, feeBps: 0, minNames: 4, realMedian: real, runs: 60, seed: 3 });
  assert.ok(real > 0, "the drift is really there");
  assert.ok(p.pValue > 0.05, `constant drift must not read as timing (p = ${p.pValue})`);
});

test("a move that only happens right after the statements does survive the shift", () => {
  // 900 sessions, events 30 apart: the five bumped days are ~14% of the
  // calendar. Pack them closer and a random shift lands on the effect as often
  // as it misses — the placebo then correctly refuses to call it timing, which
  // is worth knowing about the method: its power depends on how much of the
  // calendar the event windows already cover.
  const days = 900;
  const cal = buildCalendar(series({ days, drift: 0 }));
  const basket = ["A", "B", "C", "D", "E"];
  const prices = {};
  // Flat everywhere except +0.4% a session across the five sessions after each
  // event. Built from a RETURN series and integrated once — mutating prices in
  // place inside the loop compounds into a permanent uptrend, which is a drift
  // test wearing a timing test's name.
  const eventIdx = Array.from({ length: 25 }, (_, i) => 100 + i * 30);
  const bump = new Array(days).fill(0);
  for (const e of eventIdx) for (let k = e; k < e + 5 && k < days; k++) bump[k] = 0.004;
  for (const sym of basket) {
    const c = [];
    let px = 50;
    for (let i = 0; i < days; i++) {
      const open = px;
      px *= 1 + bump[i];
      c.push({ time: OPEN + i * SEC_DAY, open, high: Math.max(open, px), low: Math.min(open, px), close: px, volume: 200_000 });
    }
    prices[sym] = indexCandles(c);
  }
  const statements = eventIdx.map((i) => ({ at: cal.times[i] * 1000 - 3600_000 }));
  const real = median(statements
    .map((s) => priceEvent({ at: s.at, basket, prices, cal, horizons: [5], feeBps: 0, minNames: 4 })?.perHorizon[5]?.excessPct)
    .filter((x) => x != null));
  const p = placeboShift({ statements, basket, prices, cal, horizon: 5, feeBps: 0, minNames: 4, realMedian: real, runs: 100, seed: 3 });
  assert.ok(real > 1, `the planted move should be ~2% (was ${real.toFixed(2)}%)`);
  assert.ok(p.pValue <= 0.05, `a real, timed effect should survive the shift (p = ${p.pValue})`);
});

// ── the reporting verb has to be the SPEAKER'S ──────────────────────────────

test("a reporting verb belonging to someone else is not the speaker's statement", () => {
  // The bug this pins, found on the first live run: both a roster name and a
  // "say" in one headline, and the person saying it is "sources".
  assert.equal(parseStatement("Trump expected to attend White House meeting with crypto CEOs, sources say"), null);
  assert.equal(parseStatement("Analysts said the Powell testimony would set the tone for the week"), null);
  // …while the genuine reported form still parses.
  assert.ok(parseStatement("Oil output will not be cut further, OPEC says"));
  assert.ok(parseStatement("Putin warns of consequences if the sanctions stand"));
});

test("the source id travels with the statement so a second classifier can join on it", () => {
  const st = extractStatements([
    { id: "tg:chan/42", time: Date.UTC(2026, 0, 5), text: "TRUMP ON OIL: WE WILL DRILL EVERYWHERE", channel: "chan" },
  ]);
  assert.equal(st[0].sourceId, "tg:chan/42");
});

// ── the model's half ────────────────────────────────────────────────────────

test("round 1 is validated against the headlines it was shown", () => {
  const headlines = [{ id: "a", text: "TRUMP: WE WILL DRILL" }, { id: "b", text: "OIL RISES 3%" }];
  const out = parseRound1(JSON.stringify({
    statements: [
      { idx: 0, speaker: "Donald Trump", role: "US President", quote: "We will drill", isStatement: true },
      { idx: 1, speaker: "", quote: "", isStatement: true },
      { idx: 9, speaker: "Ghost", quote: "never given", isStatement: true },
      { idx: 0, speaker: "Donald Trump", quote: "", isStatement: true },
    ],
  }), headlines);
  assert.equal(out.length, 1, "an out-of-range index and an empty quote are both dropped");
  assert.equal(out[0].source.id, "a");
});

test("an invented theme id is dropped, never mapped to the nearest real one", () => {
  const statements = [{ speaker: "Donald Trump", quote: "We will build reactors" }];
  const out = parseRound2(JSON.stringify({
    assignments: [{ idx: 0, themes: ["nuclear", "fusion_energy", "vibes"], confidence: "high", because: "reactor builders" }],
  }), statements);
  assert.deepEqual(out[0].themes, ["nuclear"]);
  assert.deepEqual(out[0].invented, ["fusion_energy", "vibes"], "…and the fact that it invented them is recorded");
});

test("a reply that is prose, fenced, or malformed yields nothing rather than guessing", () => {
  assert.deepEqual(parseRound1("I think headline 0 is a statement by Trump.", [{ id: "a" }]), []);
  assert.equal(parseJson("```json\n{\"statements\":[]}\n```").statements.length, 0);
  assert.equal(parseJson("not json at all"), null);
});

test("reconcile keeps the measured assignment and only records the model's", () => {
  const agree = reconcile({ lexiconThemes: ["nuclear"], modelThemes: ["nuclear"] });
  assert.equal(agree.agreement, "agree");
  assert.deepEqual(agree.themes, ["nuclear"], "the lexicon's answer is the one that carries numbers");

  const wider = reconcile({ lexiconThemes: ["oil_gas"], modelThemes: ["oil_gas", "tankers"] });
  assert.equal(wider.agreement, "model-wider");
  assert.deepEqual(wider.themes, ["oil_gas"], "the model's extra theme has no measured history and is NOT adopted");
  assert.deepEqual(wider.onlyModel, ["tankers"]);

  assert.equal(reconcile({ lexiconThemes: ["semis"], modelThemes: [] }).agreement, "model-narrow");
  assert.equal(reconcile({ lexiconThemes: ["semis"], modelThemes: ["gold"] }).agreement, "disagree");
  assert.equal(reconcile({ lexiconThemes: [], modelThemes: [] }).agreement, "agree");
});
