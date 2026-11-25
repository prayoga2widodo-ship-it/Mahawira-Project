# Panduan Operasional Bot Evident Telegram - PT MAHAWIRA NUSANTARA GRUP

Bot Telegram ini digunakan oleh teknisi lapangan untuk mengunggah berkas evident (**ODC**, **ODP**, **TIANG**, **MODEM**) langsung ke Database Supabase & Web Dashboard **EvidentVault**.

---

## 📌 Aturan & SOP Input Evident (PENTING - WAJIB BERURUTAN & ANTI-SKIP)

Semua proses penginputan data perangkat di bot sekarang menerapkan **SISTEM WAJIB BERURUTAN (STRICT SEQUENTIAL / ANTI-SKIP)**. Teknisi **TIDAK BISA** melompati step, memintas melalui caption foto, atau menekan tombol `/done` sebelum seluruh tahapan terpenuhi 100%.

---

### 📦 Alur Wajib 6 Step ODC:
1. **Step 1 - Label ODC:** Kirim label sesuai format baku `odc-skd-01`.
2. **Step 2 - Share Loc GPS ODC:** Wajib kirim lokasi via tombol keyboard `[📍 Kirim Lokasi GPS ODC Sekarang]`. *(Foto dan tombol menu terkunci sampai GPS diterima).*
3. **Step 3 - Foto Tampak Luar:** Kirim foto fisik luar ODC tertutup.
4. **Step 4 - Foto Tampak Dalam:** Kirim foto baki tray/splitter/kabel dalam ODC.
5. **Step 5 - Foto Redaman:** Kirim foto layar ukur OPM (-dBm).
6. **Step 6 - Foto Label:** Kirim foto stiker plang label ODC terbaca jelas. *(Setelah foto ke-4 diunggah, sesi otomatis 100% SELESAI).*

---

### 🛜 Alur Wajib 6 Step ODP:
1. **Step 1 - Label ODP:** Kirim label sesuai format baku `ODP-SKD 01/01`. Bot otomatis memvalidasi ODC induk (`ODC-SKD 01`). Jika ODC belum terdaftar, bot menolak!
2. **Step 2 - Share Loc GPS ODP:** Wajib kirim lokasi via tombol keyboard `[📍 Kirim Lokasi GPS ODP Sekarang]`.
3. **Step 3 - Foto Tampak Luar:** Kirim foto fisik luar ODP tertutup.
4. **Step 4 - Foto Tampak Dalam:** Kirim foto baki tray/splitter/konektor serat optik.
5. **Step 5 - Foto Redaman:** Kirim foto layar ukur OPM (-dBm).
6. **Step 6 - Foto Label:** Kirim foto stiker nomor label ODP terbaca jelas. *(Setelah foto ke-4 diunggah, sesi otomatis 100% SELESAI).*

---

### 🪵 Alur Wajib 3 Step TIANG:
1. **Step 1 - Label Tiang:** Kirim nama/label tiang (misal `TIANG-SKD-01`).
2. **Step 2 - Foto Evident Tiang:** Kirim foto fisik tiang asli tegak di lapangan (termasuk deteksi buram & anti duplikasi).
3. **Step 3 - Share Loc GPS Tiang:** Tekan tombol `[📍 Kirim Lokasi Tiang Sekarang]` (Wajib radius minimal > 10 meter dari tiang lain). *(Selesai & tersimpan ke Supabase).*

---

### 💻 Alur Wajib 7 Step MODEM:
1. **Step 1 - Share Loc GPS Modem:** Tekan tombol `[📍 Kirim Share Loc Modem]`.
2. **Step 2 - Label ODP Induk:** Masukkan label ODP yang terdaftar (misal `ODP-SKD 01/01`).
3. **Step 3 - ID Pelanggan:** Ketik ID Pelanggan.
4. **Step 4 - Nama Pelanggan:** Ketik nama lengkap pelanggan.
5. **Step 5 - SN Modem:** Ketik Serial Number (SN) perangkat modem.
6. **Step 6 - Foto Tampak Depan:** Unggah foto depan modem (lampu indikator menyala).
7. **Step 7 - Foto Tampak Belakang:** Unggah foto belakang modem (stiker barcode & SN terbaca jelas). *(Selesai 100%).*

---

### 🔒 Proteksi Anti-Skip & Keamanan Data
* **Tombol Menu Terkunci (`🔒 Terkunci`):** Menu pemilihan jenis foto mengunci tombol yang belum tiba gilirannya. Hanya tombol bertanda `👉 Wajib Sekarang` yang dapat dipilih.
* **Perintah Langsung Diblokir:** Mengetik `/tampak_dalam`, `/redaman`, atau `/label` secara manual sebelum urutan sebelumnya selesai akan ditolak oleh bot.
* **Teks Biasa Diblokir Saat Menunggu Foto/Lokasi:** Jika teknisi mengetik teks biasa ketika bot sedang menunggu foto atau shareloc, bot akan menolak dan mengarahkan kembali ke step yang sedang aktif.
* **Foto Diblokir Saat Menunggu GPS/Label:** Mengirim foto sebelum shareloc diterima atau sebelum label diinput akan langsung ditolak bot.
* **Anti Selesai Prematur:** Tombol `[🏁 SELESAI]` atau perintah `/done` / `/selesai` **DITOLAK** jika 4 foto dan koordinat GPS belum lengkap 100%. Sesi hanya bisa ditutup jika seluruh syarat sudah lengkap!

---

## 🚀 Perintah Command Telegram
| Command | Deskripsi |
|---|---|
| `/odc` | Input evident **📦 ODC** (Wajib dilakukan di awal) |
| `/odp` | Input evident **🛜 ODP** (Validasi otomatis ke ODC induk) |
| `/tiang` | Input evident **🪵 TIANG** (Wajib foto & tagging lokasi GPS) |
| `/modem` | Input evident **💻 MODEM** |
| `/tampak_luar` | Upload **🚪 Foto Tampak Luar** (Fisik luar ODC/ODP tertutup) |
| `/tampak_dalam` | Upload **📦 Foto Tampak Dalam** (Baki/tray/splitter/konektor) |
| `/redaman` | Upload **📟 Foto Redaman** (Layar ukur power meter OPM -dBm) |
| `/label` | Upload **🏷 Foto Label** (Stiker fisik perangkat terbaca jelas) |
| `/done` / `/selesai` | 🏁 Selesai / Done upload foto unit ODC/ODP |
| `/status` | Melihat rekap jumlah file evident per kategori |
| `/batal` | Membatalkan sesi input yang sedang aktif |
| `/register <ID>` | Mendaftarkan ID Telegram teknisi ke database |
| `/help` | Panduan lengkap SOP dan format label |

---

## 🛠 Cara Menjalankan Bot di Komputer / Server

### ⚡ Cara Praktis (Cukup Klik 2x):
1. Buka folder `D:\PT MAHAWIRA NUSANTARA GRUP\PROGRAM DASHBOARD`.
2. **Klik 2x file `JALANKAN_BOT.bat`**.
3. Bot akan otomatis mendeteksi Node.js dan langsung menyala!

### 💻 Cara via Command Prompt (CMD):
```cmd
cd /d "D:\PT MAHAWIRA NUSANTARA GRUP\PROGRAM DASHBOARD" && node bot.js
```
*(Biarkan jendela CMD tetap terbuka agar bot terus aktif).*
