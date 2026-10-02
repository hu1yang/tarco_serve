import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { LiveActivityHub } from '../src/live-activity-hub.js';

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.output = '';
    this.destroyed = false;
    this.writableEnded = false;
  }

  set() {}
  flushHeaders() {}
  write(value) { this.output += value; return true; }
}

test('broadcasts state and replays the latest state to a reconnecting client', () => {
  const hub = new LiveActivityHub();
  const first = new FakeResponse();
  const unsubscribeFirst = hub.subscribe('com.example.app', first);
  const published = hub.publish('com.example.app', {
    event: 'update',
    orderId: 'order-123',
    contentState: { status: 'boarding', progress: 0.4 },
  });
  assert.equal(published.delivered, 1);
  assert.match(first.output, /"status":"boarding"/);
  unsubscribeFirst();

  const second = new FakeResponse();
  const unsubscribeSecond = hub.subscribe('com.example.app', second);
  assert.match(second.output, /"status":"boarding"/);
  assert.equal(hub.getLatest('com.example.app').sequence, 1);
  unsubscribeSecond();
});

test('isolates subscribers by bundle id', () => {
  const hub = new LiveActivityHub();
  const client = new FakeResponse();
  const unsubscribe = hub.subscribe('com.example.one', client);
  const result = hub.publish('com.example.two', {
    event: 'update',
    orderId: 'order-456',
    contentState: { status: 'other' },
  });
  assert.equal(result.delivered, 0);
  assert.doesNotMatch(client.output, /other/);
  unsubscribe();
});

test('requires a safe order id for every state change', () => {
  const hub = new LiveActivityHub();
  assert.throws(
    () => hub.publish('com.example.app', {
      event: 'end',
      orderId: '../other-order',
      contentState: { status: 'cancelled' },
    }),
    /orderId/,
  );
});
