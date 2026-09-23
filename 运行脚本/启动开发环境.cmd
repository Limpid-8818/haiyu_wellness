@echo off
setlocal
cd /d "%~dp0..\项目源码"
echo Installing dependencies if needed...
call npm install --ignore-scripts
if errorlevel 1 exit /b 1
call npm run dev
