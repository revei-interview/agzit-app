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
const bcrypt     = require('bcryptjs');
const { BrevoClient, BrevoEnvironment } = require('@getbrevo/brevo');
function makeBrevoClient() {
  return new BrevoClient({ apiKey: process.env.BREVO_API_KEY, environment: BrevoEnvironment.Production });
}
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
const INTERVIEW_SCORE_KEYS = [
  'score_communication', 'score_structure', 'score_role_knowledge',
  'score_domain_application', 'score_problem_solving', 'score_confidence',
  'score_question_handling', 'score_experience_relevance', 'score_resume_alignment',
  'depth_specificity',
];

const INTERVIEW_KEYS = [
  'candidate_name', 'candidate_email', 'total_work_experience',
  'interview_role', 'session_type', 'scheduled_at',
  'interview_status', 'join_url', 'join_token', 'session_id',
  'emp_readiness_band',
  'audio_url', 'video_url', 'jd_raw_text',
  'scheduled_by_agzit_id',
  ...INTERVIEW_SCORE_KEYS,
];

// Fetch interviews for a team member: scoped to the company (admin wpId) AND
// filtered to only interviews scheduled by this specific member (memberAgzitId).
// Older interviews without scheduled_by_agzit_id postmeta are excluded (treated as admin-only).
async function fetchMemberInterviews(adminWpId, memberAgzitId, limit) {
  if (!adminWpId || !memberAgzitId) return [];
  const [posts] = await pool.execute(
    `SELECT p.ID, p.post_title, p.post_date
     FROM wp_posts p
     INNER JOIN wp_postmeta em ON em.post_id = p.ID
       AND em.meta_key = 'employer_user_id'
       AND em.meta_value = ?
     INNER JOIN wp_postmeta pm_by ON pm_by.post_id = p.ID
       AND pm_by.meta_key = 'scheduled_by_agzit_id'
       AND pm_by.meta_value = ?
     WHERE p.post_type = 'employer_interview'
       AND p.post_status = 'publish'
     ORDER BY p.post_date DESC
     LIMIT ?`,
    [String(adminWpId), String(memberAgzitId), limit]
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
      overall_score:          (() => {
        const vals = INTERVIEW_SCORE_KEYS.map(k => m[k] !== undefined && m[k] !== null && m[k] !== '' ? parseInt(m[k]) : null);
        if (vals.every(v => v === null)) return null;
        return vals.reduce((sum, v) => sum + (v ?? 0), 0);
      })(),
      emp_readiness_band:       m.emp_readiness_band      || null,
      audio_url:                m.audio_url               || null,
      video_url:                m.video_url               || null,
      jd_raw_text:              m.jd_raw_text             || null,
      scheduled_by_agzit_id:    m.scheduled_by_agzit_id   || null,
    };
  });
}

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
      overall_score:          (() => {
        const vals = INTERVIEW_SCORE_KEYS.map(k => m[k] !== undefined && m[k] !== null && m[k] !== '' ? parseInt(m[k]) : null);
        if (vals.every(v => v === null)) return null;
        return vals.reduce((sum, v) => sum + (v ?? 0), 0);
      })(),
      emp_readiness_band:       m.emp_readiness_band      || null,
      audio_url:                m.audio_url               || null,
      video_url:                m.video_url               || null,
      jd_raw_text:              m.jd_raw_text             || null,
      scheduled_by_agzit_id:    m.scheduled_by_agzit_id   || null,
    };
  });
}

// ── GET /api/employer/dashboard ───────────────────────────────────────────────
// Employer info + company summary + unlock counters + recent 5 interviews

router.get('/dashboard', ...guardAny, async (req, res) => {
  try {
    const [[user]] = await pool.execute(
      'SELECT id, email, first_name, last_name, wp_user_id, role, created_at, has_set_password FROM agzit_users WHERE id = ?',
      [req.user.user_id]
    );
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    // Build date keys (UTC) for unlock counters
    const now = new Date();
    const ym  = now.getUTCFullYear() + String(now.getUTCMonth() + 1).padStart(2, '0');
    const ymd = ym + String(now.getUTCDate()).padStart(2, '0');

    // ── Team status (checked early so we can use the right data source) ───────
    let is_team_admin  = false;
    let is_team_member = false;
    let adminWpId      = null;
    let adminEmail     = null;
    try {
      const [[teamAdminRow]] = await pool.execute(
        "SELECT id FROM agzit_employer_team WHERE admin_user_id = ? AND status != 'removed' LIMIT 1",
        [user.id]
      );
      const [[teamMemberRow]] = await pool.execute(
        "SELECT admin_user_id FROM agzit_employer_team WHERE member_user_id = ? AND status = 'active' LIMIT 1",
        [user.id]
      );
      is_team_admin  = !!teamAdminRow;
      is_team_member = !!teamMemberRow;

      if (is_team_member) {
        const [[adminUser]] = await pool.execute(
          'SELECT wp_user_id, email FROM agzit_users WHERE id = ? LIMIT 1',
          [teamMemberRow.admin_user_id]
        );
        adminWpId  = adminUser?.wp_user_id || null;
        adminEmail = adminUser?.email      || null;
      }
    } catch (teamErr) {
      console.warn('[employer/dashboard] team query skipped:', teamErr.message);
    }

    // ── Fetch meta from admin's wp_user_id (for members) or own (for admins) ──
    const metaWpId = (is_team_member && adminWpId) ? adminWpId : user.wp_user_id;
    const EMPLOYER_META_KEYS = [
      'dpr_employer_first_name',
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
    const meta = metaWpId ? await fetchUserMeta(metaWpId, EMPLOYER_META_KEYS) : {};

    // For team members: fetch their own first_name, designation, department from own wp_usermeta
    let memberFirstName   = user.first_name || '';
    let memberDesignation = null;
    let memberDepartment  = null;
    if (is_team_member && user.wp_user_id) {
      const memMeta = await fetchUserMeta(user.wp_user_id, ['first_name', 'dpr_designation', 'dpr_department']);
      memberFirstName   = memMeta.first_name    || user.first_name || '';
      memberDesignation = memMeta.dpr_designation || null;
      memberDepartment  = memMeta.dpr_department  || null;
    }

    const usedMonth = parseInt(meta[`dpr_unlock_used_${ym}`])  || 0;
    const usedDay   = parseInt(meta[`dpr_unlock_used_${ymd}`]) || 0;

    // Recent interviews: members see only their own; admins see all company interviews
    const recentInterviews = (is_team_member && adminWpId)
      ? await fetchMemberInterviews(adminWpId, user.id, 5)
      : await fetchEmployerInterviews(metaWpId || user.wp_user_id, 5);

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
      needs_password_setup: is_team_member && !user.has_set_password,
      employer_profile: {
        // first_name: member's own name; admin's Form 35 name for admin
        first_name:          is_team_member ? memberFirstName : (meta.dpr_employer_first_name || null),
        company_name:        meta.dpr_company_name                     || null,
        // designation/department are personal to the member — null until they set their own
        designation:         is_team_member ? memberDesignation  : (meta.dpr_designation || null),
        department:          is_team_member ? memberDepartment   : (meta.dpr_department  || null),
        // work_email stat card: member's login email; admin's verified work email
        work_email:          is_team_member ? (user.email || null) : (meta.dpr_verified_work_email || null),
        application_status:  meta.dpr_employer_application_status     || null,
        verified_until:      meta.dpr_verified_until ? parseInt(meta.dpr_verified_until) : null,
        linkedin_url:        meta.dpr_verified_linkedin               || null,
        // Extra fields for profile tab (members only)
        company_admin_email: is_team_member ? adminEmail                 : null,
        member_work_email:   is_team_member ? (user.email || null)       : null,
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
      is_team_admin,
      is_team_member,
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

    // ── Team member check: fetch admin's company profile data ─────────────────
    let is_team_member = false;
    let adminWpId      = null;
    let adminEmail     = null;
    try {
      const [[teamMemberRow]] = await pool.execute(
        "SELECT admin_user_id, joined_at FROM agzit_employer_team WHERE member_user_id = ? AND status = 'active' LIMIT 1",
        [user.id]
      );
      if (teamMemberRow) {
        is_team_member = true;
        const [[adminUser]] = await pool.execute(
          'SELECT wp_user_id, email FROM agzit_users WHERE id = ? LIMIT 1',
          [teamMemberRow.admin_user_id]
        );
        adminWpId  = adminUser?.wp_user_id || null;
        adminEmail = adminUser?.email      || null;
      }
      // Store joined_at for member verification section
      var memberJoinedAt = teamMemberRow?.joined_at || null;
    } catch (e) {
      console.warn('[employer/profile] team check skipped:', e.message);
    }

    const profileWpId = (is_team_member && adminWpId) ? adminWpId : user.wp_user_id;

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

    const meta = profileWpId ? await fetchUserMeta(profileWpId, PROFILE_KEYS) : {};

    // For members: fetch their own first_name, designation, department from their own wp_usermeta
    let memberFirstName   = user.first_name || '';
    let memberDesignation = null;
    let memberDepartment  = null;
    if (is_team_member && user.wp_user_id) {
      const memMeta = await fetchUserMeta(user.wp_user_id, ['first_name', 'dpr_designation', 'dpr_department']);
      memberFirstName   = memMeta.first_name    || user.first_name || '';
      memberDesignation = memMeta.dpr_designation || null;
      memberDepartment  = memMeta.dpr_department  || null;
    }

    res.json({
      ok: true,
      is_team_member,
      profile: {
        first_name:          is_team_member
                               ? memberFirstName
                               : (meta.dpr_employer_first_name || (user.first_name && !user.first_name.includes('@') ? user.first_name : '') || ''),
        work_email:          meta.dpr_verified_work_email              || null,
        linkedin_url:        meta.dpr_verified_linkedin                || null,
        company_name:        meta.dpr_company_name                     || null,
        company_website:     meta.dpr_company_website                  || null,
        // designation/department: member's own (editable); admin's for non-members
        designation:         is_team_member ? memberDesignation : (meta.dpr_designation  || null),
        department:          is_team_member ? memberDepartment  : (meta.dpr_department   || null),
        designation_proof:   meta.dpr_designation_proof_url            || meta.dpr_designation_proof || null,
        application_status:  meta.dpr_employer_application_status      || null,
        applied_at:          meta.dpr_employer_applied_at              ? parseInt(meta.dpr_employer_applied_at) : null,
        verified_until:      meta.dpr_verified_until                   ? parseInt(meta.dpr_verified_until) : null,
        verified_at:         meta.dpr_verified_at                      ? parseInt(meta.dpr_verified_at) : null,
        // Member-only fields for profile tab display
        company_admin_email: is_team_member ? adminEmail                    : null,
        member_work_email:   is_team_member ? (user.email || null)          : null,
        joined_at:           is_team_member ? (memberJoinedAt || null)      : null,
      },
    });
  } catch (err) {
    console.error('[employer/profile]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── PUT /api/employer/profile ─────────────────────────────────────────────────
// Update editable employer profile fields.
// Body: { first_name, company_name, company_website, designation, department, linkedin_url }

router.put('/profile', ...guardAny, async (req, res) => {
  try {
    const [[user]] = await pool.execute(
      'SELECT id, email, first_name, wp_user_id FROM agzit_users WHERE id = ?',
      [req.user.user_id]
    );
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    // Team members may only edit their own designation and department
    const isMember = !!(await resolveAdminUserId(user.id).catch(() => null));
    const allowed  = isMember
      ? ['designation', 'department']
      : ['first_name', 'company_name', 'company_website', 'designation', 'department', 'linkedin_url'];
    const body     = req.body || {};

    // Map frontend keys → wp_usermeta keys
    const WP_META_MAP = {
      company_name:    'dpr_company_name',
      company_website: 'dpr_company_website',
      designation:     'dpr_designation',
      department:      'dpr_department',
      linkedin_url:    'dpr_verified_linkedin',
      first_name:      'dpr_employer_first_name',
    };

    const updates = [];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        updates.push({ key, value: String(body[key] ?? '').trim() });
      }
    }
    if (!updates.length) return res.status(400).json({ ok: false, error: 'No fields to update' });

    // Update wp_usermeta if WP user exists
    if (user.wp_user_id) {
      for (const { key, value } of updates) {
        const metaKey = WP_META_MAP[key];
        if (metaKey) await upsertUserMeta(user.wp_user_id, metaKey, value);
      }
    }

    // Also update agzit_users.first_name if first_name was submitted
    const nameUpdate = updates.find(u => u.key === 'first_name');
    if (nameUpdate && nameUpdate.value) {
      await pool.execute(
        'UPDATE agzit_users SET first_name = ? WHERE id = ?',
        [nameUpdate.value, user.id]
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[employer/profile PUT]', err);
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
    // Employers may only look up a specific candidate by DPR ID — bulk browsing is not permitted
    const dprIdParam = typeof req.query.dpr_id === 'string' ? req.query.dpr_id.trim() : '';
    if (!dprIdParam) {
      return res.status(400).json({ ok: false, error: 'dpr_id required' });
    }

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
    // Log format matches WP dpr-unlock-engine snippet: { ts, user_id, email, dpr_id, expires, scope, company }
    try {
      // Fetch employer email + company for audit trail
      const [[empUser]] = await pool.execute(
        'SELECT email FROM agzit_users WHERE wp_user_id = ? LIMIT 1',
        [wpUserId]
      );
      const empMeta = await fetchUserMeta(wpUserId, ['dpr_company_name', 'company_name']);
      const empEmail   = empUser?.email   || '';
      const empCompany = empMeta.dpr_company_name || empMeta.company_name || '';

      const [[logRow]] = await pool.execute(
        "SELECT meta_id, meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key = '_dpr_unlock_logs' LIMIT 1",
        [profilePostId]
      );
      let logs = [];
      try { logs = JSON.parse(logRow?.meta_value || '[]'); } catch { logs = []; }
      if (!Array.isArray(logs)) logs = [];
      logs.push({
        ts:      nowTs,
        user_id: wpUserId,
        email:   empEmail,
        dpr_id:  dprId,
        expires: expiresTs,
        scope:   'free_limits_5_day_50_month',
        company: empCompany,
      });
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
      'SELECT id, wp_user_id FROM agzit_users WHERE id = ?',
      [req.user.user_id]
    );

    // Resolve admin's wpId for team members (credits + interview list live there)
    let wpId = user?.wp_user_id;
    const adminUserId = await resolveAdminUserId(req.user.user_id).catch(() => null);
    if (adminUserId) {
      const [[adminUser]] = await pool.execute(
        'SELECT wp_user_id FROM agzit_users WHERE id = ? LIMIT 1', [adminUserId]
      );
      if (adminUser?.wp_user_id) wpId = adminUser.wp_user_id;
    }

    // Members see only their own interviews; admins see all company interviews
    const interviews = adminUserId
      ? await fetchMemberInterviews(wpId, req.user.user_id, 1000)
      : await fetchEmployerInterviews(wpId, 1000);

    // Batch-fetch scheduled_by names from agzit_users
    const agzitIds = [...new Set(interviews.map(iv => iv.scheduled_by_agzit_id).filter(Boolean))];
    if (agzitIds.length) {
      const ph = agzitIds.map(() => '?').join(',');
      const [nameRows] = await pool.execute(
        `SELECT id, first_name, last_name FROM agzit_users WHERE id IN (${ph})`,
        agzitIds
      );
      const nameMap = {};
      for (const r of nameRows) {
        nameMap[r.id] = [r.first_name, r.last_name].filter(Boolean).join(' ') || null;
      }
      for (const iv of interviews) {
        iv.scheduled_by = iv.scheduled_by_agzit_id ? (nameMap[iv.scheduled_by_agzit_id] || null) : null;
      }
    }

    let interview_credits = 0;
    let credits_used      = 0;
    if (wpId) {
      const cm = await fetchUserMeta(wpId, ['employer_interview_credits', 'employer_credits_used']);
      interview_credits = parseInt(cm.employer_interview_credits) || 0;
      credits_used      = parseInt(cm.employer_credits_used)      || 0;
    }

    // team_role: 'member' if this user is a team member, else 'admin'
    const team_role = adminUserId ? 'member' : 'admin';

    // Compute summary stats
    const completed        = interviews.filter(iv => iv.interview_status === 'completed');
    const total_interviews = interviews.length;
    const completed_count  = completed.length;
    const avg_score = completed_count > 0
      ? Math.round((completed.reduce((s, iv) => s + (iv.overall_score || 0), 0) / completed_count) * 10) / 10
      : null;
    const bandCounts = {};
    completed.forEach(iv => {
      if (iv.emp_readiness_band) bandCounts[iv.emp_readiness_band] = (bandCounts[iv.emp_readiness_band] || 0) + 1;
    });
    const top_band = Object.keys(bandCounts).sort((a, b) => bandCounts[b] - bandCounts[a])[0] || null;

    res.json({
      ok: true,
      count: interviews.length,
      interviews,
      interview_credits,
      credits_used,
      team_role,
      total_interviews,
      completed_count,
      avg_score,
      top_band,
      // Also nested for backward compatibility
      stats: { total_interviews, completed_count, avg_score, top_band },
    });
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

// ── Interview email (Brevo API) ────────────────────────────────────────────────
async function sendInterviewEmail({ candidateName, candidateEmail, interviewRole, sessionType, scheduledAt, joinUrl, joinToken }) {
  console.log('[sendInterviewEmail] attempting to send to:', candidateEmail, '| role:', interviewRole);
  const durationMin = sessionType === '30-min' ? 30 : 20;
  const firstName   = candidateName.split(' ')[0];

  // Parse scheduledAt (datetime-local: "YYYY-MM-DDTHH:MM") as UTC
  const dtStart = new Date(scheduledAt.includes('T') ? scheduledAt + ':00Z' : scheduledAt.replace(' ', 'T') + 'Z');
  const dtEnd   = new Date(dtStart.getTime() + durationMin * 60 * 1000);
  const isValidDt = !isNaN(dtStart.getTime());

  const scheduledDisplay = isValidDt
    ? dtStart.toUTCString().replace('GMT', 'UTC')
    : (scheduledAt ? scheduledAt : 'To be confirmed by employer');

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

  await makeBrevoClient().transactionalEmails.sendTransacEmail({
    sender:      { name: 'AGZIT AI', email: 'no-reply@mail.agzit.com' },
    to:          [{ email: candidateEmail, name: candidateName }],
    subject:     `Your AI Interview is Scheduled – ${interviewRole} | AGZIT`,
    htmlContent: html,
    attachment:  [{ name: 'interview-invite.ics', content: Buffer.from(ics, 'utf8').toString('base64') }],
  });
  console.log('[sendInterviewEmail] sent successfully to:', candidateEmail);
}

// ── GET /api/employer/test-email ─────────────────────────────────────────────
// Verify Brevo API key by sending a test email to the sender address itself.
// Returns { connected, error? }

router.get('/test-email', ...guardAny, async (req, res) => {
  try {
    await makeBrevoClient().transactionalEmails.sendTransacEmail({
      sender:      { name: 'AGZIT AI', email: 'no-reply@mail.agzit.com' },
      to:          [{ email: 'no-reply@mail.agzit.com' }],
      subject:     'AGZIT SMTP Test',
      htmlContent: '<p>SMTP test successful.</p>',
    });
    console.log('[test-email] Brevo test email sent OK');
    res.json({ connected: true });
  } catch (err) {
    console.error('[test-email] Brevo test FAILED:', err.message);
    res.json({ connected: false, error: err.message });
  }
});

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

    let wpUserId = user.wp_user_id;
    if (!wpUserId) return res.status(400).json({ ok: false, error: 'No WP user linked to this account' });

    // If this user is a team member, use the admin's credit pool
    const adminUserId = await resolveAdminUserId(user.id);
    if (adminUserId) {
      const [[adminUser]] = await pool.execute('SELECT wp_user_id FROM agzit_users WHERE id=? LIMIT 1', [adminUserId]);
      if (adminUser?.wp_user_id) wpUserId = adminUser.wp_user_id;
    }

    // Credit check — admin tops up manually via DB; no purchase flow
    const creditMeta     = await fetchUserMeta(wpUserId, ['employer_interview_credits', 'employer_credits_used']);
    const currentCredits = parseInt(creditMeta.employer_interview_credits) || 0;
    const currentUsed    = parseInt(creditMeta.employer_credits_used)      || 0;
    if (currentCredits <= 0) {
      return res.status(402).json({
        ok: false, error: 'no_credits',
        message: 'No interview credits remaining. Contact us to purchase.',
      });
    }

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
      ['employer_user_id',        String(wpUserId)],
      ['candidate_name',          candidateName],
      ['candidate_email',         candidateEmail],
      ['total_work_experience',   totalExp],
      ['interview_role',          interviewRole],
      ['session_type',            sessionType],
      ['scheduled_at',            scheduledAt],
      ['jd_raw_text',             jdRawText],
      ['resume_file',             resumeFile],
      ['interview_status',        'scheduled'],
      ['join_token',              joinToken],
      ['join_url',                joinUrl],
      ['scheduled_by_agzit_id',   String(req.user.user_id)],
    ];
    for (const [key, val] of metaRows) {
      await pool.execute(
        'INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
        [postId, key, val]
      );
    }

    // Deduct credit
    await upsertUserMeta(wpUserId, 'employer_interview_credits', String(currentCredits - 1));
    await upsertUserMeta(wpUserId, 'employer_credits_used',      String(currentUsed + 1));

    // Send candidate email — awaited so errors surface; schedule still succeeds if email fails
    let emailSent  = true;
    let emailError = null;
    console.log('[schedule-interview] candidate email resolved:', candidateEmail);
    try {
      await sendInterviewEmail({ candidateName, candidateEmail, interviewRole, sessionType, scheduledAt, joinUrl, joinToken });
      console.log('[schedule-interview] email sent successfully to:', candidateEmail);
    } catch (err) {
      emailSent  = false;
      emailError = err.message;
      console.error('[schedule-interview] email FAILED to:', candidateEmail, '|', err.message, err.stack);
    }

    console.log('[schedule-interview] created post_id=%d token=%s emailSent=%s', postId, joinToken, emailSent);
    res.json({ ok: true, post_id: postId, join_url: joinUrl, emailSent, ...(emailError && { emailError }) });
  } catch (err) {
    console.error('[employer/schedule-interview]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── Helper: upsert a single wp_postmeta row ────────────────────────────────────
async function upsertPostMeta(postId, key, value) {
  const [rows] = await pool.execute(
    'SELECT meta_id FROM wp_postmeta WHERE post_id = ? AND meta_key = ? LIMIT 1',
    [postId, key]
  );
  if (rows.length > 0) {
    await pool.execute(
      'UPDATE wp_postmeta SET meta_value = ? WHERE meta_id = ?',
      [String(value ?? ''), rows[0].meta_id]
    );
  } else {
    await pool.execute(
      'INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
      [postId, key, String(value ?? '')]
    );
  }
}

// ── Shared email helper: format scheduledAt string → display string ────────────
function fmtScheduledDisplay(scheduledAt) {
  if (!scheduledAt) return 'To be confirmed';
  const dt = new Date(scheduledAt.includes('T') ? scheduledAt + ':00Z' : scheduledAt.replace(' ', 'T') + 'Z');
  return !isNaN(dt.getTime()) ? dt.toUTCString().replace('GMT', 'UTC') : scheduledAt;
}

// ── PATCH /api/employer/interviews/:id ─────────────────────────────────────────
// Reschedule / edit interview details. Sends reschedule notification to candidate.

router.patch('/interviews/:id', ...guardVerified, async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    if (!postId) return res.status(400).json({ ok: false, error: 'Invalid interview ID' });

    const [[user]] = await pool.execute(
      'SELECT wp_user_id FROM agzit_users WHERE id = ?', [req.user.user_id]
    );
    const wpId = user?.wp_user_id;
    if (!wpId) return res.status(400).json({ ok: false, error: 'No WP user linked' });

    const [[ownership]] = await pool.execute(
      "SELECT meta_id FROM wp_postmeta WHERE post_id = ? AND meta_key = 'employer_user_id' AND meta_value = ? LIMIT 1",
      [postId, String(wpId)]
    );
    if (!ownership) return res.status(403).json({ ok: false, error: 'Interview not found or access denied' });

    const m = await fetchPostMeta(postId, [
      'candidate_name', 'candidate_email', 'interview_role',
      'session_type', 'scheduled_at', 'join_url', 'interview_status',
    ]);
    if (m.interview_status === 'cancelled') {
      return res.status(400).json({ ok: false, error: 'Cannot edit a cancelled interview' });
    }

    const { scheduled_at, session_type, interview_role, jd_raw_text } = req.body;
    if (scheduled_at)   await upsertPostMeta(postId, 'scheduled_at',   scheduled_at);
    if (session_type)   await upsertPostMeta(postId, 'session_type',   session_type);
    if (interview_role) await upsertPostMeta(postId, 'interview_role', interview_role);
    if (jd_raw_text)    await upsertPostMeta(postId, 'jd_raw_text',    jd_raw_text);

    await pool.execute(
      'UPDATE wp_posts SET post_modified = NOW(), post_modified_gmt = UTC_TIMESTAMP() WHERE ID = ?',
      [postId]
    );

    const finalRole    = interview_role || m.interview_role  || 'Interview';
    const finalSlot    = scheduled_at   || m.scheduled_at   || '';
    const finalType    = session_type   || m.session_type   || '20-min';
    const durationMin  = finalType === '30-min' ? 30 : 20;
    const firstName    = (m.candidate_name || '').split(' ')[0] || 'Candidate';
    const scheduledDisplay = fmtScheduledDisplay(finalSlot);

    if (m.candidate_email) {
      makeBrevoClient().transactionalEmails.sendTransacEmail({
        sender:      { name: 'AGZIT AI', email: 'no-reply@mail.agzit.com' },
        to:          [{ email: m.candidate_email, name: m.candidate_name || '' }],
        subject:     `Your AI Interview has been rescheduled — ${finalRole} | AGZIT`,
        htmlContent: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:Inter,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:40px 16px;">
<tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="background:linear-gradient(135deg,#0A1A3A 0%,#162848 100%);border-radius:16px 16px 0 0;padding:32px;text-align:center;">
    <div style="font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#C9A24D;margin-bottom:12px;">AGZIT &middot; AI Career Intelligence</div>
    <div style="font-size:24px;font-weight:800;color:#fff;margin-bottom:6px;">Interview Rescheduled</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.55);">Your updated interview details are below.</div>
  </td></tr>
  <tr><td style="background:#fff;padding:36px 32px;">
    <p style="margin:0 0 22px;font-size:15.5px;color:#1E293B;line-height:1.75;">Hello <strong>${firstName}</strong>,</p>
    <p style="margin:0 0 28px;font-size:15px;color:#374151;line-height:1.75;">Your AI Interview has been <strong>rescheduled</strong>. Please see the updated details below.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:12px;margin-bottom:28px;">
      <tr><td style="padding:0 22px;"><table width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="padding:16px 0;border-bottom:1px solid #F1F5F9;">
          <div style="font-size:10.5px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Interview Role</div>
          <div style="font-size:16px;font-weight:700;color:#0A1A3A;">${finalRole}</div>
        </td></tr>
        <tr><td style="padding:16px 0;border-bottom:1px solid #F1F5F9;">
          <div style="font-size:10.5px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">New Date &amp; Time</div>
          <div style="font-size:16px;font-weight:700;color:#0A1A3A;">${scheduledDisplay}</div>
        </td></tr>
        <tr><td style="padding:16px 0;">
          <div style="font-size:10.5px;font-weight:700;color:#94A3B8;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">Duration</div>
          <div style="font-size:16px;font-weight:700;color:#0A1A3A;">${durationMin} Minutes</div>
        </td></tr>
      </table></td></tr>
    </table>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
      <tr><td align="center">
        <a href="${m.join_url || '#'}" style="display:inline-block;background:#0A1A3A;color:#fff;text-decoration:none;padding:15px 40px;border-radius:10px;font-size:15px;font-weight:700;">Join Your Interview</a>
      </td></tr>
    </table>
    <p style="margin:0;font-size:12.5px;color:#94A3B8;">Join link: <span style="color:#0A1A3A;word-break:break-all;">${m.join_url || ''}</span></p>
  </td></tr>
  <tr><td style="background:#F8FAFC;border-top:1px solid #E2E8F0;border-radius:0 0 16px 16px;padding:20px 32px;text-align:center;">
    <div style="font-size:11px;font-weight:700;color:#0A1A3A;letter-spacing:2px;text-transform:uppercase;">AGZIT</div>
    <div style="font-size:12px;color:#94A3B8;margin-top:6px;">AI Career Intelligence System &nbsp;&bull;&nbsp; <a href="https://agzit.com" style="color:#C9A24D;text-decoration:none;">agzit.com</a></div>
  </td></tr>
</table></td></tr></table></body></html>`,
      }).catch(err => console.error('[interviews/edit] reschedule email error:', err.message));
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[employer/interviews/edit]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── DELETE /api/employer/interviews/:id ─────────────────────────────────────────
// Cancel interview + send cancellation email to candidate.

router.delete('/interviews/:id', ...guardVerified, async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    if (!postId) return res.status(400).json({ ok: false, error: 'Invalid interview ID' });

    const [[user]] = await pool.execute(
      'SELECT wp_user_id FROM agzit_users WHERE id = ?', [req.user.user_id]
    );
    const wpId = user?.wp_user_id;
    if (!wpId) return res.status(400).json({ ok: false, error: 'No WP user linked' });

    const [[ownership]] = await pool.execute(
      "SELECT meta_id FROM wp_postmeta WHERE post_id = ? AND meta_key = 'employer_user_id' AND meta_value = ? LIMIT 1",
      [postId, String(wpId)]
    );
    if (!ownership) return res.status(403).json({ ok: false, error: 'Interview not found or access denied' });

    const m = await fetchPostMeta(postId, [
      'candidate_name', 'candidate_email', 'interview_role', 'session_type',
      'scheduled_at', 'interview_status',
    ]);
    if (m.interview_status === 'completed') {
      return res.status(400).json({ ok: false, error: 'Completed interviews cannot be cancelled' });
    }
    if (m.interview_status === 'cancelled') {
      return res.json({ ok: true, already_cancelled: true });
    }

    await pool.execute(
      "UPDATE wp_postmeta SET meta_value = 'cancelled' WHERE post_id = ? AND meta_key = 'interview_status'",
      [postId]
    );
    await pool.execute(
      'UPDATE wp_posts SET post_modified = NOW(), post_modified_gmt = UTC_TIMESTAMP() WHERE ID = ?',
      [postId]
    );

    const firstName        = (m.candidate_name || '').split(' ')[0] || 'Candidate';
    const role             = m.interview_role || 'Interview';
    const scheduledDisplay = fmtScheduledDisplay(m.scheduled_at);

    if (m.candidate_email) {
      makeBrevoClient().transactionalEmails.sendTransacEmail({
        sender:      { name: 'AGZIT AI', email: 'no-reply@mail.agzit.com' },
        to:          [{ email: m.candidate_email, name: m.candidate_name || '' }],
        subject:     `Your AI Interview has been cancelled — ${role} | AGZIT`,
        htmlContent: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:Inter,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:40px 16px;">
<tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="background:linear-gradient(135deg,#7F1D1D 0%,#991B1B 100%);border-radius:16px 16px 0 0;padding:32px;text-align:center;">
    <div style="font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#FCA5A5;margin-bottom:12px;">AGZIT &middot; AI Career Intelligence</div>
    <div style="font-size:24px;font-weight:800;color:#fff;margin-bottom:6px;">Interview Cancelled</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.7);">Your interview has been cancelled by the employer.</div>
  </td></tr>
  <tr><td style="background:#fff;padding:36px 32px;">
    <p style="margin:0 0 22px;font-size:15.5px;color:#1E293B;line-height:1.75;">Hello <strong>${firstName}</strong>,</p>
    <p style="margin:0 0 28px;font-size:15px;color:#374151;line-height:1.75;">
      Your scheduled AI Interview for <strong>${role}</strong> on <strong>${scheduledDisplay}</strong> has been <strong>cancelled</strong> by the employer.
    </p>
    <p style="margin:0;font-size:14px;color:#6B7280;line-height:1.7;">If you have questions, please contact the employer directly.</p>
  </td></tr>
  <tr><td style="background:#F8FAFC;border-top:1px solid #E2E8F0;border-radius:0 0 16px 16px;padding:20px 32px;text-align:center;">
    <div style="font-size:11px;font-weight:700;color:#0A1A3A;letter-spacing:2px;text-transform:uppercase;">AGZIT</div>
    <div style="font-size:12px;color:#94A3B8;margin-top:6px;">AI Career Intelligence System &nbsp;&bull;&nbsp; <a href="https://agzit.com" style="color:#C9A24D;text-decoration:none;">agzit.com</a></div>
  </td></tr>
</table></td></tr></table></body></html>`,
      }).catch(err => console.error('[interviews/cancel] email error:', err.message));
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[employer/interviews/delete]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/employer/interviews/:id/resend-invite ────────────────────────────
// Resend the original invite email with current interview details.

router.post('/interviews/:id/resend-invite', ...guardVerified, async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    if (!postId) return res.status(400).json({ ok: false, error: 'Invalid interview ID' });

    const [[user]] = await pool.execute(
      'SELECT wp_user_id FROM agzit_users WHERE id = ?', [req.user.user_id]
    );
    const wpId = user?.wp_user_id;
    if (!wpId) return res.status(400).json({ ok: false, error: 'No WP user linked' });

    const [[ownership]] = await pool.execute(
      "SELECT meta_id FROM wp_postmeta WHERE post_id = ? AND meta_key = 'employer_user_id' AND meta_value = ? LIMIT 1",
      [postId, String(wpId)]
    );
    if (!ownership) return res.status(403).json({ ok: false, error: 'Interview not found or access denied' });

    const m = await fetchPostMeta(postId, [
      'candidate_name', 'candidate_email', 'interview_role',
      'session_type', 'scheduled_at', 'join_url', 'join_token', 'interview_status',
    ]);
    if (m.interview_status === 'cancelled') {
      return res.status(400).json({ ok: false, error: 'Cannot resend invite for a cancelled interview' });
    }
    if (!m.candidate_email) {
      return res.status(400).json({ ok: false, error: 'No candidate email on file' });
    }

    await sendInterviewEmail({
      candidateName:  m.candidate_name  || '',
      candidateEmail: m.candidate_email,
      interviewRole:  m.interview_role  || '',
      sessionType:    m.session_type    || '20-min',
      scheduledAt:    m.scheduled_at    || '',
      joinUrl:        m.join_url        || '',
      joinToken:      m.join_token      || '',
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('[employer/interviews/resend-invite]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── Team helpers ──────────────────────────────────────────────────────────────

// Return the admin_user_id if this user is a team member, else null
async function resolveAdminUserId(userId) {
  const [[row]] = await pool.execute(
    "SELECT admin_user_id FROM agzit_employer_team WHERE member_user_id = ? AND status = 'active' LIMIT 1",
    [userId]
  );
  return row ? row.admin_user_id : null;
}

// ── GET /api/employer/team ─────────────────────────────────────────────────────
// List all team members for this employer (admin only).
// If the user is a team member, they are not shown the team tab in the frontend.

router.get('/team', ...guardVerified, async (req, res) => {
  try {
    const userId = req.user.user_id;

    // Only admins can list the team.  A member calling this gets 403.
    const memberCheck = await resolveAdminUserId(userId);
    if (memberCheck) return res.status(403).json({ ok: false, error: 'Team management is only available to the company admin.' });

    const [rows] = await pool.execute(
      `SELECT id, member_email, member_name, team_role, status, invited_at, joined_at,
              member_user_id
       FROM agzit_employer_team
       WHERE admin_user_id = ? AND status != 'removed'
       ORDER BY invited_at DESC`,
      [userId]
    );
    res.json({ ok: true, members: rows });
  } catch (err) {
    console.error('[employer/team GET]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/employer/team/invite ─────────────────────────────────────────────
// Invite a new team member by email. Creates their account immediately.
// Body: { first_name, last_name, email }

router.post('/team/invite', ...guardVerified, async (req, res) => {
  try {
    const userId     = req.user.user_id;
    const adminEmail = req.user.email;

    // Members cannot invite
    const memberCheck = await resolveAdminUserId(userId);
    if (memberCheck) return res.status(403).json({ ok: false, error: 'Only the company admin can invite members.' });

    const email      = String(req.body.email      || '').trim().toLowerCase();
    const firstName  = String(req.body.first_name || '').trim();
    const lastName   = String(req.body.last_name  || '').trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Valid email address is required.' });
    }
    if (!firstName) {
      return res.status(400).json({ ok: false, error: 'First name is required.' });
    }
    if (email === adminEmail) {
      return res.status(400).json({ ok: false, error: 'You cannot invite yourself.' });
    }

    const displayName = [firstName, lastName].filter(Boolean).join(' ');

    // Check if already in team
    const [[existing]] = await pool.execute(
      "SELECT id, status FROM agzit_employer_team WHERE admin_user_id = ? AND member_email = ? LIMIT 1",
      [userId, email]
    );
    if (existing && existing.status === 'active') {
      return res.status(409).json({ ok: false, error: 'This person is already an active team member.' });
    }

    // ── Ensure member has an agzit_users account (created at invite time) ────
    let agzitUserId;
    const [[existingAgzit]] = await pool.execute(
      'SELECT id FROM agzit_users WHERE email = ? LIMIT 1', [email]
    );

    if (existingAgzit) {
      agzitUserId = existingAgzit.id;
      // Ensure role is verified_employer, fill in name if blank
      await pool.execute(
        `UPDATE agzit_users
         SET role='verified_employer',
             first_name = IF(first_name IS NULL OR first_name = '', ?, first_name),
             last_name  = IF(last_name  IS NULL OR last_name  = '', ?, last_name)
         WHERE id = ?`,
        [firstName, lastName, agzitUserId]
      );
    } else {
      // Look for existing wp_users row
      let wpUserId = null;
      const [[wpUser]] = await pool.execute(
        'SELECT ID FROM wp_users WHERE user_email = ? LIMIT 1', [email]
      );
      if (wpUser) {
        wpUserId = wpUser.ID;
        await pool.execute('UPDATE wp_users SET display_name = ? WHERE ID = ?', [displayName, wpUserId]);
        await upsertUserMeta(wpUserId, 'first_name', firstName);
        await upsertUserMeta(wpUserId, 'last_name', lastName);
      } else {
        // Create wp_users row (random placeholder password — member will use magic link or set password later)
        const randomPass = crypto.randomBytes(16).toString('hex');
        const [wpResult] = await pool.execute(
          `INSERT INTO wp_users (user_login, user_pass, user_email, user_registered, display_name, user_status)
           VALUES (?, ?, ?, NOW(), ?, 0)`,
          [email, randomPass, email, displayName]
        );
        wpUserId = wpResult.insertId;
        await upsertUserMeta(wpUserId, 'first_name', firstName);
        await upsertUserMeta(wpUserId, 'last_name', lastName);
      }

      // Create agzit_users (random password hash — they will set a real one after first login)
      const phash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);
      const [agzitResult] = await pool.execute(
        `INSERT INTO agzit_users (email, password_hash, role, first_name, last_name, wp_user_id)
         VALUES (?, ?, 'verified_employer', ?, ?, ?)`,
        [email, phash, firstName, lastName, wpUserId]
      );
      agzitUserId = agzitResult.insertId;
    }

    // ── Create or update agzit_employer_team entry ────────────────────────────
    if (existing) {
      await pool.execute(
        "UPDATE agzit_employer_team SET status='invited', member_user_id=?, member_name=?, invite_token=NULL, invited_at=NOW(), joined_at=NULL WHERE id=?",
        [agzitUserId, displayName, existing.id]
      );
    } else {
      await pool.execute(
        "INSERT INTO agzit_employer_team (admin_user_id, member_user_id, member_email, member_name) VALUES (?, ?, ?, ?)",
        [userId, agzitUserId, email, displayName]
      );
    }

    // ── Create magic link (7-day expiry) ─────────────────────────────────────
    // Invalidate any prior unused team_invite links for this user
    await pool.execute(
      "UPDATE agzit_magic_links SET used_at=NOW() WHERE user_id=? AND purpose='team_invite' AND used_at IS NULL",
      [agzitUserId]
    );
    const magicToken = crypto.randomBytes(32).toString('hex');
    const expiresAt  = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await pool.execute(
      "INSERT INTO agzit_magic_links (token, user_id, purpose, expires_at) VALUES (?, ?, 'team_invite', ?)",
      [magicToken, agzitUserId, expiresAt]
    );

    // ── Get admin company name ────────────────────────────────────────────────
    const [[adminUser]] = await pool.execute(
      'SELECT wp_user_id FROM agzit_users WHERE id = ?', [userId]
    );
    const adminMeta = adminUser?.wp_user_id
      ? await fetchUserMeta(adminUser.wp_user_id, ['dpr_company_name'])
      : {};
    const company = adminMeta.dpr_company_name || adminEmail.split('@')[1] || 'AGZIT';

    // ── Send personalised invite email ────────────────────────────────────────
    const inviteUrl = `https://app.agzit.com/employer-accept-invite?token=${magicToken}`;

    await makeBrevoClient().transactionalEmails.sendTransacEmail({
      sender:      { name: 'AGZIT AI', email: 'no-reply@mail.agzit.com' },
      to:          [{ email, name: displayName }],
      subject:     `Hi ${firstName}, you've been invited to join ${company} on AGZIT`,
      htmlContent: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F1F5F9;font-family:Inter,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9;padding:40px 16px;">
<tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="background:linear-gradient(135deg,#0A1A3A 0%,#162848 100%);border-radius:16px 16px 0 0;padding:32px;text-align:center;">
    <div style="font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:#C9A24D;margin-bottom:12px;">AGZIT &middot; AI Career Intelligence</div>
    <div style="font-size:24px;font-weight:800;color:#fff;margin-bottom:6px;">You're Invited</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.55);">Join ${company} on AGZIT</div>
  </td></tr>
  <tr><td style="background:#fff;padding:36px 32px;">
    <p style="margin:0 0 18px;font-size:15px;color:#1E293B;line-height:1.75;">Hi <strong>${firstName}</strong>,</p>
    <p style="margin:0 0 18px;font-size:15px;color:#1E293B;line-height:1.75;"><strong>${company}</strong> has invited you to join their employer account on AGZIT.</p>
    <p style="margin:0 0 28px;font-size:14px;color:#374151;line-height:1.75;">Click the button below to accept the invitation and access your shared employer dashboard. Your account has already been created &mdash; no registration required.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td align="center">
        <a href="${inviteUrl}" style="display:inline-block;background:#0A1A3A;color:#fff;text-decoration:none;padding:15px 40px;border-radius:10px;font-size:15px;font-weight:700;">Accept Invitation &amp; Log In</a>
      </td></tr>
    </table>
    <p style="margin:0;font-size:12px;color:#94A3B8;line-height:1.7;">If the button does not work, copy and paste: <span style="color:#0A1A3A;word-break:break-all;">${inviteUrl}</span></p>
    <p style="margin:16px 0 0;font-size:12px;color:#94A3B8;">This link expires in 7 days. After logging in, you can set a password to log in normally next time.</p>
  </td></tr>
  <tr><td style="background:#F8FAFC;border-top:1px solid #E2E8F0;border-radius:0 0 16px 16px;padding:20px 32px;text-align:center;">
    <div style="font-size:11px;font-weight:700;color:#0A1A3A;letter-spacing:2px;text-transform:uppercase;">AGZIT</div>
    <div style="font-size:12px;color:#94A3B8;margin-top:6px;">AI Career Intelligence System &nbsp;&bull;&nbsp; <a href="https://agzit.com" style="color:#C9A24D;text-decoration:none;">agzit.com</a></div>
  </td></tr>
</table></td></tr></table></body></html>`,
    });

    res.json({ ok: true, message: `Invitation sent to ${email}.` });
  } catch (err) {
    console.error('[employer/team/invite]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── DELETE /api/employer/team/:id ──────────────────────────────────────────────
// Remove a team member.

router.delete('/team/:id', ...guardVerified, async (req, res) => {
  try {
    const userId   = req.user.user_id;
    const memberId = parseInt(req.params.id);
    if (!memberId) return res.status(400).json({ ok: false, error: 'Invalid team member ID' });

    const memberCheck = await resolveAdminUserId(userId);
    if (memberCheck) return res.status(403).json({ ok: false, error: 'Only the company admin can remove members.' });

    const [[row]] = await pool.execute(
      "SELECT id FROM agzit_employer_team WHERE id = ? AND admin_user_id = ? LIMIT 1",
      [memberId, userId]
    );
    if (!row) return res.status(404).json({ ok: false, error: 'Team member not found' });

    await pool.execute(
      "UPDATE agzit_employer_team SET status='removed' WHERE id=?",
      [memberId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[employer/team DELETE]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/employer/team/set-password ────────────────────────────────────────
// First-login password setup for team members.
// Body: { password } OR { dismiss: true }

router.post('/team/set-password', ...guardAny, async (req, res) => {
  try {
    const userId  = req.user.user_id;
    const dismiss = req.body.dismiss === true;

    if (!dismiss) {
      const password = String(req.body.password || '');
      if (password.length < 8) {
        return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters.' });
      }
      const hashed = await bcrypt.hash(password, 12);
      await pool.execute('UPDATE agzit_users SET password_hash=? WHERE id=?', [hashed, userId]);
    }

    // Mark password setup complete (or dismissed)
    await pool.execute('UPDATE agzit_users SET has_set_password=1 WHERE id=?', [userId]);

    res.json({ ok: true });
  } catch (err) {
    console.error('[employer/team/set-password]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── JD Template helpers ───────────────────────────────────────────────────────

// Return the agzit_users.id to use as admin_user_id for JD templates.
// If the caller is a team member, use the admin's id so templates are shared.
async function resolveTemplateAdminId(userId) {
  const adminId = await resolveAdminUserId(userId).catch(() => null);
  return adminId !== null ? adminId : userId;
}

// ── GET /api/employer/jd-templates ───────────────────────────────────────────
router.get('/jd-templates', ...guardAny, async (req, res) => {
  try {
    const adminId = await resolveTemplateAdminId(req.user.user_id);
    const [rows] = await pool.execute(
      'SELECT id, template_name, role_title, jurisdiction, jd_text, created_at FROM agzit_jd_templates WHERE admin_user_id = ? ORDER BY created_at DESC',
      [adminId]
    );
    res.json({ ok: true, templates: rows });
  } catch (err) {
    console.error('[employer/jd-templates GET]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/employer/jd-templates ─────────────────────────────────────────
// Body: { template_name, role_title, jurisdiction?, jd_text }
router.post('/jd-templates', ...guardAny, async (req, res) => {
  try {
    const adminId      = await resolveTemplateAdminId(req.user.user_id);
    const templateName = String(req.body.template_name || '').trim();
    const roleTitle    = String(req.body.role_title    || '').trim();
    const jurisdiction = String(req.body.jurisdiction  || '').trim();
    const jdText       = String(req.body.jd_text       || '').trim();

    if (!templateName) return res.status(400).json({ ok: false, error: 'Template name is required' });
    if (!roleTitle)    return res.status(400).json({ ok: false, error: 'Role title is required' });
    if (!jdText)       return res.status(400).json({ ok: false, error: 'Job description is required' });

    const [ins] = await pool.execute(
      'INSERT INTO agzit_jd_templates (admin_user_id, template_name, role_title, jurisdiction, jd_text) VALUES (?, ?, ?, ?, ?)',
      [adminId, templateName, roleTitle, jurisdiction || null, jdText]
    );
    res.json({ ok: true, id: ins.insertId });
  } catch (err) {
    console.error('[employer/jd-templates POST]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── PUT /api/employer/jd-templates/:id ──────────────────────────────────────
// Body: { template_name, role_title, jurisdiction?, jd_text }
router.put('/jd-templates/:id', ...guardAny, async (req, res) => {
  try {
    const adminId      = await resolveTemplateAdminId(req.user.user_id);
    const id           = parseInt(req.params.id);
    const templateName = String(req.body.template_name || '').trim();
    const roleTitle    = String(req.body.role_title    || '').trim();
    const jurisdiction = String(req.body.jurisdiction  || '').trim();
    const jdText       = String(req.body.jd_text       || '').trim();

    if (!id)           return res.status(400).json({ ok: false, error: 'Invalid template ID' });
    if (!templateName) return res.status(400).json({ ok: false, error: 'Template name is required' });
    if (!roleTitle)    return res.status(400).json({ ok: false, error: 'Role title is required' });
    if (!jdText)       return res.status(400).json({ ok: false, error: 'Job description is required' });

    const [result] = await pool.execute(
      'UPDATE agzit_jd_templates SET template_name=?, role_title=?, jurisdiction=?, jd_text=? WHERE id=? AND admin_user_id=?',
      [templateName, roleTitle, jurisdiction || null, jdText, id, adminId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ ok: false, error: 'Template not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[employer/jd-templates PUT]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── DELETE /api/employer/jd-templates/:id ───────────────────────────────────
router.delete('/jd-templates/:id', ...guardAny, async (req, res) => {
  try {
    const adminId = await resolveTemplateAdminId(req.user.user_id);
    const id      = parseInt(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: 'Invalid template ID' });

    const [result] = await pool.execute(
      'DELETE FROM agzit_jd_templates WHERE id=? AND admin_user_id=?',
      [id, adminId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ ok: false, error: 'Template not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[employer/jd-templates DELETE]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/employer/bulk-schedule ────────────────────────────────────────
// Schedule multiple AI interviews at once — one per candidate email.
// Body: { emails: string (newline/comma separated) | string[],
//         interview_role, session_type, jd_raw_text }
// Returns: { ok, scheduled: [], not_found: [], already_scheduled: [] }

router.post('/bulk-schedule', ...guardVerified, async (req, res) => {
  try {
    const [[user]] = await pool.execute(
      'SELECT id, wp_user_id FROM agzit_users WHERE id = ?',
      [req.user.user_id]
    );
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    let wpUserId = user.wp_user_id;
    if (!wpUserId) return res.status(400).json({ ok: false, error: 'No WP user linked to this account' });

    const adminUserId = await resolveAdminUserId(user.id);
    if (adminUserId) {
      const [[adminUser]] = await pool.execute('SELECT wp_user_id FROM agzit_users WHERE id=? LIMIT 1', [adminUserId]);
      if (adminUser?.wp_user_id) wpUserId = adminUser.wp_user_id;
    }

    const interviewRole = String(req.body.interview_role || '').trim();
    const sessionType   = String(req.body.session_type   || '20-min').trim();
    const jdRawText     = String(req.body.jd_raw_text    || '').trim();
    const rawEmails     = req.body.emails;

    if (!interviewRole) return res.status(400).json({ ok: false, error: 'Interview role is required' });
    if (!jdRawText)     return res.status(400).json({ ok: false, error: 'Job description is required' });
    if (!['20-min', '30-min'].includes(sessionType)) {
      return res.status(400).json({ ok: false, error: 'session_type must be 20-min or 30-min' });
    }

    // Parse and deduplicate emails
    let emails = [];
    if (Array.isArray(rawEmails)) {
      emails = rawEmails.map(e => String(e).trim().toLowerCase()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    } else if (typeof rawEmails === 'string') {
      emails = rawEmails.split(/[\n,]+/).map(e => e.trim().toLowerCase()).filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    }
    emails = [...new Set(emails)];

    if (!emails.length) return res.status(400).json({ ok: false, error: 'At least one valid email address is required' });
    if (emails.length > 50) return res.status(400).json({ ok: false, error: 'Maximum 50 emails per bulk schedule' });

    // Credit check
    const creditMeta     = await fetchUserMeta(wpUserId, ['employer_interview_credits', 'employer_credits_used']);
    const currentCredits = parseInt(creditMeta.employer_interview_credits) || 0;
    const currentUsed    = parseInt(creditMeta.employer_credits_used)      || 0;
    if (currentCredits <= 0) {
      return res.status(402).json({ ok: false, error: 'no_credits', message: 'No interview credits remaining. Contact us to purchase.' });
    }

    // Look up candidates registered in agzit_users
    const placeholders = emails.map(() => '?').join(',');
    const [foundUsers] = await pool.execute(
      `SELECT email, first_name, last_name FROM agzit_users WHERE email IN (${placeholders})`,
      emails
    );
    const foundMap = {};
    for (const u of foundUsers) foundMap[u.email] = u;

    // Find emails that already have a scheduled interview with this employer
    const existingScheduled = new Set();
    if (emails.length) {
      const [existRows] = await pool.execute(
        `SELECT pm_email.meta_value AS email
         FROM wp_postmeta pm_email
         INNER JOIN wp_postmeta pm_emp    ON pm_emp.post_id    = pm_email.post_id AND pm_emp.meta_key    = 'employer_user_id' AND pm_emp.meta_value = ?
         INNER JOIN wp_postmeta pm_status ON pm_status.post_id = pm_email.post_id AND pm_status.meta_key = 'interview_status' AND pm_status.meta_value = 'scheduled'
         INNER JOIN wp_posts p            ON p.ID              = pm_email.post_id AND p.post_type = 'employer_interview' AND p.post_status = 'publish'
         WHERE pm_email.meta_key = 'candidate_email'
           AND pm_email.meta_value IN (${placeholders})`,
        [String(wpUserId), ...emails]
      );
      for (const r of existRows) existingScheduled.add(r.email);
    }

    const scheduled         = [];
    const not_found         = [];
    const already_scheduled = [];
    let creditsRemaining    = currentCredits;
    let creditsUsedDelta    = 0;

    for (const email of emails) {
      if (!foundMap[email])          { not_found.push(email);         continue; }
      if (existingScheduled.has(email)) { already_scheduled.push(email); continue; }
      if (creditsRemaining <= 0)     { not_found.push(email);         continue; } // ran out mid-loop

      const candidate     = foundMap[email];
      const candidateName = [candidate.first_name, candidate.last_name].filter(Boolean).join(' ') || email;
      const joinToken     = crypto.randomUUID();
      const joinUrl       = 'https://app.agzit.com/employer-interviews?token=' + joinToken;
      const postTitle     = candidateName + ' \u2013 ' + interviewRole;

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

      const metaRows = [
        ['employer_user_id',      String(wpUserId)],
        ['candidate_name',        candidateName],
        ['candidate_email',       email],
        ['interview_role',        interviewRole],
        ['session_type',          sessionType],
        ['scheduled_at',          ''],
        ['jd_raw_text',           jdRawText],
        ['interview_status',      'scheduled'],
        ['join_token',            joinToken],
        ['join_url',              joinUrl],
        ['scheduled_by_agzit_id', String(req.user.user_id)],
      ];
      for (const [key, val] of metaRows) {
        await pool.execute(
          'INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
          [postId, key, val]
        );
      }

      // Send email best-effort — failure does not block the response
      try {
        await sendInterviewEmail({ candidateName, candidateEmail: email, interviewRole, sessionType, scheduledAt: '', joinUrl, joinToken });
      } catch (e) {
        console.error('[bulk-schedule] email failed for', email, ':', e.message);
      }

      scheduled.push(email);
      creditsRemaining--;
      creditsUsedDelta++;
    }

    if (creditsUsedDelta > 0) {
      await upsertUserMeta(wpUserId, 'employer_interview_credits', String(creditsRemaining));
      await upsertUserMeta(wpUserId, 'employer_credits_used',      String(currentUsed + creditsUsedDelta));
    }

    console.log('[bulk-schedule] scheduled=%d not_found=%d already_scheduled=%d', scheduled.length, not_found.length, already_scheduled.length);
    res.json({ ok: true, scheduled, not_found, already_scheduled });
  } catch (err) {
    console.error('[employer/bulk-schedule]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/employer/compare-candidates ─────────────────────────────────────
// Compare up to 4 candidates by email.
// For each email: looks up agzit_users + DPR profile postmeta + most recent
// completed employer_interview scorecard belonging to this employer.

function parseTextToArray(text) {
  if (!text) return [];
  return text.split('\n')
    .map(l => l.replace(/^[-•*]\s*/, '').trim())
    .filter(l => l.length > 0);
}

const COMPARE_SCORE_KEYS = [
  'score_communication', 'score_structure', 'score_role_knowledge',
  'score_domain_application', 'score_problem_solving', 'score_confidence',
  'score_question_handling', 'score_experience_relevance', 'score_resume_alignment',
  'depth_specificity',
];
const COMPARE_POST_KEYS = [
  'candidate_name', 'candidate_email', 'interview_role', 'total_work_experience',
  'emp_readiness_band', 'mock_performance_level', 'mock_strengths', 'mock_improvements',
  ...COMPARE_SCORE_KEYS,
];

router.get('/compare-candidates', ...guardVerified, async (req, res) => {
  try {
    const rawEmails = typeof req.query.emails === 'string' ? req.query.emails : '';
    const emails = [...new Set(
      rawEmails.split(',')
        .map(e => e.trim().toLowerCase())
        .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    )].slice(0, 4);

    if (emails.length < 2) {
      return res.status(400).json({ ok: false, error: 'At least 2 valid email addresses required' });
    }

    const [[user]] = await pool.execute(
      'SELECT wp_user_id FROM agzit_users WHERE id = ?',
      [req.user.user_id]
    );
    const wpId = user?.wp_user_id;
    if (!wpId) return res.status(400).json({ ok: false, error: 'No WP user linked' });

    // Team members share the admin's interview pool
    const adminAgzitId = await resolveAdminUserId(req.user.user_id).catch(() => null);
    let adminWpId = wpId;
    if (adminAgzitId) {
      const [[adminUser]] = await pool.execute(
        'SELECT wp_user_id FROM agzit_users WHERE id = ?',
        [adminAgzitId]
      );
      if (adminUser?.wp_user_id) adminWpId = adminUser.wp_user_id;
    }

    const int = (v) => (v !== null && v !== undefined && v !== '') ? parseInt(v) : null;

    const candidates = await Promise.all(emails.map(async (email) => {
      // 1. Find candidate in agzit_users
      const [[cand]] = await pool.execute(
        'SELECT id, first_name, last_name, wp_user_id FROM agzit_users WHERE LOWER(email) = ? LIMIT 1',
        [email]
      );

      // 2. DPR profile postmeta for role/experience fallback
      let dprData = {};
      if (cand?.wp_user_id) {
        const [[profRow]] = await pool.execute(
          "SELECT meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key = 'dpr_profile_post_id' LIMIT 1",
          [cand.wp_user_id]
        );
        const profilePostId = profRow?.meta_value ? parseInt(profRow.meta_value) : null;
        if (profilePostId) {
          dprData = await fetchPostMeta(profilePostId, ['full_name', 'total_work_experience', 'desired_role', 'compliance_domains']);
        }
      }

      // 3. Most recent completed employer interview for this candidate under this employer
      const [[ivPost]] = await pool.execute(
        `SELECT p.ID, p.post_date
         FROM wp_posts p
         INNER JOIN wp_postmeta em ON em.post_id = p.ID AND em.meta_key = 'employer_user_id' AND em.meta_value = ?
         INNER JOIN wp_postmeta ce ON ce.post_id = p.ID AND ce.meta_key = 'candidate_email' AND LOWER(ce.meta_value) = ?
         INNER JOIN wp_postmeta st ON st.post_id = p.ID AND st.meta_key = 'interview_status' AND st.meta_value = 'completed'
         WHERE p.post_type = 'employer_interview' AND p.post_status = 'publish'
         ORDER BY p.post_date DESC
         LIMIT 1`,
        [String(adminWpId), email]
      );

      if (!ivPost) {
        return {
          email,
          name:                  cand ? `${cand.first_name || ''} ${cand.last_name || ''}`.trim() || null : null,
          found:                 !!cand,
          has_scorecard:         false,
          role_title:            dprData.desired_role || null,
          total_work_experience: dprData.total_work_experience || null,
          overall_score:         null,
          readiness_band:        null,
          emp_readiness_band:    null,
          scores:                null,
          strengths:             [],
          areas_to_improve:      [],
          interview_date:        null,
        };
      }

      const m            = await fetchPostMeta(ivPost.ID, COMPARE_POST_KEYS);
      const parsedScores = COMPARE_SCORE_KEYS.map(k => int(m[k]));
      const validScores  = parsedScores.filter(s => s !== null);
      const overall_score = validScores.length > 0 ? validScores.reduce((a, b) => a + b, 0) : null;

      return {
        email,
        name:                  m.candidate_name || (cand ? `${cand.first_name || ''} ${cand.last_name || ''}`.trim() : null) || email,
        found:                 true,
        has_scorecard:         validScores.length > 0,
        role_title:            m.interview_role || dprData.desired_role || null,
        total_work_experience: m.total_work_experience || dprData.total_work_experience || null,
        overall_score,
        readiness_band:     m.mock_performance_level || null,
        emp_readiness_band: m.emp_readiness_band || null,
        scores: {
          communication:        int(m.score_communication),
          answer_structure:     int(m.score_structure),
          role_knowledge:       int(m.score_role_knowledge),
          domain_application:   int(m.score_domain_application),
          problem_solving:      int(m.score_problem_solving),
          confidence:           int(m.score_confidence),
          question_handling:    int(m.score_question_handling),
          experience_relevance: int(m.score_experience_relevance),
          resume_alignment:     int(m.score_resume_alignment),
          depth_specificity:    int(m.depth_specificity),
        },
        strengths:        parseTextToArray(m.mock_strengths).slice(0, 2),
        areas_to_improve: parseTextToArray(m.mock_improvements).slice(0, 2),
        interview_date:   ivPost.post_date,
      };
    }));

    console.log('[compare-candidates] user_id=%s count=%d', req.user.user_id, candidates.length);
    res.json({ ok: true, candidates });
  } catch (err) {
    console.error('[employer/compare-candidates]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── Startup: ensure tables exist + seed employer_team_role for existing employers ──

(async () => {
  try {
    // Ensure agzit_employer_team table exists
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS agzit_employer_team (
        id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        admin_user_id   INT UNSIGNED NOT NULL,
        member_user_id  INT UNSIGNED DEFAULT NULL,
        member_email    VARCHAR(255) NOT NULL,
        member_name     VARCHAR(255) DEFAULT NULL,
        team_role       ENUM('admin','member') NOT NULL DEFAULT 'member',
        status          ENUM('invited','active','removed') NOT NULL DEFAULT 'invited',
        invite_token    VARCHAR(128) DEFAULT NULL,
        invited_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        joined_at       DATETIME DEFAULT NULL,
        INDEX idx_admin  (admin_user_id),
        INDEX idx_member (member_user_id),
        INDEX idx_email  (member_email),
        INDEX idx_token  (invite_token)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Migrations — add columns if table already existed without them
    await pool.execute(
      `ALTER TABLE agzit_employer_team
       ADD COLUMN IF NOT EXISTS member_name VARCHAR(255) DEFAULT NULL`
    ).catch(() => {});  // Ignore if already exists or MySQL < 8.0
    await pool.execute(
      `ALTER TABLE agzit_users
       ADD COLUMN IF NOT EXISTS has_set_password TINYINT(1) NOT NULL DEFAULT 0`
    ).catch(() => {});

    // Ensure agzit_magic_links table exists
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS agzit_magic_links (
        id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        token      VARCHAR(128) NOT NULL UNIQUE,
        user_id    INT UNSIGNED NOT NULL,
        purpose    VARCHAR(32) NOT NULL DEFAULT 'login',
        expires_at DATETIME NOT NULL,
        used_at    DATETIME DEFAULT NULL,
        INDEX idx_token (token),
        INDEX idx_user  (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Seed employer_team_role = 'admin' for verified_employer users who have no role set
    const [employers] = await pool.execute(`
      SELECT DISTINCT u.ID
      FROM wp_users u
      JOIN wp_usermeta um
        ON u.ID = um.user_id
        AND um.meta_key = 'wp_capabilities'
        AND um.meta_value LIKE '%verified_employer%'
      LEFT JOIN wp_usermeta tr
        ON u.ID = tr.user_id
        AND tr.meta_key = 'employer_team_role'
      WHERE tr.umeta_id IS NULL
    `);
    for (const emp of employers) {
      await pool.execute(
        "INSERT INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (?, 'employer_team_role', 'admin')",
        [emp.ID]
      );
    }
    if (employers.length > 0) {
      console.log(`[employer] Seeded employer_team_role=admin for ${employers.length} existing employer(s)`);
    }
  } catch (e) {
    console.error('[employer] Startup seed error:', e.message);
  }
})();

module.exports = router;
