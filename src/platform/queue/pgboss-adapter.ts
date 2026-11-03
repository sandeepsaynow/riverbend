import { PgBoss, type Job } from 'pg-boss';
import { INTAKE_DLQ, INTAKE_QUEUE, type JobPayload, type JobQueue } from './index.js';

export interface PgBossConfig {
  /** Owner/migrator connection — pg-boss creates and owns its `pgboss` schema here, not app_user. */
  ownerUrl: string;
  /** Total processing attempts incl. the first; pg-boss retryLimit = maxAttempts − 1 (FR-011). */
  maxAttempts: number;
  /** Job lease/expiration in seconds (drives crash recovery via lease expiration). */
  expireSeconds: number;
}

/**
 * pg-boss adapter. pg-boss is the SINGLE authority for retries, backoff, lease-based crash recovery,
 * and the attempt limit (verified against pg-boss 12.x, research R5). A crashed worker's job is
 * redelivered by lease expiration while attempts remain; on exhaustion it routes to the dead-letter
 * queue, where the worker transitions the request to `needs_review`. No application retry loop.
 */
export class PgBossQueue implements JobQueue {
  private readonly boss: PgBoss;
  private readonly retryLimit: number;
  private readonly expireInSeconds: number;

  constructor(cfg: PgBossConfig) {
    this.boss = new PgBoss({ connectionString: cfg.ownerUrl });
    this.retryLimit = Math.max(0, cfg.maxAttempts - 1);
    this.expireInSeconds = cfg.expireSeconds;
  }

  async start(): Promise<void> {
    await this.boss.start();
    // Dead-letter queue first (no retries; terminal), then the main queue routing to it.
    await this.boss.createQueue(INTAKE_DLQ);
    await this.boss.createQueue(INTAKE_QUEUE, {
      policy: 'standard',
      retryLimit: this.retryLimit,
      retryBackoff: true,
      expireInSeconds: this.expireInSeconds,
      deadLetter: INTAKE_DLQ,
    });
  }

  async stop(): Promise<void> {
    await this.boss.stop();
  }

  async publish(name: string, payload: JobPayload): Promise<void> {
    await this.boss.send(name, payload);
  }

  async work(name: string, handler: (payload: JobPayload) => Promise<void>): Promise<void> {
    await this.boss.work<JobPayload>(name, { batchSize: 1 }, async (jobs: Job<JobPayload>[]) => {
      for (const job of jobs) {
        await handler(job.data);
      }
    });
  }
}
