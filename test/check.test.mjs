// Tests split in two: the synthetic ones always run, while the corpus tests
// need real Live Photos and skip cleanly when they are absent.
//
// To run the corpus tests, drop a wallpaper-eligible pair into test/fixtures/
// as `eligible.mov` + `eligible.HEIC`, and any ordinary video as `plain.mov`.
// Fixtures are gitignored: nobody's photos ship with this library.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { checkLivePhoto, FAIL } from '../src/check.js';
import { computeIndices } from '../src/motion.js';

const dir = new URL('./fixtures/', import.meta.url).pathname;
const have = (n) => existsSync(dir + n);
const load = (n) => { const b = readFileSync(dir + n); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); };
const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
const corpus = have('eligible.mov') && have('eligible.HEIC');

test('a wallpaper-eligible pair passes every check', { skip: !corpus && 'add test/fixtures/eligible.{mov,HEIC}' }, () => {
  const r = checkLivePhoto(load('eligible.mov'), load('eligible.HEIC'));
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => c.status === FAIL), null, 2));
  assert.equal(byId(r).vitality, 'pass');
  assert.equal(byId(r)['asset-identifier'], 'pass');
});

test('an ordinary video fails on the identifying metadata', { skip: !have('plain.mov') && 'add test/fixtures/plain.mov' }, () => {
  const s = byId(checkLivePhoto(load('plain.mov')));
  assert.equal(s['content-identifier'], FAIL);
  assert.equal(s['still-image-time'], FAIL);
  assert.equal(s.vitality, FAIL);
});

test('the live-photo-info atom is absent even from eligible files', { skip: !corpus && 'add test/fixtures/eligible.mov' }, async () => {
  // Guards the claim in the README. If a future iOS starts writing this field,
  // this fails loudly rather than letting the documentation quietly go stale.
  const { readMetadata } = await import('../src/mov.js');
  const b = load('eligible.mov');
  assert.ok(!('com.apple.quicktime.live-photo-info' in readMetadata(new DataView(b.buffer, b.byteOffset, b.byteLength))));
});

test('a missing video is reported rather than thrown', () => {
  const r = checkLivePhoto(null);
  assert.equal(r.ok, false);
  assert.equal(r.checks[0].status, FAIL);
});

test('motion indices separate camera movement from subject movement', () => {
  const W = 32, H = 32, N = W * H;
  const flat = (v) => Uint8Array.from({ length: N }, () => v);

  // A uniform brightness shift stands in for the whole frame moving.
  const global = computeIndices([flat(100), flat(120)], { width: W, height: H });
  assert.ok(global.mvi.global > global.mvi.local, 'whole-frame change should read as global');

  // A change confined to a small block is subject motion.
  const patch = flat(100);
  for (let y = 12; y < 20; y++) for (let x = 12; x < 20; x++) patch[y * W + x] = 200;
  const local = computeIndices([flat(100), patch], { width: W, height: H });
  assert.equal(local.mvi.global, 0, 'localised change should leave the median untouched');
  assert.ok(local.mvi.local > 0, 'localised change should show as spread');
  assert.ok(local.msi.score > 0 && local.msi.score < 20, 'moving area should be small');
});

test('at least two frames are required', () => {
  assert.throws(() => computeIndices([new Uint8Array(4)], { width: 2, height: 2 }), /two frames/);
});
