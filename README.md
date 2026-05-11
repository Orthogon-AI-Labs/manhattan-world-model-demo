# Manhattan World Model — Demo

Live demo: **https://orthogon-ai-labs.github.io/manhattan-world-model-demo/**

A vector / wireframe world model of Manhattan rendered as an
architectural massing study, surfacing real-estate intelligence:

- 1044 buildings rising from the map at actual story counts
- Lens filters: marketing mode, building status, decision-maker
  status, size, residential type, free-text search
- Timeline slider hides pre-start buildings by quarter
- Right-rail dossier panel: pitch surfaces, performance vs peers,
  supply pressure, decision makers, listing agents

The map is the navigation surface. The dossier is the operating
surface.

## Known limitation (this static snapshot)

The **TARGETS overlay** (top-right mode toggle, yellow-highlighting
of the weakest rentals) requires a live backend call to
`/api/buildings/weak-targets`. This demo is a pure static
deployment of GitHub Pages — no backend is reachable, so toggling
Targets shows zero highlighted projects.

This will be addressed in v2 alongside the CSV→Supabase migration
(see source repo). World mode and every other filter / dossier /
timeline behavior is fully functional here.

## What's in this repo

A **static** snapshot of the pilot prototype:

| File | Purpose |
| --- | --- |
| `index.html` | Entry point. Loads Leaflet, payloads, and the app. |
| `app.js` | The whole prototype (lens, dossier, TARGETS overlay, etc.). |
| `payload.js` | Baked corpus of 916 buildings (rental data). |
| `payload-dev.js` | Baked developer-pipeline overlay. |
| `vendor/leaflet/1.9.4/` | Pinned Leaflet. |
| `bond-ny-logo.png` | Brand mark. |

No build step. No server. Pure static files served by GitHub Pages.

## Where the data comes from

The two baked payload files are produced upstream from:

- A canonical CSV of new-development projects
- A Supabase database of rental-listing intelligence (building,
  listing_snapshot, building_performance_history,
  building_listing_summary, listing_event, pipeline_run)

Cron jobs in the source repo re-bake the payloads when those
inputs change. This demo repo gets snapshot redeploys when the
upstream is updated.

## Source

Source repo (private):
`Orthogon-AI-Labs/orthogon-ai-world-model-customer-bny`
— branch `claude/pensive-cray-f71df5`.

Snapshot point: see the latest commit on this repo for the exact
upstream SHA.
