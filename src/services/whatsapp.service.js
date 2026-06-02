/**
 * WhatsApp Service
 *
 * Supports the official Meta WhatsApp Business Cloud API.
 * Each user who connects WhatsApp gets their own phone_number_id
 * and access_token stored in the DB (via Embedded Signup flow).
 *
 * Reference: https://developers.facebook.com/docs/whatsapp/cloud-api
 */

import crypto  from 'crypto';
import { prisma } from '../lib/prisma.js';
import { config }  from '../config/index.js';

const META_API_BASE = `https://graph.facebook.com/${config.whatsapp.apiVersion}`;

// ── Webhook verification ─────────────────────────────────

/**
 * Called by Meta when you first register the webhook.
 * Returns the challenge string if the verify token matches.
 */
export const verifyWebhook = (mode, token, challenge) => {
  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    return { valid: true, challenge };
  }
  return { valid: false };
};

/**
 * Verify that an incoming webhook payload is genuinely from Meta.
 * Meta signs the body with your App Secret using HMAC-SHA256.
 */
export const validateWebhookSignature = (rawBody, signatureHeader) => {
  if (!config.whatsapp.appSecret) return true; // skip in dev if not set

  const expected = 'sha256=' +
    crypto
      .createHmac('sha256', config.whatsapp.appSecret)
      .update(rawBody)
      .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(signatureHeader || ''),
  );
};

// ── Incoming message processing ──────────────────────────

/**
 * Parse a raw Meta webhook payload and return an array of normalised messages.
 * Each message is shaped like a ticket so the frontend can handle it uniformly
 * alongside Gmail tickets.
 */
export const parseIncomingWebhook = (body) => {
  const tickets = [];

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value    = change.value;
      const messages = value?.messages || [];
      const contacts = value?.contacts || [];

      for (const msg of messages) {
        const contact = contacts.find((c) => c.wa_id === msg.from) || {};

        tickets.push({
          id:            msg.id,
          channel:       'whatsapp',
          customerName:  contact.profile?.name || msg.from,
          initials:      (contact.profile?.name || msg.from).substring(0, 2).toUpperCase(),
          phoneNumber:   msg.from,
          content:       extractMessageText(msg),
          time:          new Date(Number(msg.timestamp) * 1000).toLocaleTimeString([], {
                           hour: '2-digit', minute: '2-digit',
                         }),
          status:        'new',
          hasDraft:      true,
          category:      'General',
          sentiment:     'Neutral',
          avatarVariant: 'green',
          // Keep raw for replying
          _raw: { phoneNumberId: value.metadata?.phone_number_id, waId: msg.from },
        });
      }
    }
  }

  return tickets;
};

// ── Sending messages ─────────────────────────────────────

/**
 * Send a plain-text WhatsApp message on behalf of a user.
 * Looks up the user's whatsappToken and phoneNumberId from the DB.
 */
export const sendMessage = async (userId, { to, text }) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user?.whatsappToken || !user?.whatsappPhoneNumberId) {
    const err = new Error('WhatsApp not connected. Please connect your WhatsApp Business account.');
    err.status = 400;
    throw err;
  }

  const res = await fetch(
    `${META_API_BASE}/${user.whatsappPhoneNumberId}/messages`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${user.whatsappToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
      }),
    },
  );

  if (!res.ok) {
    const error = await res.json();
    throw new Error(error?.error?.message || 'Failed to send WhatsApp message');
  }

  return res.json();
};

/**
 * Mark a received message as read (shows double blue ticks to customer).
 */
export const markAsRead = async (userId, messageId) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.whatsappToken || !user?.whatsappPhoneNumberId) return;

  await fetch(`${META_API_BASE}/${user.whatsappPhoneNumberId}/messages`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${user.whatsappToken}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      status:            'read',
      message_id:        messageId,
    }),
  });
};

// ── Embedded Signup (user connects their WA Business account) ─

/**
 * After the frontend completes Embedded Signup, it receives a `code`.
 * Exchange that code for a long-lived access token, then find the user's
 * phone number ID and store everything.
 */
export const handleEmbeddedSignup = async (userId, code) => {
  // 1. Exchange code for user access token
  const tokenRes = await fetch(
    `https://graph.facebook.com/oauth/access_token` +
    `?client_id=${process.env.META_APP_ID}` +
    `&client_secret=${process.env.META_APP_SECRET}` +
    `&code=${code}`,
  );
  const { access_token } = await tokenRes.json();

  // 2. Get the WhatsApp Business Account associated with this token
  const wabaRes = await fetch(
    `${META_API_BASE}/me/whatsapp_business_accounts`,
    { headers: { Authorization: `Bearer ${access_token}` } },
  );
  const wabaData  = await wabaRes.json();
  const wabaId    = wabaData.data?.[0]?.id;

  // 3. Get phone numbers registered under that WABA
  const phoneRes = await fetch(
    `${META_API_BASE}/${wabaId}/phone_numbers`,
    { headers: { Authorization: `Bearer ${access_token}` } },
  );
  const phoneData     = await phoneRes.json();
  const phoneNumberId = phoneData.data?.[0]?.id;

  // 4. Persist to DB
  await prisma.user.update({
    where: { id: userId },
    data: {
      whatsappToken:         access_token,
      whatsappPhoneNumberId: phoneNumberId,
      whatsappWabaId:        wabaId,
    },
  });

  return { phoneNumberId, wabaId };
};

// ── Private helpers ──────────────────────────────────────

function extractMessageText(msg) {
  switch (msg.type) {
    case 'text':     return msg.text?.body || '';
    case 'image':    return '[Image received]';
    case 'audio':    return '[Voice message received]';
    case 'document': return `[Document: ${msg.document?.filename || 'file'}]`;
    case 'location': return `[Location: ${msg.location?.latitude}, ${msg.location?.longitude}]`;
    default:         return `[${msg.type} message]`;
  }
}
