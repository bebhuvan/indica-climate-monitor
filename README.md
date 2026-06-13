# India Climate Monitor

An auto-updating temperature dashboard for India — the local equivalent of the
Reuters Climate Monitor / The Climate Brink dashboard, built on the same data
backbone (ERA5 / Copernicus + Berkeley Earth) that already feeds Indica.

Standalone Astro mini-site, deployed to `climate.thisindianlife.today`.
Kept out of the main Indica repo's git for now (see root `.gitignore`).

## Data

Reads pre-ingested series from the parent repo's `../data/series/`:

- **Berkeley Earth** — India land-temperature anomaly, 1817–2020 (the long record).
- **ERA5 / Copernicus** — All-India 2m-temperature anomaly vs 1991–2020, 1940–present
  (the modern, regularly-refreshed record used for the live ranking).

`scripts/aggregate.mjs` compresses these into `src/data/national.json` at build time.
Nothing is fetched in the browser; the page is fully static.

## Milestones

- **M1 (this):** National page — warming stripes, modern anomaly line, live "Nth-warmest-year" ranking.
- M2: city selector (38 cities, daily-vs-climatology band, monthly heatmap).
- M3: state/region warming map.
- M4: weekly cron (re-ingest → aggregate → deploy) + methodology page.

## Commands

```bash
npm install
npm run dev       # aggregate + astro dev
npm run build     # aggregate + static build to ./dist
```
