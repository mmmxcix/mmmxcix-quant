import { GraduationCap, BookOpenCheck, Compass, Sigma } from "lucide-react";
import TabHub from "@/components/TabHub";
import Academy from "@/pages/Academy";
import Guide from "@/pages/Guide";
import Resources from "@/pages/Resources";
import Formulas from "@/pages/Formulas";

export default function LearnHub() {
  return (
    <TabHub base="/learn" eyebrow="Learn" tabs={[
      { id: "academy", label: "Academy", icon: GraduationCap, el: <Academy /> },
      { id: "guide", label: "Guide", icon: BookOpenCheck, el: <Guide /> },
      { id: "resources", label: "Resources", icon: Compass, el: <Resources /> },
      { id: "formulas", label: "Formulas", icon: Sigma, el: <Formulas /> },
    ]} />
  );
}
