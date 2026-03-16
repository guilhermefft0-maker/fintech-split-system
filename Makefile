.PHONY: help up down build logs logs-webhook logs-worker \
        migrate psql sqs-stats sqs-dlq-stats sqs-purge \
        dev-webhook dev-worker simulate-webhook \
        test lint clean scale-workers

# ── Cores ─────────────────────────────────────────────────────────────────────
CYAN  := \033[36m
RESET := \033[0m

help: ## Lista todos os comandos disponíveis
	@echo ""
	@echo "  Fintech Split System — comandos disponíveis"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  $(CYAN)%-22s$(RESET) %s\n", $$1, $$2}'
	@echo ""

# ── Stack ─────────────────────────────────────────────────────────────────────
up: ## Sobe todos os serviços em background
	docker compose up -d --build

down: ## Para e remove os containers
	docker compose down

build: ## Reconstrói as imagens Docker
	docker compose build --no-cache

logs: ## Tail de todos os logs
	docker compose logs -f

logs-webhook: ## Logs do webhook service
	docker compose logs -f webhook

logs-worker: ## Logs do worker
	docker compose logs -f worker

scale-workers: ## Escala workers horizontalmente (uso: make scale-workers N=3)
	docker compose up -d --scale worker=$(N)

# ── Banco de dados ────────────────────────────────────────────────────────────
migrate: ## Roda as migrations
	docker compose run --rm migrate

psql: ## Abre shell psql no banco
	docker compose exec postgres psql -U postgres -d fintech_split

# ── SQS ──────────────────────────────────────────────────────────────────────
sqs-stats: ## Mensagens na fila principal
	docker compose exec localstack awslocal sqs get-queue-attributes \
		--queue-url http://localstack:4566/000000000000/fintech-payments.fifo \
		--attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
		--region us-east-1

sqs-dlq-stats: ## Mensagens na Dead Letter Queue
	docker compose exec localstack awslocal sqs get-queue-attributes \
		--queue-url http://localstack:4566/000000000000/fintech-payments-dlq.fifo \
		--attribute-names ApproximateNumberOfMessages \
		--region us-east-1

sqs-purge: ## Limpa a fila principal (CUIDADO!)
	@echo "⚠️  Isso vai apagar todas as mensagens da fila. Continuar? [y/N]" && read ans && [ $${ans:-N} = y ]
	docker compose exec localstack awslocal sqs purge-queue \
		--queue-url http://localstack:4566/000000000000/fintech-payments.fifo \
		--region us-east-1

# ── Dev local ─────────────────────────────────────────────────────────────────
dev-webhook: ## Webhook service com hot-reload (ts-node-dev)
	npx ts-node-dev --respawn --transpile-only src/webhook/server.ts

dev-worker: ## Worker com hot-reload (ts-node-dev)
	npx ts-node-dev --respawn --transpile-only src/worker/payment.worker.ts

simulate-webhook: ## Envia um webhook de teste para o serviço local
	@bash scripts/simulate-webhook.sh

# ── Testes e código ───────────────────────────────────────────────────────────
test: ## Roda os testes unitários
	npx jest --runInBand --forceExit

test-watch: ## Roda os testes em modo watch
	npx jest --watch

test-coverage: ## Roda os testes com relatório de cobertura
	npx jest --coverage --runInBand --forceExit

lint: ## Executa o ESLint
	npx eslint src --ext .ts

clean: ## Remove node_modules e dist
	rm -rf node_modules dist
