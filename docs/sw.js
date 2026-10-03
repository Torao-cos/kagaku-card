/* sw.js — stale-while-revalidate。一度開けば以後は圏外でも開ける（絶対保証はしない）。
 * VERSION / CACHE_PREFIX / SW_SKIP のプレースホルダは build.js がページごとに差し替える。
 * 同一オリジンに複数ページ（/ と /ion/）が並ぶため、消すのは自分の prefix のキャッシュだけ。
 * SKIP（scope からの相対パス）配下は別ページの SW の担当なので触らない。 */
var PREFIX = 'kagaku-card-';
var CACHE = PREFIX + '296e5e3bb9';
var SKIP = ["ion/"];
var ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-180.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf(PREFIX) === 0 && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  var scope = self.registration.scope;
  for (var i = 0; i < SKIP.length; i++) {
    var base = new URL(SKIP[i], scope).href;
    if (url.href.indexOf(base) === 0 || url.href + '/' === base) return;
  }
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(e.request, { ignoreSearch: true }).then(function (cached) {
      var network = fetch(e.request).then(function (res) {
        if (res && res.ok) c.put(e.request, res.clone());
        return res;
      }).catch(function () { return cached; });
      return cached || network;
    });
  }));
});
