import assert from 'node:assert/strict';
import test from 'node:test';
import { BookingStore } from '../src/booking-store.js';

const offer = {
  id: 'MCT-DOH-WY669-20260914',
  departure_date: '2026-09-14',
  departure_minutes: 390,
  duration_minutes: 95,
  status: 'scheduled',
  seats_left: 8,
  origin_code: 'MCT',
  destination_code: 'DOH',
  cabin_class: 'economy',
  flight_numbers_json: JSON.stringify(['WY 669']),
  price: 1280,
  seats_available: 5,
  fare_code: 'ECONOMY_FLEX',
  fare_name: 'Economy Flex',
  cabin_baggage_pieces: 1,
  cabin_baggage_kg: 7,
  checked_baggage_kg: 30,
  change_policy: 'allowed',
  cancellation_policy: 'fees_apply',
};

function storeWithOffer(value = offer) {
  const queries = [];
  const pool = {
    async execute(sql, params) {
      queries.push({ sql, params });
      return [{ affectedRows: 1 }];
    },
    async end() {},
  };
  return {
    queries,
    store: new BookingStore({
      pool,
      flightStore: { async offer() { return value; } },
      now: () => new Date('2026-09-14T12:00:00.000Z'),
    }),
  };
}

const request = {
  inventoryId: offer.id,
  fareCode: offer.fare_code,
  departureDate: offer.departure_date,
  origin: offer.origin_code,
  destination: offer.destination_code,
  passengers: { adults: 1, children: 0, infants: 0 },
  expected: { currency: 'SAR', total: 1200 },
};

test('creates a server-priced quote and reports a price change', async () => {
  const { store, queries } = storeWithOffer();
  const result = await store.revalidateOffer(request);

  assert.equal(result.status, 'price_changed');
  assert.equal(result.changed, true);
  assert.equal(result.quote.total, 1280);
  assert.equal(result.quote.expiresAt, '2026-09-14T12:15:00.000Z');
  assert.deepEqual(result.flight.flightNumbers, ['WY 669']);
  assert.equal(result.fare.seatsAvailable, 5);
  assert.equal(queries.some(({ sql }) => sql.includes('INSERT INTO booking_quotes')), true);
});

test('rejects inventory that does not belong to the submitted route', async () => {
  const { store } = storeWithOffer();
  await assert.rejects(
    store.revalidateOffer({ ...request, origin: 'DOH' }),
    (error) => error.code === 'OFFER_MISMATCH' && error.status === 409,
  );
});

test('rejects a quote when the selected fare has too few seats', async () => {
  const { store } = storeWithOffer({ ...offer, seats_available: 1 });
  await assert.rejects(
    store.revalidateOffer({
      ...request,
      passengers: { adults: 2, children: 0, infants: 0 },
    }),
    (error) => error.code === 'INSUFFICIENT_SEATS' && error.status === 409,
  );
});
