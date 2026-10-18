import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = resolve(ROOT, 'assets/live/data');

const USER_AGENT = 'samriddhikhar3.github.io live-map data build';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJson(url, { retries = 3 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      return await res.json();
    } catch (err) {
      if (attempt >= retries) throw err;
      console.warn(`  retrying (${attempt}/${retries - 1}): ${err.message}`);
      await sleep(1500 * attempt);
    }
  }
}

export async function carto(sql) {
  const json = await getJson(`https://phl.carto.com/api/v2/sql?q=${encodeURIComponent(sql)}`);
  if (json.error) throw new Error(`Carto: ${json.error.join('; ')}`);
  return json.rows;
}

// 5 digits is about 1 m
export function roundGeometry(geometry, digits = 5) {
  const f = 10 ** digits;
  const walk = (c) => (typeof c[0] === 'number' ? c.map((v) => Math.round(v * f) / f) : c.map(walk));
  return { ...geometry, coordinates: walk(geometry.coordinates) };
}

export async function writeJson(path, data) {
  const text = JSON.stringify(data);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  console.log(`wrote ${relative(ROOT, path)} (${(text.length / 1024).toFixed(1)} KB)`);
}
