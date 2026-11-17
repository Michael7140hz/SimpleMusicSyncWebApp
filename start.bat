@echo off
setlocal
cd /d "%~dp0"
title MusicSync

rem Already set up? Start, unless requirements.txt changed since (then add the new packages).
if exist ".venv\musicsync-ready" (
    fc /b requirements.txt ".venv\musicsync-ready" >nul 2>nul && goto :run
    echo MusicSync needs some extra packages. Installing them...
    goto :install
)

rem A half-finished setup from an earlier attempt gets redone from scratch.
if exist ".venv" (
    echo Removing an incomplete setup from an earlier attempt...
    rmdir /s /q ".venv"
)

echo Looking for Python 3.10 or newer...
set "PY="
for %%C in ("py -3" "py" "python" "python3") do (
    if not defined PY (
        %%~C -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul && set "PY=%%~C"
    )
)
if not defined PY goto :nopython

echo Using: %PY%
%PY% --version
echo.
echo Setting up MusicSync for the first time. This takes a minute...
%PY% -m venv .venv
if errorlevel 1 goto :venvfail

:install
rem Install from the bundled "wheels" folder when present (no internet needed),
rem otherwise download from the internet.
if exist "wheels\*.whl" (
    echo Installing packages from the wheels folder - no internet needed...
    ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check --no-index --find-links wheels -r requirements.txt
) else (
    echo Downloading packages from the internet...
    ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt
)
if errorlevel 1 goto :pipfail
copy /y requirements.txt ".venv\musicsync-ready" >nul
echo Setup complete.
echo.

:run
rem Quick check that everything imports, since the tray version has no window to show errors in.
".venv\Scripts\python.exe" -c "import flask, mutagen" 2>nul
if errorlevel 1 goto :broken

if /i "%~1"=="--console" (
    ".venv\Scripts\python.exe" server.py --console
    if errorlevel 1 (
        echo.
        echo MusicSync stopped with an error. The details are shown above.
        pause
    )
    goto :eof
)

rem Normal start: runs in the system tray, and this window closes.
start "" ".venv\Scripts\pythonw.exe" server.py
goto :eof

:broken
echo.
echo MusicSync's packages seem to be damaged. Delete the .venv folder in
echo "%~dp0" and run start.bat again to reinstall them.
pause
goto :eof

:nopython
echo.
echo Couldn't find a working Python 3.10 or newer. These commands were tried:
echo   py -3, py, python, python3
echo.
echo What Windows found for "py" and "python":
where py 2>nul || echo   py: not found
where python 2>nul || echo   python: not found
echo.
echo To fix this:
echo  1. Close this window, open a NEW Command Prompt and type:  py --version
echo     (Windows only picks up a fresh Python install in newly opened windows.)
echo  2. If that says "not recognized", sign out of Windows and back in, then try again.
echo  3. If "python" above points into ...\WindowsApps\, that may be the Microsoft Store
echo     placeholder. See the README for how to switch it off.
pause
goto :eof

:venvfail
echo.
echo Python was found (%PY%) but couldn't create the .venv folder.
echo The error is shown above. Make sure this folder isn't read-only and isn't
echo inside a zip file (extract the zip first), then run start.bat again.
pause
goto :eof

:pipfail
echo.
echo Installing the packages failed. The error is shown above.
if exist "wheels\*.whl" (
    echo The wheels folder may not match your Python version or PC type.
    echo On a PC with internet and the same Python, run get-packages.bat, then copy
    echo the new wheels folder here and run start.bat again.
) else (
    echo Check your internet connection, then run start.bat again.
)
rmdir /s /q ".venv" 2>nul
pause
goto :eof
