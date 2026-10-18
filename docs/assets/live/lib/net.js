export async function getJson(url, { timeout = 12_000, init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${url})`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

let counter = 0;

// SEPTA's feeds don't send CORS headers, so without the worker this is the only way to read them
export function jsonp(url, { timeout = 12_000 } = {}) {
  return new Promise((resolve, reject) => {
    const name = `__liveJsonp${(counter++).toString(36)}${Date.now().toString(36)}`;
    const script = document.createElement('script');
    const finish = () => {
      clearTimeout(timer);
      script.remove();
      // leave a no-op behind in case the script still loads after a timeout
      window[name] = () => delete window[name];
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`JSONP timed out (${url})`));
    }, timeout);
    window[name] = (data) => {
      finish();
      delete window[name];
      resolve(data);
    };
    script.onerror = () => {
      finish();
      reject(new Error(`JSONP failed (${url})`));
    };
    script.referrerPolicy = 'no-referrer';
    script.src = `${url}${url.includes('?') ? '&' : '?'}callback=${name}`;
    document.head.append(script);
  });
}
