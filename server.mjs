import http from 'node:http';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createShare } from './src/share.mjs';
import { createExchangeRateService } from './src/exchange-rates.mjs';

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
});

function securityHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  };
}

function sendJson(response, statusCode, body, extraHeaders = {}) {
  response.writeHead(statusCode, {
    ...securityHeaders(),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

async function readJson(request, limit = 16_384) {
  const chunks = [];
  let size = 0;
  let oversized = false;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      oversized = true;
    } else {
      chunks.push(chunk);
    }
  }
  if (oversized) {
    const error = new Error('请求内容过大');
    error.statusCode = 413;
    throw error;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('JSON 格式无效');
    error.statusCode = 400;
    throw error;
  }
}

function requestBaseUrl(request, configuredBaseUrl) {
  if (configuredBaseUrl) return configuredBaseUrl.replace(/\/+$/, '');
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto === 'https' ? 'https' : 'http';
  const host = String(request.headers['x-forwarded-host'] || request.headers.host || '127.0.0.1').split(',')[0].trim();
  return `${protocol}://${host}`;
}

function clientAddress(request) {
  return request.socket.remoteAddress || 'unknown';
}

function createRateLimiter({ windowMs = 60_000, max = 12 } = {}) {
  const buckets = new Map();
  return (key) => {
    const now = Date.now();
    const existing = buckets.get(key);
    if (!existing || now >= existing.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    existing.count += 1;
    return existing.count <= max;
  };
}

async function serveFile(response, filePath, method, cacheControl, extraHeaders = {}) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    response.writeHead(200, {
      ...securityHeaders(contentType),
      'content-length': info.size,
      'cache-control': cacheControl,
      ...extraHeaders,
    });
    if (method === 'HEAD') response.end();
    else createReadStream(filePath).pipe(response);
    return true;
  } catch {
    return false;
  }
}

function staticPath(publicDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..' || segment.startsWith('.'))) return null;
  const requested = segments.length === 0 ? 'index.html' : segments.join('/');
  const resolved = path.resolve(publicDir, requested);
  const root = `${path.resolve(publicDir)}${path.sep}`;
  return resolved.startsWith(root) ? resolved : null;
}

export function createAppServer({
  publicDir,
  storageDir,
  publicBaseUrl = '',
  idFactory,
  rateLimit,
  exchangeRates = createExchangeRateService({ storageDir }),
} = {}) {
  const allowShare = createRateLimiter(rateLimit);

  return http.createServer(async (request, response) => {
    const method = request.method || 'GET';
    const url = new URL(request.url || '/', 'http://localhost');

    if (method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/exchange-rates') {
      try { sendJson(response, 200, { ok: true, ...await exchangeRates.getLatest() }); }
      catch { sendJson(response, 503, { ok: false, error: '暂时无法取得可信汇率，请稍后重试；人民币输入不受影响' }); }
      return;
    }

    if (method === 'POST' && url.pathname === '/api/shares') {
      if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        sendJson(response, 415, { ok: false, error: '请使用 JSON 请求' });
        return;
      }
      if (!allowShare(clientAddress(request))) {
        sendJson(response, 429, { ok: false, error: '生成过于频繁，请稍后再试' }, { 'retry-after': '60' });
        return;
      }

      try {
        const payload = await readJson(request);
        const base = requestBaseUrl(request, publicBaseUrl);
        const share = await createShare(payload, { storageDir, publicBaseUrl: base, idFactory, exchangeRates });
        sendJson(response, 201, { ok: true, ...share });
      } catch (error) {
        const statusCode = Number(error?.statusCode) || (error instanceof RangeError || error instanceof TypeError ? 400 : 500);
        sendJson(response, statusCode, {
          ok: false,
          error: statusCode === 500 ? '图片生成失败' : error.message,
        });
      }
      return;
    }

    if ((method === 'GET' || method === 'HEAD') && /^\/shares\/[a-zA-Z0-9_-]{6,80}\.png$/.test(url.pathname)) {
      const filePath = path.join(storageDir, path.basename(url.pathname));
      // Public share images are intended for Markdown on other origins.
      // Keep same-origin defaults for HTML, scripts, APIs and error responses.
      if (await serveFile(response, filePath, method, 'public, max-age=31536000, immutable', {
        'cross-origin-resource-policy': 'cross-origin',
        'access-control-allow-origin': '*',
      })) return;
      sendJson(response, 404, { ok: false, error: '图片不存在' });
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      const filePath = staticPath(publicDir, url.pathname);
      const extension = filePath ? path.extname(filePath).toLowerCase() : '';
      const cacheControl = ['.html', '.css', '.js', '.mjs', '.json'].includes(extension)
        ? 'no-cache'
        : 'public, max-age=3600';
      if (filePath && await serveFile(response, filePath, method, cacheControl)) return;
    }

    sendJson(response, 404, { ok: false, error: '页面不存在' });
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const port = Number(process.env.PORT || 4173);
  const host = process.env.HOST || '127.0.0.1';
  const publicDir = path.resolve(root, process.env.STATIC_DIR || 'dist');
  const storageDir = path.resolve(root, process.env.STORAGE_DIR || 'storage/shares');
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || '';

  await access(publicDir);
  const server = createAppServer({ publicDir, storageDir, publicBaseUrl });
  server.listen(port, host, () => {
    console.log(`VPS Value listening on http://${host}:${port}`);
  });
}
