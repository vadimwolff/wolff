/* ==========================================================================
 *  Проверки версии 52: шифрование включено по умолчанию (без ручных кодов)
 *  и устойчивость к «моргающему» прокси.
 * ========================================================================== */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = process.env.WM_BASE || 'http://localhost:8123';
const OLD_BASE = process.env.WM_BASE_OLD || 'http://localhost:8127';
const RUN = 'k' + Date.now().toString(36).slice(-6);
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

async function open(base, query) {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 880 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { failures++; console.log('  ✗ JS-ошибка: ' + e.message); });
    await page.goto(base + '/' + (query || ''));
    await page.waitForSelector('#page-auth.active', { timeout: 20000 });
    return { ctx, page };
}

async function signUp(base, nick, name) {
    const s = await open(base);
    await s.page.click('#auth-swap-btn');
    await s.page.fill('#a-nick', nick);
    await s.page.fill('#a-name', name);
    await s.page.fill('#a-pass', 'pass1234');
    await s.page.click('#auth-btn');
    await s.page.waitForSelector('#page-main.active', { timeout: 25000 });
    return s;
}

async function signIn(base, nick) {
    const s = await open(base);
    await s.page.fill('#a-nick', nick);
    await s.page.fill('#a-pass', 'pass1234');
    await s.page.click('#auth-btn');
    await s.page.waitForSelector('#page-main.active', { timeout: 25000 });
    return s;
}

/* Читаем то, что реально лежит на сервере, минуя приложение. */
async function rawApi(page, path) {
    return page.evaluate(async (p) => {
        const key = window.WM_CONFIG.apiKey;
        const base = window.WM.api.base;
        const res = await fetch(base + p, { headers: { apikey: key, Authorization: 'Bearer ' + key } });
        return res.json();
    }, path);
}

console.log('\n=== WolffMsg e2e (шифрование по умолчанию, надёжность прокси) ===');

const ann = await signUp(BASE, RUN + 'ann', 'Аня');
const ben = await signUp(BASE, RUN + 'ben', 'Бен');

await step('при регистрации создаются ключи устройства', async () => {
    const identity = await ann.page.evaluate(() => new Promise((resolve) => {
        const req = indexedDB.open('wolffmsg', 1);
        req.onsuccess = () => {
            const get = req.result.transaction('keys', 'readonly').objectStore('keys').get('identity');
            get.onsuccess = () => {
                const rec = get.result;
                resolve(rec ? {
                    publicKey: rec.publicKey,
                    type: rec.privateKey && rec.privateKey.type,
                    extractable: rec.privateKey && rec.privateKey.extractable,
                    vault: !!(rec.vault && rec.vault.wrapped)
                } : null);
            };
            get.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
    }));

    assert(identity && identity.publicKey, 'открытый ключ не сохранён на устройстве');
    assert(identity.type === 'private', 'закрытый ключ не сохранён на устройстве');
    assert(identity.vault, 'копия ключа под паролем не сохранена — смена пароля потеряет переписку');

    // Ключ хранится «неизвлекаемым»: даже свой же код не может его выгрузить.
    assert(identity.extractable === false, 'закрытый ключ можно выгрузить из хранилища');
    const raw = await ann.page.evaluate(() => localStorage.getItem('WM_IDENTITY'));
    assert(!raw, 'закрытый ключ остался в localStorage открытым текстом');

    const rows = await rawApi(ann.page, '/profiles?nickname=eq.' + RUN + 'ann&select=id,public_key');
    assert(rows[0] && rows[0].public_key === identity.publicKey, 'открытый ключ не попал в профиль');
});

await step('закрытый ключ не читается из таблицы профилей', async () => {
    const rows = await rawApi(ann.page, '/profiles?nickname=eq.' + RUN + 'ann&select=id,nickname');
    assert(rows[0] && rows[0].id, 'профиль не читается вовсе');
    const leak = await rawApi(ann.page, '/profiles?nickname=eq.' + RUN + 'ann&select=enc_private_key');
    const denied = !Array.isArray(leak) || !leak[0] || !leak[0].enc_private_key ||
        leak[0].enc_private_key.indexOf('wm1:') === 0;
    assert(denied, 'закрытый ключ доступен в открытом виде через таблицу');
});

await step('переписка шифруется без единой настройки', async () => {
    await ann.page.click('#btn-plus');
    await ann.page.click('#plus-user');
    await ann.page.fill('#prompt-input', RUN + 'ben');
    await ann.page.click('#prompt-ok');
    await ann.page.waitForSelector('#page-chat.active', { timeout: 25000 });

    await ann.page.fill('#m-input', 'Совершенно секретный текст');
    await ann.page.click('#btn-send');
    await ann.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 25000 });

    const room = await ann.page.evaluate(() => window.WM.state.activeRoom);
    const rows = await rawApi(ann.page,
        '/messages?room_id=eq.' + encodeURIComponent(room) + '&select=text&order=created_at.desc&limit=1');
    assert(String(rows[0].text).indexOf('wm1:') === 0, 'сообщение ушло незашифрованным: ' + rows[0].text);
    assert(String(rows[0].text).indexOf('секретный') < 0, 'в шифртексте виден исходный текст');
});

await step('замок в шапке чата включён', async () => {
    await ann.page.waitForFunction(
        () => !document.getElementById('chat-lock').hidden, null, { timeout: 20000 });
});

await step('собеседник читает сообщение без ввода кода', async () => {
    await ben.page.waitForFunction(
        () => [...document.querySelectorAll('#chat-list .f-item')].some((e) => e.textContent.includes('Аня')),
        null, { timeout: 30000 });
    await ben.page.click('#chat-list .f-item:has-text("Аня")');
    await ben.page.waitForFunction(
        () => [...document.querySelectorAll('.bubble.in .text')]
            .some((e) => e.textContent.includes('Совершенно секретный текст')),
        null, { timeout: 30000 });
});

await step('код безопасности совпадает у обоих', async () => {
    await ann.page.click('#btn-chat-menu');
    await ann.page.click('#act-crypto');
    await ann.page.waitForSelector('#crypto-code-box:not([hidden])', { timeout: 20000 });
    const codeA = (await ann.page.textContent('#crypto-fingerprint')).trim();
    const stateA = await ann.page.textContent('#crypto-state');
    assert(stateA.includes('Включено'), 'состояние шифрования: ' + stateA);
    await ann.page.click('#crypto-close');

    await ben.page.click('#btn-chat-menu');
    await ben.page.click('#act-crypto');
    await ben.page.waitForSelector('#crypto-code-box:not([hidden])', { timeout: 20000 });
    const codeB = (await ben.page.textContent('#crypto-fingerprint')).trim();
    await ben.page.click('#crypto-close');

    assert(codeA.length >= 20, 'код безопасности слишком короткий: ' + codeA);
    assert(codeA === codeB, 'коды не совпали: ' + codeA + ' / ' + codeB);
});

await step('после перезагрузки переписка по-прежнему читается', async () => {
    await ben.page.reload();
    await ben.page.waitForSelector('#page-main.active', { timeout: 25000 });
    await ben.page.click('#chat-list .f-item:has-text("Аня")');
    await ben.page.waitForFunction(
        () => [...document.querySelectorAll('.bubble.in .text')]
            .some((e) => e.textContent.includes('Совершенно секретный')),
        null, { timeout: 25000 });
});

await step('вход на другом устройстве восстанавливает ключ по паролю', async () => {
    const fresh = await signIn(BASE, RUN + 'ben');       // чистый контекст: только логин и пароль
    await fresh.page.click('#chat-list .f-item:has-text("Аня")');
    await fresh.page.waitForFunction(
        () => [...document.querySelectorAll('.bubble.in .text')]
            .some((e) => e.textContent.includes('Совершенно секретный')),
        null, { timeout: 30000 });
    await fresh.ctx.close();
});

await step('посторонний не получает ключ чата', async () => {
    const spy = await signUp(BASE, RUN + 'spy', 'Наблюдатель');
    const room = await ann.page.evaluate(() => window.WM.state.activeRoom);
    const keys = await rawApi(spy.page,
        '/room_keys?room_id=eq.' + encodeURIComponent(room) + '&select=user_id');
    const ids = (keys || []).map((k) => k.user_id);
    const spyId = await spy.page.evaluate(() => window.WM.state.me.id);
    assert(ids.indexOf(spyId) < 0, 'посторонний получил ключ чата');
    assert(ids.length === 2, 'ключей в комнате: ' + ids.length);
    await spy.ctx.close();
});

await step('фото тоже уходит в зашифрованном виде', async () => {
    await ann.page.evaluate(() => {
        // маленькая картинка вместо выбора файла
        const canvas = document.createElement('canvas');
        canvas.width = 8; canvas.height = 8;
        canvas.getContext('2d').fillRect(0, 0, 8, 8);
        return new Promise((resolve) => {
            canvas.toBlob((blob) => {
                const file = new File([blob], 'p.png', { type: 'image/png' });
                const dt = new DataTransfer();
                dt.items.add(file);
                const input = document.getElementById('m-file');
                input.files = dt.files;
                input.dispatchEvent(new Event('change'));
                resolve();
            });
        });
    });
    await ann.page.waitForTimeout(3000);
    const room = await ann.page.evaluate(() => window.WM.state.activeRoom);
    const rows = await rawApi(ann.page,
        '/messages?room_id=eq.' + encodeURIComponent(room) + '&select=text&order=created_at.desc&limit=1');
    assert(String(rows[0].text).indexOf('wm1:') === 0, 'фото ушло незашифрованным');
});

await step('приложение переключает адрес, когда активный отказал', async () => {
    const s = await open(BASE, '?api=' + encodeURIComponent(BASE + '/rest/v1'));
    await s.page.fill('#a-nick', RUN + 'ann');
    await s.page.fill('#a-pass', 'pass1234');
    await s.page.click('#auth-btn');
    await s.page.waitForSelector('#page-main.active', { timeout: 25000 });

    const first = await s.page.evaluate(() => window.WM.api.base);
    assert(first.includes('/rest/v1'), 'ожидался указанный адрес, получен: ' + first);

    // указанный адрес «падает» — приложение должно уйти на адрес сайта
    await s.page.route('**/rest/v1/**', (route) => route.abort());
    await s.page.click('#chat-list .f-item:has-text("Бен")');
    await s.page.fill('#m-input', 'Сообщение после сбоя прокси');
    await s.page.click('#btn-send');
    await s.page.waitForSelector('.bubble.out:not(.pending):not(.failed)', { timeout: 30000 });

    const second = await s.page.evaluate(() => window.WM.api.base);
    assert(second !== first, 'адрес не переключился: ' + second);
    const banner = await s.page.isHidden('#net-banner');
    assert(banner, 'показана плашка «нет связи», хотя запасной адрес работает');
    await s.ctx.close();
});

await step('временная ошибка 500 не роняет отправку', async () => {
    const s = await open(BASE, '?api=' + encodeURIComponent(BASE + '/rest/v1'));
    await s.page.fill('#a-nick', RUN + 'ann');
    await s.page.fill('#a-pass', 'pass1234');
    await s.page.click('#auth-btn');
    await s.page.waitForSelector('#page-main.active', { timeout: 25000 });

    let broken = 0;
    await s.page.route('**/rest/v1/messages**', (route) => {
        if (route.request().method() === 'POST' && broken < 1) {
            broken++;
            return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
        }
        return route.continue();
    });

    await s.page.click('#chat-list .f-item:has-text("Бен")');
    await s.page.fill('#m-input', 'Пережили пятисотку');
    await s.page.click('#btn-send');
    await s.page.waitForSelector('.bubble.out:not(.pending):not(.failed)', { timeout: 30000 });
    assert(broken === 1, 'сбой не был воспроизведён');
    await s.ctx.close();
});

await step('на базе прошлой версии всё работает без шифрования', async () => {
    const old1 = await signUp(OLD_BASE, RUN + 'olda', 'Старый А');
    const old2 = await signUp(OLD_BASE, RUN + 'oldb', 'Старый Б');

    await old1.page.click('#btn-plus');
    await old1.page.click('#plus-user');
    await old1.page.fill('#prompt-input', RUN + 'oldb');
    await old1.page.click('#prompt-ok');
    await old1.page.waitForSelector('#page-chat.active', { timeout: 25000 });
    await old1.page.fill('#m-input', 'Открытое сообщение');
    await old1.page.click('#btn-send');
    await old1.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 25000 });

    const locked = await old1.page.evaluate(() => !document.getElementById('chat-lock').hidden);
    assert(!locked, 'на старой базе показан замок, хотя ключей нет');

    await old2.page.click('#btn-plus');
    await old2.page.click('#plus-user');
    await old2.page.fill('#prompt-input', RUN + 'olda');
    await old2.page.click('#prompt-ok');
    await old2.page.waitForFunction(
        () => [...document.querySelectorAll('.bubble.in .text')]
            .some((e) => e.textContent.includes('Открытое сообщение')), null, { timeout: 30000 });

    await old1.ctx.close();
    await old2.ctx.close();
});

await browser.close();
console.log('\n=== Итог: ' + (total - failures) + '/' + total + ' проверок, ошибок: ' + failures + ' ===\n');
process.exit(failures ? 1 : 0);
