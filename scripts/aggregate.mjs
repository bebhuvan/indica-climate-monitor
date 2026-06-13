// India Climate Monitor — national data aggregator.
//
// Reads the already-ingested national temperature series from the parent Indica
// repo (../data/series) and compresses them into one small JSON the page ships.
// Run by `npm run aggregate` (and automatically before dev/build).
//
// Sources:
//   Berkeley Earth   — India land-temperature anomaly, annual, 1817+ (long record)
//   ERA5 / Copernicus — All-India 2m-temp anomaly vs 1991-2020, annual, 1940+ (live)

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SERIES_DIR = join(ROOT, "..", "data", "series");
const OUT = join(ROOT, "src", "data", "national.json");

function readSeries(file) {
  const path = join(SERIES_DIR, file);
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const obs = (doc.observations || doc.rows || [])
    .map((o) => ({ year: Number(o.date), value: Number(o.value) }))
    .filter((o) => Number.isFinite(o.year) && Number.isFinite(o.value));
  return { doc, obs };
}

const BERKELEY_FILE = "berkeley.IN.climate.berkeley.temp_anomaly.json";
const ERA5_FILE = "era5.IN.climate.era5.region.all_india.temp_anomaly_1991_2020.json";

const berkeley = readSeries(BERKELEY_FILE);
const era5 = readSeries(ERA5_FILE);

// --- Live ranking, computed from the modern ERA5 record -----------------------
const era5Sorted = [...era5.obs].sort((a, b) => b.value - a.value);
const latest = era5.obs[era5.obs.length - 1];
const rank = era5Sorted.findIndex((o) => o.year === latest.year) + 1;
const warmest = era5Sorted[0];

// Top-10 warmest years, and how many of them fall in the last 15 years — the
// "the warmest years are all recent" framing these dashboards lead with.
const top10 = era5Sorted.slice(0, 10).map((o) => o.year);
const recentCutoff = latest.year - 14;
const top10RecentCount = top10.filter((y) => y >= recentCutoff).length;

// --- Decadal means (ERA5) -----------------------------------------------------
const byDecade = new Map();
for (const o of era5.obs) {
  const d = Math.floor(o.year / 10) * 10;
  if (!byDecade.has(d)) byDecade.set(d, []);
  byDecade.get(d).push(o.value);
}
const decadal = [...byDecade.entries()]
  .map(([decade, vals]) => ({
    decade,
    label: `${decade}s`,
    mean: round(vals.reduce((s, v) => s + v, 0) / vals.length, 2),
    years: vals.length,
  }))
  .sort((a, b) => a.decade - b.decade);

// Warming since the start of the record: mean of first full decade vs last full decade.
const firstDecade = decadal.find((d) => d.years >= 10);
const lastDecade = [...decadal].reverse().find((d) => d.years >= 10);
const warmingSinceStart = round(lastDecade.mean - firstDecade.mean, 2);

function round(x, n = 3) {
  const f = 10 ** n;
  return Math.round(x * f) / f;
}

const out = {
  generatedAt: new Date().toISOString(),
  sources: {
    berkeley: {
      name: "Berkeley Earth",
      label: berkeley.doc.title,
      url: berkeley.doc.sourceUrl,
      unit: berkeley.doc.unit,
      baseline: berkeley.doc.metadata?.baselinePeriod ?? "1951-1980",
    },
    era5: {
      name: "ERA5 / Copernicus",
      label: era5.doc.title,
      url: era5.doc.sourceUrl,
      unit: era5.doc.unit,
      baseline: "1991-2020",
    },
  },
  latest: {
    year: latest.year,
    anomaly: round(latest.value, 2),
    rank, // 1 = warmest on the ERA5 record
    ofYears: era5.obs.length,
  },
  warmest: { year: warmest.year, anomaly: round(warmest.value, 2) },
  top10Warmest: top10,
  top10RecentCount,
  recentWindowStart: recentCutoff,
  warmingSinceStart,
  firstDecade,
  lastDecade,
  decadal,
  // Full series for the charts. Kept tiny (annual): ~170 + ~86 points.
  berkeley: berkeley.obs.map((o) => ({ year: o.year, value: round(o.value, 3) })),
  era5: era5.obs.map((o) => ({ year: o.year, value: round(o.value, 3) })),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2));

// --- State warming choropleth (static, from the main repo's ERA5 state file) -----
const STATES_OUT = join(ROOT, "src", "data", "states.json");
const stateDoc = JSON.parse(readFileSync(join(SERIES_DIR, "era5.IN.state_warming.json"), "utf8"));
const states = {
  viewBox: stateDoc.viewBox,
  min: round(stateDoc.min, 2),
  max: round(stateDoc.max, 2),
  baseline: stateDoc.metadata?.baseline ?? "1951-1980 mean",
  recent: stateDoc.metadata?.recent ?? "2015-2024 mean",
  source: { name: "ERA5 / Copernicus", url: stateDoc.sourceUrl },
  regions: stateDoc.regions
    .map((r) => ({ name: r.name, value: round(r.value, 2), path: r.path }))
    .sort((a, b) => b.value - a.value),
};
writeFileSync(STATES_OUT, JSON.stringify(states));

// --- ENSO vs monsoon (NOAA ONI joined with IMD all-India Jun-Sep rainfall) -------
const ENSO_OUT = join(ROOT, "src", "data", "enso.json");
const ensoDoc = JSON.parse(readFileSync(join(SERIES_DIR, "derived.IN.climate.enso_imd_monsoon_join.json"), "utf8"));
const ensoRows = (ensoDoc.rows || ensoDoc.observations || [])
  .filter((r) => r.region_id === "all_india" && r.departure_jun_sep_pct != null)
  .map((r) => ({
    year: r.year,
    departure: round(r.departure_jun_sep_pct, 1),
    oni: round(r.oni_monsoon_mean_c, 2),
    phase: r.official_enso_active_during_monsoon, // "El Nino" | "La Nina" | "Neutral"
  }))
  .sort((a, b) => a.year - b.year);
const phaseRows = (p) => ensoRows.filter((r) => r.phase === p);
const meanDep = (rows) => (rows.length ? round(rows.reduce((s, r) => s + r.departure, 0) / rows.length, 1) : null);
// Observed Niño-3.4 / ONI timeline (3-month running SST anomaly), 1990+.
const SEAS = ["DJF", "JFM", "FMA", "MAM", "AMJ", "MJJ", "JJA", "JAS", "ASO", "SON", "OND", "NDJ"];
const oniDoc = JSON.parse(readFileSync(join(SERIES_DIR, "noaa-enso.global.oni_seasonal.json"), "utf8"));
const oniAll = (oniDoc.observations || oniDoc.rows || []);
const nino34 = oniAll
  .filter((r) => r.year >= 1990 && r.oni_anomaly_c != null)
  .map((r) => ({ t: round(r.year + SEAS.indexOf(r.season) / 12, 3), v: round(r.oni_anomaly_c, 2) }));
const oniLast = oniAll[oniAll.length - 1];
const current = {
  season: oniLast.season, year: oniLast.year, v: round(oniLast.oni_anomaly_c, 2),
  phase: oniLast.phase, strength: oniLast.strength,
  // 3-season trend direction
  trend: round(oniLast.oni_anomaly_c - oniAll[oniAll.length - 4].oni_anomaly_c, 2),
};

const enso = {
  source: { name: "NOAA CPC — Oceanic Niño Index", url: "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt" },
  monsoon: "IMD all-India June–September rainfall departure from normal",
  asOf: oniDoc.fetchedAt,
  current,
  nino34,
  rows: ensoRows,
  elNino: { mean: meanDep(phaseRows("El Nino")), n: phaseRows("El Nino").length },
  laNina: { mean: meanDep(phaseRows("La Nina")), n: phaseRows("La Nina").length },
  neutral: { mean: meanDep(phaseRows("Neutral")), n: phaseRows("Neutral").length },
};
writeFileSync(ENSO_OUT, JSON.stringify(enso));

console.log(
  `[aggregate] national.json written — ERA5 ${era5.obs[0].year}-${latest.year} ` +
    `(latest ${latest.year}: ${out.latest.anomaly >= 0 ? "+" : ""}${out.latest.anomaly}°C, ` +
    `#${rank} of ${era5.obs.length}); Berkeley ${berkeley.obs[0].year}-${berkeley.obs[berkeley.obs.length - 1].year}; ` +
    `${states.regions.length} states (${states.min}–${states.max}°C).`
);
