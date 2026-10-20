/**
 * server/proxy.js — optional backend for live AI mode. Zero dependencies.
 *
 * Why this file exists
 * -------------------
 * A browser cannot hold a secret. Any key shipped to the client is readable by
 * anyone who opens devtools or reads the bundle, and "just restrict it by
 * referrer" is not a security control. So CelebrAI's frontend holds no key at
 * all: it POSTs a planning *context* to this server, which adds the key from
 * the environment and forwards the request.
 *
 * It also serves the static app, so `npm start` gives you a working stack.
 *
 *   cp .env.example .env    # then edit it
 *   ANTHROPIC_API_KEY=sk-... node server/proxy.js
 *   open http://localhost:4173
 *
 * With no key configured the server still serves the app; the frontend simply
 * stays in demo mode.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 4173;

// Minimal .env loader (no dependency). Values already in the environment win.
await loadDotEnv(join(ROOT, '.env'));

const PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const API_KEY = process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || '';
const MODEL = process.env.AI_MODEL || (PROVIDER === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o-mini');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/plan') return await handlePlan(req, res);
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res);
    send(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[celebrai]', err);
    send(res, 500, { error: 'Internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`\n  CelebrAI running at http://localhost:${PORT}`);
  console.log(API_KEY
    ? `  Live planning enabled via ${PROVIDER} (${MODEL}). Set the endpoint to /api/plan in Settings.`
    : '  No API key configured — the app will run in demo mode. That is a supported state.\n');
});

/* ───────────────── Static files ───────────────── */

async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, `http://localhost:${PORT}`).pathname);
  let rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  if (rel === '/' || rel === '\\') rel = '/index.html';
  const filePath = join(ROOT, rel);

  // Path traversal guard.
  if (!filePath.startsWith(ROOT)) return send(res, 403, { error: 'Forbidden' });
  // Never serve dotfiles, node_modules or the server directory itself.
  if (/(^|[/\\])(\.|node_modules)/.test(rel)) return send(res, 404, { error: 'Not found' });

  try {
    const info = await stat(filePath);
    if (!info.isFile()) return send(res, 404, { error: 'Not found' });
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'",
      'Referrer-Policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

/* ───────────────── Planning endpoint ───────────────── */

const SYSTEM_PROMPT = `You are a planning assistant for Indian celebrations and events.

Rules you must follow:
- Return ONLY a single JSON object. No prose, no markdown fences.
- NEVER include currency amounts anywhere. The application computes all money itself.
- NEVER name a real business, give a phone number, or claim a vendor is available.
- Express budget split as relative weights (0-100) over the supplied category ids only.
- Express task timing as "daysBefore" the event, never as a date.
- Respect stated non-negotiables, cultural, dietary and accessibility requirements. If a
  requirement conflicts with the budget band or guest count, say so in "risks" rather than
  quietly dropping it.`;

async function handlePlan(req, res) {
  if (!API_KEY) {
    return send(res, 503, {
      error: 'No AI provider configured on the server. The app should stay in demo mode.',
    });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req, 64 * 1024));
  } catch {
    return send(res, 400, { error: 'Body must be JSON under 64KB.' });
  }
  if (!body || typeof body.context !== 'object' || body.context === null) {
    return send(res, 400, { error: 'Missing planning context.' });
  }

  const userPrompt = `Planning context (JSON):\n${JSON.stringify(body.context)}\n\n${String(body.schema ?? '').slice(0, 4000)}`;

  try {
    const text = PROVIDER === 'anthropic'
      ? await callAnthropic(userPrompt)
      : await callOpenAICompatible(userPrompt);
    const plan = extractJson(text);
    if (!plan) return send(res, 502, { error: 'Model did not return parseable JSON.' });
    // The client validates again; this is just an early reject.
    send(res, 200, { plan });
  } catch (err) {
    console.error('[celebrai] provider error:', err.message);
    send(res, 502, { error: 'Planning provider request failed.' });
  }
}

async function callAnthropic(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return data.content?.map((c) => c.text ?? '').join('') ?? '';
}

async function callOpenAICompatible(prompt) {
  const base = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return data.choices?.[0]?.message?.content ?? '';
}

/** Pull the first JSON object out of a model response, fences and all. */
function extractJson(text) {
  const trimmed = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(trimmed); } catch { /* try harder */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
}

/* ───────────────── helpers ───────────────── */

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolvePromise, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function loadDotEnv(path) {
  let text;
  try { text = await readFile(path, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, '');
  }
}
