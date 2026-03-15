// jobs/fetcher.js — Fetches jobs from 4 sources, saves to agzit_job_listings
const pool  = require('../config/db');
const fetch = require('node-fetch');
const { parseStringPromise } = require('xml2js');

// ── Value sanitizer — prevents "Incorrect arguments to mysqld_stmt_execute" ─
function sanitize(val, type = 'string', maxLen = 500) {
  if (val === undefined || val === null || val === '') return null;
  if (type === 'string') {
    if (typeof val === 'object') return JSON.stringify(val).substring(0, maxLen);
    return String(val).substring(0, maxLen);
  }
  if (type === 'int') {
    const n = parseInt(val);
    return isNaN(n) ? null : n;
  }
  if (type === 'bool') {
    return val ? 1 : 0;
  }
  return null;
}

// ── Source 1: JSearch (RapidAPI) — 16 broad queries ─────────────────────────
const SEARCH_QUERIES = [
  // India — top industries
  'compliance jobs in India',
  'finance accounting jobs in India',
  'HR recruitment jobs in India',
  'audit risk jobs in India',
  'banking jobs in India',
  'software IT jobs in India',

  // UAE / Gulf
  'compliance finance jobs in Dubai',
  'HR jobs in UAE',
  'banking risk jobs in Abu Dhabi',

  // UK
  'compliance audit jobs in London',
  'finance jobs in United Kingdom',

  // Singapore
  'compliance finance jobs in Singapore',

  // Canada
  'compliance HR jobs in Canada',

  // Australia
  'finance compliance jobs in Australia',

  // Remote — any location
  'remote compliance jobs',
  'remote finance jobs',
];

async function fetchJSearch() {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) { console.warn('[jobs] RAPIDAPI_KEY not set — skipping JSearch'); return 0; }

  let attempted = 0, inserted = 0, errors = 0;
  for (const query of SEARCH_QUERIES) {
    try {
      const url = `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(query)}&page=1&num_pages=1&date_posted=today`;
      const res = await fetch(url, {
        headers: {
          'X-RapidAPI-Key': key,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
        },
      });
      if (!res.ok) { console.warn(`[jobs] JSearch ${query}: HTTP ${res.status}`); continue; }
      const json = await res.json();
      const jobs = json.data || [];
      for (const job of jobs) {
        attempted++;
        const ok = await upsertJob(mapJSearchJob(job));
        if (ok) inserted++; else errors++;
      }
      await sleep(500);
    } catch (err) {
      console.error(`[jobs] JSearch "${query}" error:`, err.message);
    }
  }
  console.log(`[jobs] jsearch: ${attempted} attempted, ${inserted} inserted, ${errors} errors`);
  return inserted;
}

// ── Live per-candidate JSearch (called from candidate.js) ───────────────────
async function fetchJSearchLive(query) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) return [];

  try {
    const url = `https://jsearch.p.rapidapi.com/search?query=${encodeURIComponent(query)}&page=1&num_pages=1&date_posted=week`;
    const res = await fetch(url, {
      headers: {
        'X-RapidAPI-Key': key,
        'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
      },
    });
    if (!res.ok) { console.warn(`[jobs] Live JSearch "${query}": HTTP ${res.status}`); return []; }
    const json = await res.json();
    return (json.data || []).map(mapJSearchJob);
  } catch (err) {
    console.error(`[jobs] Live JSearch "${query}" error:`, err.message);
    return [];
  }
}

function mapJSearchJob(job) {
  return {
    external_id:     job.job_id,
    title:           job.job_title,
    company:         job.employer_name,
    location:        [job.job_city, job.job_country].filter(Boolean).join(', '),
    city:            job.job_city || null,
    country:         job.job_country || null,
    description:     (job.job_description || '').slice(0, 2000),
    apply_url:       job.job_apply_link,
    source_url:      job.job_apply_link,
    source:          'jsearch',
    date_posted:     job.job_posted_at_datetime_utc || null,
    is_remote:       job.job_is_remote ? 1 : 0,
    employment_type: job.job_employment_type || null,
  };
}

// ── Source 2: Remotive ──────────────────────────────────────────────────────
const REMOTIVE_URLS = [
  'https://remotive.com/api/remote-jobs?category=finance&limit=50',
  'https://remotive.com/api/remote-jobs?category=hr&limit=50',
];

async function fetchRemotive() {
  let attempted = 0, inserted = 0, errors = 0;
  for (const url of REMOTIVE_URLS) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) { console.warn(`[jobs] Remotive: HTTP ${res.status}`); continue; }
      const json = await res.json();
      const jobs = json.jobs || [];
      for (const job of jobs) {
        attempted++;
        const ok = await upsertJob({
          external_id:     `remotive_${job.id}`,
          title:           job.title,
          company:         job.company_name,
          location:        job.candidate_required_location || 'Remote',
          city:            null,
          country:         null,
          description:     stripHtml(job.description || '').slice(0, 2000),
          apply_url:       job.url,
          source_url:      job.url,
          source:          'remotive',
          date_posted:     job.publication_date || null,
          is_remote:       1,
          employment_type: job.job_type || null,
        });
        if (ok) inserted++; else errors++;
      }
    } catch (err) {
      console.error('[jobs] Remotive error:', err.message);
    }
  }
  console.log(`[jobs] remotive: ${attempted} attempted, ${inserted} inserted, ${errors} errors`);
  return inserted;
}

// ── Source 3: Jobicy ────────────────────────────────────────────────────────
const JOBICY_URLS = [
  'https://jobicy.com/api/v2/remote-jobs?count=50&industry=accounting-finance',
  'https://jobicy.com/api/v2/remote-jobs?count=50&industry=hr',
];

async function fetchJobicy() {
  let attempted = 0, inserted = 0, errors = 0;
  for (const url of JOBICY_URLS) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) { console.warn(`[jobs] Jobicy: HTTP ${res.status}`); continue; }
      const json = await res.json();
      const jobs = json.jobs || [];
      for (const job of jobs) {
        attempted++;
        const ok = await upsertJob({
          external_id:     `jobicy_${job.id}`,
          title:           job.jobTitle,
          company:         job.companyName,
          location:        job.jobGeo || 'Remote',
          city:            null,
          country:         job.jobGeo || null,
          description:     stripHtml(job.jobDescription || '').slice(0, 2000),
          apply_url:       job.url,
          source_url:      job.url,
          source:          'jobicy',
          date_posted:     job.pubDate || null,
          is_remote:       1,
          employment_type: job.jobType || null,
        });
        if (ok) inserted++; else errors++;
      }
    } catch (err) {
      console.error('[jobs] Jobicy error:', err.message);
    }
  }
  console.log(`[jobs] jobicy: ${attempted} attempted, ${inserted} inserted, ${errors} errors`);
  return inserted;
}

// ── Source 4: WeWorkRemotely (RSS/XML) ──────────────────────────────────────
const WWR_URLS = [
  'https://weworkremotely.com/categories/remote-finance-jobs.rss',
  'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss',
];

async function fetchWeWorkRemotely() {
  let attempted = 0, inserted = 0, errors = 0;
  for (const url of WWR_URLS) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) { console.warn(`[jobs] WWR: HTTP ${res.status}`); continue; }
      const xml = await res.text();
      const parsed = await parseStringPromise(xml, { explicitArray: false });
      const items = parsed?.rss?.channel?.item;
      if (!items) continue;
      const list = Array.isArray(items) ? items : [items];
      for (const item of list) {
        const guid = item.guid?._ || item.guid || item.link;
        if (!guid) continue;
        attempted++;
        const ok = await upsertJob({
          external_id:     `wwr_${Buffer.from(String(guid)).toString('base64').slice(0, 200)}`,
          title:           item.title || '',
          company:         extractCompany(item.title),
          location:        item['job:region'] || item.region || 'Remote',
          city:            null,
          country:         null,
          description:     stripHtml(item.description || '').slice(0, 2000),
          apply_url:       item.link,
          source_url:      item.link,
          source:          'weworkremotely',
          date_posted:     item.pubDate ? new Date(item.pubDate).toISOString() : null,
          is_remote:       1,
          employment_type: 'FULLTIME',
        });
        if (ok) inserted++; else errors++;
      }
    } catch (err) {
      console.error('[jobs] WeWorkRemotely error:', err.message);
    }
  }
  console.log(`[jobs] weworkremotely: ${attempted} attempted, ${inserted} inserted, ${errors} errors`);
  return inserted;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function stripHtml(html) {
  if (typeof html !== 'string') return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractCompany(title) {
  if (!title || typeof title !== 'string') return null;
  const m = title.match(/^(.+?):\s/);
  return m ? m[1].trim() : null;
}

// Returns true on success, false on error
async function upsertJob(job) {
  try {
    const params = [
      sanitize(job.external_id),                 // VARCHAR(255)
      sanitize(job.title, 'string', 255),        // VARCHAR(255)
      sanitize(job.company, 'string', 255),      // VARCHAR(255)
      sanitize(job.location, 'string', 255),     // VARCHAR(255)
      sanitize(job.city, 'string', 100),         // VARCHAR(100)
      sanitize(job.country, 'string', 100),      // VARCHAR(100)
      sanitize(job.description, 'string', 2000), // TEXT
      sanitize(job.apply_url),                   // VARCHAR(500)
      sanitize(job.source_url),                  // VARCHAR(500)
      sanitize(job.source, 'string', 100),       // VARCHAR(100)
      sanitize(job.date_posted) || null,         // DATETIME
      sanitize(job.is_remote, 'bool'),           // TINYINT(1)
      sanitize(job.employment_type, 'string', 100), // VARCHAR(100)
    ];

    await pool.execute(
      `INSERT IGNORE INTO agzit_job_listings
        (external_id, title, company, location, city, country, description,
         apply_url, source_url, source, date_posted, is_remote, employment_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params
    );
    return true;
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') {
      console.error('[jobs] upsert error:', err.message, '| external_id:', job.external_id);
    }
    return false;
  }
}

async function cleanupOldJobs() {
  try {
    const [result] = await pool.execute(
      'DELETE FROM agzit_job_listings WHERE date_posted < DATE_SUB(NOW(), INTERVAL 30 DAY)'
    );
    if (result.affectedRows > 0) {
      console.log(`[jobs] Cleaned up ${result.affectedRows} old jobs`);
    }
  } catch (err) {
    console.error('[jobs] Cleanup error:', err.message);
  }
}

// ── Main orchestrator ───────────────────────────────────────────────────────
async function fetchAllJobs() {
  const results = {};
  results.jsearch   = await fetchJSearch();
  results.remotive  = await fetchRemotive();
  results.jobicy    = await fetchJobicy();
  results.wwr       = await fetchWeWorkRemotely();
  await cleanupOldJobs();

  const total = Object.values(results).reduce((a, b) => a + b, 0);
  console.log(`[jobs] Fetch complete — total inserted: ${total}`, results);
  return results;
}

module.exports = { fetchAllJobs, fetchJSearchLive };
