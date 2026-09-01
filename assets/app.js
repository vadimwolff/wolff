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
        code: 'WM_CODE_'
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
        keys: {},               // room_id -> CryptoKey
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
        globalResults: null,
        listSig: '',
        globalSig: '',
        listTimer: null,
        chatTimer: null,
        searchTimer: null,
        busy: false,
        firstChatPaint: true,
        serverChats: true,
        hasPreviews: true,
        hasSearch: true,
        hasReplies: true
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

    function vibrate(ms) {
        if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) { /* no-op */ } }
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

    function isImage(text) { return typeof text === 'string' && text.indexOf('data:image/') === 0; }

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

    var api = { base: null, probing: null, statuses: {} };

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
        if (custom) list.push({ url: custom.replace(/\/+$/, ''), label: 'Ваш адрес', custom: true });
        CFG.endpoints.forEach(function (e) {
            var url = endpointUrl(e.url);
            if (!list.some(function (x) { return x.url === url; })) list.push({ url: url, label: e.label });
        });
        return list;
    }

    function headers(extra) {
        var h = {
            'apikey': CFG.apiKey,
            'Authorization': 'Bearer ' + CFG.apiKey,
            'Content-Type': 'application/json'
        };
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
        return fetchTimeout(url + '/profiles?select=id&limit=1', { headers: headers(), cache: 'no-store' }, 7000)
            .then(function (r) {
                var ct = r.headers.get('content-type') || '';
                if (r.ok) return true;
                return r.status >= 400 && r.status < 500 && ct.indexOf('json') >= 0;
            })
            .catch(function () { return false; });
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

        var list = candidates();
        var cached = localStorage.getItem(LS.apiActive);
        if (cached && !force) {
            var idx = list.findIndex(function (x) { return x.url === cached; });
            if (idx > 0) list.unshift(list.splice(idx, 1)[0]);
        }

        api.probing = new Promise(function (resolve) {
            var results = new Array(list.length).fill(null);   // null | true | false
            var settled = false;

            function check() {
                if (settled) return;
                for (var i = 0; i < list.length; i++) {
                    if (results[i] === null) return;            // более приоритетный ещё думает
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
                    api.statuses[item.url] = ok ? 'ok' : 'bad';
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

    function request(path, opts) {
        opts = opts || {};
        var attempt = 0;

        function run() {
            return resolveApi(attempt > 0).then(function (base) {
                if (!base) throw WMError('Нет соединения', 0);
                return fetchTimeout(base + path, {
                    method: opts.method || 'GET',
                    headers: headers(opts.headers),
                    body: opts.body ? JSON.stringify(opts.body) : undefined,
                    cache: 'no-store'
                }, opts.timeout || 20000).then(function (res) {
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
                });
            }).catch(function (err) {
                var networkish = !err.status;
                if (networkish && attempt === 0) {
                    attempt++;
                    api.base = null;                    // сеть изменилась — ищем другой адрес
                    return run();
                }
                if (networkish) setNetState(false, 'Нет связи с сервером');
                throw err;
            });
        }

        return run();
    }

    function rpc(name, args) {
        return request('/rpc/' + name, { method: 'POST', body: args });
    }

    function q(v) { return encodeURIComponent(v); }

    /* ------------------------------------------------------ шифрование чата */

    function storedCode(room) {
        try { return localStorage.getItem(LS.code + room) || ''; } catch (e) { return ''; }
    }

    function roomKey(room) {
        if (!room || !CR || !CR.available()) return Promise.resolve(null);
        if (state.keys[room] !== undefined) return Promise.resolve(state.keys[room]);
        var code = storedCode(room);
        if (!code) { state.keys[room] = null; return Promise.resolve(null); }
        return CR.deriveKey(code, room).then(function (key) {
            state.keys[room] = key;
            return key;
        }).catch(function () {
            state.keys[room] = null;
            return null;
        });
    }

    function setRoomCode(room, code) {
        try {
            if (code) localStorage.setItem(LS.code + room, code);
            else localStorage.removeItem(LS.code + room);
        } catch (e) { /* no-op */ }
        delete state.keys[room];
        try { localStorage.removeItem(LS.cacheMsgs + room); } catch (e) { /* no-op */ }
    }

    /* Расшифровывает тело сообщения и цитату один раз, результат кэшируется. */
    function decodeMessage(m, key) {
        if (m.body !== undefined) return Promise.resolve(m);

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

        return quote.then(function () {
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

    window.addEventListener('popstate', function () {
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
        if (pass.length < 4) { $('auth-status').textContent = 'Пароль от 4 символов'; return; }

        state.busy = true;
        $('auth-btn').disabled = true;
        $('auth-btn').classList.add('loading');
        $('auth-status').textContent = state.registerMode ? 'Создаём аккаунт…' : 'Проверяем данные…';

        var task = state.registerMode ? doRegister(nick, pass, name || nick) : doLogin(nick, pass);

        task.then(function (user) {
            state.me = normalizeUser(user);
            writeJSON(LS.user, state.me);
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

    function doRegister(nick, pass, name) {
        return rpcRegister(nick, pass, name).catch(function (err) {
            if (!missingRelation(err)) throw err;
            return legacyRegister(nick, pass, name).catch(function (legacyErr) {
                if (!accessDenied(legacyErr)) throw legacyErr;
                return delay(1500)
                    .then(function () { return rpcRegister(nick, pass, name); })
                    .catch(function (retryErr) {
                        throw missingRelation(retryErr) ? schemaHint() : retryErr;
                    });
            });
        });
    }

    function rpcRegister(nick, pass, name) {
        return rpc('wm_register', { p_nickname: nick, p_password: pass, p_name: name })
            .then(function (res) {
                if (res && res.ok) return res.user;
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
                if (res && res.length) return res[0];
                return { id: id, nickname: nick, name: name, avatar: '' };
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
            if (res && res.ok) return res.user;
            throw WMError('Неверный никнейм или пароль');
        });
    }

    function legacyLogin(nick, pass) {
        return request('/profiles?nickname=eq.' + q(nick) + '&password=eq.' + q(pass) + '&limit=1')
            .then(function (rows) {
                if (rows && rows.length) return rows[0];
                throw WMError('Неверный никнейм или пароль');
            });
    }

    function logout() {
        confirmBox('Выйти из аккаунта?', 'Локальные данные на этом устройстве будут удалены, ' +
            'включая коды шифрования чатов.', 'Выйти', function () {
            stopTimers();
            try {
                Object.keys(localStorage).forEach(function (k) {
                    if (k.indexOf('WM_') === 0 && k !== LS.theme && k !== LS.api) localStorage.removeItem(k);
                });
            } catch (e) { /* no-op */ }
            location.reload();
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
                        location.reload();
                    })
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
        var meta = document.querySelector('meta[name=theme-color]');
        var theme = THEMES.filter(function (t) { return t.id === id; })[0];
        if (meta && theme) meta.setAttribute('content', theme.bg);
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

    function changePass() {
        promptBox('Смена пароля', 'Введите текущий пароль', '', function (oldPass) {
            if (!oldPass) return;
            promptBox('Смена пароля', 'Новый пароль, минимум 4 символа', '', function (val) {
                var pass = val.trim();
                if (pass.length < 4) { toast('Слишком короткий пароль'); return; }

                rpc('wm_set_password', {
                    p_nickname: state.me.nickname,
                    p_old_password: oldPass,
                    p_new_password: pass
                }).then(function (res) {
                    if (res && res.ok) return true;
                    throw WMError(res && res.error === 'weak_password'
                        ? 'Слишком короткий пароль' : 'Текущий пароль неверен');
                }).catch(function (err) {
                    if (!missingRelation(err)) throw err;
                    return request('/profiles?nickname=eq.' + q(state.me.nickname) +
                        '&password=eq.' + q(oldPass) + '&select=id&limit=1')
                        .then(function (rows) {
                            if (!rows || !rows.length) throw WMError('Текущий пароль неверен');
                            return request('/profiles?id=eq.' + q(state.me.id),
                                { method: 'PATCH', body: { password: pass } });
                        });
                }).then(function () { toast('Пароль изменён'); })
                    .catch(function (e) { toast(e.message || 'Не удалось изменить пароль'); });
            });
        });
    }

    /* ----------------------------------------------------------- изображения */

    function shrinkImage(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onerror = function () { reject(WMError('Не удалось прочитать файл')); };
            reader.onload = function (e) {
                var img = new Image();
                img.onerror = function () { reject(WMError('Не удалось открыть изображение')); };
                img.onload = function () {
                    var max = CFG.imageMaxSide;
                    var scale = Math.min(1, max / Math.max(img.width, img.height));
                    var w = Math.max(1, Math.round(img.width * scale));
                    var h = Math.max(1, Math.round(img.height * scale));
                    var canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                    try {
                        resolve(canvas.toDataURL('image/jpeg', CFG.imageQuality));
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

    function handlePhotoFile(input) {
        var file = input.files && input.files[0];
        input.value = '';
        if (!file || !state.activeRoom) return;
        shrinkImage(file).then(function (data) { sendMessage(data); })
            .catch(function (e) { toast(e.message || 'Не удалось отправить фото'); });
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

    function chatDisplayName(chat) {
        if (chat.kind === 'channel') return chat.name || ('@' + (chat.slug || 'канал'));
        if (chat.kind === 'group') return chat.name || 'Группа';
        var other = (chat.members || []).filter(function (m) { return m !== state.me.id; })[0];
        var p = other && state.profiles[other];
        if (p) return p.name || ('@' + p.nickname);
        return chat.name || 'Чат';
    }

    function chatAvatar(chat) {
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
                kind: c.kind || (String(c.room).indexOf('group_') === 0 ? 'group' : 'dm'),
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
        writeJSON(LS.chats, state.chats.map(function (c) {
            return {
                room: c.room_id, name: c.name, kind: c.kind, members: c.members,
                slug: c.slug, owner_id: c.owner_id, subscribers: c.subscribers
            };
        }));
    }

    function loadProfiles(ids) {
        var need = ids.filter(function (id) { return id && !state.profiles[id]; });
        if (!need.length) return Promise.resolve();
        return request('/profiles?id=in.(' + need.map(q).join(',') + ')&select=id,nickname,name,avatar')
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
            ? request('/chat_previews?room_id=' + q(inList) + '&select=room_id,user_id,user_name,preview,created_at')
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
                if (!state.hasPreviews && last[c.room_id]) c.ts = last[c.room_id].created_at;
            });
        }).catch(function (err) {
            if (err.status) throw err;
        });
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
                encrypted: !!storedCode(c.room_id)
            };
        }).filter(function (c) {
            return !term || c.title.toLowerCase().indexOf(term) >= 0;
        });

        list.sort(function (a, b) {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            return String(b.ts || '').localeCompare(String(a.ts || ''));
        });
        return list;
    }

    function chatRowHtml(c) {
        var preview = c.preview;
        if (!preview) preview = c.kind === 'channel' ? 'Канал' : 'Нажмите, чтобы открыть';
        else if (isImage(preview)) preview = '📷 Фото';
        else if (CR && CR.isEncrypted(preview)) preview = '🔒 Зашифрованное сообщение';

        var icon = c.kind === 'channel' ? ' 📣' : (c.kind === 'group' ? ' 👥' : '');
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
            var term = state.search.trim();
            box.innerHTML = '<div class="empty-state"><div class="ico">' + (term ? '🔍' : '💬') + '</div>' +
                '<b>' + (term ? 'Среди ваших чатов ничего нет' : 'Чатов пока нет') + '</b>' +
                '<p>' + (term ? 'Посмотрите результаты глобального поиска ниже'
                    : 'Нажмите «＋» вверху, чтобы написать человеку,<br>создать группу или свой канал') + '</p></div>';
            return;
        }

        box.innerHTML = list.map(chatRowHtml).join('');
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

    function runSearch(value) {
        state.search = value;
        renderChatList();
        clearTimeout(state.searchTimer);
        var term = value.trim().replace(/^@+/, '');
        if (term.length < 2) {
            state.globalResults = null;
            renderGlobal();
            return;
        }
        state.searchTimer = setTimeout(function () { globalSearch(term); }, 280);
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
            html += '<div class="section-title">Пользователи</div>';
            html += res.users.map(function (u) {
                return '<div class="f-item" data-user="' + esc(u.nickname) + '">' +
                    '<img class="chat-av" alt="" src="' + esc(u.avatar || avatarFor(u.name, u.id)) + '">' +
                    '<div class="chat-info"><b>' + esc(u.name || u.nickname) + '</b>' +
                    '<small>@' + esc(u.nickname) + '</small></div>' +
                    '<span class="row-action">Написать</span></div>';
            }).join('');
        }

        if (!html) {
            html = '<div class="empty-state small-state"><div class="ico">🔍</div>' +
                '<b>Ничего не найдено</b><p>Проверьте написание запроса</p></div>';
        }

        box.innerHTML = '<div class="section-title top">Глобальный поиск</div>' + html;
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

        return request('/profiles?nickname=eq.' + q(nick) + '&select=id,nickname,name,avatar&limit=1')
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
                $('chat-search').value = '';
                runSearch('');
                openChat(room);
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
            request('/profiles?nickname=eq.' + q(nick) + '&select=id,nickname,name,avatar&limit=1')
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
                            toast('Участник добавлен');
                        });
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
            vibrate(45);
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
        return state.chats.filter(function (c) { return c.room_id === room; })[0] || null;
    }

    function isMember(chat) {
        return !chat || (chat.members || []).indexOf(state.me.id) >= 0;
    }

    function canPost(chat) {
        if (!chat) return false;
        if (chat.kind !== 'channel') return true;
        return !chat.owner_id || chat.owner_id === state.me.id;
    }

    function updateChatHeader() {
        var chat = state.activeChat;
        if (!chat) return;

        $('chat-title').childNodes[0].nodeValue = chatDisplayName(chat) + ' ';
        $('chat-lock').hidden = !storedCode(chat.room_id);

        var sub = '';
        if (chat.kind === 'channel') {
            sub = plural(chat.subscribers || (chat.members || []).length,
                'подписчик', 'подписчика', 'подписчиков');
            if (chat.slug) sub = '@' + chat.slug + ' · ' + sub;
        } else if (chat.kind === 'group') {
            sub = plural((chat.members || []).length, 'участник', 'участника', 'участников');
        } else {
            var other = (chat.members || []).filter(function (m) { return m !== state.me.id; })[0];
            var p = other && state.profiles[other];
            if (p) sub = '@' + p.nickname;
        }
        if (prefFor(chat.room_id).muted) sub += (sub ? ' · ' : '') + '🔇';
        $('chat-subtitle').textContent = sub;

        $('act-invite').hidden = chat.kind !== 'group';
        $('act-leave').hidden = chat.kind === 'dm';
        $('act-delete').hidden = chat.kind === 'channel' && chat.owner_id !== state.me.id;
        $('act-clear').hidden = !canPost(chat);
        $('act-crypto').hidden = chat.kind === 'channel';

        var member = isMember(chat);
        var post = canPost(chat) && member;
        $('input-bar').hidden = !post;
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
        state.activeRoom = room;
        state.activeChat = chat;
        state.msgs = [];
        state.pickerOpen = null;
        state.pendingRender = false;
        state.firstChatPaint = true;
        state.newCount = 0;
        state.unreadFrom = myLastRead(room);
        clearReply();
        updateScrollPill();

        $('msg-list').innerHTML = skeletonHtml();
        updateChatHeader();
        showPage('chat', true);
        $('m-input').value = '';
        $('m-input').placeholder = storedCode(room) ? 'Зашифрованное сообщение…' : 'Сообщение...';
        autoGrow($('m-input'));

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
                    text: text, reactions: m.reactions, created_at: m.created_at
                };
            });
        writeJSON(LS.cacheMsgs + room, slim);
    }

    function closeChat() {
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
        stopChatTimer();
        if (state.listTimer) { clearInterval(state.listTimer); state.listTimer = null; }
    }

    function lastCreatedAt() {
        var real = state.msgs.filter(function (m) { return !m.pending && !m.cached; });
        return real.length ? real[real.length - 1].created_at : null;
    }

    function pollChat(initial) {
        var room = state.activeRoom;
        if (!room) return Promise.resolve();

        var base = 'id,room_id,user_id,user_name,text,reactions,created_at';
        var fields = state.hasReplies ? base + ',reply_to,reply_name,reply_preview' : base;
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
            return decodeAll(state.msgs, room).then(function () {
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

    function statusClass(m) {
        if (m.pending) return 'status-sent';
        if (m.failed) return 'status-failed';
        var read = othersLastRead(state.activeRoom);
        if (read && String(m.created_at) <= read) return 'status-read';
        return 'status-delivered';
    }

    var CHECK_SVG = '<svg class="check-svg" viewBox="0 0 20 14">' +
        '<path class="check-path first" d="M2 8.2 L6 12 L13 3"/>' +
        '<path class="check-path second" d="M8 8.6 L11.4 12 L18 3"/></svg>';

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
            m.replyBody === undefined ? (m.reply_preview || '') : m.replyBody
        ].join('\u0001');
    }

    function bubbleInner(m, isGroup) {
        var out = m.user_id === state.me.id;
        var body = m.body === undefined ? m.text : m.body;

        var content;
        if (m.locked) {
            content = '<span class="locked">' + esc(body) + '</span>';
        } else if (isImage(body)) {
            content = '<img class="photo" src="' + esc(body) + '" alt="фото" data-photo="1">';
        } else {
            content = esc(body).replace(/\n/g, '<br>');
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

        return author + quote + '<div class="text">' + content + '</div>' + rHtml +
            '<div class="bubble-meta">' + esc(fmtTime(m.created_at)) +
            (out ? '<span class="status-icon ' + statusClass(m) + '">' + CHECK_SVG + '</span>' : '') +
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
        var isGroup = state.activeChat &&
            (state.activeChat.kind === 'group' || state.activeChat.kind === 'channel');

        var desired = [];
        var lastDay = '';
        var unreadShown = false;
        state.msgs.forEach(function (m) {
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
        if (scrollToEnd || wasAtBottom) {
            box.scrollTop = box.scrollHeight;
            state.newCount = 0;
        }
        updateScrollPill();
    }

    function isAtBottom() {
        var box = $('msg-list');
        return box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    }

    function updateScrollPill() {
        var pill = $('scroll-pill');
        if (!pill) return;
        var show = state.activeRoom && !isAtBottom();
        pill.hidden = !show;
        $('scroll-count').textContent = state.newCount > 0 ? String(state.newCount) : '';
        if (!show) state.newCount = 0;
    }

    function jumpToBottom() {
        var box = $('msg-list');
        box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
        state.newCount = 0;
        updateScrollPill();
    }

    function sendMessage(textOverride) {
        var input = $('m-input');
        var text = textOverride !== undefined ? textOverride : input.value.trim();
        if (!text || !state.activeRoom) return;
        if (!canPost(state.activeChat)) { toast('В этом канале пишет только автор'); return; }
        if (textOverride === undefined) { input.value = ''; autoGrow(input); }

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

        roomKey(room).then(function (key) {
            if (!key) return { text: text, quote: reply ? reply.preview : null };
            return CR.encrypt(key, text).then(function (cipher) {
                if (!reply) return { text: cipher, quote: null };
                return CR.encrypt(key, reply.preview).then(function (q) {
                    return { text: cipher, quote: q };
                });
            });
        }).then(function (payload) {
            var body = {
                room_id: room,
                user_id: state.me.id,
                user_name: state.me.name,
                text: payload.text,
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
                // старая таблица без колонок ответа — отправляем без цитаты
                if (err.status !== 400 || !reply) throw err;
                delete body.reply_to; delete body.reply_name; delete body.reply_preview;
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
            else if (act === 'delete') deleteMessage(msgId);
        });

        bubble.appendChild(menu);

        // если сообщение у верхнего края — раскрываем меню вниз
        var box = $('msg-list');
        if (bubble.getBoundingClientRect().top - box.getBoundingClientRect().top < menu.offsetHeight + 16) {
            menu.classList.add('flip');
        }

        setTimeout(function () {
            document.addEventListener('click', function once() {
                closePicker();
                document.removeEventListener('click', once);
            });
        }, 10);
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
        if (isImage(text)) return '📷 Фото';
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
            vibrate(25);
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
        if (!CR || !CR.available()) {
            toast('Браузер не поддерживает шифрование (нужен https)');
            return;
        }
        $('crypto-code').value = storedCode(state.activeRoom) || '';
        $('crypto-modal').classList.add('show');
    }

    function saveCryptoCode() {
        var room = state.activeRoom;
        var code = $('crypto-code').value.trim();
        if (!room) return;
        if (code.length < 4) { toast('Код от 4 символов'); return; }
        setRoomCode(room, code);
        $('crypto-modal').classList.remove('show');
        toast('Шифрование включено');
        reloadRoomAfterKeyChange(room);
    }

    function disableCrypto() {
        var room = state.activeRoom;
        if (!room) return;
        setRoomCode(room, '');
        $('crypto-modal').classList.remove('show');
        toast('Шифрование выключено');
        reloadRoomAfterKeyChange(room);
    }

    function reloadRoomAfterKeyChange(room) {
        state.msgs = [];
        state.firstChatPaint = true;
        $('msg-list').innerHTML = skeletonHtml();
        $('m-input').placeholder = storedCode(room) ? 'Зашифрованное сообщение…' : 'Сообщение...';
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
            $('pf-extra').textContent = isMe ? 'Это ваш профиль' : '';
            $('pf-write').hidden = isMe || !p;
            $('pf-write').onclick = function () {
                modal.classList.remove('show');
                if (p) startDialog(p.nickname);
            };
        }

        paint(state.profiles[userId] || (isMe ? state.me : null));
        modal.classList.add('show');

        if (!state.profiles[userId] && !isMe) {
            loadProfiles([userId]).then(function () { paint(state.profiles[userId]); });
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

    /* ------------------------------------------------ настройки соединения */

    function renderConnList() {
        var box = $('conn-list');
        if (!box) return;
        box.innerHTML = candidates().map(function (c) {
            var st = api.statuses[c.url] || '';
            var active = api.base === c.url;
            return '<div class="conn-row"><span class="dot ' + esc(st) + '"></span>' +
                '<div style="flex:1;min-width:0"><div>' + esc(c.label) + (active ? ' · активен' : '') + '</div>' +
                '<div class="url">' + esc(c.url) + '</div></div></div>';
        }).join('');
    }

    function openConnection() {
        $('conn-custom').value = localStorage.getItem(LS.api) || '';
        renderConnList();
        $('conn-modal').classList.add('show');
    }

    function saveConnection() {
        var val = $('conn-custom').value.trim().replace(/\/+$/, '');
        if (val) {
            if (!/^https?:\/\//i.test(val)) { toast('Адрес должен начинаться с https://'); return; }
            localStorage.setItem(LS.api, val);
        } else {
            localStorage.removeItem(LS.api);
        }
        localStorage.removeItem(LS.apiActive);
        api.base = null;
        api.statuses = {};
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
        api.base = null;
        api.statuses = {};
        resolveApi(true).then(renderConnList);
    }

    function reconnect() {
        api.base = null;
        api.statuses = {};
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

    /* -------------------------------------------------------------- запуск */

    function startApp() {
        showPage('main');
        updateProfileUI();
        renderThemes();
        state.chats = mergeChats([]);
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

        $('btn-settings').addEventListener('click', function () { showPage('settings', true); renderThemes(); });
        $('btn-plus').addEventListener('click', openPlus);
        $('chat-search').addEventListener('input', function (e) { runSearch(e.target.value); });

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
                if (findChat(channel)) openChat(channel);
                else joinChannel(channel);
            } else if (user) {
                $('chat-search').value = '';
                runSearch('');
                startDialog(user);
            }
        });

        $('btn-back').addEventListener('click', closeChat);
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
        $('m-file').addEventListener('change', function () { handlePhotoFile(this); });
        $('m-input').addEventListener('input', function () { autoGrow(this); });
        $('m-input').addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
        });

        $('msg-list').addEventListener('click', function (e) {
            if (e.target.getAttribute && e.target.getAttribute('data-photo')) {
                $('lightbox-img').src = e.target.getAttribute('src');
                $('lightbox').classList.add('show');
                return;
            }

            var author = e.target.closest('.author');
            if (author) {
                e.stopPropagation();
                openProfile(author.getAttribute('data-author'));
                return;
            }

            var quote = e.target.closest('.quote');
            if (quote) {
                e.stopPropagation();
                scrollToMessage(quote.getAttribute('data-goto'));
                return;
            }

            var badge = e.target.closest('.reaction-badge');
            if (badge) {
                e.stopPropagation();
                var id = badge.getAttribute('data-react');
                if (state.activeChat && state.activeChat.kind === 'channel') {
                    setReaction(id, badge.getAttribute('data-emoji'));
                } else {
                    openReactionList(id);
                }
                return;
            }

            if (e.target.closest('.msg-menu')) return;
            var bubble = e.target.closest('.bubble');
            if (bubble) {
                e.stopPropagation();
                openPicker(bubble, bubble.getAttribute('data-msg'));
            }
        });

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

        $('lightbox').addEventListener('click', function () { this.classList.remove('show'); });

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
        $('set-logout').addEventListener('click', logout);
        $('set-delete').addEventListener('click', deleteAccount);

        $('plus-user').addEventListener('click', function () { addUser(); });
        $('plus-group').addEventListener('click', createGroup);
        $('plus-channel').addEventListener('click', openChannelModal);
        $('plus-cancel').addEventListener('click', closePlus);
        $('plus-menu').addEventListener('click', function (e) { if (e.target === this) closePlus(); });

        $('ch-create').addEventListener('click', createChannel);
        $('ch-cancel').addEventListener('click', function () { $('channel-modal').classList.remove('show'); });
        $('channel-modal').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('show'); });

        $('crypto-save').addEventListener('click', saveCryptoCode);
        $('crypto-off').addEventListener('click', disableCrypto);
        $('crypto-close').addEventListener('click', function () { $('crypto-modal').classList.remove('show'); });
        $('crypto-modal').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('show'); });

        $('conn-save').addEventListener('click', saveConnection);
        $('conn-reset').addEventListener('click', resetConnection);
        $('conn-close').addEventListener('click', function () { $('conn-modal').classList.remove('show'); });
        $('conn-modal').addEventListener('click', function (e) { if (e.target === this) this.classList.remove('show'); });

        document.addEventListener('visibilitychange', function () {
            if (document.hidden || !state.me) return;
            if (state.activeRoom) pollChat(false);
            else if (state.page === 'main') syncChats();
        });

        window.addEventListener('online', reconnect);
        window.addEventListener('offline', function () { setNetState(false, 'Устройство не в сети'); });
    }

    function init() {
        var params = new URLSearchParams(location.search);
        if (params.get('api')) {
            localStorage.setItem(LS.api, params.get('api').replace(/\/+$/, ''));
            localStorage.removeItem(LS.apiActive);
            history.replaceState(null, '', location.pathname + location.hash);
        }

        setTheme(localStorage.getItem(LS.theme) || 'dark');
        applyMotion();
        bindEvents();
        setAuthMode(false);

        state.me = normalizeUser(readJSON(LS.user, null));
        if (state.me && state.me.id) startApp();
        else showPage('auth');

        resolveApi(false).then(function (base) {
            if (base && state.me) syncChats();
        });

        if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
            navigator.serviceWorker.register('sw.js').catch(function () { /* не критично */ });
        }
    }

    window.WM = {
        reconnect: reconnect,
        openConnection: openConnection,
        state: state,
        api: api
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
