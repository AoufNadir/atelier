# Starts only the new site's local web process and forwarding.
# The Docker development stack must already be running.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Nasaq-Common.ps1')
wsl.exe -d $NasaqDistro -- bash "$NasaqTools/configure_nasaq_pdf_host.sh"
if ($LASTEXITCODE -ne 0) { throw 'The Docker stack or new site is not ready.' }
wsl.exe -d $NasaqDistro -- bash "$NasaqTools/start_nasaq_web.sh"
if ($LASTEXITCODE -ne 0) { throw 'The new site web process could not be started.' }
try {
    $check = Invoke-WebRequest -Uri 'http://127.0.0.1:8001/atelier-login' -Headers @{Host='nasaq.localhost:8001'} -TimeoutSec 3 -UseBasicParsing
} catch {
    Start-Process -FilePath 'wsl.exe' -WindowStyle Hidden -ArgumentList @('-d', $NasaqDistro, '--', 'python3', "$NasaqTools/nasaq_local_proxy.py") -RedirectStandardOutput (Join-Path $NasaqLogs 'nasaq-proxy-launch.log') -RedirectStandardError (Join-Path $NasaqLogs 'nasaq-proxy-launch-error.log') | Out-Null
}
Write-Host 'Nasaq: http://nasaq.localhost:8001/atelier-login'
