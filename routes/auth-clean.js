// routes/auth.js
const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const db       = require('../config/db');
const { requireAuth } = require('../middleware/auth');

const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST,
  port: parseInt(process.env.MAIL_PORT) || 465,
  secure: process.env.MAIL_SECURE === 'true',
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
});

function generateOTP() { return Math.floor(100000 + Math.random() * 900000).toString(); }

function issueToken(user) {
  return jwt.sign(
    { user_id: user.id, email: user.email, role: user.role, wp_user_id: user.wp_user_id || null, first_name: user.first_name || '' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

function setCookie(res, token) {
  res.cookie('agzit_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 });
}

router.post('/send-otp', async (req, res) => {
  try {
    const { email, account_type } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Please enter a valid email.' });
    if (!['candidate', 'employer'].includes(account_type)) return res.status(400).json({ ok: false, error: 'Please select Candidate or Employer.' });
    const [existing] = await db.query('SELECT id FROM agzit_users WHERE email = ? LIMIT 1', [email.toLowerCase()]);
    if (existing.length > 0) return res.status(409).json({ ok: false, error: 'Email already registered. Please login.' });
    const otp = generateOTP();
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    await db.query(`INSERT INTO agzit_otp_codes (email, otp, account_type, expires_at, attempts) VALUES (?, ?, ?, ?, 0) ON DUPLICATE KEY UPDATE otp=VALUES(otp), account_type=VALUES(account_type), expires_at=VALUES(expires_at), attempts=0`, [email.toLowerCase(), otp, account_type, expires]);
    await transporter.sendMail({ from: process.env.MAIL_FROM, to: email, subject: 'Your AGZIT verification code', html: `<div style="font-family:sans-serif;padding:40px"><h2 style="color:#09101F">Your verification code</h2><div style="font-size:48px;font-weight:800;color:#1A44C2;letter-spacing:12px;padding:24px;background:#EAF0FF;border-radius:12px;text-align:center">${otp}</div><p>Expires in 10 minutes.</p></div>` });
    res.json({ ok: true });
  } catch (err) { console.error('send-otp error:', err); res.status(500).json({ ok: false, error: 'Failed to send OTP.' }); }
});

router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp, password, first_name, last_name } = req.body;
    if (!email || !otp || !password) return res.status(400).json({ ok: false, error: 'Email, OTP and password required.' });
    if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be 8+ characters.' });
    const [rows] = await db.query('SELECT * FROM agzit_otp_codes WHERE email = ? LIMIT 1', [email.toLowerCase()]);
    if (rows.length === 0) return res.status(400).json({ ok: false, error: 'No code found. Request a new one.' });
    const record = rows[0];
    if (new Date() > new Date(record.expires_at)) { await db.query('DELETE FROM agzit_otp_codes WHERE email = ?', [email.toLowerCase()]); return res.status(400).json({ ok: false, error: 'Code expired.' }); }
    if (record.attempts >= 5) { await db.query('DELETE FROM agzit_otp_codes WHERE email = ?', [email.toLowerCase()]); return res.status(429).json({ ok: false, error: 'Too many attempts.' }); }
    if (record.otp !== otp.trim()) { await db.query('UPDATE agzit_otp_codes SET attempts = attempts + 1 WHERE email = ?', [email.toLowerCase()]); return res.status(400).json({ ok: false, error: 'Incorrect code.' }); }
    const hashed = await bcrypt.hash(password, 12);
    const role = record.account_type === 'employer' ? 'dpr_employer' : 'dpr_candidate';
    const [result] = await db.query(`INSERT INTO agzit_users (email, password_hash, role, first_name, last_name) VALUES (?, ?, ?, ?, ?)`, [email.toLowerCase(), hashed, role, first_name || '', last_name || '']);
    await db.query('DELETE FROM agzit_otp_codes WHERE email = ?', [email.toLowerCase()]);
    const user = { id: result.insertId, email: email.toLowerCase(), role, first_name: first_name || '', wp_user_id: null };
    setCookie(res, issueToken(user));
    res.json({ ok: true, role, redirectTo: role === 'dpr_employer' ? '/employer' : '/register' });
  } catch (err) {
    console.error('verify-otp error:', err);
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ ok: false, error: 'Email already registered.' });
    res.status(500).json({ ok: false, error: 'Registration failed.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password required.' });
    const [rows] = await db.query('SELECT * FROM agzit_users WHERE email = ? LIMIT 1', [email.toLowerCase()]);
    if (rows.length === 0) return res.status(401).json({ ok: false, error: 'No account found.' });
    const user = rows[0];
    if (!await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ ok: false, error: 'Incorrect password.' });
    setCookie(res, issueToken(user));
    let redirectTo = '/login';
    if (user.role === 'administrator') redirectTo = '/wp-admin';
    else if (user.role === 'verified_employer') redirectTo = '/employer';
    else if (user.role === 'dpr_employer') redirectTo = '/employer-under-review';
    else if (user.role === 'dpr_candidate') redirectTo = '/dashboard';
    res.json({ ok: true, role: user.role, redirectTo });
  } catch (err) { console.error('login error:', err); res.status(500).json({ ok: false, error: 'Login failed.' }); }
});

router.post('/logout', (req, res) => { res.clearCookie('agzit_token'); res.json({ ok: true }); });

router.get('/me', requireAuth, (req, res) => { res.json({ ok: true, user: req.user }); });

module.exports = router;
