// Inisialisasi Klien Supabase
const supabaseClient = supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseAnonKey, {
    auth: { persistSession: false }
});

let currentUser = null;
let currentUserRole = null;
let accessList = {};
let categories = [];
let sampleData = [];
let currentCategory = 'all';
let currentOdpFilter = 'all';
let categorySearchQuery = '';
let currentPreviewId = null;

// Bersihkan cache lama jika ada
try { localStorage.removeItem('evident_deleted_categories'); } catch (e) {}

// Fungsi helper: Cek apakah user saat ini adalah Owner Project
function checkIsOwner() {
    if (currentUserRole === 'owner') return true;
    const currentEmail = (currentUser && currentUser.email) ? currentUser.email.toLowerCase().trim() : '';
    const ownerEmail = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.ownerEmail) ? APP_CONFIG.ownerEmail.toLowerCase().trim() : 'mahawira2nusantara@gmail.com';
    if (currentEmail && currentEmail === ownerEmail) return true;
    
    try {
        const persistedEmail = (sessionStorage.getItem("evident_user_email") || localStorage.getItem("evident_persisted_email") || '').toLowerCase().trim();
        if (persistedEmail && persistedEmail === ownerEmail) return true;
        const persistedRole = (sessionStorage.getItem("evident_user_role") || localStorage.getItem("evident_persisted_role") || '').toLowerCase().trim();
        if (persistedRole === 'owner') return true;
    } catch (e) {}
    
    return false;
}

// Fungsi helper: Simpan sesi login (sessionStorage untuk tab, localStorage token khusus deteksi refresh)
function saveAuthSession(email, role) {
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanRole = role || 'editor';
    try {
        sessionStorage.setItem("evident_logged_in", "true");
        sessionStorage.setItem("evident_user_email", cleanEmail);
        sessionStorage.setItem("evident_user_role", cleanRole);

        localStorage.setItem("evident_persisted_email", cleanEmail);
        localStorage.setItem("evident_persisted_role", cleanRole);
        localStorage.setItem("evident_session_active", "true");
    } catch (e) {}
}

// Fungsi helper: Bersihkan sesi auth saat sign out atau saat tab ditutup
function clearAuthSession() {
    try {
        sessionStorage.removeItem("evident_logged_in");
        sessionStorage.removeItem("evident_user_email");
        sessionStorage.removeItem("evident_user_role");

        localStorage.removeItem("evident_persisted_email");
        localStorage.removeItem("evident_persisted_role");
        localStorage.removeItem("evident_session_active");
        localStorage.removeItem("evident_refresh_timestamp");
    } catch (e) {}
}

// Catat timestamp unload untuk mendeteksi refresh vs tab close
window.addEventListener("beforeunload", () => {
    try {
        if (sessionStorage.getItem("evident_logged_in") === "true" || localStorage.getItem("evident_persisted_email")) {
            localStorage.setItem("evident_refresh_timestamp", Date.now().toString());
        }
    } catch (e) {}
});

// Cek apakah ada sesi aktif saat refresh halaman (hanya login ulang jika tab ditutup)
function getPersistedAuthSession() {
    try {
        // 1. Cek sessionStorage standar browser (bertahan saat refresh, hilang saat tab ditutup)
        const isSessionLogged = sessionStorage.getItem("evident_logged_in") === "true";
        const sessionEmail = sessionStorage.getItem("evident_user_email");
        const sessionRole = sessionStorage.getItem("evident_user_role");
        if (isSessionLogged && sessionEmail) {
            return { email: sessionEmail.trim().toLowerCase(), role: sessionRole || 'editor' };
        }

        // 2. Cek indikator reload (F5 / tombol refresh / reload di file://)
        const navEntries = (window.performance && window.performance.getEntriesByType) ? performance.getEntriesByType("navigation") : [];
        const isNavReload = navEntries.length > 0 && navEntries[0].type === "reload";
        const isLegacyReload = window.performance && window.performance.navigation && window.performance.navigation.type === 1;

        const lastRefreshTime = parseInt(localStorage.getItem("evident_refresh_timestamp") || "0", 10);
        const isRecentReload = (Date.now() - lastRefreshTime) < 10000;

        const persistedEmail = localStorage.getItem("evident_persisted_email");
        const persistedRole = localStorage.getItem("evident_persisted_role");

        if ((isNavReload || isLegacyReload || isRecentReload) && persistedEmail) {
            saveAuthSession(persistedEmail, persistedRole || 'editor');
            return { email: persistedEmail.trim().toLowerCase(), role: persistedRole || 'editor' };
        }

        // Jika bukan refresh (misal tab baru dibuka setelah ditutup): bersihkan sisa localStorage
        clearAuthSession();
    } catch (e) {
        console.warn("Storage warning:", e);
    }
    return null;
}

const activeSession = getPersistedAuthSession();
if (activeSession) {
    currentUser = { email: activeSession.email };
    currentUserRole = activeSession.role;
}

// Eksekusi utama saat halaman dimuat atau di-refresh
document.addEventListener("DOMContentLoaded", async () => {
    const el = document.getElementById("ownerDisplayEmail");
    if (el) el.innerText = APP_CONFIG.ownerEmail;

    // 1. Jika sudah ada sesi aktif dari refresh, langsung buka dashboard tanpa kedipan/tunggu
    if (currentUser) {
        grantDashboardAccess();
    }

    // 2. Ambil data terbaru dari Supabase
    await fetchSupabaseData();

    // 3. Verifikasi hak akses email dan perbarui UI
    if (currentUser) {
        verifyAndGrantAccess(currentUser.email, false);
    }
});

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Helper: Ekstraksi info pelanggan dan SN modem dari label / nama file jika belum ada di kolom tersendiri
function parseModemInfo(deviceLabel, name) {
    const text = `${deviceLabel || ''} ${name || ''}`;
    let customerId = null;
    let customerName = null;
    let modemSn = null;
    let photoType = null;

    // 1. Ekstrak ID Pelanggan LENGKAP (tidak dipotong)
    // Format: "ID: 100293", "ID Pelanggan: 100293", "_ID_100293_", "ID-100293"
    const mId = text.match(/(?:ID(?:\s*Pelanggan)?[:\s-]+|_ID_)([^|\n\r\[\]_]+)/i) ||
                text.match(/\b(ID-[A-Za-z0-9_-]+)\b/i);
    if (mId) customerId = mId[1].replace(/^_+|_+$/g, '').trim();

    // 2. Ekstrak Nama Pelanggan
    // Format: "Nama: Bpk. Bambang", "Nama Pelanggan: Bambang", "Pelanggan: Bambang"
    const mName = text.match(/(?:Nama(?:\s*Pelanggan)?|Pelanggan)[:\s-]+([^|\[\]\n\r_]+)/i);
    if (mName) customerName = mName[1].trim();

    // 3. Ekstrak SN Modem
    // Format: "SN: ZTEGC123", "SN Modem: ZTEGC123", "_SN_ZTEGC123_"
    const mSn = text.match(/(?:SN(?:\s*Modem)?[:\s-]+|_SN_)([A-Za-z0-9_-]+)/i);
    if (mSn) modemSn = mSn[1].replace(/^_+|_+$/g, '').trim();

    // 4. Ekstrak Jenis Foto Modem
    const mType = text.match(/\[(TAMPAK\s+DEPAN|TAMPAK\s+BELAKANG|TAMPAK\s+LUAR|TAMPAK\s+DALAM|REDAMAN|LABEL|DEPAN|BELAKANG)\]/i);
    if (mType) {
        let t = mType[1].toUpperCase();
        if (t === 'DEPAN') t = 'TAMPAK DEPAN';
        if (t === 'BELAKANG') t = 'TAMPAK BELAKANG';
        photoType = t;
    }

    return { customerId, customerName, modemSn, photoType };
}

// Helper: Ekstraksi Nama Label ODP (misal: ODP-SKD 01/01) dari teks / perangkat
function extractOdpName(item) {
    if (!item) return null;
    const text = `${item.deviceLabel || ''} ${item.name || ''}`;

    // 1. Jika terformat "MODEM [ODP-SKD 01/01]"
    const mModemOdp = text.match(/MODEM\s*\[\s*(ODP-[A-Za-z0-9_\s\/-]+?)\s*\]/i);
    if (mModemOdp) return mModemOdp[1].trim();

    // 2. Jika label perangkat diawali ODP (contoh: "ODP-SKD 01/01 [TAMPAK LUAR]")
    const mOdpDevice = text.match(/\b(ODP-[A-Za-z0-9_\s\/-]+?)(?:\s*\[|\s*$|\s*[-_])/i);
    if (mOdpDevice) return mOdpDevice[1].replace(/_ID_.*$/, '').replace(/\[.*$/, '').trim();

    // 3. Dari nama file: "evident_modem_ODP_SKD_01_01" atau "evident_ODP_SKD_01_01"
    const mFileOdp = text.match(/ODP[_-]([A-Za-z0-9]+)[_-](\d+)[_\/](\d+)/i);
    if (mFileOdp) return `ODP-${mFileOdp[1]} ${mFileOdp[2]}/${mFileOdp[3]}`;

    return null;
}

// Helper: Memformat tampilan File Evident agar rapi, ringkas, dan bebas dari string hash panjang
function formatEvidentDisplay(item) {
    if (!item) return { mainTitle: '-', cleanFileName: '-', photoType: '', rawName: '' };
    const rawName = item.name || '';

    // 1. Ekstrak keterangan tampak / jenis foto jika ada
    let photoType = item.photoType || '';
    if (!photoType) {
        const m = rawName.match(/\[(TAMPAK[_\s]+[A-Z_]+|DEPAN|BELAKANG|LABEL|BARCODE|REDAMAN)\]/i);
        if (m) photoType = m[1].replace(/_/g, ' ').toUpperCase();
    }

    // 2. Pisahkan ekstensi file
    const lastDot = rawName.lastIndexOf('.');
    const ext = lastDot !== -1 ? rawName.slice(lastDot) : '';
    let base = lastDot !== -1 ? rawName.slice(0, lastDot) : rawName;

    // 3. Bersihkan base dari hash [H:...], [DH:...], tampak, dan timestamp Unix panjang
    base = base
        .replace(/\[H:[a-f0-9]+\]/gi, '')
        .replace(/\[DH:[a-f0-9]+\]/gi, '')
        .replace(/\[(TAMPAK[_\s]+[A-Z_]+|DEPAN|BELAKANG|LABEL|BARCODE|REDAMAN)\]/gi, '')
        .replace(/[_-]+\d{10,15}$/i, '')
        .replace(/[_-]+$/g, '')
        .replace(/__+/g, '_')
        .trim();

    const cleanFileName = (base ? base + ext : rawName);

    // 4. Judul utama: prioritaskan deviceLabel, lalu nama file bersih tanpa ekstensi
    let mainTitle = item.deviceLabel || base || cleanFileName;

    return {
        mainTitle,
        cleanFileName,
        photoType,
        rawName
    };
}

// Helper: Temukan pasangan foto 2 jenis (View Depan & View Belakang, atau View Luar & View Dalam)
function getPairedEvidents(item, allData) {
    if (!item) return { type: 'other', single: null };
    const all = allData || sampleData || [];

    const isModem = Boolean(
        item.customerId || 
        item.customerName || 
        item.modemSn || 
        (item.category && item.category.toUpperCase() === 'MODEM') ||
        (item.deviceLabel && item.deviceLabel.toUpperCase().includes('MODEM')) ||
        (item.name && item.name.toUpperCase().includes('MODEM'))
    );

    if (isModem) {
        const cId = (item.customerId || '').trim().toLowerCase();
        const mSn = (item.modemSn || '').trim().toLowerCase();
        const cName = (item.customerName || '').trim().toLowerCase();

        const related = all.filter(d => {
            const dId = (d.customerId || '').trim().toLowerCase();
            const dSn = (d.modemSn || '').trim().toLowerCase();
            const dName = (d.customerName || '').trim().toLowerCase();
            if (cId && dId && dId === cId) return true;
            if (mSn && dSn && dSn === mSn) return true;
            if (cName && dName && dName === cName) return true;
            return false;
        });

        let front = related.find(d => {
            const t = (d.photoType || d.name || '').toUpperCase();
            return t.includes('DEPAN');
        });
        let back = related.find(d => {
            const t = (d.photoType || d.name || '').toUpperCase();
            return t.includes('BELAKANG');
        });

        const itemType = (item.photoType || item.name || '').toUpperCase();
        if (!front && itemType.includes('DEPAN')) front = item;
        if (!back && itemType.includes('BELAKANG')) back = item;
        if (!front && !back) front = item;

        return { type: 'modem', front, back };
    }

    const isOdcOdp = Boolean(
        (item.deviceLabel && (item.deviceLabel.toUpperCase().startsWith('ODC') || item.deviceLabel.toUpperCase().startsWith('ODP'))) ||
        (item.category && (item.category.toUpperCase().startsWith('ODC') || item.category.toUpperCase().startsWith('ODP')))
    );

    if (isOdcOdp) {
        const rawLabel = item.deviceLabel || item.name || '';
        const base = rawLabel.replace(/\s*\[.*\]$/, '').trim().toUpperCase();

        const related = all.filter(d => {
            const dLabel = (d.deviceLabel || d.name || '').toUpperCase();
            return dLabel.startsWith(base);
        });

        let luar = related.find(d => {
            const t = (d.photoType || d.name || '').toUpperCase();
            return t.includes('LUAR');
        });
        let dalam = related.find(d => {
            const t = (d.photoType || d.name || '').toUpperCase();
            return t.includes('DALAM');
        });

        const itemType = (item.photoType || item.name || '').toUpperCase();
        if (!luar && itemType.includes('LUAR')) luar = item;
        if (!dalam && itemType.includes('DALAM')) dalam = item;
        if (!luar && !dalam) luar = item;

        return { type: 'odc_odp', luar, dalam, baseName: base };
    }

    return { type: 'other', single: item };
}

// Helper: Kumpulkan daftar pelanggan yang berada di ODP tertentu (relasi ODP -> List Pelanggan ODP A)
function getCustomerListForOdp(odpName) {
    if (!odpName || !sampleData || sampleData.length === 0) return [];
    const targetNorm = odpName.trim().toUpperCase().replace(/[\s_-]+/g, '');
    const clientMap = new Map();

    sampleData.forEach(item => {
        const itemOdp = (item.odpName || extractOdpName(item) || '').trim().toUpperCase().replace(/[\s_-]+/g, '');
        if (itemOdp === targetNorm) {
            const cId = item.customerId;
            const cName = item.customerName;
            const mSn = item.modemSn;
            if (cId || cName || mSn) {
                const key = cId ? `ID:${cId}` : `${cName || 'UNKNOWN'}_${mSn || 'NOSN'}`;
                if (!clientMap.has(key)) {
                    clientMap.set(key, {
                        customerId: cId || null,
                        customerName: cName || 'Tanpa Nama',
                        modemSn: mSn || null,
                        photos: [],
                        items: []
                    });
                }
                const record = clientMap.get(key);
                record.items.push(item);
                if (item.photoType && !record.photos.includes(item.photoType)) {
                    record.photos.push(item.photoType);
                }
            }
        }
    });

    return Array.from(clientMap.values());
}

// Helper: Mengambil daftar ODP unik yang ikut dalam kategori / ODC tertentu
function getOdpListForCategory(cat) {
    if (!sampleData || sampleData.length === 0) return [];
    const isAll = !cat || cat === 'all';
    const isOdc = cat && cat.toUpperCase().startsWith('ODC-');
    const isModem = cat && cat.toUpperCase() === 'MODEM';

    const odpMap = new Map();

    sampleData.forEach(item => {
        let match = false;
        if (isAll) {
            match = true;
        } else if (isOdc) {
            const itemOdc = getItemOdcGroup(item);
            match = (itemOdc === cat) || (item.category === cat) || (item.odcReference === cat);
        } else if (isModem) {
            match = Boolean(item.customerId || item.customerName || item.modemSn || (item.category && item.category.toUpperCase() === 'MODEM'));
        } else {
            match = (item.category === cat) || ((item.category || '').toUpperCase() === cat.toUpperCase());
        }

        if (match) {
            const odp = item.odpName || extractOdpName(item);
            if (odp) {
                const odpKey = odp.trim().toUpperCase();
                if (!odpMap.has(odpKey)) {
                    odpMap.set(odpKey, {
                        odpName: odp.trim(),
                        fileCount: 0
                    });
                }
                odpMap.get(odpKey).fileCount += 1;
            }
        }
    });

    const result = Array.from(odpMap.values()).map(odpObj => {
        const customers = getCustomerListForOdp(odpObj.odpName);
        return {
            ...odpObj,
            customers: customers
        };
    });

    // Urutkan berdasarkan nama ODP secara natural
    return result.sort((a, b) => a.odpName.localeCompare(b.odpName, undefined, { numeric: true, sensitivity: 'base' }));
}

// Render Dropdown Pilihan ODP dan kontrol list pelanggan
function renderOdpDropdown() {
    const odpSection = document.getElementById('odpFilterSection');
    const odpSelect = document.getElementById('odpDropdownSelect');
    const badge = document.getElementById('odpActiveBadge');
    const resetBtn = document.getElementById('btnResetOdpFilter');
    if (!odpSection || !odpSelect) return;

    const odpList = getOdpListForCategory(currentCategory);

    // Jika tidak ada ODP di kategori ini (misal TIANG murni), sembunyikan section ODP
    if (odpList.length === 0) {
        odpSection.classList.add('hidden');
        currentOdpFilter = 'all';
        renderOdpCustomerPanel('all');
        return;
    }

    odpSection.classList.remove('hidden');

    let html = `<option value="all">📂 Semua ODP Terdaftar (${odpList.length} ODP)</option>`;
    odpList.forEach(odp => {
        const isSel = currentOdpFilter.toUpperCase() === odp.odpName.toUpperCase();
        const clientText = odp.customers.length > 0 ? `${odp.customers.length} Pelanggan, ` : '';
        html += `<option value="${escapeHtml(odp.odpName)}" ${isSel ? 'selected' : ''}>🛜 ${escapeHtml(odp.odpName)} (${clientText}${odp.fileCount} Evident)</option>`;
    });
    odpSelect.innerHTML = html;

    if (currentOdpFilter !== 'all') {
        const currentOdpObj = odpList.find(o => o.odpName.toUpperCase() === currentOdpFilter.toUpperCase());
        const custCount = currentOdpObj ? currentOdpObj.customers.length : 0;
        if (badge) badge.innerText = `Menampilkan data khusus: ${currentOdpFilter} (${custCount} Pelanggan)`;
        if (resetBtn) resetBtn.classList.remove('hidden');
        renderOdpCustomerPanel(currentOdpFilter);
    } else {
        if (badge) badge.innerText = `Menampilkan semua data ODP (${odpList.length} ODP)`;
        if (resetBtn) resetBtn.classList.add('hidden');
        renderOdpCustomerPanel('all');
    }
}

function handleOdpDropdownChange(val) {
    currentOdpFilter = val;
    renderOdpDropdown();
    filterFiles();
}

function resetOdpDropdownFilter() {
    currentOdpFilter = 'all';
    const odpSelect = document.getElementById('odpDropdownSelect');
    if (odpSelect) odpSelect.value = 'all';
    renderOdpDropdown();
    filterFiles();
}

// Render Panel List Pelanggan untuk ODP yang dipilih
function renderOdpCustomerPanel(odpName) {
    const card = document.getElementById('odpClientListCard');
    const titleEl = document.getElementById('odpClientCardTitle');
    const countBadge = document.getElementById('odpClientCountBadge');
    const chipsContainer = document.getElementById('odpClientChipsList');
    if (!card || !chipsContainer) return;

    if (!odpName || odpName === 'all') {
        card.classList.add('hidden');
        return;
    }

    const customers = getCustomerListForOdp(odpName);
    card.classList.remove('hidden');
    if (titleEl) titleEl.innerText = `Daftar Pelanggan Terdaftar di ${odpName}`;
    if (countBadge) countBadge.innerText = `${customers.length} Pelanggan`;

    if (customers.length === 0) {
        chipsContainer.innerHTML = `
            <div class="py-2 px-3 text-slate-400 text-xs italic bg-slate-50 border border-slate-100 rounded-lg w-full flex items-center gap-2">
                <i class="fa-solid fa-circle-info text-slate-300"></i>
                <span>Belum ada data pelanggan yang terhubung di ${escapeHtml(odpName)}. Evident modem yang diinput melalui bot akan otomatis muncul di sini.</span>
            </div>
        `;
        return;
    }

    chipsContainer.innerHTML = customers.map(c => {
        const idHtml = c.customerId
            ? `<span class="bg-indigo-100 text-indigo-800 font-mono font-bold px-1.5 py-0.5 rounded text-[10px]">${escapeHtml(c.customerId)}</span>`
            : `<span class="text-slate-400 font-mono text-[10px]">Tanpa ID</span>`;
        const snHtml = c.modemSn
            ? `<span class="bg-amber-100 text-amber-900 font-mono font-bold px-1.5 py-0.5 rounded text-[10px]"><i class="fa-solid fa-barcode mr-1 text-[8px]"></i>${escapeHtml(c.modemSn)}</span>`
            : '';
        const photosBadge = c.photos.length > 0
            ? `<span class="text-[9px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">${c.photos.join(' & ')}</span>`
            : `<span class="text-[9px] text-slate-400">${c.items.length} file</span>`;

        // Klik chip pelanggan untuk filter instan
        const filterTarget = c.customerId || c.customerName;

        return `
            <div onclick="quickFilterCustomer('${escapeHtml(filterTarget)}')" title="Klik untuk menyaring berkas pelanggan ini"
                class="cursor-pointer p-2 bg-slate-50 hover:bg-indigo-50/70 border border-slate-200 hover:border-indigo-300 rounded-lg transition text-xs flex flex-col gap-1 min-w-[210px] max-w-[280px] shadow-2xs">
                <div class="flex items-center justify-between gap-1.5">
                    <span class="font-bold text-slate-800 truncate text-[11px] flex items-center gap-1">
                        <i class="fa-solid fa-user text-slate-400 text-[10px]"></i>
                        ${escapeHtml(c.customerName)}
                    </span>
                    ${idHtml}
                </div>
                <div class="flex items-center justify-between gap-1 flex-wrap pt-1 border-t border-slate-100">
                    <div class="flex items-center gap-1">
                        ${snHtml}
                        ${photosBadge}
                    </div>
                    <button onclick="event.stopPropagation(); openCustomerHistoryModal('${escapeHtml(c.customerId || '')}', '${escapeHtml(c.customerName || '')}', '${escapeHtml(c.modemSn || '')}')"
                        class="px-2 py-0.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-bold rounded text-[9.5px] border border-indigo-200 transition flex items-center gap-1 shadow-2xs"
                        title="Buka History Aktivitas Pelanggan">
                        <i class="fa-solid fa-clock-rotate-left text-[8.5px]"></i> History Log
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

// Membuka modal riwayat / history log aktivitas pelanggan
function openCustomerHistoryModal(customerId, customerName, modemSn) {
    const modal = document.getElementById('customerHistoryModal');
    if (!modal) return;

    // Filter seluruh evident yang berkaitan dengan pelanggan ini
    const cIdNorm = (customerId || '').trim().toLowerCase();
    const cNameNorm = (customerName || '').trim().toLowerCase();
    const mSnNorm = (modemSn || '').trim().toLowerCase();

    const relatedEvidents = sampleData.filter(item => {
        const itemId = (item.customerId || '').trim().toLowerCase();
        const itemName = (item.customerName || '').trim().toLowerCase();
        const itemSn = (item.modemSn || '').trim().toLowerCase();

        if (cIdNorm && itemId && itemId === cIdNorm) return true;
        if (mSnNorm && itemSn && itemSn === mSnNorm) return true;
        if (cNameNorm && itemName && itemName === cNameNorm) return true;
        return false;
    });

    // Urutkan riwayat: id desc (terbaru di atas)
    relatedEvidents.sort((a, b) => (b.id || 0) - (a.id || 0));

    // Isi profil ringkasan
    const activeName = customerName || (relatedEvidents[0] ? relatedEvidents[0].customerName : null) || 'Pelanggan';
    const activeId = customerId || (relatedEvidents[0] ? relatedEvidents[0].customerId : null) || '-';
    const activeSn = modemSn || (relatedEvidents[0] ? relatedEvidents[0].modemSn : null) || '-';
    const activeOdp = (relatedEvidents[0] ? (relatedEvidents[0].odpName || extractOdpName(relatedEvidents[0])) : null) || '-';

    document.getElementById('custHistName').innerText = activeName;
    document.getElementById('custHistId').innerText = activeId;
    document.getElementById('custHistSn').innerText = activeSn;
    document.getElementById('custHistOdp').innerText = activeOdp;
    document.getElementById('custHistBadge').innerText = `${relatedEvidents.length} Log`;
    document.getElementById('custHistTotalEvident').innerText = `Total ${relatedEvidents.length} riwayat aktivitas berkas tercatat`;

    const timelineContainer = document.getElementById('custHistTimelineList');
    if (relatedEvidents.length === 0) {
        timelineContainer.innerHTML = `
            <div class="py-8 text-center text-slate-400">
                <i class="fa-solid fa-clock-rotate-left text-2xl text-slate-300 mb-2 block"></i>
                <p class="text-xs">Belum ada riwayat aktivitas tercatat untuk pelanggan ini.</p>
            </div>
        `;
    } else {
        timelineContainer.innerHTML = relatedEvidents.map(ev => {
            const fmt = formatEvidentDisplay(ev);
            const isOwner = checkIsOwner();
            const statusBadge = ev.status === 'Disetujui'
                ? `<span class="bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5 rounded text-[10px] font-bold inline-flex items-center gap-1"><i class="fa-solid fa-circle-check text-[9px]"></i> Disetujui</span>`
                : ev.status === 'Ditolak'
                    ? `<span class="bg-rose-50 text-rose-700 border border-rose-200 px-2 py-0.5 rounded text-[10px] font-bold inline-flex items-center gap-1"><i class="fa-solid fa-circle-xmark text-[9px]"></i> Ditolak</span>`
                    : `<span class="bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 rounded text-[10px] font-bold inline-flex items-center gap-1"><i class="fa-solid fa-clock text-[9px]"></i> Pending Review</span>`;

            return `
                <div class="p-3 bg-slate-50 hover:bg-slate-100/80 border border-slate-200 rounded-xl transition flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
                    <div class="flex items-start gap-2.5 min-w-0 flex-1">
                        <div class="w-8 h-8 rounded-lg bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs shrink-0 mt-0.5">
                            <i class="fa-solid ${fmt.photoType && fmt.photoType.includes('BELAKANG') ? 'fa-barcode' : 'fa-camera'}"></i>
                        </div>
                        <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-1.5 flex-wrap">
                                <span class="font-bold text-slate-900 text-xs">${escapeHtml(fmt.mainTitle)}</span>
                                ${fmt.photoType ? `<span class="bg-blue-100/70 text-blue-800 text-[9.5px] font-extrabold uppercase px-1.5 py-0.2 rounded border border-blue-200">${escapeHtml(fmt.photoType)}</span>` : ''}
                                ${statusBadge}
                            </div>
                            <div class="text-[10.5px] text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
                                <span><i class="fa-solid fa-user-pen text-slate-400 mr-1"></i>${escapeHtml(ev.uploader || 'Teknisi')}</span>
                                <span>•</span>
                                <span><i class="fa-solid fa-calendar text-slate-400 mr-1"></i>${escapeHtml(ev.date || '-')}</span>
                                <span>•</span>
                                <span class="font-mono text-slate-400">(${escapeHtml(ev.size || '-')})</span>
                            </div>
                            ${ev.locationUrl ? `<div class="text-[10px] text-emerald-600 mt-1"><a href="${ev.locationUrl}" target="_blank" class="hover:underline inline-flex items-center gap-1 font-semibold"><i class="fa-solid fa-location-dot"></i> Titik Lokasi GPS Maps</a></div>` : ''}
                            ${ev.rejectReason ? `<div class="text-[10px] text-rose-500 italic mt-0.5"><i class="fa-solid fa-triangle-exclamation"></i> Catatan: ${escapeHtml(ev.rejectReason)}</div>` : ''}
                        </div>
                    </div>
                    <div class="flex items-center gap-1.5 self-end sm:self-center shrink-0">
                        <button onclick="previewFile(${ev.id})" class="px-2.5 py-1 bg-white hover:bg-blue-50 text-blue-700 border border-slate-200 rounded-lg text-[11px] font-semibold transition flex items-center gap-1 shadow-2xs" title="Lihat Foto Evident">
                            <i class="fa-solid fa-eye text-[10px]"></i> Lihat
                        </button>
                        ${isOwner ? `
                        <button onclick="deleteEvident(${ev.id})" class="px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-lg text-[11px] font-semibold transition flex items-center gap-1 shadow-2xs" title="Hapus Evident Ini (Owner)">
                            <i class="fa-solid fa-trash-can text-[10px]"></i> Hapus
                        </button>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');
    }

    openModal('customerHistoryModal');
}

// Fungsi Hapus Evident Khusus Owner
async function deleteEvident(id) {
    if (!checkIsOwner()) {
        return alert('Akses Ditolak: Hanya Owner dashboard yang memiliki izin menghapus berkas evident!');
    }

    const item = sampleData.find(d => d.id === id);
    if (!item) return;

    const confirmMsg = `PERINGATAN OWNER:\nApakah Anda yakin ingin menghapus berkas evident "${item.name}" secara permanen?\n\nTindakan ini tidak dapat dibatalkan.`;
    if (!confirm(confirmMsg)) return;

    // 1. Hapus record dari database Supabase
    const { error } = await supabaseClient.from('evidents').delete().eq('id', id);
    if (error) {
        alert("Gagal menghapus evident dari database: " + error.message);
        return;
    }

    // 2. Jika ada berkas di Supabase storage, hapus juga dari bucket storage
    if (item.fileUrl && item.fileUrl.includes('evidents/')) {
        try {
            const parts = item.fileUrl.split('/');
            const fileName = parts[parts.length - 1].split('?')[0];
            await supabaseClient.storage.from('evidents').remove([fileName]);
        } catch (e) {
            console.warn("Storage deletion notice:", e);
        }
    }

    // 3. Update memory lokal sampleData
    sampleData = sampleData.filter(d => d.id !== id);

    // 4. Tutup modal preview atau refresh modal history jika sedang terbuka
    closeModal('previewModal');
    const histModal = document.getElementById('customerHistoryModal');
    if (histModal && !histModal.classList.contains('hidden')) {
        if (item.customerId || item.customerName) {
            openCustomerHistoryModal(item.customerId, item.customerName, item.modemSn);
        } else {
            closeModal('customerHistoryModal');
        }
    }

    // 5. Refresh tampilan tabel, dropdown, dan statistik
    filterFiles();
    updateStats();
    alert(`Berkas evident "${item.name}" berhasil dihapus secara permanen.`);
}

function deleteCurrentPreviewEvident() {
    if (currentPreviewId) {
        deleteEvident(currentPreviewId);
    }
}

// Quick filter saat kartu pelanggan di-klik
function quickFilterCustomer(target) {
    if (!target) return;
    const searchInput = document.getElementById('searchInput');
    const searchField = document.getElementById('searchFieldSelect');
    if (searchInput) searchInput.value = target;
    if (searchField) searchField.value = 'all';
    filterFiles();
}

// Filter / Pencarian folder kategori cepat
function filterFolderGrid() {
    const input = document.getElementById('categoryFolderSearch');
    categorySearchQuery = input ? input.value.toLowerCase().trim() : '';
    const clearBtn = document.getElementById('clearCatSearchBtn');
    if (clearBtn) {
        if (categorySearchQuery) clearBtn.classList.remove('hidden');
        else clearBtn.classList.add('hidden');
    }
    renderFolderGrid();
    renderCategoryUI();
}

function clearCatFolderSearch() {
    const input = document.getElementById('categoryFolderSearch');
    if (input) input.value = '';
    categorySearchQuery = '';
    const clearBtn = document.getElementById('clearCatSearchBtn');
    if (clearBtn) clearBtn.classList.add('hidden');
    renderFolderGrid();
    renderCategoryUI();
}
async function fetchSupabaseData() {
    try {
        // 1. Ambil Access List
        let { data: accData, error: accError } = await supabaseClient
            .from('access_list')
            .select('*');

        if (!accError && accData) {
            accessList = {};
            accData.forEach(row => {
                if (row.email) accessList[row.email.trim().toLowerCase()] = row.role;
            });
        } else {
            accessList = { [APP_CONFIG.ownerEmail.toLowerCase()]: "owner" };
        }

        // 2. Ambil Kategori
        let { data: catData, error: catError } = await supabaseClient
            .from('categories')
            .select('*')
            .order('id', { ascending: true });

        if (!catError && catData && catData.length > 0) {
            categories = catData.map(row => row.name);
        } else if (!categories || categories.length === 0) {
            categories = [...APP_CONFIG.defaultCategories];
        }

        // 3. Ambil Data Evident dari Supabase
        let { data: evData, error: evError } = await supabaseClient
            .from('evidents')
            .select('*')
            .order('id', { ascending: false });

        if (!evError && evData && evData.length > 0) {
            sampleData = evData.map(row => {
                const parsed = parseModemInfo(row.device_label, row.name);
                const odpName = row.odp_reference || extractOdpName(row);
                const locUrl = row.location_url || (row.latitude && row.longitude ? `https://www.google.com/maps?q=${row.latitude},${row.longitude}` : null);
                return {
                    id: row.id,
                    name: row.name,
                    size: row.size,
                    category: row.category,
                    deviceLabel: row.device_label || null,
                    odcReference: row.odc_reference || null,
                    odpName: odpName || null,
                    customerId: row.customer_id || parsed.customerId || null,
                    customerName: row.customer_name || parsed.customerName || null,
                    modemSn: row.modem_sn || parsed.modemSn || null,
                    photoType: row.photo_type || parsed.photoType || null,
                    locationUrl: locUrl,
                    latitude: row.latitude || null,
                    longitude: row.longitude || null,
                    uploader: row.uploader,
                    date: row.date,
                    status: row.status,
                    fileUrl: row.file_url || null,
                    rejectReason: row.reject_reason || null
                };
            });

            // PERLINDUNGAN KEABADIAN DATA: Simpan cadangan offline di cache browser
            try {
                localStorage.setItem('evident_cached_vault', JSON.stringify(sampleData));
            } catch (e) {}
        } else if (evError) {
            console.warn("Koneksi Supabase tertunda, memuat cadangan persistent:", evError.message);
            // Pulihkan dari cadangan jika ada
            const cached = localStorage.getItem('evident_cached_vault');
            if (cached && (!sampleData || sampleData.length === 0)) {
                try { sampleData = JSON.parse(cached); } catch (e) {}
            }
        }

        renderCategoryUI();
        filterFiles();
    } catch (err) {
        console.error("Gagal terhubung ke Supabase:", err);
        accessList = { [APP_CONFIG.ownerEmail.toLowerCase()]: "owner" };
        if (!categories || categories.length === 0) {
            categories = [...APP_CONFIG.defaultCategories];
        }
        // Pulihkan dari cadangan persistent jika jaringan error
        const cached = localStorage.getItem('evident_cached_vault');
        if (cached && (!sampleData || sampleData.length === 0)) {
            try { sampleData = JSON.parse(cached); } catch (e) {}
        }
        renderCategoryUI();
        filterFiles();
    }
}

async function submitLoginForm() {
    const input = document.getElementById('loginEmailInput');
    const email = input && input.value ? input.value.trim().toLowerCase() : APP_CONFIG.ownerEmail.toLowerCase();
    if (!email) {
        alert("Silakan masukkan alamat email Gmail Anda!");
        return;
    }

    await fetchSupabaseData();
    currentUser = { email: email };
    verifyAndGrantAccess(email, true);
}

async function quickLoginOwner() {
    const email = APP_CONFIG.ownerEmail.trim().toLowerCase();
    await fetchSupabaseData();
    currentUser = { email: email };
    verifyAndGrantAccess(email, true);
}

async function handleGoogleSignIn() {
    const inputEmail = prompt("Masukkan email Gmail Anda untuk masuk:", APP_CONFIG.ownerEmail);
    if (!inputEmail) return;

    const email = inputEmail.trim().toLowerCase();

    // Perbarui data access list terbaru
    await fetchSupabaseData();

    currentUser = { email: email };
    verifyAndGrantAccess(email, true);
}

function verifyAndGrantAccess(email, isManualLogin = false) {
    const cleanEmail = (email || '').trim().toLowerCase();
    const ownerClean = APP_CONFIG.ownerEmail.trim().toLowerCase();

    let grantedRole = null;
    if (cleanEmail === ownerClean) {
        grantedRole = "owner";
    } else if (accessList[cleanEmail]) {
        grantedRole = accessList[cleanEmail];
    } else if (!isManualLogin && (sessionStorage.getItem("evident_user_role") || localStorage.getItem("evident_persisted_role"))) {
        // Pertahankan sesi role saat refresh jika accessList sedang di-fetch
        grantedRole = sessionStorage.getItem("evident_user_role") || localStorage.getItem("evident_persisted_role");
    }

    if (grantedRole) {
        currentUser = { email: cleanEmail };
        currentUserRole = grantedRole;
        saveAuthSession(cleanEmail, grantedRole);
        grantDashboardAccess();
    } else {
        clearAuthSession();
        const shield = document.getElementById("authShieldStyle");
        if (shield) shield.remove();
        document.getElementById('authLockScreen').classList.remove('hidden');
        document.getElementById('authBox').classList.add('hidden');
        document.getElementById('accessDeniedBox').classList.remove('hidden');
        document.getElementById('deniedUserEmail').innerText = cleanEmail;
    }
}

function grantDashboardAccess() {
    document.getElementById('authLockScreen').classList.add('hidden');
    document.getElementById('currentEmailDisplay').innerText = currentUser.email;
    document.getElementById('userAvatar').innerText = currentUser.email.charAt(0).toUpperCase();

    const badge = document.getElementById('userRoleBadge');
    badge.innerText = (currentUserRole || 'editor').toUpperCase();

    const isOwner = checkIsOwner();
    if (isOwner) {
        currentUserRole = 'owner';
        document.getElementById('shareBtn').classList.remove('hidden');
    } else {
        document.getElementById('shareBtn').classList.add('hidden');
    }

    const isEditorOrOwner = isOwner || currentUserRole === 'editor';
    document.querySelectorAll('.role-editor').forEach(el => {
        if (isEditorOrOwner) el.classList.remove('hidden');
        else el.classList.add('hidden');
    });

    renderCategoryUI();
    filterFiles();
}

function handleSignOut() {
    currentUser = null;
    currentUserRole = null;
    clearAuthSession();
    const shield = document.getElementById("authShieldStyle");
    if (shield) shield.remove();
    document.getElementById('authLockScreen').classList.remove('hidden');
    document.getElementById('authBox').classList.remove('hidden');
    document.getElementById('accessDeniedBox').classList.add('hidden');
}

function requestAccess() {
    alert(`Permintaan izin akses untuk ${currentUser.email} telah dikirimkan ke Pemilik Utama (${APP_CONFIG.ownerEmail}).`);
}

async function grantAccess() {
    const emailInput = document.getElementById('grantEmailInput');
    const roleSelect = document.getElementById('grantRoleSelect');
    const email = emailInput.value.trim().toLowerCase();

    if (!email) return alert('Masukkan alamat email Gmail!');

    const { error } = await supabaseClient
        .from('access_list')
        .upsert({ email: email, role: roleSelect.value }, { onConflict: 'email' });

    if (error) {
        alert("Gagal menyimpan ke database Supabase: " + error.message);
        return;
    }

    accessList[email] = roleSelect.value;
    emailInput.value = '';
    renderAccessList();
    alert(`Izin akses untuk ${email} sebagai [${roleSelect.value.toUpperCase()}] berhasil disimpan!`);
}

async function revokeAccess(email) {
    if (email === APP_CONFIG.ownerEmail.toLowerCase()) return alert('Tidak bisa menghapus izin Pemilik Utama!');
    if (confirm(`Hapus izin akses untuk ${email}?`)) {
        const { error } = await supabaseClient.from('access_list').delete().eq('email', email);
        if (error) {
            alert("Gagal menghapus dari database: " + error.message);
            return;
        }
        delete accessList[email];
        renderAccessList();
    }
}

function renderAccessList() {
    const listContainer = document.getElementById('allowedEmailList');
    if (!listContainer) return;
    listContainer.innerHTML = Object.keys(accessList).map(email => `
        <div class="flex items-center justify-between p-2 bg-slate-50 border rounded-lg text-xs">
            <div>
                <span class="font-semibold text-slate-800">${email}</span>
                <span class="ml-2 text-[10px] font-bold ${accessList[email] === 'owner' ? 'text-purple-600 bg-purple-50' : accessList[email] === 'editor' ? 'text-blue-600 bg-blue-50' : 'text-amber-600 bg-amber-50'} px-1.5 py-0.5 rounded uppercase">${accessList[email]}</span>
            </div>
            ${email !== APP_CONFIG.ownerEmail.toLowerCase() ? `<button onclick="revokeAccess('${email}')" class="text-rose-600 hover:text-rose-800 p-1"><i class="fa-solid fa-trash-can text-xs"></i></button>` : ''}
        </div>
    `).join('');
}

// Pendaftaran Massal ID Telegram dari Dashboard Web (hingga 100+ ID sekaligus)
async function submitBulkTelegramFromDashboard() {
    if (currentUserRole !== 'owner') {
        return alert('Akses Ditolak: Fitur ini khusus untuk Owner Project!');
    }

    const textarea = document.getElementById('bulkTelegramInput');
    const rawText = textarea ? textarea.value.trim() : '';
    if (!rawText) return alert('Silakan masukkan daftar ID Telegram terlebih dahulu.');

    const rawLines = rawText.split(/[\r\n]+/);
    const tokens = [];

    for (const line of rawLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const digits = trimmed.match(/\b\d{5,15}\b/g) || [];
        if (digits.length > 1) {
            tokens.push(...trimmed.split(/[,;]+/).map(s => s.trim()).filter(Boolean));
        } else {
            tokens.push(trimmed);
        }
    }

    const items = [];
    const seen = new Set();

    for (const item of tokens) {
        if (!item) continue;
        const m = item.match(/^(\d{5,15})(?:\s*[-:|]\s*(.+))?$/);
        if (m) {
            const id = m[1].trim();
            const name = (m[2] || `Teknisi (${id})`).trim();
            if (!seen.has(id)) {
                seen.add(id);
                items.push({ id, name });
            }
        } else {
            const idMatches = item.match(/\b\d{5,15}\b/g);
            if (idMatches) {
                for (const id of idMatches) {
                    if (!seen.has(id)) {
                        seen.add(id);
                        items.push({ id, name: `Teknisi (${id})` });
                    }
                }
            }
        }
    }

    if (items.length === 0) {
        return alert('Tidak ditemukan ID Telegram yang valid (5-15 digit angka).');
    }

    const records = items.map(it => ({
        telegram_chat_id: it.id,
        role: 'editor',
        email: `${it.name} (ID: ${it.id})`
    }));

    const { error } = await supabaseClient
        .from('access_list')
        .upsert(records, { onConflict: 'telegram_chat_id' });

    if (error) {
        return alert("Gagal mendaftarkan ID Telegram: " + error.message);
    }

    textarea.value = '';
    alert(`Berhasil mendaftarkan ${items.length} ID Telegram teknisi sekaligus! Seluruh teknisi tersebut kini dapat langsung menggunakan bot Telegram.`);
    await fetchSupabaseData();
}

// Helper: Normalisasi string nama ODC dari label/referensi
function normalizeOdc(s) {
    if (!s || typeof s !== 'string') return null;
    const clean = s.trim().toUpperCase().replace(/\s*\[[^\]]+\]\s*$/, '').trim();
    const m = clean.match(/ODC[-_\s]+([A-Z0-9]+(?:-[A-Z0-9]+)?)[\s-]+([A-Z0-9]+)/i);
    if (m) return `ODC-${m[1].toUpperCase()} ${m[2].toUpperCase()}`;
    if (clean.startsWith('ODC-') || clean.startsWith('ODC ')) return clean;
    return null;
}

// Helper: Menentukan ODC induk bagi setiap item evident (termasuk Modem yg label-nya MODEM [ODP-xxx])
function getItemOdcGroup(item) {
    if (!item) return null;

    // Khusus Modem: jika deviceLabel mengandung MODEM [ODP-xxx], gunakan odcReference/category
    const isModemLabel = item.deviceLabel && typeof item.deviceLabel === 'string' && item.deviceLabel.toUpperCase().startsWith('MODEM [ODP-');
    if (isModemLabel) {
        const refOdc = normalizeOdc(item.odcReference || item.odc_reference);
        if (refOdc) return refOdc;
        const catOdc = normalizeOdc(item.category);
        if (catOdc) return catOdc;
        const mMod = item.deviceLabel.match(/MODEM\s*\[ODP-([A-Z0-9]+(?:-[A-Z0-9]+)?)[\\s-]+([A-Z0-9]+)\s*\//i);
        if (mMod) return `ODC-${mMod[1].toUpperCase()} ${mMod[2].toUpperCase()}`;
        return null;
    }

    // 1. Dari odcReference (misal ODC-SKD 01)
    const refOdc = normalizeOdc(item.odcReference || item.odc_reference);
    if (refOdc) return refOdc;

    // 2. Dari category jika bertipe ODC-xxx
    const catOdc = normalizeOdc(item.category);
    if (catOdc) return catOdc;

    // 3. Dari deviceLabel jika berformat ODC-xxx
    const lblOdc = normalizeOdc(item.deviceLabel);
    if (lblOdc) return lblOdc;

    // 4. Dari deviceLabel ODP (misal ODP-SKD 01/01 -> ODC-SKD 01)
    if (item.deviceLabel && typeof item.deviceLabel === 'string') {
        const mOdp = item.deviceLabel.match(/ODP-([A-Z0-9]+(?:-[A-Z0-9]+)?)[\s-]+([A-Z0-9]+)\s*\//i);
        if (mOdp) return `ODC-${mOdp[1].toUpperCase()} ${mOdp[2].toUpperCase()}`;
    }

    // 5. Dari nama file (misal evident_ODC-SKD_01_...)
    if (item.name && typeof item.name === 'string') {
        const mOdcName = item.name.match(/ODC[-_]([A-Z0-9]+)[-_]([A-Z0-9]+)/i);
        if (mOdcName) return `ODC-${mOdcName[1].toUpperCase()} ${mOdcName[2].toUpperCase()}`;
    }
    return null;
}

// Helper: Dapatkan nama unit ODC (contoh: ODC-SKD 01) tanpa embel-embel jenis foto
function getOdcUnitName(item) {
    if (!item) return 'ODC';
    // 1. Dari deviceLabel murni (contoh: ODC-SKD 01 [TAMPAK LUAR] -> ODC-SKD 01)
    if (item.deviceLabel && typeof item.deviceLabel === 'string') {
        const norm = normalizeOdc(item.deviceLabel);
        if (norm) return norm;
        const clean = item.deviceLabel.replace(/\s*\[[^\]]+\]\s*$/, '').trim().toUpperCase();
        if (clean.startsWith('ODC')) return clean;
    }
    // 2. Dari odcReference
    const ref = normalizeOdc(item.odcReference || item.odc_reference);
    if (ref) return ref;
    // 3. Dari category (jika format ODC-xxx)
    if (item.category && typeof item.category === 'string') {
        const cNorm = normalizeOdc(item.category);
        if (cNorm) return cNorm;
        if (item.category.trim().toUpperCase().startsWith('ODC') && item.category.trim().toUpperCase() !== 'ODC') {
            return item.category.trim().toUpperCase();
        }
    }
    // 4. Dari helper getItemOdcGroup
    const grp = getItemOdcGroup(item);
    if (grp) return grp;
    // 5. Dari nama file
    if (item.name && typeof item.name === 'string') {
        const m = item.name.match(/ODC[-_]([A-Z0-9]+)[-_]([A-Z0-9]+)/i);
        if (m) return `ODC-${m[1].toUpperCase()} ${m[2].toUpperCase()}`;
    }
    return 'ODC';
}

// Helper: Cek kecocokan berkas dengan kategori target secara seragam dan aman
function isItemMatchingCategory(item, targetCat) {
    if (!item) return false;
    if (!targetCat || targetCat === 'all') return true;

    const tNorm = targetCat.trim().toUpperCase();

    // 1. Khusus kategori ODC: Satukan seluruh berkas ODC ke dalam folder ODC
    if (tNorm === 'ODC') {
        const dLabel = (item.deviceLabel || '').trim().toUpperCase();
        const fName = (item.name || '').trim().toUpperCase();
        const itemCat = (item.category || '').trim().toUpperCase();

        // Jangan masukkan evident modem pelanggan atau ODP murni ke folder ODC
        const isModem = dLabel.includes('MODEM') || fName.includes('MODEM') || Boolean(item.customerId || item.modemSn);
        if (isModem) return false;

        const isOdp = dLabel.startsWith('ODP') || fName.startsWith('EVIDENT_ODP');
        if (isOdp) return false;

        if (itemCat === 'ODC' || itemCat.startsWith('ODC')) return true;
        if (dLabel.startsWith('ODC')) return true;
        if (fName.includes('ODC')) return true;
        if (getItemOdcGroup(item)) return true;
        return false;
    }

    // 2. Khusus kategori MODEM
    if (tNorm === 'MODEM') {
        if ((item.deviceLabel && item.deviceLabel.toUpperCase().includes('MODEM')) ||
            (item.name && item.name.toUpperCase().includes('MODEM')) ||
            (item.photoType && item.photoType.toUpperCase() === 'MODEM') ||
            (item.category && item.category.toUpperCase() === 'MODEM') ||
            Boolean(item.customerId || item.customerName || item.modemSn)) {
            return true;
        }
        return false;
    }

    // 3. Khusus kategori ODP
    if (tNorm === 'ODP') {
        const dLabel = (item.deviceLabel || '').trim().toUpperCase();
        const itemCat = (item.category || '').trim().toUpperCase();
        const isModem = dLabel.includes('MODEM') || Boolean(item.customerId || item.modemSn);
        if (!isModem && (itemCat === 'ODP' || dLabel.startsWith('ODP') || Boolean(item.odpName))) {
            return true;
        }
        return false;
    }

    // 4. Khusus kategori TIANG
    if (tNorm === 'TIANG') {
        const itemCat = (item.category || '').trim().toUpperCase();
        const dLabel = (item.deviceLabel || '').trim().toUpperCase();
        if (itemCat === 'TIANG' || dLabel.startsWith('TIANG') || (item.name && item.name.toUpperCase().includes('TIANG'))) {
            return true;
        }
        return false;
    }

    // 5. Pencocokan langsung untuk kategori kustom lainnya
    const tClean = tNorm.replace(/[\s_-]+/g, '');
    const itemCat = (item.category || '').trim().toUpperCase();
    if (itemCat === tNorm || (itemCat && itemCat.replace(/[\s_-]+/g, '') === tClean)) return true;

    const itemRef = (item.odcReference || item.odc_reference || '').trim().toUpperCase();
    if (itemRef === tNorm || (itemRef && itemRef.replace(/[\s_-]+/g, '') === tClean)) return true;

    return false;
}

// Kumpulkan seluruh kategori: Satukan semua ODC ke 1 folder 'ODC', disusul TIANG, ODP, MODEM
function extractAllCategories() {
    const catMap = new Map();

    // 4 folder sistem standar selalu tersedia
    catMap.set('ODC', 'ODC');
    catMap.set('TIANG', 'TIANG');
    catMap.set('ODP', 'ODP');
    catMap.set('MODEM', 'MODEM');

    // 1. Dari tabel categories Supabase
    (categories || []).forEach(c => {
        if (!c || typeof c !== 'string') return;
        const trimmed = c.trim();
        if (!trimmed) return;
        // Semua kategori ODC (ODC, ODC-SKD 01, dll) disatukan ke folder 'ODC'
        if (trimmed.toUpperCase().startsWith('ODC')) {
            catMap.set('ODC', 'ODC');
        } else if (!catMap.has(trimmed.toUpperCase())) {
            catMap.set(trimmed.toUpperCase(), trimmed);
        }
    });

    // 2. Dari berkas evident yang ada (sampleData)
    (sampleData || []).forEach(item => {
        if (!item) return;
        
        if (item.category && typeof item.category === 'string') {
            const cat = item.category.trim();
            if (cat) {
                if (cat.toUpperCase().startsWith('ODC')) {
                    catMap.set('ODC', 'ODC');
                } else if (!catMap.has(cat.toUpperCase())) {
                    catMap.set(cat.toUpperCase(), cat);
                }
            }
        }
    });

    const standardOrder = ['ODC', 'TIANG', 'ODP', 'MODEM'];

    // Urutkan kategori: ODC pertama, lalu TIANG, ODP, MODEM, kemudian kategori kustom alfabetis
    return Array.from(catMap.values()).sort((a, b) => {
        const orderA = standardOrder.indexOf(a.toUpperCase());
        const orderB = standardOrder.indexOf(b.toUpperCase());
        if (orderA !== -1 && orderB !== -1) return orderA - orderB;
        if (orderA !== -1) return -1;
        if (orderB !== -1) return 1;
        return a.localeCompare(b);
    });
}

function renderCategoryUI() {
    const filterContainer = document.getElementById('categoryFilterContainer');
    if (!filterContainer) return;

    const allCats = extractAllCategories();
    const visibleCats = categorySearchQuery
        ? allCats.filter(c => c.toLowerCase().includes(categorySearchQuery))
        : allCats;

    let buttonsHtml = `
        <button onclick="setCategoryFilter('all')" class="cat-btn ${currentCategory === 'all' ? 'bg-slate-900 text-white font-semibold' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'} px-2.5 py-1 rounded-lg text-[11px] font-medium transition flex items-center gap-1">
            <i class="fa-solid fa-layer-group text-[9px]"></i>
            <span>Semua</span>
            <span class="text-[9.5px] opacity-70">(${sampleData.length})</span>
        </button>
    `;

    visibleCats.forEach(cat => {
        const isSelected = currentCategory === cat;
        const catUpper = cat.toUpperCase();
        const count = sampleData.filter(item => isItemMatchingCategory(item, cat)).length;
        const icon = catUpper === 'ODC' ? 'fa-folder' : (catUpper === 'TIANG' ? 'fa-tower-broadcast' : (catUpper === 'MODEM' ? 'fa-house-signal' : 'fa-wifi'));

        buttonsHtml += `
            <button onclick="setCategoryFilter('${escapeHtml(cat)}')" class="cat-btn ${isSelected ? 'bg-blue-600 text-white font-semibold shadow-xs' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'} px-2.5 py-1 rounded-lg text-[11px] font-medium transition flex items-center gap-1">
                <i class="fa-solid ${icon} text-[9px]"></i>
                <span>${escapeHtml(cat)}</span>
                <span class="text-[9.5px] opacity-75">(${count})</span>
            </button>
        `;
    });

    filterContainer.innerHTML = buttonsHtml;
    renderFolderGrid();
    renderOdpDropdown();

    const catSelect = document.getElementById('categorySelect');
    if (catSelect) {
        catSelect.innerHTML = allCats.map(cat => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`).join('');
    }

    renderCategoryManageList();
}

function renderCategoryManageList() {
    const manageList = document.getElementById('categoryManageList');
    if (!manageList) return;

    const allCats = extractAllCategories();
    const isOwner = checkIsOwner();
    const canEdit = isOwner || currentUserRole === 'editor';

    if (allCats.length === 0) {
        manageList.innerHTML = `
            <div class="text-center py-4 text-xs text-slate-400">
                Belum ada kategori yang terdaftar.
            </div>
        `;
        return;
    }

    manageList.innerHTML = allCats.map(cat => {
        const catUpper = cat.toUpperCase();
        const isSystemCat = ['ODC', 'TIANG', 'ODP', 'MODEM'].includes(catUpper);
        const count = sampleData.filter(item => isItemMatchingCategory(item, cat)).length;

        return `
            <div class="flex items-center justify-between p-2.5 bg-slate-50 hover:bg-slate-100/70 border border-slate-200 rounded-lg transition">
                <span class="text-xs font-semibold text-slate-700 flex items-center gap-1.5 min-w-0">
                    <i class="fa-solid ${catUpper === 'ODC' ? 'fa-folder text-blue-500' : (catUpper === 'TIANG' ? 'fa-tower-broadcast text-amber-500' : (catUpper === 'MODEM' ? 'fa-house-signal text-cyan-500' : 'fa-wifi text-emerald-500'))} text-xs shrink-0"></i>
                    <span class="truncate">${escapeHtml(cat)}</span>
                    <span class="text-[10px] text-slate-400 font-normal">(${count} berkas)</span>
                    ${isSystemCat ? '<span class="px-1.5 py-0.2 bg-blue-50 text-blue-600 rounded text-[9px] font-bold border border-blue-200">Sistem</span>' : ''}
                </span>
                <div class="flex items-center gap-1.5 shrink-0 ml-2">
                    ${!isSystemCat && canEdit ? `
                    <button type="button" onclick="editCategoryByName('${escapeHtml(cat)}')" 
                        class="px-2 py-1 bg-white hover:bg-blue-50 border border-slate-200 hover:border-blue-300 rounded text-slate-600 hover:text-blue-600 transition flex items-center gap-1 text-[11px] shadow-2xs" 
                        title="Edit Nama Kategori: ${escapeHtml(cat)}">
                        <i class="fa-solid fa-pen text-[10px] text-blue-500"></i>
                        <span>Edit</span>
                    </button>
                    ` : ''}
                    ${!isSystemCat && isOwner ? `
                    <button type="button" onclick="deleteCategoryByName('${escapeHtml(cat)}')" 
                        class="px-2 py-1 bg-white hover:bg-rose-50 border border-slate-200 hover:border-rose-300 rounded text-rose-600 hover:text-rose-700 transition flex items-center gap-1 text-[11px] shadow-2xs" 
                        title="Hapus Kategori (Owner): ${escapeHtml(cat)}">
                        <i class="fa-solid fa-trash text-[10px]"></i>
                        <span>Hapus</span>
                    </button>
                    ` : ''}
                </div>
            </div>
        `;
    }).join('');
}

// Render navigasi folder visual Google Drive Style di dashboard
function renderFolderGrid() {
    const grid = document.getElementById('folderGrid');
    const badge = document.getElementById('folderCountBadge');
    if (!grid) return;

    const allCats = extractAllCategories();
    const visibleCats = categorySearchQuery
        ? allCats.filter(c => c.toLowerCase().includes(categorySearchQuery))
        : allCats;

    if (badge) {
        badge.innerText = categorySearchQuery
            ? `${visibleCats.length} dari ${allCats.length} Folder`
            : `${allCats.length} Folder Kategori`;
    }

    if (visibleCats.length === 0) {
        grid.innerHTML = `
            <div class="col-span-full py-4 text-center text-xs text-slate-400">
                <i class="fa-solid fa-folder-xmark text-lg text-slate-300 mb-1 block"></i>
                Tidak ada folder kategori yang sesuai dengan "<b>${escapeHtml(categorySearchQuery)}</b>"
            </div>
        `;
        return;
    }

    const isOwner = checkIsOwner();
    const canEdit = isOwner || currentUserRole === 'editor';

    grid.innerHTML = visibleCats.map(cat => {
        const isSelected = currentCategory === cat;
        const catUpper = cat.toUpperCase();
        const isSystemCat = ['ODC', 'TIANG', 'ODP', 'MODEM'].includes(catUpper);
        const count = sampleData.filter(item => isItemMatchingCategory(item, cat)).length;
        const iconClass = catUpper === 'ODC' 
            ? 'fa-folder-closed text-blue-500' 
            : (catUpper === 'TIANG' ? 'fa-tower-broadcast text-amber-500' : (catUpper === 'MODEM' ? 'fa-house-signal text-cyan-500' : 'fa-wifi text-emerald-500'));

        return `
            <div onclick="setCategoryFilter('${isSelected ? 'all' : escapeHtml(cat)}')" 
                class="group relative cursor-pointer p-2.5 rounded-xl border transition flex items-center gap-2 select-none ${isSelected ? 'bg-blue-50/90 border-blue-400 shadow-sm ring-2 ring-blue-500/20' : 'bg-white hover:bg-slate-50 border-slate-200/80 hover:border-slate-300 shadow-xs'}">
                <div class="w-7 h-7 rounded-lg ${isSelected ? 'bg-blue-600 text-white' : 'bg-slate-100'} flex items-center justify-center text-xs shadow-xs shrink-0">
                    <i class="fa-solid ${isSelected ? 'fa-folder-open' : iconClass}"></i>
                </div>
                <div class="min-w-0 flex-1">
                    <h4 class="text-[11px] font-bold text-slate-800 truncate" title="${escapeHtml(cat)}">${escapeHtml(cat)}</h4>
                    <p class="text-[9.5px] text-slate-400 font-medium">${count} berkas</p>
                </div>
                ${!isSystemCat && canEdit ? `
                <div class="flex items-center gap-1 opacity-70 group-hover:opacity-100 transition shrink-0 ml-1">
                    <button type="button" onclick="event.stopPropagation(); editCategoryByName('${escapeHtml(cat)}');" 
                        class="w-6 h-6 flex items-center justify-center bg-slate-100 hover:bg-blue-100 text-slate-500 hover:text-blue-600 rounded-md transition shadow-2xs" 
                        title="Edit Nama Kategori: ${escapeHtml(cat)}">
                        <i class="fa-solid fa-pen text-[9.5px]"></i>
                    </button>
                    ${isOwner ? `
                    <button type="button" onclick="event.stopPropagation(); deleteCategoryByName('${escapeHtml(cat)}');" 
                        class="w-6 h-6 flex items-center justify-center bg-slate-100 hover:bg-rose-100 text-slate-500 hover:text-rose-600 rounded-md transition shadow-2xs" 
                        title="Hapus Kategori (Owner): ${escapeHtml(cat)}">
                        <i class="fa-solid fa-trash text-[9.5px]"></i>
                    </button>
                    ` : ''}
                </div>
                ` : ''}
            </div>
        `;
    }).join('');
}

function setCategoryFilter(cat) {
    currentCategory = cat;
    currentOdpFilter = 'all'; // Reset filter ODP saat ganti kategori
    renderOdpDropdown();
    renderCategoryUI();
    filterFiles();
}

async function addNewCategory() {
    if (!checkIsOwner() && currentUserRole !== 'editor') return alert('Akses ditolak: Hanya Owner dan Editor yang dapat menambah kategori!');
    const input = document.getElementById('newCategoryInput');
    const name = input.value.trim();
    if (!name) return alert('Nama kategori tidak boleh kosong!');
    if ((categories || []).map(c => (c || '').toLowerCase()).includes(name.toLowerCase())) return alert('Kategori tersebut sudah ada!');

    try {
        const { error } = await supabaseClient.from('categories').insert({ name: name });
        if (error) {
            console.warn("Gagal simpan kategori ke Supabase:", error.message);
        }
        if (!categories) categories = [];
        categories.push(name);
        input.value = '';
        renderCategoryUI();
        filterFiles();
        alert(`Kategori "${name}" berhasil ditambahkan!`);
    } catch (e) {
        alert("Error menambah kategori: " + e.message);
    }
}

async function editCategoryByName(oldName) {
    if (!checkIsOwner() && currentUserRole !== 'editor') {
        alert('Akses Ditolak: Hanya Owner Project atau Editor yang dapat mengedit nama kategori!');
        return;
    }
    
    if (!oldName) return;
    if (['ODC', 'TIANG', 'ODP', 'MODEM'].includes(oldName.toUpperCase())) {
        alert(`Kategori dasar "${oldName}" adalah folder sistem utama dan tidak dapat diubah namanya.`);
        return;
    }

    const newName = prompt(`Masukkan nama baru untuk kategori "${oldName}":`, oldName);
    if (!newName || !newName.trim() || newName.trim() === oldName) {
        return;
    }
    const trimmed = newName.trim();

    try {
        // 1. Update tabel categories di Supabase
        const { data: existRows } = await supabaseClient
            .from('categories')
            .select('id, name')
            .ilike('name', oldName);

        if (existRows && existRows.length > 0) {
            for (const r of existRows) {
                await supabaseClient.from('categories').update({ name: trimmed }).eq('id', r.id);
            }
        } else {
            await supabaseClient.from('categories').insert({ name: trimmed });
        }

        // 2. Update berkas evident di Supabase
        const isNewOdc = trimmed.toUpperCase().startsWith('ODC');
        const matchingItems = sampleData.filter(item => isItemMatchingCategory(item, oldName));

        for (const item of matchingItems) {
            const updatePayload = { category: trimmed };
            if (isNewOdc) {
                updatePayload.odc_reference = trimmed;
            }
            await supabaseClient.from('evidents').update(updatePayload).eq('id', item.id);
            
            item.category = trimmed;
            if (isNewOdc) {
                item.odcReference = trimmed;
                item.odc_reference = trimmed;
            }
        }

        // Update variasi jika ada query langsung
        await supabaseClient.from('evidents').update({ category: trimmed }).ilike('category', oldName);
        if (isNewOdc) {
            await supabaseClient.from('evidents').update({ odc_reference: trimmed }).ilike('odc_reference', oldName);
        }

        // 3. Update array categories lokal
        let found = false;
        categories = (categories || []).map(c => {
            if (c && typeof c === 'string' && c.toLowerCase().trim() === oldName.toLowerCase().trim()) {
                found = true;
                return trimmed;
            }
            return c;
        });
        if (!found) categories.push(trimmed);

        if (currentCategory && typeof currentCategory === 'string' && currentCategory.toLowerCase().trim() === oldName.toLowerCase().trim()) {
            currentCategory = trimmed;
        }

        renderCategoryUI();
        filterFiles();
        alert(`Sukses! Kategori "${oldName}" telah diubah menjadi "${trimmed}".`);
    } catch (err) {
        console.error("Gagal edit kategori:", err);
        alert("Gagal mengubah nama kategori: " + (err.message || err));
    }
}

async function deleteCategoryByName(catName) {
    if (!checkIsOwner()) {
        alert('Akses Ditolak: Fitur hapus kategori hanya dapat dilakukan oleh Owner Project!');
        return;
    }

    if (!catName) return;
    if (['ODC', 'TIANG', 'ODP', 'MODEM'].includes(catName.toUpperCase())) {
        alert(`Kategori dasar "${catName}" adalah folder sistem utama dan tidak dapat dihapus.`);
        return;
    }

    const matchingItems = sampleData.filter(item => isItemMatchingCategory(item, catName));
    const count = matchingItems.length;

    const msg = `PERINGATAN OWNER PROJECT:\nApakah Anda yakin ingin menghapus kategori "${catName}"?\n` +
        (count > 0 ? `\nTerdapat ${count} berkas evident di dalam kategori ini yang akan ikut dihapus.` : '\nKategori ini akan dihapus dari sistem.') +
        `\n\nKlik OK untuk menghapus.`;

    if (!confirm(msg)) return;

    try {
        // 1. Hapus dari tabel categories di Supabase
        await supabaseClient.from('categories').delete().ilike('name', catName);

        // 2. Hapus berkas evident di Supabase
        for (const item of matchingItems) {
            if (item && item.id) {
                await supabaseClient.from('evidents').delete().eq('id', item.id);
            }
        }
        await supabaseClient.from('evidents').delete().ilike('category', catName);

        // 3. Update memory lokal
        const catNorm = catName.trim().toUpperCase();
        categories = (categories || []).filter(c => {
            return c && typeof c === 'string' && c.trim().toUpperCase() !== catNorm;
        });

        sampleData = sampleData.filter(item => !isItemMatchingCategory(item, catName));

        if (currentCategory && typeof currentCategory === 'string' && currentCategory.trim().toUpperCase() === catNorm) {
            currentCategory = 'all';
        }

        renderCategoryUI();
        filterFiles();
        alert(`Sukses! Kategori "${catName}" berhasil dihapus dari sistem.`);
    } catch (err) {
        console.error("Gagal menghapus kategori:", err);
        alert("Gagal menghapus kategori: " + (err.message || err));
    }
}

// Wrapper index untuk kompatibilitas jika ada pemicu lama
function editCategory(index) {
    const allCats = extractAllCategories();
    if (allCats[index]) editCategoryByName(allCats[index]);
}

function deleteCategory(index) {
    const allCats = extractAllCategories();
    if (allCats[index]) deleteCategoryByName(allCats[index]);
}

function clearSearch() {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) searchInput.value = '';
    const searchField = document.getElementById('searchFieldSelect');
    if (searchField) searchField.value = 'all';
    filterFiles();
}

function filterFiles() {
    const searchInput = document.getElementById('searchInput');
    const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
    const searchFieldEl = document.getElementById('searchFieldSelect');
    const searchField = searchFieldEl ? searchFieldEl.value : 'all';

    const clearBtn = document.getElementById('clearSearchBtn');
    if (clearBtn) {
        if (query.length > 0) clearBtn.classList.remove('hidden');
        else clearBtn.classList.add('hidden');
    }

    const bannerEl = document.getElementById('searchNoticeBanner');
    const bannerText = document.getElementById('searchNoticeText');

    let filtered = [];

    if (query) {
        // Mode Pencarian: Lakukan pencarian global ke seluruh data agar tidak terhambat folder kategori aktif
        filtered = sampleData.filter(item => {
            const cName = (item.customerName || '').toLowerCase();
            const cId = (item.customerId || '').toLowerCase();
            const mSn = (item.modemSn || '').toLowerCase();
            const odpName = (item.odpName || extractOdpName(item) || '').toLowerCase();
            const fName = (item.name || '').toLowerCase();
            const dLabel = (item.deviceLabel || '').toLowerCase();
            const odcRef = (item.odcReference || '').toLowerCase();
            const uploader = (item.uploader || '').toLowerCase();
            const cat = (item.category || '').toLowerCase();

            if (searchField === 'customerName') {
                return cName.includes(query);
            } else if (searchField === 'customerId') {
                return cId.includes(query);
            } else if (searchField === 'modemSn') {
                return mSn.includes(query);
            } else if (searchField === 'odpName') {
                return odpName.includes(query);
            } else if (searchField === 'fileOrLabel') {
                return fName.includes(query) || dLabel.includes(query) || odcRef.includes(query);
            } else {
                // 'all': Cocokkan ke semua field pelanggan, SN modem, nama ODP, nama file, label, ODC, pengunggah, dsb.
                return cName.includes(query) ||
                       cId.includes(query) ||
                       mSn.includes(query) ||
                       odpName.includes(query) ||
                       fName.includes(query) ||
                       dLabel.includes(query) ||
                       odcRef.includes(query) ||
                       uploader.includes(query) ||
                       cat.includes(query);
            }
        });

        if (bannerEl && bannerText) {
            bannerEl.classList.remove('hidden');
            const fieldLabels = {
                all: 'Semua Kolom',
                customerName: 'Nama Pelanggan',
                customerId: 'ID Pelanggan',
                modemSn: 'SN Modem',
                odpName: 'Nama ODP',
                fileOrLabel: 'File & Label'
            };
            bannerText.innerHTML = `Ditemukan <b>${filtered.length}</b> berkas untuk kata kunci "<b>${escapeHtml(query)}</b>" (Filter: <b>${fieldLabels[searchField] || 'Semua Kolom'}</b>)`;
        }
    } else {
        if (bannerEl) bannerEl.classList.add('hidden');

        // Mode Tampilan Folder Kategori Normal
        filtered = sampleData.filter(item => {
            return isItemMatchingCategory(item, currentCategory);
        });
    }

    // Filter tambahan ODP jika user memilih ODP tertentu di dropdown
    if (currentOdpFilter && currentOdpFilter !== 'all') {
        const targetNorm = currentOdpFilter.trim().toUpperCase().replace(/[\s_-]+/g, '');
        filtered = filtered.filter(item => {
            const itemOdp = (item.odpName || extractOdpName(item) || '').trim().toUpperCase().replace(/[\s_-]+/g, '');
            return itemOdp === targetNorm;
        });
    }

    renderTable(filtered, Boolean(query) || currentOdpFilter !== 'all');
    renderFolderGrid();
    renderOdpDropdown();
    renderOdcDropdownInSearch();
}

// Render dropdown ODC di area pencarian (untuk filter ODP berdasarkan induk ODC)
function renderOdcDropdownInSearch() {
    const dropdown = document.getElementById('odcSearchDropdown');
    if (!dropdown) return;

    // Hanya tampil saat folder ODP aktif
    const container = document.getElementById('odcSearchDropdownContainer');
    if (container) {
        if (currentCategory === 'ODP') {
            container.classList.remove('hidden');
        } else {
            container.classList.add('hidden');
        }
    }

    if (currentCategory !== 'ODP') return;

    // Kumpulkan nama ODC unik dari data
    const odcSet = new Set();
    sampleData.forEach(item => {
        const ref = item.odcReference || item.odc_reference || '';
        if (ref && ref.toUpperCase().startsWith('ODC')) {
            odcSet.add(ref.trim());
        }
        const cat = item.category || '';
        if (cat.toUpperCase().startsWith('ODC')) {
            odcSet.add(cat.trim());
        }
    });

    const odcList = Array.from(odcSet).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const currentVal = dropdown.value;

    dropdown.innerHTML = `<option value="all">🌐 Semua ODC (${odcList.length} ODC)</option>`;
    odcList.forEach(odc => {
        const opt = document.createElement('option');
        opt.value = odc;
        opt.textContent = `📡 ${odc}`;
        if (odc === currentVal) opt.selected = true;
        dropdown.appendChild(opt);
    });
}

// =====================================================================
// RENDER TABLE ODP: Khusus folder ODP → 1 baris per unit ODP dengan
// kolom: NAMA ODP | INDUK ODC | SHARE LOC | TAMPAK LUAR | TAMPAK DALAM |
//        FOTO REDAMAN | FOTO LABEL | PENGUNGGAH | TANGGAL & WAKTU | AKSI
// =====================================================================
function setOdpTableHeader() {
    const thead = document.getElementById('fileTableHead');
    if (!thead) return;
    thead.innerHTML = `
        <tr class="bg-green-50/80 border-b border-green-200/80 text-green-700 text-[10.5px] font-bold uppercase tracking-wider">
            <th class="py-2.5 px-3 min-w-[130px]"><i class="fa-solid fa-folder mr-1 text-green-500"></i>Nama ODP</th>
            <th class="py-2.5 px-3"><i class="fa-solid fa-network-wired mr-1 text-blue-400"></i>Induk ODC</th>
            <th class="py-2.5 px-3 text-center"><i class="fa-solid fa-location-dot mr-1 text-emerald-500"></i>Share Loc</th>
            <th class="py-2.5 px-3 text-center"><i class="fa-solid fa-door-open mr-1 text-blue-400"></i>Tampak Luar</th>
            <th class="py-2.5 px-3 text-center"><i class="fa-solid fa-boxes-stacked mr-1 text-indigo-400"></i>Tampak Dalam</th>
            <th class="py-2.5 px-3 text-center"><i class="fa-solid fa-gauge-high mr-1 text-orange-400"></i>Foto Redaman</th>
            <th class="py-2.5 px-3 text-center"><i class="fa-solid fa-tag mr-1 text-purple-400"></i>Foto Label</th>
            <th class="py-2.5 px-3"><i class="fa-solid fa-user-pen mr-1 text-slate-400"></i>Pengunggah</th>
            <th class="py-2.5 px-3"><i class="fa-solid fa-calendar mr-1 text-slate-400"></i>Tanggal &amp; Waktu</th>
            <th class="py-2.5 px-3 text-right">Aksi</th>
        </tr>
    `;
}

function buildOdpGroupedRow(odpName, items, canEdit) {
    const norm = s => (s || '').toUpperCase().replace(/[\s_-]+/g, '');
    const matchType = (item, ...types) => {
        const ptype = (item.photoType || '').toUpperCase();
        const dname = (item.deviceLabel || item.name || '').toUpperCase();
        return types.some(t => ptype.includes(norm(t)) || dname.includes(norm(t)));
    };

    const findPhoto = (...types) => items.find(it => matchType(it, ...types)) || null;

    const photoLuar  = findPhoto('TAMPAK LUAR', 'LUAR', 'DEPAN', 'OUTDOOR');
    const photoDalam = findPhoto('TAMPAK DALAM', 'DALAM', 'INDOOR', 'BAKI', 'SPLITTER', 'TRAY');
    const photoRed   = findPhoto('REDAMAN', 'OPM', 'LOSS', 'DBM');
    const photoLabel = findPhoto('LABEL', 'STIKER', 'STICKER', 'PLANG');

    const locItem = items.find(it => it.locationUrl) || null;
    const locationUrl = locItem ? locItem.locationUrl : null;

    // Cari nama ODC induk dari item
    const odcInduk = (() => {
        for (const it of items) {
            const ref = it.odcReference || it.odc_reference || '';
            if (ref) return ref;
            const cat = it.category || '';
            if (cat.toUpperCase().startsWith('ODC')) return cat;
        }
        return '-';
    })();

    const newest = items.reduce((a, b) => ((a.id || 0) > (b.id || 0) ? a : b), items[0] || {});

    const photoBtn = (item, label, colorClass, iconClass) => item
        ? `<button onclick="previewFile(${item.id})"
                class="inline-flex flex-col items-center justify-center gap-0.5 w-full px-1.5 py-1.5 ${colorClass} rounded-lg font-semibold text-[10px] transition shadow-xs whitespace-nowrap cursor-pointer border"
                title="Lihat ${label} (${item.size || '-'})">
                <i class="fa-solid ${iconClass} text-[11px]"></i>
                <span class="text-[9px] leading-tight">View</span>
           </button>`
        : `<div class="inline-flex flex-col items-center justify-center gap-0.5 w-full px-1.5 py-1.5 bg-slate-50 text-slate-300 border border-slate-200/60 rounded-lg text-[9px] opacity-60 cursor-not-allowed" title="${label} belum diupload">
                <i class="fa-solid ${iconClass} text-[10px]"></i>
                <span>-</span>
           </div>`;

    const luarBtn   = photoBtn(photoLuar,  'Tampak Luar',  'bg-blue-50 hover:bg-blue-100 text-blue-800 border-blue-200',     'fa-door-open');
    const dalamBtn  = photoBtn(photoDalam, 'Tampak Dalam', 'bg-indigo-50 hover:bg-indigo-100 text-indigo-800 border-indigo-200', 'fa-boxes-stacked');
    const redBtn    = photoBtn(photoRed,   'Foto Redaman', 'bg-orange-50 hover:bg-orange-100 text-orange-800 border-orange-200', 'fa-gauge-high');
    const labelBtn  = photoBtn(photoLabel, 'Foto Label',   'bg-purple-50 hover:bg-purple-100 text-purple-800 border-purple-200', 'fa-tag');

    const locCell = locationUrl
        ? `<a href="${escapeHtml(locationUrl)}" target="_blank"
              class="inline-flex flex-col items-center gap-0.5 px-2 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded-lg text-[10px] font-bold transition shadow-xs w-full"
              title="Buka Titik Lokasi GPS ODP">
              <i class="fa-solid fa-location-dot text-emerald-600 text-[11px]"></i>
              <span class="text-[9px]">Maps</span>
           </a>`
        : `<div class="inline-flex flex-col items-center gap-0.5 px-2 py-1.5 bg-slate-50 text-slate-300 border border-slate-200/60 rounded-lg text-[9px] opacity-60 cursor-not-allowed w-full" title="GPS belum dibagikan">
              <i class="fa-solid fa-location-dot text-[10px]"></i>
              <span>-</span>
           </div>`;

    const isOwner = checkIsOwner();
    const allIds = items.map(it => it.id).filter(Boolean);
    const deleteGroupBtn = isOwner && allIds.length > 0
        ? `<button onclick="deleteOdpGroup('${escapeHtml(odpName)}', [${allIds.join(',')}])"
                class="inline-flex items-center gap-1 px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-lg text-[10px] font-semibold transition shadow-xs"
                title="Hapus Semua Evident ODP ${escapeHtml(odpName)} (Owner)">
                <i class="fa-solid fa-trash-can text-[9px]"></i>
                <span>Hapus</span>
           </button>`
        : '';

    const photoCount = items.length;

    const tr = document.createElement('tr');
    tr.className = 'bg-green-50/40 hover:bg-green-50 border-b border-green-100 transition';
    tr.innerHTML = `
        <td class="py-2.5 px-3">
            <div class="flex flex-col gap-0.5">
                <span class="inline-flex items-center gap-1.5 font-bold text-green-800 text-[11px]">
                    <i class="fa-solid fa-folder-closed text-green-500 text-[10px]"></i>
                    ${escapeHtml(odpName)}
                </span>
                <span class="text-[9.5px] text-slate-400">${photoCount} foto evident</span>
            </div>
        </td>
        <td class="py-2.5 px-3">
            <span class="inline-flex items-center gap-1 text-blue-700 font-semibold text-[10px]">
                <i class="fa-solid fa-network-wired text-blue-400 text-[9px]"></i>
                ${escapeHtml(odcInduk)}
            </span>
        </td>
        <td class="py-2.5 px-3 text-center">
            <div class="flex justify-center w-full max-w-[52px] mx-auto">${locCell}</div>
        </td>
        <td class="py-2.5 px-3 text-center">
            <div class="flex justify-center w-full max-w-[52px] mx-auto">${luarBtn}</div>
        </td>
        <td class="py-2.5 px-3 text-center">
            <div class="flex justify-center w-full max-w-[52px] mx-auto">${dalamBtn}</div>
        </td>
        <td class="py-2.5 px-3 text-center">
            <div class="flex justify-center w-full max-w-[52px] mx-auto">${redBtn}</div>
        </td>
        <td class="py-2.5 px-3 text-center">
            <div class="flex justify-center w-full max-w-[52px] mx-auto">${labelBtn}</div>
        </td>
        <td class="py-2.5 px-3 font-medium text-slate-700 text-[10.5px]">${escapeHtml(newest.uploader || '-')}</td>
        <td class="py-2.5 px-3 text-slate-400 text-[10.5px]">${escapeHtml(newest.date || '-')}</td>
        <td class="py-2.5 px-3 text-right whitespace-nowrap">${deleteGroupBtn}</td>
    `;
    return tr;
}

// Helper: Hapus semua evident dalam satu grup ODP (Owner only)
async function deleteOdpGroup(odpName, ids) {
    if (!checkIsOwner()) return alert('Akses Ditolak: Hanya Owner yang dapat menghapus.');
    if (!confirm(`PERINGATAN OWNER:\nHapus semua ${ids.length} foto evident untuk ${odpName}?\n\nAksi ini tidak dapat dibatalkan.`)) return;

    let failed = 0;
    for (const id of ids) {
        try {
            const item = sampleData.find(d => d.id === id);
            if (item && item.fileUrl) {
                const fileName = item.fileUrl.split('/').pop().split('?')[0];
                try { await supabaseClient.storage.from('evidents').remove([`uploads/${decodeURIComponent(fileName)}`]); } catch (e) {}
            }
            const { error } = await supabaseClient.from('evidents').delete().eq('id', id);
            if (error) failed++;
            else sampleData = sampleData.filter(d => d.id !== id);
        } catch (e) { failed++; }
    }

    renderCategoryUI();
    filterFiles();
    if (failed > 0) alert(`Selesai. ${ids.length - failed} berhasil dihapus, ${failed} gagal.`);
    else alert(`Semua evident ODP "${odpName}" berhasil dihapus.`);
}

// =====================================================================
// RENDER TABLE ODC: Khusus folder ODC → 1 baris per unit ODC dengan
// kolom: NAMA ODC | SHARE LOC | TAMPAK LUAR | TAMPAK DALAM |
//        FOTO REDAMAN | FOTO LABEL | PENGUNGGAH | TANGGAL & WAKTU | AKSI
// =====================================================================
function setOdcTableHeader() {
    const thead = document.getElementById('fileTableHead');
    if (!thead) return;
    thead.innerHTML = `
        <tr class="bg-blue-50/80 border-b border-blue-200/80 text-blue-700 text-[10.5px] font-bold uppercase tracking-wider">
            <th class="py-2.5 px-3 min-w-[130px]"><i class="fa-solid fa-folder mr-1 text-blue-500"></i>Nama ODC</th>
            <th class="py-2.5 px-3 text-center"><i class="fa-solid fa-location-dot mr-1 text-emerald-500"></i>Share Loc</th>
            <th class="py-2.5 px-3 text-center"><i class="fa-solid fa-door-open mr-1 text-blue-400"></i>Tampak Luar</th>
            <th class="py-2.5 px-3 text-center"><i class="fa-solid fa-boxes-stacked mr-1 text-indigo-400"></i>Tampak Dalam</th>
            <th class="py-2.5 px-3 text-center"><i class="fa-solid fa-gauge-high mr-1 text-orange-400"></i>Foto Redaman</th>
            <th class="py-2.5 px-3 text-center"><i class="fa-solid fa-tag mr-1 text-purple-400"></i>Foto Label</th>
            <th class="py-2.5 px-3"><i class="fa-solid fa-user-pen mr-1 text-slate-400"></i>Pengunggah</th>
            <th class="py-2.5 px-3"><i class="fa-solid fa-calendar mr-1 text-slate-400"></i>Tanggal &amp; Waktu</th>
            <th class="py-2.5 px-3 text-right">Aksi</th>
        </tr>
    `;
}

function setDefaultTableHeader() {
    const thead = document.getElementById('fileTableHead');
    if (!thead) return;
    thead.innerHTML = `
        <tr class="bg-slate-50/80 border-b border-slate-200/80 text-slate-500 text-[10.5px] font-bold uppercase tracking-wider">
            <th class="py-2.5 px-3">File Evident</th>
            <th class="py-2.5 px-3">ID Pelanggan</th>
            <th class="py-2.5 px-3">Nama Pelanggan</th>
            <th class="py-2.5 px-3">SN Modem</th>
            <th class="py-2.5 px-3">Nama ODP</th>
            <th class="py-2.5 px-3">Kategori</th>
            <th class="py-2.5 px-3">Pengunggah</th>
            <th class="py-2.5 px-3">Tanggal &amp; Waktu</th>
            <th class="py-2.5 px-3 text-right">Aksi</th>
        </tr>
    `;
}

// Helper: Bangun baris ODC grouped (1 baris per unit ODC)
function buildOdcGroupedRow(odcName, items, canEdit) {
    // Cari foto per jenis dari semua item yang termasuk unit ODC ini
    const norm = s => (s || '').toUpperCase().replace(/[\s_-]+/g, '');
    const matchType = (item, ...types) => {
        const ptype = (item.photoType || '').toUpperCase();
        const dname = (item.deviceLabel || item.name || '').toUpperCase();
        return types.some(t => ptype.includes(norm(t)) || dname.includes(norm(t)));
    };

    const findPhoto = (...types) => items.find(it => matchType(it, ...types)) || null;

    const photoLuar  = findPhoto('TAMPAK LUAR', 'LUAR', 'DEPAN', 'OUTDOOR');
    const photoDalam = findPhoto('TAMPAK DALAM', 'DALAM', 'INDOOR', 'BAKI', 'SPLITTER', 'TRAY');
    const photoRed   = findPhoto('REDAMAN', 'OPM', 'LOSS', 'DBM');
    const photoLabel = findPhoto('LABEL', 'STIKER', 'STICKER', 'PLANG');

    // Share Loc: ambil dari item manapun yang punya locationUrl
    const locItem = items.find(it => it.locationUrl) || null;
    const locationUrl = locItem ? locItem.locationUrl : null;

    // Pengunggah & Tanggal: dari item terbaru
    const newest = items.reduce((a, b) => ((a.id || 0) > (b.id || 0) ? a : b), items[0] || {});

    // Foto button builder
    const photoBtn = (item, label, colorClass, iconClass) => item
        ? `<button onclick="previewFile(${item.id})"
                class="inline-flex flex-col items-center justify-center gap-0.5 w-full px-1.5 py-1.5 ${colorClass} rounded-lg font-semibold text-[10px] transition shadow-xs whitespace-nowrap cursor-pointer border"
                title="Lihat ${label} (${item.size || '-'})">
                <i class="fa-solid ${iconClass} text-[11px]"></i>
                <span class="text-[9px] leading-tight">View</span>
           </button>`
        : `<div class="inline-flex flex-col items-center justify-center gap-0.5 w-full px-1.5 py-1.5 bg-slate-50 text-slate-300 border border-slate-200/60 rounded-lg text-[9px] opacity-60 cursor-not-allowed" title="${label} belum diupload">
                <i class="fa-solid ${iconClass} text-[10px]"></i>
                <span>-</span>
           </div>`;

    const luarBtn   = photoBtn(photoLuar,  'Tampak Luar',  'bg-blue-50 hover:bg-blue-100 text-blue-800 border-blue-200',     'fa-door-open');
    const dalamBtn  = photoBtn(photoDalam, 'Tampak Dalam', 'bg-indigo-50 hover:bg-indigo-100 text-indigo-800 border-indigo-200', 'fa-boxes-stacked');
    const redBtn    = photoBtn(photoRed,   'Foto Redaman', 'bg-orange-50 hover:bg-orange-100 text-orange-800 border-orange-200', 'fa-gauge-high');
    const labelBtn  = photoBtn(photoLabel, 'Foto Label',   'bg-purple-50 hover:bg-purple-100 text-purple-800 border-purple-200', 'fa-tag');

    const locCell = locationUrl
        ? `<a href="${escapeHtml(locationUrl)}" target="_blank"
              class="inline-flex flex-col items-center gap-0.5 px-2 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded-lg text-[10px] font-bold transition shadow-xs w-full"
              title="Buka Titik Lokasi GPS">
              <i class="fa-solid fa-location-dot text-emerald-600 text-[11px]"></i>
              <span class="text-[9px]">Maps</span>
           </a>`
        : `<div class="inline-flex flex-col items-center gap-0.5 px-2 py-1.5 bg-slate-50 text-slate-300 border border-slate-200/60 rounded-lg text-[9px] opacity-60 cursor-not-allowed w-full" title="GPS belum dibagikan">
              <i class="fa-solid fa-location-dot text-[10px]"></i>
              <span>-</span>
           </div>`;

    // Aksi: hapus semua evident dalam grup ini (owner only), plus preview
    const isOwner = checkIsOwner();
    const allIds = items.map(it => it.id).filter(Boolean);
    const deleteGroupBtn = isOwner && allIds.length > 0
        ? `<button onclick="deleteOdcGroup('${escapeHtml(odcName)}', [${allIds.join(',')}])"
                class="inline-flex items-center gap-1 px-2 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-lg text-[10px] font-semibold transition shadow-xs"
                title="Hapus Semua Evident ODC ${escapeHtml(odcName)} (Owner)">
                <i class="fa-solid fa-trash-can text-[9px]"></i>
                <span>Hapus</span>
           </button>`
        : '';

    const photoCount = items.length;

    const tr = document.createElement('tr');
    tr.className = 'bg-blue-50/40 hover:bg-blue-50 border-b border-blue-100 transition';
    tr.innerHTML = `
        <td class="py-2.5 px-3">
            <div class="flex flex-col gap-0.5">
                <span class="inline-flex items-center gap-1.5 font-bold text-blue-800 text-[11px]">
                    <i class="fa-solid fa-folder-closed text-blue-500 text-[10px]"></i>
                    ${escapeHtml(odcName)}
                </span>
                <span class="text-[9.5px] text-slate-400">${photoCount} foto evident</span>
            </div>
        </td>
        <td class="py-2.5 px-3 text-center">
            <div class="flex justify-center w-full max-w-[52px] mx-auto">${locCell}</div>
        </td>
        <td class="py-2.5 px-3 text-center">
            <div class="flex justify-center w-full max-w-[52px] mx-auto">${luarBtn}</div>
        </td>
        <td class="py-2.5 px-3 text-center">
            <div class="flex justify-center w-full max-w-[52px] mx-auto">${dalamBtn}</div>
        </td>
        <td class="py-2.5 px-3 text-center">
            <div class="flex justify-center w-full max-w-[52px] mx-auto">${redBtn}</div>
        </td>
        <td class="py-2.5 px-3 text-center">
            <div class="flex justify-center w-full max-w-[52px] mx-auto">${labelBtn}</div>
        </td>
        <td class="py-2.5 px-3 font-medium text-slate-700 text-[10.5px]">${escapeHtml(newest.uploader || '-')}</td>
        <td class="py-2.5 px-3 text-slate-400 text-[10.5px]">${escapeHtml(newest.date || '-')}</td>
        <td class="py-2.5 px-3 text-right whitespace-nowrap">${deleteGroupBtn}</td>
    `;
    return tr;
}

// Helper: Hapus semua evident dalam satu grup ODC (Owner only)
async function deleteOdcGroup(odcName, ids) {
    if (!checkIsOwner()) return alert('Akses Ditolak: Hanya Owner yang dapat menghapus.');
    if (!confirm(`PERINGATAN OWNER:\nHapus semua ${ids.length} foto evident untuk ${odcName}?\n\nAksi ini tidak dapat dibatalkan.`)) return;

    let failed = 0;
    for (const id of ids) {
        try {
            const item = sampleData.find(d => d.id === id);
            if (item && item.fileUrl) {
                const fileName = item.fileUrl.split('/').pop().split('?')[0];
                try { await supabaseClient.storage.from('evidents').remove([`uploads/${decodeURIComponent(fileName)}`]); } catch (e) {}
            }
            const { error } = await supabaseClient.from('evidents').delete().eq('id', id);
            if (error) failed++;
            else sampleData = sampleData.filter(d => d.id !== id);
        } catch (e) { failed++; }
    }

    renderCategoryUI();
    filterFiles();
    if (failed > 0) alert(`Selesai. ${ids.length - failed} berhasil dihapus, ${failed} gagal.`);
    else alert(`Semua evident ODC "${odcName}" berhasil dihapus.`);
}

function renderTable(data, isSearchMode = false) {
    const tbody = document.getElementById('fileTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const canEdit = currentUserRole === 'owner' || currentUserRole === 'editor';

    // ===== MODE KHUSUS: Folder ODP → Tampilkan tabel grouped per unit ODP =====
    if (currentCategory === 'ODP' && !isSearchMode) {
        setOdpTableHeader();

        // Ambil ODC filter dari dropdown (jika ada)
        const odcDropdownEl = document.getElementById('odcSearchDropdown');
        const selectedOdcFilter = odcDropdownEl ? odcDropdownEl.value : 'all';

        const odpData = data && data.length > 0 ? data : sampleData.filter(item => {
            const cat = (item.category || '').toUpperCase();
            const lbl = (item.deviceLabel || '').toUpperCase();
            return cat === 'ODP' || lbl.startsWith('ODP');
        });

        // Filter berdasarkan ODC yang dipilih di dropdown
        let filteredOdpData = odpData;
        if (selectedOdcFilter && selectedOdcFilter !== 'all') {
            const selNorm = selectedOdcFilter.trim().toUpperCase();
            filteredOdpData = odpData.filter(item => {
                const ref = (item.odcReference || item.odc_reference || item.category || '').toUpperCase();
                return ref.includes(selNorm) || selNorm.includes(ref.replace(/^ODC[-\s]*/,''));
            });
        }

        if (!filteredOdpData || filteredOdpData.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="10" class="py-10 text-center text-slate-400">
                        <i class="fa-solid fa-folder-open text-2xl text-slate-300 mb-1.5 block"></i>
                        <p class="font-medium text-xs">Belum ada berkas evident ODP yang tersimpan.</p>
                    </td>
                </tr>
            `;
            updateStats();
            return;
        }

        // Grup berdasarkan nama unit ODP
        const odpGroups = {};
        filteredOdpData.forEach(item => {
            const odpName = (item.odpName || extractOdpName(item) || (item.deviceLabel || '').replace(/\s*\[.*\]$/,'').trim() || 'ODP Tidak Diketahui');
            const key = odpName.trim().toUpperCase();
            if (!odpGroups[key]) odpGroups[key] = { name: odpName, items: [] };
            odpGroups[key].items.push(item);
        });

        // Urutkan nama ODP secara natural
        const sortedOdpNames = Object.keys(odpGroups).sort((a, b) =>
            odpGroups[a].name.localeCompare(odpGroups[b].name, undefined, { numeric: true, sensitivity: 'base' })
        );
        sortedOdpNames.forEach(key => {
            tbody.appendChild(buildOdpGroupedRow(odpGroups[key].name, odpGroups[key].items, canEdit));
        });

        updateStats();
        return;
    }

    // ===== MODE KHUSUS: Folder ODC → Tampilkan tabel grouped per unit ODC =====
    if (currentCategory === 'ODC' && !isSearchMode && currentOdpFilter === 'all') {
        setOdcTableHeader();

        if (!data || data.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="9" class="py-10 text-center text-slate-400">
                        <i class="fa-solid fa-folder-open text-2xl text-slate-300 mb-1.5 block"></i>
                        <p class="font-medium text-xs">Belum ada berkas evident ODC yang tersimpan.</p>
                    </td>
                </tr>
            `;
            updateStats();
            return;
        }

        // Grup berdasarkan nama unit ODC
        const odcGroups = {};
        data.forEach(item => {
            const unitName = getOdcUnitName(item);
            if (!odcGroups[unitName]) odcGroups[unitName] = [];
            odcGroups[unitName].push(item);
        });

        // Urutkan nama ODC secara alfabetis
        const sortedNames = Object.keys(odcGroups).sort((a, b) => a.localeCompare(b));
        sortedNames.forEach(name => {
            tbody.appendChild(buildOdcGroupedRow(name, odcGroups[name], canEdit));
        });

        updateStats();
        return;
    }

    // ===== MODE NORMAL: kembalikan header default =====
    setDefaultTableHeader();

    if (!data || data.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="9" class="py-10 text-center text-slate-400">
                    <i class="fa-solid fa-folder-open text-2xl text-slate-300 mb-1.5 block"></i>
                    <p class="font-medium text-xs">${isSearchMode ? 'Tidak ada berkas yang cocok dengan filter / pencarian.' : 'Belum ada berkas evident di folder / kategori ini.'}</p>
                </td>
            </tr>
        `;
        updateStats();
        return;
    }

    // Jika sedang dalam mode pencarian atau filter ODP aktif, tampilkan item langsung
    if (isSearchMode || currentOdpFilter !== 'all') {
        data.forEach(item => {
            tbody.appendChild(buildRow(item, canEdit, false, false));
        });
        updateStats();
        return;
    }

    // ===== GROUPING: ODC menjadi induk, ODP & Modem anak masuk ke bawah ODC yang sesuai =====
    const odcInduk = {};
    const odcItems = [];
    const otherItems = [];

    const extractBase = (label) => {
        if (!label) return null;
        return label.replace(/\s*\[[^\]]+\]\s*$/, '').trim().toUpperCase();
    };

    data.forEach(item => {
        const isModem = (item.deviceLabel && item.deviceLabel.toUpperCase().includes('MODEM')) ||
                        (item.name && item.name.toUpperCase().includes('MODEM')) ||
                        (item.photoType && item.photoType.toUpperCase() === 'MODEM') ||
                        (item.category && item.category.toUpperCase() === 'MODEM');
        const isOdp = !isModem && (item.deviceLabel && item.deviceLabel.toUpperCase().startsWith('ODP'));
        const isOdc = !isModem && !isOdp && (
            (item.deviceLabel && item.deviceLabel.toUpperCase().startsWith('ODC')) || 
            (item.category && item.category.toUpperCase().startsWith('ODC'))
        );

        if (isOdc) {
            odcItems.push(item);
        } else if (isOdp || isModem) {
            const key = getItemOdcGroup(item) || '__ORPHAN__';
            if (!odcInduk[key]) odcInduk[key] = [];
            odcInduk[key].push(item);
        } else {
            otherItems.push(item);
        }
    });

    // Render ODC induk + ODP & Modem anak di bawahnya
    odcItems.forEach(odc => {
        const baseOdc = getItemOdcGroup(odc) || extractBase(odc.deviceLabel) || (odc.name || '').toUpperCase();
        const norm = (s) => (s || '').replace(/[\s_-]+/g, '').toUpperCase();

        let childs = odcInduk[baseOdc] || [];
        if (childs.length === 0) {
            Object.keys(odcInduk).forEach(ref => {
                if (ref !== '__ORPHAN__' && norm(ref) === norm(baseOdc)) {
                    childs = childs.concat(odcInduk[ref]);
                }
            });
        }

        tbody.appendChild(buildRow(odc, canEdit, true, false));

        childs.forEach(childItem => {
            tbody.appendChild(buildRow(childItem, canEdit, false, true));
        });

        delete odcInduk[baseOdc];
        Object.keys(odcInduk).forEach(ref => {
            if (ref !== '__ORPHAN__' && norm(ref) === norm(baseOdc)) delete odcInduk[ref];
        });
    });

    // Render ODP/Modem orphan (tanpa induk ODC yang muncul di filter saat ini)
    Object.keys(odcInduk).forEach(ref => {
        odcInduk[ref].forEach(childItem => tbody.appendChild(buildRow(childItem, canEdit, false, true)));
    });

    // Render TIANG dan kategori lainnya
    otherItems.forEach(item => tbody.appendChild(buildRow(item, canEdit, false, false)));

    updateStats();
}

// Helper pembuat baris tabel (dipakai renderTable) dengan font compact dan tampilan nama bersih
function buildRow(item, canEdit, isOdcHeader = false, isChild = false) {
    const tr = document.createElement('tr');
    tr.className = isOdcHeader
        ? 'bg-blue-50/50 hover:bg-blue-50 border-t-2 border-blue-200 transition'
        : isChild
            ? 'bg-slate-50/30 hover:bg-slate-100 transition'
            : 'hover:bg-slate-50 transition';

    const isModemItem = (item.deviceLabel && item.deviceLabel.toUpperCase().includes('MODEM')) ||
                        (item.name && item.name.toUpperCase().includes('MODEM')) ||
                        (item.photoType && item.photoType.toUpperCase() === 'MODEM') ||
                        (item.category && item.category.toUpperCase() === 'MODEM') ||
                        Boolean(item.customerId || item.customerName || item.modemSn);

    const indent = isChild ? '<span class="inline-block w-4 sm:w-5"></span>' : '';
    const childIcon = isChild
        ? (isModemItem
            ? '<i class="fa-solid fa-house-signal text-cyan-600 text-[10px] mr-1" title="Evident Modem Pelanggan"></i>'
            : '<i class="fa-solid fa-turn-up fa-rotate-90 text-indigo-400 text-[9px] mr-1" title="Evident ODP Anak"></i>')
        : '';

    const odcGroup = getItemOdcGroup(item);
    const categoryBadge = odcGroup 
        ? `<span class="px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-200/60 rounded text-[10.5px] font-semibold inline-flex items-center gap-1"><i class="fa-solid fa-folder text-[9px]"></i> ${escapeHtml(odcGroup)}</span>`
        : `<span class="px-2 py-0.5 ${item.category === 'TIANG' ? 'bg-amber-50 text-amber-700 border border-amber-200/60' : (isModemItem ? 'bg-cyan-50 text-cyan-700 border border-cyan-200/60' : 'bg-slate-100 text-slate-700')} rounded text-[10.5px] font-semibold">${escapeHtml(item.category)}</span>`;

    let labelBadge = '';
    if (item.deviceLabel) {
        if (isOdcHeader) {
            labelBadge = `<span class="font-bold text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded text-[10.5px] mr-1">${escapeHtml(item.deviceLabel)}</span>`;
        } else if (isModemItem) {
            labelBadge = `<span class="font-bold text-cyan-800 bg-cyan-100/80 border border-cyan-200 px-1.5 py-0.5 rounded text-[10.5px] mr-1"><i class="fa-solid fa-house-signal text-[8.5px] mr-1"></i>${escapeHtml(item.deviceLabel)}</span>`;
        } else {
            labelBadge = `<span class="font-bold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded text-[10.5px] mr-1">${escapeHtml(item.deviceLabel)}</span>`;
        }
    }

    // Dapatkan pasangan foto sejajar (View Depan & View Belakang, atau View Luar & View Dalam)
    const pair = getPairedEvidents(item, sampleData);
    let pairedButtonsHtml = '';

    if (pair.type === 'modem') {
        const frontHtml = pair.front
            ? `<button onclick="previewFile(${pair.front.id})" class="inline-flex items-center gap-1 px-2.5 py-1 bg-cyan-50 hover:bg-cyan-100 text-cyan-800 border border-cyan-300 rounded-md font-bold text-[10px] transition shadow-2xs whitespace-nowrap cursor-pointer" title="Buka View Depan (${pair.front.size || '-'})">
                 <i class="fa-solid fa-camera text-[9px] text-cyan-600"></i>
                 <span>View Depan</span>
               </button>`
            : `<span class="inline-flex items-center gap-1 px-2 py-1 bg-slate-50 text-slate-400 border border-slate-200/80 rounded-md text-[10px] whitespace-nowrap opacity-60 cursor-not-allowed" title="Foto Depan Belum Diupload">
                 <i class="fa-solid fa-camera text-[8.5px]"></i> View Depan
               </span>`;

        const backHtml = pair.back
            ? `<button onclick="previewFile(${pair.back.id})" class="inline-flex items-center gap-1 px-2.5 py-1 bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 rounded-md font-bold text-[10px] transition shadow-2xs whitespace-nowrap cursor-pointer" title="Buka View Belakang / SN (${pair.back.size || '-'})">
                 <i class="fa-solid fa-barcode text-[9px] text-amber-700"></i>
                 <span>View Belakang</span>
               </button>`
            : `<span class="inline-flex items-center gap-1 px-2 py-1 bg-slate-50 text-slate-400 border border-slate-200/80 rounded-md text-[10px] whitespace-nowrap opacity-60 cursor-not-allowed" title="Foto Belakang Belum Diupload">
                 <i class="fa-solid fa-barcode text-[8.5px]"></i> View Belakang
               </span>`;

        pairedButtonsHtml = `
            <div class="inline-flex items-center gap-1.5 flex-nowrap">
                ${frontHtml}
                ${backHtml}
            </div>
        `;
    } else if (pair.type === 'odc_odp') {
        const luarHtml = pair.luar
            ? `<button onclick="previewFile(${pair.luar.id})" class="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-50 hover:bg-blue-100 text-blue-800 border border-blue-300 rounded-md font-bold text-[10px] transition shadow-2xs whitespace-nowrap cursor-pointer" title="Buka View Luar (${pair.luar.size || '-'})">
                 <i class="fa-solid fa-door-open text-[9px] text-blue-600"></i>
                 <span>View Luar</span>
               </button>`
            : `<span class="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-50 text-slate-400 border border-slate-200/80 rounded-md text-[10px] whitespace-nowrap opacity-60 cursor-not-allowed">
                 <i class="fa-solid fa-door-open text-[8.5px]"></i> View Luar
               </span>`;

        const dalamHtml = pair.dalam
            ? `<button onclick="previewFile(${pair.dalam.id})" class="inline-flex items-center gap-1 px-2.5 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-800 border border-indigo-300 rounded-md font-bold text-[10px] transition shadow-2xs whitespace-nowrap cursor-pointer" title="Buka View Dalam (${pair.dalam.size || '-'})">
                 <i class="fa-solid fa-boxes-stacked text-[9px] text-indigo-600"></i>
                 <span>View Dalam</span>
               </button>`
            : `<span class="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-50 text-slate-400 border border-slate-200/80 rounded-md text-[10px] whitespace-nowrap opacity-60 cursor-not-allowed" title="Foto Dalam Belum Diupload">
                 <i class="fa-solid fa-boxes-stacked text-[8.5px]"></i> View Dalam
               </span>`;

        pairedButtonsHtml = `
            <div class="inline-flex items-center gap-1.5 flex-nowrap">
                ${luarHtml}
                ${dalamHtml}
            </div>
        `;
    } else {
        pairedButtonsHtml = `
            <div class="inline-flex items-center gap-1.5 flex-nowrap">
                <button onclick="previewFile(${item.id})" class="inline-flex items-center gap-1 px-2.5 py-1 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 rounded-md font-bold text-[10px] transition shadow-2xs whitespace-nowrap cursor-pointer" title="Buka View Evident (${item.size || '-'})">
                    <i class="fa-solid fa-image text-[9px] text-amber-600"></i>
                    <span>View Evident</span>
                </button>
                ${item.locationUrl ? `
                    <a href="${item.locationUrl}" target="_blank" class="inline-flex items-center gap-1 px-2 py-1 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-300 rounded-md font-bold text-[10px] transition shadow-2xs whitespace-nowrap" title="Buka Titik GPS Maps">
                        <i class="fa-solid fa-location-dot text-[9px] text-emerald-600"></i>
                        <span>GPS Map</span>
                    </a>
                ` : ''}
            </div>
        `;
    }

    // 1. Kolom ID Pelanggan LENGKAP (terpisah & rapi)
    const idCell = item.customerId
        ? `<td class="py-2 px-3">
             <span class="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-50 border border-indigo-200/80 rounded-md text-indigo-800 font-bold font-mono text-[10.5px] whitespace-nowrap shadow-2xs">
               <i class="fa-solid fa-id-card text-indigo-500 text-[10px]"></i>${escapeHtml(item.customerId)}
             </span>
           </td>`
        : `<td class="py-2 px-3 text-slate-300 text-[10.5px] font-mono">-</td>`;

    // 2. Kolom Nama Pelanggan (terpisah & rapi)
    const nameCell = item.customerName
        ? `<td class="py-2 px-3">
             <div class="font-semibold text-slate-800 text-[11px] flex items-center gap-1 whitespace-nowrap">
               <i class="fa-solid fa-user text-slate-400 text-[10px]"></i>
               <span>${escapeHtml(item.customerName)}</span>
             </div>
           </td>`
        : `<td class="py-2 px-3 text-slate-300 text-[10.5px]">-</td>`;

    // 3. Kolom SN Modem (terpisah & rapi)
    const snCell = item.modemSn
        ? `<td class="py-2 px-3">
             <div class="space-y-0.5">
               <span class="inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 border border-amber-200/80 rounded-md text-amber-900 font-bold font-mono text-[10.5px] whitespace-nowrap shadow-2xs">
                 <i class="fa-solid fa-barcode text-amber-700 text-[10px]"></i>${escapeHtml(item.modemSn)}
               </span>
             </div>
           </td>`
        : `<td class="py-2 px-3 text-slate-300 text-[10.5px] font-mono">-</td>`;

    // 4. Kolom Nama ODP (terpisah & rapi untuk memudahkan pencarian)
    const odpName = item.odpName || extractOdpName(item);
    const odpCell = odpName
        ? `<td class="py-2 px-3">
             <span class="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-50 border border-purple-200/80 rounded-md text-purple-800 font-bold text-[10.5px] whitespace-nowrap shadow-2xs">
               <i class="fa-solid fa-network-wired text-purple-600 text-[9.5px]"></i>${escapeHtml(odpName)}
             </span>
           </td>`
        : `<td class="py-2 px-3 text-slate-300 text-[10.5px] font-mono">-</td>`;

    tr.innerHTML = `
        <td class="py-2 px-3 font-semibold text-slate-800">
            <div class="flex items-center gap-2 flex-wrap">
                ${indent}${childIcon}
                ${labelBadge}
                ${pairedButtonsHtml}
            </div>
            ${item.odcReference ? `<div class="text-[9.5px] text-slate-400 mt-1"><i class="fa-solid fa-link text-indigo-400 mr-1"></i>Induk ODC: <span class="font-semibold text-indigo-600">${escapeHtml(item.odcReference)}</span></div>` : ''}
            ${item.locationUrl && pair.type !== 'other' ? `<div class="text-[9.5px] text-emerald-600 mt-0.5"><a href="${item.locationUrl}" target="_blank" class="hover:underline inline-flex items-center gap-1 font-semibold"><i class="fa-solid fa-location-dot"></i> Titik GPS Maps</a></div>` : ''}
            ${item.rejectReason ? `<div class="text-[9.5px] text-rose-500 italic mt-0.5"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(item.rejectReason)}</div>` : ''}
        </td>
        ${idCell}
        ${nameCell}
        ${snCell}
        ${odpCell}
        <td class="py-2 px-3">${categoryBadge}</td>
        <td class="py-2 px-3 font-medium text-slate-700 text-[10.5px]">${escapeHtml(item.uploader)}</td>
        <td class="py-2 px-3 text-slate-400 text-[10.5px]">${escapeHtml(item.date)}</td>
        <td class="py-2 px-3 text-right whitespace-nowrap">
            <button onclick="previewFile(${item.id})" class="text-slate-600 hover:text-blue-600 p-1 rounded hover:bg-slate-100 transition inline-flex items-center justify-center" title="Pratinjau File">
                <i class="fa-solid fa-eye text-xs"></i>
            </button>
            ${(item.customerId || item.customerName || item.modemSn) ? `
            <button onclick="openCustomerHistoryModal('${escapeHtml(item.customerId || '')}', '${escapeHtml(item.customerName || '')}', '${escapeHtml(item.modemSn || '')}')"
                class="text-indigo-600 hover:text-indigo-800 p-1 rounded hover:bg-indigo-50 transition ml-1 inline-flex items-center justify-center" title="History Log Aktivitas Pelanggan">
                <i class="fa-solid fa-clock-rotate-left text-xs"></i>
            </button>
            ` : ''}
            ${checkIsOwner() ? `
            <button onclick="deleteEvident(${item.id})" class="text-rose-500 hover:text-rose-700 p-1 rounded hover:bg-rose-50 transition ml-1 inline-flex items-center justify-center" title="Hapus Evident Permanen (Owner)">
                <i class="fa-solid fa-trash-can text-xs"></i>
            </button>
            ` : ''}
        </td>
    `;
    return tr;
}

async function updateStatus(id, newStatus) {
    if (currentUserRole !== 'owner' && currentUserRole !== 'editor') {
        return alert('Akses ditolak!');
    }

    const item = sampleData.find(d => d.id === id);
    if (!item) return;

    let reason = null;

    if (newStatus === 'Ditolak') {
        reason = prompt(`Masukkan alasan/keterangan penolakan untuk file "${item.name}":`);
        if (reason === null) {
            filterFiles();
            return;
        }
        if (!reason.trim()) {
            alert('Alasan penolakan tidak boleh kosong!');
            filterFiles();
            return;
        }
    }

    item.status = newStatus;
    item.rejectReason = reason;

    const { error } = await supabaseClient
        .from('evidents')
        .update({
            status: newStatus,
            reject_reason: reason
        })
        .eq('id', id);

    if (error) {
        alert("Gagal memperbarui status di database: " + error.message);
        filterFiles();
        return;
    }

    // Kirim notifikasi Telegram untuk Disetujui, Pending Review, dan Ditolak
    await sendTelegramNotification(item, newStatus, reason);

    filterFiles();
}

async function sendTelegramNotification(item, status, reason) {
    try {
        const uploader = item.uploader || '';
        let chatId = null;

        // 1. Ekstrak Chat ID jika uploader mengandung ID Telegram (misal: "Telegram ID: 123456789")
        const matchId = uploader.match(/(\d{7,15})/);
        if (matchId) {
            chatId = matchId[1];
        }

        // 2. Jika tidak ada angka ID di uploader, cari di tabel access_list berdasarkan email
        if (!chatId && uploader.includes('@')) {
            const { data: user } = await supabaseClient
                .from('access_list')
                .select('telegram_chat_id')
                .eq('email', uploader.trim().toLowerCase())
                .single();

            if (user && user.telegram_chat_id) {
                chatId = user.telegram_chat_id;
            }
        }

        if (!chatId) return;

        const botToken = APP_CONFIG.telegramBotToken || "9073260643:AAGVOavzwi3-6URsXE4JrJDzMh1ixal2Ow4";
        let messageText = '';
        let replyMarkup = null;

        if (status === 'Disetujui') {
            messageText =
                `✅ *PEMBERITAHUAN: EVIDENT DISETUJUI*\n\n` +
                `📂 *Kategori:* *${item.category}*\n` +
                (item.deviceLabel ? `🏷 *Label:* \`${item.deviceLabel}\`\n` : '') +
                (item.odcReference ? `🔗 *Induk ODC:* \`${item.odcReference}\`\n` : '') +
                `📄 *Berkas:* \`${item.name}\`\n` +
                `📊 *Status:* ✅ *Disetujui (Approved)*\n\n` +
                `✨ Berkas evident Anda telah diverifikasi dan disetujui oleh Admin Dashboard.`;
        } else if (status === 'Pending Review') {
            messageText =
                `⏳ *PEMBERITAHUAN: STATUS PENDING REVIEW*\n\n` +
                `📂 *Kategori:* *${item.category}*\n` +
                (item.deviceLabel ? `🏷 *Label:* \`${item.deviceLabel}\`\n` : '') +
                `📄 *Berkas:* \`${item.name}\`\n` +
                `📊 *Status:* ⏳ *Pending Review (Menunggu Pemeriksaan)*\n\n` +
                `Berkas evident Anda sedang dalam antrean pemeriksaan oleh Admin Dashboard.`;
        } else if (status === 'Ditolak') {
            messageText =
                `❌ *PEMBERITAHUAN: BERKAS EVIDENT DITOLAK*\n\n` +
                `📂 *Kategori:* *${item.category}*\n` +
                (item.deviceLabel ? `🏷 *Label:* \`${item.deviceLabel}\`\n` : '') +
                (item.odcReference ? `🔗 *Induk ODC:* \`${item.odcReference}\`\n` : '') +
                `📄 *Berkas:* \`${item.name}\`\n` +
                `📝 *Alasan Penolakan:* ${reason || 'Foto kurang jelas / tidak sesuai SOP'}\n\n` +
                `⚠️ *MOHON UPLOAD EVIDENT ULANG:*\n` +
                `Silakan ambil foto ulang yang lebih jelas atau perbaiki label sesuai catatan di atas, lalu tekan tombol di bawah untuk mengunggah ulang:`;

            const labelCode = encodeURIComponent(item.deviceLabel || 'none');
            replyMarkup = {
                inline_keyboard: [
                    [
                        { text: `🔄 Upload Ulang Evident ${item.category}`, callback_data: `reupload_${item.category}_${labelCode}` }
                    ]
                ]
            };
        }

        const payload = {
            chat_id: chatId,
            text: messageText,
            parse_mode: 'Markdown'
        };
        if (replyMarkup) {
            payload.reply_markup = replyMarkup;
        }

        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (err) {
        console.error("Gagal mengirim notifikasi Telegram:", err);
    }
}

function saveTitle(e) {
    e.preventDefault();
    if (currentUserRole !== 'owner' && currentUserRole !== 'editor') return alert('Akses ditolak!');
    const newTitle = document.getElementById('titleInput').value.trim();
    const newSubtitle = document.getElementById('subtitleInput').value.trim();
    if (newTitle) document.getElementById('dashboardTitle').innerText = newTitle;
    if (newSubtitle) document.getElementById('dashboardSubtitle').innerText = newSubtitle;
    closeModal('titleModal');
}

function getStatusClass(status) {
    if (status === 'Disetujui') return 'bg-emerald-100 text-emerald-700';
    if (status === 'Pending Review') return 'bg-amber-100 text-amber-700';
    return 'bg-rose-100 text-rose-700';
}

function updateStats() {
    const totalEl = document.getElementById('statTotal');
    const modemEl = document.getElementById('statModem');
    const odcEl = document.getElementById('statOdc');
    const odpEl = document.getElementById('statOdp');

    if (totalEl) totalEl.innerText = sampleData.length;

    if (modemEl) {
        const modemCount = sampleData.filter(d => 
            Boolean(d.customerId || d.customerName || d.modemSn) ||
            (d.deviceLabel && d.deviceLabel.toUpperCase().includes('MODEM')) ||
            (d.name && d.name.toUpperCase().includes('MODEM')) ||
            (d.category && d.category.toUpperCase() === 'MODEM')
        ).length;
        modemEl.innerText = modemCount;
    }

    if (odcEl) {
        const odcCount = sampleData.filter(d => 
            ((d.deviceLabel && d.deviceLabel.toUpperCase().startsWith('ODC')) || 
             (d.category && d.category.toUpperCase().startsWith('ODC'))) &&
            !(d.deviceLabel && d.deviceLabel.toUpperCase().includes('MODEM'))
        ).length;
        odcEl.innerText = odcCount;
    }

    if (odpEl) {
        const odpCount = sampleData.filter(d => 
            ((d.deviceLabel && d.deviceLabel.toUpperCase().startsWith('ODP')) || 
             (d.category && d.category.toUpperCase() === 'ODP')) &&
            !(d.deviceLabel && d.deviceLabel.toUpperCase().includes('MODEM'))
        ).length;
        odpEl.innerText = odpCount;
    }
}

function previewFile(id) {
    currentPreviewId = id;
    const item = sampleData.find(d => d.id === id);
    if (!item) return;

    // Tombol hapus evident khusus owner di modal preview
    const delBtn = document.getElementById('deleteFromPreviewBtn');
    if (delBtn) {
        if (checkIsOwner()) delBtn.classList.remove('hidden');
        else delBtn.classList.add('hidden');
    }

    document.getElementById('previewFileName').innerText = item.name;
    document.getElementById('previewInfo').innerText = `Pengunggah: ${item.uploader} | Ukuran: ${item.size} | Tanggal: ${item.date}`;

    const badgeContainer = document.getElementById('previewModemBadges');
    if (badgeContainer) {
        let badgesHtml = '';
        if (item.customerId) {
            badgesHtml += `<span class="bg-indigo-50 text-indigo-700 text-xs px-2.5 py-1 rounded-lg font-bold border border-indigo-200/80 inline-flex items-center gap-1.5"><i class="fa-solid fa-id-card text-indigo-500"></i> ID: ${item.customerId}</span>`;
        }
        if (item.customerName) {
            badgesHtml += `<span class="bg-emerald-50 text-emerald-800 text-xs px-2.5 py-1 rounded-lg font-semibold border border-emerald-200/80 inline-flex items-center gap-1.5"><i class="fa-solid fa-user text-emerald-600"></i> ${item.customerName}</span>`;
        }
        if (item.modemSn) {
            badgesHtml += `<span class="bg-amber-50 text-amber-900 text-xs px-2.5 py-1 rounded-lg font-mono font-bold border border-amber-200/80 inline-flex items-center gap-1.5"><i class="fa-solid fa-barcode text-amber-700"></i> SN: ${item.modemSn}</span>`;
        }
        if (item.photoType) {
            badgesHtml += `<span class="bg-cyan-50 text-cyan-800 text-xs px-2.5 py-1 rounded-lg font-bold border border-cyan-200/80 inline-flex items-center gap-1.5"><i class="fa-solid fa-camera text-cyan-600"></i> ${item.photoType}</span>`;
        }
        if (item.odcReference) {
            badgesHtml += `<span class="bg-blue-50 text-blue-800 text-xs px-2.5 py-1 rounded-lg font-semibold border border-blue-200/80 inline-flex items-center gap-1.5"><i class="fa-solid fa-folder text-blue-600"></i> Induk: ${item.odcReference}</span>`;
        }
        badgeContainer.innerHTML = badgesHtml;
    }

    const container = document.getElementById('previewBody');
    if (item.fileUrl) {
        document.getElementById('downloadFromPreviewBtn').href = item.fileUrl;
        if (item.name.match(/\.(jpeg|jpg|png|gif)$/i)) {
            container.innerHTML = `<img src="${item.fileUrl}" class="max-h-[70vh] w-auto object-contain rounded-lg">`;
        } else {
            container.innerHTML = `<iframe src="${item.fileUrl}" class="w-full h-[70vh] rounded-lg"></iframe>`;
        }
    } else if (item.fileObj) {
        const url = URL.createObjectURL(item.fileObj);
        document.getElementById('downloadFromPreviewBtn').href = url;
        container.innerHTML = `<iframe src="${url}" class="w-full h-[70vh] rounded-lg"></iframe>`;
    } else {
        container.innerHTML = `<div class="p-6 text-center text-xs text-slate-500">Pratinjau data bawaan dummy.</div>`;
    }
    openModal('previewModal');
}

async function handleUpload(e) {
    e.preventDefault();
    if (currentUserRole !== 'owner' && currentUserRole !== 'editor') return alert('Akses ditolak: Viewer tidak dapat mengunggah file.');
    const files = document.getElementById('fileInput').files;
    const category = document.getElementById('categorySelect').value;

    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const newRecord = {
            name: f.name,
            size: (f.size / (1024 * 1024)).toFixed(1) + " MB",
            category: category,
            uploader: currentUser.email,
            date: new Date().toLocaleString('id-ID'),
            status: "Pending Review",
            file_url: null
        };

        const { data, error } = await supabaseClient.from('evidents').insert([newRecord]).select();
        if (!error && data && data.length > 0) {
            sampleData.unshift({
                id: data[0].id,
                name: data[0].name,
                size: data[0].size,
                category: data[0].category,
                uploader: data[0].uploader,
                date: data[0].date,
                status: data[0].status,
                fileObj: f
            });
        } else {
            alert("Gagal mengunggah ke database Supabase: " + (error ? error.message : 'Unknown error'));
        }
    }
    closeModal('uploadModal');
    filterFiles();
}

function openModal(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.remove('hidden');
        if (id === 'categoryModal') {
            renderCategoryManageList();
        }
    }
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.classList.add('hidden');
}
