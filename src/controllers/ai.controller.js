import { prisma }              from '../lib/prisma.js';
import { AIService }           from '../services/openai.service.js';
import { findRelevantChunks }  from '../services/knowledge.service.js';
import { asyncHandler }        from '../middleware/error.middleware.js';

// POST /api/ai/chat  (KB chatbot — unchanged)
export const chat = asyncHandler(async (req, res) => {
  const { messages } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages array is required' });
  const reply = await AIService.chat(messages);
  res.json({ reply });
});

// POST /api/ai/draft  (RAG-powered draft generation)
export const generateDraft = asyncHandler(async (req, res) => {
  const userId = req.user.userId;
  const { customerName, customerMessage, customInstructions } = req.body;

  if (!customerMessage) {
    return res.status(400).json({ error: 'customerMessage is required' });
  }

  // 1. Load user's business identity + brand voice from DB
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { businessIdentity: true, brandVoice: true },
  });

  // 2. RAG — find the most relevant KB chunks for this customer message
  const chunks = await findRelevantChunks(userId, customerMessage, 5);

  let contextDocs = '';
  if (chunks.length > 0) {
    contextDocs = chunks
      .map((c, i) => `[${i + 1}] (from: ${c.docName})\n${c.content}`)
      .join('\n\n---\n\n');
  }

  // 3. Build system prompt (same logic as before, now server-side)
  const systemPrompt = `You are a customer support AI. Your ONLY job is to reply to real customer support messages using the knowledge base below.

KNOWLEDGE BASE (your only allowed source of information):
${contextDocs || 'EMPTY — escalate everything until documents are added.'}

BUSINESS: ${user?.businessIdentity || 'Not configured'}
VOICE: ${user?.brandVoice || 'Professional and friendly'}
${customInstructions ? `AGENT NOTE: ${customInstructions}\n` : ''}

STEP 1 — IS THIS A REAL CUSTOMER SUPPORT MESSAGE?
Ask yourself: "Is a real human asking for help with a product or service?"
If NO → output escalated immediately. Do not draft anything.

Signs it is NOT a real customer message:
- Sender contains: noreply, no-reply, notifications, alert, mailer-daemon, testflight, appstoreconnect, accounts.google, email.apple.com
- Content is a system notification, app review update, security alert, TestFlight build notification, promotional email, newsletter
- There is no question or request for help from a customer

STEP 2 — CAN THE KNOWLEDGE BASE ANSWER THIS?
Read the knowledge base carefully. If the customer's question is NOT covered → escalate.
Never use outside knowledge. Never guess or make up information.

STEP 3 — IS THE CUSTOMER HIGH RISK?
If threatening, abusive, claiming fraud, or requesting something not covered → escalate.

STEP 4 — ONLY IF ALL ABOVE PASS: write a reply using ONLY facts from the knowledge base.
Sign off as CareAgent Support. No placeholders.

RESPOND ONLY AS JSON — no other text:
{"status":"draft","reason":"","draft":"full reply here"}
OR
{"status":"escalated","reason":"one sentence why","draft":""}`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: `Customer Name: ${customerName || 'Customer'}\nMessage: ${customerMessage}` },
  ];

  const draft = await AIService.generateDraft(messages);
  res.json(draft);
});

// POST /api/ai/analyse
export const analyseMessage = asyncHandler(async (req, res) => {
  const { content, businessContext } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  const analysis = await AIService.analyseMessage(content, businessContext);
  res.json(analysis);
});
