import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../src/config.ts';
import { FeedState } from '../src/refresh.ts';
import { LISTS } from '../src/sources/library.ts';
import { ago, emptyCalendars, jsonResponse, quiet, recorder, withConfig, withFetch, withTempDataDir } from './helpers.ts';

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

/** Get a state to a warm, fully-synced baseline. Twelve tests started this way. */
const prime = (state: FeedState, acts: unknown = activities(), opts: { movieStatus?: number } = {}) =>
  withFetch(api(acts, opts), () => state.refreshLibraryIfChanged());

const lists = (calls: string[]) => calls.filter((c) => c.includes('/all-items/')).map((c) => c.split('/all-items/')[1]!.split('?')[0]!);
const lookups = (calls: string[]) => calls.filter((c) => /\/movies\/\d/.test(c));

test('a cold start fetches every list and resolves the films', async () => {
  await withToken(async (state) => {
    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(lists(calls).length, LISTS.length, 'every list');
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
    await prime(state);

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
    await prime(state);

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
    await prime(state);
    const before = Object.keys(state.library ?? {}).sort();

    await prime(state, activities({ tv_shows: { watching: '2026-08-15T18:00:00Z' } }));
    assert.deepEqual(Object.keys(state.library ?? {}).sort(), before, 'no list may be lost');
  });
});

// Recording the signature after a failed lookup would mark the film list
// current despite unresolved dates, and nothing would retry.
test('a transient film failure leaves the list stale so the next poll retries', async () => {
  await withToken(async (state) => {
    await prime(state, activities(), { movieStatus: 500 });

    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.deepEqual(lists(calls), ['movies/plantowatch'], 'the film list is retried');
      assert.equal(lookups(calls).length, 1);
    });
  });
});

// A 404 fails identically forever, so treating it as retryable would refetch
// the whole film list on every poll.
test('a permanently gone film does not cause a refetch loop', async () => {
  await withToken(async (state) => {
    await prime(state, activities(), { movieStatus: 404 });

    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(calls.length, 1, `expected only /sync/activities, got ${calls.join(', ')}`);
    });
  });
});

// Nothing in the library moves when a studio delays a release, so only the
// age-based trigger catches it.
test('film dates are re-resolved once they age out, with no library change', async () => {
  await withToken(async (state) => {
    await prime(state);

    state.filmsResolvedAt = ago(config.movieRefreshMs + 1000);
    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(lists(calls).length, 0, 'no list changed, so none is refetched');
      assert.equal(lookups(calls).length, 1, 'but the dates are re-read');
    });
  });
});

test('force refetches everything regardless of the signatures', async () => {
  await withToken(async (state) => {
    await prime(state);
    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged({ force: true });
      assert.equal(lists(calls).length, LISTS.length);
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
    await prime(state);
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
    await prime(state);
    assert.equal(state.errors.library, null);
  });
});

// The signature rollback cannot force a retry when the round was triggered by
// age rather than a list change, since the signature never moved. Only
// withholding the timestamp keeps the next poll trying.
test('a failed daily re-read retries on the next poll, not in another day', async () => {
  await withToken(async (state) => {
    await prime(state);

    const before = state.filmsResolvedAt;
    state.filmsResolvedAt = ago(config.movieRefreshMs + 1000);

    await withFetch(api(activities(), { movieStatus: 500 }), async (calls) => {
      await state.refreshLibraryIfChanged();
      // A 500 is retryable, so apiGet spends all five attempts; what matters is
      // that the re-read happened at all.
      assert.ok(lookups(calls).length >= 1, 'the re-read was attempted');
    });
    assert.notEqual(state.filmsResolvedAt, before, 'precondition: it was aged');
    assert.ok(
      Date.now() - Date.parse(state.filmsResolvedAt!) > config.movieRefreshMs,
      'a failed round must not count as resolved',
    );

    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(lookups(calls).length, 1, 'so the very next poll tries again');
    });
  });
});

test('a successful daily re-read does reset the clock', async () => {
  await withToken(async (state) => {
    await prime(state);
    state.filmsResolvedAt = ago(config.movieRefreshMs + 1000);

    await prime(state);
    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(calls.length, 1, 'nothing more to do until it ages out again');
    });
  });
});

// A rate limit is account-wide, not a fact about these films.
test('a sustained rate limit keeps the films and retries rather than dropping them', async () => {
  await withToken(async (state) => {
    await prime(state);
    assert.equal(state.movieReleases.size, 1, 'precondition');

    state.filmsResolvedAt = ago(config.movieRefreshMs + 1000);
    await prime(state, activities(), { movieStatus: 429 });

    assert.equal(state.movieReleases.size, 1, 'the known date is kept, not dropped');
    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(lookups(calls).length, 1, 'and it is retried promptly');
    });
  });
});

// An auth failure during film lookups must surface as one, not be filed
// against individual films.
test('a revoked token during film lookups is reported as AUTH', async () => {
  await withToken(async (state) => {
    await withFetch(
      (url) => (url.includes('/movies/') && !url.includes('all-items') ? new Response('nope', { status: 401 }) : api(activities())(url)),
      async () => {
        await state.refreshLibraryIfChanged();
      },
    );
    assert.match(state.errors.library!, /^AUTH:/);
  });
});

// Dropping a show bumps only the destination list's timestamp, so `watching` is
// never refetched and keeps its pre-move copy — status and all. Nothing in the
// payloads separates that from an un-drop, so the poll has to resolve it while
// it still knows which list it just fetched.
test('a title claimed by a refetched list is evicted from the stale one it left', async () => {
  await withToken(async (state) => {
    await prime(state);
    assert.equal(state.library?.shows_watching?.shows?.length, 1, 'the baseline has it in watching');

    const moved = activities({ tv_shows: { dropped: '2026-08-16T00:00:00Z' } });
    const dropped = { shows: [{ show: { title: 'A Show', ids: { simkl: 100 } }, status: 'dropped' }] };
    await withFetch(
      (url) => {
        if (url.includes('/sync/activities')) return jsonResponse(moved);
        if (url.includes('/all-items/shows/dropped')) return jsonResponse(dropped);
        throw new Error(`unexpected request: ${url}`);
      },
      async (calls) => {
        await state.refreshLibraryIfChanged();
        assert.deepEqual(lists(calls), ['shows/dropped'], 'only the destination is refetched');
      },
    );

    assert.deepEqual(state.library?.shows_watching?.shows, [], 'the stale membership goes');
    assert.equal(state.library?.shows_dropped?.shows?.length, 1, 'and the fresh one stands');
  });
});

// --- the sheet sync -------------------------------------------------------
//
// The sheet is a second consumer of the same poll. Everything here is about it
// staying out of the feed's way: no extra requests when it is off, no library
// error slot when it fails, and no effect on what /healthz says about SIMKL.

test('SHEET_ID with no credential leaves the sync off rather than half on', async () => {
  // The credentials path has a default, so testing it for truthiness would say
  // "a credential was supplied" on every machine — and file an ENOENT per poll.
  await withConfig({ sheetId: 'SID', sheetSyncMode: 'apply', googleKeyBase64: undefined, googleCredentialsExplicit: false }, async () => {
    await withToken(async (state) => {
      assert.equal(state.sheetSync, null);
      await withFetch(api(activities()), async (calls) => {
        await state.refreshLibraryIfChanged();
        assert.deepEqual(calls.filter((c) => c.includes('googleapis.com')), []);
      });
    });
  });
});

test('with the sheet unconfigured a quiet poll still costs exactly one request', async () => {
  await withToken(async (state) => {
    await prime(state);
    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(calls.length, 1);
    });
  });
});

test('a sheet failure is never filed as a library error, and the feed still renders', async () => {
  await withToken(async (state) => {
    state.calendars = emptyCalendars();
    state.calendarsFreshAt = new Date().toISOString();
    // Stands in for the real SheetSync: the wiring is what is under test.
    state.sheetSync = {
      lastRunAt: null,
      lastStatus: 'idle',
      frozen: null,
      run: async () => ({ status: 'failed' as const, edits: 0, inserts: 0, lines: [], error: 'sheets exploded', retry: true }),
    } as unknown as FeedState['sheetSync'];

    await withFetch(api(activities()), async () => {
      await state.refreshLibraryIfChanged();
    });

    assert.equal(state.errors.library, null);
    assert.equal(state.errors.sheet, 'sheets exploded');
    assert.equal(state.sheetRetryPending, true);
    assert.ok(state.renderedAt, 'the feed was rendered before the sheet was touched');
    // A frozen or failing sheet must not restart the container or fail a deploy.
    assert.equal(state.health.ok, true);
    assert.equal(state.health.sheet.configured, true);
  });
});

// The sheet is built entirely from the library, so a failed library refresh has
// nothing new for it to see. Running it anyway costs a full grid read and
// re-plan on every poll for the duration of a SIMKL outage: the quiet-poll early
// return cannot prevent that, because the throw goes straight past it.
test('a failed library refresh skips the sheet sync entirely', async () => {
  await withToken(async (state) => {
    state.calendars = emptyCalendars();
    let runs = 0;
    state.sheetSync = {
      lastRunAt: null,
      lastStatus: 'idle',
      frozen: null,
      run: async () => {
        runs += 1;
        return { status: 'idle' as const, edits: 0, inserts: 0, lines: [], error: null, retry: false };
      },
    } as unknown as FeedState['sheetSync'];

    await prime(state);
    assert.equal(runs, 1, 'a healthy poll does sync the sheet');

    await withFetch(() => new Response('upstream down', { status: 503 }), async () => {
      await state.refreshLibraryIfChanged();
    });
    assert.ok(state.errors.library, 'the poll really did fail');
    assert.equal(runs, 1, 'and the sheet was left alone');
  });
});

test('a poll that fell through only to retry the sheet does not advance librarySyncedAt', async () => {
  await withToken(async (state) => {
    state.calendars = emptyCalendars();
    state.sheetSync = {
      lastRunAt: null,
      lastStatus: 'idle',
      frozen: null,
      run: async () => ({ status: 'idle' as const, edits: 0, inserts: 0, lines: [], error: null, retry: true }),
    } as unknown as FeedState['sheetSync'];

    await prime(state);
    const synced = state.libraryAt;
    assert.ok(synced);

    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(calls.length, 1, 'nothing was refetched');
    });
    // librarySyncedAt means "SIMKL lists were resynced", and none were.
    assert.equal(state.libraryAt, synced);
  });
});
