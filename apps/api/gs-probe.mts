import { setup, teardown } from './test/global-setup';
await setup(); console.log('port', process.env.EARLIO_TEST_PG_PORT); await teardown();
