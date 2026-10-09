import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApnsError } from './apns-client.js';
import { AndroidSimulatorClient } from './android-simulator-client.js';
import {
  searchFlights,
  searchLowestFares,
  searchLowestFaresByMonths,
} from './flights.js';
import { androidLiveUpdatePayload, liveActivityPayload, notificationPayload } from './payloads.js';
import { LiveActivityHub } from './live-activity-hub.js';
import { mockOrder } from './orders.js';
import { NetworkSimulator } from './network-simulator.js';
import { SessionStore } from './session-store.js';
import { getDefaultFlightStore } from './flight-database.js';
import { AuthError, getDefaultAuthStore } from './auth-store.js';
import { BookingStore, getDefaultBookingStore } from './booking-store.js';
import { getDefaultCityImageStore, normalizeAirportCode } from './city-image-store.js';

export function createApp({
  pushClient,
  androidClient = new AndroidSimulatorClient(),
  sessions = new SessionStore(),
  liveActivityHub = new LiveActivityHub(),
  networkSimulator = new NetworkSimulator(),
  flightStore,
  authStore,
  bookingStore,
  cityImageStore,
  now = () => new Date(),
}) {
  const app = express();
  const publicDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data: http: https:; connect-src 'self'",
    });
    next();
  });
  app.use((request, response, next) => {
    const origin = request.get('origin');
    const configuredOrigins = (process.env.CORS_ALLOWED_ORIGINS || '')
      .split(',').map((item) => item.trim()).filter(Boolean);
    // Localhost is convenient for development; production origins must be
    // explicitly listed in CORS_ALLOWED_ORIGINS (use https origins).
    if (origin && (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      || configuredOrigins.includes(origin))) {
      response.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Accept, Authorization, Content-Type, X-Request-Id',
        Vary: 'Origin',
      });
    }
    if (request.method === 'OPTIONS') return response.sendStatus(204);
    return next();
  });
  app.get('/', (_request, response) => response.redirect('/admin/'));
  app.use(express.static(publicDirectory));
  app.use(express.json({ limit: '64kb' }));

  app.get('/health', (_request, response) => response.json({
    ok: true,
    transport: pushClient.transport,
  }));

  const accounts = authStore || getDefaultAuthStore();
  const bookings = bookingStore
    || (flightStore ? new BookingStore({ flightStore, now }) : getDefaultBookingStore());
  const cityImages = cityImageStore || getDefaultCityImageStore();

  app.post('/api/init', async (request, response, next) => {
    try {
      const { bundleId, device, deviceId, platform, guestToken, userRefreshToken } = request.body;
      let guest;
      let auth;
      const deviceDetails = device ?? (deviceId !== undefined ? { deviceId } : undefined);
      if (deviceDetails !== undefined) {
        if (!deviceDetails || typeof deviceDetails !== 'object' || Array.isArray(deviceDetails)) {
          throw new AuthError('device 必须是对象');
        }
        const deviceInput = { ...deviceDetails, ...(platform ? { platform } : {}), bundleId };
        guest = guestToken
          ? await accounts.resumeGuest(guestToken, deviceInput)
          : await accounts.createGuest(deviceInput);
      }
      if (userRefreshToken !== undefined) auth = await accounts.refresh(userRefreshToken);
      const session = sessions.create(bundleId);
      response.status(201).json({
        key: session.key,
        tokenType: 'Bearer',
        expiresAt: new Date(session.expiresAt).toISOString(),
        transport: pushClient.transport,
        ...(guest ? { guest } : {}),
        ...(auth ? { auth } : {}),
      });
    } catch (error) { next(error); }
  });

  const bearerToken = (request) => request.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];

  app.post('/api/auth/guest', async (request, response, next) => {
    try {
      const result = await accounts.createGuest(request.body);
      response.status(201).json({ code: 201, message: '游客身份创建成功', data: result });
    } catch (error) { next(error); }
  });

  app.post('/api/auth/register', async (request, response, next) => {
    try {
      const result = await accounts.register(request.body);
      response.status(201).json({ code: 201, message: '注册成功', data: result });
    } catch (error) { next(error); }
  });

  app.post('/api/auth/login', async (request, response, next) => {
    try {
      const result = await accounts.login(request.body);
      response.json({ code: 200, message: '登录成功', data: result });
    } catch (error) { next(error); }
  });

  app.post('/api/auth/refresh', async (request, response, next) => {
    try {
      const result = await accounts.refresh(request.body.refreshToken);
      response.json({ code: 200, message: '登录状态已刷新', data: result });
    } catch (error) { next(error); }
  });

  app.get('/api/auth/me', async (request, response, next) => {
    try {
      const user = await accounts.authenticate(bearerToken(request));
      response.json({ code: 200, message: 'success', data: { user } });
    } catch (error) { next(error); }
  });

  app.post('/api/auth/logout', async (request, response, next) => {
    try {
      const token = bearerToken(request);
      await accounts.authenticate(token);
      await accounts.logout(token, request.body?.refreshToken);
      response.json({ code: 200, message: '退出登录成功', data: null });
    } catch (error) { next(error); }
  });

  app.post('/api/auth/devices', async (request, response, next) => {
    try {
      const device = await accounts.registerDevice(bearerToken(request), request.body);
      response.status(201).json({ code: 201, message: '设备绑定成功', data: { device } });
    } catch (error) { next(error); }
  });

  app.get('/api/auth/devices', async (request, response, next) => {
    try {
      const devices = await accounts.devicesForToken(bearerToken(request));
      response.json({ code: 200, message: 'success', data: { devices } });
    } catch (error) { next(error); }
  });

  app.delete('/api/auth/devices/:deviceId', async (request, response, next) => {
    try {
      const removed = await accounts.removeDevice(bearerToken(request), request.params.deviceId);
      response.json({ code: 200, message: removed ? '设备解绑成功' : '设备不存在', data: null });
    } catch (error) { next(error); }
  });

  const bookingIdentity = async (request) => {
    const token = bearerToken(request);
    if (token) {
      const user = await accounts.authenticate(token);
      return { type: 'user', id: String(user.id) };
    }
    return accounts.identityForGuestToken(request.body?.guestToken);
  };

  app.post('/api/bookings/drafts', async (request, response, next) => {
    try {
      const identity = await bookingIdentity(request);
      const draft = await bookings.createDraft(request.body, identity);
      response.status(201).json({ code: 201, message: '预订草稿已创建', data: draft });
    } catch (error) { next(error); }
  });

  app.put('/api/bookings/drafts/:draftId/passengers', async (request, response, next) => {
    try {
      const identity = await bookingIdentity(request);
      const draft = await bookings.updatePassengers(request.params.draftId, request.body, identity);
      response.json({ code: 200, message: '乘客信息已更新', data: draft });
    } catch (error) { next(error); }
  });

  app.get('/api/network-simulator', (_request, response) => {
    response.json({ ...networkSimulator.getState(), logs: networkSimulator.logs });
  });

  app.put('/api/network-simulator', (request, response, next) => {
    try {
      response.json(networkSimulator.configure(request.body));
    } catch (error) { next(error); }
  });

  app.delete('/api/network-simulator/logs', (_request, response) => {
    response.json({ ok: true, stats: networkSimulator.clearLogs() });
  });

  app.post(
    '/api/network-simulator/probe',
    networkSimulator.middleware(),
    (request, response) => response.json({
      ok: true,
      message: '探针请求成功',
      requestId: request.get('x-request-id') || null,
      receivedAt: new Date().toISOString(),
    }),
  );

  app.use('/api', (request, response, next) => {
    const key = request.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    const session = sessions.get(key);
    if (!session) {
      return response.status(401).json({ error: 'key 无效或已过期，请重新调用 /api/init' });
    }
    response.locals.session = session;
    response.locals.sessionKey = key;
    return next();
  });

  app.use('/api', networkSimulator.middleware());

  app.get('/api/city-image', async (request, response, next) => {
    try {
      const arrAirport = normalizeAirportCode(request.query.arrAirport);
      const cityImage = await cityImages.get(arrAirport);
      if (!cityImage) {
        return response.status(404).json({
          code: 404,
          message: `未找到 ${arrAirport} 对应的城市图片`,
          data: null,
        });
      }
      return response.json({ code: 200, message: 'success', data: cityImage });
    } catch (error) { return next(error); }
  });

  app.get('/api/admin/city-images', async (_request, response, next) => {
    try {
      const items = await cityImages.list();
      response.json({ code: 200, message: 'success', data: { total: items.length, items } });
    } catch (error) { next(error); }
  });

  app.post('/api/admin/city-images', async (request, response, next) => {
    try {
      const cityImage = await cityImages.upsert(request.body);
      response.status(201).json({ code: 201, message: '城市图片已保存', data: cityImage });
    } catch (error) { next(error); }
  });

  app.put('/api/admin/city-images/:arrAirport', async (request, response, next) => {
    try {
      const cityImage = await cityImages.upsert(request.body, request.params.arrAirport);
      response.json({ code: 200, message: '城市图片已更新', data: cityImage });
    } catch (error) { next(error); }
  });

  app.delete('/api/admin/city-images/:arrAirport', async (request, response, next) => {
    try {
      const arrAirport = normalizeAirportCode(request.params.arrAirport);
      const removed = await cityImages.delete(arrAirport);
      response.status(removed ? 200 : 404).json({
        code: removed ? 200 : 404,
        message: removed ? '城市图片已删除' : '城市图片不存在',
        data: null,
      });
    } catch (error) { next(error); }
  });

  app.post('/api/push/notification', async (request, response, next) => {
    try {
      const { deviceToken, userId, guestId, ...input } = request.body;
      if (userId !== undefined && guestId !== undefined) {
        throw new AuthError('userId 和 guestId 只能提供一个');
      }
      if (userId !== undefined || guestId !== undefined) {
        const targetType = userId !== undefined ? 'user' : 'guest';
        const targetId = userId ?? guestId;
        const devices = targetType === 'user'
          ? await accounts.devicesForUser(targetId)
          : await accounts.devicesForGuest(targetId);
        if (devices.length === 0) {
          throw new AuthError('该身份没有已绑定的设备', {
            status: 404, code: 'IDENTITY_HAS_NO_DEVICES',
          });
        }
        const payload = notificationPayload(input);
        const deliveries = await Promise.allSettled(devices.map((device) => {
          const context = {
            bundleId: device.bundleId,
            ...(targetType === 'user' ? { userId: String(targetId) } : { guestId: String(targetId) }),
            deviceId: device.deviceId,
            simulatorUdid: device.simulatorUdid,
          };
          return device.platform === 'android'
            ? androidClient.sendNotification(payload, context)
            : pushClient.sendNotification(device.pushToken, payload, context);
        }));
        const results = deliveries.map((delivery, index) => ({
          deviceId: devices[index].deviceId,
          ok: delivery.status === 'fulfilled',
          ...(delivery.status === 'fulfilled'
            ? { result: delivery.value }
            : { error: delivery.reason?.message || '发送失败' }),
        }));
        const delivered = results.filter((result) => result.ok).length;
        return response.json({
          ok: delivered === devices.length,
          [targetType === 'user' ? 'userId' : 'guestId']: String(targetId),
          attempted: devices.length,
          delivered,
          failed: devices.length - delivered,
          results,
        });
      }
      const result = await pushClient.sendNotification(
        deviceToken,
        notificationPayload(input),
        response.locals.session,
      );
      response.json({ ok: true, ...result });
    } catch (error) { next(error); }
  });

  app.get('/api/orders/:orderId', (request, response, next) => {
    try {
      console.log(JSON.stringify(mockOrder(request.params.orderId)));
      response.json(mockOrder(request.params.orderId));
    } catch (error) { next(error); }
  });

  app.get('/api/flights/search', async (request, response) => {
    try {
      const data = await searchFlights(request.query, { store: flightStore });
      const responseDelayMs = 500 + Math.floor(Math.random() * 701);
      await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
      response.json({
        code: 200,
        message: 'success',
        data,
      });
    } catch (error) {
      response.status(400).json({
        code: 400,
        message: error.message,
        data: null,
      });
    }
  });

  app.post('/api/flights/offers/revalidate', async (request, response, next) => {
    try {
      const data = await bookings.revalidateOffer(request.body);
      response.json({ code: 200, message: '报价验证成功', data });
    } catch (error) { next(error); }
  });

  app.post('/api/flights/lowest-fares', async (request, response) => {
    try {
      const data = await searchLowestFares(request.body, { now: now(), store: flightStore });
      const responseDelayMs = 500 + Math.floor(Math.random() * 701);
      await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
      response.json({
        code: 200,
        message: 'success',
        data,
      });
    } catch (error) {
      response.status(400).json({
        code: 400,
        message: error.message,
        data: null,
      });
    }
  });

  app.post('/api/flights/lowest-fares-by-months', async (request, response) => {
    try {
      console.log(request.body);
      const data = await searchLowestFaresByMonths(request.body, { now: now(), store: flightStore });
      const responseDelayMs = 500 + Math.floor(Math.random() * 701);
      await new Promise((resolve) => setTimeout(resolve, responseDelayMs));
      response.json({
        code: 200,
        message: 'success',
        data,
      });
    } catch (error) {
      response.status(400).json({
        code: 400,
        message: error.message,
        data: null,
      });
    }
  });

  app.get('/api/admin/flights', async (request, response, next) => {
    try {
      const startDate = /^\d{4}-\d{2}-\d{2}$/.test(request.query.startDate || '')
        ? request.query.startDate : now().toISOString().slice(0, 10);
      const defaultEnd = new Date(`${startDate}T00:00:00.000Z`);
      defaultEnd.setUTCDate(defaultEnd.getUTCDate() + 60);
      const endDate = /^\d{4}-\d{2}-\d{2}$/.test(request.query.endDate || '')
        ? request.query.endDate : defaultEnd.toISOString().slice(0, 10);
      if (endDate < startDate) throw new Error('endDate 不能早于 startDate');
      const store = flightStore || getDefaultFlightStore();
      const flights = await store.inventory(startDate, endDate);
      response.json({
        database: 'MySQL', route: 'MCT → DOH', operatingWeekdays: ['周一', '周三', '周六'],
        startDate, endDate, flightCount: flights.length,
        operatingDateCount: new Set(flights.map((flight) => flight.departure_date)).size,
        availableSeats: flights.reduce((sum, flight) => sum + flight.seats_left, 0),
        flights,
      });
    } catch (error) { next(error); }
  });

  app.get('/api/admin/devices', async (_request, response, next) => {
    try {
      const devices = await accounts.adminDevices();
      response.json({
        code: 200,
        message: 'success',
        data: {
          total: devices.length,
          users: devices.filter((device) => device.identityType === 'user').length,
          guests: devices.filter((device) => device.identityType === 'guest').length,
          mergedGuests: devices.filter((device) => device.identityType === 'guest'
            && device.mergedIntoUserId !== null).length,
          pushReady: devices.filter((device) => device.hasPushToken).length,
          devices,
        },
      });
    } catch (error) { next(error); }
  });

  app.post('/api/admin/devices/:identityType/:recordId/notification', async (request, response, next) => {
    try {
      const device = await accounts.adminDevice(
        request.params.identityType,
        request.params.recordId,
      );
      if (device.platform !== 'android' && !device.pushToken && pushClient.transport !== 'ios-simulator') {
        throw new AuthError('该设备没有 Push Token', {
          status: 409, code: 'DEVICE_HAS_NO_PUSH_TOKEN',
        });
      }
      const context = {
          ...response.locals.session,
          bundleId: device.bundleId,
          deviceId: device.deviceId,
          simulatorUdid: device.simulatorUdid,
          [device.identityType === 'user' ? 'userId' : 'guestId']: device.ownerId,
        };
      const payload = notificationPayload(request.body);
      const result = device.platform === 'android'
        ? await androidClient.sendNotification(payload, context)
        : await pushClient.sendNotification(device.pushToken, payload, context);
      response.json({ ok: true, device: { ...device, pushToken: undefined }, result });
    } catch (error) { next(error); }
  });

  app.post('/api/admin/devices/:identityType/:recordId/live-update', async (request, response, next) => {
    try {
      const device = await accounts.adminDevice(
        request.params.identityType,
        request.params.recordId,
      );
      if (device.platform !== 'android') {
        throw new AuthError('实时通知测试仅支持 Android 模拟器设备', {
          status: 409, code: 'NOT_ANDROID_DEVICE',
        });
      }
      const result = await androidClient.sendLiveUpdate(
        androidLiveUpdatePayload(request.body),
        { bundleId: device.bundleId, deviceId: device.deviceId },
      );
      response.json({ ok: true, deviceId: device.deviceId, result });
    } catch (error) { next(error); }
  });

  app.get('/api/live-activity/stream', (_request, response) => {
    liveActivityHub.subscribe(response.locals.session.bundleId, response);
  });

  app.get('/api/live-activity/state', (_request, response) => {
    const bundleId = response.locals.session.bundleId;
    response.json({
      ok: true,
      state: liveActivityHub.getLatest(bundleId),
      subscribers: liveActivityHub.subscriberCount(bundleId),
    });
  });

  app.post('/api/live-activity/state', (request, response, next) => {
    try {
      const bundleId = response.locals.session.bundleId;
      const result = liveActivityHub.publish(bundleId, request.body);
      response.status(202).json({ ok: true, ...result });
    } catch (error) { next(error); }
  });

  for (const event of ['start', 'update', 'end']) {
    app.post(`/api/live-activity/${event}`, async (request, response, next) => {
      try {
        const { pushToken, ...input } = request.body;
        const result = await pushClient.sendLiveActivity(
          pushToken,
          liveActivityPayload({ ...input, event }),
          response.locals.session,
        );
        response.json({ ok: true, ...result });
      } catch (error) { next(error); }
    });
  }

  app.use((error, _request, response, _next) => {
    const status = error instanceof ApnsError ? 502 : error instanceof AuthError ? error.status : 400;
    if (!(error instanceof AuthError)) console.error(error);
    response.status(status).json({
      ...(error instanceof AuthError ? {
        code: error.code,
        message: error.message,
        data: null,
      } : { error: error.message }),
      ...(error instanceof ApnsError ? {
        apnsStatus: error.status,
        apnsReason: error.reason,
        apnsId: error.apnsId,
      } : {}),
    });
  });

  return app;
}
