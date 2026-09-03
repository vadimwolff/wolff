/* ==========================================================================
 *  Поиск гифок.
 *
 *  Приложение не ходит к чужому сервису напрямую: и ключ остался бы в
 *  браузере, и стороннему сервису было бы видно, кто что ищет. Вместо этого
 *  запрос идёт сюда, а сервер обращается к сервису гифок и возвращает только
 *  подготовленный список.
 *
 *  Поддерживаются два сервиса — годится любой, ключ нужен только один:
 *
 *   GIPHY_API_KEY   ключ Giphy (developers.giphy.com → Create an App →
 *                   API Key). Выдаётся сразу и бесплатно — самый простой путь.
 *   TENOR_API_KEY   ключ Tenor. Это ключ Google Cloud, и в том же проекте
 *                   должен быть включён «Tenor API»: обычный ключ из AI Studio
 *                   без этого отвечает 403.
 *   TENOR_CLIENT    (необязательно) имя приложения для статистики Tenor
 *
 *  Если своего ключа для гифок нет, но задан GEMINI_API_KEY, пробуем его же:
 *  Tenor — сервис Google, и ключ подойдёт, когда в том же проекте Google Cloud
 *  включён «Tenor API». Не включён — приходит понятное объяснение.
 *
 *  Если заданы оба ключа, сначала пробуется Giphy, а Tenor остаётся запасным.
 *
 *  Два режима:
 *    GET  /api/gif?q=…      — поиск (пусто — популярное)
 *    GET  /api/gif?file=…   — отдать сам файл гифки (только с доменов сервисов)
 * ========================================================================== */

const GIPHY_KEY = process.env.GIPHY_API_KEY || '';
const TENOR_KEY = process.env.TENOR_API_KEY || '';
const TENOR_CLIENT = process.env.TENOR_CLIENT || 'wolffmsg';

/* Tenor — тоже сервис Google, и ключ от Gemini подойдёт ему, если в том же
   проекте Google Cloud включён «Tenor API». Своего ключа для гифок нет —
   пробуем этот: в худшем случае придёт понятный отказ 403, из которого видно,
   что именно нужно включить. */
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

/* Файл отдаём только с доменов самих сервисов: превратить прокси в открытый
   «качатель чего угодно» нельзя. */
const ALLOWED = /^https:\/\/(media[0-9]*\.tenor\.com|c\.tenor\.com|media\.tenor\.com|media[0-9]*\.giphy\.com|i\.giphy\.com)\//i;

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

/* Причина отказа сервиса — короткой строкой и без ключа: её показывают в
   настройках, чтобы было понятно, что чинить. */
function why(status, body) {
    const text = String(body || '').replace(/(key|api_key)=[^&"'\s]+/gi, '$1=…').slice(0, 160);
    if (status === 401 || status === 403) return 'ключ не принят (' + status + '): ' + text;
    if (status === 429) return 'превышен бесплатный лимит';
    return 'сервис ответил ' + status + ': ' + text;
}

async function ask(url) {
    const upstream = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (upstream.ok) return { ok: true, data: await upstream.json() };
    const body = await upstream.text().catch(() => '');
    return {
        ok: false,
        error: (upstream.status === 401 || upstream.status === 403) ? 'bad_key' : 'busy',
        detail: why(upstream.status, body)
    };
}

/* ------------------------------------------------------------------ Giphy */

function shapeGiphy(items) {
    return (items || []).map((item) => {
        const images = item.images || {};
        const small = images.fixed_width_small || images.fixed_width || images.downsized;
        const full = images.fixed_width || images.downsized || images.original;
        if (!small || !full) return null;
        const url = full.mp4 || full.url;
        return {
            id: String(item.id || ''),
            title: String(item.title || '').slice(0, 80),
            preview: small.url,
            url: url,
            width: Number(full.width) || 200,
            height: Number(full.height) || 200,
            video: /\.mp4/.test(url)
        };
    }).filter(Boolean);
}

async function searchGiphy(query) {
    const params = new URLSearchParams({
        api_key: GIPHY_KEY,
        limit: '24',
        rating: 'g',              // без взрослого содержимого
        lang: 'ru'
    });
    if (query) params.set('q', query);
    const path = query ? 'search' : 'trending';
    const result = await ask('https://api.giphy.com/v1/gifs/' + path + '?' + params.toString());
    if (!result.ok) return result;
    return { ok: true, provider: 'giphy', results: shapeGiphy(result.data && result.data.data) };
}

/* ------------------------------------------------------------------ Tenor */

function shapeTenor(items) {
    return (items || []).map((item) => {
        const media = item.media_formats || {};
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

async function searchTenor(query, key = TENOR_KEY) {
    const params = new URLSearchParams({
        key: key,
        client_key: TENOR_CLIENT,
        limit: '24',
        media_filter: 'nanogif,tinygif,gif,tinymp4,mp4',
        contentfilter: 'high',    // без взрослого содержимого
        locale: 'ru_RU'
    });
    if (query) params.set('q', query);
    const path = query ? 'search' : 'featured';
    const result = await ask('https://tenor.googleapis.com/v2/' + path + '?' + params.toString());
    if (!result.ok) return result;
    return { ok: true, provider: 'tenor', results: shapeTenor(result.data && result.data.results) };
}

/* -------------------------------------------------------------- обработчик */

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

    if (!GIPHY_KEY && !TENOR_KEY && !GEMINI_KEY) {
        reply(res, 200, {
            ok: false,
            error: 'not_configured',
            detail: 'в настройках сервера нет ни GIPHY_API_KEY, ни TENOR_API_KEY',
            results: []
        });
        return;
    }

    const query = (url.searchParams.get('q') || '').trim().slice(0, 60);
    const providers = [];
    if (GIPHY_KEY) providers.push((q) => searchGiphy(q));
    if (TENOR_KEY) providers.push((q) => searchTenor(q));
    if (!GIPHY_KEY && !TENOR_KEY && GEMINI_KEY) {
        providers.push(async (q) => {
            const result = await searchTenor(q, GEMINI_KEY);
            if (result.ok || result.error !== 'bad_key') return result;
            return {
                ok: false,
                error: 'bad_key',
                detail: 'ключ Gemini не подошёл для гифок: в проекте Google Cloud не ' +
                    'включён Tenor API. Проще добавить GIPHY_API_KEY с developers.giphy.com'
            };
        });
    }

    let last = { ok: false, error: 'busy', detail: 'сервис не ответил' };
    for (const search of providers) {
        try {
            const result = await search(query);
            if (result.ok) { reply(res, 200, result); return; }
            last = result;
        } catch (e) {
            last = { ok: false, error: 'busy', detail: 'сервис не ответил' };
        }
    }

    reply(res, 200, { ok: false, error: last.error, detail: last.detail, results: [] });
}
