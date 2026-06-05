import { asyncHandler }  from '../middleware/error.middleware.js';
import {
  syncGmailToDb,
  getTicketStats,
  getAIInsights,
  resolveTicket,
} from '../services/tickets.service.js';

// POST /api/tickets/sync
// Syncs Gmail inbox into the DB for the authenticated user
export const syncTickets = asyncHandler(async (req, res) => {
  const result = await syncGmailToDb(req.user.userId);
  res.json(result);
});

// GET /api/tickets/stats?days=30
// Returns real computed metrics for Dashboard + Analytics
export const getStats = asyncHandler(async (req, res) => {
  const days  = parseInt(req.query.days) || 30;
  const stats = await getTicketStats(req.user.userId, days);
  res.json(stats);
});

// GET /api/tickets/insights
// Returns AI-generated recommendation + recurring issues
export const getInsights = asyncHandler(async (req, res) => {
  const insights = await getAIInsights(req.user.userId);
  res.json(insights);
});

// POST /api/tickets/resolve
// Mark a ticket resolved when reply is sent
export const markResolved = asyncHandler(async (req, res) => {
  const { externalId } = req.body;
  if (!externalId) return res.status(400).json({ error: 'externalId is required' });
  await resolveTicket(req.user.userId, externalId);
  res.json({ success: true });
});
