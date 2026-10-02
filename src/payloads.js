function unixSeconds(value, fieldName) {
  if (value === undefined) return undefined;
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  const seconds = Math.floor(date.getTime() / 1000);
  if (!Number.isFinite(seconds)) throw new Error(`${fieldName} 不是有效日期`);
  return seconds;
}

export function notificationPayload({ alert, badge, sound = 'default', data = {} }) {
  if (!alert || (!alert.title && !alert.body)) {
    throw new Error('alert.title 或 alert.body 至少需要一个');
  }
  if (data.aps !== undefined) throw new Error('data 中不能包含保留字段 aps');

  return {
    aps: {
      alert,
      sound,
      ...(badge !== undefined ? { badge } : {}),
    },
    ...data,
  };
}

export function liveActivityPayload({
  event,
  contentState,
  alert,
  staleDate,
  dismissalDate,
  attributesType,
  attributes,
}) {
  if (!['start', 'update', 'end'].includes(event)) throw new Error('无效的 Live Activity event');
  if (!contentState || typeof contentState !== 'object' || Array.isArray(contentState)) {
    throw new Error('contentState 必须是对象');
  }
  if (event === 'start' && (!attributesType || !attributes)) {
    throw new Error('start 事件需要 attributesType 和 attributes');
  }

  return {
    aps: {
      timestamp: Math.floor(Date.now() / 1000),
      event,
      'content-state': contentState,
      ...(alert ? { alert } : {}),
      ...(staleDate !== undefined ? { 'stale-date': unixSeconds(staleDate, 'staleDate') } : {}),
      ...(dismissalDate !== undefined
        ? { 'dismissal-date': unixSeconds(dismissalDate, 'dismissalDate') }
        : {}),
      ...(event === 'start' ? {
        'attributes-type': attributesType,
        attributes,
      } : {}),
    },
  };
}

export function androidLiveUpdatePayload({ event, orderId, contentState, attributes }) {
  if (!['start', 'update', 'end'].includes(event)) throw new Error('无效的实时通知 event');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(orderId || '')) throw new Error('orderId 格式无效');
  if (!contentState || typeof contentState !== 'object' || Array.isArray(contentState)) {
    throw new Error('contentState 必须是对象');
  }
  const progress = contentState.progress;
  if (progress !== undefined && (typeof progress !== 'number' || progress < 0 || progress > 1)) {
    throw new Error('progress 必须在 0 到 1 之间');
  }
  if (event === 'start' && (!attributes || typeof attributes !== 'object'
    || !['flightNumber', 'origin', 'destination'].every((field) =>
      typeof attributes[field] === 'string' && attributes[field].trim()))) {
    throw new Error('启动需要 flightNumber、origin 和 destination');
  }
  return { event, orderId, contentState, ...(attributes ? { attributes } : {}) };
}
