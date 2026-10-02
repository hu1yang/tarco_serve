import mysql from 'mysql2/promise';

const OPERATING_WEEKDAYS = new Set([1, 3, 6]); // Monday, Wednesday, Saturday

const AIRPORTS = [
  ['MCT', 'Muscat International Airport', 'Muscat', 'Oman', 'Asia/Muscat'],
  ['DOH', 'Hamad International Airport', 'Doha', 'Qatar', 'Asia/Qatar'],
  ['AUH', 'Zayed International Airport', 'Abu Dhabi', 'United Arab Emirates', 'Asia/Dubai'],
];

const AIRLINES = [
  ['WY', 'Oman Air'], ['QR', 'Qatar Airways'], ['EY', 'Etihad Airways'],
];

const SCHEDULES = [
  ['MCT-DOH-WY669', 'MCT', 'DOH', 'economy', 390, 95, [], ['WY 669'], 980],
  ['MCT-DOH-EY385', 'MCT', 'DOH', 'economy', 850, 210, ['AUH'], ['EY 385', 'EY 661'], 860],
  ['MCT-DOH-QR1127', 'MCT', 'DOH', 'business', 1080, 100, [], ['QR 1127'], 3510],
  ['DOH-MCT-WY668', 'DOH', 'MCT', 'economy', 470, 95, [], ['WY 668'], 940],
  ['DOH-MCT-EY662', 'DOH', 'MCT', 'economy', 790, 220, ['AUH'], ['EY 662', 'EY 386'], 820],
  ['DOH-MCT-QR1126', 'DOH', 'MCT', 'business', 1050, 100, [], ['QR 1126'], 3420],
];

const FARE_PRODUCTS = [
  ['ECONOMY_SUPER_SAVER', 'economy', 'Economy Super Saver', 0, 1, 7, null, 'fees_apply', 'non_refundable'],
  ['ECONOMY_COMFORT', 'economy', 'Economy Comfort', 60, 1, 7, 20, 'fees_apply', 'fees_apply'],
  ['ECONOMY_FLEX', 'economy', 'Economy Flex', 185, 1, 7, 30, 'allowed', 'fees_apply'],
  ['BUSINESS_COMFORT', 'business', 'Business Comfort', 0, 2, 7, 40, 'fees_apply', 'fees_apply'],
  ['BUSINESS_FLEX', 'business', 'Business Flex', 420, 2, 7, 50, 'allowed', 'fees_apply'],
];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS airports (
    code CHAR(3) PRIMARY KEY, name VARCHAR(120) NOT NULL, city VARCHAR(80) NOT NULL,
    country VARCHAR(80) NOT NULL, timezone VARCHAR(64) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS airlines (
    code VARCHAR(3) PRIMARY KEY, name VARCHAR(100) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS flight_schedules (
    id VARCHAR(64) PRIMARY KEY,
    origin_code CHAR(3) NOT NULL, destination_code CHAR(3) NOT NULL,
    cabin_class ENUM('economy', 'business') NOT NULL,
    departure_minutes SMALLINT UNSIGNED NOT NULL, duration_minutes SMALLINT UNSIGNED NOT NULL,
    stop_airports_json JSON NOT NULL, flight_numbers_json JSON NOT NULL,
    base_fare INT UNSIGNED NOT NULL,
    CONSTRAINT fk_schedule_origin FOREIGN KEY (origin_code) REFERENCES airports(code),
    CONSTRAINT fk_schedule_destination FOREIGN KEY (destination_code) REFERENCES airports(code),
    INDEX idx_schedule_route (origin_code, destination_code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS fare_products (
    code VARCHAR(40) PRIMARY KEY, cabin_class ENUM('economy', 'business') NOT NULL,
    name VARCHAR(80) NOT NULL, price_increment INT UNSIGNED NOT NULL,
    cabin_baggage_pieces TINYINT UNSIGNED NOT NULL, cabin_baggage_kg TINYINT UNSIGNED NOT NULL,
    checked_baggage_kg TINYINT UNSIGNED NULL,
    change_policy VARCHAR(30) NOT NULL, cancellation_policy VARCHAR(30) NOT NULL,
    INDEX idx_fare_cabin (cabin_class)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS flight_instances (
    id VARCHAR(80) PRIMARY KEY, schedule_id VARCHAR(64) NOT NULL,
    departure_date DATE NOT NULL, departure_minutes SMALLINT UNSIGNED NOT NULL,
    duration_minutes SMALLINT UNSIGNED NOT NULL, base_fare INT UNSIGNED NOT NULL,
    seats_left SMALLINT UNSIGNED NOT NULL,
    status ENUM('scheduled', 'cancelled', 'sold_out') NOT NULL,
    CONSTRAINT fk_instance_schedule FOREIGN KEY (schedule_id) REFERENCES flight_schedules(id),
    UNIQUE KEY uk_schedule_date (schedule_id, departure_date),
    INDEX idx_instance_date_status (departure_date, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS flight_fares (
    flight_id VARCHAR(80) NOT NULL, fare_code VARCHAR(40) NOT NULL,
    price INT UNSIGNED NOT NULL, seats_available SMALLINT UNSIGNED NOT NULL,
    PRIMARY KEY (flight_id, fare_code),
    CONSTRAINT fk_fare_flight FOREIGN KEY (flight_id) REFERENCES flight_instances(id) ON DELETE CASCADE,
    CONSTRAINT fk_fare_product FOREIGN KEY (fare_code) REFERENCES fare_products(code)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

function stableHash(text) {
  let hash = 2166136261;
  for (const character of text) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function dateRange(startDate, endDate) {
  const current = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const dates = [];
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function demandAdjustment(date, seed) {
  const month = Number(date.slice(5, 7));
  const highSeason = [1, 4, 7, 12].includes(month) ? 110 : 0;
  return highSeason + ((seed % 15) - 7) * 8;
}

export function mysqlConfigFromEnv() {
  return {
    host: process.env.MYSQL_HOST?.trim() || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER?.trim() || 'tarco_app',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE?.trim() || 'tarco_serve',
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10),
    dateStrings: true,
  };
}

export class FlightStore {
  constructor(config = mysqlConfigFromEnv()) {
    this.config = config;
    this.pool = mysql.createPool(config);
    this.initialization = null;
  }

  async initialize() {
    if (!this.initialization) this.initialization = this.#initialize();
    return this.initialization;
  }

  async #initialize() {
    for (const statement of SCHEMA) await this.pool.execute(statement);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const row of AIRPORTS) {
        await connection.execute('INSERT IGNORE INTO airports VALUES (?, ?, ?, ?, ?)', row);
      }
      for (const row of AIRLINES) {
        await connection.execute('INSERT IGNORE INTO airlines VALUES (?, ?)', row);
      }
      for (const row of SCHEDULES) {
        await connection.execute('INSERT IGNORE INTO flight_schedules VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [...row.slice(0, 6), JSON.stringify(row[6]), JSON.stringify(row[7]), row[8]]);
      }
      for (const row of FARE_PRODUCTS) {
        await connection.execute('INSERT IGNORE INTO fare_products VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', row);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async ensureInventory(origin, destination, startDate, endDate) {
    await this.initialize();
    const [schedules] = await this.pool.execute(
      'SELECT * FROM flight_schedules WHERE origin_code = ? AND destination_code = ? ORDER BY departure_minutes',
      [origin, destination],
    );
    if (schedules.length === 0) return;
    const [products] = await this.pool.execute('SELECT * FROM fare_products ORDER BY price_increment');
    const productsByCabin = new Map();
    for (const product of products) {
      const cabinProducts = productsByCabin.get(product.cabin_class) || [];
      cabinProducts.push(product);
      productsByCabin.set(product.cabin_class, cabinProducts);
    }
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      for (const date of dateRange(startDate, endDate)) {
        const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
        if (!OPERATING_WEEKDAYS.has(weekday)) continue;
        for (const schedule of schedules) {
          const seed = stableHash(`${schedule.id}-${date}`);
          const baseFare = Math.max(300, schedule.base_fare + demandAdjustment(date, seed));
          const seatsLeft = 3 + ((seed >>> 7) % 17);
          const status = seed % 53 === 0 ? 'cancelled' : 'scheduled';
          const flightId = `${schedule.id}-${date.replaceAll('-', '')}`;
          await connection.execute(`INSERT IGNORE INTO flight_instances
            (id, schedule_id, departure_date, departure_minutes, duration_minutes, base_fare, seats_left, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
            flightId, schedule.id, date, schedule.departure_minutes + (((seed % 5) - 2) * 5),
            schedule.duration_minutes + ((((seed >>> 3) % 5) - 2) * 5),
            baseFare, status === 'scheduled' ? seatsLeft : 0, status,
          ]);
          for (const product of productsByCabin.get(schedule.cabin_class) || []) {
            await connection.execute(`INSERT IGNORE INTO flight_fares
              (flight_id, fare_code, price, seats_available) VALUES (?, ?, ?, ?)`, [
              flightId, product.code, baseFare + product.price_increment,
              status === 'scheduled' ? Math.max(1, seatsLeft - ((seed >>> 11) % 3)) : 0,
            ]);
          }
        }
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async airport(code) {
    await this.initialize();
    const [rows] = await this.pool.execute(
      'SELECT code, name, city, country, timezone FROM airports WHERE code = ?', [code],
    );
    return rows[0];
  }

  async flights(origin, destination, date) {
    await this.ensureInventory(origin, destination, date, date);
    const [rows] = await this.pool.execute(`SELECT i.*, s.cabin_class, s.stop_airports_json, s.flight_numbers_json
      FROM flight_instances i JOIN flight_schedules s ON s.id = i.schedule_id
      WHERE s.origin_code = ? AND s.destination_code = ? AND i.departure_date = ? AND i.status = 'scheduled'
      ORDER BY i.departure_minutes`, [origin, destination, date]);
    for (const row of rows) {
      const [fares] = await this.pool.execute(`SELECT ff.price, ff.seats_available, p.*
        FROM flight_fares ff JOIN fare_products p ON p.code = ff.fare_code
        WHERE ff.flight_id = ? ORDER BY ff.price`, [row.id]);
      row.fares = fares;
    }
    return rows;
  }

  async offer(inventoryId, fareCode) {
    await this.initialize();
    const [rows] = await this.pool.execute(`SELECT i.id, DATE_FORMAT(i.departure_date, '%Y-%m-%d') AS departure_date,
        i.departure_minutes, i.duration_minutes, i.status, i.seats_left,
        s.origin_code, s.destination_code, s.cabin_class, s.flight_numbers_json,
        ff.price, ff.seats_available, p.code AS fare_code, p.name AS fare_name,
        p.cabin_baggage_pieces, p.cabin_baggage_kg, p.checked_baggage_kg,
        p.change_policy, p.cancellation_policy
      FROM flight_instances i
      JOIN flight_schedules s ON s.id = i.schedule_id
      JOIN flight_fares ff ON ff.flight_id = i.id
      JOIN fare_products p ON p.code = ff.fare_code
      WHERE i.id = ? AND ff.fare_code = ? LIMIT 1`, [inventoryId, fareCode]);
    return rows[0];
  }

  async lowestFares(origin, destination, startDate, endDate) {
    await this.ensureInventory(origin, destination, startDate, endDate);
    const [rows] = await this.pool.execute(`SELECT DATE_FORMAT(i.departure_date, '%Y-%m-%d') AS date,
        MIN(ff.price) AS lowest_price
      FROM flight_instances i
      JOIN flight_schedules s ON s.id = i.schedule_id
      JOIN flight_fares ff ON ff.flight_id = i.id
      WHERE s.origin_code = ? AND s.destination_code = ?
        AND i.departure_date BETWEEN ? AND ? AND i.status = 'scheduled' AND ff.seats_available > 0
      GROUP BY i.departure_date ORDER BY i.departure_date`, [origin, destination, startDate, endDate]);
    return rows;
  }

  async stats(startDate, endDate) {
    await this.initialize();
    const [rows] = await this.pool.execute(`SELECT COUNT(DISTINCT i.id) AS flights, COUNT(ff.fare_code) AS fares
      FROM flight_instances i LEFT JOIN flight_fares ff ON ff.flight_id = i.id
      WHERE i.departure_date BETWEEN ? AND ?`, [startDate, endDate]);
    return rows[0];
  }

  async inventory(startDate, endDate) {
    await this.ensureInventory('MCT', 'DOH', startDate, endDate);
    const [flights] = await this.pool.execute(`SELECT i.id, DATE_FORMAT(i.departure_date, '%Y-%m-%d') AS departure_date,
        i.departure_minutes, i.duration_minutes, i.base_fare, i.seats_left, i.status,
        s.origin_code, s.destination_code, s.cabin_class, s.stop_airports_json, s.flight_numbers_json
      FROM flight_instances i JOIN flight_schedules s ON s.id = i.schedule_id
      WHERE i.departure_date BETWEEN ? AND ? ORDER BY i.departure_date, i.departure_minutes`, [startDate, endDate]);
    const [fares] = await this.pool.execute(`SELECT ff.flight_id, ff.fare_code, ff.price, ff.seats_available
      FROM flight_fares ff JOIN flight_instances i ON i.id = ff.flight_id
      WHERE i.departure_date BETWEEN ? AND ? ORDER BY ff.price`, [startDate, endDate]);
    const faresByFlight = new Map();
    for (const fare of fares) {
      const list = faresByFlight.get(fare.flight_id) || [];
      list.push(fare);
      faresByFlight.set(fare.flight_id, list);
    }
    return flights.map((flight) => ({ ...flight, fares: faresByFlight.get(flight.id) || [] }));
  }

  async close() { await this.pool.end(); }
}

let defaultStore;
export function getDefaultFlightStore() {
  defaultStore ??= new FlightStore();
  return defaultStore;
}
