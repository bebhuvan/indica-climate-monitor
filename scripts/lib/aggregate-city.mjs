// Shared per-city aggregation: turn a city's daily rows into the compact JSON the
// dashboard ships. Used by ingest-cities.mjs (fetch-based, monitor-owned). Keeps the
// climatology band, spaghetti weeks, annual anomaly, monthly grid, extremes, humid
// heat and rainfall in ONE place so the logic never drifts.

const BASE_START = 1991, BASE_END = 2020;
const HOT_THRESHOLD = 40;   // °C daily max
const DATA_START = 1950;    // pre-1950 ERA5 back-extension is unreliable

const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
function dayOfYear(month, day) {
  if (month === 2 && day === 29) return null; // drop leap day → 365 slots
  return CUM[month - 1] + day;
}
export const round = (x, n = 1) =>
  x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** n) / 10 ** n;
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const pad = (n) => String(n).padStart(2, "0");

/**
 * @param meta {id,name,region,lat,lon,elevation,sourceUrl,endDate}
 * @param rows [{date:'YYYY-MM-DD', temperature_2m_mean, temperature_2m_max,
 *              precipitation_sum, apparent_temperature_max}]
 * @returns the compact city object (also suitable for deriving an index entry)
 */
export function aggregateCity(meta, rows) {
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
  if (!recs.length) return null;

  const years = [...new Set(recs.map((r) => r.y))].sort((a, b) => a - b);
  const latestYear = years[years.length - 1];
  const prevYear = latestYear - 1;

  // climatology band (1991-2020) by day-of-year, ±7-day smoothed
  const byDoy = new Map();
  for (const r of recs) {
    if (r.doy == null || r.mean == null || r.y < BASE_START || r.y > BASE_END) continue;
    if (!byDoy.has(r.doy)) byDoy.set(r.doy, []);
    byDoy.get(r.doy).push(r.mean);
  }
  const clim = [];
  for (let doy = 1; doy <= 365; doy++) {
    const pool = [];
    for (let w = -7; w <= 7; w++) {
      let dd = doy + w; if (dd < 1) dd += 365; else if (dd > 365) dd -= 365;
      const arr = byDoy.get(dd); if (arr) pool.push(...arr);
    }
    if (!pool.length) { clim.push(null); continue; }
    pool.sort((a, b) => a - b);
    clim.push({
      mean: round(pool.reduce((s, v) => s + v, 0) / pool.length),
      p10: round(quantile(pool, 0.1)), p90: round(quantile(pool, 0.9)),
    });
  }

  const yearLine = (yr) => {
    const out = new Array(365).fill(null);
    for (const r of recs) if (r.y === yr && r.doy != null && r.mean != null) out[r.doy - 1] = round(r.mean);
    return out;
  };

  // annual mean anomaly (city's own warming line)
  const annByYear = new Map();
  for (const r of recs) { if (r.mean == null) continue; (annByYear.get(r.y) ?? annByYear.set(r.y, []).get(r.y)).push(r.mean); }
  const annualMean = new Map();
  for (const [yr, arr] of annByYear) if (arr.length >= 350) annualMean.set(yr, arr.reduce((s, v) => s + v, 0) / arr.length);
  const baseAnnual = [...annualMean.entries()].filter(([y]) => y >= BASE_START && y <= BASE_END).map(([, v]) => v);
  const annualBaseline = baseAnnual.length ? baseAnnual.reduce((s, v) => s + v, 0) / baseAnnual.length : null;
  const annual = annualBaseline == null ? [] : [...annualMean.entries()].sort((a, b) => a[0] - b[0])
    .map(([yr, v]) => ({ year: yr, value: round(v - annualBaseline, 2) }));

  // per-year weekly means (52 buckets) for the spaghetti
  const weeklyByYear = new Map();
  for (const r of recs) {
    if (r.doy == null || r.mean == null) continue;
    const wk = Math.min(51, Math.floor((r.doy - 1) / 7));
    let arr = weeklyByYear.get(r.y); if (!arr) { arr = Array.from({ length: 52 }, () => []); weeklyByYear.set(r.y, arr); }
    arr[wk].push(r.mean);
  }
  const spaghettiYears = years.filter((y) => weeklyByYear.has(y));
  const weeklySeries = spaghettiYears.map((y) =>
    weeklyByYear.get(y).map((b) => (b.length ? round(b.reduce((s, v) => s + v, 0) / b.length, 1) : null)));

  // monthly anomaly grid
  const mSum = {};
  for (const r of recs) { if (r.mean == null) continue; const k = `${r.y}-${r.m}`; (mSum[k] ??= { s: 0, n: 0 }); mSum[k].s += r.mean; mSum[k].n++; }
  const monthMean = {}; for (const k in mSum) monthMean[k] = mSum[k].s / mSum[k].n;
  const monthNormal = [];
  for (let m = 1; m <= 12; m++) {
    const vals = []; for (let yr = BASE_START; yr <= BASE_END; yr++) if (monthMean[`${yr}-${m}`] != null) vals.push(monthMean[`${yr}-${m}`]);
    monthNormal[m] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  }
  const monthlyYears = years.filter((yr) => yr >= 1950);
  const monthlyGrid = monthlyYears.map((yr) => Array.from({ length: 12 }, (_, i) => {
    const v = monthMean[`${yr}-${i + 1}`]; const nrm = monthNormal[i + 1];
    return v == null || nrm == null ? null : round(v - nrm, 1);
  }));

  // extremes & counts
  let hottest = { value: -Infinity, date: null };
  for (const r of recs) if (r.max != null && r.max > hottest.value) hottest = { value: round(r.max), date: `${r.y}-${pad(r.m)}-${pad(r.d)}` };
  const hotDaysByYear = new Map();
  for (const r of recs) { if (r.max == null) continue; if (!hotDaysByYear.has(r.y)) hotDaysByYear.set(r.y, 0); if (r.max >= HOT_THRESHOLD) hotDaysByYear.set(r.y, hotDaysByYear.get(r.y) + 1); }
  const hotDays = [...hotDaysByYear.entries()].filter(([y]) => annualMean.has(y)).sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year, count }));
  const hotBase = hotDays.filter((h) => h.year >= BASE_START && h.year <= BASE_END);
  const hotBaseAvg = hotBase.length ? hotBase.reduce((s, h) => s + h.count, 0) / hotBase.length : null;
  const hotRecent = hotDays.filter((h) => h.year >= latestYear - 9);
  const hotRecentAvg = hotRecent.length ? hotRecent.reduce((s, h) => s + h.count, 0) / hotRecent.length : null;

  // humid heat
  const dangerByYear = new Map();
  for (const r of recs) { if (r.appMax == null) continue; let o = dangerByYear.get(r.y); if (!o) { o = { d40: 0, d45: 0, n: 0 }; dangerByYear.set(r.y, o); } o.n++; if (r.appMax >= 40) o.d40++; if (r.appMax >= 45) o.d45++; }
  const humidHeat = [...dangerByYear.entries()].filter(([, o]) => o.n >= 350).sort((a, b) => a[0] - b[0]).map(([year, o]) => ({ year, d40: o.d40, d45: o.d45 }));

  // rainfall
  const rainByYear = new Map();
  for (const r of recs) {
    if (r.precip == null) continue;
    let o = rainByYear.get(r.y); if (!o) { o = { total: 0, monsoon: 0, wet: 0, heavy: 0, vheavy: 0, n: 0 }; rainByYear.set(r.y, o); }
    o.n++; o.total += r.precip; if (r.m >= 6 && r.m <= 9) o.monsoon += r.precip;
    if (r.precip >= 1) o.wet++; if (r.precip >= 50) o.heavy++; if (r.precip >= 100) o.vheavy++;
  }
  const rainfall = [...rainByYear.entries()].filter(([, o]) => o.n >= 350).sort((a, b) => a[0] - b[0])
    .map(([year, o]) => ({ year, total: Math.round(o.total), monsoon: Math.round(o.monsoon), wet: o.wet, heavy: o.heavy, vheavy: o.vheavy }));

  const latestAnomaly = annual.length ? annual[annual.length - 1].value : null;

  return {
    id: meta.id, name: meta.name, region: meta.region,
    lat: meta.lat, lon: meta.lon, elevation: meta.elevation ?? null,
    recordStart: years[0], latestYear, latestDate: meta.endDate ?? null,
    baseline: `${BASE_START}-${BASE_END}`,
    source: { name: "Open-Meteo (ERA5)", url: meta.sourceUrl || "https://open-meteo.com/en/docs/historical-weather-api" },
    stats: {
      latestAnomaly,
      hottestDay: hottest.value === -Infinity ? null : hottest,
      hotThreshold: HOT_THRESHOLD,
      hotDaysBaselineAvg: hotBaseAvg == null ? null : Math.round(hotBaseAvg),
      hotDaysRecentAvg: hotRecentAvg == null ? null : Math.round(hotRecentAvg),
    },
    clim,
    currentYear: { year: latestYear, daily: yearLine(latestYear) },
    previousYear: { year: prevYear, daily: yearLine(prevYear) },
    annual, hotDays,
    monthly: { years: monthlyYears, grid: monthlyGrid },
    weekly: { years: spaghettiYears, series: weeklySeries },
    humidHeat, rainfall,
  };
}

export function indexEntry(city) {
  return {
    id: city.id, name: city.name, region: city.region, lat: city.lat, lon: city.lon,
    latestAnomaly: city.stats?.latestAnomaly ?? null, latestYear: city.latestYear,
  };
}
