const { connectToDatabase } = require('./db');
const { verifyToken } = require('./auth');
const { handleDocChat } = require('../../lib/docChat');
const { ensureDailyAbsentRecords } = require('../../lib/chat/chatHelpers');
const { handleClientChat } = require('../../lib/chat/clientChat');
const { handleStaffAction } = require('../../lib/chat/staffActions');
const { handleGroqLlmChatTurn } = require('../../lib/chat/groqChat');
const { handlePatternChat } = require('../../lib/chat/patternChat');

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
      engine = 'groq'
    } = req.body || {};

    const query = String(message || '').trim();
    const { db } = await connectToDatabase();

    const tasksCol = db.collection('tasks');
    const clientsCol = db.collection('clients');
    const usersCol = db.collection('users');
    const attendanceCol = db.collection('attendance');
    const engagementsCol = db.collection('engagements');

    const isAdmin = decoded.role === 'partner';

    // Background attendance check initialization for today
    ensureDailyAbsentRecords(db).catch(() => {});

    // 1. Google Drive Document discovery and uploads for all roles
    const docReply = await handleDocChat({ db, decoded, query, action, body: req.body || {} });
    if (docReply) {
      return res.status(200).json(docReply);
    }

    // 2. Client Portal Chat Flow
    if (decoded.role === 'client') {
      const allEngagements = (await engagementsCol.find({}).toArray()).map(e => e.title);
      const allUsers = await usersCol.find({}).toArray();
      const clientReply = await handleClientChat({
        db,
        decoded,
        query,
        action,
        body: req.body || {},
        allEngagements,
        allUsers,
        tasksCol,
        clientsCol
      });
      return res.status(200).json(clientReply);
    }

    // Load master collections for staff / admin operations
    const allClients = await clientsCol.find({ status: { $ne: 'Inactive' } }).limit(500).toArray();
    const allUsers = await usersCol.find({}).toArray();
    const allEngagements = (await engagementsCol.find({}).toArray()).map(e => e.title);

    // 3. Explicit UI Actions (triggered by action chips / buttons)
    if (action) {
      const actionResult = await handleStaffAction({
        db,
        decoded,
        action,
        body: req.body || {},
        tasksCol,
        clientsCol,
        usersCol,
        attendanceCol,
        engagementsCol,
        allClients,
        allUsers,
        allEngagements,
        isAdmin
      });
      if (actionResult) {
        const statusCode = actionResult.status || 200;
        return res.status(statusCode).json(actionResult);
      }
    }

    // 4. Conversational Chat Engine (Groq AI with Fallback to Pattern Engine)
    if (engine !== 'pattern' && process.env.GROQ_API_KEY) {
      try {
        return await handleGroqLlmChatTurn(req, res, {
          db,
          decoded,
          isAdmin,
          allClients,
          allUsers,
          query,
          history
        });
      } catch (err) {
        console.error('Groq LLM Engine error (falling back to pattern):', err.message);
      }
    }

    // 5. Deterministic Pattern Engine
    const patternResult = await handlePatternChat({
      db,
      decoded,
      isAdmin,
      allClients,
      allUsers,
      allEngagements,
      query,
      context
    });

    return res.status(200).json(patternResult);
  } catch (err) {
    console.error('Chat endpoint error:', err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, message: 'Internal chat server error.' });
    }
    res.end();
  }
};
