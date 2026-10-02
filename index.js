import { Client, Databases, Users, ID, Query } from 'node-appwrite';

// ==================== CONFIG ====================
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID || '6ab2bdb4000c76cc3bef';

// Collection IDs (Aapke existing collections)
const COL = {
  ADMINS: 'admins',
  BETS: 'bets',
  CONFIG: 'config',
  GAME_HISTORY: 'game_history',
  GAME_ROUNDS: 'game_rounds',
  SETTING: 'setting',
  USERS: 'users',
  TRANSACTIONS: 'transactions',
  WINGO_ROUNDS: 'wingo_rounds'
};

// Admin emails
const ADMIN_EMAILS = [
  'admin@killwinapp.com',
  '9833381519@killwinapp.com'
];

// ==================== CLIENT ====================
function getClient() {
  return new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);
}
const getDb = () => new Databases(getClient());
const getUsers = () => new Users(getClient());

// ==================== MAIN HANDLER ====================
export default async ({ req, res, log, error }) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Appwrite-User-Id',
  };

  if (req.method === 'OPTIONS') return res.send('', 204, corsHeaders);

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.json({ error: 'Invalid JSON' }, 400, corsHeaders);
  }

  const { action, data = {} } = body;
  const userId = req.headers['x-appwrite-user-id'] || data.userId || null;

  log(`[${action}] userId=${userId}`);

  try {
    let result;
    switch (action) {
      // PROFILE
      case 'createProfile': result = await createProfile(userId, data, log); break;
      case 'getProfile': result = await getProfile(userId, log); break;

      // GAME ROUNDS
      case 'ensureGameRound': result = await ensureGameRound(data.gameId, log); break;
      case 'getWingoHistory': result = await getWingoHistory(log); break;

      // BETTING
      case 'placeGameBet': result = await placeGameBet(userId, data, log); break;

      // WALLET
      case 'submitDeposit': result = await submitDeposit(userId, data, log); break;
      case 'requestWithdrawal': result = await requestWithdrawal(userId, data, log); break;

      // CONFIG
      case 'getPlatformConfig': result = await getPlatformConfig(log); break;
      case 'setPlatformConfig': result = await setPlatformConfig(userId, data, log); break;

      // ADMIN
      case 'verifyAdmin': result = await verifyAdmin(userId, log); break;
      case 'adminListUsers': result = await adminListUsers(log); break;
      case 'adminListTransactions': result = await adminListTransactions(log); break;
      case 'adminAddMoney': result = await adminAddMoney(data, log); break;
      case 'approveTransaction': result = await approveTransaction(data, log); break;
      case 'setAdminControl': result = await setAdminControl(data, log); break;

      default:
        return res.json({ error: `Unknown action: ${action}` }, 400, corsHeaders);
    }
    return res.json({ data: result }, 200, corsHeaders);
  } catch (err) {
    error(`[${action}] ${err.message}`);
    return res.json({ error: err.message }, 500, corsHeaders);
  }
};

// ==================== PROFILE ====================
async function createProfile(userId, data, log) {
  if (!userId) throw new Error('User ID required');
  const db = getDb();
  const { username, phone } = data;

  // Check existing
  const existing = await db.listDocuments(DATABASE_ID, COL.USERS, [
    Query.equal('uid', userId), Query.limit(1)
  ]);

  if (existing.documents.length > 0) {
    return formatUser(existing.documents[0]);
  }

  const doc = await db.createDocument(DATABASE_ID, COL.USERS, ID.unique(), {
    uid: userId,
    username: username || 'Gamer',
    name: username || 'Gamer',
    phone: phone || '',
    balance: 0,
    depositBalance: 0,
    winningBalance: 0,
    status: 'active',
    upi_id: '',
    createdAt: new Date().toISOString()
  });

  return formatUser(doc);
}

async function getProfile(userId, log) {
  if (!userId) throw new Error('Not authenticated');
  const db = getDb();

  const result = await db.listDocuments(DATABASE_ID, COL.USERS, [
    Query.equal('uid', userId), Query.limit(1)
  ]);

  if (result.documents.length === 0) {
    return await createProfile(userId, { username: 'Gamer' }, log);
  }
  return formatUser(result.documents[0]);
}

function formatUser(doc) {
  return {
    uid: doc.uid,
    username: doc.username || doc.name || 'Gamer',
    phone: doc.phone || '',
    balance: Number(doc.balance || 0),
    depositBalance: Number(doc.depositBalance || 0),
    winningBalance: Number(doc.winningBalance || 0),
    createdAt: doc.createdAt || doc.$createdAt,
    joinDate: doc.createdAt || doc.$createdAt
  };
}

// ==================== GAME ROUNDS ====================
async function ensureGameRound(gameId, log) {
  const db = getDb();
  const durations = { wingo: 30, tiger: 30, number100: 300 };
  const duration = durations[gameId] || 30;
  const now = Date.now();
  const periodNumber = Math.floor(now / (duration * 1000));
  const period = `${gameId}_${new Date(periodNumber * duration * 1000).toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
  const startAtMs = periodNumber * duration * 1000;
  const endAtMs = startAtMs + duration * 1000;

  try {
    const existing = await db.listDocuments(DATABASE_ID, COL.GAME_ROUNDS, [
      Query.equal('game_id', gameId),
      Query.equal('period', period),
      Query.limit(1)
    ]);

    if (existing.documents.length > 0) {
      const r = existing.documents[0];
      return {
        gameId, period: r.period,
        startAtMs: Number(r.start_at_ms || startAtMs),
        endAtMs: Number(r.end_at_ms || endAtMs),
        serverNowMs: now,
        status: r.status || 'active'
      };
    }
  } catch (e) { log(`Round fetch: ${e.message}`); }

  try {
    await db.createDocument(DATABASE_ID, COL.GAME_ROUNDS, ID.unique(), {
      game_id: gameId,
      period,
      start_at_ms: startAtMs,
      end_at_ms: endAtMs,
      status: 'active',
      result: '',
      color: '',
      size: '',
      result_json: '',
      settled_at: null
    });
  } catch (e) { log(`Round create: ${e.message}`); }

  return { gameId, period, startAtMs, endAtMs, serverNowMs: now, status: 'active' };
}

async function getWingoHistory(log) {
  const db = getDb();
  try {
    const result = await db.listDocuments(DATABASE_ID, COL.WINGO_ROUNDS, [
      Query.orderDesc('$createdAt'),
      Query.limit(20)
    ]);

    const history = result.documents.map(d => ({
      period: d.period,
      number: Number(d.number || 0),
      color: d.color || 'green',
      size: d.size || 'small',
      winner: d.winner || '',
      timestamp: d.$createdAt
    }));

    return { history };
  } catch (e) {
    log(`History error: ${e.message}`);
    return { history: [] };
  }
}

// ==================== BETTING ====================
async function placeGameBet(userId, data, log) {
  if (!userId) throw new Error('Login required');
  const db = getDb();
  const { gameId, selection, category, amount } = data;

  if (!gameId || !selection || !amount || amount <= 0) throw new Error('Invalid bet');

  const profiles = await db.listDocuments(DATABASE_ID, COL.USERS, [
    Query.equal('uid', userId), Query.limit(1)
  ]);

  if (profiles.documents.length === 0) throw new Error('Profile not found');
  const p = profiles.documents[0];
  const balance = Number(p.balance || 0);
  if (balance < amount) throw new Error('Insufficient balance');

  // Deduct
  await db.updateDocument(DATABASE_ID, COL.USERS, p.$id, { balance: balance - amount });

  // Get round
  const round = await ensureGameRound(gameId, log);

  // Save bet
  await db.createDocument(DATABASE_ID, COL.BETS, ID.unique(), {
    userId,
    gameId,
    period: round.period,
    selection: String(selection),
    category: category || 'Color',
    amount: Number(amount),
    payout: 0,
    status: 'pending',
    resultJson: '',
    settledAt: null
  });

  return {
    success: true,
    newBalance: balance - amount,
    period: round.period,
    message: `Bet ₹${amount} on ${selection}`
  };
}

// ==================== WALLET ====================
async function submitDeposit(userId, data, log) {
  if (!userId) throw new Error('Login required');
  const db = getDb();
  const { amount, utr } = data;
  if (!amount || amount <= 0) throw new Error('Invalid amount');
  if (!utr) throw new Error('UTR required');

  const profiles = await db.listDocuments(DATABASE_ID, COL.USERS, [
    Query.equal('uid', userId), Query.limit(1)
  ]);
  if (profiles.documents.length === 0) throw new Error('Profile not found');
  const p = profiles.documents[0];

  await db.createDocument(DATABASE_ID, COL.TRANSACTIONS, ID.unique(), {
    user_id: userId,
    userId,
    username: p.username || p.name || 'Gamer',
    type: 'Deposit',
    amount: Number(amount),
    utr,
    details: `UTR: ${utr}`,
    status: 'Pending',
    timestamp: new Date().toLocaleString('en-IN')
  });

  return { success: true, message: 'Deposit submitted' };
}

async function requestWithdrawal(userId, data, log) {
  if (!userId) throw new Error('Login required');
  const db = getDb();
  const { amount, method, details } = data;
  if (!amount || amount <= 0) throw new Error('Invalid amount');

  const profiles = await db.listDocuments(DATABASE_ID, COL.USERS, [
    Query.equal('uid', userId), Query.limit(1)
  ]);
  if (profiles.documents.length === 0) throw new Error('Profile not found');
  const p = profiles.documents[0];
  if (Number(p.balance) < amount) throw new Error('Insufficient balance');

  await db.updateDocument(DATABASE_ID, COL.USERS, p.$id, {
    balance: Number(p.balance) - Number(amount)
  });

  await db.createDocument(DATABASE_ID, COL.TRANSACTIONS, ID.unique(), {
    user_id: userId,
    userId,
    username: p.username || p.name || 'Gamer',
    type: 'Withdraw',
    amount: Number(amount),
    details: `${method}: ${details}`,
    status: 'Pending',
    timestamp: new Date().toLocaleString('en-IN')
  });

  return { success: true, message: 'Withdrawal requested' };
}

// ==================== CONFIG ====================
async function getPlatformConfig(log) {
  const db = getDb();
  try {
    const result = await db.listDocuments(DATABASE_ID, COL.CONFIG, [Query.limit(1)]);
    if (result.documents.length === 0) {
      return {
        upiId: '9833381519@ptyes',
        qrImgUrl: 'https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=upi://pay?pa=9833381519@ptyes'
      };
    }
    const c = result.documents[0];
    return {
      upiId: c.upiId || '9833381519@ptyes',
      qrImgUrl: c.qrImgUrl || ''
    };
  } catch (e) {
    log(`Config error: ${e.message}`);
    return { upiId: '9833381519@ptyes', qrImgUrl: '' };
  }
}

async function setPlatformConfig(userId, data, log) {
  const db = getDb();
  const { upiId, qrImgUrl } = data;
  const result = await db.listDocuments(DATABASE_ID, COL.CONFIG, [Query.limit(1)]);

  if (result.documents.length === 0) {
    await db.createDocument(DATABASE_ID, COL.CONFIG, ID.unique(), {
      upiId: upiId || '',
      qrImgUrl: qrImgUrl || '',
      key: 'platform',
      updatedBy: userId || 'admin',
      updatedAt: new Date().toISOString()
    });
  } else {
    await db.updateDocument(DATABASE_ID, COL.CONFIG, result.documents[0].$id, {
      upiId: upiId || '',
      qrImgUrl: qrImgUrl || '',
      updatedBy: userId || 'admin',
      updatedAt: new Date().toISOString()
    });
  }
  return { success: true };
}

// ==================== ADMIN ====================
async function verifyAdmin(userId, log) {
  if (!userId) return { isAdmin: false };
  const users = getUsers();
  try {
    const user = await users.get(userId);
    const isAdmin = ADMIN_EMAILS.includes(user.email);
    return { isAdmin, email: user.email };
  } catch (e) {
    log(`verifyAdmin: ${e.message}`);
    return { isAdmin: false };
  }
}

async function adminListUsers(log) {
  const db = getDb();
  const result = await db.listDocuments(DATABASE_ID, COL.USERS, [
    Query.orderDesc('$createdAt'), Query.limit(100)
  ]);
  const users = result.documents.map(formatUser);
  return { users };
}

async function adminListTransactions(log) {
  const db = getDb();
  const result = await db.listDocuments(DATABASE_ID, COL.TRANSACTIONS, [
    Query.orderDesc('$createdAt'), Query.limit(100)
  ]);
  const transactions = result.documents.map(t => ({
    id: t.$id,
    userId: t.userId || t.user_id,
    username: t.username,
    type: t.type,
    amount: Number(t.amount || 0),
    details: t.details || t.utr || '',
    status: t.status,
    timestamp: t.timestamp || t.$createdAt
  }));
  return { transactions };
}

async function adminAddMoney(data, log) {
  const db = getDb();
  const { userQuery, amount } = data;
  if (!userQuery || !amount || amount <= 0) throw new Error('Invalid data');

  const profiles = await db.listDocuments(DATABASE_ID, COL.USERS, [
    Query.or([
      Query.equal('phone', userQuery),
      Query.equal('uid', userQuery)
    ]), Query.limit(1)
  ]);

  if (profiles.documents.length === 0) throw new Error('User not found');
  const p = profiles.documents[0];

  await db.updateDocument(DATABASE_ID, COL.USERS, p.$id, {
    balance: Number(p.balance || 0) + Number(amount),
    depositBalance: Number(p.depositBalance || 0) + Number(amount)
  });

  await db.createDocument(DATABASE_ID, COL.TRANSACTIONS, ID.unique(), {
    user_id: p.uid,
    userId: p.uid,
    username: p.username,
    type: 'AdminAdd',
    amount: Number(amount),
    details: 'Admin added money',
    status: 'Completed',
    timestamp: new Date().toLocaleString('en-IN')
  });

  return { success: true };
}

async function approveTransaction(data, log) {
  const db = getDb();
  const { txId, decision } = data;
  if (!txId) throw new Error('txId required');

  const tx = await db.getDocument(DATABASE_ID, COL.TRANSACTIONS, txId);
  if (tx.status !== 'Pending') throw new Error('Already processed');

  if (decision === 'approve') {
    if (tx.type === 'Deposit') {
      const profiles = await db.listDocuments(DATABASE_ID, COL.USERS, [
        Query.equal('uid', tx.userId || tx.user_id), Query.limit(1)
      ]);
      if (profiles.documents.length > 0) {
        const p = profiles.documents[0];
        await db.updateDocument(DATABASE_ID, COL.USERS, p.$id, {
          balance: Number(p.balance || 0) + Number(tx.amount),
          depositBalance: Number(p.depositBalance || 0) + Number(tx.amount)
        });
      }
    }
    await db.updateDocument(DATABASE_ID, COL.TRANSACTIONS, txId, { status: 'Approved' });
  } else {
    if (tx.type === 'Withdraw') {
      const profiles = await db.listDocuments(DATABASE_ID, COL.USERS, [
        Query.equal('uid', tx.userId || tx.user_id), Query.limit(1)
      ]);
      if (profiles.documents.length > 0) {
        const p = profiles.documents[0];
        await db.updateDocument(DATABASE_ID, COL.USERS, p.$id, {
          balance: Number(p.balance || 0) + Number(tx.amount)
        });
      }
    }
    await db.updateDocument(DATABASE_ID, COL.TRANSACTIONS, txId, { status: 'Rejected' });
  }
  return { success: true };
}

async function setAdminControl(data, log) {
  const db = getDb();
  const { controls } = data;

  const result = await db.listDocuments(DATABASE_ID, COL.SETTING, [
    Query.equal('key', 'admin_controls'), Query.limit(1)
  ]);

  const value = JSON.stringify({
    wingo: controls.wingo || 'auto',
    tiger: controls.tiger || 'auto',
    number100: controls.number100 !== undefined ? controls.number100 : 'auto',
    updatedAt: new Date().toISOString()
  });

  if (result.documents.length === 0) {
    await db.createDocument(DATABASE_ID, COL.SETTING, ID.unique(), {
      key: 'admin_controls', value
    });
  } else {
    await db.updateDocument(DATABASE_ID, COL.SETTING, result.documents[0].$id, { value });
  }
  return { success: true };
}
