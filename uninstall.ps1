# Removes the SnagTune helper and its browser registrations. Your downloaded music is not touched.
$HostName = "com.snagtune.host"
foreach ($browser in @("Google\Chrome", "Microsoft\Edge", "Chromium", "BraveSoftware\Brave-Browser")) {
    Remove-Item "HKCU:\Software\$browser\NativeMessagingHosts\$HostName" -Force -ErrorAction SilentlyContinue
}
Remove-Item (Join-Path $env:LOCALAPPDATA "SnagTune") -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "SnagTune helper removed. Remove the extension itself from chrome://extensions or edge://extensions."
