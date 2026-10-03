// Firebase Cloud Messaging — handles a push arriving while no СпаркСтоп tab is
// focused (the case the "closed app" notification is actually for). When a
// tab IS open and focused, Firebase delivers the message to that tab's own
// JS instead and this handler is not involved.
// Self-hosted (was www.gstatic.com) — same third-party CDN reliability
// issue found in index.html's own <script> tags applies equally here.
importScripts('/vendor/firebase/firebase-app-compat.js');
importScripts('/vendor/firebase/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyDdbJ0oQI-NtkGu2ULLFGDSsStMv-UX1wU',
  authDomain: 'sparkdrop-586b4.firebaseapp.com',
  projectId: 'sparkdrop-586b4',
  storageBucket: 'sparkdrop-586b4.firebasestorage.app',
  messagingSenderId: '650743126239',
  appId: '1:650743126239:web:e280323e596526bf73716a'
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  // Data-only messages (see notificationService.js for why) — title/body
  // travel inside payload.data instead of a top-level payload.notification.
  const title = payload.data?.title || '⚠️ Има бъдеща авария на вашия запазен адрес';
  const options = {
    body: payload.data?.body || 'Влезте в приложението за повече информация.',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: payload.data || {}
  };
  self.registration.showNotification(title, options);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          // Currently every push sends url: '/', so this rarely differs from
          // wherever the tab already is — but if a deep link (e.g. straight
          // to one saved address) is ever added to the payload, focusing
          // alone would land on whatever page that tab happened to be on
          // instead of the intended content.
          const targetAbsolute = new URL(targetUrl, self.location.origin).href;
          if ('navigate' in client && client.url !== targetAbsolute) {
            return client.navigate(targetAbsolute).then((navigated) => (navigated || client).focus());
          }
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});

const CACHE_NAME = 'sparkdrop-shell-v3';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/logo.png',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Live outage/API data must never be served stale — network only, no caching.
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Cross-origin requests (map tiles, Firebase, etc.) must bypass this handler
  // entirely and go straight to the network unmodified — routing them through
  // fetch(request) here can throw for opaque no-cors cross-origin responses,
  // which this handler's .catch() turns into a hard failure (blank/broken tiles)
  // instead of just letting the browser load them normally.
  if (url.origin !== self.location.origin) {
    return;
  }

  // App shell: network-first, so every load reflects the latest deployed page —
  // only fall back to the cached copy if the network request actually fails (offline).
  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.ok) {
          caches.open(CACHE_NAME).then((cache) => cache.put(request, networkResponse.clone()));
        }
        return networkResponse;
      })
      .catch(() => caches.match(request))
  );
});
