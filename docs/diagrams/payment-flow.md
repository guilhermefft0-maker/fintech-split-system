# Fluxo de Pagamento — Passo a Passo

## Fluxo feliz (caminho normal)

```
Stark Bank              Webhook Service              SQS                   Worker                  PostgreSQL            Stark API
    │                           │                       │                      │                          │                     │
    │  POST /webhook/stark       │                       │                      │                          │                     │
    │  Digital-Signature: <sig>  │                       │                      │                          │                     │
    │ ─────────────────────────► │                       │                      │                          │                     │
    │                           │ valida assinatura ECDSA│                      │                          │                     │
    │                           │ faz parse do payload  │                      │                          │                     │
    │                           │ filtra eventos "paid" │                      │                          │                     │
    │                           │                       │                      │                          │                     │
    │                           │ enfileira (eventId)   │                      │                          │                     │
    │                           │ ─────────────────────►│                      │                          │                     │
    │                           │   MessageId           │                      │                          │                     │
    │                           │ ◄─────────────────────│                      │                          │                     │
    │  HTTP 200                  │                       │                      │                          │                     │
    │ ◄───────────────────────── │                       │                      │                          │                     │
    │                           │                       │                      │                          │                     │
    │                           │                       │  recebe mensagem     │                          │                     │
    │                           │                       │ ◄────────────────────│                          │                     │
    │                           │                       │  [dados do pagamento]│                          │                     │
    │                           │                       │ ─────────────────────►                          │                     │
    │                           │                       │                      │                          │                     │
    │                           │                       │                      │  INÍCIO DA TRANSAÇÃO     │                     │
    │                           │                       │                      │ ─────────────────────────►                     │
    │                           │                       │                      │                          │                     │
    │                           │                       │                      │  SELECT FOR UPDATE        │                     │
    │                           │                       │                      │  (verificação de          │                     │
    │                           │                       │                      │   idempotência)           │                     │
    │                           │                       │                      │ ─────────────────────────►                     │
    │                           │                       │                      │  → não encontrado        │                     │
    │                           │                       │                      │  INSERT PROCESSING        │                     │
    │                           │                       │                      │ ─────────────────────────►                     │
    │                           │                       │                      │                          │                     │
    │                           │                       │                      │  INSERT ledger PENDING    │                     │
    │                           │                       │                      │  (LICENCIADO + HOLDING)   │                     │
    │                           │                       │                      │ ─────────────────────────►                     │
    │                           │                       │                      │                          │                     │
    │                           │                       │                      │  Transferência 98%       │                     │
    │                           │                       │                      │ ──────────────────────────────────────────────►│
    │                           │                       │                      │  transferId-licenciado   │                     │
    │                           │                       │                      │ ◄──────────────────────────────────────────────│
    │                           │                       │                      │                          │                     │
    │                           │                       │                      │  Transferência 2%        │                     │
    │                           │                       │                      │ ──────────────────────────────────────────────►│
    │                           │                       │                      │  transferId-holding      │                     │
    │                           │                       │                      │ ◄──────────────────────────────────────────────│
    │                           │                       │                      │                          │                     │
    │                           │                       │                      │  UPDATE ledger → SENT     │                     │
    │                           │                       │                      │  UPDATE pagamento→COMPLETED│                   │
    │                           │                       │                      │ ─────────────────────────►                     │
    │                           │                       │                      │                          │                     │
    │                           │                       │                      │  COMMIT                  │                     │
    │                           │                       │                      │ ─────────────────────────►                     │
    │                           │                       │                      │                          │                     │
    │                           │                       │  remove mensagem     │                          │                     │
    │                           │                       │ ◄────────────────────│                          │                     │
```

---

## Webhook duplicado (Idempotência)

```
Stark Bank envia o mesmo evento duas vezes:

  1ª entrega → Worker insere PROCESSING, executa split → COMPLETED ✅
  2ª entrega → Worker encontra COMPLETED → retorna sem fazer nada ✅
```

---

## Falha na API da Stark Bank com Retry

```
  Tentativa 1 → timeout na Stark API → aguarda 5s
  Tentativa 2 → Stark API 503        → aguarda 25s
  Tentativa 3 → Stark API OK         → transferências criadas → COMPLETED ✅
```

Se todas as tentativas falharem:
```
  pagamento.status → FAILED
  mensagem permanece visível no SQS (VisibilityTimeout expira)
  Worker reprocessa (até MAX_SQS_RECEIVE_COUNT tentativas)
  Após N falhas → Dead Letter Queue (fila de mensagens mortas)
```

---

## Workers concorrentes (prevenção de condição de corrida)

```
Worker A                       Worker B                    PostgreSQL
   │                               │                           │
   │  INÍCIO DA TRANSAÇÃO          │  INÍCIO DA TRANSAÇÃO      │
   │  SELECT FOR UPDATE SKIP LOCKED│                           │
   │ ────────────────────────────────────────────────────────► │
   │  → registro adquirido (PROCESSING)                        │
   │ ◄──────────────────────────── │                           │
   │                               │  SELECT FOR UPDATE SKIP LOCKED
   │                               │ ─────────────────────────►│
   │                               │  → registro IGNORADO (bloqueado)
   │                               │ ◄─────────────────────────│
   │                               │  → retorna sem processar ✅│
   │  [executa o split...]         │                           │
   │  COMMIT                       │                           │
```
