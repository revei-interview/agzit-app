// routes/employer-interviews.js — Employer Interview System
// Two access modes:
//   PUBLIC (token-based) — candidate joins room via join_token from email
//   AUTH (verified_employer) — employer manages their scheduled interviews
//
// ACF field names (from employer-interview-acf-fields.code-snippets.php).
// Fields are stored as flat wp_postmeta keys (no repeater prefix).

const express = require('express');
const router  = express.Router();
const pool    = require('../config/db');
const crypto  = require('crypto');
const { requireAuth, requireRole } = require('../middleware/auth');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findByToken(token) {
  const [[row]] = await pool.execute(
    `SELECT p.ID FROM wp_posts p
     INNER JOIN wp_postmeta pm ON pm.post_id = p.ID
       AND pm.meta_key = 'join_token' AND pm.meta_value = ?
     WHERE p.post_type = 'employer_interview' AND p.post_status = 'publish'
     LIMIT 1`,
    [token]
  );
  return row?.ID || null;
}

const EI_KEYS = [
  'candidate_name', 'candidate_email', 'total_work_experience',
  'interview_role', 'session_type', 'scheduled_at',
  'jd_raw_text', 'resume_file', 'resume_text',
  'join_token', 'join_url', 'interview_status', 'session_id',
  'scorecard_json', 'audio_url', 'video_url',
  'employer_user_id', 'employer_notes',
  'emp_readiness_band', 'emp_red_flags', 'emp_role_strengths', 'emp_role_gaps', 'emp_consistency_check',
  'mock_overall_score', 'mock_performance_level',
  'score_communication', 'score_structure', 'score_role_knowledge',
  'score_domain_application', 'score_problem_solving', 'score_confidence',
  'score_question_handling', 'score_experience_relevance', 'score_resume_alignment',
  'mock_strengths', 'mock_improvements', 'mock_next_focus', 'mock_attention_areas',
];

async function fetchMeta(postId, keys = EI_KEYS) {
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

async function upsertMeta(postId, key, value) {
  const [[existing]] = await pool.execute(
    'SELECT meta_id FROM wp_postmeta WHERE post_id = ? AND meta_key = ? LIMIT 1',
    [postId, key]
  );
  if (existing) {
    await pool.execute(
      'UPDATE wp_postmeta SET meta_value = ? WHERE meta_id = ?',
      [String(value ?? ''), existing.meta_id]
    );
  } else {
    await pool.execute(
      'INSERT INTO wp_postmeta (post_id, meta_key, meta_value) VALUES (?, ?, ?)',
      [postId, key, String(value ?? '')]
    );
  }
}

function careerLevelFromExp(years) {
  const y = parseInt(years) || 0;
  if (y <= 2)  return 'Junior';
  if (y <= 5)  return 'Mid-Level';
  if (y <= 8)  return 'Senior';
  if (y <= 12) return 'Principal';
  return 'Executive';
}

function buildContextPack(m) {
  const parts = [];
  if (m.candidate_name)  parts.push('CANDIDATE: ' + m.candidate_name);
  if (m.interview_role)  parts.push('ROLE: ' + m.interview_role);
  if (m.jd_raw_text)     parts.push('JOB DESCRIPTION:\n' + String(m.jd_raw_text).slice(0, 80000));
  if (m.resume_text)     parts.push('RESUME:\n' + String(m.resume_text).slice(0, 40000));
  else if (m.resume_file) parts.push('RESUME FILE: ' + m.resume_file);
  return parts.join('\n\n---\n\n');
}

// ── GET /api/employer-interview/room?token= ───────────────────────────────────
// PUBLIC — candidate fetches session info + variableValues for Vapi call.
// Generates SID on first call (idempotent thereafter).

router.get('/room', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    if (!token || token.length < 10) {
      return res.status(400).json({ ok: false, error: 'Invalid or missing token' });
    }

    const postId = await findByToken(token);
    if (!postId) {
      return res.status(404).json({ ok: false, error: 'Session not found' });
    }

    const m = await fetchMeta(postId);

    if (m.interview_status === 'cancelled') {
      return res.status(410).json({ ok: false, error: 'Interview has been cancelled', status: 'cancelled' });
    }
    if (m.interview_status === 'completed') {
      return res.status(409).json({ ok: false, error: 'Interview already completed', status: 'completed' });
    }

    // Generate SID if not yet set (first visit)
    let sid = m.session_id || '';
    if (!sid) {
      sid = 'MIS-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
      await upsertMeta(postId, 'session_id', sid);
    }

    const contextPack = buildContextPack(m);
    if (!contextPack) {
      return res.status(400).json({ ok: false, error: 'Interview context not ready — resume or JD missing' });
    }

    const sessionMinutes = m.session_type === '30-min' ? 30 : 20;

    res.json({
      ok:              true,
      post_id:         postId,
      session_id:      sid,
      session_minutes: sessionMinutes,
      interview_role:  m.interview_role  || '',
      candidate_name:  m.candidate_name  || '',
      variableValues: {
        sid,
        candidate_name:      m.candidate_name      || '',
        interview_role:      m.interview_role      || '',
        target_career_level: careerLevelFromExp(m.total_work_experience),
        context_pack:        contextPack,
      },
    });
  } catch (err) {
    console.error('[employer-interview/room]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/employer-interview/status ───────────────────────────────────────
// PUBLIC (token-based) — candidate updates interview status from the room page.
// Body: { token, status: 'started' | 'completed' }

router.post('/status', async (req, res) => {
  try {
    const token  = String(req.body.token  || '').trim();
    const status = String(req.body.status || '').trim();

    if (!token) return res.status(400).json({ ok: false, error: 'Missing token' });
    if (!['started', 'completed'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'status must be started or completed' });
    }

    const postId = await findByToken(token);
    if (!postId) return res.status(404).json({ ok: false, error: 'Session not found' });

    await upsertMeta(postId, 'interview_status', status);
    res.json({ ok: true, post_id: postId, status });
  } catch (err) {
    console.error('[employer-interview/status]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── GET /api/employer-interview/:id ───────────────────────────────────────────
// verified_employer auth — Full interview detail + parsed scorecard.

router.get('/:id', requireAuth, requireRole('dpr_employer', 'verified_employer'), async (req, res) => {
  try {
    const postId = parseInt(req.params.id, 10);
    if (!postId) return res.status(400).json({ ok: false, error: 'Invalid id' });

    // Ownership check — one query via JOIN
    const [[post]] = await pool.execute(
      `SELECT p.ID FROM wp_posts p
       INNER JOIN wp_postmeta pm ON pm.post_id = p.ID
         AND pm.meta_key = 'employer_user_id' AND pm.meta_value = ?
       WHERE p.ID = ? AND p.post_type = 'employer_interview' AND p.post_status = 'publish'
       LIMIT 1`,
      [String(req.user.wpUserId), postId]
    );
    if (!post) return res.status(404).json({ ok: false, error: 'Not found or access denied' });

    const m = await fetchMeta(postId);

    let scorecard = null;
    if (m.scorecard_json) {
      try { scorecard = JSON.parse(m.scorecard_json); } catch { /* invalid JSON — return null */ }
    }

    res.json({ ok: true, post_id: postId, meta: m, scorecard });
  } catch (err) {
    console.error('[employer-interview/detail]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ── POST /api/employer-interview/:id/reschedule ───────────────────────────────
// verified_employer auth — Update scheduled_at (only when status=scheduled).
// Body: { scheduled_at: 'YYYY-MM-DD HH:MM:SS' }

router.post('/:id/reschedule', requireAuth, requireRole('dpr_employer', 'verified_employer'), async (req, res) => {
  try {
    const postId      = parseInt(req.params.id, 10);
    const scheduledAt = String(req.body.scheduled_at || '').trim();

    if (!postId)      return res.status(400).json({ ok: false, error: 'Invalid id' });
    if (!scheduledAt) return res.status(400).json({ ok: false, error: 'Missing scheduled_at' });

    // Ownership + status check in one query
    const [[row]] = await pool.execute(
      `SELECT p.ID,
              MAX(CASE WHEN pm.meta_key = 'employer_user_id' THEN pm.meta_value END) AS uid,
              MAX(CASE WHEN pm.meta_key = 'interview_status' THEN pm.meta_value END) AS status
       FROM wp_posts p
       INNER JOIN wp_postmeta pm ON pm.post_id = p.ID
         AND pm.meta_key IN ('employer_user_id', 'interview_status')
       WHERE p.ID = ? AND p.post_type = 'employer_interview' AND p.post_status = 'publish'
       GROUP BY p.ID LIMIT 1`,
      [postId]
    );
    if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
    if (parseInt(row.uid) !== req.user.wpUserId) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    if (row.status !== 'scheduled') {
      return res.status(409).json({ ok: false, error: 'Can only reschedule when status=scheduled' });
    }

    await upsertMeta(postId, 'scheduled_at', scheduledAt);
    res.json({ ok: true, post_id: postId, scheduled_at: scheduledAt });
  } catch (err) {
    console.error('[employer-interview/reschedule]', err);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
