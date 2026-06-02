import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';

/**
 * Protects any route that requires a logged-in user.
 * Attaches req.user = { userId } on success.
 */
export const authenticate = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader?.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  jwt.verify(token, config.jwtSecret, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = decoded; // { userId }
    next();
  });
};
