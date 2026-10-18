// SEPTA's feeds have no CORS headers. The relay trims them (~170 KB down to ~30 KB) and caches
// at the edge so all visitors share one upstream request.
import { normalizeSepta } from '../../assets/live/feeds/septa-normalize.js';

const TRANSIT = 'https://www3.septa.org/api/TransitViewAll/index.php';
const TRAINS = 'https://www3.septa.org/api/TrainView/index.php';
const TTL_SECONDS = 10;
const CACHE_KEY = new Request('https://relay.internal/v1/septa');

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'samriddhikhar3.github.io live map relay' },
    cf: { cacheTtl: TTL_SECONDS, cacheEverything: true },
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

export async function fetchUpstream() {
  const [transit, trains] = await Promise.allSettled([getJson(TRANSIT), getJson(TRAINS)]);
  if (transit.status === 'rejected' && trains.status === 'rejected') {
    throw new Error(`SEPTA unavailable: ${transit.reason}`);
  }
  return normalizeSepta(
    transit.status === 'fulfilled' ? transit.value : null,
    trains.status === 'fulfilled' ? trains.value : null,
  );
}

const tracksStub = (env) => env.TRACKS.get(env.TRACKS.idFromName('septa'));

export function recordPositions(env, body) {
  const positions = [...body.vehicles, ...body.trains]
    .map((v) => [v.id, Math.round(v.lng * 1e5), Math.round(v.lat * 1e5)]);
  return tracksStub(env).fetch('https://tracks.internal/record', {
    method: 'POST',
    body: JSON.stringify({ t: body.t, positions }),
  });
}

async function snapshot(ctx, env) {
  const cache = caches.default;
  const hit = await cache.match(CACHE_KEY);
  if (hit) return hit.json();
  const body = await fetchUpstream();
  ctx.waitUntil(Promise.all([
    cache.put(CACHE_KEY, new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${TTL_SECONDS}` },
    })),
    recordPositions(env, body).catch((err) => console.error('tracks', err)),
  ]));
  return body;
}

export async function septaLive(request, ctx, env) {
  const body = await snapshot(ctx, env);
  if (new URL(request.url).searchParams.has('tracks')) {
    try {
      body.tracks = await (await tracksStub(env).fetch('https://tracks.internal/tracks')).json();
    } catch (err) {
      console.error('tracks', err); // trails just start empty
    }
  }
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=5' },
  });
}
