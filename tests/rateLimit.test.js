import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { mockPrismaClient, resetMockPrisma } from './mockPrisma.js';

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockPrismaClient),
}));

// Fresh import in its own test file — vitest gives each test file an
// isolated module registry by default, so this app instance's in-memory
// rate limiter starts at zero, independent of anything auth.test.js did.
const { default: app } = await import('../server.js');

describe('auth rate limiting', () => {
  it('blocks login attempts once the per-IP limit is exceeded', async () => {
    resetMockPrisma();
    let lastStatus;
    // The configured limit is 20/window — fire one more than that against
    // the same route from the same (test) IP and confirm the excess
    // request gets blocked rather than silently allowed through forever.
    for (let i = 0; i < 21; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'bruteforce-target@example.com', password: `attempt-${i}` });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
