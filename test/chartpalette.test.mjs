import { test } from "node:test";
import assert from "node:assert/strict";
import { CHART_PRESETS, hexToTriplet } from "../src/lib/themeSettings.js";

// The chart palettes carry an invariant that is easy to break by hand and
// invisible until someone opens the app in the other theme: a candle BODY may
// be any colour, but only because an `ink` outline is drawn around it. Drop the
// ink and a white body disappears on the light background — which is exactly
// what "Signature" is (hollow white bearish candles).

const lum = (hex) => {
  const t = hexToTriplet(hex).split(" ").map(Number).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const LIGHT_BG = "#f8fafc";
const DARK_BG = "#0b0d12";

test("every preset defines a valid up/down pair", () => {
  assert.ok(CHART_PRESETS.length >= 2);
  for (const p of CHART_PRESETS) {
    assert.ok(hexToTriplet(p.up), `${p.id}: up must be a 6-digit hex`);
    assert.ok(hexToTriplet(p.down), `${p.id}: down must be a 6-digit hex`);
    assert.notEqual(p.up, p.down, `${p.id}: bull and bear must differ`);
  }
});

test("a candle body override requires an ink outline for BOTH themes", () => {
  // One ink is not enough. The same colour draws the outlines and the WICKS, so
  // a near-black ink that is perfect on the light theme erases every high and
  // low on the dark one — the bodies still show on their own contrast, which is
  // why this is easy to ship without noticing.
  for (const p of CHART_PRESETS) {
    if (p.candleUp || p.candleDown) {
      assert.ok(hexToTriplet(p.ink ?? ""), `${p.id}: candle overrides require an ink`);
      assert.ok(hexToTriplet(p.inkDark ?? ""), `${p.id}: …and a dark-theme counterpart`);
    }
    for (const slot of ["candleUp", "candleDown", "ink", "inkDark"]) {
      if (p[slot]) assert.ok(hexToTriplet(p[slot]), `${p.id}.${slot} must be a 6-digit hex`);
    }
  }
});

test("each ink is readable on the theme it is used for — wicks depend on it", () => {
  for (const p of CHART_PRESETS.filter((x) => x.ink)) {
    for (const [ink, bg, theme] of [[p.ink, LIGHT_BG, "light"], [p.inkDark, DARK_BG, "dark"]]) {
      const c = contrast(ink, bg);
      assert.ok(c >= 3, `${p.id}: ${theme} ink ${ink} is ${c.toFixed(2)}:1 on its own background`);
    }
  }
});

test("every candle body stays visible on both themes — by itself or by its outline", () => {
  // A body is legible if EITHER it separates from the page or the ink around it
  // does. That disjunction is the whole point of the ink: Signature's white body
  // is 1.05:1 on the light theme and is carried entirely by the outline, while
  // on dark the body does the work. 3:1 is WCAG 1.4.11 for graphical objects.
  for (const p of CHART_PRESETS) {
    for (const body of [p.candleUp || p.up, p.candleDown || p.down]) {
      for (const [bg, ink] of [[LIGHT_BG, p.ink], [DARK_BG, p.inkDark]]) {
        const best = Math.max(contrast(body, bg), ink ? contrast(ink, bg) : 0);
        assert.ok(best >= 3, `${p.id}: body ${body} on ${bg} reaches only ${best.toFixed(2)}:1`);
      }
    }
  }
});

test("Signature separates bull from bear better than a green/red pair can", () => {
  // Worth pinning, because it is the one real accessibility argument for this
  // palette. Green-vs-red is the trading convention and every such pair sits at
  // roughly equal LIGHTNESS — Classic measures 1.16:1 between its bull and bear
  // bodies — so a red-green colour blind reader has almost nothing left to go
  // on. Signature's bodies differ in lightness AND in fill (hollow white vs
  // solid rose), which is a second, non-colour channel. This does not make the
  // chart WCAG 1.4.1 conformant on its own; it makes it markedly better.
  const sep = (p) => contrast(p.candleUp || p.up, p.candleDown || p.down);
  const sig = CHART_PRESETS.find((p) => p.id === "pink");
  const classic = CHART_PRESETS.find((p) => p.id === "classic");
  assert.ok(sep(classic) < 1.3, `green/red is expected to be near-isoluminant, got ${sep(classic).toFixed(2)}`);
  assert.ok(sep(sig) > sep(classic) * 1.5,
    `Signature ${sep(sig).toFixed(2)}:1 should clearly beat Classic ${sep(classic).toFixed(2)}:1`);
});

test("the SEMANTIC tokens stay legible — they colour text, not just candles", () => {
  // --c-up/--c-down drive `text-up`/`text-down` figures and map markers. A body
  // colour that would fail here (Signature's white) belongs in candleUp/
  // candleDown instead; this test is what stops it leaking into the token.
  //
  // 3:1 both ways is the ceiling worth aiming for, not laziness: ONE hex has to
  // sit on a near-white and a near-black background, and the best any single
  // colour can do across this pair is 4.31:1. Ocean and Sunset were failing this
  // at 1.78 and 2.05 before the palettes were re-measured.
  for (const p of CHART_PRESETS) {
    for (const hex of [p.up, p.down]) {
      for (const bg of [LIGHT_BG, DARK_BG]) {
        const c = contrast(hex, bg);
        assert.ok(c >= 3, `${p.id}: token ${hex} vs ${bg} is ${c.toFixed(2)}:1, needs >= 3`);
      }
    }
  }
});

test("Signature is the reference clip's chart: rose bull, hollow white bear", () => {
  const sig = CHART_PRESETS.find((p) => p.id === "pink");
  assert.ok(sig, "the Signature preset must exist");
  assert.equal(sig.candleDown.toLowerCase(), "#ffffff", "bearish bodies are white");
  const [r, g, b] = hexToTriplet(sig.candleUp).split(" ").map(Number);
  assert.ok(r > g && r > b, "bullish bodies are a rose — red channel leads");
  assert.ok(b > g, "…leaning pink, not orange");
  assert.ok(lum(sig.ink) < 0.02, "the outline is near-black");
});
