#!/usr/bin/env node
// ffmpeg front-end for the motion indices. Kept out of src/ so the library
// stays dependency-free and browser-loadable.
import { execFileSync } from 'node:child_process';
import { computeIndices, grade } from '../src/motion.js';

export const W = 96, H = 160;

export function measure(path, { width = W, height = H } = {}) {
  const raw = execFileSync('ffmpeg', [
    '-v', 'error', '-i', path,
    '-vf', `scale=${width}:${height},format=gray`,
    '-f', 'rawvideo', '-',
  ], { maxBuffer: 1 << 28 });

  const size = width * height;
  const count = Math.floor(raw.length / size);
  if (count < 2) throw new Error(`decoded ${count} frames from ${path}`);

  // Sample evenly rather than using every frame: the indices describe the shape
  // of the motion, and 16 samples capture that at a fraction of the work.
  const want = Math.min(16, count);
  const frames = [];
  for (let i = 0; i < want; i++) {
    const f = Math.round((i * (count - 1)) / (want - 1));
    frames.push(new Uint8Array(raw.buffer, raw.byteOffset + f * size, size));
  }
  return computeIndices(frames, { width, height });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: measure.js <file.mov...>'); process.exit(2); }
  for (const f of files) {
    const i = measure(f);
    console.log(JSON.stringify({ file: f, ...i, ...grade(i, null) }, null, 2));
  }
}
