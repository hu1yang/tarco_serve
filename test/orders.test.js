import assert from 'node:assert/strict';
import test from 'node:test';
import { mockOrder } from '../src/orders.js';

test('builds deterministic flight details from an order id', () => {
  const now = new Date('2026-09-03T06:00:00.000Z');
  const order = mockOrder('order-123', { now });

  assert.equal(order.id, 'order-123');
  assert.equal(order.reference, 'TRC8F2');
  assert.equal(order.segments[0].departureAt, '2026-09-03T08:00:00.000Z');
  assert.equal(order.segments[0].departure.code, 'KRT');
  assert.equal(order.segments[0].arrival.code, 'JED');
});

test('rejects an unsafe order id', () => {
  assert.throws(() => mockOrder('../secret'), /orderId/);
});
