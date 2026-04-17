// netlify/functions/gcal.js
// Mini-backend para integración Google Calendar + Google Drive
// Variables de entorno requeridas en Netlify:
//   GCAL_CLIENT_ID, GCAL_CLIENT_SECRET, GCAL_REDIRECT_URI, GCAL_APP_URL
//   NETLIFY_SITE_ID, NETLIFY_TOKEN  (para Netlify Blobs en sites sin CI/CD)

const { getStore } = require('@netlify/blobs');
const fs   = require('fs');
const path = require('path');

const CLIENT_ID     = process.env.GCAL_CLIENT_ID;
const CLIENT_SECRET = process.env.GCAL_CLIENT_SECRET;

// En producción (NETLIFY=true), si GCAL_APP_URL apunta a localhost
// la ignoramos y usamos la URL de producción. Esto evita que variables
// copiadas del .env local rompan el redirect del callback en Netlify.
const _IS_PRODUCTION = !!(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);
const _configuredURL  = process.env.GCAL_APP_URL;
const APP_URL = (_IS_PRODUCTION && _configuredURL?.includes('localhost'))
  ? 'https://kn-dental.netlify.app'
  : (_configuredURL || 'https://kn-dental.netlify.app');

// GCAL_REDIRECT_URI también se ignora en producción si apunta a localhost.
const _configuredRedirect = process.env.GCAL_REDIRECT_URI;
const REDIRECT_URI = (_IS_PRODUCTION && _configuredRedirect?.includes('localhost'))
  ? `${APP_URL}/.netlify/functions/gcal?action=callback`
  : (_configuredRedirect || `${APP_URL}/.netlify/functions/gcal?action=callback`);
const CALENDAR_ID   = 'primary';

const GOOGLE_TOKEN_URL    = 'https://oauth2.googleapis.com/token';
const GOOGLE_CALENDAR_URL = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_DRIVE_URL    = 'https://www.googleapis.com/drive/v3';

// Scopes: Calendar + Drive (drive.file = solo archivos creados por esta app)
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

// ── Token storage: archivo local en dev, Netlify Blobs en producción ───────
const IS_LOCAL    = !process.env.NETLIFY && !process.env.AWS_LAMBDA_FUNCTION_NAME;
const TOKENS_FILE = path.join(__dirname, '../../.gcal-tokens.json');

// Crea el store pasando siteID y token explícitamente cuando el contexto
// automático (NETLIFY_BLOBS_CONTEXT) no está disponible (ej. Netlify Drop).
// Variables requeridas en el dashboard: NETLIFY_SITE_ID, NETLIFY_TOKEN
function getBlobStore() {
  const opts = { name: 'gcal', consistency: 'strong' };
  if(process.env.NETLIFY_SITE_ID) opts.siteID = process.env.NETLIFY_SITE_ID;
  if(process.env.NETLIFY_TOKEN)   opts.token   = process.env.NETLIFY_TOKEN;
  return getStore(opts);
}

async function getTokens() {
  if(IS_LOCAL) {
    try { return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); }
    catch(e) { return null; }
  }
  try {
    const store = getBlobStore();
    return await store.get('tokens', { type: 'json' });
  } catch(e) { console.error('[gcal] getTokens error', e); return null; }
}

async function saveTokens(tokens) {
  if(IS_LOCAL) {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
    return;
  }
  const store = getBlobStore();
  await store.setJSON('tokens', tokens);
}

async function deleteTokens() {
  if(IS_LOCAL) {
    try { fs.unlinkSync(TOKENS_FILE); } catch(e) {}
    return;
  }
  const store = getBlobStore();
  await store.delete('tokens');
}

// ── OAuth helpers ──────────────────────────────────────────────────────────
async function refreshAccessToken(refreshToken) {
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
      refresh_token: refreshToken, grant_type: 'refresh_token'
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

// ── Calendar API helper ────────────────────────────────────────────────────
async function calFetch(urlPath, accessToken, options = {}) {
  const resp = await fetch(`${GOOGLE_CALENDAR_URL}${urlPath}`, {
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

// ── Drive API helpers ──────────────────────────────────────────────────────
async function driveFetch(urlPath, accessToken, options = {}) {
  const resp = await fetch(`${GOOGLE_DRIVE_URL}${urlPath}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {})
    }
  });
  if(resp.status === 204) return { ok: true };
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch(e) { data = { error: { message: text } }; }
  if(!resp.ok) throw new Error(data?.error?.message || text || 'Error Google Drive API');
  return data;
}

// Busca una carpeta por nombre (y padre opcional); la crea si no existe.
async function driveEnsureFolder(name, parentId, accessToken) {
  const escaped = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  let q = `name='${escaped}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if(parentId) q += ` and '${parentId}' in parents`;
  const list = await driveFetch(
    `/files?q=${encodeURIComponent(q)}&fields=files(id)&spaces=drive`,
    accessToken
  );
  if(list.files?.length) return list.files[0].id;

  const body = { name, mimeType: 'application/vnd.google-apps.folder' };
  if(parentId) body.parents = [parentId];
  const folder = await driveFetch('/files?fields=id', accessToken, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return folder.id;
}

// ── Main handler ───────────────────────────────────────────────────────────
exports.handler = async (event) => {
  if(event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const action = event.queryStringParameters?.action;
  const ok  = (body)          => ({ statusCode: 200, headers: CORS, body: JSON.stringify(body) });
  const err = (msg, code=500) => ({ statusCode: code, headers: CORS, body: JSON.stringify({ error: msg }) });

  try {
    // 1. Generar URL OAuth (Calendar + Drive)
    if(action === 'auth-url') {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('client_id',     CLIENT_ID);
      url.searchParams.set('redirect_uri',  REDIRECT_URI);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope',         OAUTH_SCOPES);
      url.searchParams.set('access_type',   'offline');
      url.searchParams.set('prompt',        'consent');
      return ok({ url: url.toString() });
    }

    // 2. Callback OAuth
    if(action === 'callback') {
      const callbackErr = event.queryStringParameters?.error;
      if(callbackErr) return {
        statusCode: 302,
        headers: { ...CORS, Location: `${APP_URL}/?gcal=error&msg=${encodeURIComponent(callbackErr)}` },
        body: ''
      };

      const code = event.queryStringParameters?.code;
      if(!code) return err('Código OAuth no recibido', 400);

      const resp = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
          redirect_uri: REDIRECT_URI, grant_type: 'authorization_code'
        })
      });
      const tokens = await resp.json();
      if(tokens.error) return err(tokens.error_description || tokens.error, 400);
      if(!tokens.refresh_token) return err(
        'Google no devolvió refresh_token. Revoca el acceso en myaccount.google.com/permissions y vuelve a conectar.', 400
      );

      await saveTokens({ refresh_token: tokens.refresh_token, connected_at: Date.now() });
      return { statusCode: 302, headers: { ...CORS, Location: `${APP_URL}/?gcal=connected` }, body: '' };
    }

    // 3. Estado de conexión
    if(action === 'status') {
      const tokens = await getTokens();
      return ok({ connected: !!tokens?.refresh_token, connected_at: tokens?.connected_at || null });
    }

    // 4. Desconectar
    if(action === 'disconnect' && event.httpMethod === 'POST') {
      await deleteTokens();
      return ok({ ok: true });
    }

    // — Requiere autenticación —
    const accessToken = await getValidAccessToken();
    if(!accessToken) return err('No conectado a Google.', 401);

    // 5. Listar eventos del día
    if(action === 'events' && event.httpMethod === 'GET') {
      const date = event.queryStringParameters?.date || new Date().toISOString().slice(0, 10);
      const [y, m, d] = date.split('-').map(Number);
      const qs = new URLSearchParams({
        timeMin: new Date(y, m-1, d, 0, 0, 0).toISOString(),
        timeMax: new Date(y, m-1, d, 23, 59, 59).toISOString(),
        singleEvents: 'true', orderBy: 'startTime', maxResults: '50'
      });
      const data = await calFetch(`/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${qs}`, accessToken);
      return ok(data);
    }

    // 6. Crear evento
    if(action === 'create' && event.httpMethod === 'POST') {
      const data = await calFetch(
        `/calendars/${encodeURIComponent(CALENDAR_ID)}/events`,
        accessToken, { method: 'POST', body: event.body }
      );
      return ok(data);
    }

    // 7. Actualizar evento
    if(action === 'update' && event.httpMethod === 'PATCH') {
      const eventId = event.queryStringParameters?.eventId;
      if(!eventId) return err('eventId requerido', 400);
      const data = await calFetch(
        `/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${eventId}`,
        accessToken, { method: 'PATCH', body: event.body }
      );
      return ok(data);
    }

    // 8. Eliminar evento
    if(action === 'delete' && event.httpMethod === 'DELETE') {
      const eventId = event.queryStringParameters?.eventId;
      if(!eventId) return err('eventId requerido', 400);
      await calFetch(
        `/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${eventId}`,
        accessToken, { method: 'DELETE' }
      );
      return ok({ ok: true });
    }

    // ── Drive / Calendar extra ─────────────────────────────────────────────

    // 9b. Eventos futuros (hasta 6 meses) — usado para detectar eliminaciones en GCal
    if(action === 'events-future' && event.httpMethod === 'GET') {
      const now    = new Date();
      const future = new Date(now.getTime() + 183 * 24 * 60 * 60 * 1000);
      const qs = new URLSearchParams({
        timeMin: now.toISOString(), timeMax: future.toISOString(),
        singleEvents: 'true', orderBy: 'startTime', maxResults: '500'
      });
      const data = await calFetch(`/calendars/${encodeURIComponent(CALENDAR_ID)}/events?${qs}`, accessToken);
      return ok(data);
    }

    // 9. Token para uploads cliente-a-Drive
    if(action === 'drive-token' && event.httpMethod === 'GET') {
      return ok({ accessToken });
    }

    // 10. Crear/obtener carpeta del paciente en Drive
    //     Estructura: "Pacientes" > "Nombre Paciente"  (sin subcarpetas)
    //     Body: { pacienteNombre: string }
    //     Retorna: { folderId }
    if(action === 'drive-ensure-folder' && event.httpMethod === 'POST') {
      const { pacienteNombre } = JSON.parse(event.body || '{}');
      if(!pacienteNombre) return err('pacienteNombre requerido', 400);
      const rootId       = await driveEnsureFolder('Pacientes', null, accessToken);
      const pacienteFolderId = await driveEnsureFolder(pacienteNombre, rootId, accessToken);
      return ok({ folderId: pacienteFolderId });
    }

    // 11b. Listar archivos en carpeta de Drive (sin crear)
    //     Query: action=drive-list-folder, pacienteNombre, carpeta (default "Pacientes")
    //     Retorna: { files: [{id, name, mimeType, thumbnailLink}] }
    if(action === 'drive-list-folder' && event.httpMethod === 'GET') {
      const { pacienteNombre, carpeta } = event.queryStringParameters || {};
      if(!pacienteNombre) return err('pacienteNombre requerido', 400);
      const rootName = carpeta || 'Pacientes';
      const escaped  = pacienteNombre.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const escapedRoot = rootName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      // Find root folder
      const rootList = await driveFetch(
        `/files?q=${encodeURIComponent(`name='${escapedRoot}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id)&spaces=drive`,
        accessToken
      );
      if(!rootList.files?.length) return ok({ files: [] });
      const rootId = rootList.files[0].id;
      // Find patient subfolder
      const subList = await driveFetch(
        `/files?q=${encodeURIComponent(`name='${escaped}' and mimeType='application/vnd.google-apps.folder' and '${rootId}' in parents and trashed=false`)}&fields=files(id)&spaces=drive`,
        accessToken
      );
      if(!subList.files?.length) return ok({ files: [] });
      const subId = subList.files[0].id;
      // List image files in patient subfolder
      const fileList = await driveFetch(
        `/files?q=${encodeURIComponent(`'${subId}' in parents and trashed=false`)}&fields=files(id,name,mimeType,thumbnailLink)&pageSize=100&spaces=drive`,
        accessToken
      );
      return ok({ files: fileList.files || [] });
    }

    // 11. Eliminar archivo de Drive
    if(action === 'drive-delete' && event.httpMethod === 'DELETE') {
      const fileId = event.queryStringParameters?.fileId;
      if(!fileId) return err('fileId requerido', 400);
      await driveFetch(`/files/${fileId}`, accessToken, { method: 'DELETE' });
      return ok({ ok: true });
    }

    // 12. Proxy de imagen Drive → base64 (para PDF export sin CORS)
    //     El thumbnail reduce el tamaño y es suficiente para impresión.
    if(action === 'drive-image' && event.httpMethod === 'GET') {
      const fileId = event.queryStringParameters?.fileId;
      if(!fileId) return err('fileId requerido', 400);

      // Obtener thumbnailLink (URL firmada, no requiere auth adicional)
      const meta = await driveFetch(
        `/files/${fileId}?fields=mimeType,thumbnailLink`,
        accessToken
      );

      let imgBuffer;
      if(meta.thumbnailLink) {
        // Aumentar resolución del thumbnail para mejor calidad en PDF
        const thumbUrl = meta.thumbnailLink.replace(/=s\d+$/, '=s800');
        const r = await fetch(thumbUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
        imgBuffer = await r.arrayBuffer();
      } else {
        // Fallback: descarga directa del archivo
        const r = await fetch(`${GOOGLE_DRIVE_URL}/files/${fileId}?alt=media`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        imgBuffer = await r.arrayBuffer();
      }

      const base64   = Buffer.from(imgBuffer).toString('base64');
      const mimeType = meta.mimeType || 'image/jpeg';
      return ok({ base64, mimeType });
    }

    return err('Acción no reconocida', 400);

  } catch(e) {
    console.error('[gcal function]', e.message);
    return err(e.message);
  }
};
