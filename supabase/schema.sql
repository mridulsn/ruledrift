-- Ruledrift - database schema.
-- Paste this whole file into the Supabase SQL editor and run it once.
--
-- One row per player, holding the same profile object the game already keeps in
-- localStorage. Storing it as a single JSONB blob is a deliberate choice: the
-- game is offline-first and merges client-side, so the server never needs to
-- reason about the shape. That also means adding a field to the profile later
-- requires no migration.

create table if not exists public.profiles (
  id          uuid        primary key references auth.users on delete cascade,
  data        jsonb       not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

-- Row Level Security is what makes the public anon key safe to ship in the
-- client. Without these policies, anyone holding that key could read every
-- player's data. With them, a request can only ever touch its own row.
alter table public.profiles enable row level security;

drop policy if exists "read own profile"   on public.profiles;
drop policy if exists "insert own profile" on public.profiles;
drop policy if exists "update own profile" on public.profiles;
drop policy if exists "delete own profile" on public.profiles;

create policy "read own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "insert own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "update own profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Players can delete their own data. Anything less is not a real delete button.
create policy "delete own profile"
  on public.profiles for delete
  using (auth.uid() = id);

create index if not exists profiles_updated_at_idx on public.profiles (updated_at desc);
