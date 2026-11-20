// test-native-draft.js
//
// Calls the already-deployed /api/ai/draft endpoint with 5 test questions
// designed to exercise the ported Leads University rules (fee question,
// scholarship overview, hostel flow, discount-stacking, off-topic
// redirect). Plain HTTP calls — no Prisma, no OpenAI key needed here,
// just your JWT (from localStorage's `careagent_token`, see DevTools ->
// Application -> Local Storage -> careagent.flint-sol.com).
//
// Usage:
//   node test-native-draft.js "<your-jwt-token>"
//
// Optional: set BASE_URL env var to point elsewhere (defaults to prod).

const BASE_URL = process.env.BASE_URL || 'https://careagent-ai-be-production.up.railway.app';
const token = process.argv[2];

if (!token) {
  console.error('Usage: node test-native-draft.js "<your-jwt-token>"');
  console.error('Get the token from DevTools -> Application -> Local Storage -> careagent_token');
  process.exit(1);
}

const TESTS = [
  {
    label: '1. Fee question (should ask for aggregate before answering)',
    channel: 'whatsapp',
    customerMessage: 'What is the fee for BSCS?',
  },
  {
    label: '2. Vague scholarship question (should list actual tiers)',
    channel: 'whatsapp',
    customerMessage: 'Do you offer scholarships?',
  },
  {
    label: '3. Hostel question (should ask boys/girls before details)',
    channel: 'whatsapp',
    customerMessage: 'Is hostel available at the Islamabad campus?',
  },
  {
    label: '4. Discount-stacking trap (should say only the higher tier applies)',
    channel: 'website',
    customerMessage: "I'm an orphan and my aggregate is 87%, how much discount do I get?",
  },
  {
    label: '5. Off-topic (should redirect, not attempt an answer)',
    channel: 'website',
    customerMessage: "What's the weather like today?",
  },
  {
    label: '6. BBA fee (targeted check: excluded general catalog had a conflicting 150,000/semester figure for BBA — Islamabad total 1st-semester should be 130,000)',
    channel: 'whatsapp',
    customerMessage: 'What is the fee for BBA?',
  },
];

async function runTest(test) {
  const res = await fetch(`${BASE_URL}/api/ai/draft`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      customerName: 'Test Student',
      customerMessage: test.customerMessage,
      channel: test.channel,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '(no body)');
    return { ok: false, status: res.status, errText };
  }
  return { ok: true, data: await res.json() };
}

async function main() {
  for (const test of TESTS) {
    console.log('\n' + '─'.repeat(70));
    console.log(test.label);
    console.log(`Channel: ${test.channel} | Question: "${test.customerMessage}"`);
    console.log('─'.repeat(70));

    const result = await runTest(test);
    if (!result.ok) {
      console.log(`FAILED — HTTP ${result.status}`);
      console.log(result.errText);
      continue;
    }
    console.log(`Status: ${result.data.status || '(none returned)'}`);
    if (result.data.reason) console.log(`Reason: ${result.data.reason}`);
    console.log(`Draft:\n${result.data.draft || '(no draft text)'}`);
  }
  console.log('\n' + '─'.repeat(70));
  console.log('Done — review each answer against the expected behavior in the label above.');
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
