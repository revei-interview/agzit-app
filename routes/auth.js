// routes/auth.js
// POST /api/auth/send-otp
// POST /api/auth/verify-otp   (creates account)
// POST /api/auth/login
// POST /api/auth/logout
// GET  /api/auth/me

const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const db       = require('../config/db');
const { requireAuth } = require('../middleware/auth');

// ── Email transporter ──────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.MAIL_HOST,
  port:   parseInt(process.env.MAIL_PORT) || 465,
  secure: process.env.MAIL_SECURE === 'true',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

// ── Helpers ────────────────────────────────────────────────────────────────
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function issueToken(user) {
  return jwt.sign(
    {
      user_id:    user.id,
      email:      user.email,
      role:       user.role,
      wp_user_id: user.wp_user_id || null,
      first_name: user.first_name || '',
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

function setCookie(res, token) {
  res.cookie('agzit_token', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
  });
}

// ── POST /api/auth/send-otp ────────────────────────────────────────────────
// Body: { email, account_type: 'candidate' | 'employer' }
router.post('/send-otp', async (req, res) => {
  try {
    const { email, account_type } = req.body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
    }
    if (!['candidate', 'employer'].includes(account_type)) {
      return res.status(400).json({ ok: false, error: 'Please select Candidate or Employer.' });
    }

    // Check if email already registered
    const [existing] = await db.query(
      'SELECT id FROM agzit_users WHERE email = ? LIMIT 1',
      [email.toLowerCase()]
    );
    if (existing.length > 0) {
      return res.status(409).json({ ok: false, error: 'This email is already registered. Please login instead.' });
    }

    const otp     = generateOTP();
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store OTP (upsert)
    await db.query(
      `INSERT INTO agzit_otp_codes (email, otp, account_type, expires_at, attempts)
       VALUES (?, ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE otp=VALUES(otp), account_type=VALUES(account_type),
       expires_at=VALUES(expires_at), attempts=0`,
      [email.toLowerCase(), otp, account_type, expires]
    );

    // Send email
    await transporter.sendMail({
      from:    process.env.MAIL_FROM,
      to:      email,
      subject: 'Your AGZIT verification code',
      html: `
        <div style="font-family:'Plus Jakarta Sans',system-ui,sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;">
          <div style="font-size:24px;font-weight:800;color:#09101F;margin-bottom:8px;">AGZIT AI</div>
          <h2 style="font-size:20px;font-weight:800;color:#09101F;margin:0 0 16px;">Your verification code</h2>
          <p style="color:#7C83A0;font-size:15px;line-height:1.7;margin:0 0 24px;">
            Use the code below to verify your email and complete your registration.
            This code expires in <strong>10 minutes</strong>.
          </p>
          <div style="background:#F5F6FA;border:1px solid #E4E6EF;border-radius:16px;padding:32px;text-align:center;margin-bottom:24px;">
            <div style="font-size:42px;font-weight:800;color:#1A44C2;letter-spacing:12px;">${otp}</div>
          </div>
          <p style="color:#B0B5CC;font-size:13px;line-height:1.7;margin:0;">
            If you didn't request this, you can safely ignore this email.<br>
            Never share this code with anyone.
          </p>
        </div>
      `,
    });

    res.json({ ok: true, message: 'OTP sent successfully.' });

  } catch (err) {
    console.error('send-otp error:', err);
    res.status(500).json({ ok: false, error: 'Failed to send OTP. Please try again.' });
  }
});

// ── POST /api/auth/verify-otp ──────────────────────────────────────────────
// Body: { email, otp, password, first_name, last_name }
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp, password, first_name, last_name } = req.body;

    if (!email || !otp || !password) {
      return res.status(400).json({ ok: false, error: 'Email, OTP and password are required.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
    }

    // Fetch OTP record
    const [rows] = await db.query(
      'SELECT * FROM agzit_otp_codes WHERE email = ? LIMIT 1',
      [email.toLowerCase()]
    );

    if (rows.length === 0) {
      return res.status(400).json({ ok: false, error: 'No verification code found. Please request a new one.' });
    }

    const record = rows[0];

    // Check expiry
    if (new Date() > new Date(record.expires_at)) {
      await db.query('DELETE FROM agzit_otp_codes WHERE email = ?', [email.toLowerCase()]);
      return res.status(400).json({ ok: false, error: 'Verification code has expired. Please request a new one.' });
    }

    // Increment attempts (max 5)
    if (record.attempts >= 5) {
      await db.query('DELETE FROM agzit_otp_codes WHERE email = ?', [email.toLowerCase()]);
      return res.status(429).json({ ok: false, error: 'Too many failed attempts. Please request a new code.' });
    }

    if (record.otp !== otp.trim()) {
      await db.query('UPDATE agzit_otp_codes SET attempts = attempts + 1 WHERE email = ?', [email.toLowerCase()]);
      return res.status(400).json({ ok: false, error: 'Incorrect verification code. Please try again.' });
    }

    // OTP valid — create user
    const hashed = await bcrypt.hash(password, 12);
    const role   = record.account_type === 'employer' ? 'dpr_employer' : 'dpr_candidate';

    const [result] = await db.query(
      `INSERT INTO agzit_users (email, password_hash, role, first_name, last_name, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [email.toLowerCase(), hashed, role, first_name || '', last_name || '']
    );

    const user_id = result.insertId;

    // Clean up OTP
    await db.query('DELETE FROM agzit_otp_codes WHERE email = ?', [email.toLowerCase()]);

    // Issue JWT + set cookie
    const user  = { id: user_id, email: email.toLowerCase(), role, first_name: first_name || '', wp_user_id: null };
    const token = issueToken(user);
    setCookie(res, token);

    // Decide redirect
    const redirectTo = role === 'dpr_employer' ? '/employer' : '/register';

    res.json({ ok: true, role, redirectTo });

  } catch (err) {
    console.error('verify-otp error:', err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ ok: false, error: 'This email is already registered. Please login instead.' });
    }
    res.status(500).json({ ok: false, error: 'Registration failed. Please try again.' });
  }
});

// ── POST /api/auth/login ───────────────────────────────────────────────────
// Body: { email, password }
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Email and password are required.' });
    }

    const [rows] = await db.query(
      'SELECT * FROM agzit_users WHERE email = ? LIMIT 1',
      [email.toLowerCase()]
    );

    if (rows.length === 0) {
      return res.status(401).json({ ok: false, error: 'No account found with this email.' });
    }

    const user = rows[0];

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ ok: false, error: 'Incorrect password. Please try again.' });
    }

    const token = issueToken(user);
    setCookie(res, token);

    // Role-based redirect — mirrors WordPress agzit_redirect_by_role()
    let redirectTo = '/login';
    if (user.role === 'administrator')     redirectTo = '/wp-admin';
    else if (user.role === 'verified_employer') redirectTo = '/employer';
    else if (user.role === 'dpr_employer') redirectTo = '/employer-under-review';
    else if (user.role === 'dpr_candidate') redirectTo = '/dashboard';

    res.json({ ok: true, role: user.role, redirectTo });

  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ ok: false, error: 'Login failed. Please try again.' });
  }
});

// ── POST /api/auth/logout ──────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('agzit_token');
  res.json({ ok: true });
});

// ── GET /api/auth/me ───────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  res.json({ ok: true, user: req.user });
});

module.exports = router;
