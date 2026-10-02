import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function adbExecutable() {
  const roots = [process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME,
    path.join(os.homedir(), 'Library/Android/sdk')];
  for (const root of roots) {
    if (root && fs.existsSync(path.join(root, 'platform-tools/adb'))) {
      return path.join(root, 'platform-tools/adb');
    }
  }
  return 'adb';
}

export class AndroidSimulatorClient {
  constructor({ run = execFileAsync, adb = adbExecutable() } = {}) {
    this.run = run;
    this.adb = adb;
  }

  async command(args) {
    try {
      const { stdout, stderr } = await this.run(this.adb, args, { timeout: 15_000 });
      if (/SecurityException|Permission Denial|Error:/.test(`${stdout}\n${stderr}`)) {
        throw new Error(`${stdout}\n${stderr}`.trim());
      }
      return stdout;
    } catch (error) {
      throw new Error(`ADB 操作失败: ${String(error.stderr || error.message).trim()}`);
    }
  }

  async resolveDevice({ deviceId, bundleId }) {
    if (!deviceId || !/^[A-Za-z0-9._:-]+$/.test(deviceId)) {
      throw new Error('Android 设备缺少有效的安装 ID');
    }
    if (!/^[A-Za-z0-9_.]+$/.test(bundleId || '')) throw new Error('Android 包名无效');
    const component = `${bundleId}/.AndroidPushReceiver`;
    const list = await this.command(['devices']);
    const serials = [...list.matchAll(/^(emulator-\d+)\s+device\s*$/gm)].map((match) => match[1]);
    if (serials.length === 0) throw new Error('当前没有已连接的 Android 模拟器');

    const matches = [];
    for (const serial of serials) {
      const result = await this.command(['-s', serial, 'shell', 'am', 'broadcast',
        '-n', component, '-a', `${bundleId}.QUERY_DEVICE`]);
      const reportedId = result.match(/Broadcast completed: result=\d+, data="([^"]+)"/)?.[1];
      if (reportedId === deviceId) matches.push(serial);
    }
    if (matches.length !== 1) {
      throw new Error(matches.length ? '多个 Android 模拟器报告了同一设备 ID，已停止发送'
        : '找不到这条设备记录对应的 Android 模拟器，请在该模拟器重新启动 App');
    }

    return { serial: matches[0], component };
  }

  async sendNotification(payload, context) {
    const { serial, component } = await this.resolveDevice(context);
    const { deviceId, bundleId } = context;
    const alert = payload.aps?.alert || {};
    const data = { ...payload };
    delete data.aps;
    const encoded = Buffer.from(JSON.stringify({
      title: alert.title || '', body: alert.body || '', data,
    }), 'utf8').toString('base64url');
    const result = await this.command(['-s', serial, 'shell', 'am', 'broadcast',
      '-n', component, '-a', `${bundleId}.LOCAL_PUSH`,
      '--es', 'deviceId', deviceId, '--es', 'payload', encoded]);
    if (!/Broadcast completed: result=\d+, data="sent"/.test(result)) {
      throw new Error('Android 模拟器没有确认通知已发送');
    }
    return { simulated: true, platform: 'android', serial };
  }

  async sendLiveUpdate(payload, context) {
    const { serial, component } = await this.resolveDevice(context);
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const result = await this.command(['-s', serial, 'shell', 'am', 'broadcast',
      '-n', component, '-a', `${context.bundleId}.LIVE_UPDATE`,
      '--es', 'deviceId', context.deviceId, '--es', 'payload', encoded]);
    const outcome = result.match(/Broadcast completed: result=\d+, data="([^"]+)"/)?.[1];
    if (outcome !== 'started' && outcome !== 'updated' && outcome !== 'ended') {
      throw new Error(`Android 模拟器没有应用实时通知: ${outcome || result.trim()}`);
    }
    return { simulated: true, platform: 'android', serial, outcome };
  }
}
