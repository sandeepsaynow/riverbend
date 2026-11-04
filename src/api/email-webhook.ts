import express, { type Request, type Response } from 'express';
import { EmailService } from '../modules/email/index.js';
import { verifyWebhookSignature } from '../modules/email/tokens.js';

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * Inbound email webhook (D10). A provider (e.g. Mailgun) POSTs a received reply; we verify an HMAC
 * signature over the raw body, then correlate/de-dup/resume via EmailService. Mounted OUTSIDE shop
 * auth (the request authenticates by signature, not a shop key). Off unless configured.
 */
export function registerEmailWebhook(
  app: express.Express,
  deps: { email: EmailService; webhookSecret: string },
): void {
  const r = express.Router();
  r.post('/webhooks/email', async (req: Request, res: Response) => {
    const raw = (req as RawBodyRequest).rawBody;
    const sig = req.get('x-riverbend-signature') ?? '';
    if (!raw || !verifyWebhookSignature(deps.webhookSecret, raw.toString('utf8'), sig)) {
      res.status(401).json({ error: 'invalid signature' });
      return;
    }
    const b = (req.body ?? {}) as Record<string, string>;
    const result = await deps.email.handleInbound({
      providerMessageId: b.message_id ?? '',
      toAddress: b.to ?? '',
      ...(b.in_reply_to ? { inReplyTo: b.in_reply_to } : {}),
      ...(b.references ? { references: b.references } : {}),
      text: b.text ?? '',
    });
    // Always 200 to the provider (don't leak which tokens exist); report the outcome for observability.
    res.status(200).json({ status: result });
  });
  app.use(r);
}
