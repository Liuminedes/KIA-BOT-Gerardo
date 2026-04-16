import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import fs from 'fs';
import path from 'path';
import { logger } from '../config/logger.js';
import { config } from '../config/env.js';

let client = null;
let qrCode = null;
let isReady = false;

// ─────────────────────────────────────────────────────────────────────────────
// Registro de IDs de mensajes enviados por el bot (distinguir bot vs asesor)
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
// Filtro de JIDs válidos (solo chats 1-a-1, sin estados/grupos/broadcasts)
// ─────────────────────────────────────────────────────────────────────────────
function isValidClientJid(jid) {
  if (!jid) return false;
  if (jid.includes('@g.us')) return false;
  if (jid === 'status@broadcast' || jid.includes('@broadcast')) return false;
  if (jid.includes('@newsletter')) return false;
  if (jid.includes('@lid')) return false;
  return jid.endsWith('@c.us');
}

// ─────────────────────────────────────────────────────────────────────────────
// Limpiar directorio de sesión en caso de LOGOUT forzado por WhatsApp
// ─────────────────────────────────────────────────────────────────────────────
function cleanAuthDir() {
  try {
    if (fs.existsSync(config.authPath)) {
      fs.rmSync(config.authPath, { recursive: true, force: true });
      logger.info(`[WA] Directorio de sesión eliminado: ${config.authPath}`);
    }
  } catch (err) {
    logger.error(`[WA] Error limpiando auth dir: ${err.message}`);
  }
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
    logger.info('[WA] ✅ WhatsApp conectado y listo');
  });

  client.on('authenticated', () => logger.info('[WA] Autenticado'));
  client.on('auth_failure', (msg) => logger.error(`[WA] Auth failure: ${msg}`));

  // CRÍTICO: cuando WhatsApp manda LOGOUT, la sesión guardada quedó inválida.
  // NO intentar reconectar con la misma sesión — limpiar el directorio y
  // dejar que el siguiente initialize() genere un QR nuevo.
  client.on('disconnected', async (reason) => {
    isReady = false;
    logger.warn(`[WA] Desconectado: ${reason}`);

    if (reason === 'LOGOUT') {
      logger.warn('[WA] Logout detectado — limpiando sesión para re-escaneo');
      try {
        await client.destroy().catch(() => {});
      } catch (_) {}
      cleanAuthDir();
    }

    setTimeout(() => {
      client.initialize().catch(err => logger.error(`[WA] Reconexión fallida: ${err.message}`));
    }, 5000);
  });

  // ── Mensajes ENTRANTES del cliente ──────────────────────────────────────────
  client.on('message', async (msg) => {
    try {
      if (msg.fromMe) return;
      if (!isValidClientJid(msg.from)) return;

      const text = msg.body?.trim();
      if (!text) return;

      const userId = msg.from;
      const pushName = msg._data?.notifyName || '';

      logger.info(`[WA] ← ${userId} (${pushName}): ${text.substring(0, 60)}`);
      await onClientMessage({ userId, text, pushName });

    } catch (err) {
      logger.error(`[WA] Error en message: ${err.message}`);
    }
  });

  // ── Mensajes SALIENTES — distinguir bot vs asesor por msg.id ────────────────
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
// WhatsAppService — API pública
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
      }
      logger.info(`[WA] → Enviado a ${to}${msgId ? ` (${msgId.slice(-8)})` : ''}`);
    } catch (err) {
      logger.error(`[WA] Error enviando a ${to}: ${err.message}`);
    }
  },

  markAsRead() { return Promise.resolve(); },
};