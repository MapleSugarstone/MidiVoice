@echo off
setlocal
title MidiVoice
cd /d "%~dp0"

echo.
echo   ==============================
echo     MidiVoice - starting up
echo   ==============================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js is not installed, and MidiVoice needs it to run.
  echo.
  echo   Install the LTS version from https://nodejs.org/
  echo   then double-click this file again.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo   First run - installing dependencies.
  echo   This takes a minute or two and only happens once.
  echo.
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo.
    echo   Install failed. The messages above say why.
    echo.
    pause
    exit /b 1
  )
  echo.
)

echo   Starting the server. Your browser should open on its own.
echo   If it doesn't, go to:  http://localhost:5273
echo.
echo   KEEP THIS WINDOW OPEN while you work.
echo   Closing it shuts MidiVoice down. Ctrl+C also stops it.
echo.

call npm run dev

echo.
echo   MidiVoice has stopped.
echo.
pause
