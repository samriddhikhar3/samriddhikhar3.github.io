import { getJson } from '../lib/net.js';

const INDEGO = 'https://gbfs.bcycle.com/bcycle_indego';

const installed = (s) => s.is_installed === undefined || s.is_installed === 1 || s.is_installed === true;

export async function loadStations() {
  const json = await getJson(`${INDEGO}/station_information.json`, { timeout: 20_000 });
  return json.data.stations
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon))
    .map((s) => ({ id: s.station_id, name: s.name, lng: s.lon, lat: s.lat, capacity: s.capacity ?? null }));
}

export async function loadStatus() {
  const json = await getJson(`${INDEGO}/station_status.json`, { timeout: 20_000 });
  const stations = new Map();
  for (const s of json.data.stations) {
    if (installed(s)) stations.set(s.station_id, { bikes: s.num_bikes_available, docks: s.num_docks_available });
  }
  return { updated: json.last_updated * 1000, stations };
}

// Diffs consecutive status snapshots. Rebalancing shows up too, and a take and a return at the
// same station within a minute cancel out.
export class DockWatcher {
  constructor() {
    this.previous = null;
    this.updated = 0;
  }

  // [] for the first snapshot or a repeat
  update(status) {
    if (status.updated && status.updated === this.updated) return [];
    const changes = [];
    if (this.previous) {
      for (const [id, now] of status.stations) {
        const before = this.previous.get(id);
        if (before && now.bikes !== before.bikes) changes.push({ id, delta: now.bikes - before.bikes });
      }
    }
    this.previous = status.stations;
    this.updated = status.updated;
    return changes;
  }
}
