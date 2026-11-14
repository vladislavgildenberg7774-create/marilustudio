-- MariluStudio: пуш-уведомления о записях
-- Выполнить один раз в Supabase → SQL Editor (после schema.sql)

create extension if not exists pg_net with schema extensions;

-- подписки устройств на пуши
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index if not exists push_user_idx on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon;
grant select, delete on public.push_subscriptions to authenticated;
drop policy if exists ps_sel on public.push_subscriptions;
create policy ps_sel on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
drop policy if exists ps_del on public.push_subscriptions;
create policy ps_del on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());

-- сохранить подписку этого устройства за текущим пользователем
create or replace function public.save_push_sub(p_endpoint text, p_p256dh text, p_auth text, p_ua text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Нужно войти'; end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, p_ua)
  on conflict (endpoint) do update set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent;
end $$;
grant execute on function public.save_push_sub(text, text, text, text) to authenticated;

-- при новой / перенесённой / отменённой записи — вызвать функцию отправки пушей
create or replace function public.notify_appt() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare kind text;
begin
  if tg_op = 'INSERT' then kind := 'new';
  elsif new.status = 'cancelled' and old.status <> 'cancelled' then kind := 'cancelled';
  elsif new.day <> old.day or new.start_min <> old.start_min or new.member_id is distinct from old.member_id then kind := 'moved';
  else return new;
  end if;
  perform net.http_post(
    url := 'https://jnmhjrpdjzswcgguxyst.supabase.co/functions/v1/send-push',
    body := jsonb_build_object('appointment_id', new.id, 'kind', kind, 'actor', auth.uid(),
                               'old_member_id', case when tg_op = 'UPDATE' then old.member_id end),
    headers := '{"Content-Type":"application/json"}'::jsonb
  );
  return new;
exception when others then
  return new; -- уведомление никогда не мешает сохранить запись
end $$;

drop trigger if exists appts_notify on public.appointments;
create trigger appts_notify after insert or update on public.appointments
  for each row execute function public.notify_appt();
