import { Newspaper, Sparkles } from "lucide-react";
import TabHub from "@/components/TabHub";
import News from "@/pages/News";
import Briefing from "@/pages/Briefing";

// News hub — Headlines (the raw feed + newsletter signup, unchanged) and
// Briefing (AI-synthesized pulse + per-holding relevance) as tabs under
// /news/:tab. Same "X is a subcategory of Y" pattern as Cortex's
// Registry/Lab/Paper/RiskGate/Brain Vault tabs (see src/pages/Cortex.jsx).
export default function NewsHub() {
  return (
    <TabHub base="/news" eyebrow="News" tabs={[
      { id: "headlines", label: "Headlines", icon: Newspaper, el: <News /> },
      { id: "briefing", label: "Briefing", icon: Sparkles, el: <Briefing /> },
    ]} />
  );
}
