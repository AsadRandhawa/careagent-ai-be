import { Router }      from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { getEmails, replyToEmail } from '../controllers/gmail.controller.js';

const router = Router();

router.use(authenticate);

router.get('/emails',  getEmails);      // GET  /api/gmail/emails
router.post('/reply',  replyToEmail);   // POST /api/gmail/reply

export default router;
