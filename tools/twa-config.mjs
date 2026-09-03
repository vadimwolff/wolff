/* ==========================================================================
 *  Подготовка android/twa-manifest.json к сборке APK.
 *
 *  Запуск:
 *    node tools/twa-config.mjs https://мой-проект.vercel.app [пакет] [имя] [версия]
 *
 *  Скрипт подставляет адрес сайта во все поля разом — вручную их семь штук,
 *  и промахнуться легко. Всё остальное (цвета, иконки, ярлык) уже прописано.
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'android', 'twa-manifest.json');

const site = String(process.argv[2] || '').trim().replace(/\/+$/, '');
if (!/^https:\/\/[^/]+$/.test(site)) {
    console.error('Укажите адрес сайта целиком, например: https://wolffmsg.vercel.app');
    process.exit(1);
}

const host = new URL(site).host;
const pkg = String(process.argv[3] || '').trim() ||
    // Имя пакета — перевёрнутый адрес сайта: app.vercel.wolffmsg.twa
    host.split('.').reverse().join('.').replace(/[^a-z0-9.]/gi, '') + '.twa';
const name = String(process.argv[4] || 'WolffMsg').trim();
const version = String(process.argv[5] || '').trim();

const manifest = JSON.parse(fs.readFileSync(FILE, 'utf8'));

manifest.host = host;
manifest.packageId = pkg;
manifest.name = name;
manifest.launcherName = name;
manifest.webManifestUrl = site + '/manifest.webmanifest';
manifest.fullScopeUrl = site + '/';
manifest.iconUrl = site + '/assets/icon-512.png';
manifest.maskableIconUrl = site + '/assets/icon-maskable.png';
manifest.monochromeIconUrl = site + '/assets/badge-96.png';
(manifest.shortcuts || []).forEach((s) => { s.chosenIconUrl = site + '/assets/icon-192.png'; });

if (version) {
    manifest.appVersionName = version;
    // Номер сборки должен расти: собираем его из версии вида 1.2.3
    const parts = version.split('.').map((n) => Number(n) || 0);
    manifest.appVersionCode = (parts[0] || 0) * 10000 + (parts[1] || 0) * 100 + (parts[2] || 0);
}

fs.writeFileSync(FILE, JSON.stringify(manifest, null, 2) + '\n');

console.log('Готово:');
console.log('  сайт    ' + site);
console.log('  пакет   ' + manifest.packageId);
console.log('  имя     ' + manifest.name);
console.log('  версия  ' + manifest.appVersionName + ' (сборка ' + manifest.appVersionCode + ')');
