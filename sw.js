/**
 * sw.js — offline support.
 *
 * Pre-caches the app shell, data and vendored libraries on install, then
 * serves same-origin requests network-first with the cache as fallback: you
 * always get the latest files when online, and the whole atlas still opens
 * offline. Google Fonts are cached on first use (cache-first). Bump VERSION
 * when the precache list changes.
 */
const VERSION = 'atlas-v2';
const FONTS = 'atlas-fonts-v1';

const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './tailwind.css',
  './manifest.webmanifest',
  './assets/favicon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './data/wonders.json',
  './data/land-110m.json',
  './js/main.js',
  './js/MorphController.js',
  './js/morphShader.js',
  './js/pointCloud.js',
  './js/proceduralWonders.js',
  './js/ui.js',
  './js/globe.js',
  './js/sky.js',
  './js/quiz.js',
  './js/tour.js',
  './js/audio.js',
  './vendor/three/three.module.js',
  './vendor/three/three.core.js',
  './vendor/three/addons/controls/OrbitControls.js',
  './vendor/three/addons/environments/RoomEnvironment.js',
  './vendor/three/addons/loaders/DRACOLoader.js',
  './vendor/three/addons/loaders/GLTFLoader.js',
  './vendor/three/addons/loaders/HDRLoader.js',
  './vendor/three/addons/math/MeshSurfaceSampler.js',
  './vendor/three/addons/utils/BufferGeometryUtils.js',
  './vendor/three/addons/utils/SkeletonUtils.js',
  './vendor/gsap/index.js',
  './vendor/gsap/gsap-core.js',
  './vendor/gsap/CSSPlugin.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== FONTS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())))
    );
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.open(FONTS).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok || res.type === 'opaque') c.put(req, res.clone());
        return res;
      })))
    );
  }
});
