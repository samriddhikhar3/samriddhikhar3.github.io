// needs `npm run dev` running in another terminal
const BASE = process.env.API_BASE || 'http://localhost:8787';
const ORIGIN = 'http://localhost:3333';
const headers = { Origin: ORIGIN };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

check('health', (await fetch(`${BASE}/v1/health`, { headers })).ok);

const septa = await fetch(`${BASE}/v1/septa`, { headers });
const feed = await septa.json();
check('SEPTA relay', septa.ok && feed.vehicles?.length > 0, `${feed.vehicles?.length} vehicles, ${feed.trains?.length} trains`);
check('SEPTA relay sends CORS for the site', septa.headers.get('access-control-allow-origin') === ORIGIN);
const other = await fetch(`${BASE}/v1/septa`, { headers: { Origin: 'https://example.com' } });
check('SEPTA relay withholds CORS from other sites', !other.headers.get('access-control-allow-origin'));
const modes = new Set([...feed.vehicles, ...feed.trains].map((v) => v.mode));
check('vehicles are labelled bus, trolley, metro or rail', [...modes].every((m) => ['bus', 'trolley', 'metro', 'rail'].includes(m)), [...modes].join(', '));

// the relay call above just recorded a snapshot
await sleep(500);
const { tracks } = await (await fetch(`${BASE}/v1/septa?tracks=1`, { headers })).json();
const tracked = Object.values(tracks ?? {});
check('SEPTA relay returns recent tracks', tracked.length > 0 &&
  tracked.every((t) => Array.isArray(t) && t.every((p) => p.length === 3)), `${tracked.length} vehicles tracked`);

const place = await fetch(`${BASE}/v1/places/reading-terminal`, { headers });
const body = await place.json();
if (place.status === 501) {
  check('reviews say "not configured" without an API key', body.error === 'reviews_not_configured');
} else {
  check('reviews for a favorite spot', place.ok && typeof body.name === 'string' && Array.isArray(body.reviews),
    `${body.name}: ${body.rating}★, ${body.reviews?.length} reviews`);
}
check('reviews refuse unknown spots', (await fetch(`${BASE}/v1/places/not-a-spot`, { headers })).status === 404);
check('reviews refuse other sites', (await fetch(`${BASE}/v1/places/reading-terminal`, { headers: { Origin: 'https://example.com' } })).status === 403);
check('only GET is accepted', (await fetch(`${BASE}/v1/septa`, { method: 'POST', headers })).status === 405);

process.exit(failures ? 1 : 0);
