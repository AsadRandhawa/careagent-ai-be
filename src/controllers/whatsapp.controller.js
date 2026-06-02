import {
  verifyWebhook,
  validateWebhookSignature,
  parseIncomingWebhook,
  sendMessage,
  markAsRead,
  handleEmbeddedSignup,
} from '../services/whatsapp.service.js';
import { asyncHandler } from '../middleware/error.middleware.js';

// ── Webhook (public — no auth, called by Meta) ──────────

// GET /api/whatsapp/webhook  ← Meta sends this to verify the webhook URL
export const webhookVerify = (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  const { valid, challenge: ch } = verifyWebhook(mode, token, challenge);

  if (valid) {
    console.log('[WhatsApp] Webhook verified ✅');
    return res.status(200).send(ch);
  }

  res.sendStatus(403);
};

// POST /api/whatsapp/webhook  ← Meta sends incoming messages here
export const webhookReceive = asyncHandler(async (req, res) => {
  // Always respond 200 immediately — Meta will retry if we don't
  res.sendStatus(200);

  // Validate the request is genuinely from Meta
  const signature = req.headers['x-hub-signature-256'];
  const rawBody   = JSON.stringify(req.body);

  if (!validateWebhookSignature(rawBody, signature)) {
    console.warn('[WhatsApp] Invalid webhook signature — ignoring');
    return;
  }

  const tickets = parseIncomingWebhook(req.body);

  if (tickets.length > 0) {
    console.log(`[WhatsApp] Received ${tickets.length} message(s)`);
    // TODO: persist tickets to DB and emit via socket.io for real-time UI updates
    // await saveTickets(tickets);
    // io.emit('new_tickets', tickets);
  }
});

// ── Authenticated endpoints ──────────────────────────────

// POST /api/whatsapp/send
export const sendWhatsAppMessage = asyncHandler(async (req, res) => {
  const { to, text } = req.body;

  if (!to || !text) {
    return res.status(400).json({ error: 'to and text are required' });
  }

  const result = await sendMessage(req.user.userId, { to, text });
  res.json(result);
});

// POST /api/whatsapp/connect  ← called after Embedded Signup completes on frontend
export const connectWhatsApp = asyncHandler(async (req, res) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ error: 'Meta auth code is required' });
  }

  const result = await handleEmbeddedSignup(req.user.userId, code);
  res.json({ success: true, ...result });
});

// POST /api/whatsapp/read
export const markMessageRead = asyncHandler(async (req, res) => {
  const { messageId } = req.body;
  await markAsRead(req.user.userId, messageId);
  res.json({ success: true });
});
