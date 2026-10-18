// Google Places (New) details for the spots in favorites.json, which keeps the bill bounded.
// Answers 501 without GOOGLE_MAPS_API_KEY. Google's terms only allow caching place IDs, so
// everything else is fetched per request.
import favorites from '../../assets/live/data/favorites.json';

const SPOTS = new Map(favorites.map((spot) => [spot.id, spot]));
const API = 'https://places.googleapis.com/v1';
const DETAILS = [
  'id', 'displayName', 'formattedAddress', 'rating', 'userRatingCount',
  'googleMapsUri', 'websiteUri', 'priceLevel', 'primaryTypeDisplayName', 'reviews', 'photos',
].join(',');
const PRICE = { PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 };

const placeIds = new Map(); // spot id -> Google place id
const hits = new Map(); // ip -> recent request times, per isolate

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });

// 40 lookups per visitor per 10 minutes
function limited(request) {
  const visitor = request.headers.get('CF-Connecting-IP') || 'local';
  const now = Date.now();
  const recent = (hits.get(visitor) ?? []).filter((t) => now - t < 10 * 60_000);
  recent.push(now);
  hits.set(visitor, recent);
  return recent.length > 40;
}

async function placeIdFor(spot, key) {
  if (placeIds.has(spot.id)) return placeIds.get(spot.id);
  // Text Search with an ids-only field mask is free
  const res = await fetch(`${API}/places:searchText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id' },
    body: JSON.stringify({
      textQuery: `${spot.name}, ${spot.address}`,
      locationBias: { circle: { center: { latitude: spot.lat, longitude: spot.lng }, radius: 400 } },
      pageSize: 1,
    }),
  });
  if (!res.ok) throw new Error(`Places search ${res.status}`);
  const id = (await res.json()).places?.[0]?.id;
  if (!id) throw new Error(`No Google place found for ${spot.id}`);
  placeIds.set(spot.id, id);
  return id;
}

async function details(spot, key) {
  const id = await placeIdFor(spot, key);
  const res = await fetch(`${API}/places/${id}`, { headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': DETAILS } });
  if (!res.ok) throw new Error(`Places details ${res.status}`);
  const place = await res.json();
  const photo = place.photos?.[0];
  return {
    name: place.displayName?.text ?? spot.name,
    address: place.formattedAddress ?? spot.address,
    type: place.primaryTypeDisplayName?.text ?? null,
    rating: place.rating ?? null,
    ratingCount: place.userRatingCount ?? null,
    price: PRICE[place.priceLevel] ?? null,
    mapsUri: place.googleMapsUri ?? null,
    website: place.websiteUri ?? null,
    reviewCount: place.reviews?.length ?? 0,
    // Google sorts by relevance; skip rating-only reviews
    reviews: (place.reviews ?? [])
      .filter((r) => r.text?.text)
      .slice(0, 3)
      .map((r) => ({
        text: r.text.text,
        rating: r.rating ?? null,
        when: r.relativePublishTimeDescription ?? null,
        author: r.authorAttribution?.displayName ?? 'Google user',
        authorUri: r.authorAttribution?.uri ?? null,
      })),
    photo: photo
      ? {
        ref: photo.name,
        credits: (photo.authorAttributions ?? []).map((a) => ({ name: a.displayName, uri: a.uri ?? null })),
      }
      : null,
  };
}

async function photo(spot, key, ref) {
  const id = await placeIdFor(spot, key);
  // don't let this become an open proxy for any photo
  if (!ref || !ref.startsWith(`places/${id}/photos/`) || !/^[\w/-]+$/.test(ref)) return json({ error: 'bad_photo' }, 400);
  const res = await fetch(`${API}/${ref}/media?maxWidthPx=800&key=${encodeURIComponent(key)}`);
  if (!res.ok) return json({ error: 'photo_unavailable' }, 502);
  return new Response(res.body, {
    headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'image/jpeg', 'Cache-Control': 'private, max-age=3600' },
  });
}

export async function places(request, env, url) {
  const [, , , spotId, extra] = url.pathname.split('/'); // /v1/places/:spot[/photo]
  const spot = SPOTS.get(spotId);
  if (!spot || (extra && extra !== 'photo')) return json({ error: 'not_found' }, 404);
  if (!env.GOOGLE_MAPS_API_KEY) return json({ error: 'reviews_not_configured' }, 501);
  if (limited(request)) return json({ error: 'too_many_requests' }, 429);
  if (extra === 'photo') return photo(spot, env.GOOGLE_MAPS_API_KEY, url.searchParams.get('ref'));
  return json(await details(spot, env.GOOGLE_MAPS_API_KEY));
}
