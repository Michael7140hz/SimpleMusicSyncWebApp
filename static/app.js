"use strict";

// =====================================================================
// Small helpers
// =====================================================================
const $ = (s) => document.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function fmtTime(sec) {
  if (!isFinite(sec) || sec <= 0) return "0:00";
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
function fmtSize(bytes) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
}

async function handle(r) {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data && data.error) || `${r.status} ${r.statusText}`);
  return data;
}
/** Thrown when the page can't reach the server at all (as opposed to the server reporting an error). */
class ConnectionLost extends Error {
  constructor() {
    super("The page lost its connection to the MusicSync server.");
    this.connectionLost = true;
  }
}
const netFetch = (url, opts) => fetch(url, opts).catch(() => { throw new ConnectionLost(); });

const api = {
  get: (url) => netFetch(url).then(handle),
  send: (url, body, method = "POST") => netFetch(url, {
    method,
    headers: { "Content-Type": "application/json", "X-MusicSync": "1" },
    body: JSON.stringify(body ?? {}),
  }).then(handle),
};

async function serverAlive() {
  for (let i = 0; i < 5; i++) {               // give a briefly busy server a few seconds
    try { await api.get("/api/ping"); return true; } catch { await sleep(1000); }
  }
  return false;
}

const SERVER_DOWN_HELP =
  "The MusicSync server isn't answering.\n\n" +
  "Look for the MusicSync icon in the system tray, next to the clock " +
  "(it may be under the ^ arrow). If it's gone, run start.bat again.\n\n" +
  "If this keeps happening, send me the musicsync.log file from the app folder " +
  "(tray icon > Show log file).\n\n" +
  "Security software can also block or stop programs that delete files on USB drives. " +
  "If you use any, check whether it reported MusicSync or pythonw.exe.";

function setStatus(text) { $("#statusText").textContent = text; }

// =====================================================================
// State
// =====================================================================
const state = {
  tracks: [],
  byId: new Map(),          // song id (stable, from the library index) -> song
  tracksVersion: -1,
  playErrors: new Map(),    // song id -> why it couldn't be played
  view: [],                 // filtered + sorted list shown in the grid
  sortKey: null, sortDir: 1,
  filter: "",
  sel: new Set(),           // highlighted rows (ids)
  anchor: null, focus: null,
  device: null,             // connected device { folder, space }
  savedDevice: null,        // remembered device folder, even when unplugged
  busy: false,
};

const STATUS = {
  none: { label: "", rank: 0 },
  copy: { label: "To copy", rank: 2 },
  on: { label: "On device", rank: 1 },
  remove: { label: "To remove", rank: 3 },
};
const byId = (id) => state.byId.get(id);

function statusOf(t) {
  if (!state.device) return "none";
  if (t.selected && t.onDevice) return "on";
  if (t.selected) return "copy";
  if (t.onDevice) return "remove";
  return "none";
}

const byStr = (f) => (t) => (f(t) || "").toLowerCase();
const COLS = [
  { key: "selected", label: "On device?", cls: "c-check", sort: (t) => (t.selected ? 0 : 1) },
  { key: "status", label: "Device status", sort: (t) => STATUS[statusOf(t)].rank || 9 },
  { key: "title", label: "Title", cls: "c-title", text: (t) => t.title, sort: byStr((t) => t.title) },
  { key: "artist", label: "Artist", text: (t) => t.artist, sort: byStr((t) => t.artist) },
  { key: "album", label: "Album", text: (t) => t.album, sort: byStr((t) => t.album) },
  { key: "genre", label: "Genre", text: (t) => t.genre, sort: byStr((t) => t.genre) },
  { key: "year", label: "Year", num: true, text: (t) => t.year || "", sort: (t) => t.year },
  { key: "track", label: "#", num: true, text: (t) => t.track || "", sort: (t) => t.track },
  { key: "duration", label: "Length", num: true, text: (t) => fmtTime(t.duration), sort: (t) => t.duration },
  { key: "bitrate", label: "Bitrate", num: true, text: (t) => (t.bitrate ? `${t.bitrate} kbps` : ""), sort: (t) => t.bitrate },
  { key: "sampleRate", label: "Sample rate", num: true, text: (t) => (t.sampleRate ? `${+(t.sampleRate / 1000).toFixed(1)} kHz` : ""), sort: (t) => t.sampleRate },
  { key: "size", label: "Size", num: true, text: (t) => fmtSize(t.size), sort: (t) => t.size },
  { key: "rel", label: "File", text: (t) => t.rel, sort: byStr((t) => t.rel) },
];

// =====================================================================
// Grid (virtualised: only visible rows are in the page)
// =====================================================================
const grid = $("#grid"), gridHead = $("#gridHead"), gridBody = $("#gridBody");
const ROW = 30;

function renderHead() {
  gridHead.innerHTML = COLS.map((c) => {
    const arrow = state.sortKey === c.key ? `<span class="arrow">${state.sortDir > 0 ? "▲" : "▼"}</span>` : "";
    return `<div class="${c.num ? "num" : ""}" data-key="${c.key}" title="Sort by ${esc(c.label)}">${esc(c.label)}${arrow}</div>`;
  }).join("");
}

function applyView() {
  const q = state.filter.trim().toLowerCase();
  let v = q
    ? state.tracks.filter((t) => [t.title, t.artist, t.album, t.genre, t.rel].some((s) => (s || "").toLowerCase().includes(q)))
    : state.tracks.slice();
  const col = COLS.find((c) => c.key === state.sortKey);
  if (col) {
    const dir = state.sortDir;
    v = v.map((t) => [col.sort(t), t]).sort((a, b) => (a[0] < b[0] ? -dir : a[0] > b[0] ? dir : a[1].id - b[1].id)).map((p) => p[1]);
  }
  state.view = v;
  gridBody.style.height = `${v.length * ROW}px`;
  $("#empty").hidden = state.tracks.length > 0 || state.busy;
  render();
}

let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

const ERR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18h.01" class="mark"/></svg>';

/** Updates highlight classes on the rows already on screen, without redrawing them. Redrawing
 *  on every click replaced the row under the mouse, which stopped double-click from working. */
function refreshRowClasses() {
  const playingId = player.current ? player.current.id : -1;
  for (const row of gridBody.children) {
    const id = +row.dataset.id;
    row.classList.toggle("is-sel", state.sel.has(id));
    row.classList.toggle("is-focus", state.focus === id);
    row.classList.toggle("is-playing", id === playingId);
  }
}

function render() {
  const top = grid.scrollTop;
  const start = Math.max(0, Math.floor(top / ROW) - 10);
  const end = Math.min(state.view.length, Math.ceil((top + grid.clientHeight) / ROW) + 10);
  const playingId = player.current ? player.current.id : -1;
  let html = "";
  for (let i = start; i < end; i++) {
    const t = state.view[i];
    const st = statusOf(t);
    const cls = ["row"];
    if (i % 2) cls.push("alt");
    if (state.sel.has(t.id)) cls.push("is-sel");
    if (state.focus === t.id) cls.push("is-focus");
    if (t.id === playingId) cls.push("is-playing");
    html += `<div class="${cls.join(" ")}" data-id="${t.id}" style="top:${i * ROW}px">`;
    for (const c of COLS) {
      if (c.key === "selected") {
        html += `<div class="c-check"><input type="checkbox" class="chk" ${t.selected ? "checked" : ""} aria-label="Keep ${esc(t.title)} on the device"></div>`;
      } else if (c.key === "status") {
        html += `<div class="st-${st}">${STATUS[st].label}</div>`;
      } else if (c.key === "title" && state.playErrors.has(t.id)) {
        const why = esc("Can't play: " + state.playErrors.get(t.id));
        const text = esc(c.text(t));
        html += `<div class="c-title has-error" title="${why}"><span class="err-icon" role="img" aria-label="${why}">${ERR_ICON}</span>${text}</div>`;
      } else {
        const text = esc(c.text(t));
        html += `<div class="${c.num ? "num" : ""} ${c.cls || ""}" title="${text}">${text}</div>`;
      }
    }
    html += "</div>";
  }
  gridBody.innerHTML = html;
}

function trackFromEvent(e) {
  const row = e.target.closest(".row");
  return row ? byId(+row.dataset.id) : null;
}

function indexInView(id) { return state.view.findIndex((t) => t.id === id); }

function selectRange(fromId, toId) {
  const a = indexInView(fromId), b = indexInView(toId);
  if (a < 0 || b < 0) return;
  state.sel.clear();
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) state.sel.add(state.view[i].id);
}

function ensureVisible(index) {
  const headH = gridHead.offsetHeight;
  const rowTop = index * ROW, rowBottom = rowTop + ROW;
  const viewTop = grid.scrollTop, viewBottom = viewTop + grid.clientHeight - headH;
  if (rowTop < viewTop) grid.scrollTop = rowTop;
  else if (rowBottom > viewBottom) grid.scrollTop = rowBottom - (grid.clientHeight - headH);
}

function setChecked(ids, value) {
  const changed = ids.filter((id) => byId(id) && !!byId(id).selected !== value);
  for (const id of changed) byId(id).selected = value;
  updateSummary();
  render();
  if (changed.length) {
    // Saved in the library index, so ticks survive restarts.
    api.send("/api/selection", { ids: changed, selected: value })
      .catch((err) => setStatus("Couldn't save your ticks: " + err.message));
  }
}

gridHead.addEventListener("click", (e) => {
  const cell = e.target.closest("[data-key]");
  if (!cell) return;
  const key = cell.dataset.key;
  if (state.sortKey === key) state.sortDir = -state.sortDir;
  else { state.sortKey = key; state.sortDir = 1; }
  renderHead();
  applyView();
});

grid.addEventListener("scroll", queueRender);
window.addEventListener("resize", queueRender);

gridBody.addEventListener("click", (e) => {
  const t = trackFromEvent(e);
  if (!t) return;
  if (e.target.classList.contains("chk")) {
    // Ticking a highlighted row ticks every highlighted row.
    const ids = state.sel.has(t.id) && state.sel.size > 1 ? [...state.sel] : [t.id];
    setChecked(ids, e.target.checked);
    return;
  }
  if (e.shiftKey && state.anchor != null) selectRange(state.anchor, t.id);
  else if (e.ctrlKey || e.metaKey) {
    state.sel.has(t.id) ? state.sel.delete(t.id) : state.sel.add(t.id);
    state.anchor = t.id;
  } else {
    state.sel = new Set([t.id]);
    state.anchor = t.id;
  }
  state.focus = t.id;
  refreshRowClasses();
  grid.focus({ preventScroll: true });

  // Double-click detection that doesn't depend on the row element staying the same.
  const now = performance.now();
  const plain = !e.shiftKey && !e.ctrlKey && !e.metaKey;
  if (plain && lastClick.id === t.id && now - lastClick.time < 450) {
    lastClick = { id: null, time: 0 };
    playFromView(t);
  } else {
    lastClick = { id: t.id, time: now };
  }
});
let lastClick = { id: null, time: 0 };

grid.addEventListener("keydown", (e) => {
  if (e.target !== grid && !e.target.classList.contains("chk")) return;
  const n = state.view.length;
  if (!n) return;
  let idx = state.focus != null ? indexInView(state.focus) : -1;

  const move = (to) => {
    to = Math.max(0, Math.min(n - 1, to));
    const id = state.view[to].id;
    if (e.shiftKey && state.anchor != null) selectRange(state.anchor, id);
    else { state.sel = new Set([id]); state.anchor = id; }
    state.focus = id;
    ensureVisible(to);
    render();
    e.preventDefault();
  };
  const page = Math.max(1, Math.floor(grid.clientHeight / ROW) - 2);

  switch (e.key) {
    case "ArrowDown": move(idx + 1); break;
    case "ArrowUp": move(idx < 0 ? 0 : idx - 1); break;
    case "PageDown": move(idx + page); break;
    case "PageUp": move(idx - page); break;
    case "Home": move(0); break;
    case "End": move(n - 1); break;
    case " ": {
      e.preventDefault();
      const ids = state.sel.size ? [...state.sel] : (state.focus != null ? [state.focus] : []);
      if (!ids.length) return;
      // If any highlighted song is unticked, tick them all; otherwise untick them all.
      setChecked(ids, ids.some((id) => !byId(id).selected));
      break;
    }
    case "Enter":
      if (state.focus != null && byId(state.focus)) { playFromView(byId(state.focus)); e.preventDefault(); }
      break;
    case "a":
      if (e.ctrlKey || e.metaKey) {
        state.sel = new Set(state.view.map((t) => t.id));
        render();
        e.preventDefault();
      }
      break;
  }
});

// ---------- Context menu ----------
const ctx = $("#ctx");
gridBody.addEventListener("contextmenu", (e) => {
  const t = trackFromEvent(e);
  if (!t) return;
  e.preventDefault();
  if (!state.sel.has(t.id)) { state.sel = new Set([t.id]); state.anchor = t.id; }
  state.focus = t.id;
  render();
  ctx.hidden = false;
  const w = ctx.offsetWidth, h = ctx.offsetHeight;
  ctx.style.left = `${Math.min(e.clientX, innerWidth - w - 8)}px`;
  ctx.style.top = `${Math.min(e.clientY, innerHeight - h - 8)}px`;
});
document.addEventListener("click", (e) => { if (!ctx.contains(e.target)) ctx.hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") ctx.hidden = true; });
ctx.addEventListener("click", async (e) => {
  const act = e.target.closest("button")?.dataset.act;
  if (!act) return;
  ctx.hidden = true;
  const ids = [...state.sel];
  if (act === "play" && byId(state.focus)) playFromView(byId(state.focus));
  if (act === "check") setChecked(ids, true);
  if (act === "uncheck") setChecked(ids, false);
  if (act === "reveal" && state.focus != null) {
    try { await api.send("/api/reveal", { id: state.focus }); } catch (err) { setStatus(err.message); }
  }
});

$("#filter").addEventListener("input", (e) => { state.filter = e.target.value; applyView(); });

// =====================================================================
// Summary / device info
// =====================================================================
function updateSummary() {
  let checked = 0, copy = 0, remove = 0, bytes = 0;
  for (const t of state.tracks) {
    if (t.selected) checked++;
    const st = statusOf(t);
    if (st === "copy") { copy++; bytes += t.size; }
    else if (st === "remove") remove++;
  }
  $("#syncSummary").textContent = state.device
    ? `${copy.toLocaleString()} to copy (${fmtSize(bytes)}), ${remove.toLocaleString()} to remove`
    : `${checked.toLocaleString()} checked`;
  $("#syncBtn").disabled = state.busy || !state.device || (copy === 0 && remove === 0);
}

function updateDeviceInfo() {
  const d = state.device;
  const el = $("#deviceInfo");
  if (!d) {
    el.textContent = state.savedDevice
      ? `${state.savedDevice} isn't connected. Plug the drive in and it reconnects automatically.`
      : "No device chosen";
    el.title = state.savedDevice || "";
    return;
  }
  el.textContent = d.space
    ? `Copying to ${d.folder}  (${fmtSize(d.space.free)} free of ${fmtSize(d.space.total)})`
    : `Copying to ${d.folder}`;
  el.title = d.folder;
}

// =====================================================================
// Busy state and background jobs
// =====================================================================
function setBusy(busy) {
  state.busy = busy;
  for (const el of document.querySelectorAll("#libraryBar button, #libraryBar input[type=checkbox], #deviceBar button, #deviceBar select")) {
    el.disabled = busy;
  }
  $("#busy").hidden = !busy;
  $("#empty").hidden = state.tracks.length > 0 || busy;
  if (busy) $("#progress").removeAttribute("value");
  updateSummary();
}

/** Polls the server until the current job ends. onEvent receives sync changes as they happen. */
async function watchJob(onEvent) {
  setBusy(true);
  let since = 0;
  try {
    let misses = 0;
    for (;;) {
      let j;
      try {
        j = await api.get(`/api/job?since=${since}`);
        misses = 0;
      } catch (err) {
        if (!err.connectionLost || ++misses > 10) throw err;   // ride out short hiccups
        setStatus("Waiting for the MusicSync server…");
        await sleep(1000);
        continue;
      }
      if (!j) return null;
      if (j.tracksVersion != null && j.tracksVersion !== state.tracksVersion) await loadTracks();
      if (j.total) { $("#progress").max = j.total; $("#progress").value = j.done; }
      setStatus(j.total && j.running ? `[${j.done.toLocaleString()}/${j.total.toLocaleString()}] ${j.message}` : j.message);
      if (onEvent && j.events.length) { j.events.forEach(onEvent); queueRender(); updateSummary(); }
      since = j.eventCount;
      if (!j.running) return j;
      await sleep(300);
    }
  } finally {
    setBusy(false);
  }
}

$("#cancelBtn").addEventListener("click", () => api.send("/api/job/cancel").catch(() => {}));

// =====================================================================
// Library
// =====================================================================
async function loadTracks() {
  const { tracks, version } = await api.get("/api/tracks");
  state.tracksVersion = version;
  for (const t of tracks) t.selected = !!t.selected;   // saved ticks come from the library index
  state.tracks = tracks;
  state.byId = new Map(tracks.map((t) => [t.id, t]));
  // Ids are stable between rescans, so playback and highlights carry over.
  if (player.current && !state.byId.has(player.current.id)) player.stop();
  state.sel = new Set([...state.sel].filter((id) => state.byId.has(id)));
  if (!state.byId.has(state.focus)) state.focus = null;
  if (!state.byId.has(state.anchor)) state.anchor = null;
  applyView();
  updateSummary();
}

async function scanLibrary(folder) {
  try {
    const res = await api.send("/api/library", { folder, recursive: $("#recursive").checked });
    $("#libraryPath").value = folder;
    if (res.warning) { await message("Device cleared", res.warning); clearDeviceUi(); }
    await finishScan();
  } catch (err) {
    message("Couldn't open that folder", err.message);
  }
}

async function finishScan() {
  const job = await watchJob();      // reloads the list itself as the server updates it
  if (job && job.errors.length) message("Scan stopped", job.errors.join("\n"));
}

$("#browseLibrary").addEventListener("click", async () => {
  const folder = await pickFolder("Choose your music folder", $("#libraryPath").value, { mustExist: true });
  if (folder) scanLibrary(folder);
});
$("#emptyBrowse").addEventListener("click", () => $("#browseLibrary").click());
$("#rescan").addEventListener("click", () => {
  const folder = $("#libraryPath").value;
  if (folder) scanLibrary(folder); else $("#browseLibrary").click();
});

// =====================================================================
// Device
// =====================================================================
const samePath = (a, b) => !!a && !!b &&
  a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();

async function refreshDrives() {
  const sel = $("#driveSelect");
  if (document.activeElement === sel) return null;   // don't rebuild while the list is open
  let res;
  try { res = await api.get("/api/drives"); }
  catch (err) { setStatus("Couldn't list drives: " + err.message); return null; }

  const current = state.device ? state.device.folder : null;
  const options = res.drives.map((d) => ({
    value: d.musicPath,
    label: `${d.musicPath}   (${d.label}, ${fmtSize(d.free)} free)`,
    selected: samePath(current, d.musicPath),
  }));
  // A folder picked with "Choose folder…" gets its own entry so the list shows what's mapped.
  if (current && !options.some((o) => o.selected)) {
    const drive = res.drives.find((d) => current.toLowerCase().startsWith(d.root.toLowerCase()));
    const space = state.device.space ? `${fmtSize(state.device.space.free)} free` : "";
    const info = [drive && drive.label, space].filter(Boolean).join(", ");
    options.unshift({ value: current, label: info ? `${current}   (${info})` : current, selected: true });
  }
  const placeholder = current ? "" : (res.drives.length ? "Choose a drive…" : "No drives found");
  sel.innerHTML = (placeholder ? `<option value="">${placeholder}</option>` : "") +
    options.map((o) => `<option value="${esc(o.value)}" ${o.selected ? "selected" : ""}>${esc(o.label)}</option>`).join("");
  sel.title = current || "";
  return res;
}

/** Notices a device being unplugged, or the remembered one being plugged back in. */
async function checkDeviceConnection() {
  if (state.busy) return;
  const res = await refreshDrives();
  if (!res) return;
  const unplugged = state.device && res.deviceAvailable === false;
  const pluggedBackIn = !state.device && state.savedDevice && res.savedAvailable;
  if (!unplugged && !pluggedBackIn) return;
  try {
    applyDevice(await api.send("/api/device/refresh"));
    if (unplugged) setStatus(`${state.savedDevice} was disconnected. Your ticks are kept for when it's back.`);
    refreshDrives();
  } catch { /* busy or server away: try again on the next check */ }
}
setInterval(checkDeviceConnection, 4000);

/** Applies a device response from the server: which songs are on it and which are ticked. */
function applyDevice(res) {
  state.device = res.device;
  if ("savedDevice" in res) state.savedDevice = res.savedDevice;
  const on = new Set(res.onDevice);
  const ticked = res.selected ? new Set(res.selected) : null;
  for (const t of state.tracks) {
    t.onDevice = on.has(t.id);
    if (ticked) t.selected = ticked.has(t.id);
  }
  updateDeviceInfo();
  updateSummary();
  render();
  if (state.device) setStatus(`${on.size.toLocaleString()} of your songs are already on ${state.device.folder}.`);
}

function clearDeviceUi() {
  state.device = null;
  for (const t of state.tracks) t.onDevice = false;
  updateDeviceInfo(); updateSummary(); render(); refreshDrives();
}

async function setDevice(folder) {
  const hadDevice = !!state.device;
  setStatus("Checking which songs are on the device…");
  try {
    const res = await api.send("/api/device", { folder });
    applyDevice(res);
  } catch (err) {
    await message("Can't use that folder", err.message);
  }
  refreshDrives();
}

$("#driveSelect").addEventListener("change", (e) => { if (e.target.value) setDevice(e.target.value); });
$("#browseDevice").addEventListener("click", async () => {
  const folder = await pickFolder("Choose the folder on your device to copy songs into",
    state.device ? state.device.folder : "", { mustExist: false });
  if (folder) setDevice(folder);
});
$("#refreshDevice").addEventListener("click", async () => {
  if (!state.device && !state.savedDevice) { refreshDrives(); return; }
  const wasConnected = !!state.device;
  try {
    applyDevice(await api.send("/api/device/refresh"));
    if (!state.device) setStatus(`${state.savedDevice} isn't connected.`);
  } catch (err) { setStatus("Couldn't read the device: " + err.message); }
  refreshDrives();
});

$("#syncBtn").addEventListener("click", async () => {
  const copy = state.tracks.filter((t) => statusOf(t) === "copy").map((t) => t.id);
  const remove = state.tracks.filter((t) => statusOf(t) === "remove").map((t) => t.id);
  if (!copy.length && !remove.length) return;

  if (remove.length) {
    const ok = await message("Confirm sync",
      `${remove.length.toLocaleString()} unchecked song(s) will be deleted from\n${state.device.folder}\n\nYour original files are not touched.`,
      { okLabel: "Sync", cancel: true });
    if (!ok) return;
  }
  const requestedAt = Date.now() / 1000 - 2;
  try {
    await api.send("/api/sync", { copy, remove });
  } catch (err) {
    if (!err.connectionLost) { message("Can't sync", err.message); return; }
    // The reply got lost. Find out whether the server is up and the sync started anyway.
    setStatus("Lost touch with the server, checking…");
    if (!(await serverAlive())) { message("Can't sync", SERVER_DOWN_HELP); return; }
    let started = false;
    try {
      const j = await api.get("/api/job?since=0");
      started = !!(j && j.kind === "sync" && j.started >= requestedAt);
    } catch { /* treat as not started */ }
    if (!started) {
      message("Can't sync", "The sync request didn't reach the server. Press Sync to device to try again.");
      return;
    }
  }
  let job;
  try {
    job = await watchJob(([id, onDevice]) => { if (byId(id)) byId(id).onDevice = onDevice; });
  } catch (err) {
    await message("Sync interrupted", err.connectionLost ? SERVER_DOWN_HELP : err.message);
    // Re-read the device so the list shows what actually happened.
    try { applyDevice(await api.send("/api/device/refresh")); } catch { /* server still down */ }
    return;
  }
  try { state.device = (await api.get("/api/state")).device; } catch { /* ignore */ }
  updateDeviceInfo(); updateSummary(); render(); refreshDrives();
  if (job && job.errors.length) {
    const list = job.errors.slice(0, 15).join("\n") + (job.errors.length > 15 ? `\n…and ${job.errors.length - 15} more.` : "");
    message("Some files couldn't be synced", list);
  } else if (job && job.cancelled) {
    setStatus("Sync cancelled. Songs already copied stay on the device.");
  }
});

// =====================================================================
// Player
// =====================================================================
class Player {
  constructor(audio) {
    this.audio = audio;
    this.shuffle = false;          // random order
    this.repeat = "off";           // "off" | "once" | "forever"
    this.autoAdvance = true;       // go on to the next song when one ends
    this.source = []; this.order = []; this.index = -1;
    this.pass = 1;                 // which time through the list (auto-advance on)
    this.trackPlays = 0;           // times the current song has played (auto-advance off)
    this.failures = 0;
    this.current = null; this.state = "stopped";
    this.onchange = () => {}; this.onerror = () => {}; this.onplaying = () => {};

    audio.addEventListener("ended", () => this.onEnded());
    audio.addEventListener("playing", () => { this.failures = 0; if (this.current) this.onplaying(this.current); });
    audio.addEventListener("error", () => {
      if (!this.current) return;
      this.onerror(this.current, audio.error);
      if (!this.autoAdvance || ++this.failures >= Math.max(1, this.order.length)) { this.stop(); return; }
      this.next();
    });
  }

  setShuffle(on) {
    this.shuffle = on;
    if (this.source.length) this.buildOrder(this.current);
  }
  setRepeat(mode) { this.repeat = mode; this.pass = 1; }
  setAutoAdvance(on) { this.autoAdvance = on; }

  play(list, start) {
    if (!list.length) return;
    this.source = list.slice();
    this.buildOrder(start || (this.shuffle ? null : this.source[0]));
    this.pass = 1; this.failures = 0;
    this.playIndex();
  }

  /** Puts `first` at the front when shuffling, otherwise keeps list order. */
  buildOrder(first) {
    if (this.shuffle) {
      const a = this.source.slice();
      for (let i = a.length - 1; i > 0; i--) {         // Fisher–Yates shuffle
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      if (first) { const k = a.indexOf(first); if (k >= 0) { a.splice(k, 1); a.unshift(first); } }
      this.order = a; this.index = 0;
    } else {
      this.order = this.source.slice();
      this.index = first ? Math.max(0, this.order.indexOf(first)) : 0;
    }
  }

  /** A song finished on its own: apply the shuffle / repeat / auto-advance rules. */
  onEnded() {
    const n = this.order.length;
    if (!n || !this.current) { this.stop(); return; }

    if (!this.autoAdvance) {
      // Repeat applies to the current song only.
      if (this.repeat === "forever" || (this.repeat === "once" && this.trackPlays < 2)) {
        this.trackPlays++;
        this.audio.currentTime = 0;
        this.audio.play().catch(() => {});
        return;
      }
      this.stop();
      return;
    }

    if (this.index < n - 1) { this.index++; this.playIndex(); return; }

    // End of the list.
    if (this.repeat === "off" || (this.repeat === "once" && this.pass >= 2)) { this.stop(); return; }
    this.pass++;
    this.startNewPass();
  }

  startNewPass() {
    if (this.shuffle) {
      const last = this.current;
      this.buildOrder(null);
      // Don't play the same song twice in a row across a reshuffle.
      if (this.order.length > 1 && this.order[0] === last) [this.order[0], this.order[1]] = [this.order[1], this.order[0]];
    }
    this.index = 0;
    this.playIndex();
  }

  playIndex() {
    this.current = this.order[this.index];
    this.trackPlays = 1;
    this.audio.src = `/api/audio/${this.current.id}`;
    this.audio.play().catch(() => {});
    this.state = "playing";
    this.onchange();
  }

  pause() { if (this.state !== "playing") return; this.audio.pause(); this.state = "paused"; this.onchange(); }
  resume() { if (this.state !== "paused") return; this.audio.play().catch(() => {}); this.state = "playing"; this.onchange(); }

  stop() {
    this.current = null;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    this.state = "stopped";
    this.onchange();
  }

  /** Next button: always moves on, wrapping (and reshuffling) at the end. */
  next() {
    const n = this.order.length;
    if (!n) return;
    if (this.index < n - 1) { this.index++; this.playIndex(); }
    else this.startNewPass();
  }

  previous() {
    const n = this.order.length;
    if (!n) return;
    if (this.state !== "stopped" && this.audio.currentTime > 3) { this.audio.currentTime = 0; return; }
    this.index = (this.index - 1 + n) % n;
    this.playIndex();
  }
}

const audio = $("#audio");
const player = new Player(audio);
const PLAY_ICON = '<path d="M8 5v14l11-7z"/>';
const PAUSE_ICON = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';

function playFromView(start) {
  if (!state.view.length) return;
  player.play(state.view, start || null);   // current sort + filter order is the play order
}

/** Works out why a song wouldn't play, and marks it in the list with that reason. */
async function explainPlayError(track, mediaError) {
  const code = mediaError ? mediaError.code : 0;
  const detail = mediaError && mediaError.message ? mediaError.message : "";
  let chk = null;
  try { chk = await api.get(`/api/check/${track.id}`); } catch { /* server unreachable */ }
  const ext = (chk && chk.ext) || ("." + track.rel.split(".").pop().toLowerCase());
  let reason;
  if (!chk) reason = "Couldn't reach the MusicSync server to load the file.";
  else if (!chk.exists) reason = "File not found. It may have been moved, renamed or deleted. Rescan the library to update the list.";
  else if (!chk.readable) reason = `Couldn't read the file${chk.error ? ` (${chk.error})` : ""}. The drive may be busy, failing or disconnected.`;
  else if (chk.size === 0) reason = "The file is empty (0 bytes).";
  else if (chk.mime && audio.canPlayType(chk.mime) === "") reason = `This browser can't play ${ext} files.`;
  else if (!chk.parses) reason = "The file looks damaged: its audio data couldn't be read.";
  else if (code === MediaError.MEDIA_ERR_DECODE) reason = "The file is damaged, or its audio uses a codec this browser can't decode.";
  else if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) reason = `The audio inside this ${ext} file uses a codec this browser doesn't support.`;
  else if (code === MediaError.MEDIA_ERR_NETWORK) reason = "The file stopped loading part way (drive or connection error).";
  else reason = "The file couldn't be played.";
  if (detail) reason += ` (Browser: ${detail})`;
  state.playErrors.set(track.id, reason);
  render();
  setStatus(`Couldn't play “${track.title}”: ${reason}`);
}
player.onerror = (track, mediaError) => { explainPlayError(track, mediaError); };
player.onplaying = (track) => {
  if (state.playErrors.delete(track.id)) render();   // it plays now (e.g. the file was fixed)
};
player.onchange = () => {
  const t = player.current;
  const playing = player.state === "playing";
  $("#playIcon").innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
  $("#playBtn").setAttribute("aria-label", playing ? "Pause" : "Play");
  if (t) {
    $("#nowTitle").textContent = (player.state === "paused" ? "Paused: " : "") + t.title;
    $("#nowSub").textContent = [t.artist, t.album].filter(Boolean).join(", ") || t.rel;
    document.title = `${t.title} – MusicSync`;
    const i = indexInView(t.id);
    if (i >= 0) ensureVisible(i);
  } else {
    $("#nowTitle").textContent = "Not playing";
    $("#nowSub").textContent = "Double-click a song to play it";
    document.title = "MusicSync";
    $("#seek").value = 0; $("#elapsed").textContent = "0:00"; $("#total").textContent = "0:00";
  }
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = t ? new MediaMetadata({ title: t.title, artist: t.artist, album: t.album }) : null;
    navigator.mediaSession.playbackState = playing ? "playing" : t ? "paused" : "none";
  }
  render();
};

$("#playBtn").addEventListener("click", () => {
  if (player.state === "playing") player.pause();
  else if (player.state === "paused") player.resume();
  else playFromView(byId(state.focus) || null);
});
$("#stopBtn").addEventListener("click", () => player.stop());
$("#nextBtn").addEventListener("click", () => player.next());
$("#prevBtn").addEventListener("click", () => player.previous());

if ("mediaSession" in navigator) {   // keyboard media keys
  navigator.mediaSession.setActionHandler("play", () => $("#playBtn").click());
  navigator.mediaSession.setActionHandler("pause", () => player.pause());
  navigator.mediaSession.setActionHandler("stop", () => player.stop());
  navigator.mediaSession.setActionHandler("nexttrack", () => player.next());
  navigator.mediaSession.setActionHandler("previoustrack", () => player.previous());
}

const volume = $("#volume"), seek = $("#seek");

// ---------- Play mode toggles ----------
const REPEAT_NEXT = { off: "once", once: "forever", forever: "off" };
function loadPref(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function savePref(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }

player.setShuffle(loadPref("musicsync.shuffle", "off") === "on");
player.setRepeat(["off", "once", "forever"].includes(loadPref("musicsync.repeat", "off")) ? loadPref("musicsync.repeat", "off") : "off");
player.setAutoAdvance(loadPref("musicsync.advance", "on") === "on");

function describeMode() {
  const a = player.autoAdvance, r = player.repeat;
  if (!a) return r === "off" ? "Plays one song" : r === "once" ? "Plays this song twice" : "Loops this song";
  const what = player.shuffle ? "list in random order" : "list";
  return r === "off" ? `Plays the ${what}` : r === "once" ? `Plays the ${what} twice` : `Loops the ${what}`;
}

function renderModes() {
  const set = (btn, pressed, label) => {
    btn.setAttribute("aria-pressed", String(pressed));
    btn.title = label;
    btn.setAttribute("aria-label", label);
  };
  set($("#shuffleBtn"), player.shuffle, `Shuffle: ${player.shuffle ? "on" : "off"}`);
  set($("#repeatBtn"), player.repeat !== "off",
    `Repeat: ${{ off: "off", once: "once", forever: "forever" }[player.repeat]} (click to change)`);
  set($("#advanceBtn"), player.autoAdvance, `Auto-advance: ${player.autoAdvance ? "on" : "off"}`);
  const badge = $("#repeatBadge");
  badge.hidden = player.repeat === "off";
  badge.textContent = player.repeat === "once" ? "1" : "∞";
  $("#modeText").textContent = describeMode();
}

$("#shuffleBtn").addEventListener("click", () => {
  player.setShuffle(!player.shuffle);
  savePref("musicsync.shuffle", player.shuffle ? "on" : "off");
  renderModes();
});
$("#repeatBtn").addEventListener("click", () => {
  player.setRepeat(REPEAT_NEXT[player.repeat]);
  savePref("musicsync.repeat", player.repeat);
  renderModes();
});
$("#advanceBtn").addEventListener("click", () => {
  player.setAutoAdvance(!player.autoAdvance);
  savePref("musicsync.advance", player.autoAdvance ? "on" : "off");
  renderModes();
});
renderModes();

// ---------- Light / dark ----------
const MOON = '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>';
const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => (document.documentElement.dataset.theme || (darkQuery.matches ? "dark" : "light")) === "dark";
function renderTheme() {
  const dark = isDark();
  $("#themeIcon").innerHTML = dark ? SUN : MOON;
  const label = dark ? "Switch to light mode" : "Switch to dark mode";
  $("#themeBtn").title = label;
  $("#themeBtn").setAttribute("aria-label", label);
}
$("#themeBtn").addEventListener("click", () => {
  const next = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  savePref("musicsync.theme", next);
  renderTheme();
});
darkQuery.addEventListener("change", renderTheme);
renderTheme();

volume.value = loadPref("musicsync.volume", "0.7");
audio.volume = +volume.value;
volume.addEventListener("input", () => { audio.volume = +volume.value; savePref("musicsync.volume", volume.value); });

let seeking = false;
seek.addEventListener("input", () => { seeking = true; $("#elapsed").textContent = fmtTime(+seek.value); });
seek.addEventListener("change", () => { if (player.current) audio.currentTime = +seek.value; seeking = false; });
audio.addEventListener("loadedmetadata", () => {
  seek.max = isFinite(audio.duration) ? audio.duration : (player.current?.duration || 0);
  $("#total").textContent = fmtTime(+seek.max);
});
audio.addEventListener("timeupdate", () => {
  if (seeking || !player.current) return;
  seek.value = audio.currentTime;
  $("#elapsed").textContent = fmtTime(audio.currentTime);
});

// =====================================================================
// Dialogs
// =====================================================================
function message(title, body, { okLabel = "OK", cancel = false } = {}) {
  const dlg = $("#msg");
  $("#msgTitle").textContent = title;
  $("#msgBody").textContent = body;
  $("#msgOk").textContent = okLabel;
  $("#msgCancel").hidden = !cancel;
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true }));
}

function pickFolder(title, start, { mustExist }) {
  const dlg = $("#picker"), list = $("#pickerList"), input = $("#pickerPath"), hint = $("#pickerHint");
  let parent = null;
  $("#pickerTitle").textContent = title;
  hint.textContent = mustExist ? "" : "You can type a folder that doesn't exist yet; it's created when you sync.";

  async function go(path) {
    try {
      const res = await api.get(`/api/browse?path=${encodeURIComponent(path || "")}`);
      input.value = res.path;
      parent = res.parent;
      $("#pickerUp").disabled = parent == null;
      $("#pickerOk").disabled = !res.path;
      list.innerHTML = res.dirs.length
        ? res.dirs.map((d) => `<li tabindex="0" data-path="${esc(d.path)}">${esc(d.name)}</li>`).join("")
        : `<li class="none">No folders inside</li>`;
      list.scrollTop = 0;
    } catch (err) {
      hint.textContent = err.message;
      $("#pickerOk").disabled = mustExist;
    }
  }

  list.onclick = (e) => { const li = e.target.closest("li[data-path]"); if (li) go(li.dataset.path); };
  list.onkeydown = (e) => { if (e.key === "Enter") { const li = e.target.closest("li[data-path]"); if (li) { e.preventDefault(); go(li.dataset.path); } } };
  $("#pickerUp").onclick = () => { if (parent != null) go(parent); };
  $("#pickerGo").onclick = () => go(input.value);
  input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); go(input.value); } };
  input.oninput = () => { $("#pickerOk").disabled = !input.value.trim(); };

  dlg.returnValue = "";
  dlg.showModal();
  go(start);
  return new Promise((resolve) => dlg.addEventListener("close",
    () => resolve(dlg.returnValue === "ok" && input.value.trim() ? input.value.trim() : null), { once: true }));
}

// =====================================================================
// Start-up
// =====================================================================
(async function init() {
  renderHead();
  applyView();
  try {
    const s = await api.get("/api/state");
    $("#recursive").checked = s.recursive;
    if (s.library) $("#libraryPath").value = s.library;
    state.device = s.device;
    state.savedDevice = s.savedDevice;
    updateDeviceInfo();
    await refreshDrives();

    if (s.job && s.job.running) await finishScan();       // the server is reading the last library
    else if (s.trackCount) await loadTracks();
    else setStatus("Choose a music folder to begin.");

    if (state.device || state.savedDevice) {
      applyDevice(await api.send("/api/device/refresh"));
      await refreshDrives();
      if (!state.device) setStatus(`${state.savedDevice} isn't connected. Plug the drive in and it reconnects automatically.`);
    }
  } catch (err) {
    setStatus("Can't reach the MusicSync server. Run start.bat to start it again.");
  }
})();
