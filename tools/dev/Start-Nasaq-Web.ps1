# Starts only the new site's local web process and forwarding.
# The Docker development stack must already be running.
$ErrorActionPreference = 'Stop'
$taskWork = 'C:\Users\User\.codex\visualizations\2026\11\01\01a1986c-dd33-7182-ab8f-1a85c8f9eb22\atelier-cloud-work'
wsl.exe -d Ubuntu-24.04 -- bash /mnt/f/App/ERP/scripts/configure_nasaq_pdf_host.sh
if ($LASTEXITCODE -ne 0) { throw 'The Docker stack or new site is not ready.' }
wsl.exe -d Ubuntu-24.04 -- bash /mnt/f/App/ERP/scripts/start_nasaq_web.sh
if ($LASTEXITCODE -ne 0) { throw 'The new site web process could not be started.' }
try {
    $check = Invoke-WebRequest -Uri 'http://127.0.0.1:8001/atelier-login' -Headers @{Host='nasaq.localhost:8001'} -TimeoutSec 3
} catch {
    Start-Process -FilePath 'wsl.exe' -WindowStyle Hidden -ArgumentList @('-d','Ubuntu-24.04','--','python3','/mnt/f/App/ERP/scripts/nasaq_local_proxy.py') -RedirectStandardOutput (Join-Path $taskWork 'nasaq-proxy-launch.log') -RedirectStandardError (Join-Path $taskWork 'nasaq-proxy-launch-error.log') | Out-Null
}
Write-Host 'Nasaq: http://nasaq.localhost:8001/atelier-login'
