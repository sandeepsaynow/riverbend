import express, { type Request, type Response } from 'express';
import { EmailService } from '../modules/email/index.js';
import { parseResendEvent, type InboundWebhookVerifier } from '../modules/email/resend-webhook.js';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * Inbound Resend webhook (D21). Resend POSTs an `email.*` event signed with Svix; we verify the
 * signature over the RAW body, durably record the provider event (de-duped by svix-id) BEFORE acking,
 * and return 200 fast. The worker fetches content + correlates asynchronously (the payload is metadata
 * only). Mounted OUTSIDE shop auth (authenticated by signature). Off unless configured.
 */
export function registerResendWebhook(
  app: express.Express,
  deps: { email: EmailService; verifier: InboundWebhookVerifier },
): void {
  const r = express.Router();
  r.post('/webhooks/resend', async (req: Request, res: Response) => {
    const raw = (req as RawBodyRequest).rawBody;
    const svixId = req.get('svix-id') ?? '';
    const svixTimestamp = req.get('svix-timestamp') ?? '';
    const svixSignature = req.get('svix-signature') ?? '';
    if (!raw || !svixId || !svixTimestamp || !svixSignature) {
      res.status(400).json({ error: 'invalid signature' });
      return;
    }
    const event = deps.verifier.verify(raw.toString('utf8'), { svixId, svixTimestamp, svixSignature });
    if (!event) {
      res.status(400).json({ error: 'invalid signature' });
      return;
    }
    const parsed = parseResendEvent(event);
    if (!parsed) {
      res.status(400).json({ error: 'malformed event' });
      return;
    }
    // Persist the provider event identity BEFORE acknowledging (durable + idempotent).
    const result = await deps.email.ingestEvent(svixId, parsed.type, parsed.emailId);
    res.status(200).json({ status: result });
  });
  app.use(r);
}
