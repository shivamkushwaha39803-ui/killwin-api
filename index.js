import { createHash, randomBytes } from "node:crypto";

/*
 * Indian Club Game - Appwrite Function backend
 * Function ID: 6ab37be2001d71ca80d3
 * Scope: Free Fire tournaments + wallet/admin only.
 * WinGo / Colour Trading / Tiger-Lion / 0-100 game logic is intentionally NOT included.
 */

const PROJECT_ID =
    process.env.APPWRITE_FUNCTION_PROJECT_ID ||
    process.env.APPWRITE_PROJECT_ID ||
    "6ab2b71c00171587d4fc";

const DATABASE_ID =
    process.env.APPWRITE_DATABASE_ID ||
    "6ab2bdb4000c76cc3bef";

const ENDPOINT = (
    process.env.APPWRITE_ENDPOINT ||
    process.env.APPWRITE_FUNCTION_API_ENDPOINT ||
    "https://cloud.appwrite.io/v1"
).replace(/\/+$/, "");

const API_KEY =
    process.env.APPWRITE_API_KEY ||
    process.env.APPWRITE_FUNCTION_API_KEY ||
    "";

const TABLES = {
    users: "6ab2bf1d0025b9c53f38",
    admins: "6ab34851002ce1959b05",
    config: "6ab348cb001698034464",
    tournaments: "6abfe6d700319be4c776",
    transactions: "transactions"
};

const PLATFORM_CONFIG_KEY = "platform";
const DEFAULT_UPI_ID = "9833381519@ptyes";
const DEFAULT_QR_URL =
    "https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=upi://pay?pa=9833381519@ptyes";

class BackendError extends Error {
    constructor(message, status = 400, code = "BACKEND_ERROR", details = null) {
        super(message);
        this.name = "BackendError";
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

function nowIso() {
    return new Date().toISOString();
}

function cleanString(value, max = 500) {
    return String(value ?? "").trim().slice(0, max);
}

function normalizePhone(value) {
    return String(value ?? "")
        .trim()
        .replace(/[\s()+-]/g, "");
}

function normalizeUtr(value) {
    return String(value ?? "").trim().toUpperCase();
}

function money(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return NaN;
    return Math.round((n + Number.EPSILON) * 100) / 100;
}

function assertMoney(value, field = "amount", max = 10000000) {
    const n = money(value);
    if (!Number.isFinite(n) || n <= 0 || n > max) {
        throw new BackendError(`Invalid ${field}.`, 400, "INVALID_AMOUNT");
    }
    return n;
}

function makeId(prefix = "row") {
    return `${prefix}_${randomBytes(12).toString("hex")}`.slice(0, 36);
}

function hashId(value, prefix = "id") {
    const digest = createHash("sha256").update(String(value)).digest("hex");
    return `${prefix}_${digest}`.slice(0, 36);
}

function getHeader(req, name) {
    const headers = req?.headers || {};
    const wanted = String(name).toLowerCase();

    for (const [key, value] of Object.entries(headers)) {
        if (String(key).toLowerCase() === wanted) {
            return Array.isArray(value) ? value[0] : value;
        }
    }
    return "";
}

function getUserId(req) {
    return (
        getHeader(req, "x-appwrite-user-id") ||
        getHeader(req, "x-appwrite-user-id".replace(/-/g, "_")) ||
        ""
    ).trim();
}

function parseBody(req) {
    if (req?.bodyJson && typeof req.bodyJson === "object") {
        return req.bodyJson;
    }

    if (typeof req?.body === "object" && req.body !== null) {
        return req.body;
    }

    const raw =
        typeof req?.bodyRaw === "string"
            ? req.bodyRaw
            : typeof req?.body === "string"
                ? req.body
                : "";

    if (!raw) return {};

    try {
        return JSON.parse(raw);
    } catch {
        throw new BackendError("Request body must be valid JSON.", 400, "INVALID_JSON");
    }
}

async function appwriteRequest(path, options = {}) {
    if (!API_KEY) {
        throw new BackendError(
            "APPWRITE_API_KEY is not configured in the Function.",
            500,
            "MISSING_API_KEY"
        );
    }

    const url = `${ENDPOINT}${path.startsWith("/") ? path : `/${path}`}`;
    const headers = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Appwrite-Project": PROJECT_ID,
        "X-Appwrite-Key": API_KEY,
        "X-Appwrite-Response-Format": "2.3.0",
        ...(options.headers || {})
    };

    let response;
    try {
        response = await fetch(url, {
            method: options.method || "GET",
            headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body)
        });
    } catch (err) {
        throw new BackendError(
            `Appwrite network error: ${err?.message || "request failed"}`,
            502,
            "APPWRITE_NETWORK_ERROR"
        );
    }

    const raw = await response.text();
    let payload = {};
    if (raw) {
        try {
            payload = JSON.parse(raw);
        } catch {
            payload = { message: raw };
        }
    }

    if (!response.ok) {
        const message =
            payload?.message ||
            payload?.error ||
            payload?.description ||
            `Appwrite HTTP ${response.status}`;

        throw new BackendError(
            String(message),
            response.status,
            payload?.type || "APPWRITE_ERROR",
            payload
        );
    }

    return payload;
}

function queryString(method, column, values = []) {
    const q = {
        method,
        ...(column ? { column } : {}),
        ...(values.length ? { values } : {})
    };
    return JSON.stringify(q);
}

function buildListPath(tableId, queries = []) {
    const params = new URLSearchParams();
    queries.forEach((q) => params.append("queries[]", q));
    return `/tablesdb/${encodeURIComponent(DATABASE_ID)}/tables/${encodeURIComponent(tableId)}/rows${
        params.toString() ? `?${params.toString()}` : ""
    }`;
}

async function listRows(tableId, queries = []) {
    return appwriteRequest(buildListPath(tableId, queries));
}

async function listAllRows(tableId, baseQueries = [], maxRows = 5000) {
    const rows = [];
    let cursor = "";
    let guard = 0;

    while (rows.length < maxRows && guard < 100) {
        guard += 1;

        const queries = [...baseQueries, queryString("limit", "", [100])];
        if (cursor) {
            queries.push(queryString("cursorAfter", "", [cursor]));
        }

        const result = await listRows(tableId, queries);
        const batch = Array.isArray(result?.rows) ? result.rows : [];
        rows.push(...batch);

        if (batch.length < 100) break;
        cursor = batch[batch.length - 1]?.$id;
        if (!cursor) break;
    }

    return rows.slice(0, maxRows);
}

async function getRow(tableId, rowId) {
    return appwriteRequest(
        `/tablesdb/${encodeURIComponent(DATABASE_ID)}/tables/${encodeURIComponent(tableId)}/rows/${encodeURIComponent(rowId)}`
    );
}

async function createRow(tableId, rowId, data, transactionId = null) {
    return appwriteRequest(
        `/tablesdb/${encodeURIComponent(DATABASE_ID)}/tables/${encodeURIComponent(tableId)}/rows`,
        {
            method: "POST",
            body: {
                rowId: rowId || "unique()",
                data,
                ...(transactionId ? { transactionId } : {})
            }
        }
    );
}

async function updateRow(tableId, rowId, data, transactionId = null) {
    return appwriteRequest(
        `/tablesdb/${encodeURIComponent(DATABASE_ID)}/tables/${encodeURIComponent(tableId)}/rows/${encodeURIComponent(rowId)}`,
        {
            method: "PATCH",
            body: {
                data,
                ...(transactionId ? { transactionId } : {})
            }
        }
    );
}

async function upsertRow(tableId, rowId, data, transactionId = null) {
    return appwriteRequest(
        `/tablesdb/${encodeURIComponent(DATABASE_ID)}/tables/${encodeURIComponent(tableId)}/rows/${encodeURIComponent(rowId)}`,
        {
            method: "PUT",
            body: {
                rowId,
                data,
                ...(transactionId ? { transactionId } : {})
            }
        }
    );
}

async function createDbTransaction(ttl = 60) {
    return appwriteRequest("/tablesdb/transactions", {
        method: "POST",
        body: { ttl }
    });
}

async function commitDbTransaction(transactionId) {
    return appwriteRequest(
        `/tablesdb/transactions/${encodeURIComponent(transactionId)}`,
        {
            method: "PATCH",
            body: { commit: true, rollback: false }
        }
    );
}

async function rollbackDbTransaction(transactionId) {
    try {
        await appwriteRequest(
            `/tablesdb/transactions/${encodeURIComponent(transactionId)}`,
            {
                method: "PATCH",
                body: { commit: false, rollback: true }
            }
        );
    } catch {
        // The original Appwrite error is more useful to the caller.
    }
}

async function withDbTransaction(work, ttl = 60) {
    const tx = await createDbTransaction(ttl);
    const transactionId = tx?.$id;

    if (!transactionId) {
        throw new BackendError(
            "Appwrite did not return a database transaction ID.",
            502,
            "TRANSACTION_CREATE_FAILED"
        );
    }

    try {
        const result = await work(transactionId);
        await commitDbTransaction(transactionId);
        return result;
    } catch (err) {
        await rollbackDbTransaction(transactionId);
        throw err;
    }
}

async function findOne(tableId, queries) {
    const result = await listRows(tableId, [
        ...queries,
        queryString("limit", "", [1])
    ]);
    return Array.isArray(result?.rows) && result.rows.length
        ? result.rows[0]
        : null;
}

async function findUserByUid(uid) {
    return findOne(TABLES.users, [
        queryString("equal", "uid", [uid])
    ]);
}

async function findAdminByUid(uid) {
    const direct = await findOne(TABLES.admins, [
        queryString("equal", "uid", [uid])
    ]);
    if (direct) return direct;

    const byUserId = await findOne(TABLES.admins, [
        queryString("equal", "user_id", [uid])
    ]);
    if (byUserId) return byUserId;

    return findOne(TABLES.admins, [
        queryString("equal", "user_id", [uid])
    ]);
}

async function requireAuth(req) {
    const uid = getUserId(req);
    if (!uid) {
        throw new BackendError(
            "Login required. Appwrite user identity was not provided.",
            401,
            "AUTH_REQUIRED"
        );
    }

    return uid;
}

async function requireAdmin(req) {
    const uid = await requireAuth(req);
    const admin = await findAdminByUid(uid);

    if (!admin) {
        throw new BackendError(
            "Access denied: authenticated user is not authorized as admin.",
            403,
            "ADMIN_REQUIRED"
        );
    }

    const role = String(admin.role ?? "admin").toLowerCase();
    if (role && !["admin", "superadmin", "owner", "host"].includes(role)) {
        throw new BackendError(
            "Access denied: admin role is not authorized.",
            403,
            "ADMIN_REQUIRED"
        );
    }

    return { uid, admin };
}

function normalizeProfile(row) {
    if (!row) return null;

    const balance = money(row.balance) || 0;
    const depositBalance = money(row.depositBalance) || 0;
    const winningBalance = money(row.winningBalance) || 0;

    return {
        id: row.$id,
        uid: String(row.uid ?? ""),
        username: String(row.username ?? row.name ?? "Gamer"),
        name: String(row.name ?? row.username ?? "Gamer"),
        phone: String(row.phone ?? ""),
        balance,
        depositBalance,
        winningBalance,
        createdAt: row.createdAt ?? row.$createdAt ?? null
    };
}

function normalizeTournament(raw, fallbackId = null) {
    const idValue = raw?.id ?? fallbackId ?? raw?.$id;
    const id = Number(idValue);

    return {
        id: Number.isFinite(id) ? id : fallbackId,
        title: cleanString(raw?.title, 150) || "Free Fire Tournament",
        time: cleanString(raw?.time, 100),
        booyah: cleanString(raw?.booyah, 50),
        prize: cleanString(raw?.prize, 100) || "₹0",
        perKill: cleanString(raw?.perKill, 50) || "₹0",
        entry: money(raw?.entry ?? raw?.entryFee) || 0,
        currentJoined: Math.max(
            0,
            Number(raw?.currentJoined ?? (Array.isArray(raw?.joinedUsers) ? raw.joinedUsers.length : 0)) || 0
        ),
        maxSlots: Math.max(0, Number(raw?.maxSlots ?? raw?.slots) || 0),
        type: cleanString(raw?.type, 30) || "squad",
        map: cleanString(raw?.map, 50) || "BERMUDA",
        roomId: cleanString(raw?.roomId ?? raw?.roomid, 100),
        roomPass: cleanString(raw?.roomPass ?? raw?.password, 100),
        joinedUsers: Array.isArray(raw?.joinedUsers)
            ? [...new Set(raw.joinedUsers.map(String))]
            : [],
        status: cleanString(raw?.status, 30) || "open"
    };
}

function tournamentToTableData(t) {
    return {
        title: t.title,
        prize: t.prize,
        entryFee: t.entry,
        slots: t.maxSlots,
        time: t.time,
        roomid: t.roomId,
        password: t.roomPass,
        status: t.status || "open",
        updatedAt: nowIso()
    };
}

function inferTypeFromTitle(title) {
    const x = String(title || "").toLowerCase();
    if (x.includes("solo")) return "solo";
    if (x.includes("clash")) return "clash";
    return "squad";
}

function buildTournamentFromTable(row) {
    const id = Number(row.$id);
    return normalizeTournament(
        {
            id,
            title: row.title,
            time: row.time,
            prize: row.prize,
            entryFee: row.entryFee,
            slots: row.slots,
            roomid: row.roomid,
            password: row.password,
            status: row.status,
            type: inferTypeFromTitle(row.title),
            map: "BERMUDA",
            joinedUsers: []
        },
        id
    );
}

async function getPlatformConfigRow() {
    const byKey = await findOne(TABLES.config, [
        queryString("equal", "key", [PLATFORM_CONFIG_KEY])
    ]);
    if (byKey) return byKey;

    // Preserve compatibility with an older config row whose ID was used as "platform".
    try {
        const direct = await getRow(TABLES.config, PLATFORM_CONFIG_KEY);
        if (direct) return direct;
    } catch (err) {
        if (err?.status !== 404) throw err;
    }

    const rows = await listRows(TABLES.config, [
        queryString("limit", "", [1])
    ]);
    return Array.isArray(rows?.rows) && rows.rows.length ? rows.rows[0] : null;
}

async function getTournamentState() {
    const config = await getPlatformConfigRow();
    const configTournaments = Array.isArray(config?.tournaments)
        ? config.tournaments.map((t) => normalizeTournament(t))
        : [];

    const tableRows = await listAllRows(TABLES.tournaments, [], 100);
    const tableTournaments = tableRows
        .map((row) => buildTournamentFromTable(row))
        .filter((t) => Number.isInteger(t.id));

    const byId = new Map();

    for (const t of tableTournaments) byId.set(Number(t.id), t);
    for (const t of configTournaments) {
        if (Number.isInteger(t.id)) {
            const old = byId.get(Number(t.id));
            byId.set(Number(t.id), normalizeTournament({ ...old, ...t }, Number(t.id)));
        }
    }

    return {
        config,
        tournaments: [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id))
    };
}

async function getTournamentById(tournamentId) {
    const state = await getTournamentState();
    const tournament = state.tournaments.find(
        (t) => Number(t.id) === Number(tournamentId)
    );

    if (!tournament) {
        throw new BackendError(
            "Tournament not found.",
            404,
            "TOURNAMENT_NOT_FOUND"
        );
    }

    return { ...state, tournament };
}

function assertTournamentOpen(tournament) {
    const status = String(tournament.status || "open").toLowerCase();

    if (
        ["closed", "inactive", "disabled", "locked", "completed", "cancelled", "full"].includes(status)
    ) {
        throw new BackendError(
            "Tournament joining is currently closed.",
            409,
            "TOURNAMENT_CLOSED"
        );
    }

    if (tournament.maxSlots <= 0) {
        throw new BackendError(
            "Tournament slots are not configured.",
            409,
            "INVALID_TOURNAMENT_SLOTS"
        );
    }

    if (tournament.currentJoined >= tournament.maxSlots) {
        throw new BackendError(
            "Tournament is full.",
            409,
            "TOURNAMENT_FULL"
        );
    }
}

function spendWallet(profile, amount) {
    const total = money(profile.balance) || 0;
    const deposit = money(profile.depositBalance) || 0;
    const winning = money(profile.winningBalance) || 0;

    if (total + 0.0001 < amount) {
        throw new BackendError(
            "Insufficient wallet balance.",
            409,
            "INSUFFICIENT_BALANCE"
        );
    }

    // Preserve the wallet split: consume deposit balance first, then winnings.
    let remaining = amount;
    const fromDeposit = Math.min(deposit, remaining);
    remaining = money(remaining - fromDeposit);
    const fromWinning = remaining;

    if (winning + 0.0001 < fromWinning) {
        // If the stored component values are inconsistent with total balance,
        // do not silently manufacture money.
        throw new BackendError(
            "Wallet balances are inconsistent. Please contact support.",
            409,
            "WALLET_INCONSISTENT"
        );
    }

    return {
        balance: money(total - amount),
        depositBalance: money(deposit - fromDeposit),
        winningBalance: money(winning - fromWinning)
    };
}

function refundWinningWallet(profile, amount) {
    return {
        balance: money((profile.balance || 0) + amount),
        depositBalance: money(profile.depositBalance || 0),
        winningBalance: money((profile.winningBalance || 0) + amount)
    };
}

function validateFreeFireUid(value) {
    const uid = cleanString(value, 30);
    if (!/^\d{6,15}$/.test(uid)) {
        throw new BackendError(
            "Please enter a valid Free Fire UID.",
            400,
            "INVALID_FREE_FIRE_UID"
        );
    }
    return uid;
}

function validateFreeFireName(value) {
    const name = cleanString(value, 50);
    if (name.length < 2 || name.length > 50) {
        throw new BackendError(
            "Please enter a valid in-game name.",
            400,
            "INVALID_FREE_FIRE_NAME"
        );
    }
    return name;
}

function validateUpi(value) {
    const upi = cleanString(value, 120);
    if (!/^[A-Za-z0-9._-]{2,80}@[A-Za-z0-9.-]{2,40}$/.test(upi)) {
        throw new BackendError(
            "Invalid UPI ID.",
            400,
            "INVALID_UPI"
        );
    }
    return upi;
}

function canonicalWithdrawalDetails(method, details) {
    const raw = cleanString(details, 1000);

    if (method === "upi") {
        const match = raw.match(/^UPI ID:\s*(.+)$/i);
        const upi = validateUpi(match ? match[1].trim() : raw);
        return `UPI ID: ${upi}`;
    }

    if (method !== "bank") {
        throw new BackendError(
            "Unsupported withdrawal method.",
            400,
            "INVALID_WITHDRAW_METHOD"
        );
    }

    const match = raw.match(
        /^Holder:\s*(.+?),\s*Bank:\s*(.+?),\s*Acc:\s*([A-Za-z0-9-]{6,30}),\s*IFSC:\s*([A-Za-z]{4}0[A-Za-z0-9]{6})$/i
    );

    if (!match) {
        throw new BackendError(
            "Invalid bank withdrawal details.",
            400,
            "INVALID_BANK_DETAILS"
        );
    }

    const holder = cleanString(match[1], 100);
    const bank = cleanString(match[2], 120);
    const account = cleanString(match[3], 30);
    const ifsc = cleanString(match[4], 11).toUpperCase();

    if (holder.length < 2 || bank.length < 2) {
        throw new BackendError(
            "Invalid bank holder or bank name.",
            400,
            "INVALID_BANK_DETAILS"
        );
    }

    return `Holder: ${holder}, Bank: ${bank}, Acc: ${account}, IFSC: ${ifsc}`;
}

function publicTournament(t) {
    const normalized = normalizeTournament(t, Number(t.id));

    return {
        id: normalized.id,
        title: normalized.title,
        time: normalized.time,
        booyah: normalized.booyah,
        prize: normalized.prize,
        perKill: normalized.perKill,
        entry: normalized.entry,
        entryFee: normalized.entry,
        currentJoined: normalized.joinedUsers.length,
        maxSlots: normalized.maxSlots,
        slots: normalized.maxSlots,
        type: normalized.type,
        map: normalized.map,
        roomid: normalized.roomId,
        roomId: normalized.roomId,
        password: normalized.roomPass,
        roomPass: normalized.roomPass,
        joinedUsers: normalized.joinedUsers,
        status: normalized.status
    };
}

async function actionVerifyAdmin(req) {
    const uid = await requireAuth(req);
    const admin = await findAdminByUid(uid);

    return {
        isAdmin: Boolean(admin),
        uid,
        role: admin?.role ?? null
    };
}

async function actionGetPlatformConfig() {
    const config = await getPlatformConfigRow();

    return {
        upiId: config?.upiId ?? DEFAULT_UPI_ID,
        qrImgUrl: config?.qrImgUrl ?? DEFAULT_QR_URL
    };
}

async function actionSetPlatformConfig(req, data) {
    const { uid } = await requireAdmin(req);

    const upiId = validateUpi(data?.upiId);
    const qrImgUrl = cleanString(data?.qrImgUrl, 2000);

    if (qrImgUrl && !/^https?:\/\//i.test(qrImgUrl)) {
        throw new BackendError(
            "QR image URL must start with http:// or https://.",
            400,
            "INVALID_QR_URL"
        );
    }

    const current = await getPlatformConfigRow();
    const patch = {
        upiId,
        qrImgUrl,
        updatedAt: nowIso(),
        updatedBy: uid
    };

    if (current) {
        await updateRow(TABLES.config, current.$id, patch);
    } else {
        await createRow(TABLES.config, PLATFORM_CONFIG_KEY, {
            key: PLATFORM_CONFIG_KEY,
            upiId,
            qrImgUrl,
            updatedAt: nowIso(),
            updatedBy: uid,
            tournaments: []
        });
    }

    return { upiId, qrImgUrl };
}

async function actionGetTournaments() {
    const { tournaments } = await getTournamentState();

    return {
        tournaments: tournaments.map(publicTournament)
    };
}

async function actionSetTournaments(req, data) {
    const { uid } = await requireAdmin(req);

    if (!Array.isArray(data?.tournaments)) {
        throw new BackendError(
            "tournaments must be an array.",
            400,
            "INVALID_TOURNAMENT_PAYLOAD"
        );
    }

    const incoming = data.tournaments;
    if (incoming.length > 100) {
        throw new BackendError(
            "Too many tournaments in one request.",
            400,
            "TOO_MANY_TOURNAMENTS"
        );
    }

    const currentState = await getTournamentState();
    const currentById = new Map(
        currentState.tournaments.map((t) => [Number(t.id), t])
    );

    const adminTournaments = [];

    for (let index = 0; index < incoming.length; index += 1) {
        const raw = incoming[index];
        const id = Number(raw?.id);

        if (!Number.isInteger(id) || id <= 0) {
            throw new BackendError(
                `Invalid tournament ID at position ${index + 1}.`,
                400,
                "INVALID_TOURNAMENT_ID"
            );
        }

        const existing = currentById.get(id);
        const title = cleanString(raw?.title, 150);
        const time = cleanString(raw?.time, 100);
        const prize = cleanString(raw?.prize, 100);
        const perKill = cleanString(
            raw?.perKill ?? existing?.perKill ?? "₹0",
            50
        );

        const entry = assertMoney(
            raw?.entry ?? raw?.entryFee,
            "entry fee",
            1000000
        );

        const maxSlots = Number(raw?.maxSlots ?? raw?.slots);
        if (!Number.isInteger(maxSlots) || maxSlots < 1 || maxSlots > 10000) {
            throw new BackendError(
                `Invalid max slots for tournament ${id}.`,
                400,
                "INVALID_MAX_SLOTS"
            );
        }

        const roomId = cleanString(raw?.roomId ?? raw?.roomid, 100);
        const roomPass = cleanString(raw?.roomPass ?? raw?.password, 100);

        const joinedUsers = existing?.joinedUsers
            ? [...existing.joinedUsers]
            : [];

        if (joinedUsers.length > maxSlots) {
            throw new BackendError(
                `Cannot reduce tournament ${id} below its current joined player count.`,
                409,
                "SLOTS_BELOW_CURRENT"
            );
        }

        const status = existing?.status || "open";

        adminTournaments.push(
            normalizeTournament({
                ...(existing || {}),
                id,
                title: title || existing?.title || `Tournament #${id}`,
                time,
                prize,
                perKill,
                entry,
                maxSlots,
                type: existing?.type || inferTypeFromTitle(title),
                map: existing?.map || "BERMUDA",
                roomId,
                roomPass,
                joinedUsers,
                currentJoined: joinedUsers.length,
                status
            }, id)
        );
    }

    const platform = currentState.config;
    const saved = await withDbTransaction(async (transactionId) => {
        for (const tournament of adminTournaments) {
            const rowId = String(tournament.id);
            const existingRow = await (async () => {
                try {
                    return await getRow(TABLES.tournaments, rowId);
                } catch (err) {
                    if (err?.status === 404) return null;
                    throw err;
                }
            })();

            const tableData = tournamentToTableData(tournament);

            if (existingRow) {
                await updateRow(
                    TABLES.tournaments,
                    rowId,
                    tableData,
                    transactionId
                );
            } else {
                await createRow(
                    TABLES.tournaments,
                    rowId,
                    {
                        ...tableData,
                        createdAt: nowIso()
                    },
                    transactionId
                );
            }
        }

        const configData = {
            key: PLATFORM_CONFIG_KEY,
            upiId: platform?.upiId ?? DEFAULT_UPI_ID,
            qrImgUrl: platform?.qrImgUrl ?? DEFAULT_QR_URL,
            updatedAt: nowIso(),
            updatedBy: uid,
            tournaments: adminTournaments
        };

        if (platform) {
            await updateRow(
                TABLES.config,
                platform.$id,
                { tournaments: adminTournaments, updatedAt: nowIso(), updatedBy: uid },
                transactionId
            );
        } else {
            await createRow(
                TABLES.config,
                PLATFORM_CONFIG_KEY,
                configData,
                transactionId
            );
        }

        return adminTournaments.map(publicTournament);
    });

    return { tournaments: saved };
}

async function actionCreateProfile(req, data) {
    const uid = await requireAuth(req);

    const username = cleanString(data?.username, 100) || "Gamer";
    const phone = normalizePhone(data?.phone);

    if (!/^\d{10,15}$/.test(phone)) {
        throw new BackendError(
            "Invalid phone number.",
            400,
            "INVALID_PHONE"
        );
    }

    const existing = await findUserByUid(uid);

    if (existing) {
        const updated = await updateRow(TABLES.users, existing.$id, {
            username,
            name: username,
            phone
        });

        return normalizeProfile(updated);
    }

    const row = await createRow(TABLES.users, uid.slice(0, 36), {
        uid,
        username,
        name: username,
        phone,
        balance: 0,
        depositBalance: 0,
        winningBalance: 0,
        createdAt: nowIso()
    });

    return normalizeProfile(row);
}

async function actionGetProfile(req) {
    const uid = await requireAuth(req);
    const profile = await findUserByUid(uid);

    if (!profile) {
        throw new BackendError(
            "User profile not found. Please register again.",
            404,
            "PROFILE_NOT_FOUND"
        );
    }

    return normalizeProfile(profile);
}

async function actionJoinTournament(req, data) {
    const uid = await requireAuth(req);

    const tournamentId = Number(data?.tournamentId);
    if (!Number.isInteger(tournamentId) || tournamentId <= 0) {
        throw new BackendError(
            "Invalid tournament selection.",
            400,
            "INVALID_TOURNAMENT_ID"
        );
    }

    const ffUid = validateFreeFireUid(data?.ffUid);
    const ffName = validateFreeFireName(data?.ffName);

    const state = await getTournamentState();
    const tournament = state.tournaments.find(
        (t) => Number(t.id) === tournamentId
    );

    if (!tournament) {
        throw new BackendError(
            "Tournament not found.",
            404,
            "TOURNAMENT_NOT_FOUND"
        );
    }

    assertTournamentOpen(tournament);

    if (tournament.joinedUsers.includes(String(uid))) {
        throw new BackendError(
            "You have already joined this tournament.",
            409,
            "ALREADY_JOINED"
        );
    }

    const entryFee = assertMoney(
        tournament.entry,
        "tournament entry fee",
        1000000
    );

    const profile = await findUserByUid(uid);
    if (!profile) {
        throw new BackendError(
            "User profile not found.",
            404,
            "PROFILE_NOT_FOUND"
        );
    }

    const currentProfile = normalizeProfile(profile);
    const newWallet = spendWallet(currentProfile, entryFee);

    const newJoinedUsers = [...tournament.joinedUsers, String(uid)];
    const newTournament = normalizeTournament({
        ...tournament,
        joinedUsers: newJoinedUsers,
        currentJoined: newJoinedUsers.length
    }, tournamentId);

    if (newTournament.currentJoined > newTournament.maxSlots) {
        throw new BackendError(
            "Tournament became full. Please try another match.",
            409,
            "TOURNAMENT_FULL"
        );
    }

    const joinRowId = hashId(`tournament:${tournamentId}:user:${uid}`, "join");

    const result = await withDbTransaction(async (transactionId) => {
        let existingJoin = null;
        try {
            existingJoin = await getRow(TABLES.transactions, joinRowId);
        } catch (err) {
            if (err?.status !== 404) throw err;
        }

        if (existingJoin) {
            throw new BackendError(
                "You have already joined this tournament.",
                409,
                "ALREADY_JOINED"
            );
        }

        // If an older transaction row was created without joinKey, also inspect
        // the user/tournament identity encoded in details.
        const oldJoins = await listRows(TABLES.transactions, [
            queryString("equal", "user_id", [uid]),
            queryString("equal", "type", ["Tournament"]),
            queryString("limit", "", [100])
        ]);

        const duplicateOldJoin = (oldJoins?.rows || []).find((row) => {
            const d = String(row.details || "");
            return (
                d.includes(`Tournament ID: ${tournamentId}`) &&
                ["Pending", "Approved", "Completed"].includes(String(row.status))
            );
        });

        if (duplicateOldJoin) {
            throw new BackendError(
                "You have already joined this tournament.",
                409,
                "ALREADY_JOINED"
            );
        }

        await updateRow(
            TABLES.users,
            profile.$id,
            {
                balance: newWallet.balance,
                depositBalance: newWallet.depositBalance,
                winningBalance: newWallet.winningBalance
            },
            transactionId
        );

        const platform = state.config;
        if (platform) {
            const latestConfig = await getRow(TABLES.config, platform.$id);
            const latestArray = Array.isArray(latestConfig?.tournaments)
                ? latestConfig.tournaments.map((t) => normalizeTournament(t))
                : [];

            const latestTournament =
                latestArray.find((t) => Number(t.id) === tournamentId) ||
                newTournament;

            if (latestTournament.joinedUsers.includes(String(uid))) {
                throw new BackendError(
                    "You have already joined this tournament.",
                    409,
                    "ALREADY_JOINED"
                );
            }

            if (latestTournament.joinedUsers.length >= latestTournament.maxSlots) {
                throw new BackendError(
                    "Tournament is full.",
                    409,
                    "TOURNAMENT_FULL"
                );
            }

            latestTournament.joinedUsers = [
                ...latestTournament.joinedUsers,
                String(uid)
            ];
            latestTournament.currentJoined =
                latestTournament.joinedUsers.length;

            const mergedArray = latestArray.map((t) =>
                Number(t.id) === tournamentId ? latestTournament : t
            );

            if (!latestArray.some((t) => Number(t.id) === tournamentId)) {
                mergedArray.push(latestTournament);
            }

            await updateRow(
                TABLES.config,
                platform.$id,
                {
                    tournaments: mergedArray,
                    updatedAt: nowIso(),
                    updatedBy: uid
                },
                transactionId
            );
        } else {
            await createRow(
                TABLES.config,
                PLATFORM_CONFIG_KEY,
                {
                    key: PLATFORM_CONFIG_KEY,
                    upiId: DEFAULT_UPI_ID,
                    qrImgUrl: DEFAULT_QR_URL,
                    updatedAt: nowIso(),
                    updatedBy: uid,
                    tournaments: [newTournament]
                },
                transactionId
            );
        }

        await createRow(
            TABLES.transactions,
            joinRowId,
            {
                user_id: uid,
                username: currentProfile.username,
                type: "Tournament",
                status: "Completed",
                amount: entryFee,
                details:
                    `Tournament ID: ${tournamentId}; ` +
                    `Tournament: ${newTournament.title}; ` +
                    `Free Fire UID: ${ffUid}; ` +
                    `In-game Name: ${ffName}`
            },
            transactionId
        );

        return newTournament;
    }, 60);

    return {
        success: true,
        tournament: publicTournament(result)
    };
}

async function actionAdminListUsers(req) {
    await requireAdmin(req);

    const rows = await listAllRows(TABLES.users, [], 5000);

    const users = rows
        .map(normalizeProfile)
        .filter(Boolean)
        .sort((a, b) =>
            String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
        );

    return { users };
}

async function findUserByQuery(userQuery) {
    const q = cleanString(userQuery, 150);
    if (!q) {
        throw new BackendError(
            "User ID or phone is required.",
            400,
            "USER_QUERY_REQUIRED"
        );
    }

    let user = await findOne(TABLES.users, [
        queryString("equal", "uid", [q])
    ]);

    if (user) return user;

    user = await findOne(TABLES.users, [
        queryString("equal", "$id", [q])
    ]);

    if (user) return user;

    const phone = normalizePhone(q);
    if (/^\d{10,15}$/.test(phone)) {
        user = await findOne(TABLES.users, [
            queryString("equal", "phone", [phone])
        ]);
        if (user) return user;
    }

    user = await findOne(TABLES.users, [
        queryString("equal", "username", [q])
    ]);

    return user;
}

async function actionAdminAddMoney(req, data) {
    const { uid: adminUid } = await requireAdmin(req);

    const amount = assertMoney(data?.amount, "amount", 10000000);
    const target = await findUserByQuery(data?.userQuery);

    if (!target) {
        throw new BackendError(
            "User not found. Check the registered phone number or UID.",
            404,
            "USER_NOT_FOUND"
        );
    }

    const profile = normalizeProfile(target);

    const result = await withDbTransaction(async (transactionId) => {
        const current = await getRow(TABLES.users, target.$id);
        const currentProfile = normalizeProfile(current);

        const newBalance = money(currentProfile.balance + amount);
        const newDeposit = money(currentProfile.depositBalance + amount);

        await updateRow(
            TABLES.users,
            target.$id,
            {
                balance: newBalance,
                depositBalance: newDeposit
            },
            transactionId
        );

        await createRow(
            TABLES.transactions,
            makeId("admin"),
            {
                user_id: currentProfile.uid,
                username: currentProfile.username,
                type: "AdminCredit",
                status: "Approved",
                amount,
                details: `Admin direct credit by ${adminUid}`,
            },
            transactionId
        );

        return {
            uid: currentProfile.uid,
            balance: newBalance
        };
    }, 60);

    return result;
}

async function actionSubmitDeposit(req, data) {
    const uid = await requireAuth(req);
    const amount = assertMoney(data?.amount, "deposit amount", 10000000);

    const utr = normalizeUtr(data?.utr);

    if (!/^\d{12}$/.test(utr)) {
        throw new BackendError(
            "UTR must be exactly 12 digits.",
            400,
            "INVALID_UTR"
        );
    }

    const profile = await findUserByUid(uid);
    if (!profile) {
        throw new BackendError(
            "User profile not found.",
            404,
            "PROFILE_NOT_FOUND"
        );
    }

    const duplicate = await findOne(TABLES.transactions, [
        queryString("equal", "utr", [utr])
    ]);

    if (duplicate) {
        throw new BackendError(
            "This UTR has already been submitted.",
            409,
            "DUPLICATE_UTR"
        );
    }

    const txId = hashId(`deposit:${utr}`, "dep");

    try {
        await createRow(TABLES.transactions, txId, {
            user_id: uid,
            username: normalizeProfile(profile).username,
            type: "Deposit",
            status: "Pending",
            utr,
            amount,
            details: `UTR: ${utr}`,
        });
    } catch (err) {
        if (err?.status === 409) {
            throw new BackendError(
                "This UTR has already been submitted.",
                409,
                "DUPLICATE_UTR"
            );
        }
        throw err;
    }

    return {
        success: true,
        transactionId: txId,
        status: "Pending"
    };
}

async function actionRequestWithdrawal(req, data) {
    const uid = await requireAuth(req);
    const amount = assertMoney(data?.amount, "withdrawal amount", 10000000);

    const method = cleanString(data?.method, 20).toLowerCase();
    const details = canonicalWithdrawalDetails(method, data?.details);

    const profileRow = await findUserByUid(uid);
    if (!profileRow) {
        throw new BackendError(
            "User profile not found.",
            404,
            "PROFILE_NOT_FOUND"
        );
    }

    const result = await withDbTransaction(async (transactionId) => {
        const currentRow = await getRow(TABLES.users, profileRow.$id);
        const profile = normalizeProfile(currentRow);

        // Withdrawals are specifically for winnings in this UI.
        if ((profile.winningBalance || 0) + 0.0001 < amount) {
            throw new BackendError(
                "Withdrawal amount cannot exceed your winning balance.",
                409,
                "INSUFFICIENT_WINNINGS"
            );
        }

        const newBalance = money(profile.balance - amount);
        const newWinning = money(profile.winningBalance - amount);

        if (newBalance < -0.0001 || newWinning < -0.0001) {
            throw new BackendError(
                "Insufficient winning balance.",
                409,
                "INSUFFICIENT_WINNINGS"
            );
        }

        await updateRow(
            TABLES.users,
            profileRow.$id,
            {
                balance: Math.max(0, newBalance),
                winningBalance: Math.max(0, newWinning)
            },
            transactionId
        );

        const txId = makeId("wd");

        await createRow(
            TABLES.transactions,
            txId,
            {
                user_id: uid,
                username: profile.username,
                type: "Withdraw",
                status: "Pending",
                amount,
                details,
            },
            transactionId
        );

        return {
            transactionId: txId,
            balance: Math.max(0, newBalance),
            winningBalance: Math.max(0, newWinning)
        };
    }, 60);

    return {
        success: true,
        status: "Pending",
        ...result
    };
}

function transactionForAdmin(row) {
    return {
        id: row.$id,
        userId: row.user_id ?? "",
        username: row.username ?? "Gamer",
        type: row.type ?? "",
        status: row.status ?? "",
        utr: row.utr ?? "",
        amount: money(row.amount) || 0,
        details: row.details ?? "",
        timestamp: row.$createdAt ?? ""
    };
}

async function actionAdminListTransactions(req) {
    await requireAdmin(req);

    const rows = await listAllRows(
        TABLES.transactions,
        [
            queryString("equal", "status", ["Pending"])
        ],
        5000
    );

    const transactions = rows
        .map(transactionForAdmin)
        .sort((a, b) =>
            String(b.timestamp).localeCompare(String(a.timestamp))
        );

    return { transactions };
}

async function actionApproveTransaction(req, data) {
    const { uid: adminUid } = await requireAdmin(req);

    const txId = cleanString(data?.txId, 100);
    const decision = cleanString(data?.decision, 30).toLowerCase();

    if (!txId) {
        throw new BackendError(
            "Transaction ID is required.",
            400,
            "TX_ID_REQUIRED"
        );
    }

    if (!["approve", "reject", "approved", "rejected"].includes(decision)) {
        throw new BackendError(
            "Invalid transaction decision.",
            400,
            "INVALID_DECISION"
        );
    }

    const approved = decision === "approve" || decision === "approved";

    const result = await withDbTransaction(async (transactionId) => {
        const tx = await getRow(TABLES.transactions, txId);

        if (String(tx.status) !== "Pending") {
            throw new BackendError(
                `Transaction is already ${tx.status}.`,
                409,
                "TRANSACTION_ALREADY_PROCESSED"
            );
        }

        const type = String(tx.type || "");
        const userId = String(tx.user_id ?? "");
        const amount = assertMoney(tx.amount, "transaction amount");

        if (!userId) {
            throw new BackendError(
                "Transaction has no user ID.",
                409,
                "TRANSACTION_USER_MISSING"
            );
        }

        const user = await findUserByUid(userId);
        if (!user) {
            throw new BackendError(
                "Transaction user no longer exists.",
                404,
                "TRANSACTION_USER_NOT_FOUND"
            );
        }

        if (type === "Deposit") {
            if (approved) {
                const profile = normalizeProfile(user);
                const newBalance = money(profile.balance + amount);
                const newDeposit = money(profile.depositBalance + amount);

                await updateRow(
                    TABLES.users,
                    user.$id,
                    {
                        balance: newBalance,
                        depositBalance: newDeposit
                    },
                    transactionId
                );

                await updateRow(
                    TABLES.transactions,
                    tx.$id,
                    {
                        status: "Approved"
                    },
                    transactionId
                );

                return {
                    status: "Approved",
                    balance: newBalance,
                    userId,
                    adminUid
                };
            }

            await updateRow(
                TABLES.transactions,
                tx.$id,
                {
                    status: "Rejected"
                },
                transactionId
            );

            return {
                status: "Rejected",
                userId,
                adminUid
            };
        }

        if (type === "Withdraw") {
            if (approved) {
                await updateRow(
                    TABLES.transactions,
                    tx.$id,
                    {
                        status: "Approved"
                    },
                    transactionId
                );

                return {
                    status: "Approved",
                    userId,
                    adminUid
                };
            }

            const profile = normalizeProfile(user);
            const refunded = refundWinningWallet(profile, amount);

            await updateRow(
                TABLES.users,
                user.$id,
                {
                    balance: refunded.balance,
                    winningBalance: refunded.winningBalance
                },
                transactionId
            );

            await updateRow(
                TABLES.transactions,
                tx.$id,
                {
                    status: "Rejected"
                },
                transactionId
            );

            return {
                status: "Rejected",
                refunded: amount,
                balance: refunded.balance,
                winningBalance: refunded.winningBalance,
                userId,
                adminUid
            };
        }

        throw new BackendError(
            `Transaction type "${type}" cannot be approved from this panel.`,
            400,
            "UNSUPPORTED_TRANSACTION_TYPE"
        );
    }, 60);

    return result;
}

const ACTIONS = {
    verifyAdmin: actionVerifyAdmin,
    getPlatformConfig: actionGetPlatformConfig,
    setPlatformConfig: actionSetPlatformConfig,
    getTournaments: actionGetTournaments,
    setTournaments: actionSetTournaments,
    createProfile: actionCreateProfile,
    getProfile: actionGetProfile,
    joinTournament: actionJoinTournament,
    adminListUsers: actionAdminListUsers,
    adminAddMoney: actionAdminAddMoney,
    submitDeposit: actionSubmitDeposit,
    requestWithdrawal: actionRequestWithdrawal,
    adminListTransactions: actionAdminListTransactions,
    approveTransaction: actionApproveTransaction
};

export default async ({ req, res, log, error }) => {
    const startedAt = Date.now();

    try {
        if (req?.method === "OPTIONS") {
            return res.send(
                "",
                204,
                {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "POST, OPTIONS",
                    "Access-Control-Allow-Headers":
                        "Content-Type, X-Appwrite-Project, X-Appwrite-User-JWT"
                }
            );
        }

        const body = parseBody(req);
        const action = cleanString(body?.action, 100);
        const data =
            body?.data && typeof body.data === "object"
                ? body.data
                : {};

        if (!action) {
            throw new BackendError(
                "Missing action.",
                400,
                "ACTION_REQUIRED"
            );
        }

        const handler = ACTIONS[action];
        if (!handler) {
            throw new BackendError(
                `Unsupported action: ${action}`,
                400,
                "UNKNOWN_ACTION"
            );
        }

        log?.(`Action ${action} started`);

        const result = await handler(req, data);

        log?.(`Action ${action} completed in ${Date.now() - startedAt}ms`);

        return res.json(
            {
                ok: true,
                data: result
            },
            200
        );
    } catch (err) {
        const status =
            err instanceof BackendError
                ? err.status
                : Number(err?.status) >= 400 && Number(err?.status) < 600
                    ? Number(err.status)
                    : 500;

        const message =
            err?.message ||
            err?.response?.message ||
            "Unexpected backend error.";

        error?.(
            `[${status}] ${message}${err?.stack ? `\n${err.stack}` : ""}`
        );

        return res.json(
            {
                ok: false,
                error: String(message),
                code:
                    err instanceof BackendError
                        ? err.code
                        : err?.type || "INTERNAL_SERVER_ERROR"
            },
            status
        );
    }
};
