const USER_KEY = 'cityhealth_demo_user';

export function currentUserId() {
  try { return localStorage.getItem(USER_KEY) || 'gov-1'; }
  catch { return 'gov-1'; }
}

export function setCurrentUserId(userId) {
  try { localStorage.setItem(USER_KEY, userId); } catch { /* storage may be unavailable */ }
}

/** Same-origin JSON API. `responseType: 'text' | 'blob'` supports exports. */
export async function api(path, options = {}) {
  const { responseType = 'json', headers = {}, body, ...rest } = options;
  const requestHeaders = { Accept: responseType === 'blob' ? '*/*' : 'application/json', ...headers };
  let payload = body;
  if (body !== undefined && body !== null && !(body instanceof FormData) && typeof body !== 'string' && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    payload = JSON.stringify(body);
    requestHeaders['Content-Type'] = 'application/json';
  }
  if (/(^|\/)admin(?:\/|$)/.test(location.pathname)) {
    requestHeaders['x-user-id'] = headers['x-user-id'] || currentUserId();
  }

  let response;
  try {
    response = await fetch(path, { ...rest, headers: requestHeaders, body: payload });
  } catch (error) {
    throw new Error('无法连接服务，请确认本地服务已启动后重试。');
  }

  if (responseType === 'blob') {
    if (!response.ok) {
      let message = `请求失败（${response.status}）`;
      try { const data = await response.json(); message = data?.error?.message || message; } catch { /* non-JSON error */ }
      throw new Error(message);
    }
    return response.blob();
  }

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch {
      if (!response.ok) throw new Error(`服务暂时不可用（${response.status}），请稍后重试。`);
      if (responseType === 'text') return text;
      throw new Error('服务返回了无法解析的数据。');
    }
  }
  if (!response.ok) {
    throw new Error(data?.error?.message || `请求失败（${response.status}）`);
  }
  if (responseType === 'text') return text;
  return data;
}
