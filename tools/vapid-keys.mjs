/* ==========================================================================
 *  Печатает пару ключей для уведомлений (VAPID).
 *
 *  Запуск: node tools/vapid-keys.mjs
 *
 *  Открытый ключ приложение забирает с сервера само — его никуда вписывать не
 *  нужно. Оба значения добавляются в настройки проекта на Vercel.
 * ========================================================================== */

import { generateVapidKeys } from '../api/_webpush.mjs';

const keys = generateVapidKeys();

console.log('\nДобавьте это в Vercel → Settings → Environment Variables:\n');
console.log('VAPID_PUBLIC_KEY  = ' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY = ' + keys.privateKey);
console.log('VAPID_SUBJECT     = mailto:ваша-почта@example.com');
console.log('\nЗакрытый ключ никому не показывайте: он подтверждает,');
console.log('что уведомления рассылает именно ваш сервер.\n');
