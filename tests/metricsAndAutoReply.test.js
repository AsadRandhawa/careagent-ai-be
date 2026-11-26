import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {
  mockPrismaClient,
  resetMockPrisma,
  fakeUsers,
  fakeTickets,
  fakeChatSessions,
  fakeLeads,
  fakeAutoReplyChanges,
} from './mockPrisma.js';

vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => mockPrismaClient),
}));

const { default: app, tryAutoReplyFacebookNative } = await import('../server.js');

const JWT_SECRET = process.env.JWT_SECRET || 'careagent-test-secret-long-enough-32-chars';

function createToken(userId, email = 'tester@careagent.test') {
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: '1h' });
}

beforeEach(() => {
  resetMockPrisma();
});

describe('Preferences & Per-Channel Auto-Reply Configuration', () => {
  it('rejects non-strict boolean values for auto-send flags with HTTP 400', async () => {
    const testUser = {
      id: 'test-user-1',
      email: 'user1@test.com',
      whatsappToken: 'wa-tok',
      whatsappPhoneNumberId: 'wa-phone-1',
    };
    fakeUsers.push(testUser);
    const token = createToken(testUser.id, testUser.email);

    const res = await request(app)
      .patch('/api/user/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ whatsappAutoSend: 'true' }); // string instead of boolean

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be a strict boolean/i);
  });

  it('rejects enabling auto-send for an unconnected channel with HTTP 409', async () => {
    const testUser = {
      id: 'test-user-unconnected',
      email: 'unconnected@test.com',
      whatsappToken: null,
      whatsappPhoneNumberId: null,
      facebookConnected: false,
      facebookPageToken: null,
      instagramConnected: false,
      livechatToken: null,
    };
    fakeUsers.push(testUser);
    const token = createToken(testUser.id, testUser.email);

    // Try enabling WhatsApp auto-send when not connected
    const resWa = await request(app)
      .patch('/api/user/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ whatsappAutoSend: true });
    expect(resWa.status).toBe(409);
    expect(resWa.body.error).toMatch(/WhatsApp is not connected/i);

    // Try enabling Facebook auto-send when not connected
    const resFb = await request(app)
      .patch('/api/user/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ facebookAutoSend: true });
    expect(resFb.status).toBe(409);
    expect(resFb.body.error).toMatch(/Facebook Messenger is not connected/i);

    // Try enabling Instagram auto-send when not connected
    const resIg = await request(app)
      .patch('/api/user/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ instagramAutoSend: true });
    expect(resIg.status).toBe(409);
    expect(resIg.body.error).toMatch(/Instagram DMs is not connected/i);

    // Try enabling LiveChat auto-send when not connected
    const resLc = await request(app)
      .patch('/api/user/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ livechatAutoSend: true });
    expect(resLc.status).toBe(409);
    expect(resLc.body.error).toMatch(/Web Live Chat is not connected/i);
  });

  it('allows enabling auto-send when the channel IS connected', async () => {
    const testUser = {
      id: 'test-user-connected',
      email: 'connected@test.com',
      whatsappToken: 'valid-wa-token',
      whatsappPhoneNumberId: 'valid-phone-id',
      facebookConnected: true,
      facebookPageToken: 'valid-fb-token',
      instagramConnected: true,
      livechatToken: 'valid-lc-token',
    };
    fakeUsers.push(testUser);
    const token = createToken(testUser.id, testUser.email);

    const res = await request(app)
      .patch('/api/user/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({
        whatsappAutoSend: true,
        facebookAutoSend: true,
        instagramAutoSend: true,
        livechatAutoSend: true,
      });

    expect(res.status).toBe(200);
    expect(testUser.whatsappAutoSend).toBe(true);
    expect(testUser.facebookAutoSend).toBe(true);
    expect(testUser.instagramAutoSend).toBe(true);
    expect(testUser.livechatAutoSend).toBe(true);
  });

  it('allows turning auto-send OFF immediately without 409 even if disconnected', async () => {
    const testUser = {
      id: 'test-user-turnoff',
      email: 'turnoff@test.com',
      facebookAutoSend: true,
      facebookConnected: false,
    };
    fakeUsers.push(testUser);
    const token = createToken(testUser.id, testUser.email);

    const res = await request(app)
      .patch('/api/user/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ facebookAutoSend: false });

    expect(res.status).toBe(200);
    expect(testUser.facebookAutoSend).toBe(false);
  });

  it('persists AutoReplyChange records on preferences update and on disconnects', async () => {
    const testUser = {
      id: 'test-user-audit',
      email: 'audit@test.com',
      whatsappToken: 'wa-tok',
      whatsappPhoneNumberId: 'wa-phone',
      facebookConnected: true,
      facebookPageToken: 'fb-tok',
      facebookAutoSend: true,
      instagramConnected: true,
      instagramAutoSend: true,
    };
    fakeUsers.push(testUser);
    const token = createToken(testUser.id, testUser.email);

    // Toggle WhatsApp autoSend ON via preferences
    await request(app)
      .patch('/api/user/preferences')
      .set('Authorization', `Bearer ${token}`)
      .send({ whatsappAutoSend: true });

    expect(fakeAutoReplyChanges.some(c => c.userId === testUser.id && c.channel === 'whatsappAutoSend' && c.enabled === true)).toBe(true);

    // Disconnect Facebook (resets both FB and IG auto-send to false)
    await request(app)
      .delete('/api/user/disconnect/facebook')
      .set('Authorization', `Bearer ${token}`);

    expect(fakeAutoReplyChanges.some(c => c.userId === testUser.id && c.channel === 'facebookAutoSend' && c.enabled === false)).toBe(true);
    expect(fakeAutoReplyChanges.some(c => c.userId === testUser.id && c.channel === 'instagramAutoSend' && c.enabled === false)).toBe(true);
  });
});

describe('DELETE /api/user/disconnect/livechat endpoint', () => {
  it('rejects unauthenticated requests with HTTP 401', async () => {
    const res = await request(app).delete('/api/user/disconnect/livechat');
    expect(res.status).toBe(401);
  });

  it('disconnects livechat scoped strictly to logged-in tenant and writes AutoReplyChange audit row', async () => {
    const tenantA = {
      id: 'tenant-a',
      email: 'a@careagent.test',
      livechatToken: 'token-a',
      livechatEnabled: true,
      livechatAutoSend: true,
    };
    const tenantB = {
      id: 'tenant-b',
      email: 'b@careagent.test',
      livechatToken: 'token-b',
      livechatEnabled: true,
      livechatAutoSend: true,
    };
    fakeUsers.push(tenantA, tenantB);

    const tokenA = createToken(tenantA.id, tenantA.email);

    const res = await request(app)
      .delete('/api/user/disconnect/livechat')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Tenant A is disconnected and auto-send is turned off
    expect(tenantA.livechatToken).toBeNull();
    expect(tenantA.livechatEnabled).toBe(false);
    expect(tenantA.livechatAutoSend).toBe(false);

    // Tenant B remains completely untouched (strict tenant scoping)
    expect(tenantB.livechatToken).toBe('token-b');
    expect(tenantB.livechatEnabled).toBe(true);
    expect(tenantB.livechatAutoSend).toBe(true);

    // AutoReplyChange record created for tenant A
    const auditRecord = fakeAutoReplyChanges.find(c => c.userId === 'tenant-a' && c.channel === 'livechatAutoSend');
    expect(auditRecord).toBeDefined();
    expect(auditRecord.enabled).toBe(false);
  });
});

describe('Dashboard Metrics & Details Endpoint Alignment (All 7 Metrics)', () => {
  const userId = 'stats-test-tenant';
  let token;

  beforeEach(() => {
    const user = { id: userId, email: 'stats@test.com' };
    fakeUsers.push(user);
    token = createToken(userId, user.email);
  });

  // METRIC 1: Open Tickets
  it('Metric 1: Open Tickets card count strictly equals details modal count', async () => {
    const now = new Date();
    // 3 WhatsApp open tickets
    fakeTickets.push(
      { id: 't1', userId, channel: 'whatsapp', status: 'new', customerName: 'User 1', receivedAt: new Date(now - 3000) },
      { id: 't2', userId, channel: 'whatsapp', status: 'new', customerName: 'User 2', receivedAt: new Date(now - 2000) },
      { id: 't3', userId, channel: 'whatsapp', status: 'new', customerName: 'User 3', receivedAt: new Date(now - 1000) }
    );
    // 2 Facebook open tickets
    fakeTickets.push(
      { id: 't4', userId, channel: 'facebook', status: 'new', customerName: 'User 4', receivedAt: new Date(now - 4000) },
      { id: 't5', userId, channel: 'facebook', status: 'new', customerName: 'User 5', receivedAt: new Date(now - 5000) }
    );
    // 1 waiting LiveChat session
    fakeChatSessions.push({
      id: 's1',
      userId,
      status: 'active',
      visitorName: 'Visitor 1',
      escalated: false,
      messages: [{ role: 'visitor', createdAt: new Date(now - 1500) }],
    });

    const statsRes = await request(app)
      .get('/api/tickets/stats?days=30')
      .set('Authorization', `Bearer ${token}`);
    expect(statsRes.status).toBe(200);

    const detailsRes = await request(app)
      .get('/api/tickets/stats/details?metric=open&days=30')
      .set('Authorization', `Bearer ${token}`);
    expect(detailsRes.status).toBe(200);

    // Expected: 5 ticket rows + 1 livechat session = 6 open tickets
    expect(statsRes.body.openTickets).toBe(6);
    expect(detailsRes.body.count).toBe(6);
    expect(statsRes.body.openTickets).toBe(detailsRes.body.count);
    expect(detailsRes.body.items.length).toBe(6);

    // Oldest waiting first
    const oldestItem = detailsRes.body.items[0];
    expect(oldestItem.id).toBe('t5'); // 5000ms ago is oldest
  });

  // METRIC 2: Avg Resolution Time
  it('Metric 2: Avg Resolution Time card value and sample count strictly equal details modal', async () => {
    const now = Date.now();
    // 6 resolved tickets with known durations
    const durationsMins = [10, 20, 30, 40, 50, 60];
    durationsMins.forEach((mins, i) => {
      const received = new Date(now - (mins + 10) * 60 * 1000);
      const resolved = new Date(now - 10 * 60 * 1000);
      fakeTickets.push({
        id: `res-${i}`,
        userId,
        channel: i % 2 === 0 ? 'whatsapp' : 'facebook',
        status: 'resolved',
        receivedAt: received,
        resolvedAt: resolved,
        customerName: `Customer ${i}`,
      });
    });

    const statsRes = await request(app)
      .get('/api/tickets/stats?days=30')
      .set('Authorization', `Bearer ${token}`);
    expect(statsRes.status).toBe(200);

    const detailsRes = await request(app)
      .get('/api/tickets/stats/details?metric=resolution&days=30')
      .set('Authorization', `Bearer ${token}`);
    expect(detailsRes.status).toBe(200);

    expect(detailsRes.body.count).toBe(6);
    expect(statsRes.body.avgResolutionTime).toBe(detailsRes.body.avgResolutionTime);
    expect(detailsRes.body.slowestTickets.length).toBe(6);
    // Slowest ticket first (60 mins formatted as 1.0 hrs)
    expect(detailsRes.body.slowestTickets[0].durationFormatted).toBe('1.0 hrs');
    expect(detailsRes.body.calculationExplanation).toBe('Counted from when the message arrived to when the ticket was resolved.');
    expect(detailsRes.body.calculationExplanation).not.toMatch(/receivedAt|resolvedAt|database|model/i);
  });

  it('Metric 2b: computes Avg Resolution Time when Resolved (30d) is exactly 1 (no dash) and uses plain wording', async () => {
    const singleUserId = 'single-res-tenant';
    fakeUsers.push({ id: singleUserId, email: 'single@careagent.test' });
    const singleToken = createToken(singleUserId, 'single@careagent.test');

    const now = Date.now();
    // Exactly 1 resolved ticket taking 15 minutes
    fakeTickets.push({
      id: 'single-res-1',
      userId: singleUserId,
      channel: 'whatsapp',
      status: 'resolved',
      receivedAt: new Date(now - 20 * 60 * 1000),
      resolvedAt: new Date(now - 5 * 60 * 1000), // 15 min duration
      customerName: 'Single User',
    });

    const statsRes = await request(app)
      .get('/api/tickets/stats?days=30')
      .set('Authorization', `Bearer ${singleToken}`);
    expect(statsRes.status).toBe(200);

    const detailsRes = await request(app)
      .get('/api/tickets/stats/details?metric=resolution&days=30')
      .set('Authorization', `Bearer ${singleToken}`);
    expect(detailsRes.status).toBe(200);

    // Shows 15 min instead of "—"
    expect(statsRes.body.resolvedThisPeriod).toBe(1);
    expect(statsRes.body.avgResolutionTime).toBe('15 min');
    expect(detailsRes.body.count).toBe(1);
    expect(detailsRes.body.avgResolutionTime).toBe('15 min');
    expect(detailsRes.body.calculationExplanation).toBe('Counted from when the message arrived to when the ticket was resolved.');
  });

  // METRIC 3: Escalation Rate
  it('Metric 3: Escalation Rate card percentage and ratio counts strictly equal details modal', async () => {
    const now = new Date();
    // 4 escalated tickets
    for (let i = 0; i < 4; i++) {
      fakeTickets.push({
        id: `esc-${i}`,
        userId,
        channel: 'whatsapp',
        status: 'escalated',
        escalationReason: `Uncertain intent ${i}`,
        receivedAt: now,
        updatedAt: now,
      });
    }
    // 6 resolved tickets (total decided = 10 -> 40.0%)
    for (let i = 0; i < 6; i++) {
      fakeTickets.push({
        id: `res-item-${i}`,
        userId,
        channel: 'whatsapp',
        status: 'resolved',
        receivedAt: now,
        resolvedAt: now,
        updatedAt: now,
      });
    }

    const statsRes = await request(app)
      .get('/api/tickets/stats?days=30')
      .set('Authorization', `Bearer ${token}`);
    expect(statsRes.status).toBe(200);

    const detailsRes = await request(app)
      .get('/api/tickets/stats/details?metric=escalation&days=30')
      .set('Authorization', `Bearer ${token}`);
    expect(detailsRes.status).toBe(200);

    expect(statsRes.body.escalationRate).toBe('40.0%');
    expect(detailsRes.body.escalationRate).toBe('40.0%');
    expect(detailsRes.body.escalatedCount).toBe(4);
    expect(detailsRes.body.totalDecided).toBe(10);
    expect(detailsRes.body.ratioText).toBe('4 of 10');
    expect(detailsRes.body.items.length).toBe(4);
  });

  // METRICS 4-7: Lead Report Cards
  it('Metrics 4-7: Lead Report card counts strictly equal modal counts via shared predicates', async () => {
    const seededLeads = [
      { id: 'l1', userId, name: 'Alice', email: 'alice@example.com', interestLevel: 'Hot', leadStatus: 'New', createdAt: new Date() },
      { id: 'l2', userId, name: 'Bob', email: null, interestLevel: 'Hot', leadStatus: 'Fee Submitted', createdAt: new Date() },
      { id: 'l3', userId, name: 'Charlie', email: 'charlie@test.org', interestLevel: 'Warm', leadStatus: 'Nourishing', createdAt: new Date() },
      { id: 'l4', userId, name: 'Diana', email: 'diana@domain.com', interestLevel: 'Cold', leadStatus: 'Lost', createdAt: new Date() },
      { id: 'l5', userId, name: 'Eve', email: null, interestLevel: 'Not Eligible', leadStatus: 'New', createdAt: new Date() },
    ];
    fakeLeads.push(...seededLeads);

    const LEAD_PREDICATES = {
      total: (_l) => true,
      hot: (l) => l.interestLevel === 'Hot',
      email: (l) => Boolean(l.email && l.email.trim()),
      feeSubmitted: (l) => l.leadStatus === 'Fee Submitted',
    };

    const res = await request(app)
      .get('/api/leads?days=30')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const leads = res.body;

    // Total Leads (Metric 4)
    const totalCardCount = leads.filter(LEAD_PREDICATES.total).length;
    const totalModalCount = seededLeads.filter(LEAD_PREDICATES.total).length;
    expect(totalCardCount).toBe(5);
    expect(totalCardCount).toBe(totalModalCount);

    // Hot Leads (Metric 5)
    const hotCardCount = leads.filter(LEAD_PREDICATES.hot).length;
    const hotModalCount = seededLeads.filter(LEAD_PREDICATES.hot).length;
    expect(hotCardCount).toBe(2);
    expect(hotCardCount).toBe(hotModalCount);

    // With Email (Metric 6)
    const emailCardCount = leads.filter(LEAD_PREDICATES.email).length;
    const emailModalCount = seededLeads.filter(LEAD_PREDICATES.email).length;
    expect(emailCardCount).toBe(3);
    expect(emailCardCount).toBe(emailModalCount);

    // Fee Submitted (Metric 7)
    const feeCardCount = leads.filter(LEAD_PREDICATES.feeSubmitted).length;
    const feeModalCount = seededLeads.filter(LEAD_PREDICATES.feeSubmitted).length;
    expect(feeCardCount).toBe(1);
    expect(feeCardCount).toBe(feeModalCount);
  });
});

describe('Auto-Reply Execution on TEST Account', () => {
  it('does NOT trigger auto-reply when autoSend flag is OFF', async () => {
    const testUser = {
      id: 'test-auto-off',
      email: 'autooff@test.com',
      facebookAutoSend: false, // OFF
      facebookEnabled: true,
      facebookConnected: true,
      facebookPageId: 'page_123',
      facebookPageToken: 'page_token_123',
    };
    fakeUsers.push(testUser);

    const ticket = {
      id: 'ticket-auto-1',
      customerName: 'Test Customer',
      threadId: 'thread_123',
    };

    // Spy on global.fetch to ensure no Meta API call is made
    const fetchSpy = vi.spyOn(global, 'fetch');

    await tryAutoReplyFacebookNative(testUser, ticket, 'Hello CareAgent');

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('triggers outbound send when autoSend flag is ON (logs HTTP status only)', async () => {
    const testUser = {
      id: 'test-auto-on',
      email: 'autoon@test.com',
      facebookAutoSend: true, // ON
      facebookEnabled: true,
      facebookConnected: true,
      facebookPageId: 'page_456',
      facebookPageToken: 'page_token_456',
    };
    fakeUsers.push(testUser);

    const ticket = {
      id: 'ticket-auto-2',
      customerName: 'Test Customer 2',
      threadId: 'thread_456',
    };

    // Mock global.fetch to intercept outbound call to graph.facebook.com
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url) => {
      if (typeof url === 'string' && url.includes('graph.facebook.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ message_id: 'mid.test.123' }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    await tryAutoReplyFacebookNative(testUser, ticket, 'Need assistance with pricing');

    // Outbound send must be called when flag is ON
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
