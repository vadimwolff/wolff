/* ==========================================================================
 *  Проверки версии 50: публичные каналы, глобальный поиск, шифрование,
 *  мгновенная отрисовка из кэша и отсутствие мигания списка сообщений.
 * ========================================================================== */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = process.env.WM_BASE || 'http://localhost:8123';
const RUN = 'v' + Date.now().toString(36).slice(-6);
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
    const ctx = await browser.newContext({ viewport: { width: 420, height: 880 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { failures++; console.log('  ✗ JS-ошибка (' + nick + '): ' + e.message); });
    await page.goto(BASE + '/');
    await page.click('#auth-swap-btn');
    await page.fill('#a-nick', nick);
    await page.fill('#a-name', name);
    await page.fill('#a-pass', 'pass1234');
    await page.click('#auth-btn');
    await page.waitForSelector('#page-main.active', { timeout: 20000 });
    return { ctx, page };
}

console.log('\n=== WolffMsg e2e (каналы, поиск, шифрование, отсутствие мигания) ===');

const author = await signUp(RUN + 'author', 'Автор Канала');
const reader = await signUp(RUN + 'reader', 'Читатель');

await step('создание публичного канала', async () => {
    await author.page.click('#btn-plus');
    await author.page.click('#plus-channel');
    await author.page.fill('#ch-title', 'Новости стаи');
    await author.page.fill('#ch-slug', RUN + 'news');
    await author.page.fill('#ch-about', 'Официальный канал');
    await author.page.click('#ch-create');
    await author.page.waitForSelector('#page-chat.active', { timeout: 20000 });
    const sub = await author.page.textContent('#chat-subtitle');
    assert(sub.includes('подписчик'), 'подзаголовок канала: ' + sub);
});

await step('автор публикует запись', async () => {
    await author.page.fill('#m-input', 'Первый пост канала');
    await author.page.click('#btn-send');
    await author.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 20000 });
});

await step('канал находится в глобальном поиске', async () => {
    await reader.page.fill('#chat-search', 'новости');
    await reader.page.waitForSelector('#global-results .f-item[data-channel]', { timeout: 20000 });
    const text = await reader.page.textContent('#global-results .f-item[data-channel]');
    assert(text.includes('Новости стаи'), 'найден не тот канал: ' + text);
    assert(text.includes('Подписаться'), 'нет кнопки подписки: ' + text);
});

await step('подписка открывает канал и показывает записи', async () => {
    await reader.page.click('#global-results .f-item[data-channel]');
    await reader.page.waitForSelector('#page-chat.active', { timeout: 20000 });
    await reader.page.waitForFunction(
        () => [...document.querySelectorAll('.bubble.in .text')]
            .some((e) => e.textContent.includes('Первый пост')), null, { timeout: 20000 });
});

await step('подписчик не может писать в канал', async () => {
    const barHidden = await reader.page.isHidden('#input-bar');
    assert(barHidden, 'подписчику показана строка ввода');
    const note = await reader.page.textContent('#channel-note');
    assert(note.includes('автор'), 'нет пояснения про автора: ' + note);
});

await step('поиск людей и переход в личный чат', async () => {
    await reader.page.click('#btn-back');
    await reader.page.fill('#chat-search', RUN + 'author');
    await reader.page.waitForSelector('#global-results .f-item[data-user]', { timeout: 20000 });
    await reader.page.click('#global-results .f-item[data-user]');
    await reader.page.waitForSelector('#page-chat.active', { timeout: 20000 });
    const title = await reader.page.textContent('#chat-title');
    assert(title.includes('Автор'), 'заголовок личного чата: ' + title);
});

await step('переписка в личном чате', async () => {
    await reader.page.fill('#m-input', 'Здравствуйте!');
    await reader.page.click('#btn-send');
    await reader.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 20000 });

    await author.page.click('#btn-back');
    await author.page.waitForFunction(
        () => [...document.querySelectorAll('#chat-list .f-item')].some((e) => e.textContent.includes('Читатель')),
        null, { timeout: 25000 });
    await author.page.click('#chat-list .f-item:has-text("Читатель")');
    await author.page.waitForFunction(
        () => [...document.querySelectorAll('.bubble.in .text')]
            .some((e) => e.textContent.includes('Здравствуйте')), null, { timeout: 20000 });
});

await step('список сообщений не пересоздаётся при опросе сервера', async () => {
    // помечаем существующие узлы и ждём несколько циклов опроса
    await author.page.evaluate(() => {
        document.querySelectorAll('#msg-list .bubble').forEach((n, i) => { n.dataset.probe = 'p' + i; });
    });
    const before = await author.page.evaluate(() => document.querySelectorAll('#msg-list .bubble').length);
    assert(before > 0, 'в чате нет сообщений для проверки');

    await author.page.waitForTimeout(7000);   // ~3 цикла опроса

    const kept = await author.page.evaluate(
        () => [...document.querySelectorAll('#msg-list .bubble')].filter((n) => n.dataset.probe).length);
    assert(kept === before, 'узлы сообщений пересоздались: было ' + before + ', осталось ' + kept);
});

await step('выделение текста переживает обновление чата', async () => {
    await author.page.evaluate(() => {
        const node = document.querySelector('#msg-list .bubble .text');
        const range = document.createRange();
        range.selectNodeContents(node);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    });
    await author.page.waitForTimeout(5000);
    const stillSelected = await author.page.evaluate(() => window.getSelection().toString().length > 0);
    assert(stillSelected, 'выделение текста сбрасывается при обновлении');
});

await step('шифрование: сервер видит только шифртекст', async () => {
    await author.page.click('#btn-chat-menu');
    await author.page.click('#act-crypto');
    await author.page.fill('#crypto-code', 'общий-секрет-42');
    await author.page.click('#crypto-save');
    await author.page.waitForFunction(() => !document.getElementById('chat-lock').hidden, null, { timeout: 10000 });

    await author.page.fill('#m-input', 'Секретное сообщение');
    await author.page.click('#btn-send');
    await author.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 20000 });

    // читаем то, что реально лежит на сервере
    const raw = await author.page.evaluate(async () => {
        const base = window.WM.api.base;
        const room = window.WM.state.activeRoom;
        const key = window.WM_CONFIG.apiKey;
        const res = await fetch(base + '/messages?room_id=eq.' + encodeURIComponent(room) +
            '&select=text&order=created_at.desc&limit=1',
            { headers: { apikey: key, Authorization: 'Bearer ' + key } });
        return (await res.json())[0].text;
    });
    assert(raw.startsWith('wm1:'), 'сообщение ушло на сервер незашифрованным: ' + raw.slice(0, 40));
    assert(!raw.includes('Секретное'), 'в шифртексте виден исходный текст');
});

await step('без кода собеседник видит замок, с кодом — текст', async () => {
    await reader.page.waitForFunction(
        () => [...document.querySelectorAll('.bubble.in')].some((e) => e.querySelector('.locked')),
        null, { timeout: 25000 });

    await reader.page.click('#btn-chat-menu');
    await reader.page.click('#act-crypto');
    await reader.page.fill('#crypto-code', 'общий-секрет-42');
    await reader.page.click('#crypto-save');

    await reader.page.waitForFunction(
        () => [...document.querySelectorAll('.bubble.in .text')]
            .some((e) => e.textContent.includes('Секретное сообщение')), null, { timeout: 25000 });
});

await step('неверный код не расшифровывает переписку', async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/');
    await page.fill('#a-nick', RUN + 'reader');
    await page.fill('#a-pass', 'pass1234');
    await page.click('#auth-btn');
    await page.waitForSelector('#page-main.active', { timeout: 20000 });
    await page.click('#chat-list .f-item:has-text("Автор")');
    await page.click('#btn-chat-menu');
    await page.click('#act-crypto');
    await page.fill('#crypto-code', 'неправильный-код');
    await page.click('#crypto-save');
    await page.waitForFunction(
        () => [...document.querySelectorAll('.bubble')].some((e) => e.querySelector('.locked')),
        null, { timeout: 25000 });
    const leaked = await page.evaluate(
        () => document.getElementById('msg-list').textContent.includes('Секретное сообщение'));
    assert(!leaked, 'сообщение расшифровалось неверным кодом');
    await ctx.close();
});

await step('мгновенная отрисовка чата из кэша', async () => {
    await author.page.reload();
    await author.page.waitForSelector('#page-main.active', { timeout: 20000 });

    // список чатов из кэша появляется сразу после загрузки страницы
    const listAtStart = await author.page.evaluate(
        () => document.querySelectorAll('#chat-list .f-item').length);
    assert(listAtStart > 0, 'список чатов не отрисовался из кэша');

    await author.page.route('**/messages*', async (route) => {
        await new Promise((r) => setTimeout(r, 2500));      // медленный сервер
        route.continue();
    });
    await author.page.click('#chat-list .f-item:has-text("Читатель")');
    await author.page.waitForSelector('.bubble', { timeout: 1500 });   // до ответа сервера
    await author.page.unroute('**/messages*');
});

await step('переключение адреса API при смене сети', async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    // первый адрес недоступен, второй работает — приложение должно выбрать второй
    await page.route('**/api/db/**', (route) => route.abort());
    await page.goto(BASE + '/?api=' + encodeURIComponent(BASE + '/rest/v1'));
    await page.waitForSelector('#page-auth.active');
    await page.waitForFunction(
        () => window.WM && window.WM.api.base && window.WM.api.base.includes('/rest/v1'),
        null, { timeout: 20000 });
    const banner = await page.isHidden('#net-banner');
    assert(banner, 'показана плашка «нет связи», хотя рабочий адрес найден');
    await ctx.close();
});

await browser.close();
console.log('\n=== Итог: ' + (total - failures) + '/' + total + ' проверок, ошибок: ' + failures + ' ===\n');
process.exit(failures ? 1 : 0);
