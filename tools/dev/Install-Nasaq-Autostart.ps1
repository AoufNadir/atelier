# Registers two Windows scheduled tasks for the current user:
#  - "Raqmi Start": starts the containers and the real site one minute after logon
#  - "Raqmi Backup": daily backup at -BackupTime (and the task catches up if the PC was off)
# Run once from PowerShell inside the repository. Re-running replaces the two tasks only.
param([Parameter(Mandatory = $true)][string]$BackupDestination, [string]$BackupTime = '14:00')
$ErrorActionPreference = 'Stop'
$ps = (Get-Command powershell.exe).Source
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$start = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSScriptRoot\Start-Nasaq.ps1`""
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logon.Delay = 'PT1M'
Register-ScheduledTask -TaskName 'Raqmi Start' -Action $start -Trigger $logon -Settings $settings -Force | Out-Null
$backup = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$PSScriptRoot\Backup-Nasaq.ps1`" -Destination `"$BackupDestination`""
$daily = New-ScheduledTaskTrigger -Daily -At $BackupTime
Register-ScheduledTask -TaskName 'Raqmi Backup' -Action $backup -Trigger $daily -Settings $settings -Force | Out-Null
Write-Host "OK: 'Raqmi Start' at logon, 'Raqmi Backup' daily at $BackupTime -> $BackupDestination"
