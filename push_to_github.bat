@echo off
REM VaxGuard Suite — GitHub Push Helper
REM Run this after creating an empty repo on GitHub

echo.
echo ============================================
echo  VaxGuard Suite — GitHub Deploy
echo ============================================
echo.
set /p REPO_URL="Paste your GitHub repo URL (e.g. https://github.com/yourname/vaxguard): "
echo.
git remote remove origin 2>nul
git remote add origin %REPO_URL%
git branch -M main
git push -u origin main
echo.
echo Done! Your app is live at:
echo %REPO_URL:.git=%/
echo.
echo To enable GitHub Pages:
echo   1. Go to your repo on GitHub
echo   2. Settings → Pages
echo   3. Source: main branch / root
echo   4. Save — app will be live in ~1 minute
echo.
pause
