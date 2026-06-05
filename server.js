import express from 'express';
import cors    from 'cors';
import dotenv  from 'dotenv';

dotenv.config();

import authRoutes     from './src/routes/auth.routes.js';
import userRoutes     from './src/routes/user.routes.js';
import gmailRoutes    from './src/routes/gmail.routes.js';
import whatsappRoutes from './src/routes/whatsapp.routes.js';
import aiRoutes       from './src/routes/ai.routes.js';
import ticketRoutes   from './src/routes/tickets.routes.js';
import { errorHandler } from './src/middleware/error.middleware.js';

const app = express();

app.use(cors());
app.use(express.json());

// ── Routes ──────────────────────────────────────────────
app.use('/api/auth',      authRoutes);
app.use('/api/user',      userRoutes);
app.use('/api/gmail',     gmailRoutes);
app.use('/api/whatsapp',  whatsappRoutes);
app.use('/api/ai',        aiRoutes);
app.use('/api/tickets',   ticketRoutes);

// ── Global error handler ─────────────────────────────────
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅  Server running on port ${PORT}`));
