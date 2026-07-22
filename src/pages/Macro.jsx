import { useEffect, useMemo, useState } from "react";
import { Landmark, CalendarDays, Database, Search, Download, AlertTriangle, TrendingDown } from "lucide-react";
import Skeleton from "@/components/Skeleton";
import { cn, fmtNum } from "@/lib/utils";
import {
  fetchYieldStats, fetchYields, yieldCurves,
  fetchCalendar, fetchCalendarStats,
  fetchL3List, l3DownloadUrl, fmtBytes,
} from "@/lib/macro";

// Macro hub — the LSE archive's non-price datasets: government bond yields,
// the historical economic-events archive, and the Level-3 order-book files.

const errBox = (msg) => (
  <p className="text-sm text-down flex items-start gap-1.5">
    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {msg}
  </p>
);

/* ── Yields ──────────────────────────────────────────────────────────── */

// Two yield curves (now vs 1y ago) over log-spaced maturities.
function CurveChart({ latest, yearAgo, height = 240 }) {
  const [hov, setHov] = useState(null);
  if (!latest) return null;
  const pts = latest.points;
  const all = [...pts, ...(yearAgo?.points || [])];
  const min = Math.min(...all.map((p) => p.close)), max = Math.max(...all.map((p) => p.close));
  const rng = max - min || 1;
  const lo = Math.log(pts[0].days), hi = Math.log(pts[pts.length - 1].days);
  const W = 600, H = height;
  const X = (d) => ((Math.log(d) - lo) / (hi - lo || 1)) * (W - 20) + 10;
  const Y = (v) => H - 22 - ((v - min) / rng) * (H - 44);
  const line = (arr) => arr.map((p) => `${X(p.days).toFixed(1)},${Y(p.close).toFixed(1)}`).join(" ");
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} onPointerLeave={() => setHov(null)}>
        {yearAgo && (
          <polyline points={line(yearAgo.points)} fill="none" stroke="var(--viz-blue)" strokeWidth="1.5"
            strokeDasharray="4 3" opacity="0.7" strokeLinejoin="round" />
        )}
        <polyline points={line(pts)} fill="none" stroke="var(--viz-amber)" strokeWidth="2" strokeLinejoin="round" />
        {pts.map((p, i) => (
          <g key={p.days} onPointerEnter={() => setHov(i)}>
            <circle cx={X(p.days)} cy={Y(p.close)} r="8" fill="transparent" />
            <circle cx={X(p.days)} cy={Y(p.close)} r={hov === i ? 4 : 2.5} fill="var(--viz-amber)" />
            <text x={X(p.days)} y={H - 6} textAnchor="middle" className="fill-current text-dim" fontSize="9">{p.tenor}</text>
          </g>
        ))}
      </svg>
      {hov != null && (
        <div className="absolute top-1 left-2 rounded-lg border border-line bg-bg/95 px-2.5 py-1.5 text-[11px] font-mono pointer-events-none">
          <span className="text-text font-semibold">{pts[hov].tenor}: {pts[hov].close.toFixed(3)}%</span>
          {yearAgo && (() => {
            const then = yearAgo.points.find((p) => p.days === pts[hov].days);
            return then ? <span className="text-dim ml-2">1y ago {then.close.toFixed(3)}%</span> : null;
          })()}
        </div>
      )}
    </div>
  );
}

// One tenor's history as a simple line.
function HistoryChart({ rows, tenorDays, height = 200 }) {
  const series = useMemo(() => rows.filter((r) => r.days === tenorDays), [rows, tenorDays]);
  const [hov, setHov] = useState(null);
  if (series.length < 2) return null;
  const vals = series.map((p) => p.close);
  const min = Math.min(...vals), max = Math.max(...vals), rng = max - min || 1;
  const W = 600, H = height;
  const X = (i) => (i / (series.length - 1)) * W;
  const Y = (v) => H - 4 - ((v - min) / rng) * (H - 14);
  const line = series.map((p, i) => `${X(i).toFixed(1)},${Y(p.close).toFixed(1)}`).join(" ");
  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    setHov(Math.round(frac * (series.length - 1)));
  };
  const hx = hov != null ? (hov / (series.length - 1)) * 100 : 0;
  return (
    <div className="relative" onPointerMove={onMove} onPointerLeave={() => setHov(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full block" style={{ height }} aria-hidden="true">
        <polyline points={line} fill="none" stroke="var(--viz-teal)" strokeWidth="1.8"
          vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      {hov != null && (
        <>
          <div className="absolute top-0 bottom-0 w-px bg-text/20 pointer-events-none" style={{ left: `${hx}%` }} />
          <div className="absolute top-1 pointer-events-none rounded-lg border border-line bg-bg/95 px-2.5 py-1.5 text-[11px] font-mono whitespace-nowrap"
            style={{ left: `${hx}%`, transform: hx > 55 ? "translateX(calc(-100% - 10px))" : "translateX(10px)" }}>
            <span className="text-text font-semibold">{series[hov].close.toFixed(3)}%</span>
            <span className="text-dim ml-2">{series[hov].date}</span>
          </div>
        </>
      )}
    </div>
  );
}

export function Yields() {
  const [stats, setStats] = useState(undefined);
  const [country, setCountry] = useState("US");
  const [rows, setRows] = useState(undefined);
  const [error, setError] = useState(null);
  const [histTenor, setHistTenor] = useState(3650); // 10Y default

  useEffect(() => {
    fetchYieldStats().then(setStats).catch((e) => { setStats(null); setError(e.message); });
  }, []);

  useEffect(() => {
    let alive = true;
    setRows(undefined);
    setError(null);
    fetchYields(country).then((r) => { if (alive) setRows(r); })
      .catch((e) => { if (alive) { setRows(null); setError(e.message); } });
    return () => { alive = false; };
  }, [country]);

  const curves = useMemo(() => (rows?.length ? yieldCurves(rows) : null), [rows]);
  const tenors = useMemo(() => {
    if (!rows?.length) return [];
    const seen = new Map();
    for (const r of rows) seen.set(r.days, r.tenor);
    return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([days, tenor]) => ({ days, tenor }));
  }, [rows]);
  useEffect(() => {
    if (tenors.length && !tenors.some((t) => t.days === histTenor)) setHistTenor(tenors[tenors.length - 1].days);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenors]);

  // Classic recession dashboard number: the 10Y−2Y spread.
  const spread = useMemo(() => {
    if (!curves?.latest) return null;
    const p10 = curves.latest.points.find((p) => p.tenor === "10Y");
    const p2 = curves.latest.points.find((p) => p.tenor === "2Y");
    return p10 && p2 ? p10.close - p2.close : null;
  }, [curves]);

  const countryList = (stats?.countries || []).slice(0, 14);

  return (
    <div className="space-y-4">
      {stats === undefined ? <Skeleton className="h-8 w-full max-w-lg rounded-lg" /> : stats === null ? errBox(error) : (
        <div className="flex flex-wrap gap-1">
          {countryList.map((c) => (
            <button key={c.code} onClick={() => setCountry(c.code)} title={`${c.name} · from ${c.firstDate}`}
              className={cn("chip font-mono", country === c.code ? "chip-active" : "chip-idle")}>
              {c.code}
            </button>
          ))}
        </div>
      )}

      {rows === undefined ? <Skeleton className="h-64 w-full rounded-xl" /> : rows === null ? null : !curves?.latest ? (
        <p className="text-sm text-dim">Not enough curve data for {country}.</p>
      ) : (
        <>
          <div className="rounded-xl border border-line lg-glass p-4">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2">
              <p className="text-sm font-semibold">Yield curve — {country}</p>
              <p className="text-[11px] text-dim font-mono">as of {curves.lastDate}</p>
              {spread != null && (
                <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-mono font-semibold",
                  spread < 0 ? "bg-down/10 text-down" : "bg-up/10 text-up")}>
                  {spread < 0 && <TrendingDown className="w-3 h-3" />}
                  10Y−2Y {spread >= 0 ? "+" : ""}{spread.toFixed(2)}pp{spread < 0 ? " · inverted" : ""}
                </span>
              )}
            </div>
            <CurveChart latest={curves.latest} yearAgo={curves.yearAgo} />
            <p className="text-[11px] text-dim mt-1">
              <span style={{ color: "var(--viz-amber)" }}>■</span> today ·{" "}
              <span style={{ color: "var(--viz-blue)" }}>■</span> one year ago (dashed) · log-spaced maturities ·
              an inverted curve (short {">"} long) has preceded most US recessions.
            </p>
          </div>

          <div className="rounded-xl border border-line lg-glass p-4">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <p className="text-sm font-semibold">History</p>
              <div className="flex flex-wrap gap-1 ml-auto">
                {tenors.map((t) => (
                  <button key={t.days} onClick={() => setHistTenor(t.days)}
                    className={cn("chip !text-[10px] !py-0.5 font-mono", histTenor === t.days ? "chip-active" : "chip-idle")}>
                    {t.tenor}
                  </button>
                ))}
              </div>
            </div>
            <HistoryChart rows={rows} tenorDays={histTenor} />
          </div>
        </>
      )}
      <p className="text-xs text-dim">
        Daily closing yields in percent, {stats ? `${stats.countries.length} countries` : "…"} — London Strategic Edge archive.
      </p>
    </div>
  );
}

/* ── Economic events archive ─────────────────────────────────────────── */

const IMPACT_TONE = { High: "bg-down/10 text-down", Medium: "bg-accent/10 text-accent", Low: "bg-line/50 text-dim" };

export function EconCalendar() {
  const [stats, setStats] = useState(undefined);
  const [impact, setImpact] = useState("High");
  const [country, setCountry] = useState("US");
  const [events, setEvents] = useState(undefined);
  const [error, setError] = useState(null);

  useEffect(() => { fetchCalendarStats().then(setStats).catch(() => setStats(null)); }, []);

  // Latest available window: the archive is historical (ends where LSE's feed
  // stops) — show the most recent 60 days it actually has.
  useEffect(() => {
    if (!stats) return;
    let alive = true;
    setEvents(undefined);
    setError(null);
    const end = (stats.latest || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
    const start = new Date(Date.parse(end) - 60 * 86400_000).toISOString().slice(0, 10);
    fetchCalendar({ impact: impact || undefined, country: country || undefined, startDate: start, endDate: end })
      .then((r) => { if (alive) setEvents(r.reverse()); }) // newest first
      .catch((e) => { if (alive) { setEvents(null); setError(e.message); } });
    return () => { alive = false; };
  }, [stats, impact, country]);

  const commonCountries = ["US", "EU", "DE", "GB", "JP", "CH", "CN", "CA", "AU"];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {["High", "Medium", ""].map((i) => (
            <button key={i || "all"} onClick={() => setImpact(i)}
              className={cn("chip", impact === i ? "chip-active" : "chip-idle")}>
              {i || "All impacts"}
            </button>
          ))}
        </div>
        <span className="w-px h-4 bg-line" />
        <div className="flex flex-wrap gap-1">
          {commonCountries.map((c) => (
            <button key={c} onClick={() => setCountry(c)}
              className={cn("chip font-mono", country === c ? "chip-active" : "chip-idle")}>
              {c}
            </button>
          ))}
          <button onClick={() => setCountry("")}
            className={cn("chip", country === "" ? "chip-active" : "chip-idle")}>All</button>
        </div>
      </div>

      {stats && (
        <p className="text-xs text-dim">
          Historical archive: {fmtNum(stats.totalEvents, 0)} events since {String(stats.earliest).slice(0, 10)},
          last update <span className="font-mono">{String(stats.latest).slice(0, 10)}</span> — research data
          (estimate vs. actual), not a forward-looking calendar.
        </p>
      )}

      {events === undefined ? <Skeleton className="h-64 w-full rounded-xl" /> : events === null ? errBox(error) : events.length === 0 ? (
        <p className="text-sm text-dim">No events for this filter in the latest 60 archived days.</p>
      ) : (
        <div className="rounded-xl border border-line lg-glass overflow-hidden">
          <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-surface">
                <tr className="text-left text-dim text-[10px] uppercase tracking-wide border-b border-line">
                  <th className="px-4 py-2.5 font-medium">Date</th>
                  <th className="px-4 py-2.5 font-medium">Event</th>
                  <th className="px-4 py-2.5 font-medium text-right">Estimate</th>
                  <th className="px-4 py-2.5 font-medium text-right">Actual</th>
                  <th className="px-4 py-2.5 font-medium text-right hidden sm:table-cell">Previous</th>
                  <th className="px-4 py-2.5 font-medium text-right">Impact</th>
                </tr>
              </thead>
              <tbody>
                {events.slice(0, 400).map((e, i) => {
                  const surprise = e.actual != null && e.estimate != null ? e.actual - e.estimate : null;
                  return (
                    <tr key={i} className="border-b border-line/40 last:border-0 hover:bg-bg/40">
                      <td className="px-4 py-2 font-mono text-xs text-dim whitespace-nowrap">{String(e.date).slice(0, 16).replace("T", " ")}</td>
                      <td className="px-4 py-2">
                        <span className="font-mono text-xs text-dim mr-2">{e.country}</span>{e.event}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs">{e.estimate != null ? `${e.estimate}${e.unit}` : "–"}</td>
                      <td className={cn("px-4 py-2 text-right font-mono text-xs font-semibold",
                        surprise == null ? "" : surprise > 0 ? "text-up" : surprise < 0 ? "text-down" : "")}>
                        {e.actual != null ? `${e.actual}${e.unit}` : "–"}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-xs text-dim hidden sm:table-cell">{e.previous != null ? `${e.previous}${e.unit}` : "–"}</td>
                      <td className="px-4 py-2 text-right">
                        <span className={cn("text-[10px] rounded-full px-2 py-0.5 font-semibold", IMPACT_TONE[e.impact] || "bg-line/50 text-dim")}>
                          {e.impact}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── L3 order-book archive ───────────────────────────────────────────── */

export function L3Archive() {
  const [list, setList] = useState(undefined);
  const [error, setError] = useState(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(null); // instrument name

  useEffect(() => {
    fetchL3List().then(setList).catch((e) => { setList(null); setError(e.message); });
  }, []);

  const filtered = useMemo(() => {
    if (!list) return [];
    const s = q.trim().toLowerCase();
    const items = s ? list.instruments.filter((i) => i.displayName.toLowerCase().includes(s) || i.name.includes(s)) : list.instruments;
    return [...items].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [list, q]);

  return (
    <div className="space-y-4">
      {list === undefined ? <Skeleton className="h-40 w-full rounded-xl" /> : list === null ? errBox(error) : (
        <>
          <p className="text-xs text-dim leading-relaxed">
            Raw <span className="text-text font-semibold">Level-3 order-book event files</span> — every order
            add/modify/cancel/execute, one gzipped CSV per instrument per trading day.{" "}
            {list.totalInstruments} instruments · {fmtNum(list.totalFiles, 0)} files · {fmtBytes(list.totalSize)} total.
            This is microstructure research material for external tools (Python/pandas) — not chartable in the browser.
          </p>
          <div className="relative max-w-xs">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter instruments…"
              className="input-base w-full !pl-8 text-sm" />
          </div>
          <div className="rounded-xl border border-line lg-glass overflow-hidden divide-y divide-line/40">
            {filtered.map((inst) => (
              <div key={inst.name}>
                <button onClick={() => setOpen(open === inst.name ? null : inst.name)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-bg/40 transition-colors">
                  <Database className="w-3.5 h-3.5 text-accent shrink-0" />
                  <span className="text-sm font-semibold">{inst.displayName}</span>
                  <span className="text-[11px] text-dim font-mono ml-auto whitespace-nowrap">
                    {inst.fileCount} days · {fmtBytes(inst.totalSize)} · {inst.from} → {inst.to}
                  </span>
                </button>
                {open === inst.name && (
                  <div className="px-4 pb-3 grid sm:grid-cols-2 lg:grid-cols-3 gap-1 bg-bg/20">
                    {inst.files.map((f) => (
                      <a key={f} href={l3DownloadUrl(inst.name, f)} download
                        className="flex items-center gap-1.5 text-[11px] font-mono text-dim hover:text-accent py-0.5">
                        <Download className="w-3 h-3 shrink-0" /> {f}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {filtered.length === 0 && <p className="px-4 py-6 text-sm text-dim">No instrument matches.</p>}
          </div>
        </>
      )}
    </div>
  );
}
