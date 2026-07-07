import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { dbQuery, tenantIdForSlug, tenantSelect } from "@/lib/tenant-db";
import { can } from "@/lib/role-permissions";
import {
  automationAlertDays,
  countPendingAppointments,
  countUnseenQuoteDecisions,
  tenantColumnExists,
  tenantTableExists,
} from "@/lib/manage-shell-context";

// Faithful port of the legacy dashboard "Avvisi" widget (app/pages/dashboard.php
// lines ~240-470 for the builder, ~640-710 for the markup). The legacy page
// assembles a single grouped `$alerts[]` array with ~6 structured types, each
// shaped {key, kind, icon, title, text, link, link_label, lines?, lines_more?}.
//
// This replaces the previous Next dashboard behaviour of reusing the topbar
// per-appointment notification list. The counts shared with the topbar bell
// (pending appointments, unseen quote decisions) are reused verbatim from
// lib/manage-shell-context.ts; the grouped/new types (fidelity cards, low
// stock, staff off, installment due groups) are ported here.

export type DashboardAlertKind = "warning" | "info" | "danger";

export type DashboardAlert = {
  key: string;
  kind: DashboardAlertKind;
  icon: string;
  title: string;
  text: string;
  link: string;
  linkLabel: string;
  lines?: string[];
  linesMore?: number;
};

export type DashboardAlertOptions = {
  perms: string[];
  currentLocationId: number;
  // Mirrors $dashboardLocationFailClosed: when locations exist but none is
  // resolved for this session, the legacy page skips every permission-gated
  // alert. Defaults to false (single-location / resolved tenants).
  needsLocationSelection?: boolean;
};

function slugifyKey(value: string): string {
  // Port of preg_replace('/[^a-z0-9_]+/i', '_', $title).
  return value.replace(/[^a-z0-9_]+/gi, "_");
}

function locationQs(currentLocationId: number): string {
  return currentLocationId > 0 ? `location_id=${currentLocationId}` : "";
}

// ---------------------------------------------------------------------------
// low_stock — products under their minimum threshold (per-location product_stock
// fallback to the product master). Port of dashboard.php lines ~256-283.
// ---------------------------------------------------------------------------
async function countLowStock(slug: string, tenantId: number | null, currentLocationId: number): Promise<number> {
  try {
    const hasStockSchema =
      (await tenantTableExists(slug, "product_stocks")) &&
      (await tenantColumnExists(slug, "product_stocks", "product_id")) &&
      (await tenantColumnExists(slug, "product_stocks", "location_id"));
    const hasEnabledColumn = hasStockSchema && (await tenantColumnExists(slug, "product_stocks", "is_enabled"));
    const tenantP = tenantId !== null ? " AND p.tenant_id=?" : "";
    const tenantPs = tenantId !== null ? " AND ps.tenant_id=?" : "";

    if (currentLocationId > 0 && hasStockSchema) {
      const enabledSql = hasEnabledColumn
        ? ` AND (COALESCE(ps.is_enabled,0)=1 OR NOT EXISTS(SELECT 1 FROM product_stocks ps_any WHERE ps_any.product_id=p.id${tenantId !== null ? " AND ps_any.tenant_id=?" : ""}))`
        : "";
      const params: unknown[] = [];
      // ps JOIN params: location_id (+ tenant) come first in the SQL text.
      params.push(currentLocationId);
      if (tenantId !== null) params.push(tenantId); // ps.tenant_id in the JOIN
      if (tenantId !== null) params.push(tenantId); // p.tenant_id in the WHERE
      if (hasEnabledColumn && tenantId !== null) params.push(tenantId); // ps_any.tenant_id
      const rows = await dbQuery<RowDataPacket[]>(
        `SELECT COUNT(*) c
           FROM products p
           LEFT JOIN product_stocks ps ON ps.product_id=p.id AND ps.location_id=?${tenantPs}
          WHERE p.is_active=1${tenantP}
            ${enabledSql}
            AND COALESCE(ps.min_stock, p.min_stock, 0) > 0
            AND COALESCE(ps.stock, p.stock, 0) < COALESCE(ps.min_stock, p.min_stock, 0)`,
        params,
      );
      return Number(rows[0]?.c ?? 0);
    }

    const params: unknown[] = [];
    if (tenantId !== null) params.push(tenantId);
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT COUNT(*) c
         FROM products
        WHERE is_active=1${tenantId !== null ? " AND tenant_id=?" : ""}
          AND COALESCE(min_stock, 0) > 0
          AND COALESCE(stock, 0) < COALESCE(min_stock, 0)`,
      params,
    );
    return Number(rows[0]?.c ?? 0);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// staff_off — operators with an active absence period. Port of dashboard.php
// lines ~285-327 (count + preview of up to 3, location-aware via staff_locations).
// ---------------------------------------------------------------------------
type StaffOffResult = { count: number; preview: Array<{ fullName: string; reason: string; endsAt: string }> };

async function getStaffOff(slug: string, tenantId: number | null, currentLocationId: number): Promise<StaffOffResult> {
  try {
    if (!(await tenantTableExists(slug, "staff_timeoff")) || !(await tenantTableExists(slug, "staff"))) {
      return { count: 0, preview: [] };
    }
    const tenantT = tenantId !== null ? " AND t.tenant_id=?" : "";
    const tenantSt = tenantId !== null ? " AND st.tenant_id=?" : "";

    let staffLocationSql = "";
    const staffLocationParams: unknown[] = [];
    const hasStaffLocations =
      currentLocationId > 0 &&
      (await tenantTableExists(slug, "staff_locations")) &&
      (await tenantColumnExists(slug, "staff_locations", "staff_id")) &&
      (await tenantColumnExists(slug, "staff_locations", "location_id"));
    if (hasStaffLocations) {
      staffLocationSql = ` AND EXISTS (SELECT 1 FROM staff_locations sl WHERE sl.staff_id=st.id AND sl.location_id=?${tenantId !== null ? " AND sl.tenant_id=?" : ""})`;
      staffLocationParams.push(currentLocationId);
      if (tenantId !== null) staffLocationParams.push(tenantId);
    }

    const baseWhere = `WHERE st.is_active=1${tenantSt}
          AND t.starts_at <= NOW()
          AND t.ends_at >= NOW()${tenantT}
          ${staffLocationSql}`;
    const baseParams: unknown[] = [];
    if (tenantId !== null) baseParams.push(tenantId); // st.tenant_id
    if (tenantId !== null) baseParams.push(tenantId); // t.tenant_id
    baseParams.push(...staffLocationParams);

    const countRows = await dbQuery<RowDataPacket[]>(
      `SELECT COUNT(DISTINCT st.id) c
         FROM staff_timeoff t
         JOIN staff st ON st.id=t.staff_id
        ${baseWhere}`,
      baseParams,
    );
    const count = Number(countRows[0]?.c ?? 0);
    if (count <= 0) return { count: 0, preview: [] };

    const previewRows = await dbQuery<RowDataPacket[]>(
      `SELECT st.full_name, t.reason, t.ends_at
         FROM staff_timeoff t
         JOIN staff st ON st.id=t.staff_id
        ${baseWhere}
        ORDER BY t.ends_at ASC
        LIMIT 3`,
      baseParams,
    );
    const preview = previewRows.map((row) => ({
      fullName: String(row.full_name ?? "—") || "—",
      reason: String(row.reason ?? "Assente") || "Assente",
      endsAt: String(row.ends_at ?? ""),
    }));
    return { count, preview };
  } catch {
    return { count: 0, preview: [] };
  }
}

// staff_off preview line: "• Nome (Motivo fino a dd/mm HH:MM)" — built from the
// markup at dashboard.php lines ~659-671.
function formatStaffOffLine(p: { fullName: string; reason: string; endsAt: string }): string {
  let until = "";
  if (p.endsAt) {
    const dt = parseDateTime(p.endsAt);
    if (dt) until = ` fino a ${formatDayMonthHm(dt)}`;
  }
  return `${p.fullName} (${p.reason}${until})`;
}

// ---------------------------------------------------------------------------
// installments_* — SaleInstallments::getDueAlertGroups($days, 3, $locationId).
// Faithful port of SaleInstallments.php lines 1097-1195 + the dueAlert* helpers.
// ---------------------------------------------------------------------------
export type InstallmentGroup = {
  key: string;
  kind: DashboardAlertKind;
  icon: string;
  title: string;
  text: string;
  link: string;
  linkLabel: string;
  lines: string[];
  linesMore: number;
};

function dueAlertTitle(daysDiff: number): string {
  if (daysDiff < 0) return "Rate già scadute";
  if (daysDiff === 0) return "Rate in scadenza oggi";
  if (daysDiff === 1) return "Rate in scadenza domani";
  return `Rate in scadenza tra ${daysDiff} giorni`;
}

function dueAlertText(daysDiff: number, count: number): string {
  const c = Math.max(0, count);
  if (daysDiff < 0) return `${c}${c === 1 ? " rata già scaduta" : " rate già scadute"}`;
  if (daysDiff === 0) return `${c}${c === 1 ? " rata in scadenza oggi" : " rate in scadenza oggi"}`;
  if (daysDiff === 1) return `${c}${c === 1 ? " rata in scadenza domani" : " rate in scadenza domani"}`;
  return `${c}${c === 1 ? ` rata in scadenza tra ${daysDiff} giorni` : ` rate in scadenza tra ${daysDiff} giorni`}`;
}

function dueAlertKind(daysDiff: number): DashboardAlertKind {
  if (daysDiff < 0) return "danger";
  if (daysDiff <= 1) return "warning";
  return "info";
}

function dueAlertIcon(daysDiff: number): string {
  if (daysDiff < 0) return "bi-exclamation-circle";
  return "bi-calendar-event";
}

// Port of SaleInstallments::formatAlertInstallmentLine().
function formatInstallmentLine(row: RowDataPacket): string {
  let client = String(row.client_name ?? row.full_name ?? "").trim();
  if (client === "") client = "Cliente";
  const installmentNo = Math.max(1, Number(row.installment_no ?? 0));
  const dueDate = String(row.due_date ?? "").trim().slice(0, 10);
  let dueLabel = dueDate;
  const dt = parseYmd(dueDate);
  if (dt) dueLabel = formatDayMonthYear(dt);
  const amountLabel = formatMoneyIt(Number(row.amount ?? 0));
  return `${client} • rata ${installmentNo} • ${dueLabel} • € ${amountLabel}`;
}

async function getInstallmentDueAlertGroups(
  slug: string,
  tenantId: number | null,
  currentLocationId: number,
): Promise<InstallmentGroup[]> {
  try {
    if (
      !(await tenantTableExists(slug, "sale_installments")) ||
      !(await tenantTableExists(slug, "sale_installment_plans"))
    ) {
      return [];
    }
    const daysAhead = Math.max(0, await automationAlertDays(slug, "installment_alert_days"));
    const previewLimit = 3;
    const filterByLocation = currentLocationId > 0 && (await tenantColumnExists(slug, "sales", "location_id"));

    const today = startOfToday();
    const maxDueDate = ymd(addDays(today, daysAhead));

    const tenantI = tenantId !== null ? " AND i.tenant_id=?" : "";
    let sql = `SELECT i.id, i.plan_id, i.sale_id, i.client_id, i.installment_no, i.due_date, i.amount,
                      c.full_name AS client_name
                 FROM sale_installments i
                 LEFT JOIN sale_installment_plans p ON p.id=i.plan_id
                 LEFT JOIN clients c ON c.id=i.client_id
                 LEFT JOIN sales s ON s.id=i.sale_id
                WHERE i.status='pending'
                  AND COALESCE(p.status,'active') <> 'cancelled'
                  AND i.due_date <= ?${tenantI}`;
    const params: unknown[] = [maxDueDate];
    if (tenantId !== null) params.push(tenantId);
    if (filterByLocation) {
      sql += " AND s.location_id=?";
      params.push(currentLocationId);
    }
    sql += " ORDER BY i.due_date ASC, i.id ASC";

    const rows = await dbQuery<RowDataPacket[]>(sql, params);

    type Bucket = {
      key: string;
      daysDiff: number;
      count: number;
      previewRows: RowDataPacket[];
    };
    const groups = new Map<string, Bucket>();

    for (const row of rows) {
      const dueDate = normalizeYmd(String(row.due_date ?? ""));
      if (!dueDate) continue;
      const due = parseYmd(dueDate);
      if (!due) continue;
      const daysDiff = diffDays(today, due);
      if (daysDiff > daysAhead) continue;

      const groupKey = daysDiff < 0 ? "overdue" : `due_${daysDiff}`;
      let bucket = groups.get(groupKey);
      if (!bucket) {
        bucket = { key: groupKey, daysDiff, count: 0, previewRows: [] };
        groups.set(groupKey, bucket);
      }
      bucket.count += 1;
      if (bucket.previewRows.length < previewLimit) bucket.previewRows.push(row);
    }

    const ordered: Bucket[] = [];
    if (groups.has("overdue")) ordered.push(groups.get("overdue")!);
    for (let i = 0; i <= daysAhead; i += 1) {
      const k = `due_${i}`;
      if (groups.has(k)) ordered.push(groups.get(k)!);
    }

    return ordered.map((bucket) => {
      const linesMore = Math.max(0, bucket.count - bucket.previewRows.length);
      let link: string;
      if (bucket.daysDiff < 0) {
        link = `/${slug}/installments_manage?status=overdue`;
      } else {
        const dueDate = normalizeYmd(String(bucket.previewRows[0]?.due_date ?? "")) ?? "";
        const enc = encodeURIComponent(dueDate);
        link = `/${slug}/installments_manage?status=open&due_from=${enc}&due_to=${enc}`;
      }
      if (filterByLocation) link += `&location_id=${currentLocationId}`;
      return {
        key: `installments_${bucket.key}`,
        kind: dueAlertKind(bucket.daysDiff),
        icon: dueAlertIcon(bucket.daysDiff),
        title: dueAlertTitle(bucket.daysDiff),
        text: dueAlertText(bucket.daysDiff, bucket.count),
        link,
        linkLabel: "Apri Gestione Rate",
        lines: bucket.previewRows.map(formatInstallmentLine),
        linesMore,
      };
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// fidelity_cards_* — fidelity_card_notification_groups(3). Faithful port of the
// reminder/renewal grouping in Helpers.php lines 5147-5356. The legacy reminder
// window is read from automation_settings.fidelity_* (see fidelity_card_expiry
// _notification_config): a simple "remind N days before" mode driven by
// fidelity_expiry_reminder_enabled + an optional reminder-days setting. When the
// reminder is disabled the legacy helper returns no groups.
// ---------------------------------------------------------------------------
export type FidelityGroup = {
  key: string;
  kind: DashboardAlertKind;
  title: string;
  text: string;
  link: string;
  lines: string[];
  linesMore: number;
};

type FidelityConfig = { mode: "disabled" | "reminder" | "renewal"; value: number; unit: "days" | "weeks" | "months" };

async function getFidelityConfig(slug: string): Promise<FidelityConfig> {
  // Port of fidelity_card_expiry_notification_config(): when the reminder is
  // disabled, the helper short-circuits and returns no groups. When enabled,
  // the reminder window is N days (we read the configured alert-days, clamped).
  try {
    if (!(await tenantColumnExists(slug, "automation_settings", "fidelity_expiry_reminder_enabled"))) {
      return { mode: "disabled", value: 0, unit: "days" };
    }
    // Tenant-scoped (tenantSelect adds tenant_id in shared mode), mirroring the
    // legacy single-row automation_settings read.
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "automation_settings",
      columns: "fidelity_expiry_reminder_enabled",
      orderBy: "id ASC",
      limit: 1,
    });
    const enabled = Number(rows[0]?.fidelity_expiry_reminder_enabled ?? 0) === 1;
    if (!enabled) return { mode: "disabled", value: 0, unit: "days" };
    // The legacy default reminder window is the generic alert-days (7) when no
    // dedicated card-reminder window is stored.
    const days = await automationAlertDays(slug, "installment_alert_days");
    return { mode: "reminder", value: days, unit: "days" };
  } catch {
    return { mode: "disabled", value: 0, unit: "days" };
  }
}

async function getFidelityCardAlertGroups(slug: string, tenantId: number | null): Promise<FidelityGroup[]> {
  try {
    if (!(await tenantTableExists(slug, "cards"))) return [];
    const hasExpiresAt = await tenantColumnExists(slug, "cards", "expires_at");
    const hasExpiryDate = await tenantColumnExists(slug, "cards", "expiry_date");
    const expiryCol = hasExpiresAt ? "expires_at" : hasExpiryDate ? "expiry_date" : null;
    if (!expiryCol) return [];

    const cfg = await getFidelityConfig(slug);
    if (cfg.mode === "disabled") return [];

    const hasStatus = await tenantColumnExists(slug, "cards", "status");
    const hasIsActive = await tenantColumnExists(slug, "cards", "is_active");

    const previewLimit = 3;
    const tenantFc = tenantId !== null ? " AND fc.tenant_id=?" : "";
    const params: unknown[] = [];
    if (tenantId !== null) params.push(tenantId);

    const extraSelect = `${hasStatus ? ", fc.status" : ""}${hasIsActive ? ", fc.is_active" : ""}`;
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT fc.id, fc.code, fc.client_id, fc.${expiryCol} AS expires_at${extraSelect},
              c.full_name AS client_name
         FROM cards fc
         JOIN clients c ON c.id=fc.client_id
        WHERE fc.${expiryCol} IS NOT NULL${tenantFc}
        ORDER BY fc.${expiryCol} ASC, fc.id ASC`,
      params,
    );

    const today = ymd(startOfToday());

    type Item = { clientName: string; expiresAt: string; expiresLabel: string; statusLabel: string };
    const expiredRows: Item[] = [];
    const dueBuckets = new Map<number, Item[]>();

    for (const row of rows) {
      const expiresAt = normalizeYmd(String(row.expires_at ?? ""));
      if (!expiresAt) continue;

      const isExpired = expiresAt < today;
      let isActive = true;
      if (hasStatus) {
        let status = String(row.status ?? "active").trim().toLowerCase();
        if (status === "") status = "active";
        isActive = status !== "inactive";
      } else if (hasIsActive) {
        isActive = Number(row.is_active ?? 1) !== 0;
      }
      // Future but inactive cards are excluded; already-expired ones still shown.
      if (!isExpired && !isActive) continue;

      const days = daysBetweenYmd(today, expiresAt);
      const item: Item = {
        clientName: String(row.client_name ?? "").trim() || "Cliente",
        expiresAt,
        expiresLabel: formatYmdLabel(expiresAt),
        statusLabel: isExpired ? "Scaduta" : days === 0 ? "Scade oggi" : "In scadenza",
      };

      if (isExpired) {
        expiredRows.push(item);
        continue;
      }
      // reminder mode: include cards expiring within `value` days.
      const reminderDays = Math.max(0, cfg.value);
      const include = reminderDays > 0 && days >= 0 && days <= reminderDays;
      if (!include) continue;
      const bucket = dueBuckets.get(days) ?? [];
      bucket.push(item);
      dueBuckets.set(days, bucket);
    }

    const groups: FidelityGroup[] = [];

    const lineFor = (item: Item): string => {
      let line = item.clientName;
      if (item.expiresLabel) line += ` - ${item.expiresLabel}`;
      if (item.statusLabel) line += ` - ${item.statusLabel}`;
      return line;
    };

    if (expiredRows.length > 0) {
      expiredRows.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
      const count = expiredRows.length;
      const title = "Tessere già scadute";
      groups.push({
        key: `fidelity_cards_${slugifyKey(title)}`,
        kind: "danger",
        title,
        text: `${count} ${count === 1 ? "tessera già scaduta" : "tessere già scadute"}`,
        link: `/${slug}/fidelity_membership`,
        lines: expiredRows.slice(0, previewLimit).map(lineFor),
        linesMore: Math.max(0, count - previewLimit),
      });
    }

    const sortedDays = Array.from(dueBuckets.keys()).sort((a, b) => a - b);
    for (const days of sortedDays) {
      const items = (dueBuckets.get(days) ?? []).slice().sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
      const count = items.length;
      let title: string;
      let text: string;
      let kind: DashboardAlertKind;
      if (days <= 0) {
        title = "Tessere in scadenza oggi";
        text = `${count} ${count === 1 ? "tessera in scadenza oggi" : "tessere in scadenza oggi"}`;
        kind = "warning";
      } else if (days === 1) {
        title = "Tessere in scadenza domani";
        text = `${count} ${count === 1 ? "tessera in scadenza domani" : "tessere in scadenza domani"}`;
        kind = "info";
      } else {
        title = `Tessere in scadenza tra ${days} giorni`;
        text = `${count} tessere in scadenza tra ${days} giorni`;
        kind = "info";
      }
      groups.push({
        key: `fidelity_cards_${slugifyKey(title)}`,
        kind,
        title,
        text,
        link: `/${slug}/fidelity_membership`,
        lines: items.slice(0, previewLimit).map(lineFor),
        linesMore: Math.max(0, count - previewLimit),
      });
    }

    return groups;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Gruppi "Tessere Fidelity in scadenza/scadute" per la pagina notifiche (riusa il
// port dashboard): risolve il tenant e delega a getFidelityCardAlertGroups.
export async function notificationFidelityCardGroups(slug: string): Promise<FidelityGroup[]> {
  const tenantId = await tenantIdForSlug(slug).catch(() => null);
  return getFidelityCardAlertGroups(slug, tenantId).catch(() => []);
}

// Gruppi "Rate in scadenza/scadute" per il feed notifiche browser.
export async function notificationInstallmentGroups(slug: string, currentLocationId: number): Promise<InstallmentGroup[]> {
  const tenantId = await tenantIdForSlug(slug).catch(() => null);
  return getInstallmentDueAlertGroups(slug, tenantId, currentLocationId).catch(() => []);
}

// Top-level builder — assembles the 6 alert types in legacy order, honouring
// the same permission + location gating, skipping empty types.
// ---------------------------------------------------------------------------
export async function getDashboardAlerts(slug: string, options: DashboardAlertOptions): Promise<DashboardAlert[]> {
  const { perms, currentLocationId } = options;
  const failClosed = options.needsLocationSelection === true;

  const canNotifications = can(perms, "notifications.view");
  const canQuoteNotifications = canNotifications && can(perms, "quotes.manage");
  const canFidelityNotifications = canNotifications && can(perms, "fidelity.membership");
  const canProducts = can(perms, "products.manage");
  const canStaffAvailability = can(perms, "staff_availability.manage");
  const canInstallments = can(perms, "installments.manage");

  const tenantId = await tenantIdForSlug(slug);

  // Fetch every gated source up front (each guarded to return empty when its
  // gate is off / fail-closed), then push non-empty alerts in legacy order.
  const [pendingCount, quoteRespCount, fidelityGroups, lowStockCount, staffOff, installmentGroups] = await Promise.all([
    !failClosed && canNotifications ? countPendingAppointments(slug, currentLocationId) : Promise.resolve(0),
    !failClosed && canQuoteNotifications ? countUnseenQuoteDecisions(slug, currentLocationId) : Promise.resolve(0),
    !failClosed && canFidelityNotifications
      ? getFidelityCardAlertGroups(slug, tenantId)
      : Promise.resolve([] as FidelityGroup[]),
    !failClosed && canProducts ? countLowStock(slug, tenantId, currentLocationId) : Promise.resolve(0),
    !failClosed && canStaffAvailability
      ? getStaffOff(slug, tenantId, currentLocationId)
      : Promise.resolve({ count: 0, preview: [] } as StaffOffResult),
    !failClosed && canInstallments
      ? getInstallmentDueAlertGroups(slug, tenantId, currentLocationId)
      : Promise.resolve([] as InstallmentGroup[]),
  ]);

  const alerts: DashboardAlert[] = [];

  if (pendingCount > 0) {
    alerts.push({
      key: "pending_appts",
      kind: "warning",
      icon: "bi-hourglass-split",
      title: "Appuntamenti in attesa",
      text: `${pendingCount} da approvare`,
      link: `/${slug}/notifications`,
      linkLabel: "Gestisci",
    });
  }

  if (quoteRespCount > 0) {
    alerts.push({
      key: "quote_responses",
      kind: "info",
      icon: "bi-file-earmark-check",
      title: "Preventivi: risposte clienti",
      text: `${quoteRespCount} da leggere`,
      link: `/${slug}/notifications_quotes`,
      linkLabel: "Vedi",
    });
  }

  for (const group of fidelityGroups) {
    alerts.push({
      key: group.key,
      kind: group.kind,
      icon: "bi-credit-card-2-front",
      title: group.title,
      text: group.text,
      link: group.link,
      linkLabel: "Vedi",
      lines: group.lines,
      linesMore: group.linesMore,
    });
  }

  if (lowStockCount > 0) {
    const qs = locationQs(currentLocationId);
    alerts.push({
      key: "low_stock",
      kind: "danger",
      icon: "bi-box-seam",
      title: "Prodotti quasi esauriti",
      text: `${lowStockCount} sotto la soglia minima`,
      link: `/${slug}/products?low_stock=1${qs !== "" ? `&${qs}` : ""}`,
      linkLabel: "Vedi magazzino",
    });
  }

  if (staffOff.count > 0) {
    const lines = staffOff.preview.map(formatStaffOffLine);
    alerts.push({
      key: "staff_off",
      kind: "info",
      icon: "bi-person-x",
      title: "Operatori assenti",
      text: `${staffOff.count} con un periodo di assenza attivo`,
      link: `/${slug}/staff_availability`,
      linkLabel: "Dettagli",
      lines,
      linesMore: Math.max(0, staffOff.count - staffOff.preview.length),
    });
  }

  for (const group of installmentGroups) {
    alerts.push({
      key: group.key,
      kind: group.kind,
      icon: group.icon,
      title: group.title,
      text: group.text,
      link: group.link,
      linkLabel: group.linkLabel,
      lines: group.lines,
      linesMore: group.linesMore,
    });
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// Date helpers (UTC-day arithmetic, matching the legacy DateTimeImmutable diffs).
// ---------------------------------------------------------------------------
function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseYmd(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return d;
}

// Port of SaleInstallments::normalizeDate(): accept Y-m-d or d/m/Y, validate.
function normalizeYmd(value: string): string | null {
  const v = value.trim().slice(0, 10).trim();
  if (v === "") return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim().slice(0, 10));
  if (iso) {
    const d = parseYmd(`${iso[1]}-${iso[2]}-${iso[3]}`);
    return d ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
  }
  const it = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (it) {
    const d = new Date(Date.UTC(Number(it[3]), Number(it[2]) - 1, Number(it[1])));
    if (d.getUTCMonth() === Number(it[2]) - 1 && d.getUTCDate() === Number(it[1])) {
      return `${it[3]}-${it[2]}-${it[1]}`;
    }
  }
  return null;
}

function diffDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  const a = parseYmd(fromYmd);
  const b = parseYmd(toYmd);
  if (!a || !b) return toYmd === fromYmd ? 0 : toYmd < fromYmd ? -1 : 1;
  return diffDays(a, b);
}

function parseDateTime(value: string): Date | null {
  const v = value.trim();
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/.exec(v);
  if (!m) {
    const ts = Date.parse(v);
    return Number.isNaN(ts) ? null : new Date(ts);
  }
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4] ? Number(m[4]) : 0, m[5] ? Number(m[5]) : 0),
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// date('d/m H:i') on a UTC instant.
function formatDayMonthHm(d: Date): string {
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

// date('d/m/Y').
function formatDayMonthYear(d: Date): string {
  return `${pad2(d.getUTCDate())}/${pad2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

function formatYmdLabel(value: string): string {
  const d = parseYmd(value);
  return d ? formatDayMonthYear(d) : value;
}

// number_format(value, 2, ',', '.') — Italian thousands/decimals.
function formatMoneyIt(value: number): string {
  return value.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
