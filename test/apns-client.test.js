import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import { ApnsClient } from '../src/apns-client.js';

test('creates a valid ES256 provider token and caches it', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const client = new ApnsClient({
    keyId: 'KEY123',
    teamId: 'TEAM123',
    privateKey,
    bundleId: 'com.example.app',
    useSandbox: true,
  });

  const token = client.jwt();
  assert.equal(client.jwt(), token);
  const [header, claims, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'ES256', kid: 'KEY123' });
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).iss, 'TEAM123');
  assert.equal(Buffer.from(signature, 'base64url').length, 64);
  assert.equal(crypto.verify(
    'sha256',
    Buffer.from(`${header}.${claims}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  ), true);
});
