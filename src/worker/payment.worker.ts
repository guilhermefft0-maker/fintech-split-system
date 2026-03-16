import 'dotenv/config';
import { pool, withTransaction }                                          from '../database/db';
import { receivePayments, deleteMessage, sendToDLQ, PaymentMessage }     from '../queue/sqs.service';
import { acquireIdempotencyLock, markPaymentCompleted, markPaymentFailed } from '../utils/idempotency';
import { createLedgerEntry, markLedgerSent, markLedgerFailed }           from '../ledger/ledger.service';
import { executeSplit, initStarkBank }                                    from '../transfers/stark.service';
import { withRetry }                                                      from './retry.strategy';
import { logger }                                                         from '../utils/logger';

const MAX_SQS_RECEIVE_COUNT = Number(process.env.MAX_SQS_RECEIVE_COUNT) || 5;

// Processa um único pagamento da fila.
//
// Fluxo dentro de uma transação:
//   1. Lock de idempotência (SELECT FOR UPDATE)
//   2. Cria entradas PENDING no ledger para as duas transferências
//   3. Executa o split via Stark Bank (com retry)
//   4. Atualiza ledger para SENT
//   5. Marca o pagamento como COMPLETED
//   6. COMMIT
//
// Se a Stark Bank falhar em todas as tentativas → ROLLBACK + status FAILED
async function processPayment(msg: PaymentMessage): Promise<void> {
  const log = logger.child({ eventId: msg.eventId, paymentId: msg.paymentId });

  log.info({ amount: msg.amount }, 'Processando pagamento');

  await withTransaction(async (client) => {
    // 1. Verifica idempotência — garante que não processamos o mesmo pagamento duas vezes
    const payment = await acquireIdempotencyLock(client, msg.eventId, msg.amount);

    if (!payment) {
      log.info('Pagamento duplicado ou já em processamento, pulando');
      return;
    }

    // 2. Registra as duas pernas da transferência como PENDING no ledger
    const licensedEntry = await createLedgerEntry(
      client, payment.id, 'LICENSED', payment.licensed_amount
    );
    const holdingEntry = await createLedgerEntry(
      client, payment.id, 'HOLDING', payment.holding_amount
    );

    log.info(
      { licenciado: payment.licensed_amount, holding: payment.holding_amount },
      'Entradas no ledger criadas'
    );

    // 3. Executa o split com retry exponencial — se a Stark Bank cair, tentamos de novo
    let licensedTransferId: string;
    let holdingTransferId: string;

    try {
      const result = await withRetry(
        () => executeSplit({
          paymentDbId:    payment.id,
          licensedAmount: payment.licensed_amount,
          holdingAmount:  payment.holding_amount,
        }),
        { maxAttempts: 4, baseDelayMs: 5_000, maxDelayMs: 600_000, jitter: true },
        { paymentId: payment.id }
      );

      licensedTransferId = result.licensedTransferId;
      holdingTransferId  = result.holdingTransferId;
    } catch (err) {
      // Todas as tentativas falharam — registra a falha e deixa o ROLLBACK acontecer
      await markLedgerFailed(client, licensedEntry.id, String(err));
      await markLedgerFailed(client, holdingEntry.id,  String(err));
      await markPaymentFailed(client, payment.id,      String(err));

      log.error({ err }, 'Split falhou após todas as tentativas');
      throw err; // dispara o ROLLBACK no withTransaction
    }

    // 4. Transferências criadas — atualiza o ledger com os IDs da Stark Bank
    await markLedgerSent(client, licensedEntry.id, licensedTransferId);
    await markLedgerSent(client, holdingEntry.id,  holdingTransferId);

    // 5. Tudo certo — fecha o pagamento como COMPLETED
    await markPaymentCompleted(client, payment.id);

    log.info(
      { licensedTransferId, holdingTransferId },
      'Split concluído com sucesso'
    );
  });
}

// Loop principal do worker — fica em poll contínuo no SQS
async function startWorker(): Promise<void> {
  // Inicializa o SDK da Stark Bank — em dev com credenciais dummy, só avisa e continua
  try {
    initStarkBank();
  } catch (err) {
    if (process.env.NODE_ENV === 'production') {
      logger.error({ err }, 'Falha ao inicializar SDK da Stark Bank — abortando');
      process.exit(1);
    }
    logger.warn({ err }, 'SDK da Stark Bank não inicializado (modo dev — transferências vão falhar)');
  }

  logger.info('Worker iniciado, aguardando mensagens no SQS...');

  while (true) {
    try {
      const messages = await receivePayments(MAX_SQS_RECEIVE_COUNT);

      if (messages.length === 0) {
        logger.debug('Nenhuma mensagem, continuando o poll');
        continue;
      }

      logger.info({ total: messages.length }, 'Mensagens recebidas do SQS');

      // Processa todas as mensagens da rodada em paralelo
      await Promise.allSettled(
        messages.map(async (sqsMessage) => {
          if (!sqsMessage.Body || !sqsMessage.ReceiptHandle) return;

          let payload: PaymentMessage;

          try {
            payload = JSON.parse(sqsMessage.Body) as PaymentMessage;
          } catch {
            logger.error({ body: sqsMessage.Body }, 'Corpo da mensagem SQS inválido');
            return;
          }

          // versão do SDK
          const receiveCount = Number(
          sqsMessage.Attributes?.ApproximateReceiveCount ?? '1'
          );
          
          

          // Muitas tentativas — manda pra DLQ pra inspeção manual
          if (receiveCount > MAX_SQS_RECEIVE_COUNT) {
            logger.warn(
              { eventId: payload.eventId, receiveCount },
              'Excedeu o limite de tentativas, enviando pra DLQ'
            );
            await sendToDLQ(payload, `Limite de ${receiveCount} tentativas excedido`);
            await deleteMessage(sqsMessage.ReceiptHandle);
            return;
          }

          try {
            await processPayment(payload);
            await deleteMessage(sqsMessage.ReceiptHandle); // só remove se processou com sucesso
          } catch (err) {
            // Não remove — o SQS vai recolocar na fila quando o visibility timeout expirar
            logger.error(
              { err, eventId: payload.eventId },
              'Falha no processamento, mensagem será reentregue pelo SQS'
            );
          }
        })
      );
    } catch (err) {
      logger.error({ err }, 'Erro fatal no loop do worker, aguardando 10s antes de continuar');
      await new Promise(r => setTimeout(r, 10_000));
    }
  }
}

// Graceful shutdown — espera o pool do banco fechar antes de matar o processo
process.on('SIGTERM', async () => {
  logger.info('SIGTERM recebido, encerrando worker...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT recebido, encerrando worker...');
  await pool.end();
  process.exit(0);
});

startWorker().catch((err) => {
  logger.error({ err }, 'Worker encerrado com erro fatal');
  process.exit(1);
});
