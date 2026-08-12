@echo off
REM Double-click to toggle the local agent fleet off and on.
REM Off = nothing runs: no Kronos on the GPU, no C++/q compiles, no pollers.
REM The daemon notices within ~30 seconds; it does not need restarting.
REM The same switch lives on /arena (admin only) and the two stay in sync.
cd /d "%~dp0"
node scripts\gaming-mode.mjs toggle
echo.
node scripts\gaming-mode.mjs status
echo.
timeout /t 6 >nul
