param([switch]$InstallOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'NSIS/WebView2 smoke requires a disposable Windows runner.' }
$root = (Resolve-Path "$PSScriptRoot/../..").Path
Push-Location $root
$driver = $null
$installed = $false
try {
  $lane = [IO.Path]::GetFullPath((Join-Path $root '.lane/windows-app'))
  $evidence = "$lane/evidence"
  New-Item -ItemType Directory -Force $evidence | Out-Null
  $build = Get-Content "$lane/build-result.json" -Raw | ConvertFrom-Json
  $installDir = Join-Path $lane 'installed'
  if (Test-Path 'Registry::HKEY_CURRENT_USER\Software\Classes\omarchy-bot') { throw 'Use a disposable Windows account without an existing Omarchy Bot install.' }
  $installer = Start-Process -FilePath $build.artifact -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
  if ($installer.ExitCode -ne 0) { throw "NSIS install failed: $($installer.ExitCode)" }
  $installed = $true
  $env:OMARCHY_BOT_SMOKE_APP = Join-Path $installDir 'omarchy-bot.exe'
  if (-not (Test-Path $env:OMARCHY_BOT_SMOKE_APP)) { throw 'Installed app executable missing.' }
  if (-not (Test-Path "$installDir/omarchy-bot-sidecar.exe")) { throw 'Compiled Sidecar missing from NSIS installation.' }
  $scheme = 'Registry::HKEY_CURRENT_USER\Software\Classes\omarchy-bot'
  $command = (Get-Item "$scheme\shell\open\command").GetValue('')
  if (-not $command.Contains('omarchy-bot.exe') -or -not $command.Contains('%1') -or -not $command.Contains($installDir)) { throw 'NSIS did not register the installed URL scheme handler.' }
  if (-not (Get-Item $scheme).GetValueNames().Contains('URL Protocol')) { throw 'NSIS URL Protocol marker missing.' }
  @{ installerSha256 = (Get-FileHash $build.artifact).Hash; installed = $true; schemeRegistered = $true; authenticode = (Get-AuthenticodeSignature $build.artifact).Status.ToString(); label = $build.label } | ConvertTo-Json | Set-Content "$evidence/install.json"
  if (-not $InstallOnly) {
    foreach ($name in @('WINDOWS_SMOKE_SERVICE_ORIGIN','WINDOWS_SMOKE_HOST_SECRET','WINDOWS_SMOKE_UNTRUSTED_ORIGIN','WINDOWS_SMOKE_X11_FIXTURE')) {
      if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Full smoke requires $name; cannot silently skip WebView2." }
    }
    $env:WEBVIEW2_USER_DATA_FOLDER = "$lane/webview2-profile"
    $env:OMARCHY_BOT_SMOKE_DIR = "$lane/profile/native"
    $env:LOCALAPPDATA = "$lane/profile/local"
    $env:APPDATA = "$lane/profile/roaming"
    New-Item -ItemType Directory -Force $env:LOCALAPPDATA, $env:APPDATA | Out-Null
    $edgeDriver = (Get-Command msedgedriver.exe -ErrorAction Stop).Source
    $driver = Start-Process -FilePath (Get-Command tauri-driver.exe -ErrorAction Stop).Source -ArgumentList @('--native-driver', $edgeDriver) -PassThru -RedirectStandardOutput "$evidence/driver.log" -RedirectStandardError "$evidence/driver-error.log"
    & bun scripts/windows-app/smoke.ts
    if ($LASTEXITCODE) { throw 'Packaged WebView2 smoke failed.' }
  }
} finally {
  if ($driver -and -not $driver.HasExited) { Stop-Process -Id $driver.Id -Force }
  if ($installed) {
    $uninstaller = "$installDir/uninstall.exe"
    if (-not (Test-Path $uninstaller)) { throw 'NSIS uninstaller missing.' }
    $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$installDir") -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) { throw 'NSIS uninstall failed.' }
    if (Test-Path 'Registry::HKEY_CURRENT_USER\Software\Classes\omarchy-bot') { throw 'Uninstall left the URL scheme registered.' }
    @{ schemeRemoved = $true } | ConvertTo-Json | Set-Content "$evidence/uninstall.json"
  }
  Pop-Location
}
