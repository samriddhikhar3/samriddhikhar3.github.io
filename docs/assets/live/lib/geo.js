export const featureCollection = (features) => ({ type: 'FeatureCollection', features });
export const EMPTY = featureCollection([]);
export const point = (lng, lat, properties = {}) => ({
  type: 'Feature',
  properties,
  geometry: { type: 'Point', coordinates: [lng, lat] },
});

// files in assets/live/data, built by scripts/
export async function loadData(name) {
  const res = await fetch(new URL(`../data/${name}`, import.meta.url));
  if (!res.ok) throw new Error(`${name}: ${res.status}`);
  return res.json();
}

// metres
export function haversine([x1, y1], [x2, y2]) {
  const r = Math.PI / 180;
  const a = Math.sin(((y2 - y1) * r) / 2) ** 2 + Math.cos(y1 * r) * Math.cos(y2 * r) * Math.sin(((x2 - x1) * r) / 2) ** 2;
  return 2 * 6_371_008 * Math.asin(Math.sqrt(a));
}

// flat-earth approximation, fine at city scale
export function circle([lng, lat], metres, steps = 72) {
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
  const ring = Array.from({ length: steps + 1 }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    return [lng + (Math.cos(a) * metres) / kx, lat + (Math.sin(a) * metres) / 110_574];
  });
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}
