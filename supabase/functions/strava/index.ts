// ERGlab ↔ Strava bridge (Supabase Edge Function, Deno).
// Holds the Strava Client Secret and every rider's Strava tokens server-side.
// The browser only ever sends its own Supabase session; it never sees a Strava token.
//
// Secrets (`supabase secrets set …`, never in Git):
//   STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET   your Strava API application
//   ALLOWED_ORIGINS                          exact origins, e.g. https://folfure.github.io
//
// Routes (signed-in, INVITED riders only):
//   GET  /strava/status          → { connected, athlete, client_id }
//   POST /strava/exchange        { code, scope } → { athlete }
//   POST /strava/upload          multipart (file, data_type, name, description, external_id, sport_type) → Strava upload JSON
//   GET  /strava/upload/:id      → Strava upload status JSON
//   POST /strava/disconnect      → { ok, revoked }

import { createClient, type SupabaseClient, type User } from 'jsr:@supabase/supabase-js@2.118.0';

const STRAVA = 'https://www.strava.com';
const env = (k: string) => Deno.env.get(k) ?? '';
const keyFrom = (jsonVar: string, legacyVar: string) => {
  try { const j = JSON.parse(env(jsonVar) || '{}'); if (j && typeof j.default === 'string') return j.default; } catch { /* fall back */ }
  return env(legacyVar);
};
const SB_URL = env('SUPABASE_URL');
const PUBLIC_KEY = keyFrom('SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_ANON_KEY');
const SECRET_KEY = keyFrom('SUPABASE_SECRET_KEYS', 'SUPABASE_SERVICE_ROLE_KEY');
const CLIENT_ID = env('STRAVA_CLIENT_ID');
const CLIENT_SECRET = env('STRAVA_CLIENT_SECRET');
const ALLOWED = env('ALLOWED_ORIGINS').split(',').map((s) => s.trim()).filter((s) => /^https?:\/\/[^/]+$/.test(s));
const SPORTS = new Set(['VirtualRide', 'Ride']);
const MAX_FILE = 10 * 1024 * 1024;

const admin: SupabaseClient = createClient(SB_URL, SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const base = { 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
  return ALLOWED.includes(origin) ? { ...base, 'Access-Control-Allow-Origin': origin } : base;
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsFor(req), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Caller must hold a valid session (checked by the Auth server) AND be an invited, non-banned rider.
function isRider(u: User) {
  const meta = (u.app_metadata ?? {}) as Record<string, unknown>;
  const banned = (u as unknown as { banned_until?: string }).banned_until;
  return !u.is_anonymous && (!!u.invited_at || meta.erglab_rider === true) && !(banned && Date.parse(banned) > Date.now());
}
async function requireRider(req: Request): Promise<string> {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt || jwt === PUBLIC_KEY) throw new HttpError(401, 'Sign in first');
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data?.user?.id) throw new HttpError(401, 'Session expired, sign in again');
  if (!isRider(data.user)) throw new HttpError(403, 'This account is not an invited ERGlab rider');
  return data.user.id;
}

type Tok = { user_id: string; access_token: string; refresh_token: string; expires_at: number; athlete: { id?: number } | null; refreshing_until: string | null };
async function getTok(uid: string): Promise<Tok | null> {
  const { data, error } = await admin.from('strava_tokens').select('user_id, access_token, refresh_token, expires_at, athlete, refreshing_until').eq('user_id', uid).maybeSingle();
  if (error) throw new HttpError(503, 'Token storage unavailable');
  return data as Tok | null;
}
async function tokenRequest(params: Record<string, string>) {
  const body = new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...params });
  const r = await fetch(`${STRAVA}/api/v3/oauth/token`, { method: 'POST', body });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}
async function deauthorize(accessToken: string) {
  try { const r = await fetch(`${STRAVA}/oauth/deauthorize`, { method: 'POST', body: new URLSearchParams({ access_token: accessToken }) }); return r.ok; }
  catch { return false; }
}
// Valid access token for this rider. Strava rotates refresh tokens, so only one request may refresh at a time:
// a short lease (refreshing_until) is taken with a compare-and-swap update before calling Strava.
async function accessToken(uid: string, force = false): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const t = await getTok(uid);
    if (!t) throw new HttpError(409, 'Strava is not connected');
    if (!force && t.expires_at * 1000 - Date.now() > 5 * 60_000) return t.access_token;
    const now = new Date().toISOString();
    const { data: lease, error: le } = await admin.from('strava_tokens')
      .update({ refreshing_until: new Date(Date.now() + 20_000).toISOString() })
      .eq('user_id', uid).eq('refresh_token', t.refresh_token)
      .or(`refreshing_until.is.null,refreshing_until.lt.${now}`).select('user_id');
    if (le) throw new HttpError(503, 'Token storage unavailable');
    if (!lease?.length) { await sleep(700); force = false; continue; } // someone else is refreshing: wait and re-read
    const { ok, status, j } = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh_token });
    if (ok && j.access_token) {
      const { error } = await admin.from('strava_tokens').update({
        access_token: j.access_token, refresh_token: j.refresh_token ?? t.refresh_token, expires_at: j.expires_at ?? t.expires_at,
        refreshing_until: null, updated_at: new Date().toISOString(),
      }).eq('user_id', uid).eq('refresh_token', t.refresh_token);
      if (error) console.error('strava token persist failed', error.code); // never fall through to delete
      return j.access_token;
    }
    await admin.from('strava_tokens').update({ refreshing_until: null }).eq('user_id', uid).eq('refresh_token', t.refresh_token);
    const appErr = Array.isArray(j?.errors) && j.errors.some((e: { resource?: string }) => /Application/i.test(e.resource ?? ''));
    if (appErr) throw new HttpError(502, 'Strava rejected the server\'s app credentials');
    if (status === 400 || status === 401) { // the grant itself is dead (revoked on Strava): forget it, still holding the lease
      await admin.from('strava_tokens').delete().eq('user_id', uid).eq('refresh_token', t.refresh_token);
      throw new HttpError(409, 'Strava access expired or was revoked. Connect Strava again.');
    }
    throw new HttpError(502, `Strava token error ${status}`);
  }
  throw new HttpError(503, 'Strava busy, try again');
}
async function stravaApi(uid: string, path: string, init: RequestInit = {}) {
  let tk = await accessToken(uid);
  let r = await fetch(`${STRAVA}/api/v3${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${tk}` } });
  if (r.status === 401) {
    tk = await accessToken(uid, true);
    r = await fetch(`${STRAVA}/api/v3${path}`, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${tk}` } });
  }
  const text = await r.text();
  let body: unknown; try { body = JSON.parse(text); } catch { body = { message: text.slice(0, 300) }; }
  return { status: r.status, body };
}
// read a multipart body with a hard size limit, even without (or with a false) Content-Length
async function limitedForm(req: Request): Promise<FormData> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_FILE) throw new HttpError(413, 'Ride file too large');
  if (!req.body) throw new HttpError(400, 'Missing ride file');
  let seen = 0;
  const limited = req.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) { seen += chunk.byteLength; if (seen > MAX_FILE + 65_536) ctl.error(new HttpError(413, 'Ride file too large')); else ctl.enqueue(chunk); },
  }));
  try { return await new Response(limited, { headers: { 'content-type': req.headers.get('content-type') ?? '' } }).formData(); }
  catch { throw seen > MAX_FILE ? new HttpError(413, 'Ride file too large') : new HttpError(400, 'Malformed upload'); }
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: origin && ALLOWED.includes(origin) ? 204 : 403, headers: corsFor(req) });
  try {
    if (origin && !ALLOWED.includes(origin)) throw new HttpError(403, 'Origin not allowed');
    if (!CLIENT_ID || !CLIENT_SECRET || !SECRET_KEY) throw new HttpError(500, 'Strava bridge is not configured');
    const path = new URL(req.url).pathname.replace(/^.*\/strava/, '') || '/';
    const uid = await requireRider(req);

    if (req.method === 'GET' && path === '/status') {
      const t = await getTok(uid);
      return json(req, { connected: !!t, athlete: t?.athlete ?? null, client_id: CLIENT_ID });
    }

    if (req.method === 'POST' && path === '/exchange') {
      const { code, scope } = await req.json().catch(() => ({}));
      if (typeof code !== 'string' || !/^[A-Za-z0-9]{10,100}$/.test(code)) throw new HttpError(400, 'Invalid authorization code');
      if (typeof scope !== 'string' || !/(^|[ ,])activity:write([ ,]|$)/.test(scope)) throw new HttpError(400, 'Allow "Upload your activities" on the Strava screen');
      const { ok, j } = await tokenRequest({ code, grant_type: 'authorization_code' });
      if (!ok || !j.access_token) throw new HttpError(502, 'Strava did not accept the authorization');
      const a = j.athlete ?? {};
      const athlete = { id: typeof a.id === 'number' ? a.id : null, firstname: String(a.firstname ?? '').slice(0, 80), lastname: String(a.lastname ?? '').slice(0, 80) };
      const prev = await getTok(uid);
      const { error } = await admin.from('strava_tokens').upsert({
        user_id: uid, athlete, access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at,
        scope: String(scope).slice(0, 200), refreshing_until: null, updated_at: new Date().toISOString(),
      });
      if (error?.code === '23505') { await deauthorize(j.access_token); throw new HttpError(409, 'This Strava account is already linked to another ERGlab rider'); }
      if (error) throw new HttpError(500, 'Could not store the Strava connection');
      // switched to a different Strava athlete: revoke the old grant so it doesn't linger
      if (prev && prev.athlete?.id && prev.athlete.id !== athlete.id) await deauthorize(prev.access_token);
      return json(req, { athlete });
    }

    if (req.method === 'POST' && path === '/upload') {
      const form = await limitedForm(req);
      const file = form.get('file');
      const dataType = String(form.get('data_type') ?? '');
      if (!(file instanceof File) || file.size === 0 || file.size > MAX_FILE) throw new HttpError(400, 'Missing ride file');
      if (!['tcx', 'tcx.gz'].includes(dataType)) throw new HttpError(400, 'Unsupported file type');
      const out = new FormData();
      out.append('file', file, (file.name || 'ride.tcx').replace(/[^\w.-]/g, '').slice(0, 100) || 'ride.tcx');
      out.append('data_type', dataType);
      out.append('trainer', '1');
      out.append('name', String(form.get('name') ?? 'Indoor ride').slice(0, 200));
      out.append('description', String(form.get('description') ?? '').slice(0, 2000));
      const ext = String(form.get('external_id') ?? '').replace(/[^\w.-]/g, '').slice(0, 100);
      if (ext) out.append('external_id', ext);
      const sport = String(form.get('sport_type') ?? 'VirtualRide');
      out.append('sport_type', SPORTS.has(sport) ? sport : 'VirtualRide');
      const r = await stravaApi(uid, '/uploads', { method: 'POST', body: out });
      return json(req, r.body, r.status);
    }

    const m = path.match(/^\/upload\/(\d{1,20})$/);
    if (req.method === 'GET' && m) {
      const r = await stravaApi(uid, `/uploads/${m[1]}`);
      return json(req, r.body, r.status);
    }

    if (req.method === 'POST' && path === '/disconnect') {
      let revoked = false;
      const t = await getTok(uid);
      if (t) {
        try { revoked = await deauthorize(await accessToken(uid)); } catch { /* still remove locally */ }
        const { error } = await admin.from('strava_tokens').delete().eq('user_id', uid);
        if (error) throw new HttpError(500, 'Could not remove the Strava connection, try again');
      }
      return json(req, { ok: true, revoked });
    }

    throw new HttpError(404, 'Not found');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (!(e instanceof HttpError)) console.error('strava fn error', e instanceof Error ? e.name : 'unknown');
    return json(req, { message: e instanceof HttpError ? e.message : 'Server error' }, status);
  }
});
