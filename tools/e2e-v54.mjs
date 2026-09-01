/* ==========================================================================
 *  Проверки версии 54: галочки статуса, мгновенные фотографии, вход в чат
 *  на последнем сообщении, просмотр канала без подписки, скрытый состав
 *  подписчиков, установка приложения и уведомления.
 * ========================================================================== */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = process.env.WM_BASE || 'http://localhost:8123';
const RUN = 'n' + Date.now().toString(36).slice(-6);
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

async function signUp(nick, name, opts) {
    const ctx = await browser.newContext(Object.assign({
        viewport: { width: 390, height: 844 },
        serviceWorkers: 'block'
    }, opts || {}));
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

/* Кладём картинку в поле выбора файла, не открывая системный диалог. */
async function attachPhoto(page) {
    await page.evaluate(() => new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        canvas.width = 600; canvas.height = 400;
        const g = canvas.getContext('2d');
        g.fillStyle = '#3b6cf6'; g.fillRect(0, 0, 600, 400);
        g.fillStyle = '#fff'; g.font = '48px sans-serif'; g.fillText('ФОТО', 200, 220);
        canvas.toBlob((blob) => {
            const dt = new DataTransfer();
            dt.items.add(new File([blob], 'photo.png', { type: 'image/png' }));
            const input = document.getElementById('m-file');
            input.files = dt.files;
            input.dispatchEvent(new Event('change'));
            resolve();
        });
    }));
}

console.log('\n=== WolffMsg e2e (галочки, фото, каналы, PWA, уведомления) ===');

const kate = await signUp(RUN + 'kate', 'Катя');
const paul = await signUp(RUN + 'paul', 'Павел');

await step('одна галочка после отправки', async () => {
    await kate.page.click('#btn-plus');
    await kate.page.click('#plus-user');
    await kate.page.fill('#prompt-input', RUN + 'paul');
    await kate.page.click('#prompt-ok');
    await kate.page.waitForSelector('#page-chat.active', { timeout: 25000 });

    await kate.page.fill('#m-input', 'Проверка галочек');
    await kate.page.click('#btn-send');
    await kate.page.waitForSelector('.bubble.out .status-icon.status-sent', { timeout: 25000 });

    const secondHidden = await kate.page.evaluate(() => {
        const p = document.querySelector('.bubble.out .status-icon .check-path.second');
        return p ? parseFloat(getComputedStyle(p).opacity) < 0.05 : false;
    });
    assert(secondHidden, 'после отправки видны две галочки вместо одной');
});

await step('две галочки после прочтения', async () => {
    await paul.page.waitForFunction(
        () => [...document.querySelectorAll('#chat-list .f-item')].some((e) => e.textContent.includes('Катя')),
        null, { timeout: 30000 });
    await paul.page.click('#chat-list .f-item:has-text("Катя")');
    await paul.page.waitForSelector('.bubble.in', { timeout: 25000 });

    await kate.page.waitForSelector('.bubble.out .status-icon.status-read', { timeout: 30000 });
    const bothVisible = await kate.page.evaluate(() => {
        const paths = [...document.querySelectorAll('.bubble.out .status-icon.status-read .check-path')];
        return paths.length === 2 && paths.every((p) => parseFloat(getComputedStyle(p).opacity) > 0.9);
    });
    assert(bothVisible, 'после прочтения не видно двух галочек');
});

await step('фото отправляется отдельным вложением, а не внутри сообщения', async () => {
    await attachPhoto(kate.page);
    await kate.page.waitForSelector('.bubble.out img.photo', { timeout: 30000 });

    const room = await kate.page.evaluate(() => window.WM.state.activeRoom);
    const row = await kate.page.evaluate(async (r) => {
        const key = window.WM_CONFIG.apiKey;
        const res = await fetch(window.WM.api.base + '/messages?room_id=eq.' +
            encodeURIComponent(r) + '&select=text,thumb&order=created_at.desc&limit=1',
            { headers: { apikey: key, Authorization: 'Bearer ' + key } });
        return (await res.json())[0];
    }, room);

    assert(String(row.text).indexOf('wm1:') === 0, 'ссылка на фото не зашифрована: ' + row.text);
    assert(String(row.text).length < 400, 'в сообщении лежит само фото, а не ссылка: ' + row.text.length + ' символов');
    assert(row.thumb && String(row.thumb).indexOf('wm1:') === 0, 'превью не сохранено или не зашифровано');
});

await step('у собеседника фото появляется сразу превью, потом полностью', async () => {
    await paul.page.waitForSelector('.bubble.in img.photo', { timeout: 30000 });
    const early = await paul.page.evaluate(() => {
        const img = document.querySelector('.bubble.in img.photo');
        return { src: img.getAttribute('src').slice(0, 30), loading: img.classList.contains('loading') };
    });
    assert(early.src.indexOf('data:image') === 0, 'превью не показано: ' + early.src);

    await paul.page.waitForFunction(
        () => {
            const img = document.querySelector('.bubble.in img.photo');
            return img && img.getAttribute('data-loaded') === '1' && !img.classList.contains('loading');
        }, null, { timeout: 30000 });
});

await step('полное фото хранится отдельно и зашифровано', async () => {
    const rows = await kate.page.evaluate(async () => {
        const key = window.WM_CONFIG.apiKey;
        const res = await fetch(window.WM.api.base + '/attachments?select=data&order=id.desc&limit=1',
            { headers: { apikey: key, Authorization: 'Bearer ' + key } });
        return res.json();
    });
    assert(rows.length === 1, 'вложение не сохранено');
    assert(String(rows[0].data).indexOf('wm1:') === 0, 'вложение хранится незашифрованным');
});

await step('при входе в чат виден конец переписки', async () => {
    for (let i = 1; i <= 18; i++) {
        await kate.page.fill('#m-input', 'Строка истории номер ' + i);
        await kate.page.press('#m-input', 'Enter');
        await kate.page.waitForTimeout(110);
    }
    await kate.page.waitForTimeout(1500);
    await kate.page.click('#btn-back');
    await kate.page.waitForSelector('#page-main.active', { timeout: 20000 });
    await kate.page.click('#chat-list .f-item:has-text("Павел")');
    await kate.page.waitForSelector('.bubble', { timeout: 25000 });
    await kate.page.waitForTimeout(2500);

    const atBottom = await kate.page.evaluate(() => {
        const b = document.getElementById('msg-list');
        return b.scrollHeight - b.scrollTop - b.clientHeight < 140;
    });
    assert(atBottom, 'чат открылся не на последнем сообщении');

    const lastVisible = await kate.page.evaluate(() => {
        const nodes = [...document.querySelectorAll('.bubble .text')];
        const last = nodes[nodes.length - 1];
        const box = document.getElementById('msg-list').getBoundingClientRect();
        const r = last.getBoundingClientRect();
        return r.bottom <= box.bottom + 4 && r.top >= box.top - 4;
    });
    assert(lastVisible, 'последнее сообщение не попало в видимую часть');
});

await step('вход в канал не подписывает автоматически', async () => {
    await kate.page.click('#btn-back');
    await kate.page.click('#btn-plus');
    await kate.page.click('#plus-channel');
    await kate.page.fill('#ch-title', 'Открытый канал');
    await kate.page.fill('#ch-slug', RUN + 'open');
    await kate.page.click('#ch-create');
    await kate.page.waitForSelector('#page-chat.active', { timeout: 25000 });
    await kate.page.fill('#m-input', 'Первая запись');
    await kate.page.click('#btn-send');
    await kate.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 25000 });

    await paul.page.click('#btn-back');
    await paul.page.fill('#chat-search', 'Открытый');
    await paul.page.waitForSelector('#global-results .f-item[data-channel]', { timeout: 25000 });
    await paul.page.click('#global-results .f-item[data-channel]');
    await paul.page.waitForSelector('#page-chat.active', { timeout: 25000 });
    await paul.page.waitForSelector('.bubble.in', { timeout: 25000 });

    const joinVisible = await paul.page.isVisible('#btn-join');
    assert(joinVisible, 'кнопки «Подписаться» нет — значит подписка произошла сама');

    const room = await paul.page.evaluate(() => window.WM.state.activeRoom);
    const subs = await paul.page.evaluate(async (r) => {
        const key = window.WM_CONFIG.apiKey;
        const res = await fetch(window.WM.api.base + '/chats?room_id=eq.' +
            encodeURIComponent(r) + '&select=members,subscribers',
            { headers: { apikey: key, Authorization: 'Bearer ' + key } });
        return (await res.json())[0];
    }, room);
    assert(subs.subscribers === 1, 'подписчиков стало ' + subs.subscribers + ' без нажатия кнопки');
});

await step('канал не попадает в список чатов до подписки', async () => {
    await paul.page.click('#btn-back');
    await paul.page.waitForSelector('#page-main.active', { timeout: 20000 });
    await paul.page.fill('#chat-search', '');
    await paul.page.waitForTimeout(6000);
    const names = await paul.page.evaluate(
        () => [...document.querySelectorAll('#chat-list .f-item b')].map((e) => e.textContent));
    assert(!names.some((n) => n.includes('Открытый канал')),
        'канал появился в списке без подписки: ' + names.join(', '));
});

await step('подписка происходит только по кнопке', async () => {
    await paul.page.fill('#chat-search', 'Открытый');
    await paul.page.waitForSelector('#global-results .f-item[data-channel]', { timeout: 25000 });
    await paul.page.click('#global-results .f-item[data-channel]');
    await paul.page.waitForSelector('#btn-join', { timeout: 20000 });
    await paul.page.click('#btn-join');
    await paul.page.waitForFunction(
        () => document.getElementById('btn-join').hidden, null, { timeout: 25000 });

    const room = await paul.page.evaluate(() => window.WM.state.activeRoom);
    const subs = await paul.page.evaluate(async (r) => {
        const key = window.WM_CONFIG.apiKey;
        const res = await fetch(window.WM.api.base + '/chats?room_id=eq.' +
            encodeURIComponent(r) + '&select=subscribers',
            { headers: { apikey: key, Authorization: 'Bearer ' + key } });
        return (await res.json())[0].subscribers;
    }, room);
    assert(subs === 2, 'после подписки подписчиков: ' + subs);
});

await step('в канале не показывается состав подписчиков', async () => {
    await paul.page.click('#chat-head');
    await paul.page.waitForSelector('#profile-modal.show', { timeout: 15000 });
    const extra = await paul.page.textContent('#pf-extra');
    assert(/подписчик/.test(extra), 'нет числа подписчиков: ' + extra);

    const listShown = await paul.page.isVisible('#reactions-modal.show');
    assert(!listShown, 'показан список участников канала');
    const leaked = await paul.page.evaluate(
        () => document.getElementById('profile-modal').textContent);
    assert(!leaked.includes('Катя'), 'в карточке канала виден конкретный подписчик');
    await paul.page.click('#pf-close');
});

await step('манифест и иконки готовы к установке', async () => {
    const manifest = await kate.page.evaluate(async () => {
        const res = await fetch('manifest.webmanifest');
        return res.json();
    });
    assert(manifest.display === 'standalone', 'display: ' + manifest.display);
    assert(manifest.icons.some((i) => i.sizes === '192x192'), 'нет иконки 192');
    assert(manifest.icons.some((i) => i.sizes === '512x512'), 'нет иконки 512');
    assert(manifest.icons.some((i) => i.purpose === 'maskable'), 'нет maskable-иконки');

    const codes = await kate.page.evaluate(async () => {
        const files = ['assets/icon-192.png', 'assets/icon-512.png', 'assets/apple-touch-icon.png'];
        const out = [];
        for (const f of files) out.push((await fetch(f)).status);
        return out;
    });
    codes.forEach((code, i) => assert(code === 200, 'иконка №' + (i + 1) + ' недоступна: ' + code));
});

await step('уведомление ведёт в нужный чат', async () => {
    const ctx = await browser.newContext({
        viewport: { width: 390, height: 844 },
        serviceWorkers: 'block',
        permissions: ['notifications']
    });
    const page = await ctx.newPage();
    await page.goto(BASE + '/');
    await page.fill('#a-nick', RUN + 'paul');
    await page.fill('#a-pass', 'pass1234');
    await page.click('#auth-btn');
    await page.waitForSelector('#page-main.active', { timeout: 25000 });

    // включаем уведомления и проверяем, что приложение их показывает
    const shown = await page.evaluate(() => new Promise((resolve) => {
        window.__shown = [];
        const original = window.Notification;
        window.Notification = function (title, options) {
            window.__shown.push({ title: title, body: options && options.body });
        };
        window.Notification.permission = 'granted';
        window.Notification.requestPermission = () => Promise.resolve('granted');
        localStorage.setItem('WM_NOTIFY', 'on');
        setTimeout(() => resolve(true), 100);
    }));
    assert(shown, 'не удалось подготовить проверку уведомлений');

    // приходит новое сообщение в другой чат
    await kate.page.click('#btn-back');
    await kate.page.click('#chat-list .f-item:has-text("Павел")');
    await kate.page.fill('#m-input', 'Сообщение для уведомления');
    await kate.page.click('#btn-send');

    await page.waitForFunction(
        () => window.__shown && window.__shown.length > 0, null, { timeout: 35000 });
    const note = await page.evaluate(() => window.__shown[0]);
    assert(note.title.includes('Катя'), 'заголовок уведомления: ' + note.title);

    // переход из уведомления открывает чат
    const room = await kate.page.evaluate(() => window.WM.state.activeRoom);
    await page.evaluate((r) => window.WM.openFromNotification(r, null), room);
    await page.waitForSelector('#page-chat.active', { timeout: 20000 });
    const title = await page.textContent('#chat-title');
    assert(title.includes('Катя'), 'открылся не тот чат: ' + title);
    await ctx.close();
});

await browser.close();
console.log('\n=== Итог: ' + (total - failures) + '/' + total + ' проверок, ошибок: ' + failures + ' ===\n');
process.exit(failures ? 1 : 0);
