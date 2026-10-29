/* Thanos Hand Tracker — ISOLATED world content script (v4.1.0)
 * v4 adds FOREHEAD TOUCH: raise a hand to your forehead, hold it there,
 * you vanish (background only); raise it again, hold, you come back.
 * Detection: palm centre (avg of landmarks 0,5,9,13,17) in upper-centre
 * (y < 0.42, x 0.30-0.70), hand large enough (scale > 0.12), held almost
 * still (< 0.08 movement) for >= 700ms. After a trigger it will NOT fire
 * again until the hand leaves the forehead region.
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
  var foreheadHist = []; // {t, x, y}
  var foreheadArmed = true, lastForeheadAt = 0;
  var framesSent = 0, resultsReceived = 0, videoState = 'no-video', lastSendAt = 0;

  function dist(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function onResults(results) {
    busy = false; resultsReceived++;
    var lm = results && results.multiHandLandmarks && results.multiHandLandmarks[0];
    var now = Date.now();
    if (!lm) {
      history = []; foreheadHist = []; foreheadArmed = true;
      if (now - lastStatusAt > 1000) { lastStatusAt = now; emit('thanos-hand-status', { seen: false, ratio: null, ready: ready, forehead: false, holdMs: 0, frames: framesSent, results: resultsReceived, video: videoState }); }
      return;
    }
    var palmX = (lm[0].x + lm[5].x + lm[9].x + lm[13].x + lm[17].x) / 5;
    var palmY = (lm[0].y + lm[5].y + lm[9].y + lm[13].y + lm[17].y) / 5;
    var palmScale = dist(lm[0], lm[9]);
    var inForehead = palmY < 0.42 && palmX > 0.30 && palmX < 0.70 && palmScale > 0.12;
    var holdMs = 0;
    if (inForehead) {
      foreheadHist.push({ t: now, x: palmX, y: palmY });
      while (foreheadHist.length && now - foreheadHist[0].t > 900) foreheadHist.shift();
      holdMs = foreheadHist.length ? now - foreheadHist[0].t : 0;
      var maxMove = 0;
      for (var fi = 0; fi < foreheadHist.length; fi++) {
        var dxf = foreheadHist[fi].x - foreheadHist[0].x, dyf = foreheadHist[fi].y - foreheadHist[0].y;
        var ddf = Math.sqrt(dxf * dxf + dyf * dyf); if (ddf > maxMove) maxMove = ddf;
      }
      if (foreheadArmed && holdMs >= 700 && maxMove < 0.08 && now - lastForeheadAt > 1500) {
        lastForeheadAt = now; foreheadArmed = false; foreheadHist = [];
        emit('thanos-forehead-touch', { at: now, holdMs: holdMs });
      }
    } else {
      if (foreheadHist.length) foreheadArmed = true;
      foreheadHist = []; holdMs = 0;
    }
    var scale = dist(lm[0], lm[9]) || 0.2;
    var ratio = dist(lm[4], lm[12]) / scale;
    var handRaised = lm[12].y < 0.75;
    history.push({ t: now, ratio: ratio });
    while (history.length && now - history[0].t > 500) history.shift();
    if (now - lastStatusAt > 800) {
      lastStatusAt = now;
      emit('thanos-hand-status', { seen: true, ratio: Math.round(ratio * 100) / 100, ready: ready, forehead: inForehead, holdMs: holdMs, frames: framesSent, results: resultsReceived, video: videoState });
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
      hands.setOptions({ maxNumHands: 1, modelComplexity: 0, minDetectionConfidence: 0.4, minTrackingConfidence: 0.4 });
      hands.onResults(onResults);
      ready = true;
      emit('thanos-hand-status', { seen: false, ratio: null, ready: true });
    } catch (e) {
      emit('thanos-hand-status', { seen: false, ratio: null, ready: false, error: String(e && e.message || e) });
      return;
    }
    // Loop: find the MAIN-world source video in the shared DOM.
    // v4.1.0: if that video is missing/frozen, fall back to the largest
    // playing <video> on the page (Meet's own tile). Also unstick 'busy'
    // if a send never produced a result within 800ms (previously a
    // single failed send could block the tracker forever).
    (function loop() {
      setTimeout(function () {
        if (busy && Date.now() - lastSendAt > 800) busy = false;
        var video = document.getElementById('thanos-source-video');
        if (!video || video.readyState < 2 || video.videoWidth === 0) {
          var all = document.querySelectorAll('video');
          var best = null, bestArea = 0;
          for (var vi = 0; vi < all.length; vi++) {
            var v = all[vi];
            if (v.readyState >= 2 && v.videoWidth > 0 && !v.paused) {
              var area = v.videoWidth * v.videoHeight;
              if (area > bestArea) { bestArea = area; best = v; }
            }
          }
          if (best) video = best;
        }
        if (!video) videoState = 'no-video';
        else if (video.readyState < 2 || video.videoWidth === 0) videoState = 'video-not-ready';
        else if (video.paused) videoState = 'video-paused';
        else videoState = 'video-ok';
        if (video && video.readyState >= 2 && video.videoWidth > 0 && !busy) {
          busy = true; lastSendAt = Date.now(); framesSent++;
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
