import { Client, Databases, Query, ID } from 'node-appwrite';

const DATABASE_ID = process.env.APPWRITE_DATABASE_ID || "6ab2bdb4000c76cc3bef";

const COLLECTIONS = {
    USERS: "users",
    BETS: "bets",
    GAME_ROUNDS: "game_rounds",
    CONFIG: "config"
};

const DURATION_MAP = {
    wingo: 30 * 1000,
    tiger: 30 * 1000,
    number100: 300 * 1000
};

export default async ({ req, res, log, error }) => {
    const client = new Client()
        .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || "https://cloud.appwrite.io/v1")
        .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
        .setKey(process.env.APPWRITE_API_KEY);

    const db = new Databases(client);

    let body = {};
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    } catch (e) {
        body = {};
    }

    const { action, data } = body;
    const userId = req.headers['x-appwrite-user-id'] || null;

    try {
        switch (action) {
            case 'ensureGameRound':
                return res.json(await handleEnsureGameRound(db, data?.gameId || 'wingo'));

            case 'placeBet':
                return res.json(await handlePlaceBet(db, userId, data));

            case 'getWingoHistory':
                return res.json(await handleGetHistory(db, data?.gameId || 'wingo'));

            case 'verifyAdmin':
                return res.json(await handleVerifyAdmin(db, userId));

            case 'saveAdminResultSettings':
                return res.json(await handleSaveAdminResultSettings(db, userId, data));

            default:
                return res.json({ success: false, error: "Invalid action type" }, 400);
        }
    } catch (err) {
        error("Execution Error: " + err.message);
        return res.json({ success: false, error: err.message }, 500);
    }
};

// ================= HANDLER FUNCTIONS ================= //

async function handleEnsureGameRound(db, gameId) {
    const duration = DURATION_MAP[gameId] || 30000;
    const now = Date.now();

    const rounds = await db.listDocuments(DATABASE_ID, COLLECTIONS.GAME_ROUNDS, [
        Query.equal('gameId', gameId),
        Query.equal('status', 'open'),
        Query.orderDesc('startAtMs'),
        Query.limit(1)
    ]);

    let activeRound = rounds.documents[0];

    if (activeRound && now >= Number(activeRound.endAtMs)) {
        await settleGameRound(db, activeRound);
        activeRound = null;
    }

    if (!activeRound) {
        const period = `${gameId.toUpperCase()}_${Date.now()}`;
        const startAtMs = now;
        const endAtMs = now + duration;

        activeRound = await db.createDocument(DATABASE_ID, COLLECTIONS.GAME_ROUNDS, ID.unique(), {
            gameId,
            period,
            startAtMs,
            endAtMs,
            status: 'open',
            result: '',
            price: 0
        });
    }

    return {
        success: true,
        gameId,
        period: activeRound.period,
        startAtMs: Number(activeRound.startAtMs),
        endAtMs: Number(activeRound.endAtMs),
        serverNowMs: now
    };
}

async function handlePlaceBet(db, userId, betData) {
    if (!userId) throw new Error("Unauthorized user");
    const { gameId, selection, category, amount } = betData;

    if (!amount || amount <= 0) throw new Error("Invalid bet amount");

    const user = await db.getDocument(DATABASE_ID, COLLECTIONS.USERS, userId);
    const totalBal = (user.balance || 0) + (user.depositBalance || 0) + (user.winningBalance || 0);

    if (totalBal < amount) throw new Error("Insufficient balance");

    // Deduct balance logic
    let remaining = amount;
    let depBal = user.depositBalance || 0;
    let winBal = user.winningBalance || 0;
    let regBal = user.balance || 0;

    if (depBal >= remaining) {
        depBal -= remaining;
        remaining = 0;
    } else {
        remaining -= depBal;
        depBal = 0;
    }

    if (remaining > 0 && winBal >= remaining) {
        winBal -= remaining;
        remaining = 0;
    } else if (remaining > 0) {
        remaining -= winBal;
        winBal = 0;
    }

    if (remaining > 0) {
        regBal -= remaining;
    }

    await db.updateDocument(DATABASE_ID, COLLECTIONS.USERS, userId, {
        depositBalance: depBal,
        winningBalance: winBal,
        balance: Math.max(0, regBal)
    });

    const activeRound = await handleEnsureGameRound(db, gameId);

    const betDoc = await db.createDocument(DATABASE_ID, COLLECTIONS.BETS, ID.unique(), {
        userId,
        period: activeRound.period,
        gameId,
        category: category || 'Default',
        selection: String(selection),
        amount: Number(amount),
        status: 'pending',
        payout: 0,
        resultJson: ''
    });

    return { success: true, bet: betDoc };
}

async function handleGetHistory(db, gameId) {
    const list = await db.listDocuments(DATABASE_ID, COLLECTIONS.GAME_ROUNDS, [
        Query.equal('gameId', gameId),
        Query.equal('status', 'settled'),
        Query.orderDesc('endAtMs'),
        Query.limit(20)
    ]);

    return {
        success: true,
        history: list.documents.map(d => ({
            period: d.period,
            result: d.result,
            price: d.price,
            resultJson: d.resultJson || ''
        }))
    };
}

async function handleVerifyAdmin(db, userId) {
    if (!userId) return { isAdmin: false };
    const user = await db.getDocument(DATABASE_ID, COLLECTIONS.USERS, userId);
    return { isAdmin: !!user.isAdmin };
}

async function handleSaveAdminResultSettings(db, userId, data) {
    const user = await db.getDocument(DATABASE_ID, COLLECTIONS.USERS, userId);
    if (!user.isAdmin) throw new Error("Admin access required");

    await db.createDocument(DATABASE_ID, COLLECTIONS.CONFIG, ID.unique(), {
        key: 'result_settings',
        value: JSON.stringify(data)
    });

    return { success: true };
}

// ================= SETTLEMENT ENGINE ================= //

async function settleGameRound(db, round) {
    const { gameId, period } = round;

    const betsList = await db.listDocuments(DATABASE_ID, COLLECTIONS.BETS, [
        Query.equal('gameId', gameId),
        Query.equal('period', period),
        Query.equal('status', 'pending')
    ]);

    let finalResult = "";
    let finalPrice = Math.floor(1000 + Math.random() * 9000);

    if (gameId === 'wingo') {
        const winningNum = Math.floor(Math.random() * 10);
        const color = (winningNum === 0 || winningNum === 5) ? 'violet' : (winningNum % 2 === 0 ? 'red' : 'green');
        const size = winningNum >= 5 ? 'Big' : 'Small';
        finalResult = JSON.stringify({ number: winningNum, color, size });
    } else if (gameId === 'tiger') {
        const choices = ['Tiger', 'Lion', 'Tie'];
        const chosen = choices[Math.floor(Math.random() * choices.length)];
        finalResult = JSON.stringify({ winner: chosen });
    } else if (gameId === 'number100') {
        const num = Math.floor(Math.random() * 101);
        finalResult = JSON.stringify({ number: num });
    }

    // Process payout per bet (with 2% platform fee deduction on winnings)
    for (const bet of betsList.documents) {
        let isWin = false;
        let multiplier = 0;

        const resObj = JSON.parse(finalResult);

        if (gameId === 'wingo') {
            if (bet.category === 'Color' && bet.selection.toLowerCase() === resObj.color) {
                isWin = true;
                multiplier = resObj.color === 'violet' ? 4.5 : 2;
            } else if (bet.category === 'Number' && String(bet.selection) === String(resObj.number)) {
                isWin = true;
                multiplier = 9;
            } else if (bet.category === 'Size' && bet.selection.toLowerCase() === resObj.size.toLowerCase()) {
                isWin = true;
                multiplier = 2;
            }
        } else if (gameId === 'tiger') {
            if (bet.selection.toLowerCase() === resObj.winner.toLowerCase()) {
                isWin = true;
                multiplier = resObj.winner === 'Tie' ? 8 : 2;
            }
        } else if (gameId === 'number100') {
            if (String(bet.selection) === String(resObj.number)) {
                isWin = true;
                multiplier = 30;
            }
        }

        let payout = 0;
        if (isWin) {
            const grossPayout = bet.amount * multiplier;
            payout = grossPayout * 0.98; // 2% Platform Fee

            const user = await db.getDocument(DATABASE_ID, COLLECTIONS.USERS, bet.userId);
            await db.updateDocument(DATABASE_ID, COLLECTIONS.USERS, bet.userId, {
                winningBalance: (user.winningBalance || 0) + payout
            });
        }

        await db.updateDocument(DATABASE_ID, COLLECTIONS.BETS, bet.$id, {
            status: isWin ? 'won' : 'lost',
            payout: payout,
            resultJson: finalResult
        });
    }

    await db.updateDocument(DATABASE_ID, COLLECTIONS.GAME_ROUNDS, round.$id, {
        status: 'settled',
        result: finalResult,
        price: finalPrice
    });
}
