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

ENV NODE_ENV=production
EXPOSE 8080

# Default to the api process; `command:` in docker-compose can select the worker.
CMD ["npm", "run", "start:api"]
