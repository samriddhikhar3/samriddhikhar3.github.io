// keep in sync with the tokens at the top of live.css
export const COLORS = {
  transit: '#2a78d6', // MBTA vehicles (TOD story)
  transitDeep: '#1c5cab', // walkshed outlines
  dev: '#eb6834', // construction permits (DevTracker)
  ink: '#373a3c',
  muted: '#868e96',
  hairline: '#c9cdd1',
  surface: '#ffffff',
  land: '#f4f4f2',
  // sequential blues, light to dark
  seq: ['#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
};

// Home page map. For color-blind readers the purple sits close to the bus blue and the pink
// to the trolley green, so those also differ by shape: stations don't move, trains get track
// with ties and bigger dots.
const TRANSIT = {
  light: { bus: '#2a78d6', trolley: '#1baf7a', train: '#ff1251', bike: '#9a00fa', grey: '#c3c8ce', surface: '#ffffff' },
  night: { bus: '#3987e5', trolley: '#199e70', train: '#ff1251', bike: '#9a00fa', grey: '#3a444f', surface: '#000000' },
};

export const transitColors = (theme) => TRANSIT[theme === 'night' ? 'night' : 'light'];

const cache = new Map();
export function rgba(hex, alpha) {
  const key = `${hex}/${alpha}`;
  if (!cache.has(key)) {
    const n = parseInt(hex.slice(1), 16);
    cache.set(key, `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`);
  }
  return cache.get(key);
}
