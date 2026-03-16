import { validateHMACSignature, validateWebhookSignature } from '../utils/signature';
import crypto from 'crypto';

const SEGREDO = 'segredo-de-teste-fintech';

// Gera a assinatura HMAC correta para um body
function assinar(body: string, segredo = SEGREDO): string {
  return crypto.createHmac('sha256', segredo).update(body, 'utf-8').digest('hex');
}

describe('validateHMACSignature', () => {
  const body = JSON.stringify({ event: { id: 'evt_123', subscription: 'invoice' } });

  test('aceita assinatura HMAC válida', () => {
    const sig = assinar(body);
    expect(validateHMACSignature(body, sig, SEGREDO).valid).toBe(true);
  });

  test('rejeita body adulterado', () => {
    const sig = assinar(body);
    const adulterado = body.replace('evt_123', 'evt_FALSO');
    const result = validateHMACSignature(adulterado, sig, SEGREDO);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  test('rejeita assinatura gerada com segredo errado', () => {
    const sig = assinar(body, 'segredo-errado');
    expect(validateHMACSignature(body, sig, SEGREDO).valid).toBe(false);
  });

  test('rejeita assinatura com tamanho diferente', () => {
    const result = validateHMACSignature(body, 'curto', SEGREDO);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('length_mismatch');
  });

  test('rejeita assinatura vazia', () => {
    expect(validateHMACSignature(body, '', SEGREDO).valid).toBe(false);
  });
});

describe('validateWebhookSignature em modo HMAC', () => {
  const body = JSON.stringify({ event: { id: 'evt_abc' } });

  beforeEach(() => {
    process.env.SIGNATURE_MODE      = 'hmac';
    process.env.WEBHOOK_HMAC_SECRET = SEGREDO;
  });

  afterEach(() => {
    delete process.env.SIGNATURE_MODE;
    delete process.env.WEBHOOK_HMAC_SECRET;
  });

  test('retorna inválido quando o header está ausente', () => {
    const result = validateWebhookSignature(body, undefined);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_signature');
  });

  test('aceita assinatura válida', () => {
    const sig = assinar(body);
    expect(validateWebhookSignature(body, sig).valid).toBe(true);
  });

  test('rejeita assinatura forjada', () => {
    const sig = assinar(body, 'intruso');
    expect(validateWebhookSignature(body, sig).valid).toBe(false);
  });
});
