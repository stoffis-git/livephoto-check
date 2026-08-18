// MOV-side inspection: the QuickTime metadata and track structure that decide
// whether iOS treats a Live Photo as wallpaper-eligible.

import { find, findAll, walk, metaPayloadStart, utf8 } from './isobmff.js';

/**
 * Read the `moov/meta` keys+ilst pair into a plain object.
 *
 * QuickTime stores these as two parallel structures: `keys` holds the key
 * names, `ilst` holds values in boxes whose four-byte "type" is really a
 * 1-based index into that key table.
 */
export function readMetadata(view) {
  const meta = find(view, 'moov/meta');
  if (!meta) return {};

  const payloadStart = metaPayloadStart(view, meta);
  const keysBox = findAll(view, 'keys', payloadStart, meta.end)[0];
  const ilstBox = findAll(view, 'ilst', payloadStart, meta.end)[0];
  if (!keysBox || !ilstBox) return {};

  // keys: FullBox(4) + entry_count(4), then [size(4)][namespace(4)][name...]
  const keys = [];
  let off = keysBox.payloadStart + 8;
  while (off + 8 <= keysBox.end) {
    const size = view.getUint32(off);
    if (size < 8 || off + size > keysBox.end) break;
    keys.push(utf8(new Uint8Array(view.buffer, view.byteOffset + off + 8, size - 8)));
    off += size;
  }

  const out = {};
  for (const item of walk(view, ilstBox.payloadStart, ilstBox.end)) {
    // The box type is a big-endian index into `keys`, not a printable name.
    const index = view.getUint32(item.start + 4);
    const key = keys[index - 1];
    if (!key) continue;

    const data = find(view, 'data', item.payloadStart, item.end);
    if (!data) continue;

    // data payload: type_indicator(4) + locale(4) + value
    const valueStart = data.payloadStart + 8;
    const typeIndicator = view.getUint32(data.payloadStart) & 0x00ffffff;
    const raw = new Uint8Array(view.buffer, view.byteOffset + valueStart, Math.max(0, data.end - valueStart));

    // Type 1 is UTF-8; everything else we keep as bytes. live-photo-info is
    // type 0 (binary) and its packed struct is undocumented, so we only ever
    // report its presence and size.
    out[key] = { type: typeIndicator, bytes: raw, text: typeIndicator === 1 ? utf8(raw) : null };
  }
  return out;
}

/** Movie duration in seconds, from `mvhd`. */
export function readDuration(view) {
  const mvhd = find(view, 'moov/mvhd');
  if (!mvhd) return null;
  const version = view.getUint8(mvhd.payloadStart);
  let timescale, duration;
  if (version === 1) {
    timescale = view.getUint32(mvhd.payloadStart + 20);
    const hi = view.getUint32(mvhd.payloadStart + 24);
    const lo = view.getUint32(mvhd.payloadStart + 28);
    duration = hi * 2 ** 32 + lo;
  } else {
    timescale = view.getUint32(mvhd.payloadStart + 12);
    duration = view.getUint32(mvhd.payloadStart + 16);
  }
  if (!timescale) return null;
  return duration / timescale;
}

/** Handler type ('vide', 'soun', 'meta', ...) for a trak box. */
function handlerOf(view, trak) {
  const hdlr = find(view, 'mdia/hdlr', trak.payloadStart, trak.end);
  if (!hdlr) return null;
  // FullBox(4) + pre_defined(4) + handler_type(4)
  const off = hdlr.payloadStart + 8;
  return String.fromCharCode(
    view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3),
  );
}

/** Sample-entry format codes ('hvc1', 'avc1', 'mebx', ...) inside a trak. */
function sampleFormats(view, trak) {
  const stsd = find(view, 'mdia/minf/stbl/stsd', trak.payloadStart, trak.end);
  if (!stsd) return [];
  // FullBox(4) + entry_count(4), then sample entries as ordinary boxes.
  return [...walk(view, stsd.payloadStart + 8, stsd.end)].map((b) => b.type);
}

export function readTracks(view) {
  return findAll(view, 'moov/trak').map((trak) => ({
    handler: handlerOf(view, trak),
    formats: sampleFormats(view, trak),
    box: trak,
  }));
}

/**
 * The still-image-time marker lives in a timed metadata track: a 'meta'
 * handler whose sample description is 'mebx', carrying a keys table that
 * names com.apple.quicktime.still-image-time.
 */
export function hasStillImageTime(view, tracks) {
  return tracks.some((t) => {
    if (t.handler !== 'meta') return false;
    const bytes = new Uint8Array(
      view.buffer, view.byteOffset + t.box.payloadStart, t.box.end - t.box.payloadStart,
    );
    return utf8(bytes).includes('com.apple.quicktime.still-image-time');
  });
}

const HEVC = new Set(['hvc1', 'hev1']);

export function videoCodec(view, tracks) {
  const video = tracks.find((t) => t.handler === 'vide');
  if (!video) return null;
  const format = video.formats[0] ?? null;
  return { format, isHEVC: HEVC.has(format) };
}
