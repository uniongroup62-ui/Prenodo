import { activeTenantSlugs, assertCronAuth, trackCronResponse } from "@/lib/cron";
import { dbExecute, dbQuery, tenantIdForSlug } from "@/lib/tenant-db";
import type { RowDataPacket } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Next port of cron/fidelity_reconcile_lots.php (uses app/lib/Fidelity.php).
//
// Realigns point_lots to the client points balance (clients.points). It does
// NOT change the balance — only the lots, so Booking/expiry views stay
// coherent after an upgrade/import. Per active tenant it collects clients with
// a non-zero balance OR residual lots, and for each one that is out of sync it
// runs Fidelity::reconcilePointLots.
//
// Every statement is scoped by tenant_id = ? (no withTenant / app.tenant_id).
// The MySQL->Postgres shim handles ? -> $n, backticks, etc. Numeric columns
// come back as strings (pg parsers); coerce with Number()/parseFloat.

const EPS = 0.0000001;

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

// Wall-time ROMA (audit 21/07): stessa convenzione businessNowDateTime del
// resto dell'app (i componenti locali del server su Amplify sono UTC).
import { businessNowDateTime } from "@/lib/business-datetime";
function nowString(): string {
  return businessNowDateTime();
}

type FidelitySettings = { enabled: boolean; expireEnabled: boolean; expireDays: number };

// Fidelity::settings() — only the keys the reconcile path needs.
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

// Fidelity::expiryBoundaryFromBaseTs — 23:59:59 of (base day + days).
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

// Fidelity::ensureLotsInitializedLocked — if the client has a balance but no
// lots at all, seed a single legacy lot for that balance.
async function ensureLotsInitialized(
  tenantId: number,
  clientId: number,
  currentBalance: number,
  now: string,
  settings: FidelitySettings,
): Promise<void> {
  const balance = normalizePoints(currentBalance);
  if (balance <= 0) return;
  try {
    const existing = await dbQuery<RowDataPacket[]>(
      "SELECT id FROM point_lots WHERE tenant_id = ? AND client_id = ? LIMIT 1",
      [tenantId, clientId],
    );
    if (existing.length) return;
    const expiresAt =
      settings.expireEnabled && settings.expireDays > 0 ? expiryBoundary(now, settings.expireDays) : null;
    await dbExecute(
      `INSERT INTO point_lots (tenant_id,client_id,transaction_id,source_type,source_id,earned_points,remaining_points,earned_at,expires_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [tenantId, clientId, null, "legacy", null, balance, balance, now, expiresAt],
    );
  } catch {
    // ignore
  }
}

type LotRow = { id: number; remaining_points: number };

// Port of Fidelity::reconcilePointLots. Realigns the non-lock lots to the
// desired balance (balance - locked points). Does NOT change clients.points,
// except the PHP normalizes a fractional balance to an integer — preserved.
// NOTE: the PHP uses a DB transaction + FOR UPDATE; the cron-shim has no shared
// transaction, so statements run sequentially (safe for a daily batch with no
// concurrent writers). Returns true if any lot was changed.
async function reconcilePointLots(
  tenantId: number,
  clientId: number,
  settings: FidelitySettings,
  now: string,
): Promise<boolean> {
  if (clientId <= 0) return false;
  let changed = false;

  try {
    const curRows = await dbQuery<RowDataPacket[]>(
      "SELECT points FROM clients WHERE tenant_id = ? AND id = ? LIMIT 1",
      [tenantId, clientId],
    );
    if (!curRows.length || curRows[0].points === null || curRows[0].points === undefined) return false;

    const balanceRaw = num(curRows[0].points);
    const balance = normalizePoints(balanceRaw);
    if (Math.abs(balanceRaw - balance) >= EPS) {
      await dbExecute("UPDATE clients SET points = ? WHERE tenant_id = ? AND id = ?", [balance, tenantId, clientId]);
    }

    await ensureLotsInitialized(tenantId, clientId, balance, now, settings);

    // Sum of currently-locked (frozen) points.
    let lockSum = 0;
    try {
      const rows = await dbQuery<RowDataPacket[]>(
        "SELECT COALESCE(SUM(remaining_points),0) AS s FROM point_lots WHERE tenant_id = ? AND client_id = ? AND remaining_points > 0 AND source_type LIKE 'lock@%'",
        [tenantId, clientId],
      );
      lockSum = normalizePoints(num(rows[0]?.s));
    } catch {
      lockSum = 0;
    }
    if (!Number.isFinite(lockSum) || lockSum < 0) lockSum = 0;

    const desiredNormal = normalizePoints(Math.max(0, balance - lockSum));

    let rows: LotRow[] = [];
    try {
      rows = (await dbQuery<RowDataPacket[]>(
        `SELECT id, remaining_points
           FROM point_lots
          WHERE tenant_id = ? AND client_id = ?
            AND remaining_points > 0
            AND (source_type IS NULL OR source_type NOT LIKE 'lock@%')
          ORDER BY earned_at ASC, id ASC`,
        [tenantId, clientId],
      )) as unknown as LotRow[];
    } catch {
      rows = [];
    }

    let actualNormal = 0;
    for (const r of rows) actualNormal += normalizePoints(num(r.remaining_points));

    const excess = normalizePoints(actualNormal - desiredNormal);
    if (excess >= 0.01) {
      // Too many normal points in lots: shave the excess off (FIFO).
      let remaining = excess;
      for (const r of rows) {
        if (remaining <= EPS) break;
        const lotId = Number(r.id ?? 0);
        const rem = normalizePoints(num(r.remaining_points));
        if (lotId <= 0 || rem <= EPS) continue;
        let take = Math.min(rem, remaining);
        take = normalizePoints(take);
        if (take <= EPS) continue;
        await dbExecute(
          "UPDATE point_lots SET remaining_points = GREATEST(remaining_points - ?, 0) WHERE tenant_id = ? AND id = ?",
          [take, tenantId, lotId],
        );
        remaining = normalizePoints(remaining - take);
        changed = true;
      }
    } else {
      // Too few normal points: top up with a single legacy lot.
      const missing = normalizePoints(desiredNormal - actualNormal);
      if (missing >= 0.01) {
        const expiresAt =
          settings.expireEnabled && settings.expireDays > 0 ? expiryBoundary(now, settings.expireDays) : null;
        await dbExecute(
          `INSERT INTO point_lots (tenant_id,client_id,transaction_id,source_type,source_id,earned_points,remaining_points,earned_at,expires_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [tenantId, clientId, null, "legacy", null, missing, missing, now, expiresAt],
        );
        changed = true;
      }
    }

    return changed;
  } catch {
    return false;
  }
}

// Per-tenant reconcile pass: mirror of the foreach body in
// cron/fidelity_reconcile_lots.php.
async function reconcileTenant(
  tenantId: number,
  settings: FidelitySettings,
  now: string,
  maxClients: number,
): Promise<{ checked: number; fixed: number }> {
  let limit = Math.trunc(maxClients);
  if (limit <= 0) limit = 5000;

  // Clients with balance != 0 OR with residual lots.
  let ids: number[] = [];
  try {
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT id FROM (
         SELECT c.id AS id FROM clients c WHERE c.tenant_id = ? AND c.points <> 0
         UNION
         SELECT l.client_id AS id FROM point_lots l WHERE l.tenant_id = ? AND COALESCE(l.remaining_points,0) > 0
       ) x
       ORDER BY id ASC
       LIMIT ${limit}`,
      [tenantId, tenantId],
    );
    const seen = new Set<number>();
    for (const r of rows) {
      const cid = Number(r.id ?? 0);
      if (cid > 0) seen.add(cid);
    }
    ids = [...seen];
  } catch {
    ids = [];
  }

  let checked = 0;
  let fixed = 0;

  for (const cid of ids) {
    checked++;

    // Best-effort needs-check: avoid touching clients already in sync.
    let needs = false;
    try {
      const balRows = await dbQuery<RowDataPacket[]>(
        "SELECT points FROM clients WHERE tenant_id = ? AND id = ? LIMIT 1",
        [tenantId, cid],
      );
      const balance = normalizePoints(num(balRows[0]?.points));

      let row: RowDataPacket | undefined;
      if (settings.expireEnabled) {
        const res = await dbQuery<RowDataPacket[]>(
          "SELECT COUNT(*) AS c, COALESCE(SUM(remaining_points),0) AS s FROM point_lots WHERE tenant_id = ? AND client_id = ? AND remaining_points > 0 AND (expires_at IS NULL OR expires_at >= ?)",
          [tenantId, cid, now],
        );
        row = res[0];
      } else {
        const res = await dbQuery<RowDataPacket[]>(
          "SELECT COUNT(*) AS c, COALESCE(SUM(remaining_points),0) AS s FROM point_lots WHERE tenant_id = ? AND client_id = ? AND remaining_points > 0",
          [tenantId, cid],
        );
        row = res[0];
      }
      const cnt = Number(row?.c ?? 0);
      const sum = round2(num(row?.s));
      const diff = round2(sum - balance);
      if ((cnt <= 0 && balance > 0.0000001) || Math.abs(diff) >= 0.01) {
        needs = true;
      }
    } catch {
      needs = false;
    }

    if (needs) {
      if (await reconcilePointLots(tenantId, cid, settings, now)) {
        fixed++;
      }
    }
  }

  return { checked, fixed };
}

async function handler(request: Request) {
  try {
    assertCronAuth(request);
  } catch {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  try {
    // Optional ?max=<n> cap (the PHP took it as an argv[1] CLI arg). Default 5000.
    let maxClients = 5000;
    const raw = new URL(request.url).searchParams.get("max");
    if (raw) {
      const v = Math.trunc(Number(raw));
      if (v > 0) maxClients = v;
    }

    const now = nowString();
    const slugs = await activeTenantSlugs();
    const results: Array<{ tenant: string; checked: number; fixed: number; skipped?: boolean }> = [];
    let totChecked = 0;
    let totFixed = 0;

    for (const slug of slugs) {
      // Isolamento per-tenant (audit 21/07): un tenant rotto non salta i successivi.
      try {
        const tenantId = await tenantIdForSlug(slug);
        if (!tenantId) continue;

        const settings = await fidelitySettings(tenantId);
        if (!settings.enabled) {
          results.push({ tenant: slug, checked: 0, fixed: 0, skipped: true });
          continue;
        }

        const { checked, fixed } = await reconcileTenant(tenantId, settings, now, maxClients);
        results.push({ tenant: slug, checked, fixed });
        totChecked += checked;
        totFixed += fixed;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[cron fidelity-reconcile-lots] tenant ${slug} FALLITO:`, msg);
        results.push({ tenant: slug, checked: 0, fixed: 0 });
      }
    }

    return Response.json({
      ok: true,
      job: "fidelity-reconcile-lots",
      total: totFixed,
      totalChecked: totChecked,
      results,
    });
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "Errore cron fidelity-reconcile-lots." },
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
  return trackCronResponse("fidelity-reconcile-lots", () => handler(request));
}
