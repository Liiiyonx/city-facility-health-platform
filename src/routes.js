import { randomBytes, randomUUID } from 'node:crypto';
import { accessSync, constants, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFECT_LABELS,
  GRADE_LABELS,
  assertTransition,
  calculateResponseHours,
  clamp,
  evaluateHealth,
  gradeRank,
  isResponseCompliant
} from './domain.js';
import { parseJson as parseJsonValue } from './db.js';

const now = () => new Date().toISOString();
const id = () => randomUUID();

function json(response, status, data, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    ...headers
  });
  response.end(JSON.stringify(data));
}

function errorResponse(response, error) {
  if (/UNIQUE constraint failed/i.test(error.message || '')) {
    error.status = 409;
    error.code = 'CONFLICT';
    error.message = '数据已存在或发生并发冲突，请刷新后重试';
  } else if (/FOREIGN KEY constraint failed/i.test(error.message || '')) {
    error.status = 400;
    error.code = 'INVALID_REFERENCE';
    error.message = '关联数据不存在，请刷新后重试';
  } else if (/SQLITE_BUSY|database is locked/i.test(error.message || '')) {
    error.status = 503;
    error.code = 'DATABASE_BUSY';
    error.message = '数据库暂时繁忙，请稍后重试';
  }
  const status = error.status || 500;
  const code = error.code || 'INTERNAL_ERROR';
  const message = status === 500 ? '服务内部错误，请查看本地日志。' : error.message;
  json(response, status, { error: { code, message } });
}

function badRequest(message, code = 'VALIDATION_ERROR') {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
}

function notFound(message = '对象不存在') {
  const error = new Error(message);
  error.code = 'NOT_FOUND';
  error.status = 404;
  return error;
}

function payloadTooLarge(message) {
  const error = new Error(message);
  error.code = 'PAYLOAD_TOO_LARGE';
  error.status = 413;
  return error;
}

function forbidden(message = '当前演示角色无权执行此操作') {
  const error = new Error(message);
  error.code = 'FORBIDDEN';
  error.status = 403;
  return error;
}

function conflict(message, code = 'CONFLICT') {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  return error;
}

function normalizeDefectType(value) {
  if (DEFECT_LABELS[value]) return value;
  return Object.entries(DEFECT_LABELS).find(([, label]) => label === value)?.[0] ?? null;
}

function requireFields(body, fields) {
  for (const field of fields) {
    if (body[field] === undefined || body[field] === null || body[field] === '') {
      throw badRequest(`缺少必填字段：${field}`);
    }
  }
}

function validateFields(body, schema) {
  const result = { ...body };
  for (const [field, rules] of Object.entries(schema)) {
    const value = body[field];
    if (value === undefined || value === null || value === '') {
      if (rules.required) throw badRequest(`缺少必填字段：${field}`);
      continue;
    }
    if (rules.type === 'string') {
      if (typeof value !== 'string') throw badRequest(`字段 ${field} 必须为文本`);
      const text = value.trim();
      if (rules.min !== undefined && text.length < rules.min) throw badRequest(`字段 ${field} 至少需要 ${rules.min} 个字符`);
      if (rules.max !== undefined && text.length > rules.max) throw badRequest(`字段 ${field} 不能超过 ${rules.max} 个字符`);
      result[field] = text;
    } else if (rules.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw badRequest(`字段 ${field} 必须为有效数字`);
      if (rules.min !== undefined && value < rules.min) throw badRequest(`字段 ${field} 不能小于 ${rules.min}`);
      if (rules.max !== undefined && value > rules.max) throw badRequest(`字段 ${field} 不能大于 ${rules.max}`);
    } else if (rules.type === 'date') {
      if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw badRequest(`字段 ${field} 必须为有效时间`);
    }
  }
  return result;
}

function inTransaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* preserve the original failure */ }
    throw error;
  }
}

function documentNumber(prefix, timestamp = now()) {
  return `${prefix}-${timestamp.slice(0, 10).replaceAll('-', '')}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

function facilityScope(user, alias = 'f') {
  if (user.role === 'street') return { sql: `${alias}.street_id = ?`, params: [user.id] };
  if (user.role === 'community') return { sql: `${alias}.community_id = ?`, params: [user.id] };
  return { sql: '', params: [] };
}

function getUser(db, request) {
  const userId = request.headers['x-user-id'];
  if (!userId) return null;
  return db.prepare('SELECT id, name, role, role_label AS roleLabel, org, expertise FROM users WHERE id = ?').get(userId) ?? null;
}

function requireUser(db, request) {
  const user = request.user || getUser(db, request);
  if (!user) throw forbidden('请先选择演示角色');
  if (user.role === 'public') throw forbidden('公众端不能访问内部管理接口');
  return user;
}

function requireRoles(user, roles) {
  if (!roles.includes(user.role) && user.role !== 'admin') throw forbidden();
}

function assertFacilityScope(db, user, facilityId) {
  if (!['street', 'community'].includes(user.role)) return;
  const facility = db.prepare('SELECT street_id, community_id FROM facilities WHERE id = ?').get(facilityId);
  if (!facility) throw notFound('设施不存在');
  if (user.role === 'street' && facility.street_id !== user.id) throw forbidden('无权操作其他街道设施');
  if (user.role === 'community' && facility.community_id !== user.id) throw forbidden('无权操作其他社区设施');
}

function audit(db, user, action, objectType, objectId, summary, beforeValue = null, afterValue = null) {
  db.prepare(`
    INSERT INTO audit_logs (id, user_id, action, object_type, object_id, before_json, after_json, summary, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id(), user.id, action, objectType, objectId,
    beforeValue === null ? null : JSON.stringify(beforeValue),
    afterValue === null ? null : JSON.stringify(afterValue),
    summary, now()
  );
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    roleLabel: user.roleLabel,
    org: user.org,
    expertise: parseJsonValue(user.expertise, [])
  };
}

function facilityRow(db, facilityId) {
  return db.prepare(`
    SELECT f.*, s.name AS streetName, c.name AS communityName
    FROM facilities f
    JOIN regions s ON s.id = f.street_id
    JOIN regions c ON c.id = f.community_id
    WHERE f.id = ?
  `).get(facilityId);
}

function assessmentById(db, assessmentId) {
  return db.prepare('SELECT * FROM assessments WHERE id = ?').get(assessmentId);
}

function assessmentReasons(value) {
  const parsed = parseJsonValue(value, []);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    return Object.values(parsed).map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item.reason === 'string') return item.reason;
      return JSON.stringify(item);
    });
  }
  return parsed ? [String(parsed)] : [];
}

function serializeAssessment(row) {
  if (!row) return null;
  return {
    id: row.id,
    detectionId: row.detection_id,
    defectType: row.defect_type,
    dimensions: parseJsonValue(row.dimensions, {}),
    totalScore: row.total_score,
    aiGrade: row.ai_grade,
    expertGrade: row.expert_grade,
    status: row.status,
    ruleVersion: row.rule_version,
    reasons: assessmentReasons(row.reasons),
    recommendation: row.recommendation,
    disclaimer: row.disclaimer,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function detectionById(db, detectionId) {
  return db.prepare('SELECT * FROM detections WHERE id = ?').get(detectionId);
}

function serializeDetection(row) {
  return {
    id: row.id,
    analysisId: row.analysis_id,
    facilityId: row.facility_id,
    buildingId: row.building_id,
    componentId: row.component_id,
    type: row.type,
    subtype: row.subtype,
    confidence: row.confidence,
    bbox: parseJsonValue(row.bbox, {}),
    geometry: parseJsonValue(row.geometry, {}),
    modelVersion: row.model_version,
    reviewStatus: row.review_status,
    createdAt: row.created_at
  };
}

function syncResponseWithAssessment(db, assessment, user) {
  const grade = assessment.expert_grade || assessment.ai_grade;
  const existing = db.prepare('SELECT * FROM responses WHERE assessment_id = ?').get(assessment.id);
  const timestamp = now();
  if (gradeRank(grade) < 3) {
    if (!existing || existing.status !== '待响应') return existing || null;
    db.prepare('UPDATE responses SET status = ?, updated_at = ? WHERE id = ?').run('已取消', timestamp, existing.id);
    audit(db, user, '专家复核降级取消政府响应', 'response', existing.id,
      `专家复核降为${GRADE_LABELS[grade]}，取消尚未响应的任务`, { status: existing.status }, { status: '已取消' });
    return { ...existing, status: '已取消', updated_at: timestamp };
  }
  if (existing) {
    if (existing.status === '已取消') {
      db.prepare('UPDATE responses SET grade = ?, status = ?, due_at = ?, updated_at = ? WHERE id = ?').run(
        grade, '待响应', new Date(Date.now() + 72 * 3_600_000).toISOString(), timestamp, existing.id
      );
      audit(db, user, '专家复核升级恢复政府响应', 'response', existing.id,
        `专家复核调整为${GRADE_LABELS[grade]}，重新进入政府响应流程`,
        { status: existing.status, grade: existing.grade }, { status: '待响应', grade });
    } else if (existing.grade !== grade) {
      db.prepare('UPDATE responses SET grade = ?, updated_at = ? WHERE id = ?').run(grade, timestamp, existing.id);
    }
    return { ...existing, grade };
  }
  const responseId = id();
  db.prepare(`
    INSERT INTO responses (id, assessment_id, grade, department, owner, due_at, status, received_at, responded_at, action, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '待响应', ?, NULL, NULL, ?, ?)
  `).run(
    responseId, assessment.id, grade, '试点街道城市建设办公室', '待分派',
    new Date(Date.now() + 72 * 3_600_000).toISOString(), timestamp, timestamp, timestamp
  );
  audit(db, user, '生成政府响应任务', 'response', responseId, `${GRADE_LABELS[grade]}进入政府响应流程`);
  return { id: responseId };
}

function refreshFacilityGrade(db, facilityId) {
  const rows = db.prepare(`
    SELECT a.ai_grade AS aiGrade, a.expert_grade AS expertGrade
    FROM assessments a JOIN detections d ON d.id = a.detection_id WHERE d.facility_id = ?
  `).all(facilityId);
  let grade = 'I';
  for (const row of rows) {
    for (const candidate of [row.aiGrade, row.expertGrade]) {
      if (candidate && gradeRank(candidate) > gradeRank(grade)) grade = candidate;
    }
  }
  db.prepare('UPDATE facilities SET risk_grade = ?, updated_at = ? WHERE id = ?').run(grade, now(), facilityId);
}

function createReviewIfNeeded(db, assessment, detection, user) {
  const grade = assessment.ai_grade;
  if (gradeRank(grade) < 3) return null;
  const existing = db.prepare('SELECT id FROM reviews WHERE assessment_id = ?').get(assessment.id);
  if (existing) return existing;
  const timestamp = now();
  const reviewId = id();
  const expertId = detection.type === 'leak' ? 'expert-2' : 'expert-1';
  db.prepare(`
    INSERT INTO reviews (id, assessment_id, detection_id, expert_id, status, due_at, assigned_at)
    VALUES (?, ?, ?, ?, '待分配', ?, ?)
  `).run(reviewId, assessment.id, detection.id, expertId, new Date(Date.now() + 24 * 3_600_000).toISOString(), timestamp);
  audit(db, user, '生成专家复核任务', 'review', reviewId, `${GRADE_LABELS[grade]}自动进入专家复核队列`);
  return { id: reviewId };
}

function assertReassessmentAllowed(db, assessmentId) {
  if (db.prepare('SELECT id FROM responses WHERE assessment_id = ?').get(assessmentId)) {
    throw conflict('该评估已进入政府响应流程，不能重新评估', 'ASSESSMENT_LOCKED');
  }
  if (db.prepare('SELECT id FROM workorders WHERE assessment_id = ?').get(assessmentId)) {
    throw conflict('该评估已关联治理工单，不能重新评估', 'ASSESSMENT_LOCKED');
  }
  const review = db.prepare('SELECT status FROM reviews WHERE assessment_id = ?').get(assessmentId);
  if (review && !['待分配', '待接单', '退回补充', '超时'].includes(review.status)) {
    throw conflict('专家已开始或完成复核，不能重新评估', 'ASSESSMENT_LOCKED');
  }
}

function insertAssessment(db, detection, input, user) {
  const existing = db.prepare('SELECT * FROM assessments WHERE detection_id = ?').get(detection.id);
  if (existing && existing.status !== '待重新评估') throw badRequest('该检测结果已存在健康评估', 'DUPLICATE_ASSESSMENT');
  if (existing) assertReassessmentAllowed(db, existing.id);
  const evaluation = evaluateHealth(input);
  const timestamp = now();
  const assessmentId = existing?.id || id();
  if (existing) {
    db.prepare('DELETE FROM reviews WHERE assessment_id = ?').run(existing.id);
    db.prepare(`
      UPDATE assessments SET defect_type = ?, dimensions = ?, total_score = ?, ai_grade = ?,
        expert_grade = NULL, status = '待复核', rule_version = ?, reasons = ?, recommendation = ?,
        disclaimer = ?, updated_at = ? WHERE id = ?
    `).run(
      evaluation.defectType, JSON.stringify(evaluation.dimensions), evaluation.totalScore,
      evaluation.aiGrade, evaluation.ruleVersion, JSON.stringify(evaluation.reasons),
      evaluation.recommendation, evaluation.disclaimer, timestamp, existing.id
    );
  } else {
    db.prepare(`
      INSERT INTO assessments (
        id, detection_id, defect_type, dimensions, total_score, ai_grade, expert_grade,
        status, rule_version, reasons, recommendation, disclaimer, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      assessmentId, detection.id, evaluation.defectType, JSON.stringify(evaluation.dimensions),
      evaluation.totalScore, evaluation.aiGrade, '待复核', evaluation.ruleVersion,
      JSON.stringify(evaluation.reasons), evaluation.recommendation, evaluation.disclaimer,
      timestamp, timestamp
    );
  }
  const assessment = assessmentById(db, assessmentId);
  refreshFacilityGrade(db, detection.facility_id);
  const review = createReviewIfNeeded(db, assessment, detection, user);
  audit(db, user, existing ? '重新生成健康评估' : '生成健康评估', 'assessment', assessmentId,
    `AI建议${GRADE_LABELS[evaluation.aiGrade]}，得分${evaluation.totalScore}`,
    existing ? { status: existing.status, aiGrade: existing.ai_grade, totalScore: existing.total_score } : null,
    { status: assessment.status, aiGrade: assessment.ai_grade, totalScore: assessment.total_score });
  return { assessment: serializeAssessment(assessment), review };
}

function dashboard(db, user) {
  const scope = facilityScope(user);
  const scopedWhere = scope.sql ? `WHERE ${scope.sql}` : '';
  const one = (sql, params = []) => db.prepare(sql).get(...params);
  const facilityCount = one(`SELECT COUNT(*) AS value FROM facilities f ${scopedWhere}`, scope.params).value;
  const buildingCount = one(`
    SELECT COUNT(*) AS value FROM buildings b JOIN facilities f ON f.id = b.facility_id ${scopedWhere}
  `, scope.params).value;
  const inspectionCount = one(`
    SELECT COUNT(*) AS value FROM inspections i JOIN facilities f ON f.id = i.facility_id ${scopedWhere}
  `, scope.params).value;
  const highRisk = one(`
    SELECT COUNT(*) AS value FROM facilities f ${scope.sql ? `WHERE f.risk_grade IN ('III', 'IV') AND ${scope.sql}` : "WHERE f.risk_grade IN ('III', 'IV')"}
  `, scope.params).value;
  const pendingReviews = one(`
    SELECT COUNT(*) AS value FROM reviews r
    JOIN assessments a ON a.id = r.assessment_id
    JOIN detections d ON d.id = a.detection_id
    JOIN facilities f ON f.id = d.facility_id
    ${scope.sql ? `WHERE r.status IN ('待分配', '待接单', '复核中', '退回补充', '超时') AND ${scope.sql}` : "WHERE r.status IN ('待分配', '待接单', '复核中', '退回补充', '超时')"}
  `, scope.params).value;
  const activeWorkorders = one(`
    SELECT COUNT(*) AS value FROM workorders w JOIN facilities f ON f.id = w.facility_id
    ${scope.sql ? `WHERE w.status NOT IN ('已销号', '已取消') AND ${scope.sql}` : "WHERE w.status NOT IN ('已销号', '已取消')"}
  `, scope.params).value;
  const publicReports = one(`
    SELECT COUNT(DISTINCT p.id) AS value FROM public_reports p
    JOIN facilities f ON f.community_id = p.community_id ${scopedWhere}
  `, scope.params).value;
  const orderTotal = one(`
    SELECT COUNT(*) AS value FROM workorders w JOIN facilities f ON f.id = w.facility_id ${scopedWhere}
  `, scope.params).value;
  const orderClosed = one(`
    SELECT COUNT(*) AS value FROM workorders w JOIN facilities f ON f.id = w.facility_id
    ${scope.sql ? `WHERE w.status = '已销号' AND ${scope.sql}` : "WHERE w.status = '已销号'"}
  `, scope.params).value;

  const responseRows = db.prepare(`
    SELECT r.received_at AS receivedAt, r.responded_at AS respondedAt
    FROM responses r
    JOIN assessments a ON a.id = r.assessment_id
    JOIN detections d ON d.id = a.detection_id
    JOIN facilities f ON f.id = d.facility_id
    WHERE r.responded_at IS NOT NULL AND r.grade IN ('III', 'IV') ${scope.sql ? `AND ${scope.sql}` : ''}
  `).all(...scope.params);
  const responseHours = responseRows
    .map((row) => calculateResponseHours(row.receivedAt, row.respondedAt))
    .filter((value) => value !== null);
  const avgResponseHours = responseHours.length
    ? Number((responseHours.reduce((sum, value) => sum + value, 0) / responseHours.length).toFixed(1))
    : 0;
  const responseCompliance = responseHours.length
    ? Math.round((responseHours.filter(isResponseCompliant).length / responseHours.length) * 100)
    : 100;

  const gradeCounts = new Map(db.prepare(`
    SELECT f.risk_grade AS grade, COUNT(*) AS count FROM facilities f
    ${scopedWhere} GROUP BY f.risk_grade
  `).all(...scope.params).map((row) => [row.grade, row.count]));
  const gradeDistribution = ['I', 'II', 'III', 'IV'].map((grade) => ({
    grade, count: gradeCounts.get(grade) || 0
  }));
  const statusDistribution = db.prepare(`
    SELECT i.status, COUNT(*) AS count FROM inspections i JOIN facilities f ON f.id = i.facility_id
    ${scopedWhere} GROUP BY i.status ORDER BY count DESC
  `).all(...scope.params);
  const recentAlerts = db.prepare(`
    SELECT a.id, d.facility_id AS facilityId, f.name AS facilityName, d.type, a.ai_grade AS grade, a.status, a.created_at AS createdAt
    FROM assessments a
    JOIN detections d ON d.id = a.detection_id
    JOIN facilities f ON f.id = d.facility_id
    WHERE (a.ai_grade IN ('III', 'IV') OR a.expert_grade IN ('III', 'IV')) ${scope.sql ? `AND ${scope.sql}` : ''}
    ORDER BY a.created_at DESC LIMIT 6
  `).all(...scope.params).map((row) => ({ ...row, type: DEFECT_LABELS[row.type] || row.type }));

  const streetScope = user.role === 'street'
    ? { sql: 'AND s.id = ?', params: [user.id] }
    : user.role === 'community'
      ? { sql: 'AND f.community_id = ?', params: [user.id] }
      : { sql: '', params: [] };
  const streetStats = db.prepare(`
    SELECT s.name,
      COUNT(DISTINCT f.id) AS facilities,
      COUNT(DISTINCT CASE WHEN f.risk_grade IN ('III', 'IV') THEN f.id END) AS highRisk,
      COUNT(DISTINCT CASE WHEN w.status NOT IN ('已销号', '已取消') THEN w.id END) AS openOrders
    FROM regions s
    LEFT JOIN facilities f ON f.street_id = s.id
    LEFT JOIN workorders w ON w.facility_id = f.id
    WHERE s.level = 'street' ${streetScope.sql}
    GROUP BY s.id, s.name ORDER BY s.name
  `).all(...streetScope.params);

  const trendEnd = new Date();
  trendEnd.setUTCHours(0, 0, 0, 0);
  trendEnd.setUTCDate(trendEnd.getUTCDate() + 1);
  const trendStart = new Date(trendEnd);
  trendStart.setUTCDate(trendStart.getUTCDate() - 7);
  const trendRows = db.prepare(`
    SELECT substr(i.updated_at, 1, 10) AS date, COUNT(*) AS count
    FROM inspections i JOIN facilities f ON f.id = i.facility_id
    WHERE i.status = '已完成' AND i.updated_at >= ? AND i.updated_at < ? ${scope.sql ? `AND ${scope.sql}` : ''}
    GROUP BY substr(i.updated_at, 1, 10)
  `).all(trendStart.toISOString(), trendEnd.toISOString(), ...scope.params);
  const trendCounts = new Map(trendRows.map((row) => [row.date, row.count]));
  const inspectionTrend = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const date = new Date(trendStart);
    date.setUTCDate(date.getUTCDate() + offset);
    const key = date.toISOString().slice(0, 10);
    inspectionTrend.push({ date: key.slice(5), count: trendCounts.get(key) || 0 });
  }

  return {
    metrics: {
      facilities: facilityCount,
      buildings: buildingCount,
      inspections: inspectionCount,
      highRisk,
      pendingReviews,
      activeWorkorders,
      publicReports,
      closureRate: orderTotal ? Math.round((orderClosed / orderTotal) * 100) : 0,
      avgResponseHours,
      responseCompliance
    },
    gradeDistribution,
    statusDistribution,
    recentAlerts,
    streetStats,
    inspectionTrend,
    updatedAt: now()
  };
}

function facilityList(db, user) {
  let where = '';
  const params = [];
  if (user.role === 'street') {
    where = ' WHERE f.street_id = ?';
    params.push(user.id);
  } else if (user.role === 'community') {
    where = ' WHERE f.community_id = ?';
    params.push(user.id);
  }
  return db.prepare(`
    SELECT f.id, f.name, f.category, f.address, s.name AS streetName, c.name AS communityName,
      f.manager, f.built_year AS builtYear, f.structure, f.longitude, f.latitude,
      f.risk_grade AS riskGrade, COUNT(b.id) AS buildingCount
    FROM facilities f
    JOIN regions s ON s.id = f.street_id
    JOIN regions c ON c.id = f.community_id
    LEFT JOIN buildings b ON b.facility_id = f.id
    ${where}
    GROUP BY f.id ORDER BY f.created_at DESC
  `).all(...params).map((row) => ({ ...row, latestGrade: row.riskGrade }));
}

function inspectionList(db, status, user) {
  const conditions = [];
  const params = [];
  if (status) {
    conditions.push('i.status = ?');
    params.push(status);
  }
  if (user.role === 'street') {
    conditions.push('f.street_id = ?');
    params.push(user.id);
  } else if (user.role === 'community') {
    conditions.push('f.community_id = ?');
    params.push(user.id);
  }
  const rows = db.prepare(`
    SELECT i.*, f.name AS facilityName, b.name AS buildingName, c.name AS componentName
    FROM inspections i
    JOIN facilities f ON f.id = i.facility_id
    JOIN buildings b ON b.id = i.building_id
    LEFT JOIN components c ON c.id = i.component_id
    ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY i.created_at DESC
  `).all(...params);
  return rows.map((row) => ({
    id: row.id,
    taskNo: row.task_no,
    facilityId: row.facility_id,
    facilityName: row.facilityName,
    buildingId: row.building_id,
    buildingName: row.buildingName,
    componentId: row.component_id,
    componentName: row.componentName,
    scope: row.scope,
    sensors: parseJsonValue(row.sensors, []),
    plannedAt: row.planned_at,
    assignee: row.assignee,
    status: row.status,
    progress: row.progress,
    externalTaskNo: row.external_task_no,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function detectionList(db, reviewStatus, user) {
  const conditions = [];
  const params = [];
  if (reviewStatus) {
    conditions.push('d.review_status = ?');
    params.push(reviewStatus);
  }
  if (user.role === 'street') {
    conditions.push('f.street_id = ?');
    params.push(user.id);
  } else if (user.role === 'community') {
    conditions.push('f.community_id = ?');
    params.push(user.id);
  } else if (user.role === 'repair') {
    conditions.push("EXISTS (SELECT 1 FROM workorders w WHERE w.detection_id = d.id AND w.unit = '城维工程有限公司')");
  }
  const rows = db.prepare(`
    SELECT d.*, f.name AS facilityName, b.name AS buildingName, c.name AS componentName,
      a.id AS assessmentId, a.ai_grade AS aiGrade, a.expert_grade AS expertGrade,
      a.status AS assessmentStatus, a.recommendation, a.rule_version AS ruleVersion
    FROM detections d
    JOIN facilities f ON f.id = d.facility_id
    JOIN buildings b ON b.id = d.building_id
    LEFT JOIN components c ON c.id = d.component_id
    LEFT JOIN assessments a ON a.detection_id = d.id
    ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY d.created_at DESC
  `).all(...params);
  return rows.map((row) => ({
    id: row.id,
    analysisId: row.analysis_id,
    facilityName: row.facilityName,
    buildingName: row.buildingName,
    componentName: row.componentName,
    type: row.type,
    subtype: row.subtype,
    confidence: row.confidence,
    bbox: parseJsonValue(row.bbox, {}),
    geometry: parseJsonValue(row.geometry, {}),
    modelVersion: row.model_version,
    reviewStatus: row.review_status,
    createdAt: row.created_at,
    assessment: row.assessmentId ? {
      id: row.assessmentId,
      aiGrade: row.aiGrade,
      expertGrade: row.expertGrade,
      status: row.assessmentStatus,
      recommendation: row.recommendation,
      ruleVersion: row.ruleVersion
    } : null
  }));
}

function reviewList(db, user) {
  const conditions = [];
  const params = [];
  if (user.role === 'expert') {
    conditions.push('r.expert_id = ?');
    params.push(user.id);
  } else if (user.role === 'street') {
    conditions.push('f.street_id = ?');
    params.push(user.id);
  } else if (user.role === 'community') {
    conditions.push('f.community_id = ?');
    params.push(user.id);
  }
  return db.prepare(`
    SELECT r.*, f.name AS facilityName, d.type, u.name AS expertName
    FROM reviews r
    JOIN assessments a ON a.id = r.assessment_id
    JOIN detections d ON d.id = r.detection_id
    JOIN facilities f ON f.id = d.facility_id
    JOIN users u ON u.id = r.expert_id
    ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY r.assigned_at DESC
  `).all(...params).map((row) => ({
    id: row.id,
    assessmentId: row.assessment_id,
    detectionId: row.detection_id,
    facilityName: row.facilityName,
    type: row.type,
    aiGrade: row.ai_grade,
    expertId: row.expert_id,
    expertName: row.expertName,
    status: row.status,
    conclusion: row.conclusion,
    opinion: row.opinion,
    expertGrade: row.expert_grade,
    dueAt: row.due_at,
    assignedAt: row.assigned_at,
    acceptedAt: row.accepted_at,
    completedAt: row.completed_at
  }));
}

function responseList(db, user) {
  const conditions = [];
  const params = [];
  if (user.role === 'street') {
    conditions.push('f.street_id = ?');
    params.push(user.id);
  } else if (user.role === 'community') {
    conditions.push('f.community_id = ?');
    params.push(user.id);
  }
  return db.prepare(`
    SELECT r.*, f.name AS facilityName, d.type
    FROM responses r
    JOIN assessments a ON a.id = r.assessment_id
    JOIN detections d ON d.id = a.detection_id
    JOIN facilities f ON f.id = d.facility_id
    ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY r.created_at DESC
  `).all(...params).map((row) => ({
    id: row.id,
    assessmentId: row.assessment_id,
    facilityName: row.facilityName,
    type: row.type,
    grade: row.grade,
    department: row.department,
    owner: row.owner,
    dueAt: row.due_at,
    status: row.status,
    receivedAt: row.received_at,
    respondedAt: row.responded_at,
    action: row.action,
    responseHours: calculateResponseHours(row.received_at, row.responded_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

function workorderList(db, user) {
  const conditions = [];
  const params = [];
  if (user.role === 'repair') {
    conditions.push('w.unit = ?');
    params.push(user.org);
  } else if (user.role === 'street') {
    conditions.push('f.street_id = ?');
    params.push(user.id);
  } else if (user.role === 'community') {
    conditions.push('f.community_id = ?');
    params.push(user.id);
  } else if (user.role === 'property') {
    conditions.push('w.unit = ?');
    params.push(user.org);
  }
  const rows = db.prepare(`
    SELECT w.*, f.name AS facilityName, b.name AS buildingName, d.type
    FROM workorders w
    JOIN facilities f ON f.id = w.facility_id
    JOIN buildings b ON b.id = w.building_id
    JOIN detections d ON d.id = w.detection_id
    ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY w.created_at DESC
  `).all(...params);
  const eventsByOrder = new Map();
  if (rows.length) {
    const eventRows = db.prepare(`
      SELECT workorder_id AS workorderId, status, note, operator, created_at AS createdAt
      FROM workorder_events
      WHERE workorder_id IN (${rows.map(() => '?').join(', ')})
      ORDER BY created_at ASC
    `).all(...rows.map((row) => row.id));
    for (const event of eventRows) {
      const events = eventsByOrder.get(event.workorderId) || [];
      events.push(event);
      eventsByOrder.set(event.workorderId, events);
    }
  }
  return rows.map((row) => ({
    id: row.id,
    orderNo: row.order_no,
    assessmentId: row.assessment_id,
    detectionId: row.detection_id,
    facilityName: row.facilityName,
    buildingName: row.buildingName,
    type: row.type,
    grade: row.grade,
    unit: row.unit,
    owner: row.owner,
    dueAt: row.due_at,
    status: row.status,
    requirement: row.requirement,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    events: eventsByOrder.get(row.id) || []
  }));
}

function publicReportAdminList(db, user) {
  const conditions = [];
  const params = [];
  if (user.role === 'street') {
    conditions.push('r.parent_id = ?');
    params.push(user.id);
  } else if (user.role === 'community') {
    conditions.push('p.community_id = ?');
    params.push(user.id);
  }
  return db.prepare(`
    SELECT p.id, p.code, p.type, p.description, p.location, p.status, p.feedback,
      p.quality_score AS qualityScore, p.confidence, p.created_at AS createdAt, p.updated_at AS updatedAt
    FROM public_reports p
    LEFT JOIN regions r ON r.id = p.community_id
    ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
    ORDER BY p.created_at DESC
  `).all(...params);
}

function publicReportByCode(db, code) {
  const row = db.prepare(`
    SELECT code, type, status, feedback, created_at, updated_at
    FROM public_reports WHERE code = ?
  `).get(code);
  if (!row) throw notFound('未找到该受理编号');
  return row;
}

function validatePhotoData(photoData, maxBytes) {
  if (photoData === undefined || photoData === null || photoData === '') return null;
  if (typeof photoData !== 'string') throw badRequest('照片格式不正确');
  if (photoData.length > Math.ceil(maxBytes / 3) * 4 + 16) throw payloadTooLarge('图片过大，请压缩后重试');
  const match = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(photoData);
  if (!match || match[2].length % 4 !== 0) throw badRequest('仅支持 JPG、PNG 或 WebP 图片');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > maxBytes) throw payloadTooLarge(`图片大小应在 ${Math.round(maxBytes / 1024 / 1024)}MB 以内`);
  const mime = match[1].toLowerCase();
  const validSignature = mime === 'png'
    ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'webp'
      ? bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
      : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!validSignature) throw badRequest('图片内容与格式不匹配');
  return { data: photoData, bytes, mime };
}

function storePublicPhoto(uploadDir, reportId, photoData) {
  const photo = validatePhotoData(photoData, 3 * 1024 * 1024);
  if (!photo) return { photoPath: null, qualityScore: 0 };
  const extension = photo.mime === 'jpg' ? 'jpeg' : photo.mime;
  const relativePath = `public-reports/${reportId}.${extension}`;
  mkdirSync(join(uploadDir, 'public-reports'), { recursive: true });
  writeFileSync(join(uploadDir, ...relativePath.split('/')), photo.bytes, { flag: 'wx' });
  return { photoPath: relativePath, qualityScore: photo.bytes.length > 80_000 ? 0.91 : 0.64 };
}

function facilityDetail(db, facilityId) {
  const facility = facilityRow(db, facilityId);
  if (!facility) throw notFound('设施不存在');
  const buildings = db.prepare(`
    SELECT id, name, floors, height, area, structure, wall_material AS wallMaterial,
      roof_type AS roofType, built_year AS builtYear FROM buildings WHERE facility_id = ? ORDER BY name
  `).all(facilityId);
  const components = db.prepare(`
    SELECT c.id, c.name, c.type, c.importance, c.location, b.name AS buildingName
    FROM components c JOIN buildings b ON b.id = c.building_id WHERE b.facility_id = ? ORDER BY b.name, c.id
  `).all(facilityId);
  const recentInspections = db.prepare(`
    SELECT i.id, i.task_no AS taskNo, i.status, i.scope, i.planned_at AS plannedAt,
      i.assignee, b.name AS buildingName, c.name AS componentName
    FROM inspections i JOIN buildings b ON b.id = i.building_id
    LEFT JOIN components c ON c.id = i.component_id
    WHERE i.facility_id = ? ORDER BY i.created_at DESC LIMIT 10
  `).all(facilityId);
  const assessments = db.prepare(`
    SELECT a.id, a.detection_id AS detectionId, d.type, a.ai_grade AS aiGrade,
      a.expert_grade AS expertGrade, a.status, a.recommendation, a.created_at AS createdAt
    FROM assessments a JOIN detections d ON d.id = a.detection_id
    WHERE d.facility_id = ? ORDER BY a.created_at DESC
  `).all(facilityId);
  const workorders = db.prepare(`
    SELECT w.id, w.order_no AS orderNo, w.status, w.due_at AS dueAt, w.grade,
      w.unit, d.type
    FROM workorders w JOIN detections d ON d.id = w.detection_id
    WHERE w.facility_id = ? ORDER BY w.created_at DESC
  `).all(facilityId);
  return {
    facility: {
      ...facility,
      builtYear: facility.built_year,
      riskGrade: facility.risk_grade,
      latestGrade: facility.risk_grade
    },
    buildings,
    components,
    recentInspections,
    assessments,
    workorders
  };
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[\t\r\n =+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function regulationCsv(db) {
  const rows = db.prepare(`
    SELECT f.name AS facility, s.name AS street, c.name AS community, d.type,
      a.ai_grade AS aiGrade, a.expert_grade AS expertGrade, a.total_score AS score,
      r.status AS responseStatus, r.received_at AS receivedAt, r.responded_at AS respondedAt,
      w.order_no AS orderNo, w.status AS orderStatus
    FROM assessments a
    JOIN detections d ON d.id = a.detection_id
    JOIN facilities f ON f.id = d.facility_id
    JOIN regions s ON s.id = f.street_id
    JOIN regions c ON c.id = f.community_id
    LEFT JOIN responses r ON r.assessment_id = a.id
    LEFT JOIN workorders w ON w.assessment_id = a.id
    ORDER BY a.created_at DESC
  `).all();
  const header = ['设施', '街道', '社区', '缺陷类型', 'AI等级', '专家等级', '评估得分', '响应状态', '政府接收时间', '首次响应时间', '工单编号', '工单状态'];
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push([
      row.facility, row.street, row.community, DEFECT_LABELS[row.type] || row.type,
      row.aiGrade, row.expertGrade, row.score, row.responseStatus, row.receivedAt,
      row.respondedAt, row.orderNo, row.orderStatus
    ].map(csvCell).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}`;
}

export function buildRoutes(context) {
  const { db, uploadDir } = context;
  const routes = [];
  const add = (method, path, handler, access = 'auth') => routes.push({
    method, path, handler, access,
    authorize: access === 'auth' ? (request) => requireUser(db, request) : null
  });

  add('GET', '/api/health', () => {
    let storage = 'ok';
    try {
      accessSync(uploadDir, constants.W_OK);
    } catch {
      storage = 'down: storage';
    }
    const database = db.prepare('SELECT 1 AS ok').get().ok === 1 ? 'ok' : 'down: database';
    const status = database === 'ok' && storage === 'ok' ? 'ok' : 'degraded';
    return { status, dependencies: { database, storage }, mode: 'local-demo', timestamp: now() };
  }, 'public');

  add('GET', '/api/session', (request) => publicUser(requireUser(db, request)));
  add('PUT', '/api/session', (request, body) => {
    const input = validateFields(body, { userId: { type: 'string', required: true, max: 64 } });
    const user = db.prepare('SELECT id, name, role, role_label AS roleLabel, org, expertise FROM users WHERE id = ?').get(input.userId);
    if (!user) throw notFound('演示用户不存在');
    return publicUser(user);
  }, 'public');

  add('GET', '/api/dashboard', (request) => dashboard(db, requireUser(db, request)));
  add('GET', '/api/facilities', (request) => facilityList(db, requireUser(db, request)));
  add('GET', '/api/facilities/:id', (request, body, params) => {
    const user = requireUser(db, request);
    const detail = facilityDetail(db, params.id);
    if (user.role === 'street' && detail.facility.street_id !== user.id) throw forbidden('无权查看其他街道设施');
    if (user.role === 'community' && detail.facility.community_id !== user.id) throw forbidden('无权查看其他社区设施');
    return detail;
  });
  add('POST', '/api/facilities', (request, body) => {
    const user = requireUser(db, request);
    requireRoles(user, ['government', 'street', 'admin']);
    const input = validateFields(body, {
      name: { type: 'string', required: true, max: 120 },
      address: { type: 'string', required: true, max: 200 },
      category: { type: 'string', required: true, max: 60 },
      streetId: { type: 'string', required: true, max: 64 },
      communityId: { type: 'string', required: true, max: 64 },
      manager: { type: 'string', required: true, max: 120 },
      structure: { type: 'string', max: 80 },
      builtYear: { type: 'number', min: 1800, max: 2200 },
      longitude: { type: 'number', min: -180, max: 180 },
      latitude: { type: 'number', min: -90, max: 90 }
    });
    const community = db.prepare('SELECT id, parent_id FROM regions WHERE id = ? AND level = ?').get(input.communityId, 'community');
    if (!community || community.parent_id !== input.streetId) throw badRequest('社区必须属于所选街道');
    if (user.role === 'street' && input.streetId !== user.id) throw forbidden('无权在其他街道新建设施');
    const facilityId = id();
    const timestamp = now();
    return inTransaction(db, () => {
      db.prepare(`
        INSERT INTO facilities (id, name, category, address, street_id, community_id, manager, built_year, structure, longitude, latitude, risk_grade, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'I', ?, ?)
      `).run(
        facilityId, input.name, input.category, input.address, input.streetId, input.communityId,
        input.manager, input.builtYear ?? null, input.structure ?? null,
        input.longitude ?? null, input.latitude ?? null, timestamp, timestamp
      );
      audit(db, user, '新建设施档案', 'facility', facilityId, `新建${input.name}`);
      return { id: facilityId };
    });
  });

  add('GET', '/api/inspections', (request) => {
    const user = requireUser(db, request);
    return inspectionList(db, request.query.status, user);
  });
  add('POST', '/api/inspections', (request, body) => {
    const user = requireUser(db, request);
    requireRoles(user, ['pilot', 'street', 'government', 'admin']);
    const input = validateFields(body, {
      facilityId: { type: 'string', required: true, max: 64 },
      buildingId: { type: 'string', required: true, max: 64 },
      componentId: { type: 'string', max: 64 },
      scope: { type: 'string', required: true, max: 500 },
      plannedAt: { type: 'date', required: true },
      assignee: { type: 'string', required: true, max: 120 },
      externalTaskNo: { type: 'string', max: 120 }
    });
    if (!facilityRow(db, input.facilityId)) throw badRequest('设施不存在');
    assertFacilityScope(db, user, input.facilityId);
    const building = db.prepare('SELECT id FROM buildings WHERE id = ? AND facility_id = ?').get(input.buildingId, input.facilityId);
    if (!building) throw badRequest('楼栋与设施不匹配');
    if (input.componentId) {
      const component = db.prepare('SELECT id FROM components WHERE id = ? AND building_id = ?').get(input.componentId, input.buildingId);
      if (!component) throw badRequest('构件必须属于所选楼栋');
    }
    const sensors = input.sensors ?? ['可见光'];
    if (!Array.isArray(sensors) || sensors.length > 8 || sensors.some((item) => typeof item !== 'string' || item.length > 20)) {
      throw badRequest('传感器列表格式不正确');
    }
    const inspectionId = id();
    const timestamp = now();
    const taskNo = documentNumber('XJ', timestamp);
    return inTransaction(db, () => {
      db.prepare(`
        INSERT INTO inspections (id, task_no, facility_id, building_id, component_id, scope, sensors, planned_at, assignee, status, progress, external_task_no, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '待执行', 0, ?, ?, ?)
      `).run(
        inspectionId, taskNo, input.facilityId, input.buildingId, input.componentId ?? null,
        input.scope, JSON.stringify(sensors), input.plannedAt,
        input.assignee, input.externalTaskNo ?? null, timestamp, timestamp
      );
      audit(db, user, '创建巡检任务', 'inspection', inspectionId, `创建任务${taskNo}`);
      return { id: inspectionId, taskNo };
    });
  });
  add('PATCH', '/api/inspections/:id/status', (request, body, params) => {
    const user = requireUser(db, request);
    requireRoles(user, ['pilot', 'street', 'government', 'admin']);
    requireFields(body, ['status']);
    const current = db.prepare('SELECT * FROM inspections WHERE id = ?').get(params.id);
    if (!current) throw notFound('巡检任务不存在');
    assertFacilityScope(db, user, current.facility_id);
    assertTransition('inspection', current.status, body.status);
    const progress = { 待执行: 5, 采集中: 25, 待上传: 40, 数据质检中: 55, 待分析: 65, 分析中: 80, 已完成: 100, 异常终止: current.progress }[body.status];
    return inTransaction(db, () => {
      db.prepare('UPDATE inspections SET status = ?, progress = ?, updated_at = ? WHERE id = ?').run(body.status, progress, now(), params.id);
      audit(db, user, '更新巡检状态', 'inspection', params.id, `${current.status} → ${body.status}`, { status: current.status }, { status: body.status });
      return { id: params.id, status: body.status, progress };
    });
  });
  add('POST', '/api/inspections/:id/analyze', (request, body, params) => {
    const user = requireUser(db, request);
    requireRoles(user, ['pilot', 'government', 'street', 'admin']);
    const inspection = db.prepare('SELECT * FROM inspections WHERE id = ?').get(params.id);
    if (!inspection) throw notFound('巡检任务不存在');
    assertFacilityScope(db, user, inspection.facility_id);
    const input = validateFields(body, {
      defectType: { type: 'string', required: true, max: 80 },
      severity: { type: 'number', required: true, min: 0, max: 100 },
      componentImportance: { type: 'string', required: true, max: 30 },
      environment: { type: 'number', required: true, min: 0, max: 100 },
      location: { type: 'string', max: 200 }
    });
    const defectType = normalizeDefectType(input.defectType);
    if (!defectType) throw badRequest('不支持的缺陷类型');
    if (!['low', 'medium', 'high', 'structural'].includes(input.componentImportance)) throw badRequest('不支持的构件重要性');
    const canRerun = input.rerun === true && ['government', 'admin'].includes(user.role);
    if (!['待分析', '分析中'].includes(inspection.status) && !canRerun) {
      throw badRequest('只有待分析或分析中的任务可以执行初判；已完成任务需授权重跑', 'INVALID_ANALYSIS_STATE');
    }
    const timestamp = now();
    const analysisId = id();
    return inTransaction(db, () => {
      db.prepare(`
        INSERT INTO analyses (id, inspection_id, status, model_version, dataset_version, started_at, completed_at)
        VALUES (?, ?, '成功', 'demo-vision-0.1', 'demo-dataset-0.1', ?, ?)
      `).run(analysisId, params.id, timestamp, timestamp);
      const detectionId = id();
      const severity = input.severity;
      db.prepare(`
        INSERT INTO detections (id, analysis_id, facility_id, building_id, component_id, type, subtype, confidence, bbox, geometry, model_version, review_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo-vision-0.1', '待复核', ?)
      `).run(
        detectionId, analysisId, inspection.facility_id, inspection.building_id, inspection.component_id,
        defectType, input.location || '演示规则生成的疑似缺陷区域',
        Number((0.68 + severity / 400).toFixed(2)),
        JSON.stringify({ x: 120, y: 86, width: 280, height: 190 }),
        JSON.stringify({ length: Math.round(severity * 3.2), width: Number((severity / 45).toFixed(1)), area: Math.round(severity * 12), unit: 'px', severity, calibrated: false }),
        timestamp
      );
      db.prepare("UPDATE inspections SET status = '已完成', progress = 100, updated_at = ? WHERE id = ?").run(timestamp, params.id);
      const detection = detectionById(db, detectionId);
      const result = insertAssessment(db, detection, { ...input, defectType }, user);
      audit(db, user, '执行本地AI初判', 'analysis', analysisId, canRerun ? '授权重跑并保留历史结果' : '演示模型完成检测与可解释规则评估');
      return { analysis: { id: analysisId, status: '成功', modelVersion: 'demo-vision-0.1' }, detection: serializeDetection(detection), ...result };
    });
  });

  add('GET', '/api/media', (request) => {
    const user = requireUser(db, request);
    requireRoles(user, ['pilot', 'street', 'community', 'government', 'expert', 'admin']);
    const conditions = [];
    const params = [];
    const scope = facilityScope(user);
    if (scope.sql) {
      conditions.push(scope.sql);
      params.push(...scope.params);
    }
    if (request.query.inspectionId) {
      const inspection = db.prepare('SELECT facility_id FROM inspections WHERE id = ?').get(request.query.inspectionId);
      if (!inspection) throw notFound('巡检任务不存在');
      assertFacilityScope(db, user, inspection.facility_id);
      conditions.push('m.inspection_id = ?');
      params.push(request.query.inspectionId);
    }
    return db.prepare(`
      SELECT m.id, m.inspection_id AS inspectionId, m.type, m.file_name AS fileName,
        m.mime_type AS mimeType, m.path, m.sha256, m.size, m.metadata, m.created_at AS createdAt,
        i.task_no AS taskNo, f.name AS facilityName
      FROM media m JOIN inspections i ON i.id = m.inspection_id
      JOIN facilities f ON f.id = i.facility_id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY m.created_at DESC
    `).all(...params).map((row) => ({
      ...row, metadata: parseJsonValue(row.metadata, {})
    }));
  });
  add('POST', '/api/media', (request, body) => {
    const user = requireUser(db, request);
    requireRoles(user, ['pilot', 'street', 'government', 'admin']);
    const input = validateFields(body, {
      inspectionId: { type: 'string', required: true, max: 64 },
      type: { type: 'string', required: true, max: 30 },
      fileName: { type: 'string', required: true, max: 120 },
      mimeType: { type: 'string', required: true, max: 80 },
      path: { type: 'string', required: true, max: 500 },
      sha256: { type: 'string', max: 128 },
      size: { type: 'number', min: 0 }
    });
    const inspection = db.prepare('SELECT facility_id FROM inspections WHERE id = ?').get(input.inspectionId);
    if (!inspection) throw notFound('巡检任务不存在');
    assertFacilityScope(db, user, inspection.facility_id);
    if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata))) {
      throw badRequest('采集元数据必须为对象');
    }
    const mediaId = id();
    return inTransaction(db, () => {
      db.prepare(`
        INSERT INTO media (id, inspection_id, type, file_name, mime_type, path, sha256, size, metadata, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        mediaId, input.inspectionId, input.type, input.fileName, input.mimeType, input.path,
        input.sha256 ?? null, input.size ?? null, JSON.stringify(input.metadata ?? {}), now()
      );
      audit(db, user, '登记采集文件', 'media', mediaId, `关联文件${input.fileName}`);
      return { id: mediaId };
    });
  });
  add('GET', '/api/analyses', (request) => {
    const user = requireUser(db, request);
    requireRoles(user, ['pilot', 'street', 'community', 'government', 'expert', 'admin']);
    const scope = facilityScope(user);
    return db.prepare(`
      SELECT a.id, a.inspection_id AS inspectionId, a.status, a.model_version AS modelVersion,
        a.dataset_version AS datasetVersion, a.started_at AS startedAt, a.completed_at AS completedAt,
        a.error, i.task_no AS taskNo, f.name AS facilityName
      FROM analyses a JOIN inspections i ON i.id = a.inspection_id
      JOIN facilities f ON f.id = i.facility_id
      ${scope.sql ? `WHERE ${scope.sql}` : ''} ORDER BY a.started_at DESC
    `).all(...scope.params);
  });
  add('GET', '/api/models', (request) => {
    requireUser(db, request);
    return [{
      name: '本地建筑表观初筛演示模型',
      version: 'demo-vision-0.1',
      datasetVersion: 'demo-dataset-0.1',
      status: '演示规则模拟',
      trained: false,
      description: '用于验证检测结果、置信度、模型版本和复核流程；不代表真实训练模型或验收指标。',
      updatedAt: now()
    }];
  });
  add('GET', '/api/rules', (request) => {
    requireUser(db, request);
    return {
      version: 'DEMO-RULE-0.1',
      status: '待专家评审',
      dimensions: [
        { key: 'defectType', label: '缺陷类型', max: 40 },
        { key: 'geometry', label: '几何特征', max: 30 },
        { key: 'component', label: '构件重要性', max: 20 },
        { key: 'environment', label: '环境影响', max: 10 }
      ],
      thresholds: { I: '0—39.9', II: '40—64.9', III: '65—84.9', IV: '85—100' },
      disclaimer: '演示阈值仅用于业务流程验证，正式规则须由项目方组织专家评审确认。'
    };
  });

  add('GET', '/api/detections', (request) => {
    const user = requireUser(db, request);
    return detectionList(db, request.query.reviewStatus, user);
  });
  add('POST', '/api/assessments', (request, body) => {
    const user = requireUser(db, request);
    requireRoles(user, ['government', 'expert', 'street', 'admin']);
    const input = validateFields(body, {
      detectionId: { type: 'string', required: true, max: 64 },
      componentImportance: { type: 'string', max: 30 },
      environment: { type: 'number', min: 0, max: 100 }
    });
    if (input.componentImportance && !['low', 'medium', 'high', 'structural'].includes(input.componentImportance)) {
      throw badRequest('不支持的构件重要性');
    }
    const detection = detectionById(db, input.detectionId);
    if (!detection) throw notFound('检测结果不存在');
    assertFacilityScope(db, user, detection.facility_id);
    const geometry = parseJsonValue(detection.geometry, {});
    const component = detection.component_id
      ? db.prepare('SELECT importance FROM components WHERE id = ?').get(detection.component_id)
      : null;
    return inTransaction(db, () => insertAssessment(db, detection, {
      defectType: detection.type,
      severity: geometry.severity ?? 50,
      componentImportance: input.componentImportance ?? component?.importance ?? 'medium',
      environment: input.environment ?? 30
    }, user));
  });
  add('POST', '/api/detections/:id/review', (request, body, params) => {
    const user = requireUser(db, request);
    requireRoles(user, ['expert', 'government', 'street', 'admin']);
    const input = validateFields(body, {
      status: { type: 'string', required: true, max: 20 },
      defectType: { type: 'string', max: 80 },
      note: { type: 'string', max: 500 }
    });
    if (!['确认', '修正', '否决'].includes(input.status)) throw badRequest('不支持的复核结论');
    const type = input.defectType === undefined ? detectionById(db, params.id)?.type : normalizeDefectType(input.defectType);
    if (!type || !DEFECT_LABELS[type]) throw badRequest('请选择有效的缺陷类型');
    if (input.status === '修正' && input.defectType === undefined) throw badRequest('修正检测结果时必须提供缺陷类型');
    const detection = detectionById(db, params.id);
    if (!detection) throw notFound('检测结果不存在');
    assertFacilityScope(db, user, detection.facility_id);
    const assessment = db.prepare('SELECT id FROM assessments WHERE detection_id = ?').get(params.id);
    const needsReassessment = Boolean(assessment && type !== detection.type);
    if (needsReassessment) assertReassessmentAllowed(db, assessment.id);
    return inTransaction(db, () => {
      db.prepare('UPDATE detections SET type = ?, review_status = ? WHERE id = ?').run(type, input.status, params.id);
      if (needsReassessment) {
        db.prepare('UPDATE assessments SET status = ?, updated_at = ? WHERE id = ?').run('待重新评估', now(), assessment.id);
      }
      audit(db, user, '复核AI检测结果', 'detection', params.id, input.note || `${input.status}${DEFECT_LABELS[type]}`,
        { type: detection.type, reviewStatus: detection.review_status }, { type, reviewStatus: input.status });
      return { id: params.id, type, reviewStatus: input.status, assessmentNeedsRefresh: needsReassessment };
    });
  });

  add('GET', '/api/reviews', (request) => reviewList(db, requireUser(db, request)));
  add('PATCH', '/api/reviews/:id', (request, body, params) => {
    const user = requireUser(db, request);
    requireRoles(user, ['expert', 'government', 'street', 'admin']);
    const input = validateFields(body, {
      status: { type: 'string', required: true, max: 20 },
      conclusion: { type: 'string', max: 1000 },
      opinion: { type: 'string', max: 2000 },
      expertGrade: { type: 'string', max: 2 }
    });
    if (input.status === '已完成') {
      const completion = validateFields(input, {
        conclusion: { type: 'string', required: true, min: 1, max: 1000 },
        opinion: { type: 'string', required: true, min: 1, max: 2000 },
        expertGrade: { type: 'string', required: true }
      });
      if (!['I', 'II', 'III', 'IV'].includes(completion.expertGrade)) throw badRequest('专家等级必须为 I、II、III 或 IV');
      Object.assign(input, completion);
    }
    const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(params.id);
    if (!review) throw notFound('复核任务不存在');
    if (user.role === 'expert' && review.expert_id !== user.id) throw forbidden('该复核任务未分配给当前专家');
    const reviewDetection = detectionById(db, review.detection_id);
    assertFacilityScope(db, user, reviewDetection.facility_id);
    assertTransition('review', review.status, input.status);
    const timestamp = now();
    const acceptedAt = review.accepted_at || (input.status === '复核中' || input.status === '已完成' ? timestamp : null);
    const completedAt = input.status === '已完成' ? timestamp : null;
    return inTransaction(db, () => {
      db.prepare(`
        UPDATE reviews SET status = ?, conclusion = ?, opinion = ?, expert_grade = ?, accepted_at = ?, completed_at = ? WHERE id = ?
      `).run(
        input.status, input.conclusion ?? review.conclusion, input.opinion ?? review.opinion,
        input.expertGrade ?? review.expert_grade, acceptedAt, completedAt, params.id
      );
      const assessment = assessmentById(db, review.assessment_id);
      const assessmentStatus = input.status === '已完成' ? '已复核' : input.status === '退回补充' ? '退回补充' : assessment.status;
      db.prepare('UPDATE assessments SET expert_grade = ?, status = ?, updated_at = ? WHERE id = ?').run(
        input.expertGrade ?? assessment.expert_grade, assessmentStatus, timestamp, assessment.id
      );
      const response = input.status === '已完成'
        ? syncResponseWithAssessment(db, { ...assessment, expert_grade: input.expertGrade }, user)
        : null;
      const detection = detectionById(db, review.detection_id);
      refreshFacilityGrade(db, detection.facility_id);
      audit(db, user, '更新专家复核', 'review', params.id, input.opinion || `${review.status} → ${input.status}`,
        { status: review.status }, { status: input.status });
      return { id: params.id, status: input.status, response };
    });
  });

  add('GET', '/api/responses', (request) => {
    const user = requireUser(db, request);
    return responseList(db, user);
  });
  add('PATCH', '/api/responses/:id', (request, body, params) => {
    const user = requireUser(db, request);
    requireRoles(user, ['government', 'street', 'admin']);
    const input = validateFields(body, {
      status: { type: 'string', required: true, max: 20 },
      action: { type: 'string', max: 500 }
    });
    const current = db.prepare('SELECT * FROM responses WHERE id = ?').get(params.id);
    if (!current) throw notFound('政府响应任务不存在');
    const assessment = assessmentById(db, current.assessment_id);
    const detection = detectionById(db, assessment.detection_id);
    assertFacilityScope(db, user, detection.facility_id);
    assertTransition('response', current.status, input.status);
    const timestamp = now();
    const respondedAt = current.responded_at || (input.status === '待响应' ? null : timestamp);
    return inTransaction(db, () => {
      db.prepare('UPDATE responses SET status = ?, responded_at = ?, action = ?, updated_at = ? WHERE id = ?').run(
        input.status, respondedAt, input.action ?? current.action, timestamp, params.id
      );
      audit(db, user, '更新政府响应', 'response', params.id, input.action || `${current.status} → ${input.status}`,
        { status: current.status }, { status: input.status });
      return { id: params.id, status: input.status, respondedAt };
    });
  });

  add('GET', '/api/workorders', (request) => workorderList(db, requireUser(db, request)));
  add('POST', '/api/workorders', (request, body) => {
    const user = requireUser(db, request);
    requireRoles(user, ['government', 'street', 'property', 'admin']);
    const input = validateFields(body, {
      assessmentId: { type: 'string', required: true, max: 64 },
      unit: { type: 'string', required: true, max: 120 },
      owner: { type: 'string', required: true, max: 120 },
      dueAt: { type: 'date', required: true },
      requirement: { type: 'string', required: true, min: 1, max: 2000 }
    });
    const assessment = assessmentById(db, input.assessmentId);
    if (!assessment) throw notFound('健康评估不存在');
    if (assessment.status === '待重新评估') throw badRequest('检测结果已修正，请重新生成健康评估后再派单');
    const detection = detectionById(db, assessment.detection_id);
    assertFacilityScope(db, user, detection.facility_id);
    if (user.role === 'property' && input.unit !== user.org) throw forbidden('物业只能创建本单位的工单');
    const workorderId = id();
    const timestamp = now();
    const grade = assessment.expert_grade || assessment.ai_grade;
    const orderNo = documentNumber('GD', timestamp);
    return inTransaction(db, () => {
      db.prepare(`
        INSERT INTO workorders (id, order_no, assessment_id, detection_id, facility_id, building_id, component_id, grade, unit, owner, due_at, status, requirement, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '待派单', ?, ?, ?)
      `).run(
        workorderId, orderNo, assessment.id, detection.id, detection.facility_id, detection.building_id,
        detection.component_id, grade, input.unit, input.owner, input.dueAt, input.requirement, timestamp, timestamp
      );
      db.prepare(`
        INSERT INTO workorder_events (id, workorder_id, status, note, operator, created_at) VALUES (?, ?, '待派单', '工单已生成', ?, ?)
      `).run(id(), workorderId, user.name, timestamp);
      audit(db, user, '创建治理工单', 'workorder', workorderId, `生成工单${orderNo}`);
      return { id: workorderId, orderNo };
    });
  });
  add('PATCH', '/api/workorders/:id', (request, body, params) => {
    const user = requireUser(db, request);
    requireRoles(user, ['repair', 'property', 'street', 'government', 'admin']);
    const input = validateFields(body, {
      status: { type: 'string', required: true, max: 20 },
      note: { type: 'string', max: 500 }
    });
    const current = db.prepare('SELECT * FROM workorders WHERE id = ?').get(params.id);
    if (!current) throw notFound('治理工单不存在');
    if (user.role === 'repair' && current.unit !== user.org) throw forbidden('无权修改其他维修单位的工单');
    if (user.role === 'property' && current.unit !== user.org) throw forbidden('无权修改其他物业单位的工单');
    assertFacilityScope(db, user, current.facility_id);
    assertTransition('workorder', current.status, input.status);
    if (input.status === '已销号') {
      const passed = db.prepare("SELECT id FROM acceptances WHERE workorder_id = ? AND result = '通过'").get(params.id);
      if (!passed) throw badRequest('销号前必须完成复检并通过', 'ACCEPTANCE_REQUIRED');
    }
    const timestamp = now();
    return inTransaction(db, () => {
      db.prepare('UPDATE workorders SET status = ?, updated_at = ? WHERE id = ?').run(input.status, timestamp, params.id);
      db.prepare(`
        INSERT INTO workorder_events (id, workorder_id, status, note, operator, created_at) VALUES (?, ?, ?, ?, ?, ?)
      `).run(id(), params.id, input.status, input.note || '状态更新', user.name, timestamp);
      if (input.status === '已销号') db.prepare("UPDATE assessments SET status = '已闭环', updated_at = ? WHERE id = ?").run(timestamp, current.assessment_id);
      audit(db, user, '更新治理工单', 'workorder', params.id, input.note || `${current.status} → ${input.status}`,
        { status: current.status }, { status: input.status });
      return { id: params.id, status: input.status };
    });
  });
  add('GET', '/api/workorders/:id/acceptances', (request, body, params) => {
    const user = requireUser(db, request);
    const workorder = db.prepare('SELECT * FROM workorders WHERE id = ?').get(params.id);
    if (!workorder) throw notFound('治理工单不存在');
    if (user.role === 'repair' && workorder.unit !== user.org) throw forbidden('无权查看其他维修单位的工单');
    if (user.role === 'property' && workorder.unit !== user.org) throw forbidden('无权查看其他物业单位的工单');
    assertFacilityScope(db, user, workorder.facility_id);
    return db.prepare(`
      SELECT id, reviewer, result, opinion, before_photo AS beforePhoto,
        after_photo AS afterPhoto, created_at AS createdAt
      FROM acceptances WHERE workorder_id = ? ORDER BY created_at DESC
    `).all(params.id);
  });
  add('POST', '/api/workorders/:id/acceptance', (request, body, params) => {
    const user = requireUser(db, request);
    requireRoles(user, ['acceptance', 'street', 'government', 'admin']);
    const input = validateFields(body, {
      result: { type: 'string', required: true, max: 10 },
      opinion: { type: 'string', required: true, min: 1, max: 2000 },
      reviewer: { type: 'string', required: true, max: 120 },
      beforePhoto: { type: 'string', max: 11_184_820 },
      afterPhoto: { type: 'string', max: 11_184_820 }
    });
    const beforePhoto = validatePhotoData(input.beforePhoto, 8 * 1024 * 1024)?.data ?? null;
    const afterPhoto = validatePhotoData(input.afterPhoto, 8 * 1024 * 1024)?.data ?? null;
    if (!['通过', '不通过'].includes(input.result)) throw badRequest('复检结论必须为通过或不通过');
    const workorder = db.prepare('SELECT * FROM workorders WHERE id = ?').get(params.id);
    if (!workorder) throw notFound('治理工单不存在');
    assertFacilityScope(db, user, workorder.facility_id);
    if (workorder.status !== '待复检') throw badRequest('只有待复检工单可以提交复检结论', 'INVALID_ACCEPTANCE_STATE');
    const timestamp = now();
    const nextStatus = input.result === '通过' ? '已销号' : '整改不通过';
    const acceptanceId = id();
    return inTransaction(db, () => {
      db.prepare(`
        INSERT INTO acceptances (id, workorder_id, reviewer, result, opinion, before_photo, after_photo, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(acceptanceId, params.id, input.reviewer, input.result, input.opinion, beforePhoto, afterPhoto, timestamp);
      db.prepare('UPDATE workorders SET status = ?, updated_at = ? WHERE id = ?').run(nextStatus, timestamp, params.id);
      db.prepare(`
        INSERT INTO workorder_events (id, workorder_id, status, note, operator, created_at) VALUES (?, ?, ?, ?, ?, ?)
      `).run(id(), params.id, nextStatus, `复检${input.result}：${input.opinion}`, user.name, timestamp);
      db.prepare('UPDATE assessments SET status = ?, updated_at = ? WHERE id = ?').run(nextStatus === '已销号' ? '已闭环' : '整改不通过', timestamp, workorder.assessment_id);
      audit(db, user, '提交复检结论', 'workorder', params.id, `复检${input.result}：${input.opinion}`,
        { status: workorder.status }, { status: nextStatus });
      return { id: acceptanceId, status: nextStatus };
    });
  });

  add('PATCH', '/api/public/reports/:id', (request, body, params) => {
    const user = requireUser(db, request);
    requireRoles(user, ['government', 'street', 'community', 'expert', 'admin']);
    const input = validateFields(body, {
      status: { type: 'string', required: true, max: 20 },
      feedback: { type: 'string', required: true, min: 1, max: 500 }
    });
    const report = db.prepare('SELECT id, community_id, status FROM public_reports WHERE id = ?').get(params.id);
    if (!report) throw notFound('公众线索不存在');
    if (user.role === 'street') {
      const community = db.prepare('SELECT parent_id FROM regions WHERE id = ?').get(report.community_id);
      if (!community || community.parent_id !== user.id) throw forbidden('无权处理其他街道的公众线索');
    }
    if (user.role === 'community' && report.community_id !== user.id) throw forbidden('无权处理其他社区的公众线索');
    assertTransition('publicReport', report.status, input.status);
    const timestamp = now();
    return inTransaction(db, () => {
      db.prepare('UPDATE public_reports SET status = ?, feedback = ?, updated_at = ? WHERE id = ?').run(
        input.status, input.feedback, timestamp, params.id
      );
      audit(db, user, '处理公众线索', 'publicReport', params.id, input.feedback,
        { status: report.status }, { status: input.status });
      return { id: params.id, status: input.status, feedback: input.feedback, updatedAt: timestamp };
    });
  });
  add('GET', '/api/public/reports', (request) => {
    const user = requireUser(db, request);
    requireRoles(user, ['government', 'street', 'community', 'expert', 'admin']);
    return publicReportAdminList(db, user);
  });
  add('GET', '/api/public/context', () => ({
    communities: db.prepare("SELECT id, name FROM regions WHERE level = 'community' ORDER BY name").all(),
    buildings: db.prepare(`
      SELECT b.id, b.name, f.community_id AS communityId, f.name AS facilityName
      FROM buildings b JOIN facilities f ON f.id = b.facility_id ORDER BY f.name, b.name
    `).all()
  }), 'public');
  add('POST', '/api/public/reports', (request, body) => {
    const input = validateFields(body, {
      type: { type: 'string', required: true, max: 80 },
      description: { type: 'string', required: true, min: 5, max: 500 },
      location: { type: 'string', required: true, min: 2, max: 160 },
      contact: { type: 'string', max: 30 },
      communityId: { type: 'string', max: 64 },
      buildingId: { type: 'string', max: 64 }
    });
    const reportType = normalizeDefectType(input.type);
    if (!reportType) throw badRequest('请选择有效的上报类别');
    if (input.communityId && !db.prepare("SELECT id FROM regions WHERE id = ? AND level = 'community'").get(input.communityId)) {
      throw badRequest('请选择有效的社区');
    }
    if (input.buildingId) {
      const building = db.prepare(`
        SELECT b.id FROM buildings b JOIN facilities f ON f.id = b.facility_id
        WHERE b.id = ? AND f.community_id = ?
      `).get(input.buildingId, input.communityId || null);
      if (!building) throw badRequest('建筑必须属于所选社区', 'INVALID_BUILDING_CONTEXT');
    }
    const timestamp = now();
    const reportId = id();
    const { photoPath, qualityScore } = storePublicPhoto(uploadDir, reportId, body.photoData);
    const confidence = Number(clamp(0.28 + Math.min(input.description.length, 80) / 200 + qualityScore * 0.35, 0, 0.96).toFixed(2));
    let status = '待筛查';
    let feedback = '已提交，系统正在进行本地快速筛查。';
    if (!photoPath || qualityScore < 0.7) {
      status = '补充材料';
      feedback = '请补充清晰、完整的现场照片，并保持安全拍摄距离。';
    } else if (confidence < 0.45) {
      status = '未采纳';
      feedback = '当前线索与建筑隐患相关性较低，已归档。';
    } else if (confidence >= 0.75) {
      status = '待专家复核';
      feedback = '已完成快速筛查，线索已进入专家复核队列。';
    }
    const serial = 1000 + randomBytes(2).readUInt16BE(0) % 9000;
    const code = `PUB-${timestamp.slice(0, 10).replaceAll('-', '')}-${String(serial).padStart(4, '0')}-${randomBytes(5).toString('hex').toUpperCase()}`;
    try {
      db.prepare(`
        INSERT INTO public_reports (id, code, contact, type, description, location, community_id, building_id, photo_path, quality_score, confidence, status, feedback, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reportId, code, input.contact || null, reportType, input.description, input.location,
        input.communityId ?? null, input.buildingId ?? null, photoPath,
        qualityScore, confidence, status, feedback, timestamp, timestamp
      );
    } catch (error) {
      if (photoPath) {
        try { unlinkSync(join(uploadDir, ...photoPath.split('/'))); } catch { /* keep the original database error */ }
      }
      throw error;
    }
    return { code, status, feedback };
  }, 'public');
  add('GET', '/api/public/reports/:code', (request, body, params) => {
    const row = publicReportByCode(db, params.code);
    return {
      code: row.code,
      type: DEFECT_LABELS[row.type] || row.type,
      status: row.status,
      feedback: row.feedback,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }, 'public');

  add('GET', '/api/audit', (request) => {
    const user = requireUser(db, request);
    requireRoles(user, ['government', 'admin']);
    return db.prepare(`
      SELECT a.id, u.name AS userName, a.action, a.object_type AS objectType,
        a.object_id AS objectId, a.summary, a.created_at AS createdAt
      FROM audit_logs a JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 200
    `).all();
  });
  add('GET', '/api/export/regulation.csv', (request) => {
    const user = requireUser(db, request);
    requireRoles(user, ['government', 'admin']);
    return { csv: regulationCsv(db), filename: `监管报表_${now().slice(0, 10)}.csv` };
  });

  return routes;
}

export function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const names = [];
    const pattern = route.path.replace(/:([A-Za-z0-9_]+)/g, (_, name) => {
      names.push(name);
      return '([^/]+)';
    });
    const match = pathname.match(new RegExp(`^${pattern}$`));
    if (!match) continue;
    try {
      const params = Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
      return { route, params };
    } catch {
      throw badRequest('路径参数编码不合法', 'INVALID_PATH');
    }
  }
  return null;
}

export function routeApi(request, response, routes, body = {}) {
  const url = new URL(request.url, 'http://localhost');
  const matched = matchRoute(routes, request.method, url.pathname);
  if (!matched) throw notFound('接口不存在');
  const { route, params } = matched;
  if (!route.authorize && route.access !== 'public') throw forbidden('接口未配置访问策略');
  if (route.authorize) request.user = route.authorize(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('请求体必须为 JSON 对象');
  const requestWithQuery = request;
  requestWithQuery.query = Object.fromEntries(url.searchParams.entries());
  return route.handler(requestWithQuery, body, params);
}

export { errorResponse, json };
