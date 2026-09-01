/* ==========================================================================
 *  Проверки доставки уведомлений при закрытом приложении.
 *
 *  Браузеру уведомление приходит не от приложения, а от службы доставки, и
 *  принимает она его только если тело зашифровано ровно по стандарту.
 *  Проверить это «вживую» нельзя, поэтому здесь:
 *
 *   · постоянный образец: те же ключи и соль обязаны дать тот же результат
 *     байт в байт. Образец получен нашей реализацией и сверен с эталонной
 *     библиотекой http_ece — той же, что используют готовые серверы push;
 *   · обратная расшифровка со стороны браузера: ключ выводится из закрытого
 *     ключа подписки, и текст должен совпасть;
 *   · разбор заголовка тела по RFC 8188;
 *   · подпись VAPID проверяется открытым ключом.
 * ========================================================================== */

import crypto from 'node:crypto';
import { encryptPayload, vapidAuth, generateVapidKeys, b64url, fromB64url }
    from '../api/_webpush.mjs';

let total = 0, failures = 0;

function step(name, fn) {
    total++;
    try { fn(); console.log('  ✓ ' + name); }
    catch (err) { failures++; console.log('  ✗ ' + name + ' — ' + err.message); }
}

function assert(cond, message) { if (!cond) throw new Error(message); }

/* Постоянные значения образца. */
const UA_PRIVATE = Buffer.from(
    '9f1e0f0b6b2a3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5', 'hex');
const P256DH = 'BLDgxaBs4WISA1D_D3sgi4Kpe0mVdbuw5EHu-Dc8u0W745Q-6U_4wINV8j1juJo2oe5XpSFTCqs8HuJEboc67LM';
const AUTH = 'AQIDBAUGBwgJCgsMDQ4PEA';
const SALT = 'ESIzRFVmd4iZqrvM3e7_AA';
const AS_PRIVATE = 'TF1uf4CRorPE1eb3CBkqO0xdbn-AkaKzxNXm9wgZKjs';
const MESSAGE = '{"title":"Аня","body":"Новое сообщение","room":"r1","msg":42}';
const EXPECTED = 'ESIzRFVmd4iZqrvM3e7_AAAAEABBBKPmKyzLy2gjcqzfG5baC7qC8ZlpCOj-Cjz7cAW9uXMj' +
    'R6XIS23nBSAk6EeY3SZ71uhOO_6OR3luXFh8ZqNoOcUGWqCoYWUyxBQlzwjUG1UwKAJHnJTLLffFeTkrJUSaba6i' +
    'R9NJdRXSvSLOke_p4o2Sr7USFioAp51UGUST8oqTb0M02gXOVvokpKHKzXuFtiymjjzce-MS6eicgeQ-zQ';

console.log('\n=== WolffMsg: уведомления при закрытом приложении ===');

step('шифрование совпадает с проверенным образцом', () => {
    const body = encryptPayload(MESSAGE, P256DH, AUTH, { salt: SALT, privateKey: AS_PRIVATE });
    assert(b64url(body) === EXPECTED, 'тело push изменилось — служба доставки его отвергнет');
});

step('тело собрано по стандарту: соль, размер записи, наш ключ', () => {
    const body = encryptPayload(MESSAGE, P256DH, AUTH, { salt: SALT, privateKey: AS_PRIVATE });
    assert(b64url(body.subarray(0, 16)) === SALT, 'соль не в начале тела');
    assert(body.readUInt32BE(16) === 4096, 'неверный размер записи: ' + body.readUInt32BE(16));
    assert(body[20] === 65, 'неверная длина открытого ключа: ' + body[20]);
    assert(body[21] === 4, 'ключ должен быть в несжатом виде');
    // 21 байт заголовка + 65 байт ключа + текст + признак конца + метка целостности
    assert(body.length === 21 + 65 + Buffer.byteLength(MESSAGE) + 1 + 16,
        'неожиданная длина тела: ' + body.length);
});

step('браузер расшифровывает уведомление своим ключом', () => {
    const body = encryptPayload(MESSAGE, P256DH, AUTH);
    const salt = body.subarray(0, 16);
    const asPublic = body.subarray(21, 86);
    const payload = body.subarray(86);

    const ua = crypto.createECDH('prime256v1');
    ua.setPrivateKey(UA_PRIVATE);
    const shared = ua.computeSecret(asPublic);

    const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
    const info = (text) => Buffer.concat([Buffer.from(text), Buffer.from([0])]);
    const hkdf = (s, ikm, i, len) =>
        hmac(hmac(s, ikm), Buffer.concat([i, Buffer.from([1])])).subarray(0, len);

    const prkKey = hmac(fromB64url(AUTH), shared);
    const keyInfo = Buffer.concat([info('WebPush: info'), ua.getPublicKey(), asPublic]);
    const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
    const cek = hkdf(salt, ikm, info('Content-Encoding: aes128gcm'), 16);
    const nonce = hkdf(salt, ikm, info('Content-Encoding: nonce'), 12);

    const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(payload.subarray(payload.length - 16));
    const plain = Buffer.concat([
        decipher.update(payload.subarray(0, payload.length - 16)),
        decipher.final()
    ]);

    assert(plain[plain.length - 1] === 2, 'нет признака последней записи');
    assert(plain.subarray(0, plain.length - 1).toString('utf8') === MESSAGE,
        'текст уведомления не расшифровался');
});

step('каждое уведомление шифруется заново', () => {
    const a = encryptPayload(MESSAGE, P256DH, AUTH);
    const b = encryptPayload(MESSAGE, P256DH, AUTH);
    assert(!a.equals(b), 'соль и временный ключ повторяются — так делать нельзя');
});

step('подпись VAPID проверяется открытым ключом', () => {
    const keys = generateVapidKeys();
    const header = vapidAuth('https://fcm.googleapis.com/fcm/send/abc',
        keys.publicKey, keys.privateKey, 'mailto:me@example.com');

    assert(header.indexOf('vapid t=') === 0, 'неверный вид заголовка: ' + header.slice(0, 20));
    assert(header.indexOf(', k=' + keys.publicKey) > 0, 'в заголовке нет открытого ключа');

    const token = header.slice('vapid t='.length).split(',')[0];
    const [head, claims, signature] = token.split('.');
    const pub = fromB64url(keys.publicKey);
    const verifyKey = crypto.createPublicKey({
        format: 'jwk',
        key: {
            kty: 'EC', crv: 'P-256',
            x: b64url(pub.subarray(1, 33)),
            y: b64url(pub.subarray(33, 65))
        }
    });

    const ok = crypto.verify('sha256', Buffer.from(head + '.' + claims),
        { key: verifyKey, dsaEncoding: 'ieee-p1363' }, fromB64url(signature));
    assert(ok, 'служба доставки отвергнет такую подпись');

    const body = JSON.parse(fromB64url(claims).toString('utf8'));
    assert(body.aud === 'https://fcm.googleapis.com', 'неверный адресат токена: ' + body.aud);
    assert(body.exp > Math.floor(Date.now() / 1000), 'токен уже просрочен');
    assert(body.sub === 'mailto:me@example.com', 'потерян контакт отправителя');
});

step('ключи VAPID пригодны для подписки браузера', () => {
    const keys = generateVapidKeys();
    const pub = fromB64url(keys.publicKey);
    assert(pub.length === 65 && pub[0] === 4, 'открытый ключ не в том виде, что ждёт браузер');
    assert(fromB64url(keys.privateKey).length === 32, 'закрытый ключ неверной длины');
});

console.log('\n=== Итог: ' + (total - failures) + '/' + total +
    ' проверок, ошибок: ' + failures + ' ===\n');
process.exit(failures ? 1 : 0);
