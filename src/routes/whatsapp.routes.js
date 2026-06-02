import { Router }      from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import {
  webhookVerify,
  webhookReceive,
  sendWhatsAppMessage,
  connectWhatsApp,
  markMessageRead,
} from '../controllers/whatsapp.controller.js';

const router = Router();

// ── Public (no auth) — called by Meta servers ────────────
router.get('/webhook',   webhookVerify);    // Meta webhook challenge
router.post('/webhook',  webhookReceive);   // Incoming messages from Meta

// ── Authenticated ─────────────────────────────────────────
router.use(authenticate);

router.post('/connect',  connectWhatsApp);      // POST /api/whatsapp/connect
router.post('/send',     sendWhatsAppMessage);  // POST /api/whatsapp/send
router.post('/read',     markMessageRead);      // POST /api/whatsapp/read

export default router;
