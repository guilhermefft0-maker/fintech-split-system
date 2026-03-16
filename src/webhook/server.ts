import 'dotenv/config';
import express from 'express';
import webhookRoutes from './webhook.routes';
import { healthHandler } from './webhook.controller';
import { logger } from '../utils/logger';

const app = express();

// Captura o body bruto antes de qualquer parsing — necessário pra validar a assinatura ECDSA/HMAC.
// Se deixar o express.json() passar primeiro, o body vira objeto e a assinatura não bate mais.
app.use(
  express.raw({
    type: 'application/json',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString('utf-8');
    },
  })
);

// Parse normal de JSON para as outras rotas
app.use(express.json());

// Log de cada requisição HTTP com método, path, status e tempo de resposta
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info(
      {
        method: req.method,
        path:   req.path,
        status: res.statusCode,
        ms:     Date.now() - start,
      },
      'Requisição HTTP'
    );
  });
  next();
});

// Rotas do webhook e health check interno
app.use('/webhook', webhookRoutes);

// Alias na raiz pra facilitar o healthcheck do Docker Compose e K8s
app.get('/health', healthHandler);

// Qualquer rota não mapeada cai aqui
app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Webhook service escutando');
});

// Graceful shutdown — Docker manda SIGTERM antes de parar o container
process.on('SIGTERM', () => {
  logger.info('SIGTERM recebido, encerrando webhook service...');
  process.exit(0);
});

export default app;
