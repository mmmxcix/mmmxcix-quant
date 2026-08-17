import { FlaskConical, Scale, BrainCircuit, CalendarSearch } from "lucide-react";
import TabHub from "@/components/TabHub";
import Backtest from "@/pages/Backtest";
import Compare from "@/pages/Compare";
import MLStudio from "@/pages/MLStudio";
import EventLab from "@/pages/EventLab";
import MMSim from "@/pages/MMSim";

export default function BacktestHub() {
  return (
    <TabHub base="/backtest" tabs={[
      { id: "run", label: "Backtest", icon: FlaskConical, el: <Backtest /> },
      { id: "compare", label: "Compare", icon: Scale, el: <Compare /> },
      { id: "ml", label: "ML Studio", icon: BrainCircuit, el: <MLStudio /> },
      { id: "events", label: "Event Lab", icon: CalendarSearch, el: <EventLab /> },
      { id: "mm", label: "MM Sim", icon: Scale, el: <MMSim /> },
    ]} />
  );
}
