// <div data-live="sams-philly" data-bleed></div> mounts that widget once it scrolls near the
// viewport; data-bleed stretches it to the full window width.
const WIDGETS = {
  'sams-philly': () => import('./widgets/sams-philly.js'),
  'dev-live': () => import('./widgets/dev-live.js'),
  'tod-story': () => import('./widgets/tod-story.js'),
};

async function mount(root) {
  const load = WIDGETS[root.dataset.live];
  if (!load) return;
  root.classList.add('is-loading');
  try {
    const widget = await load();
    await widget.mount(root, { ...root.dataset });
    root.classList.add('is-ready');
  } catch (err) {
    console.error(`[live] "${root.dataset.live}" could not start`, err);
    root.classList.add('is-failed');
    const message = document.createElement('p');
    message.className = 'live-fallback';
    message.textContent = 'This live map could not load here. It needs a browser with WebGL and a network connection.';
    root.append(message);
  } finally {
    root.classList.remove('is-loading');
  }
}

// clientWidth leaves out the scrollbar, so this never causes horizontal scrolling
function bleed(el) {
  const fit = () => {
    el.style.marginLeft = '0px';
    const left = el.getBoundingClientRect().left;
    el.style.width = `${document.documentElement.clientWidth}px`;
    el.style.marginLeft = `${-left}px`;
  };
  fit();
  addEventListener('resize', fit);
}

for (const el of document.querySelectorAll('[data-live][data-bleed]')) bleed(el);

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      mount(entry.target);
    }
  },
  { rootMargin: '600px 0px' },
);

for (const root of document.querySelectorAll('[data-live]')) observer.observe(root);
