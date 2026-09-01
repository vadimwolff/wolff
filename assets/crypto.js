/* ==========================================================================
 *  WolffMsg — криптография.
 *
 *  Модель:
 *    · при регистрации устройство создаёт пару ключей ECDH P-256;
 *    · закрытый ключ шифруется ключом, выведенным из пароля (PBKDF2-SHA256,
 *      210 000 итераций), и только в таком виде хранится на сервере;
 *    · открытый ключ лежит в профиле и доступен собеседникам;
 *    · у каждого чата свой случайный ключ AES-256-GCM; он зашифрован для
 *      каждого участника общим секретом ECDH и хранится в room_keys;
 *    · сообщения, цитаты и фотографии шифруются ключом чата.
 *
 *  Сервер видит только шифртекст и открытые ключи. Ни пароль, ни закрытый
 *  ключ, ни ключ чата в открытом виде туда не попадают.
 * ========================================================================== */

(function () {
    'use strict';

    var subtle = (window.crypto && window.crypto.subtle) || null;
    var PREFIX = 'wm1:';
    var ITERATIONS = 210000;
    var CURVE = { name: 'ECDH', namedCurve: 'P-256' };

    function available() {
        return !!subtle;
    }

    /* ------------------------------------------------------- преобразования */

    function bytesToB64(bytes) {
        var bin = '';
        var arr = new Uint8Array(bytes);
        var chunk = 0x8000;
        for (var i = 0; i < arr.length; i += chunk) {
            bin += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
        }
        return btoa(bin);
    }

    function b64ToBytes(b64) {
        var bin = atob(String(b64));
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function randomSalt() {
        return bytesToB64(window.crypto.getRandomValues(new Uint8Array(16)));
    }

    /* ------------------------------------------------ симметричное шифрование */

    function encrypt(key, text) {
        var iv = window.crypto.getRandomValues(new Uint8Array(12));
        return subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(String(text)))
            .then(function (cipher) { return PREFIX + bytesToB64(iv) + ':' + bytesToB64(cipher); });
    }

    function decrypt(key, payload) {
        if (!isEncrypted(payload)) return Promise.resolve(payload);
        var parts = String(payload).slice(PREFIX.length).split(':');
        if (parts.length !== 2) return Promise.reject(new Error('bad_payload'));
        return subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(parts[0]) }, key, b64ToBytes(parts[1]))
            .then(function (plain) { return new TextDecoder().decode(plain); });
    }

    function isEncrypted(text) {
        return typeof text === 'string' && text.indexOf(PREFIX) === 0;
    }

    /* ------------------------------------------------- ключ из пароля (PBKDF2) */

    function passwordKey(password, saltB64) {
        var enc = new TextEncoder();
        return subtle.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveKey'])
            .then(function (base) {
                return subtle.deriveKey({
                    name: 'PBKDF2',
                    salt: b64ToBytes(saltB64),
                    iterations: ITERATIONS,
                    hash: 'SHA-256'
                }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
            });
    }

    /* Совместимость: ключ чата из секретного кода (ручной режим прошлой версии). */
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

    /* ------------------------------------------------------------ личные ключи */

    function generateIdentity() {
        return subtle.generateKey(CURVE, true, ['deriveKey', 'deriveBits']).then(function (pair) {
            return subtle.exportKey('spki', pair.publicKey).then(function (spki) {
                return { publicKey: bytesToB64(spki), privateKey: pair.privateKey, pair: pair };
            });
        });
    }

    function importPublic(b64) {
        return subtle.importKey('spki', b64ToBytes(b64), CURVE, true, []);
    }

    function exportPrivateJwk(privateKey) {
        return subtle.exportKey('jwk', privateKey);
    }

    /* По умолчанию ключ создаётся «неизвлекаемым»: браузер даёт им подписывать
       и расшифровывать, но не отдаёт его содержимое даже своему же коду.
       Извлекаемая копия нужна ровно в двух местах — при выдаче ключей и при
       смене пароля, когда закрытый ключ надо перешифровать заново. */
    function importPrivateJwk(jwk, extractable) {
        return subtle.importKey('jwk', jwk, CURVE, extractable === true, ['deriveKey', 'deriveBits']);
    }

    /* Копия ключа, которую нельзя выгрузить наружу. */
    function hardenPrivate(privateKey) {
        return exportPrivateJwk(privateKey).then(function (jwk) {
            return importPrivateJwk(jwk, false);
        });
    }

    /* Закрытый ключ шифруется ключом из пароля — на сервер уходит только это. */
    function wrapPrivate(privateKey, keyFromPassword) {
        return exportPrivateJwk(privateKey).then(function (jwk) {
            return encrypt(keyFromPassword, JSON.stringify(jwk));
        });
    }

    function unwrapPrivate(payload, keyFromPassword, extractable) {
        return decrypt(keyFromPassword, payload).then(function (json) {
            return importPrivateJwk(JSON.parse(json), extractable);
        });
    }

    /* Общий секрет двух участников: ECDH. Наружу никогда не выходит. */
    function sharedKey(myPrivateKey, theirPublicB64) {
        return importPublic(theirPublicB64).then(function (pub) {
            return subtle.deriveKey({ name: 'ECDH', public: pub }, myPrivateKey,
                { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        });
    }

    /* ------------------------------------------------------------- ключ чата */

    function randomRoomKey() {
        return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    }

    function exportRoomKey(key) {
        return subtle.exportKey('raw', key).then(bytesToB64);
    }

    function importRoomKey(b64) {
        return subtle.importKey('raw', b64ToBytes(b64), { name: 'AES-GCM', length: 256 },
            true, ['encrypt', 'decrypt']);
    }

    /* Код безопасности: совпадает у обоих собеседников, если ключи не подменены. */
    function fingerprint(pubA, pubB) {
        var pair = [String(pubA || ''), String(pubB || '')].sort().join('|');
        return subtle.digest('SHA-256', new TextEncoder().encode(pair)).then(function (hash) {
            var bytes = new Uint8Array(hash).subarray(0, 10);
            var hex = '';
            for (var i = 0; i < bytes.length; i++) {
                hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
            }
            return hex.toUpperCase().replace(/(.{4})/g, '$1 ').trim();
        });
    }

    window.WMCrypto = {
        available: available,
        isEncrypted: isEncrypted,
        encrypt: encrypt,
        decrypt: decrypt,
        deriveKey: deriveKey,
        randomSalt: randomSalt,
        passwordKey: passwordKey,
        generateIdentity: generateIdentity,
        importPublic: importPublic,
        exportPrivateJwk: exportPrivateJwk,
        importPrivateJwk: importPrivateJwk,
        hardenPrivate: hardenPrivate,
        wrapPrivate: wrapPrivate,
        unwrapPrivate: unwrapPrivate,
        sharedKey: sharedKey,
        randomRoomKey: randomRoomKey,
        exportRoomKey: exportRoomKey,
        importRoomKey: importRoomKey,
        fingerprint: fingerprint
    };
})();
