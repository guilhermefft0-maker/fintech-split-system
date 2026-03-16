# Payment Flow — Step by Step

## Happy Path

```
Stark Bank                Webhook Service              SQS                   Worker                  PostgreSQL            Stark API
    │                           │                       │                      │                          │                     │
    │  POST /webhook/stark       │                       │                      │                          │                     │
    │  Digital-Signature: <sig>  │                       │                      │                          │                     │
    │ ─────────────────────────► │                       │                      │                          │                     │
    │                           │ validate ECDSA sig    │                      │                          │                     │
    │                           │ parse JSON payload    │                      │                          │                     │
    │                           │ filter "paid" events  │                      │                          │                     │
    │                           │                       │                      │                          │                     │
    │                           │ SendMessage(eventId)  │                      │                          │                     │
    │                           │ ─────────────────────►│                      │                          │                     │
    │                           │   MessageId           │                      │                          │                     │
    │                           │ ◄─────────────────────│                      │                          │                     │
    │  HTTP 200                  │                       │                      │                          │                     │
    │ ◄───────────────────────── │                       │                      │                          │                     │
    │                           │                       │                      │                          │                     │
    │                           │                       │  ReceiveMessage      │                          │                     │
    │                           │                       │ ◄────────────────────│                          │                     │
    │                           │                       │  [payment message]   │                          │                     │
    │                           │                       │ ─────────────────────►                          │                     │
    │                           │                       │                      │                          │                     │
    │                           │                       │                      │  BEGIN                   │                     │
    │                           │                       │                      │ ─────────────────────────►                     │
    │                           │                       │                      │                          │                     │
    │                           │                       │                      │  SELECT FOR UPDATE        │                     │
    │                           │                       │                      │  (idempotency check)      │                     │
    │                           │                       │                      │ ─────────────────────────►                     │
    │                           │                       │                      │  → not found             │                     │
    │                           │                       │                      │  INSERT PROCESSING        │                     │
    │                           │                       │                      │ ─────────────────────────►                     │
    │                           │                       │                      │                          │                     │
    │                           │                       │                      │  INSERT ledger PENDING    │                     │
    │                           │                       │                      │  (LICENSED + HOLDING)     │                     │
    │                           │                       │                      │ ─────────────────────────►                     │
    │                           │                       │                      │                          │                     │
    │                           │                       │                      │  Transfer 98%            │                     │
    │                           │                       │                      │ ────────────────────────────────────────────── ►
    │                           │                       │                      │  transferId-licensed     │                     │
    │                           │                       │                      │ ◄──────────────────────────────────────────────
    │                           │                       │                      │                          │                     │
    │                           │                       │                      │  Transfer 2%             │                     │
    │                           │                       │                      │ ────────────────────────────────────────────── ►
    │                           │                       │                      │  transferId-holding      │                     │
    │                           │                       │                      │ ◄──────────────────────────────────────────────
    │                           │                       │                      │                          │                     │
    │                           │                       │                      │  UPDATE ledger → SENT     │                     │
    │                           │                       │                      │  UPDATE payment→COMPLETED │                     │
    │                           │                       │                      │ ─────────────────────────►                     │
    │                           │                       │                      │                          │                     │
    │                           │                       │                      │  COMMIT                  │                     │
    │                           │                       │                      │ ─────────────────────────►                     │
    │                           │                       │                      │                          │                     │
    │                           │                       │  DeleteMessage       │                          │                     │
    │                           │                       │ ◄────────────────────│                          │                     │
```

---

## Duplicate Webhook (Idempotency)

```
Stark Bank sends same event twice:

  1st delivery → Worker inserts PROCESSING, executes split → COMPLETED ✅
  2nd delivery → Worker finds COMPLETED → returns early, no transfers ✅
```

---

## Stark API Failure with Retry

```
  Attempt 1 → Stark API timeout → delay 5s
  Attempt 2 → Stark API 503     → delay 25s
  Attempt 3 → Stark API OK      → transfers created → COMPLETED ✅
```

If all attempts fail:
```
  payment.status → FAILED
  SQS message stays visible (VisibilityTimeout expires)
  Worker picks it up again (up to MAX_SQS_RECEIVE_COUNT)
  After N failures → Dead Letter Queue
```

---

## Concurrent Workers (Race Condition Prevention)

```
Worker A                       Worker B                    PostgreSQL
   │                               │                           │
   │  BEGIN                        │  BEGIN                    │
   │  SELECT FOR UPDATE SKIP LOCKED│                           │
   │ ────────────────────────────────────────────────────────► │
   │  → row acquired (PROCESSING)  │                           │
   │ ◄──────────────────────────── │                           │
   │                               │  SELECT FOR UPDATE SKIP LOCKED
   │                               │ ─────────────────────────►│
   │                               │  → row SKIPPED (locked)   │
   │                               │ ◄─────────────────────────│
   │                               │  → returns early ✅        │
   │  [executes split...]          │                           │
   │  COMMIT                       │                           │
```
