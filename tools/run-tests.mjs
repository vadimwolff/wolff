/* Поднимает оба стенда, прогоняет оба набора тестов и гасит серверы. */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function start(port, extraEnv = {}) {
    return spawn(process.execPath, [path.join(ROOT, 'tools/mock-postgrest.mjs'), String(port)], {
        cwd: ROOT,
        env: { ...process.env, WM_LEGACY: '', WM_DENY: '', ...extraEnv },
        stdio: 'ignore'
    });
}

function run(script, env = {}) {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [path.join(ROOT, script)], {
            cwd: ROOT,
            env: { ...process.env, ...env },
            stdio: 'inherit'
        });
        p.on('exit', (code) => resolve(code || 0));
    });
}

const servers = [
    start(8123),                            // обычная схема
    start(8124, { WM_LEGACY: '1' }),        // старая схема без функций входа
    start(8125, { WM_DENY: 'warmup' }),     // кеш API прогревается
    start(8126, { WM_DENY: 'always' }),     // кеш API не обновился
    start(8127, { WM_OLDCHATS: '1' })       // база без колонок каналов и ответов
];
await new Promise((r) => setTimeout(r, 1500));

let code = 0;
code += await run('tools/e2e.mjs', { WM_BASE: 'http://localhost:8123' });
code += await run('tools/e2e-legacy.mjs', { WM_BASE: 'http://localhost:8124' });
code += await run('tools/e2e-v50.mjs', { WM_BASE: 'http://localhost:8123' });
code += await run('tools/e2e-v51.mjs', {
    WM_BASE: 'http://localhost:8123',
    WM_BASE_OLD: 'http://localhost:8127'
});
code += await run('tools/e2e-v52.mjs', {
    WM_BASE: 'http://localhost:8123',
    WM_BASE_OLD: 'http://localhost:8127'
});
code += await run('tools/e2e-v53.mjs', { WM_BASE: 'http://localhost:8123' });
code += await run('tools/e2e-v54.mjs', { WM_BASE: 'http://localhost:8123' });
code += await run('tools/e2e-v55.mjs', { WM_BASE: 'http://localhost:8123' });
code += await run('tools/e2e-schema.mjs', {
    WM_BASE_WARMUP: 'http://localhost:8125',
    WM_BASE_ALWAYS: 'http://localhost:8126'
});

servers.forEach((s) => s.kill());
process.exit(code ? 1 : 0);
