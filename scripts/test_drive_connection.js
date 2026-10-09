const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { google } = require('googleapis');

// Load environment variables from .env / .env.local
function loadEnv() {
  const envCandidates = ['.env', '.env.local', '.env.production.local'];
  for (const file of envCandidates) {
    const envPath = path.resolve(__dirname, '..', file);
    if (!fs.existsSync(envPath)) continue;
    const content = fs.readFileSync(envPath, 'utf8');
    const lines = content.split(/\r?\n/);
    let currentKey = null;
    let currentValue = null;
    let quoteChar = null;

    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      if (quoteChar) {
        const endQuoteIndex = rawLine.indexOf(quoteChar);
        if (endQuoteIndex >= 0) {
          currentValue += '\n' + rawLine.slice(0, endQuoteIndex);
          if (!process.env[currentKey]) {
            process.env[currentKey] = currentValue;
          }
          currentKey = null;
          currentValue = null;
          quoteChar = null;
        } else {
          currentValue += '\n' + rawLine;
        }
        continue;
      }

      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;

      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();

      if (val.startsWith('"') || val.startsWith("'")) {
        const q = val[0];
        if (val.length > 1 && val.endsWith(q) && !val.endsWith('\\' + q)) {
          if (!process.env[key]) process.env[key] = val.slice(1, -1);
        } else {
          quoteChar = q;
          currentKey = key;
          currentValue = val.slice(1);
        }
      } else {
        const hash = val.indexOf('#');
        if (hash > 0) val = val.slice(0, hash).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
}

loadEnv();

// Parse CLI flags
const args = process.argv.slice(2);
let clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
let clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
let refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
let folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '1uQnyR7B6v0cNAZ4GzaqErktO0AgcQqju';
let saveEnv = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--client-id' && args[i + 1]) {
    clientId = args[i + 1]; i++;
  } else if (args[i] === '--client-secret' && args[i + 1]) {
    clientSecret = args[i + 1]; i++;
  } else if (args[i] === '--refresh-token' && args[i + 1]) {
    refreshToken = args[i + 1]; i++;
  } else if (args[i] === '--folder' && args[i + 1]) {
    folderId = args[i + 1]; i++;
  } else if (args[i] === '--save-env') {
    saveEnv = true;
  }
}

// Auto-fallback to local oauth-credentials.json if client ID or secret missing
if ((!clientId || !clientSecret) && fs.existsSync(path.resolve(process.cwd(), 'oauth-credentials.json'))) {
  try {
    const credFile = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'oauth-credentials.json'), 'utf8'));
    const creds = credFile.web || credFile.installed;
    if (creds) {
      clientId = clientId || creds.client_id;
      clientSecret = clientSecret || creds.client_secret;
    }
  } catch (_) {}
}

if (!clientId || !clientSecret || !refreshToken) {
  console.log(`
ℹ️  Google Drive OAuth Connection Test Diagnostics:
   Run with command line flags:
     node scripts/test_drive_connection.js --client-id "..." --client-secret "..." --refresh-token "..." --folder "1uQnyR7B6v0cNAZ4GzaqErktO0AgcQqju"

   OR configure in .env / Vercel:
     GOOGLE_OAUTH_CLIENT_ID="..."
     GOOGLE_OAUTH_CLIENT_SECRET="..."
     GOOGLE_OAUTH_REFRESH_TOKEN="..."
     GOOGLE_DRIVE_FOLDER_ID="1uQnyR7B6v0cNAZ4GzaqErktO0AgcQqju"

Missing configuration:
  ${!clientId ? '❌ GOOGLE_OAUTH_CLIENT_ID is missing' : '✅ GOOGLE_OAUTH_CLIENT_ID is present'}
  ${!clientSecret ? '❌ GOOGLE_OAUTH_CLIENT_SECRET is missing' : '✅ GOOGLE_OAUTH_CLIENT_SECRET is present (hidden)'}
  ${!refreshToken ? '❌ GOOGLE_OAUTH_REFRESH_TOKEN is missing' : '✅ GOOGLE_OAUTH_REFRESH_TOKEN is present (hidden)'}
  ${!folderId ? '❌ GOOGLE_DRIVE_FOLDER_ID is missing' : '✅ GOOGLE_DRIVE_FOLDER_ID is present (' + folderId + ')'}
`);
  process.exit(1);
}

async function runTest() {
  console.log('\n--- Google Drive OAuth 2.0 Connection & Upload Test ---');
  console.log(`Target Folder ID : ${folderId}`);
  console.log(`Client ID Prefix : ${clientId.slice(0, 16)}...`);
  let hasErrors = false;
  let testFileId = null;

  // 1. Initialize OAuth2 Client and test token refresh
  process.stdout.write('\n1. Testing OAuth 2.0 Client & Token Refresh... ');
  let oauthClient;
  let drive;
  try {
    oauthClient = new google.auth.OAuth2(clientId, clientSecret);
    oauthClient.setCredentials({ refresh_token: refreshToken });
    const tokenRes = await oauthClient.getAccessToken();
    if (!tokenRes.token) throw new Error('No access token returned from refresh token.');
    drive = google.drive({ version: 'v3', auth: oauthClient });
    console.log('✅ OK (Access token refreshed successfully)');
  } catch (err) {
    console.log('❌ FAILED');
    console.error(`   Error refreshing OAuth token: ${err.message}`);
    hasErrors = true;
    process.exit(1);
  }

  // 2. Verify target folder access
  process.stdout.write(`2. Verifying access to target folder (${folderId})... `);
  try {
    const folderRes = await drive.files.get({
      fileId: folderId,
      fields: 'id, name, mimeType, capabilities',
      supportsAllDrives: true
    });
    if (folderRes.data.mimeType !== 'application/vnd.google-apps.folder') {
      throw new Error(`Item ${folderId} is not a Google Drive folder (type: ${folderRes.data.mimeType})`);
    }
    console.log(`✅ OK (Found folder: "${folderRes.data.name}")`);
  } catch (err) {
    console.log('❌ FAILED');
    console.error(`   Error accessing folder: ${err.message}`);
    hasErrors = true;
    process.exit(1);
  }

  // 3. Upload a temporary test file using user's quota
  const testFileName = `__oauth_verify_${Date.now()}.txt`;
  const testContent = `Google Drive OAuth verification passed on ${new Date().toISOString()}`;
  process.stdout.write(`3. Uploading test file ("${testFileName}") using personal quota... `);
  try {
    const uploadRes = await drive.files.create({
      requestBody: {
        name: testFileName,
        parents: [folderId]
      },
      media: {
        mimeType: 'text/plain',
        body: Readable.from(Buffer.from(testContent, 'utf8'))
      },
      fields: 'id, name, size',
      supportsAllDrives: true
    });

    if (!uploadRes.data.id) {
      throw new Error('Upload succeeded but no file ID returned.');
    }
    testFileId = uploadRes.data.id;
    console.log(`✅ OK (Created File ID: ${testFileId})`);
  } catch (err) {
    console.log('❌ FAILED');
    console.error(`   Upload error: ${err.message}`);
    hasErrors = true;
  }

  // 4. Download and verify content
  if (testFileId && !hasErrors) {
    process.stdout.write('4. Reading back uploaded test file... ');
    try {
      const getRes = await drive.files.get(
        { fileId: testFileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      );

      const chunks = [];
      await new Promise((resolve, reject) => {
        getRes.data.on('data', chunk => chunks.push(chunk));
        getRes.data.on('end', resolve);
        getRes.data.on('error', reject);
      });

      const downloadedText = Buffer.concat(chunks).toString('utf8');
      if (downloadedText === testContent) {
        console.log('✅ OK (Content matches exactly)');
      } else {
        console.log('❌ FAILED (Content mismatch)');
        hasErrors = true;
      }
    } catch (err) {
      console.log('❌ FAILED');
      console.error(`   Read-back error: ${err.message}`);
      hasErrors = true;
    }
  }

  // 5. Cleanup temporary test file
  if (testFileId) {
    process.stdout.write('5. Cleaning up temporary test file... ');
    try {
      await drive.files.delete({ fileId: testFileId, supportsAllDrives: true });
      console.log('✅ OK (Deleted test file)');
    } catch (cleanupErr) {
      console.log(`⚠️ Warning: could not delete temporary file: ${cleanupErr.message}`);
    }
  }

  // 6. Final verification report
  if (hasErrors) {
    console.error('\n❌ DRIVE INTEGRATION VERIFICATION FAILED.');
    console.error('One or more required steps failed. Please review errors above.\n');
    process.exit(1);
  }

  console.log('\n🎉 ALL GOOGLE DRIVE OAUTH TESTS PASSED!');
  console.log('Google Drive OAuth 2.0 integration is fully operational.\n');

  if (saveEnv) {
    const envFilePath = path.resolve(__dirname, '../.env');
    let envContent = fs.existsSync(envFilePath) ? fs.readFileSync(envFilePath, 'utf8') : '';
    const updateOrAppend = (k, v) => {
      const regex = new RegExp(`^${k}=.*$`, 'm');
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${k}=${v}`);
      } else {
        envContent += `\n${k}=${v}`;
      }
    };
    updateOrAppend('GOOGLE_OAUTH_CLIENT_ID', clientId);
    updateOrAppend('GOOGLE_OAUTH_CLIENT_SECRET', clientSecret);
    updateOrAppend('GOOGLE_OAUTH_REFRESH_TOKEN', refreshToken);
    updateOrAppend('GOOGLE_DRIVE_FOLDER_ID', folderId);

    fs.writeFileSync(envFilePath, envContent.trim() + '\n', 'utf8');
    console.log(`✅ Saved configuration directly to ${envFilePath}!`);
  }
}

runTest().catch((err) => {
  console.error('\nFatal test execution error:', err);
  process.exit(1);
});
