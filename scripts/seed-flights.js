import 'dotenv/config';
import { FlightStore } from '../src/flight-database.js';

const store = new FlightStore();
const now = new Date();
const start = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 12, 0));
const startDate = start.toISOString().slice(0, 10);
const endDate = end.toISOString().slice(0, 10);

await Promise.all([
  store.ensureInventory('MCT', 'DOH', startDate, endDate),
  store.ensureInventory('DOH', 'MCT', startDate, endDate),
]);
const { flights, fares } = await store.stats(startDate, endDate);

console.log(`Flight database: mysql://${store.config.host}:${store.config.port}/${store.config.database}`);
console.log(`Seeded ${flights} flight instances and ${fares} fare records (${startDate} to ${endDate}).`);
await store.close();
