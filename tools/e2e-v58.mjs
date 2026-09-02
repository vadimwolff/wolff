/* ==========================================================================
 *  Проверки версии 58: статус «в сети» и его скрытие, меню по одному
 *  нажатию, подтверждение удаления, несколько фотографий и видео за раз,
 *  а также поиск сервера помощника и отсутствие ключа базы в запросах.
 * ========================================================================== */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = process.env.WM_BASE || 'http://localhost:8123';
const RUN = 'r' + Date.now().toString(36).slice(-6);
let total = 0, failures = 0;

async function step(name, fn) {
    total++;
    try { await fn(); console.log('  ✓ ' + name); }
    catch (err) { failures++; console.log('  ✗ ' + name + ' — ' + err.message); }
}

function assert(cond, message) { if (!cond) throw new Error(message); }

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required']
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

console.log('\n=== WolffMsg e2e (статусы, меню, удаление, видео и ключи) ===');

const sonya = await signUp(RUN + 'sonya', 'Соня');
const timur = await signUp(RUN + 'timur', 'Тимур');

await step('личный чат создан', async () => {
    await sonya.page.click('#btn-plus');
    await sonya.page.click('#plus-user');
    await sonya.page.fill('#prompt-input', RUN + 'timur');
    await sonya.page.click('#prompt-ok');
    await sonya.page.waitForSelector('#page-chat.active', { timeout: 25000 });
    await sonya.page.fill('#m-input', 'Привет, Тимур');
    await sonya.page.click('#btn-send');
    await sonya.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 25000 });
});

/* ------------------------------------------------------------ «в сети» */

await step('в шапке чата видно, что собеседник в сети', async () => {
    await timur.page.waitForFunction(
        () => [...document.querySelectorAll('#chat-list .f-item')].some((e) => e.textContent.includes('Соня')),
        null, { timeout: 25000 });
    await timur.page.click('#chat-list .f-item:has-text("Соня")');
    await timur.page.waitForSelector('#page-chat.active', { timeout: 15000 });

    await timur.page.waitForFunction(
        () => document.getElementById('chat-subtitle').textContent.includes('в сети'),
        null, { timeout: 30000 });
});

await step('статус виден и в карточке профиля', async () => {
    await timur.page.click('#chat-head');
    await timur.page.waitForSelector('#profile-modal.show', { timeout: 15000 });
    await timur.page.waitForFunction(
        () => document.getElementById('pf-extra').textContent.includes('в сети'),
        null, { timeout: 15000 });
    await timur.page.click('#pf-close');
});

await step('переключатель прячет статус от собеседника', async () => {
    await sonya.page.click('#btn-back');
    await sonya.page.click('#btn-settings');
    await sonya.page.waitForSelector('#page-settings.active', { timeout: 15000 });

    const before = await sonya.page.textContent('#online-state');
    assert(before === 'вкл', 'по умолчанию статус должен показываться: ' + before);
    await sonya.page.click('#set-online');
    const after = await sonya.page.textContent('#online-state');
    assert(after === 'выкл', 'переключатель не сработал: ' + after);

    await timur.page.waitForFunction(
        () => !document.getElementById('chat-subtitle').textContent.includes('в сети'),
        null, { timeout: 40000 });

    // и обратно
    await sonya.page.click('#set-online');
    assert((await sonya.page.textContent('#online-state')) === 'вкл', 'статус не вернулся');
    await sonya.page.click('#btn-settings-done');
});

/* ------------------------------------------------- меню и удаление */

await step('одно нажатие открывает меню сообщения', async () => {
    await timur.page.click('.bubble.in .text');
    await timur.page.waitForSelector('.msg-menu', { timeout: 10000 });
    await timur.page.keyboard.press('Escape');
    await timur.page.waitForFunction(
        () => document.querySelectorAll('.msg-menu').length === 0, null, { timeout: 10000 });
});

await step('нажатие на ссылку и реакцию меню не открывает', async () => {
    await timur.page.click('.bubble.in .text');
    await timur.page.click('.msg-menu .emoji-btn[data-pick="👍"]');
    await timur.page.waitForSelector('.bubble.in .reaction-badge', { timeout: 15000 });

    await timur.page.click('.bubble.in .reaction-badge');
    await timur.page.waitForTimeout(400);
    const menus = await timur.page.locator('.msg-menu').count();
    assert(menus === 0, 'нажатие на реакцию открыло меню');
});

await step('удаление сообщения спрашивает подтверждение', async () => {
    await sonya.page.click('#chat-list .f-item:has-text("Тимур")');
    await sonya.page.waitForSelector('.bubble.out', { timeout: 20000 });
    const before = await sonya.page.locator('.bubble.out').count();

    await sonya.page.locator('.bubble.out').last().click();
    await sonya.page.click('.msg-menu .menu-item[data-act="delete"]');
    await sonya.page.waitForSelector('#confirm-modal.show', { timeout: 10000 });

    // отказ ничего не удаляет
    await sonya.page.click('#confirm-cancel');
    await sonya.page.waitForTimeout(800);
    const still = await sonya.page.locator('.bubble.out').count();
    assert(still === before, 'сообщение удалилось без подтверждения');

    await sonya.page.locator('.bubble.out').last().click();
    await sonya.page.click('.msg-menu .menu-item[data-act="delete"]');
    await sonya.page.waitForSelector('#confirm-modal.show', { timeout: 10000 });
    await sonya.page.click('#confirm-ok');
    await sonya.page.waitForFunction(
        (n) => document.querySelectorAll('.bubble.out').length === n - 1, before, { timeout: 15000 });
});

/* --------------------------------------------------- фото и видео */

await step('несколько фотографий уходят за один выбор', async () => {
    const before = await sonya.page.locator('.bubble.out').count();

    await sonya.page.evaluate(async () => {
        const make = (color) => new Promise((resolve) => {
            const canvas = document.createElement('canvas');
            canvas.width = 120; canvas.height = 90;
            const g = canvas.getContext('2d');
            g.fillStyle = color; g.fillRect(0, 0, 120, 90);
            canvas.toBlob((b) => resolve(new File([b], color + '.png', { type: 'image/png' })));
        });
        const files = await Promise.all([make('#f00'), make('#0f0'), make('#00f')]);
        const dt = new DataTransfer();
        files.forEach((f) => dt.items.add(f));
        const input = document.getElementById('m-file');
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
    });

    await sonya.page.waitForFunction(
        (n) => document.querySelectorAll('.bubble.out img.photo').length >= 3 &&
            document.querySelectorAll('.bubble.out').length >= n + 3,
        before, { timeout: 40000 });
});

await step('видео отправляется с превью и уходит зашифрованным', async () => {
    const size = await sonya.page.evaluate(async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 160; canvas.height = 120;
        const g = canvas.getContext('2d');
        const stream = canvas.captureStream(15);
        const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
        const chunks = [];
        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        rec.start();
        for (let i = 0; i < 12; i++) {
            g.fillStyle = i % 2 ? '#e33' : '#33e';
            g.fillRect(0, 0, 160, 120);
            await new Promise((r) => setTimeout(r, 70));
        }
        await new Promise((r) => { rec.onstop = r; rec.stop(); });

        const blob = new Blob(chunks, { type: 'video/webm' });
        const dt = new DataTransfer();
        dt.items.add(new File([blob], 'clip.webm', { type: 'video/webm' }));
        const input = document.getElementById('m-file');
        input.files = dt.files;
        input.dispatchEvent(new Event('change'));
        return blob.size;
    });
    assert(size > 1000, 'ролик не записался: ' + size);

    await sonya.page.waitForSelector('.bubble.out .video', { timeout: 45000 });
    const hasPoster = await sonya.page.locator('.bubble.out .video .video-poster').count();
    assert(hasPoster > 0, 'у видео нет превью первого кадра');

    const room = await sonya.page.evaluate(() => window.WM.state.activeRoom);
    const rows = await sonya.page.evaluate(async (r) => {
        const res = await fetch(window.WM.api.base + '/attachments?room_id=eq.' +
            encodeURIComponent(r) + '&select=data&order=id.desc&limit=1');
        return res.json();
    }, room);
    assert(rows.length && String(rows[0].data).indexOf('wm1:') === 0,
        'видео ушло незашифрованным');
});

await step('видео открывается на весь экран', async () => {
    await sonya.page.click('.bubble.out .video');
    await sonya.page.waitForFunction(
        () => document.getElementById('lightbox').classList.contains('show') &&
            !document.getElementById('lightbox-video').hidden,
        null, { timeout: 30000 });

    const src = await sonya.page.evaluate(() => document.getElementById('lightbox-video').src);
    assert(src.indexOf('data:video') === 0, 'в просмотре не видео: ' + src.slice(0, 30));

    await sonya.page.click('#lightbox', { position: { x: 10, y: 10 } });
    await sonya.page.waitForFunction(
        () => !document.getElementById('lightbox').classList.contains('show'),
        null, { timeout: 10000 });
});

/* ------------------------------------------------------ ключи и службы */

await step('через свой сервер ключ базы не отправляется', async () => {
    const seen = [];
    sonya.page.on('request', (req) => {
        if (req.url().includes('/api/db/')) {
            const h = req.headers();
            seen.push(!!(h.apikey || h.authorization));
        }
    });

    await sonya.page.evaluate(() => window.WM.state.chats.length);
    await sonya.page.fill('#m-input', 'Проверка заголовков');
    await sonya.page.click('#btn-send');
    await sonya.page.waitForTimeout(2500);

    assert(seen.length > 0, 'запросы к своему серверу не замечены');
    assert(seen.every((withKey) => withKey === false),
        'ключ базы всё ещё уходит из браузера');
});

await step('сервер помощника ищется рядом со всеми известными адресами', async () => {
    const urls = await sonya.page.evaluate(() => {
        // активный адрес нарочно не /api/db — сервер всё равно должен найтись
        window.WM.api.base = 'https://example.test/rest/v1';
        localStorage.setItem('WM_API_URL', 'https://mysite.example/api/db');
        const list = window.WM.serviceUrls('ai');
        localStorage.removeItem('WM_API_URL');
        return list;
    });

    assert(urls.some((u) => u === 'https://mysite.example/api/ai'),
        'адрес помощника не выведен из сохранённого адреса сервера: ' + urls.join(', '));
    assert(urls.some((u) => /\/api\/ai$/.test(u) && u.indexOf(BASE) === 0),
        'нет адреса помощника на домене сайта: ' + urls.join(', '));
});

await browser.close();
console.log('\n=== Итог: ' + (total - failures) + '/' + total + ' проверок, ошибок: ' + failures + ' ===\n');
process.exit(failures ? 1 : 0);
