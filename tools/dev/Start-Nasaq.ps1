# Starts everything for daily work: containers, bench, the site's web process, forwarding.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Nasaq-Common.ps1')
Start-Process -FilePath 'wsl.exe' -WindowStyle Hidden -ArgumentList @('-d', $NasaqDistro, '--', 'bash', "$NasaqTools/start_nasaq.sh") -RedirectStandardOutput (Join-Path $NasaqLogs 'bench.log') -RedirectStandardError (Join-Path $NasaqLogs 'bench-error.log') | Out-Null
Start-Sleep -Seconds 25
& (Join-Path $PSScriptRoot 'Start-Nasaq-Web.ps1')
