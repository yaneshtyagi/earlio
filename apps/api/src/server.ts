import { bootstrap } from './bootstrap';
import { buildApp } from './app';
import { startWorker } from './worker';

const { svc, stop } = await bootstrap();
const app = await buildApp(svc);
const stopWorker = svc.config.env === 'test' ? () => {} : startWorker(svc);
await app.listen({ port: svc.config.port, host: svc.config.host });
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => { stopWorker(); await app.close(); await stop(); process.exit(0); });
}
