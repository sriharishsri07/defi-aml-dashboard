// Digital Assets demo dashboard - tiny local server (no dependencies, Node 18+).
// Serves index.html and exposes GET /api/data, which runs the Dashboard_Data_WF
// workflow on the platform (sync) and returns its payload. The API key stays on the
// server and is never sent to the browser.

const http = require('http');
const fs = require('fs');
const path = require('path');

// ---- config (.env file next to this script, or real environment variables) ----
function loadEnv() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 3100);
const BASE_URL = (process.env.ABL_BASE_URL || 'https://agents.kore.ai').replace(/\/+$/, '');
const PROJECT_SLUG = process.env.ABL_PROJECT_SLUG || 'defi-aml';
const ENV_NAME = process.env.ABL_ENV || 'dev';
const WORKFLOW_SLUG = process.env.ABL_WORKFLOW_SLUG || 'dashboard-data-wf';
const API_KEY = process.env.ABL_API_KEY || '';

let inflight = null; // collapse concurrent refreshes into one platform call

function parseMaybe(x) {
  if (typeof x === 'string') {
    try { return JSON.parse(x); } catch (e) { return x; }
  }
  return x;
}

async function fetchPayload() {
  if (!API_KEY) {
    const err = new Error('ABL_API_KEY is not set. Copy .env.example to .env and add your platform API key.');
    err.status = 500;
    throw err;
  }
  const url = `${BASE_URL}/api/v1/project/${PROJECT_SLUG}/${ENV_NAME}/workflow/${WORKFLOW_SLUG}/invoke`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify({ input: {} }),
    signal: AbortSignal.timeout(90000),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
  if (!res.ok || body.success === false) {
    const msg = (body.error && (body.error.message || body.error.code)) || `Platform returned HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status === 401 || res.status === 403 ? 401 : 502;
    throw err;
  }
  const data = body.data || {};
  if (data.status && data.status !== 'completed') {
    const err = new Error(`Workflow status: ${data.status}${data.error ? ' - ' + JSON.stringify(data.error) : ''}`);
    err.status = 502;
    throw err;
  }
  let result = parseMaybe(data.result);
  if (result && result.output !== undefined && result.payload === undefined) result = parseMaybe(result.output);
  let payload = parseMaybe(result && result.payload !== undefined ? result.payload : result);
  if (!payload || !Array.isArray(payload.tables)) {
    const err = new Error('Workflow returned an unexpected shape: ' + JSON.stringify(result).slice(0, 300));
    err.status = 502;
    throw err;
  }
  return payload;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/data') {
    try {
      if (!inflight) inflight = fetchPayload().finally(() => { inflight = null; });
      const payload = await inflight;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
    } catch (e) {
      res.writeHead(e.status || 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Digital Assets demo dashboard: http://localhost:${PORT}`);
  console.log(API_KEY ? `Platform: ${BASE_URL}` : 'WARNING: ABL_API_KEY is not set (see .env.example)');
});
