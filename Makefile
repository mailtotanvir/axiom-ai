.PHONY: help install build lint typecheck test up down logs ps smoke clean

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install TS workspaces + Python venv
	npm install --no-audit --no-fund
	npx prisma generate --schema services/ops-observability/prisma/schema.prisma
	cd services/rag-pipeline && \
		python3 -m venv .venv && \
		.venv/bin/pip install -q -r requirements.txt -r requirements-dev.txt

build: ## Compile all TypeScript services + core package
	npm run build -w @tanvir1971/core -w @axiom-ai/gateway -w @axiom-ai/agent-runtime -w @axiom-ai/ops-observability

lint: ## Lint TS (eslint) + Python (ruff)
	npm run lint -w @tanvir1971/core -w @axiom-ai/gateway -w @axiom-ai/agent-runtime -w @axiom-ai/ops-observability
	cd services/rag-pipeline && .venv/bin/python -m ruff check app tests

typecheck: ## TypeScript strict typecheck across workspaces
	npm run typecheck -w @tanvir1971/core -w @axiom-ai/gateway -w @axiom-ai/agent-runtime -w @axiom-ai/ops-observability

test: ## Run all unit tests (vitest + pytest)
	npm test -w @tanvir1971/core -w @axiom-ai/gateway -w @axiom-ai/agent-runtime -w @axiom-ai/ops-observability
	cd services/rag-pipeline && .venv/bin/python -m pytest -q

up: ## Boot the full platform via docker compose
	docker compose -f docker-compose.dev.yml up -d --build
	@echo ""
	@echo "Jaeger UI      http://localhost:16686"
	@echo "Qdrant console http://localhost:6333/dashboard"
	@echo "Traefik routes Host(api.axiom.ai) / Host(ops.axiom.ai) on :80"
	@echo ""

down: ## Tear down the compose stack
	docker compose -f docker-compose.dev.yml down

logs: ## Tail service logs
	docker compose -f docker-compose.dev.yml logs -f --tail=100 gateway rag-pipeline agent-runtime ops-observability

ps: ## Show compose service status
	docker compose -f docker-compose.dev.yml ps

smoke: ## Verify all health endpoints respond
	scripts/smoke.sh localhost

clean: ## Remove build artifacts and volumes
	rm -rf packages/*/dist services/*/dist services/*/coverage packages/*/coverage
	docker compose -f docker-compose.dev.yml down -v || true
