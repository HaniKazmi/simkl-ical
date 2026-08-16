#!/usr/bin/env node
// One-shot device login. Deliberately a CLI, not an HTTP route: nothing
// reachable from the public hostname should be able to start an OAuth flow.
//
//   npm run login
//   docker compose run --rm simkl-ical npm run login
import { login, writeToken, readToken } from './api/simkl/auth.ts';
import { errorMessage } from './shared/errors.ts';

// --force first, and the read inside a try: `readToken` rethrows anything that
// is not ENOENT, so a corrupt or unreadable token.json would crash the one
// command that exists to replace it.
if (!process.argv.includes('--force')) {
  let existing: string | null = null;
  try {
    existing = await readToken();
  } catch (err) {
    console.warn(`  The existing token could not be read (${errorMessage(err)}); authorising afresh.`);
  }
  if (existing) {
    console.log('A token already exists in the data directory.');
    console.log('Re-run with --force to replace it.');
    process.exit(0);
  }
}

try {
  const token = await login({
    onPrompt: ({ userCode, verificationUrl, expiresIn }) => {
      console.log('');
      console.log(`  Go to  ${verificationUrl}`);
      console.log(`  Enter  ${userCode}`);
      console.log('');
      console.log(`  Waiting for approval (code expires in ${Math.round(expiresIn / 60)} minutes)...`);
    },
    onTick: (secondsLeft) => {
      process.stdout.write(`\r  still waiting... ${secondsLeft}s left   `);
    },
  });

  const path = await writeToken(token);
  console.log(`\n\n  Authorised. Token written to ${path}\n`);
} catch (err) {
  console.error(`\n\n  Login failed: ${errorMessage(err)}\n`);
  process.exit(1);
}
