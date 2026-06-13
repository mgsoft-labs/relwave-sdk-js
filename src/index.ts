import { NewsletterError } from './errors.js';
import type {
  ApiEnvelope,
  Campaign,
  CreateSubscriberInput,
  ErrorMap,
  ListSubscribersParams,
  MailingList,
  Message,
  Paginated,
  PaginationMeta,
  RequestOptions,
  SendMessageInput,
  Subscriber,
} from './types.js';

export { NewsletterError } from './errors.js';
export type * from './types.js';

/** Minimal `fetch` signature so the SDK works in Node 18+, Deno and browsers. */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Configuration for {@link NewsletterClient}. */
export interface NewsletterClientConfig {
  /**
   * API key in `nl_xxxxx.secret` form. Keys prefixed with `nl_test_` are
   * sandbox keys — transactional sends are mocked, no real email is delivered.
   */
  apiKey: string;
  /**
   * Base URL of the API, without a trailing `/api/v1`. Defaults to
   * `https://api.avva.com.tr`. The `/api/v1` segment is appended automatically.
   */
  baseUrl?: string;
  /** Send the key as `X-Api-Key` instead of `Authorization: Bearer`. Default: bearer. */
  useApiKeyHeader?: boolean;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Per-request timeout in milliseconds. Default: 30000. Set `0` to disable. */
  timeoutMs?: number;
  /** Override the `fetch` implementation (e.g. for testing). Defaults to global `fetch`. */
  fetch?: FetchLike;
}

const DEFAULT_BASE_URL = 'https://api.avva.com.tr';
const DEFAULT_TIMEOUT_MS = 30_000;

interface RequestSpec {
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

/**
 * Typed client for the AVVA Newsletter API.
 *
 * @example
 * ```ts
 * import { NewsletterClient } from '@avva/newsletter';
 *
 * const client = new NewsletterClient({ apiKey: process.env.NEWSLETTER_API_KEY! });
 *
 * const message = await client.messages.send({
 *   to: 'jane@example.com',
 *   subject: 'Welcome!',
 *   html: '<h1>Hi {{ name }}</h1>',
 *   variables: { name: 'Jane' },
 * });
 * console.log(message.id, message.status);
 * ```
 */
export class NewsletterClient {
  readonly subscribers: SubscribersResource;
  readonly lists: ListsResource;
  readonly campaigns: CampaignsResource;
  readonly messages: MessagesResource;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly useApiKeyHeader: boolean;
  private readonly extraHeaders: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(config: NewsletterClientConfig) {
    if (!config.apiKey) {
      throw new Error('NewsletterClient: `apiKey` is required.');
    }

    const fetchImpl = config.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error(
        'NewsletterClient: no global `fetch` available. Use Node 18+ or pass a `fetch` implementation.',
      );
    }

    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.useApiKeyHeader = config.useApiKeyHeader ?? false;
    this.extraHeaders = config.headers ?? {};
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = fetchImpl;

    this.subscribers = new SubscribersResource(this);
    this.lists = new ListsResource(this);
    this.campaigns = new CampaignsResource(this);
    this.messages = new MessagesResource(this);
  }

  /** True when this client is authenticated with a sandbox (`nl_test_`) key. */
  get isSandbox(): boolean {
    return this.apiKey.startsWith('nl_test_');
  }

  /**
   * Issue a request and return the parsed envelope. Throws {@link NewsletterError}
   * on HTTP >= 400 or a populated `errors` map. Internal — resources call this.
   *
   * @internal
   */
  async request<T>(spec: RequestSpec): Promise<ApiEnvelope<T>> {
    const url = this.buildUrl(spec.path, spec.query);
    const headers = this.buildHeaders(spec);
    const { signal, clear } = this.buildSignal(spec.signal);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: spec.method,
        headers,
        body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
        signal,
      });
    } catch (cause) {
      clear();
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new NewsletterError('Request aborted or timed out.', {
          status: 0,
          body: cause,
        });
      }
      throw new NewsletterError(
        `Network error: ${cause instanceof Error ? cause.message : String(cause)}`,
        { status: 0, body: cause },
      );
    } finally {
      clear();
    }

    return this.parse<T>(response);
  }

  private async parse<T>(response: Response): Promise<ApiEnvelope<T>> {
    const text = await response.text();
    let parsed: unknown = null;

    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Non-JSON body (e.g. a proxy error page) — surface it raw.
        if (!response.ok) {
          throw new NewsletterError(
            `Unexpected non-JSON response (HTTP ${response.status}).`,
            { status: response.status, body: text },
          );
        }
        throw new NewsletterError('Failed to parse response body as JSON.', {
          status: response.status,
          body: text,
        });
      }
    }

    const envelope = (parsed ?? {}) as Partial<ApiEnvelope<T>>;
    const errors = normalizeErrors(envelope.errors);
    const hasErrors = Object.keys(errors).length > 0;

    if (!response.ok || hasErrors) {
      throw new NewsletterError(this.buildErrorMessage(response.status, errors), {
        status: response.status,
        errors,
        retryAfter: this.resolveRetryAfter(response, envelope.meta),
        meta: (envelope.meta as Record<string, unknown>) ?? {},
        body: parsed,
      });
    }

    return {
      data: envelope.data as T,
      meta: (envelope.meta as Record<string, unknown>) ?? {},
      errors: {},
    };
  }

  private buildErrorMessage(status: number, errors: ErrorMap): string {
    const first = Object.values(errors)[0]?.[0];
    if (first) {
      return first;
    }
    return `Newsletter API request failed with status ${status}.`;
  }

  private resolveRetryAfter(
    response: Response,
    meta: Record<string, unknown> | undefined,
  ): number | undefined {
    if (response.status !== 429) {
      return undefined;
    }

    const header = response.headers.get('Retry-After');
    if (header) {
      const parsed = Number.parseInt(header, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    const metaValue = meta?.['retry_after_seconds'];
    if (typeof metaValue === 'number' && Number.isFinite(metaValue)) {
      return metaValue;
    }

    return undefined;
  }

  private buildUrl(path: string, query?: RequestSpec['query']): string {
    let url = `${this.baseUrl}/api/v1${path}`;

    if (query) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          search.append(key, String(value));
        }
      }
      const qs = search.toString();
      if (qs.length > 0) {
        url += `?${qs}`;
      }
    }

    return url;
  }

  private buildHeaders(spec: RequestSpec): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.extraHeaders,
    };

    if (this.useApiKeyHeader) {
      headers['X-Api-Key'] = this.apiKey;
    } else {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    if (spec.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (spec.idempotencyKey) {
      headers['X-Idempotency-Key'] = spec.idempotencyKey;
    }

    return headers;
  }

  private buildSignal(external?: AbortSignal): { signal: AbortSignal | undefined; clear: () => void } {
    if (this.timeoutMs <= 0) {
      return { signal: external, clear: () => {} };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const clear = () => clearTimeout(timer);

    if (external) {
      if (external.aborted) {
        controller.abort();
      } else {
        external.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }

    return { signal: controller.signal, clear };
  }
}

/** Normalize the envelope `errors` block (object or `{}`) into an {@link ErrorMap}. */
function normalizeErrors(raw: unknown): ErrorMap {
  if (!raw || typeof raw !== 'object') {
    return {};
  }

  const out: ErrorMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      out[key] = value.map((v) => String(v));
    } else if (value != null) {
      out[key] = [String(value)];
    }
  }

  return out;
}

function toPaginationMeta(meta: Record<string, unknown>): PaginationMeta {
  return {
    current_page: Number(meta['current_page'] ?? 1),
    last_page: Number(meta['last_page'] ?? 1),
    per_page: Number(meta['per_page'] ?? 0),
    total: Number(meta['total'] ?? 0),
  };
}

/** Subscriber operations: `client.subscribers.*`. */
export class SubscribersResource {
  constructor(private readonly client: NewsletterClient) {}

  /** List subscribers (paginated). `GET /subscribers`. */
  async list(params: ListSubscribersParams = {}): Promise<Paginated<Subscriber>> {
    const envelope = await this.client.request<Subscriber[]>({
      method: 'GET',
      path: '/subscribers',
      query: { page: params.page, per_page: params.per_page },
    });

    return {
      data: envelope.data ?? [],
      meta: toPaginationMeta(envelope.meta),
    };
  }

  /** Create or upsert a subscriber. `POST /subscribers` (201). Idempotent on email. */
  async create(body: CreateSubscriberInput, options: RequestOptions = {}): Promise<Subscriber> {
    const envelope = await this.client.request<Subscriber>({
      method: 'POST',
      path: '/subscribers',
      body,
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });

    return envelope.data;
  }

  /** Fetch a single subscriber by id. `GET /subscribers/{id}`. */
  async get(id: number | string, options: RequestOptions = {}): Promise<Subscriber> {
    const envelope = await this.client.request<Subscriber>({
      method: 'GET',
      path: `/subscribers/${encodeURIComponent(String(id))}`,
      signal: options.signal,
    });

    return envelope.data;
  }

  /** Soft-unsubscribe a subscriber. `DELETE /subscribers/{id}`. Returns the updated record. */
  async delete(id: number | string, options: RequestOptions = {}): Promise<Subscriber> {
    const envelope = await this.client.request<Subscriber>({
      method: 'DELETE',
      path: `/subscribers/${encodeURIComponent(String(id))}`,
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });

    return envelope.data;
  }
}

/** Mailing list operations: `client.lists.*`. */
export class ListsResource {
  constructor(private readonly client: NewsletterClient) {}

  /** List all mailing lists. `GET /lists`. */
  async list(options: RequestOptions = {}): Promise<MailingList[]> {
    const envelope = await this.client.request<MailingList[]>({
      method: 'GET',
      path: '/lists',
      signal: options.signal,
    });

    return envelope.data ?? [];
  }
}

/** Campaign operations: `client.campaigns.*`. */
export class CampaignsResource {
  constructor(private readonly client: NewsletterClient) {}

  /** List all campaigns. `GET /campaigns`. */
  async list(options: RequestOptions = {}): Promise<Campaign[]> {
    const envelope = await this.client.request<Campaign[]>({
      method: 'GET',
      path: '/campaigns',
      signal: options.signal,
    });

    return envelope.data ?? [];
  }
}

/** Transactional message operations: `client.messages.*`. */
export class MessagesResource {
  constructor(private readonly client: NewsletterClient) {}

  /** Send a transactional message. `POST /messages` (201). At least one of `html`/`text` required. */
  async send(body: SendMessageInput, options: RequestOptions = {}): Promise<Message> {
    if (!body.html && !body.text) {
      throw new NewsletterError('messages.send requires at least one of `html` or `text`.', {
        status: 422,
        errors: { html: ['html or text is required'] },
      });
    }

    const envelope = await this.client.request<Message>({
      method: 'POST',
      path: '/messages',
      body,
      idempotencyKey: options.idempotencyKey,
      signal: options.signal,
    });

    return envelope.data;
  }

  /** Fetch a message (with its event timeline). `GET /messages/{id}`. */
  async get(id: number | string, options: RequestOptions = {}): Promise<Message> {
    const envelope = await this.client.request<Message>({
      method: 'GET',
      path: `/messages/${encodeURIComponent(String(id))}`,
      signal: options.signal,
    });

    return envelope.data;
  }
}
