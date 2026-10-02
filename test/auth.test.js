import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { AuthError } from '../src/auth-store.js';

function createAuthStoreFixture() {
  const users = new Map();
  const tokens = new Map();
  const refreshTokens = new Map();
  const devices = [];
  const guests = new Map();
  const mergeGuest = (guestToken, userId) => {
    if (!guestToken) return false;
    const guest = guests.get(guestToken);
    if (!guest) throw new AuthError('游客身份无效或已过期', { status: 401, code: 'INVALID_GUEST_SESSION' });
    guest.userId = userId;
    for (const device of devices.filter((item) => item.guestId === guest.guestId)) {
      const { guestId: _guestId, ...installation } = device;
      devices.push({ ...installation, userId });
    }
    return true;
  };
  return {
    async register(input) {
      const email = input.email?.trim().toLowerCase();
      if (users.has(email)) {
        throw new AuthError('该邮箱已注册', { status: 409, code: 'EMAIL_ALREADY_REGISTERED' });
      }
      const user = {
        id: String(users.size + 1), firstName: input.firstName.trim(), lastName: input.lastName.trim(),
        email, createdAt: '2026-09-10T00:00:00.000Z',
      };
      users.set(email, { user, password: input.password });
      const guestMerged = mergeGuest(input.guestToken, user.id);
      const accessToken = `token-${user.id}`;
      const refreshToken = `refresh-token-${user.id}`;
      tokens.set(accessToken, user);
      refreshTokens.set(refreshToken, user);
      return {
        user, accessToken, refreshToken, tokenType: 'Bearer',
        expiresAt: '2026-10-10T00:00:00.000Z',
        refreshExpiresAt: '2026-12-10T00:00:00.000Z', guestMerged,
      };
    },
    async login(input) {
      const account = users.get(input.email?.trim().toLowerCase());
      if (!account || account.password !== input.password) {
        throw new AuthError('邮箱或密码错误', { status: 401, code: 'INVALID_CREDENTIALS' });
      }
      const accessToken = `login-token-${account.user.id}`;
      const refreshToken = `login-refresh-token-${account.user.id}`;
      tokens.set(accessToken, account.user);
      refreshTokens.set(refreshToken, account.user);
      const guestMerged = mergeGuest(input.guestToken, account.user.id);
      return {
        user: account.user, accessToken, refreshToken, tokenType: 'Bearer',
        expiresAt: '2026-10-10T00:00:00.000Z', refreshExpiresAt: '2026-12-10T00:00:00.000Z',
        guestMerged,
      };
    },
    async authenticate(token) {
      const user = tokens.get(token);
      if (!user) throw new AuthError('登录状态无效或已过期', { status: 401, code: 'UNAUTHORIZED' });
      return user;
    },
    async refresh(refreshToken) {
      const user = refreshTokens.get(refreshToken);
      if (!user) throw new AuthError('登录已过期，请重新登录', { status: 401, code: 'INVALID_REFRESH_TOKEN' });
      const accessToken = `refreshed-access-${user.id}`;
      tokens.set(accessToken, user);
      return {
        user, accessToken, refreshToken, tokenType: 'Bearer',
        expiresAt: '2026-10-11T00:00:00.000Z', refreshExpiresAt: '2026-12-11T00:00:00.000Z',
      };
    },
    async logout(token, refreshToken) {
      tokens.delete(token);
      if (refreshToken) refreshTokens.delete(refreshToken);
    },
    async createGuest(input) {
      const guestId = '550e8400-e29b-41d4-a716-446655440000';
      const guestToken = 'guest-token-1';
      guests.set(guestToken, { guestId, userId: null });
      devices.push({
        ...input, platform: input.platform || 'ios', pushToken: input.pushToken || null, guestId,
        lastSeenAt: '2026-09-10T00:00:00.000Z',
      });
      return {
        guestId, guestToken, tokenType: 'Guest', expiresAt: '2026-12-10T00:00:00.000Z',
        device: { ...input, platform: input.platform || 'ios', pushToken: input.pushToken || null },
      };
    },
    async resumeGuest(guestToken, input) {
      const guest = guests.get(guestToken);
      if (!guest) throw new AuthError('游客身份无效或已过期', { status: 401, code: 'INVALID_GUEST_SESSION' });
      const existing = devices.findIndex((device) => device.deviceId === input.deviceId
        && device.bundleId === input.bundleId);
      const device = {
        ...input, platform: input.platform || 'ios', pushToken: input.pushToken || null,
        ...(guest.userId ? { userId: guest.userId } : { guestId: guest.guestId }),
        lastSeenAt: '2026-09-11T00:00:00.000Z',
      };
      if (existing >= 0) devices[existing] = device; else devices.push(device);
      return {
        guestId: guest.guestId, guestToken, tokenType: 'Guest',
        expiresAt: '2026-12-10T00:00:00.000Z', mergedIntoUserId: guest.userId,
        device: { ...input, platform: input.platform || 'ios', pushToken: input.pushToken || null },
      };
    },
    async registerDevice(token, input) {
      const user = await this.authenticate(token);
      const device = { ...input, platform: input.platform || 'ios', pushToken: input.pushToken || null };
      const existing = devices.findIndex((item) => item.deviceId === device.deviceId
        && item.bundleId === device.bundleId);
      const record = { ...device, userId: user.id, lastSeenAt: '2026-09-10T00:00:00.000Z' };
      if (existing >= 0) devices[existing] = record; else devices.push(record);
      return device;
    },
    async devicesForToken(token) {
      const user = await this.authenticate(token);
      return this.devicesForUser(user.id);
    },
    async devicesForUser(userId) {
      return devices.filter((device) => device.userId === String(userId));
    },
    async devicesForGuest(guestId) {
      const guest = [...guests.values()].find((item) => item.guestId === guestId);
      if (guest?.userId) return this.devicesForUser(guest.userId);
      return devices.filter((device) => device.guestId === guestId);
    },
    async adminDevices() {
      return devices.map((device, index) => ({
        identityType: device.userId ? 'user' : 'guest',
        recordId: String(index + 1),
        ownerId: device.userId || device.guestId,
        ownerName: device.userId ? 'Test User' : '游客',
        ownerEmail: device.userId ? 'device@example.com' : null,
        mergedIntoUserId: device.guestId
          ? guests.get('guest-token-1')?.userId || null : null,
        deviceId: device.deviceId,
        platform: device.platform,
        hasPushToken: Boolean(device.pushToken),
        simulatorUdid: device.simulatorUdid || null,
        maskedPushToken: device.pushToken ? `${device.pushToken.slice(0, 4)}••••${device.pushToken.slice(-4)}` : null,
        bundleId: device.bundleId,
        deviceName: device.deviceName || null,
        lastSeenAt: device.lastSeenAt,
      }));
    },
    async adminDevice(identityType, recordId) {
      const device = devices[Number(recordId) - 1];
      const actualType = device?.userId ? 'user' : 'guest';
      if (!device || actualType !== identityType) {
        throw new AuthError('设备不存在', { status: 404, code: 'DEVICE_NOT_FOUND' });
      }
      return {
        identityType, recordId, ownerId: device.userId || device.guestId,
        deviceId: device.deviceId, pushToken: device.pushToken,
        platform: device.platform,
        simulatorUdid: device.simulatorUdid || null,
        bundleId: device.bundleId, deviceName: device.deviceName || null,
      };
    },
    async removeDevice(token, deviceId) {
      const user = await this.authenticate(token);
      const index = devices.findIndex((device) => device.userId === user.id && device.deviceId === deviceId);
      if (index < 0) return false;
      devices.splice(index, 1);
      return true;
    },
  };
}

async function startServer(context) {
  const server = createApp({
    pushClient: { transport: 'test' },
    authStore: createAuthStoreFixture(),
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('registers a user and returns a bearer token without exposing the password', async (context) => {
  const baseUrl = await startServer(context);
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firstName: '  Ali ', lastName: ' Khan  ', email: 'ALI@EXAMPLE.COM', password: 'flight123',
    }),
  });
  const result = await response.json();

  assert.equal(response.status, 201);
  assert.equal(result.code, 201);
  assert.deepEqual(result.data.user, {
    id: '1', firstName: 'Ali', lastName: 'Khan', email: 'ali@example.com',
    createdAt: '2026-09-10T00:00:00.000Z',
  });
  assert.equal(result.data.tokenType, 'Bearer');
  assert.equal(result.data.accessToken, 'token-1');
  assert.equal(JSON.stringify(result).includes('flight123'), false);
});

test('logs in, reads the current user, and invalidates the token on logout', async (context) => {
  const baseUrl = await startServer(context);
  const account = { firstName: 'Sara', lastName: 'Lee', email: 'sara@example.com', password: 'secure123' };
  await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(account),
  });
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  const loginResult = await login.json();
  const headers = { authorization: `Bearer ${loginResult.data.accessToken}` };

  assert.equal(login.status, 200);
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).data.user.email, account.email);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(`${baseUrl}/api/auth/me`, { headers });
  assert.equal(afterLogout.status, 401);
});

test('returns safe auth errors for duplicate registration and wrong password', async (context) => {
  const baseUrl = await startServer(context);
  const account = { firstName: 'A', lastName: 'B', email: 'user@example.com', password: 'password8' };
  const request = () => fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(account),
  });
  await request();
  const duplicate = await request();
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 'EMAIL_ALREADY_REGISTERED');

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: 'wrong-pass' }),
  });
  assert.equal(login.status, 401);
  assert.deepEqual(await login.json(), {
    code: 'INVALID_CREDENTIALS', message: '邮箱或密码错误', data: null,
  });
});

test('binds an iOS device to a user and sends a notification by user id', async (context) => {
  const authStore = createAuthStoreFixture();
  const deliveries = [];
  const pushClient = {
    transport: 'test',
    async sendNotification(token, payload, session) {
      deliveries.push({ token, payload, session });
      return { id: 'push-by-user-1' };
    },
  };
  const server = createApp({ pushClient, authStore }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firstName: 'Ali', lastName: 'Khan', email: 'device@example.com', password: 'password8',
    }),
  }).then((response) => response.json());
  const userToken = registration.data.accessToken;
  const userId = registration.data.user.id;
  const deviceResponse = await fetch(`${baseUrl}/api/auth/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${userToken}` },
    body: JSON.stringify({
      deviceId: 'installation-123', bundleId: 'com.example.app',
      pushToken: 'aabbccddeeff', deviceName: 'Ali iPhone',
      simulatorUdid: '6B82192D-60F1-4F8D-904A-3A30E36E8C7B',
    }),
  });
  assert.equal(deviceResponse.status, 201);

  const { key } = await fetch(`${baseUrl}/api/init`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bundleId: 'com.example.admin' }),
  }).then((response) => response.json());
  const pushResponse = await fetch(`${baseUrl}/api/push/notification`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      userId, alert: { title: 'Booking confirmed', body: 'Your flight is ready.' },
      data: { orderId: 'order-123' },
    }),
  });
  const pushResult = await pushResponse.json();

  assert.equal(pushResponse.status, 200);
  assert.equal(pushResult.delivered, 1);
  assert.equal(deliveries[0].token, 'aabbccddeeff');
  assert.equal(deliveries[0].session.bundleId, 'com.example.app');
  assert.equal(deliveries[0].session.userId, userId);
  assert.equal(deliveries[0].payload.orderId, 'order-123');

  const deviceList = await fetch(`${baseUrl}/api/admin/devices`, {
    headers: { authorization: `Bearer ${key}` },
  }).then((response) => response.json());
  assert.equal(deviceList.data.total, 1);
  assert.equal(deviceList.data.devices[0].maskedPushToken, 'aabb••••eeff');
  assert.equal(Object.hasOwn(deviceList.data.devices[0], 'pushToken'), false);

  const directPush = await fetch(`${baseUrl}/api/admin/devices/user/1/notification`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ alert: { title: 'Direct device message', body: 'Only this phone.' } }),
  });
  assert.equal(directPush.status, 200);
  assert.equal(deliveries[1].session.deviceId, 'installation-123');
  assert.equal(deliveries[1].session.simulatorUdid, '6B82192D-60F1-4F8D-904A-3A30E36E8C7B');
});

test('lists an Android device and routes its direct notification through ADB only', async (context) => {
  const androidDeliveries = [];
  const iosDeliveries = [];
  const server = createApp({
    authStore: createAuthStoreFixture(),
    pushClient: { transport: 'ios-simulator', sendNotification: (...args) => iosDeliveries.push(args) },
    androidClient: { async sendNotification(payload, target) {
      androidDeliveries.push({ payload, target });
      return { simulated: true, platform: 'android' };
    } },
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const init = await fetch(`${baseUrl}/api/init`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bundleId: 'com.example.tarco_aviation', device: {
      deviceId: 'installation-android', platform: 'android', deviceName: 'Pixel Emulator',
    } }),
  }).then((response) => response.json());
  const list = await fetch(`${baseUrl}/api/admin/devices`, {
    headers: { authorization: `Bearer ${init.key}` },
  }).then((response) => response.json());
  assert.equal(list.data.devices[0].platform, 'android');

  const response = await fetch(`${baseUrl}/api/admin/devices/guest/1/notification`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${init.key}` },
    body: JSON.stringify({ alert: { title: 'Android only', body: 'Hello' } }),
  });
  assert.equal(response.status, 200);
  assert.equal(androidDeliveries.length, 1);
  assert.equal(androidDeliveries[0].target.deviceId, 'installation-android');
  assert.equal(iosDeliveries.length, 0);
});

test('notifies a guest and transfers the guest device when the guest logs in', async (context) => {
  const authStore = createAuthStoreFixture();
  const deliveries = [];
  const pushClient = {
    transport: 'test',
    async sendNotification(_token, _payload, identity) {
      deliveries.push(identity);
      return { id: `push-${deliveries.length}` };
    },
  };
  const server = createApp({ pushClient, authStore }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const guest = await fetch(`${baseUrl}/api/auth/guest`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      deviceId: 'guest-installation', bundleId: 'com.example.app', pushToken: 'guest-apns-token',
    }),
  }).then((response) => response.json());
  const { key } = await fetch(`${baseUrl}/api/init`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bundleId: 'com.example.admin' }),
  }).then((response) => response.json());
  const adminHeaders = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
  const notification = { alert: { title: 'Order update' } };

  const guestPush = await fetch(`${baseUrl}/api/push/notification`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ guestId: guest.data.guestId, ...notification }),
  });
  assert.equal(guestPush.status, 200);
  assert.equal(deliveries[0].guestId, guest.data.guestId);

  await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firstName: 'Guest', lastName: 'Buyer', email: 'guest@example.com',
      password: 'password8', guestToken: guest.data.guestToken,
    }),
  });
  const userLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'guest@example.com', password: 'password8' }),
  }).then((response) => response.json());

  const oldGuestPush = await fetch(`${baseUrl}/api/push/notification`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ guestId: guest.data.guestId, ...notification }),
  });
  const userPush = await fetch(`${baseUrl}/api/push/notification`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ userId: userLogin.data.user.id, ...notification }),
  });
  assert.equal(oldGuestPush.status, 200);
  assert.equal(userPush.status, 200);
  assert.equal(deliveries[1].guestId, guest.data.guestId);
  assert.equal(deliveries[2].userId, userLogin.data.user.id);

  const mergedDevices = await fetch(`${baseUrl}/api/admin/devices`, {
    headers: { authorization: `Bearer ${key}` },
  }).then((response) => response.json());
  assert.equal(mergedDevices.data.users, 1);
  assert.equal(mergedDevices.data.guests, 1);
  assert.equal(mergedDevices.data.mergedGuests, 1);
});

test('initializes the app session and guest identity in one request', async (context) => {
  const baseUrl = await startServer(context);
  const body = {
    bundleId: 'com.example.app',
    device: { deviceId: 'installation-combined', pushToken: 'first-token', deviceName: 'iPhone' },
  };
  const firstResponse = await fetch(`${baseUrl}/api/init`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const first = await firstResponse.json();

  assert.equal(firstResponse.status, 201);
  assert.equal(typeof first.key, 'string');
  assert.equal(first.guest.guestId, '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(first.guest.device.bundleId, body.bundleId);

  const resumedResponse = await fetch(`${baseUrl}/api/init`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...body, guestToken: first.guest.guestToken,
      device: { ...body.device, pushToken: 'refreshed-token' },
    }),
  });
  const resumed = await resumedResponse.json();
  assert.equal(resumedResponse.status, 201);
  assert.equal(resumed.guest.guestId, first.guest.guestId);
  assert.equal(resumed.guest.device.pushToken, 'refreshed-token');
});

test('refreshes the access token and sliding expiry during app initialization', async (context) => {
  const baseUrl = await startServer(context);
  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firstName: 'Stay', lastName: 'Signed In', email: 'stay@example.com', password: 'password8',
    }),
  }).then((response) => response.json());

  const initialized = await fetch(`${baseUrl}/api/init`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      bundleId: 'com.example.app', userRefreshToken: registration.data.refreshToken,
    }),
  });
  const result = await initialized.json();

  assert.equal(initialized.status, 201);
  assert.equal(result.auth.user.email, 'stay@example.com');
  assert.equal(result.auth.accessToken, 'refreshed-access-1');
  assert.equal(result.auth.refreshToken, registration.data.refreshToken);

  const reused = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken: registration.data.refreshToken }),
  });
  assert.equal(reused.status, 200);
});
