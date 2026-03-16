import crypto from 'crypto';
import {
  validateHMACSignature,
  validateECDSASignature,
  validateWebhookSignature,
} from './signature';

const SECRET = 'test-secret-key';
const BODY   = '{"event":{"id":"evt-001"}}';

function makeHMAC(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf-8').digest('hex');
}

describe('validateHMACSignature', () => {
  it('aceita assinatura valida', () => {
    const sig = makeHMAC(BODY, SECRET);
    expect(validateHMACSignature(BODY, sig, SECRET)).toEqual({ valid: true });
  });

  it('rejeita secret errado', () => {
    const sig = makeHMAC(BODY, 'wrong-secret');
    const result = validateHMACSignature(BODY, sig, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('rejeita body diferente', () => {
    const sig = makeHMAC('outro body', SECRET);
    const result = validateHMACSignature(BODY, sig, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('rejeita quando tamanhos diferem', () => {
    const result = validateHMACSignature(BODY, 'abc', SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('length_mismatch');
  });

  it('rejeita hex invalido', () => {
    const result = validateHMACSignature(BODY, 'zz'.repeat(32), SECRET);
    expect(result.valid).toBe(false);
    expect(['length_mismatch', 'validation_error', 'signature_mismatch']).toContain(result.reason);
  });
});

describe('validateECDSASignature', () => {
  const keys = crypto.generateKeyPairSync('ec' as any, {
    namedCurve:        'prime256v1',
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }) as any;

  function sign(body: string): string {
    const s = crypto.createSign('SHA256');
    s.update(body, 'utf-8');
    return s.sign(keys.privateKey, 'base64');
  }

  it('aceita assinatura ECDSA valida', () => {
    const sig = sign(BODY);
    expect(validateECDSASignature(BODY, sig, keys.publicKey)).toEqual({ valid: true });
  });

  it('rejeita body adulterado', () => {
    const sig = sign(BODY);
    const result = validateECDSASignature('{"event":{"id":"evt-FAKE"}}', sig, keys.publicKey);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('rejeita chave publica errada', () => {
    const other = crypto.generateKeyPairSync('ec' as any, {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    }) as any;
    const sig = sign(BODY);
    const result = validateECDSASignature(BODY, sig, other.publicKey);
    expect(result.valid).toBe(false);
  });

  it('rejeita assinatura malformada', () => {
    const result = validateECDSASignature(BODY, 'nao-e-base64!!', keys.publicKey);
    expect(result.valid).toBe(false);
    expect(['validation_error', 'signature_mismatch']).toContain(result.reason);
  });
});

describe('validateWebhookSignature', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV, SIGNATURE_MODE: 'hmac', WEBHOOK_HMAC_SECRET: SECRET };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('rejeita quando nao ha header', () => {
    const result = validateWebhookSignature(BODY, undefined);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('missing_signature');
  });

  it('usa HMAC quando SIGNATURE_MODE=hmac', () => {
    const sig = makeHMAC(BODY, SECRET);
    expect(validateWebhookSignature(BODY, sig)).toEqual({ valid: true });
  });

  it('lanca erro se WEBHOOK_HMAC_SECRET nao configurado', () => {
    delete process.env.WEBHOOK_HMAC_SECRET;
    const sig = makeHMAC(BODY, SECRET);
    expect(() => validateWebhookSignature(BODY, sig)).toThrow('WEBHOOK_HMAC_SECRET');
  });

  it('lanca erro se STARK_PUBLIC_KEY_PEM nao configurado no modo ecdsa', () => {
    process.env.SIGNATURE_MODE = 'ecdsa';
    delete process.env.STARK_PUBLIC_KEY_PEM;
    expect(() => validateWebhookSignature(BODY, 'qualquer')).toThrow('STARK_PUBLIC_KEY_PEM');
  });
});