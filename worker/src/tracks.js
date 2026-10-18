// Rolling window of SEPTA position snapshots so trails can be drawn as soon as a page opens.
// At most one row every 30 s keeps writes well inside the free plan.
import { DurableObject } from 'cloudflare:workers';

const KEEP_MS = 8.5 * 60_000;
const MIN_GAP_MS = 30_000;

export class SeptaTracks extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS snapshots (t INTEGER PRIMARY KEY, data TEXT NOT NULL)');
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === 'POST' && pathname === '/record') {
      this.record(await request.json());
      return new Response(null, { status: 204 });
    }
    if (pathname === '/tracks') return Response.json(this.tracks());
    return new Response('not found', { status: 404 });
  }

  // snapshot: { t, positions: [[id, lng*1e5, lat*1e5], ...] }
  record({ t, positions }) {
    const { last } = this.sql.exec('SELECT MAX(t) AS last FROM snapshots').one();
    if (last && t - last < MIN_GAP_MS) return;
    this.sql.exec('INSERT OR REPLACE INTO snapshots (t, data) VALUES (?, ?)', t, JSON.stringify(positions));
    this.sql.exec('DELETE FROM snapshots WHERE t < ?', t - KEEP_MS);
  }

  // { id: [[lng*1e5, lat*1e5, ageSeconds], ...] }, oldest first, no repeated positions
  tracks() {
    const now = Date.now();
    const byId = {};
    for (const { t, data } of this.sql.exec('SELECT t, data FROM snapshots WHERE t > ? ORDER BY t', now - KEEP_MS)) {
      const age = Math.round((now - t) / 1000);
      for (const [id, x, y] of JSON.parse(data)) {
        const track = (byId[id] ??= []);
        const prev = track.at(-1);
        if (!prev || prev[0] !== x || prev[1] !== y) track.push([x, y, age]);
      }
    }
    return byId;
  }
}
