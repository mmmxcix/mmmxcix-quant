import { useState, useEffect } from "react";
import { NavLink, Link, useLocation } from "react-router-dom";
import { LayoutDashboard, CandlestickChart, FlaskConical, Newspaper, Compass, Wrench, Activity, Scale, Star, Briefcase, Radar, GraduationCap, Menu, X } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/monitor", label: "Monitor", icon: Activity },
  { to: "/screener", label: "Screener", icon: Radar },
  { to: "/charts", label: "Charts", icon: CandlestickChart },
  { to: "/watchlist", label: "Watchlist", icon: Star },
  { to: "/portfolio", label: "Portfolio", icon: Briefcase },
  { to: "/backtest", label: "Backtest", icon: FlaskConical },
  { to: "/compare", label: "Compare", icon: Scale },
  { to: "/tools", label: "Tools", icon: Wrench },
  { to: "/academy", label: "Academy", icon: GraduationCap },
  { to: "/news", label: "News", icon: Newspaper },
  { to: "/resources", label: "Resources", icon: Compass },
];

function NavItems({ onNavigate }) {
  return NAV.map(({ to, label, icon: Icon, end }) => (
    <NavLink
      key={to}
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition-colors",
          isActive ? "bg-accent/10 text-accent" : "text-dim hover:text-text hover:bg-surface"
        )
      }
    >
      <Icon className="w-4 h-4 shrink-0" />
      {label}
    </NavLink>
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

      {/* Desktop sidebar */}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-56 flex-col border-r border-line lg-frost p-4">
        <div className="mb-8 px-3 pt-2">
          <p className="text-[10px] tracking-[0.3em] text-dim uppercase">MMMXCIX</p>
          <p className="text-lg font-bold text-text tracking-tight">Quant</p>
        </div>
        <nav className="flex flex-col gap-1">
          <NavItems />
        </nav>
        <div className="mt-auto px-3 pb-2 space-y-2">
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
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Open menu"
          className="p-2 -mr-2 rounded-lg text-dim hover:text-text active:bg-surface transition-colors"
        >
          <Menu className="w-5 h-5" />
        </button>
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

      <main className="md:ml-56 p-3 sm:p-4 md:p-8 max-w-[1800px]">{children}</main>

      {/* Mobile footer */}
      <footer className="md:hidden border-t border-line px-4 py-4 mt-4">
        <LegalLinks />
        <p className="mt-2 text-[10px] text-dim/60">Not investment advice.</p>
      </footer>
    </div>
  );
}
