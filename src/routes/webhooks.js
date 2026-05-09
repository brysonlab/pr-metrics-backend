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

// Verify GitHub webhook signature
function verifyWebhookSignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];
  const payload = req.rawBody;
  
  if (!signature || !payload) {
    return res.status(401).json({ error: 'Missing signature or payload' });
  }
  
  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', process.env.GITHUB_WEBHOOK_SECRET || process.env.GITHUB_CLIENT_SECRET)
    .update(payload)
    .digest('hex');
  
  if (signature !== expectedSignature) {
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  next();
}

// Register a webhook for a repo
router.post('/:repoId/register', authenticate, async (req, res) => {
  try {
    const db = getDb();
    const repo = db.prepare('SELECT * FROM repos WHERE id = ? AND user_id = ?')
      .get(req.params.repoId, req.user.id);
    
    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }
    
    const webhookUrl = `${req.protocol}://${req.get('host')}/api/webhooks/github`;
    
    // In a production implementation, you would use the GitHub API to register the webhook
    // For now, we just store the webhook registration locally
    const webhookId = crypto.randomUUID();
    const events = ['pull_request', 'review', 'issue_comment'];
    
    db.prepare(`
      INSERT OR REPLACE INTO webhooks (id, repo_id, url, events, active)
      VALUES (?, ?, ?, ?, 1)
    `).run(webhookId, repo.id, webhookUrl, JSON.stringify(events));
    
    res.json({
      message: 'Webhook registered',
      webhook_id: webhookId,
      url: webhookUrl,
      events
    });
  } catch (error) {
    console.error('Error registering webhook:', error);
    res.status(500).json({ error: 'Failed to register webhook' });
  }
});

// GitHub webhook receiver
router.post('/github', verifyWebhookSignature, express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}), async (req, res) => {
  try {
    const event = req.headers['x-github-event'];
    const deliveryId = req.headers['x-github-delivery'];
    
    console.log(`Received webhook: ${event} (${deliveryId})`);
    
    const payload = req.body;
    const db = getDb();
    
    switch (event) {
      case 'pull_request':
        await handlePullRequestEvent(db, payload);
        break;
      case 'review':
        await handleReviewEvent(db, payload);
        break;
      case 'issue_comment':
        await handleCommentEvent(db, payload);
        break;
      default:
        console.log(`Unhandled event type: ${event}`);
    }
    
    res.status(200).json({ received: true, delivery_id: deliveryId });
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

async function handlePullRequestEvent(db, payload) {
  const { action, pull_request: pr, repository: repo } = payload;
  
  // Find the repo in our database
  const dbRepo = db.prepare('SELECT * FROM repos WHERE github_repo_id = ?')
    .get(repo.id);
  
  if (!dbRepo) {
    console.log(`Repo not tracked: ${repo.full_name}`);
    return;
  }
  
  // Only process certain actions
  if (!['opened', 'closed', 'merged', 'reopened', 'synchronize'].includes(action)) {
    return;
  }
  
  const prId = crypto.randomUUID();
  db.prepare(`
    INSERT OR REPLACE INTO pull_requests
    (id, repo_id, github_pr_id, number, title, body, state, author, author_id, created_at, updated_at, closed_at, merged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    prId, dbRepo.id, pr.id, pr.number, pr.title, pr.body, pr.state,
    pr.user.login, pr.user.id, pr.created_at, pr.updated_at, pr.closed_at, pr.merged_at
  );
  
  console.log(`Synced PR #${pr.number} (${action})`);
}

async function handleReviewEvent(db, payload) {
  const { action, review, pull_request: pr, repository: repo } = payload;
  
  if (!['submitted', 'dismissed'].includes(action)) {
    return;
  }
  
  // Find the PR in our database
  const dbPr = db.prepare(`
    SELECT pr.* FROM pull_requests pr
    JOIN repos r ON pr.repo_id = r.id
    WHERE r.github_repo_id = ? AND pr.github_pr_id = ?
  `).get(repo.id, pr.id);
  
  if (!dbPr) {
    console.log(`PR not found: ${repo.full_name} #${pr.number}`);
    return;
  }
  
  // Get the user who submitted the review
  const reviewer = db.prepare('SELECT id FROM users WHERE github_id = ?')
    .get(review.user.id);
  
  if (!reviewer) {
    console.log(`Reviewer not a user: ${review.user.login}`);
    return;
  }
  
  const reviewId = crypto.randomUUID();
  db.prepare(`
    INSERT OR REPLACE INTO reviews
    (id, pull_request_id, github_review_id, user_id, author, state, submitted_at, body)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reviewId, dbPr.id, review.id, reviewer.id, review.user.login, review.state, review.submitted_at, review.body
  );
  
  console.log(`Synced review for PR #${pr.number} (${action})`);
}

async function handleCommentEvent(db, payload) {
  const { action, comment, pull_request: pr, repository: repo } = payload;
  
  if (action !== 'created') {
    return;
  }
  
  // Check if this is a PR comment (not an issue comment)
  if (!pr || !comment.pull_request_id) {
    return;
  }
  
  // Find the PR in our database
  const dbPr = db.prepare(`
    SELECT pr.* FROM pull_requests pr
    JOIN repos r ON pr.repo_id = r.id
    WHERE r.github_repo_id = ? AND pr.github_pr_id = ?
  `).get(repo.id, pr.id);
  
  if (!dbPr) {
    return;
  }
  
  // Get the user who commented
  const commenter = db.prepare('SELECT id FROM users WHERE github_id = ?')
    .get(comment.user.id);
  
  if (!commenter) {
    return;
  }
  
  const commentId = crypto.randomUUID();
  db.prepare(`
    INSERT OR REPLACE INTO comments
    (id, pull_request_id, github_comment_id, user_id, author, body, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    commentId, dbPr.id, comment.id, commenter.id, comment.user.login, comment.body, comment.created_at, comment.updated_at
  );
  
  console.log(`Synced comment for PR #${pr.number}`);
}

// Get webhooks for a repo
router.get('/:repoId', authenticate, (req, res) => {
  try {
    const db = getDb();
    const repo = db.prepare('SELECT * FROM repos WHERE id = ? AND user_id = ?')
      .get(req.params.repoId, req.user.id);
    
    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }
    
    const webhooks = db.prepare('SELECT * FROM webhooks WHERE repo_id = ? AND active = 1')
      .all(repo.id);
    
    res.json({ webhooks });
  } catch (error) {
    console.error('Error fetching webhooks:', error);
    res.status(500).json({ error: 'Failed to fetch webhooks' });
  }
});

// Delete a webhook
router.delete('/:repoId/:webhookId', authenticate, (req, res) => {
  try {
    const db = getDb();
    const result = db.prepare(`
      DELETE FROM webhooks WHERE id = ? AND repo_id = ? AND active = 1
    `).run(req.params.webhookId, req.params.repoId);
    
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Webhook not found' });
    }
    
    res.json({ message: 'Webhook deleted' });
  } catch (error) {
    console.error('Error deleting webhook:', error);
    res.status(500).json({ error: 'Failed to delete webhook' });
  }
});

module.exports = router;
