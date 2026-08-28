/* ==========================================================================
 *  Проверка совместимости со «старой» базой: есть только таблицы profiles и
 *  messages, паролей-хешей и функций входа нет. Приложение должно работать,
 *  автоматически откатываясь на прямые REST-запросы.
 *
 *  Запуск:  WM_LEGACY=1 node tools/mock-postgrest.mjs 8124 &
 *           WM_BASE=http://localhost:8124 node tools/e2e-legacy.mjs
 * ========================================================================== */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = process.env.WM_BASE || 'http://localhost:8124';
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

async function signUp(nick, name, pass) {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 880 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { failures++; console.log('  ✗ JS-ошибка (' + nick + '): ' + e.message); });
    await page.goto(BASE + '/');
    await page.click('#auth-swap-btn');
    await page.fill('#a-nick', nick);
    await page.fill('#a-name', name);
    await page.fill('#a-pass', pass);
    await page.click('#auth-btn');
    await page.waitForSelector('#page-main.active', { timeout: 15000 });
    return { ctx, page };
}

console.log('\n=== WolffMsg e2e (совместимость со старой базой) ===');

let a, b;

await step('регистрация без серверных функций (fallback на REST)', async () => {
    a = await signUp('legacya', 'Лена', 'pass1234');
    b = await signUp('legacyb', 'Пётр', 'pass1234');
});

await step('повторный ник отклоняется и в старой схеме', async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/');
    await page.click('#auth-swap-btn');
    await page.fill('#a-nick', 'legacya');
    await page.fill('#a-pass', 'pass1234');
    await page.click('#auth-btn');
    await page.waitForFunction(
        () => document.getElementById('auth-status').textContent.includes('занят'), null, { timeout: 10000 });
    await ctx.close();
});

await step('переписка работает (чаты хранятся локально)', async () => {
    await a.page.click('#btn-plus');
    await a.page.click('#plus-user');
    await a.page.fill('#prompt-input', 'legacyb');
    await a.page.click('#prompt-ok');
    await a.page.waitForSelector('#page-chat.active', { timeout: 15000 });
    await a.page.fill('#m-input', 'Работает и на старой базе');
    await a.page.click('#btn-send');
    await a.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 15000 });

    await b.page.click('#btn-plus');
    await b.page.click('#plus-user');
    await b.page.fill('#prompt-input', 'legacya');
    await b.page.click('#prompt-ok');
    await b.page.waitForSelector('#page-chat.active', { timeout: 15000 });
    await b.page.waitForFunction(
        () => [...document.querySelectorAll('.bubble.in .text')]
            .some((e) => e.textContent.includes('старой базе')), null, { timeout: 20000 });
});

await step('реакции работают без таблицы reactions-владельцев', async () => {
    await b.page.click('.bubble.in');
    await b.page.waitForSelector('.reaction-picker');
    await b.page.click('.reaction-picker .emoji-btn[data-pick="👍"]');
    await b.page.waitForSelector('.bubble.in .reaction-badge.mine', { timeout: 10000 });
    await a.page.waitForFunction(
        () => !!document.querySelector('.bubble.out .reaction-badge'), null, { timeout: 20000 });
});

await step('вход по сохранённому паролю старого формата', async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/');
    await page.fill('#a-nick', 'legacya');
    await page.fill('#a-pass', 'pass1234');
    await page.click('#auth-btn');
    await page.waitForSelector('#page-main.active', { timeout: 15000 });
    await ctx.close();
});

await step('отсутствие таблиц chats/room_reads не роняет интерфейс', async () => {
    const errors = await a.page.evaluate(() => ({
        serverChats: window.WM.state.serverChats,
        previews: window.WM.state.hasPreviews
    }));
    assert(errors.serverChats === false, 'ожидался откат на локальный список чатов');
    assert(errors.previews === false, 'ожидался откат превью');
    const visible = await a.page.isVisible('#page-chat.active');
    assert(visible, 'страница чата не отображается');
});

await browser.close();
console.log('\n=== Итог: ' + (total - failures) + '/' + total + ' проверок, ошибок: ' + failures + ' ===\n');
process.exit(failures ? 1 : 0);
