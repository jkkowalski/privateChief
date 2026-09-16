@echo off
rem PrivateChief - aplikacja domowa dla telefonow w sieci WiFi.
rem Klikniecie uruchamia serwer; okno pokazuje PIN i adres do wpisania na telefonie.
rem Zatrzymanie: Ctrl+C albo zamkniecie tego okna.

title PrivateChief - aplikacja domowa
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  if exist "C:\nvm4w\nodejs\node.exe" (
    "C:\nvm4w\nodejs\node.exe" "web\app.js"
  ) else (
    echo.
    echo   Nie znalazlem Node.js. Zainstaluj go albo popraw sciezke w tym pliku.
    echo.
    pause
  )
) else (
  node "web\app.js"
)

echo.
echo   Serwer zatrzymany.
pause
