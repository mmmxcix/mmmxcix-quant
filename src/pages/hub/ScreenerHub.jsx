import { Radar, Telescope, Grid3x3 } from "lucide-react";
import TabHub from "@/components/TabHub";
import Screener from "@/pages/Screener";
import Anomalies from "@/pages/Anomalies";
import Correlation from "@/pages/Correlation";

export default function ScreenerHub() {
  return (
    <TabHub base="/screener" tabs={[
      { id: "scan", label: "Screener", icon: Radar, el: <Screener /> },
      { id: "anomalies", label: "Anomalies", icon: Telescope, el: <Anomalies /> },
      { id: "correlation", label: "Correlation", icon: Grid3x3, el: <Correlation /> },
    ]} />
  );
}
