import { NavLink } from "react-router-dom";
import { LayoutDashboard, CandlestickChart, FlaskConical, Newspaper, Compass, Wrench, Activity, Scale } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/monitor", label: "Monitor", icon: Activity },
  { to: "/charts", label: "Charts", icon: CandlestickChart },
  { to: "/backtest", label: "Backtest", icon: FlaskConical },
  { to: "/compare", label: "Vergleich", icon: Scale },
  { to: "/tools", label: "Tools", icon: Wrench },
  { to: "/news", label: "News", icon: Newspaper },
  { to: "/resources", label: "Ressourcen", icon: Compass },
];

function NavItems({ horizontal = false }) {
  return NAV.map(({ to, label, icon: Icon, end }) => (
    <NavLink
      key={to}
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 rounded-lg text-sm transition-colors",
          horizontal ? "px-3 py-1.5" : "px-3 py-2",
          isActive ? "bg-accent/10 text-accent" : "text-dim hover:text-text hover:bg-surface"
        )
      }
    >
      <Icon className="w-4 h-4 shrink-0" />
      {label}
    </NavLink>
  ));
}

export default function Layout({ children }) {
  // Glass look is pure CSS here (.lg-glass/.lg-frost in glass.css) — the
  // WebGL liquidGL lens from the casino smeared overlapping UI (dropdowns)
  // and cost too much RAM for a data-dense trading tool.
  return (
    <div className="min-h-screen">
      <div className="ambient-bg" aria-hidden="true" />
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-56 flex-col border-r border-line lg-frost p-4">
        <div className="mb-8 px-3 pt-2">
          <p className="text-[10px] tracking-[0.3em] text-dim uppercase">MMMXCIX</p>
          <p className="text-lg font-bold text-text tracking-tight">Quant</p>
        </div>
        <nav className="flex flex-col gap-1">
          <NavItems />
        </nav>
        <div className="mt-auto px-3 pb-2">
          <p className="text-[10px] text-dim/60 leading-relaxed">
            Keine Anlageberatung. Backtests sind hypothetisch — vergangene Performance garantiert nichts.
          </p>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="md:hidden sticky top-0 z-20 border-b border-line lg-frost px-4 py-3">
        <p className="text-sm font-bold mb-2">
          <span className="text-dim tracking-[0.25em] text-[10px] uppercase mr-2">MMMXCIX</span>Quant
        </p>
        <nav className="flex gap-1 overflow-x-auto">
          <NavItems horizontal />
        </nav>
      </header>

      <main className="md:ml-56 p-4 md:p-8 max-w-[1800px]">{children}</main>
    </div>
  );
}
