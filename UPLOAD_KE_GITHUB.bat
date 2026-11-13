@echo off
title Upload Repository ke GitHub - prayoga2widodo-ship-it/Mahawira-Project
color 0b
echo ========================================================
echo       UPLOAD REPOSITORY KE GITHUB & UPDATE VERCEL
echo    Target: prayoga2widodo-ship-it/Mahawira-Project
echo ========================================================
echo.

set "GIT_EXE=C:\Users\LENOVO\AppData\Local\Programs\MinGit\cmd\git.exe"
if not exist "%GIT_EXE%" (
    where git >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        set "GIT_EXE=git"
    ) else (
        echo [!] Git tidak ditemukan.
        pause
        exit /b
    )
)

echo [OK] Menggunakan Git: %GIT_EXE%
echo.

cd /d "%~dp0"

echo [1/4] Memeriksa status repository...
"%GIT_EXE%" remote remove origin >nul 2>&1
"%GIT_EXE%" remote add origin https://github.com/prayoga2widodo-ship-it/Mahawira-Project.git
"%GIT_EXE%" branch -M main

echo [2/4] Menambahkan seluruh file terbaru...
"%GIT_EXE%" add .

echo [3/4] Melakukan commit...
"%GIT_EXE%" commit -m "feat: complete evident dashboard layout, paired view, telegram bot registration, customer log" >nul 2>&1

echo [4/4] Mengunggah (push) ke GitHub...
echo.
echo CATATAN: Jika diminta Username dan Password:
echo - Masukkan Username: prayoga2widodo-ship-it
echo - Masukkan Password: Gunakan GitHub Personal Access Token (bukan password akun biasa)
echo   (Jika belum punya token, bisa buat cepat di https://github.com/settings/tokens)
echo.
"%GIT_EXE%" push -u origin main --force

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================================
    echo [SUKSES!] Seluruh kode terbaru BERHASIL diunggah ke GitHub!
    echo Vercel sedang otomatis mengupdate website Anda:
    echo https://project-ten-nu-61.vercel.app/
    echo Silakan buka dan refresh (Ctrl+F5) di browser Anda!
    echo ========================================================
) else (
    echo.
    echo [!] Terjadi kendala saat push. Silakan periksa kredensial / token GitHub Anda.
)

echo.
pause
