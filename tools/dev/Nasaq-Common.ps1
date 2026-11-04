# Shared by the Nasaq PowerShell scripts. Paths follow this file, so any folder works.
$NasaqDistro = if ($env:NASAQ_WSL_DISTRO) { $env:NASAQ_WSL_DISTRO } else { 'Ubuntu-24.04' }
$NasaqTools = (& wsl.exe -d $NasaqDistro -- wslpath -a ($PSScriptRoot -replace '\\', '/')).Trim()
if (-not $NasaqTools) { throw "WSL distribution $NasaqDistro is not ready." }
$NasaqLogs = Join-Path $env:LOCALAPPDATA 'Nasaq'
New-Item -ItemType Directory -Force -Path $NasaqLogs | Out-Null
