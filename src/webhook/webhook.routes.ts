import { Router } from 'express';
import { starkWebhookHandler, healthHandler } from './webhook.controller';

const router = Router();

// A Stark Bank envia um POST assinado aqui sempre que um pagamento é confirmado
router.post('/stark', starkWebhookHandler);

// Health check interno da rota /webhook/health
router.get('/health', healthHandler);

export default router;
