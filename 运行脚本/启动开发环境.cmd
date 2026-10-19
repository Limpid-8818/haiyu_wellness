@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
if errorlevel 1 exit /b %errorlevel%
cd /d "%~dp0..\项目源码"
if errorlevel 1 exit /b %errorlevel%
echo Installing dependencies from package-lock.json...
call npm ci --ignore-scripts
if errorlevel 1 exit /b %errorlevel%
call npm run dev
exit /b %errorlevel%
