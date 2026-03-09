// jobs/session-cleanup.js — Session auto-complete cron
// Runs every 60 seconds. Finds mock_interview_sessions rows that are still
// 'in_progress' but whose time has elapsed (started_at + duration_minutes + 2 min).
// Marks them 'completed' and clears the user-level session lock.

const pool = require('../config/db');

const INTERVAL_MS   = 60 * 1000;   // 60 seconds
const GRACE_SECONDS = 2 * 60;       // 2-minute grace period after duration

async function runCleanup() {
  try {
    // 1. Find all postmeta rows with interview_status = 'in_progress'
    //    Key pattern: mock_interview_sessions_{N}_interview_status
    const [statusRows] = await pool.execute(
      `SELECT post_id, meta_key, meta_value
       FROM wp_postmeta
       WHERE meta_key LIKE 'mock_interview_sessions_%_interview_status'
         AND meta_value = 'in_progress'`
    );

    if (!statusRows.length) return;

    for (const row of statusRows) {
      const { post_id: postId, meta_key: statusKey } = row;

      // Parse row index from key: mock_interview_sessions_{rowIdx}_interview_status
      const match = statusKey.match(/^mock_interview_sessions_(\d+)_interview_status$/);
      if (!match) continue;
      const rowIdx = match[1]; // e.g. "0", "1", "2"

      // 2. Fetch started_at and duration_minutes for this specific row
      const startedKey   = `mock_interview_sessions_${rowIdx}_started_at`;
      const durationKey  = `mock_interview_sessions_${rowIdx}_duration_minutes`;
      const sidKey       = `mock_interview_sessions_${rowIdx}_session_id`;

      const [metaRows] = await pool.execute(
        `SELECT meta_key, meta_value FROM wp_postmeta
         WHERE post_id = ? AND meta_key IN (?, ?, ?)`,
        [postId, startedKey, durationKey, sidKey]
      );

      const meta = {};
      for (const m of metaRows) meta[m.meta_key] = m.meta_value;

      const startedAt       = meta[startedKey] || '';
      const durationMinutes = parseInt(meta[durationKey] || '20', 10) || 20;
      const sid             = meta[sidKey] || '';

      if (!startedAt) continue;

      // started_at is stored as 'YYYY-MM-DD HH:MM:SS' in WP local time
      const startedTs  = Math.floor(new Date(startedAt.replace(' ', 'T')).getTime() / 1000);
      if (isNaN(startedTs)) continue;

      const nowTs      = Math.floor(Date.now() / 1000);
      const expiresAt  = startedTs + (durationMinutes * 60) + GRACE_SECONDS;

      if (nowTs < expiresAt) continue; // not expired yet

      // 3. Mark session completed
      const [[existingStatus]] = await pool.execute(
        'SELECT meta_id FROM wp_postmeta WHERE post_id = ? AND meta_key = ? LIMIT 1',
        [postId, statusKey]
      );
      if (existingStatus) {
        await pool.execute(
          'UPDATE wp_postmeta SET meta_value = ? WHERE meta_id = ?',
          ['completed', existingStatus.meta_id]
        );
      }

      // 4. Find the WP user who owns this profile (via wp_posts.post_author)
      const [[postRow]] = await pool.execute(
        'SELECT post_author FROM wp_posts WHERE ID = ? LIMIT 1',
        [postId]
      );
      if (postRow?.post_author) {
        const wpUserId = postRow.post_author;
        // Clear session lock meta
        await pool.execute(
          `UPDATE wp_usermeta SET meta_value = ''
           WHERE user_id = ? AND meta_key IN ('mock_session_lock_until', 'mock_session_lock_id')`,
          [wpUserId]
        );
      }

      console.log(`[session-cleanup] Auto-completed stale session post_id=${postId} sid=${sid || '(unknown)'}`);
    }
  } catch (err) {
    console.error('[session-cleanup] Error during cleanup run:', err.message);
  }
}

// Start the interval immediately on require
setInterval(runCleanup, INTERVAL_MS);
console.log('[session-cleanup] Auto-complete cron started (60s interval)');
