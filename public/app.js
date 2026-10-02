const elements = {
  serviceStatus: document.querySelector('#serviceStatus'),
  connectForm: document.querySelector('#connectForm'),
  connectButton: document.querySelector('#connectButton'),
  bundleId: document.querySelector('#bundleId'),
  sessionState: document.querySelector('#sessionState'),
  title: document.querySelector('#notificationTitle'),
  body: document.querySelector('#notificationBody'),
  badge: document.querySelector('#notificationBadge'),
  data: document.querySelector('#notificationData'),
  bodyCount: document.querySelector('#bodyCount'),
  previewTitle: document.querySelector('#previewTitle'),
  previewBody: document.querySelector('#previewBody'),
  notificationPanel: document.querySelector('#notificationPanel'),
  livePanel: document.querySelector('#livePanel'),
  liveEvent: document.querySelector('#liveEvent'),
  liveOrderId: document.querySelector('#liveOrderId'),
  attributesType: document.querySelector('#attributesType'),
  attributesTypeField: document.querySelector('#attributesTypeField'),
  attributes: document.querySelector('#liveAttributes'),
  attributesField: document.querySelector('#attributesField'),
  contentState: document.querySelector('#contentState'),
  liveSubmitLabel: document.querySelector('#liveSubmitLabel'),
  dynamicIsland: document.querySelector('#dynamicIsland'),
  islandStatus: document.querySelector('#islandStatus'),
  islandProgress: document.querySelector('#islandProgress'),
  activityList: document.querySelector('#activityList'),
  toast: document.querySelector('#toast'),
};

const storageKey = 'push-deck-session';
let session = readSession();
let toastTimer;

function readSession() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey));
    return value?.key && new Date(value.expiresAt) > new Date() ? value : null;
  } catch { return null; }
}

function saveSession(value) {
  session = value;
  localStorage.setItem(storageKey, JSON.stringify(value));
  renderSession();
}

function renderSession() {
  if (!session) {
    elements.sessionState.classList.remove('is-ready');
    elements.sessionState.innerHTML = '<span class="state-icon">—</span><span>尚未获取会话 key</span>';
    return;
  }
  elements.bundleId.value = session.bundleId;
  elements.sessionState.classList.add('is-ready');
  const expires = new Date(session.expiresAt).toLocaleString('zh-CN', { hour12: false });
  elements.sessionState.innerHTML = `<span class="state-icon">✓</span><span>已连接 ${escapeHtml(session.bundleId)} · key 有效至 ${escapeHtml(expires)}</span>`;
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

function parseJson(value, label, fallback = {}) {
  if (!value.trim()) return fallback;
  try { return JSON.parse(value); }
  catch { throw new Error(`${label}不是有效的 JSON`); }
}

async function api(path, body, authenticated = true) {
  if (authenticated && !session) throw new Error('请先填写 Bundle ID 并建立连接');
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated ? { Authorization: `Bearer ${session.key}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      session = null;
      localStorage.removeItem(storageKey);
      renderSession();
    }
    throw new Error(result.error || '请求失败');
  }
  return result;
}

function setBusy(button, busy) {
  button.disabled = busy;
  button.dataset.label ||= button.textContent;
  button.textContent = busy ? '处理中…' : button.dataset.label;
}

function notify(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('is-error', isError);
  elements.toast.classList.add('is-visible');
  toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 3600);
}

function addLog(type, detail, success = true) {
  elements.activityList.querySelector('.empty-log')?.remove();
  const item = document.createElement('li');
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  item.innerHTML = `<time>${escapeHtml(time)}</time><span>${escapeHtml(type)}</span><small class="${success ? 'log-success' : 'log-error'}">${escapeHtml(detail)}</small>`;
  elements.activityList.prepend(item);
  while (elements.activityList.children.length > 5) elements.activityList.lastElementChild.remove();
}

elements.connectForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBusy(elements.connectButton, true);
  try {
    const bundleId = elements.bundleId.value.trim();
    const result = await api('/api/init', { bundleId }, false);
    saveSession({ ...result, bundleId });
    addLog('建立连接', bundleId);
    notify('连接成功，可以发送推送了');
  } catch (error) {
    addLog('建立连接', error.message, false);
    notify(error.message, true);
  } finally { setBusy(elements.connectButton, false); }
});

elements.notificationPanel.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  setBusy(button, true);
  try {
    const badge = elements.badge.value === '' ? undefined : Number(elements.badge.value);
    const result = await api('/api/push/notification', {
      alert: { title: elements.title.value.trim(), body: elements.body.value.trim() },
      ...(badge !== undefined ? { badge } : {}),
      data: parseJson(elements.data.value, '自定义数据'),
    });
    addLog('普通通知', result.message || '已投递');
    notify('通知已发送到 iOS 模拟器');
  } catch (error) {
    addLog('普通通知', error.message, false);
    notify(error.message, true);
  } finally { setBusy(button, false); }
});

elements.livePanel.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  setBusy(button, true);
  try {
    const action = elements.liveEvent.value;
    const body = {
      orderId: elements.liveOrderId.value.trim(),
      contentState: parseJson(elements.contentState.value, '实时状态'),
    };
    if (action === 'start') {
      body.attributesType = elements.attributesType.value.trim();
      body.attributes = parseJson(elements.attributes.value, '固定属性');
    }
    body.event = action;
    const result = await api('/api/live-activity/state', body);
    const detail = result.delivered > 0 ? `已送达 ${result.delivered} 个 Flutter 连接` : '状态已保存，等待 Flutter 连接';
    addLog(`灵动岛 · ${action}`, detail);
    notify(detail);
  } catch (error) {
    addLog('灵动岛', error.message, false);
    notify(error.message, true);
  } finally { setBusy(button, false); }
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((item) => {
      const active = item === tab;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', String(active));
    });
    const isLive = tab.dataset.panel === 'livePanel';
    elements.notificationPanel.hidden = isLive;
    elements.livePanel.hidden = !isLive;
    elements.dynamicIsland.classList.toggle('is-visible', isLive);
  });
}

elements.title.addEventListener('input', () => { elements.previewTitle.textContent = elements.title.value || '通知标题'; });
elements.body.addEventListener('input', () => {
  elements.previewBody.textContent = elements.body.value || '通知内容会显示在这里';
  elements.bodyCount.textContent = elements.body.value.length;
});
elements.contentState.addEventListener('input', () => {
  try {
    const state = JSON.parse(elements.contentState.value);
    elements.islandStatus.textContent = state.status || '进行中';
    elements.islandProgress.textContent = Number.isFinite(state.progress) ? `${Math.round(state.progress * 100)}%` : 'LIVE';
  } catch { /* 输入过程中保留最后一次有效预览 */ }
});
elements.liveEvent.addEventListener('change', () => {
  const isStart = elements.liveEvent.value === 'start';
  elements.attributesTypeField.hidden = !isStart;
  elements.attributesField.hidden = !isStart;
  elements.liveSubmitLabel.textContent = ({ start: '启动灵动岛', update: '更新灵动岛', end: '结束灵动岛' })[elements.liveEvent.value];
});

elements.liveEvent.dispatchEvent(new Event('change'));

async function boot() {
  renderSession();
  try {
    const response = await fetch('/health');
    const result = await response.json();
    if (!response.ok) throw new Error();
    elements.serviceStatus.classList.add('is-online');
    elements.serviceStatus.lastElementChild.textContent = result.transport === 'ios-simulator' ? '模拟器服务在线' : 'APNs 服务在线';
  } catch {
    elements.serviceStatus.lastElementChild.textContent = '服务不可用';
  }
}

boot();
