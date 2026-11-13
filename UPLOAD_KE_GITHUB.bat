@echo off
title Upload Repository ke GitHub - EvidentVault
color 0b
echo ========================================================
echo       UPLOAD REPOSITORY KE GITHUB & UPDATE VERCEL
echo ========================================================
echo.

where git >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [!] Git belum terdeteksi di komputer ini.
    echo Sedang mencoba mengunduh/memasang Git via winget...
    winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements
    echo.
    echo Jika pemasangan selesai, silakan tutup jendela ini dan jalankan kembali UPLOAD_KE_GITHUB.bat
    pause
    exit /b
)

echo [OK] Git terdeteksi!
echo.
set /p REPO_URL="Masukkan URL Repository GitHub Anda (contoh: https://github.com/username/project.git): "

if "%REPO_URL%"=="" (
    echo [!] URL repository tidak boleh kosong!
    pause
    exit /b
)

echo.
echo Menyiapkan Git repository lokal...
if not exist .git (
    git init
)

git remote remove origin >nul 2>&1
git remote add origin %REPO_URL%
git branch -M main

echo Menambahkan file...
git add .

echo Membuat commit pembaruan...
git commit -m "feat: complete evident dashboard layout, paired view, telegram bot registration, customer log"

echo.
echo Mengunggah ke GitHub (main)...
git push -u origin main --force

echo.
echo ========================================================
echo [SELESAI] Kode berhasil diunggah ke GitHub!
echo Vercel akan otomatis mendeteksi dan memperbarui link:
echo https://project-ten-nu-61.vercel.app/
echo ========================================================
pause

