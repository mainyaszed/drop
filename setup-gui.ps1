# Drop Setup: a window that installs everything Drop needs, no console, no manual steps
# except the one Chrome insists on (Load unpacked). Packed into Drop-Setup.exe with drop.zip.
#
#   -Headless      run the steps without a window (for testing), printing the log
#   -InstallDir    where to install (default %LOCALAPPDATA%\SnagTune, the app's original folder name)
#   -NoRegister    skip the browser registry entries (testing)
#   -Snapshot png  render the window with sample progress to an image and exit (design check)
param(
    [switch]$Headless,
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "SnagTune"),
    [switch]$NoRegister,
    [string]$Snapshot
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ---- payload: drop.zip next to this script (inside the exe), else the project folder ----
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Src = $Here
$zip = Join-Path $Here "drop.zip"
if (Test-Path $zip) {
    $Src = Join-Path $env:TEMP "drop-setup-payload"
    Remove-Item $Src -Recurse -Force -ErrorAction SilentlyContinue
    Expand-Archive -LiteralPath $zip -DestinationPath $Src -Force
}

$StepNames = @(
    "Getting ready",
    "Python",
    "Python packages (yt-dlp, mutagen, Pillow)",
    "ffmpeg (audio converter)",
    "JavaScript runtime (YouTube needs one)",
    "Connecting to your browsers"
)
$sync = [hashtable]::Synchronized(@{
    States = @("pending") * $StepNames.Count   # pending | running | done | failed
    Details = @("") * $StepNames.Count
    Percent = 0; Indeterminate = $false
    Log = New-Object System.Text.StringBuilder
    Finished = $false; Failed = $false; Error = ""
    ExtDir = (Join-Path $InstallDir "extension")
})

# ---- the install steps (run in a background runspace so the window stays responsive) ----
$Worker = {
    param($sync, $Src, $InstallDir, $NoRegister)
    $ErrorActionPreference = "Stop"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    function Log($t) { [void]$sync.Log.AppendLine([string]$t) }
    function Step($i, $state, $detail) {
        $sync.States[$i] = $state
        if ($null -ne $detail) { $sync.Details[$i] = $detail }
        if ($state -eq "running") { $sync.Percent = 0; $sync.Indeterminate = $true }
    }
    function Refresh-Path {
        $env:Path = (@([Environment]::GetEnvironmentVariable("Path", "Machine"),
                       [Environment]::GetEnvironmentVariable("Path", "User"),
                       "$env:LOCALAPPDATA\Microsoft\WinGet\Links", "$InstallDir\bin") -join ";")
    }
    function Download($url, $dest, $i, $label) {
        Log "Downloading $url"
        $req = [Net.HttpWebRequest]::Create($url)
        $req.UserAgent = "DropSetup/1.0"
        $resp = $req.GetResponse()
        $total = $resp.ContentLength
        $in = $resp.GetResponseStream()
        $out = [IO.File]::Create($dest)
        $buf = New-Object byte[] 262144
        $done = 0
        $sync.Indeterminate = $total -le 0
        try {
            while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
                $out.Write($buf, 0, $n)
                $done += $n
                if ($total -gt 0) {
                    $sync.Percent = [int](100 * $done / $total)
                    $sync.Details[$i] = "{0}  {1:N1} of {2:N1} MB" -f $label, ($done / 1MB), ($total / 1MB)
                }
            }
        } finally { $out.Close(); $in.Close(); $resp.Close() }
        $sync.Indeterminate = $true
    }
    function Exec($exe, [string[]]$argv) {
        & $exe @argv 2>&1 | ForEach-Object { Log $_ }
        if ($LASTEXITCODE -ne 0) { throw "$([IO.Path]::GetFileName($exe)) failed (exit code $LASTEXITCODE). See Details." }
    }

    $i = 0
    try {
        # 0 ---- getting ready: stop a running helper, copy Drop's files ----
        Step 0 "running" "Copying Drop's files"
        Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like '*snagtune_host*' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        New-Item -ItemType Directory -Force $InstallDir | Out-Null
        Copy-Item (Join-Path $Src "host\snagtune_host.py") $InstallDir -Force
        $ext = Join-Path $InstallDir "extension"
        Remove-Item $ext -Recurse -Force -ErrorAction SilentlyContinue
        Copy-Item (Join-Path $Src "extension") $ext -Recurse -Force
        Log "Installed files to $InstallDir"
        Step 0 "done" "Installing to $InstallDir"
        Refresh-Path

        # 1 ---- Python: use yours, else a private copy just for Drop (no admin needed) ----
        $i = 1; Step 1 "running" "Looking for Python 3.9+"
        $pyExe = $null
        $private = Join-Path $InstallDir "python\python.exe"
        $candidates = @()
        if (Test-Path $private) { $candidates += , @($private) }
        $candidates += , @("py", "-3"); $candidates += , @("python")
        foreach ($c in $candidates) {
            try {
                $out = & $c[0] @($c | Select-Object -Skip 1) -c "import sys, venv; print(sys.version_info >= (3, 9)); print(sys.executable)" 2>$null
                if ($LASTEXITCODE -eq 0 -and $out[0] -eq "True") { $pyExe = $out[1]; break }
            } catch {}
        }
        if ($pyExe) {
            Step 1 "done" "Found $pyExe"
        } else {
            $ver = "3.12.10"
            $inst = Join-Path $env:TEMP "drop-python-$ver.exe"
            Download "https://www.python.org/ftp/python/$ver/python-$ver-amd64.exe" $inst 1 "Downloading Python $ver"
            Step 1 "running" "Installing Python $ver (private copy for Drop)"
            $p = Start-Process $inst -Wait -PassThru -ArgumentList @(
                "/quiet", "InstallAllUsers=0", "PrependPath=0", "Include_launcher=0", "Include_test=0",
                "Include_doc=0", "Shortcuts=0", "AssociateFiles=0", "TargetDir=`"$(Join-Path $InstallDir 'python')`"")
            Remove-Item $inst -Force -ErrorAction SilentlyContinue
            if ($p.ExitCode -ne 0 -or -not (Test-Path $private)) { throw "Python setup failed (exit code $($p.ExitCode))." }
            $pyExe = $private
            Step 1 "done" "Installed Python $ver for Drop"
        }
        Log "Python: $pyExe"

        # 2 ---- packages in Drop's own environment ----
        $i = 2; Step 2 "running" "Creating Drop's Python environment"
        $venv = Join-Path $InstallDir "venv"
        $vpy = Join-Path $venv "Scripts\python.exe"
        if (-not (Test-Path $vpy)) { Exec $pyExe @("-m", "venv", $venv) }
        $sync.Details[2] = "Installing yt-dlp, mutagen and Pillow (latest versions)"
        Exec $vpy @("-m", "pip", "install", "--upgrade", "--disable-pip-version-check", "--no-input", "yt-dlp[default]", "mutagen", "pillow")
        $ytv = (& $vpy -c "import yt_dlp; print(yt_dlp.version.__version__)" 2>$null)
        Step 2 "done" "yt-dlp $ytv, mutagen, Pillow"

        # 3 ---- ffmpeg: a private copy (builds bundled with other apps are often stripped) ----
        $i = 3; Step 3 "running" "Checking ffmpeg"
        $ff = Join-Path $InstallDir "ffmpeg"
        if (Test-Path "$ff\bin\ffprobe.exe") {
            Step 3 "done" "Already installed"
        } else {
            $fz = Join-Path $env:TEMP "drop-ffmpeg.zip"
            Download "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" $fz 3 "Downloading ffmpeg"
            Step 3 "running" "Unpacking ffmpeg"
            $tmp = Join-Path $env:TEMP "drop-ffmpeg"
            Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
            Expand-Archive -LiteralPath $fz -DestinationPath $tmp -Force
            Remove-Item $ff -Recurse -Force -ErrorAction SilentlyContinue
            Move-Item (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName $ff
            Remove-Item $fz, $tmp, "$ff\bin\ffplay.exe", "$ff\doc" -Recurse -Force -ErrorAction SilentlyContinue
            Step 3 "done" "Installed"
        }

        # 4 ---- JavaScript runtime for YouTube: Node or Deno if present, else a private Deno ----
        $i = 4; Step 4 "running" "Looking for Node or Deno"
        $js = Get-Command deno, node -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($js) {
            Step 4 "done" "Found $($js.Name) ($($js.Source))"
        } else {
            $dz = Join-Path $env:TEMP "drop-deno.zip"
            Download "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip" $dz 4 "Downloading Deno"
            New-Item -ItemType Directory -Force (Join-Path $InstallDir "bin") | Out-Null
            Expand-Archive -LiteralPath $dz -DestinationPath (Join-Path $InstallDir "bin") -Force
            Remove-Item $dz -Force -ErrorAction SilentlyContinue
            Step 4 "done" "Installed Deno for Drop"
        }

        # 5 ---- native messaging: let Chrome / Edge / Brave / Chromium talk to the helper ----
        $i = 5; Step 5 "running" "Registering"
        $bat = Join-Path $InstallDir "snagtune_host.bat"
        Set-Content -Path $bat -Encoding ASCII -Value "@echo off`r`n`"%~dp0venv\Scripts\python.exe`" -u `"%~dp0snagtune_host.py`" %*"
        $hostName = "com.snagtune.host"
        $mpath = Join-Path $InstallDir "$hostName.json"
        $manifest = [ordered]@{
            name = $hostName; description = "Drop download helper"; path = $bat; type = "stdio"
            allowed_origins = @("chrome-extension://elofpkmmcbdjkcnlhncihakikmbojnkl/")
        } | ConvertTo-Json
        [IO.File]::WriteAllText($mpath, $manifest, (New-Object Text.UTF8Encoding $false))
        if ($NoRegister) {
            Step 5 "done" "Skipped (test run)"
        } else {
            foreach ($b in @("Google\Chrome", "Microsoft\Edge", "Chromium", "BraveSoftware\Brave-Browser")) {
                $key = "HKCU:\Software\$b\NativeMessagingHosts\$hostName"
                New-Item -Path $key -Force | Out-Null
                Set-ItemProperty -Path $key -Name "(default)" -Value $mpath
            }
            Step 5 "done" "Chrome, Edge, Brave, Chromium"
        }
        $sync.Percent = 100; $sync.Indeterminate = $false
        Log "Done."
    } catch {
        Step $i "failed" $_.Exception.Message
        $sync.Failed = $true
        $sync.Error = $_.Exception.Message
        Log "ERROR: $($_.Exception.Message)"
        Log $_.ScriptStackTrace
    } finally {
        $sync.Finished = $true
    }
}

function Open-Extensions {
    try { Set-Clipboard -Value $sync.ExtDir } catch {}
    foreach ($b in @(@("chrome", "chrome://extensions"), @("msedge", "edge://extensions"))) {
        try { Start-Process $b[0] $b[1] -ErrorAction Stop; return } catch {}
    }
}

# ---- headless: just run the steps here and print the log ----
if ($Headless) {
    & $Worker $sync $Src $InstallDir $NoRegister.IsPresent
    for ($k = 0; $k -lt $StepNames.Count; $k++) { "{0,-8} {1} - {2}" -f $sync.States[$k], $StepNames[$k], $sync.Details[$k] }
    "---- log ----"; $sync.Log.ToString()
    if ($sync.Failed) { exit 1 } else { exit 0 }
}

# ---- the window ----
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase
[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Drop Setup" Width="540" SizeToContent="Height" ResizeMode="CanMinimize"
        WindowStartupLocation="CenterScreen" Background="#F8FAFC" FontFamily="Segoe UI" FontSize="13"
        Foreground="#0F172A" UseLayoutRounding="True">
  <Window.Resources>
    <Style x:Key="Btn" TargetType="Button">
      <Setter Property="Padding" Value="16,8"/>
      <Setter Property="Margin" Value="8,0,0,0"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
                    BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="8" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="b" Property="Opacity" Value="0.88"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter TargetName="b" Property="Opacity" Value="0.45"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>
  <StackPanel Margin="28,24,28,22">
    <StackPanel Orientation="Horizontal">
      <Image x:Name="Logo" Width="52" Height="52" RenderOptions.BitmapScalingMode="HighQuality"/>
      <StackPanel Margin="14,0,0,0" VerticalAlignment="Center">
        <TextBlock Text="Drop" FontSize="24" FontWeight="Bold"/>
        <TextBlock x:Name="Sub" Text="Setting up everything Drop needs. This takes a minute or two."
                   Foreground="#475569" TextWrapping="Wrap" MaxWidth="400"/>
      </StackPanel>
    </StackPanel>

    <Border Margin="0,20,0,0" Background="White" CornerRadius="12" Padding="16,10" BorderBrush="#E2E8F0" BorderThickness="1">
      <StackPanel x:Name="Steps"/>
    </Border>

    <Border Margin="0,16,0,0" Height="8" CornerRadius="4" Background="#E2E8F0" ClipToBounds="True">
      <ProgressBar x:Name="Bar" Height="8" Minimum="0" Maximum="100" BorderThickness="0"
                   Background="Transparent" Foreground="#F96C16"/>
    </Border>

    <Expander Header="Details" Margin="0,12,0,0" Foreground="#475569">
      <TextBox x:Name="LogBox" Height="120" Margin="0,6,0,0" IsReadOnly="True" FontFamily="Consolas" FontSize="11"
               VerticalScrollBarVisibility="Auto" TextWrapping="Wrap" Background="White" BorderBrush="#E2E8F0"/>
    </Expander>

    <Border x:Name="NextBox" Margin="0,14,0,0" Background="#FFF7ED" BorderBrush="#FED7AA" BorderThickness="1"
            CornerRadius="10" Padding="14,10" Visibility="Collapsed">
      <TextBlock x:Name="NextText" TextWrapping="Wrap" Foreground="#7C2D12"/>
    </Border>

    <DockPanel Margin="0,16,0,0" LastChildFill="False">
      <TextBlock x:Name="Status" DockPanel.Dock="Left" VerticalAlignment="Center" Foreground="#475569" Text="Working..."/>
      <Button x:Name="CloseBtn" DockPanel.Dock="Right" Style="{StaticResource Btn}" Content="Cancel"
              Background="White" BorderBrush="#CBD5E1" BorderThickness="1"/>
      <Button x:Name="OpenBtn" DockPanel.Dock="Right" Style="{StaticResource Btn}" Content="Open extensions page"
              Background="#F96C16" Foreground="White" BorderThickness="0" FontWeight="SemiBold" Visibility="Collapsed"/>
    </DockPanel>
  </StackPanel>
</Window>
"@
$win = [Windows.Markup.XamlReader]::Load((New-Object System.Xml.XmlNodeReader $xaml))
$el = @{}; foreach ($n in "Logo", "Sub", "Steps", "Bar", "LogBox", "NextBox", "NextText", "Status", "CloseBtn", "OpenBtn") { $el[$n] = $win.FindName($n) }

$logo = Join-Path $Src "extension\icons\128.png"
if (Test-Path $logo) {
    $bmp = New-Object Windows.Media.Imaging.BitmapImage
    $bmp.BeginInit(); $bmp.UriSource = New-Object Uri $logo; $bmp.CacheOption = "OnLoad"; $bmp.EndInit()
    $el.Logo.Source = $bmp
    $win.Icon = $bmp
}

# one row per step: status mark, name, detail line
$rows = @()
$brush = { param($hex) (New-Object Windows.Media.BrushConverter).ConvertFromString($hex) }
foreach ($name in $StepNames) {
    $g = New-Object Windows.Controls.Grid
    $g.Margin = "0,6,0,6"
    $c0 = New-Object Windows.Controls.ColumnDefinition; $c0.Width = "28"
    $c1 = New-Object Windows.Controls.ColumnDefinition
    $g.ColumnDefinitions.Add($c0); $g.ColumnDefinitions.Add($c1)
    $mark = New-Object Windows.Controls.TextBlock
    $mark.FontSize = 15; $mark.FontWeight = "Bold"; $mark.VerticalAlignment = "Top"
    $sp = New-Object Windows.Controls.StackPanel; [Windows.Controls.Grid]::SetColumn($sp, 1)
    $t = New-Object Windows.Controls.TextBlock; $t.Text = $name; $t.FontWeight = "SemiBold"
    $d = New-Object Windows.Controls.TextBlock; $d.FontSize = 12; $d.Foreground = & $brush "#64748B"; $d.TextWrapping = "Wrap"
    [void]$sp.Children.Add($t); [void]$sp.Children.Add($d)
    [void]$g.Children.Add($mark); [void]$g.Children.Add($sp)
    [void]$el.Steps.Children.Add($g)
    $rows += , @{ Mark = $mark; Title = $t; Detail = $d }
}

$look = @{
    pending = @("○", "#CBD5E1", "#94A3B8"); running = @("●", "#F96C16", "#0F172A")
    done = @("✓", "#16A34A", "#0F172A"); failed = @("✕", "#DC2626", "#DC2626")
}
function Render {
    for ($k = 0; $k -lt $rows.Count; $k++) {
        $s = $sync.States[$k]; $l = $look[$s]
        $rows[$k].Mark.Text = $l[0]; $rows[$k].Mark.Foreground = & $brush $l[1]
        $rows[$k].Title.Foreground = & $brush $l[2]
        $rows[$k].Detail.Text = $sync.Details[$k]
        $rows[$k].Detail.Visibility = if ($sync.Details[$k]) { "Visible" } else { "Collapsed" }
    }
    $el.Bar.IsIndeterminate = [bool]$sync.Indeterminate
    $el.Bar.Value = $sync.Percent
    $txt = $sync.Log.ToString()
    if ($el.LogBox.Text.Length -ne $txt.Length) { $el.LogBox.Text = $txt; $el.LogBox.ScrollToEnd() }
    $done = ($sync.States | Where-Object { $_ -eq "done" }).Count
    if (-not $sync.Finished) { $el.Status.Text = "Step $([Math]::Min($done + 1, $rows.Count)) of $($rows.Count)" }
}
function Finish {
    $el.Bar.IsIndeterminate = $false
    if ($sync.Failed) {
        $el.Status.Text = "Setup stopped"
        $el.Sub.Text = "Something went wrong. Open Details for the full log, then run Drop Setup again."
        $el.NextText.Text = $sync.Error
        $el.NextBox.Background = & $brush "#FEF2F2"; $el.NextBox.BorderBrush = & $brush "#FECACA"
        $el.NextText.Foreground = & $brush "#991B1B"
        $el.NextBox.Visibility = "Visible"
        $el.CloseBtn.Content = "Close"
    } else {
        $el.Bar.Value = 100
        $el.Status.Text = "All set"
        $el.Sub.Text = "Everything is installed."
        $el.NextText.Text = "Last step in your browser (Chrome doesn't let installers do it):`n" +
            "1.  Click Open extensions page below (the folder path is copied for you).`n" +
            "2.  Turn on Developer mode (top right).`n" +
            "3.  Click Load unpacked, paste the path and press Enter.`n`n" +
            "Already had Drop loaded? Just click its reload button instead."
        $el.NextBox.Visibility = "Visible"
        $el.OpenBtn.Visibility = "Visible"
        $el.CloseBtn.Content = "Close"
    }
}

$el.OpenBtn.Add_Click({ Open-Extensions })

# design check: sample progress, render to PNG, exit
if ($Snapshot) {
    $sync.States = @("done", "done", "done", "running", "pending", "pending")
    $sync.Details = @("Installing to $InstallDir", "Found C:\Program Files\Python314\python.exe", "yt-dlp 2026.10.21, mutagen, Pillow",
                      "Downloading ffmpeg  41.2 of 98.7 MB", "", "")
    $sync.Percent = 42; $sync.Indeterminate = $false
    [void]$sync.Log.AppendLine("Installed files to $InstallDir"); [void]$sync.Log.AppendLine("Downloading https://github.com/...")
    Render
    if ($Snapshot -like "*done*") { $sync.States = @("done") * 6; $sync.Details[3] = "Installed"; $sync.Details[4] = "Found node (C:\Program Files\nodejs\node.exe)"; $sync.Details[5] = "Chrome, Edge, Brave, Chromium"; $sync.Finished = $true; Render; Finish }
    $win.ShowActivated = $false; $win.Left = -3000
    $win.Add_ContentRendered({
        $root = $win.Content
        $rw = [int]$root.ActualWidth + 56; $rh = [int]$root.ActualHeight + 46  # + the 28/24/22 px outer margin
        $rtb = New-Object Windows.Media.Imaging.RenderTargetBitmap -ArgumentList $rw, $rh, 96, 96, ([Windows.Media.PixelFormats]::Pbgra32)
        $bg = New-Object Windows.Media.DrawingVisual
        $rect = New-Object Windows.Rect -ArgumentList 0, 0, $rw, $rh
        $dc = $bg.RenderOpen(); $dc.DrawRectangle((& $brush "#F8FAFC"), $null, $rect); $dc.Close()
        $rtb.Render($bg); $rtb.Render($root)
        $enc = New-Object Windows.Media.Imaging.PngBitmapEncoder
        $enc.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($rtb))
        $fs = [IO.File]::Create($Snapshot); $enc.Save($fs); $fs.Close()
        $win.Close()
    })
    [void]$win.ShowDialog()
    exit 0
}

# run the steps in the background; poll their progress ten times a second
$rs = [runspacefactory]::CreateRunspace(); $rs.ApartmentState = "MTA"; $rs.Open()
$ps = [powershell]::Create(); $ps.Runspace = $rs
[void]$ps.AddScript($Worker).AddArgument($sync).AddArgument($Src).AddArgument($InstallDir).AddArgument($NoRegister.IsPresent)
$handle = $ps.BeginInvoke()

$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(100)
$timer.Add_Tick({
    Render
    if ($sync.Finished) { $timer.Stop(); Finish }
})
$timer.Start()

$el.CloseBtn.Add_Click({ $win.Close() })
$win.Add_Closing({
    param($s, $e)
    if (-not $sync.Finished) {
        $r = [Windows.MessageBox]::Show("Drop Setup is still working. Stop it?", "Drop Setup", "YesNo", "Question")
        if ($r -ne "Yes") { $e.Cancel = $true; return }
        $ps.Stop()
    }
})
[void]$win.ShowDialog()
try { $ps.Dispose(); $rs.Close() } catch {}
Remove-Item (Join-Path $env:TEMP "drop-setup-payload") -Recurse -Force -ErrorAction SilentlyContinue
