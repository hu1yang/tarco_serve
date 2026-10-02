import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionStore } from '../src/session-store.js';

test('issues and resolves a session key', () => {
  const sessions = new SessionStore();
  const issued = sessions.create('com.example.flutterApp');
  assert.equal(typeof issued.key, 'string');
  assert.equal(sessions.get(issued.key).bundleId, 'com.example.flutterApp');
});

test('rejects an invalid bundle id', () => {
  assert.throws(() => new SessionStore().create('not a bundle id'), /bundleId/);
});
