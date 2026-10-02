import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class SimulatorPushClient {
  constructor({ device = 'booted' } = {}) {
    this.device = device;
    this.transport = 'ios-simulator';
  }

  async resolveInstalledBundleId(bundleId, device = this.device) {
    try {
      const { stdout: installedApps } = await execFileAsync(
        'xcrun',
        ['simctl', 'listapps', device],
        { timeout: 15_000 },
      );
      const identifiers = [...installedApps.matchAll(/CFBundleIdentifier = "([^"]+)";/g)]
        .map((match) => match[1]);
      return identifiers.find((candidate) => candidate.toLowerCase() === bundleId.toLowerCase())
        || bundleId;
    } catch {
      return bundleId;
    }
  }

  async send(bundleId, payload, device = this.device) {
    const targetBundleId = await this.resolveInstalledBundleId(bundleId, device);
    const file = path.join(os.tmpdir(), `codex-push-${crypto.randomUUID()}.apns`);
    const simulatorPayload = { 'Simulator Target Bundle': targetBundleId, ...payload };

    try {
      await fs.writeFile(file, JSON.stringify(simulatorPayload), { mode: 0o600 });
      const { stdout, stderr } = await execFileAsync(
        'xcrun',
        ['simctl', 'push', device, targetBundleId, file],
        { timeout: 15_000 },
      );
      return {
        simulated: true,
        id: crypto.randomUUID(),
        message: (stdout || stderr || 'Notification sent to simulator').trim(),
      };
    } catch (error) {
      const details = String(error.stderr || error.stdout || error.message).trim();
      throw new Error(`模拟器推送失败: ${details}`);
    } finally {
      await fs.rm(file, { force: true });
    }
  }

  sendNotification(_token, payload, { bundleId, deviceId, simulatorUdid } = {}) {
    if (deviceId && !simulatorUdid) {
      throw new Error('该设备尚未绑定 Simulator UDID，请在对应模拟器中重新启动 App 后再发送');
    }
    return this.send(bundleId, payload, simulatorUdid || this.device);
  }

  sendLiveActivity(_token, payload, { bundleId, simulatorUdid } = {}) {
    return this.send(bundleId, payload, simulatorUdid || this.device);
  }
}
