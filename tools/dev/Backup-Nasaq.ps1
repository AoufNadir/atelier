# Daily backup of the real site to a Windows folder (e.g. Google Drive for desktop).
# Usage: .\tools\dev\Backup-Nasaq.ps1 -Destination 'G:\My Drive\raqmi-backups'
param([Parameter(Mandatory = $true)][string]$Destination)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Nasaq-Common.ps1')
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$dest = (& wsl.exe -d $NasaqDistro -- wslpath -a ($Destination -replace '\\', '/')).Trim()
wsl.exe -d $NasaqDistro -- bash "$NasaqTools/backup_nasaq.sh" "$dest" 2>&1 | Tee-Object -Append -FilePath (Join-Path $NasaqLogs 'backup.log')
if ($LASTEXITCODE -ne 0) { throw 'Backup failed: see backup.log' }
