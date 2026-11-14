-- MariluStudio: схема базы данных и права доступа
-- Выполнить один раз в Supabase → SQL Editor → New query → Run

create extension if not exists pgcrypto;

-- ============ ТАБЛИЦЫ ============
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  email text,
  full_name text,
  is_superadmin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.studios (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  address text,
  work_start int not null default 8 check (work_start between 0 and 23),
  work_end int not null default 21 check (work_end between 1 and 24),
  sub_until date,
  blocked boolean not null default false,
  max_members int not null default 6,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios on delete cascade,
  user_id uuid references auth.users on delete set null,
  email text not null,
  name text not null,
  position text,
  role text not null check (role in ('owner','smm','master')),
  in_journal boolean not null default true,
  color text default '#7c6cf2',
  photo text,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  unique (studio_id, email)
);
create index if not exists members_user_idx on public.members(user_id);

create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios on delete cascade,
  name text not null,
  category text,
  duration int not null default 60,
  price numeric not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists services_studio_idx on public.services(studio_id);

create table if not exists public.clients (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios on delete cascade,
  name text not null,
  phone text,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists clients_studio_idx on public.clients(studio_id);

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios on delete cascade,
  member_id uuid references public.members on delete set null,
  client_id uuid references public.clients on delete set null,
  day date not null,
  start_min int not null check (start_min between 0 and 1439),
  duration int not null default 60 check (duration between 5 and 1440),
  price numeric not null default 0,
  service_ids uuid[] not null default '{}',
  status text not null default 'booked' check (status in ('booked','confirmed','done','noshow','cancelled')),
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists appts_studio_day_idx on public.appointments(studio_id, day);
create index if not exists appts_client_idx on public.appointments(client_id);

-- ============ ФУНКЦИИ ПРОВЕРКИ ПРАВ ============
create or replace function public.is_super() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_superadmin from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.my_role(s uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from public.members where studio_id = s and user_id = auth.uid() limit 1
$$;

create or replace function public.my_member(s uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.members where studio_id = s and user_id = auth.uid() limit 1
$$;

-- подписка активна и студия не заблокирована
create or replace function public.studio_ok(s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select not blocked and (sub_until is null or sub_until >= current_date)
                   from public.studios where id = s), false)
$$;

create or replace function public.can_manage(s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_super() or (public.my_role(s) = 'owner' and public.studio_ok(s))
$$;

create or replace function public.can_book(s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_super() or (public.my_role(s) in ('owner','smm') and public.studio_ok(s))
$$;

-- ============ ТРИГГЕРЫ ============
-- новый пользователь: профиль + привязка к приглашению. Первый зарегистрированный становится суперадмином.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, is_superadmin)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data->>'full_name', ''),
          not exists (select 1 from public.profiles where is_superadmin));
  update public.members set user_id = new.id
   where lower(email) = lower(new.email) and user_id is null;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- профиль: нельзя самому сделать себя суперадмином
create or replace function public.profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super() then
    new.is_superadmin := old.is_superadmin;
    new.email := old.email;
  end if;
  return new;
end $$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.profiles_guard();

-- студия: подписку, блокировку и лимит меняет только суперадмин
create or replace function public.studios_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super() then
    new.sub_until := old.sub_until;
    new.blocked := old.blocked;
    new.max_members := old.max_members;
  end if;
  if new.work_end <= new.work_start then
    raise exception 'Конец рабочего дня должен быть позже начала';
  end if;
  return new;
end $$;
drop trigger if exists studios_guard on public.studios;
create trigger studios_guard before update on public.studios
  for each row execute function public.studios_guard();

-- сотрудники: лимиты и привязка аккаунта
create or replace function public.members_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare mx int;
begin
  new.email := lower(trim(new.email));
  if tg_op = 'INSERT' or new.email is distinct from old.email then
    select id into new.user_id from auth.users where lower(email) = new.email limit 1;
  else
    new.user_id := old.user_id;
  end if;

  select max_members into mx from public.studios where id = new.studio_id;
  if tg_op = 'INSERT' and (select count(*) from public.members where studio_id = new.studio_id) >= mx then
    raise exception 'Достигнут лимит сотрудников: %', mx;
  end if;

  if new.role = 'owner' then
    if not public.is_super() and (tg_op = 'INSERT' or old.role <> 'owner') then
      raise exception 'Главного в студии назначает только администратор MariluStudio';
    end if;
    if exists (select 1 from public.members where studio_id = new.studio_id and role = 'owner' and id <> new.id) then
      raise exception 'В студии может быть только один главный';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner' and not public.is_super() then
    raise exception 'Роль главного меняет только администратор MariluStudio';
  end if;
  if new.role = 'smm' and (select count(*) from public.members
        where studio_id = new.studio_id and role = 'smm' and id <> new.id) >= 2 then
    raise exception 'В студии может быть не больше 2 СММ-менеджеров';
  end if;
  return new;
end $$;
drop trigger if exists members_check on public.members;
create trigger members_check before insert or update on public.members
  for each row execute function public.members_check();

create or replace function public.members_delete_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.role = 'owner' and not public.is_super() then
    raise exception 'Главного удаляет только администратор MariluStudio';
  end if;
  return old;
end $$;
drop trigger if exists members_delete_guard on public.members;
create trigger members_delete_guard before delete on public.members
  for each row execute function public.members_delete_guard();

-- записи: мастер может менять у своих записей только статус и комментарий
create or replace function public.appts_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.can_book(new.studio_id) then
    new.studio_id := old.studio_id; new.member_id := old.member_id; new.client_id := old.client_id;
    new.day := old.day; new.start_min := old.start_min; new.duration := old.duration;
    new.price := old.price; new.service_ids := old.service_ids;
  end if;
  new.created_by := old.created_by; new.created_at := old.created_at;
  return new;
end $$;
drop trigger if exists appts_guard on public.appointments;
create trigger appts_guard before update on public.appointments
  for each row execute function public.appts_guard();

-- ============ RPC ДЛЯ СУПЕРАДМИНА ============
create or replace function public.admin_create_studio(p_name text, p_owner_name text, p_owner_email text, p_months int default 1)
returns uuid language plpgsql security definer set search_path = public as $$
declare sid uuid;
begin
  if not public.is_super() then raise exception 'Нет доступа'; end if;
  insert into public.studios (name, sub_until)
  values (p_name, (current_date + make_interval(months => greatest(p_months, 0)))::date)
  returning id into sid;
  insert into public.members (studio_id, email, name, role, in_journal, position)
  values (sid, p_owner_email, p_owner_name, 'owner', false, 'Руководитель');
  return sid;
end $$;

create or replace function public.admin_studio_list()
returns table (id uuid, name text, sub_until date, blocked boolean, max_members int, created_at timestamptz,
               members_count bigint, owner_name text, owner_email text, owner_joined boolean, appts_30d bigint)
language sql stable security definer set search_path = public as $$
  select s.id, s.name, s.sub_until, s.blocked, s.max_members, s.created_at,
         (select count(*) from public.members m where m.studio_id = s.id),
         o.name, o.email, o.user_id is not null,
         (select count(*) from public.appointments a where a.studio_id = s.id and a.created_at > now() - interval '30 days')
  from public.studios s
  left join public.members o on o.studio_id = s.id and o.role = 'owner'
  where public.is_super()
  order by s.created_at desc
$$;

-- ============ RLS ============
alter table public.profiles enable row level security;
alter table public.studios enable row level security;
alter table public.members enable row level security;
alter table public.services enable row level security;
alter table public.clients enable row level security;
alter table public.appointments enable row level security;

revoke all on public.profiles, public.studios, public.members, public.services, public.clients, public.appointments from anon;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.studios, public.members, public.services, public.clients, public.appointments to authenticated;
grant execute on function public.is_super(), public.my_role(uuid), public.my_member(uuid), public.studio_ok(uuid),
  public.can_manage(uuid), public.can_book(uuid), public.admin_create_studio(text,text,text,int), public.admin_studio_list() to authenticated;

drop policy if exists p_sel on public.profiles;
create policy p_sel on public.profiles for select to authenticated using (id = auth.uid() or public.is_super());
drop policy if exists p_upd on public.profiles;
create policy p_upd on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists s_sel on public.studios;
create policy s_sel on public.studios for select to authenticated using (public.is_super() or public.my_role(id) is not null);
drop policy if exists s_ins on public.studios;
create policy s_ins on public.studios for insert to authenticated with check (public.is_super());
drop policy if exists s_upd on public.studios;
create policy s_upd on public.studios for update to authenticated
  using (public.is_super() or public.my_role(id) = 'owner') with check (public.is_super() or public.my_role(id) = 'owner');
drop policy if exists s_del on public.studios;
create policy s_del on public.studios for delete to authenticated using (public.is_super());

drop policy if exists m_sel on public.members;
create policy m_sel on public.members for select to authenticated using (public.is_super() or public.my_role(studio_id) is not null);
drop policy if exists m_ins on public.members;
create policy m_ins on public.members for insert to authenticated with check (public.can_manage(studio_id));
drop policy if exists m_upd on public.members;
create policy m_upd on public.members for update to authenticated using (public.can_manage(studio_id)) with check (public.can_manage(studio_id));
drop policy if exists m_del on public.members;
create policy m_del on public.members for delete to authenticated using (public.can_manage(studio_id));

drop policy if exists sv_sel on public.services;
create policy sv_sel on public.services for select to authenticated using (public.is_super() or public.my_role(studio_id) is not null);
drop policy if exists sv_ins on public.services;
create policy sv_ins on public.services for insert to authenticated with check (public.can_manage(studio_id));
drop policy if exists sv_upd on public.services;
create policy sv_upd on public.services for update to authenticated using (public.can_manage(studio_id)) with check (public.can_manage(studio_id));
drop policy if exists sv_del on public.services;
create policy sv_del on public.services for delete to authenticated using (public.can_manage(studio_id));

drop policy if exists c_sel on public.clients;
create policy c_sel on public.clients for select to authenticated using (
  public.is_super() or public.my_role(studio_id) in ('owner','smm')
  or exists (select 1 from public.appointments a where a.client_id = clients.id and a.member_id = public.my_member(clients.studio_id)));
drop policy if exists c_ins on public.clients;
create policy c_ins on public.clients for insert to authenticated with check (public.can_book(studio_id));
drop policy if exists c_upd on public.clients;
create policy c_upd on public.clients for update to authenticated using (public.can_book(studio_id)) with check (public.can_book(studio_id));
drop policy if exists c_del on public.clients;
create policy c_del on public.clients for delete to authenticated using (public.can_manage(studio_id));

drop policy if exists a_sel on public.appointments;
create policy a_sel on public.appointments for select to authenticated using (
  public.is_super() or public.my_role(studio_id) in ('owner','smm') or member_id = public.my_member(studio_id));
drop policy if exists a_ins on public.appointments;
create policy a_ins on public.appointments for insert to authenticated with check (public.can_book(studio_id));
drop policy if exists a_upd on public.appointments;
create policy a_upd on public.appointments for update to authenticated
  using (public.can_book(studio_id) or (member_id = public.my_member(studio_id) and public.studio_ok(studio_id)))
  with check (public.can_book(studio_id) or (member_id = public.my_member(studio_id) and public.studio_ok(studio_id)));
drop policy if exists a_del on public.appointments;
create policy a_del on public.appointments for delete to authenticated using (public.can_book(studio_id));

-- ============ REALTIME (живое обновление журнала) ============
do $$ begin
  begin alter publication supabase_realtime add table public.appointments; exception when others then null; end;
  begin alter publication supabase_realtime add table public.clients; exception when others then null; end;
  begin alter publication supabase_realtime add table public.members; exception when others then null; end;
  begin alter publication supabase_realtime add table public.services; exception when others then null; end;
end $$;
