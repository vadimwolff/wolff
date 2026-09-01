/* ==========================================================================
 *  Проверки версии 56: значок уведомления в строке состояния телефона и
 *  доставка сообщений при закрытом приложении.
 * ========================================================================== */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = process.env.WM_BASE || 'http://localhost:8123';
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

async function signUp(nick, name) {
    const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        serviceWorkers: 'block'
    });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { failures++; console.log('  ✗ JS-ошибка (' + nick + '): ' + e.message); });
    await page.goto(BASE + '/');
    await page.click('#auth-swap-btn');
    await page.fill('#a-nick', nick);
    await page.fill('#a-name', name);
    await page.fill('#a-pass', 'pass1234');
    await page.click('#auth-btn');
    await page.waitForSelector('#page-main.active', { timeout: 25000 });
    return { ctx, page };
}

console.log('\n=== WolffMsg e2e (значок уведомления и доставка при закрытом приложении) ===');

const nina = await signUp(RUN + 'nina', 'Нина');
const oleg = await signUp(RUN + 'oleg', 'Олег');

/* ------------------------------------------- значок в строке состояния */

await step('значок уведомления — силуэт, а не белый квадрат', async () => {
    const stats = await nina.page.evaluate(() => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const g = canvas.getContext('2d');
            g.drawImage(img, 0, 0);
            const data = g.getImageData(0, 0, canvas.width, canvas.height).data;

            let clear = 0, solid = 0, colored = 0;
            for (let i = 0; i < data.length; i += 4) {
                const alpha = data[i + 3];
                if (alpha < 8) clear++;
                else if (alpha > 200) {
                    solid++;
                    // Android рисует значок одним цветом: важна прозрачность,
                    // а сама картинка должна быть белой.
                    if (data[i] < 230 || data[i + 1] < 230 || data[i + 2] < 230) colored++;
                }
            }
            resolve({ total: data.length / 4, clear, solid, colored, size: img.width });
        };
        img.onerror = () => reject(new Error('значок не загрузился'));
        img.src = 'assets/badge-96.png';
    }));

    assert(stats.size >= 48, 'значок слишком мелкий: ' + stats.size);
    // Именно этого не хватало раньше: у цветной иконки прозрачных точек нет,
    // и телефон показывал сплошной белый квадрат.
    assert(stats.clear > stats.total * 0.3,
        'у значка почти нет прозрачного фона — телефон покажет квадрат');
    assert(stats.solid > stats.total * 0.1, 'на значке ничего не нарисовано');
    assert(stats.colored === 0, 'значок не одноцветный: ' + stats.colored + ' цветных точек');
});

await step('значок уведомления берётся из приложения и из service worker', async () => {
    const inApp = await nina.page.evaluate(async () => (await fetch('assets/app.js')).text());
    assert(inApp.includes("badge: 'assets/badge-96.png'"), 'приложение шлёт старый значок');

    const inWorker = await nina.page.evaluate(async () => (await fetch('sw.js')).text());
    assert(inWorker.includes("badge: './assets/badge-96.png'"), 'service worker шлёт старый значок');
    assert(inWorker.includes('visibilityState'), 'уведомление придёт даже при открытом приложении');
    assert(inWorker.includes('muted'), 'service worker не учитывает отключённые чаты');
});

/* ------------------------------------ доставка при закрытом приложении */

await step('приложение находит сервер уведомлений', async () => {
    const server = await nina.page.evaluate(() => window.WM.findPushServer());
    assert(server && server.url, 'сервер уведомлений не найден');
    assert(/\/api\/push$/.test(server.url), 'неожиданный адрес: ' + server.url);
    assert(server.vapid && server.vapid.length > 80, 'сервер не отдал ключ подписки');
});

await step('после отправки сообщения сервер получает просьбу разослать его', async () => {
    await nina.page.click('#btn-plus');
    await nina.page.click('#plus-user');
    await nina.page.fill('#prompt-input', RUN + 'oleg');
    await nina.page.click('#prompt-ok');
    await nina.page.waitForSelector('#page-chat.active', { timeout: 25000 });
    await nina.page.fill('#m-input', 'Проверка доставки');
    await nina.page.click('#btn-send');
    await nina.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 25000 });

    const id = await nina.page.evaluate(
        () => String((window.WM.state.msgs[window.WM.state.msgs.length - 1] || {}).id || ''));
    assert(id && id.indexOf('tmp_') !== 0, 'сообщение не сохранилось на сервере');

    await nina.page.waitForFunction(async (msgId) => {
        const res = await fetch('/api/push?log=1');
        const data = await res.json();
        return (data.pings || []).some((p) => p.msg === msgId);
    }, id, { timeout: 20000 });
});

await step('уведомление адресовано собеседнику, а не автору', async () => {
    const me = await nina.page.evaluate(() => window.WM.state.me.id);
    const other = await oleg.page.evaluate(() => window.WM.state.me.id);
    const room = await nina.page.evaluate(() => window.WM.state.activeRoom);

    // Оба «подписались» на доставку — так же, как это делает браузер.
    for (const [session, user] of [[nina, me], [oleg, other]]) {
        await session.page.evaluate(async (args) => {
            await window.WM.rpc('wm_push_save', {
                p_user: args.user,
                p_endpoint: 'https://push.example/' + args.user,
                p_p256dh: 'k', p_auth: 'a'
            });
        }, { user });
    }

    const id = await nina.page.evaluate(
        () => String((window.WM.state.msgs[window.WM.state.msgs.length - 1] || {}).id || ''));
    const info = await nina.page.evaluate(
        (msgId) => window.WM.rpc('wm_push_targets', { p_msg: Number(msgId) }), id);

    assert(info && info.ok, 'сообщение не найдено для рассылки');
    assert(info.room === room, 'уведомление о другом чате: ' + info.room);
    const endpoints = (info.targets || []).map((t) => t.endpoint);
    assert(endpoints.length === 1, 'адресатов должно быть ровно один: ' + endpoints.join(', '));
    assert(endpoints[0].includes(other), 'уведомление уйдёт не тому: ' + endpoints[0]);
    assert(!endpoints[0].includes(me), 'автор получает уведомление о собственном сообщении');
});

await step('по выдуманному номеру сообщения рассылки не будет', async () => {
    const info = await nina.page.evaluate(
        () => window.WM.rpc('wm_push_targets', { p_msg: 999999 }));
    assert(info && info.ok === false, 'сервер согласился разослать несуществующее сообщение');
    assert(!(info.targets || []).length, 'выданы адреса по выдуманному сообщению');
});

await browser.close();
console.log('\n=== Итог: ' + (total - failures) + '/' + total + ' проверок, ошибок: ' + failures + ' ===\n');
process.exit(failures ? 1 : 0);
