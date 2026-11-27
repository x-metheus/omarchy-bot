import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import stylex from "@stylexjs/rollup-plugin";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

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
      return transform.call(this, code, id, options);
    };
  }
  return plugin;
}

export default defineConfig(({ command }) => ({
  plugins: [
    {
      name: "development-shell",
      apply: "serve",
      transformIndexHtml: () => [{ tag: "script", attrs: { type: "module", src: "/src/dev-shell.ts" }, injectTo: "head" }],
    },
    tanstackRouter({ target: "react", routesDirectory: "src/routes", generatedRouteTree: "src/routeTree.gen.ts" }),
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
  server: {
    host: process.env.OMARCHY_BOT_HOST ?? "127.0.0.1",
    port: 7322,
  },
}));
