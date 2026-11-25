import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertTransition,
  calculateResponseHours,
  canTransition,
  evaluateHealth,
  gradeFromScore,
  gradeRank,
  isResponseCompliant
} from '../src/domain.js';

test('健康评估按四个维度形成可解释总分', () => {
  const result = evaluateHealth({ defectType: 'spall', severity: 100, componentImportance: 'structural', environment: 100 });
  assert.equal(result.dimensions.defectType.score, 40);
  assert.equal(result.dimensions.geometry.score, 30);
  assert.equal(result.dimensions.component.score, 20);
  assert.equal(result.dimensions.environment.score, 10);
  assert.equal(result.totalScore, 100);
  assert.equal(result.aiGrade, 'IV');
  assert.equal(result.ruleVersion, 'DEMO-RULE-0.1');
  assert.match(result.disclaimer, /专家评审/);
});

test('健康等级阈值覆盖边界且不使用模型置信度', () => {
  assert.equal(gradeFromScore(39.9), 'I');
  assert.equal(gradeFromScore(40), 'II');
  assert.equal(gradeFromScore(64.9), 'II');
  assert.equal(gradeFromScore(65), 'III');
  assert.equal(gradeFromScore(84.9), 'III');
  assert.equal(gradeFromScore(85), 'IV');
  assert.ok(gradeRank('IV') > gradeRank('III'));
  assert.ok(gradeRank('III') > gradeRank('II'));
  assert.ok(gradeRank('II') > gradeRank('I'));
  const low = evaluateHealth({ defectType: 'crack', severity: 10, componentImportance: 'low', environment: 0 });
  const high = evaluateHealth({ defectType: 'spall', severity: 100, componentImportance: 'structural', environment: 100 });
  assert.equal(low.aiGrade, 'I');
  assert.equal(high.aiGrade, 'IV');
});

test('非法状态流转被明确拒绝', () => {
  assert.equal(canTransition('workorder', '待派单', '已销号'), false);
  assert.throws(() => assertTransition('workorder', '待派单', '已销号'), { code: 'INVALID_TRANSITION' });
  assert.equal(canTransition('workorder', '待复检', '整改不通过'), true);
  assert.equal(canTransition('workorder', '整改不通过', '处理中'), true);
  assert.equal(canTransition('publicReport', '复核中', '未采纳'), true);
});

test('政府响应仅允许待响应任务取消且取消不可逆', () => {
  assert.equal(canTransition('response', '待响应', '已取消'), true);
  assert.doesNotThrow(() => assertTransition('response', '待响应', '已取消'));
  for (const from of ['已响应', '处置中', '已完成', '已取消']) {
    assert.equal(canTransition('response', from, '已取消'), false, `${from} 不应进入已取消`);
    assert.throws(() => assertTransition('response', from, '已取消'), { code: 'INVALID_TRANSITION' });
  }
  assert.equal(canTransition('response', '已取消', '待响应'), false);
  assert.throws(() => assertTransition('response', '已取消', '待响应'), { code: 'INVALID_TRANSITION' });
});

test('巡检与专家复核拒绝跳过阶段和终态回退', () => {
  const invalidTransitions = [
    ['inspection', '待执行', '已完成'],
    ['inspection', '待上传', '采集中'],
    ['inspection', '已完成', '待执行'],
    ['review', '待分配', '复核中'],
    ['review', '退回补充', '已完成'],
    ['review', '已完成', '复核中']
  ];
  for (const [entity, from, to] of invalidTransitions) {
    assert.equal(canTransition(entity, from, to), false, `${entity}: ${from} → ${to}`);
    assert.throws(() => assertTransition(entity, from, to), { code: 'INVALID_TRANSITION' });
  }
  assert.equal(canTransition('inspection', '待执行', '采集中'), true);
  assert.equal(canTransition('review', '待分配', '待接单'), true);
  assert.equal(canTransition('review', '待接单', '复核中'), true);
});

test('72小时响应统计使用小时且拒绝倒挂时间', () => {
  const received = '2026-11-24T00:00:00.000Z';
  assert.equal(calculateResponseHours(received, '2026-11-24T02:30:00.000Z'), 2.5);
  assert.equal(calculateResponseHours(received, '2026-11-27T00:00:00.000Z'), 72);
  assert.equal(calculateResponseHours(received, '2026-11-27T00:01:00.000Z'), 72);
  assert.equal(isResponseCompliant(72), true);
  assert.equal(isResponseCompliant(72.1), false);
  assert.equal(calculateResponseHours(received, '2026-11-23T23:00:00.000Z'), null);
  assert.equal(calculateResponseHours(received, null), null);
});
