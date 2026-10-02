import 'dotenv/config';
import { ApnsClient } from './apns-client.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { SimulatorPushClient } from './simulator-client.js';

try {
  const config = loadConfig();
  const pushClient = config.apns ? new ApnsClient(config.apns) : new SimulatorPushClient();
  const app = createApp({ pushClient });
  app.listen(config.port, config.host, () => {
    console.log(`Push service listening on http://${config.host}:${config.port}`);
    console.log(`Push transport: ${pushClient.transport}`);
  });
} catch (error) {
  console.error(`启动失败: ${error.message}`);
  process.exitCode = 1;
}
