import { Router } from 'express';
import {
  register,
  login,
  googleAuthRedirect,
  googleAuthCallback,
} from '../controllers/auth.controller.js';

const router = Router();

router.post('/register',          register);
router.post('/login',             login);
router.get('/google',             googleAuthRedirect);   // → redirects user to Google
router.get('/google/callback',    googleAuthCallback);   // ← Google redirects back here

export default router;
