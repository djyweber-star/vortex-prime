let userId = null;
let pollTimer = null;
let waMode = 'pairing';
let numIsBusiness = false;
let autoRun = false;

function setMode(m) {
  waMode = m;
  document.getElementById('mode-qr').classList.toggle('active', m === 'qr');
  document.getElementById('mode-pairing').classList.toggle('active', m === 'pairing');
}

async function connect() {
  const phone = document.getElementById('phone').value.trim();
  if (phone.replace(/\D/g, '').length < 10) return alert('Numéro invalide (avec indicatif pays)');
  document.getElementById('pairing').classList.remove('hidden');
  document.getElementById('qr').classList.add('hidden');
  document.getElementById('pairing-code').textContent = '';
  document.getElementById('wa-status').textContent = 'Vérification de la session existante...';

  const pre = await fetch('/api/wa/status/' + encodeURIComponent(phone));
  const preData = await pre.json();
  if (preData.status === 'connected') {
    document.getElementById('wa-status').textContent = 'Session déjà active ✔';
    await enterPanel();
    return;
  }

  document.getElementById('wa-status').textContent = 'Connexion aux serveurs WhatsApp... (le code apparaît après ~5s)';
  const res = await fetch('/api/wa/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: phone, mode: waMode })
  });
  const data = await res.json();
  if (data.error) { document.getElementById('wa-status').textContent = data.error; return; }
  if (data.status === 'connected') {
    document.getElementById('wa-status').textContent = 'Session déjà active ✔';
    await enterPanel();
    return;
  }
  pollStatus(phone);
}

function pollStatus(phone) {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const res = await fetch('/api/wa/status/' + encodeURIComponent(phone));
    const s = await res.json();
    if (s.qr) {
      const qrImg = document.getElementById('qr');
      qrImg.src = s.qr; qrImg.classList.remove('hidden');
      document.getElementById('wa-status').innerHTML =
        'Scanne ce QR : <b>WhatsApp → Paramètres → Appareils connectés → Associer un appareil</b>';
    }
    if (s.pairing_code) {
      document.getElementById('pairing-code').textContent = s.pairing_code;
      document.getElementById('wa-status').innerHTML =
        '<b>WhatsApp → Paramètres → Appareils connectés → Associer un appareil → Associer avec le numéro de téléphone</b>, puis saisis ce code :';
    }
    if (s.status === 'connected') {
      clearInterval(pollTimer);
      document.getElementById('wa-status').textContent = 'Session authentifiée par WhatsApp ✔';
      await enterPanel();
    }
  }, 2000);
}

async function resetSession() {
  const phone = document.getElementById('phone').value.trim();
  if (!phone) return alert('Entre ton numéro d\u2019abord');
  await fetch('/api/wa/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: phone })
  });
  document.getElementById('pairing').classList.add('hidden');
  alert('Session réinitialisée. Relance la connexion.');
}

async function enterPanel() {
  const phone = document.getElementById('phone').value.trim();
  const res = await fetch('/api/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: phone })
  });
  const data = await res.json();
  userId = data.user_id;
  document.getElementById('step-connect').classList.add('hidden');
  document.getElementById('step-panel').classList.remove('hidden');
  renderReports();
}

function stepVal(id, delta) {
  const el = document.getElementById(id);
  let v = parseInt(el.value) || 0;
  v = Math.max(parseInt(el.min), Math.min(parseInt(el.max), v + delta));
  el.value = v;
}

async function startSession() {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: userId,
      max_reports: document.getElementById('max-reports').value,
      cooldown: document.getElementById('cooldown').value
    })
  });
  const data = await res.json();
  if (data.error) return alert(data.error);
  document.getElementById('report-zone').classList.remove('hidden');
  updateQuota();
}

function updateQuota() {
  fetch('/api/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId })
  }).then(r => r.json()).then(d => {
    if (d.no_session) return;
    document.getElementById('quota').textContent =
      'CYCLES : ' + d.used + ' / ' + d.max_reports + ' — ' + d.left + ' RESTANTS — DÉLAI : ' + d.cooldown + 's';
  });
}

async function checkNumber() {
  const target = document.getElementById('target').value.trim();
  const msg = document.getElementById('message');
  if (target.replace(/\D/g, '').length < 8) { msg.textContent = 'Numéro invalide'; return; }

  const res = await fetch('/api/number-info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: userId, target_phone: target })
  });
  const data = await res.json();
  const box = document.getElementById('number-type');
  box.classList.remove('hidden');
  if (data.error) { msg.textContent = data.error; box.classList.add('hidden'); return; }

  numIsBusiness = !!data.is_business;
  if (data.exists === true && numIsBusiness) {
    document.getElementById('ntext').textContent = '🏢 WHATSAPP BUSINESS détecté' + (data.business_name ? ' — ' + data.business_name : '');
    document.getElementById('reason-biz').classList.remove('hidden');
    document.getElementById('reason-normal').classList.add('hidden');
  } else if (data.exists === false) {
    document.getElementById('ntext').textContent = '⚠️ Numéro absent de WhatsApp — vérifie-le';
    document.getElementById('reason-normal').classList.remove('hidden');
    document.getElementById('reason-biz').classList.add('hidden');
  } else {
    document.getElementById('ntext').textContent = '👤 Numéro détecté (ou vérification non concluante)';
    document.getElementById('reason-normal').classList.remove('hidden');
    document.getElementById('reason-biz').classList.add('hidden');
  }
}

function currentReason() {
  return numIsBusiness
    ? document.getElementById('reason-b').value
    : document.getElementById('reason').value;
}

function startCountdown(seconds, onDone) {
  const msg = document.getElementById('message');
  let remaining = seconds;
  const timer = setInterval(() => {
    if (remaining <= 0) { clearInterval(timer); if (onDone) onDone(); return; }
    msg.innerHTML = 'PAUSE : <b>' + remaining + 's</b> avant le prochain cycle — LÂCHE TOUT, ÇA CONTINUE TOUT SEUL';
    remaining--;
  }, 1000);
}

async function reportOnce(doBlock) {
  const res = await fetch('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: userId,
      target_phone: document.getElementById('target').value.trim(),
      reason: currentReason(),
      do_block: doBlock
    })
  });
  return await res.json();
}

function setBusy(b) {
  document.getElementById('btn-report').disabled = b;
  document.getElementById('btn-report-noblock').disabled = b;
  document.getElementById('btn-stop').classList.toggle('hidden', !b);
}

// ===== MOTEUR AUTOMATIQUE =====
// UN appui -> repetitions jusqu'au nombre choisi, pauses incluses, arret automatique.
async function runAuto(doBlock) {
  if (autoRun) return;
  autoRun = true;
  setBusy(true);
  const msg = document.getElementById('message');
  let fini = false;

  while (autoRun && !fini) {
    const data = await reportOnce(doBlock);
    if (!autoRun) break;

    if (data.error) {
      if (data.error === 'PAUSE') {
        await new Promise(resolve => startCountdown(data.remaining, resolve));
        continue;
      }
      msg.textContent = '⛔ ' + data.error;
      break;
    }

    if (doBlock) {
      msg.textContent = data.action === 'block'
        ? '🔄 CYCLE ' + data.used + ' / ' + data.max_reports + ' : SIGNALÉ + BLOQUÉ ✔'
        : '🔄 CYCLE ' + data.used + ' / ' + data.max_reports + ' : DÉBLOQUÉ ✔';
    } else {
      msg.textContent = '🔄 SIGNALEMENT ' + data.used + ' / ' + data.max_reports + ' ENREGISTRÉ (sans blocage) ✔';
    }
    updateQuota(); renderReports();

    if (data.left <= 0) {
      fini = true;
      msg.textContent = '🏁 TERMINÉ : ' + data.used + ' / ' + data.max_reports + ' effectués. Arrêt automatique.';
      break;
    }
    await new Promise(resolve => startCountdown(data.cooldown, resolve));
  }

  autoRun = false;
  setBusy(false);
}

function report() { runAuto(true); }
function reportNoBlock() { runAuto(false); }

function stopAuto() {
  autoRun = false;
  document.getElementById('message').textContent = '⏹ Arrêté par l\u2019utilisateur';
  setBusy(false);
}

async function blockAction(action) {
  const res = await fetch('/api/block', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: userId,
      target_phone: document.getElementById('target').value.trim(),
      action: action
    })
  });
  const data = await res.json();
  document.getElementById('message').textContent = data.error || data.result;
}

async function renderReports() {
  const res = await fetch('/api/reports');
  const reports = await res.json();
  const list = document.getElementById('report-list');
  list.innerHTML = reports.length
    ? reports.map(r =>
        '<li><span class="num">' + r.target_phone + '</span> — ' + r.reason +
        ' [' + r.wa_action + ']' +
        '<div class="meta">' + r.created_at + '</div></li>').join('')
    : '<li style="color:#446">Aucun signalement pour le moment.</li>';
}

setInterval(renderReports, 15000);
renderReports();
