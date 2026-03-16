import { PoolClient } from 'pg';
import { logger } from '../utils/logger';

export type LedgerDirection = 'HOLDING' | 'LICENSED';
export type LedgerStatus    = 'PENDING' | 'SENT' | 'CONFIRMED' | 'FAILED';

export interface LedgerEntry {
  id:          string;
  payment_id:  string;
  direction:   LedgerDirection;
  amount:      number;
  transfer_id: string | null;
  status:      LedgerStatus;
  created_at:  Date;
}

// Cria uma entrada no ledger como PENDING antes de tentar a transferência.
// Precisa estar dentro de uma transação aberta.
export async function createLedgerEntry(
  client: PoolClient,
  paymentId: string,
  direction: LedgerDirection,
  amount: number
): Promise<LedgerEntry> {
  const { rows } = await client.query<LedgerEntry>(
    `INSERT INTO ledger_entries (payment_id, direction, amount, status)
     VALUES ($1, $2, $3, 'PENDING')
     RETURNING *`,
    [paymentId, direction, amount]
  );

  logger.info({ paymentId, direction, amount }, 'Entrada no ledger criada (PENDING)');
  return rows[0];
}

// Atualiza a entrada pra SENT depois que a Stark Bank confirmar a criação da transferência
export async function markLedgerSent(
  client: PoolClient,
  entryId: string,
  transferId: string
): Promise<void> {
  await client.query(
    `UPDATE ledger_entries
     SET status = 'SENT', transfer_id = $2, updated_at = NOW()
     WHERE id = $1`,
    [entryId, transferId]
  );

  logger.info({ entryId, transferId }, 'Entrada no ledger marcada como SENT');
}

// Marca a entrada como FAILED — acontece quando a transferência não foi criada
export async function markLedgerFailed(
  client: PoolClient,
  entryId: string,
  reason?: string
): Promise<void> {
  await client.query(
    `UPDATE ledger_entries
     SET status = 'FAILED', updated_at = NOW()
     WHERE id = $1`,
    [entryId]
  );

  logger.warn({ entryId, reason }, 'Entrada no ledger marcada como FAILED');
}

// Retorna todas as entradas de um pagamento — útil pra auditoria e reconciliação
export async function getLedgerByPayment(
  client: PoolClient,
  paymentId: string
): Promise<LedgerEntry[]> {
  const { rows } = await client.query<LedgerEntry>(
    `SELECT * FROM ledger_entries WHERE payment_id = $1 ORDER BY created_at ASC`,
    [paymentId]
  );
  return rows;
}
