# Fintech Split System

Sistema de processamento de pagamentos Pix via Stark Bank com split automático de recebíveis.

> **98%** → conta do licenciado · **2%** → conta da holding

---

## Arquitetura

```
STARK BANK
    │  webhook (ECDSA signed)
    ▼
WEBHOOK SERVICE  ──────────►  SQS FIFO QUEUE
(valida + enfileira)          (buffer durável)
                                    │
                                    ▼
                             PAYMENT WORKER(S)
                          (idempotente + retry)
                            │              │
                            ▼              ▼
                       POSTGRESQL     STARK API
                        (ledger)    (transferências)
```

Para detalhes completos: [`docs/architecture/system-design.md`](docs/architecture/system-design.md)

---

## Stack

| Camada | Tecnologia |
|---|---|
| Runtime | Node.js 20 + TypeScript |
| HTTP | Express |
| Fila | AWS SQS FIFO (LocalStack em dev) |
| Banco | PostgreSQL 16 |
| Pagamentos | Stark Bank SDK |
| Logs | Pino (JSON estruturado) |
| Containers | Docker + Docker Compose |

---

## Pré-requisitos

- Docker e Docker Compose
- Node.js 20+ (para desenvolvimento local)
- AWS CLI (opcional, para inspecionar SQS via `make sqs-stats`)

---

## Início rápido

```bash
# 1. Clone e configure variáveis de ambiente
cp .env .env.local
# edite .env.local com suas credenciais Stark Bank

# 2. Suba todo o stack
make up

# 3. Verifique os logs
make logs

# 4. Envie um webhook de teste
make simulate-webhook
```

---

## Comandos disponíveis

```bash
make help            # lista todos os comandos

# Stack
make up              # sobe todos os serviços
make down            # derruba os containers
make build           # reconstrói as imagens
make logs            # tail de todos os logs
make logs-webhook    # logs do webhook service
make logs-worker     # logs do worker
make scale-workers N=3  # escala workers horizontalmente

# Banco de dados
make migrate         # roda as migrations
make psql            # abre shell psql

# SQS
make sqs-stats       # mensagens na fila principal
make sqs-dlq-stats   # mensagens na DLQ
make sqs-purge       # limpa a fila (cuidado!)

# Dev local
make dev-webhook     # webhook com hot-reload
make dev-worker      # worker com hot-reload
make simulate-webhook  # envia webhook mock

# Código
make lint            # ESLint
make clean           # remove node_modules e dist
```

---

## Estrutura do projeto

```
fintech-split-system/
├── src/
│   ├── webhook/
│   │   ├── server.ts              # Express app entry point
│   │   ├── webhook.controller.ts  # handlers HTTP
│   │   ├── webhook.routes.ts      # rotas
│   │   └── webhook.service.ts     # valida + enfileira
│   ├── worker/
│   │   ├── payment.worker.ts      # loop SQS + processamento
│   │   └── retry.strategy.ts      # backoff exponencial
│   ├── queue/
│   │   └── sqs.service.ts         # producer / consumer SQS
│   ├── ledger/
│   │   └── ledger.service.ts      # entradas financeiras
│   ├── transfers/
│   │   └── stark.service.ts       # chamadas Stark Bank
│   ├── database/
│   │   ├── db.ts                  # pool pg + withTransaction
│   │   └── migrate.ts             # runner de migrations
│   └── utils/
│       ├── idempotency.ts         # SELECT FOR UPDATE lock
│       ├── signature.ts           # validação ECDSA / HMAC
│       └── logger.ts              # pino logger
├── database/
│   └── migrations/
│       └── 001_initial.sql        # schema completo
├── services/
│   ├── webhook/Dockerfile
│   └── worker/Dockerfile
├── scripts/
│   ├── localstack-init.sh         # cria filas SQS automaticamente
│   └── simulate-webhook.sh        # envia webhook de teste
├── docs/
│   ├── architecture/system-design.md
│   └── diagrams/payment-flow.md
├── docker-compose.yml
├── Makefile
├── package.json
├── tsconfig.json
└── .env
```

---

## Garantias do sistema

### Idempotência
Stark Bank pode reenviar o mesmo webhook várias vezes. O sistema protege em duas camadas:

1. **SQS FIFO** — `MessageDeduplicationId = eventId` impede duplicatas na fila
2. **PostgreSQL** — `SELECT FOR UPDATE SKIP LOCKED` garante que apenas um worker processa cada pagamento, mesmo com múltiplos workers concorrentes

### Consistência financeira
Cada pagamento segue a máquina de estados:

```
PENDING → PROCESSING → COMPLETED
                    ↘ FAILED → PROCESSING (retry)
```

Cada leg de transferência (LICENSED e HOLDING) tem sua própria entrada no ledger, permitindo auditoria completa e detecção de falhas parciais.

### Retry e resiliência
Se a API da Stark Bank estiver indisponível:

| Tentativa | Delay |
|---|---|
| 1 | ~5s |
| 2 | ~25s |
| 3 | ~2 min |
| 4 | ~10 min |

Após 5 falhas de entrega: mensagem vai para a **Dead Letter Queue** para inspeção manual.

### Segurança
- Assinaturas ECDSA (produção) ou HMAC-SHA256 (dev/sandbox) validadas a cada request
- Comparação em tempo constante (`crypto.timingSafeEqual`) para prevenir timing attacks
- Containers rodando como usuário não-root

---

## Variáveis de ambiente

Veja o arquivo [`.env`](.env) para a lista completa documentada.

Variáveis obrigatórias em produção:

```bash
STARK_PROJECT_ID
STARK_PRIVATE_KEY
STARK_PUBLIC_KEY_PEM
LICENSED_TAX_ID / LICENSED_BANK_CODE / ...
HOLDING_TAX_ID / HOLDING_BANK_CODE / ...
DB_HOST / DB_PASSWORD
SQS_QUEUE_URL / SQS_DLQ_QUEUE_URL
AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
```

---

## Escalabilidade horizontal

Workers são stateless. Para processar maior volume:

```bash
docker compose up --scale worker=10
```

O padrão `SELECT FOR UPDATE SKIP LOCKED` garante que workers concorrentes nunca processem o mesmo pagamento.
