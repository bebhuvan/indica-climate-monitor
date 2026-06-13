// CMIP6 downscaled climate projections (Open-Meteo Climate API) → "your city to 2050".
// Second enrichment pass: for each city already written by ingest-cities.mjs, fetch
// the 7 HighResMIP models 1991-2050, aggregate to an annual multi-model anomaly band
// (vs the model 1991-2020 baseline, so it lines up with the observed anomaly line),
// and merge a `projection` field back into public/data/cities/<id>.json.
//
// HighResMIP future runs follow a HIGH-emissions pathway — the UI labels it as such
// and shows the multi-model spread, not a single line. Run AFTER ingest-cities.
//
//   FORCE=1 node scripts/ingest-cmip6.mjs

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setGlobalDispatcher, Agent } from "undici";
import { round } from "./lib/aggregate-city.mjs";

// VPN nodes often black-hole IPv6 → fetch stalls. Force socket connect to IPv4. (See ingest-cities.)
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CITIES = JSON.parse(readFileSync(join(ROOT, "data", "cities-150.json"), "utf8"));
const CITY_OUT = join(ROOT, "public", "data", "cities");

const FORCE = !!process.env.FORCE;
// Patient like ingest-cities: the climate API weight-limits these 7-model requests too.
const CONC = Number(process.env.CONC || 1);
const THROTTLE_MS = Number(process.env.THROTTLE_MS || 9000);
const MAX_REQUEUE = Number(process.env.MAX_REQUEUE || 6);
const MODELS = ["CMCC_CM2_VHR4", "FGOALS_f3_H", "HiRAM_SIT_HR", "MRI_AGCM3_2_S", "EC_Earth3P_HR", "MPI_ESM1_2_XR", "NICAM16_8S"];
const BASE_START = 1991, BASE_END = 2020;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchClimate(city) {
  const url = `https://climate-api.open-meteo.com/v1/climate?latitude=${city.lat}&longitude=${city.lon}` +
    `&start_date=1991-01-01&end_date=2050-12-31&models=${MODELS.join(",")}&daily=temperature_2m_mean`;
  const backoff = [15000, 30000, 60000, 90000, 120000, 150000];
  const wait = (a) => backoff[Math.min(a, backoff.length - 1)] + Math.floor(Math.random() * 15000);
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    let res;
    try { res = await fetch(url); }
    catch { await sleep(wait(attempt)); continue; }
    if (res.status === 429 || res.status >= 500) { await sleep(wait(attempt)); continue; }
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json.reason || `HTTP ${res.status}`);
    return json;
  }
  const e = new Error("rate-limited after retries"); e.rateLimited = true; throw e;
}

// per-model annual mean → anomaly vs that model's 1991-2020 mean
function modelAnnualAnomaly(time, vals) {
  const byYear = new Map();
  for (let i = 0; i < time.length; i++) {
    const v = vals[i]; if (v == null) continue;
    const yr = +time[i].slice(0, 4);
    (byYear.get(yr) ?? byYear.set(yr, []).get(yr)).push(v);
  }
  const annual = new Map();
  for (const [yr, arr] of byYear) if (arr.length >= 300) annual.set(yr, arr.reduce((s, v) => s + v, 0) / arr.length);
  const base = [...annual.entries()].filter(([y]) => y >= BASE_START && y <= BASE_END).map(([, v]) => v);
  if (base.length < 20) return null;
  const baseline = base.reduce((s, v) => s + v, 0) / base.length;
  const out = new Map();
  for (const [yr, v] of annual) out.set(yr, v - baseline);
  return out;
}

let ok = 0, skip = 0, fail = 0, done = 0;

async function processCity(job) {
  const city = job.c;
  const outPath = join(CITY_OUT, `${city.id}.json`);
  if (!existsSync(outPath)) { skip++; return "skip"; }     // city ingest must have run
  const cityDoc = JSON.parse(readFileSync(outPath, "utf8"));
  if (!FORCE && cityDoc.projection) { skip++; return "skip"; }
  const tag = `(${city.name})`;
  try {
    const json = await fetchClimate(city);
    const time = json.daily.time;
    const perModel = [];
    for (const m of MODELS) {
      const vals = json.daily[`temperature_2m_mean_${m}`];
      if (!vals) continue;
      const anom = modelAnnualAnomaly(time, vals);
      if (anom) perModel.push(anom);
    }
    if (perModel.length < 3) throw new Error(`only ${perModel.length} usable models`);
    const years = [];
    for (let y = BASE_START; y <= 2050; y++) years.push(y);
    const annual = years.map((y) => {
      const vs = perModel.map((m) => m.get(y)).filter((v) => v != null);
      if (!vs.length) return null;
      return { year: y, mean: round(vs.reduce((s, v) => s + v, 0) / vs.length, 2), lo: round(Math.min(...vs), 2), hi: round(Math.max(...vs), 2) };
    }).filter(Boolean);
    cityDoc.projection = {
      baseline: `${BASE_START}-${BASE_END}`,
      scenario: "high emissions (CMIP6 HighResMIP)",
      models: perModel.length,
      source: { name: "Open-Meteo — CMIP6 downscaled", url: "https://open-meteo.com/en/docs/climate-api" },
      annual,
    };
    writeFileSync(outPath, JSON.stringify(cityDoc));
    ok++;
    const last = annual[annual.length - 1];
    console.log(`[cmip6] ${tag} ok · ${perModel.length} models · 2050 ≈ +${last.mean}°C (${last.lo}–${last.hi})`);
    return "done";
  } catch (e) {
    if (e.rateLimited && (job.tries || 0) < MAX_REQUEUE) {
      job.tries = (job.tries || 0) + 1;
      console.error(`[cmip6] ${tag} rate-limited — re-queued (attempt ${job.tries}/${MAX_REQUEUE})`);
      return "requeue";
    }
    fail++;
    console.error(`[cmip6] ${tag} FAILED: ${e.message}`);
    return "done";
  }
}

const queue = CITIES.map((c) => ({ c, tries: 0 }));
async function worker() {
  let job;
  while ((job = queue.shift())) {
    const status = await processCity(job);
    if (status === "requeue") queue.push(job);
    if (status !== "skip" && queue.length) await sleep(THROTTLE_MS);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
console.log(`[cmip6] done — ${ok} projected, ${skip} skipped, ${fail} failed.`);
