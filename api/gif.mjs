/* ==========================================================================
 *  Поиск гифок.
 *
 *  Приложение не ходит к чужому сервису напрямую: и ключ остался бы в
 *  браузере, и стороннему сервису было бы видно, кто что ищет. Вместо этого
 *  запрос идёт сюда, а сервер обращается к Tenor и возвращает только
 *  подготовленный список.
 *
 *  Переменные окружения проекта:
 *
 *   TENOR_API_KEY   ключ Tenor (Google AI Studio → Tenor API), бесплатный
 *   TENOR_CLIENT    (необязательно) имя приложения для статистики Tenor
 *
 *  Два режима:
 *    GET  /api/gif?q=…      — поиск (пусто — популярное)
 *    GET  /api/gif?file=…   — отдать сам файл гифки (только с доменов Tenor)
 * ========================================================================== */

const KEY = process.env.TENOR_API_KEY || '';
const CLIENT = process.env.TENOR_CLIENT || 'wolffmsg';
const API = 'https://tenor.googleapis.com/v2/';

/* Файл отдаём только с доменов самого Tenor: превратить прокси в открытый
   «качатель чего угодно» нельзя. */
const ALLOWED = /^https:\/\/(media[0-9]*\.tenor\.com|c\.tenor\.com|media\.tenor\.com)\//i;

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400'
};

function reply(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...CORS
    });
    res.end(JSON.stringify(data));
}

/* Из ответа Tenor берём только то, что нужно: маленькую картинку для панели
   и короткий mp4 для отправки. */
function shape(results) {
    return (results || []).map((item) => {
        const media = (item.media_formats || {});
        const preview = media.nanogif || media.tinygif || media.gif;
        const full = media.tinymp4 || media.mp4 || media.tinygif || media.gif;
        if (!preview || !full) return null;
        return {
            id: String(item.id || ''),
            title: String(item.content_description || '').slice(0, 80),
            preview: preview.url,
            url: full.url,
            width: full.dims ? full.dims[0] : 200,
            height: full.dims ? full.dims[1] : 200,
            video: /\.mp4/.test(full.url)
        };
    }).filter(Boolean);
}

export default async function handler(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
    }
    if (req.method !== 'GET') {
        reply(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
    }

    const url = new URL(req.url, 'http://localhost');
    const file = url.searchParams.get('file');

    // Отдаём сам файл — так он приходит с домена сайта и не требует
    // послаблений в политике безопасности страницы.
    if (file) {
        if (!ALLOWED.test(file)) { reply(res, 400, { ok: false, error: 'bad_source' }); return; }
        try {
            const upstream = await fetch(file, { signal: AbortSignal.timeout(15000) });
            if (!upstream.ok) { reply(res, 502, { ok: false, error: 'upstream' }); return; }
            const buffer = Buffer.from(await upstream.arrayBuffer());
            res.writeHead(200, {
                'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
                'Content-Length': String(buffer.length),
                'Cache-Control': 'public, max-age=86400',
                ...CORS
            });
            res.end(buffer);
        } catch (e) {
            reply(res, 502, { ok: false, error: 'upstream' });
        }
        return;
    }

    if (!KEY) {
        reply(res, 200, { ok: false, error: 'not_configured', results: [] });
        return;
    }

    const query = (url.searchParams.get('q') || '').trim().slice(0, 60);
    const params = new URLSearchParams({
        key: KEY,
        client_key: CLIENT,
        limit: '24',
        media_filter: 'nanogif,tinygif,gif,tinymp4,mp4',
        contentfilter: 'high'          // без взрослого содержимого
    });
    if (query) params.set('q', query);
    params.set('locale', 'ru_RU');

    try {
        const upstream = await fetch(API + (query ? 'search' : 'featured') + '?' + params.toString(),
            { signal: AbortSignal.timeout(12000) });
        if (!upstream.ok) { reply(res, 200, { ok: false, error: 'busy', results: [] }); return; }
        const data = await upstream.json();
        reply(res, 200, { ok: true, results: shape(data.results) });
    } catch (e) {
        reply(res, 200, { ok: false, error: 'busy', results: [] });
    }
}
