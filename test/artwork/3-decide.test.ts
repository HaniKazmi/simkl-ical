import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCell, decideLink } from '../../src/artwork/3-decide.ts';
import { cellOf } from '../helpers.ts';

const BUCKET = 'shows-bucket';
const LINK = 'https://storage.googleapis.com/shows-bucket/Severance';

test('a cell is read as blank, formula, bucket, foreign or other', () => {
  assert.equal(classifyCell(cellOf(null), BUCKET).kind, 'blank');
  assert.equal(classifyCell(undefined, BUCKET).kind, 'blank');
  assert.deepEqual(classifyCell(cellOf({ formula: '=CONCAT($Z$2,A5)', value: LINK }), BUCKET), { kind: 'formula', url: LINK, key: 'Severance' });
  assert.deepEqual(classifyCell(cellOf({ formula: '=CONCAT($Z$2,A5)', value: 'Severance' }), BUCKET), { kind: 'formula', url: 'Severance', key: null });
  assert.deepEqual(classifyCell(cellOf(LINK), BUCKET), { kind: 'bucket', url: LINK, key: 'Severance' });
  assert.deepEqual(classifyCell(cellOf('https://image.tmdb.org/t/p/w1280/x.jpg'), BUCKET), { kind: 'foreign', url: 'https://image.tmdb.org/t/p/w1280/x.jpg', key: null });
  assert.equal(classifyCell(cellOf('https://storage.googleapis.com/other-bucket/Severance'), BUCKET).kind, 'foreign');
  assert.deepEqual(classifyCell(cellOf('TODO'), BUCKET), { kind: 'other', url: 'TODO', key: null });
  assert.equal(classifyCell(cellOf(42), BUCKET).kind, 'other');
});

// The one unconditional rule: whatever a formula resolves to, the cell is
// never written. Kept when it already links the bucket, refused otherwise.
test('a formula is never written', () => {
  const kept = decideLink(cellOf({ formula: '=CONCAT($Z$2,A5)', value: LINK }), { title: 'Severance', bucket: BUCKET, adopt: true });
  assert.deepEqual(kept, { action: 'keep', key: 'Severance', link: LINK });
  for (const value of ['Severance', 'https://image.tmdb.org/t/p/w1280/x.jpg', undefined]) {
    const decision = decideLink(cellOf({ formula: '=CONCAT($Z$2,A5)', value }), { title: 'Severance', bucket: BUCKET, adopt: true });
    assert.equal(decision.action, 'refuse');
    assert.equal(decision.action === 'refuse' && decision.reason, 'formula');
  }
});

test('a blank cell takes the static link for the title', () => {
  assert.deepEqual(decideLink(cellOf(null), { title: 'Severance', bucket: BUCKET }), { action: 'write', key: 'Severance', link: LINK });
  assert.deepEqual(decideLink(cellOf(null), { title: '3%', bucket: BUCKET }), { action: 'write', key: '3%', link: 'https://storage.googleapis.com/shows-bucket/3%25' });
});

// The cell decides the key: a hand-written link naming the object with a
// typo keeps pointing at that object.
test('a link into this bucket is kept under the key the cell names', () => {
  const typo = 'https://storage.googleapis.com/shows-bucket/Aquarian%20Evol';
  assert.deepEqual(decideLink(cellOf(typo), { title: 'Aquarion Evol', bucket: BUCKET }), { action: 'keep', key: 'Aquarian Evol', link: typo });
});

test('a link elsewhere is replaced only on adopt', () => {
  const foreign = cellOf('https://image.tmdb.org/t/p/w1280/x.jpg');
  const refused = decideLink(foreign, { title: 'Severance', bucket: BUCKET });
  assert.equal(refused.action, 'refuse');
  assert.equal(refused.action === 'refuse' && refused.reason, 'needs-adopt');
  assert.deepEqual(decideLink(foreign, { title: 'Severance', bucket: BUCKET, adopt: true }), { action: 'write', key: 'Severance', link: LINK });
});

test('text that is not a link is refused, adopt or not', () => {
  for (const adopt of [false, true]) {
    const decision = decideLink(cellOf('see notes'), { title: 'Severance', bucket: BUCKET, adopt });
    assert.equal(decision.action, 'refuse');
    assert.equal(decision.action === 'refuse' && decision.reason, 'unrecognised');
  }
});
