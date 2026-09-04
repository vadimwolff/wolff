/* ==========================================================================
 *  Проверки версии 62: приложение, собранное внутрь пакета Android.
 *
 *  Стенд повторяет устройство: сайт отдаётся из папки пакета (там нет ни
 *  сервера, ни служебного работника), а переписка идёт на отдельный адрес по
 *  https — ровно как с телефона на Vercel.
 * ========================================================================== */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const PACK = process.env.WM_BASE_PACK || 'http://localhost:8130';   // файлы из пакета
const SERVER = process.env.WM_BASE_TLS || 'https://localhost:8443'; // сервер переписки
const RUN = 'p' + Date.now().toString(36).slice(-6);
let total = 0, failures = 0;

async function step(name, fn) {
    total++;
    try { await fn(); console.log('  ✓ ' + name); }
    catch (err) { failures++; console.log('  ✗ ' + name + ' — ' + err.message); }
}

function assert(cond, message) { if (!cond) throw new Error(message); }

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox']
});

const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'block',
    ignoreHTTPSErrors: true
});
const page = await ctx.newPage();
page.on('pageerror', (e) => { failures++; console.log('  ✗ JS-ошибка: ' + e.message); });

console.log('\n=== WolffMsg e2e (приложение внутри пакета Android) ===');

await step('приложение открывается из пакета, без интернета для самого экрана', async () => {
    await page.goto(PACK + '/index.html');
    await page.waitForSelector('#page-auth.active', { timeout: 20000 });

    // Ни одного запроса к чужому домену ради самого интерфейса.
    const outside = await page.evaluate(() => performance.getEntriesByType('resource')
        .map((r) => r.name)
        .filter((n) => n.indexOf(location.origin) !== 0));
    assert(outside.length === 0, 'экран тянет файлы со стороны: ' + outside.join(', '));
});

await step('в пакете лежат все файлы приложения', async () => {
    const loaded = await page.evaluate(() => ({
        app: typeof window.WM !== 'undefined',
        crypto: typeof window.WMCrypto !== 'undefined' || typeof window.CR !== 'undefined',
        styles: getComputedStyle(document.body).backgroundColor,
        config: !!(window.WM_CONFIG && window.WM_CONFIG.endpoints.length)
    }));
    assert(loaded.app, 'app.js не загрузился из пакета');
    assert(loaded.config, 'настройки не загрузились из пакета');
    assert(loaded.styles && loaded.styles !== 'rgba(0, 0, 0, 0)', 'стили не загрузились');
});

await step('адрес сервера прописан в пакете заранее', async () => {
    const cfg = await page.evaluate(() => ({
        server: window.WM_CONFIG.serverUrl,
        first: window.WM_CONFIG.endpoints[0].url,
        sameOrigin: window.WM_CONFIG.endpoints.some((e) => String(e.url).indexOf('same-origin:') === 0)
    }));
    assert(cfg.server === SERVER, 'адрес сервера: ' + cfg.server);
    assert(cfg.first === SERVER + '/api/db', 'первый канал связи: ' + cfg.first);
    assert(!cfg.sameOrigin, 'остался канал «на домене сайта» — внутри пакета он ведёт в никуда');
});

await step('регистрация и переписка работают', async () => {
    await page.click('#auth-swap-btn');
    await page.fill('#a-nick', RUN + 'ilya');
    await page.fill('#a-name', 'Илья');
    await page.fill('#a-pass', 'pass1234');
    await page.click('#auth-btn');
    await page.waitForSelector('#page-main.active', { timeout: 30000 });

    await page.click('#chat-list .f-item:has-text("Избранное")');
    await page.waitForSelector('#page-chat.active', { timeout: 15000 });
    await page.fill('#m-input', 'Работает из пакета');
    await page.click('#btn-send');
    await page.waitForSelector('.bubble.out:not(.pending)', { timeout: 25000 });

    const base = await page.evaluate(() => window.WM.api.base);
    assert(base.indexOf(SERVER) === 0, 'переписка идёт не через сервер: ' + base);
});

await step('шифрование работает и в пакете', async () => {
    const room = await page.evaluate(() => window.WM.state.activeRoom);
    const rows = await page.evaluate(async (args) => {
        const res = await fetch(args.server + '/rest/v1/messages?room_id=eq.' +
            encodeURIComponent(args.room) + '&select=text&order=id.desc&limit=1');
        return res.json();
    }, { server: SERVER, room });
    assert(rows.length && String(rows[0].text).indexOf('wm1:') === 0,
        'сообщение ушло незашифрованным: ' + JSON.stringify(rows[0]));
});

await step('помощник и гифки находятся по заранее прописанному адресу', async () => {
    await page.click('#btn-back');
    await page.waitForSelector('#page-main.active', { timeout: 15000 });
    await page.click('#btn-settings');
    await page.waitForSelector('#page-settings.active', { timeout: 15000 });

    await page.waitForFunction(() => {
        const ai = document.getElementById('ai-state');
        const gif = document.getElementById('gif-state');
        return ai && gif && ai.textContent === 'подключён' && gif.textContent === 'работает';
    }, null, { timeout: 30000 });
});

await step('служебный работник внутри пакета не регистрируется', async () => {
    const registered = await page.evaluate(() => !!(navigator.serviceWorker &&
        navigator.serviceWorker.controller));
    assert(!registered, 'внутри пакета включился служебный работник');
});

await browser.close();
console.log('\n=== Итог: ' + (total - failures) + '/' + total + ' проверок, ошибок: ' + failures + ' ===\n');
process.exit(failures ? 1 : 0);
