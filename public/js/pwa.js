'use strict';

// Registers the service worker (issue #142) so the app is installable and works
// offline. IIFE with no top-level names, so it needs no entry in eslint's
// frontendGlobals and is safe anywhere in the load order (it references only
// browser globals, nothing from the other scripts).
(function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Register after load so it never competes with the initial page render.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // Non-fatal: the app works without the SW (just no offline/install). Log
      // for debugging rather than surfacing to the user.
      console.error('Service worker registration failed:', err);
    });
  });
})();
