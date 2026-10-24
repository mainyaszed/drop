const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const FORMAT_HINTS = {
  best: "Original stream, no re-encoding: the highest quality.",
  mp3: "320 kbps, plays on everything (car stereos, old players).",
  m4a: "AAC, ideal for Apple Music / iTunes.",
  flac: "Lossless copy of the source. Big files, same quality.",
};

const DEFAULT_SETTINGS = { outDir: "", format: "best", pattern: "{artist} - {title}", vlc: "", bg: "wallpaper", autoUpdate: true };

const BG_HINTS = {
  wallpaper: "Your Windows desktop wallpaper. Follows it when you change it.",
  custom: "A picture of your choice. Click Image again to pick another.",
  orbs: "Colour orbs on white.",
};

const state = {
  url: null,
  info: null,
  format: "best",
  coverMode: "thumb", // thumb (original artwork) | custom | none
  coverData: null, // custom image as a data: URL (picked, pasted or dropped)
  coverLink: null, // custom image as an http(s) URL (pasted link)
  filenameEdited: false,
  settings: { ...DEFAULT_SETTINGS },
  vlcReady: false, // VLC's Wi-Fi sharing page answered at settings.vlc
  trackUrl: null, // the single track on this page, if any
  plUrl: null, // the playlist on this page, if any
  playlist: null, // playlist_info result for plUrl
  media: "audio", // "audio" | "video"
  quality: "best", // video: "best" or a height like "1080"
  clip: null, // {start, end, speed, crop, exact} from the editor, or null
  plMedia: "audio",
  plQuality: "best",
  edits: {}, // per-track playlist edits, by playlist index: {meta?, cover?, square?}
  editIdx: null, // entries[] position of the track being edited, else null
  editBase: null, // that track's values before any edit (to store only what changed)
  defaultDir: "", // the helper's default download folder, for display
  jobs: {},
};

// ------------------------------------------------------------- helpers --

async function bg(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  if (!res?.ok) throw new Error(res?.error || "No response from background");
  return res.result;
}

function show(id, on = true) {
  $(id).hidden = !on;
}

function showError(msg) {
  $("#errorBox").textContent = msg;
  show("#errorBox", !!msg);
}

function isTrackUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\.|^m\./, "");
    if (h === "youtu.be") return u.pathname.length > 1;
    if (h === "youtube.com" || h === "music.youtube.com") {
      return (u.pathname === "/watch" && u.searchParams.has("v")) || /^\/(shorts|live)\/[\w-]+/.test(u.pathname);
    }
    if (h === "soundcloud.com" || h === "on.soundcloud.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      const reserved = ["discover", "feed", "you", "search", "stream", "upload", "messages", "notifications", "settings", "charts"];
      return h === "on.soundcloud.com" ? parts.length === 1 : parts.length === 2 && !reserved.includes(parts[0]) && parts[1] !== "sets";
    }
  } catch {}
  return false;
}

// The playlist/set/album a link points to (or that the video belongs to), else null.
function playlistUrl(url) {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\.|^m\./, "");
    if (h === "youtube.com" || h === "music.youtube.com") {
      const list = u.searchParams.get("list");
      // WL / LL / LM are your private Watch later / Liked lists: they need a sign-in
      if (list && !/^(WL|LL|LM)$/.test(list)) {
        const v = u.searchParams.get("v");
        if (/^RD/.test(list) && v) return `https://www.youtube.com/watch?v=${v}&list=${list}`; // Mix
        return `https://${h}/playlist?list=${list}`;
      }
      if (h === "music.youtube.com" && /^\/browse\/(MPREb|VL)/.test(u.pathname)) return u.origin + u.pathname;
    }
    if (h === "soundcloud.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 3 && parts[1] === "sets") return `https://soundcloud.com/${parts[0]}/sets/${parts[2]}`;
      const inSet = u.searchParams.get("in"); // a track opened from a set
      if (inSet && /\/sets\//.test(inSet)) return `https://soundcloud.com/${inSet}`;
    }
  } catch {}
  return null;
}

function normalizeUrl(url) {
  const u = new URL(url);
  if (u.hostname.includes("youtube.com") && u.searchParams.has("v")) {
    // drop playlist/radio params so we only grab this one video
    return `https://${u.hostname}/watch?v=${u.searchParams.get("v")}`;
  }
  if (u.hostname.includes("soundcloud.com")) {
    u.search = "";
    u.hash = "";
  }
  return u.toString();
}

function fmtDuration(s) {
  if (!s) return "";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, "0")}` : m) + ":" + String(sec).padStart(2, "0");
}

function fmtSpeed(bps) {
  if (!bps) return "";
  return bps > 1e6 ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} KB/s`;
}

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, " ").trim();
}

function currentMeta() {
  return {
    title: $("#fTitle").value.trim(),
    artist: $("#fArtist").value.trim(),
    album: $("#fAlbum").value.trim(),
    album_artist: $("#fAlbumArtist").value.trim(),
    year: $("#fYear").value.trim(),
    genre: $("#fGenre").value.trim(),
    track: $("#fTrack").value.trim(),
    comment: state.info?.meta?.comment || state.url,
  };
}

function filenameFromPattern() {
  const m = currentMeta();
  const name = state.settings.pattern
    .replace(/\{(\w+)\}/g, (_, k) => m[k] || "")
    .replace(/\s*-\s*$/, "")
    .replace(/^\s*-\s*/, "")
    .replace(/\(\s*\)|\[\s*\]/g, "");
  return sanitize(name) || "track";
}

function extFor(format) {
  if (state.media === "video") return "mp4";
  return format === "best" ? state.info?.best_ext || "opus" : format;
}

// --------------------------------------------------------------- draft --
// The popup closes whenever it loses focus, so keep edits per URL.

async function saveDraft() {
  if (state.editIdx != null) return saveTrackEdit(); // editing one track of a playlist
  if (!state.url || !state.info) return;
  const draft = {
    meta: currentMeta(),
    filename: $("#fFilename").value,
    filenameEdited: state.filenameEdited,
    format: state.format,
    coverMode: state.coverMode,
    coverData: state.coverData,
    coverLink: state.coverLink,
    square: $("#squareCrop").checked,
  };
  await chrome.storage.session.set({ [`draft:${state.url}`]: draft });
}

// ---------------------------------------------------------------- cover --

function setCoverMode(mode) {
  state.coverMode = mode;
  renderCover();
}

function coverSrc() {
  switch (state.coverMode) {
    case "thumb": return state.info?.thumbnail;
    case "custom": return state.coverData || state.coverLink;
    default: return null;
  }
}

function renderCover() {
  const src = coverSrc();
  const box = $("#coverBox");
  const img = $("#coverImg");
  show("#coverNone", !src);
  img.hidden = !src;
  if (src) img.src = src;
  box.classList.toggle("empty", !src);
  box.classList.toggle("wide", !$("#squareCrop").checked);
  show("#coverTag", state.coverMode === "custom" && !!src);
  // "Use original" only makes sense when the original isn't showing
  show("#coverRestore", state.coverMode !== "thumb" && !!state.info?.thumbnail);
  const square = $("#squareCrop").checked;
  $("#squareBtn").setAttribute("aria-pressed", String(square));
  $("#squareBtn").title = square ? "Cropped to square (click for original shape)" : "Original shape (click to crop square)";
}

function coverPayload() {
  switch (state.coverMode) {
    case "thumb": return { type: "url", value: state.info.thumbnail };
    case "custom":
      if (state.coverData) return { type: "data", value: state.coverData };
      if (state.coverLink) return { type: "url", value: state.coverLink };
      return { type: "none" };
    default: return { type: "none" };
  }
}

// Shrink big images (phone photos, 4K screenshots) before storing them: the
// helper re-encodes anyway, and session storage is limited.
function imageToDataUrl(blob, max = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.92));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't an image Chrome can read.")); };
    img.src = url;
  });
}

async function setCustomImage(blob) {
  if (!blob?.type?.startsWith("image/")) return showError("That's not an image.");
  try {
    state.coverData = await imageToDataUrl(blob);
    state.coverLink = null;
    showError("");
    setCoverMode("custom");
    saveDraft();
  } catch (e) {
    showError(e.message);
  }
}

function setCustomLink(url) {
  state.coverLink = url;
  state.coverData = null;
  setCoverMode("custom");
  saveDraft();
}

const IMAGE_URL = /^https?:\/\/\S+\.(?:jpe?g|png|webp|gif|avif|bmp)(?:[?#]\S*)?$|^https?:\/\/(?:i\.ytimg\.com|i\d\.sndcdn\.com|lh\d\.googleusercontent\.com)\/\S+$/i;

function onPaste(e) {
  if ($("#trackForm").hidden || !$("#editor").hidden) return;
  const items = [...(e.clipboardData?.items || [])];
  const file = items.find((i) => i.kind === "file" && i.type.startsWith("image/"))?.getAsFile();
  if (file) {
    e.preventDefault();
    return setCustomImage(file);
  }
  // A pasted image link counts too, unless the user is typing in a text field
  const text = e.clipboardData?.getData("text/plain")?.trim();
  const typing = e.target.matches?.("input:not([type=checkbox]), textarea");
  if (text && IMAGE_URL.test(text) && !typing) {
    e.preventDefault();
    setCustomLink(text);
  }
}

// --------------------------------------------------------------- editor --
// Square crop editor: drag to pan, wheel/slider to zoom, rotate 90°, flip.
// The image always covers the square, so the result never has empty edges.

const HOST = "com.snagtune.host";
const STAGE = 240; // css px, matches .stage
const OUT = 1200; // exported cover size
const ed = { img: null, rot: 0, flip: 1, zoom: 1, x: 0, y: 0 };

// Images from other sites can't be read back from a canvas, so the helper
// fetches them for us (one-shot native message, separate from downloads).
async function loadEditableImage(src) {
  let dataUrl = src;
  if (!src.startsWith("data:")) {
    const res = await chrome.runtime.sendNativeMessage(HOST, { id: "img", cmd: "image", url: new URL(src, location.href).href });
    if (!res || res.type === "error") throw new Error(res?.error || "Couldn't load the image.");
    dataUrl = res.result.data;
  }
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  return img;
}

function edDims() {
  const turned = ed.rot % 180 !== 0;
  return turned ? [ed.img.naturalHeight, ed.img.naturalWidth] : [ed.img.naturalWidth, ed.img.naturalHeight];
}

function edScale() {
  const [w, h] = edDims();
  return Math.max(STAGE / w, STAGE / h) * ed.zoom; // "cover" fit, times zoom
}

function edClamp() {
  const [w, h] = edDims();
  const k = edScale();
  const mx = Math.max(0, (w * k - STAGE) / 2);
  const my = Math.max(0, (h * k - STAGE) / 2);
  ed.x = Math.min(mx, Math.max(-mx, ed.x));
  ed.y = Math.min(my, Math.max(-my, ed.y));
}

function edPaint(canvas, size) {
  const ctx = canvas.getContext("2d");
  const f = size / STAGE;
  const k = edScale() * f;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingQuality = "high";
  ctx.translate(size / 2 + ed.x * f, size / 2 + ed.y * f);
  ctx.scale(ed.flip, 1); // flip in screen space, so it's always left-right
  ctx.rotate((ed.rot * Math.PI) / 180);
  ctx.scale(k, k);
  ctx.drawImage(ed.img, -ed.img.naturalWidth / 2, -ed.img.naturalHeight / 2);
}

function edDraw() {
  if (!ed.img) return;
  edClamp();
  const c = $("#edCanvas");
  const size = Math.round(STAGE * devicePixelRatio);
  if (c.width !== size) c.width = c.height = size;
  edPaint(c, size);
  $("#edZoom").value = ed.zoom;
  $("#edFlip").classList.toggle("on", ed.flip === -1);
}

function edReset() {
  Object.assign(ed, { rot: 0, flip: 1, zoom: 1, x: 0, y: 0 });
  edDraw();
}

async function openEditor() {
  const src = coverSrc();
  if (!src) return $("#coverFile").click();
  ed.img = null;
  $("#edCanvas").getContext("2d").clearRect(0, 0, 9999, 9999);
  $("#edLoading").textContent = "Loading image…";
  show("#edLoading");
  show("#editor");
  document.body.classList.add("editing");
  try {
    ed.img = await loadEditableImage(src);
    show("#edLoading", false);
    edReset();
  } catch (e) {
    $("#edLoading").textContent = e.message;
  }
}

function closeEditor() {
  show("#editor", false);
  document.body.classList.remove("editing");
  ed.img = null;
}

function applyEditor() {
  if (!ed.img) return closeEditor();
  const c = document.createElement("canvas");
  c.width = c.height = OUT;
  edPaint(c, OUT);
  state.coverData = c.toDataURL("image/jpeg", 0.92);
  state.coverLink = null;
  $("#squareCrop").checked = true; // already square
  closeEditor();
  setCoverMode("custom");
  saveDraft();
}

function setupEditor() {
  $("#editBtn").onclick = (e) => { e.stopPropagation(); openEditor(); };
  $("#edClose").onclick = closeEditor;
  $("#edCancel").onclick = closeEditor;
  $("#edApply").onclick = applyEditor;
  $("#edReset").onclick = edReset;
  $("#editor").onclick = (e) => { if (e.target.id === "editor") closeEditor(); };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#editor").hidden) { e.preventDefault(); closeEditor(); }
  });

  const rotate = (dir) => {
    ed.rot = (ed.rot + dir * 90 + 360) % 360;
    [ed.x, ed.y] = dir > 0 ? [-ed.y, ed.x] : [ed.y, -ed.x]; // keep the same spot centred
    edDraw();
  };
  $("#edRotL").onclick = () => rotate(-1);
  $("#edRotR").onclick = () => rotate(1);
  $("#edFlip").onclick = () => { ed.flip *= -1; ed.x = -ed.x; edDraw(); };
  $("#edZoom").oninput = (e) => { ed.zoom = Number(e.target.value); edDraw(); };

  const stage = $("#edStage");
  stage.onwheel = (e) => {
    if (!ed.img) return;
    e.preventDefault();
    const z = Math.min(5, Math.max(1, ed.zoom * Math.exp(-e.deltaY * 0.0015)));
    // zoom towards the cursor
    const r = stage.getBoundingClientRect();
    const px = e.clientX - r.left - STAGE / 2, py = e.clientY - r.top - STAGE / 2;
    ed.x = px - (px - ed.x) * (z / ed.zoom);
    ed.y = py - (py - ed.y) * (z / ed.zoom);
    ed.zoom = z;
    edDraw();
  };
  let drag = null;
  stage.onpointerdown = (e) => {
    if (!ed.img) return;
    stage.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY };
    stage.classList.add("moving");
  };
  stage.onpointermove = (e) => {
    if (!drag) return;
    ed.x += e.clientX - drag.x;
    ed.y += e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    edDraw();
  };
  stage.onpointerup = stage.onpointercancel = () => { drag = null; stage.classList.remove("moving"); };
}

// ---------------------------------------------------------------- format --

function setFormat(f) {
  state.format = f;
  $$(".seg[data-format]").forEach((b) => b.classList.toggle("active", b.dataset.format === f));
  $("#fExt").textContent = "." + extFor(f);
}

// ----------------------------------------------------------------- track --

async function loadTrack(url) {
  state.url = normalizeUrl(url);
  state.trackUrl = url;
  show("#empty", false);
  show("#trackForm", false);
  show("#playlistForm", false);
  showError("");
  $("#loadingMsg").textContent = "Reading track info…";
  show("#loading");

  const cacheKey = `info:${state.url}`;
  const draftKey = `draft:${state.url}`;
  const cached = await chrome.storage.session.get([cacheKey, draftKey]);
  try {
    state.info = cached[cacheKey] || (await bg("info", { url: state.url }));
    await chrome.storage.session.set({ [cacheKey]: state.info });
  } catch (e) {
    show("#loading", false);
    showError(e.message);
    show("#empty");
    $("#urlInput").value = state.url;
    return;
  }
  show("#loading", false);
  fillForm(state.info, cached[draftKey]);
  show("#trackForm");
}

function fillForm(info, draft) {
  const m = draft?.meta || info.meta;
  $("#fTitle").value = m.title || "";
  $("#fArtist").value = m.artist || "";
  $("#fAlbum").value = m.album || "";
  $("#fAlbumArtist").value = m.album_artist || "";
  $("#fYear").value = m.year || "";
  $("#fGenre").value = m.genre || "";
  $("#fTrack").value = m.track || "";

  const sc = /soundcloud/i.test(info.source);
  $("#sourceBadge").textContent = sc ? "SoundCloud" : "YouTube";
  $("#sourceBadge").classList.toggle("sc", sc);
  $("#audioInfo").textContent = [info.audio, fmtDuration(info.duration)].filter(Boolean).join(" · ");

  $("#squareCrop").checked = draft ? draft.square : true;
  state.coverData = draft?.coverData || null;
  state.coverLink = draft?.coverLink || null;
  state.filenameEdited = !!draft?.filenameEdited;
  setFormat(draft?.format || state.settings.format);
  // drafts from older versions used upload/url modes
  const mode = { upload: "custom", url: "custom" }[draft?.coverMode] || draft?.coverMode || "thumb";
  setCoverMode(mode === "custom" && !state.coverData && !state.coverLink ? "thumb" : mode);
  $("#fFilename").value = state.filenameEdited ? draft.filename : filenameFromPattern();
  state.clip = null;
  ce.frames = {};
  renderQualities();
  $(".mode-seg .seg[data-mode=video]").disabled = !info.has_video;
  setMedia(state.editIdx != null ? "audio" : state.media);
}

async function download(e, toVlc = false) {
  e.preventDefault();
  if (state.editIdx != null) return exitTrackEdit(); // Enter in a field while editing = Done
  const btn = toVlc ? $("#vlcBtn") : $("#downloadBtn");
  btn.disabled = true;
  showError("");
  try {
    const meta = currentMeta();
    await bg("download", {
      request: {
        url: state.url,
        format: state.format,
        meta,
        cover: coverPayload(),
        square_cover: $("#squareCrop").checked,
        filename: sanitize($("#fFilename").value) || filenameFromPattern(),
        out_dir: state.settings.outDir,
        ...(toVlc ? { vlc_url: state.settings.vlc } : {}),
        ...mediaRequest(),
      },
    });
    if (toVlc) {
      setTimeout(() => { btn.disabled = !state.vlcReady; }, 1200);
    } else {
      btn.textContent = "Added ✓";
      setTimeout(() => { btn.textContent = "Download"; btn.disabled = false; }, 1200);
    }
  } catch (err) {
    showError(err.message);
    btn.disabled = toVlc ? !state.vlcReady : false;
  }
}

// ------------------------------------------------------------- send to VLC --

function renderVlcBtn(stateName, title) {
  for (const b of $$(".vlc-btn")) {
    b.classList.toggle("ready", stateName === "ready");
    b.classList.toggle("checking", stateName === "checking");
    b.disabled = stateName !== "ready" || (b.id === "plVlcBtn" && state.playlist && !selectedEntries().length);
    b.title = b.id === "plVlcBtn" && stateName === "ready" ? title.replace("Send to VLC", "Send the selected tracks to VLC") : title;
  }
}

// Lights the VLC button only when the phone's sharing page actually answers.
// quiet = a background poll: no "searching" blink, just flip the button if it changed.
async function checkVlc(quiet = false) {
  const was = state.vlcReady;
  const set = (ready, btnState, title) => {
    state.vlcReady = ready;
    renderVlcBtn(btnState, title);
    if (ready !== was || !quiet) renderJobs(state.jobs); // "→ VLC" links follow readiness
  };
  const addr = state.settings.vlc;
  if (!addr) {
    set(false, "off", "Send to VLC: set your VLC address in Settings");
    return { ok: false, error: "No VLC address set." };
  }
  if (!quiet) renderVlcBtn("checking", "Looking for VLC…");
  try {
    const r = await bg("vlcPing", { url: addr });
    if (addr !== state.settings.vlc) return { ok: false, error: "Address changed." }; // stale answer
    set(true, "ready", `Send to VLC on your phone (${r.base}). Not saved on this PC.`);
    return { ok: true, base: r.base };
  } catch (e) {
    const msg = /Unknown message/.test(e.message)
      ? "Reload Drop once in chrome://extensions to turn on Send to VLC."
      : e.message;
    set(false, "off", `VLC not available: ${msg}`);
    return { ok: false, error: msg };
  }
}

// Keep looking for the phone while the popup is open: the button lights up when
// VLC's sharing screen appears and greys out when it goes away.
const VLC_POLL_MS = 2500;
let vlcTimer = null;
function pollVlc() {
  clearTimeout(vlcTimer);
  checkVlc(true).finally(() => { vlcTimer = setTimeout(pollVlc, VLC_POLL_MS); });
}

// -------------------------------------------------------------- playlists --

function fmtLong(sec) {
  if (!sec) return "";
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

function setScope(scope) {
  $$(".scope-btn").forEach((b) => b.classList.toggle("active", b.dataset.scope === scope));
  if (scope === "playlist") {
    if (state.playlist && state.playlist._url === state.plUrl) {
      show("#trackForm", false);
      show("#playlistForm");
    } else {
      loadPlaylist(state.plUrl);
    }
  } else {
    show("#playlistForm", false);
    if (state.info) show("#trackForm");
    else if (state.trackUrl) loadTrack(state.trackUrl);
  }
}

// ------------------------------------------- SoundCloud: read the open page --
// Personal mixes (soundcloud.com/discover/sets/…) and private sets only exist for
// the signed-in account, so the helper gets "404". The tracks in them are public,
// though: read the list off the page the user has open, then download normally.

async function fetchPlaylist(url) {
  const personal = /soundcloud\.com\/discover\/sets\//.test(url);
  if (!personal) {
    try {
      return await bg("playlistInfo", { url });
    } catch (e) {
      if (!/soundcloud\.com/.test(url) || /Unknown message/.test(e.message)) throw e;
    }
  }
  return playlistFromPage(url);
}

// Runs inside the SoundCloud page (MAIN world, so it can see the page's own data).
async function scrapeSoundCloudPage() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sel = "a.trackItem__trackTitle";
  // long lists render as you scroll: scroll until the count stops growing, then put the page back
  let last = -1, still = 0;
  const t0 = Date.now(), y0 = scrollY;
  while (Date.now() - t0 < 15000) {
    const n = document.querySelectorAll(sel).length;
    if (n === last) { if (++still >= 4) break; } else { still = 0; last = n; }
    scrollTo(0, document.body.scrollHeight);
    await sleep(450);
  }
  scrollTo(0, y0);
  const dom = [...document.querySelectorAll(sel)].map((a) => {
    const li = a.closest("li");
    const art = li && li.querySelector(".sc-artwork");
    const m = art && (art.style.backgroundImage || "").match(/url\("?(.*?)"?\)/);
    return {
      url: new URL(a.getAttribute("href").split("?")[0], location.origin).href,
      title: a.textContent.trim(),
      uploader: (li && li.querySelector(".trackItem__username")?.textContent.trim()) || "",
      thumb: m ? m[1] : null,
    };
  });
  const h = (window.__sc_hydration || []).find((x) => /playlist/i.test(x.hydratable))?.data || {};
  const hyd = (h.tracks || []).map((t) => ({
    id: t.id, url: t.permalink_url || null, title: t.title || "", uploader: t.user?.username || "",
    duration: t.duration ? t.duration / 1000 : null, thumb: t.artwork_url || null,
  }));
  return {
    title: h.title || h.short_title || document.querySelector(".soundTitle__title, .fullHero__title")?.textContent.trim()
      || document.title.replace(/\s*\|.*$/, ""),
    owner: h.user?.username || "",
    artwork: h.artwork_url || h.calculated_artwork_url || null,
    dom, hyd,
    notFound: /can.t find that playlist/i.test(document.body.innerText),
  };
}

const nonEmpty = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));

async function playlistFromPage(url) {
  const signIn = "This SoundCloud playlist only exists for your account. Open it in Chrome while signed in to SoundCloud, then click Drop on that page.";
  const here = (u) => u.replace(/[?#].*$/, "").replace(/\/$/, "");
  if (state.tabId == null || here(state.tabUrl) !== here(url)) throw new Error(signIn);
  if (!chrome.scripting) throw new Error("Reload Drop once in chrome://extensions to read SoundCloud mixes.");
  $("#loadingMsg").textContent = "Reading the playlist from this page…";
  const [{ result: page }] = await chrome.scripting.executeScript({
    target: { tabId: state.tabId }, world: "MAIN", func: scrapeSoundCloudPage,
  });
  if (!page.dom.length && !page.hyd.length) {
    throw new Error(page.notFound
      ? "SoundCloud says this playlist isn't available. Sign in to SoundCloud in this browser, reload the page, then try again."
      : "Couldn't find any tracks on this page. Let it finish loading, then open Drop again.");
  }
  // the page's own data has full details for some tracks; the visible list has every link
  const byUrl = new Map(page.hyd.filter((t) => t.url).map((t) => [t.url, t]));
  let list = page.dom.length >= page.hyd.length
    ? page.dom.map((r) => ({ ...r, ...nonEmpty(byUrl.get(r.url) || {}), url: r.url }))
    : page.hyd;
  // fill the gaps: ids without a link, links without artist/cover
  const ids = list.filter((x) => !x.url && x.id).map((x) => x.id);
  const urls = list.filter((x) => x.url && (!x.thumb || !x.uploader)).map((x) => x.url).slice(0, 300);
  if (ids.length || urls.length) {
    try {
      const r = await bg("scTracks", { ids, urls });
      const byLink = new Map(r.entries.map((e) => [e.url, e]));
      list = list.map((x) => (!x.url && r.tracks[x.id]) ? r.tracks[x.id]
        : x.url && byLink.has(x.url) ? { ...byLink.get(x.url), ...nonEmpty(x) } : x);
    } catch {
      // keep what the page gave us
    }
  }
  const entries = list.filter((x) => x.url).map((x, i) => ({
    index: i + 1, url: x.url, title: x.title || x.url.split("/").pop(), uploader: x.uploader || "",
    duration: x.duration || null, thumb: x.thumb || null, unavailable: false,
  }));
  return {
    title: page.title || "SoundCloud mix", uploader: page.owner || "SoundCloud", count: entries.length,
    thumbnail: page.artwork || entries.find((e) => e.thumb)?.thumb || null,
    source: "SoundcloudSet", webpage_url: url, entries, fromPage: true,
  };
}

async function loadPlaylist(url) {
  state.plUrl = url;
  show("#empty", false);
  show("#trackForm", false);
  show("#playlistForm", false);
  showError("");
  $("#loadingMsg").textContent = "Reading playlist…";
  show("#loading");
  const key = `pl:${url}`;
  try {
    const cached = (await chrome.storage.session.get(key))[key];
    state.playlist = cached || (await fetchPlaylist(url));
    state.playlist._url = url;
    if (!cached) await chrome.storage.session.set({ [key]: state.playlist });
  } catch (e) {
    show("#loading", false);
    showError(/Unknown message/.test(e.message) ? "Reload Drop once in chrome://extensions to download playlists." : e.message);
    if (state.trackUrl) setScope("track");
    else show("#empty");
    return;
  }
  await loadEdits();
  show("#loading", false);
  fillPlaylist(state.playlist);
  show("#playlistForm");
}

function fillPlaylist(pl) {
  $("#plCover").src = pl.thumbnail || "icons/128.png";
  const sc = /soundcloud/i.test(pl.source);
  $("#plBadge").textContent = sc ? "SoundCloud" : /music\.youtube/.test(pl.webpage_url) ? "YouTube Music" : "YouTube";
  $("#plBadge").classList.toggle("sc", sc);
  const total = pl.entries.reduce((n, e) => n + (e.duration || 0), 0);
  $("#plMeta").textContent = [pl.uploader, `${pl.count} tracks`, fmtLong(total)].filter(Boolean).join(" · ");
  $("#plMeta").title = pl.fromPage ? "Read from this page (it's only visible while you're signed in)" : "";
  $("#plTitle").textContent = pl.title;
  $("#plTitle").title = pl.title;
  $("#plAlbum").value = pl.title.replace(/^Mix - /, "");
  $("#plAlbumArtist").value = pl.uploader || "";
  $("#scopeCount").textContent = String(pl.count);
  $("#plList").replaceChildren();
  renderPlRows();
  setFormat(state.format || state.settings.format);
}

const PENCIL = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

const NOTE = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" '
  + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/>'
  + '<circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';

function noArt() {
  const s = document.createElement("span");
  s.className = "pl-noart";
  s.title = "No cover";
  s.innerHTML = NOTE;
  return s;
}

// (Re)draw the track rows, keeping which boxes are ticked.
function renderPlRows() {
  const pl = state.playlist;
  const was = new Map($$("#plList input").map((cb) => [Number(cb.dataset.i), cb.checked]));
  $("#plList").replaceChildren(...pl.entries.map((e, i) => {
    const ed = state.edits[e.index];
    const m = ed?.meta || {};
    const li = document.createElement("li");
    li.className = "pl-item" + (e.unavailable ? " off" : "") + (ed ? " edited" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.i = i;
    cb.checked = was.has(i) ? was.get(i) : !e.unavailable;
    cb.disabled = e.unavailable;
    const idx = document.createElement("span");
    idx.className = "idx";
    idx.textContent = e.index;
    // no cover (removed, missing or failing to load): a placeholder tile, never an empty <img>
    const thumb = ed?.cover ? (ed.cover.mode === "custom" ? ed.cover.data || ed.cover.link : "") : e.thumb;
    let img = noArt();
    if (thumb) {
      img = document.createElement("img");
      img.alt = "";
      img.loading = "lazy";
      img.onerror = () => img.replaceWith(noArt());
      img.src = thumb;
    }
    const t = document.createElement("span");
    t.className = "t";
    const b = document.createElement("b");
    const title = m.title || e.title;
    b.textContent = e.unavailable ? `${title} (unavailable)` : title;
    b.title = title;
    const small = document.createElement("small");
    small.textContent = m.artist || e.uploader || "";
    t.append(b, small);
    const dur = document.createElement("span");
    dur.className = "dur";
    dur.textContent = fmtDuration(e.duration);
    const pen = document.createElement("button");
    pen.type = "button";
    pen.className = "pl-edit";
    pen.innerHTML = PENCIL;
    pen.title = ed ? "Edited: click to change tags & cover" : "Edit tags & cover";
    pen.setAttribute("aria-label", `Edit track ${e.index}`);
    pen.disabled = e.unavailable;
    pen.onclick = (ev) => { ev.stopPropagation(); openTrackEdit(i); };
    li.append(cb, idx, img, t, dur, pen);
    li.onclick = (ev) => {
      if (cb.disabled) return;
      if (ev.target !== cb) cb.checked = !cb.checked;
      updatePlCount();
    };
    li.ondblclick = (ev) => { if (!cb.disabled && ev.target !== cb) { cb.checked = !cb.checked; openTrackEdit(i); } };
    return li;
  }));
  updatePlCount();
}

// ------------------------------------------------- per-track playlist edits --
// Saved in chrome.storage.local (survives closing the popup and the browser),
// one record per playlist, only for tracks that differ from the original.

const editsKey = () => `pledits:${state.plUrl}`;

async function loadEdits() {
  const k = editsKey();
  state.edits = (await chrome.storage.local.get(k))[k] || {};
}

async function storeEdits() {
  const k = editsKey();
  const { pleditsKeys = [] } = await chrome.storage.local.get("pleditsKeys");
  const keys = [k, ...pleditsKeys.filter((x) => x !== k)];
  await chrome.storage.local.set({ [k]: state.edits, pleditsKeys: keys.slice(0, 10) });
  if (keys.length > 10) await chrome.storage.local.remove(keys.slice(10)); // keep the 10 most recent playlists
}

function setEditMode(on) {
  show("#editBar", on);
  show("#editActions", on);
  show("#trackActions", !on);
  show("#filenameRow", !on); // playlist files are named by the playlist rules
}

async function openTrackEdit(i) {
  const e = state.playlist.entries[i];
  state.editIdx = i;
  show("#playlistForm", false);
  show("#scopeBar", false);
  showError("");
  $("#loadingMsg").textContent = "Reading track info…";
  show("#loading");
  const url = normalizeUrl(e.url);
  const key = `info:${url}`;
  let info;
  try {
    info = (await chrome.storage.session.get(key))[key] || (await bg("info", { url }));
    await chrome.storage.session.set({ [key]: info });
  } catch (err) {
    show("#loading", false);
    showError(err.message);
    state.editIdx = null;
    show("#playlistForm");
    if (state.trackUrl) show("#scopeBar");
    return;
  }
  show("#loading", false);
  if (state.editIdx !== i) return; // user went back meanwhile
  state.url = url;
  state.info = info;
  // what this track gets without edits: its own tags + the playlist's album rules
  state.editBase = {
    ...info.meta,
    album: $("#plAlbum").value.trim() || info.meta.album,
    album_artist: $("#plAlbumArtist").value.trim() || info.meta.album_artist,
    track: $("#plNumber").checked ? String(e.index) : info.meta.track,
  };
  fillTrackEdit(state.edits[e.index] || {});
  $("#editLabel").textContent = `Track ${e.index} · ${$("#plAlbum").value.trim() || state.playlist.title}`;
  setEditMode(true);
  show("#trackForm");
  $("#fTitle").focus();
}

function fillTrackEdit(ed) {
  fillForm(state.info, {
    meta: { ...state.editBase, ...(ed.meta || {}) },
    square: ed.square ?? true,
    coverMode: ed.cover?.mode || "thumb",
    coverData: ed.cover?.data || null,
    coverLink: ed.cover?.link || null,
    format: state.format,
  });
}

// Autosaves on every change: keep only what differs from the original.
async function saveTrackEdit() {
  const e = state.playlist.entries[state.editIdx];
  const cur = currentMeta();
  const changed = {};
  for (const k of ["title", "artist", "album", "album_artist", "year", "genre", "track"]) {
    if ((cur[k] || "") !== (state.editBase[k] || "")) changed[k] = cur[k];
  }
  const rec = {};
  if (Object.keys(changed).length) rec.meta = changed;
  if (state.coverMode !== "thumb") rec.cover = { mode: state.coverMode, data: state.coverData, link: state.coverLink };
  if (!$("#squareCrop").checked) rec.square = false;
  if (Object.keys(rec).length) state.edits[e.index] = rec;
  else delete state.edits[e.index];
  await storeEdits();
}

async function resetTrackEdit() {
  delete state.edits[state.playlist.entries[state.editIdx].index];
  await storeEdits();
  fillTrackEdit({});
}

function exitTrackEdit() {
  state.editIdx = null;
  state.info = null; // "This track" reloads its own info next time
  state.url = null;
  setEditMode(false);
  show("#trackForm", false);
  show("#playlistForm");
  if (state.trackUrl) show("#scopeBar");
  renderPlRows();
}

// Selected entries, with their saved edits, as the helper expects them.
function playlistRequestEntries(sel) {
  return sel.map((e) => {
    const out = { index: e.index, url: e.url, title: e.title };
    const ed = state.edits[e.index];
    if (ed?.meta) out.meta = ed.meta;
    if (ed?.cover) {
      out.cover = ed.cover.mode !== "custom" ? { type: "none" }
        : ed.cover.data ? { type: "data", value: ed.cover.data } : { type: "url", value: ed.cover.link };
    }
    if (ed?.square === false) out.square = false;
    return out;
  });
}

function selectedEntries() {
  return $$("#plList input:checked").map((cb) => state.playlist.entries[Number(cb.dataset.i)]);
}

function updatePlCount() {
  const n = selectedEntries().length;
  const avail = state.playlist.entries.filter((e) => !e.unavailable).length;
  $$("#plList .pl-item").forEach((li) => li.classList.toggle("unchecked", !li.querySelector("input").checked));
  $("#plCount").textContent = `${n} of ${state.playlist.count} selected`;
  $("#plToggleAll").textContent = n === avail ? "Select none" : "Select all";
  const btn = $("#plDownloadBtn");
  btn.textContent = n ? `Download ${n}` : "Download";
  btn.disabled = n === 0;
  $("#plVlcBtn").disabled = n === 0 || !state.vlcReady;
}

async function downloadPlaylist(e, toVlc = false) {
  e.preventDefault();
  const sel = selectedEntries();
  if (!sel.length) return;
  const btn = toVlc ? $("#plVlcBtn") : $("#plDownloadBtn");
  btn.disabled = true;
  showError("");
  try {
    await bg("downloadPlaylist", {
      request: {
        entries: playlistRequestEntries(sel),
        format: state.format,
        album: $("#plAlbum").value.trim(),
        album_artist: $("#plAlbumArtist").value.trim(),
        number: $("#plNumber").checked,
        subfolder: $("#plFolder").checked,
        square_cover: true,
        pattern: state.settings.pattern,
        out_dir: state.settings.outDir,
        ...(toVlc ? { vlc_url: state.settings.vlc } : {}),
        mode: state.plMedia, quality: state.plQuality,
      },
      info: { title: $("#plAlbum").value.trim() || state.playlist.title, uploader: state.playlist.uploader },
    });
    if (!toVlc) btn.textContent = "Added ✓";
  } catch (err) {
    showError(err.message);
  }
  setTimeout(updatePlCount, 1200);
}

// ---------------------------------------------------- video, clip, speed, crop --

const fmtT = (s) => {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), sec = s - m * 60;
  return `${m}:${sec < 10 ? "0" : ""}${sec.toFixed(1)}`;
};
const parseT = (v) => {
  const p = String(v).trim().split(":").map(Number);
  if (p.some(isNaN)) return null;
  return p.reduce((a, x) => a * 60 + x, 0);
};

function mediaRequest() {
  const req = { mode: state.media, quality: state.quality };
  const c = state.clip;
  if (c) {
    const dur = state.info?.duration || 0;
    if (c.start > 0.05 || (dur && c.end < dur - 0.05)) req.clip = { start: c.start, end: c.end };
    req.exact = !c.fast;
    if (c.speed !== 1) req.speed = c.speed;
    if (c.crop && state.media === "video") req.crop = c.crop;
  }
  return req;
}

function setMedia(mode) {
  if (mode === "video" && state.info && !state.info.has_video) mode = "audio";
  state.media = mode;
  $$(".mode-seg .seg").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  $("#trackForm").classList.toggle("video", mode === "video");
  show("#qualityRow", mode === "video");
  $$("#trackActions .formats").forEach((f) => (f.hidden = mode === "video"));
  $("#fExt").textContent = "." + extFor(state.format);
  renderEditSummary();
}

function renderQualities() {
  const hs = (state.info?.heights || []).filter((h) => h >= 240);
  const label = (h) => (h >= 2160 ? "4K" : h >= 1440 ? "2K" : `${h}p`);
  const items = [["best", "Best", hs[0] ? label(hs[0]) : ""], ...hs.map((h) => [String(h), `${h}p`, h >= 1440 ? (h >= 2160 ? "4K" : "2K") : ""])];
  if (!items.some(([v]) => v === state.quality)) state.quality = "best";
  $("#qualityRow").replaceChildren(...items.map(([v, text, tag]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "q" + (v === state.quality ? " active" : "");
    b.textContent = text;
    if (tag) { const s = document.createElement("small"); s.textContent = tag; b.append(s); }
    b.title = v === "best" ? "The highest quality this video has" : v >= 1440 ? "VP9/AV1 video (YouTube has no H.264 above 1080p)" : "H.264 MP4: plays everywhere";
    b.onclick = () => { state.quality = v; renderQualities(); };
    return b;
  }));
}

function renderEditSummary() {
  const c = state.clip;
  const parts = [];
  if (c) {
    const dur = state.info?.duration || 0;
    if (c.start > 0.05 || (dur && c.end < dur - 0.05)) parts.push(`✂ ${fmtT(c.start)}–${fmtT(c.end)}`);
    if (c.speed !== 1) parts.push(`${c.speed}×`);
    if (c.crop && state.media === "video") parts.push(c.cropName);
  }
  $("#editSummaryText").textContent = parts.join(" · ");
  show("#editSummary", parts.length > 0);
  $("#clipBtn").classList.toggle("on", parts.length > 0);
}

// ---- the editor ----
const ce = { start: 0, end: 0, speed: 1, aspect: "", which: "start", box: null, timer: null, frames: {} };

async function openClipEditor() {
  if (!state.info) return;
  const dur = state.info.duration || 0;
  const c = state.clip || { start: 0, end: dur, speed: 1, crop: null, aspect: "", fast: false };
  Object.assign(ce, { start: c.start, end: c.end || dur, speed: c.speed, aspect: c.aspect || "", which: "start", box: c.crop ? { ...c.crop } : null });
  for (const id of ["#clipStart", "#clipEnd"]) { $(id).max = dur; }
  $("#clipFast").checked = !!c.fast;
  const video = state.media === "video";
  show("#cropControls", video);
  show("#clipEditor");
  document.body.classList.add("editing");
  syncClipUI();
  if (video) loadFrame();
  else { $("#clipFrame").src = coverSrc() || state.info.thumbnail || ""; show("#cropBox", false); $("#clipWhich").textContent = "Audio"; }
}

function closeClipEditor() {
  show("#clipEditor", false);
  if ($("#editor").hidden && $("#whatsNew").hidden) document.body.classList.remove("editing");
}

function syncClipUI() {
  const dur = state.info.duration || 0;
  $("#clipStart").value = ce.start; $("#clipEnd").value = ce.end;
  $("#clipStartT").value = fmtT(ce.start); $("#clipEndT").value = fmtT(ce.end);
  const len = (ce.end - ce.start) / ce.speed;
  $("#clipLen").textContent = `${fmtT(len)} long`;
  $("#clipFill").style.left = `${(ce.start / dur) * 100}%`;
  $("#clipFill").style.width = `${((ce.end - ce.start) / dur) * 100}%`;
  $$(".speed-seg .seg").forEach((b) => b.classList.toggle("active", Number(b.dataset.speed) === ce.speed));
  $$(".crop-seg .seg").forEach((b) => b.classList.toggle("active", b.dataset.crop === ce.aspect));
  placeCropBox();
}

// show the exact frame at the handle that last moved (fetched by the helper)
function loadFrame() {
  if (state.media !== "video") return;
  clearTimeout(ce.timer);
  ce.timer = setTimeout(async () => {
    const t = Math.round((ce.which === "end" ? Math.max(0, ce.end - 0.1) : ce.start) * 10) / 10;
    $("#clipWhich").textContent = `${ce.which === "end" ? "End" : "Start"} · ${fmtT(t)}`;
    if (ce.frames[t]) { $("#clipFrame").src = ce.frames[t]; return; }
    $("#clipStage").classList.add("loading");
    try {
      const r = await bg("frame", { url: state.url, t });
      ce.frames[t] = r.data;
      $("#clipFrame").src = r.data;
      show("#clipMsg", false);
    } catch (e) {
      if (!$("#clipFrame").getAttribute("src")) $("#clipFrame").src = state.info.thumbnail || "";
      $("#clipMsg").textContent = /Unknown message/.test(e.message) ? "Reload Drop once to see video frames." : "Couldn't load this frame.";
      show("#clipMsg");
    } finally {
      $("#clipStage").classList.remove("loading");
    }
  }, 280);
}

// crop box: the biggest box of the chosen shape, draggable inside the picture
function frameRect() {
  const stage = $("#clipStage").getBoundingClientRect();
  const vw = state.info.width || 16, vh = state.info.height || 9;
  const scale = Math.min(stage.width / vw, stage.height / vh);
  const w = vw * scale, h = vh * scale;
  return { left: (stage.width - w) / 2, top: (stage.height - h) / 2, w, h, vw, vh };
}

function placeCropBox() {
  const box = $("#cropBox");
  if (!ce.aspect || state.media !== "video") { box.hidden = true; ce.box = null; return; }
  const f = frameRect();
  const want = Number(ce.aspect), have = f.vw / f.vh;
  const w = want < have ? (want / have) : 1, h = want < have ? 1 : (have / want);
  if (!ce.box || Math.abs(ce.box.w - w) > 0.001 || Math.abs(ce.box.h - h) > 0.001) {
    ce.box = { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
  }
  Object.assign(box.style, {
    left: `${f.left + ce.box.x * f.w}px`, top: `${f.top + ce.box.y * f.h}px`,
    width: `${ce.box.w * f.w}px`, height: `${ce.box.h * f.h}px`,
  });
  box.hidden = false;
}

function setupClipEditor() {
  $("#clipBtn").onclick = openClipEditor;
  $("#clipClose").onclick = closeClipEditor;
  $("#clipEditor").onclick = (e) => { if (e.target.id === "clipEditor") closeClipEditor(); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#clipEditor").hidden) closeClipEditor(); });
  $$(".mode-seg .seg").forEach((b) => (b.onclick = () => setMedia(b.dataset.mode)));
  $("#editClear").onclick = () => { state.clip = null; renderEditSummary(); };

  const minLen = 0.5;
  $("#clipStart").oninput = (e) => { ce.start = Math.min(Number(e.target.value), ce.end - minLen); ce.which = "start"; syncClipUI(); loadFrame(); };
  $("#clipEnd").oninput = (e) => { ce.end = Math.max(Number(e.target.value), ce.start + minLen); ce.which = "end"; syncClipUI(); loadFrame(); };
  const typed = (which) => (e) => {
    const v = parseT(e.target.value), dur = state.info.duration || 0;
    if (v == null) return syncClipUI();
    if (which === "start") ce.start = Math.min(Math.max(0, v), ce.end - minLen);
    else ce.end = Math.max(Math.min(dur, v), ce.start + minLen);
    ce.which = which; syncClipUI(); loadFrame();
  };
  $("#clipStartT").onchange = typed("start");
  $("#clipEndT").onchange = typed("end");
  $$(".speed-seg .seg").forEach((b) => (b.onclick = () => { ce.speed = Number(b.dataset.speed); syncClipUI(); }));
  $$(".crop-seg .seg").forEach((b) => (b.onclick = () => { ce.aspect = b.dataset.crop; ce.box = null; syncClipUI(); }));

  // drag the crop box
  let drag = null;
  $("#cropBox").onpointerdown = (e) => {
    e.target.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, box: { ...ce.box } };
  };
  $("#cropBox").onpointermove = (e) => {
    if (!drag) return;
    const f = frameRect();
    ce.box.x = Math.min(1 - ce.box.w, Math.max(0, drag.box.x + (e.clientX - drag.x) / f.w));
    ce.box.y = Math.min(1 - ce.box.h, Math.max(0, drag.box.y + (e.clientY - drag.y) / f.h));
    placeCropBox();
  };
  $("#cropBox").onpointerup = () => { drag = null; };

  $("#clipReset").onclick = () => {
    Object.assign(ce, { start: 0, end: state.info.duration || 0, speed: 1, aspect: "", box: null, which: "start" });
    $("#clipFast").checked = false;
    syncClipUI(); loadFrame();
  };
  $("#clipApply").onclick = () => {
    const names = { "1": "1:1", "0.5625": "9:16", "1.7778": "16:9", "0.8": "4:5" };
    state.clip = {
      start: ce.start, end: ce.end, speed: ce.speed, fast: $("#clipFast").checked,
      aspect: ce.aspect, crop: ce.box ? { ...ce.box } : null, cropName: names[ce.aspect] || "",
    };
    closeClipEditor();
    renderEditSummary();
  };

  // playlists: audio or video, and a quality
  const plMode = (m) => {
    state.plMedia = m;
    $$(".pl-mode-seg .seg").forEach((b) => b.classList.toggle("active", b.dataset.plmode === m));
    $(".pl-quality-seg").hidden = m !== "video";
    $$("#playlistForm .actions .formats").forEach((f) => (f.hidden = m === "video"));
  };
  const plQ = (q) => { state.plQuality = q; $$(".pl-quality-seg .seg").forEach((b) => b.classList.toggle("active", b.dataset.plq === q)); };
  $$(".pl-mode-seg .seg").forEach((b) => (b.onclick = () => plMode(b.dataset.plmode)));
  $$(".pl-quality-seg .seg").forEach((b) => (b.onclick = () => plQ(b.dataset.plq)));
  plMode("audio"); plQ("best");
}

// ------------------------------------------------------------------ jobs --

const STAGE_LABEL = {
  starting: "Starting…", downloading: "Downloading", converting: "Converting…",
  tagging: "Adding tags & cover…", sending: "Sending to VLC", cancelling: "Stopping…", retrying: "Retrying…", editing: "Editing video…",
};

function cancelLink(id) {
  const c = document.createElement("button");
  c.className = "link";
  c.textContent = "Cancel";
  c.onclick = () => bg("cancel", { jobId: id }).catch(() => {});
  return c;
}

// One row for a whole playlist: overall progress, then a summary.
function playlistRow(id, j, left, right, li) {
  const s = j.summary || {};
  if (j.status === "running") {
    left.textContent = j.stage === "cancelling" ? "Stopping…"
      : j.stage === "retrying" ? `Retrying track ${j.item} of ${j.total}${j.eta ? ` in ${j.eta}s` : ""}…`
      : `${j.toVlc ? "Sending" : "Downloading"} ${j.item || 0} of ${j.total}`;
    right.append(`${Math.round(j.percent || 0)}% · `, cancelLink(id));
  } else if (j.status === "done") {
    const local = (s.saved || 0) - (s.sent || 0);
    left.textContent = (local && s.sent
      ? `Saved ${local} · sent ${s.sent} to VLC (of ${s.total})`
      : s.sent ? `Sent ${s.sent} of ${s.total} to VLC ✓` : `Saved ${local} of ${s.total}`)
      + (s.cancelled ? " · stopped" : "");
    if (s.sent && !local) left.className = "sent";
    if (j.path) {
      const a = document.createElement("button");
      a.className = "link";
      a.textContent = "Open folder";
      a.onclick = () => bg("reveal", { path: j.path }).catch((e) => showError(e.message));
      right.append(a);
    }
    if (s.skipped) {
      const err = document.createElement("div");
      err.className = "err";
      err.textContent = s.rate_limited
        ? `${s.skipped} not downloaded: YouTube is limiting your connection. Wait a few minutes, then Retry failed.`
        : `${s.skipped} skipped: ${(j.skipped || [])[0] || ""}`;
      err.title = (j.skipped || []).join("\n");
      li.append(err);
    }
    retryLink(id, j, right);
  } else {
    left.textContent = j.cancelled ? "Cancelled" : "Failed";
    retryLink(id, j, right);
  }
}

// "Retry failed (N)": start a new playlist job with only the tracks that didn't make it.
function retryLink(id, j, right) {
  const failed = (j.failed || []).filter((f) => f.url);
  if (!failed.length || !j.request) return;
  const want = new Set(failed.map((f) => f.url));
  const b = document.createElement("button");
  b.className = "link";
  b.textContent = `Retry failed (${failed.length})`;
  b.onclick = async () => {
    b.disabled = true;
    try {
      await bg("downloadPlaylist", {
        request: { ...j.request, entries: j.request.entries.filter((e) => want.has(e.url)) },
        info: { title: j.title, uploader: j.artist },
      });
      await bg("clearJob", { jobId: id });
    } catch (e) {
      showError(e.message);
      b.disabled = false;
    }
  };
  if (right.childNodes.length) right.append(" · ");
  right.append(b);
}
const hasPercent = (j) => (j.stage === "downloading" || j.stage === "sending") && j.percent != null;

function renderJobs(jobs) {
  state.jobs = jobs || {};
  const list = Object.entries(state.jobs).sort((a, b) => b[1].created - a[1].created);
  show("#jobsSection", list.length > 0);
  const ul = $("#jobs");
  ul.replaceChildren(
    ...list.map(([id, j]) => {
      const li = document.createElement("li");
      li.className = `job ${j.status}`;
      const title = document.createElement("div");
      title.className = "job-title";
      title.textContent = [j.artist, j.title].filter(Boolean).join(" — ");

      const meta = document.createElement("div");
      meta.className = "job-meta";
      const left = document.createElement("span");
      const right = document.createElement("span");
      if (j.kind === "playlist") {
        title.textContent = `▤ ${j.title}`;
        li.append(title, meta);
        meta.append(left, right);
        playlistRow(id, j, left, right, li);
        if (j.status === "running") {
          const cur = document.createElement("div");
          cur.className = "cur";
          cur.textContent = j.current || "";
          const bar = document.createElement("div");
          bar.className = "bar";
          const fill = document.createElement("i");
          fill.style.width = `${j.percent || 0}%`;
          bar.append(fill);
          li.append(cur, bar);
        }
        if (j.status === "error" && !j.cancelled && j.error) {
          const err = document.createElement("div");
          err.className = "err";
          err.textContent = j.error;
          li.append(err);
        }
        return li;
      }
      if (j.status === "done" && !j.path) {
        // sent straight to the phone, nothing kept on this PC
        left.className = "sent";
        left.textContent = `Sent to VLC ✓ · ${(j.ext || j.format).toUpperCase()}`;
        right.textContent = "not saved on PC";
      } else if (j.status === "done") {
        left.textContent = `Saved · ${(j.ext || j.format).toUpperCase()}`;
        if (j.vlc === "sent" || j.vlc === "sending") {
          const tag = document.createElement("span");
          tag.className = "sent";
          tag.textContent = j.vlc === "sent" ? " · Sent to VLC ✓" : " · Sending to VLC…";
          left.append(tag);
        }
        if (state.vlcReady && !j.vlc) {
          const v = document.createElement("button");
          v.className = "link";
          v.textContent = "→ VLC";
          v.title = "Send this file to VLC on your phone";
          v.onclick = () => bg("vlcSend", { jobId: id, path: j.path, url: state.settings.vlc }).catch(() => {});
          right.append(v, " · ");
        }
        const a = document.createElement("button");
        a.className = "link";
        a.textContent = "Show in folder";
        a.onclick = () => bg("reveal", { path: j.path }).catch((e) => showError(e.message));
        right.append(a);
      } else if (j.status === "error") {
        left.textContent = j.cancelled ? "Cancelled" : "Failed";
      } else {
        left.textContent = STAGE_LABEL[j.stage] || j.stage;
        const info = [hasPercent(j) ? `${Math.round(j.percent)}%` : "", j.stage === "downloading" ? fmtSpeed(j.speed) : ""]
          .filter(Boolean).join(" · ");
        right.append(info ? `${info} · ` : "", cancelLink(id));
      }
      meta.append(left, right);
      li.append(title, meta);

      if (j.status === "running") {
        const bar = document.createElement("div");
        bar.className = "bar";
        const fill = document.createElement("i");
        if (hasPercent(j)) fill.style.width = `${j.percent}%`;
        else bar.classList.add("indet");
        bar.append(fill);
        li.append(bar);
      }
      if ((j.error && !j.cancelled) || j.warning || j.vlcError) {
        const err = document.createElement("div");
        err.className = "err";
        err.textContent = j.error || (j.vlcError ? `Not sent to VLC: ${j.vlcError}` : j.warning);
        li.append(err);
      }
      return li;
    })
  );
}

// -------------------------------------------------------------- settings --

async function loadSettings() {
  const { settings } = await chrome.storage.sync.get("settings");
  state.settings = { ...DEFAULT_SETTINGS, ...settings };
  $("#setDir").value = state.settings.outDir;
  renderFolder();
  setDefaultFormat(state.settings.format);
  $("#setPattern").value = state.settings.pattern;
  $("#setVlc").value = state.settings.vlc;
  $("#setAutoUpd").checked = state.settings.autoUpdate !== false;
  renderBgSeg();
}

// Long paths show their tail: "…\Music\Drop" says more than "C:\Users\ma…"
function shortPath(p) {
  if (p.length <= 34) return p;
  const parts = p.split(/[\\/]/).filter(Boolean);
  let out = parts.pop();
  while (parts.length && (parts[parts.length - 1] + "\\" + out).length <= 30) out = parts.pop() + "\\" + out;
  return "…\\" + out;
}

function renderFolder() {
  const custom = $("#setDir").value;
  const shown = custom || state.defaultDir || "Music\\Drop";
  $("#folderPath").textContent = shortPath(shown);
  $("#folderBtn").title = `${custom ? "Saving to" : "Saving to the default folder"}: ${shown}. Click to change.`;
  show("#folderReset", !!custom);
}

async function pickFolder() {
  const btn = $("#folderBtn");
  btn.disabled = true;
  try {
    // Chrome closes this popup when the Windows dialog takes focus; the
    // background saves the choice, so it's there next time either way.
    const r = await bg("pickFolder", { initial: $("#setDir").value || state.defaultDir });
    if (r.path) {
      $("#setDir").value = r.path;
      state.settings.outDir = r.path;
      renderFolder();
    }
  } catch (e) {
    showError(/Unknown message/.test(e.message) ? "Reload Drop once in chrome://extensions to use the folder picker." : e.message);
  } finally {
    btn.disabled = false;
  }
}

async function resetFolder() {
  $("#setDir").value = "";
  state.settings.outDir = "";
  const { settings = {} } = await chrome.storage.sync.get("settings");
  await chrome.storage.sync.set({ settings: { ...settings, outDir: "" } });
  renderFolder();
}

// -------------------------------------------------------------- background --
// Images live in chrome.storage.local (too big for sync): wpCache = the last
// wallpaper the helper sent, bgCustom = the user's own picture.

async function applyBackground() {
  const mode = state.settings.bg || "wallpaper";
  const { wpCache, bgCustom } = await chrome.storage.local.get(["wpCache", "bgCustom"]);
  if (mode === "custom" && bgCustom) return setBackdrop(bgCustom, null);
  if (mode === "wallpaper" && wpCache) return setBackdrop(wpCache.data || null, wpCache.color || null);
  setBackdrop(null, null);
}

function setBackdrop(img, color) {
  const wp = $("#wallpaper");
  const on = !!(img || color);
  wp.style.backgroundImage = img ? `url("${img}")` : "";
  wp.style.backgroundColor = color || "";
  wp.hidden = !on;
  $(".orbs").hidden = on;
  document.body.classList.toggle("has-wall", on);
  if (img) pickInk(img);
  else document.body.classList.toggle("ink-light", !!color && luma(...hexRgb(color)) < 0.55);
}

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const luma = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

// How bright is the strip behind the top bar? The picture is drawn "cover" into a
// ~400x600 popup, so sample the matching part of the image.
async function pickInk(src) {
  try {
    const im = new Image();
    im.src = src;
    await im.decode();
    const w = im.naturalWidth, h = im.naturalHeight;
    const box = document.body.getBoundingClientRect();
    const scale = Math.max(box.width / w, box.height / h);
    const visW = box.width / scale, visH = box.height / scale;
    const sx = (w - visW) / 2, sy = (h - visH) / 2;
    const c = document.createElement("canvas");
    c.width = 64; c.height = 8;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(im, sx, sy, visW, visH * (56 / box.height), 0, 0, 64, 8);
    const d = g.getImageData(0, 0, 64, 8).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += luma(d[i], d[i + 1], d[i + 2]);
    document.body.classList.toggle("ink-light", sum / (d.length / 4) < 0.55);
  } catch {
    document.body.classList.remove("ink-light");
  }
}

// Ask the helper whether the wallpaper changed since last time (cheap when it hasn't).
async function refreshWallpaper() {
  if ((state.settings.bg || "wallpaper") !== "wallpaper") return;
  const { wpCache } = await chrome.storage.local.get("wpCache");
  try {
    const r = await bg("wallpaper", { sig: wpCache?.sig });
    if (r.same) return;
    await chrome.storage.local.set({ wpCache: r });
    if ((state.settings.bg || "wallpaper") === "wallpaper") setBackdrop(r.data || null, r.color || null);
  } catch {
    // old background script or no helper: keep whatever we have
  }
}

async function saveBgMode(mode) {
  state.settings.bg = mode;
  const { settings = {} } = await chrome.storage.sync.get("settings");
  await chrome.storage.sync.set({ settings: { ...settings, bg: mode } });
}

function renderBgSeg() {
  const mode = state.settings.bg || "wallpaper";
  $$("#setBgSeg .seg").forEach((b) => b.classList.toggle("active", b.dataset.bg === mode));
  $("#setBgHint").textContent = BG_HINTS[mode];
}

async function chooseBg(mode) {
  if (mode === "custom") {
    const { bgCustom } = await chrome.storage.local.get("bgCustom");
    // first time, or clicking Image again: pick a picture
    if (!bgCustom || state.settings.bg === "custom") return $("#bgFile").click();
  }
  await saveBgMode(mode);
  renderBgSeg();
  await applyBackground();
  if (mode === "wallpaper") refreshWallpaper();
}

async function onBgFile() {
  const f = $("#bgFile").files[0];
  $("#bgFile").value = "";
  if (!f) return;
  try {
    await chrome.storage.local.set({ bgCustom: await imageToDataUrl(f, 1400) });
    await saveBgMode("custom");
    renderBgSeg();
    await applyBackground();
  } catch (e) {
    showError(e.message);
  }
}

function setDefaultFormat(f) {
  $("#setFormat").value = f;
  $$("#setFormatSeg .seg").forEach((b) => b.classList.toggle("active", b.dataset.value === f));
  $("#setFormatHint").textContent = FORMAT_HINTS[f];
}

async function saveSettings() {
  state.settings = {
    outDir: $("#setDir").value.trim(),
    format: $("#setFormat").value,
    pattern: $("#setPattern").value.trim() || DEFAULT_SETTINGS.pattern,
    vlc: $("#setVlc").value.trim(),
    bg: state.settings.bg || "wallpaper",
    autoUpdate: $("#setAutoUpd").checked,
  };
  await chrome.storage.sync.set({ settings: state.settings });
  if (state.info && !state.filenameEdited) $("#fFilename").value = filenameFromPattern();
}

async function checkHelper() {
  const dot = $("#helperDot");
  try {
    const p = await bg("ping");
    state.defaultDir = p.default_dir;
    renderFolder();
    dot.className = "status ok";
    dot.querySelector("b").textContent = "Ready";
    dot.title = `Helper v${p.version} · yt-dlp ${p.yt_dlp}`;
    const warn = [!p.ffmpeg && "ffmpeg missing", !p.js_runtime && "Deno missing (needed for YouTube)"].filter(Boolean);
    $("#helperInfo").textContent = `Helper v${p.version} · yt-dlp ${p.yt_dlp} · saves to ${state.settings.outDir || p.default_dir}` +
      (warn.length ? ` · ⚠ ${warn.join(", ")}` : "");
    if (warn.length) showError(`⚠ ${warn.join(", ")}. Re-run install.ps1.`);
    return true;
  } catch (e) {
    dot.className = "status bad";
    dot.querySelector("b").textContent = "Offline";
    dot.title = e.message;
    $("#helperInfo").textContent = e.message;
    showError(e.message);
    return false;
  }
}

// ------------------------------------------------------------------ init --

// ----------------------------------------------------------------- updates --

function updateNote(text, { ok = false, button = false } = {}) {
  const bar = $("#updateBar");
  $("#updateText").textContent = text;
  bar.classList.toggle("ok", ok);
  show("#updateBtn", button);
  bar.hidden = false;
}

async function showUpdateState() {
  const bar = $("#updateBar");
  const { justUpdated } = await chrome.storage.local.get("justUpdated");
  if (justUpdated) { // shown once, right after Drop reloaded into a new version
    updateNote(`Updated to Drop ${justUpdated.to} ✓`, { ok: true });
    $("#updateLater").onclick = () => { bar.hidden = true; };
    await chrome.storage.local.remove("justUpdated");
    openWhatsNew(justUpdated.to);
    return;
  }
  let r;
  try { r = await bg("checkUpdate"); } catch { return; } // also starts an automatic update
  const { updating, updateWaiting, updDismissed } = await chrome.storage.local.get(["updating", "updateWaiting", "updDismissed"]);
  $("#updateLater").onclick = () => { bar.hidden = true; };
  if (updating) {
    updateNote(updating.silent
      ? `Updating to Drop ${updating.version}… the update window shows the progress; Drop restarts by itself.`
      : `Installing Drop ${updating.version}… finish the setup window; Drop restarts by itself.`);
    return;
  }
  if (updateWaiting) {
    updateNote(`Drop ${updateWaiting} will install when your downloads finish.`);
    return;
  }
  if (!r?.newer || r.latest === updDismissed) return;
  // only reached when automatic updates are switched off
  $("#updateText").textContent = `Drop ${r.latest} is available.`;
  bar.title = r.notes ? `What's new:\n${r.notes}` : "";
  show("#updateBtn");
  bar.hidden = false;
  $("#updateBtn").onclick = async () => {
    $("#updateBtn").disabled = true;
    $("#updateText").textContent = "Downloading the update…";
    try {
      await bg("installUpdate", { url: r.url, version: r.latest });
      $("#updateText").textContent = "Setup opened. Follow it; Drop restarts by itself when it's done.";
      show("#updateBtn", false);
    } catch (e) {
      $("#updateText").textContent = `Update failed: ${e.message}`;
      $("#updateBtn").disabled = false;
    }
  };
  $("#updateLater").onclick = async () => {
    bar.hidden = true;
    await chrome.storage.local.set({ updDismissed: r.latest }); // ask again for the next version
  };
}

// What changed in a version: extension/whatsnew.json ({"1.1.0": {"items": [{title, text, image}]}}),
// pictures in extension/whatsnew/. Opens by itself once after an update.
async function openWhatsNew(version) {
  let notes = {};
  try { notes = await (await fetch("whatsnew.json")).json(); } catch {}
  const versions = Object.keys(notes);
  const v = notes[version] ? version : notes[chrome.runtime.getManifest().version] ? chrome.runtime.getManifest().version : versions[0];
  if (!v) return;
  $("#wnTitle").textContent = `What's new in Drop ${v}`;
  $("#wnList").replaceChildren(...notes[v].items.map((it) => {
    const card = document.createElement("article");
    card.className = "wn-item";
    if (it.image) {
      const img = document.createElement("img");
      img.src = it.image;
      img.alt = "";
      img.onerror = () => img.remove();
      card.append(img);
    }
    const h = document.createElement("h3");
    h.textContent = it.title;
    const p = document.createElement("p");
    p.textContent = it.text;
    card.append(h, p);
    return card;
  }));
  $("#wnList").scrollTop = 0;
  show("#whatsNew");
  document.body.classList.add("editing"); // room for the dialog
}

function closeWhatsNew() {
  show("#whatsNew", false);
  if ($("#editor").hidden) document.body.classList.remove("editing");
}

async function checkUpdatesNow() {
  const b = $("#checkUpdBtn");
  b.disabled = true;
  b.textContent = "Checking…";
  try {
    const r = await bg("checkUpdate", { force: true });
    b.textContent = r.error ? "Couldn't check" : r.newer ? `Drop ${r.latest} is available` : "You're up to date";
    if (r.newer) { await chrome.storage.local.remove("updDismissed"); setTimeout(showUpdateState, 300); }
  } catch {
    b.textContent = "Couldn't check";
  }
  setTimeout(() => { b.textContent = "Check for updates"; b.disabled = false; }, 2500);
}

// ---------------------------------------------------------------- tooltips --
// Windows draws native title="" tooltips and they can't be styled, so each title
// is moved to data-tip the moment the pointer (or keyboard focus) reaches it,
// before the native one appears, and shown in our own bubble instead. Works for
// titles set later by code too: they're picked up on the next hover.

function setupTooltips() {
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.setAttribute("role", "tooltip");
  document.body.append(tip);
  let target = null;
  let timer = null;

  const tipOf = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (n.nodeType !== 1) continue;
      if (n.hasAttribute("title")) {
        const t = n.getAttribute("title");
        n.removeAttribute("title");
        if (t) n.dataset.tip = t;
        else delete n.dataset.tip;
      }
      if (n.dataset.tip) return n;
    }
    return null;
  };

  const place = () => {
    const r = target.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let top = r.top - h - 8;
    tip.classList.toggle("below", top < 4);
    if (top < 4) top = r.bottom + 8;
    const left = Math.min(Math.max(6, r.left + r.width / 2 - w / 2), innerWidth - w - 6);
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  };

  const hide = () => {
    clearTimeout(timer);
    target = null;
    tip.classList.remove("on");
  };

  const showFor = (el, delay) => {
    if (el === target) return;
    hide();
    if (!el) return;
    target = el;
    timer = setTimeout(() => {
      if (target !== el || !el.isConnected) return;
      tip.textContent = el.dataset.tip;
      place();
      tip.classList.add("on");
    }, delay);
  };

  document.addEventListener("mouseover", (e) => showFor(tipOf(e.target), 450));
  document.addEventListener("mouseout", (e) => {
    if (target && !target.contains(e.relatedTarget)) hide();
  });
  document.addEventListener("focusin", (e) => {
    if (e.target.matches(":focus-visible")) showFor(tipOf(e.target), 250);
  });
  document.addEventListener("focusout", hide);
  for (const ev of ["mousedown", "keydown", "wheel"]) document.addEventListener(ev, hide, true);
  document.addEventListener("scroll", hide, true);
}

async function init() {
  setupTooltips();
  // artist names, titles and file names aren't dictionary words: no red squiggles
  $$("input").forEach((i) => { i.spellcheck = false; i.autocomplete = "off"; });
  await loadSettings();
  applyBackground(); // cached picture right away, no flash

  // events
  $("#settingsBtn").onclick = () => { show("#settings", $("#settings").hidden); show("#main", $("#settings").hidden); };
  $("#settingsDone").onclick = async () => { await saveSettings(); show("#settings", false); show("#main"); checkVlc(); };
  $("#vlcTest").onclick = async () => {
    await saveSettings();
    const s = $("#vlcStatus");
    s.className = "small muted vlc-status";
    s.textContent = "Looking for VLC…";
    const r = await checkVlc();
    s.classList.add(r.ok ? "ok" : "bad");
    s.textContent = r.ok ? `Connected to VLC at ${r.base} ✓` : r.error;
  };
  $("#vlcBtn").onclick = (e) => download(e, true);
  $$(".scope-btn").forEach((b) => (b.onclick = () => setScope(b.dataset.scope)));
  $("#editBack").onclick = exitTrackEdit;
  $("#editDone").onclick = exitTrackEdit;
  $("#editReset").onclick = resetTrackEdit;
  $("#playlistForm").onsubmit = (e) => downloadPlaylist(e);
  $("#plVlcBtn").onclick = (e) => downloadPlaylist(e, true);
  $("#plToggleAll").onclick = () => {
    const boxes = $$("#plList input:not(:disabled)");
    const all = boxes.every((cb) => cb.checked);
    boxes.forEach((cb) => (cb.checked = !all));
    updatePlCount();
  };
  $("#folderBtn").onclick = pickFolder;
  $("#checkUpdBtn").onclick = checkUpdatesNow;
  setupClipEditor();
  $("#whatsNewBtn").onclick = () => openWhatsNew();
  $("#wnOk").onclick = closeWhatsNew;
  $("#wnClose").onclick = closeWhatsNew;
  $("#whatsNew").onclick = (e) => { if (e.target.id === "whatsNew") closeWhatsNew(); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#whatsNew").hidden) closeWhatsNew(); });
  $("#versionInfo").textContent = `Drop v${chrome.runtime.getManifest().version}`;
  $$("#setBgSeg .seg").forEach((b) => (b.onclick = () => chooseBg(b.dataset.bg)));
  $("#bgFile").onchange = onBgFile;
  $("#folderReset").onclick = resetFolder;
  $("#updateBtn").onclick = async () => {
    const b = $("#updateBtn");
    b.disabled = true;
    b.textContent = "Updating…";
    try {
      const r = await bg("update");
      $("#helperInfo").textContent = `yt-dlp ${r.yt_dlp} installed. ${r.note}`;
    } catch (e) {
      $("#helperInfo").textContent = e.message;
    }
    b.disabled = false;
    b.textContent = "Update yt-dlp";
  };

  $$(".seg[data-format]").forEach((b) => (b.onclick = () => { setFormat(b.dataset.format); saveDraft(); }));
  $$("#setFormatSeg .seg").forEach((b) => (b.onclick = () => setDefaultFormat(b.dataset.value)));
  $$(".seg[data-format]").forEach((b) => (b.title = FORMAT_HINTS[b.dataset.format]));

  // cover: click = pick a file, Ctrl+V = paste, drag & drop, × = remove, 1:1 = square crop
  const box = $("#coverBox");
  box.onclick = () => $("#coverFile").click();
  box.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#coverFile").click(); } };
  $("#coverFile").onchange = () => {
    const f = $("#coverFile").files[0];
    $("#coverFile").value = "";
    if (f) setCustomImage(f);
  };
  $("#coverRemove").onclick = (e) => { e.stopPropagation(); setCoverMode("none"); saveDraft(); };
  $("#coverRestore").onclick = (e) => { e.stopPropagation(); setCoverMode("thumb"); saveDraft(); };
  $("#squareBtn").onclick = (e) => {
    e.stopPropagation();
    $("#squareCrop").checked = !$("#squareCrop").checked;
    renderCover();
    saveDraft();
  };
  document.addEventListener("paste", onPaste);
  setupEditor();
  box.ondragover = (e) => { e.preventDefault(); box.classList.add("dragging"); };
  box.ondragleave = () => box.classList.remove("dragging");
  box.ondrop = (e) => {
    e.preventDefault();
    box.classList.remove("dragging");
    const f = [...e.dataTransfer.files].find((x) => x.type.startsWith("image/"));
    if (f) return setCustomImage(f);
    const link = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
    if (link && /^https?:\/\//.test(link.trim())) setCustomLink(link.trim());
  };

  $$("#trackForm input:not([type=file]):not([type=checkbox])").forEach((i) =>
    i.addEventListener("input", () => {
      if (i.id === "fFilename") state.filenameEdited = true;
      else if (!state.filenameEdited) $("#fFilename").value = filenameFromPattern();
      saveDraft();
    })
  );
  $("#trackForm").onsubmit = download;
  $("#urlForm").onsubmit = (e) => {
    e.preventDefault();
    const url = $("#urlInput").value.trim();
    const pl = playlistUrl(url);
    show("#scopeBar", false);
    if (isTrackUrl(url)) {
      loadTrack(url);
      if (pl) { state.plUrl = pl; show("#scopeBar"); }
    } else if (pl) {
      loadPlaylist(pl);
    } else {
      showError("That doesn't look like a YouTube or SoundCloud track or playlist link.");
    }
  };
  $("#clearJobs").onclick = () => bg("clearJobs");

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes.jobs) renderJobs(changes.jobs.newValue);
  });
  renderJobs((await chrome.storage.session.get("jobs")).jobs);

  // which URL?
  const param = new URLSearchParams(location.search).get("url");
  if (param) document.body.classList.add("window");
  let url = param;
  if (!url) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    url = tab?.url;
    state.tabId = tab?.id ?? null; // for reading a signed-in SoundCloud page (personal mixes)
    state.tabUrl = tab?.url || "";
  }

  const ok = await checkHelper();
  if (ok) checkVlc().finally(() => { vlcTimer = setTimeout(pollVlc, VLC_POLL_MS); });
  if (ok) refreshWallpaper();
  if (ok) showUpdateState();
  const pl = url && playlistUrl(url);
  if (ok && url && isTrackUrl(url)) {
    loadTrack(url);
    if (pl) {
      // this video is part of a playlist: offer both
      state.plUrl = pl;
      show("#scopeBar");
    }
  } else if (ok && pl) {
    loadPlaylist(pl);
  } else {
    show("#empty");
  }
}

init();
