import { PoolClient } from 'pg';
import { logger } from './logger';

export type PaymentStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface ProcessedPayment {
  id: string;
  external_id: string;
  status: PaymentStatus;
  amount: number;
  holding_amount: number;
  licensed_amount: number;
  retry_count: number;
  created_at: Date;
}

// Tenta adquirir o lock de idempotência para um pagamento.
//
// Regras:
//   COMPLETED  → já processado, retorna null (pula)
//   PROCESSING → outro worker está processando, retorna null (pula)
//   PENDING/FAILED → pode processar/reprocessar, retorna o registro
//   Não encontrado → insere como PROCESSING e retorna
//
// Precisa ser chamado dentro de uma transação aberta.
// O SELECT FOR UPDATE SKIP LOCKED evita que dois workers peguem o mesmo pagamento.
export async function acquireIdempotencyLock(
  client: PoolClient,
  externalId: string,
  amount: number
): Promise<ProcessedPayment | null> {
  const existing = await client.query<ProcessedPayment>(
    `SELECT * FROM processed_payments
     WHERE external_id = $1
     FOR UPDATE SKIP LOCKED`,
    [externalId]
  );

  if (existing.rows.length > 0) {
    const record = existing.rows[0];

    if (record.status === 'COMPLETED') {
      logger.info({ externalId }, 'Pagamento já processado, pulando');
      return null;
    }

    if (record.status === 'PROCESSING') {
      logger.warn({ externalId }, 'Pagamento sendo processado por outro worker, pulando');
      return null;
    }

    // PENDING ou FAILED — marca como PROCESSING e permite reprocessar
    await client.query(
      `UPDATE processed_payments
       SET status = 'PROCESSING', retry_count = retry_count + 1, updated_at = NOW()
       WHERE id = $1`,
      [record.id]
    );

    logger.info(
      { externalId, tentativa: record.retry_count + 1 },
      'Reprocessando pagamento'
    );

    return { ...record, status: 'PROCESSING', retry_count: record.retry_count + 1 };
  }

  // Primeira vez que vemos esse pagamento — calcula o split e insere
  const holdingAmount  = Math.round(amount * 0.02);  // 2% holding
  const licensedAmount = amount - holdingAmount;       // 98% licenciado

  const inserted = await client.query<ProcessedPayment>(
    `INSERT INTO processed_payments
       (external_id, status, amount, holding_amount, licensed_amount)
     VALUES ($1, 'PROCESSING', $2, $3, $4)
     RETURNING *`,
    [externalId, amount, holdingAmount, licensedAmount]
  );

  logger.info({ externalId, amount, holdingAmount, licensedAmount }, 'Novo pagamento registrado');

  return inserted.rows[0];
}

// Marca o pagamento como concluído com sucesso
export async function markPaymentCompleted(
  client: PoolClient,
  paymentId: string
): Promise<void> {
  await client.query(
    `UPDATE processed_payments
     SET status = 'COMPLETED', updated_at = NOW()
     WHERE id = $1`,
    [paymentId]
  );
}

// Marca o pagamento como falho e registra o motivo
export async function markPaymentFailed(
  client: PoolClient,
  paymentId: string,
  errorMessage: string
): Promise<void> {
  await client.query(
    `UPDATE processed_payments
     SET status = 'FAILED', error_message = $2, updated_at = NOW()
     WHERE id = $1`,
    [paymentId, errorMessage]
  );
}
