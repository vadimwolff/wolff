/* ==========================================================================
 *  Проверка поведения сразу после применения db/schema.sql: прямая запись в
 *  profiles уже запрещена правами, а кеш REST-API ещё отдаёт 404 на функции
 *  входа. Раньше это давало пользователю сырую ошибку Postgres
 *  «permission denied for table profiles».
 *
 *  Запуск: WM_DENY=warmup node tools/mock-postgrest.mjs 8125 &
 *          WM_DENY=always node tools/mock-postgrest.mjs 8126 &
 *          node tools/e2e-schema.mjs
 * ========================================================================== */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const WARMUP = process.env.WM_BASE_WARMUP || 'http://localhost:8125';
const ALWAYS = process.env.WM_BASE_ALWAYS || 'http://localhost:8126';
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

async function tryRegister(base, nick) {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 880 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(base + '/');
    await page.click('#auth-swap-btn');
    await page.fill('#a-nick', nick);
    await page.fill('#a-name', 'Тестовый');
    await page.fill('#a-pass', 'pass1234');
    await page.click('#auth-btn');
    return { ctx, page };
}

console.log('\n=== WolffMsg e2e (состояние базы сразу после schema.sql) ===');

// ники уникальны для запуска, чтобы прогон не зависел от данных прошлого
const RUN = 'u' + Date.now().toString(36);

await step('кеш API прогревается: регистрация всё равно проходит', async () => {
    const { ctx, page } = await tryRegister(WARMUP, RUN + 'a');
    await page.waitForSelector('#page-main.active', { timeout: 20000 });
    await ctx.close();
});

await step('кеш API не обновился: вместо ошибки Postgres — понятная подсказка', async () => {
    const { ctx, page } = await tryRegister(ALWAYS, RUN + 'b');
    await page.waitForFunction(
        () => /schema\.sql/.test(document.getElementById('auth-status').textContent),
        null, { timeout: 25000 });
    const text = await page.textContent('#auth-status');
    assert(!/permission denied/i.test(text), 'пользователю всё ещё видна сырая ошибка Postgres: ' + text);
    assert(/reload schema/.test(text), 'в подсказке нет команды обновления кеша: ' + text);
    await ctx.close();
});

await step('вход в том же состоянии тоже даёт подсказку, а не ошибку прав', async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(ALWAYS + '/');
    await page.fill('#a-nick', RUN + 'b');
    await page.fill('#a-pass', 'pass1234');
    await page.click('#auth-btn');
    await page.waitForFunction(
        () => /schema\.sql/.test(document.getElementById('auth-status').textContent),
        null, { timeout: 25000 });
    await ctx.close();
});

await browser.close();
console.log('\n=== Итог: ' + (total - failures) + '/' + total + ' проверок, ошибок: ' + failures + ' ===\n');
process.exit(failures ? 1 : 0);
