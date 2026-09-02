/* ==========================================================================
 *  Сборка PNG-иконок из SVG.
 *
 *  Запуск: node tools/make-icons.mjs
 *  Рисует картинки headless-браузером, поэтому дополнительных пакетов не нужно.
 * ========================================================================== */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* transparent: true — фон не заливается, нужен для значка строки состояния. */
const JOBS = [
    { svg: 'assets/badge.svg', out: 'assets/badge-96.png', size: 96, transparent: true },
    { svg: 'assets/icon.svg', out: 'assets/icon-192.png', size: 192 },
    { svg: 'assets/icon.svg', out: 'assets/icon-512.png', size: 512 },
    { svg: 'assets/icon.svg', out: 'assets/apple-touch-icon.png', size: 180 },
    { svg: 'assets/icon-maskable.svg', out: 'assets/icon-maskable.png', size: 512 }
];

const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox']
});

for (const job of JOBS) {
    const svg = fs.readFileSync(path.join(ROOT, job.svg), 'utf8');
    const page = await browser.newPage({
        viewport: { width: job.size, height: job.size },
        deviceScaleFactor: 1
    });
    await page.setContent(
        '<style>html,body{margin:0;padding:0;background:transparent}' +
        'svg{display:block;width:' + job.size + 'px;height:' + job.size + 'px}</style>' + svg,
        { waitUntil: 'load' }
    );
    await page.screenshot({
        path: path.join(ROOT, job.out),
        omitBackground: !!job.transparent
    });
    await page.close();
    console.log(job.out);
}

await browser.close();
