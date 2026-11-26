/**
 * ==============================================================================
 * BOT LOGISTIK & PENGELOLAAN MATERIAL - PT MAHAWIRA NUSANTARA GRUP
 * ==============================================================================
 * File: bot_material.js
 * Fungsi:
 * 1. 📦 Pengambilan Material (Outbound ke Lapangan/PSB/Maintenance)
 * 2. 🔄 Return Material Tidak Terpakai (Sisa Proyek/Kabel/Aksesoris)
 * 3. ♻️ Pengembalian Material Refurbish (Bekas Tarikan Pelanggan/Rusak/ONT)
 * 4. 📊 Cek Status Barang yang Dibawa Teknisi
 * 5. 🛡️ Penyimpanan Evident Foto Permanen ke Supabase Cloud Storage
 * ==============================================================================
 */

const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

// Load Konfigurasi
let APP_CONFIG;
try {
    APP_CONFIG = require('./config.js');
} catch (e) {
    console.error("❌ Gagal membaca config.js:", e.message);
    process.exit(1);
}

const SUPABASE_URL = APP_CONFIG.supabaseUrl;
const SUPABASE_ANON_KEY = APP_CONFIG.supabaseAnonKey;
const TELEGRAM_TOKEN = process.env.TELEGRAM_MATERIAL_BOT_TOKEN || APP_CONFIG.telegramMaterialBotToken || APP_CONFIG.telegramBotToken;

if (!TELEGRAM_TOKEN || TELEGRAM_TOKEN === "ISI_DENGAN_TOKEN_BOT_MATERIAL") {
    console.warn("⚠️ PERINGATAN: TELEGRAM_MATERIAL_BOT_TOKEN belum diset di config.js atau environment variable!");
    console.warn("👉 Silakan buat bot baru di @BotFather, lalu masukkan tokennya ke config.js atau variabel Railway.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const bot = new Telegraf(TELEGRAM_TOKEN);

// State Session Teknisi dalam memori
const userSessions = new Map();

function getSession(chatId) {
    if (!userSessions.has(chatId)) {
        userSessions.set(chatId, {
            step: null,
            transactionType: null, // 'OUT', 'RETURN_UNUSED', 'REFURBISH'
            materialName: null,
            quantity: 1,
            unit: 'pcs',
            serialNumber: null,
            condition: 'Bagus',
            projectTarget: null,
            notes: null,
            photoBuffer: null,
            photoUrl: null,
            fileName: null,
            uploader: null,
            chatId: chatId,
            latitude: null,
            longitude: null,
            locationUrl: null
        });
    }
    return userSessions.get(chatId);
}

function clearSession(chatId) {
    userSessions.delete(chatId);
}

// Keyboard Navigasi Menu Utama Material
function buildMaterialMenu() {
    return Markup.keyboard([
        ['📦 Ambil Material (Out)', '🔄 Return Material Sisa'],
        ['♻️ Kembalikan Refurbish', '📋 Cek Material Saya'],
        ['❓ Bantuan', '❌ Batalkan Sesi']
    ]).resize();
}

// Download file buffer dari URL Telegram
function downloadFileBuffer(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https') ? https : http;
        client.get(url, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to download file: HTTP ${res.statusCode}`));
            }
            const data = [];
            res.on('data', chunk => data.push(chunk));
            res.on('end', () => resolve(Buffer.concat(data)));
            res.on('error', reject);
        }).on('error', reject);
    });
}

// Upload permanen ke Supabase Storage (dengan sanitasi aman S3)
async function uploadMaterialEvident(fileName, fileBuffer, mimeType = 'image/jpeg') {
    try {
        const safeName = (fileName || `mat_${Date.now()}.jpg`).replace(/[^a-zA-Z0-9_.-]/g, '_');
        const filePath = `materials/${Date.now()}_${safeName}`;
        
        const { data, error } = await supabase.storage
            .from('evidents')
            .upload(filePath, fileBuffer, {
                contentType: mimeType,
                upsert: true
            });

        if (error) {
            console.error("Storage upload error:", error);
            // Fallback emergency upload
            const emergencyPath = `materials/emerg_${Date.now()}.jpg`;
            const { data: emData } = await supabase.storage
                .from('evidents')
                .upload(emergencyPath, fileBuffer, { contentType: 'image/jpeg', upsert: true });
            if (emData) {
                const { data: pUrl } = supabase.storage.from('evidents').getPublicUrl(emergencyPath);
                return pUrl ? pUrl.publicUrl : null;
            }
            return null;
        }

        if (data) {
            const { data: publicData } = supabase.storage
                .from('evidents')
                .getPublicUrl(filePath);
            if (publicData && publicData.publicUrl) {
                console.log(`✅ Evident material berhasil disimpan permanen: ${filePath}`);
                return publicData.publicUrl;
            }
        }
    } catch (e) {
        console.warn("Material storage notice:", e.message);
    }
    return null;
}

// Simpan transaksi ke Database Supabase
async function saveMaterialTransaction(session) {
    try {
        const record = {
            transaction_type: session.transactionType,
            material_name: session.materialName,
            quantity: parseInt(session.quantity, 10) || 1,
            unit: session.unit || 'pcs',
            serial_number: session.serialNumber || null,
            item_condition: session.condition || 'Bagus',
            project_target: session.projectTarget || null,
            notes: session.notes || null,
            file_url: session.photoUrl || null,
            uploader: session.uploader,
            telegram_chat_id: session.chatId.toString(),
            date: new Date().toLocaleString('id-ID'),
            latitude: session.latitude || null,
            longitude: session.longitude || null,
            location_url: session.locationUrl || null,
            status: 'Pending'
        };

        const { data, error } = await supabase
            .from('material_transactions')
            .insert([record])
            .select();

        if (error) {
            console.error("Error saving material transaction to DB:", error);
            return { ok: false, message: error.message };
        }
        return { ok: true, data: data ? data[0] : null };
    } catch (err) {
        console.error("Exception saving material transaction:", err);
        return { ok: false, message: err.message };
    }
}

// ==============================================================================
// COMMANDS & HANDLERS BOT TELEGRAM MATERIAL
// ==============================================================================

bot.command('start', async (ctx) => {
    const fromUser = ctx.from || {};
    const userName = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(' ') || fromUser.username || 'Teknisi';
    clearSession(ctx.chat.id);

    return ctx.reply(
        `👋 *SELAMAT DATANG DI BOT LOGISTIK MATERIAL*\n` +
        `🏢 *PT MAHAWIRA NUSANTARA GRUP*\n\n` +
        `Halo *${userName}*! Sistem ini digunakan untuk mencatat alur keluar masuk material secara teratur, transparan, dan terhubung langsung ke Web Dashboard.\n\n` +
        `📦 *PILIH MENU TRANSAKSI DI BAWAH:*\n` +
        `1. *Ambil Material:* Ambil barang dari gudang untuk proyek/lapangan\n` +
        `2. *Return Material Sisa:* Kembalikan sisa barang baru yang belum terpakai\n` +
        `3. *Kembalikan Refurbish:* Kembalikan perangkat/kabel bekas tarikan\n` +
        `4. *Cek Material Saya:* Lihat daftar material yang sedang Anda bawa\n\n` +
        `_Silakan tekan tombol menu di bawah untuk memulai._`,
        {
            parse_mode: 'Markdown',
            ...buildMaterialMenu()
        }
    );
});

bot.command('batal', (ctx) => {
    clearSession(ctx.chat.id);
    return ctx.reply(`❌ *Sesi transaksi material telah dibatalkan.*`, {
        parse_mode: 'Markdown',
        ...buildMaterialMenu()
    });
});

bot.hears('❌ Batalkan Sesi', (ctx) => {
    clearSession(ctx.chat.id);
    return ctx.reply(`❌ *Sesi transaksi material telah dibatalkan.*`, {
        parse_mode: 'Markdown',
        ...buildMaterialMenu()
    });
});

bot.hears('❓ Bantuan', (ctx) => {
    return ctx.reply(
        `📖 *PANDUAN PENGGUNAAN BOT MATERIAL:*\n\n` +
        `• *Ambil Material:* Catat setiap Anda mengambil barang di gudang. Masukkan nama barang, jumlah, dan keperluan perangkat/pelanggan.\n` +
        `• *Return Material Sisa:* Jika Anda mengambil 100m kabel tapi terpakai 60m, kembalikan sisa 40m melalui menu ini agar tidak menjadi tanggungan Anda.\n` +
        `• *Kembalikan Refurbish:* Untuk modem ONT, adaptor, atau aksesoris bekas tarikan pelanggan isolir/ganti perangkat. Masukkan Serial Number jika ada.\n` +
        `• *Foto Evident Wajib:* Setiap transaksi wajib melampirkan foto serah terima barang secara jelas.\n\n` +
        `_Ketik /batal jika ingin membatalkan input kapan saja._`,
        { parse_mode: 'Markdown' }
    );
});

// ------------------------------------------------------------------------------
// ALUR 1: AMBIL MATERIAL (OUTBOUND)
// ------------------------------------------------------------------------------
bot.hears('📦 Ambil Material (Out)', async (ctx) => {
    const session = getSession(ctx.chat.id);
    session.transactionType = 'OUT';
    session.step = 'waiting_material_name';
    session.uploader = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username || 'Teknisi';

    return ctx.reply(
        `📦 *PENGAMBILAN MATERIAL GUDANG (OUT)*\n\n` +
        `👉 *Langkah 1/5: Masukkan NAMA BARANG / MATERIAL yang diambil:*\n\n` +
        `💡 *Contoh Pilihan Cepat:*\n` +
        `• Modem ONT ZTE F609\n` +
        `• Dropcore 1 Core (meter)\n` +
        `• Pigtail SC/UPC\n` +
        `• Fast Connector\n` +
        `• Klem Buaya / S-Clamp\n\n` +
        `_Ketik nama barang secara spesifik, atau klik /batal untuk batalkan._`,
        { parse_mode: 'Markdown' }
    );
});

// ------------------------------------------------------------------------------
// ALUR 2: RETURN MATERIAL SISA (UNUSED RETURN)
// ------------------------------------------------------------------------------
bot.hears('🔄 Return Material Sisa', async (ctx) => {
    const session = getSession(ctx.chat.id);
    session.transactionType = 'RETURN_UNUSED';
    session.step = 'waiting_material_name';
    session.uploader = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username || 'Teknisi';

    return ctx.reply(
        `🔄 *RETURN MATERIAL SISA (TIDAK TERPAKAI)*\n\n` +
        `Gunakan menu ini untuk mengembalikan sisa barang baru yang tidak jadi terpakai di lapangan ke gudang.\n\n` +
        `👉 *Langkah 1/5: Masukkan NAMA BARANG yang ingin dikembalikan:*\n` +
        `💡 *Contoh:* \`Dropcore 1 Core\` atau \`Pigtail SC\` atau \`Splitter 1:8\`\n\n` +
        `_(Ketik /batal untuk membatalkan)_`,
        { parse_mode: 'Markdown' }
    );
});

// ------------------------------------------------------------------------------
// ALUR 3: PENGEMBALIAN REFURBISH / BEKAS TARIKAN
// ------------------------------------------------------------------------------
bot.hears('♻️ Kembalikan Refurbish', async (ctx) => {
    const session = getSession(ctx.chat.id);
    session.transactionType = 'REFURBISH';
    session.step = 'waiting_material_name';
    session.uploader = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username || 'Teknisi';

    return ctx.reply(
        `♻️ *PENGEMBALIAN MATERIAL REFURBISH / TARIKAN*\n\n` +
        `Gunakan menu ini untuk mengembalikan barang bekas tarikan lapangan (seperti ONT bekas cabutan, adaptor lama, dsb).\n\n` +
        `👉 *Langkah 1/6: Masukkan NAMA BARANG REFURBISH:*\n` +
        `💡 *Contoh:* \`Modem ONT ZTE F609\` atau \`Adaptor 12V 1.5A\`\n\n` +
        `_(Ketik /batal untuk membatalkan)_`,
        { parse_mode: 'Markdown' }
    );
});

// ------------------------------------------------------------------------------
// ALUR 4: CEK MATERIAL SAYA
// ------------------------------------------------------------------------------
bot.hears('📋 Cek Material Saya', async (ctx) => {
    const chatId = ctx.chat.id.toString();
    ctx.reply(`⏳ *Memeriksa riwayat mutasi material Anda di database...*`, { parse_mode: 'Markdown' });

    try {
        const { data, error } = await supabase
            .from('material_transactions')
            .select('material_name, transaction_type, quantity, unit, date, status, serial_number')
            .eq('telegram_chat_id', chatId)
            .order('id', { ascending: false })
            .limit(10);

        if (error || !data || data.length === 0) {
            return ctx.reply(
                `📋 *RIWAYAT MATERIAL ANDA:*\n\n` +
                `Belum ada data transaksi pengambilan/pengembalian material yang tercatat atas nama akun Telegram Anda.`,
                { parse_mode: 'Markdown' }
            );
        }

        let msg = `📋 *10 TRANSAKSI MATERIAL TERAKHIR ANDA:*\n\n`;
        data.forEach((t, i) => {
            const icon = t.transaction_type === 'OUT' ? '📦 AMBIL' : (t.transaction_type === 'RETURN_UNUSED' ? '🔄 RETURN SISA' : '♻️ REFURBISH');
            msg += `${i + 1}. *[${icon}]* ${t.material_name}\n`;
            msg += `   • Jumlah: *${t.quantity} ${t.unit}* ${t.serial_number ? `(SN: \`${t.serial_number}\`)` : ''}\n`;
            msg += `   • Waktu: ${t.date} | Status: *${t.status}*\n\n`;
        });
        msg += `_Data di atas tersinkronisasi langsung dengan Web Dashboard Admin._`;

        return ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (e) {
        return ctx.reply(`❌ Terjadi kendala mengambil data: ${e.message}`);
    }
});

// ------------------------------------------------------------------------------
// PENANGANAN INPUT TEKS MULTI-STEP
// ------------------------------------------------------------------------------
bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    const session = getSession(ctx.chat.id);
    if (!session.step) return;

    // STEP 1: NAMA BARANG
    if (session.step === 'waiting_material_name') {
        session.materialName = text;
        session.step = 'waiting_quantity';
        return ctx.reply(
            `✅ *Barang:* \`${session.materialName}\`\n\n` +
            `👉 *Langkah 2: Masukkan JUMLAH & SATUAN:*\n` +
            `💡 *Contoh Penulisan:*\n` +
            `• \`2 unit\`\n` +
            `• \`150 meter\`\n` +
            `• \`5 pcs\`\n` +
            `• Atau cukup ketik angkanya saja: \`10\`\n\n` +
            `_(Ketik /batal untuk membatalkan)_`,
            { parse_mode: 'Markdown' }
        );
    }

    // STEP 2: JUMLAH
    if (session.step === 'waiting_quantity') {
        const parts = text.split(/\s+/);
        const qtyNum = parseInt(parts[0], 10);
        if (isNaN(qtyNum) || qtyNum <= 0) {
            return ctx.reply(`❌ Masukkan angka jumlah yang valid (contoh: \`2\` atau \`100 meter\`).`);
        }
        session.quantity = qtyNum;
        session.unit = parts.length > 1 ? parts.slice(1).join(' ') : 'pcs';

        // Jika transaksi REFURBISH, minta Serial Number
        if (session.transactionType === 'REFURBISH') {
            session.step = 'waiting_sn';
            return ctx.reply(
                `✅ *Jumlah:* \`${session.quantity} ${session.unit}\`\n\n` +
                `👉 *Langkah 3/6: Masukkan SERIAL NUMBER (SN) / MAC ADDRESS (Jika Ada):*\n` +
                `💡 *Contoh:* \`ZTEGC1928371\` atau ketik \`-\` jika bukan barang bernomor seri.\n\n` +
                `_(Ketik /batal untuk membatalkan)_`,
                { parse_mode: 'Markdown' }
            );
        }

        // Jika AMBIL / RETURN SISA, langsung ke Target Proyek/Perangkat
        session.step = 'waiting_project_target';
        return ctx.reply(
            `✅ *Jumlah:* \`${session.quantity} ${session.unit}\`\n\n` +
            `👉 *Langkah 3/5: Untuk keperluan apa barang ini? (Target Lapangan):*\n` +
            `💡 *Contoh:*\n` +
            `• \`PSB Pelanggan Bpk Ahmad\`\n` +
            `• \`Pemasangan ODP-KT 055/002\`\n` +
            `• \`Perbaikan Kabel Putus Sektor A\`\n\n` +
            `_(Ketik /batal untuk membatalkan)_`,
            { parse_mode: 'Markdown' }
        );
    }

    // STEP REFURBISH KHUSUS: SERIAL NUMBER
    if (session.step === 'waiting_sn') {
        session.serialNumber = text === '-' ? null : text;
        session.step = 'waiting_condition';
        return ctx.reply(
            `✅ *SN Tercatat:* \`${session.serialNumber || 'Tanpa SN'}\`\n\n` +
            `👉 *Langkah 4/6: Bagaimana kondisi barang fisik saat ini?*\n\n` +
            `Silakan klik salah satu pilihan kondisi di bawah:`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('🟢 Layak Pakai (Bagus)', 'cond_bagus')],
                    [Markup.button.callback('🟡 Rusak Ringan (Bisa Servis)', 'cond_rusak_ringan')],
                    [Markup.button.callback('🔴 Mati Total (Afkir/Rusak Berat)', 'cond_matot')]
                ])
            }
        );
    }

    // STEP: TARGET PROYEK / PELANGGAN
    if (session.step === 'waiting_project_target') {
        session.projectTarget = text;
        session.step = 'waiting_photo';

        const actionText = session.transactionType === 'OUT' ? 'PENGAMBILAN' : 'PENGEMBALIAN';
        return ctx.reply(
            `✅ *Target:* \`${session.projectTarget}\`\n\n` +
            `📷 *LANGKAH TERAKHIR: Kirim FOTO FISIK EVIDENT ${actionText}!* 📷\n\n` +
            `Ambil foto fisik barang yang Anda ${actionText.toLowerCase()} secara jelas di gudang/kendaraan.\n\n` +
            `⚠️ _Foto wajib dikirim dalam format foto biasa (Compressed/Kamera langsung)._`,
            { parse_mode: 'Markdown' }
        );
    }

    // STEP REFURBISH: TARGET DARI MANA BARANG DICABUT
    if (session.step === 'waiting_refurbish_source') {
        session.projectTarget = text;
        session.step = 'waiting_photo';
        return ctx.reply(
            `✅ *Asal Tarikan:* \`${session.projectTarget}\`\n\n` +
            `📷 *LANGKAH TERAKHIR: Kirim FOTO FISIK EVIDENT BARANG REFURBISH!* 📷\n\n` +
            `Ambil foto barang tersebut (perlihatkan label SN/kondisi fisik secara jelas).\n\n` +
            `⚠️ _Foto akan langsung disimpan permanen di Cloud Storage._`,
            { parse_mode: 'Markdown' }
        );
    }
});

// Penanganan Action Callback Kondisi Refurbish
bot.action(/cond_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const condKey = ctx.match[1];
    const session = getSession(ctx.chat.id);

    if (condKey === 'bagus') session.condition = 'Layak Pakai (Bagus)';
    else if (condKey === 'rusak_ringan') session.condition = 'Rusak Ringan (Perlu Servis)';
    else if (condKey === 'matot') session.condition = 'Mati Total (Afkir)';

    session.step = 'waiting_refurbish_source';
    return ctx.reply(
        `✅ *Kondisi:* \`${session.condition}\`\n\n` +
        `👉 *Langkah 5/6: Dari mana barang ini dicabut / ditarik?*\n` +
        `💡 *Contoh:* \`Bekas Pelanggan ID-100234 (Bpk Joko)\` atau \`Tarikan ODC Lama\`\n\n` +
        `_(Ketik /batal untuk membatalkan)_`,
        { parse_mode: 'Markdown' }
    );
});

// ------------------------------------------------------------------------------
// PENANGANAN FOTO EVIDENT (WAJIB & PERMANEN)
// ------------------------------------------------------------------------------
bot.on('photo', async (ctx) => {
    const session = getSession(ctx.chat.id);
    if (session.step !== 'waiting_photo') {
        return ctx.reply(`⚠️ Anda sedang tidak dalam sesi input material. Tekan tombol menu untuk memulai.`);
    }

    const photos = ctx.message.photo;
    const bestPhoto = photos[photos.length - 1];
    
    await ctx.reply(`⏳ *Sedang memproses dan mengunggah foto ke Cloud Storage...*`, { parse_mode: 'Markdown' });

    try {
        const fileLink = await ctx.telegram.getFileLink(bestPhoto.file_id);
        const fileBuffer = await downloadFileBuffer(fileLink.href);

        const safeTitle = (session.materialName || 'material').replace(/[^a-zA-Z0-9_.-]/g, '_');
        const customFileName = `evident_mat_${session.transactionType}_${safeTitle}_${Date.now()}.jpg`;

        // Upload Permanen ke Supabase Storage
        const publicUrl = await uploadMaterialEvident(customFileName, fileBuffer, 'image/jpeg');

        if (!publicUrl) {
            return ctx.reply(`❌ Gagal menyimpan foto ke Cloud Storage. Silakan coba kirim ulang fotonya.`);
        }

        session.photoUrl = publicUrl;
        session.fileName = customFileName;

        // Simpan ke Database Supabase
        const saveResult = await saveMaterialTransaction(session);

        if (!saveResult.ok) {
            return ctx.reply(`❌ Gagal mencatat transaksi ke database: ${saveResult.message}`);
        }

        const typeLabel = session.transactionType === 'OUT' ? 'PENGAMBILAN' : (session.transactionType === 'RETURN_UNUSED' ? 'RETURN MATERIAL SISA' : 'PENGEMBALIAN REFURBISH');
        const icon = session.transactionType === 'OUT' ? '📦' : (session.transactionType === 'RETURN_UNUSED' ? '🔄' : '♻️');

        const successMsg = 
            `🎉 *TRANSAKSI BERHASIL DICATAT & DISIMPAN PERMANEN!* 🎉\n\n` +
            `${icon} *Jenis Transaksi:* ${typeLabel}\n` +
            `🏷 *Nama Material:* \`${session.materialName}\`\n` +
            `🔢 *Jumlah:* \`${session.quantity} ${session.unit}\`\n` +
            (session.serialNumber ? `🔖 *Serial Number:* \`${session.serialNumber}\`\n` : '') +
            (session.condition ? `🩺 *Kondisi:* \`${session.condition}\`\n` : '') +
            `🎯 *Target / Keperluan:* \`${session.projectTarget}\`\n` +
            `👤 *Teknisi:* \`${session.uploader}\`\n` +
            `📅 *Waktu:* \`${new Date().toLocaleString('id-ID')}\`\n` +
            `☁️ *Status Foto:* Tersimpan Permanen di Supabase Storage ✅\n\n` +
            `_Data telah otomatis muncul di Web Dashboard Admin untuk diverifikasi._`;

        clearSession(ctx.chat.id);
        return ctx.reply(successMsg, {
            parse_mode: 'Markdown',
            ...buildMaterialMenu()
        });

    } catch (err) {
        console.error("Gagal memproses foto material:", err);
        return ctx.reply(`❌ Terjadi kesalahan saat memproses foto: ${err.message}`);
    }
});

// Jalankan Bot
bot.launch().then(() => {
    console.log("=================================================");
    console.log("🚀 BOT MATERIAL & LOGISTIK MAHAWIRA AKTIF!");
    console.log("=================================================");
}).catch(err => {
    console.error("❌ Gagal menjalankan Bot Material:", err.message);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
