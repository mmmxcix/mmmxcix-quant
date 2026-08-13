// args.js — argument coercion for the board catalog.
//
// Every resource declares a schema, and nothing that is not in that schema ever
// reaches a resolver. This is the security-relevant half of the layer, not a
// convenience: /api/argus once bound an arbitrary `what` parameter straight into
// a D1 key lookup, which let a public caller read private rows (prefs,
// portfolio, telegram) — CWE-639, fixed by denying everything but one fixed key.
// A surface whose whole purpose is "everything reachable from one place" would
// repeat that bug across ten sources instead of one. So here: unknown keys are
// REFUSED rather than ignored, enums are closed, every list and limit has a
// ceiling, and no argument is ever concatenated into a key or a query by a
// resolver that did not declare it.

/** Thrown for a caller mistake — the endpoint maps this to 400, never to 500. */
export class ArgError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

const DURATION_RE = /^(\d+)\s*(m|h|d|w)$/i;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/**
 * "24h" | "7d" | "90m" | "all" → milliseconds, or null for "all".
 * A window is always expressed as a duration, never as a raw timestamp: a
 * caller cannot ask for a window the cache and the freshness label disagree on.
 */
export function parseDuration(v) {
  const s = String(v).trim().toLowerCase();
  if (s === "all" || s === "") return null;
  const m = DURATION_RE.exec(s);
  if (!m) throw new ArgError("bad_duration", `"${v}" — use 30m, 24h, 7d, 4w or all`);
  const ms = Number(m[1]) * UNIT_MS[m[2]];
  if (ms > 520 * UNIT_MS.w) throw new ArgError("bad_duration", "at most 520w");
  return ms;
}

// Symbols are interpolated into Yahoo and Binance URLs — /api/yahoo/v8/finance/
// chart/<symbol> puts one straight into a PATH — so the character class is an
// allowlist of what real tickers actually use: ^GSPC, GC=F, EURUSD=X, BRK-B,
// NESN.SW, BTCUSDT. No slash (nothing needs one, and it opens a path segment)
// and no "..", which the dot needed for Swiss/US class tickers would otherwise
// permit. The first version of this regex allowed "../../etc/passwd"; the test
// above it is the reason that never shipped.
const SYMBOL_RE = /^[A-Za-z0-9^=.\-]{1,24}$/;

function coerceOne(name, spec, value) {
  switch (spec.type) {
    case "string": {
      const s = String(value);
      if (s.length > (spec.max ?? 200)) throw new ArgError("arg_too_long", name);
      return s;
    }
    case "symbol": {
      const s = String(value).trim().toUpperCase();
      if (!SYMBOL_RE.test(s) || s.includes("..")) throw new ArgError("bad_symbol", name);
      return s;
    }
    case "enum": {
      const s = String(value);
      if (!spec.values.includes(s)) {
        throw new ArgError("bad_enum", `${name} must be one of ${spec.values.join(", ")}`);
      }
      return s;
    }
    case "bool": {
      if (typeof value === "boolean") return value;
      const s = String(value).toLowerCase();
      if (s === "true" || s === "1") return true;
      if (s === "false" || s === "0") return false;
      throw new ArgError("bad_bool", name);
    }
    case "int":
    case "number": {
      const num = Number(value);
      if (!Number.isFinite(num)) throw new ArgError("bad_number", name);
      const v = spec.type === "int" ? Math.trunc(num) : num;
      // Clamp rather than reject: a caller asking for 5,000 headlines gets the
      // ceiling and a working answer, not an error it has to learn to avoid.
      return Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, v));
    }
    case "duration":
      return parseDuration(value);
    case "list": {
      const raw = Array.isArray(value) ? value : String(value).split(",");
      const items = raw.map((x) => String(x).trim()).filter(Boolean);
      if (items.length > (spec.max ?? 20)) throw new ArgError("list_too_long", name);
      return items.map((x) => coerceOne(name, spec.of, x));
    }
    default:
      throw new ArgError("bad_schema", `${name} has unknown type ${spec.type}`);
  }
}

/**
 * Validate and normalise one call's arguments against a resource's schema.
 * @param {object} schema  { name: { type, default, required, ... } }
 * @param {object} raw     what the caller sent
 * @returns {object} frozen, fully-defaulted arguments
 */
export function coerceArgs(schema = {}, raw = {}) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ArgError("bad_args", "args must be an object");
  }
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(schema, key)) throw new ArgError("unknown_arg", key);
  }
  const out = {};
  for (const [name, spec] of Object.entries(schema)) {
    const given = raw[name];
    if (given === undefined || given === null || given === "") {
      if (spec.required) throw new ArgError("missing_arg", name);
      out[name] = spec.type === "duration" && spec.default !== undefined
        ? parseDuration(spec.default)
        : spec.default ?? null;
      continue;
    }
    out[name] = coerceOne(name, spec, given);
  }
  return Object.freeze(out);
}

/** Human-readable one-liner per argument, for the catalog listing and the chat's tool schema. */
export function describeArgs(schema = {}) {
  return Object.entries(schema).map(([name, spec]) => ({
    name,
    type: spec.type,
    required: !!spec.required,
    default: spec.default ?? null,
    values: spec.values || null,
    note: spec.note || "",
  }));
}
