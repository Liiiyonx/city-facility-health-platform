import { api } from '../shared/api.js';
import { icon, escapeHtml, formatDateTime, statusTone, badge, toast } from '../shared/ui.js';

const DEFECT_LABELS = {
  crack: '墙体裂缝', hollow: '外墙饰面空鼓与脱落', spall: '混凝土剥落与露筋',
  corrosion: '钢结构锈蚀', leak: '屋面渗漏痕迹', sealant: '幕墙密封胶失效', other: '其他异常'
};
const $ = selector => document.querySelector(selector);
const form = $('#report-form');
const communitySelect = $('#community-select');
const buildingSelect = $('#building-select');
const contextLoading = $('#context-loading');
const locationInput = $('#location-input');
const locationStatus = $('#location-status');
const submitButton = $('#submit-report');
const submitError = $('#submit-error');
const queryResult = $('#query-result');
const queryInput = $('#query-code');
const state = {
  communities: [], buildings: [], photo: null, submission: null,
  activeTab: 'report', contextLoaded: false
};

document.querySelectorAll('[data-icon]').forEach(el => { el.innerHTML = icon(el.dataset.icon); });

function setTab(tab) {
  if (!['report', 'query', 'about'].includes(tab)) tab = 'report';
  state.activeTab = tab;
  document.querySelectorAll('[data-view]').forEach(view => view.classList.toggle('is-active', view.dataset.view === tab));
  document.querySelectorAll('.bottom-nav [data-tab]').forEach(button => {
    const active = button.dataset.tab === tab;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const label = { report: '提交线索', query: '查询进度', about: '服务说明' }[tab];
  document.title = `${label} · 城市设施健康公众服务`;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  if (tab === 'query') setTimeout(() => queryInput.focus(), 120);
}

async function loadContext() {
  contextLoading.textContent = '正在加载社区信息…';
  buildingSelect.disabled = true;
  try {
    const context = await api('/api/public/context');
    state.communities = Array.isArray(context?.communities) ? context.communities : [];
    state.buildings = Array.isArray(context?.buildings) ? context.buildings : [];
    state.contextLoaded = true;
    const selected = communitySelect.value;
    communitySelect.innerHTML = '<option value="">请选择社区（可选）</option>' + state.communities.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
    if (state.communities.some(item => String(item.id) === selected)) communitySelect.value = selected;
    contextLoading.textContent = state.communities.length ? `已加载 ${state.communities.length} 个可选社区` : '暂无可选社区，可手动填写位置';
    updateBuildings();
  } catch (error) {
    state.contextLoaded = false;
    contextLoading.innerHTML = `社区信息加载失败 <button type="button" class="inline-retry" data-action="retry-context">重试</button>`;
    toast(error.message, 'error');
  }
}

function updateBuildings() {
  const communityId = communitySelect.value;
  const available = communityId ? state.buildings.filter(item => {
    const candidate = item.communityId ?? item.communityID ?? item.community;
    if (candidate !== undefined) return String(typeof candidate === 'object' ? candidate.id : candidate) === String(communityId);
    return true;
  }) : [];
  const selected = buildingSelect.value;
  if (!communityId) {
    buildingSelect.innerHTML = '<option value="">请先选择社区（可选）</option>';
    buildingSelect.disabled = true;
  } else if (!available.length) {
    buildingSelect.innerHTML = '<option value="">暂无可选建筑</option>';
    buildingSelect.disabled = true;
  } else {
    buildingSelect.disabled = false;
    buildingSelect.innerHTML = '<option value="">请选择建筑（可选）</option>' + available.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
    if (available.some(item => String(item.id) === selected)) buildingSelect.value = selected;
  }
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('照片读取失败，请重新选择。'));
    reader.readAsDataURL(file);
  });
}

async function compressPhoto(file) {
  if (!file.type.startsWith('image/')) throw new Error('请选择 JPG、PNG 等图片文件。');
  if (file.size > 10 * 1024 * 1024) throw new Error('照片大小不能超过 10MB。');
  if (file.size <= 1024 * 1024 && /^image\/(jpeg|png|webp)$/.test(file.type)) return readAsDataUrl(file);
  const source = await readAsDataUrl(file);
  try {
    const image = await new Promise((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('图片格式无法识别。'));
      element.src = source;
    });
    const ratio = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.78);
  } catch (error) {
    if (/格式/.test(error.message)) throw error;
    return source;
  }
}

async function choosePhoto(file) {
  if (!file) return;
  try {
    const dataUrl = await compressPhoto(file);
    state.photo = { file, dataUrl };
    $('#photo-image').src = dataUrl;
    $('#photo-name').textContent = file.name || '现场照片';
    const bytes = Math.round(dataUrl.length * 3 / 4);
    $('#photo-size').textContent = bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB · 已处理` : `${Math.max(1, Math.round(bytes / 1024))} KB · 已处理`;
    $('#photo-preview').hidden = false;
    toast('照片已添加');
  } catch (error) { toast(error.message, 'error'); }
  finally {
    $('#camera-input').value = '';
    $('#album-input').value = '';
  }
}

function removePhoto() {
  state.photo = null;
  $('#photo-preview').hidden = true;
  $('#photo-image').removeAttribute('src');
  $('#camera-input').value = '';
  $('#album-input').value = '';
}

function locate() {
  const button = document.querySelector('[data-action="locate"]');
  if (!navigator.geolocation) {
    locationStatus.textContent = '当前浏览器不支持定位，请手动填写位置';
    toast('当前浏览器不支持定位，请手动填写位置', 'error');
    return;
  }
  button.disabled = true;
  button.innerHTML = '<span class="spinner" style="width:13px;height:13px"></span>定位中';
  locationStatus.textContent = '正在获取定位，请允许浏览器权限…';
  navigator.geolocation.getCurrentPosition(position => {
    const { longitude, latitude, accuracy } = position.coords;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      locationStatus.textContent = '定位数据无效，请手动填写位置';
      button.disabled = false;
      button.innerHTML = `${icon('locate')}重新定位`;
      toast('定位数据无效，请手动填写位置', 'error');
      return;
    }
    locationInput.value = `定位点（${longitude.toFixed(6)}, ${latitude.toFixed(6)}）`;
    locationStatus.textContent = `定位成功，精度约 ${Math.round(accuracy || 0)} 米，可手动修改`;
    button.disabled = false;
    button.innerHTML = `${icon('locate')}重新定位`;
    toast('定位成功，已填入位置');
  }, error => {
    const messages = { 1: '定位权限未开启', 2: '暂时无法获取位置', 3: '定位超时' };
    locationStatus.textContent = `${messages[error.code] || '定位未成功'}，请手动填写位置`;
    button.disabled = false;
    button.innerHTML = `${icon('locate')}重新定位`;
    toast(`${messages[error.code] || '定位未成功'}，请手动填写位置`, 'error');
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}

function validateReport() {
  const description = form.elements.description.value.trim();
  const location = locationInput.value.trim();
  let message = '';
  if (!form.elements.type.value) message = '请选择线索分类。';
  else if (description.length < 5) message = '请至少填写 5 个字的详细描述。';
  else if (!location) message = '请获取定位或手动填写线索位置。';
  else if (!form.elements.consent.checked) message = '请阅读并同意信息使用说明。';
  submitError.hidden = !message;
  submitError.textContent = message;
  return !message;
}

function setSubmitting(busy) {
  submitButton.disabled = busy;
  submitButton.innerHTML = busy ? '<span class="spinner" style="width:17px;height:17px;border-color:rgba(255,255,255,.3);border-top-color:#fff"></span><span>正在提交…</span>' : `${icon('send')}<span>提交隐患线索</span>`;
}

async function submitReport(event) {
  event.preventDefault();
  if (!validateReport()) {
    const firstInvalid = form.querySelector(':invalid');
    firstInvalid?.focus();
    toast(submitError.textContent, 'error');
    return;
  }
  const values = Object.fromEntries(new FormData(form).entries());
  const body = {
    type: values.type,
    description: values.description.trim(),
    location: locationInput.value.trim(),
    communityId: values.communityId || '',
    buildingId: values.buildingId || '',
    photoData: state.photo?.dataUrl || '',
    contact: (values.contact || '').trim()
  };
  setSubmitting(true);
  submitError.hidden = true;
  try {
    const result = await api('/api/public/reports', { method: 'POST', body });
    state.submission = { ...result, type: body.type };
    queryInput.value = result.code || '';
    renderSuccess();
    setTab('report');
    requestAnimationFrame(() => $('#success-panel .success-code strong')?.focus({ preventScroll: true }));
    toast('线索提交成功，请保存报告编号');
  } catch (error) {
    submitError.hidden = false;
    submitError.textContent = error.message;
    toast(error.message, 'error');
  } finally { setSubmitting(false); }
}

function renderSuccess() {
  $('#success-panel')?.remove();
  const report = state.submission;
  if (!report) return;
  const panel = document.createElement('section');
  panel.id = 'success-panel';
  panel.className = 'success-panel';
  panel.innerHTML = `<div class="success-hero"><span class="success-icon">${icon('check')}</span><h1>线索已提交</h1><p>感谢您参与城市设施健康共治，可凭报告编号查询进度。</p></div>
    <div class="success-code"><small>您的报告编号</small><strong tabindex="-1">${escapeHtml(report.code || '—')}</strong><button class="copy-button" type="button" data-action="copy-code">${icon('file')}复制编号</button></div>
    <section class="mobile-card status-card"><div class="status-card-head"><h2>提交信息</h2>${badge(report.status || '已提交')}</div><div class="status-details"><div class="status-detail"><span>线索分类</span><strong>${escapeHtml(DEFECT_LABELS[report.type] || report.type || '其他异常')}</strong></div><div class="status-detail"><span>当前反馈</span><strong>${escapeHtml(report.feedback || '已收到，等待核查')}</strong></div></div></section>
    <div class="success-actions"><button class="secondary-button" type="button" data-action="new-report">${icon('plus')}继续提交</button><button class="submit-button compact" type="button" data-action="query-success">${icon('search')}查询进度</button></div>
    <p class="query-privacy">${icon('shield')}请妥善保管报告编号。公众端仅展示处理状态与反馈，不公开内部信息。</p>`;
  $('#view-report').prepend(panel);
  $('.welcome-card').hidden = true;
  $('.notice-strip').hidden = true;
  form.hidden = true;
}

function newReport() {
  state.submission = null;
  $('#success-panel')?.remove();
  form.reset();
  removePhoto();
  updateBuildings();
  $('#description-count').textContent = '0';
  submitError.hidden = true;
  $('.welcome-card').hidden = false;
  $('.notice-strip').hidden = false;
  form.hidden = false;
  locationStatus.textContent = '可定位，也可手动填写';
  setTab('report');
  setTimeout(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
    form.elements.type.focus({ preventScroll: true });
  }, 20);
}

async function copyCode() {
  const code = state.submission?.code || '';
  if (!code) return;
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(code);
    else {
      const textarea = document.createElement('textarea');
      textarea.value = code; textarea.style.position = 'fixed'; textarea.style.opacity = '0'; document.body.append(textarea); textarea.select();
      const copied = document.execCommand('copy'); textarea.remove();
      if (!copied) throw new Error('copy failed');
    }
    toast('报告编号已复制');
  } catch { toast('复制失败，请手动记录报告编号', 'error'); }
}

function renderQueryLoading() {
  queryResult.innerHTML = `<section class="mobile-card query-placeholder"><span class="spinner"></span><h2>正在查询</h2><p>请稍候，正在获取报告最新状态。</p></section>`;
}
function renderQueryError(message) {
  queryResult.innerHTML = `<section class="mobile-card status-card"><div class="query-error">${icon('alert')}<h2>查询失败</h2><p>${escapeHtml(message)}</p><button class="secondary-button" type="button" data-action="query">${icon('refresh')}重新查询</button></div></section>`;
}
function renderQueryResult(report) {
  const fields = [
    ['报告编号', report.code],
    ['线索分类', report.type],
    ['当前状态', report.status],
    ['提交时间', formatDateTime(report.createdAt)],
    ['最近更新', formatDateTime(report.updatedAt)]
  ];
  queryResult.innerHTML = `<section class="mobile-card status-card"><div class="status-card-head"><h2>处理进度</h2>${badge(report.status || '已提交')}</div><div class="status-details">${fields.map(([label, value]) => `<div class="status-detail${label === '报告编号' ? ' report-code-detail' : ''}"><span>${label}</span><strong>${escapeHtml(value || '—')}</strong></div>`).join('')}</div><div class="feedback-box"><strong>官方反馈</strong><p>${escapeHtml(report.feedback || '暂无反馈，请稍后再次查询。')}</p></div></section><p class="query-privacy">${icon('shield')}为保护隐私，查询结果仅展示编号、分类、状态、反馈与时间，不包含内部缺陷或专家意见。</p>`;
}
async function queryReport(code = queryInput.value) {
  const value = String(code || '').trim();
  if (!value) { toast('请输入报告编号', 'error'); queryInput.focus(); return; }
  queryInput.value = value;
  renderQueryLoading();
  try {
    const report = await api(`/api/public/reports/${encodeURIComponent(value)}`);
    renderQueryResult(report);
  } catch (error) { renderQueryError(error.message); }
}

communitySelect.addEventListener('change', updateBuildings);
form.addEventListener('submit', submitReport);
form.elements.description.addEventListener('input', event => { $('#description-count').textContent = event.target.value.length; });
$('#camera-input').addEventListener('change', event => choosePhoto(event.target.files[0]));
$('#album-input').addEventListener('change', event => choosePhoto(event.target.files[0]));
queryInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); queryReport(); } });

document.addEventListener('click', event => {
  const tabButton = event.target.closest('[data-tab]');
  if (tabButton) { setTab(tabButton.dataset.tab); return; }
  const tabLink = event.target.closest('[data-tab-link]');
  if (tabLink) { event.preventDefault(); setTab(tabLink.dataset.tabLink); return; }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'retry-context') loadContext();
  else if (action === 'remove-photo') removePhoto();
  else if (action === 'locate') locate();
  else if (action === 'query') queryReport();
  else if (action === 'query-success') { setTab('query'); queryReport(state.submission?.code || ''); }
  else if (action === 'copy-code') copyCode();
  else if (action === 'new-report') newReport();
});

setTab('report');
loadContext();
