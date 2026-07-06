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

export default function App() {
  return (
    <BrowserRouter>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/charts" element={<Charts />} />
          <Route path="/backtest" element={<Backtest />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/monitor" element={<Monitor />} />
          <Route path="/news" element={<News />} />
          <Route path="/tools" element={<Tools />} />
          <Route path="/resources" element={<Resources />} />
          <Route path="*" element={<Dashboard />} />
        </Routes>
      </Layout>
    </BrowserRouter>
  );
}
