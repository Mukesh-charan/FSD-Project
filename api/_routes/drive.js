const { connectToDatabase } = require('./db');
const { verifyToken, checkRole } = require('./auth');
const Drive = require('../../lib/driveClient');
const D = require('../../lib/docs');

module.exports = async (req, res) => {
  const decoded = verifyToken(req);
  if (!decoded) return res.status(401).json({ success: false, message: 'Unauthorized.' });
  if (!checkRole(decoded, ['partner'])) return res.status(403).json({ success: false, message: 'Forbidden: Admins only.' });

  const cfg = Drive.getDriveConfig();
  if (!cfg) return res.status(200).json({ success: true, configured: false });

  const action = (req.query && req.query.action) || (req.body && req.body.action) || 'status';

  // 1. SYNC ACTION: Scan Google Drive Client Vault & update MongoDB Atlas
  if (action === 'sync') {
    try {
      await Drive.getAccessToken(cfg);
      const { db } = await connectToDatabase();
      await Drive.ensureIndexes(db);

      const clientFolders = await Drive.listFiles(cfg, cfg.rootFolderId);
      let syncedCount = 0;

      for (const cFolder of clientFolders) {
        const m = /^(\d+)_+(.+)$/.exec(cFolder.name);
        if (!m) continue;
        const clientId = parseInt(m[1], 10);
        const clientName = m[2];

        // Ensure client in clients collection
        await db.collection('clients').updateOne(
          { id: clientId },
          { $setOnInsert: { id: clientId, name: clientName, createdAt: new Date() } },
          { upsert: true }
        );

        // Ensure user in users collection
        await db.collection('users').updateOne(
          { username: `c${clientId}` },
          {
            $setOnInsert: {
              username: `c${clientId}`,
              name: clientName,
              password: '1234',
              role: 'client',
              clientId: clientId,
              createdAt: new Date()
            }
          },
          { upsert: true }
        );

        async function scanFolder(folderId, relPath = '') {
          await db.collection('drive_folders').updateOne(
            { clientId, path: relPath },
            { $set: { clientId, path: relPath, folderId, updatedAt: new Date() } },
            { upsert: true }
          );

          const items = await Drive.listFiles(cfg, folderId);
          for (const item of items) {
            if (item.mimeType === 'application/vnd.google-apps.folder') {
              const subRel = relPath ? `${relPath}/${item.name}` : item.name;
              await scanFolder(item.id, subRel);
            } else {
              const fileName = item.name;
              const yr = D.parseYear(fileName) || D.parseYear(relPath);
              const types = D.matchDocTypes(fileName) || [];
              const docType = types[0] || 'Other Document';
              const info = D.typeInfo(docType);
              const category = info ? info.category : (relPath.includes('KYC') ? 'kyc' : 'received');

              const docRecord = {
                clientId,
                clientName,
                fy: yr ? yr.fy : null,
                ay: yr && yr.fy ? D.fyToAy(yr.fy) : null,
                category,
                docType,
                fileName,
                originalFileName: fileName,
                driveFileId: item.id,
                driveFolderId: folderId,
                folderPath: relPath,
                mimeType: item.mimeType,
                size: item.size ? parseInt(item.size, 10) : 1024,
                clientVisible: true,
                uploadedBy: 'drive_sync',
                uploadedByRole: 'partner',
                uploadedAt: new Date(),
                source: 'drive_sync'
              };

              await db.collection('documents').updateOne(
                { driveFileId: item.id },
                { $set: docRecord },
                { upsert: true }
              );
              syncedCount++;
            }
          }
        }

        await scanFolder(cFolder.id, '');
      }

      return res.status(200).json({
        success: true,
        count: syncedCount,
        message: `Successfully synced ${syncedCount} client documents from Google Drive!`
      });
    } catch (e) {
      console.error('Drive sync error:', e);
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  // 2. LIST FILES ACTION: Return documents registered in MongoDB
  if (action === 'listFiles') {
    try {
      const { db } = await connectToDatabase();
      const docs = await db.collection('documents').find({}).sort({ uploadedAt: -1 }).limit(100).toArray();
      const files = docs.map(d => ({
        id: d.driveFileId,
        name: `${d.fileName} (${d.clientName || 'Client #' + d.clientId})`,
        mimeType: d.mimeType,
        modifiedTime: d.uploadedAt,
        docId: String(d._id),
        webViewLink: `https://drive.google.com/file/d/${d.driveFileId}/view`
      }));
      return res.status(200).json({ success: true, files });
    } catch (e) {
      return res.status(500).json({ success: false, message: e.message });
    }
  }

  // 3. STATUS ACTION (default)
  try {
    await Drive.getAccessToken(cfg);
    return res.status(200).json({
      success: true,
      configured: true,
      connected: true,
      authType: 'oauth2',
      rootFolderId: cfg.rootFolderId
    });
  } catch (e) {
    return res.status(200).json({ success: true, configured: true, connected: false, error: e.message });
  }
};
