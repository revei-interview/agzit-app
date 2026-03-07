// routes/internal.js — Internal REST endpoints replacing WP REST API for daily backend
// Called by agzit-daily-backend.onrender.com (not browsers)
// Auth: x-wp-app-token header (timing-safe compare against WP_APP_TOKEN env var)
// All ACF field names sourced from WordPress snippet files.

const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');
const crypto  = require('crypto');

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAppToken(req, res, next) {
  const token  = req.headers['x-wp-app-token'];
  const secret = process.env.WP_APP_TOKEN;
  if (!token || !secret) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  try {
    const a = Buffer.from(token);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
  } catch {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Validate SID format (matches WP generation: MIS- + 8 uppercase alphanumeric chars)
function isValidSid(sid) {
  return typeof sid === 'string' && /^MIS-[A-Z0-9]{6,}$/.test(sid);
}

// Find which dpr_profile post and ACF repeater row index contains a given SID.
// Returns { profileId, rowIndex } or null.
async function findSessionBySid(sid) {
  const [rows] = await pool.execute(
    "SELECT post_id, meta_key FROM wp_postmeta WHERE meta_value = ? AND meta_key LIKE 'mock_interview_sessions_%_session_id' LIMIT 1",
    [sid]
  );
  if (!rows.length) return null;
  const { post_id, meta_key } = rows[0];
  // meta_key pattern: mock_interview_sessions_{N}_session_id
  const match = meta_key.match(/^mock_interview_sessions_(\d+)_session_id$/);
  if (!match) return null;
  return { profileId: post_id, rowIndex: parseInt(match[1], 10) };
}

// Get specific postmeta values by key list for a single post
async function getPostMetaValues(postId, keys) {
  if (!keys.length) return {};
  const ph = keys.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT meta_key, meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key IN (${ph})`,
    [postId, ...keys]
  );
  const out = {};
  for (const r of rows) out[r.meta_key] = r.meta_value;
  return out;
}

// Get all subfields for a specific ACF repeater row (excludes ACF field-key rows starting with _)
async function getSessionRow(profileId, rowIndex) {
  const prefix = `mock_interview_sessions_${rowIndex}_`;
  const [rows] = await pool.execute(
    "SELECT meta_key, meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key LIKE ? AND meta_key NOT LIKE '\\_mock%'",
    [profileId, `${prefix}%`]
  );
  const out = {};
  for (const r of rows) {
    const subfield = r.meta_key.slice(prefix.length);
    // Skip ACF internal field-key entries (start with underscore after prefix)
    if (!subfield.startsWith('_')) out[subfield] = r.meta_value;
  }
  return out;
}

// Upsert a single wp_postmeta row (UPDATE existing or INSERT new)
async function upsertPostMeta(postId, metaKey, metaValue) {
  const [[existing]] = await pool.execute(
    'SELECT meta_id FROM wp_postmeta WHERE post_id = ? AND meta_key = ? LIMIT 1',
    [postId, metaKey]
  );
  if (existing) {
    await pool.execute(
      'UPDATE wp_postmeta SET meta_value = ? WHERE meta_id = ?',
      [String(metaValue ?? ''), existing.meta_id]
    );
  } else {
    await pool.execute(
      'INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
      [postId, metaKey, String(metaValue ?? '')]
    );
  }
}

// Upsert a single wp_usermeta row
async function upsertUserMeta(wpUserId, metaKey, metaValue) {
  const [[existing]] = await pool.execute(
    'SELECT umeta_id FROM wp_usermeta WHERE user_id = ? AND meta_key = ? LIMIT 1',
    [wpUserId, metaKey]
  );
  if (existing) {
    await pool.execute(
      'UPDATE wp_usermeta SET meta_value = ? WHERE umeta_id = ?',
      [String(metaValue ?? ''), existing.umeta_id]
    );
  } else {
    await pool.execute(
      'INSERT INTO wp_usermeta (user_id, meta_key, meta_value) VALUES (?, ?, ?)',
      [wpUserId, metaKey, String(metaValue ?? '')]
    );
  }
}

// Get the WP user ID (post_author) for a dpr_profile post
async function getPostAuthor(postId) {
  const [[post]] = await pool.execute(
    'SELECT post_author FROM wp_posts WHERE ID = ? LIMIT 1',
    [postId]
  );
  return post?.post_author || null;
}

// ── GET /api/internal/vapi-variables?sid=... ──────────────────────────────────
// Replaces: WP /wp-json/dpr/v1/vapi-variables
// Called by: agzit-daily-backend /vapi/context
// Returns: variableValues (5 keys: sid, candidate_name, interview_role,
//          target_career_level, context_pack) + session_minutes + profile_post_id

router.get('/vapi-variables', requireAppToken, async (req, res) => {
  try {
    const { sid } = req.query;
    if (!isValidSid(sid)) {
      return res.status(400).json({ ok: false, error: 'Invalid or missing sid' });
    }

    const found = await findSessionBySid(sid);
    if (!found) {
      return res.status(404).json({ ok: false, error: 'Session not found', sid });
    }

    const { profileId, rowIndex } = found;

    // Fetch profile-level fields and session row in parallel
    const [profileMeta, sessionRow] = await Promise.all([
      getPostMetaValues(profileId, ['full_name', 'current_career_level', 'work_level']),
      getSessionRow(profileId, rowIndex),
    ]);

    const candidateName   = profileMeta.full_name || '';
    const interviewRole   = sessionRow.interview_role || '';

    // target_career_level fallback chain (mirrors wordpress-rest-endpoint-v2)
    const careerLevel = sessionRow.target_career_level
      || profileMeta.current_career_level
      || profileMeta.work_level
      || 'mid';

    const contextPack = sessionRow.context_pack || '';

    if (!contextPack) {
      return res.status(400).json({ ok: false, error: 'context_pack missing from session row', sid });
    }

    const sessionMinutesRaw = parseInt(sessionRow.duration_minutes) || 0;
    const sessionMinutes    = [20, 30].includes(sessionMinutesRaw) ? sessionMinutesRaw : 20;

    res.json({
      ok:              true,
      sid,
      profile_post_id: profileId,
      session_minutes: sessionMinutes,
      variableValues: {
        sid,
        candidate_name:      candidateName,
        interview_role:      interviewRole,
        target_career_level: careerLevel,
        context_pack:        contextPack,
      },
    });
  } catch (err) {
    console.error('[internal/vapi-variables]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/internal/mock-session-start ─────────────────────────────────────
// Replaces: WP /wp-json/dpr/v1/mock-session-start
// Called by: agzit-daily-backend /vapi/context (fire-and-forget)
// Accepts: sid, profile_post_id, session_type, interview_role,
//          target_career_level, context_pack, duration_minutes,
//          share_token, share_expires_at, jd_raw_text, started_at

router.post('/mock-session-start', requireAppToken, async (req, res) => {
  try {
    const {
      sid,
      profile_post_id,
      session_type        = 'voice_video',
      interview_role      = '',
      target_career_level = '',
      context_pack        = '',
      duration_minutes    = 20,
      share_token         = '',
      share_expires_at    = '',
      jd_raw_text         = '',
      started_at,
    } = req.body;

    if (!isValidSid(sid)) {
      return res.status(400).json({ ok: false, error: 'Invalid or missing sid' });
    }

    // Check if session row already exists
    const found = await findSessionBySid(sid);

    if (found) {
      // Row exists — update mutable fields (do NOT overwrite duration_minutes or started_at if already set)
      const { profileId, rowIndex } = found;
      const prefix  = `mock_interview_sessions_${rowIndex}_`;
      const updates = {
        interview_status:    'in_progress',
        session_type,
        interview_role,
        target_career_level,
        context_pack,
        jd_raw_text,
        share_token,
        share_expires_at,
      };
      if (started_at) updates.started_at = started_at;

      await Promise.all(
        Object.entries(updates).map(([k, v]) => upsertPostMeta(profileId, `${prefix}${k}`, v))
      );
      return res.json({ ok: true, action: 'updated', sid, profile_post_id: profileId, row_index: rowIndex });
    }

    // Row doesn't exist — need profile_post_id to create it
    if (!profile_post_id) {
      return res.status(400).json({ ok: false, error: 'Session row not found and profile_post_id not provided' });
    }
    const profileId = parseInt(profile_post_id, 10);
    if (!profileId) {
      return res.status(400).json({ ok: false, error: 'Invalid profile_post_id' });
    }

    // Get current repeater row count (ACF stores count as the repeater field itself)
    const [[countRow]] = await pool.execute(
      "SELECT meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key = 'mock_interview_sessions' LIMIT 1",
      [profileId]
    );
    const currentCount = parseInt(countRow?.meta_value) || 0;
    const rowIndex     = currentCount;
    const prefix       = `mock_interview_sessions_${rowIndex}_`;
    const now          = started_at || new Date().toISOString().replace('T', ' ').slice(0, 19);

    // All 29 subfields initialized (scorecard fields start empty)
    const subfields = {
      session_id:               sid,
      started_at:               now,
      session_type,
      interview_role,
      target_career_level,
      interview_status:         'in_progress',
      duration_minutes:         String(duration_minutes),
      context_pack,
      jd_raw_text,
      share_token,
      share_expires_at,
      audio_url:                '',
      video_url:                '',
      recording_id:             '',
      transcript:               '',
      score_communication:      '',
      score_structure:          '',
      score_role_knowledge:     '',
      score_domain_application: '',
      score_problem_solving:    '',
      score_confidence:         '',
      score_question_handling:  '',
      score_experience_relevance: '',
      score_resume_alignment:   '',
      mock_overall_score:       '',
      mock_performance_level:   '',
      mock_strengths:           '',
      mock_improvements:        '',
      mock_next_focus:          '',
      mock_attention_areas:     '',
    };

    // Insert all subfields + update repeater count atomically
    await Promise.all([
      ...Object.entries(subfields).map(([k, v]) =>
        pool.execute(
          'INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
          [profileId, `${prefix}${k}`, v]
        )
      ),
      upsertPostMeta(profileId, 'mock_interview_sessions', String(currentCount + 1)),
    ]);

    res.json({ ok: true, action: 'created', sid, profile_post_id: profileId, row_index: rowIndex });
  } catch (err) {
    console.error('[internal/mock-session-start]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/internal/save-interview-artifacts ───────────────────────────────
// Replaces: WP /wp-json/dpr/v1/save-interview-artifacts
// Called by: agzit-daily-backend webhook handler after Vapi call ends
// Saves audio_url, video_url, recording_id, marks session completed, clears lock

router.post('/save-interview-artifacts', requireAppToken, async (req, res) => {
  try {
    const {
      sid,
      audio_url    = '',
      video_url    = '',
      recording_id = '',
    } = req.body;

    if (!isValidSid(sid)) {
      return res.status(400).json({ ok: false, error: 'Invalid or missing sid' });
    }

    const found = await findSessionBySid(sid);
    if (!found) {
      return res.status(404).json({ ok: false, error: 'Session not found', sid });
    }

    const { profileId, rowIndex } = found;
    const prefix = `mock_interview_sessions_${rowIndex}_`;

    const updates = {
      interview_status: 'completed',
      audio_url:        audio_url    || '',
      video_url:        video_url    || '',
      recording_id:     recording_id || '',
    };

    await Promise.all(
      Object.entries(updates).map(([k, v]) => upsertPostMeta(profileId, `${prefix}${k}`, v))
    );

    // Clear session lock on the WP user who owns this profile
    const wpUserId = await getPostAuthor(profileId);
    if (wpUserId) {
      await Promise.all([
        upsertUserMeta(wpUserId, 'mock_session_lock_until', '0'),
        upsertUserMeta(wpUserId, 'mock_session_lock_id',    ''),
      ]);
    }

    // Write debug meta to profile post (mirrors WP save-artifacts behaviour)
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await Promise.all([
      upsertPostMeta(profileId, 'vapi_last_saved_sid',      sid),
      upsertPostMeta(profileId, 'vapi_last_call_id',        recording_id),
      upsertPostMeta(profileId, 'vapi_last_recording_url',  audio_url),
      upsertPostMeta(profileId, 'vapi_last_video_url',      video_url),
      upsertPostMeta(profileId, 'vapi_last_saved_at',       now),
    ]);

    res.json({ ok: true, saved: true, sid, profile_post_id: profileId, row_index: rowIndex });
  } catch (err) {
    console.error('[internal/save-interview-artifacts]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/internal/save-scorecard ─────────────────────────────────────────
// Replaces: WP /wp-json/dpr/v1/save-scorecard
// Called by: agzit-daily-backend generateScorecard() after OpenAI returns scores
// Body: { sid, scorecard: { 9 scores + mock_overall_score + mock_performance_level + 4 text fields } }

router.post('/save-scorecard', requireAppToken, async (req, res) => {
  try {
    const { sid, scorecard } = req.body;

    if (!isValidSid(sid)) {
      return res.status(400).json({ ok: false, error: 'Invalid or missing sid' });
    }
    if (!scorecard || typeof scorecard !== 'object') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid scorecard object' });
    }

    const found = await findSessionBySid(sid);
    if (!found) {
      return res.status(404).json({ ok: false, error: 'Session not found', sid });
    }

    const { profileId, rowIndex } = found;
    const prefix = `mock_interview_sessions_${rowIndex}_`;

    // Allowed scorecard fields — exactly 15 (matches ACF subfield definitions)
    const SCORECARD_FIELDS = [
      'score_communication', 'score_structure', 'score_role_knowledge',
      'score_domain_application', 'score_problem_solving', 'score_confidence',
      'score_question_handling', 'score_experience_relevance', 'score_resume_alignment',
      'mock_overall_score', 'mock_performance_level',
      'mock_strengths', 'mock_improvements', 'mock_next_focus', 'mock_attention_areas',
    ];

    const writeable = SCORECARD_FIELDS.filter(f => scorecard[f] !== undefined && scorecard[f] !== null);
    if (!writeable.length) {
      return res.status(400).json({ ok: false, error: 'No valid scorecard fields provided' });
    }

    // Use direct update_post_meta pattern (avoids ACF repeater rewrite race — mirrors WP snippet)
    await Promise.all(
      writeable.map(f => upsertPostMeta(profileId, `${prefix}${f}`, scorecard[f]))
    );

    res.json({ ok: true, saved: true, sid, fields_written: writeable.length });
  } catch (err) {
    console.error('[internal/save-scorecard]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/internal/employer-interview-room/:token ─────────────────────────
// Called by: agzit-daily-backend /vapi/employer-context?token=
// Returns variableValues for employer-scheduled interview; generates SID if first call.

router.get('/employer-interview-room/:token', requireAppToken, async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) return res.status(400).json({ ok: false, error: 'Missing token' });

    const [[row]] = await pool.execute(
      `SELECT p.ID FROM wp_posts p
       INNER JOIN wp_postmeta pm ON pm.post_id = p.ID
         AND pm.meta_key = 'join_token' AND pm.meta_value = ?
       WHERE p.post_type = 'employer_interview' AND p.post_status = 'publish'
       LIMIT 1`,
      [token]
    );
    if (!row) return res.status(404).json({ ok: false, error: 'Session not found' });
    const postId = row.ID;

    const keys = [
      'candidate_name', 'total_work_experience', 'interview_role',
      'session_type', 'jd_raw_text', 'resume_text', 'resume_file',
      'session_id', 'interview_status',
    ];
    const ph = keys.map(() => '?').join(',');
    const [mRows] = await pool.execute(
      `SELECT meta_key, meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key IN (${ph})`,
      [postId, ...keys]
    );
    const m = {};
    for (const r of mRows) m[r.meta_key] = r.meta_value;

    if (m.interview_status === 'cancelled') {
      return res.status(410).json({ ok: false, error: 'Interview cancelled', status: 'cancelled' });
    }

    // Generate SID if not set; update status to started
    let sid = m.session_id || '';
    if (!sid) {
      sid = 'MIS-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
    }
    await Promise.all([
      upsertPostMeta(postId, 'session_id',       sid),
      upsertPostMeta(postId, 'interview_status', 'started'),
    ]);

    function eiCareerLevel(years) {
      const y = parseInt(years) || 0;
      if (y <= 2)  return 'Junior';
      if (y <= 5)  return 'Mid-Level';
      if (y <= 8)  return 'Senior';
      if (y <= 12) return 'Principal';
      return 'Executive';
    }

    function eiContextPack(meta) {
      const parts = [];
      if (meta.candidate_name) parts.push('CANDIDATE: ' + meta.candidate_name);
      if (meta.interview_role) parts.push('ROLE: ' + meta.interview_role);
      if (meta.jd_raw_text)    parts.push('JOB DESCRIPTION:\n' + String(meta.jd_raw_text).slice(0, 80000));
      if (meta.resume_text)    parts.push('RESUME:\n' + String(meta.resume_text).slice(0, 40000));
      else if (meta.resume_file) parts.push('RESUME FILE: ' + meta.resume_file);
      return parts.join('\n\n---\n\n');
    }

    const sessionMinutes = m.session_type === '30-min' ? 30 : 20;

    res.json({
      ok:              true,
      post_id:         postId,
      session_id:      sid,
      session_minutes: sessionMinutes,
      variableValues: {
        sid,
        candidate_name:      m.candidate_name || '',
        interview_role:      m.interview_role || '',
        target_career_level: eiCareerLevel(m.total_work_experience),
        context_pack:        eiContextPack(m),
      },
    });
  } catch (err) {
    console.error('[internal/employer-interview-room]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/internal/employer-interview-by-sid?sid= ─────────────────────────
// Called by: agzit-daily-backend webhook handler to detect employer interview SIDs.
// Mirrors WP: GET /wp-json/dpr/v1/find-employer-interview-by-sid

router.get('/employer-interview-by-sid', requireAppToken, async (req, res) => {
  try {
    const { sid } = req.query;
    if (!sid) return res.status(400).json({ ok: false, error: 'Missing sid' });

    const [[row]] = await pool.execute(
      `SELECT p.ID FROM wp_posts p
       INNER JOIN wp_postmeta pm ON pm.post_id = p.ID
         AND pm.meta_key = 'session_id' AND pm.meta_value = ?
       WHERE p.post_type = 'employer_interview' AND p.post_status = 'publish'
       LIMIT 1`,
      [sid]
    );
    if (!row) return res.status(404).json({ ok: false, error: 'Session not found', sid });

    res.json({ ok: true, post_id: row.ID, sid });
  } catch (err) {
    console.error('[internal/employer-interview-by-sid]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/internal/save-employer-scorecard ────────────────────────────────
// Called by: agzit-daily-backend generateScorecard() after employer interview ends.
// Mirrors WP: POST /wp-json/dpr/v1/save-scheduled-scorecard
// Body: { sid, scorecard: { 9 scores + overall + 4 text + 5 employer fields } }

router.post('/save-employer-scorecard', requireAppToken, async (req, res) => {
  try {
    const { sid, scorecard } = req.body;
    if (!sid)                                 return res.status(400).json({ ok: false, error: 'Missing sid' });
    if (!scorecard || typeof scorecard !== 'object') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid scorecard' });
    }

    const [[row]] = await pool.execute(
      `SELECT p.ID FROM wp_posts p
       INNER JOIN wp_postmeta pm ON pm.post_id = p.ID
         AND pm.meta_key = 'session_id' AND pm.meta_value = ?
       WHERE p.post_type = 'employer_interview' AND p.post_status = 'publish'
       LIMIT 1`,
      [sid]
    );
    if (!row) return res.status(404).json({ ok: false, error: 'Session not found', sid });
    const postId = row.ID;

    const SCORECARD_FIELDS = [
      'score_communication', 'score_structure', 'score_role_knowledge',
      'score_domain_application', 'score_problem_solving', 'score_confidence',
      'score_question_handling', 'score_experience_relevance', 'score_resume_alignment',
      'mock_overall_score', 'mock_performance_level',
      'mock_strengths', 'mock_improvements', 'mock_next_focus', 'mock_attention_areas',
      'emp_readiness_band', 'emp_red_flags', 'emp_role_strengths', 'emp_role_gaps', 'emp_consistency_check',
    ];

    const writeable = SCORECARD_FIELDS.filter(f => scorecard[f] !== undefined && scorecard[f] !== null);
    await Promise.all(writeable.map(f => upsertPostMeta(postId, f, scorecard[f])));

    // Merge into scorecard_json blob
    let existing = {};
    try {
      const [[existingRow]] = await pool.execute(
        "SELECT meta_value FROM wp_postmeta WHERE post_id = ? AND meta_key = 'scorecard_json' LIMIT 1",
        [postId]
      );
      if (existingRow?.meta_value) existing = JSON.parse(existingRow.meta_value);
    } catch { /* ignore invalid JSON */ }
    await upsertPostMeta(postId, 'scorecard_json', JSON.stringify({ ...existing, ...scorecard }));

    res.json({ ok: true, saved: true, sid, post_id: postId, fields_written: writeable.length });
  } catch (err) {
    console.error('[internal/save-employer-scorecard]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/internal/save-employer-recording-urls ──────────────────────────
// Called by: agzit-daily-backend webhook handler after employer Vapi call ends.
// Mirrors WP: POST /wp-json/dpr/v1/save-recording-urls
// Body: { sid, audio_url, video_url }

router.post('/save-employer-recording-urls', requireAppToken, async (req, res) => {
  try {
    const { sid, audio_url = '', video_url = '' } = req.body;
    if (!sid) return res.status(400).json({ ok: false, error: 'Missing sid' });

    const [[row]] = await pool.execute(
      `SELECT p.ID FROM wp_posts p
       INNER JOIN wp_postmeta pm ON pm.post_id = p.ID
         AND pm.meta_key = 'session_id' AND pm.meta_value = ?
       WHERE p.post_type = 'employer_interview' AND p.post_status = 'publish'
       LIMIT 1`,
      [sid]
    );
    if (!row) return res.status(404).json({ ok: false, error: 'Session not found', sid });
    const postId = row.ID;

    await Promise.all([
      upsertPostMeta(postId, 'audio_url',        audio_url || ''),
      upsertPostMeta(postId, 'video_url',        video_url || ''),
      upsertPostMeta(postId, 'interview_status', 'completed'),
    ]);

    res.json({ ok: true, saved: true, sid, post_id: postId });
  } catch (err) {
    console.error('[internal/save-employer-recording-urls]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;

