import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAirportCode, validateCityImage } from '../src/city-image-store.js';

test('normalizes an arrival airport code', () => {
  assert.equal(normalizeAirportCode(' doh '), 'DOH');
  assert.throws(() => normalizeAirportCode('DOHA'), /3 位 IATA/);
});

test('validates city image input and only accepts web URLs', () => {
  assert.deepEqual(validateCityImage({
    arrAirport: 'doh',
    cityName: ' Doha ',
    imageSrc: 'https://images.example.com/doha.jpg',
  }), {
    arrAirport: 'DOH',
    cityName: 'Doha',
    imageSrc: 'https://images.example.com/doha.jpg',
  });
  assert.throws(() => validateCityImage({
    arrAirport: 'DOH', cityName: 'Doha', imageSrc: 'javascript:alert(1)',
  }), /http 或 https/);
});
