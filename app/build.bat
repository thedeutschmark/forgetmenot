@echo off
REM Build forgetmenot-tray.exe — Windows tray app for ForgetMeNot.
REM Embeds the runtime exe so the tray ships as a single file.
REM Output: forgetmenot.exe (next to this script)

setlocal
cd /d "%~dp0"

REM ── Step 1: Ensure runtime exe exists ──
set "RUNTIME_SRC=..\forgetmenot\build\forgetmenot.exe"
if not exist "%RUNTIME_SRC%" (
  echo.
  echo Runtime exe not found at %RUNTIME_SRC%
  echo Build it first:
  echo   cd ..\forgetmenot
  echo   build-exe.bat
  echo.
  pause
  exit /b 1
)

REM ── Step 2: Copy runtime into embed dir ──
echo Copying runtime exe into embed dir...
copy /Y "%RUNTIME_SRC%" "embedded\forgetmenot.exe" >nul
if errorlevel 1 goto :failed

REM ── Step 3: Regenerate status icons from flower.png if Python + Pillow are
REM available. Skipped silently if not — in that case the committed .ico
REM files are used as-is. The go build step re-embeds whatever is on disk
REM via //go:embed, so regen-here-then-build keeps the tray status colors
REM and face in sync with icons\flower.png without manual steps.
where python >nul 2>nul
if errorlevel 1 (
  echo Skipping icon regen ^(python not found^). Using committed icons.
) else (
  echo Regenerating tray icons from flower.png...
  pushd icons
  python generate.py
  if errorlevel 1 (
    echo Icon regen failed. Check that Pillow is installed: pip install Pillow
    popd
    goto :failed
  )
  popd
)

REM ── Step 4: Regenerate Windows resource (.syso) so the app/File Explorer
REM icon matches the current forgetmenot.ico. The .syso is what gives the
REM exe its taskbar / Alt-Tab / File Explorer icon — without this step a
REM newly designed brand icon won't land in the built exe even though the
REM tray status icons (which //go:embed re-reads) will update fine.
set "RSRC_BIN=%USERPROFILE%\go\bin\rsrc.exe"
if not exist "%RSRC_BIN%" (
  where rsrc >nul 2>nul
  if not errorlevel 1 set "RSRC_BIN=rsrc"
)
if exist "%RSRC_BIN%" (
  echo Regenerating rsrc_windows_amd64.syso from icons\forgetmenot.ico...
  "%RSRC_BIN%" -ico icons\forgetmenot.ico -arch amd64 -o rsrc_windows_amd64.syso
  if errorlevel 1 goto :failed
) else (
  echo Skipping .syso regen ^(rsrc not found^).
  echo Install with: go install github.com/akavel/rsrc@latest
  echo Using committed rsrc_windows_amd64.syso.
)

REM ── Step 5: Fetch Go deps if missing ──
if not exist go.sum (
  echo Fetching Go dependencies...
  go mod tidy
  if errorlevel 1 goto :failed
)

REM ── Step 6: Build ──
REM -H windowsgui hides the console window
REM -s -w strips debug info to reduce size
REM -X main.Version embeds the version string used by the update checker.
REM CI sets TRAY_VERSION to the git tag; local builds default to "dev".
if not defined TRAY_VERSION set "TRAY_VERSION=dev"
echo Building forgetmenot.exe (version %TRAY_VERSION% — embeds ~86 MB runtime)...
go build -ldflags="-H windowsgui -s -w -X main.Version=%TRAY_VERSION%" -o forgetmenot.exe .
if errorlevel 1 goto :failed

echo.
for %%I in (forgetmenot.exe) do echo Done. forgetmenot.exe (%%~zI bytes)
echo Single-file distribution. Just ship this one exe.
if not defined CI pause
exit /b 0

:failed
echo.
echo Build failed.
if not defined CI pause
exit /b 1
