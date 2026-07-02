import OpenAI from 'openai';
import { config } from '../config/index.js';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

export const AIService = {
  // ── General KB chat ────────────────────────────────────────────────────────
  async chat(messages) {
    const response = await openai.chat.completions.create({
      model:       'gpt-4o-mini',
      messages,
      temperature: 0.7,
    });
    return response.choices[0]?.message?.content || '';
  },

  // ── Customer-support draft (returns parsed JSON) ───────────────────────────
  async generateDraft(messages) {
    const response = await openai.chat.completions.create({
      model:           'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages,
    });
    const raw = response.choices[0]?.message?.content || '{}';
    return JSON.parse(raw);
  },

  // ── Message classification ─────────────────────────────────────────────────
  async analyseMessage(messageContent, businessContext = '') {
    const systemPrompt = `You are a customer support AI. Analyse the customer message and return a JSON object with:
- category: string (Billing, Technical, General, Complaint, Compliment, Refund, Other)
- sentiment: string (Positive, Neutral, Negative, Urgent)
- urgency: number (1-5, where 5 is most urgent)
- suggestedTone: string (Empathetic, Professional, Friendly, Apologetic)
- summary: string (one sentence summary)
${businessContext ? `Business context: ${businessContext}` : ''}
Respond ONLY with valid JSON, no markdown.`;

    const response = await openai.chat.completions.create({
      model:           'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: messageContent },
      ],
    });
    return JSON.parse(response.choices[0]?.message?.content || '{}');
  },

  // ── RAG: Generate text embedding (1536 dimensions) ─────────────────────────
  // Uses the same OpenAI API key — no extra setup needed
  async embed(text) {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',   // cheapest: $0.02 / 1M tokens
      input: text.slice(0, 8000),         // safety trim
    });
    return response.data[0].embedding;   // float[] of length 1536
  },
};
