const { getTaskBadge, getISTDateDetails } = require('./chatHelpers');

async function handlePatternChat({
  db,
  decoded,
  isAdmin,
  allClients = [],
  allUsers = [],
  allEngagements = [],
  query = '',
  context = null
}) {
  const queryLower = String(query || '').toLowerCase().trim();

  // 1. Clock-In / Clock-Out Block without regex
  const clockKeywords = ['clock in', 'punch in', 'clock out', 'punch out'];
  if (clockKeywords.some(k => queryLower.includes(k))) {
    const isClockIn = queryLower.includes('clock in') || queryLower.includes('punch in');
    return {
      success: false,
      reply: `⚠️ **Attendance ${isClockIn ? 'Clock-In' : 'Clock-Out'} cannot be performed via Chat.**\n\nPlease use the **Attendance** tab or biometric camera kiosk to ${isClockIn ? 'punch in' : 'punch out'}.`,
      context: null,
      chips: [
        { label: '🕒 Open Attendance Tab', action: 'view_attendance', params: {} },
        { label: '👥 Who is Present Today?', action: 'prompt_text', text: 'Who is present today?' }
      ]
    };
  }

  // 2. Conversational Reset Check without regex
  const cancelKeywords = ['cancel', 'reset', 'stop', 'start over', 'nevermind'];
  if (cancelKeywords.some(k => queryLower.startsWith(k) || queryLower === k)) {
    return {
      success: true,
      reply: 'Operation cancelled. How else can I assist you?',
      context: null,
      chips: [
        { label: '📋 View All Tasks', action: 'view_tasks', params: {} },
        { label: '🏢 View All Clients', action: 'view_clients', params: {} },
        { label: '📊 View Stats', action: 'view_stats', params: {} }
      ]
    };
  }

  // 3. Conversational Greetings without regex
  const greetingKeywords = ['hi', 'hello', 'hey', 'help', 'good morning', 'good afternoon', 'good evening', 'what can you do'];
  if (greetingKeywords.some(k => queryLower.startsWith(k) || queryLower === k)) {
    const greetingReply = `👋 **Hello! I am your AI Office Workflow Assistant.**\n\nI can help you manage office operations:\n- 📋 **Tasks**: Create, edit due dates, assign operators, approve, rework, or delete.\n- 🏢 **Clients**: Add new clients, look up by ID/PAN, edit details, view files.\n- 🕒 **Attendance**: Check today's attendance, who is present/absent, mark On Duty.\n- 👥 **Team Workload**: View staff queues, recommend top candidates for any task.\n- 📊 **Analytics**: View filing stats and workflow queue counts.\n\nWhat would you like to do?`;
    return {
      success: true,
      reply: greetingReply,
      context: null,
      chips: [
        { label: '📋 View All Tasks', action: 'view_tasks', params: {} },
        { label: '🏢 View All Clients', action: 'view_clients', params: {} },
        { label: '🕒 Check Attendance', action: 'view_attendance', params: {} },
        { label: '📊 View Stats', action: 'view_stats', params: {} }
      ]
    };
  }

  const tasksCol = db.collection('tasks');
  const clientsCol = db.collection('clients');
  const attendanceCol = db.collection('attendance');

  // 4. Attendance query without regex
  const attKeywords = ['attendance', 'present', 'absent', 'who is here', 'punch list'];
  if (attKeywords.some(k => queryLower.includes(k))) {
    const { dateStr } = getISTDateDetails();
    const records = await attendanceCol.find({ date: dateStr }).toArray();
    let present = 0, absent = 0, onDuty = 0;
    records.forEach(r => {
      if (r.status === 'Present') present++;
      else if (r.status === 'On Duty') onDuty++;
      else absent++;
    });

    let reply = `### 🕒 Attendance for Today (${dateStr}):\n- **Present**: ${present} | **On Duty**: ${onDuty} | **Absent**: ${absent}\n\n`;
    records.slice(0, 10).forEach(r => {
      const icon = r.status === 'Present' ? '🟢' : (r.status === 'On Duty' ? '🔵' : '🔴');
      reply += `${icon} **@${r.username}**: ${r.status} ${r.checkIn ? `(${r.checkIn} - ${r.checkOut || 'Active'})` : ''}\n`;
    });

    return {
      success: true,
      reply,
      context: null,
      chips: [
        { label: '🕒 Full Attendance Tab', action: 'view_attendance', params: {} },
        { label: '📋 View All Tasks', action: 'view_tasks', params: {} }
      ]
    };
  }

  // 5. Stats query without regex
  const statKeywords = ['stat', 'stats', 'statistics', 'summary', 'leaderboard', 'metrics', 'overview'];
  if (statKeywords.some(k => queryLower.includes(k))) {
    const totalTasks = await tasksCol.countDocuments({});
    const totalClients = await clientsCol.countDocuments({});
    const filedCount = await tasksCol.countDocuments({ currentStatus: 'Filed' });
    const pendingCount = await tasksCol.countDocuments({ currentStatus: { $ne: 'Filed' } });

    let reply = `### 📊 CA Office Workflow Overview:\n- **Total Tasks**: ${totalTasks}\n- **Completed (Filed)**: ${filedCount}\n- **Active / Pending**: ${pendingCount}\n- **Total Clients**: ${totalClients}\n`;

    return {
      success: true,
      reply,
      context: null,
      chips: [
        { label: '📋 View All Tasks', action: 'view_tasks', params: {} },
        { label: '🏢 View All Clients', action: 'view_clients', params: {} }
      ]
    };
  }

  // 6. Tasks listing / query without regex
  const taskKeywords = ['task', 'tasks', 'pending', 'unassigned', 'assigned', 'review'];
  if (taskKeywords.some(k => queryLower.includes(k))) {
    const filter = isAdmin ? {} : { workTakenBy: decoded.username };
    const list = await tasksCol.find(filter).sort({ dueDate: 1 }).limit(10).toArray();

    if (list.length === 0) {
      return {
        success: true,
        reply: '📋 No active workflow tasks found right now.',
        context: null,
        chips: [{ label: '➕ Create New Task', action: 'create_task', params: {} }]
      };
    }

    let reply = `### 📋 Workflow Tasks (${list.length} items):\n\n`;
    list.forEach(t => {
      const badge = getTaskBadge(t);
      reply += `- **Task ${badge}**: ${t.natureOfWork} for **${t.clientName}** [**${t.currentStatus}**] | Assigned: @${t.workTakenBy || 'Unassigned'} | Due: \`${t.dueDate}\`\n`;
    });

    return {
      success: true,
      reply,
      context: null,
      chips: [
        { label: '📋 View All Tasks', action: 'view_tasks', params: {} },
        { label: '🏢 View All Clients', action: 'view_clients', params: {} }
      ]
    };
  }

  // 7. Clients query without regex
  const clientKeywords = ['client', 'clients', 'search client', 'find client'];
  if (clientKeywords.some(k => queryLower.includes(k))) {
    const list = await clientsCol.find({}).limit(8).toArray();
    let reply = `### 🏢 Registered Clients (${list.length} shown):\n\n`;
    list.forEach(c => {
      reply += `- **#${c.id} ${c.name}** | PAN: \`${c.pan || 'N/A'}\` | Status: **${c.status || 'Active'}**\n`;
    });

    return {
      success: true,
      reply,
      context: null,
      chips: [
        { label: '🏢 View All Clients', action: 'view_clients', params: {} },
        { label: '📋 View All Tasks', action: 'view_tasks', params: {} }
      ]
    };
  }

  // 8. Default fallback
  return {
    success: true,
    reply: `I can help you coordinate tasks, clients, and attendance. Tap an action below or tell me what you'd like to do:`,
    context: null,
    chips: [
      { label: '📋 View All Tasks', action: 'view_tasks', params: {} },
      { label: '🏢 View All Clients', action: 'view_clients', params: {} },
      { label: '🕒 Check Attendance', action: 'view_attendance', params: {} },
      { label: '📊 View Stats', action: 'view_stats', params: {} }
    ]
  };
}

module.exports = { handlePatternChat };
