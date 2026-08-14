import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../src/config.ts';
import { FeedState } from '../src/refresh.ts';
import { jsonResponse, quiet, recorder, withFetch, withTempDataDir } from './helpers.ts';

config.clientId ??= 'test-client-id';

const T = '2026-08-15T12:00:00Z';

/** A full activities payload; pass overrides to move individual timestamps. */
const activities = (over: Record<string, Record<string, string>> = {}) => ({
  tv_shows: { watching: T, plantowatch: T, completed: T, removed_from_list: T, ...over.tv_shows },
  anime: { watching: T, plantowatch: T, completed: T, removed_from_list: T, ...over.anime },
  movies: { plantowatch: T, removed_from_list: T, ...over.movies },
});

const listBody = { shows: [{ show: { title: 'A Show', ids: { simkl: 100 } } }] };
const filmBody = { movies: [{ movie: { title: 'A Film', ids: { simkl: 300 } } }] };
const movieDetail = {
  title: 'A Film',
  runtime: 120,
  release_dates: [{ iso_3166_1: 'GB', results: [{ type: 3, release_date: '2027-05-25' }] }],
};

/** Routes the three endpoint families a library refresh touches. */
const api =
  (acts: unknown, { movieStatus = 200 }: { movieStatus?: number } = {}) =>
  (url: string): Response => {
    if (url.includes('/sync/activities')) return jsonResponse(acts);
    if (url.includes('/all-items/movies/')) return jsonResponse(filmBody);
    if (url.includes('/all-items/')) return jsonResponse(listBody);
    if (url.includes('/movies/')) {
      return movieStatus === 200 ? jsonResponse(movieDetail) : new Response('nope', { status: movieStatus });
    }
    throw new Error(`unexpected request: ${url}`);
  };

const withToken = (fn: (state: FeedState) => Promise<void>, logger: FeedState['log'] = quiet) =>
  withTempDataDir(async (dir) => {
    await writeFile(join(dir, 'token.json'), JSON.stringify({ access_token: 'tok' }));
    await fn(new FeedState({ logger }));
  });

const lists = (calls: string[]) => calls.filter((c) => c.includes('/all-items/')).map((c) => c.split('/all-items/')[1]!.split('?')[0]!);
const lookups = (calls: string[]) => calls.filter((c) => /\/movies\/\d/.test(c));

test('a cold start fetches every list and resolves the films', async () => {
  await withToken(async (state) => {
    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(lists(calls).length, 7, 'all seven lists');
      assert.equal(lookups(calls).length, 1, 'and the one film');
      assert.ok(state.library);
      assert.equal(state.movieReleases.size, 1);
    });
  });
});

// The whole point of the activities gate: a poll where nothing moved should
// cost exactly one request.
test('a poll with nothing changed makes one request and refetches nothing', async () => {
  await withToken(async (state) => {
    const acts = activities();
    await withFetch(api(acts), async () => {
      await state.refreshLibraryIfChanged();
    });
    await withFetch(api(acts), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(calls.length, 1, `expected only /sync/activities, got ${calls.join(', ')}`);
    });
  });
});

test('marking an episode watched refetches only that one list', async () => {
  await withToken(async (state) => {
    await withFetch(api(activities()), async () => {
      await state.refreshLibraryIfChanged();
    });

    const moved = activities({ tv_shows: { watching: '2026-08-15T18:00:00Z' } });
    await withFetch(api(moved), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.deepEqual(lists(calls), ['shows/watching']);
      assert.equal(lookups(calls).length, 0, 'an episode must not drag the film lookups along');
    });
  });
});

test('a film list change re-resolves the films', async () => {
  await withToken(async (state) => {
    await withFetch(api(activities()), async () => {
      await state.refreshLibraryIfChanged();
    });

    const moved = activities({ movies: { plantowatch: '2026-08-15T18:00:00Z' } });
    await withFetch(api(moved), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.deepEqual(lists(calls), ['movies/plantowatch']);
      assert.equal(lookups(calls).length, 1);
    });
  });
});

// A partial refresh must merge into what is already held, not replace it.
test('refetching one list leaves the others in place', async () => {
  await withToken(async (state) => {
    await withFetch(api(activities()), async () => {
      await state.refreshLibraryIfChanged();
    });
    const before = Object.keys(state.library ?? {}).sort();

    await withFetch(api(activities({ tv_shows: { watching: '2026-08-15T18:00:00Z' } })), async () => {
      await state.refreshLibraryIfChanged();
    });
    assert.deepEqual(Object.keys(state.library ?? {}).sort(), before, 'no list may be lost');
  });
});

// The bug this guards, from commit 2cde00e: recording the signature after a
// failed lookup would mark the film list current despite unresolved dates, and
// nothing would retry until the user next added or removed a title.
test('a transient film failure leaves the list stale so the next poll retries', async () => {
  await withToken(async (state) => {
    await withFetch(api(activities(), { movieStatus: 500 }), async () => {
      await state.refreshLibraryIfChanged();
    });

    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.deepEqual(lists(calls), ['movies/plantowatch'], 'the film list is retried');
      assert.equal(lookups(calls).length, 1);
    });
  });
});

// The other half: a 404 fails identically forever, so treating it as retryable
// refetched the whole film list on every poll for the life of the process.
test('a permanently gone film does not cause a refetch loop', async () => {
  await withToken(async (state) => {
    await withFetch(api(activities(), { movieStatus: 404 }), async () => {
      await state.refreshLibraryIfChanged();
    });

    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(calls.length, 1, `expected only /sync/activities, got ${calls.join(', ')}`);
    });
  });
});

// Nothing in the library moves when a studio delays a release, so without an
// age-based trigger the feed keeps a stale date until the film vanishes.
test('film dates are re-resolved once they age out, with no library change', async () => {
  await withToken(async (state) => {
    await withFetch(api(activities()), async () => {
      await state.refreshLibraryIfChanged();
    });

    state.filmsResolvedAt = new Date(Date.now() - config.movieRefreshMs - 1000).toISOString();
    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(lists(calls).length, 0, 'no list changed, so none is refetched');
      assert.equal(lookups(calls).length, 1, 'but the dates are re-read');
    });
  });
});

test('force refetches everything regardless of the signatures', async () => {
  await withToken(async (state) => {
    await withFetch(api(activities()), async () => {
      await state.refreshLibraryIfChanged();
    });
    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged({ force: true });
      assert.equal(lists(calls).length, 7);
    });
  });
});

// --- failure modes --------------------------------------------------------

test('no token is reported without touching the network', async () => {
  await withTempDataDir(async () => {
    const state = new FeedState({ logger: quiet });
    await withFetch(
      () => {
        throw new Error('should not have been called');
      },
      async (calls) => {
        await state.refreshLibraryIfChanged();
        assert.match(state.errors.library!, /no token/);
        assert.equal(calls.length, 0);
      },
    );
  });
});

test('a revoked token keeps the last good feed and says how to fix it', async () => {
  const log = recorder();
  await withToken(async (state) => {
    await withFetch(api(activities()), async () => {
      await state.refreshLibraryIfChanged();
    });
    const good = state.ics;

    await withFetch(
      () => new Response('unauthorized', { status: 401 }),
      async () => {
        await state.refreshLibraryIfChanged();
      },
    );

    assert.match(state.errors.library!, /^AUTH:/);
    assert.equal(state.ics, good, 'the feed must survive a revoked token');
    assert.ok(
      log.lines.some((l) => l.includes('npm run login -- --force')),
      log.lines.join('\n'),
    );
  }, log);
});

test('a successful poll clears an earlier library failure', async () => {
  await withToken(async (state) => {
    state.errors.library = 'AUTH: something old';
    await withFetch(api(activities()), async () => {
      await state.refreshLibraryIfChanged();
    });
    assert.equal(state.errors.library, null);
  });
});
