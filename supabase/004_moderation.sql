-- MariluStudio: регистрация с модерацией + СММ «только чтение»
-- Выполнить один раз в Supabase → SQL Editor (после 003_targeted_push.sql)

-- статус аккаунта: pending (ждёт одобрения) / active / rejected
alter table public.profiles add column if not exists status text not null default 'pending'
  check (status in ('pending', 'active', 'rejected'));
alter table public.profiles add column if not exists note text;
alter table public.profiles add column if not exists phone text;

-- уже существующие аккаунты, у которых есть студия, и суперадмин — активны
update public.profiles p set status = 'active'
 where p.is_superadmin or exists (select 1 from public.members m where m.user_id = p.id);

-- новый пользователь: если руководитель уже добавил его email в студию — сразу активен, иначе заявка
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare first_user boolean; invited boolean;
begin
  first_user := not exists (select 1 from public.profiles where is_superadmin);
  invited := exists (select 1 from public.members where lower(email) = lower(new.email));
  insert into public.profiles (id, email, full_name, phone, note, is_superadmin, status)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data->>'full_name', ''),
          nullif(new.raw_user_meta_data->>'phone', ''), nullif(new.raw_user_meta_data->>'note', ''),
          first_user, case when first_user or invited then 'active' else 'pending' end);
  update public.members set user_id = new.id where lower(email) = lower(new.email) and user_id is null;
  return new;
end $$;

-- статус меняет только суперадмин (и добавление в студию — см. триггер ниже)
create or replace function public.profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super() and current_setting('marilu.sys', true) is distinct from '1' then
    new.is_superadmin := old.is_superadmin;
    new.email := old.email;
    new.status := old.status;
  end if;
  return new;
end $$;

-- если сотрудника добавили в студию по email — его аккаунт становится активным
create or replace function public.members_activate() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is not null then
    perform set_config('marilu.sys', '1', true);
    update public.profiles set status = 'active' where id = new.user_id and status <> 'active';
    perform set_config('marilu.sys', '', true);
  end if;
  return new;
end $$;
drop trigger if exists members_activate on public.members;
create trigger members_activate after insert or update of user_id on public.members
  for each row execute function public.members_activate();

-- активен ли текущий пользователь
create or replace function public.is_active() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select status = 'active' from public.profiles where id = auth.uid()), false)
$$;

-- роль в студии — только для активного аккаунта (заявки и отклонённые не видят ничего)
create or replace function public.my_role(s uuid) returns text
language sql stable security definer set search_path = public as $$
  select m.role from public.members m
   where m.studio_id = s and m.user_id = auth.uid() and public.is_active() limit 1
$$;

-- записывать и менять клиентов теперь может только главный. СММ — только чтение.
create or replace function public.can_book(s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_super() or (public.my_role(s) = 'owner' and public.studio_ok(s))
$$;

-- ===== заявки для суперадмина =====
create or replace function public.admin_requests(p_status text default 'pending')
returns table (id uuid, email text, full_name text, phone text, note text, status text, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select p.id, p.email, p.full_name, p.phone, p.note, p.status, p.created_at
    from public.profiles p
   where public.is_super() and p.status = p_status and not p.is_superadmin
   order by p.created_at desc
$$;

create or replace function public.admin_approve(p_user uuid, p_studio uuid, p_role text, p_name text default null, p_position text default null)
returns void language plpgsql security definer set search_path = public as $$
declare pr public.profiles;
begin
  if not public.is_super() then raise exception 'Нет доступа'; end if;
  if p_role not in ('owner', 'smm', 'master') then raise exception 'Неизвестная роль'; end if;
  select * into pr from public.profiles where id = p_user;
  if pr.id is null then raise exception 'Заявка не найдена'; end if;
  insert into public.members (studio_id, email, name, role, position, in_journal)
  values (p_studio, pr.email, coalesce(nullif(trim(p_name), ''), nullif(pr.full_name, ''), pr.email), p_role,
          nullif(trim(p_position), ''), p_role = 'master')
  on conflict (studio_id, email) do update set role = excluded.role;
  update public.profiles set status = 'active' where id = p_user;
end $$;

create or replace function public.admin_reject(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_super() then raise exception 'Нет доступа'; end if;
  update public.profiles set status = 'rejected' where id = p_user and not is_superadmin;
end $$;

grant execute on function public.is_active(), public.admin_requests(text),
  public.admin_approve(uuid, uuid, text, text, text), public.admin_reject(uuid) to authenticated;

-- в списке студий админ-панели — число заявок не нужно, но список студий для выбора уже есть (admin_studio_list)
