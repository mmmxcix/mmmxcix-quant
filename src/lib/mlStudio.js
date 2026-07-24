// mlStudio.js — in-browser price forecasting via Pyodide + scikit-learn
// (LSE "ML Studio" clone). Everything runs client-side; no data leaves the
// browser.
//
// Honesty rules baked in:
// - target is the NEXT bar's return; features only use information available
//   at prediction time (no look-ahead)
// - evaluation is strictly out-of-sample: the last 25% of history is never
//   seen in training
// - every metric ships with its naive baseline, and the verdict says plainly
//   when a hit rate is statistically indistinguishable from a coin flip
// - LSE advertises LSTM/XGBoost/CatBoost; WASM has none of those. We ship what
//   actually runs in the browser (sklearn) and say so, instead of relabeling.

import { loadPy } from "@/lib/pyRunner";

export const ML_MODELS = [
  { id: "rf", label: "Random Forest", desc: "200 trees, depth ≤ 6 — robust default, real feature importances" },
  { id: "gbm", label: "Gradient Boosting", desc: "sklearn GBM (the browser stand-in for XGBoost/CatBoost)" },
  { id: "ridge", label: "Ridge (linear)", desc: "standardized linear model — the sanity check the fancy models must beat" },
];

const PY_ML = `
import numpy as np, pandas as pd, json
from sklearn.ensemble import RandomForestRegressor, GradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

def _rsi(s, period=14):
    d = s.diff()
    g = d.clip(lower=0).ewm(alpha=1/period, adjust=False).mean()
    l = (-d.clip(upper=0)).ewm(alpha=1/period, adjust=False).mean()
    rs = g / l.replace(0, np.nan)
    return 100 - 100 / (1 + rs)

def run_forecast(o, h, l, c, v, t, model_id):
    df = pd.DataFrame({"open": o, "high": h, "low": l, "close": c, "volume": v})
    close = df["close"]
    ret = close.pct_change()
    dt = pd.to_datetime(pd.Series(t), unit="s", utc=True)

    X = pd.DataFrame(index=df.index)
    for lag in (1, 2, 3, 5, 10):
        X[f"return lag {lag}"] = ret.shift(lag - 1)
    X["volatility 5d"] = ret.rolling(5).std()
    X["volatility 20d"] = ret.rolling(20).std()
    X["RSI 14"] = _rsi(close) / 100.0
    X["dist to SMA20"] = close / close.rolling(20).mean() - 1
    X["dist to SMA50"] = close / close.rolling(50).mean() - 1
    vol_mu = df["volume"].rolling(20).mean()
    vol_sd = df["volume"].rolling(20).std()
    X["volume z-score"] = ((df["volume"] - vol_mu) / vol_sd.replace(0, np.nan)).clip(-4, 4)
    X["day of week"] = dt.dt.dayofweek.to_numpy() / 4.0

    y = ret.shift(-1)  # next bar's return — the thing we try to predict

    valid = X.notna().all(axis=1)
    fit_mask = valid & y.notna()
    Xf, yf = X[fit_mask], y[fit_mask]
    times = pd.Series(t)[fit_mask].to_numpy()
    n = len(Xf)
    if n < 120:
        raise ValueError(f"only {n} usable rows after feature warmup — load more history")

    split = int(n * 0.75)
    X_tr, X_te = Xf.iloc[:split], Xf.iloc[split:]
    y_tr, y_te = yf.iloc[:split].to_numpy(), yf.iloc[split:].to_numpy()
    t_te = times[split:]

    if model_id == "rf":
        model = RandomForestRegressor(n_estimators=200, max_depth=6, min_samples_leaf=5, random_state=7, n_jobs=1)
    elif model_id == "gbm":
        model = GradientBoostingRegressor(n_estimators=200, max_depth=3, learning_rate=0.05, subsample=0.8, random_state=7)
    else:
        model = make_pipeline(StandardScaler(), Ridge(alpha=1.0))

    model.fit(X_tr, y_tr)
    pred = model.predict(X_te)

    # Direction accuracy vs the coin flip, with a binomial z-score so a lucky
    # 52% on 80 samples doesn't get dressed up as an edge.
    nz = y_te != 0
    hits = (np.sign(pred[nz]) == np.sign(y_te[nz]))
    n_dir = int(nz.sum())
    hit = float(hits.mean()) if n_dir else 0.5
    z = (hit - 0.5) / np.sqrt(0.25 / n_dir) if n_dir else 0.0

    mae = float(np.mean(np.abs(pred - y_te)))
    mae_naive = float(np.mean(np.abs(y_te)))  # predicting 0 every day
    corr = float(np.corrcoef(pred, y_te)[0, 1]) if len(y_te) > 2 else 0.0

    # Frictionless sign-trading curve on the test window vs buy & hold — an
    # upper bound, not a tradable result (no fees/slippage).
    pos = np.sign(pred)
    strat = np.cumprod(1 + pos * y_te)
    bh = np.cumprod(1 + y_te)

    if model_id == "ridge":
        coefs = np.abs(model.named_steps["ridge"].coef_)
        imp = coefs / (coefs.sum() or 1)
    else:
        imp = model.feature_importances_
    importances = sorted(zip(Xf.columns.tolist(), imp.tolist()), key=lambda kv: -kv[1])

    # Tomorrow's forecast: predict on the latest fully-known feature row.
    live = X[valid].iloc[[-1]]
    tomorrow = float(model.predict(live)[0])

    step = max(1, len(pred) // 300)
    scatter = [[float(p), float(a)] for p, a in zip(pred[::step], y_te[::step])]

    return json.dumps({
        "nTrain": int(split), "nTest": int(n - split), "hit": hit, "z": float(z),
        "mae": mae, "maeNaive": mae_naive, "corr": corr, "tomorrow": tomorrow,
        "importances": importances[:10],
        "curve": {"t": [int(x) for x in t_te], "strat": strat.tolist(), "bh": bh.tolist()},
        "scatter": scatter,
    })
`;

// ── Cross-sectional ranking (the way ML actually earns money in equities:
// not "will AAPL rise tomorrow" but "which of these 50 will do RELATIVELY
// best next month"). Monthly rebalance, strict time split with a 1-month
// embargo, rank IC as the honest headline metric. ─────────────────────────

export const RANK_FEATURES = [
  "momentum 12-1m", "momentum 6-1m", "momentum 3m", "momentum 1m",
  "volatility 3m", "dist to 52w high",
];

/**
 * Daily candles per symbol → one row per symbol per month-end:
 * { sym, month: "YYYY-MM", feats[6], fwd } where fwd is the NEXT month's
 * return (null on the latest month — those become the live picks).
 */
export function buildRankingRows(candlesBySym) {
  const rows = [];
  for (const [sym, candles] of Object.entries(candlesBySym)) {
    const c = candles.map((x) => x.close);
    const months = candles.map((x) => new Date(x.time * 1000).toISOString().slice(0, 7));
    const monthEnd = [];
    for (let i = 0; i < c.length; i++) {
      if (i === c.length - 1 || months[i + 1] !== months[i]) monthEnd.push(i);
    }
    for (let k = 0; k < monthEnd.length; k++) {
      const i = monthEnd[k];
      if (i < 260) continue; // need a full year of history for the features
      const rets = [];
      for (let j = i - 62; j <= i; j++) rets.push(c[j] / c[j - 1] - 1);
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) * Math.sqrt(252);
      let hi = 0;
      for (let j = i - 252; j <= i; j++) hi = Math.max(hi, c[j]);
      const feats = [
        c[i - 21] / c[i - 252] - 1, // classic 12-1 momentum (skip the last month)
        c[i - 21] / c[i - 126] - 1,
        c[i] / c[i - 63] - 1,
        c[i] / c[i - 21] - 1,
        vol,
        c[i] / hi - 1,
      ];
      if (feats.some((f) => !Number.isFinite(f))) continue;
      const next = monthEnd[k + 1];
      rows.push({ sym, month: months[i], feats, fwd: next != null ? c[next] / c[i] - 1 : null });
    }
  }
  return rows;
}

const PY_RANK = `
import numpy as np, json
from sklearn.ensemble import RandomForestRegressor

def _spearman(a, b):
    ra = np.argsort(np.argsort(a)).astype(float)
    rb = np.argsort(np.argsort(b)).astype(float)
    if ra.std() == 0 or rb.std() == 0:
        return 0.0
    return float(np.corrcoef(ra, rb)[0, 1])

def run_ranking(rows_json):
    rows = json.loads(rows_json)
    months = sorted({r["month"] for r in rows if r["fwd"] is not None})
    if len(months) < 18:
        raise ValueError(f"only {len(months)} usable months — need more history")
    split_idx = int(len(months) * 0.7)
    split = months[split_idx]
    embargo = months[split_idx - 1]  # 1-month gap: the last train forward return
    train = [r for r in rows if r["fwd"] is not None and r["month"] < embargo]
    test_months = [m for m in months if m >= split]

    model = RandomForestRegressor(n_estimators=300, max_depth=6, min_samples_leaf=20, random_state=7, n_jobs=1)
    model.fit(np.array([r["feats"] for r in train]), np.array([r["fwd"] for r in train]))

    ics, top_r, bot_r, uni_r, curve_m = [], [], [], [], []
    decile_acc = [[] for _ in range(10)]  # mean fwd return per predicted decile
    for m in test_months:
        sub = [r for r in rows if r["month"] == m and r["fwd"] is not None]
        if len(sub) < 10:
            continue
        X = np.array([r["feats"] for r in sub])
        y = np.array([r["fwd"] for r in sub])
        p = model.predict(X)
        ics.append(_spearman(p, y))
        k = max(1, len(sub) // 5)
        order = np.argsort(-p)
        top_r.append(float(y[order[:k]].mean()))
        bot_r.append(float(y[order[-k:]].mean()))
        uni_r.append(float(y.mean()))
        # Decile buckets: split by ASCENDING predicted score, mean realized
        # return in each. A monotone-rising staircase = a genuine ranking edge
        # (Alphalens' mean-return-by-quantile, done honestly out-of-sample).
        groups = np.array_split(np.argsort(p), 10)
        for di in range(10):
            g = groups[di]
            if len(g):
                decile_acc[di].append(float(y[g].mean()))
        curve_m.append(m)

    ics_a = np.array(ics)
    ic_mean = float(ics_a.mean()) if len(ics_a) else 0.0
    sd = ics_a.std(ddof=1) if len(ics_a) > 2 else 0.0
    ic_t = float(ic_mean / (sd / np.sqrt(len(ics_a)))) if sd > 0 else 0.0
    spread = float(np.mean(np.array(top_r) - np.array(bot_r))) if top_r else 0.0
    deciles = [float(np.mean(v)) if v else 0.0 for v in decile_acc]
    # Monotonicity: Spearman of decile index vs its mean return (1 = perfect staircase).
    dnz = [(i, d) for i, d in enumerate(deciles) if any(decile_acc[i])]
    decile_mono = _spearman(np.array([i for i, _ in dnz]), np.array([d for _, d in dnz])) if len(dnz) >= 3 else 0.0

    live_month = max(r["month"] for r in rows)
    live = [r for r in rows if r["month"] == live_month and r["fwd"] is None]
    picks = []
    if live:
        pl = model.predict(np.array([r["feats"] for r in live]))
        for i in np.argsort(-pl)[:10]:
            picks.append({"sym": live[int(i)]["sym"], "score": float(pl[int(i)]), "mom": float(live[int(i)]["feats"][0])})

    return json.dumps({
        "icMean": ic_mean, "icT": ic_t, "spread": spread,
        "monthsTested": len(curve_m), "monthsTrained": len({r['month'] for r in train}),
        "curve": {"months": curve_m,
                  "top": np.cumprod(1 + np.array(top_r)).tolist() if top_r else [],
                  "uni": np.cumprod(1 + np.array(uni_r)).tolist() if uni_r else []},
        "importances": model.feature_importances_.tolist(),
        "deciles": deciles, "decileMono": decile_mono,
        "picks": picks, "liveMonth": live_month,
    })
`;

// ── Triple-barrier labeling + meta-labeling + purged CV (López de Prado /
// Jansen ML4T). Instead of "will the next bar be up?", label each bar by which
// of three barriers it hits first — a volatility-scaled profit-take, a stop-
// loss, or a time limit. A primary trend rule proposes the side; a SECONDARY
// "meta" model learns when to actually take that bet. Validation is a purged,
// embargoed forward-chaining CV so overlapping labels don't leak. ───────────

const PY_LABELED = `
import numpy as np, pandas as pd, json
from sklearn.ensemble import RandomForestClassifier

def _rsi(s, period=14):
    d = s.diff()
    g = d.clip(lower=0).ewm(alpha=1/period, adjust=False).mean()
    l = (-d.clip(upper=0)).ewm(alpha=1/period, adjust=False).mean()
    rs = g / l.replace(0, np.nan)
    return 100 - 100 / (1 + rs)

def _triple_barrier(c, vol, pt_mult, sl_mult, horizon):
    n = len(c)
    lab = np.full(n, np.nan)
    for i in range(n):
        vi = vol[i]
        if not np.isfinite(vi) or vi <= 0:
            continue
        end = min(i + horizon, n - 1)
        if end <= i:
            continue
        up, dn = pt_mult * vi, -sl_mult * vi
        hit = 0
        for j in range(i + 1, end + 1):
            r = c[j] / c[i] - 1.0
            if r >= up:
                hit = 1; break
            if r <= dn:
                hit = -1; break
        else:
            r = c[end] / c[i] - 1.0
            hit = 1 if r > 0 else (-1 if r < 0 else 0)
        lab[i] = hit
    return lab

def run_labeled(o, h, l, c, v, t, pt_mult, sl_mult, horizon):
    df = pd.DataFrame({"open": o, "high": h, "low": l, "close": c, "volume": v})
    close = df["close"]
    ret = close.pct_change()
    dt = pd.to_datetime(pd.Series(t), unit="s", utc=True)

    X = pd.DataFrame(index=df.index)
    for lag in (1, 2, 3, 5, 10):
        X[f"return lag {lag}"] = ret.shift(lag - 1)
    X["volatility 5d"] = ret.rolling(5).std()
    X["volatility 20d"] = ret.rolling(20).std()
    X["RSI 14"] = _rsi(close) / 100.0
    X["dist to SMA20"] = close / close.rolling(20).mean() - 1
    X["dist to SMA50"] = close / close.rolling(50).mean() - 1
    X["day of week"] = dt.dt.dayofweek.to_numpy() / 4.0

    vol = ret.ewm(span=20, adjust=False).std().to_numpy()
    labels = _triple_barrier(close.to_numpy(), vol, pt_mult, sl_mult, horizon)
    lab = pd.Series(labels, index=df.index)

    side = np.sign((close / close.rolling(20).mean() - 1).to_numpy())
    side_s = pd.Series(side, index=df.index)
    meta = ((side_s == lab) & (lab != 0)).astype(float)

    valid = X.notna().all(axis=1) & lab.notna()
    Xf = X[valid]
    yf = lab[valid].to_numpy().astype(int)
    metaf = meta[valid].to_numpy().astype(int)
    n = len(Xf)
    if n < 200:
        raise ValueError(f"only {n} usable rows after warmup — load more history")

    K = 5
    embargo = max(3, n // 100)
    fold_edges = np.linspace(int(n * 0.35), n, K + 1).astype(int)
    accs, base_rates, ics = [], [], []
    for f in range(K):
        s, e = fold_edges[f], fold_edges[f + 1]
        if e - s < 15:
            continue
        cut = max(0, s - horizon - embargo)
        if cut < 80:
            continue
        Xtr, ytr = Xf.iloc[:cut], yf[:cut]
        if len(np.unique(ytr)) < 2:
            continue
        clf = RandomForestClassifier(n_estimators=200, max_depth=6, min_samples_leaf=10, random_state=7, n_jobs=1, class_weight="balanced")
        clf.fit(Xtr, ytr)
        Xte, yte = Xf.iloc[s:e], yf[s:e]
        pred = clf.predict(Xte)
        accs.append(float((pred == yte).mean()))
        vals, cnts = np.unique(yte, return_counts=True)
        base_rates.append(float(cnts.max() / cnts.sum()))
        classes = list(clf.classes_)
        if 1 in classes:
            pup = clf.predict_proba(Xte)[:, classes.index(1)]
            if pup.std() > 0 and yte.std() > 0:
                ra, rb = np.argsort(np.argsort(pup)), np.argsort(np.argsort(yte))
                ics.append(float(np.corrcoef(ra, rb)[0, 1]))

    acc_m = float(np.mean(accs)) if accs else 0.0
    acc_sd = float(np.std(accs)) if len(accs) > 1 else 0.0
    base_m = float(np.mean(base_rates)) if base_rates else 0.0
    ic_m = float(np.mean(ics)) if ics else 0.0

    split = int(n * 0.7)
    cut = max(0, split - horizon - embargo)
    metatr, Xmtr = metaf[:cut], Xf.iloc[:cut]
    meta_prec = meta_cov = meta_base = 0.0
    if len(np.unique(metatr)) == 2 and metatr.sum() >= 20:
        mclf = RandomForestClassifier(n_estimators=200, max_depth=5, min_samples_leaf=10, random_state=7, n_jobs=1, class_weight="balanced")
        mclf.fit(Xmtr, metatr)
        Xmte, metate = Xf.iloc[split:], metaf[split:]
        take = mclf.predict(Xmte) == 1
        meta_cov = float(take.mean())
        meta_prec = float(metate[take].mean()) if take.sum() > 0 else 0.0
        meta_base = float(metate.mean())

    clf = RandomForestClassifier(n_estimators=200, max_depth=6, min_samples_leaf=10, random_state=7, n_jobs=1, class_weight="balanced")
    clf.fit(Xf.iloc[: n - horizon], yf[: n - horizon])
    live = X[X.notna().all(axis=1)].iloc[[-1]]
    proba = clf.predict_proba(live)[0]
    classes = list(clf.classes_)
    p_up = float(proba[classes.index(1)]) if 1 in classes else 0.0
    p_dn = float(proba[classes.index(-1)]) if -1 in classes else 0.0
    imp = sorted(zip(Xf.columns.tolist(), clf.feature_importances_.tolist()), key=lambda kv: -kv[1])
    dist = {int(k): int(vv) for k, vv in zip(*np.unique(yf, return_counts=True))}

    return json.dumps({
        "ptMult": pt_mult, "slMult": sl_mult, "horizon": horizon,
        "nUsable": int(n), "folds": len(accs),
        "accMean": acc_m, "accStd": acc_sd, "baseRate": base_m, "icMean": ic_m,
        "metaPrecision": meta_prec, "metaCoverage": meta_cov, "metaBase": meta_base,
        "pUp": p_up, "pDown": p_dn, "importances": imp[:10],
        "labelUp": dist.get(1, 0), "labelDown": dist.get(-1, 0), "labelFlat": dist.get(0, 0),
    })
`;

let _sklearnLoaded = false;

/**
 * Train + evaluate a forecast model on candles, fully in the browser.
 * @returns parsed result object (see PY_ML return payload)
 */
/** Train + evaluate the cross-sectional ranking model on prepared rows. */
export async function runMlRanking(rows, onProgress) {
  const py = await loadPy(onProgress);
  if (!_sklearnLoaded) {
    onProgress?.("Loading scikit-learn (~12 MB, first time only)…");
    await py.loadPackage(["scikit-learn"]);
    _sklearnLoaded = true;
  }
  onProgress?.("Training ranking model…");
  py.globals.set("_rank_rows", JSON.stringify(rows));
  try {
    py.runPython(PY_RANK + "\n_rank_out = run_ranking(_rank_rows)");
    return JSON.parse(py.globals.get("_rank_out"));
  } catch (e) {
    const msg = String(e?.message || e).trim().split("\n").filter(Boolean).pop() || "Python error";
    throw new Error(msg.slice(0, 300));
  } finally {
    for (const k of ["_rank_rows", "_rank_out"]) { try { py.globals.delete(k); } catch { /* noop */ } }
  }
}

/**
 * Triple-barrier + meta-labeling forecast with purged CV, in the browser.
 * @returns parsed result object (see PY_LABELED return payload)
 */
export async function runMlLabeled(candles, { ptMult = 1.5, slMult = 1.0, horizon = 10 } = {}, onProgress) {
  const py = await loadPy(onProgress);
  if (!_sklearnLoaded) {
    onProgress?.("Loading scikit-learn (~12 MB, first time only)…");
    await py.loadPackage(["scikit-learn"]);
    _sklearnLoaded = true;
  }
  onProgress?.("Labeling barriers & training…");
  py.globals.set("_o", candles.map((c) => c.open));
  py.globals.set("_h", candles.map((c) => c.high));
  py.globals.set("_l", candles.map((c) => c.low));
  py.globals.set("_c", candles.map((c) => c.close));
  py.globals.set("_v", candles.map((c) => c.volume ?? 0));
  py.globals.set("_t", candles.map((c) => c.time));
  py.globals.set("_pt", ptMult);
  py.globals.set("_sl", slMult);
  py.globals.set("_hz", horizon);
  try {
    py.runPython(PY_LABELED + "\n_lab_out = run_labeled(list(_o), list(_h), list(_l), list(_c), list(_v), list(_t), _pt, _sl, _hz)");
    return JSON.parse(py.globals.get("_lab_out"));
  } catch (e) {
    const msg = String(e?.message || e).trim().split("\n").filter(Boolean).pop() || "Python error";
    throw new Error(msg.slice(0, 300));
  } finally {
    for (const k of ["_o", "_h", "_l", "_c", "_v", "_t", "_pt", "_sl", "_hz", "_lab_out"]) {
      try { py.globals.delete(k); } catch { /* noop */ }
    }
  }
}

export async function runMlForecast(candles, modelId, onProgress) {
  const py = await loadPy(onProgress);
  if (!_sklearnLoaded) {
    onProgress?.("Loading scikit-learn (~12 MB, first time only)…");
    await py.loadPackage(["scikit-learn"]);
    _sklearnLoaded = true;
  }
  onProgress?.("Training model…");
  py.globals.set("_o", candles.map((c) => c.open));
  py.globals.set("_h", candles.map((c) => c.high));
  py.globals.set("_l", candles.map((c) => c.low));
  py.globals.set("_c", candles.map((c) => c.close));
  py.globals.set("_v", candles.map((c) => c.volume ?? 0));
  py.globals.set("_t", candles.map((c) => c.time));
  py.globals.set("_model_id", modelId);
  try {
    py.runPython(PY_ML + '\n_ml_out = run_forecast(list(_o), list(_h), list(_l), list(_c), list(_v), list(_t), _model_id)');
    const raw = py.globals.get("_ml_out");
    return JSON.parse(raw);
  } catch (e) {
    const msg = String(e?.message || e).trim().split("\n").filter(Boolean).pop() || "Python error";
    throw new Error(msg.slice(0, 300));
  } finally {
    for (const k of ["_o", "_h", "_l", "_c", "_v", "_t", "_model_id", "_ml_out"]) {
      try { py.globals.delete(k); } catch { /* noop */ }
    }
  }
}
