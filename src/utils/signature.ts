import crypto from 'crypto';
import { logger } from './logger';

// A Stark Bank assina os webhooks com ECDSA (ES256).
// O header chega como "Digital-Signature".
//
// Em produção: use starkbank.event.parse({ content, signature }) — ele lida com tudo.
// Em dev/testes: usamos HMAC-SHA256 com segredo local, mais simples de simular.

export interface SignatureValidationResult {
  valid: boolean;
  reason?: string;
}

// Valida assinatura ECDSA usando a chave pública da Stark Bank (formato PEM)
export function validateECDSASignature(
  rawBody: string,
  signature: string,
  publicKeyPem: string
): SignatureValidationResult {
  try {
    const verify = crypto.createVerify('SHA256');
    verify.update(rawBody, 'utf-8');

    const isValid = verify.verify(
      { key: publicKeyPem, format: 'pem', type: 'spki' },
      signature,
      'base64'
    );

    if (!isValid) {
      logger.warn({ signature }, 'Assinatura ECDSA inválida');
      return { valid: false, reason: 'signature_mismatch' };
    }

    return { valid: true };
  } catch (err) {
    logger.error({ err }, 'Erro ao validar assinatura ECDSA');
    return { valid: false, reason: 'validation_error' };
  }
}

// Valida assinatura HMAC-SHA256 — usado em dev/testes com webhook simulado
export function validateHMACSignature(
  rawBody: string,
  receivedSignature: string,
  secret: string
): SignatureValidationResult {
  try {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody, 'utf-8')
      .digest('hex');

    const expectedBuf = Buffer.from(expected, 'hex');
    const receivedBuf = Buffer.from(receivedSignature, 'hex');

    if (expectedBuf.length !== receivedBuf.length) {
      return { valid: false, reason: 'length_mismatch' };
    }

    // timingSafeEqual evita timing attack (compara sem curto-circuito)
    const isValid = crypto.timingSafeEqual(expectedBuf, receivedBuf);

    if (!isValid) {
      logger.warn('Assinatura HMAC inválida');
      return { valid: false, reason: 'signature_mismatch' };
    }

    return { valid: true };
  } catch (err) {
    logger.error({ err }, 'Erro ao validar assinatura HMAC');
    return { valid: false, reason: 'validation_error' };
  }
}

// Ponto de entrada único — escolhe ECDSA em prod, HMAC em dev
export function validateWebhookSignature(
  rawBody: string,
  signature: string | undefined
): SignatureValidationResult {
  if (!signature) {
    logger.warn('Webhook recebido sem header Digital-Signature');
    return { valid: false, reason: 'missing_signature' };
  }

  const useHMAC = process.env.SIGNATURE_MODE === 'hmac';

  if (useHMAC) {
    const secret = process.env.WEBHOOK_HMAC_SECRET;
    if (!secret) throw new Error('WEBHOOK_HMAC_SECRET não configurado');
    return validateHMACSignature(rawBody, signature, secret);
  }

  const publicKey = process.env.STARK_PUBLIC_KEY_PEM;
  if (!publicKey) throw new Error('STARK_PUBLIC_KEY_PEM não configurado');
  return validateECDSASignature(rawBody, signature, publicKey);
}
