// routes/candidate.js — Candidate API routes
// All routes require: JWT auth + dpr_candidate role
// Field names sourced directly from WordPress ACF snippet files.

const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const crypto  = require('crypto');
const https   = require('https');
const jwt     = require('jsonwebtoken');
const multer  = require('multer');
const pdfParse = require('pdf-parse');

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
    if (!profileId) return res.status(404).json({ ok: false, error: 'Profile not found' });

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
      'preferred_work_type', 'work_level',
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
          employment_type:      s(r.employment_type),
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
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'No file uploaded. Use field name "resume".' });
    }
    if (req.file.mimetype !== 'application/pdf') {
      return res.status(400).json({ ok: false, error: 'File must be a PDF.' });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(503).json({ ok: false, error: 'Resume parsing not available. Please fill the form manually.' });
    }

    // Extract raw text from PDF buffer, then send to OpenAI
    let pdfText;
    try {
      const parsed = await pdfParse(req.file.buffer);
      pdfText = parsed.text?.trim() || '';
    } catch (e) {
      console.error('[parse-resume] pdf-parse error:', e.message);
      return res.status(422).json({ ok: false, error: 'Could not read PDF. Please ensure the file is not password-protected.' });
    }
    if (!pdfText) {
      return res.status(422).json({ ok: false, error: 'PDF appears to be empty or image-only. Please upload a text-based PDF.' });
    }

    const schema = `{
  "full_name": "string",
  "email": "string",
  "phone": "string",
  "location": "string (city, country)",
  "current_job_title": "string",
  "total_experience_years": "number",
  "summary": "string (professional bio)",
  "skills": ["array of skill strings"],
  "work_experience": [
    {
      "company": "string",
      "title": "string",
      "start_date": "string (YYYY-MM or Month YYYY)",
      "end_date": "string or null",
      "currently_working": "boolean",
      "description": "string (key responsibilities)"
    }
  ],
  "education": [
    {
      "institution": "string",
      "degree": "string",
      "field": "string",
      "start_year": "number or null",
      "end_year": "number or null"
    }
  ],
  "certifications": [
    {
      "name": "string",
      "issuer": "string or null",
      "year": "number or null"
    }
  ]
}`;

    const systemPrompt = 'Extract structured profile data from the resume text below. Return ONLY valid JSON matching the schema. No markdown fences, no explanation, no trailing commas.';
    const userContent  = `Schema:\n${schema}\n\nResume text:\n${pdfText.slice(0, 40000)}`;

    const rawText = await callOpenAI(systemPrompt, userContent, 2048);

    // Strip markdown code fences if model wrapped JSON
    let jsonText = rawText.trim();
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (e) {
      console.error('[parse-resume] JSON parse failed:', e.message, rawText.slice(0, 300));
      return res.status(502).json({ ok: false, error: 'AI returned invalid data. Please fill the form manually.' });
    }

    return res.json({ ok: true, data: parsed });
  } catch (err) {
    console.error('[parse-resume]', err.message);
    if (err.message?.startsWith('OPENAI_API_KEY')) {
      return res.status(503).json({ ok: false, error: 'Resume parsing not configured.' });
    }
    res.status(500).json({ ok: false, error: 'Server error' });
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

module.exports = router;
