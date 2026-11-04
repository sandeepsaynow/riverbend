import { PgBoss, type Job } from 'pg-boss';
import {
  INTAKE_DLQ, INTAKE_QUEUE, PIPELINE_DLQ, PIPELINE_QUEUE, type JobPayload, type JobQueue,
} from './index.js';

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
    // Dead-letter queues first (terminal), then each main queue routing to its DLQ.
    await this.boss.createQueue(INTAKE_DLQ);
    await this.boss.createQueue(PIPELINE_DLQ);
    for (const [queue, dlq] of [
      [INTAKE_QUEUE, INTAKE_DLQ],
      [PIPELINE_QUEUE, PIPELINE_DLQ],
    ] as const) {
      await this.boss.createQueue(queue, {
        policy: 'standard',
        retryLimit: this.retryLimit,
        retryBackoff: true,
        expireInSeconds: this.expireInSeconds,
        deadLetter: dlq,
      });
    }
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

  /**
   * Register a self-rescheduling singleton job (006/D21.1 inbound polling). A `singleton` queue + a
   * `singletonKey` send mean at most one job exists/runs at a time (single-flight across instances, with
   * the DB lease as a second guard). After each run — success or not — exactly one next run is queued
   * `startAfter: intervalSeconds`, giving a configurable seconds interval without an extra scheduler dep.
   */
  async workPoll(name: string, intervalSeconds: number, handler: () => Promise<void>): Promise<void> {
    await this.boss.createQueue(name, { policy: 'singleton', retryLimit: 0, expireInSeconds: this.expireInSeconds });
    await this.boss.work(name, { batchSize: 1 }, async () => {
      try {
        await handler();
      } catch {
        // Swallow — the next scheduled tick retries (bounded, interval-paced). Details are logged by caller.
      } finally {
        await this.schedulePoll(name, intervalSeconds);
      }
    });
  }

  /** Queue one poll run after `afterSeconds`; `singletonKey` dedups so a restart never double-schedules. */
  async schedulePoll(name: string, afterSeconds: number): Promise<void> {
    await this.boss.send(name, {}, { startAfter: afterSeconds, singletonKey: name });
  }
}
