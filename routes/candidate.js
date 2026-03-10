// routes/candidate.js — Candidate API routes
// All routes require: JWT auth + dpr_candidate role
// Field names sourced directly from WordPress ACF snippet files.

const express  = require('express');
const router   = express.Router();
const pool     = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const https    = require('https');
const jwt      = require('jsonwebtoken');
const multer      = require('multer');
const pdfParse    = require('pdf-parse');

// multer: in-memory storage, 5 MB limit, PDF only
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
});

const guard = [requireAuth, requireRole('dpr_candidate')];

// ── Unlock helpers (used by /resume/download for employer access checks) ─────

function parseUnlockedMap(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch { return {}; }
}

function isProfileUnlocked(unlockedMap, dprId) {
  if (!dprId) return false;
  const entry = unlockedMap[dprId];
  if (!entry) return false;
  const expires = parseInt(entry.expires) || 0;
  if (expires > 0 && Math.floor(Date.now() / 1000) > expires) return false;
  return true;
}

// ── OpenAI API helper ────────────────────────────────────────────────────────

async function callOpenAI(systemPrompt, userContent, maxTokens = 1500) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(30000),
    body: JSON.stringify({
      model:       'gpt-4o',
      temperature: 0,
      max_tokens:  maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent  },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || '';
}

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
    "SELECT meta_key, meta_value FROM wp_postmeta WHERE post_id = ? AND LEFT(meta_key, 1) != '_'",
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

// ── Industry label map + parser ───────────────────────────────────────────────
const INDUSTRY_LABEL = {
  compliance:'Compliance / Regulatory', finance:'Finance / Treasury',
  accounting:'Accounting / Taxation', banking:'Banking / Financial Services',
  risk:'Risk Management', fraud:'Fraud / Anti-Fraud', audit:'Audit & Assurance',
  legal:'Legal / Law', insurance:'Insurance', hr:'Human Resources',
  administration:'Administration', sales:'Sales / Business Development',
  marketing:'Marketing / Brand', product:'Product Management',
  operations:'Operations', procurement:'Procurement',
  supply_chain:'Logistics / Supply Chain', customer_support:'Customer Support',
  data:'Data / Analytics', it:'IT / Systems', software:'Software Development',
  cybersecurity:'Cybersecurity', erp_crm:'ERP / CRM', qa:'Quality / QA',
  r_and_d:'Research & Development', engineering:'Engineering', telecom:'Telecom',
  network_admin:'System / Network Administration', hardware_it:'IT Hardware / Support',
  architecture:'Architecture', design:'Graphic / Web Design',
  media:'Media / Journalism', content:'Content / Editing',
  translation:'Language Translation', education:'Teaching / Education',
  healthcare:'Healthcare / Medical', pharma:'Pharmaceutical',
  manufacturing:'Production / Manufacturing', site_engineering:'Site Engineering',
  civil:'Civil / Surveying', mech_electrical:'Mechanical / Electrical',
  hse:'Health, Safety & Environment', aviation:'Aviation',
  marine:'Marine / Shipping', oil_gas:'Oil & Gas / Energy',
  mining:'Mining / Geology', security:'Security Services', retail:'Retail',
  hospitality:'Hospitality / F&B', travel:'Travel / Ticketing',
  transport:'Transport / Driving', government:'Government / Public Sector',
  management:'Senior Management', freshers:'Fresh Graduates', other:'Other',
};

function parseComplianceDomains(raw) {
  if (!raw) return '';
  let keys = [];
  const str = String(raw).trim();
  if (str.startsWith('a:')) {
    // PHP serialized: a:1:{i:0;s:10:"compliance";}
    const matches = str.match(/s:\d+:"([^"]+)"/g) || [];
    keys = matches.map(m => m.match(/s:\d+:"([^"]+)"/)[1]);
  } else {
    try {
      const parsed = JSON.parse(str);
      keys = Array.isArray(parsed) ? parsed : [str];
    } catch (_) {
      keys = [str];
    }
  }
  return keys.map(k => INDUSTRY_LABEL[k] || k).filter(Boolean).join(', ');
}

// ── All interview session subfields (used in multiple routes) ─────────────────
const SESSION_SUBFIELDS = [
  'session_id', 'started_at', 'session_type', 'interview_role',
  'target_career_level', 'interview_status', 'duration_minutes',
  'audio_url', 'video_url', 'recording_id', 'share_token', 'share_expires_at',
  'jd_raw_text',
  // Scorecard — 10 core scores
  'score_communication', 'score_structure', 'score_role_knowledge',
  'score_domain_application', 'score_problem_solving', 'score_confidence',
  'score_question_handling', 'score_experience_relevance', 'score_resume_alignment',
  'depth_specificity',
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
        dpr_id_view_count:    meta.dpr_id_view_count,
        open_for_work_badge:  meta.open_for_work_badge,
        compliance_domains:   parseComplianceDomains(meta.compliance_domains),
        current_career_level: meta.current_career_level,
        profile_visibility:   meta.profile_visibility,
        email_visibility:     meta.email_visibility,
        phone_visibility:     meta.phone_visibility,
        resume_visibility:    meta.resume_visibility,
        current_address:      meta.residential_address_line_1,
        key_achievements:     meta.key_achievements,
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
    if (!data) return res.json({ ok: true, profile: null, has_dpr_profile: false });
    const { meta, profileId } = data;

    // Repeaters — exact subfield names from dpr-self-profile + dpr-build-context-pack-v2
    const workExperience = parseRepeater(meta, 'work_experience', [
      'job_title', 'company_name', 'office_country', 'office_city',
      'start_date', 'end_date', 'Currently_working',   // capital C — ACF naming
      'key_responsibilities', 'key_achievements',
    ]);
    // Sort work experience: currently working first, then by start_date descending
    workExperience.sort((a, b) => {
      const aCurr = String(a.Currently_working || '').toLowerCase() === 'yes';
      const bCurr = String(b.Currently_working || '').toLowerCase() === 'yes';
      if (aCurr && !bCurr) return -1;
      if (!aCurr && bCurr) return 1;
      return (b.start_date || '').localeCompare(a.start_date || '');
    });

    const education = parseRepeater(meta, 'education', [
      'degree', 'institution_name', 'edu_country', 'edu_city',
      'edu_start_date', 'edu_end_date',
    ]);
    // Sort education: by edu_end_date descending (most recent graduation first)
    education.sort((a, b) => (b.edu_end_date || '').localeCompare(a.edu_end_date || ''));

    const certifications = parseRepeater(meta, 'certifications', [
      'certification_name', 'credential_id', 'issuing_organization',
      'cert_issue_date', 'cert_expiry_date', 'certificate_pdf',
    ]);
    // Sort certifications: by cert_issue_date descending
    certifications.sort((a, b) => (b.cert_issue_date || '').localeCompare(a.cert_issue_date || ''));
    const complianceTools     = parseRepeater(meta, 'compliance_tools',     ['tool_name']);
    const languageProficiency = parseRepeater(meta, 'language_proficiency', ['language']);
    const preferredLocation   = parseRepeater(meta, 'preferred_location',   [
      'preferred_city_name', 'preferred_country_name',
    ]);

    // Check agzit_resume_files for actual resume existence (fixes stale meta)
    let resumeRow = null;
    try {
      const [[row]] = await pool.execute(
        'SELECT filename FROM agzit_resume_files WHERE post_id = ? LIMIT 1', [profileId]
      );
      resumeRow = row || null;
    } catch (_) { /* table may not exist yet */ }
    const hasResumeActual = !!(resumeRow || meta.has_resume === '1' || meta.resume_upload);
    // Auto-heal: if resume exists in DB but meta missing, set it now
    if (resumeRow && meta.has_resume !== '1') {
      upsertPostMeta(profileId, 'has_resume', '1').catch(() => {});
      upsertPostMeta(profileId, 'resume_upload', String(profileId)).catch(() => {});
    }

    res.json({
      ok:              true,
      has_dpr_profile: true,
      dpr_post_id:     profileId,
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
        compliance_domains:               meta.compliance_domains,  // raw; parseIndustry() handles display client-side
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
        resume_upload:                    meta.resume_upload || (resumeRow ? String(profileId) : null),
        has_resume:                       hasResumeActual ? '1' : null,
        resume_filename:                  meta.resume_filename || (resumeRow ? resumeRow.filename : null),
        resume_uploaded_at:               meta.resume_uploaded_at,
        key_achievements:                 meta.key_achievements,

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
        email_visibility:                 meta.email_visibility,
        phone_visibility:                 meta.phone_visibility,
        resume_visibility:                meta.resume_visibility,

        // ── New fields
        key_achievements:                 meta.key_achievements,
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

    // ?session_id=XXX — return a specific session's full scorecard
    const { session_id } = req.query;
    if (session_id) {
      const session = sessions.find(s => s.session_id === session_id);
      if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });
      return res.json({ ok: true, session });
    }

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
// Mock sessions (ACF repeater) + employer-scheduled interviews (employer_interview WP posts)

const EMP_INTERVIEW_KEYS = [
  'candidate_email', 'candidate_name', 'role_title', 'scheduled_at', 'status',
  'audio_url', 'video_url', 'admin_user_id', 'company_name',
  'emp_overall_score', 'emp_readiness_band', 'emp_strengths', 'emp_areas_to_improve',
  'score_communication', 'score_structure', 'score_role_knowledge',
  'score_domain_application', 'score_problem_solving', 'score_confidence',
  'score_question_handling', 'score_experience_relevance', 'score_resume_alignment',
  'depth_specificity',
];

router.get('/interviews', ...guard, async (req, res) => {
  try {
    const data = await loadProfile(req.user.user_id);
    if (!data) return res.status(404).json({ ok: false, error: 'Profile not found' });

    const sessions = parseRepeater(data.meta, 'mock_interview_sessions', SESSION_SUBFIELDS);

    // Employer-scheduled interviews — matched by candidate email
    const userEmail = req.user.email;
    let employer_interviews = [];

    if (userEmail) {
      const [empPosts] = await pool.execute(
        `SELECT p.ID, p.post_date FROM wp_posts p
         JOIN wp_postmeta pm ON pm.post_id = p.ID AND pm.meta_key = 'candidate_email' AND pm.meta_value = ?
         WHERE p.post_type = 'employer_interview'
           AND p.post_status NOT IN ('trash', 'auto-draft')
         ORDER BY p.post_date DESC LIMIT 50`,
        [userEmail]
      );

      if (empPosts.length) {
        const ph = EMP_INTERVIEW_KEYS.map(() => '?').join(',');
        employer_interviews = await Promise.all(empPosts.map(async (p) => {
          const [metaRows] = await pool.execute(
            `SELECT meta_key, meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key IN (${ph})`,
            [p.ID, ...EMP_INTERVIEW_KEYS]
          );
          const m = {};
          for (const r of metaRows) m[r.meta_key] = r.meta_value;

          // Resolve employer display name
          let employer_name = m.company_name || null;
          if (!employer_name && m.admin_user_id) {
            const [[eu]] = await pool.execute(
              'SELECT first_name, last_name FROM agzit_users WHERE id = ? LIMIT 1',
              [parseInt(m.admin_user_id)]
            ).catch(() => [[null]]);
            if (eu) employer_name = [eu.first_name, eu.last_name].filter(Boolean).join(' ') || null;
          }

          return {
            post_id:            p.ID,
            post_date:          p.post_date,
            role_title:         m.role_title    || null,
            scheduled_at:       m.scheduled_at  || p.post_date,
            status:             m.status        || 'pending',
            audio_url:          m.audio_url     || null,
            video_url:          m.video_url     || null,
            employer_name,
            emp_overall_score:          m.emp_overall_score  || null,
            emp_readiness_band:         m.emp_readiness_band || null,
            emp_strengths:              m.emp_strengths      || null,
            emp_areas_to_improve:       m.emp_areas_to_improve || null,
            score_communication:        m.score_communication || null,
            score_structure:            m.score_structure || null,
            score_role_knowledge:       m.score_role_knowledge || null,
            score_domain_application:   m.score_domain_application || null,
            score_problem_solving:      m.score_problem_solving || null,
            score_confidence:           m.score_confidence || null,
            score_question_handling:    m.score_question_handling || null,
            score_experience_relevance: m.score_experience_relevance || null,
            score_resume_alignment:     m.score_resume_alignment || null,
            depth_specificity:          m.depth_specificity || null,
          };
        }));
      }
    }

    res.json({
      ok:                 true,
      count:              sessions.length,
      sessions:           [...sessions].reverse(), // newest first
      employer_interviews,
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

// ── PATCH /api/candidate/account ─────────────────────────────────────────────
// Change password
// Body: { current_password, new_password }

router.patch('/account', ...guard, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return res.status(400).json({ ok: false, error: 'Current and new passwords are required.' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ ok: false, error: 'New password must be at least 8 characters.' });
    }

    const [[user]] = await pool.execute(
      'SELECT id, password_hash FROM agzit_users WHERE id = ?',
      [req.user.user_id]
    );
    if (!user) return res.status(404).json({ ok: false, error: 'User not found.' });

    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return res.status(401).json({ ok: false, error: 'Current password is incorrect.' });

    const newHash = await bcrypt.hash(new_password, 12);
    await pool.execute('UPDATE agzit_users SET password_hash = ? WHERE id = ?', [newHash, user.id]);

    res.json({ ok: true, message: 'Password updated successfully.' });
  } catch (err) {
    console.error('[candidate/account]', err);
    res.status(500).json({ ok: false, error: 'Server error.' });
  }
});

// ── PATCH /api/candidate/visibility ──────────────────────────────────────────
// Toggle employer-facing visibility settings
// Body: { profile_visibility?, email_visibility?, phone_visibility?, resume_visibility? }

router.patch('/visibility', ...guard, async (req, res) => {
  const ALLOWED_VALUES = {
    profile_visibility: ['public', 'private'],
    email_visibility:   ['co_public', 'co_verified_only', 'co_private'],
    phone_visibility:   ['co_public', 'co_verified_only', 'co_private'],
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

// ── Additional helpers ────────────────────────────────────────────────────────

// SELECT+UPDATE or INSERT for wp_usermeta (no unique constraint — safe upsert)
async function upsertUserMeta(wpUserId, metaKey, metaValue) {
  const [rows] = await pool.execute(
    'SELECT umeta_id FROM wp_usermeta WHERE user_id = ? AND meta_key = ? LIMIT 1',
    [wpUserId, metaKey]
  );
  if (rows.length > 0) {
    await pool.execute('UPDATE wp_usermeta SET meta_value = ? WHERE umeta_id = ?', [String(metaValue), rows[0].umeta_id]);
  } else {
    await pool.execute('INSERT INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (?, ?, ?)', [wpUserId, metaKey, String(metaValue)]);
  }
}

// Build the candidate context pack text block (matches dpr_build_context_pack_panel_v2 format)
// meta is the full wp_postmeta map; jdText, interviewRole, careerLevel come from the form
function buildContextPack(meta, jdText, interviewRole, careerLevel) {
  const lines = ['=== CANDIDATE PROFILE ==='];

  if (meta.full_name)             lines.push(`Candidate Name: ${meta.full_name}`);
  if (meta.email_address)         lines.push(`Email: ${meta.email_address}`);
  if (meta.phone_number)          lines.push(`Phone: ${meta.phone_number}`);
  if (meta.total_work_experience) lines.push(`Total Experience: ${meta.total_work_experience} years`);
  if (careerLevel)                lines.push(`Career Level: ${careerLevel}`);
  if (meta.compliance_domains)    lines.push(`Industry / Domain: ${meta.compliance_domains}`);

  if (meta.professional_summary_bio) {
    lines.push('', 'Professional Summary:', String(meta.professional_summary_bio).slice(0, 80000));
  }

  // Work experience — up to 7 rows (ACF repeater pattern: work_experience_{i}_{field})
  const workCount = parseInt(meta.work_experience) || 0;
  const workRows  = [];
  for (let i = 0; i < Math.min(workCount, 7); i++) {
    const title   = meta[`work_experience_${i}_job_title`]             || '';
    const company = meta[`work_experience_${i}_company_name`]           || '';
    const resp    = meta[`work_experience_${i}_key_responsibilities`]   || '';
    if (title || company) {
      workRows.push(`- ${title}${company ? ` at ${company}` : ''}${resp ? `: ${resp}` : ''}`);
    }
  }
  if (workRows.length) lines.push('', 'Work Experience:', ...workRows);

  // Tools & Software — compliance_tools repeater, top 10
  const toolCount = parseInt(meta.compliance_tools) || 0;
  const tools     = [];
  for (let i = 0; i < Math.min(toolCount, 10); i++) {
    const t = meta[`compliance_tools_${i}_tool_name`] || '';
    if (t) tools.push(t);
  }
  if (tools.length) lines.push('', `Tools & Software: ${tools.join(', ')}`);

  if (meta.soft_skills) {
    lines.push('', `Skills: ${String(meta.soft_skills).slice(0, 40000)}`);
  }

  lines.push('', '=== JOB DESCRIPTION ===');
  if (interviewRole) lines.push(`Role Applied For: ${interviewRole}`);
  if (careerLevel)   lines.push(`Target Career Level: ${careerLevel}`);
  if (jdText)        lines.push('', String(jdText).slice(0, 80000));

  return lines.join('\n');
}

// POST JSON to a URL using Node.js built-in https (no external deps)
function postJson(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u       = new URL(url);
    const isHttps = u.protocol === 'https:';
    const mod     = isHttps ? https : require('http');

    const req = mod.request({
      hostname: u.hostname,
      port:     u.port || (isHttps ? 443 : 80),
      path:     u.pathname + u.search,
      method:   'POST',
      headers:  Object.assign({
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      }, headers),
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── POST /api/candidate/interviews/start ─────────────────────────────────────
// Create a new mock interview session; returns SID + redirect URL
// Body: { interview_role, target_career_level, chosen_minutes (20|30), jd_raw_text? }

router.post('/interviews/start', ...guard, async (req, res) => {
  try {
    const [[user]] = await pool.execute(
      'SELECT id, wp_user_id, dpr_profile_id FROM agzit_users WHERE id = ?',
      [req.user.user_id]
    );
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    const wpUserId      = user.wp_user_id;
    const profilePostId = user.dpr_profile_id;

    if (!wpUserId)      return res.status(400).json({ ok: false, error: 'WP account not linked. Please contact support.' });
    if (!profilePostId) return res.status(400).json({ ok: false, error: 'DPR profile not found. Please complete registration first.' });

    // ── Validate body ─────────────────────────────────────────────────────────
    const interviewRole  = typeof req.body.interview_role === 'string'       ? req.body.interview_role.trim()       : '';
    const careerLevelIn  = typeof req.body.target_career_level === 'string'  ? req.body.target_career_level.trim()  : '';
    const chosenMinutes  = parseInt(req.body.chosen_minutes) || 0;
    const jdText         = typeof req.body.jd_raw_text === 'string'          ? req.body.jd_raw_text.trim()          : '';

    if (!interviewRole)                  return res.status(400).json({ ok: false, error: 'interview_role is required' });
    if (![20, 30].includes(chosenMinutes)) return res.status(400).json({ ok: false, error: 'chosen_minutes must be 20 or 30' });

    const creditKey = chosenMinutes === 20 ? 'mock_sessions_remaining_20' : 'mock_sessions_remaining_30';

    // ── Load entitlements + lock state ────────────────────────────────────────
    const userMeta = await fetchUserMeta(wpUserId, [
      'mock_sessions_remaining_20',
      'mock_sessions_remaining_30',
      'mock_sessions_remaining',
      'mock_valid_until',
      'mock_session_lock_until',
      'mock_session_lock_id',
    ]);

    const nowTs      = Math.floor(Date.now() / 1000);
    const validUntil = parseInt(userMeta.mock_valid_until) || 0;

    // Expiry check — zero out buckets if plan has expired
    if (validUntil > 0 && nowTs > validUntil) {
      await upsertUserMeta(wpUserId, 'mock_sessions_remaining_20', '0');
      await upsertUserMeta(wpUserId, 'mock_sessions_remaining_30', '0');
      await upsertUserMeta(wpUserId, 'mock_sessions_remaining',    '0');
      return res.status(402).json({ ok: false, error: 'Your interview credits have expired. Please purchase a new plan.' });
    }

    // Credits check
    const credits = parseInt(userMeta[creditKey]) || 0;
    if (credits < 1) {
      return res.status(402).json({
        ok: false,
        error: `No ${chosenMinutes}-minute interview credits remaining. Please purchase more.`,
      });
    }

    // Lock check — prevent concurrent sessions
    const lockUntil = parseInt(userMeta.mock_session_lock_until) || 0;
    if (nowTs < lockUntil) {
      const waitMins = Math.ceil((lockUntil - nowTs) / 60);
      return res.status(409).json({
        ok: false,
        error: `An interview session is already in progress. Please wait ${waitMins} minute${waitMins === 1 ? '' : 's'}.`,
        lock_until: lockUntil,
      });
    }

    // ── Generate SID: MIS- + first 8 chars of UUID4 uppercase ────────────────
    const sid = 'MIS-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();

    // ── Build context pack ────────────────────────────────────────────────────
    const profileMeta   = await fetchPostMeta(profilePostId);
    const careerLevel   = careerLevelIn || profileMeta.current_career_level || 'mid';
    const contextPack   = buildContextPack(profileMeta, jdText, interviewRole, careerLevel);

    // ── Share token + expiry ──────────────────────────────────────────────────
    const shareToken     = crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
    const shareExpiresAt = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    // ── Deduct credit ─────────────────────────────────────────────────────────
    const newCredits = credits - 1;
    await upsertUserMeta(wpUserId, creditKey, String(newCredits));

    const rem20 = chosenMinutes === 20 ? newCredits : (parseInt(userMeta.mock_sessions_remaining_20) || 0);
    const rem30 = chosenMinutes === 30 ? newCredits : (parseInt(userMeta.mock_sessions_remaining_30) || 0);
    await upsertUserMeta(wpUserId, 'mock_sessions_remaining', String(rem20 + rem30));

    // ── Set session lock ──────────────────────────────────────────────────────
    const lockTtl = chosenMinutes * 60 + 5 * 60; // plan duration + 5 min buffer
    await upsertUserMeta(wpUserId, 'mock_session_lock_until', String(nowTs + lockTtl));
    await upsertUserMeta(wpUserId, 'mock_session_lock_id',    sid);

    // ── Call WP mock-session-start to create ACF row with proper field keys ───
    const wpUrl   = process.env.WP_URL   || 'https://agzit.com';
    const wpToken = process.env.WP_APP_TOKEN || '';

    const wpResult = await postJson(
      `${wpUrl}/wp-json/dpr/v1/mock-session-start`,
      {
        sid,
        profile_post_id:      profilePostId,
        session_type:         'voice_video',
        interview_role:       interviewRole,
        target_career_level:  careerLevel,
        context_pack:         contextPack,
        duration_minutes:     chosenMinutes,
        share_token:          shareToken,
        share_expires_at:     shareExpiresAt,
        jd_raw_text:          jdText,
      },
      { 'x-wp-app-token': wpToken }
    ).catch(err => {
      console.error('[interviews/start] WP mock-session-start error:', err.message);
      return { status: 0, body: null };
    });

    if (!wpResult.body?.ok) {
      // Refund credit and clear lock on WP failure
      await upsertUserMeta(wpUserId, creditKey,                   String(credits));
      await upsertUserMeta(wpUserId, 'mock_sessions_remaining',   String(rem20 + rem30 + 1));
      await upsertUserMeta(wpUserId, 'mock_session_lock_until',   '0');
      await upsertUserMeta(wpUserId, 'mock_session_lock_id',      '');
      console.error('[interviews/start] WP returned:', wpResult.status, wpResult.body);
      return res.status(502).json({ ok: false, error: 'Failed to create interview session. Please try again.' });
    }

    res.json({
      ok:               true,
      sid,
      interview_role:   interviewRole,
      duration_minutes: chosenMinutes,
      redirect_url:     `/interview-room?sid=${encodeURIComponent(sid)}`,
    });
  } catch (err) {
    console.error('[candidate/interviews/start]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── PUT /api/candidate/profile ────────────────────────────────────────────────
// Update all editable DPR profile fields + repeaters.
// Body: scalar fields + work_experience[], education[], certifications[] arrays.

// Upsert a single wp_postmeta row (prevents duplicates)
async function upsertPostMeta(postId, key, value) {
  const [rows] = await pool.execute(
    'SELECT meta_id FROM wp_postmeta WHERE post_id = ? AND meta_key = ? LIMIT 1',
    [postId, key]
  );
  if (rows.length > 0) {
    await pool.execute('UPDATE wp_postmeta SET meta_value = ? WHERE meta_id = ?',
      [String(value ?? ''), rows[0].meta_id]);
  } else {
    await pool.execute(
      'INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
      [postId, key, String(value ?? '')]
    );
  }
}

// Delete all postmeta rows for a repeater (count + row fields + ACF key refs)
async function clearRepeaterMeta(postId, prefix) {
  await pool.execute(
    'DELETE FROM wp_postmeta WHERE post_id = ? AND (meta_key = ? OR meta_key LIKE ?)',
    [postId, prefix, `${prefix}_%`]
  );
  await pool.execute(
    'DELETE FROM wp_postmeta WHERE post_id = ? AND (meta_key = ? OR meta_key LIKE ?)',
    [postId, `_${prefix}`, `_${prefix}_%`]
  );
}

// Write an entire repeater (count row + all subfield rows)
async function writeRepeater(postId, prefix, rows) {
  await pool.execute(
    'INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
    [postId, prefix, String(rows.length)]
  );
  for (let i = 0; i < rows.length; i++) {
    for (const [k, v] of Object.entries(rows[i])) {
      await pool.execute(
        'INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
        [postId, `${prefix}_${i}_${k}`, String(v ?? '')]
      );
    }
  }
}

const PROFILE_VISIBILITY_VALUES = {
  profile_visibility: ['public', 'private'],
  contact_visibility: ['co_public', 'co_verified_only', 'co_private'],
  resume_visibility:  ['re_public', 're_verified_only', 're_private'],
  public_name_mode:   ['full', 'first_only', 'initials'],
};

router.put('/profile', ...guard, async (req, res) => {
  try {
    const profileId = await getProfileId(req.user.user_id);

    // ── No DPR profile — update basic account fields only ─────────────────────
    if (!profileId) {
      const b = req.body;
      const s = v => (typeof v === 'string' ? v.trim() : '');
      const wpUserId = req.user.wp_user_id;

      // Update agzit_users name fields
      const agzitUpdates = {};
      if (b.first_name !== undefined) agzitUpdates.first_name = s(b.first_name);
      if (b.last_name  !== undefined) agzitUpdates.last_name  = s(b.last_name);
      if (Object.keys(agzitUpdates).length) {
        const setCols = Object.keys(agzitUpdates).map(k => `${k} = ?`).join(', ');
        await pool.execute(
          `UPDATE agzit_users SET ${setCols} WHERE id = ?`,
          [...Object.values(agzitUpdates), req.user.user_id]
        );
      }

      if (wpUserId) {
        // Update wp_users.display_name
        const firstName = s(b.first_name || '');
        const lastName  = s(b.last_name  || '');
        const displayName = [firstName, lastName].filter(Boolean).join(' ');
        if (displayName) {
          await pool.execute('UPDATE wp_users SET display_name = ? WHERE ID = ?', [displayName, wpUserId]);
        }

        // Upsert wp_usermeta
        const META_KEYS = [
          'first_name', 'last_name',
          'dpr_current_role', 'dpr_department', 'dpr_linkedin_url',
          'dpr_work_email', 'dpr_phone', 'dpr_bio',
        ];
        for (const key of META_KEYS) {
          if (b[key] !== undefined) await upsertUserMeta(wpUserId, key, s(b[key]));
        }
      }

      return res.json({ ok: true });
    }

    const b = req.body;
    const s = v => (typeof v === 'string' ? v.trim() : '');

    // ── Simple scalar fields ───────────────────────────────────────────────────
    const SCALAR_FIELDS = [
      'full_name', 'email_address', 'phone_number', 'linkedin_url',
      'professional_summary_bio', 'total_work_experience',
      'current_employment_status', 'notice_period_in_days',
      'open_to_relocate', 'open_for_work_badge',
      'desired_role', 'soft_skills',
      'residential_address_line_1', 'residential_address_line_2',
      'residential_city', 'residential_state', 'residential_zip_code',
      'country_of_nationality', 'residential_country', 'compliance_domains',
      'current_annual_ctc_with_currency', 'expected_annual_ctc_with_currency',
      'preferred_work_type', 'work_level', 'current_career_level',
    ];
    for (const f of SCALAR_FIELDS) {
      if (b[f] !== undefined) await upsertPostMeta(profileId, f, b[f]);
    }

    // ── Visibility fields (validated) ─────────────────────────────────────────
    for (const [field, allowed] of Object.entries(PROFILE_VISIBILITY_VALUES)) {
      if (b[field] !== undefined) {
        if (!allowed.includes(b[field])) {
          return res.status(400).json({ ok: false, error: `Invalid value for ${field}` });
        }
        await upsertPostMeta(profileId, field, b[field]);
      }
    }

    // ── Work Experience repeater ───────────────────────────────────────────────
    if (Array.isArray(b.work_experience)) {
      const rows = b.work_experience
        .filter(r => s(r.job_title) || s(r.company_name))
        .map(r => ({
          job_title:            s(r.job_title),
          company_name:         s(r.company_name),
          office_country:       s(r.office_country),
          office_city:          s(r.office_city),
          start_date:           s(r.start_date),
          end_date:             s(r.end_date),
          Currently_working:    r.Currently_working ? '1' : '0', // capital C — exact ACF field name
          key_responsibilities: s(r.key_responsibilities),
          key_achievements:     s(r.key_achievements),
        }));
      await clearRepeaterMeta(profileId, 'work_experience');
      await writeRepeater(profileId, 'work_experience', rows);
    }

    // ── Education repeater ────────────────────────────────────────────────────
    if (Array.isArray(b.education)) {
      const rows = b.education
        .filter(r => s(r.degree) || s(r.institution_name))
        .map(r => ({
          degree:           s(r.degree),
          institution_name: s(r.institution_name),
          edu_country:      s(r.edu_country),
          edu_city:         s(r.edu_city),
          edu_start_date:   s(r.edu_start_date),
          edu_end_date:     s(r.edu_end_date),
        }));
      await clearRepeaterMeta(profileId, 'education');
      await writeRepeater(profileId, 'education', rows);
    }

    // ── Certifications repeater ───────────────────────────────────────────────
    if (Array.isArray(b.certifications)) {
      const rows = b.certifications
        .filter(r => s(r.certification_name))
        .map(r => ({
          certification_name:   s(r.certification_name),
          credential_id:        s(r.credential_id),
          issuing_organization: s(r.issuing_organization),
          cert_issue_date:      s(r.cert_issue_date),
          cert_expiry_date:     s(r.cert_expiry_date),
          certificate_pdf:      s(r.certificate_pdf),
        }));
      await clearRepeaterMeta(profileId, 'certifications');
      await writeRepeater(profileId, 'certifications', rows);
    }

    // ── Compliance tools repeater ─────────────────────────────────────────────
    if (Array.isArray(b.compliance_tools)) {
      const rows = b.compliance_tools
        .filter(r => s(r.tool_name))
        .map(r => ({ tool_name: s(r.tool_name) }));
      await clearRepeaterMeta(profileId, 'compliance_tools');
      await writeRepeater(profileId, 'compliance_tools', rows);
    }

    // ── Languages repeater ────────────────────────────────────────────────────
    if (Array.isArray(b.language_proficiency)) {
      const rows = b.language_proficiency
        .filter(r => s(r.language))
        .map(r => ({ language: s(r.language) }));
      await clearRepeaterMeta(profileId, 'language_proficiency');
      await writeRepeater(profileId, 'language_proficiency', rows);
    }

    // ── Resume upload attachment ID (L1: also rename WP attachment title) ─────
    if (b.resume_upload !== undefined) {
      const rawId = String(b.resume_upload || '').trim();
      if (/^\d+$/.test(rawId)) {
        const attachId = parseInt(rawId);
        await upsertPostMeta(profileId, 'resume_upload', rawId);

        // Fetch dpr_id to build the "{DPR_ID}_resume" title
        const [[dprRow]] = await pool.execute(
          "SELECT meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key = 'dpr_id' LIMIT 1",
          [profileId]
        );
        const dprId = dprRow?.meta_value || '';
        if (dprId && attachId) {
          await pool.execute(
            `UPDATE wp_posts SET post_title = ?, post_name = ? WHERE ID = ? AND post_type = 'attachment'`,
            [`${dprId}_resume`, `${dprId.toLowerCase()}_resume`, attachId]
          );
        }
      }
    }

    // ── Sync name to agzit_users + wp_users if full_name changed ──────────────
    if (b.full_name) {
      const parts = String(b.full_name).trim().split(/\s+/);
      const firstName = parts[0] || '';
      const lastName  = parts.slice(1).join(' ') || '';
      await pool.execute(
        'UPDATE agzit_users SET first_name = ?, last_name = ? WHERE id = ?',
        [firstName, lastName, req.user.user_id]
      );
      const wpUserId = req.user.wp_user_id;
      if (wpUserId) {
        await pool.execute(
          'UPDATE wp_users SET display_name = ?, user_nicename = ? WHERE ID = ?',
          [b.full_name.trim(), b.full_name.trim().toLowerCase().replace(/\s+/g, '-'), wpUserId]
        );
        await upsertUserMeta(wpUserId, 'first_name', firstName);
        await upsertUserMeta(wpUserId, 'last_name',  lastName);
      }
    }

    // ── Timestamp ─────────────────────────────────────────────────────────────
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await upsertPostMeta(profileId, 'profile_last_updated', now);

    res.json({ ok: true });
  } catch (err) {
    console.error('[candidate/profile PUT]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/candidate/download ───────────────────────────────────────────────
// Download candidate's own resume or a specific certificate PDF.
// ?type=resume                — redirects to WP attachment URL
// ?type=certificate&row=N    — redirects to certificate_pdf URL (0-based row)
//
// ACF Link field (certificate_pdf) is stored as PHP serialized assoc array
// or a plain URL string. Both cases are handled by extractLinkUrl().

function parsePhpAssocArray(raw) {
  const s = String(raw || '');
  if (!s.startsWith('a:')) return null;
  const pairs = [...s.matchAll(/s:\d+:"([^"]*)";s:\d+:"([^"]*)";/g)];
  const obj = {};
  for (const m of pairs) obj[m[1]] = m[2];
  return obj;
}

function extractLinkUrl(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.startsWith('a:')) {
    const obj = parsePhpAssocArray(s);
    return obj?.url || null;
  }
  // Plain URL
  return s;
}

router.get('/download', ...guard, async (req, res) => {
  try {
    const data = await loadProfile(req.user.user_id);
    if (!data) return res.status(404).json({ ok: false, error: 'Profile not found' });
    const { meta, profileId } = data;

    const { type, row } = req.query;

    // ── Resume ───────────────────────────────────────────────────────────────
    if (type === 'resume') {
      const raw = String(meta.resume_upload || '').trim();
      if (!raw) return res.status(404).json({ ok: false, error: 'No resume uploaded' });

      // resume_upload is an attachment post ID (integer string) or JSON array with ID key
      let attachId = null;
      if (/^\d+$/.test(raw)) {
        attachId = parseInt(raw);
      } else {
        try {
          const parsed = JSON.parse(raw);
          attachId = parsed?.ID ? parseInt(parsed.ID) : null;
        } catch (_) {}
      }

      if (!attachId) return res.status(404).json({ ok: false, error: 'Invalid resume upload reference' });

      const [[post]] = await pool.execute(
        'SELECT guid FROM wp_posts WHERE ID = ? AND post_type = "attachment" LIMIT 1',
        [attachId]
      );
      if (!post?.guid) return res.status(404).json({ ok: false, error: 'Resume file not found' });

      // Fire-and-forget: increment resume_download_count in wp_postmeta
      pool.execute(
        `SELECT meta_id, meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key = 'resume_download_count' LIMIT 1`,
        [profileId]
      ).then(([[row]]) => {
        if (row) {
          return pool.execute('UPDATE wp_postmeta SET meta_value = ? WHERE meta_id = ?',
            [String(parseInt(row.meta_value || '0') + 1), row.meta_id]);
        }
        return pool.execute('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
          [profileId, 'resume_download_count', '1']);
      }).catch(() => {});

      return res.redirect(302, post.guid);
    }

    // ── Certificate ──────────────────────────────────────────────────────────
    if (type === 'certificate') {
      const rowIndex = parseInt(row);
      if (isNaN(rowIndex) || rowIndex < 0) {
        return res.status(400).json({ ok: false, error: 'row parameter required (0-based index)' });
      }

      const certCount = parseInt(meta.certifications) || 0;
      if (rowIndex >= certCount) {
        return res.status(404).json({ ok: false, error: 'Certificate row not found' });
      }

      const raw = meta[`certifications_${rowIndex}_certificate_pdf`];
      const url = extractLinkUrl(raw);
      if (!url) return res.status(404).json({ ok: false, error: 'No certificate file for this row' });

      return res.redirect(302, url);
    }

    res.status(400).json({ ok: false, error: 'type must be resume or certificate' });
  } catch (err) {
    console.error('[candidate/download]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/candidate/vapi-context ──────────────────────────────────────────
// Proxy to daily backend /vapi/context — returns variableValues + session_minutes
// Query params: sid, industry (optional, defaults to compliance)

router.get('/vapi-context', ...guard, async (req, res) => {
  try {
    const sid      = typeof req.query.sid      === 'string' ? req.query.sid.trim().toUpperCase()     : '';
    const industry = typeof req.query.industry === 'string' ? req.query.industry.trim().toLowerCase() : 'compliance';

    if (!sid || !/^MIS-[A-Z0-9]{8}$/.test(sid)) {
      return res.status(400).json({ ok: false, error: 'Valid SID required (format: MIS-XXXXXXXX)' });
    }

    const dailyUrl = (process.env.RENDER_DAILY_URL || 'https://agzit-daily-backend.onrender.com').replace(/\/$/, '');

    const result = await postJson(`${dailyUrl}/vapi/context`, { sid, industry }).catch(err => {
      console.error('[vapi-context] proxy error:', err.message);
      return { status: 502, body: { ok: false, error: 'Interview service unavailable' } };
    });

    res.status(result.status === 200 ? 200 : (result.status || 502)).json(result.body);
  } catch (err) {
    console.error('[candidate/vapi-context]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/candidate/parse-resume ─────────────────────────────────────────
// H1 — AI extracts structured profile data from a PDF resume upload.
// Accepts multipart/form-data with field name "resume" (PDF, max 5 MB).
// Auth: requireAuth only (no role restriction — usable pre-registration too).

router.post('/parse-resume', requireAuth, upload.single('resume'), async (req, res) => {
  try {
    // ── Block parse if DPR already submitted (true one-time limit) ──
    const existingProfile = await getProfileId(req.user.user_id);
    if (existingProfile) {
      return res.status(429).json({ ok: false, error: 'DPR already submitted. Resume parsing is no longer available.' });
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file uploaded. Use field name "resume".' });
    }
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ ok: false, error: 'File must be a PDF.' });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ ok: false, error: 'Resume parsing not available. Please fill the form manually.' });
    }


    const pdfBuffer = req.file.buffer;
    let pdfText = '';
    try {
      const pdfData = await pdfParse(pdfBuffer);
      pdfText = pdfData.text || '';
      console.log(`[parse-resume] pdf-parse extracted ${pdfText.length} chars`);
    } catch (parseErr) {
      console.error('[parse-resume] pdf-parse error:', parseErr.message);
      return res.status(422).json({ ok: false, error: 'Could not read PDF. Please ensure it is a valid, non-corrupted PDF file.' });
    }

    if (pdfText.trim().length < 50) {
      return res.status(422).json({ ok: false, error: 'PDF appears to be empty or image-only. Please upload a text-based PDF.' });
    }

    // Clean: keep only lines where >50% of chars are printable ASCII and line has >3 readable chars
    const cleanText = pdfText
      .split('\n')
      .filter(line => {
        const r = (line.match(/[\x20-\x7E]/g) || []).length;
        return r > line.length * 0.5 && r > 3;
      })
      .join('\n')
      .slice(0, 8000);

    console.log(`[parse-resume] sending to OpenAI, sample: ${cleanText.substring(0, 100)}`);

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not configured');

    const oaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({
        model:       'gpt-4o',
        max_tokens:  4096,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'You are a resume parser. Extract data and return ONLY valid JSON, no markdown, no explanation.',
          },
          {
            role: 'user',
            content: `Extract the following fields from this resume text and return as JSON.

IMPORTANT RULES:
- first_name and last_name: Extract from the candidate's actual name on the resume. It may appear at the top, bottom, or in a header/footer. Do NOT extract from email addresses or LinkedIn URLs.
- phone: CRITICAL — scan the ENTIRE text for phone numbers. They often appear near the name, in headers/footers, or at the top/bottom. Look for patterns like +91-XXXXXXXXXX, (+91) XXXXXXXXXX, or any 10+ digit number with optional country code. Return the digits only (e.g. "9766886605"). If country code found (e.g. +91), put "91" in phone_code.
- city: Extract the candidate's city/location if mentioned near the name or contact details.
- country: Extract or infer the country (e.g. "India" if city is Pune, Mumbai, etc.).
- industry: You MUST map to one of these exact values only: accounting, administration, media, architecture, audit, aviation, banking, civil, compliance, customer_support, cybersecurity, data, engineering, erp_crm, finance, fraud, freshers, government, design, hse, healthcare, hospitality, hr, insurance, it, hardware_it, content, translation, legal, logistics, marine, marketing, mep, mining, oil_gas, operations, other, pharma, procurement, product, manufacturing, qa, r_and_d, retail, risk, sales, security, management, site_engineering, software, network_admin, education, telecom, transport, travel. Pick the closest match. For AML/KYC/Compliance roles use "compliance". For banking/financial services use "banking".
- skills: Array of individual skill strings, max 10.
- education: Array of ALL education entries. Each: degree (string), institution (string), graduation_year (number), field_of_study (string). Include every degree listed.
- work_experience: CRITICAL — first count how many distinct job titles/roles exist in the resume, then include ALL of them. If someone held multiple titles at the same company (e.g. Analyst → Senior Analyst → Associate Manager → Manager), each title is a SEPARATE entry. Include from the most recent down to the very first/oldest role. Do NOT stop early or skip any role. Each entry: job_title, company, start_date (YYYY-MM), end_date (YYYY-MM or null), current (boolean), description (string — copy ALL the responsibility bullet points exactly as written in the resume for that role, do NOT summarize or shorten them).
- certifications: Array of objects with: name, issuing_org, year.

Return this exact JSON structure:
{
  "first_name": "",
  "last_name": "",
  "headline": "",
  "phone": "",
  "phone_code": "",
  "city": "",
  "country": "",
  "linkedin": "",
  "experience_years": 0,
  "industry": "",
  "summary": "",
  "skills": [],
  "education": [],
  "work_experience": [],
  "certifications": [],
  "desired_role": "",
  "current_ctc": "",
  "expected_ctc": ""
}

Resume text:
${cleanText}`,
          },
        ],
      }),
    });
    const oaiData = await oaiRes.json();
    console.log('[parse-resume] OpenAI responded, usage:', oaiData?.usage?.total_tokens);
    if (!oaiRes.ok) {
      console.error('[parse-resume] OpenAI error:', JSON.stringify(oaiData));
      throw new Error('OpenAI API error');
    }
    const rawText = oaiData.choices[0].message.content;

    // Strip markdown code fences if model wrapped JSON
    let jsonText = rawText.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error('[parse-resume] JSON parse failed:', e.message, '| raw:', rawText?.slice(0, 500));
      return res.status(502).json({ ok: false, error: 'AI returned invalid data. Please fill the form manually.' });
    }
    console.log('[parse-resume] parsed result:', JSON.stringify(parsed).substring(0, 500));

    return res.json({ ok: true, data: parsed });
  } catch (err) {
    console.error('[parse-resume] ERROR:', err.message, err.stack?.split('\n')[1]);
    if (err.message?.startsWith('OPENAI_API_KEY')) {
      return res.status(503).json({ ok: false, error: 'Resume parsing not configured.' });
    }
    if (err.name === 'TimeoutError' || err.message?.includes('abort')) {
      return res.status(504).json({ ok: false, error: 'AI parsing took too long. Please try again.' });
    }
    res.status(500).json({ ok: false, error: 'Server error: ' + (err.message || 'unknown') });
  }
});

// ── POST /api/candidate/resume/ai-rewrite ────────────────────────────────────
// H2 — AI rewrites a resume section (summary / experience / skills).
// Body: { section: 'summary'|'experience'|'skills', content, job_title?, target_role? }
// Auth: guard (dpr_candidate)

router.post('/resume/ai-rewrite', ...guard, async (req, res) => {
  try {
    const section    = typeof req.body.section     === 'string' ? req.body.section.trim()     : '';
    const content    = typeof req.body.content     === 'string' ? req.body.content.trim()     : '';
    const jobTitle   = typeof req.body.job_title   === 'string' ? req.body.job_title.trim()   : '';
    const targetRole = typeof req.body.target_role === 'string' ? req.body.target_role.trim() : '';

    if (!['summary', 'experience', 'skills'].includes(section)) {
      return res.status(400).json({ ok: false, error: 'section must be summary, experience, or skills' });
    }
    if (!content) {
      return res.status(400).json({ ok: false, error: 'content is required' });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ ok: false, error: 'AI rewrite not configured.' });
    }

    const userContent = [
      `Section: ${section}`,
      targetRole ? `Target Role: ${targetRole}` : null,
      jobTitle   ? `Current Job Title: ${jobTitle}` : null,
      '',
      'Content to rewrite:',
      content,
    ].filter(l => l !== null).join('\n');

    const rewritten = await callOpenAI(
      'You are a professional resume writer. Rewrite the provided content to be concise, impactful and ATS-optimised for the target role. Return ONLY the rewritten text, no explanation, no preamble.',
      userContent,
      800
    );

    if (!rewritten) {
      return res.status(502).json({ ok: false, error: 'AI returned empty response. Please try again.' });
    }

    return res.json({ ok: true, rewritten });
  } catch (err) {
    console.error('[resume/ai-rewrite]', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/candidate/resume/download ───────────────────────────────────────
// H3 — Protected resume download proxy.
// Query param: dpr_id — whose resume to download.
// Auth: optional — enforces resume_visibility rules:
//   re_public             → anyone can download
//   re_verified_only      → verified_employer + unlocked profile required
//   re_private            → always 403
// Proxies file through Render so the WP attachment URL is never exposed.

router.get('/resume/download', async (req, res) => {
  try {
    const dprId = typeof req.query.dpr_id === 'string' ? req.query.dpr_id.trim().toUpperCase() : '';
    if (!dprId) return res.status(400).json({ ok: false, error: 'dpr_id required' });

    // Find the dpr_profile post
    const [[profileRow]] = await pool.execute(
      `SELECT p.ID, p.post_status
       FROM wp_posts p
       INNER JOIN wp_postmeta pm ON pm.post_id = p.ID AND pm.meta_key = 'dpr_id' AND pm.meta_value = ?
       WHERE p.post_type = 'dpr_profile'
       LIMIT 1`,
      [dprId]
    );
    if (!profileRow || profileRow.post_status !== 'publish') {
      return res.status(404).json({ ok: false, error: 'Profile not found' });
    }
    const profileId = profileRow.ID;

    // Fetch needed meta in one query
    const [metaRows] = await pool.execute(
      `SELECT meta_key, meta_value FROM wp_postmeta
       WHERE post_id = ? AND meta_key IN ('profile_visibility','resume_visibility','resume_upload')`,
      [profileId]
    );
    const meta = {};
    for (const r of metaRows) meta[r.meta_key] = r.meta_value;

    if ((meta.profile_visibility || 'public') === 'private') {
      return res.status(403).json({ ok: false, error: 'Profile is private' });
    }

    const resumeVis = (meta.resume_visibility || 're_verified_only').trim();
    if (resumeVis === 're_private') {
      return res.status(403).json({ ok: false, error: 'Resume is private' });
    }

    // Determine download permission
    let canDownload = (resumeVis === 're_public');

    if (!canDownload) {
      // Need verified_employer + unlocked profile
      try {
        const token = req.cookies?.agzit_token;
        if (token) {
          const decoded = jwt.verify(token, process.env.JWT_SECRET);
          if (decoded.role === 'verified_employer' && decoded.wp_user_id) {
            // Check verification expiry
            const [[vRow]] = await pool.execute(
              "SELECT meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key = 'dpr_verified_until' LIMIT 1",
              [decoded.wp_user_id]
            );
            const verifiedUntil = parseInt(vRow?.meta_value) || 0;
            const nowTs = Math.floor(Date.now() / 1000);
            if (verifiedUntil > 0 && nowTs > verifiedUntil) {
              return res.status(403).json({ ok: false, error: 'Employer verification has expired' });
            }
            // Check unlock
            const [[ulRow]] = await pool.execute(
              "SELECT meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key = 'unlocked_profiles' LIMIT 1",
              [decoded.wp_user_id]
            );
            if (isProfileUnlocked(parseUnlockedMap(ulRow?.meta_value), dprId)) {
              canDownload = true;
            }
          }
        }
      } catch (_) { /* invalid/expired JWT — treat as public visitor */ }

      if (!canDownload) {
        return res.status(403).json({ ok: false, error: 'Access denied. Verified employer unlock required.' });
      }
    }

    // Resolve attachment ID from resume_upload (stored as integer or JSON array)
    const rawUpload = String(meta.resume_upload || '').trim();
    if (!rawUpload) return res.status(404).json({ ok: false, error: 'No resume uploaded' });

    let attachId = null;
    if (/^\d+$/.test(rawUpload)) {
      attachId = parseInt(rawUpload);
    } else {
      try {
        const parsed = JSON.parse(rawUpload);
        attachId = parsed?.ID ? parseInt(parsed.ID) : null;
      } catch (_) {}
    }
    if (!attachId) return res.status(404).json({ ok: false, error: 'Invalid resume reference' });

    // Fetch WP attachment URL
    const [[attachPost]] = await pool.execute(
      'SELECT guid FROM wp_posts WHERE ID = ? AND post_type = "attachment" LIMIT 1',
      [attachId]
    );
    if (!attachPost?.guid) return res.status(404).json({ ok: false, error: 'Resume file not found' });

    // Proxy the file through Render so the WP attachment URL is never exposed to the browser
    const fileRes = await fetch(attachPost.guid);
    if (!fileRes.ok) {
      console.error('[resume/download] upstream fetch failed:', fileRes.status, attachPost.guid);
      return res.status(502).json({ ok: false, error: 'Could not retrieve resume file' });
    }

    const buffer = Buffer.from(await fileRes.arrayBuffer());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${dprId}_resume.pdf"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', buffer.length);
    return res.send(buffer);

  } catch (err) {
    console.error('[resume/download]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/candidate/dpr ───────────────────────────────────────────────────
// Creates the candidate's DPR profile for the first time.
// Auth: requireAuth only (no role restriction — called during onboarding).
// Body: { personal, career[], education[], certifications[], skills }

router.post('/dpr', requireAuth, async (req, res) => {
  try {
    // 1. Guard: reject if profile already exists
    const existing = await getProfileId(req.user.user_id);
    if (existing) {
      return res.status(409).json({ ok: false, error: 'DPR profile already exists.' });
    }

    const { personal = {}, career = [], education = [], certifications = [], skills = {}, job_preferences = {}, privacy = {} } = req.body;
    const s = v => String(v ?? '').trim();

    if (!s(personal.first_name) || !s(personal.last_name)) {
      return res.status(400).json({ ok: false, error: 'First name and last name are required.' });
    }

    const wpUserId = req.user.wp_user_id;
    const email    = req.user.email || '';
    const fullName = `${s(personal.first_name)} ${s(personal.last_name)}`;
    const now      = new Date();
    const nowStr   = now.toISOString().replace('T', ' ').slice(0, 19);

    // 2. Get user email from DB (fallback if not in JWT)
    let userEmail = email;
    if (!userEmail) {
      const [[uRow]] = await pool.execute('SELECT email FROM agzit_users WHERE id = ? LIMIT 1', [req.user.user_id]);
      userEmail = uRow?.email || '';
    }

    // 3. Create wp_posts row (draft)
    const [postResult] = await pool.execute(
      `INSERT INTO wp_posts
         (post_author, post_date, post_date_gmt, post_content, post_title, post_excerpt,
          post_status, comment_status, ping_status, post_password, post_name,
          to_ping, pinged, post_modified, post_modified_gmt, post_content_filtered,
          post_parent, guid, menu_order, post_type, post_mime_type, comment_count)
       VALUES (?, ?, ?, '', ?, '', 'draft', 'closed', 'closed', '', '',
               '', '', ?, ?, '', 0, '', 0, 'dpr_profile', '', 0)`,
      [wpUserId || 1, nowStr, nowStr, fullName, nowStr, nowStr]
    );
    const postId = postResult.insertId;

    // 4. Set guid (WP convention: set after insert to include post ID)
    await pool.execute(
      'UPDATE wp_posts SET guid = ? WHERE ID = ?',
      [`https://agzit.com/?post_type=dpr_profile&p=${postId}`, postId]
    );

    // 5. Generate DPR ID
    const dateYmd  = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const country2 = (s(personal.nationality).slice(0, 2).toUpperCase()) || 'NA';
    const hash6    = crypto.createHash('sha256')
      .update(`DPR|${dateYmd}|${country2}|${postId}`)
      .digest('hex').slice(0, 6).toUpperCase();
    const dprId = `DPR-${dateYmd}-${country2}-${postId}-${hash6}`;

    // 6. Write scalar postmeta
    const fieldsForCompleteness = [
      personal.first_name || personal.last_name,
      userEmail,
      personal.phone,
      personal.residential_city || personal.city,
      personal.residential_country || personal.country,
      personal.headline,
      personal.experience,
      personal.industry,
      skills.summary,
      skills.linkedin,
      skills.achievements,
      personal.residential_address_line_1 || personal.current_address,
    ];
    const filledCount = fieldsForCompleteness.filter(v => v && String(v).trim() !== '').length;
    const profileCompleteness = String(Math.max(20, Math.round((filledCount / 12) * 100)));

    const scalarMeta = [
      ['full_name',                          fullName],
      ['email_address',                      userEmail],
      ['phone_number',                       s(personal.phone)],
      ['residential_city',                   s(personal.residential_city) || s(personal.city)],
      ['residential_country',                s(personal.residential_country) || s(personal.country)],
      ['residential_address_line_1',         s(personal.residential_address_line_1) || s(personal.current_address)],
      ['residential_address_line_2',         s(personal.residential_address_line_2)],
      ['residential_state',                  s(personal.residential_state)],
      ['residential_zip_code',               s(personal.residential_zip_code)],
      ['gender',                             s(personal.gender)],
      ['date_of_birth',                      s(personal.dob)],
      ['country_of_nationality',             s(personal.nationality)],
      ['professional_headline',              s(personal.headline)],
      ['professional_summary_bio',           s(skills.summary)],
      ['total_work_experience',              String(parseInt(personal.experience) || 0)],
      ['compliance_domains',                 JSON.stringify([s(personal.industry)].filter(Boolean))],
      ['current_employment_status',          s(job_preferences.employment_status)],
      ['notice_period_in_days',              s(job_preferences.notice_period)],
      ['current_annual_ctc_with_currency',   s(job_preferences.current_ctc)],
      ['expected_annual_ctc_with_currency',  s(job_preferences.expected_ctc)],
      ['desired_role',                       s(job_preferences.desired_role)],
      ['key_achievements',                   s(skills.achievements)],
      ['soft_skills',                        s(skills.skills_list)],
      ['linkedin_url',                       s(skills.linkedin)],
      ['portfolio_url',                      s(skills.portfolio)],
      ['dpr_id',                             dprId],
      ['dpr_status',                         'approved'],
      ['profile_visibility',                 s(privacy.profile_visibility) || 'public'],
      ['email_visibility',                   s(privacy.email_visibility)   || 'co_public'],
      ['phone_visibility',                   s(privacy.phone_visibility)   || 'co_verified_only'],
      ['resume_visibility',                  s(privacy.resume_visibility)  || 're_verified_only'],
      ['public_name_mode',                   'initials'],
      ['open_for_work_badge',                job_preferences.open_for_work_badge ? '1' : '0'],
      ['open_to_relocate',                   job_preferences.open_to_relocate ? '1' : '0'],
      ['work_level',                         s(job_preferences.work_level)],
      ['preferred_work_type',                s(job_preferences.preferred_work_type)],
      ['profile_completeness',               profileCompleteness],
      ['profile_last_updated',               nowStr],
      ['has_resume',                         '1'],
    ];
    for (const [key, value] of scalarMeta) {
      await pool.execute(
        'INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
        [postId, key, String(value ?? '')]
      );
    }

    // 7. Write work_experience repeater
    const padM = m => String(m || '').padStart(2, '0');
    const careerRows = (Array.isArray(career) ? career : [])
      .filter(c => s(c.title) || s(c.company))
      .map(c => ({
        job_title:            s(c.title),
        company_name:         s(c.company),
        office_country:       '',
        office_city:          '',
        start_date:           (c.start_year && c.start_month) ? `${c.start_year}-${padM(c.start_month)}-01` : '',
        end_date:             c.currently_working ? '' : ((c.end_year && c.end_month) ? `${c.end_year}-${padM(c.end_month)}-01` : ''),
        Currently_working:    c.currently_working ? '1' : '0',
        key_responsibilities: s(c.responsibilities),
        key_achievements:     '',
      }));
    await pool.execute('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
      [postId, 'work_experience', String(careerRows.length)]);
    for (let i = 0; i < careerRows.length; i++) {
      for (const [k, v] of Object.entries(careerRows[i])) {
        await pool.execute('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
          [postId, `work_experience_${i}_${k}`, String(v ?? '')]);
      }
    }

    // 8. Write education repeater
    const eduRows = (Array.isArray(education) ? education : [])
      .filter(e => s(e.institution) || s(e.degree))
      .map(e => ({
        degree:           s(e.degree),
        institution_name: s(e.institution),
        edu_country:      s(e.country),
        edu_city:         s(e.city),
        edu_start_date:   e.start_year ? `${e.start_year}-01-01` : '',
        edu_end_date:     e.end_year   ? `${e.end_year}-06-01`   : '',
      }));
    await pool.execute('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
      [postId, 'education', String(eduRows.length)]);
    for (let i = 0; i < eduRows.length; i++) {
      for (const [k, v] of Object.entries(eduRows[i])) {
        await pool.execute('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
          [postId, `education_${i}_${k}`, String(v ?? '')]);
      }
    }

    // 9. Write certifications repeater
    const certRows = (Array.isArray(certifications) ? certifications : [])
      .filter(c => s(c.name))
      .map(c => ({
        certification_name:   s(c.name),
        issuing_organization: s(c.issuer),
        credential_id:        s(c.credential_id),
        cert_issue_date:      (c.issue_year && c.issue_month) ? `${c.issue_year}-${padM(c.issue_month)}-01` : '',
        cert_expiry_date:     c.no_expiry ? '' : ((c.expiry_year && c.expiry_month) ? `${c.expiry_year}-${padM(c.expiry_month)}-01` : ''),
        certificate_pdf:      '',
      }));
    await pool.execute('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
      [postId, 'certifications', String(certRows.length)]);
    for (let i = 0; i < certRows.length; i++) {
      for (const [k, v] of Object.entries(certRows[i])) {
        await pool.execute('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
          [postId, `certifications_${i}_${k}`, String(v ?? '')]);
      }
    }

    // 9b. Write preferred_location repeater
    const prefLocRows = (Array.isArray(job_preferences.preferred_location) ? job_preferences.preferred_location : [])
      .filter(p => s(p.preferred_city_name) || s(p.preferred_country_name))
      .map(p => ({
        preferred_city_name:    s(p.preferred_city_name),
        preferred_country_name: s(p.preferred_country_name),
      }));
    await pool.execute('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
      [postId, 'preferred_location', String(prefLocRows.length)]);
    for (let i = 0; i < prefLocRows.length; i++) {
      for (const [k, v] of Object.entries(prefLocRows[i])) {
        await pool.execute('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
          [postId, `preferred_location_${i}_${k}`, String(v ?? '')]);
      }
    }

    // 10. Publish post
    await pool.execute(
      `UPDATE wp_posts SET post_status = 'publish', post_modified = ?, post_modified_gmt = ? WHERE ID = ?`,
      [nowStr, nowStr, postId]
    );

    // 11. Upsert dpr_profile_post_id in wp_usermeta + update agzit_users
    if (wpUserId) await upsertUserMeta(wpUserId, 'dpr_profile_post_id', String(postId));
    await pool.execute(
      'UPDATE agzit_users SET dpr_profile_id = ?, first_name = ?, last_name = ? WHERE id = ?',
      [postId, s(personal.first_name), s(personal.last_name), req.user.user_id]
    );

    // 12. Update wp_users first_name, last_name, display_name
    if (wpUserId) {
      await pool.execute(
        'UPDATE wp_users SET display_name = ?, user_nicename = ? WHERE ID = ?',
        [fullName, fullName.toLowerCase().replace(/\s+/g, '-'), wpUserId]
      );
      await upsertUserMeta(wpUserId, 'first_name', s(personal.first_name));
      await upsertUserMeta(wpUserId, 'last_name',  s(personal.last_name));
    }

    console.log(`[dpr] Created ${dprId} (post ${postId}) for user ${req.user.user_id}`);
    return res.json({ ok: true, dpr_id: dprId, post_id: postId, redirectTo: '/dashboard' });

  } catch (err) {
    console.error('[dpr/create]', err.message);
    res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
  }
});

// ── POST /api/candidate/resume ────────────────────────────────────────────────
// Upload or replace resume from the dashboard. Stores in agzit_resume_files.
// Auth: requireAuth + must have a DPR profile

const RESUME_ALLOWED_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

router.post('/resume', requireAuth, upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });

    if (!RESUME_ALLOWED_TYPES.includes(req.file.mimetype)) {
      return res.status(400).json({ ok: false, error: 'Only PDF and Word documents are accepted.' });
    }

    const profileId = await getProfileId(req.user.user_id);
    if (!profileId) return res.status(404).json({ ok: false, error: 'Profile not found. Complete DPR registration first.' });

    const filename = req.file.originalname || 'resume.pdf';
    const mimetype = req.file.mimetype;
    const filedata = req.file.buffer;
    const nowStr   = new Date().toISOString().replace('T', ' ').slice(0, 19);

    await pool.execute(
      `INSERT INTO agzit_resume_files (post_id, user_id, filename, mimetype, filedata, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE filename=VALUES(filename), mimetype=VALUES(mimetype),
         filedata=VALUES(filedata), uploaded_at=VALUES(uploaded_at)`,
      [profileId, req.user.user_id, filename, mimetype, filedata, nowStr]
    );
    await upsertPostMeta(profileId, 'has_resume',        '1');
    await upsertPostMeta(profileId, 'resume_upload',      String(profileId));
    await upsertPostMeta(profileId, 'resume_filename',    filename);
    await upsertPostMeta(profileId, 'resume_uploaded_at', nowStr);

    console.log(`[resume] Saved ${filename} for profile ${profileId}, ${req.file.size} bytes`);
    return res.json({ ok: true, filename, path: '/api/candidate/download?type=resume' });
  } catch (err) {
    console.error('[resume]', err);
    res.status(500).json({ ok: false, error: err.message || 'Server error.' });
  }
});

// ── POST /api/candidate/dpr/:postId/resume ─────────────────────────────────
// Uploads a resume PDF after DPR creation. Stores file in agzit_resume_files.
// Auth: requireAuth

router.post('/dpr/:postId/resume', requireAuth, upload.single('resume'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded.' });

    const postId = parseInt(req.params.postId);
    if (!postId) return res.status(400).json({ ok: false, error: 'Invalid post ID.' });

    // Verify this post belongs to the authenticated user
    const profileId = await getProfileId(req.user.user_id);
    if (profileId !== postId) return res.status(403).json({ ok: false, error: 'Access denied.' });

    const filename  = req.file.originalname || 'resume.pdf';
    const mimetype  = req.file.mimetype     || 'application/pdf';
    const filedata  = req.file.buffer;
    const nowStr    = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // UPSERT into agzit_resume_files (unique key on post_id)
    await pool.execute(
      `INSERT INTO agzit_resume_files (post_id, user_id, filename, mimetype, filedata, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE filename=VALUES(filename), mimetype=VALUES(mimetype),
         filedata=VALUES(filedata), uploaded_at=VALUES(uploaded_at)`,
      [postId, req.user.user_id, filename, mimetype, filedata, nowStr]
    );

    await upsertPostMeta(postId, 'has_resume',         '1');
    await upsertPostMeta(postId, 'resume_upload',       String(postId));
    await upsertPostMeta(postId, 'resume_filename',     filename);
    await upsertPostMeta(postId, 'resume_uploaded_at',  nowStr);

    console.log(`[dpr/resume] Saved resume for post ${postId}, ${req.file.size} bytes`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[dpr/resume]', err);
    res.status(500).json({ ok: false, error: err.message || 'Server error.' });
  }
});

module.exports = router;
