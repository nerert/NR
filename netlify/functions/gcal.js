// netlify/functions/gcal.js
// Mini-backend para integración Google Calendar
// Variables de entorno requeridas en Netlify:
//   GCAL_CLIENT_ID, GCAL_CLIENT_SECRET, GCAL_REDIRECT_URI

const { getStore } = require('@netlify/blobs');

const CLIENT_ID     = process.env.GCAL_CLIENT_ID;
const CLIENT_SECRET = process.env.GCAL_CLIENT_SECRET;
const REDIRECT_URI  = process.env.GCAL_REDIRECT_URI;
const CALENDAR_ID   = 'primary';

const GOOGLE_TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_URL = 'https://www.googleapis.com/calendar/v3';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

// ── Token storage via Netlify Blobs ────────────────────────────────────────
async function getTokens() {
  try {
    const store = getStore({ name: 'gcal', consistency: 'strong' });
    return await store.get('tokens', { type: 'json' });
  } catch(e) {
    console.error('[gcal] getTokens error', e);
    return null;
  }
}

async function saveTokens(tokens) {
  const store = getStore({ name: 'gcal', consistency: 'strong' });
  await store.setJSON('tokens', tokens);
}

async function deleteTokens() {
  const store = getStore({ name: 'gcal', consistency: 'strong' });
  await store.delete('tokens');
}

// ── OAuth helpers ──────────────────────────────────────────────────────────
async function refreshAccessToken(refreshToken) {
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token'
    })
  });
  const data = await resp.json();
  if(data.error) throw new Error(data.error_description || data.error);
  return data.access_token;
}

async function getValidAccessToken() {
  const tokens = await getTokens();
  if(!tokens?.refresh_token) return null;
  return await refreshAccessToken(tokens.refresh_token);
}

// ── Calendar API helpers ───────────────────────────────────────────────────
async function calFetch(path, accessToken, options = {}) {
  const url = `${GOOGLE_CALENDAR_URL}${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if(resp.status === 204) return { ok: true };
  const data = await resp.json();
  if(!resp.ok) throw new Error(data.error?.message || JSON.stringify(data.error) || 'Error Google API');
  return data;
}

// ── Main handler ───────────────────────────────────────────────────────────
exports.handler = async (event) => {
  // OPTIONS preflight
  if(event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  const action = event.queryStringParameters?.action;
  const ok  = (body)  => ({ statusCode: 200, headers: CORS, body: JSON.stringify(body) });
  const err = (msg, code = 500) => ({ statusCode: code, headers: CORS, body: JSON.stringify({ error: msg }) });

  try {
    // ── 1. Generar URL de autorización OAuth ───────────────────────────────
    if(action === 'auth-url') {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('client_id',     CLIENT_ID);
      url.searchParams.set('redirect_uri',  REDIRECT_URI);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope',         'https://www.googleapis.com/auth/calendar.events');
      url.searchParams.set('access_type',   'offline');
      url.searchParams.set('prompt',        'consent'); // siempre pide refresh_token
      return ok({ url: url.toString() });
    }

    // ── 2. Callback OAuth: intercambiar código por tokens ──────────────────
    if(action === 'callback') {
      const code = event.queryStringParameters?.code;
      const callbackErr = event.queryStringParameters?.error;
      if(callbackErr) {
        return {
          statusCode: 302,
          headers: { ...CORS, Location: '/?gcal=error&msg=' + encodeURIComponent(callbackErr) },
          body: ''
        };
      }
      if(!code) return err('Código OAuth no recibido', 400);

      const resp = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id:     CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri:  REDIRECT_URI,
          grant_type:    'authorization_code'
        })
      });
      const tokens = await resp.json();
      if(tokens.error) return err(tokens.error_description || tokens.error, 400);
      if(!tokens.refresh_token) return err('Google no devolvió refresh_token. Revoca el acceso en myaccount.google.com/permissions y vuelve a conectar.', 400);

      await saveTokens({ refresh_token: tokens.refresh_token, connected_at: Date.now() });

      return {
        statusCode: 302,
        headers: { ...CORS, Location: '/?gcal=connected' },
        body: ''
      };
    }

    // ── 3. Estado de conexión ──────────────────────────────────────────────
    if(action === 'status') {
      const tokens = await getTokens();
      return ok({ connected: !!tokens?.refresh_token, connected_at: tokens?.connected_at || null });
    }

    // ── 4. Desconectar ─────────────────────────────────────────────────────
    if(action === 'disconnect' && event.httpMethod === 'POST') {
      await deleteTokens();
      return ok({ ok: true });
    }

    // ── Desde aquí requiere autenticación ──────────────────────────────────
    const accessToken = await getValidAccessToken();
    if(!accessToken) return err('No conectado a Google Calendar. Conecta primero.', 401);

    // ── 5. Listar eventos del día ──────────────────────────────────────────
    if(action === 'events' && event.httpMethod === 'GET') {
      const date = event.queryStringParameters?.date || new Date().toISOString().slice(0, 10);
      const [y, m, d] = date.split('-').map(Number);
      const timeMin = new Date(y, m - 1, d, 0, 0, 0).toISOString();
      const timeMax = new Date(y, m - 1, d, 23, 59, 59).toISOString();
      const qs = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '50' });
      const data = await calFetch(`/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${qs}`, accessToken);
      return ok(data);
    }

    // ── 6. Crear evento ────────────────────────────────────────────────────
    if(action === 'create' && event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const data = await calFetch(
        `/calendars/${encodeURIComponent(CALENDAR_ID)}/events`,
        accessToken,
        { method: 'POST', body: JSON.stringify(body) }
      );
      return ok(data);
    }

    // ── 7. Actualizar evento ───────────────────────────────────────────────
    if(action === 'update' && event.httpMethod === 'PATCH') {
      const eventId = event.queryStringParameters?.eventId;
      if(!eventId) return err('eventId requerido', 400);
      const body = JSON.parse(event.body || '{}');
      const data = await calFetch(
        `/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${eventId}`,
        accessToken,
        { method: 'PATCH', body: JSON.stringify(body) }
      );
      return ok(data);
    }

    // ── 8. Eliminar evento ─────────────────────────────────────────────────
    if(action === 'delete' && event.httpMethod === 'DELETE') {
      const eventId = event.queryStringParameters?.eventId;
      if(!eventId) return err('eventId requerido', 400);
      await calFetch(
        `/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${eventId}`,
        accessToken,
        { method: 'DELETE' }
      );
      return ok({ ok: true });
    }

    return err('Acción no reconocida', 400);

  } catch(e) {
    console.error('[gcal function]', e.message);
    return err(e.message);
  }
};
