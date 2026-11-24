"use strict";
// =====================================================================
// Theater mode: a full-window player over a slowly drifting wall of album
// art. The wall is turned monochrome and tinted with a colour taken from the
// playing song's cover. Uses the same player as the library view.
// =====================================================================
(() => {
  const th = $("#theater"), pan = $("#thPan"), app = $(".app");
  const ui = {
    cover: $(".th-cover"), art: $("#thArt"), artist: $("#thArtist"), album: $("#thAlbum"), title: $("#thTitle"),
    info: $("#thInfo"), synced: $("#thSynced"), locate: $("#thLocate"), details: $("#thDetails"),
    queue: $("#thQueue"), queueList: $("#thQueueList"), queueBtn: $("#thQueueBtn"),
    ptitle: $("#thPTitle"), seek: $("#thSeek"), elapsed: $("#thElapsed"), remain: $("#thRemain"),
    repeat: $("#thRepeat"), repeatBadge: $("#thRepeatBadge"), shuffle: $("#thShuffle"),
    prev: $("#thPrev"), play: $("#thPlay"), playIcon: $("#thPlayIcon"), next: $("#thNext"),
    full: $("#thFull"), fullIcon: $("#thFullIcon"), close: $("#thClose"), back: $("#thBack"),
    vol: $("#thVol"), volText: $("#thVolText"),
  };
  const GAP = 3;                       // dark seams between tiles
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  let isOpen = false, tiles = [], unit = 120, swapTimer = 0, idleTimer = 0, resizeTimer = 0;
  let candidates = [], candIndex = 0, shownTrackId = null, seeking = false, lastFocus = null;
  const missingArt = new Set();       // song ids whose album has no art

  // ---------------------------------------------------------------
  // Albums for the wall: one song per album (folder + album name).
  // ---------------------------------------------------------------
  function albumCandidates() {
    const albums = new Map();
    for (const t of state.tracks) {
      const folder = t.rel.replace(/[\\/][^\\/]*$/, "").toLowerCase();
      const key = `${folder}|${(t.album || "").toLowerCase()}`;
      if (!albums.has(key)) albums.set(key, t);
    }
    const list = [...albums.values()];
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }
  const artLeft = () => candidates.some((t) => !missingArt.has(t.id));
  function nextCandidate() {
    if (!candidates.length) return null;
    for (let tries = 0; tries < candidates.length; tries++) {
      const t = candidates[candIndex++ % candidates.length];
      if (!missingArt.has(t.id)) return t;
    }
    return candidates[candIndex++ % candidates.length];   // no art anywhere: lettered tiles
  }

  // ---------------------------------------------------------------
  // The wall: tiles of 1x1, 2x2 and 3x3 units packed into a grid a bit
  // larger than the window, so it can drift.
  // ---------------------------------------------------------------
  function buildWall() {
    clearInterval(swapTimer);
    const W = th.clientWidth, H = th.clientHeight;
    unit = Math.round(Math.max(84, Math.min(170, H / 6.4)));
    const cols = Math.ceil((W * 1.2) / unit) + 1, rows = Math.ceil((H * 1.2) / unit) + 1;
    const used = Array.from({ length: rows }, () => new Uint8Array(cols));
    const fits = (r, c, s) => {
      if (r + s > rows || c + s > cols) return false;
      for (let i = 0; i < s; i++) for (let j = 0; j < s; j++) if (used[r + i][c + j]) return false;
      return true;
    };
    tiles = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (used[r][c]) continue;
        const roll = Math.random();
        let s = roll < 0.08 ? 3 : roll < 0.32 ? 2 : 1;
        while (s > 1 && !fits(r, c, s)) s--;
        for (let i = 0; i < s; i++) for (let j = 0; j < s; j++) used[r + i][c + j] = 1;
        tiles.push({ r, c, s });
      }
    }
    pan.textContent = "";
    pan.style.width = `${cols * unit}px`;
    pan.style.height = `${rows * unit}px`;
    pan.style.setProperty("--dx", `${-(cols * unit - W)}px`);
    pan.style.setProperty("--dy", `${-(rows * unit - H)}px`);
    const frag = document.createDocumentFragment();
    for (const t of tiles) {
      t.el = document.createElement("div");
      t.el.className = "th-tile";
      t.el.style.cssText = `left:${t.c * unit}px;top:${t.r * unit}px;width:${t.s * unit - GAP}px;height:${t.s * unit - GAP}px`;
      frag.append(t.el);
    }
    pan.append(frag);
    // Fill the big tiles first, a few at a time, so the wall builds up as it opens.
    [...tiles].sort((a, b) => b.s - a.s).forEach((t, i) => setTimeout(() => isOpen && fillTile(t), i * 22));
    swapTimer = setInterval(swapTile, reduceMotion.matches ? 9000 : 2400);
  }

  function fillTile(tile, track = nextCandidate(), attempts = 0) {
    if (!track || !tile.el) return;
    tile.track = track;
    if (missingArt.has(track.id)) { letterTile(tile, track); return; }
    const img = new Image();
    img.alt = "";
    img.decoding = "async";
    img.onload = () => {
      if (tile.track !== track) return;
      tile.el.append(img);
      void img.offsetWidth;                      // start the fade from transparent
      img.classList.add("on");
      retireOthers(tile, img);
    };
    img.onerror = () => {
      missingArt.add(track.id);
      if (tile.track !== track) return;
      if (attempts < 4 && artLeft()) fillTile(tile, nextCandidate(), attempts + 1);
      else letterTile(tile, track);
    };
    img.src = `/api/art/${track.id}?size=${tile.s * unit > 330 ? "large" : "small"}`;
  }

  /** Albums without art get a typographic tile instead. */
  function letterTile(tile, track) {
    const d = document.createElement("div");
    d.className = "th-type";
    const words = (track.album || track.title || "").split(/\s+/);
    const longest = Math.max(4, ...words.map((w) => w.length));
    const w = tile.s * unit * 0.8;                       // fit the longest word on one line
    d.style.fontSize = `${Math.round(Math.min(w / 5.2, w / (longest * 0.76)))}px`;
    d.innerHTML = `<b>${esc(track.album || track.title)}</b><small>${esc(track.artist)}</small>`;
    tile.el.append(d);
    void d.offsetWidth;
    d.classList.add("on");
    retireOthers(tile, d);
  }

  /** After the fade, remove the layers underneath (only older ones: a newer one may be fading in). */
  function retireOthers(tile, keep) {
    setTimeout(() => {
      let el = keep.previousElementSibling;
      while (el) { const prev = el.previousElementSibling; el.remove(); el = prev; }
    }, 1800);
  }

  function swapTile() {
    if (!tiles.length || document.hidden) return;
    const small = tiles.filter((t) => t.s < 3);
    const tile = (small.length ? small : tiles)[Math.floor(Math.random() * (small.length || tiles.length))];
    fillTile(tile);
  }

  /** On a new song, put its album on one of the big tiles near the middle. */
  function featureCurrent(track) {
    const W = th.clientWidth, H = th.clientHeight;
    const near = tiles.filter((t) => t.s >= 2 && t.c * unit < W * 0.75 && t.r * unit < H * 0.7);
    const pick = near[Math.floor(Math.random() * near.length)];
    if (pick && !missingArt.has(track.id)) fillTile(pick, track);
  }

  // ---------------------------------------------------------------
  // Colour: tint the wall with the cover's most characteristic colour.
  // ---------------------------------------------------------------
  const DEFAULT_HUE = 328;
  function setAccent(hue, sat = 0.7) {
    const s = Math.round(Math.min(0.82, Math.max(0.5, sat)) * 100);
    th.style.setProperty("--th-accent", `hsl(${hue} ${s}% 46%)`);
    th.style.setProperty("--th-accent-text", `hsl(${hue} 90% 72%)`);
    // Keep two tones: a warm gold above, unless the cover itself is gold-ish.
    const goldish = hue >= 25 && hue <= 70;
    th.style.setProperty("--th-warm", goldish ? `hsl(${(hue + 170) % 360} 30% 42%)` : "#a08a4a");
  }
  function accentFromImage(img) {
    try {
      const c = document.createElement("canvas");
      c.width = c.height = 32;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 32, 32);
      const px = ctx.getImageData(0, 0, 32, 32).data;
      let x = 0, y = 0, wsum = 0, ssum = 0;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
        if (d < 0.08) continue;                          // greys say nothing about colour
        const s = d / (1 - Math.abs(2 * l - 1));
        let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        h *= 60;
        const w = s * (1 - Math.abs(l - 0.5) * 1.6);
        x += Math.cos((h * Math.PI) / 180) * w;
        y += Math.sin((h * Math.PI) / 180) * w;
        wsum += w; ssum += s * w;
      }
      if (wsum < 8) { setAccent(DEFAULT_HUE); return; }
      setAccent(Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360), ssum / wsum);
    } catch { setAccent(DEFAULT_HUE); }
  }

  // ---------------------------------------------------------------
  // Now playing, queue, progress, controls
  // ---------------------------------------------------------------
  const PLAY = '<path d="M8 5v14l11-7z"/>', PAUSE = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
  const FULL_ON = '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>';
  const FULL_OFF = '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>';

  function updateAll() {
    const t = player.current;
    const playing = player.state === "playing";
    th.classList.toggle("playing", playing);
    ui.playIcon.innerHTML = playing ? PAUSE : PLAY;
    ui.play.setAttribute("aria-label", playing ? "Pause" : "Play");
    if (!t) {
      ui.artist.textContent = "Nothing playing";
      ui.album.textContent = "";
      ui.title.textContent = "Pick a song in the library";
      ui.ptitle.textContent = "";
      ui.cover.classList.add("blank");
      ui.art.removeAttribute("src");
      shownTrackId = null;
      renderQueue();
      return;
    }
    ui.artist.textContent = t.artist || "Unknown artist";
    ui.album.textContent = t.album || "";
    ui.title.textContent = t.title;
    ui.ptitle.textContent = t.title;
    ui.synced.setAttribute("aria-pressed", String(!!t.selected));
    ui.synced.title = t.selected ? "On your device list (click to untick)" : "Keep on device (ticks Synced?)";
    if (shownTrackId !== t.id) {
      shownTrackId = t.id;
      ui.cover.classList.remove("blank");
      ui.art.src = `/api/art/${t.id}?size=large`;
      featureCurrent(t);
      renderQueue();
    }
    if (!ui.details.hidden) renderDetails();
  }

  ui.art.addEventListener("load", () => accentFromImage(ui.art));
  ui.art.addEventListener("error", () => { ui.cover.classList.add("blank"); setAccent(DEFAULT_HUE); });

  function renderQueue() {
    const order = player.order, cur = player.index;
    if (!order.length || !player.current) { ui.queueList.innerHTML = ""; return; }
    const start = Math.max(0, cur - 2), end = Math.min(order.length, cur + 200);
    let html = "";
    for (let i = start; i < end; i++) {
      const t = order[i];
      const cls = i === cur ? "current" : i < cur ? "played" : "";
      const mark = i === cur ? '<span class="th-eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>' : '<span class="th-eq" aria-hidden="true"></span>';
      html += `<li class="${cls}" data-idx="${i}" tabindex="0"${i === cur ? ' aria-current="true"' : ""}>${mark}` +
        `<span class="th-q-title">${esc(t.title)}</span><span class="th-q-artist">${esc(t.artist || "")}</span></li>`;
    }
    ui.queueList.innerHTML = html;
    const curEl = ui.queueList.querySelector(".current");
    // Show one finished song above the current one, aligned to whole rows.
    const anchor = curEl && (curEl.previousElementSibling || curEl);
    if (anchor) ui.queueList.scrollTop = Math.max(0, anchor.offsetTop - ui.queueList.offsetTop);
  }

  function playQueueItem(li) {
    const idx = +li.dataset.idx;
    if (!Number.isFinite(idx) || !player.order[idx]) return;
    player.index = idx;
    player.playIndex();
  }
  ui.queueList.addEventListener("click", (e) => { const li = e.target.closest("li[data-idx]"); if (li) playQueueItem(li); });
  ui.queueList.addEventListener("keydown", (e) => {
    const li = e.target.closest("li[data-idx]");
    if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.stopPropagation(); playQueueItem(li); }
  });

  function renderDetails() {
    const t = player.current;
    if (!t) { ui.details.innerHTML = ""; return; }
    const conv = state.playingConverted && state.playingConverted.id === t.id
      ? ` (playing as ${state.playingConverted.to}, converted)` : "";
    const rows = [
      ["Format", (t.rel.match(/\.([^.\\/]+)$/) || [, "?"])[1].toUpperCase() + conv],
      ["Bitrate", t.bitrate ? `${t.bitrate} kbps` : "–"],
      ["Sample rate", t.sampleRate ? `${+(t.sampleRate / 1000).toFixed(1)} kHz` : "–"],
      ["Length", fmtTime(t.duration)],
      ["Size", fmtSize(t.size)],
      ["Year / genre", [t.year || "", t.genre].filter(Boolean).join(" · ") || "–"],
      ["Device", { on: "On device", copy: "To copy", remove: "To remove", none: state.device ? "Not on device" : "No device connected" }[statusOf(t)]],
      ["File", t.rel],
    ];
    ui.details.innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`).join("");
  }

  function updateProgress() {
    if (!isOpen) return;
    const a = $("#audio");
    const dur = isFinite(a.duration) ? a.duration : (player.current ? player.current.duration : 0);
    const pos = seeking ? +ui.seek.value : a.currentTime;
    ui.seek.max = dur || 0;
    if (!seeking) ui.seek.value = pos;
    ui.seek.style.setProperty("--pct", dur ? `${(pos / dur) * 100}%` : "0%");
    ui.elapsed.textContent = fmtTime(pos);
    ui.remain.textContent = "-" + fmtTime(Math.max(0, dur - pos));
  }
  $("#audio").addEventListener("timeupdate", updateProgress);
  $("#audio").addEventListener("loadedmetadata", updateProgress);
  ui.seek.addEventListener("input", () => { seeking = true; updateProgress(); });
  ui.seek.addEventListener("change", () => {
    if (player.current) $("#audio").currentTime = +ui.seek.value;
    seeking = false;
  });

  function updateModes() {
    ui.shuffle.setAttribute("aria-pressed", String(player.shuffle));
    ui.shuffle.title = `Shuffle: ${player.shuffle ? "on" : "off"}`;
    ui.shuffle.setAttribute("aria-label", ui.shuffle.title);
    ui.repeat.setAttribute("aria-pressed", String(player.repeat !== "off"));
    ui.repeat.title = `Repeat: ${player.repeat}`;
    ui.repeat.setAttribute("aria-label", ui.repeat.title);
    ui.repeatBadge.hidden = player.repeat === "off";
    ui.repeatBadge.textContent = player.repeat === "once" ? "1" : "∞";
  }

  function syncVolume() {
    const v = +$("#volume").value;
    ui.vol.value = v;
    ui.volText.textContent = Math.round(v * 100);
  }
  ui.vol.addEventListener("input", () => {
    $("#volume").value = ui.vol.value;
    $("#volume").dispatchEvent(new Event("input"));   // same path as the library's slider (saves it too)
    ui.volText.textContent = Math.round(+ui.vol.value * 100);
  });

  ui.play.addEventListener("click", () => $("#playBtn").click());
  ui.prev.addEventListener("click", () => player.previous());
  ui.next.addEventListener("click", () => player.next());
  ui.shuffle.addEventListener("click", () => { $("#shuffleBtn").click(); updateModes(); renderQueue(); });
  ui.repeat.addEventListener("click", () => { $("#repeatBtn").click(); updateModes(); });
  ui.queueBtn.addEventListener("click", () => {
    const show = ui.queue.hidden;
    ui.queue.hidden = !show;
    th.classList.toggle("queue-hidden", !show);
    ui.queueBtn.setAttribute("aria-pressed", String(show));
    savePref("musicsync.theaterQueue", show ? "on" : "off");
    if (show) renderQueue();
  });
  ui.info.addEventListener("click", () => {
    const show = ui.details.hidden;
    ui.details.hidden = !show;
    ui.info.setAttribute("aria-pressed", String(show));
    if (show) renderDetails();
  });
  ui.synced.addEventListener("click", () => {
    const t = player.current;
    if (!t) return;
    setChecked([t.id], !t.selected);          // same as ticking Synced? (auto-sync follows)
    updateAll();
  });
  ui.locate.addEventListener("click", () => {
    const t = player.current;
    closeTheater();
    if (!t) return;
    if (indexInView(t.id) < 0) { $("#filter").value = ""; state.filter = ""; applyView(); }
    state.sel = new Set([t.id]);
    state.focus = state.anchor = t.id;
    ensureVisible(indexInView(t.id));
    render();
    grid.focus({ preventScroll: true });
  });

  // ---------------------------------------------------------------
  // Full screen and idle cursor
  // ---------------------------------------------------------------
  function renderFull() {
    const on = !!document.fullscreenElement;
    ui.fullIcon.innerHTML = on ? FULL_OFF : FULL_ON;
    ui.full.title = on ? "Exit full screen (F)" : "Full screen (F)";
    ui.full.setAttribute("aria-label", ui.full.title);
  }
  function toggleFull() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }
  ui.full.addEventListener("click", toggleFull);
  document.addEventListener("fullscreenchange", renderFull);
  renderFull();

  function wake() {
    th.classList.remove("idle");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => th.classList.add("idle"), 3000);
  }
  th.addEventListener("mousemove", wake);

  // ---------------------------------------------------------------
  // Open / close
  // ---------------------------------------------------------------
  function openTheater(startTrack) {
    if (startTrack) playFromView(startTrack);
    else if (!player.current) {
      const t = byId(state.focus) || state.view[0];
      if (t) playFromView(t);
    }
    if (isOpen) return;
    isOpen = true;
    lastFocus = document.activeElement;
    th.hidden = false;
    app.inert = true;
    const showQueue = loadPref("musicsync.theaterQueue", "on") === "on";
    ui.queue.hidden = !showQueue;
    th.classList.toggle("queue-hidden", !showQueue);
    ui.queueBtn.setAttribute("aria-pressed", String(showQueue));
    candidates = albumCandidates();
    candIndex = 0;
    shownTrackId = null;
    setAccent(DEFAULT_HUE);
    buildWall();
    updateAll();
    updateModes();
    syncVolume();
    updateProgress();
    wake();
    th.focus({ preventScroll: true });
  }

  function closeTheater() {
    if (!isOpen) return;
    isOpen = false;
    clearInterval(swapTimer);
    clearTimeout(idleTimer);
    th.hidden = true;
    app.inert = false;
    pan.textContent = "";
    tiles = [];
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    (lastFocus && document.contains(lastFocus) ? lastFocus : grid).focus({ preventScroll: true });
  }
  ui.back.addEventListener("click", closeTheater);
  ui.close.addEventListener("click", closeTheater);

  th.addEventListener("keydown", (e) => {
    const onControl = e.target.matches("input, button, li[data-idx]");
    if (e.key === "Escape") { e.preventDefault(); closeTheater(); }
    else if (e.key === " " && !onControl) { e.preventDefault(); $("#playBtn").click(); }
    else if ((e.key === "f" || e.key === "F") && !e.ctrlKey && !e.metaKey) { toggleFull(); }
    else if (e.key === "ArrowRight" && !e.target.matches("input")) { e.preventDefault(); player.next(); }
    else if (e.key === "ArrowLeft" && !e.target.matches("input")) { e.preventDefault(); player.previous(); }
    wake();
  });

  // T opens Theater mode from the library.
  document.addEventListener("keydown", (e) => {
    if (isOpen || e.ctrlKey || e.metaKey || e.altKey || (e.key !== "t" && e.key !== "T")) return;
    if (e.target.matches("input, textarea, select") || document.querySelector("dialog[open]")) return;
    e.preventDefault();
    openTheater();
  });

  $("#theaterBtn").addEventListener("click", () => openTheater());
  $("#ctx").addEventListener("click", (e) => {
    if (e.target.closest("button")?.dataset.act === "theater" && byId(state.focus)) openTheater(byId(state.focus));
  });

  addEventListener("resize", () => {
    if (!isOpen) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(buildWall, 300);
  });

  // ---------------------------------------------------------------
  // Album art in the library's player bar and in the system media overlay
  // ---------------------------------------------------------------
  const nowArt = $("#nowArt");
  let nowArtId = null;
  nowArt.addEventListener("error", () => { nowArt.hidden = true; });
  nowArt.addEventListener("load", () => { nowArt.hidden = false; });

  const baseOnChange = player.onchange;
  player.onchange = () => {
    baseOnChange();
    const t = player.current;
    if (!t) { nowArt.hidden = true; nowArtId = null; }
    else if (t.id !== nowArtId) {
      nowArtId = t.id;
      nowArt.src = `/api/art/${t.id}?size=small`;
      if ("mediaSession" in navigator && navigator.mediaSession.metadata) {
        navigator.mediaSession.metadata.artwork = [
          { src: `${location.origin}/api/art/${t.id}?size=large`, sizes: "800x800", type: "image/jpeg" },
        ];
      }
    }
    if (isOpen) updateAll();
  };
})();
