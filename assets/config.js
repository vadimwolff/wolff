/* ==========================================================================
 * WolffMsg — конфигурация подключения
 *
 * Приложение работает с любым PostgREST-совместимым адресом (Supabase REST).
 * Список ниже перебирается сверху вниз: первый ответивший адрес становится
 * рабочим и запоминается. Это нужно, чтобы сайт продолжал работать из сетей,
 * где часть доменов недоступна.
 * ========================================================================== */

window.WM_CONFIG = {
    /* Публичный anon-ключ Supabase. Он предназначен для клиента и не является
       секретом; доступ к данным ограничивается политиками RLS в базе. */
    apiKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ6Z2l5YWZwa2VxdmJwcW9tYmtyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3NzU5MTksImV4cCI6MjA5NDM1MTkxOX0.qvKNRcO-ylrWzOFYxEvWhcGBeSCxoanZx4i1VnhF7_w",

    endpoints: [
        {
            /* Работает, когда сайт развёрнут на Vercel: запрос идёт на тот же
               домен, что и сайт, и уже сервер обращается к базе. Самый надёжный
               вариант для России — сторонние домены не задействуются. */
            url: "same-origin:/api/db",
            label: "Через сервер сайта"
        },
        {
            url: "https://myproxy.vadimwolff2000.workers.dev/rest/v1",
            label: "Резервный канал"
        },
        {
            url: "https://rzgiyafpkeqvbpqombkr.supabase.co/rest/v1",
            label: "Основной сервер"
        }
    ],

    /* Сервер уведомлений (тот, что рассылает их при закрытом приложении).
       Пусто — приложение ищет его само: рядом с адресом базы /api/db и на
       домене самого сайта по адресу /api/push. */
    pushUrl: "",

    /* Сервер помощника WolffAI. Пусто — приложение ищет его само рядом с
       адресом базы и на домене сайта, по адресу /api/ai. */
    aiUrl: "",

    /* Серверы для звонков. STUN помогает двум устройствам найти друг друга
       через интернет. Если звонки не соединяются из некоторых сетей, сюда
       добавляют свой TURN-сервер: { urls, username, credential }. */
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
        { urls: "stun:stun.cloudflare.com:3478" }
    ],

    /* Интервалы опроса сервера, мс */
    pollChatMs: 2000,
    pollListMs: 5000,

    /* Ограничения на загружаемые изображения */
    imageMaxSide: 1280,
    imageQuality: 0.72
};
