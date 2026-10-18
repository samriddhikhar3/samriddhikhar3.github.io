// Uses the worker relay when there is one, otherwise SEPTA's JSONP endpoints.
import { API_BASE } from '../config.js';
import { getJson, jsonp } from '../lib/net.js';
import { normalizeSepta } from './septa-normalize.js';

const TRANSIT = 'https://www3.septa.org/api/TransitViewAll/index.php';
const TRAINS = 'https://www3.septa.org/api/TrainView/index.php';

let relayRetryAt = 0;

// tracks: recent history per vehicle from the relay, { id: [[lng*1e5, lat*1e5, ageSeconds], ...] }
export async function fetchSepta({ tracks = false } = {}) {
  if (API_BASE && Date.now() >= relayRetryAt) {
    try {
      return await getJson(`${API_BASE}/v1/septa${tracks ? '?tracks=1' : ''}`, { timeout: 10_000 });
    } catch (err) {
      relayRetryAt = Date.now() + 5 * 60_000;
      console.info('[live] SEPTA relay unavailable; reading SEPTA directly for a while.', err.message);
    }
  }
  const [transit, trains] = await Promise.allSettled([jsonp(TRANSIT), jsonp(TRAINS)]);
  if (transit.status === 'rejected' && trains.status === 'rejected') throw transit.reason;
  return normalizeSepta(
    transit.status === 'fulfilled' ? transit.value : null,
    trains.status === 'fulfilled' ? trains.value : null,
  );
}

export function vehicleName(v) {
  if (v.mode === 'rail') return `${v.route} Line`;
  return /^\d+$/.test(v.route) ? `Route ${v.route} ${v.mode}` : `${v.route} ${v.mode}`;
}

export function lateness(minutes) {
  if (minutes == null) return null;
  if (minutes <= 0) return 'On time';
  return `${minutes} min late`;
}
