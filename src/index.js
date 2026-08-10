import { config, requireClientId } from './config.js';
import { FeedState } from './refresh.js';
import { buildServer } from './server.js';

requireClientId();
if (!config.feedToken) {
  console.error('FEED_TOKEN is not set. Generate one with: openssl rand -hex 24');
  process.exit(1);
}

const state = new FeedState({ logger: console });
const app = buildServer(state);

await state.hydrate();
await state.refreshLibraryIfChanged();
state.start();

await app.listen({ port: config.port, host: '0.0.0.0' });

app.log.info(
  `serving ${state.events.length} events in ${config.timezone} at /${'*'.repeat(8)}/feed.ics`,
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    state.stop();
    await app.close();
    process.exit(0);
  });
}
