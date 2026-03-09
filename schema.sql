-- ============================================================
-- AGZIT Render App — New Tables
-- Run these in Hostinger phpMyAdmin
-- ============================================================

-- 1) App users table (separate from WordPress wp_users)
--    These are users who register via the Render app (not WP)
--    wp_user_id links back to WordPress if needed

CREATE TABLE IF NOT EXISTS agzit_users (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email             VARCHAR(255) NOT NULL UNIQUE,
  password_hash     VARCHAR(255) NOT NULL,
  role              ENUM('dpr_candidate','dpr_employer','verified_employer','administrator')
                    NOT NULL DEFAULT 'dpr_candidate',
  first_name        VARCHAR(100) DEFAULT '',
  last_name         VARCHAR(100) DEFAULT '',
  wp_user_id        INT UNSIGNED DEFAULT NULL,  -- links to wp_users.ID if migrated
  dpr_profile_id    INT UNSIGNED DEFAULT NULL,  -- links to dpr_profile post
  is_active         TINYINT(1) NOT NULL DEFAULT 1,
  has_set_password  TINYINT(1) NOT NULL DEFAULT 0,  -- 1 once team member sets/dismisses password prompt
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_role  (role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- 2) OTP codes table (for email verification during registration)

CREATE TABLE IF NOT EXISTS agzit_otp_codes (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email        VARCHAR(255) NOT NULL UNIQUE,
  otp          VARCHAR(6)   NOT NULL,
  account_type ENUM('candidate','employer') NOT NULL DEFAULT 'candidate',
  expires_at   DATETIME NOT NULL,
  attempts     TINYINT UNSIGNED NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_email_otp (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- 3) Employer team members (shared company account)
--    admin_user_id  = agzit_users.id of the company admin (the one who invited)
--    member_user_id = agzit_users.id of the team member (null until they accept)

CREATE TABLE IF NOT EXISTS agzit_employer_team (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_user_id  INT UNSIGNED NOT NULL,
  member_user_id INT UNSIGNED DEFAULT NULL,
  member_email   VARCHAR(255) NOT NULL,
  member_name    VARCHAR(255) DEFAULT NULL,
  team_role      ENUM('admin','member') NOT NULL DEFAULT 'member',
  status         ENUM('invited','active','removed') NOT NULL DEFAULT 'invited',
  invite_token   VARCHAR(128) DEFAULT NULL,
  invited_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  joined_at      DATETIME DEFAULT NULL,
  INDEX idx_admin  (admin_user_id),
  INDEX idx_member (member_user_id),
  INDEX idx_email  (member_email),
  INDEX idx_token  (invite_token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- 4) Magic links (passwordless login / team invite accept tokens)

CREATE TABLE IF NOT EXISTS agzit_magic_links (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  token      VARCHAR(128) NOT NULL UNIQUE,
  user_id    INT UNSIGNED NOT NULL,
  purpose    VARCHAR(32)  NOT NULL DEFAULT 'login',
  expires_at DATETIME NOT NULL,
  used_at    DATETIME DEFAULT NULL,
  INDEX idx_token (token),
  INDEX idx_user  (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================
-- NOTES:
-- * agzit_users is INDEPENDENT of wp_users.
--   WordPress shortcodes stay on WP using wp_users.
--   New Render registrations go into agzit_users.
-- * wp_user_id can be filled later if you want to migrate
--   existing WordPress users to the Render app.
-- * dpr_profile_id will link to the DPR profile record
--   once DPR profile tables are created (next session).
-- ============================================================
