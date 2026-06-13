// National CMIP6 projection for the "your city to 2050" band, from the World Bank
// Climate Change Knowledge Portal (CCKP). Keyless, clean JSON, CC BY 4.0.
//
// CCKP serves country/admin-level CMIP6 — NOT arbitrary city points (a point query
// returns empty). So this is an INDIA-SCALE projection: the dashboard overlays it on
// every city's trend as regional context, with a caveat explainer. At CMIP6's ~25km
// model resolution a city's future essentially tracks its region's, so this is the
// honest resolution, not a per-city forecast. State-level is a later upgrade.
//
// Band = the range between a mid-emissions (SSP2-4.5) and high-emissions (SSP5-8.5)
// pathway, ensemble median, as an anomaly vs the 1991-2014 baseline (the slice of the
// historical run that overlaps our cities' 1991-2020 normal — close enough; noted).
//
//   node scripts/ingest-cmip6-cckp.mjs

import { setGlobalDispatcher, Agent } from "undici";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

setGlobalDispatcher(new Agent({ connect: { family: 4 } })); // VPN IPv6 black-hole guard

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "src", "data", "projection.json");
const BASE = "https://cckpapi.worldbank.org/cckp/v1";
const BASE_START = 1991, BASE_END = 2014, END_YEAR = 2050;

function url(scenario, period) {
  const slug = ["cmip6-x0.25", "timeseries", "tas", "timeseries", "annual",
    period, "median", scenario, "ensemble", "all", "mean"].join("_");
  return `${BASE}/${slug}/IND?_format=json`;
}

async function series(scenario, period) {
  const res = await fetch(url(scenario, period), { headers: { accept: "application/json", "user-agent": "indica-climate-monitor" } });
  if (!res.ok) throw new Error(`CCKP ${scenario} HTTP ${res.status}`);
  const j = await res.json();
  if (j?.metadata?.status !== "success") throw new Error(`CCKP ${scenario} non-success`);
  const out = new Map();
  for (const [stamp, v] of Object.entries(j.data?.IND || {})) {
    const yr = +String(stamp).slice(0, 4);
    if (Number.isFinite(yr) && Number.isFinite(+v)) out.set(yr, +v);
  }
  return out;
}
const round = (x) => Math.round(x * 100) / 100;

const [hist, ssp245, ssp585] = await Promise.all([
  series("historical", "1950-2014"),
  series("ssp245", "2015-2100"),
  series("ssp585", "2015-2100"),
]);

// baseline = mean historical tas over 1991-2014
const baseVals = [];
for (let y = BASE_START; y <= BASE_END; y++) if (hist.has(y)) baseVals.push(hist.get(y));
if (baseVals.length < 20) throw new Error(`thin baseline (${baseVals.length} yrs)`);
const baseline = baseVals.reduce((s, v) => s + v, 0) / baseVals.length;

// per-year band: lo/hi = min/max of the two scenario anomalies, mean = midpoint
const annual = [];
for (let y = 2015; y <= END_YEAR; y++) {
  const a = ssp245.get(y), b = ssp585.get(y);
  if (a == null || b == null) continue;
  const lo = Math.min(a, b) - baseline, hi = Math.max(a, b) - baseline;
  annual.push({ year: y, lo: round(lo), hi: round(hi), mean: round((lo + hi) / 2) });
}

const doc = {
  scope: "India (national, CMIP6 ensemble median)",
  baseline: `${BASE_START}-${BASE_END}`,
  scenarios: { lo: "SSP2-4.5 (intermediate)", hi: "SSP5-8.5 (high emissions)" },
  source: { name: "World Bank Climate Change Knowledge Portal — CMIP6", url: "https://climateknowledgeportal.worldbank.org/" },
  note: "India-scale projection overlaid on each city as regional context; not a city-specific forecast.",
  annual,
};
writeFileSync(OUT, JSON.stringify(doc, null, 2));
const last = annual[annual.length - 1];
console.log(`[cckp] wrote ${annual.length} yrs (2015-${last.year}) · baseline ${baseline.toFixed(2)}°C · 2050 band +${last.lo}–+${last.hi}°C`);
