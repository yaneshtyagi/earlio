import { bootstrap } from './bootstrap';
import { buildApp } from './app';

const { svc, stop } = await bootstrap();
const app = await buildApp(svc);
await app.listen({ port: svc.config.port, host: svc.config.host });
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => { await app.close(); await stop(); process.exit(0); });
}
