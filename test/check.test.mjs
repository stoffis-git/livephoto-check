// Regression tests against the device-validated corpus.
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkLivePhoto, FAIL } from '../src/check.js';

const SPIKE = new URL('../../livephoto-spike/', import.meta.url).pathname;
const load = (p) => { const b = readFileSync(SPIKE + p); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); };
const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c.status]));

test('device-validated eligible pair passes every check', () => {
  const r = checkLivePhoto(load('validated-pair/wallpaper.mov'), load('validated-pair/wallpaper.HEIC'));
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => c.status === FAIL), null, 2));
  assert.equal(byId(r)['vitality'], 'pass');
  assert.equal(byId(r)['asset-identifier'], 'pass');
});

test('raw unprocessed video fails on the identifying metadata', () => {
  const r = checkLivePhoto(load('goLive/input/input.mov'));
  const s = byId(r);
  assert.equal(r.ok, false);
  assert.equal(s['content-identifier'], FAIL);
  assert.equal(s['still-image-time'], FAIL);
  assert.equal(s['vitality'], FAIL);
});

test('the superseded live-photo-info atom is absent even from eligible files', async () => {
  // Guards the correction in the spec: if a future iOS starts writing this
  // field, this test fails and we revisit the checker.
  const { readMetadata } = await import('../src/mov.js');
  const b = load('validated-pair/wallpaper.mov');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  assert.ok(!('com.apple.quicktime.live-photo-info' in readMetadata(v)));
});

test('motion indices separate camera movement from subject movement', async () => {
  const { computeIndices } = await import('../src/motion.js');
  const W = 32, H = 32, N = W * H;
  const flat = (v) => Uint8Array.from({ length: N }, () => v);

  // A uniform brightness shift stands in for the whole frame moving: it should
  // register as global, not local.
  const global = computeIndices([flat(100), flat(120)], { width: W, height: H });
  assert.ok(global.mvi.global > global.mvi.local, 'whole-frame change should read as global');

  // A change confined to a small block is subject motion: high spread, low median.
  const patch = flat(100);
  for (let y = 12; y < 20; y++) for (let x = 12; x < 20; x++) patch[y * W + x] = 200;
  const local = computeIndices([flat(100), patch], { width: W, height: H });
  assert.equal(local.mvi.global, 0, 'localised change should leave the median untouched');
  assert.ok(local.mvi.local > 0, 'localised change should show as spread');
  assert.ok(local.msi.score > 0 && local.msi.score < 20, 'moving area should be small');
});

test('an iOS-transcoded JPEG is reported as a copy, not as a broken pairing', () => {
  // Device-verified on iOS 26.6: a file input hands over a flattened JPEG.
  // Calling that "pairing lost" would tell someone their good photo is broken.
  const jpeg = new Uint8Array(64);
  jpeg.set([0xFF, 0xD8, 0xFF, 0xE0], 0);
  jpeg.set([0x4A, 0x46, 0x49, 0x46], 6); // 'JFIF'
  const r = checkLivePhoto(null, jpeg);
  assert.equal(r.transcoded, true);
  assert.equal(r.checks[0].id, 'transcoded');
  assert.notEqual(r.checks[0].status, FAIL, 'a converted copy proves nothing, so it must not read as a failure');
});
