#!/usr/bin/env bash
# Verifies every Axiom AI service answers its health endpoints.
# Usage: scripts/smoke.sh [base-host]   (default: localhost)

set -euo pipefail

HOST="${1:-localhost}"
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

echo "Axiom AI smoke test against $HOST"
check "gateway /healthz"     "http://$HOST:3000/healthz" '"status":"ok"'
check "rag-pipeline /healthz" "http://$HOST:8000/healthz" '"status":"ok"'
check "agent-runtime /healthz" "http://$HOST:5000/healthz" '"status":"ok"'
check "ops-observability /healthz" "http://$HOST:14000/healthz" '"status":"ok"'
check "gateway model catalog" "http://$HOST:3000/v1/models" 'gemini-3.6-flash'
check "rag retrieval stub"    "http://$HOST:8000/v1/knowledge/retrieve" 'served_from_cache' \
  -H 'content-type: application/json' -d '{"query":"smoke test","top_k":3}'
check "clickhouse ping"      "http://$HOST:8123/ping" 'Ok.'
check "qdrant readiness"     "http://$HOST:6333/readyz" 'all shards are ready'

if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES check(s) failed"
  exit 1
fi
echo "All checks passed."
