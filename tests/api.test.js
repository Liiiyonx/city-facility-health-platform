import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { constants as sqliteConstants } from 'node:sqlite';
import { openDatabase } from '../src/db.js';
import { closeServer, createPlatformServer, listen } from '../src/server.js';

async function request(base, path, { method = 'GET', user = 'gov-1', body, rawBody, headers = {} } = {}) {
  const payload = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined;
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(user ? { 'x-user-id': user } : {}),
      ...(payload !== undefined && !Object.keys(headers).some(name => name.toLowerCase() === 'content-type')
        ? { 'Content-Type': 'application/json' }
        : {}),
      ...headers
    },
    body: payload
  });
  const text = await response.text();
  let data = text;
  if (text) {
    try { data = JSON.parse(text); } catch { /* CSV and other text responses */ }
  }
  return { status: response.status, data, text, headers: response.headers };
}

async function testServer(t, options = {}) {
  const uploadDir = mkdtempSync(join(tmpdir(), 'cityhealth-test-'));
  const db = options.db || openDatabase({ filename: ':memory:' });
  const server = createPlatformServer({ db, uploadDir, ...options.server });
  t.after(async () => {
    await closeServer(server);
    rmSync(uploadDir, { recursive: true, force: true });
  });
  const { url } = await listen(server, 0);
  return { db, server, url, uploadDir };
}

function rowCount(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r' && source[index + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
    } else if (char === '\n' || char === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

test('完整治理闭环：AI初判→专家复核→政府响应→工单→复检销号', async (t) => {
  const uploadDir = mkdtempSync(join(tmpdir(), 'cityhealth-test-'));
  const db = openDatabase({ filename: ':memory:' });
  const server = createPlatformServer({ db, uploadDir });
  const { url } = await listen(server, 0);
  t.after(async () => {
    await closeServer(server);
    rmSync(uploadDir, { recursive: true, force: true });
  });

  const health = await request(url, '/api/health', { user: null });
  assert.equal(health.status, 200);
  assert.equal(health.data.status, 'ok');
  const initialDashboard = await request(url, '/api/dashboard');
  assert.equal(initialDashboard.data.inspectionTrend.reduce((sum, item) => sum + item.count, 0), 6);
  const dashboardFacilities = await request(url, '/api/facilities');
  const facilityIds = new Set(dashboardFacilities.data.map((item) => item.id));
  assert.ok(initialDashboard.data.recentAlerts.length > 0);
  assert.ok(initialDashboard.data.recentAlerts.every((item) => facilityIds.has(item.facilityId)), '总览预警必须返回可跳转的真实设施ID');
  const exportResponse = await fetch(`${url}/api/export/regulation.csv`, { headers: { 'x-user-id': 'gov-1' } });
  assert.equal(exportResponse.status, 200);
  assert.match(exportResponse.headers.get('content-type'), /^text\/csv/);
  assert.match(exportResponse.headers.get('content-disposition'), /attachment/);
  assert.match(await exportResponse.text(), /桂花苑小区/);
  const seededReport = await request(url, '/api/public/reports');
  assert.equal(typeof seededReport.data[0].qualityScore, 'number');
  assert.equal(typeof seededReport.data[0].feedback, 'string');

  const unauthorized = await request(url, '/api/facilities', { user: null });
  assert.equal(unauthorized.status, 403);

  const analyzed = await request(url, '/api/inspections/insp-extra-3/analyze', {
    method: 'POST',
    body: { defectType: '混凝土剥落与露筋', severity: 95, componentImportance: 'structural', environment: 80, location: '南立面五层' }
  });
  assert.equal(analyzed.status, 200);
  assert.equal(analyzed.data.assessment.aiGrade, 'IV');
  assert.ok(Array.isArray(analyzed.data.assessment.reasons), '新评估的 reasons 必须对外返回数组');
  assert.equal(analyzed.data.detection.type, 'spall');
  assert.ok(analyzed.data.review.id);
  assert.equal(analyzed.data.detection.geometry.calibrated, false);

  const repeated = await request(url, '/api/inspections/insp-extra-3/analyze', {
    method: 'POST',
    body: { defectType: 'spall', severity: 50, componentImportance: 'medium', environment: 30 }
  });
  assert.equal(repeated.status, 400);
  assert.equal(repeated.data.error.code, 'INVALID_ANALYSIS_STATE');

  const accepted = await request(url, `/api/reviews/${analyzed.data.review.id}`, {
    method: 'PATCH', user: 'expert-1', body: { status: '待接单' }
  });
  assert.equal(accepted.status, 200);
  const reviewing = await request(url, `/api/reviews/${analyzed.data.review.id}`, {
    method: 'PATCH', user: 'expert-1', body: { status: '复核中' }
  });
  assert.equal(reviewing.status, 200);
  const completed = await request(url, `/api/reviews/${analyzed.data.review.id}`, {
    method: 'PATCH', user: 'expert-1',
    body: { status: '已完成', conclusion: '确认', opinion: '建议紧急处置并开展现场专业复核。', expertGrade: 'IV' }
  });
  assert.equal(completed.status, 200);

  const responses = await request(url, '/api/responses');
  const responseTask = responses.data.find((item) => item.assessmentId === analyzed.data.assessment.id);
  assert.ok(responseTask);
  assert.equal(responseTask.grade, 'IV');
  const responded = await request(url, `/api/responses/${responseTask.id}`, {
    method: 'PATCH', body: { status: '已响应', action: '责任部门确认接收并启动现场核查。' }
  });
  assert.equal(responded.status, 200);
  assert.ok(responded.data.respondedAt);

  const createdOrder = await request(url, '/api/workorders', {
    method: 'POST',
    body: {
      assessmentId: analyzed.data.assessment.id,
      unit: '城维工程有限公司',
      owner: '李维修',
      dueAt: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      requirement: '落实临时管控并完成专业维修。'
    }
  });
  assert.equal(createdOrder.status, 200);
  for (const status of ['待接单', '处理中', '待复检']) {
    const updated = await request(url, `/api/workorders/${createdOrder.data.id}`, { method: 'PATCH', body: { status, note: '测试推进' } });
    assert.equal(updated.status, 200);
  }
  const acceptancePhoto = `data:image/png;base64,${Buffer.concat([
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'),
    Buffer.alloc(1024)
  ]).toString('base64')}`;
  const acceptance = await request(url, `/api/workorders/${createdOrder.data.id}/acceptance`, {
    method: 'POST', user: 'accept-1',
    body: { result: '通过', reviewer: '何验收', opinion: '整改资料完整，复检通过。', beforePhoto: acceptancePhoto, afterPhoto: acceptancePhoto }
  });
  assert.equal(acceptance.status, 200);
  assert.equal(acceptance.data.status, '已销号');
  const acceptanceRecords = await request(url, `/api/workorders/${createdOrder.data.id}/acceptances`, { user: 'accept-1' });
  assert.equal(acceptanceRecords.status, 200);
  assert.equal(acceptanceRecords.data[0].beforePhoto, acceptancePhoto);
  assert.equal(acceptanceRecords.data[0].afterPhoto, acceptancePhoto);

  const orders = await request(url, '/api/workorders');
  const closed = orders.data.find((item) => item.id === createdOrder.data.id);
  assert.equal(closed.status, '已销号');
  const audit = await request(url, '/api/audit');
  assert.ok(audit.data.some((item) => item.action === '提交复检结论' && item.objectId === createdOrder.data.id));

  const invalid = await request(url, '/api/inspections/insp-extra-2/status', {
    method: 'PATCH', body: { status: '已完成' }
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.data.error.code, 'INVALID_TRANSITION');
});

test('公众端只返回脱敏状态且按角色隔离设施', async (t) => {
  const uploadDir = mkdtempSync(join(tmpdir(), 'cityhealth-test-'));
  const db = openDatabase({ filename: ':memory:' });
  db.prepare('INSERT INTO users (id, name, role, role_label, org, expertise) VALUES (?, ?, ?, ?, ?, ?)')
    .run('street-2', '滨水街道测试用户', 'street', '街道管理人员', '滨水街道', '[]');
  const server = createPlatformServer({ db, uploadDir });
  const { url } = await listen(server, 0);
  t.after(async () => {
    await closeServer(server);
    rmSync(uploadDir, { recursive: true, force: true });
  });

  const photoBytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(100_000, 0x41)]);
  const created = await request(url, '/api/public/reports', {
    method: 'POST', user: null,
    body: {
      type: 'crack', description: '外墙发现明显裂缝，希望安排核查。', location: '桂花苑社区1幢南侧',
      communityId: 'community-1', buildingId: 'bld-1-1', contact: '13800000000',
      photoData: `data:image/jpeg;base64,${photoBytes.toString('base64')}`
    }
  });
  assert.equal(created.status, 200);
  assert.match(created.data.code, /^PUB-\d{8}-\d{4}-[A-F0-9]{10}$/);
  const queried = await request(url, `/api/public/reports/${created.data.code}`, { user: null });
  assert.equal(queried.status, 200);
  assert.deepEqual(Object.keys(queried.data).sort(), ['code', 'createdAt', 'feedback', 'status', 'type', 'updatedAt'].sort());
  assert.equal(queried.data.contact, undefined);
  assert.equal(queried.data.location, undefined);
  assert.equal(queried.data.type, '墙体裂缝');

  const invalidContext = await request(url, '/api/public/reports', {
    method: 'POST', user: null,
    body: { type: 'crack', description: '测试建筑社区不匹配的提交。', location: '测试位置', communityId: 'community-1', buildingId: 'bld-3-1' }
  });
  assert.equal(invalidContext.status, 400);
  assert.equal(invalidContext.data.error.code, 'INVALID_BUILDING_CONTEXT');

  const context = await request(url, '/api/public/context', { user: null });
  assert.equal(context.data.buildings.find(item => item.id === 'bld-1-1').communityId, 'community-1');
  const reports = await request(url, '/api/public/reports');
  const createdReport = reports.data.find(item => item.code === created.data.code);
  const handled = await request(url, `/api/public/reports/${createdReport.id}`, {
    method: 'PATCH', user: 'street-1', body: { status: '待专家复核', feedback: '线索已分派核查。' }
  });
  assert.equal(handled.status, 200);
  const reviewing = await request(url, `/api/public/reports/${createdReport.id}`, {
    method: 'PATCH', user: 'street-1', body: { status: '复核中', feedback: '专家正在核查线索。' }
  });
  assert.equal(reviewing.status, 200);
  const crossStreetReport = await request(url, `/api/public/reports/${createdReport.id}`, {
    method: 'PATCH', user: 'street-2', body: { status: '已确认', feedback: '越权处理测试。' }
  });
  assert.equal(crossStreetReport.status, 403);
  const updatedQuery = await request(url, `/api/public/reports/${created.data.code}`, { user: null });
  assert.equal(updatedQuery.data.status, '复核中');
  assert.equal(updatedQuery.data.feedback, '专家正在核查线索。');

  const streetDashboard = await request(url, '/api/dashboard', { user: 'street-1' });
  assert.equal(streetDashboard.data.metrics.facilities, 3);
  assert.equal(streetDashboard.data.metrics.buildings, 6);
  assert.equal(streetDashboard.data.streetStats.length, 1);
  assert.equal(streetDashboard.data.streetStats[0].name, '试点街道');
  const governmentDashboard = await request(url, '/api/dashboard');
  assert.equal(governmentDashboard.data.metrics.facilities, 6);
  assert.equal(governmentDashboard.data.metrics.buildings, 12);

  const facility = await request(url, '/api/facilities/fac-1');
  assert.equal(facility.data.facility.latestGrade, facility.data.facility.riskGrade);
  assert.ok(facility.data.recentInspections.every(item => typeof item.scope === 'string' && typeof item.assignee === 'string'));
  assert.ok(facility.data.workorders.every(item => typeof item.type === 'string' && typeof item.unit === 'string'));

  const streetFacilities = await request(url, '/api/facilities', { user: 'street-1' });
  assert.equal(streetFacilities.data.length, 3);
  assert.ok(streetFacilities.data.every((item) => item.streetName === '试点街道'));
  const crossRegion = await request(url, '/api/facilities/fac-3', { user: 'street-1' });
  assert.equal(crossRegion.status, 403);

  const expertReviews = await request(url, '/api/reviews', { user: 'expert-1' });
  assert.ok(expertReviews.data.every((item) => item.expertId === 'expert-1'));
  const repairOrders = await request(url, '/api/workorders', { user: 'repair-1' });
  assert.ok(repairOrders.data.every((item) => item.unit === '城维工程有限公司'));
  const crossUnit = await request(url, '/api/workorders/wo-3', {
    method: 'PATCH', user: 'repair-1', body: { status: '处理中' }
  });
  assert.equal(crossUnit.status, 403);
  const crossStreetResponse = await request(url, '/api/responses/response-3', {
    method: 'PATCH', user: 'street-1', body: { status: '已响应', action: '跨街道测试' }
  });
  assert.equal(crossStreetResponse.status, 403);
});

test('内部接口认证、审计导出权限及街道/社区查询范围', async (t) => {
  const { db, url } = await testServer(t);
  db.prepare("UPDATE inspections SET status = '待分析' WHERE id = 'insp-extra-1'").run();
  const analyzed = await request(url, '/api/inspections/insp-extra-1/analyze', {
    method: 'POST',
    body: { defectType: 'spall', severity: 95, componentImportance: 'structural', environment: 80 }
  });
  assert.equal(analyzed.status, 200);

  for (const path of [
    '/api/session', '/api/dashboard', '/api/facilities', '/api/inspections', '/api/media',
    '/api/analyses', '/api/detections', '/api/reviews', '/api/responses', '/api/workorders',
    '/api/public/reports', '/api/audit'
  ]) {
    const denied = await request(url, path, { user: null });
    assert.equal(denied.status, 403, `${path} 未要求登录`);
    assert.equal(denied.headers.get('x-content-type-options'), 'nosniff');
  }

  const internalRoles = ['street-1', 'community-1', 'pilot-1', 'expert-1', 'property-1', 'repair-1', 'accept-1'];
  for (const user of internalRoles) {
    assert.equal((await request(url, '/api/audit', { user })).status, 403, `${user} 不应读取审计`);
    assert.equal((await request(url, '/api/export/regulation.csv', { user })).status, 403, `${user} 不应导出监管报表`);
  }
  for (const user of ['gov-1', 'admin-1']) {
    assert.equal((await request(url, '/api/audit', { user })).status, 200);
    assert.equal((await request(url, '/api/export/regulation.csv', { user })).status, 200);
  }

  const expectedStreetFacilities = ['桂花苑小区', '文晖公寓', '云栖公馆'];
  const expectedCommunityFacilities = ['桂花苑小区', '云栖公馆'];
  for (const path of ['/api/media', '/api/analyses']) {
    const streetRows = await request(url, path, { user: 'street-1' });
    assert.equal(streetRows.status, 200);
    assert.deepEqual([...new Set(streetRows.data.map(row => row.facilityName))].sort(), expectedStreetFacilities.sort());
    const communityRows = await request(url, path, { user: 'community-1' });
    assert.equal(communityRows.status, 200);
    assert.deepEqual([...new Set(communityRows.data.map(row => row.facilityName))].sort(), expectedCommunityFacilities.sort());
    for (const user of ['repair-1', 'property-1', 'accept-1']) {
      assert.equal((await request(url, path, { user })).status, 403, `${user} 不应读取 ${path}`);
    }
  }

  const streetReviews = await request(url, '/api/reviews', { user: 'street-1' });
  assert.deepEqual([...new Set(streetReviews.data.map(row => row.facilityName))].sort(), ['文晖公寓', '桂花苑小区'].sort());
  const communityReviews = await request(url, '/api/reviews', { user: 'community-1' });
  assert.deepEqual([...new Set(communityReviews.data.map(row => row.facilityName))], ['桂花苑小区']);

  const crossStreetReview = await request(url, '/api/reviews/review-3', {
    method: 'PATCH', user: 'street-1',
    body: { status: '已完成', conclusion: '越权', opinion: '跨街道复核测试', expertGrade: 'I' }
  });
  assert.equal(crossStreetReview.status, 403);
  assert.equal(db.prepare("SELECT status FROM reviews WHERE id = 'review-3'").get().status, '复核中');
  const inStreetReview = await request(url, `/api/reviews/${analyzed.data.review.id}`, {
    method: 'PATCH', user: 'street-1', body: { status: '待接单' }
  });
  assert.equal(inStreetReview.status, 200);
});

test('公众上报描述、位置和联系方式长度边界', async (t) => {
  const { db, url } = await testServer(t);
  const valid = {
    type: 'crack', description: '描'.repeat(500), location: '位'.repeat(160), contact: '1'.repeat(30)
  };
  const boundary = await request(url, '/api/public/reports', {
    method: 'POST', user: null, body: valid, headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
  assert.equal(boundary.status, 200);
  const before = rowCount(db, 'public_reports');
  for (const [field, maximum] of [['description', 500], ['location', 160], ['contact', 30]]) {
    const rejected = await request(url, '/api/public/reports', {
      method: 'POST', user: null, body: { ...valid, [field]: 'x'.repeat(maximum + 1) }
    });
    assert.equal(rejected.status, 400, `${field} 超过 ${maximum} 应被拒绝`);
    assert.equal(rowCount(db, 'public_reports'), before, `${field} 超限不得落库`);
  }
});

test('公众上报与进度查询使用独立低阈值限流桶', async (t) => {
  const { url } = await testServer(t, {
    server: { rateLimit: { publicReports: 2, publicLookup: 2, windowMs: 60_000 } }
  });
  const body = { type: 'crack', description: '限流测试：外墙发现明显裂缝。', location: '测试社区1幢南侧' };
  const first = await request(url, '/api/public/reports', { method: 'POST', user: null, body });
  const second = await request(url, '/api/public/reports', { method: 'POST', user: null, body });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await request(url, '/api/public/reports', { method: 'POST', user: null, body })).status, 429);

  assert.equal((await request(url, `/api/public/reports/${first.data.code}`, { user: null })).status, 200);
  assert.equal((await request(url, `/api/public/reports/${first.data.code}`, { user: null })).status, 200);
  assert.equal((await request(url, `/api/public/reports/${first.data.code}`, { user: null })).status, 429);
});

test('公众照片落盘且进度查询不读取 photo_data', async (t) => {
  const { db, url, uploadDir } = await testServer(t);
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
  const photoData = `data:image/png;base64,${bytes.toString('base64')}`;
  const created = await request(url, '/api/public/reports', {
    method: 'POST', user: null,
    body: { type: 'crack', description: '照片落盘测试：外墙发现明显裂缝。', location: '测试位置', photoData }
  });
  assert.equal(created.status, 200);
  const row = db.prepare('SELECT photo_data, photo_path FROM public_reports WHERE code = ?').get(created.data.code);
  assert.equal(row.photo_data, null, '新照片不得写入 SQLite');
  assert.equal(typeof row.photo_path, 'string');
  assert.ok(row.photo_path.length > 0);
  assert.equal(isAbsolute(row.photo_path), false, 'photo_path 必须为相对路径');
  assert.equal(row.photo_path.split(/[\\/]/).includes('..'), false, 'photo_path 不得路径穿越');
  assert.deepEqual(readFileSync(join(uploadDir, row.photo_path)), bytes);

  db.setAuthorizer((action, table, column) => {
    if (action === sqliteConstants.SQLITE_READ && table === 'public_reports' && column === 'photo_data') {
      return sqliteConstants.SQLITE_DENY;
    }
    return sqliteConstants.SQLITE_OK;
  });
  let queried;
  try {
    queried = await request(url, `/api/public/reports/${created.data.code}`, { user: null });
  } finally {
    db.setAuthorizer(null);
  }
  assert.equal(queried.status, 200, '公开查询不得读取 photo_data');
  assert.deepEqual(Object.keys(queried.data).sort(), ['code', 'createdAt', 'feedback', 'status', 'type', 'updatedAt'].sort());
});

test('工单创建在审计触发器失败时完整回滚', async (t) => {
  const { db, url } = await testServer(t);
  db.exec(`
    CREATE TRIGGER fail_workorder_audit BEFORE INSERT ON audit_logs
    WHEN NEW.action = '创建治理工单'
    BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END
  `);
  const before = {
    workorders: rowCount(db, 'workorders'),
    events: rowCount(db, 'workorder_events'),
    audits: rowCount(db, 'audit_logs')
  };
  const failed = await request(url, '/api/workorders', {
    method: 'POST',
    body: {
      assessmentId: 'assessment-1', unit: '城维工程有限公司', owner: '李维修',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(), requirement: '事务回滚测试工单'
    }
  });
  assert.ok(failed.status >= 500, '故障注入应使请求失败');
  assert.equal(rowCount(db, 'workorders'), before.workorders);
  assert.equal(rowCount(db, 'workorder_events'), before.events);
  assert.equal(rowCount(db, 'audit_logs'), before.audits);
});

test('专家降级仅取消待响应任务且保留审计，已响应任务不被静默取消', async (t) => {
  const { db, url } = await testServer(t);
  const pendingBefore = db.prepare("SELECT responded_at FROM responses WHERE id = 'response-3'").get();
  const downgraded = await request(url, '/api/reviews/review-3', {
    method: 'PATCH', user: 'expert-1',
    body: { status: '已完成', conclusion: '修正', opinion: '现场复核确认低风险，降为II级。', expertGrade: 'II' }
  });
  assert.equal(downgraded.status, 200);
  const pendingAfter = db.prepare("SELECT status, responded_at FROM responses WHERE id = 'response-3'").get();
  assert.equal(pendingAfter.status, '已取消');
  assert.equal(pendingAfter.responded_at, pendingBefore.responded_at);
  assert.ok(db.prepare("SELECT id FROM audit_logs WHERE object_type = 'response' AND object_id = 'response-3'").get(), '取消响应必须写审计');

  db.prepare("UPDATE reviews SET status = '复核中', completed_at = NULL, expert_grade = NULL WHERE id = 'review-2'").run();
  db.prepare("UPDATE assessments SET expert_grade = NULL, status = '待复核' WHERE id = 'assessment-2'").run();
  const respondedBefore = db.prepare("SELECT status, responded_at, action FROM responses WHERE id = 'response-2'").get();
  const secondDowngrade = await request(url, '/api/reviews/review-2', {
    method: 'PATCH', user: 'expert-1',
    body: { status: '已完成', conclusion: '修正', opinion: '补充复核后降为I级。', expertGrade: 'I' }
  });
  assert.equal(secondDowngrade.status, 200);
  const respondedAfter = db.prepare("SELECT status, responded_at, action FROM responses WHERE id = 'response-2'").get();
  assert.deepEqual(respondedAfter, respondedBefore, '已响应任务不得因降级被取消或改写响应记录');
});

test('检测修正后可重新评估，已进入治理流程的记录保持锁定', async (t) => {
  const { db, url } = await testServer(t);
  const analyzed = await request(url, '/api/inspections/insp-extra-3/analyze', {
    method: 'POST',
    body: { defectType: 'spall', severity: 95, componentImportance: 'structural', environment: 80 }
  });
  assert.equal(analyzed.status, 200);
  const detectionId = analyzed.data.detection.id;
  const assessmentId = analyzed.data.assessment.id;
  const originalReviewId = analyzed.data.review.id;
  const invalid = await request(url, `/api/detections/${detectionId}/review`, {
    method: 'POST', user: 'expert-1', body: { status: '修正', defectType: 'not-a-defect', note: '无效类型测试' }
  });
  assert.equal(invalid.status, 400);
  assert.equal(db.prepare('SELECT type FROM detections WHERE id = ?').get(detectionId).type, 'spall');

  const corrected = await request(url, `/api/detections/${detectionId}/review`, {
    method: 'POST', user: 'expert-1', body: { status: '修正', defectType: 'crack', note: '现场确认墙体裂缝' }
  });
  assert.equal(corrected.status, 200);
  assert.equal(db.prepare('SELECT status FROM assessments WHERE id = ?').get(assessmentId).status, '待重新评估');
  const reassessed = await request(url, '/api/assessments', {
    method: 'POST', body: { detectionId, componentImportance: 'structural', environment: 80 }
  });
  assert.equal(reassessed.status, 200);
  assert.equal(reassessed.data.assessment.id, assessmentId, '重新评估应保留评估ID和关联关系');
  assert.equal(reassessed.data.assessment.defectType, 'crack');
  assert.equal(reassessed.data.assessment.status, '待复核');
  assert.notEqual(reassessed.data.review.id, originalReviewId, '重新评估应替换尚未处理的复核任务');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assessments WHERE detection_id = ?').get(detectionId).count, 1);
  assert.ok(db.prepare("SELECT id FROM audit_logs WHERE action = '重新生成健康评估' AND object_id = ?").get(assessmentId));

  const lockedStatusBefore = db.prepare("SELECT status FROM assessments WHERE id = 'assessment-1'").get().status;
  const locked = await request(url, '/api/detections/det-1/review', {
    method: 'POST', body: { status: '修正', defectType: 'spall', note: '不得改写已闭环评估' }
  });
  assert.equal(locked.status, 409);
  assert.equal(locked.data.error.code, 'ASSESSMENT_LOCKED');
  assert.equal(db.prepare("SELECT type FROM detections WHERE id = 'det-1'").get().type, 'crack');
  assert.equal(db.prepare("SELECT status FROM assessments WHERE id = 'assessment-1'").get().status, lockedStatusBefore);
});

test('HTML CSP、JSON/CSV nosniff 与 CSV 公式注入防护', async (t) => {
  const { db, url } = await testServer(t);
  for (const path of ['/admin/', '/citizen/']) {
    const response = await fetch(`${url}${path}`);
    assert.equal(response.status, 200);
    const csp = response.headers.get('content-security-policy');
    assert.ok(csp && /default-src/i.test(csp), `${path} 缺少 Content-Security-Policy`);
    await response.text();
  }
  const jsonResponse = await request(url, '/api/health', { user: null });
  assert.equal(jsonResponse.headers.get('x-content-type-options'), 'nosniff');
  const jsonError = await request(url, '/api/facilities', { user: null });
  assert.equal(jsonError.headers.get('x-content-type-options'), 'nosniff');

  db.prepare("UPDATE facilities SET name = '=1+1' WHERE id = 'fac-1'").run();
  db.prepare("UPDATE regions SET name = '+1' WHERE id = 'street-1'").run();
  db.prepare("UPDATE regions SET name = '-1' WHERE id = 'community-1'").run();
  db.prepare("UPDATE detections SET type = '@SUM(1)' WHERE id = 'det-1'").run();
  db.prepare("UPDATE responses SET status = ? WHERE id = 'response-2'").run('\tTAB');
  db.prepare("UPDATE workorders SET order_no = ? WHERE id = 'wo-1'").run('\rCR');
  const exported = await request(url, '/api/export/regulation.csv');
  assert.equal(exported.status, 200);
  assert.match(exported.headers.get('content-type'), /^text\/csv/i);
  assert.equal(exported.headers.get('x-content-type-options'), 'nosniff');
  const cells = parseCsv(exported.text).flat();
  for (const value of ['=1+1', '+1', '-1', '@SUM(1)', '\tTAB', '\rCR']) {
    assert.ok(cells.includes(`'${value}`), `CSV 危险单元格未前置单引号：${JSON.stringify(value)}`);
  }
});

test('HTTP 边界：415、空 JSON 体、非法百分号与 SQLite UNIQUE 冲突', async (t) => {
  const { db, url } = await testServer(t);
  const unsupported = await request(url, '/api/public/reports', {
    method: 'POST', user: null, rawBody: '{"type":"crack"}', headers: { 'Content-Type': 'text/plain' }
  });
  assert.equal(unsupported.status, 415);
  const unsupportedPatch = await request(url, '/api/responses/response-3', {
    method: 'PATCH', rawBody: '{"status":"已响应"}', headers: { 'Content-Type': 'text/plain' }
  });
  assert.equal(unsupportedPatch.status, 415, '非 JSON 写请求应统一返回415');
  const emptyTextBody = await request(url, '/api/public/reports', {
    method: 'POST', user: null, rawBody: '', headers: { 'Content-Type': 'text/plain' }
  });
  assert.equal(emptyTextBody.status, 400, '空文本体应进入参数校验而不是 415');
  const malformedJson = await request(url, '/api/public/reports', {
    method: 'POST', user: null, rawBody: '{', headers: { 'Content-Type': 'application/json' }
  });
  assert.equal(malformedJson.status, 400);
  for (const path of ['/api/facilities/%E0%A4%A', '/api/public/reports/%']) {
    assert.equal((await request(url, path, { user: path.startsWith('/api/public/') ? null : 'gov-1' })).status, 400, `${path} 应返回400`);
  }

  db.exec('CREATE UNIQUE INDEX test_workorders_requirement ON workorders(requirement)');
  const duplicateRequirement = db.prepare("SELECT requirement FROM workorders WHERE id = 'wo-1'").get().requirement;
  const before = rowCount(db, 'workorders');
  const conflict = await request(url, '/api/workorders', {
    method: 'POST',
    body: {
      assessmentId: 'assessment-1', unit: '城维工程有限公司', owner: '李维修',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(), requirement: duplicateRequirement
    }
  });
  assert.equal(conflict.status, 409, 'SQLite UNIQUE 冲突必须映射为409');
  assert.equal(rowCount(db, 'workorders'), before);
});

test('旧对象 reasons 对外兼容为数组且保留原因内容', async (t) => {
  const { db, url } = await testServer(t);
  db.prepare("DELETE FROM assessments WHERE id = 'assessment-6'").run();
  db.exec(`
    CREATE TRIGGER legacy_assessment_reasons AFTER INSERT ON assessments
    BEGIN
      UPDATE assessments SET reasons = '{"历史原因":"旧版对象原因"}' WHERE id = NEW.id;
    END
  `);
  const created = await request(url, '/api/assessments', {
    method: 'POST', body: { detectionId: 'det-6' }
  });
  assert.equal(created.status, 200);
  assert.ok(Array.isArray(created.data.assessment.reasons), '旧对象 reasons 必须转换为数组');
  assert.match(JSON.stringify(created.data.assessment.reasons), /旧版对象原因/);
});

test('工单列表按当前用户处置单位隔离且不产生缺失字段', async (t) => {
  const { db, url } = await testServer(t);
  db.prepare('INSERT INTO users (id, name, role, role_label, org, expertise) VALUES (?, ?, ?, ?, ?, ?)')
    .run('repair-2', '其他维修测试', 'repair', '维修施工单位', '其他施工单位', '[]');
  const created = await request(url, '/api/workorders', {
    method: 'POST',
    body: {
      assessmentId: 'assessment-1', unit: '其他施工单位', owner: '其他维修测试',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(), requirement: '处置单位范围测试工单'
    }
  });
  assert.equal(created.status, 200);

  const repairRows = await request(url, '/api/workorders', { user: 'repair-1' });
  assert.ok(repairRows.data.length > 0);
  assert.ok(repairRows.data.every(item => item.unit === '城维工程有限公司'));
  assert.ok(repairRows.data.every(item => typeof item.facilityName === 'string' && typeof item.buildingName === 'string'));
  assert.doesNotMatch(JSON.stringify(repairRows.data), /undefined|NaN/);

  const otherRepairRows = await request(url, '/api/workorders', { user: 'repair-2' });
  assert.deepEqual(otherRepairRows.data.map(item => item.id), [created.data.id]);
  const propertyRows = await request(url, '/api/workorders', { user: 'property-1' });
  assert.ok(propertyRows.data.every(item => item.unit === '桂花苑物业服务中心'));
});

test('演示角色切换返回统一会话字段', async (t) => {
  const { url } = await testServer(t);
  const switched = await request(url, '/api/session', { method: 'PUT', user: null, body: { userId: 'repair-1' } });
  assert.equal(switched.status, 200);
  assert.equal(switched.data.id, 'repair-1');
  assert.equal(switched.data.role, 'repair');
  assert.equal(switched.data.roleLabel, '维修施工单位');
  assert.equal(switched.data.org, '城维工程有限公司');
  assert.equal(switched.data.role_label, undefined);
  assert.doesNotMatch(JSON.stringify(switched.data), /undefined|NaN/);
});

test('数据库忙碌超时与关键查询索引存在', (t) => {
  const db = openDatabase({ filename: ':memory:', seed: false });
  t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 2000);
  const requiredIndexes = [
    ['detections', ['facility_id']],
    ['workorder_events', ['workorder_id', 'created_at']],
    ['media', ['inspection_id']],
    ['analyses', ['inspection_id']],
    ['public_reports', ['community_id']],
    ['inspections', ['status', 'updated_at']]
  ];
  for (const [table, requiredColumns] of requiredIndexes) {
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table);
    const found = indexes.some(index => {
      const escapedName = index.name.replaceAll('"', '""');
      const columns = db.prepare(`PRAGMA index_info("${escapedName}")`).all().map(row => row.name);
      return requiredColumns.every((column, position) => columns[position] === column);
    });
    assert.ok(found, `${table} 缺少索引(${requiredColumns.join(', ')})`);
  }
});
