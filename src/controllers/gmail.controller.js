import { fetchInboxEmails, sendReply } from '../services/gmail.service.js';
import { asyncHandler }               from '../middleware/error.middleware.js';

// GET /api/gmail/emails
export const getEmails = asyncHandler(async (req, res) => {
  const maxResults = parseInt(req.query.limit) || 20;
  const tickets    = await fetchInboxEmails(req.user.userId, maxResults);
  res.json(tickets);
});

// POST /api/gmail/reply
export const replyToEmail = asyncHandler(async (req, res) => {
  const { to, subject, body, threadId } = req.body;

  if (!to || !body) {
    return res.status(400).json({ error: 'to and body are required' });
  }

  await sendReply(req.user.userId, { to, subject, body, threadId });
  res.json({ success: true });
});
