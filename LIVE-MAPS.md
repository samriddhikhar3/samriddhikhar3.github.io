# Live maps

The site's live, interactive maps: what they are, where the code lives, and how to change them.

| Where | What |
|---|---|
| Home page, top | "My Philadelphia, now" (the `sams-philly` widget): Sam's favorite spots on a live map of every SEPTA bus, trolley and train, plus Indego bike share. Picking a spot lights up the routes, stops and Indego stations within a half-mile walk, greys out the rest, and opens a card with the spot's Google reviews and nearest stops |
| Home page, "Project Update" | A compact version of the DevTracker map beside a short note that links to the project |
| DevTracker project | "Development, live": the 2022 construction hot spots against every building permit from the last 30 days, with a replay |
| TOD Boston project | "The story in one scroll": a scroll-driven map story with live MBTA trains |

## How it fits together

Pages stay plain Quarto. A widget is one line of HTML in a `.qmd` file:

````markdown
```{=html}
<div data-live="sams-philly" data-bleed></div>
```
````

`data-bleed` runs a widget edge to edge across the window, and `data-variant="compact"` gives the DevTracker map its home page version. `_includes/live-loader.html`, which `_quarto.yml` adds to every page, loads `assets/live/main.js` only on pages that have a `data-live` element. Each widget then downloads its code and data when it scrolls near the screen.

- `assets/live/widgets/`: one file per widget (`sams-philly`, `dev-live`, `tod-story`), plus `spot-card.js`, the card for a favorite spot. The TOD story's text lives in `portfolio/1_TOD_Boston/index.qmd`, so it can be edited like any other page text.
- `assets/live/feeds/`: one module per data source.
- `assets/live/lib/` and `assets/live/live.css`: map setup, polling, animation, UI pieces and styles. `lib/routes.js` keeps each SEPTA vehicle on its route.
- `assets/live/config.js`: where the optional Worker lives.

Maps use MapLibre GL JS (loaded from jsDelivr) on OpenFreeMap's Positron basemap, so the maps themselves need no API keys, accounts or usage bills. On "My Philadelphia, now" buses are blue, trolleys green, trains and the Metro neon pink (#ff1251, drawn as 40% pink track so the lines sharing Center City's trunk don't add up) and Indego bike share purple (#9a00fa); on the DevTracker map construction permits are orange and hot spots blue. The colors were checked for color-blind readers (pink trains and green trolleys are told apart by shape too: trains run on track with ties) and live in `lib/palette.js`, mirrored at the top of `live.css`.

"My Philadelphia, now" opens centered on City Hall, as close in as the spots around Center City, University City and the riverfront allow (Belmont Plateau and Devil's Pool are a pan away), in the site's color scheme: the navbar's light/dark toggle (light by default, remembered per browser) switches the whole site, this map included, to its night version: a neon map after Snazzy Maps' "Neon Dark", with black land, deep cyan water with glowing shores and a grey street grid (highways left out) at 10% laid under every other layer (cyan being a neon hue no live layer uses), where moving lights glow brightest. The spots' emoji sit above the moving vehicles. The sun/moon button under the map's zoom buttons switches just the map. Train and Metro lines are drawn as track, crossed by short ties. GPS fixes arrive every 15–60 seconds and are often tens of metres off, so each one is placed on the nearest point of the vehicle's route, and the vehicle glides along the route to it, down the street or along the track, instead of cutting across. Small backward jumps are treated as GPS wobble and ignored. A vehicle more than about 100 m off its route (150 m for trains), on a detour or a layover, fades out until it is back. Each vehicle leaves a trail of its last four minutes along its route that fades smoothly toward its tail, and at night trails and glows add up where routes overlap, so the busiest corridors light up. The analysis maps (DevTracker, TOD story) stay light.

## Sam's favorite spots

The spots are listed in `scripts/favorites.json`: a name, an emoji, a category and neighborhood, an address, coordinates and a one-line description for each. To add, remove or edit one:

1. Edit `scripts/favorites.json`. The `id` is the spot's permanent key, so keep it short and don't change it later.
2. In `scripts/`, run `npm run philly-spots`. It downloads SEPTA's current schedule data (GTFS) and writes two files to `assets/live/data/`: `septa-routes.json`, every street and track each route's trips use (each variant once, to within about 5 m), which the map draws and keeps vehicles on, and `favorites.json`, the spots with their nearest bus, train and trolley stops and every route and stop within a half-mile walk.
3. If the Worker serves Google reviews, deploy it again (`npm run deploy` in `worker/`), because it only looks up the spots it was deployed with.

Rerun step 2 when SEPTA changes its routes, a few times a year. The descriptions are Sam's own notes on each place; Google's reviews, when the Worker has a key, appear below them.

## Data

Visitors' browsers read the public feeds directly. The exceptions are SEPTA, which goes through the Worker when one is configured, and Google, which only the Worker can reach.

| Source | Used for | Updates |
|---|---|---|
| SEPTA TransitView and TrainView | Buses, trolleys, Metro and Regional Rail | Polled every 15 seconds |
| SEPTA GTFS | Routes, stops and each spot's nearest stops | When `npm run philly-spots` runs |
| Indego (GBFS) | Dock activity and bikes at each station | About once a minute |
| Google Places API (New), through the Worker | Each spot's rating, top reviews and photo | When a visitor opens a spot |
| MBTA V3 API | T trains and Silver Line buses | Every few seconds |
| City of Philadelphia L&I permits (Carto) | Building permits | Nightly |

A feed is only polled while its map is on screen and the tab is visible, and polling backs off when a source is down.

The files in `assets/live/data/` are built ahead of time by the scripts in `scripts/` (run `npm install` there once; `npm run build` rebuilds them all):

- `philly-limits.json`, Philadelphia's city limits: `npm run philly`
- `dev-hotspots-2022.json`, DevTracker's construction hot spots recomputed with the project's method: `npm run devtracker`
- `tod-boston.json`, the tracts, ACS indicators, stations, lines and walksheds for the TOD story: `npm run tod`
- `septa-routes.json` and `favorites.json`, for "My Philadelphia, now": `npm run philly-spots`

The first three only need rebuilding to change the method or the years.

## The Worker (optional, recommended)

`worker/` holds a Cloudflare Worker that relays SEPTA's feed, keeps the last few minutes of vehicle positions so trails are drawn the moment the page opens, and fetches Google reviews for the favorite spots. `worker/README.md` explains how to deploy it and how to add the Google key. After deploying, set `PRODUCTION_API` in `assets/live/config.js`.

Until then the site works without it: SEPTA is read directly, trails start empty and grow while the page is open, and each spot card shows Sam's note with an "Open in Google Maps" link instead of reviews.

## Working locally

```bash
quarto preview                  # the site, http://localhost:3333
cd worker && npm run dev        # optional: the Worker, http://127.0.0.1:8787
```

GitHub Pages serves the `docs/` folder, so run `quarto render` before committing.

The first version of these maps also had a Live page with a community pin board, bike share in three cities and the Delaware River tide. They were removed in favor of "My Philadelphia, now" and remain in the git history (commit `db68bf9`).
