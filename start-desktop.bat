@echo off
chcp 65001 >nul
title SwiftDrop Desktop - P2P File & Remote Control
cd /d "%~dp0"
if exist "SwiftDrop.exe" (
  start "" "SwiftDrop.exe" %*
  exit /b 0
)
cd /d "%~dp0desktop-app"
where node >nul 2>nul
if %errorlevel%==0 (
  start "" /b node "native-host.js"
  exit /b 0
)
if exist "node_modules\electron\dist\electron.exe" (
  start "" "node_modules\electron\dist\electron.exe" "."
  exit /b 0
)
echo Hay cai Node.js LTS (https://nodejs.org) hoac tai SwiftDrop.exe!
pause
