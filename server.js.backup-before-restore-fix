const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const pino = require('pino');
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const DB_FILE = 'data.json';
let db = { users: [], reports: [], sessions: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
function saveDb() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

function getUserByPhone(phone) {
  return db.users.find(u => u.phone === phone);
}
function createUser(phone, connected) {
  const user = { id: Date.now(), phone, connected: connected ? 1 : 0 };
  db.users.push(user);
  saveDb();
  return user;
}

const logger = pino({ level: 'silent' });
const waSessions = new Map();

function waStatus(phone) {
  const s = waSessions.get(phone);
  if (!s) return { status: 'none', qr: null, pairing_code: null };
  return { status: s.status, qr: s.qr, pairing_code: s.pairingCode };
}

function toJid(number) {
  return number.replace(/\D/g, '') + '@s.whatsapp.net';
}

async function waStart(phone, mode) {
  const number = phone.replace(/\D/g, '');
  const existing = waSessions.get(number);
  if (existing && existing.status === 'connected') return waStatus(number);

  const sessionDir = path.join(process.cwd(), 'sessions', number);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger,
    browser: Browsers.ubuntu('Chrome')
  });

  const entry = { status: 'connecting', qr: null, pairingCode: null, sock, mode: mode || 'pairing' };
  waSessions.set(number, entry);
  let pairingRequested = false;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      entry.qr = await QRCode.toDataURL(qr, {
        color: { dark: '#00ff9d', light: '#050505' }
      });
      entry.status = 'pairing';
      if (entry.mode === 'pairing' && !pairingRequested) {
        pairingRequested = true;
        setTimeout(async () => {
          try {
            entry.pairingCode = await sock.requestPairingCode(number);
          } catch (e) {
            entry.pairingCode = null;
            entry.status = 'disconnected';
          }
        }, 5000);
      }
    }

    if (connection === 'open') {
      entry.status = 'connected';
      entry.qr = null;
      entry.pairingCode = null;
      // ===== FIX DU BUG : l'utilisateur est TOUJOURS marque connecte =====
      let user = getUserByPhone('+' + number);
      if (!user) user = createUser('+' + number, true);
      user.connected = 1;
      saveDb();
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        waSessions.delete(number);
        sock.ev.removeAllListeners('connection.update');
      } else {
        entry.status = 'connecting';
        setTimeout(() => waStart('+' + number, entry.mode).catch(() => {}), 3000);
      }
    }
  });

  return waStatus(number);
}

// Au demarrage : recharge automatiquement les sessions sauvegardees
async function restoreSessions() {
  const dir = path.join(process.cwd(), 'sessions');
  try {
    const numbers = fs.readdirSync(dir);
    for (const number of numbers) {
      try {
        await waStart('+' + number, 'none');
        console.log('Session rechargée : +' + number);
      } catch (e) {}
    }
  } catch (e) {}
}

function getConnectedSock(phone) {
  const number = phone.replace(/\D/g, '');
  const s = waSessions.get(number);
  if (!s || s.status !== 'connected' || !s.sock) return null;
  return { sock: s.sock, number: number };
}

// Verifie la connexion : drapeau en base OU session reelle vivante
function ensureConnected(user) {
  if (user.connected === 1 && getConnectedSock(user.phone)) return true;
  const live = getConnectedSock(user.phone);
  if (live) { user.connected = 1; saveDb(); return true; }
  return false;
}

app.post('/api/wa/start', async (req, res) => {
  const { phone, mode } = req.body;
  if (!phone || phone.replace(/\D/g, '').length < 10) {
    return res.status(400).json({ error: 'Numero invalide (avec indicatif pays)' });
  }
  try { res.json(await waStart(phone, mode)); }
  catch (e) { res.status(500).json({ error: 'Erreur de connexion a WhatsApp' }); }
});

app.get('/api/wa/status/:phone', (req, res) => {
  res.json(waStatus(decodeURIComponent(req.params.phone)));
});

app.post('/api/wa/logout', async (req, res) => {
  const number = (req.body.phone || '').replace(/\D/g, '');
  const s = waSessions.get(number);
  if (s?.sock) { try { await s.sock.logout(); } catch (e) {} }
  waSessions.delete(number);
  const user = getUserByPhone('+' + number);
  if (user) { user.connected = 0; saveDb(); }
  res.json({ ok: true });
});

app.post('/api/user', (req, res) => {
  const number = '+' + req.body.phone.replace(/\D/g, '');
  let user = getUserByPhone(number);
  if (!user) user = createUser(number, 0);
  const live = !!getConnectedSock(number);
  if (live) { user.connected = 1; saveDb(); }
  res.json({ user_id: user.id, connected: user.connected });
});

app.post('/api/session', (req, res) => {
  const { user_id, max_reports, cooldown } = req.body;
  const max = Math.min(Math.max(parseInt(max_reports) || 5, 1), 50);
  const cool = Math.min(Math.max(parseInt(cooldown) || 10, 0), 600);
  db.sessions[user_id] = { max_reports: max, cooldown: cool, used: 0, last_ts: 0 };
  saveDb();
  res.json({ ok: true, max_reports: max, cooldown: cool, used: 0 });
});

app.post('/api/status', (req, res) => {
  const s = db.sessions[req.body.user_id];
  if (!s) return res.json({ no_session: true });
  res.json({
    max_reports: s.max_reports, cooldown: s.cooldown,
    used: s.used, left: s.max_reports - s.used
  });
});

app.post('/api/report', (req, res) => {
  const { user_id, target_phone, reason, block_too } = req.body;
  const user = db.users.find(u => u.id === user_id);
  if (!user || !ensureConnected(user)) {
    return res.status(403).json({ error: 'Connecte ton WhatsApp avant de signaler' });
  }
  if (!target_phone || target_phone.replace(/\D/g, '').length < 8) {
    return res.status(400).json({ error: 'Numero a signaler invalide' });
  }

  const s = db.sessions[user_id];
  if (!s) return res.status(400).json({ error: 'Demarre d\u2019abord une session de signalement' });

  if (s.used >= s.max_reports) {
    return res.status(429).json({ error: 'Limite de la session atteinte : ' + s.max_reports + ' signalements.' });
  }

  const elapsed = (Date.now() - s.last_ts) / 1000;
  const remaining = Math.ceil(s.cooldown - elapsed);
  if (s.last_ts && remaining > 0) {
    return res.status(429).json({ error: 'PAUSE', remaining: remaining });
  }

  let waResult = 'non-bloque';
  if (block_too !== false) {
    const ctx = getConnectedSock(user.phone);
    if (!ctx) return res.status(500).json({ error: 'Session WhatsApp deconnectee, reconnecte-toi' });
    try {
      ctx.sock.updateBlockStatus(toJid(target_phone), 'block');
      waResult = 'bloque-dans-whatsapp';
    } catch (e) {
      return res.status(500).json({ error: 'Echec du blocage reel : ' + e.message });
    }
  }

  db.reports.push({
    user_id: user_id, target_phone: target_phone,
    reason: reason || 'Non precise',
    wa_action: waResult,
    created_at: new Date().toISOString()
  });
  s.used++;
  s.last_ts = Date.now();
  saveDb();

  res.json({ ok: true, used: s.used, left: s.max_reports - s.used, cooldown: s.cooldown, wa_result: waResult });
});

app.post('/api/block', async (req, res) => {
  const { user_id, target_phone, action } = req.body;
  const user = db.users.find(u => u.id === user_id);
  if (!user || !ensureConnected(user)) return res.status(403).json({ error: 'Connecte ton WhatsApp avant' });
  if (!target_phone || target_phone.replace(/\D/g, '').length < 8) {
    return res.status(400).json({ error: 'Numero invalide' });
  }
  const ctx = getConnectedSock(user.phone);
  if (!ctx) return res.status(500).json({ error: 'Session WhatsApp deconnectee, reconnecte-toi' });
  try {
    await ctx.sock.updateBlockStatus(toJid(target_phone), action === 'unblock' ? 'unblock' : 'block');
    res.json({ ok: true, result: action === 'unblock' ? 'DEBLOQUE ✔' : 'BLOQUE ✔ (visible dans WhatsApp : Contacts bloques)' });
  } catch (e) {
    res.status(500).json({ error: 'Echec : ' + e.message });
  }
});

app.get('/api/reports', (req, res) => {
  res.json([...db.reports].reverse().slice(0, 100));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('PANEL VORTEX PRIME TDL demarre : http://localhost:' + PORT);
  restoreSessions();
});
