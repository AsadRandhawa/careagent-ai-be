/**
 * Tickets Service
 * Handles syncing Gmail → DB, computing real stats, and AI-powered insights.
 */
import { prisma }   from '../lib/prisma.js';
import { createUserOAuthClient } from './gmail.service.js';
import { google }   from 'googleapis';
import OpenAI       from 'openai';
import { config }   from '../config/index.js';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

// ── Sync Gmail → DB ──────────────────────────────────────

/**
 * Fetch up to `maxResults` emails from Gmail and upsert into Ticket table.
 * Uses @@unique([userId, externalId]) so re-syncing never creates duplicates.
 */
export const syncGmailToDb = async (userId, maxResults = 50) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.googleTokens) return { synced: 0 };

  const auth  = createUserOAuthClient(userId, user.googleTokens);
  const gmail = google.gmail({ version: 'v1', auth });

  const listRes = await gmail.users.messages.list({
    userId:     'me',
    maxResults,
    q:          'in:inbox',
  });

  const messages = listRes.data.messages || [];
  if (messages.length === 0) return { synced: 0 };

  const emails = await Promise.all(
    messages.map(msg => gmail.users.messages.get({ userId: 'me', id: msg.id }))
  );

  let synced = 0;
  for (const { data } of emails) {
    const headers      = data.payload?.headers || [];
    const subject      = header(headers, 'Subject') || 'No Subject';
    const fromHeader   = header(headers, 'From')    || 'Unknown';
    const dateHeader   = header(headers, 'Date');

    const nameMatch    = fromHeader.match(/^(.*?)\s*</);
    const emailMatch   = fromHeader.match(/<([^>]+)>/);
    const customerName = nameMatch ? nameMatch[1].replace(/"/g, '').trim() : fromHeader;
    const emailAddress = emailMatch ? emailMatch[1] : fromHeader;
    const receivedAt   = dateHeader ? new Date(dateHeader) : new Date();

    try {
      await prisma.ticket.upsert({
        where:  { userId_externalId: { userId, externalId: data.id } },
        create: {
          userId,
          externalId:    data.id,
          threadId:      data.threadId,
          customerName:  customerName || 'Unknown',
          customerEmail: emailAddress,
          subject,
          content:       data.snippet || '',
          channel:       'gmail',
          status:        'new',
          sentiment:     'Neutral',
          category:      'General',
          receivedAt,
        },
        update: {
          // Update content in case snippet changed; don't overwrite status/sentiment
          subject,
          content: data.snippet || '',
          threadId: data.threadId,
        },
      });
      synced++;
    } catch (err) {
      // Skip individual failures silently
      console.error(`[Tickets] Failed to upsert ticket ${data.id}:`, err.message);
    }
  }

  return { synced };
};

/**
 * Mark a ticket as resolved when a reply is sent.
 */
export const resolveTicket = async (userId, externalId) => {
  await prisma.ticket.updateMany({
    where: { userId, externalId },
    data:  { status: 'resolved', resolvedAt: new Date() },
  });
};

// ── Real Stats ───────────────────────────────────────────

/**
 * Compute dashboard metrics from stored tickets.
 * Returns data for MetricCards, Sentiment chart, Volume trend, Categories.
 */
export const getTicketStats = async (userId, days = 30) => {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const [all, resolved, escalated, sentiments, categories, volumeRaw] =
    await Promise.all([
      // All open tickets
      prisma.ticket.count({ where: { userId, status: { in: ['new', 'pending'] } } }),

      // Resolved in period
      prisma.ticket.count({ where: { userId, status: 'resolved', resolvedAt: { gte: since } } }),

      // Escalated
      prisma.ticket.count({ where: { userId, status: 'escalated' } }),

      // Sentiment breakdown (all tickets in period)
      prisma.ticket.groupBy({
        by:    ['sentiment'],
        where: { userId, receivedAt: { gte: since } },
        _count: { sentiment: true },
      }),

      // Category breakdown
      prisma.ticket.groupBy({
        by:    ['category'],
        where: { userId, receivedAt: { gte: since } },
        _count: { category: true },
        orderBy: { _count: { category: 'desc' } },
        take: 5,
      }),

      // Volume by week (last 5 weeks)
      prisma.$queryRaw`
        SELECT
          DATE_TRUNC('week', "receivedAt") AS week,
          COUNT(*)::int                    AS count
        FROM "Ticket"
        WHERE "userId" = ${userId}
          AND "receivedAt" >= NOW() - INTERVAL '35 days'
        GROUP BY week
        ORDER BY week ASC
      `,
    ]);

  // Avg resolution time (minutes)
  const resolvedTickets = await prisma.ticket.findMany({
    where:  { userId, status: 'resolved', resolvedAt: { not: null }, receivedAt: { gte: since } },
    select: { receivedAt: true, resolvedAt: true },
  });

  const avgResolutionMins = resolvedTickets.length
    ? Math.round(
        resolvedTickets.reduce((sum, t) => {
          return sum + (t.resolvedAt - t.receivedAt) / 60000;
        }, 0) / resolvedTickets.length
      )
    : 0;

  // Sentiment totals
  const sentimentMap = { Positive: 0, Neutral: 0, Negative: 0, Urgent: 0 };
  let totalSentiment = 0;
  for (const s of sentiments) {
    sentimentMap[s.sentiment] = s._count.sentiment;
    totalSentiment += s._count.sentiment;
  }

  const sentimentPct = {
    positive:   totalSentiment ? Math.round((sentimentMap.Positive / totalSentiment) * 100) : 0,
    neutral:    totalSentiment ? Math.round((sentimentMap.Neutral   / totalSentiment) * 100) : 0,
    frustrated: totalSentiment
      ? Math.round(((sentimentMap.Negative + sentimentMap.Urgent) / totalSentiment) * 100)
      : 0,
  };

  // Category breakdown as percentages
  const totalCat = categories.reduce((s, c) => s + c._count.category, 0);
  const categoryStats = categories.map(c => ({
    name:  c.category,
    value: totalCat ? Math.round((c._count.category / totalCat) * 100) : 0,
    count: c._count.category,
  }));

  // Weekly volume for chart (last 5 weeks)
  const volumeTrend = (volumeRaw).map((row, i) => ({
    name:  `Week ${i + 1}`,
    count: row.count,
  }));

  // 7-day mini bar chart
  const last7 = await prisma.$queryRaw`
    SELECT
      TO_CHAR("receivedAt", 'Dy') AS day,
      COUNT(*)::int                AS count
    FROM "Ticket"
    WHERE "userId" = ${userId}
      AND "receivedAt" >= NOW() - INTERVAL '7 days'
    GROUP BY day, DATE_TRUNC('day', "receivedAt")
    ORDER BY DATE_TRUNC('day', "receivedAt") ASC
  `;

  const escalationRate = (all + resolved + escalated) > 0
    ? ((escalated / (all + resolved + escalated)) * 100).toFixed(1)
    : '0.0';

  return {
    openTickets:       all,
    resolvedThisPeriod: resolved,
    escalated,
    escalationRate:    `${escalationRate}%`,
    avgResolutionTime: avgResolutionMins > 0
      ? avgResolutionMins < 60
        ? `${avgResolutionMins}m`
        : `${Math.round(avgResolutionMins / 60)}h`
      : 'N/A',
    sentimentPct,
    categoryStats,
    volumeTrend,
    miniBarData:       last7.map(r => ({ day: r.day, value: r.count })),
    aiDraftsReady:     all, // each open ticket has a potential draft
  };
};

// ── AI Insights ──────────────────────────────────────────

/**
 * Analyse recent tickets with OpenAI to produce:
 * - Recurring issues (grouped by similarity)
 * - One actionable recommendation
 */
export const getAIInsights = async (userId) => {
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const tickets = await prisma.ticket.findMany({
    where:   { userId, receivedAt: { gte: since } },
    select:  { subject: true, content: true, category: true, sentiment: true },
    orderBy: { receivedAt: 'desc' },
    take:    100,
  });

  if (tickets.length === 0) {
    return {
      recommendation: 'Connect your Gmail and sync tickets to get AI-powered insights.',
      recurringIssues: [],
    };
  }

  const ticketSummary = tickets
    .map((t, i) => `${i + 1}. [${t.category}] ${t.subject || t.content.substring(0, 80)}`)
    .join('\n');

  const prompt = `You are a customer support analytics AI. Analyze these ${tickets.length} recent support tickets and respond ONLY with a JSON object:

Tickets:
${ticketSummary}

Return this exact JSON structure:
{
  "recommendation": "One specific actionable recommendation to reduce ticket volume (max 2 sentences)",
  "recurringIssues": [
    { "title": "Issue description", "count": number, "severity": "High|Medium|Low" },
    { "title": "Issue description", "count": number, "severity": "High|Medium|Low" },
    { "title": "Issue description", "count": number, "severity": "High|Medium|Low" }
  ]
}

Base counts on how many tickets relate to each issue. Be specific to the actual ticket content.`;

  try {
    const response = await openai.chat.completions.create({
      model:           'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages:        [{ role: 'user', content: prompt }],
      temperature:     0.3,
    });

    return JSON.parse(response.choices[0]?.message?.content || '{}');
  } catch (err) {
    console.error('[Tickets] AI insights failed:', err.message);
    return {
      recommendation: 'Could not generate insights at this time.',
      recurringIssues: [],
    };
  }
};

// ── Helpers ──────────────────────────────────────────────
const header = (headers, name) =>
  headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value;
