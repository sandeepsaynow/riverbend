.PHONY: up down migrate test typecheck lint logs eval eval-live provision

# One-command local run (FR-012): start Postgres + api; the api migrates before serving (FR-022).
up:
	docker compose up --build -d
	@echo "Waiting for readiness on http://localhost:8080/readyz ..."
	@for i in $$(seq 1 60); do \
		if curl -fs localhost:8080/readyz >/dev/null 2>&1; then echo "READY"; exit 0; fi; \
		sleep 2; \
	done; echo "Not ready in time; see 'make logs'"; exit 1

down:
	docker compose down -v

logs:
	docker compose logs -f api

# Run migrations against the migrator connection (also done automatically on api startup).
migrate:
	npm run migrate

# Tests use Testcontainers (real PostgreSQL via Docker). Requires Docker running.
test:
	npm test

typecheck:
	npm run typecheck

lint:
	npm run lint

# 40-message evaluation (008). `eval` is deterministic + free (recorded golden; Docker for the DB).
# `eval-live` uses the real provider via LiteLLM (gated B1, costs money) — run the proxy first
# (`docker compose --profile llm up -d litellm`) and keep the aggregate spend under USD 20.
eval:
	npx tsx eval/run.ts recorded

eval-live:
	npx tsx eval/run.ts live

# No-SQL local provisioning (009): ensure the 3 shops + issue a shop API key each (idempotent).
# `make provision` leaves existing active keys alone; `make provision ROTATE=1` issues replacements.
provision:
	npx tsx scripts/provision.ts $(if $(ROTATE),--rotate,)
