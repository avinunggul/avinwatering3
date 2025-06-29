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
                        let icon = '☁️';
                        const cuaca = (data[obj.weather_desc] || '').toUpperCase();

                        if (cuaca.includes('HUJAN')) icon = '🌧️';
                        else if (cuaca.includes('CERAH')) icon = '☀️';
                        else if (cuaca.includes('BERAWAN')) icon = '🌥️';
                        else if (cuaca.includes('MENDUNG')) icon = '☁️';


                        forecasts.push({
                            waktu: data[obj.local_datetime] ?? '-',
                            cuaca: data[obj.weather_desc] ?? '-',
                            suhu: data[obj.t] ?? '-',
                            kelembapan: typeof obj.hu === 'number' ? obj.hu : '-',
                            icon
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
            pesan += `Cuaca: ${f.cuaca} ${f.icon}\n`;
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

const wateringStatusListeners = {};

// --- mengirimkan pesan saat status done dari firebase
async function listenWateringStatus(raspiId, sock) {
    if (wateringStatusListeners[raspiId]) {
        const { ref, callback } = wateringStatusListeners[raspiId];
        ref.off('value', callback);
    }

    const statusRef = db.ref(`users/${raspiId}/watering_status`);

    const callback = async (snapshot) => {
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
    };

    wateringStatusListeners[raspiId] = { ref: statusRef, callback};
    statusRef.on('value', callback);
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

let reconnectAttempts = 0;
const MAX_RECONNECT = 20;

async function reattachAllListeners(sock) {
    const allUsers = await getAllRaspiIds();
    allUsers.forEach(user => {
        listenWateringStatus(user.raspiId, sock);
    });
}

let notifInterval = null
const { DateTime } = require('luxon');
function getNextEvenHourTimeout(){
    const now = DateTime.now().setZone('Asia/Jakarta');
    let nextHour = now.hour();

    //cari kelipatan 2 berikutnya dari jam sekarang
    if (nextHour % 2 === 0) {
        nextHour += 2;
    } else {
        nextHour += 1;
    }
    if (nextHour >= 24) nextHour -= 24;

    const next = now.set({
        hour: nextHour,
        minute: 0,
        second: 0,
        millisecond: 0
    });
    
    const ms = next.toMillis() - now.toMillis();

    console.log(`⏰ Jadwal notifikasi cuaca berikutnya jam ${nextHour}:00 (dalam ${Math.round(ms/60000)} menit)`);
    return ms;
    //return 10000; //notif delay 10 detik untuk tes kode diatas dihapus semua kemudian untuk interval nya diubah manual dibawah
}

function startScheduleNotif(sock) {
    const now = new Date();
    const jam = now.getHours();
    const menit = now.getMinutes();

    const isEvenHour = jam % 2 === 0 && menit === 0;

    const kirimNotifikasi = async () => {
        const allUsers = await getAllRaspiIds();
        for (const user of allUsers) {
            const kodeWilayah = await getKodeWilayahByRaspiId(user.raspiId);
            if(!kodeWilayah) continue;
            const waId = user.whatsapp.replace(/^0/, '62') + '@s.whatsapp.net';
            const pesanCuaca = await getPrakiraanCuaca(kodeWilayah);
            await sock.sendMessage(waId, {text: pesanCuaca});
            console.log(`[NOTIF] Kirim notifikasi di jam: ${DateTime.now().setZone('Asia/Jakarta').toFormat('HH:mm:ss')}`);
        }
    };

    if (isEvenHour) {
        kirimNotifikasi();
    };

    const delay = getNextEvenHourTimeout();

    setTimeout(() => {
        kirimNotifikasi();

    notifInterval = setInterval(kirimNotifikasi, 2 * 60 * 60 * 1000);
    }, delay);
}
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth');
    const sock = makeWASocket({ auth: state });

    setupFirestoreListener(sock);
    await reattachAllListeners(sock);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) qrcode.generate(qr, { small: true });
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect && reconnectAttempts < MAX_RECONNECT) {
                reconnectAttempts++;
                console.log(`[RECONNECT] Attempt ${reconnectAttempts} of ${MAX_RECONNECT}, retrying in 5s...`);
                setTimeout(() => {
                    startBot();
                }, 5000);
            } else if (!shouldReconnect) {
                console.log('[RECONNECT] Tidak reconnect, status logged out.');
            } else {
                console.log(`[RECONNECT] Sudah mencapai batas maksimal percobaan (${MAX_RECONNECT}).`);
            }
        }
        if (connection === 'open') {
            reconnectAttempts = 0; // reset kalau sukses connect
            console.log(`✅ Terhubung! Memantau seluruh device...`);
            setupFirestoreListener(sock);
        }
    });

    if (notifInterval) {
        clearInterval(notifInterval);
        console.log('Interval notif lama di clear sebelum buat baru.');
    }

    startScheduleNotif(sock);

    // Pasang listener watering_status untuk semua user saat pertama kali WA connect
    getAllRaspiIds().then(raspiUsers => {
        raspiUsers.forEach(user => listenWateringStatus(user.raspiId, sock));
    });


    // mengirim pesan saat user ketik status, siram dan stop siram
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
            await sock.sendMessage(from, { text: '' });
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
                pesanCuaca = await getPrakiraanCuacaWithRetry(kodeWilayah);
            } else {
                pesanCuaca = 'Kode wilayah tidak ditemukan untuk user ini.\n\n';
            }

            response += pesanCuaca;
            response += `\n\n ketik *SIRAM SEKARANG* untuk menyiram tanaman.`;

            await sock.sendMessage(from, { text: response });
            return;
        }

        if (text.includes('stop') && text.includes('siram')) {
            await db.ref(`users/${raspiId}/watering_status`).set('stop');
            await sock.sendMessage(from, { text: `🚫 Penyiraman dihentikan untuk device ${raspiId}!` });
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
async function notifikasiWhatsapp(user, sock) {
    const raspiId = user.raspiId;
    const from = user.whatsapp.replace(/^0/, '62') + '@s.whatsapp.net';

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
    response += `📱 *Pemilik: ${user.name}*\n`;
    response += `⏰ *Terakhir Disiram: ${last_watered}*\n\n`;
    response += `💧 *Kadar Air: ${kadarAir}%*\n`;
    response += `🔄 Status: ${status}\n\n`;

    const kodeWilayah = await getKodeWilayahByRaspiId(raspiId);
    let pesanCuacanotif = '';
    if (kodeWilayah) {
        pesanCuacanotif = await getPrakiraanCuacaSingkatWithRetry(kodeWilayah);
    } else {
        pesanCuacanotif = 'Kode wilayah tidak ditemukan untuk user ini.\n\n';
    }

    response += pesanCuacanotif;
    response += `\n\nKetik *SIRAM SEKARANG* untuk menyiram tanaman.`;

    try {
        await sock.sendMessage(from, { text: response });
        console.log(`[NOTIF] SUKSES kirim ke ${user.name || raspiId} (${from})`);
    } catch (err) {
        console.log(`[NOTIF] GAGAL kirim ke ${user.name || raspiId} (${from}): ${err.message}`);
    }
}




//untuk mengaktifkan render
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getPrakiraanCuacaSingkatWithRetry(kodeWilayah, maxRetry = 20, delayMs = 5000) {
    for (let attempt = 1; attempt <= maxRetry; attempt++) {
        const pesan = await getPrakiraanCuacaSingkat(kodeWilayah);

        //cek data valid di render, langsung return
        if (!pesan.includes('tidak ditemukan') && !pesan.includes('tidak tersedia')) {
            return pesan;
        }

        // kalau belum valid dan masih ada retry tunggu dulu
        if (attempt < maxRetry) {
            console.log(`Cuaca belum tersedia, retry ke ${attempt}, tunggu ${delayMs/1000} detik..`);
            await sleep(delayMs);
        }
    }
    return `Maaf, data prakiraan cuaca tidak tersedian saat ini.\n\n`
}

async function getPrakiraanCuacaWithRetry(kodeWilayah, maxRetry = 6, delayMs = 5000) {
    for (let attempt = 1; attempt <= maxRetry; attempt++){
        const pesan = await getPrakiraanCuaca(kodeWilayah);
        if (!pesan.includes('tidak ditemukan') && !pesan.includes('tidak tersedia')) {
            return pesan;
        }

        if (attempt < maxRetry) {
            console.log(`Cuaca belum tersedia, retry ke ${attempt}, tunggu ${delayMs/1000} detik..`);
            await sleep(delayMs);
        }
    }
    return `Maaf, data prakiraan cuaca tidak tersedia saat ini.\n\n`
}
