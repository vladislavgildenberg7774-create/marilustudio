-- MariluStudio: график работы сотрудников (смены по дням)
-- Выполнить один раз в Supabase → SQL Editor (после 004_moderation.sql)

create table if not exists public.shifts (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios on delete cascade,
  member_id uuid not null references public.members on delete cascade,
  day date not null,
  start_min int not null check (start_min between 0 and 1439),
  end_min int not null check (end_min between 1 and 1440),
  check (end_min > start_min),
  unique (member_id, day)
);
create index if not exists shifts_studio_day_idx on public.shifts(studio_id, day);

alter table public.shifts enable row level security;
revoke all on public.shifts from anon;
grant select, insert, update, delete on public.shifts to authenticated;

-- видят все сотрудники студии, меняет только главный (и суперадмин)
drop policy if exists sh_sel on public.shifts;
create policy sh_sel on public.shifts for select to authenticated using (public.is_super() or public.my_role(studio_id) is not null);
drop policy if exists sh_ins on public.shifts;
create policy sh_ins on public.shifts for insert to authenticated with check (public.can_manage(studio_id));
drop policy if exists sh_upd on public.shifts;
create policy sh_upd on public.shifts for update to authenticated using (public.can_manage(studio_id)) with check (public.can_manage(studio_id));
drop policy if exists sh_del on public.shifts;
create policy sh_del on public.shifts for delete to authenticated using (public.can_manage(studio_id));

do $$ begin
  begin alter publication supabase_realtime add table public.shifts; exception when others then null; end;
end $$;
