import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRoutes } from '../src/routes.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const publicDir = join(root, 'public');
const routes = buildRoutes({ db: null, uploadDir: '' });

async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(path));
    else if (/\.(js|html|css)$/.test(entry.name)) result.push(path);
  }
  return result;
}

function routeMatches(route, callPath, method = 'GET') {
  if ((route.method || 'GET') !== method) return false;
  const routeParts = route.path.split('/').filter(Boolean);
  const callParts = callPath.split(/[?#]/, 1)[0]
    .split('/').filter(Boolean)
    .map(part => part.includes('${') ? ':param' : part);
  if (callParts.length !== routeParts.length) return false;
  return routeParts.every((part, index) => part.startsWith(':') || part === callParts[index]);
}

const routeMatchExamples = [
  [{ method: 'GET', path: '/api/facilities' }, '/api/facilities', 'GET', true],
  [{ method: 'GET', path: '/api/facilities/:id' }, '/api/facilities', 'GET', false],
  [{ method: 'GET', path: '/api/facilities' }, '/api/facilities/fac-1', 'GET', false],
  [{ method: 'GET', path: '/api/facilities/:id' }, '/api/facilities/${facilityId}', 'GET', true],
  [{ method: 'PATCH', path: '/api/facilities/:id' }, '/api/facilities/fac-1', 'GET', false],
  [{ method: 'PATCH', path: '/api/facilities/:id' }, '/api/facilities/fac-1', 'PATCH', true]
];
for (const [route, path, method, expected] of routeMatchExamples) {
  const actual = routeMatches(route, path, method);
  if (actual !== expected) {
    throw new Error(`routeMatches 自证失败：${method} ${path} / ${route.method} ${route.path}，期望 ${expected}，实际 ${actual}`);
  }
}

const files = await filesUnder(publicDir);
if (files.length < 6) throw new Error(`前端文件过少，检查器可能未覆盖真实产物：${files.length}`);
const source = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
const calls = [];
const seenCalls = new Set();
const addCall = (path, method = 'GET') => {
  const key = `${method} ${path}`;
  if (seenCalls.has(key)) return;
  seenCalls.add(key);
  calls.push({ path, method });
};
const apiCallPattern = /\bapi\(\s*(['"`])(\/api\/[^'"`]+)\1([\s\S]*?)\)/g;
for (const match of source.matchAll(apiCallPattern)) {
  addCall(match[2], match[3].match(/\bmethod\s*:\s*['"]([A-Z]+)['"]/)?.[1] || 'GET');
}
for (const match of source.matchAll(/\bpath\s*:\s*(['"`])(\/api\/[^'"`]+)\1/g)) {
  addCall(match[2]);
}
for (const match of source.matchAll(/\browsFor\(\s*(['"`])(\/api\/[^'"`]+)\1/g)) {
  addCall(match[2]);
}
for (const match of source.matchAll(/\bpath\s*=\s*(['"`])(\/api\/[^'"`]+)\1(?:\s*;\s*method\s*=\s*['"]([A-Z]+)['"])?/g)) {
  addCall(match[2], match[3] || 'POST');
}
if (calls.length < 10) throw new Error(`前端API调用过少，检查器可能失效：${calls.length}`);
if (routes.length < 25) throw new Error(`后端路由过少，检查器可能失效：${routes.length}`);
const missing = calls.filter(call => !routes.some(route => routeMatches(route, call.path, call.method)));
if (missing.length) {
  throw new Error(`前端调用了不存在的API：${missing.map(call => `${call.method} ${call.path}`).join(', ')}`);
}
const external = [...source.matchAll(/(?:src|href)=["']https?:\/\/[^"']+/g)];
if (external.length) throw new Error(`前端存在外部资源依赖：${external.map((item) => item[0]).join(', ')}`);
console.log(`接口契约检查通过：${routes.length} 个后端路由，${calls.length} 个前端API调用，${files.length} 个前端文件，无外链资源。`);
