@echo off
title EvidentVault - Telegram Bot Launcher
color 0A
cd /d "%~dp0"

if exist "C:\Program Files\nodejs" set "PATH=C:\Program Files\nodejs;%PATH%"
if exist "%LOCALAPPDATA%\Programs\nodejs" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%PATH%"

echo ==========================================================
echo       BOT TELEGRAM EVIDENT - PT MAHAWIRA NUSANTARA GRUP
echo ==========================================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NO_NODE

echo [OK] Node.js terdeteksi:
node -v
echo.

if exist "node_modules\jpeg-js" goto RUN_BOT

echo [INFO] Menyiapkan library pertama kali / memperbarui modul...
echo Mohon tunggu sebentar, sedang memasang telegraf, supabase, dan jpeg-js...
echo.
call npm install
if errorlevel 1 goto NPM_ERROR

echo.
echo [OK] Semua library berhasil dipasang!
echo.

:RUN_BOT
echo [INFO] Menjalankan Bot Telegram...
echo [INFO] Menghubungkan ke server Telegram dan Supabase...
echo.
echo ==========================================================
echo   BOT AKTIF! JANGAN TUTUP JENDELA INI AGAR BOT TETAP NYALA
echo ==========================================================
echo Tekan Ctrl + C jika ingin menghentikan bot.
echo.

node bot.js

echo.
echo ==========================================================
echo Bot telah berhenti.
pause
exit /b

:NO_NODE
color 0C
echo [ERROR] Program Node.js belum terdeteksi di komputer Anda!
echo.
echo Bot Telegram ini membutuhkan Node.js untuk dapat berjalan.
echo Sedang membuka halaman download resmi Node.js di browser Anda...
echo.
start https://nodejs.org/en/download
echo Setelah Node.js selesai didownload dan diinstall:
echo Silakan tutup jendela ini lalu jalankan kembali file JALANKAN_BOT.bat.
echo.
echo ==========================================================
pause
exit /b

:NPM_ERROR
color 0C
echo.
echo [ERROR] Gagal memasang library pendukung!
echo Pastikan komputer Anda terhubung dengan internet.
echo ==========================================================
pause
exit /b
