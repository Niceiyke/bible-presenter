# Fetch the LGPL ffmpeg + ffprobe binaries used by the bundled-media-binaries
# resolver (src-tauri/src/binpaths.rs).
#
# Source: BtbN FFmpeg-Builds LGPL Windows build. LGPL is required so the
# bundled ffmpeg carries no GPL obligations (mux-only RTMP work + media
# probing — see docs/OUTPUT_MANAGER_DESIGN.md). The binaries are NOT committed
# to git; run this script once (and after each deliberate upgrade) so
# `tauri build` can bundle them.
#
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1
#
# Runtime resolution order is: {resource_dir}/bin/ffmpeg.exe -> PATH.
#
# Reproducibility: BtbN publishes rolling auto-builds under a moving `latest`
# tag. To keep release builds deterministic, pin `$ReleaseTag` to a specific
# autobuild tag (e.g. `autobuild-2026-08-17-13-29`, see
# https://github.com/BtbN/FFmpeg-Builds/releases) rather than `latest`, and the
# zip's SHA-256 is verified against the `checksums.sha256` published in the
# SAME release — a mismatch fails the fetch instead of silently bundling an
# unexpected binary.

$ErrorActionPreference = "Stop"

$BinDir = Join-Path $PSScriptRoot "..\src-tauri\binaries"
$ReleaseTag = "latest"   # Pin to a specific autobuild tag for a locked release.
$AssetName = "ffmpeg-master-latest-win64-lgpl.zip"
$BaseUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$ReleaseTag"
$Url = "$BaseUrl/$AssetName"
$ChecksumsUrl = "$BaseUrl/checksums.sha256"
$Zip = Join-Path $env:TEMP "ffmpeg-lgpl.zip"
$Checksums = Join-Path $env:TEMP "ffmpeg-checksums.sha256"
$Extract = Join-Path $env:TEMP "ffmpeg-lgpl"

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

Write-Host "Downloading LGPL ffmpeg build ($ReleaseTag, ~150 MB)..."
Invoke-WebRequest -Uri $ChecksumsUrl -OutFile $Checksums
Invoke-WebRequest -Uri $Url -OutFile $Zip

# Verify the zip against the release's published SHA-256 so a corrupted or
# unexpected download can never be bundled silently.
$expected = Get-Content $Checksums | Where-Object { $_ -match $AssetName } | ForEach-Object {
    ($_ -split '\s+')[0].Trim().ToLower()
}
if (-not $expected) {
    throw "checksums.sha256 did not list $AssetName — refusing to bundle an unverified binary."
}
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Zip).Hash.ToLower()
if ($actual -ne $expected) {
    throw "SHA-256 mismatch for $AssetName (expected $expected, got $actual) — aborting."
}
Write-Host "  SHA-256 verified: $actual"

if (Test-Path $Extract) { Remove-Item -Recurse -Force $Extract }
Expand-Archive -Path $Zip -DestinationPath $Extract -Force

# The archive contains bin/ffmpeg.exe + bin/ffprobe.exe.
foreach ($name in @("ffmpeg.exe", "ffprobe.exe")) {
    $src = Get-ChildItem -Path $Extract -Recurse -Filter $name | Select-Object -First 1
    if (-not $src) { throw "ffmpeg.exe/ffprobe.exe not found in the downloaded archive" }
    Copy-Item -LiteralPath $src.FullName -Destination (Join-Path $BinDir $name) -Force
    Write-Host "  bundled $($src.FullName)"
}

Remove-Item -Force $Zip
Remove-Item -Force $Checksums
Remove-Item -Recurse -Force $Extract

Write-Host "Done. src-tauri\binaries\ now contains ffmpeg.exe and ffprobe.exe (~$([math]::Round((Get-ChildItem $BinDir | Measure-Object Length -Sum).Sum / 1MB)) MB total)."