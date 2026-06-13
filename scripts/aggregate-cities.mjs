// India Climate Monitor — per-city daily aggregator.
//
// Reads the 38 Open-Meteo (ERA5-backed) daily city tables in ../data/series and
// compresses each ~9 MB / 31k-row file into a compact (~40-80 KB) JSON the browser
// fetches on demand. This is the granular layer behind the city dashboard:
//
//   • climatology band  — 1991-2020 day-of-year mean + p10/p90 (the "normal")
//   • current + last year overlay — daily mean temp, to show this year vs normal
//   • annual anomaly     — each city's own warming line (vs its 1991-2020 mean)
//   • monthly anomaly    — year × month grid for the heatmap
//   • extremes & counts  — hottest day, 40°C+ days per year, etc.
//
// Output: public/data/cities/<id>.json  +  src/data/cities-index.json

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SERIES_DIR = join(ROOT, "..", "data", "series");
const CITY_OUT = join(ROOT, "public", "data", "cities");
const INDEX_OUT = join(ROOT, "src", "data", "cities-index.json");

const BASE_START = 1991, BASE_END = 2020;
const HOT_THRESHOLD = 40; // °C daily max — heatwave-ish for most Indian cities
// ERA5's pre-1950 back-extension is the lower-quality "preliminary" version, so we
// start the city records at 1950 to avoid spurious early readings.
const DATA_START = 1950;

// Region grouping for the selector (by city id).
const REGION = {
  delhi: "North", jaipur: "North", jodhpur: "North", lucknow: "North",
  varanasi: "North", chandigarh: "North", amritsar: "North", dehradun: "North",
  bikaner: "North", gwalior: "North",
  srinagar: "Himalaya", shimla: "Himalaya", leh: "Himalaya",
  bengaluru: "South", chennai: "South", hyderabad: "South", coimbatore: "South",
  madurai: "South", kochi: "South", thiruvananthapuram: "South",
  visakhapatnam: "South", vijayawada: "South",
  mumbai: "West", pune: "West", surat: "West", ahmedabad: "West",
  bhopal: "Central", indore: "Central", nagpur: "Central", raipur: "Central",
  kolkata: "East", patna: "East", ranchi: "East", bhubaneswar: "East",
  guwahati: "Northeast", shillong: "Northeast", imphal: "Northeast", agartala: "Northeast",
};

const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]; // non-leap day-of-year
function dayOfYear(month, day) {
  if (month === 2 && day === 29) return null; // drop leap day to keep 365 slots
  return CUM[month - 1] + day;
}
const round = (x, n = 1) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n);
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const files = readdirSync(SERIES_DIR).filter((f) => /^open-meteo\.IN\..+\.daily\.json$/.test(f));
mkdirSync(CITY_OUT, { recursive: true });

const index = [];

for (const file of files) {
  const doc = JSON.parse(readFileSync(join(SERIES_DIR, file), "utf8"));
  const id = doc.geography.id;
  const rows = doc.rows || [];

  // Parse rows into typed records. We deliberately do NOT reconstruct a missing
  // daily mean from (max+min)/2 — the midpoint warm-biases the mean and corrupts
  // the early record. Only the true ERA5 daily mean is used.
  const recs = [];
  for (const r of rows) {
    const [y, m, d] = r.date.split("-").map(Number);
    if (y < DATA_START) continue;
    const mean = r.temperature_2m_mean;
    recs.push({
      y, m, d, doy: dayOfYear(m, d),
      mean: mean == null ? null : Number(mean),
      max: r.temperature_2m_max == null ? null : Number(r.temperature_2m_max),
      precip: r.precipitation_sum == null ? null : Number(r.precipitation_sum),
      appMax: r.apparent_temperature_max == null ? null : Number(r.apparent_temperature_max),
    });
  }

  const years = [...new Set(recs.map((r) => r.y))].sort((a, b) => a - b);
  const latestYear = years[years.length - 1];
  const prevYear = latestYear - 1;

  // --- Climatology band (1991-2020) by day-of-year, smoothed over a ±7-day window
  const byDoy = new Map(); // doy -> [means over baseline years]
  for (const r of recs) {
    if (r.doy == null || r.mean == null || r.y < BASE_START || r.y > BASE_END) continue;
    if (!byDoy.has(r.doy)) byDoy.set(r.doy, []);
    byDoy.get(r.doy).push(r.mean);
  }
  const clim = [];
  for (let doy = 1; doy <= 365; doy++) {
    const pool = [];
    for (let w = -7; w <= 7; w++) {
      let dd = doy + w;
      if (dd < 1) dd += 365; else if (dd > 365) dd -= 365;
      const arr = byDoy.get(dd);
      if (arr) pool.push(...arr);
    }
    if (!pool.length) { clim.push(null); continue; }
    pool.sort((a, b) => a - b);
    clim.push({
      mean: round(pool.reduce((s, v) => s + v, 0) / pool.length),
      p10: round(quantile(pool, 0.1)),
      p90: round(quantile(pool, 0.9)),
    });
  }

  // --- Current + previous year daily-mean overlay (by doy)
  const yearLine = (yr) => {
    const out = new Array(365).fill(null);
    for (const r of recs) {
      if (r.y === yr && r.doy != null && r.mean != null) out[r.doy - 1] = round(r.mean);
    }
    return out;
  };

  // --- Annual mean anomaly (city's own warming line)
  const annByYear = new Map();
  for (const r of recs) {
    if (r.mean == null) continue;
    if (!annByYear.has(r.y)) annByYear.set(r.y, []);
    annByYear.get(r.y).push(r.mean);
  }
  const annualMean = new Map();
  for (const [yr, arr] of annByYear) {
    if (arr.length >= 350) annualMean.set(yr, arr.reduce((s, v) => s + v, 0) / arr.length);
  }
  const baseAnnual = [...annualMean.entries()].filter(([y]) => y >= BASE_START && y <= BASE_END).map(([, v]) => v);
  const annualBaseline = baseAnnual.reduce((s, v) => s + v, 0) / baseAnnual.length;
  const annual = [...annualMean.entries()].sort((a, b) => a[0] - b[0])
    .map(([yr, v]) => ({ year: yr, value: round(v - annualBaseline, 2) }));

  // --- Per-year weekly means (52 buckets) for the "every year" spaghetti
  const weeklyByYear = new Map();
  for (const r of recs) {
    if (r.doy == null || r.mean == null) continue;
    const wk = Math.min(51, Math.floor((r.doy - 1) / 7));
    let arr = weeklyByYear.get(r.y);
    if (!arr) { arr = Array.from({ length: 52 }, () => []); weeklyByYear.set(r.y, arr); }
    arr[wk].push(r.mean);
  }
  const spaghettiYears = years.filter((y) => weeklyByYear.has(y));
  const weeklySeries = spaghettiYears.map((y) =>
    weeklyByYear.get(y).map((b) => (b.length ? round(b.reduce((s, v) => s + v, 0) / b.length, 1) : null))
  );

  // --- Monthly anomaly grid (year × month) vs 1991-2020 monthly normals
  const mSum = {}; // `${y}-${m}` -> {s,n}
  for (const r of recs) {
    if (r.mean == null) continue;
    const k = `${r.y}-${r.m}`;
    (mSum[k] ??= { s: 0, n: 0 });
    mSum[k].s += r.mean; mSum[k].n++;
  }
  const monthMean = {};
  for (const k in mSum) monthMean[k] = mSum[k].s / mSum[k].n;
  const monthNormal = [];
  for (let m = 1; m <= 12; m++) {
    const vals = [];
    for (let yr = BASE_START; yr <= BASE_END; yr++) if (monthMean[`${yr}-${m}`] != null) vals.push(monthMean[`${yr}-${m}`]);
    monthNormal[m] = vals.reduce((s, v) => s + v, 0) / vals.length;
  }
  const monthlyYears = years.filter((yr) => yr >= 1950); // grid from 1950 keeps it compact
  const monthlyGrid = monthlyYears.map((yr) =>
    Array.from({ length: 12 }, (_, i) => {
      const v = monthMean[`${yr}-${i + 1}`];
      return v == null ? null : round(v - monthNormal[i + 1], 1);
    })
  );

  // --- Extremes & counts
  let hottest = { value: -Infinity, date: null };
  for (const r of recs) if (r.max != null && r.max > hottest.value) hottest = { value: round(r.max), date: `${r.y}-${pad(r.m)}-${pad(r.d)}` };
  const hotDaysByYear = new Map();
  for (const r of recs) {
    if (r.max == null) continue;
    if (!hotDaysByYear.has(r.y)) hotDaysByYear.set(r.y, 0);
    if (r.max >= HOT_THRESHOLD) hotDaysByYear.set(r.y, hotDaysByYear.get(r.y) + 1);
  }
  const hotDays = [...hotDaysByYear.entries()].filter(([y]) => annualMean.has(y))
    .sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year, count }));
  const hotBase = hotDays.filter((h) => h.year >= BASE_START && h.year <= BASE_END);
  const hotBaseAvg = hotBase.length ? hotBase.reduce((s, h) => s + h.count, 0) / hotBase.length : null;
  const hotRecent = hotDays.filter((h) => h.year >= latestYear - 9);
  const hotRecentAvg = hotRecent.length ? hotRecent.reduce((s, h) => s + h.count, 0) / hotRecent.length : null;

  // --- Humid heat: "feels like" danger days (apparent temperature max)
  const dangerByYear = new Map(); // y -> {d40,d45,n}
  for (const r of recs) {
    if (r.appMax == null) continue;
    let o = dangerByYear.get(r.y); if (!o) { o = { d40: 0, d45: 0, n: 0 }; dangerByYear.set(r.y, o); }
    o.n++; if (r.appMax >= 40) o.d40++; if (r.appMax >= 45) o.d45++;
  }
  const humidHeat = [...dangerByYear.entries()].filter(([, o]) => o.n >= 350)
    .sort((a, b) => a[0] - b[0]).map(([year, o]) => ({ year, d40: o.d40, d45: o.d45 }));

  // --- Rainfall: monsoon (JJAS) total, rainy days, heavy-downpour days
  const rainByYear = new Map();
  for (const r of recs) {
    if (r.precip == null) continue;
    let o = rainByYear.get(r.y); if (!o) { o = { total: 0, monsoon: 0, wet: 0, heavy: 0, vheavy: 0, n: 0 }; rainByYear.set(r.y, o); }
    o.n++; o.total += r.precip; if (r.m >= 6 && r.m <= 9) o.monsoon += r.precip;
    if (r.precip >= 1) o.wet++; if (r.precip >= 50) o.heavy++; if (r.precip >= 100) o.vheavy++;
  }
  const rainfall = [...rainByYear.entries()].filter(([, o]) => o.n >= 350)
    .sort((a, b) => a[0] - b[0])
    .map(([year, o]) => ({ year, total: Math.round(o.total), monsoon: Math.round(o.monsoon), wet: o.wet, heavy: o.heavy, vheavy: o.vheavy }));

  const latestAnomaly = annual.length ? annual[annual.length - 1].value : null;

  const out = {
    id,
    name: doc.geography.name,
    region: REGION[id] || "Other",
    lat: doc.geography.latitude,
    lon: doc.geography.longitude,
    elevation: doc.metadata?.elevation ?? null,
    recordStart: years[0],
    latestYear,
    latestDate: doc.metadata?.endDate ?? null,
    baseline: `${BASE_START}-${BASE_END}`,
    source: { name: "Open-Meteo (ERA5)", url: doc.sourceUrl },
    stats: {
      latestAnomaly,
      hottestDay: hottest.value === -Infinity ? null : hottest,
      hotThreshold: HOT_THRESHOLD,
      hotDaysBaselineAvg: hotBaseAvg == null ? null : Math.round(hotBaseAvg),
      hotDaysRecentAvg: hotRecentAvg == null ? null : Math.round(hotRecentAvg),
    },
    clim,                     // 365 × {mean,p10,p90}
    currentYear: { year: latestYear, daily: yearLine(latestYear) },
    previousYear: { year: prevYear, daily: yearLine(prevYear) },
    annual,                   // [{year, value}]
    hotDays,                  // [{year, count}]
    monthly: { years: monthlyYears, grid: monthlyGrid },
    weekly: { years: spaghettiYears, series: weeklySeries }, // per-year 52-week curves
    humidHeat,                // [{year, d40, d45}]
    rainfall,                 // [{year, total, monsoon, wet, heavy, vheavy}]
  };

  writeFileSync(join(CITY_OUT, `${id}.json`), JSON.stringify(out));
  index.push({
    id, name: out.name, region: out.region, lat: out.lat, lon: out.lon,
    latestAnomaly, latestYear,
  });
}

function pad(n) { return String(n).padStart(2, "0"); }

index.sort((a, b) => a.name.localeCompare(b.name));
mkdirSync(dirname(INDEX_OUT), { recursive: true });
writeFileSync(INDEX_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), cities: index }, null, 2));

console.log(`[aggregate-cities] ${index.length} cities written to public/data/cities/ + index.`);
