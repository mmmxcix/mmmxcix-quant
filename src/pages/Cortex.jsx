import { Boxes, Dices, Shield, Network } from "lucide-react";
import TabHub from "@/components/TabHub";
import AlwaysOnSwitch from "@/components/AlwaysOnSwitch";
import Registry from "@/pages/Registry";
import Lab from "@/pages/Lab";
import RiskGate from "@/pages/RiskGate";
import BrainVault from "@/pages/BrainVault";
import LabStatus from "@/components/LabStatus";

// Cortex — the autonomous research system as one hub. Registry / Paper /
// RiskGate / Brain Vault are tabs under /cortex/:tab; old routes redirect here.
// The live "Lab agent (your PC)" panel sits on the Paper tab (it used to live on
// the Coach page, away from everything it reports on). The Always-On switch
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
        {
          id: "paper", label: "Paper", icon: Dices,
          el: <div className="space-y-5"><LabStatus /><Lab /></div>,
        },
        { id: "riskgate", label: "RiskGate", icon: Shield, el: <RiskGate /> },
        { id: "brain", label: "Brain Vault", icon: Network, el: <BrainVault /> },
      ]}
    />
  );
}
