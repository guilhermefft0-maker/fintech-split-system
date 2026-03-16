import {
  acquireIdempotencyLock,
  markPaymentCompleted,
  markPaymentFailed,
  ProcessedPayment,
} from '../utils/idempotency';

// Mock mínimo de um PoolClient do pg — só intercepta as queries pra a gente inspecionar
function criarClienteMock(respostas: Record<string, any> = {}) {
  const chamadas: { sql: string; params: any[] }[] = [];

  const client = {
    _chamadas: chamadas,
    query: jest.fn(async (sql: string, params?: any[]) => {
      chamadas.push({ sql: sql.trim(), params: params || [] });

      // Retorna a resposta configurada quando a SQL bater com a chave
      for (const [chave, resposta] of Object.entries(respostas)) {
        if (sql.includes(chave)) return resposta;
      }
      return { rows: [], rowCount: 0 };
    }),
  };

  return client as any;
}

const PAGAMENTO_BASE: ProcessedPayment = {
  id:              'uuid-001',
  external_id:     'evt_pix_abc123',
  status:          'PENDING',
  amount:          10_000,
  holding_amount:  200,
  licensed_amount: 9_800,
  retry_count:     0,
  created_at:      new Date(),
};

describe('acquireIdempotencyLock', () => {
  test('insere como PROCESSING quando é a primeira vez que vemos o pagamento', async () => {
    const client = criarClienteMock({
      'SELECT *':                     { rows: [] }, // nunca visto antes
      'INSERT INTO processed_payments': {
        rows: [{ ...PAGAMENTO_BASE, status: 'PROCESSING' }],
      },
    });

    const result = await acquireIdempotencyLock(client, 'evt_novo', 10_000);

    expect(result).not.toBeNull();
    expect(result?.status).toBe('PROCESSING');
    expect(result?.holding_amount).toBe(200);   // 2%
    expect(result?.licensed_amount).toBe(9_800); // 98%

    const insert = client._chamadas.find((c: any) =>
      c.sql.includes('INSERT INTO processed_payments')
    );
    expect(insert).toBeDefined();
  });

  test('retorna null quando pagamento já está COMPLETED — não processa de novo', async () => {
    const client = criarClienteMock({
      'SELECT *': { rows: [{ ...PAGAMENTO_BASE, status: 'COMPLETED' }] },
    });

    const result = await acquireIdempotencyLock(client, PAGAMENTO_BASE.external_id, 10_000);

    expect(result).toBeNull();

    // Garante que não tentou inserir nem atualizar
    const insert = client._chamadas.some((c: any) =>
      c.sql.includes('INSERT INTO processed_payments')
    );
    expect(insert).toBe(false);
  });

  test('retorna null quando outro worker já está com PROCESSING — evita duplicata', async () => {
    const client = criarClienteMock({
      'SELECT *': { rows: [{ ...PAGAMENTO_BASE, status: 'PROCESSING' }] },
    });

    const result = await acquireIdempotencyLock(client, PAGAMENTO_BASE.external_id, 10_000);
    expect(result).toBeNull();
  });

  test('permite reprocessar quando status é FAILED', async () => {
    const client = criarClienteMock({
      'SELECT *':                    { rows: [{ ...PAGAMENTO_BASE, status: 'FAILED', retry_count: 1 }] },
      'UPDATE processed_payments':   { rows: [], rowCount: 1 },
    });

    const result = await acquireIdempotencyLock(client, PAGAMENTO_BASE.external_id, 10_000);
    expect(result).not.toBeNull();

    const update = client._chamadas.some((c: any) =>
      c.sql.includes('UPDATE processed_payments') && c.sql.includes('PROCESSING')
    );
    expect(update).toBe(true);
  });

  test('calcula o split correto ao inserir o pagamento', async () => {
    const client = criarClienteMock({
      'SELECT *': { rows: [] },
      'INSERT INTO processed_payments': {
        rows: [{
          ...PAGAMENTO_BASE,
          amount:          50_000,
          holding_amount:  1_000,
          licensed_amount: 49_000,
          status:          'PROCESSING',
        }],
      },
    });

    await acquireIdempotencyLock(client, 'evt_50k', 50_000);

    const insert = client._chamadas.find((c: any) =>
      c.sql.includes('INSERT INTO processed_payments')
    );
    expect(insert?.params[1]).toBe(50_000); // amount
    expect(insert?.params[2]).toBe(1_000);  // holding 2%
    expect(insert?.params[3]).toBe(49_000); // licensed 98%
  });
});

describe('markPaymentCompleted', () => {
  test('faz UPDATE com status COMPLETED', async () => {
    const client = criarClienteMock();
    await markPaymentCompleted(client, 'uuid-001');

    const update = client._chamadas.find((c: any) =>
      c.sql.includes('UPDATE processed_payments') && c.sql.includes('COMPLETED')
    );
    expect(update).toBeDefined();
    expect(update?.params[0]).toBe('uuid-001');
  });
});

describe('markPaymentFailed', () => {
  test('faz UPDATE com status FAILED e salva a mensagem de erro', async () => {
    const client = criarClienteMock();
    await markPaymentFailed(client, 'uuid-001', 'Timeout na Stark Bank');

    const update = client._chamadas.find((c: any) =>
      c.sql.includes('UPDATE processed_payments') && c.sql.includes('FAILED')
    );
    expect(update).toBeDefined();
    expect(update?.params[0]).toBe('uuid-001');
    expect(update?.params[1]).toBe('Timeout na Stark Bank');
  });
});
