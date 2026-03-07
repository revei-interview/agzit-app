// middleware/auth.js — JWT verification
const jwt = require('jsonwebtoken');

function requireAuth(req, res, next) {
  const token = req.cookies?.agzit_token;
  if (!token) {
    // API request → 401 JSON
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ ok: false, error: 'Not authenticated' });
    }
    // Page request → redirect to login
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { user_id, email, role, wp_user_id }
    next();
  } catch (err) {
    res.clearCookie('agzit_token');
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ ok: false, error: 'Session expired' });
    }
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ ok: false, error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: 'Access denied' });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
