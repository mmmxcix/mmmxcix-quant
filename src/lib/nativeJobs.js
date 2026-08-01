// nativeJobs.js — client for the native backtest queue (/api/backtest-jobs). The
// browser submits a strategy job, the executor-agent on the PC runs it in its real
// language (C++/q/native Python/JS) and pushes the result back; we poll for it.

export async function executorStatus() {
  try {
    const r = await fetch("/api/backtest-jobs?status=1");
    if (!r.ok) return null;
    return await r.json(); // { executor: { tools, host, at } | null, pending }
  } catch { return null; }
}

export async function submitNativeJob(spec) {
  const r = await fetch("/api/backtest-jobs", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ submit: spec }),
  });
  if (!r.ok) return null;
  return (await r.json()).id || null;
}

async function pollJob(id) {
  try {
    const r = await fetch(`/api/backtest-jobs?id=${encodeURIComponent(id)}`);
    if (!r.ok) return null;
    return (await r.json()).job || null;
  } catch { return null; }
}

/** Submit + wait for a native backtest. onStatus(status) fires on state changes. */
export async function runNative(spec, onStatus, timeoutMs = 150_000) {
  const id = await submitNativeJob(spec);
  if (!id) return { ok: false, error: "couldn't queue the job (are you signed in as dev?)" };
  onStatus?.("queued");
  const start = Date.now();
  let last = "queued";
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 1500));
    const job = await pollJob(id);
    if (!job) continue;
    if (job.status !== last) { last = job.status; onStatus?.(job.status); }
    if (job.status === "done" || job.status === "error") return job.result || { ok: false, error: "no result returned" };
  }
  return { ok: false, error: "timed out — is the executor running on your PC?" };
}

/** Is the executor's heartbeat fresh (seen in the last 3 minutes)? */
export function executorOnline(status) {
  const at = status?.executor?.at;
  return !!at && Date.now() - at < 180_000;
}
