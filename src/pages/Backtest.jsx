import { useEffect, useMemo, useState } from "react";
import { Play, AlertTriangle, Sparkles, Copy, Check, KeyRound, Loader2, Boxes } from "lucide-react";
import { Link } from "react-router-dom";
import EquityChart from "@/components/EquityChart";
import CandleChart from "@/components/CandleChart";
import SymbolSearch from "@/components/SymbolSearch";
import MonteCarloPanel from "@/components/MonteCarloPanel";
import ValidationPanel from "@/components/ValidationPanel";
import { fetchCandles, fetchFunding, MARKETS, INTERVALS, rangesFor, INTERVAL_SECONDS } from "@/lib/data";
import OptimizerPanel from "@/components/OptimizerPanel";
import CodeOptimizerPanel from "@/components/CodeOptimizerPanel";
import MarketScanPanel from "@/components/MarketScanPanel";
import NativeRunPanel from "@/components/NativeRunPanel";
import { fetchLseCandles } from "@/lib/lse";
import { runBacktest, compileStrategy } from "@/lib/backtest";
import { runPythonSignals, signalsToFn, PYTHON_TEMPLATE } from "@/lib/pyRunner";
import { useSession } from "@/lib/authClient";
import CountUp from "@/components/CountUp";
import { BUILT_IN_STRATEGIES } from "@/lib/strategies";
import { strategyToCode } from "@/lib/strategyCode";
import { auditStrategy } from "@/lib/strategyAudit";

// One editor, one source of truth: the language is DETECTED from the code, never
// picked from a toggle. Pine Script is recognised for export/paste, but it can't
// run in this engine (TradingView only) — say so instead of failing cryptically.
export function detectLang(src) {
  const c = String(src || "");
  // C++ and kdb+/q run only on the native executor (your PC), not in the browser.
  if (/std::vector\s*<\s*int\s*>\s*signals|#include\s*<|std::vector<Bar>/.test(c)) return "cpp";
  if (/signals\s*:\s*\{\s*\[\s*t\s*\]|\bxcol\b|0:\s*`\$/.test(c)) return "q";
  if (/\bdef\s+signals\s*\(/.test(c)) return "python";
  if (/function\s+strategy\s*\(|=>\s*\{?\s*(?:"long"|"short"|"flat")|ctx\.(candles|indicators|position)/.test(c)) return "js";
  if (/\/\/@version\s*=|\bta\.\w+|strategy\.(entry|close|exit)\s*\(|\bplot(shape)?\s*\(/.test(c)) return "pine";
  return "js";
}
const LANG_LABEL = { js: "JavaScript", python: "Python", pine: "Pine Script", cpp: "C++", q: "kdb+/q" };
import { saveEntry } from "@/lib/registry";
import { windowProfile } from "@/lib/windowProfile";
import { omniEnabled, omniGenerate, omniConfig, setOmniConfig, omniPing, omniModels, cliEnabled, cliUrl, cliModel } from "@/lib/omniroute";
import { cn, fmtNum, fmtPct } from "@/lib/utils";

const DEFAULT_SYMBOL = { crypto: "BTCUSDT", stock: "SPY" };

function MetricCard({ label, value, num, format, tone }) {
  return (
    <div className="rounded-xl border border-line lg-glass px-4 py-3 hover-lift">
      <p className="text-[10px] uppercase tracking-wide text-dim mb-1.5">{label}</p>
      <p className={cn("font-mono text-lg font-bold tabular-nums leading-none", tone)}>
        {num != null && Number.isFinite(num) ? <CountUp value={num} format={format} /> : value}
      </p>
    </div>
  );
}

export default function Backtest() {
  const [market, setMarket] = useState("crypto");
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL.crypto);
  const [interval, setIntervalId] = useState("1d");
  const [range, setRange] = useState("5y");
  const [dataSrc, setDataSrc] = useState("yahoo"); // stock data: yahoo | london (LSE archive)
  // Custom test period — backtest exactly the window you pick (e.g. only the
  // 2022 bear market), instead of "the last N years".
  const [customPeriod, setCustomPeriod] = useState(false);
  const [fromDate, setFromDate] = useState("2020-01-01");
  const [toDate, setToDate] = useState(() => new Date().toISOString().slice(0, 10));
  // UNIFIED editor: `strategyId` selects a PRESET whose code is loaded into the
  // single `code` field. Editing the code detaches it from the preset (the preset
  // dropdown then reads "Custom"), and `lang` is DETECTED, never chosen.
  const [strategyId, setStrategyId] = useState(BUILT_IN_STRATEGIES[0].id);
  const [paramValues, setParamValues] = useState({});
  const [presetDirty, setPresetDirty] = useState(false); // code edited away from the preset
  const [code, setCode] = useState(() =>
    strategyToCode({ mode: "builder", strategyId: BUILT_IN_STRATEGIES[0].id, params: {} }, "python") || PYTHON_TEMPLATE);
  const [pyStatus, setPyStatus] = useState(null); // Pyodide loading/progress text
  const lang = useMemo(() => detectLang(code), [code]);
  // Code-validity audit — the same check Cortex runs, so a bug (look-ahead,
  // degenerate arbitrage, no risk exit) is visible right where you write the code.
  const audit = useMemo(() => auditStrategy(code, lang === "python" ? "python" : "js"), [code, lang]);
  // A clean (unedited) preset still runs through the fast builder implementation;
  // only edited code goes through the JS/Python compiler.
  const mode = presetDirty ? "code" : "builder";
  const [capital, setCapital] = useState(10000);
  const [feeBps, setFeeBps] = useState(10);
  const [positionPct, setPositionPct] = useState(100);
  const [leverage, setLeverage] = useState(1);
  const [applyFunding, setApplyFunding] = useState(false); // perp funding (crypto)
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [verdicts, setVerdicts] = useState({ wf: null, dsr: null, noise: null });
  const [saved, setSaved] = useState(false);
  const [fromRegistry, setFromRegistry] = useState(false);

  // Deep-link from the Registry ("Open in Backtester"): pre-fill the EXACT market,
  // window (as a custom from/to period — the research ranges like "10y" aren't in
  // the dropdown), fee, sizing and code so an agent's registry number reproduces
  // here 1:1. Handed off via sessionStorage to avoid URL-length limits on code.
  useEffect(() => {
    let h;
    try { h = JSON.parse(sessionStorage.getItem("backtest_handoff") || "null"); } catch { h = null; }
    if (!h) return;
    sessionStorage.removeItem("backtest_handoff");
    if (h.market) setMarket(h.market);
    if (h.symbol) setSymbol(h.symbol);
    if (h.interval) setIntervalId(h.interval);
    if (h.customPeriod) { setCustomPeriod(true); if (h.fromDate) setFromDate(h.fromDate); if (h.toDate) setToDate(h.toDate); }
    if (h.feeBps != null) setFeeBps(h.feeBps);
    if (h.positionPct != null) setPositionPct(h.positionPct);
    // Code handed over from the Registry goes straight into the one editor; the
    // language detects itself, so no mode/lang to restore.
    if (typeof h.code === "string" && h.code.trim()) { setCode(h.code); setPresetDirty(true); }
    else if (h.strategyId) { setStrategyId(h.strategyId); if (h.params) setParamValues(h.params); }
    if (h.leverage != null) setLeverage(h.leverage);
    setFromRegistry(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // AI code generation: the provider keys never reach the browser — the Pages
  // Function /api/generate holds them server-side; access requires the signed-in
  // ADMIN (dev) session. The panel is simply hidden for everyone else.
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiLoading, setAiLoading] = useState(false); // false | "new" | "improve" | "review"
  const [aiError, setAiError] = useState(null);
  const [aiReview, setAiReview] = useState(null);    // prose assessment of the current code
  const [aiBugs, setAiBugs] = useState(null);        // structured code-bug review (look-ahead, degenerate, …)
  const [prevCode, setPrevCode] = useState(null);    // undo target for an AI rewrite
  const [aiCompare, setAiCompare] = useState(null);  // measured before/after of a rewrite
  const [aiRejected, setAiRejected] = useState(null); // a worse attempt we did NOT apply
  const [aiNote, setAiNote] = useState(null);        // status line for the improve flow
  const [omniCfg, setOmniCfg] = useState(() => omniConfig()); // local OmniRoute + CLI settings
  const [omniStatus, setOmniStatus] = useState(null); // null | "checking" | "ok" | "down"
  const [omniModelList, setOmniModelList] = useState([]); // models discovered from /models
  const [cliStatus, setCliStatus] = useState(null);
  const pingOmni = async () => {
    setOmniStatus("checking");
    const ok = await omniPing();
    setOmniStatus(ok ? "ok" : "down");
    // Discover the real model ids so the user can pick Claude (cc/claude-opus-4-8)
    // instead of a guessed alias. Auto-select a Claude/Opus model if none set.
    if (ok) {
      const models = await omniModels();
      setOmniModelList(models);
      if (models.length && (!omniCfg.model || !models.includes(omniCfg.model))) {
        const pick = models.find((m) => /claude.*opus|opus.*4-8|opus-4/i.test(m)) || models.find((m) => /claude/i.test(m)) || models[0];
        if (pick) { const c = setOmniConfig({ model: pick }); setOmniCfg(c); }
      }
    }
  };
  const pingCli = async () => { setCliStatus("checking"); setCliStatus((await omniPing(cliUrl())) ? "ok" : "down"); };
  useEffect(() => { if (omniCfg.enabled) pingOmni(); if (omniCfg.cliEnabled) pingCli(); /* eslint-disable-next-line */ }, []);
  const [copied, setCopied] = useState(false);
  const { data: session } = useSession();
  const isDev = session?.user?.role === "admin";

  // Copy the strategy in any of the three languages. A clean PRESET can be
  // translated to all three (JS / Python twins + the Pine exporter). Edited code
  // is only itself — offering a fake translation would be lying, so we say so.
  const copyAs = async (target) => {
    let text = null;
    // C++ and kdb+/q are REFERENCE exports — a scaffold + the exact source to port.
    // They work for BOTH a clean preset and edited code (never runnable here).
    if (target === "cpp" || target === "q") {
      const entry = (!presetDirty && strategy)
        ? { mode: "builder", strategyId, params: effectiveParams, name: strategy.name }
        : { mode: "code", code, language: lang === "python" ? "python" : "js", name: "Custom strategy" };
      text = strategyToCode(entry, target);
    } else if (!presetDirty && strategy) {
      const entry = { mode: "builder", strategyId, params: effectiveParams, positionPct, feeBps, name: strategy.name };
      text = strategyToCode(entry, target === "js" ? "js" : target);
    } else if (target === lang) {
      text = code;
    }
    if (!text || !String(text).trim()) {
      setError(target === "pine"
        ? "Pine export is available for the built-in presets — pick one (or reset your edits) to copy it as Pine."
        : `This edited code is ${LANG_LABEL[lang]}; it can't be auto-translated to ${LANG_LABEL[target]}. Copy it as ${LANG_LABEL[lang]}, or reset to the preset.`);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(target);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };

  /**
   * Re-run the SAME backtest (same candles, fees, sizing) for the code before and
   * after an AI rewrite, so "improved" is a measured claim rather than a promise.
   * Returns null when a version can't run — the caller then just stays quiet.
   */
  const compareVersions = async (beforeSrc, afterSrc, prev) => {
    const runOne = async (src) => {
      try {
        const l = detectLang(src);
        let fn;
        if (l === "python") fn = signalsToFn(await runPythonSignals(src, prev.candles, setPyStatus));
        else fn = compileStrategy(src);
        const r = runBacktest({ candles: prev.candles, signalFn: fn, initialCapital: capital, feeBps, positionPct, leverage });
        if (r.warnings.some((w) => /error/i.test(w))) return null;
        return r.metrics;
      } catch { return null; }
    };
    const [a, b] = [await runOne(beforeSrc), await runOne(afterSrc)];
    setPyStatus(null);
    if (!a || !b) return null;
    return { before: a, after: b };
  };

  // The AI works on THIS editor in three ways:
  //   "new"     — write a fresh strategy from the prompt
  //   "improve" — rewrite the code that's in the editor (prompt = what to change)
  //   "review"  — read the code and give an assessment, changing nothing
  const runAi = async (action) => {
    const p = aiPrompt.trim();
    const src = code.trim();
    if (aiLoading) return;
    if (action === "new" && !p) return;
    if (action !== "new" && !src) { setAiError("The editor is empty — there's nothing to work on."); return; }
    if (action !== "new" && lang === "pine") {
      setAiError("Pine Script is an export format here — the AI reviews and improves the JavaScript or Python that actually runs in this engine.");
      return;
    }
    // Improve needs a baseline backtest to verify against — without one it can't
    // know whether an "improvement" actually helped.
    if (action === "improve" && !result?.candles?.length) {
      setAiError("Run the backtest first — then I can verify an improvement actually beats it, and only keep it if it does.");
      return;
    }
    setAiLoading(action);
    setAiError(null);
    setAiReview(null);
    setAiBugs(null);
    setAiCompare(null);
    setAiRejected(null);
    setAiNote(null);
    try {
      // Give the model the CURRENT numbers as the bar to beat. Without them it
      // rewrites blind — which is how an "improvement" ended up doubling the
      // drawdown it was asked to cut.
      const m = result?.metrics;
      const baseline = m
        ? `The current version, backtested on ${symbol} ${interval} (${result.candleCount} bars, ${feeBps}bps/side, ${positionPct}% position${leverage > 1 ? `, ${leverage}x leverage` : ""}), scores: ` +
          `total return ${m.totalReturnPct.toFixed(1)}%, max drawdown ${m.maxDrawdownPct.toFixed(1)}%, Sharpe ${(m.sharpe ?? 0).toFixed(2)}, ` +
          `profit factor ${Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "∞"}, ${m.tradeCount} trades ` +
          `(buy & hold over the same window: ${(m.buyHoldReturnPct ?? 0).toFixed(1)}%, Sharpe ${(m.buyHoldSharpe ?? 0).toFixed(2)}). ` +
          "Your version MUST beat these on Sharpe without materially worsening drawdown. Make the SMALLEST change that does so — " +
          "keep the core idea and the trade count in the same ballpark; do not buy one metric with another " +
          "(no cutting drawdown by barely trading, no lifting return by doubling drawdown)."
        : "";
      const improveBody = { improve: {
        code: src,
        facts: `${p || "Make the smallest change that raises risk-adjusted return without changing the core idea."}${baseline ? `\n\n${baseline}` : ""}`,
        title: presetDirty ? "an edited strategy" : strategy?.name,
      }, language: lang };

      const callGenerate = async (body) => {
        // Priority: local CLI (your Claude subscription — free Opus) → local
        // OmniRoute (free/strong) → the Cloudflare provider chain. Each falls
        // through on any failure or empty result.
        if (cliEnabled()) {
          const viaCli = await omniGenerate(body, { url: cliUrl(), model: cliModel() }).catch(() => null);
          if (viaCli && (viaCli.code || viaCli.review || viaCli.critique || viaCli.codeReview)) {
            return { res: { ok: true, status: 200 }, data: viaCli };
          }
        }
        if (omniEnabled()) {
          const local = await omniGenerate(body).catch(() => null);
          if (local && (local.code || local.review || local.critique || local.codeReview)) {
            return { res: { ok: true, status: 200 }, data: local };
          }
        }
        const res = await fetch("/api/generate", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 401) throw new Error("Sign in with the dev account to use AI generation.");
        if (res.status === 503) throw new Error("AI not configured yet (Cloudflare secrets missing).");
        if (res.status === 429) throw new Error("Rate limit reached — please wait a moment.");
        return { res, data };
      };

      if (action === "review") {
        const { res, data } = await callGenerate({ review: { code: src, prompt: p }, language: lang });
        if (!res.ok || !data.review) throw new Error("Review failed — please try again.");
        setAiReview(data.review);
      } else if (action === "bugs") {
        // The same code-audit Cortex runs on survivors — reads the SOURCE for
        // correctness bugs (look-ahead, degenerate signals, wrong math), HFT-aware.
        const { res, data } = await callGenerate({ codeReview: { code: src, title: presetDirty ? "an edited strategy" : strategy?.name, language: lang }, language: lang });
        if (!res.ok || !data.codeReview) throw new Error("Audit failed — please try again.");
        setAiBugs(data.codeReview);
      } else if (action === "new") {
        const { res, data } = await callGenerate({ prompt: p, language: lang });
        if (!res.ok || !data.code) throw new Error("Generation failed — please try again.");
        setPrevCode(code); setCode(data.code); setPresetDirty(true);
      } else {
        // IMPROVE — verify before apply. Fetch a couple of candidates, backtest
        // each against the current version, and only apply one that genuinely
        // beats it. If none do, keep the user's code and show the best attempt.
        const N = 2;
        const settled = await Promise.allSettled(Array.from({ length: N }, () => callGenerate(improveBody)));
        const codes = [];
        for (const s of settled) {
          if (s.status === "fulfilled" && s.value.res.ok && s.value.data.code) codes.push(s.value.data.code);
        }
        // de-dupe identical candidates
        const uniq = [...new Set(codes)];
        if (!uniq.length) {
          const firstReject = settled.find((s) => s.status === "rejected");
          throw new Error(firstReject?.reason?.message || "Generation failed — please try again.");
        }
        const scored = [];
        for (const cand of uniq) {
          const cmp = await compareVersions(src, cand, result);
          if (cmp) scored.push({ code: cand, cmp });
        }
        const isBetter = (c) => (c.after.sharpe ?? -99) > (c.before.sharpe ?? -99) && c.after.maxDrawdownPct <= c.before.maxDrawdownPct * 1.05;
        const gain = (c) => (c.after.sharpe ?? 0) - (c.before.sharpe ?? 0);
        const winners = scored.filter((s) => isBetter(s.cmp)).sort((a, b) => gain(b.cmp) - gain(a.cmp));
        if (winners.length) {
          setPrevCode(code); setCode(winners[0].code); setPresetDirty(true);
          setAiCompare(winners[0].cmp);
          setAiNote({ ok: true, text: `Applied a verified improvement${uniq.length > 1 ? ` (best of ${uniq.length} attempts)` : ""}.` });
        } else if (scored.length) {
          // Nothing beat the current version — DON'T make it worse. Keep the code,
          // surface the best attempt so the user can inspect or force-apply it.
          const best = scored.sort((a, b) => gain(b.cmp) - gain(a.cmp))[0];
          setAiCompare(best.cmp);
          setAiRejected(best.code);
          setAiNote({ ok: false, text: `No attempt beat your current version — kept yours. The best try is below.` });
        } else {
          throw new Error("Couldn't backtest the attempts — please try again.");
        }
      }
    } catch (e) {
      setAiError(e.message);
    } finally {
      setAiLoading(false);
    }
  };

  // Apply a rejected AI attempt anyway (the user overrides the "not better" call).
  const applyRejected = () => {
    if (!aiRejected) return;
    setPrevCode(code); setCode(aiRejected); setPresetDirty(true);
    setAiRejected(null); setAiNote({ ok: true, text: "Applied the AI's attempt (you overrode the verification)." });
  };

  const strategy = useMemo(
    () => BUILT_IN_STRATEGIES.find((s) => s.id === strategyId),
    [strategyId]
  );

  const effectiveParamsFor = (s, vals) =>
    Object.fromEntries((s?.params || []).map((p) => [p.key, vals[p.key] ?? p.default]));

  // Load the selected preset (with its current params) into the editor as PYTHON —
  // the canonical, readable form. Skipped once the user edits the code, so their
  // work is never overwritten; "Reset to preset" brings the preset back.
  useEffect(() => {
    if (presetDirty || !strategy) return;
    const src =
      strategyToCode({ mode: "builder", strategyId, params: effectiveParamsFor(strategy, paramValues) }, "python") ||
      strategyToCode({ mode: "builder", strategyId, params: effectiveParamsFor(strategy, paramValues) }) ||
      PYTHON_TEMPLATE;
    setCode(src);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategyId, paramValues, presetDirty]);

  // Only ranges that actually exist for the chosen interval (e.g. Yahoo has
  // no multi-year hourly data — it would silently degrade to monthly bars and
  // quietly wreck the test). Snap the range when the interval changes.
  const validRanges = useMemo(() => rangesFor(interval, market), [interval, market]);
  useEffect(() => {
    if (!validRanges.some((r) => r.id === range)) {
      setRange(validRanges[validRanges.length - 1].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interval, market]);

  const effectiveParams = useMemo(() => {
    const out = {};
    for (const p of strategy.params) out[p.key] = paramValues[p.key] ?? p.default;
    return out;
  }, [strategy, paramValues]);

  const switchMarket = (m) => {
    setMarket(m);
    setSymbol(DEFAULT_SYMBOL[m]);
    if (m === "stock" && !INTERVALS.find((i) => i.id === interval)?.markets.includes("stock")) {
      setIntervalId("1d");
    }
  };

  const run = async () => {
    // Pine Script is an EXPORT target — TradingView runs it, this engine can't.
    // Say that plainly instead of failing inside the compiler.
    if (lang === "pine") {
      setError("That's Pine Script — it runs on TradingView, not in this engine. Paste JavaScript or Python here, or use a preset and copy it as Pine.");
      return;
    }
    // C++ and kdb+/q can't run in the browser — they go to the native executor on
    // your PC. Point there instead of failing inside the JS compiler.
    if (lang === "cpp" || lang === "q") {
      setError(`That's ${LANG_LABEL[lang]} — it runs natively on your PC, not in the browser. Use “Run natively on my PC” below.`);
      return;
    }
    setRunning(true);
    setError(null);
    try {
      // Python needs the candles first (it computes a vectorised signal array),
      // so fetch data before building the signal function in every mode.
      // Custom period → explicit unix window through whichever source is active.
      let from, to;
      if (customPeriod) {
        from = Math.floor(Date.parse(fromDate + "T00:00:00Z") / 1000);
        to = Math.floor(Date.parse(toDate + "T23:59:59Z") / 1000);
        if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
          throw new Error("Custom period: pick a valid from/to date range.");
        }
      }
      const candles = market === "stock" && dataSrc === "london"
        ? await fetchLseCandles({
            symbol: symbol.trim().toUpperCase(), interval,
            rangeDays: validRanges.find((r) => r.id === range)?.days ?? 365,
            from, to,
          })
        : await fetchCandles({ market, symbol: symbol.trim().toUpperCase(), interval, range, from, to });
      let signalFn;
      if (mode === "builder") {
        // Untouched preset → run the fast native implementation (its Python twin
        // is verified to trade identically, so the shown code is truthful).
        signalFn = strategy.build(effectiveParams);
      } else if (lang === "python") {
        const signals = await runPythonSignals(code, candles, setPyStatus);
        setPyStatus(null);
        signalFn = signalsToFn(signals); // Python signals → same JS fill engine
      } else {
        signalFn = compileStrategy(code);
      }
      // Perp funding (crypto only): fetch the funding history for this window so
      // the backtest charges longs / credits shorts, instead of pretending
      // funding is free. Best-effort — a fetch failure just runs without it.
      let fundingRates = null;
      if (applyFunding && market === "crypto" && candles.length) {
        try {
          fundingRates = await fetchFunding(symbol.trim().toUpperCase(), candles[0].time, candles[candles.length - 1].time);
          if (!fundingRates.length) setError("No perp funding history for this symbol — ran without funding.");
        } catch (e) { setError(`Funding unavailable (${e.message}) — ran without it.`); }
      }
      const res = runBacktest({ candles, signalFn, initialCapital: capital, feeBps, positionPct, leverage, fundingRates });
      // Data sanity: if the source silently delivered a coarser granularity
      // than requested (Yahoo does this for long intraday ranges), say so
      // loudly — indicator periods would mean something entirely different.
      // Zero trades is almost always a setup mismatch — say why instead of
      // showing a silent all-zero result.
      if (res.metrics.tradeCount === 0) {
        res.warnings.unshift(
          mode === "builder" && strategyId === "opening-range-breakout" && !["1s","1m","5m","15m","30m","1h","2h","4h"].includes(interval)
            ? "ORB needs an INTRADAY interval (e.g. 5m or 15m): on daily candles every bar starts a new day, so an opening range can never form — the strategy stays flat forever."
            : "No trades were made — the entry conditions never triggered on this data (check interval, range and parameters)."
        );
      }
      if (candles.length >= 3) {
        const spac = [];
        for (let i = 1; i < candles.length; i++) spac.push(candles[i].time - candles[i - 1].time);
        spac.sort((a, b) => a - b);
        const med = spac[Math.floor(spac.length / 2)];
        const want = INTERVAL_SECONDS[interval] || 0;
        if (want > 0 && med > want * 3) {
          res.warnings.unshift(
            `Data mismatch: you requested ${interval} candles but the source delivered ~${Math.round(med / 86400) >= 1 ? Math.round(med / 86400) + "-day" : Math.round(med / 3600) + "-hour"} bars for this range. Indicator periods now mean something else — pick a shorter range or a larger interval.`
          );
        }
      }
      setResult({ ...res, candles, symbol: symbol.trim().toUpperCase(), candleCount: candles.length });
      setVerdicts({ wf: null, dsr: null, noise: null });
      setSaved(false);
    } catch (e) {
      setError(e.message);
      setResult(null);
    } finally {
      setRunning(false);
      setPyStatus(null);
    }
  };

  const saveToRegistry = () => {
    if (!result) return;
    // Time-window memory: WHERE in the backtest the money was made. Stored on the
    // entry so a decayed ("good-early") strategy carries its flaw, and Cortex can
    // later pair it with a complementary ("good-late") one.
    const wp = windowProfile(result.equity, { segments: 2 });
    const flaw = wp && wp.profile !== "consistent" && wp.profile !== "good-late" ? wp.summary : null;
    saveEntry({
      name: mode === "builder" ? strategy.name : `${strategy?.name || "Code"} (edited)`,
      market, symbol: symbol.trim().toUpperCase(), interval, range,
      mode,
      strategyId: mode === "builder" ? strategyId : null,
      params: mode === "builder" ? effectiveParams : null,
      code: mode === "code" ? code : null,
      language: mode === "code" ? lang : null,
      positionPct, feeBps,
      metrics: result.metrics,
      equity: result.equity,
      tradeReturns: result.trades.map((t) => t.pnlPct / 100),
      validation: verdicts,
      windowProfile: wp,
      failureReason: flaw,
      // A strategy that passed every run validation earns "validated" straight away.
      status: verdicts.wf === "pass" && verdicts.dsr === "pass" && verdicts.noise === "pass" ? "validated" : "factory",
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const equitySeries = useMemo(() => {
    if (!result) return null;
    return [
      { label: "Strategy", color: "#2dd4bf", points: result.equity },
      { label: "Buy & Hold", color: "#64748b", points: result.buyHold },
    ];
  }, [result]);

  // Entry/exit arrows on the price chart — direction-aware so you can see
  // exactly where the strategy went long or short and how it got out.
  // lightweight-charts silently drops unsorted markers, so sort by time
  // (entries before exits on the same bar for readability).
  const tradeMarkers = useMemo(() => {
    if (!result?.trades) return [];
    const out = [];
    for (const t of result.trades) {
      const short = t.side === "short";
      out.push({ time: t.entryTime, side: short ? "sell" : "buy", text: short ? "Short" : "Long", order: 0 });
      out.push({ time: t.exitTime, side: short ? "buy" : "sell", text: short ? "Cover" : "Sell", order: 1 });
    }
    out.sort((a, b) => a.time - b.time || a.order - b.order);
    return out;
  }, [result]);

  const m = result?.metrics;

  return (
    <div>
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Strategy Lab</p>
      <h1 className="text-2xl font-bold mb-6">Backtest</h1>

      <div className="grid lg:grid-cols-[340px_1fr] gap-6 [&>*]:min-w-0">
        {/* ── Settings column ─────────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="rounded-xl border border-line lg-glass p-4 space-y-3">
            <p className="text-xs text-dim font-medium">Data</p>
            <div className="flex gap-1">
              {MARKETS.map((mk) => (
                <button key={mk.id} onClick={() => switchMarket(mk.id)}
                  className={cn("chip", market === mk.id ? "chip-active" : "chip-idle")}>
                  {mk.label}
                </button>
              ))}
            </div>
            <SymbolSearch
              market={market}
              value={symbol}
              onSelect={setSymbol}
              placeholder={market === "crypto" ? "e.g. Bitcoin or BTCUSDT" : "e.g. Apple or SPY"}
              className="w-full"
            />
            <div className="flex flex-wrap gap-1">
              {INTERVALS.filter((i) => i.markets.includes(market)).map((i) => (
                <button key={i.id} onClick={() => setIntervalId(i.id)}
                  className={cn("chip font-mono", interval === i.id ? "chip-active" : "chip-idle")}>
                  {i.label}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {validRanges.map((r) => (
                <button key={r.id} onClick={() => { setRange(r.id); setCustomPeriod(false); }}
                  className={cn("chip font-mono", !customPeriod && range === r.id ? "chip-active" : "chip-idle")}>
                  {r.label}
                </button>
              ))}
              <button onClick={() => setCustomPeriod(true)}
                title="Backtest an exact period, e.g. only the 2022 bear market"
                className={cn("chip font-mono", customPeriod ? "chip-active" : "chip-idle")}>
                Custom
              </button>
            </div>
            {customPeriod && (
              <div className="flex flex-wrap items-end gap-2">
                <label className="text-xs text-dim">
                  From
                  <input type="date" value={fromDate} max={toDate}
                    onChange={(e) => setFromDate(e.target.value)}
                    className="input-base w-36 mt-1 font-mono block" />
                </label>
                <label className="text-xs text-dim">
                  To
                  <input type="date" value={toDate} min={fromDate} max={new Date().toISOString().slice(0, 10)}
                    onChange={(e) => setToDate(e.target.value)}
                    className="input-base w-36 mt-1 font-mono block" />
                </label>
              </div>
            )}
            {customPeriod && market === "stock" && dataSrc === "yahoo" && INTERVALS.find((i) => i.id === interval && !["1d", "1w", "1M"].includes(i.id)) && (
              <p className="text-[11px] text-dim">Yahoo serves intraday data only for recent weeks — for older periods use daily bars or the London source.</p>
            )}
            {market === "stock" && (
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-dim uppercase tracking-wide mr-1">Source</span>
                {[["yahoo", "Yahoo"], ["london", "London"]].map(([id, label]) => (
                  <button key={id} onClick={() => setDataSrc(id)}
                    title={id === "london" ? "London Strategic Edge archive (133B ticks) — needs the LSE_API_KEY secret" : "Yahoo Finance via site proxy"}
                    className={cn("chip !text-[10px] !py-0.5", dataSrc === id ? "chip-active" : "chip-idle")}>
                    {label}
                  </button>
                ))}
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              <label className="text-xs text-dim">
                Starting capital
                <input type="number" value={capital} min={100}
                  onChange={(e) => setCapital(+e.target.value || 10000)} className="input-base w-full mt-1 font-mono" />
              </label>
              <label className="text-xs text-dim">
                Fee (bps/side)
                <input type="number" value={feeBps} min={0} max={100}
                  onChange={(e) => setFeeBps(+e.target.value || 0)} className="input-base w-full mt-1 font-mono" />
              </label>
              <label className="text-xs text-dim" title="Percent of equity deployed per trade — drawdowns scale roughly with this">
                Position (%)
                <input type="number" value={positionPct} min={1} max={100} step={5}
                  onChange={(e) => setPositionPct(+e.target.value || 100)} className="input-base w-full mt-1 font-mono" />
              </label>
              <label className="text-xs text-dim" title="Leverage multiplies exposure (3x = 300%). Amplifies returns AND drawdowns — enough drawdown at high leverage liquidates the account (equity → 0).">
                Leverage (×)
                <input type="number" value={leverage} min={1} max={10} step={1}
                  onChange={(e) => setLeverage(Math.min(10, Math.max(1, +e.target.value || 1)))} className="input-base w-full mt-1 font-mono" />
              </label>
            </div>
            {/* Perp funding — crypto only. Ignoring funding is where most crypto
                backtests quietly lie (a long in positive-funding markets bleeds it). */}
            {market === "crypto" && (
              <label className="flex items-center gap-2 text-xs text-dim cursor-pointer" title="Fetch the Binance perp funding history for the window and charge longs / credit shorts each ~8h funding stamp. Makes crypto backtests honest.">
                <input type="checkbox" checked={applyFunding} onChange={(e) => setApplyFunding(e.target.checked)} className="accent-current" />
                <span className="text-text">Apply perp funding</span> — models the ~8h funding longs pay / shorts earn
              </label>
            )}
          </div>

          <div className="rounded-xl border border-line lg-glass p-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-dim font-medium">Strategy</p>
              <span className={cn("chip !text-[10px] !py-0.5",
                lang === "pine" ? "chip-idle text-accent" : "chip-idle")}
                title="Detected automatically from your code — no need to pick a language">
                {LANG_LABEL[lang]}{lang === "pine" ? " · export only" : ""}
              </span>
            </div>

            {/* Preset picker — loads the strategy into the editor as Python */}
            <div className="flex items-center gap-2">
              <select
                value={presetDirty ? "" : strategyId}
                onChange={(e) => { if (e.target.value) { setStrategyId(e.target.value); setParamValues({}); setPresetDirty(false); } }}
                className="input-base w-full">
                {presetDirty && <option value="">Custom code (edited)</option>}
                {BUILT_IN_STRATEGIES.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              {presetDirty && (
                <button onClick={() => { setPresetDirty(false); setParamValues({}); }}
                  title="Discard your edits and reload the preset"
                  className="chip chip-idle !text-[10px] whitespace-nowrap">Reset</button>
              )}
            </div>
            {!presetDirty && <p className="text-xs text-dim leading-relaxed">{strategy.description}</p>}

            {/* Preset params — editing one re-generates the code below */}
            {!presetDirty && (
              <div className="grid grid-cols-2 gap-2">
                {strategy.params.map((p) => (
                  <label key={p.key} className="text-xs text-dim">
                    {p.label}
                    <input
                      type="number"
                      value={paramValues[p.key] ?? p.default}
                      min={p.min} max={p.max} step={p.step}
                      onChange={(e) => setParamValues((v) => ({ ...v, [p.key]: +e.target.value }))}
                      className="input-base w-full mt-1 font-mono"
                    />
                  </label>
                ))}
              </div>
            )}

            {/* THE one editor — edit freely; the language is detected */}
            <>
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-dim">
                    {presetDirty ? "Your code" : "Preset code — edit it to make it yours"}
                  </p>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-dim">Copy as</span>
                    {["python", "js", "pine", "cpp", "q"].map((target) => (
                      <button key={target}
                        onClick={() => copyAs(target)}
                        title={target === "pine" ? "TradingView Pine Script (presets only)"
                          : target === "cpp" || target === "q" ? `${LANG_LABEL[target]} reference — not runnable here; a scaffold + the exact source to port to your own engine`
                          : `Copy as ${LANG_LABEL[target]}`}
                        className="text-[11px] text-dim hover:text-accent transition-colors">
                        {copied === target ? <Check className="w-3.5 h-3.5 text-up inline" />
                          : target === "js" ? "JS" : target === "python" ? "PY" : target === "pine" ? "Pine" : target === "cpp" ? "C++" : "q"}
                      </button>
                    ))}
                  </div>
                </div>
                <textarea
                  value={code}
                  onChange={(e) => { setCode(e.target.value); setPresetDirty(true); }}
                  spellCheck={false}
                  rows={16}
                  className="input-base w-full font-mono text-xs leading-relaxed resize-y"
                />
                {lang === "pine" ? (
                  <p className="text-[11px] text-accent leading-relaxed">
                    Pine Script runs on TradingView, not in this engine — paste it into a TradingView chart
                    to backtest it there. Use JavaScript or Python here.
                  </p>
                ) : lang === "python" ? (
                  <p className="text-[11px] text-dim leading-relaxed">
                    Define <code className="text-accent">def signals(df)</code> returning one value per bar:{" "}
                    <code className="text-accent">1</code> long, <code className="text-accent">0</code> flat,{" "}
                    <code className="text-accent">-1</code> short. <code>df</code> has columns{" "}
                    <code>open/high/low/close/volume</code>; <code>numpy</code> + <code>pandas</code> available.
                    Runs real CPython (Pyodide, ~6 MB, loads on first run) — the signals feed the same fill
                    engine as JS, so fees and no-look-ahead are identical. For stop/target brackets, return a
                    <code className="text-accent"> DataFrame</code> with <code>signal</code>/<code>stop</code>/<code>target</code> columns.
                  </p>
                ) : (
                  <p className="text-[11px] text-dim leading-relaxed">
                    Define <code className="text-accent">function strategy(ctx)</code> and return{" "}
                    <code className="text-accent">"long"</code>, <code className="text-accent">"short"</code> or{" "}
                    <code className="text-accent">"flat"</code> — or{" "}
                    <code className="text-accent">{'{ signal, stop, target }'}</code> for bracket exits.
                    Available: <code>ctx.candles</code>, <code>ctx.index</code>, <code>ctx.open/high/low/close</code>,{" "}
                    <code>ctx.position</code>, <code>ctx.session</code> (UTC time, isNewDay),{" "}
                    <code>ctx.indicators</code> (sma, ema, rsi, roc, atr, bollinger, donchian, macd).
                  </p>
                )}
                {pyStatus && (
                  <p className="text-[11px] text-accent flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> {pyStatus}
                  </p>
                )}

                {/* AI assistant — dev-account only; hidden for everyone else.
                    Works ON the code above by default: improve it, or review it.
                    Writing something brand-new is the explicit "New" action. */}
                {isDev && (
                  <div className="border-t border-line pt-3 space-y-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <p className="text-[11px] text-dim flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-accent" /> AI — works on the code above
                      </p>
                      {/* CLI/subscription first (your Claude via a shim or OmniRoute), then OmniRoute, then cloud. */}
                      <label className="ml-auto flex items-center gap-1.5 text-[10px] text-dim cursor-pointer" title="Route generation through your Claude subscription first — the CLI shim, or your OmniRoute with the Claude-Code model. Only the builder uses this; background agents don't.">
                        <input type="checkbox" checked={!!omniCfg.cliEnabled}
                          onChange={(e) => { const c = setOmniConfig({ cliEnabled: e.target.checked }); setOmniCfg(c); if (e.target.checked) pingCli(); }}
                          className="accent-current" />
                        CLI (subscription)
                        {omniCfg.cliEnabled && (
                          <span className={cn("w-1.5 h-1.5 rounded-full",
                            cliStatus === "ok" ? "bg-up" : cliStatus === "down" ? "bg-down" : "bg-line")} />
                        )}
                      </label>
                      {/* Free/strong path: route through the local OmniRoute. */}
                      <label className="flex items-center gap-1.5 text-[10px] text-dim cursor-pointer" title="Route generation through your local OmniRoute (free, strong models). Falls back to the cloud if unreachable.">
                        <input type="checkbox" checked={!!omniCfg.enabled}
                          onChange={(e) => { const c = setOmniConfig({ enabled: e.target.checked }); setOmniCfg(c); if (e.target.checked) pingOmni(); }}
                          className="accent-current" />
                        OmniRoute
                        {omniCfg.enabled && (
                          <span className={cn("w-1.5 h-1.5 rounded-full",
                            omniStatus === "ok" ? "bg-up" : omniStatus === "down" ? "bg-down" : "bg-line")} />
                        )}
                      </label>
                    </div>
                    {omniCfg.cliEnabled && (
                      <div className="flex items-center gap-1.5">
                        <input value={omniCfg.cliUrl || "http://localhost:8899/v1"}
                          onChange={(e) => { const c = setOmniConfig({ cliUrl: e.target.value }); setOmniCfg(c); }}
                          placeholder="CLI shim, or your OmniRoute URL" className="input-base flex-1 !py-1 text-[10px] font-mono" />
                        <input value={omniCfg.cliModel || "cli"}
                          onChange={(e) => { const c = setOmniConfig({ cliModel: e.target.value }); setOmniCfg(c); }}
                          placeholder="claude-code model" className="input-base w-32 !py-1 text-[10px] font-mono" />
                        <button onClick={pingCli} className="chip chip-idle !text-[10px]">
                          {cliStatus === "checking" ? "…" : "test"}
                        </button>
                      </div>
                    )}
                    {omniCfg.enabled && (
                      <div className="flex items-center gap-1.5">
                        <input value={omniCfg.url || "http://localhost:3000/v1"}
                          onChange={(e) => { const c = setOmniConfig({ url: e.target.value }); setOmniCfg(c); }}
                          placeholder="http://localhost:3000/v1" className="input-base flex-1 !py-1 text-[10px] font-mono" />
                        <input value={omniCfg.model || ""} list="omni-model-list"
                          onChange={(e) => { const c = setOmniConfig({ model: e.target.value }); setOmniCfg(c); }}
                          placeholder="model (e.g. cc/claude-opus-4-8)" className="input-base w-40 !py-1 text-[10px] font-mono" />
                        <datalist id="omni-model-list">
                          {omniModelList.map((m) => <option key={m} value={m} />)}
                        </datalist>
                        <button onClick={pingOmni} className="chip chip-idle !text-[10px]" title="Test + load the models your OmniRoute serves">
                          {omniStatus === "checking" ? "…" : "test"}
                        </button>
                      </div>
                    )}
                    {omniCfg.enabled && omniStatus === "ok" && omniModelList.length > 0 && (
                      <p className="text-[10px] text-dim">
                        {omniModelList.length} models available — Claude:{" "}
                        <span className="text-text font-mono">{omniModelList.filter((m) => /claude|opus|sonnet|haiku/i.test(m)).slice(0, 4).join(", ") || "none found"}</span>. Pick one in the model box.
                      </p>
                    )}
                    {((omniCfg.cliEnabled && cliStatus === "down") || (omniCfg.enabled && omniStatus === "down")) && (
                      <p className="text-[10px] text-down">A local endpoint is unreachable — the AI falls through (CLI → OmniRoute → cloud). Check it's running + allows CORS for <span className="font-mono">{typeof window !== "undefined" ? window.location.origin : "this origin"}</span> (OmniRoute → CORS settings).</p>
                    )}
                    <textarea
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      placeholder="What should change? e.g. add an ATR stop and only trade above the SMA 200 — leave empty to let it improve robustness on its own"
                      rows={3}
                      className="input-base w-full text-xs resize-y"
                    />
                    <button onClick={() => runAi("improve")} disabled={!!aiLoading || !code.trim()}
                      title="Rewrites the code in the editor, keeping its core idea"
                      className="btn-accent w-full flex items-center justify-center gap-2 !py-1.5 text-xs">
                      {aiLoading === "improve" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                      {aiLoading === "improve" ? "Improving…" : "Improve this strategy"}
                    </button>
                    <div className="flex items-center gap-2">
                      <button onClick={() => runAi("review")} disabled={!!aiLoading || !code.trim()}
                        title="Assess the code — explains what it does and what to fix. Changes nothing."
                        className="chip chip-idle !text-[11px] flex-1 flex items-center justify-center gap-1.5">
                        {aiLoading === "review" ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Review
                      </button>
                      <button onClick={() => runAi("bugs")} disabled={!!aiLoading || !code.trim()}
                        title="The same code-audit Cortex runs — reads the source for correctness bugs (look-ahead, degenerate signals, wrong math). Changes nothing."
                        className="chip chip-idle !text-[11px] flex-1 flex items-center justify-center gap-1.5">
                        {aiLoading === "bugs" ? <Loader2 className="w-3 h-3 animate-spin" /> : null} Find bugs
                      </button>
                      <button onClick={() => runAi("new")} disabled={!!aiLoading || !aiPrompt.trim()}
                        title="Ignore the editor and write a brand-new strategy from your description"
                        className="chip chip-idle !text-[11px] flex-1 flex items-center justify-center gap-1.5">
                        {aiLoading === "new" ? <Loader2 className="w-3 h-3 animate-spin" /> : null} New from prompt
                      </button>
                      {prevCode != null && (
                        <button onClick={() => { setCode(prevCode); setPrevCode(null); }}
                          title="Restore the code from before the last AI rewrite"
                          className="chip chip-idle !text-[11px]">Undo</button>
                      )}
                    </div>
                    {aiError && <p className="text-[11px] text-down">{aiError}</p>}
                    {aiNote && <p className={cn("text-[11px]", aiNote.ok ? "text-up" : "text-amber-400")}>{aiNote.text}</p>}
                    {/* Measured verdict — the same backtest, before vs after. When the
                        attempt was rejected (kept your version), it's shown as a rejected
                        try you can force-apply, not something already in the editor. */}
                    {aiCompare && (() => {
                      const { before: b, after: a } = aiCompare;
                      const rows = [
                        ["Return", b.totalReturnPct, a.totalReturnPct, 1, (v) => `${v.toFixed(1)}%`],
                        ["Max drawdown", b.maxDrawdownPct, a.maxDrawdownPct, -1, (v) => `${v.toFixed(1)}%`],
                        ["Sharpe", b.sharpe ?? 0, a.sharpe ?? 0, 1, (v) => v.toFixed(2)],
                        ["Trades", b.tradeCount, a.tradeCount, 0, (v) => String(v)],
                      ];
                      const better = (a.sharpe ?? 0) > (b.sharpe ?? 0) && a.maxDrawdownPct <= b.maxDrawdownPct * 1.05;
                      const rejected = !!aiRejected;
                      return (
                        <div className={cn("rounded-lg border p-3", rejected ? "border-amber-400/30 bg-amber-400/5" : better ? "border-up/30 bg-up/5" : "border-down/30 bg-down/5")}>
                          <p className={cn("text-[10px] uppercase tracking-wide font-semibold mb-1.5", rejected ? "text-amber-400" : better ? "text-up" : "text-down")}>
                            {rejected ? "Best attempt — NOT applied (yours is better)" : better ? "Applied: measured better" : "Measured: not better — consider Undo"}
                          </p>
                          <table className="w-full text-[11px] font-mono">
                            <tbody>
                              {rows.map(([label, bv, av, dir, fmt]) => {
                                const delta = av - bv;
                                const good = dir === 0 ? null : dir > 0 ? delta > 0 : delta < 0;
                                return (
                                  <tr key={label}>
                                    <td className="text-dim font-sans pr-2">{label}</td>
                                    <td className="text-dim text-right">{fmt(bv)}</td>
                                    <td className="text-dim px-1">→</td>
                                    <td className={cn("text-right", good == null ? "text-text" : good ? "text-up" : "text-down")}>{fmt(av)}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          <p className="text-[10px] text-dim mt-1.5">Same data, fees and sizing as your last run.</p>
                          {aiRejected && (
                            <button onClick={applyRejected} className="chip chip-idle !text-[10px] mt-2 hover:text-accent">Apply anyway</button>
                          )}
                        </div>
                      );
                    })()}
                    {aiReview && (
                      <div className="rounded-lg border border-line bg-bg/50 p-3">
                        <div className="flex items-center justify-between mb-1.5">
                          <p className="text-[10px] uppercase tracking-wide text-accent font-semibold">AI review</p>
                          <button onClick={() => setAiReview(null)} className="text-[10px] text-dim hover:text-text">dismiss</button>
                        </div>
                        <p className="text-[11px] text-dim leading-relaxed whitespace-pre-wrap">{aiReview}</p>
                      </div>
                    )}
                    {aiBugs && (
                      <div className={cn("rounded-lg border p-3", aiBugs.bugs.some((b) => b.severity === "critical") ? "border-down/40 bg-down/5" : aiBugs.bugs.length ? "border-warn/40 bg-warn/5" : "border-up/30 bg-up/5")}>
                        <div className="flex items-center justify-between mb-1.5">
                          <p className={cn("text-[10px] uppercase tracking-wide font-semibold", aiBugs.bugs.some((b) => b.severity === "critical") ? "text-down" : aiBugs.bugs.length ? "text-warn" : "text-up")}>
                            AI code audit — {aiBugs.verdict === "clean" ? "no bugs found" : `${aiBugs.bugs.length} issue${aiBugs.bugs.length > 1 ? "s" : ""}`} · {aiBugs.confidence}% confident
                          </p>
                          <button onClick={() => setAiBugs(null)} className="text-[10px] text-dim hover:text-text">dismiss</button>
                        </div>
                        {aiBugs.summary && <p className="text-[11px] text-dim mb-1.5">{aiBugs.summary}</p>}
                        <ul className="space-y-1.5">
                          {aiBugs.bugs.map((b, i) => (
                            <li key={i} className="text-[11px] leading-relaxed">
                              <span className={cn("shrink-0 font-semibold mr-1.5", b.severity === "critical" ? "text-down" : "text-warn")}>{b.severity === "critical" ? "✕" : "!"}</span>
                              <span className="text-text/85">{b.issue}</span>
                              {b.fix && <span className="block text-dim ml-4 mt-0.5">→ {b.fix}</span>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {mode === "code" && audit.findings.length > 0 && (
                      <div className={cn("rounded-lg border p-3", audit.blocked ? "border-down/40 bg-down/5" : "border-warn/40 bg-warn/5")}>
                        <p className={cn("text-[10px] uppercase tracking-wide font-semibold mb-1.5", audit.blocked ? "text-down" : "text-warn")}>
                          Code audit — {audit.critical ? `${audit.critical} critical bug${audit.critical > 1 ? "s" : ""}` : `${audit.warnings} warning${audit.warnings > 1 ? "s" : ""}`}
                          {audit.blocked && " · results can't be trusted"}
                        </p>
                        <ul className="space-y-1">
                          {audit.findings.map((f, i) => (
                            <li key={i} className="text-[11px] leading-relaxed flex gap-1.5">
                              <span className={cn("shrink-0 font-semibold", f.severity === "critical" ? "text-down" : "text-warn")}>{f.severity === "critical" ? "✕" : "!"}</span>
                              <span className="text-text/85">{f.msg}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </>
          </div>

          <button onClick={run} disabled={running} className="btn-accent w-full flex items-center justify-center gap-2">
            <Play className="w-4 h-4" />
            {running ? "Running…" : "Run backtest"}
          </button>

          {isDev && (
            <NativeRunPanel
              spec={{
                code, language: lang, market, symbol, interval, range,
                capital, feeBps, positionPct, leverage,
              }}
            />
          )}

          {error && (
            <div className="rounded-xl border border-down/40 bg-down/10 p-3 text-sm text-down flex gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* ── Results column ──────────────────────────────────────────── */}
        <div className="space-y-4">
          {!result ? (
            <div className="rounded-xl border border-line lg-glass h-72 flex items-center justify-center text-sm text-dim px-8 text-center">
              Pick data and a strategy, then run the backtest — results appear here.
            </div>
          ) : (
            <>
              {result.warnings?.length > 0 && (
                <div className="rounded-xl border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
                  Strategy warning: {result.warnings[0]}
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3 stagger">
                <MetricCard label="Return" num={m.totalReturnPct} format={fmtPct}
                  tone={m.totalReturnPct >= 0 ? "text-up" : "text-down"} />
                <MetricCard label="Buy & Hold" num={m.buyHoldReturnPct} format={fmtPct}
                  tone={m.buyHoldReturnPct >= 0 ? "text-up" : "text-down"} />
                <MetricCard label="CAGR" num={m.cagrPct} format={fmtPct}
                  tone={m.cagrPct >= 0 ? "text-up" : "text-down"} />
                <MetricCard label="Sharpe" num={m.sharpe} format={fmtNum} tone="text-text" />
                <MetricCard label="Sortino" num={Number.isFinite(m.sortino) ? m.sortino : null} format={fmtNum} tone="text-text" value={Number.isFinite(m.sortino) ? fmtNum(m.sortino) : "∞"} />
                <MetricCard label="Calmar" num={Number.isFinite(m.calmar) ? m.calmar : null} format={fmtNum} tone="text-text" value={Number.isFinite(m.calmar) ? fmtNum(m.calmar) : "∞"} />
                <MetricCard label="Max drawdown" num={-Math.abs(m.maxDrawdownPct)} format={fmtPct} tone="text-down" />
                <MetricCard label="B&H max drawdown" num={-Math.abs(m.buyHoldMaxDrawdownPct ?? 0)} format={fmtPct} tone="text-down" />
                <MetricCard label="Win rate" num={m.winRatePct} format={(v) => fmtPct(v).replace("+", "")} tone="text-text" />
                <MetricCard label="Profit factor" num={Number.isFinite(m.profitFactor) ? m.profitFactor : null} format={fmtNum} tone="text-text" value={fmtNum(m.profitFactor)} />
                <MetricCard label="Trades · Exposure" value={`${m.tradeCount} · ${fmtNum(m.exposurePct, 0)}%`} tone="text-text" />
                {m.fundingPaidPct != null && (
                  <MetricCard label="Funding paid" num={-m.fundingPaidPct} format={fmtPct}
                    tone={m.fundingPaidPct > 0 ? "text-down" : "text-up"}
                    value={`${m.fundingPaidPct >= 0 ? "−" : "+"}${fmtNum(Math.abs(m.fundingPaidPct), 2)}%`} />
                )}
              </div>

              {/* Save to the Strategy Registry (the lab notebook) */}
              <div className="flex flex-wrap items-center gap-3">
                <button onClick={saveToRegistry} disabled={saved}
                  className={cn("flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors",
                    saved ? "border-up/50 text-up bg-up/10" : "border-line text-dim hover:text-accent hover:border-accent/40")}>
                  {saved ? <Check className="w-4 h-4" /> : <Boxes className="w-4 h-4" />}
                  {saved ? "Saved to registry" : "Save to registry"}
                </button>
                <span className="text-[11px] text-dim">
                  {verdicts.wf === "pass" && verdicts.dsr === "pass" && verdicts.noise === "pass"
                    ? <>Passed all three validations → saves straight into <span className="text-up">Validated</span>.</>
                    : <>Saves into <span className="text-text">Factory</span> (a saved candidate). Run the validation below — walk-forward, DSR and noise — and it goes straight into <span className="text-up">Validated</span> instead.</>} ·{" "}
                  <Link to="/registry" className="text-accent hover:underline">open Registry</Link>
                </span>
              </div>

              {/* Parameter optimizer — builder strategies sweep their params via the
                  fast builder; hand-written code uses the async panel that sweeps the
                  constants it detects (JS or Python). Always available after a run. */}
              {mode === "builder" && strategy && result.candles?.length > 100 && (
                <OptimizerPanel
                  strategy={strategy}
                  candles={result.candles}
                  capital={capital}
                  feeBps={feeBps}
                  positionPct={positionPct}
                  leverage={leverage}
                  onApply={(p) => setParamValues({ ...p })}
                />
              )}
              {mode !== "builder" && result.candles?.length > 100 && (
                <CodeOptimizerPanel
                  code={code}
                  language={lang}
                  candles={result.candles}
                  capital={capital}
                  feeBps={feeBps}
                  positionPct={positionPct}
                  leverage={leverage}
                  onApply={(newCode) => { setPrevCode(code); setCode(newCode); setPresetDirty(true); }}
                />
              )}

              {/* Find best market — scan this strategy across the whole universe. */}
              {result.candles?.length > 100 && (
                <MarketScanPanel
                  code={code}
                  language={lang}
                  capital={capital}
                  feeBps={feeBps}
                  positionPct={positionPct}
                  leverage={leverage}
                  onLoad={({ market: m, symbol: s, interval: iv, range: rg }) => {
                    setMarket(m); setSymbol(s); setIntervalId(iv); if (rg) setRange(rg);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                />
              )}

              <div className="rounded-xl border border-line lg-glass p-3">
                <p className="text-xs text-dim px-2 pt-1 pb-2">
                  Price with entries/exits — <span className="text-up">▲ Buy</span>{" "}
                  <span className="text-down">▼ Sell</span> ({result.symbol})
                </p>
                <CandleChart candles={result.candles} markers={tradeMarkers} height={300} showVolume={false} fitAll />
              </div>

              <div className="rounded-xl border border-line lg-glass p-3">
                <p className="text-xs text-dim px-2 pt-1 pb-2">
                  Equity curve — <span className="text-accent">Strategy</span> vs.{" "}
                  <span className="text-text/70">Buy &amp; Hold</span> ({result.symbol}, {result.candleCount} candles)
                </p>
                <EquityChart series={equitySeries} />
              </div>

              {result.trades.length >= 10 && (
                <ValidationPanel
                  mode={mode}
                  strategy={strategy}
                  code={code}
                  compile={compileStrategy}
                  candles={result.candles}
                  feeBps={feeBps}
                  positionPct={positionPct}
                  result={result}
                  onVerdicts={setVerdicts}
                />
              )}

              {result.trades.length >= 10 && (
                <div className="rounded-xl border border-line lg-glass p-4">
                  <p className="text-xs text-dim font-medium pb-3">
                    Monte Carlo — is this result skill or ordering luck?
                  </p>
                  <MonteCarloPanel
                    returns={result.trades.map((t) => t.pnlPct / 100)}
                    initialCapital={capital}
                    defaultSteps={result.trades.length}
                    defaultLimitPct={20}
                    note="Each path resamples this backtest's own trades in random order. If P(end ≤ start) isn't near zero, the edge may be luck; the 95th-percentile drawdown — not the single backtest's — is the number to size against (a 50K prop account's $2,000 limit = 4%)."
                  />
                </div>
              )}

              {result.trades.length > 0 && (
                <div className="rounded-xl border border-line lg-glass overflow-hidden">
                  <p className="text-xs text-dim px-4 pt-3 pb-1">Recent trades ({Math.min(result.trades.length, 50)} of {result.trades.length})</p>
                  <div className="overflow-x-auto max-h-80 overflow-y-auto">
                    <table className="w-full text-xs font-mono">
                      <thead>
                        <tr className="text-left text-dim border-b border-line sticky top-0 bg-surface">
                          <th className="px-4 py-2 font-medium">Side</th>
                          <th className="px-4 py-2 font-medium">Entry</th>
                          <th className="px-4 py-2 font-medium">Exit</th>
                          <th className="px-4 py-2 font-medium">Reason</th>
                          <th className="px-4 py-2 font-medium text-right">Bars</th>
                          <th className="px-4 py-2 font-medium text-right">PnL %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.trades.slice(-50).reverse().map((t, i) => (
                          <tr key={i} className="border-b border-line/40 last:border-0">
                            <td className={cn("px-4 py-1.5", t.side === "short" ? "text-down" : "text-up")}>
                              {t.side === "short" ? "Short" : "Long"}
                            </td>
                            <td className="px-4 py-1.5 text-dim">{new Date(t.entryTime * 1000).toLocaleDateString("de-CH")}</td>
                            <td className="px-4 py-1.5 text-dim">{new Date(t.exitTime * 1000).toLocaleDateString("de-CH")}</td>
                            <td className="px-4 py-1.5 text-dim">{t.reason || "signal"}</td>
                            <td className="px-4 py-1.5 text-right">{t.bars}</td>
                            <td className={cn("px-4 py-1.5 text-right", t.pnlPct >= 0 ? "text-up" : "text-down")}>
                              {fmtPct(t.pnlPct)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
