/* ==========================================================================
 *  Прокси Supabase REST на домене самого сайта (Vercel Edge Function).
 *
 *  Браузер обращается к /api/db/... — то есть к тому же домену, с которого
 *  загружен сайт, а к Supabase ходит уже сервер Vercel. Сторонние домены в
 *  браузере не используются: если открывается сам сайт, работает и мессенджер.
 *
 *  Настраивается переменными окружения проекта (Settings → Environment
 *  Variables). Если их не задать, используются значения по умолчанию.
 * ========================================================================== */

export const config = { runtime: 'edge' };

const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://rzgiyafpkeqvbpqombkr.supabase.co')
    .replace(/\/+$/, '');

const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY ||
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6Z2l5YWZwa2VxdmJwcW9tYmtyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3NzU5MTksImV4cCI6MjA5NDM1MTkxOX0.qvKNRcO-ylrWzOFYxEvWhcGBeSCxoanZx4i1VnhF7_w';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'apikey,authorization,content-type,prefer,accept,range,x-client-info',
    'Access-Control-Expose-Headers': 'content-range,content-type',
    'Access-Control-Max-Age': '86400'
};

export default async function handler(request) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    const incoming = new URL(request.url);
    const path = incoming.pathname.replace(/^\/api\/db/, '') || '/';
    const target = SUPABASE_URL + '/rest/v1' + path + incoming.search;

    const headers = new Headers();
    headers.set('apikey', SUPABASE_KEY);
    headers.set('Authorization', 'Bearer ' + SUPABASE_KEY);
    headers.set('Accept', request.headers.get('accept') || 'application/json');
    const passthrough = ['content-type', 'prefer', 'range', 'accept-profile', 'content-profile'];
    for (const name of passthrough) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
    }

    const init = { method: request.method, headers };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = await request.text();
    }

    /* Supabase изредка отвечает 5xx на холодном старте или при всплеске
       нагрузки. Один тихий повтор здесь избавляет клиента от лишнего
       переключения адреса и мигания «нет связи». */
    async function callUpstream() {
        return fetch(target, { ...init, signal: AbortSignal.timeout(20000) });
    }

    let upstream;
    try {
        upstream = await callUpstream();
        if (upstream.status >= 500 && request.method === 'GET') {
            await new Promise((r) => setTimeout(r, 250));
            upstream = await callUpstream();
        }
    } catch (err) {
        // Повторяем только чтение: повтор записи мог бы создать дубль сообщения.
        try {
            if (request.method !== 'GET') throw err;
            await new Promise((r) => setTimeout(r, 250));
            upstream = await callUpstream();
        } catch (retryErr) {
            return new Response(JSON.stringify({ message: 'upstream_unavailable', detail: String(retryErr) }), {
                status: 502,
                headers: { ...CORS, 'content-type': 'application/json' }
            });
        }
    }

    const out = new Headers(CORS);
    out.set('content-type', upstream.headers.get('content-type') || 'application/json');
    const range = upstream.headers.get('content-range');
    if (range) out.set('content-range', range);
    out.set('cache-control', 'no-store');

    return new Response(upstream.body, { status: upstream.status, headers: out });
}
