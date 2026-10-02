import fs from 'node:fs';
import path from 'node:path';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

export function loadConfig() {
  const base = {
    port: Number(process.env.PORT || 3000),
    host: process.env.HOST?.trim() || '127.0.0.1',
  };

  const inlineKey = process.env.APNS_PRIVATE_KEY?.replaceAll('\\n', '\n');
  const keyPath = process.env.APNS_KEY_PATH?.trim();
  const hasApnsConfig = Boolean(
    inlineKey?.includes('BEGIN PRIVATE KEY')
      || (keyPath && fs.existsSync(path.resolve(keyPath))),
  );
  if (!hasApnsConfig) return { ...base, apns: null };

  const privateKey = inlineKey || (keyPath
    ? fs.readFileSync(path.resolve(keyPath), 'utf8')
    : required('APNS_PRIVATE_KEY 或 APNS_KEY_PATH'));

  return {
    ...base,
    apns: {
      keyId: required('APNS_KEY_ID'),
      teamId: required('APNS_TEAM_ID'),
      bundleId: required('APNS_BUNDLE_ID'),
      privateKey,
      useSandbox: (process.env.APNS_USE_SANDBOX || 'true').toLowerCase() !== 'false',
    },
  };
}
