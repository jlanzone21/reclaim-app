-- Reclaim initial schema: the resource library. Applied to the live project
-- (hdymcreqtwcwgwftglox) on 2026-09-23, after dropping stray empty tables left over from earlier,
-- unrelated work (resources/bible_plan_days/checkins/users/chat_messages/device_usage — all 0 rows,
-- RLS-enabled with zero policies, so already unreachable).
--
-- checkins (accounts/auth) is a separate, still-not-started migration -- see supabase/checkins_design.sql.

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
  -- Directory-style fields (small groups, counseling centers, accountability programs). Nullable and
  -- unused by the other resource types.
  city text,
  state text,
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  -- Everything else from a richer source (e.g. the recovery-groups CSV) that doesn't need its own
  -- column: contact_name/role/email/phone, curriculum, eligibility, meeting_schedule,
  -- availability_note, verification_status, accepting_new_members, source_url. Keeps this shared
  -- table from sprawling a dozen narrow columns that only apply to a few resource types.
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index resources_type_idx on public.resources (type);
create index resources_state_idx on public.resources (state);

create table public.bible_plan_days (
  id bigint generated always as identity primary key,
  plan_id bigint not null references public.resources (id) on delete cascade,
  day_number integer not null check (day_number > 0),
  reference text not null,
  reflection text,
  unique (plan_id, day_number)
);

alter table public.resources enable row level security;
alter table public.bible_plan_days enable row level security;

create policy "Anyone can read resources"
  on public.resources for select to anon, authenticated using (true);
create policy "Anyone can read bible plan days"
  on public.bible_plan_days for select to anon, authenticated using (true);

grant select on public.resources, public.bible_plan_days to anon, authenticated;
