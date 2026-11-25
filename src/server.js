import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { openDatabase } from './db.js';
import { buildRoutes, errorResponse, json, routeApi } from './routes.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PUBLIC_DIR = resolve(ROOT, 'public');
const DEFAULT_UPLOAD_DIR = resolve(ROOT, 'data', 'uploads');
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self), geolocation=(self), microphone=()'
};
const HTML_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

async function readBody(request, maxBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error(`请求体超过${Math.round(maxBytes / 1024 / 1024)}MB限制`);
      error.code = 'PAYLOAD_TOO_LARGE';
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const contentType = String(request.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    const error = new Error('写请求必须使用 application/json');
    error.code = 'UNSUPPORTED_MEDIA_TYPE';
    error.status = 415;
    throw error;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('请求体不是有效JSON');
    error.code = 'INVALID_JSON';
    error.status = 400;
    throw error;
  }
}

function staticPath(pathname, publicDir) {
  let target;
  if (pathname === '/' || pathname === '/admin' || pathname === '/admin/') {
    target = resolve(publicDir, 'admin', 'index.html');
  } else if (pathname === '/citizen' || pathname === '/public' || pathname === '/citizen/' || pathname === '/public/') {
    target = resolve(publicDir, 'citizen', 'index.html');
  } else {
    target = resolve(publicDir, `.${pathname}`);
  }
  if (target !== publicDir && !target.startsWith(`${publicDir}${sep}`)) return null;
  return target;
}

async function serveStatic(response, pathname, publicDir, headOnly = false) {
  const target = staticPath(pathname, publicDir);
  if (!target) {
    json(response, 403, { error: { code: 'FORBIDDEN', message: '禁止访问该路径' } });
    return;
  }
  try {
    const info = await stat(target);
    if (!info.isFile()) throw new Error('not a file');
    const content = await readFile(target);
    const contentType = MIME[extname(target).toLowerCase()] || 'application/octet-stream';
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
      ...SECURITY_HEADERS,
      ...(contentType.startsWith('text/html') ? { 'Content-Security-Policy': HTML_CSP } : {})
    });
    response.end(headOnly ? undefined : content);
  } catch {
    json(response, 404, { error: { code: 'NOT_FOUND', message: '文件不存在' } });
  }
}

function createRateLimiter({ publicReports = 10, publicLookup = 30, windowMs = 60_000 } = {}) {
  const buckets = new Map();
  return (request, pathname, method) => {
    const bucket = method === 'POST' && pathname === '/api/public/reports'
      ? 'reports'
      : method === 'GET' && /^\/api\/public\/reports\/[^/]+$/.test(pathname)
        ? 'lookup'
        : null;
    if (!bucket) return;
    const timestamp = Date.now();
    const key = `${request.socket.remoteAddress || 'unknown'}:${bucket}`;
    const entry = buckets.get(key);
    const limit = bucket === 'reports' ? publicReports : publicLookup;
    if (!entry || timestamp >= entry.resetAt) {
      buckets.set(key, { count: 1, resetAt: timestamp + windowMs });
      return;
    }
    if (entry.count >= limit) {
      const error = new Error('请求过于频繁，请稍后再试');
      error.code = 'RATE_LIMITED';
      error.status = 429;
      throw error;
    }
    entry.count += 1;
  };
}

function assertDemoHost(host) {
  const loopback = host === 'localhost' || host === '::1' || host === '[::1]' || host.startsWith('127.');
  if (loopback) return;
  if (process.env.ALLOW_INSECURE_REMOTE_DEMO !== 'true') {
    throw new Error('演示身份可由请求头切换，禁止直接绑定非本机地址；私有部署请显式设置 ALLOW_INSECURE_REMOTE_DEMO=true 并置于可信网络。');
  }
  console.warn('安全提示：当前以不安全的远程演示模式监听，请仅限可信私有网络使用。');
}

export function createPlatformServer({
  db = openDatabase(),
  publicDir = DEFAULT_PUBLIC_DIR,
  uploadDir = DEFAULT_UPLOAD_DIR,
  host = '127.0.0.1',
  rateLimit = {}
} = {}) {
  assertDemoHost(host);
  mkdirSync(uploadDir, { recursive: true });
  const routes = buildRoutes({ db, uploadDir });
  const consumeRateLimit = createRateLimiter(rateLimit);
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      consumeRateLimit(request, pathname, request.method);
      if (pathname.startsWith('/api/')) {
        const acceptsPhotos = /^\/api\/workorders\/[^/]+\/acceptance$/.test(pathname) && request.method === 'POST';
        const body = ['POST', 'PUT', 'PATCH'].includes(request.method)
          ? await readBody(request, acceptsPhotos ? 24 * 1024 * 1024 : undefined)
          : {};
        const result = await routeApi(request, response, routes, body);
        if (pathname === '/api/export/regulation.csv' && result?.csv !== undefined) {
          response.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
            'Cache-Control': 'no-store',
            ...SECURITY_HEADERS,
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
          });
          response.end(result.csv);
          return;
        }
        if (!response.headersSent) json(response, 200, result);
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) {
        json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求方法' } });
        return;
      }
      await serveStatic(response, pathname, publicDir, request.method === 'HEAD');
    } catch (error) {
      console.error(`[${new Date().toISOString()}] ${request.method} ${request.url}:`, error.message);
      if (!response.headersSent) errorResponse(response, error);
      else response.end();
    }
  });
  server.host = host;
  server.db = db;
  server.routes = routes;
  return server;
}

export async function listen(server, port = Number(process.env.PORT || 3000)) {
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, server.host, resolvePromise);
  });
  const address = server.address();
  return { port: address.port, url: `http://${server.host}:${address.port}` };
}

export async function closeServer(server) {
  if (server.listening) await new Promise((resolvePromise) => server.close(resolvePromise));
  server.db.close();
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const db = openDatabase({ filename: resolve(ROOT, 'data', 'platform.sqlite') });
  const server = createPlatformServer({ db, host: process.env.HOST || '127.0.0.1' });
  try {
    const info = await listen(server);
    console.log(`城建设施健康平台已启动：${info.url}`);
    console.log(`管理端：${info.url}/admin/`);
    console.log(`公众端：${info.url}/citizen/`);
    console.log('本地演示模式：AI结果由可解释规则生成，不构成正式安全鉴定。');
  } catch (error) {
    console.error('启动失败：', error.message);
    db.close();
    process.exitCode = 1;
  }

  const shutdown = async () => {
    await closeServer(server);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
