import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiGet, classify, TvdbError } from '../../../src/api/tvdb/client.ts';
import { clearTokenCache, exchangeToken, TvdbAuthError } from '../../../src/api/tvdb/auth.ts';
import { buildConfig } from '../../../src/shared/config.ts';
import { clearRequests, recentRequests } from '../../../src/api/requests.ts';
import { jsonResponse, withConfig, withFetch } from '../../helpers.ts';

const KEY = 'secret-key-value';
const PIN = 'secret-pin';

/** A handler that logs in once and then answers with `body`. */
const server = (body: unknown, { status = 200 }: { status?: number } = {}) =>
  (url: string): Response => {
    if (url.endsWith('/login')) return jsonResponse({ status: 'success', data: { token: 'tok' } });
    return status === 200 ? jsonResponse(body) : new Response(JSON.stringify(body), { status });
  };

const withKey = (fn: () => Promise<void>) => withConfig({ tvdbApiKey: KEY }, fn);

test('a season read returns the parsed body', async () => {
  clearTokenCache();
  await withKey(() =>
    withFetch(server({ data: { episodes: [{ number: 1, runtime: 24 }] } }), async (calls) => {
      const out = await apiGet<{ data: { episodes: unknown[] } }>('/series/1/episodes/official', {
        component: 'runtimes',
        params: { season: 3, page: 0 },
      });
      assert.equal(out.data.episodes.length, 1);
      assert.equal(calls.length, 2, 'one login, one read');
      assert.equal(calls[1], 'https://api4.thetvdb.com/v4/series/1/episodes/official?season=3&page=0');
    }),
  );
});

// The load-bearing one. `describeUrl` renders request paths onto the status
// page and into the request log, so a credential in the query string is a
// credential on a page — and the denylist that hides boring parameters is the
// wrong mechanism to rely on for that.
test('neither the key nor the pin ever reaches a URL', async () => {
  clearTokenCache();
  await withConfig({ tvdbApiKey: KEY, tvdbPin: PIN }, () =>
    withFetch(server({ data: { episodes: [] } }), async (calls) => {
      await apiGet('/series/1/episodes/official', { component: 'runtimes', params: { season: 1 } });
      assert.ok(calls.length > 1);
      for (const call of calls) {
        assert.ok(!call.includes(KEY), `key leaked into ${call}`);
        assert.ok(!call.includes(PIN), `pin leaked into ${call}`);
      }
    }),
  );
});

test('the token is sent as a bearer, and the key goes in the login body alone', async () => {
  clearTokenCache();
  await withConfig({ tvdbApiKey: KEY, tvdbPin: PIN }, () =>
    withFetch(
      (url, init) => {
        if (url.endsWith('/login')) {
          assert.equal(init?.method, 'POST');
          assert.deepEqual(JSON.parse(String(init?.body)), { apikey: KEY, pin: PIN });
          return jsonResponse({ data: { token: 'tok' } });
        }
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer tok');
        return jsonResponse({ data: { episodes: [] } });
      },
      async () => {
        await apiGet('/series/1/episodes/official', { component: 'runtimes' });
      },
    ),
  );
});

// A licensed key logs in with the key alone, and TVDB hands back a token for a
// *wrong* pin rather than refusing — so sending an empty one would look like it
// worked while proving nothing.
test('an unset pin is omitted from the login body rather than sent empty', async () => {
  clearTokenCache();
  await withConfig({ tvdbApiKey: KEY, tvdbPin: undefined }, () =>
    withFetch(
      (url, init) => {
        if (url.endsWith('/login')) {
          assert.deepEqual(JSON.parse(String(init?.body)), { apikey: KEY });
          return jsonResponse({ data: { token: 'tok' } });
        }
        return jsonResponse({ data: { episodes: [] } });
      },
      async () => {
        await apiGet('/series/1/episodes/official', { component: 'runtimes' });
      },
    ),
  );
});

test('the token is fetched once and reused across calls', async () => {
  clearTokenCache();
  await withKey(() =>
    withFetch(server({ data: { episodes: [] } }), async (calls) => {
      await apiGet('/series/1/episodes/official', { component: 'runtimes' });
      await apiGet('/series/2/episodes/official', { component: 'runtimes' });
      assert.equal(calls.filter((c) => c.endsWith('/login')).length, 1);
    }),
  );
});

test('without a key nothing reaches the network at all', async () => {
  clearTokenCache();
  await withConfig({ tvdbApiKey: undefined }, () =>
    withFetch(
      () => {
        throw new Error('should not have been called');
      },
      async (calls) => {
        await assert.rejects(() => apiGet('/series/1/episodes/official', { component: 'runtimes' }), TvdbAuthError);
        assert.equal(calls.length, 0);
      },
    ),
  );
});

test('a rejected login is an account failure, not a fact about any season', async () => {
  clearTokenCache();
  await withKey(() =>
    withFetch(
      () => new Response(JSON.stringify({ status: 'failure', message: 'InvalidAPIKey: apikey invalid' }), { status: 401 }),
      async () => {
        const err = await apiGet('/series/1/episodes/official', { component: 'runtimes' }).catch((e: unknown) => e);
        assert.ok(err instanceof TvdbAuthError);
        assert.equal(classify(err), 'account');
      },
    ),
  );
});

// The lifetime in auth.ts is assumed rather than read from the response, so a
// token can in principle outlive its welcome. Dropping the cache is what makes
// a wrong guess cost one poll instead of every poll after it.
test('a 401 on a read drops the cached token so the next call logs in again', async () => {
  clearTokenCache();
  let reject = true;
  await withKey(() =>
    withFetch(
      (url) => {
        if (url.endsWith('/login')) return jsonResponse({ data: { token: 'tok' } });
        if (reject) return new Response('nope', { status: 401 });
        return jsonResponse({ data: { episodes: [] } });
      },
      async (calls) => {
        await assert.rejects(() => apiGet('/series/1/episodes/official', { component: 'runtimes' }), TvdbError);
        reject = false;
        await apiGet('/series/1/episodes/official', { component: 'runtimes' });
        assert.equal(calls.filter((c) => c.endsWith('/login')).length, 2);
      },
    ),
  );
});

test('a 404 is settled and a 500 is worth retrying', async () => {
  clearTokenCache();
  await withKey(() =>
    withFetch(server({ message: 'NotFoundException: Season not found' }, { status: 404 }), async () => {
      const err = await apiGet('/series/9/episodes/official', { component: 'runtimes' }).catch((e: unknown) => e);
      assert.equal(classify(err), 'gone');
    }),
  );

  clearTokenCache();
  await withKey(() =>
    withFetch(server({}, { status: 500 }), async (calls) => {
      const err = await apiGet('/series/9/episodes/official', { component: 'runtimes' }).catch((e: unknown) => e);
      assert.equal(classify(err), 'transient');
      assert.equal(calls.filter((c) => !c.endsWith('/login')).length, 4, 'retried to the cap');
    }),
  );
});

test('a login failure is logged under auth, and a season read under runtimes', async () => {
  clearTokenCache();
  clearRequests();
  await withKey(() =>
    withFetch(server({ data: { episodes: [] } }), async () => {
      await apiGet('/series/1/episodes/official', { component: 'runtimes' });
    }),
  );
  const records = recentRequests().filter((r) => r.service === 'tvdb');
  assert.deepEqual(new Set(records.map((r) => r.component)), new Set(['auth', 'runtimes']));
  clearRequests();
});

test('a missing key names the variable to set', async () => {
  await assert.rejects(() => exchangeToken(buildConfig({})), /TVDB_API_KEY is not set/);
});
