import { Landmark, CalendarDays, Database } from "lucide-react";
import TabHub from "@/components/TabHub";
import { Yields, EconCalendar, L3Archive } from "@/pages/Macro";

export default function MacroHub() {
  return (
    <TabHub base="/macro" eyebrow="Macro" tabs={[
      { id: "yields", label: "Bond Yields", icon: Landmark, el: <Yields /> },
      { id: "calendar", label: "Econ Events", icon: CalendarDays, el: <EconCalendar /> },
      { id: "l3", label: "L3 Archive", icon: Database, el: <L3Archive /> },
    ]} />
  );
}
