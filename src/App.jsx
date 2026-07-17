import { BrowserRouter, Routes, Route } from "react-router-dom";
import Layout from "@/components/Layout";
import Dashboard from "@/pages/Dashboard";
import Charts from "@/pages/Charts";
import Backtest from "@/pages/Backtest";
import News from "@/pages/News";
import Resources from "@/pages/Resources";
import Tools from "@/pages/Tools";
import Compare from "@/pages/Compare";
import Monitor from "@/pages/Monitor";
import Watchlist from "@/pages/Watchlist";
import Portfolio from "@/pages/Portfolio";
import Screener from "@/pages/Screener";
import Options from "@/pages/Options";
import Academy from "@/pages/Academy";
import Coach from "@/pages/Coach";
import Lab from "@/pages/Lab";
import Anomalies from "@/pages/Anomalies";
import Guide from "@/pages/Guide";
import Registry from "@/pages/Registry";
import Impressum from "@/pages/Impressum";
import Datenschutz from "@/pages/Datenschutz";
import Nutzung from "@/pages/Nutzung";

// The legal pages carry their own full-page shell (LegalLayout), so they render
// outside the app chrome; everything else lives inside Layout.
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/impressum" element={<Impressum />} />
        <Route path="/datenschutz" element={<Datenschutz />} />
        <Route path="/nutzung" element={<Nutzung />} />
        <Route
          path="*"
          element={
            <Layout>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/charts" element={<Charts />} />
                <Route path="/backtest" element={<Backtest />} />
                <Route path="/lab" element={<Lab />} />
                <Route path="/anomalies" element={<Anomalies />} />
                <Route path="/registry" element={<Registry />} />
                <Route path="/compare" element={<Compare />} />
                <Route path="/monitor" element={<Monitor />} />
                <Route path="/screener" element={<Screener />} />
                <Route path="/options" element={<Options />} />
                <Route path="/watchlist" element={<Watchlist />} />
                <Route path="/portfolio" element={<Portfolio />} />
                <Route path="/news" element={<News />} />
                <Route path="/academy" element={<Academy />} />
                <Route path="/guide" element={<Guide />} />
                <Route path="/coach" element={<Coach />} />
                <Route path="/tools" element={<Tools />} />
                <Route path="/resources" element={<Resources />} />
                <Route path="*" element={<Dashboard />} />
              </Routes>
            </Layout>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
