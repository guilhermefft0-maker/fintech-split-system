import crypto from 'crypto';

jest.mock('../queue/sqs.service', () => ({
  enqueuePayment: jest.fn().mockResolvedValue('msg-id-001'),
}));

import { handleWebhook } from './webhook.service';
import { enqueuePayment } from '../queue/sqs.service';

const SECRET = 'test-secret';

function sign(body: string): string {
  return crypto.createHmac('sha256', SECRET).update(body, 'utf-8').digest('hex');
}

function makePayload(overrides: Record<string, any> = {}): string {
  return JSON.stringify({
    event: {
      id: 'evt-001',
      subscription: 'pixRequest',
      log: {
        type: 'credited',
        payment: { id: 'pay-001', amount: 10_000, status: 'paid', updated: '2026-01-01T00:00:00Z' },
        ...overrides.log,
      },
      ...overrides.event,
    },
    ...overrides.root,
  });
}

const OLD_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...OLD_ENV, SIGNATURE_MODE: 'hmac', WEBHOOK_HMAC_SECRET: SECRET };
});

afterAll(() => {
  process.env = OLD_ENV;
});

// ── Assinatura ───────────────────────────────────────────────────────────────

describe('handleWebhook — validação de assinatura', () => {
  it('rejeita quando não há assinatura', async () => {
    const result = await handleWebhook(makePayload(), undefined);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('missing_signature');
  });

  it('rejeita assinatura inválida', async () => {
    const result = await handleWebhook(makePayload(), 'assinatura-invalida');
    expect(result.accepted).toBe(false);
  });
});

// ── Parsing e validação ──────────────────────────────────────────────────────

describe('handleWebhook — validação do payload', () => {
  it('rejeita JSON inválido', async () => {
    const body = 'nao-e-json';
    const result = await handleWebhook(body, sign(body));
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid_json');
  });

  it('rejeita payload sem event.id', async () => {
    const body = JSON.stringify({ event: { log: {} } });
    const result = await handleWebhook(body, sign(body));
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('missing_event_id');
  });

  it('aceita e ignora evento que não é pagamento', async () => {
    const body = makePayload({ log: { type: 'created', payment: { status: 'created' } } });
    const result = await handleWebhook(body, sign(body));
    expect(result.accepted).toBe(true);
    expect(result.reason).toBe('not_a_payment_event');
    expect(enqueuePayment).not.toHaveBeenCalled();
  });

  it('rejeita pagamento com amount zero', async () => {
    const body = makePayload({ log: { type: 'credited', payment: { id: 'p1', amount: 0, status: 'paid' } } });
    const result = await handleWebhook(body, sign(body));
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid_amount');
  });

  it('rejeita pagamento com amount negativo', async () => {
    const body = makePayload({ log: { type: 'credited', payment: { id: 'p1', amount: -100, status: 'paid' } } });
    const result = await handleWebhook(body, sign(body));
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('invalid_amount');
  });
});

// ── Fluxo feliz ──────────────────────────────────────────────────────────────

describe('handleWebhook — fluxo de pagamento válido', () => {
  it('aceita pagamento válido e enfileira no SQS', async () => {
    const body = makePayload();
    const result = await handleWebhook(body, sign(body));

    expect(result.accepted).toBe(true);
    expect(result.messageId).toBe('msg-id-001');
    expect(enqueuePayment).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt-001', paymentId: 'pay-001', amount: 10_000 })
    );
  });

  it('aceita invoice pago (log.invoice em vez de log.payment)', async () => {
    const body = JSON.stringify({
      event: {
        id: 'evt-002',
        subscription: 'invoice',
        log: {
          type: 'paid',
          invoice: { id: 'inv-001', amount: 5_000, status: 'paid', updated: '2026-01-01T00:00:00Z' },
        },
      },
    });
    const result = await handleWebhook(body, sign(body));
    expect(result.accepted).toBe(true);
    expect(enqueuePayment).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 5_000 })
    );
  });
});
