const express = require('express');
const crypto = require('crypto');
const { getDb } = require('../config/database');
const GitHubClient = require('../services/githubClient');

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

// Get all repos for the authenticated user
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const repos = db.prepare(`
      SELECT r.*, 
             (SELECT COUNT(*) FROM pull_requests WHERE repo_id = r.id) as pr_count
      FROM repos r
      WHERE r.user_id = ?
      ORDER BY r.added_at DESC
    `).all(req.user.id);
    
    res.json({ repos });
  } catch (error) {
    console.error('Error fetching repos:', error);
    res.status(500).json({ error: 'Failed to fetch repos' });
  }
});

// Add a new repo to track
router.post('/', authenticate, async (req, res) => {
  try {
    const { owner, repo: repoName } = req.body;
    
    if (!owner || !repoName) {
      return res.status(400).json({ error: 'owner and repo are required' });
    }
    
    const githubClient = new GitHubClient(req.user.access_token);
    const githubRepo = await githubClient.getRepo(owner, repoName);
    
    const db = getDb();
    const repoId = crypto.randomUUID();
    
    db.prepare(`
      INSERT OR IGNORE INTO repos (id, user_id, github_repo_id, name, full_name, owner, is_private)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      repoId,
      req.user.id,
      githubRepo.id,
      githubRepo.name,
      githubRepo.full_name,
      githubRepo.owner.login,
      githubRepo.private ? 1 : 0
    );
    
    const repo = db.prepare('SELECT * FROM repos WHERE user_id = ? AND github_repo_id = ?')
      .get(req.user.id, githubRepo.id);
    
    res.status(201).json({ repo });
  } catch (error) {
    console.error('Error adding repo:', error);
    res.status(500).json({ error: 'Failed to add repo' });
  }
});

// Remove a repo from tracking
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const result = db.prepare('DELETE FROM repos WHERE id = ? AND user_id = ?')
      .run(req.params.id, req.user.id);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Repo not found' });
    }
    
    res.json({ message: 'Repo removed successfully' });
  } catch (error) {
    console.error('Error removing repo:', error);
    res.status(500).json({ error: 'Failed to remove repo' });
  }
});

// Sync repos from GitHub (fetch PRs, reviews, comments)
router.post('/:id/sync', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const repo = db.prepare('SELECT * FROM repos WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);
    
    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }
    
    const githubClient = new GitHubClient(req.user.access_token);
    const [owner, repoName] = repo.full_name.split('/');
    
    // Fetch PRs from GitHub
    const prs = await githubClient.getPullRequests(owner, repoName, 'all');
    
    let prCount = 0;
    let reviewCount = 0;
    let commentCount = 0;
    
    for (const pr of prs) {
      // Insert or update PR
      const prId = crypto.randomUUID();
      try {
        db.prepare(`
          INSERT OR REPLACE INTO pull_requests 
          (id, repo_id, github_pr_id, number, title, body, state, author, author_id, created_at, updated_at, closed_at, merged_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          prId, repo.id, pr.id, pr.number, pr.title, pr.body, pr.state,
          pr.user.login, pr.user.id, pr.created_at, pr.updated_at, pr.closed_at, pr.merged_at
        );
        prCount++;
        
        // Fetch and store reviews
        const reviews = await githubClient.getPRReviews(owner, repoName, pr.number);
        for (const review of reviews) {
          const reviewId = crypto.randomUUID();
          try {
            db.prepare(`
              INSERT OR REPLACE INTO reviews
              (id, pull_request_id, github_review_id, user_id, author, state, submitted_at, body)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              reviewId, prId, review.id, req.user.id, review.user.login, review.state, review.submitted_at, review.body
            );
            reviewCount++;
          } catch (e) {
            // Ignore duplicate review errors
          }
        }
        
        // Fetch and store comments
        const comments = await githubClient.getPRComments(owner, repoName, pr.number);
        for (const comment of comments) {
          const commentId = crypto.randomUUID();
          try {
            db.prepare(`
              INSERT OR REPLACE INTO comments
              (id, pull_request_id, github_comment_id, user_id, author, body, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              commentId, prId, comment.id, req.user.id, comment.user.login, comment.body, comment.created_at, comment.updated_at
            );
            commentCount++;
          } catch (e) {
            // Ignore duplicate comment errors
          }
        }
      } catch (e) {
        console.error('Error syncing PR:', e);
      }
    }
    
    res.json({
      message: 'Sync completed',
      stats: { prCount, reviewCount, commentCount }
    });
  } catch (error) {
    console.error('Error syncing repo:', error);
    res.status(500).json({ error: 'Failed to sync repo' });
  }
});

module.exports = router;
