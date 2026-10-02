import crypto from 'node:crypto';
import http2 from 'node:http2';

const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';
const PRODUCTION_HOST = 'https://api.push.apple.com';

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export class ApnsError extends Error {
  constructor(status, reason, apnsId) {
    super(`APNs 请求失败 (${status}): ${reason || 'Unknown error'}`);
    this.name = 'ApnsError';
    this.status = status;
    this.reason = reason;
    this.apnsId = apnsId;
  }
}

export class ApnsClient {
  constructor(config) {
    this.config = config;
    this.cachedJwt = null;
    this.transport = 'apns';
  }

  jwt() {
    const now = Math.floor(Date.now() / 1000);
    if (this.cachedJwt && now - this.cachedJwt.issuedAt < 50 * 60) return this.cachedJwt.value;

    const header = base64url(JSON.stringify({ alg: 'ES256', kid: this.config.keyId }));
    const claims = base64url(JSON.stringify({ iss: this.config.teamId, iat: now }));
    const unsigned = `${header}.${claims}`;
    const signature = crypto.sign('sha256', Buffer.from(unsigned), {
      key: this.config.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');

    this.cachedJwt = { issuedAt: now, value: `${unsigned}.${signature}` };
    return this.cachedJwt.value;
  }

  async send({ token, payload, pushType, topic, priority = 10, expiration = 0 }) {
    if (!/^[a-fA-F0-9]{32,}$/.test(token || '')) throw new Error('无效的 APNs token');
    const host = this.config.useSandbox ? SANDBOX_HOST : PRODUCTION_HOST;

    return new Promise((resolve, reject) => {
      const client = http2.connect(host);
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        client.close();
        callback(value);
      };

      client.once('error', (error) => finish(reject, error));
      const request = client.request({
        ':method': 'POST',
        ':path': `/3/device/${token}`,
        authorization: `bearer ${this.jwt()}`,
        'apns-push-type': pushType,
        'apns-topic': topic,
        'apns-priority': String(priority),
        'apns-expiration': String(expiration),
      });

      let status = 0;
      let apnsId;
      let responseBody = '';
      request.setEncoding('utf8');
      request.on('response', (headers) => {
        status = Number(headers[':status']);
        apnsId = headers['apns-id'];
      });
      request.on('data', (chunk) => { responseBody += chunk; });
      request.on('end', () => {
        if (status === 200) return finish(resolve, { apnsId });
        let reason;
        try { reason = JSON.parse(responseBody).reason; } catch { reason = responseBody; }
        return finish(reject, new ApnsError(status, reason, apnsId));
      });
      request.on('error', (error) => finish(reject, error));
      request.end(JSON.stringify(payload));
    });
  }

  sendNotification(token, payload, _context = {}) {
    return this.send({
      token,
      payload,
      pushType: 'alert',
      topic: this.config.bundleId,
    });
  }

  sendLiveActivity(token, payload, _context = {}) {
    return this.send({
      token,
      payload,
      pushType: 'liveactivity',
      topic: `${this.config.bundleId}.push-type.liveactivity`,
    });
  }
}
