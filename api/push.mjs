/* ==========================================================================
 *  Доставка уведомлений, когда приложение полностью закрыто.
 *
 *  Как это работает:
 *
 *   1. Браузер подписывается на уведомления и сохраняет свой адрес доставки
 *      в базе (функция wm_push_save).
 *   2. Отправив сообщение, приложение зовёт этот адрес: POST { msg: <номер> }.
 *   3. Сервер спрашивает базу, кому это сообщение адресовано
 *      (wm_push_targets — она же проверяет, что сообщение настоящее и
 *      только что написано), и рассылает уведомления.
 *
 *  Текст сообщения сюда не передаётся и на сервере не расшифровывается: в
 *  уведомление попадают только имя отправителя и адрес чата.
 *
 *  Переменные окружения проекта (Vercel → Settings → Environment Variables):
 *
 *   VAPID_PUBLIC_KEY   открытый ключ, приложение забирает его отсюда само
 *   VAPID_PRIVATE_KEY  закрытый ключ, известен только серверу
 *   VAPID_SUBJECT      mailto:… или адрес сайта (требование стандарта)
 *   SUPABASE_URL       адрес базы (как и у прокси /api/db)
 *   SUPABASE_ANON_KEY  публичный ключ базы
 *
 *  Пару ключей печатает `node tools/vapid-keys.mjs`.
 * ========================================================================== */

import { sendPush } from './_webpush.mjs';

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://rzgiyafpkeqvbpqombkr.supabase.co')
    .replace(/\/+$/, '');

const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6Z2l5YWZwa2VxdmJwcW9tYmtyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3NzU5MTksImV4cCI6MjA5NDM1MTkxOX0.qvKNRcO-ylrWzOFYxEvWhcGBeSCxoanZx4i1VnhF7_w';

const KEYS = {
    publicKey: process.env.VAPID_PUBLIC_KEY || '',
    privateKey: process.env.VAPID_PRIVATE_KEY || '',
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@wolffmsg.app'
};

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store'
};

/* Одно и то же сообщение не рассылаем дважды подряд. */
const recent = new Map();

function reply(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
    res.end(JSON.stringify(data));
}

async function rpc(name, args) {
    const response = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
        method: 'POST',
        headers: {
            apikey: SUPABASE_KEY,
            Authorization: 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error('rpc ' + name + ': ' + response.status);
    return response.json();
}

async function readBody(req) {
    if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export default async function handler(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
    }

    const configured = !!(KEYS.publicKey && KEYS.privateKey);

    // Приложение спрашивает открытый ключ: без него подписаться нельзя.
    if (req.method === 'GET') {
        reply(res, 200, { ok: configured, vapid: KEYS.publicKey });
        return;
    }

    if (req.method !== 'POST') {
        reply(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
    }

    if (!configured) {
        reply(res, 503, { ok: false, error: 'vapid_not_configured' });
        return;
    }

    let payload;
    try {
        payload = await readBody(req);
    } catch (e) {
        reply(res, 400, { ok: false, error: 'bad_json' });
        return;
    }

    const msg = Number(payload && payload.msg);
    if (!Number.isFinite(msg) || msg <= 0) {
        reply(res, 400, { ok: false, error: 'bad_request' });
        return;
    }

    const now = Date.now();
    for (const [key, time] of recent) if (now - time > 300000) recent.delete(key);
    if (recent.has(msg)) {
        reply(res, 200, { ok: true, sent: 0, note: 'already_sent' });
        return;
    }
    recent.set(msg, now);

    let info;
    try {
        info = await rpc('wm_push_targets', { p_msg: msg });
    } catch (e) {
        reply(res, 502, { ok: false, error: 'database_unavailable' });
        return;
    }

    if (!info || !info.ok) {
        reply(res, 200, { ok: true, sent: 0, note: 'nothing_to_send' });
        return;
    }

    const body = JSON.stringify({
        title: info.title || 'WolffMsg',
        body: 'Новое сообщение',
        room: info.room,
        msg: info.msg
    });

    const targets = Array.isArray(info.targets) ? info.targets : [];
    let sent = 0;
    const dead = [];

    await Promise.all(targets.map(async (target) => {
        try {
            const result = await sendPush(target, body, KEYS);
            if (result.status === 404 || result.status === 410) dead.push(target.endpoint);
            else if (result.status >= 200 && result.status < 300) sent++;
        } catch (e) {
            /* один недоступный адрес не должен мешать остальным */
        }
    }));

    // Браузер мог отозвать подписку — убираем такие адреса из базы.
    await Promise.all(dead.map((endpoint) => rpc('wm_push_drop', { p_endpoint: endpoint })
        .catch(() => null)));

    reply(res, 200, { ok: true, sent: sent, dropped: dead.length });
}
