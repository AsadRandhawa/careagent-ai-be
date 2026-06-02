import { Router }     from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import {
  getMe,
  updateKnowledgeBase,
  disconnectGmail,
  disconnectWhatsApp,
} from '../controllers/user.controller.js';

const router = Router();

// All user routes require authentication
router.use(authenticate);

router.get('/me',                    getMe);
router.post('/knowledge-base',       updateKnowledgeBase);
router.delete('/disconnect/gmail',   disconnectGmail);
router.delete('/disconnect/whatsapp', disconnectWhatsApp);

export default router;
