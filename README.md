# AGZIT App — Render Deployment

## Deploy to Render

### Step 1 — Run the SQL schema
Open Hostinger phpMyAdmin and run `schema.sql` to create the two new tables:
- `agzit_users`
- `agzit_otp_codes`

### Step 2 — Push to GitHub
```bash
git init
git add .
git commit -m "Initial AGZIT Render app"
git remote add origin https://github.com/YOUR_USERNAME/agzit-app.git
git push -u origin main
```

### Step 3 — Create Render Web Service
1. Go to https://render.com → New → Web Service
2. Connect your GitHub repo
3. Settings:
   - **Name:** agzit-app
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`

### Step 4 — Set Environment Variables in Render
Go to your service → Environment → Add these:

| Key | Value |
|---|---|
| `DB_HOST` | Your Hostinger MySQL host |
| `DB_PORT` | `3306` |
| `DB_NAME` | Your database name |
| `DB_USER` | Your DB username |
| `DB_PASS` | Your DB password |
| `JWT_SECRET` | Any 64-char random string |
| `JWT_EXPIRES_IN` | `7d` |
| `MAIL_HOST` | `smtp.hostinger.com` |
| `MAIL_PORT` | `465` |
| `MAIL_SECURE` | `true` |
| `MAIL_USER` | `noreply@agzit.com` |
| `MAIL_PASS` | Your email password |
| `MAIL_FROM` | `AGZIT AI <noreply@agzit.com>` |
| `APP_URL` | `https://agzit.onrender.com` |
| `WP_URL` | `https://agzit.com` |
| `NODE_ENV` | `production` |
| `CLOUDINARY_CLOUD_NAME` | Your Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | Your Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Your Cloudinary API secret |

### Step 5 — Deploy
Click **Deploy** in Render. Your app will be live at:
- `https://agzit.onrender.com/login`
- `https://agzit.onrender.com/register`

---

## What's built (Session 13)

| File | Purpose |
|---|---|
| `server.js` | Express app entry point |
| `config/db.js` | MySQL pool (Hostinger) |
| `middleware/auth.js` | JWT verify middleware |
| `routes/auth.js` | `/api/auth/*` — OTP, register, login, logout, me |
| `public/login/index.html` | Login + Register UI (3-step with OTP) |
| `public/register/index.html` | DPR profile form (4-step) |
| `schema.sql` | New tables to run on Hostinger |

## Coming Next Session
- `routes/candidate.js` — DPR profile submit + dashboard data API
- `routes/employer.js` — Employer dashboard API
- `public/dashboard/index.html` — Full candidate dashboard
- `public/employer/index.html` — Full employer dashboard
