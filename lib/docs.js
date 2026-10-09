// Pure helpers: document taxonomy, FY/AY parsing, intent detection, authorization.

const CATEGORIES = {
  kyc:      { folder: '01_KYC',                   perFy: false },
  received: { folder: '1_Received_from_Client',   perFy: true },
  working:  { folder: '2_Working_Statements',     perFy: true },
  filed:    { folder: '3_Filed_Returns',          perFy: true },
  notice:   { folder: '4_Notices_Correspondence', perFy: true }
};

// keys are matched as whole words/phrases (lower-case)
const DOC_TYPES = [
  { type: 'Form 16',                 category: 'received', keys: ['form 16', 'form16', 'form-16'] },
  { type: 'Bank Statement',          category: 'received', keys: ['bank statement', 'bank stmt', 'passbook'] },
  { type: 'Investment Proof',        category: 'received', keys: ['investment', '80c', 'rent receipt'] },
  { type: 'Other Document',          category: 'received', keys: [] },
  { type: 'Computation of Income',   category: 'working',  keys: ['computation', 'workings'] },
  { type: 'Tax Computation Summary', category: 'working',  keys: ['tax summary', 'computation summary'] },
  { type: 'ITR-V',                   category: 'filed',    keys: ['itr-v', 'itrv', 'itr v'] },
  { type: 'ITR Acknowledgement',     category: 'filed',    keys: ['acknowledgement', 'acknowledgment', 'ack'] },
  { type: 'Filed ITR (JSON)',        category: 'filed',    keys: ['json'] },
  { type: 'Notice',                  category: 'notice',   keys: ['notice', 'intimation', 'demand'] },
  { type: 'PAN Card',                category: 'kyc',      keys: ['pan card', 'pan'] },
  { type: 'Aadhaar',                 category: 'kyc',      keys: ['aadhaar', 'aadhar'] }
];
const ITR_GROUP = ['ITR-V', 'ITR Acknowledgement', 'Filed ITR (JSON)'];
const CLIENT_UPLOAD_CATEGORIES = ['received', 'kyc']; // clients may not write into working/filed/notice

const hasKey = (text, key) => String(text || '').toLowerCase().includes(String(key || '').toLowerCase());
const typeInfo = (type) => DOC_TYPES.find((d) => d.type === type) || null;

// ---------- financial year helpers ----------
function isValidFy(fy) {
  if (!fy || typeof fy !== 'string') return false;
  const parts = fy.split('-');
  if (parts.length !== 2) return false;
  const y1 = parseInt(parts[0], 10);
  const y2 = parseInt(parts[1], 10);
  return !isNaN(y1) && !isNaN(y2) && y1 >= 2000 && y1 <= 2099 && y2 === (y1 + 1) % 100;
}
const mkFy = (start) => `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
const fyToAy = (fy) => mkFy(parseInt(fy.slice(0, 4), 10) + 1);
const fyLabel = (fy) => `FY ${fy} (AY ${fyToAy(fy)})`;
const fyFolderName = (fy) => `FY ${fy} (AY ${fyToAy(fy)})`;

// Most recent *completed* FY. Oct 2026 -> 2025-26.
function latestCompletedFy(now = new Date()) {
  const y = now.getMonth() >= 3 ? now.getFullYear() - 1 : now.getFullYear() - 2;
  return mkFy(y);
}

// Returns { fy } | { ask: [fy, fy] } | null
function parseYear(text) {
  const t = String(text || '');
  const tail = '(?!\\d|[-/]\\d)';
  let m = new RegExp(`\\b(?:fy|f\\.y\\.|financial year)\\s*[:\\-]?\\s*(20\\d{2})\\s*[-/\\u2013]\\s*(?:\\d{2}|\\d{4})${tail}`, 'i').exec(t);
  if (m) return { fy: mkFy(+m[1]) };
  m = new RegExp(`\\b(?:ay|a\\.y\\.|assessment year)\\s*[:\\-]?\\s*(20\\d{2})\\s*[-/\\u2013]\\s*(?:\\d{2}|\\d{4})${tail}`, 'i').exec(t);
  if (m) return { fy: mkFy(+m[1] - 1) };
  m = /\bay\s*[:\-]?\s*(20\d{2})\b(?![-/]\d)/i.exec(t);
  if (m) return { fy: mkFy(+m[1] - 1) };
  m = /\bfy\s*[:\-]?\s*(20\d{2})\b(?![-/]\d)/i.exec(t);
  if (m) return { fy: mkFy(+m[1]) };
  m = new RegExp(`\\b(20\\d{2})\\s*[-/\\u2013]\\s*(?:\\d{2}|\\d{4})${tail}`).exec(t);
  if (m) return { ask: [mkFy(+m[1] - 1), mkFy(+m[1])] };   // "2024-25": FY or AY?
  m = /(?<![-/\d])\b(20\d{2})\b(?![-/]\d)/.exec(t);
  if (m) return { ask: [mkFy(+m[1] - 1), mkFy(+m[1])] };   // "2024": return for FY 2023-24 or 2024-25?
  return null;
}

// ---------- intent detection ----------
const VERBS = ['send', 'give', 'get', 'show', 'fetch', 'download', 'find', 'need', 'want', 'share', 'provide', 'retrieve', 'pull', 'copy of'];
const GENERIC_OBJECTS = ['itr', 'it return', 'income tax return', 'document', 'documents', 'file', 'files', 'statement', 'statements', 'certificate', 'kyc', 'acknowledgement', 'acknowledgment', 'computation', 'notice'];

function matchDocTypes(text) {
  const hits = DOC_TYPES.filter((d) => d.keys.some((k) => hasKey(text, k))).map((d) => d.type);
  if (hits.length) return hits;
  const lower = String(text || '').toLowerCase();
  if (lower.includes('itr') || lower.includes('it return') || lower.includes('income tax return')) return ITR_GROUP;
  return null;
}

function looksLikeFileRequest(text) {
  const t = String(text || '').toLowerCase();
  if (t.includes('task') || t.includes('recommend') || t.includes('assign') || t.includes('attendance') || t.includes('present') || t.includes('absent')) return false;
  const specific = DOC_TYPES.some((d) => d.keys.some((k) => hasKey(t, k)));
  const object = specific || GENERIC_OBJECTS.some(obj => t.includes(obj));
  if (!object) return false;
  return VERBS.some(v => t.includes(v)) || specific || parseYear(t) !== null;
}

// ---------- authorization ----------
const STAFF_ROLES = ['partner', 'staff', 'article'];
function canAccessDoc(decoded, doc) {
  if (!decoded || !doc) return false;
  if (STAFF_ROLES.includes(decoded.role)) return true;
  if (decoded.role === 'client') {
    return Number.isInteger(decoded.clientId) && doc.clientId === decoded.clientId && doc.clientVisible !== false;
  }
  return false;
}

function safeFileName(name) {
  const base = String(name || 'file').split(/[\\/]/).pop().replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
  return (base || 'file').slice(0, 150);
}

module.exports = {
  CATEGORIES, DOC_TYPES, ITR_GROUP, CLIENT_UPLOAD_CATEGORIES, STAFF_ROLES,
  typeInfo, hasKey, isValidFy, fyToAy, fyLabel, fyFolderName, latestCompletedFy,
  parseYear, matchDocTypes, looksLikeFileRequest, canAccessDoc, safeFileName
};