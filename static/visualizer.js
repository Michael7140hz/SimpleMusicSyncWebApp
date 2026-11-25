"use strict";
// =====================================================================
// Visualiser in the player bar, in the theme's orange-to-magenta gradient,
// low notes on the left and high on the right. Two styles; click it to switch:
//   - bars: slim bars with falling peak caps. The number of bars follows the
//     width, so wide windows get more bars instead of fatter ones;
//   - wave: a smooth glowing line along a baseline, with a faint reflection.
//
// To measure the sound, Web Audio has to take over the <audio> element's
// output. Browsers only let that start after you've clicked or pressed a key,
// so it connects on your first click/key. If it can't start, it never
// connects, so the music is never silenced. Hidden when "reduce motion" is on.
// =====================================================================
(() => {
  const button = $("#vizBtn"), canvas = $("#viz"), audioEl = $("#audio");
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const LOW_HZ = 40, HIGH_HZ = 16000;
  const BAR_W = 3, BAR_GAP = 2;          // CSS pixels: slim bars, however wide the window
  let ac = null, analyser = null, bins = null, connecting = false;
  let count = 0, levels = new Float32Array(0), peaks = new Float32Array(0);
  let raf = 0, colours = null;
  let style = loadPref("musicsync.vizStyle", "bars") === "wave" ? "wave" : "bars";

  // ---------------------------------------------------------------
  // Connecting to the audio
  // ---------------------------------------------------------------
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
      an.fftSize = 8192;                    // fine enough to give low notes their own bars
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

  // ---------------------------------------------------------------
  // Switching style
  // ---------------------------------------------------------------
  function labelButton() {
    const next = style === "bars" ? "wave" : "bars";
    button.title = `Visualizer: ${style}. Click for ${next}.`;
    button.setAttribute("aria-label", `Visualizer style: ${style}. Switch to ${next}.`);
  }
  button.addEventListener("click", () => {
    style = style === "bars" ? "wave" : "bars";
    savePref("musicsync.vizStyle", style);
    labelButton();
    draw(false);                           // show the new style straight away, even when paused
    start();
  });
  labelButton();

  // ---------------------------------------------------------------
  // Colours follow the theme
  // ---------------------------------------------------------------
  function readColours() {
    const cs = getComputedStyle(document.documentElement);
    const dark = cs.colorScheme.includes("dark") || cs.getPropertyValue("color-scheme").includes("dark");
    colours = {
      from: cs.getPropertyValue("--zune-orange").trim() || "#F58113",
      to: cs.getPropertyValue("--zune-magenta").trim() || "#EC008C",
      line: cs.getPropertyValue("--line").trim() || "#DAD9D9",
      glow: dark ? 0.75 : 0.4,             // the glow reads strongest on dark backgrounds
    };
  }
  const resetColours = () => { colours = null; draw(false); start(); };
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", resetColours);
  new MutationObserver(resetColours).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  // ---------------------------------------------------------------
  // Measuring
  // ---------------------------------------------------------------
  /** Level (0..1) of the frequency range [lo, hi] Hz, reading between bins for narrow ranges. */
  function levelFor(lo, hi, nyquist) {
    const per = bins.length / nyquist;
    const a = lo * per, b = hi * per;
    if (b - a < 1) {                       // narrower than one bin: interpolate, so neighbours differ smoothly
      const x = (a + b) / 2, i = Math.floor(x), f = x - i;
      return ((bins[i] || 0) * (1 - f) + (bins[i + 1] || 0) * f) / 255;
    }
    let v = 0;
    for (let k = Math.floor(a); k < Math.ceil(b) && k < bins.length; k++) v = Math.max(v, bins[k]);
    return v / 255;
  }

  function measure(live) {
    const nyquist = ac ? ac.sampleRate / 2 : 22050;
    let moving = false;
    for (let i = 0; i < count; i++) {
      let v = 0;
      if (live) {
        const lo = LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, i / count);
        const hi = LOW_HZ * Math.pow(HIGH_HZ / LOW_HZ, (i + 1) / count);
        v = Math.pow(levelFor(lo, hi, nyquist), 1.25);
      }
      levels[i] = v > levels[i] ? v : levels[i] * 0.86;          // quick rise, gentle fall
      peaks[i] = levels[i] > peaks[i] ? levels[i] : Math.max(0, peaks[i] - 0.012);
      if (levels[i] > 0.004 || peaks[i] > 0.004) moving = true;
    }
    return moving;
  }

  // ---------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------
  function gradient(g, w) {
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, colours.from);
    grad.addColorStop(1, colours.to);
    return grad;
  }

  function drawBars(g, w, h, dpr) {
    const gap = BAR_GAP * dpr, barW = (w - gap * (count - 1)) / count;
    g.fillStyle = colours.line;
    g.fillRect(0, h - dpr, w, dpr);                                // baseline
    g.fillStyle = gradient(g, w);
    const room = h - 3 * dpr;
    for (let i = 0; i < count; i++) {
      const x = i * (barW + gap);
      const bh = Math.round(levels[i] * room);
      if (bh > 0) g.fillRect(x, h - bh, barW, bh);
      if (peaks[i] > 0.02) g.fillRect(x, Math.round(h - peaks[i] * room - 2 * dpr), barW, Math.max(1, Math.round(1.5 * dpr)));
    }
  }

  /** A smooth line through the levels: quadratic curves between the midpoints of neighbours. */
  function tracePath(g, xs, ys) {
    g.beginPath();
    g.moveTo(xs[0], ys[0]);
    for (let i = 1; i < xs.length - 1; i++) {
      g.quadraticCurveTo(xs[i], ys[i], (xs[i] + xs[i + 1]) / 2, (ys[i] + ys[i + 1]) / 2);
    }
    g.lineTo(xs[xs.length - 1], ys[ys.length - 1]);
  }

  function drawWave(g, w, h, dpr) {
    const base = Math.round(h * 0.7);                              // line sits low, reflection below
    const up = base - 3 * dpr, down = h - base - dpr;
    const xs = new Float32Array(count + 2), top = new Float32Array(count + 2), bottom = new Float32Array(count + 2);
    xs[0] = 0; top[0] = bottom[0] = base;
    const K = [1, 3, 5, 3, 1];                                     // blend with neighbours: wide, smooth humps
    for (let i = 0; i < count; i++) {
      let sum = 0, wsum = 0;
      for (let k = -2; k <= 2; k++) {
        const j = i + k;
        if (j >= 0 && j < count) { sum += levels[j] * K[k + 2]; wsum += K[k + 2]; }
      }
      // The line rests on the baseline and only the peaks rise: ignore the steady floor of the
      // music, stretch what's above it, and ease off towards both ends.
      const above = Math.max(0, (sum / wsum - 0.2) / 0.8);
      const edge = Math.min(1, (i + 1) / (count * 0.04), (count - i) / (count * 0.04));
      const v = Math.min(1, Math.pow(above, 1.2) * 1.9) * Math.sin(edge * Math.PI / 2);
      xs[i + 1] = ((i + 0.5) / count) * w;
      top[i + 1] = base - v * up;
      bottom[i + 1] = base + v * down * 0.85;
    }
    xs[count + 1] = w; top[count + 1] = bottom[count + 1] = base;
    const grad = gradient(g, w);
    g.lineJoin = g.lineCap = "round";

    // Reflection: the same shape upside down below the line, faint.
    g.save();
    g.globalAlpha = 0.28;
    g.strokeStyle = grad;
    g.lineWidth = 1.5 * dpr;
    tracePath(g, xs, bottom);
    g.stroke();
    g.restore();

    // Glow, then the line itself.
    g.save();
    g.strokeStyle = grad;
    g.shadowColor = colours.to;
    g.shadowBlur = 10 * dpr;
    g.globalAlpha = colours.glow;
    g.lineWidth = 4 * dpr;
    tracePath(g, xs, top);
    g.stroke();
    g.restore();
    g.save();
    g.strokeStyle = grad;
    g.lineWidth = 2 * dpr;
    tracePath(g, xs, top);
    g.stroke();
    g.restore();
  }

  function draw(advance) {
    const dpr = devicePixelRatio || 1;
    const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
    const w = Math.round(cssW * dpr), h = Math.round(cssH * dpr);
    if (!w || !h) return false;                                    // hidden (narrow window)
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; colours = null; }
    if (!colours) readColours();

    // As many slim bars as fit; the wave uses a point every 9 px, for smooth humps.
    const want = style === "bars"
      ? Math.max(16, Math.min(400, Math.floor((cssW + BAR_GAP) / (BAR_W + BAR_GAP))))
      : Math.max(20, Math.min(240, Math.floor(cssW / 9)));
    if (want !== count) {
      count = want;
      levels = new Float32Array(count);
      peaks = new Float32Array(count);
    }

    const live = analyser && player.state === "playing" && !audioEl.paused;
    if (live) analyser.getByteFrequencyData(bins);
    const moving = advance ? measure(live) : false;

    const g = canvas.getContext("2d");
    g.clearRect(0, 0, w, h);
    if (style === "wave") drawWave(g, w, h, dpr); else drawBars(g, w, h, dpr);
    return live || moving;
  }

  function start() {
    if (!raf && !reduceMotion.matches) raf = requestAnimationFrame(frame);
  }
  function frame() {
    raf = 0;
    if (draw(true)) start();                                       // idle when silent: no wasted frames
  }

  addEventListener("resize", () => { draw(false); start(); });
  start();
})();
