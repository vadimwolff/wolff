/* WolffMsg service worker.
   Оболочка приложения отдаётся из кэша мгновенно, а свежая версия
   подтягивается в фоне. Запросы к API не кэшируются никогда. */

var CACHE = 'wolffmsg-v50-1';

var SHELL = [
    './',
    './index.html',
    './assets/styles.css',
    './assets/app.js',
    './assets/config.js',
    './assets/crypto.js',
    './assets/icon.svg',
    './assets/manifest.webmanifest'
];

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE)
            .then(function (cache) { return cache.addAll(SHELL); })
            .then(function () { return self.skipWaiting(); })
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

function fromNetwork(request) {
    return fetch(request).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(request, copy); });
        }
        return res;
    });
}

self.addEventListener('fetch', function (event) {
    var req = event.request;
    if (req.method !== 'GET') return;

    var url = new URL(req.url);
    if (url.origin !== self.location.origin) return;          // чужие домены — мимо
    if (url.pathname.indexOf('/api/') >= 0) return;           // серверный прокси — мимо
    if (url.pathname.indexOf('/rest/v1') >= 0) return;

    // Документ: сначала сеть (чтобы обновления доезжали), кэш — резерв.
    if (req.mode === 'navigate') {
        event.respondWith(
            fromNetwork(req).catch(function () {
                return caches.match(req).then(function (hit) {
                    return hit || caches.match('./index.html');
                });
            })
        );
        return;
    }

    // Статика: мгновенно из кэша, обновление тихо подтягивается в фоне.
    event.respondWith(
        caches.match(req).then(function (hit) {
            var network = fromNetwork(req).catch(function () { return hit; });
            return hit || network;
        })
    );
});
