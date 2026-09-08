@echo off
setlocal
cd /d "%~dp0"

echo === Crewfall ===
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js LTS from nodejs.org, then run play.bat again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo First run: installing packages. This needs the internet once and takes a minute.
  call npm install
  if errorlevel 1 (
    echo npm install failed. Copy the text above and keep it for troubleshooting.
    pause
    exit /b 1
  )
)

echo Starting the game. A browser tab will open. Close this window to stop the game.
call npm run dev
if errorlevel 1 (
  echo The game server stopped with an error. Copy the text above and keep it for troubleshooting.
  pause
  exit /b 1
)
endlocal
