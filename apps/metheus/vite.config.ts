import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 7322,
    strictPort: true,
    host: process.env.METHEUS_HOST ?? process.env.OMARCHY_BOT_HOST ?? "127.0.0.1",
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
