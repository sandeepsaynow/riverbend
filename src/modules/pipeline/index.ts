import type { Db } from '../../platform/db/index.js';
import { AiPausedError, BudgetExceededError, type LlmGateway } from '../../platform/llm/index.js';
import { BudgetService } from '../budget/index.js';
import { decide } from './decide.js';
import { ExtractionInvalid, validateExtraction, type Extraction } from './schema.js';
export { PER_WHEEL } from './decide.js';

export interface PipelineOptions {
  defaultBudgetMicros: number;
  estimateMicros: number;
  /** Override the billing period (YYYY-MM); defaults to the current UTC month. */
  period?: string;
}

const TERMINAL = new Set(['extracted', 'answered', 'needs_review']);

/**
 * The AI pipeline for one request (D5/D6/D7). Runs on an `awaiting_pipeline` request (initial) or an
 * `awaiting_customer` request (reply): budget reserve → gateway.extract → validate (I3, one escalation
 * retry) → settle → deterministic decide (I6) → persist extraction + set state. The model proposes;
 * code decides and performs every side effect. No price totals / work orders (slice 004), no email (006).
 */
export class PipelineService {
  private readonly budget: BudgetService;
  private codes: ReadonlySet<string> | null = null;

  constructor(
    private readonly db: Db,
    private readonly gateway: LlmGateway,
    private readonly opts: PipelineOptions,
  ) {
    this.budget = new BudgetService(db);
  }

  private period(): string {
    return this.opts.period ?? new Date().toISOString().slice(0, 7);
  }

  private async catalogCodes(): Promise<ReadonlySet<string>> {
    if (this.codes) return this.codes;
    const r = await this.db.appQuery<{ code: string }>(`SELECT code FROM catalog_service`);
    this.codes = new Set(r.rows.map((x) => x.code));
    return this.codes;
  }

  /** Record the customer's one reply, to be consumed on the next run with isReply=true. */
  async applyReply(shopId: string, requestId: string, replyContent: string): Promise<void> {
    await this.db.withTenant(shopId, (c) =>
      c.query(`UPDATE follow_ups SET reply_content = $2, replied_at = now() WHERE request_id = $1`, [requestId, replyContent]),
    );
  }

  async run(payload: { requestId: string; shopId: string }, opts: { isReply?: boolean } = {}): Promise<void> {
    const { requestId, shopId } = payload;
    const period = this.period();

    const loaded = await this.db.withTenant(shopId, (c) =>
      c.query<{ state: string; content: string }>(
        `SELECT r.state, m.content FROM requests r JOIN messages m ON m.id = r.message_id WHERE r.id = $1`,
        [requestId],
      ),
    );
    const row = loaded.rows[0];
    if (!row || TERMINAL.has(row.state)) return; // unknown or already decided (idempotent)

    // Follow-up context (alreadyAsked + the reply text, if any).
    const fu = await this.db.withTenant(shopId, (c) =>
      c.query<{ reply_content: string | null }>(`SELECT reply_content FROM follow_ups WHERE request_id = $1`, [requestId]),
    );
    const alreadyAsked = fu.rows.length > 0;
    let content = row.content;
    const hasReply = alreadyAsked && !!fu.rows[0]!.reply_content;
    if (hasReply) content = `${content}\n${fu.rows[0]!.reply_content}`;
    // A reply is being consumed if the caller said so OR a reply is present (resumed via the queue).
    // Distinct budget-receipt step so the reply call is charged separately from the first extraction.
    const step = opts.isReply || hasReply ? 'extract-reply' : 'extract';

    // Ensure a budget row (operator cap preserved if already set).
    if (!(await this.budget.usage(shopId, period))) {
      await this.budget.ensureBudget(shopId, period, this.opts.defaultBudgetMicros);
    }

    await this.setState(shopId, requestId, 'processing');

    // The fixed service-code vocabulary the model may map onto (FR-002); code re-validates it (I3).
    const codes = await this.catalogCodes();
    const allowedServiceCodes = [...codes];

    // Extract with validation (I3) and one escalation retry; reserve-then-settle each attempt (I4).
    let extraction: Extraction | null = null;
    let lastErr = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const res = await this.budget.reserve({ shopId, requestId, period, step, attempt, estimateMicros: this.opts.estimateMicros });
      if (!res.ok) {
        await this.setState(shopId, requestId, 'held_budget');
        return; // at the cap — honest no-AI hold (D7)
      }
      let raw: unknown;
      try {
        raw = await this.gateway.extract({ content, allowedServiceCodes, shopId });
      } catch (err) {
        if (res.callId && !res.reused) await this.budget.settle(shopId, res.callId, 0);
        if (err instanceof BudgetExceededError || err instanceof AiPausedError) {
          // Budget authority denied admission (I4), or the AI-paused switch is on (007): honest no-AI
          // hold, no retry. Staff see held_budget; it resumes when the cap/switch clears.
          await this.setState(shopId, requestId, 'held_budget');
          return;
        }
        throw err; // transient (timeout / circuit-open / bulkhead) → let pg-boss retry, then DLQ → needs_review
      }
      // Settle at the proxy-calculated real cost when available (FR-007), else the estimate.
      const costMicros = this.gateway.lastCostMicros ?? this.opts.estimateMicros;
      if (res.callId && !res.reused) await this.budget.settle(shopId, res.callId, costMicros);
      try {
        extraction = validateExtraction(raw, codes);
        break;
      } catch (err) {
        if (!(err instanceof ExtractionInvalid)) throw err;
        lastErr = err.message; // escalate: retry once (a stronger model in prod; same fake here)
      }
    }
    if (!extraction) {
      await this.setStateWithError(shopId, requestId, 'needs_review', `invalid_output: ${lastErr}`);
      return;
    }

    const decision = decide(extraction, alreadyAsked);
    const flagged = decision.outcome === 'extracted' && decision.flagged;
    const bikes = flagged
      ? [{ bikeNumber: 1, issues: extraction.bikes.flatMap((b) => b.issues), serviceCodes: ['GENERAL_INSPECT'] }]
      : extraction.bikes;
    await this.upsertExtraction(shopId, requestId, extraction.kind, bikes, extraction.urgency, extraction.dateWords, flagged);

    switch (decision.outcome) {
      case 'ask':
        await this.insertFollowUp(shopId, requestId, decision.question);
        await this.setState(shopId, requestId, 'awaiting_customer');
        break;
      case 'extracted':
        await this.setState(shopId, requestId, 'extracted');
        break;
      case 'answered':
        await this.setState(shopId, requestId, 'answered');
        break;
      case 'needs_review':
        await this.setStateWithError(shopId, requestId, 'needs_review', decision.reason);
        break;
    }
  }

  private async setState(shopId: string, requestId: string, state: string): Promise<void> {
    await this.db.withTenant(shopId, (c) =>
      c.query(`UPDATE requests SET state = $2, updated_at = now() WHERE id = $1`, [requestId, state]),
    );
  }
  private async setStateWithError(shopId: string, requestId: string, state: string, reason: string): Promise<void> {
    await this.db.withTenant(shopId, (c) =>
      c.query(`UPDATE requests SET state = $2, last_error = $3, updated_at = now() WHERE id = $1`, [requestId, state, reason]),
    );
  }
  private async upsertExtraction(
    shopId: string, requestId: string, kind: string, bikes: unknown, urgency: string, dateWords: string | null, flagged: boolean,
  ): Promise<void> {
    await this.db.withTenant(shopId, (c) =>
      c.query(
        `INSERT INTO extractions (shop_id, request_id, kind, bikes, urgency, date_words, flagged)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (request_id) DO UPDATE SET kind=EXCLUDED.kind, bikes=EXCLUDED.bikes,
           urgency=EXCLUDED.urgency, date_words=EXCLUDED.date_words, flagged=EXCLUDED.flagged`,
        [shopId, requestId, kind, JSON.stringify(bikes), urgency, dateWords, flagged],
      ),
    );
  }
  private async insertFollowUp(shopId: string, requestId: string, question: string): Promise<void> {
    await this.db.withTenant(shopId, (c) =>
      c.query(
        `INSERT INTO follow_ups (shop_id, request_id, question) VALUES ($1, $2, $3)
         ON CONFLICT (request_id) DO NOTHING`, // UNIQUE(request_id) enforces at most one (I6)
        [shopId, requestId, question],
      ),
    );
  }
}
