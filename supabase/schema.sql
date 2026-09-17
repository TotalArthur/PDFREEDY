-- PDFreedy cloud backend schema.
--
-- Run this once in the Supabase SQL Editor (Dashboard > SQL Editor > New
-- query > paste all of this > Run) on a fresh project. Safe to re-run: every
-- statement is guarded so a second run is a no-op rather than an error.
--
-- After running this, create the "pdfs" storage bucket (Storage > New
-- bucket, name it exactly "pdfs", leave it Private) before pasting the
-- storage policies at the bottom of this file — they reference that bucket.

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
-- corrections — shared OCR-correction library. Any active user can read and
-- contribute; it's a communal dictionary of "this garbled OCR read actually
-- says X", not per-user data.
-- =======================================================================
create table if not exists public.corrections (
  id uuid primary key default gen_random_uuid(),
  raw_key text not null unique,
  corrected text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

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

-- =======================================================================
-- projects / project_files — a user's saved PDFs. Owner-only.
-- =======================================================================
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

alter table public.projects enable row level security;

drop policy if exists "own projects" on public.projects;
create policy "own projects" on public.projects
  for all using (auth.uid() = user_id and public.is_active())
  with check (auth.uid() = user_id and public.is_active());

create table if not exists public.project_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  storage_path text not null,
  filename text not null,
  uploaded_at timestamptz not null default now()
);

alter table public.project_files enable row level security;

drop policy if exists "own project files" on public.project_files;
create policy "own project files" on public.project_files
  for all using (
    exists (select 1 from public.projects pr where pr.id = project_id and pr.user_id = auth.uid())
  )
  with check (
    exists (select 1 from public.projects pr where pr.id = project_id and pr.user_id = auth.uid())
  );

-- =======================================================================
-- usage_events — lightweight usage/licensing log (search runs, AI-assist
-- calls, saved projects, session starts). Users can only insert their own
-- events; only admins can read them back.
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
-- Storage policies for the "pdfs" bucket.
-- Create the bucket first (Storage > New bucket > name "pdfs" > Private)
-- then run this section. Files are stored at "<user_id>/<project_id>/<name>"
-- so a path-prefix check is enough to keep everyone to their own files.
-- =======================================================================
drop policy if exists "own pdf read" on storage.objects;
create policy "own pdf read" on storage.objects
  for select using (bucket_id = 'pdfs' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "own pdf write" on storage.objects;
create policy "own pdf write" on storage.objects
  for insert with check (bucket_id = 'pdfs' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "own pdf update" on storage.objects;
create policy "own pdf update" on storage.objects
  for update using (bucket_id = 'pdfs' and auth.uid()::text = (storage.foldername(name))[1]);

drop policy if exists "own pdf delete" on storage.objects;
create policy "own pdf delete" on storage.objects
  for delete using (bucket_id = 'pdfs' and auth.uid()::text = (storage.foldername(name))[1]);

-- =======================================================================
-- Bootstrap: after you sign up once through the running app (so a profiles
-- row exists for your account), run this to make yourself an active admin.
-- Everyone else stays 'pending' until you promote them the same way.
-- =======================================================================
-- update public.profiles set status = 'active', is_admin = true
--   where email = 'artwdickson@gmail.com';
