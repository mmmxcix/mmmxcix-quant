import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Loader2, ShieldCheck } from "lucide-react";
import { authClient } from "@/lib/authClient";

// Full-page sign-in. Two steps: credentials, then (only if the account has 2FA
// enabled) a TOTP code. Renders outside the app chrome.
export default function Login() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next") || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState("credentials"); // "credentials" | "totp"
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const { data, error } = await authClient.signIn.email({ email, password });
      if (error) { setErr(error.message || "Sign-in failed."); return; }
      if (data?.twoFactorRedirect) { setStep("totp"); return; } // 2FA account
      nav(next, { replace: true });
    } catch { setErr("Something went wrong. Try again."); }
    finally { setBusy(false); }
  };

  const verify = async (e) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const { error } = await authClient.twoFactor.verifyTotp({ code: code.trim() });
      if (error) { setErr(error.message || "Invalid code."); return; }
      nav(next, { replace: true });
    } catch { setErr("Something went wrong. Try again."); }
    finally { setBusy(false); }
  };

  return (
    <AuthShell title={step === "totp" ? "Two-factor code" : "Sign in"}>
      {step === "totp" ? (
        <form onSubmit={verify} className="space-y-3">
          <p className="flex items-center gap-1.5 text-xs text-dim">
            <ShieldCheck className="w-3.5 h-3.5" /> Enter the 6-digit code from your authenticator app.
          </p>
          <input
            autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="000000"
            className="input-base w-full text-center font-mono tracking-[0.4em] text-lg"
          />
          {err && <p className="text-xs text-down">{err}</p>}
          <button type="submit" disabled={busy || code.length < 6} className="btn-accent w-full justify-center flex items-center gap-2">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Verify
          </button>
          <button type="button" onClick={() => { setStep("credentials"); setCode(""); setErr(""); }} className="btn-ghost w-full justify-center">
            Back
          </button>
        </form>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-xs text-dim">Email
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)}
              className="input-base w-full mt-1" placeholder="you@example.com" />
          </label>
          <label className="block text-xs text-dim">Password
            <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="input-base w-full mt-1" placeholder="••••••••" />
          </label>
          {err && <p className="text-xs text-down">{err}</p>}
          <button type="submit" disabled={busy} className="btn-accent w-full justify-center flex items-center gap-2">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Sign in
          </button>
          <p className="text-xs text-dim text-center pt-1">
            No account? <Link to="/register" className="text-accent hover:underline">Create one</Link>
          </p>
        </form>
      )}
    </AuthShell>
  );
}

export function AuthShell({ title, children }) {
  return (
    <div className="min-h-screen grid place-items-center px-4">
      <div className="ambient-bg" aria-hidden="true" />
      <div className="w-full max-w-sm rounded-2xl border border-line lg-glass p-6 shadow-xl view-in">
        <div className="mb-5">
          <p className="text-[10px] tracking-[0.3em] text-dim uppercase">MMMXCIX</p>
          <p className="text-lg font-bold tracking-tight">Quant</p>
        </div>
        <h1 className="text-xl font-semibold mb-4">{title}</h1>
        {children}
        <p className="mt-5 text-[10px] text-dim/60 leading-relaxed">
          Not investment advice. Backtests are hypothetical — past performance guarantees nothing.
        </p>
      </div>
    </div>
  );
}
