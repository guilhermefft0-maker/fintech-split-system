import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  Message,
} from '@aws-sdk/client-sqs';
import { logger } from '../utils/logger';

// Em dev aponta pro LocalStack, em prod vai direto pra AWS
const sqs = new SQSClient({
  region: process.env.AWS_REGION || 'us-east-1',
  ...(process.env.SQS_ENDPOINT ? { endpoint: process.env.SQS_ENDPOINT } : {}),
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID     || 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
  },
});

const QUEUE_URL     = process.env.SQS_QUEUE_URL     || '';
const DLQ_QUEUE_URL = process.env.SQS_DLQ_QUEUE_URL || '';

export interface PaymentMessage {
  eventId:    string; // ID do evento da Stark Bank
  paymentId:  string; // ID do pagamento Pix
  amount:     number; // valor em centavos
  receivedAt: string; // quando chegou no webhook
}

// Enfileira um pagamento no SQS para processamento assíncrono.
// O MessageDeduplicationId evita que a fila aceite duplicatas do mesmo evento.
export async function enqueuePayment(payload: PaymentMessage): Promise<string> {
  const cmd = new SendMessageCommand({
    QueueUrl:               QUEUE_URL,
    MessageBody:            JSON.stringify(payload),
    MessageGroupId:         payload.eventId, // agrupa mensagens do mesmo evento (FIFO)
    MessageDeduplicationId: payload.eventId, // SQS descarta se já recebeu esse ID
  });

  const result = await sqs.send(cmd);
  logger.info({ messageId: result.MessageId, eventId: payload.eventId }, 'Pagamento enfileirado no SQS');

  return result.MessageId!;
}

// Busca mensagens pendentes no SQS com long polling (20s).
// Long polling reduz custo e evita que o worker fique girando em vazio.
export async function receivePayments(maxMessages = 5): Promise<Message[]> {
  const cmd = new ReceiveMessageCommand({
    QueueUrl:            QUEUE_URL,
    MaxNumberOfMessages: maxMessages,
    WaitTimeSeconds:     20,  // aguarda até 20s por mensagens antes de retornar vazio
    VisibilityTimeout:   60,  // worker tem 60s pra processar antes da msg voltar pra fila
    // ✅ Correto para AWS SDK v3 recente
    MessageSystemAttributeNames: ["ApproximateReceiveCount"],
  });

  const result = await sqs.send(cmd);
  return result.Messages ?? [];
}

// Remove a mensagem da fila após processamento bem-sucedido
export async function deleteMessage(receiptHandle: string): Promise<void> {
  const cmd = new DeleteMessageCommand({
    QueueUrl:      QUEUE_URL,
    ReceiptHandle: receiptHandle,
  });

  await sqs.send(cmd);
  logger.debug('Mensagem SQS removida da fila');
}

// Manda a mensagem pra DLQ quando esgotamos as tentativas.
// Lá ela fica guardada pra inspeção manual e possível replay.
export async function sendToDLQ(payload: PaymentMessage, reason: string): Promise<void> {
  if (!DLQ_QUEUE_URL) {
    logger.warn({ eventId: payload.eventId }, 'DLQ não configurada — mensagem será perdida');
    return;
  }

  const cmd = new SendMessageCommand({
    QueueUrl:    DLQ_QUEUE_URL,
    MessageBody: JSON.stringify({
      ...payload,
      dlqReason: reason,
      dlqAt:     new Date().toISOString(),
    }),
  });

  await sqs.send(cmd);
  logger.warn({ eventId: payload.eventId, reason }, 'Mensagem enviada para a DLQ');
}

export { Message };
