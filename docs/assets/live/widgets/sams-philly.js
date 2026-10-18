// The home page map ("My Philadelphia, now"): live SEPTA vehicles and Indego docks around Sam's
// favorite spots. Picking a spot highlights the transit within a half-mile walk.
import { fetchSepta, lateness, vehicleName } from '../feeds/septa.js';
import { DockWatcher, loadStations, loadStatus } from '../feeds/gbfs.js';
import { EMPTY, circle, featureCollection, haversine, loadData, point } from '../lib/geo.js';
import { addCityFrame, createMap, padBounds, restyle } from '../lib/maplibre.js';
import { Overlay, Ripples, drawSprite, onFrame, reducedMotion, sprite } from '../lib/motion.js';
import { transitColors } from '../lib/palette.js';
import { poll } from '../lib/poll.js';
import { RouteMovers, RouteNetwork, drawRouteTrails, screenTransform } from '../lib/routes.js';
import { LiveStatus, Tooltip, ago, fmt, h, legendKey, localPoint, svg } from '../lib/ui.js';
import { SpotCard } from './spot-card.js';

const SEPTA_EVERY = 15_000;
const INDEGO_EVERY = 60_000; // Indego only updates about once a minute
const TRAIL_MS = 4 * 60_000;
const HALF_MILE = 804.672; // metres
const LINKEDIN = 'https://www.linkedin.com/in/samriddhi-khare-3668821b1/';
// left out of the opening view so it can stay zoomed in; Belmont would sit behind the title card
const OUT_OF_FRAME = new Set(['devils-pool', 'belmont-plateau']);
const CITY_HALL = [-75.16362, 39.95228];
const GROUPS = ['bus', 'trolley', 'train'];

const groupOf = (v) => (v.mode === 'rail' || v.mode === 'metro' ? 'train' : v.mode === 'trolley' ? 'trolley' : 'bus');

// hex at alpha over the ground color, flattened to an opaque color
function over(hex, alpha, ground) {
  const a = parseInt(hex.slice(1), 16);
  const b = parseInt(ground.slice(1), 16);
  const channel = (shift) => Math.round(((a >> shift) & 255) * alpha + ((b >> shift) & 255) * (1 - alpha));
  return `#${[16, 8, 0].map((shift) => channel(shift).toString(16).padStart(2, '0')).join('')}`;
}

// Quarto only puts quarto-dark on <body> after load; until then _includes/color-scheme.html
// marks <html>
const pageTheme = () =>
  document.body.classList.contains('quarto-dark') || document.documentElement.classList.contains('quarto-dark-early')
    ? 'night'
    : 'light';

// At night glows and trails are drawn with 'lighter' so busy corridors add up and brighten.
function makeLook(theme) {
  const C = transitColors(theme);
  const night = theme === 'night';
  const radius = { bus: 2.4, trolley: 2.7, train: 3.5 };
  const dots = {};
  const glows = {};
  const greys = {};
  for (const g of GROUPS) {
    dots[g] = sprite({ radius: radius[g], color: C[g], ring: night ? 0 : 1.5, ringColor: C.surface });
    glows[g] = night ? sprite({ radius: 0, color: C[g], glow: g === 'train' ? 14 : 9, glowAlpha: g === 'train' ? 0.34 : 0.3 }) : null;
    greys[g] = sprite({ radius: radius[g] - 0.4, color: C.grey, ring: night ? 0 : 1, ringColor: C.surface });
  }
  return {
    C, night, dots, glows, greys,
    ground: night ? '#000000' : '#f4f4f2', // the basemap's land
    blend: night ? 'lighter' : 'source-over',
    trail: { width: night ? 2.4 : 2.2, alpha: night ? 0.85 : 0.6 },
  };
}

const ICONS = {
  moon: 'M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z',
  sun: 'M12 7.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9ZM12 2v2.2M12 19.8V22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2 12h2.2M19.8 12H22M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6',
};

class ThemeControl {
  constructor(getTheme, setTheme) {
    this.getTheme = getTheme;
    this.setTheme = setTheme;
  }

  onAdd() {
    this.button = h('button', { type: 'button', class: 'live-theme', onclick: () => this.setTheme(this.getTheme() === 'night' ? 'light' : 'night') });
    this.el = h('div', { class: 'maplibregl-ctrl maplibregl-ctrl-group' }, this.button);
    this.update();
    return this.el;
  }

  update() {
    const night = this.getTheme() === 'night';
    const label = night ? 'Switch to the light map' : 'Switch to the dark map';
    this.button.setAttribute('aria-label', label);
    this.button.title = label;
    this.button.replaceChildren(svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
      svg('path', { d: night ? ICONS.sun : ICONS.moon, fill: night ? 'none' : 'currentColor', stroke: 'currentColor', 'stroke-width': night ? 1.8 : 0, 'stroke-linecap': 'round' })));
  }

  onRemove() {
    this.el.remove();
  }
}

export async function mount(root) {
  let theme = pageTheme();
  let look = makeLook(theme);
  let selection = null; // { spot, routes: Set of route keys, stations: Set of Indego ids }

  const mapEl = h('div', {
    class: 'live-map',
    role: 'region',
    'aria-label': 'My Philadelphia, now: a live map of Philadelphia with Sam’s favorite spots, SEPTA buses, trolleys and trains, and Indego bike share.',
  });
  const status = new LiveStatus({ staleAfter: 75_000 });
  const head = h('div', { class: 'live-head sams-head' },
    h('h2', { class: 'sams-head__title' }, 'My Philadelphia, now 🔔'),
    h('p', { class: 'sams-head__subtitle' },
      'My favorite spots in the city of Philadelphia, from the 4 brief years I’ve spent here. ',
      h('a', { href: LINKEDIN, target: '_blank', rel: 'noopener' }, 'Tell me what I missed!')),
    h('p', { class: 'sams-head__status' }, status.el));
  const legend = h('div', { class: 'live-legend sams-legend' });
  const frame = h('div', { class: `live-frame live-frame--hero${theme === 'night' ? ' live-frame--night' : ''}` }, mapEl, head, legend);
  root.replaceChildren(frame);
  const tip = new Tooltip(frame);
  const isPhone = () => frame.getBoundingClientRect().width <= 760;
  const card = new SpotCard(frame, { onClose: () => clearSelection() });

  function renderLegend() {
    const { C } = look;
    legend.replaceChildren(
      legendKey('dot', C.bus, 'Bus'),
      legendKey('dot', C.trolley, 'Trolley'),
      legendKey('dot-lg', C.train, 'Train & Metro'),
      legendKey('line', C.bus, `Last ${TRAIL_MS / 60_000} minutes of travel`),
      legendKey('ring', C.bike, 'Indego dock change'),
    );
  }
  renderLegend();

  const [limits, stations, routeData, spots] = await Promise.all([
    loadData('philly-limits.json'),
    loadStations(),
    loadData('septa-routes.json'),
    loadData('favorites.json'),
  ]);
  const { map, maplibregl } = await createMap(mapEl, {
    theme,
    bounds: limits.bbox,
    fitBoundsOptions: { padding: 24 },
    maxBounds: padBounds(limits.bbox, 0.7),
    minZoom: 9,
    maxZoom: 16.5,
    scrollZoom: false,
    attribution: ['SEPTA', 'Indego', 'Google'],
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  const themeControl = new ThemeControl(() => theme, (next) => setTheme(next));
  map.addControl(themeControl, 'top-right');
  addCityFrame(map, limits, { theme });

  // Start on City Hall and zoom out until every spot (but OUT_OF_FRAME) is clear of the title
  // card, legend and buttons.
  const framed = spots.filter((s) => !OUT_OF_FRAME.has(s.id));
  const frameBox = frame.getBoundingClientRect();
  const MARGIN = 24; // a bit more than half a marker
  const blockers = [head, legend, ...mapEl.querySelectorAll('.maplibregl-ctrl-top-right, .maplibregl-ctrl-bottom-right')]
    .map((el) => el.getBoundingClientRect())
    .map((r) => ({
      left: r.left - frameBox.left - MARGIN,
      right: r.right - frameBox.left + MARGIN,
      top: r.top - frameBox.top - MARGIN,
      bottom: r.bottom - frameBox.top + MARGIN,
    }));
  const allClear = () => framed.every((s) => {
    const { x, y } = map.project([s.lng, s.lat]);
    const inFrame = x > MARGIN && y > MARGIN && x < frameBox.width - MARGIN && y < frameBox.height - MARGIN;
    return inFrame && !blockers.some((b) => x > b.left && x < b.right && y > b.top && y < b.bottom);
  });
  let zoom = 14;
  map.jumpTo({ center: CITY_HALL, zoom });
  while (!allClear() && zoom > map.getMinZoom()) {
    zoom -= 0.1;
    map.jumpTo({ center: CITY_HALL, zoom });
  }

  const network = new RouteNetwork(routeData);
  // Also count the shape it's actually on: RR trains run through onto other lines, trolleys
  // share track.
  const onRoutes = (v, keys) => keys.has(v.shape.key) || keys.has(network.keyOf(v));

  map.addSource('routes', { type: 'geojson', data: network.geojson() });
  map.addLayer({ id: 'routes', type: 'line', source: 'routes', layout: { 'line-join': 'round', 'line-cap': 'round' } });
  // ties across the train lines, so they read as track
  map.addLayer({
    id: 'rail-ties',
    type: 'line',
    source: 'routes',
    filter: ['==', ['get', 'mode'], 'train'],
    layout: { 'line-join': 'round', 'line-cap': 'butt' },
    paint: { 'line-dasharray': [0.22, 1.6] },
  });
  map.addSource('spot-buffer', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'spot-buffer-fill', type: 'fill', source: 'spot-buffer' });
  map.addLayer({ id: 'spot-buffer-line', type: 'line', source: 'spot-buffer' });
  map.addSource('indego', {
    type: 'geojson',
    data: featureCollection(stations.map((s) => point(s.lng, s.lat, { id: s.id, name: s.name }))),
  });
  map.addLayer({ id: 'indego', type: 'circle', source: 'indego' });
  map.addSource('spot-stops', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'spot-stops', type: 'circle', source: 'spot-stops' });

  function paintLayers() {
    const { C, night, ground } = look;
    const set = (layer, prop, value) => map.setPaintProperty(layer, prop, value);
    const modeColor = ['match', ['get', 'mode'], 'bus', C.bus, 'trolley', C.trolley, C.train];
    const lit = selection && ['in', ['get', 'key'], ['literal', [...selection.routes]]];
    const byMode = (busValue, trainValue) => ['match', ['get', 'mode'], 'train', trainValue, busValue];
    // Keep the network dimmer than the trails so vehicles stay readable. Train lines are opaque
    // pre-blended colors instead of 40% pink: many lines share the trunk through Center City and
    // translucent strokes stacked up into a solid band.
    const train = over(C.train, lit ? 0.6 : 0.4, ground);
    const routeColor = ['match', ['get', 'mode'], 'bus', C.bus, 'trolley', C.trolley, train];
    const unlit = night ? 0.32 : 0.5;
    set('routes', 'line-color', lit ? ['case', lit, routeColor, C.grey] : routeColor);
    set('routes', 'line-opacity', lit ? ['case', lit, byMode(night ? 0.5 : 0.6, 1), unlit] : byMode(night ? 0.13 : 0.2, 1));
    set('routes', 'line-width', lit
      ? ['interpolate', ['linear'], ['zoom'], 10, ['case', lit, byMode(1, 1.5), 0.5], 15, ['case', lit, byMode(2, 2.8), 1]]
      : ['interpolate', ['linear'], ['zoom'], 10, byMode(0.5, 1.1), 15, byMode(1.1, 2.2)]);
    map.setLayoutProperty('routes', 'line-sort-key', lit ? ['case', lit, 1, 0] : 0);
    set('rail-ties', 'line-color', lit ? ['case', lit, train, C.grey] : train);
    set('rail-ties', 'line-opacity', lit ? ['case', lit, 1, unlit] : 1);
    set('rail-ties', 'line-width', lit
      ? ['interpolate', ['linear'], ['zoom'], 10, ['case', lit, 4, 2], 15, ['case', lit, 8, 4]]
      : ['interpolate', ['linear'], ['zoom'], 10, 3.2, 15, 6.5]);

    set('spot-buffer-fill', 'fill-color', night ? '#ffffff' : '#1c2833');
    set('spot-buffer-fill', 'fill-opacity', night ? 0.05 : 0.04);
    set('spot-buffer-line', 'line-color', night ? '#c9d2db' : '#5c6166');
    set('spot-buffer-line', 'line-opacity', 0.65);
    set('spot-buffer-line', 'line-width', 1.2);

    const near = selection && ['in', ['get', 'id'], ['literal', [...selection.stations]]];
    set('indego', 'circle-color', near ? ['case', near, C.bike, C.grey] : C.bike);
    set('indego', 'circle-opacity', near ? ['case', near, 1, night ? 0.5 : 0.6] : night ? 0.8 : 0.75);
    set('indego', 'circle-radius', near
      ? ['interpolate', ['linear'], ['zoom'], 10, ['case', near, 3, 1.3], 15, ['case', near, 5, 2.6]]
      : ['interpolate', ['linear'], ['zoom'], 10, 1.5, 13, 2.6, 16, 4.5]);
    set('indego', 'circle-stroke-color', C.surface);
    set('indego', 'circle-stroke-width', near ? ['case', near, 1.5, 0] : 0);

    // hollow so stops don't look like vehicles
    set('spot-stops', 'circle-color', C.surface);
    set('spot-stops', 'circle-radius', ['interpolate', ['linear'], ['zoom'], 11, 1.6, 15, 3.2]);
    set('spot-stops', 'circle-stroke-color', modeColor);
    set('spot-stops', 'circle-stroke-width', ['interpolate', ['linear'], ['zoom'], 11, 1, 15, 1.5]);
  }
  paintLayers();

  const markers = new Map();
  for (const spot of spots) {
    const el = h('button', {
      type: 'button',
      class: 'spot-marker',
      'aria-label': `${spot.name}, ${spot.category.toLowerCase()} in ${spot.neighborhood}`,
      'aria-pressed': 'false',
      title: spot.name,
    }, h('span', { 'aria-hidden': 'true' }, spot.emoji));
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      if (selection?.spot === spot) clearSelection();
      else select(spot);
    });
    new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([spot.lng, spot.lat]).addTo(map);
    markers.set(spot.id, el);
  }

  function select(spot) {
    const here = [spot.lng, spot.lat];
    let nearestStation = null;
    const inside = [];
    for (const s of stations) {
      const m = haversine(here, [s.lng, s.lat]);
      if (m <= HALF_MILE) inside.push(s.id);
      if (!nearestStation || m < nearestStation.m) nearestStation = { ...s, m };
    }
    selection = { spot, routes: new Set(spot.routes), stations: new Set(inside) };
    const buffer = circle(here, HALF_MILE);
    map.getSource('spot-buffer').setData(buffer);
    map.getSource('spot-stops').setData(featureCollection(spot.stops.map(([x, y, mode]) => point(x, y, { mode }))));
    paintLayers();
    for (const [id, el] of markers) {
      el.classList.toggle('is-selected', id === spot.id);
      el.setAttribute('aria-pressed', String(id === spot.id));
    }
    card.show(spot, {
      bike: nearestStation && { name: nearestStation.name, m: Math.round(nearestStation.m), bikes: docks.get(nearestStation.id)?.bikes ?? null },
    });
    frame.classList.add('has-card');
    const ring = buffer.geometry.coordinates[0];
    const xs = ring.map((p) => p[0]);
    const ys = ring.map((p) => p[1]);
    const { height } = frame.getBoundingClientRect();
    map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], {
      // phones: the card is a bottom sheet over 55% of the map and the title card is hidden
      padding: isPhone()
        ? { top: 24, bottom: Math.round(height * 0.55) + 16, left: 52, right: 52 }
        : { top: 70, bottom: 60, left: 60, right: 440 },
      maxZoom: 15.5,
      duration: reducedMotion() ? 0 : 900,
    });
    overlay.render();
  }

  function clearSelection() {
    if (!selection) return;
    const spot = selection.spot;
    selection = null;
    map.getSource('spot-buffer').setData(EMPTY);
    map.getSource('spot-stops').setData(EMPTY);
    paintLayers();
    for (const el of markers.values()) {
      el.classList.remove('is-selected');
      el.setAttribute('aria-pressed', 'false');
    }
    card.close();
    frame.classList.remove('has-card');
    markers.get(spot.id)?.focus({ preventScroll: true });
    overlay.render();
  }

  async function setTheme(next) {
    if (next === theme) return;
    theme = next;
    look = makeLook(next);
    frame.classList.toggle('live-frame--night', next === 'night');
    await restyle(map, next);
    paintLayers();
    renderLegend();
    themeControl.update();
    overlay.render();
  }

  const movers = new RouteMovers(network, { trail: TRAIL_MS });
  const bikeRipples = new Ripples({ life: 2000, r0: 2, r1: 14, width: 1.6, opacity: 0.9 });
  const pings = new Ripples({ life: 1100, r0: 2, r1: 9, width: 1.2, opacity: 0.5 });
  let drawn = [];

  const overlay = new Overlay(map, (ctx, now, ov) => {
    const { C, blend, dots, glows, greys, trail } = look;
    bikeRipples.blend = blend;
    pings.blend = blend;
    const T = screenTransform(map);
    drawn = [];
    for (const v of movers.items.values()) {
      const alpha = movers.alpha(v, now);
      if (alpha < 0.02) continue;
      const [x, y] = movers.point(v, now);
      // no off-screen culling: a train's trail can reach well into view
      drawn.push({ item: v, v, p: { x: T.x(x), y: T.y(y) }, alpha, group: groupOf(v), lit: !selection || onRoutes(v, selection.routes) });
    }
    bikeRipples.draw(ctx, map, now);
    const unlit = drawn.filter((d) => !d.lit);
    drawRouteTrails(ctx, T, movers, unlit, now, { maxAge: TRAIL_MS, color: C.grey, width: trail.width, alpha: trail.alpha * 0.6 });
    for (const g of GROUPS) {
      drawRouteTrails(ctx, T, movers, drawn.filter((d) => d.lit && d.group === g), now,
        { maxAge: TRAIL_MS, color: C[g], width: g === 'train' ? trail.width + 0.6 : trail.width, alpha: trail.alpha, blend });
    }
    pings.draw(ctx, map, now);
    ctx.save();
    for (const { p, alpha, group, lit } of drawn) {
      if (!ov.visible(p) || !lit || !glows[group]) continue;
      ctx.globalCompositeOperation = blend;
      ctx.globalAlpha = alpha;
      drawSprite(ctx, glows[group], p.x, p.y);
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const { p, alpha, group, lit } of drawn) {
      if (!ov.visible(p)) continue;
      ctx.globalAlpha = alpha;
      drawSprite(ctx, lit ? dots[group] : greys[group], p.x, p.y);
    }
    ctx.restore();
  });

  let inView = true;
  new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; }).observe(frame);

  let pageScheme = pageTheme();
  new MutationObserver(() => {
    if (pageTheme() === pageScheme) return;
    pageScheme = pageTheme();
    setTheme(pageScheme);
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  setTheme(pageScheme); // the site may have switched while the map loaded

  const pingQueue = [];
  let seeded = false;

  // A poll brings ~15 s worth of fixes at once. Spreading the pings over the next interval, in
  // report order, avoids one big flash per poll.
  function schedulePings(moved, now) {
    const stamps = moved.map((v) => v.ts).filter(Boolean);
    const lo = Math.min(...stamps);
    const span = stamps.length ? Math.max(...stamps) - lo : 0;
    for (const v of moved) {
      const k = v.ts && span > 0 ? (v.ts - lo) / span : Math.random();
      pingQueue.push({ at: now + k * SEPTA_EVERY * 0.9, v });
    }
    pingQueue.sort((a, b) => a.at - b.at);
  }

  poll(async () => {
    const data = await fetchSepta({ tracks: !seeded });
    const now = performance.now();
    const moved = movers.update([...data.vehicles, ...data.trains], now, (next, prev) =>
      next.ts && prev.ts && next.ts > prev.ts ? (next.ts - prev.ts) * 1000 : SEPTA_EVERY);
    if (data.tracks) {
      // recent positions from the worker, so trails don't start empty
      for (const [id, points] of Object.entries(data.tracks)) {
        movers.seed(id, points.map(([x, y, age]) => [x / 1e5, y / 1e5, now - age * 1000]));
      }
    }
    seeded = true;
    if (inView && !reducedMotion()) schedulePings(moved, now);
    status.ok(data.t);
    overlay.render(now);
  }, { interval: SEPTA_EVERY, target: frame, onError: () => status.fail() });

  const watcher = new DockWatcher();
  const stationIndex = new Map(stations.map((s) => [s.id, s]));
  const bikeQueue = []; // dock changes, spread over the minute until the next poll
  let docks = new Map();

  poll(async () => {
    const snapshot = await loadStatus();
    docks = snapshot.stations;
    const now = performance.now();
    for (const change of watcher.update(snapshot)) {
      const s = stationIndex.get(change.id);
      if (s) bikeQueue.push({ at: now + Math.random() * 55_000, id: s.id, lngLat: [s.lng, s.lat] });
    }
    bikeQueue.sort((a, b) => a.at - b.at);
  }, { interval: INDEGO_EVERY, target: frame });

  onFrame((now) => {
    while (bikeQueue.length && bikeQueue[0].at <= now) {
      const event = bikeQueue.shift();
      const lit = !selection || selection.stations.has(event.id);
      if (inView && lit && !reducedMotion() && now - event.at < 3_000) bikeRipples.add(event.lngLat, now, look.C.bike);
    }
    while (pingQueue.length && pingQueue[0].at <= now) {
      const { at, v } = pingQueue.shift();
      if (now - at < 2_000 && !v.dying && (!selection || onRoutes(v, selection.routes))) {
        pings.add(movers.lngLat(v, now), now, look.C[groupOf(v)]);
      }
    }
    if (!inView || document.hidden) return;
    movers.sweep(now);
    if (!reducedMotion()) overlay.tick(now, 30);
  });

  function hitTest(event) {
    const { x, y } = localPoint(event, mapEl);
    let vehicle = null;
    let bestDistance = event.pointerType === 'touch' ? 18 : 11;
    for (const item of drawn) {
      const d = Math.hypot(item.p.x - x, item.p.y - y);
      if (d < bestDistance) [vehicle, bestDistance] = [item, d];
    }
    const [station] = vehicle ? [] : map.queryRenderedFeatures([[x - 7, y - 7], [x + 7, y + 7]], { layers: ['indego'] });
    return { x, y, vehicle, station };
  }

  function inspect(event) {
    if (event.target.closest('.live-legend, .live-head, .maplibregl-ctrl, .spot-card, .spot-marker')) return tip.hide();
    const { x, y, vehicle, station } = hitTest(event);
    if (vehicle) {
      const v = vehicle.v;
      const seen = v.ts ? `GPS ${ago(Date.now() - v.ts * 1000)}` : null;
      return tip.show(x, y, {
        title: v.mode === 'rail' ? `${vehicleName(v)} · train ${v.id.slice(1)}` : vehicleName(v),
        rows: [{ value: v.dest ? `to ${v.dest}` : 'In service', color: look.C[vehicle.group] }],
        note: [v.next ? `Next: ${v.next}` : null, lateness(v.late), seen].filter(Boolean).join(' · '),
      });
    }
    if (station) {
      const dock = docks.get(station.properties.id);
      return tip.show(x, y, {
        title: station.properties.name,
        rows: dock ? [{ value: `${fmt(dock.bikes)} bikes`, label: `· ${fmt(dock.docks)} open docks`, color: look.C.bike }] : [],
        note: 'Indego station',
      });
    }
    return tip.hide();
  }
  frame.addEventListener('pointermove', inspect);
  frame.addEventListener('pointerleave', () => tip.hide());
  map.on('movestart', () => tip.hide());
  map.on('click', (event) => {
    const target = event.originalEvent?.target;
    if (target?.closest?.('.spot-marker, .spot-card')) return;
    const { vehicle, station } = hitTest(event.originalEvent);
    if (vehicle || station) return inspect(event.originalEvent);
    if (selection) clearSelection();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && selection) clearSelection();
  });
}
