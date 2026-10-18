# Live-map Worker

A small Cloudflare Worker behind three features of the site's live maps. It fits in Cloudflare's free plan; only the optional Google reviews can cost money, on Google's side.

- **SEPTA relay** (`GET /v1/septa`). SEPTA's real-time feeds don't send CORS headers, so browsers can't read them directly. The Worker fetches them, trims them to what the map draws (about 170 KB down to 30 KB), labels each vehicle as a bus, trolley, Metro or Regional Rail train, and caches the result at the edge for 10 seconds so every visitor shares one upstream request. Without the Worker, the site reads SEPTA's JSONP endpoints instead.
- **Vehicle trails** (`GET /v1/septa?tracks=1`). A Durable Object keeps the last eight minutes of vehicle positions (at most one snapshot every 30 seconds, in SQLite), so each bus and train's trail is already drawn when a visitor arrives. A cron trigger records a snapshot every minute so the history is ready even after a quiet spell. Without the Worker, trails start empty and grow while the page is open.
- **Google reviews for Sam's favorite spots** (`GET /v1/places/:spot` and `/v1/places/:spot/photo`). The Worker finds the spot on Google by name near its coordinates, then returns its rating, the first three reviews with text, and a photo, so the API key never reaches the browser. Only the spots in `assets/live/data/favorites.json` can be looked up, only from the site's own pages, and at most 40 times per visitor every 10 minutes. Without a key these answer 501 and each card shows Sam's note and an "Open in Google Maps" link.

## Run it locally

```bash
npm install
cp .dev.vars.example .dev.vars    # optional: add a Google Maps key to try the reviews
npm run dev                       # serves http://127.0.0.1:8787
```

Local pages of the site (`quarto preview` in the repo root) use `http://127.0.0.1:8787` automatically (see `assets/live/config.js`).

With the dev server running, `npm test` checks the whole thing end to end: the relay, CORS, vehicle labels, trails, and that reviews refuse unknown spots, other sites and anything but GET.

## Deploy

1. Create a free Cloudflare account, then sign in from this folder: `npx wrangler login`.
2. Run `npm run deploy`. It prints the Worker's URL, like `https://samriddhi-live.<subdomain>.workers.dev`.
3. Paste that URL into `PRODUCTION_API` in `assets/live/config.js`, run `quarto render`, then commit and push.

If the site moves to another domain, add it to `ALLOWED_ORIGINS` in `wrangler.toml` and deploy again. The Worker bundles the list of favorite spots, so deploy again after changing them too.

## Google reviews (optional)

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project with billing turned on and enable **Places API (New)**.
2. Create an API key and restrict it to Places API (New). The Worker calls Google from Cloudflare's servers, so leave the application restriction at "None".
3. From this folder, run `npx wrangler secret put GOOGLE_MAPS_API_KEY` and paste the key. The next request picks it up; there is nothing to redeploy.

Each spot card a visitor opens costs one Place Details request plus one photo, at most once per spot per page view. Asking for reviews puts Place Details in Google's Enterprise + Atmosphere tier, which in 2026 includes 1,000 free requests a month and then costs about $25 per 1,000; photos are billed separately ([pricing](https://developers.google.com/maps/billing-and-pricing/pricing)). Finding each spot's Google place uses the free, ID-only Text Search, and the place IDs are remembered. To make sure a busy month can't run up a bill, cap requests per day under Places API (New) → Quotas in the Cloud console and set a budget alert.

Google's terms ask that reviews and photos keep their authors' names and links, which the card shows, and that place content isn't stored, so the Worker keeps only place IDs and fetches everything else fresh.
