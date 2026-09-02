/* ==========================================================================
 *  WolffAI — ответы помощника в отдельном чате.
 *
 *  Приложение присылает сюда последние реплики беседы, сервер обращается к
 *  Gemini и возвращает ответ. Ключ хранится только здесь, в настройках
 *  проекта, и в браузер не попадает.
 *
 *  Переменные окружения (Vercel → Settings → Environment Variables):
 *
 *   GEMINI_API_KEY   ключ из Google AI Studio — единственное, что нужно
 *   GEMINI_MODELS    (необязательно) свой список моделей через запятую
 *
 *  Модели перебираются по очереди: как только у одной кончается бесплатный
 *  лимит (ответ 429) или она недоступна, запрос уходит следующей. Если не
 *  ответила ни одна, приложение показывает, что сейчас большой спрос.
 * ========================================================================== */

const KEY = process.env.GEMINI_API_KEY || '';

const MODELS = (process.env.GEMINI_MODELS ||
    'gemini-2.5-flash,gemini-2.5-flash-lite,gemini-2.0-flash,gemini-2.0-flash-lite')
    .split(',').map((m) => m.trim()).filter(Boolean);

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/';

const SYSTEM = 'Ты WolffAI — помощник внутри мессенджера WolffMsg. ' +
    'Отвечай на языке собеседника, дружелюбно и по делу, без канцелярита. ' +
    'Держи ответы короткими: несколько предложений, если не просят подробнее. ' +
    'Не выдумывай факты: если чего-то не знаешь, так и скажи.';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store'
};

const MAX_TURNS = 20;          // сколько последних реплик учитывать
const MAX_CHARS = 4000;        // ограничение на длину одной реплики

function reply(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
    res.end(JSON.stringify(data));
}

async function readBody(req) {
    if (req.body) return typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/* Ответ одной модели. Возвращает текст либо причину, по которой не вышло. */
async function ask(model, contents) {
    const response = await fetch(ENDPOINT + encodeURIComponent(model) + ':generateContent?key=' +
        encodeURIComponent(KEY), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents,
            systemInstruction: { parts: [{ text: SYSTEM }] },
            generationConfig: { temperature: 0.8, maxOutputTokens: 1024 }
        }),
        signal: AbortSignal.timeout(25000)
    });

    if (response.status === 429 || response.status === 503) return { retry: true };
    if (response.status === 404 || response.status === 400) return { retry: true };
    if (!response.ok) return { retry: response.status >= 500 };

    const data = await response.json();
    const candidate = data && data.candidates && data.candidates[0];
    const parts = (candidate && candidate.content && candidate.content.parts) || [];
    const text = parts.map((p) => p.text || '').join('').trim();

    // Пустой ответ бывает, когда модель остановили фильтры — пробуем следующую.
    if (!text) return { retry: true };
    return { text, model };
}

export default async function handler(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
    }

    // Приложение спрашивает, есть ли помощник, прежде чем показывать чат.
    if (req.method === 'GET') {
        reply(res, 200, { ok: !!KEY, models: KEY ? MODELS.length : 0 });
        return;
    }

    if (req.method !== 'POST') {
        reply(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
    }

    if (!KEY) {
        reply(res, 200, { ok: false, error: 'not_configured' });
        return;
    }

    let body;
    try {
        body = await readBody(req);
    } catch (e) {
        reply(res, 400, { ok: false, error: 'bad_json' });
        return;
    }

    const history = Array.isArray(body && body.messages) ? body.messages : [];
    const contents = history.slice(-MAX_TURNS).map((m) => ({
        role: m && m.role === 'model' ? 'model' : 'user',
        parts: [{ text: String((m && m.text) || '').slice(0, MAX_CHARS) }]
    })).filter((m) => m.parts[0].text);

    if (!contents.length) {
        reply(res, 400, { ok: false, error: 'empty' });
        return;
    }

    for (const model of MODELS) {
        try {
            const result = await ask(model, contents);
            if (result.text) {
                reply(res, 200, { ok: true, text: result.text, model: result.model });
                return;
            }
            if (!result.retry) break;
        } catch (e) {
            /* сеть или таймаут — пробуем следующую модель */
        }
    }

    // Ни одна модель не ответила: чаще всего это исчерпанный бесплатный лимит.
    reply(res, 200, { ok: false, error: 'busy' });
}
