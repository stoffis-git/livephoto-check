// Minimal ISO base media file format (ISO/IEC 14496-12) box walker.
// MOV, MP4 and HEIC all use this container, so one walker serves all three.
// No dependencies and no Node built-ins: the same code runs in a browser.

/** A parsed box header plus the byte range of its payload. */
export class Box {
  constructor(type, start, payloadStart, end, view) {
    this.type = type;
    this.start = start;              // first byte of the box, including its header
    this.payloadStart = payloadStart; // first byte after the header
    this.end = end;                   // one past the last byte of the box
    this.view = view;
  }

  get payloadLength() {
    return this.end - this.payloadStart;
  }

  /** Payload bytes, copied out. */
  bytes() {
    return new Uint8Array(this.view.buffer, this.view.byteOffset + this.payloadStart, this.payloadLength);
  }

  /** Direct children, assuming this box is a pure container. */
  children() {
    return [...walk(this.view, this.payloadStart, this.end)];
  }
}

const ascii = (view, off) =>
  String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));

/**
 * Yield each box between `start` and `end`. Handles both the 32-bit size field
 * and the 64-bit `largesize` escape (size === 1), plus size === 0 meaning
 * "runs to the end of the file".
 */
export function* walk(view, start = 0, end = view.byteLength) {
  let off = start;
  while (off + 8 <= end) {
    let size = view.getUint32(off);
    const type = ascii(view, off + 4);
    let payloadStart = off + 8;

    if (size === 1) {
      // 64-bit size. JS numbers hold this safely for any real file.
      const hi = view.getUint32(off + 8);
      const lo = view.getUint32(off + 12);
      size = hi * 2 ** 32 + lo;
      payloadStart = off + 16;
    } else if (size === 0) {
      size = end - off;
    }

    const boxEnd = off + size;
    // A malformed or truncated box would otherwise send us into an infinite
    // loop or past the buffer; stop cleanly instead.
    if (size < 8 || boxEnd > end) return;

    yield new Box(type, off, payloadStart, boxEnd, view);
    off = boxEnd;
  }
}

/**
 * Find boxes by a slash-separated path, e.g. "moov/trak/mdia".
 * Returns every box matching the full path.
 */
export function findAll(view, path, start = 0, end = view.byteLength) {
  const [head, ...rest] = path.split('/');
  const out = [];
  for (const box of walk(view, start, end)) {
    if (box.type !== head) continue;
    if (rest.length === 0) out.push(box);
    else out.push(...findAll(view, rest.join('/'), box.payloadStart, box.end));
  }
  return out;
}

/** First box matching a path, or null. */
export function find(view, path, start = 0, end = view.byteLength) {
  return findAll(view, path, start, end)[0] ?? null;
}

/**
 * QuickTime writes `meta` as a plain container while ISO-BMFF writes it as a
 * FullBox with a 4-byte version/flags prefix. Sniff which one we have by
 * checking whether a plausible box header sits at offset 0 or offset 4.
 */
export function metaPayloadStart(view, meta) {
  const looksLikeBox = (off) => {
    if (off + 8 > meta.end) return false;
    const size = view.getUint32(off);
    if (size < 8 || off + size > meta.end) return false;
    // Box types are four printable ASCII characters.
    for (let i = 4; i < 8; i++) {
      const c = view.getUint8(off + i);
      if (c < 0x20 || c > 0x7e) return false;
    }
    return true;
  };
  if (looksLikeBox(meta.payloadStart)) return meta.payloadStart;
  if (looksLikeBox(meta.payloadStart + 4)) return meta.payloadStart + 4;
  return meta.payloadStart;
}

export const utf8 = (bytes) => new TextDecoder('utf-8').decode(bytes);
