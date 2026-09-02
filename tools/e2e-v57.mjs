/* ==========================================================================
 *  Проверки версии 57: ссылки в сообщениях, ответ смахиванием, реакции,
 *  голосовые сообщения, чат с WolffAI и звонки.
 * ========================================================================== */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const BASE = process.env.WM_BASE || 'http://localhost:8123';
const RUN = 'w' + Date.now().toString(36).slice(-6);
let total = 0, failures = 0;

async function step(name, fn) {
    total++;
    try { await fn(); console.log('  ✓ ' + name); }
    catch (err) { failures++; console.log('  ✗ ' + name + ' — ' + err.message); }
}

function assert(cond, message) { if (!cond) throw new Error(message); }

/* Микрофон и камера подменяются встроенными «фальшивыми» устройствами
   браузера: разрешение спрашивать не нужно, звук генерируется сам. */
const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: [
        '--no-sandbox',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required'
    ]
});

async function signUp(nick, name, opts) {
    const ctx = await browser.newContext(Object.assign({
        viewport: { width: 390, height: 844 },
        serviceWorkers: 'block',
        permissions: ['microphone']
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

/* Смахивание пальцем: браузер получает те же события, что и от руки. */
async function swipeLeft(page, selector, distance) {
    const box = await page.locator(selector).first().boundingBox();
    const y = box.y + box.height / 2;
    const from = box.x + box.width - 8;
    await page.evaluate(async (args) => {
        const el = document.elementFromPoint(args.from, args.y).closest('.bubble');
        const fire = (type, x) => el.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, clientX: x, clientY: args.y,
            pointerType: 'touch', pointerId: 1, isPrimary: true, button: 0
        }));
        fire('pointerdown', args.from);
        for (let i = 1; i <= 8; i++) {
            fire('pointermove', args.from - (args.distance * i) / 8);
            await new Promise((r) => setTimeout(r, 16));
        }
        fire('pointerup', args.from - args.distance);
    }, { from, y, distance });
}

console.log('\n=== WolffMsg e2e (ссылки, свайп, реакции, голос, WolffAI, звонки) ===');

const dima = await signUp(RUN + 'dima', 'Дима');
const kira = await signUp(RUN + 'kira', 'Кира');

await step('личный чат создан', async () => {
    await dima.page.click('#btn-plus');
    await dima.page.click('#plus-user');
    await dima.page.fill('#prompt-input', RUN + 'kira');
    await dima.page.click('#prompt-ok');
    await dima.page.waitForSelector('#page-chat.active', { timeout: 25000 });
});

/* ------------------------------------------------------------- ссылки */

await step('в сообщении кликабельны только ссылки', async () => {
    await dima.page.fill('#m-input', 'смотри https://example.com/page и site.ru — и ещё текст. точка');
    await dima.page.click('#btn-send');
    await dima.page.waitForSelector('.bubble.out a.link', { timeout: 20000 });

    const links = await dima.page.evaluate(() => [...document.querySelectorAll('.bubble.out a.link')]
        .map((a) => ({ href: a.getAttribute('href'), text: a.textContent, target: a.target })));

    assert(links.length === 2, 'ссылок должно быть две: ' + JSON.stringify(links));
    assert(links[0].href === 'https://example.com/page', 'адрес первой: ' + links[0].href);
    assert(links[1].href === 'https://site.ru', 'адрес второй: ' + links[1].href);
    assert(links.every((l) => l.target === '_blank'), 'ссылка открывается не в новой вкладке');

    const html = await dima.page.evaluate(
        () => document.querySelector('.bubble.out .text').innerHTML);
    assert(html.includes('и ещё текст. точка'), 'обычный текст пострадал: ' + html);
});

await step('ссылка не превращает в ссылку весь текст и разметку', async () => {
    await dima.page.fill('#m-input', '<b>жирный</b> и почта a@b.ru');
    await dima.page.click('#btn-send');
    await dima.page.waitForFunction(() => {
        const last = [...document.querySelectorAll('.bubble.out .text')].pop();
        return last && last.textContent.includes('почта');
    }, null, { timeout: 20000 });

    const html = await dima.page.evaluate(
        () => [...document.querySelectorAll('.bubble.out .text')].pop().innerHTML);
    assert(html.includes('&lt;b&gt;'), 'разметка выполнилась: ' + html);
    assert(!html.includes('<a '), 'почтовый адрес превращён в ссылку: ' + html);
});

/* -------------------------------------------------------------- реакции */

await step('нажатие на реакцию ставит такую же', async () => {
    await kira.page.waitForFunction(
        () => [...document.querySelectorAll('#chat-list .f-item')].some((e) => e.textContent.includes('Дима')),
        null, { timeout: 25000 });
    await kira.page.click('#chat-list .f-item:has-text("Дима")');
    await kira.page.waitForSelector('.bubble.in', { timeout: 20000 });

    // Дима ставит реакцию через меню
    await dima.page.locator('.bubble.out').first().click({ button: 'right' });
    await dima.page.click('.msg-menu .emoji-btn[data-pick="👍"]');
    await dima.page.waitForSelector('.bubble.out .reaction-badge.mine', { timeout: 15000 });

    // Кира нажимает на плашку — у неё появляется такая же реакция
    await kira.page.waitForSelector('.bubble.in .reaction-badge', { timeout: 25000 });
    await kira.page.click('.bubble.in .reaction-badge');
    await kira.page.waitForSelector('.bubble.in .reaction-badge.mine', { timeout: 15000 });

    const text = await kira.page.textContent('.bubble.in .reaction-badge');
    assert(text.includes('👍') && text.includes('2'), 'плашка реакции: ' + text);

    const modal = await kira.page.isVisible('#reactions-modal.show');
    assert(!modal, 'нажатие на плашку открыло список вместо постановки реакции');
});

await step('список отреагировавших открывается из меню', async () => {
    await kira.page.locator('.bubble.in').first().click({ button: 'right' });
    await kira.page.click('.msg-menu .menu-item[data-act="who"]');
    await kira.page.waitForSelector('#reactions-modal.show .reaction-user', { timeout: 15000 });
    const rows = await kira.page.evaluate(
        () => [...document.querySelectorAll('#reactions-modal .reaction-user')].map((e) => e.textContent));
    assert(rows.length === 2, 'в списке должно быть двое: ' + rows.join(' | '));
    await kira.page.click('#reactions-close');
});

/* ---------------------------------------------------------------- свайп */

await step('смахивание влево открывает ответ', async () => {
    await kira.page.evaluate(() => window.WM.state.replyTo = null);
    await swipeLeft(kira.page, '.bubble.in', 90);
    await kira.page.waitForSelector('#reply-bar:not([hidden])', { timeout: 10000 });
    const preview = await kira.page.textContent('#reply-preview');
    assert(preview.length > 0, 'цитата пустая');
    await kira.page.click('#reply-cancel');
});

await step('короткое движение и прокрутка ответом не считаются', async () => {
    await swipeLeft(kira.page, '.bubble.in', 30);          // не дотянули до порога
    await kira.page.waitForTimeout(400);
    let open = await kira.page.isVisible('#reply-bar');
    assert(!open, 'ответ открылся от короткого движения');

    // движение по вертикали — это прокрутка, а не смахивание
    const box = await kira.page.locator('.bubble.in').first().boundingBox();
    await kira.page.evaluate(async (b) => {
        const el = document.elementFromPoint(b.x + b.width - 8, b.y + b.height / 2).closest('.bubble');
        const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, clientX: x, clientY: y,
            pointerType: 'touch', pointerId: 2, isPrimary: true, button: 0
        }));
        const x0 = b.x + b.width - 8, y0 = b.y + b.height / 2;
        fire('pointerdown', x0, y0);
        for (let i = 1; i <= 8; i++) {
            fire('pointermove', x0 - i * 12, y0 - i * 12);
            await new Promise((r) => setTimeout(r, 16));
        }
        fire('pointerup', x0 - 96, y0 - 96);
    }, box);
    await kira.page.waitForTimeout(400);
    open = await kira.page.isVisible('#reply-bar');
    assert(!open, 'ответ открылся при прокрутке');
});

/* -------------------------------------------------------------- голос */

await step('голосовое сообщение записывается и уходит зашифрованным', async () => {
    await dima.page.evaluate(() => {
        // короткое нажатие включает запись и оставляет её включённой
        document.getElementById('btn-mic').dispatchEvent(new PointerEvent('pointerdown',
            { bubbles: true, clientX: 300, clientY: 700, pointerId: 3, button: 0 }));
        setTimeout(() => document.getElementById('btn-mic').dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true, clientX: 300, clientY: 700, pointerId: 3, button: 0 })), 60);
    });

    await dima.page.waitForSelector('#rec-bar:not([hidden])', { timeout: 10000 });
    await dima.page.waitForTimeout(1600);                  // записываем полторы секунды
    await dima.page.click('#rec-stop');

    await dima.page.waitForSelector('.bubble.out .voice', { timeout: 25000 });
    const dur = await dima.page.textContent('.bubble.out .voice-time');
    assert(/^0:0[1-9]/.test(dur), 'длительность: ' + dur);

    const room = await dima.page.evaluate(() => window.WM.state.activeRoom);
    const rows = await dima.page.evaluate(async (r) => {
        const key = window.WM_CONFIG.apiKey;
        const res = await fetch(window.WM.api.base + '/attachments?room_id=eq.' +
            encodeURIComponent(r) + '&select=data&order=id.desc&limit=1',
        { headers: { apikey: key, Authorization: 'Bearer ' + key } });
        return res.json();
    }, room);
    assert(rows.length && String(rows[0].data).indexOf('wm1:') === 0,
        'голос ушёл незашифрованным');
});

await step('собеседник слушает голосовое сообщение', async () => {
    await kira.page.waitForSelector('.bubble.in .voice', { timeout: 25000 });
    await kira.page.click('.bubble.in .voice-play');
    await kira.page.waitForSelector('.bubble.in .voice.playing', { timeout: 20000 });

    const playing = await kira.page.evaluate(() => new Promise((resolve) => {
        setTimeout(() => {
            const audio = [...document.querySelectorAll('audio')].find((a) => a.src && a.src.length > 100);
            resolve(!!audio || document.querySelector('.voice.playing') !== null);
        }, 700);
    }));
    assert(playing, 'звук не воспроизводится');
});

/* ------------------------------------------------------------- WolffAI */

await step('чат с WolffAI есть у каждого и отвечает', async () => {
    await dima.page.click('#btn-back');
    await dima.page.waitForSelector('#page-main.active', { timeout: 15000 });
    await dima.page.waitForFunction(
        () => [...document.querySelectorAll('#chat-list .f-item b')].some((e) => e.textContent.includes('WolffAI')),
        null, { timeout: 25000 });

    const names = await dima.page.evaluate(
        () => [...document.querySelectorAll('#chat-list .f-item b')].map((e) => e.textContent));
    assert(names[0].includes('Избранное'), 'первым идёт не «Избранное»: ' + names.join(' | '));
    assert(names[1].includes('WolffAI'), 'вторым идёт не WolffAI: ' + names.join(' | '));

    await dima.page.click('#chat-list .f-item:has-text("WolffAI")');
    await dima.page.waitForSelector('#page-chat.active', { timeout: 15000 });
    await dima.page.fill('#m-input', 'Расскажи про волков');
    await dima.page.click('#btn-send');

    await dima.page.waitForSelector('.bubble.in .text', { timeout: 30000 });
    const answer = await dima.page.textContent('.bubble.in .text');
    assert(answer.includes('Расскажи про волков'), 'ответ помощника: ' + answer);
});

await step('переписка с WolffAI тоже зашифрована', async () => {
    const room = await dima.page.evaluate(() => window.WM.state.activeRoom);
    const rows = await dima.page.evaluate(async (r) => {
        const key = window.WM_CONFIG.apiKey;
        const res = await fetch(window.WM.api.base + '/messages?room_id=eq.' +
            encodeURIComponent(r) + '&select=text,user_id',
        { headers: { apikey: key, Authorization: 'Bearer ' + key } });
        return res.json();
    }, room);

    assert(rows.length >= 2, 'в чате помощника нет переписки');
    assert(rows.every((m) => String(m.text).indexOf('wm1:') === 0),
        'переписка с помощником лежит открытым текстом');
    assert(rows.some((m) => m.user_id === 'wolffai'), 'ответа помощника нет в базе');
});

await step('чужой чат с WolffAI недоступен', async () => {
    const mine = await dima.page.evaluate(() => window.WM.state.me.id);
    const rooms = await kira.page.evaluate(
        () => window.WM.state.chats.map((c) => c.room_id));
    assert(!rooms.some((r) => r === 'ai_' + mine), 'чужой чат помощника виден в списке');
});

await step('при исчерпанном лимите WolffAI честно говорит о спросе', async () => {
    const busyBase = process.env.WM_BASE_BUSY;
    if (!busyBase) throw new Error('не задан стенд с перегруженным помощником');

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(busyBase + '/');
    await page.click('#auth-swap-btn');
    await page.fill('#a-nick', RUN + 'busy');
    await page.fill('#a-name', 'Занятый');
    await page.fill('#a-pass', 'pass1234');
    await page.click('#auth-btn');
    await page.waitForSelector('#page-main.active', { timeout: 25000 });

    await page.waitForSelector('#chat-list .f-item:has-text("WolffAI")', { timeout: 25000 });
    await page.click('#chat-list .f-item:has-text("WolffAI")');
    await page.waitForSelector('#page-chat.active', { timeout: 15000 });
    await page.fill('#m-input', 'Привет');
    await page.click('#btn-send');

    await page.waitForSelector('.bubble.in .text', { timeout: 30000 });
    const answer = await page.textContent('.bubble.in .text');
    assert(answer.includes('большой спрос'), 'ответ при перегрузке: ' + answer);
    await ctx.close();
});

/* -------------------------------------------------------------- звонки */

await step('звонок соединяется и идёт напрямую между устройствами', async () => {
    await dima.page.click('#btn-back');
    await dima.page.waitForSelector('#page-main.active', { timeout: 15000 });
    await dima.page.click('#chat-list .f-item:has-text("Кира")');
    await dima.page.waitForSelector('#page-chat.active', { timeout: 15000 });
    await dima.page.waitForSelector('#btn-call:not([hidden])', { timeout: 20000 });

    await dima.page.click('#btn-call');
    await dima.page.waitForSelector('#call-screen:not([hidden])', { timeout: 10000 });

    // у собеседника появляется входящий
    await kira.page.waitForSelector('#call-screen:not([hidden])', { timeout: 30000 });
    const who = await kira.page.textContent('#call-name');
    assert(who.includes('Дима'), 'кто звонит: ' + who);
    await kira.page.click('#call-accept');

    // обе стороны действительно установили прямое соединение
    for (const [who2, page] of [['звонящий', dima.page], ['принявший', kira.page]]) {
        await page.waitForFunction(
            () => window.WM.state.call && window.WM.state.call.pc &&
                window.WM.state.call.pc.connectionState === 'connected',
            null, { timeout: 45000 }).catch(() => {
            throw new Error('соединение не установилось: ' + who2);
        });
    }

    // звук действительно передаётся
    const gotAudio = await kira.page.evaluate(() => {
        const receivers = window.WM.state.call.pc.getReceivers();
        return receivers.some((r) => r.track && r.track.kind === 'audio');
    });
    assert(gotAudio, 'звук не пришёл');

    await dima.page.waitForFunction(
        () => /^\d+:\d\d$/.test(document.getElementById('call-status').textContent),
        null, { timeout: 15000 });
});

await step('сигналы звонка на сервере зашифрованы', async () => {
    const rows = await dima.page.evaluate(async () => {
        const key = window.WM_CONFIG.apiKey;
        const res = await fetch(window.WM.api.base + '/calls?select=kind,payload',
            { headers: { apikey: key, Authorization: 'Bearer ' + key } });
        return res.json();
    });
    const withPayload = rows.filter((r) => r.payload);
    assert(withPayload.length >= 2, 'сигналов звонка не видно: ' + rows.length);
    assert(withPayload.every((r) => String(r.payload).indexOf('wm1:') === 0),
        'сигналы звонка лежат открытым текстом');
});

await step('завершение у одного закрывает звонок у обоих', async () => {
    const closed = () => document.getElementById('call-screen').hidden;
    await dima.page.click('#call-hangup');
    await dima.page.waitForFunction(closed, null, { timeout: 10000 });
    await kira.page.waitForFunction(closed, null, { timeout: 25000 });
    const call = await kira.page.evaluate(() => !!window.WM.state.call);
    assert(!call, 'звонок остался висеть у собеседника');
});

await browser.close();
console.log('\n=== Итог: ' + (total - failures) + '/' + total + ' проверок, ошибок: ' + failures + ' ===\n');
process.exit(failures ? 1 : 0);
