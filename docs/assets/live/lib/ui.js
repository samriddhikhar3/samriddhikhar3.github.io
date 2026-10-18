// feed data is untrusted, so text only ever goes in as text nodes, never innerHTML

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style') el.style.cssText = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) if (value != null) el.setAttribute(key, value);
  for (const child of children.flat()) if (child) el.append(child);
  return el;
}

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const fmt = (n) => (n == null || Number.isNaN(n) ? '–' : integer.format(n));
export const money = (n) => (n == null ? '–' : `$${integer.format(n)}`);
export const plural = (n, one, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

const PHILLY_TZ = 'America/New_York';
export const shortDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: PHILLY_TZ });
export const weekdayDate = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: PHILLY_TZ });

export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hours = Math.round(m / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

export const truncate = (text, max) => (text && text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text || '');

export class LiveStatus {
  constructor({ staleAfter = 90_000 } = {}) {
    this.text = h('span', { class: 'live-status__text' }, 'Connecting…');
    this.el = h('span', { class: 'live-status', dataset: { state: 'connecting' } },
      h('span', { class: 'live-status__dot', 'aria-hidden': 'true' }), this.text);
    this.staleAfter = staleAfter;
    this.last = 0;
    this.failed = false;
    this.timer = setInterval(() => this.render(), 1000);
  }

  ok(at = Date.now()) {
    this.last = at;
    this.failed = false;
    this.render();
  }

  fail() {
    this.failed = true;
    this.render();
  }

  render() {
    const age = Date.now() - this.last;
    let state = 'connecting';
    if (this.last) state = this.failed || age > this.staleAfter ? 'stale' : 'live';
    else if (this.failed) state = 'offline';
    this.el.dataset.state = state;
    this.text.textContent = {
      connecting: 'Connecting…',
      live: `Live · updated ${ago(age)}`,
      stale: `Reconnecting · updated ${ago(age)}`,
      offline: 'Feed unavailable',
    }[state];
  }
}

// shape: dot | dot-lg | ring | square | wash | line
export function legendKey(shape, color, label) {
  const key = h('span', { class: `live-key live-key--${shape}`, style: `--key: ${color}`, 'aria-hidden': 'true' });
  return h('span', { class: 'live-legend__item' }, key, h('span', null, label));
}

// rows: [{ value, label, color }]
export class Tooltip {
  constructor(container) {
    this.container = container;
    this.el = h('div', { class: 'live-tip', role: 'tooltip', hidden: true });
    container.append(this.el);
  }

  show(x, y, { title, rows = [], note } = {}) {
    this.el.replaceChildren(
      title ? h('div', { class: 'live-tip__title' }, title) : null,
      ...rows.map((row) => h('div', { class: 'live-tip__row' },
        row.color ? h('span', { class: 'live-tip__key', style: `--key: ${row.color}` }) : null,
        h('strong', null, row.value),
        row.label ? h('span', null, row.label) : null)),
      note ? h('div', { class: 'live-tip__note' }, note) : null,
    );
    this.el.hidden = false;
    const { width, height } = this.el.getBoundingClientRect();
    const bounds = this.container.getBoundingClientRect();
    let left = x + 14;
    let top = y + 14;
    if (left + width > bounds.width - 8) left = x - width - 14;
    if (top + height > bounds.height - 8) top = y - height - 14;
    this.el.style.transform = `translate(${Math.max(8, left)}px, ${Math.max(8, top)}px)`;
  }

  hide() {
    this.el.hidden = true;
  }
}

export function localPoint(event, el) {
  const r = el.getBoundingClientRect();
  return { x: event.clientX - r.left, y: event.clientY - r.top };
}
