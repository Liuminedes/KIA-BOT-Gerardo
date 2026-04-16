import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import { logger } from '../config/logger.js';
import { config } from '../config/env.js';

let client = null;
let qrCode = null;
let isReady = false;
let readyTimestamp = 0;

// Callback guardado para usar también desde el poller
let _onClientMessage = null;

// Procesados por el poller — evita procesar 2 veces el mismo msg
const processedIds = new Set();
const PROCESSED_TTL = 5 * 60_000; // 5 min

// IDs de mensajes enviados por el bot
const botSentIds = new Set();
const BOT_ID_TTL = 60_000;

const OLD_MESSAGE_THRESHOLD_SEC = 120;

function registerBotMessage(msgId) {
  if (!msgId) return;
  botSentIds.add(msgId);
  setTimeout(() => botSentIds.delete(msgId), BOT_ID_TTL);
}

function isBotMessage(msgId) {
  return msgId && botSentIds.has(msgId);
}

function markProcessed(msgId) {
  if (!msgId) return;
  processedIds.add(msgId);
  setTimeout(() => processedIds.delete(msgId), PROCESSED_TTL);
}

function wasProcessed(msgId) {
  return msgId && processedIds.has(msgId);
}

// ─── Filtro de JIDs válidos ────────────────────────────────────────────────
function isValidClientJid(jid) {
  if (!jid) return false;
  if (jid.includes('@g.us')) return false;
  if (jid === 'status@broadcast' || jid.includes('@broadcast')) return false;
  if (jid.includes('@newsletter')) return false;
  if (jid.includes('@lid')) return false;
  return jid.endsWith('@c.us');
}

export function getQR() { return qrCode; }
export function isClientReady() { return isReady; }
export function getClient() { return client; }

// ─────────────────────────────────────────────────────────────────────────────
// Procesar un mensaje entrante (unificado: usado por evento Y por poller)
// ─────────────────────────────────────────────────────────────────────────────
async function processIncomingMessage(msg, source = 'event') {
  try {
    if (msg.fromMe) return;
    if (!isValidClientJid(msg.from)) return;

    const msgId = msg.id?._serialized || msg.id?.id;
    if (wasProcessed(msgId)) return;
    markProcessed(msgId);

    // Ignorar muy antiguos
    if (msg.timestamp && msg.timestamp < (readyTimestamp - OLD_MESSAGE_THRESHOLD_SEC)) {
      return;
    }

    const text = (msg.body || '').trim();
    if (!text) return;

    const userId = msg.from;
    const pushName = msg._data?.notifyName || msg.notifyName || '';

    logger.info(`[WA:${source}] ← ${userId} (${pushName}): ${text.substring(0, 60)}`);
    if (_onClientMessage) {
      await _onClientMessage({ userId, text, pushName });
    }
  } catch (err) {
    logger.error(`[WA] Error procesando mensaje: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POLLER de fallback — revisa chats con mensajes no leídos cada 5 segundos
// Crítico para mitigar el bug de whatsapp-web.js #5765 donde los eventos
// 'message' no se disparan confiablemente.
// ─────────────────────────────────────────────────────────────────────────────
async function runPoller() {
  if (!isReady || !client) return;

  try {
    const chats = await client.getChats();
    for (const chat of chats) {
      if (!chat.unreadCount || chat.unreadCount < 1) continue;
      if (!isValidClientJid(chat.id?._serialized)) continue;

      // Trae los últimos N mensajes del chat (N = unreadCount)
      const messages = await chat.fetchMessages({ limit: chat.unreadCount });
      for (const msg of messages) {
        await processIncomingMessage(msg, 'poll');
      }
    }
  } catch (err) {
    logger.error(`[WA:Poller] Error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
export async function initWhatsApp(onClientMessage, onAdvisorMessage) {
  _onClientMessage = onClientMessage;

  const puppeteerConfig = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
    ],
  };

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    puppeteerConfig.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.authPath }),
    puppeteer: puppeteerConfig,
  });

  client.on('qr', (qr) => {
    qrCode = qr;
    isReady = false;
    logger.info('[WA] QR generado — escanea en /admin');
  });

  client.on('ready', () => {
    isReady = true;
    qrCode = null;
    readyTimestamp = Math.floor(Date.now() / 1000);
    logger.info(`[WA] ✅ WhatsApp conectado y listo (readyTs=${readyTimestamp})`);

    // Arrancar poller cada 5s como fallback
    setInterval(runPoller, 5_000);
    logger.info('[WA] Poller de fallback iniciado (intervalo: 5s)');
  });

  client.on('authenticated', () => logger.info('[WA] Autenticado'));
  client.on('auth_failure', (msg) => logger.error(`[WA] Auth failure: ${msg}`));

  client.on('disconnected', (reason) => {
    isReady = false;
    logger.warn(`[WA] Desconectado: ${reason}`);
    setTimeout(() => {
      client.initialize().catch(err => logger.error(`[WA] Reconexión fallida: ${err.message}`));
    }, 5000);
  });

  // ── Mensajes ENTRANTES (evento en tiempo real) ──────────────────────────────
  client.on('message', async (msg) => {
    await processIncomingMessage(msg, 'evt');
  });

  // ── Mensajes SALIENTES ─────────────────────────────────────────────────────
  client.on('message_create', async (msg) => {
    try {
      if (!msg.fromMe) return;
      if (!isValidClientJid(msg.to)) return;

      const msgId = msg.id?._serialized;
      if (!msgId) return;
      if (isBotMessage(msgId)) return;

      const clientUserId = msg.to;
      logger.info(`[WA] → Gerardo escribió a ${clientUserId}: ${(msg.body || '').substring(0, 60)}`);
      await onAdvisorMessage({ clientUserId });
    } catch (err) {
      logger.error(`[WA] Error en message_create: ${err.message}`);
    }
  });

  await client.initialize();
}

// ─────────────────────────────────────────────────────────────────────────────
// WhatsAppService
// ─────────────────────────────────────────────────────────────────────────────
export const WhatsAppService = {

  async sendText(to, text) {
    if (!isReady) {
      logger.warn(`[WA] No listo — no se envió a ${to}`);
      return;
    }

    if (!isValidClientJid(to)) {
      logger.warn(`[WA] Destino inválido, no se envía: ${to}`);
      return;
    }

    try {
      const sentMsg = await client.sendMessage(to, text);
      const msgId = sentMsg?.id?._serialized;

      if (msgId) {
        registerBotMessage(msgId);
        logger.info(`[WA] → Enviado a ${to} (ID: ${msgId.slice(-8)})`);
      } else {
        logger.warn(`[WA] Mensaje enviado a ${to} sin ID retornado`);
      }
    } catch (err) {
      logger.error(`[WA] Error enviando a ${to}: ${err.message}`);
    }
  },

  markAsRead() { return Promise.resolve(); },
};