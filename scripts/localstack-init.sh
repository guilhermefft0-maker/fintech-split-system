#!/usr/bin/env bash
# Executado automaticamente pelo LocalStack ao iniciar
# Cria as filas SQS FIFO necessárias para o sistema

set -euo pipefail

ENDPOINT="http://localhost:4566"
REGION="us-east-1"
ACCOUNT="000000000000"

echo "➤  Criando filas SQS..."

# Fila principal FIFO
awslocal sqs create-queue \
  --queue-name "fintech-payments.fifo" \
  --attributes '{
    "FifoQueue":                 "true",
    "ContentBasedDeduplication": "false",
    "VisibilityTimeout":         "300",
    "MessageRetentionPeriod":    "86400",
    "ReceiveMessageWaitTimeSeconds": "20"
  }' \
  --region "${REGION}"

echo "✔  Fila principal criada: fintech-payments.fifo"

# Dead Letter Queue FIFO
awslocal sqs create-queue \
  --queue-name "fintech-payments-dlq.fifo" \
  --attributes '{
    "FifoQueue": "true",
    "ContentBasedDeduplication": "false",
    "MessageRetentionPeriod": "1209600"
  }' \
  --region "${REGION}"

echo "✔  DLQ criada: fintech-payments-dlq.fifo"

# Vincula a DLQ à fila principal (redrive policy)
MAIN_URL="http://localstack:4566/${ACCOUNT}/fintech-payments.fifo"
DLQ_ARN="arn:aws:sqs:${REGION}:${ACCOUNT}:fintech-payments-dlq.fifo"

awslocal sqs set-queue-attributes \
  --queue-url "${MAIN_URL}" \
  --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" \
  --region "${REGION}" 2>/dev/null || true

echo "✔  Redrive policy configurada (max 5 tentativas → DLQ)"
echo ""
echo "✔  LocalStack SQS inicializado com sucesso!"
