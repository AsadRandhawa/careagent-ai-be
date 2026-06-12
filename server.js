import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { OpenAI } from 'openai';
import { google } from 'googleapis';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

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
app.use(express.json());


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
      }
    });
    res.set('Cache-Control', 'no-store');
    res.json({
      id: user.id,
      email: user.email,
      googleConnected:    !!user.googleTokens,
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
            aiAutoDrafting, autoClassification, sentimentTracking } = req.body;
    const data = {};
    if (gmailEnabled          !== undefined) data.gmailEnabled          = gmailEnabled;
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
    const { messages, ticketId, ticketContent, ticketSubject } = req.body;
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages,
    });
    const draftObj = JSON.parse(response.choices[0]?.message?.content || '{}');

    // Persist escalation status + sentiment to DB
    if (ticketId) {
      const sentiment = analyzeSentiment((ticketContent || '') + ' ' + (ticketSubject || ''));
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
          customerName:     'Unknown',
          customerEmail:    'unknown@email.com',
          subject:          ticketSubject || 'No Subject',
          content:          ticketContent || '',
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
