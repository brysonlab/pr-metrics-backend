const { getDb } = require('../config/database');

// Calculate velocity (PRs per week) for a repo
function calculateVelocity(repoId, weeks = 12) {
  const db = getDb();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - (weeks * 7));
  
  const result = db.prepare(`
    SELECT COUNT(*) as pr_count,
           MIN(created_at) as first_pr,
           MAX(created_at) as last_pr
    FROM pull_requests
    WHERE repo_id = ? AND created_at >= ?
  `).get(repoId, startDate.toISOString());
  
  if (!result || result.pr_count === 0) {
    return { velocity: 0, pr_count: 0, weeks };
  }
  
  const firstPrDate = new Date(result.first_pr);
  const lastPrDate = new Date(result.last_pr);
  const actualWeeks = Math.max(1, Math.ceil((lastPrDate - firstPrDate) / (7 * 24 * 60 * 60 * 1000)));
  
  return {
    velocity: Math.round((result.pr_count / actualWeeks) * 10) / 10,
    pr_count: result.pr_count,
    weeks: actualWeeks
  };
}

// Calculate average review time (time from PR creation to first review)
function calculateAverageReviewTime(repoId) {
  const db = getDb();
  
  const result = db.prepare(`
    SELECT AVG(
      CASE 
        WHEN r.submitted_at IS NOT NULL AND pr.created_at IS NOT NULL 
        THEN (julianday(r.submitted_at) - julianday(pr.created_at)) * 24
        ELSE NULL 
      END
    ) as avg_hours
    FROM pull_requests pr
    JOIN reviews r ON r.pull_request_id = pr.id
    WHERE pr.repo_id = ? AND r.state IN ('APPROVED', 'CHANGES_REQUESTED')
  `).get(repoId);
  
  return {
    average_review_time_hours: result.avg_hours ? Math.round(result.avg_hours * 10) / 10 : null
  };
}

// Calculate PR merge rate
function calculateMergeRate(repoId, days = 90) {
  const db = getDb();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  
  const result = db.prepare(`
    SELECT 
      COUNT(CASE WHEN merged_at IS NOT NULL THEN 1 END) as merged_count,
      COUNT(CASE WHEN state = 'closed' AND merged_at IS NULL THEN 1 END) as closed_without_merge,
      COUNT(*) as total_closed
    FROM pull_requests
    WHERE repo_id = ? AND closed_at IS NOT NULL AND closed_at >= ?
  `).get(repoId, startDate.toISOString());
  
  const total = result.merged_count + result.closed_without_merge;
  
  return {
    merge_rate: total > 0 ? Math.round((result.merged_count / total) * 1000) / 10 : null,
    merged_count: result.merged_count,
    closed_without_merge: result.closed_without_merge,
    period_days: days
  };
}

// Detect bottlenecks (PRs waiting for review for too long)
function detectBottlenecks(repoId, thresholdHours = 48) {
  const db = getDb();
  
  // Find open PRs that haven't been reviewed
  const unreviewedPRs = db.prepare(`
    SELECT pr.*, r.full_name as repo_name
    FROM pull_requests pr
    JOIN repos r ON pr.repo_id = r.id
    WHERE pr.repo_id = ? 
      AND pr.state = 'open'
      AND NOT EXISTS (
        SELECT 1 FROM reviews WHERE pull_request_id = pr.id
      )
    ORDER BY pr.created_at ASC
  `).all(repoId);
  
  // Find PRs with pending reviews (reviewed but not merged)
  const pendingPRs = db.prepare(`
    SELECT pr.*, r.full_name as repo_name,
           (julianday('now') - julianday(pr.updated_at)) * 24 as hours_since_update
    FROM pull_requests pr
    JOIN repos r ON pr.repo_id = r.id
    WHERE pr.repo_id = ? 
      AND pr.state = 'open'
      AND EXISTS (
        SELECT 1 FROM reviews WHERE pull_request_id = pr.id AND state IN ('APPROVED', 'CHANGES_REQUESTED')
      )
    ORDER BY hours_since_update DESC
  `).all(repoId);
  
  const bottleneckPRs = [];
  
  for (const pr of unreviewedPRs) {
    const createdAt = new Date(pr.created_at);
    const hoursWaiting = (Date.now() - createdAt) / (1000 * 60 * 60);
    if (hoursWaiting > thresholdHours) {
      bottleneckPRs.push({
        pr_id: pr.id,
        number: pr.number,
        title: pr.title,
        author: pr.author,
        hours_waiting: Math.round(hoursWaiting),
        issue: 'No reviews yet'
      });
    }
  }
  
  for (const pr of pendingPRs) {
    if (pr.hours_since_update > thresholdHours) {
      bottleneckPRs.push({
        pr_id: pr.id,
        number: pr.number,
        title: pr.title,
        author: pr.author,
        hours_waiting: Math.round(pr.hours_since_update),
        issue: 'Pending action after review'
      });
    }
  }
  
  return {
    bottleneck_count: bottleneckPRs.length,
    threshold_hours: thresholdHours,
    bottleneck_prs: bottleneckPRs
  };
}

// Calculate team health score (0-100)
function calculateTeamHealth(repoId) {
  const db = getDb();
  
  // Get review participation rate
  const reviewStats = db.prepare(`
    SELECT 
      COUNT(DISTINCT pr.id) as total_prs,
      COUNT(DISTINCT r.user_id) as reviewers
    FROM pull_requests pr
    LEFT JOIN reviews r ON r.pull_request_id = pr.id
    WHERE pr.repo_id = ?
  `).get(repoId);
  
  // Get comment activity
  const commentStats = db.prepare(`
    SELECT COUNT(DISTINCT user_id) as commenters
    FROM comments c
    JOIN pull_requests pr ON c.pull_request_id = pr.id
    WHERE pr.repo_id = ?
  `).get(repoId);
  
  // Get recent activity (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  
  const recentActivity = db.prepare(`
    SELECT 
      COUNT(DISTINCT pr.id) as recent_prs,
      COUNT(DISTINCT r.id) as recent_reviews,
      COUNT(DISTINCT c.id) as recent_comments
    FROM pull_requests pr
    LEFT JOIN reviews r ON r.pull_request_id = pr.id AND r.submitted_at >= ?
    LEFT JOIN comments c ON c.pull_request_id = pr.id AND c.created_at >= ?
    WHERE pr.repo_id = ?
  `).get(thirtyDaysAgo.toISOString(), thirtyDaysAgo.toISOString(), repoId);
  
  // Calculate health score components
  const velocityScore = Math.min(100, (recentActivity.recent_prs / 10) * 100);
  const reviewParticipationScore = reviewStats.reviewers > 0 ? Math.min(100, (reviewStats.reviewers / 5) * 100) : 0;
  const activityScore = Math.min(100, ((recentActivity.recent_reviews + recentActivity.recent_comments) / 20) * 100);
  
  // Weighted health score
  const healthScore = Math.round(
    (velocityScore * 0.3) + 
    (reviewParticipationScore * 0.35) + 
    (activityScore * 0.35)
  );
  
  return {
    health_score: healthScore,
    velocity_score: Math.round(velocityScore),
    review_participation_score: Math.round(reviewParticipationScore),
    activity_score: Math.round(activityScore),
    stats: {
      total_prs: reviewStats.total_prs,
      reviewers: reviewStats.reviewers,
      commenters: commentStats.commenters,
      recent_prs: recentActivity.recent_prs,
      recent_reviews: recentActivity.recent_reviews,
      recent_comments: recentActivity.recent_comments
    }
  };
}

// Cache metrics in database
function cacheMetrics(repoId, metricType, value, periodStart = null, periodEnd = null) {
  const db = getDb();
  const cacheId = require('crypto').randomUUID();
  
  db.prepare(`
    INSERT OR REPLACE INTO metrics_cache (id, repo_id, metric_type, value, calculated_at, period_start, period_end)
    VALUES (?, ?, ?, ?, datetime('now'), ?, ?)
  `).run(cacheId, repoId, metricType, value, periodStart, periodEnd);
}

// Get cached metrics
function getCachedMetrics(repoId, metricType, maxAgeHours = 1) {
  const db = getDb();
  const maxAge = new Date();
  maxAge.setHours(maxAge.getHours() - maxAgeHours);
  
  return db.prepare(`
    SELECT * FROM metrics_cache
    WHERE repo_id = ? AND metric_type = ? AND calculated_at >= ?
    ORDER BY calculated_at DESC
    LIMIT 1
  `).get(repoId, metricType, maxAge.toISOString());
}

module.exports = {
  calculateVelocity,
  calculateAverageReviewTime,
  calculateMergeRate,
  detectBottlenecks,
  calculateTeamHealth,
  cacheMetrics,
  getCachedMetrics
};
