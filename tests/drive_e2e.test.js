const crypto = require('crypto');
const assert = require('assert');
const { ObjectId } = require('mongodb');
const { Readable } = require('stream');

// ---------- env + fake Google Drive OAuth ----------
const Drive = require('../lib/driveClient');

process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-oauth-client-id';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-oauth-client-secret';
process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'test-oauth-refresh-token';
process.env.GOOGLE_DRIVE_FOLDER_ID = 'ROOT';
process.env.JWT_SECRET = 'test-secret';

const driveCalls = { folders: [], uploads: [], downloads: [] };
const driveFiles = {};
let seq = 0;

const mockDrive = {
  files: {
    create: async ({ requestBody, media }) => {
      if (requestBody.mimeType === 'application/vnd.google-apps.folder') {
        const id = 'D' + ++seq;
        driveCalls.folders.push({ name: requestBody.name, parent: requestBody.parents[0], id });
        return { data: { id, name: requestBody.name } };
      } else {
        const id = 'F' + ++seq;
        const chunks = [];
        if (media && media.body) {
          for await (const chunk of media.body) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
        }
        const buf = Buffer.concat(chunks);
        driveFiles[id] = buf;
        driveCalls.uploads.push({ name: requestBody.name, parent: requestBody.parents[0], id });
        return { data: { id, name: requestBody.name, size: buf.length, mimeType: media ? media.mimeType : 'application/octet-stream' } };
      }
    },
    get: async ({ fileId, alt }) => {
      if (alt === 'media') {
        driveCalls.downloads.push(fileId);
        const data = Readable.from([`BYTES-OF-${fileId}`]);
        return { status: 200, data };
      }
      return { data: { id: fileId, name: 'Client', mimeType: 'application/vnd.google-apps.folder' } };
    },
    delete: async ({ fileId }) => {
      delete driveFiles[fileId];
      return { data: {} };
    }
  }
};

Drive.setDriveInstance(mockDrive);

// ---------- fake Mongo ----------
const match = (doc, f) => Object.entries(f).every(([k, v]) => {
  const x = doc[k];
  if (v && typeof v === 'object' && !(v instanceof ObjectId) && !(v instanceof Date)) {
    if ('$in' in v) return v.$in.includes(x);
    if ('$ne' in v) return x !== v.$ne;
    if ('$nin' in v) return !v.$nin.includes(x);
  }
  return String(x) === String(v);
});
const store = {};
const col = (n) => { const a = (store[n] = store[n] || []); return {
  findOne: async (f = {}) => a.find((d) => match(d, f)) || null,
  find: (f = {}) => { let r = a.filter((d) => match(d, f)); const c = { sort: (s) => { const [k, dir] = Object.entries(s)[0]; r = [...r].sort((p, q) => (p[k] > q[k] ? 1 : -1) * dir); return c; }, limit: (n) => { r = r.slice(0, n); return c; }, skip: () => c, toArray: async () => r }; return c; },
  insertOne: async (d) => { if (n === 'drive_folders' && a.some((x) => x.clientId === d.clientId && x.path === d.path)) { const e = new Error('dup'); e.code = 11000; throw e; } d._id = d._id || new ObjectId(); a.push(d); return { insertedId: d._id }; },
  distinct: async (k, f = {}) => [...new Set(a.filter((d) => match(d, f)).map((d) => d[k]))],
  countDocuments: async () => a.length, createIndex: async () => 'ok', updateOne: async () => ({}),
  find_all: a }; };
require.cache[require.resolve('../api/_routes/db.js')] = { exports: { connectToDatabase: async () => ({ db: { collection: col } }) }, loaded: true, id: 'x', filename: 'x' };

// ---------- helpers ----------
const jwt = require('jsonwebtoken');
const tok = (p) => jwt.sign(p, 'test-secret');
const { Writable } = require('stream');
const call = async (mod, { method = 'POST', token, body = {}, query = {} }) => {
  const req = { method, headers: token ? { authorization: 'Bearer ' + token } : {}, body, query };
  const chunks = []; const headers = {};
  const res = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.statusCode = 200; res.headersSent = false;
  res.setHeader = (k, v) => (headers[k] = v);
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.out = o; res.end(); return res; };
  await require(mod)(req, res);
  await new Promise((r) => (res.writableFinished ? r() : res.on('finish', r)));
  return { status: res.statusCode, json: res.out, text: Buffer.concat(chunks).toString(), headers };
};

(async () => {
  // data
  for (const [id, name] of [[1001, 'Ramesh Kumar'], [1002, 'Anita Sharma']]) store.clients = [...(store.clients || []), { id, name }];
  store.users = [{ username: 'smk', password: '1234', name: 'Partner', role: 'partner' }];
  const partner = tok({ username: 'smk', role: 'partner', name: 'P' });
  const staff = tok({ username: 'ravi', role: 'staff', name: 'R' });

  // partner creates a client login (users.js patch) + validation
  let r = await call('../api/_routes/users.js', { token: partner, body: { action: 'create', username: 'c1001', password: 'x', name: 'Ramesh', role: 'client', clientId: 1001 } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  r = await call('../api/_routes/users.js', { token: partner, body: { action: 'create', username: 'bad', password: 'x', name: 'B', role: 'client', clientId: 9999 } });
  assert.equal(r.status, 400);
  await call('../api/_routes/users.js', { token: partner, body: { action: 'create', username: 'c1002', password: 'x', name: 'Anita', role: 'client', clientId: 1002 } });

  // login puts clientId in JWT (login.js patch)
  r = await call('../api/_routes/login.js', { body: { username: 'c1001', password: 'x' } });
  assert.equal(r.json.user.clientId, 1001);
  const c1001 = r.json.token;
  assert.equal(jwt.verify(c1001, 'test-secret').clientId, 1001);
  r = await call('../api/_routes/login.js', { body: { username: 'c1002', password: 'x' } });
  const c1002 = r.json.token;

  // ---- uploads ----
  const b64 = (s) => Buffer.from(s).toString('base64');
  const up = (token, o) => call('../api/_routes/files.js', { token, body: { action: 'upload', mimeType: 'application/pdf', base64Data: b64('hello'), ...o } });

  r = await up(c1001, { clientId: 1002, fy: '2023-24', docType: 'Form 16', fileName: 'Form16.pdf' }); // tries to spoof client 1002
  assert.equal(r.status, 200); assert.equal(store.documents[0].clientId, 1001, 'client id must come from token');
  r = await up(c1001, { fy: '2023-24', docType: 'Form 16', fileName: 'Form16.pdf' });
  assert.equal(store.documents[1].fileName, 'Form16_v2.pdf');
  r = await up(c1001, { fy: '2023-24', docType: 'ITR-V', fileName: 'fake.pdf' });
  assert.equal(r.status, 403, 'client must not write to Filed Returns');
  r = await up(c1001, { docType: 'PAN Card', fileName: 'pan.jpg', mimeType: 'image/jpeg' }); assert.equal(r.status, 200);
  assert.equal(store.documents[2].folderPath, '01_KYC'); assert.equal(store.documents[2].fy, null);
  r = await up(staff, { clientId: 1002, fy: '2024-25', docType: 'ITR-V', fileName: 'ITRV.pdf' }); assert.equal(r.status, 200);
  r = await up(staff, { clientId: 1002, fy: '2024-26', docType: 'ITR-V', fileName: 'x.pdf' }); assert.equal(r.status, 400);
  r = await up(staff, { clientId: 1002, fy: '2024-25', docType: 'Bogus', fileName: 'x.pdf' }); assert.equal(r.status, 400);
  r = await up(staff, { clientId: 1002, fy: '2024-25', docType: 'Form 16', fileName: '../../etc/passwd' });
  assert.equal(store.documents.at(-1).fileName, 'passwd');
  // folders created once and reused
  const names = driveCalls.folders.map((f) => f.name);
  assert.equal(names.filter((n) => n === '1001_Ramesh Kumar').length, 1);
  assert.equal(names.filter((n) => n === 'FY 2023-24 (AY 2024-25)').length, 1);
  assert(names.includes('1_Received_from_Client') && names.includes('3_Filed_Returns') && names.includes('01_KYC'));
  assert.equal(driveCalls.folders.find((f) => f.name === '1001_Ramesh Kumar').parent, 'ROOT');
  console.log('uploads + folders OK:', names.length, 'folders');

  // ---- chat: find files ----
  const chat = async (token, message, extra = {}) => { console.log('chat>', message || extra.action); return call('../api/_routes/chat.js', { token, body: { message, ...extra } }); };
  r = await chat(c1001, 'send my 2024 IT return');
  assert(r.json.chips.length === 2 && r.json.chips[0].action === 'prompt_text', 'should ask FY vs AY');
  r = await chat(c1001, r.json.chips[0].text); // "... FY 2023-24"
  assert(/couldn't find/.test(r.json.reply), 'client 1001 has no ITR docs');
  r = await chat(c1001, 'give me Form 16 FY 2023-24');
  assert.equal(r.json.chips.length, 2); assert(r.json.chips.every((c) => c.action === 'download_file'));
  const myDocId = r.json.chips[0].params.docId;
  r = await chat(c1001, 'Form 16 for client 1002 fy 2024-25'); // spoof attempt in text
  assert(/Ramesh Kumar/.test(r.json.reply) && !/Anita/.test(r.json.reply), 'client text cannot switch client');
  r = await chat(staff, 'Form 16 FY 2024-25 for Anita Sharma');
  assert(/Anita Sharma/.test(r.json.reply)); assert.equal(r.json.chips.length, 1);
  r = await chat(staff, 'send ITR-V for AY 2025-26 client 1002');
  assert.equal(r.json.chips.length, 1); assert(/ITRV/.test(r.json.chips[0].label));
  r = await chat(staff, 'Form 16'); assert(/Which client/.test(r.json.reply));

  // ---- client scope: can view/manage own tasks and documents, cannot execute partner actions ----
  r = await chat(c1001, 'pending review tasks'); assert(/Tasks for|no.*tasks/i.test(r.json.reply) && !r.json.data);
  r = await chat(c1001, '', { action: 'advance_status', taskId: 1, targetStatus: 'Filed' }); assert(r.json.reply && !r.json.data);
  r = await chat(c1001, 'Create GST Monthly Return for Alpha Corp'); assert(/Ramesh Kumar|GST/i.test(r.json.reply));
  // existing staff flows are untouched
  r = await Promise.race([chat(partner, 'Who is present today?'), new Promise((_, rej) => setTimeout(() => rej(new Error('STALL in legacy path')), 3000))]); console.log('legacy path status', r.status, (r.json.reply || '').slice(0, 60));

  // ---- download authorization ----
  r = await call('../api/_routes/files.js', { method: 'GET', token: c1001, query: { action: 'download', id: myDocId } });
  assert.equal(r.status, 200); assert(/^BYTES-OF-/.test(r.text)); assert(/attachment/.test(r.headers['Content-Disposition']));
  const otherDoc = String(store.documents.find((d) => d.clientId === 1002)._id);
  r = await call('../api/_routes/files.js', { method: 'GET', token: c1001, query: { action: 'download', id: otherDoc } });
  assert.equal(r.status, 404, 'client cannot download another client file');
  r = await call('../api/_routes/files.js', { method: 'GET', token: staff, query: { action: 'download', id: otherDoc } }); assert.equal(r.status, 200);
  r = await call('../api/_routes/files.js', { method: 'GET', query: { action: 'download', id: otherDoc } }); assert.equal(r.status, 401);
  r = await call('../api/_routes/files.js', { method: 'GET', token: c1001, query: { action: 'download', id: '{"$ne":1}' } }); assert.equal(r.status, 400);
  const jwtNoClient = tok({ username: 'x', role: 'client' });
  r = await call('../api/_routes/files.js', { method: 'GET', token: jwtNoClient, query: { action: 'download', id: myDocId } }); assert.equal(r.status, 404);
  console.log('download authz OK; audit rows:', store.audit_logs.map((a) => a.action).join(','));

  // ---- upload proposal ----
  r = await chat(c1001, '', { action: 'classify_upload', fileName: 'Form16_2023-24.pdf', mimeType: 'application/pdf', size: 10 });
  console.log('\nPROPOSAL (client):\n' + r.json.reply + '\nchips: ' + r.json.chips.map((c) => c.label).join(' | '));
  assert(r.json.chips[0].action === 'upload_confirm' && r.json.chips[0].params.docType === 'Form 16' && r.json.chips[0].params.clientId === 1001);
  r = await chat(c1001, '', { action: 'classify_upload', fileName: 'scan.jpg', clientId: 1002 });
  assert(/Ramesh/.test(r.json.reply), 'client param clientId ignored');
  r = await chat(staff, 'for Anita Sharma fy 2024-25', { action: 'classify_upload', fileName: 'scan.pdf' });
  assert(/What type/.test(r.json.reply)); console.log('staff unknown type -> asks:', r.json.chips.length, 'chips');
  r = await chat(staff, '', { action: 'classify_upload', fileName: 'scan.pdf' }); assert(r.json.awaitingClient);
  r = await chat(staff, 'ITR-V for client 1002', { action: 'classify_upload', fileName: 'x.pdf' });
  assert(r.json.chips[0].params.docType === 'ITR-V');
  console.log('\nALL E2E CHECKS PASSED');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
