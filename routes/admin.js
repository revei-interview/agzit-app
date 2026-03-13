const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { requireAuth } = require('../middleware/auth');

// MIDDLEWARE: Check super admin access
const isSuperAdmin = async (req, res, next) => {
  try {
    const userId = req.user.user_id || req.user.id;
    const [[user]] = await pool.execute(
      'SELECT is_super_admin FROM wp_users WHERE ID = ?',
      [userId]
    );

    if (!user || !user.is_super_admin) {
      return res.status(403).json({ error: 'Access denied' });
    }

    req.adminId = userId;
    next();
  } catch (error) {
    res.status(500).json({ error: 'Auth error' });
  }
};

const guard = [requireAuth, isSuperAdmin];

// LOG ADMIN ACTION
const logAdminAction = async (adminId, action, targetUserId, targetType, oldValue, newValue) => {
  try {
    await pool.execute(
      `INSERT INTO agzit_super_admin_logs (admin_id, action, target_user_id, target_type, old_value, new_value, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [adminId, action, targetUserId, targetType, JSON.stringify(oldValue), JSON.stringify(newValue)]
    );
  } catch (error) {
    console.error('Log error:', error);
  }
};

// ==========================================
// 1. DASHBOARD OVERVIEW
// ==========================================

router.get('/overview', ...guard, async (req, res) => {
  try {
    const [[userStats]] = await pool.execute(`
      SELECT
        COUNT(*) as total_users,
        COUNT(CASE WHEN is_super_admin = 0 OR is_super_admin IS NULL THEN 1 END) as candidates,
        COUNT(CASE WHEN is_super_admin = 1 THEN 1 END) as admins
      FROM wp_users
    `);

    const [[interviewStats]] = await pool.execute(`
      SELECT
        COUNT(*) as total_interviews,
        COUNT(DISTINCT post_author) as candidates_with_interviews
      FROM wp_posts WHERE post_type = 'employer_interview' AND post_status = 'publish'
    `);

    const [[creditStats]] = await pool.execute(`
      SELECT
        COALESCE(SUM(credit_balance), 0) as total_credits_in_circulation,
        COUNT(DISTINCT user_id) as users_with_credits
      FROM agzit_candidate_credits
    `);

    const [[reportStats]] = await pool.execute(`
      SELECT
        COUNT(*) as total_reports,
        COUNT(DISTINCT user_id) as unique_users
      FROM agzit_career_reports
    `);

    const [[referralStats]] = await pool.execute(`
      SELECT
        COUNT(*) as total_referrals,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed
      FROM agzit_referrals
    `);

    res.json({
      ok: true,
      users: userStats,
      interviews: interviewStats,
      credits: creditStats,
      reports: reportStats,
      referrals: referralStats,
      timestamp: new Date()
    });

  } catch (error) {
    console.error('Overview error:', error);
    res.status(500).json({ error: 'Failed to fetch overview' });
  }
});

// ==========================================
// 2. USER MANAGEMENT
// ==========================================

router.get('/users', ...guard, async (req, res) => {
  try {
    const { page = 1, limit = 50, search = '' } = req.query;
    const offset = (page - 1) * limit;

    let query = 'SELECT ID, user_email, display_name, user_registered, is_super_admin FROM wp_users WHERE 1=1';
    let params = [];

    if (search) {
      query += ' AND (user_email LIKE ? OR display_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY user_registered DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const [users] = await pool.execute(query, params);

    // Get credits for each user
    const usersWithCredits = await Promise.all(
      users.map(async (user) => {
        const [[credits]] = await pool.execute(
          'SELECT credit_balance FROM agzit_candidate_credits WHERE user_id = ?',
          [user.ID]
        );
        return { ...user, credit_balance: credits?.credit_balance || 0 };
      })
    );

    res.json({ ok: true, users: usersWithCredits, page: parseInt(page), limit: parseInt(limit) });

  } catch (error) {
    console.error('Users list error:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.get('/users/:userId', ...guard, async (req, res) => {
  try {
    const { userId } = req.params;

    const [[user]] = await pool.execute(
      'SELECT ID, user_email, display_name, user_registered, is_super_admin, user_status FROM wp_users WHERE ID = ?',
      [userId]
    );

    if (!user) return res.status(404).json({ error: 'User not found' });

    const [[credits]] = await pool.execute(
      'SELECT * FROM agzit_candidate_credits WHERE user_id = ?',
      [userId]
    );

    const [interviews] = await pool.execute(
      `SELECT ID, post_title, post_date FROM wp_posts
       WHERE post_type = 'employer_interview' AND post_author = ?
       ORDER BY post_date DESC LIMIT 10`,
      [userId]
    );

    const [activity] = await pool.execute(
      'SELECT * FROM agzit_user_activity_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
      [userId]
    );

    const [referrals] = await pool.execute(
      'SELECT * FROM agzit_referrals WHERE referrer_id = ? ORDER BY referred_at DESC LIMIT 10',
      [userId]
    );

    res.json({
      ok: true,
      user,
      credits: credits || null,
      interviews,
      activity,
      referrals
    });

  } catch (error) {
    console.error('User detail error:', error);
    res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

router.put('/users/:userId', ...guard, async (req, res) => {
  try {
    const { userId } = req.params;
    const { display_name, user_email } = req.body;

    const [[oldUser]] = await pool.execute(
      'SELECT display_name, user_email FROM wp_users WHERE ID = ?', [userId]
    );

    await pool.execute(
      'UPDATE wp_users SET display_name = ?, user_email = ? WHERE ID = ?',
      [display_name, user_email, userId]
    );

    await logAdminAction(req.adminId, 'user_edit', parseInt(userId), 'user', oldUser, { display_name, user_email });

    res.json({ ok: true, message: 'User updated' });

  } catch (error) {
    console.error('User update error:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

router.post('/users/:userId/grant-credits', ...guard, async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, reason } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({ error: 'Amount must be at least 1' });
    }

    // Upsert credits
    await pool.execute(
      `INSERT INTO agzit_candidate_credits (user_id, credit_balance, total_credits_earned)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         credit_balance = credit_balance + ?,
         total_credits_earned = total_credits_earned + ?`,
      [userId, amount, amount, amount, amount]
    );

    // Log transaction
    await pool.execute(
      "INSERT INTO agzit_credit_transactions (user_id, transaction_type, amount, description) VALUES (?, 'purchase', ?, ?)",
      [userId, amount, reason || 'Admin granted credits']
    );

    await logAdminAction(req.adminId, 'grant_credits', parseInt(userId), 'credit', {}, { amount, reason });

    res.json({ ok: true, message: `Granted ${amount} credits` });

  } catch (error) {
    console.error('Grant credits error:', error);
    res.status(500).json({ error: 'Failed to grant credits' });
  }
});

router.post('/users/:userId/ban', ...guard, async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body;

    if (parseInt(userId) === req.adminId) {
      return res.status(400).json({ error: 'Cannot ban yourself' });
    }

    await pool.execute(
      'UPDATE wp_users SET user_status = 1 WHERE ID = ?',
      [userId]
    );

    await logAdminAction(req.adminId, 'ban_user', parseInt(userId), 'user', {}, { reason });

    res.json({ ok: true, message: 'User banned' });

  } catch (error) {
    console.error('Ban user error:', error);
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

router.post('/users/:userId/unban', ...guard, async (req, res) => {
  try {
    const { userId } = req.params;

    await pool.execute(
      'UPDATE wp_users SET user_status = 0 WHERE ID = ?',
      [userId]
    );

    await logAdminAction(req.adminId, 'unban_user', parseInt(userId), 'user', {}, {});

    res.json({ ok: true, message: 'User unbanned' });

  } catch (error) {
    res.status(500).json({ error: 'Failed to unban user' });
  }
});

// ==========================================
// 3. CREDIT MANAGEMENT
// ==========================================

router.get('/credits/stats', ...guard, async (req, res) => {
  try {
    const [[stats]] = await pool.execute(`
      SELECT
        COALESCE(SUM(credit_balance), 0) as total_in_circulation,
        COALESCE(SUM(total_credits_earned), 0) as total_earned,
        COALESCE(SUM(total_credits_purchased), 0) as total_purchased,
        COUNT(DISTINCT user_id) as users_with_credits,
        COALESCE(AVG(credit_balance), 0) as avg_per_user
      FROM agzit_candidate_credits
    `);

    const [topUsers] = await pool.execute(`
      SELECT c.user_id, c.credit_balance, u.user_email, u.display_name
      FROM agzit_candidate_credits c
      LEFT JOIN wp_users u ON u.ID = c.user_id
      ORDER BY c.credit_balance DESC LIMIT 10
    `);

    res.json({ ok: true, stats, topUsers });

  } catch (error) {
    console.error('Credit stats error:', error);
    res.status(500).json({ error: 'Failed to fetch credit stats' });
  }
});

router.get('/credits/transactions', ...guard, async (req, res) => {
  try {
    const { page = 1, limit = 50, userId = '', type = '', startDate = '', endDate = '' } = req.query;
    const offset = (page - 1) * limit;

    let query = 'SELECT * FROM agzit_credit_transactions WHERE 1=1';
    let params = [];

    if (userId) {
      query += ' AND user_id = ?';
      params.push(userId);
    }

    if (type) {
      query += ' AND transaction_type = ?';
      params.push(type);
    }

    if (startDate) {
      query += ' AND DATE(created_at) >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND DATE(created_at) <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const [transactions] = await pool.execute(query, params);

    res.json({ ok: true, transactions, page: parseInt(page), limit: parseInt(limit) });

  } catch (error) {
    console.error('Transactions error:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// ==========================================
// 4. INTERVIEW MANAGEMENT
// ==========================================

router.get('/interviews', ...guard, async (req, res) => {
  try {
    const { page = 1, limit = 50, startDate = '', endDate = '' } = req.query;
    const offset = (page - 1) * limit;

    let query = `SELECT p.ID, p.post_title, p.post_author, p.post_date, u.user_email, u.display_name
      FROM wp_posts p
      LEFT JOIN wp_users u ON u.ID = p.post_author
      WHERE p.post_type = 'employer_interview' AND p.post_status = 'publish'`;
    let params = [];

    if (startDate) {
      query += ' AND DATE(p.post_date) >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND DATE(p.post_date) <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY p.post_date DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const [interviews] = await pool.execute(query, params);

    res.json({ ok: true, interviews, page: parseInt(page), limit: parseInt(limit) });

  } catch (error) {
    console.error('Interviews error:', error);
    res.status(500).json({ error: 'Failed to fetch interviews' });
  }
});

// ==========================================
// 5. ACTIVITY & AUDIT LOGS
// ==========================================

router.get('/logs', ...guard, async (req, res) => {
  try {
    const { page = 1, limit = 100, userId = '', action = '', startDate = '', endDate = '' } = req.query;
    const offset = (page - 1) * limit;

    let query = 'SELECT * FROM agzit_super_admin_logs WHERE 1=1';
    let params = [];

    if (userId) {
      query += ' AND target_user_id = ?';
      params.push(userId);
    }

    if (action) {
      query += ' AND action = ?';
      params.push(action);
    }

    if (startDate) {
      query += ' AND DATE(created_at) >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND DATE(created_at) <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const [logs] = await pool.execute(query, params);

    res.json({ ok: true, logs, page: parseInt(page), limit: parseInt(limit) });

  } catch (error) {
    console.error('Logs error:', error);
    res.status(500).json({ error: 'Failed to fetch logs' });
  }
});

router.get('/user-activity/:userId', ...guard, async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 50, type = '', startDate = '', endDate = '' } = req.query;
    const offset = (page - 1) * limit;

    let query = 'SELECT * FROM agzit_user_activity_log WHERE user_id = ?';
    let params = [userId];

    if (type) {
      query += ' AND activity_type = ?';
      params.push(type);
    }

    if (startDate) {
      query += ' AND DATE(created_at) >= ?';
      params.push(startDate);
    }

    if (endDate) {
      query += ' AND DATE(created_at) <= ?';
      params.push(endDate);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const [activity] = await pool.execute(query, params);

    res.json({ ok: true, activity, page: parseInt(page), limit: parseInt(limit) });

  } catch (error) {
    console.error('User activity error:', error);
    res.status(500).json({ error: 'Failed to fetch user activity' });
  }
});

// ==========================================
// 6. REFERRAL MANAGEMENT
// ==========================================

router.get('/referrals', ...guard, async (req, res) => {
  try {
    const { page = 1, limit = 50, status = '' } = req.query;
    const offset = (page - 1) * limit;

    let query = `SELECT r.*, u.user_email as referrer_email, u.display_name as referrer_name
      FROM agzit_referrals r
      LEFT JOIN wp_users u ON u.ID = r.referrer_id
      WHERE 1=1`;
    let params = [];

    if (status) {
      query += ' AND r.status = ?';
      params.push(status);
    }

    query += ' ORDER BY r.referred_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), offset);

    const [referrals] = await pool.execute(query, params);

    res.json({ ok: true, referrals, page: parseInt(page), limit: parseInt(limit) });

  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch referrals' });
  }
});

// ==========================================
// 7. API TOKEN MANAGEMENT
// ==========================================

router.get('/api-tokens', ...guard, async (req, res) => {
  try {
    const [tokens] = await pool.execute(`
      SELECT t.*, u.user_email, u.display_name
      FROM agzit_api_tokens t
      LEFT JOIN wp_users u ON u.ID = t.user_id
      ORDER BY t.created_at DESC
    `);

    res.json({ ok: true, tokens });

  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch API tokens' });
  }
});

router.get('/api-usage/:tokenId', ...guard, async (req, res) => {
  try {
    const { tokenId } = req.params;

    const [calls] = await pool.execute(
      'SELECT * FROM agzit_api_calls WHERE token_id = ? ORDER BY created_at DESC LIMIT 500',
      [tokenId]
    );

    res.json({ ok: true, calls });

  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch API usage' });
  }
});

// ==========================================
// 8. ANALYTICS
// ==========================================

router.get('/analytics/overview', ...guard, async (req, res) => {
  try {
    const [signups] = await pool.execute(`
      SELECT DATE(user_registered) as date, COUNT(*) as count
      FROM wp_users
      WHERE user_registered >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY DATE(user_registered)
      ORDER BY date DESC
    `);

    const [interviews] = await pool.execute(`
      SELECT DATE(post_date) as date, COUNT(*) as count
      FROM wp_posts
      WHERE post_type = 'employer_interview' AND post_status = 'publish'
        AND post_date >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY DATE(post_date)
      ORDER BY date DESC
    `);

    const [reports] = await pool.execute(`
      SELECT DATE(created_at) as date, COUNT(*) as count
      FROM agzit_career_reports
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);

    res.json({ ok: true, signups, interviews, reports });

  } catch (error) {
    console.error('Analytics error:', error);
    res.status(500).json({ error: 'Failed to fetch analytics' });
  }
});

module.exports = router;
