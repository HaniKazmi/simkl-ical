import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { login, pollPin, readToken, requestPin, writeToken } from '../../../src/api/simkl/auth.ts';
import { jsonResponse, withFetch, withTempDataDir } from '../../helpers.ts';

// --- the token on disk ----------------------------------------------------

test('a written token round-trips', async () => {
  await withTempDataDir(async () => {
    const path = await writeToken('secret-token');
    assert.equal(await readToken(), 'secret-token');
    assert.equal(JSON.parse(await readFile(path, 'utf8')).access_token, 'secret-token');
  });
});

test('the token records when it was saved', async () => {
  await withTempDataDir(async (dir) => {
    await writeToken('t');
    const saved = JSON.parse(await readFile(join(dir, 'token.json'), 'utf8')).saved_at;
    assert.ok(!Number.isNaN(Date.parse(saved)), `saved_at should be a date, got ${saved}`);
  });
});

// writeFile creates at 0666 & ~umask, so narrowing with a later chmod leaves a
// window where the token is world-readable. That window is not observable from
// outside the process, so these catch the mode going missing altogether; the
// window itself is closed structurally, by renaming a fresh 0600 inode.
test('a freshly created token file is 0600 from the moment it exists', async () => {
  await withTempDataDir(async (dir) => {
    await writeToken('secret');
    assert.equal((await stat(join(dir, 'token.json'))).mode & 0o777, 0o600);
  });
});

// The assertion that pins the write-and-rename: `mode` alone does nothing to a
// file that already exists, so only replacing the inode tightens it.
test('replacing a loose token file leaves it 0600, not 0644', async () => {
  await withTempDataDir(async (dir) => {
    const path = join(dir, 'token.json');
    await writeFile(path, '{}');
    await chmod(path, 0o644);
    await writeToken('replacement');
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await readToken(), 'replacement');
  });
});

test('writing the token leaves no temporary file behind', async () => {
  await withTempDataDir(async (dir) => {
    const { readdir } = await import('node:fs/promises');
    await writeToken('t');
    assert.deepEqual(await readdir(dir), ['token.json']);
  });
});

test('a missing token file reads as null rather than throwing', async () => {
  await withTempDataDir(async () => {
    assert.equal(await readToken(), null);
  });
});

test('a token file with no access_token reads as null', async () => {
  await withTempDataDir(async (dir) => {
    await writeFile(join(dir, 'token.json'), JSON.stringify({ saved_at: 'whenever' }));
    assert.equal(await readToken(), null);
  });
});

// Only ENOENT is swallowed: treating a truncated file as "no token" would hide
// a real problem behind a login prompt.
test('an unreadable token file throws rather than reading as absent', async () => {
  await withTempDataDir(async (dir) => {
    await writeFile(join(dir, 'token.json'), '{ truncated');
    await assert.rejects(() => readToken());
  });
});

// --- the device flow ------------------------------------------------------

const PIN = { result: 'OK', user_code: 'ABC123', verification_url: 'https://simkl.com/pin', expires_in: 900, interval: 0 };

test('requestPin returns the code and where to enter it', async () => {
  await withFetch(
    () => jsonResponse(PIN),
    async () => {
      const pin = await requestPin();
      assert.equal(pin.userCode, 'ABC123');
      assert.equal(pin.verificationUrl, 'https://simkl.com/pin');
      assert.equal(pin.expiresIn, 900);
    },
  );
});

test('requestPin accepts the verification_uri spelling and fills in defaults', async () => {
  await withFetch(
    () => jsonResponse({ user_code: 'XYZ', verification_uri: 'https://example.test/pin' }),
    async () => {
      const pin = await requestPin();
      assert.equal(pin.verificationUrl, 'https://example.test/pin');
      assert.equal(pin.expiresIn, 900, 'a sensible default when unstated');
      assert.equal(pin.intervalSeconds, 5);
    },
  );
});

test('requestPin falls back to the known pin page when none is given', async () => {
  await withFetch(
    () => jsonResponse({ user_code: 'XYZ' }),
    async () => {
      assert.equal((await requestPin()).verificationUrl, 'https://simkl.com/pin');
    },
  );
});

test('a non-OK result from the pin endpoint is an error', async () => {
  await withFetch(
    () => jsonResponse({ result: 'KO', message: 'client id unknown', user_code: '' }),
    async () => {
      await assert.rejects(() => requestPin(), /client id unknown/);
    },
  );
});

// SIMKL returns the literal string "DEVICE_CODE" for device_code; polling is
// keyed on user_code, which is the value shown to the user.
test('polling uses the user code, not the device code placeholder', async () => {
  await withFetch(
    () => jsonResponse({ result: 'KO' }),
    async (calls) => {
      await pollPin('ABC123');
      assert.ok(calls[0]!.includes('/oauth/pin/ABC123'), String(calls[0]));
      assert.ok(!calls[0]!.includes('DEVICE_CODE'), String(calls[0]));
    },
  );
});

test('polling returns null until approval, then the token', async () => {
  await withFetch(
    () => jsonResponse({ result: 'KO' }),
    async () => {
      assert.equal(await pollPin('ABC123'), null);
    },
  );
  await withFetch(
    () => jsonResponse({ result: 'OK', access_token: 'granted' }),
    async () => {
      assert.equal(await pollPin('ABC123'), 'granted');
    },
  );
});

test('a login polls until the user approves', async () => {
  let polls = 0;
  const prompted: string[] = [];
  await withFetch(
    (url) => {
      if (url.includes('/oauth/pin/')) {
        polls += 1;
        return jsonResponse(polls < 3 ? { result: 'KO' } : { result: 'OK', access_token: 'granted' });
      }
      return jsonResponse(PIN);
    },
    async () => {
      const token = await login({ onPrompt: (p) => void prompted.push(p.userCode) });
      assert.equal(token, 'granted');
      assert.equal(polls, 3);
      assert.deepEqual(prompted, ['ABC123'], 'the code is shown once, before polling');
    },
  );
});

test('a code that is never approved expires rather than polling forever', async () => {
  await withFetch(
    (url) => jsonResponse(url.includes('/oauth/pin/') ? { result: 'KO' } : { ...PIN, expires_in: 0 }),
    async () => {
      await assert.rejects(() => login(), /expired before it was approved/);
    },
  );
});
