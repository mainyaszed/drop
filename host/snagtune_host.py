"""Drop (formerly SnagTune) native messaging host.

Chrome/Edge talk to this process over stdin/stdout using the native messaging
protocol (4-byte little-endian length + UTF-8 JSON). It uses yt-dlp to fetch the
best audio stream, ffmpeg to remux/convert, and mutagen to write tags + cover art.
"""

import base64
import io
import json
import logging
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import http.client
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

VERSION = "1.5.0"
HERE = Path(__file__).resolve().parent

# Chrome can hand child processes an SSLKEYLOGFILE pointing at a file we can't
# open; Python's ssl then fails every HTTPS request with PermissionError.
os.environ.pop("SSLKEYLOGFILE", None)

# Grab the real stdout for protocol messages, then point sys.stdout at stderr so
# nothing (yt-dlp, print, libraries) can ever corrupt the message stream.
_PROTO_OUT = sys.stdout.buffer
_PROTO_IN = sys.stdin.buffer
sys.stdout = sys.stderr
_write_lock = threading.Lock()

logging.basicConfig(
    filename=str(HERE / "snagtune_host.log"),
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("snagtune")


def _refresh_path():
    """Browsers launch us with their own (possibly stale) PATH. Merge in the
    current user/system PATH from the registry so freshly installed ffmpeg/deno
    are found without restarting the browser."""
    if os.name != "nt":
        return
    try:
        import winreg

        parts = os.environ.get("PATH", "").split(os.pathsep)
        for root, key in (
            (winreg.HKEY_CURRENT_USER, r"Environment"),
            (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        ):
            try:
                with winreg.OpenKey(root, key) as k:
                    value, _ = winreg.QueryValueEx(k, "Path")
                    parts += os.path.expandvars(value).split(os.pathsep)
            except OSError:
                pass
        parts.append(os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\WinGet\Links"))
        # Private ffmpeg (and Deno, if setup had to download it) win over anything on PATH.
        for private in (HERE / "bin", HERE / "ffmpeg" / "bin"):
            if private.is_dir():
                parts.insert(0, str(private))
        seen, merged = set(), []
        for p in parts:
            if p and p.lower() not in seen:
                seen.add(p.lower())
                merged.append(p)
        os.environ["PATH"] = os.pathsep.join(merged)
    except Exception:
        log.exception("PATH refresh failed")


_refresh_path()

import yt_dlp  # noqa: E402  (after PATH refresh)
from mutagen.flac import FLAC, Picture  # noqa: E402
from mutagen.id3 import APIC, ID3, TALB, TCON, TDRC, TIT2, TPE1, TPE2, TRCK, COMM, ID3NoHeaderError  # noqa: E402
from mutagen.mp4 import MP4, MP4Cover  # noqa: E402
from mutagen.oggopus import OggOpus  # noqa: E402

try:
    from PIL import Image
except ImportError:  # cover cropping is optional
    Image = None


# ---------------------------------------------------------------- protocol --

def send(msg):
    data = json.dumps(msg).encode("utf-8")
    with _write_lock:
        _PROTO_OUT.write(struct.pack("<I", len(data)))
        _PROTO_OUT.write(data)
        _PROTO_OUT.flush()


def read_message():
    raw_len = _PROTO_IN.read(4)
    if len(raw_len) < 4:
        return None
    (length,) = struct.unpack("<I", raw_len)
    return json.loads(_PROTO_IN.read(length).decode("utf-8"))


class _YdlLogger:
    def debug(self, msg):
        if not msg.startswith("[debug] "):
            log.info(msg)

    def info(self, msg):
        log.info(msg)

    def warning(self, msg):
        log.warning(msg)

    def error(self, msg):
        log.error(msg)


# ---------------------------------------------------------------- metadata --

_JUNK = re.compile(
    r"\s*[\(\[【](?:[^)\]】]*?\b(?:official|lyrics?|lyric video|audio|video|visuali[sz]er|hd|hq|4k|mv|m/v|"
    r"music video|clip officiel|explicit|free download)\b[^)\]】]*)[\)\]】]",
    re.IGNORECASE,
)


def clean_title(title):
    t = _JUNK.sub("", title or "")
    t = re.sub(r"\s*\|\s*.*$", "", t)  # "Song | Channel Name"
    return re.sub(r"\s{2,}", " ", t).strip(" -–—") or (title or "").strip()


def guess_metadata(info):
    """Best-effort artist/title/album/year from yt-dlp info."""
    raw_title = info.get("track") or info.get("title") or ""
    artist = info.get("artist") or info.get("creator")
    if artist and "," in artist and info.get("artists"):
        artist = ", ".join(info["artists"])
    title = raw_title

    if not info.get("track"):
        cleaned = clean_title(raw_title)
        # "Artist - Title", also sloppy "Artist -Title" / "Artist- Title"
        m = re.match(r"^(.+?)(?:\s+[-–—]\s*|\s*[-–—]\s+)(.+)$", cleaned)
        if m and not artist:
            artist, title = m.group(1).strip(), m.group(2).strip()
        else:
            title = cleaned

    if not artist:
        artist = info.get("uploader") or info.get("channel") or ""
        artist = re.sub(r"\s*-\s*Topic$", "", artist)  # YouTube auto "Artist - Topic" channels

    year = info.get("release_year")
    if not year:
        d = info.get("release_date") or info.get("upload_date") or ""
        year = d[:4] if len(d) >= 4 else ""

    genre = info.get("genre") or ""
    if not genre and info.get("genres"):
        genre = info["genres"][0]

    return {
        "title": title,
        "artist": artist,
        "album": info.get("album") or "",
        "album_artist": info.get("album_artist") or "",
        "year": str(year or ""),
        "genre": genre,
        "track": str(info.get("track_number") or ""),
        "comment": info.get("webpage_url") or "",
    }


def best_thumbnail(info):
    thumbs = [t for t in (info.get("thumbnails") or []) if t.get("url")]
    if not thumbs:
        return info.get("thumbnail")

    def score(t):
        w, h = t.get("width") or 0, t.get("height") or 0
        pref = t.get("preference") or 0
        # webp is fine for preview, but prefer jpg for embedding compatibility
        is_jpg = 1 if re.search(r"\.jpe?g(\?|$)", t["url"]) else 0
        return (w * h, pref, is_jpg)

    return max(thumbs, key=score)["url"]


def describe_audio(info):
    fmt = None
    for f in info.get("requested_formats") or [info]:
        if f.get("acodec") and f.get("acodec") != "none":
            fmt = f
    if not fmt:
        return ""
    codec = (fmt.get("acodec") or "").split(".")[0]
    abr = fmt.get("abr")
    return f"{codec}{f' ~{round(abr)} kbps' if abr else ''}"


def best_ext(info):
    """File extension the 'best' (no re-encode) option will produce."""
    codec = describe_audio(info).split(" ")[0]
    return {"opus": "opus", "mp4a": "m4a", "aac": "m4a", "mp3": "mp3", "vorbis": "ogg", "flac": "flac"}.get(codec, "opus")


# ------------------------------------------------------------------- cover --

def fetch_bytes(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def load_cover(cover, square):
    """cover = {"type": "url"|"data"|"none", "value": str}. Returns JPEG bytes or None."""
    if not cover or cover.get("type") == "none" or not cover.get("value"):
        return None
    if cover["type"] == "data":
        value = cover["value"]
        raw = base64.b64decode(value.split(",", 1)[1] if value.startswith("data:") else value)
    else:
        raw = fetch_bytes(cover["value"])

    if Image is None:
        return raw
    img = Image.open(io.BytesIO(raw))
    img = img.convert("RGB")
    if square:
        w, h = img.size
        side = min(w, h)
        img = img.crop(((w - side) // 2, (h - side) // 2, (w + side) // 2, (h + side) // 2))
    if max(img.size) > 1400:
        img.thumbnail((1400, 1400), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, "JPEG", quality=92)
    return out.getvalue()


# ----------------------------------------------------------------- tagging --

def tag_file(path, meta, cover_jpeg):
    ext = path.suffix.lower()
    m = {k: (v or "").strip() for k, v in meta.items()}

    if ext == ".mp3":
        try:
            tags = ID3(path)
        except ID3NoHeaderError:
            tags = ID3()
        tags.delall("APIC")
        for frame, key in ((TIT2, "title"), (TPE1, "artist"), (TALB, "album"), (TPE2, "album_artist"),
                           (TDRC, "year"), (TCON, "genre"), (TRCK, "track")):
            tags.delall(frame.__name__)
            if m.get(key):
                tags.add(frame(encoding=3, text=m[key]))
        if m.get("comment"):
            tags.delall("COMM")
            tags.add(COMM(encoding=3, lang="eng", desc="", text=m["comment"]))
        if cover_jpeg:
            tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover", data=cover_jpeg))
        tags.save(path, v2_version=3)

    elif ext in (".m4a", ".mp4", ".aac"):
        audio = MP4(path)
        mapping = {"title": "\xa9nam", "artist": "\xa9ART", "album": "\xa9alb", "album_artist": "aART",
                   "year": "\xa9day", "genre": "\xa9gen", "comment": "\xa9cmt"}
        for key, atom in mapping.items():
            if m.get(key):
                audio[atom] = [m[key]]
            elif atom in audio:
                del audio[atom]
        if m.get("track", "").isdigit():
            audio["trkn"] = [(int(m["track"]), 0)]
        if cover_jpeg:
            audio["covr"] = [MP4Cover(cover_jpeg, imageformat=MP4Cover.FORMAT_JPEG)]
        audio.save()

    elif ext in (".flac", ".opus", ".ogg"):
        audio = FLAC(path) if ext == ".flac" else OggOpus(path)
        mapping = {"title": "title", "artist": "artist", "album": "album", "album_artist": "albumartist",
                   "year": "date", "genre": "genre", "track": "tracknumber", "comment": "comment"}
        for key, field in mapping.items():
            if m.get(key):
                audio[field] = m[key]
            elif field in audio:
                del audio[field]
        if cover_jpeg:
            pic = Picture()
            pic.type, pic.mime, pic.desc, pic.data = 3, "image/jpeg", "Cover", cover_jpeg
            if Image is not None:
                pic.width, pic.height = Image.open(io.BytesIO(cover_jpeg)).size
                pic.depth = 24
            if ext == ".flac":
                audio.clear_pictures()
                audio.add_picture(pic)
            else:
                audio["metadata_block_picture"] = [base64.b64encode(pic.write()).decode("ascii")]
        audio.save()
    else:
        log.warning("No tagger for %s", ext)


# --------------------------------------------------------------- commands --

def ydl_base_opts():
    return {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "logger": _YdlLogger(),
        "socket_timeout": 30,
        # YouTube needs a JS runtime to solve its player challenges; use whichever is installed.
        "js_runtimes": {name: {} for name in ("deno", "node", "bun") if shutil.which(name)} or {"deno": {}},
    }


def cmd_ping(_msg):
    return {
        "version": VERSION,
        "yt_dlp": yt_dlp.version.__version__,
        "ffmpeg": bool(shutil.which("ffmpeg") and shutil.which("ffprobe")),
        "js_runtime": bool(shutil.which("deno") or shutil.which("node")),
        "default_dir": str(default_dir()),
    }


def cmd_info(msg):
    opts = ydl_base_opts() | {"format": "bestaudio/best"}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(msg["url"], download=False)
    if info.get("_type") == "playlist":
        raise RuntimeError("That's a playlist/set. Open a single track to download it.")
    return {
        "meta": guess_metadata(info),
        "raw_title": info.get("title"),
        "uploader": info.get("uploader"),
        "duration": info.get("duration"),
        "thumbnail": best_thumbnail(info),
        "source": info.get("extractor_key"),
        "audio": describe_audio(info),
        "best_ext": best_ext(info),
        "webpage_url": info.get("webpage_url") or msg["url"],
    }


def default_dir():
    music = Path.home() / "Music"
    return (music if music.is_dir() else Path.home() / "Downloads") / "Drop"


_BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_filename(name):
    name = _BAD_CHARS.sub("", name).strip().rstrip(". ")
    if name.upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}:
        name = f"_{name}"
    return name[:180] or "track"


def unique_path(folder, stem, ext):
    p = folder / f"{stem}{ext}"
    i = 2
    while p.exists():
        p = folder / f"{stem} ({i}){ext}"
        i += 1
    return p


CANCELLED = set()  # job ids the user asked to stop


def remove_tmp(tmp):
    """Delete a temp folder. After a cancel, Windows can keep the half-written
    .part file locked for a moment, so retry in the background."""
    def go():
        import gc
        for _ in range(20):
            gc.collect()  # a cancelled download can leave its file object (and Windows lock) unreferenced
            shutil.rmtree(tmp, ignore_errors=True)
            if not os.path.exists(tmp):
                return
            time.sleep(0.5)
    threading.Thread(target=go, daemon=True).start()


def sweep_old_tmp():
    """Remove temp folders left behind by a crash or a killed helper (older than 1 h)."""
    import glob
    for d in glob.glob(os.path.join(tempfile.gettempdir(), "snagtune_*")):
        try:
            if time.time() - os.path.getmtime(d) > 3600:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass


class Cancelled(Exception):
    pass


def fetch_track(url, fmt, tmp, progress, job_id):
    """Download + convert one track into tmp. Returns (audio_file, info)."""
    def hook(d):
        if job_id in CANCELLED:
            raise Cancelled()
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            pct = (d.get("downloaded_bytes", 0) / total * 100) if total else None
            progress("downloading", round(pct, 1) if pct is not None else None,
                     speed=d.get("speed"), eta=d.get("eta"))
        elif d["status"] == "finished":
            progress("converting", 100)

    pp = {"key": "FFmpegExtractAudio", "preferredcodec": fmt if fmt != "best" else "best"}
    if fmt == "mp3":
        pp["preferredquality"] = "320"  # CBR 320k
    elif fmt == "m4a":
        pp["preferredquality"] = "256"
    opts = ydl_base_opts() | {
        # bestaudio = highest-quality stream (Opus on YouTube). For M4A grab the
        # AAC stream directly so it's copied instead of re-encoded.
        "format": "bestaudio[ext=m4a]/bestaudio/best" if fmt == "m4a" else "bestaudio/best",
        "outtmpl": str(tmp / "audio.%(ext)s"),
        "progress_hooks": [hook],
        "postprocessors": [pp],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    files = [f for f in tmp.iterdir() if f.is_file() and f.suffix.lower() in
             (".mp3", ".m4a", ".opus", ".flac", ".ogg", ".aac", ".wav")]
    if not files:
        raise RuntimeError("Download finished but no audio file was produced.")
    return files[0], info


def finish_track(audio_file, stem, out_dir, vlc_url, progress):
    """Save the tagged file to out_dir, or send it to VLC (falling back to out_dir).
    Returns {"path", "ext", "vlc"?, "vlc_error"?}."""
    ext = audio_file.suffix.lower()
    res = {"path": None, "ext": ext.lstrip(".")}
    if vlc_url:
        # Send to VLC only: upload straight from the temp folder (with its real
        # name), keep nothing on this PC. The caller removes the temp folder.
        named = audio_file.with_name(stem + ext)
        audio_file.rename(named)
        audio_file = named
        try:
            vlc_upload(audio_file, vlc_url, lambda pct: progress("sending", pct))
            res["vlc"] = "sent"
            return res
        except Exception as e:
            # Don't lose the download: fall back to saving it locally.
            log.warning("VLC send failed: %s", e)
            res["vlc_error"] = friendly_error(e) + " Saved it to your PC instead."
    out_dir.mkdir(parents=True, exist_ok=True)
    final = unique_path(out_dir, stem, ext)
    shutil.move(str(audio_file), final)
    res["path"] = str(final)
    return res


def resolve_out_dir(msg):
    raw = msg.get("out_dir")
    return Path(os.path.expandvars(os.path.expanduser(raw))) if raw else default_dir()


def check_ffmpeg():
    if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        raise RuntimeError("ffmpeg/ffprobe not found. Run install.ps1 again.")


def run_download(job_id, msg):
    fmt = msg.get("format", "best")  # best | mp3 | m4a | flac | opus
    meta = msg.get("meta") or {}
    tmp = Path(tempfile.mkdtemp(prefix="snagtune_"))

    def progress(stage, percent=None, **extra):
        send({"id": job_id, "type": "progress", "stage": stage, "percent": percent, **extra})

    try:
        check_ffmpeg()
        progress("starting", 0)
        audio_file, info = fetch_track(msg["url"], fmt, tmp, progress, job_id)

        progress("tagging", 100)
        cover = None
        try:
            cover = load_cover(msg.get("cover"), msg.get("square_cover", True))
        except Exception as e:
            log.warning("Cover failed: %s", e)
            progress("tagging", 100, warning=f"Cover art skipped: {e}")
        tag_file(audio_file, meta, cover)

        stem = safe_filename(msg.get("filename") or f"{meta.get('artist', '')} - {meta.get('title', '')}".strip(" -"))
        res = finish_track(audio_file, stem, resolve_out_dir(msg), msg.get("vlc_url"), progress)
        send({"id": job_id, "type": "done", "audio": describe_audio(info), **res})
    except Cancelled:
        send({"id": job_id, "type": "error", "error": "Cancelled.", "cancelled": True})
    except Exception as e:
        log.error("Download failed: %s", traceback.format_exc())
        send({"id": job_id, "type": "error", "error": friendly_error(e)})
    finally:
        CANCELLED.discard(job_id)
        remove_tmp(tmp)


# ------------------------------------------------------------------ playlists --

def fill_pattern(pattern, meta):
    name = re.sub(r"\{(\w+)\}", lambda m: str(meta.get(m.group(1)) or ""), pattern or "{artist} - {title}")
    name = re.sub(r"\(\s*\)|\[\s*\]", "", name)
    return re.sub(r"^\s*-\s*|\s*-\s*$", "", name).strip()


def _enrich(entries):
    """SoundCloud's flat listing has only URLs. Look up title/artist/length/cover
    (metadata only, no stream resolving) for those, 8 at a time."""
    from concurrent.futures import ThreadPoolExecutor

    def one(e):
        try:
            with yt_dlp.YoutubeDL(ydl_base_opts()) as ydl:
                i = ydl.extract_info(e["url"], download=False, process=False)
            e.update(title=i.get("title") or e["title"], duration=i.get("duration"),
                     uploader=i.get("uploader") or e["uploader"], thumb=best_thumbnail(i) or e["thumb"])
        except Exception as ex:
            log.info("Couldn't enrich %s: %s", e["url"], ex)
            e["unavailable"] = True
    with ThreadPoolExecutor(8) as pool:
        list(pool.map(one, entries[:300]))


def cmd_playlist_info(msg):
    """Fast, flat listing of a playlist / album / SoundCloud set."""
    url = msg["url"]
    # YouTube "Mix" lists (RD…) are generated and nearly endless: take the first 50.
    is_mix = re.search(r"[?&]list=RD", url) is not None
    opts = ydl_base_opts() | {"extract_flat": "in_playlist", "noplaylist": False,
                              "playlistend": 50 if is_mix else 500}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get("_type") not in ("playlist", "multi_video"):
        raise RuntimeError("That link isn't a playlist.")
    entries = []
    for i, e in enumerate(info.get("entries") or [], 1):
        if not e:
            continue
        url = e.get("url") or e.get("webpage_url")
        if url and not url.startswith("http") and e.get("ie_key") == "Youtube":
            url = f"https://www.youtube.com/watch?v={e.get('id') or url}"
        title = e.get("title") or ""
        unavailable = title in ("[Private video]", "[Deleted video]") or not url
        thumbs = [t for t in (e.get("thumbnails") or []) if t.get("url")]
        thumb = (min(thumbs, key=lambda t: abs((t.get("width") or 320) - 320))["url"] if thumbs
                 else e.get("thumbnail"))
        entries.append({
            "index": i, "url": url, "title": title or (url or "").rstrip("/").rsplit("/", 1)[-1],
            "uploader": re.sub(r"\s*-\s*Topic$", "", e.get("channel") or e.get("uploader") or ""),
            "duration": e.get("duration"), "thumb": thumb, "unavailable": unavailable,
        })
    bare = [x for x in entries if not x["unavailable"] and x["duration"] is None and not x["thumb"]]
    if bare:
        _enrich(bare)
    title = info.get("title") or "Playlist"
    title = re.sub(r"^Album - ", "", title)
    owner = re.sub(r"\s*-\s*Topic$", "", info.get("channel") or info.get("uploader") or "")
    return {
        "title": title, "uploader": owner, "count": len(entries),
        "thumbnail": best_thumbnail(info) or next((x["thumb"] for x in entries if x["thumb"]), None),
        "source": info.get("extractor_key"), "webpage_url": info.get("webpage_url") or msg["url"],
        "entries": entries,
    }


def cmd_sc_tracks(msg):
    """Fill in SoundCloud tracks the popup read off a page the user is signed in
    to (personal mixes can't be fetched from outside). The tracks themselves are
    public: `ids` are looked up 50 at a time, `urls` get title/artist/cover."""
    tracks = {}
    ids = [str(int(i)) for i in msg.get("ids") or []]
    if ids:
        with yt_dlp.YoutubeDL(ydl_base_opts()) as ydl:
            ie = ydl.get_info_extractor("Soundcloud")
            ie.initialize()
            for i in range(0, len(ids), 50):
                batch = ids[i:i + 50]
                for t in ie._call_api(ie._API_V2_BASE + "tracks", "tracks", query={"ids": ",".join(batch)},
                                      headers=ie._HEADERS, fatal=False) or []:
                    art = t.get("artwork_url") or (t.get("user") or {}).get("avatar_url")
                    tracks[str(t["id"])] = {
                        "url": t.get("permalink_url"), "title": t.get("title") or "",
                        "uploader": (t.get("user") or {}).get("username") or "",
                        "duration": (t.get("duration") or 0) / 1000 or None,
                        "thumb": art.replace("-large.", "-t200x200.") if art else None,
                    }
    entries = [{"url": u, "title": u.rstrip("/").rsplit("/", 1)[-1], "uploader": "", "duration": None,
                "thumb": None, "unavailable": False} for u in msg.get("urls") or []]
    if entries:
        _enrich(entries)
    return {"tracks": tracks, "entries": entries}


def run_playlist(job_id, msg):
    """Download the chosen playlist entries one by one. One bad track (private,
    removed, region-locked) is skipped instead of stopping the whole run."""
    fmt = msg.get("format", "best")
    items = msg.get("entries") or []
    n = len(items)
    album = (msg.get("album") or "").strip()
    album_artist = (msg.get("album_artist") or "").strip()
    out_dir = resolve_out_dir(msg)
    if msg.get("subfolder", True) and album:
        out_dir = out_dir / safe_filename(album)
    saved, sent, skipped, cancelled = 0, 0, [], False

    for k, item in enumerate(items):
        if job_id in CANCELLED:
            cancelled = True
            break
        tmp = Path(tempfile.mkdtemp(prefix="snagtune_"))
        weights = {"starting": (0, 0), "downloading": (0, 0.8), "converting": (0.85, 0),
                   "tagging": (0.9, 0), "sending": (0.9, 0.1)}

        def progress(stage, percent=None, _k=k, _item=item, **extra):
            base, span = weights.get(stage, (0, 0))
            frac = base + span * ((percent or 0) / 100)
            overall = (_k + frac) / n * 100
            send({"id": job_id, "type": "progress", "stage": stage, "percent": round(overall, 1),
                  "item": _k + 1, "total": n, "current": _item.get("title"),
                  "speed": extra.get("speed") if stage == "downloading" else None})

        try:
            check_ffmpeg()
            progress("starting")
            audio_file, info = fetch_track(item["url"], fmt, tmp, progress, job_id)
            progress("tagging")
            meta = guess_metadata(info)
            if album:
                meta["album"] = album
            if album_artist:
                meta["album_artist"] = album_artist
            if msg.get("number", True):
                meta["track"] = str(item.get("index") or k + 1)
            # the user's own edits for this track (only the fields they changed)
            meta.update({key: str(v) for key, v in (item.get("meta") or {}).items() if v is not None})
            cover = None
            try:
                spec = item.get("cover") or {"type": "url", "value": best_thumbnail(info)}
                cover = load_cover(spec, item.get("square", msg.get("square_cover", True)))
            except Exception as e:
                log.warning("Cover failed: %s", e)
            tag_file(audio_file, meta, cover)
            track_no = meta["track"] if str(meta.get("track", "")).isdigit() else ""
            stem = fill_pattern(msg.get("pattern"), meta | {"track": f"{int(track_no):02d}" if track_no else ""})
            if msg.get("number", True):
                stem = f"{int(track_no or item.get('index') or k + 1):02d} - {stem}"
            res = finish_track(audio_file, safe_filename(stem), out_dir, msg.get("vlc_url"), progress)
            saved += 1
            sent += res.get("vlc") == "sent"
            if res.get("vlc_error"):
                skipped.append(f"{item.get('title')}: not sent to VLC, saved to PC")
        except Cancelled:
            cancelled = True
            break
        except Exception as e:
            log.warning("Playlist item failed (%s): %s", item.get("url"), e)
            skipped.append(f"{item.get('title') or item.get('url')}: {friendly_error(e)}")
        finally:
            remove_tmp(tmp)

    CANCELLED.discard(job_id)
    local = saved - sent
    summary = {"saved": saved, "sent": sent, "skipped": len(skipped), "total": n, "cancelled": cancelled}
    if saved == 0:
        send({"id": job_id, "type": "error", "cancelled": cancelled,
              "error": "Cancelled." if cancelled else (skipped[0] if skipped else "Nothing was downloaded."),
              "playlist": summary})
        return
    send({"id": job_id, "type": "done", "ext": fmt, "playlist": summary,
          "path": str(out_dir) if local else None, "vlc": "sent" if sent and not local else None,
          "skipped_list": skipped[:8]})


def cmd_download_playlist(msg):
    threading.Thread(target=run_playlist, args=(msg["id"], msg), daemon=True).start()
    return None


def cmd_cancel(msg):
    CANCELLED.add(msg["job"])
    return {}


def friendly_error(e):
    text = re.sub(r"\x1b\[[0-9;]*m", "", str(e))
    text = text.replace("ERROR: ", "")
    if "Sign in to confirm" in text:
        text += " (YouTube is rate-limiting you. Try the 'Update yt-dlp' button, or wait a bit.)"
    return text


def cmd_download(msg):
    threading.Thread(target=run_download, args=(msg["id"], msg), daemon=True).start()
    return None  # replies come asynchronously


# ---------------------------------------------------------- VLC Wi-Fi sharing --
# VLC for iOS/Android ("Sharing via Wi-Fi") serves a page whose uploader posts
# each file as multipart/form-data to /upload.json, field "files[]".

AUDIO_MIME = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".opus": "audio/ogg", ".ogg": "audio/ogg",
              ".flac": "audio/flac", ".wav": "audio/wav", ".aac": "audio/aac"}


def vlc_base(url):
    url = (url or "").strip()
    if not url:
        raise RuntimeError("Set your VLC address in Settings first.")
    if not re.match(r"^https?://", url, re.I):
        url = "http://" + url
    p = urllib.parse.urlsplit(url)
    return f"{p.scheme}://{p.netloc}"


def cmd_vlc_ping(msg):
    base = vlc_base(msg.get("url"))
    try:
        with urllib.request.urlopen(base + "/", timeout=2) as r:  # polled every few seconds
            html = r.read(200_000).decode("utf-8", "replace")
    except Exception as e:
        raise RuntimeError(f"VLC isn't reachable at {base}. Open VLC › Sharing via Wi-Fi on your phone "
                           f"and keep the phone on the same Wi-Fi. ({e.__class__.__name__})")
    if "upload.json" not in html or "vlc" not in html.lower():
        raise RuntimeError(f"Something answered at {base}, but it isn't VLC's Wi-Fi sharing page.")
    return {"ok": True, "base": base}


def vlc_upload(path, url, on_progress=None):
    """Stream one file to VLC's /upload.json exactly like its own web page does."""
    path = Path(path)
    base = urllib.parse.urlsplit(vlc_base(url))
    boundary = "----SnagTune" + os.urandom(12).hex()
    name = path.name.replace('"', "'").replace("\r", " ").replace("\n", " ")
    mime = AUDIO_MIME.get(path.suffix.lower(), "application/octet-stream")
    head = (f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="files[]"; filename="{name}"\r\n'
            f"Content-Type: {mime}\r\n\r\n").encode("utf-8")
    tail = f"\r\n--{boundary}--\r\n".encode("ascii")
    size = path.stat().st_size
    total = len(head) + size + len(tail)

    conn_cls = http.client.HTTPSConnection if base.scheme == "https" else http.client.HTTPConnection
    conn = conn_cls(base.netloc, timeout=60)
    try:
        conn.connect()
    except OSError as e:
        conn.close()
        raise RuntimeError(f"Couldn't reach VLC at {base.scheme}://{base.netloc}. Open VLC › Sharing via Wi-Fi "
                           "on your phone and keep the screen on.") from e
    try:
        conn.putrequest("POST", "/upload.json")
        conn.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
        conn.putheader("Content-Length", str(total))
        conn.putheader("X-Requested-With", "XMLHttpRequest")
        conn.endheaders()
        conn.send(head)
        sent, last = 0, -1
        with open(path, "rb") as f:
            while chunk := f.read(256 * 1024):
                conn.send(chunk)
                sent += len(chunk)
                pct = round(sent / size * 100) if size else 100
                if on_progress and pct != last:
                    on_progress(pct)
                    last = pct
        conn.send(tail)
        resp = conn.getresponse()
        resp.read()
        if resp.status >= 300:
            raise RuntimeError(f"VLC refused the upload (HTTP {resp.status}).")
    except (OSError, http.client.HTTPException) as e:
        raise RuntimeError(f"Lost the connection to VLC while sending ({e.__class__.__name__}). "
                           "Keep VLC's Sharing via Wi-Fi screen open.") from e
    finally:
        conn.close()


def cmd_vlc_send(msg):
    path = Path(msg["path"])
    if not path.is_file():
        raise RuntimeError("That file isn't on disk anymore.")
    vlc_upload(path, msg.get("url"))
    return {"sent": True}


_PICK_FOLDER = r"""
import sys, tkinter
from tkinter import filedialog
root = tkinter.Tk()
root.withdraw()
root.attributes("-topmost", True)  # open in front of Chrome, not behind it
path = filedialog.askdirectory(parent=root, initialdir=sys.argv[1] or None,
                               title="Choose where Drop saves music", mustexist=False)
sys.stdout.write(path or "")
"""


def cmd_pick_folder(msg):
    """Native Windows folder picker. Extensions can't see real paths, so we ask here."""
    initial = msg.get("initial") or str(default_dir())
    while initial and not os.path.isdir(initial):
        parent = os.path.dirname(initial)
        initial = parent if parent != initial else ""
    r = subprocess.run([sys.executable, "-c", _PICK_FOLDER, initial], capture_output=True, text=True,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    path = r.stdout.strip()
    return {"path": os.path.normpath(path) if path else None}


def cmd_reveal(msg):
    path = Path(msg["path"])
    if os.name == "nt":
        if path.exists():
            subprocess.Popen(["explorer", "/select,", str(path)])
        else:
            os.startfile(str(path.parent if path.suffix else path))
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path.parent)])
    return {}


def cmd_image(msg):
    """Fetch an image for the popup's cover editor. Extension pages can't read
    pixels from other sites' images, so we hand back a data: URL. Chrome caps
    host->extension messages at 1 MB, so keep the JPEG well under that."""
    if Image is None:
        raise RuntimeError("Pillow is missing. Run install.ps1 again.")
    img = Image.open(io.BytesIO(fetch_bytes(msg["url"]))).convert("RGB")
    img.thumbnail((1600, 1600), Image.LANCZOS)
    quality = 90
    while True:
        out = io.BytesIO()
        img.save(out, "JPEG", quality=quality)
        if out.tell() < 600_000 or quality <= 50:
            break
        quality -= 10
    return {"data": "data:image/jpeg;base64," + base64.b64encode(out.getvalue()).decode("ascii"),
            "width": img.width, "height": img.height}


def _wallpaper_source():
    """Where the current desktop wallpaper lives: the path Windows reports, else
    TranscodedWallpaper (the copy Windows actually displays, also for slideshows)."""
    if os.name != "nt":
        return None
    import ctypes
    buf = ctypes.create_unicode_buffer(1024)
    ctypes.windll.user32.SystemParametersInfoW(0x0073, len(buf), buf, 0)  # SPI_GETDESKWALLPAPER
    for p in (buf.value, os.path.expandvars(r"%APPDATA%\Microsoft\Windows\Themes\TranscodedWallpaper")):
        if p and os.path.isfile(p) and os.path.getsize(p) > 0:
            return p
    return None


def _desktop_color():
    """Solid-colour desktops have no image: use the background colour instead."""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Control Panel\Colors") as k:
            r, g, b = (int(x) for x in winreg.QueryValueEx(k, "Background")[0].split())
        return f"#{r:02x}{g:02x}{b:02x}"
    except Exception:
        return None


def cmd_wallpaper(msg):
    """The desktop wallpaper as a small JPEG data: URL for the popup background.
    Pass the last `sig` back to skip re-sending an unchanged wallpaper."""
    src = _wallpaper_source()
    if not src:
        color = _desktop_color()
        sig = f"color:{color}"
        return {"same": True, "sig": sig} if msg.get("sig") == sig else {"sig": sig, "color": color}
    st = os.stat(src)
    sig = f"{src}|{st.st_mtime_ns}|{st.st_size}"
    if msg.get("sig") == sig:
        return {"same": True, "sig": sig}
    if Image is None:
        raise RuntimeError("Pillow is missing. Run install.ps1 again.")
    img = Image.open(src).convert("RGB")
    img.thumbnail((1100, 1100), Image.LANCZOS)  # popup is ~400 px wide; 2x for sharp screens
    quality = 85
    while True:
        out = io.BytesIO()
        img.save(out, "JPEG", quality=quality, optimize=True)
        if out.tell() < 600_000 or quality <= 50:  # Chrome caps host messages at 1 MB
            break
        quality -= 10
    return {"sig": sig, "data": "data:image/jpeg;base64," + base64.b64encode(out.getvalue()).decode("ascii"),
            "width": img.width, "height": img.height}


# ------------------------------------------------------------- app updates --
# New versions are published as GitHub releases with Drop-Setup.exe attached.

GITHUB_REPO = "mainyaszed/drop"


def _vtuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v or "0")[:3])


def _installed_version():
    try:
        return json.loads((HERE / "extension" / "manifest.json").read_text(encoding="utf-8"))["version"]
    except Exception:
        return None


def cmd_check_update(msg):
    req = urllib.request.Request(f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest",
                                 headers={"User-Agent": "Drop-updater", "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 404:  # no release published yet
            return {"latest": None, "newer": False}
        raise
    latest = (data.get("tag_name") or "").lstrip("vV")
    asset = next((a for a in data.get("assets") or [] if a.get("name", "").lower().endswith(".exe")), None)
    current = msg.get("current") or _installed_version()
    return {
        "latest": latest, "current": current,
        "newer": bool(asset) and _vtuple(latest) > _vtuple(current),
        "url": asset and asset["browser_download_url"], "page": data.get("html_url"),
        "notes": (data.get("body") or "")[:600],
    }


def cmd_installed_version(_msg):
    return {"version": _installed_version()}


def cmd_install_update(msg):
    """Download the release's Drop-Setup.exe and open it. Only files from this
    project's own GitHub releases are accepted."""
    url = msg.get("url") or ""
    if not url.startswith(f"https://github.com/{GITHUB_REPO}/releases/download/"):
        raise RuntimeError("That update doesn't come from Drop's GitHub releases.")
    version = safe_filename(msg.get("version") or "latest")
    dest = Path(tempfile.gettempdir()) / f"Drop-Setup-{version}.exe"
    req = urllib.request.Request(url, headers={"User-Agent": "Drop-updater"})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f, 256 * 1024)

    if msg.get("silent"):
        # Unpack the installer and run it in update mode. Setup stops this
        # helper while it updates, so the setup process must not be our child in
        # Chrome's eyes: start it detached and outside our job if Windows allows.
        unpack = Path(tempfile.gettempdir()) / f"drop-update-{version}"
        shutil.rmtree(unpack, ignore_errors=True)
        unpack.mkdir(parents=True)
        subprocess.run([str(dest), "/C", f"/T:{unpack}", "/Q"], check=True, timeout=120,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        # the setup window in update mode: shows the progress, needs no clicks, closes itself
        cmd = ["powershell.exe", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
               "-File", str(unpack / "setup-gui.ps1"), "-Update", "-Version", version]
        log_file = open(HERE / "update.log", "w", encoding="utf-8")
        # a hidden console, not DETACHED_PROCESS: PowerShell quietly does nothing without one
        base = 0x00000200 | 0x08000000  # CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        kw = dict(cwd=str(unpack), stdin=subprocess.DEVNULL, stdout=log_file, stderr=subprocess.STDOUT)
        try:
            subprocess.Popen(cmd, creationflags=base | 0x01000000, **kw)  # + CREATE_BREAKAWAY_FROM_JOB
        except OSError:
            subprocess.Popen(cmd, creationflags=base, **kw)
        return {"started": True, "silent": True}

    # Interactive: open the setup window through Explorer (outside this helper's
    # process tree, since setup stops the running helper while it updates).
    subprocess.Popen(["explorer.exe", str(dest)])
    return {"started": True, "path": str(dest)}


def cmd_update(_msg):
    r = subprocess.run([sys.executable, "-m", "pip", "install", "-U", "--quiet", "yt-dlp[default]"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-500:] or "pip failed")
    out = subprocess.run([sys.executable, "-c", "import yt_dlp; print(yt_dlp.version.__version__)"],
                         capture_output=True, text=True)
    return {"yt_dlp": out.stdout.strip(), "note": "Restart the browser (or reload the extension) to use it."}


COMMANDS = {"ping": cmd_ping, "info": cmd_info, "download": cmd_download,
            "reveal": cmd_reveal, "update": cmd_update, "image": cmd_image,
            "vlc_ping": cmd_vlc_ping, "vlc_send": cmd_vlc_send, "pick_folder": cmd_pick_folder,
            "playlist_info": cmd_playlist_info, "download_playlist": cmd_download_playlist, "cancel": cmd_cancel,
            "wallpaper": cmd_wallpaper, "sc_tracks": cmd_sc_tracks,
            "check_update": cmd_check_update, "installed_version": cmd_installed_version, "install_update": cmd_install_update}


def handle(msg):
    mid = msg.get("id")
    try:
        result = COMMANDS[msg["cmd"]](msg)
        if result is not None:
            send({"id": mid, "type": "result", "result": result})
    except Exception as e:
        log.error("Command %s failed: %s", msg.get("cmd"), traceback.format_exc())
        send({"id": mid, "type": "error", "error": friendly_error(e)})


def main():
    log.info("Host started (v%s, yt-dlp %s)", VERSION, yt_dlp.version.__version__)
    threading.Thread(target=sweep_old_tmp, daemon=True).start()
    while True:
        msg = read_message()
        if msg is None:
            break
        # slow commands (network) must never block the reader loop
        if msg.get("cmd") in ("info", "update", "vlc_ping", "vlc_send", "pick_folder", "playlist_info", "wallpaper", "sc_tracks", "check_update", "install_update"):
            threading.Thread(target=handle, args=(msg,), daemon=True).start()
        else:
            handle(msg)
    log.info("Host exiting")


if __name__ == "__main__":
    main()
