# livephoto-check

Find out why iOS won't animate your Live Photo as a Lock Screen wallpaper.

When you set a Live Photo as your wallpaper and it refuses to move, iOS tells you
nothing useful — the Live badge is greyed out, or the wallpaper just sits there.
This library reads the file and tells you exactly which requirement is missing.

```
$ livephoto-check wallpaper.mov wallpaper.HEIC

[  OK  ] Video has a content identifier
[  OK  ] Still and video identifiers match
[  OK  ] Key-frame marker present
[  OK  ] Live Photo vitality metadata present
[  OK  ] Motion sensor track present
[  OK  ] Duration is in range
[  OK  ] Video track is HEVC
Format checks passed.
iOS makes the final call: passing every check does not guarantee it will animate.
```

## A correction, and how it happened

**An earlier version of this README (v0.1.0–v0.3.1) claimed that
`com.apple.quicktime.live-photo-info` is absent from working Live Photos and
that the widely repeated advice about it is wrong. That claim was mistaken and
has been withdrawn.**

The atom is present. It is not a single metadata value in `moov/meta`, which is
where the first version of this parser looked — it is a **timed metadata
track**: a `trak` whose sample description declares the key
`com.apple.quicktime.live-photo-info` and which carries roughly one sample per
video frame. In the camera-captured file used as a fixture here, that track
holds 60 samples across a 1.08 second clip.

That structure is the point. Per-frame sensor data has to vary over time, so a
track is the natural shape for it and a static metadata field is not. A parser
that only reads `moov/meta` sees nothing and concludes absence, which is exactly
the error made here.

The received account of this field was right, and this library now checks for
it directly. The lesson worth keeping is narrower: **absence of evidence in one
container is not evidence of absence.** You can see the track yourself:

```sh
ffprobe -v error -show_streams your.mov | grep -A3 'codec_tag_string=mebx'
```

## What eligible files carry

Alongside the sensor track, Live Photos that iOS accepts as wallpaper also
carry three static fields in `moov/meta`:

| Key | Type | Observed value |
|---|---|---|
| `com.apple.quicktime.live-photo.auto` | boolean | `1` |
| `com.apple.quicktime.live-photo.vitality-score` | float32 | `1.0` |
| `com.apple.quicktime.live-photo.vitality-scoring-version` | int64 | `4` |

```sh
exiftool -G1 -a your.mov | grep -i 'live-photo'
```

## What it checks

A Live Photo is a HEIC still plus a MOV video, joined by a shared UUID. All seven
checks are reported independently, because the useful information is *which* one
is missing:

1. **`content.identifier`** on the video — the UUID half of the pairing.
2. **`assetIdentifier`** in the still — Apple MakerNote tag `0x0011`, and it must
   match the video's UUID exactly. Most non-Apple encoders drop it.
3. **`still-image-time`** — a timed metadata track marking which frame is the
   key photo. Without it iOS doesn't know where the still sits in the timeline.
4. **The vitality group** above.
5. **The `live-photo-info` timed metadata track** — per-frame motion-sensor data
   the camera records at capture. Converted and generated clips have none, which
   is why goLive transplants the track from a genuine capture.
6. **Duration** — wallpaper-eligible Live Photos run about 1–3 seconds. iOS
   plays only a short window leading into the key frame.
7. **Codec** — Apple captures Live Photos as HEVC. Other codecs are less
   reliable, and a re-encoded video track can break eligibility even when every
   metadata field is correct.

## Format is necessary, not sufficient

A file can pass all six checks and still refuse to animate, because *how much the
picture moves* also matters. Two optional measurements describe that:

**MVI — Motion Volatility Index.** How much changes between frames, split into a
**global** component (the whole frame shifting — camera movement) and a **local**
component (a subject moving inside a still frame).

**MSI — Motion Surface Index.** How much of the frame is moving, plus an **edge
ratio** flagging motion concentrated at the frame's borders.

Measured across files confirmed to animate on a device, the pattern is
consistent — and it is not "less motion":

| | range across confirmed-good files |
|---|---|
| global (camera movement) | 0.33 – 1.67 |
| local (subject movement) | 6.2 – **70.73** |
| edge ratio | 0.25 – 0.70 |

Local motion runs more than forty times higher than global. Live Photos that
work tend to have **a lot** of subject movement inside a **locked** frame, not a
little movement overall.

These produce a rating, never a verdict. iOS is the only thing that decides, and
our calibration set contains no confirmed *failures* — so the bands describe the
range we have seen work, not a measured failure threshold. A tool that claimed
otherwise would be wrong often enough to be worth less than nothing.

## Install

```sh
npm install livephoto-check      # library + CLI
```

```js
import { checkLivePhoto } from 'livephoto-check';

const { checks, ok } = checkLivePhoto(movBytes, heicBytes);
for (const c of checks) console.log(c.status, c.title, c.detail);
```

`src/` has no dependencies and uses no Node built-ins, so it runs unmodified in a
browser — you can check a file without uploading it anywhere. The motion indices
need frame data, so `bin/measure.js` shells out to ffmpeg and is Node-only.

```sh
node bin/measure.js clip.mov   # MVI / MSI as JSON
npm test
```

## Prior work

[goLive](https://github.com/code-path/goLive) (MIT) is the reference
implementation for *producing* wallpaper-eligible Live Photos, and its base-file
technique is what proved the format requirements in the first place. This
library only inspects; if you want to build one, start there.

## Licence

MIT.
