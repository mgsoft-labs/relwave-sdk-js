import type { ErrorMap } from './types.js';

/**
 * Thrown whenever the API returns a non-2xx status or a populated `errors`
 * map. Carries the HTTP `status`, the structured `errors` map and — for 429
 * responses — the `retryAfter` window in seconds.
 *
 * @example
 * ```ts
 * try {
 *   await client.messages.send({ to: 'x@example.com', subject: 'Hi', text: 'yo' });
 * } catch (err) {
 *   if (err instanceof NewsletterError) {
 *     console.error(err.status, err.errors);
 *     if (err.isRateLimited) {
 *       await sleep((err.retryAfter ?? 1) * 1000);
 *     }
 *   }
 * }
 * ```
 */
export class NewsletterError extends Error {
  /** HTTP status code (e.g. 401, 403, 404, 422, 429). */
  readonly status: number;

  /** Structured `field -> messages[]` map from the response envelope. */
  readonly errors: ErrorMap;

  /** Seconds to wait before retrying — only set on 429 responses. */
  readonly retryAfter?: number;

  /** Free-form `meta` block from the error envelope, when present. */
  readonly meta: Record<string, unknown>;

  /** The raw parsed response body, for debugging. */
  readonly body: unknown;

  constructor(
    message: string,
    options: {
      status: number;
      errors?: ErrorMap;
      retryAfter?: number;
      meta?: Record<string, unknown>;
      body?: unknown;
    },
  ) {
    super(message);
    this.name = 'NewsletterError';
    this.status = options.status;
    this.errors = options.errors ?? {};
    this.retryAfter = options.retryAfter;
    this.meta = options.meta ?? {};
    this.body = options.body;

    // Restore prototype chain for `instanceof` across transpilation targets.
    Object.setPrototypeOf(this, NewsletterError.prototype);
  }

  /** True for 401 (missing/invalid API key). */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** True for 403 (account suspended / forbidden). */
  get isForbidden(): boolean {
    return this.status === 403;
  }

  /** True for 404 (resource not found). */
  get isNotFound(): boolean {
    return this.status === 404;
  }

  /** True for 422 (validation failed). */
  get isValidationError(): boolean {
    return this.status === 422;
  }

  /** True for 429 (rate limited) — inspect {@link retryAfter}. */
  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /**
   * Flatten the {@link errors} map into a single readable string, e.g.
   * `"email: invalid format; to: recipient is on the suppression list"`.
   */
  toReadableString(): string {
    const parts: string[] = [];

    for (const [field, messages] of Object.entries(this.errors)) {
      parts.push(`${field}: ${messages.join(', ')}`);
    }

    return parts.length > 0 ? parts.join('; ') : this.message;
  }
}
