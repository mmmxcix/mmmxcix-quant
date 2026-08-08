import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ShieldCheck, ShieldOff, Loader2, Copy, Check, LogOut, KeyRound, Sun, Moon, Monitor, Palette } from "lucide-react";
import QRCode from "qrcode";
import { authClient, useSession, signOut } from "@/lib/authClient";
import Skeleton from "@/components/Skeleton";
import { applyThemeMode, getThemeMode, storeThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";

// Account settings — identity + security. 2FA is optional per user (TOTP for
// Google Authenticator / Authy / 1Password …). The QR code is rendered LOCALLY
// (qrcode lib) so the TOTP secret never touches a third-party service; the
// sign-in verify step already lives in Login.jsx.

export default function Account() {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return (
      <div className="max-w-lg space-y-3">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="max-w-md mx-auto mt-16">
        <div className="rounded-xl border border-line lg-glass p-6 text-center">
          <h1 className="text-lg font-bold mb-1">Account</h1>
          <p className="text-sm text-dim">
            <Link to="/login?next=/account" className="text-accent hover:underline">Sign in</Link>{" "}
            to manage your account.
          </p>
        </div>
      </div>
    );
  }

  const u = session.user;
  return (
    <div className="max-w-lg">
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Settings</p>
      <h1 className="text-2xl font-bold mb-6">Account</h1>

      {/* Identity */}
      <div className="rounded-xl border border-line lg-glass p-5 mb-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold truncate">{u.name || u.email}</p>
            <p className="text-sm text-dim truncate">{u.email}</p>
          </div>
          <span className={cn(
            "shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            u.role === "admin" ? "border-accent/40 bg-accent/10 text-accent" : "border-line text-dim"
          )}>
            {u.role === "admin" ? "dev account" : "member"}
          </span>
        </div>
        <button
          onClick={() => signOut()}
          className="mt-4 btn-ghost flex items-center gap-1.5 text-xs"
        >
          <LogOut className="w-3.5 h-3.5" /> Sign out
        </button>
      </div>

      <ThemeSection accountTheme={u.theme} />

      <Link to="/pricing" className="rounded-xl border border-line lg-glass p-5 mb-4 flex items-center justify-between gap-3 hover:border-accent/40 transition-colors group">
        <div>
          <h2 className="font-semibold mb-1">Plans &amp; pricing</h2>
          <p className="text-sm text-dim">Free while in alpha — see what a Pro tier will add.</p>
        </div>
        <span className="text-accent group-hover:translate-x-0.5 transition-transform">→</span>
      </Link>

      <TwoFactorSection user={u} />
    </div>
  );
}

// Appearance — the per-account theme. Dark on this device = dark on every
// device (stored on the account, mirrored to localStorage for instant paint);
// "System" follows the OS setting live.
function ThemeSection({ accountTheme }) {
  const [mode, setMode] = useState(() => accountTheme || getThemeMode());

  const choose = (m) => {
    setMode(m);
    storeThemeMode(m);
    applyThemeMode(m);
    authClient.updateUser({ theme: m }).catch(() => { /* offline — local still applied */ });
  };

  const OPTIONS = [
    ["light", "Light", Sun],
    ["dark", "Dark", Moon],
    ["system", "System", Monitor],
  ];

  return (
    <div className="rounded-xl border border-line lg-glass p-5 mb-4">
      <h2 className="font-semibold mb-1">Appearance</h2>
      <p className="text-sm text-dim mb-3">
        Saved on your account — the same theme on every device. System follows your OS.
      </p>
      <div className="flex gap-2" role="radiogroup" aria-label="Theme">
        {OPTIONS.map(([id, label, Icon]) => (
          <button
            key={id}
            role="radio"
            aria-checked={mode === id}
            onClick={() => choose(id)}
            className={cn("chip flex items-center gap-1.5", mode === id ? "chip-active" : "chip-idle")}
          >
            <Icon className="w-3.5 h-3.5" /> {label}
          </button>
        ))}
      </div>
      <Link to="/theme" className="inline-flex items-center gap-1.5 mt-4 text-sm text-accent hover:underline">
        <Palette className="w-3.5 h-3.5" /> Customise chart colours &amp; background →
      </Link>
    </div>
  );
}

function TwoFactorSection({ user }) {
  // Local override so the UI flips immediately after verify/disable without
  // waiting for a session refetch.
  const [enabled, setEnabled] = useState(!!user.twoFactorEnabled);
  const [step, setStep] = useState("idle"); // idle | enablePw | setup | disablePw
  const [password, setPassword] = useState("");
  const [totpURI, setTotpURI] = useState("");
  const [backupCodes, setBackupCodes] = useState([]);
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // Render the otpauth:// URI as a QR locally — nothing leaves the browser.
  useEffect(() => {
    if (!totpURI) { setQr(""); return; }
    QRCode.toDataURL(totpURI, { width: 220, margin: 1 }).then(setQr).catch(() => setQr(""));
  }, [totpURI]);

  const reset = () => { setStep("idle"); setPassword(""); setCode(""); setErr(""); };

  const startEnable = async (e) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const { data, error } = await authClient.twoFactor.enable({ password });
      if (error) { setErr(error.message || "Could not start 2FA — wrong password?"); return; }
      setTotpURI(data?.totpURI || "");
      setBackupCodes(Array.isArray(data?.backupCodes) ? data.backupCodes : []);
      setPassword("");
      setStep("setup");
    } catch { setErr("Something went wrong. Try again."); }
    finally { setBusy(false); }
  };

  const confirmSetup = async (e) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const { error } = await authClient.twoFactor.verifyTotp({ code: code.trim() });
      if (error) { setErr(error.message || "Invalid code — try the current one from the app."); return; }
      setEnabled(true);
      setTotpURI(""); setCode("");
      setStep("idle");
    } catch { setErr("Something went wrong. Try again."); }
    finally { setBusy(false); }
  };

  const disable = async (e) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const { error } = await authClient.twoFactor.disable({ password });
      if (error) { setErr(error.message || "Could not disable — wrong password?"); return; }
      setEnabled(false);
      reset();
    } catch { setErr("Something went wrong. Try again."); }
    finally { setBusy(false); }
  };

  const copyBackup = async () => {
    try {
      await navigator.clipboard.writeText(backupCodes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };

  return (
    <div className="rounded-xl border border-line lg-glass p-5">
      <div className="flex items-center gap-2 mb-1">
        {enabled ? <ShieldCheck className="w-4 h-4 text-up" /> : <ShieldOff className="w-4 h-4 text-dim" />}
        <h2 className="font-semibold">Two-factor authentication</h2>
        <span className={cn(
          "ml-auto rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
          enabled ? "border-up/40 bg-up/10 text-up" : "border-line text-dim"
        )}>
          {enabled ? "on" : "off"}
        </span>
      </div>
      <p className="text-sm text-dim mb-4">
        Adds a 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password …)
        to every sign-in. Optional — you enable it, you own it.
      </p>

      {step === "idle" && !enabled && (
        <button onClick={() => setStep("enablePw")} className="btn-accent flex items-center gap-1.5 text-sm">
          <ShieldCheck className="w-4 h-4" /> Enable 2FA
        </button>
      )}
      {step === "idle" && enabled && (
        <button onClick={() => setStep("disablePw")} className="btn-ghost flex items-center gap-1.5 text-sm">
          <ShieldOff className="w-4 h-4" /> Disable 2FA
        </button>
      )}

      {(step === "enablePw" || step === "disablePw") && (
        <form onSubmit={step === "enablePw" ? startEnable : disable} className="space-y-2">
          <label className="block text-xs text-dim">
            Confirm your password to {step === "enablePw" ? "start the setup" : "disable 2FA"}
            <input
              type="password" autoFocus autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)}
              className="input-base w-full mt-1"
            />
          </label>
          {err && <p className="text-xs text-down">{err}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy || !password} className="btn-accent flex items-center gap-1.5 text-sm">
              {busy && <Loader2 className="w-4 h-4 animate-spin" />} Continue
            </button>
            <button type="button" onClick={reset} className="btn-ghost text-sm">Cancel</button>
          </div>
        </form>
      )}

      {step === "setup" && (
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium mb-2">1 · Scan with your authenticator app</p>
            {qr ? (
              <img src={qr} alt="TOTP QR code" width={180} height={180}
                className="rounded-lg border border-line bg-white p-2" />
            ) : (
              <Skeleton className="h-44 w-44 rounded-lg" />
            )}
            {totpURI && (
              <p className="mt-2 text-[11px] text-dim break-all">
                Can't scan? Enter the key manually:{" "}
                <code className="text-text">{(totpURI.match(/secret=([A-Z2-7]+)/i) || [])[1] || totpURI}</code>
              </p>
            )}
          </div>

          {backupCodes.length > 0 && (
            <div>
              <p className="text-sm font-medium mb-1.5">2 · Save your backup codes</p>
              <p className="text-[11px] text-dim mb-2">
                Each works once if you lose the phone. Store them somewhere safe — they won't be shown again.
              </p>
              <div className="rounded-lg border border-line bg-surface p-3 font-mono text-xs grid grid-cols-2 gap-x-6 gap-y-1">
                {backupCodes.map((c) => <span key={c}>{c}</span>)}
              </div>
              <button onClick={copyBackup} className="mt-2 btn-ghost flex items-center gap-1.5 text-xs">
                {copied ? <Check className="w-3.5 h-3.5 text-up" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? "Copied" : "Copy codes"}
              </button>
            </div>
          )}

          <form onSubmit={confirmSetup} className="space-y-2">
            <p className="text-sm font-medium">3 · Enter the current 6-digit code</p>
            <input
              inputMode="numeric" autoComplete="one-time-code" maxLength={6}
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              placeholder="000000"
              className="input-base w-40 text-center font-mono tracking-[0.4em]"
            />
            {err && <p className="text-xs text-down">{err}</p>}
            <div className="flex gap-2">
              <button type="submit" disabled={busy || code.length < 6} className="btn-accent flex items-center gap-1.5 text-sm">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />} Activate 2FA
              </button>
              <button type="button" onClick={reset} className="btn-ghost text-sm">Cancel</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
