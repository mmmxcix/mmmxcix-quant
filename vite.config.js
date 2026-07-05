import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    // Mirrors the Cloudflare Pages Function /api/yahoo/* in local dev, so
    // stock charts work under `vite dev` too (Yahoo blocks browser CORS).
    proxy: {
      "/api/yahoo": {
        target: "https://query1.finance.yahoo.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/yahoo/, ""),
      },
    },
  },
});
