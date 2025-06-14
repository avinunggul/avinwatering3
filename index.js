const express = require('express');
const app = express();

app.get('/', (req, res) => res.send('wa bot nyala'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`HTTP server running on port ${PORT}`);
});

console.log('🔥 FIREBASE_CREDS defined:', !!process.env.FIREBASE_CREDS);
console.log('🔥 FIREBASE_CREDS raw value:', process.env.FIREBASE_CREDS?.slice(0, 50)); // Potong 50 karakter aja biar aman

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const axios = require('axios');
const admin = require('firebase-admin');

if (!process.env.FIREBASE_CREDS) {
    console.error("FIREBASE_CREDS belum di-set");
    process.exit(1);
}

// Setup Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDS);
initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://avinwateringplant-default-rtdb.asia-southeast1.firebasedatabase.app'
});
const firestore = getFirestore();
const db = getDatabase();

// --- Fungsi ambil kodeWilayah dari raspiId
async function getKodeWilayahByRaspiId(raspiId) {
    try {
        const usersRef = firestore.collection('users');
        const querySnapshot = await usersRef.where('raspiId', '==', raspiId).limit(1).get();
        if (querySnapshot.empty) return null;
        const userData = querySnapshot.docs[0].data();
        return userData.kodeWilayah || null;
    } catch (e) {
        console.error('Error getKodeWilayahByRaspiId:', e.message);
        return null;
    }
}

// --- Fungsi ambil prakiraan cuaca
async function getPrakiraanCuaca(kodeWilayah) {
    try {
        const url = `https://avincuaca1.onrender.com/cuaca/${kodeWilayah}`;
        const resp = await axios.get(url, { timeout: 10000 });
        const data = resp.data;

        const provinsi = (data?.[18]?.description || data?.[18]) ?? '-';
        const kotkab = (data?.[19]?.description || data?.[19]) ?? '-';
        const kecamatan = (data?.[20]?.description || data?.[20]) ?? '-';

        let pesan = `\n*Prakiraan Cuaca 3 Jam ke Depan*\n`;
        pesan += `Lokasi:  ${kecamatan}, ${kotkab}, ${provinsi}\n\n`;

        const forecasts = [];

        data.forEach(item => {
            if (Array.isArray(item) && item.every(x => typeof x === 'number')) {
                item.forEach(idx => {
                    const obj = data[idx];
                    if (
                        obj && typeof obj === 'object' &&
                        obj.local_datetime !== undefined &&
                        typeof obj.t === 'number' &&
                        typeof obj.weather_desc !== 'undefined'
                    ) {
                        forecasts.push({
                            waktu: data[obj.local_datetime] ?? '-',
                            cuaca: data[obj.weather_desc] ?? '-',
                            suhu: data[obj.t] ?? '-',
                            icon: obj.image ? data[obj.image] : '',
                            kelembapan: typeof obj.hu === 'number' ? obj.hu : '-'
                        });
                    }
                });
            }
        });

        if (forecasts.length === 0) {
            pesan += 'Data prakiraan cuaca tidak ditemukan.\n\n';
            return pesan;
        }

        forecasts.slice(0, 3).forEach(f => {
            pesan += `🕒 *${f.waktu}*\n`;
            pesan += `Cuaca: ${f.cuaca}\n`;
            pesan += `Suhu: ${f.suhu}°C\n`;
            pesan += `Kelembapan: ${f.kelembapan}%\n\n`;
        });

        return pesan;
    } catch (err) {
        console.error("Gagal fetch cuaca:", err.message);
        return 'Maaf, data prakiraan cuaca tidak tersedia saat ini.\n\n';
    }
}

// --- Fungsi lain
async function getAllRaspiIds() {
    const usersRef = firestore.collection('users');
    const snapshot = await usersRef.get();
    const raspiIdList = [];
    snapshot.forEach(doc => {
        const data = doc.data();
        if (data.raspiId) {
            raspiIdList.push({ raspiId: data.raspiId, ...data, docId: doc.id });
        }
    });
    return raspiIdList;
}

async function findUserByWhatsApp(phone) {
    const usersRef = firestore.collection('users');
    const querySnapshot = await usersRef.where('whatsapp', '==', phone).limit(1).get();
    if (querySnapshot.empty) return null;
    return { data: querySnapshot.docs[0].data(), id: querySnapshot.docs[0].id };
}

function formatPhoneNumber(jid) {
    return jid.replace(/@s\.whatsapp\.net/g, '').replace(/^62/, '0');
}

const wateringListeners = new Set();

// --- Pantau perubahan watering_status 
async function listenWateringStatus(raspiId, sock) {
    if (wateringListeners.has(raspiId)) return;
    wateringListeners.add(raspiId);

    const statusRef = db.ref(`users/${raspiId}/watering_status`);
    statusRef.on('value', async (snapshot) => {
        const newStatus = snapshot.val();
        if (newStatus === 'done') {
            const mainDataSnap = await db.ref(`users/${raspiId}`).once('value');
            const mainData = mainDataSnap.val();
            const dataSensorSnap = await db.ref(`users/${raspiId}/data_kadar_air`).limitToLast(1).once('value');
            const dataSensor = dataSensorSnap.val();

            const usersRef = firestore.collection('users');
            const querySnapshot = await usersRef.where('raspiId', '==', raspiId).limit(1).get();
            if (querySnapshot.empty) return;
            const userData = querySnapshot.docs[0].data();
            const userWhatsApp = userData.whatsapp;
            const waId = userWhatsApp.replace(/^0/, '62') + '@s.whatsapp.net';

            let kadarAir = '-';
            let statusTanaman = '-';
            let waktu = '-';
            if (dataSensor) {
                const latestKey = Object.keys(dataSensor)[0];
                kadarAir = dataSensor[latestKey]?.nilai ?? '-';
                statusTanaman = dataSensor[latestKey]?.status ?? '-';
                waktu = dataSensor[latestKey]?.waktu ?? '-';
            }
            const watering_method = mainData?.watering_method ?? '-';
            const watering_status = mainData?.watering_status ?? '-';
            const last_watered = mainData?.last_watered ?? '-';

            let response = `🌱 *SISTEM PENYIRAMAN TANAMAN* 🌱\n\n`;
            response += `📱 *Pemilik: ${userData.name}*\n`;
            response += `🆔 Device ID: *${raspiId}*\n`;
            response += `⏰ *Terakhir Disiram: ${last_watered}*\n\n\n`;
            response += `✅ *TANAMAN TELAH SELESAI DISIRAM.*✅\n\n\n`;
            response += `💧 *Kadar Air: ${kadarAir}*%\n`;
            response += `🔄 Status: ${statusTanaman}\n`;
            response += `🚿 Status Penyiraman: ${watering_status}\n`;
            response += `🚿 Methode Penyiraman: ${watering_method}`;
            await sock.sendMessage(waId, { text: response });
        }
    });
}

// --- Listener Firestore hanya sekali
let userSnapshotUnsubscribe = null;
function setupFirestoreListener(sock) {
    if (userSnapshotUnsubscribe) userSnapshotUnsubscribe(); // Unsubscribe dulu jika sudah ada
    userSnapshotUnsubscribe = firestore.collection('users').onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
            const data = change.doc.data();
            if (data.raspiId && change.type === 'added') {
                listenWateringStatus(data.raspiId, sock);
                console.log(`[Listener] Ditambahkan untuk ${data.raspiId}`);
            }
        });
    });
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth');
    const sock = makeWASocket({ auth: state });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        }
        if (connection === 'open') {
            console.log(`✅ Terhubung! Memantau seluruh device...`);
            setupFirestoreListener(sock); // hanya sekali setiap koneksi WA open
        }
    });

    // Notifikasi berkala
    setInterval(async () => {
        console.log('⏰ Mengirim status otomatis ke semua pengguna...');
        const users = await getAllRaspiIds();
        for (const user of users) {
            try {
                await notifikasiWhatsapp(user, sock);
            } catch (e) {
                console.error(`Gagal kirim status ke ${user.name || user.raspiId}: `, e.message)
            }
        }
    }, 2 * 60 * 60 * 1000);

    // Pasang listener watering_status untuk semua user saat pertama kali WA connect
    getAllRaspiIds().then(raspiUsers => {
        raspiUsers.forEach(user => listenWateringStatus(user.raspiId, sock));
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const from = msg.key.remoteJid;
        if (from.includes('@g.us')) return;

        const senderNumber = formatPhoneNumber(from);
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim().toLowerCase();

        // Ambil user dari firestore berdasarkan WA number
        const userObj = await findUserByWhatsApp(senderNumber);
        if (!userObj) {
            await sock.sendMessage(from, { text: '⛔ Akses ditolak! Nomor tidak terdaftar.' });
            return;
        }
        const userData = userObj.data;
        const raspiId = userData.raspiId;

        if (text.includes('status')) {
            const datasensor = await db.ref(`users/${raspiId}/data_kadar_air`).limitToLast(1).once('value');
            const data = datasensor.val();

            const datasiram = await db.ref(`users/${raspiId}`).once('value');
            const mainData = datasiram.val();

            let kadarAir = '-';
            let status = '-';
            let waktu = '-';
            if (data) {
                const latestKey = Object.keys(data)[0];
                kadarAir = data[latestKey]?.nilai ?? '-';
                status = data[latestKey]?.status ?? '-';
                waktu = data[latestKey]?.waktu ?? '-';
            }
            const watering_status = mainData?.watering_status ?? '-';
            const watering_method = mainData?.watering_method ?? '-';
            const last_watered = mainData?.last_watered ?? '-';

            let response = `🌱 *SISTEM PENYIRAMAN TANAMAN* 🌱\n\n`;
            response += `📱 *Pemilik: ${userData.name}*\n`;
            response += `🆔 Device ID: ${raspiId}\n`;
            response += `⏰ *Terakhir Disiram: ${last_watered}*\n\n\n`;
            response += `💧 *Kadar Air: ${kadarAir}%*\n`;
            response += `🔄 Status: ${status}\n`;
            response += `🚿 Methode Penyiraman: ${watering_method}\n\n`;

            // --- Ambil kodeWilayah dan prakiraan cuaca
            const kodeWilayah = await getKodeWilayahByRaspiId(raspiId);
            let pesanCuaca = '';
            if (kodeWilayah) {
                pesanCuaca = await getPrakiraanCuaca(kodeWilayah);
            } else {
                pesanCuaca = 'Kode wilayah tidak ditemukan untuk user ini.\n\n';
            }

            response += pesanCuaca;
            response += `\n\n ketik *SIRAM SEKARANG* untuk menyiram tanaman.`;

            await sock.sendMessage(from, { text: response });
            return;
        }

        if (text.includes('siram')) {
            await db.ref(`users/${raspiId}/watering_status`).set('requested');
            await db.ref(`users/${raspiId}/watering_method`).set('manual');
            await sock.sendMessage(from, { text: `🚿 Memulai penyiraman untuk device ${raspiId}` });
        }
    });
}
startBot();

// --- Prakiraan cuaca singkat
async function getPrakiraanCuacaSingkat(kodeWilayah) {
    try {
        const url = `https://avincuaca1.onrender.com/cuaca/${kodeWilayah}`;
        const resp = await axios.get(url, { timeout: 10000 });
        const data = resp.data;

        const forecasts = [];
        data.forEach(item => {
            if (Array.isArray(item) && item.every(x => typeof x === 'number')) {
                item.forEach(idx => {
                    const obj = data[idx];
                    if (
                        obj && typeof obj === 'object' &&
                        obj.local_datetime !== undefined &&
                        typeof obj.t === 'number' &&
                        typeof obj.weather_desc !== 'undefined'
                    ) {
                        let jam = '-';
                        if (data[obj.local_datetime]) {
                            const waktu = data[obj.local_datetime];
                            const match = waktu.match(/\d{2}:\d{2}/);
                            jam = match ? match[0].replace(':', '.') : waktu;
                        }

                        let cuaca = (data[obj.weather_desc] ?? '-').toUpperCase();
                        let icon = '☁️';
                        if (cuaca.includes('HUJAN')) icon = '🌧️';
                        else if (cuaca.includes('CERAH')) icon = '☀️';
                        else if (cuaca.includes('BERAWAN')) icon = '🌥️';

                        forecasts.push({
                            waktu: jam,
                            cuaca,
                            icon,
                        });
                    }
                });
            }
        });

        if (forecasts.length === 0) {
            return 'Data prakiraan cuaca tidak ditemukan.';
        }

        let pesan = '*Prediksi Cuaca*\n';
        forecasts.slice(0, 5).forEach(f => {
            pesan += `🕒 ${f.waktu} : ${f.cuaca} ${f.icon}\n`;
        });

        return pesan;
    } catch (err) {
        return 'Maaf, data prakiraan cuaca tidak tersedia saat ini.\n\n';
    }
}

// --- Notifikasi WhatsApp tiap 2 jam
async function notifikasiWhatsapp(userData, sock) {
    const raspiId = userData.raspiId;
    const from = userData.whatsapp.replace(/^0/, '62') + '@s.whatsapp.net';

    const datasensor = await db.ref(`users/${raspiId}/data_kadar_air`).limitToLast(1).once('value');
    const data = datasensor.val();

    const datasiram = await db.ref(`users/${raspiId}`).once('value');
    const mainData = datasiram.val();

    let kadarAir = '-';
    let status = '-';
    let waktu = '-';

    if (data) {
        const latestKey = Object.keys(data)[0];
        kadarAir = data[latestKey]?.nilai ?? '-';
        status = data[latestKey]?.status ?? '-';
        waktu = data[latestKey]?.waktu ?? '-';
    }

    const watering_status = mainData?.watering_status ?? '-';
    const watering_method = mainData?.watering_method ?? '-';
    const last_watered = mainData?.last_watered ?? '-';

    let response = `🌱 *SISTEM PENYIRAMAN TANAMAN* 🌱\n\n`;
    response += `📱 *Pemilik: ${userData.name}*\n`;
    response += `⏰ *Terakhir Disiram: ${last_watered}*\n\n\n`;
    response += `💧 *Kadar Air: ${kadarAir}%*\n`;
    response += `🔄 Status: ${status}\n`;

    const kodeWilayah = await getKodeWilayahByRaspiId(raspiId);
    let pesanCuacanotif = '';
    if (kodeWilayah) {
        pesanCuacanotif = await getPrakiraanCuacaSingkat(kodeWilayah);
    } else {
        pesanCuacanotif = 'Kode wilayah tidak ditemukan untuk user ini.\n\n';
    }

    response += pesanCuacanotif;
    response += `\n\nKetik *SIRAM SEKARANG* untuk menyiram tanaman.`;

    await sock.sendMessage(from, { text: response });
}
