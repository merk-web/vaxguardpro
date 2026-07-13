@echo off
title VaxGuard Suite Launcher
chcp 65001 >nul
cls

:MENU
echo.
echo =================================================================
echo             VaxGuard Suite - Launcher Menu
echo =================================================================
echo  [1] Launch PWA Web Application (opens in browser)
echo  [2] Launch Python CTk Desktop GUI Application
echo  [3] Install / Update Python Requirements
echo  [4] Export/Backup SQLite Database (Local Backup)
echo  [5] Exit
echo =================================================================
set /p opt="Select an option (1-5): "

if "%opt%"=="1" goto WEB_APP
if "%opt%"=="2" goto PYTHON_GUI
if "%opt%"=="3" goto INSTALL_REQS
if "%opt%"=="4" goto BACKUP_DB
if "%opt%"=="5" goto EXIT_PROG

echo Invalid option. Please try again.
pause
cls
goto MENU

:WEB_APP
cls
echo [INFO] Starting local web server on port 8888...
echo [INFO] Opening browser to http://localhost:8888 ...
start "" "http://localhost:8888"
python -m http.server 8888
pause
cls
goto MENU

:PYTHON_GUI
cls
echo [INFO] Launching Python GUI Application...
echo [INFO] If it fails, run option [3] to install requirements first.
echo.
python vaccine_reviewer.py
if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Application exited with error code %ERRORLEVEL%.
    echo [TIP]   Try running option [3] to install missing requirements.
    pause
)
cls
goto MENU

:INSTALL_REQS
cls
echo =================================================================
echo             Installing Python Requirements
echo =================================================================
echo.
echo Checking if pip is available...
python -m pip --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] pip not found. Make sure Python is installed correctly.
    echo         Download from: https://www.python.org/downloads/
    pause
    goto MENU
)

echo [INFO] Installing required packages...
echo.
python -m pip install --upgrade pip
python -m pip install pandas openpyxl customtkinter pillow

if %ERRORLEVEL% equ 0 (
    echo.
    echo [SUCCESS] All requirements installed successfully!
    echo [INFO]    You can now run option [2] to launch the GUI app.
) else (
    echo.
    echo [WARNING] Some packages may have failed. Check output above.
)
pause
cls
goto MENU

:BACKUP_DB
cls
echo [INFO] Backing up SQLite database...
if exist vaxguard.db (
    for /f "tokens=1-3 delims=/" %%a in ("%date%") do set DATESTAMP=%%c-%%b-%%a
    copy vaxguard.db "vaxguard_backup_%DATESTAMP%.db" >nul
    echo [SUCCESS] Backup created: vaxguard_backup_%DATESTAMP%.db
) else (
    echo [WARNING] No SQLite database file found (vaxguard.db).
    echo           The PWA stores data in the browser's IndexedDB, not here.
)
pause
cls
goto MENU

:EXIT_PROG
echo Goodbye!
exit
