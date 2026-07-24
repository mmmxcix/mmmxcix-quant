import { useEffect, useMemo, useState } from "react";
import { ShieldCheck, ShieldAlert, Loader2, Play, FlaskConical, Waves, SigmaSquare } from "lucide-react";
import { walkForwardBuilder, kFoldCode, noiseTest, deflatedSharpe, equityReturns } from "@/lib/validation";
import { cn, fmtNum, fmtPct } from "@/lib/utils";

// The anti-overfitting pipeline, applied to the CURRENT backtest setup:
//   1. Walk-forward (builder) / k-fold consistency (code)
//   2. Deflated Sharpe Ratio — corrects for how many variants were tried
//   3. Price-noise robustness — does the edge survive perturbed data?
// Every check reports an explicit pass/fail verdict with its reasoning.

function Verdict({ v }) {
  if (v === "pass") {
    return <span className="inline-flex items-center gap-1 rounded-full border border-up/40 bg-up/10 px-2 py-0.5 text-[10px] font-semibold text-up uppercase">✓ pass</span>;
  }
  return <span className="inline-flex items-center gap-1 rounded-full border border-down/40 bg-down/10 px-2 py-0.5 text-[10px] font-semibold text-down uppercase">✗ fail</span>;
}

function Card({ icon: Icon, title, children }) {
  return (
    <div className="rounded-lg border border-line bg-bg/30 p-3">
      <p className="flex items-center gap-1.5 text-[10px] text-dim font-medium mb-2">
        <Icon className="w-3.5 h-3.5 text-accent" /> {title}
      </p>
      {children}
    </div>
  );
}

export default function ValidationPanel({ mode, strategy, code, compile, candles, feeBps, positionPct, result, onVerdicts }) {
  const [wf, setWf] = useState(null);
  const [wfBusy, setWfBusy] = useState(false);
  const [noise, setNoise] = useState(null);
  const [noiseBusy, setNoiseBusy] = useState(false);
  const [trials, setTrials] = useState(10);

  const dsr = useMemo(() => {
    if (!result?.equity?.length) return null;
    return deflatedSharpe(equityReturns(result.equity), trials);
  }, [result, trials]);

  // Report the three verdicts upward so "Save to registry" can capture them.
  useEffect(() => {
    if (!onVerdicts) return;
    onVerdicts({
      wf: wf && !wf.error ? wf.verdict : null,
      dsr: dsr ? (dsr.dsr >= 0.95 ? "pass" : "fail") : null,
      noise: noise && !noise.error ? noise.verdict : null,
    });
  }, [wf, dsr, noise, onVerdicts]);

  const runWf = () => {
    setWfBusy(true);
    setWf(null);
    setTimeout(() => { // let the spinner paint before the sync crunch
      try {
        const out = mode === "builder"
          ? walkForwardBuilder({ candles, strategy, feeBps, positionPct })
          : kFoldCode({ candles, makeSignalFn: () => compile(code), feeBps, positionPct });
        setWf(out || { error: "Not enough data (needs ≥ 120 candles per fold — load a longer range)." });
      } catch (e) {
        setWf({ error: e.message });
      } finally {
        setWfBusy(false);
      }
    }, 30);
  };

  const runNoise = () => {
    setNoiseBusy(true);
    setNoise(null);
    setTimeout(() => {
      try {
        const makeSignalFn = mode === "builder"
          ? () => strategy.build(Object.fromEntries(strategy.params.map((p) => [p.key, p.default])))
          : () => compile(code);
        setNoise(noiseTest({ candles, makeSignalFn, feeBps, positionPct }) || { error: "Not enough data." });
      } catch (e) {
        setNoise({ error: e.message });
      } finally {
        setNoiseBusy(false);
      }
    }, 30);
  };

  return (
    <div className="rounded-xl border border-line lg-glass p-4">
      <p className="text-xs text-dim font-medium pb-3">
        Validation pipeline — the tests a strategy must survive before you trust it
      </p>
      <div className="grid lg:grid-cols-3 gap-3">
        {/* 1 — walk-forward / k-fold */}
        <Card icon={FlaskConical} title={mode === "builder" ? "Walk-forward analysis" : "K-fold consistency"}>
          {!wf && (
            <>
              <p className="text-[11px] text-dim leading-relaxed mb-2">
                {mode === "builder"
                  ? "Optimizes the parameters on each window, then tests them frozen on the NEXT window. Only the out-of-sample segments count."
                  : "Runs the code independently on 5 sequential windows — a real edge shouldn't live off one lucky stretch."}
              </p>
              <button onClick={runWf} disabled={wfBusy} className="btn-accent flex items-center gap-1.5 !py-1.5 text-xs">
                {wfBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                {wfBusy ? "Crunching…" : "Run"}
              </button>
            </>
          )}
          {wf?.error && <p className="text-xs text-down">{wf.error}</p>}
          {wf && !wf.error && (
            <div className="text-xs font-mono space-y-1">
              <div className="flex justify-between items-center">
                <span className="text-dim font-sans">Verdict</span><Verdict v={wf.verdict} />
              </div>
              {"oosReturnPct" in wf && (
                <>
                  <div className="flex justify-between"><span className="text-dim">OOS return (stitched)</span>
                    <span className={wf.oosReturnPct >= 0 ? "text-up" : "text-down"}>{fmtPct(wf.oosReturnPct)}</span></div>
                  <div className="flex justify-between"><span className="text-dim">OOS profit factor</span><span>{fmtNum(wf.oosProfitFactor, 2)}</span></div>
                  <div className="flex justify-between"><span className="text-dim">Combos tested/fold</span><span>{wf.testedCombos}</span></div>
                </>
              )}
              <div className="flex justify-between"><span className="text-dim">Profitable folds</span>
                <span>{wf.profitableFolds}/{wf.totalFolds}</span></div>
              <div className="pt-1 space-y-0.5">
                {wf.folds.map((f) => (
                  <div key={f.fold} className="flex justify-between text-[11px]">
                    <span className="text-dim">fold {f.fold}{f.params ? ` ${Object.values(f.params).join("/")}` : ""}</span>
                    <span className={(f.oosReturnPct ?? f.returnPct) >= 0 ? "text-up" : "text-down"}>
                      {fmtPct(f.oosReturnPct ?? f.returnPct)}
                    </span>
                  </div>
                ))}
              </div>
              {"oosReturnPct" in wf && (
                <p className="text-[10px] text-dim/80 font-sans leading-relaxed pt-1">
                  Unstable fold parameters = the optimizer chases noise; similar parameters across folds = a real plateau.
                </p>
              )}
            </div>
          )}
        </Card>

        {/* 2 — deflated sharpe */}
        <Card icon={SigmaSquare} title="Deflated Sharpe Ratio">
          <p className="text-[11px] text-dim leading-relaxed mb-2">
            Probability the Sharpe is real and not data-mining luck — the more variants you tried, the higher the bar (López de Prado).
          </p>
          <label className="text-[11px] text-dim block mb-2">
            Variants tried (be honest — every tweak counts)
            <input type="number" min={1} max={10000} value={trials}
              onChange={(e) => setTrials(Math.max(1, +e.target.value || 1))}
              className="input-base w-full mt-1 font-mono text-xs" />
          </label>
          {dsr ? (
            <div className="text-xs font-mono space-y-1">
              <div className="flex justify-between items-center">
                <span className="text-dim font-sans">Verdict</span>
                <Verdict v={dsr.dsr >= 0.95 ? "pass" : "fail"} />
              </div>
              <div className="flex justify-between"><span className="text-dim">P(edge is real)</span>
                <span className={dsr.dsr >= 0.95 ? "text-up" : dsr.dsr >= 0.9 ? "text-warn" : "text-down"}>
                  {(dsr.dsr * 100).toFixed(1)}%
                </span></div>
              <div className="flex justify-between"><span className="text-dim">Skew / excess kurt</span>
                <span>{fmtNum(dsr.skew, 2)} / {fmtNum(dsr.kurt - 3, 2)}</span></div>
              <p className="text-[10px] text-dim/80 font-sans leading-relaxed pt-1">
                ≥ 95% = the Sharpe survives the multiple-testing correction. Below that, assume you found noise.
              </p>
            </div>
          ) : (
            <p className="text-xs text-dim">Run a backtest first (needs ≥ 30 bars of equity).</p>
          )}
        </Card>

        {/* 3 — noise robustness */}
        <Card icon={Waves} title="Price-noise robustness">
          {!noise && (
            <>
              <p className="text-[11px] text-dim leading-relaxed mb-2">
                Re-runs the strategy on 25 copies of the data with every bar shifted by small random noise (¼ of a bar's range). Curve-fits shatter; real edges bend.
              </p>
              <button onClick={runNoise} disabled={noiseBusy} className="btn-accent flex items-center gap-1.5 !py-1.5 text-xs">
                {noiseBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                {noiseBusy ? "Running 25 sims…" : "Run"}
              </button>
            </>
          )}
          {noise?.error && <p className="text-xs text-down">{noise.error}</p>}
          {noise && !noise.error && (
            <div className="text-xs font-mono space-y-1">
              <div className="flex justify-between items-center">
                <span className="text-dim font-sans">Verdict</span><Verdict v={noise.verdict} />
              </div>
              <div className="flex justify-between"><span className="text-dim">Base return</span>
                <span className={noise.baseReturnPct >= 0 ? "text-up" : "text-down"}>{fmtPct(noise.baseReturnPct)}</span></div>
              <div className="flex justify-between"><span className="text-dim">Median (noisy)</span>
                <span className={noise.medianReturnPct >= 0 ? "text-up" : "text-down"}>{fmtPct(noise.medianReturnPct)}</span></div>
              <div className="flex justify-between"><span className="text-dim">10th–90th pct</span>
                <span>{fmtPct(noise.p10ReturnPct)} … {fmtPct(noise.p90ReturnPct)}</span></div>
              <div className="flex justify-between"><span className="text-dim">Profitable share</span>
                <span className={noise.profitableShare >= 0.6 ? "text-up" : "text-down"}>{Math.round(noise.profitableShare * 100)}%</span></div>
            </div>
          )}
        </Card>
      </div>
      <p className="flex items-start gap-1.5 text-[10px] text-dim/80 mt-3 leading-relaxed">
        <ShieldCheck className="w-3.5 h-3.5 shrink-0 text-dim" />
        Passing all three raises confidence — it never guarantees live profits. Failing any one of them is a real warning: shrink size, simplify, or bury the idea in the graveyard.
      </p>
    </div>
  );
}
