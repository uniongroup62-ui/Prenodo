import { businessNowDateTime } from "@/lib/business-datetime";
import { activeTenantSlugs, assertCronAuth, trackCronResponse } from "@/lib/cron";
import { giftExpireDueInstancesBatch } from "@/lib/gifts-engine";
import { dbExecute, dbQuery, tenantIdForSlug } from "@/lib/tenant-db";
import type { RowDataPacket } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Next port of cron/fidelity_expire.php (uses app/lib/Fidelity.php).
//
// Per active tenant it:
//   1) syncs expired Fidelity card statuses (cards table) — best-effort;
//   2) expires due point lots in batch (Fidelity::expireDueLotsBatch ->
//      expireClientLots -> expireDueLotsLocked), writing `expire` transactions,
//      zeroing the expired lots and decreasing the client points balance.
//
//   3) expires due GIFT instances (Gifts::expireDueInstancesBatch via
//      lib/gifts-engine.giftExpireDueInstancesBatch) — best-effort like the
//      legacy cron's try/catch: 'disponibile' oltre expires_at -> 'scaduto',
//      annullando le prenotazioni pending/scheduled collegate all'istanza.
//
// Every statement is scoped by tenant_id = ? (no withTenant / app.tenant_id).
// MySQL -> Postgres: handled by the tenant-db shim (? -> $n, backticks, etc.).
// Numeric/date columns come back as strings (pg type parsers), so we coerce
// with Number()/parseFloat where needed. `INSERT IGNORE` -> `ON CONFLICT ... DO
// NOTHING` against the transactions_uq_fid_src unique index.

const EPS = 0.0000001;

// Mirror of Fidelity::normalizePoints — points are always integers.
function normalizePoints(points: number): number {
  if (!Number.isFinite(points)) return 0;
  if (points > 0) return Math.floor(points + 0.000000001);
  if (points < 0) return Math.ceil(points - 0.000000001);
  return 0;
}

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : 0;
}

// Wall-time ROMA (audit 21/07): coi componenti locali del server (UTC su
// Amplify) tra le 00:00 e le 02:00 di Roma i lotti scadevano col giorno
// sbagliato — stessa convenzione businessNowDateTime del resto dell'app.
function nowString(): string {
  return businessNowDateTime();
}

// Start of the current calendar day (Fidelity::dayStart) — scadenza is
// evaluated per calendar day: a lot is valid until 23:59:59 of expires_at.
function dayStartString(): string {
  return `${businessNowDateTime().slice(0, 10)} 00:00:00`;
}

// Fidelity::settings() — only the keys the expiry path needs.
type FidelitySettings = { enabled: boolean; expireEnabled: boolean; expireDays: number };

async function fidelitySettings(tenantId: number): Promise<FidelitySettings> {
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT fidelity_enabled, fidelity_points_enabled, fidelity_expire_enabled, fidelity_expire_days FROM businesses WHERE tenant_id = ? ORDER BY id ASC LIMIT 1",
    [tenantId],
  );
  const row = rows[0] ?? {};
  const globalEnabled = !!Number(row.fidelity_enabled ?? 0);
  const pointsEnabled =
    row.fidelity_points_enabled === undefined ? true : !!Number(row.fidelity_points_enabled ?? 0);
  let expireDays = Number(row.fidelity_expire_days ?? 365) || 0;
  if (expireDays < 0) expireDays = 0;
  if (expireDays > 36500) expireDays = 36500;
  return {
    enabled: globalEnabled && pointsEnabled,
    expireEnabled: !!Number(row.fidelity_expire_enabled ?? 0),
    expireDays,
  };
}

// Fidelity::pendingReservedStatusSql — appointment statuses whose points are
// still "reserved" (not yet earned/expired).
const PENDING_RESERVED_STATUSES = [
  "pending",
  "scheduled",
  "in sospeso",
  "in attesa",
  "attesa",
  "prenotato",
  "prenotata",
  "confirmed",
  "confermato",
  "confermata",
  "approved",
  "booked",
];

function pendingReservedStatusSql(alias = ""): string {
  const col = alias ? `${alias}.status` : "status";
  const quoted = PENDING_RESERVED_STATUSES.map((s) => `'${s.replace(/'/g, "''")}'`).join(",");
  return `LOWER(TRIM(COALESCE(${col},''))) IN (${quoted})`;
}

// Fidelity::reservedPoints — points reserved by pending appointments.
async function reservedPoints(tenantId: number, clientId: number, hasGiftCol: boolean): Promise<number> {
  const giftExpr = hasGiftCol ? "COALESCE(a.fidelity_gift_points_used,0)" : "0";
  try {
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT COALESCE(SUM(COALESCE(a.fidelity_points_used,0) + ${giftExpr}),0) AS s
         FROM appointments a
        WHERE a.tenant_id = ? AND a.client_id = ? AND ${pendingReservedStatusSql("a")}`,
      [tenantId, clientId],
    );
    return Math.max(0, normalizePoints(num(rows[0]?.s)));
  } catch {
    return 0;
  }
}

// lock@YYYYMMDDHHMMSS source marker for frozen (reserved) expired points.
function mkLockSource(expiresAt: string | null): string {
  const d = expiresAt ? new Date(expiresAt.replace(" ", "T")) : new Date();
  const base = Number.isNaN(d.getTime()) ? new Date() : d;
  const p = (x: number) => String(x).padStart(2, "0");
  return `lock@${base.getFullYear()}${p(base.getMonth() + 1)}${p(base.getDate())}${p(base.getHours())}${p(base.getMinutes())}${p(base.getSeconds())}`;
}

function parseLockExpiry(sourceType: string | null, justBeforeNow: string): string {
  const st = String(sourceType ?? "").trim().toLowerCase();
  if (!st.startsWith("lock@")) return justBeforeNow;
  const raw = st.slice(5);
  if (/^\d{14}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}`;
  }
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} 00:00:00`;
  }
  return justBeforeNow;
}

type LotRow = { id: number; remaining_points: number; earned_at: string | null; source_type: string | null; expires_at: string | null };

// Port of Fidelity::expireClientLots + expireDueLotsLocked for a single client.
// NOTE: the PHP version runs inside a DB transaction with row-level FOR UPDATE
// locks. The cron-shim has no shared transaction, so we run the same statements
// sequentially. For a once-a-day batch with no concurrent writers this is
// behaviorally equivalent; the lock-lot bookkeeping order is preserved exactly.
async function expireClientLots(
  tenantId: number,
  clientId: number,
  settings: FidelitySettings,
  hasGiftCol: boolean,
): Promise<number> {
  if (clientId <= 0) return 0;
  if (!settings.enabled || !settings.expireEnabled) return 0;

  const now = nowString();
  const dayStart = dayStartString();
  // dayStart - 1 secondo = 23:59:59 del giorno prima, aritmetica PURA sui
  // componenti wall-time (Date.UTC come calcolatrice, nessuna timezone).
  const m = /^(\d{4})-(\d{2})-(\d{2}) /.exec(dayStart);
  const prev = new Date(Date.UTC(Number(m?.[1] ?? 0), Number(m?.[2] ?? 1) - 1, Number(m?.[3] ?? 1)) - 1000);
  const p = (x: number) => String(x).padStart(2, "0");
  const justBeforeNow = `${prev.getUTCFullYear()}-${p(prev.getUTCMonth() + 1)}-${p(prev.getUTCDate())} 23:59:59`;

  let expired = 0;

  // ensureLotsInitializedLocked: if the client has a balance but no lots yet,
  // seed a single legacy lot so expiry has something to work on.
  const curRows = await dbQuery<RowDataPacket[]>(
    "SELECT points FROM clients WHERE tenant_id = ? AND id = ? LIMIT 1",
    [tenantId, clientId],
  );
  if (!curRows.length || curRows[0].points === null || curRows[0].points === undefined) return 0;
  const curPts = normalizePoints(num(curRows[0].points));
  if (curPts > 0) {
    const existing = await dbQuery<RowDataPacket[]>(
      "SELECT id FROM point_lots WHERE tenant_id = ? AND client_id = ? LIMIT 1",
      [tenantId, clientId],
    );
    if (!existing.length) {
      const expiresAt =
        settings.expireEnabled && settings.expireDays > 0 ? expiryBoundary(now, settings.expireDays) : null;
      await dbExecute(
        `INSERT INTO point_lots (tenant_id,client_id,transaction_id,source_type,source_id,earned_points,remaining_points,earned_at,expires_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [tenantId, clientId, null, "legacy", null, curPts, curPts, now, expiresAt],
      );
    }
  }

  // --- expireDueLotsLocked ---
  // 0) reserved points (pending appointments) must not expire.
  const reserved = round2(Math.max(0, await reservedPoints(tenantId, clientId, hasGiftCol)));

  // 1) protected reserved = appointments already pending at the start of the day.
  let protectedReserved = reserved;
  try {
    const giftExpr = hasGiftCol ? "COALESCE(a.fidelity_gift_points_used,0)" : "0";
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT COALESCE(SUM(COALESCE(a.fidelity_points_used,0) + ${giftExpr}),0) AS s
         FROM appointments a
        WHERE a.tenant_id = ? AND a.client_id = ?
          AND ${pendingReservedStatusSql("a")}
          AND (COALESCE(a.fidelity_points_used,0) + ${giftExpr}) > 0
          AND a.created_at < ?`,
      [tenantId, clientId, dayStart],
    );
    protectedReserved = num(rows[0]?.s);
  } catch {
    protectedReserved = reserved;
  }
  protectedReserved = normalizePoints(Math.max(0, Math.min(reserved, protectedReserved)));

  // expired normal points still available to be frozen.
  let expiredNormal = 0;
  try {
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT COALESCE(SUM(remaining_points),0) AS s
         FROM point_lots
        WHERE tenant_id = ? AND client_id = ?
          AND remaining_points > 0
          AND expires_at IS NOT NULL AND expires_at < ?
          AND (source_type IS NULL OR source_type NOT LIKE 'lock@%')`,
      [tenantId, clientId, dayStart],
    );
    expiredNormal = num(rows[0]?.s);
  } catch {
    expiredNormal = 0;
  }
  expiredNormal = normalizePoints(Math.max(0, expiredNormal));

  // 2) existing lock-lots (frozen expired points).
  let lockedLots: LotRow[] = [];
  try {
    lockedLots = (await dbQuery<RowDataPacket[]>(
      `SELECT id, remaining_points, earned_at, source_type
         FROM point_lots
        WHERE tenant_id = ? AND client_id = ?
          AND remaining_points > 0
          AND source_type LIKE 'lock@%'
        ORDER BY earned_at ASC, id ASC`,
      [tenantId, clientId],
    )) as unknown as LotRow[];
  } catch {
    lockedLots = [];
  }
  let existingLocked = 0;
  for (const ll of lockedLots) existingLocked += normalizePoints(num(ll.remaining_points));
  existingLocked = normalizePoints(Math.max(0, existingLocked));

  const requiredLocked = normalizePoints(Math.min(protectedReserved, existingLocked + expiredNormal));

  // 3) unlock the excess of frozen points (back to normal lots, original expiry).
  if (existingLocked > requiredLocked + EPS) {
    let toUnlock = normalizePoints(existingLocked - requiredLocked);
    for (const ll of lockedLots) {
      if (toUnlock <= EPS) break;
      const lockLotId = Number(ll.id ?? 0);
      const remLock = normalizePoints(num(ll.remaining_points));
      if (lockLotId <= 0 || remLock <= EPS) continue;
      let take = Math.min(remLock, toUnlock);
      take = normalizePoints(take);
      if (take <= EPS) continue;
      const earnedAt = String(ll.earned_at ?? now);
      const expAt = parseLockExpiry(ll.source_type, justBeforeNow);
      await dbExecute(
        `INSERT INTO point_lots (tenant_id,client_id,transaction_id,source_type,source_id,earned_points,remaining_points,earned_at,expires_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [tenantId, clientId, null, "unlock", lockLotId, take, take, earnedAt, expAt],
      );
      await dbExecute(
        "UPDATE point_lots SET remaining_points = GREATEST(remaining_points - ?, 0) WHERE tenant_id = ? AND id = ?",
        [take, tenantId, lockLotId],
      );
      toUnlock = normalizePoints(toUnlock - take);
    }
    existingLocked = requiredLocked;
  }

  // 4) freeze more expired-normal points into lock-lots if reservation needs it (FIFO).
  if (existingLocked + EPS < requiredLocked) {
    let needLock = normalizePoints(requiredLocked - existingLocked);
    let expLots: LotRow[] = [];
    try {
      expLots = (await dbQuery<RowDataPacket[]>(
        `SELECT id, remaining_points, earned_at, expires_at
           FROM point_lots
          WHERE tenant_id = ? AND client_id = ?
            AND remaining_points > 0
            AND expires_at IS NOT NULL AND expires_at < ?
            AND (source_type IS NULL OR source_type NOT LIKE 'lock@%')
          ORDER BY expires_at ASC, earned_at ASC, id ASC`,
        [tenantId, clientId, dayStart],
      )) as unknown as LotRow[];
    } catch {
      expLots = [];
    }
    for (const l of expLots) {
      if (needLock <= EPS) break;
      const lotId = Number(l.id ?? 0);
      const rem = normalizePoints(num(l.remaining_points));
      if (lotId <= 0 || rem <= EPS) continue;
      let take = Math.min(rem, needLock);
      take = normalizePoints(take);
      if (take <= EPS) continue;
      const earnedAt = String(l.earned_at ?? now);
      const expiresAt = String(l.expires_at ?? justBeforeNow);
      await dbExecute(
        `INSERT INTO point_lots (tenant_id,client_id,transaction_id,source_type,source_id,earned_points,remaining_points,earned_at,expires_at)
         VALUES (?,?,?,?,?,?,?,?,NULL)`,
        [tenantId, clientId, null, mkLockSource(expiresAt), lotId, take, take, earnedAt],
      );
      await dbExecute(
        "UPDATE point_lots SET remaining_points = GREATEST(remaining_points - ?, 0) WHERE tenant_id = ? AND id = ?",
        [take, tenantId, lotId],
      );
      needLock = normalizePoints(needLock - take);
      existingLocked = normalizePoints(existingLocked + take);
    }
  }

  // 5) expire the remaining (non-frozen) due lots.
  const dueLots = (await dbQuery<RowDataPacket[]>(
    `SELECT id, remaining_points
       FROM point_lots
      WHERE tenant_id = ? AND client_id = ?
        AND remaining_points > 0
        AND expires_at IS NOT NULL AND expires_at < ?
        AND (source_type IS NULL OR source_type NOT LIKE 'lock@%')
      ORDER BY expires_at ASC, earned_at ASC, id ASC`,
    [tenantId, clientId, dayStart],
  )) as unknown as LotRow[];

  for (const l of dueLots) {
    const lotId = Number(l.id ?? 0);
    const rem = normalizePoints(num(l.remaining_points));
    if (lotId <= 0 || rem <= EPS) continue;

    // Idempotent per lot via transactions_uq_fid_src
    // (tenant_id,client_id,kind,source_type,source_id).
    // TODO: appendLocationColumns() (location_id/location_name on the
    // transaction) is not ported — those columns are nullable and the cron
    // movement has no location context, so they stay NULL, matching the
    // behavior when no location is resolved.
    const ins = await dbExecute(
      `INSERT INTO transactions (tenant_id,client_id,kind,source_type,source_id,delta_points,amount,note,created_by)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT (tenant_id,client_id,kind,source_type,source_id) DO NOTHING`,
      [tenantId, clientId, "expire", "lot", lotId, -rem, null, "Scadenza punti", null],
    );
    if (ins.affectedRows > 0) {
      await dbExecute("UPDATE point_lots SET remaining_points = 0 WHERE tenant_id = ? AND id = ?", [tenantId, lotId]);
      await dbExecute(
        "UPDATE clients SET points = GREATEST(points - ?, 0) WHERE tenant_id = ? AND id = ?",
        [rem, tenantId, clientId],
      );
      expired += rem;
    }
  }

  return round2(expired);
}

function expiryBoundary(now: string, days: number): string | null {
  const d = Math.max(0, Math.min(36500, Math.trunc(days)));
  if (d <= 0) return null;
  const base = new Date(now.replace(" ", "T"));
  if (Number.isNaN(base.getTime())) return null;
  base.setHours(0, 0, 0, 0);
  base.setDate(base.getDate() + d);
  base.setHours(23, 59, 59, 0);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${base.getFullYear()}-${p(base.getMonth() + 1)}-${p(base.getDate())} ${p(base.getHours())}:${p(base.getMinutes())}:${p(base.getSeconds())}`;
}

// Fidelity::expireDueLotsBatch — find clients with due lots / lock-lots and
// process each. maxClients clamped like the PHP (1..5000), default 500 as the
// cron passes.
async function expireDueLotsBatch(
  tenantId: number,
  settings: FidelitySettings,
  hasGiftCol: boolean,
  maxClients = 500,
): Promise<number> {
  let limit = Math.trunc(maxClients);
  if (limit <= 0) limit = 200;
  if (limit > 5000) limit = 5000;
  if (!settings.enabled || !settings.expireEnabled) return 0;

  const dayStart = dayStartString();
  let ids: number[] = [];
  try {
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT DISTINCT client_id
         FROM point_lots
        WHERE tenant_id = ?
          AND remaining_points > 0
          AND ((expires_at IS NOT NULL AND expires_at < ?) OR (source_type LIKE 'lock@%'))
        ORDER BY client_id ASC
        LIMIT ${limit}`,
      [tenantId, dayStart],
    );
    ids = rows.map((r) => Number(r.client_id ?? 0)).filter((id) => id > 0);
  } catch {
    ids = [];
  }

  let tot = 0;
  for (const cid of ids) {
    tot += await expireClientLots(tenantId, cid, settings, hasGiftCol);
  }
  return round2(tot);
}

// fidelity_card_sync_expired_statuses (Helpers.php): mark cards whose expiry is
// in the past as inactive. Best-effort; columns are probed for compatibility.
// Returns number of cards updated.
async function syncExpiredCardStatuses(tenantId: number): Promise<number> {
  // probe table + columns
  const hasExpiresAt = await columnExistsLive("cards", "expires_at");
  const expiryCol = hasExpiresAt ? "expires_at" : (await columnExistsLive("cards", "expiry_date")) ? "expiry_date" : null;
  if (!expiryCol) return 0;
  const hasStatus = await columnExistsLive("cards", "status");
  const hasIsActive = await columnExistsLive("cards", "is_active");
  if (!hasStatus && !hasIsActive) return 0;

  const today = nowString().slice(0, 10);
  const sets: string[] = [];
  const stateWhere: string[] = [];
  if (hasStatus) {
    sets.push("status='inactive'");
    stateWhere.push("COALESCE(NULLIF(TRIM(status), ''), 'active') <> 'inactive'");
  }
  if (hasIsActive) {
    sets.push("is_active=0");
    stateWhere.push("COALESCE(is_active,1) <> 0");
  }
  if (!sets.length || !stateWhere.length) return 0;

  try {
    const res = await dbExecute(
      `UPDATE cards SET ${sets.join(", ")}
        WHERE tenant_id = ? AND ${expiryCol} IS NOT NULL AND DATE(${expiryCol}) < ?
          AND (${stateWhere.join(" OR ")})`,
      [tenantId, today],
    );
    // TODO: fidelity_card_release_pending_appointment_discounts_for_clients()
    // (releasing reserved points/discounts on pending appointments of clients
    // whose card just expired) is not ported. It is gated by
    // fidelity_card_expiry_enabled() (a JSON-config flag) and is a deep
    // best-effort cascade; the legacy cron also wraps it in try/catch. The core
    // card-status sync above is faithfully ported.
    return res.affectedRows;
  } catch {
    return 0;
  }
}

// Live column probe (the shim's columnExists targets current_schema()).
async function columnExistsLive(table: string, column: string): Promise<boolean> {
  try {
    const rows = await dbQuery<RowDataPacket[]>(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ? LIMIT 1",
      [table, column],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function handler(request: Request) {
  try {
    assertCronAuth(request);
  } catch {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    const slugs = await activeTenantSlugs();
    const results: Array<{ tenant: string; expired: number; cardsExpired: number; giftsExpired: number }> = [];
    let total = 0;

    // gift_points_used column is present in the migrated schema; detect once.
    const hasGiftCol = await columnExistsLive("appointments", "fidelity_gift_points_used");

    for (const slug of slugs) {
      // Isolamento per-tenant (audit 21/07): un tenant rotto non salta i successivi.
      try {
        const tenantId = await tenantIdForSlug(slug);
        if (!tenantId) continue;

        let cardsExpired = 0;
        try {
          cardsExpired = await syncExpiredCardStatuses(tenantId);
        } catch {
          cardsExpired = 0;
        }

        const settings = await fidelitySettings(tenantId);
        const expired = await expireDueLotsBatch(tenantId, settings, hasGiftCol, 500);

        // Scadenza istanze omaggio (legacy cron: try { Gifts::expireDueInstancesBatch }).
        let giftsExpired = 0;
        try {
          giftsExpired = (await giftExpireDueInstancesBatch(slug, 500)).expired;
        } catch {
          giftsExpired = 0;
        }

        results.push({ tenant: slug, expired, cardsExpired, giftsExpired });
        total += expired;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[cron fidelity-expire] tenant ${slug} FALLITO:`, msg);
        results.push({ tenant: slug, expired: 0, cardsExpired: 0, giftsExpired: 0 });
      }
    }

    return Response.json({
      ok: true,
      job: "fidelity-expire",
      total,
      results,
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore cron fidelity-expire." },
      { status: 500 },
    );
  }
}

export const POST = GET;

// Registro cron (Fase C pannello, 2026-07-19): auth PRIMA del tracking, poi
// l'esecuzione viene registrata in saas_cron_runs (esito, durata, sintesi).
export async function GET(request: Request) {
  try {
    assertCronAuth(request);
  } catch {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  return trackCronResponse("fidelity-expire", () => handler(request));
}
