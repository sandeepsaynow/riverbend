# Single image, run as either the api or the worker process (D1).
FROM node:22-slim

WORKDIR /app

# Install dependencies first for layer caching.
COPY package.json package-lock.json* ./
RUN npm ci || npm install

# Application source (TypeScript, run directly via tsx — no build step needed in this slice).
COPY tsconfig.json ./
COPY catalog ./catalog
COPY src ./src
# Operator scripts (e.g. no-SQL local provisioning, 009) so they can run in-container against the
# compose database — `docker compose exec api npx tsx scripts/provision.ts` — avoiding any host DB.
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 8080

# Default to the api process; `command:` in docker-compose can select the worker.
CMD ["npm", "run", "start:api"]
