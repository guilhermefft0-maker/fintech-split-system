import { Request, Response } from 'express';
import { handleWebhook } from './webhook.service';
import { checkDatabaseHealth } from '../database/db';
import { logger } from '../utils/logger';

// POST /webhook/stark
// Recebe os webhooks da Stark Bank.
// Responde rápido — o processamento real acontece de forma assíncrona via SQS.
export async function starkWebhookHandler(req: Request, res: Response): Promise<void> {
  const signature = req.headers['digital-signature'] as string | undefined;

  // rawBody é preenchido pelo middleware express.raw() — necessário pra validar a assinatura
  const rawBody: string = (req as any).rawBody ?? JSON.stringify(req.body);

  try {
    const result = await handleWebhook(rawBody, signature);

    // not_a_payment_event é esperado (eventos que não são pagamento) — retorna 200 mesmo assim
    if (!result.accepted && result.reason !== 'not_a_payment_event') {
      logger.warn({ reason: result.reason }, 'Webhook rejeitado');
      res.status(400).json({ error: result.reason });
      return;
    }

    res.status(200).json({ ok: true, messageId: result.messageId });
  } catch (err) {
    logger.error({ err }, 'Erro inesperado no handler do webhook');
    res.status(500).json({ error: 'internal_error' });
  }
}

// GET /health
// Probe de liveness e readiness — usado pelo Docker Compose e orquestradores
export async function healthHandler(_req: Request, res: Response): Promise<void> {
  const dbOk = await checkDatabaseHealth();

  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    db:     dbOk ? 'conectado' : 'inacessível',
    uptime: process.uptime(),
    ts:     new Date().toISOString(),
  });
}
