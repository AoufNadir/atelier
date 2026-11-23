# Daily backup of the real site to a Windows folder (e.g. Google Drive for desktop).
# Usage: .\tools\dev\Backup-Nasaq.ps1 -Destination 'G:\My Drive\raqmi-backups'
# When the destination drive is missing (Drive disconnected), the set waits in
# %LOCALAPPDATA%\Nasaq\pending-backups and goes to the destination on the next run that reaches it.
param([Parameter(Mandatory = $true)][string]$Destination, [int]$Keep = 14)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Nasaq-Common.ps1')
$log = Join-Path $NasaqLogs 'backup.log'
$pending = Join-Path $NasaqLogs 'pending-backups'
# WSL makes the backup; Windows copies it (WSL cannot see Google Drive's virtual drive)
$out = (& wsl.exe -d $NasaqDistro -- bash "$NasaqTools/backup_nasaq.sh" 2>> $log | Select-Object -Last 1)
if ($LASTEXITCODE -ne 0 -or -not $out) { throw "Backup failed: see $log" }
$src = (& wsl.exe -d $NasaqDistro -- wslpath -w $out.Trim()).Trim()
$name = Split-Path $src -Leaf
$reachable = $false
try { $reachable = Test-Path -LiteralPath (Split-Path -Qualifier $Destination) } catch { $reachable = $false }
if ($reachable) {
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Copy-Item -Path $src -Destination (Join-Path $Destination $name) -Recurse -Force
    # sets that waited on this computer while Drive was away
    if (Test-Path $pending) {
        Get-ChildItem $pending -Directory | ForEach-Object { Move-Item $_.FullName (Join-Path $Destination $_.Name) -Force }
    }
    Get-ChildItem -Path $Destination -Directory | Sort-Object Name -Descending | Select-Object -Skip $Keep | Remove-Item -Recurse -Force
    $where = 'drive'; $target = Join-Path $Destination $name
} else {
    New-Item -ItemType Directory -Force -Path $pending | Out-Null
    Copy-Item -Path $src -Destination (Join-Path $pending $name) -Recurse -Force
    Get-ChildItem -Path $pending -Directory | Sort-Object Name -Descending | Select-Object -Skip $Keep | Remove-Item -Recurse -Force
    $where = 'local'; $target = Join-Path $pending $name
}
& wsl.exe -d $NasaqDistro -- bash "$NasaqTools/mark_backup.sh" $where 2>> $log
$size = '{0:N1} MB' -f ((Get-ChildItem $target -Recurse | Measure-Object Length -Sum).Sum / 1MB)
$note = if ($where -eq 'local') { ' (Google Drive not reachable: kept on this computer)' } else { '' }
"$(Get-Date -Format s) backup: $target ($size)$note" | Tee-Object -Append -FilePath $log
