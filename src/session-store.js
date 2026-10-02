import crypto from 'node:crypto';

const BUNDLE_ID_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/;

export class SessionStore {
  constructor({ ttlMs = 24 * 60 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  create(bundleId) {
    if (!BUNDLE_ID_PATTERN.test(bundleId || '')) {
      throw new Error('bundleId 格式无效，例如 com.example.myapp');
    }
    const key = crypto.randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + this.ttlMs;
    this.sessions.set(key, { bundleId, expiresAt });
    return { key, bundleId, expiresAt };
  }

  get(key) {
    const session = this.sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }
}
