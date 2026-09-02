/* ==========================================================================
 *  Проверки версии 59: гифки, запись о звонке в переписке, полоса системной
 *  строки, мягкая вибрация, обращение «@WolffAI» из обычного чата и то, что
 *  нечитаемые сообщения не мозолят глаза.
 * ========================================================================== */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = process.env.WM_BASE || 'http://localhost:8123';
const RUN = 'g' + Date.now().toString(36).slice(-6);
let total = 0, failures = 0;

async function step(name, fn) {
    total++;
    try { await fn(); console.log('  ✓ ' + name); }
    catch (err) { failures++; console.log('  ✗ ' + name + ' — ' + err.message); }
}

function assert(cond, message) { if (!cond) throw new Error(message); }

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: [
        '--no-sandbox',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required'
    ]
});

async function signUp(nick, name) {
    const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        serviceWorkers: 'block',
        permissions: ['microphone']
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

console.log('\n=== WolffMsg e2e (гифки, запись о звонке, строка состояния) ===');

const yura = await signUp(RUN + 'yura', 'Юра');
const zoya = await signUp(RUN + 'zoya', 'Зоя');

await step('личный чат создан', async () => {
    await yura.page.click('#btn-plus');
    await yura.page.click('#plus-user');
    await yura.page.fill('#prompt-input', RUN + 'zoya');
    await yura.page.click('#prompt-ok');
    await yura.page.waitForSelector('#page-chat.active', { timeout: 25000 });
    await yura.page.fill('#m-input', 'Начали');
    await yura.page.click('#btn-send');
    await yura.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 25000 });
});

/* ---------------------------------------------------- строка состояния */

await step('под системной строкой телефона своя полоса', async () => {
    const info = await yura.page.evaluate(() => {
        // изображаем «чёлку»: в браузере безопасная зона нулевая
        document.documentElement.style.setProperty('--safe-top', '44px');
        const strip = document.getElementById('statusbar');
        const box = strip.getBoundingClientRect();
        const style = getComputedStyle(strip);
        const panel = getComputedStyle(document.body).getPropertyValue('--panel').trim();
        document.documentElement.style.removeProperty('--safe-top');
        return {
            height: box.height, top: box.top,
            background: style.backgroundColor, panel: panel,
            z: Number(style.zIndex)
        };
    });

    assert(Math.round(info.height) === 44, 'высота полосы: ' + info.height);
    assert(info.top === 0, 'полоса не сверху: ' + info.top);
    assert(info.z >= 100, 'полоса окажется под содержимым: ' + info.z);
    assert(info.background && info.background !== 'rgba(0, 0, 0, 0)',
        'полоса прозрачная — строка телефона сольётся с приложением');
});

await step('цвет системной строки меняется вместе с темой', async () => {
    const before = await yura.page.getAttribute('meta[name=theme-color]', 'content');
    await yura.page.evaluate(() => window.WM.setTheme('light'));
    const after = await yura.page.getAttribute('meta[name=theme-color]', 'content');
    assert(before !== after, 'цвет строки не изменился: ' + before);
    await yura.page.evaluate(() => window.WM.setTheme('dark'));
});

/* ------------------------------------------------------------ вибрация */

await step('виброотклик едва ощутимый', async () => {
    await yura.page.evaluate(() => {
        window.__buzz = [];
        navigator.vibrate = function (v) { window.__buzz.push(v); return true; };
    });

    await yura.page.locator('.bubble.out').first().click();
    await yura.page.waitForSelector('.msg-menu', { timeout: 10000 });
    await yura.page.click('.msg-menu .emoji-btn[data-pick="👍"]');
    await yura.page.waitForSelector('.bubble.out .reaction-badge', { timeout: 15000 });

    const buzz = await yura.page.evaluate(() => window.__buzz);
    assert(buzz.length > 0, 'вибрации не было вовсе');
    buzz.forEach(function (v) {
        assert(typeof v === 'number' && v <= 10, 'слишком сильная вибрация: ' + v);
    });
});

/* -------------------------------------------------------------- гифки */

await step('кнопка гифок появляется, когда поиск настроен', async () => {
    await yura.page.waitForSelector('#btn-gif:not([hidden])', { timeout: 20000 });
});

await step('панель ищет гифки и не занимает весь экран', async () => {
    await yura.page.click('#btn-gif');
    await yura.page.waitForSelector('#gif-panel:not([hidden])', { timeout: 10000 });
    await yura.page.waitForSelector('#gif-grid .gif-item img', { timeout: 20000 });

    const share = await yura.page.evaluate(() => {
        const panel = document.getElementById('gif-panel').getBoundingClientRect();
        return panel.height / window.innerHeight;
    });
    assert(share < 0.6, 'панель гифок заняла почти весь экран: ' + share.toFixed(2));

    await yura.page.fill('#gif-search', 'волк');
    await yura.page.waitForFunction(() => {
        const first = document.querySelector('#gif-grid .gif-item img');
        return first && /волк/.test(first.getAttribute('alt') || '');
    }, null, { timeout: 20000 });

    // превью идут через свой сервер, а не с чужого домена
    const src = await yura.page.getAttribute('#gif-grid .gif-item img', 'src');
    assert(src.indexOf('/api/gif?file=') > 0, 'превью грузится не через свой сервер: ' + src);
});

await step('гифка уходит зашифрованным вложением и место под неё зарезервировано', async () => {
    await yura.page.click('#gif-grid .gif-item');
    await yura.page.waitForSelector('.bubble.out .gif-box', { timeout: 30000 });

    const closed = await yura.page.evaluate(() => document.getElementById('gif-panel').hidden);
    assert(closed, 'панель гифок осталась открытой');

    const ratio = await yura.page.evaluate(
        () => getComputedStyle(document.querySelector('.bubble.out .gif-box')).aspectRatio);
    assert(ratio && ratio !== 'auto', 'место под гифку не зарезервировано: ' + ratio);

    const room = await yura.page.evaluate(() => window.WM.state.activeRoom);
    const rows = await yura.page.evaluate(async (r) => {
        const res = await fetch(window.WM.api.base + '/attachments?room_id=eq.' +
            encodeURIComponent(r) + '&select=data&order=id.desc&limit=1');
        return res.json();
    }, room);
    assert(rows.length && String(rows[0].data).indexOf('wm1:') === 0,
        'гифка ушла незашифрованной');
});

/* ------------------------------------------------- нечитаемые сообщения */

await step('сообщение с чужим ключом не показывается, вместо него одна строка', async () => {
    const room = await yura.page.evaluate(() => window.WM.state.activeRoom);
    const before = await yura.page.locator('.bubble').count();

    await yura.page.evaluate(async (r) => {
        await fetch(window.WM.api.base + '/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                room_id: r, user_id: 'ghost', user_name: 'Призрак',
                text: 'wm1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBB',
                created_at: new Date().toISOString()
            })
        });
    }, room);

    await yura.page.waitForSelector('.locked-note', { timeout: 20000 });
    const note = await yura.page.textContent('.locked-note');
    assert(/зашифрован/.test(note), 'непонятная строка: ' + note);

    const after = await yura.page.locator('.bubble').count();
    assert(after === before, 'нечитаемое сообщение всё-таки показано');
});

/* ------------------------------------------------- @WolffAI в любом чате */

await step('«@WolffAI» в обычном чате получает ответ прямо там', async () => {
    await yura.page.fill('#m-input', '@WolffAI подскажи, где мы');
    await yura.page.click('#btn-send');

    await yura.page.waitForFunction(() => [...document.querySelectorAll('.bubble .text')]
        .some((e) => e.textContent.includes('Отвечаю на')), null, { timeout: 30000 });

    const room = await yura.page.evaluate(() => window.WM.state.activeRoom);
    const answered = await yura.page.evaluate(() => window.WM.state.msgs
        .some((m) => m.user_id === 'wolffai'));
    assert(answered, 'помощник не ответил в обычном чате');
    assert(room.indexOf('ai_') !== 0, 'ответ пришёл не в тот чат');
});

/* --------------------------------------------------- запись о звонке */

await step('после звонка в переписке остаётся запись с длительностью', async () => {
    await zoya.page.waitForFunction(
        () => [...document.querySelectorAll('#chat-list .f-item')].some((e) => e.textContent.includes('Юра')),
        null, { timeout: 25000 });
    await zoya.page.click('#chat-list .f-item:has-text("Юра")');
    await zoya.page.waitForSelector('#page-chat.active', { timeout: 15000 });

    await yura.page.waitForSelector('#btn-call:not([hidden])', { timeout: 20000 });
    await yura.page.click('#btn-call');
    await zoya.page.waitForSelector('#call-screen:not([hidden])', { timeout: 30000 });
    await zoya.page.click('#call-accept');

    await yura.page.waitForFunction(
        () => window.WM.state.call && window.WM.state.call.startedAt,
        null, { timeout: 45000 });
    await yura.page.waitForTimeout(2200);
    await yura.page.click('#call-hangup');

    await yura.page.waitForFunction(() => [...document.querySelectorAll('.bubble .call-log')]
        .some((e) => /Звонок · \d+:\d\d/.test(e.textContent)), null, { timeout: 30000 });

    const text = await yura.page.textContent('.bubble .call-log');
    assert(/0:0[1-9]/.test(text), 'длительность звонка не записалась: ' + text);

    // собеседник видит ту же запись
    await zoya.page.waitForFunction(() => [...document.querySelectorAll('.bubble .call-log')].length > 0,
        null, { timeout: 30000 });
});

await step('кнопки экрана звонка на месте и работают', async () => {
    await yura.page.click('#btn-call');
    await yura.page.waitForSelector('#call-screen:not([hidden])', { timeout: 10000 });
    await zoya.page.waitForSelector('#call-screen:not([hidden])', { timeout: 30000 });

    // отклонение у собеседника закрывает звонок у обоих
    await zoya.page.click('#call-hangup');
    const closed = () => document.getElementById('call-screen').hidden;
    await zoya.page.waitForFunction(closed, null, { timeout: 10000 });
    await yura.page.waitForFunction(closed, null, { timeout: 25000 });

    await yura.page.waitForFunction(() => [...document.querySelectorAll('.bubble .call-log')]
        .some((e) => /отклонён|Пропущенный/.test(e.textContent)), null, { timeout: 30000 });
});

await browser.close();
console.log('\n=== Итог: ' + (total - failures) + '/' + total + ' проверок, ошибок: ' + failures + ' ===\n');
process.exit(failures ? 1 : 0);
