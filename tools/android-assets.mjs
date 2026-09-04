/* ==========================================================================
 *  Кладёт приложение внутрь пакета Android.
 *
 *  Запуск:
 *    node tools/android-assets.mjs https://мой-проект.vercel.app
 *
 *  Копирует все файлы приложения в android-app/app/src/main/assets/www,
 *  прописывает в настройках адрес сервера (внутри пакета «свой домен» — это
 *  сам пакет, поэтому адрес нужно знать заранее) и раскладывает иконки.
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'android-app', 'app', 'src', 'main');
const WWW = path.join(APP, 'assets', 'www');

const site = String(process.argv[2] || '').trim().replace(/\/+$/, '');
if (!/^https:\/\/[^/]+$/.test(site)) {
    console.error('Укажите адрес сервера целиком, например: https://wolffmsg.vercel.app');
    process.exit(1);
}

/* ------------------------------------------------ файлы приложения */

fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(WWW, { recursive: true });

for (const name of ['index.html', 'manifest.webmanifest']) {
    fs.copyFileSync(path.join(ROOT, name), path.join(WWW, name));
}
fs.cpSync(path.join(ROOT, 'assets'), path.join(WWW, 'assets'), { recursive: true });

/* Служебный работник внутри пакета не нужен: файлы и так лежат рядом, а
   перехват запросов только мешал бы. Приложение это понимает само по адресу
   страницы, но на всякий случай файла в пакете просто нет. */

/* ------------------------------------------------ адрес сервера */

/* Внутри пакета «домен сайта» — это сам пакет, поэтому адрес сервера нужно
   знать заранее. Настройки читаем как обычный файл и записываем заново: так
   ничего не сломается от случайной правки текста. */
const configPath = path.join(WWW, 'assets', 'config.js');
const source = fs.readFileSync(configPath, 'utf8');

const holder = {};
// eslint-disable-next-line no-new-func
new Function('window', source)(holder);
const config = holder.WM_CONFIG;

if (!config || !Array.isArray(config.endpoints)) {
    console.error('Не удалось прочитать assets/config.js');
    process.exit(1);
}

config.serverUrl = site;
config.endpoints = [{ url: site + '/api/db', label: 'Через сервер сайта' }].concat(
    config.endpoints.filter((e) => String(e.url).indexOf('same-origin:') !== 0)
);

fs.writeFileSync(configPath,
    '/* Настройки для приложения Android — собраны автоматически при сборке.\n' +
    '   Исходный файл с пояснениями лежит в assets/config.js. */\n' +
    'window.WM_CONFIG = ' + JSON.stringify(config, null, 4) + ';\n');

/* ------------------------------------------------ иконки приложения */

const icons = [
    ['assets/icon-512.png', 'res/mipmap-xxxhdpi/ic_launcher.png'],
    ['assets/icon-maskable.png', 'res/drawable/ic_launcher_fg.png']
];

for (const [from, to] of icons) {
    const target = path.join(APP, to);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, from), target);
}

const files = fs.readdirSync(path.join(WWW, 'assets')).length;
console.log('В пакет уложено: index.html, manifest и ' + files + ' файлов приложения');
console.log('Сервер для переписки: ' + site);
