import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import stylex from "@stylexjs/rollup-plugin";

function stylexForScripts(command: "build" | "serve"): Plugin {
  const plugin = stylex({
    dev: command === "serve",
    runtimeInjection: command === "serve",
    unstable_moduleResolution: { type: "commonJS" },
  }) as unknown as Plugin;
  const transform = plugin.transform;
  if (typeof transform === "function") {
    plugin.transform = function (code, id, options) {
      // Vite 8 passes CSS modules through JS transform hooks; StyleX only parses JS/TS sources.
      if (/\.css(?:$|\?)/.test(id)) return null;
      // Pre-bundled dependencies already ship compiled styles. Vite can replace these chunks during discovery.
      if (id.includes("/node_modules/.vite/deps/")) return null;
      return transform.call(this, code, id, options);
    };
  }
  return plugin;
}

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    stylexForScripts(command),
    {
      name: "stylex-stylesheet",
      apply: "build",
      transformIndexHtml: {
        order: "post",
        handler: () => [{ tag: "link", attrs: { rel: "stylesheet", href: "/stylex.css" }, injectTo: "head" }],
      },
    },
  ],
  clearScreen: false,
  server: {
    port: 7322,
    strictPort: true,
    host: process.env.OMARCHY_BOT_HOST ?? "127.0.0.1",
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
