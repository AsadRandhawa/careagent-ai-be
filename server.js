import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { google } from 'googleapis';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.VITE_OPENAI_API_KEY || process.env.OPENAI_API_KEY
});

// Google OAuth Setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || "http://localhost:5000/api/auth/google/callback"
);

// --- ROUTES ---

// 1. Google Auth Login
app.get('/api/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Request a refresh token
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.modify', 
      'https://www.googleapis.com/auth/userinfo.email'
    ]
  });
  res.redirect(url);
});

// 2. Google Auth Callback
app.get('/api/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    // In a real app, save these tokens to your database!
    console.log("Successfully acquired Google Tokens!");
    
    // Immediately test fetching emails
    fetchRecentEmails();
    
    // Redirect back to the frontend Channels page
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/channels?connected=gmail`);
  } catch (error) {
    console.error("Google Auth Error:", error);
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/channels?error=auth_failed`);
  }
});

// Endpoint for Knowledge Base Chat
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.7,
    });
    res.json({ reply: response.choices[0]?.message?.content || "" });
  } catch (error) {
    console.error("Chat Error:", error);
    res.status(500).json({ error: "Failed to process chat" });
  }
});

// Endpoint for AI Drafts
app.post('/api/draft', async (req, res) => {
  try {
    const { messages } = req.body;
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages,
    });
    const draftObj = JSON.parse(response.choices[0]?.message?.content || "{}");
    res.json(draftObj);
  } catch (error) {
    console.error("Draft Error:", error);
    res.status(500).json({ error: "Failed to generate draft" });
  }
});

// Endpoint to fetch LIVE emails for the Inbox
app.get('/api/emails', async (req, res) => {
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const response = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 10,
      q: 'in:inbox' // Only grab from inbox
    });

    const messages = response.data.messages || [];
    const tickets = [];

    for (const msg of messages) {
      const email = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
      });
      
      const headers = email.data.payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
      const fromHeader = headers.find(h => h.name === 'From')?.value || 'Unknown';
      
      const nameMatch = fromHeader.match(/^(.*?)\s*</);
      const emailMatch = fromHeader.match(/<([^>]+)>/);
      const customerName = nameMatch ? nameMatch[1].replace(/"/g, '').trim() : fromHeader;
      const emailAddress = emailMatch ? emailMatch[1] : fromHeader;
      
      const dateHeader = headers.find(h => h.name === 'Date')?.value;
      const timeString = dateHeader ? new Date(dateHeader).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Just now';

      tickets.push({
        id: msg.id,
        customerName: customerName || "Unknown",
        initials: (customerName || "U").substring(0, 2).toUpperCase(),
        subject,
        time: timeString,
        status: "new",
        hasDraft: true,
        avatarVariant: ["blue", "purple", "green", "orange"][Math.floor(Math.random() * 4)],
        email: emailAddress,
        category: "General",
        content: email.data.snippet,
        sentiment: "Neutral",
      });
    }

    res.json(tickets);
  } catch (error) {
    console.error('Failed to fetch emails: ', error);
    res.status(500).json({ error: "Failed to fetch emails. Did you connect Gmail?" });
  }
});

// Helper function to fetch real emails
async function fetchRecentEmails() {
  try {
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const response = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 3,
      q: 'in:inbox' // Only grab from inbox
    });

    const messages = response.data.messages || [];
    if (messages.length === 0) {
      console.log('No recent emails found.');
      return;
    }

    console.log('\n=============================================');
    console.log('📬 FETCHED 3 RECENT EMAILS FROM YOUR INBOX:');
    console.log('=============================================');
    for (const msg of messages) {
      const email = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
      });
      const headers = email.data.payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
      const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
      
      console.log(`[FROM]: ${from}`);
      console.log(`[SUBJECT]: ${subject}`);
      console.log(`[SNIPPET]: ${email.data.snippet}`);
      console.log('---------------------------------------------');
    }
  } catch (error) {
    console.error('Failed to fetch emails: ' + error);
  }
}

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
