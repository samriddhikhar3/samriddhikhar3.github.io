//   GET /v1/health
//   GET /v1/septa[?tracks=1]
//   GET /v1/places/:spot[/photo]
import { places } from './places.js';
import { fetchUpstream, recordPositions, septaLive } from './septa.js';
import { SeptaTracks } from './tracks.js';

export { SeptaTracks };

const allowedOrigins = (env) => (env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);

// image requests send no Origin, only a Referer
function fromSite(request, env) {
  const origins = allowedOrigins(env);
  const origin = request.headers.get('Origin');
  if (origin) return origins.includes(origin);
  const referer = request.headers.get('Referer') || '';
  return origins.some((o) => referer === o || referer.startsWith(`${o}/`));
}

function corsHeaders(origin, allowed) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (allowed) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

async function route(request, env, ctx, url) {
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);
  if (url.pathname === '/v1/health') return json({ ok: true });
  if (url.pathname === '/v1/septa') return septaLive(request, ctx, env);
  if (url.pathname.startsWith('/v1/places/')) {
    // paid API key behind this, so only the site may call it
    if (!fromSite(request, env)) return json({ error: 'origin_not_allowed' }, 403);
    return places(request, env, url);
  }
  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowed = Boolean(origin) && allowedOrigins(env).includes(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin, allowed) });
    }

    let response;
    try {
      response = await route(request, env, ctx, url);
    } catch (err) {
      console.error(err);
      response = json({ error: 'upstream_unavailable' }, 502);
    }
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders(origin, allowed))) headers.set(key, value);
    return new Response(response.body, { status: response.status, headers });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchUpstream().then((body) => recordPositions(env, body)));
  },
};
