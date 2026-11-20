// test-livechat-native.js
//
// Simulates a real website visitor going through the ACTUAL public
// livechat endpoints (/api/livechat/session -> /message -> /poll) —
// not a direct call to generateNativeDraft like test-native-draft.js.
// This is the first real end-to-end test of tryAutoReplyWebsiteNative(),
// since that path has never been exercised in production before.
//
// IMPORTANT: livechatAutoSend is off by default. Before running this,
// go to Channels in the CareAgent UI and turn ON "Live Chat auto-send"
// for the account you're testing — otherwise the visitor's message will
// just sit there with no AI reply, same as it always has.
//
// Usage:
//   node test-livechat-native.js "<your-jwt-token>"

const BASE_URL = process.env.BASE_URL || 'https://careagent-ai-be-production.up.railway.app';
const token = process.argv[2];

if (!token) {
  console.error('Usage: node test-livechat-native.js "<your-jwt-token>"');
  process.exit(1);
}

// Single-shot questions (quick smoke test)
const TEST_QUESTIONS = [
  'What is the fee for BSCS?',
  'Do you offer scholarships?',
  'Is hostel available?',
];

// Multi-turn conversation — same shape that caught real bugs on WhatsApp
// today (program-memory loss, cross-program number contamination). Sent
// as sequential messages in ONE session, not separate sessions, since
// the whole point is testing whether history/context carries correctly.
const MULTI_TURN_CONVERSATION = [
  'What is the fee for BSCS?',
  '89%',
  'Great, what about BBA?',
  "It's same 89%",
  'What about ADP?',
];

async function getLivechatToken() {
  const res = await fetch(`${BASE_URL}/api/livechat/token`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Failed to get livechat token: HTTP ${res.status}`);
  const data = await res.json();
  return data.livechatToken || data.token;
}

async function createSession(livechatToken) {
  const visitorId = `test-visitor-${Date.now()}`;
  const res = await fetch(`${BASE_URL}/api/livechat/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ livechatToken, visitorId, visitorName: 'Test Visitor' }),
  });
  if (!res.ok) throw new Error(`Failed to create session: HTTP ${res.status}`);
  const data = await res.json();
  return data.sessionId;
}

async function sendMessage(sessionId, content) {
  const res = await fetch(`${BASE_URL}/api/livechat/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, content }),
  });
  if (!res.ok) throw new Error(`Failed to send message: HTTP ${res.status}`);
}

async function pollForReply(sessionId, sinceISO, timeoutMs = 25000, intervalMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BASE_URL}/api/livechat/poll/${sessionId}?after=${encodeURIComponent(sinceISO)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.messages && data.messages.length > 0) {
        return data.messages;
      }
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null; // timed out — either escalated (no auto-send) or auto-send is off
}

async function runConversation(livechatToken, messages) {
  const sessionId = await createSession(livechatToken);
  console.log(`Session created: ${sessionId}`);

  for (const message of messages) {
    console.log(`\n> ${message}`);
    const sentAt = new Date().toISOString();
    await sendMessage(sessionId, message);
    const replies = await pollForReply(sessionId, sentAt);
    if (!replies) {
      console.log('  (no reply within 25s — escalated, or auto-send is off)');
      continue;
    }
    for (const m of replies) console.log(`  ${m.content}`);
  }
}

async function main() {
  console.log('Getting livechat token...');
  const livechatToken = await getLivechatToken();
  console.log(`Got token: ${livechatToken.slice(0, 8)}...`);

  for (const question of TEST_QUESTIONS) {
    console.log('\n' + '─'.repeat(70));
    console.log(`Question: "${question}"`);
    console.log('─'.repeat(70));

    const sessionId = await createSession(livechatToken);
    console.log(`Session created: ${sessionId}`);

    const sentAt = new Date().toISOString();
    await sendMessage(sessionId, question);
    console.log('Message sent, polling for AI reply...');

    const messages = await pollForReply(sessionId, sentAt);
    if (!messages) {
      console.log('No agent reply within 25s — either livechatAutoSend is OFF for this');
      console.log('account, or the AI escalated (check the Inbox for this session\'s');
      console.log(`escalation reason: session ${sessionId}).`);
      continue;
    }
    for (const m of messages) {
      console.log(`Reply:\n${m.content}`);
    }
  }

  console.log('\n' + '─'.repeat(70));
  console.log('MULTI-TURN CONVERSATION TEST (same shape that caught real bugs on WhatsApp)');
  console.log('─'.repeat(70));
  await runConversation(livechatToken, MULTI_TURN_CONVERSATION);

  console.log('\n' + '─'.repeat(70));
  console.log('Done.');
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
