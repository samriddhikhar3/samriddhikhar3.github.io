// Side panel for a favorite spot. Google's photo, rating and reviews load afterwards through the
// worker, and only if it has a Maps key.
import { API_BASE } from '../config.js';
import { getJson } from '../lib/net.js';
import { fmt, h } from '../lib/ui.js';

const google = new Map(); // spot id -> details promise
let googleOff = false; // set after a 501 (no key on the worker)

function distance(m) {
  const miles = m / 1609.344;
  return miles < 0.1 ? `${Math.max(50, Math.round((m * 3.28084) / 50) * 50)} ft` : `${miles.toFixed(1)} mi`;
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')}…` : text);

// "Regional Rail", "L1", "Bus 30, 42, 49 +2"
function routeLabel(kind, routes) {
  if (kind === 'train') {
    const metro = routes.filter((r) => /^[A-Z]\d$/.test(r));
    const rail = routes.length - metro.length;
    return [...metro, rail ? 'Regional Rail' : null].filter(Boolean).join(' · ');
  }
  const shown = routes.slice(0, 4).join(', ');
  const more = routes.length > 4 ? ` +${routes.length - 4}` : '';
  return kind === 'bus' ? `Bus ${shown}${more}` : `${shown}${more}`;
}

export class SpotCard {
  constructor(container, { onClose }) {
    this.onClose = onClose;
    this.el = h('aside', { class: 'spot-card', hidden: true, 'aria-label': 'About this spot' });
    container.append(this.el);
    this.el.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.onClose();
    });
  }

  // access.bike is the nearest Indego station: { name, m, bikes }
  show(spot, access) {
    this.spot = spot;
    const search = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${spot.name}, ${spot.address}`)}`;
    const ways = [
      ['🚆', 'Train', spot.nearest.train, 'train'],
      ['🚌', 'Bus', spot.nearest.bus, 'bus'],
      spot.nearest.trolley && spot.nearest.trolley.m <= 805 ? ['🚋', 'Trolley', spot.nearest.trolley, 'trolley'] : null,
      access.bike ? ['🚲', 'Indego', { ...access.bike, routes: [] }, 'bike'] : null,
    ].filter(Boolean);

    this.photo = h('figure', { class: 'spot-card__photo', hidden: true });
    this.rating = h('p', { class: 'spot-card__rating', hidden: true });
    this.description = h('p', { class: 'spot-card__desc' }, spot.description);
    this.reviews = h('section', { class: 'spot-card__reviews', hidden: true });
    this.maps = h('a', { class: 'live-btn live-btn--primary', href: search, target: '_blank', rel: 'noopener' }, 'Open in Google Maps ↗');
    this.website = h('a', { class: 'live-btn', target: '_blank', rel: 'noopener', hidden: true }, 'Website');

    this.el.replaceChildren(
      h('button', { type: 'button', class: 'spot-card__close', 'aria-label': 'Close', onclick: () => this.onClose() }, '×'),
      this.photo,
      h('div', { class: 'spot-card__body' },
        h('h3', { class: 'spot-card__name', tabindex: '-1' }, spot.name),
        this.rating,
        this.description,
        this.reviews,
        h('section', { class: 'spot-card__transit' },
          h('p', { class: 'spot-card__label' }, 'How to get there'),
          h('ul', null, ways.map(([icon, label, stop, kind]) => h('li', null,
            h('span', { class: 'spot-card__icon', 'aria-hidden': 'true' }, icon),
            h('span', null,
              h('strong', null, stop.name),
              h('small', null, [
                `${label} · ${distance(stop.m)}`,
                kind === 'bike'
                  ? (stop.bikes != null ? ` · ${fmt(stop.bikes)} bikes now` : '')
                  : stop.routes.length ? ` · ${routeLabel(kind, stop.routes)}` : '',
              ].join(''))),
          )))),
        h('p', { class: 'spot-card__address' }, spot.address),
        h('div', { class: 'spot-card__actions' }, this.maps, this.website)),
    );
    this.el.hidden = false;
    this.el.scrollTop = 0;
    this.el.querySelector('.spot-card__name').focus({ preventScroll: true });
    this.loadGoogle(spot);
  }

  close() {
    this.el.hidden = true;
    this.spot = null;
  }

  async loadGoogle(spot) {
    if (!API_BASE || googleOff) return;
    if (!google.has(spot.id)) {
      google.set(spot.id, getJson(`${API_BASE}/v1/places/${spot.id}`, { timeout: 9_000 }).catch((err) => {
        if (err.message.startsWith('501')) googleOff = true;
        return null;
      }));
    }
    const place = await google.get(spot.id);
    if (!place || this.spot !== spot) return; // failed, or another spot is open by now

    if (place.rating) {
      this.rating.replaceChildren(
        h('strong', null, place.rating.toFixed(1)), h('span', { class: 'spot-card__star', 'aria-hidden': 'true' }, ' ★'),
        place.ratingCount ? h('span', null, ` ${fmt(place.ratingCount)} reviews`) : null,
        place.price ? h('span', { class: 'spot-card__price' }, ` · ${'$'.repeat(place.price)}`) : null);
      this.rating.hidden = false;
    }
    if (place.mapsUri) this.maps.href = place.mapsUri;
    if (place.website) {
      this.website.href = place.website;
      this.website.hidden = false;
    }
    if (place.photo) {
      const credit = place.photo.credits?.[0];
      this.photo.replaceChildren(
        h('img', {
          src: `${API_BASE}/v1/places/${spot.id}/photo?ref=${encodeURIComponent(place.photo.ref)}`,
          alt: spot.name,
          loading: 'lazy',
        }),
        h('figcaption', null, 'via Google',
          credit ? [' · ', credit.uri ? h('a', { href: credit.uri, target: '_blank', rel: 'noopener' }, credit.name) : credit.name] : null),
      );
      this.photo.hidden = false;
    }
    if (place.reviews?.length) {
      this.reviews.replaceChildren(
        h('p', { class: 'spot-card__label' }, `Selected from ${place.reviewCount} reviews · via Google`),
        ...place.reviews.map((r) => h('blockquote', null,
          h('p', null, `“${truncate(r.text, 260)}”`),
          h('footer', null,
            r.authorUri ? h('a', { href: r.authorUri, target: '_blank', rel: 'noopener' }, r.author) : r.author,
            r.rating ? ` · ${r.rating}★` : '', r.when ? ` · ${r.when}` : ''))),
      );
      this.reviews.hidden = false;
    }
  }
}
