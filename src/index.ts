import { config, requireClientId, requireValidTimezone } from './config.ts';
import { errorMessage, errorStack } from './errors.ts';
import { FeedState } from './refresh.ts';
import { buildServer } from './server.ts';

try {
  requireClientId();
  requireValidTimezone();
} catch (err) {
  console.error(errorMessage(err));
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

void (async () => {
  await state.hydrate();
  await state.refreshLibraryIfChanged();
  state.start();
  app.log.info(`ready: serving ${state.events.length} events`);
})().catch((err: unknown) => {
  // Never fatal: the server keeps answering /healthz so the failure is visible.
  state.errors.render = `startup: ${errorMessage(err)}`;
  app.log.error(`warm-up failed: ${errorStack(err)}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    state.stop();
    await app.close();
    process.exit(0);
  });
}
