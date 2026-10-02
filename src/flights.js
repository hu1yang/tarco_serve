import { getDefaultFlightStore } from './flight-database.js';

const AIRPORT_CODE_PATTERN = /^[A-Z]{3}$/;
const DEPARTURE_PATTERN = /^(\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4})$/;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_INDEX = new Map([
  ['Jan', 0], ['Feb', 1], ['Mar', 2], ['Apr', 3], ['May', 4], ['Jun', 5],
  ['Jul', 6], ['Aug', 7], ['Sep', 8], ['Oct', 9], ['Nov', 10], ['Dec', 11],
]);

function validateBody(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('请求体必须是 JSON 对象');
  }
}

function airportCode(value, fieldName) {
  if (typeof value !== 'string' || !AIRPORT_CODE_PATTERN.test(value)) {
    throw new Error(`${fieldName} 必须是三个大写英文字母组成的机场代码`);
  }
  return value;
}

function route(input) {
  const depAirport = airportCode(input.depAirport, 'depAirport');
  const arrAirport = airportCode(input.arrAirport, 'arrAirport');
  if (depAirport === arrAirport) throw new Error('depAirport 和 arrAirport 不能相同');
  return { depAirport, arrAirport };
}

function departureDate(value) {
  if (typeof value !== 'string') {
    throw new Error('departure 必须是 dd MMM yyyy 格式的日期，例如 04 Sep 2026');
  }
  const match = DEPARTURE_PATTERN.exec(value);
  if (!match) throw new Error('departure 必须是 dd MMM yyyy 格式的日期，例如 04 Sep 2026');
  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText);
  const month = MONTH_INDEX.get(monthText);
  const year = Number(yearText);
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    throw new Error('departure 不是有效日期');
  }
  return date.toISOString().slice(0, 10);
}

function restrictedMonthCount(value) {
  if (!Number.isInteger(value) || value < 1 || value > 12) {
    throw new Error('restrictedMonths 必须是 1 到 12 之间的整数');
  }
  return value;
}

function optionalStartDate(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('startDate 必须是 yyyy-MM-dd 格式的日期');
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) throw new Error('startDate 必须是 yyyy-MM-dd 格式的日期');
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText) - 1;
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    throw new Error('startDate 不是有效日期');
  }
  return value;
}

function timeText(totalMinutes) {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, '0')}:${String(normalized % 60).padStart(2, '0')}`;
}

function durationText(minutes, stops) {
  const routeText = stops.length === 0
    ? 'non-stop'
    : `${stops.length} stop${stops.length > 1 ? 's' : ''} (${stops.join('), (')})`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} m, ${routeText}`;
}

async function airportResponse(store, code) {
  const airport = await store.airport(code);
  return airport ? { code: airport.code, city: airport.city } : { code, city: code };
}

function storeFrom(options) {
  return options.store || getDefaultFlightStore();
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  }
  return [];
}

export async function searchFlights(input, options = {}) {
  validateBody(input);
  const { depAirport, arrAirport } = route(input);
  const date = departureDate(input.departure);
  const store = storeFrom(options);
  const rows = await store.flights(depAirport, arrAirport, date);
  const flights = rows.map((row, index) => {
    const stops = jsonArray(row.stop_airports_json);
    const arrivalMinutes = row.departure_minutes + row.duration_minutes;
    return {
      id: `mock-flight-${String(index + 1).padStart(3, '0')}`,
      inventoryId: row.id,
      departureTime: timeText(row.departure_minutes),
      arrivalTime: timeText(arrivalMinutes),
      arrivalDayOffset: Math.floor(arrivalMinutes / 1440),
      durationMinutes: row.duration_minutes,
      durationText: durationText(row.duration_minutes, stops),
      stops,
      baseFare: row.base_fare,
      seatsLeft: row.seats_left,
      lowestFare: false,
      cabinClass: row.cabin_class,
      airlines: jsonArray(row.flight_numbers_json),
      fareOptions: row.fares.map((fare) => ({
        code: fare.code,
        name: fare.name,
        price: fare.price,
        seatsAvailable: fare.seats_available,
        cabinBaggage: { pieces: fare.cabin_baggage_pieces, weightKgPerPiece: fare.cabin_baggage_kg },
        checkedBaggageKg: fare.checked_baggage_kg,
        changePolicy: fare.change_policy,
        cancellationPolicy: fare.cancellation_policy,
      })),
    };
  });
  const lowest = Math.min(...flights.map((flight) => flight.baseFare));
  if (Number.isFinite(lowest)) flights.find((flight) => flight.baseFare === lowest).lowestFare = true;
  return {
    currency: 'SAR',
    departureDate: date,
    origin: await airportResponse(store, depAirport),
    destination: await airportResponse(store, arrAirport),
    resultCount: flights.length,
    flights,
  };
}

function rangeFor(now, restrictedMonths) {
  const start = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + restrictedMonths, 0));
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}

async function calendarFares(store, depAirport, arrAirport, startDate, endDate) {
  const rows = await store.lowestFares(depAirport, arrAirport, startDate, endDate);
  const prices = new Map(rows
    .map((row) => [row.date, row.lowest_price]));
  const fares = [];
  const date = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (date <= end) {
    const isoDate = date.toISOString().slice(0, 10);
    const price = prices.get(isoDate);
    fares.push({ lostPrice: price ?? null, isSegment: price !== undefined, date: isoDate });
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return fares;
}

export async function searchLowestFares(input, options = {}) {
  validateBody(input);
  const { depAirport, arrAirport } = route(input);
  const selectedDate = departureDate(input.departure);
  const restrictedMonths = restrictedMonthCount(input.restrictedMonths);
  const store = storeFrom(options);
  const { startDate, endDate } = rangeFor(options.now || new Date(), restrictedMonths);
  if (selectedDate < startDate) throw new Error('departure 不能早于今天');
  if (selectedDate > endDate) throw new Error('departure 不能晚于 restrictedMonths 限制范围');
  return {
    currency: 'SAR', depAirport, arrAirport, restrictedMonths, startDate, endDate, selectedDate,
    fares: await calendarFares(store, depAirport, arrAirport, startDate, endDate),
  };
}

export async function searchLowestFaresByMonths(input, options = {}) {
  validateBody(input);
  const { depAirport, arrAirport } = route(input);
  const restrictedMonths = restrictedMonthCount(input.restrictedMonths);
  const store = storeFrom(options);
  const range = rangeFor(options.now || new Date(), restrictedMonths);
  const requestedStartDate = optionalStartDate(input.startDate);
  const startDate = requestedStartDate && requestedStartDate > range.startDate
    ? requestedStartDate : range.startDate;
  const { endDate } = range;
  if (startDate > endDate) throw new Error('startDate 不能晚于 restrictedMonths 限制范围');
  return {
    currency: 'SAR', depAirport, arrAirport, restrictedMonths, startDate, endDate,
    fares: await calendarFares(store, depAirport, arrAirport, startDate, endDate),
  };
}
