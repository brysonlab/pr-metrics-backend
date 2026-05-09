const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DATABASE_URL || 'file:./data.db';

let db;

function getDb() {
  if (!db) {
    const dbUrl = process.env.DATABASE_URL || 'file:./data.db';
    const dbFile = dbUrl.replace('file:', '');
    const fullPath = path.resolve(process.cwd(), dbFile);
    db = new Database(fullPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initializeDatabase() {
  const db = getDb();

  // Users table - stores GitHub OAuth info and user preferences
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      github_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      email TEXT,
      avatar_url TEXT,
      access_token TEXT,
      refresh_token TEXT,
      token_expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Repos table - tracked GitHub repositories
  db.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      github_repo_id TEXT NOT NULL,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      owner TEXT NOT NULL,
      is_private INTEGER DEFAULT 0,
      added_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, github_repo_id)
    )
  `);

  // Pull requests table
  db.exec(`
    CREATE TABLE IF NOT EXISTS pull_requests (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      github_pr_id INTEGER NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      state TEXT NOT NULL,
      author TEXT NOT NULL,
      author_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      merged_at TEXT,
      FOREIGN KEY (repo_id) REFERENCES repos(id),
      UNIQUE(repo_id, github_pr_id)
    )
  `);

  // Reviews table
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      pull_request_id TEXT NOT NULL,
      github_review_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      author TEXT NOT NULL,
      state TEXT NOT NULL,
      submitted_at TEXT NOT NULL,
      body TEXT,
      FOREIGN KEY (pull_request_id) REFERENCES pull_requests(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(pull_request_id, github_review_id)
    )
  `);

  // Comments table (PR comments, review comments, inline comments)
  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      pull_request_id TEXT NOT NULL,
      github_comment_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (pull_request_id) REFERENCES pull_requests(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(pull_request_id, github_comment_id)
    )
  `);

  // Metrics cache table
  db.exec(`
    CREATE TABLE IF NOT EXISTS metrics_cache (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      metric_type TEXT NOT NULL,
      value REAL NOT NULL,
      calculated_at TEXT DEFAULT (datetime('now')),
      period_start TEXT,
      period_end TEXT,
      FOREIGN KEY (repo_id) REFERENCES repos(id),
      UNIQUE(repo_id, metric_type, period_start, period_end)
    )
  `);

  // Webhooks table - to track registered webhooks
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      github_webhook_id INTEGER,
      url TEXT NOT NULL,
      events TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (repo_id) REFERENCES repos(id)
    )
  `);

  return db;
}

module.exports = { getDb, initializeDatabase };
