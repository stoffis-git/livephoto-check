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
[  OK  ] Duration is in range
[  OK  ] Video track is HEVC

Format checks passed.
iOS makes the final call: passing every check does not guarantee it will animate.
```

## The field everyone points at is the wrong one

Search for this problem and you will be told the answer is an undocumented
QuickTime atom called `com.apple.quicktime.live-photo-info` — the theory being
that it holds gyroscope data from the camera, and that third-party Live Photos
fail because they can't produce it.

**We checked. That atom is absent from every file we tested, including files
confirmed to animate on a real device.** It is absent from Live Photos produced
by [goLive](https://github.com/code-path/goLive), and absent from a
camera-captured pair that we verified animating on an iPhone.

What eligible files *actually* carry is a group of three fields:

| Key | Type | Observed value |
|---|---|---|
| `com.apple.quicktime.live-photo.auto` | boolean | `1` |
| `com.apple.quicktime.live-photo.vitality-score` | float32 | `1.0` |
| `com.apple.quicktime.live-photo.vitality-scoring-version` | int64 | `4` |

You can confirm this yourself in one line against any Live Photo that works:

```sh
exiftool -G1 -a your-live-photo.mov | grep -i 'live-photo'
```

We are publishing this because the wrong answer is repeated widely enough that
people give up on a fixable problem. If you find a counter-example — a file that
animates and *does* carry `live-photo-info` — please open an issue. The test
suite asserts the field's absence precisely so that a future iOS release
changing this will fail loudly rather than silently.

## What it checks

A Live Photo is a HEIC still plus a MOV video, joined by a shared UUID. All six
checks are reported independently, because the useful information is *which* one
is missing:

1. **`content.identifier`** on the video — the UUID half of the pairing.
2. **`assetIdentifier`** in the still — Apple MakerNote tag `0x0011`, and it must
   match the video's UUID exactly. Most non-Apple encoders drop it.
3. **`still-image-time`** — a timed metadata track marking which frame is the
   key photo. Without it iOS doesn't know where the still sits in the timeline.
4. **The vitality group** above.
5. **Duration** — wallpaper-eligible Live Photos run about 1–3 seconds. iOS
   plays only a short window leading into the key frame.
6. **Codec** — Apple captures Live Photos as HEVC. Other codecs are less
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

### Running the full test suite

The synthetic tests run anywhere. The tests that read real files skip unless you
supply your own, because nobody's photos ship with this library:

```
test/fixtures/eligible.mov + eligible.HEIC   a pair you have confirmed animating
test/fixtures/plain.mov                      any ordinary video
```

That directory is gitignored. `npm test` tells you which fixtures are missing.

## Prior work

[goLive](https://github.com/code-path/goLive) (MIT) is the reference
implementation for *producing* wallpaper-eligible Live Photos, and its base-file
technique is what proved the format requirements in the first place. This
library only inspects; if you want to build one, start there.

## Licence

MIT.
