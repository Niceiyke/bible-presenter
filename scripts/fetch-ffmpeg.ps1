# Fetches TWO pinned artifacts from one BtbN autobuild release:
#   1. the NON-shared GPL zip -> ffmpeg.exe + ffprobe.exe into src-tauri/binaries/
#      (subprocess fallback resolved by src-tauri/src/binpaths.rs)
#   2. the SHARED GPL zip     -> src-tauri/ffmpeg-dist/ (include/ lib/ bin/,
#      the FFMPEG_DIR tree ffmpeg-sys-next links against) + av*/sw*.dll into
#      src-tauri/binaries/dll/ (bundled beside the exes by tauri.conf.json).
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
# Full shared-build development tree staged here: include/, lib/, bin/. Point
# FFMPEG_DIR at this directory so ffmpeg-sys-next links against exactly the
# DLLs this repo ships (scripts/copy-engine-binary.mjs stages $FFMPEG_DIR/bin
# into src-tauri/binaries/dll at bundle time).
$DistDir = Join-Path $PSScriptRoot "..\src-tauri\ffmpeg-dist"
# PINNED autobuild tag (NOT `latest`): a moving tag makes release builds
# non-reproducible, so the tag must be a specific BtbN autobuild. Update both
# the tag and `$ExpectedSha256` together when deliberately upgrading ffmpeg.
$ReleaseTag = "autobuild-2026-08-17-13-05"
# Committed SHA-256 of the NON-shared GPL win64 zip for the pinned tag. This is
# independent of the (moving) checksums.sha256 and makes the fetch tamper-proof
# even if the release's own checksum file were replaced.
$ExpectedSha256 = "423d30b197e52e20e0702278a30bc63e006cc383c968935874c4c13dda9eb299"
# The SHARED GPL win64 zip from the SAME pinned release provides the libav
# development tree (import libs + headers) the engine links against AND the
# av*/sw*.dll runtime libraries bundled beside the exes. Pinned to the n9.0.1
# branch build so CI matches the libav ABI (63/61/12/7/10) developers link
# against locally.
$SharedAssetPattern = 'win64-gpl-shared-9\.0\.zip$'
$ExpectedSharedSha256 = "dab4523561a1889a0247bcacad2480c97f29c6fca15ca306bbbcf741ae3adcf8"
$BaseUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$ReleaseTag"
$ChecksumsUrl = "$BaseUrl/checksums.sha256"
$Zip = Join-Path $env:TEMP "ffmpeg-gpl.zip"
$Checksums = Join-Path $env:TEMP "ffmpeg-checksums.sha256"
$Extract = Join-Path $env:TEMP "ffmpeg-gpl"
$SharedZip = Join-Path $env:TEMP "ffmpeg-gpl-shared.zip"
$SharedExtract = Join-Path $env:TEMP "ffmpeg-gpl-shared"

# Reproducibility gate: a release build must never use the moving `latest` tag.
if ($ReleaseTag -eq "latest" -or $ReleaseTag -match "latest") {
    throw "ReleaseTag must be pinned to a specific autobuild tag (e.g. autobuild-YYYY-MM-DD-HH-MM), not 'latest', for reproducible releases."
}

# Idempotency (CI caching): when both outputs from a previous run of THIS
# script version are present, skip the downloads. The cache key hashes this
# script, so a pin/hash edit invalidates it.
$haveExes = (Test-Path (Join-Path $BinDir "ffmpeg.exe")) -and (Test-Path (Join-Path $BinDir "ffprobe.exe"))
$haveDist = Test-Path (Join-Path $DistDir "lib\avcodec.lib")
$haveDlls = Test-Path (Join-Path $BinDir "dll\avcodec-*.dll")
if ($haveExes -and $haveDist -and $haveDlls) {
    Write-Host "ffmpeg artifacts already staged (exes, ffmpeg-dist dev tree, runtime DLLs) - skipping download."
    exit 0
}

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

# Large GitHub release assets occasionally drop mid-transfer (proxy/AV/TLS
# resets); retry so a flaky network cannot fail an otherwise valid build.
function Fetch-WithRetry([string]$Url, [string]$OutFile, [int]$Attempts = 3) {
    for ($i = 1; $i -le $Attempts; $i++) {
        try {
            Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
            return
        } catch {
            if ($i -eq $Attempts) { throw }
            Write-Host "  download attempt $i failed ($($_.Exception.Message)) - retrying in 5s..."
            Start-Sleep -Seconds (5 * $i)
        }
    }
}

Write-Host "Resolving ffmpeg asset for $ReleaseTag..."
Fetch-WithRetry $ChecksumsUrl $Checksums

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
Fetch-WithRetry "$BaseUrl/$AssetName" $Zip

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

# ---------------------------------------------------------------------------
# SHARED GPL build: libav development tree (FFMPEG_DIR) + runtime DLLs.
# ---------------------------------------------------------------------------
$SharedLine = Get-Content $Checksums | Where-Object { $_ -match $SharedAssetPattern } | Select-Object -First 1
if (-not $SharedLine) {
    throw "checksums.sha256 did not list a win64 gpl-shared zip matching $SharedAssetPattern - refusing to stage an unverified dev tree."
}
$SharedName = ($SharedLine -split '\s+') | Where-Object { $_ -match '\.zip$' } | Select-Object -First 1
$SharedPublished = ($SharedLine -split '\s+')[0].Trim().ToLower()
if (-not $SharedName) {
    throw "Could not determine the shared asset name from checksums.sha256."
}

Write-Host "Downloading SHARED GPL ffmpeg build ($SharedName, ~120 MB)..."
Fetch-WithRetry "$BaseUrl/$SharedName" $SharedZip

$sharedActual = (Get-FileHash -Algorithm SHA256 -LiteralPath $SharedZip).Hash.ToLower()
if ($sharedActual -ne $SharedPublished) {
    throw "SHA-256 mismatch for $SharedName vs published checksums (expected $SharedPublished, got $sharedActual) - aborting."
}
if ($sharedActual -ne $ExpectedSharedSha256) {
    throw "SHA-256 mismatch for $SharedName vs the committed pinned hash (expected $ExpectedSharedSha256, got $sharedActual) - update ExpectedSharedSha256 together with the release tag when upgrading."
}
Write-Host "  SHA-256 verified: $sharedActual"

if (Test-Path $SharedExtract) { Remove-Item -Recurse -Force $SharedExtract }
Expand-Archive -Path $SharedZip -DestinationPath $SharedExtract -Force
$SharedRoot = Get-ChildItem -Path $SharedExtract -Recurse -Filter "avcodec*.dll" | Select-Object -First 1
if (-not $SharedRoot) { throw "avcodec dll not found in the shared archive" }
$SharedBin = Split-Path $SharedRoot.FullName   # ...\bin
$DistSource = Split-Path $SharedBin           # archive root containing include/ lib/ bin/

# Stage the full development tree (include/, lib/, bin/) as FFMPEG_DIR so
# ffmpeg-sys-next links against import libs whose ABI exactly matches the
# runtime DLLs staged below.
if (Test-Path $DistDir) { Remove-Item -Recurse -Force $DistDir }
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
foreach ($sub in @("include", "lib", "bin")) {
    Copy-Item -Path (Join-Path $DistSource $sub) -Destination (Join-Path $DistDir $sub) -Recurse -Force
}
Write-Host "  staged ffmpeg dev tree -> $DistDir"

# Stage the av*/sw*.dll runtime libraries for bundling. tauri.conf.json maps
# `binaries/dll/*.dll` -> the bundle ROOT beside both exes: they are load-time
# static imports and the Windows loader searches only the exe's own folder
# before any app code runs.
New-Item -ItemType Directory -Force -Path (Join-Path $BinDir "dll") | Out-Null
Get-ChildItem -Path $SharedBin -Filter "*.dll" | Where-Object { $_.Name -match '^(av|sw)' } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $BinDir "dll" $_.Name) -Force
    Write-Host "  staged runtime $($_.Name)"
}

Remove-Item -Recurse -Force $SharedExtract

Remove-Item -Force $Zip
Remove-Item -Force $Checksums
Remove-Item -Recurse -Force $Extract
Remove-Item -Force $SharedZip

Write-Host ("Done. src-tauri\binaries\ has ffmpeg.exe + ffprobe.exe; src-tauri\binaries\dll\ has the runtime DLLs; " +
    "set FFMPEG_DIR=$DistDir to build against them.")
