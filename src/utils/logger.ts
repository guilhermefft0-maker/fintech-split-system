import pino from 'pino';

// Em dev mostra log colorido e legível, em prod sai JSON puro
const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    base: {
      service: process.env.SERVICE_NAME || 'fintech-split',
      env: process.env.NODE_ENV || 'development',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  },
  isDev
    ? pino.transport({
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      })
    : undefined
);

// Cria um logger filho com contexto extra (ex: eventId, paymentId)
export function childLogger(context: Record<string, unknown>) {
  return logger.child(context);
}
