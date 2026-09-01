/* ==========================================================================
 *  Проверки версии 51: одна реакция на человека, список авторов реакций,
 *  ответы на сообщения, профиль, поведение прокрутки, темы и создание канала
 *  на базе прошлой версии.
 * ========================================================================== */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = process.env.WM_BASE || 'http://localhost:8123';
const OLD_BASE = process.env.WM_BASE_OLD || 'http://localhost:8127';
const RUN = 'w' + Date.now().toString(36).slice(-6);
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

async function signUp(base, nick, name) {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 880 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { failures++; console.log('  ✗ JS-ошибка (' + nick + '): ' + e.message); });
    await page.goto(base + '/');
    await page.click('#auth-swap-btn');
    await page.fill('#a-nick', nick);
    await page.fill('#a-name', name);
    await page.fill('#a-pass', 'pass1234');
    await page.click('#auth-btn');
    await page.waitForSelector('#page-main.active', { timeout: 20000 });
    return { ctx, page };
}

console.log('\n=== WolffMsg e2e (реакции, ответы, профиль, прокрутка, темы) ===');

const anna = await signUp(BASE, RUN + 'anna', 'Анна Лис');
const oleg = await signUp(BASE, RUN + 'oleg', 'Олег Волк');

await step('личный чат и первое сообщение', async () => {
    await anna.page.click('#btn-plus');
    await anna.page.click('#plus-user');
    await anna.page.fill('#prompt-input', RUN + 'oleg');
    await anna.page.click('#prompt-ok');
    await anna.page.waitForSelector('#page-chat.active', { timeout: 20000 });
    await anna.page.fill('#m-input', 'Первое сообщение');
    await anna.page.click('#btn-send');
    await anna.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 20000 });

    await oleg.page.waitForFunction(
        () => [...document.querySelectorAll('#chat-list .f-item')].some((e) => e.textContent.includes('Анна')),
        null, { timeout: 25000 });
    await oleg.page.click('#chat-list .f-item:has-text("Анна")');
    await oleg.page.waitForSelector('.bubble.in', { timeout: 20000 });
});

await step('от человека остаётся только одна реакция', async () => {
    await oleg.page.click('.bubble.in');
    await oleg.page.click('.msg-menu .emoji-btn[data-pick="👍"]');
    await oleg.page.waitForSelector('.bubble.in .reaction-badge.mine', { timeout: 15000 });

    await oleg.page.click('.bubble.in');
    await oleg.page.click('.msg-menu .emoji-btn[data-pick="❤️"]');
    await oleg.page.waitForFunction(() => {
        const badges = document.querySelectorAll('.bubble.in .reaction-badge');
        return badges.length === 1 && badges[0].textContent.includes('❤️');
    }, null, { timeout: 15000 });

    const count = await oleg.page.textContent('.bubble.in .reaction-count');
    assert(count === '1', 'счётчик реакции: ' + count);
});

await step('видно, кто оставил реакцию', async () => {
    await anna.page.waitForSelector('.bubble.out .reaction-badge', { timeout: 25000 });
    await anna.page.click('.bubble.out .reaction-badge');
    await anna.page.waitForSelector('#reactions-modal.show .reaction-user', { timeout: 15000 });
    const row = await anna.page.textContent('#reactions-modal .reaction-user');
    assert(row.includes('Олег'), 'в списке реакций нет автора: ' + row);
    assert(row.includes('❤️'), 'в списке нет эмодзи: ' + row);
});

await step('из списка реакций открывается профиль', async () => {
    await anna.page.click('#reactions-modal .reaction-user');
    await anna.page.waitForSelector('#profile-modal.show', { timeout: 10000 });
    const name = await anna.page.textContent('#pf-name');
    assert(name.includes('Олег'), 'профиль: ' + name);
    await anna.page.click('#pf-close');
});

await step('профиль собеседника открывается из шапки чата', async () => {
    await anna.page.click('#chat-head');
    await anna.page.waitForSelector('#profile-modal.show', { timeout: 10000 });
    const nick = await anna.page.textContent('#pf-nick');
    assert(nick.includes(RUN + 'oleg'), 'никнейм в профиле: ' + nick);
    await anna.page.click('#pf-close');
});

await step('меню закрывается и не накапливается', async () => {
    await oleg.page.click('.bubble.in .text');
    await oleg.page.waitForSelector('.msg-menu', { timeout: 10000 });

    await oleg.page.click('#msg-list', { position: { x: 200, y: 20 } });   // клик мимо
    await oleg.page.waitForFunction(
        () => document.querySelectorAll('.msg-menu').length === 0, null, { timeout: 10000 });

    await oleg.page.click('.bubble.in .text');
    await oleg.page.click('.bubble.in .text');
    await oleg.page.waitForTimeout(400);
    const menus = await oleg.page.locator('.msg-menu').count();
    assert(menus <= 1, 'одновременно открыто меню: ' + menus);

    await oleg.page.click('#msg-list', { position: { x: 200, y: 20 } });
    await oleg.page.waitForTimeout(200);
});

await step('ответ на сообщение с цитатой', async () => {
    await oleg.page.click('.bubble.in');
    await oleg.page.click('.msg-menu .menu-item[data-act="reply"]');
    await oleg.page.waitForSelector('#reply-bar:not([hidden])', { timeout: 10000 });
    const preview = await oleg.page.textContent('#reply-preview');
    assert(preview.includes('Первое'), 'цитата в панели ответа: ' + preview);

    await oleg.page.fill('#m-input', 'Отвечаю на первое');
    await oleg.page.click('#btn-send');
    await oleg.page.waitForSelector('.bubble.out .quote', { timeout: 20000 });
    const hidden = await oleg.page.isHidden('#reply-bar');
    assert(hidden, 'панель ответа не закрылась после отправки');

    await anna.page.waitForFunction(
        () => [...document.querySelectorAll('.bubble.in .quote')].length > 0, null, { timeout: 25000 });
    const quote = await anna.page.textContent('.bubble.in .quote');
    assert(quote.includes('Первое'), 'цитата у собеседника: ' + quote);
});

await step('клик по цитате подсвечивает исходное сообщение', async () => {
    await anna.page.click('.bubble.in .quote');
    await anna.page.waitForSelector('.bubble.flash', { timeout: 10000 });
});

await step('чат не прокручивается, пока читаешь историю', async () => {
    // набиваем историю, чтобы появилась прокрутка
    for (let i = 1; i <= 14; i++) {
        await anna.page.fill('#m-input', 'Сообщение истории №' + i);
        await anna.page.press('#m-input', 'Enter');
        await anna.page.waitForTimeout(120);
    }
    await anna.page.waitForTimeout(1500);

    await anna.page.evaluate(() => { document.getElementById('msg-list').scrollTop = 0; });
    await anna.page.waitForTimeout(300);
    const before = await anna.page.evaluate(() => document.getElementById('msg-list').scrollTop);

    await oleg.page.fill('#m-input', 'Новое сообщение сверху');
    await oleg.page.click('#btn-send');
    await anna.page.waitForTimeout(6000);   // несколько циклов опроса

    const after = await anna.page.evaluate(() => document.getElementById('msg-list').scrollTop);
    assert(Math.abs(after - before) < 30, 'чат самопроизвольно прокрутился: ' + before + ' → ' + after);
});

await step('кнопка «вниз» показывает число новых и прокручивает', async () => {
    await anna.page.waitForSelector('#scroll-pill:not([hidden])', { timeout: 15000 });
    const count = await anna.page.textContent('#scroll-count');
    assert(Number(count) >= 1, 'счётчик новых сообщений: ' + count);
    await anna.page.click('#scroll-pill');
    await anna.page.waitForFunction(() => {
        const b = document.getElementById('msg-list');
        return b.scrollHeight - b.scrollTop - b.clientHeight < 140;
    }, null, { timeout: 10000 });
    await anna.page.waitForFunction(
        () => document.getElementById('scroll-pill').hidden, null, { timeout: 10000 });
});

await step('своё сообщение всегда прокручивает чат вниз', async () => {
    await anna.page.evaluate(() => { document.getElementById('msg-list').scrollTop = 0; });
    await anna.page.fill('#m-input', 'Своё сообщение');
    await anna.page.press('#m-input', 'Enter');
    await anna.page.waitForFunction(() => {
        const b = document.getElementById('msg-list');
        return b.scrollHeight - b.scrollTop - b.clientHeight < 140;
    }, null, { timeout: 10000 });
});

await step('шесть тем, выбор сохраняется', async () => {
    await anna.page.click('#btn-back');
    await anna.page.click('#btn-settings');
    await anna.page.waitForSelector('#page-settings.active');
    const count = await anna.page.locator('.theme-card').count();
    assert(count === 6, 'тем в списке: ' + count);

    for (const id of ['light', 'sand', 'dusk', 'moss', 'fog', 'dark']) {
        await anna.page.click('.theme-card[data-theme="' + id + '"]');
        await anna.page.waitForFunction(
            (t) => document.body.className === 'theme-' + t, id, { timeout: 5000 });
        // фон должен реально меняться вместе с темой
        const bg = await anna.page.evaluate(
            () => getComputedStyle(document.body).backgroundColor);
        assert(bg && bg !== 'rgba(0, 0, 0, 0)', 'тема ' + id + ' без фона');
    }

    await anna.page.click('.theme-card[data-theme="fog"]');
    await anna.page.reload();
    await anna.page.waitForSelector('#page-main.active', { timeout: 20000 });
    const cls = await anna.page.evaluate(() => document.body.className);
    assert(cls === 'theme-fog', 'после перезагрузки тема: ' + cls);
});

await step('подпись в настройках — WolffMsg global', async () => {
    await anna.page.click('#btn-settings');
    const version = await anna.page.textContent('.version');
    assert(version.trim() === 'WolffMsg global', 'подпись: ' + version);
});

await step('свой профиль открывается из настроек', async () => {
    await anna.page.click('#set-profile');
    await anna.page.waitForSelector('#profile-modal.show', { timeout: 10000 });
    const extra = await anna.page.textContent('#pf-extra');
    assert(extra.includes('ваш профиль'), 'подпись своего профиля: ' + extra);
    const writeHidden = await anna.page.isHidden('#pf-write');
    assert(writeHidden, 'у своего профиля показана кнопка «Написать»');
    await anna.page.click('#pf-close');
});

await step('в канале список авторов реакций не открывается', async () => {
    await anna.page.click('#btn-settings-done');
    await anna.page.click('#btn-plus');
    await anna.page.click('#plus-channel');
    await anna.page.fill('#ch-title', 'Канал реакций');
    await anna.page.fill('#ch-slug', RUN + 'chan');
    await anna.page.click('#ch-create');
    await anna.page.waitForSelector('#page-chat.active', { timeout: 20000 });

    await anna.page.fill('#m-input', 'Пост канала');
    await anna.page.click('#btn-send');
    await anna.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 20000 });

    await anna.page.click('.bubble.out');
    await anna.page.waitForSelector('.msg-menu', { timeout: 10000 });
    const hasWho = await anna.page.locator('.msg-menu .menu-item[data-act="who"]').count();
    assert(hasWho === 0, 'в канале предложено смотреть авторов реакций');
    await anna.page.click('.msg-menu .emoji-btn[data-pick="🔥"]');
    await anna.page.waitForSelector('.bubble.out .reaction-badge', { timeout: 15000 });

    await anna.page.click('.bubble.out .reaction-badge');
    await anna.page.waitForTimeout(700);
    const modalShown = await anna.page.isVisible('#reactions-modal.show');
    assert(!modalShown, 'в канале открылся список авторов реакций');
});

await step('канал создаётся и на базе прошлой версии', async () => {
    const legacy = await signUp(OLD_BASE, RUN + 'old', 'Старая База');
    await legacy.page.click('#btn-plus');
    await legacy.page.click('#plus-channel');
    await legacy.page.fill('#ch-title', 'Канал на старой базе');
    await legacy.page.fill('#ch-slug', RUN + 'oldchan');
    await legacy.page.click('#ch-create');
    await legacy.page.waitForSelector('#page-chat.active', { timeout: 25000 });
    const title = await legacy.page.textContent('#chat-title');
    assert(title.includes('Канал на старой базе'), 'заголовок канала: ' + title);

    await legacy.page.fill('#m-input', 'Работает и здесь');
    await legacy.page.click('#btn-send');
    await legacy.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 20000 });
    await legacy.ctx.close();
});

await browser.close();
console.log('\n=== Итог: ' + (total - failures) + '/' + total + ' проверок, ошибок: ' + failures + ' ===\n');
process.exit(failures ? 1 : 0);
