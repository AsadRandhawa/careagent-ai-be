import { prisma }       from '../lib/prisma.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import { safeUser }     from '../services/auth.service.js';

// GET /api/user/me
export const getMe = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where:  { id: req.user.userId },
    select: {
      id:                    true,
      email:                 true,
      documents:             true,
      businessIdentity:      true,
      brandVoice:            true,
      googleTokens:          true,
      whatsappToken:         true,
      whatsappPhoneNumberId: true,
    },
  });

  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    ...safeUser(user),
    knowledgeBase: {
      documents:        user.documents,
      businessIdentity: user.businessIdentity,
      brandVoice:       user.brandVoice,
    },
  });
});

// POST /api/user/knowledge-base
export const updateKnowledgeBase = asyncHandler(async (req, res) => {
  const { documents, businessIdentity, brandVoice } = req.body;

  await prisma.user.update({
    where: { id: req.user.userId },
    data:  {
      documents:        documents        || [],
      businessIdentity: businessIdentity || null,
      brandVoice:       brandVoice       || null,
    },
  });

  res.json({ success: true });
});

// DELETE /api/user/disconnect/gmail
export const disconnectGmail = asyncHandler(async (req, res) => {
  await prisma.user.update({
    where: { id: req.user.userId },
    data:  { googleTokens: null },
  });
  res.json({ success: true });
});

// DELETE /api/user/disconnect/whatsapp
export const disconnectWhatsApp = asyncHandler(async (req, res) => {
  await prisma.user.update({
    where: { id: req.user.userId },
    data:  {
      whatsappToken:         null,
      whatsappPhoneNumberId: null,
      whatsappWabaId:        null,
    },
  });
  res.json({ success: true });
});
