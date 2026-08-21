import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: ["many-cheating-uniformly.ngrok-free.dev"],
    proxy: {
      "/preflight-api": {
        target: "http://localhost:4001",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/preflight-api/, ""),
      },
    },
  },
});