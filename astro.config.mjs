// @ts-check
import { defineConfig } from "astro/config";

// India Climate Monitor — static build, deployed to climate.thisindianlife.today.
// Purely static: data is pre-baked by scripts/aggregate.mjs at build time, and a
// weekly cron re-runs ingest + aggregate + deploy to keep it a live "monitor".
export default defineConfig({
  site: "https://climate.thisindianlife.today",
  trailingSlash: "always",
  build: { format: "directory" },
});
