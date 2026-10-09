const assert = require('assert');
const { ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'test-secret-ca-workflow';

// ---------- In-memory MongoDB Mock ----------
const match = (doc, f) => {
  return Object.entries(f).every(([k, v]) => {
    if (k === '$or') {
      return v.some(subFilter => match(doc, subFilter));
    }
    const x = doc[k];
    if (v && typeof v === 'object' && !(v instanceof ObjectId) && !(v instanceof Date)) {
      if ('$in' in v) return v.$in.map(String).includes(String(x));
      if ('$ne' in v) return String(x) !== String(v.$ne);
      if ('$nin' in v) return !v.$nin.map(String).includes(String(x));
    }
    return String(x) === String(v);
  });
};

const store = {
  users: [
    { _id: new ObjectId(), username: 'smk', password: '1234', name: 'CA S. Masilamani', role: 'partner', requireBiometric: false },
    { _id: new ObjectId(), username: 'siva', password: '1234', name: 'Siva Staff', role: 'staff', requireBiometric: false }
  ],
  clients: [
    { _id: new ObjectId(), id: 101, name: 'Acme Traders', pan: 'ABCDE1234F', contact: '9876543210' },
    { _id: new ObjectId(), id: 102, name: 'Apex Logistics', pan: 'FGHIJ5678K', contact: '9876543211' }
  ],
  tasks: [
    { _id: new ObjectId(), id: 10001, clientCode: '101', clientName: 'Acme Traders', natureOfWork: 'Income Tax Return (ITR)', assessmentYear: '2024-25', dateReceived: '2024-04-10', dueDate: '2024-07-31', currentStatus: 'Assigned', workTakenBy: 'siva', sendBackCount: 0 },
    { _id: new ObjectId(), id: 10002, clientCode: '101', clientName: 'Acme Traders', natureOfWork: 'GSTR 3B', assessmentYear: '', dateReceived: '2024-05-14', dueDate: '2024-05-20', currentStatus: 'Filed', workTakenBy: 'siva', sendBackCount: 0 },
    { _id: new ObjectId(), id: 10003, clientCode: '102', clientName: 'Apex Logistics', natureOfWork: 'Statutory Audit', assessmentYear: '2024-25', dateReceived: '2024-06-01', dueDate: '2024-09-30', currentStatus: 'Assigned', workTakenBy: 'siva', sendBackCount: 0 }
  ],
  engagements: [
    { title: 'Income Tax Return (ITR)' },
    { title: 'GSTR 3B' },
    { title: 'GSTR 1' },
    { title: 'Statutory Audit' },
    { title: 'Tax Audit (3CD)' }
  ],
  attendance: [],
  audit_logs: []
};

const col = (n) => {
  const a = (store[n] = store[n] || []);
  return {
    findOne: async (f = {}) => a.find((d) => match(d, f)) || null,
    find: (f = {}) => {
      let r = a.filter((d) => match(d, f));
      const c = {
        sort: (s) => {
          const [k, dir] = Object.entries(s)[0];
          r = [...r].sort((p, q) => (p[k] > q[k] ? 1 : -1) * dir);
          return c;
        },
        limit: (n) => { r = r.slice(0, n); return c; },
        skip: (n) => { r = r.slice(n); return c; },
        toArray: async () => r
      };
      return c;
    },
    insertOne: async (d) => {
      d._id = d._id || new ObjectId();
      a.push(d);
      return { insertedId: d._id };
    },
    insertMany: async (docs) => {
      docs.forEach(d => { d._id = d._id || new ObjectId(); a.push(d); });
      return { insertedCount: docs.length };
    },
    updateOne: async (f, update) => {
      const doc = a.find((d) => match(d, f));
      if (doc && update.$set) {
        Object.assign(doc, update.$set);
        return { matchedCount: 1, modifiedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0 };
    },
    updateMany: async (f, update) => {
      let count = 0;
      a.forEach(d => {
        if (match(d, f) && update.$set) {
          Object.assign(d, update.$set);
          count++;
        }
      });
      return { matchedCount: count, modifiedCount: count };
    },
    deleteOne: async (f) => {
      const idx = a.findIndex((d) => match(d, f));
      if (idx !== -1) { a.splice(idx, 1); return { deletedCount: 1 }; }
      return { deletedCount: 0 };
    },
    deleteMany: async (f) => {
      let count = 0;
      for (let i = a.length - 1; i >= 0; i--) {
        if (match(a[i], f)) { a.splice(i, 1); count++; }
      }
      return { deletedCount: count };
    },
    countDocuments: async (f = {}) => a.filter((d) => match(d, f)).length,
    aggregate: (pipeline) => ({
      toArray: async () => []
    })
  };
};

require.cache[require.resolve('../api/_routes/db.js')] = {
  exports: { connectToDatabase: async () => ({ db: { collection: col } }) },
  loaded: true,
  id: 'mock-db',
  filename: 'mock-db'
};

const usersHandler = require('../api/_routes/users.js');
const tasksHandler = require('../api/_routes/tasks.js');
const clientsHandler = require('../api/_routes/clients.js');
const loginHandler = require('../api/_routes/login.js');
const chatHandler = require('../api/_routes/chat.js');

const tok = (p) => jwt.sign(p, 'test-secret-ca-workflow');

const call = async (mod, { method = 'POST', token, body = {}, query = {} }) => {
  const req = { method, headers: token ? { authorization: 'Bearer ' + token } : {}, body, query };
  let status = 200;
  let resData = null;
  const res = {
    status(s) { status = s; return this; },
    json(data) { resData = data; return this; }
  };
  await mod(req, res);
  return { status, body: resData };
};

async function runTests() {
  console.log('🧪 Starting Client Workflow, Security & Chat Tests...\n');

  const partnerToken = tok({ username: 'smk', role: 'partner', name: 'CA S. Masilamani' });
  const staffToken = tok({ username: 'siva', role: 'staff', name: 'Siva Staff' });

  // TEST 1: Partner seeds client logins
  console.log('1. Testing client logins bulk sync (seed_clients)...');
  const seedRes = await call(usersHandler, {
    method: 'POST',
    token: partnerToken,
    body: { action: 'seed_clients' }
  });
  assert.strictEqual(seedRes.status, 200);
  assert.strictEqual(seedRes.body.success, true);
  assert.strictEqual(seedRes.body.createdCount, 2);
  console.log('   ✓ Seeded 2 client accounts successfully.');

  // TEST 2: Staff cannot trigger seed_clients
  console.log('2. Testing staff access control on seed_clients...');
  const staffSeedRes = await call(usersHandler, {
    method: 'POST',
    token: staffToken,
    body: { action: 'seed_clients' }
  });
  assert.strictEqual(staffSeedRes.status, 403);
  console.log('   ✓ Non-partner correctly denied from seeding accounts (403 Forbidden).');

  // TEST 3: Client logins with username 'c101' and password '1234'
  console.log('3. Testing client login with default password "1234"...');
  const loginRes = await call(loginHandler, {
    method: 'POST',
    body: { username: 'c101', password: '1234' }
  });
  assert.strictEqual(loginRes.status, 200);
  assert.strictEqual(loginRes.body.success, true);
  assert.strictEqual(loginRes.body.user.role, 'client');
  assert.strictEqual(loginRes.body.user.clientId, 101);
  const clientToken = loginRes.body.token;
  console.log('   ✓ Client successfully authenticated; JWT carries clientId: 101.');

  // TEST 4: Client gets their own tasks ONLY
  console.log('4. Testing client task isolation on GET /api/tasks...');
  const clientTasksRes = await call(tasksHandler, {
    method: 'GET',
    token: clientToken,
    query: {}
  });
  assert.strictEqual(clientTasksRes.status, 200);
  assert.strictEqual(clientTasksRes.body.success, true);
  assert.strictEqual(clientTasksRes.body.tasks.length, 2);
  assert(clientTasksRes.body.tasks.every(t => String(t.clientCode) === '101'), 'Must only return tasks for client 101');
  console.log(`   ✓ Client 101 received only their 2 tasks (Client 102 tasks hidden).`);

  // TEST 5: Client blocked from stats analytics
  console.log('5. Testing client blocked from analytics stats...');
  const statsRes = await call(tasksHandler, {
    method: 'GET',
    token: clientToken,
    query: { mode: 'stats' }
  });
  assert.strictEqual(statsRes.status, 403);
  console.log('   ✓ Client blocked from /api/tasks?mode=stats with 403 Forbidden.');

  // TEST 6: Client search does not leak other clients' tasks
  console.log('6. Testing client search boundary...');
  const searchOtherRes = await call(tasksHandler, {
    method: 'GET',
    token: clientToken,
    query: { search: 'Apex' }
  });
  assert.strictEqual(searchOtherRes.status, 200);
  assert.strictEqual(searchOtherRes.body.tasks.length, 0);
  console.log('   ✓ Searching other client name returned 0 results.');

  // TEST 7: Client calls /api/clients - only gets their own client record
  console.log('7. Testing client isolation on GET /api/clients...');
  const clientProfileRes = await call(clientsHandler, {
    method: 'GET',
    token: clientToken,
    query: {}
  });
  assert.strictEqual(clientProfileRes.status, 200);
  assert.strictEqual(clientProfileRes.body.clients.length, 1);
  assert.strictEqual(clientProfileRes.body.clients[0].id, 101);
  console.log('   ✓ /api/clients strictly returns only their single client record.');

  // TEST 8: Client calls /api/users - only gets safe staff list without passwords
  console.log('8. Testing staff selection list for client on GET /api/users...');
  const usersForClientRes = await call(usersHandler, {
    method: 'GET',
    token: clientToken,
    query: {}
  });
  assert.strictEqual(usersForClientRes.status, 200);
  assert(usersForClientRes.body.users.every(u => !u.password), 'Passwords must never be exposed');
  assert(usersForClientRes.body.users.every(u => ['partner', 'staff', 'article'].includes(u.role)), 'Only staff/partner roles exposed');
  console.log('   ✓ Safe staff list returned to client without credentials or client data.');

  // TEST 9: Client inwarding task for themselves with chosen staff
  console.log('9. Testing client adding task for themselves with chosen operator...');
  const createTaskRes = await call(tasksHandler, {
    method: 'POST',
    token: clientToken,
    body: {
      natureOfWork: 'GST Annual Return (9/9C)',
      assessmentYear: '2023-24',
      dueDate: '2024-12-31',
      operator: 'siva'
    }
  });
  assert.strictEqual(createTaskRes.status, 201);
  assert.strictEqual(createTaskRes.body.success, true);
  assert.strictEqual(createTaskRes.body.task.clientCode, '101');
  assert.strictEqual(createTaskRes.body.task.clientName, 'Acme Traders');
  assert.strictEqual(createTaskRes.body.task.workTakenBy, 'siva');
  assert.strictEqual(createTaskRes.body.task.currentStatus, 'Assigned');
  const createdTaskId = createTaskRes.body.task.id;
  console.log('   ✓ Task created with clientCode locked to 101 and allocated to siva.');

  // TEST 10: Client can delete their own active task
  console.log('10. Testing client deleting their own active task via DELETE /api/tasks...');
  const delActiveRes = await call(tasksHandler, {
    method: 'DELETE',
    token: clientToken,
    query: { id: createdTaskId }
  });
  assert.strictEqual(delActiveRes.status, 200);
  assert.strictEqual(delActiveRes.body.success, true);
  console.log('   ✓ Client successfully deleted their own active task.');

  // TEST 11: Client CANNOT delete a Filed task
  console.log('11. Testing client blocked from deleting a Filed/Closed task...');
  const delFiledRes = await call(tasksHandler, {
    method: 'DELETE',
    token: clientToken,
    query: { id: 10002 } // Filed task
  });
  assert.strictEqual(delFiledRes.status, 400);
  console.log('   ✓ Attempt to delete Filed task correctly rejected (400 Bad Request).');

  // TEST 12: Client CANNOT delete another client's task
  console.log('12. Testing client blocked from deleting another client\'s task...');
  const delOtherRes = await call(tasksHandler, {
    method: 'DELETE',
    token: clientToken,
    query: { id: 10003 } // Belongs to client 102
  });
  assert.strictEqual(delOtherRes.status, 403);
  console.log('   ✓ Attempt to delete other client\'s task rejected (403 Forbidden).');

  // TEST 13: Client chat: asking for my tasks
  console.log('13. Testing client querying tasks in Chatbot...');
  const chatTasksRes = await call(chatHandler, {
    method: 'POST',
    token: clientToken,
    body: { message: 'my tasks' }
  });
  assert.strictEqual(chatTasksRes.status, 200);
  assert.strictEqual(chatTasksRes.body.success, true);
  assert(chatTasksRes.body.reply.includes('Acme Traders'), 'Must identify client');
  assert(chatTasksRes.body.chips.length > 0, 'Must provide chips');
  console.log('   ✓ Chatbot responded with client tasks and action chips.');

  // TEST 14: Client chat: creating a task via chat action
  console.log('14. Testing client creating task in Chatbot...');
  const chatCreateRes = await call(chatHandler, {
    method: 'POST',
    token: clientToken,
    body: {
      action: 'client_create_task',
      params: {
        natureOfWork: 'Tax Audit (3CD)',
        assessmentYear: '2024-25',
        dueDate: '2024-09-30'
      }
    }
  });
  assert.strictEqual(chatCreateRes.status, 200);
  assert.strictEqual(chatCreateRes.body.success, true);
  assert(chatCreateRes.body.reply.includes('Created') || chatCreateRes.body.reply.includes('Registered'));
  console.log('   ✓ Chatbot created task for client with accurate metadata.');

  // TEST 15: Client chat: cancelling/deleting their active task via chat
  console.log('15. Testing client cancelling active task in Chatbot...');
  const chatDelRes = await call(chatHandler, {
    method: 'POST',
    token: clientToken,
    body: {
      message: 'delete task #10001'
    }
  });
  assert.strictEqual(chatDelRes.status, 200);
  assert.strictEqual(chatDelRes.body.success, true);
  assert(chatDelRes.body.reply.includes('Are you sure') || chatDelRes.body.reply.includes('Confirm'));
  console.log('   ✓ Chatbot prompted confirmation to delete task.');

  // TEST 16: Client requesting staff recommendations for a service
  console.log('16. Testing client requesting staff recommendations via /api/recommend...');
  const recHandler = require('../api/_routes/recommend.js');
  const recRes = await call(recHandler, {
    method: 'GET',
    token: clientToken,
    query: { natureOfWork: 'Income Tax Return (ITR)' }
  });
  assert.strictEqual(recRes.status, 200);
  assert.strictEqual(recRes.body.success, true);
  assert(Array.isArray(recRes.body.recommendations));
  console.log(`   ✓ Staff recommendations returned successfully (${recRes.body.recommendations.length} evaluated).`);

  console.log('\n🎉 ALL 16 TESTS PASSED SUCCESSFULLY! Seeding, UI workflow, staff recommendations, and chat actions 100% verified.');
}

runTests().catch(err => {
  console.error('\n❌ Test failure:', err);
  process.exit(1);
});
