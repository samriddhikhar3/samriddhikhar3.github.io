// Scrollytelling map for the TOD Boston page. The step text is in the page itself
// (portfolio/1_TOD_Boston/index.qmd); this adds the sticky map and fills in [data-fill] and
// [data-compare] from tod-boston.json.
import { fetchVehicles } from '../feeds/mbta.js';
import { loadData } from '../lib/geo.js';
import { createMap } from '../lib/maplibre.js';
import { Movers, Overlay, TAU, drawTrails, onFrame, projector, reducedMotion } from '../lib/motion.js';
import { COLORS } from '../lib/palette.js';
import { poll } from '../lib/poll.js';
import { LiveStatus, Tooltip, fmt, h, legendKey, localPoint, money } from '../lib/ui.js';

const VEHICLES_EVERY = 10_000;
const TRAIL_MS = 4 * 60_000;
const NO_DATA = '#e2e4e7';
const INK = '#2b2f33';
const LINE_NAMES = { Red: 'Red Line', Mattapan: 'Mattapan trolley', Orange: 'Orange Line', Blue: 'Blue Line', Green: 'Green Line', Silver: 'Silver Line' };

const STEPS = {
  // lines stay muted while trains are showing so the trails stand out
  network: { camera: 'network', lines: 0.45, stations: 1, vehicles: 1, walkshed: 0, tracts: null },
  walkshed: { camera: 'county', lines: 0.55, stations: 1, vehicles: 0.3, walkshed: 1, tracts: null },
  tod: { camera: 'county', lines: 0.35, stations: 0.5, vehicles: 0, walkshed: 0.5, tracts: 'tod' },
  rent: { camera: 'county', lines: 0, stations: 0, vehicles: 0, walkshed: 'edge', tracts: 'rent' },
  income: { camera: 'county', lines: 0, stations: 0, vehicles: 0, walkshed: 'edge', tracts: 'income' },
  burden: { camera: 'county', lines: 0, stations: 0, vehicles: 0, walkshed: 'edge', tracts: 'rentPct' },
  close: { camera: 'network', lines: 0.45, stations: 1, vehicles: 1, walkshed: 0, tracts: null },
};

const CHOROPLETHS = {
  rent: { title: 'Median rent, 2020', format: (v) => `$${fmt(v)}`, unit: 'median rent' },
  income: { title: 'Median household income, 2020', format: (v) => `$${fmt(v / 1000)}k`, unit: 'median household income' },
  rentPct: { title: 'Rent as a share of income, 2020', format: (v) => `${v}%`, unit: 'of income goes to rent' },
};

const tractName = (id) => {
  const code = id.slice(5);
  const suffix = code.slice(4);
  return `Census tract ${Number.parseInt(code.slice(0, 4), 10)}${suffix === '00' ? '' : `.${suffix}`}`;
};

export async function mount(root) {
  const steps = [...root.querySelectorAll('.tod-step')];
  const mapEl = h('div', {
    class: 'live-map',
    role: 'img',
    'aria-label': 'Map of Boston’s rapid transit and Suffolk County census tracts. It changes with each step of the story.',
  });
  const status = new LiveStatus({ staleAfter: 60_000 });
  const legend = h('div', { class: 'live-legend live-legend--right' });
  const frame = h('div', { class: 'live-frame' },
    mapEl, h('div', { class: 'live-head' }, h('p', { class: 'live-eyebrow' }, 'How Boston moves'), status.el), legend);
  root.prepend(h('div', { class: 'tod-sticky' }, frame));
  const tip = new Tooltip(frame);

  const data = await loadData('tod-boston.json');
  const { summary, meta } = data;
  const routeColor = new Map(meta.routes.map((r) => [r.id, r.color]));
  const routeGroup = new Map(meta.routes.map((r) => [r.id, r.group]));
  fillNumbers(root, summary);
  buildTables(root, summary);

  // cards cover the left side on wide screens and the lower half on phones
  const isPhone = () => frame.getBoundingClientRect().width <= 760;
  const padding = () => {
    const { width, height } = frame.getBoundingClientRect();
    return isPhone()
      ? { top: 150, bottom: Math.round(height * 0.5), left: 16, right: 16 }
      : { top: 80, bottom: 40, left: Math.min(470, width * 0.4), right: 60 };
  };

  const { map } = await createMap(mapEl, {
    bounds: data.bounds.network,
    fitBoundsOptions: { padding: padding() },
    minZoom: 8.5,
    maxZoom: 15,
    scrollZoom: false,
    attribution: ['MBTA', 'U.S. Census Bureau'],
  });

  const fade = { duration: 500, delay: 0 };
  map.addSource('tracts', { type: 'geojson', data: data.tracts });
  map.addSource('walkshed', { type: 'geojson', data: data.walkshed });
  map.addSource('lines', { type: 'geojson', data: data.lines });
  map.addSource('stations', { type: 'geojson', data: data.stations });
  map.addLayer({ id: 'tracts', type: 'fill', source: 'tracts', paint: { 'fill-color': NO_DATA, 'fill-opacity': 0, 'fill-opacity-transition': fade } });
  map.addLayer({ id: 'tract-edges', type: 'line', source: 'tracts', paint: { 'line-color': '#ffffff', 'line-width': 0.7, 'line-opacity': 0, 'line-opacity-transition': fade } });
  map.addLayer({ id: 'walkshed', type: 'fill', source: 'walkshed', paint: { 'fill-color': COLORS.transit, 'fill-opacity': 0, 'fill-opacity-transition': fade } });
  map.addLayer({
    id: 'walkshed-edge',
    type: 'line',
    source: 'walkshed',
    paint: { 'line-color': COLORS.transitDeep, 'line-width': 1.4, 'line-opacity': 0, 'line-opacity-transition': fade, 'line-color-transition': fade },
  });
  const lineWidth = (a, b) => ['interpolate', ['linear'], ['zoom'], 10, a, 14, b];
  map.addLayer({
    id: 'line-casing',
    type: 'line',
    source: 'lines',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': '#ffffff', 'line-width': lineWidth(4.5, 8), 'line-opacity-transition': fade },
  });
  map.addLayer({
    id: 'lines',
    type: 'line',
    source: 'lines',
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: { 'line-color': ['get', 'color'], 'line-width': lineWidth(2.2, 4.5), 'line-opacity-transition': fade },
  });
  map.addLayer({
    id: 'stations',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-color': '#ffffff',
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 1.8, 14, 4],
      'circle-stroke-color': '#5c6166',
      'circle-stroke-width': 1,
      'circle-opacity-transition': fade,
      'circle-stroke-opacity-transition': fade,
    },
  });

  const movers = new Movers({ trail: TRAIL_MS });
  let vehicleAlpha = 1;
  let drawn = [];
  const overlay = new Overlay(map, (ctx, now, ov) => {
    drawn = [];
    if (vehicleAlpha <= 0.01) return;
    const byColor = new Map();
    for (const v of movers.items.values()) {
      const alpha = movers.alpha(v, now) * vehicleAlpha;
      if (alpha < 0.02) continue;
      const p = map.project(movers.position(v, now));
      if (!ov.visible(p, 120)) continue;
      const color = routeColor.get(v.route) ?? COLORS.transit;
      const entry = { item: v, v, p, alpha, color };
      drawn.push(entry);
      if (!byColor.has(color)) byColor.set(color, []);
      byColor.get(color).push(entry);
    }
    const project = projector(map, ov.width, ov.height);
    for (const [color, entries] of byColor) {
      drawTrails(ctx, project, entries, now, { maxAge: TRAIL_MS, color, alpha: 0.9 * vehicleAlpha, width: 3.2 });
    }
    for (const { p, alpha, color } of drawn) {
      if (!ov.visible(p)) continue;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5.6, 0, TAU);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.8, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  });
  onFrame((now) => {
    movers.sweep(now);
    if (movers.items.size && !reducedMotion()) overlay.tick(now, 30);
  });

  const vehicleCount = root.querySelectorAll('[data-fill="vehicles"]');
  poll(async () => {
    const vehicles = await fetchVehicles(meta.routes.map((r) => r.id));
    movers.update(vehicles, performance.now(), (next, prev) =>
      next.ts > prev.ts ? next.ts - prev.ts : VEHICLES_EVERY);
    status.ok();
    for (const el of vehicleCount) el.textContent = fmt(vehicles.length);
    if (reducedMotion()) overlay.render();
  }, { interval: VEHICLES_EVERY, target: root, onError: () => status.fail() });

  const tractColor = (mode) => {
    if (mode === 'tod') return ['case', ['==', ['get', 'tod'], 1], COLORS.transit, '#ffffff'];
    const [b1, b2, b3, b4] = meta.breaks[mode];
    return ['case', ['==', ['get', mode], null], NO_DATA,
      ['step', ['get', mode], COLORS.seq[0], b1, COLORS.seq[1], b2, COLORS.seq[2], b3, COLORS.seq[3], b4, COLORS.seq[4]]];
  };

  function renderLegend(name, state) {
    const items = [];
    if (state.tracts && CHOROPLETHS[state.tracts]) {
      const { title } = CHOROPLETHS[state.tracts];
      // short labels ($1.15k) so the breaks fit the narrow legend on phones
      const format = isPhone() && state.tracts === 'rent'
        ? (v) => `$${(v / 1000).toFixed(2).replace(/\.?0+$/, '')}k`
        : CHOROPLETHS[state.tracts].format;
      const [b1, b2, b3, b4] = meta.breaks[state.tracts];
      items.push(h('span', { class: 'live-legend__title' }, title),
        h('div', { class: 'live-scale' },
          h('div', { class: 'live-scale__bar' }, COLORS.seq.map((c) => h('span', { style: `background:${c}` }))),
          h('div', { class: 'live-scale__labels' },
            [b1, b2, b3, b4].map((b, k) => h('span', { style: `left:${(k + 1) * 20}%` }, format(b))))),
        legendKey('line', INK, 'Half a mile from a station'),
        legendKey('square', NO_DATA, 'No data'));
    } else if (state.tracts === 'tod') {
      items.push(h('span', { class: 'live-legend__title' }, 'Transit-rich tracts'),
        legendKey('wash', COLORS.transit, 'Center within half a mile'),
        legendKey('line', COLORS.transitDeep, 'Half-mile walkshed'));
    } else if (name === 'walkshed') {
      items.push(h('span', { class: 'live-legend__title' }, 'Ten-minute walk'),
        legendKey('wash', COLORS.transit, 'Within half a mile of a stop'));
    } else {
      items.push(h('span', { class: 'live-legend__title' }, 'MBTA rapid transit'),
        ...['Red', 'Orange', 'Blue', 'Green', 'Silver'].map((g) => legendKey('line', meta.routes.find((r) => r.group === g)?.color ?? '#999', LINE_NAMES[g])),
        legendKey('dot', INK, 'Train or bus, live'));
    }
    legend.replaceChildren(...items);
  }

  let active = null;
  function activate(name) {
    const state = STEPS[name];
    if (!state || name === active) return;
    active = name;
    for (const step of steps) step.classList.toggle('is-active', step.dataset.step === name);

    map.setPaintProperty('lines', 'line-opacity', state.lines);
    map.setPaintProperty('line-casing', 'line-opacity', state.lines);
    map.setPaintProperty('stations', 'circle-opacity', state.stations);
    map.setPaintProperty('stations', 'circle-stroke-opacity', state.stations);
    vehicleAlpha = state.vehicles;
    const edgeOnly = state.walkshed === 'edge';
    map.setPaintProperty('walkshed', 'fill-opacity', edgeOnly ? 0 : 0.14 * state.walkshed);
    map.setPaintProperty('walkshed-edge', 'line-opacity', edgeOnly ? 1 : 0.9 * state.walkshed);
    map.setPaintProperty('walkshed-edge', 'line-color', edgeOnly ? INK : COLORS.transitDeep);

    if (state.tracts) {
      map.setPaintProperty('tracts', 'fill-color', tractColor(state.tracts));
      map.setPaintProperty('tracts', 'fill-opacity', state.tracts === 'tod' ? ['case', ['==', ['get', 'tod'], 1], 0.45, 0] : 0.9);
      map.setPaintProperty('tract-edges', 'line-opacity', state.tracts === 'tod' ? 0 : 0.9);
    } else {
      map.setPaintProperty('tracts', 'fill-opacity', 0);
      map.setPaintProperty('tract-edges', 'line-opacity', 0);
    }
    renderLegend(name, state);
    map.fitBounds(data.bounds[state.camera], { padding: padding(), duration: reducedMotion() ? 0 : 1400 });
    overlay.render();
  }

  // lower on phones, so the step changes once the card is below the map subject
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) activate(entry.target.dataset.step);
  }, { rootMargin: isPhone() ? '-62% 0px -30% 0px' : '-45% 0px -45% 0px' });
  for (const step of steps) observer.observe(step);
  activate(steps[0]?.dataset.step ?? 'network');

  frame.addEventListener('pointermove', (event) => {
    if (event.target.closest('.live-legend, .live-head, .maplibregl-ctrl')) return tip.hide();
    const { x, y } = localPoint(event, mapEl);
    const state = STEPS[active];
    if (state.vehicles > 0.2) {
      const hit = drawn.find(({ p }) => Math.hypot(p.x - x, p.y - y) < 10);
      if (hit) {
        const group = routeGroup.get(hit.v.route);
        const route = meta.routes.find((r) => r.id === hit.v.route);
        return tip.show(x, y, {
          title: group === 'Silver' ? `Silver Line ${route?.name ?? ''}`.trim() : LINE_NAMES[group] ?? hit.v.route,
          rows: [{ value: hit.v.status === 'STOPPED_AT' ? 'Stopped at a station' : 'Between stations', color: routeColor.get(hit.v.route) }],
          note: hit.v.label ? `Vehicle ${hit.v.label}` : null,
        });
      }
    }
    if (state.stations > 0.4) {
      const [station] = map.queryRenderedFeatures([[x - 6, y - 6], [x + 6, y + 6]], { layers: ['stations'] });
      if (station) {
        return tip.show(x, y, {
          title: station.properties.name,
          note: station.properties.lines.split(',').map((g) => LINE_NAMES[g] ?? g).join(' · '),
        });
      }
    }
    if (state.tracts) {
      const [tract] = map.queryRenderedFeatures([[x, y], [x, y]], { layers: ['tracts'] });
      if (tract) {
        const p = tract.properties;
        const mode = CHOROPLETHS[state.tracts];
        const value = mode ? p[state.tracts] : null;
        return tip.show(x, y, {
          title: tractName(p.id),
          rows: mode ? [{ value: value == null ? 'No data' : state.tracts === 'rentPct' ? `${value}%` : money(value), label: value == null ? '' : mode.unit }] : [],
          note: p.tod ? 'Transit-rich tract' : 'Outside the half-mile walksheds',
        });
      }
    }
    return tip.hide();
  });
  frame.addEventListener('pointerleave', () => tip.hide());
  new ResizeObserver(() => map.resize()).observe(frame);
}

function fillNumbers(root, s) {
  const pct = (v) => (v == null ? '–' : `${v.toFixed(1)}%`);
  const values = {
    stations: fmt(s.stations.county),
    tracts: fmt(s.tracts.total),
    todTracts: fmt(s.tracts.tod),
  };
  for (const year of ['2016', '2020']) {
    for (const group of ['tod', 'other']) {
      const g = s[year][group];
      const suffix = `${group === 'tod' ? 'Tod' : 'Other'}${year}`;
      values[`rent${suffix}`] = money(g.rent);
      values[`income${suffix}`] = money(g.income);
      values[`burden${suffix}`] = pct(g.rentPct);
    }
  }
  for (const el of root.querySelectorAll('[data-fill]')) {
    if (values[el.dataset.fill] != null) el.textContent = values[el.dataset.fill];
  }
}

function buildTables(root, s) {
  const metrics = {
    rent: { key: 'rent', format: money, dollars: true },
    income: { key: 'income', format: money, dollars: true },
    burden: { key: 'rentPct', format: (v) => (v == null ? '–' : `${v.toFixed(1)}%`) },
  };
  for (const el of root.querySelectorAll('[data-compare]')) {
    const metric = metrics[el.dataset.compare];
    if (!metric) continue;
    const row = (label, group) => h('tr', null, h('td', null, label),
      h('td', null, metric.format(s['2016'][group][metric.key])),
      h('td', null, metric.format(s['2020'][group][metric.key])));
    el.replaceChildren(h('table', { class: 'tod-compare' },
      h('thead', null, h('tr', null, h('th', null, 'Tract average'), h('th', null, metric.dollars ? '2016*' : '2016'), h('th', null, '2020'))),
      h('tbody', null, row('Transit-rich', 'tod'), row('Rest of county', 'other'))));
  }
}
