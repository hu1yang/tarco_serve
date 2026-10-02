import mysql from 'mysql2/promise';
import { mysqlConfigFromEnv } from './flight-database.js';

const SCHEMA = `CREATE TABLE IF NOT EXISTS airport_city_images (
  airport_code CHAR(3) PRIMARY KEY,
  city_name VARCHAR(80) NOT NULL,
  image_src VARCHAR(2048) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

export function normalizeAirportCode(value, field = 'arrAirport') {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(code)) throw new Error(`${field} 必须是 3 位 IATA 机场代码`);
  return code;
}

export function validateCityImage(input = {}, airportCode) {
  const arrAirport = normalizeAirportCode(airportCode ?? input.arrAirport);
  const cityName = typeof input.cityName === 'string' ? input.cityName.trim() : '';
  const imageSrc = typeof input.imageSrc === 'string' ? input.imageSrc.trim() : '';
  if (!cityName || cityName.length > 80) throw new Error('cityName 必须为 1～80 个字符');
  if (!imageSrc || imageSrc.length > 2048) throw new Error('imageSrc 必须为 1～2048 个字符');
  let url;
  try {
    url = new URL(imageSrc);
  } catch {
    throw new Error('imageSrc 必须是有效的图片 URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('imageSrc 仅支持 http 或 https URL');
  }
  return { arrAirport, cityName, imageSrc: url.toString() };
}

function mapRow(row) {
  if (!row) return null;
  return {
    arrAirport: row.airport_code,
    cityName: row.city_name,
    imageSrc: row.image_src,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CityImageStore {
  constructor(config = mysqlConfigFromEnv()) {
    this.pool = mysql.createPool(config);
    this.initialization = null;
  }

  async initialize() {
    this.initialization ??= this.pool.execute(SCHEMA);
    await this.initialization;
  }

  async get(arrAirport) {
    await this.initialize();
    const code = normalizeAirportCode(arrAirport);
    const [rows] = await this.pool.execute(
      'SELECT * FROM airport_city_images WHERE airport_code = ? LIMIT 1', [code],
    );
    return mapRow(rows[0]);
  }

  async list() {
    await this.initialize();
    const [rows] = await this.pool.execute(
      'SELECT * FROM airport_city_images ORDER BY updated_at DESC, airport_code',
    );
    return rows.map(mapRow);
  }

  async upsert(input, airportCode) {
    await this.initialize();
    const cityImage = validateCityImage(input, airportCode);
    await this.pool.execute(`INSERT INTO airport_city_images
      (airport_code, city_name, image_src) VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE city_name = VALUES(city_name), image_src = VALUES(image_src)`, [
      cityImage.arrAirport, cityImage.cityName, cityImage.imageSrc,
    ]);
    return this.get(cityImage.arrAirport);
  }

  async delete(arrAirport) {
    await this.initialize();
    const code = normalizeAirportCode(arrAirport);
    const [result] = await this.pool.execute(
      'DELETE FROM airport_city_images WHERE airport_code = ?', [code],
    );
    return result.affectedRows > 0;
  }

  async close() { await this.pool.end(); }
}

let defaultStore;
export function getDefaultCityImageStore() {
  defaultStore ??= new CityImageStore();
  return defaultStore;
}
