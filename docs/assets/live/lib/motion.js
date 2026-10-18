import { rgba } from './palette.js';

const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
export const reducedMotion = () => motionQuery.matches;

const callbacks = new Set();
let frame = 0;
function loop(now) {
  frame = 0;
  for (const cb of callbacks) cb(now);
  if (callbacks.size) frame = requestAnimationFrame(loop);
}

// one shared rAF loop; it stops when nothing is subscribed
export function onFrame(cb) {
  callbacks.add(cb);
  if (!frame) frame = requestAnimationFrame(loop);
  return () => callbacks.delete(cb);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const TAU = Math.PI * 2;

// rough, but fine for spotting GPS jumps
function metres([x1, y1], [x2, y2]) {
  const kx = 111_320 * Math.cos((((y1 + y2) / 2) * Math.PI) / 180);
  return Math.hypot((x2 - x1) * kx, (y2 - y1) * 110_574);
}

// Vehicles glide from their previous fix to the newest one at the pace they reported, so the
// map trails real time by one report.
export class Movers {
  constructor({ trail = 0 } = {}) {
    this.items = new Map();
    this.fade = 700;
    this.maxGlide = 2500; // metres, longer jumps snap
    this.trail = trail;
  }

  // durationOf(next, previous) gives the glide time in ms. Returns the vehicles that moved.
  update(list, now, durationOf) {
    const seen = new Set();
    const moved = [];
    for (const next of list) {
      seen.add(next.id);
      const item = this.items.get(next.id);
      const to = [next.lng, next.lat];
      if (!item) {
        this.items.set(next.id, { ...next, from: to, to, t0: now, dur: 1, born: now, dying: 0, movedAt: 0, trail: [] });
        continue;
      }
      const changed = item.to[0] !== to[0] || item.to[1] !== to[1];
      const here = this.position(item, now);
      const previous = { ...item };
      Object.assign(item, next, { dying: 0 });
      if (!changed) continue;
      const jump = metres(here, to) > this.maxGlide;
      if (this.trail) {
        if (jump) item.trail = [];
        else item.trail.push([here[0], here[1], now]);
      }
      const snap = jump || reducedMotion();
      item.from = snap ? to : here;
      item.to = to;
      item.t0 = now;
      item.dur = snap ? 1 : clamp(durationOf(next, previous), 2_000, 60_000);
      item.movedAt = now;
      moved.push(item);
    }
    for (const item of this.items.values()) {
      if (!seen.has(item.id) && !item.dying) item.dying = now;
    }
    return moved;
  }

  // points: [[lng, lat, time], ...], oldest first
  seed(id, points) {
    const item = this.items.get(id);
    if (!item || !this.trail) return;
    const path = [];
    let newer = item.to;
    for (let i = points.length - 1; i >= 0; i--) {
      const d = metres(points[i], newer);
      if (d > this.maxGlide) break;
      if (d > 3) {
        path.push(points[i]);
        newer = points[i];
      }
    }
    item.trail = path.reverse();
  }

  position(item, now) {
    const k = clamp((now - item.t0) / item.dur, 0, 1);
    return [item.from[0] + (item.to[0] - item.from[0]) * k, item.from[1] + (item.to[1] - item.from[1]) * k];
  }

  alpha(item, now) {
    const appear = clamp((now - item.born) / this.fade, 0, 1);
    const vanish = item.dying ? clamp(1 - (now - item.dying) / this.fade, 0, 1) : 1;
    return appear * vanish;
  }

  sweep(now) {
    for (const [id, item] of this.items) {
      if (item.dying && now - item.dying > this.fade) {
        this.items.delete(id);
        continue;
      }
      const trail = item.trail;
      let drop = 0;
      while (drop < trail.length && now - trail[drop][2] > this.trail) drop++;
      if (drop) trail.splice(0, drop);
      if (trail.length > 80) trail.splice(0, trail.length - 80);
    }
  }
}

// Caches each point's projection on the point itself until the camera moves. Most frames the
// map isn't moving, so redrawing trails is cheap.
export function projector(map, width, height) {
  const c = map.getCenter();
  const key = `${c.lng},${c.lat},${map.getZoom()},${width},${height}`;
  return (pt) => {
    if (pt.k !== key) {
      const q = map.project([pt[0], pt[1]]);
      pt.k = key;
      pt.x = q.x;
      pt.y = q.y;
    }
    return pt;
  };
}

// One stroke per vehicle with a gradient along it. Drawing segments separately left visible
// seams where the round caps overlapped. entries: [{ item, p }], p = projected position.
export function drawTrails(ctx, project, entries, now, { maxAge, color, width = 2.4, alpha = 0.6, blend = 'source-over' }) {
  ctx.save();
  ctx.globalCompositeOperation = blend;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = width;
  const head = rgba(color, alpha);
  for (const { item, p } of entries) {
    const trail = item.trail;
    if (!trail?.length) continue;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    let tail = null;
    let oldest = 0;
    for (let i = trail.length - 1; i >= 0; i--) {
      const age = now - trail[i][2];
      if (age >= maxAge) break;
      tail = project(trail[i]);
      oldest = age;
      ctx.lineTo(tail.x, tail.y);
    }
    if (!tail || Math.abs(tail.x - p.x) + Math.abs(tail.y - p.y) < 1) continue;
    const gradient = ctx.createLinearGradient(p.x, p.y, tail.x, tail.y);
    gradient.addColorStop(0, head);
    // short (new) trails end part-way faded, full-length ones fade to nothing
    gradient.addColorStop(1, rgba(color, +(alpha * (1 - oldest / maxAge) ** 1.5).toFixed(2)));
    ctx.strokeStyle = gradient;
    ctx.stroke();
  }
  ctx.restore();
}

// pre-rendered so drawing a few hundred dots a frame is just drawImage
export function sprite({ radius, color, ring = 0, ringColor = '#fff', glow = 0, glowAlpha = 0.35 }) {
  const ratio = 2;
  const half = Math.ceil(Math.max(radius + ring, glow)) + 1;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = half * 2 * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  if (glow) {
    const g = ctx.createRadialGradient(half, half, 0, half, half, glow);
    g.addColorStop(0, rgba(color, glowAlpha));
    g.addColorStop(0.4, rgba(color, glowAlpha * 0.45));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, half * 2, half * 2);
  }
  if (ring) {
    ctx.fillStyle = ringColor;
    ctx.beginPath();
    ctx.arc(half, half, radius + ring, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(half, half, radius, 0, TAU);
  ctx.fill();
  return { canvas, half };
}

export function drawSprite(ctx, s, x, y) {
  ctx.drawImage(s.canvas, x - s.half, y - s.half, s.half * 2, s.half * 2);
}

export class Ripples {
  constructor({ life = 1800, r0 = 2, r1 = 16, width = 1.6, opacity = 0.9, blend = 'source-over' } = {}) {
    Object.assign(this, { life, r0, r1, width, opacity, blend });
    this.list = [];
  }

  add(lngLat, at, color) {
    this.list.push({ lngLat, at, color });
  }

  get active() {
    return this.list.length > 0;
  }

  draw(ctx, map, now) {
    this.list = this.list.filter((r) => now - r.at < this.life);
    ctx.save();
    ctx.globalCompositeOperation = this.blend;
    for (const r of this.list) {
      if (now < r.at) continue;
      const k = (now - r.at) / this.life;
      const ease = 1 - (1 - k) ** 3;
      const p = map.project(r.lngLat);
      ctx.globalAlpha = (1 - k) * this.opacity;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = this.width * (1 - k * 0.5);
      ctx.beginPath();
      ctx.arc(p.x, p.y, this.r0 + ease * (this.r1 - this.r0), 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }
}

// Canvas on top of the map for anything that moves every frame (updating a GeoJSON source that
// often would mean re-tiling constantly). Redraws on every map render to stay in sync while panning.
export class Overlay {
  constructor(map, draw) {
    this.map = map;
    this.draw = draw;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'live-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    map.getCanvasContainer().append(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.resize();
    map.on('resize', () => this.resize());
    map.on('render', () => this.render());
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.map.getContainer();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(w * ratio);
    this.canvas.height = Math.round(h * ratio);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.width = w;
    this.height = h;
    this.render();
  }

  render(now = performance.now()) {
    this.lastRender = now;
    this.ctx.clearRect(0, 0, this.width, this.height);
    this.draw(this.ctx, now, this);
  }

  tick(now, fps = 30) {
    if (!this.lastRender || now - this.lastRender >= 1000 / fps - 2) this.render(now);
  }

  visible(p, margin = 24) {
    return p.x > -margin && p.y > -margin && p.x < this.width + margin && p.y < this.height + margin;
  }
}

export { TAU };
