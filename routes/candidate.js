// routes/candidate.js — Candidate API routes
// All routes require: JWT auth + dpr_candidate role
// Field names sourced directly from WordPress ACF snippet files.

const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const guard = [requireAuth, requireRole('dpr_candidate')];

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getProfileId(userId) {
  const [[user]] = await pool.execute(
    'SELECT dpr_profile_id FROM agzit_users WHERE id = ?',
    [userId]
  );
  return user?.dpr_profile_id || null;
}

// Fetch all non-private postmeta for a WP post (excludes ACF field-key rows)
async function fetchPostMeta(postId) {
  const [rows] = await pool.execute(
    "SELECT meta_key, meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key NOT LIKE '\_%'",
    [postId]
  );
  const meta = {};
  for (const r of rows) meta[r.meta_key] = r.meta_value;
  return meta;
}

// Parse a flat ACF repeater from the postmeta map
// e.g. parseRepeater(meta, 'work_experience', ['job_title','company_name', ...])
function parseRepeater(meta, field, subfields) {
  const count = parseInt(meta[field]) || 0;
  const rows  = [];
  for (let i = 0; i < count; i++) {
    const row = {};
    for (const sf of subfields) {
      row[sf] = meta[`${field}_${i}_${sf}`] ?? null;
    }
    rows.push(row);
  }
  return rows;
}

// Fetch selected wp_usermeta keys for a WP user
async function fetchUserMeta(wpUserId, keys) {
  if (!wpUserId) return {};
  const ph = keys.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT meta_key, meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key IN (${ph})`,
    [wpUserId, ...keys]
  );
  const meta = {};
  for (const r of rows) meta[r.meta_key] = r.meta_value;
  return meta;
}

// Load profile meta in one shot
async function loadProfile(userId) {
  const profileId = await getProfileId(userId);
  if (!profileId) return null;
  const meta = await fetchPostMeta(profileId);
  return { profileId, meta };
}

// ── All interview session subfields (used in multiple routes) ─────────────────
const SESSION_SUBFIELDS = [
  'session_id', 'started_at', 'session_type', 'interview_role',
  'target_career_level', 'interview_status', 'duration_minutes',
  'audio_url', 'video_url', 'recording_id', 'share_token', 'share_expires_at',
  'jd_raw_text',
  // Scorecard — 9 core scores
  'score_communication', 'score_structure', 'score_role_knowledge',
  'score_domain_application', 'score_problem_solving', 'score_confidence',
  'score_question_handling', 'score_experience_relevance', 'score_resume_alignment',
  // Scorecard — overall + feedback
  'mock_overall_score', 'mock_performance_level',
  'mock_strengths', 'mock_improvements', 'mock_next_focus', 'mock_attention_areas',
];

// ── GET /api/candidate/dashboard ─────────────────────────────────────────────
// One-shot: user info + profile highlights + entitlements + recent interviews + latest scorecard

router.get('/dashboard', ...guard, async (req, res) => {
  try {
    const [[user]] = await pool.execute(
      'SELECT id, email, first_name, last_name, dpr_profile_id, wp_user_id, created_at FROM agzit_users WHERE id = ?',
      [req.user.user_id]
    );
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    const meta = user.dpr_profile_id ? await fetchPostMeta(user.dpr_profile_id) : null;

    // Parse sessions for both recent-interviews and latest-scorecard
    const sessions = meta
      ? parseRepeater(meta, 'mock_interview_sessions', SESSION_SUBFIELDS)
      : [];

    const recentInterviews = [...sessions].reverse().slice(0, 5).map(s => ({
      session_id:          s.session_id,
      started_at:          s.started_at,
      interview_role:      s.interview_role,
      interview_status:    s.interview_status,
      duration_minutes:    s.duration_minutes,
      audio_url:           s.audio_url,
      video_url:           s.video_url,
      mock_overall_score:  s.mock_overall_score,
      mock_performance_level: s.mock_performance_level,
    }));

    const latestScorecard = [...sessions].reverse().find(s => s.mock_overall_score) || null;

    // Interview entitlements from wp_usermeta (if WP user linked)
    const userMeta = user.wp_user_id
      ? await fetchUserMeta(user.wp_user_id, [
          'mock_sessions_remaining_20',
          'mock_sessions_remaining_30',
          'mock_sessions_remaining',
          'mock_valid_until',
        ])
      : {};

    res.json({
      ok: true,
      user: {
        id:         user.id,
        email:      user.email,
        first_name: user.first_name,
        last_name:  user.last_name,
        created_at: user.created_at,
      },
      profile: meta ? {
        dpr_id:               meta.dpr_id,
        full_name:            meta.full_name,
        dpr_status:           meta.dpr_status,
        profile_completeness: meta.profile_completeness,
        open_for_work_badge:  meta.open_for_work_badge,
        compliance_domains:   meta.compliance_domains,
        current_career_level: meta.current_career_level,
        profile_visibility:   meta.profile_visibility,
        contact_visibility:   meta.contact_visibility,
        resume_visibility:    meta.resume_visibility,
      } : null,
      entitlements: {
        sessions_20: parseInt(userMeta.mock_sessions_remaining_20) || 0,
        sessions_30: parseInt(userMeta.mock_sessions_remaining_30) || 0,
        total:       parseInt(userMeta.mock_sessions_remaining)    || 0,
        valid_until: userMeta.mock_valid_until || null,
      },
      recent_interviews: recentInterviews,
      latest_scorecard:  latestScorecard,
    });
  } catch (err) {
    console.error('[candidate/dashboard]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/candidate/profile ────────────────────────────────────────────────
// Full DPR profile — all ACF fields, all repeaters

router.get('/profile', ...guard, async (req, res) => {
  try {
    const data = await loadProfile(req.user.user_id);
    if (!data) return res.status(404).json({ ok: false, error: 'Profile not found' });
    const { meta } = data;

    // Repeaters — exact subfield names from dpr-self-profile + dpr-build-context-pack-v2
    const workExperience = parseRepeater(meta, 'work_experience', [
      'job_title', 'company_name', 'office_country', 'office_city',
      'start_date', 'end_date', 'Currently_working',   // capital C — ACF naming
      'key_responsibilities', 'employment_type', 'key_achievements',
    ]);
    const education = parseRepeater(meta, 'education', [
      'degree', 'institution_name', 'edu_country', 'edu_city',
      'edu_start_date', 'edu_end_date',
    ]);
    const certifications = parseRepeater(meta, 'certifications', [
      'certification_name', 'credential_id', 'issuing_organization',
      'cert_issue_date', 'cert_expiry_date', 'certificate_pdf',
    ]);
    const complianceTools     = parseRepeater(meta, 'compliance_tools',     ['tool_name']);
    const languageProficiency = parseRepeater(meta, 'language_proficiency', ['language']);
    const preferredLocation   = parseRepeater(meta, 'preferred_location',   [
      'preferred_city_name', 'preferred_country_name',
    ]);

    res.json({
      ok: true,
      profile: {
        // ── Personal information
        dpr_id:                           meta.dpr_id,
        full_name:                        meta.full_name,
        email_address:                    meta.email_address,
        phone_number:                     meta.phone_number,
        gender:                           meta.gender,
        date_of_birth:                    meta.date_of_birth,
        country_of_nationality:           meta.country_of_nationality,
        residential_address_line_1:       meta.residential_address_line_1,
        residential_address_line_2:       meta.residential_address_line_2,
        residential_city:                 meta.residential_city,
        residential_zip_code:             meta.residential_zip_code,
        residential_state:                meta.residential_state,
        residential_country:              meta.residential_country,
        linkedin_url:                     meta.linkedin_url,
        profile_photo:                    meta.profile_photo,
        issue_date:                       meta.issue_date,
        dpr_id_view_count:                meta.dpr_id_view_count,

        // ── Professional summary
        professional_summary_bio:         meta.professional_summary_bio,
        total_work_experience:            meta.total_work_experience,
        compliance_domains:               meta.compliance_domains,   // "Industry / Functional Area"
        current_employment_status:        meta.current_employment_status,
        notice_period_in_days:            meta.notice_period_in_days,
        current_annual_ctc_with_currency: meta.current_annual_ctc_with_currency,
        open_to_relocate:                 meta.open_to_relocate,
        open_for_work_badge:              meta.open_for_work_badge,
        current_career_level:             meta.current_career_level,

        // ── Skills & expertise
        soft_skills:                      meta.soft_skills,          // ACF label: "Skills"
        compliance_tools:                 complianceTools,            // ACF label: "Tools & Software"
        language_proficiency:             languageProficiency,

        // ── Job preferences
        desired_role:                     meta.desired_role,
        work_level:                       meta.work_level,
        preferred_location:               preferredLocation,
        expected_annual_ctc_with_currency: meta.expected_annual_ctc_with_currency,
        preferred_work_type:              meta.preferred_work_type,
        resume_upload:                    meta.resume_upload,

        // ── Repeaters
        work_experience:                  workExperience,
        education:                        education,
        certifications:                   certifications,

        // ── Verification badges (admin-set)
        id_verified:                      meta.id_verified,
        address_verified:                 meta.address_verified,
        experience_verified:              meta.experience_verified,
        certificate_verified:             meta.certificate_verified,
        public_name_mode:                 meta.public_name_mode,
        profile_completeness:             meta.profile_completeness,
        profile_last_updated:             meta.profile_last_updated,
        dpr_status:                       meta.dpr_status,

        // ── Visibility
        profile_visibility:               meta.profile_visibility,
        contact_visibility:               meta.contact_visibility,
        resume_visibility:                meta.resume_visibility,
      },
    });
  } catch (err) {
    console.error('[candidate/profile]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/candidate/scorecard ──────────────────────────────────────────────
// Returns latest scored session + all scored sessions (newest first)

router.get('/scorecard', ...guard, async (req, res) => {
  try {
    const data = await loadProfile(req.user.user_id);
    if (!data) return res.status(404).json({ ok: false, error: 'Profile not found' });

    const sessions = parseRepeater(data.meta, 'mock_interview_sessions', SESSION_SUBFIELDS);
    const scored   = [...sessions].reverse().filter(s => s.mock_overall_score);

    res.json({
      ok:              true,
      latest_scorecard: scored[0] || null,
      all_scorecards:   scored,
    });
  } catch (err) {
    console.error('[candidate/scorecard]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/candidate/interviews ─────────────────────────────────────────────
// Full session history, newest first, all 29 subfields

router.get('/interviews', ...guard, async (req, res) => {
  try {
    const data = await loadProfile(req.user.user_id);
    if (!data) return res.status(404).json({ ok: false, error: 'Profile not found' });

    const sessions = parseRepeater(data.meta, 'mock_interview_sessions', SESSION_SUBFIELDS);

    res.json({
      ok:       true,
      count:    sessions.length,
      sessions: [...sessions].reverse(), // newest first
    });
  } catch (err) {
    console.error('[candidate/interviews]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/candidate/resume ─────────────────────────────────────────────────
// Resume info + visibility setting

router.get('/resume', ...guard, async (req, res) => {
  try {
    const data = await loadProfile(req.user.user_id);
    if (!data) return res.status(404).json({ ok: false, error: 'Profile not found' });
    const { meta } = data;

    res.json({
      ok:     true,
      resume: {
        dpr_id:            meta.dpr_id,
        full_name:         meta.full_name,
        email_address:     meta.email_address,
        phone_number:      meta.phone_number,
        linkedin_url:      meta.linkedin_url,
        resume_upload:     meta.resume_upload,      // WP attachment ID or array
        resume_visibility: meta.resume_visibility,  // re_public | re_verified_only | re_private
      },
    });
  } catch (err) {
    console.error('[candidate/resume]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── PATCH /api/candidate/visibility ──────────────────────────────────────────
// Toggle employer-facing visibility settings
// Body: { profile_visibility?, contact_visibility?, resume_visibility? }

router.patch('/visibility', ...guard, async (req, res) => {
  const ALLOWED_VALUES = {
    profile_visibility: ['public', 'private'],
    contact_visibility: ['co_public', 'co_verified_only', 'co_private'],
    resume_visibility:  ['re_public', 're_verified_only', 're_private'],
  };

  try {
    const profileId = await getProfileId(req.user.user_id);
    if (!profileId) return res.status(404).json({ ok: false, error: 'Profile not found' });

    const updates = {};
    for (const [field, allowed] of Object.entries(ALLOWED_VALUES)) {
      if (req.body[field] !== undefined) {
        if (!allowed.includes(req.body[field])) {
          return res.status(400).json({ ok: false, error: `Invalid value for ${field}: must be one of ${allowed.join(', ')}` });
        }
        updates[field] = req.body[field];
      }
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ ok: false, error: 'No valid fields provided' });
    }

    // Upsert each visibility field in wp_postmeta
    for (const [field, value] of Object.entries(updates)) {
      await pool.execute(
        `INSERT INTO wp_postmeta (post_id, meta_key, meta_value)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE meta_value = VALUES(meta_value)`,
        [profileId, field, value]
      );
    }

    res.json({ ok: true, updated: updates });
  } catch (err) {
    console.error('[candidate/visibility]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
