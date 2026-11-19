@echo off
rem Downloads the packages MusicSync needs into the "wheels" folder, so start.bat
rem can install them later on a PC without internet.
rem Run this on a PC that HAS internet and the SAME Python version (and 32/64-bit/ARM)
rem as the offline PC, then copy the whole MusicSync folder across.
setlocal
cd /d "%~dp0"
set "PY="
for %%C in ("py -3" "py" "python" "python3") do (
    if not defined PY (
        %%~C -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul && set "PY=%%~C"
    )
)
if not defined PY (
    echo Couldn't find Python 3.10 or newer.
    pause
    goto :eof
)
echo Using:
%PY% --version
if exist wheels rmdir /s /q wheels
%PY% -m pip download --disable-pip-version-check --only-binary=:all: -r requirements.txt -d wheels
if not errorlevel 1 %PY% -m pip download --disable-pip-version-check --only-binary=:all: -r requirements-convert.txt -d wheels
if errorlevel 1 (
    echo.
    echo Download failed. The error is shown above.
) else (
    echo.
    echo Done. Copy this whole folder, including "wheels", to the offline PC and run start.bat.
)
pause
