/* ==========================================================================
 * WolffMsg — клиентское приложение
 *
 * Ключевые решения:
 *   · сообщения обновляются точечно (сверка DOM по ключам), поэтому список не
 *     пересобирается на каждом опросе и ничего не мигает;
 *   · последнее состояние кэшируется локально и рисуется мгновенно, ещё до
 *     ответа сервера;
 *   · адрес API выбирается из нескольких кандидатов параллельно и меняется на
 *     лету, если сеть изменилась (например включили VPN);
 *   · переписку можно зашифровать секретным кодом — сервер видит только шифртекст.
 * ========================================================================== */
(function () {
    'use strict';

    var CFG = window.WM_CONFIG;
    var CR = window.WMCrypto;

    var LS = {
        user: 'WM_DATA_USER',
        chats: 'WM_DATA_FRIENDS',
        prefs: 'WM_PREFS',
        reads: 'WM_READS',
        theme: 'WM_THEME',
        motion: 'WM_MOTION',
        api: 'WM_API_URL',
        apiActive: 'WM_API_ACTIVE',
        cacheChats: 'WM_CACHE_CHATS',
        cacheMsgs: 'WM_CACHE_MSGS_',
        code: 'WM_CODE_',
        identity: 'WM_IDENTITY',
        notify: 'WM_NOTIFY',
        notified: 'WM_NOTIFIED',
        recent: 'WM_RECENT',
        sound: 'WM_SOUND',
        online: 'WM_ONLINE',
        server: 'WM_SERVER',
        aiUrl: 'WM_AI_URL'
    };

    var THEMES = [
        { id: 'dark', label: 'Графит', bg: '#0e0e10', a: '#434b7d', b: '#1e1e23' },
        { id: 'light', label: 'Снег', bg: '#f4f5f7', a: '#d5dff9', b: '#ffffff' },
        { id: 'fog', label: 'Туман', bg: '#ecedf0', a: '#d1d9e2', b: '#ffffff' },
        { id: 'sand', label: 'Песок', bg: '#f6f2ea', a: '#e7d6ba', b: '#fffdf8' },
        { id: 'dusk', label: 'Сумерки', bg: '#0f1319', a: '#2c496d', b: '#1c232d' },
        { id: 'moss', label: 'Мох', bg: '#0f1310', a: '#324a36', b: '#1b221c' }
    ];

    /* Прежние названия тем — на ближайшие по настроению из нового набора. */
    var THEME_ALIASES = { ocean: 'dusk', forest: 'moss', lavender: 'dusk', emerald: 'moss', purple: 'dusk' };

    var EMOJIS = ['👍', '❤️', '🔥', '😂', '😮', '😢'];
    var TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    var LOCKED_LABEL = '🔒 Зашифровано — введите код чата';

    /* ---------------------------------------------------------------- state */

    var state = {
        me: null,
        chats: [],
        profiles: {},
        activeRoom: null,
        activeChat: null,
        msgs: [],
        reads: {},
        photos: {},             // id вложения -> готовое изображение
        photoTasks: {},         // id -> Promise загрузки
        hasAttachments: true,   // есть ли таблица вложений
        pinBottom: true,        // держать ли чат прижатым к последнему сообщению
        keys: {},               // room_id -> CryptoKey (ключ комнаты)
        keyTasks: {},           // room_id -> Promise, чтобы не запрашивать ключ дважды
        virtual: {},            // комнаты обсуждений под записями канала
        commentCounts: {},      // id записи -> число комментариев
        identity: null,         // { publicKey (base64), privateKey (CryptoKey) }
        vault: null,            // { wrapped, salt } — закрытый ключ под паролем
        hasKeyStore: true,      // есть ли таблица room_keys
        selectedRoom: null,
        pickerOpen: null,
        pendingRender: false,
        replyTo: null,          // сообщение, на которое отвечаем
        unreadFrom: null,       // граница «непрочитанные» на момент открытия чата
        newCount: 0,            // сколько новых сообщений пришло, пока читали историю
        atBottom: true,
        registerMode: false,
        page: 'auth',
        search: '',
        searchMode: false,      // открыт ли экран поиска
        globalResults: null,
        msgResults: null,       // найденное в загруженной переписке
        listSig: '',
        globalSig: '',
        msgSig: '',
        listTimer: null,
        chatTimer: null,
        searchTimer: null,
        busy: false,
        kbManual: false,
        installTab: 'desktop',
        call: null,             // текущий звонок
        callTimer: null,
        callPoll: null,
        callRing: null,
        callsReady: false,      // есть ли в базе таблица звонков
        wakeLock: null,
        gifTimer: null,
        lastCallId: 0,
        services: {},           // имя службы -> адрес, null — службы нет
        serviceTasks: {},
        serviceTried: {},       // что перебрали при поиске — видно в настройках
        aiBusy: false,
        firstChatPaint: true,
        serverChats: true,
        hasPreviews: true,
        hasSearch: true,
        hasReplies: true,
        hasPublicKeys: true,
        hasPresence: true,      // есть ли в базе колонки статуса «в сети»
        presenceTimer: null
    };

    /* --------------------------------------------------------------- утилиты */

    function $(id) { return document.getElementById(id); }

    function esc(s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function readJSON(key, def) {
        try {
            var raw = localStorage.getItem(key);
            if (!raw || raw === 'undefined' || raw === 'null') return def;
            var val = JSON.parse(raw);
            return val === null || val === undefined ? def : val;
        } catch (e) { return def; }
    }

    function writeJSON(key, val) {
        try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* приватный режим или переполнение */ }
    }

    var toastTimer = null;
    function toast(text) {
        var t = $('toast');
        t.textContent = text;
        t.classList.add('visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { t.classList.remove('visible'); }, 2600);
    }

    /* Виброотклик — короткий и почти незаметный: он подсказывает, что
       нажатие засчитано, и не должен «бить по руке». Длинная вибрация
       осталась только у входящего звонка, и та мягким пунктиром. */
    var TAP_BUZZ = 6;

    function vibrate(ms) {
        if (!navigator.vibrate) return;
        try { navigator.vibrate(ms === undefined ? TAP_BUZZ : ms); } catch (e) { /* no-op */ } 
    }

    function delay(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    function fmtTime(iso) {
        var d = new Date(iso);
        if (isNaN(d)) return '';
        return pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function fmtListTime(iso) {
        var d = new Date(iso);
        if (isNaN(d)) return '';
        var now = new Date();
        if (d.toDateString() === now.toDateString()) return fmtTime(iso);
        var y = new Date(now.getTime() - 86400000);
        if (d.toDateString() === y.toDateString()) return 'вчера';
        return pad(d.getDate()) + '.' + pad(d.getMonth() + 1);
    }

    function fmtDay(iso) {
        var d = new Date(iso);
        if (isNaN(d)) return '';
        var now = new Date();
        if (d.toDateString() === now.toDateString()) return 'Сегодня';
        var y = new Date(now.getTime() - 86400000);
        if (d.toDateString() === y.toDateString()) return 'Вчера';
        var months = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля',
            'августа', 'сентября', 'октября', 'ноября', 'декабря'];
        return d.getDate() + ' ' + months[d.getMonth()];
    }

    function plural(n, one, few, many) {
        var m10 = n % 10, m100 = n % 100;
        if (m10 === 1 && m100 !== 11) return n + ' ' + one;
        if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return n + ' ' + few;
        return n + ' ' + many;
    }

    /* ------------------------------------------------------------- ссылки

       В тексте сообщения кликабельными становятся только сами адреса —
       остальной текст остаётся обычным. Адрес сначала вырезается из текста,
       и только потом всё экранируется, поэтому разметку через сообщение не
       протащить. */

    var TLD = 'ru|com|org|net|io|me|dev|app|info|biz|tv|cc|co|ua|by|kz|su|xyz|online|store|site|рф';
    var LINK_RE = new RegExp(
        '(https?:\\/\\/[^\\s<]+' +                       // полный адрес
        '|www\\.[^\\s<]+' +                              // без протокола
        '|[a-z0-9][a-z0-9-]*\\.(?:' + TLD + ')(?:\\/[^\\s<]*)?)',  // просто домен
        'gi');

    /* Хвостовые знаки препинания в адрес не входят: «зайди на site.ru.» */
    function trimTail(url) {
        var tail = '';
        while (url.length && '.,;:!?»"\''.indexOf(url.slice(-1)) >= 0) {
            tail = url.slice(-1) + tail;
            url = url.slice(0, -1);
        }
        // Закрывающая скобка отрезается, только если её нечем закрыть.
        while (url.slice(-1) === ')' && url.split('(').length <= url.split(')').length - 1) {
            tail = ')' + tail;
            url = url.slice(0, -1);
        }
        return { url: url, tail: tail };
    }

    function linkify(text) {
        var out = '';
        var last = 0;
        var match;
        LINK_RE.lastIndex = 0;

        while ((match = LINK_RE.exec(String(text))) !== null) {
            // Хвост почтового адреса ссылкой не считаем: в «a@b.ru» ссылки нет.
            var before = match.index > 0 ? String(text).charAt(match.index - 1) : '';
            if (before && /[@\w]/.test(before)) continue;

            var piece = trimTail(match[0]);
            if (!piece.url) continue;

            var href = /^https?:\/\//i.test(piece.url) ? piece.url : 'https://' + piece.url;
            if (!/^https?:\/\//i.test(href)) continue;          // ничего, кроме http(s)

            out += esc(String(text).slice(last, match.index));
            out += '<a class="link" href="' + esc(href) + '" target="_blank" ' +
                'rel="noopener noreferrer nofollow">' + esc(piece.url) + '</a>';
            out += esc(piece.tail);
            last = match.index + match[0].length;
        }

        out += esc(String(text).slice(last));
        return out.replace(/\n/g, '<br>');
    }

    function isImage(text) { return typeof text === 'string' && text.indexOf('data:image/') === 0; }

    /* Новый формат фотографии: в сообщении лежит только ссылка на вложение,
       поэтому список сообщений остаётся лёгким. */
    function isPhotoRef(text) { return typeof text === 'string' && text.indexOf('wmimg:') === 0; }
    function isVoiceRef(text) { return typeof text === 'string' && text.indexOf('wmvoice:') === 0; }
    function isVideoRef(text) { return typeof text === 'string' && text.indexOf('wmvid:') === 0; }
    function isCallLog(text) { return typeof text === 'string' && text.indexOf('wmcall:') === 0; }
    function isGifRef(text) { return typeof text === 'string' && text.indexOf('wmgif:') === 0; }

    /* «wmgif:<номер вложения>:<ширина>:<высота>» */
    function gifInfo(text) {
        var parts = String(text).split(':');
        return {
            id: parts[1] || '',
            width: Math.max(1, Number(parts[2]) || 200),
            height: Math.max(1, Number(parts[3]) || 200)
        };
    }

    /* «wmcall:<секунд>:<состояние>» */
    function callLogText(text) {
        var parts = String(text).split(':');
        var seconds = Math.max(0, Math.round(Number(parts[1]) || 0));
        var status = parts[2] || 'done';
        if (seconds) return '📞 Звонок · ' + fmtDuration(seconds);
        return status === 'declined' ? '📞 Звонок отклонён' : '📞 Пропущенный звонок';
    }

    /* «wmvid:<номер вложения>:<секунд>» */
    function videoInfo(text) {
        var parts = String(text).split(':');
        return { id: parts[1] || '', seconds: Math.max(0, Math.round(Number(parts[2]) || 0)) };
    }

    /* «wmvoice:<номер вложения>:<секунд>» */
    function voiceInfo(text) {
        var parts = String(text).split(':');
        return { id: parts[1] || '', seconds: Math.max(1, Math.round(Number(parts[2]) || 1)) };
    }

    function fmtDuration(sec) {
        sec = Math.max(0, Math.round(sec));
        return Math.floor(sec / 60) + ':' + pad(sec % 60);
    }
    function isPhoto(text) { return isImage(text) || isPhotoRef(text); }
    function attachmentId(text) { return String(text).slice('wmimg:'.length); }

    function hashCode(s) {
        var h = 0, i;
        for (i = 0; i < String(s).length; i++) h = (h * 31 + String(s).charCodeAt(i)) | 0;
        return Math.abs(h);
    }

    /* Аватар рисуется локально: никаких обращений к внешним сервисам. */
    function avatarFor(name, seed) {
        var palette = ['#0a84ff', '#ff375f', '#30d158', '#ff9f0a', '#bf5af2', '#64d2ff', '#ff6482', '#5e5ce6'];
        var color = palette[hashCode(seed || name || '?') % palette.length];
        var letters = String(name || '?').trim().split(/\s+/).slice(0, 2)
            .map(function (w) { return w.charAt(0); }).join('').toUpperCase() || '?';
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">' +
            '<rect width="128" height="128" rx="38" fill="' + color + '"/>' +
            '<text x="64" y="64" font-family="Helvetica,Arial,sans-serif" font-size="52" font-weight="bold"' +
            ' fill="#fff" text-anchor="middle" dominant-baseline="central">' + esc(letters) + '</text></svg>';
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }

    /* ------------------------------------------------------------ API-слой */

    var api = {
        base: null,          // адрес, ответивший последним
        probing: null,
        statuses: {},        // url -> 'ok' | 'bad' | 'wait'
        health: {}           // url -> { fails, cooldownUntil, latency }
    };

    function endpointUrl(raw) {
        if (raw.indexOf('same-origin:') === 0) {
            var rel = raw.slice('same-origin:'.length).replace(/^\/+/, '');
            return new URL(rel, location.href).href.replace(/\/+$/, '');
        }
        return raw.replace(/\/+$/, '');
    }

    function candidates() {
        var list = [];
        var custom = localStorage.getItem(LS.api);
        if (custom) list.push({ url: custom.replace(/\/+$/, ''), label: 'Ваш канал связи', custom: true });
        CFG.endpoints.forEach(function (e) {
            var url = endpointUrl(e.url);
            if (!list.some(function (x) { return x.url === url; })) list.push({ url: url, label: e.label });
        });
        return list;
    }

    function healthOf(url) {
        if (!api.health[url]) api.health[url] = { fails: 0, cooldownUntil: 0, latency: null };
        return api.health[url];
    }

    function markOk(url, ms) {
        var h = healthOf(url);
        h.fails = 0;
        h.cooldownUntil = 0;
        h.latency = ms;
        api.statuses[url] = 'ok';
    }

    /* Сбойный адрес не выбрасывается навсегда — он отправляется «на отдых»
       с растущей паузой, поэтому мигающий прокси не блокирует работу. */
    function markBad(url) {
        var h = healthOf(url);
        h.fails++;
        h.cooldownUntil = Date.now() + Math.min(120000, 4000 * Math.pow(2, h.fails - 1));
        api.statuses[url] = 'bad';
    }

    /* Порядок перебора: сначала рабочие, потом отдыхающие; при равенстве —
       порядок из настроек, а последний успешный адрес идёт первым. */
    function orderedCandidates() {
        var now = Date.now();
        var active = api.base || localStorage.getItem(LS.apiActive);
        return candidates().map(function (c, i) {
            var h = healthOf(c.url);
            return {
                url: c.url,
                label: c.label,
                order: i,
                cooling: h.cooldownUntil > now,
                fails: h.fails,
                preferred: c.url === active ? 0 : 1
            };
        }).sort(function (a, b) {
            if (a.cooling !== b.cooling) return a.cooling ? 1 : -1;
            if (a.preferred !== b.preferred) return a.preferred - b.preferred;
            if (a.fails !== b.fails) return a.fails - b.fails;
            return a.order - b.order;
        });
    }

    /* Свой сервер (/api/db) подставляет ключ базы сам, поэтому в браузер его
       отдавать незачем: через прокси запросы уходят вообще без ключа. Ключ
       нужен только прямым адресам. */
    function needsKey(url) {
        return !/\/api\/db\/?$/.test(String(url || ''));
    }

    function headers(extra, url) {
        var h = { 'Content-Type': 'application/json' };
        if (CFG.apiKey && needsKey(url === undefined ? api.base : url)) {
            h.apikey = CFG.apiKey;
            h.Authorization = 'Bearer ' + CFG.apiKey;
        }
        if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
        return h;
    }

    function fetchTimeout(url, opts, ms) {
        var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var o = Object.assign({}, opts);
        if (ctl) o.signal = ctl.signal;
        var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms || 15000);
        return fetch(url, o).then(function (r) { clearTimeout(timer); return r; },
            function (e) { clearTimeout(timer); throw e; });
    }

    /* Живой ли адрес: PostgREST обязан ответить JSON-ом. Статическая страница
       (например 404 GitHub Pages) отдаёт HTML и проверку не проходит. */
    function probe(url) {
        var started = Date.now();
        return fetchTimeout(url + '/profiles?select=id&limit=1',
            { headers: headers(null, url), cache: 'no-store' }, 8000)
            .then(function (r) {
                var ct = r.headers.get('content-type') || '';
                var ok = r.ok || (r.status >= 400 && r.status < 500 && ct.indexOf('json') >= 0);
                if (ok) markOk(url, Date.now() - started);
                else markBad(url);
                return ok;
            })
            .catch(function () { markBad(url); return false; });
    }

    function setNetState(ok, message) {
        var banner = $('net-banner');
        if (ok) {
            banner.hidden = true;
        } else {
            $('net-banner-text').textContent = message || 'Нет связи с сервером';
            banner.hidden = false;
        }
        var pill = $('conn-state');
        if (pill) {
            pill.textContent = ok ? 'на связи' : 'нет связи';
            pill.className = 'pill ' + (ok ? 'ok' : 'bad');
        }
    }

    /* Все адреса проверяются одновременно, но выбирается самый приоритетный из
       ответивших — так запуск не ждёт таймаутов недоступных адресов. */
    function resolveApi(force) {
        if (api.base && !force) return Promise.resolve(api.base);
        if (api.probing) return api.probing;

        var list = orderedCandidates();

        api.probing = new Promise(function (resolve) {
            var results = new Array(list.length).fill(null);
            var settled = false;

            function check() {
                if (settled) return;
                for (var i = 0; i < list.length; i++) {
                    if (results[i] === null) return;          // более приоритетный ещё думает
                    if (results[i] === true) {
                        settled = true;
                        api.base = list[i].url;
                        localStorage.setItem(LS.apiActive, api.base);
                        setNetState(true);
                        resolve(api.base);
                        return;
                    }
                }
                settled = true;
                api.base = null;
                setNetState(false, 'Сервер недоступен');
                resolve(null);
            }

            list.forEach(function (item, i) {
                api.statuses[item.url] = 'wait';
                probe(item.url).then(function (ok) {
                    results[i] = ok;
                    renderConnList();
                    check();
                });
            });
            renderConnList();
        }).then(function (res) { api.probing = null; return res; });

        return api.probing;
    }

    function WMError(message, status, code) {
        var e = new Error(message);
        e.status = status;
        e.code = code;
        return e;
    }

    function missingRelation(err) {
        return err && (err.status === 404 || err.code === 'PGRST202' || err.code === 'PGRST205');
    }

    function accessDenied(err) {
        if (!err) return false;
        if (err.code === '42501') return true;
        if (err.status === 401 || err.status === 403) return true;
        return /permission denied/i.test(err.message || '');
    }

    function schemaHint() {
        return WMError('База ещё не готова принимать регистрацию. В Supabase → SQL Editor ' +
            'выполните db/schema.sql, затем строку: notify pgrst, \'reload schema\'; ' +
            'и повторите через минуту.');
    }

    /* Ошибка самого адреса (сеть, таймаут, сбой шлюза), а не ответ базы: такой
       запрос имеет смысл повторить на другом адресе. */
    function isEndpointFailure(err) {
        if (!err) return false;
        if (!err.status) return true;                       // сеть или таймаут
        return err.status >= 500 || err.status === 429 || err.status === 408;
    }

    /*
     * Запрос с переключением адресов на лету.
     *
     * Раньше адрес выбирался один раз и запоминался; если прокси начинал
     * «моргать», каждый запрос сначала ждал таймаут и только потом искал
     * замену. Теперь при сбое адреса запрос немедленно повторяется на
     * следующем кандидате, а неудачник уходит на паузу с растущим интервалом.
     */
    function request(path, opts) {
        opts = opts || {};

        var list = orderedCandidates();
        if (!list.length) return Promise.reject(WMError('Нет адресов сервера', 0));

        var lastError = null;
        var round = 0;

        function attempt(i) {
            if (i >= list.length) {
                if (round === 0 && list.length) {
                    // второй заход: адрес мог ожить, сеть могла переключиться
                    round++;
                    return delay(700).then(function () { return attempt(0); });
                }
                setNetState(false, 'Нет связи с сервером');
                throw lastError || WMError('Нет соединения', 0);
            }

            var url = list[i].url;
            var started = Date.now();

            return fetchTimeout(url + path, {
                method: opts.method || 'GET',
                headers: headers(opts.headers, url),
                body: opts.body ? JSON.stringify(opts.body) : undefined,
                cache: 'no-store'
            }, opts.timeout || 15000).then(function (res) {
                if (res.status >= 500 || res.status === 429) {
                    throw WMError('Сервер отвечает ошибкой ' + res.status, res.status);
                }
                markOk(url, Date.now() - started);
                if (api.base !== url) {
                    api.base = url;
                    localStorage.setItem(LS.apiActive, url);
                    renderConnList();
                }
                setNetState(true);

                if (res.status === 204 || res.status === 205) return null;
                return res.text().then(function (txt) {
                    var data = null;
                    if (txt) { try { data = JSON.parse(txt); } catch (e) { data = txt; } }
                    if (!res.ok) {
                        var text = (data && data.message) || ('Ошибка ' + res.status);
                        var code = data && data.code;
                        if (code === '42501' || /permission denied/i.test(text)) {
                            text = 'Недостаточно прав в базе — проверьте, что выполнен db/schema.sql';
                        }
                        throw WMError(text, res.status, code);
                    }
                    return data;
                });
            }).catch(function (err) {
                if (!isEndpointFailure(err)) throw err;      // ответ базы — не вина адреса
                markBad(url);
                lastError = err;
                renderConnList();
                return attempt(i + 1);
            });
        }

        return attempt(0);
    }

    function rpc(name, args) {
        return request('/rpc/' + name, { method: 'POST', body: args });
    }

    function q(v) { return encodeURIComponent(v); }

    /* ==================================================================
       ШИФРОВАНИЕ

       У каждого устройства есть пара ключей. У каждого чата — свой случайный
       ключ, зашифрованный для каждого участника общим секретом ECDH. Сервер
       хранит только шифртекст: ни ключ чата, ни закрытый ключ ему не видны.
       ================================================================== */

    function cryptoReady() {
        return !!(CR && CR.available() && state.identity && state.identity.privateKey);
    }

    /* Хранилище ключей.

       Закрытый ключ лежит в собственной базе браузера как «неизвлекаемый»
       объект: расшифровать им можно, а выгрузить его содержимое нельзя — ни
       расширению, ни постороннему коду. Рядом хранится копия ключа,
       зашифрованная паролем: она нужна только для смены пароля и без пароля
       бесполезна. */

    var IDB_NAME = 'wolffmsg';
    var IDB_STORE = 'keys';

    function idb() {
        if (!window.indexedDB) return Promise.reject(new Error('no_idb'));
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open(IDB_NAME, 1);
            req.onupgradeneeded = function () {
                if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error || new Error('idb')); };
        });
    }

    function idbPut(key, value) {
        return idb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).put(value, key);
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { reject(tx.error || new Error('idb_put')); };
            });
        });
    }

    function idbGet(key) {
        return idb().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(IDB_STORE, 'readonly');
                var req = tx.objectStore(IDB_STORE).get(key);
                req.onsuccess = function () { resolve(req.result || null); };
                req.onerror = function () { reject(req.error || new Error('idb_get')); };
            });
        });
    }

    function idbDelete(key) {
        return idb().then(function (db) {
            return new Promise(function (resolve) {
                var tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).delete(key);
                tx.oncomplete = function () { resolve(true); };
                tx.onerror = function () { resolve(false); };
            });
        }).catch(function () { return false; });
    }

    /* vault — { wrapped, salt }: закрытый ключ под паролем, нужен при его смене. */
    function saveIdentity(identity, vault) {
        state.identity = identity;
        if (vault && vault.wrapped && vault.salt) state.vault = vault;

        var store = function (privateKey) {
            return idbPut('identity', {
                publicKey: identity.publicKey,
                privateKey: privateKey,
                vault: state.vault || null
            });
        };

        // В хранилище кладём неизвлекаемую копию; извлекаемая остаётся только
        // в памяти этой вкладки, пока она нужна для выдачи ключей.
        return CR.hardenPrivate(identity.privateKey)
            .then(store)
            .catch(function () { return store(identity.privateKey).catch(function () { /* ключ живёт в памяти */ }); })
            .then(function () { localStorage.removeItem(LS.identity); });
    }

    function loadIdentity() {
        if (!CR || !CR.available()) return Promise.resolve(null);

        return idbGet('identity').catch(function () { return null; }).then(function (rec) {
            if (rec && rec.privateKey) {
                state.identity = { publicKey: rec.publicKey, privateKey: rec.privateKey };
                state.vault = rec.vault || null;
                return state.identity;
            }
            return migrateIdentity();
        }).catch(function () { return null; });
    }

    /* Ключ прошлой версии лежал в localStorage открытым текстом — переносим
       его в защищённое хранилище и стираем старую копию. */
    function migrateIdentity() {
        var stored = readJSON(LS.identity, null);
        if (!stored || !stored.privateJwk) return null;
        return CR.importPrivateJwk(stored.privateJwk, false).then(function (priv) {
            state.identity = { publicKey: stored.publicKey, privateKey: priv };
            return idbPut('identity', {
                publicKey: stored.publicKey, privateKey: priv, vault: null
            }).catch(function () { /* останется в памяти */ });
        }).then(function () {
            localStorage.removeItem(LS.identity);
            return state.identity;
        }).catch(function () { return null; });
    }

    /* Создаём ключи при регистрации, восстанавливаем при входе, а аккаунтам
       без ключей (созданным до этой версии) выдаём их при первом входе. */
    function prepareIdentity(password, keys) {
        if (!CR || !CR.available()) return Promise.resolve(null);

        if (keys && keys.enc_private_key && keys.key_salt) {
            return CR.passwordKey(password, keys.key_salt)
                .then(function (pk) { return CR.unwrapPrivate(keys.enc_private_key, pk, false); })
                .then(function (priv) {
                    return saveIdentity({ publicKey: keys.public_key, privateKey: priv },
                        { wrapped: keys.enc_private_key, salt: keys.key_salt });
                })
                .then(function () { return state.identity; })
                .catch(function () { return null; });      // пароль сменили на другом устройстве
        }
        return null;
    }

    function createIdentity(password) {
        if (!CR || !CR.available()) return Promise.resolve(null);
        var salt = CR.randomSalt();
        var identity;
        return CR.generateIdentity().then(function (id) {
            identity = id;
            return CR.passwordKey(password, salt);
        }).then(function (pk) {
            return CR.wrapPrivate(identity.privateKey, pk);
        }).then(function (wrapped) {
            return saveIdentity(identity, { wrapped: wrapped, salt: salt }).then(function () {
                return {
                    public_key: identity.publicKey,
                    enc_private_key: wrapped,
                    key_salt: salt
                };
            });
        }).catch(function () { return null; });
    }

    /* ==================================================================
       «В СЕТИ»

       Приложение отмечает своё присутствие в профиле раз в минуту, а рядом
       лежит разрешение показывать это другим. Выключенный переключатель
       прячет отметку у всех: другие видят просто имя, без времени.
       ================================================================== */

    var ONLINE_MS = 60000;          // как часто отмечаемся
    var ONLINE_WINDOW = 90000;      // до этого возраста отметка считается «в сети»

    function showOnline() {
        return localStorage.getItem(LS.online) !== 'off';
    }

    function touchOnline() {
        if (!state.me || !state.hasPresence) return Promise.resolve();
        return request('/profiles?id=eq.' + q(state.me.id), {
            method: 'PATCH',
            body: { last_seen: new Date().toISOString(), show_online: showOnline() }
        }).catch(function (err) {
            // База прошлой версии — просто живём без статусов.
            if (err.status === 400 || missingRelation(err)) state.hasPresence = false;
            return null;
        });
    }

    /* Текст статуса собеседника: «в сети», «был(а) в 14:05» или ничего. */
    function presenceText(profile) {
        if (!state.hasPresence || !profile) return '';
        if (profile.show_online === false || !profile.last_seen) return '';

        var seen = new Date(profile.last_seen).getTime();
        if (!seen) return '';
        var gap = Date.now() - seen;
        if (gap < ONLINE_WINDOW) return 'в сети';

        var when = new Date(seen);
        var today = new Date();
        var sameDay = when.toDateString() === today.toDateString();
        if (gap < 3600000) {
            var mins = Math.max(1, Math.round(gap / 60000));
            return 'был(а) ' + mins + ' ' + plural(mins, 'минуту', 'минуты', 'минут') + ' назад';
        }
        return sameDay ? 'был(а) в ' + fmtTime(profile.last_seen)
            : 'был(а) ' + fmtDay(profile.last_seen);
    }

    function updateOnlinePill() {
        var pill = $('online-state');
        if (!pill) return;
        var on = showOnline();
        pill.textContent = on ? 'вкл' : 'выкл';
        pill.className = 'pill ' + (on ? 'ok' : '');
    }

    function toggleOnline() {
        var on = !showOnline();
        localStorage.setItem(LS.online, on ? 'on' : 'off');
        updateOnlinePill();
        touchOnline();
        toast(on ? 'Другие видят, когда вы в сети' : 'Статус «в сети» скрыт');
    }

    function profileCols() {
        var cols = 'id,nickname,name,avatar';
        if (state.hasPublicKeys) cols += ',public_key';
        if (state.hasPresence) cols += ',last_seen,show_online';
        return cols;
    }

    /* Запрос профилей с откатом: в базе прошлой версии части колонок нет,
       и PostgREST отвечает на них ошибкой 400. */
    function fetchProfiles(filter) {
        var base = 'id,nickname,name,avatar';
        var retry = function (err) {
            if (err.status !== 400) throw err;
            if (state.hasPresence) {                 // сначала отказываемся от статусов
                state.hasPresence = false;
                return request('/profiles?' + filter + '&select=' + profileCols()).catch(retry);
            }
            if (state.hasPublicKeys) {
                state.hasPublicKeys = false;
                return request('/profiles?' + filter + '&select=' + base);
            }
            throw err;
        };
        return request('/profiles?' + filter + '&select=' + profileCols()).catch(retry);
    }

    function publicKeyOf(userId) {
        var p = state.profiles[userId];
        return p && p.public_key ? p.public_key : null;
    }

    /* Ключ чата: берём готовый, расшифровываем свою копию или создаём новый. */
    function ensureRoomKey(room) {
        var chat = findChat(room);
        if (!chat || chat.kind === 'channel' || chat.kind === 'comments') return Promise.resolve(null);
        if (!cryptoReady() || !state.hasKeyStore) return Promise.resolve(null);

        return request('/room_keys?room_id=eq.' + q(room) + '&user_id=eq.' + q(state.me.id) +
            '&select=wrapped_key,wrapped_by&limit=1')
            .catch(function (err) {
                if (missingRelation(err)) { state.hasKeyStore = false; return null; }
                throw err;
            })
            .then(function (rows) {
                if (rows && rows.length) return unwrapRoomKey(rows[0]);
                return createRoomKey(chat);
            })
            .catch(function () { return null; });
    }

    function unwrapRoomKey(row) {
        var author = row.wrapped_by || state.me.id;
        return loadProfiles([author]).then(function () {
            var pub = publicKeyOf(author);
            if (!pub) return null;
            return CR.sharedKey(state.identity.privateKey, pub)
                .then(function (shared) { return CR.decrypt(shared, row.wrapped_key); })
                .then(function (raw) { return CR.importRoomKey(raw); });
        }).catch(function () { return null; });
    }

    function createRoomKey(chat) {
        var members = (chat.members || []).slice();
        if (members.indexOf(state.me.id) < 0) members.push(state.me.id);

        return loadProfiles(members).then(function () {
            var missing = members.filter(function (id) { return !publicKeyOf(id); });
            if (missing.length) return null;              // у кого-то старая версия

            var roomKey;
            return CR.randomRoomKey().then(function (key) {
                roomKey = key;
                return CR.exportRoomKey(key);
            }).then(function (raw) {
                return Promise.all(members.map(function (id) {
                    return CR.sharedKey(state.identity.privateKey, publicKeyOf(id))
                        .then(function (shared) { return CR.encrypt(shared, raw); })
                        .then(function (wrapped) {
                            return {
                                room_id: chat.room_id,
                                user_id: id,
                                wrapped_key: wrapped,
                                wrapped_by: state.me.id
                            };
                        });
                }));
            }).then(function (rows) {
                /* Если ключ комнаты в этот же момент создаёт собеседник, побеждает
                   тот, кто записал первым: ignore-duplicates не затирает чужую
                   строку. Раньше здесь стояло merge-duplicates — два ключа
                   перетирали друг друга, и часть сообщений навсегда оставалась
                   нечитаемой. */
                return request('/room_keys', {
                    method: 'POST',
                    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
                    body: rows
                }).then(function () {
                    // Берём то, что в итоге лежит в базе, а не то, что отправляли.
                    return request('/room_keys?room_id=eq.' + q(chat.room_id) +
                        '&user_id=eq.' + q(state.me.id) + '&select=wrapped_key,wrapped_by&limit=1')
                        .then(function (saved) {
                            if (saved && saved.length) return unwrapRoomKey(saved[0]);
                            return roomKey;
                        })
                        .catch(function () { return roomKey; });
                });
            });
        }).catch(function () { return null; });
    }

    /* Выдаём ключ комнаты новому участнику группы. */
    function shareRoomKey(room, userId) {
        if (!cryptoReady() || !state.hasKeyStore) return Promise.resolve();
        return roomKey(room).then(function (key) {
            if (!key) return null;
            return loadProfiles([userId]).then(function () {
                var pub = publicKeyOf(userId);
                if (!pub) return null;
                return CR.exportRoomKey(key).then(function (raw) {
                    return CR.sharedKey(state.identity.privateKey, pub)
                        .then(function (shared) { return CR.encrypt(shared, raw); })
                        .then(function (wrapped) {
                            return request('/room_keys', {
                                method: 'POST',
                                headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
                                body: {
                                    room_id: room, user_id: userId,
                                    wrapped_key: wrapped, wrapped_by: state.me.id
                                }
                            });
                        });
                });
            });
        }).catch(function () { return null; });
    }

    function storedCode(room) {
        try { return localStorage.getItem(LS.code + room) || ''; } catch (e) { return ''; }
    }

    function roomKey(room) {
        if (!room || !CR || !CR.available()) return Promise.resolve(null);
        if (state.keys[room] !== undefined) return Promise.resolve(state.keys[room]);
        if (state.keyTasks[room]) return state.keyTasks[room];

        var code = storedCode(room);
        var task = code
            ? CR.deriveKey(code, room)                     // ручной код прошлой версии
            : ensureRoomKey(room);

        state.keyTasks[room] = task.then(function (key) {
            state.keys[room] = key || null;
            delete state.keyTasks[room];
            updateLockIcon(room);
            return state.keys[room];
        }).catch(function () {
            state.keys[room] = null;
            delete state.keyTasks[room];
            return null;
        });

        return state.keyTasks[room];
    }

    function updateLockIcon(room) {
        if (state.activeRoom !== room) return;
        var lock = $('chat-lock');
        if (lock) lock.hidden = !state.keys[room];
    }

    function setRoomCode(room, code) {
        try {
            if (code) localStorage.setItem(LS.code + room, code);
            else localStorage.removeItem(LS.code + room);
        } catch (e) { /* no-op */ }
        delete state.keys[room];
        delete state.keyTasks[room];
        try { localStorage.removeItem(LS.cacheMsgs + room); } catch (e) { /* no-op */ }
    }

    /* Расшифровывает тело сообщения и цитату один раз, результат кэшируется. */
    function decodeMessage(m, key) {
        if (m.body !== undefined) return Promise.resolve(m);

        var thumbTask = Promise.resolve();
        if (m.thumb) {
            if (!CR || !CR.isEncrypted(m.thumb)) {
                m.thumbBody = m.thumb;
            } else if (key) {
                thumbTask = CR.decrypt(key, m.thumb)
                    .then(function (plain) { m.thumbBody = plain; })
                    .catch(function () { m.thumbBody = null; });
            }
        }

        var quote = Promise.resolve();
        if (m.reply_preview) {
            if (!CR || !CR.isEncrypted(m.reply_preview)) {
                m.replyBody = m.reply_preview;
            } else if (!key) {
                m.replyBody = '🔒 …';
            } else {
                quote = CR.decrypt(key, m.reply_preview)
                    .then(function (plain) { m.replyBody = plain; })
                    .catch(function () { m.replyBody = '🔒 …'; });
            }
        }

        return Promise.all([quote, thumbTask]).then(function () {
            if (!CR || !CR.isEncrypted(m.text)) {
                m.body = m.text;
                m.encrypted = false;
                return m;
            }
            m.encrypted = true;
            if (!key) { m.body = LOCKED_LABEL; m.locked = true; return m; }
            return CR.decrypt(key, m.text).then(function (plain) {
                m.body = plain;
                m.locked = false;
                return m;
            }).catch(function () {
                m.body = LOCKED_LABEL;
                m.locked = true;
                return m;
            });
        });
    }

    function decodeAll(msgs, room) {
        return roomKey(room).then(function (key) {
            return Promise.all(msgs.map(function (m) { return decodeMessage(m, key); }));
        });
    }

    /* ------------------------------------------------------- навигация UI */

    function showPage(id, push) {
        var prev = state.page;
        state.page = id;
        var pages = document.querySelectorAll('.page');
        for (var i = 0; i < pages.length; i++) pages[i].classList.remove('active', 'leaving');
        var el = $('page-' + id);
        if (el) {
            el.classList.add('active');
            el.classList.remove('anim-right', 'anim-up');
            if (id === 'chat') el.classList.add('anim-right');
            if (id === 'settings') el.classList.add('anim-up');
        }
        closeChatMenu();
        if (push && history && history.pushState) {
            try { history.pushState({ wm: id, from: prev }, ''); } catch (e) { /* no-op */ }
        }
    }

    /* Системная кнопка «назад» сначала закрывает окно или поиск и только
       потом уводит с экрана — так же, как ожидается на телефоне. */
    window.addEventListener('popstate', function () {
        var keep = function () {
            try { history.pushState({ wm: state.page }, ''); } catch (e) { /* no-op */ }
        };
        if (closeTopModal()) { keep(); return; }
        if (state.searchMode) { closeSearch(); keep(); return; }
        if (state.page === 'chat') closeChat();
        else if (state.page === 'settings') showPage('main');
    });

    /* --------------------------------------------------------- авторизация */

    function setAuthMode(register) {
        state.registerMode = register;
        $('auth-title').textContent = register ? 'Регистрация' : 'С возвращением!';
        $('auth-subtitle').textContent = register
            ? 'Создайте аккаунт за пару секунд'
            : 'Войдите в свой аккаунт WolffMsg';
        $('auth-btn').textContent = register ? 'Создать аккаунт' : 'Войти';
        $('auth-swap-btn').textContent = register ? 'Уже есть аккаунт? Войти' : 'Создать новый аккаунт';
        $('a-name').hidden = !register;
        $('a-pass').setAttribute('autocomplete', register ? 'new-password' : 'current-password');
        $('auth-status').textContent = '';
    }

    function normalizeUser(u) {
        if (!u) return null;
        return {
            id: String(u.id),
            nickname: String(u.nickname || '').toLowerCase(),
            name: u.name || u.nickname || 'Пользователь',
            avatar: u.avatar || ''
        };
    }

    function handleAuth(ev) {
        if (ev) ev.preventDefault();
        if (state.busy) return;

        var nick = $('a-nick').value.trim().toLowerCase().replace(/^@+/, '');
        var pass = $('a-pass').value;
        var name = $('a-name').value.trim();

        if (!nick || !pass) { $('auth-status').textContent = 'Заполните никнейм и пароль'; return; }
        if (!/^[a-z0-9_.]{3,32}$/.test(nick)) {
            $('auth-status').textContent = 'Ник: 3–32 символа, латиница, цифры, _ и .';
            return;
        }
        // Пароль защищает и переписку: из него выводится ключ, которым
        // зашифрован закрытый ключ. Для новых аккаунтов минимум выше.
        if (state.registerMode && pass.length < 8) {
            $('auth-status').textContent = 'Пароль от 8 символов — им шифруется ваша переписка';
            return;
        }
        if (pass.length < 4) { $('auth-status').textContent = 'Пароль от 4 символов'; return; }

        state.busy = true;
        $('auth-btn').disabled = true;
        $('auth-btn').classList.add('loading');
        $('auth-status').textContent = state.registerMode ? 'Создаём аккаунт…' : 'Проверяем данные…';

        var task = state.registerMode ? doRegister(nick, pass, name || nick) : doLogin(nick, pass);

        task.then(function (res) {
            state.me = normalizeUser(res.user || res);
            writeJSON(LS.user, state.me);
            return setupKeys(nick, pass, res.keys);
        }).then(function () {
            $('a-pass').value = '';
            $('auth-status').textContent = '';
            toast(state.registerMode ? 'Аккаунт создан' : 'Вход выполнен');
            startApp();
        }).catch(function (err) {
            $('auth-status').textContent = err.message || 'Не удалось выполнить вход';
        }).then(function () {
            state.busy = false;
            $('auth-btn').disabled = false;
            $('auth-btn').classList.remove('loading');
        });
    }

    /* Ключи после входа: восстанавливаем свои или выдаём их аккаунту,
       созданному до появления шифрования. */
    function setupKeys(nick, pass, keys) {
        if (!CR || !CR.available()) return Promise.resolve();
        if (state.identity) return Promise.resolve();          // созданы при регистрации

        var restore = prepareIdentity(pass, keys);
        if (restore) {
            return restore.then(function (identity) {
                if (identity) return null;
                return issueKeys(nick, pass);
            });
        }
        return issueKeys(nick, pass);
    }

    function issueKeys(nick, pass) {
        return createIdentity(pass).then(function (bundle) {
            if (!bundle) return null;
            return rpc('wm_set_keys', {
                p_nickname: nick,
                p_password: pass,
                p_public_key: bundle.public_key,
                p_enc_private_key: bundle.enc_private_key,
                p_key_salt: bundle.key_salt
            }).catch(function () { return null; });            // старая база — работаем без шифрования
        }).catch(function () { return null; });
    }

    function doRegister(nick, pass, name) {
        return createIdentity(pass).then(function (bundle) {
            return doRegisterWith(nick, pass, name, bundle);
        });
    }

    function doRegisterWith(nick, pass, name, bundle) {
        return rpcRegister(nick, pass, name, bundle).catch(function (err) {
            if (!missingRelation(err)) throw err;
            return legacyRegister(nick, pass, name).catch(function (legacyErr) {
                if (!accessDenied(legacyErr)) throw legacyErr;
                return delay(1500)
                    .then(function () { return rpcRegister(nick, pass, name, bundle); })
                    .catch(function (retryErr) {
                        throw missingRelation(retryErr) ? schemaHint() : retryErr;
                    });
            });
        });
    }

    function rpcRegister(nick, pass, name, bundle) {
        // Полный набор параметров передаём всегда, даже без ключей: если в базе
        // остались обе версии функции, такой вызов однозначно выбирает новую.
        var args = {
            p_nickname: nick,
            p_password: pass,
            p_name: name,
            p_public_key: bundle ? bundle.public_key : null,
            p_enc_private_key: bundle ? bundle.enc_private_key : null,
            p_key_salt: bundle ? bundle.key_salt : null
        };
        return rpc('wm_register', args)
            .catch(function (err) {
                // база прошлой версии знает функцию только с тремя параметрами
                if (!missingRelation(err)) throw err;
                return rpc('wm_register', { p_nickname: nick, p_password: pass, p_name: name });
            })
            .then(function (res) {
                if (res && res.ok) return { user: res.user, keys: res.keys };
                var map = {
                    nickname_taken: 'Такой никнейм уже занят',
                    bad_nickname: 'Ник: 3–32 символа, латиница, цифры, _ и .',
                    weak_password: 'Пароль от 4 символов'
                };
                throw WMError((res && map[res.error]) || 'Не удалось зарегистрироваться');
            });
    }

    /* Совместимость со «старой» схемой без функций и хеширования паролей. */
    function legacyRegister(nick, pass, name) {
        return request('/profiles?nickname=eq.' + q(nick) + '&select=id&limit=1').then(function (rows) {
            if (rows && rows.length) throw WMError('Такой никнейм уже занят');
            var id = 'u' + Date.now() + Math.floor(Math.random() * 1000);
            return request('/profiles', {
                method: 'POST',
                headers: { Prefer: 'return=representation' },
                body: { id: id, nickname: nick, password: pass, name: name, avatar: '' }
            }).then(function (res) {
                if (res && res.length) return { user: res[0] };
                return { user: { id: id, nickname: nick, name: name, avatar: '' } };
            });
        });
    }

    function doLogin(nick, pass) {
        return rpcLogin(nick, pass).catch(function (err) {
            if (!missingRelation(err)) throw err;
            return legacyLogin(nick, pass).catch(function (legacyErr) {
                if (!accessDenied(legacyErr)) throw legacyErr;
                return delay(1500)
                    .then(function () { return rpcLogin(nick, pass); })
                    .catch(function (retryErr) {
                        throw missingRelation(retryErr) ? schemaHint() : retryErr;
                    });
            });
        });
    }

    function rpcLogin(nick, pass) {
        return rpc('wm_login', { p_nickname: nick, p_password: pass }).then(function (res) {
            if (res && res.ok) return { user: res.user, keys: res.keys };
            throw WMError('Неверный никнейм или пароль');
        });
    }

    function legacyLogin(nick, pass) {
        return request('/profiles?nickname=eq.' + q(nick) + '&password=eq.' + q(pass) + '&limit=1')
            .then(function (rows) {
                if (rows && rows.length) return { user: rows[0] };
                throw WMError('Неверный никнейм или пароль');
            });
    }

    function logout() {
        confirmBox('Выйти из аккаунта?', 'Локальные данные на этом устройстве будут удалены, ' +
            'включая коды шифрования чатов.', 'Выйти', function () {
            stopTimers();
            disablePush();                 // чужие уведомления на это устройство не приходят
            state.identity = null;
            state.vault = null;
            state.keys = {};
            try {
                Object.keys(localStorage).forEach(function (k) {
                    if (k.indexOf('WM_') === 0 && k !== LS.theme && k !== LS.api) localStorage.removeItem(k);
                });
            } catch (e) { /* no-op */ }
            Promise.all([idbDelete('identity'), idbDelete('prefs')])
                .then(function () { location.reload(); });
        });
    }

    function deleteAccount() {
        confirmBox('Удалить аккаунт?', 'Профиль и все ваши сообщения будут удалены навсегда. Никнейм освободится.',
            'Удалить', function () {
                var id = state.me && state.me.id;
                if (!id) return;
                request('/messages?user_id=eq.' + q(id), { method: 'DELETE' })
                    .catch(function () { /* сообщений может не быть */ })
                    .then(function () { return request('/profiles?id=eq.' + q(id), { method: 'DELETE' }); })
                    .then(function () {
                        localStorage.clear();
                        disablePush();
                        return Promise.all([idbDelete('identity'), idbDelete('prefs')]);
                    })
                    .then(function () { location.reload(); })
                    .catch(function (e) { toast(e.message || 'Не удалось удалить аккаунт'); });
            });
    }

    /* ------------------------------------------------------- профиль и темы */

    function updateProfileUI() {
        if (!state.me) return;
        $('s-name').textContent = state.me.name;
        $('s-nick').textContent = '@' + state.me.nickname;
        $('s-av').src = state.me.avatar || avatarFor(state.me.name, state.me.id);
        var hour = new Date().getHours();
        var g = 'Добрый вечер';
        if (hour < 6) g = 'Доброй ночи';
        else if (hour < 12) g = 'Доброе утро';
        else if (hour < 18) g = 'Добрый день';
        $('main-greeting').textContent = g + ', ' + String(state.me.name).split(' ')[0];
    }

    function renderThemes() {
        var cur = localStorage.getItem(LS.theme) || 'dark';
        $('theme-scroll').innerHTML = THEMES.map(function (t) {
            return '<div class="theme-card' + (t.id === cur ? ' active' : '') + '" data-theme="' + t.id + '">' +
                '<div class="theme-preview" style="background:' + t.bg + '">' +
                '<i style="background:' + t.b + '"></i><i style="background:' + t.a + '"></i></div>' +
                '<span>' + esc(t.label) + '</span></div>';
        }).join('');
    }

    function applyMotion() {
        var off = localStorage.getItem(LS.motion) === 'off';
        document.body.classList.toggle('no-motion', off);
        var pill = $('motion-state');
        if (pill) pill.textContent = off ? 'выкл' : 'вкл';
    }

    function setTheme(id) {
        if (THEME_ALIASES[id]) id = THEME_ALIASES[id];
        if (!THEMES.some(function (t) { return t.id === id; })) id = 'dark';
        document.body.className = 'theme-' + id;
        localStorage.setItem(LS.theme, id);
        applyMotion();
        // Цвет системной строки берём у той же полосы, что нарисована сверху:
        // так строка телефона отделена от приложения и на Android, и на iPhone.
        var meta = document.querySelector('meta[name=theme-color]');
        var strip = getComputedStyle(document.body).getPropertyValue('--panel').trim();
        var theme = THEMES.filter(function (t) { return t.id === id; })[0];
        if (meta) meta.setAttribute('content', strip || (theme ? theme.bg : '#0e0e10'));
        renderThemes();
    }

    function changeName() {
        promptBox('Изменить имя', 'Как вас будут видеть собеседники', state.me.name, function (val) {
            var name = val.trim();
            if (!name) return;
            request('/profiles?id=eq.' + q(state.me.id), { method: 'PATCH', body: { name: name } })
                .then(function () {
                    state.me.name = name;
                    writeJSON(LS.user, state.me);
                    updateProfileUI();
                    toast('Имя обновлено');
                })
                .catch(function (e) { toast(e.message || 'Не удалось сохранить'); });
        });
    }

    /* Смена пароля перешифровывает закрытый ключ: иначе на другом устройстве
       он больше не открылся бы, а вся прежняя переписка стала бы нечитаемой. */
    function rewrapPrivateKey(oldPass, newPass) {
        var vault = state.vault;
        if (!CR || !CR.available() || !vault || !vault.wrapped || !vault.salt) {
            return Promise.resolve(null);
        }
        var salt = CR.randomSalt();
        var priv;
        return CR.passwordKey(oldPass, vault.salt)
            .then(function (k) { return CR.unwrapPrivate(vault.wrapped, k, true); })
            .then(function (key) { priv = key; return CR.passwordKey(newPass, salt); })
            .then(function (nk) { return CR.wrapPrivate(priv, nk); })
            .then(function (wrapped) { return { enc_private_key: wrapped, key_salt: salt }; })
            .catch(function () { return null; });
    }

    function changePass() {
        promptBox('Смена пароля', 'Введите текущий пароль', '', function (oldPass) {
            if (!oldPass) return;
            promptBox('Смена пароля', 'Новый пароль, минимум 8 символов', '', function (val) {
                var pass = val.trim();
                if (pass.length < 8) { toast('Пароль должен быть от 8 символов'); return; }

                rewrapPrivateKey(oldPass, pass).then(function (bundle) {
                    return rpc('wm_set_password', {
                        p_nickname: state.me.nickname,
                        p_old_password: oldPass,
                        p_new_password: pass,
                        p_enc_private_key: bundle ? bundle.enc_private_key : null,
                        p_key_salt: bundle ? bundle.key_salt : null
                    }).catch(function (err) {
                        if (!missingRelation(err)) throw err;
                        return rpc('wm_set_password', {
                            p_nickname: state.me.nickname,
                            p_old_password: oldPass,
                            p_new_password: pass
                        });
                    }).then(function (res) {
                        if (!res || !res.ok) {
                            throw WMError(res && res.error === 'weak_password'
                                ? 'Слишком короткий пароль' : 'Текущий пароль неверен');
                        }
                        // Ключ на сервере перешифрован — запоминаем и у себя.
                        if (bundle && state.identity) {
                            saveIdentity(state.identity, {
                                wrapped: bundle.enc_private_key, salt: bundle.key_salt
                            });
                        }
                        return true;
                    }).catch(function (err) {
                        if (!missingRelation(err)) throw err;
                        return request('/profiles?nickname=eq.' + q(state.me.nickname) +
                            '&password=eq.' + q(oldPass) + '&select=id&limit=1')
                            .then(function (rows) {
                                if (!rows || !rows.length) throw WMError('Текущий пароль неверен');
                                return request('/profiles?id=eq.' + q(state.me.id),
                                    { method: 'PATCH', body: { password: pass } });
                            });
                    });
                }).then(function () { toast('Пароль изменён'); })
                    .catch(function (e) { toast(e.message || 'Не удалось изменить пароль'); });
            });
        });
    }

    /* ----------------------------------------------------------- изображения */

    function shrinkImage(file, maxSide, quality) {
        maxSide = maxSide || CFG.imageMaxSide;
        quality = quality || CFG.imageQuality;
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onerror = function () { reject(WMError('Не удалось прочитать файл')); };
            reader.onload = function (e) {
                var img = new Image();
                img.onerror = function () { reject(WMError('Не удалось открыть изображение')); };
                img.onload = function () {
                    var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
                    var w = Math.max(1, Math.round(img.width * scale));
                    var h = Math.max(1, Math.round(img.height * scale));
                    var canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    try {
                        resolve(canvas.toDataURL('image/jpeg', quality));
                    } catch (err) { reject(WMError('Не удалось обработать изображение')); }
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        });
    }

    function handleAvatarFile(input) {
        var file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        shrinkImage(file).then(function (data) {
            return request('/profiles?id=eq.' + q(state.me.id), { method: 'PATCH', body: { avatar: data } })
                .then(function () {
                    state.me.avatar = data;
                    writeJSON(LS.user, state.me);
                    updateProfileUI();
                    toast('Аватар обновлён');
                });
        }).catch(function (e) { toast(e.message || 'Не удалось обновить аватар'); });
    }

    /* Выбранные файлы отправляются по очереди: несколько снимков сразу —
       это просто несколько сообщений подряд, зато порядок не путается и
       память не забивается разом всеми картинками. */
    function handlePhotoFile(input) {
        var files = Array.prototype.slice.call((input && input.files) || []);
        if (input) input.value = '';
        if (!files.length || !state.activeRoom) return;

        var room = state.activeRoom;
        if (files.length > 1) toast('Отправляем ' + files.length + '…');

        return files.reduce(function (chain, file) {
            return chain.then(function () {
                if (state.activeRoom !== room) return null;
                return /^video\//.test(file.type) ? sendVideoFile(room, file)
                    : sendPhotoFile(room, file);
            });
        }, Promise.resolve());
    }

    function sendPhotoFile(room, file) {
        return Promise.all([
            shrinkImage(file, CFG.imageMaxSide, CFG.imageQuality),
            shrinkImage(file, 56, 0.45)          // крошечное превью для мгновенного показа
        ]).then(function (parts) {
            return sendPhoto(room, parts[0], parts[1]);
        }).catch(function (e) { toast(e.message || 'Не удалось отправить фото'); });
    }

    /* --------------------------------------------------------------- видео

       Ролик хранится вложением целиком, поэтому есть предел по размеру: в
       базе строка не резиновая, да и по мобильной сети большой файл идёт
       долго. В сообщении остаётся ссылка на вложение, длительность и кадр
       для превью — его видно сразу, до загрузки самого ролика. */

    var VIDEO_MAX_BYTES = 16 * 1024 * 1024;

    function videoPoster(file) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(file);
            var video = document.createElement('video');
            video.preload = 'metadata';
            video.muted = true;
            video.playsInline = true;

            var done = function (poster, seconds) {
                URL.revokeObjectURL(url);
                resolve({ poster: poster, seconds: seconds });
            };

            video.onloadeddata = function () {
                var seconds = isFinite(video.duration) ? Math.round(video.duration) : 0;
                try {
                    var scale = Math.min(1, 320 / Math.max(video.videoWidth || 320, 1));
                    var canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, Math.round((video.videoWidth || 320) * scale));
                    canvas.height = Math.max(1, Math.round((video.videoHeight || 240) * scale));
                    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
                    done(canvas.toDataURL('image/jpeg', 0.5), seconds);
                } catch (e) {
                    done('', seconds);           // кадр не сняли — обойдёмся без превью
                }
            };
            video.onerror = function () {
                URL.revokeObjectURL(url);
                reject(WMError('Не удалось прочитать видео'));
            };
            video.src = url;
        });
    }

    function readAsDataUrl(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function () { resolve(String(reader.result)); };
            reader.onerror = function () { reject(WMError('Не удалось прочитать файл')); };
            reader.readAsDataURL(file);
        });
    }

    /* Телефон снимает ролики по 20 Мбит/с — целиком такое не отправишь.
       Поэтому видео пережимается прямо в браузере: кадры перерисовываются в
       уменьшенный холст, звук берётся из самого файла, и всё это заново
       записывается с разумным битрейтом. Идёт это в реальном времени, поэтому
       минутный ролик готовится примерно минуту — с показом процентов. */

    var VIDEO_MAX_SIDE = 640;
    var VIDEO_BITRATE = 900000;
    var VIDEO_MAX_SECONDS = 180;

    function compressVideo(file, onProgress) {
        return new Promise(function (resolve, reject) {
            if (typeof MediaRecorder === 'undefined') { reject(WMError('no_recorder')); return; }

            var url = URL.createObjectURL(file);
            var video = document.createElement('video');
            video.src = url;
            video.muted = true;
            video.playsInline = true;
            video.preload = 'auto';

            var cleanup = function () { URL.revokeObjectURL(url); };
            var failed = function (err) { cleanup(); reject(err || WMError('video')); };

            video.onerror = function () { failed(WMError('Не удалось прочитать видео')); };

            video.onloadedmetadata = function () {
                var duration = isFinite(video.duration) ? video.duration : 0;
                if (duration > VIDEO_MAX_SECONDS) {
                    failed(WMError('Ролик длиннее ' + Math.round(VIDEO_MAX_SECONDS / 60) +
                        ' минут — снимите покороче'));
                    return;
                }

                var wide = Math.max(video.videoWidth || 640, video.videoHeight || 480);
                var scale = Math.min(1, VIDEO_MAX_SIDE / wide);
                var canvas = document.createElement('canvas');
                canvas.width = Math.max(2, Math.round((video.videoWidth || 640) * scale / 2) * 2);
                canvas.height = Math.max(2, Math.round((video.videoHeight || 480) * scale / 2) * 2);
                var g = canvas.getContext('2d');

                var stream = canvas.captureStream(24);
                try {
                    // Звук берём из самого файла: элемент приглушён только для
                    // колонок, дорожка при этом никуда не девается.
                    var withAudio = video.captureStream ? video.captureStream()
                        : (video.mozCaptureStream ? video.mozCaptureStream() : null);
                    if (withAudio) {
                        withAudio.getAudioTracks().forEach(function (t) { stream.addTrack(t); });
                    }
                } catch (e) { /* без звука тоже сойдёт */ }

                var types = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
                var mime = '';
                for (var i = 0; i < types.length && !mime; i++) {
                    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(types[i])) {
                        mime = types[i];
                    }
                }

                var chunks = [];
                var recorder;
                try {
                    recorder = new MediaRecorder(stream, {
                        mimeType: mime || undefined,
                        videoBitsPerSecond: VIDEO_BITRATE,
                        audioBitsPerSecond: 64000
                    });
                } catch (e) { failed(WMError('no_recorder')); return; }

                recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
                recorder.onstop = function () {
                    cleanup();
                    var blob = new Blob(chunks, { type: mime || 'video/webm' });
                    if (!blob.size) { reject(WMError('video_empty')); return; }
                    resolve({ blob: blob, seconds: Math.round(duration) });
                };

                var first = null;
                var draw = function () {
                    if (video.ended || video.paused) return;
                    g.drawImage(video, 0, 0, canvas.width, canvas.height);
                    if (!first) first = canvas.toDataURL('image/jpeg', 0.5);
                    if (duration && onProgress) onProgress(video.currentTime / duration, first);
                    requestAnimationFrame(draw);
                };

                video.onended = function () {
                    if (recorder.state === 'recording') recorder.stop();
                };

                video.play().then(function () {
                    recorder.start();
                    requestAnimationFrame(draw);
                }).catch(function () { failed(WMError('Не удалось открыть видео')); });
            };
        });
    }

    function sendVideoFile(room, file) {
        if (!state.hasAttachments) {
            toast('Видео требует обновления базы');
            return Promise.resolve();
        }

        var info = { poster: '', seconds: 0 };
        var shown = -1;

        toast('Готовим видео…');

        return compressVideo(file, function (done, poster) {
            if (poster && !info.poster) info.poster = poster;
            var percent = Math.round(done * 100);
            if (percent >= shown + 20) { shown = percent; toast('Готовим видео… ' + percent + '%'); }
        }).then(function (res) {
            info.seconds = res.seconds;
            return res.blob;
        }).catch(function (err) {
            // Пережать не вышло — отправим как есть, если размер позволяет.
            if (err && err.message && err.message.indexOf('Ролик длиннее') === 0) throw err;
            if (file.size <= VIDEO_MAX_BYTES) {
                return videoPoster(file).then(function (res) {
                    info = res || info;
                    return file;
                });
            }
            throw WMError('Видео слишком большое, а пережать его не получилось');
        }).then(function (blob) {
            if (blob.size > VIDEO_MAX_BYTES) {
                throw WMError('Даже после сжатия ролик больше ' +
                    Math.round(VIDEO_MAX_BYTES / 1048576) + ' МБ — снимите покороче');
            }
            if (!info.poster) {
                return videoPoster(file).then(function (res) {
                    if (res && res.poster) info.poster = res.poster;
                    return blob;
                }).catch(function () { return blob; });
            }
            return blob;
        }).then(function (blob) {
            return readAsDataUrl(blob);
        }).then(function (dataUrl) {
            return roomKey(room).then(function (key) {
                if (!key) return { data: dataUrl, thumb: info.poster };
                return Promise.all([
                    CR.encrypt(key, dataUrl),
                    info.poster ? CR.encrypt(key, info.poster) : Promise.resolve(null)
                ]).then(function (p) { return { data: p[0], thumb: p[1] }; });
            }).then(function (payload) {
                return request('/attachments', {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: { room_id: room, user_id: state.me.id, data: payload.data }
                }).then(function (rows) {
                    var id = rows && rows[0] && rows[0].id;
                    if (!id) throw WMError('Вложение не сохранено');
                    state.photos[String(id)] = dataUrl;      // своё видео открывается сразу
                    sendMessage('wmvid:' + id + ':' + (info.seconds || 0),
                        { thumb: payload.thumb, thumbBody: info.poster });
                });
            });
        }).catch(function (err) {
            if (missingRelation(err)) {
                state.hasAttachments = false;
                toast('Видео требует обновления базы');
                return;
            }
            toast(err.message || 'Не удалось отправить видео');
        });
    }

    /* Полный снимок уходит в отдельную таблицу, в сообщении остаётся ссылка на
       него и маленькое превью — поэтому чат открывается мгновенно. */
    function sendPhoto(room, full, thumb) {
        if (!state.hasAttachments) return sendMessage(full);

        return roomKey(room).then(function (key) {
            if (!key) return { data: full, thumb: thumb };
            return Promise.all([CR.encrypt(key, full), CR.encrypt(key, thumb)])
                .then(function (p) { return { data: p[0], thumb: p[1] }; });
        }).then(function (payload) {
            return request('/attachments', {
                method: 'POST',
                headers: { Prefer: 'return=representation' },
                body: { room_id: room, user_id: state.me.id, data: payload.data }
            }).then(function (rows) {
                var id = rows && rows[0] && rows[0].id;
                if (!id) throw WMError('Вложение не сохранено');
                state.photos[String(id)] = full;          // своё фото показываем сразу
                sendMessage('wmimg:' + id, { thumb: payload.thumb, thumbBody: thumb });
            });
        }).catch(function (err) {
            if (missingRelation(err)) {                   // база прошлой версии
                state.hasAttachments = false;
                return sendMessage(full);
            }
            toast(err.message || 'Не удалось отправить фото');
        });
    }

    /* Достаёт вложение (снимок или голос) и расшифровывает его ключом чата. */
    function fetchAttachment(id) {
        if (state.photos[id]) return Promise.resolve(state.photos[id]);
        if (state.photoTasks[id]) return state.photoTasks[id];

        var room = state.activeRoom;
        state.photoTasks[id] = request('/attachments?id=eq.' + q(id) + '&select=data&limit=1')
            .then(function (rows) {
                if (!rows || !rows.length) throw WMError('Вложение не найдено');
                return roomKey(room).then(function (key) {
                    var data = rows[0].data;
                    if (!key || !CR.isEncrypted(data)) return data;
                    return CR.decrypt(key, data);
                });
            })
            .then(function (data) {
                state.photos[id] = data;
                delete state.photoTasks[id];
                return data;
            })
            .catch(function (err) {
                delete state.photoTasks[id];
                throw err;
            });

        return state.photoTasks[id];
    }

    /* Подгружает полный снимок и подменяет превью прямо в узле. */
    function loadAttachment(id, node) {
        return fetchAttachment(id)
            .then(function (data) { applyPhoto(node, data); })
            .catch(function () { if (node) node.classList.remove('loading'); });
    }

    function applyPhoto(node, data) {
        if (!node) return;
        node.onload = function () {
            node.classList.remove('loading');
            // картинка изменила высоту — если стоим внизу, остаёмся внизу
            var box = $('msg-list');
            if (box && (state.pinBottom || isAtBottom())) box.scrollTop = box.scrollHeight;
        };
        node.src = data;
        node.setAttribute('data-loaded', '1');
    }

    /* ==================================================================
       ГОЛОСОВЫЕ СООБЩЕНИЯ

       Запись идёт в браузере, готовый звук шифруется ключом чата и уходит
       отдельным вложением — как фотография. В самом сообщении остаётся
       только ссылка на вложение и длительность, поэтому список сообщений
       остаётся лёгким, а полоса воспроизведения рисуется сразу.
       ================================================================== */

    var VOICE_MAX_MS = 180000;      // три минуты
    var VOICE_MIN_MS = 700;         // случайное касание записью не считаем
    var rec = null;                 // текущая запись
    var player = null;              // <audio> для воспроизведения

    function voiceSupported() {
        return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia &&
            typeof MediaRecorder !== 'undefined');
    }

    function recMime() {
        var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
        for (var i = 0; i < types.length; i++) {
            if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(types[i])) return types[i];
        }
        return '';
    }

    function showRecBar(on, locked) {
        $('rec-bar').hidden = !on;
        $('rec-stop').hidden = !locked;
        $('rec-hint').textContent = locked
            ? 'Идёт запись' : 'Отпустите — отправится, влево — отмена';
        if (!on) $('rec-time').textContent = '0:00';
    }

    function startRecording() {
        if (rec || !voiceSupported() || !state.activeRoom) return Promise.resolve();
        if (!canPost(state.activeChat)) return Promise.resolve();

        rec = { room: state.activeRoom, started: Date.now(), chunks: [], cancelled: false, locked: false };
        showRecBar(true, false);

        rec.timer = setInterval(function () {
            if (!rec) return;
            var sec = (Date.now() - rec.started) / 1000;
            $('rec-time').textContent = fmtDuration(sec);
            if (sec * 1000 >= VOICE_MAX_MS) stopRecording(false);
        }, 200);

        return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
            if (!rec) {                                   // успели отпустить раньше разрешения
                stream.getTracks().forEach(function (t) { t.stop(); });
                return;
            }
            rec.stream = stream;
            var mime = recMime();
            rec.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
            rec.recorder.ondataavailable = function (e) {
                if (e.data && e.data.size) rec.chunks.push(e.data);
            };
            rec.recorder.onstop = finishRecording;
            rec.recorder.start();
        }).catch(function () {
            cleanupRecording();
            toast('Нужен доступ к микрофону');
        });
    }

    function cleanupRecording() {
        if (rec) {
            clearInterval(rec.timer);
            if (rec.stream) rec.stream.getTracks().forEach(function (t) { t.stop(); });
        }
        rec = null;
        showRecBar(false, false);
    }

    function stopRecording(cancelled) {
        if (!rec) return;
        rec.cancelled = !!cancelled;
        rec.length = Date.now() - rec.started;
        if (rec.recorder && rec.recorder.state === 'recording') {
            rec.recorder.stop();                          // дальше сработает finishRecording
        } else {
            cleanupRecording();
        }
    }

    function finishRecording() {
        var current = rec;
        if (!current) return;
        var chunks = current.chunks;
        var room = current.room;
        var cancelled = current.cancelled;
        var length = current.length || (Date.now() - current.started);
        var mime = (current.recorder && current.recorder.mimeType) || 'audio/webm';
        cleanupRecording();

        if (cancelled || !chunks.length) return;
        if (length < VOICE_MIN_MS) { toast('Слишком короткое сообщение'); return; }

        var blob = new Blob(chunks, { type: mime });
        var reader = new FileReader();
        reader.onload = function () {
            sendVoice(room, String(reader.result), Math.round(length / 1000));
        };
        reader.onerror = function () { toast('Не удалось записать голос'); };
        reader.readAsDataURL(blob);
    }

    function sendVoice(room, dataUrl, seconds) {
        if (!state.hasAttachments) { toast('Голосовые сообщения требуют обновления базы'); return; }

        return roomKey(room).then(function (key) {
            return key ? CR.encrypt(key, dataUrl) : dataUrl;
        }).then(function (payload) {
            return request('/attachments', {
                method: 'POST',
                headers: { Prefer: 'return=representation' },
                body: { room_id: room, user_id: state.me.id, data: payload }
            });
        }).then(function (rows) {
            var id = rows && rows[0] && rows[0].id;
            if (!id) throw WMError('Вложение не сохранено');
            state.photos[String(id)] = dataUrl;            // своё сообщение слушаем сразу
            sendMessage('wmvoice:' + id + ':' + seconds);
        }).catch(function (err) {
            if (missingRelation(err)) {
                state.hasAttachments = false;
                toast('Голосовые сообщения требуют обновления базы');
                return;
            }
            toast(err.message || 'Не удалось отправить голосовое');
        });
    }

    /* Видео открывается на весь экран поверх переписки. */
    function openVideo(node) {
        var id = node.getAttribute('data-video');
        node.classList.add('loading');

        fetchAttachment(id).then(function (data) {
            node.classList.remove('loading');
            var box = $('lightbox');
            $('lightbox-img').hidden = true;
            var player = $('lightbox-video');
            player.hidden = false;
            player.src = data;
            box.classList.add('show');
            player.play().catch(function () { /* автозапуск запретили — есть кнопка */ });
        }).catch(function () {
            node.classList.remove('loading');
            toast('Не удалось открыть видео');
        });
    }

    function closeLightbox() {
        var player = $('lightbox-video');
        if (player) { player.pause(); player.removeAttribute('src'); player.load(); player.hidden = true; }
        $('lightbox-img').hidden = false;
        $('lightbox').classList.remove('show');
    }

    /* ----------------------------------------------------- воспроизведение */

    function stopVoice() {
        if (player) { player.pause(); player.currentTime = 0; }
        var active = document.querySelectorAll('.voice.playing');
        Array.prototype.forEach.call(active, function (node) {
            node.classList.remove('playing');
            var fill = node.querySelector('.voice-fill');
            if (fill) fill.style.width = '0%';
        });
    }

    function playVoice(node) {
        var id = node.getAttribute('data-voice');
        var seconds = Number(node.getAttribute('data-dur')) || 1;

        if (node.classList.contains('playing')) { stopVoice(); return; }
        stopVoice();

        node.classList.add('loading');
        fetchAttachment(id).then(function (data) {
            node.classList.remove('loading');
            if (!player) player = new Audio();
            player.src = data;
            player.currentTime = 0;

            var fill = node.querySelector('.voice-fill');
            var time = node.querySelector('.voice-time');
            player.ontimeupdate = function () {
                var total = player.duration && isFinite(player.duration) ? player.duration : seconds;
                var done = Math.min(1, player.currentTime / total);
                if (fill) fill.style.width = (done * 100).toFixed(1) + '%';
                if (time) time.textContent = fmtDuration(player.currentTime);
            };
            player.onended = function () {
                node.classList.remove('playing');
                if (fill) fill.style.width = '0%';
                if (time) time.textContent = fmtDuration(seconds);
            };

            node.classList.add('playing');
            return player.play();
        }).catch(function () {
            node.classList.remove('loading', 'playing');
            toast('Не удалось воспроизвести');
        });
    }

    /* ==================================================================
       ГИФКИ

       Поиск идёт через свой сервер: ключ сервиса остаётся на нём, а чужому
       сервису не видно, кто и что ищет. Выбранная гифка скачивается тем же
       сервером, шифруется ключом чата и уходит обычным вложением — то есть
       живёт в переписке так же, как фотография, и никуда не «утекает».
       ================================================================== */

    function findGifServer() {
        return findService('gif', function (info, url) {
            return info.ok ? { url: url, results: info.results || [] } : null;
        });
    }

    function gifProxy(server, fileUrl) {
        return server.url + '?file=' + encodeURIComponent(fileUrl);
    }

    function setupGifs() {
        findGifServer().then(function (server) {
            $('btn-gif').hidden = !server;
        });
    }

    function openGifs() {
        var panel = $('gif-panel');
        if (!panel.hidden) { closeGifs(); return; }

        panel.hidden = false;
        panel.classList.add('open');
        $('gif-search').value = '';
        searchGifs('');
    }

    function closeGifs() {
        var panel = $('gif-panel');
        panel.classList.remove('open');
        panel.hidden = true;
        stopGifPreviews();
    }

    function stopGifPreviews() {
        $('gif-grid').innerHTML = '';
    }

    function renderGifNote(text) {
        var note = $('gif-note');
        note.hidden = !text;
        note.textContent = text || '';
    }

    function searchGifs(query) {
        clearTimeout(state.gifTimer);
        state.gifTimer = setTimeout(function () {
            findGifServer().then(function (server) {
                if (!server) { renderGifNote('Поиск гифок не настроен'); return; }
                renderGifNote('');

                var url = server.url + (query ? '?q=' + encodeURIComponent(query) : '');
                return fetchTimeout(url, { method: 'GET' }, 12000)
                    .then(function (res) { return res.json(); })
                    .then(function (data) {
                        var list = (data && data.results) || [];
                        if (!list.length) { renderGifNote('Ничего не нашлось'); }
                        $('gif-grid').innerHTML = list.map(function (g) {
                            return '<button type="button" class="gif-item" ' +
                                'data-gif-url="' + esc(g.url) + '" ' +
                                'data-w="' + esc(g.width) + '" data-h="' + esc(g.height) + '">' +
                                '<img loading="lazy" alt="' + esc(g.title) + '" ' +
                                'src="' + esc(gifProxy(server, g.preview)) + '"></button>';
                        }).join('');
                    });
            }).catch(function () { renderGifNote('Поиск гифок сейчас недоступен'); });
        }, query ? 320 : 0);
    }

    function sendGif(fileUrl, width, height) {
        var room = state.activeRoom;
        if (!room || !state.hasAttachments) { toast('Гифки требуют обновления базы'); return; }

        closeGifs();
        toast('Отправляем гифку…');

        findGifServer().then(function (server) {
            if (!server) throw WMError('Гифки не настроены');
            return fetchTimeout(gifProxy(server, fileUrl), { method: 'GET' }, 20000);
        }).then(function (res) {
            if (!res.ok) throw WMError('Не удалось скачать гифку');
            return res.blob();
        }).then(function (blob) {
            if (blob.size > 8 * 1024 * 1024) throw WMError('Гифка слишком большая');
            return readAsDataUrl(blob);
        }).then(function (dataUrl) {
            return roomKey(room).then(function (key) {
                return key ? CR.encrypt(key, dataUrl) : dataUrl;
            }).then(function (payload) {
                return request('/attachments', {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: { room_id: room, user_id: state.me.id, data: payload }
                }).then(function (rows) {
                    var id = rows && rows[0] && rows[0].id;
                    if (!id) throw WMError('Вложение не сохранено');
                    state.photos[String(id)] = dataUrl;
                    sendMessage('wmgif:' + id + ':' + (width || 200) + ':' + (height || 200));
                });
            });
        }).catch(function (err) {
            if (missingRelation(err)) { state.hasAttachments = false; }
            toast(err.message || 'Не удалось отправить гифку');
        });
    }

    /* Гифки в переписке подгружаются по мере появления на экране — иначе
       десяток движущихся картинок сразу съел бы и трафик, и плавность. */
    function hydrateGifs() {
        var box = $('msg-list');
        if (!box) return;
        var nodes = box.querySelectorAll('.gif[data-gif]:not([data-loaded])');
        var top = box.scrollTop - 400;
        var bottom = box.scrollTop + box.clientHeight + 400;
        var started = 0;

        Array.prototype.forEach.call(nodes, function (node) {
            if (started >= 3) return;
            if (node.offsetTop < top || node.offsetTop > bottom) return;
            started++;
            node.setAttribute('data-loaded', '1');
            fetchAttachment(node.getAttribute('data-gif')).then(function (data) {
                node.src = data;
                node.play().catch(function () { /* автозапуск запретили */ });
            }).catch(function () { node.removeAttribute('data-loaded'); });
        });
    }

    /* ------------------------------------------------- кнопка микрофона

       Пока в поле ничего не набрано, вместо «отправить» стоит микрофон.
       Короткое нажатие включает запись и оставляет её включённой, удержание
       записывает, пока держат палец, движение влево — отмена. */

    function updateComposer() {
        var typing = !!$('m-input').value.trim();
        var canVoice = voiceSupported() && canPost(state.activeChat);
        $('btn-send').hidden = canVoice && !typing;
        $('btn-mic').hidden = !canVoice || typing;
    }

    function bindVoiceButton() {
        var mic = $('btn-mic');
        var hold = null;

        mic.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            if (rec) return;
            hold = { at: Date.now(), x: e.clientX, cancelled: false };
            startRecording();
        });

        mic.addEventListener('pointermove', function (e) {
            if (!hold || !rec || rec.locked) return;
            if (e.clientX - hold.x < -70) {              // увели палец влево — отмена
                hold.cancelled = true;
                vibrate();
                stopRecording(true);
                toast('Запись отменена');
                hold = null;
            }
        });

        var release = function () {
            if (!hold) return;
            var quick = Date.now() - hold.at < 400;
            var wasHold = hold;
            hold = null;
            if (!rec || wasHold.cancelled) return;
            if (quick) {                                 // короткое нажатие — запись остаётся
                rec.locked = true;
                showRecBar(true, true);
                return;
            }
            stopRecording(false);
        };

        mic.addEventListener('pointerup', release);
        mic.addEventListener('pointercancel', function () {
            if (hold) { hold = null; stopRecording(true); }
        });
        mic.addEventListener('pointerleave', release);

        $('rec-cancel').addEventListener('click', function () {
            stopRecording(true);
            toast('Запись отменена');
        });
        $('rec-stop').addEventListener('click', function () { stopRecording(false); });
    }

    /* После отрисовки догружаем видимые фотографии, по три за раз. */
    function hydratePhotos() {
        var nodes = $('msg-list').querySelectorAll('img[data-att]:not([data-loaded])');
        var queue = Array.prototype.slice.call(nodes).reverse();   // сначала свежие
        var active = 0;

        function next() {
            while (active < 3 && queue.length) {
                var node = queue.shift();
                active++;
                loadAttachment(node.getAttribute('data-att'), node).then(function () {
                    active--;
                    next();
                });
            }
        }
        next();
    }

    /* ------------------------------------------------------- локальные метки */

    function prefs() { return readJSON(LS.prefs, {}); }

    function prefFor(room) {
        return prefs()[room] || { pinned: false, muted: false };
    }

    function setPref(room, patch) {
        var all = prefs();
        all[room] = Object.assign({ pinned: false, muted: false }, all[room], patch);
        writeJSON(LS.prefs, all);
        mirrorPrefs(all);
    }

    /* Копия настроек в базе браузера: её читает service worker, когда решает,
       показывать ли уведомление о сообщении из отключённого чата. */
    function mirrorPrefs(all) {
        idbPut('prefs', all || prefs()).catch(function () { /* не критично */ });
    }

    function localReads() { return readJSON(LS.reads, {}); }

    function myLastRead(room) {
        var srv = state.reads[room] && state.reads[room][state.me.id];
        var loc = localReads()[room];
        if (srv && loc) return srv > loc ? srv : loc;
        return srv || loc || '1970-01-01T00:00:00Z';
    }

    function markRead(room, when) {
        var iso = when || new Date().toISOString();
        var all = localReads();
        all[room] = iso;
        writeJSON(LS.reads, all);
        if (!state.reads[room]) state.reads[room] = {};
        state.reads[room][state.me.id] = iso;
        request('/room_reads', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: { room_id: room, user_id: state.me.id, last_read_at: iso }
        }).catch(function () { /* таблицы может не быть */ });
    }

    /* ------------------------------------------------------------- чаты */

    /* ------------------------------------------------------------ избранное

       Личный раздел человека: комната, в которой он единственный участник.
       Ключ комнаты зашифрован только его собственным ключом, поэтому записи
       из «Избранного» не может прочитать никто, включая сервер. */

    function savedRoom() {
        return state.me ? 'fav_' + state.me.id : null;
    }

    function isSaved(chat) {
        return !!chat && chat.kind === 'saved';
    }

    /* Раздел создаётся один раз и дальше приходит вместе с остальными чатами. */
    function ensureSaved() {
        var room = savedRoom();
        if (!room || findChat(room)) return Promise.resolve();

        var chat = {
            room_id: room,
            name: 'Избранное',
            kind: 'saved',
            members: [state.me.id]
        };
        state.chats.push(chat);
        renderChatList();
        return upsertChat(chat).catch(function () { /* появится при следующем запуске */ });
    }

    function openSaved() {
        closePlus();
        var room = savedRoom();
        if (!room) return;
        ensureSaved().then(function () { openChat(room); });
    }

    /* ---------------------------------------------------------- WolffAI

       Помощник живёт в обычном чате, где участник только сам человек.
       Переписка так же зашифрована ключом чата, а ответ приходит через
       сервер: он держит ключ Gemini у себя и в браузер его не отдаёт. */

    var AI_ID = 'wolffai';
    var AI_NAME = 'WolffAI';

    function aiRoom() {
        return state.me ? 'ai_' + state.me.id : null;
    }

    function isAi(chat) {
        return !!chat && chat.kind === 'ai';
    }

    function ensureAi() {
        var room = aiRoom();
        if (!room || findChat(room)) return Promise.resolve();

        var chat = { room_id: room, name: AI_NAME, kind: 'ai', members: [state.me.id] };
        state.chats.push(chat);
        renderChatList();
        return upsertChat(chat).catch(function () { /* появится при следующем запуске */ });
    }

    function setAiTyping(on) {
        if (!isAi(state.activeChat)) return;
        $('chat-subtitle').textContent = on ? 'печатает…' : 'ваш помощник';
    }

    function aiHistory() {
        return state.msgs.slice(-20).filter(function (m) { return !m.pending; }).map(function (m) {
            var text = m.body === undefined ? m.text : m.body;
            return {
                role: m.user_id === AI_ID ? 'model' : 'user',
                text: typeof text === 'string' ? text : ''
            };
        }).filter(function (m) {
            return m.text && !isPhoto(m.text) && !isVoiceRef(m.text) && !isVideoRef(m.text) &&
                !(CR && CR.isEncrypted(m.text));
        });
    }

    var AI_BUSY_TEXT = 'Сейчас большой спрос на WolffAI — он временно не работает. ' +
        'Попробуйте, пожалуйста, чуть позже.';
    var AI_SETUP_TEXT = 'WolffAI ещё не подключён. Владельцу сайта нужно добавить ключ ' +
        'Gemini в настройках сервера — после этого я заработаю.';
    var AI_NOSERVER_TEXT = 'Не нахожу свой сервер: похоже, приложение открыто с адреса, ' +
        'где его нет. Откройте Настройки → Помощник WolffAI → Указать адрес и вставьте ' +
        'адрес сервера — после этого я отвечу.';

    function askAi(room) {
        if (state.aiBusy) return Promise.resolve();
        state.aiBusy = true;
        setAiTyping(true);

        var history = aiHistory();

        return findAiServer().then(function (server) {
            if (!server) return { ok: false, error: 'no_server' };
            return fetchTimeout(server.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: history })
            }, 35000).then(function (res) { return res.json(); });
        }).then(function (res) {
            if (res && res.ok && res.text) return postAiMessage(room, res.text);
            if (res && res.error === 'no_server') return postAiMessage(room, AI_NOSERVER_TEXT);
            if (res && res.error === 'not_configured') return postAiMessage(room, AI_SETUP_TEXT);
            return postAiMessage(room, AI_BUSY_TEXT);
        }).catch(function () {
            return postAiMessage(room, AI_BUSY_TEXT);
        }).then(function () {
            state.aiBusy = false;
            setAiTyping(false);
            if (state.activeRoom === room) pollChat(false);
        });
    }

    /* Ответ помощника сохраняется как обычное сообщение — и точно так же
       шифруется, поэтому на сервере он тоже нечитаем. */
    function postAiMessage(room, text) {
        return roomKey(room).then(function (key) {
            if (!key) return { text: text, preview: String(text).slice(0, 70) };
            return Promise.all([CR.encrypt(key, text), CR.encrypt(key, String(text).slice(0, 70))])
                .then(function (parts) { return { text: parts[0], preview: parts[1] }; });
        }).then(function (payload) {
            var body = {
                room_id: room,
                user_id: AI_ID,
                user_name: AI_NAME,
                text: payload.text,
                preview: payload.preview,
                reactions: {},
                created_at: new Date().toISOString()
            };
            return request('/messages', { method: 'POST', body: body }).catch(function (err) {
                if (err.status !== 400) throw err;
                delete body.preview;
                return request('/messages', { method: 'POST', body: body });
            });
        }).catch(function () { /* ответ не сохранился — не роняем чат */ });
    }

    function chatDisplayName(chat) {
        if (chat.kind === 'saved') return 'Избранное';
        if (chat.kind === 'ai') return AI_NAME;
        if (chat.kind === 'channel') return chat.name || ('@' + (chat.slug || 'канал'));
        if (chat.kind === 'group') return chat.name || 'Группа';
        var other = (chat.members || []).filter(function (m) { return m !== state.me.id; })[0];
        var p = other && state.profiles[other];
        if (p) return p.name || ('@' + p.nickname);
        return chat.name || 'Чат';
    }

    var SAVED_AVATAR = 'data:image/svg+xml;utf8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#f0b429"/><stop offset="1" stop-color="#e07b39"/>' +
        '</linearGradient></defs>' +
        '<rect width="96" height="96" rx="48" fill="url(#g)"/>' +
        '<path d="M34 26h28a4 4 0 0 1 4 4v42l-18-12-18 12V30a4 4 0 0 1 4-4z" fill="#fff"/></svg>');

    var AI_AVATAR = 'data:image/svg+xml;utf8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#7d8cf5"/><stop offset="1" stop-color="#b06ae0"/>' +
        '</linearGradient></defs>' +
        '<rect width="96" height="96" rx="48" fill="url(#g)"/>' +
        '<path d="M48 22l6.5 15.5L70 44l-15.5 6.5L48 66l-6.5-15.5L26 44l15.5-6.5z" fill="#fff"/>' +
        '<circle cx="70" cy="70" r="7" fill="#fff" opacity="0.9"/></svg>');

    function chatAvatar(chat) {
        if (chat.kind === 'saved') return SAVED_AVATAR;
        if (chat.kind === 'ai') return AI_AVATAR;
        if (chat.kind === 'dm') {
            var other = (chat.members || []).filter(function (m) { return m !== state.me.id; })[0];
            var p = other && state.profiles[other];
            if (p && p.avatar) return p.avatar;
        }
        return avatarFor(chatDisplayName(chat), chat.room_id);
    }

    function mergeChats(serverRows) {
        var local = readJSON(LS.chats, []);
        var byRoom = {};

        local.forEach(function (c) {
            if (!c || !c.room) return;
            byRoom[c.room] = {
                room_id: c.room,
                name: c.name || '',
                kind: c.kind || (String(c.room).indexOf('group_') === 0 ? 'group'
                    : (String(c.room).indexOf('fav_') === 0 ? 'saved'
                        : (String(c.room).indexOf('ai_') === 0 ? 'ai' : 'dm'))),
                members: c.members || [state.me.id],
                slug: c.slug || null,
                owner_id: c.owner_id || null,
                subscribers: c.subscribers || 0
            };
        });

        (serverRows || []).forEach(function (r) {
            byRoom[r.room_id] = {
                room_id: r.room_id,
                name: r.name || '',
                kind: r.kind || 'dm',
                members: r.members || [],
                slug: r.slug || null,
                about: r.about || '',
                owner_id: r.owner_id || null,
                subscribers: r.subscribers || (r.members || []).length
            };
        });

        return Object.keys(byRoom).map(function (k) { return byRoom[k]; });
    }

    function persistChats() {
        writeJSON(LS.chats, state.chats.filter(function (c) { return c.kind !== 'comments'; }).map(function (c) {
            return {
                room: c.room_id, name: c.name, kind: c.kind, members: c.members,
                slug: c.slug, owner_id: c.owner_id, subscribers: c.subscribers
            };
        }));
    }

    function loadProfiles(ids, force) {
        var need = (ids || []).filter(function (id) {
            return id && (force || !state.profiles[id]);
        });
        if (!need.length) return Promise.resolve();

        return fetchProfiles('id=in.(' + need.map(q).join(',') + ')')
            .then(function (rows) {
                (rows || []).forEach(function (p) { state.profiles[p.id] = p; });
            })
            .catch(function () { /* профили не критичны для отрисовки */ });
    }

    function syncChats() {
        if (!state.me) return Promise.resolve();

        var fetchChats = state.serverChats
            ? request('/chats?members=cs.' + q('{' + state.me.id + '}') +
                '&select=room_id,name,kind,members,slug,about,owner_id,subscribers')
                .catch(function (err) {
                    if (missingRelation(err)) { state.serverChats = false; return []; }
                    // старая таблица chats без колонок каналов
                    if (err.status === 400) {
                        return request('/chats?members=cs.' + q('{' + state.me.id + '}') +
                            '&select=room_id,name,kind,members').catch(function () { return []; });
                    }
                    throw err;
                })
            : Promise.resolve([]);

        return fetchChats.then(function (rows) {
            state.chats = mergeChats(rows);
            ensureSaved();
            ensureAi();
            persistChats();
            var ids = [];
            state.chats.forEach(function (c) {
                (c.members || []).forEach(function (m) { if (ids.indexOf(m) < 0) ids.push(m); });
            });
            return loadProfiles(ids);
        }).then(function () {
            return loadPreviews();
        }).then(function () {
            renderChatList();
            cacheChatList();
        }).catch(function (err) {
            renderChatList();
            if (!err.status) setNetState(false, 'Нет связи с сервером');
        });
    }

    function loadPreviews() {
        var rooms = state.chats.map(function (c) { return c.room_id; });
        if (!rooms.length) return Promise.resolve();

        var inList = 'in.(' + rooms.map(function (r) { return '"' + String(r).replace(/"/g, '') + '"'; }).join(',') + ')';
        var oldest = rooms.map(myLastRead).sort()[0];

        var previewReq = state.hasPreviews
            ? request('/chat_previews?room_id=' + q(inList) + '&select=room_id,id,user_id,user_name,preview,created_at')
                .catch(function (err) {
                    if (missingRelation(err)) { state.hasPreviews = false; return null; }
                    throw err;
                })
            : Promise.resolve(null);

        return previewReq.then(function (previews) {
            if (previews) {
                var map = {};
                previews.forEach(function (p) { map[p.room_id] = p; });
                state.chats.forEach(function (c) {
                    var p = map[c.room_id];
                    c.preview = p ? p.preview : '';
                    c.ts = p ? p.created_at : null;
                    c.lastId = p ? String(p.id) : null;
                });
            }
            return request('/messages?room_id=' + q(inList) +
                '&created_at=gt.' + q(oldest) +
                '&select=id,room_id,user_id,user_name,created_at&order=created_at.desc&limit=500');
        }).then(function (rows) {
            var counts = {};
            var last = {};
            (rows || []).forEach(function (m) {
                if (!last[m.room_id]) last[m.room_id] = m;
                if (m.user_id !== state.me.id && m.created_at > myLastRead(m.room_id)) {
                    counts[m.room_id] = (counts[m.room_id] || 0) + 1;
                }
            });
            state.chats.forEach(function (c) {
                c.unread = counts[c.room_id] || 0;
                if (!state.hasPreviews && last[c.room_id]) {
                    c.ts = last[c.room_id].created_at;
                    c.lastId = String(last[c.room_id].id);
                }
            });
            return decodePreviews().then(maybeNotify);
        }).catch(function (err) {
            if (err.status) throw err;
        });
    }

    /* Подписи в списке чатов тоже зашифрованы — расшифровываем ключом чата. */
    function decodePreviews() {
        if (!CR || !CR.available()) return Promise.resolve();
        var work = state.chats.filter(function (c) { return CR.isEncrypted(c.preview); });
        if (!work.length) return Promise.resolve();

        return Promise.all(work.map(function (c) {
            return roomKey(c.room_id).then(function (key) {
                if (!key) { c.preview = '🔒 Зашифрованное сообщение'; return; }
                return CR.decrypt(key, c.preview).then(function (plain) {
                    c.preview = plain;
                }).catch(function () {
                    c.preview = '🔒 Зашифрованное сообщение';
                });
            }).catch(function () { c.preview = '🔒 Зашифрованное сообщение'; });
        }));
    }

    function chatListModel() {
        var term = state.search.trim().toLowerCase();
        var list = state.chats.map(function (c) {
            var p = prefFor(c.room_id);
            return {
                room_id: c.room_id,
                kind: c.kind,
                title: chatDisplayName(c),
                avatar: chatAvatar(c),
                preview: c.preview || '',
                ts: c.ts || null,
                unread: c.unread || 0,
                pinned: !!p.pinned,
                muted: !!p.muted,
                saved: c.kind === 'saved',
                ai: c.kind === 'ai',
                encrypted: !!state.keys[c.room_id]
            };
        }).filter(function (c) {
            return !term || c.title.toLowerCase().indexOf(term) >= 0;
        });

        list.sort(function (a, b) {
            if (a.saved !== b.saved) return a.saved ? -1 : 1;   // «Избранное» всегда сверху
            if (a.ai !== b.ai) return a.ai ? -1 : 1;            // следом — помощник
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            return String(b.ts || '').localeCompare(String(a.ts || ''));
        });
        return list;
    }

    function chatRowHtml(c) {
        var preview = c.preview;
        if (!preview && c.kind === 'saved') preview = 'Заметки и файлы только для вас';
        else if (!preview && c.kind === 'ai') preview = 'Спросите о чём угодно';
        else if (!preview) preview = c.kind === 'channel' ? 'Канал' : 'Нажмите, чтобы открыть';
        else if (isImage(preview)) preview = '📷 Фото';
        else if (CR && CR.isEncrypted(preview)) preview = 'Сообщение';

        var icon = c.kind === 'channel' ? ' 📣'
            : (c.kind === 'group' ? ' 👥'
                : (c.kind === 'saved' ? ' 🔖' : (c.kind === 'ai' ? ' ✨' : '')));
        return '<div class="f-item' + (state.selectedRoom === c.room_id ? ' selected' : '') + '"' +
            ' data-room="' + esc(c.room_id) + '">' +
            '<img class="chat-av" alt="" src="' + esc(c.avatar) + '">' +
            '<div class="chat-info">' +
            '<b>' + (c.pinned ? '📌 ' : '') + esc(c.title) + icon + (c.encrypted ? ' 🔒' : '') + '</b>' +
            '<small>' + (c.muted ? '🔇 ' : '') + esc(preview) + '</small>' +
            '</div>' +
            '<div class="chat-side">' +
            '<span class="chat-time">' + esc(c.ts ? fmtListTime(c.ts) : '') + '</span>' +
            '<div class="badge">' + (c.unread ? esc(c.unread > 99 ? '99+' : c.unread) : '') + '</div>' +
            '</div></div>';
    }

    function renderChatList() {
        var box = $('chat-list');
        var list = chatListModel();
        var sig = JSON.stringify(list) + '|' + state.selectedRoom;
        if (sig === state.listSig) return;             // ничего не изменилось — DOM не трогаем
        state.listSig = sig;

        if (!list.length) {
            // В режиме поиска пустоту показывает общий блок «Ничего не найдено»,
            // чтобы под запросом не висели две подсказки подряд.
            box.innerHTML = state.search.trim() ? ''
                : '<div class="empty-state"><div class="ico">💬</div>' +
                '<b>Чатов пока нет</b><p>Нажмите «＋» вверху, чтобы написать человеку,' +
                '<br>создать группу или свой канал</p></div>';
            updateSearchViews();
            return;
        }

        box.innerHTML = list.map(chatRowHtml).join('');
        updateSearchViews();
    }

    function cacheChatList() {
        writeJSON(LS.cacheChats, chatListModel().slice(0, 40));
    }

    function paintCachedChatList() {
        var cached = readJSON(LS.cacheChats, []);
        if (!cached.length) return;
        $('chat-list').innerHTML = cached.map(chatRowHtml).join('');
        state.listSig = '';
    }

    /* ------------------------------------------------ глобальный поиск */

    /* Экран поиска: пока он открыт, список чатов превращается в результаты,
       а шапка уступает место строке ввода с кнопкой «Отмена». */

    function openSearch() {
        if (state.searchMode) return;
        state.searchMode = true;
        document.body.classList.add('searching');
        renderRecent();
        updateSearchViews();
    }

    function closeSearch() {
        state.searchMode = false;
        document.body.classList.remove('searching');
        $('chat-search').value = '';
        $('chat-search').blur();
        runSearch('');
    }

    function recentQueries() {
        var list = readJSON(LS.recent, []);
        return Array.isArray(list) ? list.filter(function (s) { return typeof s === 'string'; }) : [];
    }

    function rememberQuery(term) {
        term = String(term || '').trim();
        if (term.length < 2) return;
        var list = recentQueries().filter(function (s) { return s.toLowerCase() !== term.toLowerCase(); });
        list.unshift(term);
        writeJSON(LS.recent, list.slice(0, 8));
    }

    function renderRecent() {
        var box = $('search-recent');
        var list = recentQueries();
        if (!state.searchMode || state.search.trim() || !list.length) { box.hidden = true; return; }
        box.hidden = false;
        box.innerHTML = '<div class="section-title top">Недавние запросы' +
            '<button type="button" class="link-btn" id="recent-clear">Очистить</button></div>' +
            '<div class="chips">' + list.map(function (s) {
                return '<button type="button" class="chip" data-recent="' + esc(s) + '">🕘 ' + esc(s) + '</button>';
            }).join('') + '</div>';
    }

    /* Поиск по загруженной переписке: тексты уже расшифрованы на устройстве,
       поэтому искать можно, не отправляя запрос наружу. */
    function searchMessages(term) {
        var needle = term.toLowerCase();
        var out = [];
        state.chats.forEach(function (chat) {
            var cached = readJSON(LS.cacheMsgs + chat.room_id, []);
            if (!Array.isArray(cached)) return;
            for (var i = cached.length - 1; i >= 0 && out.length < 30; i--) {
                var m = cached[i];
                var text = m && typeof m.text === 'string' ? m.text : '';
                if (!text || isPhoto(text) || isVoiceRef(text) || isVideoRef(text) ||
                    isCallLog(text) || isGifRef(text) || (CR && CR.isEncrypted(text))) continue;
                if (text.toLowerCase().indexOf(needle) < 0) continue;
                out.push({
                    room_id: chat.room_id,
                    id: m.id,
                    title: chatDisplayName(chat),
                    avatar: chatAvatar(chat),
                    author: m.user_id === state.me.id ? 'Вы' : (m.user_name || ''),
                    text: text,
                    created_at: m.created_at
                });
            }
        });
        out.sort(function (a, b) { return String(b.created_at || '').localeCompare(String(a.created_at || '')); });
        return out.slice(0, 20);
    }

    function highlight(text, term) {
        var idx = text.toLowerCase().indexOf(term.toLowerCase());
        if (idx < 0) return esc(text.slice(0, 90));
        var from = Math.max(0, idx - 24);
        var cut = text.slice(from, from + 90);
        var pos = idx - from;
        return (from ? '…' : '') + esc(cut.slice(0, pos)) +
            '<mark>' + esc(cut.slice(pos, pos + term.length)) + '</mark>' +
            esc(cut.slice(pos + term.length));
    }

    function renderMsgResults() {
        var box = $('msg-results');
        var res = state.msgResults;
        var sig = JSON.stringify(res);
        if (sig === state.msgSig) return;
        state.msgSig = sig;

        if (!res || !res.length) { box.innerHTML = ''; return; }
        var term = state.search.trim();
        box.innerHTML = '<div class="section-title">Сообщения</div>' + res.map(function (m) {
            return '<div class="f-item" data-goto-room="' + esc(m.room_id) + '"' +
                ' data-goto-msg="' + esc(m.id) + '">' +
                '<img class="chat-av" alt="" src="' + esc(m.avatar) + '">' +
                '<div class="chat-info"><b>' + esc(m.title) + '</b>' +
                '<small>' + (m.author ? esc(m.author) + ': ' : '') + highlight(m.text, term) + '</small></div>' +
                '<span class="chat-time">' + esc(m.created_at ? fmtListTime(m.created_at) : '') + '</span>' +
                '</div>';
        }).join('');
    }

    /* Показываем только то, что относится к текущему состоянию экрана. */
    function updateSearchViews() {
        var term = state.search.trim();
        var searching = state.searchMode && !!term;

        $('chat-section').hidden = !searching || !$('chat-list').querySelector('.f-item');
        $('search-recent').hidden = !state.searchMode || !!term || !recentQueries().length;

        var empty = searching &&
            !$('chat-list').querySelector('.f-item') &&
            !$('global-results').querySelector('.f-item') &&
            !$('msg-results').querySelector('.f-item') &&
            state.globalResults !== null;
        $('search-empty').hidden = !empty;
    }

    function runSearch(value) {
        state.search = value;
        $('search-clear').hidden = !value;
        renderChatList();
        renderRecent();
        clearTimeout(state.searchTimer);

        var term = value.trim().replace(/^@+/, '');
        if (term.length < 2) {
            state.globalResults = null;
            state.msgResults = null;
            renderGlobal();
            renderMsgResults();
            updateSearchViews();
            return;
        }

        state.msgResults = searchMessages(term);
        renderMsgResults();
        updateSearchViews();
        state.searchTimer = setTimeout(function () {
            rememberQuery(term);
            globalSearch(term);
        }, 280);
    }

    function globalSearch(term) {
        var task = state.hasSearch
            ? rpc('wm_search', { p_query: term, p_me: state.me.id }).catch(function (err) {
                if (!missingRelation(err)) throw err;
                state.hasSearch = false;
                return legacySearch(term);
            })
            : legacySearch(term);

        task.then(function (res) {
            if (state.search.trim().replace(/^@+/, '') !== term) return;   // запрос устарел
            state.globalResults = {
                channels: (res && res.channels) || [],
                users: (res && res.users) || []
            };
            renderGlobal();
        }).catch(function () {
            state.globalResults = { channels: [], users: [] };
            renderGlobal();
        });
    }

    function legacySearch(term) {
        var like = '*' + term + '*';
        var channels = request('/chats?is_public=is.true&or=(' +
            'name.ilike.' + q(like) + ',slug.ilike.' + q(like) + ')' +
            '&select=room_id,name,slug,about,subscribers,owner_id,members&limit=20')
            .catch(function () { return []; });
        var users = request('/profiles?or=(nickname.ilike.' + q(like) + ',name.ilike.' + q(like) + ')' +
            '&select=id,nickname,name,avatar&limit=20')
            .catch(function () { return []; });

        return Promise.all([channels, users]).then(function (r) {
            return {
                channels: (r[0] || []).map(function (c) {
                    c.joined = (c.members || []).indexOf(state.me.id) >= 0;
                    return c;
                }),
                users: (r[1] || []).filter(function (u) { return u.id !== state.me.id; })
            };
        });
    }

    function renderGlobal() {
        var box = $('global-results');
        var res = state.globalResults;
        if (!res) {
            if (state.globalSig !== '') { box.innerHTML = ''; state.globalSig = ''; }
            updateSearchViews();
            return;
        }

        var sig = JSON.stringify(res);
        if (sig === state.globalSig) return;
        state.globalSig = sig;

        var html = '';

        if (res.channels.length) {
            html += '<div class="section-title">Каналы</div>';
            html += res.channels.map(function (c) {
                var subs = plural(c.subscribers || 0, 'подписчик', 'подписчика', 'подписчиков');
                return '<div class="f-item" data-channel="' + esc(c.room_id) + '">' +
                    '<img class="chat-av" alt="" src="' + esc(avatarFor(c.name, c.room_id)) + '">' +
                    '<div class="chat-info"><b>' + esc(c.name) + ' 📣</b>' +
                    '<small>@' + esc(c.slug || '') + ' · ' + esc(subs) + '</small></div>' +
                    '<span class="row-action">' + (c.joined ? 'Открыть' : 'Подписаться') + '</span>' +
                    '</div>';
            }).join('');
        }

        if (res.users.length) {
            html += '<div class="section-title">Люди</div>';
            html += res.users.map(function (u) {
                return '<div class="f-item" data-user="' + esc(u.nickname) + '">' +
                    '<img class="chat-av" alt="" src="' + esc(u.avatar || avatarFor(u.name, u.id)) + '">' +
                    '<div class="chat-info"><b>' + esc(u.name || u.nickname) + '</b>' +
                    '<small>@' + esc(u.nickname) + '</small></div>' +
                    '<span class="row-action">Написать</span></div>';
            }).join('');
        }

        box.innerHTML = html;
        updateSearchViews();
    }

    /* ------------------------------------------------- создание и подписки */

    function addUser(nickname) {
        closePlus();
        if (nickname) return startDialog(nickname);
        promptBox('Написать пользователю', 'Введите никнейм собеседника', '@', function (val) {
            startDialog(val);
        });
    }

    function startDialog(val) {
        var nick = String(val || '').trim().toLowerCase().replace(/^@+/, '');
        if (!nick) return Promise.resolve();
        if (nick === state.me.nickname) { toast('Это вы 🙂'); return Promise.resolve(); }

        return fetchProfiles('nickname=eq.' + q(nick) + '&limit=1')
            .then(function (rows) {
                if (!rows || !rows.length) { toast('Пользователь не найден'); return; }
                var other = rows[0];
                state.profiles[other.id] = other;
                var room = [state.me.id, other.id].sort().join('_');

                return upsertChat({
                    room_id: room,
                    name: '',
                    kind: 'dm',
                    members: [state.me.id, other.id].sort()
                }).then(function () { return syncChats(); })
                    .then(function () { openChat(room); });
            })
            .catch(function (e) { toast(e.message || 'Не удалось открыть чат'); });
    }

    function createGroup() {
        closePlus();
        promptBox('Новая группа', 'Название группы', '', function (val) {
            var name = val.trim();
            if (!name) return;
            var room = 'group_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
            upsertChat({ room_id: room, name: name, kind: 'group', members: [state.me.id] })
                .then(function () { return syncChats(); })
                .then(function () { openChat(room); })
                .catch(function (e) { toast(e.message || 'Не удалось создать группу'); });
        });
    }

    function openChannelModal() {
        closePlus();
        $('ch-title').value = '';
        $('ch-slug').value = '';
        $('ch-about').value = '';
        $('ch-status').textContent = '';
        $('channel-modal').classList.add('show');
    }

    function createChannel() {
        var title = $('ch-title').value.trim();
        var slug = $('ch-slug').value.trim().toLowerCase().replace(/^@+/, '');
        var about = $('ch-about').value.trim();

        if (title.length < 2) { $('ch-status').textContent = 'Название от 2 символов'; return; }
        if (!/^[a-z0-9_]{4,32}$/.test(slug)) {
            $('ch-status').textContent = 'Ссылка: 4–32 символа, латиница, цифры и _';
            return;
        }
        $('ch-status').textContent = 'Создаём…';

        rpc('wm_create_channel', { p_owner: state.me.id, p_title: title, p_slug: slug, p_about: about })
            .then(function (res) {
                if (res && res.ok) return res.chat;
                var map = {
                    slug_taken: 'Такая ссылка уже занята',
                    bad_slug: 'Ссылка: 4–32 символа, латиница, цифры и _',
                    bad_title: 'Название от 2 символов'
                };
                throw WMError((res && map[res.error]) || 'Не удалось создать канал');
            })
            .catch(function (err) {
                if (!missingRelation(err)) throw err;
                // Функции нет — создаём канал напрямую. Если в таблице ещё нет
                // колонок каналов, повторяем запрос с базовым набором полей.
                var room = 'channel_' + slug;
                var full = {
                    room_id: room, name: title, kind: 'channel', members: [state.me.id],
                    slug: slug, about: about, owner_id: state.me.id, is_public: true, subscribers: 1
                };
                var insert = function (body) {
                    return request('/chats', {
                        method: 'POST',
                        headers: { Prefer: 'return=representation' },
                        body: body
                    });
                };
                return insert(full)
                    .catch(function (columnErr) {
                        if (columnErr.status !== 400) throw columnErr;
                        toast('В базе нет колонок каналов — выполните db/schema.sql');
                        return insert({ room_id: room, name: title, kind: 'channel', members: [state.me.id] });
                    })
                    .then(function (rows) { return (rows && rows[0]) || { room_id: room }; });
            })
            .then(function (chat) {
                $('channel-modal').classList.remove('show');
                toast('Канал создан');
                return syncChats().then(function () { openChat(chat.room_id); });
            })
            .catch(function (err) {
                console.error('Создание канала:', err);
                $('ch-status').textContent = (err.message || 'Не удалось создать канал') +
                    (err.status ? ' (код ' + err.status + ')' : '');
            });
    }

    /* Канал из поиска открывается только для чтения. Подписка происходит
       исключительно по кнопке внизу — просто зайти и «случайно подписаться»
       больше нельзя. */
    function previewChannel(room) {
        if (findChat(room)) { openChat(room); return; }

        var found = null;
        var res = state.globalResults;
        if (res && res.channels) {
            found = res.channels.filter(function (c) { return c.room_id === room; })[0] || null;
        }

        state.virtual[room] = {
            room_id: room,
            kind: 'channel',
            name: found ? found.name : 'Канал',
            slug: found ? found.slug : null,
            about: found ? found.about : '',
            owner_id: found ? found.owner_id : null,
            subscribers: found ? found.subscribers : 0,
            members: [],                       // себя в участники не добавляем
            preview: true
        };
        openChat(room);
    }

    function joinChannel(room) {
        return rpc('wm_join_chat', { p_room: room, p_user: state.me.id })
            .then(function (res) {
                if (res && res.ok) return res.chat;
                throw WMError('Не удалось подписаться');
            })
            .catch(function (err) {
                if (!missingRelation(err)) throw err;
                return request('/chats?room_id=eq.' + q(room) + '&select=room_id,members')
                    .then(function (rows) {
                        var chat = rows && rows[0];
                        if (!chat) throw WMError('Канал не найден');
                        var members = (chat.members || []).concat([state.me.id]);
                        return request('/chats?room_id=eq.' + q(room),
                            { method: 'PATCH', body: { members: members, subscribers: members.length } });
                    });
            })
            .then(function () { return syncChats(); })
            .then(function () {
                delete state.virtual[room];        // теперь это обычный чат из списка
                $('chat-search').value = '';
                runSearch('');
                openChat(room);
                toast('Вы подписались');
            })
            .catch(function (e) { toast(e.message || 'Не удалось подписаться'); });
    }

    function leaveChat() {
        closeChatMenu();
        var room = state.activeRoom;
        if (!room) return;
        confirmBox('Отписаться?', 'Чат исчезнет из списка. Подписаться снова можно через поиск.',
            'Отписаться', function () {
                rpc('wm_leave_chat', { p_room: room, p_user: state.me.id })
                    .catch(function (err) {
                        if (!missingRelation(err)) throw err;
                        var chat = findChat(room);
                        var members = (chat.members || []).filter(function (m) { return m !== state.me.id; });
                        return request('/chats?room_id=eq.' + q(room),
                            { method: 'PATCH', body: { members: members, subscribers: members.length } });
                    })
                    .then(function () {
                        var local = readJSON(LS.chats, []).filter(function (c) { return c && c.room !== room; });
                        writeJSON(LS.chats, local);
                        closeChat();
                        return syncChats();
                    })
                    .then(function () { toast('Вы отписались'); })
                    .catch(function (e) { toast(e.message || 'Не удалось отписаться'); });
            });
    }

    function upsertChat(chat) {
        var local = readJSON(LS.chats, []).filter(function (c) { return c && c.room !== chat.room_id; });
        local.push({ room: chat.room_id, name: chat.name, kind: chat.kind, members: chat.members });
        writeJSON(LS.chats, local);

        if (!state.serverChats) return Promise.resolve();

        return request('/chats', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: chat
        }).catch(function (err) {
            if (missingRelation(err)) { state.serverChats = false; return null; }
            throw err;
        });
    }

    function inviteToChat() {
        closeChatMenu();
        var chat = state.activeChat;
        if (!chat) return;
        if (chat.kind !== 'group') { toast('Добавлять можно только в группу'); return; }

        promptBox('Добавить участника', 'Никнейм пользователя', '@', function (val) {
            var nick = val.trim().toLowerCase().replace(/^@+/, '');
            if (!nick) return;
            fetchProfiles('nickname=eq.' + q(nick) + '&limit=1')
                .then(function (rows) {
                    if (!rows || !rows.length) { toast('Пользователь не найден'); return; }
                    var other = rows[0];
                    state.profiles[other.id] = other;
                    if ((chat.members || []).indexOf(other.id) >= 0) { toast('Уже в группе'); return; }
                    return rpc('wm_join_chat', { p_room: chat.room_id, p_user: other.id })
                        .catch(function (err) {
                            if (!missingRelation(err)) throw err;
                            var members = (chat.members || []).concat([other.id]);
                            return request('/chats?room_id=eq.' + q(chat.room_id),
                                { method: 'PATCH', body: { members: members } });
                        })
                        .then(function () {
                            chat.members = (chat.members || []).concat([other.id]);
                            updateChatHeader();
                            return shareRoomKey(chat.room_id, other.id);
                        })
                        .then(function () { toast('Участник добавлен'); });
                })
                .catch(function (e) { toast(e.message || 'Не удалось добавить участника'); });
        });
    }

    /* -------------------------------------------------- выделение долгим тапом */

    var pressTimer = null;
    var longPressed = false;

    function startPress(room) {
        longPressed = false;
        clearTimeout(pressTimer);
        pressTimer = setTimeout(function () {
            longPressed = true;
            state.selectedRoom = room;
            $('context-bar').classList.add('show');
            renderChatList();
            vibrate();
        }, 450);
    }

    function endPress() { clearTimeout(pressTimer); }

    function resetSelection() {
        state.selectedRoom = null;
        $('context-bar').classList.remove('show');
        renderChatList();
    }

    /* ------------------------------------------------------------ окно чата */

    function findChat(room) {
        if (state.virtual[room]) return state.virtual[room];
        return state.chats.filter(function (c) { return c.room_id === room; })[0] || null;
    }

    function isCommentsRoom(chat) {
        return !!chat && chat.kind === 'comments';
    }

    /* Обсуждение под записью канала: отдельная комната post_<id>.
       Писать в неё может любой — это не сам канал. */
    function openComments(postId) {
        var parent = state.activeChat;
        if (!parent) return;
        var msg = state.msgs.filter(function (m) { return m.id === String(postId); })[0];
        var room = 'post_' + postId;

        state.virtual[room] = {
            room_id: room,
            kind: 'comments',
            name: 'Комментарии',
            members: [state.me.id],
            parentRoom: parent.room_id,
            parentTitle: chatDisplayName(parent),
            postPreview: msg ? replySnippet(msg) : ''
        };
        openChat(room);
    }

    /* Сколько комментариев под каждой записью канала. */
    function loadCommentCounts(room, ids) {
        if (!ids.length) return Promise.resolve(false);
        var list = 'in.(' + ids.map(function (id) { return '"post_' + String(id).replace(/"/g, '') + '"'; }).join(',') + ')';
        return request('/messages?room_id=' + q(list) + '&select=room_id&limit=1000')
            .then(function (rows) {
                var counts = {};
                (rows || []).forEach(function (r) {
                    var id = String(r.room_id).slice(5);
                    counts[id] = (counts[id] || 0) + 1;
                });
                var changed = false;
                ids.forEach(function (id) {
                    var next = counts[id] || 0;
                    if (state.commentCounts[id] !== next) {
                        state.commentCounts[id] = next;
                        changed = true;
                    }
                });
                return changed;
            })
            .catch(function () { return false; });
    }

    function isMember(chat) {
        return !chat || (chat.members || []).indexOf(state.me.id) >= 0;
    }

    function canPost(chat) {
        if (!chat) return false;
        if (chat.kind !== 'channel') return true;          // обсуждения открыты всем
        return !chat.owner_id || chat.owner_id === state.me.id;
    }

    function updateChatHeader() {
        var chat = state.activeChat;
        if (!chat) return;

        $('chat-title').childNodes[0].nodeValue = chatDisplayName(chat) + ' ';
        $('chat-lock').hidden = !state.keys[chat.room_id];

        var sub = '';
        if (isCommentsRoom(chat)) {
            $('chat-lock').hidden = true;
            $('chat-subtitle').textContent = chat.postPreview
                ? 'к записи: ' + chat.postPreview : 'обсуждение записи';
            $('act-invite').hidden = true;
            $('act-crypto').hidden = true;
            $('act-leave').hidden = true;
            $('act-delete').hidden = true;
            $('act-clear').hidden = true;
            $('input-bar').hidden = false;
            $('channel-bar').hidden = true;
            return;
        }
        if (chat.kind === 'channel') {
            sub = plural(chat.subscribers || (chat.members || []).length,
                'подписчик', 'подписчика', 'подписчиков');
            if (chat.slug) sub = '@' + chat.slug + ' · ' + sub;
        } else if (chat.kind === 'group') {
            sub = plural((chat.members || []).length, 'участник', 'участника', 'участников');
        } else if (isSaved(chat)) {
            sub = 'виден только вам';
        } else if (isAi(chat)) {
            sub = 'ваш помощник';
        } else {
            var other = (chat.members || []).filter(function (m) { return m !== state.me.id; })[0];
            var p = other && state.profiles[other];
            if (p) sub = presenceText(p) || ('@' + p.nickname);
        }
        if (prefFor(chat.room_id).muted) sub += (sub ? ' · ' : '') + '🔇';
        $('chat-subtitle').textContent = sub;

        $('btn-call').hidden = !(chat.kind === 'dm' && callsSupported() && state.callsReady);
        $('act-invite').hidden = chat.kind !== 'group';
        $('act-leave').hidden = chat.kind === 'dm' || isSaved(chat) || isAi(chat);
        $('act-delete').hidden = isSaved(chat) || isAi(chat) ||
            (chat.kind === 'channel' && chat.owner_id !== state.me.id);
        $('act-clear').hidden = !canPost(chat);
        $('act-crypto').hidden = chat.kind === 'channel';

        var member = isMember(chat);
        var post = canPost(chat) && member;
        $('input-bar').hidden = !post;
        updateComposer();
        $('channel-bar').hidden = post;
        if (!post) {
            $('btn-join').hidden = member;
            $('channel-note').textContent = member
                ? 'Только автор канала публикует записи'
                : 'Вы не подписаны на этот канал';
        }
    }

    function openChat(room) {
        var chat = findChat(room);
        if (!chat) return;
        if (state.searchMode) closeSearch();
        state.activeRoom = room;
        state.activeChat = chat;
        state.msgs = [];
        state.pickerOpen = null;
        state.pendingRender = false;
        state.firstChatPaint = true;
        state.newCount = 0;
        state.pinBottom = true;        // при открытии всегда показываем конец переписки
        state.unreadFrom = myLastRead(room);
        clearReply();
        updateScrollPill();

        $('msg-list').innerHTML = skeletonHtml();
        updateChatHeader();
        showPage('chat', true);
        $('m-input').value = '';
        $('m-input').placeholder = 'Сообщение...';
        autoGrow($('m-input'));
        stopVoice();
        updateComposer();

        stopChatTimer();

        paintCachedMessages(room).then(function () {
            return pollChat(true);
        }).then(function () {
            state.chatTimer = setInterval(function () {
                if (!document.hidden) pollChat(false);
            }, CFG.pollChatMs);
        });
    }

    function skeletonHtml() {
        var rows = '';
        var widths = [55, 40, 70, 35];
        for (var i = 0; i < widths.length; i++) {
            rows += '<div class="skeleton-bubble ' + (i % 2 ? 'out' : 'in') + '" ' +
                'style="width:' + widths[i] + '%"></div>';
        }
        return '<div class="skeleton-wrap">' + rows + '</div>';
    }

    /* Мгновенная отрисовка последнего известного состояния чата из кэша. */
    function paintCachedMessages(room) {
        var cached = readJSON(LS.cacheMsgs + room, null);
        if (!cached || !cached.length) return Promise.resolve();
        state.msgs = cached.map(function (m) { m.cached = true; return m; });
        return decodeAll(state.msgs, room).then(function () {
            if (state.activeRoom !== room) return;
            renderMessages(true);
            state.firstChatPaint = false;
        });
    }

    function cacheMessages(room) {
        var slim = state.msgs.slice(-40).filter(function (m) { return !m.pending; })
            .map(function (m) {
                var text = m.text;
                if (typeof text === 'string' && text.length > 20000) text = '📷 Фото';
                return {
                    id: m.id, room_id: m.room_id, user_id: m.user_id, user_name: m.user_name,
                    text: text, thumb: m.thumb, reply_to: m.reply_to, reply_name: m.reply_name,
                    reply_preview: m.reply_preview, reactions: m.reactions, created_at: m.created_at
                };
            });
        writeJSON(LS.cacheMsgs + room, slim);
    }

    function closeChat() {
        stopVoice();
        closeGifs();
        if (rec) stopRecording(true);
        var current = state.activeChat;
        if (isCommentsRoom(current) && current.parentRoom) {
            stopChatTimer();
            closePicker();
            var back = current.parentRoom;
            state.activeRoom = null;
            state.activeChat = null;
            state.msgs = [];
            openChat(back);
            return;
        }
        stopChatTimer();
        closePicker();
        state.activeRoom = null;
        state.activeChat = null;
        state.msgs = [];
        showPage('main');
        syncChats();
    }

    function stopChatTimer() {
        if (state.chatTimer) { clearInterval(state.chatTimer); state.chatTimer = null; }
    }

    function stopTimers() {
        clearInterval(state.callPoll);
        clearInterval(state.presenceTimer);
        stopChatTimer();
        if (state.listTimer) { clearInterval(state.listTimer); state.listTimer = null; }
    }

    function lastCreatedAt() {
        var real = state.msgs.filter(function (m) { return !m.pending && !m.cached; });
        return real.length ? real[real.length - 1].created_at : null;
    }

    /* Пока личный чат открыт, раз в 15 секунд освежаем профиль собеседника —
       иначе «в сети» в шапке замерло бы на момент открытия. */
    function refreshPresence() {
        var chat = state.activeChat;
        if (!chat || chat.kind !== 'dm' || !state.hasPresence) return;
        if (Date.now() - (state.presenceAt || 0) < 15000) return;
        state.presenceAt = Date.now();

        var other = (chat.members || []).filter(function (m) { return m !== state.me.id; })[0];
        if (!other) return;
        loadProfiles([other], true).then(function () {
            if (state.activeChat === chat) updateChatHeader();
        });
    }

    function pollChat(initial) {
        var room = state.activeRoom;
        if (!room) return Promise.resolve();
        refreshPresence();

        var base = 'id,room_id,user_id,user_name,text,reactions,created_at';
        var fields = state.hasReplies
            ? base + ',reply_to,reply_name,reply_preview,thumb' : base;
        var newerThan = initial ? null : lastCreatedAt();

        function fetchRange(cols) {
            return newerThan
                ? request('/messages?room_id=eq.' + q(room) + '&created_at=gt.' + q(newerThan) +
                    '&select=' + cols + '&order=created_at.asc&limit=100')
                : request('/messages?room_id=eq.' + q(room) +
                    '&select=' + cols + '&order=created_at.desc&limit=100')
                    .then(function (rows) { return (rows || []).slice().reverse(); });
        }

        var loadMsgs = fetchRange(fields).catch(function (err) {
            // в базе прошлой версии колонок ответа нет — читаем без них
            if (err.status !== 400 || !state.hasReplies) throw err;
            state.hasReplies = false;
            return fetchRange(base);
        });

        return loadMsgs.then(function (rows) {
            if (state.activeRoom !== room) return null;
            var fresh = (rows || []).map(function (m) { m.id = String(m.id); return m; });

            if (initial) {
                // сохраняем ещё не отправленные сообщения
                var pending = state.msgs.filter(function (m) { return m.pending; });
                state.msgs = fresh.concat(pending);
            } else {
                fresh.forEach(function (m) {
                    if (!state.msgs.some(function (x) { return x.id === m.id; })) state.msgs.push(m);
                });
            }
            state.msgs.sort(function (a, b) { return String(a.created_at).localeCompare(String(b.created_at)); });

            return request('/messages?room_id=eq.' + q(room) + '&select=id,reactions&order=created_at.desc&limit=100')
                .then(function (light) {
                    if (state.activeRoom !== room) return null;
                    var alive = {};
                    (light || []).forEach(function (l) {
                        alive[String(l.id)] = true;
                        var m = state.msgs.filter(function (x) { return x.id === String(l.id); })[0];
                        if (m) m.reactions = l.reactions;
                    });
                    state.msgs = state.msgs.filter(function (m) { return m.pending || alive[m.id]; });
                    return fresh;
                });
        }).then(function (added) {
            if (state.activeRoom !== room) return;
            var chat = findChat(room);
            var counts = (chat && chat.kind === 'channel')
                ? loadCommentCounts(room, state.msgs.filter(function (m) { return !m.pending; })
                    .slice(-40).map(function (m) { return m.id; }))
                : Promise.resolve(false);

            return counts.then(function () {
                return decodeAll(state.msgs, room);
            }).then(function () {
                return loadReads(room);
            }).then(function () {
                if (state.activeRoom !== room) return;
                var incoming = 0;
                (added || []).forEach(function (m) { if (m.user_id !== state.me.id) incoming++; });
                if (incoming && !isAtBottom()) state.newCount += incoming;
                renderMessages(!!initial);
                cacheMessages(room);
                if (initial || (added && added.length)) markRead(room);
            });
        }).catch(function (err) {
            if (state.activeRoom !== room) return;
            if (initial && !state.msgs.length) {
                $('msg-list').innerHTML = '<div class="empty-state"><div class="ico">⚠️</div>' +
                    '<b>Не удалось загрузить</b><p>' + esc(err.message || 'Проверьте соединение') + '</p></div>';
            }
        });
    }

    function loadReads(room) {
        return request('/room_reads?room_id=eq.' + q(room) + '&select=user_id,last_read_at')
            .then(function (rows) {
                var map = {};
                (rows || []).forEach(function (r) { map[r.user_id] = r.last_read_at; });
                var local = localReads()[room];
                if (local && (!map[state.me.id] || local > map[state.me.id])) map[state.me.id] = local;
                state.reads[room] = map;
            })
            .catch(function () { /* таблицы может не быть */ });
    }

    function othersLastRead(room) {
        var map = state.reads[room] || {};
        var best = '';
        Object.keys(map).forEach(function (uid) {
            if (uid === state.me.id) return;
            if (String(map[uid]) > best) best = String(map[uid]);
        });
        return best;
    }

    function normalizeReactions(raw) {
        var out = {};
        if (!raw || typeof raw !== 'object') return out;
        Object.keys(raw).forEach(function (emoji) {
            var v = raw[emoji];
            if (Array.isArray(v)) {
                if (v.length) out[emoji] = v.slice();
            } else if (typeof v === 'number' && v > 0) {
                var arr = [];
                for (var i = 0; i < v; i++) arr.push('legacy_' + i);
                out[emoji] = arr;
            }
        });
        return out;
    }

    /* Одна галочка — сообщение на сервере, две — собеседник его прочитал.
       Пока сообщение уходит, показываются часики. */
    function statusClass(m) {
        if (m.pending) return 'status-pending';
        if (m.failed) return 'status-failed';
        var read = othersLastRead(state.activeRoom);
        if (read && String(m.created_at) <= read) return 'status-read';
        return 'status-sent';
    }

    var CHECK_SVG = '<svg class="check-svg" viewBox="0 0 20 14">' +
        '<path class="check-path first" d="M2 8.2 L6 12 L13 3"/>' +
        '<path class="check-path second" d="M8 8.6 L11.4 12 L18 3"/></svg>';

    var CLOCK_SVG = '<svg class="check-svg clock" viewBox="0 0 20 20">' +
        '<circle cx="10" cy="10" r="7"/><path d="M10 6 L10 10.5 L13 12"/></svg>';

    function statusIcon(m) {
        var cls = statusClass(m);
        return '<span class="status-icon ' + cls + '">' +
            (cls === 'status-pending' ? CLOCK_SVG : CHECK_SVG) + '</span>';
    }

    /* ------------------------------------------------- отрисовка сообщений
       Список сверяется по ключам: неизменившиеся узлы не трогаются вообще.
       Именно это убирает мигание при опросе сервера каждые две секунды. */

    function messageKey(m) { return m.localKey || ('id' + m.id); }

    function messageSignature(m) {
        return [
            m.body === undefined ? m.text : m.body,
            JSON.stringify(m.reactions || {}),
            statusClass(m),
            m.pending ? 1 : 0,
            m.failed ? 1 : 0,
            m.user_name || '',
            m.reply_to || '',
            m.replyBody === undefined ? (m.reply_preview || '') : m.replyBody,
            state.commentCounts[m.id] === undefined ? '' : state.commentCounts[m.id],
            m.thumbBody ? '1' : '0'
        ].join('\u0001');
    }

    function bubbleInner(m, isGroup) {
        var out = m.user_id === state.me.id;
        var body = m.body === undefined ? m.text : m.body;

        var content;
        if (m.locked) {
            content = '<span class="locked">' + esc(body) + '</span>';
        } else if (isPhotoRef(body)) {
            var id = attachmentId(body);
            var ready = state.photos[id];
            content = '<img class="photo' + (ready ? '' : ' loading') + '"' +
                ' src="' + esc(ready || m.thumbBody || TRANSPARENT_PIXEL) + '"' +
                ' alt="фото" data-photo="1" data-att="' + esc(id) + '"' +
                (ready ? ' data-loaded="1"' : '') + '>';
        } else if (isGifRef(body)) {
            var gif = gifInfo(body);
            // Место под гифку резервируется заранее — переписка не «прыгает».
            content = '<div class="gif-box" style="aspect-ratio:' + esc(gif.width) + '/' +
                esc(gif.height) + '"><video class="gif" data-gif="' + esc(gif.id) + '"' +
                ' muted loop playsinline preload="none"></video></div>';
        } else if (isCallLog(body)) {
            content = '<span class="call-log">' + esc(callLogText(body)) + '</span>';
        } else if (isVideoRef(body)) {
            var vid = videoInfo(body);
            var poster = m.thumbBody || '';
            content = '<div class="video" data-video="' + esc(vid.id) + '">' +
                (poster ? '<img class="video-poster" src="' + esc(poster) + '" alt="видео">' : '') +
                '<span class="video-play"></span>' +
                (vid.seconds ? '<span class="video-time">' + esc(fmtDuration(vid.seconds)) +
                    '</span>' : '') + '</div>';
        } else if (isVoiceRef(body)) {
            var voice = voiceInfo(body);
            content = '<div class="voice" data-voice="' + esc(voice.id) + '"' +
                ' data-dur="' + esc(voice.seconds) + '">' +
                '<button type="button" class="voice-play" aria-label="Слушать"></button>' +
                '<div class="voice-bar"><i class="voice-fill"></i></div>' +
                '<span class="voice-time">' + esc(fmtDuration(voice.seconds)) + '</span></div>';
        } else if (isImage(body)) {
            content = '<img class="photo" src="' + esc(body) + '" alt="фото" data-photo="1">';
        } else {
            content = linkify(body);
        }

        var reactions = normalizeReactions(m.reactions);
        var keys = Object.keys(reactions);
        var rHtml = '';
        if (keys.length) {
            rHtml = '<div class="reactions-row">' + keys.map(function (emoji) {
                var mine = reactions[emoji].indexOf(state.me.id) >= 0;
                return '<div class="reaction-badge' + (mine ? ' mine' : '') + '"' +
                    ' data-react="' + esc(m.id) + '" data-emoji="' + esc(emoji) + '">' +
                    '<span>' + esc(emoji) + '</span>' +
                    '<span class="reaction-count">' + reactions[emoji].length + '</span></div>';
            }).join('') + '</div>';
        }

        var author = (!out && isGroup)
            ? '<span class="author" data-author="' + esc(m.user_id || '') + '">' +
              esc(m.user_name || 'Пользователь') + '</span>' : '';

        var quote = '';
        if (m.reply_to) {
            quote = '<div class="quote" data-goto="' + esc(m.reply_to) + '"><i></i>' +
                '<div class="q-body"><b>' + esc(m.reply_name || 'Сообщение') + '</b>' +
                '<small>' + esc(m.replyBody === undefined ? (m.reply_preview || '') : m.replyBody) +
                '</small></div></div>';
        }

        var foot = '';
        if (state.activeChat && state.activeChat.kind === 'channel' && !m.pending) {
            var n = state.commentCounts[m.id] || 0;
            foot = '<div class="post-foot" data-comments="' + esc(m.id) + '">💬 ' +
                (n ? esc(plural(n, 'комментарий', 'комментария', 'комментариев'))
                   : 'Комментировать') + '</div>';
        }

        return author + quote + '<div class="text">' + content + '</div>' + rHtml + foot +
            '<div class="bubble-meta">' + esc(fmtTime(m.created_at)) +
            (out ? statusIcon(m) : '') +
            '</div>';
    }

    function createBubble(m, isGroup) {
        var node = document.createElement('div');
        var out = m.user_id === state.me.id;
        node.className = 'bubble ' + (out ? 'out' : 'in') +
            (m.pending ? ' pending' : '') + (m.failed ? ' failed' : '');
        node.setAttribute('data-key', 'msg:' + messageKey(m));
        node.setAttribute('data-msg', m.id);
        node.innerHTML = bubbleInner(m, isGroup);
        node._sig = messageSignature(m);
        return node;
    }

    function updateBubble(node, m, isGroup) {
        var sig = messageSignature(m);
        if (node._sig === sig && node.getAttribute('data-msg') === String(m.id)) return;
        node._sig = sig;
        node.setAttribute('data-msg', m.id);
        node.classList.toggle('pending', !!m.pending);
        node.classList.toggle('failed', !!m.failed);
        node.innerHTML = bubbleInner(m, isGroup);
    }

    function renderMessages(scrollToEnd) {
        if (state.pickerOpen) { state.pendingRender = true; return; }
        var box = $('msg-list');
        if (!state.activeRoom) return;

        if (!state.msgs.length) {
            box.innerHTML = '<div class="empty-state"><div class="ico">👋</div>' +
                '<b>Сообщений пока нет</b><p>' +
                (canPost(state.activeChat) ? 'Напишите первым' : 'Автор ещё ничего не публиковал') +
                '</p></div>';
            return;
        }

        var skeleton = box.querySelector('.skeleton-wrap, .empty-state');
        if (skeleton) box.innerHTML = '';

        var wasAtBottom = isAtBottom();
        // в группах, каналах и обсуждениях показываем автора входящего сообщения
        var isGroup = state.activeChat && state.activeChat.kind !== 'dm' &&
            !isSaved(state.activeChat) && !isAi(state.activeChat);

        /* Сообщения, зашифрованные ключом, которого у нас нет (например,
           присланные до того, как чат обзавёлся общим ключом), в переписке не
           показываем: вместо стены замков — одна спокойная строка сверху. */
        var visible = state.msgs.filter(function (m) { return !m.locked; });
        var hidden = state.msgs.length - visible.length;

        var desired = [];
        var lastDay = '';
        var unreadShown = false;
        if (hidden) desired.push({ key: 'locked-note', note: hidden });
        visible.forEach(function (m) {
            var day = fmtDay(m.created_at);
            if (day && day !== lastDay) {
                desired.push({ key: 'sep:' + day, day: day });
                lastDay = day;
            }
            if (!unreadShown && state.unreadFrom && m.user_id !== state.me.id &&
                String(m.created_at) > state.unreadFrom) {
                desired.push({ key: 'unread', unread: true });
                unreadShown = true;
            }
            desired.push({ key: 'msg:' + messageKey(m), m: m });
        });

        var index = {};
        Array.prototype.forEach.call(box.children, function (node) {
            var k = node.getAttribute('data-key');
            if (k) index[k] = node;
        });

        var cursor = box.firstChild;
        var animate = !state.firstChatPaint;

        desired.forEach(function (item) {
            var node = index[item.key];
            if (node) {
                if (item.m) updateBubble(node, item.m, isGroup);
            } else if (item.m) {
                node = createBubble(item.m, isGroup);
                if (animate) node.classList.add('appear');
            } else if (item.note) {
                node = document.createElement('div');
                node.className = 'locked-note';
                node.setAttribute('data-key', item.key);
                node.textContent = 'Скрыто ' + item.note + ' ' +
                    plural(item.note, 'сообщение', 'сообщения', 'сообщений') +
                    ': они зашифрованы прежним ключом';
            } else if (item.unread) {
                node = document.createElement('div');
                node.className = 'unread-sep';
                node.setAttribute('data-key', item.key);
                node.textContent = 'Непрочитанные сообщения';
            } else {
                node = document.createElement('div');
                node.className = 'day-sep';
                node.setAttribute('data-key', item.key);
                node.textContent = item.day;
            }

            if (node === cursor) cursor = cursor.nextSibling;
            else box.insertBefore(node, cursor);
        });

        while (cursor) {
            var next = cursor.nextSibling;
            box.removeChild(cursor);
            cursor = next;
        }

        state.firstChatPaint = false;

        // Прокручиваем только когда это уместно: при открытии чата, при своей
        // отправке или если человек и так стоит внизу. Читаете историю —
        // список остаётся на месте, а о новых сообщениях сообщает кнопка.
        if (scrollToEnd || wasAtBottom || state.pinBottom) {
            box.scrollTop = box.scrollHeight;
            state.newCount = 0;
        }
        updateScrollPill();
        hydratePhotos();
        hydrateGifs();
    }

    function isAtBottom() {
        var box = $('msg-list');
        return box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    }

    function updateScrollPill() {
        var pill = $('scroll-pill');
        if (!pill) return;
        if (!isAtBottom()) state.pinBottom = false;      // человек ушёл читать историю
        var show = state.activeRoom && !isAtBottom();
        pill.hidden = !show;
        $('scroll-count').textContent = state.newCount > 0 ? String(state.newCount) : '';
        if (!show) state.newCount = 0;
    }

    function jumpToBottom() {
        var box = $('msg-list');
        box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
        state.newCount = 0;
        state.pinBottom = true;
        $('scroll-pill').hidden = true;
        $('scroll-count').textContent = '';
    }

    function sendMessage(textOverride, extra) {
        extra = extra || {};
        var input = $('m-input');
        var text = textOverride !== undefined ? textOverride : input.value.trim();
        if (!text || !state.activeRoom) return;
        if (!canPost(state.activeChat)) { toast('В этом канале пишет только автор'); return; }
        if (textOverride === undefined) { input.value = ''; autoGrow(input); updateComposer(); }

        var room = state.activeRoom;
        var stamp = new Date().toISOString();
        var reply = state.replyTo;
        var temp = {
            id: 'tmp_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
            localKey: 'local_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
            room_id: room,
            user_id: state.me.id,
            user_name: state.me.name,
            text: text,
            body: text,
            thumb: extra.thumb || null,
            thumbBody: extra.thumbBody,
            reactions: {},
            created_at: stamp,
            reply_to: reply ? reply.id : null,
            reply_name: reply ? reply.name : null,
            replyBody: reply ? reply.preview : undefined,
            pending: true
        };
        clearReply();
        state.msgs.push(temp);
        renderMessages(true);

        var previewText = isPhoto(text) ? '📷 Фото'
            : (isVoiceRef(text) ? '🎤 Голосовое сообщение'
                : (isVideoRef(text) ? '🎬 Видео'
                    : (isCallLog(text) ? callLogText(text)
                        : (isGifRef(text) ? '🎞 GIF' : String(text).slice(0, 70)))));

        roomKey(room).then(function (key) {
            if (!key) return { text: text, quote: reply ? reply.preview : null, preview: previewText };
            return Promise.all([
                CR.encrypt(key, text),
                reply ? CR.encrypt(key, reply.preview) : Promise.resolve(null),
                CR.encrypt(key, previewText)
            ]).then(function (parts) {
                return { text: parts[0], quote: parts[1], preview: parts[2] };
            });
        }).then(function (payload) {
            var body = {
                room_id: room,
                user_id: state.me.id,
                user_name: state.me.name,
                text: payload.text,
                preview: payload.preview,
                thumb: extra.thumb || null,
                reactions: {},
                created_at: stamp
            };
            if (reply) {
                body.reply_to = String(reply.id);
                body.reply_name = reply.name;
                body.reply_preview = payload.quote;
            }
            return request('/messages', {
                method: 'POST',
                headers: { Prefer: 'return=representation' },
                body: body
            }).catch(function (err) {
                // старая таблица без новых колонок — отправляем базовый набор полей
                if (err.status !== 400) throw err;
                delete body.reply_to; delete body.reply_name; delete body.reply_preview;
                delete body.preview; delete body.thumb;
                return request('/messages', {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: body
                });
            });
        }).then(function (rows) {
            var saved = rows && rows[0];
            var idx = state.msgs.indexOf(temp);
            if (idx < 0) return;
            if (saved) {
                saved.id = String(saved.id);
                saved.localKey = temp.localKey;       // тот же DOM-узел: без повторной анимации
                saved.body = text;
                saved.replyBody = temp.replyBody;
                saved.thumbBody = temp.thumbBody;
                if (state.msgs.some(function (x) { return x.id === saved.id && x !== temp; })) {
                    state.msgs.splice(idx, 1);
                } else {
                    state.msgs[idx] = saved;
                }
            } else {
                temp.pending = false;
            }
            if (state.activeRoom === room) { renderMessages(false); cacheMessages(room); }
            markRead(room, stamp);
            if (saved && saved.id) pingPush(saved.id);
            // «@WolffAI» в любом чате: помощник отвечает прямо там, куда его
            // позвали, — добавлять его в участники не нужно.
            if (!isAi(findChat(room)) && /@wolffai\b/i.test(String(text))) askAi(room);

            if (isAi(findChat(room))) {
                // Помощник понимает только текст: на фото и голос отвечаем сразу.
                if (isPhoto(text) || isVoiceRef(text) || isVideoRef(text)) {
                    postAiMessage(room, 'Я пока понимаю только текст — напишите словами, ' +
                        'и я отвечу.').then(function () { pollChat(false); });
                } else {
                    askAi(room);
                }
            }
        }).catch(function (err) {
            temp.pending = false;
            temp.failed = true;
            if (state.activeRoom === room) renderMessages(false);
            toast(err.message || 'Сообщение не отправлено');
        });
    }

    function deleteMessage(id) {
        var msg = state.msgs.filter(function (m) { return m.id === id; })[0];
        if (!msg || msg.user_id !== state.me.id) return;
        state.msgs = state.msgs.filter(function (m) { return m.id !== id; });
        renderMessages(false);
        if (msg.pending) return;
        request('/messages?id=eq.' + q(id), { method: 'DELETE' })
            .catch(function (e) { toast(e.message || 'Не удалось удалить'); });
    }

    /* --------------------------------------------------------- реакции */

    function closePicker() {
        var open = document.querySelectorAll('.msg-menu, .reaction-picker');
        Array.prototype.forEach.call(open, function (node) {
            if (node.parentNode) node.parentNode.removeChild(node);
        });
        state.pickerOpen = null;
        if (state.pendingRender) {
            state.pendingRender = false;
            renderMessages(false);
        }
    }

    function openPicker(bubble, msgId) {
        closePicker();
        var msg = state.msgs.filter(function (m) { return m.id === msgId; })[0];
        if (!msg || msg.pending) return;

        state.pickerOpen = msgId;
        var mine = msg.user_id === state.me.id;
        var chosen = myReaction(msg);
        var isChannel = state.activeChat && state.activeChat.kind === 'channel';
        var hasReactions = Object.keys(normalizeReactions(msg.reactions)).length > 0;

        var menu = document.createElement('div');
        menu.className = 'msg-menu';

        var html = '<div class="menu-emojis">' + EMOJIS.map(function (e, i) {
            return '<span class="emoji-btn' + (chosen === e ? ' chosen' : '') + '"' +
                ' style="--i:' + i + '" data-pick="' + esc(e) + '">' + esc(e) + '</span>';
        }).join('') + '</div>';

        if (canPost(state.activeChat)) {
            html += '<div class="menu-item" data-act="reply"><span>↩️</span> Ответить</div>';
        }
        html += '<div class="menu-item" data-act="copy"><span>📋</span> Копировать</div>';
        if (hasReactions && !isChannel) {
            html += '<div class="menu-item" data-act="who"><span>😊</span> Кто отреагировал</div>';
        }
        if (mine) {
            html += '<div class="menu-item danger" data-act="delete"><span>🗑</span> Удалить</div>';
        }
        menu.innerHTML = html;

        menu.addEventListener('click', function (ev) {
            ev.stopPropagation();
            var pick = ev.target.getAttribute('data-pick');
            var item = ev.target.closest('.menu-item');
            var act = item && item.getAttribute('data-act');
            closePicker();
            if (pick) setReaction(msgId, pick);
            else if (act === 'reply') startReply(msg);
            else if (act === 'copy') copyMessage(msg);
            else if (act === 'who') openReactionList(msgId);
            else if (act === 'delete') {
                confirmBox('Удалить сообщение?',
                    'Сообщение исчезнет у всех участников чата.', 'Удалить', function () {
                    deleteMessage(msgId);
                });
            }
        });

        bubble.appendChild(menu);

        // если сообщение у верхнего края — раскрываем меню вниз
        var box = $('msg-list');
        if (bubble.getBoundingClientRect().top - box.getBoundingClientRect().top < menu.offsetHeight + 16) {
            menu.classList.add('flip');
        }

        // Меню закрывается следующим касанием мимо него. Слушаем именно
        // нажатие, а не щелчок: меню открылось во время долгого нажатия, и
        // щелчок от него же закрыл бы его сразу.
        setTimeout(function () {
            var once = function (ev) {
                if (ev.target.closest && ev.target.closest('.msg-menu')) return;
                closePicker();
                document.removeEventListener('pointerdown', once, true);
            };
            document.addEventListener('pointerdown', once, true);
        }, 0);
    }

    /* ==================================================================
       ЖЕСТЫ В ПЕРЕПИСКЕ

       Долгое нажатие открывает меню сообщения, смахивание влево — ответ.
       Обычное касание не делает ничего: так меню не выскакивает под пальцем
       во время чтения, а текст можно спокойно выделять.

       Чтобы ответ не срабатывал случайно, смахивание засчитывается только
       если движение начато пальцем, идёт заметно горизонтально и дошло до
       порога. Любое движение вверх-вниз сразу отменяет жест — это прокрутка.
       ================================================================== */

    var SWIPE_START = 12;      // с какого сдвига считаем, что это смахивание
    var SWIPE_DONE = 62;       // с какого срабатывает ответ
    var SWIPE_MAX = 84;
    var HOLD_MS = 420;

    var gesture = null;

    function clearGesture(animate) {
        if (!gesture) return;
        clearTimeout(gesture.timer);
        var node = gesture.node;
        if (node) {
            node.classList.remove('swiping', 'swipe-ready');
            if (animate) {
                node.style.transition = 'transform .18s cubic-bezier(.4,0,.2,1)';
                node.style.transform = '';
                setTimeout(function () { node.style.transition = ''; }, 220);
            } else {
                node.style.transform = '';
            }
        }
        gesture = null;
    }

    function gestureDown(e) {
        if (!e.target.closest) return;
        if (e.button !== undefined && e.button !== 0) return;
        var bubble = e.target.closest('.bubble');
        if (!bubble || e.target.closest('.msg-menu') || e.target.closest('a.link')) return;

        clearGesture(false);
        var id = bubble.getAttribute('data-msg');
        gesture = {
            node: bubble, id: id, x: e.clientX, y: e.clientY, dx: 0,
            touch: e.pointerType !== 'mouse', swiping: false, ready: false, opened: false,
            timer: setTimeout(function () {
                if (!gesture) return;
                gesture.opened = true;
                vibrate();
                openPicker(bubble, id);
            }, HOLD_MS)
        };
    }

    function gestureMove(e) {
        if (!gesture) return;
        var dx = e.clientX - gesture.x;
        var dy = e.clientY - gesture.y;

        if (!gesture.swiping) {
            if (Math.abs(dx) > 8 || Math.abs(dy) > 8) clearTimeout(gesture.timer);
            if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) { clearGesture(true); return; }
            if (!gesture.touch) return;                    // мышью не смахиваем
            if (dx > -SWIPE_START) return;
            if (Math.abs(dx) < Math.abs(dy) * 1.6) return; // движение недостаточно горизонтальное
            gesture.swiping = true;
            gesture.node.classList.add('swiping');
        }

        gesture.dx = Math.max(-SWIPE_MAX, Math.min(0, dx + SWIPE_START));
        gesture.node.style.transform = 'translateX(' + gesture.dx + 'px)';

        var ready = gesture.dx <= -SWIPE_DONE;
        if (ready !== gesture.ready) {
            gesture.ready = ready;
            gesture.node.classList.toggle('swipe-ready', ready);
            if (ready) vibrate();
        }
    }

    function gestureUp(e) {
        if (!gesture) return;
        var swiped = gesture.swiping && gesture.dx <= -SWIPE_DONE;
        var reply = swiped ? findMessage(gesture.id) : null;

        // Обычное касание открывает то же меню, что и долгое нажатие.
        var tap = !gesture.swiping && !gesture.opened &&
            Math.abs((e && e.clientX ? e.clientX : gesture.x) - gesture.x) < 8;
        var node = gesture.node;
        var id = gesture.id;

        clearGesture(true);

        if (reply && !reply.pending && canPost(state.activeChat)) {
            vibrate();
            startReply(reply);
            return;
        }
        if (tap && node && !tapHitsControl(e)) openPicker(node, id);
    }

    /* Нажатия на ссылку, фото, голос, реакцию, цитату, имя автора и строку
       обсуждения обрабатываются по-своему — меню там не нужно. */
    function tapHitsControl(e) {
        var el = e && e.target && e.target.closest ? e.target : null;
        if (!el) return false;
        return !!el.closest('a.link, .voice, .video, .gif-box, .call-log, .reaction-badge, .quote, ' +
            '.author, [data-comments], [data-photo], .msg-menu');
    }

    function findMessage(id) {
        return state.msgs.filter(function (m) { return String(m.id) === String(id); })[0] || null;
    }

    function bindMessageGestures() {
        var list = $('msg-list');
        list.addEventListener('pointerdown', gestureDown);
        list.addEventListener('pointermove', gestureMove);
        list.addEventListener('pointerup', gestureUp);
        list.addEventListener('pointercancel', function () { clearGesture(true); });
        list.addEventListener('pointerleave', function () { clearGesture(true); });

        // На компьютере меню сообщения открывается правой кнопкой.
        list.addEventListener('contextmenu', function (e) {
            var bubble = e.target.closest && e.target.closest('.bubble');
            if (!bubble) return;
            e.preventDefault();
            clearGesture(false);
            openPicker(bubble, bubble.getAttribute('data-msg'));
        });
    }

    function copyMessage(msg) {
        var text = msg.body === undefined ? msg.text : msg.body;
        if (isImage(text)) { toast('Это изображение'); return; }
        var done = function () { toast('Скопировано'); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () { toast('Не удалось скопировать'); });
        } else {
            var ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); done(); } catch (e) { toast('Не удалось скопировать'); }
            document.body.removeChild(ta);
        }
    }

    /* ---------------------------------------------------- ответы на сообщения */

    function replySnippet(msg) {
        var text = msg.body === undefined ? msg.text : msg.body;
        if (isPhoto(text)) return '📷 Фото';
        return String(text || '').slice(0, 120);
    }

    function startReply(msg) {
        state.replyTo = {
            id: msg.id,
            name: msg.user_id === state.me.id ? 'Вы' : (msg.user_name || 'Участник'),
            preview: replySnippet(msg)
        };
        $('reply-name').textContent = state.replyTo.name;
        $('reply-preview').textContent = state.replyTo.preview;
        $('reply-bar').hidden = false;
        $('m-input').focus();
    }

    function clearReply() {
        state.replyTo = null;
        $('reply-bar').hidden = true;
    }

    function scrollToMessage(id) {
        var node = $('msg-list').querySelector('[data-msg="' + String(id).replace(/"/g, '') + '"]');
        if (!node) { toast('Сообщение не найдено в загруженной истории'); return; }
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        node.classList.remove('flash');
        void node.offsetWidth;
        node.classList.add('flash');
    }

    function myReaction(msg) {
        var reactions = normalizeReactions(msg && msg.reactions);
        var found = null;
        Object.keys(reactions).forEach(function (emoji) {
            if (reactions[emoji].indexOf(state.me.id) >= 0) found = emoji;
        });
        return found;
    }

    /* От одного человека — одна реакция на сообщение: новая заменяет прежнюю,
       повторное нажатие на ту же снимает её. */
    function setReaction(msgId, emoji) {
        var msg = state.msgs.filter(function (m) { return m.id === msgId; })[0];
        if (!msg) return;

        var reactions = normalizeReactions(msg.reactions);
        var had = (reactions[emoji] || []).indexOf(state.me.id) >= 0;

        Object.keys(reactions).forEach(function (k) {
            var rest = reactions[k].filter(function (u) { return u !== state.me.id; });
            if (rest.length) reactions[k] = rest;
            else delete reactions[k];
        });

        if (!had) {
            reactions[emoji] = (reactions[emoji] || []).concat([state.me.id]);
            vibrate();
        }

        msg.reactions = reactions;
        renderMessages(false);

        request('/messages?id=eq.' + q(msgId), { method: 'PATCH', body: { reactions: reactions } })
            .catch(function (e) { toast(e.message || 'Реакция не сохранена'); });
    }

    /* Кто отреагировал: в каналах не показываем. */
    function openReactionList(msgId) {
        if (state.activeChat && state.activeChat.kind === 'channel') return;
        var msg = state.msgs.filter(function (m) { return m.id === msgId; })[0];
        if (!msg) return;

        var reactions = normalizeReactions(msg.reactions);
        var rows = [];
        Object.keys(reactions).forEach(function (emoji) {
            reactions[emoji].forEach(function (uid) { rows.push({ emoji: emoji, uid: uid }); });
        });
        if (!rows.length) return;

        var box = $('reactions-list');
        box.innerHTML = '<div class="muted small" style="padding:10px 4px">Загрузка…</div>';
        $('reactions-modal').classList.add('show');

        var unknown = rows.map(function (r) { return r.uid; })
            .filter(function (id) { return id && id.indexOf('legacy_') !== 0; });

        loadProfiles(unknown).then(function () {
            box.innerHTML = rows.map(function (r, i) {
                var p = state.profiles[r.uid];
                var name = p ? (p.name || '@' + p.nickname) : 'Участник';
                var nick = p ? '@' + p.nickname : '';
                var av = (p && p.avatar) || avatarFor(name, r.uid);
                return '<div class="reaction-user" style="--i:' + i + '" data-uid="' + esc(r.uid) + '">' +
                    '<img alt="" src="' + esc(av) + '">' +
                    '<b>' + esc(name) + '</b>' +
                    '<span class="muted small">' + esc(nick) + '</span>' +
                    '<span class="emoji">' + esc(r.emoji) + '</span></div>';
            }).join('');
        });
    }

    /* --------------------------------------------------- меню и действия чата */

    function toggleChatMenu() {
        var menu = $('chat-actions-menu');
        if (menu.hidden) {
            menu.hidden = false;
            setTimeout(function () { document.addEventListener('click', outsideMenu); }, 10);
        } else {
            closeChatMenu();
        }
    }

    function outsideMenu(ev) {
        var menu = $('chat-actions-menu');
        if (!menu.contains(ev.target)) closeChatMenu();
    }

    function closeChatMenu() {
        var menu = $('chat-actions-menu');
        if (menu && !menu.hidden) {
            menu.hidden = true;
            document.removeEventListener('click', outsideMenu);
        }
    }

    function toggleMuteActive() {
        closeChatMenu();
        var room = state.activeRoom;
        if (!room) return;
        var muted = !prefFor(room).muted;
        setPref(room, { muted: muted });
        updateChatHeader();
        toast(muted ? 'Уведомления выключены' : 'Уведомления включены');
    }

    function clearHistory() {
        closeChatMenu();
        var room = state.activeRoom;
        if (!room) return;
        confirmBox('Очистить историю?', 'Все сообщения этого чата будут удалены у всех участников.',
            'Очистить', function () {
                request('/messages?room_id=eq.' + q(room), { method: 'DELETE' })
                    .then(function () {
                        state.msgs = [];
                        renderMessages(true);
                        cacheMessages(room);
                        toast('История очищена');
                    })
                    .catch(function (e) { toast(e.message || 'Не удалось очистить'); });
            });
    }

    function deleteActiveChat() {
        closeChatMenu();
        var room = state.activeRoom;
        if (!room) return;
        confirmBox('Удалить чат?', 'Чат и вся переписка будут удалены.', 'Удалить', function () {
            removeChat(room).then(function () {
                closeChat();
                toast('Чат удалён');
            });
        });
    }

    function removeChat(room) {
        var local = readJSON(LS.chats, []).filter(function (c) { return c && c.room !== room; });
        writeJSON(LS.chats, local);
        state.chats = state.chats.filter(function (c) { return c.room_id !== room; });
        try { localStorage.removeItem(LS.cacheMsgs + room); } catch (e) { /* no-op */ }
        renderChatList();

        return request('/messages?room_id=eq.' + q(room), { method: 'DELETE' })
            .catch(function () { return null; })
            .then(function () {
                if (!state.serverChats) return null;
                return request('/chats?room_id=eq.' + q(room), { method: 'DELETE' }).catch(function () { return null; });
            })
            .then(function () { return syncChats(); });
    }

    /* -------------------------------------------------- шифрование: диалог */

    function openCryptoModal() {
        closeChatMenu();
        var room = state.activeRoom;
        var chat = state.activeChat;
        if (!room || !chat) return;

        $('crypto-modal').classList.add('show');
        $('crypto-code-box').hidden = true;
        $('crypto-off').hidden = !storedCode(room);

        if (!CR || !CR.available()) {
            setCryptoState(false, 'Недоступно', 'Браузер не поддерживает шифрование. ' +
                'Оно требует защищённого соединения (https).');
            return;
        }
        if (chat.kind === 'channel') {
            setCryptoState(false, 'Канал открыт всем',
                'Записи канала может прочитать любой подписчик, поэтому они не шифруются.');
            return;
        }

        $('crypto-state').textContent = 'Проверяем…';
        $('crypto-state').className = 'crypto-state';

        roomKey(room).then(function (key) {
            if (!key) {
                setCryptoState(false, 'Пока не включено',
                    'Ключи появятся, когда все участники войдут в новую версию приложения. ' +
                    'До этого сообщения передаются без шифрования.');
                return;
            }
            setCryptoState(true, 'Включено',
                'Сообщения, цитаты и фотографии шифруются на устройстве. ' +
                'На сервере хранится только нечитаемый набор символов.');

            var other = (chat.members || []).filter(function (m) { return m !== state.me.id; })[0];
            var myPub = state.identity && state.identity.publicKey;
            var theirPub = other && publicKeyOf(other);
            if (chat.kind === 'dm' && myPub && theirPub) {
                CR.fingerprint(myPub, theirPub).then(function (code) {
                    $('crypto-fingerprint').textContent = code;
                    $('crypto-code-box').hidden = false;
                });
            }
        });
    }

    function setCryptoState(ok, title, note) {
        var el = $('crypto-state');
        el.textContent = (ok ? '🔒 ' : '🔓 ') + title;
        el.className = 'crypto-state ' + (ok ? 'on' : 'off');
        $('crypto-note').textContent = note || '';
    }

    /* Ручной код прошлой версии: только снятие, новые чаты шифруются сами. */
    function disableCrypto() {
        var room = state.activeRoom;
        if (!room) return;
        setRoomCode(room, '');
        $('crypto-modal').classList.remove('show');
        toast('Старый код чата убран');
        reloadRoomAfterKeyChange(room);
    }

    function reloadRoomAfterKeyChange(room) {
        state.msgs = [];
        state.firstChatPaint = true;
        $('msg-list').innerHTML = skeletonHtml();
        updateChatHeader();
        state.listSig = '';
        renderChatList();
        pollChat(true);
    }

    /* ------------------------------------------------------ профиль человека */

    function openProfile(userId) {
        if (!userId) return;
        var modal = $('profile-modal');
        var isMe = userId === state.me.id;

        function paint(p) {
            var name = p ? (p.name || p.nickname) : 'Участник';
            $('pf-av').src = (p && p.avatar) || avatarFor(name, userId);
            $('pf-name').textContent = name;
            $('pf-nick').textContent = p && p.nickname ? '@' + p.nickname : '';
            var status = isMe ? '' : presenceText(p);
            var note = isMe ? 'Это ваш профиль'
                : (p && p.public_key ? 'Переписка с этим человеком шифруется' : '');
            $('pf-extra').textContent = status ? status + (note ? ' · ' + note : '') : note;
            $('pf-write').hidden = isMe || !p;
            $('pf-write').onclick = function () {
                modal.classList.remove('show');
                if (p) startDialog(p.nickname);
            };
        }

        paint(state.profiles[userId] || (isMe ? state.me : null));
        modal.classList.add('show');

        if (!isMe) {
            // Обновляем карточку: статус «в сети» должен быть свежим.
            loadProfiles([userId], true).then(function () { paint(state.profiles[userId]); });
        }
    }

    /* Заголовок чата: личный — профиль собеседника, группа и канал — состав. */
    function openChatInfo() {
        var chat = state.activeChat;
        if (!chat) return;
        if (chat.kind === 'dm') {
            var other = (chat.members || []).filter(function (m) { return m !== state.me.id; })[0];
            if (other) openProfile(other);
            return;
        }

        // В канале состав подписчиков закрыт: показываем только их число.
        if (chat.kind === 'channel') {
            $('pf-av').src = avatarFor(chatDisplayName(chat), chat.room_id);
            $('pf-name').textContent = chatDisplayName(chat);
            $('pf-nick').textContent = chat.slug ? '@' + chat.slug : '';
            $('pf-extra').textContent = (chat.about ? chat.about + ' · ' : '') +
                plural(chat.subscribers || 0, 'подписчик', 'подписчика', 'подписчиков');
            $('pf-write').hidden = true;
            $('profile-modal').classList.add('show');
            return;
        }

        var ids = (chat.members || []).slice(0, 50);
        var box = $('reactions-list');
        box.innerHTML = '<div class="muted small" style="padding:10px 4px">Загрузка…</div>';
        $('reactions-modal').classList.add('show');
        loadProfiles(ids).then(function () {
            box.innerHTML = ids.map(function (id, i) {
                var p = state.profiles[id];
                var name = p ? (p.name || p.nickname) : 'Участник';
                var role = id === chat.owner_id ? 'автор' : '';
                return '<div class="reaction-user" style="--i:' + i + '" data-uid="' + esc(id) + '">' +
                    '<img alt="" src="' + esc((p && p.avatar) || avatarFor(name, id)) + '">' +
                    '<b>' + esc(name) + '</b>' +
                    '<span class="muted small">' + esc(role) + '</span></div>';
            }).join('');
        });
    }

    /* -------------------------------------------------- модалки (без alert) */

    function promptBox(title, text, value, onOk) {
        var modal = $('prompt-modal');
        $('prompt-title').textContent = title;
        $('prompt-text').textContent = text || '';
        var input = $('prompt-input');
        input.value = value || '';
        modal.classList.add('show');
        setTimeout(function () { input.focus(); }, 60);

        function close() {
            modal.classList.remove('show');
            $('prompt-ok').onclick = null;
            $('prompt-cancel').onclick = null;
            input.onkeydown = null;
        }
        function ok() { var v = input.value; close(); onOk(v); }

        $('prompt-ok').onclick = ok;
        $('prompt-cancel').onclick = close;
        input.onkeydown = function (e) { if (e.key === 'Enter') ok(); if (e.key === 'Escape') close(); };
    }

    function confirmBox(title, text, okLabel, onOk) {
        var modal = $('confirm-modal');
        $('confirm-title').textContent = title;
        $('confirm-text').textContent = text || '';
        $('confirm-ok').textContent = okLabel || 'Продолжить';
        modal.classList.add('show');

        function close() {
            modal.classList.remove('show');
            $('confirm-ok').onclick = null;
            $('confirm-cancel').onclick = null;
        }
        $('confirm-ok').onclick = function () { close(); onOk(); };
        $('confirm-cancel').onclick = close;
    }

    function openPlus() { $('plus-menu').classList.add('show'); }
    function closePlus() { $('plus-menu').classList.remove('show'); }

    /* Закрывает верхнее открытое окно; возвращает true, если было что закрывать. */
    function closeTopModal() {
        var open = document.querySelectorAll('.modal-overlay.show, .lightbox.show');
        if (!open.length) return false;
        open[open.length - 1].classList.remove('show');
        return true;
    }

    /* ------------------------------------------------ настройки соединения */

    /* Показываем только названия каналов связи и их состояние: адреса серверов
       на экран не выводятся — ни свои, ни сохранённый пользователем. */
    function renderConnList() {
        var box = $('conn-list');
        if (!box) return;
        var now = Date.now();
        box.innerHTML = candidates().map(function (c) {
            var st = api.statuses[c.url] || '';
            var h = api.health[c.url] || {};
            var note;
            if (api.base === c.url) note = 'активен';
            else if (h.cooldownUntil > now) note = 'пауза ' + Math.ceil((h.cooldownUntil - now) / 1000) + ' с';
            else if (st === 'ok') note = 'доступен';
            else if (st === 'bad') note = 'не отвечает';
            else note = 'не проверялся';
            if (h.latency != null && st === 'ok') note += ' · ' + h.latency + ' мс';

            return '<div class="conn-row"><span class="dot ' + esc(st) + '"></span>' +
                '<div class="conn-body"><div class="conn-name">' + esc(c.label) + '</div>' +
                '<div class="conn-note">' + esc(note) + '</div></div></div>';
        }).join('');
    }

    function openConnection() {
        $('conn-custom').value = '';        // сохранённый адрес не показываем
        renderConnList();
        $('conn-modal').classList.add('show');
    }

    function saveConnection() {
        var val = $('conn-custom').value.trim().replace(/\/+$/, '');
        if (val) {
            if (!/^https?:\/\//i.test(val)) { toast('Адрес должен начинаться с https://'); return; }
            localStorage.setItem(LS.api, val);
            $('conn-custom').value = '';
        }
        // Пустое поле означает «просто проверить связь»: сохранённый адрес
        // убирается кнопкой «Сбросить», а не случайным нажатием.
        localStorage.removeItem(LS.apiActive);
        api.base = null;
        api.statuses = {};
        api.health = {};
        toast('Проверяем адреса…');
        resolveApi(true).then(function (base) {
            renderConnList();
            if (base) {
                toast('Соединение установлено');
                if (state.me) syncChats();
            } else {
                toast('Ни один адрес не отвечает');
            }
        });
    }

    function resetConnection() {
        localStorage.removeItem(LS.api);
        localStorage.removeItem(LS.apiActive);
        $('conn-custom').value = '';
        toast('Свой канал связи убран');
        api.base = null;
        api.statuses = {};
        api.health = {};
        resolveApi(true).then(renderConnList);
    }

    function reconnect() {
        api.base = null;
        api.statuses = {};
        api.health = {};
        toast('Переподключение…');
        return resolveApi(true).then(function (base) {
            if (base && state.me) { syncChats(); if (state.activeRoom) pollChat(true); }
            if (!base) toast('Сервер по-прежнему недоступен');
            return base;
        });
    }

    /* ------------------------------------------------------------ ввод текста */

    function autoGrow(el) {
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    }

    /* ==================================================================
       ЭКРАННАЯ КЛАВИАТУРА

       На телефонах клавиатура перекрывает нижнюю часть страницы. Замеряем её
       через visualViewport и поднимаем интерфейс ровно на эту высоту, чтобы
       поле ввода и кнопки всегда оставались видимыми.
       ================================================================== */

    /* Ручная подстановка высоты клавиатуры: нужна для проверки вёрстки на
       десктопе, где настоящей клавиатуры нет. */
    var applyKeyboardInset = function (px) {
        state.kbManual = px > 0;
        document.documentElement.style.setProperty('--kb', px + 'px');
        document.body.classList.toggle('keyboard-open', px > 0);
    };

    function setupKeyboard() {
        var vv = window.visualViewport;
        if (!vv) return;

        var lastHeight = 0;

        function apply() {
            if (state.kbManual) return;          // включён ручной режим отладки
            // высота, которую занимает клавиатура снизу окна
            var hidden = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
            var kb = hidden > 90 ? Math.round(hidden) : 0;   // мелкие расхождения — не клавиатура

            if (kb !== lastHeight) {
                lastHeight = kb;
                document.documentElement.style.setProperty('--kb', kb + 'px');
                document.body.classList.toggle('keyboard-open', kb > 0);

                // когда клавиатура открылась, показываем конец переписки
                if (kb > 0 && state.activeRoom) {
                    setTimeout(function () {
                        var box = $('msg-list');
                        if (box && isAtBottom()) box.scrollTop = box.scrollHeight;
                        updateScrollPill();
                    }, 60);
                }
            }
        }

        applyKeyboardInset = function (px) {
            state.kbManual = px > 0;
            lastHeight = px;
            document.documentElement.style.setProperty('--kb', px + 'px');
            document.body.classList.toggle('keyboard-open', px > 0);
        };

        vv.addEventListener('resize', apply);
        vv.addEventListener('scroll', apply);
        window.addEventListener('orientationchange', function () { setTimeout(apply, 250); });

        // при фокусе в поле ввода докручиваем список к последнему сообщению
        $('m-input').addEventListener('focus', function () {
            setTimeout(function () {
                var box = $('msg-list');
                if (box && isAtBottom()) box.scrollTop = box.scrollHeight;
            }, 220);
        });

        apply();
    }

    /* ==================================================================
       УВЕДОМЛЕНИЯ И УСТАНОВКА ПРИЛОЖЕНИЯ
       ================================================================== */

    function notifyEnabled() {
        return localStorage.getItem(LS.notify) === 'on' &&
            typeof Notification !== 'undefined' && Notification.permission === 'granted';
    }

    /* ==================================================================
       ЗВОНКИ

       Разговор идёт напрямую между устройствами (WebRTC), а база нужна
       только чтобы стороны договорились: через таблицу calls передаются
       предложение, ответ и сигнал завершения. Сами эти сигналы шифруются
       ключом чата, а звук WebRTC шифрует сам.

       Кандидаты сети не отправляются по одному: приложение дожидается, пока
       браузер их соберёт, и отправляет всё одним сообщением — так связь
       налаживается даже при неспешном опросе базы.
       ================================================================== */

    var CALL_POLL_MS = 2000;
    var CALL_GATHER_MS = 3000;
    var CALL_RING_MS = 45000;

    function callsSupported() {
        return !!(window.RTCPeerConnection && navigator.mediaDevices &&
            navigator.mediaDevices.getUserMedia);
    }

    function iceServers() {
        var list = (CFG.iceServers || []).slice();
        return list.length ? list : [{ urls: 'stun:stun.l.google.com:19302' }];
    }

    function callSignal(room, to, kind, payload) {
        var send = function (text) {
            return request('/calls', {
                method: 'POST',
                headers: { Prefer: 'return=representation' },
                body: {
                    room_id: room, from_id: state.me.id, to_id: to,
                    kind: kind, payload: text
                }
            }).then(function (rows) {
                return rows && rows[0] ? rows[0].id : null;
            }).catch(function () { return null; });
        };
        if (!payload) return send(null);
        return roomKey(room).then(function (key) {
            return key ? CR.encrypt(key, payload) : payload;
        }).catch(function () { return payload; }).then(send);
    }

    function readSignal(row) {
        var text = row.payload;
        if (!text || !CR || !CR.isEncrypted(text)) return Promise.resolve(text);
        return roomKey(row.room_id).then(function (key) {
            return key ? CR.decrypt(key, text) : null;
        }).catch(function () { return null; });
    }

    /* Ждём, пока браузер соберёт сетевые кандидаты, но не дольше отведённого. */
    function gathered(pc) {
        if (pc.iceGatheringState === 'complete') return Promise.resolve();
        return new Promise(function (resolve) {
            var done = false;
            var finish = function () {
                if (done) return;
                done = true;
                pc.removeEventListener('icegatheringstatechange', check);
                resolve();
            };
            var check = function () { if (pc.iceGatheringState === 'complete') finish(); };
            pc.addEventListener('icegatheringstatechange', check);
            setTimeout(finish, CALL_GATHER_MS);
        });
    }

    function showCall(on) {
        $('call-screen').hidden = !on;
        document.body.classList.toggle('in-call', !!on);
    }

    function setCallStatus(text) {
        $('call-status').textContent = text;
    }

    function callTick() {
        if (!state.call || !state.call.startedAt) return;
        setCallStatus(fmtDuration((Date.now() - state.call.startedAt) / 1000));
    }

    /* После разговора в переписке остаётся строчка: состоялся звонок или нет
       и сколько длился. Пишет её тот, кто звонил, — чтобы не было двух записей. */
    function logCall(call) {
        if (!call || !call.outgoing || call.logged) return;
        call.logged = true;

        var seconds = call.startedAt ? Math.round((Date.now() - call.startedAt) / 1000) : 0;
        var status = seconds ? 'done' : (call.declined ? 'declined' : 'missed');
        var text = 'wmcall:' + seconds + ':' + status;
        var preview = seconds ? '📞 Звонок · ' + fmtDuration(seconds)
            : (status === 'declined' ? '📞 Звонок отклонён' : '📞 Пропущенный звонок');

        roomKey(call.room).then(function (key) {
            if (!key) return { text: text, preview: preview };
            return Promise.all([CR.encrypt(key, text), CR.encrypt(key, preview)])
                .then(function (p) { return { text: p[0], preview: p[1] }; });
        }).then(function (payload) {
            var body = {
                room_id: call.room, user_id: state.me.id, user_name: state.me.name,
                text: payload.text, preview: payload.preview,
                reactions: {}, created_at: new Date().toISOString()
            };
            return request('/messages', { method: 'POST', body: body }).catch(function (err) {
                if (err.status !== 400) throw err;
                delete body.preview;
                return request('/messages', { method: 'POST', body: body });
            });
        }).then(function () {
            if (state.activeRoom === call.room) pollChat(false);
        }).catch(function () { /* запись о звонке не критична */ });
    }

    /* Пока идёт разговор, экран не должен гаснуть. */
    function keepAwake(on) {
        if (!navigator.wakeLock) return;
        if (on) {
            navigator.wakeLock.request('screen')
                .then(function (lock) { state.wakeLock = lock; })
                .catch(function () { /* не дали — не страшно */ });
        } else if (state.wakeLock) {
            try { state.wakeLock.release(); } catch (e) { /* уже отпущен */ }
            state.wakeLock = null;
        }
    }

    function endCall(reason, silent) {
        var call = state.call;
        state.call = null;
        clearInterval(state.callTimer);
        state.callTimer = null;
        clearTimeout(state.callRing);

        if (call) {
            if (!silent) callSignal(call.room, call.peerId, 'end', null);
            if (call.pc) { try { call.pc.close(); } catch (e) { /* уже закрыт */ } }
            if (call.stream) call.stream.getTracks().forEach(function (t) { t.stop(); });
        }
        $('call-audio').srcObject = null;
        showCall(false);
        keepAwake(false);
        if (call) logCall(call);
        if (reason) toast(reason);
    }

    function newPeer(call) {
        var pc = new RTCPeerConnection({ iceServers: iceServers() });
        call.pc = pc;

        pc.ontrack = function (e) {
            $('call-audio').srcObject = e.streams[0];
            $('call-audio').play().catch(function () { /* автозапуск запретили */ });
        };
        pc.onconnectionstatechange = function () {
            if (!state.call || state.call !== call) return;
            if (pc.connectionState === 'connected') {
                clearTimeout(state.callRing);
                call.startedAt = call.startedAt || Date.now();
                keepAwake(true);
                $('call-mute').hidden = false;
                $('call-accept').hidden = true;
                callTick();
                state.callTimer = setInterval(callTick, 1000);
            }
            if (pc.connectionState === 'failed') {
                endCall('Не удалось установить соединение');
            }
        };
        return pc;
    }

    function micStream() {
        return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }

    /* --------------------------------------------------------- исходящий */

    function startCall() {
        var chat = state.activeChat;
        if (!chat || chat.kind !== 'dm' || !callsSupported()) return;
        if (state.call) { toast('Звонок уже идёт'); return; }

        var peerId = (chat.members || []).filter(function (m) { return m !== state.me.id; })[0];
        if (!peerId) return;
        var profile = state.profiles[peerId] || {};

        var call = {
            room: chat.room_id, peerId: peerId,
            name: profile.name || chatDisplayName(chat),
            avatar: profile.avatar || chatAvatar(chat),
            outgoing: true, startedAt: null
        };
        state.call = call;

        $('call-name').textContent = call.name;
        $('call-av').src = call.avatar;
        $('call-accept').hidden = true;
        $('call-mute').hidden = true;
        setCallStatus('Вызов…');
        showCall(true);

        state.callRing = setTimeout(function () {
            if (state.call === call && !call.startedAt) endCall('Не отвечает');
        }, CALL_RING_MS);

        micStream().then(function (stream) {
            if (state.call !== call) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
            call.stream = stream;
            var pc = newPeer(call);
            stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
            return pc.createOffer()
                .then(function (offer) { return pc.setLocalDescription(offer); })
                .then(function () { return gathered(pc); })
                .then(function () {
                    if (state.call !== call) return null;
                    return callSignal(call.room, peerId, 'offer',
                        JSON.stringify(pc.localDescription))
                        .then(function (id) { if (id) pingCall(id); });
                });
        }).catch(function () {
            endCall('Нужен доступ к микрофону', true);
        });
    }

    /* --------------------------------------------------------- входящий */

    function incomingCall(row, sdp) {
        var chat = findChat(row.room_id);
        var profile = state.profiles[row.from_id] || {};
        var call = {
            room: row.room_id, peerId: row.from_id,
            name: profile.name || (chat ? chatDisplayName(chat) : 'Входящий звонок'),
            avatar: profile.avatar || (chat ? chatAvatar(chat) : avatarFor('?', row.from_id)),
            outgoing: false, offer: sdp, startedAt: null
        };
        state.call = call;

        $('call-name').textContent = call.name;
        $('call-av').src = call.avatar;
        $('call-accept').hidden = false;
        $('call-mute').hidden = true;
        setCallStatus('Входящий звонок');
        showCall(true);
        vibrate([25, 220, 25, 220, 25]);   // деликатный пунктир входящего звонка

        if (document.hidden) {
            showNotification(call.name, 'Входящий звонок', row.room_id, null);
        }

        state.callRing = setTimeout(function () {
            if (state.call === call && !call.startedAt) endCall('Пропущенный звонок');
        }, CALL_RING_MS);
    }

    function acceptCall() {
        var call = state.call;
        if (!call || call.outgoing || !call.offer) return;
        $('call-accept').hidden = true;
        setCallStatus('Соединяем…');

        micStream().then(function (stream) {
            if (state.call !== call) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
            call.stream = stream;
            var pc = newPeer(call);
            stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });

            return pc.setRemoteDescription(JSON.parse(call.offer))
                .then(function () { return pc.createAnswer(); })
                .then(function (answer) { return pc.setLocalDescription(answer); })
                .then(function () { return gathered(pc); })
                .then(function () {
                    if (state.call !== call) return null;
                    return callSignal(call.room, call.peerId, 'answer',
                        JSON.stringify(pc.localDescription));
                });
        }).catch(function () {
            endCall('Нужен доступ к микрофону');
        });
    }

    function toggleMute() {
        var call = state.call;
        if (!call || !call.stream) return;
        var tracks = call.stream.getAudioTracks();
        var on = tracks.length ? !tracks[0].enabled : false;
        tracks.forEach(function (t) { t.enabled = on; });
        $('call-mute').classList.toggle('off', !on);
        toast(on ? 'Микрофон включён' : 'Микрофон выключен');
    }

    /* ------------------------------------------------- приём сигналов */

    function handleSignal(row) {
        if (String(row.from_id) === String(state.me.id)) return Promise.resolve();

        if (row.kind === 'end') {
            if (state.call && state.call.peerId === row.from_id) {
                if (!state.call.startedAt) state.call.declined = true;
                endCall(state.call.startedAt ? 'Звонок завершён' : 'Звонок отклонён', true);
            }
            return Promise.resolve();
        }

        return readSignal(row).then(function (sdp) {
            if (!sdp) return null;

            if (row.kind === 'offer') {
                // Уже разговариваем — вежливо отказываем.
                if (state.call) return callSignal(row.room_id, row.from_id, 'end', null);
                if (!callsSupported()) return callSignal(row.room_id, row.from_id, 'end', null);
                incomingCall(row, sdp);
                return null;
            }

            if (row.kind === 'answer' && state.call && state.call.outgoing &&
                state.call.peerId === row.from_id && state.call.pc) {
                setCallStatus('Соединяем…');
                return state.call.pc.setRemoteDescription(JSON.parse(sdp));
            }
            return null;
        }).catch(function () { return null; });
    }

    function pollCalls() {
        if (!state.me || !state.callsReady) return Promise.resolve();

        return request('/calls?to_id=eq.' + q(state.me.id) +
            '&id=gt.' + q(state.lastCallId) + '&order=id.asc&limit=10')
            .then(function (rows) {
                if (!rows || !rows.length) return null;
                rows.forEach(function (r) {
                    state.lastCallId = Math.max(state.lastCallId, Number(r.id) || 0);
                });
                return rows.reduce(function (chain, row) {
                    return chain.then(function () { return handleSignal(row); });
                }, Promise.resolve());
            })
            .catch(function (err) {
                if (missingRelation(err)) state.callsReady = false;   // база без звонков
                return null;
            });
    }

    /* Стартовая точка: всё, что лежало в таблице раньше, звонком не считаем. */
    function setupCalls() {
        if (!state.me) return Promise.resolve();
        return request('/calls?to_id=eq.' + q(state.me.id) + '&select=id&order=id.desc&limit=1')
            .then(function (rows) {
                state.lastCallId = rows && rows.length ? Number(rows[0].id) : 0;
                state.callsReady = true;
                clearInterval(state.callPoll);
                state.callPoll = setInterval(function () {
                    if (!document.hidden || state.call) pollCalls();
                }, CALL_POLL_MS);
            })
            .catch(function () { state.callsReady = false; });
    }

    /* ------------------------------------------------------------------ звук

       Короткий мягкий сигнал из двух нот. Он собирается прямо в браузере,
       поэтому ничего не скачивается, а громкость заведомо небольшая. Между
       сигналами выдерживается пауза, чтобы поток сообщений не превратился
       в трель. */

    var audioCtx = null;
    var lastSound = 0;

    function soundEnabled() {
        var saved = localStorage.getItem(LS.sound);
        if (saved) return saved === 'on';
        return devicePlatform() === 'desktop';      // на компьютере — по умолчанию
    }

    function playChime() {
        if (Date.now() - lastSound < 2500) return;
        lastSound = Date.now();
        try {
            var Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            if (!audioCtx) audioCtx = new Ctx();
            if (audioCtx.state === 'suspended') audioCtx.resume();

            var now = audioCtx.currentTime + 0.01;
            [[880, 0], [1174.7, 0.1]].forEach(function (note) {
                var osc = audioCtx.createOscillator();
                var gain = audioCtx.createGain();
                var at = now + note[1];
                osc.type = 'sine';
                osc.frequency.value = note[0];
                gain.gain.setValueAtTime(0.0001, at);
                gain.gain.exponentialRampToValueAtTime(0.075, at + 0.025);
                gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                osc.start(at);
                osc.stop(at + 0.5);
            });
        } catch (e) { /* звук не критичен */ }
    }

    function updateSoundPill() {
        var pill = $('sound-state');
        if (!pill) return;
        var on = soundEnabled();
        pill.textContent = on ? 'вкл' : 'выкл';
        pill.className = 'pill ' + (on ? 'ok' : '');
    }

    function toggleSound() {
        var on = !soundEnabled();
        localStorage.setItem(LS.sound, on ? 'on' : 'off');
        updateSoundPill();
        if (on) playChime();
        toast(on ? 'Звук новых сообщений включён' : 'Звук выключен');
    }

    /* ------------------------------------ уведомления при закрытом приложении

       Браузер получает их не от приложения, а от службы доставки: приложению
       для этого нужен сервер, который умеет их рассылать. Такой сервер живёт
       рядом с прокси базы — по адресу /api/push. Если его нет, всё остальное
       работает по-прежнему, просто уведомления приходят только пока
       приложение запущено. */

    /* Серверные службы — уведомления, помощник WolffAI, поиск гифок — живут по
       адресу /api/<имя> на сервере приложения (Vercel).

       Сайт может лежать и отдельно от сервера: на GitHub Pages серверной части
       нет вовсе, там только файлы. Поэтому адрес сервера можно задать один раз —
       полем serverUrl в config.js или вручную в настройках, — и он проверяется
       первым; если он не задан, ищем рядом с адресом прокси базы и на домене
       самого сайта.

       Из любой записи адреса делаем «корень сервера»: и «мойпроект.vercel.app»,
       и «https://мойпроект.vercel.app/api/ai», и адрес прокси базы приводятся
       к одному виду — https://мойпроект.vercel.app. */
    function serverOrigin(raw) {
        var value = String(raw || '').trim();
        if (!value) return '';
        if (!/^https?:\/\//i.test(value)) {
            // «имя.vercel.app» — тоже адрес: дописываем https сами.
            if (/^[^\s/:?#]+\.[^\s/:?#]{2,}([/?#]|$)/.test(value)) value = 'https://' + value;
            else return '';
        }
        try {
            var u = new URL(value);
            return /^https?:$/.test(u.protocol) ? u.origin : '';
        } catch (e) { return ''; }
    }

    /* Адрес сервера, заданный человеком или в настройках сайта. Он главнее
       всего остального: раз указали — туда и идём. */
    function chosenServers() {
        var list = [];
        var add = function (raw) {
            var origin = serverOrigin(raw);
            if (origin && list.indexOf(origin) < 0) list.push(origin);
        };
        try { add(localStorage.getItem(LS.server)); } catch (e) { /* нет доступа */ }
        add(CFG.serverUrl);
        return list;
    }

    /* Где ещё имеет смысл поискать: на домене своего сервера базы и на самом
       сайте. Прямые адреса базы (Supabase и прокси) не трогаем — служб там
       не бывает, а лишние запросы только тянут время. */
    function otherOrigins() {
        var list = [];
        var chosen = chosenServers();
        var add = function (raw) {
            var origin = serverOrigin(raw);
            if (origin && chosen.indexOf(origin) < 0 && list.indexOf(origin) < 0) list.push(origin);
        };
        var own = function (base) { if (base && String(base).indexOf('/api/') > 0) add(base); };
        own(api.base);
        try { own(localStorage.getItem(LS.api)); } catch (e) { /* нет доступа */ }
        candidates().forEach(function (c) { own(c.url); });
        add(location.href);
        return list;
    }

    function serviceUrls(name) {
        var list = [];
        var add = function (url) { if (url && list.indexOf(url) < 0) list.push(url); };
        var custom = name === 'push' ? CFG.pushUrl : (name === 'ai' ? CFG.aiUrl : '');

        if (name === 'ai') {
            // Адрес, указанный вручную в старых версиях, проверяем первым.
            try { add((localStorage.getItem(LS.aiUrl) || '').replace(/\/+$/, '')); }
            catch (e) { /* нет доступа к хранилищу */ }
        }
        if (custom) add(String(custom).replace(/\/+$/, ''));

        chosenServers().forEach(function (origin) { add(origin + '/api/' + name); });

        // Прокси базы может лежать и в подпапке — тогда служба рядом с ним.
        var fromBase = function (base) {
            if (base && /\/api\/db\/?$/.test(base)) add(base.replace(/\/api\/db\/?$/, '/api/' + name));
        };
        fromBase(api.base);
        try { fromBase(localStorage.getItem(LS.api)); } catch (e) { /* нет доступа */ }
        candidates().forEach(function (c) { fromBase(c.url); });

        otherOrigins().forEach(function (origin) { add(origin + '/api/' + name); });
        add(new URL('api/' + name, location.href).href.replace(/\/+$/, ''));
        return list;
    }

    /* Адрес службы ищем один раз и запоминаем на время сессии.
       accept решает, годится ли ответ; результат null означает «службы нет».
       Заодно записываем, что и почему не подошло: это видно в настройках. */
    function findService(name, accept) {
        if (state.services[name] !== undefined) return Promise.resolve(state.services[name]);
        if (state.serviceTasks[name]) return state.serviceTasks[name];

        var urls = serviceUrls(name);
        var tried = [];
        state.serviceTried[name] = tried;

        var note = function (url, why) { tried.push({ url: url, why: why }); };
        var step = function (i) {
            if (i >= urls.length) return null;
            var url = urls[i];
            return fetchTimeout(url, { method: 'GET' }, 6000)
                .then(function (res) {
                    if (!res.ok) { note(url, 'ответ ' + res.status); return null; }
                    // Сайт без сервера отдаёт на этот адрес обычную страницу —
                    // такой ответ службой не считаем.
                    return res.json().catch(function () {
                        note(url, 'здесь не сервер');
                        return null;
                    });
                })
                .then(function (info) {
                    var value = info ? accept(info, url) : null;
                    if (info && !value) note(url, 'служба не настроена');
                    return value || step(i + 1);
                })
                .catch(function () {
                    note(url, 'нет ответа');
                    return step(i + 1);
                });
        };

        state.serviceTasks[name] = step(0).then(function (found) {
            state.services[name] = found || null;
            delete state.serviceTasks[name];
            // Нашли сервер — запоминаем его: в следующий раз найдутся сразу и
            // уведомления, и гифки, даже если сайт открыт с другого адреса.
            if (found && found.url) rememberServer(found.url);
            return state.services[name];
        });
        return state.serviceTasks[name];
    }

    /* Куда приложение ходит за серверными службами. Пустая строка — «не задан». */
    function currentServer() {
        try { return localStorage.getItem(LS.server) || ''; } catch (e) { return ''; }
    }

    function rememberServer(serviceUrl) {
        var origin = serverOrigin(serviceUrl);
        if (!origin || origin === serverOrigin(location.href)) return;
        try {
            if (localStorage.getItem(LS.server) !== origin) localStorage.setItem(LS.server, origin);
        } catch (e) { /* нет доступа к хранилищу */ }
    }

    /* Адрес сервера, указанный человеком. Одна запись включает сразу помощника,
       уведомления при закрытом приложении и гифки. */
    function setServer(raw) {
        var origin = serverOrigin(raw);
        if (!origin) return '';
        try {
            localStorage.setItem(LS.server, origin);
            localStorage.removeItem(LS.aiUrl);   // старая настройка больше не нужна
        } catch (e) { /* нет доступа к хранилищу */ }
        forgetServices();
        return origin;
    }

    function forgetServices() {
        ['ai', 'push', 'gif'].forEach(function (name) {
            delete state.services[name];
            delete state.serviceTasks[name];
            delete state.serviceTried[name];
        });
    }

    function findPushServer() {
        return findService('push', function (info, url) {
            return info.ok && info.vapid ? { url: url, vapid: info.vapid } : null;
        });
    }

    function findAiServer() {
        return findService('ai', function (info, url) {
            return info.ok ? { url: url } : null;
        });
    }

    function base64ToBytes(base64) {
        var padded = String(base64).replace(/-/g, '+').replace(/_/g, '/');
        while (padded.length % 4) padded += '=';
        var raw = atob(padded);
        var out = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }

    function subscriptionFields(sub) {
        var json = sub.toJSON ? sub.toJSON() : {};
        var keys = json.keys || {};
        return { endpoint: json.endpoint || sub.endpoint, p256dh: keys.p256dh || '', auth: keys.auth || '' };
    }

    /* Подписка на доставку: адрес браузера сохраняется в базе. */
    function enablePush() {
        if (!navigator.serviceWorker || typeof PushManager === 'undefined' || !state.me) {
            return Promise.resolve(false);
        }
        return findPushServer().then(function (server) {
            if (!server) return false;
            return navigator.serviceWorker.ready.then(function (reg) {
                return reg.pushManager.getSubscription().then(function (existing) {
                    if (existing) return existing;
                    return reg.pushManager.subscribe({
                        userVisibleOnly: true,
                        applicationServerKey: base64ToBytes(server.vapid)
                    });
                });
            }).then(function (sub) {
                var fields = subscriptionFields(sub);
                return rpc('wm_push_save', {
                    p_user: state.me.id,
                    p_endpoint: fields.endpoint,
                    p_p256dh: fields.p256dh,
                    p_auth: fields.auth
                }).then(function () { return true; });
            });
        }).catch(function () { return false; });
    }

    function disablePush() {
        if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return Promise.resolve();
        return navigator.serviceWorker.ready.then(function (reg) {
            return reg.pushManager.getSubscription();
        }).then(function (sub) {
            if (!sub) return null;
            var endpoint = subscriptionFields(sub).endpoint;
            return sub.unsubscribe().then(function () {
                return rpc('wm_push_drop', { p_endpoint: endpoint }).catch(function () { return null; });
            });
        }).catch(function () { return null; });
    }

    /* Уведомление о входящем звонке — чтобы телефон зазвонил и при закрытом
       приложении. Проверку «звонок настоящий» делает сама база. */
    function pingCall(callId) {
        if (state.services.push === null) return;
        findPushServer().then(function (server) {
            if (!server) return;
            fetchTimeout(server.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ call: callId })
            }, 8000).catch(function () { /* не критично */ });
        });
    }

    /* Просим сервер разослать уведомление о только что отправленном сообщении.
       Ответ не важен: если сервера нет, всё остальное работает как прежде. */
    function pingPush(msgId) {
        if (state.services.push === null) return;
        findPushServer().then(function (server) {
            if (!server) return;
            fetchTimeout(server.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ msg: msgId })
            }, 8000).catch(function () { /* уведомление — не критично */ });
        });
    }

    /* Состояние помощника видно в настройках: так сразу понятно, дошло ли
       приложение до сервера с ключом или ищет его не там. */
    function updateAiPill(force) {
        var pill = $('ai-state');
        if (!pill) return Promise.resolve(null);
        if (force) { delete state.services.ai; delete state.serviceTasks.ai; }

        pill.textContent = 'проверяем…';
        pill.className = 'pill';
        return findAiServer().then(function (server) {
            pill.textContent = server ? 'подключён' : 'не найден';
            pill.className = 'pill ' + (server ? 'ok' : 'bad');
            return server;
        });
    }

    /* Короткий отчёт о поиске: какие адреса проверили и что там оказалось. */
    function aiReport() {
        var tried = state.serviceTried.ai || [];
        if (!tried.length) return '';
        return tried.slice(0, 4).map(function (t) {
            var host = t.url;
            try { host = new URL(t.url).host; } catch (e) { /* оставим как есть */ }
            return '• ' + host + ' — ' + t.why;
        }).join('\n');
    }

    function askServerAddress() {
        promptBox('Адрес сервера',
            'Вставьте адрес вашего проекта на Vercel — например https://имя.vercel.app. ' +
            'Подойдёт и ссылка на /api/ai: приложение само возьмёт из неё нужное.',
            currentServer(), function (val) {
                var origin = setServer(val);
                if (!origin) { toast('Не похоже на адрес сайта'); return; }
                updateAiPill(true).then(function (found) {
                    if (!found) { toast('По этому адресу помощник не отвечает'); return; }
                    toast('WolffAI на связи');
                    // Тот же сервер умеет присылать уведомления и искать гифки.
                    if (notifyEnabled()) enablePush();
                    setupGifs();
                });
            });
    }

    function checkAi() {
        updateAiPill(true).then(function (server) {
            if (server) { toast('WolffAI на связи'); return; }
            var report = aiReport();
            confirmBox('WolffAI не найден',
                'Помощник живёт на вашем сервере — там же, где ключ Gemini. Похоже, ' +
                'приложение открыто с адреса, где сервера нет.' +
                (report ? '\n\nПроверили:\n' + report : '') +
                '\n\nУкажите адрес сервера один раз — заодно заработают уведомления ' +
                'при закрытом приложении и гифки.',
                'Указать адрес', askServerAddress);
        });
    }

    function updateNotifyPill() {
        var pill = $('notify-state');
        if (!pill) return;
        if (typeof Notification === 'undefined') {
            pill.textContent = 'недоступно';
            pill.className = 'pill';
            return;
        }
        if (Notification.permission === 'denied') {
            pill.textContent = 'запрещены';
            pill.className = 'pill bad';
            return;
        }
        var on = notifyEnabled();
        pill.textContent = on ? 'вкл' : 'выкл';
        pill.className = 'pill ' + (on ? 'ok' : '');
    }

    function toggleNotifications() {
        if (typeof Notification === 'undefined') {
            toast('Браузер не умеет показывать уведомления');
            return;
        }
        if (notifyEnabled()) {
            localStorage.setItem(LS.notify, 'off');
            updateNotifyPill();
            disablePush();
            toast('Уведомления выключены');
            return;
        }
        if (Notification.permission === 'denied') {
            toast('Разрешите уведомления в настройках браузера');
            return;
        }
        Notification.requestPermission().then(function (result) {
            if (result !== 'granted') {
                toast('Уведомления не разрешены');
                updateNotifyPill();
                return;
            }
            localStorage.setItem(LS.notify, 'on');
            updateNotifyPill();
            showNotification('WolffMsg', 'Уведомления работают', null, null);

            enablePush().then(function (background) {
                toast(background
                    ? 'Уведомления включены — приходят и при закрытом приложении'
                    : 'Уведомления включены');
            });
        });
    }

    function showNotification(title, body, room, msgId) {
        var options = {
            body: body || '',
            icon: 'assets/icon-192.png',
            badge: 'assets/badge-96.png',      // одноцветный значок строки состояния
            tag: room || 'wolffmsg',
            renotify: true,
            data: { room: room, msg: msgId }
        };
        var direct = function () {
            try { new Notification(title, options); } catch (e) { /* нельзя — молчим */ }
        };

        // Через service worker уведомления показываются и на Android, но если
        // он ещё не управляет страницей, ждать его нельзя: показываем сразу.
        if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
            direct();
            return;
        }

        var done = false;
        var timer = setTimeout(function () {
            if (!done) { done = true; direct(); }
        }, 500);

        navigator.serviceWorker.ready.then(function (reg) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            reg.showNotification(title, options);
        }).catch(function () {
            if (done) return;
            done = true;
            clearTimeout(timer);
            direct();
        });
    }

    /* Показываем уведомление о новых сообщениях в чатах, которые сейчас не
       открыты, и отмечаем счётчик на значке приложения. */
    function maybeNotify() {
        var badge = 0;
        state.chats.forEach(function (c) { badge += c.unread || 0; });
        try {
            if (navigator.setAppBadge) {
                if (badge > 0) navigator.setAppBadge(badge);
                else if (navigator.clearAppBadge) navigator.clearAppBadge();
            }
        } catch (e) { /* не поддерживается */ }

        var wantPush = notifyEnabled();
        var wantSound = soundEnabled();
        if (!wantPush && !wantSound) return;

        var seen = readJSON(LS.notified, {});
        var changed = false;

        state.chats.forEach(function (c) {
            if (!c.ts || !c.unread) return;
            if (prefFor(c.room_id).muted) return;
            if (state.activeRoom === c.room_id && !document.hidden) return;
            if (seen[c.room_id] && seen[c.room_id] >= c.ts) return;

            seen[c.room_id] = c.ts;
            changed = true;
            if (!wantPush) return;

            var body = c.preview || 'Новое сообщение';
            if (CR && CR.isEncrypted(body)) body = 'Новое сообщение';
            showNotification(chatDisplayName(findChat(c.room_id) || c) || c.title,
                body, c.room_id, c.lastId);
        });

        if (changed) {
            writeJSON(LS.notified, seen);
            if (wantSound) playChime();
        }
    }

    /* Переход из уведомления: открыть чат и показать нужное сообщение. */
    function openFromNotification(room, msgId) {
        if (!room || !state.me) return;
        var go = function () {
            openChat(room);
            if (msgId) setTimeout(function () { scrollToMessage(msgId); }, 1200);
        };
        if (findChat(room)) go();
        else syncChats().then(go);
    }

    function setupNotifications() {
        updateNotifyPill();
        updateSoundPill();

        if (navigator.serviceWorker) {
            navigator.serviceWorker.addEventListener('message', function (event) {
                var data = event.data || {};
                if (data.type === 'open-call') { pollCalls(); return; }
                if (data.type === 'open-chat') openFromNotification(data.room, data.msg);
            });
        }

        var params = new URLSearchParams(location.search);
        if (params.get('open')) {
            var room = params.get('open');
            var msg = params.get('msg');
            history.replaceState(null, '', location.pathname);
            setTimeout(function () { openFromNotification(room, msg); }, 600);
        }

        // Приложение открыли из уведомления о звонке — сразу ищем вызов.
        if (params.has('call')) {
            history.replaceState(null, '', location.pathname);
            setTimeout(function () { pollCalls(); }, 800);
        }
    }

    /* ---------------------------------------------------------- установка */

    var installPrompt = null;

    /* Инструкции по установке. Системный диалог есть не везде, поэтому для
       каждого вида устройств показываем понятные шаги, а вкладки позволяют
       посмотреть инструкцию и для чужого телефона. */

    var INSTALL_GUIDES = {
        android: {
            label: '🤖 Android',
            steps: [
                'Нажмите кнопку «Установить» ниже. Если её нет — откройте меню браузера (три точки справа вверху).',
                'Выберите пункт «Установить приложение» или «Добавить на главный экран».',
                'Подтвердите установку в появившемся окне.'
            ],
            note: 'Работает в Chrome, Яндекс.Браузере и других браузерах на его основе.'
        },
        ios: {
            label: '🍎 iPhone',
            steps: [
                'Откройте сайт именно в Safari — в других браузерах на iPhone установка недоступна.',
                'Нажмите кнопку «Поделиться» внизу экрана — квадрат со стрелкой вверх.',
                'Пролистайте список и выберите «На экран «Домой»».',
                'Нажмите «Добавить» справа вверху.'
            ],
            note: 'Иконка появится на домашнем экране, приложение откроется без адресной строки.'
        },
        desktop: {
            label: '💻 Компьютер',
            steps: [
                'Нажмите кнопку «Установить» ниже или значок установки в правой части адресной строки.',
                'Если значка нет — откройте меню браузера и выберите «Установить приложение».',
                'Приложение появится в списке программ и будет открываться отдельным окном.'
            ],
            note: 'Поддерживают Chrome, Edge и Яндекс.Браузер. В Firefox установка недоступна — сайт работает как обычная вкладка.'
        }
    };

    function devicePlatform() {
        var ua = navigator.userAgent;
        if (/iphone|ipad|ipod/i.test(ua)) return 'ios';
        if (/android/i.test(ua)) return 'android';
        return 'desktop';
    }

    function appInstalled() {
        return window.matchMedia('(display-mode: standalone)').matches ||
            navigator.standalone === true;
    }

    function setupInstall() {
        window.addEventListener('beforeinstallprompt', function (e) {
            e.preventDefault();
            installPrompt = e;
            if ($('install-modal').classList.contains('show')) renderInstall(state.installTab);
        });

        window.addEventListener('appinstalled', function () {
            installPrompt = null;
            $('install-modal').classList.remove('show');
            toast('Приложение установлено');
        });
    }

    function renderInstall(platform) {
        state.installTab = platform;
        var guide = INSTALL_GUIDES[platform] || INSTALL_GUIDES.desktop;

        $('install-tabs').innerHTML = Object.keys(INSTALL_GUIDES).map(function (key) {
            return '<button type="button" class="install-tab' + (key === platform ? ' active' : '') +
                '" data-platform="' + key + '">' + esc(INSTALL_GUIDES[key].label) + '</button>';
        }).join('');

        $('install-steps').innerHTML = guide.steps.map(function (s) {
            return '<li>' + esc(s) + '</li>';
        }).join('');

        $('install-note').textContent = appInstalled()
            ? 'Приложение уже установлено — вы открыли его с домашнего экрана.'
            : guide.note;

        // Системный диалог браузер отдаёт только своей платформе.
        var canPrompt = !!installPrompt && platform === devicePlatform();
        $('install-go').hidden = !canPrompt;
    }

    function openInstall() {
        renderInstall(devicePlatform());
        $('install-modal').classList.add('show');
    }

    /* -------------------------------------------------------------- запуск */

    function startApp() {
        showPage('main');
        updateProfileUI();
        renderThemes();
        state.chats = mergeChats([]);
        ensureSaved();
        ensureAi();
        mirrorPrefs();
        setupCalls();
        setupGifs();
        touchOnline();
        clearInterval(state.presenceTimer);
        state.presenceTimer = setInterval(function () {
            if (!document.hidden) touchOnline();
        }, ONLINE_MS);
        if (notifyEnabled()) enablePush();      // подписка могла устареть
        paintCachedChatList();
        renderChatList();
        syncChats();
        stopTimers();
        state.listTimer = setInterval(function () {
            if (!document.hidden && !state.activeRoom && state.page === 'main') syncChats();
        }, CFG.pollListMs);
    }

    function bindEvents() {
        $('auth-form').addEventListener('submit', handleAuth);
        $('auth-swap-btn').addEventListener('click', function () { setAuthMode(!state.registerMode); });

        $('btn-settings').addEventListener('click', function () {
            showPage('settings', true);
            renderThemes();
            updateAiPill(false);
            updateOnlinePill();
        });
        $('btn-plus').addEventListener('click', openPlus);
        $('chat-search').addEventListener('input', function (e) { openSearch(); runSearch(e.target.value); });
        $('chat-search').addEventListener('focus', openSearch);
        $('chat-search').addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
        });
        $('search-cancel').addEventListener('click', closeSearch);
        $('search-clear').addEventListener('click', function () {
            $('chat-search').value = '';
            runSearch('');
            $('chat-search').focus();
        });
        $('search-recent').addEventListener('click', function (e) {
            if (e.target.id === 'recent-clear') {
                localStorage.removeItem(LS.recent);
                renderRecent();
                return;
            }
            var chip = e.target.closest('[data-recent]');
            if (!chip) return;
            var term = chip.getAttribute('data-recent');
            $('chat-search').value = term;
            runSearch(term);
        });
        $('msg-results').addEventListener('click', function (e) {
            var row = e.target.closest('[data-goto-room]');
            if (!row) return;
            var room = row.getAttribute('data-goto-room');
            var msg = row.getAttribute('data-goto-msg');
            closeSearch();
            openChat(room);
            if (msg) setTimeout(function () { scrollToMessage(msg); }, 700);
        });

        $('ctx-close').addEventListener('click', resetSelection);
        $('ctx-pin').addEventListener('click', function () {
            var room = state.selectedRoom;
            if (!room) return;
            var pinned = !prefFor(room).pinned;
            setPref(room, { pinned: pinned });
            resetSelection();
            toast(pinned ? 'Закреплено' : 'Откреплено');
        });
        $('ctx-mute').addEventListener('click', function () {
            var room = state.selectedRoom;
            if (!room) return;
            var muted = !prefFor(room).muted;
            setPref(room, { muted: muted });
            resetSelection();
            toast(muted ? 'Уведомления выключены' : 'Уведомления включены');
        });
        $('ctx-delete').addEventListener('click', function () {
            var room = state.selectedRoom;
            if (!room) return;
            var special = findChat(room);
            if (isSaved(special) || isAi(special)) {
                resetSelection();
                toast(isAi(special)
                    ? 'Чат с WolffAI удалить нельзя — можно очистить историю внутри'
                    : '«Избранное» удалить нельзя — очистите историю внутри');
                return;
            }
            confirmBox('Удалить чат?', 'Чат и переписка будут удалены.', 'Удалить', function () {
                resetSelection();
                removeChat(room).then(function () { toast('Чат удалён'); });
            });
        });

        var list = $('chat-list');
        list.addEventListener('click', function (e) {
            var item = e.target.closest('.f-item');
            if (!item) return;
            if (longPressed) { longPressed = false; return; }
            if (state.selectedRoom) { resetSelection(); return; }
            openChat(item.getAttribute('data-room'));
        });
        ['mousedown', 'touchstart'].forEach(function (evt) {
            list.addEventListener(evt, function (e) {
                var item = e.target.closest('.f-item');
                if (item) startPress(item.getAttribute('data-room'));
            }, { passive: true });
        });
        ['mouseup', 'mouseleave', 'touchend', 'touchmove', 'touchcancel'].forEach(function (evt) {
            list.addEventListener(evt, endPress, { passive: true });
        });

        $('global-results').addEventListener('click', function (e) {
            var row = e.target.closest('.f-item');
            if (!row) return;
            var channel = row.getAttribute('data-channel');
            var user = row.getAttribute('data-user');
            if (channel) {
                previewChannel(channel);
            } else if (user) {
                closeSearch();
                startDialog(user);
            }
        });

        $('btn-back').addEventListener('click', closeChat);
        $('btn-call').addEventListener('click', startCall);
        $('call-accept').addEventListener('click', acceptCall);
        $('call-mute').addEventListener('click', toggleMute);
        $('call-hangup').addEventListener('click', function () { endCall(null); });
        $('btn-chat-menu').addEventListener('click', function (e) { e.stopPropagation(); toggleChatMenu(); });
        $('act-invite').addEventListener('click', inviteToChat);
        $('act-crypto').addEventListener('click', openCryptoModal);
        $('act-mute').addEventListener('click', toggleMuteActive);
        $('act-clear').addEventListener('click', clearHistory);
        $('act-leave').addEventListener('click', leaveChat);
        $('act-delete').addEventListener('click', deleteActiveChat);
        $('btn-join').addEventListener('click', function () { joinChannel(state.activeRoom); });

        $('btn-send').addEventListener('click', function () { sendMessage(); });
        $('btn-attach').addEventListener('click', function () { $('m-file').click(); });
        $('btn-gif').addEventListener('click', openGifs);
        $('gif-close').addEventListener('click', closeGifs);
        $('gif-search').addEventListener('input', function () { searchGifs(this.value.trim()); });
        $('gif-grid').addEventListener('click', function (e) {
            var item = e.target.closest('.gif-item');
            if (!item) return;
            sendGif(item.getAttribute('data-gif-url'),
                Number(item.getAttribute('data-w')), Number(item.getAttribute('data-h')));
        });
        $('m-file').addEventListener('change', function () { handlePhotoFile(this); });
        $('m-input').addEventListener('input', function () { autoGrow(this); updateComposer(); });
        bindVoiceButton();
        $('m-input').addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        });

        $('msg-list').addEventListener('click', function (e) {
            if (e.target.getAttribute && e.target.getAttribute('data-photo')) {
                $('lightbox-img').src = e.target.getAttribute('src');
                $('lightbox').classList.add('show');
                return;
            }

            var video = e.target.closest('.video');
            if (video) {
                e.stopPropagation();
                openVideo(video);
                return;
            }

            var voice = e.target.closest('.voice');
            if (voice) {
                e.stopPropagation();
                playVoice(voice);
                return;
            }

            var author = e.target.closest('.author');
            if (author) {
                e.stopPropagation();
                openProfile(author.getAttribute('data-author'));
                return;
            }

            var post = e.target.closest('[data-comments]');
            if (post) {
                e.stopPropagation();
                openComments(post.getAttribute('data-comments'));
                return;
            }

            var quote = e.target.closest('.quote');
            if (quote) {
                e.stopPropagation();
                scrollToMessage(quote.getAttribute('data-goto'));
                return;
            }

            // Нажатие на плашку ставит такую же реакцию или снимает свою.
            // Список отреагировавших открывается из меню сообщения.
            var badge = e.target.closest('.reaction-badge');
            if (badge) {
                e.stopPropagation();
                setReaction(badge.getAttribute('data-react'), badge.getAttribute('data-emoji'));
                return;
            }
        });

        bindMessageGestures();

        $('msg-list').addEventListener('scroll', updateScrollPill, { passive: true });
        $('scroll-pill').addEventListener('click', jumpToBottom);
        $('reply-cancel').addEventListener('click', clearReply);
        $('chat-head').addEventListener('click', openChatInfo);

        $('reactions-list').addEventListener('click', function (e) {
            var row = e.target.closest('.reaction-user');
            if (!row) return;
            $('reactions-modal').classList.remove('show');
            openProfile(row.getAttribute('data-uid'));
        });
        $('reactions-close').addEventListener('click', function () {
            $('reactions-modal').classList.remove('show');
        });
        $('reactions-modal').addEventListener('click', function (e) {
            if (e.target === this) this.classList.remove('show');
        });
        $('pf-close').addEventListener('click', function () { $('profile-modal').classList.remove('show'); });
        $('profile-modal').addEventListener('click', function (e) {
            if (e.target === this) this.classList.remove('show');
        });
        $('set-profile').addEventListener('click', function () { openProfile(state.me.id); });

        $('lightbox').addEventListener('click', function (e) {
            if (e.target && e.target.id === 'lightbox-video') return;   // не мешаем управлять
            closeLightbox();
        });

        $('btn-settings-done').addEventListener('click', function () { showPage('main'); });
        $('theme-scroll').addEventListener('click', function (e) {
            var card = e.target.closest('.theme-card');
            if (card) setTheme(card.getAttribute('data-theme'));
        });
        $('s-av').addEventListener('click', function () { $('s-file').click(); });
        $('s-file').addEventListener('change', function () { handleAvatarFile(this); });
        $('set-name').addEventListener('click', changeName);
        $('set-pass').addEventListener('click', changePass);
        $('set-conn').addEventListener('click', openConnection);
        $('set-motion').addEventListener('click', function () {
            var off = localStorage.getItem(LS.motion) === 'off';
            localStorage.setItem(LS.motion, off ? 'on' : 'off');
            applyMotion();
        });
        $('set-cache').addEventListener('click', function () {
            confirmBox('Очистить локальные данные?', 'Список чатов будет заново загружен с сервера. ' +
                'Коды шифрования сохранятся.', 'Очистить', function () {
                localStorage.removeItem(LS.chats);
                localStorage.removeItem(LS.prefs);
                localStorage.removeItem(LS.cacheChats);
                try {
                    Object.keys(localStorage).forEach(function (k) {
                        if (k.indexOf(LS.cacheMsgs) === 0) localStorage.removeItem(k);
                    });
                } catch (e) { /* no-op */ }
                location.reload();
            });
        });
        $('set-notify').addEventListener('click', toggleNotifications);
        $('set-sound').addEventListener('click', toggleSound);
        $('set-ai').addEventListener('click', checkAi);
        $('set-online').addEventListener('click', toggleOnline);
        $('set-install').addEventListener('click', openInstall);
        $('install-tabs').addEventListener('click', function (e) {
            var tab = e.target.closest('[data-platform]');
            if (tab) renderInstall(tab.getAttribute('data-platform'));
        });
        $('install-go').addEventListener('click', function () {
            if (!installPrompt) return;
            $('install-modal').classList.remove('show');
            installPrompt.prompt();
            installPrompt = null;
        });
        $('install-close').addEventListener('click', function () {
            $('install-modal').classList.remove('show');
        });
        $('install-modal').addEventListener('click', function (e) {
            if (e.target === this) this.classList.remove('show');
        });
        $('set-logout').addEventListener('click', logout);
        $('set-delete').addEventListener('click', deleteAccount);

        $('plus-saved').addEventListener('click', openSaved);
        $('plus-user').addEventListener('click', function () { addUser(); });
        $('plus-group').addEventListener('click', createGroup);
        $('plus-channel').addEventListener('click', openChannelModal);
        $('plus-cancel').addEventListener('click', closePlus);
        $('plus-menu').addEventListener('click', function (e) { if (e.target === this) closePlus(); });

        $('ch-create').addEventListener('click', createChannel);
        $('ch-cancel').addEventListener('click', function () { $('channel-modal').classList.remove('show'); });
        $('channel-modal').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('show'); });

        $('crypto-off').addEventListener('click', disableCrypto);
        $('crypto-close').addEventListener('click', function () { $('crypto-modal').classList.remove('show'); });
        $('crypto-modal').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('show'); });

        $('conn-save').addEventListener('click', saveConnection);
        $('conn-check').addEventListener('click', function () {
            toast('Проверяем связь…');
            reconnect().then(renderConnList);
        });
        $('conn-reset').addEventListener('click', resetConnection);
        $('conn-close').addEventListener('click', function () { $('conn-modal').classList.remove('show'); });
        $('conn-modal').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('show'); });

        $('net-retry').addEventListener('click', reconnect);
        $('net-setup').addEventListener('click', openConnection);

        // Esc закрывает то, что открыто последним: сначала окно, потом поиск.
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (closeTopModal()) return;
            if (state.pickerOpen) { closePicker(); return; }
            if (state.searchMode) { closeSearch(); return; }
            if (state.page === 'chat') closeChat();
        });

        document.addEventListener('visibilitychange', function () {
            if (document.hidden || !state.me) return;
            if (state.activeRoom) pollChat(false);
            else if (state.page === 'main') syncChats();
        });

        window.addEventListener('online', reconnect);
        window.addEventListener('offline', function () { setNetState(false, 'Устройство не в сети'); });
    }

    /* Адрес сервера из ссылки. Чужой адрес принимаем только с явного согласия:
       иначе достаточно было бы прислать ссылку, чтобы увести переписку и пароль
       на посторонний сервер. */
    function applyApiFromLink(raw) {
        var value = String(raw).replace(/\/+$/, '');
        var host;
        try { host = new URL(value, location.href).host; } catch (e) { return; }

        var save = function () {
            localStorage.setItem(LS.api, value);
            localStorage.removeItem(LS.apiActive);
            api.base = null;
            api.statuses = {};
            api.health = {};
        };

        if (host === location.host) { save(); return; }
        confirmBox('Сменить сервер?', 'Ссылка предлагает отправлять ваши сообщения и пароль ' +
            'на сервер ' + host + '. Соглашайтесь, только если это ваш собственный сервер.',
        'Разрешить', function () { save(); reconnect(); });
    }

    function init() {
        var params = new URLSearchParams(location.search);
        var fromLink = params.get('api');
        if (fromLink) history.replaceState(null, '', location.pathname + location.hash);

        setTheme(localStorage.getItem(LS.theme) || 'dark');
        applyMotion();
        bindEvents();
        setupKeyboard();
        setupInstall();
        setupNotifications();
        setAuthMode(false);

        state.me = normalizeUser(readJSON(LS.user, null));
        loadIdentity();
        if (state.me && state.me.id) startApp();
        else showPage('auth');

        if (fromLink) applyApiFromLink(fromLink);

        resolveApi(false).then(function (base) {
            if (base && state.me) syncChats();
        });

        // Ярлык «Написать» из меню приложения открывает выбор собеседника.
        if (params.get('action') === 'new' && state.me) setTimeout(openPlus, 300);

        if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
            navigator.serviceWorker.register('sw.js').catch(function () { /* не критично */ });
        }
    }

    window.WM = {
        simulateKeyboard: function (px) { applyKeyboardInset(px || 0); },
        openFromNotification: function (room, msg) { openFromNotification(room, msg); },
        reconnect: reconnect,
        openConnection: openConnection,
        findPushServer: findPushServer,
        findAiServer: findAiServer,
        serviceUrls: serviceUrls,
        setServer: setServer,
        currentServer: currentServer,
        setTheme: setTheme,
        state: state,
        api: api,
        rpc: rpc
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
