import assert from 'node:assert/strict';
import test from 'node:test';
import { AndroidSimulatorClient } from '../src/android-simulator-client.js';

test('sends only to the emulator reporting the selected installation ID', async () => {
  const commands = [];
  const client = new AndroidSimulatorClient({ adb: 'adb', run: async (_adb, args) => {
    commands.push(args);
    if (args[0] === 'devices') return { stdout: 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n' };
    if (args.some((arg) => arg.endsWith('.QUERY_DEVICE'))) {
      const id = args[1] === 'emulator-5554' ? 'installation-other' : 'installation-target';
      return { stdout: `Broadcast completed: result=0, data="${id}"\n` };
    }
    return { stdout: 'Broadcast completed: result=0, data="sent"\n' };
  } });

  const result = await client.sendNotification({ aps: { alert: { title: 'Hi', body: 'Message' } } }, {
    deviceId: 'installation-target', bundleId: 'com.example.tarco_aviation',
  });
  assert.equal(result.serial, 'emulator-5556');
  const pushes = commands.filter((args) => args.some((arg) => arg.endsWith('.LOCAL_PUSH')));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0][1], 'emulator-5556');
});

test('does not send when the selected installation is not connected', async () => {
  const commands = [];
  const client = new AndroidSimulatorClient({ adb: 'adb', run: async (_adb, args) => {
    commands.push(args);
    return { stdout: args[0] === 'devices'
      ? 'List of devices attached\nemulator-5554\tdevice\n'
      : 'Broadcast completed: result=0, data="installation-other"\n' };
  } });
  await assert.rejects(client.sendNotification({ aps: { alert: { title: 'Hi' } } }, {
    deviceId: 'installation-target', bundleId: 'com.example.tarco_aviation',
  }), /找不到/);
  assert.equal(commands.some((args) => args.some((arg) => arg.endsWith('.LOCAL_PUSH'))), false);
});

test('updates a live notification on the selected emulator', async () => {
  const commands = [];
  const client = new AndroidSimulatorClient({ adb: 'adb', run: async (_adb, args) => {
    commands.push(args);
    if (args[0] === 'devices') return { stdout: 'List of devices attached\nemulator-5554\tdevice\n' };
    if (args.some((arg) => arg.endsWith('.QUERY_DEVICE'))) {
      return { stdout: 'Broadcast completed: result=0, data="installation-target"\n' };
    }
    return { stdout: 'Broadcast completed: result=0, data="updated"\n' };
  } });
  const result = await client.sendLiveUpdate({
    event: 'update', orderId: 'order-123', contentState: { progress: 0.8 },
  }, { deviceId: 'installation-target', bundleId: 'com.example.tarco_aviation' });
  assert.equal(result.outcome, 'updated');
  const command = commands.find((args) => args.some((arg) => arg.endsWith('.LIVE_UPDATE')));
  assert.equal(command[1], 'emulator-5554');
  const payload = command[command.indexOf('payload') + 1];
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).orderId, 'order-123');
});
