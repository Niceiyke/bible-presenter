# Live progress for the paraphrase fixture builder (builds_probe_index_fixture).
#
# The fixture build prints "fixture: 12800/46337 (12.4 docs/s, ~2697s left)"
# every 100 batches to stderr, which the documented workflow redirects into
# src-tauri/fixture_err.txt. This watcher tails that file, shows the worker's
# CPU time, and exits when the index file appears or the build process ends.
#
# Usage (from anywhere):
#   powershell -ExecutionPolicy Bypass -File tools\watch-fixture-progress.ps1
#   ... -IntervalSeconds 5        # poll faster
#   ... -LogPath <other file> -IndexPath <other index>

param(
    [string]$LogPath = "src-tauri\fixture_err.txt",
    [string]$IndexPath = "src-tauri\bible_data\bible-semantic-bge-base-v1-WEB.index",
    [int]$IntervalSeconds = 15
)

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogPath = Join-Path $RepoRoot $LogPath
$IndexPath = Join-Path $RepoRoot $IndexPath
$started = Get-Date

Write-Host "Watching: $LogPath"
Write-Host "Index:    $IndexPath"
Write-Host "Interval: ${IntervalSeconds}s - Ctrl+C to stop"
Write-Host ""

while ($true) {
    $stamp = (Get-Date).ToString("HH:mm:ss")
    $build = @(Get-Process -Name "wordlyte_lib*" -ErrorAction SilentlyContinue)
    $cpuSeconds = if ($build.Count -gt 0) { [math]::Round(($build | Measure-Object -Property CPU -Sum).Sum, 1) } else { 0 }
    $progress = Get-Content $LogPath -ErrorAction SilentlyContinue |
        Select-String -Pattern "^fixture:" |
        Select-Object -Last 1
    $elapsed = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)

    if ($progress) {
        Write-Host "[$stamp] $($progress.Line.Trim())  | cpu ${cpuSeconds}s | watched ${elapsed} min"
    } elseif ($build.Count -gt 0) {
        Write-Host "[$stamp] compiling or loading model... | cpu ${cpuSeconds}s | watched ${elapsed} min"
    } else {
        Write-Host "[$stamp] no fixture build process running | watched ${elapsed} min"
    }

    if (Test-Path $IndexPath) {
        $sizeMb = [math]::Round((Get-Item $IndexPath).Length / 1MB, 1)
        Write-Host ""
        Write-Host "INDEX READY: $IndexPath ($sizeMb MB)"
        break
    }
    if ($build.Count -eq 0) {
        Write-Host ""
        Write-Host "Fixture build process has exited. Final log output:"
        Get-Content $LogPath -Tail 20 -ErrorAction SilentlyContinue
        break
    }
    Start-Sleep -Seconds $IntervalSeconds
}

Write-Host ("Done after {0:n1} minutes." -f ((Get-Date) - $started).TotalMinutes)
