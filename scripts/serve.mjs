import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname } from 'path';
import { LEGACY_HEADER, readLegacyAsset } from './chromium-53-simulation.mjs';
import { HLS_PATH, handleHlsRequest, isPrivateHost } from './hls-proxy.mjs';

const PORT = Number(process.env.PREVIEW_PORT) || 3000;
const DIR = 'dist';

const MIME = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.m3u': 'application/x-mpegurl',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ts': 'video/mp2t',
  '.ttml': 'application/ttml+xml',
  '.vtt': 'text/vtt',
  '.xml': 'application/xml',
};

// The preview has no Luna service, so the app asks this endpoint to read an
// embed page server-side. Same bounds as the resolver; dev only.
const EMBED_PATH = '/__embed';
const EMBED_MAX_BYTES = 512 * 1024;
const EMBED_TIMEOUT_MS = 10 * 1000;
const EMBED_MAX_REDIRECTS = 5;

function embedTarget(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname || isPrivateHost(parsed.hostname)) return null;
  return parsed;
}

async function readCapped(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > EMBED_MAX_BYTES) return null;
  if (!response.body) {
    const text = await response.text();
    return text.length > EMBED_MAX_BYTES ? null : text;
  }
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > EMBED_MAX_BYTES) {
      try { await reader.cancel(); } catch { /* best effort */ }
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchEmbedPage(rawUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
  try {
    let target = embedTarget(rawUrl);
    if (!target) return { ok: false, reason: 'blocked' };
    for (let hop = 0; hop <= EMBED_MAX_REDIRECTS; hop++) {
      const response = await fetch(target, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'webos-iptv-preview', accept: 'text/html,*/*' },
      });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400) {
        if (!location) return { ok: false, reason: `http_${response.status}` };
        const next = embedTarget(new URL(location, target).href);
        if (!next) return { ok: false, reason: 'blocked' };
        target = next;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        return { ok: false, reason: `http_${response.status}`, status: response.status };
      }
      const text = await readCapped(response);
      if (text === null) return { ok: false, reason: 'too_large', status: response.status };
      return { ok: true, status: response.status, url: target.href, text };
    }
    return { ok: false, reason: 'too_many_redirects' };
  } catch {
    return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

async function serveEmbed(req, res, requestUrl) {
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' });
    res.end('Method not allowed');
    return;
  }
  const raw = requestUrl.searchParams.get('url');
  const result = raw ? await fetchEmbedPage(raw) : { ok: false, reason: 'invalid' };
  const body = JSON.stringify(result);
  res.writeHead(result.ok ? 200 : 502, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', 'http://localhost');
  if (requestUrl.pathname === EMBED_PATH) {
    await serveEmbed(req, res, requestUrl);
    return;
  }
  if (requestUrl.pathname === HLS_PATH) {
    await handleHlsRequest(req, res, requestUrl);
    return;
  }
  const pathname = requestUrl.pathname;
  const file = join(DIR, pathname === '/' ? '/index.html' : pathname);
  try {
    const ext = extname(file);
    // The `chromium-53-simulation` Playwright project asks for the webOS 4
    // engine via this header; a plain preview never sends it.
    const legacy = req.headers[LEGACY_HEADER] === '1';
    const data = legacy ? await readLegacyAsset(file, pathname) : await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      Vary: LEGACY_HEADER,
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`Preview: http://localhost:${PORT}`);
});
