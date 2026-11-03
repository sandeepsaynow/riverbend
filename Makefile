.PHONY: up down migrate test typecheck lint logs

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
