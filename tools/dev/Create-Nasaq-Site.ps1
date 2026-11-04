$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Nasaq - create clean site (private password input)'
. (Join-Path $PSScriptRoot 'Nasaq-Common.ps1')
Write-Host 'This window asks for the database root password and the NEW site Administrator password.'
Write-Host 'Neither password is saved in a script or sent to the chat.'
wsl.exe -d $NasaqDistro -- bash "$NasaqTools/create_nasaq_site.sh"
