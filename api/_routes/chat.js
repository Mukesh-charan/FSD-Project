const { connectToDatabase } = require('./db');
const { verifyToken, checkRole, logAuditAction } = require('./auth');
const { computeRecommendations } = require('./recommend');

function isGstWorkCheck(natureOfWork) {
  if (!natureOfWork) return false;
  const str = String(natureOfWork).toLowerCase().trim();
  return str.includes('gst') || str.includes('cmp');
}

// Indian Standard Time (IST) helper
function getISTDateDetails() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const istTime = new Date(utc + (3600000 * 5.5));
  const year = istTime.getFullYear();
  const month = String(istTime.getMonth() + 1).padStart(2, '0');
  const day = String(istTime.getDate()).padStart(2, '0');
  return {
    dateStr: `${year}-${month}-${day}`,
    timestamp: now
  };
}

// Ensure daily absent records for non-partner staff
async function ensureDailyAbsentRecords(db) {
  const { dateStr } = getISTDateDetails();
  const usersCollection = db.collection('users');
  const attendanceCollection = db.collection('attendance');

  const nonPartners = await usersCollection.find({ role: { $ne: 'partner' } }).toArray();
  for (const user of nonPartners) {
    const usernameLower = user.username.trim().toLowerCase();
    const existing = await attendanceCollection.findOne({
      username: usernameLower,
      date: dateStr
    });

    if (!existing) {
      await attendanceCollection.insertOne({
        username: usernameLower,
        name: user.name,
        role: user.role,
        date: dateStr,
        clockIn: null,
        clockOut: null,
        status: 'Absent'
      });
    }
  }
}


// =============================================================================
// UNIVERSAL TASK & CLIENT RESOLUTION HELPERS
// =============================================================================
function getTaskBadge(t) {
  if (!t) return '#N/A';
  if (t.id != null && String(t.id) !== 'undefined' && String(t.id) !== 'null' && String(t.id) !== 'NaN') {
    return '#' + t.id;
  }
  if (t._id) {
    return '#' + String(t._id).slice(-5);
  }
  if (t.clientCode != null && String(t.clientCode) !== 'undefined' && String(t.clientCode) !== 'null') {
    return '#C' + t.clientCode;
  }
  return '#N/A';
}

async function getNextTaskId(tasksCol) {
  const highest = await tasksCol.find({
    id: { $type: 'number', $gte: 10000, $lt: 1000000000 }
  }).sort({ id: -1 }).limit(1).toArray();

  if (highest.length > 0 && typeof highest[0].id === 'number') {
    return highest[0].id + 1;
  }
  return 10001;
}

function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = [];
  for (let i = 0; i <= b.length; i++) row[i] = i;
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const val = a[i - 1] === b[j - 1] ? row[j - 1] : Math.min(row[j - 1], prev, row[j]) + 1;
      row[j - 1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

async function findTasksByAnyIdentifier(tasksCol, target, allClients = null) {
  if (!target && target !== 0) return [];
  const targetStr = String(target).trim().replace(/^#/, '');
  const numVal = parseInt(targetStr);

  const orClauses = [];
  if (!isNaN(numVal)) {
    orClauses.push({ id: numVal });
    orClauses.push({ id: String(numVal) });
    orClauses.push({ clientCode: String(numVal) });
    orClauses.push({ clientCode: numVal });
    orClauses.push({ clientId: numVal });
  }

  if (targetStr.length >= 2) {
    const escaped = targetStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    orClauses.push({ clientName: { $regex: escaped, $options: 'i' } });
  }

  let found = [];
  if (orClauses.length > 0) {
    found = await tasksCol.find({ $or: orClauses }).toArray();
  }

  if (found.length === 0 && allClients && targetStr.length >= 2) {
    const fuzzyC = findClientFuzzy(allClients, targetStr);
    if (fuzzyC) {
      const cCode = String(fuzzyC.id || fuzzyC.clientCode || '');
      const cName = fuzzyC.name || fuzzyC.clientName || '';
      const cQueries = [];
      if (cCode) {
        cQueries.push({ clientCode: cCode });
        cQueries.push({ clientCode: Number(cCode) });
      }
      if (cName) {
        cQueries.push({ clientName: { $regex: cName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } });
      }
      if (cQueries.length > 0) {
        found = await tasksCol.find({ $or: cQueries }).toArray();
      }
    }
  }

  for (let idx = 0; idx < found.length; idx++) {
    const t = found[idx];
    if (t.id == null || String(t.id) === 'undefined' || String(t.id) === 'null' || String(t.id) === 'NaN') {
      const nextId = await getNextTaskId(tasksCol);
      t.id = nextId;
      tasksCol.updateOne({ _id: t._id }, { $set: { id: t.id } }).catch(() => {});
    }
  }
  return found;
}

function findClientFuzzy(allClients, inputName) {
  if (!inputName || typeof inputName !== 'string' || !Array.isArray(allClients)) return null;
  const cleanInput = inputName.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (cleanInput.length < 2) return null;

  for (const c of allClients) {
    const cName = (c.name || c.clientName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cName && (cName === cleanInput || cName.includes(cleanInput) || (cleanInput.length >= 4 && cleanInput.includes(cName)))) {
      return c;
    }
  }

  const stopWords = new Set(['i', 'want', 'to', 'edit', 'update', 'delete', 'task', 'of', 'for', 'client', 'the', 'a', 'an', 'and', 'or', 'corp', 'corporation', 'ltd', 'limited', 'pvt', 'private', 'co', 'company']);
  const inputWords = inputName.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3 && !stopWords.has(w));
  if (inputWords.length === 0) {
    inputWords.push(...inputName.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3));
  }

  let bestClient = null;
  let bestScore = 0;

  for (const c of allClients) {
    const cRaw = (c.name || c.clientName || '').toLowerCase();
    const clientWords = cRaw.split(/[^a-z0-9]+/).filter(w => w.length >= 2);
    let score = 0;

    for (const iw of inputWords) {
      const sortedIw = iw.split('').sort().join('');
      for (const cw of clientWords) {
        if (iw === cw) {
          score += 4;
        } else if (cw.length >= 3 && (cw.includes(iw) || iw.includes(cw))) {
          score += 2;
        } else if (cw.length >= 3 && sortedIw === cw.split('').sort().join('')) {
          score += 3;
        } else if (cw.length >= 4 && iw.length >= 4 && levenshteinDistance(iw, cw) <= 2) {
          score += 2;
        }
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestClient = c;
    }
  }

  if (bestScore >= 2) {
    return bestClient;
  }
  return null;
}

// =============================================================================
// PARAMETER EXTRACTOR FOR NATURAL LANGUAGE COMMANDS
// =============================================================================
function parseNaturalLanguageParameters(text, allClients = [], allUsers = [], allEngagements = []) {
  const tLower = text.toLowerCase();
  const result = {
    // Task params
    taskId: null,
    clientCode: '',
    clientName: '',
    natureOfWork: '',
    assessmentYear: '',
    dueDate: '',
    operator: '',
    assignToBest: false,
    requestedN: null,
    wantsRecommendation: false,
    targetStatus: null,
    reason: '',
    // Client params
    pan: '',
    phone: '',
    email: '',
    gstNumber: '',
    clientStatus: '',
    address: '',
    // User params
    targetUser: '',
    role: '',
    password: '',
    fullName: '',
    // Engagement params
    engagementTitle: '',
    newEngagementTitle: '',
    // Date
    date: '',
    // Search
    searchTerm: '',
    confidence: {
      hasClient: false,
      hasNature: false,
      hasDueDate: false
    }
  };

  // 1. Task ID or Number (e.g., "task #12345", "job 12345", "#52737", "task 52737", "65597", "1023")
  const taskIdMatch = text.match(/(?:task|job)\s*#?(\d{2,})/i) ||
                      text.match(/#(\d{2,})/i) ||
                      text.match(/\b(\d{3,6})\b/);
  if (taskIdMatch) {
    result.taskId = parseInt(taskIdMatch[1]);
  }

  // 2. Client ID (e.g., "client #1001", "client 1001", "client id 45422", "id 45422", "#45422")
  const clientIdMatch = text.match(/(?:client\s*(?:id\s*)?#?|id\s*#?|#)(\d{1,6})\b/i);
  if (clientIdMatch) {
    const cId = parseInt(clientIdMatch[1]);
    const found = allClients.find(c => Number(c.id || c.clientCode) === cId);
    if (found) {
      result.clientCode = String(found.id || found.clientCode || cId);
      result.clientName = found.name || found.clientName || '';
      result.confidence.hasClient = true;
    } else {
      result.clientCode = String(cId);
    }
  }

  // 3. Client Name match from database (Exact and Fuzzy)
  if (!result.clientCode) {
    for (const c of allClients) {
      const cName = c.name || c.clientName || '';
      const cNameClean = cName.toLowerCase().trim();
      if (cNameClean.length >= 3 && tLower.includes(cNameClean)) {
        result.clientCode = String(c.id || c.clientCode || '');
        result.clientName = cName;
        result.confidence.hasClient = true;
        break;
      }
    }
    // Fuzzy matching for typos like "amce corp"
    if (!result.clientCode) {
      const fuzzy = findClientFuzzy(allClients, text);
      if (fuzzy) {
        result.clientCode = String(fuzzy.id || fuzzy.clientCode || '');
        result.clientName = fuzzy.name || fuzzy.clientName || '';
        result.confidence.hasClient = true;
      }
    }
  }

  // 4. PAN Extraction: 5 letters, 4 digits, 1 letter
  const panMatch = text.match(/\b([A-Z]{5}[0-9]{4}[A-Z])\b/i);
  if (panMatch) {
    result.pan = panMatch[1].toUpperCase();
  }

  // 5. GSTIN Extraction: 15 alphanumeric
  const gstMatch = text.match(/\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/i) ||
                   text.match(/(?:gst|gstin|gst\s*number)\s*[:=]?\s*([0-9a-zA-Z]{15})/i);
  if (gstMatch) {
    result.gstNumber = gstMatch[1].toUpperCase();
  }

  // 6. Phone / Contact Extraction: 10 digits
  const phoneMatch = text.match(/(?:phone|contact|mobile)\s*[:=]?\s*(\+?91[\s-]?)?([6-9]\d{9})/i) ||
                     text.match(/\b([6-9]\d{9})\b/);
  if (phoneMatch) {
    result.phone = (phoneMatch[2] || phoneMatch[1] || '').trim();
  }

  // 7. Email Extraction
  const emailMatch = text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  if (emailMatch) {
    result.email = emailMatch[1].toLowerCase().trim();
  }

  // 8. Client Status
  const statusMatch = text.match(/\bstatus\s*[:=]?\s*(active|inactive)\b/i);
  if (statusMatch) {
    result.clientStatus = statusMatch[1].charAt(0).toUpperCase() + statusMatch[1].slice(1).toLowerCase();
  }

  // 9. Client Phrase match if not already matched
  if (!result.clientCode) {
    const phraseMatch = text.match(/(?:for\s+client|client\s*[:=]|task\s+of\s+client|task\s+of|of\s+client|for|of)\s+([a-zA-Z0-9\s&.,'-]+?)(?:\s+(?:for|due|ay|period|with|and|recommend|assign|status|to|pan|phone|email|gst)|$)/i);
    if (phraseMatch) {
      const candidateName = phraseMatch[1].trim();
      if (candidateName.length >= 2 && !['task', 'the', 'a', 'an', 'gst', 'it', 'tds', 'all', 'mine', 'my'].includes(candidateName.toLowerCase())) {
        result.clientName = candidateName;
        result.confidence.hasClient = true;
        const fuzzy = findClientFuzzy(allClients, candidateName);
        if (fuzzy) {
          result.clientCode = String(fuzzy.id || fuzzy.clientCode || '');
          result.clientName = fuzzy.name || fuzzy.clientName || candidateName;
        }
      }
    }
  }

  // 10. Nature of Work Extraction
  if (tLower.includes('tax audit') || tLower.includes('3cd') || tLower.includes('44ab')) {
    result.natureOfWork = 'Tax Audit (3CD)';
    result.confidence.hasNature = true;
  } else if (tLower.includes('statutory audit') || tLower.includes('company audit')) {
    result.natureOfWork = 'Statutory Audit';
    result.confidence.hasNature = true;
  } else if (tLower.includes('gstr 3b') || tLower.includes('gstr3b')) {
    result.natureOfWork = 'GSTR 3B';
    result.confidence.hasNature = true;
  } else if (tLower.includes('gstr 1') || tLower.includes('gstr1')) {
    result.natureOfWork = 'GSTR 1';
    result.confidence.hasNature = true;
  } else if (tLower.includes('gstr 4') || tLower.includes('cmp 8') || tLower.includes('cmp-8')) {
    result.natureOfWork = 'GSTR 4';
    result.confidence.hasNature = true;
  } else if (tLower.includes('gst annual') || tLower.includes('9/9c') || tLower.includes('gstr 9')) {
    result.natureOfWork = 'GST Annual Return (9/9C)';
    result.confidence.hasNature = true;
  } else if (tLower.includes('gst monthly') || tLower.includes('gst return') || tLower.includes('gst filing') || tLower.includes('gst')) {
    result.natureOfWork = 'GST Monthly Return';
    result.confidence.hasNature = true;
  } else if (tLower.includes('tds') || tLower.includes('26q') || tLower.includes('24q')) {
    result.natureOfWork = 'TDS Quarterly Filing';
    result.confidence.hasNature = true;
  } else if (tLower.includes('roc') || tLower.includes('mca') || tLower.includes('aoc-4')) {
    result.natureOfWork = 'ROC Filing';
    result.confidence.hasNature = true;
  } else if (tLower.includes('it return') || tLower.includes('itr') || tLower.includes('income tax')) {
    result.natureOfWork = 'IT Return';
    result.confidence.hasNature = true;
  } else {
    for (const eng of allEngagements) {
      const engStr = typeof eng === 'string' ? eng : (eng?.title || '');
      if (engStr && tLower.includes(engStr.toLowerCase())) {
        result.natureOfWork = engStr;
        result.confidence.hasNature = true;
        break;
      }
    }
  }

  // 11. Due Date / Dates
  const now = new Date();
  const currYear = now.getFullYear();
  const currMonth = String(now.getMonth() + 1).padStart(2, '0');

  const isoDateMatch = text.match(/\b(20[2-3][0-9]-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01]))\b/);
  if (isoDateMatch) {
    result.dueDate = isoDateMatch[1];
    result.date = isoDateMatch[1];
    result.confidence.hasDueDate = true;
  }

  if (!result.dueDate) {
    const indianDateMatch = text.match(/\b(0?[1-9]|[12][0-9]|3[01])[/-](0?[1-9]|1[0-2])[/-](20[2-3][0-9])\b/);
    if (indianDateMatch) {
      const d = String(indianDateMatch[1]).padStart(2, '0');
      const m = String(indianDateMatch[2]).padStart(2, '0');
      const y = indianDateMatch[3];
      result.dueDate = `${y}-${m}-${d}`;
      result.date = result.dueDate;
      result.confidence.hasDueDate = true;
    }
  }

  if (!result.dueDate) {
    const monthNames = {
      jan: '01', january: '01', feb: '02', february: '02', mar: '03', march: '03',
      apr: '04', april: '04', may: '05', jun: '06', june: '06', jul: '07', july: '07',
      aug: '08', august: '08', sep: '09', september: '09', oct: '10', october: '10',
      nov: '11', november: '11', dec: '12', december: '12'
    };
    const dayMonthMatch = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-zA-Z]{3,9})(?:\s+(\d{4}))?\b/i) ||
                          text.match(/\b([a-zA-Z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?\b/i);
    if (dayMonthMatch) {
      let dayPart = parseInt(dayMonthMatch[1]) || parseInt(dayMonthMatch[2]);
      let monthPart = (dayMonthMatch[1] && isNaN(dayMonthMatch[1])) ? dayMonthMatch[1].toLowerCase() : dayMonthMatch[2].toLowerCase();
      let yearPart = dayMonthMatch[3] ? parseInt(dayMonthMatch[3]) : currYear;

      if (monthNames[monthPart]) {
        result.dueDate = `${yearPart}-${monthNames[monthPart]}-${String(dayPart).padStart(2, '0')}`;
        result.date = result.dueDate;
        result.confidence.hasDueDate = true;
      }
    }
  }

  if (!result.dueDate) {
    if (tLower.includes('tomorrow')) {
      const target = new Date(now.getTime() + 86400000);
      result.dueDate = target.toISOString().split('T')[0];
      result.confidence.hasDueDate = true;
    } else if (tLower.includes('today')) {
      result.dueDate = now.toISOString().split('T')[0];
      result.date = result.dueDate;
    } else if (tLower.includes('next week')) {
      const target = new Date(now.getTime() + 7 * 86400000);
      result.dueDate = target.toISOString().split('T')[0];
      result.confidence.hasDueDate = true;
    } else if (tLower.includes('next month')) {
      const target = new Date(now.getTime() + 30 * 86400000);
      result.dueDate = target.toISOString().split('T')[0];
      result.confidence.hasDueDate = true;
    }
  }

  // 12. Assessment Year / Period
  const ayMatch = text.match(/(?:ay|assessment year|period|fy|financial year)\s*[:=]?\s*([0-9]{4}[-/][0-9]{2,4}|[0-9]{4}-[0-9]{2})/i) ||
                  text.match(/\b(20[2-3][0-9]-[2-3][0-9])\b/);
  if (ayMatch) {
    result.assessmentYear = ayMatch[1].trim();
  }

  // 13. Operator / Username Extraction
  if (tLower.includes('assign to best') || tLower.includes('assign best')) {
    result.assignToBest = true;
  } else {
    // Explicit @username mentions
    const atMatch = text.match(/@([a-zA-Z0-9_]+)/);
    if (atMatch) {
      result.operator = atMatch[1].toLowerCase();
      result.targetUser = atMatch[1].toLowerCase();
    } else {
      const userMatch = text.match(/(?:assign\s+to|assigned\s+to|operator\s*[:=]?|user\s*[:=]?|staff\s*[:=]?)\s*@?([a-zA-Z0-9_]+)/i);
      if (userMatch) {
        const cand = userMatch[1].trim().toLowerCase();
        const nonUsers = ['the', 'a', 'task', 'client', 'staff', 'best', 'top', 'new', 'all', 'any', 'filed', 'assigned', 'pending', 'review', 'done', 'closed', 'active', 'inactive', 'unassigned'];
        if (!nonUsers.includes(cand)) {
          const uObj = allUsers.find(u => u.username && u.username.toLowerCase() === cand);
          if (uObj) {
            result.operator = uObj.username.toLowerCase();
            result.targetUser = uObj.username.toLowerCase();
          } else {
            result.targetUser = cand;
            result.operator = cand;
          }
        }
      } else {
        // Check if any actual user's username is mentioned directly
        for (const u of allUsers) {
          if (u.username && u.username.length >= 3) {
            const uNameLower = u.username.toLowerCase();
            const re = new RegExp(`\\b${uNameLower}\\b`, 'i');
            if (re.test(tLower) && !['admin', 'staff', 'user', 'client', 'task'].includes(uNameLower)) {
              result.operator = uNameLower;
              result.targetUser = uNameLower;
              break;
            }
          }
        }
      }
    }
  }

  // 14. User Roles
  const roleMatch = text.match(/\brole\s*[:=]?\s*(partner|staff|article)\b/i);
  if (roleMatch) {
    result.role = roleMatch[1].toLowerCase();
  }

  // 15. Password
  const passMatch = text.match(/\bpassword\s*[:=]?\s*([^\s,]+)/i);
  if (passMatch) {
    result.password = passMatch[1].trim();
  }

  // 16. Full Name
  const nameMatch = text.match(/\bname\s*[:=]?\s*([a-zA-Z\s&.,'-]+?)(?:\s+(?:role|password|username|pan|contact|email|gst)|$)/i);
  if (nameMatch) {
    result.fullName = nameMatch[1].trim();
  }

  // 17. Reason for Pending / Remarks
  const reasonMatch = text.match(/(?:reason|remarks|pending reason)\s*[:=]?\s*(.+)/i);
  if (reasonMatch) {
    result.reason = reasonMatch[1].trim();
  }

  // 18. Status transitions
  if (tLower.includes('approve') || tLower.includes('approved')) {
    result.targetStatus = 'Approved';
  } else if (tLower.includes('file') || tLower.includes('mark filed') || tLower.includes('mark as filed')) {
    result.targetStatus = 'Filed';
  } else if (tLower.includes('review') || tLower.includes('pending review') || tLower.includes('submit for review')) {
    result.targetStatus = 'Pending Review';
  } else if (tLower.includes('reject') || tLower.includes('send back') || tLower.includes('rework')) {
    result.targetStatus = 'Rework';
  }

  // 19. Search term
  const searchMatch = text.match(/(?:search|find|for)\s+(?:client|task|user|staff)?\s*([a-zA-Z0-9\s&.,'-]+)/i);
  if (searchMatch) {
    result.searchTerm = searchMatch[1].trim();
  }

  return result;
}

// =============================================================================
// GROQ LLM TOOL CALLING ENGINE & SCHEMAS
// =============================================================================
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
      description: 'Check attendance records (present/absent/on duty) for staff today or on a given date. NOTE: Clock-in/out cannot be performed here.',
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
          natureOfWork: { type: 'string', description: 'Nature of work (e.g. GST Monthly Return, Income Tax Audit)' },
          limit: { type: 'number', description: 'Number of recommendations (default 3)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_compliance_automation',
      description: 'Automatically generate recurring monthly GST compliance tasks for all active GST clients. Requires partner/admin role.',
      parameters: {
        type: 'object',
        properties: {}
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
      reasonForPending: ''
    };
    await tasksCol.insertOne(newTask);
    await logAuditAction(db, decoded.username, 'CREATE_TASK_LLM', { taskId: nextId, clientName: cName });
    return { success: true, taskId: nextId, task: newTask };
  }

  if (name === 'update_task') {
    const tId = parseInt(args.taskId);
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
    const tId = parseInt(args.taskId);
    if (!tId) return { success: false, error: 'Task ID is required' };
    const resDel = await tasksCol.deleteOne({ id: tId });
    if (resDel.deletedCount === 0) return { success: false, error: `Task #${tId} not found.` };
    await logAuditAction(db, decoded.username, 'DELETE_TASK_LLM', { taskId: tId });
    return { success: true, deletedTaskId: tId };
  }

  if (name === 'advance_task_status') {
    const tId = parseInt(args.taskId);
    const targetStatus = args.targetStatus;
    if (!tId || !targetStatus) return { success: false, error: 'Task ID and targetStatus are required' };
    const task = await tasksCol.findOne({ id: tId });
    if (!task) return { success: false, error: `Task #${tId} not found` };

    if (['Approved', 'Filed'].includes(targetStatus) && !isAdmin) {
      return { success: false, error: 'Forbidden: Partner/admin role required for approval or filing.' };
    }

    const updates = { currentStatus: targetStatus };
    const today = new Date().toISOString().split('T')[0];
    if (targetStatus === 'Filed') updates.fileDate = today;
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
      const q = String(args.query).trim();
      const numQ = parseInt(q.replace(/^#/, ''));
      if (!isNaN(numQ)) {
        filter.$or = [{ id: numQ }, { clientCode: String(numQ) }];
      } else {
        filter.$or = [
          { clientName: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
          { natureOfWork: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }
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
    const nextCId = (highest.length > 0 && typeof highest[0].id === 'number') ? highest[0].id + 1 : 101;

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

  if (name === 'update_client') {
    if (!isAdmin) return { success: false, error: 'Forbidden: Admins only can update clients.' };
    const cId = parseInt(args.clientId);
    if (!cId) return { success: false, error: 'Client ID is required.' };
    const client = await clientsCol.findOne({ id: cId });
    if (!client) return { success: false, error: `Client #${cId} not found.` };

    const updates = {};
    if (args.name) updates.name = args.name.trim();
    if (args.pan !== undefined) updates.pan = args.pan.toUpperCase().trim();
    if (args.contact !== undefined) updates.contact = args.contact;
    if (args.email !== undefined) updates.email = args.email;
    if (args.gstNumber !== undefined) updates.gstNumber = args.gstNumber.toUpperCase().trim();
    if (args.status) updates.status = args.status;

    await clientsCol.updateOne({ _id: client._id }, { $set: updates });
    const updated = await clientsCol.findOne({ _id: client._id });
    await logAuditAction(db, decoded.username, 'UPDATE_CLIENT_LLM', { clientId: cId, updates });
    return { success: true, clientId: cId, client: updated };
  }

  if (name === 'delete_client') {
    if (!isAdmin) return { success: false, error: 'Forbidden: Admins only can delete clients.' };
    const cId = parseInt(args.clientId);
    if (!cId) return { success: false, error: 'Client ID is required.' };
    const client = await clientsCol.findOne({ id: cId });
    if (!client) return { success: false, error: `Client #${cId} not found.` };

    await clientsCol.deleteOne({ id: cId });
    await tasksCol.deleteMany({ clientCode: String(cId) });
    await logAuditAction(db, decoded.username, 'DELETE_CLIENT_LLM', { clientId: cId, clientName: client.name });
    return { success: true, deletedClientId: cId, clientName: client.name };
  }

  if (name === 'search_clients') {
    const filter = {};
    if (args.status) filter.status = args.status;
    if (args.query) {
      const q = String(args.query).trim();
      const numQ = parseInt(q);
      if (!isNaN(numQ)) {
        filter.$or = [{ id: numQ }, { pan: { $regex: q, $options: 'i' } }];
      } else {
        filter.$or = [
          { name: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
          { pan: { $regex: q, $options: 'i' } },
          { contact: { $regex: q, $options: 'i' } }
        ];
      }
    }
    const limit = Math.min(args.limit || 10, 20);
    const list = await clientsCol.find(filter).limit(limit).toArray();
    return {
      success: true,
      count: list.length,
      clients: list.map(c => ({ id: c.id, name: c.name, pan: c.pan || 'N/A', contact: c.contact || 'N/A', gstNumber: c.gstNumber || 'N/A', status: c.status || 'Active' }))
    };
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
        clockIn: r.clockIn ? new Date(r.clockIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-',
        clockOut: r.clockOut ? new Date(r.clockOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-'
      }))
    };
  }

  if (name === 'mark_on_duty') {
    if (!isAdmin) return { success: false, error: 'Forbidden: Admins only can mark On Duty.' };
    const targetUser = String(args.username || '').trim().toLowerCase();
    const userDoc = await usersCol.findOne({ username: targetUser });
    if (!userDoc) return { success: false, error: `User @${targetUser} not found.` };
    const dateStr = args.date || getISTDateDetails().dateStr;

    await attendanceCol.updateOne(
      { username: targetUser, date: dateStr },
      { $set: { status: 'On Duty', name: userDoc.name, role: userDoc.role } },
      { upsert: true }
    );
    await logAuditAction(db, decoded.username, 'MARK_OD_LLM', { username: targetUser, date: dateStr });
    return { success: true, username: targetUser, date: dateStr, status: 'On Duty' };
  }

  if (name === 'get_staff_recommendations') {
    const recommendations = await computeRecommendations(db, args.natureOfWork || '');
    const limit = Math.min(args.limit || 3, 5);
    return {
      success: true,
      natureOfWork: args.natureOfWork || 'General',
      topRecommendations: recommendations.slice(0, limit)
    };
  }

  if (name === 'run_compliance_automation') {
    if (!isAdmin) return { success: false, error: 'Forbidden: Admins only can run compliance automations.' };
    const now = new Date();
    const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
    const currentYear = now.getFullYear();
    const currentPeriod = `${currentYear}-${currentMonth}`;

    const gstClients = await clientsCol.find({
      status: { $ne: 'Inactive' },
      gstNumber: { $exists: true, $ne: '' }
    }).limit(50).toArray();

    const existingTasks = await tasksCol.find({
      natureOfWork: 'GST Monthly Return',
      assessmentYear: currentPeriod
    }).toArray();
    const existingClientCodes = new Set(existingTasks.map(t => String(t.clientCode)));

    const tasksToInsert = [];
    const today = new Date().toISOString().split('T')[0];
    let nextTaskId = await getNextTaskId(tasksCol);

    for (const c of gstClients) {
      if (!existingClientCodes.has(String(c.id))) {
        tasksToInsert.push({
          id: nextTaskId++,
          clientCode: String(c.id),
          clientName: c.name,
          natureOfWork: 'GST Monthly Return',
          assessmentYear: currentPeriod,
          dateReceived: today,
          dueDate: `${currentYear}-${currentMonth}-20`,
          currentStatus: c.gstStaff ? 'Assigned' : 'Unassigned',
          workTakenBy: c.gstStaff || '',
          workTakenOn: c.gstStaff ? today : '',
          sendBackCount: 0,
          reasonForPending: ''
        });
      }
    }

    if (tasksToInsert.length > 0) {
      await tasksCol.insertMany(tasksToInsert);
      await logAuditAction(db, decoded.username, 'AUTO_GST_LLM', { count: tasksToInsert.length });
    }
    return { success: true, period: currentPeriod, createdCount: tasksToInsert.length };
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
    const leaderboard = await tasksCol.aggregate([
      { $match: { currentStatus: 'Filed' } },
      { $group: { _id: '$workTakenBy', totalFiled: { $sum: 1 } } },
      { $sort: { totalFiled: -1 } },
      { $limit: 5 }
    ]).toArray();

    return {
      success: true,
      totalTasks,
      statusBreakdown: sMap,
      totalClients,
      totalUsers,
      leaderboard: leaderboard.map(l => ({ username: l._id || 'unassigned', totalFiled: l.totalFiled }))
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
Firm Administrative Privileges: ${isAdmin ? 'Full Partner Admin' : 'Staff / Article'}

You manage clients, workflow tasks, staff assignments, status pipelines, attendance checks, and compliance automations.
Task Status Stages in Order:
1. "Unassigned" -> 2. "Assigned" -> 3. "Pending Review" -> 4. "Approved" -> 5. "Filed" (or "Rework" if sent back).

CRITICAL POLICY & SECURITY RULES:
1. ATTENDANCE CLOCK-IN / PUNCH-IN / CLOCK-OUT:
   - Attendance Clock-In and Clock-Out CANNOT be performed via Chatbot.
   - If the user asks to clock in, punch in, clock out, or punch out, politely refuse and instruct them to use the camera scanner on the Attendance tab.
   - You CAN check attendance (who is present/absent) and mark On Duty (OD) for field work.
2. PARTNER PRIVILEGES:
   - Creating/deleting clients, deleting tasks, approving tasks, marking On Duty, and running bulk automations require Partner role.
3. TASK IDENTIFIERS:
   - Task IDs are 5-digit numbers starting at #10001 (e.g. #10001, #10002).
   - Client IDs are numbers like 101, 45422.
   - Always refer to tasks with their proper Task ID badge like #10001.
4. TONE & FORMAT:
   - Be concise, direct, professional, and clear.
   - Use Markdown formatting: bold for names/statuses, bullet lists for multiple items, code blocks for IDs/PAN.
   - Execute tools when requested to perform actions or search information. If multiple tools are needed (e.g. search client then create task), call them in order.`;

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

  // 1st LLM call
  const firstData = await callGroqChatCompletions(messages, GROQ_TOOLS, apiKey, model);
  const choice = firstData?.choices?.[0];
  if (!choice || !choice.message) {
    throw new Error('Invalid response structure from Groq API');
  }

  const assistantMsg = choice.message;
  const toolCalls = assistantMsg.tool_calls;

  let lastTask = null;
  let lastClient = null;
  let lastAttendance = null;
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
      if (toolResult.attendance || call.function.name === 'check_attendance') {
        lastAttendance = toolResult;
        chips.push({ label: '🕒 Open Attendance Tab', action: 'view_attendance', params: {} });
      }
      if (call.function.name === 'get_staff_recommendations') {
        chips.push({ label: '⭐ Recommend Staff', action: 'recommend_staff', params: { limit: 3 } });
      }

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(toolResult)
      });
    }

    // 2nd LLM call for conversational summary
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
      attendance: lastAttendance,
      context: null
    });
  }

  // No tools called - direct conversational reply
  const replyContent = assistantMsg.content || 'I am ready to help you with tasks, clients, and attendance.';
  const defaultChips = [
    { label: '➕ Create Task', action: 'prompt_text', text: 'Create a new task' },
    { label: '📋 View All Tasks', action: 'view_tasks', params: {} },
    { label: '🏢 View All Clients', action: 'view_clients', params: {} },
    { label: '🕒 Check Attendance', action: 'view_attendance', params: {} }
  ];

  return res.status(200).json({
    success: true,
    reply: replyContent,
    chips: defaultChips,
    context: null
  });
}

// =============================================================================
// MAIN CHATBOT ROUTE DISPATCHER
// =============================================================================
module.exports = async (req, res) => {
  try {
    const decoded = verifyToken(req);
    if (!decoded) {
      return res.status(401).json({ success: false, message: 'Unauthorized: Missing or invalid token.' });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ success: false, message: 'Method Not Allowed' });
    }

    const {
      message = '',
      action = '',
      context = null,
      history = [],
      engine = 'groq',
      // Task params
      taskId,
      clientCode,
      clientName,
      natureOfWork,
      assessmentYear,
      dueDate,
      operator,
      targetStatus,
      reason,
      limit,
      // Client params
      id,
      clientId,
      name,
      pan,
      contact,
      email,
      gstNumber,
      gstStaff,
      status,
      address,
      city,
      pinCode,
      // User params
      username,
      password,
      role,
      newPassword,
      originalUsername,
      // Attendance params
      date,
      // Engagement params
      title,
      originalTitle
    } = req.body || {};

    const isAdmin = checkRole(decoded, ['partner']);
    const query = String(message || '').trim();
    const queryLower = query.toLowerCase();

    const { db } = await connectToDatabase();
    const clientsCol = db.collection('clients');
    const tasksCol = db.collection('tasks');
    const attendanceCol = db.collection('attendance');
    const usersCol = db.collection('users');
    const engagementsCol = db.collection('engagements');

    // Make sure absent records exist for today
    await ensureDailyAbsentRecords(db);

    const allClients = await clientsCol.find({ status: { $ne: 'Inactive' } }).limit(500).toArray();
    const allUsers = await usersCol.find({}).toArray();
    const allEngagements = (await engagementsCol.find({}).toArray()).map(e => e.title);

    // =========================================================================
    // SECTION A: EXPLICIT ACTION HANDLERS (Invoked by UI chips or buttons)
    // =========================================================================

    // -------------------------------------------------------------------------
    // A1. TASK CRUD ACTIONS
    // -------------------------------------------------------------------------
    if (action === 'create_task') {
      if (!isAdmin) {
        return res.status(403).json({ success: false, message: 'Forbidden: Admins only can create tasks.' });
      }

      if (!clientCode || !clientName || !natureOfWork || !dueDate) {
        return res.status(400).json({ success: false, message: 'Client Code, Client Name, Nature of Work, and Due Date are required.' });
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
        return res.status(200).json({
          success: false,
          reply: `⚠️ **Duplicate Task Blocked**: An active task for **${cNameClean}** (#${cCodeClean}) for **${natureClean}** is already open (Status: *${existingTask.currentStatus}*, Assigned: @${existingTask.workTakenBy || 'Unassigned'}, Task ID: #${existingTask.id}).`,
          task: existingTask,
          context: null
        });
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
        reasonForPending: ''
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

      return res.status(200).json({ success: true, reply: replyMsg, task: newTask, context: null, chips });
    }

    if (action === 'view_tasks' || action === 'list_tasks') {
      let filter = {};
      if (req.body.status) {
        filter.currentStatus = req.body.status;
      }
      if (req.body.operator) {
        filter.workTakenBy = String(req.body.operator).trim().toLowerCase();
      }
      if (req.body.clientCode) {
        filter.clientCode = String(req.body.clientCode);
      }
      if (!isAdmin) {
        filter.workTakenBy = decoded.username;
      }

      const tasksList = await tasksCol.find(filter).sort({ dueDate: 1 }).limit(parseInt(limit || '10') || 10).toArray();
      if (tasksList.length === 0) {
        return res.status(200).json({
          success: true,
          reply: `📋 No tasks found matching your criteria.`,
          context: null,
          chips: [{ label: '➕ Create New Task', action: 'prompt_text', text: 'Create task for client ' }]
        });
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

      return res.status(200).json({ success: true, reply: replyMsg, tasks: tasksList, context: null, chips });
    }

    if (action === 'update_task') {
      const candidateTasks = await findTasksByAnyIdentifier(tasksCol, taskId || id, allClients);
      const task = candidateTasks[0];
      if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });

      if (!isAdmin && task.workTakenBy !== decoded.username) {
        return res.status(403).json({ success: false, message: 'Forbidden: You can only edit your own assigned tasks.' });
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

      return res.status(200).json({
        success: true,
        reply: `✏️ **Task ${badge} Updated Successfully!**\n- Client: **${updated.clientName}**\n- Nature: **${updated.natureOfWork}**\n- Status: **${updated.currentStatus}**\n- Assigned: @${updated.workTakenBy || 'Unassigned'}\n- Due: \`${updated.dueDate}\``,
        task: updated,
        context: null,
        chips: [{ label: `⏩ Manage ${badge}`, action: 'advance_status', params: { taskId: updated.id } }]
      });
    }

    if (action === 'delete_task') {
      if (!isAdmin) return res.status(403).json({ success: false, message: 'Forbidden: Admins only can delete tasks.' });
      const candidateTasks = await findTasksByAnyIdentifier(tasksCol, taskId || id, allClients);
      const taskToDelete = candidateTasks[0];
      if (!taskToDelete) return res.status(404).json({ success: false, message: 'Task not found.' });

      const badge = getTaskBadge(taskToDelete);
      await tasksCol.deleteOne({ _id: taskToDelete._id });
      await logAuditAction(db, decoded.username, 'DELETE_TASK_CHAT', { taskId: taskToDelete.id, clientName: taskToDelete.clientName });

      return res.status(200).json({
        success: true,
        reply: `🗑️ **Task ${badge} (${taskToDelete.natureOfWork} for ${taskToDelete.clientName}) deleted successfully.**`,
        context: null,
        chips: [{ label: '📋 View All Tasks', action: 'view_tasks', params: {} }]
      });
    }

    if (action === 'assign_task') {
      if (!isAdmin) return res.status(403).json({ success: false, message: 'Forbidden: Admins only can assign tasks.' });
      const opUsername = String(operator || '').trim().toLowerCase();
      if (!opUsername) return res.status(400).json({ success: false, message: 'Operator username is required.' });

      const opUser = await usersCol.findOne({ username: opUsername });
      if (!opUser) return res.status(404).json({ success: false, message: `Staff user @${opUsername} not found.` });

      let targetTask = null;
      if (taskId || id) {
        const candidateTasks = await findTasksByAnyIdentifier(tasksCol, taskId || id, allClients);
        targetTask = candidateTasks[0];
      } else if (clientCode && natureOfWork) {
        targetTask = await tasksCol.findOne({
          clientCode: String(clientCode),
          natureOfWork: String(natureOfWork),
          currentStatus: { $in: ['Unassigned', 'Assigned'] }
        });
      }

      if (!targetTask) return res.status(404).json({ success: false, message: 'No matching active task found to assign.' });

      const todayStr = new Date().toISOString().split('T')[0];
      await tasksCol.updateOne({ _id: targetTask._id }, { $set: { workTakenBy: opUsername, workTakenOn: todayStr, currentStatus: 'Assigned' } });
      const updatedTask = await tasksCol.findOne({ _id: targetTask._id });
      const badge = getTaskBadge(updatedTask);

      await logAuditAction(db, decoded.username, 'ASSIGN_TASK_CHAT', { taskId: updatedTask.id, operator: opUsername });

      return res.status(200).json({
        success: true,
        reply: `✅ **Task ${badge} Assigned to ${opUser.name} (@${opUsername})**\n- **Client**: ${updatedTask.clientName}\n- **Nature**: ${updatedTask.natureOfWork}\n- **Status**: **Assigned**`,
        task: updatedTask,
        context: null,
        chips: [
          { label: '⏩ Advance to Pending Review', action: 'advance_status', params: { taskId: updatedTask.id, targetStatus: 'Pending Review' } },
          { label: '📋 View All Tasks', action: 'view_tasks', params: {} }
        ]
      });
    }

    if (action === 'advance_status') {
      const candidateTasks = await findTasksByAnyIdentifier(tasksCol, taskId || id, allClients);
      const existingTask = candidateTasks[0];
      if (!existingTask) return res.status(404).json({ success: false, message: 'Task not found.' });
      const badge = getTaskBadge(existingTask);
      const tId = existingTask.id;

      let nextStatus = targetStatus;
      if (!nextStatus) {
        switch (existingTask.currentStatus) {
          case 'Unassigned':
            return res.status(200).json({
              success: false,
              reply: `Task ${badge} is currently **Unassigned**. Assign an operator before advancing status.`,
              chips: [{ label: '⭐ Recommend Top 3 Staff', action: 'recommend_staff', params: { taskId: tId, clientCode: existingTask.clientCode, natureOfWork: existingTask.natureOfWork, limit: 3 } }]
            });
          case 'Assigned':
            nextStatus = 'Pending Review';
            break;
          case 'Pending Review':
            if (isAdmin) nextStatus = 'Approved';
            else nextStatus = 'Pending Review';
            break;
          case 'Approved':
            nextStatus = 'Filed';
            break;
          case 'Filed':
            return res.status(200).json({ success: true, reply: `Task ${badge} is already **Filed** and locked.`, context: null });
          default:
            nextStatus = 'Pending Review';
        }
      }

      if (nextStatus === 'Approved' && !isAdmin) {
        return res.status(403).json({ success: false, message: 'Only Partners can approve tasks.' });
      }

      let updateDoc = { currentStatus: nextStatus };
      if (targetStatus === 'Reject' || targetStatus === 'Rework') {
        nextStatus = 'Assigned';
        updateDoc = { currentStatus: 'Assigned', sendBackCount: (existingTask.sendBackCount || 0) + 1 };
      }

      await tasksCol.updateOne({ _id: existingTask._id }, { $set: updateDoc });
      const updatedTask = await tasksCol.findOne({ _id: existingTask._id });

      await logAuditAction(db, decoded.username, 'STATUS_CHANGE_CHAT', {
        taskId: tId,
        fromStatus: existingTask.currentStatus,
        toStatus: updatedTask.currentStatus
      });

      let replyMsg = `🔄 **Task ${badge} Status Updated!**\n- **Client**: ${updatedTask.clientName}\n- **Work**: ${updatedTask.natureOfWork}\n- **Operator**: @${updatedTask.workTakenBy || 'Unassigned'}\n- **New Status**: **${updatedTask.currentStatus}**\n\n`;

      const nextChips = [];
      if (updatedTask.currentStatus === 'Assigned') {
        replyMsg += `Work is in progress with @${updatedTask.workTakenBy}.`;
        nextChips.push({ label: '⏩ Submit for Review', action: 'advance_status', params: { taskId: tId, targetStatus: 'Pending Review' } });
      } else if (updatedTask.currentStatus === 'Pending Review' && isAdmin) {
        replyMsg += `Task is awaiting partner review verdict:`;
        nextChips.push({ label: '✅ Approve Task', action: 'advance_status', params: { taskId: tId, targetStatus: 'Approved' } });
        nextChips.push({ label: '❌ Send Back for Correction', action: 'advance_status', params: { taskId: tId, targetStatus: 'Rework' } });
      } else if (updatedTask.currentStatus === 'Approved') {
        replyMsg += `Task is partner-approved and ready for portal filing!`;
        nextChips.push({ label: '🏛️ Mark as Filed', action: 'advance_status', params: { taskId: tId, targetStatus: 'Filed' } });
      } else if (updatedTask.currentStatus === 'Filed') {
        replyMsg += `🎉 Task completed and successfully filed on portal.`;
      }

      return res.status(200).json({ success: true, reply: replyMsg, task: updatedTask, context: null, chips: nextChips });
    }

    if (action === 'recommend_staff') {
      const nLimit = parseInt(limit || '3') || 3;
      const recs = await computeRecommendations(db, {
        clientCode: clientCode || '',
        natureOfWork: natureOfWork || '',
        limit: nLimit
      });

      if (recs.length === 0) {
        return res.status(200).json({ success: true, reply: `No eligible staff members found in the directory.`, recommendations: [] });
      }

      let replyMsg = `### 🎯 Top ${recs.length} Recommended Staff\n\n`;
      recs.forEach((r, idx) => {
        const attBadge = r.attendanceStatus === 'Present' ? '🟢 Present' : (r.attendanceStatus === 'Absent' ? '🔴 Absent' : '⚪ ' + r.attendanceStatus);
        replyMsg += `**${idx + 1}. ${r.name}** (@${r.username}) — **${r.score}% Match** [${attBadge}]\n- *Role*: ${r.role} | *Active Queue*: ${r.activeTasks} task(s)\n`;
        if (r.reasons && r.reasons.length > 0) replyMsg += `- *Highlights*: ${r.reasons.join(', ')}\n`;
        replyMsg += `\n`;
      });

      const chips = recs.map(r => ({
        label: `Assign @${r.username}`,
        action: 'assign_task',
        params: { taskId: taskId || null, operator: r.username, clientCode, natureOfWork }
      }));

      return res.status(200).json({ success: true, reply: replyMsg, recommendations: recs, chips });
    }

    // -------------------------------------------------------------------------
    // A2. CLIENT CRUD ACTIONS
    // -------------------------------------------------------------------------
    if (action === 'create_client') {
      const clientNameInput = name || clientName;
      if (!clientNameInput) {
        return res.status(400).json({ success: false, message: 'Client name is required.' });
      }

      let targetId = 0;
      if (id || clientId) {
        targetId = parseInt(id || clientId);
        const existing = await clientsCol.findOne({ id: targetId });
        if (existing) return res.status(400).json({ success: false, message: `Client ID [${targetId}] already exists.` });
      } else {
        const maxClient = await clientsCol.find({}).sort({ id: -1 }).limit(1).toArray();
        const topId = maxClient.length > 0 ? (Number(maxClient[0].id) || Number(maxClient[0].clientCode) || 0) : 0;
        targetId = topId > 0 ? (topId + 1) : 1001;
      }

      const hasGst = !!gstNumber;
      const isCmp = hasGst && clientNameInput.toLowerCase().includes('- gstr 4');
      const calculatedGstType = hasGst ? (isCmp ? 'cmp' : 'normal') : '';

      const newClient = {
        id: targetId,
        name: clientNameInput.trim(),
        pan: pan ? pan.trim().toUpperCase() : '',
        contact: contact ? contact.trim() : '',
        email: email ? email.trim() : '',
        status: status ? status.trim() : 'Active',
        gstNumber: gstNumber ? gstNumber.trim().toUpperCase() : '',
        gstStaff: gstStaff ? gstStaff.trim().toLowerCase() : '',
        gstType: calculatedGstType,
        address: address ? address.trim() : '',
        city: city ? city.trim() : '',
        pinCode: pinCode ? pinCode.trim() : ''
      };

      await clientsCol.insertOne(newClient);
      await logAuditAction(db, decoded.username, 'CREATE_CLIENT_CHAT', { clientId: targetId, clientName: newClient.name });

      const replyMsg = `🏢 **Client Created Successfully!**\n- **ID**: [#${targetId}]\n- **Name**: **${newClient.name}**\n- **PAN**: \`${newClient.pan || 'N/A'}\`\n- **Phone**: \`${newClient.contact || 'N/A'}\`\n- **GSTIN**: \`${newClient.gstNumber || 'N/A'}\`\n- **Status**: *${newClient.status}*`;

      const chips = [
        { label: `➕ Create Task for ${newClient.name}`, action: 'prompt_text', text: `Create task for ${newClient.name} (#${targetId}) due 20th next month` },
        { label: '📋 View All Clients', action: 'view_clients', params: {} }
      ];

      return res.status(200).json({ success: true, reply: replyMsg, client: newClient, context: null, chips });
    }

    if (action === 'view_clients' || action === 'list_clients') {
      const searchStr = req.body.search || '';
      let queryFilter = {};
      if (searchStr) {
        const searchRegex = { $regex: searchStr.trim(), $options: 'i' };
        queryFilter.$or = [
          { name: searchRegex },
          { pan: searchRegex },
          { contact: searchRegex },
          { gstNumber: searchRegex }
        ];
      }

      const clientsList = await clientsCol.find(queryFilter).sort({ id: 1 }).limit(parseInt(limit || '10') || 10).toArray();
      if (clientsList.length === 0) {
        return res.status(200).json({ success: true, reply: `🏢 No clients found matching "${searchStr}".`, context: null });
      }

      let replyMsg = `### 🏢 Client Directory (${clientsList.length} items):\n\n`;
      const chips = [];
      clientsList.forEach(c => {
        replyMsg += `- **[#${c.id}] ${c.name}** | PAN: \`${c.pan || 'N/A'}\` | Phone: \`${c.contact || 'N/A'}\` | Status: *${c.status || 'Active'}*\n`;
        if (chips.length < 5) {
          chips.push({ label: `➕ Task for #${c.id}`, action: 'prompt_text', text: `Create task for ${c.name} (#${c.id}) due 20th next month` });
        }
      });

      return res.status(200).json({ success: true, reply: replyMsg, clients: clientsList, context: null, chips });
    }

    if (action === 'update_client') {
      const targetId = parseInt(id || clientId);
      if (!targetId) return res.status(400).json({ success: false, message: 'Client ID is required.' });

      const client = await clientsCol.findOne({ id: targetId });
      if (!client) return res.status(404).json({ success: false, message: 'Client not found.' });

      const updates = {};
      if (name) updates.name = name.trim();
      if (pan !== undefined) updates.pan = pan.trim().toUpperCase();
      if (contact !== undefined) updates.contact = contact.trim();
      if (email !== undefined) updates.email = email.trim();
      if (gstNumber !== undefined) updates.gstNumber = gstNumber.trim().toUpperCase();
      if (status !== undefined) updates.status = status.trim();
      if (address !== undefined) updates.address = address.trim();

      await clientsCol.updateOne({ id: targetId }, { $set: updates });
      if (updates.name) {
        await tasksCol.updateMany({ clientCode: String(targetId) }, { $set: { clientName: updates.name } });
      }
      const updatedClient = await clientsCol.findOne({ id: targetId });
      await logAuditAction(db, decoded.username, 'UPDATE_CLIENT_CHAT', { clientId: targetId, updates });

      return res.status(200).json({
        success: true,
        reply: `✏️ **Client [#${targetId}] Profile Updated Successfully!**\n- **Name**: ${updatedClient.name}\n- **PAN**: \`${updatedClient.pan || 'N/A'}\`\n- **Phone**: \`${updatedClient.contact || 'N/A'}\`\n- **Status**: *${updatedClient.status}*`,
        client: updatedClient,
        context: null,
        chips: [{ label: `➕ New Task for #${targetId}`, action: 'prompt_text', text: `Create task for ${updatedClient.name} (#${targetId})` }]
      });
    }

    if (action === 'delete_client') {
      if (!isAdmin) return res.status(403).json({ success: false, message: 'Forbidden: Admins only can delete clients.' });
      const targetId = parseInt(id || clientId);
      if (!targetId) return res.status(400).json({ success: false, message: 'Client ID is required.' });

      const client = await clientsCol.findOne({ id: targetId });
      if (!client) return res.status(404).json({ success: false, message: 'Client not found.' });

      await clientsCol.deleteOne({ id: targetId });
      await tasksCol.deleteMany({ clientCode: String(targetId) });
      await logAuditAction(db, decoded.username, 'DELETE_CLIENT_CHAT', { clientId: targetId, clientName: client.name });

      return res.status(200).json({
        success: true,
        reply: `🗑️ **Client [#${targetId}] "${client.name}" and all associated workflow tasks wiped globally.**`,
        context: null,
        chips: [{ label: '📋 View Remaining Clients', action: 'view_clients', params: {} }]
      });
    }

    // -------------------------------------------------------------------------
    // A3. ATTENDANCE CRUD ACTIONS
    // -------------------------------------------------------------------------
    if (action === 'clock_in' || action === 'clock_out') {
      const isClockIn = action === 'clock_in';
      return res.status(200).json({
        success: false,
        reply: `⚠️ **Attendance ${isClockIn ? 'Clock-In' : 'Clock-Out'} cannot be performed via Chat.**\n\nPlease use the **Attendance** tab or biometric kiosk to ${isClockIn ? 'punch in' : 'punch out'}.`,
        context: null,
        chips: [
          { label: '🕒 Open Attendance Tab', action: 'view_attendance', params: {} },
          { label: '👥 Who is Present Today?', action: 'prompt_text', text: 'Who is present today?' }
        ]
      });
    }

    if (action === 'mark_od') {
      if (!isAdmin) return res.status(403).json({ success: false, message: 'Forbidden: Admins only can mark On Duty.' });
      const targetUsername = String(username || '').trim().toLowerCase();
      if (!targetUsername) return res.status(400).json({ success: false, message: 'Username is required.' });

      const userDoc = await usersCol.findOne({ username: targetUsername });
      if (!userDoc) return res.status(404).json({ success: false, message: `User @${targetUsername} not found.` });

      const targetDate = date || getISTDateDetails().dateStr;
      const existing = await attendanceCol.findOne({ username: targetUsername, date: targetDate });

      if (existing) {
        await attendanceCol.updateOne({ _id: existing._id }, { $set: { status: 'On Duty' } });
      } else {
        await attendanceCol.insertOne({
          username: targetUsername,
          name: userDoc.name,
          role: userDoc.role,
          date: targetDate,
          clockIn: null,
          clockOut: null,
          status: 'On Duty'
        });
      }

      await logAuditAction(db, decoded.username, 'MARK_OD_CHAT', { targetUser: targetUsername, date: targetDate });
      return res.status(200).json({
        success: true,
        reply: `📍 **On Duty (OD) Marked!**\n- **User**: ${userDoc.name} (@${targetUsername})\n- **Date**: \`${targetDate}\`\n- **Status**: **On Duty**`,
        attendance: { username: targetUsername, date: targetDate, status: 'On Duty' },
        context: null,
        chips: [{ label: '📋 View Attendance', action: 'view_attendance', params: {} }]
      });
    }

    if (action === 'view_attendance') {
      const targetDate = date || getISTDateDetails().dateStr;
      let queryFilter = { date: targetDate };
      if (!isAdmin) queryFilter.username = decoded.username;

      const logs = await attendanceCol.find(queryFilter).toArray();
      if (logs.length === 0) {
        return res.status(200).json({ success: true, reply: `🕒 No attendance records logged for \`${targetDate}\`.`, context: null });
      }

      let replyMsg = `### 🕒 Attendance Status for \`${targetDate}\`:\n\n`;
      let presentCount = 0;
      let absentCount = 0;
      let odCount = 0;

      logs.forEach(l => {
        if (l.status === 'Active' || l.status === 'Completed' || l.status === 'Present') presentCount++;
        else if (l.status === 'On Duty') odCount++;
        else absentCount++;

        const inTime = l.clockIn ? new Date(l.clockIn).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-';
        const outTime = l.clockOut ? new Date(l.clockOut).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '-';
        const badge = (l.status === 'Active' || l.status === 'Completed') ? '🟢 Present' : (l.status === 'On Duty' ? '📍 OD' : '🔴 Absent');
        replyMsg += `- **${l.name}** (@${l.username}) [${badge}] — In: \`${inTime}\` | Out: \`${outTime}\`\n`;
      });

      replyMsg += `\n**Summary**: 🟢 Present: **${presentCount}** | 📍 On Duty: **${odCount}** | 🔴 Absent: **${absentCount}**`;

      const chips = [
        { label: '🕒 Open Attendance Tab', action: 'view_attendance', params: {} },
        { label: '📋 View All Tasks', action: 'view_tasks', params: {} }
      ];

      return res.status(200).json({ success: true, reply: replyMsg, logs, context: null, chips });
    }

    // -------------------------------------------------------------------------
    // A4. USER & ENGAGEMENT ACTIONS
    // -------------------------------------------------------------------------
    if (action === 'create_user') {
      if (!isAdmin) return res.status(403).json({ success: false, message: 'Forbidden: Admins only can create users.' });
      if (!username || !password || !name || !role) {
        return res.status(400).json({ success: false, message: 'Username, password, name, and role are required.' });
      }

      const uInput = username.trim().toLowerCase();
      const exist = await usersCol.findOne({ username: uInput });
      if (exist) return res.status(400).json({ success: false, message: `Username @${uInput} already exists.` });

      const newUser = {
        username: uInput,
        password: password.trim(),
        name: name.trim(),
        role: role.trim().toLowerCase(),
        requireBiometric: false,
        faceDescriptor: null
      };

      await usersCol.insertOne(newUser);
      await logAuditAction(db, decoded.username, 'CREATE_USER_CHAT', { targetUser: uInput, role });

      return res.status(201).json({
        success: true,
        reply: `👤 **User Account Provisioned!**\n- **Name**: ${newUser.name}\n- **Username**: \`@${uInput}\`\n- **Role**: **${newUser.role}**\n- **Password**: \`${newUser.password}\``,
        user: newUser,
        context: null,
        chips: [{ label: '👥 View All Users', action: 'view_users', params: {} }]
      });
    }

    if (action === 'view_users' || action === 'list_users') {
      const usersList = await usersCol.find({}).toArray();
      let replyMsg = `### 👥 Registered Office Staff (${usersList.length} members):\n\n`;

      const loadStats = await tasksCol.aggregate([
        { $match: { currentStatus: { $nin: ['Filed', 'Unassigned'] } } },
        { $group: { _id: '$workTakenBy', count: { $sum: 1 } } }
      ]).toArray();
      const loadMap = {};
      loadStats.forEach(l => { loadMap[l._id] = l.count; });

      usersList.forEach(u => {
        const load = loadMap[u.username.toLowerCase()] || 0;
        replyMsg += `- **${u.name}** (@${u.username}) | Role: **${u.role}** | Active Queue: **${load} task(s)**\n`;
      });

      const chips = [
        { label: '⭐ Recommend Staff', action: 'recommend_staff', params: { limit: 3 } },
        { label: '🕒 Check Attendance', action: 'view_attendance', params: {} }
      ];

      return res.status(200).json({ success: true, reply: replyMsg, users: usersList, context: null, chips });
    }

    if (action === 'create_engagement') {
      if (!isAdmin) return res.status(403).json({ success: false, message: 'Forbidden: Admins only can create engagements.' });
      const engTitle = String(title || req.body.title || '').trim();
      if (!engTitle) return res.status(400).json({ success: false, message: 'Engagement title is required.' });

      const existing = await engagementsCol.findOne({ title: engTitle });
      if (existing) return res.status(200).json({ success: false, reply: `⚠️ Engagement **"${engTitle}"** already exists in the system.`, context: null });

      const newEng = { title: engTitle };
      await engagementsCol.insertOne(newEng);
      await logAuditAction(db, decoded.username, 'CREATE_ENGAGEMENT_CHAT', { title: engTitle });

      return res.status(201).json({
        success: true,
        reply: `🏷️ **Service Engagement Added!**\n- **Service**: **${engTitle}**\n- Added to active engagement registry.`,
        engagement: newEng,
        context: null,
        chips: [
          { label: '📋 View All Engagements', action: 'view_engagements', params: {} }
        ]
      });
    }

    if (action === 'view_engagements' || action === 'list_engagements') {
      const engList = await engagementsCol.find({}).toArray();
      let replyMsg = `### 🏷️ Active Service Engagements (${engList.length}):\n\n`;
      engList.forEach((e, idx) => {
        replyMsg += `${idx + 1}. **${e.title}**\n`;
      });
      return res.status(200).json({ success: true, reply: replyMsg, engagements: engList, context: null });
    }

    if (action === 'delete_engagement') {
      if (!isAdmin) return res.status(403).json({ success: false, message: 'Forbidden: Admins only can delete engagements.' });
      const engTitle = String(title || req.body.title || '').trim();
      if (!engTitle) return res.status(400).json({ success: false, message: 'Engagement title is required.' });

      await engagementsCol.deleteOne({ title: engTitle });
      await logAuditAction(db, decoded.username, 'DELETE_ENGAGEMENT_CHAT', { title: engTitle });

      return res.status(200).json({
        success: true,
        reply: `🗑️ Engagement service **"${engTitle}"** has been removed.`,
        context: null
      });
    }

    if (action === 'view_stats' || action === 'show_stats') {
      const totalTasks = await tasksCol.countDocuments({});
      const statusCounts = await tasksCol.aggregate([
        { $group: { _id: '$currentStatus', count: { $sum: 1 } } }
      ]).toArray();
      const sMap = {};
      statusCounts.forEach(s => { sMap[s._id] = s.count; });

      const totalClients = await clientsCol.countDocuments({});
      const totalUsers = await usersCol.countDocuments({});

      const leaderboard = await tasksCol.aggregate([
        { $match: { currentStatus: 'Filed' } },
        { $group: { _id: '$workTakenBy', totalFiled: { $sum: 1 } } },
        { $sort: { totalFiled: -1 } },
        { $limit: 5 }
      ]).toArray();

      let replyMsg = `### 📊 CA Office Workflow Analytics & Stats\n\n`;
      replyMsg += `- 🏢 **Total Clients Registered**: **${totalClients}**\n`;
      replyMsg += `- 👥 **Active Staff Accounts**: **${totalUsers}**\n`;
      replyMsg += `- 📋 **Total Tasks in Ledger**: **${totalTasks}**\n\n`;
      replyMsg += `**Status Breakdown:**\n`;
      replyMsg += `- ⚪ Unassigned: **${sMap['Unassigned'] || 0}**\n`;
      replyMsg += `- 🟡 Assigned / In Progress: **${sMap['Assigned'] || 0}**\n`;
      replyMsg += `- 🟠 Pending Review: **${sMap['Pending Review'] || 0}**\n`;
      replyMsg += `- 🟢 Partner Approved: **${sMap['Approved'] || 0}**\n`;
      replyMsg += `- 🏛️ Filed & Completed: **${sMap['Filed'] || 0}**\n\n`;

      if (leaderboard.length > 0) {
        replyMsg += `**🏆 Top Filing Staff (Leaderboard):**\n`;
        leaderboard.forEach((l, idx) => {
          replyMsg += `${idx + 1}. **@${l._id || 'unassigned'}**: ${l.totalFiled} filed tasks\n`;
        });
      }

      return res.status(200).json({
        success: true,
        reply: replyMsg,
        context: null,
        chips: [
          { label: '📋 View All Tasks', action: 'view_tasks', params: {} },
          { label: '🏢 View All Clients', action: 'view_clients', params: {} },
          { label: '🕒 Check Attendance', action: 'view_attendance', params: {} }
        ]
      });
    }

    if (action === 'run_automation') {
      if (!isAdmin) return res.status(403).json({ success: false, message: 'Forbidden: Admins only.' });

      const now = new Date();
      const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
      const currentYear = now.getFullYear();
      const currentPeriod = `${currentYear}-${currentMonth}`;

      const gstClients = await clientsCol.find({
        status: { $ne: 'Inactive' },
        gstNumber: { $exists: true, $ne: '' }
      }).limit(50).toArray();

      const existingTasks = await tasksCol.find({
        natureOfWork: 'GST Monthly Return',
        assessmentYear: currentPeriod
      }).toArray();
      const existingClientCodes = new Set(existingTasks.map(t => String(t.clientCode)));

      const tasksToInsert = [];
      const today = new Date().toISOString().split('T')[0];
      let nextTaskId = await getNextTaskId(tasksCol);

      for (const client of gstClients) {
        const cCode = String(client.id);
        if (existingClientCodes.has(cCode)) continue;

        tasksToInsert.push({
          id: nextTaskId++,
          clientCode: cCode,
          clientName: client.name,
          natureOfWork: 'GST Monthly Return',
          assessmentYear: currentPeriod,
          dateReceived: today,
          dueDate: `${currentYear}-${currentMonth}-20`,
          currentStatus: client.gstStaff ? 'Assigned' : 'Unassigned',
          workTakenBy: client.gstStaff || '',
          workTakenOn: client.gstStaff ? today : '',
          sendBackCount: 0,
          reasonForPending: 'Auto-generated by AI Pipeline'
        });
      }

      if (tasksToInsert.length > 0) {
        await tasksCol.insertMany(tasksToInsert);
        await logAuditAction(db, decoded.username, 'AUTO_GST_CHAT', { count: tasksToInsert.length });
        return res.status(200).json({
          success: true,
          reply: `⚡ **Automation Triggered Successfully!** Generated **${tasksToInsert.length}** recurring GST compliance tasks for period \`${currentPeriod}\`.`,
          context: null,
          chips: [{ label: '📋 View All Tasks', action: 'view_tasks', params: {} }]
        });
      } else {
        return res.status(200).json({
          success: true,
          reply: `✅ All active GST clients already have tasks generated for period \`${currentPeriod}\`. No duplicates created.`,
          context: null
        });
      }
    }

    // =========================================================================
    // SECTION B: CONVERSATIONAL MULTI-TURN AI DIALOG ENGINE
    // =========================================================================

    // Universal Attendance Clock-In / Clock-Out Block (Never permitted via Chat)
    if (/\b(?:clock\s*in|punch\s*in|clock\s*out|punch\s*out)\b/i.test(queryLower)) {
      const isClockIn = /\b(?:clock\s*in|punch\s*in)\b/i.test(queryLower);
      return res.status(200).json({
        success: false,
        reply: `⚠️ **Attendance ${isClockIn ? 'Clock-In' : 'Clock-Out'} cannot be performed via Chat.**\n\nPlease use the **Attendance** tab or biometric camera kiosk to ${isClockIn ? 'punch in' : 'punch out'}.`,
        context: null,
        chips: [
          { label: '🕒 Open Attendance Tab', action: 'view_attendance', params: {} },
          { label: '👥 Who is Present Today?', action: 'prompt_text', text: 'Who is present today?' }
        ]
      });
    }

    // Engine Selector: Groq AI (LLM) vs Classic Pattern
    if (engine !== 'pattern') {
      const groqApiKey = process.env.GROQ_API_KEY;
      if (groqApiKey) {
        try {
          return await handleGroqLlmChatTurn(req, res, { db, decoded, isAdmin, allClients, allUsers, query, history });
        } catch (llmErr) {
          console.error('Groq LLM Engine error (falling back to Classic Pattern):', llmErr.message);
          // Fall back seamlessly to Classic Pattern engine below
        }
      }
    }

    // B0. Conversational Reset Check
    if (/^(?:cancel|reset|stop|start\s+over|nevermind)\b/i.test(queryLower)) {
      return res.status(200).json({
        success: true,
        reply: 'Operation cancelled. How else can I assist you?',
        context: null,
        chips: [
          { label: '📋 View All Tasks', action: 'view_tasks', params: {} },
          { label: '🏢 View All Clients', action: 'view_clients', params: {} },
          { label: '📊 View Stats', action: 'view_stats', params: {} }
        ]
      });
    }

    // B1. Conversational Greetings
    if (/^(?:hi|hello|hey|help|good\s+morning|good\s+afternoon|good\s+evening|what\s+can\s+you\s+do)\b/i.test(queryLower.trim())) {
      const greetingReply = `👋 **Hello! I am your AI Office Workflow Assistant.**\n\nI can understand and guide you step-by-step through every operation:\n- 📋 **Tasks**: Create, edit due dates, assign operators, approve, rework, or delete.\n- 🏢 **Clients**: Add new clients, look up by ID/PAN, edit details, view files.\n- 🕒 **Attendance**: Check today's attendance, who is present/absent, mark On Duty.\n- 👥 **Team Workload**: View staff queues, recommend top candidates for any task.\n- 📊 **Analytics**: View filing stats, leaderboard, or run auto GST generation.\n\nWhat would you like to do?`;
      return res.status(200).json({
        success: true,
        reply: greetingReply,
        context: null,
        chips: [
          { label: '📋 View All Tasks', action: 'view_tasks', params: {} },
          { label: '🏢 View All Clients', action: 'view_clients', params: {} },
          { label: '🕒 Check Attendance', action: 'view_attendance', params: {} },
          { label: '📊 View Stats', action: 'view_stats', params: {} }
        ]
      });
    }

    let activeContext = context ? { ...context } : null;
    const parsed = parseNaturalLanguageParameters(query, allClients, allUsers, allEngagements);

    // -------------------------------------------------------------------------
    // B2. ACTIVE MULTI-TURN CONTEXT CONTINUATION
    // -------------------------------------------------------------------------
    if (activeContext && activeContext.intent) {
      // 2A. MULTI-TURN: EDIT TASK
      if (activeContext.intent === 'EDIT_TASK') {
        if (activeContext.step === 'AWAITING_TASK_SELECTION') {
          // If user switches intent completely, break out of this context
          if (queryLower.includes('delete')) {
            activeContext = null;
          } else {
            let candidateTasks = [];
            if (parsed.taskId) {
              candidateTasks = await findTasksByAnyIdentifier(tasksCol, parsed.taskId);
            } else if (parsed.clientCode || parsed.clientName) {
              candidateTasks = await findTasksByAnyIdentifier(tasksCol, parsed.clientCode || parsed.clientName);
            } else {
              candidateTasks = await findTasksByAnyIdentifier(tasksCol, query);
              if (candidateTasks.length === 0) {
                const fuzzyClient = findClientFuzzy(allClients, query);
                if (fuzzyClient) {
                  candidateTasks = await tasksCol.find({
                    $or: [
                      { clientCode: String(fuzzyClient.id || fuzzyClient.clientCode) },
                      { clientName: fuzzyClient.name || fuzzyClient.clientName }
                    ]
                  }).toArray();
                }
              }
            }

            if (candidateTasks.length === 1) {
              const task = candidateTasks[0];
              const badge = getTaskBadge(task);
              activeContext.step = 'AWAITING_UPDATE_DETAILS';
              activeContext.taskId = task.id;

              return res.status(200).json({
                success: true,
                reply: `Selected **Task ${badge} (${task.natureOfWork} for ${task.clientName})**.\n\nWhat would you like to update?\n- 📅 **Due Date** (e.g. *'change due date to 2026-12-10'*)\n- 👤 **Operator** (e.g. *'assign to rahul'*)\n- 🚦 **Status** (e.g. *'mark pending review'* or *'approve'*)`,
                context: activeContext,
                chips: [
                  { label: '📅 Change Due Date', action: 'prompt_text', text: `change due date of task ${badge} to ` },
                  { label: '👤 Assign to rahul', action: 'prompt_text', text: `assign task ${badge} to rahul` },
                  { label: '⏩ Advance Status', action: 'advance_status', params: { taskId: task.id } }
                ]
              });
            } else if (candidateTasks.length > 1) {
              let replyMsg = `I found **${candidateTasks.length} tasks** matching "${query}". Which task would you like to edit?\n\n`;
              candidateTasks.forEach(t => {
                const badge = getTaskBadge(t);
                const opText = t.workTakenBy ? `@${t.workTakenBy}` : 'Unassigned';
                replyMsg += `- **${badge} ${t.natureOfWork}** for *${t.clientName}* [**${t.currentStatus}**] — Assigned: ${opText} | Due: \`${t.dueDate}\`\n`;
              });
              return res.status(200).json({
                success: true,
                reply: replyMsg,
                context: {
                  intent: 'EDIT_TASK',
                  step: 'AWAITING_TASK_SELECTION',
                  candidateTaskIds: candidateTasks.map(t => t.id)
                },
                chips: candidateTasks.map(t => {
                  const badge = getTaskBadge(t);
                  return { label: `Task ${badge} (${t.natureOfWork})`, action: 'prompt_text', text: `Task ${badge}` };
                })
              });
            } else {
              const recent = await tasksCol.find({ currentStatus: { $ne: 'Filed' } }).sort({ dateReceived: -1 }).limit(4).toArray();
              recent.forEach((t, i) => { if (!t.id) t.id = Number(t.clientCode) || (Date.now() + i); });
              return res.status(200).json({
                success: true,
                reply: `I couldn't locate a task matching **"${query}"**. Please enter a Task ID (e.g. *'#52737'*), Client Name, or choose below:`,
                context: activeContext,
                chips: [
                  ...recent.map(t => ({ label: `Task ${getTaskBadge(t)} (${t.clientName})`, action: 'prompt_text', text: `Task ${getTaskBadge(t)}` })),
                  { label: '❌ Cancel', action: 'prompt_text', text: 'cancel' }
                ]
              });
            }
          }
        }

        if (activeContext.step === 'AWAITING_UPDATE_DETAILS') {
          const tId = activeContext.taskId;
          const candidateTasks = await findTasksByAnyIdentifier(tasksCol, tId);
          if (candidateTasks.length === 0) return res.status(200).json({ success: false, reply: `Task #${tId} not found.`, context: null });
          const task = candidateTasks[0];

          let updates = {};
          let msgLines = [];

          if (parsed.dueDate) {
            updates.dueDate = parsed.dueDate;
            msgLines.push(`- **Due Date**: set to \`${parsed.dueDate}\``);
          }
          if (parsed.operator) {
            updates.workTakenBy = parsed.operator;
            updates.currentStatus = 'Assigned';
            updates.workTakenOn = new Date().toISOString().split('T')[0];
            msgLines.push(`- **Operator**: assigned to **@${parsed.operator}**`);
          }
          if (parsed.targetStatus) {
            updates.currentStatus = parsed.targetStatus;
            msgLines.push(`- **Status**: set to **${parsed.targetStatus}**`);
          }
          if (parsed.reason) {
            updates.reasonForPending = parsed.reason;
            msgLines.push(`- **Reason**: \`${parsed.reason}\``);
          }

          if (Object.keys(updates).length > 0) {
            await tasksCol.updateOne({ id: tId }, { $set: updates });
            const updated = await tasksCol.findOne({ id: tId });
            await logAuditAction(db, decoded.username, 'UPDATE_TASK_CHAT', { taskId: tId, updates });

            return res.status(200).json({
              success: true,
              reply: `✅ **Task #${tId} Updated Successfully!**\n- **Client**: ${updated.clientName}\n- **Work**: ${updated.natureOfWork}\n${msgLines.join('\n')}\n- **Status**: **${updated.currentStatus}**`,
              task: updated,
              context: null,
              chips: [
                { label: '⏩ Advance Status', action: 'advance_status', params: { taskId: tId } },
                { label: '📋 View All Tasks', action: 'view_tasks', params: {} }
              ]
            });
          } else {
            return res.status(200).json({
              success: true,
              reply: `I didn't catch the changes for Task #${tId}. You can say:\n- *"Change due date to 2026-12-10"*\n- *"Assign to rahul"*\n- *"Approve task"*\n- Or type *"cancel"* to stop.`,
              context: activeContext
            });
          }
        }
      }

      // 2B. MULTI-TURN: CREATE TASK
      if (activeContext.intent === 'CREATE_TASK') {
        if (!activeContext.data) activeContext.data = {};

        if (activeContext.step === 'AWAITING_CLIENT') {
          const cCode = parsed.clientCode || String(Date.now()).slice(-5);
          const cName = parsed.clientName || query;
          activeContext.data.clientCode = cCode;
          activeContext.data.clientName = cName;
          activeContext.step = 'AWAITING_NATURE';

          return res.status(200).json({
            success: true,
            reply: `Got client **${cName}**.\n\n**Step 2:** What is the **Nature of Work**?\n*(e.g., GST Monthly Return, Tax Audit (3CD), IT Return, ROC Filing)*`,
            context: activeContext,
            chips: [
              { label: 'GST Monthly Return', action: 'prompt_text', text: 'GST Monthly Return' },
              { label: 'Tax Audit (3CD)', action: 'prompt_text', text: 'Tax Audit (3CD)' },
              { label: 'IT Return', action: 'prompt_text', text: 'IT Return' }
            ]
          });
        }

        if (activeContext.step === 'AWAITING_NATURE') {
          const nat = parsed.natureOfWork || query;
          activeContext.data.natureOfWork = nat;
          activeContext.step = 'AWAITING_DUE_DATE';

          return res.status(200).json({
            success: true,
            reply: `Work type set to **${nat}**.\n\n**Step 3:** What is the **Due Date**?\n*(e.g., '2026-11-20', '20th next month', or 'tomorrow')*`,
            context: activeContext,
            chips: [
              { label: '20th Next Month', action: 'prompt_text', text: '20th next month' },
              { label: 'End of Month', action: 'prompt_text', text: 'end of month' },
              { label: 'Tomorrow', action: 'prompt_text', text: 'tomorrow' }
            ]
          });
        }

        if (activeContext.step === 'AWAITING_DUE_DATE') {
          const dDate = parsed.dueDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
          activeContext.data.dueDate = dDate;
          activeContext.step = 'AWAITING_OPERATOR';

          return res.status(200).json({
            success: true,
            reply: `Due date set to \`${dDate}\`.\n\n**Step 4:** Who should be assigned to this task?\nYou can specify an operator username (e.g. *'rahul'*), say *'recommend'*, or *'unassigned'*.`,
            context: activeContext,
            chips: [
              { label: '⭐ Recommend Best Staff', action: 'prompt_text', text: 'recommend' },
              { label: 'Unassigned', action: 'prompt_text', text: 'unassigned' }
            ]
          });
        }

        if (activeContext.step === 'AWAITING_OPERATOR') {
          let assignedOp = parsed.operator || '';
          if (queryLower.includes('recommend') || queryLower.includes('best')) {
            const recs = await computeRecommendations(db, {
              clientCode: activeContext.data.clientCode,
              natureOfWork: activeContext.data.natureOfWork,
              limit: 1
            });
            if (recs.length > 0) assignedOp = recs[0].username;
          }

          const nowStr = new Date().toISOString().split('T')[0];
          const nextTaskId = await getNextTaskId(tasksCol);
          const newTask = {
            id: nextTaskId,
            clientCode: activeContext.data.clientCode,
            clientName: activeContext.data.clientName,
            natureOfWork: activeContext.data.natureOfWork,
            assessmentYear: isGstWorkCheck(activeContext.data.natureOfWork) ? '' : `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`,
            dateReceived: nowStr,
            dueDate: activeContext.data.dueDate,
            currentStatus: assignedOp ? 'Assigned' : 'Unassigned',
            workTakenBy: assignedOp,
            workTakenOn: assignedOp ? nowStr : '',
            sendBackCount: 0,
            reasonForPending: ''
          };

          await tasksCol.insertOne(newTask);
          await logAuditAction(db, decoded.username, 'CREATE_TASK_CHAT', { taskId: newTask.id, clientName: newTask.clientName });

          return res.status(200).json({
            success: true,
            reply: `✅ **Task #${newTask.id} Created Successfully!**\n- **Client**: ${newTask.clientName}\n- **Work**: ${newTask.natureOfWork}\n- **Due Date**: \`${newTask.dueDate}\`\n- **Status**: **${newTask.currentStatus}** ${assignedOp ? `(Assigned to @${assignedOp})` : ''}`,
            task: newTask,
            context: null,
            chips: [
              { label: '⏩ Advance to Pending Review', action: 'advance_status', params: { taskId: newTask.id, targetStatus: 'Pending Review' } },
              { label: '📋 View All Tasks', action: 'view_tasks', params: {} }
            ]
          });
        }
      }

      // 2C. MULTI-TURN: DELETE TASK
      if (activeContext.intent === 'DELETE_TASK') {
        if (activeContext.step === 'AWAITING_TASK_SELECTION') {
          // If user switches intent completely, break out
          if (queryLower.includes('edit')) {
            activeContext = null;
          } else {
            const candidateTasks = await findTasksByAnyIdentifier(tasksCol, parsed.taskId || parsed.clientCode || parsed.clientName || query);
            if (candidateTasks.length > 0) {
              const task = candidateTasks[0];
              const badge = getTaskBadge(task);
              activeContext.step = 'AWAITING_CONFIRMATION';
              activeContext.taskId = task.id;
              return res.status(200).json({
                success: true,
                reply: `⚠️ Are you sure you want to permanently delete **Task ${badge} (${task.natureOfWork} for ${task.clientName})**?`,
                context: activeContext,
                chips: [
                  { label: '✅ Confirm Delete', action: 'prompt_text', text: 'yes' },
                  { label: '❌ Cancel', action: 'prompt_text', text: 'cancel' }
                ]
              });
            } else {
              const recent = await tasksCol.find({}).sort({ dateReceived: -1 }).limit(4).toArray();
              recent.forEach((t, i) => { if (!t.id) t.id = Number(t.clientCode) || (Date.now() + i); });
              return res.status(200).json({
                success: true,
                reply: `I couldn't locate a task matching **"${query}"** to delete. Please specify the Task ID from below:`,
                context: activeContext,
                chips: [
                  ...recent.map(t => ({ label: `Delete ${getTaskBadge(t)}`, action: 'prompt_text', text: `Task ${getTaskBadge(t)}` })),
                  { label: '❌ Cancel', action: 'prompt_text', text: 'cancel' }
                ]
              });
            }
          }
        }

        if (activeContext.step === 'AWAITING_CONFIRMATION') {
          if (/^(?:yes|confirm|proceed|ok|sure|y)\b/i.test(queryLower)) {
            const candidateTasks = await findTasksByAnyIdentifier(tasksCol, activeContext.taskId);
            const task = candidateTasks[0];
            const badge = task ? getTaskBadge(task) : `#${activeContext.taskId}`;
            if (task) {
              await tasksCol.deleteOne({ _id: task._id });
              await logAuditAction(db, decoded.username, 'DELETE_TASK_CHAT', { taskId: task.id, clientName: task.clientName });
            }

            return res.status(200).json({
              success: true,
              reply: `🗑️ **Task ${badge} (${task?.natureOfWork || 'Task'}) deleted permanently from the ledger.**`,
              context: null,
              chips: [{ label: '📋 View All Tasks', action: 'view_tasks', params: {} }]
            });
          } else {
            return res.status(200).json({
              success: true,
              reply: `Deletion cancelled. Task was preserved.`,
              context: null,
              chips: [{ label: '📋 View All Tasks', action: 'view_tasks', params: {} }]
            });
          }
        }
      }
    }

    // -------------------------------------------------------------------------
    // B3. NEW CONVERSATIONAL INTENTS (Turn 1 Inception)
    // -------------------------------------------------------------------------

    // B3A. Conversational Attendance (Clock In & Clock Out disabled in Chat)
    if (/\b(?:clock\s*in|punch\s*in)\b/i.test(queryLower)) {
      return res.status(200).json({
        success: false,
        reply: `⚠️ **Attendance Clock-In cannot be performed via Chat.**\n\nPlease use the **Attendance** tab or biometric kiosk to punch in.`,
        context: null,
        chips: [
          { label: '🕒 Open Attendance Tab', action: 'view_attendance', params: {} },
          { label: '👥 Who is Present Today?', action: 'prompt_text', text: 'Who is present today?' }
        ]
      });
    }
    if (/\b(?:clock\s*out|punch\s*out)\b/i.test(queryLower)) {
      return res.status(200).json({
        success: false,
        reply: `⚠️ **Attendance Clock-Out cannot be performed via Chat.**\n\nPlease use the **Attendance** tab or biometric kiosk to punch out.`,
        context: null,
        chips: [
          { label: '🕒 Open Attendance Tab', action: 'view_attendance', params: {} },
          { label: '👥 Who is Present Today?', action: 'prompt_text', text: 'Who is present today?' }
        ]
      });
    }
    if (/\b(?:mark\s+od|on\s+duty|mark\s+on\s+duty)\b/i.test(queryLower)) {
      req.body.action = 'mark_od';
      req.body.username = parsed.targetUser || decoded.username;
      req.body.date = parsed.date;
      return module.exports(req, res);
    }
    if (/\b(?:who\s+is\s+present|who\s+is\s+absent|show\s+attendance|attendance\s+today|check\s+attendance|attendance\s+status)\b/i.test(queryLower)) {
      req.body.action = 'view_attendance';
      req.body.date = parsed.date;
      return module.exports(req, res);
    }

    // B3B. Conversational Edit Task Inquiry
    const isEditTaskInquiry = /\b(?:edit|update|reschedule|change|modify)\s+(?:a\s+|the\s+)?task\b/i.test(queryLower) ||
                              queryLower.includes('edit task') ||
                              queryLower.includes('update task') ||
                              queryLower.includes('reschedule task');

    if (isEditTaskInquiry) {
      // 1. If user gave specific Task ID and also gave fields to update
      if (parsed.taskId && (parsed.dueDate || parsed.operator || parsed.reason || parsed.targetStatus)) {
        req.body.action = 'update_task';
        req.body.taskId = parsed.taskId;
        req.body.dueDate = parsed.dueDate;
        req.body.operator = parsed.operator;
        req.body.reason = parsed.reason;
        req.body.targetStatus = parsed.targetStatus;
        return module.exports(req, res);
      }

      // 2. Specific Task ID given without update fields -> Ask what to change
      if (parsed.taskId) {
        const candidateTasks = await findTasksByAnyIdentifier(tasksCol, parsed.taskId, allClients);
        if (candidateTasks.length === 0) {
          return res.status(200).json({ success: false, reply: `⚠️ Task **#${parsed.taskId}** was not found in the ledger.`, context: null });
        }

        if (candidateTasks.length === 1) {
          const task = candidateTasks[0];
          const badge = getTaskBadge(task);
          const opText = task.workTakenBy ? `@${task.workTakenBy}` : 'Unassigned';
          return res.status(200).json({
            success: true,
            reply: `### ✏️ Editing Task ${badge} (${task.natureOfWork})\n- **Client**: [${task.clientCode}] **${task.clientName}**\n- **Status**: **${task.currentStatus}**\n- **Assigned**: ${opText}\n- **Due Date**: \`${task.dueDate}\`\n\nWhat would you like to update?`,
            context: { intent: 'EDIT_TASK', step: 'AWAITING_UPDATE_DETAILS', taskId: task.id },
            chips: [
              { label: '📅 Change Due Date', action: 'prompt_text', text: `change due date of task ${badge} to ` },
              { label: '👤 Assign Operator', action: 'prompt_text', text: `assign task ${badge} to ` },
              { label: '⏩ Advance Status', action: 'advance_status', params: { taskId: task.id } }
            ]
          });
        }

        let replyMsg = `I found **${candidateTasks.length} task(s)** matching #${parsed.taskId}. Which one would you like to edit?\n\n`;
        candidateTasks.forEach(t => {
          const badge = getTaskBadge(t);
          const opText = t.workTakenBy ? `@${t.workTakenBy}` : 'Unassigned';
          replyMsg += `- **${badge} ${t.natureOfWork}** for *${t.clientName}* [**${t.currentStatus}**] — Assigned: ${opText} | Due: \`${t.dueDate}\`\n`;
        });
        return res.status(200).json({
          success: true,
          reply: replyMsg,
          context: {
            intent: 'EDIT_TASK',
            step: 'AWAITING_TASK_SELECTION',
            candidateTaskIds: candidateTasks.map(t => t.id)
          },
          chips: candidateTasks.map(t => ({ label: `${getTaskBadge(t)} (${t.natureOfWork})`, action: 'prompt_text', text: `${getTaskBadge(t)}` }))
        });
      }

      // 3. Client ID or Client Name given (e.g. "i want to edit task of client id 45422", "edit task of amce corp")
      if (parsed.clientCode || parsed.clientName) {
        let candidateTasks = [];
        if (parsed.clientCode) {
          candidateTasks = await findTasksByAnyIdentifier(tasksCol, parsed.clientCode, allClients);
        }
        if (candidateTasks.length === 0 && parsed.clientName) {
          candidateTasks = await findTasksByAnyIdentifier(tasksCol, parsed.clientName, allClients);
        }

        if (candidateTasks.length > 0) {
          if (candidateTasks.length === 1) {
            const singleTask = candidateTasks[0];
            const badge = getTaskBadge(singleTask);
            const opText = singleTask.workTakenBy ? `@${singleTask.workTakenBy}` : 'Unassigned';
            return res.status(200).json({
              success: true,
              reply: `### ✏️ Editing Task ${badge} (${singleTask.natureOfWork})\n- **Client**: [${singleTask.clientCode}] **${singleTask.clientName}**\n- **Status**: **${singleTask.currentStatus}**\n- **Assigned**: ${opText}\n- **Due Date**: \`${singleTask.dueDate}\`\n\nWhat would you like to update?`,
              context: {
                intent: 'EDIT_TASK',
                step: 'AWAITING_UPDATE_DETAILS',
                taskId: singleTask.id
              },
              chips: [
                { label: '📅 Change Due Date', action: 'prompt_text', text: `change due date of task ${badge} to ` },
                { label: '👤 Assign Operator', action: 'prompt_text', text: `assign task ${badge} to ` },
                { label: '⏩ Advance Status', action: 'advance_status', params: { taskId: singleTask.id } }
              ]
            });
          }

          const clientDisplayName = parsed.clientName || `Client #${parsed.clientCode}`;
          let replyMsg = `### ✏️ Tasks for **${clientDisplayName}**\n`;
          replyMsg += `I found **${candidateTasks.length} task(s)** for this client. Which task would you like to edit?\n\n`;

          candidateTasks.forEach(t => {
            const badge = getTaskBadge(t);
            const opText = t.workTakenBy ? `@${t.workTakenBy}` : 'Unassigned';
            replyMsg += `- **${badge} ${t.natureOfWork}** | Status: **${t.currentStatus}** | Assigned: **${opText}** | Due: \`${t.dueDate}\`\n`;
          });

          return res.status(200).json({
            success: true,
            reply: replyMsg,
            context: {
              intent: 'EDIT_TASK',
              step: 'AWAITING_TASK_SELECTION',
              clientCode: parsed.clientCode,
              candidateTaskIds: candidateTasks.map(t => t.id)
            },
            chips: candidateTasks.map(t => ({ label: `${getTaskBadge(t)} (${t.natureOfWork})`, action: 'prompt_text', text: `${getTaskBadge(t)}` }))
          });
        } else {
          const clientDisplayName = parsed.clientName || `Client #${parsed.clientCode}`;
          return res.status(200).json({
            success: true,
            reply: `Client **${clientDisplayName}** currently has no active tasks in the ledger. Would you like to create one?`,
            context: null,
            chips: [
              { label: `➕ Create Task for ${clientDisplayName}`, action: 'prompt_text', text: `Create task for ${clientDisplayName} due 20th next month` },
              { label: '📋 View All Tasks', action: 'view_tasks', params: {} }
            ]
          });
        }
      }

      // 4. Generic "i want to edit a task" -> Show recent tasks and wait for selection
      const recentTasks = await tasksCol.find({ currentStatus: { $ne: 'Filed' } }).sort({ dateReceived: -1 }).limit(5).toArray();
      for (let idx = 0; idx < recentTasks.length; idx++) {
        const t = recentTasks[idx];
        if (t.id == null || String(t.id) === 'undefined' || String(t.id) === 'null' || String(t.id) === 'NaN') {
          t.id = await getNextTaskId(tasksCol);
          tasksCol.updateOne({ _id: t._id }, { $set: { id: t.id } }).catch(() => {});
        }
      }
      let replyMsg = `Sure! Which task would you like to edit? Specify the Task ID (e.g. *'#10001'*) or client name.\n\nHere are your most recent active tasks:\n\n`;
      recentTasks.forEach(t => {
        const badge = getTaskBadge(t);
        const opText = t.workTakenBy ? `@${t.workTakenBy}` : 'Unassigned';
        const cCodeBadge = t.clientCode ? `[Client #${t.clientCode}] ` : '';
        replyMsg += `- **Task ${badge}**: ${t.natureOfWork} for **${t.clientName}** ${cCodeBadge}[**${t.currentStatus}**] — Assigned: ${opText}\n`;
      });

      return res.status(200).json({
        success: true,
        reply: replyMsg,
        context: {
          intent: 'EDIT_TASK',
          step: 'AWAITING_TASK_SELECTION',
          candidateTaskIds: recentTasks.map(t => t.id)
        },
        chips: recentTasks.map(t => ({ label: `Task ${getTaskBadge(t)} (${t.natureOfWork})`, action: 'prompt_text', text: `Task ${getTaskBadge(t)}` }))
      });
    }

    // B3C. Conversational Delete Task Inquiry
    const isDeleteTaskInquiry = /\b(?:delete|remove|cancel|drop)\s+(?:a\s+|the\s+)?task\b/i.test(queryLower) ||
                               queryLower.includes('delete task');

    if (isDeleteTaskInquiry) {
      if (!isAdmin) {
        return res.status(403).json({ success: false, message: 'Forbidden: Admins only can delete tasks.' });
      }

      if (parsed.taskId) {
        const candidateTasks = await findTasksByAnyIdentifier(tasksCol, parsed.taskId, allClients);
        if (candidateTasks.length === 0) {
          return res.status(200).json({ success: false, reply: `⚠️ Task **#${parsed.taskId}** was not found in the ledger.`, context: null });
        }
        if (candidateTasks.length === 1) {
          const task = candidateTasks[0];
          const badge = getTaskBadge(task);
          return res.status(200).json({
            success: true,
            reply: `⚠️ Are you sure you want to permanently delete **Task ${badge} (${task.natureOfWork} for ${task.clientName})**?`,
            context: { intent: 'DELETE_TASK', step: 'AWAITING_CONFIRMATION', taskId: task.id },
            chips: [
              { label: '✅ Confirm Delete', action: 'prompt_text', text: 'yes' },
              { label: '❌ Cancel', action: 'prompt_text', text: 'cancel' }
            ]
          });
        }

        let replyMsg = `I found **${candidateTasks.length} task(s)** matching #${parsed.taskId}. Which one would you like to delete?\n\n`;
        candidateTasks.forEach(t => {
          const badge = getTaskBadge(t);
          replyMsg += `- **${badge} ${t.natureOfWork}** for *${t.clientName}* [**${t.currentStatus}**] — Due: \`${t.dueDate}\`\n`;
        });
        return res.status(200).json({
          success: true,
          reply: replyMsg,
          context: { intent: 'DELETE_TASK', step: 'AWAITING_TASK_SELECTION', candidateTaskIds: candidateTasks.map(t => t.id) },
          chips: candidateTasks.map(t => ({ label: `Delete ${getTaskBadge(t)}`, action: 'prompt_text', text: `${getTaskBadge(t)}` }))
        });
      }

      if (parsed.clientCode || parsed.clientName) {
        let candidateTasks = [];
        if (parsed.clientCode) {
          candidateTasks = await findTasksByAnyIdentifier(tasksCol, parsed.clientCode, allClients);
        }
        if (candidateTasks.length === 0 && parsed.clientName) {
          candidateTasks = await findTasksByAnyIdentifier(tasksCol, parsed.clientName, allClients);
        }

        if (candidateTasks.length > 0) {
          if (candidateTasks.length === 1) {
            const singleTask = candidateTasks[0];
            const badge = getTaskBadge(singleTask);
            return res.status(200).json({
              success: true,
              reply: `⚠️ Are you sure you want to permanently delete **Task ${badge} (${singleTask.natureOfWork} for ${singleTask.clientName})**?`,
              context: { intent: 'DELETE_TASK', step: 'AWAITING_CONFIRMATION', taskId: singleTask.id },
              chips: [
                { label: '✅ Confirm Delete', action: 'prompt_text', text: 'yes' },
                { label: '❌ Cancel', action: 'prompt_text', text: 'cancel' }
              ]
            });
          }

          const clientDisplayName = parsed.clientName || `Client #${parsed.clientCode}`;
          let replyMsg = `### 🗑️ Delete Tasks for **${clientDisplayName}**\nWhich task would you like to delete?\n\n`;
          candidateTasks.forEach(t => {
            const badge = getTaskBadge(t);
            replyMsg += `- **${badge} ${t.natureOfWork}** [**${t.currentStatus}**] — Due: \`${t.dueDate}\`\n`;
          });
          return res.status(200).json({
            success: true,
            reply: replyMsg,
            context: { intent: 'DELETE_TASK', step: 'AWAITING_TASK_SELECTION', candidateTaskIds: candidateTasks.map(t => t.id) },
            chips: candidateTasks.map(t => ({ label: `Delete ${getTaskBadge(t)}`, action: 'prompt_text', text: `${getTaskBadge(t)}` }))
          });
        }
      }

      const recentTasks = await tasksCol.find({}).sort({ dateReceived: -1 }).limit(5).toArray();
      for (let idx = 0; idx < recentTasks.length; idx++) {
        const t = recentTasks[idx];
        if (t.id == null || String(t.id) === 'undefined' || String(t.id) === 'null' || String(t.id) === 'NaN') {
          t.id = await getNextTaskId(tasksCol);
          tasksCol.updateOne({ _id: t._id }, { $set: { id: t.id } }).catch(() => {});
        }
      }
      let replyMsg = `Which task would you like to delete? Please pick or enter the Task ID:\n\n`;
      recentTasks.forEach(t => {
        const badge = getTaskBadge(t);
        const cCodeBadge = t.clientCode ? `[Client #${t.clientCode}] ` : '';
        replyMsg += `- **Task ${badge}**: ${t.natureOfWork} for **${t.clientName}** ${cCodeBadge}[**${t.currentStatus}**]\n`;
      });

      return res.status(200).json({
        success: true,
        reply: replyMsg,
        context: { intent: 'DELETE_TASK', step: 'AWAITING_TASK_SELECTION', candidateTaskIds: recentTasks.map(t => t.id) },
        chips: recentTasks.map(t => ({ label: `Delete Task ${getTaskBadge(t)}`, action: 'prompt_text', text: `Delete Task ${getTaskBadge(t)}` }))
      });
    }

    // B3D. Conversational Create Task Inquiry (Step-by-Step Slot Filling)
    const isCreateTaskInquiry = /\b(?:create|add|new|register|inward)\s+(?:a\s+|the\s+)?task\b/i.test(queryLower) ||
                                queryLower === 'create task' ||
                                queryLower === 'add task';

    if (isCreateTaskInquiry && !parsed.confidence.hasClient && !parsed.confidence.hasNature) {
      return res.status(200).json({
        success: true,
        reply: `I'll guide you step-by-step to create a workflow task!\n\n**Step 1:** What is the **Client Name or ID**?`,
        context: { intent: 'CREATE_TASK', step: 'AWAITING_CLIENT', data: {} },
        chips: allClients.slice(0, 4).map(c => ({ label: `[#${c.id}] ${c.name}`, action: 'prompt_text', text: c.name }))
      });
    }

    // B3E. One-shot Task Creation (if details provided in single sentence)
    if (parsed.confidence.hasClient && (parsed.confidence.hasNature || queryLower.includes('task'))) {
      req.body.action = 'create_task';
      req.body.clientCode = parsed.clientCode || String(Date.now()).slice(-5);
      req.body.clientName = parsed.clientName;
      req.body.natureOfWork = parsed.natureOfWork || 'GST Monthly Return';
      req.body.assessmentYear = parsed.assessmentYear;
      req.body.dueDate = parsed.dueDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0];
      req.body.operator = parsed.operator;
      return module.exports(req, res);
    }

    // B3F. Client CRUD Inquiries
    if (/\b(?:create\s+client|add\s+client|new\s+client)\b/i.test(queryLower)) {
      const cName = parsed.clientName || parsed.fullName || (query.match(/(?:create client|add client|new client)\s+([^,]+?)(?:\s+(?:pan|contact|phone|email|gst)|$)/i) || [])[1];
      if (!cName) {
        return res.status(200).json({
          success: true,
          reply: `To register a client, what is the **Client's Name**? *(You can also provide PAN and Phone number)*`,
          context: { intent: 'CREATE_CLIENT', step: 'AWAITING_CLIENT_NAME', data: {} },
          chips: [{ label: '🏢 View All Clients', action: 'view_clients', params: {} }]
        });
      }

      req.body.action = 'create_client';
      req.body.name = cName.trim();
      req.body.pan = parsed.pan;
      req.body.contact = parsed.phone;
      req.body.email = parsed.email;
      req.body.gstNumber = parsed.gstNumber;
      return module.exports(req, res);
    }

    if (/\b(?:delete\s+client|remove\s+client)\b/i.test(queryLower)) {
      let targetId = parsed.clientCode;
      if (!targetId) {
        const recent = await clientsCol.find({}).sort({ id: -1 }).limit(5).toArray();
        let replyMsg = `Which client would you like to delete? Please choose or enter the Client ID:\n\n`;
        return res.status(200).json({
          success: true,
          reply: replyMsg,
          context: null,
          chips: recent.map(c => ({ label: `Delete [#${c.id}] ${c.name}`, action: 'delete_client', params: { clientId: c.id } }))
        });
      }
      req.body.action = 'delete_client';
      req.body.clientId = targetId;
      return module.exports(req, res);
    }

    if (/\b(?:list\s+clients|show\s+clients|view\s+clients|all\s+clients)\b/i.test(queryLower)) {
      req.body.action = 'view_clients';
      return module.exports(req, res);
    }

    // B3G. User CRUD Inquiries (Natural Language)
    if (/\b(?:create\s+user|add\s+user|new\s+user)\b/i.test(queryLower)) {
      const uMatch = query.match(/(?:create user|add user|new user)\s+([a-zA-Z0-9_]+)/i);
      const uName = parsed.targetUser || (uMatch ? uMatch[1] : '');
      if (uName) {
        req.body.action = 'create_user';
        req.body.username = uName;
        req.body.name = parsed.fullName || (uName.charAt(0).toUpperCase() + uName.slice(1));
        req.body.role = parsed.role || 'staff';
        req.body.password = parsed.password || 'password123';
        return module.exports(req, res);
      }
    }

    if (/\b(?:list\s+users|show\s+users|view\s+users|all\s+users|view\s+staff)\b/i.test(queryLower)) {
      req.body.action = 'view_users';
      return module.exports(req, res);
    }

    if (/\b(?:delete\s+user|remove\s+user)\b/i.test(queryLower)) {
      const uMatch = query.match(/(?:delete user|remove user)\s+([a-zA-Z0-9_]+)/i);
      const uName = parsed.targetUser || (uMatch ? uMatch[1] : '');
      if (uName) {
        req.body.action = 'delete_user';
        req.body.username = uName;
        return module.exports(req, res);
      }
    }

    // B3H. Engagement CRUD Inquiries (Natural Language)
    if (/\b(?:create\s+engagement|add\s+engagement|new\s+engagement|add\s+service)\b/i.test(queryLower)) {
      const eMatch = query.match(/(?:create engagement|add engagement|new engagement|add service)\s+([^,]+)/i);
      const eTitle = (eMatch ? eMatch[1] : '').trim();
      if (eTitle) {
        req.body.action = 'create_engagement';
        req.body.title = eTitle;
        return module.exports(req, res);
      }
    }

    if (/\b(?:list\s+engagements|show\s+engagements|view\s+engagements|all\s+engagements|list\s+services)\b/i.test(queryLower)) {
      req.body.action = 'view_engagements';
      return module.exports(req, res);
    }

    if (/\b(?:delete\s+engagement|remove\s+engagement)\b/i.test(queryLower)) {
      const eMatch = query.match(/(?:delete engagement|remove engagement)\s+([^,]+)/i);
      const eTitle = (eMatch ? eMatch[1] : '').trim();
      if (eTitle) {
        req.body.action = 'delete_engagement';
        req.body.title = eTitle;
        return module.exports(req, res);
      }
    }

    // B3I. Attendance Inquiries (Natural Language)
    if (/\b(?:who\s+is\s+present|check\s+attendance|today'?s\s+attendance|attendance\s+log)\b/i.test(queryLower)) {
      req.body.action = 'view_attendance';
      return module.exports(req, res);
    }

    // B3G. Analytics & Automation
    if (/\b(?:show\s+stats|leaderboard|analytics|dashboard)\b/i.test(queryLower)) {
      req.body.action = 'view_stats';
      return module.exports(req, res);
    }
    if (/\b(?:run\s+gst\s+automation|auto\s+pipeline)\b/i.test(queryLower)) {
      req.body.action = 'run_automation';
      return module.exports(req, res);
    }

    // B3H. Entity lookup fallback if client ID was mentioned
    if (parsed.clientCode) {
      const client = await clientsCol.findOne({ id: Number(parsed.clientCode) });
      const clientTasks = await tasksCol.find({ clientCode: String(parsed.clientCode) }).sort({ dueDate: 1 }).toArray();

      if (client || clientTasks.length > 0) {
        const clientNameDisplay = client ? client.name : (clientTasks[0]?.clientName || `Client #${parsed.clientCode}`);
        let replyMsg = `### 🏢 Client [#${parsed.clientCode}] ${clientNameDisplay}\n`;
        if (client) {
          replyMsg += `- **PAN**: \`${client.pan || 'N/A'}\` | **Phone**: \`${client.contact || 'N/A'}\` | **Status**: *${client.status || 'Active'}*\n`;
        }

        const chips = [];
        if (clientTasks.length > 0) {
          replyMsg += `\n**Associated Workflow Tasks (${clientTasks.length}):**\n`;
          clientTasks.forEach(t => {
            const opText = t.workTakenBy ? `@${t.workTakenBy}` : 'Unassigned';
            replyMsg += `- **#${t.id} ${t.natureOfWork}** [**${t.currentStatus}**] — Operator: ${opText} (Due: \`${t.dueDate}\`)\n`;
            if (chips.length < 4 && t.currentStatus !== 'Filed') {
              chips.push({ label: `⚙️ Manage #${t.id}`, action: 'advance_status', params: { taskId: t.id } });
            }
          });
        }

        chips.push({ label: `➕ New Task for ${clientNameDisplay}`, action: 'prompt_text', text: `Create task for ${clientNameDisplay} (#${parsed.clientCode}) due 20th next month` });
        return res.status(200).json({ success: true, reply: replyMsg, client, tasks: clientTasks, context: null, chips });
      }
    }

    // Final clean fuzzy search
    const cleanSearch = query
      .replace(/\b(?:i\s+want\s+to|how\s+to|can\s+you|please|show\s+me|search|find|tell\s+me|about)\b/gi, '')
      .replace(/\b(?:client\s+id|client|task|job|id)\b/gi, '')
      .trim();

    let recordsFound = { clients: [], tasks: [] };
    if (cleanSearch.length >= 2) {
      const searchRegex = { $regex: cleanSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      recordsFound.clients = await clientsCol.find({
        $or: [
          { name: searchRegex },
          { pan: searchRegex },
          { contact: searchRegex },
          { id: isNaN(cleanSearch) ? -999999 : Number(cleanSearch) }
        ]
      }).limit(5).toArray();

      recordsFound.tasks = await tasksCol.find({
        $or: [
          { clientName: searchRegex },
          { clientCode: searchRegex },
          { natureOfWork: searchRegex },
          { workTakenBy: searchRegex }
        ]
      }).limit(5).toArray();
    }

    let reply = '';
    const chips = [];

    if (recordsFound.clients.length > 0) {
      reply += `### 🏢 Matching Clients:\n`;
      recordsFound.clients.forEach(c => {
        reply += `- **[#${c.id}] ${c.name}** | PAN: \`${c.pan || 'N/A'}\` | Phone: \`${c.contact || 'N/A'}\`\n`;
      });
      reply += `\n`;
    }

    if (recordsFound.tasks.length > 0) {
      reply += `### 📋 Matching Tasks:\n`;
      recordsFound.tasks.forEach(t => {
        reply += `- **#${t.id} ${t.natureOfWork}** for *${t.clientName}* [**${t.currentStatus}**] — Operator: @${t.workTakenBy || 'Unassigned'}\n`;
        chips.push({ label: `⚙️ Manage #${t.id}`, action: 'advance_status', params: { taskId: t.id } });
      });
      reply += `\n`;
    }

    if (!reply) {
      reply = `I understand you said: **"${query}"**.\n\nTell me what you'd like to do:\n- 📋 *"Create task for Apex Logistics due 20th next month"*\n- ✏️ *"Edit task of client id 45422"* or *"Edit task #12345"*\n- 🗑️ *"Delete task #12345"*\n- 🏢 *"Create client Acme Corp"* or *"List clients"*\n- 🕒 *"Who is present today?"* or *"Check attendance"*`;

      chips.push({ label: '📋 View All Tasks', action: 'view_tasks', params: {} });
      chips.push({ label: '🏢 View All Clients', action: 'view_clients', params: {} });
      chips.push({ label: '🕒 Check Attendance', action: 'view_attendance', params: {} });
      chips.push({ label: '📊 View Stats', action: 'view_stats', params: {} });
    }

    return res.status(200).json({
      success: true,
      reply,
      context: null,
      chips: chips.slice(0, 6)
    });
  } catch (err) {
    console.error('Chatbot API error:', err);
    return res.status(500).json({ success: false, message: 'Chatbot error: ' + err.message });
  }
};
