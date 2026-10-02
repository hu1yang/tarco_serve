import crypto from 'node:crypto';

const EVENTS = new Set(['start', 'update', 'end']);
const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class LiveActivityHub {
  constructor() {
    this.clients = new Map();
    this.latest = new Map();
    this.sequence = 0;
  }

  publish(bundleId, input) {
    const event = input.event || 'update';
    if (!EVENTS.has(event)) throw new Error('event 必须是 start、update 或 end');
    if (!ORDER_ID_PATTERN.test(input.orderId || '')) {
      throw new Error('orderId 格式无效');
    }
    if (!input.contentState || typeof input.contentState !== 'object' || Array.isArray(input.contentState)) {
      throw new Error('contentState 必须是对象');
    }
    if (event === 'start' && (!input.attributesType || !input.attributes)) {
      throw new Error('start 需要 attributesType 和 attributes');
    }

    const message = {
      id: crypto.randomUUID(),
      sequence: ++this.sequence,
      event,
      orderId: input.orderId,
      contentState: input.contentState,
      ...(input.attributesType ? { attributesType: input.attributesType } : {}),
      ...(input.attributes ? { attributes: input.attributes } : {}),
      publishedAt: new Date().toISOString(),
    };
    this.latest.set(bundleId, message);

    let delivered = 0;
    for (const response of this.clients.get(bundleId) || []) {
      if (this.#write(response, message)) delivered += 1;
    }
    return { message, delivered };
  }

  getLatest(bundleId) {
    return this.latest.get(bundleId) || null;
  }

  subscribe(bundleId, response) {
    response.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    response.write('retry: 2000\n\n');

    const clients = this.clients.get(bundleId) || new Set();
    clients.add(response);
    this.clients.set(bundleId, clients);

    const latest = this.latest.get(bundleId);
    if (latest) this.#write(response, latest);

    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
    const unsubscribe = () => {
      clearInterval(heartbeat);
      clients.delete(response);
      if (clients.size === 0) this.clients.delete(bundleId);
    };
    response.once('close', unsubscribe);
    return unsubscribe;
  }

  subscriberCount(bundleId) {
    return this.clients.get(bundleId)?.size || 0;
  }

  #write(response, message) {
    if (response.destroyed || response.writableEnded) return false;
    response.write(`id: ${message.id}\n`);
    response.write('event: live-activity\n');
    response.write(`data: ${JSON.stringify(message)}\n\n`);
    return true;
  }
}
