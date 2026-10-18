// DevTracker's 2022 hot spots against the last 30 days of building permits, with a day-by-day
// replay. The "compact" variant on the home page leaves out the eyebrow.
import { buildingPermits, describePermit, prettyAddress } from '../feeds/permits.js';
import { featureCollection, loadData, point } from '../lib/geo.js';
import { addCityFrame, createMap, padBounds } from '../lib/maplibre.js';
import { Overlay, Ripples, onFrame, reducedMotion } from '../lib/motion.js';
import { COLORS, rgba } from '../lib/palette.js';
import { Tooltip, fmt, h, legendKey, localPoint, plural, shortDate, svg, truncate, weekdayDate } from '../lib/ui.js';

const DAYS = 30;
const STEP_MS = 420; // per day of replay
const HOT = COLORS.seq[2];

const dayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const PLAY = 'M3 1.5v11l9.5-5.5Z';
const PAUSE = 'M2.5 1.5h3v11h-3ZM8.5 1.5h3v11h-3Z';

export async function mount(root, { variant } = {}) {
  const compact = variant === 'compact';
  const mapEl = h('div', {
    class: 'live-map',
    role: 'img',
    'aria-label': 'Map of Philadelphia comparing 2022 construction hot spots with building permits issued in the last 30 days.',
  });
  const through = h('span', { class: 'live-status__text' }, 'Loading permits…');
  const frame = h('div', { class: `live-frame ${compact ? 'live-frame--medium' : 'live-frame--tall'}` },
    mapEl,
    h('div', { class: 'live-head' }, compact ? null : h('p', { class: 'live-eyebrow' }, 'Is the pattern holding?'),
      h('span', { class: 'live-status', dataset: { state: 'live' } }, h('span', { class: 'live-status__dot', 'aria-hidden': 'true' }), through)),
    h('div', { class: 'live-legend' },
      legendKey('wash', HOT, '2022 hot spot (500 ft cell)'),
      legendKey('dot', COLORS.dev, 'Building permit, last 30 days'),
      legendKey('dot-lg', COLORS.dev, 'Issued on the day shown')));

  const icon = svg('path', { d: PLAY, fill: 'currentColor' });
  const playButton = h('button', { class: 'dev-play', type: 'button', 'aria-label': 'Play the last 30 days' },
    svg('svg', { viewBox: '0 0 14 14', 'aria-hidden': 'true' }, icon));
  const dayLabel = h('strong', null, '');
  const dayDetail = h('span', null, '');
  const bars = svg('svg', { class: 'dev-bars', tabindex: '0', role: 'slider', 'aria-label': 'Day of the replay' });

  root.replaceChildren(
    frame,
    h('div', { class: 'dev-replay' }, playButton, h('div', null, h('div', { class: 'dev-day' }, dayLabel, dayDetail), bars)),
  );
  const tip = new Tooltip(frame);

  const [limits, grid, permits] = await Promise.all([
    loadData('philly-limits.json'),
    loadData('dev-hotspots-2022.json'),
    buildingPermits(DAYS + 1),
  ]);
  const { meta } = grid;
  const size = meta.cellSizeM;
  const unproject = (x, y) => [x / meta.kx + meta.ref[0], y / meta.ky + meta.ref[1]];
  const hotCells = new Map(grid.hot.map(([i, j, count]) => [`${i},${j}`, count]));
  const cellOf = (lng, lat) => {
    const x = (lng - meta.ref[0]) * meta.kx;
    const y = (lat - meta.ref[1]) * meta.ky;
    return `${Math.floor((x - meta.x0) / size)},${Math.floor((y - meta.y0) / size)}`;
  };

  // count back from the newest permit, not today (the data only updates nightly)
  const newest = permits.reduce((max, p) => Math.max(max, p.issued || 0), 0);
  const days = Array.from({ length: DAYS }, (_, k) => newest - (DAYS - 1 - k) * 864e5);
  const keys = days.map((t) => dayKey.format(t));
  const dayIndex = new Map(keys.map((k, i) => [k, i]));
  const items = permits
    .map((p) => ({ ...p, day: dayIndex.get(dayKey.format(p.issued)), hot: hotCells.has(cellOf(p.lng, p.lat)) }))
    .filter((p) => p.day !== undefined);
  const perDay = keys.map((_, i) => items.filter((p) => p.day === i));

  through.textContent = `Permits through ${shortDate.format(newest)} · refreshed nightly`;

  // fit between the header and the legend, which wraps onto more lines on phones
  const box = frame.getBoundingClientRect();
  const { bottom: headBottom } = frame.querySelector('.live-head').getBoundingClientRect();
  const { top: legendTop } = frame.querySelector('.live-legend').getBoundingClientRect();
  const { map, maplibregl } = await createMap(mapEl, {
    bounds: limits.bbox,
    fitBoundsOptions: {
      padding: { top: Math.round(headBottom - box.top + 14), bottom: Math.round(box.bottom - legendTop + 14), left: 24, right: 24 },
    },
    maxBounds: padBounds(limits.bbox, 0.5),
    minZoom: 9.5,
    maxZoom: 17,
    attribution: ['City of Philadelphia L&I'],
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  addCityFrame(map, limits, { maskOpacity: 0.7 });

  map.addSource('hot', {
    type: 'geojson',
    data: featureCollection(grid.hot.map(([i, j, count]) => {
      const x = meta.x0 + i * size;
      const y = meta.y0 + j * size;
      return {
        type: 'Feature',
        properties: { count },
        geometry: { type: 'Polygon', coordinates: [[unproject(x, y), unproject(x + size, y), unproject(x + size, y + size), unproject(x, y + size), unproject(x, y)]] },
      };
    })),
  });
  map.addLayer({ id: 'hot', type: 'fill', source: 'hot', paint: { 'fill-color': HOT, 'fill-opacity': 0.42 } });
  map.addLayer({
    id: 'hot-edge',
    type: 'line',
    source: 'hot',
    minzoom: 13,
    paint: { 'line-color': COLORS.seq[3], 'line-width': 0.6, 'line-opacity': 0.6 },
  });

  map.addSource('permits', {
    type: 'geojson',
    data: featureCollection(items.map((p) => point(p.lng, p.lat, {
      day: p.day,
      hot: p.hot ? 1 : 0,
      address: prettyAddress(p.address),
      kind: describePermit(p),
      issued: p.issued,
      scope: truncate(p.scope, 140),
    }))),
  });
  map.addLayer({
    id: 'permits',
    type: 'circle',
    source: 'permits',
    paint: {
      'circle-color': COLORS.dev,
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 1.2,
    },
  });

  const ripples = new Ripples({ life: 1400, r0: 3, r1: 14, width: 1.6 });
  const overlay = new Overlay(map, (ctx, now) => ripples.draw(ctx, map, now));
  onFrame((now) => {
    if (ripples.active) overlay.render(now);
  });
  const rippleColor = rgba(COLORS.dev, 1);

  let current = DAYS - 1;
  let timer = 0;

  function setDay(i, { animate = false } = {}) {
    current = Math.max(0, Math.min(DAYS - 1, i));
    const today = ['==', ['get', 'day'], current];
    map.setFilter('permits', ['<=', ['get', 'day'], current]);
    map.setPaintProperty('permits', 'circle-radius',
      ['interpolate', ['linear'], ['zoom'], 10, ['case', today, 4.6, 2.5], 15, ['case', today, 7.5, 4.5]]);
    map.setPaintProperty('permits', 'circle-opacity', ['case', today, 1, 0.62]);
    map.setPaintProperty('permits', 'circle-stroke-opacity', ['case', today, 1, 0.62]);
    const list = perDay[current];
    const hot = list.filter((p) => p.hot).length;
    dayLabel.textContent = weekdayDate.format(days[current]);
    dayDetail.textContent = `${plural(list.length, 'permit')} · ${fmt(hot)} in hot spots`;
    bars.setAttribute('aria-valuenow', String(current));
    bars.setAttribute('aria-valuetext', `${weekdayDate.format(days[current])}: ${plural(list.length, 'permit')}`);
    drawBars();
    if (animate && !reducedMotion()) {
      const now = performance.now();
      list.forEach((p, k) => ripples.add([p.lng, p.lat], now + (k / Math.max(1, list.length)) * STEP_MS, rippleColor));
    }
  }

  function play() {
    if (timer) return;
    if (current >= DAYS - 1) setDay(0, { animate: true });
    icon.setAttribute('d', PAUSE);
    playButton.setAttribute('aria-label', 'Pause the replay');
    timer = setInterval(() => {
      if (current >= DAYS - 1) return pause();
      setDay(current + 1, { animate: true });
    }, STEP_MS);
  }

  function pause() {
    clearInterval(timer);
    timer = 0;
    icon.setAttribute('d', PLAY);
    playButton.setAttribute('aria-label', 'Play the last 30 days');
  }

  playButton.addEventListener('click', () => (timer ? pause() : play()));

  function drawBars() {
    const width = bars.clientWidth || 600;
    const height = 56;
    const base = 38;
    const gap = 2;
    const w = (width - gap * (DAYS - 1)) / DAYS;
    const max = Math.max(1, ...perDay.map((d) => d.length));
    bars.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const marks = perDay.map((list, k) => {
      const barHeight = list.length ? Math.max(2, (list.length / max) * (base - 4)) : 0;
      const x = k * (w + gap);
      const r = Math.min(2, w / 2, barHeight);
      const state = k === current ? ' is-current' : k > current ? ' is-future' : '';
      return svg('path', {
        class: `bar${state}`,
        d: `M${x},${base}V${base - barHeight + r}Q${x},${base - barHeight} ${x + r},${base - barHeight}` +
          `H${x + w - r}Q${x + w},${base - barHeight} ${x + w},${base - barHeight + r}V${base}Z`,
      }, svg('title', {}, `${weekdayDate.format(days[k])}: ${plural(list.length, 'permit')}`));
    });
    const tick = (k, anchor) => svg('text', {
      class: 'tick',
      x: anchor === 'start' ? 0 : anchor === 'end' ? width : k * (w + gap) + w / 2,
      y: height - 3,
      'text-anchor': anchor,
    }, shortDate.format(days[k]));
    bars.replaceChildren(...marks,
      svg('line', { class: 'baseline', x1: 0, x2: width, y1: base + 0.5, y2: base + 0.5 }),
      tick(0, 'start'), tick(Math.floor(DAYS / 2), 'middle'), tick(DAYS - 1, 'end'));
  }
  new ResizeObserver(() => drawBars()).observe(bars);
  bars.setAttribute('aria-valuemin', '0');
  bars.setAttribute('aria-valuemax', String(DAYS - 1));

  const dayAt = (event) => {
    const r = bars.getBoundingClientRect();
    return Math.floor(((event.clientX - r.left) / r.width) * DAYS);
  };
  bars.addEventListener('pointerdown', (event) => {
    pause();
    bars.setPointerCapture(event.pointerId);
    setDay(dayAt(event));
  });
  bars.addEventListener('pointermove', (event) => {
    if (bars.hasPointerCapture(event.pointerId) && dayAt(event) !== current) setDay(dayAt(event));
  });
  bars.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
    if (step) setDay(current + step);
    else if (event.key === 'Home') setDay(0);
    else if (event.key === 'End') setDay(DAYS - 1);
    else if (event.key === ' ' || event.key === 'Enter') timer ? pause() : play();
    else return;
    event.preventDefault();
    if (step || event.key === 'Home' || event.key === 'End') pause();
  });

  setDay(DAYS - 1);
  // autoplay once, the first time it's mostly in view
  const autoplay = new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) return;
    autoplay.disconnect();
    if (!reducedMotion()) play();
  }, { threshold: 0.6 });
  autoplay.observe(frame);

  frame.addEventListener('pointermove', (event) => {
    if (event.target.closest('.live-legend, .live-head, .maplibregl-ctrl')) return tip.hide();
    const { x, y } = localPoint(event, mapEl);
    const box = [[x - 7, y - 7], [x + 7, y + 7]];
    const [permit] = map.queryRenderedFeatures(box, { layers: ['permits'] });
    if (permit) {
      const p = permit.properties;
      return tip.show(x, y, {
        title: p.address,
        rows: [{ value: p.kind, color: COLORS.dev }],
        note: [`Issued ${shortDate.format(p.issued)}`, p.hot ? 'inside a 2022 hot spot' : null, p.scope].filter(Boolean).join(' · '),
      });
    }
    const [cell] = map.queryRenderedFeatures([[x, y], [x, y]], { layers: ['hot'] });
    if (cell) {
      return tip.show(x, y, {
        title: '2022 construction hot spot',
        rows: [{ value: plural(cell.properties.count, 'building permit'), label: 'in this 500 ft cell in 2022', color: HOT }],
      });
    }
    return tip.hide();
  });
  frame.addEventListener('pointerleave', () => tip.hide());
}
