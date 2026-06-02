import { AuthService }    from '../services/auth.service.js';
import { asyncHandler }   from '../middleware/error.middleware.js';
import { getAuthUrl, exchangeCodeForTokens } from '../services/gmail.service.js';
import { signToken }      from '../services/auth.service.js';
import { prisma }         from '../lib/prisma.js';
import { config }         from '../config/index.js';

// POST /api/auth/register
export const register = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const result = await AuthService.register(email, password);
  res.status(201).json(result);
});

// POST /api/auth/login
export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const result = await AuthService.login(email, password);
  res.json(result);
});

// GET /api/auth/google  ← user clicks "Connect Gmail"
export const googleAuthRedirect = (req, res) => {
  // Pass the user's JWT as `state` so the callback knows who to link to
  const userToken = req.query.token || '';
  const url = getAuthUrl(userToken);
  res.redirect(url);
};

// GET /api/auth/google/callback  ← Google redirects here after consent
export const googleAuthCallback = asyncHandler(async (req, res) => {
  const { code, state: userToken, error } = req.query;

  if (error) {
    return res.redirect(`${config.frontendUrl}/channels?error=google_denied`);
  }

  const tokens = await exchangeCodeForTokens(code);

  // If a valid JWT was passed as state, link Google tokens to that user
  if (userToken) {
    try {
      const decoded = await import('jsonwebtoken').then(({ default: jwt }) =>
        jwt.verify(userToken, config.jwtSecret),
      );

      await prisma.user.update({
        where: { id: decoded.userId },
        data:  { googleTokens: tokens },
      });
    } catch {
      console.warn('[Auth] Could not link Google account — invalid state token');
    }
  }

  res.redirect(`${config.frontendUrl}/channels?connected=gmail`);
});
