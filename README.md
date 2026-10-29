# Thanos Snap for Google Meet — v4.1.0

> **v4.1.0 fix:** PJ's v4 test showed 'Hand not seen' the whole time, so the salute never fired. v4.1.0 adds a pixel forehead-cover fallback in the MAIN script (no hand model, no WASM): salute to your forehead, hold still, the green cover bar must pass 28 for 0.7s, then you vanish. MediaPipe is kept with diagnostics, a busy-timeout, confidence 0.4, and fallback to Meet's tile video.


> **v4.0.0:** Forehead touch is now the main trigger, as in PJ's 29 Oct video: raise a hand to your forehead and hold still ~0.7s — you vanish, background stays; do it again — you return. Snap (visual + audio) is kept as backup. Trigger mode is selectable in the panel: Both / Forehead only / Snap only.


> **v3.0.0:** Visual snap via MediaPipe Hands (bundled locally, no CDN). It watches the video for the thumb+middle finger flick — pressed together, then apart fast — so a quiet snap near a far laptop mic still triggers. Audio snap is kept as backup only. Panel shows hand status live.


> **v2.0.0:** Person-only dust (Chrome FaceDetector finds you, only your box becomes dust, background stays), snap detection is automatic — **Test dust is manual only, you never need to click it** — and the panel is draggable by its title bar, with X to hide it to a small floating ✨ button.


> **How to prove you are on the new code:** after loading, the Extensions card MUST say **1.0.3** and the panel title MUST say **v1.0.3**. If the card still says 1.0.1, Chrome has not reloaded it — click the circular Reload icon on that card, or Remove it and Load unpacked again. Also click **Clear all** on the Errors page first, or old 1.0.1 TrustedHTML errors will stay visible and look like the fix failed.


> **v1.0.2 fix:** Meet enforces Trusted Types, so v1.0.0/v1.0.1 crashed at `panel.innerHTML` (your screenshot, thanos.js:179) and the panel never appeared. v1.0.2 builds the panel with DOM APIs only — no innerHTML anywhere — so it should now appear after a Meet reload.

> **If it did nothing in v1.0.0, read this first:** Chrome does NOT
> inject an extension into a tab that was already open when you installed
> it, and v1.0.0 also waited until page-load to hook the camera, so Meet
> kept its raw camera. v1.0.1 hooks the camera immediately and the panel
> now says HOOKED or NOT HOOKED. **You must reload the Meet tab and
> rejoin after installing/updating, then check the panel says HOOKED
> before you snap.** If it says NOT HOOKED after 6 seconds, reload again.

Snap your fingers while you're on camera: you dissolve into dust particles
and your mic mutes. Snap again: you reassemble and your mic unmutes.

## Install (Chrome, unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`meet-thanos-snap`).
4. Join a Google Meet. Allow camera + mic when asked.
5. A small **✨ Thanos Snap** panel appears bottom-right in Meet.

Note: the extension must be loaded *before* you join / before Meet asks
for the camera. If you install it mid-call, leave and rejoin the Meet so
it can intercept the camera stream from the start.

## How to use

- **Snap once** near your mic, hand in frame if you want the joke to land.
  You dissolve into dust over ~1.4 seconds, then your tile goes black,
  and Meet shows you muted.
- **Snap again** while dusted. Particles fly back together, then your
  video and mic come back.
- Use **Test dust** in the panel if you want to check the animation
  without snapping.
- **Snap sensitivity** slider in the panel: slide right if snaps are
  missed, slide left if normal speech ("p", "t" sounds) triggers it
  by accident.

## How the second snap works while you're muted

This is the tricky part, and it's handled on purpose:

- Meet never hears your raw mic. It hears a *clone* of your mic track.
  When you dust, that clone is muted (and Meet's own mute button is
  clicked, so the Meet UI agrees).
- Snap detection listens to your *original* mic track, which is never
  muted. So the second snap is still heard even though Meet hears
  silence.

## What other people see

- During the snap: your video breaks into dust particles and fades.
- While you're gone: a black tile (Meet has no "transparent person"
  video — black is the disappeared state).
- On return: particles converge back into your live video.

Your own Meet preview shows the same effect, because Meet's preview
uses the same processed stream.

## Limitations — read this before your first live test

- **This is audio snap detection, not hand tracking.** The trigger is
  the *sound* of a finger snap. A completely silent hand gesture won't
  trigger it. A real snap always clicks, and audio is far more reliable
  than video hand-tracking in a Meet call.
- **Not live-tested on a real Meet call from this machine** (no camera /
  Meet session here). The code is syntax-checked and packaged, but your
  first real call is the real test. If a snap is missed, raise the
  sensitivity; if speech triggers it, lower it.
- If Meet changes its mute-button labels, the UI click may miss, but
  the clone-track mute fallback still mutes you in Meet.
- Works on `meet.google.com` in Chrome only. It does not work in the
  Meet mobile app.
- Loud environments and quiet snaps fight each other: snap close to
  the mic, clearly, with a short pause before and after.

## Files

- `manifest.json` — Manifest V3, runs only on meet.google.com.
- `thanos.js` — everything: camera interception, dust animation,
  snap detection, mute/unmute, and the control panel.

## Troubleshooting

- **No panel / no effect:** reload Meet after loading the extension,
  and make sure you loaded the folder, not the ZIP.
- **Video black from the start:** the extension probably loaded after
  Meet already grabbed the camera. Leave and rejoin.
- **Snap not detected:** raise sensitivity, snap louder and closer to
  the mic, and check Chrome didn't block mic access.
- **Speech triggers it:** lower sensitivity.
- **Second snap doesn't bring you back:** use the panel's Test button
  to check the return animation, then try a louder, isolated snap.
  The detector needs a short quiet moment before the snap, so don't
  snap mid-sentence.
