# Run this script from Windows Task Scheduler while the desktop user is logged in.
$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$OutputDir = Join-Path $RepoRoot "data\output"
$LogPath = Join-Path $OutputDir "scheduled-monitor.log"

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
Set-Location $RepoRoot

"===== Monitoring cycle started: $(Get-Date -Format o) =====" | Out-File -FilePath $LogPath -Append -Encoding utf8
& npm.cmd run collect:cycle >> $LogPath 2>&1
$CycleExitCode = $LASTEXITCODE
"===== Monitoring cycle finished: $(Get-Date -Format o); exit=$CycleExitCode =====" | Out-File -FilePath $LogPath -Append -Encoding utf8

exit $CycleExitCode
