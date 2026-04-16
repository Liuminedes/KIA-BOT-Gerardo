import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
import { logger } from '../config/logger.js';
import { config } from '../config/env.js';
import { SessionService } from './session.service.js';

let client = null;
let qrCode = null;
let isReady = false;

// ─────────────────────────────────────────────────────────────────────────────
// Registro de IDs de mensajes enviados por el bot
// Clave: msg.id._serialized  →  timestamp de envío
// Permite distinguir con certeza bot vs asesor, sin depender de texto ni timing
// ─────────────────────────────────────────────────────────────────────────────
const botSentIds = new Map();
const BOT_ID_TTL = 30_000; // 30 segundos — margen amplio para latencia de Railway

function registerBotMessage(msgId) {
  botSentIds.set(msgId, Date.now());
  // Limpieza automática después del TTL
  setTimeout(() => botSentIds.delete(msgId), BOT_ID_TTL);
}

function isBotMessage(msgId) {
  return botSentIds.has(msgId);
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
      if (msg.fromMe) return; // ignorar los propios
      if (msg.from.includes('@g.us')) return; // ignorar grupos

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

  // ── Mensajes SALIENTES — distinguir bot vs asesor por ID exacto ─────────────
  // Este evento captura TODOS los mensajes enviados desde el número del asesor,
  // tanto los del bot (via client.sendMessage) como los que Gerardo escribe manualmente.
  client.on('message_create', async (msg) => {
    try {
      if (!msg.fromMe) return;
      if (msg.to.includes('@g.us')) return;

      const clientUserId = msg.to;
      const msgId = msg.id?._serialized;

      if (!msgId) {
        logger.warn('[WA] message_create sin id._serialized — ignorado');
        return;
      }

      // Si el ID está registrado → fue el bot → ignorar
      if (isBotMessage(msgId)) {
        logger.debug(`[WA] Mensaje propio del bot confirmado (ID: ${msgId.slice(-8)})`);
        return;
      }

      // ID no registrado → fue Gerardo escribiendo manualmente
      logger.info(`[WA] → Gerardo escribió a ${clientUserId}: ${msg.body?.substring(0, 60)}`);
      await onAdvisorMessage({ clientUserId });

    } catch (err) {
      logger.error(`[WA] Error en message_create: ${err.message}`);
    }
  });

  await client.initialize();
}

// ─────────────────────────────────────────────────────────────────────────────
// WhatsAppService — API pública para el flujo
// ─────────────────────────────────────────────────────────────────────────────
export const WhatsAppService = {

  async sendText(to, text) {
    if (!isReady) {
      logger.warn(`[WA] No listo — no se envió a ${to}`);
      return;
    }
    try {
      // Enviar y registrar el ID del mensaje ANTES de que llegue message_create
      const sentMsg = await client.sendMessage(to, text);
      const msgId = sentMsg?.id?._serialized;

      if (msgId) {
        registerBotMessage(msgId);
        logger.debug(`[WA] Enviado a ${to} (ID: ${msgId.slice(-8)})`);
      } else {
        // Fallback: si por alguna razón no hay ID, loguear pero no romper
        logger.warn(`[WA] Mensaje enviado a ${to} sin ID retornado`);
      }
    } catch (err) {
      logger.error(`[WA] Error enviando a ${to}: ${err.message}`);
    }
  },

  // markAsRead es no-op en whatsapp-web.js sin parámetro de msgId útil,
  // se mantiene por compatibilidad con el flow
  markAsRead() { return Promise.resolve(); },
};