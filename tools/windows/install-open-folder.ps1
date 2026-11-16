# Installs the «افتح مجلد المشروع» helper for the current Windows user (no admin rights).
# Registers the nasaq:// link so the app's button opens the project folder in File Explorer.
$dest = Join-Path $env:LOCALAPPDATA 'Nasaq'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot 'nasaq-open.ps1') (Join-Path $dest 'nasaq-open.ps1')

$key = 'HKCU:\Software\Classes\nasaq'
New-Item -Force -Path "$key\shell\open\command" | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value 'URL:Nasaq'
Set-ItemProperty -Path $key -Name 'URL Protocol' -Value ''
$cmd = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + (Join-Path $dest 'nasaq-open.ps1') + '" "%1"'
Set-ItemProperty -Path "$key\shell\open\command" -Name '(default)' -Value $cmd
Write-Output "Installed: $cmd"
