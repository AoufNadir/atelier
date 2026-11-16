@echo off
rem Installs the "open project folder" helper for this Windows user (no admin rights needed).
powershell -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\Ubuntu-24.04\home\aoufnadir\erp\frappe_docker\development\frappe-bench\apps\atelier\tools\windows\install-open-folder.ps1"
echo.
echo Done. The "open project folder" button now opens folders in File Explorer.
pause
