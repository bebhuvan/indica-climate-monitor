// Monitor-owned city ingest: fetch Open-Meteo (ERA5) daily weather for every city
// in data/cities-150.json, aggregate to the compact dashboard JSON, write
// public/data/cities/<id>.json + src/data/cities-index.json.
//
// Decoupled from the main Indica repo. Polite to Open-Meteo: sequential with a
// delay, resumable (skips cities already written unless FORCE=1), retries on 429.
//
//   FORCE=1 node scripts/ingest-cities.mjs   # re-fetch everything

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { setGlobalDispatcher, Agent } from "undici";
import { aggregateCity, indexEntry } from "./lib/aggregate-city.mjs";

// Many VPN exit nodes route IPv4 but black-hole IPv6 (AAAA connects hang to a 10s
// timeout). Node's fetch (undici) otherwise stalls on IPv6 and the run silently makes
// no progress — dns "ipv4first" does NOT fix it, undici ignores it. Forcing the socket
// connect family to 4 is the reliable fix.
setGlobalDispatcher(new Agent({ connect: { family: 4 } }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CITIES = JSON.parse(readFileSync(join(ROOT, "data", "cities-150.json"), "utf8"));
const CITY_OUT = join(ROOT, "public", "data", "cities");
const INDEX_OUT = join(ROOT, "src", "data", "cities-index.json");
mkdirSync(CITY_OUT, { recursive: true });

const FORCE = !!process.env.FORCE;
// Open-Meteo weights long historical requests heavily (76yr × 4 vars per city), so
// even CONC=2 fills the per-minute weight window and trips 429s. Default to a single
// patient worker that throttles between cities — slower but ~zero failures and it
// never gets the IP flagged. Bump CONC after an IP swap if you're in a hurry.
const CONC = Number(process.env.CONC || 1);
// Gap between a worker's requests, so we never fill the per-minute weight window.
const THROTTLE_MS = Number(process.env.THROTTLE_MS || 9000);
// How many times to re-queue a rate-limited city before giving up on it entirely.
const MAX_REQUEUE = Number(process.env.MAX_REQUEUE || 6);
// Only the variables the aggregator consumes — keeps each 1950+ daily payload light.
const VARS = ["temperature_2m_mean", "temperature_2m_max", "precipitation_sum", "apparent_temperature_max"];
const SRC_URL = "https://open-meteo.com/en/docs/historical-weather-api";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function endDate() {
  const d = new Date(Date.now() - 6 * 864e5); // ~6 days back (ERA5 latency)
  return d.toISOString().slice(0, 10);
}

async function fetchCity(city, end) {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${city.lat}&longitude=${city.lon}` +
    `&start_date=1950-01-01&end_date=${end}&daily=${VARS.join(",")}&timezone=Asia%2FKolkata&models=era5&cell_selection=land`;
  const backoff = [15000, 30000, 60000, 90000, 120000, 150000]; // wait out the per-minute window
  // jitter so concurrent workers don't retry in lockstep (thundering herd)
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

const end = endDate();
let ok = 0, skip = 0, fail = 0, done = 0;

// Returns: "skip" (already on disk, no fetch), "done" (fetched ok / hard fail),
// or "requeue" (rate-limited, retry later). Worker only throttles after a real fetch.
async function processCity(job) {
  const city = job.c;
  const outPath = join(CITY_OUT, `${city.id}.json`);
  if (!FORCE && existsSync(outPath)) { skip++; return "skip"; }
  const tag = `(${city.name})`;
  try {
    const json = await fetchCity(city, end);
    const t = json.daily.time;
    const rows = t.map((date, k) => {
      const r = { date };
      for (const v of VARS) r[v] = json.daily[v]?.[k] ?? null;
      return r;
    });
    const out = aggregateCity({
      id: city.id, name: city.name, region: city.region, lat: city.lat, lon: city.lon,
      elevation: json.elevation ?? null, sourceUrl: SRC_URL, endDate: t[t.length - 1],
    }, rows);
    if (!out) throw new Error("no usable rows");
    writeFileSync(outPath, JSON.stringify(out));
    ok++;
    const left = CITIES.length - readdirSync(CITY_OUT).filter((f) => f.endsWith(".json")).length;
    console.log(`[cities] ${tag} ok · ${out.recordStart}-${out.latestYear} · anomaly ${out.stats.latestAnomaly} · ${left} left`);
    return "done";
  } catch (e) {
    // Rate-limit exhaustion is transient — re-queue (up to MAX_REQUEUE) so a single
    // unattended run eventually completes instead of dropping the city.
    if (e.rateLimited && (job.tries || 0) < MAX_REQUEUE) {
      job.tries = (job.tries || 0) + 1;
      console.error(`[cities] ${tag} rate-limited — re-queued (attempt ${job.tries}/${MAX_REQUEUE})`);
      return "requeue";
    }
    fail++;
    console.error(`[cities] ${tag} FAILED: ${e.message}`);
    return "done";
  }
}

// concurrent worker pool with throttle + re-queue. Throttle only after a real network
// fetch — skipping already-done cities must be instant, or a restart wastes minutes.
const queue = CITIES.map((c, i) => ({ c, i, tries: 0 }));
async function worker() {
  let job;
  while ((job = queue.shift())) {
    const status = await processCity(job);
    if (status === "requeue") queue.push(job);   // retry rate-limited city at the back
    if (status !== "skip" && queue.length) await sleep(THROTTLE_MS);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

// Rebuild index from everything currently on disk (covers skipped + fresh).
const index = readdirSync(CITY_OUT).filter((f) => f.endsWith(".json"))
  .map((f) => indexEntry(JSON.parse(readFileSync(join(CITY_OUT, f), "utf8"))))
  .sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(INDEX_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), cities: index }, null, 2));

console.log(`[cities] done — ${ok} fetched, ${skip} skipped, ${fail} failed; index has ${index.length} cities.`);
