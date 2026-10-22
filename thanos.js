/* Thanos Snap for Google Meet — v2.0.0
 * v2.0.0 — what changed from v1.0.3, in plain terms:
 * - PERSON-ONLY DUST: v1 dusted the whole frame to black because it had
 *   no idea where you are vs your background. v2 uses Chrome's built-in
 *   FaceDetector (no download, no external model) to find your face,
 *   expands that box to cover your torso, and only those pixels become
 *   dust. Everything outside that box stays as your background. When
 *   you are gone, the panel shows the background with the person area
 *   filled from the wall colour around you — on a plain wall this looks
 *   like you simply vanished. If FaceDetector is unavailable in your
 *   Chrome, it falls back to the old whole-frame dust and says so.
 * - SNAP IS AUTOMATIC, TEST BUTTON IS NOT REQUIRED: 'Test dust' was
 *   only ever a manual test button. You never need to click it in a
 *   real call — just snap. v2 also lowers the snap threshold, relaxes
 *   the quiet-before-snap rule, and adds a live mic meter so you can
 *   SEE whether a snap registers before you trust it.
 * - MOVABLE PANEL: drag the panel by its title bar to anywhere, and
 *   use X to hide it completely (a small floating button brings it
 *   back). The minimised bar is no longer stuck in one corner.
 *
 * v1.0.3: no code change from v1.0.2 except version markers everywhere
 * (manifest, panel title, console) — so you can prove Chrome actually
 * reloaded the new code. If the Extensions card still says 1.0.1, Chrome
 * has NOT reloaded it, no matter what files are on disk.
 * v1.0.2 FIX (below, in buildPanel): Meet enforces Trusted Types, so
 * setting innerHTML in the page (MAIN) world throws "This document
 * requires TrustedHTML assignment" and the panel never builds. v1.0.2
 * builds the panel with createElement/textContent/style properties
 * only — no innerHTML, no cssText, anywhere.
 *
 * v1.0.1 FIX — why v1.0.0 silently did nothing in PJ's test video:
 * - v1.0.0 only installed the camera interceptor on DOMContentLoaded.
 *   Meet can grab the camera before that, so it kept the raw track and
 *   the canvas/dust pipeline never saw a frame. The panel also gave no
 *   sign of this, so it just looked dead.
 * - v1.0.1 installs the interceptor IMMEDIATELY (document_start), and
 *   the panel now shows HOOKED vs NOT HOOKED in plain text. If it says
 *   NOT HOOKED, the tab was already in Meet when the extension was
 *   installed — Chrome does NOT inject content scripts into already-open
 *   tabs — and the only fix is to reload the Meet tab and rejoin.
 * - The rest of the design is unchanged (see v1.0.0 notes below).
 *
 * How it works (important, read before debugging):
 * 1. This script runs in the page itself (world: MAIN) so it can intercept
 *    navigator.mediaDevices.getUserMedia BEFORE Meet grabs the camera/mic.
 * 2. Meet never gets your raw camera track. It gets a canvas track. The
 *    canvas normally just draws your live camera frame, so video looks
 *    normal. On a snap, the canvas animates that last frame into dust
 *    particles and then goes black — that is what other people see.
 * 3. Meet never gets your raw mic track either. It gets a CLONE of it.
 *    Snap detection listens to the ORIGINAL mic track, which is never
 *    muted. That is why the second snap still works while you are
 *    "muted" in Meet: Meet hears the muted clone, the detector still
 *    hears your real mic.
 * 4. Snap detection is AUDIO detection (the sound of a finger snap).
 *    A silent hand gesture alone will not trigger it — a real snap
 *    always makes that sharp click, and audio is far more reliable than
 *    trying to track fingers in video. Keep your hand in frame for the
 *    visual joke; the sound does the triggering.
 * 5. Muting is done two ways: the Meet mute button is clicked (so the
 *    Meet UI shows muted) AND the clone track sent to Meet is disabled
 *    as a fallback, checked 400ms after the click.
 */
(function () {
  'use strict';
  if (window.__thanosSnapInstalled) return;
  window.__thanosSnapInstalled = true;

  var SETTINGS_KEY = 'thanosSnapSettings';
  var settings = { enabled: true, sensitivity: 0.80, dustMs: 1400 };
  try {
    var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    if (typeof saved.enabled === 'boolean') settings.enabled = saved.enabled;
    if (typeof saved.sensitivity === 'number') settings.sensitivity = saved.sensitivity;
  } catch (e) { /* keep defaults */ }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }
  // Higher sensitivity = lower peak threshold.
  function peakThreshold() { return 1.02 - settings.sensitivity * 0.62; }

  // ---------- state ----------
  var mode = 'live'; // live | dusting | gone | returning
  var lastSnapAt = 0;
  var snapCount = 0;
  var hooked = false; // true once Meet's camera actually went through the canvas
  var hookEl = null;
  var personBox = null; // {x,y,w,h} in canvas coords, from FaceDetector
  var personEl = null, meterEl = null;
  var faceDetector = null, faceAvailable = false;
  var bgCanvas = document.createElement('canvas');
  function setHooked() {
    hooked = true;
    if (hookEl) { hookEl.textContent = '● HOOKED — Meet video is going through the dust canvas'; hookEl.style.color = '#7CFC9A'; }
    if (statusEl) { statusEl.textContent = '● Visible, mic live'; statusEl.style.color = '#7CFC9A'; }
  }

  // ---------- video processor (shared canvas) ----------
  var canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 720;
  var ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);

  var videoEl = document.createElement('video');
  videoEl.muted = true; videoEl.playsInline = true; videoEl.autoplay = true;

  var canvasStream = null, canvasTrack = null;
  try {
    canvasStream = canvas.captureStream(30);
    canvasTrack = canvasStream.getVideoTracks()[0];
  } catch (e) { canvasTrack = null; }

  var meetAudioTrack = null; // clone sent to Meet
  var origAudioTrack = null; // real mic, used only for snap detection

  // ---------- particles ----------
  var snapshotCanvas = document.createElement('canvas');
  var particles = [];
  var animStart = 0;

  function makeParticles(scattered) {
    particles = [];
    var step = 6;
    var sw = snapshotCanvas.width, sh = snapshotCanvas.height;
    var sctx = snapshotCanvas.getContext('2d');
    var data;
    try { data = sctx.getImageData(0, 0, sw, sh).data; } catch (e) { return; }
    for (var y = 0; y < sh; y += step) {
      for (var x = 0; x < sw; x += step) {
        var i = (y * sw + x) * 4;
        var a = data[i + 3];
        if (a < 20) continue; // skip near-transparent pixels
        var px = (x / sw) * canvas.width;
        var py = (y / sh) * canvas.height;
        if (personBox && (px < personBox.x || px > personBox.x + personBox.w || py < personBox.y || py > personBox.y + personBox.h)) continue;
        if (scattered) {
          particles.push({
            tx: px, ty: py,
            x: px + (Math.random() - 0.5) * 340,
            y: py + (Math.random() - 0.5) * 340 - 60,
            r: data[i], g: data[i + 1], b: data[i + 2],
            size: 1 + Math.random() * 2.2
          });
        } else {
          particles.push({
            x: px, y: py,
            vx: (Math.random() - 0.5) * 3.2 + 0.6,
            vy: -Math.random() * 2.2 - 0.2,
            r: data[i], g: data[i + 1], b: data[i + 2],
            size: 1 + Math.random() * 2.2,
            life: 1
          });
        }
      }
    }
  }

  function takeSnapshot() {
    snapshotCanvas.width = canvas.width;
    snapshotCanvas.height = canvas.height;
    var sctx = snapshotCanvas.getContext('2d');
    try { sctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height); }
    catch (e) { sctx.drawImage(canvas, 0, 0); }
    // Background-only canvas: full frame, but the person box filled with
    // the average colour sampled from just outside the box. On a plain
    // wall this is almost indistinguishable from the real background.
    bgCanvas.width = canvas.width; bgCanvas.height = canvas.height;
    var bctx = bgCanvas.getContext('2d');
    bctx.drawImage(snapshotCanvas, 0, 0);
    if (personBox) {
      try {
        var img = sctx.getImageData(0, 0, snapshotCanvas.width, snapshotCanvas.height).data;
        var r = 0, g = 0, b = 0, n = 0;
        var bx = Math.round(personBox.x), by = Math.round(personBox.y);
        var bw = Math.round(personBox.w), bh = Math.round(personBox.h);
        for (var yy = Math.max(0, by - 30); yy < Math.min(snapshotCanvas.height, by + bh + 30); yy += 4) {
          for (var xx = Math.max(0, bx - 30); xx < Math.min(snapshotCanvas.width, bx + bw + 30); xx += 4) {
            var inside = xx >= bx && xx < bx + bw && yy >= by && yy < by + bh;
            if (inside) continue;
            var idx = (yy * snapshotCanvas.width + xx) * 4;
            r += img[idx]; g += img[idx + 1]; b += img[idx + 2]; n++;
          }
        }
        if (n > 0) {
          bctx.fillStyle = 'rgb(' + Math.round(r / n) + ',' + Math.round(g / n) + ',' + Math.round(b / n) + ')';
          bctx.fillRect(personBox.x, personBox.y, personBox.w, personBox.h);
        }
      } catch (e) {}
    } else {
      bctx.fillStyle = '#000'; bctx.fillRect(0, 0, canvas.width, canvas.height);
      // Fallback (no face box): bg is black, i.e. old whole-frame behaviour.
      // To keep the fallback simple, draw the snapshot over black and let
      // dusting fade it — handled in render by the personBox check.
      bctx.drawImage(snapshotCanvas, 0, 0);
    }
  }

  // ---------- Meet mute / unmute ----------
  function findMeetMicButton() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var label = (btns[i].getAttribute('aria-label') || '').toLowerCase();
      if (label.indexOf('microphone') !== -1 || label === 'mute' || label === 'unmute') return btns[i];
    }
    return null;
  }

  function syncMeetMute(wantMuted) {
    // 1) Try the Meet UI button so Meet's own state stays in sync.
    var btn = findMeetMicButton();
    if (btn) {
      var label = (btn.getAttribute('aria-label') || '').toLowerCase();
      var currentlyMuted = label.indexOf('turn on microphone') !== -1 || label === 'unmute';
      if (wantMuted && !currentlyMuted) { try { btn.click(); } catch (e) {} }
      if (!wantMuted && currentlyMuted) { try { btn.click(); } catch (e) {} }
    }
    // 2) Fallback / guarantee: force the track Meet actually hears.
    setTimeout(function () {
      if (meetAudioTrack) meetAudioTrack.enabled = !wantMuted;
    }, 400);
    if (meetAudioTrack) meetAudioTrack.enabled = !wantMuted;
  }

  // ---------- panel UI ----------
  var panel, statusEl, toastEl;
  function setStatus(text, color) {
    if (statusEl) { statusEl.textContent = text; statusEl.style.color = color; }
  }
  function showToast(text) {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.style.opacity = '1';
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () { toastEl.style.opacity = '0'; }, 2200);
  }

  // Drag helper: drag by a handle, ignore clicks on buttons inside it.
  var floatBtn = null;
  function makeDraggable(handle, target, saveKey) {
    handle.addEventListener('mousedown', function (e) {
      if (e.target && e.target.tagName === 'BUTTON' && e.target !== handle) return;
      e.preventDefault();
      var startX = e.clientX, startY = e.clientY;
      var rect = target.getBoundingClientRect();
      var moved = false;
      function onMove(ev) {
        if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) moved = true;
        target.style.left = (rect.left + ev.clientX - startX) + 'px';
        target.style.top = (rect.top + ev.clientY - startY) + 'px';
        target.style.right = 'auto'; target.style.bottom = 'auto';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        if (saveKey) { try { localStorage.setItem(saveKey, JSON.stringify({ left: target.style.left, top: target.style.top })); } catch (err) {} }
        target._dragged = moved;
        setTimeout(function () { target._dragged = false; }, 0);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
  function restorePos(target, key) {
    try {
      var saved = JSON.parse(localStorage.getItem(key) || 'null');
      if (saved && saved.left && saved.top) {
        target.style.left = saved.left; target.style.top = saved.top;
        target.style.right = 'auto'; target.style.bottom = 'auto';
      }
    } catch (e) {}
  }

  function buildPanel() {
    if (!document.body) return;
    if (document.getElementById('thanos-snap-panel')) return;
    panel = document.createElement('div');
    panel.id = 'thanos-snap-panel';
    panel.style.position = 'fixed'; panel.style.right = '16px'; panel.style.bottom = '96px';
    panel.style.zIndex = '2147483647'; panel.style.width = '268px';
    panel.style.background = 'rgba(18,18,28,0.94)'; panel.style.color = '#fff';
    panel.style.border = '1px solid rgba(255,255,255,0.18)'; panel.style.borderRadius = '14px';
    panel.style.padding = '12px 14px'; panel.style.fontFamily = 'system-ui,Arial,sans-serif';
    panel.style.fontSize = '13px'; panel.style.lineHeight = '1.4';
    panel.style.boxShadow = '0 8px 30px rgba(0,0,0,0.45)';
    restorePos(panel, 'thanosSnapPos');
    var header = document.createElement('div');
    header.style.display = 'flex'; header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center'; header.style.marginBottom = '6px';
    header.style.cursor = 'move';
    var titleEl = document.createElement('b');
    titleEl.textContent = '✨ Thanos Snap v2.0.0  ⠿ drag me';
    header.appendChild(titleEl);
    var minBtn = document.createElement('button');
    minBtn.textContent = '–';
    minBtn.style.background = 'none'; minBtn.style.border = '1px solid rgba(255,255,255,0.3)';
    minBtn.style.color = '#fff'; minBtn.style.borderRadius = '8px';
    minBtn.style.padding = '2px 8px'; minBtn.style.cursor = 'pointer'; minBtn.style.marginLeft = '6px';
    header.appendChild(minBtn);
    var hideBtn = document.createElement('button');
    hideBtn.textContent = '✕';
    hideBtn.title = 'Hide panel (floating button brings it back)';
    hideBtn.style.background = 'none'; hideBtn.style.border = '1px solid rgba(255,255,255,0.3)';
    hideBtn.style.color = '#fff'; hideBtn.style.borderRadius = '8px';
    hideBtn.style.padding = '2px 8px'; hideBtn.style.cursor = 'pointer'; hideBtn.style.marginLeft = '4px';
    header.appendChild(hideBtn);
    panel.appendChild(header);
    makeDraggable(header, panel, 'thanosSnapPos');
    var bodyDiv = document.createElement('div');
    panel.appendChild(bodyDiv);
    var statusRow = document.createElement('div');
    statusRow.appendChild(document.createTextNode('Status: '));
    statusEl = document.createElement('span');
    statusEl.textContent = '● Visible, mic live'; statusEl.style.color = '#7CFC9A';
    statusRow.appendChild(statusEl);
    bodyDiv.appendChild(statusRow);
    hookEl = document.createElement('div');
    hookEl.textContent = '○ Waiting for camera…';
    hookEl.style.fontSize = '11px'; hookEl.style.color = '#ffd479'; hookEl.style.marginTop = '2px';
    bodyDiv.appendChild(hookEl);
    personEl = document.createElement('div');
    personEl.textContent = faceAvailable ? 'Looking for your face…' : 'Face detection not available in this Chrome — dust will be whole-frame';
    personEl.style.fontSize = '11px'; personEl.style.color = '#ccc'; personEl.style.marginTop = '2px';
    bodyDiv.appendChild(personEl);
    var meterLabel = document.createElement('div');
    meterLabel.textContent = 'Mic level — a snap should spike this bar';
    meterLabel.style.margin = '8px 0 2px'; meterLabel.style.fontSize = '11px';
    bodyDiv.appendChild(meterLabel);
    var meterBox = document.createElement('div');
    meterBox.style.height = '8px'; meterBox.style.background = 'rgba(255,255,255,0.15)';
    meterBox.style.borderRadius = '4px'; meterBox.style.overflow = 'hidden';
    meterEl = document.createElement('div');
    meterEl.style.height = '100%'; meterEl.style.width = '0%'; meterEl.style.background = '#7c4dff';
    meterBox.appendChild(meterEl);
    bodyDiv.appendChild(meterBox);
    var sensLabel = document.createElement('div');
    sensLabel.textContent = 'Snap sensitivity';
    sensLabel.style.margin = '8px 0 2px';
    bodyDiv.appendChild(sensLabel);
    var sens = document.createElement('input');
    sens.type = 'range'; sens.min = '0.3'; sens.max = '0.95'; sens.step = '0.05';
    sens.style.width = '100%';
    bodyDiv.appendChild(sens);
    var sensNote = document.createElement('div');
    sensNote.textContent = 'Higher = easier to trigger. If snaps do not trigger, slide right and snap louder, close to the mic.';
    sensNote.style.fontSize = '11px'; sensNote.style.color = '#ccc';
    bodyDiv.appendChild(sensNote);
    var onLabel = document.createElement('label');
    onLabel.style.display = 'flex'; onLabel.style.gap = '6px'; onLabel.style.alignItems = 'center';
    onLabel.style.marginTop = '8px';
    var onChk = document.createElement('input');
    onChk.type = 'checkbox';
    onLabel.appendChild(onChk);
    onLabel.appendChild(document.createTextNode(' Snap detection on (automatic)'));
    bodyDiv.appendChild(onLabel);
    var testBtn = document.createElement('button');
    testBtn.textContent = 'Test dust — manual only, you do NOT need this to snap';
    testBtn.style.width = '100%'; testBtn.style.marginTop = '10px'; testBtn.style.padding = '8px';
    testBtn.style.border = '0'; testBtn.style.borderRadius = '9px';
    testBtn.style.background = '#444'; testBtn.style.color = '#fff'; testBtn.style.fontWeight = '600';
    testBtn.style.cursor = 'pointer'; testBtn.style.fontSize = '12px';
    bodyDiv.appendChild(testBtn);
    var footNote = document.createElement('div');
    footNote.textContent = 'How it works: just snap — detection is automatic, no click needed. The Test button is only for checking the animation without snapping. Drag the title bar to move this panel. X hides it; the small ✨ button brings it back. Snap again while dusted to come back.';
    footNote.style.fontSize = '11px'; footNote.style.color = '#ccc'; footNote.style.marginTop = '8px';
    bodyDiv.appendChild(footNote);
    document.body.appendChild(panel);
    if (hooked) setHooked();
    sens.value = String(settings.sensitivity);
    sens.addEventListener('input', function () { settings.sensitivity = parseFloat(sens.value); saveSettings(); });
    onChk.checked = settings.enabled;
    onChk.addEventListener('change', function () { settings.enabled = onChk.checked; saveSettings(); showToast(settings.enabled ? 'Snap detection on' : 'Snap detection off'); });
    testBtn.addEventListener('click', function () {
      if (!hooked) { showToast('NOT HOOKED yet — reload this Meet tab first, then Test again'); return; }
      onSnapDetected('test button');
    });
    var collapsed = false;
    minBtn.addEventListener('click', function () {
      collapsed = !collapsed;
      bodyDiv.style.display = collapsed ? 'none' : 'block';
      this.textContent = collapsed ? '+' : '–';
    });
    if (!floatBtn) {
      floatBtn = document.createElement('button');
      floatBtn.textContent = '✨';
      floatBtn.title = 'Show Thanos Snap panel';
      floatBtn.style.position = 'fixed'; floatBtn.style.right = '16px'; floatBtn.style.bottom = '16px';
      floatBtn.style.zIndex = '2147483647'; floatBtn.style.width = '44px'; floatBtn.style.height = '44px';
      floatBtn.style.borderRadius = '50%'; floatBtn.style.border = '1px solid rgba(255,255,255,0.3)';
      floatBtn.style.background = 'rgba(18,18,28,0.94)'; floatBtn.style.color = '#fff';
      floatBtn.style.fontSize = '20px'; floatBtn.style.cursor = 'pointer'; floatBtn.style.display = 'none';
      document.body.appendChild(floatBtn);
      makeDraggable(floatBtn, floatBtn, 'thanosSnapFloatPos');
      floatBtn.addEventListener('click', function () {
        if (floatBtn._dragged) return;
        panel.style.display = 'block'; floatBtn.style.display = 'none';
      });
    }
    hideBtn.addEventListener('click', function () {
      panel.style.display = 'none';
      if (floatBtn) floatBtn.style.display = 'block';
    });

    toastEl = document.createElement('div');
    toastEl.style.position = 'fixed'; toastEl.style.left = '50%'; toastEl.style.top = '18px';
    toastEl.style.transform = 'translateX(-50%)'; toastEl.style.zIndex = '2147483647';
    toastEl.style.background = 'rgba(18,18,28,0.94)'; toastEl.style.color = '#fff';
    toastEl.style.padding = '10px 16px'; toastEl.style.borderRadius = '999px';
    toastEl.style.fontFamily = 'system-ui,Arial,sans-serif'; toastEl.style.fontSize = '14px';
    toastEl.style.opacity = '0'; toastEl.style.transition = 'opacity 0.25s'; toastEl.style.pointerEvents = 'none';
    document.body.appendChild(toastEl);
  }

  // ---------- snap transitions ----------
  function startDust() {
    takeSnapshot();
    makeParticles(false);
    mode = 'dusting';
    animStart = performance.now();
    syncMeetMute(true);
    setStatus('💨 Dusted, mic muted', '#c9a7ff');
    showToast('💨 Snapped — you turned to dust and muted');
  }
  function startReturn() {
    takeSnapshot();
    makeParticles(true);
    mode = 'returning';
    animStart = performance.now();
    setStatus('✨ Reassembling…', '#ffd479');
    showToast('✨ Snapped again — coming back…');
  }
  function onSnapDetected(source) {
    if (!settings.enabled) return;
    var now = Date.now();
    if (now - lastSnapAt < 1500) return; // debounce + animation guard
    lastSnapAt = now;
    snapCount++;
    if (mode === 'live') startDust();
    else if (mode === 'gone') startReturn();
    // ignore snaps during dusting/returning animations
  }

  // ---------- render loop ----------
  function render(now) {
    requestAnimationFrame(render);
    if (mode === 'live') {
      if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        // Keep canvas size in step with the camera when it changes.
        var w = videoEl.videoWidth, h = videoEl.videoHeight;
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
      }
      return;
    }
    if (mode === 'gone') {
      if (bgCanvas.width === canvas.width && personBox) ctx.drawImage(bgCanvas, 0, 0);
      else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      return;
    }
    if (mode === 'dusting') {
      var p = Math.min(1, (now - animStart) / settings.dustMs);
      if (bgCanvas.width === canvas.width && personBox) ctx.drawImage(bgCanvas, 0, 0);
      else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.save();
      if (personBox) { ctx.beginPath(); ctx.rect(personBox.x, personBox.y, personBox.w, personBox.h); ctx.clip(); }
      ctx.globalAlpha = Math.max(0, 1 - p);
      ctx.drawImage(snapshotCanvas, 0, 0, canvas.width, canvas.height);
      ctx.restore();
      for (var i = 0; i < particles.length; i++) {
        var pt = particles[i];
        pt.x += pt.vx; pt.y += pt.vy; pt.vy += 0.02; pt.life = 1 - p;
        if (pt.life <= 0) continue;
        ctx.fillStyle = 'rgba(' + pt.r + ',' + pt.g + ',' + pt.b + ',' + pt.life.toFixed(3) + ')';
        ctx.fillRect(pt.x, pt.y, pt.size, pt.size);
      }
      if (p >= 1) { mode = 'gone'; if (meetAudioTrack) meetAudioTrack.enabled = false; }
      return;
    }
    if (mode === 'returning') {
      var q = Math.min(1, (now - animStart) / 900);
      // ease-out cubic
      var e = 1 - Math.pow(1 - q, 3);
      if (bgCanvas.width === canvas.width && personBox) ctx.drawImage(bgCanvas, 0, 0);
      else { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
      ctx.save();
      if (personBox) { ctx.beginPath(); ctx.rect(personBox.x, personBox.y, personBox.w, personBox.h); ctx.clip(); }
      ctx.globalAlpha = e;
      ctx.drawImage(snapshotCanvas, 0, 0, canvas.width, canvas.height);
      ctx.restore();
      for (var j = 0; j < particles.length; j++) {
        var rp = particles[j];
        var x = rp.x + (rp.tx - rp.x) * e;
        var y = rp.y + (rp.ty - rp.y) * e;
        ctx.fillStyle = 'rgba(' + rp.r + ',' + rp.g + ',' + rp.b + ',' + e.toFixed(3) + ')';
        ctx.fillRect(x, y, rp.size, rp.size);
      }
      if (q >= 1) {
        mode = 'live';
        syncMeetMute(false);
        setStatus('● Visible, mic live', '#7CFC9A');
        showToast('✨ You are back — mic unmuted');
      }
      return;
    }
  }
  requestAnimationFrame(render);

  // ---------- snap detection (audio) ----------
  var audioCtx = null, analyser = null, sourceNode = null;
  var timeData = null, freqData = null, rmsHistory = [];
  function attachDetector(stream) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      if (sourceNode) { try { sourceNode.disconnect(); } catch (e) {} }
      sourceNode = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      sourceNode.connect(analyser);
      timeData = new Float32Array(analyser.fftSize);
      freqData = new Uint8Array(analyser.frequencyBinCount);
      rmsHistory = [];
    } catch (e) { analyser = null; }
  }
  function detectorTick() {
    if (analyser && timeData) {
      analyser.getFloatTimeDomainData(timeData);
      analyser.getByteFrequencyData(freqData);
      var peak = 0, sum = 0;
      for (var i = 0; i < timeData.length; i++) {
        var v = Math.abs(timeData[i]); if (v > peak) peak = v; sum += v * v;
      }
      var rms = Math.sqrt(sum / timeData.length);
      // High-frequency share (snap clicks are broadband / high-frequency).
      var hi = 0, tot = 0;
      for (var k = 0; k < freqData.length; k++) {
        tot += freqData[k];
        if (k > freqData.length * 0.45) hi += freqData[k];
      }
      var hiRatio = tot > 0 ? hi / tot : 0;
      var prevAvg = rmsHistory.length ? rmsHistory.reduce(function (a, b) { return a + b; }, 0) / rmsHistory.length : 0;
      if (meterEl) meterEl.style.width = Math.min(100, Math.round(peak * 100)) + '%';
      if (peak > peakThreshold() && prevAvg < 0.25 && hiRatio > 0.12) {
        onSnapDetected('audio snap');
      }
      rmsHistory.push(rms);
      if (rmsHistory.length > 10) rmsHistory.shift();
    }
    setTimeout(detectorTick, 12);
  }
  detectorTick();
  document.addEventListener('click', function () { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); });
  document.addEventListener('keydown', function () { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); });

  // ---------- person finding (Chrome FaceDetector, no download) ----------
  function initFaceDetector() {
    try {
      if (typeof FaceDetector !== 'undefined') {
        faceDetector = new FaceDetector({ fastMode: true });
        faceAvailable = true;
      }
    } catch (e) { faceAvailable = false; }
  }
  function faceTick() {
    if (faceDetector && mode === 'live' && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
      try {
        faceDetector.detect(videoEl).then(function (faces) {
          if (faces && faces.length) {
            var f = faces[0].boundingBox;
            var sx = canvas.width / videoEl.videoWidth, sy = canvas.height / videoEl.videoHeight;
            var fx = f.x * sx, fy = f.y * sy, fw = f.width * sx, fh = f.height * sy;
            personBox = {
              x: Math.max(0, fx - fw * 0.9),
              y: Math.max(0, fy - fh * 0.4),
              w: Math.min(canvas.width - Math.max(0, fx - fw * 0.9), fw * 2.8),
              h: Math.min(canvas.height - Math.max(0, fy - fh * 0.4), fh * 4.2)
            };
            if (personEl) personEl.textContent = 'Person found — dust will be person-only';
          }
        }).catch(function () {});
      } catch (e) {}
    }
    setTimeout(faceTick, 400);
  }
  initFaceDetector();
  faceTick();

  // ---------- intercept getUserMedia ----------
  function installInterceptor() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    if (navigator.mediaDevices.__thanosHooked) return;
    navigator.mediaDevices.__thanosHooked = true;
    var origGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    var wrapped = async function (constraints) {
      var stream = await origGetUserMedia(constraints);
      var hasVideo = !!(constraints && constraints.video);
      var hasAudio = !!(constraints && constraints.audio);
      var vTrack = stream.getVideoTracks()[0];
      var aTrack = stream.getAudioTracks()[0];
      if (!settings.enabled || !vTrack || !canvasTrack) {
        // Pass through untouched when disabled or when canvas capture failed.
        if (aTrack) { origAudioTrack = aTrack; }
        return stream;
      }
      if (hasVideo && vTrack) {
        try {
          videoEl.srcObject = new MediaStream([vTrack]);
          videoEl.play().catch(function () {});
        } catch (e) {}
        setHooked();
      }
      if (hasAudio && aTrack) {
        origAudioTrack = aTrack;
        // Meet hears the clone; the detector hears the original.
        try { meetAudioTrack = aTrack.clone(); } catch (e) { meetAudioTrack = aTrack; }
        attachDetector(new MediaStream([aTrack]));
      }
      var outTracks = [];
      stream.getTracks().forEach(function (t) {
        if (t.kind === 'video' && hasVideo && canvasTrack) outTracks.push(canvasTrack);
        else if (t.kind === 'audio' && hasAudio && meetAudioTrack) outTracks.push(meetAudioTrack);
        else outTracks.push(t);
      });
      return new MediaStream(outTracks);
    };
    navigator.mediaDevices.getUserMedia = wrapped;
    try {
      if (window.MediaDevices && window.MediaDevices.prototype) {
        window.MediaDevices.prototype.getUserMedia = wrapped;
      }
    } catch (e) {}
  }

  // v1.0.1: install the interceptor IMMEDIATELY — do NOT wait for
  // DOMContentLoaded. That wait was the v1.0.0 bug: Meet can grab the
  // camera before DOMContentLoaded fires.
  installInterceptor();
  // Panel needs <body>, so retry it until it exists.
  buildPanel();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  }
  var panelRetry = setInterval(function () {
    buildPanel();
    if (document.getElementById('thanos-snap-panel')) clearInterval(panelRetry);
  }, 500);
  setTimeout(function () { clearInterval(panelRetry); }, 15000);
  // After 6s, if the panel is up but no camera ever went through the
  // canvas, say so plainly instead of failing silently.
  setTimeout(function () {
    if (!hooked && hookEl) {
      hookEl.textContent = '✕ NOT HOOKED — reload this Meet tab and rejoin (extension was loaded after the camera started)';
      hookEl.style.color = '#ff8a8a';
    }
  }, 6000);

  window.__thanosSnap = {
    testSnap: function () { onSnapDetected('manual'); },
    status: function () { return { mode: mode, hooked: hooked, snaps: snapCount, sensitivity: settings.sensitivity }; },
    toggle: function () { settings.enabled = !settings.enabled; saveSettings(); return settings.enabled; }
  };
  console.log('[Thanos Snap v2.0.0] loaded — interceptor installed, waiting for camera.');
})();
