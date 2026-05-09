const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Use a unique file for this run to avoid persistence issues
const dbFile = path.resolve('/tmp', `test-${crypto.randomBytes(4).toString('hex')}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;

const { initializeDatabase, getDb } = require('../src/config/database');
const metricsService = require('../src/services/metricsService');

test('Metrics Service Calculations', async (t) => {
  const db = initializeDatabase();
  
  // Cleanup at the end
  t.after(() => {
    try {
      db.close();
      fs.unlinkSync(dbFile);
      fs.unlinkSync(`${dbFile}-shm`);
      fs.unlinkSync(`${dbFile}-wal`);
    } catch (e) {}
  });

  // Helper to clear tables
  const clearDb = () => {
    db.exec("DELETE FROM reviews");
    db.exec("DELETE FROM comments");
    db.exec("DELETE FROM pull_requests");
    db.exec("DELETE FROM repos");
    db.exec("DELETE FROM users");
  };

  const userId = 'user-1';
  const repoId = 'repo-1';

  const setupBase = () => {
    clearDb();
    db.prepare("INSERT INTO users (id, github_id, username) VALUES (?, ?, ?)").run(userId, 'gh-1', 'testuser');
    db.prepare("INSERT INTO repos (id, user_id, github_repo_id, name, full_name, owner) VALUES (?, ?, ?, ?, ?, ?)").run(
      repoId, userId, 'gh-repo-1', 'test-repo', 'testuser/test-repo', 'testuser'
    );
  };

  await t.test('calculateVelocity should return 0 for empty repo', () => {
    setupBase();
    const result = metricsService.calculateVelocity(repoId);
    assert.strictEqual(result.velocity, 0);
    assert.strictEqual(result.pr_count, 0);
  });

  await t.test('calculateVelocity should calculate correct velocity', () => {
    setupBase();
    const now = new Date();
    const threeWeeksAgo = new Date(now);
    threeWeeksAgo.setDate(now.getDate() - 21);

    db.prepare(`
      INSERT INTO pull_requests (id, repo_id, github_pr_id, number, title, state, author, author_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('pr-1', repoId, 1, 1, 'PR 1', 'merged', 'testuser', 'gh-1', threeWeeksAgo.toISOString(), threeWeeksAgo.toISOString());

    db.prepare(`
      INSERT INTO pull_requests (id, repo_id, github_pr_id, number, title, state, author, author_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('pr-2', repoId, 2, 2, 'PR 2', 'merged', 'testuser', 'gh-1', now.toISOString(), now.toISOString());

    const result = metricsService.calculateVelocity(repoId, 4);
    assert.strictEqual(result.pr_count, 2);
    assert.strictEqual(result.velocity, 0.7);
  });

  await t.test('calculateAverageReviewTime should return null when no reviews', () => {
    setupBase();
    const result = metricsService.calculateAverageReviewTime(repoId);
    assert.strictEqual(result.average_review_time_hours, null);
  });

  await t.test('calculateAverageReviewTime should calculate correctly', () => {
    setupBase();
    const prId = 'pr-review-test';
    const createdAt = new Date('2023-01-01T10:00:00Z');
    const reviewedAt = new Date('2023-01-01T14:00:00Z'); // 4 hours later

    db.prepare(`
      INSERT INTO pull_requests (id, repo_id, github_pr_id, number, title, state, author, author_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(prId, repoId, 10, 10, 'Review Test PR', 'open', 'testuser', 'gh-1', createdAt.toISOString(), createdAt.toISOString());

    db.prepare(`
      INSERT INTO reviews (id, pull_request_id, github_review_id, user_id, author, state, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('rev-1', prId, 100, userId, 'reviewer-1', 'APPROVED', reviewedAt.toISOString());

    const result = metricsService.calculateAverageReviewTime(repoId);
    assert.strictEqual(result.average_review_time_hours, 4);
  });

  await t.test('calculateMergeRate should calculate correctly', () => {
    setupBase();
    const now = new Date();
    db.prepare(`
      INSERT INTO pull_requests (id, repo_id, github_pr_id, number, title, state, author, author_id, created_at, updated_at, closed_at, merged_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('pr-merge-1', repoId, 20, 20, 'Merged PR', 'closed', 'testuser', 'gh-1', now.toISOString(), now.toISOString(), now.toISOString(), now.toISOString());
    
    db.prepare(`
      INSERT INTO pull_requests (id, repo_id, github_pr_id, number, title, state, author, author_id, created_at, updated_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('pr-merge-2', repoId, 21, 21, 'Closed PR', 'closed', 'testuser', 'gh-1', now.toISOString(), now.toISOString(), now.toISOString());

    const result = metricsService.calculateMergeRate(repoId);
    assert.strictEqual(result.merge_rate, 50);
    assert.strictEqual(result.merged_count, 1);
  });

  await t.test('detectBottlenecks should find slow PRs', () => {
    setupBase();
    const longAgo = new Date();
    longAgo.setDate(longAgo.getDate() - 3);
    
    db.prepare(`
      INSERT INTO pull_requests (id, repo_id, github_pr_id, number, title, state, author, author_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('pr-slow', repoId, 30, 30, 'Slow PR', 'open', 'testuser', 'gh-1', longAgo.toISOString(), longAgo.toISOString());

    const result = metricsService.detectBottlenecks(repoId, 48);
    assert.strictEqual(result.bottleneck_count, 1);
    assert.strictEqual(result.bottleneck_prs[0].pr_id, 'pr-slow');
    assert.strictEqual(result.bottleneck_prs[0].issue, 'No reviews yet');
  });

  await t.test('calculateTeamHealth should return a score', () => {
    setupBase();
    const result = metricsService.calculateTeamHealth(repoId);
    assert.ok(typeof result.health_score === 'number');
    assert.ok(result.health_score >= 0 && result.health_score <= 100);
  });
});
