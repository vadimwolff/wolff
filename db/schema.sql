-- ============================================================================
--  WolffMsg — схема базы для Supabase (PostgreSQL)
--
--  Запустить в Supabase → SQL Editor → New query → Run.
--
--  Скрипт безопасен для существующей базы: ничего не удаляется, недостающее
--  добавляется. Все шаги, способные завершиться ошибкой на «грязных» данных,
--  обёрнуты в блоки с перехватом ошибок — Supabase выполняет скрипт одной
--  транзакцией, и одна упавшая строка иначе откатывала бы всю установку.
--
--  В самом конце скрипт печатает отчёт: сколько функций создано и открыт ли
--  доступ. Если что-то пошло не так — смотрите NOTICE в выводе.
-- ============================================================================

-- ------------------------------------------------- расширение для паролей ---
-- В Supabase расширения ставятся в схему extensions, в «голом» PostgreSQL —
-- в public. Поддерживаем оба варианта.
create schema if not exists extensions;

do $$
begin
    if not exists (select 1 from pg_extension where extname = 'pgcrypto') then
        begin
            execute 'create extension pgcrypto with schema extensions';
        exception when others then
            execute 'create extension pgcrypto';
        end;
    end if;
end $$;

-- ---------------------------------------------------------------- профили ---
create table if not exists public.profiles (
    id            text primary key,
    nickname      text not null,
    name          text not null default '',
    avatar        text default '',
    password      text,             -- устаревшее поле (открытый пароль)
    password_hash text,             -- bcrypt-хеш, используется начиная с v49
    created_at    timestamptz not null default now()
);

alter table public.profiles add column if not exists name          text;
alter table public.profiles add column if not exists avatar        text;
alter table public.profiles add column if not exists password      text;
alter table public.profiles add column if not exists password_hash text;
alter table public.profiles add column if not exists created_at    timestamptz default now();

-- ключи сквозного шифрования: открытый ключ виден всем, закрытый хранится
-- только в зашифрованном виде и расшифровывается паролем на устройстве
alter table public.profiles add column if not exists public_key      text;
alter table public.profiles add column if not exists enc_private_key text;
alter table public.profiles add column if not exists key_salt        text;

update public.profiles set name = coalesce(nullif(name, ''), nickname) where name is null or name = '';
update public.profiles set avatar = coalesce(avatar, '') where avatar is null;
update public.profiles set created_at = now() where created_at is null;

-- Приводим ники к нижнему регистру и разводим совпадения: без этого шага
-- уникальный индекс ниже падает, а вместе с ним откатывается весь скрипт.
do $$
declare
    dup record;
    other text;
    n int;
begin
    update public.profiles
       set nickname = lower(trim(both ' ' from nickname))
     where nickname is distinct from lower(trim(both ' ' from nickname));

    for dup in
        select nickname, array_agg(id order by created_at nulls last, id) as ids
          from public.profiles
         group by nickname
        having count(*) > 1
    loop
        n := 1;
        -- первый владелец ника остаётся как есть, остальным добавляем номер
        foreach other in array dup.ids[2:array_length(dup.ids, 1)]
        loop
            n := n + 1;
            update public.profiles
               set nickname = dup.nickname || n::text
             where id = other;
            raise notice 'Ник «%» повторялся: профиль % переименован в «%»',
                dup.nickname, other, dup.nickname || n::text;
        end loop;
    end loop;
exception when others then
    raise notice 'Не удалось развести повторяющиеся ники: %', sqlerrm;
end $$;

do $$
begin
    create unique index if not exists profiles_nickname_key on public.profiles (nickname);
exception when others then
    raise notice 'Уникальный индекс по нику не создан: %', sqlerrm;
end $$;

-- ------------------------------------------------------- чаты и каналы ---
create table if not exists public.chats (
    room_id    text primary key,
    name       text not null default '',
    kind       text not null default 'dm',        -- 'dm' | 'group' | 'channel' | 'saved'
    members    text[] not null default '{}',
    created_at timestamptz not null default now()
);

-- публичные каналы: короткая ссылка, описание, владелец
alter table public.chats add column if not exists slug        text;
alter table public.chats add column if not exists about       text;
alter table public.chats add column if not exists owner_id    text;
alter table public.chats add column if not exists is_public   boolean default false;
alter table public.chats add column if not exists subscribers integer default 0;

update public.chats set is_public = false where is_public is null;
update public.chats set subscribers = coalesce(array_length(members, 1), 0) where subscribers is null;

do $$
begin
    create unique index if not exists chats_slug_key on public.chats (lower(slug)) where slug is not null;
exception when others then
    raise notice 'Уникальный индекс по ссылке канала не создан: %', sqlerrm;
end $$;

do $$
begin
    create index if not exists chats_public_idx on public.chats (is_public) where is_public;
exception when others then
    raise notice 'Индекс публичных каналов не создан: %', sqlerrm;
end $$;

do $$
begin
    create index if not exists chats_members_idx on public.chats using gin (members);
exception when others then
    raise notice 'Индекс по участникам чата не создан: %', sqlerrm;
end $$;

-- ------------------------------------------------------------- сообщения ---
create table if not exists public.messages (
    id         bigint generated by default as identity primary key,
    room_id    text not null,
    user_id    text,
    user_name  text,
    text       text,
    reactions  jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

alter table public.messages add column if not exists reactions  jsonb default '{}'::jsonb;
alter table public.messages add column if not exists created_at timestamptz default now();
alter table public.messages add column if not exists user_name  text;

-- ответы на сообщения: цитата хранится рядом, чтобы не делать лишних запросов
alter table public.messages add column if not exists reply_to      text;
alter table public.messages add column if not exists reply_name    text;
alter table public.messages add column if not exists reply_preview text;

-- короткая подпись для списка чатов: шифруется отдельно от самого сообщения,
-- иначе в списке пришлось бы расшифровывать целые фотографии
alter table public.messages add column if not exists preview text;

-- крошечное превью фотографии (несколько килобайт): приходит вместе со
-- списком сообщений и показывается мгновенно, пока грузится полный снимок
alter table public.messages add column if not exists thumb text;

update public.messages set reactions = '{}'::jsonb where reactions is null;

do $$
begin
    create index if not exists messages_room_time_idx on public.messages (room_id, created_at desc);
exception when others then
    raise notice 'Индекс по сообщениям не создан: %', sqlerrm;
end $$;

-- ----------------------------------------------------------- вложения ---
-- Полные изображения лежат отдельно от сообщений: список сообщений остаётся
-- лёгким и грузится мгновенно, а снимок подтягивается по мере показа.
create table if not exists public.attachments (
    id         bigint generated by default as identity primary key,
    room_id    text not null,
    user_id    text,
    data       text not null,        -- зашифровано ключом чата
    created_at timestamptz not null default now()
);

do $$
begin
    create index if not exists attachments_room_idx on public.attachments (room_id, created_at desc);
exception when others then
    raise notice 'Индекс вложений не создан: %', sqlerrm;
end $$;

-- ------------------------------------------------------------- звонки ---
--
-- Через эту таблицу два браузера договариваются о прямом соединении: сюда
-- кладутся предложение, ответ и сигнал завершения. Сам разговор идёт
-- напрямую между устройствами и здесь не хранится. Содержимое сигналов
-- шифруется ключом чата, поэтому серверу видны только отправитель,
-- получатель и время.

create table if not exists public.calls (
    id         bigint generated by default as identity primary key,
    room_id    text not null,
    from_id    text not null,
    to_id      text not null,
    kind       text not null default 'offer',      -- offer | answer | end
    payload    text,
    created_at timestamptz not null default now()
);

do $$
begin
    create index if not exists calls_to_idx on public.calls (to_id, id desc);
exception when others then
    raise notice 'Индекс звонков не создан: %', sqlerrm;
end $$;

-- ------------------------------------------------ подписки на уведомления ---
--
-- Адрес, по которому браузер получает уведомления при закрытом приложении.
-- Таблица закрыта полностью: и запись, и чтение идут только через функции
-- wm_push_save / wm_push_targets, поэтому чужие адреса нельзя ни прочитать,
-- ни подменить, имея публичный ключ приложения.

create table if not exists public.push_subscriptions (
    endpoint   text primary key,
    user_id    text not null,
    p256dh     text not null,
    auth       text not null,
    updated_at timestamptz not null default now()
);

do $$
begin
    create index if not exists push_subs_user_idx on public.push_subscriptions (user_id);
exception when others then
    raise notice 'Индекс подписок на уведомления не создан: %', sqlerrm;
end $$;

-- ------------------------------------------- ключи чатов (по участникам) ---
-- Для каждого участника лежит ключ комнаты, зашифрованный общим секретом ECDH.
-- Без закрытого ключа участника строка бесполезна.
create table if not exists public.room_keys (
    room_id     text not null,
    user_id     text not null,
    wrapped_key text not null,
    wrapped_by  text,
    created_at  timestamptz not null default now(),
    primary key (room_id, user_id)
);

-- --------------------------------------------------- отметки о прочтении ---
create table if not exists public.room_reads (
    room_id      text not null,
    user_id      text not null,
    last_read_at timestamptz not null default now(),
    primary key (room_id, user_id)
);

-- ------------------------------------- превью последнего сообщения чата ---
create or replace view public.chat_previews as
select distinct on (m.room_id)
    m.room_id,
    m.id,
    m.user_id,
    m.user_name,
    case
        when m.preview is not null then m.preview
        when m.text like 'data:image/%' then '📷 Фото'
        when m.text like 'wm1:%' then '🔒'
        else left(coalesce(m.text, ''), 120)
    end as preview,
    m.created_at
from public.messages m
order by m.room_id, m.created_at desc;

-- ============================================================================
--  Удаление прежних версий функций.
--
--  create or replace не заменяет функцию, у которой изменился набор
--  параметров, — рядом появляется вторая. Тогда PostgREST не может выбрать и
--  отвечает «не удалось выбрать лучшую функцию-кандидат». Поэтому перед
--  созданием сносим все прежние варианты по имени.
-- ============================================================================

do $$
declare
    r record;
begin
    for r in
        select p.oid::regprocedure as signature
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('wm_register', 'wm_login', 'wm_set_password', 'wm_set_keys',
                             'wm_create_channel', 'wm_join_chat', 'wm_leave_chat',
                             'wm_search', 'wm_public_user', 'wm_user_keys',
                             'wm_push_save', 'wm_push_drop', 'wm_push_targets',
                             'wm_guard_channel_post')
    loop
        execute 'drop function if exists ' || r.signature || ' cascade';
    end loop;
exception when others then
    raise notice 'Не удалось удалить прежние версии функций: %', sqlerrm;
end $$;

-- ============================================================================
--  Функции входа и регистрации.
--  Пароли хранятся только в виде bcrypt-хеша; клиент их не читает.
--  search_path включает extensions — там в Supabase живёт pgcrypto.
-- ============================================================================

/* Закрытые ключи отдаются только владельцу — через вход, не через таблицу. */
create or replace function public.wm_user_keys(p public.profiles)
returns json language sql immutable as $$
    select json_build_object('public_key', p.public_key,
                             'enc_private_key', p.enc_private_key,
                             'key_salt', p.key_salt);
$$;

create or replace function public.wm_public_user(p public.profiles)
returns json language sql immutable as $$
    select json_build_object('id', p.id, 'nickname', p.nickname,
                             'name', coalesce(nullif(p.name, ''), p.nickname),
                             'avatar', coalesce(p.avatar, ''));
$$;

create or replace function public.wm_register(
    p_nickname        text,
    p_password        text,
    p_name            text,
    p_public_key      text default null,
    p_enc_private_key text default null,
    p_key_salt        text default null)
returns json
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_nick text := lower(trim(both ' ' from coalesce(p_nickname, '')));
    v_row  public.profiles;
begin
    if v_nick !~ '^[a-z0-9_.]{3,32}$' then
        return json_build_object('ok', false, 'error', 'bad_nickname');
    end if;
    if coalesce(length(p_password), 0) < 4 then
        return json_build_object('ok', false, 'error', 'weak_password');
    end if;
    if exists (select 1 from public.profiles where nickname = v_nick) then
        return json_build_object('ok', false, 'error', 'nickname_taken');
    end if;

    insert into public.profiles (id, nickname, name, avatar, password_hash,
                                 public_key, enc_private_key, key_salt)
    values ('u' || floor(extract(epoch from now()) * 1000)::bigint || floor(random() * 1000)::int,
            v_nick,
            coalesce(nullif(trim(both ' ' from coalesce(p_name, '')), ''), v_nick),
            '',
            crypt(p_password, gen_salt('bf')),
            p_public_key, p_enc_private_key, p_key_salt)
    returning * into v_row;

    return json_build_object('ok', true, 'user', public.wm_public_user(v_row),
                             'keys', public.wm_user_keys(v_row));
end;
$$;

create or replace function public.wm_login(p_nickname text, p_password text)
returns json
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_row public.profiles;
begin
    select * into v_row from public.profiles
     where nickname = lower(trim(both ' ' from coalesce(p_nickname, '')))
     limit 1;

    if v_row.id is null then
        return json_build_object('ok', false, 'error', 'not_found');
    end if;

    if v_row.password_hash is not null then
        if v_row.password_hash = crypt(p_password, v_row.password_hash) then
            return json_build_object('ok', true, 'user', public.wm_public_user(v_row),
                                     'keys', public.wm_user_keys(v_row));
        end if;
        return json_build_object('ok', false, 'error', 'bad_password');
    end if;

    -- миграция со старой схемы: пароль лежал открытым текстом
    if v_row.password is not null and v_row.password = p_password then
        update public.profiles
           set password_hash = crypt(p_password, gen_salt('bf')), password = null
         where id = v_row.id;
        return json_build_object('ok', true, 'user', public.wm_public_user(v_row),
                                 'keys', public.wm_user_keys(v_row));
    end if;

    return json_build_object('ok', false, 'error', 'bad_password');
end;
$$;

create or replace function public.wm_set_password(
    p_nickname        text,
    p_old_password    text,
    p_new_password    text,
    p_enc_private_key text default null,
    p_key_salt        text default null)
returns json
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_check json;
    v_row   public.profiles;
begin
    if coalesce(length(p_new_password), 0) < 4 then
        return json_build_object('ok', false, 'error', 'weak_password');
    end if;

    v_check := public.wm_login(p_nickname, p_old_password);
    if (v_check ->> 'ok')::boolean is not true then
        return json_build_object('ok', false, 'error', 'bad_password');
    end if;

    update public.profiles
       set password_hash = crypt(p_new_password, gen_salt('bf')),
           password = null,
           enc_private_key = coalesce(p_enc_private_key, enc_private_key),
           key_salt = coalesce(p_key_salt, key_salt)
     where nickname = lower(trim(both ' ' from p_nickname))
    returning * into v_row;

    return json_build_object('ok', true, 'user', public.wm_public_user(v_row));
end;
$$;

/* Выдача ключей аккаунту, созданному до появления шифрования.
   Требует пароль — иначе чужие ключи подменить нельзя. */
create or replace function public.wm_set_keys(
    p_nickname        text,
    p_password        text,
    p_public_key      text,
    p_enc_private_key text,
    p_key_salt        text)
returns json
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_check json;
    v_row   public.profiles;
begin
    v_check := public.wm_login(p_nickname, p_password);
    if (v_check ->> 'ok')::boolean is not true then
        return json_build_object('ok', false, 'error', 'bad_password');
    end if;

    update public.profiles
       set public_key = p_public_key,
           enc_private_key = p_enc_private_key,
           key_salt = p_key_salt
     where nickname = lower(trim(both ' ' from p_nickname))
       and public_key is null            -- уже выданные ключи не перезаписываем
    returning * into v_row;

    if v_row.id is null then
        return json_build_object('ok', false, 'error', 'already_set');
    end if;
    return json_build_object('ok', true, 'user', public.wm_public_user(v_row));
end;
$$;

-- ============================================================================
--  Публичные каналы: создание, подписка, поиск.
--  Всё через функции — иначе одновременные подписки затирали бы друг друга
--  (массив участников читается и записывается целиком).
-- ============================================================================

create or replace function public.wm_create_channel(p_owner text, p_title text, p_slug text, p_about text)
returns json
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_slug text := lower(trim(both ' ' from coalesce(p_slug, '')));
    v_room text;
    v_row  public.chats;
begin
    if coalesce(length(trim(both ' ' from coalesce(p_title, ''))), 0) < 2 then
        return json_build_object('ok', false, 'error', 'bad_title');
    end if;
    if v_slug !~ '^[a-z0-9_]{4,32}$' then
        return json_build_object('ok', false, 'error', 'bad_slug');
    end if;
    if exists (select 1 from public.chats where lower(slug) = v_slug) then
        return json_build_object('ok', false, 'error', 'slug_taken');
    end if;

    v_room := 'channel_' || v_slug;

    insert into public.chats (room_id, name, kind, members, slug, about, owner_id, is_public, subscribers)
    values (v_room, trim(both ' ' from p_title), 'channel', array[p_owner], v_slug,
            nullif(trim(both ' ' from coalesce(p_about, '')), ''), p_owner, true, 1)
    returning * into v_row;

    return json_build_object('ok', true, 'chat', to_json(v_row));
end;
$$;

create or replace function public.wm_join_chat(p_room text, p_user text)
returns json
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_row public.chats;
begin
    update public.chats
       set members = case when p_user = any(members) then members else array_append(members, p_user) end
     where room_id = p_room
    returning * into v_row;

    if v_row.room_id is null then
        return json_build_object('ok', false, 'error', 'not_found');
    end if;

    update public.chats set subscribers = coalesce(array_length(members, 1), 0)
     where room_id = p_room returning * into v_row;

    return json_build_object('ok', true, 'chat', to_json(v_row));
end;
$$;

create or replace function public.wm_leave_chat(p_room text, p_user text)
returns json
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_row public.chats;
begin
    update public.chats
       set members = array_remove(members, p_user)
     where room_id = p_room
    returning * into v_row;

    if v_row.room_id is null then
        return json_build_object('ok', false, 'error', 'not_found');
    end if;

    update public.chats set subscribers = coalesce(array_length(members, 1), 0)
     where room_id = p_room returning * into v_row;

    return json_build_object('ok', true, 'chat', to_json(v_row));
end;
$$;

/* Единый поиск: публичные каналы и пользователи одним запросом. */
create or replace function public.wm_search(p_query text, p_me text)
returns json
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_q        text := lower(trim(both ' ' from coalesce(p_query, '')));
    v_channels json;
    v_users    json;
begin
    v_q := regexp_replace(v_q, '^@+', '');
    if length(v_q) < 1 then
        return json_build_object('channels', '[]'::json, 'users', '[]'::json);
    end if;

    select coalesce(json_agg(c), '[]'::json) into v_channels from (
        select room_id, name, slug, about, subscribers, owner_id,
               (p_me = any(members)) as joined
          from public.chats
         where is_public
           and (lower(name) like '%' || v_q || '%' or lower(coalesce(slug, '')) like '%' || v_q || '%')
         order by subscribers desc nulls last, name
         limit 20
    ) c;

    select coalesce(json_agg(u), '[]'::json) into v_users from (
        select id, nickname, name, avatar
          from public.profiles
         where id is distinct from p_me
           and (lower(nickname) like '%' || v_q || '%' or lower(name) like '%' || v_q || '%')
         order by nickname
         limit 20
    ) u;

    return json_build_object('channels', v_channels, 'users', v_users);
end;
$$;

-- ============================================================================
--  Уведомления при закрытом приложении
--
--  wm_push_save    — браузер сохраняет свой адрес доставки;
--  wm_push_drop    — адрес удаляется, когда браузер от него отказался;
--  wm_push_targets — по номеру сообщения возвращает адреса тех, кому его
--                    следует доставить. Функция сама проверяет, что сообщение
--                    действительно существует и только что написано, поэтому
--                    послать уведомление «просто так» через неё нельзя.
--
--  Текст сообщения наружу не отдаётся: он зашифрован, и в уведомлении
--  показывается только имя отправителя.
-- ============================================================================

create or replace function public.wm_push_save(
    p_user text, p_endpoint text, p_p256dh text, p_auth text
) returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
    if coalesce(p_user, '') = '' or coalesce(p_endpoint, '') = '' then
        return jsonb_build_object('ok', false, 'error', 'bad_request');
    end if;

    insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
         values (p_endpoint, p_user, coalesce(p_p256dh, ''), coalesce(p_auth, ''))
    on conflict (endpoint) do update
            set user_id    = excluded.user_id,
                p256dh     = excluded.p256dh,
                auth       = excluded.auth,
                updated_at = now();

    return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.wm_push_drop(p_endpoint text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
    delete from public.push_subscriptions where endpoint = p_endpoint;
    return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.wm_push_targets(p_msg bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_msg     record;
    v_chat    record;
    v_title   text;
    v_targets jsonb;
begin
    select id, room_id, user_id, user_name, created_at
      into v_msg
      from public.messages
     where id = p_msg;

    -- Нет такого сообщения или оно давно написано — рассылать нечего.
    if v_msg.id is null or v_msg.created_at < now() - interval '5 minutes' then
        return jsonb_build_object('ok', false, 'error', 'not_found', 'targets', '[]'::jsonb);
    end if;

    select room_id, name, kind, members, owner_id
      into v_chat
      from public.chats
     where room_id = v_msg.room_id;

    v_title := case
        when v_chat.kind in ('group', 'channel') and coalesce(v_chat.name, '') <> ''
            then v_chat.name
        else coalesce(v_msg.user_name, 'WolffMsg')
    end;

    select coalesce(jsonb_agg(jsonb_build_object(
               'endpoint', s.endpoint,
               'p256dh',   s.p256dh,
               'auth',     s.auth
           )), '[]'::jsonb)
      into v_targets
      from public.push_subscriptions s
     where s.user_id = any (coalesce(v_chat.members, '{}'))
       and s.user_id is distinct from v_msg.user_id;

    return jsonb_build_object(
        'ok', true,
        'room', v_msg.room_id,
        'msg', v_msg.id,
        'title', v_title,
        'targets', v_targets
    );
end;
$$;

/* В канале пишет только автор — проверка на стороне базы, а не только в UI. */
create or replace function public.wm_guard_channel_post()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
    v_owner text;
    v_kind  text;
begin
    select kind, owner_id into v_kind, v_owner from public.chats where room_id = new.room_id;
    if v_kind = 'channel' and v_owner is not null and new.user_id is distinct from v_owner then
        raise exception 'only the channel owner can post here' using errcode = '42501';
    end if;
    return new;
end;
$$;

do $$
begin
    drop trigger if exists wm_messages_channel_guard on public.messages;
    create trigger wm_messages_channel_guard
        before insert on public.messages
        for each row execute function public.wm_guard_channel_post();
exception when others then
    raise notice 'Защита канала от посторонних записей не установлена: %', sqlerrm;
end $$;

-- ============================================================================
--  Права доступа
--
--  ВАЖНО: приложение обращается к базе публичным ключом anon. Пароли закрыты
--  полностью (их проверяет только функция входа), остальные данные доступны
--  любому, у кого есть ключ. Для приватной переписки нужен переход на
--  Supabase Auth с политиками по auth.uid().
-- ============================================================================

alter table public.profiles   enable row level security;
alter table public.chats      enable row level security;
alter table public.messages   enable row level security;
alter table public.room_reads enable row level security;
alter table public.room_keys   enable row level security;
alter table public.attachments enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.calls        enable row level security;

drop policy if exists wm_profiles_read   on public.profiles;
drop policy if exists wm_profiles_write  on public.profiles;
drop policy if exists wm_chats_all       on public.chats;
drop policy if exists wm_messages_all    on public.messages;
drop policy if exists wm_reads_all       on public.room_reads;
drop policy if exists wm_keys_all        on public.room_keys;
drop policy if exists wm_files_all       on public.attachments;
drop policy if exists wm_calls_all       on public.calls;

create policy wm_profiles_read  on public.profiles   for select using (true);
create policy wm_profiles_write on public.profiles   for update using (true) with check (true);
create policy wm_chats_all      on public.chats      for all    using (true) with check (true);
create policy wm_messages_all   on public.messages   for all    using (true) with check (true);
create policy wm_reads_all      on public.room_reads for all    using (true) with check (true);
create policy wm_keys_all       on public.room_keys   for all   using (true) with check (true);
create policy wm_files_all      on public.attachments for all   using (true) with check (true);
create policy wm_calls_all      on public.calls       for all   using (true) with check (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.chats         to anon, authenticated;
grant select, insert, update, delete on public.messages      to anon, authenticated;
grant select, insert, update, delete on public.room_reads    to anon, authenticated;
grant select, insert, update, delete on public.room_keys     to anon, authenticated;
grant select, insert, update, delete on public.attachments   to anon, authenticated;
grant select, insert, delete         on public.calls         to anon, authenticated;
grant select                         on public.chat_previews to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;

grant execute on function public.wm_register(text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.wm_login(text, text)                       to anon, authenticated;
grant execute on function public.wm_set_password(text, text, text, text, text)  to anon, authenticated;
grant execute on function public.wm_set_keys(text, text, text, text, text)  to anon, authenticated;
grant execute on function public.wm_create_channel(text, text, text, text)  to anon, authenticated;
grant execute on function public.wm_join_chat(text, text)                   to anon, authenticated;
grant execute on function public.wm_leave_chat(text, text)                  to anon, authenticated;
grant execute on function public.wm_search(text, text)                      to anon, authenticated;
grant execute on function public.wm_push_save(text, text, text, text)      to anon, authenticated;
grant execute on function public.wm_push_drop(text)                        to anon, authenticated;
grant execute on function public.wm_push_targets(bigint)                   to anon, authenticated;

-- Сама таблица подписок недоступна: ни прочитать чужие адреса, ни записать
-- их напрямую нельзя — только через функции выше.
revoke all on public.push_subscriptions from anon, authenticated;

-- Доступ к profiles закрываем ТОЛЬКО если функции входа действительно созданы.
-- Иначе приложение осталось бы и без функций, и без прямой записи — именно так
-- выглядела ошибка «permission denied for table profiles».
do $$
declare
    v_funcs int;
begin
    select count(*) into v_funcs
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('wm_register', 'wm_login');

    if v_funcs >= 2 then
        execute 'revoke all on public.profiles from anon, authenticated';
        -- открытый ключ читают все, зашифрованный закрытый — никто:
        -- он выдаётся только функцией входа своему владельцу
        execute 'grant select (id, nickname, name, avatar, created_at, public_key) on public.profiles to anon, authenticated';
        execute 'grant update (name, avatar) on public.profiles to anon, authenticated';
        execute 'grant delete on public.profiles to anon, authenticated';
        raise notice 'Прямой доступ к паролям закрыт, вход работает через функции.';
    else
        execute 'grant select, insert, update, delete on public.profiles to anon, authenticated';
        raise notice 'ВНИМАНИЕ: функции входа не созданы, оставлен прямой доступ к profiles.';
    end if;
end $$;

-- ============================================================================
--  Обновление кеша REST API. PostgREST держит список таблиц и функций в
--  памяти; без этой команды новые функции какое-то время отдают 404, и
--  приложение сообщает «База ещё не готова принимать регистрацию».
-- ============================================================================

notify pgrst, 'reload schema';

-- ------------------------------------------------------------- отчёт ------
select
    (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in
            ('wm_register', 'wm_login', 'wm_set_password',
             'wm_create_channel', 'wm_join_chat', 'wm_leave_chat', 'wm_search',
             'wm_set_keys', 'wm_push_save', 'wm_push_drop', 'wm_push_targets'))
        as "функций создано (нужно 11)",
    (select count(*) from public.profiles)  as "профилей в базе",
    (select count(*) from public.messages)  as "сообщений в базе",
    (select count(*) from information_schema.role_table_grants
      where grantee = 'anon' and table_name = 'messages' and privilege_type = 'INSERT')
        as "anon может писать сообщения";
