// Only polls while the tab is visible and, if `target` is given, while it's near the viewport.
// Backs off exponentially on errors, up to 5 minutes.
export function poll(task, { interval, target, onError } = {}) {
  let timer = 0;
  let running = false;
  let failures = 0;
  let inView = !target;

  const active = () => !document.hidden && inView;

  async function run() {
    clearTimeout(timer);
    timer = 0;
    if (!active() || running) return;
    running = true;
    try {
      await task();
      failures = 0;
    } catch (err) {
      failures++;
      onError?.(err, failures);
    } finally {
      running = false;
    }
    if (active()) {
      const delay = failures ? Math.min(interval * 2 ** failures, 5 * 60_000) : interval;
      timer = setTimeout(run, delay);
    }
  }

  const resume = () => {
    if (active() && !timer && !running) run();
  };
  document.addEventListener('visibilitychange', resume);

  if (target) {
    new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      resume();
    }, { rootMargin: '200px 0px' }).observe(target);
  }

  run();
}
