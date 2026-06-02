import { AIService }     from '../services/openai.service.js';
import { asyncHandler }  from '../middleware/error.middleware.js';

// POST /api/ai/chat
export const chat = asyncHandler(async (req, res) => {
  const { messages } = req.body;

  if (!messages?.length) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const reply = await AIService.chat(messages);
  res.json({ reply });
});

// POST /api/ai/draft
export const generateDraft = asyncHandler(async (req, res) => {
  const { messages } = req.body;

  if (!messages?.length) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const draft = await AIService.generateDraft(messages);
  res.json(draft);
});

// POST /api/ai/analyse
export const analyseMessage = asyncHandler(async (req, res) => {
  const { content, businessContext } = req.body;

  if (!content) {
    return res.status(400).json({ error: 'content is required' });
  }

  const analysis = await AIService.analyseMessage(content, businessContext);
  res.json(analysis);
});
