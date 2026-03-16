import { acquireIdempotencyLock, markPaymentCompleted, markPaymentFailed } from './idempotency';
import { PoolClient } from 'pg';

function makeClient(rows: any[] = []): jest.Mocked<PoolClient> {
  return {
    query: jest.fn().mockResolvedValue({ rows }),
  } as unknown as jest.Mocked<PoolClient>;
}

const AMOUNT      = 10_000;
const EXTERNAL_ID = 'evt-001';

// ── acquireIdempotencyLock ───────────────────────────────────────────────────

describe('acquireIdempotencyLock', () => {
  it('retorna null para pagamento COMPLETED (já processado)', async () => {
    const client = makeClient([{ status: 'COMPLETED', id: '1', retry_count: 0 }]);
    const result = await acquireIdempotencyLock(client, EXTERNAL_ID, AMOUNT);
    expect(result).toBeNull();
  });

  it('retorna null para pagamento PROCESSING (outro worker)', async () => {
    const client = makeClient([{ status: 'PROCESSING', id: '1', retry_count: 0 }]);
    const result = await acquireIdempotencyLock(client, EXTERNAL_ID, AMOUNT);
    expect(result).toBeNull();
  });

  it('atualiza para PROCESSING e retorna registro quando PENDING', async () => {
    const record = { id: '1', status: 'PENDING', retry_count: 0, amount: AMOUNT };
    const client = makeClient([record]);
    (client.query as jest.Mock).mockResolvedValueOnce({ rows: [record] });
    (client.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const result = await acquireIdempotencyLock(client, EXTERNAL_ID, AMOUNT);
    expect(result).not.toBeNull();
    expect(result?.status).toBe('PROCESSING');
    expect(result?.retry_count).toBe(1);
    expect(client.query).toHaveBeenCalledTimes(2);
  });

  it('atualiza para PROCESSING e retorna registro quando FAILED', async () => {
    const record = { id: '1', status: 'FAILED', retry_count: 2, amount: AMOUNT };
    const client = makeClient([record]);
    (client.query as jest.Mock).mockResolvedValueOnce({ rows: [record] });
    (client.query as jest.Mock).mockResolvedValueOnce({ rows: [] });

    const result = await acquireIdempotencyLock(client, EXTERNAL_ID, AMOUNT);
    expect(result?.status).toBe('PROCESSING');
    expect(result?.retry_count).toBe(3);
  });

  it('insere novo registro quando pagamento é desconhecido', async () => {
    const inserted = {
      id:              'novo-uuid',
      external_id:     EXTERNAL_ID,
      status:          'PROCESSING',
      amount:          AMOUNT,
      holding_amount:  200,
      licensed_amount: 9800,
      retry_count:     0,
    };
    const client = makeClient([]);
    (client.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [inserted] });

    const result = await acquireIdempotencyLock(client, EXTERNAL_ID, AMOUNT);
    expect(result?.id).toBe('novo-uuid');
    expect(result?.holding_amount).toBe(200);
    expect(result?.licensed_amount).toBe(9800);
  });

  it('calcula split 98/2 corretamente', async () => {
    const client = makeClient([]);
    (client.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ holding_amount: 200, licensed_amount: 9800 }] });

    await acquireIdempotencyLock(client, EXTERNAL_ID, 10_000);

    const insertCall = (client.query as jest.Mock).mock.calls[1];
    const [, , holdingAmount, licensedAmount] = insertCall[1];
    expect(holdingAmount).toBe(200);
    expect(licensedAmount).toBe(9800);
  });

  it('arredonda holding para inteiro (Math.round)', async () => {
    const client = makeClient([]);
    (client.query as jest.Mock)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ holding_amount: 1, licensed_amount: 49 }] });

    await acquireIdempotencyLock(client, EXTERNAL_ID, 50);

    const insertCall = (client.query as jest.Mock).mock.calls[1];
    const holdingAmount = insertCall[1][2];
    expect(Number.isInteger(holdingAmount)).toBe(true);
  });
});

// ── markPaymentCompleted ─────────────────────────────────────────────────────

describe('markPaymentCompleted', () => {
  it('executa UPDATE com status COMPLETED', async () => {
    const client = makeClient();
    await markPaymentCompleted(client, 'uuid-123');
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('COMPLETED'),
      ['uuid-123']
    );
  });
});

// ── markPaymentFailed ────────────────────────────────────────────────────────

describe('markPaymentFailed', () => {
  it('executa UPDATE com status FAILED e mensagem de erro', async () => {
    const client = makeClient();
    await markPaymentFailed(client, 'uuid-123', 'API timeout');
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('FAILED'),
      ['uuid-123', 'API timeout']
    );
  });
});
