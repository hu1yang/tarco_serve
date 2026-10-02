import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import { mysqlConfigFromEnv } from './flight-database.js';

const PASSWORD_ROUNDS = 12;
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const GUEST_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;
const DUMMY_PASSWORD_HASH = '$2b$12$QjUXKp05Kc4RwYiNJNFZPekW7SEToeUIlsru5p6dR2b7AkCAr2j8a';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    first_name VARCHAR(80) NOT NULL,
    last_name VARCHAR(80) NOT NULL,
    email VARCHAR(254) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_users_email (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS auth_sessions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    refresh_token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    refresh_expires_at DATETIME(3) NULL,
    last_used_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_auth_sessions_token_hash (token_hash),
    UNIQUE KEY uk_auth_sessions_refresh_token_hash (refresh_token_hash),
    INDEX idx_auth_sessions_user_expiry (user_id, expires_at),
    CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS guests (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
    merged_into_user_id BIGINT UNSIGNED NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    merged_at DATETIME(3) NULL,
    INDEX idx_guests_merged_user (merged_into_user_id),
    CONSTRAINT fk_guests_merged_user FOREIGN KEY (merged_into_user_id) REFERENCES users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS guest_sessions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    guest_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_guest_sessions_token_hash (token_hash),
    INDEX idx_guest_sessions_guest_expiry (guest_id, expires_at),
    CONSTRAINT fk_guest_sessions_guest FOREIGN KEY (guest_id) REFERENCES guests(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS user_devices (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    device_id VARCHAR(128) NOT NULL,
    platform ENUM('ios', 'android') NOT NULL DEFAULT 'ios',
    push_token VARCHAR(255) NULL,
    simulator_udid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    bundle_id VARCHAR(255) NOT NULL,
    device_name VARCHAR(100) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_user_devices_installation (device_id, bundle_id),
    INDEX idx_user_devices_user (user_id),
    CONSTRAINT fk_user_devices_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS guest_devices (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    guest_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    device_id VARCHAR(128) NOT NULL,
    platform ENUM('ios', 'android') NOT NULL DEFAULT 'ios',
    push_token VARCHAR(255) NULL,
    simulator_udid CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
    bundle_id VARCHAR(255) NOT NULL,
    device_name VARCHAR(100) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_guest_devices_installation (device_id, bundle_id),
    INDEX idx_guest_devices_guest (guest_id),
    CONSTRAINT fk_guest_devices_guest FOREIGN KEY (guest_id) REFERENCES guests(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

export class AuthError extends Error {
  constructor(message, { status = 400, code = 'AUTH_INVALID_REQUEST' } = {}) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

function requiredText(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AuthError(`${field} 不能为空`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new AuthError(`${field} 不能超过 ${maxLength} 个字符`);
  }
  return normalized;
}

function normalizeEmail(value) {
  const email = requiredText(value, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError('email 格式不正确');
  }
  return email;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) {
    throw new AuthError('password 长度必须为 8～128 个字符');
  }
  return value;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function validUserId(value) {
  const userId = String(value ?? '');
  if (!/^[1-9]\d*$/.test(userId)) {
    throw new AuthError('userId 格式无效');
  }
  return userId;
}

function validGuestId(value) {
  const guestId = String(value ?? '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(guestId)) {
    throw new AuthError('guestId 格式无效');
  }
  return guestId;
}

function deviceInput(input = {}) {
  const platform = input.platform ?? 'ios';
  if (!['ios', 'android'].includes(platform)) throw new AuthError('platform 格式无效');
  const deviceId = requiredText(input.deviceId, 'deviceId', 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(deviceId)) {
    throw new AuthError('deviceId 格式无效');
  }
  const bundleId = requiredText(input.bundleId, 'bundleId', 255);
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(bundleId)) {
    throw new AuthError('bundleId 格式无效，例如 com.example.myapp');
  }
  const pushToken = input.pushToken == null || input.pushToken === ''
    ? null : requiredText(input.pushToken, 'pushToken', 255);
  const deviceName = input.deviceName == null || input.deviceName === ''
    ? null : requiredText(input.deviceName, 'deviceName', 100);
  const simulatorUdid = input.simulatorUdid == null || input.simulatorUdid === ''
    ? null : requiredText(input.simulatorUdid, 'simulatorUdid', 36).toUpperCase();
  if (simulatorUdid && !/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(simulatorUdid)) {
    throw new AuthError('simulatorUdid 格式无效');
  }
  return { deviceId, platform, bundleId, pushToken, deviceName, simulatorUdid };
}

function publicUser(row) {
  return {
    id: String(row.id),
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    createdAt: row.created_at,
  };
}

export class AuthStore {
  constructor(config = mysqlConfigFromEnv()) {
    this.pool = mysql.createPool(config);
    this.initialization = null;
  }

  async initialize() {
    if (!this.initialization) this.initialization = this.#initialize();
    return this.initialization;
  }

  async #initialize() {
    for (const statement of SCHEMA) await this.pool.execute(statement);
    const [columns] = await this.pool.execute(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'auth_sessions'`);
    const names = new Set(columns.map((column) => column.COLUMN_NAME));
    if (!names.has('refresh_token_hash')) {
      await this.pool.execute(`ALTER TABLE auth_sessions ADD COLUMN refresh_token_hash
        CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER expires_at`);
    }
    if (!names.has('refresh_expires_at')) {
      await this.pool.execute(`ALTER TABLE auth_sessions ADD COLUMN refresh_expires_at
        DATETIME(3) NULL AFTER refresh_token_hash`);
    }
    if (!names.has('last_used_at')) {
      await this.pool.execute(`ALTER TABLE auth_sessions ADD COLUMN last_used_at
        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER refresh_expires_at`);
    }
    const [indexes] = await this.pool.execute(`SELECT index_name FROM information_schema.statistics
      WHERE table_schema = DATABASE() AND table_name = 'auth_sessions'
        AND index_name = 'uk_auth_sessions_refresh_token_hash'`);
    if (indexes.length === 0) {
      await this.pool.execute(`ALTER TABLE auth_sessions ADD UNIQUE KEY
        uk_auth_sessions_refresh_token_hash (refresh_token_hash)`);
    }
    for (const table of ['user_devices', 'guest_devices']) {
      const [deviceColumns] = await this.pool.execute(`SELECT column_name, column_type
        FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?`, [table]);
      const deviceColumnNames = new Set(deviceColumns.map((column) => column.COLUMN_NAME));
      if (!deviceColumnNames.has('simulator_udid')) {
        await this.pool.execute(`ALTER TABLE ${table} ADD COLUMN simulator_udid
          CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER push_token`);
      }
      if (!deviceColumns.find((column) => column.COLUMN_NAME === 'platform')?.COLUMN_TYPE.includes('android')) {
        await this.pool.execute(`ALTER TABLE ${table}
          MODIFY COLUMN platform ENUM('ios', 'android') NOT NULL DEFAULT 'ios'`);
      }
    }
  }

  async #createSession(connection, userId) {
    const accessToken = crypto.randomBytes(32).toString('base64url');
    const refreshToken = crypto.randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
    const refreshExpiresAt = new Date(Date.now() + REFRESH_LIFETIME_MS);
    await connection.execute(
      `INSERT INTO auth_sessions
        (user_id, token_hash, expires_at, refresh_token_hash, refresh_expires_at, last_used_at, created_at)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
      [
        userId,
        hashToken(accessToken),
        expiresAt.toISOString().slice(0, 23).replace('T', ' '),
        hashToken(refreshToken),
        refreshExpiresAt.toISOString().slice(0, 23).replace('T', ' '),
      ],
    );
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresAt: expiresAt.toISOString(),
      refreshExpiresAt: refreshExpiresAt.toISOString(),
    };
  }

  async #mergeGuest(connection, guestToken, userId) {
    if (guestToken === undefined || guestToken === null || guestToken === '') return false;
    if (typeof guestToken !== 'string') {
      throw new AuthError('guestToken 格式无效', { status: 401, code: 'INVALID_GUEST_SESSION' });
    }
    const [rows] = await connection.execute(`SELECT g.id, g.merged_into_user_id
      FROM guest_sessions s JOIN guests g ON g.id = s.guest_id
      WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3) LIMIT 1 FOR UPDATE`,
    [hashToken(guestToken)]);
    const guest = rows[0];
    if (!guest) {
      throw new AuthError('游客身份无效或已过期', { status: 401, code: 'INVALID_GUEST_SESSION' });
    }
    if (guest.merged_into_user_id !== null) {
      if (String(guest.merged_into_user_id) !== String(userId)) {
        throw new AuthError('该游客身份已经合并到其他用户', {
          status: 409, code: 'GUEST_ALREADY_MERGED',
        });
      }
      return true;
    }

    await connection.execute(`INSERT INTO user_devices
      (user_id, device_id, platform, push_token, simulator_udid, bundle_id, device_name, created_at, last_seen_at)
      SELECT ?, device_id, platform, push_token, simulator_udid, bundle_id, device_name, created_at, UTC_TIMESTAMP(3)
      FROM guest_devices WHERE guest_id = ?
      ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform), push_token = VALUES(push_token),
        simulator_udid = VALUES(simulator_udid), bundle_id = VALUES(bundle_id), device_name = VALUES(device_name),
        last_seen_at = UTC_TIMESTAMP(3)`, [userId, guest.id]);
    // Keep the guest registration as an identity-history record. The same
    // installation is also attached to the signed-in user above, but removing
    // this row made merged guests disappear from the admin device view.
    await connection.execute(`UPDATE guests SET merged_into_user_id = ?, merged_at = UTC_TIMESTAMP(3)
      WHERE id = ?`, [userId, guest.id]);
    return true;
  }

  async register(input = {}) {
    const firstName = requiredText(input.firstName, 'firstName', 80);
    const lastName = requiredText(input.lastName, 'lastName', 80);
    const email = normalizeEmail(input.email);
    const password = validatePassword(input.password);
    await this.initialize();

    const passwordHash = await bcrypt.hash(password, PASSWORD_ROUNDS);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(
        `INSERT INTO users (first_name, last_name, email, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))`,
        [firstName, lastName, email, passwordHash],
      );
      const guestMerged = await this.#mergeGuest(connection, input.guestToken, result.insertId);
      const session = await this.#createSession(connection, result.insertId);
      const [rows] = await connection.execute(`SELECT id, first_name, last_name, email,
        DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.000Z') AS created_at
        FROM users WHERE id = ?`, [result.insertId]);
      await connection.commit();
      return { user: publicUser(rows[0]), ...session, guestMerged };
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        throw new AuthError('该邮箱已注册', { status: 409, code: 'EMAIL_ALREADY_REGISTERED' });
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async login(input = {}) {
    const email = normalizeEmail(input.email);
    const password = validatePassword(input.password);
    await this.initialize();

    const [rows] = await this.pool.execute(`SELECT id, first_name, last_name, email, password_hash,
      DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.000Z') AS created_at
      FROM users WHERE email = ? LIMIT 1`, [email]);
    const row = rows[0];
    const passwordMatches = await bcrypt.compare(password, row?.password_hash || DUMMY_PASSWORD_HASH);
    if (!row || !passwordMatches) {
      throw new AuthError('邮箱或密码错误', { status: 401, code: 'INVALID_CREDENTIALS' });
    }

    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const guestMerged = await this.#mergeGuest(connection, input.guestToken, row.id);
      const session = await this.#createSession(connection, row.id);
      await connection.commit();
      return { user: publicUser(row), ...session, guestMerged };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async createGuest(input = {}) {
    const device = deviceInput(input);
    await this.initialize();
    const guestId = crypto.randomUUID();
    const guestToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + GUEST_LIFETIME_MS);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        'INSERT INTO guests (id, created_at) VALUES (?, UTC_TIMESTAMP(3))', [guestId],
      );
      await connection.execute(`INSERT INTO guest_sessions
        (guest_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, UTC_TIMESTAMP(3))`, [
        guestId, hashToken(guestToken), expiresAt.toISOString().slice(0, 23).replace('T', ' '),
      ]);
      await connection.execute(`INSERT INTO guest_devices
      (guest_id, device_id, platform, push_token, simulator_udid, bundle_id, device_name, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE guest_id = VALUES(guest_id), platform = VALUES(platform), push_token = VALUES(push_token),
          simulator_udid = VALUES(simulator_udid), bundle_id = VALUES(bundle_id), device_name = VALUES(device_name),
          last_seen_at = UTC_TIMESTAMP(3)`, [
        guestId, device.deviceId, device.platform, device.pushToken, device.simulatorUdid,
        device.bundleId, device.deviceName,
      ]);
      await connection.commit();
      return {
        guestId, guestToken, tokenType: 'Guest', expiresAt: expiresAt.toISOString(),
        device,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async resumeGuest(guestToken, input = {}) {
    if (typeof guestToken !== 'string' || !guestToken) {
      throw new AuthError('游客身份无效或已过期', { status: 401, code: 'INVALID_GUEST_SESSION' });
    }
    const device = deviceInput(input);
    await this.initialize();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(`SELECT g.id, g.merged_into_user_id,
        DATE_FORMAT(s.expires_at, '%Y-%m-%dT%H:%i:%s.000Z') AS expires_at
        FROM guest_sessions s JOIN guests g ON g.id = s.guest_id
        WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3) LIMIT 1 FOR UPDATE`,
      [hashToken(guestToken)]);
      const guest = rows[0];
      if (!guest) {
        throw new AuthError('游客身份无效或已过期', {
          status: 401, code: 'INVALID_GUEST_SESSION',
        });
      }

      if (guest.merged_into_user_id !== null) {
        await connection.execute(`INSERT INTO user_devices
          (user_id, device_id, platform, push_token, simulator_udid, bundle_id, device_name, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
          ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform), push_token = VALUES(push_token),
            simulator_udid = VALUES(simulator_udid), bundle_id = VALUES(bundle_id), device_name = VALUES(device_name),
            last_seen_at = UTC_TIMESTAMP(3)`, [
          guest.merged_into_user_id, device.deviceId, device.platform, device.pushToken, device.simulatorUdid,
          device.bundleId, device.deviceName,
        ]);
      } else {
        await connection.execute(`INSERT INTO guest_devices
          (guest_id, device_id, platform, push_token, simulator_udid, bundle_id, device_name, created_at, last_seen_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
          ON DUPLICATE KEY UPDATE guest_id = VALUES(guest_id), platform = VALUES(platform), push_token = VALUES(push_token),
            simulator_udid = VALUES(simulator_udid), bundle_id = VALUES(bundle_id), device_name = VALUES(device_name),
            last_seen_at = UTC_TIMESTAMP(3)`, [
          guest.id, device.deviceId, device.platform, device.pushToken, device.simulatorUdid,
          device.bundleId, device.deviceName,
        ]);
      }
      await connection.commit();
      return {
        guestId: guest.id,
        guestToken,
        tokenType: 'Guest',
        expiresAt: guest.expires_at,
        mergedIntoUserId: guest.merged_into_user_id === null
          ? null : String(guest.merged_into_user_id),
        device,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async identityForGuestToken(guestToken) {
    if (typeof guestToken !== 'string' || !guestToken) {
      throw new AuthError('游客身份无效或已过期', {
        status: 401, code: 'INVALID_GUEST_SESSION',
      });
    }
    await this.initialize();
    const [rows] = await this.pool.execute(`SELECT g.id AS guest_id, g.merged_into_user_id
      FROM guest_sessions s JOIN guests g ON g.id = s.guest_id
      WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3) LIMIT 1`,
    [hashToken(guestToken)]);
    const row = rows[0];
    if (!row) {
      throw new AuthError('游客身份无效或已过期', {
        status: 401, code: 'INVALID_GUEST_SESSION',
      });
    }
    return row.merged_into_user_id === null
      ? { type: 'guest', id: row.guest_id }
      : { type: 'user', id: String(row.merged_into_user_id) };
  }

  async authenticate(accessToken) {
    if (typeof accessToken !== 'string' || !accessToken) {
      throw new AuthError('请提供 Bearer Token', { status: 401, code: 'UNAUTHORIZED' });
    }
    await this.initialize();
    const [rows] = await this.pool.execute(`SELECT u.id, u.first_name, u.last_name, u.email,
      DATE_FORMAT(u.created_at, '%Y-%m-%dT%H:%i:%s.000Z') AS created_at
      FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3) LIMIT 1`, [hashToken(accessToken)]);
    if (!rows[0]) {
      throw new AuthError('登录状态无效或已过期', { status: 401, code: 'UNAUTHORIZED' });
    }
    return publicUser(rows[0]);
  }

  async refresh(refreshToken) {
    if (typeof refreshToken !== 'string' || !refreshToken) {
      throw new AuthError('请提供 refreshToken', { status: 401, code: 'INVALID_REFRESH_TOKEN' });
    }
    await this.initialize();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute(`SELECT s.id, u.id AS user_id, u.first_name,
        u.last_name, u.email, DATE_FORMAT(u.created_at, '%Y-%m-%dT%H:%i:%s.000Z') AS created_at
        FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.refresh_token_hash = ? AND s.refresh_expires_at > UTC_TIMESTAMP(3)
        LIMIT 1 FOR UPDATE`, [hashToken(refreshToken)]);
      const row = rows[0];
      if (!row) {
        throw new AuthError('登录已过期，请重新登录', {
          status: 401, code: 'INVALID_REFRESH_TOKEN',
        });
      }

      const nextAccessToken = crypto.randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
      const refreshExpiresAt = new Date(Date.now() + REFRESH_LIFETIME_MS);
      await connection.execute(`UPDATE auth_sessions SET token_hash = ?, expires_at = ?,
        refresh_expires_at = ?, last_used_at = UTC_TIMESTAMP(3)
        WHERE id = ?`, [
        hashToken(nextAccessToken), expiresAt.toISOString().slice(0, 23).replace('T', ' '),
        refreshExpiresAt.toISOString().slice(0, 23).replace('T', ' '), row.id,
      ]);
      await connection.commit();
      return {
        user: publicUser({ ...row, id: row.user_id }),
        accessToken: nextAccessToken,
        refreshToken,
        tokenType: 'Bearer',
        expiresAt: expiresAt.toISOString(),
        refreshExpiresAt: refreshExpiresAt.toISOString(),
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async logout(accessToken, refreshToken) {
    if (typeof accessToken === 'string' && accessToken) {
      await this.initialize();
      await this.pool.execute(`DELETE FROM auth_sessions WHERE token_hash = ?
        OR (? IS NOT NULL AND refresh_token_hash = ?)`, [
        hashToken(accessToken),
        typeof refreshToken === 'string' && refreshToken ? hashToken(refreshToken) : null,
        typeof refreshToken === 'string' && refreshToken ? hashToken(refreshToken) : null,
      ]);
    }
  }

  async registerDevice(accessToken, input = {}) {
    const user = await this.authenticate(accessToken);
    const device = deviceInput(input);
    await this.pool.execute(`INSERT INTO user_devices
      (user_id, device_id, platform, push_token, simulator_udid, bundle_id, device_name, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), platform = VALUES(platform), push_token = VALUES(push_token),
        simulator_udid = VALUES(simulator_udid), bundle_id = VALUES(bundle_id), device_name = VALUES(device_name),
        last_seen_at = UTC_TIMESTAMP(3)`,
    [user.id, device.deviceId, device.platform, device.pushToken, device.simulatorUdid,
      device.bundleId, device.deviceName]);
    return device;
  }

  async devicesForToken(accessToken) {
    const user = await this.authenticate(accessToken);
    return this.devicesForUser(user.id);
  }

  async devicesForUser(userId) {
    await this.initialize();
    const [rows] = await this.pool.execute(`SELECT device_id, platform, push_token, simulator_udid, bundle_id,
      device_name, DATE_FORMAT(last_seen_at, '%Y-%m-%dT%H:%i:%s.000Z') AS last_seen_at
      FROM user_devices WHERE user_id = ? ORDER BY last_seen_at DESC`, [validUserId(userId)]);
    return rows.map((row) => ({
      deviceId: row.device_id,
      platform: row.platform,
      pushToken: row.push_token,
      simulatorUdid: row.simulator_udid,
      bundleId: row.bundle_id,
      deviceName: row.device_name,
      lastSeenAt: row.last_seen_at,
    }));
  }

  async devicesForGuest(guestId) {
    await this.initialize();
    const normalizedGuestId = validGuestId(guestId);
    const [guests] = await this.pool.execute(
      'SELECT merged_into_user_id FROM guests WHERE id = ? LIMIT 1', [normalizedGuestId],
    );
    if (!guests[0]) return [];
    if (guests[0].merged_into_user_id !== null) {
      return this.devicesForUser(guests[0].merged_into_user_id);
    }
    const [rows] = await this.pool.execute(`SELECT device_id, platform, push_token, simulator_udid, bundle_id,
      device_name, DATE_FORMAT(last_seen_at, '%Y-%m-%dT%H:%i:%s.000Z') AS last_seen_at
      FROM guest_devices WHERE guest_id = ? ORDER BY last_seen_at DESC`, [normalizedGuestId]);
    return rows.map((row) => ({
      deviceId: row.device_id,
      platform: row.platform,
      pushToken: row.push_token,
      simulatorUdid: row.simulator_udid,
      bundleId: row.bundle_id,
      deviceName: row.device_name,
      lastSeenAt: row.last_seen_at,
    }));
  }

  async adminDevices() {
    await this.initialize();
    const [rows] = await this.pool.execute(`SELECT * FROM (
      SELECT 'user' AS identity_type, d.id AS record_id, CAST(d.user_id AS CHAR) AS owner_id,
        CONCAT(u.first_name, ' ', u.last_name) AS owner_name, u.email AS owner_email,
        d.device_id, d.platform, d.push_token, d.simulator_udid, d.bundle_id, d.device_name,
        DATE_FORMAT(d.last_seen_at, '%Y-%m-%dT%H:%i:%s.000Z') AS last_seen_at,
        NULL AS merged_into_user_id
      FROM user_devices d JOIN users u ON u.id = d.user_id
      UNION ALL
      SELECT 'guest' AS identity_type, d.id AS record_id, d.guest_id AS owner_id,
        CASE WHEN g.merged_into_user_id IS NULL THEN '游客'
          ELSE CONCAT('游客（已合并至用户 ', g.merged_into_user_id, '）') END AS owner_name,
        NULL AS owner_email, d.device_id, d.platform, d.push_token, d.simulator_udid,
        d.bundle_id, d.device_name,
        DATE_FORMAT(d.last_seen_at, '%Y-%m-%dT%H:%i:%s.000Z') AS last_seen_at,
        CAST(g.merged_into_user_id AS CHAR) AS merged_into_user_id
      FROM guest_devices d JOIN guests g ON g.id = d.guest_id
    ) devices ORDER BY last_seen_at DESC`);
    return rows.map((row) => ({
      identityType: row.identity_type,
      recordId: String(row.record_id),
      ownerId: String(row.owner_id),
      ownerName: row.owner_name,
      ownerEmail: row.owner_email,
      mergedIntoUserId: row.merged_into_user_id === null
        || row.merged_into_user_id === undefined ? null : String(row.merged_into_user_id),
      deviceId: row.device_id,
      platform: row.platform,
      hasPushToken: Boolean(row.push_token),
      simulatorUdid: row.simulator_udid,
      maskedPushToken: row.push_token
        ? `${row.push_token.slice(0, 4)}••••${row.push_token.slice(-4)}` : null,
      bundleId: row.bundle_id,
      deviceName: row.device_name,
      lastSeenAt: row.last_seen_at,
    }));
  }

  async adminDevice(identityType, recordId) {
    if (!['user', 'guest'].includes(identityType)) throw new AuthError('设备身份类型无效');
    const normalizedRecordId = validUserId(recordId);
    await this.initialize();
    const table = identityType === 'user' ? 'user_devices' : 'guest_devices';
    const ownerColumn = identityType === 'user' ? 'user_id' : 'guest_id';
    const [rows] = await this.pool.execute(`SELECT id, ${ownerColumn} AS owner_id, device_id,
      platform, push_token, simulator_udid, bundle_id, device_name FROM ${table} WHERE id = ? LIMIT 1`, [normalizedRecordId]);
    const row = rows[0];
    if (!row) throw new AuthError('设备不存在', { status: 404, code: 'DEVICE_NOT_FOUND' });
    return {
      identityType,
      recordId: String(row.id),
      ownerId: String(row.owner_id),
      deviceId: row.device_id,
      platform: row.platform,
      pushToken: row.push_token,
      simulatorUdid: row.simulator_udid,
      bundleId: row.bundle_id,
      deviceName: row.device_name,
    };
  }

  async removeDevice(accessToken, deviceId) {
    const user = await this.authenticate(accessToken);
    const normalizedDeviceId = requiredText(deviceId, 'deviceId', 128);
    const [result] = await this.pool.execute(
      'DELETE FROM user_devices WHERE user_id = ? AND device_id = ?',
      [user.id, normalizedDeviceId],
    );
    return result.affectedRows > 0;
  }

  async close() { await this.pool.end(); }
}

let defaultStore;
export function getDefaultAuthStore() {
  defaultStore ??= new AuthStore();
  return defaultStore;
}
