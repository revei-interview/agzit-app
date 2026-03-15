// jobs/fetcher.js — Fetches jobs from 4 sources, saves to agzit_job_listings
const pool  = require('../config/db');
const fetch = require('node-fetch');
const { parseStringPromise } = require('xml2js');

// ── Source 1: JSearch (RapidAPI) ────────────────────────────────────────────
const JSEARCH_QUERIES = [
  'compliance jobs in India',
  'finance jobs in India',
  'HR jobs in India',
  'audit jobs in India',
  'risk management jobs in India',
  'compliance jobs in Dubai',
  'finance jobs in Dubai',
  'HR manager jobs UAE',
  'compliance jobs in London',
  'finance jobs in Singapore',
  'compliance jobs in Canada',
  'finance jobs in Australia',
];

async function fetchJSearch() {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) { console.warn('[jobs] RAPIDAPI_KEY not set — skipping JSearch'); return 0; }

  let total = 0;
  for (const query of JSEARCH_QUERIES) {
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
        await upsertJob({
          external_id:     job.job_id,
          title:           job.job_title,
          company:         job.employer_name,
          location:        [job.job_city, job.job_country].filter(Boolean).join(', '),
          city:            job.job_city || null,
          country:         job.job_country || null,
          description:     (job.job_description || '').slice(0, 1000),
          apply_url:       job.job_apply_link,
          source_url:      job.job_apply_link,
          source:          'jsearch',
          date_posted:     job.job_posted_at_datetime_utc || null,
          is_remote:       job.job_is_remote ? 1 : 0,
          employment_type: job.job_employment_type || null,
        });
        total++;
      }
      // Small delay to respect rate limits
      await sleep(500);
    } catch (err) {
      console.error(`[jobs] JSearch "${query}" error:`, err.message);
    }
  }
  return total;
}

// ── Source 2: Remotive ──────────────────────────────────────────────────────
const REMOTIVE_URLS = [
  'https://remotive.com/api/remote-jobs?category=finance&limit=50',
  'https://remotive.com/api/remote-jobs?category=hr&limit=50',
];

async function fetchRemotive() {
  let total = 0;
  for (const url of REMOTIVE_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) { console.warn(`[jobs] Remotive: HTTP ${res.status}`); continue; }
      const json = await res.json();
      const jobs = json.jobs || [];
      for (const job of jobs) {
        await upsertJob({
          external_id:     `remotive_${job.id}`,
          title:           job.title,
          company:         job.company_name,
          location:        job.candidate_required_location || 'Remote',
          city:            null,
          country:         null,
          description:     stripHtml(job.description || '').slice(0, 1000),
          apply_url:       job.url,
          source_url:      job.url,
          source:          'remotive',
          date_posted:     job.publication_date || null,
          is_remote:       1,
          employment_type: job.job_type || null,
        });
        total++;
      }
    } catch (err) {
      console.error('[jobs] Remotive error:', err.message);
    }
  }
  return total;
}

// ── Source 3: Jobicy ────────────────────────────────────────────────────────
const JOBICY_URLS = [
  'https://jobicy.com/api/v2/remote-jobs?count=50&industry=accounting-finance',
  'https://jobicy.com/api/v2/remote-jobs?count=50&industry=hr',
];

async function fetchJobicy() {
  let total = 0;
  for (const url of JOBICY_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) { console.warn(`[jobs] Jobicy: HTTP ${res.status}`); continue; }
      const json = await res.json();
      const jobs = json.jobs || [];
      for (const job of jobs) {
        await upsertJob({
          external_id:     `jobicy_${job.id}`,
          title:           job.jobTitle,
          company:         job.companyName,
          location:        job.jobGeo || 'Remote',
          city:            null,
          country:         job.jobGeo || null,
          description:     stripHtml(job.jobDescription || '').slice(0, 1000),
          apply_url:       job.url,
          source_url:      job.url,
          source:          'jobicy',
          date_posted:     job.pubDate || null,
          is_remote:       1,
          employment_type: job.jobType || null,
        });
        total++;
      }
    } catch (err) {
      console.error('[jobs] Jobicy error:', err.message);
    }
  }
  return total;
}

// ── Source 4: WeWorkRemotely (RSS/XML) ──────────────────────────────────────
const WWR_URLS = [
  'https://weworkremotely.com/categories/remote-finance-jobs.rss',
  'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss',
];

async function fetchWeWorkRemotely() {
  let total = 0;
  for (const url of WWR_URLS) {
    try {
      const res = await fetch(url);
      if (!res.ok) { console.warn(`[jobs] WWR: HTTP ${res.status}`); continue; }
      const xml = await res.text();
      const parsed = await parseStringPromise(xml, { explicitArray: false });
      const items = parsed?.rss?.channel?.item;
      if (!items) continue;
      const list = Array.isArray(items) ? items : [items];
      for (const item of list) {
        const guid = item.guid?._ || item.guid || item.link;
        if (!guid) continue;
        await upsertJob({
          external_id:     `wwr_${Buffer.from(guid).toString('base64').slice(0, 200)}`,
          title:           item.title || '',
          company:         extractCompany(item.title),
          location:        item['job:region'] || item.region || 'Remote',
          city:            null,
          country:         null,
          description:     stripHtml(item.description || '').slice(0, 1000),
          apply_url:       item.link,
          source_url:      item.link,
          source:          'weworkremotely',
          date_posted:     item.pubDate ? new Date(item.pubDate).toISOString() : null,
          is_remote:       1,
          employment_type: 'FULLTIME',
        });
        total++;
      }
    } catch (err) {
      console.error('[jobs] WeWorkRemotely error:', err.message);
    }
  }
  return total;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractCompany(title) {
  // WWR titles often look like "Company: Job Title"
  if (!title) return null;
  const m = title.match(/^(.+?):\s/);
  return m ? m[1].trim() : null;
}

async function upsertJob(job) {
  try {
    await pool.execute(
      `INSERT IGNORE INTO agzit_job_listings
        (external_id, title, company, location, city, country, description,
         apply_url, source_url, source, date_posted, is_remote, employment_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        job.external_id, job.title, job.company, job.location,
        job.city, job.country, job.description,
        job.apply_url, job.source_url, job.source,
        job.date_posted, job.is_remote, job.employment_type,
      ]
    );
  } catch (err) {
    // Ignore duplicates silently, log other errors
    if (err.code !== 'ER_DUP_ENTRY') {
      console.error('[jobs] upsert error:', err.message);
    }
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
  console.log(`[jobs] Fetch complete — total: ${total}`, results);
  return results;
}

module.exports = { fetchAllJobs };
