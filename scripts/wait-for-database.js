import 'dotenv/config';
import mysql from 'mysql2/promise';
import { mysqlConfigFromEnv } from '../src/flight-database.js';

const config = mysqlConfigFromEnv();
const deadline = Date.now() + 60_000;
let lastError;

while (Date.now() < deadline) {
  let connection;
  try {
    connection = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectTimeout: 3_000,
    });
    await connection.end();
    console.log(`MySQL is ready at ${config.host}:${config.port}/${config.database}`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  } finally {
    if (connection) await connection.end().catch(() => {});
  }
}

console.error(`MySQL did not become ready within 60 seconds: ${lastError?.message || 'connection failed'}`);
process.exit(1);
