import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { AuthError } from './auth-store.js';
import { getDefaultFlightStore, mysqlConfigFromEnv } from './flight-database.js';

const QUOTE_LIFETIME_MS = 15 * 60 * 1000;
const DRAFT_LIFETIME_MS = 30 * 60 * 1000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS booking_quotes (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    inventory_id VARCHAR(80) NOT NULL, fare_code VARCHAR(40) NOT NULL,
    passenger_count SMALLINT UNSIGNED NOT NULL, currency CHAR(3) NOT NULL,
    total DECIMAL(12,2) NOT NULL, snapshot_json JSON NOT NULL,
    expires_at DATETIME(3) NOT NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_booking_quotes_expiry (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS booking_drafts (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    quote_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    owner_type ENUM('user', 'guest') NOT NULL, owner_id VARCHAR(64) NOT NULL,
    contact_json JSON NOT NULL, passengers_json JSON NOT NULL, preferences_json JSON NOT NULL,
    status VARCHAR(40) NOT NULL, expires_at DATETIME(3) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_booking_drafts_owner (owner_type, owner_id),
    INDEX idx_booking_drafts_expiry (expires_at),
    CONSTRAINT fk_booking_draft_quote FOREIGN KEY (quote_id) REFERENCES booking_quotes(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

function requiredText(value, field, maxLength = 255) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AuthError(`${field} 不能为空`, { code: 'BOOKING_INVALID_REQUEST' });
  }
  const text = value.trim();
  if (text.length > maxLength) {
    throw new AuthError(`${field} 不能超过 ${maxLength} 个字符`, { code: 'BOOKING_INVALID_REQUEST' });
  }
  return text;
}

function positiveInteger(value, field, { allowZero = false } = {}) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new AuthError(`${field} 格式无效`, { code: 'BOOKING_INVALID_REQUEST' });
  }
  return value;
}

function mysqlDate(date) {
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function jsonValue(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function flightTimes(row) {
  const departureHour = String(Math.floor(row.departure_minutes / 60) % 24).padStart(2, '0');
  const departureMinute = String(row.departure_minutes % 60).padStart(2, '0');
  const arrivalMinutes = row.departure_minutes + row.duration_minutes;
  const arrivalHour = String(Math.floor(arrivalMinutes / 60) % 24).padStart(2, '0');
  const arrivalMinute = String(arrivalMinutes % 60).padStart(2, '0');
  return { departureTime: `${departureHour}:${departureMinute}`, arrivalTime: `${arrivalHour}:${arrivalMinute}` };
}

function validatePassengerInput(input) {
  if (!Array.isArray(input.passengers) || input.passengers.length === 0) {
    throw new AuthError('passengers 至少需要一位乘客', { code: 'BOOKING_INVALID_REQUEST' });
  }
  const passengers = input.passengers.map((passenger, index) => ({
    clientPassengerId: requiredText(passenger?.clientPassengerId, `passengers[${index}].clientPassengerId`, 64),
    type: requiredText(passenger?.type, `passengers[${index}].type`, 20),
    title: requiredText(passenger?.title, `passengers[${index}].title`, 20),
    firstName: requiredText(passenger?.firstName, `passengers[${index}].firstName`, 80),
    lastName: requiredText(passenger?.lastName, `passengers[${index}].lastName`, 80),
    dateOfBirth: requiredText(passenger?.dateOfBirth, `passengers[${index}].dateOfBirth`, 10),
    ...(passenger.frequentFlyer ? { frequentFlyer: passenger.frequentFlyer } : {}),
    preferences: passenger.preferences && typeof passenger.preferences === 'object'
      ? passenger.preferences : {},
  }));
  const contact = input.contact;
  if (!contact || typeof contact !== 'object' || Array.isArray(contact)) {
    throw new AuthError('contact 必须是对象', { code: 'BOOKING_INVALID_REQUEST' });
  }
  const normalizedContact = {
    countryCode: requiredText(contact.countryCode, 'contact.countryCode', 2).toUpperCase(),
    dialCode: requiredText(contact.dialCode, 'contact.dialCode', 8),
    phoneNumber: requiredText(contact.phoneNumber, 'contact.phoneNumber', 20),
    email: requiredText(contact.email, 'contact.email', 254).toLowerCase(),
  };
  const preferences = input.preferences === undefined ? {} : input.preferences;
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
    throw new AuthError('preferences 必须是对象', { code: 'BOOKING_INVALID_REQUEST' });
  }
  return { contact: normalizedContact, passengers, preferences };
}

export class BookingStore {
  constructor({ pool, config = mysqlConfigFromEnv(), flightStore = getDefaultFlightStore(), now = () => new Date() } = {}) {
    this.pool = pool || mysql.createPool(config);
    this.flightStore = flightStore;
    this.now = now;
    this.initialization = null;
  }

  async initialize() {
    if (!this.initialization) {
      this.initialization = (async () => {
        for (const statement of SCHEMA) await this.pool.execute(statement);
      })();
    }
    return this.initialization;
  }

  async revalidateOffer(input = {}) {
    const inventoryId = requiredText(input.inventoryId, 'inventoryId', 80);
    const fareCode = requiredText(input.fareCode, 'fareCode', 40);
    const departureDate = requiredText(input.departureDate, 'departureDate', 10);
    const origin = requiredText(input.origin, 'origin', 3).toUpperCase();
    const destination = requiredText(input.destination, 'destination', 3).toUpperCase();
    const adults = positiveInteger(input.passengers?.adults, 'passengers.adults');
    const children = positiveInteger(input.passengers?.children ?? 0, 'passengers.children', { allowZero: true });
    const infants = positiveInteger(input.passengers?.infants ?? 0, 'passengers.infants', { allowZero: true });
    if (infants > adults) {
      throw new AuthError('婴儿数量不能超过成人数量', { code: 'BOOKING_INVALID_REQUEST' });
    }
    const passengerCount = adults + children + infants;
    const row = await this.flightStore.offer(inventoryId, fareCode);
    if (!row) throw new AuthError('所选航班或票价不存在', { status: 409, code: 'OFFER_UNAVAILABLE' });
    if (String(row.departure_date) !== departureDate
        || row.origin_code !== origin || row.destination_code !== destination) {
      throw new AuthError('航班库存与出发日期或航线不匹配', {
        status: 409, code: 'OFFER_MISMATCH',
      });
    }
    if (row.status !== 'scheduled') {
      throw new AuthError(row.status === 'cancelled' ? '所选航班已经取消' : '所选航班已经售罄', {
        status: 409, code: row.status === 'cancelled' ? 'FLIGHT_CANCELLED' : 'OFFER_SOLD_OUT',
      });
    }
    if (Number(row.seats_available) < passengerCount) {
      throw new AuthError('所选票价余位不足', { status: 409, code: 'INSUFFICIENT_SEATS' });
    }
    const currency = 'SAR';
    const total = Number(row.price) * passengerCount;
    const times = flightTimes(row);
    const changes = [];
    if (input.expected?.currency && input.expected.currency !== currency) {
      changes.push({ field: 'currency', oldValue: input.expected.currency, newValue: currency });
    }
    if (Number.isFinite(Number(input.expected?.total)) && Number(input.expected.total) !== total) {
      changes.push({ field: 'total', oldValue: Number(input.expected.total), newValue: total });
    }
    for (const field of ['departureTime', 'arrivalTime']) {
      if (input.expected?.[field] && input.expected[field] !== times[field]) {
        changes.push({ field, oldValue: input.expected[field], newValue: times[field] });
      }
    }
    const hasScheduleChange = changes.some((change) => ['departureTime', 'arrivalTime'].includes(change.field));
    const status = hasScheduleChange ? 'schedule_changed'
      : changes.some((change) => ['total', 'currency'].includes(change.field)) ? 'price_changed' : 'available';
    const quoteId = crypto.randomUUID();
    const expiresAt = new Date(this.now().getTime() + QUOTE_LIFETIME_MS);
    const snapshot = {
      flight: {
        inventoryId: row.id, flightNumbers: jsonValue(row.flight_numbers_json),
        origin: row.origin_code, destination: row.destination_code,
        departureDate: row.departure_date, ...times, durationMinutes: row.duration_minutes, status: row.status,
      },
      fare: {
        code: row.fare_code, name: row.fare_name, cabinClass: row.cabin_class,
        unitPrice: Number(row.price), seatsAvailable: Number(row.seats_available),
        cabinBaggage: { pieces: row.cabin_baggage_pieces, weightKgPerPiece: row.cabin_baggage_kg },
        checkedBaggageKg: row.checked_baggage_kg,
        changePolicy: row.change_policy, cancellationPolicy: row.cancellation_policy,
      },
    };
    await this.initialize();
    await this.pool.execute(`INSERT INTO booking_quotes
      (id, inventory_id, fare_code, passenger_count, currency, total, snapshot_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
      quoteId, inventoryId, fareCode, passengerCount, currency, total, JSON.stringify(snapshot), mysqlDate(expiresAt),
    ]);
    return {
      status, changed: changes.length > 0,
      quote: { quoteId, expiresAt: expiresAt.toISOString(), currency, total, passengerCount },
      ...snapshot, changes,
    };
  }

  async createDraft(input = {}, identity) {
    const quoteId = requiredText(input.quoteId, 'quoteId', 36);
    const details = validatePassengerInput(input);
    await this.initialize();
    const [quotes] = await this.pool.execute(`SELECT id, currency, total, passenger_count,
      DATE_FORMAT(expires_at, '%Y-%m-%dT%H:%i:%s.000Z') AS expires_at
      FROM booking_quotes WHERE id = ? AND expires_at > UTC_TIMESTAMP(3) LIMIT 1`, [quoteId]);
    if (!quotes[0]) throw new AuthError('报价已过期，请重新选择航班', { status: 409, code: 'QUOTE_EXPIRED' });
    if (details.passengers.length !== Number(quotes[0].passenger_count)) {
      throw new AuthError('乘客资料数量与报价人数不一致', {
        status: 409, code: 'PASSENGER_COUNT_MISMATCH',
      });
    }
    const bookingDraftId = crypto.randomUUID();
    const expiresAt = new Date(this.now().getTime() + DRAFT_LIFETIME_MS);
    await this.pool.execute(`INSERT INTO booking_drafts
      (id, quote_id, owner_type, owner_id, contact_json, passengers_json, preferences_json, status, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'passenger_details_saved', ?)`, [
      bookingDraftId, quoteId, identity.type, identity.id, JSON.stringify(details.contact),
      JSON.stringify(details.passengers), JSON.stringify(details.preferences), mysqlDate(expiresAt),
    ]);
    return this.#draftResponse({
      id: bookingDraftId, status: 'passenger_details_saved', expires_at: expiresAt.toISOString(),
      currency: quotes[0].currency, total: quotes[0].total,
      passengers_json: details.passengers,
    });
  }

  async updatePassengers(draftId, input = {}, identity) {
    const details = validatePassengerInput(input);
    await this.initialize();
    const [drafts] = await this.pool.execute(`SELECT q.passenger_count
      FROM booking_drafts d JOIN booking_quotes q ON q.id = d.quote_id
      WHERE d.id = ? AND d.owner_type = ? AND d.owner_id = ?
        AND d.expires_at > UTC_TIMESTAMP(3) LIMIT 1`, [draftId, identity.type, identity.id]);
    if (!drafts[0]) {
      throw new AuthError('预订草稿不存在、已过期或无权访问', {
        status: 404, code: 'BOOKING_DRAFT_NOT_FOUND',
      });
    }
    if (details.passengers.length !== Number(drafts[0].passenger_count)) {
      throw new AuthError('乘客资料数量与报价人数不一致', {
        status: 409, code: 'PASSENGER_COUNT_MISMATCH',
      });
    }
    const [result] = await this.pool.execute(`UPDATE booking_drafts SET contact_json = ?, passengers_json = ?,
      preferences_json = ?, expires_at = ?, status = 'passenger_details_saved'
      WHERE id = ? AND owner_type = ? AND owner_id = ? AND expires_at > UTC_TIMESTAMP(3)`, [
      JSON.stringify(details.contact), JSON.stringify(details.passengers), JSON.stringify(details.preferences),
      mysqlDate(new Date(this.now().getTime() + DRAFT_LIFETIME_MS)), draftId, identity.type, identity.id,
    ]);
    if (result.affectedRows === 0) {
      throw new AuthError('预订草稿不存在、已过期或无权访问', { status: 404, code: 'BOOKING_DRAFT_NOT_FOUND' });
    }
    return { bookingDraftId: draftId, status: 'passenger_details_saved', updatedAt: this.now().toISOString() };
  }

  #draftResponse(row) {
    const passengers = jsonValue(row.passengers_json).map((passenger) => ({
      passengerId: crypto.randomUUID(), ...passenger,
    }));
    return {
      bookingDraftId: row.id, status: row.status, expiresAt: row.expires_at,
      quote: {
        currency: row.currency, flightTotal: Number(row.total), extrasTotal: 0,
        seatTotal: 0, grandTotal: Number(row.total),
      },
      passengers,
    };
  }

  async close() { await this.pool.end(); }
}

let defaultStore;
export function getDefaultBookingStore() {
  defaultStore ??= new BookingStore();
  return defaultStore;
}
