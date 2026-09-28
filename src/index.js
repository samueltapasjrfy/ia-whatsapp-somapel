import { exec } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import makeWASocket, {
  Browsers, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, fetchLatestWaWebVersion,
  isJidBroadcast, isJidGroup, isJidNewsletter, isJidStatusBroadcast, jidNormalizedUser, useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import qrcode from 'qrcode-terminal';
import { formatHandoff, leadVCard, runAgent, transcribeAudio } from './agent.js';
import { brVariants, config, formatBR, normalizeBR } from './config.js';
import { addMessage, getLead, updateLead, upsertLead } from './db.js';

// Logs internos do Baileys vão para data/baileys.log (útil para diagnosticar conexão).
const logger = pino({ level: 'info' }, pino.destination({ dest: new URL('../data/baileys.log', import.meta.url).pathname, sync: false, mkdir: true }));
const log = (...a) => console.log(new Date().toLocaleTimeString('pt-BR'), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let sock;
const botSentIds = new Set();   // ids das mensagens enviadas pelo bot (para distinguir de humano)
const chats = new Map();        // jid -> { pending: [], timer, running }

// Página local com o QR (atualiza sozinha), mais fácil de escanear que o QR no terminal.
const QR_PAGE = new URL('../data/qr.html', import.meta.url).pathname;
let qrPageOpened = false;
function writeQrPage(body) {
  writeFileSync(QR_PAGE, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="4"><title>Somapel SDR — WhatsApp</title>
<body style="font-family:system-ui;display:grid;place-items:center;min-height:95vh;background:#f4f6f8;color:#1d2b36;text-align:center">
<div>${body}</div></body>`);
  if (!qrPageOpened && process.platform === 'darwin') { exec(`open "${QR_PAGE}"`); qrPageOpened = true; }
}

// ───────────────────────────── conexão ─────────────────────────────
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
  // Usa a versão ATUAL do WhatsApp Web; versão defasada faz o celular recusar o pareamento.
  const { version } = await fetchLatestWaWebVersion().catch(() => fetchLatestBaileysVersion()).catch(() => ({ version: undefined }));
  log(`🔌 Conectando (WhatsApp Web ${version?.join('.') || 'padrão'})...`);

  sock = makeWASocket({ auth: state, version, logger, browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: false, syncFullHistory: false });
  sock.ev.on('creds.update', saveCreds);

  if (config.pairingNumber && !state.creds.registered) {
    await sleep(3000);
    const code = await sock.requestPairingCode(config.pairingNumber);
    log(`🔑 Código de pareamento: ${code}  (WhatsApp → Aparelhos conectados → Conectar com número de telefone)`);
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr && !config.pairingNumber) {
      console.log('\n📱 Escaneie o QR code no WhatsApp → Aparelhos conectados → Conectar aparelho:\n');
      qrcode.generate(qr, { small: true });
      QRCode.toString(qr, { type: 'svg', margin: 2, width: 360 }).then((svg) => writeQrPage(
        `<h2>Conectar o WhatsApp da Sofia</h2><div style="background:#fff;padding:12px;border-radius:12px;display:inline-block">${svg}</div>
         <p>WhatsApp → <b>Aparelhos conectados</b> → <b>Conectar aparelho</b></p><small>O código muda a cada ~20s; esta página atualiza sozinha.</small>`,
      )).catch(() => {});
    }
    if (connection === 'open') {
      log(`✅ WhatsApp conectado como ${sock.user?.id}. Agente ${config.agentName} ativo (modelo ${config.model}).`);
      if (qrPageOpened) writeQrPage(`<h1>✅ Conectado!</h1><p>A ${config.agentName} já está atendendo. Pode fechar esta aba.</p>`);
      log(`👩‍💼 Leads aquecidos (score ≥ ${config.handoffScore}) vão para ${config.sellerName}: ${config.sellerNumbers.map(formatBR).join(', ') || '(SELLER_WHATSAPP não configurado)'}`);
      if (!config.replyToAll) log(`🔒 Modo seguro: respondendo apenas ${config.allowedNumbers.join(', ') || '(ninguém — configure ALLOWED_NUMBERS)'}`);
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        log('🚪 Sessão encerrada no celular. Apague a pasta', config.authDir, 'e rode de novo para gerar outro QR.');
        process.exit(1);
      }
      log(`⚠️  Conexão caiu (${code}${lastDisconnect?.error?.message ? ` ${lastDisconnect.error.message}` : ''}). Reconectando...`);
      setTimeout(connect, 2000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try { await onMessage(msg); } catch (err) { log('❌ erro ao processar mensagem:', err); }
    }
  });
}

// ───────────────────────────── recebimento ─────────────────────────────
async function resolvePhone(msg) {
  const jid = msg.key.remoteJid;
  if (jid.endsWith('@s.whatsapp.net')) return jid.split('@')[0];
  const alt = msg.key.remoteJidAlt || msg.key.senderPn;
  if (alt) return jidNormalizedUser(alt).split('@')[0];
  if (jid.endsWith('@lid')) {
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID?.(jid).catch(() => null);
    if (pn) return jidNormalizedUser(pn).split('@')[0];
  }
  return jid.split('@')[0];
}

function unwrap(message = {}) {
  return message.ephemeralMessage?.message || message.viewOnceMessage?.message || message.viewOnceMessageV2?.message
    || message.documentWithCaptionMessage?.message || message;
}

async function onMessage(msg) {
  const jid = msg.key.remoteJid;
  if (!jid || !msg.message || isJidGroup(jid) || isJidBroadcast(jid) || isJidStatusBroadcast(jid) || isJidNewsletter(jid)) return;
  if (msg.message.protocolMessage || msg.message.reactionMessage) return;

  const m = unwrap(msg.message);
  const text = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || '';

  // Mensagem enviada pelo próprio número: se não foi o bot, é um humano assumindo o chat.
  if (msg.key.fromMe) {
    if (botSentIds.has(msg.key.id)) return;
    const selfJid = jidNormalizedUser(sock.user?.id);
    if (jid === selfJid || jid === jidNormalizedUser(sock.user?.lid || '')) return;
    const lead = getLead(jid);
    if (!lead) return;
    const cmd = text.trim().toLowerCase();
    if (cmd === '#bot') { updateLead(jid, { paused_until: 0 }); log(`▶️  bot retomado em ${lead.phone}`); return; }
    if (cmd === '#pausar') { updateLead(jid, { paused_until: Date.now() + 30 * 24 * 3600e3 }); log(`⏸️  bot pausado em ${lead.phone}`); return; }
    if (text) addMessage(jid, 'human', text);
    updateLead(jid, { paused_until: Date.now() + config.humanPauseMinutes * 60e3 });
    log(`🧑 humano respondeu ${lead.phone} — bot pausado por ${config.humanPauseMinutes} min (envie #bot no chat para retomar)`);
    return;
  }

  const phone = await resolvePhone(msg);
  const allowed = new Set(config.allowedNumbers.flatMap(brVariants));
  if (!config.replyToAll && !brVariants(phone).some((v) => allowed.has(v))) {
    log(`🙈 ignorando ${phone} (${jid}) — fora de ALLOWED_NUMBERS`);
    return;
  }

  const lead = upsertLead(jid, { phone: normalizeBR(phone), pushName: msg.pushName });

  // Monta o conteúdo do item (texto / áudio transcrito / imagem)
  const item = { key: msg.key, text: text.trim(), images: [] };
  try {
    if (m.audioMessage) {
      const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      const t = await transcribeAudio(buf, 'audio.ogg');
      item.text = `[áudio transcrito] ${t}`;
      log(`🎙️  áudio de ${phone}: "${t}"`);
    } else if (m.imageMessage) {
      const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      item.images.push(`data:${m.imageMessage.mimetype || 'image/jpeg'};base64,${buf.toString('base64')}`);
      item.text = `[enviou uma imagem]${text ? ` ${text}` : ''}`;
    } else if (m.documentMessage) {
      item.text = `[enviou o documento "${m.documentMessage.fileName || 'arquivo'}"]${text ? ` ${text}` : ''}`;
    } else if (m.stickerMessage) {
      item.text = '[enviou uma figurinha]';
    } else if (m.locationMessage) {
      item.text = `[enviou localização: ${m.locationMessage.name || ''} ${m.locationMessage.address || ''} (${m.locationMessage.degreesLatitude}, ${m.locationMessage.degreesLongitude})]`;
    } else if (m.contactMessage) {
      item.text = `[enviou um contato: ${m.contactMessage.displayName}]`;
    } else if (m.videoMessage) {
      item.text = `[enviou um vídeo]${text ? ` ${text}` : ''}`;
    }
  } catch (err) {
    log('⚠️  falha ao processar mídia:', err.message);
    item.text ||= '[enviou uma mídia que não consegui abrir]';
  }
  if (!item.text) return;

  log(`📩 ${lead.push_name || phone}: ${item.text}`);
  addMessage(jid, 'user', item.text);

  if (lead.paused_until > Date.now()) {
    log(`⏸️  chat ${phone} em atendimento humano — bot não responde`);
    return;
  }

  // Buffer: espera o lead terminar de mandar mensagens picadas.
  const chat = chats.get(jid) || { pending: [], timer: null, running: false };
  chats.set(jid, chat);
  chat.pending.push(item);
  clearTimeout(chat.timer);
  chat.timer = setTimeout(() => flush(jid), config.bufferSeconds * 1000);
}

// ───────────────────────────── resposta ─────────────────────────────
async function flush(jid) {
  const chat = chats.get(jid);
  if (!chat || chat.running || !chat.pending.length) return;
  chat.running = true;
  const batch = chat.pending.splice(0);

  try {
    await sock.readMessages(batch.map((b) => b.key)).catch(() => {});
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});

    const started = Date.now();
    let result;
    try {
      result = await runAgent(jid, { images: batch.flatMap((b) => b.images) });
    } catch (err) {
      log('⚠️  erro OpenAI, tentando de novo:', err.message);
      await sleep(2000);
      result = await runAgent(jid, { images: batch.flatMap((b) => b.images) });
    }

    const { replies, attachments, handoff, updates } = result;
    for (let i = 0; i < replies.length; i++) {
      const typingMs = Math.min(1500 + replies[i].length * 30, 7000) - (i === 0 ? Date.now() - started : 0);
      await sock.sendPresenceUpdate('composing', jid).catch(() => {});
      if (typingMs > 0) await sleep(typingMs);
      await send(jid, { text: replies[i] });
      log(`🤖 ${config.agentName} → ${getLead(jid).phone}: ${replies[i].replace(/\n/g, ' ⏎ ')}`);
    }
    for (const a of attachments) await sendAttachment(jid, a);
    await sock.sendPresenceUpdate('paused', jid).catch(() => {});

    if (handoff) await notifySellers(formatHandoff(handoff), handoff.lead);
    for (const u of updates) await notifySellers(u);

    const l = getLead(jid);
    log(`📊 ${l.phone}: score ${l.score} (${l.temperature}) · ${l.stage}`);
  } catch (err) {
    log('❌ falha ao responder:', err);
    await send(jid, { text: 'Opa, tive uma instabilidade aqui 😅 Já já te respondo!' }).catch(() => {});
    await notifySellers(`⚠️ O agente falhou ao responder ${getLead(jid)?.phone}. Verifique o chat.`);
  } finally {
    chat.running = false;
    if (chat.pending.length) chat.timer = setTimeout(() => flush(jid), 1500);
  }
}

async function send(jid, content) {
  const sent = await sock.sendMessage(jid, content);
  if (sent?.key?.id) botSentIds.add(sent.key.id);
  return sent;
}

async function sendAttachment(jid, a) {
  try {
    await sock.sendPresenceUpdate('composing', jid).catch(() => {});
    await sleep(1000);
    if (a.kind === 'document') {
      await send(jid, { document: readFileSync(a.path), mimetype: 'application/pdf', fileName: a.fileName });
    } else if (a.kind === 'image') {
      await send(jid, { image: readFileSync(a.path), mimetype: 'image/jpeg', caption: a.caption });
    }
    log(`📎 enviado ${a.kind}: ${a.fileName || a.produto || a.caption}`);
  } catch (err) {
    log(`⚠️  falha ao enviar ${a.kind}:`, err.message);
  }
}

// Descobre o JID real no WhatsApp (no Brasil a conta pode estar registrada com ou sem o 9º dígito).
const jidCache = new Map();
async function resolveJid(number) {
  if (jidCache.has(number)) return jidCache.get(number);
  let jid = `${number}@s.whatsapp.net`;
  for (const v of brVariants(number)) {
    const [r] = await sock.onWhatsApp(v).catch(() => []);
    if (r?.exists) { jid = r.jid; break; }
  }
  jidCache.set(number, jid);
  return jid;
}

async function notifySellers(text, lead) {
  if (!config.sellerNumbers.length) {
    log(`📣 (SELLER_WHATSAPP não configurado) notificação:\n${text}`);
    return;
  }
  for (const n of config.sellerNumbers) {
    try {
      const jid = await resolveJid(n);
      await send(jid, { text });
      if (lead?.phone) await send(jid, { contacts: { displayName: leadVCard(lead).displayName, contacts: [{ vcard: leadVCard(lead).vcard }] } });
    } catch (err) {
      log('⚠️  falha ao notificar', config.sellerName, n, err.message);
    }
  }
  log(`📣 ${config.sellerName} notificada (${config.sellerNumbers.map(formatBR).join(', ')})`);
}

connect();
