#!/usr/bin/env bash
# Verifies every Axiom AI service answers its health endpoints.
# Usage: scripts/smoke.sh [base-host]   (default: localhost)

set -euo pipefail

HOST="${1:-localhost}"
SECRET="${AXIOM_INTER_SERVICE_SECRET:-dev-only-inter-service-secret}"
TENANT="axiom-smoke"
FAILURES=0

check() {
  local name="$1" url="$2" expected="$3"
  shift 3
  if curl -fsS --max-time 10 "$@" "$url" | grep -q "$expected"; then
    printf '  \033[32mok\033[0m    %-28s %s\n' "$name" "$url"
  else
    printf '  \033[31mFAIL\033[0m  %-28s %s\n' "$name" "$url"
    FAILURES=$((FAILURES + 1))
  fi
}

signed_knowledge_headers() {
  local body="$1" timestamp body_hash canonical signature
  timestamp="$(date +%s)"
  body_hash="$(printf '%s' "$body" | openssl dgst -sha256 -hex | awk '{print $NF}')"
  canonical="${timestamp}.${body_hash}.${TENANT}"
  signature="$(printf '%s' "$canonical" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $NF}')"
  printf -- '-H\ncontent-type: application/json\n-H\nx-axiom-tenant: %s\n-H\nx-axiom-signature: t=%s,v1=%s\n' \
    "$TENANT" "$timestamp" "$signature"
}

echo "Axiom AI smoke test against $HOST"
check "gateway /healthz"     "http://$HOST:3000/healthz" '"status":"ok"'
check "rag-pipeline /healthz" "http://$HOST:8000/healthz" '"status":"ok"'
check "agent-runtime /healthz" "http://$HOST:5000/healthz" '"status":"ok"'
check "ops-observability /healthz" "http://$HOST:14000/healthz" '"status":"ok"'
check "gateway model catalog" "http://$HOST:3000/v1/models" 'gemini-3.6-flash'

knowledge_body='{"query":"smoke test","top_k":3}'
mapfile -t KNOWLEDGE_HEADERS < <(signed_knowledge_headers "$knowledge_body")
check "rag retrieval API"     "http://$HOST:8000/v1/knowledge/retrieve" 'served_from_cache' \
  "${KNOWLEDGE_HEADERS[@]}" -d "$knowledge_body"
check "clickhouse ping"      "http://$HOST:8123/ping" 'Ok.'
check "qdrant readiness"     "http://$HOST:6333/readyz" 'all shards are ready'

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES check(s) failed"
  exit 1
fi
echo "All checks passed."
