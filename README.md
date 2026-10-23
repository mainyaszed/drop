# Drop

<img src="extension/icons/128.png" width="72" align="right" alt="Drop logo">

Chrome / Edge extension that downloads audio from **YouTube** and **SoundCloud** in the best available quality, with your own title, artist, album, year, genre, track number and cover art written into the file.

## How it works

```
extension (JavaScript, MV3)  ──native messaging──▶  helper (Python + yt-dlp + ffmpeg + mutagen)
  popup UI, job list                                 fetches the best audio stream, converts, tags, saves
```

A browser extension on its own can't reliably grab YouTube's best audio stream, convert it or write tags, so a small local helper does the heavy lifting. The setup installs it.

## Install (Windows)

**Easiest:** download **`Drop-Setup.exe`** from the [latest release](https://github.com/mainyaszed/drop/releases/latest) and double-click it. A setup window downloads and installs everything by itself (Python if you don't have it, yt-dlp, ffmpeg, a JavaScript runtime for YouTube) and connects Drop to your browsers. When it's done, click **Open extensions page** (the folder path is copied for you), turn on *Developer mode*, click **Load unpacked** and paste. (Windows may say "Windows protected your PC" because the installer isn't signed: click *More info → Run anyway*.)

Or by hand:

1. Right-click `install.ps1` → **Run with PowerShell**, or run:
   ```
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```
   It installs Python packages into `%LOCALAPPDATA%\SnagTune`, downloads ffmpeg if needed, and registers the helper with Chrome, Edge, Brave and Chromium.
2. Open `chrome://extensions` or `edge://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick `%LOCALAPPDATA%\SnagTune\extension` (the installer copies it there so it keeps working even if you move or delete this project folder; re-run the installer after changing the extension).
3. Restart the browser once.

## Use

Open a track page and click the Drop icon (or right-click a YouTube/SoundCloud link → *Download audio with Drop*).

- **Cover:** the original artwork is grabbed automatically. Click the cover to pick another image, press **Ctrl+V** to paste an image (or an image link), or drop one onto it. Hover the cover for **×** (remove), **1:1** (crop to square, on by default, so 16:9 thumbnails become proper album art) and the **crop icon**, which opens an editor to move, zoom, rotate and flip the cover. "Use original" brings the original artwork back.
- **Formats:**
  | Format | What you get |
  |---|---|
  | **Best** (recommended) | The original stream, not re-encoded: Opus on YouTube, AAC/MP3 on SoundCloud. Highest quality. |
  | MP3 320 | Re-encoded for old players and car stereos. |
  | M4A | AAC; good for Apple Music/iTunes. Copied without re-encoding when the source is AAC. |
  | FLAC | Lossless copy of the source. Large files, and it can't add quality the source doesn't have. |
- **Background:** by default the popup uses your Windows desktop wallpaper behind the glass and follows it when you change it. ⚙ › **Background** switches to **Image** (a picture of your choice) or **Colors** (colour orbs on white). The top bar switches to light text on dark pictures.
- **Settings (⚙):** download folder (default `Music\SnagTune`), default format, file-name pattern (`{artist} - {title}`), and **Update yt-dlp**. Use the update button when YouTube stops working; that's usually all a break needs.

Downloads keep running if you close the popup. Running downloads have a **Cancel** link.

### Playlists

Open a YouTube playlist, YouTube Music album/playlist, YouTube Mix or SoundCloud set. When the video you're watching is part of a playlist, the popup shows **This track / Whole playlist**.

- Untick tracks you don't want (private/deleted videos are greyed out).
- Click **✎** on a track (or double-click it) to edit its title, artist, album, year, genre, track number and cover, with the same cover tools as single tracks. Edits save as you type, survive closing the browser, and are used by the playlist download; **Reset to original** undoes them.
- Each track gets its own title, artist and square cover; the playlist name becomes the **Album** and its position the **track number** (both editable, and *Number tracks* also prefixes file names with `01 - `).
- **Own folder** saves into a subfolder named after the album. The VLC cone sends the whole selection to your phone instead.
- **SoundCloud personal mixes** ("Your Mix", Daily Drops, Discover sets — links like `soundcloud.com/discover/sets/personalized-tracks::…`) only exist for your account, so SnagTune reads the track list from the page you have open. Open the mix in Chrome **while signed in to SoundCloud** and click SnagTune on that page; the tracks themselves download normally.
- One bad track is skipped, not fatal; the row in Downloads shows how many were saved/skipped. Mixes are capped at 50 tracks, other playlists at 500.

### Send to VLC on your phone

VLC for iPhone/Android can receive files over Wi-Fi (VLC › Network › **Sharing via Wi-Fi**). Put the address it shows (e.g. `192.168.1.20`) in ⚙ › **VLC Wi-Fi address** and press **Test**.

The orange cone button next to Download lights up only while VLC's sharing screen is reachable. It downloads the track into a temporary folder, uploads it to your phone with a progress bar, and keeps nothing on your PC (if the upload fails, the file is saved to your PC instead so nothing is lost). Finished downloads also get a **→ VLC** link to send them later. Keep the phone on the same Wi-Fi with VLC's sharing screen open; VLC stops sharing when the phone locks.

## Troubleshooting

- **Red dot / "helper isn't installed":** run `install.ps1` again, then restart the browser.
- **YouTube errors:** click ⚙ → *Update yt-dlp*, then reload the extension.
- Log file: `%LOCALAPPDATA%\SnagTune\snagtune_host.log`
- Uninstall: `uninstall.ps1`, then remove the extension.

> Only download content you have the right to. Downloading from YouTube is against its Terms of Service, so this extension can't be published on the Chrome Web Store and is meant to be loaded unpacked for personal use.

## Updates

Drop checks this repo's [releases](https://github.com/mainyaszed/drop/releases) about every 6 hours (⚙ › **Check for updates** checks right away). When a newer version is out, the popup shows **Drop x.y.z is available · Update**: click it, follow the setup window, and Drop restarts itself with the new version. Updates are only downloaded from this repo's releases.

## Making a release

1. Bump `"version"` in `extension/manifest.json`.
2. Build the installer: `powershell -ExecutionPolicy Bypass -File build-setup.ps1` → `dist\Drop-Setup.exe`.
3. Publish it: `gh release create v1.1.0 dist\Drop-Setup.exe --title "Drop 1.1.0" --notes "What changed"`.

## Project layout

| Path | What it is |
|---|---|
| `extension/` | The Chrome/Edge extension (popup, background worker, icons) |
| `host/snagtune_host.py` | The local helper (yt-dlp, ffmpeg, tagging, VLC upload, updates) |
| `setup-gui.ps1` | The setup window packed into `Drop-Setup.exe` |
| `build-setup.ps1` | Builds `dist/Drop-Setup.exe` |
| `install.ps1` / `uninstall.ps1` | Console install / removal |

## License

MIT. See [LICENSE](LICENSE).
