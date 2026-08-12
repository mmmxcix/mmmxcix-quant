@echo off
REM Double-click to toggle the local agent fleet off and on.
REM Off = nothing runs: no Kronos on the GPU, no C++/q compiles, no pollers.
REM The daemon notices within ~30 seconds; it does not need restarting.
cd /d "%~dp0"
if exist "%USERPROFILE%\.mmmxcix-paused" (
  node scripts\gaming-mode.mjs off
) else (
  node scripts\gaming-mode.mjs on
)
echo.
node scripts\gaming-mode.mjs status
echo.
timeout /t 6 >nul
