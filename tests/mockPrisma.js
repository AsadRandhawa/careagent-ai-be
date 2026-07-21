import { vi } from 'vitest';

// A minimal in-memory stand-in for the parts of Prisma that the auth routes
// actually touch. Not a general-purpose Prisma mock — just enough to let
// register/login run their real logic (including real bcrypt hashing) end
// to end without a live database.
export const fakeUsers = [];
let nextId = 1;

export const mockPrismaClient = {
  user: {
    findUnique: vi.fn(async ({ where }) => {
      if (where.id) return fakeUsers.find(u => u.id === where.id) || null;
      if (where.email) return fakeUsers.find(u => u.email === where.email) || null;
      return null;
    }),
    create: vi.fn(async ({ data }) => {
      const user = { id: `test-user-${nextId++}`, plan: 'startup', ...data };
      fakeUsers.push(user);
      return user;
    }),
    update: vi.fn(async ({ where, data }) => {
      const user = fakeUsers.find(u => u.id === where.id);
      if (!user) throw new Error('Record to update not found.');
      Object.assign(user, data);
      return user;
    }),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  ticket: {
    upsert: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  chatSession: {
    update: vi.fn(async () => ({})),
    findFirst: vi.fn(async () => null),
  },
  $executeRaw: vi.fn(async () => 0),
  $queryRaw: vi.fn(async () => []),
};

export function resetMockPrisma() {
  fakeUsers.length = 0;
  nextId = 1;
  for (const value of Object.values(mockPrismaClient)) {
    if (typeof value?.mockClear === 'function') {
      value.mockClear();
    } else if (typeof value === 'object' && value !== null) {
      for (const fn of Object.values(value)) {
        if (typeof fn?.mockClear === 'function') fn.mockClear();
      }
    }
  }
}
