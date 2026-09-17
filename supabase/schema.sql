-- PDFreedy cloud backend schema — the "accuracy brain."
--
-- This backend does exactly one job: make OCR reads more accurate over
-- time, shared across everyone approved to use it. It does NOT store PDFs,
-- drawings, or anything else — there is deliberately no file storage here.
--
-- Run this once in the Supabase SQL Editor (Dashboard > SQL Editor > New
-- query > paste all of this > Run) on a fresh project. Safe to re-run: every
-- statement is guarded so a second run is a no-op rather than an error.

-- =======================================================================
-- profiles — one row per signed-up account, auto-created on signup.
-- New accounts start 'pending': nothing else in this schema is usable until
-- an admin flips them to 'active' (see the bootstrap step at the bottom).
-- =======================================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  status text not null default 'pending' check (status in ('pending','active','revoked')),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.is_active()
returns boolean as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and status = 'active'
  );
$$ language sql security definer stable set search_path = public;

create or replace function public.is_admin()
returns boolean as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and is_admin
  );
$$ language sql security definer stable set search_path = public;

drop policy if exists "select own profile" on public.profiles;
create policy "select own profile" on public.profiles
  for select using (auth.uid() = id or public.is_admin());

drop policy if exists "admins update profiles" on public.profiles;
create policy "admins update profiles" on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

-- =======================================================================
-- corrections — the brain itself. A shared dictionary of "this garbled OCR
-- read actually says X", confirmed by "Fix text" in the app or accepted
-- from an AI-assist judgement. Every active user reads the whole table and
-- can contribute; it's communal, not per-user data.
--
-- confirm_count tracks how many times a given (raw_key -> corrected) pair
-- has been independently confirmed — via confirm_correction() below, which
-- increments it instead of just overwriting, so a correction seen and
-- agreed on repeatedly carries more weight than one seen once.
-- =======================================================================
create table if not exists public.corrections (
  id uuid primary key default gen_random_uuid(),
  raw_key text not null unique,
  corrected text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Added after the table already existed on some deployments — "create table
-- if not exists" above won't add a column to a table that's already there.
alter table public.corrections add column if not exists confirm_count integer not null default 1;

alter table public.corrections enable row level security;

drop policy if exists "active users read corrections" on public.corrections;
create policy "active users read corrections" on public.corrections
  for select using (public.is_active());

drop policy if exists "active users write corrections" on public.corrections;
create policy "active users write corrections" on public.corrections
  for insert with check (public.is_active());

drop policy if exists "active users update corrections" on public.corrections;
create policy "active users update corrections" on public.corrections
  for update using (public.is_active()) with check (public.is_active());

drop policy if exists "active users delete corrections" on public.corrections;
create policy "active users delete corrections" on public.corrections
  for delete using (public.is_active());

-- Runs as the calling user (RLS still applies via the policies above) — not
-- security definer, so it can't be used to write as someone unapproved.
create or replace function public.confirm_correction(p_raw_key text, p_corrected text)
returns public.corrections as $$
  insert into public.corrections (raw_key, corrected, created_by)
  values (p_raw_key, p_corrected, auth.uid())
  on conflict (raw_key) do update
    set corrected = excluded.corrected,
        confirm_count = public.corrections.confirm_count + 1,
        updated_at = now()
  returning *;
$$ language sql set search_path = public;

-- =======================================================================
-- usage_events — lightweight usage/licensing log (session starts, AI-assist
-- calls). Users can only insert their own events; only admins can read them
-- back. Nothing PDF- or drawing-related is ever logged here.
-- =======================================================================
create table if not exists public.usage_events (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id) on delete set null,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.usage_events enable row level security;

drop policy if exists "insert own usage events" on public.usage_events;
create policy "insert own usage events" on public.usage_events
  for insert with check (auth.uid() = user_id and public.is_active());

drop policy if exists "admins read usage events" on public.usage_events;
create policy "admins read usage events" on public.usage_events
  for select using (public.is_admin());

-- =======================================================================
-- Cleanup: drops the old projects/PDF-storage feature and its data, if this
-- is a re-run against a project that had it. No-ops on a fresh project.
--
-- The "pdfs" storage bucket itself is NOT dropped here — Postgres refuses
-- direct DELETEs against storage.objects/storage.buckets ("Use the Storage
-- API instead"). Delete it once, by hand, in the dashboard: Storage > pdfs >
-- the "..." menu > Delete bucket. These policies are harmless left behind
-- (they only apply to a bucket named "pdfs", which won't exist once you've
-- deleted it), but dropping them now costs nothing either.
-- =======================================================================
drop table if exists public.project_files;
drop table if exists public.projects;
drop policy if exists "own pdf read" on storage.objects;
drop policy if exists "own pdf write" on storage.objects;
drop policy if exists "own pdf update" on storage.objects;
drop policy if exists "own pdf delete" on storage.objects;

-- =======================================================================
-- Bootstrap: after you sign up once through the running app (so a profiles
-- row exists for your account), run this to make yourself an active admin.
-- Everyone else stays 'pending' until you promote them the same way.
-- =======================================================================
-- update public.profiles set status = 'active', is_admin = true
--   where email = 'your-email@example.com';
