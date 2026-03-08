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
const crypto   = require('crypto');
const db       = require('../config/db');
const { requireAuth } = require('../middleware/auth');

// ── WordPress password verification ────────────────────────────────────────
// WordPress uses phpass ($P$/$H$) for older installs, bcrypt ($2y$) for WP 6.8+.
// This verifier handles all three formats.

function phpassCheck(password, hash) {
  const itoa64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  function md5bin(s) { return crypto.createHash('md5').update(s, 'binary').digest('binary'); }

  const countLog2 = itoa64.indexOf(hash[3]);
  if (countLog2 < 0 || countLog2 > 30) return false;
  let count = 1 << countLog2;
  const salt = hash.substring(4, 12);
  if (salt.length !== 8) return false;

  let h = md5bin(salt + password);
  do { h = md5bin(h + password); } while (--count);

  function encode64(input, count) {
    let out = ''; let i = 0;
    do {
      let v = input.charCodeAt(i++);
      out += itoa64[v & 0x3f];
      if (i < count) v |= input.charCodeAt(i) << 8;
      out += itoa64[(v >> 6) & 0x3f];
      if (i++ >= count) break;
      if (i < count) v |= input.charCodeAt(i) << 8;
      out += itoa64[(v >> 12) & 0x3f];
      if (i++ >= count) break;
      out += itoa64[(v >> 18) & 0x3f];
    } while (i < count);
    return out;
  }

  return (hash.substring(0, 12) + encode64(h, 16)) === hash;
}

async function verifyWpPassword(password, wpHash) {
  if (!wpHash || !password) return false;

  // WP 6.8+: prefixed bcrypt — format is "$wp$2y$..."
  // "$wp" is 3 chars; slice(3) keeps the "$" separator → "$2y$10$..."
  if (wpHash.startsWith('$wp$')) {
    const inner = wpHash.slice(3); // "$wp$2y$..." → "$2y$..."
    const normalised = inner.replace(/^\$2y\$/, '$2b$');
    return bcrypt.compare(password, normalised);
  }
  // Bare bcrypt (no prefix): $2y$, $2b$, $2a$
  if (wpHash.startsWith('$2y$') || wpHash.startsWith('$2b$') || wpHash.startsWith('$2a$')) {
    const normalised = wpHash.replace(/^\$2y\$/, '$2b$');
    return bcrypt.compare(password, normalised);
  }
  // WP classic: phpass ($P$ or $H$)
  if (wpHash.startsWith('$P$') || wpHash.startsWith('$H$')) {
    return phpassCheck(password, wpHash);
  }
  // Very old WP: plain MD5 (32-char hex)
  return crypto.createHash('md5').update(password).digest('hex') === wpHash;
}

// Parse WP serialized capabilities → Render role string
// e.g. a:1:{s:17:"verified_employer";b:1;} → 'verified_employer'
function parseWpRole(capabilities) {
  if (!capabilities) return 'dpr_candidate';
  const roleMap = {
    verified_employer: 'verified_employer',
    dpr_employer:      'dpr_employer',
    dpr_candidate:     'dpr_candidate',
    administrator:     'administrator',
  };
  for (const [wpRole, renderRole] of Object.entries(roleMap)) {
    if (capabilities.includes('"' + wpRole + '"') || capabilities.includes("'" + wpRole + "'")) {
      return renderRole;
    }
  }
  return 'dpr_candidate';
}

// ── Email transporter ──────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:              process.env.MAIL_HOST,
  port:              587,
  secure:            false,       // false = STARTTLS on 587 (not direct SSL)
  requireTLS:        true,        // force TLS upgrade
  auth:              { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
  tls:               { rejectUnauthorized: false }, // accept Hostinger's cert chain
  connectionTimeout: 10000,
  greetingTimeout:   10000,
  socketTimeout:     10000,
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

    // Decide redirect — employers go to review page, candidates go to DPR profile form
    const redirectTo = role === 'dpr_employer' ? '/employer-review' : '/register';

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
// Supports two user sources:
//   1. agzit_users — accounts registered via Render (bcrypt hash)
//   2. wp_users    — accounts created in WordPress (phpass or bcrypt hash)
//      On first successful WP login, auto-migrates account into agzit_users.
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: 'Email and password are required.' });
    }

    const emailLower = email.toLowerCase();

    // ── 1. Check Render-native agzit_users table ───────────────────────────
    const [rows] = await db.query(
      'SELECT * FROM agzit_users WHERE email = ? LIMIT 1',
      [emailLower]
    );

    if (rows.length > 0) {
      const user = rows[0];
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ ok: false, error: 'Incorrect password. Please try again.' });
      }
      const token = issueToken(user);
      setCookie(res, token);
      let redirectTo = '/dashboard';
      if (user.role === 'verified_employer') redirectTo = '/employer';
      else if (user.role === 'dpr_employer') redirectTo = '/employer-review';
      return res.json({ ok: true, role: user.role, redirectTo });
    }

    // ── 2. Fallback: check WordPress wp_users (WP-origin accounts) ─────────
    const [wpRows] = await db.query(
      'SELECT ID, user_login, user_email, user_pass, display_name FROM wp_users WHERE user_email = ? LIMIT 1',
      [emailLower]
    );

    if (wpRows.length === 0) {
      return res.status(401).json({ ok: false, error: 'No account found with this email.' });
    }

    const wpUser = wpRows[0];
    const wpValid = await verifyWpPassword(password, wpUser.user_pass);
    if (!wpValid) {
      return res.status(401).json({ ok: false, error: 'Incorrect password. Please try again.' });
    }

    // Get WP role from usermeta
    const [[capRow]] = await db.query(
      "SELECT meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key = 'wp_capabilities' LIMIT 1",
      [wpUser.ID]
    );
    const role = parseWpRole(capRow?.meta_value || '');

    // Get first/last name from usermeta
    const [nameMeta] = await db.query(
      "SELECT meta_key, meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key IN ('first_name','last_name')",
      [wpUser.ID]
    );
    const nameLookup = {};
    nameMeta.forEach(m => { nameLookup[m.meta_key] = m.meta_value; });
    const firstName = nameLookup.first_name || wpUser.display_name.split(' ')[0] || '';
    const lastName  = nameLookup.last_name  || '';

    // Get linked dpr_profile post ID if available
    const [[profileMeta]] = await db.query(
      "SELECT meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key = 'dpr_profile_post_id' LIMIT 1",
      [wpUser.ID]
    ).catch(() => [[null]]);
    const dprProfileId = profileMeta?.meta_value ? parseInt(profileMeta.meta_value) : null;

    // Auto-migrate WP account into agzit_users with a bcrypt hash for future logins
    const newHash = await bcrypt.hash(password, 12);
    let newUserId;
    try {
      const [ins] = await db.query(
        `INSERT INTO agzit_users (email, password_hash, role, first_name, last_name, wp_user_id, dpr_profile_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           password_hash  = VALUES(password_hash),
           role           = VALUES(role),
           wp_user_id     = VALUES(wp_user_id),
           dpr_profile_id = VALUES(dpr_profile_id)`,
        [emailLower, newHash, role, firstName, lastName, wpUser.ID, dprProfileId]
      );
      newUserId = ins.insertId || null;
    } catch (insertErr) {
      console.error('[login] agzit_users upsert failed:', insertErr.message);
      // Continue anyway — we can still issue a token without persisting
    }

    // Fetch the newly inserted/updated row so issueToken has the right shape
    const [[freshUser]] = await db.query(
      'SELECT * FROM agzit_users WHERE email = ? LIMIT 1',
      [emailLower]
    ).catch(() => [[null]]);

    const tokenUser = freshUser || {
      id: newUserId, email: emailLower, role,
      first_name: firstName, wp_user_id: wpUser.ID,
    };

    const token = issueToken(tokenUser);
    setCookie(res, token);

    let redirectTo = '/dashboard';
    if (role === 'verified_employer') redirectTo = '/employer';
    else if (role === 'dpr_employer') redirectTo = '/employer-review';

    console.log(`[login] WP user migrated: ${emailLower} role=${role}`);
    res.json({ ok: true, role, redirectTo });

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
