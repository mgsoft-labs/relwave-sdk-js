/**
 * Dependency-free smoke example for @relwave/sdk.
 *
 * No test runner (vitest is not installed). It uses a mocked `fetch` to
 * exercise the envelope unwrapping, idempotency header, and typed errors,
 * then asserts with Node's built-in `assert`.
 *
 * Run after building:  npm run build && node test/example.mjs
 */
import assert from 'node:assert/strict';
import { RelwaveClient, RelwaveError } from '../dist/index.js';

/** Build a JSON Response shaped like the /api/v1 envelope. */
function envelope(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

// me() hits /me on the production API by default.
{
  let requested;
  const client = new RelwaveClient({
    apiKey: 'nl_abcde.secret',
    fetch: async (url) => {
      requested = String(url);

      return envelope({ data: { account: { slug: 'acme', name: 'Acme' }, sandbox: false }, meta: {}, errors: {} });
    },
  });

  const me = await client.me();
  assert.equal(requested, 'https://relwave.com/api/v1/me');
  assert.equal(me.account.slug, 'acme');
}

// 1. messages.send unwraps `data` and forwards the idempotency header.
{
  const calls = [];
  const client = new RelwaveClient({
    apiKey: 'nl_test_abcde.secret',
    baseUrl: 'https://app.test',
    fetch: async (url, init) => {
      calls.push({ url, init });

      return envelope({
        data: { id: 1, message_id: 'abc@app.test', to: 'jane@example.com', status: 'sent', sandbox: true },
        meta: { sandbox: true },
        errors: {},
      }, { status: 201 });
    },
  });

  assert.equal(client.isSandbox, true);

  const message = await client.messages.send(
    { to: 'jane@example.com', subject: 'Hi', text: 'yo' },
    { idempotencyKey: 'idem-123' },
  );

  assert.equal(message.id, 1);
  assert.equal(message.status, 'sent');
  assert.equal(calls[0].url, 'https://app.test/api/v1/messages');
  assert.equal(calls[0].init.headers['Authorization'], 'Bearer nl_test_abcde.secret');
  assert.equal(calls[0].init.headers['X-Idempotency-Key'], 'idem-123');
}

// 2. subscribers.list exposes pagination meta.
{
  const client = new RelwaveClient({
    apiKey: 'nl_live.secret',
    fetch: async () =>
      envelope({
        data: [{ id: 9, email: 'a@b.com', status: 'confirmed' }],
        meta: { current_page: 2, last_page: 5, per_page: 25, total: 120 },
        errors: {},
      }),
  });

  const page = await client.subscribers.list({ page: 2 });
  assert.equal(page.data[0].email, 'a@b.com');
  assert.equal(page.meta.total, 120);
  assert.equal(page.meta.last_page, 5);
}

// 3. A 422 envelope throws a typed RelwaveError.
{
  const client = new RelwaveClient({
    apiKey: 'nl_live.secret',
    fetch: async () =>
      envelope({ data: null, meta: {}, errors: { to: ['recipient is on the suppression list'] } }, { status: 422 }),
  });

  await assert.rejects(
    () => client.messages.send({ to: 'x@y.com', subject: 'Hi', text: 'yo' }),
    (err) => {
      assert.ok(err instanceof RelwaveError);
      assert.equal(err.status, 422);
      assert.equal(err.isValidationError, true);
      assert.deepEqual(err.errors.to, ['recipient is on the suppression list']);

      return true;
    },
  );
}

// 4. A 429 surfaces retryAfter from the Retry-After header.
{
  const client = new RelwaveClient({
    apiKey: 'nl_live.secret',
    fetch: async () =>
      envelope(
        { data: null, meta: { retry_after_seconds: 30 }, errors: { rate_limit: ['limit exceeded'] } },
        { status: 429, headers: { 'Retry-After': '30' } },
      ),
  });

  await assert.rejects(
    () => client.subscribers.list(),
    (err) => {
      assert.ok(err instanceof RelwaveError);
      assert.equal(err.isRateLimited, true);
      assert.equal(err.retryAfter, 30);

      return true;
    },
  );
}

console.log('All @relwave/sdk smoke checks passed.');
