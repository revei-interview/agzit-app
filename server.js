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
  origin:      ['https://agzit.com', 'https://www.agzit.com', 'https://app.agzit.com'],
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

// Candidate scorecard detail page
app.get('/scorecard', requireAuth, requireRole('dpr_candidate'), (req, res) => {
  res.sendFile(path.join(__dirname, 'public/scorecard/index.html'));
});

// Employer-scheduled interview room — PUBLIC (token-based, no WP login required)
app.get('/employer-interviews', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/employer-interviews/index.html'));
});

// Public candidate profile viewer — no auth required
app.get('/profile', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/profile/index.html'));
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

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 AGZIT App running on port ${PORT}`);
  console.log(`   ENV: ${process.env.NODE_ENV}`);
  console.log(`   WP:  ${process.env.WP_URL}`);
});
