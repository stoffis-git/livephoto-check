// Motion indices for Live Photo wallpapers.
//
// Format correctness (see check.js) is necessary but not sufficient: a file can
// carry every required field and still refuse to animate, because the *content*
// moves too much. These two indices measure that, and deliberately produce a
// rating rather than a verdict — iOS is the only thing that decides, and any
// tool claiming otherwise will be wrong often enough to lose trust.
//
// Both work on downscaled grayscale frames, so they are cheap and stable
// against encoder noise. Pure functions over Uint8Array: no I/O, no deps.

/** Absolute per-pixel differences between two equal-length frames. */
function diff(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.abs(a[i] - b[i]);
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

// Below this, a pixel "change" is encoder noise rather than real movement.
const NOISE_FLOOR = 8;
// Outer band of the frame, as a fraction of width/height. Motion that reaches
// the frame edge is the pattern our own motion notes flag as risky, because it
// reads as the whole scene sliding rather than a subject moving within it.
const EDGE_BAND = 0.15;

/**
 * @param {Uint8Array[]} frames  grayscale, all width*height bytes
 * @param {{width:number,height:number}} size
 */
export function computeIndices(frames, { width, height }) {
  if (frames.length < 2) throw new Error('need at least two frames');

  const edgeX = Math.max(1, Math.round(width * EDGE_BAND));
  const edgeY = Math.max(1, Math.round(height * EDGE_BAND));
  const isEdge = (i) => {
    const x = i % width, y = (i / width) | 0;
    return x < edgeX || x >= width - edgeX || y < edgeY || y >= height - edgeY;
  };

  const pairs = [];
  for (let f = 1; f < frames.length; f++) {
    const d = diff(frames[f - 1], frames[f]);

    const sorted = Uint8Array.from(d).sort();
    const median = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);

    let sum = 0, changed = 0, changedEdge = 0, edgeTotal = 0;
    for (let i = 0; i < d.length; i++) {
      sum += d[i];
      const edge = isEdge(i);
      if (edge) edgeTotal++;
      if (d[i] > NOISE_FLOOR) { changed++; if (edge) changedEdge++; }
    }

    pairs.push({
      mean: sum / d.length,
      median,                       // whole-frame shift => camera movement
      spread: Math.max(0, p95 - median), // concentrated change => subject movement
      areaPct: (changed / d.length) * 100,
      // >1 means motion is over-represented at the frame edges.
      edgeRatio: changed === 0 ? 0 : (changedEdge / changed) / (edgeTotal / d.length),
    });
  }

  const avg = (k) => pairs.reduce((s, p) => s + p[k], 0) / pairs.length;
  const peak = (k) => Math.max(...pairs.map((p) => p[k]));

  // Fixed, documented transforms so a score means the same thing forever.
  // An average luma change of 32 levels per pixel is treated as full scale.
  const clamp = (n) => Math.max(0, Math.min(100, n));
  const mvi = clamp((avg('mean') / 32) * 100);
  const msi = clamp(avg('areaPct'));

  return {
    mvi: {
      score: +mvi.toFixed(2),
      global: +avg('median').toFixed(2), // camera shake component
      local: +avg('spread').toFixed(2),  // subject motion component
      peak: +((peak('mean') / 32) * 100).toFixed(2),
    },
    msi: {
      score: +msi.toFixed(2),
      peakArea: +peak('areaPct').toFixed(2),
      edgeRatio: +avg('edgeRatio').toFixed(2),
    },
    frames: frames.length,
  };
}

/**
 * Compare measurements against a calibration set built from files we have
 * actually watched animate on a device. Returns a band plus the plain-English
 * reason, and never asserts what iOS will do.
 */
export function grade(indices, calibration) {
  if (!calibration) return { band: null, reason: 'No calibration data available.' };
  const { mviMax, msiMax } = calibration;
  const reasons = [];
  if (indices.mvi.score > mviMax) reasons.push('more overall movement');
  if (indices.msi.score > msiMax) reasons.push('a larger moving area');
  if (indices.msi.edgeRatio > 1.25) reasons.push('movement reaching the frame edges');

  if (reasons.length === 0) {
    return { band: 'A', reason: 'Within the range of every file we have confirmed animating on a device.' };
  }
  if (reasons.length === 1) {
    return { band: 'B', reason: `Borderline: ${reasons[0]} than anything in our confirmed set.` };
  }
  return { band: 'C', reason: `Beyond our confirmed set on ${reasons.length} counts: ${reasons.join(', ')}.` };
}
