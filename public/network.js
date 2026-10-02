const $ = (selector) => document.querySelector(selector);
const elements = {
  serviceStatus: $('#serviceStatus'),
  masterToggle: $('#masterToggle'),
  masterLabel: $('#masterLabel'),
  activeDescription: $('#activeDescription'),
  activeProfile: $('#activeProfile'),
  profileGrid: $('#profileGrid'),
  saveCustom: $('#saveCustom'),
  probabilityNote: $('#probabilityNote'),
  clientTimeout: $('#clientTimeout'),
  runProbe: $('#runProbe'),
  probeResult: $('#probeResult'),
  clearLogs: $('#clearLogs'),
  statTotal: $('#statTotal'),
  statSuccess: $('#statSuccess'),
  statDuration: $('#statDuration'),
  logs: $('#networkLogs'),
  toast: $('#toast'),
};

const configFields = [
  'minDelayMs', 'maxDelayMs', 'serviceUnavailableRate', 'timeoutRate',
  'disconnectRate', 'rateLimitRate', 'malformedRate', 'timeoutMs',
];
let state;
let toastTimer;
let pollTimer;

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value);
  return node.innerHTML;
}

function notify(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('is-error', isError);
  elements.toast.classList.add('is-visible');
  toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 3200);
}

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); }
  catch { result = { raw: text }; }
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function configFromForm() {
  return Object.fromEntries(configFields.map((name) => [name, Number($(`#${name}`).value)]));
}

function renderProbability() {
  const config = configFromForm();
  const total = config.serviceUnavailableRate + config.timeoutRate + config.disconnectRate
    + config.rateLimitRate + config.malformedRate;
  elements.probabilityNote.textContent = total <= 100
    ? `异常概率合计 ${total}%，其余 ${100 - total}% 请求成功。`
    : `异常概率合计 ${total}%，已超出 100%。`;
  elements.probabilityNote.classList.toggle('is-error', total > 100);
  elements.saveCustom.disabled = total > 100;
}

function fillConfig(config) {
  for (const name of configFields) $(`#${name}`).value = config[name];
  renderProbability();
}

function renderProfiles() {
  elements.profileGrid.innerHTML = state.profiles.map((profile) => {
    const active = state.profileId === profile.id;
    const config = profile.config;
    const errorRate = config.serviceUnavailableRate + config.timeoutRate + config.disconnectRate
      + config.rateLimitRate + config.malformedRate;
    return `<button class="profile-card${active ? ' is-active' : ''}" type="button" data-profile="${escapeHtml(profile.id)}">
      <span class="profile-check">${active ? '✓' : '→'}</span>
      <strong>${escapeHtml(profile.name)}</strong>
      <small>${escapeHtml(profile.description)}</small>
      <span class="profile-meta"><b>${config.minDelayMs}–${config.maxDelayMs} ms</b><i>${profile.sequenced ? '序列场景' : `异常 ${errorRate}%`}</i></span>
    </button>`;
  }).join('');
}

function renderLogs(logs) {
  if (!logs.length) {
    elements.logs.innerHTML = '<tr><td class="empty-table" colspan="6">暂无请求，可先运行一次探针。</td></tr>';
    return;
  }
  elements.logs.innerHTML = logs.map((log) => {
    const time = new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
    const outcomeClass = log.outcome === 'success' ? 'is-success' : 'is-failure';
    return `<tr><td>${escapeHtml(time)}</td><td><code>${escapeHtml(log.method)} ${escapeHtml(log.path)}</code></td><td>${escapeHtml(log.profileId)}</td><td><span class="outcome ${outcomeClass}">${escapeHtml(log.outcomeLabel)}</span></td><td>${log.delayMs} ms</td><td>${log.durationMs} ms</td></tr>`;
  }).join('');
}

function render(nextState, { preserveForm = false } = {}) {
  state = nextState;
  elements.masterToggle.checked = state.enabled;
  elements.masterLabel.textContent = state.enabled ? '弱网模拟已开启' : '弱网模拟已关闭';
  const profile = state.profiles.find((item) => item.id === state.profileId);
  elements.activeDescription.textContent = state.enabled
    ? (profile?.description || '当前使用自定义参数')
    : '所有 API 按正常速度运行';
  elements.activeProfile.textContent = state.enabled
    ? (profile?.name || '自定义')
    : '未启用';
  elements.activeProfile.classList.toggle('is-on', state.enabled);
  elements.serviceStatus.classList.add('is-online');
  elements.serviceStatus.lastElementChild.textContent = state.enabled ? '弱网模拟中' : '服务在线';
  renderProfiles();
  if (!preserveForm) fillConfig(state.config);
  elements.statTotal.textContent = state.stats.total;
  elements.statSuccess.textContent = `${state.stats.successRate}%`;
  elements.statDuration.textContent = state.stats.averageDurationMs;
  renderLogs(state.logs || []);
}

async function update(payload, message) {
  const nextState = await request('/api/network-simulator', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  render({ ...nextState, logs: state?.logs || [] });
  if (message) notify(message);
}

elements.masterToggle.addEventListener('change', async () => {
  try { await update({ enabled: elements.masterToggle.checked }, elements.masterToggle.checked ? '弱网模拟已开启' : '弱网模拟已关闭'); }
  catch (error) { elements.masterToggle.checked = !elements.masterToggle.checked; notify(error.message, true); }
});

elements.profileGrid.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-profile]');
  if (!button) return;
  try { await update({ profileId: button.dataset.profile, enabled: true }, `已切换到 ${button.querySelector('strong').textContent}`); }
  catch (error) { notify(error.message, true); }
});

for (const name of configFields) $(`#${name}`).addEventListener('input', renderProbability);

elements.saveCustom.addEventListener('click', async () => {
  try { await update({ config: configFromForm(), enabled: true }, '自定义弱网参数已应用'); }
  catch (error) { notify(error.message, true); }
});

elements.runProbe.addEventListener('click', async () => {
  const controller = new AbortController();
  const clientTimeout = Number(elements.clientTimeout.value);
  const timeout = setTimeout(() => controller.abort(), clientTimeout);
  const startedAt = performance.now();
  elements.runProbe.disabled = true;
  elements.probeResult.className = 'probe-result is-running';
  elements.probeResult.innerHTML = '<span class="probe-signal"></span><div><strong>请求中…</strong><small>正在经过当前弱网环境</small></div>';
  try {
    const result = await request('/api/network-simulator/probe', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Request-Id': crypto.randomUUID() },
      body: JSON.stringify({ sentAt: new Date().toISOString() }), signal: controller.signal,
    });
    const duration = Math.round(performance.now() - startedAt);
    elements.probeResult.className = 'probe-result is-success';
    elements.probeResult.innerHTML = `<span class="probe-signal"></span><div><strong>${result.raw ? '异常正文' : '请求成功'}</strong><small>${duration} ms${result.raw ? ' · JSON 解析失败' : ''}</small></div>`;
  } catch (error) {
    const duration = Math.round(performance.now() - startedAt);
    const message = error.name === 'AbortError' ? `客户端在 ${clientTimeout} ms 后超时` : error.message;
    elements.probeResult.className = 'probe-result is-failure';
    elements.probeResult.innerHTML = `<span class="probe-signal"></span><div><strong>请求失败</strong><small>${escapeHtml(message)} · ${duration} ms</small></div>`;
  } finally {
    clearTimeout(timeout);
    elements.runProbe.disabled = false;
    setTimeout(refresh, 500);
  }
});

elements.clearLogs.addEventListener('click', async () => {
  try {
    await request('/api/network-simulator/logs', { method: 'DELETE' });
    await refresh();
    notify('请求记录已清空');
  } catch (error) { notify(error.message, true); }
});

async function refresh({ preserveForm = true } = {}) {
  try {
    const nextState = await request('/api/network-simulator');
    render(nextState, { preserveForm });
  } catch {
    elements.serviceStatus.classList.remove('is-online');
    elements.serviceStatus.lastElementChild.textContent = '服务不可用';
  }
}

refresh({ preserveForm: false });
pollTimer = setInterval(refresh, 2000);
window.addEventListener('pagehide', () => clearInterval(pollTimer));
