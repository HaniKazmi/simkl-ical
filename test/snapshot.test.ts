import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.ts';
import { loadSnapshot, saveSnapshot } from '../src/snapshot.ts';
import { reconcileReleases } from '../src/sources/movies.ts';
import type { MovieRelease } from '../src/simkl/types.ts';

const withTempDataDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'simkl-ical-test-'));
  const original = config.dataDir;
  config.dataDir = dir;
  try {
    await fn(dir);
  } finally {
    config.dataDir = original;
    await rm(dir, { recursive: true, force: true });
  }
};

test('a snapshot round-trips, including the movieReleases Map', async () => {
  await withTempDataDir(async () => {
    const movieReleases = new Map<number, MovieRelease>([[300, { simkl_id: 300, title: 'A Film', date: '2026-12-18', releaseType: 3, country: 'GB', runtime: null, url: '' }]]);
    await saveSnapshot({
      library: { shows_watching: { shows: [] } },
      movieReleases,
      listSignatures: { shows_watching: 'watching=x|removed=y' },
    });

    const loaded = await loadSnapshot();
    assert.ok(loaded!.movieReleases instanceof Map, 'must come back as a Map, not an array');
    assert.equal(loaded!.movieReleases.get(300)!.title, 'A Film');
    assert.deepEqual(loaded!.listSignatures, { shows_watching: 'watching=x|removed=y' });
    assert.ok(loaded!.savedAt);
  });
});

test('a missing snapshot is null rather than an error', async () => {
  await withTempDataDir(async () => {
    assert.equal(await loadSnapshot(), null);
  });
});

test('a corrupt snapshot is null rather than an error', async () => {
  await withTempDataDir(async (dir) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'snapshot.json'), '{ this is not json');
    assert.equal(await loadSnapshot(), null);
  });
});

test('a snapshot predating per-list gating reads as fully stale', async () => {
  await withTempDataDir(async (dir) => {
    await writeFile(join(dir, 'snapshot.json'), JSON.stringify({ library: {}, savedAt: 'then' }));
    const loaded = await loadSnapshot();
    assert.deepEqual(loaded!.listSignatures, {}, 'so every list refetches');
    assert.equal(loaded!.movieReleases.size, 0);
  });
});

// --- reconcileReleases ---------------------------------------------------

const release = (id: number): MovieRelease => ({ simkl_id: id, title: `Film ${id}`, date: '2026-12-18', releaseType: 3, country: 'GB', runtime: null, url: '' });

test('all lookups resolving reports complete', () => {
  const { releases, complete } = reconcileReleases(new Map(), [1, 2], new Map([[1, release(1)], [2, release(2)]]));
  assert.equal(complete, true);
  assert.equal(releases.size, 2);
});

test('a failed lookup keeps its previous value and reports incomplete', () => {
  const previous = new Map([[1, release(1)], [2, release(2)]]);
  const { releases, complete } = reconcileReleases(previous, [1, 2], new Map([[1, release(1)]]));
  assert.equal(complete, false, 'so the list stays stale and retries');
  assert.equal(releases.size, 2, 'the unresolved film is not lost');
  assert.equal(releases.get(2)!.title, 'Film 2');
});

test('a total failure keeps everything and reports incomplete', () => {
  const previous = new Map([[1, release(1)]]);
  const { releases, complete } = reconcileReleases(previous, [1], new Map());
  assert.equal(complete, false);
  assert.equal(releases.get(1)!.title, 'Film 1');
});

test('films dropped from the list are dropped from the map', () => {
  const previous = new Map([[1, release(1)], [2, release(2)]]);
  const { releases } = reconcileReleases(previous, [1], new Map([[1, release(1)]]));
  assert.deepEqual([...releases.keys()], [1]);
});

test('an empty film list yields an empty map and counts as complete', () => {
  const { releases, complete } = reconcileReleases(new Map([[1, release(1)]]), [], new Map());
  assert.equal(releases.size, 0);
  assert.equal(complete, true);
});
