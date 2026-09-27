const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const app = express();
app.use(express.json({ limit: '20mb' }));

let sock;
let isConnected = false;
const API_KEY = process.env.WA_GATEWAY_KEY;

// Ganti dengan nomor WhatsApp kamu, format internasional TANPA + dan TANPA spasi
// Contoh: 6289646957741
const PHONE_NUMBER_FOR_PAIRING = '6289602910492';
const USE_PAIRING_CODE = true; // true = pakai kode 8 digit, false = pakai QR seperti biasa

async function startWA() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_session');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Menggunakan WA Web versi ${version.join('.')}, terbaru: ${isLatest}`);

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
    });

    // Kalau belum pernah login (belum ada sesi tersimpan) dan mode pairing aktif,
    // minta pairing code alih-alih menunggu QR discan
    if (USE_PAIRING_CODE && !sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(PHONE_NUMBER_FOR_PAIRING);
                console.log('🔑 KODE PAIRING KAMU: ' + code);
                console.log('🔑 Masukkan kode ini di WhatsApp HP: Linked Devices > Link with phone number instead > masukkan kode di atas');
            } catch (err) {
                console.log('❌ Gagal request pairing code:', err.message);
            }
        }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && !USE_PAIRING_CODE) {
            console.log('📱 Scan QR ini dengan WhatsApp kamu:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            isConnected = false;
            const statusCode = (new Boom(lastDisconnect?.error))?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log('⚠️  Koneksi terputus. StatusCode:', statusCode, '| Reason:', lastDisconnect?.error?.message);
            console.log('⚠️  Reconnect:', shouldReconnect);
            if (shouldReconnect) startWA();
        } else if (connection === 'open') {
            isConnected = true;
            console.log('✅ WhatsApp Gateway terhubung!');
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

startWA();

// ── Health check untuk Railway (tanpa perlu API key) ──
// Railway/monitoring tool sering ping "/" untuk cek service hidup atau tidak.
app.get('/', (req, res) => {
    res.json({ status: true, message: 'WA Gateway is running', connected: isConnected });
});

// ── Logging semua request masuk ──
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// ── Middleware auth ──
app.use((req, res, next) => {
    if (req.headers['x-api-key'] !== API_KEY) {
        console.log('❌ Ditolak: API key salah/tidak ada. Diterima:', req.headers['x-api-key']);
        return res.status(401).json({ status: false, message: 'Unauthorized' });
    }
    next();
});

// ── Endpoint cek status koneksi (buat debugging) ──
app.get('/status', (req, res) => {
    res.json({ connected: isConnected });
});

// ── Endpoint kirim dokumen (PDF) ──
app.post('/send-document', async (req, res) => {
    try {
        const { target, message, fileBase64, fileName } = req.body;
        console.log('📩 Permintaan kirim ke:', target, '| Ukuran file (base64):', fileBase64 ? fileBase64.length : 0);

        if (!isConnected) {
            console.log('❌ WhatsApp belum terkoneksi.');
            return res.status(503).json({ status: false, message: 'WhatsApp belum terkoneksi. Scan QR dulu.' });
        }

        if (!target || !fileBase64) {
            return res.status(400).json({ status: false, message: 'target & fileBase64 wajib diisi' });
        }

        const jid = target.replace(/[^0-9]/g, '') + '@s.whatsapp.net';

        const buffer = Buffer.from(fileBase64, 'base64');

        await sock.sendMessage(jid, {
            document: buffer,
            mimetype: 'application/pdf',
            fileName: fileName || 'booking.pdf',
            caption: message || '',
        });

        console.log('✅ Berhasil terkirim ke', jid);
        return res.json({ status: true, message: 'Terkirim' });
    } catch (err) {
        console.error('❌ Error:', err.message);
        return res.status(500).json({ status: false, message: err.message });
    }
});

// ── Endpoint kirim teks biasa (untuk testing) ──
app.post('/send-text', async (req, res) => {
    try {
        const { target, message } = req.body;
        if (!isConnected) {
            return res.status(503).json({ status: false, message: 'WhatsApp belum terkoneksi.' });
        }
        const jid = target.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: message });
        console.log('✅ Teks terkirim ke', jid);
        return res.json({ status: true });
    } catch (err) {
        console.error('❌ Error:', err.message);
        return res.status(500).json({ status: false, message: err.message });
    }
});

// ── Port dinamis untuk Railway (WAJIB, jangan hardcode 3000) ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Gateway jalan di port ${PORT}`));