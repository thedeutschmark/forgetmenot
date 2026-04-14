@echo off
REM Build forgetmenot.exe — single-file standalone Windows executable.
REM Output: build/forgetmenot.exe

cd /d "%~dp0"
node scripts/build-exe.mjs
if errorlevel 1 (
  echo.
  echo Build failed.
  pause
  exit /b 1
)

echo.
echo Done. Exe is at: %~dp0build\forgetmenot.exe
pause
