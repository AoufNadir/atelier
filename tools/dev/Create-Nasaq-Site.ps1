$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Nasaq - create clean site (private password input)'
Write-Host 'This window asks for the database root password and the NEW site Administrator password.'
Write-Host 'Neither password is saved in a script or sent to the chat.'
wsl.exe -d Ubuntu-24.04 -- bash /mnt/f/App/ERP/scripts/create_nasaq_site.sh
