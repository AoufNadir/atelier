# Daily backup of the real site to a Windows folder (e.g. Google Drive for desktop).
# Usage: .\tools\dev\Backup-Nasaq.ps1 -Destination 'G:\My Drive\raqmi-backups'
param([Parameter(Mandatory = $true)][string]$Destination, [int]$Keep = 14)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Nasaq-Common.ps1')
$log = Join-Path $NasaqLogs 'backup.log'
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
# WSL makes the backup; Windows copies it (WSL cannot see Google Drive's virtual drive)
$out = (& wsl.exe -d $NasaqDistro -- bash "$NasaqTools/backup_nasaq.sh" 2>> $log | Select-Object -Last 1)
if ($LASTEXITCODE -ne 0 -or -not $out) { throw "Backup failed: see $log" }
$src = (& wsl.exe -d $NasaqDistro -- wslpath -w $out.Trim()).Trim()
$target = Join-Path $Destination (Split-Path $src -Leaf)
Copy-Item -Path $src -Destination $target -Recurse -Force
# keep the newest $Keep sets
Get-ChildItem -Path $Destination -Directory | Sort-Object Name -Descending | Select-Object -Skip $Keep | Remove-Item -Recurse -Force
$size = '{0:N1} MB' -f ((Get-ChildItem $target -Recurse | Measure-Object Length -Sum).Sum / 1MB)
"$(Get-Date -Format s) backup: $target ($size)" | Tee-Object -Append -FilePath $log
