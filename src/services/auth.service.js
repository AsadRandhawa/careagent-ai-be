import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma.js';
import { config } from '../config/index.js';

export const AuthService = {
  /**
   * Register a new user with email + password.
   * Returns a signed JWT.
   */
  async register(email, password) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      const err = new Error('An account with this email already exists');
      err.status = 400;
      throw err;
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, password: hashed, documents: [] },
    });

    return { token: signToken(user.id), user: safeUser(user) };
  },

  /**
   * Login with email + password.
   * Returns a signed JWT.
   */
  async login(email, password) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      const err = new Error('Invalid email or password');
      err.status = 400;
      throw err;
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      const err = new Error('Invalid email or password');
      err.status = 400;
      throw err;
    }

    return { token: signToken(user.id), user: safeUser(user) };
  },
};

// ── Helpers ──────────────────────────────────────────────
export const signToken = (userId) =>
  jwt.sign({ userId }, config.jwtSecret, { expiresIn: '30d' });

/** Strip sensitive fields before sending user to frontend */
export const safeUser = (user) => ({
  id:             user.id,
  email:          user.email,
  googleConnected: !!user.googleTokens,
  whatsappConnected: !!user.whatsappToken,
});
