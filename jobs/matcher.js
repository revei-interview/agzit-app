// jobs/matcher.js — Match jobs to candidate profile

// ── Industry keyword map — all 53 AGZIT industries ──────────────────────────
const INDUSTRY_KEYWORDS = {
  compliance:       ['compliance', 'regulatory', 'regulation', 'aml', 'kyc', 'fincrime', 'governance', 'grc'],
  finance:          ['finance', 'financial', 'cfo', 'controller', 'treasury', 'investment', 'portfolio'],
  accounting:       ['accounting', 'accountant', 'bookkeeping', 'tax', 'cpa', 'ifrs', 'gaap', 'ledger'],
  banking:          ['banking', 'bank', 'credit', 'lending', 'mortgage', 'retail banking', 'commercial banking'],
  risk:             ['risk', 'risk management', 'enterprise risk', 'credit risk', 'market risk', 'operational risk'],
  fraud:            ['fraud', 'anti-fraud', 'fraud investigation', 'forensic', 'fincrime', 'whistleblower'],
  audit:            ['audit', 'auditor', 'internal audit', 'external audit', 'sox', 'assurance'],
  legal:            ['legal', 'lawyer', 'attorney', 'counsel', 'litigation', 'contract', 'paralegal'],
  insurance:        ['insurance', 'underwriting', 'actuary', 'claims', 'reinsurance', 'policyholder'],
  hr:               ['hr', 'human resources', 'recruitment', 'talent', 'people operations', 'payroll', 'hrbp'],
  administration:   ['administration', 'admin', 'office manager', 'executive assistant', 'receptionist', 'clerical'],
  sales:            ['sales', 'business development', 'account manager', 'revenue', 'inside sales', 'b2b'],
  marketing:        ['marketing', 'brand', 'digital marketing', 'seo', 'sem', 'social media', 'advertising'],
  product:          ['product manager', 'product owner', 'product management', 'roadmap', 'backlog'],
  operations:       ['operations', 'ops', 'process improvement', 'lean', 'six sigma', 'operational excellence'],
  procurement:      ['procurement', 'sourcing', 'vendor management', 'purchasing', 'tender', 'rfp'],
  supply_chain:     ['supply chain', 'logistics', 'warehouse', 'inventory', 'distribution', 'freight'],
  customer_support: ['customer service', 'customer support', 'helpdesk', 'call center', 'client success', 'cx'],
  data:             ['data', 'data analyst', 'data engineer', 'data science', 'machine learning', 'analytics', 'bi', 'tableau', 'power bi'],
  it:               ['it', 'information technology', 'it support', 'sysadmin', 'system administrator', 'helpdesk'],
  software:         ['software', 'developer', 'full stack', 'backend', 'frontend', 'react', 'node', 'python', 'java', 'devops'],
  cybersecurity:    ['cybersecurity', 'infosec', 'security analyst', 'penetration', 'soc', 'incident response', 'ciso'],
  erp_crm:          ['erp', 'sap', 'oracle', 'crm', 'salesforce', 'dynamics', 'netsuite', 'workday'],
  qa:               ['qa', 'quality assurance', 'testing', 'test engineer', 'automation testing', 'selenium', 'qc'],
  r_and_d:          ['r&d', 'research and development', 'innovation', 'scientist', 'laboratory', 'clinical trial'],
  engineering:      ['engineer', 'engineering', 'mechanical', 'electrical', 'chemical', 'industrial'],
  telecom:          ['telecom', 'telecommunications', '5g', 'wireless', 'fiber', 'voip'],
  network_admin:    ['network', 'network admin', 'cisco', 'lan', 'wan', 'firewall', 'routing'],
  hardware_it:      ['hardware', 'embedded', 'firmware', 'iot', 'pcb', 'semiconductor', 'chip'],
  architecture:     ['architecture', 'architect', 'building design', 'urban planning', 'cad', 'bim'],
  design:           ['design', 'ui', 'ux', 'graphic', 'creative', 'visual', 'illustration', 'figma'],
  media:            ['media', 'journalism', 'publishing', 'broadcast', 'entertainment', 'film', 'video'],
  content:          ['content', 'content writer', 'copywriter', 'editor', 'technical writer', 'blogging'],
  translation:      ['translation', 'interpreter', 'localization', 'linguist', 'bilingual', 'multilingual'],
  education:        ['education', 'teaching', 'academic', 'professor', 'instructor', 'curriculum', 'e-learning'],
  healthcare:       ['healthcare', 'medical', 'clinical', 'nursing', 'hospital', 'patient care', 'health'],
  pharma:           ['pharma', 'pharmaceutical', 'drug', 'biotech', 'clinical trial', 'regulatory affairs'],
  manufacturing:    ['manufacturing', 'production', 'factory', 'assembly', 'lean manufacturing', 'plant'],
  site_engineering: ['site engineer', 'construction engineer', 'field engineer', 'project engineer', 'site manager'],
  civil:            ['civil', 'civil engineering', 'structural', 'construction', 'building', 'infrastructure'],
  mech_electrical:  ['mechanical', 'electrical', 'hvac', 'plumbing', 'mep', 'power systems', 'motor'],
  hse:              ['hse', 'health safety', 'safety officer', 'ehs', 'occupational health', 'osha'],
  aviation:         ['aviation', 'airline', 'aerospace', 'pilot', 'aircraft', 'airport'],
  marine:           ['marine', 'maritime', 'shipping', 'vessel', 'port', 'offshore', 'naval'],
  oil_gas:          ['oil', 'gas', 'petroleum', 'upstream', 'downstream', 'refinery', 'drilling', 'energy'],
  mining:           ['mining', 'mineral', 'geology', 'exploration', 'ore', 'excavation'],
  security:         ['security', 'security guard', 'surveillance', 'loss prevention', 'physical security'],
  retail:           ['retail', 'ecommerce', 'e-commerce', 'merchandising', 'store', 'pos'],
  hospitality:      ['hospitality', 'hotel', 'restaurant', 'food service', 'chef', 'catering'],
  travel:           ['travel', 'tourism', 'tour', 'booking', 'destination', 'hospitality'],
  transport:        ['transport', 'transportation', 'fleet', 'driver', 'trucking', 'rail', 'courier'],
  government:       ['government', 'public sector', 'civil service', 'policy', 'public administration'],
  management:       ['management', 'general manager', 'director', 'vp', 'c-suite', 'executive', 'ceo', 'coo'],
  freshers:         ['fresher', 'intern', 'internship', 'graduate', 'trainee', 'entry level', 'apprentice'],
  other:            ['manager', 'analyst', 'coordinator', 'specialist', 'officer', 'consultant', 'advisor'],
};

// ── Country aliases (for location matching) ─────────────────────────────────
const COUNTRY_ALIASES = {
  india:      ['india', 'in'],
  uae:        ['uae', 'united arab emirates', 'dubai', 'abu dhabi'],
  uk:         ['uk', 'united kingdom', 'england', 'london', 'britain', 'gb'],
  usa:        ['usa', 'united states', 'us', 'america'],
  canada:     ['canada', 'ca'],
  australia:  ['australia', 'au'],
  singapore:  ['singapore', 'sg'],
};

function expandCountry(country) {
  if (!country) return [];
  const low = country.toLowerCase();
  const terms = [low];
  for (const aliases of Object.values(COUNTRY_ALIASES)) {
    if (aliases.some(a => low.includes(a))) {
      aliases.forEach(a => terms.push(a));
    }
  }
  return [...new Set(terms)];
}

// ── Experience level keywords ───────────────────────────────────────────────
const LEVEL_KEYWORDS = {
  fresher: ['fresher', 'intern', 'internship', 'graduate', 'trainee', 'entry level', 'junior', 'entry-level'],
  entry:   ['entry', 'junior', 'associate', 'entry level', 'entry-level', 'graduate'],
  mid:     ['mid', 'mid-level', 'mid level', 'intermediate', '3-5 years', '3+ years'],
  senior:  ['senior', 'lead', 'principal', 'staff', 'sr.', 'sr ', '7+ years', '5+ years'],
  lead:    ['lead', 'team lead', 'tech lead', 'principal'],
  manager: ['manager', 'head of', 'head -', 'director', 'vp'],
  executive: ['executive', 'c-suite', 'cxo', 'ceo', 'cfo', 'coo', 'cto', 'chief'],
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
  const candidateLevel = (profile.work_level || '').toLowerCase();

  // Determine candidate's industry keywords
  const industryKeywords = getIndustryKeywords(candidateIndustryRaw);

  // Desired role words (filter out very short/common words)
  const roleWords = desiredRole
    .split(/[\s,\-\/]+/)
    .map(w => w.trim())
    .filter(w => w.length > 2);

  // Expand country for alias matching
  const countryTerms = expandCountry(candidateCountry);

  // Preferred locations from repeater
  const preferredLocations = [];
  if (Array.isArray(profile.preferred_location)) {
    for (const loc of profile.preferred_location) {
      const prefCity = (loc.preferred_city_name || '').toLowerCase().trim();
      const prefCountry = (loc.preferred_country_name || '').toLowerCase().trim();
      if (prefCity || prefCountry) {
        preferredLocations.push({
          city: prefCity,
          country: prefCountry,
          countryTerms: expandCountry(prefCountry),
        });
      }
    }
  }

  // Experience level keywords for candidate
  const levelKeywords = LEVEL_KEYWORDS[candidateLevel] || [];

  const now = Date.now();
  const scored = [];

  for (const job of jobs) {
    const titleLow = (job.title || '').toLowerCase();
    const descLow  = (job.description || '').toLowerCase();
    const combined = titleLow + ' ' + descLow;
    const breakdown = { industry: 0, role: 0, location: 0, skills: 0, level: 0, freshness: 0 };

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

    // 3. Location match (+20) with country aliases + preferred locations
    const jobCountry  = (job.country || '').toLowerCase();
    const jobCity     = (job.city || '').toLowerCase();
    const jobLocation = (job.location || '').toLowerCase();
    const jobLocAll   = jobCountry + ' ' + jobCity + ' ' + jobLocation;

    if (job.is_remote) {
      breakdown.location += 10;
    }
    // Check residential location
    if (countryTerms.length > 0 && countryTerms.some(t => jobLocAll.includes(t))) {
      breakdown.location = Math.max(breakdown.location, 20);
    } else if (candidateCity && (jobCity.includes(candidateCity) || jobLocation.includes(candidateCity))) {
      breakdown.location = Math.max(breakdown.location, 20);
    }
    // Check preferred locations
    for (const loc of preferredLocations) {
      if (loc.city && (jobCity.includes(loc.city) || jobLocation.includes(loc.city))) {
        breakdown.location = Math.max(breakdown.location, 20);
        break;
      }
      if (loc.countryTerms.length > 0 && loc.countryTerms.some(t => jobLocAll.includes(t))) {
        breakdown.location = Math.max(breakdown.location, 15);
      }
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

    // 5. Experience level match (+10)
    if (levelKeywords.length > 0) {
      const match = levelKeywords.some(kw => titleLow.includes(kw));
      if (match) breakdown.level = 10;
    }

    // 6. Freshness bonus (+5)
    if (job.date_posted) {
      const posted = new Date(job.date_posted).getTime();
      const ageMs = now - posted;
      if (ageMs < 24 * 60 * 60 * 1000)      breakdown.freshness = 5;
      else if (ageMs < 7 * 24 * 60 * 60 * 1000) breakdown.freshness = 2;
    }

    // Total possible: 115 — displayed as % capped at 100
    const rawScore = breakdown.industry + breakdown.role + breakdown.location + breakdown.skills + breakdown.level + breakdown.freshness;
    if (rawScore >= 25) {
      const pct = Math.min(Math.round((rawScore / 115) * 100), 100);
      scored.push({ ...job, score: pct, score_raw: rawScore, score_breakdown: breakdown });
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
