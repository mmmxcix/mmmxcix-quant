import { useParams, Navigate, NavLink } from "react-router-dom";
import { Boxes, Dices, Shield, Network } from "lucide-react";
import Registry from "@/pages/Registry";
import Lab from "@/pages/Lab";
import RiskGate from "@/pages/RiskGate";
import BrainVault from "@/pages/BrainVault";
import { cn } from "@/lib/utils";

// Cortex — the autonomous research system, consolidated into one hub. What used
// to be four separate pages (Registry / Lab / RiskGate / Brain Vault) are now
// tabs under /cortex/:tab. Old routes redirect here (see App.jsx).
const TABS = [
  { id: "registry", label: "Registry", icon: Boxes, el: <Registry /> },
  { id: "paper", label: "Paper", icon: Dices, el: <Lab /> },
  { id: "riskgate", label: "RiskGate", icon: Shield, el: <RiskGate /> },
  { id: "brain", label: "Brain Vault", icon: Network, el: <BrainVault /> },
];

export default function Cortex() {
  const { tab } = useParams();
  const active = TABS.find((t) => t.id === tab);
  if (!active) return <Navigate to="/cortex/registry" replace />;

  return (
    <div>
      <p className="text-[10px] tracking-[0.3em] text-dim uppercase mb-1">Cortex</p>
      <nav className="flex gap-1 mb-6 border-b border-line overflow-x-auto">
        {TABS.map((t) => (
          <NavLink
            key={t.id}
            to={`/cortex/${t.id}`}
            className={({ isActive }) =>
              cn(
                "inline-flex items-center gap-2 px-3.5 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors",
                isActive ? "border-accent text-accent" : "border-transparent text-dim hover:text-text"
              )
            }
          >
            <t.icon className="w-4 h-4" />
            {t.label}
          </NavLink>
        ))}
      </nav>
      {active.el}
    </div>
  );
}
