import assert from 'node:assert/strict';
import test from 'node:test';
import { searchFlights, searchLowestFaresByMonths } from '../src/flights.js';
import { createFlightStoreFixture } from './flight-store-fixture.js';

test('uses matching prices in search and the fare calendar', async () => {
  const store = createFlightStoreFixture();
  const search = await searchFlights(
    { depAirport: 'MCT', arrAirport: 'DOH', departure: '05 Sep 2026' }, { store },
  );
  const calendar = await searchLowestFaresByMonths(
    { depAirport: 'MCT', arrAirport: 'DOH', restrictedMonths: 2 },
    { store, now: new Date('2026-08-30T12:00:00.000Z') },
  );
  const lowestSearchPrice = Math.min(...search.flights.map((flight) => flight.fareOptions[0].price));
  assert.equal(calendar.fares.find((fare) => fare.date === '2026-09-05').lostPrice, lowestSearchPrice);
});

test('offers flights on only three weekdays each week', async () => {
  const calendar = await searchLowestFaresByMonths(
    { depAirport: 'MCT', arrAirport: 'DOH', restrictedMonths: 1 },
    { store: createFlightStoreFixture(), now: new Date('2026-09-06T12:00:00.000Z') },
  );
  assert.deepEqual(calendar.fares.slice(0, 7).filter((fare) => fare.isSegment).map((fare) => fare.date), [
    '2026-09-07', '2026-09-09', '2026-09-12',
  ]);
});

test('starts the monthly fare calendar at an optional start date', async () => {
  const calendar = await searchLowestFaresByMonths(
    { depAirport: 'MCT', arrAirport: 'DOH', restrictedMonths: 2, startDate: '2026-09-05' },
    { store: createFlightStoreFixture(), now: new Date('2026-08-30T12:00:00.000Z') },
  );

  assert.equal(calendar.startDate, '2026-09-05');
  assert.equal(calendar.endDate, '2026-09-30');
  assert.equal(calendar.fares[0].date, '2026-09-05');
  assert.equal(calendar.fares.at(-1).date, '2026-09-30');
  assert.equal(calendar.fares.length, 26);
});

test('rejects an invalid monthly fare start date', async () => {
  await assert.rejects(
    searchLowestFaresByMonths(
      { depAirport: 'MCT', arrAirport: 'DOH', restrictedMonths: 2, startDate: '2026-02-30' },
      { store: createFlightStoreFixture(), now: new Date('2026-01-10T12:00:00.000Z') },
    ),
    /startDate 不是有效日期/,
  );
});

test('offers return flights from DOH to MCT', async () => {
  const store = createFlightStoreFixture();
  const search = await searchFlights(
    { depAirport: 'DOH', arrAirport: 'MCT', departure: '07 Sep 2026' }, { store },
  );
  const calendar = await searchLowestFaresByMonths(
    { depAirport: 'DOH', arrAirport: 'MCT', restrictedMonths: 1 },
    { store, now: new Date('2026-09-06T12:00:00.000Z') },
  );

  assert.equal(search.flights.length, 3);
  assert.equal(search.origin.code, 'DOH');
  assert.equal(search.destination.code, 'MCT');
  assert.equal(calendar.fares.find((fare) => fare.date === '2026-09-07').lostPrice, 820);
});
