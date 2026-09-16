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

process.on('uncaughtException', (err) => {
  console.log('[ERREUR attrapee, serveur en vie] :', err.message);
});
process.on('unhandledRejection', (err) => {
  console.log('[PROMESSE rejettee, serveur en vie] :', err && err.message ? err.message : err);
});

const app = express();
app.use(express.json());
app.use(express.static('public'));

const DB_FILE = 'data.json';
let db = { users: [], reports: [], sessions: {} };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
function saveDb() { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

function getUserByPhone(phone) { return db.users.find(u => u.phone === phone); }
function createUser(phone, connected) {
  const user = { id: Date.now(), phone, connected: connected ? 1 : 0 };
  db.users.push(user); saveDb(); return user;
}

const logger = pino({ level: 'silent' });
const waSessions = new Map();

function waStatus(phone) {
  const s = waSessions.get(phone);
  if (!s) return { status: 'none', qr: null, pairing_code: null };
  return { status: s.status, qr: s.qr, pairing_code: s.pairingCode };
}

function digitsOnly(n) { return (n || '').replace(/\D/g, ''); }
function toJid(n) { return digitsOnly(n) + '@s.whatsapp.net'; }

async function waStart(phone, mode) {
  const number = digitsOnly(phone);
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
      try { entry.qr = await QRCode.toDataURL(qr, { color: { dark: '#00ff9d', light: '#050505' } }); } catch (e) {}
      entry.status = 'pairing';
      if (entry.mode === 'pairing' && !pairingRequested) {
        pairingRequested = true;
        setTimeout(async () => {
          try { entry.pairingCode = await sock.requestPairingCode(number); } catch (e) { entry.pairingCode = null; }
        }, 5000);
      }
    }

    if (connection === 'open') {
      entry.status = 'connected';
      entry.qr = null; entry.pairingCode = null;
      let user = getUserByPhone('+' + number);
      if (!user) user = createUser('+' + number, true);
      user.connected = 1; saveDb();
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        waSessions.delete(number);
      } else {
        entry.status = 'connecting';
        setTimeout(() => waStart('+' + number, entry.mode).catch(() => {}), 3000);
      }
    }
  });

  return waStatus(number);
}

async function restoreSessions() {
  try {
    for (const number of fs.readdirSync(path.join(process.cwd(), 'sessions'))) {
      try { await waStart('+' + number, 'none'); } catch (e) {}
    }
  } catch (e) {}
}

function getConnectedSock(phone) {
  const s = waSessions.get(digitsOnly(phone));
  if (!s || s.status !== 'connected' || !s.sock) return null;
  return { sock: s.sock, number: digitsOnly(phone) };
}

function ensureConnected(user) {
  if (getConnectedSock(user.phone)) {
    if (user.connected !== 1) { user.connected = 1; saveDb(); }
    return true;
  }
  return false;
}

app.post('/api/wa/start', async (req, res) => {
  const { phone, mode } = req.body;
  if (digitsOnly(phone).length < 10) return res.status(400).json({ error: 'Numero invalide (avec indicatif pays)' });
  try { res.json(await waStart(phone, mode)); }
  catch (e) { res.status(500).json({ error: 'Erreur de connexion a WhatsApp' }); }
});

app.get('/api/wa/status/:phone', (req, res) => {
  res.json(waStatus(decodeURIComponent(req.params.phone)));
});

app.post('/api/wa/reset', async (req, res) => {
  const number = digitsOnly(req.body.phone);
  const s = waSessions.get(number);
  if (s?.sock) { try { s.sock.end(); } catch (e) {} }
  waSessions.delete(number);
  try { fs.rmSync(path.join(process.cwd(), 'sessions', number), { recursive: true, force: true }); } catch (e) {}
  const user = getUserByPhone('+' + number);
  if (user) { user.connected = 0; saveDb(); }
  res.json({ ok: true });
});

app.post('/api/user', (req, res) => {
  const phone = (req.body.phone || '').trim();
  let user = getUserByPhone(phone);
  if (!user) user = createUser(phone, getConnectedSock(phone) ? 1 : 0);
  ensureConnected(user);
  res.json({ user_id: user.id });
});

app.post('/api/session', (req, res) => {
  const { user_id, max_reports, cooldown } = req.body;
  const user = db.users.find(u => u.id === user_id);
  if (!user) return res.status(400).json({ error: 'Utilisateur inconnu, reconnecte-toi' });
  if (!ensureConnected(user)) return res.status(400).json({ error: 'WhatsApp non connecte' });

  const max = Math.max(1, Math.min(100, parseInt(max_reports) || 5));
  const cd = Math.max(0, Math.min(600, parseInt(cooldown) || 0));
  db.sessions[user_id] = { max_reports: max, cooldown: cd, used: 0, last_report_at: 0, next_action: 'block' };
  saveDb();
  res.json({ ok: true, max_reports: max, cooldown: cd });
});

app.post('/api/status', (req, res) => {
  const s = db.sessions[req.body.user_id];
  if (!s) return res.json({ no_session: true });
  res.json({ used: s.used, max_reports: s.max_reports, left: Math.max(0, s.max_reports - s.used), cooldown: s.cooldown });
});

function pauseRemaining(user_id) {
  const s = db.sessions[user_id];
  if (!s || s.cooldown === 0 || !s.last_report_at) return 0;
  const remaining = s.cooldown - (Date.now() - s.last_report_at) / 1000;
  return remaining > 0 ? Math.ceil(remaining) : 0;
}

app.post('/api/number-info', async (req, res) => {
  const user = db.users.find(u => u.id === req.body.user_id);
  if (!user) return res.status(400).json({ error: 'Utilisateur inconnu' });
  const ctx = getConnectedSock(user.phone);
  if (!ctx) return res.status(400).json({ error: 'Session WhatsApp deconnectee, reconnecte-toi' });

  const digits = digitsOnly(req.body.target_phone);
  if (digits.length < 8) return res.status(400).json({ error: 'Numéro cible invalide' });

  let exists = false;
  try {
    const result = await ctx.sock.onWhatsApp(digits);
    if (Array.isArray(result) && result.length > 0) exists = !!result[0].exists;
  } catch (e) {
    return res.json({ exists: 'unknown', is_business: false, business_name: null });
  }
  if (!exists) return res.json({ exists: false, is_business: false, business_name: null });

  let isBusiness = false, businessName = null;
  try {
    const prof = await ctx.sock.getBusinessProfile(toJid(digits));
    if (prof && (prof.description || prof.category)) { isBusiness = true; businessName = prof.description || prof.category; }
  } catch (e) {}
  res.json({ exists: true, is_business: is_businessFix(isBusiness), business_name: businessName });
});
function is_businessFix(v) { return !!v; }

app.post('/api/report', async (req, res) => {
  const user = db.users.find(u => u.id === req.body.user_id);
  if (!user) return res.status(400).json({ error: 'Utilisateur inconnu, reconnecte-toi' });
  const ctx = getConnectedSock(user.phone);
  if (!ctx) return res.status(400).json({ error: 'Session WhatsApp deconnectee, reconnecte-toi' });

  const session = db.sessions[user.id];
  if (!session) return res.status(400).json({ error: 'Demarre la session d\u2019abord (DÉMARRER LA SESSION)' });
  if (session.used >= session.max_reports) {
    return res.status(429).json({ error: 'LIMITE ATTEINTE', used: session.used, max_reports: session.max_reports });
  }
  const remaining = pauseRemaining(user.id);
  if (remaining > 0) return res.status(429).json({ error: 'PAUSE', remaining: remaining });

  const targetPhone = (req.body.target_phone || '').trim();
  const digits = digitsOnly(targetPhone);
  if (digits.length < 8) return res.status(400).json({ error: 'Numéro cible invalide' });
  const reason = (req.body.reason || 'Spam').trim();

  // ===== CYCLE AUTOMATIQUE : bloque, puis debloque, puis bloque... =====
  const action = session.next_action === 'unblock' ? 'unblock' : 'block';
  let done = false;
  try {
    await ctx.sock.updateBlockStatus(toJid(digits), action);
    done = true;
  } catch (e1) {
    console.log('[CYCLE ' + action + ' echec] :', e1.message);
    try { await waStart(user.phone, 'none'); } catch (e) {}
    await new Promise(r => setTimeout(r, 4000));
    const ctx2 = getConnectedSock(user.phone);
    if (ctx2) {
      try {
        await ctx2.sock.updateBlockStatus(toJid(digits), action);
        done = true;
      } catch (e2) { console.log('[CYCLE ' + action + ' echec 2] :', e2.message); }
    }
  }

  // Prepare l'action inverse pour le prochain signalement
  session.next_action = (action === 'block') ? 'unblock' : 'block';
  session.used++;
  session.last_report_at = Date.now();
  db.reports.push({
    user_id: user.id, from_phone: user.phone,
    target_phone: '+' + digits, reason: reason,
    wa_action: done ? action : 'echec-' + action,
    created_at: new Date().toISOString()
  });
  saveDb();

  res.json({
    ok: true,
    action: done ? action : 'echec',
    used: session.used, max_reports: session.max_reports,
    left: Math.max(0, session.max_reports - session.used), cooldown: session.cooldown
  });
});

app.post('/api/block', async (req, res) => {
  const user = db.users.find(u => u.id === req.body.user_id);
  if (!user) return res.status(400).json({ error: 'Utilisateur inconnu, reconnecte-toi' });
  const ctx = getConnectedSock(user.phone);
  if (!ctx) return res.status(500).json({ error: 'Session WhatsApp deconnectee, reconnecte-toi' });

  const action = req.body.action === 'unblock' ? 'unblock' : 'block';
  const digits = digitsOnly(req.body.target_phone || '');
  if (digits.length < 8) return res.status(400).json({ error: 'Numéro cible invalide' });

  try {
    await ctx.sock.updateBlockStatus(toJid(digits), action);
    res.json({ ok: true, result: action === 'unblock' ? 'DÉBLOQUÉ ✔' : 'BLOQUÉ ✔ (visible dans WhatsApp : Contacts bloqués)' });
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
