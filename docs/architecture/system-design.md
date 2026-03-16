# Arquitetura do sistema

## Visão geral

O Fintech Split System processa pagamentos Pix recebidos via Stark Bank e executa automaticamente o split de recebíveis: **98%** para a conta do licenciado e **2%** para a conta da holding.

```
STARK BANK
    │  POST /webhook/stark (ECDSA signed)
    ▼
┌─────────────────────┐
│   WEBHOOK SERVICE   │  Express — valida assinatura, enfileira, responde < 1s
│   porta 3000        │
└──────────┬──────────┘
           │  SendMessage (MessageDeduplicationId = eventId)
           ▼
┌─────────────────────┐
│   SQS FIFO QUEUE    │  Buffer durável — garante ordem e deduplicação
│   fintech-payments  │  Visibility timeout: 300s
└──────────┬──────────┘
           │  ReceiveMessage (long polling 20s)
           ▼
┌─────────────────────┐        ┌──────────────────┐
│   PAYMENT WORKER    │───────▶│   STARK BANK API │
│   (escalável)       │        │   (transferências)│
└──────────┬──────────┘        └──────────────────┘
           │
           ▼
┌─────────────────────┐
│    POSTGRESQL       │  ledger de transações + controle de idempotência
└─────────────────────┘
```

---

## Decisões de design

### Por que SQS FIFO entre webhook e worker?

O webhook precisa responder para a Stark Bank em menos de 3 segundos — caso contrário, ela considera o endpoint indisponível e começa a reenviar. Colocar uma fila entre os dois serviços desacopla a latência da API da Stark Bank do tempo de resposta do webhook.

O FIFO garante que, se dois eventos chegarem para o mesmo pagamento, eles sejam processados em ordem. O `MessageDeduplicationId = eventId` impede que a mesma mensagem entre na fila duas vezes dentro da janela de deduplicação de 5 minutos.

### Por que SELECT FOR UPDATE SKIP LOCKED?

Com múltiplos workers rodando em paralelo, dois deles poderiam tentar processar o mesmo pagamento ao mesmo tempo (por exemplo, após um reenvio da Stark Bank). O `SELECT FOR UPDATE` trava o registro no PostgreSQL enquanto o worker está processando. O `SKIP LOCKED` faz com que outros workers simplesmente pulem esse registro em vez de ficarem bloqueados esperando — o que seria um gargalo de performance.

### Por que as transferências da Stark Bank são sequenciais?

As transferências para o licenciado e para a holding são feitas em sequência (não em paralelo) de forma intencional. O `externalId` de cada transferência garante idempotência no lado da Stark Bank — se o worker repetir a chamada após uma falha parcial, a transferência já criada não será duplicada.

Criar as duas em paralelo com `Promise.all` introduziria um risco de race condition no tratamento de erro: se uma falha e outra sucede simultaneamente, a lógica de rollback fica mais complexa. A serialização aqui é uma troca consciente de performance por previsibilidade.

### Por que HMAC em dev e ECDSA em produção?

A Stark Bank assina os webhooks com ECDSA (ES256) usando uma chave rotacionada periodicamente. Em produção, o ideal é usar `starkbank.event.parse()` — o SDK gerencia a rotação automática das chaves públicas.

Em desenvolvimento, simular ECDSA exigiria gerar e gerenciar um par de chaves, o que complica o setup local desnecessariamente. HMAC-SHA256 com um segredo local dá as mesmas garantias de segurança para fins de teste.

---

## Máquina de estados de um pagamento

```
                    ┌─────────┐
   webhook recebido │ PENDING │
                    └────┬────┘
                         │ worker pega o lock
                    ┌────▼──────┐
                    │ PROCESSING│
                    └────┬──────┘
           ┌─────────────┴─────────────┐
      sucesso                       falha (todas as tentativas)
           │                           │
    ┌──────▼────┐               ┌──────▼────┐
    │ COMPLETED │               │  FAILED   │──► reprocessado na próxima entrega SQS
    └───────────┘               └───────────┘
```

Cada leg de transferência (LICENSED e HOLDING) tem sua própria entrada no ledger com os mesmos estados, permitindo auditoria granular.

---

## Escalabilidade

O worker é completamente stateless — todo o estado está no PostgreSQL e no SQS. Para escalar horizontalmente:

```bash
docker compose up --scale worker=10
```

O `SELECT FOR UPDATE SKIP LOCKED` garante que workers concorrentes nunca processem o mesmo pagamento, sem necessidade de coordenação externa (Redis, Zookeeper etc.).

O gargalo de escala é o PostgreSQL. Para volumes muito altos, considere:
- Read replicas para queries de ledger
- Particionamento da tabela `processed_payments` por data
- Connection pooling com PgBouncer

---

## Dead Letter Queue

Após `MAX_SQS_RECEIVE_COUNT` (padrão: 5) tentativas de entrega, o worker envia a mensagem para a DLQ (`fintech-payments-dlq.fifo`) com um motivo de falha. Isso permite:

- Inspeção manual das mensagens problemáticas
- Reprocessamento seletivo após correção de um bug
- Alertas baseados no tamanho da DLQ (recomendado: alarme no CloudWatch se > 0)
