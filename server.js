// server.js — AGZIT App Entry Point
require('dotenv').config();

const express      = require('express');
const cookieParser = require('cookie-parser');
const cors         = require('cors');
const path         = require('path');

const app = express();

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(cors({
  origin:      process.env.WP_URL || 'https://agzit.com',
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Static files ───────────────────────────────────────────────────────────
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));

// ── API Routes ─────────────────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'));
// app.use('/api/candidate', require('./routes/candidate'));  // coming next session
// app.use('/api/employer',  require('./routes/employer'));   // coming next session

// ── Page Routes ────────────────────────────────────────────────────────────

// Login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/login/index.html'));
});

// Registration page (DPR profile form — after account created)
app.get('/register', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/register/index.html'));
});

// Placeholder dashboard routes (will be full pages next session)
app.get('/dashboard', (req, res) => {
  res.redirect('/login?next=/dashboard');
});

app.get('/employer', (req, res) => {
  res.redirect('/login?next=/employer');
});

// Logout (GET for simple link clicks)
app.get('/logout', (req, res) => {
  res.clearCookie('agzit_token');
  res.redirect(process.env.WP_URL + '/');
});

// Health check (Render uses this)
app.get('/health', (req, res) => {
  res.json({ ok: true, env: process.env.NODE_ENV });
});

// 404
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public/404.html'));
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 AGZIT App running on port ${PORT}`);
  console.log(`   ENV: ${process.env.NODE_ENV}`);
  console.log(`   WP:  ${process.env.WP_URL}`);
});
