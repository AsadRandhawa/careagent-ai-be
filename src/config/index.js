export const config = {
  jwtSecret:   process.env.JWT_SECRET || 'change_me_in_production',
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
  port:        process.env.PORT || 5000,

  google: {
    clientId:     process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri:  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:5000/api/auth/google/callback',
    scopes: [
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY,
  },

  whatsapp: {
    // Meta / WhatsApp Business API
    appSecret:   process.env.WHATSAPP_APP_SECRET,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'careagent_verify_token',
    apiVersion:  'v19.0',
  },
};
