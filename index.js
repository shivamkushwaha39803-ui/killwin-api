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

function nowMs() {
  return Date.now();
}

function money(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function enc(s) {
  return encodeURIComponent(String(s));
}

function uidFrom(ctx) {
  const h = ctx?.req?.headers || {};

  return (
    h['x-appwrite-user-id'] ||
    h['X-Appwrite-User-Id'] ||
    process.env.APPWRITE_FUNCTION_USER_ID ||
    ''
  );
}

function keyFrom(ctx) {
  const h = ctx?.req?.headers || {};

  return (
    h['x-appwrite-key'] ||
    h['X-Appwrite-Key'] ||
    process.env.APPWRITE_FUNCTION_API_KEY ||
    ''
  );
}

function randomId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 11);
}

/* =========================================================
   APPWRITE REST API
========================================================= */

async function api(ctx, method, path, body) {
  const key = keyFrom(ctx);

  if (!key) {
    throw new Error(
      'Appwrite API key missing. Add APPWRITE_FUNCTION_API_KEY to the Function.'
    );
  }

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

  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { message: text };
  }

  if (!res.ok) {
    const e = new Error(
      data.message ||
      data.error ||
      `Appwrite API ${res.status}`
    );

    e.status = res.status;
    e.response = data;

    throw e;
  }

  return data;
}

async function getRow(ctx, table, rowId) {
  return api(
    ctx,
    'GET',
    `/tablesdb/${enc(DATABASE_ID)}/tables/${enc(table)}/rows/${enc(rowId)}`
  );
}

async function updateRow(ctx, table, rowId, data) {
  return api(
    ctx,
    'PATCH',
    `/tablesdb/${enc(DATABASE_ID)}/tables/${enc(table)}/rows/${enc(rowId)}/`,
    { data }
  );
}

async function createRow(ctx, table, data, rowId) {
  return api(
    ctx,
    'POST',
    `/tablesdb/${enc(DATABASE_ID)}/tables/${enc(table)}/rows`,
    {
      rowId: rowId || 'unique()',
      data
    }
  );
}

async function upsertRow(ctx, table, rowId, data) {
  try {
    return await updateRow(ctx, table, rowId, data);
  } catch (e) {
    if (e.status !== 404) throw e;
    return createRow(ctx, table, data, rowId);
  }
}

async function listRows(ctx, table, limit = 100, offset = 0) {
  const r = await api(
    ctx,
    'GET',
    `/tablesdb/${enc(DATABASE_ID)}/tables/${enc(table)}/rows?limit=${limit}&offset=${offset}`
  );

  return {
    ...r,
    rows: Array.isArray(r.rows) ? r.rows : []
  };
}

async function listAllRows(ctx, table, pageSize = 100, maxPages = 100) {
  const out = [];

  for (let p = 0; p < maxPages; p++) {
    const r = await listRows(
      ctx,
      table,
      pageSize,
      p * pageSize
    );

    out.push(...r.rows);

    if (r.rows.length < pageSize) {
      break;
    }
  }

  return out;
}

async function safeGetRow(ctx, table, rowId) {
  try {
    return await getRow(ctx, table, rowId);
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function safeUpdateRow(ctx, table, rowId, data) {
  try {
    return await updateRow(ctx, table, rowId, data);
  } catch (e) {
    if (e.status === 404) {
      return createRow(ctx, table, data, rowId);
    }

    throw e;
  }
}

/* =========================================================
   SERVER-SIDE DETERMINISTIC RESULT
========================================================= */

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

function seededInt(seed, max) {
  return Math.floor(
    mulberry32(hashString(String(seed)))() * max
  );
}

function seededChoice(seed, arr) {
  return arr[seededInt(seed, arr.length)];
}

/* =========================================================
   ROUND / PERIOD
========================================================= */

function periodInfo(gameId, t = nowMs()) {
  const seconds = GAME_RULES[gameId]?.seconds || 30;

  const size = seconds * 1000;

  const start = Math.floor(t / size) * size;

  const end = start + size;

  const d = new Date(start);

  const period =
    `${d.getUTCFullYear()}` +
    `${String(d.getUTCMonth() + 1).padStart(2, '0')}` +
    `${String(d.getUTCDate()).padStart(2, '0')}` +
    `${String(d.getUTCHours()).padStart(2, '0')}` +
    `${String(d.getUTCMinutes()).padStart(2, '0')}` +
    `${String(d.getUTCSeconds()).padStart(2, '0')}`;

  return {
    game_id: gameId,
    period,
    startAtMs: start,
    endAtMs: end
  };
}

/* =========================================================
   WIN GO RESULT
========================================================= */

function colorForNumber(n) {
  if (n === 0 || n === 5) {
    return 'violet';
  }

  return n % 2 === 0 ? 'red' : 'green';
}

function sizeForNumber(n) {
  return n >= 5 ? 'Big' : 'Small';
}

function generateOutcome(gameId, period) {
  if (gameId === 'wingo') {
    const number = seededInt(period, 10);

    return {
      number,
      color: colorForNumber(number),
      size: sizeForNumber(number)
    };
  }

  if (gameId === 'tiger') {
    return {
      winner: seededChoice(
        period,
        ['Tiger', 'Lion', 'Tie']
      )
    };
  }

  if (gameId === 'number100') {
    return {
      number: seededInt(period, 101)
    };
  }

  throw new Error('Unsupported game');
}

/* =========================================================
   PAYOUT
========================================================= */

function payoutMultiplier(gameId, selection, category) {
  if (gameId === 'wingo') {

    if (category === 'Color') {
      return String(selection).toLowerCase() === 'violet'
        ? 4.5
        : 2;
    }

    if (category === 'Size') {
      return 2;
    }

    if (category === 'Number') {
      return 9;
    }
  }

  if (gameId === 'tiger') {
    return String(selection).toLowerCase() === 'tie'
      ? 8
      : 2;
  }

  if (gameId === 'number100') {
    return 30;
  }

  return 0;
}

function isWinningBet(gameId, bet, outcome) {

  if (gameId === 'wingo') {

    if (bet.category === 'Color') {
      return (
        String(bet.selection).toLowerCase() ===
        String(outcome.color).toLowerCase()
      );
    }

    if (bet.category === 'Size') {
      return (
        String(bet.selection).toLowerCase() ===
        String(outcome.size).toLowerCase()
      );
    }

    if (bet.category === 'Number') {
      return (
        Number(bet.selection) ===
        Number(outcome.number)
      );
    }
  }

  if (gameId === 'tiger') {
    return (
      String(bet.selection).toLowerCase() ===
      String(outcome.winner).toLowerCase()
    );
  }

  if (gameId === 'number100') {
    return (
      Number(bet.selection) ===
      Number(outcome.number)
    );
  }

  return false;
}

function parseResult(v) {
  if (!v) return null;

  if (typeof v === 'object') {
    return v;
  }

  try {
    const x = JSON.parse(String(v));

    return x && typeof x === 'object'
      ? x
      : null;
  } catch (_) {
    return null;
  }
}

/* =========================================================
   USER / ADMIN
========================================================= */

async function requireUser(ctx) {
  const uid = uidFrom(ctx);

  if (!uid) {
    throw new Error('Login required.');
  }

  return uid;
}

async function getUser(ctx, uid) {
  const row = await safeGetRow(
    ctx,
    TABLES.users,
    uid
  );

  if (!row) {
    throw new Error('User profile not found.');
  }

  return row;
}

function profileResponse(row) {
  return {
    id: row.$id,
    uid: row.uid || row.$id,

    username:
      row.username ||
      row.name ||
      'Gamer',

    name:
      row.name ||
      row.username ||
      'Gamer',

    phone: row.phone || '',

    balance: Number(row.balance || 0),

    depositBalance:
      Number(row.depositBalance || 0),

    winningBalance:
      Number(row.winningBalance || 0),

    createdAt:
      row.createdAt ||
      row.$createdAt
  };
}

async function requireAdmin(ctx) {
  const uid = await requireUser(ctx);

  const direct = await safeGetRow(
    ctx,
    TABLES.admins,
    uid
  );

  if (
    direct &&
    String(direct.role || 'admin')
      .trim()
      .toLowerCase() === 'admin' &&
    String(
      direct.userId ??
      direct.user_id ??
      direct.uid ??
      direct.$id ??
      ''
    ).trim() === uid
  ) {
    return uid;
  }

  const rows = await listAllRows(
    ctx,
    TABLES.admins
  );

  const ok = rows.some(r =>
    String(
      r.userId ??
      r.user_id ??
      r.uid ??
      r.$id ??
      ''
    ).trim() === uid &&
    String(r.role || 'admin')
      .trim()
      .toLowerCase() === 'admin'
  );

  if (!ok) {
    throw new Error('Admin verification failed.');
  }

  return uid;
}

/* =========================================================
   PROFILE
========================================================= */

async function actionCreateProfile(ctx, data) {
  const uid = await requireUser(ctx);

  const existing = await safeGetRow(
    ctx,
    TABLES.users,
    uid
  );

  if (existing) {
    return profileResponse(existing);
  }

  const username =
    String(data.username || 'Gamer')
      .trim()
      .slice(0, 80);

  const phone =
    String(data.phone || '')
      .trim()
      .slice(0, 40);

  const row = await createRow(
    ctx,
    TABLES.users,
    {
      uid,
      username,
      name: username,
      phone,

      balance: 0,
      depositBalance: 0,
      winningBalance: 0,

      createdAt: new Date().toISOString()
    },
    uid
  );

  return profileResponse(row);
}

async function actionGetProfile(ctx) {
  return profileResponse(
    await getUser(
      ctx,
      await requireUser(ctx)
    )
  );
}

/* =========================================================
   PLATFORM CONFIG
========================================================= */

async function findPlatformConfigRow(ctx) {

  const direct = await safeGetRow(
    ctx,
    TABLES.config,
    'platform'
  );

  if (direct) {
    return direct;
  }

  const rows = await listAllRows(
    ctx,
    TABLES.config
  );

  return (
    rows.find(
      r =>
        String(r.key || '')
          .trim()
          .toLowerCase() === 'platform'
    ) || null
  );
}

async function actionGetPlatformConfig(ctx) {

  const row =
    await findPlatformConfigRow(ctx);

  if (!row) {
    return {
      upiId: '',
      qrImgUrl: '',
      tournaments: []
    };
  }

  let tournaments = [];

  if (Array.isArray(row.tournaments)) {
    tournaments = row.tournaments;
  } else if (row.tournaments) {

    try {
      tournaments =
        JSON.parse(row.tournaments);

      if (!Array.isArray(tournaments)) {
        tournaments = [];
      }

    } catch (_) {
      tournaments = [];
    }
  }

  return {
    upiId: String(row.upiId || ''),
    qrImgUrl: String(row.qrImgUrl || ''),
    tournaments
  };
}

async function actionSetPlatformConfig(ctx, data) {

  const uid = await requireAdmin(ctx);

  const row =
    await findPlatformConfigRow(ctx);

  const payload = {};

  if (data.upiId !== undefined) {
    payload.upiId =
      String(data.upiId || '').trim();
  }

  if (data.qrImgUrl !== undefined) {
    payload.qrImgUrl =
      String(data.qrImgUrl || '').trim();
  }

  payload.updatedAt =
    new Date().toISOString();

  payload.updatedBy = uid;

  const saved = row
    ? await updateRow(
        ctx,
        TABLES.config,
        row.$id,
        payload
      )
    : await createRow(
        ctx,
        TABLES.config,
        {
          key: 'platform',
          ...payload
        },
        'platform'
      );

  return {
    ok: true,

    config: {
      upiId:
        String(saved.upiId || ''),

      qrImgUrl:
        String(saved.qrImgUrl || '')
    }
  };
}

/* =========================================================
   ADMIN DIRECT RESULT OVERRIDE ENDPOINT (Appwrite Synced)
========================================================= */

async function actionSetGameResultOverride(ctx, data) {
  await requireAdmin(ctx);

  const gameId = String(data.game_id || data.gameId || 'wingo').trim();
  if (!GAME_RULES[gameId]) throw new Error('Unsupported gameId.');

  const current = periodInfo(gameId);
  const roundId = `${gameId}_${current.period}`;

  let outcome = {};

  if (gameId === 'wingo') {
    const num = Number(data.number ?? 0);
    outcome = {
      number: num,
      color: colorForNumber(num),
      size: sizeForNumber(num)
    };
  } else if (gameId === 'tiger') {
    outcome = {
      winner: String(data.winner || 'Tiger').trim()
    };
  } else if (gameId === 'number100') {
    outcome = {
      number: Number(data.number ?? 0)
    };
  }

  const payload = {
    game_id: gameId,
    period: current.period,
    status: 'open',
    start_at_ms: current.startAtMs,
    end_at_ms: current.endAtMs,
    result_json: JSON.stringify(outcome),
    result: String(outcome.number ?? outcome.winner ?? ''),
    color: outcome.color || '',
    size: outcome.size || ''
  };

  const updated = await upsertRow(ctx, TABLES.game_rounds, roundId, payload);

  return {
    ok: true,
    roundId,
    outcome,
    updated
  };
}

/* =========================================================
   TOURNAMENTS
========================================================= */

async function actionGetTournaments(ctx) {
  const config =
    await actionGetPlatformConfig(ctx);

  return config.tournaments || [];
}

async function actionSetTournaments(ctx, data) {

  await requireAdmin(ctx);

  const row =
    await findPlatformConfigRow(ctx);

  const tournaments =
    Array.isArray(data.tournaments)
      ? data.tournaments
      : [];

  const payload = {
    tournaments,

    updatedAt:
      new Date().toISOString(),

    updatedBy:
      uidFrom(ctx)
  };

  const saved = row
    ? await updateRow(
        ctx,
        TABLES.config,
        row.$id,
        payload
      )
    : await createRow(
        ctx,
        TABLES.config,
        {
          key: 'platform',
          upiId: '',
          qrImgUrl: '',
          ...payload
        },
        'platform'
      );

  return {
    ok: true,

    tournaments:
      Array.isArray(saved.tournaments)
        ? saved.tournaments
        : tournaments
  };
}

/* =========================================================
   ENSURE GAME ROUND
========================================================= */

async function actionEnsureGameRound(ctx, data) {

  const gameId =
    String(
      data.game_id ||
      data.gameId ||
      ''
    ).trim();

  if (!GAME_RULES[gameId]) {
    throw new Error(
      'Unsupported gameId.'
    );
  }

  const current =
    periodInfo(gameId);

  const roundId =
    `${gameId}_${current.period}`;

  let round =
    await safeGetRow(
      ctx,
      TABLES.game_rounds,
      roundId
    );

  if (!round) {

    const outcome =
      generateOutcome(
        gameId,
        current.period
      );

    round =
      await createRow(
        ctx,
        TABLES.game_rounds,
        {
          game_id: gameId,
          period: current.period,

          status: 'open',

          start_at_ms:
            current.startAtMs,

          end_at_ms:
            current.endAtMs,

          result_json:
            JSON.stringify(outcome),

          result:
            String(
              outcome.number ??
              outcome.winner ??
              ''
            ),

          color:
            outcome.color || '',

          size:
            outcome.size || ''
        },
        roundId
      );
  }

  const prev =
    periodInfo(
      gameId,
      current.startAtMs - 1
    );

  const prevId =
    `${gameId}_${prev.period}`;

  const prevRow =
    await safeGetRow(
      ctx,
      TABLES.game_rounds,
      prevId
    );

  if (
    prevRow &&
    prevRow.status !== 'settled' &&
    Number(prevRow.end_at_ms) <= nowMs()
  ) {

    try {

      await settleRoundInternal(
        ctx,
        gameId,
        prev.period
      );

    } catch (e) {

      try {
        ctx.error?.(
          `Auto settlement ${gameId}/${prev.period}: ${e.message}`
        );
      } catch (_) {}
    }
  }

  return {
    ...periodInfo(gameId),

    roundId,

    serverNowMs:
      nowMs(),

    status:
      round.status,

    result:
      parseResult(
        round.result_json
      )
  };
}

/* =========================================================
   PLACE BET
========================================================= */

async function actionPlaceGameBet(ctx, data) {

  const uid =
    await requireUser(ctx);

  const gameId =
    String(
      data.game_id ||
      data.gameId ||
      ''
    ).trim();

  const category =
    String(
      data.category || ''
    ).trim();

  const selection =
    String(
      data.selection ?? ''
    ).trim();

  const amount =
    money(data.amount);

  if (
    !GAME_RULES[gameId] ||
    !selection ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    throw new Error('Invalid bet.');
  }

  const round =
    periodInfo(gameId);

  if (
    nowMs() >
    round.endAtMs - 5000
  ) {
    throw new Error(
      'Betting is closed for this round.'
    );
  }

  const multiplier =
    payoutMultiplier(
      gameId,
      selection,
      category
    );

  if (multiplier <= 0) {
    throw new Error(
      'Invalid selection/category.'
    );
  }

  const user =
    await getUser(ctx, uid);

  if (
    money(user.balance) <
    amount
  ) {
    throw new Error(
      'Insufficient balance.'
    );
  }

  await updateRow(
    ctx,
    TABLES.users,
    uid,
    {
      balance:
        money(
          Number(user.balance) -
          amount
        )
    }
  );

  const betId =
    `bet_${randomId()}`;

  return createRow(
    ctx,
    TABLES.bets,
    {
      userId: uid,

      gameId,

      period:
        round.period,

      selection,

      category,

      amount,

      status: 'open',

      payout: 0,

      multiplier,

      createdAt:
        new Date().toISOString()
    },
    betId
  );
}

/* =========================================================
   SETTLE ROUND (Completed Routine)
========================================================= */

async function settleRoundInternal(
  ctx,
  gameId,
  period
) {

  const roundId =
    `${gameId}_${period}`;

  const round =
    await safeGetRow(
      ctx,
      TABLES.game_rounds,
      roundId
    );

  if (!round) {
    return {
      settled: false,
      reason: 'round_not_found'
    };
  }

  if (round.status === 'settled') {
    return {
      settled: true,
      period,
      ...(parseResult(
        round.result_json
      ) || {}),
      settledBets: []
    };
  }

  if (
    Number(round.end_at_ms) >
    nowMs()
  ) {
    return {
      settled: false,
      reason: 'round_still_open'
    };
  }

  const outcome =
    parseResult(
      round.result_json
    ) ||
    generateOutcome(
      gameId,
      period
    );

  try {

    await updateRow(
      ctx,
      TABLES.game_rounds,
      roundId,
      {
        status: 'settling'
      }
    );

  } catch (e) {

    const latest =
      await safeGetRow(
        ctx,
        TABLES.game_rounds,
        roundId
      );

    if (
      latest?.status ===
      'settled'
    ) {
      return {
        settled: true,
        period,
        ...(parseResult(
          latest.result_json
        ) || {}),
        settledBets: []
      };
    }

    throw e;
  }

  const allBets =
    await listAllRows(
      ctx,
      TABLES.bets
    );

  const bets =
    allBets.filter(
      b =>
        String(
          b.gameId ||
          b.game_id
        ) === gameId &&

        String(b.period) ===
        period &&

        String(b.status) ===
        'open'
    );

  const settledBets = [];

  for (const bet of bets) {

    const win =
      isWinningBet(
        gameId,
        {
          ...bet,
          selection: bet.selection,
          category: bet.category
        },
        outcome
      );

    let payout = 0;

    if (win) {
      const gross = money(Number(bet.amount || 0) * Number(bet.multiplier || 1));
      payout = money(gross * (1 - FEE));
    }

    await updateRow(
      ctx,
      TABLES.bets,
      bet.$id,
      {
        status: win ? 'won' : 'lost',
        payout
      }
    );

    if (win && payout > 0 && bet.userId) {
      const user = await safeGetRow(ctx, TABLES.users, bet.userId);
      if (user) {
        const curBal = Number(user.balance || 0);
        const curWin = Number(user.winningBalance || 0);

        await updateRow(ctx, TABLES.users, bet.userId, {
          balance: money(curBal + payout),
          winningBalance: money(curWin + payout)
        });
      }
    }

    settledBets.push({
      betId: bet.$id,
      userId: bet.userId,
      win,
      payout
    });
  }

  await updateRow(
    ctx,
    TABLES.game_rounds,
    roundId,
    {
      status: 'settled',
      result_json: JSON.stringify(outcome)
    }
  );

  return {
    settled: true,
    period,
    outcome,
    settledBets
  };
}

/* =========================================================
   MAIN APPWRITE ROUTER HANDLER
========================================================= */

module.exports = async function (ctx) {
  try {
    let reqData = {};

    if (ctx.req?.body) {
      try {
        reqData = typeof ctx.req.body === 'string' ? JSON.parse(ctx.req.body) : ctx.req.body;
      } catch (_) {
        reqData = {};
      }
    }

    const action = reqData.action || ctx.req?.query?.action || 'ensureGameRound';

    let result = null;

    switch (action) {
      case 'createProfile':
        result = await actionCreateProfile(ctx, reqData);
        break;
      case 'getProfile':
        result = await actionGetProfile(ctx);
        break;
      case 'getPlatformConfig':
        result = await actionGetPlatformConfig(ctx);
        break;
      case 'setPlatformConfig':
        result = await actionSetPlatformConfig(ctx, reqData);
        break;
      case 'getTournaments':
        result = await actionGetTournaments(ctx);
        break;
      case 'setTournaments':
        result = await actionSetTournaments(ctx, reqData);
        break;
      case 'ensureGameRound':
        result = await actionEnsureGameRound(ctx, reqData);
        break;
      case 'placeGameBet':
        result = await actionPlaceGameBet(ctx, reqData);
        break;
      case 'overrideResult':
      case 'setGameResultOverride':
        result = await actionSetGameResultOverride(ctx, reqData);
        break;
      default:
        result = await actionEnsureGameRound(ctx, reqData);
        break;
    }

    return ctx.res.json({
      success: true,
      data: result
    });
  } catch (err) {
    return ctx.res.json({
      success: false,
      error: err.message || 'Server error'
    }, err.status || 500);
  }
};
