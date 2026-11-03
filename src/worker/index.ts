import { loadConfig } from '../platform/config/index.js';
import { createLogger } from '../platform/observability/logger.js';

/**
 * Worker process — placeholder for slice 001. It performs NO work: the job queue and all
 * background processing (and anything AI-related) arrive in slice 002. It exists only so the
 * api/worker two-process split (D1) is established now. This process must never call the AI model.
 */
function main(): void {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  logger.info('worker placeholder: no jobs are processed until slice 002 (intake-queue)');
}

main();
