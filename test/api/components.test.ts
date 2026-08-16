import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every transport call names the part of the service making it.
 *
 * `component` is required by the type, so a new call site cannot omit it — but
 * nothing stops one being labelled with a copied-and-wrong value, and a label
 * that lies is worse than none. This pins the mapping that actually holds: the
 * component is a property of the *calling module*, so each module uses exactly
 * one component and it is the one its folder implies.
 */
const EXPECTED: Record<string, string> = {
  'src/api/simkl/lists.ts': 'poll',
  'src/api/simkl/auth.ts': 'login',
  'src/feed/io/calendar.ts': 'calendars',
  'src/feed/io/movies.ts': 'films',
  'src/sheet/io/catalogue.ts': 'catalogue',
  'src/sheet/io/spreadsheet.ts': 'spreadsheet',
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );

test('every call site labels itself, and no module claims two sources', () => {
  const found = new Map<string, Set<string>>();
  for (const file of walk('src')) {
    const sources = [...readFileSync(file, 'utf8').matchAll(/component: '([a-z]+)'/g)].map((m) => m[1]!);
    if (sources.length) found.set(file, new Set(sources));
  }

  for (const [file, sources] of found) {
    assert.equal(sources.size, 1, `${file} labels its calls ${[...sources].join(' and ')} — a module is one component`);
    assert.equal([...sources][0], EXPECTED[file], `${file} is labelled ${[...sources][0]}`);
  }
  // A new io/ module that starts making calls has to be added above, which is
  // the point: the mapping is checked rather than remembered.
  assert.deepEqual([...found.keys()].sort(), Object.keys(EXPECTED).sort());
});
