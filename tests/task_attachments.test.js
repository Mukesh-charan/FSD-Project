const assert = require('assert');
const { ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-ca-workflow';

// Mock DB
const store = {
  users: [
    { _id: new ObjectId(), username: 'smk', password: '1234', name: 'CA S. Masilamani', role: 'partner' },
    { _id: new ObjectId(), username: 'siva', password: '1234', name: 'Siva Staff', role: 'staff' },
    { _id: new ObjectId(), username: 'client1001', password: '1234', name: 'Ramesh Kumar', role: 'client', clientId: 1001 }
  ],
  clients: [
    { _id: new ObjectId(), id: 1001, name: 'Ramesh Kumar', pan: 'ABCDE1234F', contact: '9876543210' }
  ],
  tasks: [],
  documents: [],
  audit_logs: [],
  engagements: [
    { title: 'Income Tax Return (ITR)' },
    { title: 'GSTR 3B' },
    { title: 'GSTR 1' }
  ]
};

const match = (doc, f) => {
  return Object.entries(f).every(([k, v]) => {
    if (k === '$or') return v.some(sub => match(doc, sub));
    const x = doc[k];
    if (v && typeof v === 'object' && !(v instanceof ObjectId) && !(v instanceof Date)) {
      if ('$in' in v) return v.$in.map(String).includes(String(x));
      if ('$ne' in v) return String(x) !== String(v.$ne);
    }
    return String(x) === String(v);
  });
};

const col = (n) => {
  const a = (store[n] = store[n] || []);
  return {
    findOne: async (f = {}) => a.find((d) => match(d, f)) || null,
    find: (f = {}) => {
      let r = a.filter((d) => match(d, f));
      return {
        sort: () => ({ limit: () => ({ toArray: async () => r }), toArray: async () => r }),
        limit: () => ({ toArray: async () => r }),
        toArray: async () => r
      };
    },
    insertOne: async (d) => {
      d._id = d._id || new ObjectId();
      a.push(d);
      return { insertedId: d._id };
    },
    updateOne: async (f, update) => {
      const doc = a.find((d) => match(d, f));
      if (!doc) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(doc, update.$set);
      if (update.$push) {
        for (const [pk, pv] of Object.entries(update.$push)) {
          doc[pk] = doc[pk] || [];
          doc[pk].push(pv);
        }
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
    distinct: async (field, f = {}) => {
      const filtered = a.filter(d => match(d, f));
      return [...new Set(filtered.map(d => d[field]))];
    },
    countDocuments: async (f = {}) => a.filter((d) => match(d, f)).length,
    aggregate: () => ({ toArray: async () => [] })
  };
};

const mockDb = {
  collection: col
};

require.cache[require.resolve('../api/_routes/db.js')] = {
  exports: { connectToDatabase: async () => ({ db: mockDb }) },
  loaded: true
};

const tasksHandler = require('../api/_routes/tasks.js');
const chatHandler = require('../api/_routes/chat.js');
const { handleDocChat } = require('../lib/docChat.js');

const clientToken = jwt.sign(
  { username: 'client1001', role: 'client', name: 'Ramesh Kumar', clientId: 1001 },
  process.env.JWT_SECRET
);

async function runTests() {
  console.log('🧪 Testing Task Creation with Attached Files & Chat Workflow...\n');

  // Test 1: Task creation via tasks.js with attachedFiles
  console.log('1. Testing POST /api/tasks with attachedFiles array...');
  const req1 = {
    method: 'POST',
    headers: { authorization: `Bearer ${clientToken}` },
    body: {
      natureOfWork: 'Income Tax Return (ITR)',
      assessmentYear: '2025-26',
      dueDate: '2026-07-31',
      attachedFiles: [
        { docId: 'doc_123', fileName: 'Form16_Ramesh.pdf', driveFileId: 'gdrive_file_1' }
      ]
    }
  };
  let res1Data = null;
  let res1Status = 200;
  const res1 = {
    status: (s) => { res1Status = s; return res1; },
    json: (d) => { res1Data = d; return res1; }
  };

  await tasksHandler(req1, res1);
  assert.strictEqual(res1Status, 201, 'Task should be created with 201');
  assert.ok(res1Data.success, 'Task creation must succeed');
  assert.strictEqual(res1Data.task.attachedFiles.length, 1, 'attachedFiles should have 1 file');
  assert.strictEqual(res1Data.task.attachedFiles[0].fileName, 'Form16_Ramesh.pdf');
  const createdTaskId = res1Data.task.id;
  console.log(`   ✓ Task #${createdTaskId} created with 1 attached file.`);

  // Test 2: Chatbot task creation prompts for file attachment
  console.log('2. Testing Chatbot client task creation flow...');
  const req2 = {
    method: 'POST',
    headers: { authorization: `Bearer ${clientToken}` },
    body: {
      action: 'client_create_task',
      params: {
        natureOfWork: 'GSTR 3B',
        dueDate: '2026-10-20'
      }
    }
  };
  let res2Data = null;
  const res2 = {
    status: () => res2,
    json: (d) => { res2Data = d; return res2; }
  };

  await chatHandler(req2, res2);
  assert.ok(res2Data.success, 'Chat task creation should succeed');
  assert.ok(res2Data.reply.includes('attach files'), 'Reply should ask if client wants to attach files');
  const attachChip = res2Data.chips.find(c => c.action === 'trigger_chat_upload');
  assert.ok(attachChip, 'Should provide trigger_chat_upload chip');
  assert.ok(attachChip.params.taskId, 'trigger_chat_upload chip must include taskId');
  console.log(`   ✓ Chatbot created Task #${attachChip.params.taskId} and asked to attach files with action chip.`);

  // Test 3: Chatbot handles natural language intent to upload files
  console.log('3. Testing Chatbot natural language "upload document" intent...');
  const req3 = {
    method: 'POST',
    headers: { authorization: `Bearer ${clientToken}` },
    body: {
      message: 'upload document'
    }
  };
  let res3Data = null;
  const res3 = {
    status: () => res3,
    json: (d) => { res3Data = d; return res3; }
  };
  await chatHandler(req3, res3);
  assert.ok(res3Data.success, 'Natural language upload query should succeed');
  assert.ok(res3Data.chips.some(c => c.action === 'trigger_chat_upload'), 'Should provide trigger_chat_upload chip');
  console.log('   ✓ Chatbot responded to "upload document" with upload action chip.');

  // Test 4: docChat.js handleClassifyUpload preserves taskId
  console.log('4. Testing docChat upload classification with taskId...');
  const classifyResult = await handleDocChat({
    db: mockDb,
    decoded: { username: 'client1001', role: 'client', clientId: 1001 },
    query: '',
    action: 'classify_upload',
    body: {
      fileName: 'Bank_Statement_Oct.pdf',
      mimeType: 'application/pdf',
      size: 10240,
      taskId: createdTaskId,
      assessmentYear: '2025-26'
    }
  });
  assert.ok(classifyResult.success, 'Classification must succeed');
  assert.ok(classifyResult.reply.includes(`Task #${createdTaskId}`), 'Reply should mention task ID');
  const confirmChip = classifyResult.chips.find(c => c.action === 'upload_confirm');
  assert.ok(confirmChip, 'Should provide upload_confirm chip');
  assert.strictEqual(confirmChip.params.taskId, createdTaskId, 'confirm chip must retain taskId');
  console.log('   ✓ Classification correctly linked upload to Task #' + createdTaskId);

  console.log('\n🎉 ALL 4 ATTACHMENT & CHAT TESTS PASSED!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
