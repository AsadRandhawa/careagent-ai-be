import { vi } from 'vitest';

export const fakeUsers = [];
export const fakeTickets = [];
export const fakeChatSessions = [];
export const fakeLeads = [];
export const fakeMessages = [];
export const fakeAutoReplyChanges = [];
let nextId = 1;

export const mockPrismaClient = {
  autoReplyChange: {
    create: vi.fn(async ({ data }) => {
      const record = { id: `arc-${nextId++}`, createdAt: new Date(), ...data };
      fakeAutoReplyChanges.push(record);
      return record;
    }),
    createMany: vi.fn(async ({ data }) => {
      const list = Array.isArray(data) ? data : [data];
      for (const item of list) {
        fakeAutoReplyChanges.push({ id: `arc-${nextId++}`, createdAt: new Date(), ...item });
      }
      return { count: list.length };
    }),
    findMany: vi.fn(async ({ where } = {}) => {
      let filtered = [...fakeAutoReplyChanges];
      if (where?.userId) filtered = filtered.filter(x => x.userId === where.userId);
      return filtered;
    }),
  },
  user: {
    findUnique: vi.fn(async ({ where }) => {
      if (where.id) return fakeUsers.find(u => u.id === where.id) || null;
      if (where.email) return fakeUsers.find(u => u.email === where.email) || null;
      if (where.livechatToken) return fakeUsers.find(u => u.livechatToken === where.livechatToken) || null;
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
    upsert: vi.fn(async ({ create, update, where }) => {
      const existing = fakeTickets.find(t => t.id === where?.id || t.externalId === where?.externalId);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const ticket = { id: `test-ticket-${nextId++}`, receivedAt: new Date(), ...create };
      fakeTickets.push(ticket);
      return ticket;
    }),
    count: vi.fn(async ({ where } = {}) => {
      let filtered = [...fakeTickets];
      if (where?.userId) filtered = filtered.filter(t => t.userId === where.userId);
      if (where?.status) filtered = filtered.filter(t => t.status === where.status);
      if (where?.channel) {
        if (typeof where.channel === 'object' && where.channel.not) {
          filtered = filtered.filter(t => t.channel !== where.channel.not);
        } else if (typeof where.channel === 'string') {
          filtered = filtered.filter(t => t.channel === where.channel);
        }
      }
      if (where?.resolvedAt?.gte) {
        filtered = filtered.filter(t => t.resolvedAt && new Date(t.resolvedAt) >= where.resolvedAt.gte);
      }
      if (where?.updatedAt?.gte) {
        filtered = filtered.filter(t => t.updatedAt && new Date(t.updatedAt) >= where.updatedAt.gte);
      }
      return filtered.length;
    }),
    findMany: vi.fn(async ({ where, orderBy, take, select } = {}) => {
      let filtered = [...fakeTickets];
      if (where?.userId) filtered = filtered.filter(t => t.userId === where.userId);
      if (where?.status) filtered = filtered.filter(t => t.status === where.status);
      if (where?.channel) {
        if (typeof where.channel === 'object' && where.channel.not) {
          filtered = filtered.filter(t => t.channel !== where.channel.not);
        } else if (Array.isArray(where.channel?.in)) {
          filtered = filtered.filter(t => where.channel.in.includes(t.channel));
        } else if (typeof where.channel === 'string') {
          filtered = filtered.filter(t => t.channel === where.channel);
        }
      }
      if (where?.resolvedAt?.gte) {
        filtered = filtered.filter(t => t.resolvedAt && new Date(t.resolvedAt) >= where.resolvedAt.gte);
      }
      if (where?.updatedAt?.gte) {
        filtered = filtered.filter(t => t.updatedAt && new Date(t.updatedAt) >= where.updatedAt.gte);
      }
      if (orderBy?.receivedAt === 'asc') {
        filtered.sort((a, b) => new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime());
      } else if (orderBy?.updatedAt === 'desc') {
        filtered.sort((a, b) => new Date(b.updatedAt || b.receivedAt).getTime() - new Date(a.updatedAt || a.receivedAt).getTime());
      }
      if (take) filtered = filtered.slice(0, take);
      return filtered;
    }),
    groupBy: vi.fn(async () => []),
    update: vi.fn(async ({ where, data }) => {
      const ticket = fakeTickets.find(t => t.id === where.id);
      if (ticket) Object.assign(ticket, data);
      return ticket;
    }),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  chatSession: {
    findMany: vi.fn(async ({ where } = {}) => {
      let filtered = [...fakeChatSessions];
      if (where?.userId) filtered = filtered.filter(s => s.userId === where.userId);
      if (where?.status) filtered = filtered.filter(s => s.status === where.status);
      return filtered;
    }),
    findFirst: vi.fn(async ({ where } = {}) => {
      return fakeChatSessions.find(s => s.userId === where?.userId) || null;
    }),
    update: vi.fn(async ({ where, data }) => {
      const s = fakeChatSessions.find(x => x.id === where.id);
      if (s) Object.assign(s, data);
      return s;
    }),
  },
  lead: {
    findMany: vi.fn(async ({ where, orderBy } = {}) => {
      let filtered = [...fakeLeads];
      if (where?.userId) filtered = filtered.filter(l => l.userId === where.userId);
      if (where?.createdAt?.gte) {
        filtered = filtered.filter(l => new Date(l.createdAt) >= where.createdAt.gte);
      }
      if (orderBy?.updatedAt === 'desc') {
        filtered.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      }
      return filtered;
    }),
  },
  message: {
    findMany: vi.fn(async ({ where } = {}) => {
      return fakeMessages.filter(m => m.ticketId === where?.ticketId);
    }),
  },
  $executeRaw: vi.fn(async () => 0),
  $queryRaw: vi.fn(async () => []),
};

export function resetMockPrisma() {
  fakeUsers.length = 0;
  fakeTickets.length = 0;
  fakeChatSessions.length = 0;
  fakeLeads.length = 0;
  fakeMessages.length = 0;
  fakeAutoReplyChanges.length = 0;
  nextId = 1;
}
