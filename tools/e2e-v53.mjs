/* ==========================================================================
 *  Проверки версии 53: интерфейс над экранной клавиатурой и обсуждения
 *  под записями канала.
 * ========================================================================== */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = process.env.WM_BASE || 'http://localhost:8123';
const RUN = 'c' + Date.now().toString(36).slice(-6);
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

async function signUp(nick, name, size) {
    const ctx = await browser.newContext({
        viewport: size || { width: 390, height: 844 },
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

/* Клавиатуры в тестовом браузере нет, поэтому поднимаем интерфейс тем же
   способом, что и приложение, и проверяем, что вёрстка на это отвечает. */
async function fakeKeyboard(page, px) {
    await page.evaluate((h) => window.WM.simulateKeyboard(h), px);
    await page.waitForTimeout(320);
}

console.log('\n=== WolffMsg e2e (клавиатура и обсуждения в каналах) ===');

const blogger = await signUp(RUN + 'blog', 'Автор Блога');
const reader1 = await signUp(RUN + 'read1', 'Первый Читатель');
const reader2 = await signUp(RUN + 'read2', 'Второй Читатель');

await step('поле ввода не уходит под клавиатуру', async () => {
    await blogger.page.click('#btn-plus');
    await blogger.page.click('#plus-user');
    await blogger.page.fill('#prompt-input', RUN + 'read1');
    await blogger.page.click('#prompt-ok');
    await blogger.page.waitForSelector('#page-chat.active', { timeout: 25000 });

    const before = await blogger.page.evaluate(
        () => document.getElementById('input-bar').getBoundingClientRect().bottom);

    await fakeKeyboard(blogger.page, 300);
    const after = await blogger.page.evaluate(
        () => document.getElementById('input-bar').getBoundingClientRect().bottom);
    const viewport = await blogger.page.evaluate(() => window.innerHeight);

    assert(after <= viewport - 290, 'панель ввода осталась под клавиатурой: ' + after + ' из ' + viewport);
    assert(before - after > 250, 'панель не поднялась: было ' + before + ', стало ' + after);
});

await step('шапка чата остаётся на месте при открытой клавиатуре', async () => {
    const top = await blogger.page.evaluate(
        () => document.querySelector('#page-chat header').getBoundingClientRect().top);
    assert(Math.abs(top) < 2, 'шапка уехала: ' + top);
    const visible = await blogger.page.isVisible('#chat-title');
    assert(visible, 'заголовок чата не виден');
});

await step('модальное окно тоже помещается над клавиатурой', async () => {
    try {
        await blogger.page.click('#btn-chat-menu');
        await blogger.page.click('#act-crypto');
        await blogger.page.waitForSelector('#crypto-modal.show', { timeout: 10000 });
        await blogger.page.waitForTimeout(500);          // ждём конца анимации появления
        const box = await blogger.page.evaluate(
            () => document.querySelector('#crypto-modal .modal-sheet').getBoundingClientRect().bottom);
        const viewport = await blogger.page.evaluate(() => window.innerHeight);
        assert(box <= viewport - 290, 'окно закрыто клавиатурой: ' + box + ' из ' + viewport);
    } finally {
        await blogger.page.evaluate(
            () => document.getElementById('crypto-modal').classList.remove('show'));
        await fakeKeyboard(blogger.page, 0);
    }
});

await step('поля ввода не вызывают увеличение страницы на iPhone', async () => {
    const sizes = await blogger.page.evaluate(() => {
        const ids = ['m-input', 'a-nick', 'chat-search', 'prompt-input'];
        return ids.map((id) => {
            const el = document.getElementById(id);
            return el ? parseFloat(getComputedStyle(el).fontSize) : 16;
        });
    });
    sizes.forEach(function (size, i) {
        assert(size >= 16, 'поле №' + (i + 1) + ' со шрифтом ' + size + 'px — iOS увеличит страницу');
    });
});

await step('на низком экране виден и список, и поле ввода', async () => {
    const small = await browser.newContext({ viewport: { width: 360, height: 420 }, serviceWorkers: 'block' });
    const page = await small.newPage();
    await page.goto(BASE + '/');
    await page.fill('#a-nick', RUN + 'blog');
    await page.fill('#a-pass', 'pass1234');
    await page.click('#auth-btn');
    await page.waitForSelector('#page-main.active', { timeout: 25000 });
    await page.click('#chat-list .f-item');
    await page.waitForSelector('#page-chat.active', { timeout: 20000 });

    const fits = await page.evaluate(() => {
        const bar = document.getElementById('input-bar').getBoundingClientRect();
        const list = document.getElementById('msg-list').getBoundingClientRect();
        return bar.bottom <= window.innerHeight + 1 && list.height > 40 && bar.top >= list.bottom - 1;
    });
    assert(fits, 'на низком экране интерфейс не помещается');
    await small.close();
});

await step('канал: автор публикует запись', async () => {
    await blogger.page.click('#btn-back');
    await blogger.page.click('#btn-plus');
    await blogger.page.click('#plus-channel');
    await blogger.page.fill('#ch-title', 'Дневник разработки');
    await blogger.page.fill('#ch-slug', RUN + 'devlog');
    await blogger.page.click('#ch-create');
    await blogger.page.waitForSelector('#page-chat.active', { timeout: 25000 });

    await blogger.page.fill('#m-input', 'Вышла новая версия приложения');
    await blogger.page.click('#btn-send');
    await blogger.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 25000 });
    await blogger.page.waitForSelector('.post-foot', { timeout: 20000 });
    const foot = await blogger.page.textContent('.post-foot');
    assert(foot.includes('Комментировать'), 'нет приглашения к обсуждению: ' + foot);
});

async function subscribe(user) {
    await user.page.fill('#chat-search', 'Дневник');
    await user.page.waitForSelector('#global-results .f-item[data-channel]', { timeout: 25000 });
    await user.page.click('#global-results .f-item[data-channel]');
    await user.page.waitForSelector('#page-chat.active', { timeout: 25000 });
    await user.page.waitForSelector('.bubble.in', { timeout: 25000 });
    await user.page.click('#btn-join');                    // подписка только по кнопке
    await user.page.waitForFunction(
        () => document.getElementById('btn-join').hidden, null, { timeout: 25000 });
}

await step('двое подписываются на канал', async () => {
    await subscribe(reader1);
    await subscribe(reader2);
    const barHidden = await reader1.page.isHidden('#input-bar');
    assert(barHidden, 'подписчику доступна публикация в канале');
});

await step('подписчики комментируют запись', async () => {
    await reader1.page.click('.post-foot');
    await reader1.page.waitForFunction(
        () => document.getElementById('chat-title').textContent.includes('Комментарии'),
        null, { timeout: 20000 });
    const canWrite = await reader1.page.isVisible('#input-bar');
    assert(canWrite, 'в обсуждении нельзя писать');

    await reader1.page.fill('#m-input', 'Отличная новость!');
    await reader1.page.click('#btn-send');
    await reader1.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 25000 });

    await reader2.page.click('.post-foot');
    await reader2.page.waitForFunction(
        () => [...document.querySelectorAll('.bubble.in .text')]
            .some((e) => e.textContent.includes('Отличная новость')), null, { timeout: 25000 });
    await reader2.page.fill('#m-input', 'Присоединяюсь, ждём продолжения');
    await reader2.page.click('#btn-send');
    await reader2.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 25000 });
});

await step('в обсуждении видно, кто автор каждого комментария', async () => {
    await reader1.page.waitForFunction(
        () => [...document.querySelectorAll('.bubble.in .author')]
            .some((e) => e.textContent.includes('Второй')), null, { timeout: 25000 });
});

await step('автор канала отвечает в обсуждении', async () => {
    await blogger.page.waitForFunction(
        () => {
            const foot = document.querySelector('.post-foot');
            return foot && /коммент/.test(foot.textContent);
        }, null, { timeout: 30000 });
    const foot = await blogger.page.textContent('.post-foot');
    assert(/2 коммент/.test(foot), 'счётчик комментариев: ' + foot);

    await blogger.page.click('.post-foot');
    await blogger.page.waitForSelector('.bubble.in', { timeout: 25000 });
    await blogger.page.fill('#m-input', 'Спасибо! Продолжение на следующей неделе');
    await blogger.page.click('#btn-send');
    await blogger.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 25000 });

    await reader1.page.waitForFunction(
        () => [...document.querySelectorAll('.bubble.in .text')]
            .some((e) => e.textContent.includes('Продолжение на следующей неделе')),
        null, { timeout: 30000 });
});

await step('кнопка «назад» из обсуждения возвращает в канал', async () => {
    await reader1.page.click('#btn-back');
    await reader1.page.waitForFunction(
        () => document.getElementById('chat-title').textContent.includes('Дневник'),
        null, { timeout: 20000 });
    await reader1.page.waitForSelector('.post-foot', { timeout: 20000 });
});

await step('обсуждение не появляется отдельным чатом в списке', async () => {
    await reader1.page.click('#btn-back');
    await reader1.page.waitForSelector('#page-main.active', { timeout: 20000 });
    await reader1.page.waitForTimeout(6000);
    const names = await reader1.page.evaluate(
        () => [...document.querySelectorAll('#chat-list .f-item b')].map((e) => e.textContent));
    assert(!names.some((n) => n.includes('Комментарии')), 'обсуждение попало в список чатов: ' + names.join(', '));
});

await step('в канале нельзя писать напрямую даже через интерфейс', async () => {
    await reader1.page.click('#chat-list .f-item:has-text("Дневник")');
    await reader1.page.waitForSelector('#page-chat.active', { timeout: 20000 });
    const hidden = await reader1.page.isHidden('#input-bar');
    assert(hidden, 'подписчику показана строка публикации в канале');
    const note = await reader1.page.textContent('#channel-note');
    assert(note.includes('автор'), 'нет пояснения: ' + note);
});

await browser.close();
console.log('\n=== Итог: ' + (total - failures) + '/' + total + ' проверок, ошибок: ' + failures + ' ===\n');
process.exit(failures ? 1 : 0);
