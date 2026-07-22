import { FlaskConical, Scale, Briefcase, Sigma, GraduationCap, BookOpenCheck, Compass, Radar, Telescope, Grid3x3, BrainCircuit, Landmark, CalendarDays, Database, Ship } from "lucide-react";
import TabHub from "@/components/TabHub";
import Backtest from "@/pages/Backtest";
import Compare from "@/pages/Compare";
import Portfolio from "@/pages/Portfolio";
import Options from "@/pages/Options";
import Academy from "@/pages/Academy";
import Guide from "@/pages/Guide";
import Resources from "@/pages/Resources";
import Screener from "@/pages/Screener";
import Anomalies from "@/pages/Anomalies";
import Correlation from "@/pages/Correlation";
import MLStudio from "@/pages/MLStudio";
import { Yields, EconCalendar, L3Archive } from "@/pages/Macro";
import Ships from "@/pages/Ships";

// Consolidated hubs — related pages merged into one tabbed route each. Old
// routes redirect to the matching tab (see App.jsx).

export function BacktestHub() {
  return (
    <TabHub base="/backtest" tabs={[
      { id: "run", label: "Backtest", icon: FlaskConical, el: <Backtest /> },
      { id: "compare", label: "Compare", icon: Scale, el: <Compare /> },
      { id: "ml", label: "ML Studio", icon: BrainCircuit, el: <MLStudio /> },
    ]} />
  );
}

export function PortfolioHub() {
  return (
    <TabHub base="/portfolio" tabs={[
      { id: "holdings", label: "Portfolio", icon: Briefcase, el: <Portfolio /> },
      { id: "options", label: "Options", icon: Sigma, el: <Options /> },
    ]} />
  );
}

export function ScreenerHub() {
  return (
    <TabHub base="/screener" tabs={[
      { id: "scan", label: "Screener", icon: Radar, el: <Screener /> },
      { id: "anomalies", label: "Anomalies", icon: Telescope, el: <Anomalies /> },
      { id: "correlation", label: "Correlation", icon: Grid3x3, el: <Correlation /> },
    ]} />
  );
}

export function LearnHub() {
  return (
    <TabHub base="/learn" eyebrow="Learn" tabs={[
      { id: "academy", label: "Academy", icon: GraduationCap, el: <Academy /> },
      { id: "guide", label: "Guide", icon: BookOpenCheck, el: <Guide /> },
      { id: "resources", label: "Resources", icon: Compass, el: <Resources /> },
    ]} />
  );
}

export function MacroHub() {
  return (
    <TabHub base="/macro" eyebrow="Macro" tabs={[
      { id: "yields", label: "Bond Yields", icon: Landmark, el: <Yields /> },
      { id: "calendar", label: "Econ Events", icon: CalendarDays, el: <EconCalendar /> },
      { id: "l3", label: "L3 Archive", icon: Database, el: <L3Archive /> },
      { id: "ships", label: "Ship Tracking", icon: Ship, el: <Ships /> },
    ]} />
  );
}
