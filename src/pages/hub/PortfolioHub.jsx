import { Briefcase, Sigma, Activity } from "lucide-react";
import TabHub from "@/components/TabHub";
import Portfolio from "@/pages/Portfolio";
import Options from "@/pages/Options";
import Volatility from "@/pages/Volatility";

export default function PortfolioHub() {
  return (
    <TabHub base="/portfolio" tabs={[
      { id: "holdings", label: "Portfolio", icon: Briefcase, el: <Portfolio /> },
      { id: "options", label: "Options", icon: Sigma, el: <Options /> },
      { id: "volatility", label: "Volatility", icon: Activity, el: <Volatility /> },
    ]} />
  );
}
