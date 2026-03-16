// config/industries.js — Supported industries for Naukri job search
// Used by backend (require) and mirrored in frontend dashboard.

const SUPPORTED_INDUSTRIES = {
  accounting:    { label: 'Accounting / Taxation / Audit',       subs: ['Accounts Payable', 'Accounts Receivable', 'GST', 'Taxation', 'Bookkeeping', 'Reconciliation'] },
  audit:         { label: 'Audit & Assurance',                   subs: ['Internal Audit', 'External Audit', 'SOX Compliance', 'Statutory Audit', 'IS Audit'] },
  banking:       { label: 'Banking / Financial Services',        subs: ['Retail Banking', 'Trade Finance', 'Loan Processing', 'Credit Analysis', 'NBFC'] },
  compliance:    { label: 'Compliance / Regulatory',             subs: ['KYC', 'AML', 'Transaction Monitoring', 'Sanctions', 'CKYC', 'FATF Compliance'] },
  cybersecurity: { label: 'Cybersecurity / InfoSec',             subs: ['SOC Analyst', 'VAPT', 'InfoSec', 'Penetration Testing', 'Vulnerability Assessment'] },
  finance:       { label: 'Finance / Treasury',                  subs: ['Treasury', 'Cash Management', 'FP&A', 'Corporate Finance', 'Financial Planning'] },
  fraud:         { label: 'Fraud / Anti-Fraud',                  subs: ['Fraud Analyst', 'AML', 'Chargeback', 'Fraud Investigation', 'Anti-Money Laundering'] },
  hr:            { label: 'Human Resources / People Ops',        subs: ['Talent Acquisition', 'Recruiter', 'HRBP', 'Learning & Development', 'Payroll', 'HR Generalist'] },
  it:            { label: 'IT / Systems',                        subs: ['System Admin', 'Network Admin', 'IT Support', 'Infrastructure', 'ERP', 'IT Operations'] },
  risk:          { label: 'Risk Management',                     subs: ['Credit Risk', 'Market Risk', 'Operational Risk', 'Basel', 'Risk Analyst'] },
  software:      { label: 'Software Development / Engineering',  subs: ['React', 'Node.js', 'Python', 'Java', 'Full Stack Developer', 'Backend', 'Frontend'] },
};

const SUPPORTED_COUNTRIES = [
  { code: 'CA', label: 'Canada' },
  { code: 'IN', label: 'India' },
  { code: 'SG', label: 'Singapore' },
  { code: 'AE', label: 'UAE' },
  { code: 'GB', label: 'United Kingdom' },
  { code: 'US', label: 'United States' },
];

module.exports = { SUPPORTED_INDUSTRIES, SUPPORTED_COUNTRIES };
