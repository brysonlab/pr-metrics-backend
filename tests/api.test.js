const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Setup environment for integration tests
const dbFile = path.resolve('/tmp', `api-test-${crypto.randomBytes(4).toString('hex')}.db`);
process.env.DATABASE_URL = `file:${dbFile}`;
process.env.PORT = 0; // Listen on random port
process.env.JWT_SECRET = 'test-secret';

const app = require('../src/index');
let server;
let baseUrl;

test('API Integration Tests', async (t) => {
  // Wait for server to start and get the port
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try {
      if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
      if (fs.existsSync(`${dbFile}-shm`)) fs.unlinkSync(`${dbFile}-shm`);
      if (fs.existsSync(`${dbFile}-wal`)) fs.unlinkSync(`${dbFile}-wal`);
    } catch (e) {}
  });

  await t.test('GET /health should return 200', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'ok');
  });

  await t.test('GET /api/auth/me should return 401 without token', async () => {
    const res = await fetch(`${baseUrl}/api/auth/me`);
    assert.strictEqual(res.status, 401);
  });

  await t.test('GET /api/auth/me should return user with valid token', async () => {
    const { getDb } = require('../src/config/database');
    const db = getDb();
    
    const userId = crypto.randomUUID();
    const token = 'test-access-token';
    
    db.prepare(`
      INSERT INTO users (id, github_id, username, access_token)
      VALUES (?, ?, ?, ?)
    `).run(userId, 'gh-123', 'testuser', token);

    const res = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.user.username, 'testuser');
  });

  await t.test('GET /api/metrics/:repoId/velocity should return metrics', async () => {
    const { getDb } = require('../src/config/database');
    const db = getDb();
    
    const userId = crypto.randomUUID();
    const repoId = crypto.randomUUID();
    const token = 'metrics-test-token';
    
    db.prepare(`INSERT INTO users (id, github_id, username, access_token) VALUES (?, ?, ?, ?)`).run(userId, 'gh-456', 'metricsuser', token);
    db.prepare(`INSERT INTO repos (id, user_id, github_repo_id, name, full_name, owner) VALUES (?, ?, ?, ?, ?, ?)`).run(
      repoId, userId, 'gh-repo-456', 'metrics-repo', 'metricsuser/metrics-repo', 'metricsuser'
    );

    const res = await fetch(`${baseUrl}/api/metrics/${repoId}/velocity`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.velocity !== undefined);
  });

  await t.test('GET /api/metrics/:repoId/all should return all metrics', async () => {
    const { getDb } = require('../src/config/database');
    const db = getDb();
    
    const userId = 'user-all';
    const repoId = 'repo-all';
    const token = 'all-metrics-token';
    
    db.prepare(`INSERT INTO users (id, github_id, username, access_token) VALUES (?, ?, ?, ?)`).run(userId, 'gh-789', 'alluser', token);
    db.prepare(`INSERT INTO repos (id, user_id, github_repo_id, name, full_name, owner) VALUES (?, ?, ?, ?, ?, ?)`).run(
      repoId, userId, 'gh-repo-789', 'all-repo', 'alluser/all-repo', 'alluser'
    );

    const res = await fetch(`${baseUrl}/api/metrics/${repoId}/all`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.velocity !== undefined);
    assert.ok(data.review_time !== undefined);
    assert.ok(data.merge_rate !== undefined);
    assert.ok(data.bottlenecks !== undefined);
    assert.ok(data.health !== undefined);
  });
});
