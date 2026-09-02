/* ==========================================================================
 *  Сквозной тест интерфейса: два пользователя в двух независимых браузерных
 *  контекстах переписываются через локальный стенд.
 *
 *  Запуск:  node tools/mock-postgrest.mjs 8123 &   node tools/e2e.mjs
 * ========================================================================== */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = process.env.WM_BASE || 'http://localhost:8123';
const results = [];
let failures = 0;

async function step(name, fn) {
    try {
        await fn();
        results.push('  ✓ ' + name);
        console.log('  ✓ ' + name);
    } catch (err) {
        failures++;
        results.push('  ✗ ' + name + ' — ' + err.message);
        console.log('  ✗ ' + name + ' — ' + err.message);
    }
}

function assert(cond, message) {
    if (!cond) throw new Error(message);
}

async function newUser(browser, nick, name, pass) {
    const context = await browser.newContext({
        viewport: { width: 420, height: 880 },
        serviceWorkers: 'block'
    });
    const page = await context.newPage();
    page.on('pageerror', (err) => {
        failures++;
        console.log('  ✗ JS-ошибка на странице (' + nick + '): ' + err.message);
    });
    page.on('console', (msg) => {
        if (msg.type() === 'error') console.log('  · console.error (' + nick + '): ' + msg.text());
    });

    await page.goto(BASE + '/');
    await page.waitForSelector('#page-auth.active');
    await page.click('#auth-swap-btn');
    await page.fill('#a-nick', nick);
    await page.fill('#a-name', name);
    await page.fill('#a-pass', pass);
    await page.click('#auth-btn');
    await page.waitForSelector('#page-main.active', { timeout: 15000 });
    return { context, page };
}

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox']
});

console.log('\n=== WolffMsg e2e ===');

let alice, bob;

await step('регистрация первого пользователя', async () => {
    alice = await newUser(browser, 'alisa', 'Алиса Волкова', 'pass1234');
    const greeting = await alice.page.textContent('#main-greeting');
    assert(/Алиса/.test(greeting), 'приветствие без имени: ' + greeting);
});

await step('регистрация второго пользователя', async () => {
    bob = await newUser(browser, 'boris', 'Борис', 'qwerty12');
});

await step('повторная регистрация того же ника отклоняется', async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/');
    await page.click('#auth-swap-btn');
    await page.fill('#a-nick', 'alisa');
    await page.fill('#a-pass', 'pass1234');
    await page.click('#auth-btn');
    await page.waitForFunction(() => document.getElementById('auth-status').textContent.includes('занят'),
        null, { timeout: 10000 });
    await ctx.close();
});

await step('вход с неверным паролем отклоняется', async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/');
    await page.fill('#a-nick', 'alisa');
    await page.fill('#a-pass', 'wrong');
    await page.click('#auth-btn');
    await page.waitForFunction(() => /Неверный/.test(document.getElementById('auth-status').textContent),
        null, { timeout: 10000 });
    await ctx.close();
});

await step('Алиса добавляет Бориса в чат', async () => {
    await alice.page.click('#btn-plus');
    await alice.page.click('#plus-user');
    await alice.page.fill('#prompt-input', '@boris');
    await alice.page.click('#prompt-ok');
    await alice.page.waitForSelector('#page-chat.active', { timeout: 15000 });
    const title = await alice.page.textContent('#chat-title');
    assert(title.includes('Борис'), 'заголовок чата: ' + title);
});

await step('Алиса отправляет сообщение', async () => {
    await alice.page.fill('#m-input', 'Привет, Борис!');
    await alice.page.click('#btn-send');
    await alice.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 15000 });
    const text = await alice.page.textContent('.bubble.out .text');
    assert(text === 'Привет, Борис!', 'текст сообщения: ' + text);
});

await step('у Бориса появляется чат с непрочитанным', async () => {
    // Первым в списке всегда стоит личный раздел «Избранное», поэтому ищем
    // чат по имени собеседника, а не по позиции.
    await bob.page.waitForFunction(() => {
        const item = [...document.querySelectorAll('#chat-list .f-item')]
            .find((e) => e.textContent.includes('Алиса'));
        return item && item.querySelector('.badge').textContent === '1';
    }, null, { timeout: 20000 });
    const preview = await bob.page.textContent('#chat-list .f-item:has-text("Алиса") .chat-info small');
    assert(preview.includes('Привет'), 'превью: ' + preview);
});

await step('Борис читает и отвечает', async () => {
    await bob.page.click('#chat-list .f-item:has-text("Алиса")');
    await bob.page.waitForSelector('.bubble.in', { timeout: 15000 });
    const incoming = await bob.page.textContent('.bubble.in .text');
    assert(incoming === 'Привет, Борис!', 'входящее: ' + incoming);
    await bob.page.fill('#m-input', 'Здорово! Как дела?');
    await bob.page.click('#btn-send');
    await bob.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 15000 });
});

await step('Алиса видит ответ без перезагрузки', async () => {
    await alice.page.waitForFunction(
        () => [...document.querySelectorAll('.bubble.in .text')].some((e) => e.textContent.includes('Здорово')),
        null, { timeout: 20000 });
});

await step('галочки становятся «прочитано»', async () => {
    await alice.page.waitForFunction(
        () => !!document.querySelector('.bubble.out .status-icon.status-read'),
        null, { timeout: 20000 });
});

await step('реакция ставится и видна собеседнику', async () => {
    await alice.page.click('.bubble.in', { button: 'right' });
    await alice.page.waitForSelector('.msg-menu');
    await alice.page.click('.msg-menu .emoji-btn[data-pick="🔥"]');
    await alice.page.waitForSelector('.bubble.in .reaction-badge.mine', { timeout: 10000 });
    await bob.page.waitForFunction(
        () => {
            const b = document.querySelector('.bubble.out .reaction-badge');
            return b && b.textContent.includes('🔥') && b.textContent.includes('1');
        }, null, { timeout: 20000 });
});

await step('повторный выбор той же реакции снимает её', async () => {
    await alice.page.click('.bubble.in', { button: 'right' });
    await alice.page.waitForSelector('.msg-menu .emoji-btn.chosen');
    await alice.page.click('.msg-menu .emoji-btn.chosen');
    await alice.page.waitForFunction(
        () => !document.querySelector('.bubble.in .reaction-badge'), null, { timeout: 10000 });
});

await step('длинное сообщение и перенос строк не ломают верстку', async () => {
    await alice.page.fill('#m-input', 'Строка 1\nСтрока 2 <script>alert(1)</script>');
    await alice.page.press('#m-input', 'Enter');
    await alice.page.waitForFunction(
        () => [...document.querySelectorAll('.bubble.out .text')]
            .some((e) => e.innerHTML.includes('&lt;script&gt;') && e.innerHTML.includes('<br>')),
        null, { timeout: 15000 });
    const scrollX = await alice.page.evaluate(() => document.body.scrollWidth > window.innerWidth + 1);
    assert(!scrollX, 'появилась горизонтальная прокрутка');
});

await step('удаление своего сообщения', async () => {
    const before = await alice.page.locator('.bubble.out').count();
    await alice.page.locator('.bubble.out').last().click({ button: 'right' });
    await alice.page.waitForSelector('.msg-menu .menu-item[data-act="delete"]');
    await alice.page.click('.msg-menu .menu-item[data-act="delete"]');
    await alice.page.waitForSelector('#confirm-modal.show', { timeout: 10000 });
    await alice.page.click('#confirm-ok');
    await alice.page.waitForFunction(
        (n) => document.querySelectorAll('.bubble.out').length === n - 1, before, { timeout: 15000 });
});

await step('смена темы сохраняется после перезагрузки', async () => {
    await alice.page.click('#btn-back');
    await alice.page.click('#btn-settings');
    await alice.page.waitForSelector('#page-settings.active');
    await alice.page.click('.theme-card[data-theme="dusk"]');
    await alice.page.waitForFunction(() => document.body.className === 'theme-dusk');
    await alice.page.reload();
    await alice.page.waitForSelector('#page-main.active', { timeout: 15000 });
    const cls = await alice.page.evaluate(() => document.body.className);
    assert(cls === 'theme-dusk', 'после перезагрузки: ' + cls);
});

await step('сессия сохраняется между перезагрузками', async () => {
    const greeting = await alice.page.textContent('#main-greeting');
    assert(/Алиса/.test(greeting), 'после перезагрузки нет входа: ' + greeting);
});

await step('групповой чат: создание, участник, сообщение', async () => {
    await alice.page.click('#btn-plus');
    await alice.page.click('#plus-group');
    await alice.page.fill('#prompt-input', 'Стая');
    await alice.page.click('#prompt-ok');
    await alice.page.waitForSelector('#page-chat.active', { timeout: 15000 });

    await alice.page.click('#btn-chat-menu');
    await alice.page.click('#act-invite');
    await alice.page.fill('#prompt-input', 'boris');
    await alice.page.click('#prompt-ok');
    await alice.page.waitForFunction(
        () => document.getElementById('chat-subtitle').textContent.includes('2'), null, { timeout: 15000 });

    await alice.page.fill('#m-input', 'Всем привет!');
    await alice.page.click('#btn-send');

    await bob.page.click('#btn-back');
    await bob.page.waitForFunction(
        () => [...document.querySelectorAll('#chat-list .f-item')].some((e) => e.textContent.includes('Стая')),
        null, { timeout: 25000 });
});

await step('в группе показывается автор входящего сообщения', async () => {
    await bob.page.click('#chat-list .f-item:has-text("Стая")');
    await bob.page.waitForSelector('.bubble.in .author', { timeout: 20000 });
    const author = await bob.page.textContent('.bubble.in .author');
    assert(author.includes('Алиса'), 'автор: ' + author);
});

await step('поиск по списку чатов', async () => {
    await bob.page.click('#btn-back');
    await bob.page.fill('#chat-search', 'ста');
    await bob.page.waitForFunction(
        () => document.querySelectorAll('#chat-list .f-item').length === 1, null, { timeout: 10000 });
    await bob.page.fill('#chat-search', '');
    await bob.page.waitForFunction(
        () => document.querySelectorAll('#chat-list .f-item').length === 4, null, { timeout: 10000 });
});

await step('закрепление чата поднимает его наверх', async () => {
    await bob.page.locator('#chat-list .f-item:has-text("Алиса")').dispatchEvent('mousedown');
    await bob.page.waitForSelector('#context-bar.show', { timeout: 5000 });
    await bob.page.click('#ctx-pin');
    // Личные разделы («Избранное», WolffAI) всегда сверху, а среди обычных
    // чатов закреплённый поднимается выше остальных.
    await bob.page.waitForFunction(() => {
        const rows = [...document.querySelectorAll('#chat-list .f-item')].map((e) => e.textContent);
        const pinned = rows.findIndex((t) => t.includes('Алиса'));
        const other = rows.findIndex((t) => t.includes('Стая'));
        return pinned >= 0 && other >= 0 && pinned < other && rows[pinned].includes('📌');
    }, null, { timeout: 10000 });
});

await step('очистка истории удаляет сообщения у обоих', async () => {
    await bob.page.click('#chat-list .f-item:has-text("Алиса")');
    await bob.page.waitForSelector('.bubble', { timeout: 15000 });
    await bob.page.click('#btn-chat-menu');
    await bob.page.click('#act-clear');
    await bob.page.click('#confirm-ok');
    await bob.page.waitForFunction(
        () => !document.querySelector('.bubble'), null, { timeout: 15000 });
    if (await alice.page.isVisible('#page-chat.active')) await alice.page.click('#btn-back');
    await alice.page.waitForSelector('#page-main.active');
    await alice.page.click('#chat-list .f-item:has-text("Борис")');
    await alice.page.waitForFunction(
        () => !document.querySelector('.bubble'), null, { timeout: 25000 });
});

await step('удаление чата убирает его из списка', async () => {
    await alice.page.click('#btn-chat-menu');
    await alice.page.click('#act-delete');
    await alice.page.click('#confirm-ok');
    await alice.page.waitForSelector('#page-main.active', { timeout: 15000 });
    await alice.page.waitForFunction(
        () => ![...document.querySelectorAll('#chat-list .f-item')].some((e) => e.textContent.includes('Борис')),
        null, { timeout: 15000 });
});

await step('смена имени в настройках', async () => {
    await alice.page.click('#btn-settings');
    await alice.page.click('#set-name');
    await alice.page.fill('#prompt-input', 'Алиса В.');
    await alice.page.click('#prompt-ok');
    await alice.page.waitForFunction(
        () => document.getElementById('s-name').textContent === 'Алиса В.', null, { timeout: 15000 });
});

await step('смена пароля и вход с новым паролем', async () => {
    await alice.page.click('#set-pass');
    await alice.page.fill('#prompt-input', 'pass1234');
    await alice.page.click('#prompt-ok');
    await alice.page.fill('#prompt-input', 'newpass99');
    await alice.page.click('#prompt-ok');
    await alice.page.waitForFunction(
        () => document.getElementById('toast').textContent.includes('Пароль изменён'), null, { timeout: 15000 });

    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/');
    await page.fill('#a-nick', 'alisa');
    await page.fill('#a-pass', 'newpass99');
    await page.click('#auth-btn');
    await page.waitForSelector('#page-main.active', { timeout: 15000 });
    await ctx.close();
});

await step('выход из аккаунта возвращает на экран входа', async () => {
    await alice.page.click('#set-logout');
    await alice.page.click('#confirm-ok');
    await alice.page.waitForSelector('#page-auth.active', { timeout: 15000 });
});

await step('недоступный сервер показывает баннер, а не белый экран', async () => {
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.route('**/rest/v1/**', (route) => route.abort());
    await page.route('**/api/db/**', (route) => route.abort());
    await page.goto(BASE + '/?api=' + encodeURIComponent(BASE + '/rest/v1'));
    await page.waitForSelector('#net-banner:not([hidden])', { timeout: 25000 });
    const visible = await page.isVisible('#page-auth');
    assert(visible, 'экран входа не отрисовался при недоступном сервере');
    await ctx.close();
});

await step('скриншоты интерфейса', async () => {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 880 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/');
    await page.fill('#a-nick', 'boris');
    await page.fill('#a-pass', 'qwerty12');
    await page.click('#auth-btn');
    await page.waitForSelector('#page-main.active', { timeout: 15000 });
    await page.screenshot({ path: '/tmp/wm-list.png' });
    await page.click('#chat-list .f-item:has-text("Стая")');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: '/tmp/wm-chat.png' });
    await page.click('#btn-back');
    await page.click('#btn-settings');
    await page.waitForTimeout(400);
    await page.screenshot({ path: '/tmp/wm-settings.png' });
    await ctx.close();
});

await browser.close();

console.log('\n=== Итог: ' + (results.length - failures) + '/' + results.length +
    ' проверок пройдено, ошибок: ' + failures + ' ===\n');
process.exit(failures ? 1 : 0);
