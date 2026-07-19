import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';
import { google } from 'googleapis';
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';

dotenv.config();

const app = express();
app.use(cors({
  origin: [
    'https://careagent.flint-sol.com',
    'https://careagent-ai-fe-production.up.railway.app',
    'http://localhost:3000',
    'http://localhost:5173',
  ],
  credentials: true,
}));
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; },
}));


const prisma = new PrismaClient();

const openai = new OpenAI({
  apiKey: process.env.VITE_OPENAI_API_KEY || process.env.OPENAI_API_KEY
});

// ── Auth middleware ────────────────────────────────────────
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token == null) return res.sendStatus(401);
  jwt.verify(token, process.env.JWT_SECRET || 'secret_key', (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// ── Google OAuth ───────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/auth/google/callback'
);

// ── Helper: build OAuth client per user ───────────────────
const getUserOAuth = (tokens) => {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/auth/google/callback'
  );
  client.setCredentials(tokens);
  return client;
};

// ═══════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) return res.status(400).json({ error: 'User already exists' });
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, password: hashedPassword, documents: [] }
    });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || 'secret_key');
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: 'Failed to register' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(400).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET || 'secret_key');
    res.json({ token });
  } catch (err) {
    res.status(500).json({ error: 'Failed to login' });
  }
});

// ═══════════════════════════════════════════════════════════
// USER ROUTES
// ═══════════════════════════════════════════════════════════

app.get('/api/user/me', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: {
        id: true, email: true, documents: true,
        businessIdentity: true, brandVoice: true,
        googleTokens: true, gmailEnabled: true,
        aiAutoDrafting: true, autoClassification: true, sentimentTracking: true,
        lastSeenInboxAt: true, lastSeenEscalAt: true,
        facebookConnected: true, facebookPageName: true, facebookEnabled: true,
      }
    });
    res.set('Cache-Control', 'no-store');
    res.json({
      id: user.id,
      email: user.email,
      googleConnected:    !!user.googleTokens,
      facebookConnected:  user.facebookConnected  ?? false,
      facebookPageName:   user.facebookPageName    ?? null,
      facebookEnabled:    user.facebookEnabled     ?? true,
      gmailEnabled:       user.gmailEnabled       ?? true,
      aiAutoDrafting:     user.aiAutoDrafting     ?? true,
      autoClassification: user.autoClassification ?? true,
      sentimentTracking:  user.sentimentTracking  ?? false,
      lastSeenInboxAt:    user.lastSeenInboxAt,
      lastSeenEscalAt:    user.lastSeenEscalAt,
      knowledgeBase: {
        documents: user.documents,
        businessIdentity: user.businessIdentity,
        brandVoice: user.brandVoice
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

app.post('/api/user/knowledge-base', authenticateToken, async (req, res) => {
  try {
    const { documents, businessIdentity, brandVoice } = req.body;
    await prisma.user.update({
      where: { id: req.user.userId },
      data: { documents: documents || [], businessIdentity, brandVoice }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update knowledge base' });
  }
});

// Update user preferences (gmailEnabled, lastSeenInboxAt, lastSeenEscalAt)
app.patch('/api/user/preferences', authenticateToken, async (req, res) => {
  try {
    const { gmailEnabled, lastSeenInboxAt, lastSeenEscalAt,
            aiAutoDrafting, autoClassification, sentimentTracking, facebookEnabled } = req.body;
    const data = {};
    if (gmailEnabled          !== undefined) data.gmailEnabled          = gmailEnabled;
    if (facebookEnabled       !== undefined) data.facebookEnabled       = facebookEnabled;
    if (aiAutoDrafting        !== undefined) data.aiAutoDrafting        = aiAutoDrafting;
    if (autoClassification    !== undefined) data.autoClassification    = autoClassification;
    if (sentimentTracking     !== undefined) data.sentimentTracking     = sentimentTracking;
    if (lastSeenInboxAt       !== undefined) data.lastSeenInboxAt       = new Date(lastSeenInboxAt);
    if (lastSeenEscalAt       !== undefined) data.lastSeenEscalAt       = new Date(lastSeenEscalAt);
    await prisma.user.update({ where: { id: req.user.userId }, data });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// Disconnect Gmail
app.delete('/api/user/disconnect/gmail', authenticateToken, async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.userId },
      data: { googleTokens: null, gmailEnabled: true }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect Gmail.' });
  }
});

// Disconnect Facebook
app.delete('/api/user/disconnect/facebook', authenticateToken, async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.userId },
      data: { facebookPageId: null, facebookPageName: null, facebookPageToken: null, facebookConnected: false, facebookEnabled: true }
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect Facebook.' });
  }
});

// ═══════════════════════════════════════════════════════════
// GOOGLE OAUTH
// ═══════════════════════════════════════════════════════════

app.get('/api/auth/google', (req, res) => {
  const token = req.query.token;
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    state: token || ''
  });
  res.redirect(url);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  try {
    const { tokens } = await oauth2Client.getToken(code);
    if (state) {
      try {
        const decoded = jwt.verify(state, process.env.JWT_SECRET || 'secret_key');
        await prisma.user.update({
          where: { id: decoded.userId },
          data: { googleTokens: tokens }
        });
      } catch (err) {
        console.error('Failed to link Google account:', err);
      }
    }
    res.redirect(`${frontendUrl}/channels?connected=gmail`);
  } catch (error) {
    console.error('Google Auth Error:', error);
    res.redirect(`${frontendUrl}/channels?error=auth_failed`);
  }
});

// ═══════════════════════════════════════════════════════════
// FACEBOOK OAUTH (Connect Page)
// ═══════════════════════════════════════════════════════════

app.get('/api/auth/facebook', (req, res) => {
  const token = req.query.token;
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: process.env.FACEBOOK_REDIRECT_URI,
    state: token || '',
    scope: 'pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement,business_management',
    response_type: 'code',
  });
  res.redirect(`https://www.facebook.com/v19.0/dialog/oauth?${params}`);
});

app.get('/api/auth/facebook/callback', async (req, res) => {
  const { code, state } = req.query;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  try {
    if (!code) throw new Error('No code returned from Facebook');

    // 1. Exchange code for a short-lived user token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?` +
      new URLSearchParams({
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri: process.env.FACEBOOK_REDIRECT_URI,
        code,
      })
    );
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error(tokenData.error?.message || 'Token exchange failed');

    // 2. Exchange for a long-lived user token (~60 days)
    const longLivedRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?` +
      new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        fb_exchange_token: tokenData.access_token,
      })
    );
    const longLivedData = await longLivedRes.json();
    const longLivedToken = longLivedData.access_token || tokenData.access_token;

    // 2b. Verify the connecting account is tied to a real Business Manager account.
    // This is a genuine business_management-scoped call — best-effort only, never
    // blocks the connect flow if it fails (e.g. user has no Business Manager yet).
    try {
      const bizRes = await fetch(
        `https://graph.facebook.com/v19.0/me/businesses?access_token=${longLivedToken}`
      );
      const bizData = await bizRes.json();
      console.log('[Facebook] business_management verification:', JSON.stringify(bizData));
    } catch (bizErr) {
      console.warn('[Facebook] business_management verification skipped:', bizErr.message);
    }

    // 3. Get the Pages this user manages
    const pagesRes = await fetch(
      `https://graph.facebook.com/v19.0/me/accounts?access_token=${longLivedToken}`
    );
    const pagesData = await pagesRes.json();
    const page = pagesData.data?.[0]; // first Page — extend to a picker later if user has multiple
    if (!page) throw new Error('No Facebook Page found for this account');

    // 4. Subscribe the app to this Page's webhooks
    const subRes = await fetch(`https://graph.facebook.com/v19.0/${page.id}/subscribed_apps`, {
      method: 'POST',
      body: new URLSearchParams({
        subscribed_fields: 'messages,messaging_postbacks',
        access_token: page.access_token,
      }),
    });
    const subData = await subRes.json();
    console.log('[Facebook] Page webhook subscribe result:', JSON.stringify(subData));
    if (!subData.success) {
      console.error('[Facebook] Page did NOT subscribe to webhooks — messages will not be delivered:', subData);
    }

    // 5. Save to DB
    if (state) {
      const decoded = jwt.verify(state, process.env.JWT_SECRET || 'secret_key');
      await prisma.user.update({
        where: { id: decoded.userId },
        data: {
          facebookPageId: page.id,
          facebookPageName: page.name,
          facebookPageToken: page.access_token,
          facebookConnected: true,
        },
      });
    }

    res.redirect(`${frontendUrl}/channels?connected=facebook`);
  } catch (error) {
    console.error('Facebook Auth Error:', error.message || error);
    res.redirect(`${frontendUrl}/channels?error=auth_failed`);
  }
});

// ═══════════════════════════════════════════════════════════
// GMAIL ROUTES
// ═══════════════════════════════════════════════════════════

// Fetch live emails from Gmail inbox
app.get('/api/gmail/emails', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user?.googleTokens) return res.status(400).json({ error: 'Gmail not connected.' });
    if (user.gmailEnabled === false) return res.json([]);

    const gmail = google.gmail({ version: 'v1', auth: getUserOAuth(user.googleTokens) });
    const response = await gmail.users.messages.list({ userId: 'me', maxResults: 20, q: 'in:inbox' });
    const messages = response.data.messages || [];
    const tickets = [];

    for (const msg of messages) {
      const email = await gmail.users.messages.get({ userId: 'me', id: msg.id });
      const headers = email.data.payload.headers;
      const subject   = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
      const fromHeader = headers.find(h => h.name === 'From')?.value || 'Unknown';
      const nameMatch  = fromHeader.match(/^(.*?)\s*</);
      const emailMatch = fromHeader.match(/<([^>]+)>/);
      const customerName = nameMatch ? nameMatch[1].replace(/"/g, '').trim() : fromHeader;
      const emailAddress = emailMatch ? emailMatch[1] : fromHeader;
      const dateHeader   = headers.find(h => h.name === 'Date')?.value;
      const createdAt    = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();
      const timeString   = dateHeader ? new Date(dateHeader).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Just now';

      // Check if this ticket exists in DB to get its status
      const dbTicket = await prisma.ticket.findUnique({
        where: { userId_externalId: { userId: user.id, externalId: msg.id } }
      });

      tickets.push({
        id:           msg.id,
        threadId:     email.data.threadId,
        customerName: customerName || 'Unknown',
        initials:     (customerName || 'U').substring(0, 2).toUpperCase(),
        subject,
        time:         timeString,
        createdAt,
        status:       (dbTicket?.status === 'resolved') ? 'resolved' : (dbTicket?.status === 'escalated') ? 'escalated' : 'new',
        hasDraft:     true,
        avatarVariant: ['blue', 'purple', 'green', 'orange'][Math.floor(Math.random() * 4)],
        email:        emailAddress,
        category:     dbTicket?.category || 'General',
        content:      email.data.snippet,
        sentiment:    dbTicket?.sentiment || 'Neutral',
      });
    }
    res.json(tickets);
  } catch (error) {
    console.error('Failed to fetch emails:', error);
    res.status(500).json({ error: 'Failed to fetch emails.' });
  }
});

// Dismiss escalation — reset ticket to new or in_progress
app.post('/api/tickets/dismiss', authenticateToken, async (req, res) => {
  try {
    const { ticketId, status = 'new' } = req.body;
    await prisma.ticket.updateMany({
      where: { userId: req.user.userId, externalId: ticketId },
      data: { status, escalationReason: null }
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Dismiss error:', err.message);
    res.status(500).json({ error: 'Failed to dismiss ticket' });
  }
});

// ── Paddle Webhook ───────────────────────────────────────
app.post('/api/paddle/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const payload = JSON.parse(req.body.toString());
    const eventType = payload.event_type;

    if (eventType === 'transaction.completed' || eventType === 'subscription.activated') {
      const customerEmail = payload.data?.customer?.email || payload.data?.billing_details?.email;
      if (customerEmail) {
        await prisma.user.updateMany({
          where: { email: customerEmail },
          data: { plan: 'growth', stripeSubscriptionId: payload.data?.subscription_id || null }
        });
        console.log('Paddle plan updated for:', customerEmail);
      }
    }

    if (eventType === 'subscription.canceled') {
      const customerEmail = payload.data?.customer?.email;
      if (customerEmail) {
        await prisma.user.updateMany({
          where: { email: customerEmail },
          data: { plan: 'startup' }
        });
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Paddle webhook error:', err.message);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Manual escalate — persist to DB
app.post('/api/tickets/escalate', authenticateToken, async (req, res) => {
  try {
    const { ticketId, subject, customerName, customerEmail, content, threadId, reason } = req.body;
    await prisma.ticket.upsert({
      where: { userId_externalId: { userId: req.user.userId, externalId: ticketId } },
      update: { status: 'escalated', escalationReason: reason || 'Manually escalated' },
      create: {
        userId:           req.user.userId,
        externalId:       ticketId,
        threadId:         threadId || null,
        customerName:     customerName || 'Unknown',
        customerEmail:    customerEmail || 'unknown@email.com',
        subject:          subject || 'No Subject',
        content:          content || '',
        channel:          'gmail',
        status:           'escalated',
        escalationReason: reason || 'Manually escalated',
      }
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Escalate error:', err.message);
    res.status(500).json({ error: 'Failed to escalate ticket' });
  }
});

// Send reply and mark ticket as resolved
app.post('/api/gmail/reply', authenticateToken, async (req, res) => {
  try {
    const { to, subject, body, threadId, ticketExternalId } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user?.googleTokens) return res.status(400).json({ error: 'Gmail not connected.' });

    const gmail = google.gmail({ version: 'v1', auth: getUserOAuth(user.googleTokens) });

    const rawMessage = Buffer.from(
      `To: ${to}\r\nSubject: Re: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
    ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

    await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: rawMessage, threadId }
    });

    // Upsert the ticket in DB and mark as resolved
    if (ticketExternalId) {
      await prisma.ticket.upsert({
        where: { userId_externalId: { userId: user.id, externalId: ticketExternalId } },
        update: { status: 'resolved', resolvedAt: new Date() },
        create: {
          userId:       user.id,
          externalId:   ticketExternalId,
          threadId:     threadId || null,
          customerName: to,
          customerEmail: to,
          subject:      subject || 'No Subject',
          content:      body,
          channel:      'gmail',
          status:       'resolved',
          resolvedAt:   new Date(),
        }
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Reply error:', err);
    res.status(500).json({ error: 'Failed to send reply.' });
  }
});

// Sync Gmail inbox → DB tickets (upsert so no duplicates)
app.post('/api/tickets/sync', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user?.googleTokens) return res.json({ success: true, synced: 0 });

    const gmail = google.gmail({ version: 'v1', auth: getUserOAuth(user.googleTokens) });
    const response = await gmail.users.messages.list({ userId: 'me', maxResults: 20, q: 'in:inbox' });
    const messages = response.data.messages || [];
    let synced = 0;

    for (const msg of messages) {
      const email   = await gmail.users.messages.get({ userId: 'me', id: msg.id });
      const headers = email.data.payload.headers;
      const subject     = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
      const fromHeader  = headers.find(h => h.name === 'From')?.value || 'Unknown';
      const emailMatch  = fromHeader.match(/<([^>]+)>/);
      const nameMatch   = fromHeader.match(/^(.*?)\s*</);
      const customerEmail = emailMatch ? emailMatch[1] : fromHeader;
      const customerName  = nameMatch ? nameMatch[1].replace(/"/g, '').trim() : fromHeader;
      const dateHeader    = headers.find(h => h.name === 'Date')?.value;
      const receivedAt    = dateHeader ? new Date(dateHeader) : new Date();

      await prisma.ticket.upsert({
        where: { userId_externalId: { userId: user.id, externalId: msg.id } },
        update: {},  // don't overwrite status if already set
        create: {
          userId:        user.id,
          externalId:    msg.id,
          threadId:      email.data.threadId || null,
          customerName:  customerName || 'Unknown',
          customerEmail: customerEmail,
          subject,
          content:       email.data.snippet || '',
          channel:       'gmail',
          status:        'new',
          receivedAt,
        }
      });
      synced++;
    }
    res.json({ success: true, synced });
  } catch (err) {
    console.error('Sync error:', err);
    res.status(500).json({ error: 'Sync failed.' });
  }
});

// ═══════════════════════════════════════════════════════════
// TICKET STATS — derived from DB Ticket table
// ═══════════════════════════════════════════════════════════

app.get('/api/tickets/stats', authenticateToken, async (req, res) => {
  try {
    const days = parseInt(req.query.days || '30');
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const userId = req.user.userId;

    // Get live Gmail inbox count for open tickets
    let gmailOpenCount = 0;
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (user?.googleTokens && user?.gmailEnabled !== false) {
        const gmailClient = google.gmail({ version: 'v1', auth: getUserOAuth(user.googleTokens) });
        const gmailRes = await gmailClient.users.messages.list({ userId: 'me', maxResults: 1, q: 'in:inbox' });
        gmailOpenCount = gmailRes.data.resultSizeEstimate || 0;
      }
    } catch (e) { console.error('Gmail count error:', e.message); }

    const [resolvedThisPeriod, escalated, volumeTrend] = await Promise.all([
      // Count resolved in this period
      prisma.ticket.count({ where: { userId, status: 'resolved', resolvedAt: { gte: since } } }),
      // Count escalated
      prisma.ticket.count({ where: { userId, status: 'escalated' } }),
      // Volume by week for chart
      prisma.ticket.groupBy({
        by: ['receivedAt'],
        where: { userId, receivedAt: { gte: since } },
        _count: true,
        orderBy: { receivedAt: 'asc' }
      })
    ]);

    const openTickets = gmailOpenCount;
    const resolvedCount = (Number.isFinite(resolvedThisPeriod) ? resolvedThisPeriod : 0);
    const total = openTickets + resolvedCount;
    const escalationRate = (total > 0 && escalated > 0) ? ((escalated / total) * 100).toFixed(1) + '%' : '0.0%';

    // Build weekly volume buckets
    const weeklyMap = {};
    volumeTrend.forEach(row => {
      const weekNum = Math.ceil((new Date(row.receivedAt) - since) / (7 * 24 * 60 * 60 * 1000));
      const key = `Week ${Math.max(1, weekNum)}`;
      weeklyMap[key] = (weeklyMap[key] || 0) + row._count;
    });
    const volumeData = Object.entries(weeklyMap).map(([name, count]) => ({ name, count }));

    res.json({
      openTickets:        parseInt(openTickets) || 0,
      resolvedThisPeriod: parseInt(resolvedCount) || 0,
      escalated:          parseInt(escalated) || 0,
      escalationRate,
      avgResolutionTime: 'N/A',
      aiDraftsReady: openTickets,
      sentimentPct: await (async () => {
        const total_s = await prisma.ticket.count({ where: { userId } });
        if (total_s === 0) return { positive: 0, neutral: 100, frustrated: 0 };
        const [pos, frust] = await Promise.all([
          prisma.ticket.count({ where: { userId, sentiment: 'Positive' } }),
          prisma.ticket.count({ where: { userId, sentiment: 'Frustrated' } }),
        ]);
        const neu = total_s - pos - frust;
        return {
          positive:   Math.round((pos / total_s) * 100),
          neutral:    Math.round((neu / total_s) * 100),
          frustrated: Math.round((frust / total_s) * 100),
        };
      })(),
      categoryStats: [{ name: 'General', value: 100, count: openTickets }],
      volumeTrend: volumeData,
      miniBarData: []
    });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats.' });
  }
});

// ═══════════════════════════════════════════════════════════
// AI ROUTES
// ═══════════════════════════════════════════════════════════

// Helper: keyword-based sentiment analysis
const analyzeSentiment = (text) => {
  const t = (text || '').toLowerCase();
  const frustratedWords = ['angry','furious','terrible','awful','worst','horrible','refund','scam','fraud','useless','garbage','ridiculous','unacceptable','disappointed','never again','cheated','lied'];
  const positiveWords = ['thank','great','excellent','amazing','wonderful','love','perfect','brilliant','fantastic','happy','satisfied','awesome'];
  const frustratedScore = frustratedWords.filter(w => t.includes(w)).length;
  const positiveScore = positiveWords.filter(w => t.includes(w)).length;
  if (frustratedScore >= 2 || (frustratedScore >= 1 && t.includes('!'))) return 'Frustrated';
  if (positiveScore >= 1) return 'Positive';
  return 'Neutral';
};

app.post('/api/ai/draft', authenticateToken, async (req, res) => {
  try {
    const { customerName, customerMessage, customInstructions, ticketId, ticketContent, ticketSubject } = req.body;

    // Pull knowledge base / brand context for this user so the draft is grounded
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { businessIdentity: true, brandVoice: true, documents: true },
    });

    const kbSnippets = Array.isArray(user?.documents)
      ? user.documents
          .map(d => d?.textContent)
          .filter(Boolean)
          .join('\n\n')
          .slice(0, 6000) // keep prompt size sane
      : '';

    const systemPrompt = `You are an AI customer support agent.
Business context: ${user?.businessIdentity || 'A growing company that values fast, helpful support.'}
Brand voice: ${user?.brandVoice || 'Professional, concise, but friendly.'}
${kbSnippets ? `Relevant knowledge base content:\n${kbSnippets}` : 'No knowledge base content available — answer using general best practice, and escalate if the answer requires specific business knowledge you do not have.'}

Respond ONLY with a JSON object in this exact shape:
{
  "status": "draft" | "escalated",
  "draft": "the drafted reply text (required if status is draft)",
  "reason": "why this needs human escalation (required if status is escalated)"
}
Escalate when the customer's request needs information outside the knowledge base, involves a refund/complaint requiring judgment, or expresses strong frustration.`;

    const userPrompt = `Customer name: ${customerName || 'Unknown'}
Customer message: ${customerMessage || ticketContent || ''}
${customInstructions ? `Additional instructions for this draft: ${customInstructions}` : ''}`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });
    const draftObj = JSON.parse(response.choices[0]?.message?.content || '{}');

    // Persist escalation status + sentiment to DB
    if (ticketId) {
      const sentiment = analyzeSentiment((customerMessage || ticketContent || '') + ' ' + (ticketSubject || ''));
      const updateData = { sentiment };
      if (draftObj.status === 'escalated') {
        updateData.status = 'escalated';
        updateData.escalationReason = draftObj.reason || 'AI escalated';
      }
      prisma.ticket.upsert({
        where: { userId_externalId: { userId: req.user.userId, externalId: ticketId } },
        update: updateData,
        create: {
          userId:           req.user.userId,
          externalId:       ticketId,
          customerName:     customerName || 'Unknown',
          customerEmail:    'unknown@email.com',
          subject:          ticketSubject || 'No Subject',
          content:          customerMessage || ticketContent || '',
          channel:          'gmail',
          status:           draftObj.status === 'escalated' ? 'escalated' : 'new',
          sentiment,
          escalationReason: draftObj.reason || null,
        }
      }).catch(e => console.error('Ticket upsert:', e.message));
    }

    res.json(draftObj);
  } catch (error) {
    console.error('Draft Error:', error?.message || error);
    res.status(500).json({ error: 'Failed to generate draft' });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    const { messages, system } = req.body;
    const fullMessages = system
      ? [{ role: 'system', content: system }, ...messages]
      : messages;
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: fullMessages,
      temperature: 0.7,
    });
    res.json({ reply: response.choices[0]?.message?.content || '' });
  } catch (error) {
    console.error('Chat Error:', error?.message || error?.status || error);
    res.status(500).json({ error: error?.message || 'Failed to process chat' });
  }
});

app.get('/api/tickets/insights', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    // Find recurring issues — categories/subjects with multiple tickets
    const recurring = await prisma.ticket.groupBy({
      by: ['category'],
      where: { userId },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 5,
    });
    const recurringIssues = recurring.map(r => ({
      title: r.category,
      count: r._count.id,
      severity: r._count.id >= 5 ? 'High' : r._count.id >= 3 ? 'Medium' : 'Low'
    }));
    res.json({
      recommendation: recurringIssues.length > 0
        ? `You have recurring "${recurringIssues[0].title}" tickets. Consider adding more docs to your knowledge base to resolve these automatically.`
        : 'Review recent tickets and update your knowledge base to improve AI resolution rate.',
      recurringIssues
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch insights.' });
  }
});


// ═══════════════════════════════════════════════════════════
// STRIPE ROUTES
// ═══════════════════════════════════════════════════════════

// Create Checkout Session
app.post('/api/stripe/create-checkout', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const frontendUrl = process.env.FRONTEND_URL || 'https://careagent.flint-sol.com';

    // Create or retrieve Stripe customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: user.id }
      });
      customerId = customer.id;
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: customerId }
      });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price: process.env.STRIPE_GROWTH_PRICE_ID,
        quantity: 1,
      }],
      mode: 'subscription',
      success_url: `${frontendUrl}/billing?plan=growth&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/#pricing`,
      metadata: { userId: user.id },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// Stripe Webhook — handle payment events
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata?.userId;
    if (userId) {
      await prisma.user.update({
        where: { id: userId },
        data: {
          plan: 'growth',
          stripeSubscriptionId: session.subscription,
        }
      }).catch(console.error);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    await prisma.user.updateMany({
      where: { stripeSubscriptionId: subscription.id },
      data: { plan: 'startup', stripeSubscriptionId: null }
    }).catch(console.error);
  }

  res.json({ received: true });
});

// Customer billing portal
app.post('/api/stripe/portal', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user?.stripeCustomerId) return res.status(400).json({ error: 'No billing account found' });

    const frontendUrl = process.env.FRONTEND_URL || 'https://careagent.flint-sol.com';
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${frontendUrl}/dashboard`,
    });

    res.json({ url: portalSession.url });
  } catch (err) {
    console.error('Portal error:', err.message);
    res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

// Sync plan after Paddle checkout (called from frontend after successful payment)
app.post('/api/paddle/sync', authenticateToken, async (req, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.userId },
      data: { plan: 'growth' }
    });
    res.json({ success: true, plan: 'growth' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to sync plan' });
  }
});

// Sync plan from Stripe session (called after successful checkout)
app.post('/api/stripe/sync-session', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.json({ success: false });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status === 'paid' || session.status === 'complete') {
      await prisma.user.update({
        where: { id: req.user.userId },
        data: {
          plan: 'growth',
          stripeSubscriptionId: session.subscription,
          stripeCustomerId: session.customer,
        }
      });
      return res.json({ success: true, plan: 'growth' });
    }
    res.json({ success: false });
  } catch (err) {
    console.error('Sync session error:', err.message);
    res.status(500).json({ error: 'Failed to sync session' });
  }
});

// Get current plan
app.get('/api/stripe/plan', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { plan: true, stripeCustomerId: true }
    });
    res.json({ plan: user?.plan || 'startup' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch plan' });
  }
});


// ═══════════════════════════════════════════════════════════
// FACEBOOK MESSENGER — Webhook + Tickets + Reply
// ═══════════════════════════════════════════════════════════

// GET — Meta webhook verification challenge
app.get('/api/facebook/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const verifyToken = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && verifyToken === process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN) {
    console.log('[Facebook] Webhook verified ✅');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// POST — incoming Messenger events from Meta (public, signature-checked)
app.post('/api/facebook/webhook', async (req, res) => {
  res.sendStatus(200); // ack immediately — Meta retries aggressively on non-200

  try {
    console.log('[Facebook] Webhook payload received:', JSON.stringify(req.body));

    const signature = req.headers['x-hub-signature-256'];
    if (process.env.META_APP_SECRET && signature && req.rawBody) {
      const expected = 'sha256=' + crypto
        .createHmac('sha256', process.env.META_APP_SECRET)
        .update(req.rawBody)
        .digest('hex');
      const sigBuf = Buffer.from(signature);
      const expBuf = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        console.warn('[Facebook] Invalid webhook signature — ignoring. Got:', signature, 'Expected:', expected);
        return;
      }
    } else {
      console.warn('[Facebook] Skipping signature check — missing secret, header, or rawBody', {
        hasSecret: !!process.env.META_APP_SECRET, hasSig: !!signature, hasRawBody: !!req.rawBody,
      });
    }

    for (const entry of req.body.entry || []) {
      const pageId = entry.id;
      for (const event of entry.messaging || []) {
        if (!event.message || event.message.is_echo) continue; // skip our own sent messages

        const senderId = event.sender.id;
        const text = event.message.text || '[Attachment received]';

        const user = await prisma.user.findFirst({ where: { facebookPageId: pageId } });
        if (!user) continue;

        let customerName = senderId;
        try {
          const profileRes = await fetch(
            `https://graph.facebook.com/v19.0/${senderId}?fields=name&access_token=${user.facebookPageToken}`
          );
          const profile = await profileRes.json();
          if (profile.name) customerName = profile.name;
        } catch (_) {}

        await prisma.ticket.upsert({
          where: { userId_externalId: { userId: user.id, externalId: event.message.mid } },
          update: {},
          create: {
            userId: user.id,
            externalId: event.message.mid,
            threadId: senderId, // Messenger PSID — used to route replies
            customerName,
            customerEmail: null,
            subject: 'Facebook Messenger',
            content: text,
            channel: 'facebook',
            status: 'new',
            sentiment: 'Neutral',
            category: 'General',
            receivedAt: new Date(event.timestamp),
          },
        });
      }
    }
  } catch (err) {
    console.error('[Facebook] Webhook processing error:', err.message);
  }
});

// GET — Facebook tickets from DB (authenticated, merged into inbox by store.ts)
app.get('/api/facebook/tickets', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (user?.facebookEnabled === false) return res.json([]);

    const tickets = await prisma.ticket.findMany({
      where: { userId: req.user.userId, channel: 'facebook' },
      orderBy: { receivedAt: 'desc' },
    });
    res.json(tickets.map(t => ({
      id: t.externalId,
      threadId: t.threadId,
      customerName: t.customerName,
      initials: (t.customerName || 'U').substring(0, 2).toUpperCase(),
      subject: t.subject || 'Facebook Messenger',
      content: t.content,
      time: new Date(t.receivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      createdAt: t.receivedAt.toISOString(),
      status: t.status,
      hasDraft: true,
      avatarVariant: 'blue',
      channel: 'facebook',
      category: t.category,
      sentiment: t.sentiment,
    })));
  } catch (err) {
    console.error('[facebook/tickets]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST — agent sends reply via Send API, marks ticket resolved (authenticated)
app.post('/api/facebook/reply', authenticateToken, async (req, res) => {
  try {
    const { ticketId, threadId, body } = req.body;
    if (!threadId || !body?.trim()) return res.status(400).json({ error: 'threadId and body required' });

    const user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    if (!user?.facebookPageToken) return res.status(400).json({ error: 'Facebook not connected' });

    const sendRes = await fetch(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${user.facebookPageToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient: { id: threadId },
          message: { text: body },
        }),
      }
    );
    if (!sendRes.ok) {
      const err = await sendRes.json();
      throw new Error(err?.error?.message || 'Send failed');
    }

    if (ticketId) {
      await prisma.ticket.updateMany({
        where: { userId: req.user.userId, externalId: ticketId },
        data: { status: 'resolved', resolvedAt: new Date() },
      });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Facebook reply error:', error.message);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// ═══════════════════════════════════════════════════════════
// LIVE CHAT — Widget + Real-time Chat Routes
// ═══════════════════════════════════════════════════════════

// Allow any origin for livechat routes (widget runs on 3rd-party sites)
app.use(['/api/livechat', '/widget.js'], (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// GET /widget.js — serve embeddable chat widget
app.get('/widget.js', (req, res) => {
  const API = (process.env.VITE_API_URL || 'https://careagent-ai-be-production.up.railway.app').replace(/\/$/, '');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(buildWidget(API));
});

function buildWidget(API) {
  return `(function(){
var _A='${API}',_sc=document.currentScript||[...document.querySelectorAll('script[data-token]')].pop();
if(!_sc)return;
var _tok=_sc.getAttribute('data-token'),_nm=_sc.getAttribute('data-name')||'Support',_col=_sc.getAttribute('data-color')||'#3B82F6';
if(!_tok)return;
var _sid=localStorage.getItem('_ca_sid_'+_tok),_vid=localStorage.getItem('_ca_vid')||(function(){var v='v_'+Math.random().toString(36).substr(2,9);localStorage.setItem('_ca_vid',v);return v;})(),_vname=localStorage.getItem('_ca_nm_'+_tok)||'',_named=!!_vname,_open=false,_last=null,_poll=null,_unread=0;
var _css='.ca-w{position:fixed;bottom:24px;right:24px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}.ca-btn{width:56px;height:56px;border-radius:50%;background:'+_col+';border:none;cursor:pointer;box-shadow:0 4px 20px rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center;transition:transform .2s;position:relative}.ca-btn:hover{transform:scale(1.08)}.ca-bdg{position:absolute;top:-3px;right:-3px;background:#EF4444;color:#fff;border-radius:50%;min-width:18px;height:18px;font-size:10px;font-weight:700;display:none;align-items:center;justify-content:center;padding:0 3px}.ca-pnl{position:absolute;bottom:68px;right:0;width:340px;height:500px;background:#fff;border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,.18);display:flex;flex-direction:column;overflow:hidden;transition:transform .25s cubic-bezier(.4,0,.2,1),opacity .25s;transform-origin:bottom right}.ca-pnl.off{transform:scale(.9) translateY(8px);opacity:0;pointer-events:none}.ca-hd{background:'+_col+';padding:14px 16px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0}.ca-ht{color:#fff;font-size:15px;font-weight:600;margin:0}.ca-hs{color:rgba(255,255,255,.75);font-size:11px;margin:2px 0 0}.ca-cx{background:none;border:none;cursor:pointer;color:#fff;opacity:.8;padding:4px;border-radius:6px;display:flex}.ca-cx:hover{opacity:1;background:rgba(255,255,255,.15)}.ca-ms{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px}.ca-ms::-webkit-scrollbar{width:4px}.ca-ms::-webkit-scrollbar-thumb{background:#E5E7EB;border-radius:4px}.ca-mg{max-width:82%;display:flex;flex-direction:column}.ca-mg.v{align-self:flex-end;align-items:flex-end}.ca-mg.a{align-self:flex-start;align-items:flex-start}.ca-bb{padding:9px 13px;border-radius:14px;font-size:13px;line-height:1.45;word-break:break-word}.ca-mg.v .ca-bb{background:'+_col+';color:#fff;border-bottom-right-radius:4px}.ca-mg.a .ca-bb{background:#F3F4F6;color:#111827;border-bottom-left-radius:4px}.ca-ts{font-size:10px;color:#9CA3AF;margin-top:3px}.ca-nf{padding:12px 14px;border-top:1px solid #F3F4F6;flex-shrink:0}.ca-nf p{font-size:12px;color:#6B7280;margin:0 0 6px}.ca-nr{display:flex;gap:8px}.ca-ni{flex:1;border:1px solid #E5E7EB;border-radius:8px;padding:8px 10px;font-size:13px;outline:none;font-family:inherit}.ca-ni:focus{border-color:'+_col+'}.ca-ia{padding:10px 12px;border-top:1px solid #F3F4F6;display:flex;gap:8px;align-items:flex-end;flex-shrink:0}.ca-inp{flex:1;border:1px solid #E5E7EB;border-radius:10px;padding:8px 11px;font-size:13px;outline:none;resize:none;height:38px;max-height:96px;font-family:inherit;transition:border-color .15s;line-height:1.4}.ca-inp:focus{border-color:'+_col+'}.ca-sb{width:36px;height:36px;min-width:36px;border-radius:10px;background:'+_col+';border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:opacity .15s}.ca-sb:hover{opacity:.85}.ca-em{text-align:center;padding:32px 14px}.ca-em svg{margin:0 auto;display:block}.ca-em p{color:#9CA3AF;font-size:13px;line-height:1.6;margin:10px 0 0}';
var _s=document.createElement('style');_s.textContent=_css;document.head.appendChild(_s);
var _c=document.createElement('div');_c.className='ca-w';
_c.innerHTML='<div class="ca-pnl off"><div class="ca-hd"><div><p class="ca-ht">'+_nm+'</p><p class="ca-hs">Typically replies in minutes</p></div><button class="ca-cx" id="_ca_cx"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div><div class="ca-ms" id="_ca_ms"><div class="ca-em" id="_ca_em"><svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="'+_col+'" stroke-width="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><p>Hi! How can we help you today?</p></div></div><div class="ca-nf" id="_ca_nf" style="display:'+(_named?'none':'block')+'"><p>What's your name?</p><div class="ca-nr"><input class="ca-ni" id="_ca_ni" placeholder="Your name..." /><button class="ca-sb" id="_ca_ns"><svg width="15" height="15" viewBox="0 0 24 24" fill="white"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg></button></div></div><div class="ca-ia" id="_ca_ia" style="display:'+(_named?'flex':'none')+'"><textarea class="ca-inp" id="_ca_inp" placeholder="Type a message..." rows="1"></textarea><button class="ca-sb" id="_ca_sd"><svg width="15" height="15" viewBox="0 0 24 24" fill="white"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg></button></div></div><button class="ca-btn" id="_ca_btn"><div class="ca-bdg" id="_ca_bdg"></div><svg id="_ca_ic" width="22" height="22" viewBox="0 0 24 24" fill="white"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><svg id="_ca_ix" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" style="display:none"><path d="M18 6L6 18M6 6l12 12"/></svg></button>';
document.body.appendChild(_c);
var _$=function(id){return document.getElementById(id);};
function _ft(ts){return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});}
function _rm(m){var d=document.createElement('div');d.className='ca-mg '+(m.role==='visitor'?'v':'a');d.innerHTML='<div class="ca-bb">'+m.content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>')+'</div><div class="ca-ts">'+_ft(m.createdAt)+'</div>';return d;}
function _add(m){var ms=_$('_ca_ms'),em=_$('_ca_em');if(em)em.remove();ms.appendChild(_rm(m));ms.scrollTop=ms.scrollHeight;}
function _bdg(n){_unread=n;var b=_$('_ca_bdg');if(n>0&&!_open){b.textContent=n>9?'9+':n;b.style.display='flex';}else{b.style.display='none';}}
async function _is(){try{var r=await fetch(_A+'/api/livechat/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({livechatToken:_tok,visitorId:_vid,visitorName:_vname})});var d=await r.json();_sid=d.sessionId;localStorage.setItem('_ca_sid_'+_tok,_sid);(d.messages||[]).forEach(function(m){_add(m);});if(d.messages&&d.messages.length)_last=d.messages[d.messages.length-1].createdAt;_sp();}catch(e){console.error('[CA]',e);}}
async function _snd(t){if(!t.trim()||!_sid)return;_add({role:'visitor',content:t,createdAt:new Date().toISOString()});try{await fetch(_A+'/api/livechat/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:_sid,content:t})});}catch(e){}}
function _sp(){if(_poll)return;_poll=setInterval(async function(){if(!_sid)return;try{var p=_last?'?after='+encodeURIComponent(_last):'';var r=await fetch(_A+'/api/livechat/poll/'+_sid+p);var d=await r.json();if(d.messages&&d.messages.length){d.messages.forEach(function(m){_add(m);if(!_open)_bdg(_unread+1);});_last=d.messages[d.messages.length-1].createdAt;}}catch(e){}},3000);}
function _tg(){_open=!_open;var pnl=_c.querySelector('.ca-pnl');if(_open){pnl.classList.remove('off');_$('_ca_ic').style.display='none';_$('_ca_ix').style.display='block';_bdg(0);if(!_sid&&_named)_is();}else{pnl.classList.add('off');_$('_ca_ic').style.display='block';_$('_ca_ix').style.display='none';}}
_$('_ca_btn').onclick=_tg;_$('_ca_cx').onclick=_tg;
_$('_ca_ns').onclick=async function(){var n=_$('_ca_ni').value.trim();if(!n)return;_vname=n;_named=true;localStorage.setItem('_ca_nm_'+_tok,n);_$('_ca_nf').style.display='none';_$('_ca_ia').style.display='flex';await _is();};
_$('_ca_ni').onkeydown=function(e){if(e.key==='Enter')_$('_ca_ns').click();};
function _ds(){var inp=_$('_ca_inp');var t=inp.value.trim();if(!t)return;inp.value='';inp.style.height='38px';_snd(t);}
_$('_ca_sd').onclick=_ds;
_$('_ca_inp').onkeydown=function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();_ds();}};
_$('_ca_inp').oninput=function(){this.style.height='38px';this.style.height=Math.min(this.scrollHeight,96)+'px';};
if(_sid&&_named)_sp();
})();`;
}

// POST /api/livechat/token — generate/get embed token (authenticated)
app.post('/api/livechat/token', authenticateToken, async (req, res) => {
  try {
    let user = await prisma.user.findUnique({ where: { id: req.user.userId } });
    let lct = user.livechatToken;
    if (!lct) {
      lct = crypto.randomBytes(16).toString('hex');
      await prisma.user.update({ where: { id: req.user.userId }, data: { livechatToken: lct, livechatEnabled: true } });
    }
    const base = (process.env.VITE_API_URL || 'https://careagent-ai-be-production.up.railway.app').replace(/\/$/, '');
    res.json({
      token: lct,
      embedCode: `<script src="${base}/widget.js" data-token="${lct}" data-name="Support"></script>`,
    });
  } catch (err) {
    console.error('[livechat/token]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/livechat/session — create/resume session (public)
app.post('/api/livechat/session', async (req, res) => {
  try {
    const { livechatToken, visitorId, visitorName } = req.body;
    if (!livechatToken || !visitorId) return res.status(400).json({ error: 'livechatToken and visitorId required' });
    const user = await prisma.user.findUnique({ where: { livechatToken } });
    if (!user) return res.status(404).json({ error: 'Invalid token' });
    let session = await prisma.chatSession.findFirst({
      where: { userId: user.id, visitorId, status: 'active' },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) {
      session = await prisma.chatSession.create({
        data: { userId: user.id, visitorId, visitorName: visitorName || 'Visitor' },
        include: { messages: true },
      });
    }
    res.json({ sessionId: session.id, messages: session.messages });
  } catch (err) {
    console.error('[livechat/session]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/livechat/message — visitor sends message (public)
app.post('/api/livechat/message', async (req, res) => {
  try {
    const { sessionId, content } = req.body;
    if (!sessionId || !content?.trim()) return res.status(400).json({ error: 'sessionId and content required' });
    const session = await prisma.chatSession.findUnique({ where: { id: sessionId } });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const message = await prisma.chatMessage.create({ data: { sessionId, role: 'visitor', content: content.trim() } });
    await prisma.chatSession.update({ where: { id: sessionId }, data: { updatedAt: new Date() } });
    res.json({ message });
  } catch (err) {
    console.error('[livechat/message]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/livechat/poll/:sessionId — visitor polls for agent replies (public)
app.get('/api/livechat/poll/:sessionId', async (req, res) => {
  try {
    const { after } = req.query;
    const messages = await prisma.chatMessage.findMany({
      where: {
        sessionId: req.params.sessionId,
        role: 'agent',
        ...(after ? { createdAt: { gt: new Date(after) } } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/livechat/tickets — all active sessions as inbox tickets (authenticated)
app.get('/api/livechat/tickets', authenticateToken, async (req, res) => {
  try {
    const sessions = await prisma.chatSession.findMany({
      where: { userId: req.user.userId, status: 'active' },
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
      orderBy: { updatedAt: 'desc' },
    });
    const tickets = sessions.map(s => ({
      id:           s.id,
      customerName: s.visitorName || 'Website Visitor',
      initials:     (s.visitorName || 'WV').substring(0, 2).toUpperCase(),
      subject:      'Live Chat',
      content:      s.messages[0]?.content || 'Started a chat',
      time:         new Date(s.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      createdAt:    s.createdAt.toISOString(),
      status:       'new',
      hasDraft:     true,
      avatarVariant: 'teal',
      channel:      'website',
      sessionId:    s.id,
    }));
    res.json(tickets);
  } catch (err) {
    console.error('[livechat/tickets]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/livechat/messages/:sessionId — full conversation (authenticated)
app.get('/api/livechat/messages/:sessionId', authenticateToken, async (req, res) => {
  try {
    const session = await prisma.chatSession.findFirst({
      where: { id: req.params.sessionId, userId: req.user.userId },
    });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const messages = await prisma.chatMessage.findMany({
      where: { sessionId: req.params.sessionId },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/livechat/reply — agent sends reply (authenticated)
app.post('/api/livechat/reply', authenticateToken, async (req, res) => {
  try {
    const { sessionId, content } = req.body;
    if (!sessionId || !content?.trim()) return res.status(400).json({ error: 'sessionId and content required' });
    const session = await prisma.chatSession.findFirst({
      where: { id: sessionId, userId: req.user.userId },
    });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const message = await prisma.chatMessage.create({ data: { sessionId, role: 'agent', content: content.trim() } });
    res.json({ success: true, message });
  } catch (err) {
    console.error('[livechat/reply]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/livechat/resolve — close a session (authenticated)
app.post('/api/livechat/resolve', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.body;
    await prisma.chatSession.update({
      where: { id: sessionId, userId: req.user.userId },
      data: { status: 'resolved' },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
