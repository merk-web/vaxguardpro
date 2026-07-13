@echo off
title VaxGuard Suite Launcher
cls

:MENU
echo =================================================================
echo             VaxGuard Suite - Launcher Menu
echo =================================================================
echo  [1] Launch PWA Web Application (starts local HTTP server)
echo  [2] Launch Python CTk Desktop GUI Application
echo  [3] Export/Backup SQLite Database (Local Backup)
echo  [4] Exit
echo =================================================================
set /p opt="Select an option (1-4): "

if "%opt%"=="1" goto WEB_APP
if "%opt%"=="2" goto PYTHON_GUI
if "%opt%"=="3" goto BACKUP_DB
if "%opt%"=="4" goto EXIT_PROG

echo Invalid option. Please try again.
pause
cls
goto MENU

:WEB_APP
cls
echo [INFO] Starting local Web server on port 8080...
echo [INFO] Opening Web Browser to http://localhost:8888 ...
start "" "http://localhost:8888"
python -m http.server 8888
pause
cls
goto MENU

:PYTHON_GUI
cls
echo [INFO] Launching CustomTkinter Python GUI Application...
python vaccine_reviewer.py
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Python GUI application exited with error code %ERRORLEVEL%.
    pause
)
cls
goto MENU

:BACKUP_DB
cls
echo [INFO] backing up SQLite database...
if exist vaxguard.db (
    copy vaxguard.db vaxguard_backup_%date:~-4%-%date:~3,2%-%date:~0,2%.db
    echo [SUCCESS] Backup created successfully.
) else (
    echo [WARNING] No database file found to backup.
)
pause
cls
goto MENU

:EXIT_PROG
echo Goodbye!
exit
