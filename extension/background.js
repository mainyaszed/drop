// Drop background service worker.
// Owns the native-messaging connection and the job list, so downloads keep
// going after the popup closes. Job state lives in chrome.storage.session and
// the popup just renders it.

const HOST = "com.snagtune.host";
let port = null;
let nextId = 1;
const pending = new Map(); // id -> {resolve, reject}

function connect() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener(onHostMessage);
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message || "Helper disconnected";
    port = null;
    for (const { reject } of pending.values()) reject(new Error(hostError(err)));
    pending.clear();
    failRunningJobs(hostError(err));
  });
  return port;
}

function hostError(msg) {
  if (/not found|not registered|forbidden/i.test(msg)) {
    return "The Drop helper isn't installed. Run install.ps1 (see README), then restart the browser.";
  }
  return msg;
}

function call(cmd, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = `r${nextId++}`;
    pending.set(id, { resolve, reject });
    try {
      connect().postMessage({ id, cmd, ...payload });
    } catch (e) {
      pending.delete(id);
      reject(new Error(hostError(e.message)));
    }
  });
}

// ---------------------------------------------------------------- jobs --

async function getJobs() {
  return (await chrome.storage.session.get("jobs")).jobs || {};
}

let writeChain = Promise.resolve();
function updateJob(id, patch) {
  // serialize read-modify-write so rapid progress messages don't clobber each other
  writeChain = writeChain.then(async () => {
    const jobs = await getJobs();
    if (!jobs[id] && !patch.created) return;
    jobs[id] = { ...(jobs[id] || {}), ...patch };
    await chrome.storage.session.set({ jobs });
  });
  return writeChain;
}

async function failRunningJobs(error) {
  const jobs = await getJobs();
  for (const [id, j] of Object.entries(jobs)) {
    if (j.status === "running") updateJob(id, { status: "error", error });
  }
}

function onHostMessage(msg) {
  const req = pending.get(msg.id);
  if (req) {
    pending.delete(msg.id);
    msg.type === "error" ? req.reject(new Error(msg.error)) : req.resolve(msg.result);
    return;
  }
  // async job updates
  if (msg.type === "progress") {
    const patch = { stage: msg.stage, percent: msg.percent, speed: msg.speed, eta: msg.eta };
    if (msg.warning) patch.warning = msg.warning;
    if (msg.item) Object.assign(patch, { item: msg.item, total: msg.total, current: msg.current });
    updateJob(msg.id, patch);
  } else if (msg.type === "done") {
    updateJob(msg.id, {
      status: "done", stage: "done", percent: 100, path: msg.path, audio: msg.audio, ext: msg.ext,
      vlc: msg.vlc || null, vlcError: msg.vlc_error || null,
      summary: msg.playlist || null, skipped: msg.skipped_list || null, failed: msg.failed || null,
    });
    setBadge();
  } else if (msg.type === "error") {
    updateJob(msg.id, { status: "error", error: msg.error, cancelled: !!msg.cancelled, summary: msg.playlist || null, failed: msg.failed || null });
    setBadge();
  }
}

async function startDownload(req) {
  const id = `j${Date.now()}${nextId++}`;
  await updateJob(id, {
    created: Date.now(),
    status: "running",
    stage: "starting",
    percent: 0,
    title: req.meta.title,
    artist: req.meta.artist,
    format: req.format,
  });
  setBadge();
  connect().postMessage({ id, cmd: "download", ...req });
  return id;
}

async function startPlaylist(req, info) {
  const id = `p${Date.now()}${nextId++}`;
  await updateJob(id, {
    created: Date.now(),
    kind: "playlist",
    status: "running",
    stage: "starting",
    percent: 0,
    item: 0,
    total: req.entries.length,
    title: info.title,
    artist: info.uploader,
    format: req.format,
    toVlc: !!req.vlc_url,
    request: req, // kept so "Retry failed" can re-run just the failed tracks
  });
  setBadge();
  connect().postMessage({ id, cmd: "download_playlist", ...req });
  return id;
}

// ------------------------------------------------------------- app updates --
// The helper asks GitHub for the latest release. After the user starts an
// update, watch the installed files and reload Drop once the new version is in.

const CURRENT = chrome.runtime.getManifest().version;
const SIX_HOURS = 6 * 60 * 60 * 1000;
const vt = (v) => (v || "0").split(".").map(Number);
const newer = (a, b) => { const x = vt(a), y = vt(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };

async function checkForUpdate(force = false) {
  const { upd } = await chrome.storage.local.get("upd");
  if (!force && upd && upd.current === CURRENT && Date.now() - upd.checked < SIX_HOURS) return upd;
  try {
    const r = await call("check_update", { current: CURRENT });
    const fresh = { ...r, current: CURRENT, checked: Date.now() };
    await chrome.storage.local.set({ upd: fresh });
    return fresh;
  } catch (e) {
    return upd ? { ...upd, error: e.message } : { newer: false, error: e.message };
  }
}

// Automatic updates: install in the background with no window, but never in the
// middle of a download. Off switch: Settings > "Install updates automatically".
async function autoUpdate(upd) {
  if (!upd?.newer || !upd.url) return;
  const { settings = {} } = await chrome.storage.sync.get("settings");
  if (settings.autoUpdate === false) return;
  const { updating } = await chrome.storage.local.get("updating");
  if (updating) return;
  const running = Object.values(await getJobs()).some((j) => j.status === "running");
  if (running) {
    await chrome.storage.local.set({ updateWaiting: upd.latest });
    chrome.alarms.create("update-retry", { delayInMinutes: 2 }); // try again when downloads are done
    return;
  }
  await chrome.storage.local.remove("updateWaiting");
  await startUpdate(upd.url, upd.latest, true);
}

async function startUpdate(url, version, silent) {
  await chrome.storage.local.set({ updating: { version, silent, since: Date.now() } });
  chrome.alarms.create("update-watch", { delayInMinutes: 0.5, periodInMinutes: 0.5 });
  try {
    return await call("install_update", { url, version, silent });
  } catch (e) {
    await chrome.storage.local.remove("updating");
    chrome.alarms.clear("update-watch");
    throw e;
  }
}

async function watchInstalledVersion() {
  const { updating } = await chrome.storage.local.get("updating");
  if (!updating || Date.now() - updating.since > 30 * 60 * 1000) {
    await chrome.storage.local.remove("updating");
    chrome.alarms.clear("update-watch");
    return;
  }
  try {
    const { version } = await call("installed_version");
    if (version && newer(version, CURRENT)) {
      await chrome.storage.local.remove(["updating", "upd"]);
      chrome.runtime.reload(); // load the new files
    }
  } catch {
    // setup restarts the helper while it works: try again on the next tick
  }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "update-check") checkForUpdate(true).then(autoUpdate);
  if (a.name === "update-retry") checkForUpdate().then(autoUpdate);
  if (a.name === "update-watch") watchInstalledVersion();
});
chrome.runtime.onStartup.addListener(() => chrome.alarms.create("update-check", { delayInMinutes: 1, periodInMinutes: 360 }));

async function setBadge() {
  await writeChain;
  const running = Object.values(await getJobs()).filter((j) => j.status === "running").length;
  chrome.action.setBadgeBackgroundColor({ color: "#ff4f5a" });
  chrome.action.setBadgeText({ text: running ? String(running) : "" });
}

// ---------------------------------------------------------- popup API --

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "ping":
        return call("ping");
      case "info":
        return call("info", { url: msg.url });
      case "download":
        return { jobId: await startDownload(msg.request) };
      case "reveal":
        return call("reveal", { path: msg.path });
      case "update":
        return call("update");
      case "checkUpdate": {
        const upd = await checkForUpdate(!!msg.force);
        autoUpdate(upd); // no-op when off, already updating or nothing new
        return upd;
      }
      case "installUpdate": // manual (auto-update switched off): open the setup window
        return startUpdate(msg.url, msg.version, false);
      case "scTracks":
        return call("sc_tracks", { ids: msg.ids, urls: msg.urls });
      case "wallpaper":
        return call("wallpaper", { sig: msg.sig });
      case "playlistInfo":
        return call("playlist_info", { url: msg.url });
      case "downloadPlaylist":
        return { jobId: await startPlaylist(msg.request, msg.info) };
      case "cancel":
        await updateJob(msg.jobId, { stage: "cancelling" });
        return call("cancel", { job: msg.jobId });
      case "pickFolder": {
        // The native dialog steals focus, which closes the popup, so save the
        // choice here; the popup shows it next time it opens.
        const r = await call("pick_folder", { initial: msg.initial });
        if (r.path) {
          const { settings = {} } = await chrome.storage.sync.get("settings");
          await chrome.storage.sync.set({ settings: { ...settings, outDir: r.path } });
        }
        return r;
      }
      case "vlcPing":
        return call("vlc_ping", { url: msg.url });
      case "vlcSend": {
        // re-send a finished download; show it on the job row while it goes
        await updateJob(msg.jobId, { vlc: "sending", vlcError: null });
        try {
          await call("vlc_send", { path: msg.path, url: msg.url });
          await updateJob(msg.jobId, { vlc: "sent" });
        } catch (e) {
          await updateJob(msg.jobId, { vlc: null, vlcError: e.message });
          throw e;
        }
        return {};
      }
      case "clearJob": {
        const jobs = await getJobs();
        delete jobs[msg.jobId];
        await chrome.storage.session.set({ jobs });
        return {};
      }
      case "clearJobs": {
        const jobs = await getJobs();
        for (const [id, j] of Object.entries(jobs)) if (j.status !== "running") delete jobs[id];
        await chrome.storage.session.set({ jobs });
        return {};
      }
      default:
        throw new Error(`Unknown message ${msg.type}`);
    }
  })().then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: e.message })
  );
  return true; // async response
});

// Right-click menu: MV3 can't open the toolbar popup programmatically, so open
// the same popup UI in a small window with the link passed as ?url=.
chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === "update" && d.previousVersion && d.previousVersion !== CURRENT) {
    chrome.storage.local.set({ justUpdated: { from: d.previousVersion, to: CURRENT } });
  }
  chrome.alarms.create("update-check", { delayInMinutes: 1, periodInMinutes: 360 });
  chrome.contextMenus.create({
    id: "snag-link",
    title: "Download audio with Drop",
    contexts: ["link", "page"],
    documentUrlPatterns: ["*://*.youtube.com/*", "*://youtu.be/*", "*://soundcloud.com/*", "*://*.soundcloud.com/*"],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  const url = info.linkUrl || info.pageUrl;
  chrome.windows.create({
    url: `popup.html?url=${encodeURIComponent(url)}`,
    type: "popup",
    width: 420,
    height: 720,
  });
});
