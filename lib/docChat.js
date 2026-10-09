// Chat-side logic for document requests and upload proposals.
// Returns a chat response object ({ success, reply, chips }) or null if the message is not ours.
const D = require('./docs');

const MAX_CHIPS = 8;

async function resolveClient(db, text) {
  const t = String(text || '');
  let parsedId = null;
  const cleanTokens = t.toLowerCase().split('#').join(' # ').split(' ').filter(Boolean);
  for (let i = 0; i < cleanTokens.length; i++) {
    const w = cleanTokens[i];
    if (w === 'client' || w === 'id' || w === '#') {
      const nextN = parseInt(cleanTokens[i + 1], 10);
      if (!isNaN(nextN) && nextN >= 100) { parsedId = nextN; break; }
    }
  }
  const cols = db.collection('clients');
  if (parsedId) {
    const c = await cols.findOne({ id: parsedId });
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
  if (!fy && b.assessmentYear) {
    const yr = D.parseYear(`AY ${b.assessmentYear}`);
    if (yr && yr.fy) fy = yr.fy;
  }
  if (!fy) {
    const yr = D.parseYear(text.split('_').join(' ').split('.').join(' '));
    if (yr && yr.fy) fy = yr.fy;
    else if (yr && yr.ask) { fy = yr.ask[1]; yearNote = ' (guessed — please check)'; }
    else { fy = D.latestCompletedFy(); yearNote = ' (defaulted to the latest completed year — please check)'; }
  }

  const meta = { fileName, mimeType: b.mimeType || '', size: b.size || 0, clientId: client.id, taskId: b.taskId || null };
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

  const taskNote = b.taskId ? ` and attach to **Task #${b.taskId}**` : '';
  return {
    success: true,
    reply: `I'll save **${fileName}** for **${client.name}**${taskNote}:\n- **Type**: ${docType}\n- **Year**: ${D.fyLabel(fy)}${yearNote}\n- **Folder**: ${where}\n\nConfirm to upload?`,
    chips: [
      { label: b.taskId ? '✅ Save & Attach to Task' : '✅ Save to Drive', action: 'upload_confirm', params: base },
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