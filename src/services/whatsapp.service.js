import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import { logger } from '../config/logger.js';
import { config } from '../config/env.js';

let client = null;
let qrCode = null;
let isReady = false;

// Timestamp de cuando el cliente se conectó (unix segundos)
// Se usa para ignorar mensajes muy antiguos que llegan en la sincronización inicial
let readyTimestamp = 0;

// Margen de gracia: aceptamos mensajes de hasta 2 minutos ANTES del ready.
// Esto cubre el caso donde WhatsApp asigna al mensaje un timestamp del servidor
// que puede ser unos segundos previo al evento 'ready' local.
const OLD_MESSAGE_THRESHOLD_SEC = 120;

// ─────────────────────────────────────────────────────────────────────────────
// Registro de IDs de mensajes enviados por el bot
// ─────────────────────────────────────────────────────────────────────────────
const botSentIds = new Set();
const BOT_ID_TTL = 60_000;

function registerBotMessage(msgId) {
  if (!msgId) return;
  botSentIds.add(msgId);
  setTimeout(() => botSentIds.delete(msgId), BOT_ID_TTL);
}

function isBotMessage(msgId) {
  return msgId && botSentIds.has(msgId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Filtro de JIDs válidos (solo chats 1-a-1 con clientes reales)
// ─────────────────────────────────────────────────────────────────────────────
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
// INIT
// ─────────────────────────────────────────────────────────────────────────────
export async function initWhatsApp(onClientMessage, onAdvisorMessage) {
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

  // ── Mensajes ENTRANTES del cliente ──────────────────────────────────────────
  client.on('message', async (msg) => {
    try {
      if (msg.fromMe) return;

      // Log RAW para diagnóstico — cada mensaje que entra, sin filtros
      logger.info(`[WA:RAW-IN] from=${msg.from} ts=${msg.timestamp} body="${(msg.body || '').substring(0, 40)}"`);

      // Filtrar JIDs no válidos (estados, broadcasts, canales, grupos)
      if (!isValidClientJid(msg.from)) {
        logger.info(`[WA] Ignorado (JID inválido): ${msg.from}`);
        return;
      }

      // Ignorar mensajes muy antiguos (sincronización inicial)
      // Con margen de gracia de 2 minutos para cubrir desfase de timestamp
      if (msg.timestamp && msg.timestamp < (readyTimestamp - OLD_MESSAGE_THRESHOLD_SEC)) {
        logger.info(`[WA] Ignorado (mensaje antiguo): ${msg.from} ts=${msg.timestamp} readyTs=${readyTimestamp}`);
        return;
      }

      const text = msg.body?.trim();
      if (!text) {
        logger.info(`[WA] Ignorado (sin texto): ${msg.from}`);
        return;
      }

      const userId = msg.from;
      const pushName = msg._data?.notifyName || '';

      logger.info(`[WA] ← ${userId} (${pushName}): ${text.substring(0, 60)}`);
      await onClientMessage({ userId, text, pushName });

    } catch (err) {
      logger.error(`[WA] Error en message: ${err.message}`);
    }
  });

  // ── Mensajes SALIENTES ──────────────────────────────────────────────────────
  client.on('message_create', async (msg) => {
    try {
      if (!msg.fromMe) return;
      if (!isValidClientJid(msg.to)) return;

      const msgId = msg.id?._serialized;
      if (!msgId) return;

      if (isBotMessage(msgId)) return;

      const clientUserId = msg.to;
      logger.info(`[WA] → Gerardo escribió a ${clientUserId}: ${msg.body?.substring(0, 60)}`);
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