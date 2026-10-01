const PROJECT_ID = process.env.APPWRITE_FUNCTION_PROJECT_ID || '6ab2b71c00171587d4fc';
const DATABASE_ID = process.env.APPWRITE_DATABASE_ID || '6ab2bdb4000c76cc3bef';
const ENDPOINT = process.env.APPWRITE_ENDPOINT || 'https://cloud.appwrite.io/v1';

const TABLES = {
  users: process.env.USERS_TABLE_ID || '6ab2bf1d0025b9c53f38',
  admins: process.env.ADMINS_TABLE_ID || '6ab34851002ce1959b05',
  config: process.env.CONFIG_TABLE_ID || '6ab348cb001698034464',
  game_rounds: process.env.GAME_ROUNDS_TABLE_ID || '6ab349bd001c6378143a',
  transactions: process.env.TRANSACTIONS_TABLE_ID || 'transactions',
  bets: process.env.BETS_TABLE_ID || '6ab34ddf001d569d3f06'
};

const FEE = 0.02;
const GAME_RULES = {
  wingo: { seconds: 30 },
  tiger: { seconds: 30 },
  number100: { seconds: 300 }
};

function nowMs() { return Date.now(); }
function money(n) { return Math.round(Number(n || 0) * 100) / 100; }

function uidFrom(ctx) {
  const h = ctx?.req?.headers || {};
  return h['x-appwrite-user-id'] || h['X-Appwrite-User-Id'] ||
         process.env.APPWRITE_FUNCTION_USER_ID || '';
}

function keyFrom(ctx) {
  const h = ctx?.req?.headers || {};
  return h['x-appwrite-key'] || h['X-Appwrite-Key'] ||
         process.env.APPWRITE_FUNCTION_API_KEY || '';
}

function enc(s) { return encodeURIComponent(String(s)); }

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededInt(period, max) {
  const rand = mulberry32(hashString(String(period)));
  return Math.floor(rand() * max);
}

function seededChoice(period, arr) {
  return arr[seededInt(period, arr.length)];
}

function randomId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 11);
}

async function api(ctx, method, path, body) {
  const key = keyFrom(ctx);
  if (!key) throw new Error('Appwrite API key missing. Add APPWRITE_FUNCTION_API_KEY to the Function.');

  const headers = {
    'X-Appwrite-Project': PROJECT_ID,
    'X-Appwrite-Key': key,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };

  const res = await fetch(`${ENDPOINT}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch (_) { data = { message: text }; }

  if (!res.ok) {
    const err = new Error(data.message || data.error || `Appwrite API ${res.status}`);
    err.status = res.status;
    err.response = data;
    throw err;
  }
  return data;
}

async function getRow(ctx, tableId, rowId) {
  return api(ctx, 'GET',
    `/tablesdb/${enc(DATABASE_ID)}/tables/${enc(tableId)}/rows/${enc(rowId)}`);
}

async function updateRow(ctx, tableId, rowId, data) {
  return api(ctx, 'PATCH',
    `/tablesdb/${enc(DATABASE_ID)}/tables/${enc(tableId)}/rows/${enc(rowId)}/`,
    { data });
}

async function createRow(ctx, tableId, data, rowId) {
  return api(ctx, 'POST',
    `/tablesdb/${enc(DATABASE_ID)}/tables/${enc(tableId)}/rows`,
    { rowId: rowId || 'unique()', data });
}

async function upsertRow(ctx, tableId, rowId, data) {
  try {
    return await updateRow(ctx, tableId, rowId, data);
  } catch (e) {
    if (e.status !== 404) throw e;
    return createRow(ctx, tableId, data, rowId);
  }
}

async function listRows(ctx, tableId, limit = 100, offset = 0) {
  const result = await api(
    ctx, 'GET',
    `/tablesdb/${enc(DATABASE_ID)}/tables/${enc(tableId)}/rows?limit=${limit}&offset=${offset}`
  );
  return { ...result, rows: Array.isArray(result.rows) ? result.rows : [] };
}

async function listAllRows(ctx, tableId, pageSize = 100, maxPages = 100) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const list = await listRows(ctx, tableId, pageSize, page * pageSize);
    const rows = list.rows || [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

async function safeGetRow(ctx, tableId, rowId) {
  try { return await getRow(ctx, tableId, rowId); }
  catch (e) { if (e.status === 404) return null; throw e; }
}

async function safeUpdateRow(ctx, tableId, rowId, data) {
  try { return await updateRow(ctx, tableId, rowId, data); }
  catch (e) {
    if (e.status === 404) return upsertRow(ctx, tableId, rowId, data);
    throw e;
  }
}

function periodInfo(game_id, t = nowMs()) {
  const seconds = GAME_RULES[game_id]?.seconds || 30;
  const size = seconds * 1000;
  const start = Math.floor(t / size) * size;
  const end = start + size;
  const d = new Date(start);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const period = `${y}${mo}${day}${hh}${mm}${ss}`;
  return { game_id, period, startAtMs: start, endAtMs: end };
}

function colorForNumber(n) {
  if (n === 0 || n === 5) return 'violet';
  return n % 2 === 0 ? 'red' : 'green';
}

function sizeForNumber(n) { return n >= 5 ? 'Big' : 'Small'; }

function generateOutcome(game_id, period) {
  if (game_id === 'wingo') {
    const number = seededInt(period, 10);
    return { number, color: colorForNumber(number), size: sizeForNumber(number) };
  }
  if (game_id === 'tiger') {
    return { winner: seededChoice(period, ['Tiger', 'Lion', 'Tie']) };
  }
  if (game_id === 'number100') {
    return { number: seededInt(period, 101) };
  }
  throw new Error('Unsupported game');
}

function payoutMultiplier(game_id, selection, category) {
  if (game_id === 'wingo') {
    if (category === 'Color') return selection === 'violet' ? 4.5 : 2;
    if (category === 'Size') return 2;
    if (category === 'Number') return 9;
  }
  if (game_id === 'tiger') {
    if (selection === 'Tie') return 8;
    return 2;
  }
  if (game_id === 'number100') return 30;
  return 0;
}

function isWinningBet(game_id, bet, outcome) {
  if (game_id === 'wingo') {
    if (bet.category === 'Color')
      return String(bet.selection).toLowerCase() === outcome.color;
    if (bet.category === 'Size')
      return String(bet.selection).toLowerCase() === String(outcome.size).toLowerCase();
    if (bet.category === 'Number')
      return Number(bet.selection) === Number(outcome.number);
  }
  if (game_id === 'tiger')
    return String(bet.selection).toLowerCase() === String(outcome.winner).toLowerCase();
  if (game_id === 'number100')
    return Number(bet.selection) === Number(outcome.number);
  return false;
}

function parseResult(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) { return null; }
}

async function requireUser(ctx) {
  const uid = uidFrom(ctx);
  if (!uid) throw new Error('Login required.');
  return uid;
}

async function getUser(ctx, uid) {
  const row = await safeGetRow(ctx, TABLES.users, uid);
  if (!row) throw new Error('User profile not found.');
  return row;
}

function profileResponse(row) {
  return {
    id: row.$id,
    uid: row.uid || row.$id,
    username: row.username || 'Gamer',
    phone: row.phone || '',
    balance: Number(row.balance || 0),
    depositBalance: Number(row.deposit_balance || row.depositBalance || 0),
    winningBalance: Number(row.winning_balance || row.winningBalance || 0),
    createdAt: row.created_at || row.createdAt || row.$createdAt
  };
}

async function requireAdmin(ctx) {
  const uid = await requireUser(ctx);
  const direct = await safeGetRow(ctx, TABLES.admins, uid);
  if (direct && String(direct.role || 'admin').toLowerCase() === 'admin') return uid;

  const list = await listRows(ctx, TABLES.admins, 100);
  const ok = (list.rows || []).some(r =>
    String(r.user_id || r.uid || r.userId || r.$id || '') === uid &&
    String(r.role || 'admin').toLowerCase() === 'admin'
  );
  if (!ok) throw new Error('Admin verification failed.');
  return uid;
}

async function actionCreateProfile(ctx, data) {
  const uid = await requireUser(ctx);
  const existing = await safeGetRow(ctx, TABLES.users, uid);
  if (existing) return profileResponse(existing);

  const username = String(data.username || 'Gamer').trim().slice(0, 80);
  const phone = String(data.phone || '').trim().slice(0, 40);

  const row = await upsertRow(ctx, TABLES.users, uid, {
    uid, username, phone,
    balance: 0,
    deposit_balance: 0,
    winning_balance: 0,
    created_at: new Date().toISOString()
  });
  return profileResponse(row);
}

async function actionGetProfile(ctx) {
  const uid = await requireUser(ctx);
  return profileResponse(await getUser(ctx, uid));
}

async function actionGetPlatformConfig(ctx) {
  const row = await safeGetRow(ctx, TABLES.config, 'platform');
  return row ? {
    upiId: row.upi_id || row.upiId || '',
    qrImgUrl: row.qr_img_url || row.qrImgUrl || ''
  } : { upiId: '', qrImgUrl: '' };
}

async function actionSetPlatformConfig(ctx, data) {
  await requireAdmin(ctx);
  const payload = {};
  if (data.upiId !== undefined) payload.upi_id = String(data.upiId || '').trim();
  if (data.qrImgUrl !== undefined) payload.qr_img_url = String(data.qrImgUrl || '').trim();
  if (!Object.keys(payload).length) return { ok: true };
  const row = await safeUpdateRow(ctx, TABLES.config, 'platform', payload);
  return { ok: true, config: {
    upiId: row.upi_id || row.upiId || '',
    qrImgUrl: row.qr_img_url || row.qrImgUrl || ''
  }};
}

async function actionEnsureGameRound(ctx, data) {
  const game_id = String(data.game_id || data.gameId || '').trim();
  if (!GAME_RULES[game_id]) throw new Error('Unsupported game_id.');

  const current = periodInfo(game_id);
  const currentId = `${game_id}_${current.period}`;

  let round = await safeGetRow(ctx, TABLES.game_rounds, currentId);
  if (!round) {
    const outcome = generateOutcome(game_id, current.period);
    round = await upsertRow(ctx, TABLES.game_rounds, currentId, {
      game_id,
      period: current.period,
      start_at_ms: current.startAtMs,
      end_at_ms: current.endAtMs,
      status: 'open',
      result_json: JSON.stringify(outcome)
    });
  }

  const prev = periodInfo(game_id, current.startAtMs - 1);
  if (prev.endAtMs <= nowMs()) {
    try { await settleRoundInternal(ctx, game_id, prev.period); } catch (_) {}
  }

  return {
    game_id,
    period: current.period,
    startAtMs: current.startAtMs,
    endAtMs: current.endAtMs,
    serverNowMs: nowMs()
  };
}

async function actionPlaceGameBet(ctx, data) {
  const uid = await requireUser(ctx);
  const game_id = String(data.game_id || data.gameId || '');
  if (!GAME_RULES[game_id]) throw new Error('Unsupported game_id.');

  const amount = money(data.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000)
    throw new Error('Invalid bet amount.');

  const selection = String(data.selection ?? '').trim();
  const category = String(data.category || '').trim();
  if (!selection) throw new Error('Selection required.');

  const multiplier = payoutMultiplier(game_id, selection, category);
  if (!multiplier) throw new Error('Invalid selection/category.');

  const round = periodInfo(game_id);
  if (nowMs() >= round.endAtMs - 5000)
    throw new Error('Betting is closed for this round.');

  const user = await getUser(ctx, uid);
  const balance = money(user.balance);
  if (balance < amount) throw new Error('Insufficient balance.');

  const betId = `bet_${randomId()}`;
  const updatedBalance = money(balance - amount);

  await updateRow(ctx, TABLES.users, uid, { balance: updatedBalance });

  const bet = await createRow(ctx, TABLES.bets, {
    bet_id: betId,
    user_id: uid,
    userId: uid, 
    game_id,
    gameId: game_id,
    period: round.period,
    selection,
    category,
    amount,
    multiplier,
    status: 'open',
    payout: 0,
    created_at: new Date().toISOString(),
    createdAt: new Date().toISOString()
  }, betId);

  return { betId, period: round.period, balance: updatedBalance, bet };
}

async function settleRoundInternal(ctx, game_id, period) {
  const roundId = `${game_id}_${period}`;
  const round = await safeGetRow(ctx, TABLES.game_rounds, roundId);
  if (!round) return { settled: false, reason: 'round_not_found' };

  if (round.status === 'settled') {
    return { settled: true, period, ...parseResult(round.result_json), settledBets: [] };
  }

  if (Number(round.end_at_ms) > nowMs())
    return { settled: false, reason: 'round_still_open' };

  try {
    await updateRow(ctx, TABLES.game_rounds, roundId, { status: 'settling' });
  } catch (e) {
    const latest = await safeGetRow(ctx, TABLES.game_rounds, roundId);
    if (latest?.status === 'settled') {
      return { settled: true, period, ...parseResult(latest.result_json), settledBets: [] };
    }
    return { settled: false, reason: 'settlement_in_progress' };
  }

  const outcome = parseResult(round.result_json) || generateOutcome(game_id, period);
  const all = await listAllRows(ctx, TABLES.bets);
  const bets = all.filter(b =>
    b.game_id === game_id &&
    b.period === period &&
    b.status === 'open'
  );

  const settledBets = [];

  for (const bet of bets) {
    const win = isWinningBet(game_id, bet, outcome);
    const gross = win ? money(Number(bet.amount) * Number(bet.multiplier || 0)) : 0;
    const payout = win ? money(gross * (1 - FEE)) : 0;

    const user = await getUser(ctx, bet.user_id || bet.userId);
    const newBalance = money(Number(user.balance || 0) + payout);

    await updateRow(ctx, TABLES.users, bet.user_id || bet.userId, {
      balance: newBalance,
      winning_balance: money(Number(user.winning_balance || user.winningBalance || 0) + payout)
    });

    await updateRow(ctx, TABLES.bets, bet.$id, {
      status: win ? 'won' : 'lost',
      payout,
      settled_at: new Date().toISOString()
    });

    settledBets.push({
      ...bet,
      status: win ? 'won' : 'lost',
      payout
    });
  }

  await updateRow(ctx, TABLES.game_rounds, roundId, {
    status: 'settled',
    result_json: JSON.stringify(outcome),
    settled_at: new Date().toISOString(),
    result: String(outcome.number ?? outcome.winner ?? ''),
    color: outcome.color || '',
    size: outcome.size || ''
  });

  return { settled: true, period, ...outcome, settledBets };
}

async function actionSettleGameRound(ctx, data) {
  const game_id = String(data.game_id || data.gameId || '');
  const period = String(data.period || '');
  if (!GAME_RULES[game_id] || !period)
    throw new Error('game_id and period are required.');
  return settleRoundInternal(ctx, game_id, period);
}

async function actionGetWingoHistory(ctx) {
  const list = await listRows(ctx, TABLES.game_rounds, 100);
  const history = (list.rows || [])
    .filter(x => (x.game_id || x.gameId) === 'wingo' && x.status === 'settled')
    .sort((a, b) => String(b.period).localeCompare(String(a.period)))
    .slice(0, 50)
    .map(x => {
      const r = parseResult(x.result_json || x.resultJson) || {};
      return {
        period: x.period,
        number: Number(r.number),
        color: r.color || '',
        size: r.size || ''
      };
    });
  return { history };
}

async function actionSubmitDeposit(ctx, data) {
  const uid = await requireUser(ctx);
  const amount = money(data.amount);
  const utr = String(data.utr || '').trim().slice(0, 100);

  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000 || !utr)
    throw new Error('Invalid deposit request.');

  const user = await getUser(ctx, uid);
  const txId = `tx_${randomId()}`;

  return createRow(ctx, TABLES.transactions, {
    tx_id: txId,
    user_id: uid,
    userId: uid,
    username: user.username || 'Gamer',
    type: 'Deposit',
    amount,
    details: `UTR: ${utr}`,
    status: 'Pending',
    timestamp: new Date().toISOString()
  }, txId);
}

async function actionRequestWithdrawal(ctx, data) {
  const uid = await requireUser(ctx);
  const amount = money(data.amount);
  const method = String(data.method || '').trim();
  const details = String(data.details || '').trim().slice(0, 500);

  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000 || !details)
    throw new Error('Invalid withdrawal request.');

  const user = await getUser(ctx, uid);
  if (money(user.balance) < amount) throw new Error('Insufficient balance.');

  const newBalance = money(Number(user.balance) - amount);
  await updateRow(ctx, TABLES.users, uid, { balance: newBalance });

  const txId = `tx_${randomId()}`;
  return createRow(ctx, TABLES.transactions, {
    tx_id: txId,
    user_id: uid,
    userId: uid,
    username: user.username || 'Gamer',
    type: 'Withdraw',
    amount,
    method,
    details,
    status: 'Pending',
    timestamp: new Date().toISOString()
  }, txId);
}

async function actionAdminListUsers(ctx) {
  await requireAdmin(ctx);
  const rows = await listAllRows(ctx, TABLES.users);
  return {
    users: rows.map(x => ({
      id: x.$id,
      uid: x.uid || x.$id,
      username: x.username || 'Gamer',
      phone: x.phone || '',
      balance: Number(x.balance || 0),
      depositBalance: Number(x.deposit_balance || x.depositBalance || 0),
      winningBalance: Number(x.winning_balance || x.winningBalance || 0)
    }))
  };
}

async function actionAdminAddMoney(ctx, data) {
  await requireAdmin(ctx);
  const amount = money(data.amount);
  const q = String(data.userQuery || '').trim();

  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000000 || !q)
    throw new Error('Invalid add-money request.');

  let target = await safeGetRow(ctx, TABLES.users, q);

  if (!target) {
    const needle = q.toLowerCase();
    const normPhone = v => String(v || '').replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
    const qPhone = normPhone(q);
    const pageSize = 100;

    for (let offset = 0; offset < 10000 && !target; offset += pageSize) {
      const list = await listRows(ctx, TABLES.users, pageSize, offset);
      const rows = list.rows || [];
      target = rows.find(u =>
        (qPhone && normPhone(u.phone) === qPhone) ||
        String(u.uid || '').trim() === q ||
        String(u.$id || '').trim() === q ||
        String(u.username || '').trim().toLowerCase() === needle
      );
      if (rows.length < pageSize) break;
    }
  }

  if (!target) throw new Error('User not found.');

  const newBalance = money(Number(target.balance || 0) + amount);
  return updateRow(ctx, TABLES.users, target.$id, {
    balance: newBalance,
    deposit_balance: money(Number(target.deposit_balance || target.depositBalance || 0) + amount)
  });
}

async function actionAdminListTransactions(ctx) {
  await requireAdmin(ctx);
  const list = await listRows(ctx, TABLES.transactions, 100);
  return {
    transactions: (list.rows || [])
      .sort((a, b) => String(b.timestamp || b.$createdAt || '').localeCompare(String(a.timestamp || a.$createdAt || '')))
      .map(x => ({
        id: x.$id,
        userId: x.user_id || x.userId,
        username: x.username,
        type: x.type,
        amount: Number(x.amount || 0),
        details: x.details || '',
        status: x.status || 'Pending',
        timestamp: x.timestamp || x.$createdAt
      }))
  };
}

async function actionApproveTransaction(ctx, data) {
  await requireAdmin(ctx);
  const txId = String(data.txId || '');
  if (!txId || data.decision !== 'approve')
    throw new Error('Only approve is supported.');

  const tx = await getRow(ctx, TABLES.transactions, txId);
  if (tx.status !== 'Pending') return tx;

  const user = await getUser(ctx, tx.user_id || tx.userId);

  if (tx.type === 'Deposit') {
    const amount = money(tx.amount);
    await updateRow(ctx, TABLES.users, tx.user_id || tx.userId, {
      balance: money(Number(user.balance || 0) + amount),
      deposit_balance: money(Number(user.deposit_balance || user.depositBalance || 0) + amount)
    });
  }

  return updateRow(ctx, TABLES.transactions, txId, {
    status: 'Approved',
    approved_at: new Date().toISOString()
  });
}

async function actionVerifyAdmin(ctx) {
  await requireAdmin(ctx);
  return { isAdmin: true, uid: uidFrom(ctx) };
}

async function actionSetAdminControl(ctx) {
  await requireAdmin(ctx);
  throw new Error('Admin game-control storage is not enabled in this backend package. Add an audited control table/schema before enabling it.');
}

const ACTIONS = {
  createProfile: actionCreateProfile,
  getProfile: actionGetProfile,
  getPlatformConfig: actionGetPlatformConfig,
  setPlatformConfig: actionSetPlatformConfig,
  ensureGameRound: actionEnsureGameRound,
  placeGameBet: actionPlaceGameBet,
  settleGameRound: actionSettleGameRound,
  getWingoHistory: actionGetWingoHistory,
  submitDeposit: actionSubmitDeposit,
  requestWithdrawal: actionRequestWithdrawal,
  adminListUsers: actionAdminListUsers,
  adminAddMoney: actionAdminAddMoney,
  adminListTransactions: actionAdminListTransactions,
  approveTransaction: actionApproveTransaction,
  verifyAdmin: actionVerifyAdmin,
  setAdminControl: actionSetAdminControl
};

function parseBody(req) {
  const raw = req?.body ?? req?.bodyText ?? '';
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); }
  catch (_) { throw new Error('Invalid JSON request body.'); }
}

async function main(ctx) {
  const body = parseBody(ctx.req);
  const action = String(body.action || '').trim();
  const data = body.data && typeof body.data === 'object' ? body.data : {};

  if (!action) throw new Error('Missing action.');
  const fn = ACTIONS[action];
  if (!fn) throw new Error(`Unknown action: ${action}`);

  return await fn(ctx, data);
}

module.exports = async (ctx) => {
  const res = ctx.res;
  try {
    const data = await main(ctx);
    return res.json({ ok: true, data });
  } catch (error) {
    const status = Number(error.status) >= 400 && Number(error.status) < 600
      ? Number(error.status) : 400;

    try {
      ctx.error?.(`${error.message}\n${error.stack || ''}`);
    } catch (_) {}

    return res.json({
      ok: false,
      error: error.message || 'Function error'
    }, status);
  }
};
