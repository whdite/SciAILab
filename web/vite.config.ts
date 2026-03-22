import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/health": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
      },
      "/v1": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
      },
      "/trace": {
        target: "http://127.0.0.1:8765",
        changeOrigin: true,
      },
      "/gateway": {
        target: "http://127.0.0.1:18789",
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
