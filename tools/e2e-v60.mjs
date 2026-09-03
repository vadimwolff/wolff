/* ==========================================================================
 *  Проверки версии 60: сайт, открытый с адреса без серверной части
 *  (так выглядит копия на GitHub Pages), находит помощника, уведомления
 *  и гифки после того, как один раз указан адрес сервера.
 * ========================================================================== */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

/* Сервер отвечает по https — как настоящий: браузер и не пустит приложение
   на посторонний адрес без https. Сертификат самодельный, поэтому контекст
   создаётся с ignoreHTTPSErrors. */
const BASE = process.env.WM_BASE_TLS || 'https://localhost:8443';   // сервер приложения
const SITE = process.env.WM_BASE_SITE || 'http://localhost:8129';   // сайт без сервера
const RUN = 's' + Date.now().toString(36).slice(-6);
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

console.log('\n=== WolffMsg e2e (сайт отдельно, сервер отдельно) ===');

/* Сайт лежит на одном адресе, база — там же напрямую, а серверных функций
   (/api/...) на этом адресе нет вовсе — как на GitHub Pages. */
const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: 'block',
    ignoreHTTPSErrors: true
});
const page = await ctx.newPage();
page.on('pageerror', (e) => { failures++; console.log('  ✗ JS-ошибка: ' + e.message); });

await step('вход на сайт без серверной части', async () => {
    await page.goto(SITE + '/?api=' + encodeURIComponent(SITE + '/rest/v1'));
    await page.click('#auth-swap-btn');
    await page.fill('#a-nick', RUN + 'ann');
    await page.fill('#a-name', 'Аня');
    await page.fill('#a-pass', 'pass1234');
    await page.click('#auth-btn');
    await page.waitForSelector('#page-main.active', { timeout: 25000 });
});

await step('помощник честно показывает, что сервер не найден', async () => {
    await page.click('#btn-settings');
    await page.waitForSelector('#page-settings.active', { timeout: 15000 });
    await page.waitForFunction(() => {
        const pill = document.getElementById('ai-state');
        return pill && pill.textContent === 'не найден';
    }, null, { timeout: 25000 });
});

await step('в подсказке видно, какие адреса проверили', async () => {
    await page.click('#set-ai');
    await page.waitForSelector('#confirm-modal.show', { timeout: 25000 });
    const text = await page.textContent('#confirm-text');
    assert(/Проверили/.test(text), 'нет отчёта о поиске: ' + text);
    assert(text.includes('localhost:8129'), 'не указан проверенный адрес: ' + text);
    assert(!/apikey|eyJ/.test(text), 'в подсказке засветился ключ: ' + text);
});

await step('адрес сервера принимается в любом виде', async () => {
    const cases = await page.evaluate(() => {
        const was = window.WM.currentServer();
        const out = {
            bare: window.WM.setServer('wolffmsg.vercel.app'),
            withPath: window.WM.setServer('https://wolffmsg.vercel.app/api/ai'),
            proxy: window.WM.setServer('https://wolffmsg.vercel.app/api/db/'),
            junk: window.WM.setServer('не адрес')
        };
        if (was) window.WM.setServer(was); else localStorage.removeItem('WM_SERVER');
        return out;
    });
    const expected = 'https://wolffmsg.vercel.app';
    assert(cases.bare === expected, 'адрес без https: ' + cases.bare);
    assert(cases.withPath === expected, 'ссылка на /api/ai: ' + cases.withPath);
    assert(cases.proxy === expected, 'ссылка на прокси базы: ' + cases.proxy);
    assert(cases.junk === '', 'мусор принят за адрес: ' + cases.junk);
});

await step('указали адрес сервера — помощник нашёлся', async () => {
    await page.click('#confirm-ok');
    await page.waitForSelector('#prompt-modal.show', { timeout: 15000 });
    await page.fill('#prompt-input', BASE);
    await page.click('#prompt-ok');

    await page.waitForFunction(() => {
        const pill = document.getElementById('ai-state');
        return pill && pill.textContent === 'подключён';
    }, null, { timeout: 30000 });
});

await step('тот же адрес включил и гифки', async () => {
    await page.click('#btn-settings-done');
    await page.waitForSelector('#page-main.active', { timeout: 15000 });
    await page.waitForFunction(
        () => [...document.querySelectorAll('#chat-list .f-item b')].some((e) => e.textContent.includes('WolffAI')),
        null, { timeout: 25000 });
    await page.click('#chat-list .f-item:has-text("WolffAI")');
    await page.waitForSelector('#page-chat.active', { timeout: 15000 });
    await page.waitForSelector('#btn-gif:not([hidden])', { timeout: 25000 });
});

await step('помощник отвечает в своём чате', async () => {
    await page.fill('#m-input', 'Проверка связи');
    await page.click('#btn-send');
    await page.waitForSelector('.bubble.in .text', { timeout: 30000 });
    const answer = await page.textContent('.bubble.in .text');
    assert(answer.includes('Проверка связи'), 'ответ помощника: ' + answer);
});

/* --------------------------------------------------------------- гифки */

await step('гифка с телефона уходит живой, а не картинкой', async () => {
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    await page.setInputFiles('#m-file', { name: 'wolf.gif', mimeType: 'image/gif', buffer: gif });
    await page.waitForSelector('.bubble.out .gif-box', { timeout: 30000 });

    const room = await page.evaluate(() => window.WM.state.activeRoom);
    const rows = await page.evaluate(async (r) => {
        const res = await fetch(window.WM.api.base + '/attachments?room_id=eq.' +
            encodeURIComponent(r) + '&select=data&order=id.desc&limit=1');
        return res.json();
    }, room);
    assert(rows.length && String(rows[0].data).indexOf('wm1:') === 0,
        'гифка с телефона ушла незашифрованной');

    const msgs = await page.evaluate(() => window.WM.state.msgs
        .map((m) => String(m.body === undefined ? m.text : m.body)));
    assert(msgs.some((t) => /^wmgif:/.test(t)),
        'гифка ушла обычной картинкой: ' + msgs.slice(-2).join(' | '));
});

await step('помощник не пытается разглядывать гифку', async () => {
    await page.waitForFunction(() => [...document.querySelectorAll('.bubble.in .text')]
        .some((e) => e.textContent.includes('понимаю только текст')), null, { timeout: 30000 });
});

await step('в настройках видно, почему поиск гифок не работает', async () => {
    await page.route('**/api/gif*', (route) => {
        if (route.request().url().includes('file=')) return route.continue();
        return route.fulfill({
            status: 200,
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({ ok: false, error: 'bad_key', detail: 'ключ не принят (403): forbidden' })
        });
    });

    await page.click('#btn-back');
    await page.waitForSelector('#page-main.active', { timeout: 15000 });
    await page.click('#btn-settings');
    await page.waitForSelector('#page-settings.active', { timeout: 15000 });
    await page.click('#set-gif');

    await page.waitForSelector('#confirm-modal.show', { timeout: 25000 });
    const text = await page.textContent('#confirm-text');
    assert(/ключ не принят/.test(text), 'причина не показана: ' + text);
    assert(/\.gif/.test(text), 'нет подсказки про гифки с телефона: ' + text);

    const pill = await page.textContent('#gif-state');
    assert(pill === 'не настроен', 'состояние поиска: ' + pill);

    await page.click('#confirm-cancel');
    await page.unroute('**/api/gif*');
});

await step('поиск гифок снова работает после починки', async () => {
    await page.click('#set-gif');
    await page.waitForFunction(() => {
        const pill = document.getElementById('gif-state');
        return pill && pill.textContent === 'работает';
    }, null, { timeout: 25000 });
    await page.click('#btn-settings-done');
    await page.waitForSelector('#page-main.active', { timeout: 15000 });
});

await step('адрес запомнен: после перезапуска искать заново не нужно', async () => {
    await page.reload();
    await page.waitForSelector('#page-main.active', { timeout: 25000 });

    const saved = await page.evaluate(() => window.WM.currentServer());
    assert(saved === BASE, 'сохранён другой адрес: ' + saved);

    const urls = await page.evaluate(() => window.WM.serviceUrls('push'));
    assert(urls[0] === BASE + '/api/push', 'сервер проверяется не первым: ' + urls.join(', '));
});

await step('запись о сервере не содержит ничего секретного', async () => {
    const dump = await page.evaluate(() => JSON.stringify(Object.fromEntries(
        Object.keys(localStorage).map((k) => [k, String(localStorage.getItem(k)).slice(0, 200)]))));
    assert(!/GEMINI|TENOR|service_role/i.test(dump), 'в браузере оказался серверный ключ');
});

await ctx.close();
await browser.close();
console.log('\n=== Итог: ' + (total - failures) + '/' + total + ' проверок, ошибок: ' + failures + ' ===\n');
process.exit(failures ? 1 : 0);
