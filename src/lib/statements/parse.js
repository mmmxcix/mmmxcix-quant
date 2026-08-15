// parse.js — turning a market headline into "who said what, and when".
//
// The channels this reads (WalterBloomberg, financialjuice) write in a house
// style that is almost a grammar:
//
//   TRUMP ON IRAN: PRETTY SOON I'LL BE DECLARING HORMUZ STRAIT A TERRITORY…
//   U.S. DEFENSE SECRETARY HEGSETH ON IRAN: U.S. CAN HOLD BLOCKADE AS LONG AS NEEDED
//   Ukraine's military strikes Russian missile factory in Samara, Zelenskiy says
//
// So detection is deterministic and does not need a model. That matters more
// than it looks: an LLM classifying two years of historical headlines knows what
// happened afterwards, and there is no way to prove it did not use that. Every
// step that touches the HISTORY here is a fixed rule, written once, reproducible
// from the corpus alone. The model is used on the LIVE path only, where the
// future genuinely is unknown.
//
// A statement is not an event. "OIL RISES 3%" is a fact about the market;
// "TRUMP: WE WILL DRILL" is a person committing to something. Only the second
// kind is what this project is about, because only the second kind has a
// plausible mechanism — someone with power says what they intend to do, and
// somebody's revenue depends on it.

/**
 * The roster. Deliberately small and senior: these are the people whose words
 * are supposed to move a sector. Adding a hundred more names would raise the
 * event count and lower the average importance, which is the wrong trade for a
 * study that already has a sample-size problem.
 *
 * `match` is tested against the UPPER-CASED headline. Order matters only for
 * reporting — the first match wins, so more specific names come first.
 */
export const SPEAKERS = [
  { id: "trump", name: "Donald Trump", role: "US President", match: /\bTRUMP\b/ },
  { id: "powell", name: "Jerome Powell", role: "Fed Chair", match: /\bPOWELL\b/ },
  { id: "bessent", name: "Scott Bessent", role: "US Treasury", match: /\bBESSENT\b/ },
  { id: "lutnick", name: "Howard Lutnick", role: "US Commerce", match: /\bLUTNICK\b/ },
  { id: "hegseth", name: "Pete Hegseth", role: "US Defense", match: /\bHEGSETH\b/ },
  { id: "rubio", name: "Marco Rubio", role: "US State", match: /\bRUBIO\b/ },
  { id: "vance", name: "JD Vance", role: "US Vice President", match: /\bVANCE\b/ },
  { id: "wright", name: "Chris Wright", role: "US Energy", match: /\bENERGY SECRETARY\b|\bCHRIS WRIGHT\b/ },
  { id: "lagarde", name: "Christine Lagarde", role: "ECB President", match: /\bLAGARDE\b/ },
  { id: "ecb", name: "ECB official", role: "ECB", match: /\bECB(?:'S)?\b/ },
  { id: "fed", name: "Fed official", role: "Federal Reserve", match: /\bFED(?:'S)?\b(?!ERAL RESERVE BANK OF)|\bFOMC\b/ },
  { id: "boj", name: "BOJ official", role: "Bank of Japan", match: /\bBOJ(?:'S)?\b|\bUEDA\b/ },
  { id: "boe", name: "BOE official", role: "Bank of England", match: /\bBOE(?:'S)?\b|\bBAILEY\b/ },
  { id: "putin", name: "Vladimir Putin", role: "Russian President", match: /\bPUTIN\b/ },
  { id: "zelensky", name: "Volodymyr Zelensky", role: "Ukrainian President", match: /\bZELENSK(?:Y|IY|YY)\b/ },
  { id: "xi", name: "Xi Jinping", role: "Chinese President", match: /\bXI JINPING\b/ },
  { id: "netanyahu", name: "Benjamin Netanyahu", role: "Israeli PM", match: /\bNETANYAHU\b/ },
  { id: "khamenei", name: "Ali Khamenei", role: "Iranian Supreme Leader", match: /\bKHAMENEI\b/ },
  { id: "opec", name: "OPEC", role: "OPEC / OPEC+", match: /\bOPEC\b|\bNOVAK\b/ },
  { id: "musk", name: "Elon Musk", role: "Tesla/SpaceX", match: /\bMUSK\b/ },
  { id: "huang", name: "Jensen Huang", role: "NVIDIA CEO", match: /\bJENSEN HUANG\b|\bNVIDIA CEO\b/ },
  { id: "dimon", name: "Jamie Dimon", role: "JPMorgan CEO", match: /\bDIMON\b/ },
];

const SPEAKER_BY_ID = new Map(SPEAKERS.map((s) => [s.id, s]));
export const speakerById = (id) => SPEAKER_BY_ID.get(id) || null;

// Verbs that turn a name into a statement. "X SAYS", "X WARNS", "X VOWS" — the
// reporting verbs these desks use. `:` after a speaker segment counts too, which
// is the caps house style.
const VERBS = /\b(SAYS?|SAID|TELLS|TOLD|WARNS?|VOWS?|THREATENS?|PLEDGES?|ANNOUNCES?|CONFIRMS?|DENIES|CALLS FOR|URGES?|ORDERS?|SIGNALS?|REITERATES?|INSISTS?|COMMENTS?)\b/g;

// How far before a reporting verb the speaker's name has to sit for the verb to
// be THEIRS. Without this the reported form matches anything with a name and a
// "says" anywhere in it: "Trump expected to attend a meeting with crypto CEOs,
// sources say" has both, and the speaker is *sources*. Twenty-five characters
// covers "Zelenskiy says", "Trump's spokesman said" and "Powell, however, warned"
// without reaching across a clause.
const VERB_PROXIMITY = 25;

/** Does a reporting verb in this text actually belong to this speaker? */
function speakerSpeaks(upper, speaker) {
  VERBS.lastIndex = 0;
  let m;
  while ((m = VERBS.exec(upper))) {
    const before = upper.slice(Math.max(0, m.index - VERB_PROXIMITY), m.index);
    if (speaker.match.test(before)) return true;
  }
  return false;
}

// Headlines that merely REPORT a market fact, even when a speaker's name is in
// them. These are not commitments and have no mechanism.
const NOT_A_STATEMENT = /^\s*(\$[A-Z.]{1,6}\b|BREAKING:?\s*\$)|\b(RISES?|FALLS?|GAINS?|DROPS?|CLIMBS?|SLIDES?|JUMPS?|TUMBLES?)\s+(ABOVE|BELOW|\d)/;

/** Strip the channel's own signature junk. */
function clean(text) {
  return String(text || "")
    .replace(/\(@\w+\)\s*$/g, "")
    .replace(/\|FJ\s*$/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Parse one headline.
 *
 * @returns {null|{speakerId, speaker, role, subject, quote, headline, form}}
 *   `subject` is the "ON <TOPIC>" hint when the house style provides one — it is
 *   a hint for theme matching, never the theme itself.
 *   `form` is how it was recognised, so a sample can be audited by shape.
 */
export function parseStatement(text) {
  const headline = clean(text);
  if (headline.length < 12 || headline.length > 400) return null;
  const upper = headline.toUpperCase();
  if (NOT_A_STATEMENT.test(upper)) return null;

  const speaker = SPEAKERS.find((s) => s.match.test(upper));
  if (!speaker) return null;

  // Form 1, the caps house style: "<SPEAKER SEGMENT>[ ON <TOPIC>]: <quote>".
  // The segment before the colon has to be short, or a sentence that merely
  // happens to contain a colon would qualify.
  const colon = headline.indexOf(":");
  if (colon > 0 && colon <= 90) {
    const head = headline.slice(0, colon);
    const quote = headline.slice(colon + 1).trim();
    if (speaker.match.test(head.toUpperCase()) && quote.length >= 8) {
      const on = /\bON\s+([A-Z][A-Z\s/&.-]{2,40})$/i.exec(head.trim());
      return {
        speakerId: speaker.id, speaker: speaker.name, role: speaker.role,
        subject: on ? on[1].trim() : null,
        quote, headline, form: "colon",
      };
    }
  }

  // Form 2, the reported style: "<clause>, <speaker> says" / "<speaker> warns …".
  // The verb has to be theirs — see speakerSpeaks.
  if (speakerSpeaks(upper, speaker)) {
    return {
      speakerId: speaker.id, speaker: speaker.name, role: speaker.role,
      subject: null, quote: headline, headline, form: "reported",
    };
  }

  return null;
}

const STOPWORDS = new Set(["THE", "A", "AN", "AND", "OR", "OF", "TO", "IN", "ON", "FOR", "IS", "ARE", "WE", "IT", "THAT", "WILL", "WITH", "AT", "BE", "HAS", "HAVE"]);

/** Content words of a line: upper-cased, punctuation dropped, stopwords removed. */
export function fingerprint(s) {
  return [...new Set(
    String(s).toUpperCase().replace(/[^A-Z0-9 ]/g, " ").split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w))
  )];
}

/** Jaccard overlap of two token sets, 0…1. */
export function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  const set = new Set(b);
  let shared = 0;
  for (const w of a) if (set.has(w)) shared++;
  return shared / (a.length + b.length - shared);
}

/**
 * Parse a whole harvested channel into statements, de-duplicated.
 *
 * These desks publish the same line twice within minutes — a one-line squawk,
 * then a fuller write-up, often with a word changed ("U.S. SENDING…" then "U.S.
 * SENDS…"). Counting both doubles the event count and halves the effective
 * sample without anyone noticing, so overlap is measured rather than equality:
 * two lines inside the window whose content words agree by `threshold` are one
 * statement, kept at the EARLIEST time — the moment it was first public.
 */
export function extractStatements(messages, { dedupeWindowMs = 30 * 60_000, threshold = 0.6 } = {}) {
  const out = [];
  const recent = [];
  for (const m of [...messages].sort((a, b) => a.time - b.time)) {
    const st = parseStatement(m.text);
    if (!st) continue;
    const words = fingerprint(st.quote);
    while (recent.length && m.time - recent[0].time > dedupeWindowMs) recent.shift();
    if (recent.some((r) => similarity(words, r.words) >= threshold)) continue;
    recent.push({ words, time: m.time });
    // `sourceId` travels with the statement so a second classifier's answer can
    // be joined back to THIS row by identity rather than by comparing prose,
    // which does not survive either side cleaning the text differently.
    out.push({ ...st, at: m.time, channel: m.channel, url: m.url, sourceId: m.id ?? null });
  }
  return out;
}
