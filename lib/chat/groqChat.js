const { logAuditAction } = require('../../api/_routes/auth');
const { computeRecommendations } = require('../../api/_routes/recommend');
const { isGstWorkCheck, getISTDateDetails, getNextTaskId, findClientFuzzy } = require('./chatHelpers');

const GROQ_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a new workflow task for a client in the CA office ledger.',
      parameters: {
        type: 'object',
        properties: {
          clientName: { type: 'string', description: 'Name of the client firm or individual (e.g. Apex Logistics, Ram & Co)' },
          clientCode: { type: 'string', description: 'Client ID / code if known, otherwise omitted or inferred' },
          natureOfWork: { type: 'string', description: 'Work nature (e.g. GST Monthly Return, Income Tax Audit, TDS Filing, CMP-08 Filing)' },
          dueDate: { type: 'string', description: 'Due date in YYYY-MM-DD format (e.g. 2026-10-20)' },
          assessmentYear: { type: 'string', description: 'Assessment year/period (e.g. 2024-25), blank if GST' },
          operator: { type: 'string', description: 'Staff username to assign this task to (e.g. rahul, priya)' }
        },
        required: ['clientName', 'natureOfWork', 'dueDate']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_task',
      description: 'Update an existing task details like due date, assigned operator, status, or remarks.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'number', description: 'Sequential Task ID (e.g. 10001)' },
          dueDate: { type: 'string', description: 'New due date in YYYY-MM-DD format' },
          operator: { type: 'string', description: 'New assigned staff username' },
          currentStatus: { type: 'string', enum: ['Unassigned', 'Assigned', 'Pending Review', 'Approved', 'Filed', 'Rework'], description: 'New workflow status' },
          reasonForPending: { type: 'string', description: 'Pending reason or remarks' }
        },
        required: ['taskId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_task',
      description: 'Delete a task from the ledger. Requires partner/admin role.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'number', description: 'Sequential Task ID to delete' }
        },
        required: ['taskId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'advance_task_status',
      description: 'Advance or transition the lifecycle status of a workflow task.',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'number', description: 'Sequential Task ID' },
          targetStatus: { type: 'string', enum: ['Assigned', 'Pending Review', 'Approved', 'Filed', 'Rework'], description: 'Next status' },
          reason: { type: 'string', description: 'Remarks or reason if marking Rework or Pending' },
          operator: { type: 'string', description: 'Username if assigning' }
        },
        required: ['taskId', 'targetStatus']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_tasks',
      description: 'Search, filter, or list tasks from the office workflow database.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search term for client name, work nature, or task ID' },
          status: { type: 'string', description: 'Filter by status (Unassigned, Assigned, Pending Review, Approved, Filed, Rework)' },
          operator: { type: 'string', description: 'Filter by assigned staff username' },
          limit: { type: 'number', description: 'Maximum results to return (default 10)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_client',
      description: 'Create/register a new client in the master database. Requires partner/admin role.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Full business or client name' },
          pan: { type: 'string', description: '10-character PAN number' },
          contact: { type: 'string', description: 'Primary phone/mobile number' },
          email: { type: 'string', description: 'Email address' },
          gstNumber: { type: 'string', description: '15-character GSTIN' },
          gstStaff: { type: 'string', description: 'Default GST staff username' },
          status: { type: 'string', enum: ['Active', 'Inactive'], description: 'Client status' }
        },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_client',
      description: 'Update an existing client details. Requires partner/admin role.',
      parameters: {
        type: 'object',
        properties: {
          clientId: { type: 'number', description: 'Client ID number' },
          name: { type: 'string', description: 'Updated client name' },
          pan: { type: 'string', description: 'Updated PAN' },
          contact: { type: 'string', description: 'Updated contact phone' },
          email: { type: 'string', description: 'Updated email' },
          gstNumber: { type: 'string', description: 'Updated GSTIN' },
          status: { type: 'string', enum: ['Active', 'Inactive'] }
        },
        required: ['clientId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_client',
      description: 'Delete a client and all their tasks. Requires partner/admin role.',
      parameters: {
        type: 'object',
        properties: {
          clientId: { type: 'number', description: 'Client ID number to delete' }
        },
        required: ['clientId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_clients',
      description: 'Search or list registered clients by name, PAN, phone, or status.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Client name, PAN, or phone number' },
          status: { type: 'string', description: 'Active or Inactive' },
          limit: { type: 'number', description: 'Max results to return (default 10)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_attendance',
      description: 'Check attendance records (present/absent/on duty) for staff today or on a given date.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date in YYYY-MM-DD format (default today)' },
          username: { type: 'string', description: 'Optional username to check specific staff' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mark_on_duty',
      description: 'Mark a staff member as On Duty (OD) for a given date. Requires partner/admin role.',
      parameters: {
        type: 'object',
        properties: {
          username: { type: 'string', description: 'Staff username to mark On Duty' },
          date: { type: 'string', description: 'Date in YYYY-MM-DD format (default today)' }
        },
        required: ['username']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_staff_recommendations',
      description: 'Get smart workload-balanced staff recommendations for a task/nature of work.',
      parameters: {
        type: 'object',
        properties: {
          natureOfWork: { type: 'string', description: 'Nature of work' },
          limit: { type: 'number', description: 'Number of recommendations (default 3)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_office_stats',
      description: 'Get office workflow statistics, queue counts by status, client totals, and filing leaderboard.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  }
];

async function callGroqChatCompletions(messages, tools, apiKey, model) {
  const modelName = model || process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: modelName,
      messages,
      ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      temperature: 0.1,
      max_tokens: 1024
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Groq API HTTP ${resp.status}: ${errText}`);
  }

  return await resp.json();
}

async function executeLlmToolCall(name, args, { db, decoded, isAdmin, allClients, allUsers }) {
  const clientsCol = db.collection('clients');
  const tasksCol = db.collection('tasks');
  const attendanceCol = db.collection('attendance');
  const usersCol = db.collection('users');

  if (name === 'create_task') {
    if (!isAdmin) return { success: false, error: 'Forbidden: Admins only can create tasks.' };
    let cCode = String(args.clientCode || '').trim();
    const cName = String(args.clientName || '').trim();
    const nature = String(args.natureOfWork || '').trim();
    const dueDate = args.dueDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
    const isGst = isGstWorkCheck(nature);
    const ay = isGst ? '' : String(args.assessmentYear || '').trim();
    const op = args.operator ? String(args.operator).trim().toLowerCase() : '';

    if (!cName) return { success: false, error: 'Client name is required.' };
    if (!nature) return { success: false, error: 'Nature of work is required.' };

    if (!cCode) {
      const matchC = findClientFuzzy(allClients, cName);
      cCode = matchC ? String(matchC.id) : String(Math.floor(10000 + Math.random() * 90000));
    }

    const dup = await tasksCol.findOne({
      clientCode: cCode,
      natureOfWork: nature,
      currentStatus: { $ne: 'Filed' },
      ...(ay ? { assessmentYear: ay } : {})
    });
    if (dup) {
      return { success: false, duplicate: true, existingTaskId: dup.id, message: `Duplicate: Active task #${dup.id} already exists for ${cName} (${nature}).` };
    }

    const nextId = await getNextTaskId(tasksCol);
    const nowStr = new Date().toISOString().split('T')[0];
    const newTask = {
      id: nextId,
      clientCode: cCode,
      clientName: cName,
      natureOfWork: nature,
      assessmentYear: ay,
      dateReceived: nowStr,
      dueDate,
      currentStatus: op ? 'Assigned' : 'Unassigned',
      workTakenBy: op,
      workTakenOn: op ? nowStr : '',
      sendBackCount: 0,
      reasonForPending: '',
      attachedFiles: []
    };
    await tasksCol.insertOne(newTask);
    await logAuditAction(db, decoded.username, 'CREATE_TASK_LLM', { taskId: nextId, clientName: cName });
    return { success: true, taskId: nextId, task: newTask };
  }

  if (name === 'update_task') {
    const tId = parseInt(args.taskId, 10);
    if (!tId) return { success: false, error: 'Task ID is required' };
    const task = await tasksCol.findOne({ id: tId });
    if (!task) return { success: false, error: `Task #${tId} not found` };

    const updates = {};
    if (args.dueDate) updates.dueDate = args.dueDate;
    if (args.operator !== undefined) {
      updates.workTakenBy = String(args.operator).trim().toLowerCase();
      if (updates.workTakenBy && task.currentStatus === 'Unassigned') {
        updates.currentStatus = 'Assigned';
        updates.workTakenOn = new Date().toISOString().split('T')[0];
      }
    }
    if (args.currentStatus) updates.currentStatus = args.currentStatus;
    if (args.reasonForPending !== undefined) updates.reasonForPending = args.reasonForPending;

    await tasksCol.updateOne({ _id: task._id }, { $set: updates });
    const updated = await tasksCol.findOne({ _id: task._id });
    await logAuditAction(db, decoded.username, 'UPDATE_TASK_LLM', { taskId: tId, updates });
    return { success: true, taskId: tId, task: updated };
  }

  if (name === 'delete_task') {
    if (!isAdmin) return { success: false, error: 'Forbidden: Admins only can delete tasks.' };
    const tId = parseInt(args.taskId, 10);
    if (!tId) return { success: false, error: 'Task ID is required' };
    const resDel = await tasksCol.deleteOne({ id: tId });
    if (resDel.deletedCount === 0) return { success: false, error: `Task #${tId} not found.` };
    await logAuditAction(db, decoded.username, 'DELETE_TASK_LLM', { taskId: tId });
    return { success: true, deletedTaskId: tId };
  }

  if (name === 'advance_task_status') {
    const tId = parseInt(args.taskId, 10);
    const targetStatus = args.targetStatus;
    if (!tId || !targetStatus) return { success: false, error: 'Task ID and targetStatus are required' };
    const task = await tasksCol.findOne({ id: tId });
    if (!task) return { success: false, error: `Task #${tId} not found` };

    if (['Approved', 'Filed'].includes(targetStatus) && !isAdmin) {
      return { success: false, error: 'Forbidden: Partner/admin role required for approval or filing.' };
    }

    const updates = { currentStatus: targetStatus };
    const today = new Date().toISOString().split('T')[0];
    if (targetStatus === 'Filed') updates.filedDate = today;
    if (targetStatus === 'Rework') {
      updates.sendBackCount = (task.sendBackCount || 0) + 1;
      if (args.reason) updates.reasonForPending = args.reason;
    }
    if (args.operator) {
      updates.workTakenBy = String(args.operator).trim().toLowerCase();
      updates.workTakenOn = today;
    }

    await tasksCol.updateOne({ _id: task._id }, { $set: updates });
    const updated = await tasksCol.findOne({ _id: task._id });
    await logAuditAction(db, decoded.username, 'STATUS_ADVANCE_LLM', { taskId: tId, targetStatus });
    return { success: true, taskId: tId, previousStatus: task.currentStatus, currentStatus: targetStatus, task: updated };
  }

  if (name === 'search_tasks') {
    const filter = {};
    if (args.status) filter.currentStatus = args.status;
    if (args.operator) filter.workTakenBy = String(args.operator).trim().toLowerCase();
    if (args.query) {
      const q = String(args.query).trim().replace('#', '');
      const numQ = parseInt(q, 10);
      if (!isNaN(numQ)) {
        filter.$or = [{ id: numQ }, { clientCode: String(numQ) }];
      } else {
        filter.$or = [
          { clientName: { $regex: q, $options: 'i' } },
          { natureOfWork: { $regex: q, $options: 'i' } }
        ];
      }
    }
    const limit = Math.min(args.limit || 10, 20);
    const list = await tasksCol.find(filter).sort({ dueDate: 1 }).limit(limit).toArray();
    return {
      success: true,
      count: list.length,
      tasks: list.map(t => ({
        id: t.id,
        clientCode: t.clientCode,
        clientName: t.clientName,
        natureOfWork: t.natureOfWork,
        currentStatus: t.currentStatus,
        workTakenBy: t.workTakenBy || 'Unassigned',
        dueDate: t.dueDate
      }))
    };
  }

  if (name === 'create_client') {
    if (!isAdmin) return { success: false, error: 'Forbidden: Admins only can create clients.' };
    const cName = String(args.name || '').trim();
    if (!cName) return { success: false, error: 'Client name is required.' };

    const highest = await clientsCol.find({ id: { $type: 'number' } }).sort({ id: -1 }).limit(1).toArray();
    const nextCId = highest.length > 0 ? highest[0].id + 1 : 101;

    const newClient = {
      id: nextCId,
      name: cName,
      pan: (args.pan || '').toUpperCase().trim(),
      contact: args.contact || '',
      email: args.email || '',
      gstNumber: (args.gstNumber || '').toUpperCase().trim(),
      gstStaff: args.gstStaff || '',
      status: args.status || 'Active'
    };
    await clientsCol.insertOne(newClient);
    await logAuditAction(db, decoded.username, 'CREATE_CLIENT_LLM', { clientId: nextCId, name: cName });
    return { success: true, clientId: nextCId, client: newClient };
  }

  if (name === 'check_attendance') {
    const dateStr = args.date || getISTDateDetails().dateStr;
    const filter = { date: dateStr };
    if (args.username) filter.username = String(args.username).trim().toLowerCase();
    const records = await attendanceCol.find(filter).toArray();
    return {
      success: true,
      date: dateStr,
      count: records.length,
      records: records.map(r => ({
        username: r.username,
        name: r.name,
        role: r.role,
        status: r.status,
        checkIn: r.checkIn || '-',
        checkOut: r.checkOut || '-'
      }))
    };
  }

  if (name === 'get_office_stats') {
    const totalTasks = await tasksCol.countDocuments({});
    const statusCounts = await tasksCol.aggregate([
      { $group: { _id: '$currentStatus', count: { $sum: 1 } } }
    ]).toArray();
    const sMap = {};
    statusCounts.forEach(s => { sMap[s._id] = s.count; });
    const totalClients = await clientsCol.countDocuments({});
    const totalUsers = await usersCol.countDocuments({});

    return {
      success: true,
      totalTasks,
      statusBreakdown: sMap,
      totalClients,
      totalUsers
    };
  }

  return { success: false, error: `Unknown tool: ${name}` };
}

async function handleGroqLlmChatTurn(req, res, { db, decoded, isAdmin, allClients, allUsers, query, history }) {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

  const systemPrompt = `You are the intelligent AI Office Workflow Assistant for a Chartered Accountant (CA) firm.
Current Date (IST): ${getISTDateDetails().dateStr}
Current User: ${decoded.username} (${decoded.role})
Privileges: ${isAdmin ? 'Full Partner Admin' : 'Staff / Article'}

POLICY RULES:
1. Clock-in / clock-out cannot be done in chat; use Attendance kiosk.
2. Managing clients and deleting tasks requires Partner admin.
3. Be concise, direct, and professional. Use markdown formatting.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    ...(history || []).slice(-6).map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: String(m.content || '')
    }))
  ];

  if (messages.length === 1 || messages[messages.length - 1].role !== 'user') {
    messages.push({ role: 'user', content: query });
  }

  const firstData = await callGroqChatCompletions(messages, GROQ_TOOLS, apiKey, model);
  const choice = firstData?.choices?.[0];
  if (!choice || !choice.message) {
    throw new Error('Invalid response structure from Groq API');
  }

  const assistantMsg = choice.message;
  const toolCalls = assistantMsg.tool_calls;

  let lastTask = null;
  let lastClient = null;
  const chips = [];

  if (toolCalls && toolCalls.length > 0) {
    messages.push(assistantMsg);

    for (const call of toolCalls) {
      let args = {};
      try {
        args = typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : (call.function.arguments || {});
      } catch (_) {
        args = {};
      }

      const toolResult = await executeLlmToolCall(call.function.name, args, { db, decoded, isAdmin, allClients, allUsers });

      if (toolResult.task) {
        lastTask = toolResult.task;
        chips.push({ label: `⚙️ Manage #${toolResult.task.id}`, action: 'advance_status', params: { taskId: toolResult.task.id } });
      }
      if (toolResult.client) {
        lastClient = toolResult.client;
        chips.push({ label: `🏢 View Client #${toolResult.client.id}`, action: 'view_clients', params: {} });
      }

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(toolResult)
      });
    }

    const secondData = await callGroqChatCompletions(messages, null, apiKey, model);
    const finalContent = secondData?.choices?.[0]?.message?.content || 'Action processed successfully.';

    if (chips.length === 0) {
      chips.push({ label: '📋 View All Tasks', action: 'view_tasks', params: {} });
      chips.push({ label: '🏢 View All Clients', action: 'view_clients', params: {} });
    }

    return res.status(200).json({
      success: true,
      reply: finalContent,
      chips: chips.slice(0, 6),
      task: lastTask,
      client: lastClient,
      context: null
    });
  }

  const replyContent = assistantMsg.content || 'I am ready to help you with tasks, clients, and attendance.';
  return res.status(200).json({
    success: true,
    reply: replyContent,
    chips: [
      { label: '📋 View All Tasks', action: 'view_tasks', params: {} },
      { label: '🏢 View All Clients', action: 'view_clients', params: {} },
      { label: '🕒 Check Attendance', action: 'view_attendance', params: {} }
    ],
    context: null
  });
}

module.exports = { GROQ_TOOLS, handleGroqLlmChatTurn };
