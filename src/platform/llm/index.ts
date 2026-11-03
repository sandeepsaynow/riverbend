/**
 * LlmGateway port (D6). The model only fills a strict form; it returns RAW, UNVALIDATED output that
 * code must validate (I3). No tools, memory, secrets, prices, or shop-list are ever passed to it.
 */
export interface ExtractionInput {
  /** The customer message body. Never logged. */
  content: string;
  /** BCP-47 locale hint for same-language replies (no PII). */
  locale?: string;
}

export interface LlmGateway {
  readonly name: string;
  /** Returns raw model output (unknown shape) — the caller validates against the schema (I3). */
  extract(input: ExtractionInput): Promise<unknown>;
}
