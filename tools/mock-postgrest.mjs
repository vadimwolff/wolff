/* ==========================================================================
 *  Локальный стенд для проверки клиента: статика + минимальная эмуляция
 *  PostgREST (Supabase REST) в памяти процесса.
 *
 *  Запуск:  node tools/mock-postgrest.mjs [порт]
 *  Открыть: http://localhost:8123/?api=http://localhost:8123/rest/v1
 *
 *  Поддерживается ровно то подмножество API, которым пользуется приложение:
 *  фильтры eq/gt/in/cs, select, order, limit, Prefer: return/resolution,
 *  а также функции wm_register / wm_login / wm_set_password.
 * ========================================================================== */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8123);

/* WM_LEGACY=1 — эмуляция «старой» базы: только profiles и messages, пароли
   открытым текстом, без функций входа. Нужна для проверки совместимости. */
const LEGACY = process.env.WM_LEGACY === '1';

/* WM_DENY воспроизводит состояние Supabase сразу после применения schema.sql:
   прямая запись в profiles уже запрещена правами, а кеш REST-API ещё не видит
   функций входа и отдаёт на них 404.
     warmup — первый вызов функции даёт 404, дальше кеш «прогрет»;
     always — кеш не обновляется никогда. */
const DENY = process.env.WM_DENY || '';
let rpcCalls = 0;

/* WM_OLDCHATS=1 — база предыдущей версии: функций каналов нет, а в таблицах
   отсутствуют колонки каналов и ответов. PostgREST на такие поля отвечает 400. */
const OLD_CHATS = process.env.WM_OLDCHATS === '1';
const OLD_COLUMNS = {
    chats: ['room_id', 'name', 'kind', 'members', 'created_at'],
    messages: ['id', 'room_id', 'user_id', 'user_name', 'text', 'reactions', 'created_at'],
    // в старой базе нет ни колонок ответа, ни короткого превью
    profiles: ['id', 'nickname', 'name', 'avatar', 'password', 'created_at']
};

const db = {
    profiles: [],
    chats: [],
    messages: [],
    room_reads: [],
    room_keys: [],
    attachments: [],
    push_subscriptions: []
};

/* Что ушло на сервер уведомлений: тесты смотрят сюда. */
const pushLog = [];

/* Открытый ключ подписки — настоящий по виду, но выдуманный: в стенде
   уведомления никуда не отправляются. */
const MOCK_VAPID = 'BDOWGXA08bMq-yXbKASz2aESoUQlpMXv9jR6ZjjXO4jaZTFA5j91SdguNu0og11xM9D7ph8Csm-hkm4ws9ak6gw';

let messageSeq = 1;
let attachmentSeq = 1;

const hash = (s) => 'bcrypt$' + crypto.createHash('sha256').update(String(s)).digest('hex');

/* ------------------------------------------------------------- фильтрация */

/* Делит "a.ilike.*x*,b.eq.1" по запятым верхнего уровня, не трогая скобки. */
function splitTop(text) {
    const out = [];
    let depth = 0, buf = '';
    for (const ch of text) {
        if (ch === '(' || ch === '{') depth++;
        if (ch === ')' || ch === '}') depth--;
        if (ch === ',' && depth === 0) { out.push(buf); buf = ''; continue; }
        buf += ch;
    }
    if (buf) out.push(buf);
    return out;
}

function matchFilter(row, column, expr) {
    if (column === 'or') {
        // or=(name.ilike.*x*,slug.ilike.*x*)
        return splitTop(expr.replace(/^\(|\)$/g, '')).some((part) => {
            const dot = part.indexOf('.');
            return matchFilter(row, part.slice(0, dot), part.slice(dot + 1));
        });
    }

    const dot = expr.indexOf('.');
    const op = expr.slice(0, dot);
    const raw = expr.slice(dot + 1);
    const value = row[column];

    switch (op) {
        case 'is': {
            if (raw === 'null') return value === null || value === undefined;
            return String(!!value) === raw;
        }
        case 'ilike': {
            const needle = raw.replace(/[%*]/g, '').toLowerCase();
            return String(value ?? '').toLowerCase().includes(needle);
        }
        case 'eq': return String(value) === raw;
        case 'neq': return String(value) !== raw;
        case 'gt': return String(value) > raw;
        case 'gte': return String(value) >= raw;
        case 'lt': return String(value) < raw;
        case 'lte': return String(value) <= raw;
        case 'in': {
            const items = raw.replace(/^\(|\)$/g, '').split(',')
                .map((s) => s.trim().replace(/^"|"$/g, ''));
            return items.includes(String(value));
        }
        case 'cs': {
            const items = raw.replace(/^\{|\}$/g, '').split(',')
                .map((s) => s.trim().replace(/^"|"$/g, ''));
            return Array.isArray(value) && items.every((i) => value.includes(i));
        }
        case 'like': return String(value).includes(raw.replace(/[%*]/g, ''));
        default: return true;
    }
}

function applyQuery(rows, params) {
    let out = rows.slice();

    for (const [key, val] of params) {
        if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
        out = out.filter((r) => matchFilter(r, key, val));
    }

    const order = params.get('order');
    if (order) {
        const [col, dir = 'asc'] = order.split('.');
        out.sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? '')));
        if (dir.startsWith('desc')) out.reverse();
    }

    const limit = params.get('limit');
    if (limit) out = out.slice(0, Number(limit));

    const select = params.get('select');
    if (select && select !== '*') {
        const cols = select.split(',').map((s) => s.trim());
        out = out.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
    }

    return out;
}

/* ------------------------------------------------------ представления/RPC */

function chatPreviews() {
    const byRoom = new Map();
    for (const m of db.messages) {
        const cur = byRoom.get(m.room_id);
        if (!cur || String(m.created_at) > String(cur.created_at)) byRoom.set(m.room_id, m);
    }
    return [...byRoom.values()].map((m) => ({
        room_id: m.room_id,
        id: m.id,
        user_id: m.user_id,
        user_name: m.user_name,
        preview: m.preview != null ? m.preview
            : (String(m.text || '').startsWith('data:image/') ? '📷 Фото'
                : (String(m.text || '').startsWith('wm1:') ? '🔒' : String(m.text || '').slice(0, 120))),
        created_at: m.created_at
    }));
}

function publicUser(p) {
    return { id: p.id, nickname: p.nickname, name: p.name, avatar: p.avatar || '' };
}

function userKeys(p) {
    return {
        public_key: p.public_key || null,
        enc_private_key: p.enc_private_key || null,
        key_salt: p.key_salt || null
    };
}

const rpcs = {
    wm_register({ p_nickname, p_password, p_name, p_public_key, p_enc_private_key, p_key_salt }) {
        const nick = String(p_nickname || '').trim().toLowerCase();
        if (!/^[a-z0-9_.]{3,32}$/.test(nick)) return { ok: false, error: 'bad_nickname' };
        if (String(p_password || '').length < 4) return { ok: false, error: 'weak_password' };
        if (db.profiles.some((p) => p.nickname === nick)) return { ok: false, error: 'nickname_taken' };

        const row = {
            id: 'u' + Date.now() + Math.floor(Math.random() * 1000),
            nickname: nick,
            name: String(p_name || '').trim() || nick,
            avatar: '',
            password: null,
            password_hash: hash(p_password),
            public_key: p_public_key || null,
            enc_private_key: p_enc_private_key || null,
            key_salt: p_key_salt || null,
            created_at: new Date().toISOString()
        };
        db.profiles.push(row);
        return { ok: true, user: publicUser(row), keys: userKeys(row) };
    },

    wm_login({ p_nickname, p_password }) {
        const nick = String(p_nickname || '').trim().toLowerCase();
        const row = db.profiles.find((p) => p.nickname === nick);
        if (!row) return { ok: false, error: 'not_found' };
        if (row.password_hash) {
            return row.password_hash === hash(p_password)
                ? { ok: true, user: publicUser(row), keys: userKeys(row) }
                : { ok: false, error: 'bad_password' };
        }
        if (row.password && row.password === p_password) {
            row.password_hash = hash(p_password);
            row.password = null;
            return { ok: true, user: publicUser(row), keys: userKeys(row) };
        }
        return { ok: false, error: 'bad_password' };
    },

    wm_create_channel({ p_owner, p_title, p_slug, p_about }) {
        const slug = String(p_slug || '').trim().toLowerCase();
        if (String(p_title || '').trim().length < 2) return { ok: false, error: 'bad_title' };
        if (!/^[a-z0-9_]{4,32}$/.test(slug)) return { ok: false, error: 'bad_slug' };
        if (db.chats.some((c) => String(c.slug || '').toLowerCase() === slug)) {
            return { ok: false, error: 'slug_taken' };
        }
        const chat = {
            room_id: 'channel_' + slug,
            name: String(p_title).trim(),
            kind: 'channel',
            members: [p_owner],
            slug,
            about: String(p_about || '').trim() || null,
            owner_id: p_owner,
            is_public: true,
            subscribers: 1,
            created_at: new Date().toISOString()
        };
        db.chats.push(chat);
        return { ok: true, chat };
    },

    wm_join_chat({ p_room, p_user }) {
        const chat = db.chats.find((c) => c.room_id === p_room);
        if (!chat) return { ok: false, error: 'not_found' };
        if (!chat.members.includes(p_user)) chat.members.push(p_user);
        chat.subscribers = chat.members.length;
        return { ok: true, chat };
    },

    wm_leave_chat({ p_room, p_user }) {
        const chat = db.chats.find((c) => c.room_id === p_room);
        if (!chat) return { ok: false, error: 'not_found' };
        chat.members = chat.members.filter((m) => m !== p_user);
        chat.subscribers = chat.members.length;
        return { ok: true, chat };
    },

    wm_search({ p_query, p_me }) {
        const term = String(p_query || '').trim().toLowerCase().replace(/^@+/, '');
        if (!term) return { channels: [], users: [] };
        const channels = db.chats
            .filter((c) => c.is_public && (String(c.name || '').toLowerCase().includes(term) ||
                String(c.slug || '').toLowerCase().includes(term)))
            .slice(0, 20)
            .map((c) => ({
                room_id: c.room_id, name: c.name, slug: c.slug, about: c.about,
                subscribers: c.subscribers, owner_id: c.owner_id,
                joined: (c.members || []).includes(p_me)
            }));
        const users = db.profiles
            .filter((p) => p.id !== p_me && (p.nickname.includes(term) ||
                String(p.name || '').toLowerCase().includes(term)))
            .slice(0, 20)
            .map((p) => ({ id: p.id, nickname: p.nickname, name: p.name, avatar: p.avatar }));
        return { channels, users };
    },

    wm_push_save({ p_user, p_endpoint, p_p256dh, p_auth }) {
        if (!p_user || !p_endpoint) return { ok: false, error: 'bad_request' };
        const rows = db.push_subscriptions.filter((s) => s.endpoint !== p_endpoint);
        rows.push({ endpoint: p_endpoint, user_id: p_user, p256dh: p_p256dh || '', auth: p_auth || '' });
        db.push_subscriptions = rows;
        return { ok: true };
    },

    wm_push_drop({ p_endpoint }) {
        db.push_subscriptions = db.push_subscriptions.filter((s) => s.endpoint !== p_endpoint);
        return { ok: true };
    },

    wm_push_targets({ p_msg }) {
        const msg = db.messages.find((m) => String(m.id) === String(p_msg));
        if (!msg) return { ok: false, error: 'not_found', targets: [] };
        const fresh = Date.now() - new Date(msg.created_at).getTime() < 5 * 60 * 1000;
        if (!fresh) return { ok: false, error: 'not_found', targets: [] };

        const chat = db.chats.find((c) => c.room_id === msg.room_id) || { members: [] };
        const title = (chat.kind === 'group' || chat.kind === 'channel') && chat.name
            ? chat.name : (msg.user_name || 'WolffMsg');
        const targets = db.push_subscriptions.filter(
            (s) => (chat.members || []).includes(s.user_id) && s.user_id !== msg.user_id);
        return { ok: true, room: msg.room_id, msg: msg.id, title, targets };
    },

    wm_set_keys({ p_nickname, p_password, p_public_key, p_enc_private_key, p_key_salt }) {
        const check = rpcs.wm_login({ p_nickname, p_password });
        if (!check.ok) return { ok: false, error: 'bad_password' };
        const row = db.profiles.find((p) => p.nickname === String(p_nickname).toLowerCase());
        if (row.public_key) return { ok: false, error: 'already_set' };
        row.public_key = p_public_key;
        row.enc_private_key = p_enc_private_key;
        row.key_salt = p_key_salt;
        return { ok: true, user: publicUser(row) };
    },

    wm_set_password({ p_nickname, p_old_password, p_new_password, p_enc_private_key, p_key_salt }) {
        if (String(p_new_password || '').length < 4) return { ok: false, error: 'weak_password' };
        const check = rpcs.wm_login({ p_nickname, p_password: p_old_password });
        if (!check.ok) return { ok: false, error: 'bad_password' };
        const row = db.profiles.find((p) => p.nickname === String(p_nickname).toLowerCase());
        row.password_hash = hash(p_new_password);
        row.password = null;
        if (p_enc_private_key) row.enc_private_key = p_enc_private_key;
        if (p_key_salt) row.key_salt = p_key_salt;
        return { ok: true, user: publicUser(row) };
    }
};

/* --------------------------------------------------------------- статика */

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json',
    '.json': 'application/json'
};

function serveStatic(req, res) {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
    }
    res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store'
    });
    res.end(fs.readFileSync(file));
}

/* ------------------------------------------------------------------- API */

function json(res, status, body, extra = {}) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'cache-control': 'no-store',
        ...extra
    });
    res.end(body === null ? '' : JSON.stringify(body));
}

function tableOf(name) {
    if (name === 'chat_previews') return chatPreviews();
    return db[name];
}

function handleApi(req, res, rest, body) {
    const url = new URL(rest, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const params = url.searchParams;
    const prefer = req.headers.prefer || '';
    const wantRepresentation = prefer.includes('return=representation');

    if (LEGACY && (parts[0] === 'rpc' || ['chats', 'room_reads', 'chat_previews'].includes(parts[0]))) {
        return json(res, 404, { code: 'PGRST205', message: 'relation not found (legacy mode)' });
    }

    if (DENY) {
        if (parts[0] === 'rpc' && (DENY === 'always' || ++rpcCalls <= 1)) {
            return json(res, 404, { code: 'PGRST202', message: 'function not found in schema cache' });
        }
        const denied = parts[0] === 'profiles' &&
            (req.method === 'POST' || req.method === 'DELETE' || params.has('password'));
        if (denied) {
            return json(res, 403, { code: '42501', message: 'permission denied for table profiles' });
        }
    }

    if (OLD_CHATS) {
        const newRpcs = ['wm_create_channel', 'wm_join_chat', 'wm_leave_chat', 'wm_search', 'wm_set_keys'];
        if (parts[0] === 'rpc' && newRpcs.includes(parts[1])) {
            return json(res, 404, { code: 'PGRST202', message: 'function not found' });
        }
        if (parts[0] === 'room_keys' || parts[0] === 'attachments') {
            return json(res, 404, { code: 'PGRST205', message: 'relation not found' });
        }
        const allowed = OLD_COLUMNS[parts[0]];
        if (allowed) {
            const select = params.get('select');
            const used = []
                .concat(select && select !== '*' ? select.split(',').map((c) => c.trim()) : [])
                .concat(body && !Array.isArray(body) ? Object.keys(body) : [])
                .concat([...params.keys()].filter((k) => !['select', 'order', 'limit', 'offset', 'or'].includes(k)));
            const bad = used.find((c) => c && !allowed.includes(c));
            if (bad) {
                return json(res, 400, {
                    code: 'PGRST204',
                    message: "Could not find the '" + bad + "' column of '" + parts[0] + "' in the schema cache"
                });
            }
        }
    }

    if (parts[0] === 'rpc') {
        const fn = rpcs[parts[1]];
        if (!fn) return json(res, 404, { code: 'PGRST202', message: 'function not found' });
        return json(res, 200, fn(body || {}));
    }

    const name = parts[0];
    if (!(name in db) && name !== 'chat_previews') {
        return json(res, 404, { code: 'PGRST205', message: 'relation not found' });
    }

    if (req.method === 'GET') {
        return json(res, 200, applyQuery(tableOf(name), params));
    }

    if (req.method === 'POST') {
        const rows = Array.isArray(body) ? body : [body];

        // как триггер в базе: в канал пишет только его владелец
        if (name === 'messages') {
            const bad = rows.find((row) => {
                const chat = db.chats.find((c) => c.room_id === row.room_id);
                return chat && chat.kind === 'channel' && chat.owner_id && chat.owner_id !== row.user_id;
            });
            if (bad) {
                return json(res, 403, { code: '42501', message: 'only the channel owner can post here' });
            }
        }

        const saved = rows.map((row) => {
            const rec = { ...row };
            if (name === 'attachments') {
                rec.id = attachmentSeq++;
                rec.created_at = rec.created_at || new Date().toISOString();
            }
            if (name === 'messages') {
                rec.id = messageSeq++;
                rec.created_at = rec.created_at || new Date().toISOString();
                rec.reactions = rec.reactions || {};
            }
            if (prefer.includes('resolution=merge-duplicates')) {
                const keys = name === 'chats' ? ['room_id'] : ['room_id', 'user_id'];
                const idx = db[name].findIndex((r) => keys.every((k) => r[k] === rec[k]));
                if (idx >= 0) { db[name][idx] = { ...db[name][idx], ...rec }; return db[name][idx]; }
            }
            db[name].push(rec);
            return rec;
        });
        return wantRepresentation ? json(res, 201, saved) : json(res, 204, null);
    }

    if (req.method === 'PATCH') {
        const targets = applyQuery(db[name], new URLSearchParams(
            [...params].filter(([k]) => !['select', 'order', 'limit'].includes(k))));
        const updated = [];
        for (const row of db[name]) {
            if (targets.some((t) => t === row)) { Object.assign(row, body); updated.push(row); }
        }
        return wantRepresentation ? json(res, 200, updated) : json(res, 204, null);
    }

    if (req.method === 'DELETE') {
        const targets = new Set(applyQuery(db[name], params));
        db[name] = db[name].filter((r) => !targets.has(r));
        return json(res, 204, null);
    }

    return json(res, 405, { message: 'method not allowed' });
}

/* ---------------------------------------------------------------- сервер */

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return json(res, 204, null);

    // Сервер уведомлений: отдаёт ключ и записывает, о чём его попросили.
    if (req.url.split('?')[0] === '/api/push') {
        if (req.method === 'GET') {
            if (req.url.includes('log=1')) return json(res, 200, { pings: pushLog });
            return json(res, 200, { ok: true, vapid: MOCK_VAPID });
        }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            let parsed = null;
            try { parsed = JSON.parse(body || '{}'); } catch { parsed = null; }
            if (parsed && parsed.msg) pushLog.push({ msg: String(parsed.msg), at: Date.now() });
            json(res, 200, { ok: true, sent: 0 });
        });
        return undefined;
    }

    // и /rest/v1/... (прямой Supabase), и /api/db/... (прокси на домене сайта)
    const match = req.url.match(/^\/(?:rest\/v1|api\/db)(\/.*)$/);
    if (!match) return serveStatic(req, res);

    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
        let body = null;
        if (raw) { try { body = JSON.parse(raw); } catch { body = null; } }
        try {
            handleApi(req, res, match[1], body);
        } catch (err) {
            json(res, 500, { message: String(err) });
        }
    });
});

server.listen(PORT, () => {
    console.log('mock server: http://localhost:' + PORT + '/?api=http://localhost:' + PORT + '/rest/v1');
});

export { db };
