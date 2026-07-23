import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import Layout from "@/components/Layout";
import RequireAdmin from "@/components/RequireAdmin";
import Skeleton from "@/components/Skeleton";

// Route-level code splitting: each page loads as its own chunk on first visit,
// so the initial bundle stays lean (Charts' charting lib, the Academy content,
// Cortex etc. no longer weigh down the landing). Layout stays eager — it IS the
// shell. hubs.jsx exports several named hubs, hence the .then() default-mapping.
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Charts = lazy(() => import("@/pages/Charts"));
const News = lazy(() => import("@/pages/News"));
const Tools = lazy(() => import("@/pages/Tools"));
const Regimes = lazy(() => import("@/pages/Regimes"));
const Coach = lazy(() => import("@/pages/Coach"));
const Cortex = lazy(() => import("@/pages/Cortex"));
const BacktestHub = lazy(() => import("@/pages/hubs").then((m) => ({ default: m.BacktestHub })));
const PortfolioHub = lazy(() => import("@/pages/hubs").then((m) => ({ default: m.PortfolioHub })));
const ScreenerHub = lazy(() => import("@/pages/hubs").then((m) => ({ default: m.ScreenerHub })));
const LearnHub = lazy(() => import("@/pages/hubs").then((m) => ({ default: m.LearnHub })));
const MacroHub = lazy(() => import("@/pages/hubs").then((m) => ({ default: m.MacroHub })));
const WorldMap = lazy(() => import("@/pages/WorldMap"));
const Impressum = lazy(() => import("@/pages/Impressum"));
const Datenschutz = lazy(() => import("@/pages/Datenschutz"));
const Nutzung = lazy(() => import("@/pages/Nutzung"));
const Login = lazy(() => import("@/pages/Login"));
const Register = lazy(() => import("@/pages/Register"));
const Account = lazy(() => import("@/pages/Account"));

// Skeleton shown while a route chunk loads (usually just a flicker on repeat
// visits — chunks are cached).
function RouteFallback() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-6 w-44" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

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
      <Suspense fallback={null}>
      <Routes>
        <Route path="/impressum" element={<Impressum />} />
        <Route path="/datenschutz" element={<Datenschutz />} />
        <Route path="/nutzung" element={<Nutzung />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route
          path="*"
          element={
            <Layout>
              <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/charts" element={<Charts />} />
                <Route path="/news" element={<News />} />
                <Route path="/watchlist" element={<Redir to="/?view=watchlist" />} />
                <Route path="/monitor" element={<Redir to="/?view=monitor" />} />
                <Route path="/tools" element={<Tools />} />
                <Route path="/regimes" element={<Regimes />} />
                <Route path="/coach" element={<Coach />} />
                <Route path="/account" element={<Account />} />

                {/* Cortex hub (Registry · Paper · RiskGate · Brain Vault) — dev only */}
                <Route path="/cortex" element={<Redir to="/cortex/registry" replace />} />
                <Route path="/cortex/:tab" element={<RequireAdmin><Cortex /></RequireAdmin>} />
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
                <Route path="/correlation" element={<Redir to="/screener/correlation" replace />} />

                <Route path="/macro" element={<Redir to="/macro/yields" replace />} />
                <Route path="/map" element={<WorldMap />} />
                <Route path="/ships" element={<Redir to="/map" replace />} />
                <Route path="/planes" element={<Redir to="/map" replace />} />
                <Route path="/macro/ships" element={<Redir to="/map" replace />} />
                <Route path="/macro/planes" element={<Redir to="/map" replace />} />
                <Route path="/macro/:tab" element={<MacroHub />} />

                {/* Learn hub (Academy · Guide · Resources) */}
                <Route path="/learn" element={<Redir to="/learn/academy" replace />} />
                <Route path="/learn/:tab" element={<LearnHub />} />
                <Route path="/academy" element={<Redir to="/learn/academy" replace />} />
                <Route path="/guide" element={<Redir to="/learn/guide" replace />} />
                <Route path="/resources" element={<Redir to="/learn/resources" replace />} />

                <Route path="*" element={<Dashboard />} />
              </Routes>
              </Suspense>
            </Layout>
          }
        />
      </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
