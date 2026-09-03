/* ==========================================================================
 *  Проверки версии 61: гифки видно и в длинной переписке, они появляются
 *  сразу при отправке, кнопка гифок есть под скрепкой, а панель закрывается
 *  смахиванием вниз.
 * ========================================================================== */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = process.env.WM_BASE || 'http://localhost:8123';
const RUN = 'h' + Date.now().toString(36).slice(-6);
let total = 0, failures = 0;

async function step(name, fn) {
    total++;
    try { await fn(); console.log('  ✓ ' + name); }
    catch (err) { failures++; console.log('  ✗ ' + name + ' — ' + err.message); }
}

function assert(cond, message) { if (!cond) throw new Error(message); }

const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox']
});

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
const page = await ctx.newPage();
page.on('pageerror', (e) => { failures++; console.log('  ✗ JS-ошибка: ' + e.message); });

console.log('\n=== WolffMsg e2e (гифки: видимость, скорость, скрепка, смахивание) ===');

await step('вход и открытый чат', async () => {
    await page.goto(BASE + '/');
    await page.click('#auth-swap-btn');
    await page.fill('#a-nick', RUN + 'gera');
    await page.fill('#a-name', 'Гера');
    await page.fill('#a-pass', 'pass1234');
    await page.click('#auth-btn');
    await page.waitForSelector('#page-main.active', { timeout: 25000 });
    await page.click('#chat-list .f-item:has-text("Избранное")');
    await page.waitForSelector('#page-chat.active', { timeout: 15000 });
});

await step('в строке ввода нет отдельной кнопки гифок', async () => {
    const gone = await page.evaluate(() => !document.getElementById('btn-gif'));
    assert(gone, 'кнопка GIF всё ещё в строке ввода');
});

await step('скрепка открывает выдвижное меню с крупными кнопками', async () => {
    await page.click('#btn-attach');
    await page.waitForSelector('#attach-menu.show', { timeout: 10000 });

    const tiles = await page.evaluate(() => [...document.querySelectorAll('.attach-tile')]
        .map((t) => ({ text: t.textContent.trim(), h: t.getBoundingClientRect().height })));
    assert(tiles.length === 3, 'кнопок в меню: ' + tiles.length);
    assert(tiles.every((t) => t.h >= 80), 'кнопки слишком мелкие: ' + JSON.stringify(tiles));

    await page.click('#attach-gif');
    await page.waitForSelector('#gif-panel:not([hidden])', { timeout: 10000 });

    const open = await page.evaluate(() => document.getElementById('attach-menu').classList.contains('show'));
    assert(!open, 'меню скрепки осталось открытым');
});

await step('панель гифок разворачивается на пол-экрана и обратно', async () => {
    const height = () => page.evaluate(
        () => document.getElementById('gif-panel').getBoundingClientRect().height);

    await page.waitForSelector('#gif-grid .gif-item', { timeout: 20000 });
    await page.waitForTimeout(300);            // сетка встала на место
    const normal = await height();

    await page.click('#gif-grab');
    await page.waitForFunction(
        () => document.getElementById('gif-panel').classList.contains('tall'),
        null, { timeout: 10000 });
    await page.waitForTimeout(350);

    const tall = await height();
    assert(tall > normal * 1.4, 'панель не развернулась: ' + normal + ' → ' + tall);

    await page.click('#gif-grab');
    await page.waitForFunction(
        () => !document.getElementById('gif-panel').classList.contains('tall'),
        null, { timeout: 10000 });
    await page.waitForTimeout(400);            // дожидаемся конца анимации

    const back = await height();
    assert(Math.abs(back - normal) < 30, 'панель не вернулась к обычному размеру: ' + back);
});

await step('панель закрывается смахиванием вниз', async () => {
    const box = await page.locator('#gif-panel').boundingBox();
    const x = box.x + box.width / 2;
    const y = box.y + 10;                      // полоска-ручка сверху

    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
        await page.mouse.move(x, y + (110 * i) / 6);
        await page.waitForTimeout(16);
    }
    await page.mouse.up();

    await page.waitForFunction(() => document.getElementById('gif-panel').hidden,
        null, { timeout: 10000 });
});

await step('гифка с телефона появляется в переписке сразу, не дожидаясь сервера', async () => {
    // Сервер отвечает с задержкой — как мобильная сеть.
    await page.route('**/rest/v1/attachments**', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        await new Promise((r) => setTimeout(r, 2500));
        return route.continue();
    });

    const started = Date.now();
    await page.setInputFiles('#m-gif-file',
        { name: 'wolf.gif', mimeType: 'image/gif', buffer: Buffer.from(GIF, 'base64') });

    await page.waitForSelector('.bubble.pending .gif-box img', { timeout: 2000 });
    const shown = Date.now() - started;
    assert(shown < 2000, 'гифка показалась только через ' + shown + ' мс');

    // а когда сервер ответил — пузырь становится обычным
    await page.waitForFunction(
        () => document.querySelectorAll('.bubble.out:not(.pending) .gif-box img').length > 0,
        null, { timeout: 30000 });
    await page.unroute('**/rest/v1/attachments**');
});

await step('в длинной переписке гифка внизу тоже видна', async () => {
    // Набиваем историю, чтобы список пришлось прокручивать.
    for (let i = 1; i <= 14; i++) {
        await page.fill('#m-input', 'Сообщение ' + i);
        await page.click('#btn-send');
        await page.waitForTimeout(60);
    }
    await page.waitForFunction(
        () => document.querySelectorAll('.bubble').length >= 15, null, { timeout: 25000 });

    // и отправляем гифку последней — она внизу, где список уже прокручен
    await page.setInputFiles('#m-gif-file',
        { name: 'wolf2.gif', mimeType: 'image/gif', buffer: Buffer.from(GIF, 'base64') });

    await page.waitForFunction(() => {
        const nodes = [...document.querySelectorAll('.gif-box img')];
        const last = nodes[nodes.length - 1];
        return last && last.getBoundingClientRect().width > 100;
    }, null, { timeout: 25000 });

    const scrolled = await page.evaluate(() => document.getElementById('msg-list').scrollTop);
    assert(scrolled > 200, 'переписка так и не прокрутилась: ' + scrolled);
});

await step('гифка видна и после возврата в чат', async () => {
    await page.click('#btn-back');
    await page.waitForSelector('#page-main.active', { timeout: 15000 });
    await page.click('#chat-list .f-item:has-text("Избранное")');
    await page.waitForSelector('#page-chat.active', { timeout: 15000 });

    await page.waitForFunction(() => {
        const nodes = [...document.querySelectorAll('.gif-box img')];
        const last = nodes[nodes.length - 1];
        return last && last.getBoundingClientRect().height > 40;
    }, null, { timeout: 25000 });
});

/* --------------------------------------------------- уведомления */

await step('в настройках видно, что уведомления доходят и при закрытом приложении', async () => {
    await ctx.grantPermissions(['notifications'], { origin: BASE });
    await page.evaluate(() => localStorage.setItem('WM_NOTIFY', 'on'));

    await page.click('#btn-back');
    await page.waitForSelector('#page-main.active', { timeout: 15000 });
    await page.click('#btn-settings');
    await page.waitForSelector('#page-settings.active', { timeout: 15000 });

    await page.waitForFunction(() => {
        const pill = document.getElementById('notify-state');
        return pill && pill.textContent === 'и при закрытом';
    }, null, { timeout: 20000 });
});

await step('подписка обновляется, когда у сервера сменился ключ', async () => {
    const checks = await page.evaluate(async () => {
        const keys = await window.WM.makeVapidKeys();
        const other = await window.WM.makeVapidKeys();
        const bytes = (b64) => {
            const pad = b64.replace(/-/g, '+').replace(/_/g, '/');
            const raw = atob(pad + '='.repeat((4 - pad.length % 4) % 4));
            const out = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
            return out;
        };
        const sub = { options: { applicationServerKey: bytes(keys.publicKey).buffer } };
        return {
            len: keys.publicKey.length,
            head: keys.publicKey.slice(0, 1),
            secret: (keys.privateKey || '').length,
            same: window.WM.sameVapid(sub, keys.publicKey),
            changed: window.WM.sameVapid(sub, other.publicKey)
        };
    });

    assert(checks.len >= 86, 'открытый ключ подозрительно короткий: ' + checks.len);
    assert(checks.head === 'B', 'ключ не в том формате: ' + checks.head);
    assert(checks.secret >= 40, 'закрытый ключ не создан');
    assert(checks.same === true, 'своя же подписка считается устаревшей');
    assert(checks.changed === false, 'смена ключа сервера не замечена');
});

await browser.close();
console.log('\n=== Итог: ' + (total - failures) + '/' + total + ' проверок, ошибок: ' + failures + ' ===\n');
process.exit(failures ? 1 : 0);
