import { bootstrap } from './bootstrap';
import { buildApp } from './app';
import { startWorker } from './worker';

const { svc, stop } = await bootstrap();
const app = await buildApp(svc);
if (process.env.EARLIO_SEED_SCENARIOS === '1' && svc.config.env !== 'production') {
  const { seedScenarios } = await import('./demo/scenarios');
  const out = await seedScenarios(app, svc);
  console.log(`Pilot scenarios ready (${out.length} invoices); clock at ${svc.clock.now().toISOString()}`);
}
const stopWorker = svc.config.env === 'test' ? () => {} : startWorker(svc);
await app.listen({ port: svc.config.port, host: svc.config.host });
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => { stopWorker(); await app.close(); await stop(); process.exit(0); });
}
