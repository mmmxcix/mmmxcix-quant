// themes.js — a statement becomes a theme, a theme becomes a basket.
//
// This is the layer the whole idea lives or dies on, and it is deliberately a
// FIXED LOOKUP rather than a model call. Three reasons, in order of how much
// they matter:
//
//   1. A model classifying two years of old headlines knows what happened next.
//      There is no way to prove it did not lean on that, and a study whose
//      labelling step can see the future is not a study. Every rule here was
//      written from the mechanism ("who sells the thing the statement is
//      about"), never from a chart.
//   2. It is reproducible. Rerun the script in a month and the same headline
//      lands in the same theme; a model at temperature 0.3 does not promise that.
//   3. It is auditable. Anyone can read why "TRUMP ON IRAN: NUCLEAR PROGRAM"
//      is not a uranium-mining story, and disagree in one place.
//
// The model IS used, on the live path only, where the future is genuinely
// unknown — see functions/api/statements.js. It maps a new statement onto THESE
// theme ids; it never invents a theme, because a theme with no measured history
// is exactly the narrative generator this project is trying not to build.
//
// HONEST WARNING ABOUT THE BASKETS. Membership is fixed as of August 2026. That
// biases every result UPWARD: a company is in the nuclear basket today partly
// because the last two years went well for it, and a company that went bankrupt
// in 2025 is in no basket at all. The study reports how many names each event
// could actually price, and the findings doc states this as a known bias rather
// than burying it. Cross-checked against IBKR's own "Nuclear Energy" theme
// (relevance-ranked, 71 companies) — the overlap was close enough that the
// hand-fixed list was kept, because a list that changes under you cannot be
// re-measured.

/**
 * @typedef {object} Theme
 * @property {string} id
 * @property {string} name
 * @property {RegExp} match   tested against the UPPER-CASED statement
 * @property {RegExp} [veto]  a match here disqualifies the theme
 * @property {string[]} basket  US-listed tickers, most central first
 * @property {string} why     the mechanism, in one line — if this cannot be
 *                            written plainly, the theme does not belong here
 */

/** @type {Theme[]} */
export const THEMES = [
  {
    id: "nuclear",
    name: "Nuclear energy & uranium",
    match: /\bURANIUM\b|\bNUCLEAR (POWER|ENERGY|PLANT|REACTOR|FUEL)\b|\bREACTORS?\b|\bENRICHMENT\b|\bSMALL MODULAR\b/,
    // A statement about Iran's nuclear PROGRAMME is a weapons story. It may well
    // move uranium names too, but through a different mechanism, and mixing the
    // two makes the basket answer a question nobody asked. The country names are
    // in the veto because the house style often drops the word "weapon"
    // entirely — "GETTING THEIR ENRICHED URANIUM OUT" is non-proliferation, not
    // fuel demand, and it matched the fuel basket until this line was added.
    veto: /\bNUCLEAR (WEAPON|BOMB|WARHEAD|ARSENAL|STRIKE|TEST|DEAL|PROGRAM|PROGRAMME|AMBITION)|\bIRAN|\bNORTH KOREA|\bWARHEAD|\bNON-?PROLIFERATION|\bIAEA\b/,
    basket: ["CCJ", "LEU", "UEC", "BWXT", "SMR", "CEG", "VST", "GEV", "UUUU", "DNN"],
    why: "Miners, enrichers, reactor builders and the utilities that run the fleet.",
  },
  {
    id: "defense",
    name: "Defense & aerospace",
    match: /\bDEFENSE (SPENDING|BUDGET|CONTRACT)\b|\bMILITARY (AID|BUDGET|SPENDING)\b|\bREARM|\bWEAPONS? (SALE|PACKAGE|SHIPMENT)\b|\bMISSILE DEFENSE\b|\bNATO SPENDING\b|\bARMS (DEAL|SALE)\b/,
    basket: ["LMT", "RTX", "NOC", "GD", "LHX", "HII", "LDOS", "KTOS", "AVAV", "TXT"],
    why: "Prime contractors and their suppliers bill against defense budgets.",
  },
  {
    id: "oil_gas",
    name: "Oil & gas producers",
    match: /\bOIL\b|\bCRUDE\b|\bDRILL(ING)?\b|\bOPEC\b|\bREFINER|\bPETROLEUM\b|\bSTRATEGIC PETROLEUM RESERVE\b|\bLNG\b|\bNATURAL GAS\b/,
    basket: ["XOM", "CVX", "COP", "OXY", "EOG", "SLB", "HAL", "PSX", "VLO", "MPC"],
    why: "Producers and refiners earn on the barrel the statement is about.",
  },
  {
    id: "tankers",
    name: "Tankers & shipping",
    match: /\bHORMUZ\b|\bRED SEA\b|\bSUEZ\b|\bBLOCKADE\b|\bSHIPPING LANE|\bTANKERS?\b|\bSTRAIT OF\b|\bMARITIME\b|\bPORT (STRIKE|FEE)/,
    basket: ["FRO", "TNK", "DHT", "STNG", "INSW", "ZIM", "MATX", "GSL"],
    why: "Closing a lane lengthens every voyage, and rates are paid per day.",
  },
  {
    id: "semis",
    name: "Semiconductors",
    match: /\bSEMICONDUCTOR|\bCHIPS?\b|\bCHIP (ACT|EXPORT|BAN|CURB|TARIFF)\b|\bFOUNDR|\bEXPORT CONTROLS? ON\b.*\bCHIP|\bAI (CHIP|ACCELERATOR)/,
    basket: ["NVDA", "AMD", "INTC", "MU", "AMAT", "LRCX", "KLAC", "AVGO", "QCOM", "TXN"],
    why: "Designers and equipment makers sit directly under export policy.",
  },
  {
    id: "crypto",
    name: "Crypto-linked equities",
    match: /\bBITCOIN\b|\bCRYPTO(CURRENCY)?\b|\bDIGITAL ASSETS?\b|\bSTABLECOIN\b|\bETHEREUM\b|\bSTRATEGIC (BITCOIN|CRYPTO) RESERVE\b/,
    basket: ["COIN", "MSTR", "MARA", "RIOT", "CLSK", "HUT", "BITF", "CIFR"],
    why: "Exchanges, miners and treasury holders are levered to the coin price.",
  },
  {
    id: "solar",
    name: "Solar & renewables",
    match: /\bSOLAR\b|\bRENEWABLE|\bWIND (POWER|FARM|ENERGY)\b|\bCLEAN ENERGY\b|\bINFLATION REDUCTION ACT\b|\bGREEN (SUBSID|CREDIT)/,
    basket: ["FSLR", "ENPH", "SEDG", "RUN", "NEE", "SHLS", "AMRC"],
    why: "Panel makers and installers live on subsidy and tariff policy.",
  },
  {
    id: "ev_autos",
    name: "Autos & EVs",
    match: /\bELECTRIC VEHICLES?\b|\bEV (MANDATE|CREDIT|SUBSID|TAX)\b|\bAUTOMAKERS?\b|\bAUTO (TARIFF|INDUSTRY|WORKERS)\b|\bCAFE STANDARDS\b|\bEMISSIONS? (RULE|STANDARD)/,
    basket: ["TSLA", "GM", "F", "RIVN", "LCID", "APTV", "BWA"],
    why: "Mandates, credits and tariffs land straight on unit economics.",
  },
  {
    id: "steel_metals",
    name: "Steel & aluminium",
    match: /\bSTEEL\b|\bALUMIN(I)?UM\b|\bSECTION 232\b|\bMETALS? TARIFF/,
    basket: ["NUE", "STLD", "X", "CLF", "AA", "CMC", "RS"],
    why: "Domestic mills gain pricing power exactly when imports are taxed.",
  },
  {
    id: "gold",
    name: "Gold miners",
    match: /\bGOLD\b(?!MAN)|\bBULLION\b|\bSAFE HAVEN\b|\bDEDOLLARI[SZ]|\bCENTRAL BANK (GOLD|BUYING)\b/,
    basket: ["NEM", "GOLD", "AEM", "KGC", "AU", "RGLD", "PAAS"],
    why: "Miners are a levered claim on the metal's price.",
  },
  {
    id: "banks",
    name: "Banks",
    match: /\bBANKS?\b|\bBASEL\b|\bCAPITAL REQUIREMENTS?\b|\bBANK (REGULATION|SUPERVISION|MERGER)\b|\bDEREGULAT/,
    basket: ["JPM", "BAC", "C", "WFC", "GS", "MS", "USB", "PNC"],
    why: "Capital rules and merger policy set what a balance sheet can earn.",
  },
  {
    id: "homebuilders",
    name: "Homebuilders",
    match: /\bMORTGAGE RATES?\b|\bHOUSING (MARKET|AFFORDABILITY|CRISIS|SHORTAGE)\b|\bHOME(BUILDER|BUILDING)\b|\bFANNIE MAE\b|\bFREDDIE MAC\b/,
    basket: ["DHI", "LEN", "PHM", "NVR", "TOL", "KBH", "MTH"],
    why: "Order books track the mortgage rate more tightly than anything else.",
  },
  {
    id: "pharma",
    name: "Pharmaceuticals",
    match: /\bDRUG PRIC|\bPHARMACEUTICAL|\bMEDICARE NEGOTIAT|\bFDA\b|\bMOST FAVORED NATION\b.*\bDRUG|\bPRESCRIPTION (DRUG|PRICE)/,
    basket: ["LLY", "PFE", "MRK", "ABBV", "BMY", "JNJ", "AMGN", "GILD"],
    why: "Pricing rules move the margin on the whole portfolio at once.",
  },
  {
    id: "health_insurers",
    name: "Health insurers",
    match: /\bMEDICARE ADVANTAGE\b|\bHEALTH INSUR|\bOBAMACARE\b|\bAFFORDABLE CARE ACT\b|\bMEDICAID\b/,
    basket: ["UNH", "ELV", "CI", "HUM", "CVS", "MOH"],
    why: "Reimbursement rates are the revenue line, set by policy.",
  },
  {
    id: "airlines",
    name: "Airlines",
    match: /\bAIRLINES?\b|\bAIR TRAVEL\b|\bFAA\b|\bAIRSPACE (CLOSURE|BAN)\b|\bFLIGHT (CAP|BAN)/,
    basket: ["DAL", "UAL", "AAL", "LUV", "ALK"],
    why: "Airspace and fuel policy hit a thin margin immediately.",
  },
  {
    id: "agriculture",
    name: "Agriculture",
    match: /\bFARMERS?\b|\bAGRICULTUR|\bSOYBEANS?\b|\bGRAIN\b|\bFERTILI[SZ]ER|\bCROP\b|\bWHEAT\b|\bCORN\b/,
    basket: ["ADM", "BG", "MOS", "CF", "NTR", "FMC", "DE"],
    why: "Processors and input makers move with export and subsidy policy.",
  },
  {
    id: "critical_minerals",
    name: "Critical minerals",
    match: /\bRARE EARTH|\bCRITICAL MINERALS?\b|\bLITHIUM\b|\bCOPPER\b|\bCOBALT\b|\bMINING PERMIT/,
    basket: ["MP", "FCX", "ALB", "SQM", "LAC"],
    why: "Export bans and permitting decide who can supply the West at all.",
  },
  {
    id: "cyber",
    name: "Cybersecurity",
    match: /\bCYBER(ATTACK|SECURITY|WARFARE)\b|\bHACK(ED|ING)?\b|\bRANSOMWARE\b|\bDATA BREACH\b/,
    basket: ["PANW", "CRWD", "ZS", "FTNT", "S", "CYBR"],
    why: "Budgets get approved the week after somebody is breached.",
  },
  {
    id: "space",
    name: "Space",
    match: /\bSPACE (FORCE|PROGRAM|LAUNCH)\b|\bNASA\b|\bSATELLITES?\b|\bMOON (MISSION|LANDING)\b|\bARTEMIS\b/,
    basket: ["RKLB", "LUNR", "ASTS", "RDW"],
    why: "A launch cadence is a government procurement line.",
  },
  {
    id: "china_adrs",
    name: "China-exposed ADRs",
    match: /\bCHINA\b|\bCHINESE\b|\bBEIJING\b|\bTAIWAN\b|\bDELISTING\b/,
    basket: ["BABA", "JD", "PDD", "BIDU", "NIO", "YUMC"],
    why: "US-listed Chinese names carry the political risk most directly.",
  },
  {
    id: "tariff_retail",
    name: "Import-exposed retail",
    match: /\bTARIFFS?\b|\bTRADE (WAR|DEAL|DEFICIT)\b|\bIMPORT (TAX|DUT(Y|IES))\b|\bRECIPROCAL TRADE\b|\bDE MINIMIS\b/,
    basket: ["WMT", "TGT", "COST", "DG", "DLTR", "BBY", "FIVE"],
    why: "Importers pay the tariff before anyone else does.",
  },
  {
    id: "immigration",
    name: "Immigration enforcement",
    match: /\bIMMIGRATION\b|\bDEPORT|\bBORDER (SECURITY|WALL|PATROL)\b|\bICE (RAID|DETENTION)\b|\bASYLUM\b/,
    basket: ["GEO", "CXW"],
    why: "Detention capacity is contracted per bed, per night.",
  },
];

export const THEME_BY_ID = new Map(THEMES.map((t) => [t.id, t]));

/** Every ticker any basket needs — the price loader's universe. */
export function allTickers() {
  return [...new Set(THEMES.flatMap((t) => t.basket))];
}

/**
 * Which themes does this statement belong to?
 *
 * A statement may land in several — "TRUMP ON CHINA: WE WILL TARIFF THEIR
 * CHIPS" is genuinely three stories — and each theme then counts it as one of
 * its own events. Zero is the common case and is not a failure: most of what
 * these desks publish has no investable mechanism at all, and pretending
 * otherwise is how a basket becomes a horoscope.
 *
 * @param {object} statement  from parse.js
 * @returns {string[]} theme ids
 */
export function themesFor(statement) {
  const text = `${statement.subject || ""} ${statement.quote || statement.headline || ""}`.toUpperCase();
  const out = [];
  for (const t of THEMES) {
    if (!t.match.test(text)) continue;
    if (t.veto && t.veto.test(text)) continue;
    out.push(t.id);
  }
  return out;
}

/** Attach themes to a list of statements, dropping the ones that match none. */
export function assignThemes(statements) {
  const out = [];
  for (const s of statements) {
    const themes = themesFor(s);
    if (themes.length) out.push({ ...s, themes });
  }
  return out;
}
