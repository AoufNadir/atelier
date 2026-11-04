$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Nasaq - new Administrator password'
. (Join-Path $PSScriptRoot 'Nasaq-Common.ps1')
wsl.exe -d $NasaqDistro -- python3 "$NasaqTools/create_nasaq_with_container_credentials.py"
