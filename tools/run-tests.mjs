/* Поднимает оба стенда, прогоняет оба набора тестов и гасит серверы. */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function start(port, legacy) {
    return spawn(process.execPath, [path.join(ROOT, 'tools/mock-postgrest.mjs'), String(port)], {
        cwd: ROOT,
        env: { ...process.env, WM_LEGACY: legacy ? '1' : '' },
        stdio: 'ignore'
    });
}

function run(script, base) {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [path.join(ROOT, script)], {
            cwd: ROOT,
            env: { ...process.env, WM_BASE: base },
            stdio: 'inherit'
        });
        p.on('exit', (code) => resolve(code || 0));
    });
}

const modern = start(8123, false);
const legacy = start(8124, true);
await new Promise((r) => setTimeout(r, 1500));

let code = 0;
code += await run('tools/e2e.mjs', 'http://localhost:8123');
code += await run('tools/e2e-legacy.mjs', 'http://localhost:8124');

modern.kill();
legacy.kill();
process.exit(code ? 1 : 0);
