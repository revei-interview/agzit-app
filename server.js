// server.js — AGZIT App Entry Point
require('dotenv').config();

const express      = require('express');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const path         = require('path');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const { requireAuth, requireRole } = require('./middleware/auth');

const app = express();
app.set('trust proxy', 1); // Render sits behind a load balancer — trust first proxy hop for correct IP in rate limiting
app.disable('x-powered-by'); // Don't advertise Express version

// ── Security headers ────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy:     false, // pages load inline scripts + CDN assets
  crossOriginEmbedderPolicy: false, // pages embed Vapi iframe
}));

// ── Rate limiting ───────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.' },
});
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.' },
});
const internalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.' },
});
// Strict limiter for AI-backed endpoints (parse-resume, ai-rewrite) — expensive + quota-limited
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI feature rate limit reached. Please try again in an hour.' },
});

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors({
  origin:      ['https://agzit.com', 'https://www.agzit.com', 'https://app.agzit.com', 'https://agzit-app.onrender.com'],
  credentials: true,
}));
// Capture raw body in req.rawBody before JSON parsing (needed for HMAC webhook verification)
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Webhooks ───────────────────────────────────────────────────────────────
app.use('/api/webhooks', require('./routes/webhooks'));

// ── Static files ───────────────────────────────────────────────────────────
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));
app.use('/shared', express.static(path.join(__dirname, 'public/shared')));

// ── API Routes ─────────────────────────────────────────────────────────────
app.use('/api/auth',                          authLimiter, require('./routes/auth'));
// AI endpoints get a stricter hourly limiter applied first
app.use('/api/candidate/parse-resume',        aiLimiter);
app.use('/api/candidate/resume/ai-rewrite',   aiLimiter);
app.use('/api/candidate',                     apiLimiter,  require('./routes/candidate'));
app.use('/api/employer',  apiLimiter,      require('./routes/employer'));
app.use('/api/internal',  internalLimiter, require('./routes/internal'));
app.use('/api/profile',   apiLimiter,      require('./routes/profile'));           // Public — no auth
app.use('/api/employer-interview', apiLimiter, require('./routes/employer-interviews')); // Token + employer auth
app.use('/api/admin',             apiLimiter, require('./routes/admin'));               // Super admin only

// ── Page Routes ────────────────────────────────────────────────────────────

// Login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/login/index.html'));
});

// Registration page (DPR profile form — after account created)
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/register/index.html'));
});

// Candidate dashboard
app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public/dashboard/index.html'));
});

// Employer dashboard
app.get('/employer', requireAuth, requireRole('dpr_employer', 'verified_employer'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public/employer/index.html'));
});

// Interview start panel (candidate only)
app.get('/interview-start', requireAuth, requireRole('dpr_candidate'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public/interview-start/index.html'));
});

// Interview room — Vapi launcher (candidate only)
app.get('/interview-room', requireAuth, requireRole('dpr_candidate'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public/interview-room/index.html'));
});

// Employer verification status page
app.get('/employer-review', requireAuth, requireRole('dpr_employer', 'verified_employer'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public/employer-review/index.html'));
});

// Employer interview scorecard
app.get('/employer-scorecard', requireAuth, requireRole('dpr_employer', 'verified_employer'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public/employer-scorecard/index.html'));
});

// Candidate scorecard detail page
app.get('/scorecard', requireAuth, requireRole('dpr_candidate'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public/scorecard/index.html'));
});

// Candidate profile edit page
app.get('/profile-edit', requireAuth, requireRole('dpr_candidate'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public/profile-edit/index.html'));
});

// Candidate resume builder
app.get('/resume-builder', requireAuth, requireRole('dpr_candidate'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public/resume-builder/index.html'));
});

// Employer-scheduled interview room — PUBLIC (token-based, no WP login required)
app.get('/employer-interviews', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/employer-interviews/index.html'));
});

// Public candidate profile viewer — no auth required
app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/profile/index.html'));
});

// Employer team invite accept — no auth required (token in URL)
app.get('/employer-accept-invite', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/employer-accept-invite/index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/admin/index.html'));
});

// Branded error page — serves with 200 so ?code= param works correctly
app.get('/error', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/error/index.html'));
});

// Logout (GET for simple link clicks)
app.get('/logout', (req, res) => {
  res.clearCookie('agzit_token');
  res.redirect('https://agzit.com/');
});

// Health check (Render uses this)
app.get('/health', (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV });
});

// 404
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public/error/index.html'));
});

// ── Global error handler — catches any next(err) or unhandled throw ─────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[unhandled error]', err.message, err.stack?.split('\n')[1]);
  res.status(500).json({ ok: false, error: 'An unexpected error occurred.' });
});

// ── Startup environment validation ─────────────────────────────────────────
{
  const REQUIRED_ENV = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'JWT_SECRET'];
  const missing = REQUIRED_ENV.filter(k => !process.env[k]);
  if (missing.length) {
    console.error('[startup] Missing required env vars:', missing.join(', '));
    process.exit(1);
  }
  if (process.env.JWT_SECRET.length < 32) {
    console.error('[startup] JWT_SECRET must be at least 32 characters');
    process.exit(1);
  }
}

// ── Background jobs ────────────────────────────────────────────────────────
require('./jobs/session-cleanup');

// ── DB init — runs before server accepts any connections ────────────────────
async function initDB() {
  const pool = require('./config/db');
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS agzit_employer_team (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      admin_user_id  INT NOT NULL,
      member_user_id INT DEFAULT NULL,
      member_email   VARCHAR(255) NOT NULL,
      member_name    VARCHAR(255) DEFAULT NULL,
      team_role      ENUM('admin','member') DEFAULT 'member',
      status         ENUM('invited','active','removed') DEFAULT 'invited',
      invite_token   VARCHAR(128) DEFAULT NULL,
      invited_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      joined_at      DATETIME DEFAULT NULL,
      UNIQUE KEY unique_member (admin_user_id, member_email)
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS agzit_magic_links (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      token      VARCHAR(128) NOT NULL UNIQUE,
      user_id    INT NOT NULL,
      purpose    VARCHAR(32) NOT NULL DEFAULT 'login',
      expires_at DATETIME NOT NULL,
      used_at    DATETIME DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_token  (token),
      INDEX idx_user   (user_id)
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS agzit_jd_templates (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      admin_user_id INT NOT NULL,
      template_name VARCHAR(255) NOT NULL,
      role_title    VARCHAR(255) NOT NULL,
      jurisdiction  VARCHAR(100) DEFAULT NULL,
      jd_text       TEXT NOT NULL,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS agzit_resume_files (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      user_id         INT NOT NULL,
      profile_post_id INT,
      filename        VARCHAR(255),
      mimetype        VARCHAR(100),
      filedata        LONGBLOB,
      uploaded_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user_resume (user_id)
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS agzit_ai_polish_credits (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      credits_remaining INT DEFAULT 3,
      order_id VARCHAR(255),
      purchased_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user (user_id)
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS agzit_saved_resumes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      resume_name VARCHAR(255) NOT NULL,
      template_id VARCHAR(100),
      resume_data LONGTEXT,
      jd_used TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  // Badge table for storing verified competency badges
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS agzit_badges (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      badge_type ENUM('experience_verified', 'competency'),
      competency_name VARCHAR(100),
      score DECIMAL(5,2),
      earned_date TIMESTAMP,
      expires_date TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user_badge (user_id, badge_type, competency_name)
    )
  `);

  // Candidate credits table
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS agzit_candidate_credits (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      credit_balance INT DEFAULT 0,
      total_credits_purchased INT DEFAULT 0,
      total_credits_earned INT DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_user (user_id),
      INDEX idx_user_id (user_id)
    )
  `);

  // Career reports table
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS agzit_career_reports (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      report_json LONGTEXT,
      dpr_snapshot JSON,
      badges_snapshot JSON,
      openai_response_full LONGTEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_id (user_id),
      INDEX idx_created_at (created_at)
    )
  `);

  // Credit transactions table
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS agzit_credit_transactions (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      transaction_type ENUM('purchase', 'referral', 'usage') NOT NULL,
      amount INT NOT NULL,
      reference_id VARCHAR(100),
      description VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_id (user_id),
      INDEX idx_type (transaction_type),
      INDEX idx_created_at (created_at)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS agzit_referrals (
      id INT PRIMARY KEY AUTO_INCREMENT,
      referrer_id INT NOT NULL,
      referral_email VARCHAR(255) NOT NULL,
      referred_user_id INT NULL,
      status ENUM('pending', 'completed') DEFAULT 'pending',
      referred_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP NULL,
      INDEX idx_referrer (referrer_id),
      INDEX idx_email (referral_email),
      INDEX idx_status (status)
    )
  `);

  // ── Admin / Platform tables ─────────────────────────────────────────────────
  try {
    await pool.execute('ALTER TABLE wp_users ADD COLUMN is_super_admin TINYINT DEFAULT 0');
  } catch (_) { /* already exists */ }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS agzit_super_admin_logs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      admin_id INT NOT NULL,
      action VARCHAR(255) NOT NULL,
      target_user_id INT,
      target_type ENUM('user','credit','interview','referral','api_token','email'),
      old_value JSON,
      new_value JSON,
      ip_address VARCHAR(45),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_admin (admin_id),
      INDEX idx_target_user (target_user_id),
      INDEX idx_action (action),
      INDEX idx_created (created_at)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS agzit_api_tokens (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL UNIQUE,
      token VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMP NULL,
      request_count_24h INT DEFAULT 0,
      request_count_7d INT DEFAULT 0,
      request_count_30d INT DEFAULT 0,
      rate_limit INT DEFAULT 5000,
      status ENUM('active','revoked','expired') DEFAULT 'active',
      INDEX idx_token (token),
      INDEX idx_user (user_id),
      INDEX idx_created (created_at)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS agzit_api_calls (
      id INT PRIMARY KEY AUTO_INCREMENT,
      token_id INT NOT NULL,
      user_id INT,
      endpoint VARCHAR(255) NOT NULL,
      method VARCHAR(10),
      status_code INT,
      response_time_ms INT,
      request_size INT,
      response_size INT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_token (token_id),
      INDEX idx_user (user_id),
      INDEX idx_endpoint (endpoint),
      INDEX idx_created (created_at)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS agzit_platform_metrics (
      id INT PRIMARY KEY AUTO_INCREMENT,
      metric_name VARCHAR(255) NOT NULL,
      metric_value DECIMAL(15,2),
      metric_data JSON,
      recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_metric (metric_name),
      INDEX idx_date (recorded_at)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS agzit_user_activity_log (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      activity_type ENUM('login','interview_start','interview_complete','api_call','career_report','credit_used','profile_update','download','upload'),
      activity_detail JSON,
      cost_to_platform DECIMAL(10,2),
      ip_address VARCHAR(45),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id),
      INDEX idx_type (activity_type),
      INDEX idx_created (created_at)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS agzit_interview_queue (
      id INT PRIMARY KEY AUTO_INCREMENT,
      user_id INT NOT NULL,
      email VARCHAR(255) NOT NULL,
      first_name VARCHAR(100) DEFAULT '',
      preferred_time DATETIME NULL,
      status ENUM('waiting','scheduled','notified','expired') DEFAULT 'waiting',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      notified_at DATETIME NULL,
      INDEX idx_user (user_id),
      INDEX idx_status (status),
      INDEX idx_created (created_at)
    )
  `);

  // Migration: rename post_id → profile_post_id and fix unique key if old schema exists
  try {
    await pool.execute('ALTER TABLE agzit_resume_files CHANGE COLUMN post_id profile_post_id INT NULL');
  } catch (_) { /* already migrated or fresh table */ }
  try {
    await pool.execute('ALTER TABLE agzit_resume_files DROP INDEX unique_post');
  } catch (_) { /* already gone */ }
  try {
    await pool.execute('ALTER TABLE agzit_resume_files ADD UNIQUE KEY unique_user_resume (user_id)');
  } catch (_) { /* already exists */ }

  // Ensure performance indexes (ignore if already exist)
  const INDEXES = [
    'CREATE INDEX IF NOT EXISTS idx_otp_email     ON agzit_otp_codes     (email)',
    'CREATE INDEX IF NOT EXISTS idx_otp_expires   ON agzit_otp_codes     (expires_at)',
    'CREATE INDEX IF NOT EXISTS idx_ml_token      ON agzit_magic_links   (token)',
    'CREATE INDEX IF NOT EXISTS idx_ml_user       ON agzit_magic_links   (user_id)',
    'CREATE INDEX IF NOT EXISTS idx_team_admin    ON agzit_employer_team (admin_user_id)',
    'CREATE INDEX IF NOT EXISTS idx_team_member   ON agzit_employer_team (member_user_id)',
  ];
  for (const sql of INDEXES) {
    try { await pool.execute(sql); } catch (_) { /* already exists */ }
  }

  console.log('[init] DB tables ensured');
}

// ── One-time: ensure astraluxgroup@gmail.com can log in ─────────────────────
async function fixCandidatePassword() {
  const TARGET = 'astraluxgroup@gmail.com';
  try {
    const bcrypt = require('bcryptjs');
    const pool   = require('./config/db');
    const hash   = await bcrypt.hash('Welcome@123', 12);

    // 1. Check if already in agzit_users
    const [[existing]] = await pool.execute(
      'SELECT id FROM agzit_users WHERE email = ? LIMIT 1', [TARGET]
    );

    if (existing) {
      // UPDATE password + fix first_name/last_name from wp_users
      const [[wpUser]] = await pool.execute(
        'SELECT display_name FROM wp_users WHERE user_email = ? LIMIT 1', [TARGET]
      );
      const firstName = (wpUser?.display_name || '').split(' ')[0] || '';
      const lastName  = (wpUser?.display_name || '').split(' ').slice(1).join(' ') || '';
      const [r] = await pool.execute(
        'UPDATE agzit_users SET password_hash = ?, first_name = ?, last_name = ? WHERE email = ?',
        [hash, firstName, lastName, TARGET]
      );
      console.log('[init] candidate password + name fixed, rows affected:', r.affectedRows, 'name:', firstName, lastName);
      return;
    }

    // 2. Not in agzit_users — look up in wp_users and INSERT
    const [[wpUser]] = await pool.execute(
      'SELECT ID, display_name FROM wp_users WHERE user_email = ? LIMIT 1', [TARGET]
    );
    if (!wpUser) {
      console.log('[init] candidate not found in agzit_users or wp_users — skipping');
      return;
    }

    // Get WP role
    const [[capRow]] = await pool.execute(
      "SELECT meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key = 'wp_capabilities' LIMIT 1",
      [wpUser.ID]
    );
    let role = 'dpr_candidate';
    if (capRow?.meta_value) {
      if (capRow.meta_value.includes('"verified_employer"')) role = 'verified_employer';
      else if (capRow.meta_value.includes('"dpr_employer"'))  role = 'dpr_employer';
    }

    // Get dpr_profile_post_id if present
    const [[profileMeta]] = await pool.execute(
      "SELECT meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key = 'dpr_profile_post_id' LIMIT 1",
      [wpUser.ID]
    ).catch(() => [[null]]);
    const dprProfileId = profileMeta?.meta_value ? parseInt(profileMeta.meta_value) : null;

    const firstName = (wpUser.display_name || '').split(' ')[0] || '';
    const [r] = await pool.execute(
      `INSERT INTO agzit_users (email, password_hash, role, first_name, wp_user_id, dpr_profile_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [TARGET, hash, role, firstName, wpUser.ID, dprProfileId]
    );
    console.log('[init] candidate inserted into agzit_users, id:', r.insertId, 'role:', role);
  } catch (e) {
    console.error('[init] candidate password fix failed:', e.message);
  }
}

// ── Start — only after tables are confirmed to exist ────────────────────────
const PORT = process.env.PORT || 3000;
initDB().then(async () => {
  await fixCandidatePassword();
  app.listen(PORT, () => {
    console.log(`🚀 AGZIT App running on port ${PORT}`);
    console.log(`   ENV: ${process.env.NODE_ENV}`);
    console.log(`   WP:  ${process.env.WP_URL}`);
  });
}).catch(err => {
  console.error('[init] DB init failed:', err.message);
  process.exit(1);
});
