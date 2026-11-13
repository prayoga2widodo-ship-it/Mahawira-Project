const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let jpeg = null;
try {
    jpeg = require('jpeg-js');
} catch (e) {
    jpeg = null;
}

// 1. Mengambil konfigurasi dari config.js
let APP_CONFIG = {};
try {
    APP_CONFIG = require('./config.js');
} catch (e) {
    APP_CONFIG = {};
}

// Konfigurasi Kredensial Bot Telegram & Supabase
const BOT_TOKEN = process.env.BOT_TOKEN || '9073260643:AAGVOavzwi3-6URsXE4JrJDzMh1ixal2Ow4';
const SUPABASE_URL = process.env.SUPABASE_URL || APP_CONFIG.supabaseUrl || 'https://cxibcknjtbtckbumtltx.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || APP_CONFIG.supabaseAnonKey || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN4aWJja25qdGJ0Y2tidW10bHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM5NDI0OTgsImV4cCI6MjEwOTUxODQ5OH0.5ij0znN5l5yIsvAtBzXAqAnHryLzXDM8D1MLPZCaHWw';

const bot = new Telegraf(BOT_TOKEN);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// State sesi pengguna
// userSessions[chatId] = {
//    category: 'ODC' | 'ODP' | 'TIANG' | 'MODEM' | null,
//    step: 'waiting_label' | 'waiting_photo' | 'waiting_location' | 'waiting_edit_label' | null,
//    deviceLabel: string | null,
//    odcReference: string | null,
//    pendingPhoto: object | null
// }
const userSessions = {};

function getSession(chatId) {
    const id = chatId.toString();
    if (!userSessions[id]) {
        userSessions[id] = {
            category: null,
            step: null,
            deviceLabel: null,
            photoType: null,
            odcReference: null,
            odpReference: null,
            customerId: null,
            customerName: null,
            modemSn: null,
            pendingPhoto: null,
            completedTypes: []
        };
    }
    return userSessions[id];
}

function clearSession(chatId) {
    const id = chatId.toString();
    delete userSessions[id];
}

// ==========================================================
// 1. ANALYZER FORMAT LABEL (SCRIPT MENENTUKAN KESESUAIAN)
// ==========================================================

// Format Standar ODC: ODC-(WILAYAH) (NO_ODC) atau ODC-(WILAYAH)-(NO_ODC)
// Contoh yang Benar: ODC-SKD 01, ODC-SKD 001, ODC-WNJ 01, ODC-CHSN 01
function analyzeOdcLabel(text) {
    if (!text) return { valid: false, reason: 'Label ODC tidak boleh kosong.' };
    const raw = text.trim();

    // 1. Format Valid Standar: ODC-(WILAYAH) (NO_ODC) atau ODC-(WILAYAH)-(NO_ODC)
    const validMatch = raw.match(/^ODC-([A-Z0-9]+(?:-[A-Z0-9]+)?)[\s-]+([A-Z0-9]+)$/i);
    if (validMatch) {
        const wilayah = validMatch[1].toUpperCase();
        const nomor = validMatch[2].toUpperCase();
        return {
            valid: true,
            wilayah: wilayah,
            nomor: nomor,
            formatted: `ODC-${wilayah} ${nomor}`,
            compact: `ODC-${wilayah}-${nomor}`
        };
    }

    // 2. Format Terbalik dari Lapangan (Contoh: SKD ODC 01)
    const revMatch = raw.match(/^([A-Z0-9]+)\s*[-_\/]?\s*ODC[\s-_\/]+([A-Z0-9]+)$/i);
    if (revMatch) {
        const wilayah = revMatch[1].toUpperCase();
        const nomor = revMatch[2].toUpperCase();
        return {
            valid: false,
            needsEdit: true,
            input: raw,
            suggestion: `ODC-${wilayah} ${nomor}`,
            reason: `Urutan penulisan terbalik (ODC di tengah/akhir). Sistem mewajibkan format standar: ODC-(WILAYAH) (NOMOR)`
        };
    }

    // 3. Format Salah Tanda Pemisah (Contoh: ODC/CHSN 01, ODC_CHSN 01, ODC CHSN 01, ODC-CHSN/01)
    const typoMatch = raw.match(/^ODC[\/_.\s]+([A-Z0-9]+)[\/_.\s-]+([A-Z0-9]+)$/i);
    if (typoMatch) {
        const wilayah = typoMatch[1].toUpperCase();
        const nomor = typoMatch[2].toUpperCase();
        return {
            valid: false,
            needsEdit: true,
            input: raw,
            suggestion: `ODC-${wilayah} ${nomor}`,
            reason: `Penulisan tanda pemisah salah. Sistem mewajibkan format standar: ODC-(WILAYAH) (NOMOR)`
        };
    }

    return {
        valid: false,
        needsEdit: true,
        input: raw,
        suggestion: `ODC-SKD 01`,
        reason: `Format penamaan tidak sesuai standar sistem. Format yang benar: ODC-(WILAYAH) (NOMOR)`
    };
}

// Format Standar ODP: ODP-(WILAYAH) (NO_ODC)/(NO_ODP) atau ODP-(WILAYAH)-(NO_ODC)/(NO_ODP)
// Contoh yang Benar: ODP-SKD 01/01, ODP-SKD 001/001, ODP-WNJ 01/01, ODP-SKD 01/08
function analyzeOdpLabel(text) {
    if (!text) return { valid: false, reason: 'Label ODP tidak boleh kosong.' };
    const raw = text.trim();

    // 1. Format Valid Standar
    const validMatch = raw.match(/^ODP-([A-Z0-9]+(?:-[A-Z0-9]+)?)[\s-]+([A-Z0-9]+)\s*\/\s*([A-Z0-9]+)$/i);
    if (validMatch) {
        const wilayah = validMatch[1].toUpperCase();
        const noOdc = validMatch[2].toUpperCase();
        const noOdp = validMatch[3].toUpperCase();
        return {
            valid: true,
            wilayah: wilayah,
            noOdc: noOdc,
            noOdp: noOdp,
            formattedOdp: `ODP-${wilayah} ${noOdc}/${noOdp}`,
            expectedOdc: `ODC-${wilayah} ${noOdc}`,
            expectedOdcAlt: `ODC-${wilayah}-${noOdc}`
        };
    }

    // 2. Format Terbalik / Non-standar Lapangan (Contoh: 'SKD ODP GRB 01/08' atau 'SKD ODP 01/08')
    const revMatch = raw.match(/^([A-Z0-9]+)\s*[-_\/]?\s*ODP(?:\s*[-_\/]?\s*([A-Z0-9]+))?[\s-_\/]+([A-Z0-9]+)\s*[\/_-]\s*([A-Z0-9]+)$/i);
    if (revMatch) {
        const wilayah = revMatch[1].toUpperCase();
        const noOdc = revMatch[3].toUpperCase();
        const noOdp = revMatch[4].toUpperCase();
        return {
            valid: false,
            needsEdit: true,
            input: raw,
            suggestion: `ODP-${wilayah} ${noOdc}/${noOdp}`,
            reason: `Urutan penulisan terbalik atau penamaan fisik lapangan non-standar (ODP di tengah/akhir). Sistem mewajibkan diawali: ODP-(WILAYAH) (NO_ODC)/(NO_ODP)`
        };
    }

    // 3. Format Salah Tanda Pemisah (Contoh: ODP/SKD 01/08, ODP-SKD-01-08, ODP_SKD_01/08, ODP SKD 01/08)
    const typoMatch = raw.match(/^ODP[\/_.\s-]+([A-Z0-9]+)[\/_.\s-]+([A-Z0-9]+)[\/_.\s-]+([A-Z0-9]+)$/i);
    if (typoMatch) {
        const wilayah = typoMatch[1].toUpperCase();
        const noOdc = typoMatch[2].toUpperCase();
        const noOdp = typoMatch[3].toUpperCase();
        return {
            valid: false,
            needsEdit: true,
            input: raw,
            suggestion: `ODP-${wilayah} ${noOdc}/${noOdp}`,
            reason: `Penamaan label ODP tidak lurus dengan aturan sistem. Format yang benar: ODP-(WILAYAH) (NO_ODC)/(NO_ODP)`
        };
    }

    return {
        valid: false,
        needsEdit: true,
        input: raw,
        suggestion: `ODP-SKD 01/01`,
        reason: `Format penamaan tidak sesuai standar sistem. Format yang benar: ODP-(WILAYAH) (NO_ODC)/(NO_ODP)`
    };
}

// ==========================================================
// 1.B HELPER DETEKSI JENIS FOTO EVIDENT (TAMPAK LUAR, DALAM, REDAMAN, LABEL)
// ==========================================================
function detectPhotoType(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    if (lower.includes('tampak luar') || lower.includes('luar') || lower.includes('outdoor') || lower.includes('depan')) {
        return 'TAMPAK LUAR';
    }
    if (lower.includes('tampak dalam') || lower.includes('dalam') || lower.includes('indoor') || lower.includes('baki') || lower.includes('tray') || lower.includes('isi') || lower.includes('splitter')) {
        return 'TAMPAK DALAM';
    }
    if (lower.includes('redaman') || lower.includes('opm') || lower.includes('dbm') || lower.includes('power meter') || lower.includes('loss') || lower.includes('ukur')) {
        return 'REDAMAN';
    }
    if (lower.includes('label') || lower.includes('stiker') || lower.includes('sticker') || lower.includes('plang') || lower.includes('nama')) {
        return 'LABEL';
    }
    return null;
}

function cleanCaptionForLabel(text) {
    if (!text) return '';
    return text
        .replace(/foto|tampak\s+luar|tampak\s+dalam|tampak|luar|dalam|redaman|power\s+meter|opm|dbm|loss|label|stiker|sticker|baki|tray/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildPhotoTypeMenu(category, label, completedTypes = []) {
    const done = Array.isArray(completedTypes) ? completedTypes : [];
    const mark = (t) => done.includes(t) ? ' ✅' : '';
    const totalDone = done.length;

    const rows = [
        [
            Markup.button.callback(`🚪 1. Tampak Luar${mark('TAMPAK LUAR')}`, 'action_type:TAMPAK LUAR'),
            Markup.button.callback(`📦 2. Tampak Dalam${mark('TAMPAK DALAM')}`, 'action_type:TAMPAK DALAM')
        ],
        [
            Markup.button.callback(`📟 3. Foto Redaman${mark('REDAMAN')}`, 'action_type:REDAMAN'),
            Markup.button.callback(`🏷 4. Foto Label${mark('LABEL')}`, 'action_type:LABEL')
        ]
    ];

    // Tombol SELESAI / DONE selalu tersedia dan menonjol
    const doneBtnText = totalDone >= 4
        ? `🏁 SELESAI / DONE (4/4 Foto Lengkap) 🎉`
        : totalDone > 0
            ? `🏁 SELESAI / DONE (${totalDone}/4 Terupload)`
            : `🏁 SELESAI / DONE (Selesai Unit Ini)`;

    rows.push([Markup.button.callback(doneBtnText, 'action_finish_device')]);
    rows.push([Markup.button.callback('❌ Batalkan Sesi', 'action_cancel')]);
    return Markup.inlineKeyboard(rows);
}

// ==========================================================
// 2. VALIDATOR KUALITAS FOTO (SCRIPT MENENTUKAN JELAS / BURAM)
// ==========================================================

// Helper: Decode berkas JPEG maupun PNG ke bentuk Grayscale Uint8Array
function decodeImageToGray(fileBuffer) {
    if (!fileBuffer || fileBuffer.length < 8) return null;

    // 1. Deteksi berkas PNG: Signature 89 50 4E 47
    if (fileBuffer[0] === 0x89 && fileBuffer[1] === 0x50 && fileBuffer[2] === 0x4E && fileBuffer[3] === 0x47) {
        try {
            let pos = 8, w = 0, h = 0, idats = [];
            while (pos < fileBuffer.length - 8) {
                const len = fileBuffer.readUInt32BE(pos);
                const type = fileBuffer.toString('ascii', pos + 4, pos + 8);
                if (type === 'IHDR') {
                    w = fileBuffer.readUInt32BE(pos + 8);
                    h = fileBuffer.readUInt32BE(pos + 12);
                } else if (type === 'IDAT') {
                    idats.push(fileBuffer.slice(pos + 8, pos + 8 + len));
                }
                pos += 12 + len;
            }
            if (w === 0 || h === 0 || idats.length === 0) return null;

            const raw = zlib.inflateSync(Buffer.concat(idats));
            const bpp = 4; // Format RGBA standar
            const stride = w * bpp;
            const gray = new Uint8Array(w * h);
            const scanline = Buffer.alloc(stride);
            const prev = Buffer.alloc(stride);
            let offset = 0;

            for (let y = 0; y < h; y++) {
                const filter = raw[offset++];
                for (let x = 0; x < stride; x++) {
                    const xVal = raw[offset++];
                    const a = x >= bpp ? scanline[x - bpp] : 0;
                    const bVal = prev[x];
                    const c = x >= bpp ? prev[x - bpp] : 0;
                    let val = 0;
                    if (filter === 0) val = xVal;
                    else if (filter === 1) val = (xVal + a) & 0xff;
                    else if (filter === 2) val = (xVal + bVal) & 0xff;
                    else if (filter === 3) val = (xVal + Math.floor((a + bVal) / 2)) & 0xff;
                    else if (filter === 4) {
                        const p = a + bVal - c;
                        const pa = Math.abs(p - a), pb = Math.abs(p - bVal), pc = Math.abs(p - c);
                        const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? bVal : c);
                        val = (xVal + pr) & 0xff;
                    }
                    scanline[x] = val;
                }
                scanline.copy(prev);

                for (let x = 0; x < w; x++) {
                    const idx = x * bpp;
                    gray[y * w + x] = Math.round(0.299 * scanline[idx] + 0.587 * scanline[idx + 1] + 0.114 * scanline[idx + 2]);
                }
            }
            return { width: w, height: h, gray };
        } catch (e) {
            console.warn("PNG decode notice:", e.message);
            return null;
        }
    }

    // 2. Dekode berkas JPEG via jpeg-js
    if (jpeg) {
        try {
            const raw = jpeg.decode(fileBuffer, { useTArray: true });
            if (!raw || !raw.width || !raw.height) return null;
            const w = raw.width;
            const h = raw.height;
            const data = raw.data;
            const channels = data.length === w * h * 4 ? 4 : 3;
            const gray = new Uint8Array(w * h);

            for (let y = 0; y < h; y++) {
                const row = y * w;
                for (let x = 0; x < w; x++) {
                    const idx = (row + x) * channels;
                    gray[row + x] = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
                }
            }
            return { width: w, height: h, gray };
        } catch (e) {
            console.warn("JPEG decode notice:", e.message);
            return null;
        }
    }

    return null;
}

function validatePhotoClarity(photoObj, fileBuffer = null) {
    const width = photoObj.width || 0;
    const height = photoObj.height || 0;
    const fileSize = photoObj.file_size || (fileBuffer ? fileBuffer.length : 0);
    const sizeKb = (fileSize / 1024).toFixed(1);

    // 1. Cek Resolusi Minimum (Disesuaikan dengan standar foto lapangan teknisi: min 200x150 px)
    if (width > 0 && height > 0) {
        if (width < 200 || height < 150) {
            return {
                valid: false,
                reason: `Resolusi foto terlalu kecil (${width}x${height} px). Standar minimal adalah 200x150 px agar teks stiker label tetap dapat terbaca.`
            };
        }
    }

    // 2. Cek Ukuran Berkas Minimum (Foto lapangan terkompresi min 8 KB)
    if (fileSize > 0 && fileSize < 8 * 1024) {
        return {
            valid: false,
            reason: `Ukuran berkas foto terlalu kecil (${sizeKb} KB). Berkas terdeteksi kosong atau rusak.`
        };
    }

    // 3. Analisa Ketajaman Pixel (Laplacian Variance & Edge Gradient)
    if (fileBuffer && fileBuffer.length > 0) {
        const img = decodeImageToGray(fileBuffer);
        if (img && img.width > 0 && img.height > 0) {
            const w = img.width;
            const h = img.height;
            const gray = img.gray;

            const step = w > 1200 ? 2 : 1;
            let lapSum = 0;
            let lapSqSum = 0;
            let count = 0;
            let totalGrad = 0;
            let totalBrightness = 0;

            for (let y = 1; y < h - 1; y += step) {
                const row = y * w;
                const prevRow = (y - 1) * w;
                const nextRow = (y + 1) * w;

                for (let x = 1; x < w - 1; x += step) {
                    const c = gray[row + x];
                    const t = gray[prevRow + x];
                    const b = gray[nextRow + x];
                    const l = gray[row + x - 1];
                    const r = gray[row + x + 1];

                    // Laplacian Operator
                    const lap = 4 * c - t - b - l - r;
                    lapSum += lap;
                    lapSqSum += lap * lap;
                    count++;

                    const grad = Math.abs(r - l) + Math.abs(b - t);
                    totalGrad += grad;
                    totalBrightness += c;
                }
            }

            if (count > 0) {
                const mean = lapSum / count;
                const variance = (lapSqSum / count) - (mean * mean);
                const avgGrad = totalGrad / count;
                const avgBrightness = totalBrightness / count;

                console.log(`[PEMERIKSAAN KETAJAMAN] Resolusi: ${w}x${h}, Variansi: ${variance.toFixed(2)}, Gradien: ${avgGrad.toFixed(2)}, Kecerahan: ${avgBrightness.toFixed(1)}`);

                // A. Uji Gelap
                if (avgBrightness < 18) {
                    return {
                        valid: false,
                        reason: `Foto terdeteksi TERLALU GELAP / KURANG PENCAHAYAAN (Tingkat kecerahan: ${avgBrightness.toFixed(0)}/255). Nyalakan lampu flash atau cari area lebih terang.`
                    };
                }

                // B. Uji Silau / Blank Putih
                if (avgBrightness > 250 && avgGrad < 2.0) {
                    return {
                        valid: false,
                        reason: `Foto terdeteksi TERLALU SILAU / BLOWN-OUT FLASH (Tingkat kecerahan: ${avgBrightness.toFixed(0)}/255). Kurangi pantulan cahaya agar teks stiker terbaca.`
                    };
                }

                // C. Uji Blur / Out-of-Focus (Variance of Laplacian)
                // Foto referensi tajam teknisi (265x206) bernilai 1311.6
                // Foto buram / motion blur bernilai < 70
                const MIN_SHARPNESS = 70.0;
                const MIN_GRADIENT = 4.5;

                if (variance < MIN_SHARPNESS || avgGrad < MIN_GRADIENT) {
                    return {
                        valid: false,
                        reason: `Hasil analisa script: Foto terdeteksi BURAM / TIDAK FOKUS (Skor Ketajaman: ${variance.toFixed(1)} / Standar Min: ${MIN_SHARPNESS}). Tulisan stiker label atau fisik perangkat tidak terbaca jelas.`
                    };
                }

                return {
                    valid: true,
                    width: w,
                    height: h,
                    sizeKb,
                    sharpnessScore: variance.toFixed(1),
                    decoded: img
                };
            }
        }
    }

    return {
        valid: true,
        width,
        height,
        sizeKb,
        decoded: null
    };
}

// ==========================================================
// 3. DETEKSI DUPLIKASI FOTO OTOMATIS (SHA-256 & PERCEPTUAL dHash)
// ==========================================================

const HASH_FILE = path.join(__dirname, 'evident_hashes.json');
let hashCache = [];

// Muat cache riwayat hash foto dari file lokal
function loadHashCache() {
    try {
        if (fs.existsSync(HASH_FILE)) {
            const raw = fs.readFileSync(HASH_FILE, 'utf-8');
            hashCache = JSON.parse(raw);
            if (!Array.isArray(hashCache)) hashCache = [];
        } else {
            hashCache = [];
        }
    } catch (e) {
        console.warn("Notice baca hash cache:", e.message);
        hashCache = [];
    }
    return hashCache;
}

// Simpan rekaman hash foto baru ke file lokal
function saveHashRecord(record) {
    if (!record || (!record.sha256 && !record.dhash)) return;
    loadHashCache();

    // Pastikan tidak ada rekaman persis sama yang terduplikasi di file
    const exists = hashCache.some(item => (record.sha256 && item.sha256 === record.sha256) || (record.dhash && item.dhash === record.dhash));
    if (!exists) {
        hashCache.push({
            sha256: record.sha256 || null,
            dhash: record.dhash || null,
            uploader: record.uploader || 'Teknisi',
            category: record.category || 'UNKNOWN',
            deviceLabel: record.deviceLabel || '-',
            date: record.date || new Date().toLocaleString('id-ID'),
            fileName: record.fileName || '-'
        });
        try {
            fs.writeFileSync(HASH_FILE, JSON.stringify(hashCache, null, 2), 'utf-8');
            console.log(`[HASH TERSIMPAN] Berkas: ${record.fileName}, SHA: ${record.sha256 ? record.sha256.substring(0, 10) : '-'}..., dHash: ${record.dhash || '-'}`);
        } catch (e) {
            console.error("Gagal menulis evident_hashes.json:", e.message);
        }
    }
}

// Perceptual Difference Hash (dHash 64-bit) dengan Area-Averaging Downsampling (Tahan Kompresi/Format Ulang)
function computeDHash(decoded) {
    if (!decoded || !decoded.gray || !decoded.width || !decoded.height) return null;
    const targetW = 9;
    const targetH = 8;
    const w = decoded.width;
    const h = decoded.height;
    const gray = decoded.gray;
    const small = new Float32Array(targetW * targetH);
    const blockW = w / targetW;
    const blockH = h / targetH;

    for (let ty = 0; ty < targetH; ty++) {
        const yStart = Math.floor(ty * blockH);
        const yEnd = Math.min(h, Math.floor((ty + 1) * blockH));
        for (let tx = 0; tx < targetW; tx++) {
            const xStart = Math.floor(tx * blockW);
            const xEnd = Math.min(w, Math.floor((tx + 1) * blockW));
            let sum = 0, count = 0;
            for (let y = yStart; y < yEnd; y++) {
                const row = y * w;
                for (let x = xStart; x < xEnd; x++) {
                    sum += gray[row + x];
                    count++;
                }
            }
            small[ty * targetW + tx] = count > 0 ? sum / count : 0;
        }
    }

    let hashBits = '';
    for (let y = 0; y < targetH; y++) {
        const row = y * targetW;
        for (let x = 0; x < 8; x++) {
            hashBits += small[row + x] > small[row + x + 1] ? '1' : '0';
        }
    }

    let hex = '';
    for (let i = 0; i < 64; i += 4) {
        hex += parseInt(hashBits.substr(i, 4), 2).toString(16);
    }
    return hex;
}

// Menghitung Jarak Hamming (Hamming Distance) antara 2 buah dHash 64-bit
function hammingDistance(hex1, hex2) {
    if (!hex1 || !hex2 || hex1.length !== hex2.length) return 999;
    let dist = 0;
    for (let i = 0; i < hex1.length; i++) {
        let xor = parseInt(hex1[i], 16) ^ parseInt(hex2[i], 16);
        while (xor > 0) {
            dist += xor & 1;
            xor >>= 1;
        }
    }
    return dist;
}

// Cek Apakah Foto Merupakan Duplikat dari Foto yang Pernah Di-upload Siapapun
function checkDuplicateEvident(sha256, dhash) {
    loadHashCache();
    if (!hashCache || hashCache.length === 0) return { isDuplicate: false };

    for (const record of hashCache) {
        // 1. Cek Exact Duplicate (Berkas binary persis sama via SHA-256)
        if (sha256 && record.sha256 && sha256 === record.sha256) {
            return {
                isDuplicate: true,
                type: 'EXACT (Berkas Foto Identik 100%)',
                matchRecord: record,
                distance: 0,
                similarity: 100
            };
        }

        // 2. Cek Perceptual Duplicate (Foto sama hasil screenshot, forward WA/Telegram, kompresi ulang, atau beda format)
        if (dhash && record.dhash) {
            const dist = hammingDistance(dhash, record.dhash);
            // Jarak Hamming <= 8 (dari 64 bit) menandakan kemiripan visual >= 87.5%
            if (dist <= 8) {
                const sim = Math.round((1 - (dist / 64)) * 100);
                return {
                    isDuplicate: true,
                    type: `PERCEPTUAL (Foto Identik / Kembar, Kemiripan ${sim}%)`,
                    matchRecord: record,
                    distance: dist,
                    similarity: sim
                };
            }
        }
    }

    return { isDuplicate: false };
}

// Sinkronisasi riwayat hash dari tabel evidents di Supabase saat startup
async function syncHashesFromSupabase() {
    loadHashCache();
    try {
        console.log("🔄 Menyinkronkan riwayat hash evident dari Supabase...");
        const { data, error } = await supabase
            .from('evidents')
            .select('id, name, category, device_label, uploader, date, file_url, latitude, longitude')
            .order('id', { ascending: false })
            .limit(1000);

        if (error) {
            console.warn("Sinkronisasi Supabase notice:", error.message);
            return;
        }

        if (data && data.length > 0) {
            let added = 0;
            for (const item of data) {
                if (!item.name && !item.file_url) continue;

                const matchH = item.name ? item.name.match(/\[H:([a-f0-9]+)\]/i) : null;
                const matchDH = item.name ? item.name.match(/\[DH:([a-f0-9]+)\]/i) : null;

                let sha = matchH ? matchH[1] : null;
                let dh = matchDH ? matchDH[1] : null;

                // Periksa apakah sudah ada di cache lokal
                const alreadyExists = hashCache.some(h =>
                    (sha && h.sha256 && h.sha256.startsWith(sha)) ||
                    (dh && h.dhash && h.dhash === dh) ||
                    (h.fileName && h.fileName === item.name)
                );

                // Jika belum tercatat di cache dan ada file_url, download buffer dan hitung hash
                if (!alreadyExists && item.file_url) {
                    try {
                        const buf = await downloadFileBuffer(item.file_url);
                        if (buf && buf.length > 0) {
                            sha = crypto.createHash('sha256').update(buf).digest('hex');
                            const dec = decodeImageToGray(buf);
                            dh = computeDHash(dec);
                        }
                    } catch (dlErr) {
                        console.warn(`Sync download notice ID ${item.id}:`, dlErr.message);
                    }
                }

                if (sha || dh) {
                    const isRecorded = hashCache.some(h => (sha && h.sha256 && h.sha256 === sha) || (dh && h.dhash && h.dhash === dh));
                    if (!isRecorded) {
                        hashCache.push({
                            sha256: sha,
                            dhash: dh,
                            uploader: item.uploader || 'Teknisi',
                            category: item.category || 'UNKNOWN',
                            deviceLabel: item.device_label || item.name || '-',
                            date: item.date || '-',
                            fileName: item.name || '-'
                        });
                        added++;
                    }
                }
            }

            if (added > 0) {
                try {
                    fs.writeFileSync(HASH_FILE, JSON.stringify(hashCache, null, 2), 'utf-8');
                    console.log(`✅ Sinkronisasi selesai: ${added} hash evident baru ditambahkan ke cache anti-duplikat.`);
                } catch (e) { }
            }
            console.log(`✅ Cache hash pencegahan duplikat siap (${hashCache.length} rekaman foto aktif).`);
        }
    } catch (e) {
        console.warn("Sinkronisasi hash notice:", e.message);
    }
}

// ==========================================================
// 4. VALIDASI GEOLOKASI GPS TIANG (RADIUS MAKSIMAL 30 METER)
// ==========================================================

// Menghitung Jarak Antara 2 Titik Koordinat GPS Menggunakan Formula Haversine (Satuan: Meter)
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
    if (lat1 === lat2 && lon1 === lon2) return 0;
    const R = 6371e3; // Radius bumi dalam meter
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
    const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;

    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
        Math.cos(phi1) * Math.cos(phi2) *
        Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

// Memeriksa Radius Jarak Tiang Baru Terhadap Tiang-Tiang yang Sudah Terdaftar (Radius Max 30m)
async function checkTiangProximity(lat, lng) {
    try {
        const { data, error } = await supabase
            .from('evidents')
            .select('id, name, device_label, latitude, longitude, uploader, date')
            .eq('category', 'TIANG')
            .not('latitude', 'is', null)
            .not('longitude', 'is', null);

        if (error || !data || data.length === 0) {
            return { allowed: true, closestDistance: null };
        }

        let closest = null;
        let minDistance = Infinity;

        for (const tiang of data) {
            const dist = calculateDistanceMeters(lat, lng, tiang.latitude, tiang.longitude);
            if (dist < minDistance) {
                minDistance = dist;
                closest = tiang;
            }
        }

        // SOP: Titik koordinat tiang baru wajib berada di luar radius 30 meter dari tiang yang sudah ada!
        // Jika jarak <= 30 meter, tolak karena berada di radius tiang yang sama!
        if (minDistance <= 30.0 && closest) {
            return {
                allowed: false,
                distance: minDistance,
                existingTiang: closest
            };
        }

        return {
            allowed: true,
            closestDistance: minDistance !== Infinity ? minDistance : null
        };
    } catch (e) {
        console.warn("Gagal mengecek proximity tiang:", e.message);
        return { allowed: true, closestDistance: null };
    }
}

// Helper: Memastikan nama kategori ODC terdaftar di tabel categories Supabase
async function ensureCategoryExists(categoryName) {
    if (!categoryName) return;
    try {
        await supabase
            .from('categories')
            .upsert({ name: categoryName.trim() }, { onConflict: 'name' });
    } catch (e) {
        console.warn("Notice kategori:", e.message);
    }
}

// ==========================================================
// 3. CEK ODC INDUK DI DATABASE SUPABASE
// ==========================================================
async function checkOdcExists(expectedOdc, expectedOdcAlt) {
    if (!expectedOdc) return false;
    const clean1 = expectedOdc.trim().toUpperCase();
    const clean2 = expectedOdcAlt ? expectedOdcAlt.trim().toUpperCase() : clean1;
    const cleanNoSpace = clean1.replace(/\s+/g, '-');
    const cleanUnderscore = clean1.replace(/\s+/g, '_');

    try {
        const { data, error } = await supabase
            .from('evidents')
            .select('id, device_label, name, category')
            .or(`device_label.ilike.%${clean1}%,device_label.ilike.%${clean2}%,device_label.ilike.%${cleanNoSpace}%,name.ilike.%${cleanNoSpace}%,name.ilike.%${cleanUnderscore}%,category.ilike.%${clean1}%`)
            .limit(1);

        if (error || !data || data.length === 0) {
            return false;
        }
        return true;
    } catch (e) {
        console.error("Gagal memeriksa ODC:", e);
        return false;
    }
}

// Helper: Download buffer file dari Telegram
function downloadFileBuffer(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadFileBuffer(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Status HTTP gagal: ${res.statusCode}`));
            }
            const data = [];
            res.on('data', (chunk) => data.push(chunk));
            res.on('end', () => resolve(Buffer.concat(data)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

// Helper: Upload file buffer ke Supabase Storage (dengan fallback ke URL Telegram)
async function uploadToSupabaseStorage(fileName, fileBuffer, mimeType = 'image/jpeg') {
    try {
        const filePath = `uploads/${Date.now()}_${fileName}`;
        const { data, error } = await supabase.storage
            .from('evidents')
            .upload(filePath, fileBuffer, {
                contentType: mimeType,
                upsert: true
            });

        if (!error && data) {
            const { data: publicData } = supabase.storage
                .from('evidents')
                .getPublicUrl(filePath);
            if (publicData && publicData.publicUrl) {
                return publicData.publicUrl;
            }
        }
    } catch (err) {
        console.warn("Storage notice:", err.message);
    }
    return null;
}

// Helper: Reply Keyboard di bawah layar chat
function buildPersistentKeyboard() {
    return Markup.keyboard([
        ['📦 ODC', '🛜 ODP'],
        ['🪵 TIANG', '💻 MODEM'],
        ['📊 Status Evident', '❌ Batalkan Sesi']
    ]).resize();
}

// Helper: Komentar Otomatis Jika ID Telegram Belum Didaftarkan Oleh Owner
function sendUnregisteredNotice(ctx, chatId) {
    const strId = (chatId || (ctx.chat ? ctx.chat.id : '') || '').toString();
    const fromUser = ctx.from || {};
    const userName = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(' ') || 
                     (fromUser.username ? '@' + fromUser.username : 'Teknisi');

    return ctx.reply(
        `🚫 *AKSES DITOLAK: ID TELEGRAM BELUM DIDAFTARKAN!*\n\n` +
        `👤 *Nama Pengguna:* ${userName}\n` +
        `🆔 *ID Telegram Anda:* \`${strId}\`\n\n` +
        `⚠️ *PEMBERITAHUAN SISTEM PT MAHAWIRA NUSANTARA GRUP:*\n` +
        `Akun Telegram Anda belum didaftarkan oleh **Owner / Administrator** di sistem pengumpulan evident. Demi keamanan data perusahaan, seluruh fitur bot saat ini terkunci.\n\n` +
        `👉 *CARA PENDAFTARAN OLEH OWNER:*\n` +
        `1. Salin ID Telegram Anda: \`${strId}\`\n` +
        `2. Kirimkan ID Telegram tersebut kepada Owner / Administrator.\n` +
        `3. Owner akan mendaftarkan akun Anda menggunakan perintah:\n` +
        `   \`/register ${strId} ${userName}\`\n\n` +
        `_Setelah ID Telegram Anda didaftarkan oleh Owner, silakan ketik /start untuk mulai menggunakan bot._`,
        { parse_mode: 'Markdown' }
    );
}

// ==========================================================
// DAFTAR ID TELEGRAM OWNER / ADMIN UTAMA PERMANEN
// ==========================================================
const SUPER_ADMIN_TELEGRAM_IDS = ['119509416'];

// Inisialisasi Super Admin ke access_list database jika belum ada
async function initSuperAdmin() {
    try {
        const { data: existing } = await supabase
            .from('access_list')
            .select('*')
            .eq('telegram_chat_id', '119509416')
            .single();

        if (!existing) {
            await supabase.from('access_list').insert([{
                telegram_chat_id: '119509416',
                role: 'owner',
                email: 'Owner Utama (ID: 119509416)'
            }]);
            console.log("✅ Super Admin Telegram ID 119509416 berhasil didaftarkan sebagai Owner Utama di database.");
        }
    } catch (e) {
        console.warn("Init Super Admin notice:", e.message);
    }
}
initSuperAdmin();

// Helper: Cek Apakah Pengguna Adalah Admin / Owner
async function isTelegramAdmin(chatId) {
    if (!chatId) return false;
    const strId = chatId.toString().trim();
    if (SUPER_ADMIN_TELEGRAM_IDS.includes(strId)) {
        return true;
    }
    const { data: user } = await supabase
        .from('access_list')
        .select('*')
        .eq('telegram_chat_id', strId)
        .single();

    if (user && (user.role === 'owner' || user.role === 'admin')) {
        return true;
    }
    return false;
}

// Helper: Cek Izin Akses Pengguna
async function verifyUserAccess(chatId) {
    const strId = chatId.toString().trim();
    if (SUPER_ADMIN_TELEGRAM_IDS.includes(strId)) {
        return { allowed: true, user: { role: 'owner', telegram_chat_id: strId, email: 'Owner Utama (ID: 119509416)' } };
    }
    const { data: user, error } = await supabase
        .from('access_list')
        .select('*')
        .eq('telegram_chat_id', strId)
        .single();

    if (error || !user) {
        return { allowed: false, reason: 'unregistered' };
    }
    if (user.role === 'viewer') {
        return { allowed: false, reason: 'viewer', user };
    }
    return { allowed: true, user };
}

// Helper: Parser Cerdas untuk Input Banyak ID Telegram (Hingga 100+ ID)
function parseBulkTelegramInputs(rawText) {
    const rawTokens = rawText.split(/[\r\n]+/);
    const tokens = [];

    for (const line of rawTokens) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('/register')) continue;
        const digits = trimmed.match(/\b\d{5,15}\b/g) || [];
        if (digits.length > 1) {
            tokens.push(...trimmed.split(/[,;]+/).map(s => s.trim()).filter(Boolean));
        } else {
            tokens.push(trimmed);
        }
    }

    const results = [];
    const seen = new Set();

    for (const item of tokens) {
        if (!item) continue;
        const m = item.match(/^(\d{5,15})(?:\s*[-:|]\s*(.+))?$/);
        if (m) {
            const id = m[1].trim();
            const name = (m[2] || `Teknisi (${id})`).trim();
            if (!seen.has(id)) {
                seen.add(id);
                results.push({ id, name });
            }
        } else {
            const idMatches = item.match(/\b\d{5,15}\b/g);
            if (idMatches) {
                for (const id of idMatches) {
                    if (!seen.has(id)) {
                        seen.add(id);
                        results.push({ id, name: `Teknisi (${id})` });
                    }
                }
            }
        }
    }
    return results;
}

// Helper: Pendaftaran Massal / Batch ID Telegram ke Supabase oleh Admin (Bisa 100 ID Sekaligus)
async function registerBulkTechnicians(ctx, items) {
    if (!items || items.length === 0) {
        return ctx.reply(
            `❌ *Tidak ditemukan ID Telegram yang valid!*\n\n` +
            `👉 *Format Input Massal (hingga 100 ID):*\n` +
            `\`\`\`\n` +
            `119509416 - Bpk Owner\n` +
            `123456789 - Budi Santoso\n` +
            `987654321 - Dani Pratama\n` +
            `\`\`\`\n` +
            `Atau cukup deretan ID dipisahkan koma/spasi/enter:\n` +
            `\`123456789, 987654321, 555666777\``,
            { parse_mode: 'Markdown' }
        );
    }

    const records = items.map(it => ({
        telegram_chat_id: it.id,
        role: 'editor',
        email: `${it.name} (ID: ${it.id})`
    }));

    // Simpan batch ke tabel access_list dengan upsert
    const { error: upsertErr } = await supabase
        .from('access_list')
        .upsert(records, { onConflict: 'telegram_chat_id' });

    if (upsertErr) {
        return ctx.reply(`❌ *Gagal Menyimpan Pendaftaran Massal:*\n\`${upsertErr.message}\``, { parse_mode: 'Markdown' });
    }

    let summaryList = items.slice(0, 20).map((it, idx) => `${idx + 1}. \`${it.id}\` - *${it.name}*`).join('\n');
    if (items.length > 20) {
        summaryList += `\n... dan ${items.length - 20} teknisi lainnya tercatat sukses.`;
    }

    return ctx.reply(
        `🎉 *PENDAFTARAN MASSAL BERHASIL!*\n\n` +
        `📊 *Total ID Didaftarkan:* *${items.length} Teknisi*\n` +
        `🛡 *Role Akses:* *EDITOR* (Diizinkan Upload Evident)\n\n` +
        `📋 *Rincian ID Terdaftar:*\n${summaryList}\n\n` +
        `Seluruh teknisi di atas kini sudah dapat menggunakan bot secara penuh.`,
        { parse_mode: 'Markdown' }
    );
}

// Helper: Pendaftaran ID Telegram ke Supabase oleh Admin
async function registerTechnicianByAdmin(ctx, targetId, technicianName) {
    const strId = targetId.toString().trim();

    const { data: existingUser } = await supabase
        .from('access_list')
        .select('*')
        .eq('telegram_chat_id', strId)
        .single();

    if (existingUser) {
        return ctx.reply(
            `ℹ️ *ID Telegram ${strId} sudah terdaftar sebelumnya!*\n` +
            `• Role: *${(existingUser.role || 'editor').toUpperCase()}*\n` +
            `• Identitas: ${existingUser.email || '-'}`,
            { parse_mode: 'Markdown' }
        );
    }

    const newRecord = {
        telegram_chat_id: strId,
        role: 'editor',
        email: `${technicianName} (ID: ${strId})`
    };

    const { error: insertErr } = await supabase
        .from('access_list')
        .insert([newRecord]);

    if (insertErr) {
        return ctx.reply(`❌ *Gagal Mendaftarkan ID!*\nError: \`${insertErr.message}\``, { parse_mode: 'Markdown' });
    }

    return ctx.reply(
        `✅ *PENDAFTARAN TEKNISI BERHASIL!*\n\n` +
        `🆔 *ID Telegram:* \`${strId}\`\n` +
        `👤 *Nama:* *${technicianName}*\n` +
        `🛡 *Role:* *EDITOR* (Diizinkan Upload Evident)\n\n` +
        `Teknisi sekarang sudah dapat menggunakan bot EvidentVault.`,
        { parse_mode: 'Markdown' }
    );
}

// Menu Inline Utama
function buildMainInlineMenu() {
    return Markup.inlineKeyboard([
        [
            Markup.button.callback('📦 1. Input ODC (Wajib Awal)', 'start_odc'),
            Markup.button.callback('🛜 2. Input ODP', 'start_odp')
        ],
        [
            Markup.button.callback('🪵 3. Input Tiang (Wajib GPS)', 'start_tiang'),
            Markup.button.callback('💻 4. Input Modem', 'start_modem')
        ],
        [
            Markup.button.callback('📊 Cek Status Evident', 'action_open_status'),
            Markup.button.callback('ℹ️ Panduan SOP & Format', 'action_open_help')
        ]
    ]);
}

// Helper: Menyimpan Data Evident ke Supabase (Cloud Database + Cloud Storage + Local Disk Vault Backup)
async function saveEvidentToDatabase(ctx, recordData) {
    let finalFileUrl = recordData.fileUrl;

    // 1. Simpan salinan fisik file secara lokal di disk server (Local Vault Backup) agar data abadi
    if (recordData.fileBuffer) {
        try {
            const backupDir = path.join(__dirname, 'data', 'evident_vault');
            if (!fs.existsSync(backupDir)) {
                fs.mkdirSync(backupDir, { recursive: true });
            }
            const safeLocalName = (recordData.name || `evident_${Date.now()}.jpg`).replace(/[^a-zA-Z0-9_.-]/g, '_');
            const localFilePath = path.join(backupDir, safeLocalName);
            fs.writeFileSync(localFilePath, recordData.fileBuffer);
        } catch (backupErr) {
            console.warn("Local disk backup notice:", backupErr.message);
        }
    }

    // 2. Upload file buffer ke Supabase Cloud Storage
    if (recordData.fileBuffer) {
        const uploadedUrl = await uploadToSupabaseStorage(recordData.name, recordData.fileBuffer, recordData.mimeType || 'image/jpeg');
        if (uploadedUrl) {
            finalFileUrl = uploadedUrl;
        }
    }

    const newRecord = {
        name: recordData.name,
        size: recordData.size,
        category: recordData.category,
        device_label: recordData.deviceLabel || null,
        photo_type: recordData.photoType || null,
        odc_reference: recordData.odcReference || null,
        odp_reference: recordData.odpReference || null,
        latitude: recordData.latitude || null,
        longitude: recordData.longitude || null,
        location_url: recordData.locationUrl || null,
        uploader: recordData.uploader,
        date: new Date().toLocaleString('id-ID'),
        status: 'Pending Review',
        file_url: finalFileUrl,
        reject_reason: null
    };

    if (recordData.sha256) newRecord.image_hash = recordData.sha256;
    if (recordData.dhash) newRecord.perceptual_hash = recordData.dhash;
    if (recordData.customerId) newRecord.customer_id = recordData.customerId;
    if (recordData.customerName) newRecord.customer_name = recordData.customerName;
    if (recordData.modemSn) newRecord.modem_sn = recordData.modemSn;

    let { error: insertError } = await supabase
        .from('evidents')
        .insert([newRecord]);

    // Jika Supabase belum memiliki kolom hash atau photo_type atau kolom pelanggan di skema tabel, retry tanpa kolom tersebut
    if (insertError && insertError.message && (
        insertError.message.includes('image_hash') || 
        insertError.message.includes('perceptual_hash') || 
        insertError.message.includes('photo_type') ||
        insertError.message.includes('customer_id') ||
        insertError.message.includes('customer_name') ||
        insertError.message.includes('modem_sn') ||
        insertError.message.includes('odp_reference')
    )) {
        delete newRecord.image_hash;
        delete newRecord.perceptual_hash;
        delete newRecord.photo_type;
        delete newRecord.customer_id;
        delete newRecord.customer_name;
        delete newRecord.modem_sn;
        delete newRecord.odp_reference;
        const retry = await supabase.from('evidents').insert([newRecord]);
        insertError = retry.error;
    }

    if (insertError) {
        console.error("Gagal simpan ke Supabase:", insertError);
        await ctx.reply(`❌ *GAGAL MENYIMPAN KE DATABASE!*\nError: \`${insertError.message}\``, { parse_mode: 'Markdown' });
        return false;
    }

    // Pastikan kategori (misal: ODC-SKD 01) terdaftar di tabel categories dashboard
    if (recordData.category) {
        await ensureCategoryExists(recordData.category);
    }

    // Rekam hash ke file persistent anti-duplikat
    if (recordData.sha256 || recordData.dhash) {
        saveHashRecord({
            sha256: recordData.sha256,
            dhash: recordData.dhash,
            uploader: recordData.uploader,
            category: recordData.category,
            deviceLabel: recordData.deviceLabel || recordData.name,
            date: newRecord.date,
            fileName: recordData.name
        });
    }

    let extraDetails = '';
    if (recordData.deviceLabel) extraDetails += `🏷 *Label Perangkat:* \`${recordData.deviceLabel}\`\n`;
    if (recordData.photoType) extraDetails += `📷 *Jenis Foto:* *${recordData.photoType}*\n`;
    if (recordData.customerId) extraDetails += `🆔 *ID Pelanggan:* \`${recordData.customerId}\`\n`;
    if (recordData.customerName) extraDetails += `👤 *Nama Pelanggan:* \`${recordData.customerName}\`\n`;
    if (recordData.modemSn) extraDetails += `📟 *SN Modem:* \`${recordData.modemSn}\`\n`;
    if (recordData.odcReference) extraDetails += `🔗 *Acuan ODC Induk:* \`${recordData.odcReference}\`\n`;
    if (recordData.latitude && recordData.longitude) {
        extraDetails += `📍 *Koordinat GPS:* \`${recordData.latitude}, ${recordData.longitude}\`\n`;
        extraDetails += `🗺 *Peta:* [Buka Google Maps](${recordData.locationUrl})\n`;
    }

    const completed = recordData.completedTypes || [];
    let progressNote = '';
    if (recordData.baseLabel) {
        if (completed.length >= 4) {
            progressNote = `\n🎉 *SEMUA 4 FOTO TELAH LENGKAP!*\n👉 Silakan klik tombol **[🏁 SELESAI / DONE]** di bawah untuk menutup sesi unit ini.\n`;
        } else {
            progressNote = `\n📸 *Progres Foto Unit Ini:* ${completed.length}/4 Foto Terupload.\n👉 Silakan klik jenis foto berikutnya atau tekan **[🏁 SELESAI / DONE]**:\n`;
        }
    }

    const successMsg =
        `✅ *FOTO EVIDENT LOLOS PEMERIKSAAN SCRIPT & BERHASIL DISIMPAN!*\n\n` +
        `📂 *Kategori:* *${recordData.category}*\n` +
        extraDetails +
        `📄 *Nama File:* \`${recordData.name}\`\n` +
        `⚖️ *Ukuran:* ${recordData.size}\n` +
        `👤 *Pengunggah:* \`${recordData.uploader}\`\n` +
        `📊 *Status:* ⏳ *Pending Review*` +
        progressNote + `\n` +
        `✨ *Data dan foto otomatis masuk ke folder kategori ${recordData.category} di Web Dashboard.*`;

    let buttons;
    if (recordData.baseLabel) {
        buttons = buildPhotoTypeMenu(recordData.category, recordData.baseLabel, recordData.completedTypes || []);
    } else {
        buttons = Markup.inlineKeyboard([
            [
                Markup.button.callback('📤 Upload Evident Lain', 'action_open_upload'),
                Markup.button.callback('📊 Cek Status', 'action_open_status')
            ]
        ]);
    }

    await ctx.reply(successMsg, { parse_mode: 'Markdown', ...buttons });
    return true;
}

// ==========================================================
// 4. FLOW ODC
// ==========================================================
async function startOdcFlow(ctx, prefilledLabel = null, specificType = null) {
    const chatId = ctx.chat.id.toString();
    const auth = await verifyUserAccess(chatId);
    if (!auth.allowed) {
        return sendUnregisteredNotice(ctx, chatId);
    }

    const session = getSession(chatId);
    session.category = 'ODC';

    if (prefilledLabel) {
        const check = analyzeOdcLabel(prefilledLabel);
        session.deviceLabel = check.valid ? check.formatted : prefilledLabel;
        session.completedTypes = [];

        if (specificType) {
            session.photoType = specificType;
            session.step = 'waiting_photo';
            return ctx.reply(
                `📦 *INPUT EVIDENT ODC (${specificType})*\n\n` +
                `🏷 *Label ODC:* \`${session.deviceLabel}\`\n` +
                `📷 *Jenis Foto:* *${specificType}*\n\n` +
                `📸 *Silakan kirimkan FOTO ${specificType} sekarang!*\n` +
                `⚡ Script otomatis memeriksa ketajaman dan anti-duplikat.`,
                { parse_mode: 'Markdown' }
            );
        }

        session.step = 'waiting_photo_type';
        session.photoType = null;
        return ctx.reply(
            `📦 *EVIDENT ODC:* \`${session.deviceLabel}\`\n\n` +
            `📸 *Silakan pilih jenis foto yang ingin Anda upload:*\n` +
            `1️⃣ 🚪 *Tampak Luar:* Foto pintu/fisik luar ODC tertutup\n` +
            `2️⃣ 📦 *Tampak Dalam:* Foto bagian dalam baki/tray/splitter\n` +
            `3️⃣ 📟 *Foto Redaman:* Layar ukur OPM (-dBm)\n` +
            `4️⃣ 🏷 *Foto Label:* Stiker label perangkat ODC\n\n` +
            `👉 *Klik salah satu tombol jenis foto di bawah:*`,
            {
                parse_mode: 'Markdown',
                ...buildPhotoTypeMenu('ODC', session.deviceLabel)
            }
        );
    }

    session.step = 'waiting_label';
    session.deviceLabel = null;
    session.photoType = specificType || null;
    session.pendingPhoto = null;

    const extraHint = specificType ? ` untuk upload **Foto ${specificType}**` : '';
    await ctx.reply(
        `📦 *INPUT DATA EVIDENT ODC (Optical Distribution Cabinet)*${extraHint}\n\n` +
        `⚠️ *Aturan SOP:* ODC adalah induk jaringan dan wajib diinput terlebih dahulu sebelum ODP.\n\n` +
        `👉 *Ketikkan Nama / Label ODC Anda sekarang:*\n` +
        `📌 *Format Wajib:* \`ODC-(WILAYAH) (NO_ODC)\`\n` +
        `💡 *Contoh Benar:* \`ODC-SKD 01\`, \`ODC-SKD 001\`, \`ODC-WNJ 01\`, \`ODC-CHSN 01\`\n\n` +
        `_(Ketik /batal jika ingin membatalkan)_`,
        { parse_mode: 'Markdown' }
    );
}

// ==========================================================
// 5. FLOW ODP
// ==========================================================
async function startOdpFlow(ctx, prefilledLabel = null, specificType = null) {
    const chatId = ctx.chat.id.toString();
    const auth = await verifyUserAccess(chatId);
    if (!auth.allowed) {
        return sendUnregisteredNotice(ctx, chatId);
    }

    const session = getSession(chatId);
    session.category = 'ODP';

    if (prefilledLabel) {
        const check = analyzeOdpLabel(prefilledLabel);
        if (check.valid) {
            const odcExists = await checkOdcExists(check.expectedOdc, check.expectedOdcAlt);
            if (!odcExists) {
                return ctx.reply(
                    `🚫 *INPUT DITOLAK SCRIPT: ODC INDUK BELUM TERDAFTAR!*\n\n` +
                    `🏷 *Label ODP:* \`${check.formattedOdp}\`\n` +
                    `🔍 *Acuan ODC Induk:* \`${check.expectedOdc}\`\n\n` +
                    `❌ Perangkat ODC \`${check.expectedOdc}\` belum terdaftar di database!\n` +
                    `Wilayah ODP wajib lurus dengan ODC induk yang sudah terdaftar. Anda harus menginput ODC tersebut terlebih dahulu sebelum menginput ODP ini.`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback(`📦 Input ODC: ${check.expectedOdc} Dulu`, `action_direct_odc:${encodeURIComponent(check.expectedOdc)}`)],
                            [Markup.button.callback('✏️ Edit Label ODP', 'action_edit_label')],
                            [Markup.button.callback('❌ Batal', 'action_cancel')]
                        ])
                    }
                );
            }

            session.deviceLabel = check.formattedOdp;
            session.odcReference = check.expectedOdc;
            session.completedTypes = [];

            if (specificType) {
                session.photoType = specificType;
                session.step = 'waiting_photo';
                return ctx.reply(
                    `🛜 *INPUT EVIDENT ODP (${specificType})*\n\n` +
                    `🏷 *Label ODP:* \`${session.deviceLabel}\`\n` +
                    `🔗 *Induk ODC:* \`${session.odcReference}\`\n` +
                    `📷 *Jenis Foto:* *${specificType}*\n\n` +
                    `📸 *Silakan kirimkan FOTO ${specificType} sekarang!*\n` +
                    `⚡ Script otomatis memeriksa ketajaman dan anti-duplikat.`,
                    { parse_mode: 'Markdown' }
                );
            }

            session.step = 'waiting_photo_type';
            session.photoType = null;
            return ctx.reply(
                `🛜 *EVIDENT ODP:* \`${session.deviceLabel}\`\n` +
                `🔗 *Induk ODC:* \`${session.odcReference}\`\n\n` +
                `📸 *Silakan pilih jenis foto yang ingin Anda upload:*\n` +
                `1️⃣ 🚪 *Tampak Luar:* Foto fisik box luar ODP tertutup\n` +
                `2️⃣ 📦 *Tampak Dalam:* Foto bagian dalam baki/tray/konektor\n` +
                `3️⃣ 📟 *Foto Redaman:* Layar ukur OPM (-dBm)\n` +
                `4️⃣ 🏷 *Foto Label:* Stiker label perangkat ODP\n\n` +
                `👉 *Klik salah satu tombol jenis foto di bawah:*`,
                {
                    parse_mode: 'Markdown',
                    ...buildPhotoTypeMenu('ODP', session.deviceLabel)
                }
            );
        }
    }

    session.step = 'waiting_label';
    session.deviceLabel = null;
    session.odcReference = null;
    session.photoType = specificType || null;
    session.pendingPhoto = null;

    const extraHint = specificType ? ` untuk upload **Foto ${specificType}**` : '';
    await ctx.reply(
        `🛜 *INPUT DATA EVIDENT ODP (Optical Distribution Point)*${extraHint}\n\n` +
        `⚠️ *ATURAN PENAMAAN & VALIDASI:*\n` +
        `1. Wilayah & No ODC pada ODP **WAJIB LURUS** dengan ODC induknya!\n` +
        `2. ODC induk **WAJIB SUDAH TERDAFTAR DI DATABASE**. ODP tidak bisa diinput jika ODC belum ada!\n\n` +
        `👉 *Ketikkan Nama / Label ODP Anda sekarang:*\n` +
        `📌 *Format Wajib:* \`ODP-(WILAYAH) (NO_ODC)/(NO_ODP)\`\n` +
        `💡 *Contoh Benar:* \`ODP-SKD 01/01\`, \`ODP-SKD 001/001\`, \`ODP-WNJ 01/01\`\n\n` +
        `_(Ketik /batal jika ingin membatalkan)_`,
        { parse_mode: 'Markdown' }
    );
}

// ==========================================================
// 6. FLOW TIANG & MODEM
// ==========================================================
async function startTiangFlow(ctx) {
    const chatId = ctx.chat.id.toString();
    const auth = await verifyUserAccess(chatId);
    if (!auth.allowed) {
        return sendUnregisteredNotice(ctx, chatId);
    }

    const session = getSession(chatId);
    session.category = 'TIANG';
    session.step = 'waiting_photo';
    session.deviceLabel = null;
    session.pendingPhoto = null;

    await ctx.reply(
        `🪵 *INPUT DATA EVIDENT TIANG (Global)*\n\n` +
        `⚠️ *Syarat Wajib:* Tiang bersifat global dan **HARUS ada Foto dan Tagging Lokasi GPS**.\n\n` +
        `📸 *Langkah 1: Silakan kirimkan FOTO EVIDENT TIANG sekarang:*\n` +
        `_(Boleh sertakan nomor tiang di caption foto)_\n\n` +
        `_(Ketik /batal untuk membatalkan)_`,
        { parse_mode: 'Markdown' }
    );
}

async function startModemFlow(ctx, initialOdpText = null) {
    const chatId = ctx.chat.id.toString();
    const auth = await verifyUserAccess(chatId);
    if (!auth.allowed) {
        return sendUnregisteredNotice(ctx, chatId);
    }

    const session = getSession(chatId);
    session.category = 'MODEM';
    session.deviceLabel = null;
    session.odpReference = null;
    session.odcReference = null;
    session.customerId = null;
    session.customerName = null;
    session.modemSn = null;
    session.photoType = null;
    session.pendingPhoto = null;
    session.completedTypes = [];

    if (initialOdpText) {
        return handleModemOdpInput(ctx, initialOdpText);
    }

    session.step = 'waiting_modem_odp';

    await ctx.reply(
        `💻 *INPUT DATA EVIDENT MODEM PELANGGAN*\n\n` +
        `👉 *Langkah 1/6: Silakan masukkan LABEL ODP tempat modem tersambung:*\n` +
        `📌 *Format Wajib:* \`ODP-(WILAYAH) (NO_ODC)/(NO_ODP)\`\n` +
        `💡 *Contoh Penulisan:*\n` +
        `• \`ODP-SKD 01/01\`\n` +
        `• \`ODP-SKD 01/08\`\n` +
        `• \`ODP-WNJ 01/01\`\n\n` +
        `_(Ketik /batal untuk membatalkan)_`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('❌ Batal', 'action_cancel')]
            ])
        }
    );
}

async function handleModemOdpInput(ctx, text) {
    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId);

    const check = analyzeOdpLabel(text);
    if (!check.valid) {
        return ctx.reply(
            `❌ *FORMAT PENAMAAN LABEL ODP TIDAK SESUAI / SALAH!*\n\n` +
            `Label yang Anda masukkan: \`${text}\`\n` +
            `Format yang Benar: \`${check.suggestion}\`\n\n` +
            `📌 *Alasan Script:* ${check.reason}\n\n` +
            `💡 *Contoh Penulisan Benar:*\n` +
            `• ODP-SKD 01/01\n` +
            `• ODP-SKD 01/08\n` +
            `• ODP-WNJ 01/01\n\n` +
            `👉 *Silakan klik tombol Edit Label di bawah untuk memperbaiki:*`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✏️ Edit Label ODP', 'action_edit_label')],
                    [Markup.button.callback('❌ Batal', 'action_cancel')]
                ])
            }
        );
    }

    const expectedOdc = check.expectedOdc;
    await ctx.reply(`🔍 *Memeriksa keberadaan ODC induk:* \`${expectedOdc}\` di database...`, { parse_mode: 'Markdown' });

    const odcExists = await checkOdcExists(expectedOdc, check.expectedOdcAlt);
    if (!odcExists) {
        clearSession(chatId);
        return ctx.reply(
            `🚫 *INPUT MODEM DITOLAK: ODC INDUK BELUM TERDAFTAR!*\n\n` +
            `🏷 *Label ODP Acuan:* \`${check.formattedOdp}\`\n` +
            `🔍 *Acuan ODC Induk:* \`${expectedOdc}\`\n\n` +
            `❌ *PERINGATAN:* Perangkat ODC \`${expectedOdc}\` belum terdaftar di database!\n\n` +
            `⚠️ Sesuai SOP, evident Modem harus terhubung ke ODP yang memiliki ODC induk terdaftar. Anda **HARUS menginput data dan foto ODC tersebut terlebih dahulu**.\n\n` +
            `👇 *Silakan klik tombol di bawah untuk menginput ODC sekarang:*`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback(`📦 Input ODC: ${expectedOdc} Dulu`, `action_direct_odc:${encodeURIComponent(expectedOdc)}`)],
                    [Markup.button.callback('✏️ Edit Label ODP', 'action_edit_label')],
                    [Markup.button.callback('❌ Batal', 'action_cancel')]
                ])
            }
        );
    }

    session.category = 'MODEM';
    session.odpReference = check.formattedOdp;
    session.odcReference = expectedOdc;
    session.step = 'waiting_modem_customer_id';

    return ctx.reply(
        `✅ *Label ODP Terverifikasi:* \`${check.formattedOdp}\`\n` +
        `🔗 *Induk ODC:* \`${expectedOdc}\` (Aktif di database)\n\n` +
        `👉 *Langkah 2/6: Silakan masukkan ID PELANGGAN:*\n` +
        `💡 *Contoh Penulisan:* \`ID-100293\` atau \`1029384\`\n\n` +
        `_(Ketik /batal untuk membatalkan)_`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✏️ Ganti Label ODP', 'action_edit_label')],
                [Markup.button.callback('❌ Batal', 'action_cancel')]
            ])
        }
    );
}

// ==========================================================
// 6.5 MIDDLEWARE OTOMATIS: VALIDASI PENDAFTARAN OLEH OWNER
// ==========================================================
bot.use(async (ctx, next) => {
    if (!ctx.chat || !ctx.chat.id) return next();
    const chatId = ctx.chat.id.toString();

    // Izinkan perintah registrasi admin (/register) agar Owner dapat mendaftarkan teknisi baru
    const text = (ctx.message && ctx.message.text) ? ctx.message.text.trim() : '';
    if (text.startsWith('/register')) {
        return next();
    }

    // Cek apakah ID Telegram sudah didaftarkan oleh Owner di tabel access_list
    const auth = await verifyUserAccess(chatId);
    if (!auth.allowed) {
        if (ctx.callbackQuery) {
            try {
                await ctx.answerCbQuery('⚠️ ID Telegram Anda belum didaftarkan oleh Owner!', { show_alert: true });
            } catch (e) {}
        }
        return sendUnregisteredNotice(ctx, chatId);
    }

    return next();
});

// ==========================================================
// 7. COMMANDS TELEGRAM
// ==========================================================
bot.start(async (ctx) => {
    const chatId = ctx.chat.id.toString();

    await ctx.reply(
        `👋 *Selamat datang di Bot Evident PT MAHAWIRA NUSANTARA GRUP!*\n\n` +
        `🆔 *ID Telegram Anda:* \`${chatId}\`\n\n` +
        `📋 *SOP & Format Penamaan:* \n` +
        `• **ODC:** \`ODC-(WILAYAH) (NO_ODC)\` $\\rightarrow$ Contoh: \`ODC-SKD 01\` (Wajib Awal)\n` +
        `• **ODP:** \`ODP-(WILAYAH) (NO_ODC)/(NO_ODP)\` $\\rightarrow$ Contoh: \`ODP-SKD 01/01\` (Wajib Lurus ke ODC)\n` +
        `• **TIANG:** Bersifat global dan **wajib Tagging Lokasi GPS**.\n\n` +
        `⚡ *Pemeriksaan Kualitas Foto:* Script otomatis menolak foto jika buram / tidak jelas.\n\n` +
        `👇 *SILAKAN PILIH MENU DI BAWAH INI:*`,
        {
            parse_mode: 'Markdown',
            ...buildMainInlineMenu()
        }
    );

    await ctx.reply(
        `💡 _Tombol cepat juga tersedia di papan bawah layar Anda._`,
        buildPersistentKeyboard()
    );
});

bot.help(async (ctx) => {
    const chatId = ctx.chat.id.toString();
    await ctx.reply(
        `💡 *PANDUAN LENGKAP & ATURAN PENAMAAN FORMAT:*\n\n` +
        `🆔 ID Telegram Anda: \`${chatId}\`\n\n` +
        `📦 *1. Penamaan ODC (Induk Jaringan):*\n` +
        `• Format: \`ODC-(WILAYAH) (NO_ODC)\`\n` +
        `• Contoh Benar: \`ODC-SKD 01\`, \`ODC-WNJ 01\`, \`ODC-CHSN 01\`\n` +
        `• ❌ Format Salah: \`ODC/CHSN 01\` atau \`ODC_CHSN_01\` (Otomatis ditolak script!)\n\n` +
        `🛜 *2. Penamaan ODP (Turunan ODC):*\n` +
        `• Format: \`ODP-(WILAYAH) (NO_ODC)/(NO_ODP)\`\n` +
        `• Contoh Benar: \`ODP-SKD 01/01\`, \`ODP-WNJ 01/01\`\n` +
        `• **ATURAN LURUS:** Wilayah ODP wajib sama persis dengan ODC induk yang sudah terdaftar.\n` +
        `• Jika ODC belum terdaftar di database, ODP **DITOLAK OTOMATIS**!\n\n` +
        `🪵 *3. Tiang (Global):*\n` +
        `• Wajib Foto dan Tagging Lokasi GPS.\n\n` +
        `📸 *Pemeriksaan Foto:* Script secara otomatis menolak foto yang buram, gelap, atau pecah.`,
        {
            parse_mode: 'Markdown',
            ...buildMainInlineMenu()
        }
    );
});

bot.command('upload', async (ctx) => {
    await ctx.reply(
        `📤 *PILIH KATEGORI EVIDENT UNTUK DIUPLOAD:*\n\n` +
        `SOP Evident PT Mahawira Nusantara Grup:\n` +
        `1. **ODC:** Wajib diinput awal sebagai induk jaringan.\n` +
        `2. **ODP:** Wajib lurus dengan ODC induk yang sudah terdaftar di database.\n` +
        `3. **TIANG:** Bersifat global & wajib tagging lokasi GPS.\n` +
        `4. **MODEM:** Input foto dan data SN modem pelanggan.\n\n` +
        `👇 *Silakan pilih menu kategori di bawah:*`,
        {
            parse_mode: 'Markdown',
            ...buildMainInlineMenu()
        }
    );
});

bot.command('odc', (ctx) => startOdcFlow(ctx));
bot.command('odp', (ctx) => startOdpFlow(ctx));
bot.command('tiang', (ctx) => startTiangFlow(ctx));
bot.command('modem', (ctx) => startModemFlow(ctx));

bot.hears(['📦 ODC', 'ODC', 'odc'], (ctx) => startOdcFlow(ctx));
bot.hears(['🛜 ODP', 'ODP', 'odp'], (ctx) => startOdpFlow(ctx));
bot.hears(['🪵 TIANG', 'TIANG', 'tiang'], (ctx) => startTiangFlow(ctx));
bot.hears(['💻 MODEM', 'MODEM', 'modem'], (ctx) => startModemFlow(ctx));
bot.hears(['📊 Status Evident', '📊 Status', 'Status', 'status'], (ctx) => showStatus(ctx, ctx.chat.id.toString()));
bot.hears(['❌ Batalkan Sesi', 'Batal', 'batal', 'cancel'], (ctx) => {
    clearSession(ctx.chat.id.toString());
    ctx.reply("👌 Sesi telah dibatalkan. Silakan pilih menu:", buildMainInlineMenu());
});

bot.action('start_odc', async (ctx) => {
    await ctx.answerCbQuery();
    await startOdcFlow(ctx);
});

bot.action('start_odp', async (ctx) => {
    await ctx.answerCbQuery();
    await startOdpFlow(ctx);
});

bot.action('start_tiang', async (ctx) => {
    await ctx.answerCbQuery();
    await startTiangFlow(ctx);
});

bot.action('start_modem', async (ctx) => {
    await ctx.answerCbQuery();
    await startModemFlow(ctx);
});

bot.action('action_open_upload', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("📤 *Pilih Kategori Evident:*", { parse_mode: 'Markdown', ...buildMainInlineMenu() });
});

bot.action('action_open_status', async (ctx) => {
    await ctx.answerCbQuery();
    await showStatus(ctx, ctx.chat.id.toString());
});

bot.action('action_open_help', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Silakan ketik /help untuk membaca panduan lengkap.");
});

bot.action(/action_direct_odc:(.+)/, async (ctx) => {
    const odcLabel = decodeURIComponent(ctx.match[1]);
    await ctx.answerCbQuery(`Menyiapkan input ${odcLabel}`);
    await startOdcFlow(ctx, odcLabel);
});

// Aksi Edit Label jika format salah
bot.action('action_edit_label', async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId);

    const cat = session.category || 'ODC';
    let example = 'ODC-SKD 01';
    let hint = '';

    if (cat === 'ODP') {
        example = 'ODP-SKD 01/01';
        hint = `📌 Format wajib: \`ODP-(WILAYAH) (NO_ODC)/(NO_ODP)\``;
    } else if (cat === 'MODEM') {
        example = 'ODP-SKD 01/01';
        hint = `📌 Masukkan Label ODP tempat modem tersambung:\n\`ODP-(WILAYAH) (NO_ODC)/(NO_ODP)\``;
        session.step = 'waiting_modem_odp';
    } else {
        hint = `📌 Format wajib: \`ODC-(WILAYAH) (NOMOR)\``;
        session.step = 'waiting_edit_label';
    }

    if (cat !== 'MODEM') {
        session.step = 'waiting_edit_label';
    }

    await ctx.reply(
        `✏️ *EDIT LABEL PERANGKAT (${cat})*\n\n` +
        `Silakan ketikkan penamaan label yang benar sesuai standar sistem:\n` +
        `${hint}\n` +
        `💡 *Contoh Penulisan yang Benar:* \`${example}\`\n\n` +
        `_(Ketik /batal jika ingin membatalkan)_`,
        { parse_mode: 'Markdown' }
    );
});

// Aksi Edit ID Pelanggan
bot.action('action_edit_customer_id', async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId);
    session.step = 'waiting_modem_customer_id';
    await ctx.reply(
        `✏️ *GANTI ID PELANGGAN*\n\n` +
        `Silakan masukkan ID Pelanggan yang benar:\n` +
        `💡 *Contoh:* \`ID-100293\` atau \`1029384\`\n\n` +
        `_(Ketik /batal jika ingin membatalkan)_`,
        { parse_mode: 'Markdown' }
    );
});

// Aksi Edit Nama Pelanggan
bot.action('action_edit_customer_name', async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId);
    session.step = 'waiting_modem_customer_name';
    await ctx.reply(
        `✏️ *GANTI NAMA PELANGGAN*\n\n` +
        `Silakan masukkan Nama Pelanggan yang benar:\n` +
        `💡 *Contoh:* \`Bpk. Bambang Pamungkas\` atau \`Ibu Siti Aminah\`\n\n` +
        `_(Ketik /batal jika ingin membatalkan)_`,
        { parse_mode: 'Markdown' }
    );
});

// Aksi Edit SN Modem
bot.action('action_edit_modem_sn', async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId);
    session.step = 'waiting_modem_sn';
    await ctx.reply(
        `✏️ *GANTI SERIAL NUMBER (SN) MODEM*\n\n` +
        `Silakan masukkan Serial Number (SN) Modem yang benar:\n` +
        `💡 *Contoh:* \`ZTEGC12345678\` atau \`FHTT1234ABCD\`\n\n` +
        `_(Ketik /batal jika ingin membatalkan)_`,
        { parse_mode: 'Markdown' }
    );
});

// Aksi Upload Ulang dari Notifikasi Penolakan Dashboard
bot.action(/reupload_(.+)_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const cat = ctx.match[1];
    const rawLabel = decodeURIComponent(ctx.match[2]);
    const label = rawLabel !== 'none' ? rawLabel : null;

    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId);
    session.category = cat;
    session.deviceLabel = label;
    session.step = 'waiting_photo';

    await ctx.reply(
        `🔄 *UPLOAD ULANG EVIDENT PERBAIKAN (${cat})*\n\n` +
        (label ? `🏷 *Label:* \`${label}\`\n\n` : '') +
        `📸 Silakan kirimkan FOTO PERBAIKAN yang jelas, terang, dan fokus sekarang:\n` +
        `_(Gunakan kamera 📷 atau galeri 📎 di bawah)_\n` +
        `⚡ Script akan otomatis menolak foto jika buram.`,
        { parse_mode: 'Markdown' }
    );
});

bot.action('action_register_self', async (ctx) => {
    await ctx.answerCbQuery('Pendaftaran hanya oleh Admin');
    const chatId = ctx.chat.id.toString();
    return sendUnregisteredNotice(ctx, chatId);
});

bot.action('action_cancel', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    clearSession(chatId);
    await ctx.answerCbQuery('Dibatalkan');
    try {
        await ctx.editMessageText('❌ Sesi input telah dibatalkan. Silakan pilih menu baru kapan saja.');
    } catch (e) {
        await ctx.reply('❌ Sesi input telah dibatalkan.');
    }
});

// ===== TAMBAHAN BARU: Handler tombol ✅ SELESAI per perangkat ODC/ODP =====
bot.action('action_finish_device', async (ctx) => {
    await ctx.answerCbQuery('✅ Sesi perangkat ditutup');
    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId);

    const label = session.deviceLabel || '-';
    const cat = session.category || '-';
    const done = (session.completedTypes || []).length;

    clearSession(chatId);

    const finishText =
        `✅ *SELESAI INPUT EVIDENT ${cat}*\n\n` +
        `🏷 *Label Perangkat:* \`${label}\`\n` +
        `📸 *Jenis Foto Terupload:* *${done} / 4*\n\n` +
        `✨ Semua data sudah tersimpan di Dashboard EvidentVault.\n\n` +
        `Silakan pilih menu untuk input perangkat berikutnya:`;

    const finishButtons = Markup.inlineKeyboard([
        [
            Markup.button.callback('📦 Input ODC Baru', 'start_odc'),
            Markup.button.callback('🛜 Input ODP Baru', 'start_odp')
        ],
        [
            Markup.button.callback('📊 Cek Status', 'action_open_status'),
            Markup.button.callback('📤 Upload Lain', 'action_open_upload')
        ]
    ]);

    try {
        await ctx.editMessageText(finishText, { parse_mode: 'Markdown', ...finishButtons });
    } catch (e) {
        await ctx.reply(finishText, { parse_mode: 'Markdown', ...finishButtons });
    }
    await ctx.reply("💡 Menu cepat tetap tersedia di bawah layar.", buildPersistentKeyboard());
});

bot.command(['done', 'selesai'], async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId);

    const label = session.deviceLabel || '-';
    const cat = session.category || '-';
    const done = (session.completedTypes || []).length;

    clearSession(chatId);

    const finishText =
        `🏁 *SELESAI INPUT EVIDENT ${cat} (DONE)*\n\n` +
        `🏷 *Label Perangkat:* \`${label}\`\n` +
        `📸 *Jenis Foto Terupload:* *${done} / 4*\n\n` +
        `✨ Semua data dan foto sudah tersimpan di Dashboard EvidentVault.\n\n` +
        `Silakan pilih menu untuk input perangkat berikutnya:`;

    const finishButtons = Markup.inlineKeyboard([
        [
            Markup.button.callback('📦 Input ODC Baru', 'start_odc'),
            Markup.button.callback('🛜 Input ODP Baru', 'start_odp')
        ],
        [
            Markup.button.callback('📊 Cek Status', 'action_open_status'),
            Markup.button.callback('📤 Upload Lain', 'action_open_upload')
        ]
    ]);

    await ctx.reply(finishText, { parse_mode: 'Markdown', ...finishButtons });
    await ctx.reply("💡 Menu cepat tetap tersedia di bawah layar.", buildPersistentKeyboard());
});

bot.command(['register', 'register_bulk'], async (ctx) => {
    const senderId = ctx.chat.id.toString();
    const isAdmin = await isTelegramAdmin(senderId);

    if (!isAdmin) {
        return ctx.reply(
            `⛔ *AKSES DITOLAK!*\n\n` +
            `Perintah pendaftaran hanya dapat dijalankan oleh *Admin / Pemilik Utama* (Owner: \`119509416\`).\n` +
            `ID Telegram Anda: \`${senderId}\`\n\n` +
            `Silakan hubungi Pemilik Utama untuk mendaftarkan ID Telegram Anda ke sistem.`,
            { parse_mode: 'Markdown' }
        );
    }

    const text = ctx.message.text.trim();

    // Cek apakah input berisi multi-baris atau format massal (bisa hingga 100 ID)
    const bulkItems = parseBulkTelegramInputs(text);

    if (bulkItems.length > 1) {
        return registerBulkTechnicians(ctx, bulkItems);
    }

    const args = text.split(/\s+/);
    if (args.length < 2) {
        return ctx.reply(
            `ℹ️ *CARA DAFTARKAN TEKNISI OLEH OWNER / ADMIN:*\n\n` +
            `1️⃣ *Daftar 1 Orang:*\n` +
            `\`/register <ID_TELEGRAM> [NAMA]\`\n` +
            `Contoh: \`/register 123456789 Budi Santoso\`\n\n` +
            `2️⃣ *Daftar Massal Sekaligus (Bisa Hingga 100 ID):*\n` +
            `Ketik \`/register_bulk\` diikuti daftar ID baris per baris:\n` +
            `\`\`\`\n` +
            `/register_bulk\n` +
            `119509416 - Owner Utama\n` +
            `123456789 - Budi Santoso\n` +
            `987654321 - Dani Pratama\n` +
            `\`\`\`\n` +
            `Atau cukup deretan ID: \`111111, 222222, 333333, 444444\``,
            { parse_mode: 'Markdown' }
        );
    }

    if (bulkItems.length === 1) {
        const item = bulkItems[0];
        return registerTechnicianByAdmin(ctx, item.id, item.name);
    }

    const targetId = args[1].trim();
    const technicianName = args.slice(2).join(' ').trim() || `Teknisi (${targetId})`;

    await registerTechnicianByAdmin(ctx, targetId, technicianName);
});

bot.command(['batal', 'cancel'], async (ctx) => {
    const chatId = ctx.chat.id.toString();
    clearSession(chatId);
    ctx.reply("👌 Sesi telah dibatalkan. Silakan pilih menu di bawah:", buildMainInlineMenu());
});

// ==========================================================
// 7.B ACTION & COMMAND UNTUK FOTO TAMPAK LUAR, DALAM, REDAMAN, LABEL
// ==========================================================

// Aksi Pemilihan Jenis Foto Evident (Tampak Luar, Dalam, Redaman, Label)
bot.action(/action_type:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const type = ctx.match[1];
    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId);

    if (!session.deviceLabel) {
        return ctx.reply("⚠️ Sesi telah berakhir atau label belum dimasukkan. Silakan pilih menu:", buildMainInlineMenu());
    }

    session.photoType = type;
    session.step = 'waiting_photo';

    let icon = '📸';
    let hint = '';
    if (type === 'TAMPAK LUAR') {
        icon = '🚪';
        hint = 'Pastikan pintu/box tertutup dan fisik perangkat terlihat utuh.';
    } else if (type === 'TAMPAK DALAM') {
        icon = '📦';
        hint = 'Pastikan baki, manajemen kabel, splitter, atau tray terlihat rapi dan jelas.';
    } else if (type === 'REDAMAN') {
        icon = '📟';
        hint = 'Pastikan angka hasil ukur di layar OPM (Optical Power Meter) terbaca jelas.';
    } else if (type === 'LABEL') {
        icon = '🏷';
        hint = 'Pastikan teks stiker label perangkat terbaca tajam dan tidak goyang.';
    }

    await ctx.reply(
        `${icon} *UPLOAD FOTO ${type} (${session.category || 'PERANGKAT'})*\n\n` +
        `🏷 *Label Perangkat:* \`${session.deviceLabel}\`\n` +
        `📷 *Jenis Foto:* *${type}*\n\n` +
        `📸 *Silakan ambil / kirimkan foto ${type} sekarang:*\n` +
        `💡 *Tips:* ${hint}\n` +
        `⚡ Script otomatis memeriksa ketajaman dan anti-duplikat.`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🔙 Pilih Jenis Foto Lain', 'action_back_types')],
                [Markup.button.callback('❌ Batal', 'action_cancel')]
            ])
        }
    );
});

bot.action('action_back_types', async (ctx) => {
    await ctx.answerCbQuery();
    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId);
    if (!session.deviceLabel) {
        return ctx.reply("Silakan pilih menu:", buildMainInlineMenu());
    }
    session.step = 'waiting_photo_type';
    session.photoType = null;
    await ctx.reply(
        `📸 *Pilih jenis foto untuk ${session.deviceLabel}:*`,
        {
            parse_mode: 'Markdown',
            ...buildPhotoTypeMenu(session.category || 'ODC', session.deviceLabel)
        }
    );
});

bot.action(/action_cmd_type:(.+):(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const cat = ctx.match[1];
    const type = ctx.match[2];
    if (cat === 'ODC') {
        await startOdcFlow(ctx, null, type);
    } else {
        await startOdpFlow(ctx, null, type);
    }
});

// Helper Handler Command Foto Evident
function handleDirectCategoryTypeCommand(ctx, category, photoType) {
    const text = ctx.message.text.trim();
    const parts = text.split(/\s+/);
    const labelArg = parts.length > 1 ? parts.slice(1).join(' ') : null;

    if (category === 'ODC') {
        return startOdcFlow(ctx, labelArg, photoType);
    } else {
        return startOdpFlow(ctx, labelArg, photoType);
    }
}

function handlePhotoTypeCommand(ctx, photoType) {
    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId);

    if (session.deviceLabel && (session.category === 'ODC' || session.category === 'ODP')) {
        session.photoType = photoType;
        session.step = 'waiting_photo';
        return ctx.reply(
            `📸 *UPLOAD FOTO ${photoType} (${session.category})*\n\n` +
            `🏷 *Perangkat:* \`${session.deviceLabel}\`\n\n` +
            `Silakan kirimkan foto **${photoType}** sekarang:`,
            { parse_mode: 'Markdown' }
        );
    }

    return ctx.reply(
        `📸 *UPLOAD FOTO ${photoType}*\n\n` +
        `Silakan pilih kategori perangkat untuk foto ${photoType}:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [
                    Markup.button.callback(`📦 ODC (${photoType})`, `action_cmd_type:ODC:${photoType}`),
                    Markup.button.callback(`🛜 ODP (${photoType})`, `action_cmd_type:ODP:${photoType}`)
                ],
                [Markup.button.callback('❌ Batal', 'action_cancel')]
            ])
        }
    );
}

// Command Upload Foto Khusus
bot.command(['tampak_luar', 'luar'], (ctx) => handlePhotoTypeCommand(ctx, 'TAMPAK LUAR'));
bot.command(['tampak_dalam', 'dalam'], (ctx) => handlePhotoTypeCommand(ctx, 'TAMPAK DALAM'));
bot.command(['redaman', 'opm', 'ukur'], (ctx) => handlePhotoTypeCommand(ctx, 'REDAMAN'));
bot.command(['label', 'stiker'], (ctx) => handlePhotoTypeCommand(ctx, 'LABEL'));

bot.command('odc_luar', (ctx) => handleDirectCategoryTypeCommand(ctx, 'ODC', 'TAMPAK LUAR'));
bot.command('odc_dalam', (ctx) => handleDirectCategoryTypeCommand(ctx, 'ODC', 'TAMPAK DALAM'));
bot.command('odc_redaman', (ctx) => handleDirectCategoryTypeCommand(ctx, 'ODC', 'REDAMAN'));
bot.command('odc_label', (ctx) => handleDirectCategoryTypeCommand(ctx, 'ODC', 'LABEL'));

bot.command('odp_luar', (ctx) => handleDirectCategoryTypeCommand(ctx, 'ODP', 'TAMPAK LUAR'));
bot.command('odp_dalam', (ctx) => handleDirectCategoryTypeCommand(ctx, 'ODP', 'TAMPAK DALAM'));
bot.command('odp_redaman', (ctx) => handleDirectCategoryTypeCommand(ctx, 'ODP', 'REDAMAN'));
bot.command('odp_label', (ctx) => handleDirectCategoryTypeCommand(ctx, 'ODP', 'LABEL'));

// ==========================================================
// 8. LISTENER TEKS (VALIDASI FORMAT LABEL ODC / ODP OLEH SCRIPT)
// ==========================================================
bot.on('text', async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return next();

    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId);

    // KASUS A-MODEM: Menunggu input Label ODP untuk Modem
    if (session.step === 'waiting_modem_odp' && session.category === 'MODEM') {
        return handleModemOdpInput(ctx, text);
    }

    // KASUS MODEM: Menunggu input ID Pelanggan
    if (session.step === 'waiting_modem_customer_id' && session.category === 'MODEM') {
        session.customerId = text.trim();
        session.step = 'waiting_modem_customer_name';
        return ctx.reply(
            `✅ *ID Pelanggan Tersimpan:* \`${session.customerId}\`\n\n` +
            `👉 *Langkah 3/6: Silakan masukkan NAMA PELANGGAN:*\n` +
            `💡 *Contoh Penulisan:* \`Bpk. Bambang Pamungkas\` atau \`Ibu Siti Aminah\`\n\n` +
            `_(Ketik /batal jika ingin membatalkan)_`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✏️ Ganti ID Pelanggan', 'action_edit_customer_id')],
                    [Markup.button.callback('❌ Batal', 'action_cancel')]
                ])
            }
        );
    }

    // KASUS MODEM: Menunggu input Nama Pelanggan
    if (session.step === 'waiting_modem_customer_name' && session.category === 'MODEM') {
        session.customerName = text.trim();
        session.step = 'waiting_modem_sn';
        return ctx.reply(
            `✅ *Nama Pelanggan Tersimpan:* \`${session.customerName}\`\n\n` +
            `👉 *Langkah 4/6: Silakan masukkan SERIAL NUMBER (SN) MODEM:*\n` +
            `💡 *Contoh Penulisan:* \`ZTEGC12345678\` atau \`FHTT1234ABCD\`\n\n` +
            `_(Ketik /batal jika ingin membatalkan)_`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✏️ Ganti Nama Pelanggan', 'action_edit_customer_name')],
                    [Markup.button.callback('❌ Batal', 'action_cancel')]
                ])
            }
        );
    }

    // KASUS MODEM: Menunggu input SN Modem
    if (session.step === 'waiting_modem_sn' && session.category === 'MODEM') {
        session.modemSn = text.trim().toUpperCase();
        session.photoType = 'TAMPAK DEPAN';
        session.step = 'waiting_photo';
        return ctx.reply(
            `✅ *DATA PELANGGAN & MODEM LENGKAP:*\n` +
            `• 🏷 *Label ODP:* \`${session.odpReference}\`\n` +
            `• 🔗 *Induk ODC:* \`${session.odcReference}\`\n` +
            `• 🆔 *ID Pelanggan:* \`${session.customerId}\`\n` +
            `• 👤 *Nama Pelanggan:* \`${session.customerName}\`\n` +
            `• 📟 *SN Modem:* \`${session.modemSn}\`\n\n` +
            `📸 *Langkah 5/6: Silakan kirimkan FOTO MODEM TAMPAK DEPAN!*\n` +
            `💡 _Pastikan fisik depan dan lampu indikator modem terlihat jelas._\n` +
            `⚡ Script otomatis memeriksa ketajaman dan anti-duplikat.`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('✏️ Ganti SN Modem', 'action_edit_modem_sn')],
                    [Markup.button.callback('❌ Batal', 'action_cancel')]
                ])
            }
        );
    }

    // KASUS A: Sedang mengedit label via tombol [Edit Label]
    if (session.step === 'waiting_edit_label') {
        const cat = session.category || 'ODC';

        if (cat === 'ODC') {
            const check = analyzeOdcLabel(text);
            if (!check.valid) {
                return ctx.reply(
                    `❌ *FORMAT PENAMAAN TIDAK SESUAI / SALAH!*\n\n` +
                    `Input Anda: \`${text}\`\n` +
                    `Format yang Benar: \`${check.suggestion}\`\n\n` +
                    `📌 *Alasan Script:* ${check.reason}\n\n` +
                    `💡 *Contoh Penulisan Benar:*\n` +
                    `• ODC-SKD 01\n` +
                    `• ODC-WNJ 01\n` +
                    `• ODC-CHSN 01\n\n` +
                    `👉 Silakan ketik label yang benar atau klik tombol di bawah:`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('✏️ Edit Label Lagi', 'action_edit_label')],
                            [Markup.button.callback('❌ Batal', 'action_cancel')]
                        ])
                    }
                );
            }

            session.deviceLabel = check.formatted;
            if (session.photoType) {
                session.step = 'waiting_photo';
                return ctx.reply(
                    `✅ *Label ODC Terkonfirmasi Benar:* \`${check.formatted}\`\n` +
                    `📷 *Jenis Foto:* *${session.photoType}*\n\n` +
                    `📸 *Silakan kirimkan FOTO ${session.photoType} sekarang!*\n` +
                    `⚡ Script otomatis memeriksa ketajaman dan anti-duplikat.`,
                    { parse_mode: 'Markdown' }
                );
            }

            session.step = 'waiting_photo_type';
            return ctx.reply(
                `✅ *Label ODC Terkonfirmasi Benar:* \`${check.formatted}\`\n\n` +
                `📸 *Silakan pilih jenis foto yang ingin Anda upload:*\n` +
                `1️⃣ 🚪 *Tampak Luar:* Pintu / fisik luar ODC tertutup\n` +
                `2️⃣ 📦 *Tampak Dalam:* Bagian dalam baki / tray / splitter\n` +
                `3️⃣ 📟 *Foto Redaman:* Layar ukur OPM (-dBm)\n` +
                `4️⃣ 🏷 *Foto Label:* Stiker label perangkat ODC\n\n` +
                `👉 *Klik salah satu tombol jenis foto di bawah:*`,
                {
                    parse_mode: 'Markdown',
                    ...buildPhotoTypeMenu('ODC', check.formatted)
                }
            );
        }

        if (cat === 'ODP') {
            const check = analyzeOdpLabel(text);
            if (!check.valid) {
                return ctx.reply(
                    `❌ *FORMAT PENAMAAN TIDAK SESUAI / SALAH!*\n\n` +
                    `Input Anda: \`${text}\`\n` +
                    `Format yang Benar: \`${check.suggestion}\`\n\n` +
                    `📌 *Alasan Script:* ${check.reason}\n\n` +
                    `💡 *Contoh Penulisan Benar:*\n` +
                    `• ODP-SKD 01/01\n` +
                    `• ODP-SKD 01/08\n` +
                    `• ODP-WNJ 01/01\n` +
                    `• ODP-CHSN 01/01\n\n` +
                    `👉 Silakan ketik label yang benar atau klik tombol di bawah:`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('✏️ Edit Label Lagi', 'action_edit_label')],
                            [Markup.button.callback('❌ Batal', 'action_cancel')]
                        ])
                    }
                );
            }

            // Validasi kelurusan wilayah ke ODC induk
            const odcExists = await checkOdcExists(check.expectedOdc, check.expectedOdcAlt);
            if (!odcExists) {
                return ctx.reply(
                    `🚫 *INPUT DITOLAK SCRIPT: ODC INDUK BELUM TERDAFTAR!*\n\n` +
                    `🏷 *Label ODP:* \`${check.formattedOdp}\`\n` +
                    `🔍 *Acuan ODC Induk:* \`${check.expectedOdc}\`\n\n` +
                    `❌ ODC \`${check.expectedOdc}\` belum terdaftar di database!\n` +
                    `Sesuai aturan sistem, penamaan wilayah ODP harus lurus dengan ODC induk yang sudah terdaftar. Anda wajib menginput ODC tersebut terlebih dahulu!`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback(`📦 Input ODC: ${check.expectedOdc} Dulu`, `action_direct_odc:${encodeURIComponent(check.expectedOdc)}`)],
                            [Markup.button.callback('✏️ Edit Label ODP', 'action_edit_label')],
                            [Markup.button.callback('❌ Batal', 'action_cancel')]
                        ])
                    }
                );
            }

            session.deviceLabel = check.formattedOdp;
            session.odcReference = check.expectedOdc;

            if (session.photoType) {
                session.step = 'waiting_photo';
                return ctx.reply(
                    `✅ *Label ODP Terkonfirmasi Benar:* \`${check.formattedOdp}\` (Induk: \`${check.expectedOdc}\`)\n` +
                    `📷 *Jenis Foto:* *${session.photoType}*\n\n` +
                    `📸 *Silakan kirimkan FOTO ${session.photoType} sekarang!*\n` +
                    `⚡ Script otomatis memeriksa ketajaman dan anti-duplikat.`,
                    { parse_mode: 'Markdown' }
                );
            }

            session.step = 'waiting_photo_type';
            return ctx.reply(
                `✅ *Label ODP Terkonfirmasi Benar:* \`${check.formattedOdp}\`\n` +
                `🔗 *Induk ODC:* \`${check.expectedOdc}\`\n\n` +
                `📸 *Silakan pilih jenis foto yang ingin Anda upload:*\n` +
                `1️⃣ 🚪 *Tampak Luar:* Box luar ODP tertutup\n` +
                `2️⃣ 📦 *Tampak Dalam:* Bagian dalam baki / tray / konektor\n` +
                `3️⃣ 📟 *Foto Redaman:* Layar ukur OPM (-dBm)\n` +
                `4️⃣ 🏷 *Foto Label:* Stiker label perangkat ODP\n\n` +
                `👉 *Klik salah satu tombol jenis foto di bawah:*`,
                {
                    parse_mode: 'Markdown',
                    ...buildPhotoTypeMenu('ODP', check.formattedOdp)
                }
            );
        }

        // Jika kategori MODEM dan mengedit label ODP
        if (cat === 'MODEM') {
            return handleModemOdpInput(ctx, text);
        }
    }

    // KASUS B: Menunggu input label ODC
    if (session.step === 'waiting_label' && session.category === 'ODC') {
        const check = analyzeOdcLabel(text);
        if (!check.valid) {
            return ctx.reply(
                `❌ *FORMAT PENAMAAN TIDAK SESUAI / SALAH!*\n\n` +
                `Label yang Anda masukkan: \`${text}\`\n` +
                `Format yang Benar: \`${check.suggestion}\`\n\n` +
                `📌 *Alasan Script:* ${check.reason}\n\n` +
                `💡 *Contoh Penulisan Benar:*\n` +
                `• ODC-SKD 01\n` +
                `• ODC-WNJ 01\n` +
                `• ODC-CHSN 01\n\n` +
                `👉 *Silakan klik tombol Edit Label di bawah untuk memperbaiki:*`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✏️ Edit Label', 'action_edit_label')],
                        [Markup.button.callback('❌ Batal', 'action_cancel')]
                    ])
                }
            );
        }

        session.deviceLabel = check.formatted;

        if (session.photoType) {
            session.step = 'waiting_photo';
            return ctx.reply(
                `✅ *Label ODC Terkonfirmasi:* \`${check.formatted}\`\n` +
                `📷 *Jenis Foto:* *${session.photoType}*\n\n` +
                `📸 *Silakan kirimkan FOTO ${session.photoType} ODC sekarang!*\n` +
                `⚡ Script otomatis memeriksa ketajaman dan anti-duplikat.`,
                { parse_mode: 'Markdown' }
            );
        }

        session.step = 'waiting_photo_type';
        return ctx.reply(
            `✅ *Label ODC Terkonfirmasi:* \`${check.formatted}\`\n\n` +
            `📸 *Silakan pilih jenis foto yang ingin Anda upload:*\n` +
            `1️⃣ 🚪 *Tampak Luar:* Pintu / fisik luar ODC tertutup\n` +
            `2️⃣ 📦 *Tampak Dalam:* Bagian dalam baki / tray / splitter\n` +
            `3️⃣ 📟 *Foto Redaman:* Layar ukur OPM (-dBm)\n` +
            `4️⃣ 🏷 *Foto Label:* Stiker label perangkat ODC\n\n` +
            `👉 *Klik salah satu tombol jenis foto di bawah:*`,
            {
                parse_mode: 'Markdown',
                ...buildPhotoTypeMenu('ODC', check.formatted)
            }
        );
    }

    // KASUS C: Menunggu input label ODP
    if (session.step === 'waiting_label' && session.category === 'ODP') {
        const check = analyzeOdpLabel(text);
        if (!check.valid) {
            return ctx.reply(
                `❌ *FORMAT PENAMAAN TIDAK SESUAI / SALAH!*\n\n` +
                `Label yang Anda masukkan: \`${text}\`\n` +
                `Format yang Benar: \`${check.suggestion}\`\n\n` +
                `📌 *Alasan Script:* ${check.reason}\n\n` +
                `💡 *Contoh Penulisan Benar:*\n` +
                `• ODP-SKD 01/01\n` +
                `• ODP-SKD 01/08\n` +
                `• ODP-WNJ 01/01\n` +
                `• ODP-CHSN 01/01\n\n` +
                `👉 *Silakan klik tombol Edit Label di bawah untuk memperbaiki:*`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✏️ Edit Label', 'action_edit_label')],
                        [Markup.button.callback('❌ Batal', 'action_cancel')]
                    ])
                }
            );
        }

        const expectedOdc = check.expectedOdc;
        await ctx.reply(`🔍 *Memeriksa keberadaan ODC induk:* \`${expectedOdc}\` di database...`, { parse_mode: 'Markdown' });

        const odcExists = await checkOdcExists(expectedOdc, check.expectedOdcAlt);

        if (!odcExists) {
            clearSession(chatId);
            return ctx.reply(
                `🚫 *INPUT ODP DITOLAK: ODC INDUK BELUM TERDAFTAR!*\n\n` +
                `🏷 *Label ODP:* \`${check.formattedOdp}\`\n` +
                `🔍 *Acuan ODC Induk:* \`${expectedOdc}\`\n\n` +
                `❌ *PERINGATAN:* Perangkat ODC \`${expectedOdc}\` belum terdaftar di database!\n\n` +
                `⚠️ Sesuai SOP, penamaan wilayah ODP harus lurus dengan ODC induk. Anda **HARUS menginput data dan foto ODC tersebut terlebih dahulu** sebelum ODP ini dapat diinput.\n\n` +
                `👇 *Silakan klik tombol di bawah untuk menginput ODC sekarang:*`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback(`📦 Input ODC: ${expectedOdc} Dulu`, `action_direct_odc:${encodeURIComponent(expectedOdc)}`)],
                        [Markup.button.callback('✏️ Edit Label ODP', 'action_edit_label')],
                        [Markup.button.callback('❌ Batal', 'action_cancel')]
                    ])
                }
            );
        }

        session.deviceLabel = check.formattedOdp;
        session.odcReference = expectedOdc;

        if (session.photoType) {
            session.step = 'waiting_photo';
            return ctx.reply(
                `✅ *ODC Induk Terverifikasi:* \`${expectedOdc}\` (Telah aktif di database)\n` +
                `🏷 *Label ODP:* \`${check.formattedOdp}\`\n` +
                `📷 *Jenis Foto:* *${session.photoType}*\n\n` +
                `📸 *Silakan kirimkan FOTO ${session.photoType} ODP sekarang!*\n` +
                `⚡ Script otomatis memeriksa ketajaman dan anti-duplikat.`,
                { parse_mode: 'Markdown' }
            );
        }

        session.step = 'waiting_photo_type';
        return ctx.reply(
            `✅ *ODC Induk Terverifikasi:* \`${expectedOdc}\` (Telah aktif di database)\n` +
            `🏷 *Label ODP:* \`${check.formattedOdp}\`\n\n` +
            `📸 *Silakan pilih jenis foto yang ingin Anda upload:*\n` +
            `1️⃣ 🚪 *Tampak Luar:* Box luar ODP tertutup\n` +
            `2️⃣ 📦 *Tampak Dalam:* Bagian dalam baki / tray / konektor\n` +
            `3️⃣ 📟 *Foto Redaman:* Layar ukur OPM (-dBm)\n` +
            `4️⃣ 🏷 *Foto Label:* Stiker label perangkat ODP\n\n` +
            `👉 *Klik salah satu tombol jenis foto di bawah:*`,
            {
                parse_mode: 'Markdown',
                ...buildPhotoTypeMenu('ODP', check.formattedOdp)
            }
        );
    }

    // KASUS D: Pengguna mengetik langsung tanpa menekan tombol menu terlebih dahulu
    // 1. Jika teks mengandung ODC (Contoh: ODC-SKD 01, ODC/SKD 01, SKD ODC 01)
    if (text.toUpperCase().includes('ODC')) {
        const check = analyzeOdcLabel(text);
        if (!check.valid) {
            return ctx.reply(
                `❌ *FORMAT PENAMAAN TIDAK SESUAI / SALAH!*\n\n` +
                `Input Anda: \`${text}\`\n` +
                `Format yang Benar: \`${check.suggestion}\`\n\n` +
                `📌 *Alasan Script:* ${check.reason}\n\n` +
                `💡 *Contoh Penulisan Benar:*\n` +
                `• ODC-SKD 01\n` +
                `• ODC-WNJ 01\n` +
                `• ODC-CHSN 01\n\n` +
                `👉 Silakan ketik ulang label yang benar atau klik tombol di bawah:`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✏️ Edit Label', 'action_edit_label')],
                        [Markup.button.callback('❌ Batal', 'action_cancel')]
                    ])
                }
            );
        }

        session.category = 'ODC';
        session.deviceLabel = check.formatted;
        session.photoType = null;
        session.step = 'waiting_photo_type';

        return ctx.reply(
            `✅ *Label ODC Terkonfirmasi:* \`${check.formatted}\`\n\n` +
            `📸 *Silakan pilih jenis foto yang ingin Anda upload:*\n` +
            `1️⃣ 🚪 *Tampak Luar:* Pintu / fisik luar ODC tertutup\n` +
            `2️⃣ 📦 *Tampak Dalam:* Bagian dalam baki / tray / splitter\n` +
            `3️⃣ 📟 *Foto Redaman:* Layar ukur OPM (-dBm)\n` +
            `4️⃣ 🏷 *Foto Label:* Stiker label perangkat ODC\n\n` +
            `👉 *Klik salah satu tombol jenis foto di bawah:*`,
            {
                parse_mode: 'Markdown',
                ...buildPhotoTypeMenu('ODC', check.formatted)
            }
        );
    }

    // 2. Jika teks mengandung ODP (Contoh: ODP-SKD 01/01, SKD ODP GRB 01/08, ODP/SKD 01/01)
    if (text.toUpperCase().includes('ODP')) {
        const check = analyzeOdpLabel(text);
        if (!check.valid) {
            return ctx.reply(
                `❌ *FORMAT PENAMAAN TIDAK SESUAI / SALAH!*\n\n` +
                `Input Anda: \`${text}\`\n` +
                `Format yang Benar: \`${check.suggestion}\`\n\n` +
                `📌 *Alasan Script:* ${check.reason}\n\n` +
                `💡 *Contoh Penulisan Benar:*\n` +
                `• ODP-SKD 01/01\n` +
                `• ODP-SKD 01/08\n` +
                `• ODP-WNJ 01/01\n` +
                `• ODP-CHSN 01/01\n\n` +
                `👉 Silakan ketik ulang label yang benar atau klik tombol di bawah:`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('✏️ Edit Label', 'action_edit_label')],
                        [Markup.button.callback('❌ Batal', 'action_cancel')]
                    ])
                }
            );
        }

        const expectedOdc = check.expectedOdc;
        const odcExists = await checkOdcExists(expectedOdc, check.expectedOdcAlt);

        if (!odcExists) {
            clearSession(chatId);
            return ctx.reply(
                `🚫 *INPUT ODP DITOLAK: ODC INDUK BELUM TERDAFTAR!*\n\n` +
                `🏷 *Label ODP:* \`${check.formattedOdp}\`\n` +
                `🔍 *Acuan ODC Induk:* \`${expectedOdc}\`\n\n` +
                `❌ *PERINGATAN:* Perangkat ODC \`${expectedOdc}\` belum terdaftar di database!\n\n` +
                `⚠️ Sesuai SOP, penamaan wilayah ODP harus lurus dengan ODC induk. Anda **HARUS menginput data dan foto ODC tersebut terlebih dahulu** sebelum ODP ini dapat diinput.\n\n` +
                `👇 *Silakan klik tombol di bawah untuk menginput ODC sekarang:*`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback(`📦 Input ODC: ${expectedOdc} Dulu`, `action_direct_odc:${encodeURIComponent(expectedOdc)}`)],
                        [Markup.button.callback('✏️ Edit Label ODP', 'action_edit_label')],
                        [Markup.button.callback('❌ Batal', 'action_cancel')]
                    ])
                }
            );
        }

        session.category = 'ODP';
        session.deviceLabel = check.formattedOdp;
        session.odcReference = expectedOdc;
        session.photoType = null;
        session.step = 'waiting_photo_type';

        return ctx.reply(
            `✅ *ODC Induk Terverifikasi:* \`${expectedOdc}\` (Telah aktif di database)\n` +
            `🏷 *Label ODP:* \`${check.formattedOdp}\`\n\n` +
            `📸 *Silakan pilih jenis foto yang ingin Anda upload:*\n` +
            `1️⃣ 🚪 *Tampak Luar:* Box luar ODP tertutup\n` +
            `2️⃣ 📦 *Tampak Dalam:* Bagian dalam baki / tray / konektor\n` +
            `3️⃣ 📟 *Foto Redaman:* Layar ukur OPM (-dBm)\n` +
            `4️⃣ 🏷 *Foto Label:* Stiker label perangkat ODP\n\n` +
            `👉 *Klik salah satu tombol jenis foto di bawah:*`,
            {
                parse_mode: 'Markdown',
                ...buildPhotoTypeMenu('ODP', check.formattedOdp)
            }
        );
    }

    // 3. Jika teks mengandung kata MODEM
    if (text.toUpperCase().includes('MODEM')) {
        return startModemFlow(ctx);
    }

    return ctx.reply(
        `Silakan pilih menu kategori evident yang ingin Anda input:`,
        buildMainInlineMenu()
    );
});

// ==========================================================
// 9. LISTENER LOKASI (GPS UNTUK TIANG)
// ==========================================================
bot.on('location', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const session = getSession(chatId);

    if (session.category !== 'TIANG' || session.step !== 'waiting_location' || !session.pendingPhoto) {
        return ctx.reply("ℹ️ Lokasi diterima, namun Anda tidak sedang dalam proses input Tiang. Silakan pilih menu:", buildMainInlineMenu());
    }

    const loc = ctx.message.location;
    const lat = loc.latitude;
    const lng = loc.longitude;
    const mapsUrl = `https://maps.google.com/?q=${lat},${lng}`;

    await ctx.reply(`📍 *Titik Lokasi GPS Tiang Diterima:* \`${lat}, ${lng}\`\n⏳ *Sedang memeriksa radius jarak tiang...*`, { parse_mode: 'Markdown' });

    // Validasi Radius Max 30 Meter Antar Tiang (SOP Anti Tagging Kembar)
    const proximity = await checkTiangProximity(lat, lng);
    if (!proximity.allowed) {
        const tiang = proximity.existingTiang;
        const dist = proximity.distance;
        const distStr = dist < 1 ? '0 meter (Titik Koordinat Sama Persis)' : `${dist.toFixed(1)} meter`;

        return ctx.reply(
            `🚫 *LOKASI TIANG DITOLAK: TITIK KOORDINAT TERLALU DEKAT / DALAM RADIUS TIANG LAIN!*\n\n` +
            `⚠️ *Hasil Pengecekan GPS Sistem:*\n` +
            `Titik koordinat yang Anda kirimkan berada dalam **radius ${distStr}** dari tiang yang sudah terdaftar sebelumnya.\n` +
            `*(SOP: Batas minimal jarak antar tiang wajib > 30 meter)*\n\n` +
            `📍 *Tiang Terdekat Yang Terdeteksi:*\n` +
            `• 🏷 *Label Tiang:* \`${tiang.device_label || tiang.name}\`\n` +
            `• 📍 *Koordinat Tiang:* \`${tiang.latitude}, ${tiang.longitude}\`\n` +
            `• 📏 *Jarak:* *${distStr}* (Ditolak karena $\\le$ 30 meter)\n` +
            `• 👤 *Pengunggah:* \`${tiang.uploader}\`\n` +
            `• 📅 *Waktu Upload:* ${tiang.date}\n\n` +
            `📏 *SOP PT MAHAWIRA NUSANTARA GRUP:*\n` +
            `Setiap tiang wajib berada di lokasi berbeda. Dilarang menandai titik koordinat tiang (titik A dan titik B) yang berada di radius $\\le$ 30 meter.\n\n` +
            `👉 *Silakan geser/ambil ulang titik koordinat GPS tiang yang benar di lokasi tiang baru!*`,
            {
                parse_mode: 'Markdown',
                ...Markup.keyboard([
                    [Markup.button.locationRequest('📍 Kirim Ulang Lokasi GPS Tiang')],
                    ['❌ Batalkan Sesi']
                ]).resize()
            }
        );
    }

    const photoData = session.pendingPhoto;
    const sender = ctx.from || {};
    const senderName = [sender.first_name, sender.last_name].filter(Boolean).join(' ') || (sender.username ? '@' + sender.username : '');
    const uploaderTag = senderName ? `${senderName} (ID: ${chatId})` : `Telegram ID: ${chatId}`;

    await saveEvidentToDatabase(ctx, {
        name: photoData.fileName,
        size: photoData.fileSize,
        category: 'TIANG',
        deviceLabel: photoData.caption || `TIANG-${lat.toFixed(5)}_${lng.toFixed(5)}`,
        odcReference: null,
        latitude: lat,
        longitude: lng,
        locationUrl: mapsUrl,
        uploader: uploaderTag,
        fileUrl: photoData.fileUrl,
        fileBuffer: photoData.fileBuffer,
        mimeType: photoData.mimeType,
        sha256: photoData.sha256,
        dhash: photoData.dhash
    });

    clearSession(chatId);
    await ctx.reply("Menu siap digunakan kembali:", buildPersistentKeyboard());
});

// ==========================================================
// 10. LISTENER FOTO (SCRIPT MEMERIKSA KUALITAS & MENYIMPAN OTOMATIS)
// ==========================================================
bot.on(['photo', 'document'], async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const auth = await verifyUserAccess(chatId);

    if (!auth.allowed) {
        return sendUnregisteredNotice(ctx, chatId);
    }

    const session = getSession(chatId);
    const caption = ctx.message.caption ? ctx.message.caption.trim() : '';
    const sender = ctx.from || {};
    const senderName = [sender.first_name, sender.last_name].filter(Boolean).join(' ') || (sender.username ? '@' + sender.username : '');
    const uploaderTag = senderName ? `${senderName} (ID: ${chatId})` : `Telegram ID: ${chatId}`;

    let fileId, fileName, fileSize = '1.5 MB', mimeType = 'image/jpeg';
    let highestPhotoObj = null;

    if (ctx.message.photo) {
        const photos = ctx.message.photo;
        highestPhotoObj = photos[photos.length - 1];
        fileId = highestPhotoObj.file_id;
        if (highestPhotoObj.file_size) {
            fileSize = (highestPhotoObj.file_size / (1024 * 1024)).toFixed(2) + ' MB';
        }
        fileName = `evident_${Date.now()}.jpg`;
    } else {
        fileId = ctx.message.document.file_id;
        if (ctx.message.document.file_size) {
            fileSize = (ctx.message.document.file_size / (1024 * 1024)).toFixed(2) + ' MB';
        }
        fileName = ctx.message.document.file_name || `evident_${Date.now()}`;
        mimeType = ctx.message.document.mime_type || 'application/octet-stream';
        highestPhotoObj = { width: 1280, height: 720, file_size: ctx.message.document.file_size };
    }

    await ctx.reply("⏳ *Script sedang menganalisis berkas, ketajaman, dan duplikasi foto...*", { parse_mode: 'Markdown' });

    let fileUrl = '';
    let fileBuffer = null;
    try {
        const fileLinkObj = await ctx.telegram.getFileLink(fileId);
        fileUrl = fileLinkObj.href;
        try {
            fileBuffer = await downloadFileBuffer(fileUrl);
        } catch (bufErr) {
            console.warn("Buffer notice:", bufErr.message);
        }
    } catch (err) {
        console.error("Gagal mengambil file Telegram:", err);
        return ctx.reply("❌ Gagal memproses file Telegram.");
    }

    if (!fileBuffer || fileBuffer.length === 0) {
        return ctx.reply(
            `❌ *GAGAL MENGUNDUH FOTO DARI SERVER TELEGRAM!*\n\n` +
            `Script wajib memeriksa ketajaman berkas foto asli sebelum dapat disimpan ke database.\n` +
            `👉 *Silakan kirim ulang foto Anda.*`,
            { parse_mode: 'Markdown' }
        );
    }

    // ==========================================================
    // 1. PEMERIKSAAN KUALITAS FOTO OLEH SCRIPT (JELAS VS BURAM)
    // ==========================================================
    const qualityCheck = validatePhotoClarity(highestPhotoObj, fileBuffer);
    if (!qualityCheck.valid) {
        // SCRIPT OTOMATIS MENOLAK FOTO KARENA KURANG JELAS / BURAM!
        return ctx.reply(
            `❌ *FOTO DITOLAK OLEH SCRIPT: FOTO KURANG JELAS / BURAM!*\n\n` +
            `⚠️ *Hasil Pemeriksaan Script:*\n` +
            `• ${qualityCheck.reason}\n\n` +
            `📸 *SOP:* Stiker label perangkat dan fisik harus terlihat tajam, terang, dan tidak goyang/blur.\n\n` +
            `👉 *Silakan ambil FOTO ULANG dengan kamera yang lebih jelas, terang, dan fokus:*`,
            { parse_mode: 'Markdown' }
        );
    }

    // ==========================================================
    // 2. PEMERIKSAAN DUPLIKAT FOTO OLEH SCRIPT (SHA256 & PERCEPTUAL dHash)
    // ==========================================================
    const decodedImg = qualityCheck.decoded || decodeImageToGray(fileBuffer);
    const sha256Hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const dHash = computeDHash(decodedImg);

    const dupCheck = checkDuplicateEvident(sha256Hash, dHash);
    if (dupCheck.isDuplicate) {
        // SCRIPT OTOMATIS MENOLAK FOTO KARENA DUPLICATE / IDENTIK!
        const match = dupCheck.matchRecord;
        return ctx.reply(
            `🚫 *FOTO DITOLAK OLEH SCRIPT: TERDETEKSI DUPLICATE / IDENTIK!*\n\n` +
            `⚠️ *Hasil Analisis Sistem:*\n` +
            `Foto yang Anda kirimkan terdeteksi **SUDAH PERNAH DI-UPLOAD SEBELUMNYA** (${dupCheck.type}).\n` +
            `Sistem melarang keras foto yang sama atau identik dengan yang sudah terdaftar sebelumnya.\n\n` +
            `📋 *Data Foto Asli di Sistem:*\n` +
            `• 👤 *Pengunggah Pertama:* \`${match.uploader || '-'}\`\n` +
            `• 📅 *Waktu Upload:* ${match.date || '-'}\n` +
            `• 📂 *Kategori:* *${match.category || '-'}*\n` +
            `• 🏷 *Label Perangkat:* \`${match.deviceLabel || '-'}\`\n` +
            `• 📄 *Nama Berkas:* \`${match.fileName || '-'}\`\n\n` +
            `📸 *SOP PT MAHAWIRA NUSANTARA GRUP:*\n` +
            `Setiap evident (Tiang, ODC, ODP, Modem) WAJIB difoto secara langsung (real-time) di lokasi fisik masing-masing. Dilarang mengunggah ulang foto identik milik siapapun.\n\n` +
            `👉 *Silakan ambil FOTO BARU yang asli langsung di depan fisik perangkat/tiang!*`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📤 Upload Menu', 'action_open_upload')],
                    [Markup.button.callback('❌ Batalkan Sesi', 'action_cancel')]
                ])
            }
        );
    }

    // ==========================================================
    // FAST TRACK JIKA TEKNISI MENGISI CAPTION PADA FOTO
    // ==========================================================
    if (!session.category && caption) {
        const detectedType = detectPhotoType(caption);
        const cleanedCaption = cleanCaptionForLabel(caption);
        const targetCaption = cleanedCaption || caption;

        // Cek caption MODEM
        if (targetCaption.toUpperCase().includes('MODEM')) {
            return ctx.reply(
                `💻 *ALUR INPUT EVIDENT MODEM PELANGGAN*\n\n` +
                `Sesuai SOP, evident Modem membutuhkan penginputan data lengkap secara terpisah:\n` +
                `1️⃣ Label ODP tempat tersambung (lurus ke ODC)\n` +
                `2️⃣ ID Pelanggan\n` +
                `3️⃣ Nama Pelanggan\n` +
                `4️⃣ Serial Number (SN) Modem\n` +
                `5️⃣ Foto Modem Tampak Depan\n` +
                `6️⃣ Foto Modem Tampak Belakang (SN Jelas & Terbaca)\n\n` +
                `👉 *Silakan klik tombol di bawah untuk memulai alur Modem:*`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('💻 Mulai Input Modem', 'start_modem')],
                        [Markup.button.callback('❌ Batal', 'action_cancel')]
                    ])
                }
            );
        }

        // Cek caption ODC (bisa diawali ODC atau kata ODC di dalamnya)
        if (targetCaption.toUpperCase().includes('ODC')) {
            const odcCheck = analyzeOdcLabel(targetCaption);
            if (odcCheck.valid) {
                const photoType = detectedType || 'TAMPAK LUAR';
                const baseLabel = odcCheck.formatted;
                const fullDeviceLabel = `${baseLabel} [${photoType}]`;

                await ctx.reply(`✅ *Script: Foto jelas & Label ODC terverifikasi:* \`${baseLabel}\` (${photoType})`, { parse_mode: 'Markdown' });
                if (!session.completedTypes) session.completedTypes = [];
                if (!session.completedTypes.includes(photoType)) session.completedTypes.push(photoType);

                await saveEvidentToDatabase(ctx, {
                    name: `evident_${baseLabel.replace(/\s+/g, '_')}_[${photoType.replace(/\s+/g, '_')}]_[H:${sha256Hash.substring(0, 16)}][DH:${dHash || 'none'}]_${Date.now()}.jpg`,
                    size: fileSize,
                    category: baseLabel,
                    deviceLabel: fullDeviceLabel,
                    baseLabel: baseLabel,
                    photoType: photoType,
                    odcReference: baseLabel,
                    uploader: uploaderTag,
                    fileUrl: fileUrl,
                    fileBuffer: fileBuffer,
                    mimeType: mimeType,
                    sha256: sha256Hash,
                    dhash: dHash,
                    completedTypes: session.completedTypes
                });

                // Tetap simpan deviceLabel agar teknisi bisa langsung memilih jenis foto berikutnya
                session.category = 'ODC';
                session.deviceLabel = baseLabel;
                session.odcReference = baseLabel;
                session.photoType = null;
                session.step = 'waiting_photo_type';
                return;
            } else if (odcCheck.needsEdit) {
                return ctx.reply(
                    `❌ *FORMAT PENAMAAN PADA CAPTION SALAH!*\n\n` +
                    `Input Caption: \`${caption}\`\n` +
                    `Format yang Benar: \`${odcCheck.suggestion}\`\n\n` +
                    `📌 *Alasan Script:* ${odcCheck.reason}\n\n` +
                    `👉 *Silakan klik tombol Edit Label di bawah untuk memperbaiki:*`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('✏️ Edit Label', 'action_edit_label')],
                            [Markup.button.callback('❌ Batal', 'action_cancel')]
                        ])
                    }
                );
            }
        }

        // Cek caption ODP (bisa diawali ODP atau ada kata ODP di dalamnya, e.g. SKD ODP GRB 01/08)
        if (targetCaption.toUpperCase().includes('ODP')) {
            const odpCheck = analyzeOdpLabel(targetCaption);
            if (odpCheck.valid) {
                // Cek kelurusan wilayah ke ODC Induk
                const odcExists = await checkOdcExists(odpCheck.expectedOdc, odpCheck.expectedOdcAlt);
                if (!odcExists) {
                    return ctx.reply(
                        `🚫 *INPUT DITOLAK SCRIPT: ODC INDUK BELUM TERDAFTAR!*\n\n` +
                        `🏷 *Label ODP:* \`${odpCheck.formattedOdp}\`\n` +
                        `🔍 *Acuan ODC Induk:* \`${odpCheck.expectedOdc}\`\n\n` +
                        `❌ Perangkat ODC \`${odpCheck.expectedOdc}\` belum terdaftar di database!\n` +
                        `Wilayah ODP wajib lurus dengan ODC induk yang sudah terdaftar. Anda harus menginput ODC tersebut terlebih dahulu sebelum menginput ODP ini.`,
                        {
                            parse_mode: 'Markdown',
                            ...Markup.inlineKeyboard([
                                [Markup.button.callback(`📦 Input ODC: ${odpCheck.expectedOdc} Dulu`, `action_direct_odc:${encodeURIComponent(odpCheck.expectedOdc)}`)],
                                [Markup.button.callback('✏️ Edit Label ODP', 'action_edit_label')],
                                [Markup.button.callback('❌ Batal', 'action_cancel')]
                            ])
                        }
                    );
                }

                const photoType = detectedType || 'TAMPAK LUAR';
                const baseLabel = odpCheck.formattedOdp;
                const fullDeviceLabel = `${baseLabel} [${photoType}]`;
                const parentOdc = odpCheck.expectedOdc;

                await ctx.reply(`✅ *Script: Foto jelas & ODP lurus dengan ODC:* \`${baseLabel}\` (${photoType})`, { parse_mode: 'Markdown' });
                if (!session.completedTypes) session.completedTypes = [];
                if (!session.completedTypes.includes(photoType)) session.completedTypes.push(photoType);

                await saveEvidentToDatabase(ctx, {
                    name: `evident_${baseLabel.replace(/[\s\/]+/g, '_')}_[${photoType.replace(/\s+/g, '_')}]_[H:${sha256Hash.substring(0, 16)}][DH:${dHash || 'none'}]_${Date.now()}.jpg`,
                    size: fileSize,
                    category: parentOdc,
                    deviceLabel: fullDeviceLabel,
                    baseLabel: baseLabel,
                    photoType: photoType,
                    odcReference: parentOdc,
                    uploader: uploaderTag,
                    fileUrl: fileUrl,
                    fileBuffer: fileBuffer,
                    mimeType: mimeType,
                    sha256: sha256Hash,
                    dhash: dHash,
                    completedTypes: session.completedTypes
                });

                // Siapkan sesi untuk upload jenis foto ODP berikutnya
                session.category = 'ODP';
                session.deviceLabel = baseLabel;
                session.odcReference = parentOdc;
                session.photoType = null;
                session.step = 'waiting_photo_type';
                return;
            } else if (odpCheck.needsEdit) {
                return ctx.reply(
                    `❌ *FORMAT PENAMAAN PADA CAPTION SALAH!*\n\n` +
                    `Input Caption: \`${caption}\`\n` +
                    `Format yang Benar: \`${odpCheck.suggestion}\`\n\n` +
                    `📌 *Alasan Script:* ${odpCheck.reason}\n\n` +
                    `👉 *Silakan klik tombol Edit Label di bawah untuk memperbaiki:*`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('✏️ Edit Label', 'action_edit_label')],
                            [Markup.button.callback('❌ Batal', 'action_cancel')]
                        ])
                    }
                );
            }
        }
    }

    // ==========================================================
    // ALUR STEP-BY-STEP (FOTO LOLOS KUALITAS & ANTI-DUPLIKAT -> LANGSUNG SIMPAN OTOMATIS)
    // ==========================================================

    // 1. Kategori ODC
    if (session.category === 'ODC') {
        if (!session.deviceLabel) {
            return ctx.reply("⚠️ Harap masukkan label ODC terlebih dahulu. Format: `ODC-(WILAYAH) (NOMOR)`", { parse_mode: 'Markdown' });
        }

        const baseLabel = session.deviceLabel;
        const photoType = session.photoType || detectPhotoType(caption) || 'TAMPAK LUAR';
        const fullDeviceLabel = `${baseLabel} [${photoType}]`;

        if (!session.completedTypes) session.completedTypes = [];
        if (!session.completedTypes.includes(photoType)) session.completedTypes.push(photoType);

        await saveEvidentToDatabase(ctx, {
            name: `evident_${baseLabel.replace(/\s+/g, '_')}_[${photoType.replace(/\s+/g, '_')}]_[H:${sha256Hash.substring(0, 16)}][DH:${dHash || 'none'}]_${Date.now()}.jpg`,
            size: fileSize,
            category: baseLabel,
            deviceLabel: fullDeviceLabel,
            baseLabel: baseLabel,
            photoType: photoType,
            odcReference: baseLabel,
            uploader: uploaderTag,
            fileUrl: fileUrl,
            fileBuffer: fileBuffer,
            mimeType: mimeType,
            sha256: sha256Hash,
            dhash: dHash,
            completedTypes: session.completedTypes
        });

        // Tetap simpan deviceLabel agar teknisi bisa langsung memilih jenis foto berikutnya
        session.deviceLabel = baseLabel;
        session.photoType = null;
        session.step = 'waiting_photo_type';
        return;
    }

    // 2. Kategori ODP
    if (session.category === 'ODP') {
        if (!session.deviceLabel) {
            return ctx.reply("⚠️ Harap masukkan label ODP terlebih dahulu. Format: `ODP-(WILAYAH) (NO_ODC)/(NO_ODP)`", { parse_mode: 'Markdown' });
        }

        const baseLabel = session.deviceLabel;
        const photoType = session.photoType || detectPhotoType(caption) || 'TAMPAK LUAR';
        const fullDeviceLabel = `${baseLabel} [${photoType}]`;
        const parentOdc = session.odcReference || 'ODP';

        if (!session.completedTypes) session.completedTypes = [];
        if (!session.completedTypes.includes(photoType)) session.completedTypes.push(photoType);

        await saveEvidentToDatabase(ctx, {
            name: `evident_${baseLabel.replace(/[\s\/]+/g, '_')}_[${photoType.replace(/\s+/g, '_')}]_[H:${sha256Hash.substring(0, 16)}][DH:${dHash || 'none'}]_${Date.now()}.jpg`,
            size: fileSize,
            category: parentOdc,
            deviceLabel: fullDeviceLabel,
            baseLabel: baseLabel,
            photoType: photoType,
            odcReference: parentOdc,
            uploader: uploaderTag,
            fileUrl: fileUrl,
            fileBuffer: fileBuffer,
            mimeType: mimeType,
            sha256: sha256Hash,
            dhash: dHash,
            completedTypes: session.completedTypes
        });

        // Tetap simpan deviceLabel agar teknisi bisa langsung memilih jenis foto berikutnya
        session.deviceLabel = baseLabel;
        session.photoType = null;
        session.step = 'waiting_photo_type';
        return;
    }

    // 3. Kategori TIANG (Foto lolos -> Wajib lanjut Tagging Lokasi GPS)
    if (session.category === 'TIANG') {
        session.pendingPhoto = {
            fileName: caption ? `evident_tiang_${caption.slice(0, 15).replace(/[^a-zA-Z0-9_-]/g, '_')}_[H:${sha256Hash.substring(0, 16)}][DH:${dHash || 'none'}]_${Date.now()}.jpg` : `evident_tiang_[H:${sha256Hash.substring(0, 16)}][DH:${dHash || 'none'}]_${Date.now()}.jpg`,
            fileSize: fileSize,
            fileUrl: fileUrl,
            fileBuffer: fileBuffer,
            mimeType: mimeType,
            caption: caption || 'TIANG',
            sha256: sha256Hash,
            dhash: dHash
        };
        session.step = 'waiting_location';

        return ctx.reply(
            `📍 *LANGKAH 2: WAJIB TAGGING LOKASI TIANG (GPS)*\n\n` +
            `✅ Foto tiang lolos pemeriksaan script (Jelas & Asli/Bukan Duplikat)!\n\n` +
            `⚠️ *Aturan SOP Tagging GPS Tiang:*\n` +
            `• Koordinat tiang wajib berjarak **LEBIH DARI 30 METER** dari tiang yang sudah terdaftar.\n` +
            `• Jika titik koordinat berada di dalam radius $\\le$ 30 meter dari tiang lain, sistem akan otomatis menolak.\n\n` +
            `👉 *Sekarang silakan kirimkan Lokasi GPS Tiang:*\n` +
            `Tekan tombol **📍 Kirim Lokasi Tiang Sekarang** di papan bawah layar Anda.\n` +
            `_(Atau tekan klip 📎 -> pilih Location / Lokasi -> Kirim Lokasi Saat Ini)_`,
            {
                parse_mode: 'Markdown',
                ...Markup.keyboard([
                    [Markup.button.locationRequest('📍 Kirim Lokasi Tiang Sekarang')],
                    ['❌ Batalkan Sesi']
                ]).resize()
            }
        );
    }

    // 4. Kategori MODEM — wajib ada ODP reference, ID, Nama, SN dan masuk ke folder ODC di dashboard
    if (session.category === 'MODEM') {
        // Jika belum ada ODP reference (teknisi belum input label ODP), minta dulu
        if (!session.odpReference || !session.odcReference) {
            session.step = 'waiting_modem_odp';
            return ctx.reply(
                `⚠️ *INPUT MODEM MEMBUTUHKAN LABEL ODP!*\n\n` +
                `📌 Silakan ketikkan Label ODP tempat modem tersambung terlebih dahulu:\n` +
                `💡 *Format:* \`ODP-(WILAYAH) (NO_ODC)/(NO_ODP)\`\n` +
                `💡 *Contoh:* \`ODP-SKD 01/01\`\n\n` +
                `_(Ketik label ODP sekarang)_`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('❌ Batal', 'action_cancel')]
                    ])
                }
            );
        }

        // Cek ID Pelanggan
        if (!session.customerId) {
            session.step = 'waiting_modem_customer_id';
            return ctx.reply(
                `⚠️ *INPUT MODEM MEMBUTUHKAN ID PELANGGAN!*\n\n` +
                `👉 *Langkah 2/6: Silakan masukkan ID PELANGGAN:*\n` +
                `💡 *Contoh Penulisan:* \`ID-100293\` atau \`1029384\`\n\n` +
                `_(Ketik ID Pelanggan sekarang)_`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('❌ Batal', 'action_cancel')]
                    ])
                }
            );
        }

        // Cek Nama Pelanggan
        if (!session.customerName) {
            session.step = 'waiting_modem_customer_name';
            return ctx.reply(
                `⚠️ *INPUT MODEM MEMBUTUHKAN NAMA PELANGGAN!*\n\n` +
                `👉 *Langkah 3/6: Silakan masukkan NAMA PELANGGAN:*\n` +
                `💡 *Contoh Penulisan:* \`Bpk. Bambang Pamungkas\` atau \`Ibu Siti Aminah\`\n\n` +
                `_(Ketik Nama Pelanggan sekarang)_`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('❌ Batal', 'action_cancel')]
                    ])
                }
            );
        }

        // Cek SN Modem
        if (!session.modemSn) {
            session.step = 'waiting_modem_sn';
            return ctx.reply(
                `⚠️ *INPUT MODEM MEMBUTUHKAN SERIAL NUMBER (SN) MODEM!*\n\n` +
                `👉 *Langkah 4/6: Silakan masukkan SERIAL NUMBER (SN) MODEM:*\n` +
                `💡 *Contoh Penulisan:* \`ZTEGC12345678\` atau \`FHTT1234ABCD\`\n\n` +
                `_(Ketik SN Modem sekarang)_`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('❌ Batal', 'action_cancel')]
                    ])
                }
            );
        }

        const odpRef = session.odpReference;
        const odcCat = session.odcReference;
        const cId = session.customerId;
        const cName = session.customerName;
        const sn = session.modemSn;
        const currentPhotoType = session.photoType || 'TAMPAK DEPAN';

        if (currentPhotoType === 'TAMPAK DEPAN') {
            const modemLabel = `MODEM [${odpRef}] - ID: ${cId} | Nama: ${cName} | SN: ${sn} [TAMPAK DEPAN]`;
            const cleanId = cId.replace(/[^a-zA-Z0-9_-]/g, '');
            const cleanSn = sn.replace(/[^a-zA-Z0-9_-]/g, '');
            const modemFileName = `evident_modem_${odpRef.replace(/[\s\/]+/g, '_')}_ID_${cleanId}_SN_${cleanSn}_[DEPAN]_[H:${sha256Hash.substring(0, 16)}][DH:${dHash || 'none'}]_${Date.now()}.jpg`;

            await saveEvidentToDatabase(ctx, {
                name: modemFileName,
                size: fileSize,
                category: odcCat,              // ← Masuk ke folder ODC di dashboard!
                deviceLabel: modemLabel,
                photoType: 'TAMPAK DEPAN',
                customerId: cId,
                customerName: cName,
                modemSn: sn,
                odcReference: odcCat,
                uploader: uploaderTag,
                fileUrl: fileUrl,
                fileBuffer: fileBuffer,
                mimeType: mimeType,
                sha256: sha256Hash,
                dhash: dHash
            });

            // Lanjut ke foto 2: TAMPAK BELAKANG
            session.photoType = 'TAMPAK BELAKANG';
            session.step = 'waiting_photo';

            return ctx.reply(
                `✅ *FOTO 1/2 (TAMPAK DEPAN) BERHASIL TERSIMPAN!*\n\n` +
                `📸 *Langkah 6/6: SEKARANG KIRIMKAN FOTO MODEM TAMPAK BELAKANG:*\n\n` +
                `⚠️ *PERHATIAN PENTING (SOP):*\n` +
                `• Arahkan kamera ke **stiker bagian belakang modem**.\n` +
                `• **PASTIKAN TULISAN SERIAL NUMBER (SN: \`${sn}\`) TERLIHAT SANGAT JELAS DAN TERBACA!**\n` +
                `• Pastikan pencahayaan cukup dan tidak ada bayangan/silau yang menutupi nomor SN.\n` +
                `⚡ Script otomatis memeriksa ketajaman foto dan anti-duplikat.`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('❌ Batal', 'action_cancel')]
                    ])
                }
            );
        } else {
            // currentPhotoType === 'TAMPAK BELAKANG'
            const modemLabel = `MODEM [${odpRef}] - ID: ${cId} | Nama: ${cName} | SN: ${sn} [TAMPAK BELAKANG]`;
            const cleanId = cId.replace(/[^a-zA-Z0-9_-]/g, '');
            const cleanSn = sn.replace(/[^a-zA-Z0-9_-]/g, '');
            const modemFileName = `evident_modem_${odpRef.replace(/[\s\/]+/g, '_')}_ID_${cleanId}_SN_${cleanSn}_[BELAKANG]_[H:${sha256Hash.substring(0, 16)}][DH:${dHash || 'none'}]_${Date.now()}.jpg`;

            await saveEvidentToDatabase(ctx, {
                name: modemFileName,
                size: fileSize,
                category: odcCat,              // ← Masuk ke folder ODC di dashboard!
                deviceLabel: modemLabel,
                photoType: 'TAMPAK BELAKANG',
                customerId: cId,
                customerName: cName,
                modemSn: sn,
                odcReference: odcCat,
                uploader: uploaderTag,
                fileUrl: fileUrl,
                fileBuffer: fileBuffer,
                mimeType: mimeType,
                sha256: sha256Hash,
                dhash: dHash
            });

            await ctx.reply(
                `🎉 *UPLOAD EVIDENT MODEM SELESAI (2/2 FOTO LENGKAP)!*\n\n` +
                `📋 *Rincian Evident Pelanggan:*\n` +
                `• 🏷 *Label ODP:* \`${odpRef}\`\n` +
                `• 🔗 *Induk ODC:* \`${odcCat}\`\n` +
                `• 🆔 *ID Pelanggan:* \`${cId}\`\n` +
                `• 👤 *Nama Pelanggan:* \`${cName}\`\n` +
                `• 📟 *SN Modem:* \`${sn}\`\n` +
                `• 📷 *Foto 1:* Tampak Depan (Tersimpan)\n` +
                `• 📷 *Foto 2:* Tampak Belakang & SN Jelas (Tersimpan)\n\n` +
                `📂 *Kedua evident foto modem otomatis masuk ke folder \`${odcCat}\` di Web Dashboard.*\n\n` +
                `👇 *Pilih menu berikutnya:*`,
                {
                    parse_mode: 'Markdown',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('💻 Input Modem Lain', 'start_modem')],
                        [Markup.button.callback('📤 Upload Kategori Lain', 'action_open_upload')],
                        [Markup.button.callback('📊 Cek Status', 'action_open_status')]
                    ])
                }
            );
            clearSession(chatId);
            return;
        }
    }

    // Foto tanpa konteks
    await ctx.reply(
        `📥 *Foto evident diterima!*\n` +
        `Silakan pilih kategori perangkat untuk foto ini:`,
        {
            parse_mode: 'Markdown',
            ...buildMainInlineMenu()
        }
    );
});

// ==========================================================
// 11. STATUS COMMAND
// ==========================================================
async function showStatus(ctx, chatId) {
    const auth = await verifyUserAccess(chatId);

    if (!auth.allowed) {
        return sendUnregisteredNotice(ctx, chatId);
    }

    const { data: list, error } = await supabase
        .from('evidents')
        .select('id, category, status, device_label')
        .ilike('uploader', `%${chatId}%`);

    if (error) {
        return ctx.reply("❌ Gagal memuat status: " + error.message);
    }

    const total = list ? list.length : 0;
    const approved = list ? list.filter(item => item.status === 'Approved').length : 0;
    const pending = list ? list.filter(item => item.status === 'Pending Review').length : 0;
    const rejected = list ? list.filter(item => item.status === 'Rejected').length : 0;

    const odcCount = list ? list.filter(item => item.category === 'ODC').length : 0;
    const odpCount = list ? list.filter(item => item.category === 'ODP').length : 0;
    const tiangCount = list ? list.filter(item => item.category === 'TIANG').length : 0;
    const modemCount = list ? list.filter(item => item.category === 'MODEM').length : 0;

    await ctx.reply(
        `📊 *STATUS & REKAP EVIDENT ANDA*\n\n` +
        `🆔 *ID Telegram:* \`${chatId}\`\n` +
        `🛡 *Role:* ${(auth.user.role || 'editor').toUpperCase()}\n\n` +
        `📈 *Ringkasan Status:*\n` +
        `• 📁 Total Evident: *${total}*\n` +
        `• ✅ Disetujui (Approved): *${approved}*\n` +
        `• ⏳ Menunggu (Pending): *${pending}*\n` +
        `• ❌ Revisi/Ditolak: *${rejected}*\n\n` +
        `🏷 *Berdasarkan Kategori:*\n` +
        `• 📦 ODC: ${odcCount} unit\n` +
        `• 🛜 ODP: ${odpCount} unit\n` +
        `• 🪵 TIANG: ${tiangCount} unit\n` +
        `• 💻 MODEM: ${modemCount} unit`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([[Markup.button.callback('📤 Upload Evident Baru', 'action_open_upload')]])
        }
    );
}

bot.command('status', (ctx) => showStatus(ctx, ctx.chat.id.toString()));

// ==========================================================
// 12. DAFTARKAN MENU COMMAND TELEGRAM
// ==========================================================
bot.telegram.setMyCommands([
    { command: 'start', description: '🚀 Mulai Bot & Tampilkan Menu' },
    { command: 'upload', description: '📤 Upload Foto Evident' },
    { command: 'odc', description: '📦 1. Input Evident ODC (Wajib Awal)' },
    { command: 'odp', description: '🛜 2. Input Evident ODP (Validasi ODC)' },
    { command: 'tiang', description: '🪵 3. Input Evident Tiang (Wajib GPS)' },
    { command: 'modem', description: '💻 4. Input Evident Modem' },
    { command: 'tampak_luar', description: '🚪 Foto Tampak Luar (ODC/ODP)' },
    { command: 'tampak_dalam', description: '📦 Foto Tampak Dalam (Tray/Baki)' },
    { command: 'redaman', description: '📟 Foto Redaman (Layar OPM)' },
    { command: 'label', description: '🏷 Foto Label (Stiker Perangkat)' },
    { command: 'selesai', description: '🏁 Selesai / Done Upload Unit Evident' },
    { command: 'done', description: '🏁 Selesai / Done Upload Unit Evident' },
    { command: 'status', description: '📊 Cek Status & Rekap Evident' },
    { command: 'batal', description: '❌ Batalkan Sesi Input Aktif' },
    { command: 'register', description: '🔑 Daftarkan ID Telegram Anda' },
    { command: 'help', description: 'ℹ️ Panduan SOP & Format Input' }
], { scope: { type: 'default' } }).then(() => {
    console.log("✅ Menu Bot Commands berhasil didaftarkan ke Telegram!");
}).catch((err) => {
    console.warn("⚠️ Menu commands notice:", err.message);
});

// ==========================================================
// 13. JALANKAN BOT
// ==========================================================
bot.launch().then(async () => {
    console.log("=================================================");
    console.log("🤖 BOT TELEGRAM EVIDENTVAULT AKTIF");
    console.log("⚡ Script Quality Check: AKTIF (Script menentukan jelas/buram)");
    console.log("⚡ Format Validation & Edit Label: AKTIF");
    console.log("⚡ Validasi Kelurusan ODC -> ODP: AKTIF");
    console.log("⚡ Deteksi Otomatis Foto Duplicate: AKTIF (SHA-256 + Perceptual dHash)");
    console.log("⚡ Validasi Radius GPS Tiang: AKTIF (Wajib > 30m, tolak radius <= 30m)");
    console.log("=================================================");
    await syncHashesFromSupabase();
}).catch((err) => {
    console.error("Gagal meluncurkan bot:", err);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
