import assert from 'node:assert/strict';
import test from 'node:test';
import { SimulatorPushClient } from '../src/simulator-client.js';

test('targets the simulator UDID registered for the selected device', async () => {
  const calls = [];
  const client = new SimulatorPushClient();
  client.send = async (...args) => {
    calls.push(args);
    return { simulated: true };
  };

  await client.sendNotification(null, { aps: { alert: 'hello' } }, {
    bundleId: 'com.example.app',
    deviceId: 'installation-123',
    simulatorUdid: '6B82192D-60F1-4F8D-904A-3A30E36E8C7B',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'com.example.app');
  assert.equal(calls[0][2], '6B82192D-60F1-4F8D-904A-3A30E36E8C7B');
});

test('does not redirect an old device record to whichever simulator is booted', () => {
  const client = new SimulatorPushClient();
  assert.throws(
    () => client.sendNotification(null, {}, {
      bundleId: 'com.example.app',
      deviceId: 'legacy-installation',
    }),
    /尚未绑定 Simulator UDID/,
  );
});
