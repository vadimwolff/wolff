-- ============================================================================
--  WolffMsg — проверка базы.
--
--  Выполните этот скрипт в Supabase → SQL Editor, чтобы увидеть, чего не
--  хватает. Он ничего не меняет, только смотрит. В колонке «состояние»
--  должно быть «есть» у каждой строки; если где-то «НЕТ» — выполните
--  db/schema.sql целиком и запустите проверку снова.
-- ============================================================================

with expected(kind, name, hint) as (
    values
        ('таблица',  'profiles',          'профили пользователей'),
        ('таблица',  'chats',             'чаты, группы и каналы'),
        ('таблица',  'messages',          'сообщения и записи каналов'),
        ('таблица',  'room_reads',        'отметки о прочтении'),
        ('таблица',  'room_keys',         'ключи шифрования чатов'),
        ('колонка',  'chats.slug',        'короткая ссылка канала'),
        ('колонка',  'chats.about',       'описание канала'),
        ('колонка',  'chats.owner_id',    'владелец канала'),
        ('колонка',  'chats.is_public',   'канал виден в поиске'),
        ('колонка',  'chats.subscribers', 'число подписчиков'),
        ('колонка',  'messages.preview',  'подпись для списка чатов'),
        ('колонка',  'messages.reply_to', 'ответы на сообщения'),
        ('колонка',  'profiles.public_key',      'открытый ключ шифрования'),
        ('колонка',  'profiles.enc_private_key', 'закрытый ключ (зашифрован)'),
        ('функция',  'wm_register',       'регистрация'),
        ('функция',  'wm_login',          'вход'),
        ('функция',  'wm_set_password',   'смена пароля'),
        ('функция',  'wm_set_keys',       'выдача ключей старым аккаунтам'),
        ('функция',  'wm_create_channel', 'СОЗДАНИЕ КАНАЛОВ'),
        ('функция',  'wm_join_chat',      'подписка на канал'),
        ('функция',  'wm_leave_chat',     'отписка'),
        ('функция',  'wm_search',         'поиск каналов и людей'),
        ('представление', 'chat_previews', 'подписи в списке чатов')
)
select
    e.kind      as "что",
    e.name      as "название",
    e.hint      as "зачем",
    case when exists (
        select 1 from information_schema.tables t
         where t.table_schema = 'public' and t.table_name = e.name
           and e.kind = 'таблица'
        union all
        select 1 from information_schema.views v
         where v.table_schema = 'public' and v.table_name = e.name
           and e.kind = 'представление'
        union all
        select 1 from information_schema.columns c
         where c.table_schema = 'public'
           and c.table_name = split_part(e.name, '.', 1)
           and c.column_name = split_part(e.name, '.', 2)
           and e.kind = 'колонка'
        union all
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = e.name
           and e.kind = 'функция'
    ) then 'есть' else 'НЕТ' end as "состояние"
from expected e
order by
    case when e.kind = 'функция' then 1 else 2 end,
    e.name;
