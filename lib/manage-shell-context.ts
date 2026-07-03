import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { columnExists, dbQuery, tenantSelect, tenantTable } from "@/lib/tenant-db";
import { can, canAny } from "@/lib/role-permissions";
import type { ManageUser } from "@/lib/manage-auth";

// Faithful port of View::notificationSummary() (app/lib/View.php lines 67-193)
// plus the topbar closure-range / support-access context (View.php lines
// 207-304). Everything is tenant-scoped through the Next data layer and
// tolerant of missing columns/tables, exactly like the legacy app_* helpers.

export type ShellNotificationSummary = {
  count: number;
  appointments: number;
  quotes: number;
  installments: number;
  birthdays: number;
  fidelity_cards: number;
};

export type ShellSupportAccess = {
  created_by_email: string;
  reason: string;
  expires_at: string;
} | null;

export type ShellClosureRange = { start: string; end: string } | null;

export type ShellContext = {
  notif: ShellNotificationSummary;
  supportAccess: ShellSupportAccess;
  closureRange: ShellClosureRange;
};

const EMPTY_SUMMARY: ShellNotificationSummary = {
  count: 0,
  appointments: 0,
  quotes: 0,
  installments: 0,
  birthdays: 0,
  fidelity_cards: 0,
};

// Tenant-aware column probe: resolves the (possibly prefixed/shared) physical
// table name, then checks the column. Returns false if the table is missing.
export async function tenantColumnExists(slug: string, table: string, column: string): Promise<boolean> {
  try {
    const target = await tenantTable(slug, table);
    return await columnExists(target.name, column);
  } catch {
    return false;
  }
}

export async function tenantTableExists(slug: string, table: string): Promise<boolean> {
  try {
    await tenantTable(slug, table);
    return true;
  } catch {
    return false;
  }
}

// Read an alert-days setting (installment_alert_days / client_birthday_alert_days)
// from automation_settings, mirroring installment_notification_days() /
// client_birthday_notification_days(): default 7, clamped to 0..365.
export async function automationAlertDays(slug: string, column: string): Promise<number> {
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "automation_settings",
      columns: column,
      orderBy: "id ASC",
      limit: 1,
    });
    const raw = rows[0]?.[column];
    if (raw === undefined || raw === null || raw === "") return 7;
    let days = Number.parseInt(String(raw), 10);
    if (!Number.isFinite(days)) return 7;
    if (days < 0) days = 0;
    if (days > 365) days = 365;
    return days;
  } catch {
    return 7;
  }
}

// Tenant scoping fragment for a RAW dbQuery on a shared-tenant table. Returns the SQL
// to AND into the WHERE plus its param, or empty when the table is single-tenant / has
// no tenant_id column. Without this a raw COUNT(*) aggregates ACROSS every tenant in
// the shared-schema DB (cross-tenant leak); tenantSelect already scopes automatically.
async function tenantScope(slug: string, table: string, alias?: string): Promise<{ sql: string; params: number[] }> {
  try {
    const target = await tenantTable(slug, table);
    if (target.mode === "shared" && target.tenantId && (await columnExists(target.name, "tenant_id"))) {
      return { sql: ` AND ${alias ? `${alias}.` : ""}tenant_id = ?`, params: [target.tenantId] };
    }
  } catch {
    // best effort like the rest of this file — fall back to unscoped
  }
  return { sql: "", params: [] };
}

export async function countPendingAppointments(slug: string, currentLocationId: number): Promise<number> {
  try {
    const scope = await tenantScope(slug, "appointments", "a");
    if (currentLocationId > 0) {
      const hasApptLocation = await tenantColumnExists(slug, "appointments", "location_id");
      const hasBridge =
        (await tenantTableExists(slug, "appointment_locations")) &&
        (await tenantColumnExists(slug, "appointment_locations", "appointment_id")) &&
        (await tenantColumnExists(slug, "appointment_locations", "location_id"));

      if (hasApptLocation && hasBridge) {
        const rows = await dbQuery<RowDataPacket[]>(
          `SELECT COUNT(*) c
             FROM appointments a
            WHERE a.status='pending'
              AND (a.location_id=? OR (a.location_id IS NULL AND (EXISTS (SELECT 1 FROM appointment_locations al WHERE al.appointment_id=a.id AND al.location_id=?) OR NOT EXISTS (SELECT 1 FROM appointment_locations al2 WHERE al2.appointment_id=a.id))))${scope.sql}`,
          [currentLocationId, currentLocationId, ...scope.params],
        );
        return Number(rows[0]?.c ?? 0);
      }
      if (hasApptLocation) {
        const rows = await dbQuery<RowDataPacket[]>(
          `SELECT COUNT(*) c FROM appointments a WHERE a.status='pending' AND (a.location_id=? OR a.location_id IS NULL)${scope.sql}`,
          [currentLocationId, ...scope.params],
        );
        return Number(rows[0]?.c ?? 0);
      }
      if (hasBridge) {
        const rows = await dbQuery<RowDataPacket[]>(
          `SELECT COUNT(*) c
             FROM appointments a
            WHERE a.status='pending'
              AND (EXISTS (SELECT 1 FROM appointment_locations al WHERE al.appointment_id=a.id AND al.location_id=?) OR NOT EXISTS (SELECT 1 FROM appointment_locations al2 WHERE al2.appointment_id=a.id))${scope.sql}`,
          [currentLocationId, ...scope.params],
        );
        return Number(rows[0]?.c ?? 0);
      }
    }
    const rows = await dbQuery<RowDataPacket[]>(`SELECT COUNT(*) c FROM appointments a WHERE a.status='pending'${scope.sql}`, scope.params);
    return Number(rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

export async function countUnseenQuoteDecisions(slug: string, currentLocationId: number): Promise<number> {
  try {
    const useLocation = currentLocationId > 0 && (await tenantColumnExists(slug, "quotes", "location_id"));
    const locationSql = useLocation ? " AND location_id=?" : "";
    const scope = await tenantScope(slug, "quotes");
    const params: number[] = useLocation ? [currentLocationId, ...scope.params] : [...scope.params];
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT COUNT(*) c
         FROM quotes
        WHERE status IN ('accepted','rejected')
          AND customer_decision_at IS NOT NULL
          AND customer_decision_seen_at IS NULL
          ${locationSql}${scope.sql}`,
      params,
    );
    return Number(rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

// Port of SaleInstallments::countDueAlertGroups($daysAhead, $locationId).
async function countInstallmentDueAlertGroups(slug: string, currentLocationId: number): Promise<number> {
  try {
    if (!(await tenantTableExists(slug, "sale_installments")) || !(await tenantTableExists(slug, "sale_installment_plans"))) {
      return 0;
    }
    const daysAhead = await automationAlertDays(slug, "installment_alert_days");
    const maxDueDate = isoDateOffset(daysAhead);
    const filterByLocation = currentLocationId > 0 && (await tenantColumnExists(slug, "sales", "location_id"));
    let sql =
      `SELECT COUNT(DISTINCT CASE WHEN i.due_date < CURRENT_DATE THEN 'overdue' ELSE CONCAT('due_', i.due_date) END) AS c
         FROM sale_installments i
         LEFT JOIN sale_installment_plans p ON p.id=i.plan_id
         LEFT JOIN sales s ON s.id=i.sale_id
        WHERE i.status='pending'
          AND COALESCE(p.status,'active') <> 'cancelled'
          AND i.due_date <= ?`;
    const params: unknown[] = [maxDueDate];
    if (filterByLocation) {
      sql += " AND s.location_id=?";
      params.push(currentLocationId);
    }
    const scope = await tenantScope(slug, "sale_installments", "i");
    sql += scope.sql;
    params.push(...scope.params);
    const rows = await dbQuery<RowDataPacket[]>(sql, params);
    return Number(rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

// Port of client_birthday_notification_count(): count clients whose next
// birthday falls within `daysAhead`. The legacy code computes the next
// occurrence in PHP (Feb-29 -> Feb-28 fallback), so we mirror that in JS.
async function countUpcomingBirthdays(slug: string): Promise<number> {
  try {
    if (!(await tenantTableExists(slug, "clients")) || !(await tenantColumnExists(slug, "clients", "birth_date"))) {
      return 0;
    }
    const daysAhead = await automationAlertDays(slug, "client_birthday_alert_days");
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "clients",
      columns: "birth_date",
      // birth_date è DATE su Postgres: la zero-date MySQL non può esistere e il
      // confronto con '0000-00-00' LANCIA (query sempre fallita -> compleanni 0).
      // Il filtro zero-date resta nel parser JS (birthdayDaysUntilNext).
      where: "birth_date IS NOT NULL",
    });
    let count = 0;
    for (const row of rows) {
      const days = birthdayDaysUntilNext(String(row.birth_date ?? ""));
      if (days !== null && days <= daysAhead) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

// Mirror of client_birthday_next_occurrence(): returns the whole-day distance
// from today to the next birthday, or null if the date can't be parsed.
function birthdayDaysUntilNext(raw: string): number | null {
  const value = raw.trim();
  if (!value || value === "0000-00-00") return null;

  let month = 0;
  let day = 0;
  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const itMatch = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (isoMatch) {
    month = Number(isoMatch[2]);
    day = Number(isoMatch[3]);
  } else if (itMatch) {
    month = Number(itMatch[2]);
    day = Number(itMatch[1]);
  } else {
    const ts = Date.parse(value);
    if (Number.isNaN(ts)) return null;
    const d = new Date(ts);
    month = d.getUTCMonth() + 1;
    day = d.getUTCDate();
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const make = (year: number): Date | null => {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCMonth() === month - 1 && d.getUTCDate() === day) return d;
    // Feb-29 in a non-leap year -> fall back to Feb-28, like the PHP helper.
    if (month === 2 && day === 29) return new Date(Date.UTC(year, 1, 28));
    return null;
  };

  const now = new Date();
  const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  let year = today.getUTCFullYear();
  let next = make(year);
  if (!next) return null;
  if (next.getTime() < today.getTime()) {
    year += 1;
    next = make(year);
    if (!next) return null;
  }
  return Math.round((next.getTime() - today.getTime()) / 86_400_000);
}

function isoDateOffset(daysAhead: number): string {
  const now = new Date();
  const base = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  base.setUTCDate(base.getUTCDate() + Math.max(0, daysAhead));
  return base.toISOString().slice(0, 10);
}

// Port of View::notificationSummary() — tenant-scoped + permission-gated.
export async function getNotificationSummary(
  slug: string,
  user: ManageUser,
  currentLocationId: number,
  needsLocationSelection: boolean,
): Promise<ShellNotificationSummary> {
  if (!can(user.perms, "notifications.view")) return { ...EMPTY_SUMMARY };
  if (needsLocationSelection) return { ...EMPTY_SUMMARY };

  const summary: ShellNotificationSummary = { ...EMPTY_SUMMARY };

  summary.appointments = await countPendingAppointments(slug, currentLocationId);

  if (can(user.perms, "quotes.manage")) {
    summary.quotes = await countUnseenQuoteDecisions(slug, currentLocationId);
  }
  if (can(user.perms, "installments.manage")) {
    summary.installments = await countInstallmentDueAlertGroups(slug, currentLocationId);
  }
  if (canAny(user.perms, ["clients.manage", "client_sheets.manage", "client_consents.manage"])) {
    summary.birthdays = await countUpcomingBirthdays(slug);
  }

  summary.fidelity_cards = await countFidelityCardNotifications(slug);

  // Formula legacy (View.php:191): il badge della campanella somma SOLO
  // appuntamenti pending + tessere fidelity; preventivi/rate/compleanni hanno
  // le proprie icone dedicate.
  summary.count = summary.appointments + summary.fidelity_cards;
  return summary;
}

// Port count-only di fidelity_card_notification_groups (Helpers.php 5147-5356,
// sommato dal notificationSummary a View.php:181-189): tessere gia' scadute +
// tessere in scadenza entro la finestra promemoria. Quando il promemoria
// scadenza fidelity e' disattivato il legacy ritorna [] (contatore 0).
export async function countFidelityCardNotifications(slug: string): Promise<number> {
  try {
    if (!(await tenantTableExists(slug, "cards"))) return 0;
    const hasExpiresAt = await tenantColumnExists(slug, "cards", "expires_at");
    const hasExpiryDate = await tenantColumnExists(slug, "cards", "expiry_date");
    const expiryCol = hasExpiresAt ? "expires_at" : hasExpiryDate ? "expiry_date" : null;
    if (!expiryCol) return 0;

    // fidelity_card_expiry_notification_config(): disattivato -> nessun gruppo.
    if (!(await tenantColumnExists(slug, "automation_settings", "fidelity_expiry_reminder_enabled"))) return 0;
    const settingsRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "automation_settings",
      columns: "fidelity_expiry_reminder_enabled",
      orderBy: "id ASC",
      limit: 1,
    });
    if (Number(settingsRows[0]?.fidelity_expiry_reminder_enabled ?? 0) !== 1) return 0;
    const reminderDays = await automationAlertDays(slug, "installment_alert_days");

    const hasStatus = await tenantColumnExists(slug, "cards", "status");
    const hasIsActive = await tenantColumnExists(slug, "cards", "is_active");
    const scope = await tenantScope(slug, "cards", "fc");
    const extraSelect = `${hasStatus ? ", fc.status" : ""}${hasIsActive ? ", fc.is_active" : ""}`;
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT fc.${expiryCol} AS expires_at${extraSelect}
         FROM \`cards\` fc
         JOIN \`clients\` c ON c.id = fc.client_id
        WHERE fc.${expiryCol} IS NOT NULL${scope.sql}`,
      scope.params,
    );

    const now = new Date();
    const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    let count = 0;
    for (const row of rows) {
      const raw = row.expires_at instanceof Date
        ? `${row.expires_at.getFullYear()}-${String(row.expires_at.getMonth() + 1).padStart(2, "0")}-${String(row.expires_at.getDate()).padStart(2, "0")}`
        : String(row.expires_at ?? "").slice(0, 10);
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
      if (!m) continue;
      const days = Math.round((Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - todayUtc) / 86_400_000);

      let isActive = true;
      if (hasStatus) {
        let status = String(row.status ?? "active").trim().toLowerCase();
        if (status === "") status = "active";
        isActive = status !== "inactive";
      } else if (hasIsActive) {
        isActive = Number(row.is_active ?? 1) !== 0;
      }

      if (days < 0) {
        // Gia' scadute: incluse anche se disattivate (come il legacy).
        count += 1;
      } else if (isActive && reminderDays > 0 && days <= reminderDays) {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

// Port of the topbar closure-range computation (View.php lines 248-304):
// the nearest contiguous run of future closure dates, excluding dates
// "reopened" by a non-closed business_hours_exception.
export async function getClosureRange(slug: string, currentLocationId: number): Promise<ShellClosureRange> {
  try {
    if (!(await tenantTableExists(slug, "closures"))) return null;

    const hasClosureLocation = currentLocationId > 0 && (await tenantColumnExists(slug, "closures", "location_id"));
    const closureScope = await tenantScope(slug, "closures");
    const closureRows = hasClosureLocation
      ? await dbQuery<RowDataPacket[]>(
          `SELECT date FROM closures WHERE (location_id IS NULL OR location_id=?) AND date >= CURRENT_DATE${closureScope.sql} ORDER BY date ASC`,
          [currentLocationId, ...closureScope.params],
        )
      : await dbQuery<RowDataPacket[]>(
          `SELECT date FROM closures WHERE location_id IS NULL AND date >= CURRENT_DATE${closureScope.sql} ORDER BY date ASC`,
          closureScope.params,
        );

    let dates = closureRows
      .map((row) => String(row.date ?? "").slice(0, 10))
      .filter((d) => d !== "");
    if (!dates.length) return null;

    // Exclude dates "reopened" by a non-closed exception.
    const reopened = new Set<string>();
    try {
      if (await tenantTableExists(slug, "business_hours_exceptions")) {
        const hasExcLocation =
          currentLocationId > 0 && (await tenantColumnExists(slug, "business_hours_exceptions", "location_id"));
        const excScope = await tenantScope(slug, "business_hours_exceptions");
        const excRows = hasExcLocation
          ? await dbQuery<RowDataPacket[]>(
              `SELECT date FROM business_hours_exceptions WHERE (location_id IS NULL OR location_id=?) AND is_closed=0 AND date >= CURRENT_DATE${excScope.sql}`,
              [currentLocationId, ...excScope.params],
            )
          : await dbQuery<RowDataPacket[]>(
              `SELECT date FROM business_hours_exceptions WHERE location_id IS NULL AND is_closed=0 AND date >= CURRENT_DATE${excScope.sql}`,
              excScope.params,
            );
        for (const row of excRows) {
          const d = String(row.date ?? "").slice(0, 10);
          if (d !== "") reopened.add(d);
        }
      }
    } catch {
      // Old installs may lack the table; treat as no reopenings.
    }
    if (reopened.size) dates = dates.filter((d) => !reopened.has(d));
    if (!dates.length) return null;

    const start = dates[0];
    let end = dates[0];
    for (let i = 1; i < dates.length; i += 1) {
      const expected = addOneDay(end);
      if (dates[i] === expected) end = dates[i];
      else break;
    }
    return { start, end };
  } catch {
    return null;
  }
}

function addOneDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Support access lives in the SaaS-level saas_support_access_tokens table and
// is normally tracked on the PHP $_SESSION['support_access']. The Next manage
// session does not yet carry a support-access marker, so there is no reliable
// per-request signal to surface here. Returns null (TODO: wire when the manage
// session records an active support token; `slug` is reserved for that lookup).
export async function getSupportAccess(slug: string): Promise<ShellSupportAccess> {
  void slug;
  return null;
}
