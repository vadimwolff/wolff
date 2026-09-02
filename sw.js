/* WolffMsg service worker.
   Оболочка приложения отдаётся из кэша мгновенно, а свежая версия
   подтягивается в фоне. Запросы к API не кэшируются никогда. */

var CACHE = 'wolffmsg-v58-1';

var SHELL = [
    './',
    './index.html',
    './manifest.webmanifest',
    './assets/styles.css',
    './assets/app.js',
    './assets/config.js',
    './assets/crypto.js',
    './assets/icon.svg',
    './assets/icon-192.png',
    './assets/icon-512.png',
    './assets/badge-96.png'
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
    // Если по адресу ничего нет (ярлык старой версии вёл в подпапку), отдаём
    // саму оболочку приложения, а не чужую страницу «не найдено».
    if (req.mode === 'navigate') {
        event.respondWith(
            fromNetwork(req).then(function (res) {
                if (res && res.status === 404) {
                    return caches.match('./index.html').then(function (hit) {
                        return hit || fetch('./index.html').catch(function () { return res; });
                    });
                }
                return res;
            }).catch(function () {
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

/* ==========================================================================
   УВЕДОМЛЕНИЯ

   Нажатие на уведомление открывает нужный чат: если приложение уже запущено,
   переключаем на него, иначе открываем новое окно с адресом чата.
   ========================================================================== */

self.addEventListener('notificationclick', function (event) {
    var data = (event.notification && event.notification.data) || {};
    event.notification.close();

    var target = './';
    if (data.room) {
        target = './?open=' + encodeURIComponent(data.room) +
            (data.msg ? '&msg=' + encodeURIComponent(data.msg) : '');
    }

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
            for (var i = 0; i < list.length; i++) {
                var client = list[i];
                if (client.url.indexOf(self.registration.scope) === 0 && 'focus' in client) {
                    client.postMessage({ type: 'open-chat', room: data.room, msg: data.msg });
                    return client.focus();
                }
            }
            if (self.clients.openWindow) return self.clients.openWindow(target);
        })
    );
});

/* Настройки чатов приложение дублирует в базу браузера: сюда, в service
   worker, localStorage не виден, а знать про отключённый звук нужно. */
function readPrefs() {
    return new Promise(function (resolve) {
        if (!self.indexedDB) { resolve({}); return; }
        var req = indexedDB.open('wolffmsg', 1);
        req.onsuccess = function () {
            try {
                var db = req.result;
                if (!db.objectStoreNames.contains('keys')) { resolve({}); return; }
                var get = db.transaction('keys', 'readonly').objectStore('keys').get('prefs');
                get.onsuccess = function () { resolve(get.result || {}); };
                get.onerror = function () { resolve({}); };
            } catch (e) { resolve({}); }
        };
        req.onerror = function () { resolve({}); };
        req.onblocked = function () { resolve({}); };
    });
}

/* Уведомление о новом сообщении, когда приложение закрыто или свёрнуто. */
self.addEventListener('push', function (event) {
    var payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch (e) { payload = {}; }

    var show = Promise.all([
        readPrefs(),
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    ]).then(function (res) {
        var prefs = res[0] || {};
        var clients = res[1] || [];

        // Чат отключён человеком — молчим.
        if (payload.room && prefs[payload.room] && prefs[payload.room].muted) return null;

        // Приложение открыто на экране: там уже есть свои уведомления и звук.
        for (var i = 0; i < clients.length; i++) {
            if (clients[i].visibilityState === 'visible' && clients[i].focused) return null;
        }

        return self.registration.showNotification(payload.title || 'WolffMsg', {
            body: payload.body || 'Новое сообщение',
            icon: './assets/icon-192.png',
            badge: './assets/badge-96.png',
            tag: payload.room || 'wolffmsg',
            renotify: true,
            data: { room: payload.room, msg: payload.msg }
        });
    });

    event.waitUntil(show);
});
