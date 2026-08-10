// Historical FX → USD via the free Frankfurter API (ECB reference rates).
//
// Used by the Portfolio cash model: a deposit made in CHF/EUR/… is converted to
// USD at the ECB daily rate of the deposit DATE, and the account is kept in USD
// from then on. Granularity is daily (ECB publishes one rate per business day;
// weekends/holidays resolve to the prior business day server-side), history
// goes back to 1999, no API key required.

const BASE = "https://api.frankfurter.dev/v1";

/** Currencies offered in the deposit form (all covered by the ECB feed). */
export const DEPOSIT_CURRENCIES = ["USD", "CHF", "EUR", "GBP"];

/**
 * Rate that converts 1 unit of `currency` into USD on `dateStr` (YYYY-MM-DD).
 * USD → 1 without a network call. Throws when the rate can't be fetched, so
 * callers never book a deposit with a made-up rate.
 */
export async function fxRateToUSD(currency, dateStr) {
  const cur = String(currency || "USD").toUpperCase();
  if (cur === "USD") return 1;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr)) ? dateStr : "latest";
  let res;
  try {
    res = await fetch(`${BASE}/${date}?from=${cur}&to=USD`);
  } catch (e) {
    // A CSP block surfaces here as a bare "Failed to fetch" with no hint of the
    // cause — which is exactly how this shipped broken once (api.frankfurter.dev
    // was missing from connect-src in public/_headers).
    throw new Error(`Couldn't reach the exchange-rate service (${String(e.message || e)}). Book the deposit in USD, or try again.`);
  }
  if (!res.ok) throw new Error(`FX lookup failed (${res.status})`);
  const json = await res.json();
  const rate = Number(json?.rates?.USD);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error("FX rate unavailable for that date");
  return rate;
}
