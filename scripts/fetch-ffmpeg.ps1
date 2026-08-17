# Fetch the LGPL ffmpeg + ffprobe binaries used by the bundled-media-binaries
# resolver (src-tauri/src/binpaths.rs).
#
# Source: BtbN FFmpeg-Builds "latest" LGPL Windows build. LGPL is required so
# the bundled ffmpeg carries no GPL obligations (mux-only RTMP work + media
# probing — see docs/OUTPUT_MANAGER_DESIGN.md). The binaries are NOT committed
# to git; run this script once (and after each upstream release you want) so
# `tauri build` can bundle them.
#
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1
#
# Runtime resolution order is: {resource_dir}/bin/ffmpeg.exe -> PATH.

$ErrorActionPreference = "Stop"

$BinDir = Join-Path $PSScriptRoot "..\src-tauri\binaries"
$Url = "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-lgpl.zip"
$Zip = Join-Path $env:TEMP "ffmpeg-lgpl.zip"
$Extract = Join-Path $env:TEMP "ffmpeg-lgpl"

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

Write-Host "Downloading LGPL ffmpeg build (this is ~180 MB, one time)..."
Invoke-WebRequest -Uri $Url -OutFile $Zip

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
Remove-Item -Recurse -Force $Extract

Write-Host "Done. src-tauri\binaries\ now contains ffmpeg.exe and ffprobe.exe (~$([math]::Round((Get-ChildItem $BinDir | Measure-Object Length -Sum).Sum / 1MB)) MB total)."