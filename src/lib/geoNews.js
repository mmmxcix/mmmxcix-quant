// geoNews.js — put the news feed on the map. Headlines are matched against
// country names/aliases (word-boundary regex, majors only) and pinned at the
// country's centroid. Honest scope: this is headline keyword matching, not
// NLP — a headline naming two countries pins on the first match, and
// headlines naming none stay off the map.

const P = (code, name, lat, lon, re) => ({ code, name, lat, lon, re });

export const COUNTRY_PINS = [
  P("US", "United States", 39.8, -98.6, /\b(U\.?S\.?A?|United States|America(?!n Airlines)|Washington|White House|Fed(eral Reserve)?)\b/),
  P("CN", "China", 35.9, 104.2, /\b(China|Chinese|Beijing|PBoC)\b/),
  P("RU", "Russia", 61.5, 105.3, /\b(Russia|Russian|Moscow|Kremlin)\b/),
  P("UA", "Ukraine", 48.4, 31.2, /\b(Ukrain\w+|Kyiv|Kiev)\b/),
  P("DE", "Germany", 51.2, 10.4, /\b(German\w*|Berlin|Bundesbank)\b/),
  P("GB", "United Kingdom", 54.0, -2.5, /\b(UK|Britain|British|England|London|Bank of England|BoE)\b/),
  P("FR", "France", 46.6, 2.4, /\b(France|French|Paris)\b/),
  P("JP", "Japan", 36.6, 138.2, /\b(Japan\w*|Tokyo|BoJ|Bank of Japan)\b/),
  P("IN", "India", 21.1, 78.0, /\b(India\w*|New Delhi|Mumbai|RBI)\b/),
  P("BR", "Brazil", -10.8, -52.9, /\b(Brazil\w*|Brasilia|Sao Paulo)\b/),
  P("CH", "Switzerland", 46.8, 8.2, /\b(Switzerland|Swiss|Zurich|SNB)\b/),
  P("IL", "Israel", 31.4, 35.0, /\b(Israel\w*|Tel Aviv|Jerusalem)\b/),
  P("IR", "Iran", 32.6, 54.3, /\b(Iran\w*|Tehran)\b/),
  P("SA", "Saudi Arabia", 24.2, 44.5, /\b(Saudi\w*|Riyadh|Aramco)\b/),
  P("AE", "UAE", 24.0, 54.0, /\b(UAE|Emirates|Dubai|Abu Dhabi)\b/),
  P("TR", "Türkiye", 39.0, 35.4, /\b(Turkey|Turkish|Türkiye|Ankara|Istanbul)\b/),
  P("KR", "South Korea", 36.4, 127.9, /\b(South Korea\w*|Seoul)\b/),
  P("KP", "North Korea", 40.3, 127.4, /\b(North Korea\w*|Pyongyang)\b/),
  P("TW", "Taiwan", 23.7, 121.0, /\b(Taiwan\w*|Taipei|TSMC)\b/),
  P("IT", "Italy", 42.8, 12.6, /\b(Italy|Italian|Rome|Milan)\b/),
  P("ES", "Spain", 40.2, -3.6, /\b(Spain|Spanish|Madrid)\b/),
  P("NL", "Netherlands", 52.2, 5.3, /\b(Netherlands|Dutch|Amsterdam)\b/),
  P("PL", "Poland", 52.1, 19.4, /\b(Poland|Polish|Warsaw)\b/),
  P("GR", "Greece", 39.1, 22.0, /\b(Greece|Greek|Athens)\b/),
  P("EG", "Egypt", 26.6, 29.8, /\b(Egypt\w*|Cairo|Suez)\b/),
  P("ZA", "South Africa", -29.0, 25.1, /\b(South Africa\w*|Johannesburg)\b/),
  P("NG", "Nigeria", 9.1, 8.7, /\b(Nigeria\w*|Lagos)\b/),
  P("MX", "Mexico", 23.9, -102.5, /\b(Mexico|Mexican)\b/),
  P("CA", "Canada", 56.1, -106.3, /\b(Canad\w+|Ottawa|Toronto)\b/),
  P("AR", "Argentina", -35.4, -65.2, /\b(Argentin\w+|Buenos Aires)\b/),
  P("AU", "Australia", -25.3, 134.8, /\b(Australia\w*|Sydney|RBA)\b/),
  P("ID", "Indonesia", -2.2, 117.4, /\b(Indonesia\w*|Jakarta)\b/),
  P("VN", "Vietnam", 16.6, 106.3, /\b(Vietnam\w*|Hanoi)\b/),
  P("TH", "Thailand", 15.1, 101.0, /\b(Thailand|Thai\b|Bangkok)\b/),
  P("SG", "Singapore", 1.35, 103.8, /\b(Singapore\w*)\b/),
  P("HK", "Hong Kong", 22.3, 114.2, /\b(Hong Kong)\b/),
  P("PK", "Pakistan", 29.9, 69.4, /\b(Pakistan\w*|Islamabad|Karachi)\b/),
  P("SY", "Syria", 35.0, 38.5, /\b(Syria\w*|Damascus)\b/),
  P("VE", "Venezuela", 7.1, -66.2, /\b(Venezuel\w+|Caracas)\b/),
  P("NO", "Norway", 64.6, 12.7, /\b(Norway|Norwegian|Oslo)\b/),
  P("SE", "Sweden", 62.8, 16.7, /\b(Sweden|Swedish|Stockholm)\b/),
];

/**
 * Fetch the site's news feed and group geolocatable headlines by country.
 * @returns [{ code, name, lat, lon, items: [{title, link, source, pubDate}] }]
 */
export async function fetchNewsPins() {
  // Pull the RSS news AND the Telegram OSINT feed, geo-locate BOTH by country
  // mention, and pin them together — so the fast OSINT layer lands on the map,
  // not just in Argus. OSINT items carry an `osint` flag so the UI can mark them.
  const [newsRes, tgRes] = await Promise.allSettled([fetch("/api/news"), fetch("/api/telegram")]);
  const rows = [];
  if (newsRes.status === "fulfilled" && newsRes.value.ok) {
    const j = await newsRes.value.json();
    for (const item of (Array.isArray(j) ? j : j.items || [])) {
      rows.push({ text: item.title || "", link: item.link, source: item.source, pubDate: item.pubDate, osint: false });
    }
  }
  if (tgRes.status === "fulfilled" && tgRes.value.ok) {
    const j = await tgRes.value.json();
    for (const it of (j.items || [])) {
      rows.push({ text: it.text || "", link: it.url, source: `@${it.channel}`, pubDate: it.time, osint: true, tag: it.tag });
    }
  }
  const byCode = new Map();
  for (const r of rows) {
    const pin = COUNTRY_PINS.find((c) => c.re.test(r.text));
    if (!pin) continue;
    if (!byCode.has(pin.code)) byCode.set(pin.code, { ...pin, items: [], osintCount: 0 });
    const b = byCode.get(pin.code);
    if (r.osint) b.osintCount++;
    if (b.items.length < 10) b.items.push({ title: r.text.slice(0, 160), link: r.link, source: r.source, pubDate: r.pubDate, osint: r.osint, tag: r.tag });
  }
  // Freshest country first (an OSINT-heavy country is likely where things move).
  return [...byCode.values()].sort((a, b) => b.osintCount - a.osintCount || b.items.length - a.items.length);
}
