const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { ObjectId } = require('mongodb');
const { connectToDatabase } = require('./db');
const { verifyToken, logAuditAction } = require('./auth');
const Drive = require('../../lib/driveClient');
const D = require('../../lib/docs');

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
      if (!g || (!g.body && !g.data && !g.stream)) return res.status(502).json({ success: false, message: 'File could not be fetched from Drive.' });

      await logAuditAction(db, decoded.username, 'DOWNLOAD_FILE', { docId: id, clientId: doc.clientId, fileName: doc.fileName });

      const ascii = doc.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
      res.statusCode = 200;
      res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      const stream = (g.body && typeof g.body.getReader === 'function')
        ? Readable.fromWeb(g.body)
        : (g.data || g.stream || g.body);
      await pipeline(stream, res);
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

      if (b.taskId) {
        const tId = parseInt(b.taskId, 10);
        if (tId) {
          await db.collection('tasks').updateOne(
            { id: tId },
            { $push: { attachedFiles: { docId: String(doc._id), fileName, driveFileId: up.id, uploadedAt: new Date() } } }
          );
        }
      }

      await logAuditAction(db, decoded.username, 'UPLOAD_FILE', { docId: String(doc._id), clientId, fileName, folderPath, taskId: b.taskId || null });

      const taskNote = b.taskId ? ` and attached to **Task #${b.taskId}**` : '';
      return res.status(200).json({
        success: true,
        reply: `✅ Saved **${fileName}** for **${client.name}**${taskNote} under *${folderPath}*.`,
        chips: [{ label: `⬇️ ${fileName}`, action: 'download_file', params: { docId: String(doc._id) } }],
        docId: String(doc._id),
        fileName,
        driveFileId: up.id
      });
    }

    return res.status(400).json({ success: false, message: 'Invalid action.' });
  } catch (err) {
    console.error('Files API error:', err);
    if (!res.headersSent) return res.status(500).json({ success: false, message: 'File service error.' });
    res.end();
  }
};