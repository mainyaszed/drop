// Drop video editor: opened in its own tab from the popup's ✂ Edit.
// Plays YouTube's small video stream and the audio side by side (both straight
// from the helper's links), and saves the cut, speed and crop into the same
// per-URL draft the popup reads, so Download picks them up.

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const url = new URLSearchParams(location.search).get("url");
const video = $("#video"), audio = $("#audio");
const MIN_LEN = 0.5;
const CROP_NAMES = { "1": "1:1", "0.5625": "9:16", "1.7778": "16:9", "0.8": "4:5", "1.3333": "4:3" };

const wa = { ctx: null, gain: null, ok: false };
audio.crossOrigin = "anonymous"; // lets Web Audio boost the preview past 100%
let corsFailed = false;
audio.addEventListener("error", () => {
  // the stream refused cross-origin use: play it plainly (preview capped at 100%)
  if (corsFailed || !audio.crossOrigin) return;
  corsFailed = true;
  const src = audio.src;
  audio.removeAttribute("crossorigin");
  audio.src = src;
  $("#gainNote").textContent = "Applied to the downloaded video. The preview follows it up to 100%.";
});
function boost() {
  if (wa.ctx || corsFailed) return;
  try {
    wa.ctx = new AudioContext();
    wa.gain = wa.ctx.createGain();
    wa.ctx.createMediaElementSource(audio).connect(wa.gain);
    wa.gain.connect(wa.ctx.destination);
    wa.ok = true;
    render();
  } catch {
    wa.ok = false;
  }
}

const st = { info: null, dur: 0, start: 0, end: 0, speed: 1, aspect: "", box: null, zoom: 100, loop: true, gain: 100, previewVol: 0.8 };

async function bg(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  if (!res?.ok) throw new Error(res?.error || "No response from Drop");
  return res.result;
}

// timecode: 04:11.9 (h:mm:ss.f past an hour)
const fmt = (s, tenths = true) => {
  s = Math.max(0, s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const ss = tenths ? sec.toFixed(1).padStart(4, "0") : String(Math.floor(sec)).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${String(m).padStart(2, "0")}:${ss}`;
};
const parseT = (v) => {
  const p = String(v).trim().split(":").map(Number);
  return p.some(isNaN) ? null : p.reduce((a, x) => a * 60 + x, 0);
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function message(text, err = false) {
  $("#msg").hidden = !text;
  $("#msg").classList.toggle("err", err);
  $("#msgText").textContent = text || "";
}

// ------------------------------------------------------------------ setup --
async function init() {
  if (!url) return message("Open the editor from Drop's ✂ Edit button.", true);
  document.body.classList.add("loading");
  const key = `info:${url}`, dkey = `draft:${url}`;
  const got = await chrome.storage.session.get([key, dkey]);
  try {
    st.info = got[key] || (await bg("info", { url }));
  } catch (e) {
    return message(e.message, true);
  }
  const i = st.info;
  st.dur = i.duration || 0;
  $("#title").textContent = i.meta?.title || i.title || "Video";
  $("#channel").textContent = i.uploader || "";
  document.title = `Edit · ${i.title || "video"}`;
  // what Windows' media panel shows, and its buttons drive the editor
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: i.meta?.title || i.title || "Video", artist: i.uploader || "", album: "Drop editor",
      artwork: i.thumbnail ? [{ src: i.thumbnail, sizes: "1280x720", type: "image/jpeg" }] : [],
    });
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", () => play());
    ms.setActionHandler("pause", () => video.pause());
    ms.setActionHandler("previoustrack", () => seek(st.start));
    ms.setActionHandler("nexttrack", () => seek(Math.max(st.start, st.end - 0.1)));
    ms.setActionHandler("seekbackward", () => seek(video.currentTime - 5));
    ms.setActionHandler("seekforward", () => seek(video.currentTime + 5));
  }
  video.poster = i.thumbnail || "";
  $("#dur").textContent = `/ ${fmt(st.dur, false)}`;

  const c = got[dkey]?.clip;
  st.start = c?.start || 0;
  st.end = c?.end || st.dur;
  st.speed = c?.speed || 1;
  st.aspect = c?.aspect || "";
  st.box = c?.crop ? { ...c.crop } : null;
  st.zoom = c?.zoom || 100;
  st.gain = c?.volume != null ? Math.round(c.volume * 100) : 100;

  drawTicks();
  render();
  try {
    const r = await bg("videoPreview", { url });
    video.src = r.video;
    if (r.audio) audio.src = r.audio;
  } catch (e) {
    document.body.classList.remove("loading");
    return message(/Unknown message/.test(e.message) ? "Reload Drop once (chrome://extensions) to use the editor." : `Couldn't load the video: ${e.message}`, true);
  }
  video.addEventListener("loadeddata", () => {
    document.body.classList.remove("loading");
    message("");
    video.currentTime = st.start;
    placeCrop();
    loadStrip();
  }, { once: true });
  video.addEventListener("error", () => message("The video stream stopped working. Close this tab and press ✂ Edit again.", true));
}

// ---------------------------------------------------- play: video + audio --
const playing = () => !video.paused;
function play() {
  if (video.currentTime < st.start || video.currentTime >= st.end - 0.05) video.currentTime = st.start;
  video.play();
}
function toggle() { playing() ? video.pause() : play(); }

video.addEventListener("play", () => {
  boost();
  wa.ctx?.resume();
  document.body.classList.add("playing");
  st.lastMove = performance.now();
  st.lastT = -1;
  audio.currentTime = video.currentTime;
  audio.play().catch(() => {});
  tick();
});
video.addEventListener("pause", () => {
  document.body.classList.remove("playing");
  audio.pause();
  if (st.buffering) { st.buffering = false; message(""); }
  hold(false);
});
video.addEventListener("seeking", () => { audio.currentTime = video.currentTime; });
// While the video buffers, the sound is held silently instead of paused:
// pausing and restarting makes Windows show its media panel every time.
function hold(on) {
  if (st.hold === on) return;
  st.hold = on;
  if (!on) audio.currentTime = video.currentTime;
  render();
}
video.addEventListener("waiting", () => hold(true));
video.addEventListener("playing", () => { hold(false); if (audio.paused) audio.play().catch(() => {}); });

// the picture is the clock: if it stops moving (the video stream is still
// loading) the sound waits, and both carry on together, in sync
function tick() {
  const t = video.currentTime, now = performance.now();
  if (playing()) {
    if (t !== st.lastT) {
      st.lastT = t;
      st.lastMove = now;
      if (st.buffering) {
        st.buffering = false;
        message("");
        hold(false);
      }
    } else if (now - (st.lastMove || now) > 300 && !st.buffering) {
      st.buffering = true;
      hold(true);
      message("Buffering…");
    }
  }
  if (playing() && t >= st.end) {
    if (st.loop) video.currentTime = st.start;
    else { video.pause(); video.currentTime = st.end; }
  }
  // keep the sound on the picture: nudge it back if it drifts, at most once a second
  if (playing() && !st.buffering && !audio.paused && audio.readyState >= 3 && Math.abs(audio.currentTime - t) > 0.3
      && now - (st.lastSync || 0) > 1000) {
    st.lastSync = now;
    audio.currentTime = t;
  }
  drawPlayhead();
  if (playing()) requestAnimationFrame(tick);
}
video.addEventListener("timeupdate", drawPlayhead);

function seek(t) {
  video.currentTime = clamp(t, 0, st.dur);
  drawPlayhead();
}

// --------------------------------------------------------------- timeline --
const pct = (t) => (st.dur ? (t / st.dur) * 100 : 0);

// ruler: labelled major ticks, four minor ticks between them
function drawTicks() {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const step = steps.find((s) => st.dur / s <= 9) || 7200;
  const out = [];
  for (let t = 0, k = 0; t <= st.dur + 0.01; t += step / 5, k++) {
    const i = document.createElement("i");
    i.style.left = `${pct(t)}%`;
    if (k % 5 === 0) {
      i.className = "major";
      const b = document.createElement("b");
      b.textContent = fmt(t, false);
      i.append(b);
    }
    out.push(i);
  }
  $("#ticks").replaceChildren(...out);
}

// filmstrip on the track: small frames from the helper, loaded one after another
async function loadStrip() {
  const n = Math.max(6, Math.min(16, Math.round($("#strip").clientWidth / 110)));
  const imgs = Array.from({ length: n }, () => document.createElement("img"));
  $("#strip").replaceChildren(...imgs);
  for (let k = 0; k < n; k++) {
    try {
      const r = await bg("frame", { url, t: Math.round(((k + 0.5) * st.dur / n) * 10) / 10, w: 192 });
      imgs[k].onload = () => imgs[k].classList.add("in");
      imgs[k].src = r.data;
    } catch {
      return;
    }
  }
}

function drawPlayhead() {
  $("#ph").style.left = `${pct(video.currentTime)}%`;
  $("#cur").textContent = fmt(video.currentTime);
}

function render(save = false) {
  $("#hStart").style.left = `${pct(st.start)}%`;
  $("#hEnd").style.left = `${pct(st.end)}%`;
  $("#sel").style.left = `${pct(st.start)}%`;
  $("#sel").style.width = `${pct(st.end - st.start)}%`;
  $("#dimL").style.width = `${pct(st.start)}%`;
  $("#dimR").style.width = `${100 - pct(st.end)}%`;
  if (document.activeElement !== $("#startT")) $("#startT").value = fmt(st.start);
  if (document.activeElement !== $("#endT")) $("#endT").value = fmt(st.end);
  const len = (st.end - st.start) / st.speed;
  $("#len").textContent = fmt(st.end - st.start);
  $$("#speedSeg button").forEach((b) => b.classList.toggle("active", Number(b.dataset.speed) === st.speed));
  $$("#cropSeg button").forEach((b) => b.classList.toggle("active", b.dataset.crop === st.aspect));
  $("#zoomRow").hidden = $("#cropHint").hidden = !st.aspect;
  $("#zoom").value = st.zoom;
  $("#zoom").style.setProperty("--p", `${((st.zoom - 40) / 60) * 100}%`);
  $("#zoomVal").textContent = `${st.zoom}%`;
  video.playbackRate = audio.playbackRate = st.speed;
  // what you hear = your preview volume x the clip's volume (a page can't go above 100%)
  const on = st.hold ? 0 : 1;
  if (wa.ok) {
    audio.volume = st.previewVol * on;
    wa.gain.gain.setTargetAtTime((st.gain / 100) * on, wa.ctx.currentTime, 0.03);
  } else {
    audio.volume = clamp(st.previewVol * Math.min(1, st.gain / 100), 0, 1) * on;
  }
  $("#gain").value = st.gain;
  $("#gain").style.setProperty("--p", `${st.gain / 2}%`);
  $("#gainVal").textContent = `${st.gain}%`;
  $("#oGain").textContent = `${st.gain}%`;
  $("#volume").value = st.previewVol;
  $("#volume").style.setProperty("--p", `${st.previewVol * 100}%`);
  $("#loop").classList.toggle("on", st.loop);
  placeCrop(); // first: the output size depends on the crop box
  // output
  $("#oLen").textContent = fmt(len);
  $("#oSpeed").textContent = `${st.speed}×`;
  $("#oLen").textContent = fmt(len);
  const vw = st.info?.width, vh = st.info?.height;
  if (vw && vh) {
    const b = st.box || { w: 1, h: 1 };
    const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
    $("#oSize").textContent = `${even(vw * b.w)} × ${even(vh * b.h)}`;
  }
  placeCrop();
  if (save) scheduleSave();
}

// drag the handles, or click/drag anywhere else to move the playhead
function timeAt(e) {
  const r = $("#tl").getBoundingClientRect();
  return clamp(((e.clientX - r.left) / r.width) * st.dur, 0, st.dur);
}
let drag = null;
$("#tl").addEventListener("pointerdown", (e) => {
  const h = e.target.closest(".handle");
  drag = h ? (h.id === "hStart" ? "start" : "end") : "seek";
  if (h) { h.classList.add("drag"); video.pause(); }
  $("#tl").setPointerCapture(e.pointerId);
  move(e);
});
$("#tl").addEventListener("pointermove", (e) => drag && move(e));
$("#tl").addEventListener("pointerup", () => { $$(".handle").forEach((h) => h.classList.remove("drag")); drag = null; });
function move(e) {
  const t = timeAt(e);
  if (drag === "start") { st.start = Math.min(t, st.end - MIN_LEN); seek(st.start); render(true); }
  else if (drag === "end") { st.end = Math.max(t, st.start + MIN_LEN); seek(st.end); render(true); }
  else seek(t);
}

function setStart(t = video.currentTime) { st.start = clamp(t, 0, st.end - MIN_LEN); render(true); }
function setEnd(t = video.currentTime) { st.end = clamp(t, st.start + MIN_LEN, st.dur); render(true); }

// ------------------------------------------------------------------- crop --
// the picture's rectangle inside the stage (object-fit: contain)
function frameRect() {
  const s = $("#stage").getBoundingClientRect();
  const vw = video.videoWidth || st.info?.width || 16, vh = video.videoHeight || st.info?.height || 9;
  const k = Math.min(s.width / vw, s.height / vh);
  return { left: (s.width - vw * k) / 2, top: (s.height - vh * k) / 2, w: vw * k, h: vh * k, ratio: vw / vh };
}

function placeCrop() {
  const box = $("#cropBox");
  if (!st.aspect) { box.hidden = true; st.box = null; return; }
  const f = frameRect();
  const want = Number(st.aspect), z = st.zoom / 100;
  let w = want < f.ratio ? want / f.ratio : 1, h = want < f.ratio ? 1 : f.ratio / want;
  w *= z; h *= z;
  if (!st.box || Math.abs(st.box.w - w) > 0.001 || Math.abs(st.box.h - h) > 0.001) {
    const cx = st.box ? st.box.x + st.box.w / 2 : 0.5, cy = st.box ? st.box.y + st.box.h / 2 : 0.5;
    st.box = { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
  }
  Object.assign(box.style, {
    left: `${f.left + st.box.x * f.w}px`, top: `${f.top + st.box.y * f.h}px`,
    width: `${st.box.w * f.w}px`, height: `${st.box.h * f.h}px`,
  });
  box.hidden = false;
}

let cdrag = null;
$("#cropBox").addEventListener("pointerdown", (e) => {
  $("#cropBox").setPointerCapture(e.pointerId);
  cdrag = { x: e.clientX, y: e.clientY, box: { ...st.box } };
});
$("#cropBox").addEventListener("pointermove", (e) => {
  if (!cdrag) return;
  const f = frameRect();
  st.box.x = clamp(cdrag.box.x + (e.clientX - cdrag.x) / f.w, 0, 1 - st.box.w);
  st.box.y = clamp(cdrag.box.y + (e.clientY - cdrag.y) / f.h, 0, 1 - st.box.h);
  placeCrop();
});
$("#cropBox").addEventListener("pointerup", () => { cdrag = null; scheduleSave(); });
addEventListener("resize", placeCrop);

// ------------------------------------------------------------------- save --
// into the popup's draft for this URL: Download uses it as is
let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 250);
}
async function save() {
  const dkey = `draft:${url}`;
  const draft = (await chrome.storage.session.get(dkey))[dkey] || {};
  const changed = st.start > 0.05 || st.end < st.dur - 0.05 || st.speed !== 1 || st.aspect || st.gain !== 100;
  draft.clip = changed ? {
    start: st.start, end: st.end, speed: st.speed, aspect: st.aspect, zoom: st.zoom,
    crop: st.box ? { ...st.box } : null, cropName: CROP_NAMES[st.aspect] || "", volume: st.gain / 100,
  } : null;
  draft.media = "video";
  draft.editor = null;
  await chrome.storage.session.set({ [dkey]: draft });
  const s = $("#saved");
  s.classList.add("on");
  clearTimeout(s.t);
  s.t = setTimeout(() => s.classList.remove("on"), 1200);
}

// --------------------------------------------------------------- controls --
$("#play").onclick = toggle;
$("#back5").onclick = () => seek(video.currentTime - 5);
$("#fwd5").onclick = () => seek(video.currentTime + 5);
$("#help").onclick = (e) => {
  e.stopPropagation();
  const open = $("#keys").hidden;
  $("#keys").hidden = !open;
  $("#help").setAttribute("aria-expanded", open);
};
addEventListener("click", (e) => { if (!e.target.closest("#keys")) { $("#keys").hidden = true; $("#help").setAttribute("aria-expanded", false); } });
video.addEventListener("click", toggle);
$("#toStart").onclick = () => seek(st.start);
$("#toEnd").onclick = () => seek(Math.max(st.start, st.end - 0.1));
$("#setStart").onclick = () => setStart();
$("#setEnd").onclick = () => setEnd();
$("#loop").onclick = () => { st.loop = !st.loop; render(); };
$("#mute").onclick = () => { audio.muted = !audio.muted; $("#mute").classList.toggle("muted", audio.muted); };
$("#volume").oninput = (e) => {
  st.previewVol = Number(e.target.value);
  if (audio.muted && st.previewVol > 0) $("#mute").click();
  render();
};
$("#gain").oninput = (e) => { st.gain = Number(e.target.value); render(true); };
$$("#speedSeg button").forEach((b) => (b.onclick = () => { st.speed = Number(b.dataset.speed); render(true); }));
$$("#cropSeg button").forEach((b) => (b.onclick = () => { st.aspect = b.dataset.crop; st.box = null; st.zoom = 100; render(true); }));
$("#zoom").oninput = (e) => { st.zoom = Number(e.target.value); render(true); };
const typed = (which) => (e) => {
  const v = parseT(e.target.value);
  if (v != null) which === "start" ? setStart(v) : setEnd(v);
  e.target.blur();
  render();
};
$("#startT").onchange = typed("start");
$("#endT").onchange = typed("end");
$("#reset").onclick = () => {
  Object.assign(st, { start: 0, end: st.dur, speed: 1, aspect: "", box: null, zoom: 100, gain: 100 });
  render(true);
};
$("#done").onclick = async () => {
  await save();
  const tab = await chrome.tabs.getCurrent();
  if (tab) chrome.tabs.remove(tab.id);
  else window.close();
};

addEventListener("keydown", (e) => {
  if (e.target.matches?.("input:not([type=range])")) return;
  const k = e.key.toLowerCase();
  const nudge = (d) => { e.preventDefault(); video.pause(); seek(video.currentTime + d); };
  if (k === " ") { e.preventDefault(); toggle(); }
  else if (k === "i") setStart();
  else if (k === "o") setEnd();
  else if (k === "arrowleft") nudge(e.shiftKey ? -1 : -0.1);
  else if (k === "arrowright") nudge(e.shiftKey ? 1 : 0.1);
  else if (k === "j") nudge(-5);
  else if (k === "k") nudge(5);
  else if (k === "[") seek(st.start);
  else if (k === "]") seek(Math.max(st.start, st.end - 0.1));
  else if (k === "l") $("#loop").click();
  else if (k === "m") $("#mute").click();
});

init();
