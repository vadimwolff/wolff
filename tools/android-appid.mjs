/* ==========================================================================
 *  Имя пакета для приложения Android.
 *
 *  Android требует имя вида «что-то.что-то»: только маленькие латинские буквы,
 *  цифры и точки, каждая часть начинается с буквы, хотя бы одна точка. Человеку
 *  такие правила знать не обязательно, поэтому что бы ни ввели — приводим к
 *  правильному виду, а пустое поле выводим из адреса сайта.
 *
 *  Запуск:
 *    node tools/android-appid.mjs "WolffMsg" "https://wolffmsg.vercel.app"
 *      → app.wolffmsg
 *    node tools/android-appid.mjs "" "https://wolffmsg.vercel.app"
 *      → app.vercel.wolffmsg
 * ========================================================================== */

export function cleanAppId(raw) {
    const parts = String(raw || '')
        .toLowerCase()
        .replace(/[^a-z0-9._]/g, '')
        .split('.')
        .filter(Boolean)
        // Часть имени не может начинаться с цифры или подчёркивания.
        .map((part) => (/^[a-z]/.test(part) ? part : 'a' + part));
    return parts.join('.');
}

export function appIdFor(raw, site) {
    const given = cleanAppId(raw);
    if (given.indexOf('.') > 0) return given;          // уже годится

    let fromSite = '';
    try {
        fromSite = cleanAppId(new URL(site).host.split('.').reverse().join('.'));
    } catch (e) { /* адреса нет — обойдёмся */ }

    // Ввели одно слово — дописываем «app.», иначе берём адрес сайта наоборот.
    if (given) return 'app.' + given;
    return fromSite && fromSite.indexOf('.') > 0 ? fromSite : 'app.wolffmsg';
}

const direct = process.argv[1] && process.argv[1].endsWith('android-appid.mjs');
if (direct) {
    console.log(appIdFor(process.argv[2], process.argv[3]));
}
