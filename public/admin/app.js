import { api, currentUserId, setCurrentUserId } from '../shared/api.js';
import {
  icon, escapeHtml, formatDate, formatDateTime, gradeLabel, gradeKey, gradeTone, statusTone,
  badge, gradeBadge, loading, emptyState, errorState, toast, openModal, closeModal,
  confirmDialog, facilityArtwork, formField
} from '../shared/ui.js';

const app = document.querySelector('#app');
const titles = {
  dashboard: '健康总览', facilities: '设施台账', facility: '设施详情', inspections: '巡检任务',
  detections: 'AI 缺陷识别', reviews: '专家复核', responses: '部门响应', workorders: '整改工单',
  public: '公众线索', audit: '审计日志'
};
const DEFECT_LABELS = {
  crack: '墙体裂缝', hollow: '外墙饰面空鼓与脱落', spall: '混凝土剥落与露筋',
  corrosion: '钢结构锈蚀', leak: '屋面渗漏痕迹', sealant: '幕墙密封胶失效', other: '其他异常'
};
const IMPORTANCE_LABELS = { low: '一般构件', medium: '重要构件', high: '关键构件', structural: '主体结构构件' };
const filters = {
  facilities: { q: '', category: '', grade: '' },
  inspections: { q: '', status: '' },
  detections: { q: '', reviewStatus: '', grade: '' },
  reviews: { q: '', status: '' },
  responses: { q: '', status: '' },
  workorders: { q: '', status: '' },
  public: { q: '', status: '' },
  audit: { q: '', action: '' }
};
const listViews = {
  facilities: { path: '/api/facilities', renderer: renderFacilities },
  inspections: { path: '/api/inspections', renderer: renderInspections },
  detections: { path: '/api/detections', renderer: renderDetections },
  reviews: { path: '/api/reviews', renderer: renderReviews },
  responses: { path: '/api/responses', renderer: renderResponses },
  workorders: { path: '/api/workorders', renderer: renderWorkorders },
  public: { path: '/api/public/reports', renderer: renderPublic },
  audit: { path: '/api/audit', renderer: renderAudit }
};
const listCache = new Map();
let session = null;
let renderToken = 0;
let searchTimer;

function fillIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });
}
fillIcons();

function text(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') {
    if (value.message) return value.message;
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}
function ratioPercent(value) {
  const number = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(number)) return '—';
  return `${Math.round(number * 1000) / 10}%`;
}
function percentage(value) {
  const number = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(number)) return '—';
  return `${Math.round(number * 10) / 10}%`;
}
function decimal(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10) / 10 : '—';
}
function confidenceValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? (number <= 1 ? Math.round(number * 100) : Math.round(number)) : 0;
}
function listText(value) { return Array.isArray(value) ? value.join('、') : text(value); }
function defectLabel(value) { return DEFECT_LABELS[value] || value || '其他异常'; }
function canInternal(...roles) { return session?.role === 'admin' || roles.includes(session?.role); }
const restrictedViews = {
  public: ['government', 'street', 'community', 'expert'],
  audit: ['government']
};
function canViewPage(name) { return !restrictedViews[name] || canInternal(...restrictedViews[name]); }
function applyRoleNavigation() {
  document.querySelectorAll('[data-nav]').forEach(link => {
    if (link.dataset.nav !== 'facility') link.hidden = !canViewPage(link.dataset.nav);
  });
  if (canViewPage(routeFromHash().name)) return true;
  location.hash = '#/dashboard';
  toast('当前演示角色无权访问该页面', 'error');
  return false;
}
function unique(...values) { return [...new Set(values.filter(v => v !== undefined && v !== null && v !== ''))]; }
function statusOptions(rows, key, current = '') {
  return unique(...rows.map(row => row[key]), current).map(value => [value, value]);
}
function selectedOptions(options, value) {
  return options.some(option => String(Array.isArray(option) ? option[0] : option) === String(value)) ? options : [[value, value], ...options];
}
function pageHead(title, description, actions = '') {
  return `<div class="page-head"><div><span class="eyebrow">CITY FACILITY HEALTH</span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p></div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</div>`;
}
function primaryButton(action, label, name = 'plus', attrs = '') {
  return `<button class="btn btn-primary" type="button" data-action="${action}" ${attrs}>${icon(name)}${escapeHtml(label)}</button>`;
}
function searchFilter(key, placeholder, value) {
  return `<label class="field search-field"><span>关键词检索</span><div class="field-with-icon">${icon('search')}<input data-filter="q" value="${escapeHtml(value)}" placeholder="${escapeHtml(placeholder)}" aria-label="关键词检索"></div></label>`;
}
function selectFilter(label, name, value, options) {
  return `<label class="field"><span>${escapeHtml(label)}</span><select data-filter="${escapeHtml(name)}"><option value="">全部</option>${selectedOptions(options, value).map(option => { const [val, textValue] = Array.isArray(option) ? option : [option, option]; return `<option value="${escapeHtml(val)}" ${String(value) === String(val) ? 'selected' : ''}>${escapeHtml(textValue)}</option>`; }).join('')}</select></label>`;
}
function cardHead(title, subtitle = '', extra = '') {
  return `<div class="card-head"><div><h2>${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div>${extra}</div>`;
}
function filterToolbar(inner) {
  return `<div class="filter-bar">${inner}</div>`;
}
function tableCard(title, columns, rows, subtitle = '', emptyText = '暂无符合条件的记录') {
  const body = Array.isArray(rows) ? rows.join('') : String(rows || '');
  const count = Array.isArray(rows) ? rows.length : (body.match(/<tr>/g) || []).length;
  return `<section class="card table-card">${cardHead(title, subtitle, `<span class="result-count">${paginationText(count)}</span>`)}${count ? `<div class="table-scroll"><table><thead><tr>${columns.map(column => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>` : emptyState('未找到记录', emptyText)}</section>`;
}
function paginationText(count) { return `${count} 条记录`; }
function actionButton(action, label, id, extra = '') {
  return `<button class="btn btn-sm" type="button" data-action="${action}" data-id="${escapeHtml(id)}" ${extra}>${escapeHtml(label)}</button>`;
}
function infoRow(label, value) { return `<div class="info-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(text(value))}</strong></div>`; }

async function loadView(token, loader, renderer, cacheKey = '') {
  try {
    const data = await loader();
    if (token !== renderToken) return;
    app.innerHTML = renderer(data);
    if (cacheKey && filters[cacheKey]) listCache.set(cacheKey, data);
  } catch (error) {
    if (token !== renderToken) return;
    app.innerHTML = errorState(error, location.hash);
  }
}

function routeFromHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [name, param] = raw.split('/');
  return { name: titles[name] ? name : 'dashboard', param: param ? decodeURIComponent(param) : '' };
}

function redrawList(page) {
  const view = listViews[page];
  if (!view || !listCache.has(page)) return false;
  app.innerHTML = view.renderer(listCache.get(page));
  return true;
}
function restoreFilterFocus(selector, selection) {
  const control = app.querySelector(selector);
  if (!control) return;
  control.focus({ preventScroll: true });
  if (selection && control.setSelectionRange) control.setSelectionRange(selection.start, selection.end);
}

async function render() {
  if (!applyRoleNavigation()) return;
  clearTimeout(searchTimer);
  listCache.clear();
  const token = ++renderToken;
  const route = routeFromHash();
  document.title = `${titles[route.name]} · 城市设施健康平台`;
  document.querySelector('#page-title').textContent = titles[route.name];
  document.querySelectorAll('[data-nav]').forEach(link => {
    const active = link.dataset.nav === route.name || (route.name === 'facility' && link.dataset.nav === 'facilities');
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.querySelector('[data-nav="facility"]').hidden = route.name !== 'facility';
  closeSidebar();
  app.innerHTML = loading(`正在加载${titles[route.name]}…`);
  const loaders = {
    dashboard: () => loadView(token, () => api('/api/dashboard'), renderDashboard),
    facility: () => route.param ? loadView(token, () => api(`/api/facilities/${encodeURIComponent(route.param)}`), data => renderFacility(data, route.param)) : notFound(),
    ...Object.fromEntries(Object.entries(listViews).map(([name, view]) => [name, () => loadView(token, () => api(view.path), view.renderer, name)]))
  };
  try { await loaders[route.name](); }
  catch (error) { if (token === renderToken) app.innerHTML = errorState(error, location.hash); }
  if (token === renderToken) app.focus({ preventScroll: true });
}
function notFound() { app.innerHTML = errorState(new Error('未找到该设施或路由地址。'), location.hash); }

async function loadSession() {
  const select = document.querySelector('#user-select');
  select.value = currentUserId();
  try {
    session = await api('/api/session');
    setCurrentUserId(session.id);
    select.value = session.id;
    document.querySelector('#user-avatar').textContent = String(session.name || session.roleLabel || '演').slice(0, 1);
    const label = document.querySelector('.user-switcher label small');
    label.textContent = `${session.name} · ${session.roleLabel}`;
    label.title = `${session.org || ''} / ${session.roleLabel || ''}`;
  } catch (error) {
    document.querySelector('.user-switcher label small').textContent = '演示角色（会话未连接）';
    toast(error.message, 'error');
  }
}

function metric(label, value, unit, note, name, emphasis = false) {
  return `<article class="metric-card${emphasis ? ' emphasis' : ''}"><div class="metric-top"><span>${escapeHtml(label)}</span><span class="metric-icon">${icon(name)}</span></div><div class="metric-value">${escapeHtml(value)}${unit ? `<span class="metric-unit">${escapeHtml(unit)}</span>` : ''}</div><div class="metric-note">${escapeHtml(note)}</div></article>`;
}

function donutChart(rows) {
  const normalized = rows.map(row => [gradeKey(row.grade), Number(row.count) || 0]);
  const total = normalized.reduce((sum, row) => sum + row[1], 0);
  const radius = 52, circumference = 2 * Math.PI * radius;
  let offset = 0;
  const colors = { I: '#3b9178', II: '#5b94a7', III: '#d2a04c', IV: '#c9685c', A: '#3b9178', B: '#5b94a7', C: '#d2a04c', D: '#c9685c' };
  const circles = normalized.map(([grade, count]) => {
    const length = total ? count / total * circumference : 0;
    const circle = `<circle cx="70" cy="70" r="${radius}" fill="none" stroke="${colors[grade] || '#819590'}" stroke-width="16" stroke-dasharray="${Math.max(0, length - (length ? 2 : 0))} ${circumference}" stroke-dashoffset="${-offset}"><title>${escapeHtml(gradeLabel(grade))}：${count}</title></circle>`;
    offset += length;
    return circle;
  }).join('');
  const list = ['I', 'II', 'III', 'IV'].map(grade => {
    const row = normalized.find(item => item[0] === grade) || [grade, 0];
    return `<div class="grade-row"><b class="tone-${gradeTone(grade)}">${grade} 级</b><span class="mini-track"><i class="tone-${gradeTone(grade)}" style="width:${total ? row[1] / total * 100 : 0}%"></i></span><b>${row[1]}</b></div>`;
  }).join('');
  return `<div class="grade-overview"><div class="donut-wrap"><svg viewBox="0 0 140 140" role="img" aria-label="四级健康分布"><circle cx="70" cy="70" r="${radius}" fill="none" stroke="#edf1ef" stroke-width="16"/>${circles}</svg><div class="donut-center"><strong>${total}</strong><span>设施总数</span></div></div><div class="grade-list">${list}</div></div>`;
}

function trendChart(rows) {
  const width = 680, height = 190, left = 35, right = 18, top = 17, bottom = 30;
  const values = rows.map(row => Number(row.count) || 0);
  const max = Math.max(1, ...values);
  const chartWidth = width - left - right, chartHeight = height - top - bottom;
  const point = (value, index) => [left + (rows.length <= 1 ? chartWidth / 2 : index * chartWidth / (rows.length - 1)), top + chartHeight - value / max * chartHeight];
  const points = values.map((value, index) => point(value, index));
  const line = points.map((p, index) => `${index ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = points.length ? `${line} L${points.at(-1)[0]},${top + chartHeight} L${points[0][0]},${top + chartHeight} Z` : '';
  const grid = [0, 1, 2, 3].map(index => { const y = top + chartHeight * index / 3; const value = Math.round(max * (3 - index) / 3); return `<line class="grid-line" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/><text x="${left - 9}" y="${y + 3}" text-anchor="end">${value}</text>`; }).join('');
  const labelIndexes = unique(0, Math.floor((rows.length - 1) / 2), rows.length - 1).filter(index => index >= 0);
  const labels = labelIndexes.map(index => `<text x="${points[index][0]}" y="${height - 7}" text-anchor="middle">${escapeHtml(rows[index].date)}</text>`).join('');
  const dots = points.map((p, index) => `<circle cx="${p[0]}" cy="${p[1]}" r="3.5" fill="#fff" stroke="#278f7f" stroke-width="2"><title>${escapeHtml(formatDate(rows[index].date))}：${values[index]} 次</title></circle>`).join('');
  return `<svg class="trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="巡检趋势"><defs><linearGradient id="trendGradient" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#4ba08d" stop-opacity=".24"/><stop offset="1" stop-color="#4ba08d" stop-opacity="0"/></linearGradient></defs>${grid}<path class="trend-area" d="${area}"/><path class="trend-line" d="${line}"/>${dots}${labels}</svg>`;
}

function renderDashboard(data) {
  const m = data.metrics || {};
  const grades = data.gradeDistribution || [];
  const streets = data.streetStats || [];
  const alerts = data.recentAlerts || [];
  const trend = data.inspectionTrend || [];
  const maxStreet = Math.max(1, ...streets.map(row => Number(row.facilities) || 0));
  const streetHtml = streets.length ? streets.map(row => {
    const total = Number(row.facilities) || 0, high = Number(row.highRisk) || 0;
    const riskWidth = total ? Math.min(100, high / total * 100) : 0;
    return `<div class="street-row"><div class="street-row-top"><span>${escapeHtml(row.name)}</span><small>${high} 项高风险 · ${row.openOrders} 项待办</small></div><div class="street-track"><i style="width:${total / maxStreet * 100}%"></i><i style="width:${riskWidth}%"></i></div></div>`;
  }).join('') : emptyState('暂无街道统计');
  const alertHtml = alerts.length ? alerts.map(row => `<a class="alert-item" href="#/facility/${encodeURIComponent(row.facilityId)}"><span class="alert-mark">${icon('alert')}</span><span class="alert-info"><strong>${escapeHtml(row.facilityName)}</strong><small>${escapeHtml(defectLabel(row.type))} · ${escapeHtml(formatDateTime(row.createdAt))}</small></span><span class="alert-meta">${gradeBadge(row.grade)}<small>${escapeHtml(row.status)}</small></span></a>`).join('') : emptyState('暂无近期预警');
  const actions = canInternal('government') ? `<button class="btn btn-secondary" type="button" data-action="export">${icon('download')}导出监管报表</button>` : '';
  return `${pageHead('健康总览', '汇聚设施、巡检、评估与处置数据，辅助开展分级监管。', actions)}
    <div class="metric-grid">
      ${metric('设施总数', m.facilities ?? 0, '项', '已纳入平台监管', 'building')}
      ${metric('楼栋数量', m.buildings ?? 0, '栋', '设施下属建筑台账', 'layers')}
      ${metric('累计巡检', m.inspections ?? 0, '次', '轻量化体检记录', 'clipboard')}
      ${metric('高风险设施', m.highRisk ?? 0, '项', '需优先复核与处置', 'alert', true)}
      ${metric('待复核评估', m.pendingReviews ?? 0, '项', '等待专家出具意见', 'shield')}
      ${metric('在办工单', m.activeWorkorders ?? 0, '项', '整改处置持续跟踪', 'workorder')}
      ${metric('公众报告', m.publicReports ?? 0, '条', '社会协同发现线索', 'public')}
      ${metric('闭环率', percentage(m.closureRate), '', '已销号工单占比', 'check')}
      ${metric('平均响应时长', decimal(m.avgResponseHours), '小时', '部门受理至响应', 'clock')}
      ${metric('响应及时率', percentage(m.responseCompliance), '', '按规则口径统计', 'activity')}
    </div>
    <div class="dashboard-grid">
      <section class="dashboard-hero"><div class="hero-copy"><span class="eyebrow">AI-ASSISTED ASSESSMENT</span><h2>让设施风险早发现、处置全过程可追溯</h2><p>融合巡检影像、结构构件与环境信息，形成“识别—评估—复核—响应—整改—复检”业务闭环。演示结果仅供辅助决策。</p><div class="hero-actions">${canInternal('pilot', 'street', 'government') ? `<a class="btn btn-sm" href="#/inspections">${icon('plus')}新建巡检</a>` : ''}<a class="btn btn-sm" href="#/detections">查看识别结果 ${icon('arrow')}</a></div></div><div class="hero-art"><img src="../assets/civic-building.svg" alt="公共建筑健康巡检示意"></div></section>
      <section class="card">${cardHead('四级健康分布', '按设施当前风险等级统计', '<a class="text-link" href="#/facilities">设施台账 ' + icon('arrow') + '</a>')}${donutChart(grades)}</section>
      <section class="card">${cardHead('巡检趋势', '近期巡检任务完成趋势')}${trend.length ? `<div class="card-body">${trendChart(trend)}</div>` : emptyState('暂无趋势数据')}</section>
      <section class="card">${cardHead('街道风险分布', '设施规模与高风险设施对比')}<div class="street-list">${streetHtml}</div></section>
      <section class="card span-2">${cardHead('最近预警', '按预警产生时间展示', '<a class="text-link" href="#/detections">识别中心 ' + icon('arrow') + '</a>')}<div class="alert-list">${alertHtml}</div></section>
      <section class="card">${cardHead('快捷入口', '常用业务操作')}<div class="card-body"><div class="info-list"><a class="info-row" href="#/reviews"><span>专家复核工作台</span><strong>进入 ${icon('chevron')}</strong></a><a class="info-row" href="#/workorders"><span>整改工单跟踪</span><strong>进入 ${icon('chevron')}</strong></a>${canViewPage('public') ? `<a class="info-row" href="#/public"><span>公众线索处置</span><strong>进入 ${icon('chevron')}</strong></a>` : ''}${canViewPage('audit') ? `<a class="info-row" href="#/audit"><span>审计与监管报表</span><strong>进入 ${icon('chevron')}</strong></a>` : ''}</div></div></section>
    </div>`;
}

function renderFacilities(rows) {
  const f = filters.facilities;
  const categories = unique(...rows.map(row => row.category));
  const query = f.q.trim().toLowerCase();
  const filtered = rows.filter(row => (!query || `${row.name} ${row.address} ${row.streetName} ${row.communityName} ${row.manager}`.toLowerCase().includes(query)) && (!f.category || row.category === f.category) && (!f.grade || gradeKey(row.riskGrade) === f.grade));
  const cards = filtered.map(row => `<article class="card facility-card"><a class="facility-art" href="#/facility/${encodeURIComponent(row.id)}"><img src="${facilityArtwork(row.category)}" alt="${escapeHtml(row.category || '设施')}示意图" loading="lazy">${gradeBadge(row.riskGrade).replace('class="badge', 'class="badge facility-grade')}</a><div class="facility-body"><h3><a href="#/facility/${encodeURIComponent(row.id)}">${escapeHtml(row.name)}</a></h3><div class="facility-address">${icon('pin')}<span>${escapeHtml(row.address)}</span></div><div class="facility-tags"><span class="tag">${escapeHtml(row.category)}</span><span class="tag">${escapeHtml(row.streetName)}</span><span class="tag">${escapeHtml(row.communityName)}</span></div><div class="facility-foot"><span>管理人 <strong>${escapeHtml(row.manager || '未登记')}</strong></span><span>楼栋 <strong>${row.buildingCount ?? 0}</strong> · 建成年份 <strong>${escapeHtml(row.builtYear || '—')}</strong></span></div></div></article>`).join('');
  return `${pageHead('设施台账', '查询设施基础信息、风险等级与健康评估状态。', canInternal('government', 'street') ? primaryButton('new-facility', '新增设施', 'plus') : '')}
    ${filterToolbar(`${searchFilter('facilities', '设施名称 / 地址 / 管理人', f.q)}${selectFilter('设施类型', 'category', f.category, categories)}${selectFilter('风险等级', 'grade', f.grade, unique('I', 'II', 'III', 'IV', ...rows.map(row => gradeKey(row.riskGrade))))}<span class="filter-spacer"></span><button class="btn btn-secondary" type="button" data-action="clear-filters">${icon('refresh')}重置筛选</button>`)}
    ${filtered.length ? `<div class="facility-grid">${cards}</div>` : emptyState('暂无设施', '没有符合当前筛选条件的设施，请调整关键词或重置筛选。')}`;
}

function renderFacility(data, id) {
  const facility = data.facility || {};
  const buildings = data.buildings || [], components = data.components || [], inspections = data.recentInspections || [], assessments = data.assessments || [], orders = data.workorders || [];
  const buildingRows = buildings.map(row => `<tr><td><span class="cell-title"><strong>${escapeHtml(row.name)}</strong></span><span class="cell-sub mono">${escapeHtml(row.id)}</span></td><td>${escapeHtml(row.floors ?? '—')} 层</td><td>${escapeHtml(row.height ?? '—')} m</td><td>${escapeHtml(row.area ?? '—')} ㎡</td><td>${escapeHtml(row.structure)}</td><td>${escapeHtml(row.wallMaterial)}</td><td>${escapeHtml(row.roofType)}</td><td>${escapeHtml(row.builtYear)}</td></tr>`).join('');
  const inspectionRows = inspections.map(row => `<tr><td><span class="mono">${escapeHtml(row.taskNo || row.id)}</span></td><td>${escapeHtml(row.componentName || row.buildingName)}</td><td>${escapeHtml(row.scope)}</td><td>${escapeHtml(formatDateTime(row.plannedAt))}</td><td>${escapeHtml(row.assignee)}</td><td>${badge(row.status)}</td><td>${canInternal('pilot', 'street', 'government') && ['待分析', '分析中'].includes(row.status) ? actionButton('analyze', '轻量分析', row.id) : '<span class="cell-sub">无待执行分析</span>'}</td></tr>`).join('');
  const assessmentHtml = assessments.length ? assessments.map(row => `<div class="assessment-item"><div class="assessment-top"><strong>${escapeHtml(defectLabel(row.type))}</strong><span>${badge(row.status)}</span><small>${escapeHtml(formatDateTime(row.createdAt))}</small></div><div class="assessment-rec"><span>AI ${escapeHtml(gradeLabel(row.aiGrade))}${row.expertGrade ? ` · 专家 ${escapeHtml(gradeLabel(row.expertGrade))}` : ''}</span><span>${escapeHtml(text(row.recommendation) || '暂无处置建议')}</span></div></div>`).join('') : emptyState('暂无评估记录');
  const orderRows = orders.map(row => `<tr><td class="mono">${escapeHtml(row.orderNo || row.id)}</td><td>${escapeHtml(defectLabel(row.type))}</td><td>${gradeBadge(row.grade)}</td><td>${escapeHtml(row.unit)}</td><td>${escapeHtml(formatDate(row.dueAt))}</td><td>${badge(row.status)}</td><td>${actionButton('workorder-detail', '详情', row.id)}</td></tr>`).join('');
  return `${pageHead(facility.name || '设施详情', '设施档案、构件清单、健康评估与处置记录。', `<a class="btn btn-secondary" href="#/facilities">${icon('arrow')}返回台账</a>${canInternal('pilot', 'street', 'government') ? primaryButton('new-inspection', '发起巡检', 'clipboard') : ''}`)}
    <section class="detail-hero"><div class="detail-copy"><span class="eyebrow">FACILITY PROFILE · ${escapeHtml(facility.id || id)}</span><h1>${escapeHtml(facility.name)}</h1><p>${escapeHtml(facility.address)}</p><div class="detail-meta">${gradeBadge(facility.riskGrade)}<span class="tag">${escapeHtml(facility.category)}</span><span class="tag">${escapeHtml(facility.streetName)}</span><span class="tag">${escapeHtml(facility.communityName)}</span></div><div class="detail-facts"><div class="fact"><small>结构类型</small><strong>${escapeHtml(facility.structure || '—')}</strong></div><div class="fact"><small>建成年份</small><strong>${escapeHtml(facility.builtYear || '—')}</strong></div><div class="fact"><small>设施管理人</small><strong>${escapeHtml(facility.manager || '—')}</strong></div><div class="fact"><small>楼栋数量</small><strong>${facility.buildingCount ?? buildings.length} 栋</strong></div><div class="fact"><small>最新健康等级</small><strong>${escapeHtml(gradeLabel(facility.latestGrade))}</strong></div><div class="fact"><small>地理坐标</small><strong>${escapeHtml(facility.longitude ?? '—')}, ${escapeHtml(facility.latitude ?? '—')}</strong></div></div></div><div class="detail-art"><img src="${facilityArtwork(facility.category)}" alt="设施健康巡检示意图"></div></section>
    <div class="detail-grid"><div>
      <section class="card table-card" style="margin-bottom:18px">${cardHead('建筑清单', `${buildings.length} 栋建筑`)}${buildings.length ? `<div class="table-scroll"><table><thead><tr><th>建筑名称</th><th>层数</th><th>高度</th><th>面积</th><th>结构</th><th>墙体材料</th><th>屋面类型</th><th>建成年份</th></tr></thead><tbody>${buildingRows}</tbody></table></div>` : emptyState('暂无建筑')}</section>
      <section class="card table-card" style="margin-bottom:18px">${cardHead('近期巡检', '查看任务并触发轻量化分析')}${inspections.length ? `<div class="table-scroll"><table><thead><tr><th>任务编号</th><th>构件 / 建筑</th><th>范围</th><th>计划时间</th><th>负责人</th><th>状态</th><th>操作</th></tr></thead><tbody>${inspectionRows}</tbody></table></div>` : emptyState('暂无巡检记录')}</section>
      <section class="card table-card">${cardHead('关联工单', '整改处置跟踪')}${orders.length ? `<div class="table-scroll"><table><thead><tr><th>工单编号</th><th>缺陷类型</th><th>等级</th><th>处置单位</th><th>截止日期</th><th>状态</th><th>操作</th></tr></thead><tbody>${orderRows}</tbody></table></div>` : emptyState('暂无关联工单')}</section>
    </div><aside>
      <section class="card" style="margin-bottom:18px">${cardHead('构件清单', `${components.length} 个登记构件`)}<div class="card-body"><div class="component-grid">${components.length ? components.map(row => `<div class="component-item">${icon('layers')}<div><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.type)} · ${escapeHtml(IMPORTANCE_LABELS[row.importance] || row.importance || '未标注')}</small><small>${escapeHtml(row.location)}</small></div></div>`).join('') : emptyState('暂无构件')}</div></div></section>
      <section class="card">${cardHead('健康评估', 'AI 建议与专家意见')}<div class="card-body">${assessmentHtml}</div></section>
    </aside></div>`;
}

function renderInspections(rows) {
  const f = filters.inspections, query = f.q.trim().toLowerCase();
  const filtered = rows.filter(row => (!query || `${row.taskNo} ${row.facilityName} ${row.buildingName} ${row.componentName} ${row.assignee}`.toLowerCase().includes(query)) && (!f.status || row.status === f.status));
  const body = filtered.map(row => `<tr><td><strong class="mono">${escapeHtml(row.taskNo || row.id)}</strong><span class="cell-sub">${escapeHtml(row.externalTaskNo || '无外部任务号')}</span></td><td><span class="cell-title"><strong>${escapeHtml(row.facilityName)}</strong></span><span class="cell-sub">${escapeHtml(row.buildingName)} · ${escapeHtml(row.componentName)}</span></td><td>${escapeHtml(row.scope)}<span class="cell-sub">${escapeHtml(listText(row.sensors))}</span></td><td>${escapeHtml(formatDateTime(row.plannedAt))}</td><td>${escapeHtml(row.assignee)}</td><td>${badge(row.status)}</td><td><div class="confidence"><span class="progress"><i style="width:${Math.max(0, Math.min(100, Number(row.progress) || 0))}%"></i></span><strong>${Math.round(Number(row.progress) || 0)}%</strong></div></td><td><div class="row-actions">${canInternal('pilot', 'street', 'government') ? actionButton('inspection-status', '更新状态', row.id) : ''}${canInternal('pilot', 'street', 'government') && ['待分析', '分析中'].includes(row.status) ? actionButton('analyze', '轻量分析', row.id) : ''}</div></td></tr>`).join('');
  return `${pageHead('巡检任务', '制定轻量化体检任务，跟踪执行进度并生成缺陷分析。', canInternal('pilot', 'street', 'government') ? primaryButton('new-inspection', '新建巡检任务', 'plus') : '')}
    ${filterToolbar(`${searchFilter('inspections', '任务编号 / 设施 / 负责人', f.q)}${selectFilter('任务状态', 'status', f.status, statusOptions(rows, 'status', f.status))}<span class="filter-spacer"></span><button class="btn btn-secondary" type="button" data-action="clear-filters">${icon('refresh')}重置</button>`)}
    ${tableCard('任务列表', ['任务编号', '设施 / 构件', '巡检范围', '计划时间', '负责人', '状态', '进度', '操作'], body, '任务执行与 AI 分析入口')}`;
}

function bboxPreview(row) {
  const box = row.bbox || {};
  const x = Math.max(5, Math.min(75, Number(box.x) || 25)), y = Math.max(5, Math.min(65, Number(box.y) || 18));
  const width = Math.max(10, Math.min(90 - x, Number(box.width) || 22)), height = Math.max(8, Math.min(55 - y, Number(box.height) || 15));
  return `<span class="detection-thumb" aria-label="缺陷定位框示意"><span class="detection-box" style="left:${x / 2}px;top:${y / 2}px;width:${width / 2}px;height:${height / 2}px"></span></span>`;
}
function renderDetections(rows) {
  const f = filters.detections, query = f.q.trim().toLowerCase();
  const gradeOf = row => gradeKey(row.assessment?.expertGrade || row.assessment?.aiGrade || '');
  const filtered = rows.filter(row => (!query || `${row.facilityName} ${row.buildingName} ${row.componentName} ${row.type} ${row.subtype}`.toLowerCase().includes(query)) && (!f.reviewStatus || row.reviewStatus === f.reviewStatus) && (!f.grade || gradeOf(row) === f.grade));
  const body = filtered.map(row => {
    const geometry = row.geometry || {}, assessment = row.assessment;
    return `<tr><td>${bboxPreview(row)}</td><td><span class="cell-title"><strong>${escapeHtml(row.facilityName)}</strong></span><span class="cell-sub">${escapeHtml(row.buildingName)} · ${escapeHtml(row.componentName)}</span></td><td><strong>${escapeHtml(defectLabel(row.type))}</strong><span class="cell-sub">${escapeHtml(row.subtype)}</span></td><td>${escapeHtml([geometry.length, geometry.width].filter(v => v !== undefined && v !== null).map(decimal).join(' × '))} ${escapeHtml(geometry.unit || '')}<span class="cell-sub">${escapeHtml(geometry.severity)}</span></td><td><div class="confidence"><span class="progress"><i style="width:${confidenceValue(row.confidence)}%"></i></span><strong>${confidenceValue(row.confidence)}%</strong></div><span class="cell-sub">${escapeHtml(row.modelVersion)}</span></td><td>${assessment ? `<span class="cell-title">${gradeBadge(assessment.expertGrade || assessment.aiGrade)}</span><span class="cell-sub">${escapeHtml(assessment.status)}</span>` : '<span class="tag">待生成评估</span>'}</td><td>${badge(row.reviewStatus || '待复核')}</td><td><div class="row-actions">${canInternal('government', 'expert', 'street') ? `${!assessment || assessment.status === '待重新评估' ? actionButton('create-assessment', assessment ? '重新评估' : '生成评估', row.id) : ''}${actionButton('review-detection', '人工复核', row.id)}` : ''}</div></td></tr>`;
  }).join('');
  return `${pageHead('AI 缺陷识别', '查看识别结果、几何量与置信度，并进行人工复核。', `<span class="tag">AI 结果需专家复核</span>`)}
    ${filterToolbar(`${searchFilter('detections', '设施 / 构件 / 缺陷类型', f.q)}${selectFilter('复核状态', 'reviewStatus', f.reviewStatus, statusOptions(rows, 'reviewStatus', f.reviewStatus))}${selectFilter('健康等级', 'grade', f.grade, ['I', 'II', 'III', 'IV'])}<span class="filter-spacer"></span><button class="btn btn-secondary" type="button" data-action="clear-filters">${icon('refresh')}重置</button>`)}
    ${tableCard('识别记录', ['定位', '设施 / 构件', '缺陷类型', '几何量', '模型置信度', '评估等级', '复核状态', '操作'], body, '模型版本与定位框来自接口记录')}`;
}

function renderReviews(rows) {
  const f = filters.reviews, query = f.q.trim().toLowerCase();
  const filtered = rows.filter(row => (!query || `${row.id} ${row.assessmentId} ${row.facilityName} ${row.type} ${row.expertName}`.toLowerCase().includes(query)) && (!f.status || row.status === f.status));
  const body = filtered.map(row => `<tr><td><strong class="mono">${escapeHtml(row.id)}</strong><span class="cell-sub">评估 ${escapeHtml(row.assessmentId)}</span></td><td><strong>${escapeHtml(row.facilityName)}</strong><span class="cell-sub">${escapeHtml(defectLabel(row.type))}</span></td><td>${gradeBadge(row.aiGrade)}<span class="cell-sub">${row.expertGrade ? `专家 ${escapeHtml(row.expertGrade)}` : '暂无专家定级'}</span></td><td>${escapeHtml(row.expertName)}<span class="cell-sub">${escapeHtml(row.expertId)}</span></td><td>${badge(row.status)}</td><td>${escapeHtml(formatDateTime(row.dueAt))}<span class="cell-sub">派单 ${escapeHtml(formatDateTime(row.assignedAt))}</span></td><td>${escapeHtml(row.conclusion || '—')}<span class="cell-sub">${escapeHtml(row.completedAt ? formatDateTime(row.completedAt) : '尚未完成')}</span></td><td>${canInternal('expert', 'government', 'street') ? actionButton('update-review', row.status === '待接单' ? '接单处理' : '复核处理', row.id) : ''}</td></tr>`).join('');
  return `${pageHead('专家复核', '对 III / IV 级评估开展专业复核，记录结论与专家定级。', `<span class="tag">规则待专家评审</span>`)}
    ${filterToolbar(`${searchFilter('reviews', '设施 / 评估编号 / 专家', f.q)}${selectFilter('复核状态', 'status', f.status, ['待接单', '复核中', '已完成', '退回补充', ...statusOptions(rows, 'status', f.status)])}<span class="filter-spacer"></span><button class="btn btn-secondary" type="button" data-action="clear-filters">${icon('refresh')}重置</button>`)}
    ${tableCard('复核任务', ['复核编号', '设施 / 类型', 'AI / 专家等级', '专家', '状态', '时限', '结论', '操作'], body)}`;
}

function renderResponses(rows) {
  const f = filters.responses, query = f.q.trim().toLowerCase();
  const filtered = rows.filter(row => (!query || `${row.facilityName} ${row.type} ${row.department} ${row.owner}`.toLowerCase().includes(query)) && (!f.status || row.status === f.status));
  const body = filtered.map(row => `<tr><td><strong class="mono">${escapeHtml(row.id)}</strong><span class="cell-sub">评估 ${escapeHtml(row.assessmentId)}</span></td><td><strong>${escapeHtml(row.facilityName)}</strong><span class="cell-sub">${escapeHtml(defectLabel(row.type))}</span></td><td>${gradeBadge(row.grade)}</td><td>${escapeHtml(row.department)}<span class="cell-sub">${escapeHtml(row.owner)}</span></td><td>${escapeHtml(formatDateTime(row.dueAt))}<span class="cell-sub">接收 ${escapeHtml(formatDateTime(row.receivedAt))}</span></td><td>${badge(row.status)}</td><td>${escapeHtml(row.responseHours ?? '—')} 小时<span class="cell-sub">响应 ${escapeHtml(formatDateTime(row.respondedAt))}</span></td><td>${escapeHtml(row.action || '尚未填写处置说明')}</td><td>${canInternal('government', 'street') ? actionButton('update-response', '响应处置', row.id) : ''}</td></tr>`).join('');
  return `${pageHead('部门响应', '跟踪风险告知后的部门响应与处置说明。')}
    ${filterToolbar(`${searchFilter('responses', '设施 / 部门 / 负责人', f.q)}${selectFilter('响应状态', 'status', f.status, ['待响应', '已响应', '处置中', '已完成', ...statusOptions(rows, 'status', f.status)])}<span class="filter-spacer"></span><button class="btn btn-secondary" type="button" data-action="clear-filters">${icon('refresh')}重置</button>`)}
    ${tableCard('响应台账', ['响应编号', '设施 / 类型', '等级', '责任部门', '时限', '状态', '响应时长', '处置说明', '操作'], body)}`;
}

function workorderEvents(row) {
  const events = row.events || [];
  return events.length ? `<div class="timeline">${events.map(event => `<div class="timeline-item"><span class="timeline-dot">${icon('check')}</span><div class="timeline-content"><strong>${escapeHtml(event.status)}</strong><small>${escapeHtml(event.operator)} · ${escapeHtml(formatDateTime(event.createdAt))}</small><p>${escapeHtml(event.note || '无补充说明')}</p></div></div>`).join('')}</div>` : emptyState('暂无流转记录');
}
function renderWorkorders(rows) {
  const f = filters.workorders, query = f.q.trim().toLowerCase();
  const filtered = rows.filter(row => (!query || `${row.orderNo} ${row.facilityName} ${row.buildingName} ${row.type} ${row.unit} ${row.owner}`.toLowerCase().includes(query)) && (!f.status || row.status === f.status));
  const body = filtered.map(row => `<tr><td><strong class="mono">${escapeHtml(row.orderNo || row.id)}</strong><span class="cell-sub">检测 ${escapeHtml(row.detectionId)}</span></td><td><strong>${escapeHtml(row.facilityName)}</strong><span class="cell-sub">${escapeHtml(row.buildingName)} · ${escapeHtml(defectLabel(row.type))}</span></td><td>${gradeBadge(row.grade)}</td><td>${escapeHtml(row.unit)}<span class="cell-sub">${escapeHtml(row.owner)}</span></td><td>${escapeHtml(formatDateTime(row.dueAt))}</td><td>${badge(row.status)}</td><td>${escapeHtml(row.requirement)}</td><td>${escapeHtml(formatDateTime(row.updatedAt))}</td><td><div class="row-actions">${actionButton('workorder-detail', '详情', row.id)}${canInternal('acceptance', 'street', 'government') && row.status === '待复检' ? actionButton('acceptance', '提交复检', row.id) : ''}${canInternal('repair', 'property', 'street', 'government') ? actionButton('workorder-update', '流转', row.id) : ''}</div></td></tr>`).join('');
  return `${pageHead('整改工单', '覆盖派单、接单、整改、复检与销号全过程。', canInternal('government', 'street', 'property') ? primaryButton('new-workorder', '新建工单', 'plus') : '')}
    ${filterToolbar(`${searchFilter('workorders', '工单号 / 设施 / 单位', f.q)}${selectFilter('工单状态', 'status', f.status, ['待派单', '待接单', '处理中', '待复检', '整改不通过', '已销号', '已取消', ...statusOptions(rows, 'status', f.status)])}<span class="filter-spacer"></span><button class="btn btn-secondary" type="button" data-action="clear-filters">${icon('refresh')}重置</button>`)}
    ${tableCard('工单列表', ['工单编号', '设施 / 缺陷', '等级', '处置单位', '截止时间', '状态', '整改要求', '最近更新', '操作'], body)}`;
}

function renderPublic(rows) {
  const f = filters.public, query = f.q.trim().toLowerCase();
  const filtered = rows.filter(row => (!query || `${row.code} ${row.type} ${row.description} ${row.location}`.toLowerCase().includes(query)) && (!f.status || row.status === f.status));
  const body = filtered.map(row => `<tr><td><strong class="mono">${escapeHtml(row.code || row.id)}</strong><span class="cell-sub">${escapeHtml(formatDateTime(row.createdAt))}</span></td><td><strong>${escapeHtml(defectLabel(row.type))}</strong><span class="cell-sub">${escapeHtml(row.location)}</span></td><td>${badge(row.status)}</td><td>${escapeHtml(ratioPercent(row.confidence))}<span class="cell-sub">质量分 ${escapeHtml(ratioPercent(row.qualityScore))}</span></td><td>${escapeHtml(row.feedback || '尚未反馈')}</td><td><div class="row-actions">${actionButton('public-detail', '查看线索', row.id)}${canInternal('government', 'street', 'community', 'expert') ? actionButton('public-update', '处理线索', row.id) : ''}</div></td></tr>`).join('');
  return `${pageHead('公众线索', '汇集市民提交的设施隐患线索，开展核查与反馈。', `<a class="btn btn-secondary" href="../citizen/index.html" target="_blank" rel="noopener">${icon('external')}打开公众端</a>`)}
    ${filterToolbar(`${searchFilter('public', '报告编号 / 类型 / 位置', f.q)}${selectFilter('线索状态', 'status', f.status, statusOptions(rows, 'status', f.status))}<span class="filter-spacer"></span><button class="btn btn-secondary" type="button" data-action="clear-filters">${icon('refresh')}重置</button>`)}
    ${tableCard('线索台账', ['报告编号', '线索类型', '位置与描述', '状态', '识别质量', '反馈', '操作'], body, '公众端仅反馈进度，不公开内部缺陷与专家意见')}`;
}

function renderAudit(rows) {
  const f = filters.audit, query = f.q.trim().toLowerCase();
  const actions = unique(...rows.map(row => row.action));
  const filtered = rows.filter(row => (!query || `${row.userName} ${row.action} ${row.objectType} ${row.objectId} ${row.summary}`.toLowerCase().includes(query)) && (!f.action || row.action === f.action));
  const body = filtered.map(row => `<tr><td class="mono">${escapeHtml(row.id)}</td><td>${escapeHtml(row.userName)}</td><td>${escapeHtml(row.action)}</td><td>${escapeHtml(row.objectType)}<span class="cell-sub mono">${escapeHtml(row.objectId)}</span></td><td>${escapeHtml(row.summary)}</td><td>${escapeHtml(formatDateTime(row.createdAt))}</td></tr>`).join('');
  return `${pageHead('审计日志', '记录关键业务操作，支持监管报表导出与追溯。', `<button class="btn btn-primary" type="button" data-action="export">${icon('download')}导出监管报表</button>`)}
    ${filterToolbar(`${searchFilter('audit', '用户 / 对象 / 操作摘要', f.q)}${selectFilter('操作类型', 'action', f.action, actions)}<span class="filter-spacer"></span><button class="btn btn-secondary" type="button" data-action="clear-filters">${icon('refresh')}重置</button>`)}
    ${tableCard('操作记录', ['日志编号', '操作人', '动作', '对象', '操作摘要', '发生时间'], body, '日志数据由服务端记录')}`;
}

function openFacilityForm() {
  openModal({
    title: '新增设施', wide: true,
    content: `<form id="facility-create-form" data-form="facility-create"><div class="form-grid">
      ${formField({ label: '设施名称', name: 'name', required: true, placeholder: '请输入设施名称' })}
      ${formField({ label: '设施类型', name: 'category', required: true, placeholder: '如：住宅建筑 / 公共建筑' })}
      ${formField({ label: '详细地址', name: 'address', required: true, placeholder: '请输入街道、门牌等地址' })}
      ${formField({ label: '管理人', name: 'manager', required: true, placeholder: '姓名或管理单位' })}
      ${formField({ label: '街道编号', name: 'streetId', required: true, placeholder: '请输入街道 ID' })}
      ${formField({ label: '社区编号', name: 'communityId', required: true, placeholder: '请输入社区 ID' })}
      ${formField({ label: '建成年份', name: 'builtYear', type: 'number', min: 1800, max: 2100, placeholder: '如 2010' })}
      ${formField({ label: '结构类型', name: 'structure', placeholder: '如：钢筋混凝土结构' })}
      ${formField({ label: '经度', name: 'longitude', type: 'number', step: 'any', placeholder: '如 120.16' })}
      ${formField({ label: '纬度', name: 'latitude', type: 'number', step: 'any', placeholder: '如 30.27' })}
    </div><p class="form-tip">${icon('info')}新增设施后，楼栋与构件信息需在后续业务流程中完善。</p></form>`,
    footer: `<button class="btn btn-secondary" type="button" data-close-modal>取消</button><button class="btn btn-primary" type="submit" form="facility-create-form">${icon('check')}保存设施</button>`
  });
}

function openInspectionForm(preFacilityId = '') {
  openModal({
    title: '新建巡检任务', wide: true,
    content: `<form id="inspection-create-form" data-form="inspection-create"><div class="form-grid">
      ${formField({ label: '设施 ID', name: 'facilityId', required: true, value: preFacilityId, placeholder: '请输入设施 ID' })}
      ${formField({ label: '建筑 ID', name: 'buildingId', required: true, placeholder: '请输入建筑 ID' })}
      ${formField({ label: '构件 ID', name: 'componentId', required: true, placeholder: '请输入待检构件 ID' })}
      ${formField({ label: '巡检范围', name: 'scope', required: true, placeholder: '如：屋面、外墙、主体结构' })}
      ${formField({ label: '传感器 / 采集方式', name: 'sensors', placeholder: '多个以逗号分隔，如：可见光,红外' })}
      ${formField({ label: '计划时间', name: 'plannedAt', type: 'datetime-local', required: true })}
      ${formField({ label: '负责人', name: 'assignee', required: true, placeholder: '巡检人员姓名' })}
      ${formField({ label: '外部任务编号', name: 'externalTaskNo', placeholder: '可选' })}
    </div></form>`,
    footer: `<button class="btn btn-secondary" type="button" data-close-modal>取消</button><button class="btn btn-primary" type="submit" form="inspection-create-form">${icon('plus')}创建任务</button>`
  });
}

function openInspectionStatus(row) {
  const statuses = unique('待执行', '采集中', '待上传', '数据质检中', '待分析', '分析中', '已完成', '异常终止', row.status);
  openModal({
    title: '更新巡检状态', content: `<form id="inspection-status-form" data-form="inspection-status" data-id="${escapeHtml(row.id)}"><div class="form-grid">
      <div class="full info-row"><span>任务编号</span><strong>${escapeHtml(row.taskNo || row.id)}</strong></div>
      <div class="full info-row"><span>设施名称</span><strong>${escapeHtml(row.facilityName)}</strong></div>
      ${formField({ label: '任务状态', name: 'status', required: true, value: row.status, options: statuses })}
    </div></form>`,
    footer: `<button class="btn btn-secondary" type="button" data-close-modal>取消</button><button class="btn btn-primary" type="submit" form="inspection-status-form">保存状态</button>`
  });
}

function openAnalyze(row) {
  openModal({
    title: '轻量化缺陷分析', wide: true,
    content: `<form id="analyze-form" data-form="analyze" data-id="${escapeHtml(row.id)}"><div class="form-grid">
      <div class="full info-row"><span>巡检任务</span><strong>${escapeHtml(row.taskNo || row.id)} · ${escapeHtml(row.facilityName)}</strong></div>
      ${formField({ label: '缺陷类型', name: 'defectType', required: true, options: Object.entries(DEFECT_LABELS).map(([value, label]) => [value, label]) })}
      ${formField({ label: '严重程度（0—100）', name: 'severity', type: 'number', required: true, min: 0, max: 100, placeholder: '数值越大表示几何异常越严重' })}
      ${formField({ label: '构件重要性', name: 'componentImportance', required: true, options: [['low', '一般构件'], ['medium', '重要构件'], ['high', '关键构件'], ['structural', '主体结构构件']] })}
      ${formField({ label: '环境指数（0—100）', name: 'environment', type: 'number', required: true, min: 0, max: 100, placeholder: '综合潮湿、冻融、高温等影响' })}
      ${formField({ label: '缺陷位置', name: 'location', required: true, placeholder: '如：屋面东侧 / 3 层外墙' })}
    </div><p class="form-tip">${icon('info')}分析结果由服务端规则生成，仅作为 AI 辅助评估，需经复核后使用。</p></form>`,
    footer: `<button class="btn btn-secondary" type="button" data-close-modal>取消</button><button class="btn btn-primary" type="submit" form="analyze-form">${icon('spark')}开始分析</button>`
  });
}

function analysisResultHtml(result) {
  const assessment = result.assessment || {};
  const dimensions = Object.entries(assessment.dimensions || {}).map(([key, item]) => {
    const label = key === 'component' ? IMPORTANCE_LABELS[item.value] || item.label : item.label;
    const name = key === 'defectType' ? '缺陷类型' : key === 'geometry' ? '几何与分布' : key === 'component' ? '构件重要性' : key === 'environment' ? '环境因素' : key;
    return infoRow(`评分维度 · ${name}`, `${label || '—'}：${item.score ?? '—'} / ${item.max ?? '—'} 分`);
  }).join('');
  return `<div class="info-list">${infoRow('识别分析', `${result.analysis?.status || '成功'} · ${result.analysis?.modelVersion || 'demo-vision-0.1'}`)}${infoRow('分析记录 ID', result.analysis?.id)}${infoRow('识别记录 ID', result.detection?.id)}${infoRow('评估 ID', assessment.id)}${infoRow('AI 健康等级', gradeLabel(assessment.aiGrade))}${infoRow('综合得分', `${assessment.totalScore ?? '—'} / 100`)}${dimensions}${infoRow('复核任务 ID', result.review?.id || '无需生成')}${infoRow('处置建议', assessment.recommendation)}</div><p class="form-tip">${icon('info')}${escapeHtml(assessment.disclaimer || '演示规则生成，不构成正式安全鉴定。')}</p>`;
}

function openDetectionReview(row) {
  openModal({
    title: '人工复核识别结果', wide: true,
    content: `<form id="detection-review-form" data-form="detection-review" data-id="${escapeHtml(row.id)}"><div class="form-grid">
      <div class="full info-row"><span>设施 / 构件</span><strong>${escapeHtml(row.facilityName)} · ${escapeHtml(row.componentName)}</strong></div>
      <div class="full info-row"><span>AI 识别</span><strong>${escapeHtml(defectLabel(row.type))} / ${escapeHtml(row.subtype)} · 置信度 ${confidenceValue(row.confidence)}%</strong></div>
      ${formField({ label: '复核结论', name: 'status', required: true, options: ['确认', '修正', '否决'], value: row.reviewStatus && ['确认', '修正', '否决'].includes(row.reviewStatus) ? row.reviewStatus : '确认' })}
      ${formField({ label: '缺陷类型', name: 'defectType', options: [['', '请选择修正后的类型'], ...Object.entries(DEFECT_LABELS).map(([value, label]) => [value, label])], value: row.reviewStatus === '修正' ? row.type : '', help: '选择“修正”时必须指定修正后的缺陷类型。' })}
      ${formField({ label: '复核说明', name: 'note', type: 'textarea', required: true, placeholder: '请填写判断依据或修正内容' })}
    </div></form>`,
    footer: `<button class="btn btn-secondary" type="button" data-close-modal>取消</button><button class="btn btn-primary" type="submit" form="detection-review-form">提交复核</button>`
  });
}

function openReviewForm(row) {
  openModal({
    title: '专家复核处理', wide: true,
    content: `<form id="review-update-form" data-form="review-update" data-id="${escapeHtml(row.id)}"><div class="form-grid">
      <div class="full info-row"><span>设施 / 缺陷</span><strong>${escapeHtml(row.facilityName)} · ${escapeHtml(defectLabel(row.type))}</strong></div>
      <div class="full info-row"><span>AI 评估等级</span><strong>${escapeHtml(gradeLabel(row.aiGrade))}</strong></div>
      ${formField({ label: '复核状态', name: 'status', required: true, value: row.status, options: ['待接单', '复核中', '已完成', '退回补充'] })}
      ${formField({ label: '专家定级', name: 'expertGrade', options: [['', '暂不定级'], ['I', 'I 级'], ['II', 'II 级'], ['III', 'III 级'], ['IV', 'IV 级']], value: row.expertGrade || '' })}
      ${formField({ label: '复核结论', name: 'conclusion', value: row.conclusion, placeholder: '完成复核时必填' })}
      ${formField({ label: '专家意见', name: 'opinion', type: 'textarea', value: row.opinion, placeholder: '完成复核时必填：专业判断、依据与处置建议' })}
    </div></form>`,
    footer: `<button class="btn btn-secondary" type="button" data-close-modal>取消</button><button class="btn btn-primary" type="submit" form="review-update-form">保存复核</button>`
  });
}

function openResponseForm(row) {
  openModal({
    title: '部门响应处置',
    content: `<form id="response-update-form" data-form="response-update" data-id="${escapeHtml(row.id)}"><div class="form-grid">
      <div class="full info-row"><span>设施 / 等级</span><strong>${escapeHtml(row.facilityName)} · ${escapeHtml(gradeLabel(row.grade))}</strong></div>
      ${formField({ label: '响应状态', name: 'status', required: true, value: row.status, options: selectedOptions(['待响应', '已响应', '处置中', '已完成', '已取消'], row.status) })}
      ${formField({ label: '处置说明', name: 'action', type: 'textarea', required: true, value: row.action, placeholder: '请填写已采取措施与后续计划' })}
    </div></form>`,
    footer: `<button class="btn btn-secondary" type="button" data-close-modal>取消</button><button class="btn btn-primary" type="submit" form="response-update-form">保存响应</button>`
  });
}

function openWorkorderForm() {
  openModal({
    title: '新建整改工单', wide: true,
    content: `<form id="workorder-create-form" data-form="workorder-create"><div class="form-grid">
      ${formField({ label: '评估 ID', name: 'assessmentId', required: true, placeholder: '请输入健康评估 ID' })}
      ${formField({ label: '处置单位', name: 'unit', required: true, placeholder: '维修 / 物业单位' })}
      ${formField({ label: '工单负责人', name: 'owner', required: true, placeholder: '请输入负责人' })}
      ${formField({ label: '整改截止时间', name: 'dueAt', type: 'datetime-local', required: true })}
      ${formField({ label: '整改要求', name: 'requirement', type: 'textarea', required: true, placeholder: '明确缺陷位置、整改标准与验收要求' })}
    </div></form>`,
    footer: `<button class="btn btn-secondary" type="button" data-close-modal>取消</button><button class="btn btn-primary" type="submit" form="workorder-create-form">创建工单</button>`
  });
}

function openWorkorderUpdate(row) {
  openModal({
    title: '工单状态流转',
    content: `<form id="workorder-update-form" data-form="workorder-update" data-id="${escapeHtml(row.id)}"><div class="form-grid">
      <div class="full info-row"><span>工单编号</span><strong>${escapeHtml(row.orderNo || row.id)}</strong></div>
      <div class="full info-row"><span>当前状态</span><strong>${escapeHtml(row.status)}</strong></div>
      ${formField({ label: '目标状态', name: 'status', required: true, value: row.status, options: ['待派单', '待接单', '处理中', '待复检', '整改不通过', '已销号', '已取消'] })}
      ${formField({ label: '流转说明', name: 'note', type: 'textarea', required: true, placeholder: '填写本次处理进展或状态变更依据' })}
    </div></form>`,
    footer: `<button class="btn btn-secondary" type="button" data-close-modal>取消</button><button class="btn btn-primary" type="submit" form="workorder-update-form">确认流转</button>`
  });
}

function openAcceptance(row) {
  openModal({
    title: '整改复检申请', wide: true,
    content: `<form id="acceptance-form" data-form="acceptance" data-id="${escapeHtml(row.id)}"><div class="form-grid">
      <div class="full info-row"><span>工单 / 设施</span><strong>${escapeHtml(row.orderNo || row.id)} · ${escapeHtml(row.facilityName)}</strong></div>
      ${formField({ label: '复检结论', name: 'result', required: true, options: ['通过', '不通过'] })}
      ${formField({ label: '复检人', name: 'reviewer', required: true, placeholder: '请输入复检人员姓名' })}
      ${formField({ label: '整改前照片', name: 'beforePhoto', type: 'file', accept: 'image/jpeg,image/png,image/webp', help: '支持 JPG / PNG / WebP，单张不超过 8MB' })}
      ${formField({ label: '整改后照片', name: 'afterPhoto', type: 'file', accept: 'image/jpeg,image/png,image/webp', help: '支持 JPG / PNG / WebP，单张不超过 8MB' })}
      ${formField({ label: '复检意见', name: 'opinion', type: 'textarea', required: true, placeholder: '请填写现场核查情况与验收意见' })}
    </div></form>`,
    footer: `<button class="btn btn-secondary" type="button" data-close-modal>取消</button><button class="btn btn-primary" type="submit" form="acceptance-form">提交复检</button>`
  });
}

function acceptanceRecordsHtml(records = []) {
  if (!records.length) return emptyState('暂无复检记录');
  return records.map(record => `<section class="acceptance-record"><div class="info-row"><span>复检结论</span><strong>${escapeHtml(record.result)} · ${escapeHtml(record.reviewer)}</strong></div><p>${escapeHtml(record.opinion)}</p>${record.beforePhoto || record.afterPhoto ? `<div class="acceptance-photos">${record.beforePhoto ? `<figure><img src="${escapeHtml(record.beforePhoto)}" alt="整改前照片" loading="lazy"><figcaption>整改前</figcaption></figure>` : ''}${record.afterPhoto ? `<figure><img src="${escapeHtml(record.afterPhoto)}" alt="整改后照片" loading="lazy"><figcaption>整改后</figcaption></figure>` : ''}</div>` : ''}</section>`).join('');
}
function openWorkorderDetail(row) {
  openModal({
    title: '工单详情与流转记录', drawer: true,
    content: `<div class="info-list">${infoRow('工单编号', row.orderNo || row.id)}${infoRow('关联评估', row.assessmentId)}${infoRow('设施 / 建筑', `${row.facilityName} / ${row.buildingName}`)}${infoRow('缺陷 / 等级', `${defectLabel(row.type)} / ${gradeLabel(row.grade)}`)}${infoRow('处置单位 / 负责人', `${row.unit} / ${row.owner}`)}${infoRow('当前状态', row.status)}${infoRow('整改截止', formatDateTime(row.dueAt))}${infoRow('整改要求', row.requirement)}</div><h3 class="detail-subtitle">流转时间线</h3>${workorderEvents(row)}<h3 class="detail-subtitle">复检记录</h3>${acceptanceRecordsHtml(row.acceptances)}`,
    footer: `<button class="btn btn-secondary" type="button" data-close-modal>关闭</button>${canInternal('acceptance', 'street', 'government') && row.status === '待复检' ? `<button class="btn btn-primary" type="button" data-action="acceptance" data-id="${escapeHtml(row.id)}">提交复检</button>` : ''}`
  });
}

function openPublicDetail(row) {
  openModal({
    title: '公众线索详情', drawer: true,
    content: `<div class="public-detail"><div class="info-list">${infoRow('报告编号', row.code || row.id)}${infoRow('线索类型', row.type)}${infoRow('线索位置', row.location)}${infoRow('提交时间', formatDateTime(row.createdAt))}${infoRow('当前状态', row.status)}${infoRow('质量评分', row.qualityScore)}${infoRow('识别置信度', row.confidence)}</div><h3 class="detail-subtitle">线索描述</h3><p>${escapeHtml(row.description)}</p><div class="feedback"><strong>已反馈内容</strong><p>${escapeHtml(row.feedback || '尚未反馈')}</p></div><p class="form-tip">${icon('shield')}请勿向公众反馈内部缺陷详情、专家意见或建筑敏感信息。</p></div>`,
    footer: `<button class="btn btn-secondary" type="button" data-close-modal>关闭</button>${canInternal('government', 'street', 'community', 'expert') ? `<button class="btn btn-primary" type="button" data-action="public-update" data-id="${escapeHtml(row.id)}">处理线索</button>` : ''}`
  });
}

function openPublicUpdate(row) {
  const statuses = ['待筛查', '补充材料', '待专家复核', '复核中', '已确认', '未采纳', '已转工单', '已归档'];
  openModal({
    title: '处理公众线索', wide: true,
    content: `<form id="public-update-form" data-form="public-update" data-id="${escapeHtml(row.id)}"><div class="form-grid">
      <div class="full info-row"><span>报告编号</span><strong>${escapeHtml(row.code || row.id)}</strong></div>
      ${formField({ label: '处理状态', name: 'status', required: true, value: row.status, options: statuses })}
      ${formField({ label: '公众反馈', name: 'feedback', type: 'textarea', required: true, value: row.feedback, help: '仅填写处理进度与安全提示，不展示内部缺陷或专家意见。' })}
    </div></form>`,
    footer: `<button class="btn btn-secondary" type="button" data-close-modal>取消</button><button class="btn btn-primary" type="submit" form="public-update-form">保存处理结果</button>`
  });
}

function setFormBusy(form, busy) {
  const button = form.closest('.modal')?.querySelector('button[type="submit"]') || form.querySelector('button[type="submit"]');
  if (!button) return;
  if (busy) {
    button.dataset.original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="spinner" style="width:14px;height:14px"></span>提交中…';
  } else {
    button.disabled = false;
    if (button.dataset.original) button.innerHTML = button.dataset.original;
  }
}
async function fileData(file) {
  if (!file || !file.size) return '';
  if (file.size > 8 * 1024 * 1024) throw new Error('照片大小不能超过 8MB。');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('照片读取失败，请重新选择。'));
    reader.readAsDataURL(file);
  });
}
function localDateTime(value) {
  if (!value) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

document.addEventListener('submit', async event => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  if (!form.reportValidity()) return;
  const kind = form.dataset.form, id = form.dataset.id;
  let body = Object.fromEntries(new FormData(form).entries());
  let path = '', method = 'POST', message = '操作成功';
  let showAnalysis = false;
  try {
    if (kind === 'facility-create') {
      path = '/api/facilities'; message = '设施已新增';
      body.builtYear = body.builtYear ? Number(body.builtYear) : undefined;
      body.longitude = body.longitude ? Number(body.longitude) : undefined;
      body.latitude = body.latitude ? Number(body.latitude) : undefined;
    } else if (kind === 'inspection-create') {
      path = '/api/inspections'; message = '巡检任务已创建';
      body.sensors = body.sensors ? body.sensors.split(/[,，]/).map(v => v.trim()).filter(Boolean) : [];
      body.plannedAt = localDateTime(body.plannedAt);
    } else if (kind === 'inspection-status') {
      path = `/api/inspections/${encodeURIComponent(id)}/status`; method = 'PATCH'; message = '巡检状态已更新';
    } else if (kind === 'analyze') {
      path = `/api/inspections/${encodeURIComponent(id)}/analyze`; message = '分析完成'; showAnalysis = true;
      body.severity = Number(body.severity);
      body.environment = Number(body.environment);
    } else if (kind === 'detection-review') {
      path = `/api/detections/${encodeURIComponent(id)}/review`; method = 'POST'; message = '复核结果已提交';
      if (body.status === '修正' && !body.defectType) {
        toast('修正检测结果时必须选择缺陷类型', 'error'); return;
      }
      if (body.status !== '修正') delete body.defectType;
    } else if (kind === 'review-update') {
      if (body.status === '已完成' && (!body.expertGrade || !body.conclusion?.trim() || !body.opinion?.trim())) {
        toast('完成复核时必须填写专家定级、复核结论与专家意见', 'error'); return;
      }
      path = `/api/reviews/${encodeURIComponent(id)}`; method = 'PATCH'; message = '专家复核已保存';
      if (!body.expertGrade) delete body.expertGrade;
    } else if (kind === 'response-update') {
      path = `/api/responses/${encodeURIComponent(id)}`; method = 'PATCH'; message = '部门响应已保存';
    } else if (kind === 'public-update') {
      path = `/api/public/reports/${encodeURIComponent(id)}`; method = 'PATCH'; message = '公众线索处理结果已保存';
    } else if (kind === 'workorder-create') {
      path = '/api/workorders'; message = '整改工单已创建'; body.dueAt = localDateTime(body.dueAt);
    } else if (kind === 'workorder-update') {
      path = `/api/workorders/${encodeURIComponent(id)}`; method = 'PATCH'; message = '工单状态已流转';
    } else if (kind === 'acceptance') {
      path = `/api/workorders/${encodeURIComponent(id)}/acceptance`; message = '复检结果已提交';
      setFormBusy(form, true);
      body.beforePhoto = await fileData(body.beforePhoto);
      body.afterPhoto = await fileData(body.afterPhoto);
    } else return;
    setFormBusy(form, true);
    const result = await api(path, { method, body });
    closeModal(); toast(message); await render();
    if (showAnalysis) {
      openModal({ title: '分析结果', wide: true, content: analysisResultHtml(result), footer: `<button class="btn btn-primary" type="button" data-close-modal>完成</button>` });
    }
  } catch (error) {
    setFormBusy(form, false); toast(error.message, 'error');
  }
});

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action, id = button.dataset.id;
  const rowsFor = async path => api(path);
  try {
    if (action === 'retry') { await render(); return; }
    if (action === 'clear-filters') {
      clearTimeout(searchTimer);
      const key = routeFromHash().name;
      if (filters[key]) {
        Object.keys(filters[key]).forEach(name => { filters[key][name] = ''; });
        if (!redrawList(key)) await render();
        else restoreFilterFocus('[data-filter="q"]');
      }
      return;
    }
    if (action === 'new-facility') openFacilityForm();
    else if (action === 'new-inspection') openInspectionForm(id || '');
    else if (action === 'export') {
      button.disabled = true; button.innerHTML = '<span class="spinner" style="width:14px;height:14px"></span>导出中…';
      const blob = await api('/api/export/regulation.csv', { responseType: 'blob' });
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `监管报表_${new Date().toISOString().slice(0, 10)}.csv`; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000); toast('监管报表已导出');
    } else if (['inspection-status', 'analyze'].includes(action)) {
      const rows = await rowsFor('/api/inspections');
      const row = rows.find(item => String(item.id) === String(id));
      if (!row) throw new Error('未找到该巡检任务。');
      if (action === 'inspection-status') openInspectionStatus(row);
      else openAnalyze(row);
    } else if (['workorder-update', 'acceptance', 'workorder-detail'].includes(action)) {
      const orders = await rowsFor('/api/workorders'); const order = orders.find(item => String(item.id) === String(id));
      if (!order) throw new Error('未找到该工单。');
      if (action === 'workorder-update') openWorkorderUpdate(order);
      else if (action === 'acceptance') openAcceptance(order);
      else {
        order.acceptances = await rowsFor(`/api/workorders/${encodeURIComponent(id)}/acceptances`);
        openWorkorderDetail(order);
      }
    } else if (action === 'review-detection') {
      const rows = await rowsFor('/api/detections'); const row = rows.find(item => String(item.id) === String(id));
      if (!row) throw new Error('未找到该识别记录。'); openDetectionReview(row);
    } else if (action === 'create-assessment') {
      const ok = await confirmDialog({ title: '生成健康评估', message: '将根据该识别记录生成 AI 辅助评估，III / IV 级评估会同时创建专家复核任务。是否继续？', confirmText: '生成评估' });
      if (!ok) return;
      button.disabled = true;
      const result = await api('/api/assessments', { method: 'POST', body: { detectionId: id } });
      toast(`评估已生成：${gradeLabel(result?.assessment?.aiGrade)}`); await render();    } else if (action === 'update-review') {
      const rows = await rowsFor('/api/reviews'); const row = rows.find(item => String(item.id) === String(id));
      if (!row) throw new Error('未找到该复核任务。'); openReviewForm(row);
    } else if (action === 'update-response') {
      const rows = await rowsFor('/api/responses'); const row = rows.find(item => String(item.id) === String(id));
      if (!row) throw new Error('未找到该响应记录。'); openResponseForm(row);
    } else if (action === 'new-workorder') openWorkorderForm();
    else if (action === 'public-detail') {
      const rows = await rowsFor('/api/public/reports'); const row = rows.find(item => String(item.id) === String(id));
      if (!row) throw new Error('未找到该公众线索。'); openPublicDetail(row);
    } else if (action === 'public-update') {
      const rows = await rowsFor('/api/public/reports'); const row = rows.find(item => String(item.id) === String(id));
      if (!row) throw new Error('未找到该公众线索。'); openPublicUpdate(row);
    }
  } catch (error) {
    if (action === 'export') { button.disabled = false; button.innerHTML = `${icon('download')}导出监管报表`; }
    toast(error.message, 'error');
  }
});

document.addEventListener('input', event => {
  const input = event.target.closest('[data-filter="q"]');
  if (!input) return;
  const page = routeFromHash().name, value = input.value;
  if (!filters[page] || !listCache.has(page)) return;
  filters[page].q = value;
  const restoreFocus = document.activeElement === input;
  const selection = { start: input.selectionStart, end: input.selectionEnd };
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (routeFromHash().name !== page || !redrawList(page)) return;
    if (restoreFocus && (document.activeElement === input || document.activeElement === document.body)) {
      restoreFilterFocus('[data-filter="q"]', selection);
    }
  }, 350);
});
document.addEventListener('change', async event => {
  const select = event.target.closest('select[data-filter]');
  if (select) {
    clearTimeout(searchTimer);
    const page = routeFromHash().name;
    if (filters[page]) {
      filters[page][select.dataset.filter] = select.value;
      if (!redrawList(page)) await render();
      else restoreFilterFocus(`select[data-filter="${select.dataset.filter}"]`);
    }
    return;
  }
  if (event.target.id === 'user-select') {
    const userId = event.target.value;
    event.target.disabled = true;
    try {
      const user = await api('/api/session', { method: 'PUT', body: { userId } });
      setCurrentUserId(user.id); session = user;
      document.querySelector('#user-avatar').textContent = String(user.name || user.roleLabel || '演').slice(0, 1);
      document.querySelector('.user-switcher label small').textContent = `${user.name} · ${user.roleLabel}`;
      document.querySelector('.user-switcher label small').title = `${user.org || ''} / ${user.roleLabel || ''}`;
      toast(`已切换为${user.roleLabel}演示角色`); await render();
    } catch (error) { toast(error.message, 'error'); event.target.value = currentUserId(); }
    finally { event.target.disabled = false; }
  }
});

function closeSidebar() {
  document.querySelector('#sidebar').classList.remove('is-open');
  document.querySelector('#sidebar-scrim').hidden = true;
}
document.querySelector('#menu-toggle').addEventListener('click', () => {
  document.querySelector('#sidebar').classList.add('is-open');
  document.querySelector('#sidebar-scrim').hidden = false;
});
document.querySelector('#sidebar-scrim').addEventListener('click', closeSidebar);
window.addEventListener('hashchange', render);
window.addEventListener('storage', async event => {
  if (event.key === 'cityhealth_demo_user') { await loadSession(); await render(); }
});

async function bootstrap() {
  await loadSession();
  if (!location.hash) location.hash = '/dashboard';
  else await render();
}
bootstrap();
