const { logAuditAction } = require('../../api/_routes/auth');
const { computeRecommendations } = require('../../api/_routes/recommend');
const { getTaskBadge, getNextTaskId, findTasksByAnyIdentifier, isGstWorkCheck, getISTDateDetails } = require('./chatHelpers');

async function handleStaffAction({
  db,
  decoded,
  action,
  body = {},
  tasksCol,
  clientsCol,
  usersCol,
  attendanceCol,
  engagementsCol,
  allClients = [],
  allUsers = [],
  allEngagements = [],
  isAdmin
}) {
  const {
    taskId,
    id,
    clientCode,
    clientName,
    natureOfWork,
    assessmentYear,
    dueDate,
    operator,
    targetStatus,
    reason,
    pan,
    contact,
    email,
    category,
    status: clientStatusVal,
    limit,
    username: targetUsername,
    password,
    name: targetFullName,
    role: targetRole,
    title: engTitle,
    date: attDate
  } = body;

  // 1. Create Task
  if (action === 'create_task') {
    if (!isAdmin) return { success: false, status: 403, message: 'Forbidden: Admins only can create tasks.' };
    if (!clientCode || !clientName || !natureOfWork || !dueDate) {
      return { success: false, status: 400, message: 'Client Code, Client Name, Nature of Work, and Due Date are required.' };
    }

    const cCodeClean = String(clientCode).trim();
    const cNameClean = String(clientName).trim();
    const natureClean = String(natureOfWork).trim();
    const isGst = isGstWorkCheck(natureClean);
    const ayClean = isGst ? '' : (assessmentYear ? String(assessmentYear).trim() : '');
    const assignedOp = operator ? String(operator).trim().toLowerCase() : '';

    const dupQuery = {
      clientCode: cCodeClean,
      natureOfWork: natureClean,
      currentStatus: { $ne: 'Filed' }
    };
    if (ayClean) dupQuery.assessmentYear = ayClean;
    const existingTask = await tasksCol.findOne(dupQuery);
    if (existingTask) {
      return {
        success: false,
        reply: `⚠️ **Duplicate Task Blocked**: An active task for **${cNameClean}** (#${cCodeClean}) for **${natureClean}** is already open (Status: *${existingTask.currentStatus}*, Assigned: @${existingTask.workTakenBy || 'Unassigned'}, Task ID: #${existingTask.id}).`,
        task: existingTask,
        context: null
      };
    }

    const nowStr = new Date().toISOString().split('T')[0];
    const nextTaskId = await getNextTaskId(tasksCol);
    const newTask = {
      id: nextTaskId,
      clientCode: cCodeClean,
      clientName: cNameClean,
      natureOfWork: natureClean,
      assessmentYear: ayClean,
      dateReceived: nowStr,
      dueDate: dueDate,
      currentStatus: assignedOp ? 'Assigned' : 'Unassigned',
      workTakenBy: assignedOp,
      workTakenOn: assignedOp ? nowStr : '',
      sendBackCount: 0,
      reasonForPending: '',
      attachedFiles: []
    };

    await tasksCol.insertOne(newTask);
    await logAuditAction(db, decoded.username, 'CREATE_TASK_CHAT', {
      taskId: newTask.id,
      clientName: newTask.clientName,
      natureOfWork: newTask.natureOfWork,
      operator: newTask.workTakenBy
    });

    let replyMsg = `✅ **Task #${newTask.id} Created Successfully!**\n- **Client**: [${cCodeClean}] ${cNameClean}\n- **Work**: ${natureClean}${ayClean ? ` (AY: ${ayClean})` : ''}\n- **Due Date**: \`${dueDate}\`\n- **Status**: **${newTask.currentStatus}** ${assignedOp ? `(Assigned to @${assignedOp})` : ''}\n\n`;
    let chips = [];
    if (!assignedOp) {
      replyMsg += `Would you like me to recommend the best staff for this task?`;
      chips = [
        { label: '⭐ Recommend Top 3 Staff', action: 'recommend_staff', params: { clientCode: cCodeClean, natureOfWork: natureClean, limit: 3, taskId: newTask.id } },
        { label: '⭐ Recommend Top 5 Staff', action: 'recommend_staff', params: { clientCode: cCodeClean, natureOfWork: natureClean, limit: 5, taskId: newTask.id } }
      ];
    } else {
      chips = [
        { label: '⏩ Advance to Pending Review', action: 'advance_status', params: { taskId: newTask.id, targetStatus: 'Pending Review' } },
        { label: '📋 View All Tasks', action: 'view_tasks', params: {} }
      ];
    }

    return { success: true, reply: replyMsg, task: newTask, context: null, chips };
  }

  // 2. View Tasks
  if (action === 'view_tasks' || action === 'list_tasks') {
    let filter = {};
    if (body.status) filter.currentStatus = body.status;
    if (body.operator) filter.workTakenBy = String(body.operator).trim().toLowerCase();
    if (body.clientCode) filter.clientCode = String(body.clientCode);
    if (!isAdmin) filter.workTakenBy = decoded.username;

    const tasksList = await tasksCol.find(filter).sort({ dueDate: 1 }).limit(parseInt(limit || '10', 10) || 10).toArray();
    if (tasksList.length === 0) {
      return {
        success: true,
        reply: `📋 No tasks found matching your criteria.`,
        context: null,
        chips: [{ label: '➕ Create New Task', action: 'prompt_text', text: 'Create task for client ' }]
      };
    }

    let replyMsg = `### 📋 Workflow Tasks (${tasksList.length} items):\n\n`;
    const chips = [];
    tasksList.forEach(t => {
      const badge = getTaskBadge(t);
      const cCodeBadge = t.clientCode ? `[#${t.clientCode}] ` : '';
      replyMsg += `- **Task ${badge}**: ${t.natureOfWork} | Client: ${cCodeBadge}**${t.clientName}** [**${t.currentStatus}**] | Assigned: @${t.workTakenBy || 'Unassigned'} | Due: \`${t.dueDate}\`\n`;
      if (chips.length < 5 && t.currentStatus !== 'Filed') {
        chips.push({ label: `⚙️ Manage Task ${badge}`, action: 'advance_status', params: { taskId: t.id } });
      }
    });

    return { success: true, reply: replyMsg, tasks: tasksList, context: null, chips };
  }

  // 3. Update Task
  if (action === 'update_task') {
    const candidateTasks = await findTasksByAnyIdentifier(tasksCol, taskId || id, allClients);
    const task = candidateTasks[0];
    if (!task) return { success: false, status: 404, message: 'Task not found.' };

    if (!isAdmin && task.workTakenBy !== decoded.username) {
      return { success: false, status: 403, message: 'Forbidden: You can only edit your own assigned tasks.' };
    }

    const updates = {};
    if (dueDate) updates.dueDate = dueDate;
    if (operator !== undefined) {
      updates.workTakenBy = operator.trim().toLowerCase();
      if (updates.workTakenBy && task.currentStatus === 'Unassigned') {
        updates.currentStatus = 'Assigned';
        updates.workTakenOn = new Date().toISOString().split('T')[0];
      }
    }
    if (natureOfWork) updates.natureOfWork = natureOfWork.trim();
    if (assessmentYear !== undefined) updates.assessmentYear = String(assessmentYear).trim();
    if (reason !== undefined) updates.reasonForPending = String(reason).trim();
    if (targetStatus) updates.currentStatus = targetStatus;

    await tasksCol.updateOne({ _id: task._id }, { $set: updates });
    const updated = await tasksCol.findOne({ _id: task._id });
    const badge = getTaskBadge(updated);
    await logAuditAction(db, decoded.username, 'UPDATE_TASK_CHAT', { taskId: updated.id, updates });

    return {
      success: true,
      reply: `✏️ **Task ${badge} Updated Successfully!**\n- Client: **${updated.clientName}**\n- Nature: **${updated.natureOfWork}**\n- Status: **${updated.currentStatus}**\n- Assigned: @${updated.workTakenBy || 'Unassigned'}\n- Due: \`${updated.dueDate}\``,
      task: updated,
      context: null,
      chips: [{ label: `⏩ Manage ${badge}`, action: 'advance_status', params: { taskId: updated.id } }]
    };
  }

  // 4. Delete Task
  if (action === 'delete_task') {
    if (!isAdmin) return { success: false, status: 403, message: 'Forbidden: Admins only can delete tasks.' };
    const candidateTasks = await findTasksByAnyIdentifier(tasksCol, taskId || id, allClients);
    const taskToDelete = candidateTasks[0];
    if (!taskToDelete) return { success: false, status: 404, message: 'Task not found.' };

    const badge = getTaskBadge(taskToDelete);
    await tasksCol.deleteOne({ _id: taskToDelete._id });
    await logAuditAction(db, decoded.username, 'DELETE_TASK_CHAT', { taskId: taskToDelete.id, clientName: taskToDelete.clientName });

    return {
      success: true,
      reply: `🗑️ **Task ${badge} (${taskToDelete.natureOfWork} for ${taskToDelete.clientName}) deleted successfully.**`,
      context: null,
      chips: [{ label: '📋 View All Tasks', action: 'view_tasks', params: {} }]
    };
  }

  // 5. Assign Task
  if (action === 'assign_task') {
    if (!isAdmin) return { success: false, status: 403, message: 'Forbidden: Admins only can assign tasks.' };
    const opUsername = String(operator || '').trim().toLowerCase();
    if (!opUsername) return { success: false, status: 400, message: 'Operator username is required.' };

    const opUser = await usersCol.findOne({ username: opUsername });
    if (!opUser) return { success: false, status: 404, message: `Staff user @${opUsername} not found.` };

    const candidateTasks = await findTasksByAnyIdentifier(tasksCol, taskId || id, allClients);
    const task = candidateTasks[0];
    if (!task) return { success: false, status: 404, message: 'Task not found.' };

    const nowStr = new Date().toISOString().split('T')[0];
    await tasksCol.updateOne(
      { _id: task._id },
      { $set: { workTakenBy: opUsername, workTakenOn: nowStr, currentStatus: 'Assigned' } }
    );

    const badge = getTaskBadge(task);
    await logAuditAction(db, decoded.username, 'ASSIGN_TASK_CHAT', { taskId: task.id, operator: opUsername });

    return {
      success: true,
      reply: `🎯 **Task ${badge} Assigned to ${opUser.name} (@${opUsername})!**\n- Work: **${task.natureOfWork}**\n- Client: **${task.clientName}**\n- Due Date: \`${task.dueDate}\``,
      context: null,
      chips: [
        { label: `⏩ Manage ${badge}`, action: 'advance_status', params: { taskId: task.id } },
        { label: '📋 View All Tasks', action: 'view_tasks', params: {} }
      ]
    };
  }

  // 6. Advance Status
  if (action === 'advance_status') {
    const candidateTasks = await findTasksByAnyIdentifier(tasksCol, taskId || id, allClients);
    const task = candidateTasks[0];
    if (!task) return { success: false, status: 404, message: 'Task not found.' };

    const badge = getTaskBadge(task);
    let nextSt = targetStatus;
    if (!nextSt) {
      if (task.currentStatus === 'Unassigned') nextSt = 'Assigned';
      else if (task.currentStatus === 'Assigned') nextSt = 'Pending Review';
      else if (task.currentStatus === 'Pending Review') nextSt = 'Approved';
      else if (task.currentStatus === 'Approved') nextSt = 'Filed';
      else if (task.currentStatus === 'Rework') nextSt = 'Pending Review';
      else nextSt = 'Filed';
    }

    const updates = { currentStatus: nextSt };
    if (nextSt === 'Filed') updates.filedDate = new Date().toISOString().split('T')[0];
    if (nextSt === 'Rework') updates.sendBackCount = (task.sendBackCount || 0) + 1;
    if (reason) updates.reasonForPending = String(reason).trim();

    await tasksCol.updateOne({ _id: task._id }, { $set: updates });
    await logAuditAction(db, decoded.username, 'ADVANCE_STATUS_CHAT', { taskId: task.id, from: task.currentStatus, to: nextSt });

    return {
      success: true,
      reply: `🚀 **Task ${badge} advanced to '${nextSt}' successfully!**\n- Client: **${task.clientName}**\n- Work: **${task.natureOfWork}**\n- Assigned: @${task.workTakenBy || 'Unassigned'}`,
      context: null,
      chips: [{ label: '📋 View All Tasks', action: 'view_tasks', params: {} }]
    };
  }

  // 7. Recommend Staff
  if (action === 'recommend_staff') {
    const nature = String(natureOfWork || '').trim();
    const limitNum = parseInt(limit || '3', 10);
    const recs = await computeRecommendations(db, nature, limitNum);
    if (!recs || recs.length === 0) {
      return {
        success: true,
        reply: `⚠️ Could not calculate specific recommendations for **${nature || 'this work'}**. All qualified office pool staff are available.`,
        context: null,
        chips: [{ label: '📋 View All Tasks', action: 'view_tasks', params: {} }]
      };
    }

    let replyMsg = `### 🌟 Smart Staff Recommendations for "${nature}":\n\n`;
    const chips = [];
    recs.forEach((r, idx) => {
      replyMsg += `${idx + 1}. **${r.name}** (@${r.username}) — **${r.score}% Match**\n`;
      if (r.reasons && r.reasons.length > 0) {
        replyMsg += `   • *${r.reasons.join(', ')}*\n`;
      }
      if (taskId) {
        chips.push({ label: `👉 Assign to ${r.name}`, action: 'assign_task', params: { taskId, operator: r.username } });
      }
    });

    return { success: true, reply: replyMsg, recommendations: recs, context: null, chips };
  }

  // 8. Create Client
  if (action === 'create_client') {
    if (!isAdmin) return { success: false, status: 403, message: 'Forbidden: Admins only can add clients.' };
    const nameClean = String(clientName || '').trim();
    if (!nameClean) return { success: false, status: 400, message: 'Client name is required.' };

    const highest = await clientsCol.find({ id: { $type: 'number' } }).sort({ id: -1 }).limit(1).toArray();
    const nextId = highest.length > 0 ? highest[0].id + 1 : 1001;

    const newClient = {
      id: nextId,
      name: nameClean,
      pan: pan ? String(pan).trim().toUpperCase() : '',
      contact: contact ? String(contact).trim() : '',
      email: email ? String(email).trim().toLowerCase() : '',
      category: category || 'General',
      status: clientStatusVal || 'Active',
      createdAt: new Date()
    };

    await clientsCol.insertOne(newClient);
    await logAuditAction(db, decoded.username, 'CREATE_CLIENT_CHAT', { clientId: nextId, name: nameClean });

    return {
      success: true,
      reply: `🏢 **Client #${nextId} (${nameClean}) Registered Successfully!**\n- PAN: \`${newClient.pan || 'N/A'}\`\n- Contact: \`${newClient.contact || 'N/A'}\`\n- Status: **${newClient.status}**`,
      client: newClient,
      context: null,
      chips: [
        { label: `➕ Create Task for #${nextId}`, action: 'prompt_text', text: `create task for client #${nextId} ` },
        { label: '🏢 View All Clients', action: 'view_clients', params: {} }
      ]
    };
  }

  // 9. Update Client
  if (action === 'update_client') {
    if (!isAdmin) return { success: false, status: 403, message: 'Forbidden: Admins only can update clients.' };
    const cIdNum = parseInt(clientCode || id, 10);
    const client = await clientsCol.findOne({ id: cIdNum });
    if (!client) return { success: false, status: 404, message: 'Client not found.' };

    const updates = {};
    if (clientName) updates.name = String(clientName).trim();
    if (pan) updates.pan = String(pan).trim().toUpperCase();
    if (contact) updates.contact = String(contact).trim();
    if (email) updates.email = String(email).trim().toLowerCase();
    if (category) updates.category = category;
    if (clientStatusVal) updates.status = clientStatusVal;

    await clientsCol.updateOne({ _id: client._id }, { $set: updates });
    await logAuditAction(db, decoded.username, 'UPDATE_CLIENT_CHAT', { clientId: cIdNum, updates });

    return {
      success: true,
      reply: `🏢 **Client #${cIdNum} Updated Successfully!**`,
      context: null,
      chips: [{ label: '🏢 View All Clients', action: 'view_clients', params: {} }]
    };
  }

  // 10. Delete Client
  if (action === 'delete_client') {
    if (!isAdmin) return { success: false, status: 403, message: 'Forbidden: Admins only can delete clients.' };
    const cIdNum = parseInt(clientCode || id, 10);
    const client = await clientsCol.findOne({ id: cIdNum });
    if (!client) return { success: false, status: 404, message: 'Client not found.' };

    await clientsCol.deleteOne({ _id: client._id });
    await logAuditAction(db, decoded.username, 'DELETE_CLIENT_CHAT', { clientId: cIdNum, name: client.name });

    return {
      success: true,
      reply: `🗑️ **Client #${cIdNum} (${client.name}) deleted successfully.**`,
      context: null,
      chips: [{ label: '🏢 View All Clients', action: 'view_clients', params: {} }]
    };
  }

  // 11. Attendance Check-In / Mark OD
  if (action === 'mark_od') {
    if (!isAdmin) return { success: false, status: 403, message: 'Forbidden: Admins only can mark On-Duty status.' };
    const targetUser = String(operator || targetUsername || '').trim().toLowerCase();
    if (!targetUser) return { success: false, status: 400, message: 'Staff username is required.' };

    const { dateStr } = getISTDateDetails();
    const recDate = attDate || dateStr;

    await attendanceCol.updateOne(
      { username: targetUser, date: recDate },
      { $set: { status: 'On Duty', checkIn: '09:30', checkOut: '18:30', notes: 'Approved via Chatbot by Partner' } },
      { upsert: true }
    );
    await logAuditAction(db, decoded.username, 'MARK_OD_CHAT', { username: targetUser, date: recDate });

    return {
      success: true,
      reply: `✅ **@${targetUser} marked as 'On Duty' for ${recDate}.**`,
      context: null,
      chips: [{ label: '🕒 View Attendance', action: 'view_attendance', params: {} }]
    };
  }

  // 12. View Attendance
  if (action === 'view_attendance') {
    const { dateStr } = getISTDateDetails();
    const queryDate = attDate || dateStr;
    const records = await attendanceCol.find({ date: queryDate }).toArray();

    let present = 0, absent = 0, onDuty = 0;
    records.forEach(r => {
      if (r.status === 'Present') present++;
      else if (r.status === 'On Duty') onDuty++;
      else absent++;
    });

    let replyMsg = `### 🕒 Attendance for ${queryDate}:\n- **Present**: ${present}\n- **On Duty**: ${onDuty}\n- **Absent**: ${absent}\n\n`;
    records.slice(0, 15).forEach(r => {
      const icon = r.status === 'Present' ? '🟢' : (r.status === 'On Duty' ? '🔵' : '🔴');
      replyMsg += `${icon} **@${r.username}**: ${r.status} ${r.checkIn ? `(${r.checkIn} - ${r.checkOut || 'Active'})` : ''}\n`;
    });

    return { success: true, reply: replyMsg, attendance: records, context: null };
  }

  // 13. Create User
  if (action === 'create_user') {
    if (!isAdmin) return { success: false, status: 403, message: 'Forbidden: Admins only can add staff users.' };
    const uName = String(targetUsername || '').trim().toLowerCase();
    const uPass = String(password || '1234').trim();
    const uFull = String(targetFullName || uName).trim();
    const uRole = String(targetRole || 'staff').trim().toLowerCase();

    if (!uName) return { success: false, status: 400, message: 'Username is required.' };

    const existing = await usersCol.findOne({ username: uName });
    if (existing) return { success: false, status: 400, message: `Username @${uName} already exists.` };

    const newUser = {
      username: uName,
      password: uPass,
      name: uFull,
      role: uRole,
      createdAt: new Date()
    };
    await usersCol.insertOne(newUser);
    await logAuditAction(db, decoded.username, 'CREATE_USER_CHAT', { username: uName, role: uRole });

    return {
      success: true,
      reply: `👤 **User @${uName} (${uFull}, ${uRole.toUpperCase()}) created successfully!**`,
      context: null
    };
  }

  // 14. Create Engagement
  if (action === 'create_engagement') {
    if (!isAdmin) return { success: false, status: 403, message: 'Forbidden: Admins only can add services.' };
    const cleanTitle = String(engTitle || '').trim();
    if (!cleanTitle) return { success: false, status: 400, message: 'Service title is required.' };

    const existing = await engagementsCol.findOne({ title: cleanTitle });
    if (existing) return { success: false, status: 400, message: `Service '${cleanTitle}' already exists.` };

    await engagementsCol.insertOne({ title: cleanTitle, createdAt: new Date() });
    await logAuditAction(db, decoded.username, 'CREATE_ENGAGEMENT_CHAT', { title: cleanTitle });

    return {
      success: true,
      reply: `💼 **Service '${cleanTitle}' added to catalog successfully!**`,
      context: null
    };
  }

  return null;
}

module.exports = { handleStaffAction };
