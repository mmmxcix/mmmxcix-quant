import { useState, useEffect, useRef } from "react";
import { NavLink, Link, useLocation } from "react-router-dom";
import { LayoutDashboard, CandlestickChart, FlaskConical, Newspaper, Compass, Wrench, Activity, Scale, Star, Briefcase, Radar, GraduationCap, Sigma, Menu, X, Target, BookOpenCheck, Telescope, Cpu, Sun, Moon, Monitor, Waypoints, Search, LogIn , Landmark, Globe, Radio} from "lucide-react";
import { cn } from "@/lib/utils";
import DitherBackground from "@/components/DitherBackground";
import CommandPalette from "@/components/CommandPalette";
import { authClient, useSession, signOut } from "@/lib/authClient";
import { THEME_MODES, applyThemeMode, getThemeMode, storeThemeMode } from "@/lib/theme";

// ⌘ on macOS, Ctrl elsewhere — shown in the quick-nav affordance.
const KBD_HINT = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘K" : "Ctrl K";
const openPalette = () => window.dispatchEvent(new Event("open-command-palette"));

// Theme mode ("light" | "dark" | "system") — a per-ACCOUNT preference: stored
// on the user via Better Auth, mirrored to localStorage for the before-paint
// script, so an account that picks dark stays dark on every device and reload
// until it switches back. Signed-out visitors keep a device-local mode.
function useTheme() {
  const { data: session } = useSession();
  const [mode, setModeState] = useState(getThemeMode);
  const lastAccountTheme = useRef(null);

  // The account's stored preference wins whenever it (newly) arrives or
  // changes — that's what makes "dark on one device" mean dark everywhere.
  useEffect(() => {
    const t = session?.user?.theme;
    if (t && THEME_MODES.includes(t) && t !== lastAccountTheme.current) {
      lastAccountTheme.current = t;
      setModeState(t);
      storeThemeMode(t);
    }
  }, [session?.user?.theme]);

  // Apply on change; in system mode follow the OS live.
  useEffect(() => {
    applyThemeMode(mode);
    if (mode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyThemeMode("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  const setMode = (next) => {
    setModeState(next);
    storeThemeMode(next);
    applyThemeMode(next);
    // Persist on the account so every device follows (fire-and-forget).
    if (session?.user) authClient.updateUser({ theme: next }).catch(() => { /* offline */ });
  };

  return [mode, setMode];
}

function ThemeToggle({ className }) {
  const [mode, setMode] = useTheme();
  const next = THEME_MODES[(THEME_MODES.indexOf(mode) + 1) % THEME_MODES.length];
  const Icon = mode === "dark" ? Moon : mode === "system" ? Monitor : Sun;
  return (
    <button
      onClick={() => setMode(next)}
      aria-label={`Theme: ${mode} — switch to ${next}`}
      title={`Theme: ${mode} · click for ${next}`}
      className={cn("inline-flex items-center justify-center rounded-lg border border-line text-dim hover:text-text transition-colors", className)}
    >
      <Icon className="w-4 h-4" />
    </button>
  );
}

// Four functional groups: follow the markets → manage what you hold →
// build and test strategies → learn the craft.
const NAV_GROUPS = [
  {
    label: "Markets",
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
      { to: "/charts", label: "Charts", icon: CandlestickChart },
      { to: "/screener", label: "Screener", icon: Radar },
      { to: "/news", label: "News", icon: Newspaper },
      { to: "/map", label: "World Map", icon: Globe },
      { to: "/macro", label: "Macro", icon: Landmark },
    ],
  },
  {
    label: "Strategy",
    items: [
      { to: "/backtest", label: "Backtest", icon: FlaskConical },
      { to: "/regimes", label: "Regimes", icon: Waypoints },
      { to: "/portfolio", label: "Portfolio", icon: Briefcase },
      { to: "/tools", label: "Tools", icon: Wrench },
    ],
  },
  {
    label: "Learn",
    items: [
      { to: "/learn", label: "Academy", icon: GraduationCap },
    ],
  },
];

// Dev-only nav entries appear ONLY for the signed-in admin (dev) account —
// other users don't see that these areas exist. Routes are guarded server-side
// and by RequireAdmin either way; this is just menu visibility.
function useDevNav() {
  const { data: session } = useSession();
  return session?.user?.role === "admin";
}

const DEV_ITEMS = {
  Strategy: [{ to: "/cortex", label: "Cortex", icon: Cpu }, { to: "/argus", label: "Argus", icon: Radio }],
  Learn: [{ to: "/coach", label: "Coach", icon: Target }],
};

function NavItems({ onNavigate }) {
  const isDev = useDevNav();
  const { pathname } = useLocation();
  const containerRef = useRef(null);
  const [rail, setRail] = useState(null); // { top, height } of the active item
  const groups = isDev
    ? NAV_GROUPS.map((g) => (DEV_ITEMS[g.label] ? { ...g, items: [...g.items, ...DEV_ITEMS[g.label]] } : g))
    : NAV_GROUPS;

  // The active accent bar is ONE element that slides to the active item on
  // navigation (shared-layout feel) instead of popping per item.
  useEffect(() => {
    const c = containerRef.current;
    if (!c) return;
    const el = c.querySelector('[aria-current="page"]');
    if (el) setRail({ top: el.offsetTop + 6, height: el.offsetHeight - 12 });
    else setRail(null);
  }, [pathname, isDev]);

  return (
    <div ref={containerRef} className="relative">
      {rail && (
        <span
          aria-hidden="true"
          className="nav-rail absolute -left-2 w-[3px] rounded-full bg-accent"
          style={{ top: rail.top, height: rail.height }}
        />
      )}
      {groups.map((group, gi) => (
        <div key={group.label}>
          <p className={cn("px-3 text-[9px] font-semibold uppercase tracking-[0.2em] text-dim", gi === 0 ? "mb-1" : "mt-4 mb-1")}>
            {group.label}
          </p>
          {group.items.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  "relative flex items-center gap-2.5 rounded-lg px-3 py-[7px] text-sm transition-colors",
                  isActive ? "bg-accent/10 text-accent font-medium" : "text-dim hover:text-text hover:bg-surface"
                )
              }
            >
              <Icon className="w-4 h-4 shrink-0" />
              {label}
            </NavLink>
          ))}
        </div>
      ))}
    </div>
  );
}

// Signed-in state + entry/exit, at the bottom of the sidebar / drawer. The dev
// account is labelled; sign-out revokes the server-side session.
function SessionBox() {
  const { data: session, isPending } = useSession();
  if (isPending) return null;
  // Guard on session.user, not just session: an auth hiccup can return a
  // truthy error-shaped object, and SessionBox lives in the always-mounted
  // shell — an unguarded read here white-screens the entire app.
  if (!session?.user) {
    return (
      <Link
        to="/login"
        className="flex items-center gap-2 rounded-lg border border-line bg-surface/60 px-3 py-1.5 text-xs text-dim transition-colors hover:text-text"
      >
        <LogIn className="h-3.5 w-3.5" /> Sign in
      </Link>
    );
  }
  return (
    <div className="rounded-lg border border-line bg-surface/60 px-3 py-2">
      <Link to="/account" className="block truncate text-xs text-text transition-colors hover:text-accent" title="Account settings (2FA …)">
        {session.user.name || session.user.email}
      </Link>
      <div className="mt-0.5 flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-dim">
          {session.user.role === "admin" ? "dev account" : "account"}
        </span>
        <button onClick={() => signOut()} className="text-[10px] text-dim transition-colors hover:text-text">
          Sign out
        </button>
      </div>
    </div>
  );
}

function LegalLinks({ small }) {
  const c = small ? "text-[10px] text-dim hover:text-dim" : "text-xs text-dim hover:text-text";
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      <Link to="/impressum" className={cn("transition-colors", c)}>Legal Notice</Link>
      <Link to="/datenschutz" className={cn("transition-colors", c)}>Privacy</Link>
      <Link to="/nutzung" className={cn("transition-colors", c)}>Terms</Link>
    </div>
  );
}

export default function Layout({ children }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  // Close the mobile drawer on route change and lock body scroll while open.
  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);
  useEffect(() => {
    document.body.style.overflow = drawerOpen ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [drawerOpen]);

  return (
    <div className="min-h-screen">
      <div className="ambient-bg" aria-hidden="true" />
      <DitherBackground />
      <div className="grain-layer" aria-hidden="true" />
      <CommandPalette />

      {/* Desktop sidebar */}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-56 flex-col border-r border-line lg-frost p-4">
        <div className="mb-5 px-3 pt-2">
          <p className="text-[10px] tracking-[0.3em] text-dim uppercase">MMMXCIX</p>
          <p className="text-lg font-bold text-text tracking-tight">Quant</p>
        </div>
        <button
          onClick={openPalette}
          className="mb-5 flex w-full items-center gap-2 rounded-lg border border-line bg-surface/60 px-3 py-1.5 text-xs text-dim transition-colors hover:text-text hover:border-line/80"
        >
          <Search className="h-3.5 w-3.5" />
          <span>Jump to…</span>
          <kbd className="ml-auto font-mono text-[10px] text-dim">{KBD_HINT}</kbd>
        </button>
        <nav className="flex flex-col gap-1 overflow-y-auto pr-1 -mr-1">
          <NavItems />
        </nav>
        <div className="mt-auto px-3 pb-2 space-y-2">
          <SessionBox />
          <ThemeToggle className="w-8 h-8" />
          <p className="text-[10px] text-dim leading-relaxed">
            Not investment advice. Backtests are hypothetical — past performance guarantees nothing.
          </p>
          <LegalLinks small />
        </div>
      </aside>

      {/* Mobile top bar: brand + hamburger */}
      <header className="md:hidden sticky top-0 z-30 flex items-center justify-between border-b border-line lg-frost px-4 h-14">
        <p className="text-sm font-bold">
          <span className="text-dim tracking-[0.25em] text-[10px] uppercase mr-2">MMMXCIX</span>Quant
        </p>
        <div className="flex items-center gap-1">
          <button
            onClick={openPalette}
            aria-label="Search pages"
            className="p-2 rounded-lg text-dim hover:text-text active:bg-surface transition-colors"
          >
            <Search className="w-5 h-5" />
          </button>
          <ThemeToggle className="w-9 h-9" />
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
            className="p-2 -mr-2 rounded-lg text-dim hover:text-text active:bg-surface transition-colors"
          >
            <Menu className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Mobile slide-out drawer */}
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 z-40">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} />
          <div className="absolute inset-y-0 right-0 w-72 max-w-[85vw] bg-surface border-l border-line flex flex-col p-4 shadow-2xl animate-[slidein_0.18s_ease-out]">
            <div className="flex items-center justify-between mb-6 px-1">
              <div>
                <p className="text-[10px] tracking-[0.3em] text-dim uppercase">MMMXCIX</p>
                <p className="text-lg font-bold text-text tracking-tight">Quant</p>
              </div>
              <button onClick={() => setDrawerOpen(false)} aria-label="Close menu"
                className="p-2 rounded-lg text-dim hover:text-text active:bg-bg transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex flex-col gap-1 overflow-y-auto">
              <NavItems onNavigate={() => setDrawerOpen(false)} />
            </nav>
            <div className="mt-auto space-y-3 pt-4 border-t border-line">
              <SessionBox />
              <LegalLinks />
            </div>
          </div>
        </div>
      )}

      <main className="md:ml-56 p-3 sm:p-4 md:p-8 max-w-[1800px]">
        {/* keyed by route so each page entry replays the reveal */}
        <div key={location.pathname} className="view-in">{children}</div>
      </main>

      {/* Mobile footer */}
      <footer className="md:hidden border-t border-line px-4 py-4 mt-4">
        <LegalLinks />
        <p className="mt-2 text-[10px] text-dim">Not investment advice.</p>
      </footer>
    </div>
  );
}
