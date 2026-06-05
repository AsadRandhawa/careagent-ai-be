import { Router }      from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import {
  syncTickets,
  getStats,
  getInsights,
  markResolved,
} from '../controllers/tickets.controller.js';

const router = Router();

router.use(authenticate);

router.post('/sync',     syncTickets);   // POST /api/tickets/sync
router.get('/stats',     getStats);      // GET  /api/tickets/stats?days=30
router.get('/insights',  getInsights);   // GET  /api/tickets/insights
router.post('/resolve',  markResolved);  // POST /api/tickets/resolve

export default router;
