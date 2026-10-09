// Google Drive v3 client using Google OAuth 2.0 User Authentication
// Uses googleapis with google.auth.OAuth2 and google.drive
const { google } = require('googleapis');
const { Readable } = require('stream');

let oauth2ClientInstance = null;
let driveInstance = null;

function getDriveConfig() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID || process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '1uQnyR7B6v0cNAZ4GzaqErktO0AgcQqju';

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  return {
    clientId,
    clientSecret,
    refreshToken,
    rootFolderId
  };
}

function getOAuthClient(cfg) {
  const c = cfg || getDriveConfig();
  if (!c) throw new Error('Google OAuth credentials not configured on server.');

  if (oauth2ClientInstance && oauth2ClientInstance._clientId === c.clientId) {
    return oauth2ClientInstance;
  }

  const oauth = new google.auth.OAuth2(
    c.clientId,
    c.clientSecret
  );
  oauth.setCredentials({ refresh_token: c.refreshToken });
  oauth2ClientInstance = oauth;
  driveInstance = null; // reset cached drive instance on config change
  return oauth;
}

function getDriveInstance(cfg) {
  if (driveInstance) return driveInstance;
  const auth = getOAuthClient(cfg);
  driveInstance = google.drive({ version: 'v3', auth });
  return driveInstance;
}

// Allow injecting a mock Drive client for automated testing
function setDriveInstance(mock) {
  driveInstance = mock;
}

async function getAccessToken(cfg) {
  const auth = getOAuthClient(cfg);
  const res = await auth.getAccessToken();
  return res.token;
}

async function createFolder(cfg, name, parentId) {
  const drive = getDriveInstance(cfg);
  const res = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    },
    fields: 'id, name',
    supportsAllDrives: true
  });
  return res.data.id;
}

async function uploadFile(cfg, { name, mimeType, buffer, parentId }) {
  const drive = getDriveInstance(cfg);
  const stream = Readable.from(buffer);
  const res = await drive.files.create({
    requestBody: {
      name,
      parents: [parentId]
    },
    media: {
      mimeType: mimeType || 'application/octet-stream',
      body: stream
    },
    fields: 'id, name, size, mimeType',
    supportsAllDrives: true
  });
  return res.data; // { id, name, size, mimeType }
}

async function downloadFile(cfg, fileId) {
  const drive = getDriveInstance(cfg);
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  );

  return {
    ok: true,
    status: res.status,
    data: res.data,
    stream: res.data,
    body: res.data
  };
}

async function deleteFile(cfg, fileId) {
  const drive = getDriveInstance(cfg);
  await drive.files.delete({ fileId, supportsAllDrives: true });
  return true;
}

async function listFiles(cfg, parentId, options = {}) {
  const drive = getDriveInstance(cfg);
  const q = parentId ? `'${parentId}' in parents and trashed = false` : 'trashed = false';
  const res = await drive.files.list({
    q,
    fields: 'files(id, name, mimeType, size, createdTime, modifiedTime)',
    supportsAllDrives: true,
    pageSize: options.pageSize || 100
  });
  return res.data.files || [];
}

async function getFile(cfg, fileId) {
  const drive = getDriveInstance(cfg);
  const res = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size, createdTime, modifiedTime',
    supportsAllDrives: true
  });
  return res.data;
}

async function updateFile(cfg, fileId, { name, mimeType, buffer }) {
  const drive = getDriveInstance(cfg);
  const media = buffer ? {
    mimeType: mimeType || 'application/octet-stream',
    body: Readable.from(buffer)
  } : undefined;
  const res = await drive.files.update({
    fileId,
    requestBody: name ? { name } : undefined,
    media,
    fields: 'id, name, size, mimeType',
    supportsAllDrives: true
  });
  return res.data;
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

module.exports = {
  getDriveConfig,
  getOAuthClient,
  getDriveInstance,
  setDriveInstance,
  getAccessToken,
  createFolder,
  uploadFile,
  downloadFile,
  deleteFile,
  listFiles,
  getFile,
  updateFile,
  ensureFolder,
  ensureIndexes,
  clientFolderName
};