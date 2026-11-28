import { defineConfig } from "vite";

// No guessed public domain: Vercel supplies its production hostname on deploy.
const siteUrl =
  process.env.SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : undefined);

export default defineConfig({
  plugins: [
    {
      name: "public-site-metadata",
      transformIndexHtml() {
        if (!siteUrl) return [];
        const base = new URL(siteUrl);
        if (base.protocol !== "https:" && base.protocol !== "http:") {
          throw new Error("SITE_URL must be an HTTP or HTTPS URL");
        }
        return [
          {
            tag: "link",
            attrs: { rel: "canonical", href: new URL("/", base).href },
            injectTo: "head" as const,
          },
          {
            tag: "meta",
            attrs: { property: "og:url", content: new URL("/", base).href },
            injectTo: "head" as const,
          },
        ];
      },
    },
  ],
});
