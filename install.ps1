# Drop installer (Windows). Run Drop-Setup.exe, or:  powershell -ExecutionPolicy Bypass -File install.ps1
# Installs the download helper to %LOCALAPPDATA%\SnagTune (the folder keeps the app's original
# name so updates find it) and registers it with Chrome, Edge, Brave and Chromium.

$ErrorActionPreference = "Stop"
$ExtensionId = "elofpkmmcbdjkcnlhncihakikmbojnkl"   # fixed by the "key" in extension\manifest.json
$HostName    = "com.snagtune.host"
$InstallDir  = Join-Path $env:LOCALAPPDATA "SnagTune"
$Src         = Split-Path -Parent $MyInvocation.MyCommand.Path
Start-Transcript -Path (Join-Path $Src "install.log") -Force | Out-Null

function Step($t) { Write-Host "`n==> $t" -ForegroundColor Cyan }
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User") + ";" +
                "$env:LOCALAPPDATA\Microsoft\WinGet\Links"
}
function Winget-Install($id, $what) {
    if (-not (Has winget)) {
        Write-Host "   winget isn't available. Please install $what manually, then re-run this script." -ForegroundColor Yellow
        return
    }
    winget install -e --id $id --silent --accept-source-agreements --accept-package-agreements
    Refresh-Path
}

# ---- Stop a running helper so an update can replace its files -------------
Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*snagtune_host*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# ---- Python ---------------------------------------------------------------
Step "Checking Python"
$py = $null
foreach ($c in @("py -3", "python")) {
    try {
        $v = Invoke-Expression "$c -c `"import sys; print(sys.version_info >= (3, 9))`"" 2>$null
        if ($v -eq "True") { $py = $c; break }
    } catch {}
}
if (-not $py) {
    Write-Host "   Python 3.9+ not found, installing..."
    Winget-Install "Python.Python.3.12" "Python 3 (https://python.org)"
    $py = "python"
    try { $null = & python -c "import sys" 2>$null; if ($LASTEXITCODE -ne 0) { throw } }
    catch { throw "Python 3 isn't installed. Get it from https://python.org (tick 'Add python.exe to PATH'), then run Drop-Setup again." }
}
Write-Host "   Using: $py"

# ---- Helper files + venv --------------------------------------------------
Step "Installing helper to $InstallDir"
New-Item -ItemType Directory -Force $InstallDir | Out-Null
Copy-Item (Join-Path $Src "host\snagtune_host.py") $InstallDir -Force
# Keep a stable copy of the extension to "Load unpacked" from
$ExtDir = Join-Path $InstallDir "extension"
Remove-Item $ExtDir -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $Src "extension") $ExtDir -Recurse -Force

$venv = Join-Path $InstallDir "venv"
if (-not (Test-Path "$venv\Scripts\python.exe")) {
    Invoke-Expression "$py -m venv `"$venv`""
}
$vpy = "$venv\Scripts\python.exe"
& $vpy -m pip install --upgrade --quiet pip
& $vpy -m pip install --upgrade --quiet "yt-dlp[default]" mutagen pillow
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

# ---- ffmpeg + JS runtime -----------------------------------------------------
Step "Checking ffmpeg + ffprobe"
# Always use a private copy: ffmpeg builds bundled with other apps are often stripped down.
$ffDir = Join-Path $InstallDir "ffmpeg"
if (Test-Path "$ffDir\bin\ffprobe.exe") { Write-Host "   found: $ffDir\bin" }
else {
    # yt-dlp's own ffmpeg build
    Write-Host "   Downloading ffmpeg (yt-dlp build, ~100 MB)..."
    $zip = Join-Path $env:TEMP "snagtune-ffmpeg.zip"
    $ProgressPreference = "SilentlyContinue"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" -OutFile $zip
    $tmp = Join-Path $env:TEMP "snagtune-ffmpeg"
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive $zip $tmp
    Remove-Item $ffDir -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName $ffDir
    Remove-Item $zip, $tmp, "$ffDir\bin\ffplay.exe", "$ffDir\doc" -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "   installed to $ffDir\bin"
}

Step "Checking JavaScript runtime (YouTube needs one)"
if ((Has deno) -or (Has node)) { Write-Host "   found" }
else { Winget-Install "DenoLand.Deno" "Deno (https://deno.com)" }

# ---- Native messaging registration -----------------------------------------
Step "Registering with Chrome and Edge"
$bat = Join-Path $InstallDir "snagtune_host.bat"
Set-Content -Path $bat -Encoding ASCII -Value "@echo off`r`n`"%~dp0venv\Scripts\python.exe`" -u `"%~dp0snagtune_host.py`" %*"

$manifestPath = Join-Path $InstallDir "$HostName.json"
$manifest = [ordered]@{
    name            = $HostName
    description     = "Drop download helper"
    path            = $bat
    type            = "stdio"
    allowed_origins = @("chrome-extension://$ExtensionId/")
} | ConvertTo-Json
[IO.File]::WriteAllText($manifestPath, $manifest, (New-Object Text.UTF8Encoding $false))

foreach ($browser in @("Google\Chrome", "Microsoft\Edge", "Chromium", "BraveSoftware\Brave-Browser")) {
    $key = "HKCU:\Software\$browser\NativeMessagingHosts\$HostName"
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name "(default)" -Value $manifestPath
}

Step "Done!"
# Last bit only you can do: Chrome won't let any installer add an extension by itself.
try { Set-Clipboard -Value $ExtDir } catch {}
$opened = $false
foreach ($b in @(@("chrome", "chrome://extensions"), @("msedge", "edge://extensions"))) {
    try { Start-Process $b[0] $b[1] -ErrorAction Stop; $opened = $true; break } catch {}
}
$steps = @"
Drop's helper is installed.

Last step, in the extensions page$(if ($opened) { " that just opened" } else { " (chrome://extensions)" }):
  1. Turn on "Developer mode" (top right).
  2. Click "Load unpacked".
  3. Paste the folder path (already copied) and press Enter:
     $ExtDir

Already had Drop loaded? Just click its reload button instead.
Music is saved to your Music\Drop folder by default (change it in Drop's settings).
"@
Write-Host $steps -ForegroundColor Green
try {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($steps, "Drop is almost ready", "OK", "Information")
} catch {}

Stop-Transcript | Out-Null
