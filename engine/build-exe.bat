@echo off
REM Build forgetmenot.exe — single-file standalone Windows executable.
REM Requires Node.js 22+ (24+ recommended for stable node:sqlite).
REM Output: build/forgetmenot.exe

setlocal
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :failed
)

node scripts/build-exe.mjs
if errorlevel 1 goto :failed

echo.
echo Done. Exe is at: %~dp0build\forgetmenot.exe
pause
exit /b 0

:failed
echo.
echo Build failed.
pause
exit /b 1
