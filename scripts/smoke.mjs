import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { closeServer, createPlatformServer, listen } from '../src/server.js';

const uploadDir = mkdtempSync(join(tmpdir(), 'cityhealth-smoke-'));
const db = openDatabase({ filename: ':memory:' });
const server = createPlatformServer({ db, uploadDir });
try {
  const { url } = await listen(server, 0);
  const checks = [
    ['/api/health', (data) => data.status === 'ok', 'application/json'],
    ['/api/dashboard', (data) => data.metrics.facilities >= 6, 'application/json'],
    ['/admin/', (data) => data.includes('城建设施') || data.includes('设施'), 'text/html'],
    ['/citizen/', (data) => data.includes('上报') || data.includes('隐患'), 'text/html'],
    ['/admin/app.js', (data) => data.length > 0, 'text/javascript'],
    ['/admin/styles.css', (data) => data.length > 0, 'text/css'],
    ['/citizen/app.js', (data) => data.length > 0, 'text/javascript'],
    ['/citizen/styles.css', (data) => data.length > 0, 'text/css']
  ];
  for (const [path, verify, expectedType] of checks) {
    const response = await fetch(`${url}${path}`, { headers: path.startsWith('/api/') ? { 'x-user-id': 'gov-1' } : {} });
    const text = await response.text();
    let data = text;
    if (path.startsWith('/api/')) data = JSON.parse(text);
    const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!response.ok || contentType !== expectedType || !verify(data)) {
      throw new Error(`冒烟检查失败：${path}（状态 ${response.status}，Content-Type ${contentType || '缺失'}）`);
    }
    console.log(`PASS ${path} [${contentType}]`);
  }
} finally {
  await closeServer(server);
  rmSync(uploadDir, { recursive: true, force: true });
}
