param([switch]$Release)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'Build on Windows x64 with PowerShell 7.' }
$root = (Resolve-Path "$PSScriptRoot/../..").Path
Push-Location $root
try {
  $lane = Join-Path $root '.lane/windows-app'
  New-Item -ItemType Directory -Force "$lane/cargo", "$lane/target", "$root/.lane/dist" | Out-Null
  $env:CARGO_HOME = "$lane/cargo"
  $env:CARGO_TARGET_DIR = "$lane/target"
  if (-not (Test-Path node_modules)) { & bun install --frozen-lockfile; if ($LASTEXITCODE) { throw 'bun install failed' } }
  & bun scripts/build-sidecar.ts
  if ($LASTEXITCODE) { throw 'Sidecar build failed' }
  & bun run --filter=@omarchy-bot/web build
  if ($LASTEXITCODE) { throw 'Web build failed' }
  $version = (Get-Content apps/omarchy-bot/src-tauri/tauri.conf.json -Raw | ConvertFrom-Json).version
  $overlay = @{ bundle = @{ createUpdaterArtifacts = $false; shortDescription = 'Omarchy Bot Windows unsigned preview' } }
  if ($Release) {
    if ($env:APP_VERSION -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'APP_VERSION must match app-vX.Y.Z.' }
    foreach ($name in @('TAURI_SIGNING_PRIVATE_KEY','TAURI_UPDATER_PUBKEY','TAURI_UPDATER_ENDPOINT')) {
      if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing release variable $name" }
    }
    if (-not (Select-String -Path apps/omarchy-bot/src-tauri/Cargo.toml -Pattern '^tauri-plugin-updater\s*=' -Quiet)) { throw 'Ticket 11 updater integration is required before release; artifact signing alone does not install an updater.' }
    $version = $env:APP_VERSION
    $overlay.version = $version
    $overlay.bundle.createUpdaterArtifacts = $true
    $overlay.plugins = @{ updater = @{ pubkey = $env:TAURI_UPDATER_PUBKEY; endpoints = @($env:TAURI_UPDATER_ENDPOINT) } }
  }
  # Authenticode is independent of the updater signature. No certificate means preview.
  if ($env:WINDOWS_CERTIFICATE_THUMBPRINT) {
    $overlay.bundle.shortDescription = 'Omarchy Bot Windows signed build'
    $overlay.bundle.windows = @{ certificateThumbprint = $env:WINDOWS_CERTIFICATE_THUMBPRINT; digestAlgorithm = 'sha256'; timestampUrl = 'http://timestamp.digicert.com' }
  }
  $config = "$lane/build-config.json"
  $overlay | ConvertTo-Json -Depth 10 | Set-Content $config -Encoding utf8
  Push-Location apps/omarchy-bot
  try { & cargo tauri build --bundles nsis --config $config -- --locked; if ($LASTEXITCODE) { throw 'Tauri NSIS build failed' } }
  finally { Pop-Location }
  $installers = @(Get-ChildItem "$lane/target/release/bundle/nsis/*-setup.exe")
  if ($installers.Count -ne 1) { throw 'Expected exactly one NSIS installer.' }
  $signed = (Get-AuthenticodeSignature $installers[0].FullName).Status -eq 'Valid'
  if ($env:WINDOWS_CERTIFICATE_THUMBPRINT -and -not $signed) { throw 'Requested Authenticode signing did not produce a valid signature.' }
  $env:WINDOWS_AUTHENTICODE_SIGNED = $signed.ToString().ToLowerInvariant()
  $label = if ($signed) { 'signed' } else { 'unsigned-preview' }
  $artifact = "$root/.lane/dist/omarchy-bot_${version}_x64-${label}-setup.exe"
  Copy-Item $installers[0].FullName $artifact
  if ($Release) { Copy-Item "$($installers[0].FullName).sig" "$artifact.sig" }
  "$((Get-FileHash $artifact -Algorithm SHA256).Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($artifact))" | Set-Content "$artifact.sha256" -Encoding utf8
  @{ artifact = $artifact; authenticodeSigned = $signed; label = $label; version = $version } | ConvertTo-Json | Set-Content "$lane/build-result.json"
  if ($env:GITHUB_ENV) { "WINDOWS_AUTHENTICODE_SIGNED=$env:WINDOWS_AUTHENTICODE_SIGNED" | Out-File $env:GITHUB_ENV -Append -Encoding utf8 }
} finally { Pop-Location }
