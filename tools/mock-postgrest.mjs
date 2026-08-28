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

const db = {
    profiles: [],
    chats: [],
    messages: [],
    room_reads: []
};

let messageSeq = 1;

const hash = (s) => 'bcrypt$' + crypto.createHash('sha256').update(String(s)).digest('hex');

/* ------------------------------------------------------------- фильтрация */

function matchFilter(row, column, expr) {
    const dot = expr.indexOf('.');
    const op = expr.slice(0, dot);
    const raw = expr.slice(dot + 1);
    const value = row[column];

    switch (op) {
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
        preview: String(m.text || '').startsWith('data:image/') ? '📷 Фото' : String(m.text || '').slice(0, 120),
        created_at: m.created_at
    }));
}

function publicUser(p) {
    return { id: p.id, nickname: p.nickname, name: p.name, avatar: p.avatar || '' };
}

const rpcs = {
    wm_register({ p_nickname, p_password, p_name }) {
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
            created_at: new Date().toISOString()
        };
        db.profiles.push(row);
        return { ok: true, user: publicUser(row) };
    },

    wm_login({ p_nickname, p_password }) {
        const nick = String(p_nickname || '').trim().toLowerCase();
        const row = db.profiles.find((p) => p.nickname === nick);
        if (!row) return { ok: false, error: 'not_found' };
        if (row.password_hash) {
            return row.password_hash === hash(p_password)
                ? { ok: true, user: publicUser(row) } : { ok: false, error: 'bad_password' };
        }
        if (row.password && row.password === p_password) {
            row.password_hash = hash(p_password);
            row.password = null;
            return { ok: true, user: publicUser(row) };
        }
        return { ok: false, error: 'bad_password' };
    },

    wm_set_password({ p_nickname, p_old_password, p_new_password }) {
        if (String(p_new_password || '').length < 4) return { ok: false, error: 'weak_password' };
        const check = rpcs.wm_login({ p_nickname, p_password: p_old_password });
        if (!check.ok) return { ok: false, error: 'bad_password' };
        const row = db.profiles.find((p) => p.nickname === String(p_nickname).toLowerCase());
        row.password_hash = hash(p_new_password);
        row.password = null;
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
        const saved = rows.map((row) => {
            const rec = { ...row };
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
