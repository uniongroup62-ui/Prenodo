import "server-only";

// MOTORE POINT_LOTS — port of Fidelity.php (righe ~2138-3594): i lotti punti che
// rendono OPERATIVA la scadenza punti. clients.points resta la FONTE DI VERITÀ;
// i lotti sono il dettaglio (quando sono stati guadagnati i punti e quando
// scadono). Regole legacy:
//  - un lotto per ogni transazione earn positiva (INSERT IGNORE su
//    point_lots_uq_tx), expires_at = fine giornata (23:59:59) di
//    earned_at + expire_days quando la scadenza è attiva;
//  - i clienti con saldo ma senza lotti ricevono un lotto 'legacy' (init);
//  - i redeem consumano FIFO: prima i lock-lot, poi per scadenza crescente
//    (NULL per ultimi); con scadenza spenta solo earned_at ASC;
//  - la SCADENZA protegge i punti prenotati su appuntamenti aperti creati
//    prima di oggi: la quota protetta viene spostata in lock-lot
//    (source_type 'lock@YYYYMMDDHHMMSS', expires_at NULL); il lock in eccesso
//    torna in lotti 'unlock' con la scadenza originale; il resto scade con
//    una transazione kind='expire' source_type='lot' (dedup naturale su
//    transactions_uq_fid_src) + clients.points = GREATEST(points-rem, 0);
//  - reconcile riallinea i lotti normali a (saldo - lock) senza MAI toccare
//    clients.points (riduce FIFO o crea un lotto 'legacy');
//  - il salvataggio impostazioni scadenza riallinea i lotti aperti
//    (applyExpirySettingsToOpenLots).
// Nota tz: il legacy fissa Europe/Rome per i confini di giornata; qui si usa
// l'ora locale del server (coerente col resto del port) — stessa semantica
// "valido fino alle 23:59:59 del giorno".

import type { RowDataPacket } from "@/lib/tenant-db";
import { dbExecute, quoteIdentifier, tenantInsert, tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";

const LOCK_PREFIX = "lock@";

export type FidelityLotsSettings = { expireEnabled: boolean; expireDays: number; expireWarnDays: number };

const clean = (v: unknown) => String(v ?? "").trim();

function normPoints(value: unknown): number {
  const n = Number(value) || 0;
  return n >= 0 ? Math.floor(n + 1e-9) : Math.ceil(n - 1e-9);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toSql(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Inizio della giornata corrente ('YYYY-MM-DD 00:00:00') — cutoff scadenze.
export function lotsDayStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 00:00:00`;
}

// Fine giornata (23:59:59) del giorno base + N giorni (expiryBoundaryFromBaseTs).
export function lotsDayEndAfterDays(base: Date, days: number): string {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + Math.max(0, Math.round(days)), 23, 59, 59);
  return toSql(d);
}

function lockSourceFor(expiresAt: string | null): string {
  const m = clean(expiresAt).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return `${LOCK_PREFIX}00000000000000`;
  return `${LOCK_PREFIX}${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}`;
}

// parseLockExpiry: 'lock@YYYYMMDDHHMMSS' -> 'YYYY-MM-DD HH:MM:SS'. Metadato non
// parsabile -> "appena prima di adesso" (il lotto sbloccato scade al giro
// successivo — stesso fallback del cron/legacy).
function parseLockExpiry(sourceType: string): string {
  const st = clean(sourceType).toLowerCase();
  const justBeforeNow = toSql(new Date(Date.now() - 1000));
  if (!st.startsWith(LOCK_PREFIX)) return justBeforeNow;
  const raw = st.slice(LOCK_PREFIX.length);
  if (/^\d{14}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}`;
  }
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} 00:00:00`;
  }
  return justBeforeNow;
}

// Impostazioni scadenza lette direttamente da businesses (evita il ciclo di
// import con db-repositories).
export async function fidelityLotsSettings(slug: string): Promise<FidelityLotsSettings> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "businesses",
    columns: "fidelity_expire_enabled, fidelity_expire_days, fidelity_expire_warn_days",
    orderBy: "id ASC",
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  const r = rows[0] ?? ({} as RowDataPacket);
  return {
    expireEnabled: Number(r.fidelity_expire_enabled ?? 0) === 1,
    expireDays: Math.max(0, Math.min(36500, Math.round(Number(r.fidelity_expire_days ?? 365)))),
    expireWarnDays: Math.max(0, Math.min(36500, Math.round(Number(r.fidelity_expire_warn_days ?? 30)))),
  };
}

type LotRow = { id: number; sourceType: string; earnedAt: string; expiresAt: string | null; remaining: number };

async function clientBalance(slug: string, clientId: number): Promise<number> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "points", where: "id = ?", params: [clientId], limit: 1 }).catch(() => []);
  return normPoints(rows[0]?.points ?? 0);
}

async function loadLots(slug: string, clientId: number, where = "", params: unknown[] = []): Promise<LotRow[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "point_lots",
    columns: "id, source_type, earned_at, expires_at, remaining_points",
    where: `client_id = ? AND remaining_points > 0${where ? ` AND ${where}` : ""}`,
    params: [clientId, ...params],
    orderBy: "earned_at ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  return rows.map((r) => ({
    id: Number(r.id ?? 0),
    sourceType: clean(r.source_type),
    earnedAt: clean(r.earned_at),
    expiresAt: r.expires_at ? clean(r.expires_at) : null,
    remaining: normPoints(r.remaining_points ?? 0),
  }));
}

async function setLotRemaining(slug: string, lotId: number, remaining: number): Promise<void> {
  await tenantUpdate({ slug, table: "point_lots", id: lotId, values: { remaining_points: Math.max(0, remaining) } });
}

async function insertLot(
  slug: string,
  values: { clientId: number; transactionId?: number | null; sourceType: string; sourceId?: number | null; points: number; earnedAt?: Date; expiresAt?: string | null },
): Promise<number> {
  if (values.points <= 0) return 0;
  const table = await tenantTable(slug, "point_lots");
  try {
    return await tenantInsert(table, {
      client_id: values.clientId,
      transaction_id: values.transactionId ?? null,
      source_type: clean(values.sourceType).slice(0, 20) || "legacy",
      source_id: values.sourceId ?? null,
      earned_points: values.points,
      remaining_points: values.points,
      earned_at: values.earnedAt ?? new Date(),
      expires_at: values.expiresAt ?? null,
      created_at: new Date(),
    });
  } catch {
    // INSERT IGNORE semantics (point_lots_uq_tx): lotto già creato per questa transazione.
    return 0;
  }
}

// ensureLotsInitializedLocked (Fidelity.php ~3184): saldo > 0 senza lotti ->
// lotto 'legacy' con l'intero saldo.
export async function ensureLotsInitialized(slug: string, clientId: number, settings?: FidelityLotsSettings): Promise<void> {
  if (clientId <= 0) return;
  const balance = await clientBalance(slug, clientId);
  if (balance <= 0) return;
  const existing = await tenantSelect<RowDataPacket>({ slug, table: "point_lots", columns: "id", where: "client_id = ?", params: [clientId], limit: 1 }).catch(() => []);
  if (existing.length > 0) return;
  const s = settings ?? (await fidelityLotsSettings(slug));
  await insertLot(slug, {
    clientId,
    sourceType: "legacy",
    points: balance,
    expiresAt: s.expireEnabled && s.expireDays > 0 ? lotsDayEndAfterDays(new Date(), s.expireDays) : null,
  });
}

// applyLotsDeltaLocked (Fidelity.php ~3211): earn -> nuovo lotto; delta negativo
// -> consumo FIFO (o scala il lotto specifico per kind='expire' source='lot').
export async function applyLotsDelta(
  slug: string,
  input: { clientId: number; transactionId: number; kind: string; sourceType: string; sourceId?: number; delta: number },
  settings?: FidelityLotsSettings,
): Promise<void> {
  const delta = normPoints(input.delta);
  if (delta === 0 || input.clientId <= 0) return;
  const s = settings ?? (await fidelityLotsSettings(slug));

  if (delta > 0) {
    await insertLot(slug, {
      clientId: input.clientId,
      transactionId: input.transactionId > 0 ? input.transactionId : null,
      sourceType: clean(input.sourceType) || "manual",
      sourceId: input.sourceId && input.sourceId > 0 ? input.sourceId : null,
      points: delta,
      expiresAt: s.expireEnabled && s.expireDays > 0 ? lotsDayEndAfterDays(new Date(), s.expireDays) : null,
    });
    return;
  }

  // Scadenza mirata di un lotto specifico (transazione kind='expire' source 'lot').
  if (clean(input.kind) === "expire" && clean(input.sourceType) === "lot" && (input.sourceId ?? 0) > 0) {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "point_lots", columns: "id, remaining_points", where: "id = ? AND client_id = ?", params: [input.sourceId, input.clientId], limit: 1 }).catch(() => []);
    if (rows[0]) {
      await setLotRemaining(slug, Number(rows[0].id), normPoints(rows[0].remaining_points ?? 0) + delta);
    }
    return;
  }

  // Consumo FIFO: prima i lock-lot, poi scadenza crescente (NULL per ultimi);
  // con scadenza spenta solo earned_at ASC senza filtro data.
  let need = -delta;
  const lots = await loadLots(slug, input.clientId, s.expireEnabled ? `(source_type LIKE '${LOCK_PREFIX}%' OR expires_at IS NULL OR expires_at >= ?)` : "", s.expireEnabled ? [lotsDayStart()] : []);
  const ordered = s.expireEnabled
    ? [...lots].sort((a, b) => {
        const lockA = a.sourceType.startsWith(LOCK_PREFIX) ? 0 : 1;
        const lockB = b.sourceType.startsWith(LOCK_PREFIX) ? 0 : 1;
        if (lockA !== lockB) return lockA - lockB;
        const expA = a.expiresAt ?? "9999-12-31 23:59:59";
        const expB = b.expiresAt ?? "9999-12-31 23:59:59";
        if (expA !== expB) return expA < expB ? -1 : 1;
        if (a.earnedAt !== b.earnedAt) return a.earnedAt < b.earnedAt ? -1 : 1;
        return a.id - b.id;
      })
    : lots;
  for (const lot of ordered) {
    if (need <= 0) break;
    const take = Math.min(lot.remaining, need);
    if (take <= 0) continue;
    await setLotRemaining(slug, lot.id, lot.remaining - take);
    need -= take;
  }
}

// reservedPoints protetti dalla scadenza: prenotazioni APERTE create prima di
// oggi (Fidelity.php ~3395: a.created_at < dayStart — le prenotazioni nuove non
// "resuscitano" punti già scaduti).
async function protectedReservedPoints(slug: string, clientId: number): Promise<number> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointments",
    columns: "COALESCE(SUM(COALESCE(fidelity_points_used,0) + COALESCE(fidelity_gift_points_used,0)),0) AS s",
    where: "client_id = ? AND status IN ('pending','scheduled') AND created_at < ?",
    params: [clientId, lotsDayStart()],
  }).catch(() => [] as RowDataPacket[]);
  return Math.max(0, normPoints(rows[0]?.s ?? 0));
}

// expireDueLotsLocked + expireClientLots (Fidelity.php ~2237, ~3323): lock/unlock
// dei punti protetti + scadenza effettiva dei lotti scaduti. Ritorna i punti scaduti.
export async function expireClientLots(slug: string, clientId: number): Promise<number> {
  if (clientId <= 0) return 0;
  const s = await fidelityLotsSettings(slug);
  await ensureLotsInitialized(slug, clientId, s);
  const dayStart = lotsDayStart();

  const allLots = await loadLots(slug, clientId);
  const lockLots = allLots.filter((l) => l.sourceType.startsWith(LOCK_PREFIX));
  const expiredNormalLots = allLots.filter((l) => !l.sourceType.startsWith(LOCK_PREFIX) && l.expiresAt !== null && l.expiresAt < dayStart);

  const protectedReserved = await protectedReservedPoints(slug, clientId);
  const existingLocked = lockLots.reduce((sum, l) => sum + l.remaining, 0);
  const expiredNormal = expiredNormalLots.reduce((sum, l) => sum + l.remaining, 0);
  const requiredLocked = Math.min(protectedReserved, existingLocked + expiredNormal);

  // Sblocco dell'eccesso: dal lock-lot torna un lotto 'unlock' con la scadenza
  // originale (parsata dal metadato lock@...; source_id = id del lock-lot).
  let unlockNeed = existingLocked - requiredLocked;
  for (const lock of lockLots) {
    if (unlockNeed <= 0) break;
    const give = Math.min(lock.remaining, unlockNeed);
    if (give <= 0) continue;
    await setLotRemaining(slug, lock.id, lock.remaining - give);
    await insertLot(slug, { clientId, sourceType: "unlock", sourceId: lock.id, points: give, expiresAt: parseLockExpiry(lock.sourceType) });
    unlockNeed -= give;
  }

  // Lock aggiuntivi: la quota protetta viene spostata dai lotti scaduti (FIFO)
  // in lock-lot senza scadenza, col metadato della scadenza originale e
  // source_id = id del lotto d'origine.
  let lockNeed = requiredLocked - existingLocked;
  for (const lot of expiredNormalLots) {
    if (lockNeed <= 0) break;
    const take = Math.min(lot.remaining, lockNeed);
    if (take <= 0) continue;
    await setLotRemaining(slug, lot.id, lot.remaining - take);
    lot.remaining -= take;
    await insertLot(slug, { clientId, sourceType: lockSourceFor(lot.expiresAt), sourceId: lot.id, points: take, expiresAt: null });
    lockNeed -= take;
  }

  // Scadenza effettiva del residuo: transazione 'expire' per lotto (dedup su
  // transactions_uq_fid_src) + azzeramento lotto + clients.points clampato a 0.
  let expired = 0;
  const txTable = await tenantTable(slug, "transactions");
  const clientsTable = await tenantTable(slug, "clients");
  for (const lot of expiredNormalLots) {
    if (lot.remaining <= 0) continue;
    let txId = 0;
    try {
      txId = await tenantInsert(txTable, {
        client_id: clientId,
        kind: "expire",
        source_type: "lot",
        source_id: lot.id,
        delta_points: -lot.remaining,
        amount: null,
        note: "Scadenza punti",
        created_at: new Date(),
      });
    } catch {
      // già scaduto in un run precedente (vincolo unico) — idempotente.
      continue;
    }
    if (txId > 0) {
      await setLotRemaining(slug, lot.id, 0);
      await dbExecute(
        `UPDATE ${quoteIdentifier(clientsTable.name)} SET points = GREATEST(COALESCE(points,0) - ?, 0) WHERE tenant_id = ? AND id = ?`,
        [lot.remaining, clientsTable.tenantId ?? 0, clientId],
      );
      expired += lot.remaining;
    }
  }

  await reconcilePointLots(slug, clientId);
  return expired;
}

// reconcilePointLots (Fidelity.php ~2943): riallinea i lotti NORMALI a
// (saldo - lock) senza toccare clients.points. Ritorna true se ha modificato.
export async function reconcilePointLots(slug: string, clientId: number): Promise<boolean> {
  if (clientId <= 0) return false;
  const balance = await clientBalance(slug, clientId);
  const lots = await loadLots(slug, clientId);
  const lockSum = lots.filter((l) => l.sourceType.startsWith(LOCK_PREFIX)).reduce((s, l) => s + l.remaining, 0);
  const normalLots = lots.filter((l) => !l.sourceType.startsWith(LOCK_PREFIX));
  const normalSum = normalLots.reduce((s, l) => s + l.remaining, 0);
  const desired = Math.max(0, balance - lockSum);

  if (normalSum === desired) return false;
  if (normalSum > desired) {
    let excess = normalSum - desired;
    for (const lot of normalLots) {
      if (excess <= 0) break;
      const take = Math.min(lot.remaining, excess);
      await setLotRemaining(slug, lot.id, lot.remaining - take);
      excess -= take;
    }
    return true;
  }
  const s = await fidelityLotsSettings(slug);
  await insertLot(slug, {
    clientId,
    sourceType: "legacy",
    points: desired - normalSum,
    expiresAt: s.expireEnabled && s.expireDays > 0 ? lotsDayEndAfterDays(new Date(), s.expireDays) : null,
  });
  return true;
}

// expireDueLotsBatch (Fidelity.php ~2281): clienti con lotti scaduti o lock-lot,
// processati uno a uno. Ritorna i punti scaduti totali.
export async function expireDueLotsBatch(slug: string, maxClients = 200): Promise<number> {
  const cap = Math.max(1, Math.min(5000, maxClients));
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "point_lots",
    columns: "DISTINCT client_id",
    where: `remaining_points > 0 AND (expires_at < ? OR source_type LIKE '${LOCK_PREFIX}%')`,
    params: [lotsDayStart()],
    limit: cap,
  }).catch(() => [] as RowDataPacket[]);
  let expired = 0;
  for (const row of rows) {
    expired += await expireClientLots(slug, Number(row.client_id ?? 0)).catch(() => 0);
  }
  return expired;
}

// reconcileLotsBatch (cron fidelity_reconcile_lots.php): clienti con saldo o
// lotti, riallineati se saldo e somma lotti divergono. Ritorna {checked, fixed}.
export async function reconcileLotsBatch(slug: string, maxClients = 5000): Promise<{ checked: number; fixed: number }> {
  const cap = Math.max(1, Math.min(20000, maxClients));
  const s = await fidelityLotsSettings(slug);
  const balRows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "id, points", where: "COALESCE(points,0) <> 0", limit: cap }).catch(() => [] as RowDataPacket[]);
  const lotRows = await tenantSelect<RowDataPacket>({ slug, table: "point_lots", columns: "DISTINCT client_id", where: "remaining_points > 0", limit: cap }).catch(() => [] as RowDataPacket[]);
  const ids = [...new Set([...balRows.map((r) => Number(r.id ?? 0)), ...lotRows.map((r) => Number(r.client_id ?? 0))])].filter((n) => n > 0).sort((a, b) => a - b).slice(0, cap);

  let checked = 0;
  let fixed = 0;
  for (const clientId of ids) {
    checked += 1;
    const balance = await clientBalance(slug, clientId);
    const lots = await loadLots(slug, clientId, s.expireEnabled ? `(source_type LIKE '${LOCK_PREFIX}%' OR expires_at IS NULL OR expires_at >= ?)` : "", s.expireEnabled ? [lotsDayStart()] : []);
    const sum = lots.reduce((acc, l) => acc + l.remaining, 0);
    const needs = (lots.length <= 0 && balance > 0) || Math.abs(sum - balance) >= 0.01;
    if (!needs) continue;
    await ensureLotsInitialized(slug, clientId, s);
    if (await reconcilePointLots(slug, clientId).catch(() => false)) fixed += 1;
  }
  return { checked, fixed };
}

// applyExpirySettingsToOpenLots (Fidelity.php ~3074): al salvataggio delle
// impostazioni scadenza riallinea i lotti aperti (non-lock) alla nuova scadenza
// (o NULL se disattivata) e aggiorna il metadato dei lock-lot; poi reconcile.
export async function applyExpirySettingsToOpenLots(slug: string, expireEnabled: boolean, expireDays: number): Promise<{ updatedLots: number; updatedLocks: number; reconciledClients: number; expiresAt: string | null }> {
  const table = await tenantTable(slug, "point_lots");
  const newExpiry = expireEnabled && expireDays > 0 ? lotsDayEndAfterDays(new Date(), expireDays) : null;

  const lotsRes = await dbExecute(
    `UPDATE ${quoteIdentifier(table.name)} SET expires_at = ? WHERE tenant_id = ? AND remaining_points > 0 AND (source_type IS NULL OR source_type NOT LIKE '${LOCK_PREFIX}%')`,
    [newExpiry, table.tenantId ?? 0],
  ).catch(() => ({ affectedRows: 0 }));
  const updatedLots = Number(lotsRes.affectedRows ?? 0) || 0;

  let updatedLocks = 0;
  if (newExpiry) {
    const locksRes = await dbExecute(
      `UPDATE ${quoteIdentifier(table.name)} SET source_type = ? WHERE tenant_id = ? AND remaining_points > 0 AND source_type LIKE '${LOCK_PREFIX}%'`,
      [lockSourceFor(newExpiry).slice(0, 20), table.tenantId ?? 0],
    ).catch(() => ({ affectedRows: 0 }));
    updatedLocks = Number(locksRes.affectedRows ?? 0) || 0;
  }

  const clientRows = await tenantSelect<RowDataPacket>({ slug, table: "point_lots", columns: "DISTINCT client_id", where: "remaining_points > 0" }).catch(() => [] as RowDataPacket[]);
  let reconciled = 0;
  for (const row of clientRows) {
    if (await reconcilePointLots(slug, Number(row.client_id ?? 0)).catch(() => false)) reconciled += 1;
  }
  return { updatedLots: Number(updatedLots) || 0, updatedLocks: Number(updatedLocks) || 0, reconciledClients: reconciled, expiresAt: newExpiry };
}

// expiringSoonPoints (Fidelity.php ~2875): punti in scadenza entro N giorni.
export async function expiringSoonPoints(slug: string, clientId: number, withinDays?: number): Promise<number> {
  const s = await fidelityLotsSettings(slug);
  if (!s.expireEnabled || clientId <= 0) return 0;
  const days = Math.max(0, Math.round(withinDays ?? s.expireWarnDays));
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "point_lots",
    columns: "COALESCE(SUM(remaining_points),0) AS s",
    where: `client_id = ? AND remaining_points > 0 AND source_type NOT LIKE '${LOCK_PREFIX}%' AND expires_at IS NOT NULL AND expires_at >= ? AND expires_at <= ?`,
    params: [clientId, lotsDayStart(), lotsDayEndAfterDays(new Date(), days)],
  }).catch(() => [] as RowDataPacket[]);
  return Math.max(0, normPoints(rows[0]?.s ?? 0));
}

export type PointLotScheduleRow = { lotId: number; sourceType: string; isLock: boolean; earnedAt: string; expiresAt: string | null; remaining: number; expired: boolean };

// Calendario scadenze per il wallet: i lotti residui del cliente.
export async function pointLotsSchedule(slug: string, clientId: number): Promise<PointLotScheduleRow[]> {
  if (clientId <= 0) return [];
  const dayStart = lotsDayStart();
  const lots = await loadLots(slug, clientId);
  return lots
    .map((l) => ({
      lotId: l.id,
      sourceType: l.sourceType,
      isLock: l.sourceType.startsWith(LOCK_PREFIX),
      earnedAt: l.earnedAt,
      expiresAt: l.expiresAt,
      remaining: l.remaining,
      expired: l.expiresAt !== null && l.expiresAt < dayStart && !l.sourceType.startsWith(LOCK_PREFIX),
    }))
    .sort((a, b) => {
      const expA = a.expiresAt ?? "9999-12-31";
      const expB = b.expiresAt ?? "9999-12-31";
      if (expA !== expB) return expA < expB ? -1 : 1;
      return a.lotId - b.lotId;
    });
}
