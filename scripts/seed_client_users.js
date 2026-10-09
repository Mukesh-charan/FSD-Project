const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

// Helper to find MongoDB URI from environment or .env files
function getMongoUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;

  const envFiles = ['.env', '.env.local', '.env.production.local'];
  for (const file of envFiles) {
    const fullPath = path.join(__dirname, '..', file);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      const match = content.match(/MONGODB_URI\s*=\s*["']?([^\r\n"']+)["']?/);
      if (match && match[1] && !match[1].includes('[SENSITIVE]')) {
        return match[1].trim();
      }
    }
  }
  return null;
}

async function seedClientUsers() {
  const uri = getMongoUri();
  if (!uri) {
    console.error('❌ MONGODB_URI not found in process.env or .env files.');
    console.error('Usage: MONGODB_URI="mongodb+srv://..." node scripts/seed_client_users.js');
    process.exit(1);
  }

  console.log('Connecting to MongoDB Atlas...');
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db('ca_office_workflow');
    const clientsCol = db.collection('clients');
    const usersCol = db.collection('users');

    const clients = await clientsCol.find({}).sort({ id: 1 }).toArray();
    console.log(`Found ${clients.length} clients in database.\n`);

    if (clients.length === 0) {
      console.log('No clients found in `clients` collection.');
      process.exit(0);
    }

    let createdCount = 0;
    let updatedCount = 0;
    const tableData = [];

    for (const c of clients) {
      const username = `c${c.id}`;
      const name = c.name || `Client #${c.id}`;
      const defaultPassword = '1234';

      const existingUser = await usersCol.findOne({
        $or: [
          { username },
          { role: 'client', clientId: c.id }
        ]
      });

      if (existingUser) {
        await usersCol.updateOne(
          { _id: existingUser._id },
          {
            $set: {
              username,
              password: defaultPassword,
              name,
              role: 'client',
              clientId: c.id,
              requireBiometric: false
            }
          }
        );
        updatedCount++;
        tableData.push({ 'Client ID': c.id, 'Client Name': name, 'Username': username, 'Password': defaultPassword, 'Status': 'Updated' });
      } else {
        await usersCol.insertOne({
          username,
          password: defaultPassword,
          name,
          role: 'client',
          clientId: c.id,
          requireBiometric: false,
          faceDescriptor: null
        });
        createdCount++;
        tableData.push({ 'Client ID': c.id, 'Client Name': name, 'Username': username, 'Password': defaultPassword, 'Status': 'Created' });
      }
    }

    console.table(tableData.slice(0, 20));
    if (tableData.length > 20) {
      console.log(`... and ${tableData.length - 20} more client accounts.`);
    }

    console.log(`\n✅ Seeding Complete: ${createdCount} client accounts created, ${updatedCount} updated.`);
    console.log(`🔑 All accounts initialized with password: "1234"`);
  } catch (err) {
    console.error('❌ Error during client user seeding:', err);
    process.exit(1);
  } finally {
    await client.close();
  }
}

seedClientUsers();
