const express = require('express');
const { getDb } = require('../config/database');
const metricsService = require('../services/metricsService');

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

// Get velocity for a repo
router.get('/:repoId/velocity', authenticate, (req, res) => {
  try {
    const db = getDb();
    const repo = db.prepare('SELECT * FROM repos WHERE id = ? AND user_id = ?')
      .get(req.params.repoId, req.user.id);
    
    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }
    
    const weeks = parseInt(req.query.weeks) || 12;
    const useCache = req.query.use_cache !== 'false';
    
    if (useCache) {
      const cached = metricsService.getCachedMetrics(req.params.repoId, 'velocity');
      if (cached) {
        return res.json({ 
          ...JSON.parse(cached.value),
          cached: true,
          calculated_at: cached.calculated_at
        });
      }
    }
    
    const velocity = metricsService.calculateVelocity(req.params.repoId, weeks);
    metricsService.cacheMetrics(req.params.repoId, 'velocity', JSON.stringify(velocity));
    
    res.json({ ...velocity, cached: false });
  } catch (error) {
    console.error('Error calculating velocity:', error);
    res.status(500).json({ error: 'Failed to calculate velocity' });
  }
});

// Get average review time for a repo
router.get('/:repoId/review-time', authenticate, (req, res) => {
  try {
    const db = getDb();
    const repo = db.prepare('SELECT * FROM repos WHERE id = ? AND user_id = ?')
      .get(req.params.repoId, req.user.id);
    
    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }
    
    const useCache = req.query.use_cache !== 'false';
    
    if (useCache) {
      const cached = metricsService.getCachedMetrics(req.params.repoId, 'review_time');
      if (cached) {
        return res.json({ 
          ...JSON.parse(cached.value),
          cached: true,
          calculated_at: cached.calculated_at
        });
      }
    }
    
    const reviewTime = metricsService.calculateAverageReviewTime(req.params.repoId);
    metricsService.cacheMetrics(req.params.repoId, 'review_time', JSON.stringify(reviewTime));
    
    res.json({ ...reviewTime, cached: false });
  } catch (error) {
    console.error('Error calculating review time:', error);
    res.status(500).json({ error: 'Failed to calculate review time' });
  }
});

// Get merge rate for a repo
router.get('/:repoId/merge-rate', authenticate, (req, res) => {
  try {
    const db = getDb();
    const repo = db.prepare('SELECT * FROM repos WHERE id = ? AND user_id = ?')
      .get(req.params.repoId, req.user.id);
    
    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }
    
    const days = parseInt(req.query.days) || 90;
    const useCache = req.query.use_cache !== 'false';
    
    if (useCache) {
      const cached = metricsService.getCachedMetrics(req.params.repoId, 'merge_rate');
      if (cached) {
        return res.json({ 
          ...JSON.parse(cached.value),
          cached: true,
          calculated_at: cached.calculated_at
        });
      }
    }
    
    const mergeRate = metricsService.calculateMergeRate(req.params.repoId, days);
    metricsService.cacheMetrics(req.params.repoId, 'merge_rate', JSON.stringify(mergeRate));
    
    res.json({ ...mergeRate, cached: false });
  } catch (error) {
    console.error('Error calculating merge rate:', error);
    res.status(500).json({ error: 'Failed to calculate merge rate' });
  }
});

// Get bottlenecks for a repo
router.get('/:repoId/bottlenecks', authenticate, (req, res) => {
  try {
    const db = getDb();
    const repo = db.prepare('SELECT * FROM repos WHERE id = ? AND user_id = ?')
      .get(req.params.repoId, req.user.id);
    
    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }
    
    const thresholdHours = parseInt(req.query.threshold) || 48;
    const bottlenecks = metricsService.detectBottlenecks(req.params.repoId, thresholdHours);
    
    res.json(bottlenecks);
  } catch (error) {
    console.error('Error detecting bottlenecks:', error);
    res.status(500).json({ error: 'Failed to detect bottlenecks' });
  }
});

// Get team health score for a repo
router.get('/:repoId/health', authenticate, (req, res) => {
  try {
    const db = getDb();
    const repo = db.prepare('SELECT * FROM repos WHERE id = ? AND user_id = ?')
      .get(req.params.repoId, req.user.id);
    
    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }
    
    const useCache = req.query.use_cache !== 'false';
    
    if (useCache) {
      const cached = metricsService.getCachedMetrics(req.params.repoId, 'health');
      if (cached) {
        return res.json({ 
          ...JSON.parse(cached.value),
          cached: true,
          calculated_at: cached.calculated_at
        });
      }
    }
    
    const health = metricsService.calculateTeamHealth(req.params.repoId);
    metricsService.cacheMetrics(req.params.repoId, 'health', JSON.stringify(health));
    
    res.json({ ...health, cached: false });
  } catch (error) {
    console.error('Error calculating health:', error);
    res.status(500).json({ error: 'Failed to calculate team health' });
  }
});

// Get all metrics for a repo
router.get('/:repoId/all', authenticate, (req, res) => {
  try {
    const db = getDb();
    const repo = db.prepare('SELECT * FROM repos WHERE id = ? AND user_id = ?')
      .get(req.params.repoId, req.user.id);
    
    if (!repo) {
      return res.status(404).json({ error: 'Repo not found' });
    }
    
    const velocity = metricsService.calculateVelocity(req.params.repoId, 12);
    const reviewTime = metricsService.calculateAverageReviewTime(req.params.repoId);
    const mergeRate = metricsService.calculateMergeRate(req.params.repoId, 90);
    const bottlenecks = metricsService.detectBottlenecks(req.params.repoId, 48);
    const health = metricsService.calculateTeamHealth(req.params.repoId);
    
    res.json({
      velocity,
      review_time: reviewTime,
      merge_rate: mergeRate,
      bottlenecks,
      health
    });
  } catch (error) {
    console.error('Error calculating all metrics:', error);
    res.status(500).json({ error: 'Failed to calculate metrics' });
  }
});

module.exports = router;
