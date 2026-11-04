$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Nasaq - new Administrator password'
wsl.exe -d Ubuntu-24.04 -- python3 /mnt/f/App/ERP/scripts/create_nasaq_with_container_credentials.py
