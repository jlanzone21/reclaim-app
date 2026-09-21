-- Reclaim initial schema. Run once in the Supabase SQL Editor (or `supabase db push`).

-- Resource library: anyone using the app can read it; only the dashboard or a service-role key can change it.
create table public.resources (
  id bigint generated always as identity primary key,
  type text not null check (type in (
    'scripture', 'sermon', 'article', 'devotional', 'bible_plan', 'coping_mechanism',
    'small_group', 'accountability_program', 'counseling_center'
  )),
  title text not null,
  subtitle text,
  body text,
  url text,
  contact text,
  area text,
  duration_min integer check (duration_min > 0),
  tags text[] not null default '{}',
  is_sample boolean not null default true,
  created_at timestamptz not null default now()
);
create index resources_type_idx on public.resources (type);

create table public.bible_plan_days (
  id bigint generated always as identity primary key,
  plan_id bigint not null references public.resources (id) on delete cascade,
  day_number integer not null check (day_number > 0),
  reference text not null,
  reflection text,
  unique (plan_id, day_number)
);

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

alter table public.resources enable row level security;
alter table public.bible_plan_days enable row level security;
alter table public.checkins enable row level security;

create policy "Anyone can read resources"
  on public.resources for select to anon, authenticated using (true);
create policy "Anyone can read bible plan days"
  on public.bible_plan_days for select to anon, authenticated using (true);

create policy "Users read their own check-ins"
  on public.checkins for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add their own check-ins"
  on public.checkins for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users edit their own check-ins"
  on public.checkins for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete their own check-ins"
  on public.checkins for delete to authenticated using ((select auth.uid()) = user_id);

grant select on public.resources, public.bible_plan_days to anon, authenticated;
grant select, insert, update, delete on public.checkins to authenticated;
revoke all on public.checkins from anon;
