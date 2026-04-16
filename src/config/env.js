import dotenv from 'dotenv';
dotenv.config();

const required = ['REDIS_URL', 'ADMIN_TOKEN'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`[Config] Variable requerida: ${key}`);
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',
  redis: {
    url: process.env.REDIS_URL,
    sessionTTL: 60 * 60 * 6, // 6 horas
  },
  advisor: {
    phone: process.env.ADVISOR_PHONE || null,
  },
  admin: {
    token: process.env.ADMIN_TOKEN,
  },
  // Path del volumen persistente (configurado en la plataforma de deploy).
  // En Railway: montar un Volume en esta ruta exacta.
  // En local: usa ./wwebjs_auth (no persistente, solo para desarrollo).
  authPath: process.env.AUTH_DATA_PATH || './wwebjs_auth',
};