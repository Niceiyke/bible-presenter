# Fetch the LGPL ffmpeg + ffprobe binaries used by the bundled-media-binaries
# resolver (src-tauri/src/binpaths.rs).
#
# Source: BtbN FFmpeg-Builds LGPL Windows build. LGPL is required so the
# bundled ffmpeg carries no GPL obligations (mux-only RTMP work + media
# probing - see docs/OUTPUT_MANAGER_DESIGN.md). The binaries are NOT committed
# to git; run this script once (and after each deliberate upgrade) so
# `tauri build` can bundle them.
#
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1
#
# Runtime resolution order is: {resource_dir}/bin/ffmpeg.exe -> PATH.
#
# Reproducibility: BtbN publishes rolling auto-builds under a moving `latest`
# tag (whose assets are also re-uploaded later the same day). To keep release
# builds deterministic, pin `$ReleaseTag` to a specific immutable autobuild tag
# (e.g. `autobuild-2026-08-17-13-05`, see
# https://github.com/BtbN/FFmpeg-Builds/releases) rather than `latest`. The
# archive name varies per build (it embeds the ffmpeg revision), so it is
# resolved from that release's own `checksums.sha256`, and the downloaded zip
# must match BOTH that published checksum AND the committed `$ExpectedSha256`
# below - a mismatch fails the fetch instead of silently bundling an unexpected
# binary.

$ErrorActionPreference = "Stop"

$BinDir = Join-Path $PSScriptRoot "..\src-tauri\binaries"
# PINNED autobuild tag (NOT `latest`): a moving tag makes release builds
# non-reproducible, so the tag must be a specific BtbN autobuild. Update both
# the tag and `$ExpectedSha256` together when deliberately upgrading ffmpeg.
$ReleaseTag = "autobuild-2026-08-17-13-05"
# Committed SHA-256 of the NON-shared LGPL win64 zip for the pinned tag. This is
# independent of the (moving) checksums.sha256 and makes the fetch tamper-proof
# even if the release's own checksum file were replaced.
$ExpectedSha256 = "fdf4fcb4797762e8b4cc3eccdedfedad1e4a345fe9bd8f6a44a20ebf57718c7a"
$BaseUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$ReleaseTag"
$ChecksumsUrl = "$BaseUrl/checksums.sha256"
$Zip = Join-Path $env:TEMP "ffmpeg-lgpl.zip"
$Checksums = Join-Path $env:TEMP "ffmpeg-checksums.sha256"
$Extract = Join-Path $env:TEMP "ffmpeg-lgpl"

# Reproducibility gate: a release build must never use the moving `latest` tag.
if ($ReleaseTag -eq "latest" -or $ReleaseTag -match "latest") {
    throw "ReleaseTag must be pinned to a specific autobuild tag (e.g. autobuild-YYYY-MM-DD-HH-MM), not 'latest', for reproducible releases."
}

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

Write-Host "Resolving ffmpeg asset for $ReleaseTag..."
Invoke-WebRequest -Uri $ChecksumsUrl -OutFile $Checksums

# The archive name embeds the ffmpeg revision, so resolve it from the release's
# own checksums file: pick the non-shared win64 LGPL zip line.
$AssetLine = Get-Content $Checksums | Where-Object { $_ -match 'win64-lgpl\.zip$' } | Select-Object -First 1
if (-not $AssetLine) {
    throw "checksums.sha256 did not list a non-shared win64-lgpl.zip - refusing to bundle an unverified binary."
}
$AssetName = ($AssetLine -split '\s+') | Where-Object { $_ -match '\.zip$' } | Select-Object -First 1
$published = ($AssetLine -split '\s+')[0].Trim().ToLower()
if (-not $AssetName) {
    throw "Could not determine the win64-lgpl.zip asset name from checksums.sha256."
}

Write-Host "  asset: $AssetName"
Write-Host "Downloading LGPL ffmpeg build ($ReleaseTag, ~150 MB)..."
Invoke-WebRequest -Uri "$BaseUrl/$AssetName" -OutFile $Zip

$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Zip).Hash.ToLower()
if ($actual -ne $published) {
    throw "SHA-256 mismatch for $AssetName vs published checksums (expected $published, got $actual) - aborting."
}
if ($actual -ne $ExpectedSha256) {
    throw "SHA-256 mismatch for $AssetName vs the committed pinned hash (expected $ExpectedSha256, got $actual) - the pinned tag/hash are out of date; update both together."
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
