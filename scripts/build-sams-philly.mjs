// Builds septa-routes.json and favorites.json for the home page map from SEPTA's GTFS.
// After editing scripts/favorites.json, run `npm run philly-spots`.
import * as turf from '@turf/turf';
import { strFromU8, unzipSync } from 'fflate';
import { readFile } from 'node:fs/promises';
import { DATA_DIR, ROOT, writeJson } from './lib.mjs';

const GTFS = 'https://github.com/septadev/GTFS/releases/latest/download/gtfs_public.zip';
const HALF_MILE = 804.672; // metres
const MODE_RANK = { train: 3, trolley: 2, bus: 1 };
const SIMPLIFY = 0.00005; // degrees, ~5 m, so snapped vehicles still sit on the street
const SAME_STREET_M = 15;
const MAX_SHAPES = 8;

// just enough CSV for GTFS (quoted fields can contain commas)
function readCsv(bytes) {
  const text = strFromU8(bytes).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(header.map((h, k) => [h.trim(), r[k]])));
}

function modeOf(feed, routeType) {
  if (feed === 'rail') return 'train';
  return { 0: 'trolley', 1: 'train', 2: 'train' }[routeType] ?? 'bus';
}

const KX = 111_320 * Math.cos((39.95 * Math.PI) / 180);
const KY = 110_574;
const toMetres = (pts) => pts.map(([x, y]) => [x * KX, y * KY]);

function distanceToLines(lines, [x, y]) {
  let best = Infinity;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1];
      const dx = line[i][0] - ax;
      const dy = line[i][1] - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
  }
  return best;
}

// Most-used shapes first, skipping ones that just retrace a kept shape (other direction, short
// turns), until 98% of the route's trips are covered.
function routeShapes(counts, shapes) {
  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  const kept = [];
  const keptMetres = [];
  let covered = 0;
  for (const [shapeId, n] of counts) {
    const pts = shapes.get(shapeId);
    if (!pts) continue;
    const metres = toMetres(pts);
    const sample = metres.filter((_, i) => i % 3 === 0);
    const novel = keptMetres.length ? sample.filter((p) => distanceToLines(keptMetres, p) > SAME_STREET_M).length / sample.length : 1;
    if (novel <= 0.03) {
      covered += n;
      continue;
    }
    if (kept.length === MAX_SHAPES) continue;
    kept.push(pts);
    keptMetres.push(metres);
    covered += n;
    if (covered / total >= 0.98) break;
  }
  return kept;
}

// deltas in 1e-5 degrees, decoded in assets/live/lib/routes.js
function encode(coords) {
  const out = [];
  let px = 0;
  let py = 0;
  for (const [x, y] of coords) {
    const ix = Math.round(x * 1e5);
    const iy = Math.round(y * 1e5);
    out.push(ix - px, iy - py);
    px = ix;
    py = iy;
  }
  return out;
}

function haversine([x1, y1], [x2, y2]) {
  const r = Math.PI / 180;
  const a = Math.sin(((y2 - y1) * r) / 2) ** 2 + Math.cos(y1 * r) * Math.cos(y2 * r) * Math.sin(((x2 - x1) * r) / 2) ** 2;
  return 2 * 6_371_008 * Math.asin(Math.sqrt(a));
}

console.log('Downloading SEPTA GTFS…');
const res = await fetch(GTFS);
if (!res.ok) throw new Error(`GTFS: ${res.status}`);
const outer = unzipSync(new Uint8Array(await res.arrayBuffer()));

const routes = []; // { key, name, mode, line?, lines: [[[lng, lat], …], …] }
const stops = new Map(); // `${feed}:${stop_id}` -> { name, lng, lat, keys: Set, mode }

for (const [feed, file] of [['bus', 'google_bus.zip'], ['rail', 'google_rail.zip']]) {
  const gtfs = unzipSync(outer[file]);
  const routeRows = readCsv(gtfs['routes.txt']);
  const tripRows = readCsv(gtfs['trips.txt']);
  const shapeRows = readCsv(gtfs['shapes.txt']);
  const stopRows = readCsv(gtfs['stops.txt']);
  const routeStops = readCsv(gtfs['route_stops.txt']);

  const shapes = new Map(); // shape_id -> [[lng, lat], …] in order
  for (const s of shapeRows) {
    if (!shapes.has(s.shape_id)) shapes.set(s.shape_id, []);
    shapes.get(s.shape_id).push([+s.shape_pt_sequence, +s.shape_pt_lon, +s.shape_pt_lat]);
  }
  for (const [id, pts] of shapes) shapes.set(id, pts.sort((a, b) => a[0] - b[0]).map(([, x, y]) => [x, y]));
  const tripsByRoute = new Map(); // route_id -> Map(shape_id -> trips)
  for (const t of tripRows) {
    if (!tripsByRoute.has(t.route_id)) tripsByRoute.set(t.route_id, new Map());
    const counts = tripsByRoute.get(t.route_id);
    counts.set(t.shape_id, (counts.get(t.shape_id) ?? 0) + 1);
  }

  const keyOf = new Map();
  for (const r of routeRows) {
    const mode = modeOf(feed, r.route_type);
    const key = feed === 'rail' ? r.route_id : r.route_short_name || r.route_id;
    keyOf.set(r.route_id, { key, mode });
    const counts = [...(tripsByRoute.get(r.route_id) ?? new Map())].sort((a, b) => b[1] - a[1]);
    const lines = routeShapes(counts, shapes);
    if (!lines.length) continue;
    routes.push({
      key,
      name: r.route_long_name,
      mode,
      ...(feed === 'rail' ? { line: r.route_long_name.replace(/ Line$/, '') } : {}),
      lines,
    });
  }

  for (const s of stopRows) {
    stops.set(`${feed}:${s.stop_id}`, { name: s.stop_name, lng: +s.stop_lon, lat: +s.stop_lat, keys: new Set(), mode: null });
  }
  for (const rs of routeStops) {
    const stop = stops.get(`${feed}:${rs.stop_id}`);
    const route = keyOf.get(rs.route_id);
    if (!stop || !route) continue;
    stop.keys.add(route.key);
    if (!stop.mode || MODE_RANK[route.mode] > MODE_RANK[stop.mode]) stop.mode = route.mode;
  }
}

const served = [...stops.values()].filter((s) => s.mode);
console.log(`${routes.length} routes, ${served.length} served stops`);

const routeData = {
  routes: routes.map(({ lines, ...props }) => ({
    ...props,
    shapes: lines.map((line) => encode(turf.simplify(turf.lineString(line), { tolerance: SIMPLIFY }).geometry.coordinates)),
  })),
};
console.log(`${routeData.routes.reduce((n, r) => n + r.shapes.length, 0)} shapes, ` +
  `${routeData.routes.reduce((n, r) => n + r.shapes.reduce((m, sh) => m + sh.length / 2, 0), 0)} points`);

const spots = JSON.parse(await readFile(`${ROOT}/scripts/favorites.json`, 'utf8'));
const modeOfKey = new Map(routes.map((r) => [r.key, r.mode]));

function nearest(here, mode) {
  let best = null;
  for (const s of served) {
    const keys = [...s.keys].filter((k) => modeOfKey.get(k) === mode);
    if (!keys.length) continue;
    const m = haversine(here, [s.lng, s.lat]);
    if (!best || m < best.m) best = { name: s.name, m: Math.round(m), routes: keys.sort() };
  }
  return best;
}

const enriched = spots.map((spot) => {
  const here = [spot.lng, spot.lat];
  const near = served
    .map((s) => ({ s, m: haversine(here, [s.lng, s.lat]) }))
    .filter(({ m }) => m <= HALF_MILE);
  const routeKeys = new Set(near.flatMap(({ s }) => [...s.keys]));
  return {
    ...spot,
    nearest: { bus: nearest(here, 'bus'), train: nearest(here, 'train'), trolley: nearest(here, 'trolley') },
    routes: [...routeKeys].sort(),
    stops: near.map(({ s }) => [+s.lng.toFixed(5), +s.lat.toFixed(5), s.mode]),
  };
});

for (const s of enriched) {
  console.log(`${s.emoji} ${s.name.padEnd(28)} ${String(s.routes.length).padStart(3)} routes, ${String(s.stops.length).padStart(3)} stops · ` +
    `bus ${s.nearest.bus?.name} (${s.nearest.bus?.m} m) · train ${s.nearest.train?.name} (${s.nearest.train?.m} m)`);
}

await writeJson(`${DATA_DIR}/septa-routes.json`, routeData);
await writeJson(`${DATA_DIR}/favorites.json`, enriched);
