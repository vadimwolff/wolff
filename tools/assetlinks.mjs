/* ==========================================================================
 *  Печатает содержимое .well-known/assetlinks.json — файла, который связывает
 *  сайт с приложением. Без него Android показывает поверх приложения адресную
 *  строку браузера.
 *
 *  Запуск (отпечаток ключа берётся из переменной FP):
 *    FP=AB:CD:… node tools/assetlinks.mjs > .well-known/assetlinks.json
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'android', 'twa-manifest.json'), 'utf8'));

const fingerprint = String(process.env.FP || '').trim();
if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/i.test(fingerprint)) {
    console.error('Нужен отпечаток ключа в переменной FP (32 пары через двоеточие).');
    process.exit(1);
}

console.log(JSON.stringify([{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
        namespace: 'android_app',
        package_name: manifest.packageId,
        sha256_cert_fingerprints: [fingerprint.toUpperCase()]
    }
}], null, 2));
