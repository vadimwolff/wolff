/* WolffMsg service worker: держит оболочку приложения в кэше, чтобы сайт
   открывался при плохой связи. Запросы к API не кэшируются никогда. */

var CACHE = 'wolffmsg-v49-1';

var SHELL = [
    './',
    './index.html',
    './assets/styles.css',
    './assets/app.js',
    './assets/config.js',
    './assets/icon.svg',
    './assets/manifest.webmanifest'
];

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE).then(function (cache) {
            return cache.addAll(SHELL);
        }).then(function () { return self.skipWaiting(); })
    );
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys().then(function (keys) {
            return Promise.all(keys.map(function (k) {
                return k === CACHE ? null : caches.delete(k);
            }));
        }).then(function () { return self.clients.claim(); })
    );
});

self.addEventListener('fetch', function (event) {
    var req = event.request;
    if (req.method !== 'GET') return;

    var url = new URL(req.url);
    if (url.origin !== self.location.origin) return;          // чужие домены — мимо
    if (url.pathname.indexOf('/api/') >= 0) return;           // серверный прокси — мимо
    if (url.pathname.indexOf('/rest/v1') >= 0) return;

    // сеть в приоритете, кэш — резерв: так обновления доезжают сразу
    event.respondWith(
        fetch(req).then(function (res) {
            if (res && res.status === 200 && res.type === 'basic') {
                var copy = res.clone();
                caches.open(CACHE).then(function (c) { c.put(req, copy); });
            }
            return res;
        }).catch(function () {
            return caches.match(req).then(function (hit) {
                return hit || caches.match('./index.html');
            });
        })
    );
});
