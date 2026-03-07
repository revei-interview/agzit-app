// routes/webhooks.js — Inbound webhooks from third-party services
// WooCommerce: POST /api/webhooks/woocommerce-order (order.completed)
// Auth: HMAC-SHA256 of raw request body verified against WC_WEBHOOK_SECRET env var

const express = require('express');
const router  = express.Router();
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

router.post(
  '/woocommerce-order',
  // Capture raw body BEFORE Express parses JSON
  express.raw({ type: '*/*', limit: '2mb' }),
  async (req, res) => {
    try {
      const rawBody = req.body; // Buffer when using express.raw()
      const sig     = req.headers['x-wc-webhook-signature'];

      // ── Signature verification ──────────────────────────────────────────────
      const secret = process.env.WC_WEBHOOK_SECRET;
      if (!secret) {
        console.error('[webhook/wc] WC_WEBHOOK_SECRET not set');
        return res.status(500).json({ ok: false, error: 'Webhook secret not configured' });
      }

      if (!sig) {
        return res.status(401).json({ ok: false, error: 'Missing signature' });
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
        console.warn('[webhook/wc] Signature mismatch');
        return res.status(401).json({ ok: false, error: 'Invalid signature' });
      }

      // ── Parse order ────────────────────────────────────────────────────────
      let order;
      try {
        order = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return res.status(400).json({ ok: false, error: 'Invalid JSON body' });
      }

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

module.exports = router;
