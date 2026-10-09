const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

// Load environment variables
['.env', '.env.local', '.env.production.local'].forEach(file => {
  const envPath = path.resolve(__dirname, '..', file);
  if (!fs.existsSync(envPath)) return;
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        const k = trimmed.slice(0, idx).trim();
        let v = trimmed.slice(idx + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (!process.env[k]) process.env[k] = v;
      }
    }
  });
});

const Drive = require('../lib/driveClient');
const D = require('../lib/docs');

async function syncDriveToMongo() {
  console.log('\n======================================================');
  console.log('      Sync Google Drive Client Documents to MongoDB');
  console.log('======================================================\n');

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri || mongoUri.includes('[SENSITIVE]')) {
    console.error('❌ MONGODB_URI is not set in your environment.');
    console.error('Run: $env:MONGODB_URI="mongodb+srv://..."; node scripts/sync_drive_to_mongo.js\n');
    process.exit(1);
  }

  const cfg = Drive.getDriveConfig();
  if (!cfg) {
    console.error('❌ Google Drive OAuth is not configured.');
    process.exit(1);
  }

  const client = new MongoClient(mongoUri);
  await client.connect();
  const db = client.db('ca_office_workflow');
  await Drive.ensureIndexes(db);

  console.log('Connected to MongoDB Atlas.');

  // List all client folders inside root
  const clientFolders = await Drive.listFiles(cfg, cfg.rootFolderId);
  console.log(`Found ${clientFolders.length} client folders in Google Drive.\n`);

  let syncedCount = 0;

  for (const cFolder of clientFolders) {
    const m = /^(\d+)_+(.+)$/.exec(cFolder.name);
    if (!m) continue;
    const clientId = parseInt(m[1], 10);
    const clientName = m[2];

    console.log(`👤 Client: ${clientName} (#${clientId})`);

    // Ensure client exists in clients collection
    await db.collection('clients').updateOne(
      { id: clientId },
      { $setOnInsert: { id: clientId, name: clientName, createdAt: new Date() } },
      { upsert: true }
    );

    // Ensure client user exists in users collection
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

    // Recursively scan folders
    async function scanFolder(folderId, relPath = '') {
      // Record folder in drive_folders
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
          // File
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
            uploadedBy: 'sync',
            uploadedByRole: 'system',
            uploadedAt: new Date(),
            source: 'drive_sync'
          };

          await db.collection('documents').updateOne(
            { driveFileId: item.id },
            { $set: docRecord },
            { upsert: true }
          );
          syncedCount++;
          console.log(`   ✓ Synced: ${fileName} (${docType}, ${yr ? yr.fy : 'KYC'})`);
        }
      }
    }

    await scanFolder(cFolder.id, '');
  }

  await client.close();

  console.log('\n======================================================');
  console.log(`🎉 SUCCESS: Synced ${syncedCount} documents to MongoDB Atlas!`);
  console.log(`Client c1001 can now log in and retrieve files via Chat.`);
  console.log('======================================================\n');
}

syncDriveToMongo().catch(err => {
  console.error('\n❌ Sync failed:', err);
  process.exit(1);
});
