// routes/employer.js — Employer API routes
// Field names sourced directly from:
//   dpr-employer-application-fluent-form-35-otp-admin-approve.code-snippets.php
//   employer-interview-acf-fields.code-snippets.php
//   employer-interview-form-handler.code-snippets.php
//   dpr-helpers-mask-unmask-check.code-snippets.php

const express    = require('express');
const router     = express.Router();
const pool       = require('../config/db');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
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
// Query params: page, per_page, domain, career_level, emp_status, work_type, country, open_for_work

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
    const domain     = typeof req.query.domain       === 'string' ? req.query.domain.trim()       : '';
    const career_lvl = typeof req.query.career_level === 'string' ? req.query.career_level.trim() : '';
    const emp_status = typeof req.query.emp_status   === 'string' ? req.query.emp_status.trim()   : '';
    const work_type  = typeof req.query.work_type    === 'string' ? req.query.work_type.trim()    : '';
    const country    = typeof req.query.country      === 'string' ? req.query.country.trim()      : '';
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
      // Also match legacy 'lLead' typo when filtering for 'Lead'
      if (career_lvl === 'Lead') {
        joins += " INNER JOIN wp_postmeta pc ON pc.post_id = p.ID AND pc.meta_key = 'current_career_level' AND (pc.meta_value = 'Lead' OR pc.meta_value = 'lLead')";
      } else {
        joins += " INNER JOIN wp_postmeta pc ON pc.post_id = p.ID AND pc.meta_key = 'current_career_level' AND pc.meta_value = ?";
        params.push(career_lvl);
      }
    }
    if (emp_status) {
      joins += " INNER JOIN wp_postmeta pe ON pe.post_id = p.ID AND pe.meta_key = 'current_employment_status' AND pe.meta_value = ?";
      params.push(emp_status);
    }
    if (work_type) {
      joins += " INNER JOIN wp_postmeta pwt ON pwt.post_id = p.ID AND pwt.meta_key = 'preferred_work_type' AND pwt.meta_value = ?";
      params.push(work_type);
    }
    if (country) {
      joins += " INNER JOIN wp_postmeta pco ON pco.post_id = p.ID AND pco.meta_key = 'residential_country' AND pco.meta_value LIKE ?";
      params.push('%' + country + '%');
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

// ── Helpers: masking for unverified contact display ───────────────────────────

function maskEmail(email) {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at < 0) return '****';
  return email.slice(0, Math.min(2, at)) + '****' + email.slice(at);
}

function maskPhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return digits.slice(0, 2) + '****' + digits.slice(-2);
}

// ── GET /api/employer/search?dpr_id=... ───────────────────────────────────────
// Look up a candidate by their DPR ID; returns masked contact if not unlocked

router.get('/search', ...guardVerified, async (req, res) => {
  try {
    const dprId = typeof req.query.dpr_id === 'string' ? req.query.dpr_id.trim().toUpperCase() : '';
    if (!dprId) return res.status(400).json({ ok: false, error: 'dpr_id is required' });

    // Find the profile post by dpr_id meta field
    const [[idRow]] = await pool.execute(
      "SELECT post_id FROM wp_postmeta WHERE meta_key = 'dpr_id' AND meta_value = ? LIMIT 1",
      [dprId]
    );
    if (!idRow) return res.status(404).json({ ok: false, error: 'Candidate not found' });

    const postId = idRow.post_id;

    const SEARCH_KEYS = [
      'dpr_id', 'full_name', 'email_address', 'phone_number',
      'compliance_domains', 'current_career_level', 'current_employment_status',
      'total_work_experience', 'desired_role', 'open_for_work_badge',
      'residential_city', 'residential_country',
      'profile_completeness', 'preferred_work_type', 'notice_period_in_days',
      'current_annual_ctc_with_currency', 'expected_annual_ctc_with_currency',
      'professional_summary_bio', 'linkedin_url', 'soft_skills',
      'profile_visibility', 'contact_visibility', 'dpr_status',
    ];

    const m = await fetchPostMeta(postId, SEARCH_KEYS);

    // Enforce visibility — only public + approved profiles are searchable
    if (m.profile_visibility !== 'public' || m.dpr_status !== 'approved') {
      return res.status(404).json({ ok: false, error: 'Candidate not found' });
    }

    // Check if this employer has already unlocked the profile
    let isUnlocked = false;
    if (req.user.wp_user_id) {
      const empMeta = await fetchUserMeta(req.user.wp_user_id, ['unlocked_profiles']);
      isUnlocked = isProfileUnlocked(parseUnlockedMap(empMeta.unlocked_profiles), dprId);
    }

    const contactVis  = m.contact_visibility || 'co_verified_only';
    const revealContact = isUnlocked || contactVis === 'co_public';

    res.json({
      ok: true,
      candidate: {
        post_id:                          postId,
        dpr_id:                           m.dpr_id,
        full_name:                        m.full_name                        || null,
        email_address:                    revealContact ? (m.email_address   || null) : maskEmail(m.email_address),
        phone_number:                     revealContact ? (m.phone_number    || null) : maskPhone(m.phone_number),
        compliance_domains:               m.compliance_domains               || null,
        current_career_level:             m.current_career_level             || null,
        current_employment_status:        m.current_employment_status        || null,
        total_work_experience:            m.total_work_experience            || null,
        desired_role:                     m.desired_role                     || null,
        open_for_work_badge:              m.open_for_work_badge === '1',
        residential_city:                 m.residential_city                 || null,
        residential_country:              m.residential_country              || null,
        profile_completeness:             parseInt(m.profile_completeness)   || 0,
        preferred_work_type:              m.preferred_work_type              || null,
        notice_period_in_days:            m.notice_period_in_days            || null,
        current_annual_ctc_with_currency: isUnlocked ? (m.current_annual_ctc_with_currency  || null) : null,
        expected_annual_ctc_with_currency: isUnlocked ? (m.expected_annual_ctc_with_currency || null) : null,
        professional_summary_bio:         m.professional_summary_bio         || null,
        linkedin_url:                     isUnlocked ? (m.linkedin_url       || null) : null,
        soft_skills:                      m.soft_skills                      || null,
        contact_visibility:               contactVis,
        is_unlocked:                      isUnlocked,
      },
    });
  } catch (err) {
    console.error('[employer/search]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/employer/unlock ─────────────────────────────────────────────────
// Unlock a candidate profile (5/day, 50/month limits)
// Body: { dpr_id }

router.post('/unlock', ...guardVerified, async (req, res) => {
  try {
    const dprId = typeof req.body.dpr_id === 'string' ? req.body.dpr_id.trim().toUpperCase() : '';
    if (!dprId) return res.status(400).json({ ok: false, error: 'dpr_id is required' });

    const wpUserId = req.user.wp_user_id;
    if (!wpUserId) return res.status(400).json({ ok: false, error: 'No WP user linked to your account' });

    // Build UTC date keys for unlock counters (matching employer.js dashboard pattern)
    const now = new Date();
    const ym  = now.getUTCFullYear() + String(now.getUTCMonth() + 1).padStart(2, '0');
    const ymd = ym + String(now.getUTCDate()).padStart(2, '0');

    const meta = await fetchUserMeta(wpUserId, [
      `dpr_unlock_used_${ym}`,
      `dpr_unlock_used_${ymd}`,
      'unlocked_profiles',
    ]);

    const usedMonth = parseInt(meta[`dpr_unlock_used_${ym}`])  || 0;
    const usedDay   = parseInt(meta[`dpr_unlock_used_${ymd}`]) || 0;

    // Check if already unlocked (free operation — doesn't count against limit)
    const unlockedMap = parseUnlockedMap(meta.unlocked_profiles);
    if (isProfileUnlocked(unlockedMap, dprId)) {
      return res.json({ ok: true, already_unlocked: true, message: 'Profile already unlocked.' });
    }

    if (usedDay   >= 5)  return res.status(429).json({ ok: false, error: 'Daily unlock limit of 5 reached. Try again tomorrow.' });
    if (usedMonth >= 50) return res.status(429).json({ ok: false, error: 'Monthly unlock limit of 50 reached.' });

    // Verify the candidate exists and is visible
    const [[idRow]] = await pool.execute(
      "SELECT post_id FROM wp_postmeta WHERE meta_key = 'dpr_id' AND meta_value = ? LIMIT 1",
      [dprId]
    );
    if (!idRow) return res.status(404).json({ ok: false, error: 'Candidate not found' });
    const profilePostId = idRow.post_id;

    // Write unlock entry with 30-day TTL
    const nowTs     = Math.floor(Date.now() / 1000);
    const expiresTs = nowTs + 30 * 24 * 3600;
    unlockedMap[dprId] = { unlocked_at: nowTs, expires: expiresTs };

    await upsertUserMeta(wpUserId, 'unlocked_profiles',         JSON.stringify(unlockedMap));
    await upsertUserMeta(wpUserId, `dpr_unlock_used_${ymd}`,    String(usedDay   + 1));
    await upsertUserMeta(wpUserId, `dpr_unlock_used_${ym}`,     String(usedMonth + 1));

    // Append to unlock log on the profile post (capped at 200 entries)
    try {
      const [[logRow]] = await pool.execute(
        "SELECT meta_id, meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key = '_dpr_unlock_logs' LIMIT 1",
        [profilePostId]
      );
      const existing = logRow?.meta_value;
      let logs = [];
      try { logs = JSON.parse(existing || '[]'); } catch { logs = []; }
      if (!Array.isArray(logs)) logs = [];
      logs.push({ employer_user_id: wpUserId, unlocked_at: nowTs });
      if (logs.length > 200) logs = logs.slice(-200);
      if (logRow) {
        await pool.execute('UPDATE wp_postmeta SET meta_value = ? WHERE meta_id = ?', [JSON.stringify(logs), logRow.meta_id]);
      } else {
        await pool.execute('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)', [profilePostId, '_dpr_unlock_logs', JSON.stringify(logs)]);
      }
    } catch (logErr) {
      console.error('[employer/unlock] log write failed (non-fatal):', logErr.message);
    }

    res.json({
      ok:                true,
      dpr_id:            dprId,
      remaining_today:   Math.max(0, 5  - (usedDay   + 1)),
      remaining_monthly: Math.max(0, 50 - (usedMonth + 1)),
    });
  } catch (err) {
    console.error('[employer/unlock]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/employer/interviews ──────────────────────────────────────────────
// Full list of employer's interview sessions (no page limit)

router.get('/interviews', ...guardAny, async (req, res) => {
  try {
    const [[user]] = await pool.execute(
      'SELECT wp_user_id FROM agzit_users WHERE id = ?',
      [req.user.user_id]
    );
    const interviews = await fetchEmployerInterviews(user?.wp_user_id, 1000);
    res.json({ ok: true, count: interviews.length, interviews });
  } catch (err) {
    console.error('[employer/interviews]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/employer/interviews/:id ──────────────────────────────────────────
// Full scorecard detail for a single employer interview
// Ownership enforced: employer_user_id must match requesting user's WP user ID

const FULL_INTERVIEW_KEYS = [
  'candidate_name', 'candidate_email', 'total_work_experience',
  'interview_role', 'session_type', 'scheduled_at', 'interview_started_at',
  'interview_status', 'join_url', 'join_token', 'session_id',
  'mock_overall_score', 'mock_performance_level', 'emp_readiness_band',
  'score_communication', 'score_structure', 'score_role_knowledge',
  'score_domain_application', 'score_problem_solving', 'score_confidence',
  'score_question_handling', 'score_experience_relevance', 'score_resume_alignment',
  'depth_specificity',
  'mock_strengths', 'mock_improvements', 'mock_next_focus', 'mock_attention_areas',
  'emp_role_strengths', 'emp_role_gaps', 'emp_red_flags', 'emp_consistency_check',
  'audio_url', 'video_url', 'resume_file',
  'employer_user_id',
];

router.get('/interviews/:id', ...guardAny, async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    if (!postId) return res.status(400).json({ ok: false, error: 'Invalid interview ID' });
    console.log('[employer/interviews/:id] postId=%d user_id=%s', postId, req.user.user_id);

    const [[user]] = await pool.execute(
      'SELECT wp_user_id FROM agzit_users WHERE id = ?',
      [req.user.user_id]
    );
    const wpId = user?.wp_user_id;
    console.log('[employer/interviews/:id] wpId=%s', wpId);

    // Verify the post exists and is a published employer_interview
    const [[post]] = await pool.execute(
      "SELECT ID, post_title, post_status, post_date FROM wp_posts WHERE ID = ? AND post_type = 'employer_interview' LIMIT 1",
      [postId]
    );
    console.log('[employer/interviews/:id] post=%j', post);
    if (!post) return res.status(404).json({ ok: false, error: 'Interview not found' });
    if (post.post_status !== 'publish') return res.status(404).json({ ok: false, error: 'Interview not available' });

    const m = await fetchPostMeta(postId, FULL_INTERVIEW_KEYS);

    // Ownership check: allow only the employer who created it
    if (wpId && m.employer_user_id && String(m.employer_user_id) !== String(wpId)) {
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }

    const int = (v) => (v !== null && v !== undefined && v !== '') ? parseInt(v) : null;

    // Compute overall_score as sum of all 10 competency scores (max 100)
    const scoreKeys = [
      'score_communication', 'score_structure', 'score_role_knowledge',
      'score_domain_application', 'score_problem_solving', 'score_confidence',
      'score_question_handling', 'score_experience_relevance', 'score_resume_alignment',
      'depth_specificity',
    ];
    const parsedScores = scoreKeys.map(k => int(m[k])).filter(s => s !== null);
    const overall_score = parsedScores.length > 0 ? parsedScores.reduce((a, b) => a + b, 0) : null;

    res.json({
      ok: true,
      interview: {
        id:                       postId,
        post_title:               post.post_title,
        post_date:                post.post_date,
        candidate_name:           m.candidate_name              || null,
        candidate_email:          m.candidate_email             || null,
        total_work_experience:    m.total_work_experience       || null,
        interview_role:           m.interview_role              || null,
        session_type:             m.session_type                || null,
        scheduled_at:             m.scheduled_at                || null,
        interview_started_at:     m.interview_started_at        ? parseInt(m.interview_started_at) : null,
        interview_status:         m.interview_status            || null,
        join_url:                 m.join_url                    || null,
        session_id:               m.session_id                  || null,
        overall_score,
        emp_readiness_band:       m.emp_readiness_band          || null,
        score_communication:      int(m.score_communication),
        score_structure:          int(m.score_structure),
        score_role_knowledge:     int(m.score_role_knowledge),
        score_domain_application: int(m.score_domain_application),
        score_problem_solving:    int(m.score_problem_solving),
        score_confidence:         int(m.score_confidence),
        score_question_handling:  int(m.score_question_handling),
        score_experience_relevance: int(m.score_experience_relevance),
        score_resume_alignment:   int(m.score_resume_alignment),
        depth_specificity:        int(m.depth_specificity),
        mock_strengths:           m.mock_strengths              || null,
        mock_improvements:        m.mock_improvements           || null,
        mock_attention_areas:     m.mock_attention_areas        || null,
        emp_role_strengths:       m.emp_role_strengths          || null,
        emp_role_gaps:            m.emp_role_gaps               || null,
        emp_red_flags:            m.emp_red_flags               || null,
        emp_consistency_check:    m.emp_consistency_check       || null,
        audio_url:                m.audio_url                   || null,
        video_url:                m.video_url                   || null,
        resume_file:              m.resume_file                 || null,
      },
    });
  } catch (err) {
    console.error('[employer/interviews/:id]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/employer/interviews/:id/cancel ──────────────────────────────────
// Cancel an employer interview (must belong to requesting employer)

router.post('/interviews/:id/cancel', ...guardAny, async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    if (!postId) return res.status(400).json({ ok: false, error: 'Invalid interview ID' });

    const [[user]] = await pool.execute(
      'SELECT wp_user_id FROM agzit_users WHERE id = ?',
      [req.user.user_id]
    );
    const wpId = user?.wp_user_id;
    if (!wpId) return res.status(400).json({ ok: false, error: 'No WP user linked' });

    // Verify ownership
    const [[ownership]] = await pool.execute(
      "SELECT meta_id FROM wp_postmeta WHERE post_id = ? AND meta_key = 'employer_user_id' AND meta_value = ? LIMIT 1",
      [postId, String(wpId)]
    );
    if (!ownership) return res.status(403).json({ ok: false, error: 'Interview not found or access denied' });

    // Check current status
    const [[statusMeta]] = await pool.execute(
      "SELECT meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key = 'interview_status' LIMIT 1",
      [postId]
    );
    if (statusMeta?.meta_value === 'completed') {
      return res.status(400).json({ ok: false, error: 'Completed interviews cannot be cancelled' });
    }
    if (statusMeta?.meta_value === 'cancelled') {
      return res.json({ ok: true, interview_id: postId, status: 'cancelled', already_cancelled: true });
    }

    await pool.execute(
      "UPDATE wp_postmeta SET meta_value = 'cancelled' WHERE post_id = ? AND meta_key = 'interview_status'",
      [postId]
    );

    res.json({ ok: true, interview_id: postId, status: 'cancelled' });
  } catch (err) {
    console.error('[employer/interviews/cancel]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/employer/profile-view?dpr_id=... ────────────────────────────────
// Full candidate profile for employer view (replaces dpr-public-profile-viewer shortcode)
// Enforces profile_visibility, contact_visibility, resume_visibility per ACF settings
// Increments dpr_id_view_count on each call

router.get('/profile-view', ...guardVerified, async (req, res) => {
  try {
    const dprId = typeof req.query.dpr_id === 'string' ? req.query.dpr_id.trim().toUpperCase() : '';
    if (!dprId) return res.status(400).json({ ok: false, error: 'dpr_id is required' });

    // Find profile post by dpr_id
    const [[idRow]] = await pool.execute(
      "SELECT post_id FROM wp_postmeta WHERE meta_key = 'dpr_id' AND meta_value = ? LIMIT 1",
      [dprId]
    );
    if (!idRow) return res.status(404).json({ ok: false, error: 'Candidate not found' });

    const postId = idRow.post_id;

    // Verify published + approved
    const [[post]] = await pool.execute(
      "SELECT ID, post_status FROM wp_posts WHERE ID = ? AND post_type = 'dpr_profile' LIMIT 1",
      [postId]
    );
    if (!post || post.post_status !== 'publish') {
      return res.status(404).json({ ok: false, error: 'Candidate not found' });
    }

    const FULL_KEYS = [
      'dpr_id', 'dpr_status', 'full_name', 'email_address', 'phone_number',
      'gender', 'date_of_birth', 'country_of_nationality',
      'residential_city', 'residential_country',
      'linkedin_url', 'profile_photo',
      'professional_summary_bio', 'total_work_experience',
      'compliance_domains', 'current_employment_status', 'notice_period_in_days',
      'current_annual_ctc_with_currency', 'expected_annual_ctc_with_currency',
      'open_to_relocate', 'open_for_work_badge', 'current_career_level',
      'soft_skills', 'desired_role', 'work_level', 'preferred_work_type',
      'resume_upload',
      'id_verified', 'address_verified', 'experience_verified', 'certificate_verified',
      'public_name_mode', 'profile_completeness', 'dpr_id_view_count',
      'profile_visibility', 'contact_visibility', 'resume_visibility',
      // Repeater counts
      'work_experience', 'education', 'certifications', 'compliance_tools', 'language_proficiency',
    ];

    const m = await fetchPostMeta(postId, FULL_KEYS);

    if (m.profile_visibility !== 'public' || m.dpr_status !== 'approved') {
      return res.status(404).json({ ok: false, error: 'Candidate not found' });
    }

    // Check unlock status
    let isUnlocked = false;
    if (req.user.wp_user_id) {
      const empMeta = await fetchUserMeta(req.user.wp_user_id, ['unlocked_profiles']);
      isUnlocked = isProfileUnlocked(parseUnlockedMap(empMeta.unlocked_profiles), dprId);
    }

    const contactVis = m.contact_visibility || 'co_verified_only';
    const resumeVis  = m.resume_visibility  || 're_verified_only';
    const revealContact = isUnlocked || contactVis === 'co_public';
    const revealResume  = isUnlocked || resumeVis  === 're_public';

    // Increment view count (non-blocking)
    const currentViews = parseInt(m.dpr_id_view_count) || 0;
    pool.execute(
      "UPDATE wp_postmeta SET meta_value = ? WHERE post_id = ? AND meta_key = 'dpr_id_view_count'",
      [String(currentViews + 1), postId]
    ).catch(e => console.error('[profile-view] view count update failed:', e.message));

    // Fetch repeater rows
    const WORK_EXP_FIELDS = [
      'job_title', 'company_name', 'office_country', 'office_city',
      'start_date', 'end_date', 'Currently_working',
      'key_responsibilities', 'employment_type', 'key_achievements',
    ];
    const EDU_FIELDS  = ['degree', 'institution_name', 'edu_country', 'edu_city', 'edu_start_date', 'edu_end_date'];
    const CERT_FIELDS = ['certification_name', 'credential_id', 'issuing_organization', 'cert_issue_date', 'cert_expiry_date', 'certificate_pdf'];
    const TOOL_FIELDS = ['tool_name'];
    const LANG_FIELDS = ['language'];

    function parseRepeaterLocal(count, prefix, fields) {
      const rows = [];
      for (let i = 0; i < count; i++) {
        const row = {};
        for (const f of fields) row[f] = m[`${prefix}_${i}_${f}`] ?? null;
        rows.push(row);
      }
      return rows;
    }

    // Fetch all repeater subfield meta in one query
    const [repRows] = await pool.execute(
      "SELECT meta_key, meta_value FROM wp_postmeta WHERE post_id = ? AND (meta_key LIKE 'work_experience_%' OR meta_key LIKE 'education_%' OR meta_key LIKE 'certifications_%' OR meta_key LIKE 'compliance_tools_%' OR meta_key LIKE 'language_proficiency_%') AND meta_key NOT LIKE '\\_%%'",
      [postId]
    );
    for (const r of repRows) m[r.meta_key] = r.meta_value;

    const workExperience  = parseRepeaterLocal(parseInt(m.work_experience)       || 0, 'work_experience',  WORK_EXP_FIELDS);
    const education       = parseRepeaterLocal(parseInt(m.education)             || 0, 'education',        EDU_FIELDS);
    const certifications  = parseRepeaterLocal(parseInt(m.certifications)        || 0, 'certifications',   CERT_FIELDS);
    const complianceTools = parseRepeaterLocal(parseInt(m.compliance_tools)      || 0, 'compliance_tools', TOOL_FIELDS);
    const languages       = parseRepeaterLocal(parseInt(m.language_proficiency)  || 0, 'language_proficiency', LANG_FIELDS);

    res.json({
      ok:         true,
      is_unlocked: isUnlocked,
      candidate: {
        dpr_id:               m.dpr_id,
        full_name:            m.full_name           || null,
        profile_photo:        m.profile_photo        || null,
        public_name_mode:     m.public_name_mode     || null,

        // Contact — revealed only when unlocked or co_public
        email_address:        revealContact ? (m.email_address || null) : maskEmail(m.email_address),
        phone_number:         revealContact ? (m.phone_number  || null) : maskPhone(m.phone_number),
        linkedin_url:         isUnlocked    ? (m.linkedin_url  || null) : null,
        contact_visibility:   contactVis,

        // Professional
        professional_summary_bio:          m.professional_summary_bio         || null,
        compliance_domains:                m.compliance_domains               || null,
        current_career_level:              m.current_career_level             || null,
        current_employment_status:         m.current_employment_status        || null,
        total_work_experience:             m.total_work_experience            || null,
        desired_role:                      m.desired_role                     || null,
        open_for_work_badge:               m.open_for_work_badge === '1',
        open_to_relocate:                  m.open_to_relocate === '1',
        notice_period_in_days:             m.notice_period_in_days            || null,
        preferred_work_type:               m.preferred_work_type              || null,

        // CTC — revealed only when unlocked
        current_annual_ctc_with_currency:  isUnlocked ? (m.current_annual_ctc_with_currency  || null) : null,
        expected_annual_ctc_with_currency: isUnlocked ? (m.expected_annual_ctc_with_currency || null) : null,

        // Location
        residential_city:    m.residential_city    || null,
        residential_country: m.residential_country || null,

        // Skills
        soft_skills:         m.soft_skills         || null,
        compliance_tools:    complianceTools,
        language_proficiency: languages,

        // Resume — controlled by resume_visibility
        resume_upload:       revealResume ? (m.resume_upload || null) : null,
        resume_visibility:   resumeVis,

        // Verification badges
        id_verified:          m.id_verified          === '1',
        address_verified:     m.address_verified      === '1',
        experience_verified:  m.experience_verified   === '1',
        certificate_verified: m.certificate_verified  === '1',
        profile_completeness: parseInt(m.profile_completeness) || 0,

        // Repeaters
        work_experience:  workExperience,
        education:        education,
        certifications:   certifications,
      },
    });
  } catch (err) {
    console.error('[employer/profile-view]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── Email transporter (schedule-interview) ────────────────────────────────────
const scheduleMailer = nodemailer.createTransport({
  host:   process.env.MAIL_HOST,
  port:   parseInt(process.env.MAIL_PORT) || 465,
  secure: process.env.MAIL_SECURE === 'true',
  auth:   { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
});

async function sendInterviewEmail({ candidateName, candidateEmail, interviewRole, sessionType, scheduledAt, joinUrl, joinToken }) {
  const durationMin = sessionType === '30-min' ? 30 : 20;
  const firstName   = candidateName.split(' ')[0];

  // Parse scheduledAt (datetime-local: "YYYY-MM-DDTHH:MM") as UTC
  const dtStart = new Date(scheduledAt.includes('T') ? scheduledAt + ':00Z' : scheduledAt.replace(' ', 'T') + 'Z');
  const dtEnd   = new Date(dtStart.getTime() + durationMin * 60 * 1000);
  const isValidDt = !isNaN(dtStart.getTime());

  const scheduledDisplay = isValidDt
    ? dtStart.toUTCString().replace('GMT', 'UTC')
    : scheduledAt;

  // .ics DTSTART/DTEND in UTC format (YYYYMMDDTHHmmssZ)
  const fmtIcs = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const utcNow   = fmtIcs(new Date());
  const utcStart = isValidDt ? fmtIcs(dtStart) : utcNow;
  const utcEnd   = isValidDt ? fmtIcs(dtEnd)   : utcNow;

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//AGZIT//AI Interview//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${joinToken}@agzit.com`,
    `DTSTAMP:${utcNow}`,
    `DTSTART:${utcStart}`,
    `DTEND:${utcEnd}`,
    `SUMMARY:AI Interview: ${interviewRole}`,
    `DESCRIPTION:Join here: ${joinUrl}`,
    'ORGANIZER;CN=AGZIT:mailto:noreply@agzit.com',
    `ATTENDEE;RSVP=TRUE;CN=${candidateName}:mailto:${candidateEmail}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your AI Interview is Scheduled</title></head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:Inter,Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:40px 16px;">
<tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr>
    <td style="background:linear-gradient(135deg,#0A1A3A 0%,#162848 100%);border-radius:16px 16px 0 0;padding:32px;text-align:center;">
      <div style="font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#C9A24D;margin-bottom:12px;">AGZIT &middot; AI Career Intelligence System</div>
      <div style="font-size:24px;font-weight:800;color:#ffffff;line-height:1.3;margin-bottom:6px;">AI Interview Confirmed</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.55);line-height:1.5;">Your interview details and calendar invite are attached below.</div>
    </td>
  </tr>
  <tr>
    <td style="background:#ffffff;padding:36px 32px;">
      <p style="margin:0 0 22px;font-size:15.5px;color:#1E293B;line-height:1.75;">Hello <strong>${firstName}</strong>,</p>
      <p style="margin:0 0 28px;font-size:15px;color:#374151;line-height:1.75;">You have been scheduled for an <strong>AI Interview</strong> by an employer on the AGZIT platform. Your interview details are listed below.</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;margin-bottom:28px;">
        <tr><td style="padding:0 22px;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="padding:16px 0;border-bottom:1px solid #F1F5F9;">
              <div style="font-size:10.5px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Interview Role</div>
              <div style="font-size:16px;font-weight:700;color:#0A1A3A;">${interviewRole}</div>
            </td></tr>
            <tr><td style="padding:16px 0;border-bottom:1px solid #F1F5F9;">
              <div style="font-size:10.5px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Scheduled Date &amp; Time</div>
              <div style="font-size:16px;font-weight:700;color:#0A1A3A;">${scheduledDisplay}</div>
            </td></tr>
            <tr><td style="padding:16px 0;">
              <div style="font-size:10.5px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Duration</div>
              <div style="font-size:16px;font-weight:700;color:#0A1A3A;">${durationMin} Minutes</div>
            </td></tr>
          </table>
        </td></tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
        <tr><td align="center">
          <a href="${joinUrl}" style="display:inline-block;background:#0A1A3A;color:#ffffff;text-decoration:none;padding:15px 40px;border-radius:10px;font-size:15px;font-weight:700;letter-spacing:0.2px;">Join Your Interview</a>
        </td></tr>
      </table>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:12px;margin-bottom:28px;">
        <tr><td style="padding:20px 22px;">
          <div style="font-size:11px;font-weight:700;color:#92400E;text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;">Before You Start</div>
          <p style="margin:0;font-size:14px;color:#374151;line-height:1.8;">Please join at your scheduled time using the button above. Make sure you are in a quiet place with a stable internet connection. The AI interviewer will guide you through the entire session.</p>
        </td></tr>
      </table>
      <p style="margin:0;font-size:12.5px;color:#94A3B8;line-height:1.7;">If the button does not work, copy and paste this link:<br>
        <span style="color:#0A1A3A;word-break:break-all;">${joinUrl}</span></p>
    </td>
  </tr>
  <tr>
    <td style="background:#F8FAFC;border-top:1px solid #E2E8F0;border-radius:0 0 16px 16px;padding:20px 32px;text-align:center;">
      <div style="font-size:11px;font-weight:700;color:#0A1A3A;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;">AGZIT</div>
      <div style="font-size:12px;color:#94A3B8;line-height:1.6;">AI Career Intelligence System &nbsp;&bull;&nbsp; <a href="https://agzit.com" style="color:#C9A24D;text-decoration:none;">agzit.com</a></div>
      <div style="margin-top:10px;font-size:11.5px;color:#CBD5E1;">This email was sent by AGZIT. Do not reply to this email.</div>
    </td>
  </tr>
</table></td></tr>
</table>
</body></html>`;

  await scheduleMailer.sendMail({
    from:        process.env.MAIL_FROM || process.env.MAIL_USER,
    to:          candidateEmail,
    subject:     `Your AI Interview is Scheduled – ${interviewRole} | AGZIT`,
    html,
    attachments: [{
      filename:    'interview-invite.ics',
      content:     Buffer.from(ics, 'utf8'),
      contentType: 'text/calendar; method=REQUEST',
    }],
  });
}

// ── POST /api/employer/schedule-interview ─────────────────────────────────────
// Create a new employer-scheduled AI interview and email the candidate.
// Body: { candidate_name, candidate_email, interview_role, session_type,
//         scheduled_at, jd_raw_text, total_work_experience?, resume_file? }
// scheduled_at: datetime-local format "YYYY-MM-DDTHH:MM"

router.post('/schedule-interview', ...guardVerified, async (req, res) => {
  try {
    const [[user]] = await pool.execute(
      'SELECT id, wp_user_id FROM agzit_users WHERE id = ?',
      [req.user.user_id]
    );
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    const wpUserId = user.wp_user_id;
    if (!wpUserId) return res.status(400).json({ ok: false, error: 'No WP user linked to this account' });

    const candidateName  = String(req.body.candidate_name         || '').trim();
    const candidateEmail = String(req.body.candidate_email        || '').trim().toLowerCase();
    const interviewRole  = String(req.body.interview_role         || '').trim();
    const sessionType    = String(req.body.session_type           || '20-min').trim();
    const scheduledAt    = String(req.body.scheduled_at           || '').trim();
    const jdRawText      = String(req.body.jd_raw_text            || '').trim();
    const resumeFile     = String(req.body.resume_file            || '').trim();
    const totalExp       = String(req.body.total_work_experience  || '').trim();

    if (!candidateName)  return res.status(400).json({ ok: false, error: 'Candidate name is required' });
    if (!candidateEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateEmail)) {
      return res.status(400).json({ ok: false, error: 'Valid candidate email is required' });
    }
    if (!interviewRole)  return res.status(400).json({ ok: false, error: 'Interview role is required' });
    if (!scheduledAt)    return res.status(400).json({ ok: false, error: 'Scheduled date and time is required' });
    if (!jdRawText)      return res.status(400).json({ ok: false, error: 'Job description is required' });
    if (!['20-min', '30-min'].includes(sessionType)) {
      return res.status(400).json({ ok: false, error: 'session_type must be 20-min or 30-min' });
    }

    const joinToken = crypto.randomUUID();
    const joinUrl   = 'https://app.agzit.com/employer-interviews?token=' + joinToken;
    const postTitle = candidateName + ' \u2013 ' + interviewRole; // em dash

    // Create wp_posts row
    const [ins] = await pool.execute(
      `INSERT INTO wp_posts
         (post_author, post_date, post_date_gmt, post_content, post_title,
          post_status, post_type, post_modified, post_modified_gmt,
          comment_status, ping_status, to_ping, pinged, post_content_filtered,
          post_excerpt, comment_count, menu_order)
       VALUES (?, NOW(), UTC_TIMESTAMP(), '', ?, 'publish', 'employer_interview',
               NOW(), UTC_TIMESTAMP(), 'closed', 'closed', '', '', '', '', 0, 0)`,
      [String(wpUserId), postTitle]
    );
    const postId = ins.insertId;
    if (!postId) throw new Error('Failed to create interview post');

    // Insert all postmeta rows
    const metaRows = [
      ['employer_user_id',      String(wpUserId)],
      ['candidate_name',        candidateName],
      ['candidate_email',       candidateEmail],
      ['total_work_experience', totalExp],
      ['interview_role',        interviewRole],
      ['session_type',          sessionType],
      ['scheduled_at',          scheduledAt],
      ['jd_raw_text',           jdRawText],
      ['resume_file',           resumeFile],
      ['interview_status',      'scheduled'],
      ['join_token',            joinToken],
      ['join_url',              joinUrl],
    ];
    for (const [key, val] of metaRows) {
      await pool.execute(
        'INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
        [postId, key, val]
      );
    }

    // Send candidate email (fire-and-forget)
    sendInterviewEmail({ candidateName, candidateEmail, interviewRole, sessionType, scheduledAt, joinUrl, joinToken })
      .catch(err => console.error('[schedule-interview] email error (non-fatal):', err.message));

    console.log('[schedule-interview] created post_id=%d token=%s', postId, joinToken);
    res.json({ ok: true, post_id: postId, join_url: joinUrl });
  } catch (err) {
    console.error('[employer/schedule-interview]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
