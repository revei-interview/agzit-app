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

// ── Security headers ────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy:     false, // pages load inline scripts + CDN assets
  crossOriginEmbedderPolicy: false, // pages embed Vapi iframe
}));

// ── Rate limiting ───────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.' },
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.' },
});
const internalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment.' },
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

// ── API Routes ─────────────────────────────────────────────────────────────
app.use('/api/auth',      authLimiter,     require('./routes/auth'));
app.use('/api/candidate', apiLimiter,      require('./routes/candidate'));
app.use('/api/employer',  apiLimiter,      require('./routes/employer'));
app.use('/api/internal',  internalLimiter, require('./routes/internal'));
app.use('/api/profile',   apiLimiter,      require('./routes/profile'));           // Public — no auth
app.use('/api/employer-interview', apiLimiter, require('./routes/employer-interviews')); // Token + employer auth

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
