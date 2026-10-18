// Both basemaps are recolored OpenFreeMap Positron. "night" is loosely based on Snazzy Maps'
// Neon Dark, kept to black, grey and cyan so it doesn't clash with the transit colors.
const VERSION = '6.11.2';
const CDN = `https://cdn.jsdelivr.net/npm/maplibre-gl@${VERSION}/dist`;
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

let library;
let positron;
const basemaps = {};

export function loadMapLibre() {
  if (!library) {
    if (!document.querySelector('link[data-maplibre]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${CDN}/maplibre-gl.css`;
      link.dataset.maplibre = VERSION;
      document.head.append(link);
    }
    library = import(`${CDN}/maplibre-gl.mjs`);
  }
  return library;
}

const HIDDEN_LAYERS = new Set([
  'highway-shield-non-us',
  'highway-shield-us-interstate',
  'road_shield_us',
  'airport',
  'highway-name-path',
  'aeroway-taxiway',
]);

// street grid: at night it sits at the bottom at 10%, without highways
const GRID = new Set([
  'highway_path', 'highway_minor', 'highway_major_casing', 'highway_major_inner', 'highway_major_subtle',
  'tunnel_motorway_casing', 'tunnel_motorway_inner', 'highway_motorway_casing', 'highway_motorway_inner',
  'highway_motorway_subtle', 'highway_motorway_bridge_casing', 'highway_motorway_bridge_inner',
]);
const GRID_OPACITY = 0.1;
const HIGHWAY = /motorway/;

const LIGHT = {
  background: '#f4f4f2',
  label: '#6b7177',
  labelSoft: '#9aa0a6',
  labelWater: '#7f95a3',
  mask: '#f4f4f2',
  maskOpacity: 0.6,
  outline: '#9aa0a6',
};

const NIGHT = {
  background: '#000000',
  label: '#7fa3ad',
  labelSoft: '#4d6b74',
  labelWater: '#3fb4c9',
  mask: '#000000',
  maskOpacity: 0.55,
  outline: '#0fa5bf',
  shore: '#00d9ff',
  // by Positron layer id
  layers: {
    park: '#020b06',
    water: '#00262e',
    landcover_ice_shelf: '#03090b',
    landcover_glacier: '#03090b',
    landuse_residential: '#020202',
    landcover_wood: '#020905',
    waterway: '#0b8ea6',
    building: '#0a0a0c',
    'aeroway-area': '#07070a',
    'aeroway-runway-casing': '#141418',
    'aeroway-runway': '#141418',
    road_area_pier: '#000000',
    road_pier: '#000000',
    highway_path: '#8f969c',
    highway_minor: '#b4bac0',
    highway_major_casing: '#000000',
    highway_major_inner: '#d5dade',
    highway_major_subtle: '#d5dade',
    tunnel_motorway_casing: '#000000',
    tunnel_motorway_inner: '#a8aeb4',
    highway_motorway_casing: '#000000',
    highway_motorway_inner: '#eef1f3',
    highway_motorway_subtle: '#eef1f3',
    highway_motorway_bridge_casing: '#000000',
    highway_motorway_bridge_inner: '#eef1f3',
    railway_transit: '#123238',
    railway_service: '#123238',
    railway: '#123238',
    railway_transit_dashline: '#000000',
    railway_service_dashline: '#000000',
    railway_dashline: '#000000',
    boundary_3: '#0b3740',
    boundary_2: '#0b3740',
    boundary_disputed: '#0b3740',
  },
};

function tuneLight(layer) {
  const paint = { ...layer.paint };
  switch (layer.id) {
    case 'background': paint['background-color'] = LIGHT.background; break;
    case 'water': paint['fill-color'] = '#d3dde3'; break;
    case 'waterway': paint['line-color'] = '#d3dde3'; break;
    case 'park': paint['fill-color'] = '#e6eae3'; break;
    case 'building':
      paint['fill-color'] = '#ebeae6';
      paint['fill-outline-color'] = '#e1e0dc';
      break;
  }
  // most of these don't set an opacity, so restyle() wouldn't undo the night 10% otherwise
  if (GRID.has(layer.id)) paint['line-opacity'] ??= 1;
  return tuneLabels(layer, paint, LIGHT);
}

function tuneNight(layer) {
  const paint = { ...layer.paint };
  const color = NIGHT.layers[layer.id];
  if (layer.type === 'background') paint['background-color'] = NIGHT.background;
  else if (layer.type === 'fill' && color) {
    paint['fill-color'] = color;
    if ('fill-outline-color' in paint) paint['fill-outline-color'] = layer.id === 'building' ? '#141418' : color;
  } else if (layer.type === 'line' && color) {
    paint['line-color'] = color;
  }
  if (GRID.has(layer.id)) paint['line-opacity'] = HIGHWAY.test(layer.id) ? 0 : GRID_OPACITY;
  return tuneLabels(layer, paint, NIGHT);
}

function tuneLabels(layer, paint, theme) {
  if (layer.type === 'symbol') {
    const water = layer.id.startsWith('water');
    const minor = /^(highway-name|label_other|label_village)/.test(layer.id);
    paint['text-color'] = water ? theme.labelWater : minor ? theme.labelSoft : theme.label;
    paint['text-halo-color'] = theme.background;
    paint['text-halo-width'] = 1.2;
    paint['text-halo-blur'] = 0;
  }
  return { ...layer, paint };
}

// shoreline glow, only visible at night (the light style keeps the layer so restyle() works)
const waterEdge = (water, theme) => ({
  id: 'water-edge',
  type: 'line',
  source: water.source,
  'source-layer': water['source-layer'],
  filter: water.filter,
  paint: {
    'line-color': NIGHT.shore,
    'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 14, 1.6],
    'line-blur': 0.6,
    'line-opacity': theme === 'night' ? 0.85 : 0,
  },
});

export function loadBasemap(theme = 'light') {
  if (!positron) {
    positron = fetch(STYLE_URL).then((res) => {
      if (!res.ok) throw new Error(`Basemap style: ${res.status}`);
      return res.json();
    });
  }
  basemaps[theme] ??= positron.then((style) => {
    const tune = theme === 'night' ? tuneNight : tuneLight;
    let layers = [];
    for (const layer of style.layers) {
      if (HIDDEN_LAYERS.has(layer.id)) continue;
      layers.push(tune(layer));
      if (layer.id === 'water') layers.push(waterEdge(layer, theme));
    }
    if (theme === 'night') {
      const [background, ...rest] = layers;
      layers = [background, ...rest.filter((l) => GRID.has(l.id)), ...rest.filter((l) => !GRID.has(l.id))];
    }
    return { ...style, layers };
  });
  return basemaps[theme];
}

export async function createMap(container, { attribution = [], theme = 'light', ...options } = {}) {
  const [maplibregl, style] = await Promise.all([loadMapLibre(), loadBasemap(theme)]);
  const map = new maplibregl.Map({
    container,
    style: structuredClone(style),
    attributionControl: false,
    cooperativeGestures: true,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    maxPitch: 0,
    fadeDuration: 0,
    ...options,
  });
  map.touchZoomRotate?.disableRotation();
  map.keyboard?.disableRotation();
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: attribution }), 'bottom-right');
  await new Promise((resolve) => map.once('load', resolve));
  // MapLibre expands the attribution while the map loads; start it collapsed
  const credits = container.querySelector('.maplibregl-ctrl-attrib');
  const fold = () => {
    credits?.classList.remove('maplibregl-compact-show');
    credits?.removeAttribute('open');
  };
  fold();
  map.once('idle', fold);
  return { map, maplibregl };
}

const signedArea = (ring) =>
  ring.reduce((sum, [x1, y1], i) => {
    const [x2, y2] = ring[(i + 1) % ring.length];
    return sum + (x1 * y2 - x2 * y1);
  }, 0) / 2;

export function outsideMask(feature) {
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]]; // counter-clockwise
  const holes = polygons.map(([outer]) => (signedArea(outer) > 0 ? [...outer].reverse() : outer));
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [world, ...holes] } };
}

// Swaps basemap paint in place instead of setStyle(), which would drop the widget's layers.
export async function restyle(map, theme) {
  const style = await loadBasemap(theme);
  for (const layer of style.layers) {
    if (!map.getLayer(layer.id)) continue;
    for (const [key, value] of Object.entries(layer.paint ?? {})) map.setPaintProperty(layer.id, key, value);
  }
  // match the theme's layer order (the night grid sits lower); going top-down keeps the
  // widget's layers above the basemap
  const ids = style.layers.map((l) => l.id).filter((id) => map.getLayer(id));
  for (let i = ids.length - 2; i >= 0; i--) map.moveLayer(ids[i], ids[i + 1]);
  const colors = theme === 'night' ? NIGHT : LIGHT;
  if (map.getLayer('city-mask')) {
    map.setPaintProperty('city-mask', 'fill-color', colors.mask);
    map.setPaintProperty('city-mask', 'fill-opacity', colors.maskOpacity);
  }
  if (map.getLayer('city-outline')) map.setPaintProperty('city-outline', 'line-color', colors.outline);
}

export function addCityFrame(map, limits, { theme = 'light', maskOpacity } = {}) {
  const colors = theme === 'night' ? NIGHT : LIGHT;
  map.addSource('city-mask', { type: 'geojson', data: outsideMask(limits) });
  map.addSource('city-limits', { type: 'geojson', data: limits });
  map.addLayer({
    id: 'city-mask',
    type: 'fill',
    source: 'city-mask',
    paint: { 'fill-color': colors.mask, 'fill-opacity': maskOpacity ?? colors.maskOpacity },
  });
  map.addLayer({
    id: 'city-outline',
    type: 'line',
    source: 'city-limits',
    paint: { 'line-color': colors.outline, 'line-width': 1.2, 'line-opacity': 0.9 },
  });
}

export function padBounds([w, s, e, n], fraction = 0.25) {
  const dx = (e - w) * fraction;
  const dy = (n - s) * fraction;
  return [w - dx, s - dy, e + dx, n + dy];
}
