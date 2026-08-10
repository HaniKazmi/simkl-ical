import { config, requireClientId, requireValidTimezone } from './config.js';
import { FeedState } from './refresh.js';
import { buildServer } from './server.js';

try {
  requireClientId();
  requireValidTimezone();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

if (!config.feedToken) {
  console.error('FEED_TOKEN is not set. Generate one with: openssl rand -hex 24');
  process.exit(1);
}

const state = new FeedState({ logger: console });
const app = buildServer(state);

// Listen before hydrating. The first fetch pulls several MB of calendar JSON,
// and refusing connections for the whole of it makes the container look dead to
// a healthcheck; answering 503 with a reason does not.
await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(`listening on :${config.port} in ${config.timezone}, warming up`);

(async () => {
  await state.hydrate();
  await state.refreshLibraryIfChanged();
  state.start();
  app.log.info(`ready: serving ${state.events.length} events`);
})().catch((err) => {
  // Never fatal: the server keeps answering /healthz so the failure is visible.
  state.lastError = `startup: ${err.message}`;
  app.log.error(`warm-up failed: ${err.stack ?? err.message}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    state.stop();
    await app.close();
    process.exit(0);
  });
}
