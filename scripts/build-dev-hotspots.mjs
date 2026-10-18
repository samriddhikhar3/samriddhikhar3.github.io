// Recomputes DevTracker's 2022 hot spots the way the original analysis did
// (portfolio/2_DevTracker/DevTracker.html): 500 ft fishnet, building permits per cell, Local
// Moran's I with queen contiguity and row-standardised weights, cells above the mean with
// p < 0.00001.
import * as turf from '@turf/turf';
import { readFile } from 'node:fs/promises';
import { DATA_DIR, carto, writeJson } from './lib.mjs';

const YEAR = 2022;
const PERMIT_TYPES = ['Building', 'Residential Building'];
const P_THRESHOLD = 1e-5;
const CELL = 152.4; // metres (500 ft)

// metres per degree at 40N; written to meta so the browser can find a permit's cell
const REF = [-75.15, 40.0];
const KX = 85394;
const KY = 111035;
const project = ([lng, lat]) => [(lng - REF[0]) * KX, (lat - REF[1]) * KY];
const unproject = ([x, y]) => [x / KX + REF[0], y / KY + REF[1]];

const limits = JSON.parse(await readFile(`${DATA_DIR}/philly-limits.json`, 'utf8'));

// fishnet cells touching the city
const [west, south, east, north] = limits.bbox;
const [minX, minY] = project([west, south]);
const [maxX, maxY] = project([east, north]);
const x0 = Math.floor(minX / CELL) * CELL;
const y0 = Math.floor(minY / CELL) * CELL;
const cols = Math.ceil((maxX - x0) / CELL);
const rows = Math.ceil((maxY - y0) / CELL);

const cells = new Map(); // `${i},${j}` -> { i, j, count }
const SAMPLES = [[0.5, 0.5], [0, 0], [1, 0], [0, 1], [1, 1]];
for (let i = 0; i < cols; i++) {
  for (let j = 0; j < rows; j++) {
    const touches = SAMPLES.some(([a, b]) =>
      turf.booleanPointInPolygon(unproject([x0 + (i + a) * CELL, y0 + (j + b) * CELL]), limits));
    if (touches) cells.set(`${i},${j}`, { i, j, count: 0 });
  }
}

const permits = await carto(`
  SELECT ST_X(the_geom) AS lng, ST_Y(the_geom) AS lat
  FROM permits
  WHERE permittype IN (${PERMIT_TYPES.map((t) => `'${t}'`).join(', ')})
    AND permitissuedate >= '${YEAR}-01-01' AND permitissuedate < '${YEAR + 1}-01-01'
    AND the_geom IS NOT NULL`);
let counted = 0;
for (const { lng, lat } of permits) {
  const [x, y] = project([lng, lat]);
  const cell = cells.get(`${Math.floor((x - x0) / CELL)},${Math.floor((y - y0) / CELL)}`);
  if (cell) {
    cell.count++;
    counted++;
  }
}

// Local Moran's I with conditional randomisation (Sokal et al. 1998), same as spdep::localmoran.
// erfc below is Numerical Recipes' erfcc, fractional error < 1.2e-7.
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 +
    t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 +
    t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

const list = [...cells.values()];
const n = list.length;
const mean = list.reduce((sum, c) => sum + c.count, 0) / n;
for (const c of list) c.z = c.count - mean;
const m2 = list.reduce((sum, c) => sum + c.z * c.z, 0) / n;

for (const c of list) {
  const neighbours = [];
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const other = (di || dj) && cells.get(`${c.i + di},${c.j + dj}`);
      if (other) neighbours.push(other);
    }
  }
  const k = neighbours.length;
  if (!k || c.z === 0) {
    c.p = 1;
    continue;
  }
  const lag = neighbours.reduce((sum, o) => sum + o.z, 0) / k; // w = 1/k
  const I = (c.z / m2) * lag;
  const Wi = 1;
  const Wi2 = 1 / k;
  const EI = -(c.z ** 2 * Wi) / ((n - 1) * m2);
  const VI = (c.z / m2) ** 2 * (n / (n - 2)) * (Wi2 - Wi ** 2 / (n - 1)) * (m2 - c.z ** 2 / (n - 1));
  c.I = I;
  c.p = erfc(Math.abs((I - EI) / Math.sqrt(VI)) / Math.SQRT2); // two-sided
}

const hot = list.filter((c) => c.p < P_THRESHOLD && c.I > 0 && c.z > 0);
const hotPermits = hot.reduce((sum, c) => sum + c.count, 0);

console.log(`${n} cells, ${counted}/${permits.length} permits placed, ${hot.length} hot spot cells ` +
  `(${((100 * hot.length) / n).toFixed(1)}% of cells, ${((100 * hotPermits) / counted).toFixed(1)}% of permits)`);

await writeJson(`${DATA_DIR}/dev-hotspots-2022.json`, {
  meta: {
    year: YEAR,
    permitTypes: PERMIT_TYPES,
    permits: counted,
    cellSizeFt: 500,
    cellSizeM: CELL,
    ref: REF,
    kx: KX,
    ky: KY,
    x0,
    y0,
    cols,
    rows,
    cells: n,
    hotCells: hot.length,
    hotPermits,
    pThreshold: P_THRESHOLD,
    method: "Local Moran's I on 2022 building permits per 500 ft cell (queen contiguity, row-standardised, conditional randomisation); above-average cells with two-sided p < 0.00001",
    source: 'City of Philadelphia, L&I building permits (phl.carto.com)',
    generated: new Date().toISOString().slice(0, 10),
  },
  hot: hot.map((c) => [c.i, c.j, c.count]),
});
