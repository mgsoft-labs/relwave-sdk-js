# @mgsoft/flow

Official TypeScript SDK for the **MGSoft Flow API** (`/api/v1`).

Manage subscribers, mailing lists and campaigns, and send transactional email — fully typed, ESM, `fetch`-based. Works in **Node 18+** (global `fetch`), Deno, and modern browsers.

## Installation

> **Yakında.** Paket henüz npm'e yayınlanmadı; aşağıdaki komut yayın sonrası geçerli olacak.

```bash
npm install @mgsoft/flow
```

## Quickstart

```ts
import { FlowClient } from '@mgsoft/flow';

const client = new FlowClient({
  apiKey: process.env.NEWSLETTER_API_KEY!, // "nl_xxxxx.secret"
  baseUrl: 'https://app.mgsoft.com.tr',     // optional — "/api/v1" is appended automatically
});

// Send a transactional message
const message = await client.messages.send({
  to: 'jane@example.com',
  subject: 'Welcome aboard, {{ name }}!',
  html: '<h1>Hi {{ name }}</h1><p>Glad to have you.</p>',
  variables: { name: 'Jane' },
  tags: ['welcome'],
});

console.log(message.id, message.message_id, message.status);
```

## Authentication

Every request is authenticated with your API key. By default it is sent as a
bearer token:

```
Authorization: Bearer nl_xxxxx.secret
```

To use the alternative header instead, set `useApiKeyHeader: true`:

```ts
const client = new FlowClient({
  apiKey: 'nl_xxxxx.secret',
  useApiKeyHeader: true, // sends `X-Api-Key: nl_xxxxx.secret`
});
```

## API

The client exposes four resources. All methods return parsed, typed data
(the response `data` payload) and throw a `FlowError` on failure.

### Subscribers

```ts
// List (paginated) — returns { data, meta: { current_page, last_page, per_page, total } }
const page = await client.subscribers.list({ page: 1, per_page: 50 });
console.log(page.data, page.meta.total);

// Create / upsert (idempotent on email)
const sub = await client.subscribers.create({
  email: 'new@example.com',
  first_name: 'New',
  status: 'confirmed',            // 'pending' | 'confirmed' | 'unsubscribed'
  attributes: { plan: 'pro' },
});

// Fetch one
const found = await client.subscribers.get(sub.id);

// Soft-unsubscribe (returns the updated record)
const removed = await client.subscribers.delete(sub.id);
```

### Lists

```ts
const lists = await client.lists.list(); // MailingList[]
```

### Campaigns

```ts
const campaigns = await client.campaigns.list(); // Campaign[]
```

### Messages

```ts
// Send (at least one of `html` / `text` is required)
const message = await client.messages.send({
  to: 'jane@example.com',
  subject: 'Your receipt',
  text: 'Thanks for your order.',
  from: 'billing@example.com',     // optional — falls back to account default
  reply_to: 'support@example.com', // optional
  metadata: { order_id: 4821 },    // optional, free-form
});

// Retrieve a message with its event timeline
const detail = await client.messages.get(message.id);
console.log(detail.status, detail.events);
```

## Error handling

Any non-2xx response, or a response with a populated `errors` map, throws a
typed `FlowError`. It carries the HTTP `status`, the structured `errors`
map (`field -> string[]`), and — for rate limits — `retryAfter` in seconds.

```ts
import { FlowClient, FlowError } from '@mgsoft/flow';

try {
  await client.messages.send({ to: 'bad', subject: 'Hi', text: 'yo' });
} catch (err) {
  if (err instanceof FlowError) {
    console.error('HTTP', err.status);
    console.error(err.toReadableString()); // "to: invalid email address"

    if (err.isValidationError) {
      // err.status === 422
      for (const [field, messages] of Object.entries(err.errors)) {
        console.error(field, messages);
      }
    }

    if (err.isRateLimited) {
      // err.status === 429 — back off and retry
      const waitSeconds = err.retryAfter ?? 1;
      await new Promise((r) => setTimeout(r, waitSeconds * 1000));
    }
  }
  throw err;
}
```

Convenience flags: `isUnauthorized` (401), `isForbidden` (403),
`isNotFound` (404), `isValidationError` (422), `isRateLimited` (429).

## Idempotency

Mutating calls (`subscribers.create`, `subscribers.delete`, `messages.send`)
accept an optional `idempotencyKey`. It is sent as the `X-Idempotency-Key`
header; re-sending the same key within 24h replays the original response
without re-running the operation. Use it to safely retry on network failure.

```ts
import { randomUUID } from 'node:crypto';

const key = randomUUID();

await client.messages.send(
  { to: 'jane@example.com', subject: 'Receipt', text: 'Thanks!' },
  { idempotencyKey: key },
);

// Safe to retry with the same key — no duplicate send.
await client.messages.send(
  { to: 'jane@example.com', subject: 'Receipt', text: 'Thanks!' },
  { idempotencyKey: key },
);
```

## Sandbox mode

API keys prefixed with `nl_test_` are **sandbox** keys. Transactional sends
are mocked — the API returns a realistic `sent` response (`sandbox: true`) but
no real email is delivered. Useful for integration tests.

```ts
const client = new FlowClient({ apiKey: 'nl_test_abcde.secret' });

console.log(client.isSandbox); // true

const result = await client.messages.send({
  to: 'jane@example.com',
  subject: 'Test',
  text: 'No real email is sent.',
});

console.log(result.sandbox); // true
```

## Configuration reference

| Option            | Type      | Default                     | Description                                          |
| ----------------- | --------- | --------------------------- | ---------------------------------------------------- |
| `apiKey`          | `string`  | — (required)                | API key, `nl_xxxxx.secret`.                          |
| `baseUrl`         | `string`  | `https://api.mgsoft.com.tr` | App origin; `/api/v1` is appended automatically.     |
| `useApiKeyHeader` | `boolean` | `false`                     | Send `X-Api-Key` instead of `Authorization: Bearer`. |
| `headers`         | `object`  | `{}`                        | Extra headers merged into every request.             |
| `timeoutMs`       | `number`  | `30000`                     | Per-request timeout (`0` disables).                  |
| `fetch`           | `FetchLike` | global `fetch`            | Custom `fetch` implementation (testing/polyfills).   |

## Response envelope

Every endpoint responds with `{ data, meta, errors }`. The SDK unwraps it for
you: success returns `data` (and `meta` for paginated lists), while a populated
`errors` map or HTTP ≥ 400 throws `FlowError`.

## Types

All request/response shapes are exported: `Subscriber`, `MailingList`,
`Campaign`, `Message`, `MessageStream`, `MessageEvent`, `Paginated<T>`,
`PaginationMeta`, `CreateSubscriberInput`, `SendMessageInput`,
`ListSubscribersParams`, `RequestOptions`, and more.

## License

MIT
