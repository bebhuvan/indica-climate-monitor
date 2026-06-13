// @ts-check
import { defineConfig } from "astro/config";

// India Climate Monitor — static build, deployed to climate.thisindianlife.today.
// Purely static: data is pre-baked by scripts/aggregate.mjs at build time, and a
// weekly cron re-runs ingest + aggregate + deploy to keep it a live "monitor".
export default defineConfig({
  site: "https://climate.thisindianlife.today",
  trailingSlash: "always",
  build: {
    format: "directory",
    // Inline all CSS into the HTML (total is ~6 KB) so it's never a render-blocking
    // request on the critical path — improves FCP/LCP. HTML brotli-compresses to a
    // few KB anyway, so the inline cost is negligible.
    inlineStylesheets: "always",
  },
});
