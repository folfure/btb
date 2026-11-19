-- ERGlab cloud storage.
--  * Only INVITED riders can use the database: a restrictive policy checks auth.users on every query
--    (invited_at set, or app_metadata.erglab_rider = true; not anonymous, not banned, not deleted).
--    So even if "Allow new users to sign up" were switched on by mistake, strangers get nothing.
--  * Every rider can only see and change their own rows (Row Level Security).
--  * Strava tokens are reachable only by the `strava` Edge Function (service role): no grant, no policy.

-- ---------------------------------------------------------------------------
-- Rider allow-list check
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.is_rider() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
    where u.id = (select auth.uid())
      and (u.invited_at is not null or coalesce((u.raw_app_meta_data ->> 'erglab_rider')::boolean, false))
      and coalesce(u.is_anonymous, false) = false
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until < now())
  );
$$;
revoke all on function private.is_rider() from public, anon;
grant execute on function private.is_rider() to authenticated;

-- ---------------------------------------------------------------------------
-- Profile: settings, custom workouts and training-plan progress (one row per rider)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id         uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  settings        jsonb not null default '{}'::jsonb,
  custom_workouts jsonb not null default '[]'::jsonb,
  plan_progress   jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now(),
  constraint profiles_settings_obj check (jsonb_typeof(settings) = 'object'),
  constraint profiles_custom_arr  check (jsonb_typeof(custom_workouts) = 'array'),
  constraint profiles_plans_obj   check (jsonb_typeof(plan_progress) = 'object'),
  constraint profiles_size        check (pg_column_size(settings) + pg_column_size(custom_workouts) + pg_column_size(plan_progress) < 1000000)
);

-- ---------------------------------------------------------------------------
-- Rides: summary for the history list + per-second streams (power, HR, cadence, distance)
-- ---------------------------------------------------------------------------
create table if not exists public.rides (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id         text not null,
  started_at timestamptz not null,
  name       text not null,
  summary    jsonb not null default '{}'::jsonb,
  streams    jsonb,
  strava     jsonb,
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  constraint rides_id_format   check (id ~ '^[A-Za-z0-9_-]{1,64}$'),
  constraint rides_name_len    check (char_length(name) between 1 and 200),
  constraint rides_summary_obj check (jsonb_typeof(summary) = 'object' and pg_column_size(summary) < 50000),
  constraint rides_streams_obj check (streams is null or (jsonb_typeof(streams) = 'object' and pg_column_size(streams) < 1500000)),
  constraint rides_strava_obj  check (strava is null or (jsonb_typeof(strava) = 'object' and pg_column_size(strava) < 2000))
);
create index if not exists rides_user_started_idx on public.rides (user_id, started_at desc);

-- per-rider quota so one account can't fill the database (which would make it read-only for everyone)
create or replace function public.rides_quota() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text, 0));
  if exists (select 1 from public.rides where user_id = new.user_id and id = new.id) then return new; end if; -- upsert of an existing ride
  if (select count(*) from public.rides where user_id = new.user_id and created_at > now() - interval '1 day') >= 40
     or (select count(*) from public.rides where user_id = new.user_id) >= 5000 then
    raise exception 'ride quota reached' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.rides_quota() from public, anon, authenticated;
drop trigger if exists rides_quota on public.rides;
create trigger rides_quota before insert on public.rides for each row execute function public.rides_quota();

-- ---------------------------------------------------------------------------
-- Strava tokens: only the `strava` Edge Function (service role) reads/writes this table
-- ---------------------------------------------------------------------------
create table if not exists public.strava_tokens (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  athlete          jsonb,
  access_token     text not null,
  refresh_token    text not null,
  expires_at       bigint not null,
  scope            text,
  refreshing_until timestamptz,
  updated_at       timestamptz not null default now()
);
-- one Strava athlete ↔ one ERGlab rider (Strava keeps a single grant per athlete and app)
create unique index if not exists strava_tokens_athlete_uniq on public.strava_tokens ((athlete ->> 'id')) where athlete ->> 'id' is not null;

-- ---------------------------------------------------------------------------
-- Row Level Security + grants
-- ---------------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.rides         enable row level security;
alter table public.strava_tokens enable row level security;

revoke all on public.profiles, public.rides, public.strava_tokens from anon;
revoke all on public.strava_tokens from authenticated;                -- the browser gets no access at all
grant select, insert, update, delete on public.profiles, public.rides to authenticated;

drop policy if exists "own profile" on public.profiles;
create policy "own profile" on public.profiles
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "own rides" on public.rides;
create policy "own rides" on public.rides
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- restrictive = AND-ed with the policies above: non-invited, banned or anonymous users see and write nothing
drop policy if exists "riders only" on public.profiles;
create policy "riders only" on public.profiles as restrictive
  for all to authenticated
  using ((select private.is_rider())) with check ((select private.is_rider()));

drop policy if exists "riders only" on public.rides;
create policy "riders only" on public.rides as restrictive
  for all to authenticated
  using ((select private.is_rider())) with check ((select private.is_rider()));

-- (intentionally no policy on strava_tokens: with RLS on and no policy, only the service role can use it)

-- keep updated_at fresh
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
revoke all on function public.touch_updated_at() from public, anon, authenticated;

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
