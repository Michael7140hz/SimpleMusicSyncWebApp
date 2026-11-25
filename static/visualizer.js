"use strict";
// =====================================================================
// Spectrum visualiser in the player bar: bars in the theme's orange-to-
// magenta gradient, low notes on the left, high on the right.
//
// To measure the sound, Web Audio has to take over the <audio> element's
// output. Browsers only let that start after you've clicked or pressed a key,
// so it connects on your first click/key. If it can't start, it never
// connects, so the music is never silenced. Hidden when "reduce motion" is on.
// =====================================================================
(() => {
  const canvas = $("#viz"), audioEl = $("#audio");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const BARS = 56, LOW_HZ = 40, HIGH_HZ = 16000;
  let ac = null, analyser = null, bins = null, connecting = false;
  let levels = new Float32Array(BARS), peaks = new Float32Array(BARS), raf = 0, colours = null;

  async function connect() {
    if (reduceMotion.matches) return;
    if (ac) { if (ac.state === "suspended") ac.resume().catch(() => {}); return; }
    if (connecting) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    connecting = true;
    let ctx = null;
    try {
      ctx = new AC();
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]);
      if (ctx.state !== "running") { ctx.close(); return; }      // not allowed yet: try on the next click
      const source = ctx.createMediaElementSource(audioEl);
      const an = ctx.createAnalyser();
      an.fftSize = 4096;
      an.smoothingTimeConstant = 0.7;
      an.minDecibels = -88;
      an.maxDecibels = -26;
      source.connect(an);
      an.connect(ctx.destination);
      ac = ctx; analyser = an; bins = new Uint8Array(an.frequencyBinCount);
      start();
    } catch {
      try { ctx && ctx.close(); } catch { /* ignore */ }
    } finally {
      connecting = false;
    }
  }
  for (const type of ["pointerdown", "keydown"]) document.addEventListener(type, connect, { capture: true, passive: true });
  audioEl.addEventListener("play", () => { if (ac && ac.state === "suspended") ac.resume().catch(() => {}); start(); });

  function readColours() {
    const cs = getComputedStyle(document.documentElement);
    colours = {
      from: cs.getPropertyValue("--zune-orange").trim() || "#F58113",
      to: cs.getPropertyValue("--zune-magenta").trim() || "#EC008C",
      line: cs.getPropertyValue("--line").trim() || "#DAD9D9",
    };
  }
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { colours = null; start(); });
  new MutationObserver(() => { colours = null; start(); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  function start() {
    if (!raf && !reduceMotion.matches) raf = requestAnimationFrame(frame);
  }

  function frame() {
    raf = 0;
    const dpr = devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (!w || !h) return;                                   // hidden (narrow window)
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; colours = null; }
    if (!colours) readColours();

    const live = analyser && player.state === "playing" && !audioEl.paused;
    if (live) analyser.getByteFrequencyData(bins);
    const nyquist = ac ? ac.sampleRate / 2 : 22050;
    let moving = false;
    for (let i = 0; i < BARS; i++) {
      let v = 0;
      if (live) {
        // Bars are spaced evenly on a log scale, like an equaliser.
        const lo = LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, i / BARS);
        const hi = LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, (i + 1) / BARS);
        const a = Math.floor((lo / nyquist) * bins.length), b = Math.max(a + 1, Math.ceil((hi / nyquist) * bins.length));
        for (let k = a; k < b && k < bins.length; k++) v = Math.max(v, bins[k]);
        v = Math.pow(v / 255, 1.25);
      }
      levels[i] = v > levels[i] ? v : levels[i] * 0.86;        // quick rise, gentle fall
      peaks[i] = levels[i] > peaks[i] ? levels[i] : Math.max(0, peaks[i] - 0.012);
      if (levels[i] > 0.004 || peaks[i] > 0.004) moving = true;
    }

    const g = canvas.getContext("2d");
    g.clearRect(0, 0, w, h);
    const gap = Math.max(1, Math.round(2 * dpr)), barW = (w - gap * (BARS - 1)) / BARS;
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, colours.from);
    grad.addColorStop(1, colours.to);
    g.fillStyle = colours.line;
    g.fillRect(0, h - dpr, w, dpr);                           // baseline
    g.fillStyle = grad;
    for (let i = 0; i < BARS; i++) {
      const x = i * (barW + gap);
      const bh = Math.round(levels[i] * (h - 3 * dpr));
      if (bh > 0) g.fillRect(x, h - bh, barW, bh);
      const py = Math.round(h - peaks[i] * (h - 3 * dpr) - 2 * dpr);   // small peak caps
      if (peaks[i] > 0.02) g.fillRect(x, py, barW, Math.max(1, Math.round(1.5 * dpr)));
    }
    if (live || moving) start();                              // idle when silent: no wasted frames
  }

  addEventListener("resize", start);
  start();
})();
