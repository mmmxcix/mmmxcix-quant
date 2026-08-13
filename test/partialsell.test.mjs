import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// The portfolio module is browser-first (localStorage + window events). Give it
// just enough of a DOM to run under node:test — the in-memory fallback it
// already has for private-mode browsers does the rest.
const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
};
globalThis.localStorage = window.localStorage;

const {
  addPosition, getPortfolio, sellShares, isClosed, cashUSD, addDeposit,
} = await import("../src/lib/portfolio.js");

// Reset by WRITING empty arrays, not by clearing the map. The module keeps an
// in-memory shadow for private-mode browsers and falls back to it whenever
// localStorage returns null — so clearing the store leaves the shadow in charge
// and every test after the first one inherits the previous one's positions.
beforeEach(() => {
  for (const k of ["quant_watchlist", "quant_portfolio", "quant_deposits"]) {
    store.set(k, "[]");
  }
});

const openLot = () => addPosition({
  market: "stock", symbol: "AAPL", name: "Apple",
  shares: 100, avgPrice: 50, buyDate: "2026-01-10",
})[0];

test("selling part splits the lot: one closed, one still open", () => {
  const p = openLot();
  sellShares(p.id, { shares: 40, price: 75, date: "2026-06-01" });
  const list = getPortfolio();
  assert.equal(list.length, 2, "a partial sale produces a second, realised lot");
  const open = list.find((x) => !isClosed(x));
  const sold = list.find((x) => isClosed(x));
  assert.equal(open.shares, 60, "the remainder stays open");
  assert.equal(sold.shares, 40);
  assert.equal(sold.sellPrice, 75);
  // The cost basis and buy date travel with the shares, or the realised P/L and
  // the holding period of the sold lot would both be wrong.
  assert.equal(sold.avgPrice, 50);
  assert.equal(sold.buyDate, open.buyDate);
  assert.notEqual(sold.id, open.id, "the lots must not share an id");
});

test("selling everything closes the position in place — no phantom second lot", () => {
  const p = openLot();
  sellShares(p.id, { shares: 100, price: 75 });
  const list = getPortfolio();
  assert.equal(list.length, 1, "a full sale must not split");
  assert.equal(list[0].id, p.id, "…and must keep its id");
  assert.ok(isClosed(list[0]));
});

test("floating-point dust does not leave a 5e-17 share position behind", () => {
  // 0.1 + 0.2 held, 0.3 sold. Without an epsilon the remainder is 5.55e-17 and
  // the lot lingers in the open book forever, unsellable and invisible.
  const p = addPosition({ market: "crypto", symbol: "BTCUSDT", shares: 0.1 + 0.2, avgPrice: 100 })[0];
  sellShares(p.id, { shares: 0.3, price: 120 });
  const list = getPortfolio();
  assert.equal(list.length, 1);
  assert.ok(isClosed(list[0]), "it must count as a full close");
});

test("cash follows the shares actually sold, not the whole position", () => {
  addDeposit({ amount: 10000, currency: "USD", date: "2026-01-01", rate: 1, usd: 10000 });
  const p = openLot();                       // 100 × 50 = 5,000 spent
  assert.equal(cashUSD(), 5000);
  sellShares(p.id, { shares: 40, price: 75 }); // 40 × 75 = 3,000 back
  assert.equal(cashUSD(), 8000, "only the sold shares return cash");
  sellShares(getPortfolio().find((x) => !isClosed(x)).id, { shares: 60, price: 80 });
  assert.equal(cashUSD(), 12800, "…and the rest when it is sold");
});

test("a sale larger than the holding is refused outright", () => {
  const p = openLot();
  sellShares(p.id, { shares: 101, price: 75 });
  const list = getPortfolio();
  assert.equal(list.length, 1);
  assert.equal(isClosed(list[0]), false, "the position must be untouched");
  assert.equal(list[0].shares, 100);
});

test("nonsense input changes nothing", () => {
  const p = openLot();
  for (const bad of [{ shares: 0, price: 75 }, { shares: 10, price: 0 }, { shares: -5, price: 75 }, {}]) {
    sellShares(p.id, bad);
  }
  const list = getPortfolio();
  assert.equal(list.length, 1);
  assert.equal(list[0].shares, 100);
  assert.equal(isClosed(list[0]), false);
});

test("an already-closed lot cannot be sold again", () => {
  const p = openLot();
  sellShares(p.id, { shares: 100, price: 75 });
  sellShares(p.id, { shares: 50, price: 90 });
  const list = getPortfolio();
  assert.equal(list.length, 1, "no second sale off a closed lot");
  assert.equal(list[0].sellPrice, 75, "…and the first price stands");
});

test("repeated partial sales each become their own realised lot", () => {
  // What a broker statement looks like, and what makes per-sale P/L readable.
  const p = openLot();
  sellShares(p.id, { shares: 30, price: 60 });
  const stillOpen = () => getPortfolio().find((x) => !isClosed(x));
  sellShares(stillOpen().id, { shares: 30, price: 70 });
  sellShares(stillOpen().id, { shares: 40, price: 80 });
  const list = getPortfolio();
  assert.equal(list.filter(isClosed).length, 3);
  assert.equal(list.filter((x) => !isClosed(x)).length, 0, "nothing left open");
  const realised = list.filter(isClosed).reduce((s, x) => s + x.shares * (x.sellPrice - x.avgPrice), 0);
  assert.equal(realised, 30 * 10 + 30 * 20 + 40 * 30);
});
