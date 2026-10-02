import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { AuthError } from '../src/auth-store.js';

async function startServer(context, { bookingStore, authStore }) {
  const server = createApp({
    pushClient: { transport: 'test' },
    bookingStore,
    authStore,
  }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function fixtures() {
  const calls = [];
  return {
    calls,
    authStore: {
      async authenticate(token) {
        if (token !== 'user-access-token') {
          throw new AuthError('登录状态无效或已过期', { status: 401, code: 'UNAUTHORIZED' });
        }
        return { id: '42' };
      },
      async identityForGuestToken(token) {
        if (token !== 'guest-token') {
          throw new AuthError('游客身份无效或已过期', {
            status: 401, code: 'INVALID_GUEST_SESSION',
          });
        }
        return { type: 'guest', id: 'guest-42' };
      },
    },
    bookingStore: {
      async revalidateOffer(input) {
        calls.push({ method: 'revalidateOffer', input });
        return {
          status: 'available', changed: false,
          quote: {
            quoteId: 'quote-42', expiresAt: '2026-09-14T12:15:00.000Z',
            currency: 'SAR', total: 1280, passengerCount: 1,
          },
          changes: [],
        };
      },
      async createDraft(input, identity) {
        calls.push({ method: 'createDraft', input, identity });
        return {
          bookingDraftId: 'draft-42', status: 'passenger_details_saved',
          expiresAt: '2026-09-14T12:30:00.000Z',
        };
      },
      async updatePassengers(draftId, input, identity) {
        calls.push({ method: 'updatePassengers', draftId, input, identity });
        return { bookingDraftId: draftId, status: 'passenger_details_saved' };
      },
    },
  };
}

async function bundleKey(baseUrl) {
  const response = await fetch(`${baseUrl}/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bundleId: 'com.example.myapp' }),
  });
  return (await response.json()).key;
}

const passengerDetails = {
  quoteId: 'quote-42',
  contact: {
    countryCode: 'CN', dialCode: '+86', phoneNumber: '18226753983',
    email: 'ali@example.com',
  },
  passengers: [{
    clientPassengerId: 'passenger-1', type: 'adult', title: 'Mr',
    firstName: 'Ali', lastName: 'Khan', dateOfBirth: '1998-08-24',
  }],
  preferences: { subscribeOffers: false },
};

test('revalidates a selected flight with the bundle session key', async (context) => {
  const fixture = fixtures();
  const baseUrl = await startServer(context, fixture);
  const key = await bundleKey(baseUrl);
  const input = {
    inventoryId: 'MCT-DOH-WY669-20260914', fareCode: 'ECONOMY_FLEX',
    departureDate: '2026-09-14', origin: 'MCT', destination: 'DOH',
    passengers: { adults: 1, children: 0, infants: 0 },
    expected: { currency: 'SAR', total: 1280 },
  };
  const response = await fetch(`${baseUrl}/api/flights/offers/revalidate`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.data.quote.quoteId, 'quote-42');
  assert.deepEqual(fixture.calls[0], { method: 'revalidateOffer', input });
});

test('creates a passenger draft for a signed-in user', async (context) => {
  const fixture = fixtures();
  const baseUrl = await startServer(context, fixture);
  const response = await fetch(`${baseUrl}/api/bookings/drafts`, {
    method: 'POST',
    headers: { authorization: 'Bearer user-access-token', 'content-type': 'application/json' },
    body: JSON.stringify(passengerDetails),
  });
  const result = await response.json();

  assert.equal(response.status, 201);
  assert.equal(result.data.bookingDraftId, 'draft-42');
  assert.deepEqual(fixture.calls[0].identity, { type: 'user', id: '42' });
});

test('creates and updates a passenger draft for a guest', async (context) => {
  const fixture = fixtures();
  const baseUrl = await startServer(context, fixture);
  const guestInput = { ...passengerDetails, guestToken: 'guest-token' };
  const created = await fetch(`${baseUrl}/api/bookings/drafts`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(guestInput),
  });
  assert.equal(created.status, 201);

  const updated = await fetch(`${baseUrl}/api/bookings/drafts/draft-42/passengers`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(guestInput),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(fixture.calls[0].identity, { type: 'guest', id: 'guest-42' });
  assert.equal(fixture.calls[1].draftId, 'draft-42');
});

test('rejects a draft without a user or guest identity', async (context) => {
  const fixture = fixtures();
  const baseUrl = await startServer(context, fixture);
  const response = await fetch(`${baseUrl}/api/bookings/drafts`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(passengerDetails),
  });
  const result = await response.json();
  assert.equal(response.status, 401);
  assert.equal(result.code, 'INVALID_GUEST_SESSION');
});
