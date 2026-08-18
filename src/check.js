// Format eligibility checks for Live Photo wallpapers.
//
// These are the checks iOS appears to apply before it will animate a Live Photo
// on the Lock Screen. Each is reported independently: iOS gives you one opaque
// "Motion not available", so knowing *which* field is missing is the whole point.
//
// Caveat that belongs in every consumer of this module: passing every check does
// not guarantee iOS will animate the file. Format is necessary, not sufficient —
// content still matters (see the motion indices).

import { readAssetIdentifier } from './heic.js';
import { readMetadata, readDuration, readTracks, hasStillImageTime, videoCodec, livePhotoInfoTrack } from './mov.js';

const QT = 'com.apple.quicktime.';
export const PASS = 'pass', FAIL = 'fail', WARN = 'warn';

const check = (id, status, title, detail) => ({ id, status, title, detail });

/**
 * HEIC is ISO-BMFF: bytes 4-8 are 'ftyp'. A JPEG starts 0xFFD8 and has no box
 * structure at all, so this cleanly separates an original still from a copy a
 * phone transcoded on its way into the browser.
 */
function looksLikeHeic(view) {
  if (view.byteLength < 12) return false;
  const tag = String.fromCharCode(view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7));
  return tag === 'ftyp';
}

/**
 * @param {ArrayBuffer|Uint8Array|null} movBuffer
 * @param {ArrayBuffer|Uint8Array|null} heicBuffer  optional; pairing is skipped without it
 */
export function checkLivePhoto(movBuffer, heicBuffer = null) {
  const dv = (b) => b == null ? null
    : b instanceof DataView ? b
    : ArrayBuffer.isView(b) ? new DataView(b.buffer, b.byteOffset, b.byteLength)
    : new DataView(b);

  const mov = dv(movBuffer);
  const heic = dv(heicBuffer);
  const checks = [];

  // Still-only is a real case, not an error: iOS hands a web page the still
  // and keeps the video to itself, so on a phone this is all you can get.
  if (!mov) {
    if (!heic) {
      return { checks: [check('input', FAIL, 'No file supplied', 'Choose the video, the still image, or both.')], ok: false, partial: true };
    }

    // Device-verified on iOS 26.6: picking a Live Photo through a file input
    // yields a transcoded JPEG, not the original HEIC. That copy is not the
    // file iOS would use as a wallpaper, so no verdict about it is meaningful -
    // and reporting "pairing lost" for it would tell someone their perfectly
    // good photo is broken. Detect the substitution and say what happened.
    if (!looksLikeHeic(heic)) {
      return {
        partial: true,
        ok: false,
        transcoded: true,
        checks: [check('transcoded', WARN, 'This is a converted copy, not the original',
          'The file is not a HEIC, so it is not the Live Photo still that lives on the device. Picking a Live Photo from a phone hands the browser a flattened JPEG with the video half stripped, and nothing can be concluded from it either way. Use the original files instead.')],
      };
    }

    const assetId = readAssetIdentifier(heic);
    return {
      partial: true,
      ok: !!assetId,
      checks: [assetId
        ? check('asset-identifier', PASS, 'The still image is still paired', `It carries assetIdentifier ${assetId}, so it has not been stripped or re-saved. The video half is needed to check the remaining requirements.`)
        : check('asset-identifier', FAIL, 'The still image has lost its pairing', 'No assetIdentifier in the Apple MakerNote. Whatever produced this file dropped it, and without it iOS cannot match the still to any video - so it will never animate, regardless of what the video contains.')],
    };
  }

  const meta = readMetadata(mov);
  const tracks = readTracks(mov);
  const has = (k) => (QT + k) in meta;
  const text = (k) => meta[QT + k]?.text ?? null;

  // 1. content.identifier — the UUID that pairs video to still.
  const contentId = text('content.identifier');
  checks.push(contentId
    ? check('content-identifier', PASS, 'Video has a content identifier', contentId)
    : check('content-identifier', FAIL, 'Video has no content identifier',
        `The video is missing ${QT}content.identifier, so iOS cannot pair it with a still image.`));

  // 2. assetIdentifier in the HEIC, and it must match.
  if (heic) {
    const assetId = readAssetIdentifier(heic);
    if (!assetId) {
      checks.push(check('asset-identifier', FAIL, 'Still image has no asset identifier',
        'The HEIC is missing Apple MakerNote tag 17 (assetIdentifier). Most non-Apple encoders drop it.'));
    } else if (contentId && assetId !== contentId) {
      checks.push(check('asset-identifier', FAIL, 'Identifiers do not match',
        `Still says ${assetId}, video says ${contentId}. They must be identical.`));
    } else {
      checks.push(check('asset-identifier', PASS, 'Still and video identifiers match', assetId));
    }
  }

  // 3. still-image-time — marks which frame is the key photo.
  checks.push(hasStillImageTime(mov, tracks)
    ? check('still-image-time', PASS, 'Key-frame marker present',
        'A timed metadata track carries still-image-time.')
    : check('still-image-time', FAIL, 'Key-frame marker missing',
        `No timed metadata track carries ${QT}still-image-time, so iOS does not know which frame is the still.`));

  // 4. The vitality triad. Note: much published advice points at
  // com.apple.quicktime.live-photo-info instead. That field is absent from
  // every device-verified eligible file we have tested; these three are what
  // actually appear. See README.
  const triad = ['live-photo.auto', 'live-photo.vitality-score', 'live-photo.vitality-scoring-version'];
  const missing = triad.filter((k) => !has(k));
  if (missing.length === 0) {
    const scoreEntry = meta[QT + 'live-photo.vitality-score'];
    let score = null;
    if (scoreEntry?.bytes.length >= 4) {
      const b = scoreEntry.bytes;
      score = new DataView(b.buffer, b.byteOffset, b.byteLength).getFloat32(0);
    }
    checks.push(check('vitality', PASS, 'Live Photo vitality metadata present',
      score === null ? 'auto, vitality-score and scoring-version are all set.'
                     : `vitality-score = ${score.toFixed(3)}.`));
  } else {
    checks.push(check('vitality', FAIL, 'Live Photo vitality metadata missing',
      `Absent: ${missing.map((k) => QT + k).join(', ')}. Files without these are treated as an ordinary video.`));
  }

  // 5. The live-photo-info timed metadata track: per-frame motion-sensor data
  // recorded by the camera at capture. A converted or generated clip has none,
  // which is what tools like goLive work around by transplanting the track from
  // a genuine camera capture.
  const info = livePhotoInfoTrack(mov, tracks);
  checks.push(info.present
    ? check('live-photo-info', PASS, 'Motion sensor track present',
        `A timed metadata track carries ${QT}live-photo-info across ${info.samples} samples.`)
    : check('live-photo-info', FAIL, 'Motion sensor track missing',
        `No timed metadata track declares ${QT}live-photo-info. The camera records this at capture; files built from a video or generated by an app have to inherit it from a real capture.`));

  // 6. Duration. iOS animates roughly a 1-2 second clip.
  const duration = readDuration(mov);
  if (duration == null) {
    checks.push(check('duration', WARN, 'Could not read duration', 'The movie header is missing or unreadable.'));
  } else if (duration >= 1 && duration <= 3.05) {
    checks.push(check('duration', PASS, 'Duration is in range', `${duration.toFixed(2)}s.`));
  } else {
    checks.push(check('duration', WARN, 'Duration is outside the usual range',
      `${duration.toFixed(2)}s. Wallpaper-eligible Live Photos are typically 1-3s; iOS plays only a short window near the key frame.`));
  }

  // 7. Codec. A re-encoded track has been observed to break eligibility even
  // when every metadata field is correct, so this is a warning worth surfacing.
  const codec = videoCodec(mov, tracks);
  if (!codec) {
    checks.push(check('codec', FAIL, 'No video track', 'The file contains no video track.'));
  } else if (codec.isHEVC) {
    checks.push(check('codec', PASS, 'Video track is HEVC', `Sample format ${codec.format}.`));
  } else {
    checks.push(check('codec', WARN, 'Video track is not HEVC',
      `Sample format ${codec.format}. Apple captures Live Photos as HEVC; other codecs are less reliable.`));
  }

  return { checks, ok: checks.every((c) => c.status !== FAIL) };
}
