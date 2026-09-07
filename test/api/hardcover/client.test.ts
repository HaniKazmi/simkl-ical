import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearHardcoverToken, graphql, HardcoverError } from '../../../src/api/hardcover/client.ts';
import { recentRequests } from '../../../src/api/requests.ts';
import { withConfig, withFetch } from '../../helpers.ts';

const tokenFile = (contents: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'hardcover-'));
  const path = join(dir, 'token');
  writeFileSync(path, contents);
  return path;
};

const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const ask = (): Promise<{ editions: { id: number }[] }> =>
  graphql<{ editions: { id: number }[] }>({ path: 'editions/379760', query: '{ editions { id } }', component: 'artwork' });

test('no token path means no request at all', async () => {
  clearHardcoverToken();
  await withConfig({ hardcoverTokenPath: undefined }, async () => {
    await withFetch(
      () => ok({}),
      async (calls) => {
        await assert.rejects(ask, (err: Error) => err instanceof HardcoverError && /HARDCOVER_TOKEN_PATH is not set/.test(err.message));
        // Thrown before the fetch, so an unconfigured install cannot reach
        // Hardcover even if a caller forgets the gate.
        assert.deepEqual(calls, []);
      },
    );
  });
});

test('a missing file and an empty one each name the path', async () => {
  clearHardcoverToken();
  await withConfig({ hardcoverTokenPath: '/nowhere/hardcover.token' }, async () => {
    await withFetch(
      () => ok({}),
      async (calls) => {
        await assert.rejects(ask, (err: Error) => /No Hardcover token at \/nowhere\/hardcover.token/.test(err.message));
        assert.deepEqual(calls, []);
      },
    );
  });
  clearHardcoverToken();
  await withConfig({ hardcoverTokenPath: tokenFile('  \n') }, async () => {
    await withFetch(
      () => ok({}),
      async () => {
        await assert.rejects(ask, (err: Error) => /is empty/.test(err.message));
      },
    );
  });
});

test('the token is read once, trimmed, and sent as a bearer on a POST carrying the query', async () => {
  clearHardcoverToken();
  await withConfig({ hardcoverTokenPath: tokenFile('hc_pat_secret\n') }, async () => {
    const seen: RequestInit[] = [];
    await withFetch(
      (_url, init) => {
        seen.push(init ?? {});
        return ok({ data: { editions: [{ id: 1 }] } });
      },
      async (calls) => {
        await ask();
        await ask();
        assert.deepEqual(calls, ['https://api.hardcover.app/v1/graphql', 'https://api.hardcover.app/v1/graphql']);
        const headers = seen[0]?.headers as Record<string, string>;
        assert.equal(headers.Authorization, 'Bearer hc_pat_secret');
        assert.equal(seen[0]?.method, 'POST');
        assert.deepEqual(JSON.parse(String(seen[0]?.body)).query, '{ editions { id } }');
      },
    );
  });
});

test('a query rejected with a 200 is a failure, not an empty answer', async () => {
  // The trap this client exists to close: Hardcover answers a bad query with
  // HTTP 200 and an `errors` body. Read on status alone it is a success whose
  // `data` is undefined, and it reaches the page as "this book has no covers".
  clearHardcoverToken();
  await withConfig({ hardcoverTokenPath: tokenFile('t') }, async () => {
    await withFetch(
      () => ok({ errors: [{ message: "field 'nope' not found in type: 'editions'" }] }),
      async () => {
        await assert.rejects(ask, (err: Error) => err instanceof HardcoverError && /field 'nope' not found/.test(err.message));
      },
    );
    await withFetch(
      () => ok({ error: 'Malformed request body' }),
      async () => {
        await assert.rejects(ask, (err: Error) => /Malformed request body/.test(err.message));
      },
    );
    await withFetch(
      () => ok({}),
      async () => {
        await assert.rejects(ask, (err: Error) => /carried no data/.test(err.message));
      },
    );
  });
});

test('a 401 re-reads the token and retries; a 403 does not', async () => {
  clearHardcoverToken();
  const path = tokenFile('stale');
  await withConfig({ hardcoverTokenPath: path }, async () => {
    let n = 0;
    const seen: RequestInit[] = [];
    await withFetch(
      (_url, init) => {
        seen.push(init ?? {});
        n += 1;
        // The operator rotates the token between the two attempts. A cached
        // credential re-sent verbatim would fail twice.
        if (n === 1) {
          writeFileSync(path, 'rotated');
          return new Response('{}', { status: 401 });
        }
        return ok({ data: { editions: [] } });
      },
      async (calls) => {
        await ask();
        assert.equal(calls.length, 2);
        // The point of the 401 arm, and the assertion whose absence let a
        // captured token pass for a re-read one: the retry must carry what the
        // file says now, not what the first attempt sent.
        assert.equal((seen[1]?.headers as Record<string, string>).Authorization, 'Bearer rotated');
      },
    );
  });
  clearHardcoverToken();
  await withConfig({ hardcoverTokenPath: tokenFile('t') }, async () => {
    await withFetch(
      () => new Response('{"error":"insufficient_scope"}', { status: 403 }),
      async (calls) => {
        // Asking again fixes neither a missing scope nor a query over the
        // top-level field cap.
        await assert.rejects(ask, (err: Error) => err instanceof HardcoverError);
        assert.equal(calls.length, 1);
      },
    );
  });
});

test('a 429 is retried, honouring Retry-After', async () => {
  clearHardcoverToken();
  await withConfig({ hardcoverTokenPath: tokenFile('t') }, async () => {
    let n = 0;
    await withFetch(
      () => {
        n += 1;
        return n === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } }) : ok({ data: { editions: [] } });
      },
      async (calls) => {
        await ask();
        assert.equal(calls.length, 2);
      },
    );
  });
});

test('the request log names the query, not the one path every call shares', async () => {
  // Every call is POST /v1/graphql, so without the caller's own label the
  // status page shows an unbroken column of identical rows.
  clearHardcoverToken();
  await withConfig({ hardcoverTokenPath: tokenFile('t') }, async () => {
    await withFetch(
      () => ok({ data: { editions: [] } }),
      async () => {
        await ask();
        const row = recentRequests().at(-1);
        assert.equal(row?.service, 'hardcover');
        assert.equal(row?.path, 'editions/379760');
        assert.equal(row?.method, 'POST');
      },
    );
  });
});
