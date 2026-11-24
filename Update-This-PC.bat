@echo off
cd /d "%~dp0"
echo ========================================================
echo   Scoville Overdue Alerts - Updating from GitHub...
echo ========================================================
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $appDir=(Get-Location).Path; $tmpZip=Join-Path $env:TEMP 'scoville_update.zip'; $tmpExtract=Join-Path $env:TEMP 'scoville_update_extract'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Write-Host 'Downloading latest version from GitHub...' -ForegroundColor Cyan; Invoke-WebRequest -Uri 'https://github.com/QIW-Detailing/Scoville-Overdue-Alerts/archive/refs/heads/main.zip' -OutFile $tmpZip -UseBasicParsing; if (Test-Path $tmpExtract) { Remove-Item $tmpExtract -Recurse -Force }; Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force; $src=(Get-ChildItem $tmpExtract | Select-Object -First 1).FullName; Get-ChildItem $src -Exclude 'data' | Copy-Item -Destination $appDir -Recurse -Force; Remove-Item $tmpZip -Force -ErrorAction SilentlyContinue; Remove-Item $tmpExtract -Recurse -Force -ErrorAction SilentlyContinue; Write-Host 'Files updated! Restarting local helper (your saved login & settings are kept)...' -ForegroundColor Green"
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Update failed.
    pause
    exit /b 1
)
call "%~dp0Setup-This-PC.bat"
