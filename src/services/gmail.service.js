import { google } from 'googleapis';
import { prisma } from '../lib/prisma.js';
import { config } from '../config/index.js';

// ── OAuth client factory ─────────────────────────────────

/**
 * Creates a fresh OAuth2 client with NO credentials.
 * Used to generate the Google login URL.
 */
export const createBaseOAuthClient = () =>
  new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    config.google.redirectUri,
  );

/**
 * Creates a per-user OAuth2 client pre-loaded with that user's tokens.
 * Automatically refreshes expired access tokens and persists the new
 * token back to the database.
 */
export const createUserOAuthClient = (userId, googleTokens) => {
  const client = createBaseOAuthClient();
  client.setCredentials(googleTokens);

  // Google fires this event when a token is auto-refreshed.
  // We MUST save the new access_token or the next request will fail.
  client.on('tokens', async (newTokens) => {
    try {
      const merged = { ...googleTokens, ...newTokens };
      await prisma.user.update({
        where: { id: userId },
        data:  { googleTokens: merged },
      });
      // Update in-memory reference so subsequent calls in the same
      // request lifecycle also use the fresh token.
      Object.assign(googleTokens, newTokens);
    } catch (err) {
      console.error('[Gmail] Failed to persist refreshed tokens:', err.message);
    }
  });

  return client;
};

/**
 * Generates the Google OAuth consent-screen URL.
 * `state` carries the user's JWT so the callback can link the account.
 */
export const getAuthUrl = (state = '') => {
  const client = createBaseOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline', // request a refresh_token
    prompt:      'consent', // always show consent so refresh_token is returned
    scope:       config.google.scopes,
    state,
  });
};

/**
 * Exchange the one-time `code` from Google for access + refresh tokens.
 * Returns the raw token object.
 */
export const exchangeCodeForTokens = async (code) => {
  const client = createBaseOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens;
};

// ── Email fetching ───────────────────────────────────────

/**
 * Fetch the user's Gmail inbox and return an array of ticket-shaped objects.
 */
export const fetchInboxEmails = async (userId, maxResults = 20) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user?.googleTokens) {
    const err = new Error('Gmail not connected. Please connect your Gmail account first.');
    err.status = 400;
    throw err;
  }

  const auth  = createUserOAuthClient(userId, user.googleTokens);
  const gmail = google.gmail({ version: 'v1', auth });

  const listRes = await gmail.users.messages.list({
    userId:     'me',
    maxResults,
    q:          'in:inbox',
  });

  const messages = listRes.data.messages || [];
  if (messages.length === 0) return [];

  // Fetch each message in parallel for speed
  const emails = await Promise.all(
    messages.map((msg) =>
      gmail.users.messages.get({ userId: 'me', id: msg.id }),
    ),
  );

  return emails.map(({ data }) => parseEmailToTicket(data));
};

/**
 * Send a reply email via the authenticated user's Gmail account.
 */
export const sendReply = async (userId, { to, subject, body, threadId }) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.googleTokens) {
    const err = new Error('Gmail not connected');
    err.status = 400;
    throw err;
  }

  const auth  = createUserOAuthClient(userId, user.googleTokens);
  const gmail = google.gmail({ version: 'v1', auth });

  const raw = encodeEmail({ to, subject: `Re: ${subject}`, body });

  await gmail.users.messages.send({
    userId:      'me',
    requestBody: { raw, threadId },
  });
};

// ── Private helpers ──────────────────────────────────────

const AVATAR_VARIANTS = ['blue', 'purple', 'green', 'orange'];

function parseEmailToTicket(data) {
  const headers     = data.payload?.headers || [];
  const subject     = header(headers, 'Subject') || 'No Subject';
  const fromHeader  = header(headers, 'From')    || 'Unknown';
  const dateHeader  = header(headers, 'Date');

  const nameMatch    = fromHeader.match(/^(.*?)\s*</);
  const emailMatch   = fromHeader.match(/<([^>]+)>/);
  const customerName = nameMatch
    ? nameMatch[1].replace(/"/g, '').trim()
    : fromHeader;
  const emailAddress = emailMatch ? emailMatch[1] : fromHeader;

  const time = dateHeader
    ? new Date(dateHeader).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : 'Just now';

  return {
    id:            data.id,
    threadId:      data.threadId,
    customerName:  customerName || 'Unknown',
    initials:      (customerName || 'U').substring(0, 2).toUpperCase(),
    email:         emailAddress,
    subject,
    time,
    status:        'new',
    hasDraft:      true,
    channel:       'gmail',
    category:      'General',
    sentiment:     'Neutral',
    content:       data.snippet || '',
    avatarVariant: AVATAR_VARIANTS[Math.floor(Math.random() * AVATAR_VARIANTS.length)],
  };
}

function header(headers, name) {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function encodeEmail({ to, subject, body }) {
  const message = [
    `To: ${to}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    `Subject: ${subject}`,
    '',
    body,
  ].join('\n');

  return Buffer.from(message)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
