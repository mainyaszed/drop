# Builds dist\Drop-Setup.exe: setup-gui.ps1 + drop.zip (extension, helper, scripts) packed with
# IExpress (built into Windows). Run:  powershell -ExecutionPolicy Bypass -File build-setup.ps1
#
# Releasing a new version:
#   1. Bump "version" in extension\manifest.json (e.g. 1.0.0 -> 1.1.0).
#   2. Run this script.
#   3. Publish a GitHub release tagged v1.1.0 with dist\Drop-Setup.exe attached, e.g.
#        gh release create v1.1.0 dist\Drop-Setup.exe --title "Drop 1.1.0" --notes "What changed"
#      Everyone's Drop sees it within ~6 hours (or via Settings > Check for updates).

param([string]$Out)  # default: dist\Drop-Setup.exe
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$version = (Get-Content (Join-Path $root "extension\manifest.json") -Raw | ConvertFrom-Json).version
$stage = Join-Path $env:TEMP "drop-build"
$dist = Join-Path $root "dist"
$out = if ($Out) { [IO.Path]::GetFullPath($Out) } else { Join-Path $dist "Drop-Setup.exe" }

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $stage "pkg\host"), (Split-Path -Parent $out) | Out-Null
Copy-Item (Join-Path $root "extension") (Join-Path $stage "pkg") -Recurse
Copy-Item (Join-Path $root "host\snagtune_host.py") (Join-Path $stage "pkg\host")
foreach ($f in "install.ps1", "uninstall.ps1", "README.md", "LICENSE") { Copy-Item (Join-Path $root $f) (Join-Path $stage "pkg") }
Compress-Archive -Path (Join-Path $stage "pkg\*") -DestinationPath (Join-Path $stage "drop.zip") -Force
Copy-Item (Join-Path $root "setup-gui.ps1") $stage

$sed = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=$out
FriendlyName=Drop Setup
AppLaunched=powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File setup-gui.ps1
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
FILE0="setup-gui.ps1"
FILE1="drop.zip"
[SourceFiles]
SourceFiles0=$stage\
[SourceFiles0]
%FILE0%=
%FILE1%=
"@
$sedPath = Join-Path $stage "drop.sed"
[IO.File]::WriteAllText($sedPath, ($sed -replace "`r?`n", "`r`n"), [Text.Encoding]::ASCII)

if (Test-Path $out) { Remove-Item $out -Force }  # fails loudly if the old exe is locked
$started = Get-Date
Push-Location $stage
try { & "$env:WINDIR\System32\iexpress.exe" /N /Q $sedPath | Out-Null; $code = $LASTEXITCODE } finally { Pop-Location }
if (-not (Test-Path $out) -or (Get-Item $out).LastWriteTime -lt $started.AddSeconds(-2)) {
    throw "IExpress didn't produce a new $out (exit code $code)."
}
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Built $out (Drop $version, $([Math]::Round((Get-Item $out).Length / 1KB)) KB)" -ForegroundColor Green
