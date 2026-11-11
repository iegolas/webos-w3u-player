// Dev-only HLS relay for the preview. A browser cannot set a Referer or an
// Origin on its own, so the preview server fetches the stream with the site's
// headers and rewrites playlists back through this same endpoint. It lives
// under scripts/ and never enters the IPK.

export const HLS_PATH = '/__hls';
export const PLAYLIST_MAX_BYTES = 2 * 1024 * 1024;
export const MEDIA_MAX_BYTES = 512 * 1024 * 1024;
export const UPSTREAM_TIMEOUT_MS = 10 * 1000;
export const MAX_REDIRECTS = 5;

const USER_AGENT = 'webos-iptv-preview';
const PLAYLIST_TYPE = /(?:mpegurl|m3u8)/i;
const PLAYLIST_FALLBACK = 'application/vnd.apple.mpegurl';
const PASSTHROUGH_HEADERS = [
  'content-type',
  'content-range',
  'accept-ranges',
  'last-modified',
  'etag',
];

export function isPrivateHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return true;
  }
  if (host === '::' || host === '::1') return true;
  if (host.includes(':')) return true; // Conservative for every other IPv6 form.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return a >= 224;
}

export function proxyTarget(raw) {
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

export function proxyUrl(target, referer) {
  const query = `u=${encodeURIComponent(target)}`;
  return referer
    ? `${HLS_PATH}?${query}&r=${encodeURIComponent(referer)}`
    : `${HLS_PATH}?${query}`;
}

export function isPlaylistType(contentType) {
  return typeof contentType === 'string' && PLAYLIST_TYPE.test(contentType);
}

export function looksLikePlaylist(bytes) {
  const head = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const text = head.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  return text.startsWith('#EXTM3U');
}

function refererOf(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    if (!parsed.hostname) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

// Relative URIs resolve against the fetched playlist, absolute ones against
// nothing; non-http schemes (skd:, data:) and fragment-only values stay as-is.
function proxiedUri(raw, base, referer) {
  const uri = raw.trim();
  if (!uri || uri.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) && !/^https?:/i.test(uri)) return null;
  let absolute;
  try {
    absolute = new URL(uri, base);
  } catch {
    return null;
  }
  if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return null;
  const target = proxyTarget(absolute.href);
  return target ? proxyUrl(target.href, referer) : null;
}

// Every URI attribute on an EXT line is a URL the player would fetch next.
export function rewritePlaylist(text, baseUrl, referer) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }
  return text.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      if (!trimmed.startsWith('#EXT') || !trimmed.includes('URI=')) return line;
      return line.replace(/URI="([^"]*)"/g, (whole, uri) => {
        const next = proxiedUri(uri, base, referer);
        return next ? `URI="${next}"` : whole;
      });
    }
    const next = proxiedUri(trimmed, base, referer);
    return next ?? line;
  }).join('\n');
}

function upstreamHeaders(referer, range) {
  const headers = {
    'user-agent': USER_AGENT,
    accept: '*/*',
    'accept-encoding': 'identity',
  };
  if (referer) {
    headers.referer = referer;
    try {
      headers.origin = new URL(referer).origin;
    } catch {
      headers.origin = referer;
    }
  }
  if (range) headers.range = range;
  return headers;
}

async function openUpstream(doFetch, target, referer, range, signal) {
  let current = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let response;
    try {
      response = await doFetch(current, {
        redirect: 'manual',
        signal,
        headers: upstreamHeaders(referer, range),
      });
    } catch {
      return { ok: false, reason: signal.aborted ? 'timeout' : 'network' };
    }
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      if (!location) return { ok: false, reason: `http_${response.status}` };
      let nextRaw;
      try {
        nextRaw = new URL(location, current).href;
      } catch {
        return { ok: false, reason: 'blocked' };
      }
      const next = proxyTarget(nextRaw);
      if (!next) return { ok: false, reason: 'blocked' };
      current = next;
      continue;
    }
    return { ok: true, response, url: current };
  }
  return { ok: false, reason: 'too_many_redirects' };
}

async function collect(reader, initial, limit) {
  const chunks = [];
  let size = 0;
  for (const chunk of initial) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    size += chunk.length;
    if (size > limit) {
      try { await reader.cancel(); } catch { /* best effort */ }
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readCapped(response, limit) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > limit) {
    try { await response.body?.cancel(); } catch { /* best effort */ }
    return null;
  }
  if (!response.body) return Buffer.alloc(0);
  return collect(response.body.getReader(), [], limit);
}

async function peek(reader) {
  const chunks = [];
  let size = 0;
  let done = false;
  while (size < 64) {
    const result = await reader.read();
    if (result.done) {
      done = true;
      break;
    }
    const chunk = Buffer.from(result.value);
    chunks.push(chunk);
    size += chunk.length;
  }
  return { chunks, done };
}

function sendText(res, status, text) {
  if (res.writableEnded || res.destroyed || res.headersSent) return;
  const body = Buffer.from(text);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  res.end(body);
}

async function writePlaylist(res, text, contentType) {
  const body = Buffer.from(text);
  res.writeHead(200, {
    'Content-Type': isPlaylistType(contentType) ? contentType : PLAYLIST_FALLBACK,
    'Cache-Control': 'no-store',
    'Content-Length': body.length,
  });
  res.end(body);
}

async function streamBody(res, response, prefix, reader, controller) {
  const headers = {};
  for (const name of PASSTHROUGH_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers[name] = value;
  }
  headers['cache-control'] = 'no-store';
  const length = response.headers.get('content-length');
  if (length && !response.headers.get('content-encoding')) headers['content-length'] = length;

  res.writeHead(response.status, headers);
  let sent = 0;
  let idle = null;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  };
  const write = (chunk) => {
    sent += chunk.length;
    if (sent > MEDIA_MAX_BYTES) {
      controller.abort();
      res.destroy();
      return false;
    }
    return res.write(chunk);
  };
  try {
    arm();
    for (const chunk of prefix) {
      if (!write(chunk)) return;
    }
    for (;;) {
      if (res.destroyed) return;
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      if (!write(Buffer.from(value))) {
        if (sent > MEDIA_MAX_BYTES) return;
        await new Promise((resolve) => {
          res.once('drain', resolve);
          res.once('close', resolve);
        });
      }
    }
    res.end();
  } finally {
    clearTimeout(idle);
  }
}

export async function handleHlsRequest(req, res, requestUrl, deps = {}) {
  if (req.method !== 'GET') {
    res.writeHead(405, { Allow: 'GET' });
    res.end('Method not allowed');
    return;
  }
  const raw = requestUrl.searchParams.get('u');
  const target = raw ? proxyTarget(raw) : null;
  if (!target) {
    sendText(res, raw ? 403 : 400, raw ? 'blocked' : 'invalid');
    return;
  }

  const referer = refererOf(requestUrl.searchParams.get('r')) || `${target.origin}/`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onClose);

  let upstream;
  try {
    upstream = await openUpstream(deps.fetch || fetch, target, referer, req.headers.range, controller.signal);
  } catch {
    sendText(res, 502, 'network');
    return;
  } finally {
    clearTimeout(timeout);
  }

  if (!upstream.ok) {
    if (upstream.reason === 'blocked') sendText(res, 403, upstream.reason);
    else sendText(res, 502, upstream.reason);
    return;
  }
  const { response } = upstream;
  if (!response.body) {
    res.writeHead(response.status, { 'Cache-Control': 'no-store' });
    res.end();
    return;
  }

  try {
    const contentType = response.headers.get('content-type') || '';
    if (isPlaylistType(contentType)) {
      const body = await readCapped(response, PLAYLIST_MAX_BYTES);
      if (body === null) {
        sendText(res, 413, 'playlist_too_large');
        return;
      }
      const text = rewritePlaylist(body.toString('utf8'), upstream.url.href, referer);
      if (text === null) {
        sendText(res, 502, 'invalid_playlist_base');
        return;
      }
      await writePlaylist(res, text, contentType);
      return;
    }

    const reader = response.body.getReader();
    const first = await peek(reader);
    const prefix = first.chunks;
    if (looksLikePlaylist(Buffer.concat(prefix))) {
      const rest = first.done
        ? Buffer.alloc(0)
        : await collect(reader, [], PLAYLIST_MAX_BYTES - prefix.reduce((n, c) => n + c.length, 0));
      if (rest === null) {
        sendText(res, 413, 'playlist_too_large');
        return;
      }
      const text = rewritePlaylist(
        Buffer.concat([...prefix, rest]).toString('utf8'),
        upstream.url.href,
        referer,
      );
      if (text === null) {
        sendText(res, 502, 'invalid_playlist_base');
        return;
      }
      await writePlaylist(res, text, contentType);
      return;
    }

    await streamBody(res, response, prefix, reader, controller);
  } catch {
    if (res.headersSent) res.destroy();
    else sendText(res, 502, controller.signal.aborted ? 'timeout' : 'network');
  }
}
