import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { HttpError } from './typed-route.js';
import type { Logger } from '../observability/logger.js';

/** Central error handler. Express 5 forwards async errors here (D12). Never leaks internals. */
export function errorHandler(logger: Logger) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof ZodError) {
      res.status(422).json({
        error: 'validation_error',
        message: 'Request failed validation',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'unhandled error');
    res.status(500).json({ error: 'internal', message: 'Internal server error' });
  };
}
