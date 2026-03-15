// routes/webhooks.js — Inbound webhooks from third-party services
// WooCommerce: POST /api/webhooks/woocommerce-order (order.completed)
// Auth: HMAC-SHA256 of raw request body verified against WC_WEBHOOK_SECRET env var

const { Router } = require('express');
const router      = Router();
const pool    = require('../config/db');
const crypto  = require('crypto');

// ── WooCommerce products that grant interview credits ─────────────────────────
const PRODUCT_CREDITS = {
  19594: { field: 'mock_sessions_remaining_20', label: '20-min' },
  19596: { field: 'mock_sessions_remaining_30', label: '30-min' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getUserMeta(wpUserId, keys) {
  if (!wpUserId || !keys.length) return {};
  const ph = keys.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT meta_key, meta_value FROM wp_usermeta WHERE user_id = ? AND meta_key IN (${ph})`,
    [wpUserId, ...keys]
  );
  const out = {};
  for (const r of rows) out[r.meta_key] = r.meta_value;
  return out;
}

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

// ── POST /api/webhooks/woocommerce-order ──────────────────────────────────────
// WooCommerce sends this on order.completed event.
// Body is the full WC Order object (JSON).
// Signature: base64(HMAC-SHA256(rawBody, WC_WEBHOOK_SECRET)) in X-Wc-Webhook-Signature header.

router.post('/woocommerce-order', async (req, res) => {
    try {
      // req.rawBody = raw Buffer set by express.json() verify callback in server.js
      // req.body    = already-parsed JSON object — no need to JSON.parse manually
      const rawBody = req.rawBody;
      const order   = req.body;
      const sig     = req.headers['x-wc-webhook-signature'];

      // ── Signature verification ──────────────────────────────────────────────
      const secret = (process.env.WC_WEBHOOK_SECRET || '').trim();

      if (secret && rawBody) {
        if (!sig) {
          console.warn('[webhook/wc] WC_WEBHOOK_SECRET set but X-WC-Webhook-Signature header missing');
          return res.status(401).json({ ok: false, error: 'Missing signature header' });
        }

        const expected = crypto
          .createHmac('sha256', secret)
          .update(rawBody)
          .digest('base64');

        let sigValid = false;
        try {
          const sigBuf = Buffer.from(sig,      'base64');
          const expBuf = Buffer.from(expected, 'base64');
          sigValid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
        } catch {
          sigValid = false;
        }

        if (!sigValid) {
          console.warn('[webhook/wc] Signature mismatch — received:', sig, 'expected:', expected);
          return res.status(401).json({ ok: false, error: 'Invalid signature' });
        }
      } else if (!secret) {
        console.warn('[webhook/wc] No WC_WEBHOOK_SECRET — accepting without signature check');
      }

      console.log('[webhook/wc] Processing order:', order?.id, 'status:', order?.status);

      // Only process completed orders
      if (order.status !== 'completed') {
        return res.json({ ok: true, skipped: true, reason: `status=${order.status}` });
      }

      const wpUserId = parseInt(order.customer_id, 10);
      if (!wpUserId) {
        console.warn('[webhook/wc] No customer_id in order', order.id);
        return res.json({ ok: true, skipped: true, reason: 'guest_order' });
      }

      // ── Tally credits per product ──────────────────────────────────────────
      const creditsByField = {};
      for (const item of (order.line_items || [])) {
        const productId = item.product_id;
        const def       = PRODUCT_CREDITS[productId];
        if (!def) continue;
        creditsByField[def.field] = (creditsByField[def.field] || 0) + (item.quantity || 1);
      }

      if (!Object.keys(creditsByField).length) {
        return res.json({ ok: true, skipped: true, reason: 'no_target_products' });
      }

      // ── Read existing user meta ────────────────────────────────────────────
      const metaKeys = [
        'mock_sessions_remaining_20',
        'mock_sessions_remaining_30',
        'mock_sessions_remaining',
        'mock_valid_until',
      ];
      const existingMeta = await getUserMeta(wpUserId, metaKeys);

      const current20 = parseInt(existingMeta.mock_sessions_remaining_20) || 0;
      const current30 = parseInt(existingMeta.mock_sessions_remaining_30) || 0;

      const added20 = creditsByField['mock_sessions_remaining_20'] || 0;
      const added30 = creditsByField['mock_sessions_remaining_30'] || 0;

      const new20    = current20 + added20;
      const new30    = current30 + added30;
      const newTotal = new20 + new30;

      // valid_until = max(existing, now + 365 days)
      const existingUntil  = parseInt(existingMeta.mock_valid_until) || 0;
      const oneYearFromNow = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
      const newUntil       = Math.max(existingUntil, oneYearFromNow);

      // ── Write updated meta ─────────────────────────────────────────────────
      await Promise.all([
        upsertUserMeta(wpUserId, 'mock_sessions_remaining_20', String(new20)),
        upsertUserMeta(wpUserId, 'mock_sessions_remaining_30', String(new30)),
        upsertUserMeta(wpUserId, 'mock_sessions_remaining',    String(newTotal)),
        upsertUserMeta(wpUserId, 'mock_valid_until',           String(newUntil)),
      ]);

      console.log(`[webhook/wc] Order ${order.id}: user ${wpUserId} +${added20}×20min +${added30}×30min → ${new20}/${new30} total=${newTotal}`);
      res.json({
        ok: true,
        order_id:   order.id,
        wp_user_id: wpUserId,
        credits_added: { '20min': added20, '30min': added30 },
        credits_now:   { '20min': new20,   '30min': new30, total: newTotal },
        valid_until:   newUntil,
      });
    } catch (err) {
      console.error('[webhook/wc]', err);
      res.status(500).json({ ok: false, error: 'Server error' });
    }
  }
);

// ── POST /api/webhooks/ai-polish-order ────────────────────────────────────────
// WooCommerce sends this on order.completed for AI Polish product (ID 20640).
// Automatically grants 3 AI Polish credits to the candidate.

const AI_POLISH_PRODUCT_ID = 20640;

router.post('/ai-polish-order', async (req, res) => {
  try {
    const rawBody = req.rawBody;
    const order   = req.body;
    const sig     = req.headers['x-wc-webhook-signature'];

    // ── Signature verification (same pattern as interview credits webhook) ────
    const secret = (process.env.WC_WEBHOOK_SECRET || '').trim();
    if (secret && rawBody) {
      if (!sig) {
        console.warn('[webhook/ai-polish] Missing signature header');
        return res.status(200).json({ ok: false, error: 'Missing signature' });
      }
      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
      let sigValid = false;
      try {
        const sigBuf = Buffer.from(sig, 'base64');
        const expBuf = Buffer.from(expected, 'base64');
        sigValid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
      } catch { sigValid = false; }
      if (!sigValid) {
        console.warn('[webhook/ai-polish] Signature mismatch');
        return res.status(200).json({ ok: false, error: 'Invalid signature' });
      }
    }

    console.log('[webhook/ai-polish] Processing order:', order?.id, 'status:', order?.status);

    // Only process completed orders
    if (order.status !== 'completed') {
      return res.json({ ok: true, skipped: true, reason: `status=${order.status}` });
    }

    // Check if order contains AI Polish product
    const hasPolishProduct = (order.line_items || []).some(
      item => parseInt(item.product_id) === AI_POLISH_PRODUCT_ID
    );
    if (!hasPolishProduct) {
      return res.json({ ok: true, skipped: true, reason: 'no_ai_polish_product' });
    }

    const orderId = String(order.id);

    // Check if this order was already processed (prevent duplicate credits)
    const [[alreadyUsed]] = await pool.execute(
      "SELECT id FROM agzit_credit_transactions WHERE reference_id = ? AND transaction_type = 'purchase'",
      [orderId]
    );
    if (alreadyUsed) {
      console.log('[webhook/ai-polish] Order', orderId, 'already processed — skipping');
      return res.json({ ok: true, skipped: true, reason: 'order_already_processed' });
    }

    // Find the candidate by billing email
    const billingEmail = (order.billing?.email || '').toLowerCase().trim();
    if (!billingEmail) {
      console.warn('[webhook/ai-polish] No billing email in order', orderId);
      return res.json({ ok: true, skipped: true, reason: 'no_billing_email' });
    }

    // Try agzit_users first, then wp_users
    let userId = null;
    const [[agzitUser]] = await pool.execute(
      'SELECT id FROM agzit_users WHERE LOWER(email) = ? LIMIT 1',
      [billingEmail]
    );
    if (agzitUser) {
      userId = agzitUser.id;
    } else {
      // Fallback: look up wp_users → agzit_users via wp_user_id
      const [[wpUser]] = await pool.execute(
        'SELECT ID FROM wp_users WHERE LOWER(user_email) = ? LIMIT 1',
        [billingEmail]
      );
      if (wpUser) {
        const [[linked]] = await pool.execute(
          'SELECT id FROM agzit_users WHERE wp_user_id = ? LIMIT 1',
          [wpUser.ID]
        );
        if (linked) userId = linked.id;
      }
    }

    if (!userId) {
      console.warn('[webhook/ai-polish] No candidate found for email:', billingEmail);
      return res.json({ ok: true, skipped: true, reason: 'user_not_found' });
    }

    // Grant 5 unified credits
    await pool.execute(
      `INSERT INTO agzit_candidate_credits (user_id, credit_balance, total_credits_purchased)
       VALUES (?, 5, 5)
       ON DUPLICATE KEY UPDATE credit_balance = credit_balance + 5, total_credits_purchased = total_credits_purchased + 5`,
      [userId]
    );

    // Log the transaction
    await pool.execute(
      `INSERT INTO agzit_credit_transactions (user_id, transaction_type, amount, description, reference_id)
       VALUES (?, 'purchase', 5, 'Purchased 5 credits — $5', ?)`,
      [userId, orderId]
    );

    console.log(`[webhook/ai-polish] Order ${orderId}: user ${userId} (${billingEmail}) +5 unified credits`);
    return res.json({ ok: true, user_id: userId, credits_added: 5 });
  } catch (err) {
    console.error('[webhook/ai-polish]', err);
    // Always return 200 to prevent WooCommerce retries
    return res.status(200).json({ ok: false, error: 'Server error' });
  }
});

module.exports = router;
