const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  building: '<path d="M4 21V5l8-3v19M12 8h8v13M2 21h20M7 7h2M7 11h2M7 15h2M15 12h2M15 16h2"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2h6v2M9 9h6M9 13h6M9 17h4"/>',
  scan: '<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M7 12h10M12 7v10"/><circle cx="12" cy="12" r="3"/>',
  shield: '<path d="M12 2 4 5v6c0 5.2 3.4 9.2 8 11 4.6-1.8 8-5.8 8-11V5l-8-3Z"/><path d="m8 12 3 3 5-6"/>',
  response: '<path d="m13 2-9 12h7l-1 8 10-13h-7l1-7Z"/>',
  workorder: '<path d="M14.7 6.3a4 4 0 0 0-5-5L12 3.6 9.6 6 7.3 3.7a4 4 0 0 0 5 5l-8.8 8.8a2.1 2.1 0 0 0 3 3l8.8-8.8a4 4 0 0 0 5-5L18 9l-2.4-2.4 2.3-2.3a4 4 0 0 0-3.2 2Z"/>',
  public: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  audit: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 11.9-2"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  pin: '<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  camera: '<path d="M14.5 4h-5L7 7H3a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h18a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1h-4l-2.5-3Z"/><circle cx="12" cy="13" r="4"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  locate: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  send: '<path d="m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  filter: '<path d="M4 5h16M7 12h10M10 19h4"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  file: '<path d="M14 2H5a1 1 0 0 0-1 1v18a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8l-6-6Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7l10-5ZM2 12l10 5 10-5M2 17l10 5 10-5"/>',
  activity: '<path d="M2 12h4l3-8 6 16 3-8h4"/>',
  external: '<path d="M14 3h7v7M21 3l-9 9M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>',
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V10Z"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>'
};

export function icon(name, className = '') {
  return `<svg class="icon ${escapeHtml(className)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.info}</svg>`;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value) {
  const date = validDate(value);
  if (!date) return '—';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date).replaceAll('/', '-');
}

export function formatDateTime(value) {
  const date = validDate(value);
  if (!date) return '—';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date).replaceAll('/', '-');
}

export function gradeKey(grade) {
  const value = String(grade ?? '').trim().toUpperCase();
  const aliases = { 'Ⅰ': 'I', 'Ⅱ': 'II', 'Ⅲ': 'III', 'Ⅳ': 'IV', '1': 'I', '2': 'II', '3': 'III', '4': 'IV', '一': 'I', '二': 'II', '三': 'III', '四': 'IV', 'A': 'I', 'B': 'II', 'C': 'III', 'D': 'IV' };
  if (aliases[value]) return aliases[value];
  const match = value.match(/^(IV|III|II|I)(?:级)?$/);
  return match ? match[1] : value;
}

export function gradeLabel(grade) {
  const value = gradeKey(grade);
  const map = { I: 'I 级 · 关注', II: 'II 级 · 观察', III: 'III 级 · 处置', IV: 'IV 级 · 紧急', A: 'A 级 · 健康', B: 'B 级 · 基本健康', C: 'C 级 · 需关注', D: 'D 级 · 高风险' };
  return map[value] || String(grade ?? '').trim() || '未评定';
}

export function gradeTone(grade) {
  const value = gradeKey(grade);
  if (value === 'IV') return 'danger';
  if (value === 'III') return 'warning';
  if (value === 'II') return 'info';
  if (value === 'I') return 'success';
  return 'neutral';
}

export function statusTone(status) {
  const value = String(status ?? '');
  if (/已完成|已销号|通过|确认|已响应|正常|完好|合格/.test(value)) return 'success';
  if (/高风险|重大|不通过|否决|逾期|IV/.test(value)) return 'danger';
  if (/待|处理中|复核中|处置中|修正|关注|III/.test(value)) return 'warning';
  if (/取消|退回|关闭/.test(value)) return 'neutral';
  return 'info';
}

export function badge(value, tone = statusTone(value)) {
  return `<span class="badge badge-${tone}"><span class="badge-dot"></span>${escapeHtml(value || '—')}</span>`;
}

export function gradeBadge(value) {
  return `<span class="badge badge-${gradeTone(value)}">${escapeHtml(value || '未评定')}</span>`;
}

export function loading(message = '正在加载数据…') {
  return `<div class="state loading-state" role="status"><span class="spinner"></span><span>${escapeHtml(message)}</span></div>`;
}

export function emptyState(title = '暂无数据', description = '当前筛选条件下没有记录。') {
  return `<div class="state empty-state">${icon('file')}<strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></div>`;
}

export function errorState(error, target = '') {
  return `<div class="state error-state" role="alert">${icon('alert')}<strong>数据加载失败</strong><span>${escapeHtml(error?.message || error || '请稍后重试')}</span><button class="btn btn-secondary btn-sm" data-action="retry" data-target="${escapeHtml(target)}">${icon('refresh')}重新加载</button></div>`;
}

export function toast(message, type = 'success') {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = document.createElement('div');
    host.className = 'toast-host';
    host.setAttribute('aria-live', 'polite');
    document.body.append(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `${icon(type === 'error' ? 'alert' : 'check')}<span>${escapeHtml(message)}</span>`;
  host.append(el);
  setTimeout(() => { el.classList.add('is-leaving'); setTimeout(() => el.remove(), 220); }, 3800);
}

export function openModal({ title, content, footer = '', wide = false, drawer = false, onOpen } = {}) {
  closeModal();
  document.querySelectorAll('.modal-overlay.is-leaving').forEach(el => el.remove());
  const overlay = document.createElement('div');
  overlay.className = `modal-overlay${drawer ? ' drawer-overlay' : ''}`;
  overlay.innerHTML = `<section class="modal ${wide ? 'modal-wide' : ''}${drawer ? ' drawer' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <header class="modal-header"><div><span class="eyebrow">城市设施健康平台</span><h2 id="modal-title">${escapeHtml(title)}</h2></div><button class="icon-btn" type="button" data-close-modal aria-label="关闭">${icon('close')}</button></header>
    <div class="modal-body">${content}</div>${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}</section>`;
  document.body.append(overlay);
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => overlay.classList.add('is-open'));
  const previous = document.activeElement;
  overlay._returnFocus = previous;
  overlay.addEventListener('click', event => { if (event.target === overlay || event.target.closest('[data-close-modal]')) closeModal(); });
  overlay.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeModal();
    if (event.key === 'Tab') {
      const focusables = [...overlay.querySelectorAll('button:not([disabled]), input, select, textarea, a[href], [tabindex="0"]')];
      if (!focusables.length) return;
      const first = focusables[0], last = focusables.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  setTimeout(() => (overlay.querySelector('input, select, textarea, button') || overlay).focus(), 40);
  if (onOpen) onOpen(overlay.querySelector('.modal'));
  return () => closeModal();
}

export function closeModal() {
  const overlays = [...document.querySelectorAll('.modal-overlay:not(.is-leaving)')];
  const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
  overlays.forEach(overlay => {
    const returnFocus = overlay._returnFocus;
    overlay.inert = true;
    overlay.setAttribute('aria-hidden', 'true');
    overlay.classList.add('is-leaving');
    setTimeout(() => {
      overlay.remove();
      if (!document.querySelector('.modal-overlay') && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    }, duration);
  });
  if (!overlays.length) return;
  document.body.classList.remove('modal-open');
}

export function confirmDialog({ title = '确认操作', message = '确定执行此操作吗？', confirmText = '确认', tone = 'primary' } = {}) {
  return new Promise(resolve => {
    openModal({
      title,
      content: `<div class="confirm-message">${icon('info')}<p>${escapeHtml(message)}</p></div>`,
      footer: `<button class="btn btn-secondary" type="button" data-confirm="false">取消</button><button class="btn btn-${tone}" type="button" data-confirm="true">${escapeHtml(confirmText)}</button>`
    });
    document.querySelector('.modal-overlay')?.addEventListener('click', event => {
      const button = event.target.closest('[data-confirm]');
      if (!button) {
        if (event.target.classList.contains('modal-overlay') || event.target.closest('[data-close-modal]')) resolve(false);
        return;
      }
      const result = button.dataset.confirm === 'true';
      closeModal(); resolve(result);
    }, { once: false });
    document.querySelector('.modal-overlay')?.addEventListener('keydown', event => { if (event.key === 'Escape') resolve(false); }, { once: true });
  });
}

export function asset(name) {
  return `../assets/${name}.svg`;
}

export function facilityArtwork(category) {
  const value = String(category || '');
  if (/屋顶|屋面/.test(value)) return asset('roof-inspection');
  if (/社区|住宅|房屋/.test(value)) return asset('community');
  if (/桥|市政|道路/.test(value)) return asset('urban-bridge');
  return asset('civic-building');
}

export function formField({ label, name, type = 'text', value = '', required = false, placeholder = '', options, min, max, step, help = '' }) {
  const id = `field-${name}-${Math.random().toString(36).slice(2, 7)}`;
  const attrs = `id="${id}" name="${escapeHtml(name)}" ${required ? 'required' : ''} ${placeholder ? `placeholder="${escapeHtml(placeholder)}"` : ''} ${min !== undefined ? `min="${escapeHtml(min)}"` : ''} ${max !== undefined ? `max="${escapeHtml(max)}"` : ''} ${step !== undefined ? `step="${escapeHtml(step)}"` : ''}`;
  let control;
  if (options) {
    control = `<select ${attrs}>${options.map(option => { const [val, label] = Array.isArray(option) ? option : [option, option]; return `<option value="${escapeHtml(val)}" ${String(value) === String(val) ? 'selected' : ''}>${escapeHtml(label)}</option>`; }).join('')}</select>`;
  } else if (type === 'textarea') {
    control = `<textarea ${attrs} rows="4">${escapeHtml(value)}</textarea>`;
  } else {
    control = `<input ${attrs} type="${escapeHtml(type)}" value="${escapeHtml(value)}">`;
  }
  return `<label class="field" for="${id}"><span>${escapeHtml(label)}${required ? '<em>*</em>' : ''}</span>${control}${help ? `<small>${escapeHtml(help)}</small>` : ''}</label>`;
}

export function paginationInfo(total, shown) {
  return total ? `共 ${escapeHtml(total)} 条，当前显示 ${escapeHtml(shown)} 条` : '';
}
