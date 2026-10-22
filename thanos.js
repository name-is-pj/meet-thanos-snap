/* Thanos Snap for Google Meet — v1.0.1
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
  var settings = { enabled: true, sensitivity: 0.65, dustMs: 1400 };
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

  function buildPanel() {
    if (!document.body) return;
    if (document.getElementById('thanos-snap-panel')) return;
    panel = document.createElement('div');
    panel.id = 'thanos-snap-panel';
    panel.style.cssText = 'position:fixed;right:16px;bottom:96px;z-index:2147483647;width:268px;background:rgba(18,18,28,0.94);color:#fff;border:1px solid rgba(255,255,255,0.18);border-radius:14px;padding:12px 14px;font-family:system-ui,Arial,sans-serif;font-size:13px;line-height:1.4;box-shadow:0 8px 30px rgba(0,0,0,0.45);';
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
        '<b>✨ Thanos Snap v1.0.1</b>' +
        '<button id="thanos-min" style="background:none;border:1px solid rgba(255,255,255,0.3);color:#fff;border-radius:8px;padding:2px 8px;cursor:pointer;">–</button>' +
      '</div>' +
      '<div id="thanos-body">' +
        '<div>Status: <span id="thanos-status" style="color:#7CFC9A;">● Visible, mic live</span></div>' +
        '<div id="thanos-hook" style="font-size:11px;color:#ffd479;margin-top:2px;">○ Waiting for camera…</div>' +
        '<div style="margin:8px 0 2px;">Snap sensitivity</div>' +
        '<input id="thanos-sens" type="range" min="0.3" max="0.95" step="0.05" style="width:100%;">' +
        '<div style="font-size:11px;color:#ccc;">Higher = easier to trigger. Lower it if speech triggers it.</div>' +
        '<label style="display:flex;gap:6px;align-items:center;margin-top:8px;"><input id="thanos-on" type="checkbox"> Snap detection on</label>' +
        '<button id="thanos-test" style="width:100%;margin-top:10px;padding:8px;border:0;border-radius:9px;background:#7c4dff;color:#fff;font-weight:600;cursor:pointer;">Test dust (simulates a snap)</button>' +
        '<div style="font-size:11px;color:#ccc;margin-top:8px;">If it says NOT HOOKED, reload this Meet tab and rejoin — Chrome does not inject extensions into a tab that was already open when you installed it. Snap near your mic. Snap again while dusted to come back.</div>' +
      '</div>';
    document.body.appendChild(panel);
    statusEl = document.getElementById('thanos-status');
    hookEl = document.getElementById('thanos-hook');
    if (hooked) setHooked();
    var sens = document.getElementById('thanos-sens');
    sens.value = String(settings.sensitivity);
    sens.addEventListener('input', function () { settings.sensitivity = parseFloat(sens.value); saveSettings(); });
    var on = document.getElementById('thanos-on');
    on.checked = settings.enabled;
    on.addEventListener('change', function () { settings.enabled = on.checked; saveSettings(); showToast(settings.enabled ? 'Snap detection on' : 'Snap detection off'); });
    document.getElementById('thanos-test').addEventListener('click', function () {
      if (!hooked) { showToast('NOT HOOKED yet — reload this Meet tab first, then Test again'); return; }
      onSnapDetected('test button');
    });
    var body = document.getElementById('thanos-body');
    var collapsed = false;
    document.getElementById('thanos-min').addEventListener('click', function () {
      collapsed = !collapsed;
      body.style.display = collapsed ? 'none' : 'block';
      this.textContent = collapsed ? '+' : '–';
    });

    toastEl = document.createElement('div');
    toastEl.style.cssText = 'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483647;background:rgba(18,18,28,0.94);color:#fff;padding:10px 16px;border-radius:999px;font-family:system-ui,Arial,sans-serif;font-size:14px;opacity:0;transition:opacity 0.25s;pointer-events:none;';
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
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (mode === 'dusting') {
      var p = Math.min(1, (now - animStart) / settings.dustMs);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.save(); ctx.globalAlpha = Math.max(0, 1 - p);
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
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height);
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
      if (peak > peakThreshold() && prevAvg < 0.18 && hiRatio > 0.18) {
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
  console.log('[Thanos Snap v1.0.1] loaded — interceptor installed, waiting for camera.');
})();
