import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createFlightStoreFixture } from './flight-store-fixture.js';

function createCityImageStoreFixture() {
  const items = new Map();
  return {
    async get(code) { return items.get(code) || null; },
    async list() { return [...items.values()]; },
    async upsert(input, code = input.arrAirport) {
      const value = {
        arrAirport: code.trim().toUpperCase(),
        cityName: input.cityName.trim(),
        imageSrc: input.imageSrc,
        createdAt: '2026-09-23T00:00:00.000Z',
        updatedAt: '2026-09-23T00:00:00.000Z',
      };
      items.set(value.arrAirport, value);
      return value;
    },
    async delete(code) { return items.delete(code); },
  };
}

test('serves the local push console', async (context) => {
  const server = createApp({ pushClient: { transport: 'test' } }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Tarco Ops/);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
});

test('initializes a client key and uses it for push requests', async (context) => {
  let received;
  const pushClient = {
    transport: 'test',
    async sendNotification(token, payload, session) {
      received = { token, payload, session };
      return { id: 'push-1' };
    },
  };
  const server = createApp({ pushClient }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());
  const { port } = server.address();

  const initResponse = await fetch(`http://127.0.0.1:${port}/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bundleId: 'com.example.flutterApp' }),
  });
  assert.equal(initResponse.status, 201);
  const { key } = await initResponse.json();

  const pushResponse = await fetch(`http://127.0.0.1:${port}/api/push/notification`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ alert: { title: 'hello' } }),
  });
  assert.equal(pushResponse.status, 200);
  assert.equal(received.session.bundleId, 'com.example.flutterApp');
  assert.equal(received.payload.aps.alert.title, 'hello');
});

test('rejects a push request without a key', async (context) => {
  const server = createApp({ pushClient: { transport: 'test' } }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/push/notification`, { method: 'POST' });
  assert.equal(response.status, 401);
});

test('saves, returns and deletes a city image by arrAirport', async (context) => {
  const cityImageStore = createCityImageStoreFixture();
  const server = createApp({ pushClient: { transport: 'test' }, cityImageStore })
    .listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { key } = await fetch(`${baseUrl}/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bundleId: 'com.example.tarcoAviation' }),
  }).then((response) => response.json());
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };

  const saved = await fetch(`${baseUrl}/api/admin/city-images`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      arrAirport: 'DOH', cityName: 'Doha', imageSrc: 'https://images.example.com/doha.jpg',
    }),
  });
  assert.equal(saved.status, 201);

  const found = await fetch(`${baseUrl}/api/city-image?arrAirport=DOH`, { headers });
  assert.equal(found.status, 200);
  assert.deepEqual((await found.json()).data, {
    arrAirport: 'DOH',
    cityName: 'Doha',
    imageSrc: 'https://images.example.com/doha.jpg',
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
  });

  const removed = await fetch(`${baseUrl}/api/admin/city-images/DOH`, { method: 'DELETE', headers });
  assert.equal(removed.status, 200);
  const missing = await fetch(`${baseUrl}/api/city-image?arrAirport=DOH`, { headers });
  assert.equal(missing.status, 404);
});

test('configures the network simulator and applies it to probe requests', async (context) => {
  const server = createApp({ pushClient: { transport: 'test' } }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const configured = await fetch(`${baseUrl}/api/network-simulator`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profileId: 'rate-limited', enabled: true }),
  });
  assert.equal(configured.status, 200);
  assert.equal((await configured.json()).profileId, 'rate-limited');

  const probe = await fetch(`${baseUrl}/api/network-simulator/probe`, { method: 'POST' });
  assert.equal(probe.status, 429);
  assert.equal(probe.headers.get('x-network-outcome'), 'rate-limited');
  assert.equal(probe.headers.get('retry-after'), '2');

  const state = await fetch(`${baseUrl}/api/network-simulator`).then((response) => response.json());
  assert.equal(state.stats.total, 1);
  assert.equal(state.stats.failed, 1);
  assert.equal(state.logs[0].outcome, 'rate-limited');
});

test('publishes and reads the latest Live Activity state', async (context) => {
  const server = createApp({ pushClient: { transport: 'test' } }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const init = await fetch(`${baseUrl}/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bundleId: 'com.example.flutterApp' }),
  }).then((response) => response.json());

  const published = await fetch(`${baseUrl}/api/live-activity/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${init.key}` },
    body: JSON.stringify({
      event: 'update',
      orderId: 'order-123',
      contentState: { status: 'Boarding', gate: 'A12', progress: 0.6 },
    }),
  });
  assert.equal(published.status, 202);

  const latest = await fetch(`${baseUrl}/api/live-activity/state`, {
    headers: { authorization: `Bearer ${init.key}` },
  }).then((response) => response.json());
  assert.equal(latest.state.event, 'update');
  assert.equal(latest.state.orderId, 'order-123');
  assert.equal(latest.state.contentState.progress, 0.6);
});

test('returns a confirmed order departing in about two hours', async (context) => {
  const server = createApp({ pushClient: { transport: 'test' } }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());
  const { port } = server.address();

  const initResponse = await fetch(`http://127.0.0.1:${port}/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bundleId: 'com.example.tarcoAviation' }),
  });
  const { key } = await initResponse.json();

  const beforeRequest = Date.now();
  const response = await fetch(`http://127.0.0.1:${port}/api/orders/order-123`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const order = await response.json();
  const departureDelay = new Date(order.segments[0].departureAt).getTime() - beforeRequest;

  assert.equal(response.status, 200);
  assert.equal(order.id, 'order-123');
  assert.equal(order.status, 'confirmed');
  assert.equal(order.segments[0].flightNumber, '3T 210');
  assert.ok(departureDelay >= (2 * 60 * 60 * 1000) - 1000);
  assert.ok(departureDelay <= (2 * 60 * 60 * 1000) + 1000);
});

test('searches flights using airport codes and a dd MMM yyyy date', async (context) => {
  const server = createApp({ pushClient: { transport: 'test' }, flightStore: createFlightStoreFixture() }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const { key } = await fetch(`${baseUrl}/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bundleId: 'com.example.tarcoAviation' }),
  }).then((response) => response.json());

  const requestStartedAt = Date.now();
  const params = new URLSearchParams({ depAirport: 'MCT', arrAirport: 'DOH', departure: '05 Sep 2026' });
  const response = await fetch(`${baseUrl}/api/flights/search?${params}`, {
    headers: { authorization: `Bearer ${key}` },
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.ok(Date.now() - requestStartedAt >= 500);
  assert.equal(result.code, 200);
  assert.equal(result.message, 'success');
  assert.equal(result.data.currency, 'SAR');
  assert.equal(result.data.departureDate, '2026-09-05');
  assert.deepEqual(result.data.origin, { code: 'MCT', city: 'Muscat' });
  assert.deepEqual(result.data.destination, { code: 'DOH', city: 'Doha' });
  assert.equal(result.data.resultCount, 3);
  assert.equal(result.data.flights.length, 3);
  assert.ok(new Set(result.data.flights.map((flight) => flight.departureTime)).size > 1);
  assert.ok(new Set(result.data.flights.map((flight) => flight.baseFare)).size > 1);
  assert.ok(result.data.flights.some((flight) => flight.stops.length === 0));
  assert.ok(result.data.flights.some((flight) => flight.stops.length > 0));
  assert.equal(result.data.flights.filter((flight) => flight.lowestFare).length, 1);
  assert.equal(result.data.flights[0].id, 'mock-flight-001');
  assert.equal(result.data.flights[0].fareOptions[0].code, 'ECONOMY_SUPER_SAVER');
  assert.equal(result.data.flights[2].fareOptions[1].code, 'BUSINESS_FLEX');
});

test('rejects an invalid flight search date', async (context) => {
  const server = createApp({ pushClient: { transport: 'test' } }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const { key } = await fetch(`${baseUrl}/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bundleId: 'com.example.tarcoAviation' }),
  }).then((response) => response.json());

  const params = new URLSearchParams({ depAirport: 'MCT', arrAirport: 'DOH', departure: '31 Feb 2026' });
  const response = await fetch(`${baseUrl}/api/flights/search?${params}`, {
    headers: { authorization: `Bearer ${key}` },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    code: 400,
    message: 'departure 不是有效日期',
    data: null,
  });
});

test('returns all available dates through the restricted month range', async (context) => {
  const server = createApp({
    pushClient: { transport: 'test' },
    flightStore: createFlightStoreFixture(),
    now: () => new Date('2026-08-30T12:00:00.000Z'),
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const { key } = await fetch(`${baseUrl}/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bundleId: 'com.example.tarcoAviation' }),
  }).then((response) => response.json());

  const response = await fetch(`${baseUrl}/api/flights/lowest-fares`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      depAirport: 'MCT',
      arrAirport: 'DOH',
      departure: '05 Sep 2026',
      restrictedMonths: 2,
    }),
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.code, 200);
  assert.equal(result.message, 'success');
  assert.equal(result.data.currency, 'SAR');
  assert.equal(result.data.restrictedMonths, 2);
  assert.equal(result.data.startDate, '2026-08-30');
  assert.equal(result.data.endDate, '2026-09-30');
  assert.equal(result.data.selectedDate, '2026-09-05');
  assert.equal(result.data.fares.length, 32);
  assert.equal(result.data.fares[0].date, '2026-08-30');
  assert.equal(result.data.fares[6].date, '2026-09-05');
  assert.equal(result.data.fares[6].isSegment, true);
  assert.equal(typeof result.data.fares[6].lostPrice, 'number');
  assert.equal(result.data.fares.at(-1).date, '2026-09-30');
  assert.ok(result.data.fares.some((fare) => fare.isSegment));
  assert.ok(result.data.fares.some((fare) => !fare.isSegment && fare.lostPrice === null));
});

test('returns lowest fares from today through the requested maximum month', async (context) => {
  const server = createApp({
    pushClient: { transport: 'test' },
    flightStore: createFlightStoreFixture(),
    now: () => new Date('2026-08-30T12:00:00.000Z'),
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const { key } = await fetch(`${baseUrl}/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bundleId: 'com.example.tarcoAviation' }),
  }).then((response) => response.json());

  const response = await fetch(`${baseUrl}/api/flights/lowest-fares-by-months`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      depAirport: 'MCT',
      arrAirport: 'DOH',
      restrictedMonths: 3,
    }),
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.code, 200);
  assert.equal(result.data.restrictedMonths, 3);
  assert.equal(result.data.startDate, '2026-08-30');
  assert.equal(result.data.endDate, '2026-10-31');
  assert.equal(result.data.fares.length, 63);
  assert.equal(result.data.fares[0].date, '2026-08-30');
  assert.equal(result.data.fares.at(-1).date, '2026-10-31');
});

test('returns monthly fares on and after an optional start date', async (context) => {
  const server = createApp({
    pushClient: { transport: 'test' },
    flightStore: createFlightStoreFixture(),
    now: () => new Date('2026-08-30T12:00:00.000Z'),
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const { key } = await fetch(`${baseUrl}/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bundleId: 'com.example.tarcoAviation' }),
  }).then((response) => response.json());

  const response = await fetch(`${baseUrl}/api/flights/lowest-fares-by-months`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      depAirport: 'MCT', arrAirport: 'DOH', restrictedMonths: 3, startDate: '2026-10-10',
    }),
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.data.startDate, '2026-10-10');
  assert.equal(result.data.endDate, '2026-10-31');
  assert.equal(result.data.fares.length, 22);
  assert.equal(result.data.fares[0].date, '2026-10-10');
  assert.equal(result.data.fares.at(-1).date, '2026-10-31');
});

test('rejects an invalid restricted month count', async (context) => {
  const server = createApp({ pushClient: { transport: 'test' } }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const { key } = await fetch(`${baseUrl}/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bundleId: 'com.example.tarcoAviation' }),
  }).then((response) => response.json());

  const response = await fetch(`${baseUrl}/api/flights/lowest-fares-by-months`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ depAirport: 'MCT', arrAirport: 'DOH', restrictedMonths: 0 }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    code: 400,
    message: 'restrictedMonths 必须是 1 到 12 之间的整数',
    data: null,
  });
});
