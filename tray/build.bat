@echo off
REM Build forgetmenot-tray.exe — Windows tray app for ForgetMeNot.
REM Embeds the runtime exe so the tray ships as a single file.
REM Output: forgetmenot-tray.exe (next to this script)

setlocal
cd /d "%~dp0"

REM ── Step 1: Ensure runtime exe exists ──
set "RUNTIME_SRC=..\runtime\build\forgetmenot.exe"
if not exist "%RUNTIME_SRC%" (
  echo.
  echo Runtime exe not found at %RUNTIME_SRC%
  echo Build it first:
  echo   cd ..\runtime
  echo   build-exe.bat
  echo.
  pause
  exit /b 1
)

REM ── Step 2: Copy runtime into embed dir ──
echo Copying runtime exe into embed dir...
copy /Y "%RUNTIME_SRC%" "embedded\forgetmenot.exe" >nul
if errorlevel 1 goto :failed

REM ── Step 3: Fetch Go deps if missing ──
if not exist go.sum (
  echo Fetching Go dependencies...
  go mod tidy
  if errorlevel 1 goto :failed
)

REM ── Step 4: Build ──
REM -H windowsgui hides the console window
REM -s -w strips debug info to reduce size
echo Building forgetmenot.exe (embeds ~86 MB runtime — will take a moment)...
go build -ldflags="-H windowsgui -s -w" -o forgetmenot.exe .
if errorlevel 1 goto :failed

echo.
for %%I in (forgetmenot.exe) do echo Done. forgetmenot.exe (%%~zI bytes)
echo Single-file distribution. Just ship this one exe.
pause
exit /b 0

:failed
echo.
echo Build failed.
pause
exit /b 1
