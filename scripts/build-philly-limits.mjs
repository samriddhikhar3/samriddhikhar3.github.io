import * as turf from '@turf/turf';
import { DATA_DIR, getJson, roundGeometry, writeJson } from './lib.mjs';

const SOURCE =
  'https://services.arcgis.com/fLeGjb7u4uXqeF9q/arcgis/rest/services/City_Limits/FeatureServer/0/query' +
  '?where=1%3D1&outFields=*&outSR=4326&f=geojson';

const fc = await getJson(SOURCE);
const simplified = turf.simplify(fc.features[0], { tolerance: 0.0002, highQuality: true });

const limits = {
  type: 'Feature',
  properties: { name: 'Philadelphia', source: 'City of Philadelphia, City Limits (OpenDataPhilly)' },
  geometry: roundGeometry(simplified.geometry),
};
limits.bbox = turf.bbox(limits).map((v) => +v.toFixed(5));

await writeJson(`${DATA_DIR}/philly-limits.json`, limits);
