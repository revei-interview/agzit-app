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
const { BrevoClient, BrevoEnvironment } = require('@getbrevo/brevo');
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

// ── Brevo email helper ─────────────────────────────────────────────────────
async function sendBrevoEmail({ to, toName, subject, html }) {
  const client = new BrevoClient({ apiKey: process.env.BREVO_API_KEY, environment: BrevoEnvironment.Production });
  return client.transactionalEmails.sendTransacEmail({
    sender:      { name: 'AGZIT AI', email: 'no-reply@mail.agzit.com' },
    to:          [{ email: to, ...(toName && { name: toName }) }],
    subject,
    htmlContent: html,
  });
}

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

    // Send OTP email via Brevo API
    await sendBrevoEmail({
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

    // ── Referral completion ──────────────────────────────────────────────────
    const refId = req.query.ref || req.body.ref;
    if (refId) {
      try {
        const [[referral]] = await db.query(
          'SELECT referrer_id FROM agzit_referrals WHERE id = ? AND status = "pending"',
          [refId]
        );

        if (referral) {
          const referrerId = referral.referrer_id;

          // Mark referral as completed
          await db.query(
            'UPDATE agzit_referrals SET status = "completed", referred_user_id = ?, completed_at = NOW() WHERE id = ?',
            [user_id, refId]
          );

          // Award 1 credit to referrer
          await db.query(
            `INSERT INTO agzit_candidate_credits (user_id, credit_balance, total_credits_earned)
             VALUES (?, 1, 1)
             ON DUPLICATE KEY UPDATE
               credit_balance = credit_balance + 1,
               total_credits_earned = total_credits_earned + 1`,
            [referrerId]
          );

          // Log transaction
          await db.query(
            `INSERT INTO agzit_credit_transactions (user_id, transaction_type, amount, description)
             VALUES (?, 'referral', 1, ?)`,
            [referrerId, `Referral completed: ${email}`]
          );

          // Send thank-you email to referrer
          try {
            const [[referrerUser]] = await db.query(
              'SELECT email, first_name FROM agzit_users WHERE id = ?',
              [referrerId]
            );
            if (referrerUser) {
              await fetch('https://api.brevo.com/v3/smtp/email', {
                method: 'POST',
                headers: {
                  'api-key': process.env.BREVO_API_KEY,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  to: [{ email: referrerUser.email }],
                  sender: { email: 'noreply@agzit.com', name: 'AGZIT' },
                  subject: 'Your referral joined! You earned 1 free Career Analyzer credit',
                  htmlContent: `
                    <h2>Referral Success!</h2>
                    <p>Great news, ${referrerUser.first_name || 'there'}! Your friend joined AGZIT.</p>
                    <p><strong>You've earned 1 free Career Analyzer credit!</strong></p>
                    <p>This credit is now in your account. Use it to generate your personalized career analysis.</p>
                    <p><a href="https://app.agzit.com/dashboard?tab=career-analyzer" style="background:#1A44C2;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;">View Career Analyzer</a></p>
                    <p>Keep referring to earn more credits!</p>
                  `
                })
              });
            }
          } catch (emailErr) {
            console.error('Referral thank-you email error:', emailErr.message);
          }
        }
      } catch (refErr) {
        console.error('Referral completion error:', refErr);
        // Don't fail signup if referral processing fails
      }
    }

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

// ── POST /api/auth/send-magic-link ─────────────────────────────────────────
// Send a passwordless login link to any registered employer email.
// Body: { email }

router.post('/send-magic-link', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
    }

    console.log('[magic-link] looking up:', email);

    // 1. Check Render-native agzit_users first
    let [[user]] = await db.query(
      'SELECT id FROM agzit_users WHERE email = ? LIMIT 1',
      [email]
    );
    let source = 'agzit_users';
    console.log('[magic-link] agzit_users:', user ? 'found id=' + user.id : 'not found');

    // 2. Fallback: check wp_users and auto-create agzit_users row
    if (!user) {
      const [[wpUser]] = await db.query(
        'SELECT ID, display_name FROM wp_users WHERE user_email = ? LIMIT 1',
        [email]
      );
      console.log('[magic-link] wp_users:', wpUser ? 'found id=' + wpUser.ID : 'not found');

      if (wpUser) {
        const [[capRow]] = await db.query(
          "SELECT meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key = 'wp_capabilities' LIMIT 1",
          [wpUser.ID]
        );
        const role      = parseWpRole(capRow?.meta_value || '');
        const firstName = (wpUser.display_name || '').split(' ')[0] || '';
        // Placeholder hash — magic link bypasses password check
        const placeholderHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 8);
        try {
          const [ins] = await db.query(
            `INSERT INTO agzit_users (email, password_hash, role, first_name, wp_user_id)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE wp_user_id = VALUES(wp_user_id)`,
            [email, placeholderHash, role, firstName, wpUser.ID]
          );
          const newId = ins.insertId || null;
          const [[fetched]] = await db.query('SELECT id FROM agzit_users WHERE email = ? LIMIT 1', [email]);
          user   = fetched || (newId ? { id: newId } : null);
          source = 'wp_users';
          console.log('[magic-link] wp_user migrated to agzit_users, id:', user?.id, 'role:', role);
        } catch (migErr) {
          console.error('[magic-link] wp_user migration failed:', migErr.message);
        }
      }
    }

    console.log('[magic-link] resolved user:', user ? 'id=' + user.id + ' source=' + source : 'null — skipping');

    if (user) {
      const token     = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

      await db.query(
        `INSERT INTO agzit_magic_links (token, user_id, purpose, expires_at)
         VALUES (?, ?, 'login', ?)
         ON DUPLICATE KEY UPDATE token=VALUES(token), expires_at=VALUES(expires_at), used_at=NULL`,
        [token, user.id, expiresAt]
      );
      console.log('[magic-link] token created:', token.substring(0, 8) + '…');

      const appUrl   = process.env.APP_URL || 'https://app.agzit.com';
      const magicUrl = `${appUrl}/login?ml=${token}`;
      try {
        await sendBrevoEmail({
          to:      email,
          subject: 'Your AGZIT login link',
          html: `<div style="font-family:'Plus Jakarta Sans',system-ui,sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;">
            <div style="font-size:24px;font-weight:800;color:#09101F;margin-bottom:8px;">AGZIT AI</div>
            <h2 style="font-size:20px;font-weight:800;color:#09101F;margin:0 0 16px;">Your magic login link</h2>
            <p style="color:#7C83A0;font-size:15px;line-height:1.7;margin:0 0 24px;">Click the button below to log in instantly. This link expires in <strong>15 minutes</strong> and can only be used once.</p>
            <div style="text-align:center;margin-bottom:24px;">
              <a href="${magicUrl}" style="display:inline-block;background:#1A44C2;color:#fff;text-decoration:none;padding:14px 36px;border-radius:10px;font-size:15px;font-weight:700;">Log in to AGZIT</a>
            </div>
            <p style="color:#B0B5CC;font-size:13px;line-height:1.7;">If you did not request this, you can safely ignore this email.</p>
          </div>`,
        });
        console.log('[magic-link] Brevo sent to:', email);
      } catch (emailErr) {
        console.error('[magic-link] Brevo FAILED:', emailErr.message, JSON.stringify(emailErr.response?.body || emailErr.response?.data || {}));
      }
    }

    // Always return ok to prevent user enumeration
    res.json({ ok: true, message: 'If this email is registered, a login link has been sent.' });
  } catch (err) {
    console.error('send-magic-link error:', err);
    res.status(500).json({ ok: false, error: 'Failed to send login link. Please try again.' });
  }
});

// ── GET /api/auth/magic-login ──────────────────────────────────────────────
// Exchange a magic link token for a JWT cookie.
// Query: ?token=...

router.get('/magic-login', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    if (!token) return res.status(400).json({ ok: false, error: 'Invalid token.' });

    const [[link]] = await db.query(
      'SELECT * FROM agzit_magic_links WHERE token = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1',
      [token]
    );

    if (!link) return res.status(410).json({ ok: false, error: 'Login link not found, already used, or expired. Please request a new one.' });

    // Mark as used
    await db.query('UPDATE agzit_magic_links SET used_at=NOW() WHERE id=?', [link.id]);

    // Fetch user
    const [[user]] = await db.query('SELECT * FROM agzit_users WHERE id=? LIMIT 1', [link.user_id]);
    if (!user) return res.status(404).json({ ok: false, error: 'Account not found.' });

    const jwtToken = issueToken(user);
    setCookie(res, jwtToken);

    let redirectTo = '/employer';
    if (user.role === 'dpr_candidate')  redirectTo = '/dashboard';
    if (user.role === 'dpr_employer')   redirectTo = '/employer-review';

    res.json({ ok: true, role: user.role, redirectTo });
  } catch (err) {
    console.error('magic-login error:', err);
    res.status(500).json({ ok: false, error: 'Login failed. Please try again.' });
  }
});

// ── GET /api/auth/accept-invite ────────────────────────────────────────────
// Accept a team invite via magic link token. Logs the member in directly.
// Query: ?token=...

router.get('/accept-invite', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    if (!token) return res.status(400).json({ ok: false, error: 'Invalid token.' });

    const [[link]] = await db.query(
      "SELECT * FROM agzit_magic_links WHERE token = ? AND purpose = 'team_invite' AND used_at IS NULL AND expires_at > NOW() LIMIT 1",
      [token]
    );

    if (!link) {
      return res.status(410).json({ ok: false, error: 'Invitation not found, already used, or expired. Please ask the admin to re-send the invite.' });
    }

    // Mark as used
    await db.query('UPDATE agzit_magic_links SET used_at = NOW() WHERE id = ?', [link.id]);

    // Fetch member's agzit_users row
    const [[user]] = await db.query('SELECT * FROM agzit_users WHERE id = ? LIMIT 1', [link.user_id]);
    if (!user) {
      return res.status(404).json({ ok: false, error: 'Account not found. Please contact the admin.' });
    }

    // Activate team membership
    await db.query(
      "UPDATE agzit_employer_team SET status = 'active', joined_at = NOW() WHERE member_user_id = ? AND status = 'invited'",
      [user.id]
    );

    // Ensure role is verified_employer
    if (user.role !== 'verified_employer') {
      await db.query("UPDATE agzit_users SET role = 'verified_employer' WHERE id = ?", [user.id]);
      user.role = 'verified_employer';
    }

    // Issue JWT cookie
    const jwtToken = issueToken({ ...user, role: 'verified_employer' });
    setCookie(res, jwtToken);

    res.json({ ok: true, redirectTo: '/employer' });
  } catch (err) {
    console.error('accept-invite error:', err);
    res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
  }
});

// ── POST /api/auth/logout ──────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('agzit_token');
  res.json({ ok: true });
});

// ── GET /api/auth/me ───────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const [[row]] = await db.query(
      'SELECT first_name FROM agzit_users WHERE id = ? LIMIT 1',
      [req.user.user_id]
    );
    const user = { ...req.user };
    if (row && row.first_name) user.first_name = row.first_name;
    res.json({ ok: true, user });
  } catch (err) {
    // Fallback to JWT payload if DB lookup fails
    res.json({ ok: true, user: req.user });
  }
});

module.exports = router;
