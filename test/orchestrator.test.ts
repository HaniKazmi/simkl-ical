import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../src/shared/config.ts';
import { Orchestrator } from '../src/orchestrator.ts';
import { emptyCalendars, jsonResponse, libraryOf, paramsOf, quiet, recorder, withConfig, withFetch, withTempDataDir } from './helpers.ts';
import { nowIso, plainDateIn } from '../src/shared/dates.ts';

const T = '2026-08-15T12:00:00Z';

/** A full activities payload; pass overrides to move individual timestamps. */
const activities = (over: Record<string, Record<string, string>> = {}, all = T) => ({
  all,
  tv_shows: { watching: T, plantowatch: T, completed: T, removed_from_list: T, ...over.tv_shows },
  anime: { watching: T, plantowatch: T, completed: T, removed_from_list: T, ...over.anime },
  movies: { plantowatch: T, removed_from_list: T, ...over.movies },
});

const libraryBody = {
  shows: [{ show: { title: 'A Show', ids: { simkl: 100 } }, status: 'watching' }],
  movies: [{ movie: { title: 'A Film', ids: { simkl: 300 } }, status: 'plantowatch' }],
};

/** The same library in the `simkl_ids_only` shape: ids and nothing else. */
const membershipBody = { shows: [{ show: { ids: { simkl: 100 } } }], movies: [{ movie: { ids: { simkl: 300 } } }] };
/**
 * A plain date `days` from now, so a fixture can sit inside or outside the
 * horizon. In the configured zone, because that is where `filmDue` measures its
 * horizon from — a UTC date would disagree with it for a fifth of the day.
 */
const dateIn = (days: number) => plainDateIn(Temporal.Now.instant(), config.timezone).add({ days }).toString();

/** Dated soon, so it stays inside the re-read horizon whenever the suite runs. */
const movieDetail = {
  title: 'A Film',
  runtime: 120,
  release_dates: [{ iso_3166_1: 'GB', results: [{ type: 3, release_date: dateIn(10) }] }],
};

/** The same film pushed well past the horizon, where its date stops being re-read. */
const distantDetail = { ...movieDetail, release_dates: [{ iso_3166_1: 'GB', results: [{ type: 3, release_date: dateIn(300) }] }] };

/**
 * Routes the endpoint families a library refresh touches.
 *
 * `body` overrides what the library pull answers with, which is how a delta
 * carrying one changed record is distinguished from a full pull.
 */
const api =
  (
    acts: unknown,
    {
      movieStatus = 200,
      body = libraryBody,
      membership,
      detail = movieDetail,
    }: { movieStatus?: number; body?: unknown; membership?: unknown; detail?: unknown } = {},
  ) =>
  (url: string): Response => {
    if (url.includes('/sync/activities')) return jsonResponse(acts);
    if (url.includes('/sync/all-items')) {
      if (url.includes('simkl_ids_only')) return jsonResponse(membership ?? membershipBody);
      return jsonResponse(body);
    }
    if (url.includes('/movies/')) {
      return movieStatus === 200 ? jsonResponse(detail) : new Response('nope', { status: movieStatus });
    }
    throw new Error(`unexpected request: ${url}`);
  };

const withToken = (fn: (state: Orchestrator) => Promise<void>, logger: Orchestrator['log'] = quiet) =>
  withTempDataDir(async (dir) => {
    await writeFile(join(dir, 'token.json'), JSON.stringify({ access_token: 'tok' }));
    await fn(new Orchestrator({ logger }));
  });

/** Get a state to a warm, fully-synced baseline, which most tests want. */
const prime = (state: Orchestrator, acts: unknown = activities(), opts: Parameters<typeof api>[1] = {}) =>
  withFetch(api(acts, opts), () => state.refreshLibraryIfChanged());

/** Age every film stamp past the refresh floor, so the films are due again. */
const ageFilms = (state: Orchestrator) => {
  const aged = Temporal.Now.instant().subtract({ milliseconds: config.movieRefresh.total('milliseconds') + 1000 });
  for (const id of state.feed.filmStamps.keys()) state.feed.filmStamps.set(id, aged);
};

const pulls = (calls: string[]) => calls.filter((c) => c.includes('/sync/all-items'));
const deltas = (calls: string[]) => pulls(calls).filter((c) => c.includes('date_from='));
const memberships = (calls: string[]) => pulls(calls).filter((c) => c.includes('simkl_ids_only'));
const lookups = (calls: string[]) => calls.filter((c) => /\/movies\/\d/.test(c));

test('a cold start pulls the whole library in one request and resolves the films', async () => {
  await withToken(async (state) => {
    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(pulls(calls).length, 1, 'one pull, not one per list');
      assert.equal(deltas(calls).length, 0, 'and no date_from — there is no watermark yet');
      assert.equal(lookups(calls).length, 1, 'and the one film');
      assert.equal(state.library?.size, 2);
      assert.equal(state.feed.movieReleases.size, 1);
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

test('marking an episode watched asks for a delta and nothing more', async () => {
  await withToken(async (state) => {
    await prime(state);

    const moved = activities({ tv_shows: { watching: '2026-08-15T18:00:00Z' } }, '2026-08-15T18:00:00Z');
    await withFetch(api(moved, { body: {} }), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(calls.length, 2, `activities and one delta, got ${calls.join(', ')}`);
      assert.equal(deltas(calls).length, 1);
      assert.equal(lookups(calls).length, 0, 'an episode must not drag the film lookups along');
    });
  });
});

// The commonest event there is, and the one that must not cascade. The poll has
// to pull — the sheet is built from watch counts — but the feed reads membership
// and nothing else, so re-rendering on it rewrites the file for a fresh DTSTAMP
// and an identical event set, on every episode marked.
test('marking an episode watched does not re-render the feed', async () => {
  await withToken(async (state) => {
    state.feed.calendars = emptyCalendars();
    await prime(state);
    assert.ok(state.feed.renderedAt, 'precondition: a render is possible at all here');
    // A sentinel rather than the real stamp: any render replaces it, so the
    // assertion does not rest on two wall-clock reads landing a millisecond apart.
    const RENDERED = '2020-01-01T00:00:00.000Z';
    state.feed.renderedAt = RENDERED;

    // The same show, same status, one episode further on.
    const progressed = {
      shows: [
        {
          show: { title: 'A Show', ids: { simkl: 100 } },
          status: 'watching',
          watched_episodes_count: 4,
          last_watched_at: '2026-08-15T18:00:00Z',
        },
      ],
    };
    const moved = activities({ tv_shows: { watching: '2026-08-15T18:00:00Z' } }, '2026-08-15T18:00:00Z');
    await withFetch(api(moved, { body: progressed }), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(deltas(calls).length, 1, 'the delta is still pulled — the sheet needs it');
      assert.equal(lookups(calls).length, 0, 'and no film is re-read either');
    });

    assert.equal(state.library?.get(100)?.item.watched_episodes_count, 4, 'the library did take the update');
    assert.equal(state.feed.renderedAt, RENDERED, 'but the feed was left alone');
  });
});

// The counterpart, so the guard cannot be satisfied by never rendering at all.
test('dropping a show does re-render the feed', async () => {
  await withToken(async (state) => {
    state.feed.calendars = emptyCalendars();
    await prime(state);
    assert.ok(state.feed.renderedAt, 'precondition: a render is possible at all here');
    const RENDERED = '2020-01-01T00:00:00.000Z';
    state.feed.renderedAt = RENDERED;

    const dropped = { shows: [{ show: { title: 'A Show', ids: { simkl: 100 } }, status: 'dropped' }] };
    const moved = activities({ tv_shows: { dropped: '2026-08-15T18:00:00Z' } }, '2026-08-15T18:00:00Z');
    await withFetch(api(moved, { body: dropped }), () => state.refreshLibraryIfChanged());

    assert.notEqual(state.feed.renderedAt, RENDERED, 'membership moved, so the feed must be rebuilt');
  });
});

// The watermark goes out exactly as SIMKL gave it, less one second: date_from
// is compared strictly greater, so passing back the timestamp verbatim asks for
// nothing and a change landing in that same second is never seen again.
test('the delta asks from one second behind the watermark', async () => {
  await withToken(async (state) => {
    await prime(state);
    assert.equal(state.syncedAll, T);

    const moved = activities({ tv_shows: { watching: '2026-08-15T18:00:00Z' } }, '2026-08-15T18:00:00Z');
    await withFetch(api(moved, { body: {} }), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(paramsOf(deltas(calls)[0]!).get('date_from'), '2026-08-15T11:59:59Z');
    });
    assert.equal(state.syncedAll, '2026-08-15T18:00:00Z', 'and then advances');
  });
});

// A brand-new SIMKL account reports `null` for every activity timestamp,
// including the top-level one. Storing that as the watermark would leave `full`
// true — it is partly `!syncedAll` — so every poll would pull the whole library
// forever, which is the burst answered with `401 user_token_failed`.
test('a missing activities.all does not make every poll a full pull', async () => {
  await withToken(async (state) => {
    const undated = { ...activities(), all: undefined };
    await withFetch(api(undated), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(pulls(calls).length, 1, 'the cold start still pulls');
    });
    assert.ok(state.syncedAll, 'and it leaves a watermark behind rather than null');

    await withFetch(api(undated), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(pulls(calls).length, 0, 'so the next poll is quiet, not another full pull');
    });
  });
});

// The reason the trigger is the status signature rather than activities.all,
// which rolls playback up with everything else.
test('a scrobble moves activities.all and still pulls nothing', async () => {
  await withToken(async (state) => {
    await prime(state);

    const scrobbled = activities({ tv_shows: { playback: '2026-08-15T18:00:00Z' } });
    await withFetch(api({ ...scrobbled, all: '2026-08-15T18:00:00Z' }), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(calls.length, 1, `expected only /sync/activities, got ${calls.join(', ')}`);
    });
  });
});

// A removal is in no delta: it moves removed_from_list and nothing else, so the
// membership set is the only way to learn what went.
test('a removal costs one extra request and drops the title', async () => {
  await withToken(async (state) => {
    // Two films, so dropping one is a proportion the guard lets through.
    const twoFilms = {
      ...libraryBody,
      movies: [...libraryBody.movies, { movie: { title: 'Another Film', ids: { simkl: 301 } }, status: 'plantowatch' }],
    };
    await withFetch(api(activities(), { body: twoFilms }), () => state.refreshLibraryIfChanged());
    assert.equal(state.library?.size, 3);

    const removed = activities({ movies: { removed_from_list: '2026-08-15T18:00:00Z' } });
    const membership = { shows: [{ show: { ids: { simkl: 100 } } }], movies: [{ movie: { ids: { simkl: 300 } } }] };
    await withFetch(api(removed, { membership }), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(calls.length, 2, `activities and one membership pull, got ${calls.join(', ')}`);
      assert.equal(memberships(calls).length, 1);
    });
    assert.deepEqual([...(state.library?.keys() ?? [])].sort((a, b) => a - b), [100, 300], 'the removed film is gone');
  });
});

// A category omitted from the payload is the same bytes whether SIMKL truncated
// it or the user emptied it, so a category that reported no removal is never
// deleted from — however much of it the response failed to mention.
test('a category that reported no removal survives being absent from the membership set', async () => {
  await withToken(async (state) => {
    await prime(state);
    assert.equal(state.library?.size, 2);

    // Only shows reported a removal; the payload omits movies entirely.
    const removed = activities({ tv_shows: { removed_from_list: '2026-08-15T18:00:00Z' } });
    const truncated = { shows: [{ show: { ids: { simkl: 100 } } }] };
    await withFetch(api(removed, { membership: truncated }), () => state.refreshLibraryIfChanged());

    assert.deepEqual([...(state.library?.keys() ?? [])].sort((a, b) => a - b), [100, 300], 'the film is untouched');
  });
});

// A truncated response is indistinguishable from a cleared account, and
// applying one empties the feed.
// The response is genuinely ambiguous: a category the user emptied and one the
// payload lost are the same bytes. So the diff is refused and the question is
// escalated to the one source that can answer it, rather than re-asked forever.
test('a membership response that would empty a category re-pulls the whole library', async () => {
  await withToken(async (state) => {
    await prime(state);

    const removed = activities({ movies: { removed_from_list: '2026-08-15T18:00:00Z' } });
    await withFetch(api(removed, { membership: {} }), () => state.refreshLibraryIfChanged());
    assert.equal(state.library?.size, 2, 'nothing dropped on the strength of it');

    await withFetch(api(removed), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(pulls(calls).length, 1, 'the next poll pulls');
      assert.equal(deltas(calls).length, 0, 'and pulls whole, not a delta');
      assert.equal(memberships(calls).length, 0, 'so the unanswerable question is not re-asked');
    });
  });
});

// The point of escalating: a user who really did empty a category gets that
// applied, rather than the removal hanging until the process restarts.
test('a category emptied for real is settled by the re-pull', async () => {
  await withToken(async (state) => {
    await prime(state);
    assert.equal(state.library?.size, 2);

    const removed = activities({ movies: { removed_from_list: '2026-08-15T18:00:00Z' } });
    await withFetch(api(removed, { membership: {} }), () => state.refreshLibraryIfChanged());

    // The full pull is authoritative, and it says the film is gone.
    const withoutFilm = { shows: libraryBody.shows };
    await withFetch(api(removed, { body: withoutFilm }), () => state.refreshLibraryIfChanged());

    assert.deepEqual([...(state.library?.keys() ?? [])], [100], 'the film is gone, without a restart');
    assert.equal(state.resyncPending, false, 'and the debt is cleared');
  });
});

// The film that arrived has no date yet; the one already resolved answers the
// same thing it did a moment ago, so asking again is a wasted request.
test('a new film is looked up and the films already resolved are not', async () => {
  await withToken(async (state) => {
    await prime(state);

    const moved = activities({ movies: { plantowatch: '2026-08-15T18:00:00Z' } }, '2026-08-15T18:00:00Z');
    const arrived = { movies: [{ movie: { title: 'New Film', ids: { simkl: 301 } }, status: 'plantowatch' }] };
    await withFetch(api(moved, { body: arrived }), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(deltas(calls).length, 1);
      assert.deepEqual(lookups(calls).map((c) => c.split('/movies/')[1]!.split('?')[0]), ['301']);
    });
  });
});

// A release date only firms up as it approaches, so re-reading one dated most
// of a year out costs a request per film per day to learn nothing.
test('a film dated beyond the horizon is not re-read once its date is known', async () => {
  await withToken(async (state) => {
    await prime(state, activities(), { detail: distantDetail });
    ageFilms(state);

    await withFetch(api(activities(), { detail: distantDetail }), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(calls.length, 1, `expected only /sync/activities, got ${calls.join(', ')}`);
    });
    assert.equal(state.feed.movieReleases.size, 1, 'and its date is still held');
  });
});

// A delta carries only what changed, so anything it does not mention has to
// survive it.
test('a delta merges into what is held rather than replacing it', async () => {
  await withToken(async (state) => {
    await prime(state);
    assert.deepEqual([...(state.library?.keys() ?? [])].sort((a, b) => a - b), [100, 300]);

    const moved = activities({ tv_shows: { watching: '2026-08-15T18:00:00Z' } }, '2026-08-15T18:00:00Z');
    const delta = { shows: [{ show: { title: 'A Show', ids: { simkl: 100 } }, status: 'dropped' }] };
    await withFetch(api(moved, { body: delta }), () => state.refreshLibraryIfChanged());

    assert.deepEqual([...(state.library?.keys() ?? [])].sort((a, b) => a - b), [100, 300], 'the film survives');
    assert.equal(state.library?.get(100)?.item.status, 'dropped', 'and the show moved');
  });
});

// A retryable failure leaves the id unstamped, and an unstamped id is due — so
// the retry needs no flag of its own.
test('a transient film failure is retried on the next poll', async () => {
  await withToken(async (state) => {
    await prime(state, activities(), { movieStatus: 500 });

    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(pulls(calls).length, 0, 'nothing moved, so no library pull');
      assert.equal(lookups(calls).length, 1, 'but the film is re-asked');
    });

    // And once it answers, the floor holds it until it ages out again.
    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(lookups(calls).length, 0, 'the resolved film is not re-asked');
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

    ageFilms(state);
    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(pulls(calls).length, 0, 'nothing moved, so no library pull');
      assert.equal(lookups(calls).length, 1, 'but the dates are re-read');
    });
  });
});

test('force pulls the whole library regardless of the signatures', async () => {
  await withToken(async (state) => {
    await prime(state);
    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged({ force: true });
      assert.equal(pulls(calls).length, 1);
      assert.equal(deltas(calls).length, 0, 'a forced pull is whole, not a delta');
      assert.equal(memberships(calls).length, 0, 'and a full pull is itself the membership set');
    });
  });
});

// --- failure modes --------------------------------------------------------

test('no token is reported without touching the network', async () => {
  await withTempDataDir(async () => {
    const state = new Orchestrator({ logger: quiet });
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
    const good = state.feed.ics;

    await withFetch(
      () => new Response('unauthorized', { status: 401 }),
      async () => {
        await state.refreshLibraryIfChanged();
      },
    );

    assert.match(state.errors.library!, /rejected the token/);
    assert.equal(state.feed.ics, good, 'the feed must survive a revoked token');
    assert.ok(
      log.lines.some((l) => l.includes('npm run login -- --force')),
      log.lines.join('\n'),
    );
  }, log);
});

test('a successful poll clears an earlier library failure', async () => {
  await withToken(async (state) => {
    state.errors.library = 'something old';
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

    ageFilms(state);

    await withFetch(api(activities(), { movieStatus: 500 }), async (calls) => {
      await state.refreshLibraryIfChanged();
      // A 500 is retryable, so apiGet spends all five attempts; what matters is
      // that the re-read happened at all.
      assert.ok(lookups(calls).length >= 1, 'the re-read was attempted');
    });
    // The stamp is not refreshed, so the film stays past the floor and due.
    assert.ok(
      Temporal.Now.instant().epochMilliseconds - state.feed.filmStamps.get(300)!.epochMilliseconds > config.movieRefresh.total('milliseconds'),
      'a failed round must not count as resolved',
    );

    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(lookups(calls).length, 1, 'so the very next poll tries again');
    });
  });
});

test('a successful re-read resets the floor', async () => {
  await withToken(async (state) => {
    await prime(state);
    ageFilms(state);

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
    assert.equal(state.feed.movieReleases.size, 1, 'precondition');

    ageFilms(state);
    await prime(state, activities(), { movieStatus: 429 });

    assert.equal(state.feed.movieReleases.size, 1, 'the known date is kept, not dropped');
    await withFetch(api(activities()), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(lookups(calls).length, 1, 'and it is retried promptly');
    });
  });
});

// An auth failure during film lookups must surface as one, not be filed
// against individual films.
test('a revoked token during film lookups is reported as a library failure', async () => {
  await withToken(async (state) => {
    await withFetch(
      (url) => (url.includes('/movies/') && !url.includes('all-items') ? new Response('nope', { status: 401 }) : api(activities())(url)),
      async () => {
        await state.refreshLibraryIfChanged();
      },
    );
    assert.match(state.errors.library!, /rejected the token/);
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
    state.feed.calendars = emptyCalendars();
    state.feed.calendarsFreshAt = nowIso();
    // Stands in for the real SheetSync: the wiring is what is under test.
    state.sheetSync = {
      lastRunAt: null,
      lastStatus: 'idle',
      frozen: null,
      run: async () => ({ status: 'failed' as const, edits: 0, inserts: 0, lines: [], error: 'sheets exploded', retry: true }),
    } as unknown as Orchestrator['sheetSync'];

    await withFetch(api(activities()), async () => {
      await state.refreshLibraryIfChanged();
    });

    assert.equal(state.errors.library, null);
    assert.equal(state.errors.sheet, 'sheets exploded');
    assert.equal(state.sheetRetryPending, true);
    assert.ok(state.feed.renderedAt, 'the feed was rendered before the sheet was touched');
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
    state.feed.calendars = emptyCalendars();
    let runs = 0;
    state.sheetSync = {
      lastRunAt: null,
      lastStatus: 'idle',
      frozen: null,
      run: async () => {
        runs += 1;
        return { status: 'idle' as const, edits: 0, inserts: 0, lines: [], error: null, retry: false };
      },
    } as unknown as Orchestrator['sheetSync'];

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
    state.feed.calendars = emptyCalendars();
    state.sheetSync = {
      lastRunAt: null,
      lastStatus: 'idle',
      frozen: null,
      run: async () => ({ status: 'idle' as const, edits: 0, inserts: 0, lines: [], error: null, retry: true }),
    } as unknown as Orchestrator['sheetSync'];

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

// --- the two timers overlap ------------------------------------------------

// The calendar fetch is several MB and takes seconds to minutes; the library
// poll runs on its own timer throughout, and `schedule` gives each its own
// running flag. A render carrying a library read *before* the fetch is queued
// when the fetch finishes — so it lands after the poll's own render and
// overwrites it, and stands until the next calendar refresh six hours later.
//
// The library also changes identity mid-poll: the merge and the removal diff
// each return a new Map. A capture taken before the fetch therefore renders a
// library the poll has already replaced.
test('a calendar refresh renders the library as it is when the fetch finishes', async () => {
  await withToken(async (state) => {
    const airing = {
      simkl_id: 100,
      date: nowIso(),
      finale_type: null,
      episode: { season: 1, episode: 1, title: 'Ep 1', url: 'https://simkl.com/tv/100/' },
    };
    // Empty, so this library joins to zero events.
    state.library = new Map();

    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    await withFetch(
      async (url) => {
        if (!url.includes('data.simkl.in')) throw new Error(`unexpected request: ${url}`);
        await held;
        return jsonResponse({ calendar: [airing], metadata: { 100: { title: 'A Show' } } });
      },
      async () => {
        const inFlight = state.refreshCalendars();
        // The poll lands mid-fetch and replaces the library, as it does on
        // every merge.
        state.library = libraryOf({ id: 100, title: 'A Show' });
        release();
        await inFlight;
      },
    );

    assert.equal(state.feed.events.length, 1, 'the render must use the library the poll left, not the one the fetch started with');
  });
});

// The trap this field exists to avoid. A quiet poll returns early, so a gate
// recorded after that return would leave the page able to show only gates where
// something moved — backwards, since nothing moving is the healthy steady state
// and the line an operator most wants to see.
test('a quiet poll still records a gate, with nothing in it', async () => {
  await withToken(async (state) => {
    const acts = activities();
    await withFetch(api(acts), () => state.refreshLibraryIfChanged());

    await withFetch(api(acts), async (calls) => {
      await state.refreshLibraryIfChanged();
      assert.equal(calls.length, 1, 'still exactly one request');
      assert.partialDeepStrictEqual(state.lastPoll, { changed: false, pull: 'none', removalsChecked: false, updated: 0, reshaped: 0, removed: 0 });
    });
  });
});

// On a cold start the signature differs from the absent one it is compared
// against, so the change is real and the pull is whole.
test('a cold start reports a changed gate and a full pull', async () => {
  await withToken(async (state) => {
    await withFetch(api(activities()), async () => {
      await state.refreshLibraryIfChanged();
      assert.equal(state.lastPoll?.changed, true);
      assert.equal(state.lastPoll?.pull, 'full');
      assert.equal(state.lastPoll?.updated, 2);
    });
  });
});

// The case `changed` and `pull` exist separately for: a forced poll pulls
// everything while the gate itself says nothing moved, so collapsing them into
// one field would report a change that did not happen.
test('a forced poll pulls whole while the gate reports nothing moved', async () => {
  await withToken(async (state) => {
    await prime(state);
    await withFetch(api(activities()), async () => {
      await state.refreshLibraryIfChanged({ force: true });
      assert.equal(state.lastPoll?.changed, false, 'the signature still matches');
      assert.equal(state.lastPoll?.pull, 'full', 'and yet the whole library was pulled');
    });
  });
});

test('a gate that moved reports what the delta carried', async () => {
  await withToken(async (state) => {
    await prime(state);
    const moved = activities({ tv_shows: { watching: '2026-08-15T18:00:00Z' } }, '2026-08-15T18:00:00Z');
    const delta = { shows: [{ show: { title: 'A Show', ids: { simkl: 100 } }, status: 'watching' }] };
    await withFetch(api(moved, { body: delta }), async () => {
      await state.refreshLibraryIfChanged();
      assert.partialDeepStrictEqual(state.lastPoll, { changed: true, pull: 'delta', removalsChecked: false, updated: 1, reshaped: 0, removed: 0 });
    });
  });
});

// A poll that never reached the gate has nothing to report about it, which is
// not the same as reporting that nothing moved.
test('a failed poll leaves the previous gate standing', async () => {
  await withToken(async (state) => {
    await prime(state);
    const before = state.lastPoll;
    await withFetch(() => new Response('nope', { status: 500 }), async () => {
      await state.refreshLibraryIfChanged();
    });
    assert.deepEqual(state.lastPoll, before);
    assert.ok(state.errors.library, 'and the failure is reported');
  });
});

// --- what the status page is told about movement ---------------------------

// The commonest poll there is. It updates a record and moves no count, and the
// page has to be able to say so — that distinction is the one the render gate
// keys on, and until now it existed only inside the poll.
test('watching an episode reports records updated and no count movement', async () => {
  await withToken(async (state) => {
    await prime(state);

    const moved = activities({ tv_shows: { watching: '2026-08-15T18:00:00Z' } }, '2026-08-15T18:00:00Z');
    const progressed = {
      shows: [{ show: { title: 'A Show', ids: { simkl: 100 } }, status: 'watching', watched_episodes_count: 4 }],
    };
    await withFetch(api(moved, { body: progressed }), () => state.refreshLibraryIfChanged());

    assert.deepEqual(state.lastMovement?.deltas, [], 'nothing changed status');
    assert.equal(state.lastMovement?.updated, 1, 'but a record did arrive');
  });
});

test('a show moving status reports the pair of counts shifting', async () => {
  await withToken(async (state) => {
    await prime(state);

    const moved = activities({ tv_shows: { completed: '2026-08-15T18:00:00Z' } }, '2026-08-15T18:00:00Z');
    const finished = { shows: [{ show: { title: 'A Show', ids: { simkl: 100 } }, status: 'completed' }] };
    await withFetch(api(moved, { body: finished }), () => state.refreshLibraryIfChanged());

    assert.deepEqual(state.lastMovement?.deltas, [
      { type: 'shows', status: 'watching', delta: -1 },
      { type: 'shows', status: 'completed', delta: 1 },
    ]);
  });
});

// A page that blanks every half hour tells a reader less than one still showing
// the last thing that happened.
test('a quiet poll leaves the previous movement standing', async () => {
  await withToken(async (state) => {
    await prime(state);
    const moved = activities({ tv_shows: { completed: '2026-08-15T18:00:00Z' } }, '2026-08-15T18:00:00Z');
    await withFetch(api(moved, { body: { shows: [{ show: { title: 'A Show', ids: { simkl: 100 } }, status: 'completed' }] } }), () =>
      state.refreshLibraryIfChanged(),
    );
    const after = state.lastMovement;
    assert.ok(after);

    await withFetch(api(moved), () => state.refreshLibraryIfChanged());
    assert.equal(state.lastMovement, after, 'the same record, not a blank one');
  });
});

// A cold start loaded the library rather than moving it, and reporting 741
// counts arriving from zero is true while saying nothing about movement.
test('a first load reports its size but not as movement', async () => {
  await withToken(async (state) => {
    await withFetch(api(activities()), () => state.refreshLibraryIfChanged());
    assert.deepEqual(state.lastMovement?.deltas, [], 'nothing moved; it arrived');
    assert.equal(state.lastMovement?.updated, 2, 'and the size is still reported');
  });
});
