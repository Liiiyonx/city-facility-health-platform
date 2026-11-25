import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.js';
import { closeServer, createPlatformServer, listen } from '../src/server.js';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));

function loadPlaywrightCore() {
  const candidates = [];
  const loadErrors = [];
  if (process.env.PLAYWRIGHT_CORE_PATH) candidates.push(resolve(process.env.PLAYWRIGHT_CORE_PATH));
  try {
    return require('playwright-core');
  } catch (error) {
    loadErrors.push(error.message);
  }
  const globalRoots = process.platform === 'win32'
    ? [
        process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules'),
        join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules'),
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'npm', 'node_modules'),
        'C:/Program Files/nodejs/node_modules'
      ].filter(Boolean)
    : [
        join(homedir(), '.npm-global', 'lib', 'node_modules'),
        '/usr/local/lib/node_modules',
        '/usr/lib/node_modules',
        '/opt/homebrew/lib/node_modules'
      ];
  for (const globalRoot of globalRoots) {
    candidates.push(
      join(globalRoot, '@playwright', 'mcp', 'node_modules', 'playwright-core'),
      join(globalRoot, 'playwright-core'),
      join(globalRoot, 'playwright', 'node_modules', 'playwright-core')
    );
  }
  for (const candidate of [...new Set(candidates)]) {
    if (!existsSync(candidate)) continue;
    try { return require(candidate); } catch (error) { loadErrors.push(`${candidate}: ${error.message}`); }
  }
  throw new Error(`未找到 playwright-core，请设置 PLAYWRIGHT_CORE_PATH 或安装本地/全局 Playwright。${loadErrors.join('；')}`);
}

function findChromePath() {
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH)) throw new Error(`CHROME_PATH 不存在：${process.env.CHROME_PATH}`);
    return process.env.CHROME_PATH;
  }
  const candidates = process.platform === 'win32'
    ? [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
      ].filter(Boolean)
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium'
        ]
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  return candidates.find(candidate => existsSync(candidate));
}

const { chromium } = loadPlaywrightCore();
const artifactDir = join(root, 'artifacts');
mkdirSync(artifactDir, { recursive: true });
const externalBase = process.env.BASE_URL?.trim();
const uploadDir = externalBase ? null : mkdtempSync(join(tmpdir(), 'cityhealth-browser-'));
const db = externalBase ? null : openDatabase({ filename: ':memory:' });
let server = null;
let browser = null;
let base = externalBase;

const errors = [];
const watch = (page, label) => {
  page.on('pageerror', error => errors.push(`${label} pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('favicon')) errors.push(`${label} console: ${message.text()}`);
  });
};

async function assertRendered(page, marker, label) {
  await page.waitForFunction(text => document.body.innerText.includes(text) && !document.querySelector('.loading-state') && !document.querySelector('.state.error-state'), marker);
  const text = await page.locator('body').innerText();
  if (text.includes('undefined') || text.includes('NaN')) {
    const invalid = text.split('\n').filter(line => line.includes('undefined') || line.includes('NaN')).join(' | ');
    throw new Error(`${label} 渲染了无效值：${invalid}`);
  }
  if (await page.locator('.state.error-state').count()) throw new Error(`${label} 停留在错误状态`);
  if (await page.locator('.loading-state').count()) throw new Error(`${label} 未完成加载`);
}

async function assertCurrentCitizenTab(page, tab) {
  await page.waitForFunction(expected => {
    const current = [...document.querySelectorAll('.bottom-nav [data-tab][aria-current="page"]')];
    return current.length === 1 && current[0].dataset.tab === expected;
  }, tab);
}

async function settleEntranceAnimations(page) {
  await page.evaluate(async () => {
    const animations = document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
  });
}

async function emulateReducedPreferences(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'prefers-reduced-motion', value: 'reduce' },
      { name: 'prefers-reduced-transparency', value: 'reduce' }
    ]
  });
}

try {
  if (!externalBase) {
    server = createPlatformServer({ db, uploadDir });
    ({ url: base } = await listen(server, 0));
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: findChromePath(),
    args: ['--disable-dev-shm-usage']
  });

  const admin = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  watch(admin, 'admin');
  const routes = [
    ['dashboard', '健康总览'],
    ['facilities', '设施台账'],
    ['facility/fac-1', '桂花苑小区'],
    ['inspections', '巡检任务'],
    ['detections', '识别记录'],
    ['reviews', '复核任务'],
    ['responses', '响应台账'],
    ['workorders', '工单列表'],
    ['public', '线索台账'],
    ['audit', '操作记录']
  ];
  for (const [route, marker] of routes) {
    await admin.goto(`${base}/admin/#/${route}`, { waitUntil: 'networkidle' });
    await assertRendered(admin, marker, `管理端/${route}`);
    if (route === 'facility/fac-1' && /\b(crack|spall|hollow|corrosion|leak|sealant)\b/.test(await admin.locator('#app').innerText())) {
      throw new Error('设施详情仍显示英文缺陷枚举');
    }
    const overflow = await admin.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
    if (overflow) throw new Error(`管理端/${route} 存在横向溢出`);
    await settleEntranceAnimations(admin);
    await admin.screenshot({ path: join(artifactDir, `admin-${route.split('/')[0]}.png`), fullPage: true });
  }

  await admin.goto(`${base}/admin/#/facilities`, { waitUntil: 'networkidle' });
  await assertRendered(admin, '设施台账', '管理端/本地检索');
  let facilityRequests = 0;
  const countFacilityRequests = request => {
    if (new URL(request.url()).pathname === '/api/facilities') facilityRequests += 1;
  };
  admin.on('request', countFacilityRequests);
  try {
    const beforeSearch = facilityRequests;
    const query = '桂花苑小区';
    await admin.locator('[data-filter="q"]').fill(query);
    await admin.waitForFunction(() => document.querySelectorAll('.facility-card').length === 1);
    await admin.waitForFunction(expected => {
      const input = document.querySelector('[data-filter="q"]');
      return input?.value === expected && document.activeElement === input
        && input.selectionStart === expected.length && input.selectionEnd === expected.length;
    }, query);
    assert.equal(facilityRequests, beforeSearch, '本地检索不应再次请求 /api/facilities');
  } finally {
    admin.off('request', countFacilityRequests);
  }

  await admin.goto(`${base}/admin/#/dashboard`, { waitUntil: 'networkidle' });
  await assertRendered(admin, '文晖公寓', '管理端/看板数据');
  if (!(await admin.locator('body').innerText()).includes('文晖公寓')) throw new Error('看板未加载真实高风险设施数据');
  if (!(await admin.locator('.trend-line').getAttribute('d'))?.includes('L')) throw new Error('巡检趋势图未绘制');
  const downloadPromise = admin.waitForEvent('download');
  await admin.getByRole('button', { name: '导出监管报表' }).click();
  const download = await downloadPromise;
  if (!download.suggestedFilename().endsWith('.csv')) throw new Error('监管报表下载文件名不是 CSV');
  const csvPath = resolve(artifactDir, download.suggestedFilename());
  await download.saveAs(csvPath);
  const csv = await readFile(csvPath, 'utf8');
  if (!csv.includes('设施') || !csv.includes('桂花苑小区')) throw new Error('监管报表内容不完整');

  await admin.goto(`${base}/admin/#/dashboard`, { waitUntil: 'networkidle' });
  await assertRendered(admin, '健康总览', '管理端/角色切换');
  await admin.locator('#user-select').selectOption('repair-1');
  await admin.waitForFunction(() => document.querySelector('.user-switcher label small')?.textContent.includes('李维修'));
  if (await admin.locator('[data-nav="public"]').getAttribute('hidden') === null) throw new Error('维修角色仍显示公众线索导航');
  if (await admin.locator('[data-nav="audit"]').getAttribute('hidden') === null) throw new Error('维修角色仍显示审计导航');
  if (await admin.getByRole('button', { name: '导出监管报表' }).count()) throw new Error('维修角色仍显示监管报表导出');
  await admin.goto(`${base}/admin/#/workorders`, { waitUntil: 'networkidle' });
  await assertRendered(admin, '整改工单', '管理端/维修角色工单范围');
  if ((await admin.locator('tbody').innerText()).includes('桂花苑小区')) throw new Error('维修角色看到了其他处置单位的工单');
  await admin.locator('#user-select').selectOption('gov-1');
  await admin.waitForFunction(() => document.querySelector('.user-switcher label small')?.textContent.includes('陈监管'));
  if (await admin.locator('[data-nav="public"]').getAttribute('hidden') !== null) throw new Error('监管角色未恢复公众线索导航');

  await admin.goto(`${base}/admin/#/detections`, { waitUntil: 'networkidle' });
  await assertRendered(admin, 'AI 缺陷识别', '管理端/检测修正表单');
  await admin.getByRole('button', { name: '人工复核' }).first().click();
  await admin.locator('[name="status"]').selectOption('修正');
  if (!(await admin.locator('[name="defectType"]').count())) throw new Error('修正复核表单缺少缺陷类型字段');
  await admin.locator('[name="note"]').fill('浏览器验收修正复核必填项');
  await admin.getByRole('button', { name: '提交复核' }).click();
  await admin.waitForFunction(() => document.body.innerText.includes('修正检测结果时必须选择缺陷类型'));
  await admin.locator('[data-close-modal]').first().click();

  await admin.goto(`${base}/admin/#/inspections`, { waitUntil: 'networkidle' });
  await admin.getByRole('button', { name: '新建巡检任务' }).click();
  await admin.locator('[name="facilityId"]').fill('fac-3');
  await admin.locator('[name="buildingId"]').fill('bld-3-2');
  await admin.locator('[name="componentId"]').fill('cmp-3-2-roof');
  await admin.locator('[name="scope"]').fill('浏览器验收：屋面及排水系统');
  await admin.locator('[name="plannedAt"]').fill(new Date(Date.now() + 3_600_000).toISOString().slice(0, 16));
  await admin.locator('[name="assignee"]').fill('林巡检');
  await admin.getByRole('button', { name: '创建任务' }).click();
  await admin.waitForFunction(() => document.body.innerText.includes('浏览器验收：屋面及排水系统'));
  const taskRow = admin.locator('tbody tr').filter({ hasText: '浏览器验收：屋面及排水系统' }).first();
  let currentStatus = '待执行';
  for (const status of ['采集中', '待上传', '数据质检中', '待分析']) {
    await taskRow.getByRole('button', { name: '更新状态' }).click();
    await admin.waitForSelector('#modal-title:text-is("更新巡检状态")');
    await admin.waitForFunction(() => document.querySelectorAll('.modal-overlay:not(.is-leaving)').length === 1);
    assert.equal(await admin.locator('.modal-overlay:not(.is-leaving) [name="status"]').inputValue(), currentStatus, '状态弹窗未展示最新任务状态');
    await admin.locator('.modal-overlay:not(.is-leaving) [name="status"]').selectOption(status);
    await admin.getByRole('button', { name: '保存状态' }).click();
    await admin.waitForFunction(expected => {
      const rows = [...document.querySelectorAll('tbody tr')];
      return rows.some(row => row.innerText.includes('浏览器验收：屋面及排水系统') && row.innerText.includes(expected));
    }, status);
    await admin.waitForFunction(() => !document.querySelector('.modal-overlay:not(.is-leaving)'));
    currentStatus = status;
  }
  await taskRow.getByRole('button', { name: '轻量分析' }).click();
  await admin.locator('[name="defectType"]').selectOption('spall');
  await admin.locator('[name="severity"]').fill('95');
  await admin.locator('[name="componentImportance"]').selectOption('structural');
  await admin.locator('[name="environment"]').fill('80');
  await admin.locator('[name="location"]').fill('浏览器验收屋面区域');
  await admin.getByRole('button', { name: '开始分析' }).click();
  await admin.waitForSelector('#modal-title:text-is("分析结果")');
  const analysisText = await admin.locator('.modal').innerText();
  if (!analysisText.includes('IV 级 · 紧急') || !analysisText.includes('演示规则')) throw new Error('浏览器分析结果未正确展示');
  if (analysisText.includes('{') || analysisText.includes('"id"')) throw new Error('分析结果弹窗暴露了原始 JSON');
  if (/"(?:analysis|assessment|detection|dimensions|reasons)"\s*:/.test(analysisText) || await admin.locator('.modal pre').count()) {
    throw new Error('分析结果弹窗包含原始 JSON 载荷');
  }
  if (!analysisText.includes('综合得分') || !analysisText.includes('主体结构构件')) throw new Error('分析结果缺少四维评分说明');
  await settleEntranceAnimations(admin);
  await admin.screenshot({ path: join(artifactDir, 'admin-analysis-result.png'), fullPage: true });
  await admin.getByRole('button', { name: '完成' }).click();

  const citizen = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  watch(citizen, 'citizen');
  await citizen.goto(`${base}/citizen/`, { waitUntil: 'networkidle' });
  await assertRendered(citizen, '提交隐患线索', '公众端/提交');
  if (!(await citizen.locator('body').innerText()).includes('隐私说明')) throw new Error('公众端隐私说明未渲染');
  await assertCurrentCitizenTab(citizen, 'report');
  await citizen.locator('.bottom-nav [data-tab="query"]').click();
  await assertCurrentCitizenTab(citizen, 'query');
  await citizen.locator('.bottom-nav [data-tab="about"]').click();
  await assertCurrentCitizenTab(citizen, 'about');
  await citizen.locator('.bottom-nav [data-tab="report"]').click();
  await assertCurrentCitizenTab(citizen, 'report');
  const citizenOverflow = await citizen.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  if (citizenOverflow) throw new Error('公众端存在横向溢出');
  await citizen.locator('[name="communityId"]').selectOption('community-1');
  if ((await citizen.locator('[name="buildingId"] option').count()) !== 5) throw new Error('公众端建筑未按社区过滤');
  await citizen.locator('[name="buildingId"]').selectOption('bld-1-1');
  await settleEntranceAnimations(citizen);
  await citizen.screenshot({ path: join(artifactDir, 'citizen-report.png'), fullPage: true });

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  await citizen.locator('#camera-input').setInputFiles({ name: 'facade.png', mimeType: 'image/png', buffer: png });
  await citizen.locator('[name="type"]').selectOption('crack');
  await citizen.locator('#report-form [name="description"]').fill('住宅楼外墙发现一条明显裂缝，希望安排工作人员现场核查。');
  await citizen.locator('[name="location"]').fill('桂花苑社区1幢南侧');
  await citizen.locator('[name="consent"]').check();
  await citizen.getByRole('button', { name: '提交隐患线索' }).click();
  await citizen.waitForSelector('#success-panel', { timeout: 10_000 });
  await citizen.waitForFunction(() => {
    const code = document.querySelector('#success-panel .success-code strong');
    return code !== null && document.activeElement === code;
  });
  const successText = await citizen.locator('#success-panel').innerText();
  if (!successText.includes('墙体裂缝') || /\bcrack\b/.test(successText)) throw new Error('公众端提交回执未正确显示中文线索分类');
  const code = (await citizen.locator('.success-code strong').innerText()).trim();
  if (!/^PUB-\d{8}-\d{4}-[A-F0-9]{10}$/.test(code)) throw new Error('公众报告编号格式不正确');
  await settleEntranceAnimations(citizen);
  await citizen.screenshot({ path: join(artifactDir, 'citizen-success.png'), fullPage: true });
  await citizen.locator('#success-panel').getByRole('button', { name: '查询进度' }).click();
  await citizen.waitForFunction(() => document.querySelector('#query-result')?.innerText.includes('处理进度'));
  if (!(await citizen.locator('#query-result').innerText()).includes(code)) throw new Error('公众端未查询到刚提交的线索');
  const privateFields = await citizen.locator('#query-result').innerText();
  if (privateFields.includes('桂花苑') || privateFields.includes('13800000000')) throw new Error('公众查询泄露位置或联系方式');
  await settleEntranceAnimations(citizen);
  await citizen.screenshot({ path: join(artifactDir, 'citizen-query.png'), fullPage: true });

  await emulateReducedPreferences(admin);
  await admin.goto(`${base}/admin/#/dashboard`, { waitUntil: 'networkidle' });
  await assertRendered(admin, '健康总览', '管理端/无障碍偏好');
  const adminPreferences = await admin.evaluate(() => {
    const surfaces = ['.sidebar', '.topbar'].map(selector => {
      const style = getComputedStyle(document.querySelector(selector));
      return { background: style.backgroundColor, backdrop: style.backdropFilter };
    });
    const entrance = getComputedStyle(document.querySelector('.app-main > *'));
    return { surfaces, animationDuration: entrance.animationDuration, transitionDuration: entrance.transitionDuration };
  });
  if (adminPreferences.surfaces.some(surface => surface.background !== 'rgb(255, 255, 255)' || surface.backdrop !== 'none')) {
    throw new Error(`管理端未按减少透明度偏好切换为不透明导航：${JSON.stringify(adminPreferences.surfaces)}`);
  }
  if (parseFloat(adminPreferences.animationDuration) > 0.001 || parseFloat(adminPreferences.transitionDuration) > 0.001) {
    throw new Error('管理端未按减少动态效果偏好停用入场动画');
  }

  await emulateReducedPreferences(citizen);
  await citizen.goto(`${base}/citizen/`, { waitUntil: 'networkidle' });
  await assertRendered(citizen, '提交隐患线索', '公众端/无障碍偏好');
  await assertCurrentCitizenTab(citizen, 'report');
  const citizenPreferences = await citizen.evaluate(() => {
    const surfaces = ['.citizen-header', '.bottom-nav'].map(selector => {
      const style = getComputedStyle(document.querySelector(selector));
      return { background: style.backgroundColor, backdrop: style.backdropFilter };
    });
    const button = getComputedStyle(document.querySelector('.bottom-nav button'));
    return { surfaces, transitionDuration: button.transitionDuration };
  });
  if (citizenPreferences.surfaces.some(surface => surface.background !== 'rgb(255, 255, 255)' || surface.backdrop !== 'none')) {
    throw new Error('公众端未按减少透明度偏好切换为不透明导航');
  }
  if (citizenPreferences.transitionDuration.split(',').some(value => parseFloat(value) > 0.001)) {
    throw new Error('公众端未按减少动态效果偏好停用导航过渡');
  }

  await admin.emulateMedia({ forcedColors: 'active' });
  await admin.reload({ waitUntil: 'networkidle' });
  await assertRendered(admin, '健康总览', '管理端/强制颜色');
  const forcedColorBorder = await admin.locator('.metric-card').first().evaluate(element => {
    const style = getComputedStyle(element);
    return { width: style.borderTopWidth, style: style.borderTopStyle };
  });
  if (forcedColorBorder.width !== '1px' || forcedColorBorder.style !== 'solid') throw new Error('管理端强制颜色模式缺少可见边框');

  await citizen.emulateMedia({ forcedColors: 'active' });
  await citizen.reload({ waitUntil: 'networkidle' });
  await assertRendered(citizen, '提交隐患线索', '公众端/强制颜色');
  const citizenForcedColorBorder = await citizen.locator('.form-section').first().evaluate(element => {
    const style = getComputedStyle(element);
    return { width: style.borderTopWidth, style: style.borderTopStyle };
  });
  if (citizenForcedColorBorder.width !== '1px' || citizenForcedColorBorder.style !== 'solid') throw new Error('公众端强制颜色模式缺少可见边框');

  if (errors.length) throw new Error(errors.join('\n'));
  console.log('浏览器验收通过：管理端10页、CSV导出、新建巡检→状态流转→AI初判、公众端上报→进度查询。');
  console.log('验收结果：无控制台错误、无页面异常、无横向溢出、公众查询无位置或联系方式泄露。');
  console.log('无障碍验收：减少动态效果、减少透明度与强制颜色模式均通过。');
  console.log(`截图目录：${artifactDir}`);
} finally {
  try {
    if (browser) await browser.close();
  } finally {
    try {
      if (server) await closeServer(server);
      else if (db) db.close();
    } finally {
      if (uploadDir) rmSync(uploadDir, { recursive: true, force: true });
    }
  }
}
