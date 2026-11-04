param(
  [string]$SdkDir = $env:NDI_SDK_DIR
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($SdkDir)) {
  $SdkDir = "C:\Program Files\NDI\NDI 6 SDK"
}

if (-not (Test-Path -LiteralPath $SdkDir -PathType Container)) {
  throw "NDI 6 SDK was not found at '$SdkDir'. Download it from ndi.video, accept the vendor EULA, install it, or set NDI_SDK_DIR."
}

$runtime = Get-ChildItem -LiteralPath $SdkDir -Filter "Processing.NDI.Lib.x64.dll" -File -Recurse |
  Select-Object -First 1
if ($null -eq $runtime) {
  throw "Processing.NDI.Lib.x64.dll was not found under '$SdkDir'. Verify the NDI 6 SDK installation."
}

$destination = Join-Path $PSScriptRoot "..\src-tauri\binaries\ndi"
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -LiteralPath $runtime.FullName -Destination (Join-Path $destination $runtime.Name) -Force

$item = Get-Item -LiteralPath (Join-Path $destination $runtime.Name)
Write-Host "Staged NDI runtime: $($item.FullName)"
Write-Host "Version: $($item.VersionInfo.FileVersion)"
Write-Host "Modified: $($item.LastWriteTimeUtc.ToString('u'))"
Write-Host "Build the gated integration with: cargo check --features ndi"
