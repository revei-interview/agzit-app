// jobs/matcher.js — Match jobs to candidate profile

// ── Industry keyword map ────────────────────────────────────────────────────
const INDUSTRY_KEYWORDS = {
  compliance:         ['compliance', 'regulatory', 'regulation', 'aml', 'kyc', 'fincrime', 'governance', 'grc'],
  finance:            ['finance', 'financial', 'accounting', 'audit', 'risk', 'treasury', 'banking', 'investment', 'cfo', 'controller'],
  hr:                 ['hr', 'human resources', 'recruitment', 'talent', 'people operations', 'payroll', 'hrbp'],
  it:                 ['software', 'developer', 'engineer', 'tech', 'data', 'cloud', 'devops', 'product', 'full stack', 'backend', 'frontend'],
  legal:              ['legal', 'lawyer', 'attorney', 'counsel', 'litigation', 'contract', 'paralegal'],
  marketing:          ['marketing', 'brand', 'digital marketing', 'seo', 'sem', 'content', 'social media', 'advertising'],
  sales:              ['sales', 'business development', 'account manager', 'revenue', 'crm', 'inside sales'],
  operations:         ['operations', 'supply chain', 'logistics', 'procurement', 'warehouse', 'manufacturing'],
  healthcare:         ['healthcare', 'medical', 'pharma', 'clinical', 'biotech', 'nursing', 'hospital'],
  education:          ['education', 'teaching', 'academic', 'professor', 'instructor', 'curriculum', 'e-learning'],
  construction:       ['construction', 'civil', 'structural', 'architect', 'building', 'real estate'],
  energy:             ['energy', 'oil', 'gas', 'renewable', 'solar', 'wind', 'power', 'utilities'],
  media:              ['media', 'journalism', 'publishing', 'broadcast', 'entertainment', 'film'],
  design:             ['design', 'ui', 'ux', 'graphic', 'creative', 'visual', 'illustration'],
  consulting:         ['consulting', 'advisory', 'strategy', 'management consulting', 'deloitte', 'kpmg', 'ey', 'pwc'],
  insurance:          ['insurance', 'underwriting', 'actuary', 'claims', 'reinsurance'],
  telecom:            ['telecom', 'telecommunications', 'network', '5g', 'wireless'],
  retail:             ['retail', 'ecommerce', 'e-commerce', 'merchandising', 'store'],
  hospitality:        ['hospitality', 'hotel', 'restaurant', 'tourism', 'travel', 'food service'],
  nonprofit:          ['nonprofit', 'ngo', 'charity', 'social impact', 'philanthropy', 'foundation'],
  government:         ['government', 'public sector', 'civil service', 'policy', 'public administration'],
  aviation:           ['aviation', 'airline', 'aerospace', 'pilot', 'aircraft'],
  shipping:           ['shipping', 'maritime', 'logistics', 'freight', 'port'],
  cybersecurity:      ['cybersecurity', 'infosec', 'security analyst', 'penetration', 'soc', 'incident response'],
  data_science:       ['data science', 'machine learning', 'ai', 'artificial intelligence', 'deep learning', 'nlp', 'analytics'],
  customer_service:   ['customer service', 'customer support', 'helpdesk', 'call center', 'client success'],
  project_management: ['project management', 'pmp', 'scrum', 'agile', 'program manager'],
  quality:            ['quality', 'qa', 'quality assurance', 'testing', 'inspection', 'iso'],
  research:           ['research', 'r&d', 'scientist', 'laboratory', 'clinical trial'],
  agriculture:        ['agriculture', 'farming', 'agritech', 'agribusiness', 'crop'],
  mining:             ['mining', 'mineral', 'geology', 'exploration'],
  automotive:         ['automotive', 'automobile', 'vehicle', 'ev', 'electric vehicle'],
  fashion:            ['fashion', 'apparel', 'textile', 'garment', 'luxury'],
  sports:             ['sports', 'fitness', 'athletics', 'coaching', 'wellness'],
  environmental:      ['environmental', 'sustainability', 'esg', 'climate', 'green'],
  real_estate:        ['real estate', 'property', 'realty', 'leasing', 'mortgage'],
  venture_capital:    ['venture capital', 'private equity', 'vc', 'startup', 'fundraising'],
  blockchain:         ['blockchain', 'crypto', 'web3', 'defi', 'smart contract'],
  biotechnology:      ['biotechnology', 'biotech', 'genomics', 'bioinformatics'],
  defense:            ['defense', 'defence', 'military', 'security', 'intelligence'],
  food_beverage:      ['food', 'beverage', 'fmcg', 'consumer goods', 'packaging'],
  // Catch-all generic terms that could match broad profiles
  general:            ['manager', 'analyst', 'coordinator', 'specialist', 'executive', 'officer', 'director'],
};

// ── Matching engine ─────────────────────────────────────────────────────────
function matchJobsForCandidate(profile, jobs) {
  if (!jobs || !jobs.length) return [];

  // Extract profile data
  const candidateIndustryRaw = (profile.compliance_domains || profile.industry || '').toLowerCase();
  const desiredRole    = (profile.desired_role || '').toLowerCase();
  const candidateCity  = (profile.residential_city || '').toLowerCase();
  const candidateCountry = (profile.residential_country || '').toLowerCase();
  const candidateSkills  = (profile.soft_skills || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  // Determine candidate's industry keywords
  const industryKeywords = getIndustryKeywords(candidateIndustryRaw);

  // Desired role words (filter out very short/common words)
  const roleWords = desiredRole
    .split(/[\s,\-\/]+/)
    .map(w => w.trim())
    .filter(w => w.length > 2);

  const now = Date.now();
  const scored = [];

  for (const job of jobs) {
    const titleLow = (job.title || '').toLowerCase();
    const descLow  = (job.description || '').toLowerCase();
    const combined = titleLow + ' ' + descLow;
    const breakdown = { industry: 0, role: 0, location: 0, skills: 0, freshness: 0 };

    // 1. Industry match (+40)
    if (industryKeywords.length > 0) {
      const match = industryKeywords.some(kw => combined.includes(kw));
      if (match) breakdown.industry = 40;
    }

    // 2. Desired role match (+25)
    if (roleWords.length > 0) {
      const match = roleWords.some(w => titleLow.includes(w));
      if (match) breakdown.role = 25;
    }

    // 3. Location match (+20)
    const jobCountry = (job.country || '').toLowerCase();
    const jobCity    = (job.city || '').toLowerCase();
    const jobLocation = (job.location || '').toLowerCase();

    if (job.is_remote) {
      breakdown.location += 10;
    }
    if (candidateCountry && (jobCountry.includes(candidateCountry) || jobLocation.includes(candidateCountry))) {
      breakdown.location += 20;
    } else if (candidateCity && (jobCity.includes(candidateCity) || jobLocation.includes(candidateCity))) {
      breakdown.location += 15;
    }
    if (breakdown.location > 20) breakdown.location = 20;

    // 4. Skills match (+15, +3 per skill, max 15)
    if (candidateSkills.length > 0) {
      let skillPoints = 0;
      for (const skill of candidateSkills) {
        if (skill.length > 2 && combined.includes(skill)) {
          skillPoints += 3;
          if (skillPoints >= 15) break;
        }
      }
      breakdown.skills = Math.min(skillPoints, 15);
    }

    // 5. Freshness bonus (+5)
    if (job.date_posted) {
      const posted = new Date(job.date_posted).getTime();
      const ageMs = now - posted;
      if (ageMs < 24 * 60 * 60 * 1000)      breakdown.freshness = 5;
      else if (ageMs < 7 * 24 * 60 * 60 * 1000) breakdown.freshness = 2;
    }

    const score = breakdown.industry + breakdown.role + breakdown.location + breakdown.skills + breakdown.freshness;
    if (score >= 30) {
      scored.push({ ...job, score, score_breakdown: breakdown });
    }
  }

  // Sort by score descending, then by date_posted descending
  scored.sort((a, b) => b.score - a.score || new Date(b.date_posted || 0) - new Date(a.date_posted || 0));
  return scored.slice(0, 20);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function getIndustryKeywords(rawIndustry) {
  if (!rawIndustry) return [];

  // Try to parse as JSON array (compliance_domains stores ["finance"] etc.)
  let industries = [];
  try {
    const parsed = JSON.parse(rawIndustry);
    if (Array.isArray(parsed)) industries = parsed.map(s => s.toLowerCase().trim());
    else industries = [rawIndustry];
  } catch (_) {
    industries = [rawIndustry];
  }

  const keywords = new Set();
  for (const ind of industries) {
    // Direct match in our map
    for (const [key, kws] of Object.entries(INDUSTRY_KEYWORDS)) {
      if (ind.includes(key) || kws.some(kw => ind.includes(kw))) {
        kws.forEach(kw => keywords.add(kw));
      }
    }
    // Also add the raw industry term itself
    if (ind.length > 2) keywords.add(ind);
  }
  return [...keywords];
}

module.exports = { matchJobsForCandidate };
