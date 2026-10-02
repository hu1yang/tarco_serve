const DEFAULT_LOG_LIMIT = 60;

export const NETWORK_PROFILES = Object.freeze({
  normal: {
    name: '正常网络',
    description: '20–80 ms 延迟，全部成功。',
    minDelayMs: 20,
    maxDelayMs: 80,
  },
  'weak-4g': {
    name: '弱 4G',
    description: '300–1200 ms 抖动，偶发 503、超时和断线。',
    minDelayMs: 300,
    maxDelayMs: 1200,
    serviceUnavailableRate: 5,
    timeoutRate: 3,
    disconnectRate: 2,
  },
  'unstable-3g': {
    name: '不稳定 3G',
    description: '900–4500 ms 高抖动，混合错误、超时和异常正文。',
    minDelayMs: 900,
    maxDelayMs: 4500,
    serviceUnavailableRate: 12,
    timeoutRate: 10,
    disconnectRate: 6,
    malformedRate: 4,
  },
  'poor-2g': {
    name: '极差 2G',
    description: '3–8 秒延迟，成功率约 45%。',
    minDelayMs: 3000,
    maxDelayMs: 8000,
    serviceUnavailableRate: 22,
    timeoutRate: 18,
    disconnectRate: 10,
    malformedRate: 5,
  },
  'high-jitter': {
    name: '高抖动',
    description: '相同请求可能在 30 ms 到 6 秒之间返回。',
    minDelayMs: 30,
    maxDelayMs: 6000,
  },
  'intermittent-offline': {
    name: '间歇断网',
    description: '成功、503、连接中断和超时按序交替。',
    minDelayMs: 100,
    maxDelayMs: 1600,
    sequence: ['success', 'success', 'service-unavailable', 'disconnect', 'success', 'timeout'],
  },
  'rate-limited': {
    name: '接口限流',
    description: '固定返回 429，验证指数退避。',
    minDelayMs: 50,
    maxDelayMs: 200,
    sequence: ['rate-limited'],
  },
  'malformed-response': {
    name: '响应格式异常',
    description: 'HTTP 200，但正文不是合法 JSON。',
    minDelayMs: 30,
    maxDelayMs: 120,
    sequence: ['malformed'],
  },
  'burst-loss': {
    name: '突发连续丢失',
    description: '连续 5 次成功后断开 3 次，然后循环。',
    minDelayMs: 80,
    maxDelayMs: 500,
    sequence: ['success', 'success', 'success', 'success', 'success', 'disconnect', 'disconnect', 'disconnect'],
  },
});

const OUTCOME_LABELS = {
  success: '成功',
  'service-unavailable': '503 服务不可用',
  timeout: '超时',
  disconnect: '连接中断',
  'rate-limited': '429 限流',
  malformed: '异常正文',
};

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

const DEFAULT_CONFIG = Object.freeze({
  minDelayMs: 0,
  maxDelayMs: 0,
  serviceUnavailableRate: 0,
  timeoutRate: 0,
  disconnectRate: 0,
  rateLimitRate: 0,
  malformedRate: 0,
  timeoutMs: 8000,
});

function normalizeConfig(input = {}, fallback = DEFAULT_CONFIG) {
  const minDelayMs = clampNumber(input.minDelayMs, 0, 30_000, fallback.minDelayMs);
  const maxDelayMs = clampNumber(input.maxDelayMs, minDelayMs, 30_000, fallback.maxDelayMs);
  const config = {
    minDelayMs,
    maxDelayMs,
    serviceUnavailableRate: clampNumber(input.serviceUnavailableRate, 0, 100, fallback.serviceUnavailableRate || 0),
    timeoutRate: clampNumber(input.timeoutRate, 0, 100, fallback.timeoutRate || 0),
    disconnectRate: clampNumber(input.disconnectRate, 0, 100, fallback.disconnectRate || 0),
    rateLimitRate: clampNumber(input.rateLimitRate, 0, 100, fallback.rateLimitRate || 0),
    malformedRate: clampNumber(input.malformedRate, 0, 100, fallback.malformedRate || 0),
    timeoutMs: clampNumber(input.timeoutMs, 1000, 30_000, fallback.timeoutMs || 8000),
  };
  const totalRate = config.serviceUnavailableRate + config.timeoutRate + config.disconnectRate
    + config.rateLimitRate + config.malformedRate;
  if (totalRate > 100) throw new Error('所有异常概率之和不能超过 100%');
  return config;
}

function randomDelay(config, random) {
  return Math.round(config.minDelayMs + random() * (config.maxDelayMs - config.minDelayMs));
}

export class NetworkSimulator {
  constructor({ random = Math.random, now = Date.now, logLimit = DEFAULT_LOG_LIMIT } = {}) {
    this.random = random;
    this.now = now;
    this.logLimit = logLimit;
    this.enabled = false;
    this.profileId = 'weak-4g';
    this.config = normalizeConfig(NETWORK_PROFILES[this.profileId]);
    this.sequence = NETWORK_PROFILES[this.profileId].sequence || null;
    this.requestNumber = 0;
    this.logs = [];
  }

  getState() {
    return {
      enabled: this.enabled,
      profileId: this.profileId,
      config: { ...this.config },
      profiles: Object.entries(NETWORK_PROFILES).map(([id, profile]) => ({
        id,
        name: profile.name,
        description: profile.description,
        config: normalizeConfig(profile),
        sequenced: Boolean(profile.sequence),
      })),
      stats: this.getStats(),
    };
  }

  configure(input = {}) {
    this.enabled = input.enabled === undefined ? this.enabled : Boolean(input.enabled);
    if (input.profileId && input.profileId !== 'custom') {
      const profile = NETWORK_PROFILES[input.profileId];
      if (!profile) throw new Error(`未知弱网预设: ${input.profileId}`);
      this.profileId = input.profileId;
      this.config = normalizeConfig(profile);
      this.sequence = profile.sequence || null;
      this.requestNumber = 0;
    }
    if (input.config) {
      this.profileId = 'custom';
      this.config = normalizeConfig(input.config, this.config);
      this.sequence = null;
      this.requestNumber = 0;
    }
    return this.getState();
  }

  clearLogs() {
    this.logs = [];
    return this.getStats();
  }

  getStats() {
    const total = this.logs.length;
    const successful = this.logs.filter((item) => item.outcome === 'success').length;
    const durations = this.logs.map((item) => item.durationMs);
    return {
      total,
      successful,
      failed: total - successful,
      successRate: total ? Math.round((successful / total) * 100) : 0,
      averageDurationMs: total ? Math.round(durations.reduce((sum, value) => sum + value, 0) / total) : 0,
    };
  }

  pickOutcome() {
    if (this.sequence) {
      return this.sequence[this.requestNumber++ % this.sequence.length];
    }
    this.requestNumber += 1;
    const value = this.random() * 100;
    let cursor = this.config.serviceUnavailableRate;
    if (value < cursor) return 'service-unavailable';
    cursor += this.config.timeoutRate;
    if (value < cursor) return 'timeout';
    cursor += this.config.disconnectRate;
    if (value < cursor) return 'disconnect';
    cursor += this.config.rateLimitRate;
    if (value < cursor) return 'rate-limited';
    cursor += this.config.malformedRate;
    return value < cursor ? 'malformed' : 'success';
  }

  record(request, outcome, startedAt, delayMs) {
    const entry = {
      id: `${this.now()}-${this.requestNumber}`,
      timestamp: new Date(this.now()).toISOString(),
      method: request.method,
      path: request.originalUrl || request.url,
      profileId: this.profileId,
      outcome,
      outcomeLabel: OUTCOME_LABELS[outcome] || outcome,
      delayMs,
      durationMs: Math.max(0, this.now() - startedAt),
    };
    this.logs.unshift(entry);
    this.logs.length = Math.min(this.logs.length, this.logLimit);
    return entry;
  }

  middleware() {
    return async (request, response, next) => {
      if (!this.enabled) return next();
      const startedAt = this.now();
      const delayMs = randomDelay(this.config, this.random);
      const outcome = this.pickOutcome();
      response.set('X-Network-Profile', this.profileId);
      response.set('X-Simulated-Delay', String(delayMs));
      response.set('X-Network-Outcome', outcome);

      await new Promise((resolve) => setTimeout(resolve, delayMs));

      if (outcome === 'disconnect') {
        this.record(request, outcome, startedAt, delayMs);
        request.socket.destroy();
        return;
      }
      if (outcome === 'timeout') {
        await new Promise((resolve) => setTimeout(resolve, this.config.timeoutMs));
        this.record(request, outcome, startedAt, delayMs);
        if (!response.headersSent) response.status(504).json({ error: '模拟弱网：请求超时' });
        return;
      }
      if (outcome === 'service-unavailable') {
        this.record(request, outcome, startedAt, delayMs);
        response.status(503).json({ error: '模拟弱网：服务暂时不可用' });
        return;
      }
      if (outcome === 'rate-limited') {
        this.record(request, outcome, startedAt, delayMs);
        response.set('Retry-After', '2').status(429).json({ error: '模拟弱网：请求过于频繁' });
        return;
      }
      if (outcome === 'malformed') {
        this.record(request, outcome, startedAt, delayMs);
        response.status(200).type('text/plain').send('<html>unexpected gateway response');
        return;
      }

      response.once('finish', () => this.record(request, 'success', startedAt, delayMs));
      return next();
    };
  }
}
