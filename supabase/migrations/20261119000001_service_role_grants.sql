-- Newer Supabase projects don't auto-grant table privileges to service_role.
-- The `strava` Edge Function (service role) must read/write the Strava token table;
-- browsers (anon/authenticated) still have no access to it.
grant select, insert, update, delete on public.strava_tokens to service_role;
grant select, insert, update, delete on public.profiles, public.rides to service_role;
