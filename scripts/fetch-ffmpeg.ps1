# Fetch the GPL ffmpeg + ffprobe binaries used by the bundled-media-binaries
# resolver (src-tauri/src/binpaths.rs).
#
# Source: BtbN FFmpeg-Builds Windows build. The GPL variant is REQUIRED: the
# engine's shared encoder uses `-c:v libx264` (src-tauri/src/engine/transport.rs)
# and libx264 is a GPL library that LGPL builds do not include — an LGPL ffmpeg
# has no H.264 software encoder at all and would die with "Unknown encoder
# 'libx264'". Shipping ffmpeg.exe as a SEPARATE process the engine talks to over
# stdio pipes keeps it an aggregate work (not a derivative of Wordlyte); the
# obligations are to include ffmpeg's GPL license text with distributions and
# point at the corresponding source (the BtbN release page). See
# docs/OUTPUT_MANAGER_DESIGN.md. The binaries are NOT committed to git; run
# this script once (and after each deliberate upgrade) so `tauri build` can
# bundle them.
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
# Committed SHA-256 of the NON-shared GPL win64 zip for the pinned tag. This is
# independent of the (moving) checksums.sha256 and makes the fetch tamper-proof
# even if the release's own checksum file were replaced.
$ExpectedSha256 = "423d30b197e52e20e0702278a30bc63e006cc383c968935874c4c13dda9eb299"
$BaseUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$ReleaseTag"
$ChecksumsUrl = "$BaseUrl/checksums.sha256"
$Zip = Join-Path $env:TEMP "ffmpeg-gpl.zip"
$Checksums = Join-Path $env:TEMP "ffmpeg-checksums.sha256"
$Extract = Join-Path $env:TEMP "ffmpeg-gpl"

# Reproducibility gate: a release build must never use the moving `latest` tag.
if ($ReleaseTag -eq "latest" -or $ReleaseTag -match "latest") {
    throw "ReleaseTag must be pinned to a specific autobuild tag (e.g. autobuild-YYYY-MM-DD-HH-MM), not 'latest', for reproducible releases."
}

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

Write-Host "Resolving ffmpeg asset for $ReleaseTag..."
Invoke-WebRequest -Uri $ChecksumsUrl -OutFile $Checksums

# The archive name embeds the ffmpeg revision, so resolve it from the release's
# own checksums file: pick the non-shared win64 GPL zip line.
$AssetLine = Get-Content $Checksums | Where-Object { $_ -match 'win64-gpl\.zip$' } | Select-Object -First 1
if (-not $AssetLine) {
    throw "checksums.sha256 did not list a non-shared win64-gpl.zip - refusing to bundle an unverified binary."
}
$AssetName = ($AssetLine -split '\s+') | Where-Object { $_ -match '\.zip$' } | Select-Object -First 1
$published = ($AssetLine -split '\s+')[0].Trim().ToLower()
if (-not $AssetName) {
    throw "Could not determine the win64-gpl.zip asset name from checksums.sha256."
}

Write-Host "  asset: $AssetName"
Write-Host "Downloading GPL ffmpeg build ($ReleaseTag, ~150 MB)..."
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

# Distribution obligation: ship ffmpeg's GPL license text beside the binary.
# BtbN archives do not include a license file, so the canonical GPL-2.0 text is
# committed at src-tauri/binaries/ffmpeg-COPYING.GPLv2.txt and bundled via
# tauri.conf.json's resources map; only overwrite it if the archive carries one.
$license = Get-ChildItem -Path $Extract -Recurse -Filter "COPYING.GPLv2" | Select-Object -First 1
if ($license) {
    Copy-Item -LiteralPath $license.FullName -Destination (Join-Path $BinDir "ffmpeg-COPYING.GPLv2.txt") -Force
    Write-Host "  refreshed $($license.FullName) as ffmpeg-COPYING.GPLv2.txt"
} elseif (-not (Test-Path (Join-Path $BinDir "ffmpeg-COPYING.GPLv2.txt"))) {
    throw "ffmpeg-COPYING.GPLv2.txt missing from binaries/ - restore the committed GPL license text before bundling."
} else {
    Write-Host "  keeping committed ffmpeg-COPYING.GPLv2.txt"
}

Remove-Item -Force $Zip
Remove-Item -Force $Checksums
Remove-Item -Recurse -Force $Extract

Write-Host "Done. src-tauri\binaries\ now contains ffmpeg.exe and ffprobe.exe (~$([math]::Round((Get-ChildItem $BinDir | Measure-Object Length -Sum).Sum / 1MB)) MB total)."
