import crypto from 'crypto';

// Mock do SQS — nenhuma chamada real pra AWS durante os testes
jest.mock('../queue/sqs.service', () => ({
  enqueuePayment: jest.fn().mockResolvedValue('mock-message-id'),
}));

import { handleWebhook } from '../webhook/webhook.service';
import { enqueuePayment } from '../queue/sqs.service';

const SEGREDO = 'segredo-teste-webhook';

function assinar(body: string): string {
  return crypto.createHmac('sha256', SEGREDO).update(body, 'utf-8').digest('hex');
}

// Gera um payload de webhook válido da Stark Bank
function criarPayload(sobrescrever: Record<string, any> = {}): string {
  return JSON.stringify({
    event: {
      id:           'evt_teste_001',
      subscription: 'invoice',
      log: {
        type: 'credited',
        invoice: {
          id:      'pix_abc123',
          amount:  10_000,
          status:  'paid',
          updated: new Date().toISOString(),
        },
      },
      ...sobrescrever,
    },
  });
}

beforeEach(() => {
  process.env.SIGNATURE_MODE      = 'hmac';
  process.env.WEBHOOK_HMAC_SECRET = SEGREDO;
  jest.clearAllMocks();
});

afterEach(() => {
  delete process.env.SIGNATURE_MODE;
  delete process.env.WEBHOOK_HMAC_SECRET;
});

describe('Validação de assinatura', () => {
  test('rejeita quando o header Digital-Signature está ausente', async () => {
    const body = criarPayload();
    const result = await handleWebhook(body, undefined);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('missing_signature');
    expect(enqueuePayment).not.toHaveBeenCalled();
  });

  test('rejeita quando a assinatura não bate com o body', async () => {
    const body = criarPayload();
    const result = await handleWebhook(body, assinar(body + 'adulterado'));
    expect(result.accepted).toBe(false);
    expect(enqueuePayment).not.toHaveBeenCalled();
  });

  test('aceita quando a assinatura é válida', async () => {
    const body = criarPayload();
    const result = await handleWebhook(body, assinar(body));
    expect(result.accepted).toBe(true);
    expect(result.messageId).toBe('mock-message-id');
  });
});

describe('Filtro de eventos', () => {
  test('ignora eventos que não são pagamento confirmado (ex: criado)', async () => {
    const body = JSON.stringify({
      event: {
        id:           'evt_002',
        subscription: 'invoice',
        log: {
          type:    'created',
          invoice: { id: 'pix_xyz', amount: 5_000, status: 'created', updated: '' },
        },
      },
    });
    const result = await handleWebhook(body, assinar(body));
    expect(result.accepted).toBe(true);
    expect(result.reason).toBe('not_a_payment_event');
    expect(enqueuePayment).not.toHaveBeenCalled();
  });

  test('rejeita eventos com valor zero', async () => {
    const body = JSON.stringify({
      event: {
        id:           'evt_003',
        subscription: 'invoice',
        log: {
          type:    'credited',
          invoice: { id: 'pix_zero', amount: 0, status: 'paid', updated: '' },
        },
      },
    });
    const result = await handleWebhook(body, assinar(body));
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid_amount');
    expect(enqueuePayment).not.toHaveBeenCalled();
  });

  test('rejeita body que não é JSON válido', async () => {
    const body = 'isso-nao-e-json{{{';
    const result = await handleWebhook(body, assinar(body));
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid_json');
  });
});

describe('Caminho feliz', () => {
  test('enfileira o pagamento com os campos corretos', async () => {
    const body = criarPayload();
    await handleWebhook(body, assinar(body));

    expect(enqueuePayment).toHaveBeenCalledTimes(1);
    expect(enqueuePayment).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId:   'evt_teste_001',
        paymentId: 'pix_abc123',
        amount:    10_000,
      })
    );
  });

  test('retorna o messageId do SQS no sucesso', async () => {
    const body = criarPayload();
    const result = await handleWebhook(body, assinar(body));
    expect(result.messageId).toBe('mock-message-id');
  });
});
