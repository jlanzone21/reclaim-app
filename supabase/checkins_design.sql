-- Design for the accounts/check-ins half of the Supabase migration -- NOT applied, NOT in
-- supabase/migrations/ (that folder mirrors real applied history; this doesn't belong there yet).
-- See README.md's "Planned: cloud data (Supabase)" for context. Moved out of
-- 20260921000000_initial_schema.sql when the resource-library half (that file's actual content
-- now) landed for real without this.
--
-- Requires Supabase Anonymous Auth enabled first (Authentication -> Sign In / Providers).

-- Check-ins: each row belongs to one user (anonymous or signed in) and only they can see or change it.
create table public.checkins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  client_id text not null check (char_length(client_id) between 1 and 100),
  occurred_at timestamptz not null,
  type text not null check (type in ('resisted', 'slipped')),
  tags text[] not null default '{}' check (cardinality(tags) <= 20),
  notes text not null default '' check (char_length(notes) <= 5000),
  mood_rating smallint check (mood_rating between 1 and 5),
  urge_intensity smallint check (urge_intensity between 1 and 5),
  sleep_hours numeric(4, 1) check (sleep_hours between 0 and 24),
  created_at timestamptz not null default now(),
  -- client_id is the id the device generated, so re-sending the same check-in can't create a duplicate.
  unique (user_id, client_id)
);
create index checkins_user_time_idx on public.checkins (user_id, occurred_at desc);

alter table public.checkins enable row level security;

create policy "Users read their own check-ins"
  on public.checkins for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add their own check-ins"
  on public.checkins for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users edit their own check-ins"
  on public.checkins for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete their own check-ins"
  on public.checkins for delete to authenticated using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.checkins to authenticated;
revoke all on public.checkins from anon;
