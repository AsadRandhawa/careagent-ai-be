import OpenAI from 'openai';
import { config } from '../config/index.js';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

export const AIService = {
  /**
   * General knowledge-base chat.
   * `messages` is the full conversation array: [{ role, content }, ...]
   */
  async chat(messages) {
    const response = await openai.chat.completions.create({
      model:       'gpt-4o-mini',
      messages,
      temperature: 0.7,
    });
    return response.choices[0]?.message?.content || '';
  },

  /**
   * Generate a customer-support draft reply.
   * Returns a structured JSON object: { subject, body, tone }
   */
  async generateDraft(messages) {
    const response = await openai.chat.completions.create({
      model:           'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages,
    });

    const raw = response.choices[0]?.message?.content || '{}';
    return JSON.parse(raw);
  },

  /**
   * Classify and analyse a customer message.
   * Returns { category, sentiment, urgency, suggestedTone }
   */
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
        { role: 'system',  content: systemPrompt },
        { role: 'user',    content: messageContent },
      ],
    });

    return JSON.parse(response.choices[0]?.message?.content || '{}');
  },
};
