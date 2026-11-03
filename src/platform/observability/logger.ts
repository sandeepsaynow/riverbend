import pino from 'pino';

/**
 * Structured JSON logger. Carries no customer message text (Principle VII); in this slice there
 * is no message text at all. Redacts common secret-bearing fields defensively.
 */
export function createLogger(level: string) {
  return pino({
    level,
    redact: {
      paths: ['req.headers.authorization', 'password', 'secret', '*.secret', 'token'],
      censor: '[redacted]',
    },
    base: null, // pino: null removes pid/hostname base fields (the correct idiom vs undefined)
  });
}

export type Logger = ReturnType<typeof createLogger>;
