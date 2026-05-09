require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { initializeDatabase } = require('./config/database');
const authRoutes = require('./routes/auth');
const repoRoutes = require('./routes/repos');
const prRoutes = require('./routes/pullRequests');
const metricsRoutes = require('./routes/metrics');
const webhookRoutes = require('./routes/webhooks');

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true
}));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize database
try {
  initializeDatabase();
  console.log('Database initialized successfully');
} catch (err) {
  console.error('Database initialization failed:', err);
  process.exit(1);
}

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/repos', repoRoutes);
app.use('/api/pull-requests', prRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/webhooks', webhookRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;
