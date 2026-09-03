@echo off
title LIQRADAR
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo  ERROR: Node.js no esta instalado.
  echo  Descargalo de https://nodejs.org, instalalo y vuelve a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo.
  echo  Instalando dependencias. Solo pasa la primera vez, tarda un minuto...
  echo.
  call npm install
)

echo.
echo  ==========================================
echo    LIQRADAR
echo.
echo    El navegador se abrira solo.
echo    Para cerrar: pulsa Ctrl+C en esta ventana.
echo  ==========================================
echo.

call npx vite --open

echo.
echo  El servidor se ha detenido.
pause
