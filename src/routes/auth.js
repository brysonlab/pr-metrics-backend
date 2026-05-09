const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const { getDb } = require('../config/database');
const GitHubClient = require('../services/githubClient');

const router = express.Router();

const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const SCOPES = 'repo:org read:user user:email';

// Generate state for CSRF protection
function generateState() {
  return crypto.randomBytes(32).toString('hex');
}

// Login route - redirect to GitHub OAuth
router.get('/github', (req, res) => {
  const state = generateState();
  // Store state in session/cookie for later verification
  res.cookie('oauth_state', state, { httpOnly: true, secure: process.env.NODE_ENV === 'production' });
  
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    redirect_uri: process.env.GITHUB_CALLBACK_URL,
    scope: SCOPES,
    state
  });
  
  res.redirect(`${GITHUB_AUTH_URL}?${params.toString()}`);
});

// GitHub OAuth callback
router.get('/github/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    
    // Verify state to prevent CSRF
    const storedState = req.cookies?.oauth_state;
    if (state !== storedState) {
      return res.status(400).json({ error: 'Invalid OAuth state' });
    }
    
    if (!code) {
      return res.status(400).json({ error: 'No authorization code received' });
    }
    
    // Exchange code for access token
    const tokenResponse = await axios.post(GITHUB_TOKEN_URL, {
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: process.env.GITHUB_CALLBACK_URL
    }, {
      headers: { Accept: 'application/json' }
    });
    
    const { access_token: accessToken, refresh_token: refreshToken, expires_in } = tokenResponse.data;
    
    if (!accessToken) {
      return res.status(400).json({ error: 'Failed to get access token', details: tokenResponse.data });
    }
    
    // Get user info from GitHub
    const githubClient = new GitHubClient(accessToken);
    const githubUser = await githubClient.getCurrentUser();
    
    const db = getDb();
    const now = new Date().toISOString();
    const tokenExpiresAt = new Date(Date.now() + expires_in * 1000).toISOString();
    
    // Upsert user
    const userId = crypto.randomUUID();
    const existingUser = db.prepare('SELECT id FROM users WHERE github_id = ?').get(githubUser.id);
    
    if (existingUser) {
      db.prepare(`
        UPDATE users 
        SET username = ?, email = ?, avatar_url = ?, 
            access_token = ?, refresh_token = ?, token_expires_at = ?,
            updated_at = ?
        WHERE github_id = ?
      `).run(
        githubUser.login, githubUser.email, githubUser.avatar_url,
        accessToken, refreshToken, tokenExpiresAt, now,
        githubUser.id
      );
      var user = db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubUser.id);
    } else {
      db.prepare(`
        INSERT INTO users (id, github_id, username, email, avatar_url, access_token, refresh_token, token_expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        userId, githubUser.id, githubUser.login, githubUser.email, githubUser.avatar_url,
        accessToken, refreshToken, tokenExpiresAt, now, now
      );
      var user = db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubUser.id);
    }
    
    // Generate a session token (simplified JWT-like token)
    const sessionToken = crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev-secret')
      .update(user.id + user.github_id)
      .digest('hex');
    
    // Clear OAuth state cookie
    res.clearCookie('oauth_state');
    
    // Return user info and token
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar_url: user.avatar_url
      },
      token: accessToken,
      session_token: sessionToken
    });
    
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).json({ 
      error: 'OAuth callback failed',
      message: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Logout route
router.post('/logout', (req, res) => {
  // In a full implementation, invalidate the session token
  res.json({ message: 'Logged out successfully' });
});

// Get current user
router.get('/me', (req, res) => {
  // In a full implementation, verify the session token from headers
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization header' });
  }
  
  const token = authHeader.replace('Bearer ', '');
  const db = getDb();
  const user = db.prepare('SELECT id, github_id, username, email, avatar_url, created_at FROM users WHERE access_token = ?').get(token);
  
  if (!user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  res.json({ user });
});

module.exports = router;
