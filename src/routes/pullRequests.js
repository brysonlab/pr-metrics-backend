const express = require('express');
const { getDb } = require('../config/database');

const router = express.Router();

// Middleware to extract and validate token
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization header' });
  }
  
  const token = authHeader.replace('Bearer ', '');
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE access_token = ?').get(token);
  
  if (!user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  req.user = user;
  next();
}

// Get all PRs for a repo
router.get('/repo/:repoId', authenticate, (req, res) => {
  try {
    const db = getDb();
    const repo = db.prepare('SELECT * FROM repos WHERE id = ? AND user_id = ?')
      .get(req.params.repoId, req.user.id);
    
    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }
    
    const prs = db.prepare(`
      SELECT pr.*,
             (SELECT COUNT(*) FROM reviews WHERE pull_request_id = pr.id) as review_count,
             (SELECT COUNT(*) FROM comments WHERE pull_request_id = pr.id) as comment_count
      FROM pull_requests pr
      WHERE pr.repo_id = ?
      ORDER BY pr.created_at DESC
    `).all(req.params.repoId);
    
    res.json({ pull_requests: prs });
  } catch (error) {
    console.error('Error fetching PRs:', error);
    res.status(500).json({ error: 'Failed to fetch pull requests' });
  }
});

// Get a single PR with details
router.get('/:id', authenticate, (req, res) => {
  try {
    const db = getDb();
    const pr = db.prepare(`
      SELECT pr.*, r.full_name as repo_full_name
      FROM pull_requests pr
      JOIN repos r ON pr.repo_id = r.id
      WHERE pr.id = ? AND r.user_id = ?
    `).get(req.params.id, req.user.id);
    
    if (!pr) {
      return res.status(404).json({ error: 'PR not found' });
    }
    
    // Get reviews
    const reviews = db.prepare('SELECT * FROM reviews WHERE pull_request_id = ?').all(pr.id);
    
    // Get comments
    const comments = db.prepare('SELECT * FROM comments WHERE pull_request_id = ?').all(pr.id);
    
    res.json({ pull_request: pr, reviews, comments });
  } catch (error) {
    console.error('Error fetching PR:', error);
    res.status(500).json({ error: 'Failed to fetch pull request' });
  }
});

// Get PRs by state
router.get('/state/:state', authenticate, (req, res) => {
  try {
    const { state } = req.params;
    const validStates = ['open', 'closed', 'merged', 'all'];
    
    if (!validStates.includes(state)) {
      return res.status(400).json({ error: 'Invalid state. Must be one of: open, closed, merged, all' });
    }
    
    const db = getDb();
    let query = `
      SELECT pr.*, r.full_name as repo_full_name
      FROM pull_requests pr
      JOIN repos r ON pr.repo_id = r.id
      WHERE r.user_id = ?
    `;
    
    if (state !== 'all') {
      if (state === 'merged') {
        query += ` AND pr.merged_at IS NOT NULL`;
      } else {
        query += ` AND pr.state = ?`;
      }
    }
    
    query += ` ORDER BY pr.created_at DESC`;
    
    const prs = state === 'all' 
      ? db.prepare(query).all(req.user.id)
      : db.prepare(query).all(req.user.id, state);
    
    res.json({ pull_requests: prs });
  } catch (error) {
    console.error('Error fetching PRs by state:', error);
    res.status(500).json({ error: 'Failed to fetch pull requests' });
  }
});

module.exports = router;
