/**
 * Shared type definitions for the Relwave API (/api/v1).
 *
 * These mirror the server-side response envelope and transformers exactly.
 * Every endpoint wraps its payload in {@link ApiEnvelope}:
 *
 *   { "data": ..., "meta": {...}, "errors": {...} }
 *
 * On success `errors` is empty; on failure (HTTP >= 400) `errors` is a
 * map of `field -> string[]` and the SDK throws a {@link RelwaveError}.
 */

/** Lifecycle status of a subscriber. */
export type SubscriberStatus = 'pending' | 'confirmed' | 'unsubscribed';

/** Delivery status of a transactional message. */
export type MessageStatus = 'sent' | 'failed' | 'delivered' | 'bounced' | 'complained' | (string & {});

/** Stream kind a message was sent through. */
export type StreamType = 'transactional' | 'broadcast' | (string & {});

/** Validation/runtime error map: field name -> list of human-readable messages. */
export type ErrorMap = Record<string, string[]>;

/** Free-form, JSON-serializable attribute bag. */
export type JsonObject = Record<string, unknown>;

/**
 * Canonical response envelope returned by every /api/v1 endpoint.
 *
 * @typeParam T - Shape of the `data` payload.
 */
export interface ApiEnvelope<T> {
  data: T;
  meta: Record<string, unknown>;
  errors: ErrorMap | Record<string, never>;
}

/** Pagination metadata returned by list endpoints. */
export interface PaginationMeta {
  current_page: number;
  last_page: number;
  per_page: number;
  total: number;
}

/**
 * A paginated list result. `data` holds the page of items and `meta`
 * carries the pagination cursor so callers can walk pages.
 *
 * @typeParam T - Item type contained in the page.
 */
export interface Paginated<T> {
  data: T[];
  meta: PaginationMeta;
}

/** A newsletter subscriber. */
export interface Subscriber {
  id: number;
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  status: SubscriberStatus;
  language?: string | null;
  engagement_tier?: string | null;
  created_at?: string | null;
  unsubscribed_at?: string | null;
  /** Present only when the request was made with a sandbox (`nl_test_`) key. */
  sandbox?: boolean;
}

/** The account that owns the API key, returned by `client.me()`. */
export interface Me {
  account: {
    slug: string;
    name: string;
  };
  sandbox: boolean;
}

/** A mailing list. */
export interface MailingList {
  id: number;
  name: string;
  description?: string | null;
  created_at?: string | null;
}

/** A campaign (broadcast). */
export interface Campaign {
  id: number;
  name: string;
  subject?: string | null;
  status: string;
  scheduled_at?: string | null;
  sent_at?: string | null;
  created_at?: string | null;
}

/** The stream a message was delivered through. */
export interface MessageStream {
  id: number;
  name: string;
  type: StreamType;
  slug?: string | null;
}

/** A single transactional message. */
export interface Message {
  id: number;
  message_id: string;
  to?: string | null;
  subject?: string | null;
  status: MessageStatus;
  stream?: MessageStream | null;
  metadata?: JsonObject | null;
  sent_at?: string | null;
  delivered_at?: string | null;
  failure_reason?: string | null;
  /** Present only when the request was made with a sandbox (`nl_test_`) key. */
  sandbox?: boolean;
  /** Present on `messages.get` — the chronological event timeline. */
  events?: MessageEvent[];
}

/** A delivery/engagement event attached to a message. */
export interface MessageEvent {
  id: number;
  type: string;
  data?: JsonObject | null;
  created_at?: string | null;
}

/** Query parameters for `subscribers.list`. */
export interface ListSubscribersParams {
  /** 1-based page number. */
  page?: number;
  /** Items per page (server clamps to a max of 100). */
  per_page?: number;
}

/** Request body for `subscribers.create`. */
export interface CreateSubscriberInput {
  email: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  language?: string;
  status?: SubscriberStatus;
  attributes?: JsonObject;
}

/** Request body for `messages.send`. At least one of `html` / `text` / `markdown` / `template_id` is required. */
export interface SendMessageInput {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  from?: string;
  from_name?: string;
  reply_to?: string;
  stream_id?: number;
  variables?: JsonObject;
  metadata?: JsonObject;
  /** Up to 10 tags. */
  tags?: string[];
  /** Markdown body, converted to HTML server-side. Used when `html` is absent. */
  markdown?: string;
  /** Template id; the body (if any) fills the template's `{{content}}` slot. */
  template_id?: number;
  /** Up to 10 files, 10 MB in total (decoded). */
  attachments?: MessageAttachment[];
}

/** A file attached to a transactional message. */
export interface MessageAttachment {
  filename: string;
  /** File contents, base64-encoded. */
  content: string;
  /** MIME type; guessed from the extension when omitted. */
  content_type?: string;
}

/** Per-call configuration shared by request helpers. */
export interface RequestOptions {
  /**
   * Sent as the `X-Idempotency-Key` header on mutating requests. Re-sending
   * the same key within 24h replays the original response without re-running
   * the operation.
   */
  idempotencyKey?: string;
  /** Abort signal to cancel the in-flight request. */
  signal?: AbortSignal;
}
