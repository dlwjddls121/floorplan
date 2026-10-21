// Page-side helper for the service worker (sw.js): registration and the update flow (plan §8-1).
//
// Update flow:
//   1. A new sw.js is found (on load, when the app comes back to the foreground, or every hour).
//   2. It installs and then WAITS; the running page keeps the old version, so nothing changes mid-drawing.
//   3. onUpdateAvailable callbacks fire; the UI shows "새 버전이 있습니다 [지금 적용]".
//   4. [지금 적용] → applyUpdate(): saves via the optional beforeReload hook, posts 'SKIP_WAITING' to the
//      waiting worker, and reloads the page once the new worker has taken control.
//   If the user ignores it, the new version is used the next time the app is opened after all its
//   windows were closed.
//
// Usage (main.js):
//   import { registerServiceWorker, onUpdateAvailable } from './io/swclient.js';
//   registerServiceWorker();
//   onUpdateAvailable(({ apply }) => showBanner('새 버전이 있습니다', '지금 적용', () => apply({ beforeReload: flushAutosave })));
// onUpdateAvailable also works if the page registered sw.js itself with navigator.serviceWorker.register.

// Resolved from this module's location (app/js/io/), so it works from any page of the app.
const APP_SCOPE = new URL('../../', import.meta.url).href;
const SW_URL = new URL('../../sw.js', import.meta.url).href;

const UPDATE_CHECK_MIN_INTERVAL_MS = 30 * 60 * 1000;
const UPDATE_CHECK_PERIOD_MS = 60 * 60 * 1000;

const listeners = new Set();
let watchedRegistration = null;
let notified = false;
let reloading = false;
let lastCheck = 0;
let periodicChecksStarted = false;

function supported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

function notify(registration) {
  // Only an update replaces a running version; the very first install is not an "update".
  if (!registration.waiting || !navigator.serviceWorker.controller) return;
  notified = true;
  const info = { registration, apply: (opts) => applyUpdate(opts) };
  for (const fn of listeners) {
    try { fn(info); } catch (err) { console.error('[swclient] update listener failed', err); }
  }
}

function watch(registration) {
  if (!registration || watchedRegistration === registration) return;
  watchedRegistration = registration;
  if (registration.waiting) notify(registration);
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') notify(registration);
    });
  });
  if (!periodicChecksStarted) {
    periodicChecksStarted = true;
    // Tablets keep the app in the background for days: check again whenever it comes back.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    });
    setInterval(() => checkForUpdate(), UPDATE_CHECK_PERIOD_MS);
  }
}

// Registers the app's sw.js with the app root as scope (both resolved relative to this module, so it
// works under a GitHub Pages sub-path). Resolves with the registration, or null when service workers are
// not available (e.g. plain http on a non-localhost address). Never rejects.
export async function registerServiceWorker(url = SW_URL) {
  if (!supported()) return null;
  try {
    const registration = await navigator.serviceWorker.register(url, { scope: APP_SCOPE, updateViaCache: 'none' });
    watch(registration);
    return registration;
  } catch (err) {
    console.warn('[swclient] service worker registration failed', err);
    return null;
  }
}

// callback({ registration, apply(opts) }) is called when a new version is installed and waiting.
// If one is already waiting, it is called soon after subscribing. Returns an unsubscribe function.
export function onUpdateAvailable(callback) {
  listeners.add(callback);
  if (supported()) {
    if (notified && watchedRegistration && watchedRegistration.waiting) {
      // An update was already announced to earlier subscribers: tell this one too.
      const registration = watchedRegistration;
      setTimeout(() => {
        if (!listeners.has(callback) || !registration.waiting) return;
        try { callback({ registration, apply: (opts) => applyUpdate(opts) }); } catch (err) { console.error(err); }
      }, 0);
    } else {
      // watch() announces a waiting worker to all listeners, this one included.
      navigator.serviceWorker.getRegistration(APP_SCOPE)
        .then((registration) => registration || navigator.serviceWorker.ready)
        .then((registration) => watch(registration))
        .catch(() => {});
    }
  }
  return () => listeners.delete(callback);
}

// Asks the browser to look for a new sw.js now (throttled). Resolves true if a check was made.
export async function checkForUpdate({ force = false } = {}) {
  if (!supported()) return false;
  const now = Date.now();
  if (!force && now - lastCheck < UPDATE_CHECK_MIN_INTERVAL_MS) return false;
  lastCheck = now;
  try {
    const registration = await navigator.serviceWorker.getRegistration(APP_SCOPE);
    if (!registration) return false;
    watch(registration);
    await registration.update();
    return true;
  } catch (err) {
    // Offline: just try again later.
    return false;
  }
}

// Activates the waiting version and reloads the page.
// opts.beforeReload: optional async function (e.g. flush the autosave) awaited before switching.
// Resolves false if there was nothing to apply.
export async function applyUpdate({ beforeReload } = {}) {
  if (!supported()) return false;
  const registration = await navigator.serviceWorker.getRegistration(APP_SCOPE);
  const waiting = registration && registration.waiting;
  if (!waiting) return false;
  if (beforeReload) {
    try { await beforeReload(); } catch (err) { console.error('[swclient] beforeReload failed', err); }
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  waiting.postMessage({ type: 'SKIP_WAITING' });
  return true;
}

// Asks the active service worker for its cache version (for an "앱 정보" line). → string | null
export async function getServiceWorkerVersion(timeoutMs = 1000) {
  if (!supported() || !navigator.serviceWorker.controller) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), timeoutMs);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve((event.data && event.data.version) || null);
    };
    navigator.serviceWorker.controller.postMessage({ type: 'GET_VERSION' }, [channel.port2]);
  });
}
