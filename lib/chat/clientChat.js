const { logAuditAction } = require('../../api/_routes/auth');
const { isGstWorkCheck, getNextTaskId } = require('./chatHelpers');

// Pure string number extractor without regex
function extractNumberFromText(str) {
  if (!str) return null;
  const tokens = String(str).replace(/#/g, ' ').split(' ');
  for (const tok of tokens) {
    const num = parseInt(tok, 10);
    if (!isNaN(num) && num > 0) return num;
  }
  return null;
}

async function handleClientChat({
  db,
  decoded,
  query,
  action,
  body,
  allEngagements = [],
  allUsers = [],
  tasksCol,
  clientsCol
}) {
  const cId = decoded.clientId;
  const cIdStr = String(cId);
  const clientName = decoded.name || `Client ${cId}`;
  const lowerQ = (query || '').toLowerCase().trim();
  const act = action || '';
  const params = (body && body.params) || body || {};

  // 1. Explicit Action: Client Create Task
  if (act === 'client_create_task' || act === 'create_task') {
    const rawNature = params.natureOfWork || params.type || '';
    if (!rawNature) {
      return {
        success: false,
        reply: 'Please choose which service you would like to request:',
        chips: allEngagements.slice(0, 6).map(eng => ({
          label: eng,
          action: 'client_create_task',
          params: { natureOfWork: eng }
        }))
      };
    }

    const natureClean = String(rawNature).trim();
    const isGst = isGstWorkCheck(natureClean);
    const ay = isGst ? '' : (params.assessmentYear ? String(params.assessmentYear).trim() : '');
    const now = new Date();
    const defaultDueDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const dueDate = params.dueDate || defaultDueDate;
    const operator = params.operator ? String(params.operator).trim().toLowerCase() : '';

    const dupQuery = {
      clientCode: { $in: [cIdStr, Number(cId)] },
      natureOfWork: natureClean,
      currentStatus: { $ne: 'Filed' }
    };
    if (ay) dupQuery.assessmentYear = ay;
    const existing = await tasksCol.findOne(dupQuery);
    if (existing) {
      return {
        success: false,
        reply: `⚠️ **Active Task Already Open**: Task **#${existing.id}** for **${natureClean}** is currently **${existing.currentStatus}** (Due: \`${existing.dueDate}\`).`,
        chips: [
          { label: '📋 View My Tasks', action: 'prompt_text', text: 'my tasks' },
          { label: `❌ Cancel Task #${existing.id}`, action: 'client_delete_task', params: { taskId: existing.id } }
        ]
      };
    }

    const nextTaskId = await getNextTaskId(tasksCol);
    const newTask = {
      id: nextTaskId,
      clientCode: cIdStr,
      clientName: clientName,
      natureOfWork: natureClean,
      assessmentYear: ay,
      dateReceived: now.toISOString().split('T')[0],
      dueDate: dueDate,
      currentStatus: operator ? 'Assigned' : 'Unassigned',
      workTakenBy: operator,
      workTakenOn: operator ? now.toISOString().split('T')[0] : '',
      sendBackCount: 0,
      reasonForPending: '',
      createdRole: 'client',
      attachedFiles: []
    };

    await tasksCol.insertOne(newTask);
    await logAuditAction(db, decoded.username, 'CREATE_TASK_CHAT_CLIENT', {
      taskId: newTask.id,
      clientCode: cIdStr,
      natureOfWork: natureClean
    });

    return {
      success: true,
      reply: `✅ **Task #${newTask.id} Registered Successfully!**\n- **Client**: ${clientName} (#${cIdStr})\n- **Service**: ${natureClean}${ay ? ` (AY: ${ay})` : ''}\n- **Due Date**: \`${dueDate}\`\n- **Status**: **${newTask.currentStatus}** ${operator ? `(Allocated to @${operator})` : '(Office Pool)'}\n\n📎 **Would you like to attach files for this task?** (e.g. Form 16, Bank statement, Invoices)`,
      chips: [
        { label: '📎 Attach File for this Task', action: 'trigger_chat_upload', params: { taskId: newTask.id, clientCode: cIdStr, natureOfWork: natureClean, assessmentYear: ay } },
        { label: '📋 View My Tasks', action: 'prompt_text', text: 'my tasks' },
        { label: '➕ Request Another Task', action: 'prompt_text', text: 'add new task' }
      ]
    };
  }

  // 2. Explicit Action: Client Delete Task (Own non-filed task)
  if (act === 'client_delete_task' || act === 'delete_task') {
    const rawId = params.taskId || params.id || extractNumberFromText(lowerQ);
    const targetTaskId = parseInt(rawId, 10);
    if (!targetTaskId) {
      return { success: false, reply: 'Please provide a valid Task ID to delete.' };
    }

    const task = await tasksCol.findOne({
      $or: [
        { id: targetTaskId, clientCode: { $in: [cIdStr, Number(cId)] } },
        { id: String(targetTaskId), clientCode: { $in: [cIdStr, Number(cId)] } }
      ]
    });

    if (!task) {
      return {
        success: false,
        reply: `⚠️ Task **#${targetTaskId}** was not found in your account. You can only view and manage your own tasks.`
      };
    }

    if (task.currentStatus === 'Filed') {
      return {
        success: false,
        reply: `⚠️ Task **#${task.id}** (${task.natureOfWork}) is **Filed (Closed)** and cannot be deleted.`
      };
    }

    await tasksCol.deleteOne({ _id: task._id });
    await logAuditAction(db, decoded.username, 'DELETE_TASK_CHAT_CLIENT', {
      taskId: task.id,
      clientCode: cIdStr,
      natureOfWork: task.natureOfWork
    });

    return {
      success: true,
      reply: `🗑️ **Task #${task.id} (${task.natureOfWork}) has been cancelled and deleted.**`,
      chips: [
        { label: '📋 View My Tasks', action: 'prompt_text', text: 'my tasks' },
        { label: '➕ Request New Task', action: 'prompt_text', text: 'add new task' }
      ]
    };
  }

  // 3. Natural language deletion (e.g. "delete task 10001", "cancel task #10002") without regex
  const isDeleteWord = ['delete', 'cancel', 'remove'].some(w => lowerQ.includes(w));
  if (isDeleteWord) {
    const targetTaskId = extractNumberFromText(lowerQ);
    if (targetTaskId) {
      const task = await tasksCol.findOne({
        $or: [
          { id: targetTaskId, clientCode: { $in: [cIdStr, Number(cId)] } },
          { id: String(targetTaskId), clientCode: { $in: [cIdStr, Number(cId)] } }
        ]
      });

      if (!task) {
        return {
          success: false,
          reply: `⚠️ Task **#${targetTaskId}** was not found in your account.`
        };
      }

      if (task.currentStatus === 'Filed') {
        return {
          success: false,
          reply: `⚠️ Task **#${task.id}** (${task.natureOfWork}) is already **Filed / Completed** and cannot be deleted.`
        };
      }

      return {
        success: true,
        reply: `Are you sure you want to delete **Task #${task.id}** (${task.natureOfWork}) with current status **${task.currentStatus}**?`,
        chips: [
          { label: `🗑️ Confirm Delete #${task.id}`, action: 'client_delete_task', params: { taskId: task.id } },
          { label: '✖ Keep Task', action: 'prompt_text', text: 'my tasks' }
        ]
      };
    }
  }

  // 4. View Tasks query (e.g. "my tasks", "active tasks", "status", "pending tasks", "closed tasks") without regex
  const taskKeywords = ['my task', 'my tasks', 'active task', 'active tasks', 'pending task', 'pending tasks', 'closed task', 'closed tasks', 'task status', 'show task', 'show tasks', 'view task', 'view tasks', 'tasks', 'task'];
  const isTaskQuery = taskKeywords.some(k => lowerQ.includes(k));
  if (isTaskQuery) {
    let statusFilter = null;
    if (lowerQ.includes('closed') || lowerQ.includes('filed')) {
      statusFilter = ['Filed'];
    } else if (lowerQ.includes('pending')) {
      statusFilter = ['Pending Review'];
    } else if (lowerQ.includes('active') || lowerQ.includes('open')) {
      statusFilter = ['Unassigned', 'Assigned', 'Approved'];
    }

    const taskQuery = { clientCode: { $in: [cIdStr, Number(cId)] } };
    if (statusFilter) taskQuery.currentStatus = { $in: statusFilter };

    const clientTasks = await tasksCol.find(taskQuery).sort({ id: -1 }).limit(20).toArray();

    if (clientTasks.length === 0) {
      return {
        success: true,
        reply: `You have no ${statusFilter ? statusFilter.join('/') : ''} tasks registered right now.`,
        chips: [
          { label: '➕ Request New Task', action: 'prompt_text', text: 'create task' },
          { label: '📄 My Documents', action: 'prompt_text', text: 'show my documents' }
        ]
      };
    }

    let reply = `### 📋 Tasks for ${clientName} (#${cIdStr})\n\n`;
    const chips = [];

    clientTasks.forEach(t => {
      const isFiled = t.currentStatus === 'Filed';
      const statusIcon = isFiled ? '✅' : (t.currentStatus === 'Pending Review' ? '⏳' : '⚡');
      reply += `${statusIcon} **Task #${t.id}** — **${t.natureOfWork}** ${t.assessmentYear ? `(AY: ${t.assessmentYear})` : ''}\n`;
      reply += `   • Status: \`${t.currentStatus}\` | Due: \`${t.dueDate}\` ${t.workTakenBy ? `| Operator: @${t.workTakenBy}` : ''}\n\n`;

      if (!isFiled && chips.length < 4) {
        chips.push({ label: `❌ Cancel #${t.id}`, action: 'client_delete_task', params: { taskId: t.id } });
      }
    });

    chips.push({ label: '➕ Add New Task', action: 'prompt_text', text: 'add new task' });
    chips.push({ label: '📄 My Documents', action: 'prompt_text', text: 'show my documents' });

    return {
      success: true,
      reply,
      chips
    };
  }

  // 5. Natural language task creation intent without regex
  const createKeywords = ['create', 'add', 'new', 'request', 'file', 'inward'];
  const isCreateIntent = createKeywords.some(w => lowerQ.split(' ').includes(w) || lowerQ.includes(w + ' task'));
  if (isCreateIntent) {
    let matchedEng = allEngagements.find(e => lowerQ.includes(e.toLowerCase()));
    if (!matchedEng) {
      if (lowerQ.includes('itr') || lowerQ.includes('income tax')) matchedEng = 'Income Tax Return (ITR)';
      else if (lowerQ.includes('gstr 3b') || lowerQ.includes('gstr3b')) matchedEng = 'GSTR 3B';
      else if (lowerQ.includes('gstr 1') || lowerQ.includes('gstr1')) matchedEng = 'GSTR 1';
      else if (lowerQ.includes('gst')) matchedEng = 'GST Monthly Return';
      else if (lowerQ.includes('3cd') || lowerQ.includes('tax audit')) matchedEng = 'Tax Audit (3CD)';
      else if (lowerQ.includes('statutory audit')) matchedEng = 'Statutory Audit';
      else if (lowerQ.includes('tds')) matchedEng = 'TDS Quarterly Filing';
    }

    if (matchedEng) {
      const now = new Date();
      const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      return {
        success: true,
        reply: `Would you like to request **${matchedEng}** for client account **${clientName}**?`,
        chips: [
          { label: `✅ Confirm Request (${matchedEng})`, action: 'client_create_task', params: { natureOfWork: matchedEng, dueDate: nextWeek } },
          { label: '✖ Cancel', action: 'prompt_text', text: 'my tasks' }
        ]
      };
    }

    return {
      success: true,
      reply: `Please choose which service you would like to request:`,
      chips: (allEngagements.length > 0 ? allEngagements.slice(0, 5) : ['Income Tax Return (ITR)', 'GSTR 3B', 'GSTR 1', 'Statutory Audit']).map(eng => ({
        label: `📝 ${eng}`,
        action: 'client_create_task',
        params: { natureOfWork: eng }
      }))
    };
  }

  // 5b. Natural language upload / attach files intent without regex
  const uploadKeywords = ['upload', 'attach', 'attachment', 'attachments', 'send file', 'send files', 'add file', 'add files', 'submit file', 'upload doc'];
  const isUploadIntent = uploadKeywords.some(k => lowerQ.includes(k));
  if (isUploadIntent) {
    const tid = extractNumberFromText(lowerQ);
    if (tid) {
      const targetTask = await tasksCol.findOne({
        id: tid,
        clientCode: { $in: [cIdStr, Number(cId)] }
      });
      if (targetTask) {
        return {
          success: true,
          reply: `📎 Ready to attach a file to **Task #${targetTask.id}** (**${targetTask.natureOfWork}**).\n\nTap below or click the 📎 icon to select your file:`,
          chips: [
            { label: `📎 Select File for #${targetTask.id}`, action: 'trigger_chat_upload', params: { taskId: targetTask.id, clientCode: cIdStr, natureOfWork: targetTask.natureOfWork, assessmentYear: targetTask.assessmentYear } },
            { label: '📋 View My Tasks', action: 'prompt_text', text: 'my tasks' }
          ]
        };
      }
    }
    return {
      success: true,
      reply: `📎 You can upload documents (Form 16, Bank Statements, Bills, etc.) straight to your secure Google Drive vault.\n\nTap below or click the 📎 icon:`,
      chips: [
        { label: '📎 Choose File to Upload', action: 'trigger_chat_upload', params: { clientCode: cIdStr } },
        { label: '📋 My Tasks', action: 'prompt_text', text: 'my tasks' }
      ]
    };
  }

  // 6. Default Client Portal Overview & Help
  return {
    success: true,
    reply: `👋 Welcome to your Client Portal, **${clientName}** (#${cIdStr})!\n\nYou can:\n- Check your active and filed tasks: *"my tasks"*\n- Request new services: *"create task for GSTR 3B"* or *"add task"*\n- Cancel active/pending tasks: *"delete task #10001"*\n- Find tax files: *"send my 2024 ITR"* or *"show my documents"*\n- Upload files using the 📎 button.`,
    chips: [
      { label: '📋 My Tasks', action: 'prompt_text', text: 'my tasks' },
      { label: '➕ Request New Task', action: 'prompt_text', text: 'create task' },
      { label: '📄 My Documents', action: 'prompt_text', text: 'show my documents' },
      { label: '📎 Upload Document', action: 'prompt_text', text: 'upload document' }
    ]
  };
}

module.exports = { handleClientChat };
