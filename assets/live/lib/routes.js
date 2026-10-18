// Snaps SEPTA vehicles onto their route shapes (septa-routes.json). GPS fixes come in every
// 15-60 s and are often well off the street, so gliding straight between them cuts across blocks.
import { reducedMotion } from './motion.js';
import { rgba } from './palette.js';

// web mercator scaled to metres at Philly's latitude
const M = 40_075_016.686 * Math.cos((39.95 * Math.PI) / 180);
const toX = (lng) => ((lng + 180) / 360) * M;
const toY = (lat) => ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * M;
const toLngLat = (x, y) => [(x / M) * 360 - 180, (360 / Math.PI) * Math.atan(Math.exp(Math.PI * (1 - (2 * y) / M))) - 90];

// m/s; metres off the route; metres back before it counts as a turnaround and not GPS noise
const TOP_SPEED = { bus: 25, trolley: 25, metro: 30, rail: 45 };
const OFF_ROUTE = { bus: 100, trolley: 100, metro: 150, rail: 150 };
const TURN = { bus: 150, trolley: 150, metro: 300, rail: 300 };
const SHARED = 25; // shapes closer than this are on the same street

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// first index with cum > s (>= s when not strict)
function search(cum, s, strict = true) {
  let lo = 0;
  let hi = cum.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? cum[mid] > s : cum[mid] >= s) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

class Shape {
  constructor(key, coords) {
    const n = coords.length;
    this.key = key;
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.cum = new Float64Array(n);
    this.box = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      const x = toX(coords[i][0]);
      const y = toY(coords[i][1]);
      this.xs[i] = x;
      this.ys[i] = y;
      if (i) this.cum[i] = this.cum[i - 1] + Math.hypot(x - this.xs[i - 1], y - this.ys[i - 1]);
      this.box = [Math.min(this.box[0], x), Math.min(this.box[1], y), Math.max(this.box[2], x), Math.max(this.box[3], y)];
    }
    this.length = this.cum[n - 1];
  }

  at(s) {
    const { xs, ys, cum } = this;
    const last = xs.length - 1;
    if (s <= 0) return [xs[0], ys[0]];
    if (s >= this.length) return [xs[last], ys[last]];
    const i = search(cum, s);
    const k = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return [xs[i - 1] + (xs[i] - xs[i - 1]) * k, ys[i - 1] + (ys[i] - ys[i - 1]) * k];
  }

  // `prefer` breaks ties where a shape uses the same street twice (out and back, loops), so a
  // vehicle stays on the pass it's on.
  nearest(x, y, from = 0, to = Infinity, prefer = null) {
    const { xs, ys, cum } = this;
    const last = xs.length - 1;
    const i0 = clamp(search(cum, from), 1, last);
    const i1 = clamp(search(cum, to), i0, last);
    let best = Infinity;
    let bestD2 = 0;
    let s = 0;
    for (let i = i0; i <= i1; i++) {
      const ax = xs[i - 1];
      const ay = ys[i - 1];
      const dx = xs[i] - ax;
      const dy = ys[i] - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? clamp(((x - ax) * dx + (y - ay) * dy) / len2, 0, 1) : 0;
      const ex = ax + t * dx - x;
      const ey = ay + t * dy - y;
      const d2 = ex * ex + ey * ey;
      const along = cum[i - 1] + t * (cum[i] - cum[i - 1]);
      // 1 m off the line costs as much as 20 m further along it
      const cost = prefer === null ? d2 : Math.sqrt(d2) + Math.abs(along - prefer) / 20;
      if (cost < best) {
        best = cost;
        bestD2 = d2;
        s = along;
      }
    }
    return { shape: this, s, d: Math.sqrt(bestD2) };
  }

  // every vertex between a and b (either direction), then b itself
  walk(a, b, emit) {
    const { xs, ys, cum } = this;
    if (b > a) for (let i = search(cum, a); i < xs.length && cum[i] < b; i++) emit(xs[i], ys[i]);
    else for (let i = search(cum, a, false) - 1; i >= 0 && cum[i] > b; i--) emit(xs[i], ys[i]);
    const [x, y] = this.at(b);
    emit(x, y);
  }
}

function closest(shapes, x, y, limit, skip = null) {
  let best = null;
  for (const shape of shapes) {
    const [x0, y0, x1, y1] = shape.box;
    if (shape === skip || x < x0 - limit || x > x1 + limit || y < y0 - limit || y > y1 + limit) continue;
    const m = shape.nearest(x, y);
    if (m.d <= limit && (!best || m.d < best.d)) best = m;
  }
  return best;
}

// lines are stored as deltas in 1e-5 degrees
function decode(ints) {
  const out = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < ints.length; i += 2) {
    x += ints[i];
    y += ints[i + 1];
    out.push([x / 1e5, y / 1e5]);
  }
  return out;
}

export class RouteNetwork {
  constructor(data) {
    this.routes = data.routes.map(({ shapes, ...props }) => ({ props, lines: shapes.map(decode) }));
    this.byKey = new Map();
    this.lineKey = new Map(); // Regional Rail line name -> route key
    // fallback for vehicles off their own route: RR trains run through onto the next line, and
    // trolleys share the tunnel
    this.shared = { bus: [], trolley: [], metro: [], rail: [] };
    for (const { props, lines } of this.routes) {
      const shapes = lines.map((line) => new Shape(props.key, line));
      this.byKey.set(props.key, shapes);
      if (props.line) this.lineKey.set(props.line, props.key);
      const kind = props.mode === 'train' ? (props.line ? 'rail' : 'metro') : props.mode;
      if (kind !== 'bus') this.shared[kind].push(...shapes);
    }
  }

  geojson() {
    return {
      type: 'FeatureCollection',
      features: this.routes.map(({ props, lines }) => ({
        type: 'Feature',
        properties: props,
        geometry: { type: 'MultiLineString', coordinates: lines },
      })),
    };
  }

  keyOf(v) {
    return v.mode === 'rail' ? this.lineKey.get(v.route) : v.route;
  }

  // Returns { shape, s, d } or null if the fix is off the route. Given the vehicle's last state
  // it sticks to the shape it was on, within `reach` metres.
  match(v, x, y, item = null, reach = 0) {
    const limit = OFF_ROUTE[v.mode] ?? 100;
    const own = this.byKey.get(this.keyOf(v)) ?? [];
    if (item?.shape) {
      const near = item.shape.nearest(x, y, item.s1 - reach, item.s1 + reach, item.s1);
      if (near.d <= limit) {
        const other = closest(own, x, y, limit, item.shape);
        return other && other.d < near.d - 20 ? other : near;
      }
    }
    return closest(own, x, y, limit) ?? closest(this.shared[v.mode] ?? [], x, y, limit);
  }
}

// Each vehicle glides to its latest fix over the time between its reports, so the map runs one
// report behind. Off-route vehicles (detours, layovers, garage trips) fade out until they're back.
export class RouteMovers {
  constructor(network, { trail = 0 } = {}) {
    this.network = network;
    this.items = new Map();
    this.trail = trail;
    this.fade = 700;
    this.maxGlide = 6000; // metres, longer jumps snap
  }

  // durationOf(next, previous) gives the glide time in ms. Returns the vehicles that moved.
  update(list, now, durationOf) {
    const seen = new Set();
    const moved = [];
    for (const next of list) {
      const x = toX(next.lng);
      const y = toY(next.lat);
      const item = this.items.get(next.id);
      if (!item) {
        const m = this.network.match(next, x, y);
        if (!m) continue;
        this.items.set(next.id, {
          ...next, x, y, shape: m.shape, s0: m.s, s1: m.s, t0: now, dur: 1, dir: 0,
          trail: [], born: now, dying: 0, misses: 0, fixAt: now,
        });
        seen.add(next.id);
        continue;
      }
      if (item.x === x && item.y === y) {
        Object.assign(item, next, { dying: 0 });
        seen.add(next.id);
        continue;
      }
      const reach = 300 + TOP_SPEED[next.mode] * clamp((now - item.fixAt) / 1000, 15, 600);
      const m = this.network.match(next, x, y, item, reach);
      if (!m) {
        // ignore one stray fix, fade out after two
        if (++item.misses < 2) seen.add(next.id);
        continue;
      }
      const previous = { ts: item.ts };
      Object.assign(item, next, { x, y, dying: 0, misses: 0, fixAt: now });
      seen.add(next.id);
      const how = this.follow(item, m, now);
      if (!how) continue;
      item.dur = how === 'jump' || reducedMotion() ? 1 : clamp(durationOf(next, previous), 2_000, 60_000);
      item.movedAt = now;
      moved.push(item);
    }
    for (const item of this.items.values()) {
      if (!seen.has(item.id) && !item.dying) item.dying = now;
    }
    return moved;
  }

  // 'glide', 'jump', or null to stay put
  follow(item, m, now) {
    let here = this.s(item, now);
    if (m.shape !== item.shape) {
      // another shape of the same route (branch, loop, other direction): carry on from the
      // same spot if they overlap there, otherwise start over
      const [px, py] = item.shape.at(here);
      const join = m.shape.nearest(px, py);
      if (join.d > SHARED) return this.place(item, m, now);
      item.trail = this.carry(item, m.shape, join.s);
      here = join.s;
      Object.assign(item, { shape: m.shape, s0: here, s1: here, t0: now, dir: 0 });
    }
    const step = m.s - item.s1;
    const backwards = item.dir && step * item.dir < 0;
    if (backwards && Math.abs(step) < TURN[item.mode]) return null; // GPS wobble
    if (backwards) item.trail = []; // turned around at the end of the line
    if (Math.abs(step) >= 40) item.dir = Math.sign(step);
    if (Math.abs(m.s - here) > this.maxGlide) return this.place(item, m, now);
    if (Math.abs(m.s - here) < 1) return null;
    const last = item.trail[item.trail.length - 1];
    if (this.trail && (!last || Math.abs(last[0] - here) > 1)) item.trail.push([here, now]);
    item.s0 = here;
    item.s1 = m.s;
    item.t0 = now;
    return 'glide';
  }

  place(item, m, now) {
    Object.assign(item, { shape: m.shape, s0: m.s, s1: m.s, t0: now, dir: 0, trail: [] });
    return 'jump';
  }

  // re-measure the trail on the new shape, back as far as the two overlap
  carry(item, shape, from) {
    const out = [];
    let prefer = from;
    for (let i = item.trail.length - 1; i >= 0; i--) {
      const [s, t] = item.trail[i];
      const [px, py] = item.shape.at(s);
      const on = shape.nearest(px, py, 0, Infinity, prefer);
      prefer = on.s;
      if (on.d > SHARED) break;
      out.push([on.s, t]);
    }
    return out.reverse();
  }

  // positions from before the page opened, [[lng, lat, time], ...] oldest first
  seed(id, points) {
    const item = this.items.get(id);
    if (!item || !this.trail) return;
    const limit = OFF_ROUTE[item.mode] ?? 100;
    const trail = [];
    let s = item.s1;
    let t = item.fixAt;
    let dir = 0;
    for (let i = points.length - 1; i >= 0; i--) {
      const [lng, lat, time] = points[i];
      const reach = 150 + TOP_SPEED[item.mode] * Math.max(0, (t - time) / 1000);
      const m = item.shape.nearest(toX(lng), toY(lat), s - reach, s + reach, s);
      if (m.d > limit) break;
      const step = s - m.s;
      if (dir && step * dir < 0) {
        if (Math.abs(step) < TURN[item.mode]) continue;
        break; // turned around here
      }
      if (Math.abs(step) >= 40) dir = Math.sign(step);
      if (Math.abs(step) <= 1) continue;
      trail.push([m.s, time]);
      s = m.s;
      t = time;
    }
    item.trail = trail.reverse();
    item.dir = dir;
  }

  s(item, now) {
    const k = clamp((now - item.t0) / item.dur, 0, 1);
    return item.s0 + (item.s1 - item.s0) * k;
  }

  // in map metres, see screenTransform
  point(item, now) {
    return item.shape.at(this.s(item, now));
  }

  lngLat(item, now) {
    const [x, y] = this.point(item, now);
    return toLngLat(x, y);
  }

  alpha(item, now) {
    const appear = clamp((now - item.born) / this.fade, 0, 1);
    const vanish = item.dying ? clamp(1 - (now - item.dying) / this.fade, 0, 1) : 1;
    return appear * vanish;
  }

  // Walks back from the vehicle to maxAge ago, calling emit(x, y) for each point. Returns the age
  // of the far end.
  walkTrail(item, now, maxAge, emit) {
    const { shape, trail } = item;
    let s = this.s(item, now);
    // when it got to where it is now (it may have stopped)
    let t = Math.min(now, item.t0 + item.dur);
    const [hx, hy] = shape.at(s);
    emit(hx, hy);
    let age = 0;
    for (let i = trail.length - 1; i >= 0; i--) {
      const [ts, tt] = trail[i];
      if (now - tt >= maxAge) {
        // cut the tail exactly at maxAge
        const k = clamp((t - (now - maxAge)) / (t - tt || 1), 0, 1);
        if (k > 0) shape.walk(s, s + (ts - s) * k, emit);
        return k > 0 ? maxAge : age;
      }
      shape.walk(s, ts, emit);
      s = ts;
      t = tt;
      age = now - tt;
    }
    return age;
  }

  // keeps one point older than the trail length so walkTrail can cut the tail between points
  sweep(now) {
    for (const [id, item] of this.items) {
      if (item.dying && now - item.dying > this.fade) {
        this.items.delete(id);
        continue;
      }
      const trail = item.trail;
      let drop = 0;
      while (drop + 1 < trail.length && now - trail[drop + 1][1] > this.trail) drop++;
      if (trail.length - drop > 120) drop = trail.length - 120;
      if (drop) trail.splice(0, drop);
    }
  }
}

// map metres to pixels for the current camera; only works because the map never rotates or tilts
export function screenTransform(map) {
  const [lng0, lat0, lng1, lat1] = [-75.4, 39.8, -74.8, 40.2];
  const a = map.project([lng0, lat0]);
  const b = map.project([lng1, lat1]);
  const kx = (b.x - a.x) / (toX(lng1) - toX(lng0));
  const ky = (b.y - a.y) / (toY(lat1) - toY(lat0));
  const x0 = toX(lng0);
  const y0 = toY(lat0);
  return { x: (x) => a.x + (x - x0) * kx, y: (y) => a.y + (y - y0) * ky };
}

// One stroke per vehicle, fading from the vehicle back to the end of its trail.
// entries: [{ item, p, alpha }] with p in pixels and alpha the vehicle's own fade.
export function drawRouteTrails(ctx, T, movers, entries, now, { maxAge, color, width = 2.4, alpha = 0.6, blend = 'source-over' }) {
  ctx.save();
  ctx.globalCompositeOperation = blend;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = width;
  const head = rgba(color, alpha);
  let tx = 0;
  let ty = 0;
  let started = false;
  const emit = (x, y) => {
    tx = T.x(x);
    ty = T.y(y);
    if (started) ctx.lineTo(tx, ty);
    else ctx.moveTo(tx, ty);
    started = true;
  };
  for (const { item, p, alpha: fade = 1 } of entries) {
    if (!item.trail.length) continue;
    ctx.globalAlpha = fade;
    ctx.beginPath();
    started = false;
    const age = movers.walkTrail(item, now, maxAge, emit);
    if (Math.abs(tx - p.x) + Math.abs(ty - p.y) < 1) continue;
    const gradient = ctx.createLinearGradient(p.x, p.y, tx, ty);
    gradient.addColorStop(0, head);
    // short (new) trails end part-way faded, full-length ones fade to nothing
    gradient.addColorStop(1, rgba(color, +(alpha * (1 - age / maxAge) ** 1.5).toFixed(2)));
    ctx.strokeStyle = gradient;
    ctx.stroke();
  }
  ctx.restore();
}
