import assert from 'node:assert/strict';
import test from 'node:test';
import { androidLiveUpdatePayload, liveActivityPayload, notificationPayload } from '../src/payloads.js';

test('builds a regular notification payload', () => {
  assert.deepEqual(notificationPayload({
    alert: { title: '你好', body: '测试消息' },
    badge: 1,
    data: { orderId: '123' },
  }), {
    aps: { alert: { title: '你好', body: '测试消息' }, sound: 'default', badge: 1 },
    orderId: '123',
  });
});

test('builds a Live Activity update payload', () => {
  const payload = liveActivityPayload({ event: 'update', contentState: { progress: 0.5 } });
  assert.equal(payload.aps.event, 'update');
  assert.deepEqual(payload.aps['content-state'], { progress: 0.5 });
  assert.equal(typeof payload.aps.timestamp, 'number');
});

test('requires attributes for push-to-start', () => {
  assert.throws(
    () => liveActivityPayload({ event: 'start', contentState: {} }),
    /attributesType/,
  );
});

test('validates an Android live update start', () => {
  const payload = androidLiveUpdatePayload({
    event: 'start', orderId: 'order-123',
    attributes: { flightNumber: 'WY 669', origin: 'MCT', destination: 'DOH' },
    contentState: { status: 'Boarding', progress: 0.2 },
  });
  assert.equal(payload.orderId, 'order-123');
  assert.throws(() => androidLiveUpdatePayload({
    event: 'start', orderId: 'order-123', attributes: {}, contentState: {},
  }), /flightNumber/);
});
