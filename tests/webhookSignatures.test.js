import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { mockPrismaClient } from './mockPrisma.js';

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockPrismaClient),
}));

const { isValidMetaSignature, isValidPaddleSignature } = await import('../server.js');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isValidMetaSignature (Facebook/Instagram webhooks)', () => {
  const secret = 'test-meta-app-secret';
  const payload = Buffer.from(JSON.stringify({ entry: [{ id: 'page123' }] }));

  function sign(body, withSecret = secret) {
    return 'sha256=' + crypto.createHmac('sha256', withSecret).update(body).digest('hex');
  }

  it('accepts a correctly signed request', () => {
    vi.stubEnv('META_APP_SECRET', secret);
    const req = { headers: { 'x-hub-signature-256': sign(payload) }, rawBody: payload };
    expect(isValidMetaSignature(req)).toBe(true);
  });

  it('rejects a request signed with the wrong secret', () => {
    vi.stubEnv('META_APP_SECRET', secret);
    const req = { headers: { 'x-hub-signature-256': sign(payload, 'wrong-secret') }, rawBody: payload };
    expect(isValidMetaSignature(req)).toBe(false);
  });

  it('rejects a request whose body does not match the signature (tampering)', () => {
    vi.stubEnv('META_APP_SECRET', secret);
    const tamperedBody = Buffer.from(JSON.stringify({ entry: [{ id: 'attacker-controlled' }] }));
    const req = { headers: { 'x-hub-signature-256': sign(payload) }, rawBody: tamperedBody };
    expect(isValidMetaSignature(req)).toBe(false);
  });

  it('FAILS CLOSED when the signature header is missing entirely (regression guard)', () => {
    // This is the exact bug that shipped originally: a missing header used
    // to fall through to "skip the check and process the event anyway."
    // It must now return false, not true, so the caller drops the event.
    vi.stubEnv('META_APP_SECRET', secret);
    const req = { headers: {}, rawBody: payload };
    expect(isValidMetaSignature(req)).toBe(false);
  });

  it('FAILS CLOSED when META_APP_SECRET is not configured (regression guard)', () => {
    vi.stubEnv('META_APP_SECRET', '');
    const req = { headers: { 'x-hub-signature-256': sign(payload) }, rawBody: payload };
    expect(isValidMetaSignature(req)).toBe(false);
  });

  it('FAILS CLOSED when rawBody was never captured', () => {
    vi.stubEnv('META_APP_SECRET', secret);
    const req = { headers: { 'x-hub-signature-256': sign(payload) }, rawBody: undefined };
    expect(isValidMetaSignature(req)).toBe(false);
  });
});

describe('isValidPaddleSignature (billing webhook)', () => {
  const secret = 'test-paddle-webhook-secret';
  const body = Buffer.from(JSON.stringify({ event_type: 'transaction.completed', data: {} }));

  function signedHeader(ts, rawBody = body, withSecret = secret) {
    const h1 = crypto.createHmac('sha256', withSecret).update(`${ts}:${rawBody.toString()}`).digest('hex');
    return `ts=${ts};h1=${h1}`;
  }

  it('accepts a correctly signed, fresh request', () => {
    vi.stubEnv('PADDLE_WEBHOOK_SECRET', secret);
    const ts = Math.floor(Date.now() / 1000);
    const req = { headers: { 'paddle-signature': signedHeader(ts) }, rawBody: body };
    expect(isValidPaddleSignature(req)).toBe(true);
  });

  it('rejects a signature computed with the wrong secret', () => {
    vi.stubEnv('PADDLE_WEBHOOK_SECRET', secret);
    const ts = Math.floor(Date.now() / 1000);
    const req = { headers: { 'paddle-signature': signedHeader(ts, body, 'wrong-secret') }, rawBody: body };
    expect(isValidPaddleSignature(req)).toBe(false);
  });

  it('rejects a stale signature outside the replay-protection window', () => {
    vi.stubEnv('PADDLE_WEBHOOK_SECRET', secret);
    const staleTs = Math.floor(Date.now() / 1000) - 600; // 10 minutes old, window is 5
    const req = { headers: { 'paddle-signature': signedHeader(staleTs) }, rawBody: body };
    expect(isValidPaddleSignature(req)).toBe(false);
  });

  it('rejects a malformed signature header', () => {
    vi.stubEnv('PADDLE_WEBHOOK_SECRET', secret);
    const req = { headers: { 'paddle-signature': 'not-the-right-format' }, rawBody: body };
    expect(isValidPaddleSignature(req)).toBe(false);
  });

  it('FAILS CLOSED when PADDLE_WEBHOOK_SECRET is not configured (regression guard for the original unsigned-webhook bug)', () => {
    // Original bug: this webhook had no verification at all, meaning
    // anyone who found the URL could POST a fake transaction.completed
    // event and grant a free plan upgrade. Must reject, not process.
    vi.stubEnv('PADDLE_WEBHOOK_SECRET', '');
    const ts = Math.floor(Date.now() / 1000);
    const req = { headers: { 'paddle-signature': signedHeader(ts) }, rawBody: body };
    expect(isValidPaddleSignature(req)).toBe(false);
  });

  it('FAILS CLOSED when rawBody is missing (regression guard for the raw-body/express.json ordering bug)', () => {
    // Original bug: this route relied on req.body after the global
    // express.json() parser had already consumed it, so signature checks
    // (and JSON.parse) were silently comparing against the wrong data.
    vi.stubEnv('PADDLE_WEBHOOK_SECRET', secret);
    const ts = Math.floor(Date.now() / 1000);
    const req = { headers: { 'paddle-signature': signedHeader(ts) }, rawBody: undefined };
    expect(isValidPaddleSignature(req)).toBe(false);
  });
});
