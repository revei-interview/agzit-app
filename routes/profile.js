// routes/profile.js — Public candidate profile API
// GET /api/profile?dpr_id= — No auth required
// Finds dpr_profile post by ACF dpr_id field, returns all public profile data.
// Increments dpr_id_view_count. Only returns published, non-private profiles.

const { Router } = require('express');
const router = Router();
const pool   = require('../config/db');

// ── Helpers ──────────────────────────────────────────────────────────────────

async function findPost(dprId) {
  const [[post]] = await pool.execute(
    `SELECT p.ID, p.post_status
     FROM wp_posts p
     INNER JOIN wp_postmeta pm
       ON pm.post_id = p.ID AND pm.meta_key = 'dpr_id' AND pm.meta_value = ?
     WHERE p.post_type = 'dpr_profile'
     LIMIT 1`,
    [dprId]
  );
  return post || null;
}

async function fetchPostMeta(postId) {
  const [rows] = await pool.execute(
    "SELECT meta_key, meta_value FROM wp_postmeta WHERE post_id = ? AND LEFT(meta_key, 1) != '_'",
    [postId]
  );
  const meta = {};
  for (const r of rows) meta[r.meta_key] = r.meta_value;
  return meta;
}

function parseRepeater(meta, field, subfields) {
  const count = parseInt(meta[field]) || 0;
  const rows  = [];
  for (let i = 0; i < count; i++) {
    const row = {};
    for (const sf of subfields) row[sf] = meta[`${field}_${i}_${sf}`] ?? null;
    rows.push(row);
  }
  return rows;
}

// Parse PHP serialized string into array of string values (for ACF multi-select)
// e.g. 'a:2:{i:0;s:7:"kyc_aml";i:1;s:12:"transactions";}' → ['kyc_aml','transactions']
function parsePhpArray(raw) {
  const s = String(raw || '');
  if (!s.startsWith('a:')) return s ? [s] : [];
  const matches = [...s.matchAll(/s:\d+:"([^"]*)";/g)];
  return matches.map(m => m[1]);
}

async function getAttachmentUrl(attachId) {
  if (!attachId || isNaN(attachId)) return null;
  const [[post]] = await pool.execute(
    'SELECT guid FROM wp_posts WHERE ID = ? AND post_type = "attachment" LIMIT 1',
    [parseInt(attachId)]
  );
  return post?.guid || null;
}

async function incrementViewCount(postId, current) {
  try {
    const [[row]] = await pool.execute(
      "SELECT meta_id FROM wp_postmeta WHERE post_id = ? AND meta_key = 'dpr_id_view_count' LIMIT 1",
      [postId]
    );
    if (row) {
      await pool.execute('UPDATE wp_postmeta SET meta_value = ? WHERE meta_id = ?',
        [String(current + 1), row.meta_id]);
    } else {
      await pool.execute('INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
        [postId, 'dpr_id_view_count', String(current + 1)]);
    }
  } catch (_) {}
}

// ── GET / ─────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const dprId = (req.query.dpr_id || '').trim();
    if (!dprId) return res.status(400).json({ ok: false, error: 'dpr_id required' });

    const post = await findPost(dprId);
    if (!post)                         return res.status(404).json({ ok: false, error: 'Profile not found' });
    if (post.post_status !== 'publish') return res.status(404).json({ ok: false, error: 'Profile not published' });

    const meta = await fetchPostMeta(post.ID);

    const profileVis = (meta.profile_visibility || 'public').trim();
    if (profileVis === 'private') return res.status(404).json({ ok: false, error: 'Profile is private' });

    // Increment view count (fire-and-forget)
    const currentViews = parseInt(meta.dpr_id_view_count) || 0;
    incrementViewCount(post.ID, currentViews);

    // Repeaters
    const workExperience = parseRepeater(meta, 'work_experience', [
      'job_title', 'company_name', 'office_country', 'office_city',
      'start_date', 'end_date', 'Currently_working', 'key_responsibilities', 'employment_type',
    ]);
    const education = parseRepeater(meta, 'education', [
      'degree', 'institution_name', 'edu_country', 'edu_city', 'edu_start_date', 'edu_end_date',
    ]);
    const certifications = parseRepeater(meta, 'certifications', [
      'certification_name', 'credential_id', 'issuing_organization',
      'cert_issue_date', 'cert_expiry_date',
      // certificate_pdf intentionally excluded from public API
    ]);
    const complianceTools     = parseRepeater(meta, 'compliance_tools',     ['tool_name']);
    const languageProficiency = parseRepeater(meta, 'language_proficiency', ['language']);

    // Mock interview performance — last 3 completed + scored, band only (no raw score on public page)
    const allSessions = parseRepeater(meta, 'mock_interview_sessions', [
      'session_id', 'started_at', 'interview_role', 'interview_status',
      'mock_overall_score', 'mock_performance_level',
    ]);
    const mockSessions = [...allSessions]
      .filter(s => s.interview_status === 'completed' && parseInt(s.mock_overall_score) > 0)
      .reverse()  // newest first
      .slice(0, 3)
      .map(s => ({
        interview_role:         s.interview_role,
        started_at:             s.started_at,
        mock_performance_level: s.mock_performance_level,
        // mock_overall_score intentionally excluded from public view
      }));

    // Resume URL — only if re_public
    let resumeUrl = null;
    const resumeVis = (meta.resume_visibility || '').trim();
    if (resumeVis === 're_public') {
      const raw = String(meta.resume_upload || '');
      if (/^\d+$/.test(raw)) resumeUrl = await getAttachmentUrl(parseInt(raw));
    }

    // Compliance domains — ACF multi-select stored as PHP serialized array
    const domains = parsePhpArray(meta.compliance_domains);

    res.json({
      ok: true,
      profile: {
        // Identity
        dpr_id:                    meta.dpr_id,
        full_name:                 meta.full_name,
        public_name_mode:          meta.public_name_mode,
        desired_role:              meta.desired_role,
        issue_date:                meta.issue_date,
        dpr_id_view_count:         currentViews + 1,

        // Location
        residential_city:          meta.residential_city,
        residential_state:         meta.residential_state,
        residential_country:       meta.residential_country,
        country_of_nationality:    meta.country_of_nationality,

        // Social
        linkedin_url:              meta.linkedin_url,

        // Professional
        professional_summary_bio:  meta.professional_summary_bio,
        total_work_experience:     meta.total_work_experience,
        current_employment_status: meta.current_employment_status,
        notice_period_in_days:     meta.notice_period_in_days,
        open_to_relocate:          meta.open_to_relocate,
        open_for_work_badge:       meta.open_for_work_badge,
        current_career_level:      meta.current_career_level,
        compliance_domains:        domains,
        soft_skills:               meta.soft_skills,

        // Repeaters
        work_experience:      workExperience,
        education:            education,
        certifications:       certifications,
        compliance_tools:     complianceTools,
        language_proficiency: languageProficiency,

        // AI Performance (public — band badge only, no raw score)
        mock_sessions:        mockSessions,

        // Resume (public only)
        resume_url:           resumeUrl,
        resume_visibility:    resumeVis,
      },
    });
  } catch (err) {
    console.error('[profile]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
