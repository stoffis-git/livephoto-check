#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { checkLivePhoto, PASS, FAIL } from '../src/check.js';

const args = process.argv.slice(2).filter((a) => a !== '--json');
const asJson = process.argv.includes('--json');

if (args.length === 0) {
  console.error('usage: livephoto-check <file.mov> [file.heic] [--json]');
  process.exit(2);
}

const pick = (re) => args.find((a) => re.test(a)) ?? null;
const movPath = pick(/\.mov$/i) ?? args[0];
const heicPath = pick(/\.(heic|heif)$/i);

const load = (p) => { const b = readFileSync(p); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); };
const result = checkLivePhoto(load(movPath), heicPath ? load(heicPath) : null);

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const mark = { [PASS]: '  OK  ', [FAIL]: ' FAIL ', warn: ' WARN ' };
  console.log('');
  for (const c of result.checks) console.log(`[${mark[c.status]}] ${c.title}\n           ${c.detail}`);
  console.log(`\n${result.ok ? 'Format checks passed.' : 'Format checks failed.'}`);
  console.log('iOS makes the final call: passing every check does not guarantee it will animate.\n');
}
process.exit(result.ok ? 0 : 1);
