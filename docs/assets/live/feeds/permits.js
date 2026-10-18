// L&I permits refresh nightly. Windows count back from the newest permit rather than today, so
// "last 30 days" isn't a day short before the refresh lands.
import { getJson } from '../lib/net.js';

const CARTO = 'https://phl.carto.com/api/v2/sql';

export async function carto(sql) {
  const json = await getJson(`${CARTO}?q=${encodeURIComponent(sql)}`, { timeout: 20_000 });
  if (json.error) throw new Error(`Carto: ${json.error.join('; ')}`);
  return json.rows;
}

const FIELDS = `permitnumber AS id, permittype AS type, typeofwork AS work, approvedscopeofwork AS scope,
  address, permitissuedate AS issued, ST_X(the_geom) AS lng, ST_Y(the_geom) AS lat`;
const SINCE = (days) => `permitissuedate > (SELECT max(permitissuedate) FROM permits) - INTERVAL '${Number(days)} days'`;

// building permits are what the DevTracker model counted as construction
export async function buildingPermits(days = 30) {
  const rows = await carto(`SELECT ${FIELDS} FROM permits
    WHERE the_geom IS NOT NULL AND ${SINCE(days)} AND permittype IN ('Building', 'Residential Building')
    ORDER BY permitissuedate`);
  return rows.map((row) => ({ ...row, issued: Date.parse(row.issued) }));
}

export function describePermit(p) {
  const kind = `${p.type} permit`;
  return p.work ? `${p.work} · ${kind}` : kind;
}

const titleCase = (s) => s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
export const prettyAddress = (address) => (address ? titleCase(address) : 'Address not listed');
