# Panduan Operasional Bot Evident Telegram - PT MAHAWIRA NUSANTARA GRUP

Bot Telegram ini digunakan oleh teknisi lapangan untuk mengunggah berkas evident (**ODC**, **ODP**, **TIANG**, **MODEM**) langsung ke Database Supabase & Web Dashboard **EvidentVault**.

---

## 📌 Aturan & SOP Input Evident (PENTING)

1. **Wajib Input ODC Terlebih Dahulu (Induk Jaringan)**
   * Format penamaan: `odc-(wilayah)-(no odc)`
   * Contoh: `odc-skd-001` atau `odc-skd-01`
   * Wajib melampirkan foto fisik perangkat ODC.
   * Data ODC ini akan menjadi acuan induk bagi perangkat ODP di bawahnya.

2. **Input ODP Wajib Menyantumkan & Sesuai dengan Label ODC**
   * Format penamaan: `ODP-(WILAYAH) (NO_ODC)/(NO_ODP)`
   * Contoh Benar: `ODP-SKD 01/01`, `ODP-SKD 01/08`, `ODP-WNJ 01/01`
   * **Aturan Fisik Lapangan vs Sistem:**
     * Jika stiker/cat fisik di lapangan tertulis `SKD ODP GRB 01/08`, `SKD ODP 01/08`, atau `ODP/SKD 01/08`, bot akan **otomatis mendeteksi urutan non-standar tersebut dan menolak** dengan memberikan tombol inline `[✏️ Edit Label]` serta saran penulisan yang benar: `ODP-SKD 01/08`.
     * Teknisi wajib menggunakan format baku `ODP-SKD 01/08` agar sistem database dan dashboard terhubung secara presisi.
   * Bot akan otomatis memeriksa acuan ODC induk (misal: `ODC-SKD 01`).
   * **VALIDASI KETAT:** Jika ODC induk belum terdaftar di database, maka **ODP TIDAK BISA DIINPUT**. Bot akan menolak dan meminta teknisi untuk menginput ODC tersebut terlebih dahulu!
   * Wajib melampirkan foto fisik perangkat ODP.

3. **4 Jenis Foto Evident Wajib (ODC & ODP) + Tombol SELESAI / DONE**
   Setiap unit ODC dan ODP memiliki alur upload bertahap untuk 4 jenis foto:
   * 🚪 **1. Foto Tampak Luar:** Foto fisik perangkat tertutup dari luar.
   * 📦 **2. Foto Tampak Dalam:** Foto baki/tray splitter, perkabelan, dan konektor serat optik.
   * 📟 **3. Foto Redaman:** Foto layar Optical Power Meter (OPM) yang menunjukkan angka loss/redaman (-dBm).
   * 🏷 **4. Foto Label:** Foto close-up stiker/plang penamaan perangkat agar terbaca tajam dan jelas.
   * 🏁 **Menu SELESAI / DONE:** Setelah mengunggah foto, bot menyediakan tombol **`[🏁 SELESAI / DONE]`** atau perintah `/done` / `/selesai` untuk menutup sesi unit perangkat tersebut secara resmi dan merangkum rekap foto yang telah terunggah.

4. **Pengelompokan Otomatis File ke Kategori/Folder Penamaan ODC di Dashboard Web**
   * Semua evident ODC (misal `ODC-SKD 01`) dan seluruh ODP anaknya (misal `ODP-SKD 01/01`, `ODP-SKD 01/08`) secara otomatis masuk ke dalam kategori/folder bernama **`ODC-SKD 01`**.
   * Di Web Dashboard, tersedia navigasi folder bergaya Google Drive. Mengklik folder `ODC-SKD 01` akan langsung menampilkan seluruh berkas ODC dan ODP yang bersangkutan.

5. **Sistem Sesi Login Dashboard (Bebas Login Ulang saat Refresh)**
   * Sesi login dashboard disimpan aman di `sessionStorage`.
   * **Saat halaman di-refresh**, dashboard **TIDAK AKAN meminta login ulang** dan langsung terbuka tanpa jeda.
   * Permintaan login ulang hanya terjadi apabila tab atau jendela browser dashboard telah ditutup.

6. **Input TIANG Bersifat Global + Wajib Tagging Lokasi GPS (Aturan Radius Minimal 30 Meter)**
   * Kategori TIANG bersifat global dan tidak memerlukan ODC/ODP induk.
   * **Wajib melampirkan Foto Tiang Asli:** Dilarang mengunggah foto duplikat atau foto yang identik dengan tiang/perangkat lain yang sudah terdaftar di sistem.
   * **Wajib Tagging Lokasi GPS:** Mengirimkan titik lokasi via tombol Telegram atau menu klip kertas -> Lokasi.
   * **ATURAN VALIDASI RADIUS GPS (30 METER):**
     * Sistem secara otomatis menghitung jarak koordinat tiang baru terhadap seluruh tiang yang sudah ada di database menggunakan kalkulasi presisi Haversine.
     * Titik koordinat tiang baru **WAJIB BERJARAK LEBIH DARI 30 METER** dari tiang yang sudah terdaftar.
     * Jika titik koordinat tiang (Titik A dan Titik B) berada di dalam radius $\le$ 30 meter atau koordinatnya sama persis, **bot akan otomatis menolak lokasi tersebut** dan mewajibkan teknisi untuk mengambil/mengirim ulang titik koordinat GPS yang benar di lokasi fisik tiang yang bersangkutan.

4. **Kategori MODEM**
   * Kirim foto fisik modem dan nomor pelanggan/SN.

5. **Pemeriksaan Kualitas Foto Otomatis oleh Script (Jelas vs Buram)**
   * Script bot secara matematis menganalisa ketajaman piksel foto (Laplacian Variance & Edge Gradient).
   * Foto yang buram, goyang (motion blur), out-of-focus, atau terlalu gelap/silau akan **otomatis ditolak oleh script**.
   * Script langsung meminta teknisi mengambil foto ulang di lapangan.

6. **Pencegahan & Penolakan Otomatis Foto Duplicate (Anti-Fraud)**
   * Bot memiliki sistem deteksi ganda (**SHA-256** untuk berkas identik + **Perceptual dHash 64-bit** untuk foto hasil screenshot/forward WhatsApp/kompresi ulang).
   * Jika ada teknisi atau pengguna siapapun yang mengunggah foto yang pernah di-upload sebelumnya, **bot akan otomatis menolak foto tersebut**.
   * Bot akan menampilkan rincian pengunggah pertama, waktu upload, dan label perangkat foto asli, serta mewajibkan foto baru real-time di lapangan.

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
