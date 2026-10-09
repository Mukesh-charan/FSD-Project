# Google Drive Integration for the CA Office Chatbot

Adds two things to your existing chatbot:

1. **Ask for a file** ("send my 2024 IT return") → the bot finds it, shows options if there are several, and the user taps to download it in the chat.
2. **Upload a file** (📎 in the chat) → the bot guesses client / year / type, asks to confirm, and saves it in the right Drive folder.

Files in this package: `GOOGLE_DRIVE_INTEGRATION.md` (this guide), `drive-integration.patch` (all code changes), `seed_drive_demo.py` (demo data), `drive_e2e_test.js` (offline test).

---

## 1. What I found in your code (this shaped the design)

| Finding | Consequence |
|---|---|
| The chatbot (`api/chat.js`) is **rule-based** (regex + MongoDB queries), not an LLM. | I followed the same style. File requests are detected by keywords. If you add an LLM later, the same functions can be exposed as tools. |
| Roles today are only `partner`, `staff`, `article`. **There is no `client` role**, and nothing links a login to a client record. | Added `role: 'client'` + `clientId` on the user, carried inside the JWT. Authorization is enforced from the token, never from what the user types. |
| `chat.js` only checks that the token is valid. A client token would reach the task/client search and `advance_status`. | Added a hard fence: a client token can only reach document features (§6.3). **Do this before creating any client login.** |
| `api/drive.js` has `listFiles` open to any logged-in user, builds the query by string concatenation, and has no Shared Drive support. `chat.js` also has a Drive search that links files nobody can open. | Replaced `drive.js` with a partner-only health check, removed the old search, and added `api/files.js`. |
| Drive credentials were stored in MongoDB (`settings`). | Now read from environment variables only. |
| The app is deployed on **Vercel**, which rejects request bodies over **4.5 MB** (confirmed in Vercel docs). | The app has no policy limit on file size, but the chat upload is capped at 3 MB until you do §10. Running with `node server.js` has no such cap. |

### Decisions I made from your answers (change any you disagree with)

- **"2023-2026"** is read as financial years **FY 2023-24, 2024-25, 2025-26**. Change with `--years`.
- **Staff and article** see all clients' files; **partner (owner)** sees everything; **client** sees every file in their own folder (nothing hidden).
- **Clients can upload only to "Received" and "KYC"**, never into Working / Filed / Notices, so a client cannot place a fake "ITR-V" in their filed-returns folder. Staff and partner can upload anywhere.
- **"2024 ITR" is ambiguous** (FY 2023-24 filed in 2024, or FY 2024-25?). The bot asks with two tap options instead of guessing.
- Uploads never overwrite: a same-named file becomes `name_v2.ext`.

---

## 2. How it works

```
Browser chat ──► /api/chat   (finds files in MongoDB, returns tap-to-download chips)
     │
     ├── chip "⬇️ file" ──► GET  /api/files?action=download&id=<documents._id>
     │                         checks token + ownership ─► streams from Drive
     └── 📎 + confirm  ──► POST /api/files  action=upload
                               checks token ─► Drive upload ─► MongoDB record
```

- **MongoDB is the index.** Every file has a row in `documents`. The bot searches MongoDB (fast, exact), never Drive.
- **Drive is the storage.** Only the server talks to Drive, using a service account. Nothing is made public, and the browser never sees a Drive ID or link.
- The download chip carries only the `documents._id`. The server re-checks the logged-in user against that record every time.

---

## 3. Folder structure

```
Clients/                                   ← inside a Shared Drive
└── 1005_Ramesh Kumar/                     ← <clients.id>_<name>
    ├── 01_KYC/                            ← PAN, Aadhaar (not tied to a year)
    ├── FY 2023-24 (AY 2024-25)/
    │   ├── 1_Received_from_Client/        ← Form 16, bank statement, proofs
    │   ├── 2_Working_Statements/          ← computation, summary
    │   ├── 3_Filed_Returns/               ← ITR-V, acknowledgement, filed JSON
    │   └── 4_Notices_Correspondence/
    ├── FY 2024-25 (AY 2025-26)/ ...same
    └── FY 2025-26 (AY 2026-27)/ ...same
```

The client ID is in the folder name because names repeat and change. The app finds folders by stored ID, so renaming a folder in Drive does not break anything. GST can be added later as another folder.

## 4. Data model (MongoDB)

```js
// documents  (one row per file; this is what the bot searches)
{ clientId: 1005, clientName, fy: '2023-24', ay: '2024-25',   // fy/ay null for KYC
  category: 'received|working|filed|notice|kyc', docType: 'Form 16',
  fileName, originalFileName, driveFileId, driveFolderId, folderPath,
  mimeType, size, clientVisible: true,                         // flip to false to hide from the client
  uploadedBy, uploadedByRole, uploadedAt, source: 'chat|seed' }

// drive_folders  (cache so Drive is never searched)   { clientId, path, folderId }
// users          (client logins)                      { ..., role: 'client', clientId: 1005 }
```

Indexes are created automatically on first use.

---

## 5. Google setup (you have Workspace admin)

1. **Shared Drive**: Drive → *Shared drives* → New (e.g. "CA Client Vault"). Inside it create a folder **Clients**. Open it and copy the ID from the URL (`.../folders/<THIS_PART>`). This is `GOOGLE_DRIVE_ROOT_FOLDER_ID`.
   *Use a Shared Drive, not "My Drive": service accounts have no storage quota of their own, so uploads into a normal folder fail.*
2. **Google Cloud**: create a project → enable **Google Drive API** → IAM → Service Accounts → create one → Keys → **Add key → JSON**. If key creation is blocked, your org has the policy `iam.disableServiceAccountKeyCreation` and an admin must allow it.
3. **Give the service account access**: open the Shared Drive → *Manage members* → add the service account's e-mail (`...@...iam.gserviceaccount.com`) as **Content manager**. If Drive refuses it, check the Shared Drive / sharing settings in the Admin console.
4. **Environment variables** (`.env.local` locally, Vercel project settings in production):

```env
GOOGLE_SERVICE_ACCOUNT_EMAIL=...@...iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
GOOGLE_DRIVE_ROOT_FOLDER_ID=<Clients folder id>
```

`drive-integration.patch` also adds a `.env.example` and git-ignores `service-account*.json` and `sample_data/`. **Never commit the key file.**

---

## 6. Backend changes

### 6.0 Fastest way: apply the patch

```bash
cd Workflow-Management-sanjjey-2
patch -p1 < drive-integration.patch        # or: git apply drive-integration.patch
```

The patch contains everything in §6 and §7. I applied it to a fresh copy of your zip, and syntax checks plus the tests pass. The sections below are what it contains, so you can review or apply by hand.

### 6.1 New files

**`lib/driveClient.js`**: Drive calls + folder cache (no new npm packages; uses Node 18+ `fetch`)

```js
// Minimal Google Drive v3 client for a service account + Shared Drive.
// No extra npm packages needed (uses Node 18+ global fetch).
const crypto = require('crypto');

let cachedToken = null; // { token, exp }

function getDriveConfig() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!email || !key || !rootFolderId) return null;
  return { email, privateKey: key.replace(/\\n/g, '\n'), rootFolderId };
}

async function getAccessToken(cfg) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: cfg.email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(cfg.privateKey, 'base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sig}`
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Google token request failed');
  cachedToken = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return cachedToken.token;
}

async function createFolder(cfg, name, parentId) {
  const token = await getAccessToken(cfg);
  const res = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,name', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Drive: folder create failed');
  return data.id;
}

async function uploadFile(cfg, { name, mimeType, buffer, parentId }) {
  const token = await getAccessToken(cfg);
  const boundary = 'ca_office_' + crypto.randomBytes(8).toString('hex');
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name, parents: [parentId] }) +
      `\r\n--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`
    ),
    buffer,
    Buffer.from(`\r\n--${boundary}--`)
  ]);
  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,size,mimeType',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'Drive: upload failed');
  return data; // { id, name, size, mimeType }
}

// Returns the raw fetch Response so the caller can stream it.
async function downloadFile(cfg, fileId) {
  const token = await getAccessToken(cfg);
  return fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

const cleanName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
const clientFolderName = (id, name) => `${id}_${cleanName(name)}`;

// Folder IDs are cached in Mongo (drive_folders). Path '' = the client's root folder.
async function ensureFolder(db, cfg, clientId, clientName, relPath) {
  const col = db.collection('drive_folders');
  const hit = await col.findOne({ clientId, path: relPath });
  if (hit) return hit.folderId;

  const parts = relPath ? relPath.split('/') : [];
  const parentId = parts.length === 0
    ? cfg.rootFolderId
    : await ensureFolder(db, cfg, clientId, clientName, parts.slice(0, -1).join('/'));
  const name = parts.length === 0 ? clientFolderName(clientId, clientName) : parts[parts.length - 1];

  const folderId = await createFolder(cfg, name, parentId);
  try {
    await col.insertOne({ clientId, path: relPath, folderId, createdAt: new Date() });
  } catch (e) {
    if (e.code === 11000) { // parallel request won the race; use its folder
      const again = await col.findOne({ clientId, path: relPath });
      if (again) return again.folderId;
    }
    throw e;
  }
  return folderId;
}

async function ensureIndexes(db) {
  await db.collection('drive_folders').createIndex({ clientId: 1, path: 1 }, { unique: true });
  await db.collection('documents').createIndex({ clientId: 1, fy: 1, category: 1 });
  await db.collection('documents').createIndex({ driveFileId: 1 }, { unique: true });
}

module.exports = { getDriveConfig, getAccessToken, uploadFile, downloadFile, ensureFolder, ensureIndexes, clientFolderName };
```

**`lib/docs.js`**: document types, FY/AY parsing, intent detection, authorization rule

```js
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

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasKey = (text, key) => new RegExp(`(^|[^a-z0-9])${esc(key)}([^a-z0-9]|$)`, 'i').test(text);
const typeInfo = (type) => DOC_TYPES.find((d) => d.type === type) || null;

// ---------- financial year helpers ----------
const FY_RE = /^(20\d{2})-(\d{2})$/;
function isValidFy(fy) {
  const m = FY_RE.exec(String(fy));
  return !!m && parseInt(m[2], 10) === (parseInt(m[1], 10) + 1) % 100;
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
const VERBS = /\b(send|give|get|show|fetch|download|find|need|want|share|provide|retrieve|pull|copy of)\b/i;
const GENERIC_OBJECTS = /\b(itr|it returns?|income tax returns?|documents?|files?|statements?|certificates?|kyc|acknowledg\w*|computation|notice)\b/i;

function matchDocTypes(text) {
  const hits = DOC_TYPES.filter((d) => d.keys.some((k) => hasKey(text, k))).map((d) => d.type);
  if (hits.length) return hits;
  if (/\b(itr|it returns?|income tax returns?)\b/i.test(text)) return ITR_GROUP;
  return null; // no specific type
}

function looksLikeFileRequest(text) {
  const t = String(text || '');
  if (/\btask\b/i.test(t) || /\b(recommend|assign|attendance|present|absent)\b/i.test(t)) return false;
  const specific = DOC_TYPES.some((d) => d.keys.some((k) => hasKey(t, k)));
  const object = specific || GENERIC_OBJECTS.test(t);
  if (!object) return false;
  return VERBS.test(t) || specific || parseYear(t) !== null;
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
```

**`lib/docChat.js`**: the chat logic ("find my file", "propose upload")

```js
// Chat-side logic for document requests and upload proposals.
// Returns a chat response object ({ success, reply, chips }) or null if the message is not ours.
const D = require('./docs');

const MAX_CHIPS = 8;

async function resolveClient(db, text) {
  const t = String(text || '');
  const idm = /(?:client\s*#?|id\s*#?|#)\s*(\d{3,6})\b/i.exec(t);
  const cols = db.collection('clients');
  if (idm) {
    const c = await cols.findOne({ id: parseInt(idm[1], 10) });
    if (c) return { id: c.id, name: c.name };
  }
  const all = await cols.find({}).toArray();
  const lower = t.toLowerCase();
  const hits = all.filter((c) => c.name && c.name.trim().length >= 3 && lower.includes(c.name.trim().toLowerCase()));
  hits.sort((a, b) => b.name.length - a.name.length); // longest name wins
  return hits[0] ? { id: hits[0].id, name: hits[0].name } : null;
}

async function actorClient(db, decoded, text, paramClientId) {
  if (decoded.role === 'client') {
    if (!Number.isInteger(decoded.clientId)) return null;
    const c = await db.collection('clients').findOne({ id: decoded.clientId });
    return c ? { id: c.id, name: c.name } : null;       // text/params are ignored for clients
  }
  if (paramClientId) {
    const c = await db.collection('clients').findOne({ id: parseInt(paramClientId, 10) });
    if (c) return { id: c.id, name: c.name };
  }
  return resolveClient(db, text);
}

const yearText = (d) => (d.fy ? D.fyLabel(d.fy) : 'KYC (all years)');
const dl = (d) => ({ label: `⬇️ ${d.fileName}`, action: 'download_file', params: { docId: String(d._id) } });

// ---------- "give me my 2024 ITR" ----------
async function handleFileRequest(db, decoded, query) {
  const client = await actorClient(db, decoded, query);
  if (!client) {
    return { success: true, reply: 'Which client is this for? Please mention the client name or ID, e.g. *"Form 16 FY 2023-24 for client 1005"*.' };
  }

  const yr = D.parseYear(query);
  if (yr && yr.ask) {
    return {
      success: true,
      reply: `Did you mean the return for **${D.fyLabel(yr.ask[0])}** or **${D.fyLabel(yr.ask[1])}**?`,
      chips: yr.ask.map((fy) => ({ label: D.fyLabel(fy), action: 'prompt_text', text: `${query} FY ${fy}` }))
    };
  }

  const types = D.matchDocTypes(query);
  const filter = { clientId: client.id };
  if (decoded.role === 'client') filter.clientVisible = { $ne: false };
  if (yr && yr.fy) filter.fy = yr.fy;
  if (types) filter.docType = { $in: types };

  const docs = await db.collection('documents').find(filter).sort({ fy: -1, uploadedAt: -1 }).limit(50).toArray();

  if (docs.length === 0) {
    const avail = (await db.collection('documents').distinct('fy', { clientId: client.id })).filter(Boolean);
    const hint = avail.length ? `\n\nDocuments exist for: ${avail.sort().reverse().map((f) => D.fyLabel(f)).join(', ')}.` : '';
    return { success: true, reply: `I couldn't find a matching document for **${client.name}**.${hint}` };
  }

  // Too many and no year given: narrow by year first.
  if (docs.length > MAX_CHIPS && !(yr && yr.fy)) {
    const years = [...new Set(docs.map((d) => d.fy).filter(Boolean))].sort().reverse().slice(0, MAX_CHIPS);
    return {
      success: true,
      reply: `Found **${docs.length}** documents for **${client.name}**. Which year?`,
      chips: years.map((fy) => ({ label: D.fyLabel(fy), action: 'prompt_text', text: `${query} FY ${fy}` }))
    };
  }

  const shown = docs.slice(0, MAX_CHIPS);
  let reply = shown.length === 1
    ? `Found 1 document for **${client.name}**:\n`
    : `Found **${docs.length}** documents for **${client.name}**. Tap the one you need:\n`;
  shown.forEach((d) => { reply += `- **${d.docType}** — ${yearText(d)} (${d.fileName})\n`; });
  if (docs.length > shown.length) reply += `\nShowing ${shown.length} of ${docs.length}. Add a year or document type to narrow it down.`;
  return { success: true, reply, chips: shown.map(dl) };
}

// ---------- paperclip upload: propose, then the browser confirms ----------
async function handleClassifyUpload(db, decoded, b) {
  const fileName = D.safeFileName(b.fileName);
  const text = `${b.message || ''} ${fileName}`;
  const client = await actorClient(db, decoded, b.message || '', b.clientId);
  if (!client) {
    return {
      success: true, awaitingClient: true,
      reply: `Which client is **${fileName}** for? Reply with the client name or ID (e.g. *client 1005*).`,
      chips: [{ label: '✖ Cancel upload', action: 'cancel_upload' }]
    };
  }

  const isClient = decoded.role === 'client';
  const allowed = D.DOC_TYPES.filter((d) => !isClient || D.CLIENT_UPLOAD_CATEGORIES.includes(d.category));
  let docType = b.docType && allowed.find((d) => d.type === b.docType) ? b.docType : null;
  if (!docType) {
    const guess = D.matchDocTypes(text);
    docType = (guess && guess.find((g) => allowed.some((a) => a.type === g) && g !== 'Filed ITR (JSON)')) || null;
  }
  if (!docType && isClient) docType = 'Other Document';

  let fy = b.fy && D.isValidFy(b.fy) ? b.fy : null;
  let yearNote = '';
  if (!fy) {
    const yr = D.parseYear(text.replace(/[_.]/g, ' '));
    if (yr && yr.fy) fy = yr.fy;
    else if (yr && yr.ask) { fy = yr.ask[1]; yearNote = ' (guessed — please check)'; }
    else { fy = D.latestCompletedFy(); yearNote = ' (defaulted to the latest completed year — please check)'; }
  }

  const meta = { fileName, mimeType: b.mimeType || '', size: b.size || 0, clientId: client.id };
  if (!docType || b.pickType) { // unrecognised type, or the user tapped "Change type": ask
    return {
      success: true,
      reply: `What type of document is **${fileName}**?`,
      chips: [...allowed.map((d) => ({ label: d.type, action: 'classify_upload', params: { ...meta, fy, docType: d.type } })),
              { label: '✖ Cancel upload', action: 'cancel_upload' }]
    };
  }

  const cat = D.typeInfo(docType).category;
  const where = D.CATEGORIES[cat].perFy ? `${D.fyFolderName(fy)} / ${D.CATEGORIES[cat].folder}` : D.CATEGORIES[cat].folder;
  const base = { ...meta, fy, docType };
  const latest = parseInt(D.latestCompletedFy().slice(0, 4), 10);
  const recentFys = [0, 1, 2, 3].map((i) => `${latest - i}-${String((latest - i + 1) % 100).padStart(2, '0')}`);

  return {
    success: true,
    reply: `I'll save **${fileName}** as:\n- **Client**: ${client.name} (#${client.id})\n- **Type**: ${docType}\n- **Year**: ${D.fyLabel(fy)}${yearNote}\n- **Folder**: ${where}\n\nConfirm to upload?`,
    chips: [
      { label: '✅ Save to Drive', action: 'upload_confirm', params: base },
      ...recentFys.filter((f) => f !== fy).slice(0, 3).map((f) => ({ label: `📅 ${D.fyLabel(f)}`, action: 'classify_upload', params: { ...base, fy: f } })),
      { label: '📁 Change type', action: 'classify_upload', params: { ...meta, fy, pickType: true } },
      { label: '✖ Cancel', action: 'cancel_upload' }
    ]
  };
}

async function handleDocChat({ db, decoded, query, action, body }) {
  if (action === 'classify_upload') return handleClassifyUpload(db, decoded, { ...body, message: body.message || '' });
  if (action) return null;
  if (!D.looksLikeFileRequest(query)) return null;
  return handleFileRequest(db, decoded, query);
}

module.exports = { handleDocChat };
```

**`api/files.js`**: download + upload endpoint

```js
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { ObjectId } = require('mongodb');
const { connectToDatabase } = require('./db');
const { verifyToken, logAuditAction } = require('./auth');
const Drive = require('../lib/driveClient');
const D = require('../lib/docs');

let indexesReady = false;

module.exports = async (req, res) => {
  try {
    const decoded = verifyToken(req);
    if (!decoded) return res.status(401).json({ success: false, message: 'Unauthorized: Missing or invalid token.' });

    const cfg = Drive.getDriveConfig();
    if (!cfg) return res.status(503).json({ success: false, message: 'Google Drive is not configured on the server.' });

    const { db } = await connectToDatabase();
    if (!indexesReady) { await Drive.ensureIndexes(db); indexesReady = true; }

    const action = (req.query && req.query.action) || (req.body && req.body.action);

    // ---------------- DOWNLOAD ----------------
    if (req.method === 'GET' && action === 'download') {
      const id = String(req.query.id || '');
      if (!/^[a-f0-9]{24}$/i.test(id)) return res.status(400).json({ success: false, message: 'Invalid document id.' });

      const doc = await db.collection('documents').findOne({ _id: new ObjectId(id) });
      // 404 (not 403) so a client cannot probe which ids exist
      if (!doc || !D.canAccessDoc(decoded, doc)) return res.status(404).json({ success: false, message: 'Document not found.' });

      const g = await Drive.downloadFile(cfg, doc.driveFileId);
      if (!g.ok || !g.body) return res.status(502).json({ success: false, message: 'File could not be fetched from Drive.' });

      await logAuditAction(db, decoded.username, 'DOWNLOAD_FILE', { docId: id, clientId: doc.clientId, fileName: doc.fileName });

      const ascii = doc.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
      res.statusCode = 200;
      res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      await pipeline(Readable.fromWeb(g.body), res);
      return;
    }

    // ---------------- UPLOAD ----------------
    if (req.method === 'POST' && action === 'upload') {
      const b = req.body || {};
      const isClient = decoded.role === 'client';
      if (!isClient && !D.STAFF_ROLES.includes(decoded.role)) return res.status(403).json({ success: false, message: 'Forbidden.' });

      const clientId = isClient ? decoded.clientId : parseInt(b.clientId, 10);
      if (!Number.isInteger(clientId)) return res.status(400).json({ success: false, message: 'Client is required.' });
      const client = await db.collection('clients').findOne({ id: clientId });
      if (!client) return res.status(404).json({ success: false, message: 'Client not found.' });

      const info = D.typeInfo(b.docType);
      if (!info) return res.status(400).json({ success: false, message: 'Unknown document type.' });
      if (isClient && !D.CLIENT_UPLOAD_CATEGORIES.includes(info.category)) {
        return res.status(403).json({ success: false, message: 'Clients can only upload to Received / KYC documents.' });
      }
      const perFy = D.CATEGORIES[info.category].perFy;
      if (perFy && !D.isValidFy(b.fy)) return res.status(400).json({ success: false, message: 'Invalid financial year.' });
      if (!b.base64Data) return res.status(400).json({ success: false, message: 'No file data.' });

      const buffer = Buffer.from(String(b.base64Data), 'base64');
      if (buffer.length === 0) return res.status(400).json({ success: false, message: 'Empty file.' });

      const folderPath = perFy ? `${D.fyFolderName(b.fy)}/${D.CATEGORIES[info.category].folder}` : D.CATEGORIES[info.category].folder;
      const folderId = await Drive.ensureFolder(db, cfg, clientId, client.name, folderPath);

      // never overwrite: add _v2, _v3 ... if the name is taken in this folder
      const original = D.safeFileName(b.fileName);
      const dot = original.lastIndexOf('.');
      const stem = dot > 0 ? original.slice(0, dot) : original;
      const ext = dot > 0 ? original.slice(dot) : '';
      let fileName = original;
      for (let n = 2; await db.collection('documents').findOne({ clientId, folderPath, fileName }); n++) fileName = `${stem}_v${n}${ext}`;

      const up = await Drive.uploadFile(cfg, { name: fileName, mimeType: b.mimeType, buffer, parentId: folderId });

      const doc = {
        clientId, clientName: client.name,
        fy: perFy ? b.fy : null, ay: perFy ? D.fyToAy(b.fy) : null,
        category: info.category, docType: info.type,
        fileName, originalFileName: original,
        driveFileId: up.id, driveFolderId: folderId, folderPath,
        mimeType: b.mimeType || up.mimeType || 'application/octet-stream',
        size: buffer.length, clientVisible: true,
        uploadedBy: decoded.username, uploadedByRole: decoded.role, uploadedAt: new Date(), source: 'chat'
      };
      const ins = await db.collection('documents').insertOne(doc);
      doc._id = ins.insertedId;

      await logAuditAction(db, decoded.username, 'UPLOAD_FILE', { docId: String(doc._id), clientId, fileName, folderPath });

      return res.status(200).json({
        success: true,
        reply: `✅ Saved **${fileName}** for **${client.name}** under *${folderPath}*.`,
        chips: [{ label: `⬇️ ${fileName}`, action: 'download_file', params: { docId: String(doc._id) } }]
      });
    }

    return res.status(400).json({ success: false, message: 'Invalid action.' });
  } catch (err) {
    console.error('Files API error:', err);
    if (!res.headersSent) return res.status(500).json({ success: false, message: 'File service error.' });
    res.end();
  }
};
```

**`api/drive.js`**: replace the whole file (partner-only health check)

```js
// Health check only (partner). All file access goes through /api/files.
const { verifyToken, checkRole } = require('./auth');
const { getDriveConfig, getAccessToken } = require('../lib/driveClient');

module.exports = async (req, res) => {
  const decoded = verifyToken(req);
  if (!decoded) return res.status(401).json({ success: false, message: 'Unauthorized.' });
  if (!checkRole(decoded, ['partner'])) return res.status(403).json({ success: false, message: 'Forbidden: Admins only.' });

  const cfg = getDriveConfig();
  if (!cfg) return res.status(200).json({ success: true, configured: false });
  try {
    await getAccessToken(cfg);
    return res.status(200).json({ success: true, configured: true, connected: true, clientEmail: cfg.email, rootFolderId: cfg.rootFolderId });
  } catch (e) {
    return res.status(200).json({ success: true, configured: true, connected: false, error: e.message });
  }
};
```

### 6.2 `api/login.js`: put `clientId` in the token (2 edits)

```diff
-        { username: user.username, role: user.role, name: user.name },
+        { username: user.username, role: user.role, name: user.name, ...(user.role === 'client' ? { clientId: user.clientId } : {}) },
```
```diff
           name: user.name,
-          role: user.role
+          role: user.role,
+          ...(user.role === 'client' ? { clientId: user.clientId } : {})
         }
```

### 6.3 `api/chat.js`: documents first, then fence clients out

At the top:
```js
const { handleDocChat } = require('../lib/docChat');
```
Right after `const engagementsCol = db.collection('engagements');` add:
```js
    // Drive documents (find / upload proposal) for every role, then fence off clients:
    // a client token must never reach the task / client / staff logic below.
    const docReply = await handleDocChat({ db, decoded, query, action, body: req.body || {} });
    if (docReply) return res.status(200).json(docReply);
    if (decoded.role === 'client') {
      return res.status(200).json({
        success: true,
        reply: 'I can help you find your documents (e.g. *"send my Form 16 for FY 2023-24"*) or upload new ones with the 📎 button.',
        chips: [
          { label: 'My documents', action: 'prompt_text', text: 'show my documents' },
          { label: 'My ITR', action: 'prompt_text', text: 'send my IT return' }
        ]
      });
    }
```
**Delete the old Drive search**: the block from `// Google Drive RAG` down to just before `let reply = '';`, the `if (recordsFound.driveFiles.length > 0) { ... }` block further down, and `driveFiles: []` in `recordsFound`.

### 6.4 `api/users.js`: create client logins linked to a client

In the `action === 'create'` branch, read `clientId` from the body and validate it before `insertOne`:
```js
        const { username, password, name, role, clientId } = req.body;
        ...
        let linkedClientId;
        if (role === 'client') {
          linkedClientId = parseInt(clientId, 10);
          const linked = Number.isInteger(linkedClientId) ? await db.collection('clients').findOne({ id: linkedClientId }) : null;
          if (!linked) {
            return res.status(400).json({ success: false, message: 'A client login must be linked to an existing client ID.' });
          }
        }
        await usersCollection.insertOne({
          username: uInput, password: password, name: name.trim(), role,
          ...(role === 'client' ? { clientId: linkedClientId } : {}),
          requireBiometric: false, faceDescriptor: null
        });
```

---

## 7. Frontend changes

**`index.html`**
- In the chatbot input bar, add before the text input: a hidden `<input type="file" id="chatFileInput" class="hidden" onchange="handleChatFileSelected(event)">` and a `📎` button calling `chatPickFile()`.
- In the "create user" form: add `<option value="client">Client</option>` to the role list and a number field `id="newClientId"`.
- Remove the `gdriveNavBtn` ("Drive Vault") button. The old Vault modal and its JS can be deleted; they call actions that no longer exist.

**`app.js`**: 5 small edits + one new block

1. In `appendBotMessage`, before the final `else { executeChatAction(...) }`, add handlers for the new chip actions:
```js
                } else if (chip.action === 'download_file') {
                    downloadDriveDoc(chip.params.docId, (chip.label || '').replace('⬇️ ', ''));
                } else if (chip.action === 'upload_confirm') {
                    confirmChatUpload(chip.params);
                } else if (chip.action === 'classify_upload') {
                    classifyPendingUpload(chip.params, chip.label);
                } else if (chip.action === 'cancel_upload') {
                    pendingChatUpload = null;
                    appendBotMessage('Upload cancelled.');
```
2. In `handleChatSubmit`, just before `// Add loading indicator`:
```js
    // A file is waiting for the user to say which client it belongs to
    if (pendingChatUpload && pendingChatUpload.awaitingClient) {
        classifyPendingUpload({ fileName: pendingChatUpload.file.name, mimeType: pendingChatUpload.file.type, size: pendingChatUpload.file.size, message: query });
        return;
    }
```
3. First line of `syncCoreState()`: `if (currentUserSession && currentUserSession.role === 'client') return;`
4. Add `bootClientPortal()` above `bootOfficeWorkspace()` and make the latter start with `if (currentUserSession.role === 'client') { bootClientPortal(); return; }` (a client sees only the chat window).
5. In `handleOfficeUserCreation`, add `clientId: document.getElementById('newClientId')?.value || undefined` to the request body.
6. Append this block at the end of the file:

```js
// ==========================================
// DRIVE DOCUMENTS IN CHAT (find / download / upload)
// ==========================================
let pendingChatUpload = null; // { file, awaitingClient }
// Vercel rejects request bodies over 4.5 MB; base64 adds ~33%. Raise this when self-hosting.
const MAX_CHAT_UPLOAD_BYTES = 3 * 1024 * 1024;

function addChatUserBubble(text) {
    const msgList = document.getElementById('chatMessageList');
    if (!msgList) return;
    const div = document.createElement('div');
    div.className = 'chat-msg user';
    div.innerText = text;
    msgList.appendChild(div);
    msgList.scrollTop = msgList.scrollHeight;
}

function chatPickFile() {
    document.getElementById('chatFileInput')?.click();
}

async function handleChatFileSelected(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_CHAT_UPLOAD_BYTES) {
        appendBotMessage(`**${file.name}** is too large to upload here (limit ${(MAX_CHAT_UPLOAD_BYTES / 1048576).toFixed(0)} MB). Please send it to the office directly.`);
        return;
    }
    pendingChatUpload = { file, awaitingClient: false };
    const input = document.getElementById('chatInputText');
    const typed = input ? input.value.trim() : '';
    if (input) input.value = '';
    addChatUserBubble(`📎 ${file.name}${typed ? ' — ' + typed : ''}`);
    await classifyPendingUpload({ fileName: file.name, mimeType: file.type, size: file.size, message: typed });
}

async function classifyPendingUpload(params, label) {
    if (!pendingChatUpload) { appendBotMessage('Please attach the file again with 📎.'); return; }
    if (label) addChatUserBubble(label);
    try {
        const res = await authFetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'classify_upload', ...params })
        }).then(r => r.json());
        pendingChatUpload.awaitingClient = !!res.awaitingClient;
        appendBotMessage(res.reply || res.message || 'Could not process the upload.', res.chips || []);
    } catch (err) {
        appendBotMessage('Network error: ' + err.message);
    }
}

async function confirmChatUpload(params) {
    if (!pendingChatUpload) { appendBotMessage('Please attach the file again with 📎.'); return; }
    const file = pendingChatUpload.file;
    addChatUserBubble('✅ Save to Drive');
    try {
        const base64Data = await new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result).split(',')[1]);
            r.onerror = reject;
            r.readAsDataURL(file);
        });
        const res = await authFetch('/api/files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'upload',
                clientId: params.clientId, fy: params.fy, docType: params.docType,
                fileName: file.name, mimeType: file.type, base64Data
            })
        }).then(r => r.json());
        if (res.success) {
            pendingChatUpload = null;
            appendBotMessage(res.reply, res.chips || []);
        } else {
            appendBotMessage('⚠️ Upload failed: ' + (res.message || 'unknown error'));
        }
    } catch (err) {
        appendBotMessage('⚠️ Upload failed: ' + err.message);
    }
}

async function downloadDriveDoc(docId, fileName) {
    try {
        const res = await authFetch(`/api/files?action=download&id=${encodeURIComponent(docId)}`);
        if (!res.ok) { appendBotMessage('⚠️ Could not download that file.'); return; }
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName || 'document';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (err) {
        appendBotMessage('⚠️ Download failed: ' + err.message);
    }
}
```

---

## 8. Demo data (60 clients × 3 years)

`seed_drive_demo.py` reads your clients from MongoDB, writes one-line fake files of the correct type (real PDF, XLSX, DOCX, JPG, JSON that open normally), uploads them into the matching folders, and records them in `documents`. It uses client name + ID only; PAN/Aadhaar inside files are masked placeholders.

Per client: 2 KYC files + 8 per year (Form 16, bank statement, investment proof, computation, tax summary, ITR-V, acknowledgement, filed JSON), plus a notice for every 6th client in the middle year. **About 26 files per client, roughly 1,580 files for 60 clients.**

```bash
pip install pymongo python-dotenv reportlab openpyxl python-docx pillow google-api-python-client google-auth

# A) look at the files only (nothing is uploaded, MongoDB is not touched)
python seed_drive_demo.py --local-only --clients-json clients.json --limit 3

# B) real run for ONE client first
python seed_drive_demo.py --sa-json service-account.json --root-folder-id <Clients folder id> --limit 1

# C) everything (safe to re-run; finished files are skipped)
python seed_drive_demo.py --sa-json service-account.json --root-folder-id <Clients folder id>
```

It reads `MONGODB_URI` from `.env.local` (like your `import_clients.py`). Expect several minutes for the full run. Check the folder tree in Drive after step B before running C.

---

## 9. Try it

1. Create a client login: Admin → create user → role **Client**, Client ID e.g. `1001`.
2. Log in as that client. You should see only the chat. Try:
   - `send my 2024 IT return` → bot asks FY 2023-24 or FY 2024-25 → tap → file chips → tap to download.
   - `give me Form 16 FY 2024-25`
   - 📎 attach a file → bot proposes client/type/year → **Save to Drive** → appears in the folder.
3. Log in as staff: `Form 16 FY 2024-25 for client 1005` or by client name.
4. Check `audit_logs` for `DOWNLOAD_FILE` / `UPLOAD_FILE`.

**Offline test** (no Google or MongoDB needed): copy `drive_e2e_test.js` into the project root and run `node drive_e2e_test.js`. It runs your real `login`, `users`, `chat` and `files` handlers against a fake database and fake Google, and checks the rules below.

### What I verified, and what I could not

| Verified (automated) | Not verified (needs you) |
|---|---|
| Client cannot read or download another client's files, even by typing another client's ID or sending a forged document id. | **A real Google Drive / Shared Drive.** I had no credentials or access. The code uses documented Drive v3 calls (`supportsAllDrives=true`), but run the seed with `--limit 1` first. |
| Client uploads are limited to Received/KYC; the client ID always comes from the token. | Your live MongoDB (I could not reach it; the 60 clients are read at run time). |
| Client tokens cannot reach tasks, status changes or staff data in chat. | Real browser behaviour. Frontend functions were tested in jsdom, not in a browser. Check the client screen hides the elements you want hidden. |
| FY/AY parsing, "2024" ambiguity prompt, versioned file names, folder created once and reused, audit rows. | Downloads larger than 4.5 MB on Vercel (see §10). Test with a >5 MB file after deploying. |
| Generated files all open correctly; the seed script's upload and re-run logic runs correctly against a fake Drive. | |

---

## 10. Limits and next steps

- **File size on Vercel.** Requests over 4.5 MB are rejected by the platform. The chat upload is capped at 3 MB (`MAX_CHAT_UPLOAD_BYTES` in `app.js`; raise it if you self-host). To lift this properly, use chunked uploads: the server opens a Drive *resumable upload session* and the browser sends the file in pieces. I can write this when you need it. Downloads stream from Drive, which Vercel documents as not subject to the response limit; confirm with a large file.
- **GST documents** are not included; the folder and doc-type lists make adding them straightforward.
- **Client "add task"** is not part of this change. The client token is fenced to documents only, so build that as its own endpoint with its own checks.
- **Scanned-document classification.** Type and year are guessed from the file name and message only. Reading file contents with an LLM is possible later, but keep the confirm step.

## 11. Security issues I noticed in the existing code

These are not caused by this change, but they matter once real tax documents and client logins exist:

- Passwords are stored in **plain text**, and `login.js` even converts hashed passwords back to plain text. Hash them (bcrypt is already installed).
- `JWT_SECRET` falls back to a hard-coded value if the env var is missing. Make the app fail instead.
- `GET /api/users` returns every user's password to a partner.
- Client records hold ITR portal and GST passwords in plain text.
- `/api/init` has no authentication.

I'd fix at least the first two before giving clients logins.
