// routes/employer.js — Employer API routes
// Field names sourced directly from:
//   dpr-employer-application-fluent-form-35-otp-admin-approve.code-snippets.php
//   employer-interview-acf-fields.code-snippets.php
//   employer-interview-form-handler.code-snippets.php
//   dpr-helpers-mask-unmask-check.code-snippets.php

const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');

// Guards
const guardAny      = [requireAuth, requireRole('dpr_employer', 'verified_employer')];
const guardVerified = [requireAuth, requireRole('verified_employer')];

// ── Helpers ──────────────────────────────────────────────────────────────────

// Fetch selected wp_usermeta keys for a WP user
async function fetchUserMeta(wpUserId, keys) {
  if (!wpUserId || !keys.length) return {};
  const ph = keys.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT meta_key, meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key IN (${ph})`,
    [wpUserId, ...keys]
  );
  const meta = {};
  for (const r of rows) meta[r.meta_key] = r.meta_value;
  return meta;
}

// Fetch selected wp_postmeta keys for a single WP post
async function fetchPostMeta(postId, keys) {
  if (!postId || !keys.length) return {};
  const ph = keys.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT meta_key, meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key IN (${ph})`,
    [postId, ...keys]
  );
  const meta = {};
  for (const r of rows) meta[r.meta_key] = r.meta_value;
  return meta;
}

// Fetch wp_postmeta for a list of post IDs in one query
async function fetchBulkPostMeta(postIds, keys) {
  if (!postIds.length || !keys.length) return {};
  const idPh  = postIds.map(() => '?').join(',');
  const keyPh = keys.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT post_id, meta_key, meta_value
     FROM wp_postmeta
     WHERE post_id IN (${idPh}) AND meta_key IN (${keyPh})`,
    [...postIds, ...keys]
  );
  // Group by post_id
  const map = {};
  for (const r of rows) {
    if (!map[r.post_id]) map[r.post_id] = {};
    map[r.post_id][r.meta_key] = r.meta_value;
  }
  return map;
}

// Parse the employer's unlocked_profiles JSON user meta
function parseUnlockedMap(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch { return {}; }
}

// Check if an employer has unlocked a DPR profile (and it hasn't expired)
function isProfileUnlocked(unlockedMap, dprId) {
  if (!dprId) return false;
  const entry = unlockedMap[dprId];
  if (!entry) return false;
  const expires = parseInt(entry.expires) || 0;
  if (expires > 0 && Math.floor(Date.now() / 1000) > expires) return false;
  return true;
}

// SELECT + UPDATE or INSERT for wp_usermeta (safe upsert — WP schema has no unique key on user_id+meta_key)
async function upsertUserMeta(wpUserId, metaKey, metaValue) {
  const [rows] = await pool.execute(
    'SELECT umeta_id FROM wp_usermeta WHERE user_id = ? AND meta_key = ? LIMIT 1',
    [wpUserId, metaKey]
  );
  if (rows.length > 0) {
    await pool.execute(
      'UPDATE wp_usermeta SET meta_value = ? WHERE umeta_id = ?',
      [String(metaValue), rows[0].umeta_id]
    );
  } else {
    await pool.execute(
      'INSERT INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (?, ?, ?)',
      [wpUserId, metaKey, String(metaValue)]
    );
  }
}

// Fetch employer_interview posts for a given WP user ID
// employer_user_id ACF postmeta = WP user ID (integer stored as string in meta_value)
const INTERVIEW_KEYS = [
  'candidate_name', 'candidate_email', 'total_work_experience',
  'interview_role', 'session_type', 'scheduled_at',
  'interview_status', 'join_url', 'join_token', 'session_id',
  'mock_overall_score', 'mock_performance_level', 'emp_readiness_band',
  'audio_url', 'video_url',
];

async function fetchEmployerInterviews(wpUserId, limit) {
  if (!wpUserId) return [];
  const [posts] = await pool.execute(
    `SELECT p.ID, p.post_title, p.post_date
     FROM wp_posts p
     INNER JOIN wp_postmeta em ON em.post_id = p.ID
       AND em.meta_key = 'employer_user_id'
       AND em.meta_value = ?
     WHERE p.post_type = 'employer_interview'
       AND p.post_status = 'publish'
     ORDER BY p.post_date DESC
     LIMIT ?`,
    [String(wpUserId), limit]
  );

  if (!posts.length) return [];

  const postIds = posts.map(p => p.ID);
  const metaMap = await fetchBulkPostMeta(postIds, INTERVIEW_KEYS);

  return posts.map(post => {
    const m = metaMap[post.ID] || {};
    return {
      id:                     post.ID,
      post_title:             post.post_title,
      post_date:              post.post_date,
      candidate_name:         m.candidate_name          || null,
      candidate_email:        m.candidate_email         || null,
      total_work_experience:  m.total_work_experience   || null,
      interview_role:         m.interview_role          || null,
      session_type:           m.session_type            || null,
      scheduled_at:           m.scheduled_at            || null,
      interview_status:       m.interview_status        || null,
      join_url:               m.join_url                || null,
      join_token:             m.join_token              || null,
      session_id:             m.session_id              || null,
      mock_overall_score:     m.mock_overall_score      || null,
      mock_performance_level: m.mock_performance_level  || null,
      emp_readiness_band:     m.emp_readiness_band      || null,
      audio_url:              m.audio_url               || null,
      video_url:              m.video_url               || null,
    };
  });
}

// ── GET /api/employer/dashboard ───────────────────────────────────────────────
// Employer info + company summary + unlock counters + recent 5 interviews

router.get('/dashboard', ...guardAny, async (req, res) => {
  try {
    const [[user]] = await pool.execute(
      'SELECT id, email, first_name, last_name, wp_user_id, role, created_at FROM agzit_users WHERE id = ?',
      [req.user.user_id]
    );
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    const wpId = user.wp_user_id;

    // Build date keys (UTC) for unlock counters
    // Note: WP uses site timezone; we use UTC here as a best-effort approximation
    const now = new Date();
    const ym  = now.getUTCFullYear() + String(now.getUTCMonth() + 1).padStart(2, '0');
    const ymd = ym + String(now.getUTCDate()).padStart(2, '0');

    const EMPLOYER_META_KEYS = [
      'dpr_company_name',
      'dpr_designation',
      'dpr_department',
      'dpr_verified_work_email',
      'dpr_employer_application_status',
      'dpr_verified_until',
      'dpr_verified_linkedin',
      `dpr_unlock_used_${ym}`,
      `dpr_unlock_used_${ymd}`,
    ];

    const meta = wpId ? await fetchUserMeta(wpId, EMPLOYER_META_KEYS) : {};

    const usedMonth = parseInt(meta[`dpr_unlock_used_${ym}`])  || 0;
    const usedDay   = parseInt(meta[`dpr_unlock_used_${ymd}`]) || 0;

    const recentInterviews = await fetchEmployerInterviews(wpId, 5);

    res.json({
      ok: true,
      user: {
        id:         user.id,
        email:      user.email,
        first_name: user.first_name,
        last_name:  user.last_name,
        role:       user.role,
        created_at: user.created_at,
      },
      employer_profile: {
        company_name:        meta.dpr_company_name                    || null,
        designation:         meta.dpr_designation                     || null,
        department:          meta.dpr_department                      || null,
        work_email:          meta.dpr_verified_work_email             || null,
        application_status:  meta.dpr_employer_application_status     || null,  // otp_sent | email_verified | approved
        verified_until:      meta.dpr_verified_until ? parseInt(meta.dpr_verified_until) : null,
        linkedin_url:        meta.dpr_verified_linkedin               || null,
      },
      unlock_stats: {
        used_today:          usedDay,
        used_this_month:     usedMonth,
        limit_daily:         5,
        limit_monthly:       50,
        remaining_today:     Math.max(0, 5  - usedDay),
        remaining_monthly:   Math.max(0, 50 - usedMonth),
      },
      recent_interviews: recentInterviews,
    });
  } catch (err) {
    console.error('[employer/dashboard]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/employer/profile ─────────────────────────────────────────────────
// Full employer company profile — all wp_usermeta fields set during Form 35 submission

router.get('/profile', ...guardAny, async (req, res) => {
  try {
    const [[user]] = await pool.execute(
      'SELECT id, email, first_name, last_name, wp_user_id, role, created_at FROM agzit_users WHERE id = ?',
      [req.user.user_id]
    );
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    const PROFILE_KEYS = [
      'dpr_employer_first_name',      // from Form 35 field: employer_f_names
      'dpr_verified_work_email',       // from Form 35 field: employer_f_email
      'dpr_verified_linkedin',         // from Form 35 field: employer_f_url
      'dpr_company_name',              // from Form 35 field: employer_f_company_name
      'dpr_company_website',           // from Form 35 field: employer_f_company_website
      'dpr_designation',               // from Form 35 field: employer_f_designation
      'dpr_department',                // from Form 35 field: employer_f_department
      'dpr_designation_proof',         // from Form 35 field: employer_f_upload_proof
      'dpr_designation_proof_url',     // duplicate key kept for compatibility
      'dpr_employer_application_status', // otp_sent | email_verified | approved
      'dpr_employer_applied_at',       // Unix timestamp of application submission
      'dpr_verified_until',            // Unix timestamp — set by admin on approval (+365 days)
      'dpr_verified_at',               // Unix timestamp — set when OTP verified
    ];

    const meta = user.wp_user_id
      ? await fetchUserMeta(user.wp_user_id, PROFILE_KEYS)
      : {};

    res.json({
      ok: true,
      profile: {
        first_name:          meta.dpr_employer_first_name              || user.first_name,
        work_email:          meta.dpr_verified_work_email              || null,
        linkedin_url:        meta.dpr_verified_linkedin                || null,
        company_name:        meta.dpr_company_name                     || null,
        company_website:     meta.dpr_company_website                  || null,
        designation:         meta.dpr_designation                      || null,
        department:          meta.dpr_department                       || null,
        designation_proof:   meta.dpr_designation_proof_url            || meta.dpr_designation_proof || null,
        application_status:  meta.dpr_employer_application_status      || null,
        applied_at:          meta.dpr_employer_applied_at              ? parseInt(meta.dpr_employer_applied_at) : null,
        verified_until:      meta.dpr_verified_until                   ? parseInt(meta.dpr_verified_until) : null,
        verified_at:         meta.dpr_verified_at                      ? parseInt(meta.dpr_verified_at) : null,
      },
    });
  } catch (err) {
    console.error('[employer/profile]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/employer/candidates ──────────────────────────────────────────────
// Paginated list of public, approved dpr_profile candidates
// Query params: page, per_page, domain, career_level, open_for_work

const CANDIDATE_KEYS = [
  'dpr_id',
  'full_name',
  'compliance_domains',
  'current_career_level',
  'current_employment_status',
  'total_work_experience',
  'desired_role',
  'open_for_work_badge',
  'residential_city',
  'residential_country',
  'profile_completeness',
  'preferred_work_type',
  'notice_period_in_days',
  'current_annual_ctc_with_currency',
  'expected_annual_ctc_with_currency',
];

router.get('/candidates', ...guardVerified, async (req, res) => {
  try {
    const page       = Math.max(1, parseInt(req.query.page)     || 1);
    const per_page   = Math.min(50, Math.max(1, parseInt(req.query.per_page) || 20));
    const domain     = typeof req.query.domain === 'string'       ? req.query.domain.trim()       : '';
    const career_lvl = typeof req.query.career_level === 'string' ? req.query.career_level.trim() : '';
    const open_only  = req.query.open_for_work === '1' || req.query.open_for_work === 'true';
    const offset     = (page - 1) * per_page;

    // Build JOINs for required + optional filters
    let joins  = '';
    let params = [];

    // Required: profile_visibility = 'public' AND dpr_status = 'approved'
    joins += " INNER JOIN wp_postmeta pv ON pv.post_id = p.ID AND pv.meta_key = 'profile_visibility' AND pv.meta_value = 'public'";
    joins += " INNER JOIN wp_postmeta ps ON ps.post_id = p.ID AND ps.meta_key = 'dpr_status' AND ps.meta_value = 'approved'";

    if (domain) {
      joins += " INNER JOIN wp_postmeta pd ON pd.post_id = p.ID AND pd.meta_key = 'compliance_domains' AND pd.meta_value = ?";
      params.push(domain);
    }
    if (career_lvl) {
      joins += " INNER JOIN wp_postmeta pc ON pc.post_id = p.ID AND pc.meta_key = 'current_career_level' AND pc.meta_value = ?";
      params.push(career_lvl);
    }
    if (open_only) {
      joins += " INNER JOIN wp_postmeta pw ON pw.post_id = p.ID AND pw.meta_key = 'open_for_work_badge' AND pw.meta_value = '1'";
    }

    const baseSQL = `FROM wp_posts p${joins} WHERE p.post_type = 'dpr_profile' AND p.post_status = 'publish'`;

    // Total count
    const [[{ total }]] = await pool.execute(
      `SELECT COUNT(DISTINCT p.ID) AS total ${baseSQL}`,
      params
    );

    // Profile IDs for this page
    const [idRows] = await pool.execute(
      `SELECT DISTINCT p.ID ${baseSQL} ORDER BY p.ID DESC LIMIT ? OFFSET ?`,
      [...params, per_page, offset]
    );

    if (!idRows.length) {
      return res.json({ ok: true, total: parseInt(total), page, per_page, total_pages: 0, candidates: [] });
    }

    // Bulk fetch meta for all profile IDs in one query
    const postIds  = idRows.map(r => r.ID);
    const metaMap  = await fetchBulkPostMeta(postIds, CANDIDATE_KEYS);

    // Employer's unlocked_profiles map
    let unlockedMap = {};
    if (req.user.wp_user_id) {
      const empMeta = await fetchUserMeta(req.user.wp_user_id, ['unlocked_profiles']);
      unlockedMap = parseUnlockedMap(empMeta.unlocked_profiles);
    }

    const candidates = postIds.map(id => {
      const m     = metaMap[id] || {};
      const dprId = m.dpr_id || null;
      return {
        post_id:                           id,
        dpr_id:                            dprId,
        full_name:                         m.full_name                        || null,
        compliance_domains:                m.compliance_domains               || null,  // "Industry / Functional Area"
        current_career_level:              m.current_career_level             || null,
        current_employment_status:         m.current_employment_status        || null,
        total_work_experience:             m.total_work_experience            || null,
        desired_role:                      m.desired_role                     || null,
        open_for_work_badge:               m.open_for_work_badge === '1',
        residential_city:                  m.residential_city                 || null,
        residential_country:               m.residential_country              || null,
        profile_completeness:              parseInt(m.profile_completeness)   || 0,
        preferred_work_type:               m.preferred_work_type              || null,
        notice_period_in_days:             m.notice_period_in_days            || null,
        current_annual_ctc_with_currency:  m.current_annual_ctc_with_currency || null,
        expected_annual_ctc_with_currency: m.expected_annual_ctc_with_currency || null,
        is_unlocked:                       isProfileUnlocked(unlockedMap, dprId),
      };
    });

    res.json({
      ok:          true,
      total:       parseInt(total),
      page,
      per_page,
      total_pages: Math.ceil(parseInt(total) / per_page),
      candidates,
    });
  } catch (err) {
    console.error('[employer/candidates]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/employer/verify-otp ─────────────────────────────────────────────
// Verify work email OTP after employer submits their application (Form 35 equivalent)
// Body: { work_email, otp }
// On success: sets dpr_employer_application_status = 'email_verified' in wp_usermeta

router.post('/verify-otp', requireAuth, async (req, res) => {
  try {
    const { work_email, otp } = req.body;

    if (!work_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(work_email)) {
      return res.status(400).json({ ok: false, error: 'A valid work email is required.' });
    }
    if (!otp || !otp.trim()) {
      return res.status(400).json({ ok: false, error: 'OTP is required.' });
    }

    const email = work_email.toLowerCase().trim();

    // Find OTP record (account_type = 'employer' matches what auth.js stores for employer accounts)
    const [rows] = await pool.execute(
      "SELECT * FROM agzit_otp_codes WHERE email = ? AND account_type = 'employer' LIMIT 1",
      [email]
    );

    if (!rows.length) {
      return res.status(400).json({ ok: false, error: 'No verification code found. Please request a new OTP.' });
    }

    const record = rows[0];

    if (new Date() > new Date(record.expires_at)) {
      await pool.execute('DELETE FROM agzit_otp_codes WHERE email = ?', [email]);
      return res.status(400).json({ ok: false, error: 'OTP has expired. Please request a new one.' });
    }

    if (record.attempts >= 5) {
      await pool.execute('DELETE FROM agzit_otp_codes WHERE email = ?', [email]);
      return res.status(429).json({ ok: false, error: 'Too many failed attempts. Please request a new OTP.' });
    }

    if (record.otp !== otp.trim()) {
      await pool.execute(
        'UPDATE agzit_otp_codes SET attempts = attempts + 1 WHERE email = ?',
        [email]
      );
      return res.status(400).json({ ok: false, error: 'Incorrect OTP. Please try again.' });
    }

    // OTP valid — clean up
    await pool.execute('DELETE FROM agzit_otp_codes WHERE email = ?', [email]);

    // Update wp_usermeta for the linked WP user
    const wpUserId = req.user.wp_user_id;
    if (wpUserId) {
      const nowTs = String(Math.floor(Date.now() / 1000));
      await upsertUserMeta(wpUserId, 'dpr_employer_application_status', 'email_verified');
      await upsertUserMeta(wpUserId, 'dpr_verified_work_email', email);
      await upsertUserMeta(wpUserId, 'dpr_verified_at', nowTs);
    }

    res.json({
      ok:      true,
      message: 'Work email verified. Your application is under review and will be approved by our team.',
    });
  } catch (err) {
    console.error('[employer/verify-otp]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
