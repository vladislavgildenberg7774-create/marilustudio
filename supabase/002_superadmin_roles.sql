-- MariluStudio: суперадмин сам задаёт лимит сотрудников (до 30) и раздаёт любые роли
-- Выполнить один раз в Supabase → SQL Editor (после schema.sql)

-- лимит сотрудников в студии: от 1 до 30
alter table public.studios drop constraint if exists studios_max_members_check;
alter table public.studios add constraint studios_max_members_check check (max_members between 1 and 30);

-- проверки сотрудников: для суперадмина ограничений по ролям нет
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
    raise exception 'Достигнут лимит сотрудников: %. Увеличить его может администратор MariluStudio', mx;
  end if;

  if public.is_super() then
    return new; -- суперадмин раздаёт любые роли без ограничений
  end if;

  if new.role = 'owner' and (tg_op = 'INSERT' or old.role <> 'owner') then
    raise exception 'Главного в студии назначает только администратор MariluStudio';
  end if;
  if tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner' then
    raise exception 'Роль главного меняет только администратор MariluStudio';
  end if;
  if new.role = 'smm' and (select count(*) from public.members
        where studio_id = new.studio_id and role = 'smm' and id <> new.id) >= 2 then
    raise exception 'В студии может быть не больше 2 СММ-менеджеров. Больше может назначить администратор MariluStudio';
  end if;
  return new;
end $$;

-- создание студии с лимитом сотрудников
drop function if exists public.admin_create_studio(text, text, text, int);
create or replace function public.admin_create_studio(p_name text, p_owner_name text, p_owner_email text, p_months int default 1, p_max int default 6)
returns uuid language plpgsql security definer set search_path = public as $$
declare sid uuid;
begin
  if not public.is_super() then raise exception 'Нет доступа'; end if;
  insert into public.studios (name, sub_until, max_members)
  values (p_name, (current_date + make_interval(months => greatest(p_months, 0)))::date, least(greatest(coalesce(p_max, 6), 1), 30))
  returning id into sid;
  insert into public.members (studio_id, email, name, role, in_journal, position)
  values (sid, p_owner_email, p_owner_name, 'owner', false, 'Руководитель');
  return sid;
end $$;
grant execute on function public.admin_create_studio(text, text, text, int, int) to authenticated;
