#!/usr/bin/env bash
# Envia um webhook simulado para o serviço local
# Uso: ./scripts/simulate-webhook.sh [URL] [VALOR_EM_CENTAVOS]

set -euo pipefail

URL="${1:-http://localhost:3000/webhook/stark}"
AMOUNT="${2:-10000}"
SECRET="${WEBHOOK_HMAC_SECRET:-local-dev-secret}"
EVENT_ID="test-$(date +%s)"
PAYMENT_ID="pay-$(date +%s)"

BODY=$(cat <<EOF
{"event":{"id":"${EVENT_ID}","subscription":"pixRequest","log":{"type":"credited","payment":{"id":"${PAYMENT_ID}","amount":${AMOUNT},"status":"paid","updated":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}}}}
EOF
)

# Calcula HMAC-SHA256
SIGNATURE=$(echo -n "${BODY}" | openssl dgst -sha256 -hmac "${SECRET}" | awk '{print $2}')

echo "➤  Enviando webhook de teste"
echo "   URL:       ${URL}"
echo "   Event ID:  ${EVENT_ID}"
echo "   Amount:    ${AMOUNT} centavos"
echo "   Signature: ${SIGNATURE}"
echo ""

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "${URL}" \
  -H "Content-Type: application/json" \
  -H "Digital-Signature: ${SIGNATURE}" \
  -d "${BODY}")

HTTP_CODE=$(echo "${RESPONSE}" | tail -n1)
BODY_RESP=$(echo "${RESPONSE}" | head -n-1)

echo "➤  Resposta (HTTP ${HTTP_CODE}):"
echo "${BODY_RESP}" | python3 -m json.tool 2>/dev/null || echo "${BODY_RESP}"

if [ "${HTTP_CODE}" = "200" ]; then
  echo ""
  echo "✔  Webhook aceito com sucesso!"
else
  echo ""
  echo "✘  Webhook rejeitado (HTTP ${HTTP_CODE})"
  exit 1
fi
