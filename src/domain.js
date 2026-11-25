export const DEFECT_LABELS = {
  crack: '墙体裂缝',
  hollow: '外墙饰面空鼓与脱落',
  spall: '混凝土剥落与露筋',
  corrosion: '钢结构锈蚀',
  leak: '屋面渗漏痕迹',
  sealant: '幕墙密封胶失效',
  other: '其他异常'
};

export const GRADE_LABELS = {
  I: 'Ⅰ级 · 关注',
  II: 'Ⅱ级 · 观察',
  III: 'Ⅲ级 · 处置',
  IV: 'Ⅳ级 · 紧急'
};

const DEFECT_SCORES = {
  crack: 20,
  hollow: 32,
  spall: 40,
  corrosion: 28,
  leak: 30,
  sealant: 24,
  other: 16
};

const COMPONENT_SCORES = {
  low: 4,
  medium: 10,
  high: 16,
  structural: 20
};

const RECOMMENDATIONS = {
  I: '纳入下一周期巡检重点，保留检查记录并观察变化。',
  II: '设置观察周期，安排复查或补充采集。',
  III: '生成专家复核任务，启动现场专业检测和治理流程。',
  IV: '立即提示责任部门，由有权部门按应急预案启动管控措施。'
};

export function clamp(value, min = 0, max = 100) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

export function gradeFromScore(score) {
  if (score >= 85) return 'IV';
  if (score >= 65) return 'III';
  if (score >= 40) return 'II';
  return 'I';
}

export function gradeRank(grade) {
  return { I: 1, II: 2, III: 3, IV: 4 }[grade] ?? 0;
}

export function evaluateHealth(input = {}) {
  const defectType = DEFECT_LABELS[input.defectType] ? input.defectType : 'other';
  const severity = clamp(input.severity ?? 50);
  const environment = clamp(input.environment ?? 30);
  const componentImportance = COMPONENT_SCORES[input.componentImportance]
    ? input.componentImportance
    : 'medium';

  const dimensions = {
    defectType: {
      score: DEFECT_SCORES[defectType],
      max: 40,
      value: defectType,
      label: DEFECT_LABELS[defectType],
      reason: `缺陷类型“${DEFECT_LABELS[defectType]}”命中演示规则基础分 ${DEFECT_SCORES[defectType]}。`
    },
    geometry: {
      score: Number((severity * 0.3).toFixed(1)),
      max: 30,
      value: severity,
      label: `严重度 ${severity}`,
      reason: `几何/分布严重度为 ${severity}，按 30% 权重计入。`
    },
    component: {
      score: COMPONENT_SCORES[componentImportance],
      max: 20,
      value: componentImportance,
      label: componentImportance,
      reason: `构件重要性为 ${componentImportance}，对应 ${COMPONENT_SCORES[componentImportance]} 分。`
    },
    environment: {
      score: Number((environment * 0.1).toFixed(1)),
      max: 10,
      value: environment,
      label: `环境指数 ${environment}`,
      reason: `环境影响因素指数为 ${environment}，按 10% 权重计入。`
    }
  };

  const totalScore = Number(
    Object.values(dimensions).reduce((sum, item) => sum + item.score, 0).toFixed(1)
  );
  const grade = gradeFromScore(totalScore);

  return {
    defectType,
    severity,
    componentImportance,
    environment,
    dimensions,
    totalScore,
    aiGrade: grade,
    recommendation: RECOMMENDATIONS[grade],
    reasons: Object.values(dimensions).map((item) => item.reason),
    ruleVersion: 'DEMO-RULE-0.1',
    disclaimer: '演示规则仅用于业务流程验证，阈值和专业判定依据须经项目方专家评审确认。'
  };
}

const TRANSITIONS = {
  inspection: {
    待执行: ['采集中', '异常终止'],
    采集中: ['待上传', '异常终止'],
    待上传: ['数据质检中', '异常终止'],
    数据质检中: ['待分析', '异常终止'],
    待分析: ['分析中', '异常终止'],
    分析中: ['已完成', '异常终止'],
    已完成: [],
    异常终止: ['待执行']
  },
  review: {
    待分配: ['待接单', '退回补充'],
    待接单: ['复核中', '已完成', '退回补充'],
    复核中: ['已完成', '退回补充'],
    已完成: [],
    退回补充: ['待接单'],
    超时: ['待接单']
  },
  response: {
    待响应: ['已响应', '处置中', '已取消'],
    已响应: ['处置中', '已完成'],
    处置中: ['已完成'],
    已完成: [],
    已取消: []
  },
  workorder: {
    待派单: ['待接单', '已取消'],
    待接单: ['处理中', '已取消'],
    处理中: ['待复检'],
    待复检: ['已销号', '整改不通过'],
    整改不通过: ['处理中'],
    已销号: [],
    已取消: []
  },
  publicReport: {
    待筛查: ['补充材料', '待专家复核', '未采纳', '已归档'],
    补充材料: ['待筛查'],
    待专家复核: ['复核中', '已归档'],
    复核中: ['已确认', '未采纳', '已归档'],
    已确认: ['已转工单', '已归档'],
    未采纳: ['已归档'],
    已转工单: ['已归档'],
    已归档: []
  }
};

export function canTransition(entity, from, to) {
  return Boolean(TRANSITIONS[entity]?.[from]?.includes(to));
}

export function assertTransition(entity, from, to) {
  if (!canTransition(entity, from, to)) {
    const error = new Error(`不允许的状态流转：${from} → ${to}`);
    error.code = 'INVALID_TRANSITION';
    error.status = 400;
    throw error;
  }
}

export function calculateResponseHours(receivedAt, respondedAt) {
  if (!receivedAt || !respondedAt) return null;
  const received = new Date(receivedAt).getTime();
  const responded = new Date(respondedAt).getTime();
  if (!Number.isFinite(received) || !Number.isFinite(responded) || responded < received) return null;
  return Number(((responded - received) / 3_600_000).toFixed(1));
}

export function isResponseCompliant(hours) {
  return typeof hours === 'number' && hours <= 72;
}

export function summarizeAssessment(assessment) {
  const grade = assessment.expertGrade || assessment.aiGrade;
  return `${assessment.type}：AI ${assessment.aiGrade} 级，${assessment.expertGrade ? `专家 ${assessment.expertGrade} 级` : '待专家确认'}；${assessment.recommendation}`;
}
