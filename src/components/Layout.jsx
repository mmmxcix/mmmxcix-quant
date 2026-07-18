import { useState, useEffect } from "react";
import { NavLink, Link, useLocation } from "react-router-dom";
import { LayoutDashboard, CandlestickChart, FlaskConical, Newspaper, Compass, Wrench, Activity, Scale, Star, Briefcase, Radar, GraduationCap, Sigma, Menu, X, Target, BookOpenCheck, Telescope, Cpu, Sun, Moon } from "lucide-react";
import { cn } from "@/lib/utils";
import DitherBackground from "@/components/DitherBackground";

function useTheme() {
  const get = () => (typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const [t, setT] = useState(get);
  const toggle = () => {
    const n = t === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = n;
    try { localStorage.setItem("theme", n); } catch { /* private mode */ }
    setT(n);
  };
  return [t, toggle];
}

function ThemeToggle({ className }) {
  const [t, toggle] = useTheme();
  return (
    <button
      onClick={toggle}
      aria-label="Toggle light or dark theme"
      className={cn("inline-flex items-center justify-center rounded-lg border border-line text-dim hover:text-text transition-colors", className)}
    >
      {t === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
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
    ],
  },
  {
    label: "Strategy",
    items: [
      { to: "/backtest", label: "Backtest", icon: FlaskConical },
      { to: "/cortex", label: "Cortex", icon: Cpu },
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

// The private Coach page only appears in the nav once the dev token exists in
// this browser (set on /coach or in the Backtest AI panel). The route itself
// stays gated server-side either way — this just hides the menu entry.
function useDevNav() {
  const read = () => {
    try { return !!localStorage.getItem("quant_dev_token"); } catch { return false; }
  };
  const [isDev, setIsDev] = useState(read);
  useEffect(() => {
    const update = () => setIsDev(read());
    window.addEventListener("quant-dev-token", update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener("quant-dev-token", update);
      window.removeEventListener("storage", update);
    };
  }, []);
  return isDev;
}

// Private, dev-token-gated nav entries, injected per group when a token exists.
// (RiskGate + Brain Vault are now tabs inside the Cortex hub.)
const DEV_ITEMS = {
  Learn: [{ to: "/coach", label: "Coach", icon: Target }],
};

function NavItems({ onNavigate }) {
  const isDev = useDevNav();
  const groups = isDev
    ? NAV_GROUPS.map((g) => (DEV_ITEMS[g.label] ? { ...g, items: [...g.items, ...DEV_ITEMS[g.label]] } : g))
    : NAV_GROUPS;
  return groups.map((group, gi) => (
    <div key={group.label}>
      <p className={cn("px-3 text-[9px] font-semibold uppercase tracking-[0.2em] text-dim/60", gi === 0 ? "mb-1" : "mt-4 mb-1")}>
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
              "flex items-center gap-2.5 rounded-lg px-3 py-[7px] text-sm transition-colors",
              isActive ? "bg-accent/10 text-accent" : "text-dim hover:text-text hover:bg-surface"
            )
          }
        >
          <Icon className="w-4 h-4 shrink-0" />
          {label}
        </NavLink>
      ))}
    </div>
  ));
}

function LegalLinks({ small }) {
  const c = small ? "text-[10px] text-dim/60 hover:text-dim" : "text-xs text-dim hover:text-text";
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

      {/* Desktop sidebar */}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-56 flex-col border-r border-line lg-frost p-4">
        <div className="mb-8 px-3 pt-2">
          <p className="text-[10px] tracking-[0.3em] text-dim uppercase">MMMXCIX</p>
          <p className="text-lg font-bold text-text tracking-tight">Quant</p>
        </div>
        <nav className="flex flex-col gap-1 overflow-y-auto pr-1 -mr-1">
          <NavItems />
        </nav>
        <div className="mt-auto px-3 pb-2 space-y-2">
          <ThemeToggle className="w-8 h-8" />
          <p className="text-[10px] text-dim/60 leading-relaxed">
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
            <div className="mt-auto pt-4 border-t border-line">
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
        <p className="mt-2 text-[10px] text-dim/60">Not investment advice.</p>
      </footer>
    </div>
  );
}
