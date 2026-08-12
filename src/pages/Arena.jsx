import { useEffect, useState } from "react";
import { Swords, Activity, TrendingDown, Info, CircleDot } from "lucide-react";
import { cn } from "@/lib/utils";
import { ARENA_RULES } from "@/lib/arena";
import FleetSwitch from "@/components/FleetSwitch";

// The arena: live paper trading for strategies that CANNOT be backtested.
// See src/lib/arena.js for why (no historical order-book depth) and
// scripts/arena-agent.mjs for what actually runs.

const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");
const ago = (t) => {
  if (!t) return "—";
  const s = (Date.now() - t) / 1000;
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

const STATUS = {
  learning: { label: "Gathering evidence", cls: "bg-warn/15 text-warn", Icon: CircleDot },
  active: { label: "Trading", cls: "bg-up/15 text-up", Icon: Activity },
  evicted: { label: "Removed", cls: "bg-down/15 text-down", Icon: TrendingDown },
};

function Entrant({ e }) {
  const st = e.verdict?.stats;
  const s = STATUS[e.status] || STATUS.learning;
  const open = (e.ledger || []).filter((t) => t.state === "open").length;
  return (
    <div className={cn("rounded-xl border p-4", e.status === "evicted" ? "border-line opacity-70" : "border-line lg-glass")}>
      <div className="flex items-start gap-2 flex-wrap">
        <h3 className="font-semibold">{e.label || e.id}</h3>
        <span className={cn("text-[11px] rounded-full px-2 py-0.5 font-medium inline-flex items-center gap-1", s.cls)}>
          <s.Icon className="w-3 h-3" aria-hidden="true" />{s.label}
        </span>
        {open > 0 && <span className="text-[11px] text-dim">· {open} open</span>}
      </div>
      {e.description && <p className="text-sm text-dim mt-1">{e.description}</p>}

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
        {[
          ["Trades", st?.n ?? 0, 0],
          ["Avg R", st?.avgR, 2],
          ["t-stat", st?.tStat, 2],
          ["Max DD", st?.maxDrawdownPct, 1],
        ].map(([k, v, d]) => (
          <div key={k}>
            <dt className="text-[11px] uppercase tracking-wide text-dim">{k}</dt>
            <dd className="font-mono text-sm">{k === "Max DD" ? `${fmt(v, d)}%` : fmt(v, d)}</dd>
          </div>
        ))}
      </dl>

      {e.verdict?.reason && (
        <p className={cn("text-xs mt-3", e.status === "evicted" ? "text-down" : "text-dim")}>
          {e.status === "evicted" ? "Removed: " : ""}{e.verdict.reason}
        </p>
      )}
    </div>
  );
}

function Scoreboard({ scores }) {
  if (!scores?.length) return null;
  return (
    <div className="rounded-xl border border-line lg-glass p-5 mb-5">
      <h2 className="font-semibold mb-1">Does the estimator predict?</h2>
      <p className="text-sm text-dim mb-3">
        The evidence that does not depend on anyone's fee tier: out of sample, how far each
        estimate sits from where the mid price actually was five seconds later. Lower is better;
        the figures are in ticks.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Forecast error by estimator, in ticks</caption>
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-dim">
              <th scope="col" className="font-medium py-1 pr-4">Market</th>
              <th scope="col" className="font-medium py-1 pr-4">Samples</th>
              <th scope="col" className="font-medium py-1 pr-4">Mid</th>
              <th scope="col" className="font-medium py-1 pr-4">Weighted mid</th>
              <th scope="col" className="font-medium py-1">Micro-price</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {scores.map((s) => {
              const best = Math.min(...[s.midTicks, s.weightedTicks, s.microTicks].filter(Number.isFinite));
              const cell = (v) => (
                <td className={cn("py-1 pr-4", v === best && "text-up font-semibold")}>{fmt(v, 3)}</td>
              );
              return (
                <tr key={s.symbol} className="border-t border-line">
                  <th scope="row" className="py-1 pr-4 font-sans font-medium text-left">{s.symbol}</th>
                  <td className="py-1 pr-4">{s.n}</td>
                  {cell(s.midTicks)}
                  {cell(s.weightedTicks)}
                  <td className={cn("py-1", s.microTicks === best && "text-up font-semibold")}>
                    {s.microTicks == null ? <span className="text-dim">fitting…</span> : fmt(s.microTicks, 3)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Kronos runs on a fixed paper budget and writes down every decision, the same
// way Argus does. Forecast error alone cannot answer "is this useful": a model
// can beat a random walk on average and still lose money, because being closer
// on the quiet days does not pay for being wrong on the violent ones. The
// account is what makes that visible.
function Account({ acct }) {
  if (!acct) return null;
  const up = acct.returnPct >= 0;
  const since = acct.startedAt ? new Date(acct.startedAt * 1000).toLocaleDateString() : null;
  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-3">
        <span className="font-mono text-2xl font-semibold">{fmt(acct.equity, 2)}</span>
        <span className="text-sm text-dim">of {fmt(acct.budget, 0)} USDT paper</span>
        <span className={cn("font-mono text-sm font-semibold", up ? "text-up" : "text-down")}>
          {up ? "+" : ""}{fmt(acct.returnPct, 2)}%
        </span>
        {since && <span className="text-xs text-dim">since {since}</span>}
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-3">
        {[
          ["Trades", fmt(acct.n, 0)],
          ["Win rate", `${fmt(acct.winRate, 0)}%`],
          ["Avg R", fmt(acct.avgR, 2)],
          ["t-stat", fmt(acct.tStat, 2)],
          ["Max DD", `${fmt(acct.maxDrawdownPct, 1)}%`],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-[11px] uppercase tracking-wide text-dim">{k}</dt>
            <dd className="font-mono text-sm">{v}</dd>
          </div>
        ))}
      </dl>

      {acct.open?.length > 0 && (
        <div className="rounded-lg border border-line bg-surface/40 p-3 mb-3">
          <p className="text-[11px] uppercase tracking-wide text-dim mb-1.5">Open right now</p>
          <ul className="space-y-1">
            {acct.open.map((t, i) => (
              <li key={i} className="text-sm font-mono flex flex-wrap gap-x-3">
                <span className="font-sans font-medium">{t.symbol}</span>
                <span className={t.side === "long" ? "text-up" : "text-down"}>{t.side}</span>
                <span>{fmt(t.stake, 0)} USDT @ {fmt(t.entry, 2)}</span>
                <span className="text-dim">stop {fmt(t.stop, 2)} · target {fmt(t.target, 2)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {acct.journal?.length > 0 && (
        <details className="rounded-lg border border-line bg-surface/40 p-3">
          <summary className="cursor-pointer text-[11px] uppercase tracking-wide text-dim">
            Decision log ({acct.journal.length})
          </summary>
          <p className="text-xs text-dim mt-2 mb-2">
            Every decision, including the ones not to trade — those are what a track record
            normally loses.
          </p>
          <ol className="space-y-1.5 max-h-72 overflow-y-auto">
            {[...acct.journal].reverse().map((j, i) => (
              <li key={i} className="text-xs border-l-2 border-line pl-2">
                <span className="font-mono text-dim">
                  {new Date(j.at * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>{" "}
                <span className="font-medium">{j.symbol}</span>{" "}
                <span className={cn(
                  j.action?.startsWith("open") ? "text-accent"
                    : j.action === "no trade" ? "text-dim" : "text-fg"
                )}>{j.action}</span>
                <span className="text-dim"> — {j.detail}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

// Kronos is a foundation model for candlestick sequences, run on the PC by
// scripts/kronos/forecast.py. It belongs on this page for the same reason the
// order-book strategies do: it is a claim under test, and what is shown is how
// it SCORED, not how confident its forecast looks.
function Kronos({ data }) {
  const rows = data?.scoreboard || [];
  const latest = data?.forecasts || [];
  return (
    <div className="rounded-xl border border-line lg-glass p-5 mb-5">
      <h2 className="font-semibold mb-1">Kronos, against a random walk</h2>
      <p className="text-sm text-dim mb-3">
        A pretrained candlestick model forecasting 24 hours ahead. The only number that matters
        is whether it beats repeating the last close — a baseline most price models quietly
        fail. Skill is the share of the naive error it removes; negative means it did worse
        than doing nothing.
      </p>
      <Account acct={data?.account} />

      {!rows.length ? (
        <p className="text-sm text-dim" role="status">
          {latest.length
            ? "Forecasts are out; none has reached its horizon yet, so there is nothing to report."
            : "No forecasts yet — the service has not reported."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Kronos forecast skill against a random walk</caption>
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-dim">
                <th scope="col" className="font-medium py-1 pr-4">Market</th>
                <th scope="col" className="font-medium py-1 pr-4">Graded</th>
                <th scope="col" className="font-medium py-1 pr-4">Beat naive</th>
                <th scope="col" className="font-medium py-1 pr-4">Avg skill</th>
                <th scope="col" className="font-medium py-1">Direction</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {rows.map((r) => (
                <tr key={r.symbol} className="border-t border-line">
                  <th scope="row" className="py-1 pr-4 font-sans font-medium text-left">{r.symbol}</th>
                  <td className="py-1 pr-4">{r.n}</td>
                  <td className="py-1 pr-4">{fmt(r.beatNaivePct, 0)}%</td>
                  <td className={cn("py-1 pr-4", r.avgSkillPct > 0 ? "text-up" : "text-down")}>
                    {r.avgSkillPct > 0 ? "+" : ""}{fmt(r.avgSkillPct, 1)}%
                  </td>
                  <td className="py-1">{fmt(r.directionPct, 0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data?.scoredCount > 0 && rows.every((r) => r.n < 20) && (
            <p className="text-xs text-dim mt-3">
              Fewer than 20 graded forecasts per market — far too few to conclude anything either
              way. Shown because hiding a result until it looks good is how track records lie.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function Arena() {
  const [data, setData] = useState(null);
  const [kronos, setKronos] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [a, k] = await Promise.all([
          fetch("/api/arena").then((r) => r.json()).catch(() => null),
          fetch("/api/kronos").then((r) => r.json()).catch(() => null),
        ]);
        if (!alive) return;
        setData(a);
        setKronos(k);
        setErr(a?.ok ? null : (a?.error || "unavailable"));
      } catch { if (alive) setErr("offline"); }
    };
    load();
    const t = setInterval(load, 20000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const entries = data?.entries || [];
  const live = entries.filter((e) => e.status !== "evicted");
  const gone = entries.filter((e) => e.status === "evicted");

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      <div className="flex items-center gap-2 mb-1">
        <Swords className="w-5 h-5 text-accent" aria-hidden="true" />
        <h1 className="text-xl font-bold">Arena</h1>
        {/* Renders only for the dev account; see FleetSwitch. */}
        <div className="ml-auto"><FleetSwitch /></div>
      </div>
      <p className="text-sm text-dim mb-5 max-w-2xl">
        Live paper trading for strategies that cannot be backtested. The micro-price reads the
        order book, and we have no historical book depth — so backtesting it would mean inventing
        the very data the signal reads. These trade against the real Binance book instead, and are
        judged only on trades that actually happened.
      </p>

      <div className="rounded-xl border border-line bg-surface/40 p-4 mb-5 flex gap-3">
        <Info className="w-4 h-4 text-dim shrink-0 mt-0.5" aria-hidden="true" />
        <div className="text-sm text-dim space-y-2">
          <p>
            <span className="text-fg font-medium">Nothing here is a return you could have earned.</span>{" "}
            Fills assume our resting quote is at the front of the queue, which is optimistic, and
            the ledger charges a maker fee that only a high-volume account gets. That is why the
            table above — pure forecast error — is the primary evidence and the profit figures are
            not.
          </p>
          <p>
            A strategy is removed once its mean result is negative with statistical confidence
            (t ≤ {ARENA_RULES.evictTStat} after at least {ARENA_RULES.minTrades} trades), if it draws
            down more than {ARENA_RULES.maxDrawdownPct}%, or if it stops trading for{" "}
            {ARENA_RULES.staleDays} days. Removal is permanent.
          </p>
        </div>
      </div>

      <Scoreboard scores={data?.scores} />

      <Kronos data={kronos} />

      {err && (
        <p className="text-sm text-down mb-4" role="status">
          The arena is not reporting right now ({err}). The agent may be offline.
        </p>
      )}

      {!err && !entries.length && (
        <p className="text-sm text-dim" role="status">
          No entrants yet — the agent has not reported. It needs about 25 minutes of live book data
          before the micro-price model can be fitted at all.
        </p>
      )}

      <div className="grid gap-3">
        {live.map((e) => <Entrant key={e.id} e={e} />)}
      </div>

      {gone.length > 0 && (
        <>
          <h2 className="font-semibold mt-8 mb-2">Removed</h2>
          <p className="text-sm text-dim mb-3">
            Kept on the page on purpose. A list of only the survivors is how a track record lies.
          </p>
          <div className="grid gap-3">{gone.map((e) => <Entrant key={e.id} e={e} />)}</div>
        </>
      )}

      {data?.updatedAt > 0 && (
        <p className="text-xs text-dim mt-6">Last report {ago(data.updatedAt)}.</p>
      )}
    </div>
  );
}
