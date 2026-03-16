// jobs/matcher.js — Match jobs to candidate Job Preferences (not residential address)

// ── Generic title words to skip when matching desired_role ───────────────────
const GENERIC_WORDS = new Set([
  'manager','senior','junior','assistant','associate',
  'lead','head','director','officer','executive',
  'analyst','specialist','consultant','coordinator',
  'advisor','expert','principal','deputy','global',
  'group','regional','area','general','chief',
]);

// ── Common specific words that must appear in job TITLE (too generic for description match) ──
const COMMON_SPECIFIC_WORDS = new Set([
  'data', 'sales', 'finance', 'hr', 'it',
  'marketing', 'legal', 'operations', 'admin',
]);

// ── Country name → ISO 2-letter code mapping ─────────────────────────────────
const COUNTRY_NAME_TO_CODE = {
  'india': 'IN',
  'united arab emirates': 'AE',
  'united kingdom': 'GB',
  'united states': 'US',
  'canada': 'CA',
  'australia': 'AU',
  'singapore': 'SG',
  'dubai': 'AE',
  'uae': 'AE',
  'uk': 'GB',
  'usa': 'US',
  'america': 'US',
  'england': 'GB',
  'britain': 'GB',
  'abu dhabi': 'AE',
  'sharjah': 'AE',
};

function getCountryCode(countryName) {
  if (!countryName) return null;
  const key = countryName.toLowerCase().trim();
  return COUNTRY_NAME_TO_CODE[key] || key.toUpperCase();
}

// ── Industry keyword map — all 53 AGZIT industries ──────────────────────────
const INDUSTRY_KEYWORDS = {
  compliance:       ['compliance','regulatory','regulation','aml','kyc','fincrime','financial crime','governance','cdd','sanctions','anti-money','anti money laundering','bsa','mlro','cco','know your customer','due diligence','fatf','pep screening','transaction monitoring'],
  finance:          ['finance','financial','cfo','treasurer','treasury','fp&a','financial planning','financial analyst','budgeting','fintech'],
  accounting:       ['accounting','accountant','cpa','chartered accountant','bookkeeping','ca ','accounts payable','accounts receivable','cima'],
  banking:          ['banking','banker','branch','retail bank','commercial bank','investment bank','private banking','wealth management','nbfc'],
  risk:             ['risk','risk management','risk analyst','credit risk','market risk','operational risk','enterprise risk','rcsa','risk officer'],
  fraud:            ['fraud','fraud analyst','fraud prevention','fraud detection','anti-fraud','financial crime','investigation'],
  audit:            ['audit','auditor','internal audit','external audit','it audit','sox','sarbanes','internal assurance'],
  legal:            ['legal','lawyer','solicitor','counsel','attorney','paralegal','contract'],
  insurance:        ['insurance','actuary','underwriter','claims','reinsurance'],
  hr:               ['hr','human resources','hrbp','talent acquisition','recruitment','recruiter','people operations','learning development','compensation','payroll','workforce'],
  administration:   ['admin','administrator','office manager','executive assistant','personal assistant','operations admin'],
  sales:            ['sales','account executive','business development','account manager','revenue','bdr','sdr'],
  marketing:        ['marketing','brand','digital marketing','seo','content marketing','growth','demand generation'],
  product:          ['product manager','product owner','product lead','product strategy','roadmap'],
  operations:       ['operations','ops','operational','process improvement','business operations'],
  procurement:      ['procurement','purchasing','buyer','sourcing','vendor management','category manager'],
  supply_chain:     ['supply chain','logistics','warehouse','inventory','distribution','fulfillment','scm'],
  customer_support: ['customer support','customer service','customer success','helpdesk','support agent'],
  data:             ['data analyst','data scientist','data engineer','bi ','business intelligence','analytics','tableau','power bi','sql'],
  it:               ['it support','it manager','systems administrator','infrastructure','it operations'],
  software:         ['software engineer','software developer','full stack','frontend','backend','mobile developer','react','node.js','python developer','java developer'],
  cybersecurity:    ['cybersecurity','information security','infosec','soc analyst','penetration','cissp','ciso','security analyst'],
  erp_crm:          ['sap','oracle erp','salesforce','dynamics','erp','crm implementation','d365'],
  qa:               ['qa engineer','quality assurance','test','testing','automation test','selenium'],
  r_and_d:          ['research','r&d','researcher','scientist','lab','innovation'],
  engineering:      ['engineer','mechanical','electrical','civil engineer','structural','process engineer','chemical'],
  telecom:          ['telecom','telecommunications','network engineer','rf engineer','5g','lte'],
  network_admin:    ['network admin','network engineer','cisco','ccna','ccnp','lan','wan','routing','switching'],
  hardware_it:      ['hardware','field engineer','desktop support','it technician'],
  architecture:     ['architect','architecture','urban','building design','revit','autocad'],
  design:           ['designer','graphic design','ui/ux','ux designer','ui designer','figma'],
  media:            ['media','journalist','editor','video production','broadcast'],
  content:          ['content writer','copywriter','content strategist','technical writer'],
  translation:      ['translator','interpreter','localization','language specialist'],
  education:        ['teacher','lecturer','professor','trainer','educator','curriculum','academic'],
  healthcare:       ['doctor','nurse','physician','medical','clinical','healthcare','hospital','patient care'],
  pharma:           ['pharmaceutical','pharma','drug','clinical trial','regulatory affairs pharma','medical device'],
  manufacturing:    ['manufacturing','production','plant manager','factory','quality control','lean','six sigma'],
  site_engineering: ['site engineer','construction','project engineer','site manager'],
  civil:            ['civil engineer','structural','geotechnical','surveyor','quantity surveyor'],
  mech_electrical:  ['mechanical engineer','electrical engineer','hvac','plumbing','electromechanical','maintenance engineer'],
  hse:              ['hse','health safety','safety officer','ehs','environmental health','osha','nebosh'],
  aviation:         ['aviation','pilot','cabin crew','airline','airport','air traffic','aeronautical'],
  marine:           ['marine','maritime','seafarer','naval','shipping','port','vessel','offshore marine'],
  oil_gas:          ['oil','gas','petroleum','upstream','downstream','refinery','drilling','offshore'],
  mining:           ['mining','geologist','mine','extraction','minerals'],
  security:         ['security guard','security manager','cctv','loss prevention','physical security'],
  retail:           ['retail','store manager','merchandising','shop','buyer retail'],
  hospitality:      ['hotel','hospitality','restaurant','food beverage','front desk','chef'],
  travel:           ['travel','tourism','tour operator','travel agent','destination'],
  transport:        ['transport','driver','logistics driver','fleet','dispatch','courier'],
  government:       ['government','public sector','civil service','municipal','ministry','policy'],
  management:       ['manager','director','vp ','vice president','head of','managing director','general manager','ceo'],
  freshers:         ['graduate','fresher','entry level','trainee','intern','apprentice','junior'],
  other:            [],
};

// ── Spam filter ──────────────────────────────────────────────────────────────
function isSpamJob(job) {
  const title = (job.title || '').toLowerCase();
  const company = (job.company || '').toLowerCase();

  const spamTitlePhrases = [
    'apply now bank job', 'bank job vacancies open in your city',
    'fresher and experienced both', 'job salary =',
    'urgent requirements', 'various post available',
    'male and female candidate', 'job requirements for male',
    'good bank job vacancies', 'join bank job vacancies',
  ];

  if (spamTitlePhrases.some(phrase => title.includes(phrase))) return true;

  // Company "confidential" with very generic title
  if (company === 'confidential' &&
      (title.includes('bank job') || title.includes('apply now') || title.includes('vacancies open'))) {
    return true;
  }

  return false;
}

// ── Matching engine ─────────────────────────────────────────────────────────
function matchJobsForCandidate(profile, jobs) {
  if (!jobs || !jobs.length) return [];

  // ── Parse Job Preferences ─────────────────────────────────────────────────
  const desiredRole    = (profile.desired_role || '').toLowerCase().trim();
  const workType       = (profile.preferred_work_type || '').toLowerCase();
  const workLevel      = (profile.work_level || '').toLowerCase();
  const openToRelocate = profile.open_to_relocate === '1';
  const experience     = parseInt(profile.total_work_experience) || 0;
  const skills         = (profile.soft_skills || '').split(',').map(s => s.trim().toLowerCase()).filter(s => s.length > 2);

  // ── Parse industry ────────────────────────────────────────────────────────
  let industries = [];
  try {
    const raw = profile.compliance_domains;
    if (!raw) industries = [];
    else if (raw.startsWith('[')) industries = JSON.parse(raw);
    else industries = [raw];
  } catch (_) {
    industries = [profile.compliance_domains || ''];
  }
  industries = industries.map(i => (i || '').toLowerCase().trim()).filter(Boolean);

  // ── Parse preferred locations (from Job Preferences repeater) ─────────────
  // Profile keys: preferred_location (count), preferred_location_N_preferred_city_name, preferred_location_N_preferred_country_name
  const preferredLocations = [];
  const count = parseInt(profile['preferred_location'] || '0');
  for (let i = 0; i < Math.max(count, 10); i++) {
    const city    = profile[`preferred_location_${i}_preferred_city_name`];
    const country = profile[`preferred_location_${i}_preferred_country_name`];
    if (!city && !country) continue;
    preferredLocations.push({
      city:        (city || '').toLowerCase().trim(),
      country:     (country || '').toLowerCase().trim(),
      countryCode: getCountryCode(country || ''),
    });
  }

  // Build flat sets for fast lookup
  const acceptableCities = new Set(preferredLocations.map(l => l.city).filter(Boolean));
  const acceptableCountryCodes = new Set(preferredLocations.map(l => l.countryCode).filter(Boolean));

  // Debug: log candidate prefs once per call
  console.log('[matcher-debug] candidate prefs:', JSON.stringify({
    preferredLocations, acceptableCountryCodes: [...acceptableCountryCodes],
    acceptableCities: [...acceptableCities], workType, openToRelocate, desiredRole
  }));

  // ── Spam filter ─────────────────────────────────────────────────────────
  const cleanJobs = jobs.filter(job => !isSpamJob(job));

  // ── Score each job ────────────────────────────────────────────────────────
  const scored = cleanJobs.map(job => {
    let score = 0;
    const breakdown = {};

    const jobText     = ((job.title || '') + ' ' + (job.description || '') + ' ' + (job.company || '')).toLowerCase();
    const jobTitle    = (job.title || '').toLowerCase();
    const jobCountry  = (job.country || '').toLowerCase();
    const jobCity     = (job.city || '').toLowerCase();
    const jobLocation = (job.location || '').toLowerCase();
    const isRemote    = job.is_remote === 1 || job.is_remote === true;

    // ── STEP 1: LOCATION FILTER (non-negotiable) ────────────────────────────
    if (preferredLocations.length > 0) {
      let locationOk = false;
      const jobCountryCode = (job.country || '').toUpperCase().trim();

      if (workType === 'remote') {
        locationOk = isRemote;
      } else {
        // on_site, hybrid, or unspecified
        if (isRemote) {
          locationOk = openToRelocate;
        } else {
          const countryOk = acceptableCountryCodes.has(jobCountryCode);
          const cityOk = [...acceptableCities].some(city =>
            city && (jobCity.includes(city) || jobLocation.includes(city)));
          locationOk = countryOk || cityOk;
          // open_to_relocate = within preferred COUNTRIES only, not worldwide
          if (!locationOk && openToRelocate) locationOk = countryOk;
        }
      }

      if (!locationOk) {
        return { ...job, score: 0, score_breakdown: { filtered: 'location' } };
      }
    }

    // ── STEP 1B: ROLE RELEVANCE FILTER (hard filter) ────────────────────────
    const _specificWords = desiredRole
      ? desiredRole.split(/[\s,\-\/]+/).filter(w => w.length > 2 && !GENERIC_WORDS.has(w))
      : [];
    if (_specificWords.length > 0) {
      const titleCheck = _specificWords.some(w => jobTitle.includes(w));
      const descCheck  = _specificWords.some(w => jobText.substring(0, 500).includes(w));

      // Common words like "data", "sales" must appear in TITLE to avoid false matches
      const hasCommonWord = _specificWords.some(w => COMMON_SPECIFIC_WORDS.has(w));
      let roleFound = hasCommonWord ? titleCheck : (titleCheck || descCheck);

      // KYC equivalent roles — AML/FinCrime jobs are relevant for KYC candidates
      if (!roleFound && desiredRole.includes('kyc')) {
        const kycEquivalents = ['aml','anti money','financial crime','fincrime','due diligence','sanctions','compliance analyst'];
        roleFound = kycEquivalents.some(kw => jobTitle.includes(kw));
      }

      if (!roleFound) {
        return { ...job, score: 0, score_breakdown: { filtered: 'role' } };
      }
    }

    // ── STEP 2: INDUSTRY MATCH (+40) ────────────────────────────────────────
    let industryScore = 0;
    for (const ind of industries) {
      const keywords = INDUSTRY_KEYWORDS[ind] || [ind];
      if (keywords.some(kw => jobText.includes(kw))) { industryScore = 40; break; }
    }
    score += industryScore;
    breakdown.industry = industryScore;

    // ── STEP 3: DESIRED ROLE MATCH (+25) ────────────────────────────────────
    let roleScore = 0;
    if (desiredRole) {
      if (jobTitle.includes(desiredRole) || desiredRole.includes(jobTitle)) {
        roleScore = 25;
      } else {
        const specificWords = desiredRole.split(/[\s,\-\/]+/).filter(w => w.length > 2 && !GENERIC_WORDS.has(w));
        const specificHits  = specificWords.filter(w => jobTitle.includes(w) || jobText.includes(w));

        if (specificWords.length > 0) {
          if (specificHits.length >= 2) roleScore = 25;
          else if (specificHits.length === 1) roleScore = 15;
        } else {
          // All words are generic (e.g. "Senior Manager") — check title overlap
          const genericHits = desiredRole.split(/[\s,\-\/]+/).filter(w => GENERIC_WORDS.has(w) && jobTitle.includes(w));
          if (genericHits.length >= 1) roleScore = 8;
        }
      }
    }
    // KYC equivalent role bonus
    if (desiredRole.includes('kyc') && roleScore === 0) {
      const kycEquivalents = ['aml','anti money','financial crime','fincrime','due diligence','sanctions','compliance analyst'];
      if (kycEquivalents.some(kw => jobTitle.includes(kw))) roleScore = 12;
    }
    score += roleScore;
    breakdown.role = roleScore;

    // ── STEP 4: LOCATION SCORE (+20) ────────────────────────────────────────
    let locationScore = 0;
    const jobCC = (job.country || '').toUpperCase().trim();
    if (isRemote && workType === 'remote') {
      locationScore = 20;
    } else if (!isRemote) {
      const cityMatch    = [...acceptableCities].some(city => city && (jobCity.includes(city) || jobLocation.includes(city)));
      const countryMatch = acceptableCountryCodes.has(jobCC);
      if (cityMatch) locationScore = 20;
      else if (countryMatch) locationScore = 15;
      else if (openToRelocate && countryMatch) locationScore = 5;
    } else if (isRemote && openToRelocate) {
      locationScore = 10;
    }
    score += locationScore;
    breakdown.location = locationScore;

    // ── STEP 5: SKILLS MATCH (+15) ──────────────────────────────────────────
    let skillScore = 0;
    for (const skill of skills) {
      if (skill.length > 2 && jobText.includes(skill)) skillScore += 3;
    }
    skillScore = Math.min(skillScore, 15);
    score += skillScore;
    breakdown.skills = skillScore;

    // ── STEP 6: EXPERIENCE LEVEL MATCH (+10) ────────────────────────────────
    const levelMap = {
      executive: ['director','vp ','vice president','chief','cxo','c-suite','head of'],
      manager:   ['manager','head','lead','principal','senior manager','deputy'],
      senior:    ['senior','sr.','sr ','lead','principal'],
      mid:       [],
      entry:     ['junior','associate','graduate','trainee','intern','entry'],
      fresher:   ['fresher','graduate','entry','junior','trainee','intern'],
    };
    let expScore = 0;
    const levelWords = levelMap[workLevel] || [];
    if (workLevel === 'mid') {
      const overqualified = ['director','vp ','chief','head of'].some(w => jobTitle.includes(w));
      expScore = overqualified ? 0 : 10;
    } else if (levelWords.length > 0) {
      expScore = levelWords.some(w => w && jobTitle.includes(w)) ? 10 : 3;
    } else {
      expScore = 5;
    }
    score += expScore;
    breakdown.level = expScore;

    // ── STEP 7: FRESHNESS BONUS (+5) ────────────────────────────────────────
    let freshScore = 0;
    if (job.date_posted) {
      const hoursOld = (Date.now() - new Date(job.date_posted).getTime()) / 3600000;
      if (hoursOld <= 24) freshScore = 5;
      else if (hoursOld <= 168) freshScore = 2;
    }
    score += freshScore;
    breakdown.freshness = freshScore;

    return { ...job, score: Math.min(100, Math.round(score)), score_raw: score, score_breakdown: breakdown };
  });

  // Deduplicate by title + company
  const seen = new Set();
  const deduped = scored.filter(job => {
    const key = `${(job.title || '').toLowerCase().trim()}__${(job.company || '').toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped
    .filter(j => j.score >= 70)
    .sort((a, b) => b.score - a.score || new Date(b.date_posted || 0) - new Date(a.date_posted || 0))
    .slice(0, 25);
}

function getMatchLabel(score) {
  if (score >= 80) return { label: 'Excellent match', color: 'green' };
  if (score >= 60) return { label: 'Good match', color: 'blue' };
  if (score >= 40) return { label: 'Possible match', color: 'gray' };
  return { label: 'Low match', color: 'muted' };
}

module.exports = { matchJobsForCandidate, getMatchLabel };
