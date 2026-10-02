import assert from 'node:assert/strict';
import test from 'node:test';
import { NetworkSimulator } from '../src/network-simulator.js';

test('starts disabled and exposes the available profiles', () => {
  const simulator = new NetworkSimulator();
  const state = simulator.getState();
  assert.equal(state.enabled, false);
  assert.equal(state.profileId, 'weak-4g');
  assert.ok(state.profiles.some((profile) => profile.id === 'intermittent-offline'));
  assert.ok(state.profiles.some((profile) => profile.id === 'malformed-response'));
  const normal = state.profiles.find((profile) => profile.id === 'normal');
  assert.equal(normal.config.serviceUnavailableRate, 0);
  assert.equal(normal.config.timeoutRate, 0);
  assert.equal(normal.config.disconnectRate, 0);
});

test('selects deterministic sequence outcomes in order', () => {
  const simulator = new NetworkSimulator();
  simulator.configure({ profileId: 'burst-loss', enabled: true });
  assert.deepEqual(
    Array.from({ length: 9 }, () => simulator.pickOutcome()),
    ['success', 'success', 'success', 'success', 'success', 'disconnect', 'disconnect', 'disconnect', 'success'],
  );
});

test('rejects custom probabilities above one hundred percent', () => {
  const simulator = new NetworkSimulator();
  assert.throws(
    () => simulator.configure({ config: { serviceUnavailableRate: 60, timeoutRate: 50 } }),
    /不能超过 100%/,
  );
});
