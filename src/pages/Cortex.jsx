import { Boxes, Dices, Shield, Network, Cpu } from "lucide-react";
import TabHub from "@/components/TabHub";
import AlwaysOnSwitch from "@/components/AlwaysOnSwitch";
import Registry from "@/pages/Registry";
import Lab from "@/pages/Lab";
import RiskGate from "@/pages/RiskGate";
import BrainVault from "@/pages/BrainVault";
import LabStatus from "@/components/LabStatus";

// Cortex — the autonomous research system as one hub. Registry / Lab agent /
// Paper / RiskGate / Brain Vault are tabs under /cortex/:tab; old routes redirect
// here. The live "Lab agent (your PC)" panel — what the agent is ACTUALLY trading
// right now, de-duplicated by code and expandable to each strategy's trade log —
// has its own tab (it used to be buried inside Paper). The Always-On switch
// (visible on every tab) flips the research cadence between night-only and
// around-the-clock.
export default function Cortex() {
  return (
    <TabHub
      base="/cortex"
      eyebrow="Cortex"
      extra={<AlwaysOnSwitch />}
      tabs={[
        { id: "registry", label: "Registry", icon: Boxes, el: <Registry /> },
        { id: "lab", label: "Lab agent", icon: Cpu, el: <LabStatus /> },
        { id: "paper", label: "Paper", icon: Dices, el: <Lab /> },
        { id: "riskgate", label: "RiskGate", icon: Shield, el: <RiskGate /> },
        { id: "brain", label: "Brain Vault", icon: Network, el: <BrainVault /> },
      ]}
    />
  );
}
