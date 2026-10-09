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

// Minimal valid PDF generator
function createSamplePdf(title, subtitle, clientName, details) {
  const sanitize = (s) => String(s || '').replace(/[()\\/]/g, ' ');
  const content = [
    `BT`,
    `/F1 16 Tf 50 780 Td (${sanitize(title)}) Tj`,
    `0 -25 Td /F1 12 Tf (${sanitize(subtitle)}) Tj`,
    `0 -20 Td /F1 11 Tf (Client: ${sanitize(clientName)}) Tj`,
    `0 -20 Td /F1 10 Tf (Details: ${sanitize(details)}) Tj`,
    `0 -25 Td /F1 9 Tf (This is a generated sample tax document for demonstration purposes.) Tj`,
    `0 -15 Td /F1 9 Tf (Generated on: ${new Date().toISOString()}) Tj`,
    `ET`
  ].join('\n');

  const streamLength = Buffer.byteLength(content);
  const pdfString = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length ${streamLength} >> stream
${content}
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000244 00000 n 
0000000300 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref
369
%%EOF`;
  return Buffer.from(pdfString, 'utf8');
}

// In-memory mock DB if MongoDB is not available locally
function createMemoryDb() {
  const store = { drive_folders: [], documents: [] };
  return {
    collection: (name) => {
      const arr = store[name] || (store[name] = []);
      return {
        findOne: async (q) => arr.find(item => Object.entries(q).every(([k, v]) => String(item[k]) === String(v))) || null,
        insertOne: async (doc) => { arr.push(doc); return { insertedId: doc._id || 'mock_' + Date.now() }; },
        createIndex: async () => 'ok',
        countDocuments: async () => arr.length
      };
    }
  };
}

async function seed() {
  console.log('\n======================================================');
  console.log('       Google Drive Client Sample Files Seeder');
  console.log('======================================================\n');

  const cfg = Drive.getDriveConfig();
  if (!cfg) {
    console.error('❌ Google Drive OAuth is not configured.');
    process.exit(1);
  }

  // Connect to MongoDB if available
  let db = null;
  let mongoClient = null;
  let clients = [];

  const mongoUri = process.env.MONGODB_URI;
  if (mongoUri && !mongoUri.includes('[SENSITIVE]')) {
    try {
      console.log('Connecting to MongoDB Atlas...');
      mongoClient = new MongoClient(mongoUri);
      await mongoClient.connect();
      db = mongoClient.db('ca_office_workflow');
      await Drive.ensureIndexes(db);
      clients = await db.collection('clients').find({}).limit(3).toArray();
      console.log(`✅ Connected to MongoDB Atlas. Found ${clients.length} clients to seed.`);
    } catch (err) {
      console.warn(`⚠️ MongoDB connection skipped (${err.message}). Using local DB cache.`);
      db = createMemoryDb();
    }
  } else {
    console.log('ℹ️  No live MongoDB URI in local env. Seeding Drive files and caching folder IDs locally.');
    db = createMemoryDb();
  }

  if (clients.length === 0) {
    clients = [
      { id: 1001, name: 'Ramesh Kumar', pan: 'ABCDE1234F' },
      { id: 1002, name: 'Anita Sharma', pan: 'BKWPS5678K' }
    ];
  }

  console.log(`\nStarting upload for ${clients.length} clients into Drive Folder: ${cfg.rootFolderId}...\n`);

  let totalUploaded = 0;

  for (const client of clients) {
    console.log(`------------------------------------------------------`);
    console.log(`👤 Client: ${client.name} (#${client.id})`);
    console.log(`------------------------------------------------------`);

    const docPlan = [
      // KYC
      { category: 'kyc', fy: null, docType: 'PAN Card', fileName: 'PAN_Card.pdf', title: 'Permanent Account Number Card', details: `PAN: ${client.pan || 'ABCDE1234F'}` },
      { category: 'kyc', fy: null, docType: 'Aadhaar', fileName: 'Aadhaar_Card.pdf', title: 'Aadhaar Card Copy', details: 'UID: XXXX-XXXX-9012' },

      // FY 2024-25
      { category: 'received', fy: '2024-25', docType: 'Form 16', fileName: 'Form16_FY2024-25.pdf', title: 'Form 16 (Part A & B)', details: 'Gross Salary: Rs. 14,50,000 | TDS: Rs. 1,42,000' },
      { category: 'received', fy: '2024-25', docType: 'Bank Statement', fileName: 'Bank_Statement_FY2024-25.pdf', title: 'Annual Savings Account Statement', details: 'HDFC Bank A/c 501002... | Closing Balance: Rs. 3,85,420' },
      { category: 'working', fy: '2024-25', docType: 'Computation of Income', fileName: 'Computation_of_Income_FY2024-25.pdf', title: 'Computation of Total Income', details: 'Net Taxable Income: Rs. 12,85,000' },
      { category: 'filed', fy: '2024-25', docType: 'ITR-V', fileName: 'ITR-V_AY2025-26.pdf', title: 'ITR-V Verification Acknowledgement', details: 'Ack No: 98124019283712 | Status: Verified' },

      // FY 2023-24
      { category: 'received', fy: '2023-24', docType: 'Form 16', fileName: 'Form16_FY2023-24.pdf', title: 'Form 16 (Part A & B)', details: 'Gross Salary: Rs. 12,80,000 | TDS: Rs. 1,18,000' },
      { category: 'filed', fy: '2023-24', docType: 'ITR-V', fileName: 'ITR-V_AY2024-25.pdf', title: 'ITR-V Verification Acknowledgement', details: 'Ack No: 87123912093811 | Status: Processed' }
    ];

    for (const item of docPlan) {
      const perFy = item.fy !== null;
      const folderPath = perFy 
        ? `${D.fyFolderName(item.fy)}/${D.CATEGORIES[item.category].folder}`
        : D.CATEGORIES[item.category].folder;

      process.stdout.write(`  📁 [${folderPath}] -> ${item.fileName}... `);

      // Ensure Drive folder
      const folderId = await Drive.ensureFolder(db, cfg, client.id, client.name, folderPath);

      // Generate PDF buffer
      const buffer = createSamplePdf(item.title, `Financial Year: ${item.fy || 'All Years (KYC)'}`, client.name, item.details);

      // Upload file to Drive
      const uploaded = await Drive.uploadFile(cfg, {
        name: item.fileName,
        mimeType: 'application/pdf',
        buffer,
        parentId: folderId
      });

      // Record in Mongo / cache
      const docRecord = {
        clientId: client.id,
        clientName: client.name,
        fy: item.fy,
        ay: item.fy ? D.fyToAy(item.fy) : null,
        category: item.category,
        docType: item.docType,
        fileName: item.fileName,
        originalFileName: item.fileName,
        driveFileId: uploaded.id,
        driveFolderId: folderId,
        folderPath,
        mimeType: 'application/pdf',
        size: buffer.length,
        clientVisible: true,
        uploadedBy: 'demo_seeder',
        uploadedByRole: 'partner',
        uploadedAt: new Date(),
        source: 'seed'
      };

      await db.collection('documents').insertOne(docRecord);
      totalUploaded++;

      console.log(`✅ OK (File ID: ${uploaded.id.slice(0, 15)}...)`);
    }
    console.log();
  }

  if (mongoClient) {
    await mongoClient.close();
  }

  console.log('======================================================');
  console.log(`🎉 SUCCESS: Uploaded ${totalUploaded} sample client documents!`);
  console.log(`All files are now organized in your Google Drive.`);
  console.log('======================================================\n');
}

seed().catch(err => {
  console.error('\n❌ Seeding failed:', err);
  process.exit(1);
});
