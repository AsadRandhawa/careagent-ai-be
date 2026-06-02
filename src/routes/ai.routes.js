import { Router }      from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { chat, generateDraft, analyseMessage } from '../controllers/ai.controller.js';

const router = Router();

router.use(authenticate);

router.post('/chat',     chat);            // POST /api/ai/chat
router.post('/draft',    generateDraft);   // POST /api/ai/draft
router.post('/analyse',  analyseMessage);  // POST /api/ai/analyse

export default router;
