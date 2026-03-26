// routes/candidate.js — Candidate API routes
// All routes require: JWT auth + dpr_candidate role
// Field names sourced directly from WordPress ACF snippet files.

const express      = require('express');
const router       = express.Router();
const pool         = require('../config/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const bcrypt       = require('bcryptjs');
const crypto       = require('crypto');
const https        = require('https');
const jwt          = require('jsonwebtoken');
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');
const pdfParse     = require('pdf-parse');
const sanitizeHtml = require('sanitize-html');
const cloudinary    = require('cloudinary').v2;
// ── Cloudinary setup ─────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a buffer to Cloudinary (raw resource type for PDFs/docs).
 * Returns the secure_url on success.
 */
function uploadToCloudinary(buffer, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'raw', folder: 'agzit-resumes', public_id: publicId, overwrite: true },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

// Strip HTML tags from freeform text to prevent stored XSS.
// Applied to textarea fields; short-text fields use trim-only s() helper.
function sanitize(v) {
  if (typeof v !== 'string') return '';
  return sanitizeHtml(v.trim(), { allowedTags: [], allowedAttributes: {} });
}

// multer: in-memory storage, 5 MB limit, PDF only
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 },
});

// multer: disk storage for profile photos, 2 MB limit, images only
const photoDir = path.join(__dirname, '..', 'public', 'uploads', 'profile-photos');
if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, photoDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
      cb(null, `${req.user.id}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG, PNG, WebP and GIF images are allowed'));
  },
});

// Normalize req.user.id — JWT stores user_id, some routes reference req.user.id
const normalizeUserId = (req, res, next) => {
  if (req.user && !req.user.id) req.user.id = req.user.user_id;
  next();
};
const guard = [requireAuth, requireRole('dpr_candidate'), normalizeUserId];

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
    'SELECT dpr_profile_id, wp_user_id, email FROM agzit_users WHERE id = ?',
    [userId]
  );
  if (!user) return null;

  // Method 1: cached dpr_profile_id (fast path)
  if (user.dpr_profile_id) return user.dpr_profile_id;

  // Method 2: find by post_author = wp_user_id
  let postId = null;
  if (user.wp_user_id) {
    const [[row]] = await pool.execute(
      "SELECT ID FROM wp_posts WHERE post_author = ? AND post_type = 'dpr_profile' AND post_status IN ('publish','draft') ORDER BY ID DESC LIMIT 1",
      [user.wp_user_id]
    );
    if (row) postId = row.ID;
  }

  // Method 3: find by email_address in wp_postmeta
  if (!postId && user.email) {
    const [[row]] = await pool.execute(
      `SELECT p.ID FROM wp_posts p
       JOIN wp_postmeta pm ON pm.post_id = p.ID AND pm.meta_key = 'email_address'
       WHERE p.post_type = 'dpr_profile' AND p.post_status IN ('publish','draft')
         AND pm.meta_value = ?
       ORDER BY p.ID DESC LIMIT 1`,
      [user.email]
    );
    if (row) postId = row.ID;
  }

  // Method 4: find by wp_users with same email → post_author
  if (!postId && user.email) {
    const [[wpUser]] = await pool.execute(
      'SELECT ID FROM wp_users WHERE user_email = ? LIMIT 1',
      [user.email]
    );
    if (wpUser) {
      const [[row]] = await pool.execute(
        "SELECT ID FROM wp_posts WHERE post_author = ? AND post_type = 'dpr_profile' AND post_status IN ('publish','draft') ORDER BY ID DESC LIMIT 1",
        [wpUser.ID]
      );
      if (row) postId = row.ID;
    }
  }

  // Auto-heal: cache the found profile ID in agzit_users
  if (postId) {
    console.log(`[getProfileId] Auto-healed user ${userId}: dpr_profile_id = ${postId}`);
    await pool.execute(
      'UPDATE agzit_users SET dpr_profile_id = ? WHERE id = ? AND (dpr_profile_id IS NULL OR dpr_profile_id = 0)',
      [postId, userId]
    ).catch(err => console.error('[getProfileId] Auto-heal failed:', err.message));
  }

  return postId || null;
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

    // Fetch sub-industries from wp_usermeta
    let candidateSubIndustries = [];
    if (user.wp_user_id) {
      const [[subRow]] = await pool.execute(
        "SELECT meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key = 'candidate_sub_industries' LIMIT 1",
        [user.wp_user_id]
      );
      if (subRow?.meta_value) {
        try { candidateSubIndustries = JSON.parse(subRow.meta_value); } catch (_) {}
      }
    }

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

    // Unified credit balance
    const [[creditRow]] = await pool.execute(
      'SELECT credit_balance FROM agzit_candidate_credits WHERE user_id = ?',
      [user.id]
    );
    const creditBalance = creditRow ? creditRow.credit_balance : 0;

    res.json({
      ok: true,
      user: {
        id:         user.id,
        email:      user.email,
        first_name: user.first_name,
        last_name:  user.last_name,
        created_at: user.created_at,
      },
      credit_balance: creditBalance,
      profile: meta ? {
        dpr_id:               meta.dpr_id,
        full_name:            meta.full_name,
        dpr_status:           meta.dpr_status,
        profile_completeness: meta.profile_completeness,
        dpr_id_view_count:    meta.dpr_id_view_count,
        open_for_work_badge:  meta.open_for_work_badge,
        compliance_domains:   meta.compliance_domains,  // raw value — frontend parseIndustry() handles display
        current_career_level: meta.current_career_level,
        profile_visibility:   meta.profile_visibility,
        email_visibility:     meta.email_visibility,
        phone_visibility:     meta.phone_visibility,
        resume_visibility:    meta.resume_visibility,
        current_address:      meta.residential_address_line_1,
        key_achievements:     meta.key_achievements,
        total_work_experience: meta.total_work_experience,
        desired_role:          meta.desired_role,
        professional_headline: meta.professional_headline,
        resume_upload:         meta.resume_upload,
        has_resume:            meta.has_resume,
        candidate_sub_industries: candidateSubIndustries,
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

// Calculate verified badges based on employer_interview posts with tier system
const calculateVerifiedBadges = async (userId) => {
  try {
    // Get candidate email
    const [candidate] = await pool.execute(
      'SELECT email FROM agzit_users WHERE id = ?',
      [userId]
    );

    if (!candidate || !candidate[0] || !candidate[0].email) {
      return [];
    }

    const candidateEmail = candidate[0].email;

    // Find all employer_interview posts
    const [interviews] = await pool.execute(`
      SELECT p.ID as interview_id, p.post_date
      FROM wp_posts p
      JOIN wp_postmeta pm ON p.ID = pm.post_id
      WHERE p.post_type = 'employer_interview'
        AND pm.meta_key = 'candidate_email'
        AND pm.meta_value = ?
        AND p.post_status = 'publish'
      GROUP BY p.ID
      ORDER BY p.post_date DESC
      LIMIT 50
    `, [candidateEmail]);

    // Need at least 3 interviews for any badge
    if (!interviews || interviews.length < 3) {
      return [];
    }

    const badges = [];

    // Competency to meta_key mapping
    const competencyMap = {
      'score_communication': 'Communication Clarity',
      'score_answer_structure': 'Answer Structure',
      'score_role_knowledge': 'Role Knowledge',
      'score_domain_application': 'Domain Application',
      'score_problem_solving': 'Problem Solving',
      'score_confidence_presence': 'Confidence & Presence',
      'score_question_handling': 'Question Handling',
      'score_experience_relevance': 'Experience Relevance',
      'score_resume_alignment': 'Resume Alignment',
      'score_depth_specificity': 'Depth & Specificity'
    };

    // Calculate competency badges with TIER SYSTEM
    for (const [metaKey, competencyName] of Object.entries(competencyMap)) {
      const [scores] = await pool.execute(`
        SELECT CAST(pm.meta_value AS DECIMAL(5,2)) as score
        FROM wp_posts p
        JOIN wp_postmeta pm_email ON p.ID = pm_email.post_id
        JOIN wp_postmeta pm ON p.ID = pm.post_id
        WHERE p.post_type = 'employer_interview'
          AND pm_email.meta_key = 'candidate_email'
          AND pm_email.meta_value = ?
          AND pm.meta_key = ?
          AND p.post_status = 'publish'
        ORDER BY p.post_date DESC
        LIMIT 50
      `, [candidateEmail, metaKey]);

      if (scores && scores.length >= 3) {
        const avgScore = scores.reduce((sum, row) => sum + (parseFloat(row.score) || 0), 0) / scores.length;

        // Tier system: 0-60 no badge, 61-75 silver, 76-85 gold, 86-100 platinum
        let tier = null;
        let tierIcon = '';
        let tierName = '';

        if (avgScore >= 86) {
          tier = 'platinum';
          tierIcon = '💎';
          tierName = 'Platinum Member';
        } else if (avgScore >= 76) {
          tier = 'gold';
          tierIcon = '🥇';
          tierName = 'Gold Member';
        } else if (avgScore >= 61) {
          tier = 'silver';
          tierIcon = '🥈';
          tierName = 'Silver Member';
        }
        // avgScore < 61 = no badge (tier = null)

        // Only add badge if tier exists (score >= 61)
        if (tier) {
          badges.push({
            name: `${tierIcon} ${tierName}`,
            competency: competencyName,
            score: Math.round(avgScore * 10) / 10,
            tier: tier,
            type: 'competency',
            nextTier: tier === 'silver' ? 'Gold (76+)' : tier === 'gold' ? 'Platinum (86+)' : 'Expert Level'
          });
        }
      }
    }

    // Also add overall Experience Verified badge (always shown if 3+ interviews)
    badges.push({
      name: '✓ Latest Experience Verified via AI Interview',
      competency: 'experience_verified',
      score: null,
      tier: null,
      type: 'experience_verified',
      interviewCount: interviews.length
    });

    return badges;

  } catch (error) {
    console.error('Badge calculation error:', error);
    return [];
  }
};

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
      'degree', 'institution_name',
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
    certifications.forEach(c => { c.certificate_url = extractLinkUrl(c.certificate_pdf) || null; });
    const rawTools        = parseRepeater(meta, 'compliance_tools', ['tool_name', 'name']);
    const complianceTools = rawTools
      .map(r => ({ tool_name: r.tool_name || r.name || '' }))
      .filter(r => r.tool_name);
    const rawLangs = parseRepeater(meta, 'language_proficiency', ['language', 'proficiency']);
    const languageProficiency = rawLangs.map(r => ({
      language_name: r.language || '',
      proficiency:   r.proficiency || '',
    })).filter(r => r.language_name);

    const prefLocations = parseRepeater(meta, 'preferred_location', [
      'preferred_city_name', 'preferred_country_name',
    ]);

    // Check agzit_resume_files for actual resume existence (fixes stale meta)
    let resumeRow = null;
    try {
      const [[row]] = await pool.execute(
        'SELECT filename FROM agzit_resume_files WHERE profile_post_id = ? LIMIT 1', [profileId]
      );
      resumeRow = row || null;
    } catch (_) { /* table may not exist yet */ }
    const hasResumeActual = !!(resumeRow || meta.has_resume === '1' || meta.resume_upload);
    // Auto-heal: if resume exists in DB but meta missing, set it now
    if (resumeRow && meta.has_resume !== '1') {
      upsertPostMeta(profileId, 'has_resume', '1').catch(() => {});
      upsertPostMeta(profileId, 'resume_upload', String(profileId)).catch(() => {});
    }

    const badges = await calculateVerifiedBadges(req.user.user_id);

    // Fetch sub-industries from wp_usermeta
    let candidateSubIndustries = [];
    if (req.user.wp_user_id) {
      const [[subRow]] = await pool.execute(
        "SELECT meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key = 'candidate_sub_industries' LIMIT 1",
        [req.user.wp_user_id]
      );
      if (subRow?.meta_value) {
        try { candidateSubIndustries = JSON.parse(subRow.meta_value); } catch (_) {}
      }
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
        profile_photo_url:                meta.profile_photo_url,
        issue_date:                       meta.issue_date,
        dpr_id_view_count:                meta.dpr_id_view_count,

        // ── Fresher / project fields
        is_fresher:                       meta.is_fresher,
        project_title:                    meta.project_title,
        project_date:                     meta.project_date,
        project_summary:                  meta.project_summary,

        // ── Professional summary
        professional_summary_bio:         meta.professional_summary_bio,
        total_work_experience:            meta.total_work_experience,
        compliance_domains:               meta.compliance_domains,  // raw; parseIndustry() handles display client-side
        current_employment_status:        meta.current_employment_status,
        notice_period_in_days:            meta.notice_period_in_days,
        current_annual_ctc_with_currency: meta.current_annual_ctc_with_currency,
        open_to_relocate:                 meta.open_to_relocate,
        open_for_work_badge:              meta.open_for_work_badge,
        // ── Skills & expertise
        soft_skills:                      meta.soft_skills,          // ACF label: "Skills"
        compliance_tools:                 complianceTools,            // ACF label: "Tools & Software"
        language_proficiency:             languageProficiency,

        // ── Job preferences
        desired_role:                     meta.desired_role,
        work_level:                       meta.work_level,
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
        preferred_location:               prefLocations,

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
        candidate_sub_industries:         candidateSubIndustries,
        badges,
      },
    });
  } catch (err) {
    console.error('[candidate/profile]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/candidate/career-analyzer ──────────────────────────────────────
// Generate AI career analysis with dynamic salary research (costs 1 credit)

router.post('/career-analyzer', ...guard, async (req, res) => {
  try {
    const userId = req.user.user_id || req.user.id;

    // Check credits
    const [[credits]] = await pool.execute(
      'SELECT credit_balance FROM agzit_candidate_credits WHERE user_id = ?',
      [userId]
    );

    if (!credits || credits.credit_balance < 1) {
      return res.status(402).json({
        error: 'Insufficient credits',
        message: 'Get 1 free credit by referring a friend!'
      });
    }

    // Load DPR data
    const data = await loadProfile(userId);
    if (!data) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    const { meta } = data;

    // Parse repeaters
    const workExperience = parseRepeater(meta, 'work_experience', [
      'job_title', 'company_name', 'start_date', 'end_date', 'Currently_working',
    ]);
    const education = parseRepeater(meta, 'education', [
      'degree', 'institution_name',
    ]);
    const prefLocations = parseRepeater(meta, 'preferred_location', [
      'preferred_city_name', 'preferred_country_name',
    ]);

    // Get badges
    const badges = await calculateVerifiedBadges(userId);
    const scored = badges.filter(b => b.score);
    const avgScore = scored.length > 0
      ? Math.round(scored.reduce((sum, b) => sum + b.score, 0) / scored.length)
      : null;

    // Extract location and industry
    const city = meta.residential_city || (prefLocations[0] && prefLocations[0].preferred_city_name) || 'Not specified';
    const country = meta.residential_country || meta.country_of_nationality || 'IN';
    const industry = meta.compliance_domains || 'Not specified';
    const expYears = parseInt(meta.total_work_experience) || 0;

    // Build comprehensive OpenAI prompt with dynamic salary research
    const systemPrompt = `You are an expert global career strategist with deep knowledge of:
- Salary markets across 50+ countries
- Industry trends and job market dynamics
- Realistic career progression paths
- Cost of living and purchasing power in different locations

Provide REALISTIC, DATA-DRIVEN career advice using actual 2024-2025 market data.
Return ONLY valid JSON. No preamble or explanation.`;

    const userPrompt = `Analyze this candidate's career profile and suggest 3 strategic next roles with location-specific salary insights.

CANDIDATE PROFILE:
Name: ${meta.full_name || 'Not specified'}
Current Location: ${city}, ${country}
Current Role: ${meta.desired_role || 'Not specified'}
Industry: ${industry}
Experience: ${expYears} years
Current Salary: ${meta.current_annual_ctc_with_currency || 'Not specified'}
Expected Salary: ${meta.expected_annual_ctc_with_currency || 'Not specified'}
Skills: ${meta.soft_skills || 'Not specified'}
Work Level: ${meta.work_level || 'Not specified'}
Interview Performance: ${avgScore ? avgScore + '/100' : 'Not assessed'}
Verified Skills: ${scored.map(b => b.competency).join(', ') || 'None yet'}
Open to Relocation: ${meta.open_to_relocate === '1' ? 'Yes' : 'No'}
Preferred Locations: ${prefLocations.map(p => (p.preferred_city_name || '') + ', ' + (p.preferred_country_name || '')).join('; ') || 'Current location preferred'}
Employment History:
${workExperience.map(j => `  ${j.job_title || '?'} at ${j.company_name || '?'} (${j.start_date || '?'} - ${j.Currently_working === 'yes' ? 'Present' : j.end_date || '?'})`).join('\n') || '  None listed'}
Education:
${education.map(e => `  ${e.degree || '?'} from ${e.institution_name || '?'}`).join('\n') || '  None listed'}

RESEARCH TASK:
For this ${industry} professional in ${city}, ${country}, research and provide:
1. Three realistic career paths (specific to their industry + location)
2. Current salary level in ${city} for their role
3. Salary progression for EACH path in ${city} (or if relocation, in that specific city)
4. Market demand for each role in their location
5. Timeline to transition (realistic, considering market conditions)

FOR EACH PATH PROVIDE:
- role_title: Specific job title in their industry
- timeline_months: Realistic months to transition
- required_skills: 3-4 specific skills needed
- current_salary_range: What they earn now in ${city}
- expected_salary_range: What they'll earn in new role in ${city}
- salary_growth_percentage: % increase from current
- fit_reason: Leverage their current strengths
- industries: Where this role exists
- work_life_balance: Balanced/Demanding/Flexible
- stability: Stable/Growth/Risk
- timing_strategy: When to move (market conditions, experience level)
- risks: Challenges they might face
- risk_mitigation: How to overcome risks
- next_actions: 4-5 concrete actions to start now

CRITICAL: Use REAL 2024-2025 salary data for ${city}, ${country}. No vague ranges like "5L-25L" — be SPECIFIC (e.g., "6-8L", "10-14L"). Account for ${expYears} years experience.

Return ONLY valid JSON:
{
  "paths": [{ "role_title", "timeline_months", "required_skills", "current_salary_range", "expected_salary_range", "salary_growth_percentage", "fit_reason", "industries", "work_life_balance", "stability", "timing_strategy", "risks", "risk_mitigation", "next_actions" }],
  "overall_insights": "...",
  "skill_gaps": [...],
  "market_analysis": "..."
}`;

    // Call OpenAI
    const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 3500,
        response_format: { type: 'json_object' }
      })
    });

    if (!openaiResponse.ok) {
      const err = await openaiResponse.json().catch(() => ({}));
      console.error('OpenAI error:', err);
      return res.status(500).json({ error: 'Failed to generate career analysis' });
    }

    const openaiData = await openaiResponse.json();
    const reportData = JSON.parse(openaiData.choices[0].message.content);

    // Add location metadata
    reportData.location = { city, country };

    // Save report
    await pool.execute(
      'INSERT INTO agzit_career_reports (user_id, report_json, dpr_snapshot) VALUES (?, ?, ?)',
      [userId, JSON.stringify(reportData), JSON.stringify(meta)]
    );

    // Deduct credit
    await pool.execute(
      'UPDATE agzit_candidate_credits SET credit_balance = credit_balance - 1 WHERE user_id = ?',
      [userId]
    );

    // Log transaction
    await pool.execute(
      "INSERT INTO agzit_credit_transactions (user_id, transaction_type, amount, description) VALUES (?, 'usage', 1, ?)",
      [userId, `Career Analyzer: ${industry} in ${city}`]
    );

    res.json({ ok: true, report: reportData, creditsRemaining: credits.credit_balance - 1 });

  } catch (error) {
    console.error('Career analyzer error:', error);
    res.status(500).json({ error: 'Failed to generate analysis' });
  }
});

// ── POST /api/candidate/send-referral ────────────────────────────────────────
router.post('/send-referral', ...guard, async (req, res) => {
  try {
    const userId = req.user.user_id || req.user.id;
    const { referral_email } = req.body;

    if (!referral_email || !referral_email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    // Get referrer info
    const [[referrer]] = await pool.execute(
      'SELECT id, first_name, email FROM agzit_users WHERE id = ?',
      [userId]
    );

    if (!referrer) return res.status(404).json({ error: 'User not found' });

    // Check if already invited (prevent spam)
    const [[existing]] = await pool.execute(
      'SELECT id FROM agzit_referrals WHERE referrer_id = ? AND referral_email = ? AND status IN ("pending", "completed")',
      [userId, referral_email]
    );

    if (existing) {
      return res.status(400).json({ error: 'Already invited this email' });
    }

    // Create referral record
    const [referralResult] = await pool.execute(
      `INSERT INTO agzit_referrals (referrer_id, referral_email, status, referred_at)
       VALUES (?, ?, 'pending', NOW())`,
      [userId, referral_email]
    );

    const referralId = referralResult.insertId;
    const referralLink = `https://app.agzit.com/register?ref=${referralId}`;

    // Send email via Brevo
    try {
      const emailResponse = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': process.env.BREVO_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          to: [{ email: referral_email }],
          sender: { email: 'noreply@agzit.com', name: 'AGZIT Career Intelligence' },
          subject: `${referrer.first_name} invited you to AGZIT - Get 1 Free Career Report!`,
          htmlContent: `
            <h2>You're invited to AGZIT!</h2>
            <p>Hi there,</p>
            <p><strong>${referrer.first_name}</strong> thinks you'd be great on AGZIT - a career intelligence platform for professionals.</p>

            <h3>What you get:</h3>
            <ul>
              <li>AI-powered mock interviews (10 competencies scored)</li>
              <li>Verification badges (Silver/Gold/Platinum)</li>
              <li>Career Analyzer (3 strategic paths with salary insights)</li>
              <li>1 FREE Career Analyzer report</li>
              <li>Global job market insights</li>
            </ul>

            <p><a href="${referralLink}" style="background: #1A44C2; color: white; padding: 12px 24px; border-radius: 6px; text-decoration: none; display: inline-block;">Create Your Profile Now</a></p>

            <p>Bonus: When you sign up, ${referrer.first_name} gets 1 free Career Analyzer credit!</p>

            <p>Best,<br>The AGZIT Team</p>
          `
        })
      });

      if (!emailResponse.ok) {
        console.error('Brevo email error:', await emailResponse.text());
      }
    } catch (emailErr) {
      console.error('Email send failed:', emailErr.message);
    }

    res.json({
      ok: true,
      message: 'Referral invite sent!',
      referral_id: referralId
    });

  } catch (error) {
    console.error('Send referral error:', error);
    res.status(500).json({ error: 'Failed to send referral' });
  }
});

// ── GET /api/candidate/referral-stats ────────────────────────────────────────
router.get('/referral-stats', ...guard, async (req, res) => {
  try {
    const userId = req.user.user_id || req.user.id;

    const [[stats]] = await pool.execute(
      `SELECT
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_count,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as credits_earned
      FROM agzit_referrals WHERE referrer_id = ?`,
      [userId]
    );

    // Fetch total credit balance
    const [[creditRow]] = await pool.execute(
      'SELECT credit_balance FROM agzit_candidate_credits WHERE user_id = ?',
      [userId]
    );

    res.json({
      ok: true,
      pending_invites: stats.pending_count || 0,
      successful_referrals: stats.completed_count || 0,
      credits_earned: stats.credits_earned || 0,
      total_credits: (creditRow && creditRow.credit_balance) || 0
    });

  } catch (error) {
    console.error('Referral stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ── GET /api/candidate/referral-history ──────────────────────────────────────
router.get('/referral-history', ...guard, async (req, res) => {
  try {
    const userId = req.user.user_id || req.user.id;

    const [referrals] = await pool.execute(
      `SELECT
        id, referral_email, status, referred_at, completed_at
      FROM agzit_referrals
      WHERE referrer_id = ?
      ORDER BY referred_at DESC
      LIMIT 50`,
      [userId]
    );

    res.json({
      ok: true,
      referrals: referrals || []
    });

  } catch (error) {
    console.error('Referral history error:', error);
    res.status(500).json({ error: 'Failed to fetch referral history' });
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

    // Fix stale "in_progress" sessions — if lock has expired, treat as completed
    const [[lockUser]] = await pool.execute(
      'SELECT wp_user_id FROM agzit_users WHERE id = ?', [req.user.user_id]
    );
    if (lockUser?.wp_user_id) {
      const lockMeta = await fetchUserMeta(lockUser.wp_user_id, ['mock_session_lock_until']);
      const lockUntil = parseInt(lockMeta.mock_session_lock_until) || 0;
      const nowTs = Math.floor(Date.now() / 1000);
      for (const s of sessions) {
        if (s.interview_status === 'in_progress' && nowTs >= lockUntil) {
          s.interview_status = 'completed';
        }
      }
    }

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

    // ── Create ACF session row via internal route (direct MySQL, no WordPress) ─
    const wpToken = process.env.WP_APP_TOKEN || '';
    const internalBase = `http://localhost:${process.env.PORT || 3000}`;

    const wpResult = await postJson(
      `${internalBase}/api/internal/mock-session-start`,
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
      console.error('[interviews/start] mock-session-start error:', err.message);
      return { status: 0, body: null };
    });

    if (!wpResult.body?.ok) {
      // Refund credit and clear lock on failure
      await upsertUserMeta(wpUserId, creditKey,                   String(credits));
      await upsertUserMeta(wpUserId, 'mock_sessions_remaining',   String(rem20 + rem30 + 1));
      await upsertUserMeta(wpUserId, 'mock_session_lock_until',   '0');
      await upsertUserMeta(wpUserId, 'mock_session_lock_id',      '');
      console.error('[interviews/start] internal returned:', wpResult.status, wpResult.body);
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

// ── POST /api/candidate/interview-queue/join ─────────────────────────────────
// Book a scheduled interview slot. preferred_time is required (confirmed time).
router.post('/interview-queue/join', ...guard, async (req, res) => {
  try {
    const userId = req.user.user_id;
    const scheduledTime = req.body.preferred_time;
    if (!scheduledTime) return res.status(400).json({ ok: false, error: 'Scheduled time is required' });

    // Cancel any existing waiting booking
    await pool.execute(
      'UPDATE agzit_interview_queue SET status = "expired" WHERE user_id = ? AND status = "waiting"',
      [userId]
    );

    // Get user info
    const [[user]] = await pool.execute(
      'SELECT email, first_name FROM agzit_users WHERE id = ?', [userId]
    );
    if (!user) return res.status(404).json({ ok: false, error: 'User not found' });

    // Insert booking
    const scheduledDt = new Date(scheduledTime);
    const mysqlTime = scheduledDt.toISOString().replace('T', ' ').slice(0, 19);
    const [result] = await pool.execute(
      'INSERT INTO agzit_interview_queue (user_id, email, first_name, preferred_time) VALUES (?, ?, ?, ?)',
      [userId, user.email, user.first_name || '', mysqlTime]
    );

    // Send booking confirmation email (Email 1)
    const firstName = user.first_name || 'there';
    const displayTime = scheduledDt.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });

    if (process.env.BREVO_API_KEY) {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: [{ email: user.email }],
          sender: { email: 'noreply@agzit.com', name: 'AGZIT AI' },
          subject: 'Your AGZIT interview is scheduled',
          htmlContent: `
            <div style="font-family:'Plus Jakarta Sans',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px;">
              <h2 style="color:#09101F;font-size:20px;">Hi ${firstName},</h2>
              <p style="color:#3A4163;font-size:15px;line-height:1.7;">
                Your AI mock interview is booked for <strong>${displayTime} IST</strong>.
              </p>
              <p style="color:#3A4163;font-size:15px;line-height:1.7;">
                We'll send you a direct link when it's time to start. Your interview will take 20–30 minutes.
              </p>
              <div style="background:#F5F6FA;border:1px solid #E4E6EF;border-radius:12px;padding:16px;margin:20px 0;">
                <div style="font-size:13px;color:#7C83A0;margin-bottom:4px;">SCHEDULED FOR</div>
                <div style="font-size:16px;font-weight:700;color:#09101F;">${displayTime} IST</div>
              </div>
              <p style="color:#7C83A0;font-size:13px;">You can cancel or reschedule from your dashboard at any time.</p>
              <hr style="border:none;border-top:1px solid #E4E6EF;margin:24px 0;">
              <p style="color:#7C83A0;font-size:12px;">AGZIT Career Intelligence &middot; <a href="https://agzit.com" style="color:#1A44C2;">agzit.com</a></p>
            </div>
          `,
        }),
      }).catch(err => console.error('[schedule] Brevo confirmation error:', err.message));
    }

    res.json({ ok: true, booking_id: result.insertId, scheduled_time: mysqlTime });
  } catch (err) {
    console.error('[interview-queue/join]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/candidate/interview-queue/status ────────────────────────────────
// Returns slot availability and any existing booking
router.get('/interview-queue/status', ...guard, async (req, res) => {
  try {
    const userId = req.user.user_id;

    // Check slot availability from daily backend
    const renderUrl = (process.env.RENDER_BACKEND_URL || 'https://agzit-daily-backend.onrender.com').replace(/\/$/, '');
    let slotsActive = 0, slotsMax = 10;
    try {
      const slotRes = await fetch(`${renderUrl}/interview/status`);
      const slotData = await slotRes.json();
      slotsActive = slotData.active || 0;
      slotsMax = slotData.max || 10;
    } catch (_) {}

    // Check user's booking
    const [entry] = await pool.execute(
      'SELECT id, preferred_time, status, created_at FROM agzit_interview_queue WHERE user_id = ? AND status = "waiting" ORDER BY id DESC LIMIT 1',
      [userId]
    );

    res.json({
      ok: true,
      slots_active: slotsActive,
      slots_max: slotsMax,
      slots_available: Math.max(0, slotsMax - slotsActive),
      has_booking: entry.length > 0,
      booking: entry.length ? {
        id: entry[0].id,
        scheduled_time: entry[0].preferred_time,
        created_at: entry[0].created_at,
      } : null,
    });
  } catch (err) {
    console.error('[interview-queue/status]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── DELETE /api/candidate/interview-queue/leave ──────────────────────────────
// Cancel a scheduled interview booking
router.delete('/interview-queue/leave', ...guard, async (req, res) => {
  try {
    await pool.execute(
      'UPDATE agzit_interview_queue SET status = "expired" WHERE user_id = ? AND status = "waiting"',
      [req.user.user_id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[interview-queue/leave]', err);
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
      'desired_role', 'soft_skills', 'key_achievements',
      'residential_address_line_1', 'residential_address_line_2',
      'residential_city', 'residential_state', 'residential_zip_code',
      'country_of_nationality', 'residential_country', 'compliance_domains',
      'current_annual_ctc_with_currency', 'expected_annual_ctc_with_currency',
      'preferred_work_type', 'work_level',
      'gender', 'date_of_birth',
      'email_visibility', 'phone_visibility',
      'professional_headline',
    ];
    // Textarea fields that accept freeform rich text — sanitize HTML tags
    const TEXTAREA_FIELDS = new Set([
      'professional_summary_bio', 'soft_skills', 'key_achievements',
    ]);
    for (const f of SCALAR_FIELDS) {
      if (b[f] !== undefined) {
        let val = TEXTAREA_FIELDS.has(f) ? sanitize(b[f]) : s(b[f]);
        if (f === 'soft_skills') val = val.split('http')[0].trim().replace(/,\s*$/, '');
        await upsertPostMeta(profileId, f, val);
      }
    }

    // ── CTC merge: combine separate currency + amount into single field ──────
    if (b.current_ctc_currency && b.current_ctc_amount) {
      const ctcVal = `${s(b.current_ctc_currency)} ${s(b.current_ctc_amount)}`;
      await upsertPostMeta(profileId, 'current_annual_ctc_with_currency', ctcVal);
    }
    if (b.expected_ctc_currency && b.expected_ctc_amount) {
      const ctcVal = `${s(b.expected_ctc_currency)} ${s(b.expected_ctc_amount)}`;
      await upsertPostMeta(profileId, 'expected_annual_ctc_with_currency', ctcVal);
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

    // ── Sub-industry (stored in wp_usermeta, not postmeta) ───────────────────
    if (b.candidate_sub_industries !== undefined && req.user.wp_user_id) {
      const subs = Array.isArray(b.candidate_sub_industries) ? b.candidate_sub_industries : [];
      await upsertUserMeta(req.user.wp_user_id, 'candidate_sub_industries', JSON.stringify(subs));
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
          key_responsibilities: sanitize(r.key_responsibilities || ''),
          key_achievements:     sanitize(r.key_achievements     || ''),
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
        .filter(r => s(r.language_name))
        .map(r => ({ language: s(r.language_name), proficiency: s(r.proficiency) }));
      await clearRepeaterMeta(profileId, 'language_proficiency');
      await writeRepeater(profileId, 'language_proficiency', rows);
    }

    // ── Preferred locations repeater ─────────────────────────────────────────
    if (Array.isArray(b.preferred_location)) {
      const rows = b.preferred_location
        .filter(r => s(r.preferred_city_name) || s(r.preferred_country_name))
        .map(r => ({ preferred_city_name: s(r.preferred_city_name), preferred_country_name: s(r.preferred_country_name) }));
      await clearRepeaterMeta(profileId, 'preferred_location');
      await writeRepeater(profileId, 'preferred_location', rows);
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

      // Cloudinary URL — redirect directly
      if (raw.startsWith('http')) {
        return res.redirect(302, raw);
      }

      // Fallback: serve from agzit_resume_files BLOB
      const [[blobRow]] = await pool.execute(
        'SELECT filename, mimetype, filedata FROM agzit_resume_files WHERE user_id = ? LIMIT 1',
        [req.user.user_id]
      );
      if (blobRow?.filedata) {
        res.setHeader('Content-Type', blobRow.mimetype || 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${blobRow.filename || 'resume.pdf'}"`);
        res.setHeader('Content-Length', blobRow.filedata.length);
        return res.send(blobRow.filedata);
      }

      // Legacy: WP attachment ID lookup
      let attachId = null;
      if (/^\d+$/.test(raw)) {
        attachId = parseInt(raw);
      } else {
        try {
          const parsed = JSON.parse(raw);
          attachId = parsed?.ID ? parseInt(parsed.ID) : null;
        } catch (_) {}
      }
      if (attachId) {
        const [[post]] = await pool.execute(
          'SELECT guid FROM wp_posts WHERE ID = ? AND post_type = "attachment" LIMIT 1',
          [attachId]
        );
        if (post?.guid) return res.redirect(302, post.guid);
      }

      return res.status(404).json({ ok: false, error: 'Resume file not found' });
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

    // Resolve resume URL or attachment
    const rawUpload = String(meta.resume_upload || '').trim();
    if (!rawUpload) return res.status(404).json({ ok: false, error: 'No resume uploaded' });

    // Cloudinary URL — proxy through Render so URL is never exposed
    if (rawUpload.startsWith('http')) {
      const fileRes = await fetch(rawUpload);
      if (!fileRes.ok) {
        console.error('[resume/download] Cloudinary fetch failed:', fileRes.status, rawUpload);
        return res.status(502).json({ ok: false, error: 'Could not retrieve resume file' });
      }
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      const contentType = fileRes.headers.get('content-type') || 'application/pdf';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${dprId}_resume.pdf"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Length', buffer.length);
      return res.send(buffer);
    }

    // Fallback: serve from agzit_resume_files BLOB
    const [[ownerRow]] = await pool.execute(
      `SELECT u.id FROM agzit_users u WHERE u.dpr_profile_id = ? LIMIT 1`,
      [profileId]
    );
    if (ownerRow) {
      const [[blobRow]] = await pool.execute(
        'SELECT filename, mimetype, filedata FROM agzit_resume_files WHERE user_id = ? LIMIT 1',
        [ownerRow.id]
      );
      if (blobRow?.filedata) {
        res.setHeader('Content-Type', blobRow.mimetype || 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${dprId}_resume.pdf"`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Length', blobRow.filedata.length);
        return res.send(blobRow.filedata);
      }
    }

    // Legacy: WP attachment ID lookup
    let attachId = null;
    if (/^\d+$/.test(rawUpload)) {
      attachId = parseInt(rawUpload);
    } else {
      try {
        const parsed = JSON.parse(rawUpload);
        attachId = parsed?.ID ? parseInt(parsed.ID) : null;
      } catch (_) {}
    }
    if (attachId) {
      const [[attachPost]] = await pool.execute(
        'SELECT guid FROM wp_posts WHERE ID = ? AND post_type = "attachment" LIMIT 1',
        [attachId]
      );
      if (attachPost?.guid) {
        const fileRes = await fetch(attachPost.guid);
        if (fileRes.ok) {
          const buffer = Buffer.from(await fileRes.arrayBuffer());
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename="${dprId}_resume.pdf"`);
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Content-Length', buffer.length);
          return res.send(buffer);
        }
      }
    }

    return res.status(404).json({ ok: false, error: 'Resume file not found' });

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
      ['dpr_id',                             dprId],
      ['issue_date',                         nowStr.slice(0, 10)],
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
      ['is_fresher',                         s(personal.is_fresher) === '1' ? '1' : '0'],
      ['project_title',                      s(personal.project_title)],
      ['project_date',                       s(personal.project_date)],
      ['project_summary',                    s(personal.project_summary)],
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

    // 9b. Write compliance_tools repeater
    const toolRows = (Array.isArray(skills.compliance_tools) ? skills.compliance_tools : [])
      .filter(t => s(t.tool_name))
      .map(t => ({ tool_name: s(t.tool_name) }));
    await pool.execute('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
      [postId, 'compliance_tools', String(toolRows.length)]);
    for (let i = 0; i < toolRows.length; i++) {
      for (const [k, v] of Object.entries(toolRows[i])) {
        await pool.execute('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
          [postId, `compliance_tools_${i}_${k}`, String(v ?? '')]);
      }
    }

    // 9c. Write language_proficiency repeater
    const langRows = (Array.isArray(skills.language_proficiency) ? skills.language_proficiency : [])
      .filter(l => s(l.language))
      .map(l => ({ language: s(l.language) }));
    await pool.execute('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
      [postId, 'language_proficiency', String(langRows.length)]);
    for (let i = 0; i < langRows.length; i++) {
      for (const [k, v] of Object.entries(langRows[i])) {
        await pool.execute('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
          [postId, `language_proficiency_${i}_${k}`, String(v ?? '')]);
      }
    }

    // 9d. Write preferred_location repeater
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
      // Save candidate sub-industries
      if (Array.isArray(personal.candidate_sub_industries)) {
        const subs = personal.candidate_sub_industries.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean);
        await upsertUserMeta(wpUserId, 'candidate_sub_industries', JSON.stringify(subs));
      }
    }

    // 13. Award DPR creation bonus (+1 credit, first time only)
    try {
      const [[existingBonus]] = await pool.execute(
        "SELECT id FROM agzit_credit_transactions WHERE user_id = ? AND transaction_type = 'dpr_bonus' LIMIT 1",
        [req.user.user_id]
      );
      if (!existingBonus) {
        await pool.execute(
          `INSERT INTO agzit_candidate_credits (user_id, credit_balance, total_credits_earned)
           VALUES (?, 1, 1)
           ON DUPLICATE KEY UPDATE
             credit_balance = credit_balance + 1,
             total_credits_earned = total_credits_earned + 1`,
          [req.user.user_id]
        );
        await pool.execute(
          "INSERT INTO agzit_credit_transactions (user_id, transaction_type, amount, description) VALUES (?, 'dpr_bonus', 1, 'DPR profile creation bonus')",
          [req.user.user_id]
        );
        console.log(`[dpr] Awarded DPR bonus credit to user ${req.user.user_id}`);
      }
    } catch (creditErr) {
      console.error('[dpr] DPR bonus credit error:', creditErr.message);
    }

    // 14. Award referral credit to referrer (triggered by DPR completion, not signup)
    try {
      const [[pendingRef]] = await pool.execute(
        "SELECT id, referrer_id FROM agzit_referrals WHERE referred_user_id = ? AND status = 'pending' LIMIT 1",
        [req.user.user_id]
      );
      if (pendingRef) {
        const referrerId = pendingRef.referrer_id;

        // Mark referral as completed
        await pool.execute(
          "UPDATE agzit_referrals SET status = 'completed', completed_at = NOW() WHERE id = ?",
          [pendingRef.id]
        );

        // Award +1 credit to referrer
        await pool.execute(
          `INSERT INTO agzit_candidate_credits (user_id, credit_balance, total_credits_earned)
           VALUES (?, 1, 1)
           ON DUPLICATE KEY UPDATE
             credit_balance = credit_balance + 1,
             total_credits_earned = total_credits_earned + 1`,
          [referrerId]
        );

        // Log transaction
        const userEmail = req.user.email || '';
        await pool.execute(
          "INSERT INTO agzit_credit_transactions (user_id, transaction_type, amount, description) VALUES (?, 'referral', 1, ?)",
          [referrerId, `Referral completed: ${userEmail}`]
        );

        // Send thank-you email to referrer
        try {
          const [[referrerUser]] = await pool.execute(
            'SELECT email, first_name FROM agzit_users WHERE id = ?',
            [referrerId]
          );
          if (referrerUser && process.env.BREVO_API_KEY) {
            await fetch('https://api.brevo.com/v3/smtp/email', {
              method: 'POST',
              headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                to: [{ email: referrerUser.email }],
                sender: { email: 'noreply@agzit.com', name: 'AGZIT' },
                subject: 'Your referral completed their DPR! You earned 1 free credit',
                htmlContent: `
                  <div style="font-family:'Plus Jakarta Sans',system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px;">
                    <h2 style="color:#09101F;font-size:20px;">Referral Success!</h2>
                    <p style="color:#3A4163;font-size:15px;line-height:1.7;">Great news, ${referrerUser.first_name || 'there'}! Your friend signed up and completed their DPR profile.</p>
                    <p style="color:#3A4163;font-size:15px;line-height:1.7;"><strong>You've earned 1 free credit!</strong> Use it for Career Analyzer or AI Resume Polish.</p>
                    <p style="margin:24px 0;">
                      <a href="https://app.agzit.com/dashboard" style="background:#1A44C2;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;display:inline-block;">Go to Dashboard</a>
                    </p>
                    <p style="color:#7C83A0;font-size:13px;">Keep referring to earn more credits!</p>
                    <hr style="border:none;border-top:1px solid #E4E6EF;margin:24px 0;">
                    <p style="color:#7C83A0;font-size:12px;">AGZIT Career Intelligence &middot; <a href="https://agzit.com" style="color:#1A44C2;">agzit.com</a></p>
                  </div>
                `,
              }),
            }).catch(err => console.error('[dpr] Referral thank-you email error:', err.message));
          }
        } catch (emailErr) {
          console.error('[dpr] Referral email error:', emailErr.message);
        }

        console.log(`[dpr] Awarded referral credit to user ${referrerId} (referred by user ${req.user.user_id})`);
      }
    } catch (refErr) {
      console.error('[dpr] Referral credit error:', refErr.message);
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

    const rawName  = (req.file.originalname || 'resume').replace(/[^a-zA-Z0-9._\- ]/g, '_');
    const filename = rawName || 'resume.pdf';
    const mimetype = req.file.mimetype;
    const filedata = req.file.buffer;
    const nowStr   = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // Upload to Cloudinary
    const publicId = `resume_${req.user.user_id}_${Date.now()}`;
    const cloudResult = await uploadToCloudinary(filedata, publicId);
    const resumeUrl = cloudResult.secure_url;

    // Store metadata in agzit_resume_files (keep blob as backup)
    await pool.execute(
      `INSERT INTO agzit_resume_files (user_id, profile_post_id, filename, mimetype, filedata, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE profile_post_id=VALUES(profile_post_id),
         filename=VALUES(filename), mimetype=VALUES(mimetype),
         filedata=VALUES(filedata), uploaded_at=VALUES(uploaded_at)`,
      [req.user.user_id, profileId, filename, mimetype, filedata, nowStr]
    );
    await upsertPostMeta(profileId, 'has_resume',        '1');
    await upsertPostMeta(profileId, 'resume_upload',      resumeUrl);
    await upsertPostMeta(profileId, 'resume_filename',    filename);
    await upsertPostMeta(profileId, 'resume_uploaded_at', nowStr);

    console.log(`[resume] Saved ${filename} for profile ${profileId} → Cloudinary: ${resumeUrl}`);
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

    if (!RESUME_ALLOWED_TYPES.includes(req.file.mimetype)) {
      return res.status(400).json({ ok: false, error: 'Only PDF and Word documents are accepted.' });
    }

    const postId = parseInt(req.params.postId);
    if (!postId) return res.status(400).json({ ok: false, error: 'Invalid post ID.' });

    // Verify this post belongs to the authenticated user
    const profileId = await getProfileId(req.user.user_id);
    if (profileId !== postId) return res.status(403).json({ ok: false, error: 'Access denied.' });

    // Sanitize filename: strip path components and keep only safe characters
    const rawName = (req.file.originalname || 'resume').replace(/[^a-zA-Z0-9._\- ]/g, '_');
    const filename  = rawName || 'resume.pdf';
    const mimetype  = req.file.mimetype;
    const filedata  = req.file.buffer;
    const nowStr    = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // Upload to Cloudinary
    const publicId = `resume_${req.user.user_id}_${Date.now()}`;
    const cloudResult = await uploadToCloudinary(filedata, publicId);
    const resumeUrl = cloudResult.secure_url;

    // UPSERT into agzit_resume_files (unique key on user_id) — keep blob as backup
    await pool.execute(
      `INSERT INTO agzit_resume_files (user_id, profile_post_id, filename, mimetype, filedata, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE profile_post_id=VALUES(profile_post_id),
         filename=VALUES(filename), mimetype=VALUES(mimetype),
         filedata=VALUES(filedata), uploaded_at=VALUES(uploaded_at)`,
      [req.user.user_id, postId, filename, mimetype, filedata, nowStr]
    );

    await upsertPostMeta(postId, 'has_resume',         '1');
    await upsertPostMeta(postId, 'resume_upload',       resumeUrl);
    await upsertPostMeta(postId, 'resume_filename',     filename);
    await upsertPostMeta(postId, 'resume_uploaded_at',  nowStr);

    console.log(`[dpr/resume] Saved resume for post ${postId} → Cloudinary: ${resumeUrl}`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[dpr/resume]', err);
    res.status(500).json({ ok: false, error: err.message || 'Server error.' });
  }
});

// ── AI Polish Credits ─────────────────────────────────────────────────────────

// GET /api/candidate/ai-polish/credits — now uses unified credit system
router.get('/ai-polish/credits', ...guard, async (req, res) => {
  try {
    const [[row]] = await pool.execute(
      'SELECT credit_balance FROM agzit_candidate_credits WHERE user_id = ?',
      [req.user.id]
    );
    return res.json({ ok: true, credits_remaining: row ? row.credit_balance : 0 });
  } catch (err) {
    console.error('[ai-polish/credits]', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/candidate/ai-polish/verify-purchase
router.post('/ai-polish/verify-purchase', ...guard, async (req, res) => {
  try {
    const orderId = typeof req.body.order_id === 'string' ? req.body.order_id.trim() : '';
    if (!orderId) return res.status(400).json({ ok: false, error: 'order_id is required' });

    // Check if order already used
    const [[existing]] = await pool.execute(
      'SELECT id FROM agzit_ai_polish_credits WHERE order_id = ?',
      [orderId]
    );
    if (existing) {
      return res.status(409).json({ ok: false, error: 'This order has already been applied' });
    }

    // Look up WooCommerce order: check wp_posts for wc-completed order,
    // then verify it contains product 20640 and billing email matches
    const [[order]] = await pool.execute(
      `SELECT p.ID, pm_email.meta_value AS billing_email
       FROM wp_posts p
       JOIN wp_postmeta pm_email ON pm_email.post_id = p.ID AND pm_email.meta_key = '_billing_email'
       WHERE p.ID = ? AND p.post_type = 'shop_order' AND p.post_status = 'wc-completed'
       LIMIT 1`,
      [orderId]
    );
    if (!order) {
      return res.status(404).json({ ok: false, error: 'Order not found or not completed' });
    }

    // Verify billing email matches logged-in user
    const [[user]] = await pool.execute('SELECT email FROM agzit_users WHERE id = ?', [req.user.id]);
    if (!user || order.billing_email.toLowerCase() !== user.email.toLowerCase()) {
      return res.status(403).json({ ok: false, error: 'Order email does not match your account' });
    }

    // Verify order contains product 20640
    const [[item]] = await pool.execute(
      `SELECT oi.order_item_id
       FROM wp_woocommerce_order_items oi
       JOIN wp_woocommerce_order_itemmeta oim ON oim.order_item_id = oi.order_item_id
       WHERE oi.order_id = ? AND oi.order_item_type = 'line_item'
         AND oim.meta_key = '_product_id' AND oim.meta_value = '20640'
       LIMIT 1`,
      [orderId]
    );
    if (!item) {
      return res.status(404).json({ ok: false, error: 'Order does not contain AI Polish product' });
    }

    // Insert or update credits
    await pool.execute(
      `INSERT INTO agzit_ai_polish_credits (user_id, credits_remaining, order_id)
       VALUES (?, 3, ?)
       ON DUPLICATE KEY UPDATE credits_remaining = credits_remaining + 3, order_id = VALUES(order_id), purchased_at = NOW()`,
      [req.user.id, orderId]
    );

    return res.json({ ok: true, credits_remaining: 3 });
  } catch (err) {
    console.error('[ai-polish/verify-purchase]', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/candidate/ai-polish/use-credit — now uses unified credit system
router.post('/ai-polish/use-credit', ...guard, async (req, res) => {
  try {
    const [[row]] = await pool.execute(
      'SELECT credit_balance FROM agzit_candidate_credits WHERE user_id = ?',
      [req.user.id]
    );
    if (!row || row.credit_balance < 1) {
      return res.status(403).json({ ok: false, error: 'You need 1 credit. Earn free credits by referring a friend or completing your DPR profile.' });
    }
    await pool.execute(
      'UPDATE agzit_candidate_credits SET credit_balance = credit_balance - 1 WHERE user_id = ?',
      [req.user.id]
    );
    await pool.execute(
      "INSERT INTO agzit_credit_transactions (user_id, transaction_type, amount, description) VALUES (?, 'usage', 1, 'AI Resume Polish')",
      [req.user.id]
    );
    return res.json({ ok: true, credits_remaining: row.credit_balance - 1 });
  } catch (err) {
    console.error('[ai-polish/use-credit]', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// POST /api/candidate/ai-polish — Full profile polish with optional JD (unified credits)
router.post('/ai-polish', ...guard, async (req, res) => {
  try {
    // Check unified credits
    const [[creditRow]] = await pool.execute(
      'SELECT credit_balance FROM agzit_candidate_credits WHERE user_id = ?',
      [req.user.id]
    );
    if (!creditRow || creditRow.credit_balance < 1) {
      return res.status(403).json({ ok: false, error: 'You need 1 credit. Earn free credits by referring a friend or completing your DPR profile.' });
    }

    const profile = req.body.profile;
    const jdText  = typeof req.body.jd_text === 'string' ? req.body.jd_text.trim() : '';

    if (!profile || !profile.summary) {
      return res.status(400).json({ ok: false, error: 'Profile data with summary is required' });
    }

    // Build the prompt
    let systemPrompt, userContent;

    if (jdText) {
      systemPrompt = `You are an expert resume writer and ATS optimization specialist. The candidate wants their resume tailored to a specific job description. Rewrite the summary and job bullet points to:
- Align with the job description keywords and requirements
- Improve ATS keyword match score
- Highlight relevant skills and experience
- Keep all facts true — never invent experience or qualifications
- Use strong action verbs and quantified achievements where possible
Return a JSON object with: { "summary": "rewritten summary", "work_exp": [{ "description": "rewritten bullets for job 0" }, { "description": "..." }] }
Only include work_exp entries that had descriptions. Return valid JSON only, no markdown.`;
      userContent = `JOB DESCRIPTION:\n${jdText}\n\nCANDIDATE PROFILE:\nSummary: ${profile.summary}\n\n${(profile.work_exp || []).map((w, i) => `Job ${i}: ${w.title} at ${w.company}\nBullets: ${w.description}`).join('\n\n')}`;
    } else {
      systemPrompt = `You are an expert resume writer. Polish the candidate's resume to:
- Improve clarity, remove redundancy, strengthen impact language
- Use strong action verbs and quantify achievements where possible
- Make it ATS-friendly with professional tone
- Keep all facts true — never invent experience
Return a JSON object with: { "summary": "polished summary", "work_exp": [{ "description": "polished bullets for job 0" }, { "description": "..." }] }
Only include work_exp entries that had descriptions. Return valid JSON only, no markdown.`;
      userContent = `CANDIDATE PROFILE:\nSummary: ${profile.summary}\n\n${(profile.work_exp || []).map((w, i) => `Job ${i}: ${w.title} at ${w.company}\nBullets: ${w.description}`).join('\n\n')}`;
    }

    const raw = await callOpenAI(systemPrompt, userContent, 3000);

    // Parse JSON from response (strip markdown fences if present)
    let polished;
    try {
      const jsonStr = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim();
      polished = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error('[ai-polish] Failed to parse OpenAI response:', raw.substring(0, 200));
      return res.status(502).json({ ok: false, error: 'AI returned invalid format. Please try again.' });
    }

    // Build polished profile
    const polishedProfile = JSON.parse(JSON.stringify(profile));
    if (polished.summary) polishedProfile.summary = polished.summary;
    if (polished.work_exp && Array.isArray(polished.work_exp)) {
      polished.work_exp.forEach((pw, i) => {
        if (polishedProfile.work_exp && polishedProfile.work_exp[i] && pw.description) {
          polishedProfile.work_exp[i].description = pw.description;
        }
      });
    }

    // Deduct unified credit
    await pool.execute(
      'UPDATE agzit_candidate_credits SET credit_balance = credit_balance - 1 WHERE user_id = ?',
      [req.user.id]
    );
    await pool.execute(
      "INSERT INTO agzit_credit_transactions (user_id, transaction_type, amount, description) VALUES (?, 'usage', 1, 'AI Resume Polish')",
      [req.user.id]
    );

    return res.json({
      ok: true,
      polished_profile: polishedProfile,
      credits_remaining: creditRow.credit_balance - 1,
    });
  } catch (err) {
    console.error('[ai-polish]', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── Saved Resumes ─────────────────────────────────────────────────────────────

// POST /api/candidate/saved-resumes
router.post('/saved-resumes', ...guard, async (req, res) => {
  try {
    const resumeName = typeof req.body.resume_name === 'string' ? req.body.resume_name.trim() : '';
    const templateId = typeof req.body.template_id === 'string' ? req.body.template_id.trim() : '';
    const resumeData = req.body.resume_data ? JSON.stringify(req.body.resume_data) : null;
    const jdUsed     = typeof req.body.jd_used === 'string' ? req.body.jd_used.trim() : null;

    if (!resumeName) return res.status(400).json({ ok: false, error: 'resume_name is required' });
    if (!resumeData) return res.status(400).json({ ok: false, error: 'resume_data is required' });

    const [result] = await pool.execute(
      'INSERT INTO agzit_saved_resumes (user_id, resume_name, template_id, resume_data, jd_used) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, resumeName, templateId, resumeData, jdUsed]
    );
    return res.json({ ok: true, id: result.insertId });
  } catch (err) {
    console.error('[saved-resumes/create]', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/candidate/saved-resumes
router.get('/saved-resumes', ...guard, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, resume_name, template_id, jd_used, created_at, updated_at FROM agzit_saved_resumes WHERE user_id = ? ORDER BY updated_at DESC',
      [req.user.id]
    );
    return res.json({ ok: true, resumes: rows });
  } catch (err) {
    console.error('[saved-resumes/list]', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// GET /api/candidate/saved-resumes/:id
router.get('/saved-resumes/:id', ...guard, async (req, res) => {
  try {
    const [[row]] = await pool.execute(
      'SELECT * FROM agzit_saved_resumes WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (!row) return res.status(404).json({ ok: false, error: 'Resume not found' });
    row.resume_data = JSON.parse(row.resume_data || '{}');
    return res.json({ ok: true, resume: row });
  } catch (err) {
    console.error('[saved-resumes/get]', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// DELETE /api/candidate/saved-resumes/:id
router.delete('/saved-resumes/:id', ...guard, async (req, res) => {
  try {
    const [result] = await pool.execute(
      'DELETE FROM agzit_saved_resumes WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ ok: false, error: 'Resume not found' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[saved-resumes/delete]', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/candidate/profile-photo — Upload profile photo ────────────────
router.post('/profile-photo', ...guard, (req, res, next) => {
  photoUpload.single('photo')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Image must be under 2 MB' : err.message;
      return res.status(400).json({ ok: false, error: msg });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'No image uploaded' });

    const userId = req.user.id;
    const photoUrl = `/uploads/profile-photos/${req.file.filename}`;

    // Find wp_user_id
    const [[user]] = await pool.execute(
      'SELECT wp_user_id FROM agzit_users WHERE id = ?', [userId]
    );
    if (!user?.wp_user_id) return res.status(400).json({ ok: false, error: 'No linked WP account' });

    // Find DPR post
    const [[post]] = await pool.execute(
      `SELECT p.ID FROM wp_posts p
       JOIN wp_postmeta pm ON pm.post_id = p.ID AND pm.meta_key = 'candidate_user_id'
       WHERE p.post_type = 'dpr_profile' AND p.post_status = 'publish'
         AND pm.meta_value = ?
       LIMIT 1`,
      [String(user.wp_user_id)]
    );
    if (!post) return res.status(404).json({ ok: false, error: 'DPR profile not found' });

    // Read old photo URL before upsert (for cleanup)
    const [[existing]] = await pool.execute(
      'SELECT meta_id, meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key = ?',
      [post.ID, 'profile_photo_url']
    );
    const oldPhotoUrl = existing?.meta_value;

    // Upsert profile_photo_url in wp_postmeta
    if (existing) {
      await pool.execute(
        'UPDATE wp_postmeta SET meta_value = ? WHERE post_id = ? AND meta_key = ?',
        [photoUrl, post.ID, 'profile_photo_url']
      );
    } else {
      await pool.execute(
        'INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
        [post.ID, 'profile_photo_url', photoUrl]
      );
    }

    // Delete old photo file if different
    if (oldPhotoUrl && oldPhotoUrl !== photoUrl) {
      try {
        const oldPath = path.join(__dirname, '..', 'public', oldPhotoUrl);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      } catch (_) { /* ignore cleanup errors */ }
    }

    return res.json({ ok: true, profile_photo_url: photoUrl });
  } catch (err) {
    console.error('[profile-photo]', err.message);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
