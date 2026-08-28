/* ==========================================================================
 *  WolffMsg — сквозное шифрование переписки (AES-256-GCM).
 *
 *  Как это работает:
 *    · собеседники один раз договариваются о секретном коде чата и вводят его
 *      каждый у себя — код передаётся любым другим способом, не через этот чат;
 *    · из кода и идентификатора комнаты выводится ключ (PBKDF2-SHA256,
 *      210 000 итераций), сам код и ключ никогда не уходят на сервер;
 *    · в базу попадает только шифртекст вида wm1:<iv>:<данные>.
 *
 *  Что это даёт: ни владелец базы, ни тот, у кого оказался публичный ключ
 *  приложения, не прочитает переписку — у него нет кода.
 *  Чего это не даёт: защиты от того, кто знает код, и от подмены самого сайта.
 * ========================================================================== */

(function () {
    'use strict';

    var subtle = (window.crypto && window.crypto.subtle) || null;
    var PREFIX = 'wm1:';
    var ITERATIONS = 210000;

    function available() {
        return !!subtle;
    }

    function bytesToB64(bytes) {
        var bin = '';
        var arr = new Uint8Array(bytes);
        for (var i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
        return btoa(bin);
    }

    function b64ToBytes(b64) {
        var bin = atob(b64);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function deriveKey(code, room) {
        var enc = new TextEncoder();
        return subtle.importKey('raw', enc.encode(String(code)), 'PBKDF2', false, ['deriveKey'])
            .then(function (base) {
                return subtle.deriveKey({
                    name: 'PBKDF2',
                    salt: enc.encode('wolffmsg:' + String(room)),
                    iterations: ITERATIONS,
                    hash: 'SHA-256'
                }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
            });
    }

    function encrypt(key, text) {
        var iv = window.crypto.getRandomValues(new Uint8Array(12));
        return subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(String(text)))
            .then(function (cipher) {
                return PREFIX + bytesToB64(iv) + ':' + bytesToB64(cipher);
            });
    }

    function decrypt(key, payload) {
        if (!isEncrypted(payload)) return Promise.resolve(payload);
        var parts = String(payload).slice(PREFIX.length).split(':');
        if (parts.length !== 2) return Promise.reject(new Error('bad_payload'));
        var iv = b64ToBytes(parts[0]);
        var data = b64ToBytes(parts[1]);
        return subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, data)
            .then(function (plain) { return new TextDecoder().decode(plain); });
    }

    function isEncrypted(text) {
        return typeof text === 'string' && text.indexOf(PREFIX) === 0;
    }

    window.WMCrypto = {
        available: available,
        deriveKey: deriveKey,
        encrypt: encrypt,
        decrypt: decrypt,
        isEncrypted: isEncrypted
    };
})();
