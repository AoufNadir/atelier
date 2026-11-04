$Host.UI.RawUI.WindowTitle = 'Nasaq - reset and verify Administrator'
. (Join-Path $PSScriptRoot 'Nasaq-Common.ps1')
wsl.exe -d $NasaqDistro -- python3 "$NasaqTools/reset_nasaq_administrator.py"
