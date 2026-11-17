-- MariluStudio: точечные пуш-уведомления
-- Мастер получает пуши только о своих записях. Главный и СММ — обо всех, если сами включили.
-- Выполнить один раз в Supabase → SQL Editor (после push.sql)

-- переключатель «получать уведомления обо всех записях студии» (для главного и СММ)
alter table public.members add column if not exists notify_all boolean not null default true;

create or replace function public.set_notify_all(p_studio uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.members set notify_all = p_on
   where studio_id = p_studio and user_id = auth.uid() and role in ('owner', 'smm');
  if not found then raise exception 'Уведомления обо всех записях доступны только главному и СММ'; end if;
end $$;
grant execute on function public.set_notify_all(uuid, boolean) to authenticated;

-- журнал событий для пушей: функция отправки читает событие отсюда (подделать снаружи нельзя)
create table if not exists public.push_events (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null,
  kind text not null,
  appt jsonb not null,
  old_member_id uuid,
  new_member_id uuid,
  actor uuid,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.push_events enable row level security;
revoke all on public.push_events from anon, authenticated;

-- что произошло с записью → событие → вызов функции send-push
create or replace function public.notify_appt() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare kind text; ev uuid; rec jsonb; om uuid; nm uuid; sid uuid;
begin
  if tg_op = 'INSERT' then
    kind := 'new'; rec := to_jsonb(new); nm := new.member_id; sid := new.studio_id;
  elsif tg_op = 'DELETE' then
    if old.status = 'cancelled' then return old; end if;
    kind := 'deleted'; rec := to_jsonb(old); om := old.member_id; sid := old.studio_id;
  else
    rec := to_jsonb(new); sid := new.studio_id; nm := new.member_id; om := old.member_id;
    if new.status = 'cancelled' and old.status <> 'cancelled' then kind := 'cancelled';
    elsif new.member_id is distinct from old.member_id then kind := 'reassigned';
    elsif new.day <> old.day or new.start_min <> old.start_min or new.duration <> old.duration
       or new.service_ids <> old.service_ids or (old.status = 'cancelled' and new.status <> 'cancelled') then kind := 'changed';
    else return new; -- статус «пришёл», комментарий и т.п. — без пуша
    end if;
  end if;
  insert into public.push_events (studio_id, kind, appt, old_member_id, new_member_id, actor)
  values (sid, kind, rec, om, nm, auth.uid()) returning id into ev;
  perform net.http_post(
    url := 'https://jnmhjrpdjzswcgguxyst.supabase.co/functions/v1/send-push',
    body := jsonb_build_object('event_id', ev),
    headers := '{"Content-Type":"application/json"}'::jsonb
  );
  if tg_op = 'DELETE' then return old; end if;
  return new;
exception when others then
  if tg_op = 'DELETE' then return old; end if;
  return new; -- уведомление никогда не мешает сохранить запись
end $$;

drop trigger if exists appts_notify on public.appointments;
create trigger appts_notify after insert or update or delete on public.appointments
  for each row execute function public.notify_appt();
