/* ==========================================================================
 *  Проверки версии 55: адрес запуска приложения, экран поиска, окно
 *  установки, скрытые адреса серверов, личный раздел «Избранное»,
 *  звук новых сообщений и защита от подмены сервера ссылкой.
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

async function rawApi(page, path) {
    return page.evaluate(async (p) => {
        const key = window.WM_CONFIG.apiKey;
        const res = await fetch(window.WM.api.base + p,
            { headers: { apikey: key, Authorization: 'Bearer ' + key } });
        return res.json();
    }, path);
}

console.log('\n=== WolffMsg e2e (запуск, поиск, установка, избранное, звук) ===');

const lena = await signUp(RUN + 'lena', 'Лена');
const igor = await signUp(RUN + 'igor', 'Игорь');

/* ------------------------------------------------------------ адрес запуска */

await step('приложение открывается по адресу из манифеста', async () => {
    const info = await lena.page.evaluate(async () => {
        const link = document.querySelector('link[rel="manifest"]');
        const href = new URL(link.getAttribute('href'), location.href).href;
        const res = await fetch(href);
        const m = await res.json();
        return {
            status: res.status,
            href: href,
            start: new URL(m.start_url, href).href,
            scope: new URL(m.scope, href).href,
            page: new URL('./', location.href).href
        };
    });

    assert(info.status === 200, 'манифест не отдаётся: ' + info.status);
    // Главная ошибка прошлой версии: манифест лежал в подпапке, и ярлык
    // приложения открывал несуществующий адрес — браузер показывал «404».
    assert(info.start === info.page, 'ярлык ведёт не в приложение: ' + info.start);
    assert(info.scope === info.page, 'область приложения не совпадает с сайтом: ' + info.scope);
});

await step('несуществующий адрес возвращает в приложение', async () => {
    const res = await lena.page.evaluate(async () => {
        const r = await fetch('404.html');
        return { status: r.status, body: await r.text() };
    });
    assert(res.status === 200, 'страница-спасатель не собрана: ' + res.status);
    assert(res.body.includes('location.replace'), 'страница-спасатель не переводит в приложение');
});

/* ------------------------------------------------------------------- поиск */

await step('поиск разворачивается в отдельный экран', async () => {
    await lena.page.click('#chat-search');
    await lena.page.waitForFunction(() => document.body.classList.contains('searching'),
        null, { timeout: 5000 });

    // Кнопка выезжает анимацией — ждём, пока она займёт своё место.
    await lena.page.waitForFunction(
        () => document.getElementById('search-cancel').getBoundingClientRect().width > 20,
        null, { timeout: 5000 });

    const header = await lena.page.evaluate(
        () => document.querySelector('#page-main > header').getBoundingClientRect().height);
    assert(header < 5, 'шапка не уступила место поиску: ' + header);
});

await step('поиск находит человека и показывает раздел', async () => {
    await lena.page.fill('#chat-search', RUN + 'igor');
    await lena.page.waitForSelector('#global-results .f-item[data-user]', { timeout: 20000 });
    const title = await lena.page.textContent('#global-results .section-title');
    assert(title.includes('Люди'), 'нет заголовка раздела: ' + title);
});

await step('«Отмена» закрывает поиск и возвращает список', async () => {
    await lena.page.click('#search-cancel');
    await lena.page.waitForFunction(() => !document.body.classList.contains('searching'),
        null, { timeout: 5000 });
    const value = await lena.page.inputValue('#chat-search');
    assert(value === '', 'строка поиска не очищена: ' + value);
    const results = await lena.page.evaluate(
        () => document.getElementById('global-results').children.length);
    assert(results === 0, 'результаты остались на экране');
});

await step('запрос попадает в недавние и повторяется одним нажатием', async () => {
    await lena.page.click('#chat-search');
    await lena.page.waitForSelector('#search-recent .chip', { timeout: 10000 });
    const chip = await lena.page.textContent('#search-recent .chip');
    assert(chip.includes(RUN + 'igor'), 'запрос не сохранён: ' + chip);

    await lena.page.click('#search-recent .chip');
    await lena.page.waitForSelector('#global-results .f-item[data-user]', { timeout: 20000 });
    await lena.page.click('#search-cancel');
});

await step('пустой поиск показывает понятное «ничего не найдено»', async () => {
    await lena.page.fill('#chat-search', 'щщщнеттакого');
    await lena.page.waitForFunction(
        () => !document.getElementById('search-empty').hidden, null, { timeout: 20000 });
    await lena.page.click('#search-cancel');
});

/* -------------------------------------------------------------- избранное */

await step('«Избранное» есть у каждого и стоит выше всех чатов', async () => {
    await lena.page.waitForSelector('#chat-list .f-item', { timeout: 20000 });
    const first = await lena.page.textContent('#chat-list .f-item:first-child');
    assert(first.includes('Избранное'), 'первым идёт не «Избранное»: ' + first);
});

await step('запись в «Избранном» уходит на сервер зашифрованной', async () => {
    await lena.page.click('#chat-list .f-item:first-child');
    await lena.page.waitForSelector('#page-chat.active', { timeout: 15000 });
    await lena.page.fill('#m-input', 'Секретная заметка про пароль от сейфа');
    await lena.page.click('#btn-send');
    await lena.page.waitForSelector('.bubble.out:not(.pending)', { timeout: 25000 });

    const room = await lena.page.evaluate(() => window.WM.state.activeRoom);
    const rows = await rawApi(lena.page,
        '/messages?room_id=eq.' + encodeURIComponent(room) + '&select=text,preview');
    assert(rows.length, 'запись не сохранилась');
    assert(String(rows[0].text).indexOf('wm1:') === 0, 'заметка ушла открытым текстом');
    assert(!JSON.stringify(rows).includes('сейф'), 'текст заметки виден на сервере');
});

await step('чужое «Избранное» не читается', async () => {
    const room = await lena.page.evaluate(() => window.WM.state.activeRoom);
    const rows = await rawApi(igor.page,
        '/room_keys?room_id=eq.' + encodeURIComponent(room) +
        '&user_id=eq.' + encodeURIComponent(await igor.page.evaluate(() => window.WM.state.me.id)) +
        '&select=wrapped_key');
    assert(!rows.length, 'ключ чужого раздела доступен постороннему');
});

await step('«Избранное» нельзя удалить из списка', async () => {
    await lena.page.click('#btn-back');
    await lena.page.waitForSelector('#page-main.active', { timeout: 10000 });
    await lena.page.locator('#chat-list .f-item:first-child').dispatchEvent('mousedown');
    await lena.page.waitForSelector('#context-bar.show', { timeout: 5000 });
    await lena.page.click('#ctx-delete');
    await lena.page.waitForTimeout(600);

    const gone = await lena.page.evaluate(
        () => !document.querySelector('#chat-list .f-item').textContent.includes('Избранное'));
    assert(!gone, '«Избранное» удалилось');
    const confirmOpen = await lena.page.isVisible('#confirm-modal.show');
    assert(!confirmOpen, 'предложено удаление личного раздела');
});

/* --------------------------------------------------------------- установка */

await step('окно установки показывает пошаговую инструкцию', async () => {
    await lena.page.click('#btn-settings');
    await lena.page.waitForSelector('#page-settings.active', { timeout: 10000 });
    await lena.page.click('#set-install');
    await lena.page.waitForSelector('#install-modal.show', { timeout: 10000 });

    const tabs = await lena.page.evaluate(
        () => [...document.querySelectorAll('.install-tab')].map((t) => t.textContent));
    assert(tabs.length === 3, 'нет выбора устройства: ' + tabs.join('|'));

    const steps = await lena.page.evaluate(
        () => document.querySelectorAll('.install-steps li').length);
    assert(steps >= 3, 'мало шагов в инструкции: ' + steps);

    // Инструкцию можно посмотреть и для другого устройства.
    await lena.page.click('.install-tab:has-text("iPhone")');
    const ios = await lena.page.textContent('#install-steps');
    assert(ios.includes('Safari'), 'инструкция для iPhone не показана');
    await lena.page.click('#install-close');
});

/* ------------------------------------------------------------- соединение */

await step('в настройках не видно адресов серверов', async () => {
    await lena.page.click('#set-conn');
    await lena.page.waitForSelector('#conn-modal.show', { timeout: 10000 });
    const text = await lena.page.textContent('#conn-modal');
    assert(!/https?:\/\//.test(text), 'на экране виден адрес сервера');
    assert(!text.includes('supabase'), 'на экране видно имя сервера');
    assert(text.includes('Через сервер сайта'), 'нет названий каналов связи');

    const saved = await lena.page.inputValue('#conn-custom');
    assert(saved === '', 'сохранённый адрес показан в поле');
    await lena.page.click('#conn-close');
});

/* ------------------------------------------------------------------- звук */

await step('звук новых сообщений включается и выключается', async () => {
    const before = await lena.page.textContent('#sound-state');
    await lena.page.click('#set-sound');
    const after = await lena.page.textContent('#sound-state');
    assert(before !== after, 'состояние звука не изменилось: ' + before + ' → ' + after);

    await lena.page.click('#set-sound');
    const back = await lena.page.textContent('#sound-state');
    assert(back === before, 'звук не вернулся в исходное состояние');
});

await step('звук звучит при новом сообщении и не повторяется очередью', async () => {
    // Считаем запуски звука, не проигрывая его по-настоящему.
    await lena.page.evaluate(() => {
        window.__chimes = 0;
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const original = Ctx.prototype.createOscillator;
        Ctx.prototype.createOscillator = function () {
            window.__chimes++;
            return original.call(this);
        };
        localStorage.setItem('WM_SOUND', 'on');
    });

    await lena.page.click('#btn-settings-done');
    await igor.page.click('#btn-plus');
    await igor.page.click('#plus-user');
    await igor.page.fill('#prompt-input', RUN + 'lena');
    await igor.page.click('#prompt-ok');
    await igor.page.waitForSelector('#page-chat.active', { timeout: 25000 });
    await igor.page.fill('#m-input', 'Привет, звук!');
    await igor.page.click('#btn-send');

    await lena.page.waitForFunction(() => window.__chimes > 0, null, { timeout: 30000 });
    const count = await lena.page.evaluate(() => window.__chimes);
    assert(count <= 2, 'звук сыграл слишком много раз: ' + count);
});

/* --------------------------------------------------- подмена сервера ссылкой */

await step('ссылка с чужим сервером требует подтверждения', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    await page.goto(BASE + '/?api=' + encodeURIComponent('https://chuzhoy-server.example/rest/v1'));
    await page.waitForSelector('#confirm-modal.show', { timeout: 15000 });

    const text = await page.textContent('#confirm-text');
    assert(text.includes('chuzhoy-server.example'), 'не показано, куда уйдут данные: ' + text);

    await page.click('#confirm-cancel');
    const stored = await page.evaluate(() => localStorage.getItem('WM_API_URL'));
    assert(!stored, 'чужой адрес сохранился без согласия');
    await ctx.close();
});

await browser.close();
console.log('\n=== Итог: ' + (total - failures) + '/' + total + ' проверок, ошибок: ' + failures + ' ===\n');
process.exit(failures ? 1 : 0);
