// Ingest the official NOAA CPC / IRI ENSO Diagnostic Discussion (the monthly
// advisory) — the authoritative current ENSO status + outlook. Run by the weekly
// refresh, NOT by every build (it needs network). Writes src/data/enso-advisory.json.
//
//   https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/ensodisc.shtml

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "src", "data", "enso-advisory.json");
const SRC = "https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/ensodisc.shtml";

const res = await fetch(SRC);
if (!res.ok) throw new Error(`ENSO advisory fetch failed: HTTP ${res.status}`);
const html = await res.text();

const text = html
  .replace(/<[^>]*>/g, " ")
  .replace(/&ntilde;/g, "ñ").replace(/&Ntilde;/g, "Ñ")
  .replace(/&#37;/g, "%").replace(/&deg;/g, "°").replace(/&#176;/g, "°")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();

const grab = (re, i = 1) => { const m = text.match(re); return m ? m[i].trim() : null; };

const status = grab(/((?:Final\s+)?(?:El Niño|La Niña)\s+(?:Advisory|Watch)|ENSO-neutral)/i, 1);
const issued = grab(/issued by\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i, 1)
  || grab(/(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i, 1);
const synopsis = grab(/Synopsis:\s*([^]*?\.)\s+[A-Z]/i, 1) || grab(/Synopsis:\s*([^.]*\.)/i, 1);
const weeklyNino34 = grab(/latest weekly Niño-3\.4 index value was\s*([+-]?\d+(?:\.\d+)?)\s*°?C/i, 1);

const prob = text.match(/(\d+)%\s+chance of (?:a\s+)?(very strong|strong|moderate|weak)?\s*(El Niño|La Niña)\s+during\s+([A-Za-z]+-[A-Za-z]+|[A-Za-z]+)/i);
const forecast = prob
  ? { probability: Number(prob[1]), strength: (prob[2] || "").trim() || null, phase: prob[3], season: prob[4] }
  : null;
const nextUpdate = grab(/next ENSO Diagnostics Discussion is scheduled for\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i, 1);

const out = {
  source: { name: "NOAA CPC / IRI — ENSO Diagnostic Discussion", url: SRC },
  fetchedAt: new Date().toISOString(),
  status,
  issued,
  synopsis,
  weeklyNino34: weeklyNino34 == null ? null : Number(weeklyNino34),
  forecast,
  nextUpdate,
};

writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(`[enso-advisory] ${status ?? "?"} (${issued ?? "?"}) · weekly Niño-3.4 ${out.weeklyNino34 ?? "?"}°C` +
  (forecast ? ` · ${forecast.probability}% ${forecast.strength ?? ""} ${forecast.phase} ${forecast.season}` : ""));
