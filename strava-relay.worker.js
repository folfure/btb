// BTB Strava token relay: a Cloudflare Worker (free tier is plenty).
//
// Why: Strava has no PKCE, so exchanging the login code for tokens (and refreshing them)
// needs your Strava API app's Client Secret. This relay holds the secret server-side,
// so you can share BTB with friends without publishing it. Uploads still go
// straight from the browser to Strava; the relay only ever sees OAuth token calls.
//
// Setup:
//   1. dash.cloudflare.com → Workers & Pages → Create → Worker → paste this file → Deploy
//   2. Worker → Settings → Variables and Secrets:
//        STRAVA_CLIENT_ID      = your Strava app's Client ID
//        STRAVA_CLIENT_SECRET  = your Strava app's Client Secret   (type: Secret)
//        ALLOWED_ORIGINS       = https://you.github.io            (comma-separated origins of your BTB page)
//   3. In BTB: Settings → Strava → enter the Client ID, open "Use a token relay" and paste
//      the worker URL (e.g. https://btb-strava.you.workers.dev). Leave the secret empty.
//   4. On strava.com/settings/api raise "athlete capacity" (1 by default, 10 without review).

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const originOk = allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': originOk ? origin : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: originOk ? 204 : 403, headers: cors });
    if (url.pathname !== '/token' || req.method !== 'POST') return new Response('Not found', { status: 404, headers: cors });
    if (!originOk) return new Response('Origin not allowed', { status: 403, headers: cors });

    const input = new URLSearchParams(await req.text());
    const grant = input.get('grant_type');
    const json = (o, status) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    if (input.get('client_id') && input.get('client_id') !== String(env.STRAVA_CLIENT_ID))
      return json({ message: `This relay serves Strava app ${env.STRAVA_CLIENT_ID}. Enter that Client ID in BTB Settings.` }, 409);
    const out = new URLSearchParams({ client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET, grant_type: grant || '' });
    if (grant === 'authorization_code' && input.get('code')) out.set('code', input.get('code'));
    else if (grant === 'refresh_token' && input.get('refresh_token')) out.set('refresh_token', input.get('refresh_token'));
    else return new Response(JSON.stringify({ message: 'Bad request' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });

    const r = await fetch('https://www.strava.com/api/v3/oauth/token', { method: 'POST', body: out });
    return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  },
};
