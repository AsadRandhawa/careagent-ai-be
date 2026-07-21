import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { mockPrismaClient, resetMockPrisma } from './mockPrisma.js';

// vi.mock calls are hoisted to the top of the file by vitest, so this
// intercepts '@prisma/client' before server.js's `new PrismaClient()` runs
// during the dynamic import below — no real database is touched by this
// file.
vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockPrismaClient),
}));

const { default: app } = await import('../server.js');

beforeEach(() => {
  resetMockPrisma();
});

describe('POST /api/auth/register', () => {
  it('rejects an invalid email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', password: 'longenoughpassword' });
    expect(res.status).toBe(400);
  });

  it('rejects a password under 8 characters', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'shortpw@example.com', password: 'short' });
    expect(res.status).toBe(400);
  });

  it('registers a new user and returns a token', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'newuser@example.com', password: 'longenoughpassword' });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
  });

  it('rejects a duplicate email', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'dup@example.com', password: 'longenoughpassword' });
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'dup@example.com', password: 'longenoughpassword' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/login', () => {
  it('rejects a wrong password with a generic error (no user-enumeration hint)', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'wrongpw@example.com', password: 'correct-password-1' });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'wrongpw@example.com', password: 'incorrect-password' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('rejects a login for an email that was never registered, with the same generic error', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'never-registered@example.com', password: 'whatever123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid credentials');
  });

  it('logs in with correct credentials and returns a token that actually expires', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'gooduser@example.com', password: 'correct-password-1' });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'gooduser@example.com', password: 'correct-password-1' });

    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');

    // Regression guard for the original vulnerability: tokens used to be
    // signed with no `expiresIn` at all (valid forever) and, if
    // JWT_SECRET was ever unset, with a hardcoded public fallback string.
    // Decode (not verify — we're checking the token's own claims here)
    // and assert an expiry actually exists.
    const decoded = jwt.decode(res.body.token);
    expect(decoded).toHaveProperty('exp');
    expect(decoded.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

describe('GET /api/user/me', () => {
  it('rejects a request with no token', async () => {
    const res = await request(app).get('/api/user/me');
    expect(res.status).toBe(401);
  });

  it('rejects a request with a garbage token', async () => {
    const res = await request(app)
      .get('/api/user/me')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(403);
  });

  it('rejects a token signed with a different secret than the server is using', async () => {
    // Regression guard for the original hardcoded-fallback-secret bug: a
    // token forged with any secret other than the real JWT_SECRET must be
    // rejected, not silently accepted.
    const forgedToken = jwt.sign({ userId: 'someone-elses-id' }, 'a-different-secret-entirely', { expiresIn: '1h' });
    const res = await request(app)
      .get('/api/user/me')
      .set('Authorization', `Bearer ${forgedToken}`);
    expect(res.status).toBe(403);
  });
});
