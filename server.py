"""
MusicSync (local web app)

Runs a small server on http://127.0.0.1:8765 that reads your music folder,
streams songs to the browser and copies/removes songs on an external drive.
Only your own computer can reach it.

By default it lives in the system tray (no window). Run with --console to get
a console window instead.
"""
import faulthandler
import json
import logging
import logging.handlers
import mimetypes
import os
import shutil
import sqlite3
import stat
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser
from pathlib import Path

import mutagen
from flask import Flask, abort, jsonify, request, send_file, send_from_directory
from werkzeug.exceptions import HTTPException

if sys.stdout is None:          # started with pythonw.exe (tray mode)
    sys.stdout = open(os.devnull, "w")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")

HOST = "127.0.0.1"
PORT = int(os.environ.get("MUSICSYNC_PORT", "8765"))
APP_DIR = Path(__file__).resolve().parent
IS_WIN = os.name == "nt"

EXTENSIONS = {".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus", ".wma", ".aif", ".aiff",
              ".ape", ".wv", ".mpc", ".tta", ".dsf"}
AUDIO_TYPES = {
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav",
    ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wma": "audio/x-ms-wma",
    ".aif": "audio/aiff", ".aiff": "audio/aiff",
    ".ape": "audio/x-ape", ".wv": "audio/x-wavpack", ".mpc": "audio/x-musepack",
    ".tta": "audio/x-tta", ".dsf": "audio/x-dsf",
}
PARTIAL = ".musicsync-partial"

app = Flask(__name__, static_folder=str(APP_DIR / "static"), static_url_path="/static")

# ---------------------------------------------------------------------------
# Logging: everything important also goes to musicsync.log next to this file,
# so problems can be traced after the fact.
# ---------------------------------------------------------------------------
LOG_FILE = APP_DIR / "musicsync.log"
log = logging.getLogger("musicsync")
log.setLevel(logging.INFO)
try:
    _fh = logging.handlers.RotatingFileHandler(LOG_FILE, maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    _fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(_fh)
    _crash_file = open(LOG_FILE.with_suffix(".crash.log"), "a", encoding="utf-8")
    faulthandler.enable(file=_crash_file)   # records hard crashes of the Python process
except OSError:
    pass
if sys.stderr is not None and getattr(sys.stderr, "name", "") != os.devnull:
    log.addHandler(logging.StreamHandler())
# Only show errors from the web server in the console, not every request.
logging.getLogger("werkzeug").setLevel(logging.ERROR)


def disable_quick_edit() -> None:
    """Clicking in a Windows console window normally pauses the program until a key is
    pressed ("QuickEdit"), which freezes the server. Turn that off for this window."""
    if not IS_WIN:
        return
    try:
        import ctypes
        k32 = ctypes.windll.kernel32
        handle = k32.GetStdHandle(-10)          # STD_INPUT_HANDLE
        mode = ctypes.c_uint32()
        if k32.GetConsoleMode(handle, ctypes.byref(mode)):
            ENABLE_QUICK_EDIT_MODE, ENABLE_EXTENDED_FLAGS = 0x0040, 0x0080
            k32.SetConsoleMode(handle, (mode.value & ~ENABLE_QUICK_EDIT_MODE) | ENABLE_EXTENDED_FLAGS)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def _settings_file() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home() / ".config")
    return Path(base) / "MusicSync" / "web-settings.json"


def load_settings() -> dict:
    try:
        return json.loads(_settings_file().read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_settings(data: dict) -> None:
    try:
        f = _settings_file()
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def norm_rel(rel: str) -> str:
    return os.path.normcase(os.path.normpath(rel))


def paths_overlap(a: str, b: str) -> bool:
    x = os.path.normcase(os.path.abspath(a)).rstrip("\\/") + os.sep
    y = os.path.normcase(os.path.abspath(b)).rstrip("\\/") + os.sep
    return x.startswith(y) or y.startswith(x)


def device_available(folder) -> bool:
    """True when the drive holding the device folder is plugged in."""
    if not folder:
        return False
    if IS_WIN:
        anchor = Path(folder).anchor
        return bool(anchor) and os.path.exists(anchor)
    folder = os.path.abspath(folder).rstrip("/")
    return os.path.isdir(folder) or os.path.isdir(os.path.dirname(folder))


def disk_space(path: str):
    p = os.path.abspath(path)
    while not os.path.exists(p):           # target folder may not exist yet
        parent = os.path.dirname(p)
        if parent == p:
            return None
        p = parent
    try:
        u = shutil.disk_usage(p)
        return {"free": u.free, "total": u.total}
    except OSError:
        return None


def _first(tags, *keys) -> str:
    if not tags:
        return ""
    for k in keys:
        try:
            v = tags.get(k)
        except Exception:
            v = None
        if not v:
            continue
        if isinstance(v, list):
            seen, parts = set(), []
            for x in v:                      # some formats store the same value twice
                x = str(x).strip()
                if x and x.lower() not in seen:
                    seen.add(x.lower()); parts.append(x)
            v = ", ".join(parts)
        v = str(v).strip()
        if v:
            return v
    return ""


def _leading_int(text: str) -> int:
    digits = ""
    for ch in text.strip():
        if ch.isdigit():
            digits += ch
        else:
            break
    return int(digits) if digits else 0


def read_tags(path: str, size: int) -> dict:
    """Reads tags and audio properties. Never raises: unreadable files keep their file name as title."""
    t = {
        "title": os.path.splitext(os.path.basename(path))[0],
        "artist": "", "album": "", "genre": "", "year": 0, "track": 0,
        "duration": 0.0, "bitrate": 0, "sampleRate": 0,
    }
    try:
        f = mutagen.File(path, easy=True)
        if f is not None:
            tags = f.tags
            # easy keys (MP3/MP4/FLAC/OGG), ID3 frames (WAV/AIFF), ASF names (WMA)
            t["title"] = _first(tags, "title", "TIT2", "Title") or t["title"]
            t["artist"] = _first(tags, "artist", "TPE1", "Author", "albumartist", "TPE2", "WM/AlbumArtist")
            t["album"] = _first(tags, "album", "TALB", "WM/AlbumTitle")
            t["genre"] = _first(tags, "genre", "TCON", "WM/Genre")
            t["year"] = _leading_int(_first(tags, "date", "TDRC", "WM/Year", "year"))
            t["track"] = _leading_int(_first(tags, "tracknumber", "TRCK", "WM/TrackNumber"))
            info = f.info
            if info is not None:
                t["duration"] = float(getattr(info, "length", 0) or 0)
                bitrate = int(getattr(info, "bitrate", 0) or 0)
                if not bitrate and t["duration"] > 0:
                    bitrate = int(size * 8 / t["duration"])  # estimate
                t["bitrate"] = round(bitrate / 1000)
                t["sampleRate"] = int(getattr(info, "sample_rate", 0) or 0)
    except Exception:
        pass
    return t


# ---------------------------------------------------------------------------
# Library index (SQLite in %AppData%\MusicSync): remembers every file's size,
# modified time, tags and sync choice, so rescans only read new/changed files.
# ---------------------------------------------------------------------------

TAG_FIELDS = ("title", "artist", "album", "genre", "year", "track", "duration", "bitrate", "sampleRate")
DB_COLS = ("title", "artist", "album", "genre", "year", "track", "duration", "bitrate", "sample_rate")


def library_key(folder: str) -> str:
    return os.path.normcase(os.path.abspath(folder)).rstrip("\\/")


class LibraryIndex:
    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self.db = self._open()
        except sqlite3.DatabaseError:
            log.warning("Library index was damaged; starting a fresh one.")
            try:
                path.replace(path.with_suffix(".damaged"))
            except OSError:
                pass
            self.db = self._open()

    def _open(self):
        db = sqlite3.connect(self.path, check_same_thread=False)
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("""CREATE TABLE IF NOT EXISTS tracks (
            id INTEGER PRIMARY KEY,
            library TEXT NOT NULL,
            relkey TEXT NOT NULL,          -- normalised relative path, used for matching
            rel TEXT NOT NULL,             -- relative path as found on disk
            size INTEGER, mtime_ns INTEGER,
            title TEXT, artist TEXT, album TEXT, genre TEXT,
            year INTEGER, track INTEGER, duration REAL, bitrate INTEGER, sample_rate INTEGER,
            selected INTEGER,              -- 1 keep on device, 0 don't, NULL not decided yet
            UNIQUE (library, relkey))""")
        db.execute("SELECT count(*) FROM tracks").fetchone()   # fails fast if the file is damaged
        db.commit()
        return db

    def load(self, library: str) -> dict:
        """relkey -> row dict for every indexed file of this library."""
        with self.lock:
            cur = self.db.execute(
                "SELECT id, relkey, rel, size, mtime_ns, " + ", ".join(DB_COLS) + ", selected "
                "FROM tracks WHERE library = ?", (library,))
            rows = {}
            for r in cur:
                row = {"id": r[0], "relkey": r[1], "rel": r[2], "size": r[3], "mtime_ns": r[4]}
                row.update(zip(TAG_FIELDS, r[5:14]))
                row["selected"] = None if r[14] is None else bool(r[14])
                rows[r[1]] = row
            return rows

    def update(self, library: str, upserts: list[dict], removed_ids: list[int]) -> None:
        with self.lock, self.db:
            self.db.executemany(
                "INSERT INTO tracks (library, relkey, rel, size, mtime_ns, " + ", ".join(DB_COLS) + ") "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT (library, relkey) DO UPDATE SET rel = excluded.rel, size = excluded.size, "
                "mtime_ns = excluded.mtime_ns, " + ", ".join(f"{c} = excluded.{c}" for c in DB_COLS),
                [(library, u["relkey"], u["rel"], u["size"], u["mtime_ns"], *(u[f] for f in TAG_FIELDS))
                 for u in upserts])
            self.db.executemany("DELETE FROM tracks WHERE id = ?", [(i,) for i in removed_ids])

    def set_selected(self, changes: list[tuple[int, bool]]) -> None:
        if not changes:
            return
        with self.lock, self.db:
            self.db.executemany("UPDATE tracks SET selected = ? WHERE id = ?",
                                [(1 if v else 0, i) for i, v in changes])


def _index_path() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home() / ".config")
    return Path(base) / "MusicSync" / "library-index.sqlite"


INDEX = LibraryIndex(_index_path())


# ---------------------------------------------------------------------------
# Converting formats the browser can't play (WMA, AIFF, ALAC, APE, ...).
# FFmpeg turns them into FLAC (lossless sources) or 320 kbps MP3 (lossy sources),
# which every modern browser plays. Results are cached so each file is only
# converted once; the cache is trimmed to CONVERT_CACHE_LIMIT.
# ---------------------------------------------------------------------------

CONVERT_CACHE_LIMIT = 2 * 1024 ** 3      # 2 GB
LOSSLESS_CODECS = ("pcm_", "alac", "flac", "wmalossless", "ape", "wavpack", "tta", "mlp", "truehd", "dsd_")
NO_WINDOW = 0x08000000 if IS_WIN else 0  # CREATE_NO_WINDOW: no console flash in tray mode


def find_ffmpeg():
    """FFmpeg from the bundled imageio-ffmpeg package, an ffmpeg.exe in the app folder, or PATH."""
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.isfile(exe):
            return exe
    except Exception:
        pass
    local = APP_DIR / ("ffmpeg.exe" if IS_WIN else "ffmpeg")
    if local.is_file():
        return str(local)
    return shutil.which("ffmpeg")


FFMPEG = find_ffmpeg()


def _convert_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or str(Path.home() / ".cache")
    return Path(base) / "MusicSync" / "converted"


CONVERT_DIR = _convert_dir()
_convert_locks: dict[str, threading.Lock] = {}
_convert_locks_guard = threading.Lock()


class ConvertError(Exception):
    pass


def _probe_audio(path: str) -> tuple[str, int]:
    """(codec name, sample rate) of the first audio stream, read from FFmpeg's description."""
    r = subprocess.run([FFMPEG, "-hide_banner", "-i", path], capture_output=True, text=True,
                       errors="replace", creationflags=NO_WINDOW, timeout=60)
    import re
    m = re.search(r"Audio:\s*([\w-]+)[^\n]*?(\d+)\s*Hz", r.stderr)
    if not m:
        raise ConvertError("FFmpeg found no audio in this file. It may be damaged.")
    return m.group(1).lower(), int(m.group(2))


def converted_file(t: dict) -> Path:
    """Returns a browser-friendly copy of the song, converting it first if needed."""
    if not FFMPEG:
        raise ConvertError("FFmpeg isn't installed, so this format can't be converted for playback.")
    src = t["path"]
    try:
        st = os.stat(src)
    except OSError as e:
        raise ConvertError(f"Couldn't read the file ({e.strerror or e}).")
    stem = f"{t['id']}-{st.st_size}-{st.st_mtime_ns}"

    with _convert_locks_guard:
        lock = _convert_locks.setdefault(stem, threading.Lock())
    with lock:                                   # one conversion per song at a time
        for ext in (".flac", ".mp3"):
            done = CONVERT_DIR / (stem + ext)
            if done.is_file():
                os.utime(done)                   # mark as recently used
                return done

        codec, rate = _probe_audio(src)
        lossless = codec.startswith(LOSSLESS_CODECS)
        CONVERT_DIR.mkdir(parents=True, exist_ok=True)
        out = CONVERT_DIR / (stem + (".flac" if lossless else ".mp3"))
        tmp = out.with_name(out.stem + ".part" + out.suffix)
        cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vn", "-map", "0:a:0",
               "-map_metadata", "-1"]
        if lossless:
            # FLAC tops out at 655 kHz; DSD sources get a sensible high-resolution rate.
            cmd += ["-c:a", "flac"] + (["-ar", "88200", "-sample_fmt", "s32"] if codec.startswith("dsd_") else [])
        else:
            cmd += ["-c:a", "libmp3lame", "-b:a", "320k"] + (["-ar", "48000"] if rate > 48000 else [])
        cmd.append(str(tmp))
        started = time.monotonic()
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, errors="replace",
                               creationflags=NO_WINDOW, timeout=600)
        except subprocess.TimeoutExpired:
            _try_remove(str(tmp))
            raise ConvertError("Converting took too long and was stopped.")
        if r.returncode != 0 or not tmp.is_file() or tmp.stat().st_size == 0:
            _try_remove(str(tmp))
            detail = (r.stderr or "").strip().splitlines()[-1:] or ["unknown error"]
            log.warning("Conversion failed for %s: %s", src, r.stderr.strip()[-500:])
            raise ConvertError(f"FFmpeg couldn't convert it ({detail[0][:160]}). The file may be damaged.")
        os.replace(tmp, out)
        log.info("Converted %s (%s) to %s in %.1fs", t["rel"], codec, out.suffix[1:].upper(),
                 time.monotonic() - started)
    _trim_convert_cache()
    return out


def _trim_convert_cache() -> None:
    try:
        files = [f for f in CONVERT_DIR.iterdir() if f.is_file()]
    except OSError:
        return
    stats = []
    for f in files:
        try:
            stats.append((f.stat().st_mtime, f.stat().st_size, f))
        except OSError:
            pass
    total = sum(s for _, s, _ in stats)
    for _, size, f in sorted(stats, key=lambda x: x[0]):   # oldest first
        if total <= CONVERT_CACHE_LIMIT:
            break
        if ".part" in f.name:
            continue
        try:
            f.unlink()
            total -= size
        except OSError:
            pass


def public_track(t: dict) -> dict:
    return {k: v for k, v in t.items() if k != "path"}


# ---------------------------------------------------------------------------
# Device
# ---------------------------------------------------------------------------

class Device:
    """A folder on an external drive that mirrors the checked songs."""

    def __init__(self, folder: str):
        self.folder = os.path.abspath(folder)
        self.files: dict[str, int] = {}

    def scan(self) -> None:
        files = {}
        if os.path.isdir(self.folder):
            for dirpath, _dirs, names in os.walk(self.folder):
                for name in names:
                    full = os.path.join(dirpath, name)
                    if name.endswith(PARTIAL):        # leftover from an interrupted copy
                        try:
                            os.remove(full)
                        except OSError:
                            pass
                        continue
                    try:
                        files[norm_rel(os.path.relpath(full, self.folder))] = os.path.getsize(full)
                    except OSError:
                        pass
        self.files = files

    def has(self, t: dict) -> bool:
        return self.files.get(norm_rel(t["rel"])) == t["size"]

    def dest(self, t: dict) -> str:
        return os.path.join(self.folder, t["rel"])

    def remove_empty_dirs(self, d: str) -> None:
        root = os.path.normcase(self.folder)
        while d and len(d) > len(self.folder) and os.path.normcase(d).startswith(root):
            try:
                if os.listdir(d):
                    return
                os.rmdir(d)
            except OSError:
                return
            d = os.path.dirname(d)

    def to_json(self) -> dict:
        return {"folder": self.folder, "space": disk_space(self.folder)}


# ---------------------------------------------------------------------------
# Background jobs (one at a time: a library scan or a sync)
# ---------------------------------------------------------------------------

class Cancelled(Exception):
    pass


class Job:
    def __init__(self, kind: str):
        self.kind = kind
        self.done = 0
        self.total = 0
        self.message = ""
        self.running = True
        self.cancelled = False
        self.errors: list[str] = []
        self.events: list[list] = []   # [track_id, on_device] changes made by a sync
        self.cancel = threading.Event()
        self.started = time.time()

    def to_json(self, since: int = 0) -> dict:
        return {
            "kind": self.kind, "running": self.running, "cancelled": self.cancelled,
            "done": self.done, "total": self.total, "message": self.message,
            "errors": self.errors, "events": self.events[since:], "eventCount": len(self.events),
            "started": self.started,
        }


class State:
    def __init__(self):
        self.lock = threading.RLock()
        self.settings = load_settings()
        self.library: str | None = None
        self.recursive = bool(self.settings.get("recursive", True))
        self.tracks: list[dict] = []
        self.by_id: dict[int, dict] = {}
        self.tracks_version = 0                         # bumps whenever the loaded library changes
        self.device: Device | None = None              # connected device
        self.saved_device: str | None = self.settings.get("device")  # remembered, even when unplugged
        self.job: Job | None = None

    def save(self):
        self.settings["library"] = self.library
        self.settings["recursive"] = self.recursive
        self.settings["device"] = self.saved_device
        save_settings(self.settings)

    def start_job(self, kind: str, target, *args) -> Job:
        with self.lock:
            if self.job and self.job.running:
                raise RuntimeError("Another task is still running.")
            job = Job(kind)
            self.job = job

        def run():
            try:
                target(job, *args)
            except Cancelled:
                job.cancelled = True
                job.message = "Cancelled."
            except Exception as e:  # report instead of dying silently
                log.error("%s job failed:\n%s", kind, traceback.format_exc())
                job.errors.append(str(e))
                job.message = f"Stopped: {e}"
            finally:
                job.running = False
                log.info("%s job finished: %s (%d problem(s))", kind, job.message, len(job.errors))

        threading.Thread(target=run, daemon=True).start()
        return job


S = State()


def walk_music(folder: str, recursive: bool, job: Job) -> list[tuple[str, int, int]]:
    """(path, size, mtime_ns) for every music file. os.scandir gets size and time from the
    directory listing itself on Windows, so no extra disk access per file."""
    found, stack, last = [], [folder], 0.0
    while stack:
        d = stack.pop()
        try:
            it = os.scandir(d)
        except OSError:
            continue
        with it:
            for e in it:
                if job.cancel.is_set():
                    raise Cancelled()
                try:
                    if e.is_dir(follow_symlinks=False):
                        if recursive and not e.name.startswith(("$", ".")):
                            stack.append(e.path)
                    elif os.path.splitext(e.name)[1].lower() in EXTENSIONS:
                        st = e.stat()
                        found.append((e.path, st.st_size, st.st_mtime_ns))
                except OSError:
                    pass
        if time.monotonic() - last > 0.25:
            job.message = f"Checking the music folder… {len(found):,} files found"
            last = time.monotonic()
    return found


def make_track(folder: str, row: dict) -> dict:
    t = {k: row[k] for k in ("id", "rel", "size", *TAG_FIELDS)}
    t["path"] = os.path.join(folder, row["rel"])
    t["selected"] = row.get("selected")
    t["onDevice"] = False
    return t


def resolve_undecided() -> None:
    """Songs never ticked or unticked by you start out matching the device. Call with S.lock held."""
    if not S.device:
        return
    changes = []
    for t in S.tracks:
        if t["selected"] is None:
            t["selected"] = t["onDevice"]
            changes.append((t["id"], t["selected"]))
    INDEX.set_selected(changes)


def publish_library(folder: str, recursive: bool, rows) -> None:
    """Makes `rows` the loaded library, keeping in-memory ticks made while scanning."""
    with S.lock:
        same = S.library and library_key(S.library) == library_key(folder)
        previous = S.by_id if same else {}
        tracks = []
        for row in sorted(rows, key=lambda r: r["rel"].lower()):
            t = make_track(folder, row)
            if t["id"] in previous:
                t["selected"] = previous[t["id"]]["selected"]
            if S.device:
                t["onDevice"] = S.device.has(t)
            tracks.append(t)
        S.library, S.recursive, S.tracks = folder, recursive, tracks
        S.by_id = {t["id"]: t for t in tracks}
        resolve_undecided()
        S.tracks_version += 1
        S.save()


def scan_library(job: Job, folder: str, recursive: bool) -> None:
    key = library_key(folder)
    job.message = "Opening the library index…"
    cached = INDEX.load(key)

    with S.lock:
        device = S.device
    if device:
        job.message = "Checking which songs are on the device…"
        device.scan()

    # 1. Show the saved library straight away, so it's usable while the folder is checked.
    with S.lock:
        already_shown = S.library and library_key(S.library) == key and S.tracks
    if cached and not already_shown:
        publish_library(folder, recursive, cached.values())

    # 2. See what's actually in the folder now.
    found = walk_music(folder, recursive, job)
    seen, upserts = set(), []
    for path, size, mtime_ns in found:
        rel = os.path.relpath(path, folder)
        relkey = norm_rel(rel)
        seen.add(relkey)
        c = cached.get(relkey)
        if not c or c["size"] != size or c["mtime_ns"] != mtime_ns or c["rel"] != rel:
            upserts.append({"path": path, "rel": rel, "relkey": relkey, "size": size, "mtime_ns": mtime_ns,
                            "changed": c is not None})
    removed = [c["id"] for k, c in cached.items() if k not in seen]

    # 3. Read tags only for new or changed files.
    job.total = len(upserts)
    last = 0.0
    for i, u in enumerate(upserts):
        if job.cancel.is_set():
            raise Cancelled()
        u.update(read_tags(u["path"], u["size"]))
        job.done = i + 1
        if time.monotonic() - last > 0.25 or i + 1 == len(upserts):
            job.message = f"Reading tags of new or changed files… {i + 1:,} of {len(upserts):,}"
            last = time.monotonic()

    # 4. Save the changes and load the updated library.
    if upserts or removed or not cached:
        INDEX.update(key, upserts, removed)
        publish_library(folder, recursive, INDEX.load(key).values())
    else:
        with S.lock:
            S.library, S.recursive = folder, recursive
            S.save()

    new = sum(1 for u in upserts if not u["changed"])
    changed = len(upserts) - new
    parts = [f"{new:,} new" if new else "", f"{changed:,} changed" if changed else "",
             f"{len(removed):,} removed" if removed else ""]
    detail = ", ".join(p for p in parts if p) or "no changes"
    job.message = f"{len(found):,} songs ({detail})."


def run_sync(job: Job, device: Device, to_copy: list, to_remove: list) -> None:
    job.total = len(to_copy) + len(to_remove)

    # Removals first so their space is free for the copies.
    for t in to_remove:
        if job.cancel.is_set():
            raise Cancelled()
        dest = device.dest(t)
        try:
            if os.path.exists(dest):
                os.chmod(dest, stat.S_IWRITE)
                os.remove(dest)
            device.files.pop(norm_rel(t["rel"]), None)
            t["onDevice"] = False
            device.remove_empty_dirs(os.path.dirname(dest))
            job.events.append([t["id"], False])
            job.message = f"Removed {os.path.basename(dest)}"
        except OSError as e:
            job.errors.append(f"Remove {t['rel']}: {e.strerror or e}")
            log.warning("Remove failed for %s: %r", dest, e)
        job.done += 1

    for t in to_copy:
        if job.cancel.is_set():
            raise Cancelled()
        dest = device.dest(t)
        tmp = dest + PARTIAL
        job.message = f"Copying {os.path.basename(dest)}"
        try:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            # Copy to a temp name first so a half-copied file never looks complete.
            with open(t["path"], "rb") as src, open(tmp, "wb") as out:
                while chunk := src.read(1024 * 1024):
                    if job.cancel.is_set():
                        raise Cancelled()
                    out.write(chunk)
            os.replace(tmp, dest)
            device.files[norm_rel(t["rel"])] = os.path.getsize(dest)
            t["onDevice"] = True
            job.events.append([t["id"], True])
        except Cancelled:
            _try_remove(tmp)
            raise
        except OSError as e:
            _try_remove(tmp)
            job.errors.append(f"Copy {t['rel']}: {e.strerror or e}")
            log.warning("Copy failed for %s: %r", dest, e)
        job.done += 1

    job.message = f"Sync complete: {len(to_copy):,} copied, {len(to_remove):,} removed."


def _try_remove(p: str) -> None:
    try:
        if os.path.exists(p):
            os.remove(p)
    except OSError:
        pass


# ---------------------------------------------------------------------------
# Drives
# ---------------------------------------------------------------------------

def list_drives() -> list[dict]:
    drives = []
    if IS_WIN:
        import ctypes
        k32 = ctypes.windll.kernel32
        system = (os.environ.get("SystemDrive", "C:") + "\\").upper()
        mask = k32.GetLogicalDrives()
        for i in range(26):
            if not mask & (1 << i):
                continue
            root = f"{chr(65 + i)}:\\"
            kind = k32.GetDriveTypeW(root)       # 2 = removable, 3 = fixed
            if kind not in (2, 3) or (kind == 3 and root == system):
                continue
            space = disk_space(root)
            if space is None:                    # card reader with no card, etc.
                continue
            buf = ctypes.create_unicode_buffer(261)
            k32.GetVolumeInformationW(root, buf, 261, None, None, None, None, 0)
            label = buf.value or ("Removable drive" if kind == 2 else "Local disk")
            drives.append({"root": root, "label": label, "removable": kind == 2,
                           "free": space["free"], "musicPath": os.path.join(root, "Music")})
    else:
        user = os.environ.get("USER", "")
        for base in (f"/media/{user}", f"/run/media/{user}", "/Volumes", "/mnt"):
            if not os.path.isdir(base):
                continue
            for name in sorted(os.listdir(base)):
                root = os.path.join(base, name)
                if not os.path.isdir(root) or name == "Macintosh HD":
                    continue
                space = disk_space(root)
                if space:
                    drives.append({"root": root, "label": name, "removable": True,
                                   "free": space["free"], "musicPath": os.path.join(root, "Music")})
    drives.sort(key=lambda d: not d["removable"])
    return drives


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.before_request
def guard():
    # Only answer requests addressed to this machine, and require a custom
    # header on changes so other websites can't drive the API.
    host = (request.host or "").rsplit(":", 1)[0].strip("[]")
    if host not in ("127.0.0.1", "localhost"):
        abort(403)
    if request.method != "GET" and request.headers.get("X-MusicSync") != "1":
        abort(403)


@app.errorhandler(Exception)
def unexpected_error(e):
    if isinstance(e, HTTPException):
        return e
    log.error("Error handling %s %s:\n%s", request.method, request.path, traceback.format_exc())
    return jsonify({"error": f"Unexpected error: {e}. Details are in musicsync.log."}), 500


@app.get("/api/ping")
def ping():
    return jsonify({"ok": True})


def error(msg: str, code: int = 400):
    return jsonify({"error": msg}), code


@app.get("/")
def index():
    return send_from_directory(APP_DIR / "static", "index.html")


@app.get("/api/state")
def get_state():
    with S.lock:
        return jsonify({
            "library": S.library or S.settings.get("library"),
            "recursive": S.recursive,
            "device": S.device.to_json() if S.device else None,
            "savedDevice": S.saved_device,
            "job": S.job.to_json(len(S.job.events)) if S.job else None,
            "trackCount": len(S.tracks),
            "canConvert": bool(FFMPEG),
            "tracksVersion": S.tracks_version,
            "platform": "windows" if IS_WIN else sys.platform,
        })


@app.get("/api/tracks")
def get_tracks():
    with S.lock:
        return jsonify({"tracks": [public_track(t) for t in S.tracks], "version": S.tracks_version})


@app.post("/api/library")
def set_library():
    body = request.get_json(silent=True) or {}
    folder = os.path.abspath(os.path.expanduser(str(body.get("folder", "")).strip()))
    if not os.path.isdir(folder):
        return error("That folder doesn't exist.")
    warning = None
    with S.lock:
        if S.device and paths_overlap(folder, S.device.folder):
            S.device = None
            S.saved_device = None
            warning = "The music folder overlapped the device folder, so the device was cleared. Choose it again."
    try:
        S.start_job("scan", scan_library, folder, bool(body.get("recursive", True)))
    except RuntimeError as e:
        return error(str(e), 409)
    return jsonify({"ok": True, "warning": warning})


def _device_response():
    with S.lock:
        return jsonify({
            "device": S.device.to_json() if S.device else None,
            "savedDevice": S.saved_device,
            "onDevice": [t["id"] for t in S.tracks if t["onDevice"]],
            "selected": [t["id"] for t in S.tracks if t["selected"]],
        })


@app.post("/api/device")
def set_device():
    body = request.get_json(silent=True) or {}
    folder = str(body.get("folder", "")).strip()
    if not folder:
        return error("Choose a folder.")
    folder = os.path.abspath(os.path.expanduser(folder))
    with S.lock:
        if S.job and S.job.running:
            return error("Wait for the current task to finish.", 409)
        lib = S.library or S.settings.get("library")
        if lib and paths_overlap(folder, lib):
            return error("The device folder can't be the same as (or inside) your music folder, "
                         "otherwise unchecking a song would delete your original file.")
        if not device_available(folder):
            return error("That drive isn't connected.")
        dev = Device(folder)
        dev.scan()
        S.device = dev
        S.saved_device = dev.folder
        # Songs already on the chosen device get ticked, so nothing there is proposed for deletion.
        changes = []
        for t in S.tracks:
            t["onDevice"] = dev.has(t)
            if t["onDevice"] and not t["selected"]:
                t["selected"] = True
                changes.append((t["id"], True))
        INDEX.set_selected(changes)
        resolve_undecided()
        S.save()
    return _device_response()


@app.post("/api/device/refresh")
def refresh_device():
    """Re-reads the device. Also disconnects an unplugged device, and reconnects the
    remembered device once its drive is plugged back in."""
    with S.lock:
        if S.job and S.job.running:
            return error("Wait for the current task to finish.", 409)
        lib = S.library or S.settings.get("library")
        if S.device and not device_available(S.device.folder):
            log.info("Device disconnected: %s", S.device.folder)
            S.device = None
        elif (not S.device and S.saved_device and device_available(S.saved_device)
              and not (lib and paths_overlap(S.saved_device, lib))):
            log.info("Device reconnected: %s", S.saved_device)
            S.device = Device(S.saved_device)
        if S.device:
            S.device.scan()
        for t in S.tracks:
            t["onDevice"] = bool(S.device and S.device.has(t))
        resolve_undecided()
    return _device_response()


@app.delete("/api/device")
def clear_device():
    with S.lock:
        S.device = None
        S.saved_device = None
        for t in S.tracks:
            t["onDevice"] = False
        S.save()
    return _device_response()


@app.get("/api/drives")
def drives():
    with S.lock:
        current = S.device.folder if S.device else None
        saved = S.saved_device
    return jsonify({
        "drives": list_drives(),
        # lets the page notice a device being unplugged or plugged back in
        "deviceAvailable": device_available(current) if current else None,
        "savedAvailable": device_available(saved) if saved else None,
    })


@app.post("/api/selection")
def set_selection():
    """Saves ticks/unticks so they survive restarts."""
    body = request.get_json(silent=True) or {}
    value = bool(body.get("selected"))
    with S.lock:
        changes = []
        for i in body.get("ids", []):
            t = S.by_id.get(i)
            if t is not None and t["selected"] != value:
                t["selected"] = value
                changes.append((i, value))
    INDEX.set_selected(changes)
    return jsonify({"ok": True, "changed": len(changes)})


@app.post("/api/sync")
def sync():
    body = request.get_json(silent=True) or {}
    with S.lock:
        device = S.device
        if not device:
            return error("Choose a device first.")
        by_id = S.by_id
        to_copy = [by_id[i] for i in body.get("copy", []) if i in by_id and not by_id[i]["onDevice"]]
        to_remove = [by_id[i] for i in body.get("remove", []) if i in by_id and by_id[i]["onDevice"]]
    if not to_copy and not to_remove:
        return error("Nothing to sync.")

    needed = sum(t["size"] for t in to_copy) - sum(t["size"] for t in to_remove)
    space = disk_space(device.folder)
    if space and needed > space["free"]:
        return error(f"Not enough space on the device. It needs {needed / 1e9:.2f} GB more but has "
                     f"{space['free'] / 1e9:.2f} GB free. Uncheck some songs and try again.")
    log.info("Sync requested: %d to copy, %d to remove, device %s", len(to_copy), len(to_remove), device.folder)
    try:
        S.start_job("sync", run_sync, device, to_copy, to_remove)
    except RuntimeError as e:
        return error(str(e), 409)
    return jsonify({"ok": True})


@app.get("/api/job")
def job_status():
    since = request.args.get("since", default=0, type=int)
    with S.lock:
        if not S.job:
            return jsonify(None)
        data = S.job.to_json(since)
        data["tracksVersion"] = S.tracks_version
        return jsonify(data)


@app.post("/api/job/cancel")
def cancel_job():
    with S.lock:
        if S.job:
            S.job.cancel.set()
    return jsonify({"ok": True})


@app.get("/api/audio/<int:track_id>")
def audio(track_id: int):
    with S.lock:
        t = S.by_id.get(track_id)
    if not t or not os.path.isfile(t["path"]):
        abort(404)
    ext = os.path.splitext(t["path"])[1].lower()
    # conditional=True enables range requests, which the browser needs for seeking
    return send_file(t["path"], mimetype=AUDIO_TYPES.get(ext) or mimetypes.guess_type(t["path"])[0],
                     conditional=True)


@app.post("/api/convert/<int:track_id>")
def convert(track_id: int):
    """Prepares a browser-friendly copy of a song. Can take a few seconds."""
    with S.lock:
        t = S.by_id.get(track_id)
    if not t:
        return error("Unknown song.", 404)
    try:
        out = converted_file(t)
    except ConvertError as e:
        return error(str(e), 422)
    return jsonify({"ok": True, "format": out.suffix[1:].upper()})


@app.get("/api/converted/<int:track_id>")
def converted_audio(track_id: int):
    with S.lock:
        t = S.by_id.get(track_id)
    if not t:
        abort(404)
    try:
        out = converted_file(t)      # instant when already converted
    except ConvertError:
        abort(404)
    mime = "audio/flac" if out.suffix == ".flac" else "audio/mpeg"
    return send_file(out, mimetype=mime, conditional=True)


@app.get("/api/check/<int:track_id>")
def check_file(track_id: int):
    """Called by the page when a song won't play, to work out why."""
    with S.lock:
        t = S.by_id.get(track_id)
    if not t:
        return jsonify({"known": False})
    path = t["path"]
    ext = os.path.splitext(path)[1].lower()
    result = {"known": True, "exists": os.path.isfile(path), "readable": False, "size": 0,
              "parses": False, "ext": ext, "mime": AUDIO_TYPES.get(ext, ""), "error": ""}
    if not result["exists"]:
        return jsonify(result)
    try:
        result["size"] = os.path.getsize(path)
        with open(path, "rb") as f:
            f.read(4096)
        result["readable"] = True
    except OSError as e:
        result["error"] = e.strerror or str(e)
        return jsonify(result)
    try:
        f = mutagen.File(path)
        result["parses"] = bool(f is not None and getattr(f.info, "length", 0))
    except Exception as e:
        result["error"] = str(e)
    return jsonify(result)


@app.post("/api/reveal")
def reveal():
    body = request.get_json(silent=True) or {}
    with S.lock:
        i = body.get("id")
        t = S.by_id.get(i) if isinstance(i, int) else None
    if not t:
        return error("Unknown song.")
    try:
        if IS_WIN:
            subprocess.Popen(["explorer.exe", "/select,", t["path"]])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", t["path"]])
        else:
            subprocess.Popen(["xdg-open", os.path.dirname(t["path"])])
    except OSError as e:
        return error(str(e))
    return jsonify({"ok": True})


@app.get("/api/browse")
def browse():
    """Lists sub-folders so the page can offer a folder picker."""
    path = request.args.get("path", "").strip()
    if not path:
        if IS_WIN:
            roots = [f"{c}:\\" for c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ" if os.path.exists(f"{c}:\\")]
            return jsonify({"path": "", "parent": None, "dirs": [{"name": r, "path": r} for r in roots]})
        path = str(Path.home())
    path = os.path.abspath(os.path.expanduser(path))
    if not os.path.isdir(path):
        return error("That folder doesn't exist.", 404)
    dirs = []
    try:
        with os.scandir(path) as it:
            for e in it:
                try:
                    if e.is_dir() and not e.name.startswith((".", "$")):
                        dirs.append({"name": e.name, "path": e.path})
                except OSError:
                    pass
    except PermissionError:
        return error("Windows didn't allow access to that folder.", 403)
    dirs.sort(key=lambda d: d["name"].lower())
    parent = os.path.dirname(path)
    if parent == path:
        parent = "" if IS_WIN else None
    return jsonify({"path": path, "parent": parent, "dirs": dirs})


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

def restore_last_session():
    lib = S.settings.get("library")
    dev = S.saved_device
    if dev and device_available(dev):
        S.device = Device(dev)
    if lib and os.path.isdir(lib):
        S.start_job("scan", scan_library, lib, S.recursive)


def show_message(text: str, ask: bool = False) -> bool:
    """A Windows message box (tray mode has no console to print to). With ask=True,
    shows Yes/No and returns True for Yes."""
    log.info("Message: %s", text)
    if IS_WIN:
        try:
            import ctypes
            MB_YESNO, MB_ICONWARNING, MB_ICONINFO, MB_TOPMOST = 0x4, 0x30, 0x40, 0x40000
            flags = (MB_YESNO | MB_ICONWARNING if ask else MB_ICONINFO) | MB_TOPMOST
            return ctypes.windll.user32.MessageBoxW(None, text, "MusicSync", flags) == 6  # IDYES
        except Exception:
            pass
    print(text)
    return True


def already_running(url: str) -> bool:
    try:
        with urllib.request.urlopen(url + "api/ping", timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


def make_tray_image():
    from PIL import Image, ImageDraw
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((2, 2, size - 3, size - 3), radius=14, fill=(13, 107, 99, 255))
    white = (255, 255, 255, 255)
    d.ellipse((14, 37, 32, 53), fill=white)                    # note head
    d.rectangle((28, 12, 32, 46), fill=white)                  # stem
    d.polygon([(32, 12), (48, 17), (48, 25), (32, 20)], fill=white)  # flag
    return img


def run_tray(server, url: str) -> None:
    import pystray

    def open_app(icon=None, item=None):
        webbrowser.open(url)

    def open_log(icon, item):
        try:
            if IS_WIN:
                os.startfile(LOG_FILE)
            else:
                webbrowser.open(LOG_FILE.as_uri())
        except OSError as e:
            show_message(f"Couldn't open the log: {e}")

    def quit_app(icon, item):
        with S.lock:
            syncing = bool(S.job and S.job.running and S.job.kind == "sync")
        if syncing and not show_message(
                "A sync is still running. Stop it and quit MusicSync?\n\n"
                "Songs already copied stay on the device.", ask=True):
            return
        if S.job:
            S.job.cancel.set()
        icon.stop()

    icon = pystray.Icon(
        "MusicSync", make_tray_image(), "MusicSync",
        menu=pystray.Menu(
            pystray.MenuItem("Open MusicSync", open_app, default=True),  # also on click / double-click
            pystray.MenuItem("Show log file", open_log),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit MusicSync", quit_app),
        ),
    )

    def setup(icon):
        icon.visible = True
        if not S.settings.get("trayHintShown"):
            try:
                icon.notify("MusicSync is running here in the system tray. "
                            "Click the icon to open it, right-click to quit.", "MusicSync")
            except Exception:
                pass
            S.settings["trayHintShown"] = True
            save_settings(S.settings)

    icon.run(setup)        # blocks until Quit


def main() -> None:
    url = f"http://{HOST}:{PORT}/"
    no_browser = "--no-browser" in sys.argv
    console = "--console" in sys.argv

    # Started a second time? Just bring up the page of the copy that's running.
    if already_running(url):
        if not no_browser:
            webbrowser.open(url)
        return

    tray = not console
    if tray:
        try:
            import pystray  # noqa: F401
            import PIL      # noqa: F401
        except Exception as e:
            log.warning("Tray icon unavailable (%s); running with a console window instead.", e)
            tray = False

    if not tray:
        disable_quick_edit()
    log.info("MusicSync starting (Python %s, %s mode)", sys.version.split()[0], "tray" if tray else "console")
    log.info("FFmpeg for converting: %s", FFMPEG or "not found (WMA, AIFF and similar won't play)")
    restore_last_session()

    from werkzeug.serving import make_server
    try:
        server = make_server(HOST, PORT, app, threaded=True)
    except OSError as e:
        show_message(f"MusicSync couldn't start because port {PORT} is in use by another program.\n\n"
                     f"Details: {e}")
        return

    if not no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    if tray:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            run_tray(server, url)
        except Exception:
            log.error("Tray icon failed:\n%s", traceback.format_exc())
            show_message("The tray icon couldn't be shown, so MusicSync has stopped. "
                         "Use start-console.bat instead, and see musicsync.log for details.")
        server.shutdown()
        log.info("MusicSync stopped from the tray menu.")
    else:
        print(f"MusicSync is running at {url}\nKeep this window open while you use it. Press Ctrl+C to stop.\n"
              f"A log is kept in {LOG_FILE}")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        log.error("MusicSync crashed:\n%s", traceback.format_exc())
        show_message("MusicSync stopped because of an unexpected error. Details are in musicsync.log.")
        raise
