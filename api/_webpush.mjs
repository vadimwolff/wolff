/* ==========================================================================
 *  Отправка уведомлений браузеру (Web Push).
 *
 *  Здесь собрано ровно то, что требуют стандарты:
 *
 *   · RFC 8291 — payload шифруется для конкретного браузера. Ключ выводится
 *     из общего секрета ECDH (наш временный ключ + открытый ключ браузера) и
 *     секрета auth, который браузер выдал вместе с подпиской;
 *   · RFC 8188 — формат тела: соль, размер записи, наш открытый ключ и сам
 *     шифртекст AES-128-GCM;
 *   · RFC 8292 (VAPID) — заголовок Authorization с подписанным токеном,
 *     по которому служба доставки понимает, что отправитель тот же самый,
 *     на кого подписался браузер.
 *
 *  Сторонние пакеты не нужны: всё делает встроенный модуль node:crypto.
 *  Текст сообщения сюда не попадает — он зашифрован ключом чата, и сервер
 *  отправляет только имя отправителя и адрес чата.
 * ========================================================================== */

import crypto from 'node:crypto';

const CURVE = 'prime256v1';

export function b64url(buf) {
    return Buffer.from(buf).toString('base64url');
}

export function fromB64url(text) {
    return Buffer.from(String(text), 'base64url');
}

function hmac(key, data) {
    return crypto.createHmac('sha256', key).update(data).digest();
}

/* HKDF в том виде, в каком его используют оба стандарта: одна итерация. */
function hkdf(salt, ikm, info, length) {
    const prk = hmac(salt, ikm);
    return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

function infoString(text) {
    return Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]);
}

/* ------------------------------------------------------------- шифрование */

/**
 * Собирает тело push-запроса для одной подписки.
 * options.salt и options.privateKey задаются только в тестах, чтобы результат
 * был воспроизводимым; в бою и то и другое случайно.
 */
export function encryptPayload(payload, p256dh, authSecret, options) {
    const opts = options || {};
    const uaPublic = fromB64url(p256dh);
    const auth = fromB64url(authSecret);

    const ecdh = crypto.createECDH(CURVE);
    if (opts.privateKey) ecdh.setPrivateKey(fromB64url(opts.privateKey));
    else ecdh.generateKeys();

    const asPublic = ecdh.getPublicKey();               // 65 байт, несжатый вид
    const shared = ecdh.computeSecret(uaPublic);

    // Ключ, из которого выводится всё остальное. Порядок ключей в key_info
    // важен: сначала открытый ключ браузера, затем наш.
    const prkKey = hmac(auth, shared);
    const keyInfo = Buffer.concat([infoString('WebPush: info'), uaPublic, asPublic]);
    const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));

    const salt = opts.salt ? fromB64url(opts.salt) : crypto.randomBytes(16);
    const cek = hkdf(salt, ikm, infoString('Content-Encoding: aes128gcm'), 16);
    const nonce = hkdf(salt, ikm, infoString('Content-Encoding: nonce'), 12);

    const plain = Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([2])]);  // 2 — конец
    const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);

    const header = Buffer.alloc(21);
    salt.copy(header, 0);
    header.writeUInt32BE(4096, 16);            // размер записи
    header.writeUInt8(asPublic.length, 20);

    return Buffer.concat([header, asPublic, body]);
}

/* ------------------------------------------------------------------ VAPID */

/* Ключ в виде объекта: из 32 байт закрытого ключа и 65 байт открытого. */
function vapidKey(publicKey, privateKey) {
    const pub = fromB64url(publicKey);
    return crypto.createPrivateKey({
        format: 'jwk',
        key: {
            kty: 'EC',
            crv: 'P-256',
            x: b64url(pub.subarray(1, 33)),
            y: b64url(pub.subarray(33, 65)),
            d: b64url(fromB64url(privateKey))
        }
    });
}

export function vapidAuth(endpoint, publicKey, privateKey, subject) {
    const audience = new URL(endpoint).origin;
    const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64url(JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: subject || 'mailto:admin@example.com'
    }));

    const signed = header + '.' + claims;
    const signature = crypto.sign('sha256', Buffer.from(signed), {
        key: vapidKey(publicKey, privateKey),
        dsaEncoding: 'ieee-p1363'                 // подпись как r||s, а не DER
    });

    return 'vapid t=' + signed + '.' + b64url(signature) + ', k=' + publicKey;
}

/* ------------------------------------------------------------- отправка */

/**
 * Возвращает { status } одной доставки. 404 и 410 означают, что подписка
 * больше не существует и её пора удалить из базы.
 */
export async function sendPush(subscription, payload, keys, ttl) {
    const body = encryptPayload(payload, subscription.p256dh, subscription.auth);
    const response = await fetch(subscription.endpoint, {
        method: 'POST',
        headers: {
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(body.length),
            TTL: String(ttl || 86400),
            Urgency: 'high',
            Authorization: vapidAuth(subscription.endpoint, keys.publicKey, keys.privateKey, keys.subject)
        },
        body,
        signal: AbortSignal.timeout(10000)
    });
    return { status: response.status };
}

/* Пара ключей VAPID: открытый кладётся в приложение, закрытый — в настройки
   сервера. Используется скриптом tools/vapid-keys.mjs. */
export function generateVapidKeys() {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: CURVE });
    const jwk = pair.privateKey.export({ format: 'jwk' });
    const publicKey = Buffer.concat([
        Buffer.from([4]), fromB64url(jwk.x), fromB64url(jwk.y)
    ]);
    return { publicKey: b64url(publicKey), privateKey: jwk.d };
}
