param([switch]$InstallOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows) { throw 'NSIS/WebView2 smoke requires a disposable Windows runner.' }
$root = (Resolve-Path "$PSScriptRoot/../../..").Path
Push-Location $root
$driver = $null
$installed = $false
$ownsCredential = $false
$daemon = $null
$target = 'agent-daemon-connection.com.omarchy.bot'
try {
  $lane = [IO.Path]::GetFullPath((Join-Path $root '.lane/windows-app'))
  $evidence = "$lane/evidence"
  New-Item -ItemType Directory -Force $evidence | Out-Null
  $build = Get-Content "$lane/build-result.json" -Raw | ConvertFrom-Json
  $installDir = Join-Path $lane 'installed'
  $schemeKeys = 'metheus', 'omarchy-bot' | ForEach-Object { "Registry::HKEY_CURRENT_USER\Software\Classes\$_" }
  foreach ($scheme in $schemeKeys) {
    if (Test-Path $scheme) { throw 'Use a disposable Windows account without an existing Metheus install.' }
  }
  $installer = Start-Process -FilePath $build.artifact -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
  if ($installer.ExitCode -ne 0) { throw "NSIS install failed: $($installer.ExitCode)" }
  $installed = $true
  $env:METHEUS_SMOKE_APP = Join-Path $installDir 'metheus.exe'
  if (-not (Test-Path $env:METHEUS_SMOKE_APP)) { throw 'Installed app executable missing.' }
  $daemon = Join-Path $installDir 'metheus-agent-daemon.exe'
  if (-not (Test-Path $daemon)) { throw 'Agent Daemon missing from NSIS installation.' }
  & $daemon --verify-recall-model "$installDir/recall-model"
  if ($LASTEXITCODE) { throw 'Bundled Recall validation failed.' }
  foreach ($scheme in $schemeKeys) {
    $command = (Get-Item "$scheme\shell\open\command").GetValue('')
    if (-not $command.Contains('metheus.exe') -or -not $command.Contains('%1') -or -not $command.Contains($installDir)) { throw 'NSIS did not register the installed URL scheme handler.' }
    if (-not (Get-Item $scheme).GetValueNames().Contains('URL Protocol')) { throw 'NSIS URL Protocol marker missing.' }
  }
  @{ installerSha256 = (Get-FileHash $build.artifact).Hash; installed = $true; schemeRegistered = $true; authenticode = (Get-AuthenticodeSignature $build.artifact).Status.ToString(); label = $build.label } | ConvertTo-Json | Set-Content "$evidence/install.json"
  if (-not $InstallOnly) {
    $credential = & pwsh -NoProfile -File "$PSScriptRoot/native.ps1" credential -CredentialTarget $target
    if ($LASTEXITCODE -or $credential -ne 'null') { throw 'Use a disposable account without an Agent Daemon credential.' }
    $ownsCredential = $true
    $env:WEBVIEW2_USER_DATA_FOLDER = "$lane/webview2-profile"
    $env:METHEUS_SMOKE_DIR = "$lane/profile/native"
    $env:LOCALAPPDATA = "$lane/profile/local"
    $env:APPDATA = "$lane/profile/roaming"
    New-Item -ItemType Directory -Force $env:LOCALAPPDATA, $env:APPDATA | Out-Null
    $env:OPENAI_BASE_URL = 'http://127.0.0.1:18443/v1'
    $env:METHEUS_DESKTOP_AGENT_PORT = '18444'
    $env:METHEUS_SMOKE_AGENT_PROFILE = "$env:METHEUS_SMOKE_DIR/agent-daemon"
    $env:METHEUS_SMOKE_AGENT_ARCHIVE = "$root/.lane/dist/metheus-agent-daemon_$($build.version)_x86_64-pc-windows-msvc.tar.gz"
    $env:METHEUS_SMOKE_EVIDENCE = $evidence
    $env:OMARCHY_AGENT_RECALL_MODEL_SOURCE = 'http://127.0.0.1:1'
    $edgeDriver = (Get-Command msedgedriver.exe -ErrorAction Stop).Source
    $driver = Start-Process -FilePath (Get-Command tauri-driver.exe -ErrorAction Stop).Source -ArgumentList @('--native-driver', $edgeDriver) -PassThru -RedirectStandardOutput "$evidence/driver.log" -RedirectStandardError "$evidence/driver-error.log"
    & bun tools/release/agent-release-smoke.ts
    if ($LASTEXITCODE) { throw 'Packaged WebView2 smoke failed.' }
  }
} finally {
  if ($driver -and -not $driver.HasExited) { Stop-Process -Id $driver.Id -Force }
  if ($ownsCredential) {
    foreach ($process in @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $daemon })) {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    & pwsh -NoProfile -File "$PSScriptRoot/native.ps1" clear-credential -CredentialTarget $target
    if ($LASTEXITCODE) { throw 'Disposable Agent Daemon credential cleanup failed.' }
  }
  if ($installed) {
    $uninstaller = "$installDir/uninstall.exe"
    if (-not (Test-Path $uninstaller)) { throw 'NSIS uninstaller missing.' }
    $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$installDir") -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) { throw 'NSIS uninstall failed.' }
    foreach ($scheme in $schemeKeys) {
      if (Test-Path $scheme) { throw 'Uninstall left the URL scheme registered.' }
    }
    @{ schemeRemoved = $true } | ConvertTo-Json | Set-Content "$evidence/uninstall.json"
  }
  Pop-Location
}
