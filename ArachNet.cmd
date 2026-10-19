@echo off
title ArachNet
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js fehlt - bitte von https://nodejs.org installieren. & pause & exit /b 1)
if not exist "browser\node_modules\puppeteer-core" (echo Installiere Browser-Abhaengigkeiten ... & pushd browser & call npm install --no-audit --no-fund & popd)
if not exist "viz3d\node_modules\three" (echo Installiere Visualizer-Abhaengigkeiten ... & pushd viz3d & call npm install --no-audit --no-fund & popd)
echo.
echo   ARACHNET /[.]\  Control Panel startet: http://127.0.0.1:7777/
echo   Dieses Fenster offen lassen. Beenden mit Strg+C oder Fenster schliessen.
echo.
node browser\launch.mjs %*
