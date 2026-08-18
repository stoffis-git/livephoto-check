// HEIC-side inspection: the assetIdentifier that pairs the still to the video.
//
// The identifier lives in Apple's MakerNote (tag 0x0011) inside the Exif blob,
// which HEIC stores as an ISO-BMFF item. We walk: iinf (find the Exif item id)
// -> iloc (find where its bytes are) -> TIFF -> Exif IFD -> MakerNote.

import { find, walk, utf8 } from './isobmff.js';

/** Locate the Exif item's byte range via iinf + iloc. */
function exifRange(view) {
  const meta = find(view, 'meta');
  if (!meta) return null;
  // HEIC's meta is a FullBox, so children begin 4 bytes in.
  const start = meta.payloadStart + 4;

  const iinf = find(view, 'iinf', start, meta.end);
  const iloc = find(view, 'iloc', start, meta.end);
  if (!iinf || !iloc) return null;

  // Find the item whose type is 'Exif'. infe entries carry the id then the type.
  let exifId = null;
  const iinfVersion = view.getUint8(iinf.payloadStart);
  const entriesStart = iinf.payloadStart + (iinfVersion === 0 ? 6 : 8);
  for (const infe of walk(view, entriesStart, iinf.end)) {
    if (infe.type !== 'infe') continue;
    const v = view.getUint8(infe.payloadStart);
    const idOff = infe.payloadStart + 4;
    const id = v < 2 ? view.getUint16(idOff) : (v === 2 ? view.getUint16(idOff) : view.getUint32(idOff));
    const typeOff = idOff + (v === 3 ? 4 : 2) + 2;
    if (typeOff + 4 <= infe.end) {
      const t = String.fromCharCode(
        view.getUint8(typeOff), view.getUint8(typeOff + 1),
        view.getUint8(typeOff + 2), view.getUint8(typeOff + 3),
      );
      if (t === 'Exif') { exifId = id; break; }
    }
  }
  if (exifId === null) return null;

  // iloc: version(1) flags(3) then packed nibble sizes, then the item table.
  const p = iloc.payloadStart;
  const version = view.getUint8(p);
  const b4 = view.getUint8(p + 4);
  const b5 = view.getUint8(p + 5);
  const offsetSize = b4 >> 4, lengthSize = b4 & 0xf;
  const baseOffsetSize = b5 >> 4;
  const indexSize = version >= 1 ? (b5 & 0xf) : 0;

  let off = p + 6;
  const readN = (o, n) => n === 4 ? view.getUint32(o) : n === 8 ? Number(view.getBigUint64(o)) : n === 2 ? view.getUint16(o) : 0;
  const count = version < 2 ? view.getUint16(off) : view.getUint32(off);
  off += version < 2 ? 2 : 4;

  for (let i = 0; i < count && off < iloc.end; i++) {
    const id = version < 2 ? view.getUint16(off) : view.getUint32(off);
    off += version < 2 ? 2 : 4;
    if (version >= 1) off += 2; // construction_method
    off += 2;                   // data_reference_index
    const baseOffset = readN(off, baseOffsetSize); off += baseOffsetSize;
    const extentCount = view.getUint16(off); off += 2;
    for (let e = 0; e < extentCount; e++) {
      if (indexSize) off += indexSize;
      const extentOffset = readN(off, offsetSize); off += offsetSize;
      const extentLength = readN(off, lengthSize); off += lengthSize;
      if (id === exifId) return { start: baseOffset + extentOffset, length: extentLength };
    }
  }
  return null;
}

/** Parse TIFF/Exif far enough to reach Apple's MakerNote tag 0x0011. */
function assetIdFromExif(view, start, length) {
  // The Exif item begins with a 4-byte offset to the TIFF header.
  const skip = view.getUint32(start);
  let p = start + 4 + skip;
  if (p + 8 > start + length) return null;

  const le = view.getUint16(p) === 0x4949;
  const u16 = (o) => view.getUint16(o, le);
  const u32 = (o) => view.getUint32(o, le);
  const tiff = p;
  let ifd = tiff + u32(tiff + 4);

  const findTag = (ifdStart, tag) => {
    if (ifdStart + 2 > view.byteLength) return null;
    const n = u16(ifdStart);
    for (let i = 0; i < n; i++) {
      const entry = ifdStart + 2 + i * 12;
      if (entry + 12 > view.byteLength) break;
      if (u16(entry) === tag) {
        return { type: u16(entry + 2), count: u32(entry + 4), valueOffset: entry + 8 };
      }
    }
    return null;
  };

  const exifPtr = findTag(ifd, 0x8769);
  if (!exifPtr) return null;
  const exifIfd = tiff + u32(exifPtr.valueOffset);

  const makerNote = findTag(exifIfd, 0x927c);
  if (!makerNote) return null;
  const mnStart = tiff + u32(makerNote.valueOffset);

  // Apple MakerNote: "Apple iOS\0\0\x01MM" then a big-endian IFD.
  const header = utf8(new Uint8Array(view.buffer, view.byteOffset + mnStart, 10));
  if (!header.startsWith('Apple iOS')) return null;
  const mnIfd = mnStart + 14;

  const n = view.getUint16(mnIfd);
  for (let i = 0; i < n; i++) {
    const entry = mnIfd + 2 + i * 12;
    if (view.getUint16(entry) !== 0x0011) continue;
    const count = view.getUint32(entry + 4);
    const valOff = count > 4 ? mnStart + view.getUint32(entry + 8) : entry + 8;
    return utf8(new Uint8Array(view.buffer, view.byteOffset + valOff, count)).replace(/\0+$/, '');
  }
  return null;
}

/** The Live Photo assetIdentifier UUID, or null if absent/unparseable. */
export function readAssetIdentifier(view) {
  try {
    const range = exifRange(view);
    if (!range) return null;
    return assetIdFromExif(view, range.start, range.length);
  } catch {
    return null; // A malformed HEIC is a failed check, not a crash.
  }
}
