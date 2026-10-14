/* watt & eisen: Offline-Hülle. Seite und Icons werden zwischengespeichert, Daten nie (die kommen von GitHub). */
var V = 'we-shell-d57d47e0';
var SHELL = ['./', 'index.html', 'gh-db.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(V).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== V && k.indexOf('we-') === 0; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var u = new URL(req.url);
  if (u.origin === location.origin) {
    // Netz zuerst, damit Updates sofort ankommen; ohne Netz kommt die gespeicherte Fassung.
    e.respondWith(fetch(req).then(function (r) {
      if (r.ok) { var copy = r.clone(); caches.open(V).then(function (c) { c.put(req, copy); }); }
      return r;
    }).catch(function () { return caches.match(req, { ignoreSearch: true }).then(function (m) { return m || caches.match('index.html'); }); }));
  } else if (u.hostname === 'fonts.googleapis.com' || u.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(V).then(function (c) { return c.match(req).then(function (m) {
      var net = fetch(req).then(function (r) { if (r.ok) c.put(req, r.clone()); return r; }).catch(function () { return m; });
      return m || net;
    }); }));
  }
});
