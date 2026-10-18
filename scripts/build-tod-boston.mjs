// Data for the TOD Boston scroll story, following the original analysis: Suffolk County tracts
// with ACS 2016 and 2020 estimates (2016 dollars x 1.10, like the original), rapid transit
// stops, half-mile walksheds, and TOD tracts picked by centroid.
import * as turf from '@turf/turf';
import { DATA_DIR, getJson, roundGeometry, sleep, writeJson } from './lib.mjs';

const MBTA = 'https://api-v3.mbta.com';
const RAIL = ['Red', 'Mattapan', 'Orange', 'Blue', 'Green-B', 'Green-C', 'Green-D', 'Green-E'];
const SILVER = ['741', '742', '743', '751', '749', '746'];
const VARIABLES = {
  pop: 'B25026_001E', // total population in occupied housing units
  income: 'B19013_001E', // median household income
  rent: 'B25058_001E', // median contract rent
  rentPct: 'B25071_001E', // median gross rent as a share of household income
};
const DOLLARS_2016_TO_2020 = 1.1;

// keyless MBTA access is limited to 20 requests a minute
let lastMbtaCall = 0;
async function mbta(path) {
  const wait = lastMbtaCall + 3200 - Date.now();
  if (wait > 0) await sleep(wait);
  lastMbtaCall = Date.now();
  return getJson(`${MBTA}${path}`);
}

function decodePolyline(text) {
  const coords = [];
  let lat = 0;
  let lng = 0;
  let i = 0;
  while (i < text.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = text.charCodeAt(i++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    coords.push([lng / 1e5, lat / 1e5]);
  }
  return coords;
}

const lineGroup = (route) =>
  route.startsWith('Green') ? 'Green' : SILVER.includes(route) ? 'Silver' : route;

async function loadRoutes() {
  const res = await mbta(`/routes?filter[id]=${[...RAIL, ...SILVER].join(',')}`);
  return res.data.map((r) => ({
    id: r.id,
    name: r.attributes.short_name && SILVER.includes(r.id) ? r.attributes.short_name : r.attributes.long_name,
    color: `#${r.attributes.color}`,
    group: lineGroup(r.id),
  }));
}

async function loadLines(routes) {
  const res = await mbta(`/route_patterns?filter[route]=${routes.map((r) => r.id).join(',')}&include=representative_trip.shape`);
  const trips = new Map(res.included.filter((x) => x.type === 'trip').map((t) => [t.id, t]));
  const shapes = new Map(res.included.filter((x) => x.type === 'shape').map((s) => [s.id, s.attributes.polyline]));
  const byRoute = new Map();
  for (const pattern of res.data) {
    if (pattern.attributes.typicality !== 1 || pattern.attributes.direction_id !== 0) continue;
    const route = pattern.relationships.route.data.id;
    const trip = trips.get(pattern.relationships.representative_trip.data.id);
    const polyline = shapes.get(trip?.relationships?.shape?.data?.id);
    if (!polyline) continue;
    if (!byRoute.has(route)) byRoute.set(route, []);
    byRoute.get(route).push(decodePolyline(polyline));
  }
  return routes
    .filter((r) => byRoute.has(r.id))
    .map((r) => {
      const line = turf.simplify(turf.multiLineString(byRoute.get(r.id)), { tolerance: 0.00003 });
      return turf.feature(roundGeometry(line.geometry), { route: r.id, group: r.group, name: r.name, color: r.color });
    });
}

async function loadStations(routes) {
  const stations = new Map();
  for (const route of routes) {
    const res = await mbta(`/stops?filter[route]=${route.id}&include=parent_station`);
    const parents = new Map((res.included || []).map((p) => [p.id, p]));
    for (const stop of res.data) {
      const station = parents.get(stop.relationships?.parent_station?.data?.id) || stop;
      if (!stations.has(station.id)) {
        stations.set(station.id, {
          id: station.id,
          name: station.attributes.name,
          lng: station.attributes.longitude,
          lat: station.attributes.latitude,
          lines: new Set(),
        });
      }
      stations.get(station.id).lines.add(route.group);
    }
  }
  return [...stations.values()];
}

async function loadTracts(service, layer) {
  const where = encodeURIComponent("STATE='25' AND COUNTY='025'");
  const url = `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/${service}/MapServer/${layer}/query` +
    `?where=${where}&outFields=GEOID,AREALAND&outSR=4326&geometryPrecision=6&f=geojson`;
  const fc = await getJson(url);
  // water-only tracts (the harbor)
  return fc.features.filter((f) => f.properties.AREALAND === undefined || Number(f.properties.AREALAND) > 0);
}

const toNumber = (value) => {
  const x = Number(String(value ?? '').replace(/[,+]/g, ''));
  return Number.isFinite(x) && x >= 0 ? x : null; // ACS uses negative codes for missing values
};

async function loadAcs(year) {
  const byTract = new Map();
  for (const [key, variable] of Object.entries(VARIABLES)) {
    const table = variable.split('_')[0];
    const { response } = await getJson(
      `https://data.census.gov/api/access/data/table?id=ACSDT5Y${year}.${table}&g=050XX00US25025$1400000`);
    const [header, ...rows] = response.data;
    const geo = header.indexOf('GEO_ID');
    const col = header.indexOf(variable);
    if (col < 0) throw new Error(`${variable} missing from ${year} table ${table}`);
    for (const row of rows) {
      const id = row[geo].replace(/^1400000US/, '');
      if (!byTract.has(id)) byTract.set(id, {});
      byTract.get(id)[key] = toNumber(row[col]);
    }
    await sleep(300);
  }
  return byTract;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function summarize(tracts, acs, isTod, dollars) {
  const groups = { tod: [], other: [] };
  for (const t of tracts) {
    const values = acs.get(t.properties.GEOID);
    if (values) groups[isTod(t) ? 'tod' : 'other'].push(values);
  }
  const avg = (rows, key, factor = 1) => {
    const m = mean(rows.map((r) => r[key]).filter((x) => x != null));
    return m == null ? null : Math.round(m * factor * 10) / 10;
  };
  return Object.fromEntries(Object.entries(groups).map(([group, rows]) => [group, {
    tracts: rows.length,
    pop: avg(rows, 'pop'),
    income: avg(rows, 'income', dollars),
    rent: avg(rows, 'rent', dollars),
    rentPct: avg(rows, 'rentPct'),
  }]));
}

function quintileBreaks(values, step) {
  const sorted = values.filter((x) => x != null).sort((a, b) => a - b);
  return [0.2, 0.4, 0.6, 0.8].map((q) => Math.round(sorted[Math.floor(q * (sorted.length - 1))] / step) * step);
}

console.log('MBTA routes, lines and stations…');
const routes = await loadRoutes();
const lines = await loadLines(routes);
const stations = await loadStations(routes);

console.log('Census tracts and ACS estimates…');
const tracts2020 = await loadTracts('tigerWMS_Census2020', 6);
const tracts2010 = await loadTracts('tigerWMS_Census2010', 14);
const acs2020 = await loadAcs(2020);
const acs2016 = await loadAcs(2016);

const inSuffolk = (point) => tracts2020.some((t) => turf.booleanPointInPolygon(point, t));
for (const s of stations) s.suffolk = inSuffolk([s.lng, s.lat]);
const countyStations = stations.filter((s) => s.suffolk);

const walkshed = turf.union(turf.featureCollection(
  countyStations.map((s) => turf.buffer(turf.point([s.lng, s.lat]), 0.5, { units: 'miles', steps: 32 }))));
const isTod = (tract) => turf.booleanPointInPolygon(turf.centerOfMass(tract), walkshed);

const tractFeatures = tracts2020.map((t) => {
  const v = acs2020.get(t.properties.GEOID) || {};
  const simple = turf.simplify(t, { tolerance: 0.00008 });
  return turf.feature(roundGeometry(simple.geometry), {
    id: t.properties.GEOID,
    tod: isTod(t) ? 1 : 0,
    pop: v.pop ?? null,
    income: v.income ?? null,
    rent: v.rent ?? null,
    rentPct: v.rentPct ?? null,
  });
});

const summary = {
  2016: summarize(tracts2010, acs2016, isTod, DOLLARS_2016_TO_2020),
  2020: summarize(tracts2020, acs2020, isTod, 1),
};
const todTracts = tractFeatures.filter((t) => t.properties.tod).length;
console.log(`${countyStations.length}/${stations.length} stations in Suffolk County; ` +
  `${todTracts}/${tractFeatures.length} TOD tracts (2020)`);
console.table(Object.fromEntries(Object.entries(summary).flatMap(([y, g]) =>
  Object.entries(g).map(([k, v]) => [`${y} ${k}`, v]))));

const lineCollection = turf.featureCollection(lines);
await writeJson(`${DATA_DIR}/tod-boston.json`, {
  meta: {
    studyArea: 'Suffolk County, MA (Boston, Chelsea, Revere, Winthrop)',
    method: 'TOD tracts: census tract centroid within half a mile of an MBTA rapid transit or Silver Line stop in Suffolk County',
    dollars: '2016 values multiplied by 1.10 to 2020 dollars, as in the original analysis',
    sources: ['ACS 5-year estimates 2012–2016 and 2016–2020 (data.census.gov)', 'Census TIGERweb tracts', 'MBTA V3 API'],
    generated: new Date().toISOString().slice(0, 10),
    routes,
    breaks: {
      rent: quintileBreaks(tractFeatures.map((t) => t.properties.rent), 50),
      income: quintileBreaks(tractFeatures.map((t) => t.properties.income), 5000),
      rentPct: [25, 30, 40, 50],
    },
  },
  summary: {
    ...summary,
    tracts: { total: tractFeatures.length, tod: todTracts },
    stations: { county: countyStations.length, network: stations.length },
  },
  bounds: {
    network: turf.bbox(lineCollection).map((v) => +v.toFixed(4)),
    county: turf.bbox(turf.featureCollection(tractFeatures)).map((v) => +v.toFixed(4)),
  },
  lines: lineCollection,
  stations: turf.featureCollection(stations.map((s) => turf.point(
    [+s.lng.toFixed(5), +s.lat.toFixed(5)],
    { name: s.name, lines: [...s.lines].join(','), suffolk: s.suffolk ? 1 : 0 }))),
  walkshed: turf.feature(roundGeometry(turf.simplify(walkshed, { tolerance: 0.00005 }).geometry)),
  tracts: turf.featureCollection(tractFeatures),
});
