const assert = require('assert');
const { ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-ca-workflow';

const store = {
  users: [
    { _id: new ObjectId(), username: 'smk', password: '1234', name: 'CA S. Masilamani', role: 'partner' },
    { _id: new ObjectId(), username: 'siva', password: '1234', name: 'Siva Staff', role: 'staff' }
  ],
  clients: [
    { _id: new ObjectId(), id: 1001, name: 'Acme Traders', pan: 'ABCDE1234F', contact: '9876543210', status: 'Active' }
  ],
  tasks: [
    { _id: new ObjectId(), id: 10001, clientCode: '1001', clientName: 'Acme Traders', natureOfWork: 'Income Tax Return (ITR)', assessmentYear: '2024-25', dateReceived: '2024-04-10', dueDate: '2024-07-31', currentStatus: 'Assigned', workTakenBy: 'siva', sendBackCount: 0 }
  ],
  attendance: [
    { _id: new ObjectId(), username: 'siva', date: '2026-10-09', status: 'Present', checkIn: '09:30', checkOut: null }
  ],
  audit_logs: [],
  engagements: [
    { title: 'Income Tax Return (ITR)' },
    { title: 'GSTR 3B' }
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
    updateOne: async (f, update, opts = {}) => {
      const doc = a.find((d) => match(d, f));
      if (!doc) {
        if (opts.upsert) {
          const newDoc = { ...f, ...(update.$set || {}) };
          newDoc._id = new ObjectId();
          a.push(newDoc);
          return { matchedCount: 0, modifiedCount: 1, upsertedId: newDoc._id };
        }
        return { matchedCount: 0, modifiedCount: 0 };
      }
      if (update.$set) Object.assign(doc, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    },
    deleteOne: async (f) => {
      const idx = a.findIndex((d) => match(d, f));
      if (idx !== -1) { a.splice(idx, 1); return { deletedCount: 1 }; }
      return { deletedCount: 0 };
    },
    countDocuments: async (f = {}) => a.filter((d) => match(d, f)).length,
    aggregate: () => ({ toArray: async () => [] })
  };
};

const mockDb = { collection: col };

require.cache[require.resolve('../api/_routes/db.js')] = {
  exports: { connectToDatabase: async () => ({ db: mockDb }) },
  loaded: true
};

const chatHandler = require('../api/_routes/chat.js');

const partnerToken = jwt.sign(
  { username: 'smk', role: 'partner', name: 'CA S. Masilamani' },
  process.env.JWT_SECRET
);

async function runTests() {
  console.log('🧪 Testing Staff Actions & Regex-Free Pattern Engine in Chat...\n');

  // Test 1: Explicit action create_task
  console.log('1. Testing staff action: create_task...');
  let resData = null;
  const res = {
    status: () => res,
    json: (d) => { resData = d; return res; }
  };
  await chatHandler({
    method: 'POST',
    headers: { authorization: `Bearer ${partnerToken}` },
    body: {
      action: 'create_task',
      clientCode: '1001',
      clientName: 'Acme Traders',
      natureOfWork: 'GSTR 3B',
      dueDate: '2026-10-20'
    }
  }, res);
  assert.ok(resData.success, 'create_task should succeed');
  assert.ok(resData.task.id, 'New task should have id');
  console.log(`   ✓ Created Task #${resData.task.id}`);

  // Test 2: Explicit action advance_status
  console.log('2. Testing staff action: advance_status...');
  await chatHandler({
    method: 'POST',
    headers: { authorization: `Bearer ${partnerToken}` },
    body: {
      action: 'advance_status',
      taskId: 10001,
      targetStatus: 'Pending Review'
    }
  }, res);
  assert.ok(resData.success, 'advance_status should succeed');
  assert.ok(resData.reply.includes('Pending Review'), 'Status should advance to Pending Review');
  console.log('   ✓ Advanced Task #10001 to Pending Review');

  // Test 3: Pattern engine greetings (regex free)
  console.log('3. Testing pattern engine: greetings (regex free)...');
  await chatHandler({
    method: 'POST',
    headers: { authorization: `Bearer ${partnerToken}` },
    body: {
      message: 'hello there',
      engine: 'pattern'
    }
  }, res);
  assert.ok(resData.success, 'Greeting should succeed');
  assert.ok(resData.reply.includes('Hello'), 'Should respond with welcome');
  console.log('   ✓ Responded to greeting');

  // Test 4: Pattern engine clock-in guard (regex free)
  console.log('4. Testing pattern engine: clock-in block (regex free)...');
  await chatHandler({
    method: 'POST',
    headers: { authorization: `Bearer ${partnerToken}` },
    body: {
      message: 'clock in now',
      engine: 'pattern'
    }
  }, res);
  assert.strictEqual(resData.success, false, 'Clock-in via chat must be refused');
  assert.ok(resData.reply.includes('cannot be performed via Chat'), 'Should instruct to use kiosk');
  console.log('   ✓ Refused clock-in via chat with instructions');

  // Test 5: Pattern engine tasks listing (regex free)
  console.log('5. Testing pattern engine: tasks query (regex free)...');
  await chatHandler({
    method: 'POST',
    headers: { authorization: `Bearer ${partnerToken}` },
    body: {
      message: 'show tasks',
      engine: 'pattern'
    }
  }, res);
  assert.ok(resData.success, 'Task query should succeed');
  assert.ok(resData.reply.includes('Workflow Tasks'), 'Should return task summary');
  console.log('   ✓ Returned task summary without regex');

  console.log('\n🎉 ALL STAFF ACTIONS & REGEX-FREE PATTERN TESTS PASSED!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
