import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { authClient } from "@/lib/authClient";
import { AuthShell } from "@/pages/Login";

// Open registration (email + password). Email verification is off for now, so a
// new account is signed in immediately.
export default function Register() {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    if (password.length < 8) { setErr("Password must be at least 8 characters."); return; }
    setBusy(true);
    try {
      const { error } = await authClient.signUp.email({ email, password, name: name.trim() || email.split("@")[0] });
      if (error) { setErr(error.message || "Could not create the account."); return; }
      nav("/", { replace: true });
    } catch { setErr("Something went wrong. Try again."); }
    finally { setBusy(false); }
  };

  return (
    <AuthShell title="Create account">
      <form onSubmit={submit} className="space-y-3">
        <label className="block text-xs text-dim">Name <span className="text-dim/50">(optional)</span>
          <input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)}
            className="input-base w-full mt-1" placeholder="Your name" />
        </label>
        <label className="block text-xs text-dim">Email
          <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)}
            className="input-base w-full mt-1" placeholder="you@example.com" />
        </label>
        <label className="block text-xs text-dim">Password
          <input type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
            className="input-base w-full mt-1" placeholder="At least 8 characters" />
        </label>
        {err && <p className="text-xs text-down">{err}</p>}
        <button type="submit" disabled={busy} className="btn-accent w-full justify-center flex items-center gap-2">
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} Create account
        </button>
        <p className="text-xs text-dim text-center pt-1">
          Already have an account? <Link to="/login" className="text-accent hover:underline">Sign in</Link>
        </p>
      </form>
    </AuthShell>
  );
}
