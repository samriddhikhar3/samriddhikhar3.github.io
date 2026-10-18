// keyless MBTA access allows 20 requests a minute per visitor; the story uses about 6
import { getJson } from '../lib/net.js';

export async function fetchVehicles(routeIds) {
  const json = await getJson(
    `https://api-v3.mbta.com/vehicles?filter[route]=${routeIds.join(',')}` +
      '&fields[vehicle]=latitude,longitude,updated_at,current_status,label,route',
  );
  return json.data
    .filter((v) => Number.isFinite(v.attributes.latitude) && Number.isFinite(v.attributes.longitude))
    .map((v) => ({
      id: v.id,
      route: v.relationships?.route?.data?.id,
      lat: v.attributes.latitude,
      lng: v.attributes.longitude,
      ts: Date.parse(v.attributes.updated_at),
      label: v.attributes.label,
      status: v.attributes.current_status,
    }));
}
