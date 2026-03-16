import { validateWebhookSignature } from '../utils/signature';
import { enqueuePayment, PaymentMessage } from '../queue/sqs.service';
import { logger } from '../utils/logger';

// Formato do payload que a Stark Bank envia (invoice ou pixRequest pago)
export interface StarkBankWebhookPayload {
  event: {
    id:           string;
    subscription: string;
    log: {
      type:      string;
      payment?: { id: string; amount: number; status: string; updated: string };
      invoice?: { id: string; amount: number; status: string; updated: string };
    };
  };
}

export interface WebhookResult {
  accepted:   boolean;
  reason?:    string;
  messageId?: string;
}

// Valida o webhook da Stark Bank e enfileira o pagamento para processamento assíncrono.
//
// Responde rápido (< 3s) para a Stark Bank não considerar o endpoint como falho.
// Todo o trabalho pesado (split, transferências, banco) acontece no worker.
export async function handleWebhook(
  rawBody: string,
  signature: string | undefined
): Promise<WebhookResult> {
  // 1. Valida a assinatura — rejeita qualquer coisa que não venha da Stark Bank
  const validation = validateWebhookSignature(rawBody, signature);

  if (!validation.valid) {
    logger.warn({ reason: validation.reason }, 'Webhook rejeitado: assinatura inválida');
    return { accepted: false, reason: validation.reason };
  }

  // 2. Parse do body
  let payload: StarkBankWebhookPayload;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    logger.warn('Webhook rejeitado: JSON inválido');
    return { accepted: false, reason: 'invalid_json' };
  }

  const { event } = payload;

  if (!event?.id) {
    logger.warn('Webhook rejeitado: sem event.id');
    return { accepted: false, reason: 'missing_event_id' };
  }

  const log = logger.child({ eventId: event.id, subscription: event.subscription });

  // 3. Filtra — só processa eventos de pagamento confirmado
  const logType = event.log?.type;
  const payment = event.log?.payment ?? event.log?.invoice;

  const isPago =
    (logType === 'credited' || logType === 'paid') &&
    payment?.status === 'paid';

  if (!isPago) {
    log.info({ logType, status: payment?.status }, 'Evento ignorado: não é pagamento confirmado');
    return { accepted: true, reason: 'not_a_payment_event' };
  }

  if (!payment?.amount || payment.amount <= 0) {
    log.warn({ amount: payment?.amount }, 'Webhook rejeitado: valor inválido');
    return { accepted: false, reason: 'invalid_amount' };
  }

  // 4. Tudo certo — enfileira no SQS e retorna 200 imediatamente
  const message: PaymentMessage = {
    eventId:    event.id,
    paymentId:  payment.id,
    amount:     payment.amount,
    receivedAt: new Date().toISOString(),
  };

  const messageId = await enqueuePayment(message);

  log.info({ messageId, amount: payment.amount }, 'Webhook aceito e enfileirado');

  return { accepted: true, messageId };
}
