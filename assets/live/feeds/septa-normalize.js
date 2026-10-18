// Used by the worker relay and the browser's JSONP fallback, so both return the same shape.

// T1-T5, G1 and D1-D2 are trolleys; L1, B1-B3 and M1 are Metro; everything else is a bus
const TROLLEY_ROUTES = /^(T\d|G\d|D\d|10|11|13|15|34|36|101|102)$/;
const METRO_ROUTES = /^(L\d|B\d|M\d)$/;
const modeOf = (route) => (TROLLEY_ROUTES.test(route) ? 'trolley' : METRO_ROUTES.test(route) ? 'metro' : 'bus');

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const coord = (value) => Math.round(Number(value) * 1e5) / 1e5;
// loose box around SEPTA's service area, drops 0,0 and other bad fixes
const plausible = (lat, lng) => lat > 39.3 && lat < 40.8 && lng > -76.3 && lng < -74.4;

export function normalizeSepta(transit, trains) {
  const vehicles = [];
  for (const group of transit?.routes ?? []) {
    for (const [route, list] of Object.entries(group)) {
      for (const v of Array.isArray(list) ? list : []) {
        const lat = coord(v.lat);
        const lng = coord(v.lng);
        if (!plausible(lat, lng) || !v.VehicleID || v.VehicleID === '0') continue;
        vehicles.push({
          id: `v${v.VehicleID}`,
          route,
          mode: modeOf(route),
          lat,
          lng,
          dest: v.destination || null,
          late: num(v.late),
          ts: num(v.timestamp),
        });
      }
    }
  }

  const rail = [];
  for (const t of Array.isArray(trains) ? trains : []) {
    const lat = coord(t.lat);
    const lng = coord(t.lon);
    if (!plausible(lat, lng) || !t.trainno) continue;
    rail.push({
      id: `t${t.trainno}`,
      route: t.line || 'Regional Rail',
      mode: 'rail',
      lat,
      lng,
      dest: t.dest || null,
      next: t.nextstop || null,
      late: num(t.late),
    });
  }

  return { t: Date.now(), vehicles, trains: rail };
}
