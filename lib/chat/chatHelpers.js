const { ObjectId } = require('mongodb');

// Checks if nature of work is GST / CMP without regex
function isGstWorkCheck(natureOfWork) {
  if (!natureOfWork) return false;
  const s = String(natureOfWork).toLowerCase().trim();
  return s.includes('gst') || s.includes('cmp');
}

// Indian Standard Time (IST) date utilities
function getISTDateDetails() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const istTime = new Date(utc + (3600000 * 5.5));
  const year = istTime.getFullYear();
  const month = String(istTime.getMonth() + 1).padStart(2, '0');
  const day = String(istTime.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;
  const hours = String(istTime.getHours()).padStart(2, '0');
  const mins = String(istTime.getMinutes()).padStart(2, '0');
  const timeStr = `${hours}:${mins}`;
  return { dateStr, timeStr, dayOfWeek: istTime.getDay() };
}

// Ensure default absent records for today
async function ensureDailyAbsentRecords(db) {
  try {
    const { dateStr } = getISTDateDetails();
    const usersCol = db.collection('users');
    const attCol = db.collection('attendance');
    const nonPartners = await usersCol.find({ role: { $ne: 'partner' } }).toArray();
    for (const user of nonPartners) {
      const usernameLower = user.username.trim().toLowerCase();
      const existing = await attCol.findOne({
        username: usernameLower,
        date: dateStr
      });
      if (!existing) {
        await attCol.insertOne({
          username: usernameLower,
          date: dateStr,
          status: 'Absent',
          checkIn: null,
          checkOut: null,
          verified: false,
          notes: 'Auto-initialized absent record'
        });
      }
    }
  } catch (err) {
    console.error('ensureDailyAbsentRecords error:', err.message);
  }
}

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

function sanitizeAlphaNumeric(str) {
  if (!str) return '';
  return Array.from(String(str).toLowerCase())
    .filter(c => (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))
    .join('');
}

function findClientFuzzy(allClients, inputName) {
  if (!inputName || typeof inputName !== 'string' || !Array.isArray(allClients)) return null;
  const cleanInput = sanitizeAlphaNumeric(inputName);
  if (cleanInput.length < 2) return null;

  for (const c of allClients) {
    const cName = sanitizeAlphaNumeric(c.name || c.clientName || '');
    if (cName && (cName === cleanInput || cName.includes(cleanInput) || (cleanInput.length >= 4 && cleanInput.includes(cName)))) {
      return c;
    }
  }

  const stopWords = new Set(['i', 'want', 'to', 'edit', 'update', 'delete', 'task', 'of', 'for', 'client', 'the', 'a', 'an', 'and', 'or', 'corp', 'corporation', 'ltd', 'limited', 'pvt', 'private', 'co', 'company']);
  const inputWords = inputName.toLowerCase().split(' ').map(w => sanitizeAlphaNumeric(w)).filter(w => w.length >= 3 && !stopWords.has(w));
  if (inputWords.length === 0) {
    inputWords.push(...inputName.toLowerCase().split(' ').map(w => sanitizeAlphaNumeric(w)).filter(w => w.length >= 3));
  }

  let bestClient = null;
  let bestScore = 0;

  for (const c of allClients) {
    const cRaw = (c.name || c.clientName || '').toLowerCase();
    const clientWords = cRaw.split(' ').map(w => sanitizeAlphaNumeric(w)).filter(w => w.length >= 2);
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

async function findTasksByAnyIdentifier(tasksCol, target, allClients = null) {
  if (!target && target !== 0) return [];
  const targetStr = String(target).trim().replace('#', '');
  const numVal = parseInt(targetStr, 10);

  const orClauses = [];
  if (!isNaN(numVal)) {
    orClauses.push({ id: numVal });
    orClauses.push({ id: String(numVal) });
    orClauses.push({ clientCode: String(numVal) });
    orClauses.push({ clientCode: numVal });
    orClauses.push({ clientId: numVal });
  }

  if (targetStr.length >= 2) {
    orClauses.push({ clientName: { $regex: targetStr, $options: 'i' } });
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
        cQueries.push({ clientName: { $regex: cName, $options: 'i' } });
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

module.exports = {
  isGstWorkCheck,
  getISTDateDetails,
  ensureDailyAbsentRecords,
  getTaskBadge,
  getNextTaskId,
  levenshteinDistance,
  sanitizeAlphaNumeric,
  findClientFuzzy,
  findTasksByAnyIdentifier
};
