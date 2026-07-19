import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import Layout from "@/components/Layout";
import Dashboard from "@/pages/Dashboard";
import Charts from "@/pages/Charts";
import News from "@/pages/News";
import Tools from "@/pages/Tools";
import Regimes from "@/pages/Regimes";
import Coach from "@/pages/Coach";
import Cortex from "@/pages/Cortex";
import { BacktestHub, PortfolioHub, ScreenerHub, LearnHub } from "@/pages/hubs";
import Impressum from "@/pages/Impressum";
import Datenschutz from "@/pages/Datenschutz";
import Nutzung from "@/pages/Nutzung";

// Redirect that preserves the query string, so deep links (e.g.
// /academy?c=…&l=… into the Learn hub) keep their course/lesson params.
function Redir({ to }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}

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
                <Route path="/news" element={<News />} />
                <Route path="/watchlist" element={<Redir to="/?view=watchlist" />} />
                <Route path="/monitor" element={<Redir to="/?view=monitor" />} />
                <Route path="/tools" element={<Tools />} />
                <Route path="/regimes" element={<Regimes />} />
                <Route path="/coach" element={<Coach />} />

                {/* Cortex hub (Registry · Paper · RiskGate · Brain Vault) */}
                <Route path="/cortex" element={<Redir to="/cortex/registry" replace />} />
                <Route path="/cortex/:tab" element={<Cortex />} />
                <Route path="/registry" element={<Redir to="/cortex/registry" replace />} />
                <Route path="/lab" element={<Redir to="/cortex/paper" replace />} />
                <Route path="/riskgate" element={<Redir to="/cortex/riskgate" replace />} />
                <Route path="/brain" element={<Redir to="/cortex/brain" replace />} />

                {/* Backtest hub (+ Compare) */}
                <Route path="/backtest" element={<Redir to="/backtest/run" replace />} />
                <Route path="/backtest/:tab" element={<BacktestHub />} />
                <Route path="/compare" element={<Redir to="/backtest/compare" replace />} />

                {/* Portfolio hub (+ Options) */}
                <Route path="/portfolio" element={<Redir to="/portfolio/holdings" replace />} />
                <Route path="/portfolio/:tab" element={<PortfolioHub />} />
                <Route path="/options" element={<Redir to="/portfolio/options" replace />} />

                {/* Screener hub (+ Anomalies) */}
                <Route path="/screener" element={<Redir to="/screener/scan" replace />} />
                <Route path="/screener/:tab" element={<ScreenerHub />} />
                <Route path="/anomalies" element={<Redir to="/screener/anomalies" replace />} />

                {/* Learn hub (Academy · Guide · Resources) */}
                <Route path="/learn" element={<Redir to="/learn/academy" replace />} />
                <Route path="/learn/:tab" element={<LearnHub />} />
                <Route path="/academy" element={<Redir to="/learn/academy" replace />} />
                <Route path="/guide" element={<Redir to="/learn/guide" replace />} />
                <Route path="/resources" element={<Redir to="/learn/resources" replace />} />

                <Route path="*" element={<Dashboard />} />
              </Routes>
            </Layout>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
