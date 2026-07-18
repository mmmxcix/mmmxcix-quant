import { useParams, Navigate, NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";

// TabHub — a thin tabbed shell used to consolidate related pages into one
// route (e.g. /cortex/:tab, /backtest/:tab). `tabs` is [{ id, label, icon, el }];
// the active tab comes from the :tab param and each tab links to `${base}/${id}`.
// An unknown/absent tab redirects to the first.
export default function TabHub({ base, eyebrow, tabs }) {
  const { tab } = useParams();
  const active = tabs.find((t) => t.id === tab);
  if (!active) return <Navigate to={`${base}/${tabs[0].id}`} replace />;

  return (
    <div>
      {eyebrow && <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">{eyebrow}</p>}
      <nav className="flex gap-1 mb-6 border-b border-line overflow-x-auto">
        {tabs.map((t) => (
          <NavLink
            key={t.id}
            to={`${base}/${t.id}`}
            className={({ isActive }) =>
              cn(
                "inline-flex items-center gap-2 px-3.5 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors",
                isActive ? "border-accent text-accent" : "border-transparent text-dim hover:text-text"
              )
            }
          >
            {t.icon && <t.icon className="w-4 h-4" />}
            {t.label}
          </NavLink>
        ))}
      </nav>
      {active.el}
    </div>
  );
}
