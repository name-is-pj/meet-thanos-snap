/* Thanos Hand Tracker — ISOLATED world content script (v3.0.0)
 * Runs separately from the MAIN-world thanos.js so Meet's page CSP /
 * Trusted Types cannot block it, and so chrome.runtime.getURL works.
 * It finds the hidden source video element that MAIN appends to the
 * DOM (id thanos-source-video), runs MediaPipe Hands on it, and
 * dispatches window CustomEvents that MAIN listens for:
 *   thanos-visual-snap  — a finger snap was seen in video
 *   thanos-hand-status  — {seen, ratio, ready, error} for the panel
 *
 * Snap gesture, from hand landmarks (normalised 0..1 coords):
 *   thumb tip = 4, middle tip = 12, wrist = 0, middle MCP = 9
 *   handScale = distance(wrist, middle MCP)
 *   ratio = distance(thumb tip, middle tip) / handScale
 *   Snap = ratio was < 0.55 (fingers pressed together) and then
 *   rises to > 0.95 within 400ms, hand raised (middle tip y < 0.75).
 * This is a flick, not a wave: a slow hand raise does not cross
 * that fast, and a background change produces no hand landmarks at all.
 */
(function () {
  'use strict';
  if (window.__thanosHandInstalled) return;
  window.__thanosHandInstalled = true;

  function emit(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail: detail })); } catch (e) {}
  }

  var hands = null, ready = false, busy = false;
  var history = []; // {t, ratio}
  var lastSnapAt = 0, lastStatusAt = 0;

  function dist(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function onResults(results) {
    busy = false;
    var lm = results && results.multiHandLandmarks && results.multiHandLandmarks[0];
    var now = Date.now();
    if (!lm) {
      history = [];
      if (now - lastStatusAt > 1000) { lastStatusAt = now; emit('thanos-hand-status', { seen: false, ratio: null, ready: ready }); }
      return;
    }
    var scale = dist(lm[0], lm[9]) || 0.2;
    var ratio = dist(lm[4], lm[12]) / scale;
    var handRaised = lm[12].y < 0.75;
    history.push({ t: now, ratio: ratio });
    while (history.length && now - history[0].t > 500) history.shift();
    if (now - lastStatusAt > 800) {
      lastStatusAt = now;
      emit('thanos-hand-status', { seen: true, ratio: Math.round(ratio * 100) / 100, ready: ready });
    }
    if (!handRaised) return;
    if (now - lastSnapAt < 1500) return;
    var minRatio = Math.min.apply(null, history.map(function (h) { return h.ratio; }));
    if (minRatio < 0.55 && ratio > 0.95 && (ratio - minRatio) > 0.4) {
      lastSnapAt = now;
      history = [];
      emit('thanos-visual-snap', { ratio: ratio, at: now });
    }
  }

  function start() {
    if (typeof Hands === 'undefined') {
      emit('thanos-hand-status', { seen: false, ratio: null, ready: false, error: 'Hands library not loaded' });
      return;
    }
    try {
      hands = new Hands({
        locateFile: function (file) { return chrome.runtime.getURL('lib/hands/' + file); }
      });
      hands.setOptions({ maxNumHands: 1, modelComplexity: 0, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      hands.onResults(onResults);
      ready = true;
      emit('thanos-hand-status', { seen: false, ratio: null, ready: true });
    } catch (e) {
      emit('thanos-hand-status', { seen: false, ratio: null, ready: false, error: String(e && e.message || e) });
      return;
    }
    // Loop: find the MAIN-world source video in the shared DOM.
    (function loop() {
      setTimeout(function () {
        var video = document.getElementById('thanos-source-video');
        if (video && video.readyState >= 2 && video.videoWidth > 0 && !busy) {
          busy = true;
          try {
            hands.send({ image: video }).catch(function () { busy = false; });
          } catch (e) { busy = false; }
        }
        loop();
      }, 120);
    })();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
