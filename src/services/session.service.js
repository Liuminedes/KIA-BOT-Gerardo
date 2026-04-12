import { getRedisClient } from '../config/redis.js';
import { logger } from '../config/logger.js';

const PREFIX        = 'kia:session:';
const PAUSED_PREFIX = 'kia:paused:';
const TTL           = 60 * 60 * 6; // 6 horas

// ─────────────────────────────────────────────────────────────────────────────
// initiatedBy: indica quién abrió la conversación
//   'bot'     → el cliente escribió primero, bot activó el flujo
//   'advisor' → Gerardo escribió primero, bot nació pausado
//   null      → sesión nueva sin determinar aún (no debería quedar en este estado)
// ─────────────────────────────────────────────────────────────────────────────
function defaultSession(userId) {
  return {
    userId,
    step:         'WELCOME',
    initiatedBy:  null,    // 'bot' | 'advisor'
    lead: {
      name:         null,
      phone:        null,
      interest:     null,
      budget:       null,
      employment:   null,
      income:       null,
      creditStatus: null,
    },
    handoffMode:  false,   // flujo completo terminado → bot silencioso
    bryantook:    false,   // asesor tomó/interrumpió → bot silencioso
    pushName:     null,
    updatedAt:    Date.now(),
  };
}

export const SessionService = {

  async get(userId) {
    const redis = getRedisClient();
    try {
      const raw = await redis.get(`${PREFIX}${userId}`);
      if (!raw) return defaultSession(userId);
      return JSON.parse(raw);
    } catch (err) {
      logger.error(`[Session] get error: ${err.message}`);
      return defaultSession(userId);
    }
  },

  async save(session) {
    const redis = getRedisClient();
    try {
      session.updatedAt = Date.now();
      await redis.setex(`${PREFIX}${session.userId}`, TTL, JSON.stringify(session));
    } catch (err) {
      logger.error(`[Session] save error: ${err.message}`);
    }
  },

  async reset(userId) {
    const redis = getRedisClient();
    try {
      await redis.del(`${PREFIX}${userId}`);
      logger.info(`[Session] Reset completo: ${userId}`);
    } catch (err) {
      logger.error(`[Session] reset error: ${err.message}`);
    }
  },

  // Marcar que el asesor tomó esta conversación (interrupción manual)
  async advisorTook(userId) {
    const session = await this.get(userId);
    session.bryantook = true;
    await this.save(session);
    logger.info(`[Session] Asesor tomó conversación: ${userId}`);
  },

  // Marcar que el asesor INICIÓ esta conversación (escribió antes que el cliente)
  // Esto setea bryantook=true desde el arranque
  async markAdvisorInitiated(userId) {
    const session = await this.get(userId);
    // Solo marcar si la sesión es completamente nueva
    if (session.initiatedBy === null) {
      session.initiatedBy = 'advisor';
      session.bryantook   = true;
      await this.save(session);
      logger.info(`[Session] Conversación iniciada por el asesor: ${userId}`);
    }
  },

  // Marcar que el cliente inició (bot activo)
  async markBotInitiated(userId) {
    const session = await this.get(userId);
    if (session.initiatedBy === null) {
      session.initiatedBy = 'bot';
      await this.save(session);
    }
    return session;
  },

  // Reactivar bot después de handoff completo — mantiene datos del lead
  async reactivateAfterHandoff(userId) {
    const session = await this.get(userId);
    const leadName = session.lead?.name || null;
    session.handoffMode = false;
    session.bryantook   = false;
    session.step        = 'MENU';
    // Conserva el lead completo para personalizar el saludo
    await this.save(session);
    logger.info(`[Session] Reactivado post-handoff: ${userId}`);
    return { session, leadName };
  },

  // Reactivar bot después de interrupción del asesor — flujo desde cero
  async reactivateAfterAdvisor(userId) {
    const session       = defaultSession(userId);
    session.initiatedBy = 'bot'; // ahora el cliente toma control
    session.userId      = userId;
    await this.save(session);
    logger.info(`[Session] Reactivado post-asesor: ${userId}`);
    return session;
  },

  // Pausa global desde admin
  async setPausedGlobal(paused) {
    const redis = getRedisClient();
    await redis.set(`${PAUSED_PREFIX}global`, paused ? '1' : '0');
  },

  async isGloballyPaused() {
    const redis = getRedisClient();
    const val   = await redis.get(`${PAUSED_PREFIX}global`);
    return val === '1';
  },

  // Listar sesiones activas
  async listActive() {
    const redis    = getRedisClient();
    const keys     = await redis.keys(`${PREFIX}*`);
    const sessions = [];
    for (const key of keys) {
      const raw = await redis.get(key);
      if (raw) {
        try { sessions.push(JSON.parse(raw)); } catch (_) {}
      }
    }
    return sessions;
  },

  // ── Números excluidos ─────────────────────────────────────────────────────
  async getExcludedNumbers() {
    const redis = getRedisClient();
    try {
      const raw = await redis.get('kia:excluded');
      return raw ? JSON.parse(raw) : [];
    } catch (err) {
      logger.error(`[Session] getExcluded error: ${err.message}`);
      return [];
    }
  },

  async addExcludedNumber(number) {
    const list  = await this.getExcludedNumbers();
    const clean = number.replace(/\D/g, '');
    if (!clean || list.includes(clean)) return list;
    list.push(clean);
    const redis = getRedisClient();
    await redis.set('kia:excluded', JSON.stringify(list));
    logger.info(`[Session] Número excluido: ${clean}`);
    return list;
  },

  async removeExcludedNumber(number) {
    const list    = await this.getExcludedNumbers();
    const clean   = number.replace(/\D/g, '');
    const updated = list.filter(n => n !== clean);
    const redis   = getRedisClient();
    await redis.set('kia:excluded', JSON.stringify(updated));
    logger.info(`[Session] Número removido de excluidos: ${clean}`);
    return updated;
  },

  async isExcluded(userId) {
    const list  = await this.getExcludedNumbers();
    const phone = userId.replace(/@.*$/, '');
    return list.some(n => n === userId || n === phone || phone.includes(n) || n.includes(phone));
  },
};
