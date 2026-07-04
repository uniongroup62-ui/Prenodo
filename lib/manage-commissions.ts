import "server-only";

import { createHash } from "node:crypto";

import type { RowDataPacket } from "@/lib/tenant-db";
import { columnExists, dbQuery, quoteIdentifier, tenantInsert, tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";

// Commission SETTINGS + module toggle — faithful port of the Commissions.php settings layer
// (defaultSettings / settingsMap / saveSettings / moduleSettings / setModuleEnabled). The POS
// accrual engine (buildCommissionDashboard) is ported below; this module is both the config
// foundation the settings tab writes and the engine that computes/persists commission snapshots.

export type CommissionCalculationMode = "paid_amount" | "list_price";

export type CommissionStaffSetting = {
  staffId: number;
  name: string;
  email: string;
  isActive: boolean;
  isEnabled: boolean;
  calculationMode: CommissionCalculationMode;
  appointmentPercent: number;
  posProductPercent: number;
  posServicePercent: number;
  posOtherPercent: number;
  notes: string;
};

export type CommissionSettings = {
  moduleEnabled: boolean;
  // Count of operators enabled with at least one rate > 0 (configuredRatesCount) — drives the
  // "configure rates" empty state.
  configuredRates: number;
  staff: CommissionStaffSetting[];
};

// Per-operator rate config coming from the settings form (all fields optional; missing → defaults).
export type CommissionStaffSettingInput = {
  isEnabled?: boolean;
  calculationMode?: string;
  appointmentPercent?: number | string;
  posProductPercent?: number | string;
  posServicePercent?: number | string;
  posOtherPercent?: number | string;
  notes?: string;
};

// normalizeCalculationMode (Commissions.php ~809): only 'list_price' or the default 'paid_amount'.
export function normalizeCommissionCalculationMode(value: unknown): CommissionCalculationMode {
  return String(value ?? "").trim().toLowerCase() === "list_price" ? "list_price" : "paid_amount";
}

// normalizePercent (Commissions.php ~797): clamp to [0, 100], 2 decimals, IT/EN decimal tolerant.
export function normalizeCommissionPercent(value: unknown): number {
  let n = Number(String(value ?? "").replace(",", ".").trim());
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n > 100) n = 100;
  return Math.round(n * 100) / 100;
}

// All commissionable staff (excl. the technical "SSO" row), ordered by name — mirrors
// Commissions::allStaff(includeInactive=true) minus the technical filter.
async function listCommissionStaff(slug: string): Promise<Array<{ id: number; name: string; email: string; isActive: boolean }>> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff",
    columns: "id, full_name, email, is_active",
    // Ordine legacy allStaff: prima gli attivi, poi alfabetico.
    orderBy: "is_active DESC, full_name ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  return rows
    // isTechnicalStaffRow: nome normalizzato (solo A-Z0-9) uguale a "SSO".
    .filter((r) => String(r.full_name ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, "") !== "SSO")
    .map((r) => ({
      id: Math.max(0, Number(r.id ?? 0) || 0),
      name: String(r.full_name ?? "").trim(),
      email: String(r.email ?? "").trim(),
      isActive: Number(r.is_active ?? 1) === 1,
    }))
    .filter((s) => s.id > 0);
}

// The global module on/off (staff_commission_module_settings.is_enabled, single row).
export async function getCommissionModuleEnabled(slug: string): Promise<boolean> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff_commission_module_settings",
    columns: "is_enabled",
    orderBy: "id ASC",
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  return Number(rows[0]?.is_enabled ?? 0) === 1;
}

// Full settings snapshot: module toggle + one row per staff (merged with defaults) + the
// configured-rates count (enabled operators with any rate > 0).
export async function getCommissionSettings(slug: string): Promise<CommissionSettings> {
  const [moduleEnabled, staff, settingsRows] = await Promise.all([
    getCommissionModuleEnabled(slug),
    listCommissionStaff(slug),
    tenantSelect<RowDataPacket>({ slug, table: "staff_commission_settings" }).catch(() => [] as RowDataPacket[]),
  ]);
  const byStaff = new Map<number, RowDataPacket>();
  for (const r of settingsRows) byStaff.set(Number(r.staff_id ?? 0), r);

  let configuredRates = 0;
  const staffSettings = staff.map((s): CommissionStaffSetting => {
    const row = byStaff.get(s.id);
    const isEnabled = row ? Number(row.is_enabled ?? 0) === 1 : false;
    const appointmentPercent = normalizeCommissionPercent(row?.appointment_percent);
    const posProductPercent = normalizeCommissionPercent(row?.pos_product_percent);
    const posServicePercent = normalizeCommissionPercent(row?.pos_service_percent);
    const posOtherPercent = normalizeCommissionPercent(row?.pos_other_percent);
    if (isEnabled && (appointmentPercent > 0 || posProductPercent > 0 || posServicePercent > 0 || posOtherPercent > 0)) {
      configuredRates += 1;
    }
    return {
      staffId: s.id,
      name: s.name,
      email: s.email,
      isActive: s.isActive,
      isEnabled,
      calculationMode: normalizeCommissionCalculationMode(row?.calculation_mode),
      appointmentPercent,
      posProductPercent,
      posServicePercent,
      posOtherPercent,
      notes: String(row?.notes ?? ""),
    };
  });

  return { moduleEnabled, configuredRates, staff: staffSettings };
}

// Toggle the global module (staff_commission_module_settings, single row id=1) — faithful to
// setModuleEnabled. Period bookkeeping (staff_commission_module_periods) is handled in the accrual
// block; here we own the is_enabled flag. Returns the refreshed settings.
export async function setCommissionModuleEnabled(slug: string, enabled: boolean, userId: number | null): Promise<CommissionSettings> {
  const table = await tenantTable(slug, "staff_commission_module_settings");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: table.name, columns: "id", orderBy: "id ASC", limit: 1 }).catch(() => [] as RowDataPacket[]);
  if (rows[0]) {
    await tenantUpdate({ slug, table: "staff_commission_module_settings", id: Number(rows[0].id ?? 1), values: { is_enabled: enabled ? 1 : 0, updated_by: userId, updated_at: new Date() } });
  } else {
    await tenantInsert(table, { id: 1, is_enabled: enabled ? 1 : 0, created_by: userId, updated_by: userId });
  }
  return getCommissionSettings(slug);
}

// UPSERT per-operator rates (faithful to saveSettings): only known staff ids, percents clamped,
// calculation_mode normalized, notes capped. Returns the refreshed settings.
export async function saveCommissionSettings(
  slug: string,
  rows: Record<string, CommissionStaffSettingInput>,
  userId: number | null,
): Promise<CommissionSettings> {
  const staff = await listCommissionStaff(slug);
  const validIds = new Set(staff.map((s) => s.id));
  const table = await tenantTable(slug, "staff_commission_settings");
  const existing = await tenantSelect<RowDataPacket>({ slug, table: table.name, columns: "id, staff_id" }).catch(() => [] as RowDataPacket[]);
  const existingByStaff = new Map<number, number>();
  for (const r of existing) existingByStaff.set(Number(r.staff_id ?? 0), Number(r.id ?? 0));

  for (const [key, cfg] of Object.entries(rows ?? {})) {
    const staffId = Math.max(0, Number(key) || 0);
    if (!validIds.has(staffId) || !cfg) continue;
    const values: Record<string, unknown> = {
      staff_id: staffId,
      is_enabled: cfg.isEnabled ? 1 : 0,
      calculation_mode: normalizeCommissionCalculationMode(cfg.calculationMode),
      appointment_percent: normalizeCommissionPercent(cfg.appointmentPercent),
      pos_product_percent: normalizeCommissionPercent(cfg.posProductPercent),
      pos_service_percent: normalizeCommissionPercent(cfg.posServicePercent),
      pos_other_percent: normalizeCommissionPercent(cfg.posOtherPercent),
      notes: String(cfg.notes ?? "").slice(0, 255),
      updated_by: userId,
      updated_at: new Date(),
    };
    const existingId = existingByStaff.get(staffId);
    if (existingId && existingId > 0) {
      await tenantUpdate({ slug, table: "staff_commission_settings", id: existingId, values });
    } else {
      await tenantInsert(table, { ...values, created_by: userId });
    }
  }
  return getCommissionSettings(slug);
}

// ===========================================================================
// COMMISSION ACCRUAL ENGINE — POS + APPOINTMENT paths (faithful port of
// Commissions.php buildPosEntriesFromSales / buildAppointmentEntries /
// upsertEntrySnapshot / syncEntrySnapshots / buildDashboard / setEntryPaidStatus).
//
// On GET the engine, for the requested source(s):
//   - POS: iterates the tenant's non-cancelled SALES in [from,to], computing one
//     commission entry per (sale line x resolved operator).
//   - APPOINTMENTS: iterates the tenant's DONE appointments in [from,to] (by
//     starts_at), computing one entry per (NON-redeemed service line x segment
//     staff) — the redemption filter skips lines already paid in a prior sale.
// Each produced entry is UPSERTed as a snapshot (preserving is_paid/paid_at/paid_by);
// then, per source_group INDEPENDENTLY, any stale snapshot in scope that no longer
// maps to a produced entry is marked 'cancelled' (never deleted). Finally the
// persisted entries (active + cancelled) are loaded and the per-operator + global
// summaries (incl. appointmentsBase/appointmentsCommission) are built.
//
// CAVEAT(pos_other binary model): the Next sale_items.item_type is BINARY
// ('product' | 'service' — every non-product line is stored as 'service'), so
// classifyPosItem below can only yield 'pos_product' or 'pos_service'. The
// legacy 'pos_other' bucket (settings.pos_other_percent) is therefore effectively
// unreachable in this data model and pos_other_percent is unused for accrual.
// ===========================================================================

// A single commission movement row returned to the UI.
export type CommissionEntry = {
  entryKey: string;
  staffId: number;
  operatorName: string;
  datetime: string;
  sourceGroup: string;
  sourceLabel: string;
  sourceReference: string;
  clientName: string;
  itemLabel: string;
  baseAmount: number;
  percent: number;
  commissionAmount: number;
  entryStatus: string;
  isPaid: boolean;
  paidAt: string | null;
  cancelledAt: string | null;
  locationId: number;
  locationName: string;
  note: string;
};

// Per-operator aggregate over ACTIVE entries (cancelled tracked separately).
export type CommissionOperatorSummary = {
  staffId: number;
  operatorName: string;
  appointmentsBase: number;
  appointmentsCommission: number;
  posBase: number;
  posCommission: number;
  paidCommission: number;
  unpaidCommission: number;
  cancelledCommission: number;
  totalBase: number;
  totalCommission: number;
  entriesCount: number;
  paidEntriesCount: number;
  unpaidEntriesCount: number;
  cancelledEntriesCount: number;
};

export type CommissionSummary = Omit<CommissionOperatorSummary, "staffId" | "operatorName">;

export type CommissionDashboard = {
  moduleEnabled: boolean;
  configuredRates: number;
  entries: CommissionEntry[];
  operatorSummary: CommissionOperatorSummary[];
  summary: CommissionSummary;
  // Lista COMPLETA operatori per il select filtro (legacy $staffRows: tutti gli
  // staff non tecnici, anche senza movimenti).
  staffOptions: Array<{ id: number; name: string; isActive: boolean }>;
  // Probe legacy per i 3 empty-state (commissions.php ~198-253): storico snapshot
  // nel periodo/filtri e dati sorgente (appuntamenti done / vendite) nel periodo.
  hasStoredHistory: boolean;
  hasSourceInScope: boolean;
};

export type CommissionDashboardParams = {
  from: string;
  to: string;
  staffId?: number;
  source?: string;
  locationId?: number;
};

// roundMoney — 2dp, matches the manage-costs/manage-recharges helper (round(x*100)/100
// with EPSILON), standing in for PHP round($v, 2).
function roundMoney(value: number): number {
  return Math.round(((Number(value) || 0) + Number.EPSILON) * 100) / 100;
}

// entryKey — sha1 hex of the raw key string (Commissions::entryKey → sha1()).
function commissionEntryKey(raw: string): string {
  return createHash("sha1").update(raw).digest("hex");
}

// classifyPosItem (Commissions.php ~2874): product+id → pos_product, service+id →
// pos_service, else pos_other. In the Next binary item_type model, item_id may be
// null for a free-text line; we treat any 'product'/'service' type as its bucket
// (the id>0 guard is relaxed vs legacy because the Next stores item_id nullable and
// the percent still applies to the line by type). Non product/service → pos_other.
function classifyPosItem(itemType: string): "pos_product" | "pos_service" | "pos_other" {
  const type = String(itemType ?? "").trim().toLowerCase();
  if (type === "product") return "pos_product";
  if (type === "service") return "pos_service";
  return "pos_other";
}

// normalizeDateTimeValue (Commissions.php ~823): coerce a date/datetime string to
// 'Y-m-d H:i:s'; date-only → append 00:00:00; empty → fallback.
function normalizeDateTimeValue(value: unknown, fallback = ""): string {
  const txt = String(value ?? "").trim();
  if (txt === "") return fallback;
  if (/^\d{4}-\d{2}-\d{2}$/.test(txt)) return `${txt} 00:00:00`;
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/.test(txt)) return `${txt.replace("T", " ")}:00`;
  const m = txt.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
  if (m) return `${m[1]} ${m[2]}`;
  const ts = Date.parse(txt);
  if (Number.isNaN(ts)) return fallback;
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function nowDateTime(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// A produced commission entry (before persistence), shared by the POS
// (buildPosEntriesFromSales) and the appointment (buildAppointmentEntries) paths.
// Both feed upsertEntrySnapshot / syncEntrySnapshots; sourceGroup selects the
// snapshot bucket a reconcile is allowed to touch.
type ProducedEntry = {
  entryKey: string;
  datetime: string;
  staffId: number;
  operatorName: string;
  sourceId: number;
  locationId: number;
  locationName: string;
  sourceGroup: "pos" | "appointments";
  sourceReference: string;
  sourceLabel: string;
  clientName: string;
  itemLabel: string;
  baseAmount: number;
  percent: number;
  commissionAmount: number;
  note: string;
};

// Resolve a sales row's operator_name (trimmed, case-insensitive) to an ENABLED
// commission staff row. Returns null when no enabled staff matches — the sale is
// then skipped (no commission), faithful to resolveSaleOperator + the settings gate.
function resolveSaleStaff(
  operatorName: string,
  staffByName: Map<string, CommissionStaffSetting>,
): CommissionStaffSetting | null {
  const key = String(operatorName ?? "").trim().toLowerCase();
  if (key === "") return null;
  const staff = staffByName.get(key);
  if (!staff || !staff.isEnabled) return null;
  return staff;
}

// Resolve a location name for display (locations.name), memoised per call.
async function locationNameResolver(slug: string): Promise<(id: number) => Promise<string>> {
  const cache = new Map<number, string>();
  return async (id: number): Promise<string> => {
    if (id <= 0) return "";
    if (cache.has(id)) return cache.get(id) ?? "";
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "locations",
      columns: "name",
      where: "id=?",
      params: [id],
      limit: 1,
    }).catch(() => [] as RowDataPacket[]);
    const name = String(rows[0]?.name ?? "").trim();
    cache.set(id, name);
    return name;
  };
}

// buildPosEntriesFromSales — the POS accrual. For each non-cancelled sale in
// [from,to] whose operator maps to an ENABLED staff, produce one entry per
// sale_item (percent by item type; base by calculation mode; commission = base ×
// %/100). Faithful to Commissions::buildPosEntriesFromSales, adapted to the Next
// schema + the prompt's netFactor formula.
async function buildPosEntriesFromSales(
  slug: string,
  params: { from: string; to: string; staffId: number; locationId: number },
  staffByName: Map<string, CommissionStaffSetting>,
  resolveLocationName: (id: number) => Promise<string>,
): Promise<ProducedEntry[]> {
  const { from, to, staffId, locationId } = params;

  const salesTable = await tenantTable(slug, "sales");
  const clientsTable = await tenantTable(slug, "clients").catch(() => null);
  const clauses: string[] = [];
  const queryParams: unknown[] = [];

  if (salesTable.mode === "shared" && (await columnExists(salesTable.name, "tenant_id"))) {
    clauses.push("s.tenant_id=?");
    queryParams.push(salesTable.tenantId ?? 0);
  }
  // Date range on sale_date (inclusive day span). from/to are 'YYYY-MM-DD'.
  clauses.push("DATE(s.sale_date) BETWEEN ? AND ?");
  queryParams.push(from, to);
  // Skip cancelled sales.
  clauses.push("LOWER(COALESCE(s.status,'')) NOT IN ('cancelled','canceled','annullata','annullato')");
  if (locationId > 0 && (await columnExists(salesTable.name, "location_id"))) {
    clauses.push("(s.location_id IS NULL OR s.location_id=?)");
    queryParams.push(locationId);
  }

  const clientJoin = clientsTable
    ? `LEFT JOIN ${quoteIdentifier(clientsTable.name)} c ON c.id=s.client_id${
        clientsTable.mode === "shared" && (await columnExists(clientsTable.name, "tenant_id")) ? " AND c.tenant_id=s.tenant_id" : ""
      }`
    : "";

  const sales = await dbQuery<RowDataPacket[]>(
    `SELECT s.*, c.full_name AS client_name
       FROM ${quoteIdentifier(salesTable.name)} s
       ${clientJoin}
      WHERE ${clauses.join(" AND ")}
      ORDER BY s.sale_date DESC, s.id DESC`,
    queryParams,
  ).catch(() => [] as RowDataPacket[]);

  if (!sales.length) return [];

  // Fetch all sale_items for these sales in one pass (tenant-safe via tenantSelect scope).
  const saleIds = sales.map((s) => Number(s.id ?? 0) || 0).filter((id) => id > 0);
  const itemsBySale = new Map<number, RowDataPacket[]>();
  if (saleIds.length) {
    const placeholders = saleIds.map(() => "?").join(",");
    const itemRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "sale_items",
      where: `sale_id IN (${placeholders})`,
      params: saleIds,
      orderBy: "id ASC",
    }).catch(() => [] as RowDataPacket[]);
    for (const it of itemRows) {
      const sid = Number(it.sale_id ?? 0) || 0;
      if (sid <= 0) continue;
      if (!itemsBySale.has(sid)) itemsBySale.set(sid, []);
      itemsBySale.get(sid)!.push(it);
    }
  }

  const entries: ProducedEntry[] = [];

  for (const sale of sales) {
    const saleId = Number(sale.id ?? 0) || 0;
    if (saleId <= 0) continue;

    const operatorName = String(sale.operator_name ?? "").trim();
    const staff = resolveSaleStaff(operatorName, staffByName);
    if (!staff) continue; // operator not an enabled commission staff → no commission
    if (staffId > 0 && staff.staffId !== staffId) continue;

    const items = itemsBySale.get(saleId) ?? [];
    if (!items.length) continue;

    // subtotal = sales.subtotal (fallback Σ line_total); saleTotal = sales.total
    // (fallback subtotal); netFactor = subtotal>0 ? saleTotal/subtotal : 1.
    const lineSum = items.reduce((sum, it) => sum + Math.max(0, Number(it.line_total ?? 0) || 0), 0);
    let subtotal = Number(sale.subtotal ?? 0) || 0;
    if (!(subtotal > 0)) subtotal = lineSum;
    let saleTotal = Number(sale.total ?? 0) || 0;
    if (!(saleTotal > 0)) saleTotal = subtotal;
    const netFactor = subtotal > 0 ? saleTotal / subtotal : 1;

    const saleLocationId = Number(sale.location_id ?? 0) || 0;
    const saleLocationName = saleLocationId > 0 ? await resolveLocationName(saleLocationId) : "";
    const clientName = String(sale.client_name ?? "").trim();

    for (const item of items) {
      const itemId = Number(item.id ?? 0) || 0;
      if (itemId <= 0) continue;
      const kind = classifyPosItem(String(item.item_type ?? ""));

      const percent =
        kind === "pos_product" ? staff.posProductPercent : kind === "pos_service" ? staff.posServicePercent : staff.posOtherPercent;
      if (!(percent > 0)) continue;

      const listBase = roundMoney(Math.max(0, Number(item.line_total ?? 0) || 0));
      const paidBase = roundMoney(listBase * netFactor);
      const base = staff.calculationMode === "list_price" ? listBase : paidBase;
      if (!(base > 0)) continue;

      const commission = roundMoney((base * percent) / 100);

      const label =
        String(item.item_name ?? "").trim() ||
        (kind === "pos_product" ? "Prodotto POS" : kind === "pos_service" ? "Servizio POS" : "Altra vendita POS");
      const sourceLabel = kind === "pos_product" ? "POS prodotto" : kind === "pos_service" ? "POS servizio" : "POS altra vendita";

      entries.push({
        entryKey: commissionEntryKey(`pos|${saleId}|${itemId}|${staff.staffId}`),
        datetime: normalizeDateTimeValue(sale.sale_date, ""),
        staffId: staff.staffId,
        operatorName,
        sourceId: saleId,
        locationId: saleLocationId,
        locationName: saleLocationName,
        sourceGroup: "pos",
        sourceReference: `VEN#${saleId}`,
        sourceLabel,
        clientName,
        itemLabel: label,
        baseAmount: base,
        percent: roundMoney(percent),
        commissionAmount: commission,
        note: kind === "pos_other" ? "Riga POS non catalogo" : "",
      });
    }
  }

  return entries;
}

// looksLikeAppointmentRedemption — the appointment redemption filter. A line is a
// redemption (already paid in a prior sale → NO new commission) when any explicit
// redemption FK on the appointment_services row is set (>0), OR the discount_badge
// text names a redemption source, OR the line is a zero-price line with a positive
// list price (paid_amount 0 but a catalogue value). Faithful to
// Commissions::looksLikeAppointmentRedemption, extended with the Next's explicit
// redemption FKs (cleaner than the legacy badge-only heuristic).
function looksLikeAppointmentRedemption(row: RowDataPacket, gross: number, listBase: number): boolean {
  // Explicit redemption foreign keys / indexes on the appointment_services row.
  const redemptionFkColumns = [
    "client_package_id",
    "client_package_service_id",
    "client_prepaid_service_id",
    "giftbox_instance_id",
    "giftbox_item_id",
    "gift_instance_id",
    "reward_item_index",
  ];
  for (const col of redemptionFkColumns) {
    if ((Number(row[col] ?? 0) || 0) > 0) return true;
  }
  const badge = String(row.discount_badge ?? "").trim().toLowerCase();
  if (badge !== "") {
    for (const needle of ["pacchetto", "giftbox", "gift", "giftcard", "prepag", "omaggio"]) {
      if (badge.includes(needle)) return true;
    }
  }
  return gross <= 0.00001 && listBase > 0.00001;
}

// Resolve a staff_id → its ENABLED commission staff setting (from getCommissionSettings).
// Returns null when the staff is not a known commission operator or not enabled — the
// appointment line is then skipped (no commission), faithful to the staffMap + settings gate.
function resolveStaffById(
  staffId: number,
  staffById: Map<number, CommissionStaffSetting>,
): CommissionStaffSetting | null {
  if (staffId <= 0) return null;
  const staff = staffById.get(staffId);
  if (!staff || !staff.isEnabled) return null;
  return staff;
}

// buildAppointmentEntries — the APPOINTMENT accrual. For each appointment with
// status='done' and DATE(starts_at) in [from,to], load its appointment_services (in
// order) + appointment_segments, apply the appointment discount to the eligible
// (non-redeemed) gross to get a netFactor, then produce one entry per NON-redeemed
// service line whose resolved segment staff is an ENABLED commission operator with
// appointment_percent>0 (base by calculation mode; commission = base × %/100).
// Faithful to Commissions::buildAppointmentEntries (redemption filter, segment-queue
// staff resolution, entry_key), adapted to the Next schema's explicit redemption FKs
// and the prompt's netFactor formula.
async function buildAppointmentEntries(
  slug: string,
  params: { from: string; to: string; staffId: number; locationId: number },
  staffById: Map<number, CommissionStaffSetting>,
  resolveLocationName: (id: number) => Promise<string>,
): Promise<ProducedEntry[]> {
  const { from, to, staffId, locationId } = params;

  const apptTable = await tenantTable(slug, "appointments");
  const clientsTable = await tenantTable(slug, "clients").catch(() => null);
  const clauses: string[] = [];
  const queryParams: unknown[] = [];

  if (apptTable.mode === "shared" && (await columnExists(apptTable.name, "tenant_id"))) {
    clauses.push("a.tenant_id=?");
    queryParams.push(apptTable.tenantId ?? 0);
  }
  // Only DONE appointments in the [from,to] day span (by starts_at).
  clauses.push("DATE(a.starts_at) BETWEEN ? AND ?");
  queryParams.push(from, to);
  clauses.push("a.status='done'");
  const hasApptLocation = await columnExists(apptTable.name, "location_id");
  if (locationId > 0 && hasApptLocation) {
    clauses.push("(a.location_id IS NULL OR a.location_id=?)");
    queryParams.push(locationId);
  }

  const clientJoin = clientsTable
    ? `LEFT JOIN ${quoteIdentifier(clientsTable.name)} c ON c.id=a.client_id${
        clientsTable.mode === "shared" && (await columnExists(clientsTable.name, "tenant_id")) ? " AND c.tenant_id=a.tenant_id" : ""
      }`
    : "";

  const appts = await dbQuery<RowDataPacket[]>(
    `SELECT a.*, c.full_name AS client_name
       FROM ${quoteIdentifier(apptTable.name)} a
       ${clientJoin}
      WHERE ${clauses.join(" AND ")}
      ORDER BY a.starts_at DESC, a.id DESC`,
    queryParams,
  ).catch(() => [] as RowDataPacket[]);

  if (!appts.length) return [];

  // Fetch all appointment_services + appointment_segments for these appointments in one
  // pass (tenant-safe via tenantSelect scope). Services keep row order; segments are
  // ordered by (position, id) so the per-service queue is consumed in the legacy order.
  const apptIds = appts.map((a) => Number(a.id ?? 0) || 0).filter((id) => id > 0);
  const servicesByAppt = new Map<number, RowDataPacket[]>();
  const segmentsByAppt = new Map<number, RowDataPacket[]>();
  if (apptIds.length) {
    const placeholders = apptIds.map(() => "?").join(",");
    const [svcRows, segRows] = await Promise.all([
      tenantSelect<RowDataPacket>({
        slug,
        table: "appointment_services",
        where: `appointment_id IN (${placeholders})`,
        params: apptIds,
        orderBy: "appointment_id ASC, service_id ASC",
      }).catch(() => [] as RowDataPacket[]),
      tenantSelect<RowDataPacket>({
        slug,
        table: "appointment_segments",
        where: `appointment_id IN (${placeholders})`,
        params: apptIds,
        orderBy: "appointment_id ASC, position ASC, id ASC",
      }).catch(() => [] as RowDataPacket[]),
    ]);
    for (const svc of svcRows) {
      const aid = Number(svc.appointment_id ?? 0) || 0;
      if (aid <= 0) continue;
      if (!servicesByAppt.has(aid)) servicesByAppt.set(aid, []);
      servicesByAppt.get(aid)!.push(svc);
    }
    for (const seg of segRows) {
      const aid = Number(seg.appointment_id ?? 0) || 0;
      if (aid <= 0) continue;
      if (!segmentsByAppt.has(aid)) segmentsByAppt.set(aid, []);
      segmentsByAppt.get(aid)!.push(seg);
    }
  }

  const entries: ProducedEntry[] = [];

  for (const appt of appts) {
    const apptId = Number(appt.id ?? 0) || 0;
    if (apptId <= 0) continue;

    const serviceRows = servicesByAppt.get(apptId) ?? [];
    if (!serviceRows.length) continue;

    // Eligible GROSS = Σ over NON-redeemed lines of (price × qty). Apply the
    // appointment discount to get NET, then netFactor = gross>0 ? net/gross : 1.
    // Redeemed lines are excluded from BOTH gross and net (they carry no revenue).
    let gross = 0;
    for (const line of serviceRows) {
      const qty = Math.max(1, Number(line.qty ?? 1) || 1);
      const price = roundMoney(Math.max(0, Number(line.price ?? 0) || 0));
      const listPrice = roundMoney(Math.max(0, Number(line.list_price ?? 0) || 0));
      const lineGross = roundMoney(price * qty);
      const listBase = roundMoney(listPrice * qty);
      if (looksLikeAppointmentRedemption(line, lineGross, listBase)) continue;
      if (lineGross > 0.00001) gross += lineGross;
    }
    gross = roundMoney(gross);

    const discountType = String(appt.discount_type ?? "").trim().toLowerCase();
    const discountValue = Number(appt.discount_value ?? 0) || 0;
    let net = gross;
    if (gross > 0.00001) {
      if (discountType === "percent") {
        const pct = Math.max(0, Math.min(100, discountValue));
        net = roundMoney(Math.max(0, gross * (1 - pct / 100)));
      } else if (discountType === "fixed") {
        net = roundMoney(Math.max(0, gross - Math.max(0, discountValue)));
      }
    }
    const netFactor = gross > 0.00001 ? net / gross : 1;

    const apptLocationId = Number(appt.location_id ?? 0) || 0;
    let apptLocationName = String(appt.location_name ?? "").trim();
    if (apptLocationName === "" && apptLocationId > 0) apptLocationName = await resolveLocationName(apptLocationId);
    const clientName = String(appt.client_name ?? "").trim();

    // Per-service segment queues (staff assigned per service line), consumed in order
    // by (position, id) — the legacy segment-queue behaviour when a service repeats.
    const segmentQueues = new Map<number, number[]>();
    for (const seg of segmentsByAppt.get(apptId) ?? []) {
      const svcId = Number(seg.service_id ?? 0) || 0;
      const sid = Number(seg.staff_id ?? 0) || 0;
      if (svcId <= 0 || sid <= 0) continue;
      if (!segmentQueues.has(svcId)) segmentQueues.set(svcId, []);
      segmentQueues.get(svcId)!.push(sid);
    }

    const reference = String(appt.public_code ?? "").trim() ? `#${String(appt.public_code).trim()}` : `APP#${apptId}`;

    // Per-appointment running line index so duplicate services stay distinct in the entry_key.
    let lineIndex = 0;
    for (const line of serviceRows) {
      const svcId = Number(line.service_id ?? 0) || 0;
      const qty = Math.max(1, Number(line.qty ?? 1) || 1);
      const price = roundMoney(Math.max(0, Number(line.price ?? 0) || 0));
      const listPrice = roundMoney(Math.max(0, Number(line.list_price ?? 0) || 0));
      const lineGross = roundMoney(price * qty);
      const listBase = roundMoney(listPrice * qty);
      const currentIndex = lineIndex;
      lineIndex += 1;

      // REDEMPTION FILTER — skip (no entry) for a redeemed line.
      if (looksLikeAppointmentRedemption(line, lineGross, listBase)) continue;

      // Resolve staff: consume the per-service segment queue in order (positional).
      const queue = segmentQueues.get(svcId);
      let lineStaffId = 0;
      if (queue && queue.length) {
        lineStaffId = queue.length > 1 ? (queue.shift() ?? 0) : queue[0];
      }
      if (lineStaffId <= 0) continue; // no segment → no staff → no commission

      const staff = resolveStaffById(lineStaffId, staffById);
      if (!staff) continue; // staff not an enabled commission operator → no commission
      if (!(staff.appointmentPercent > 0)) continue; // no appointment rate → no commission
      if (staffId > 0 && staff.staffId !== staffId) continue; // per-operator filter

      const base =
        staff.calculationMode === "list_price" ? listBase : roundMoney(lineGross * netFactor);
      if (!(base > 0)) continue;

      const commission = roundMoney((base * staff.appointmentPercent) / 100);

      const serviceLabel = String(line.service_name ?? "").trim() || (svcId > 0 ? `Servizio #${svcId}` : "Servizio");

      entries.push({
        entryKey: commissionEntryKey(`appointments|${apptId}|${svcId}|${currentIndex}|${staff.staffId}`),
        datetime: normalizeDateTimeValue(appt.starts_at, ""),
        staffId: staff.staffId,
        operatorName: staff.name,
        sourceId: apptId,
        locationId: apptLocationId,
        locationName: apptLocationName,
        sourceGroup: "appointments",
        sourceReference: reference,
        sourceLabel: "Appuntamento",
        clientName,
        itemLabel: serviceLabel,
        baseAmount: base,
        percent: roundMoney(staff.appointmentPercent),
        commissionAmount: commission,
        note: String(line.discount_badge ?? "").trim() || "Prestazione eseguita",
      });
    }
  }

  return entries;
}

// upsertEntrySnapshot — idempotent per (tenant, entry_key). If a row exists →
// UPDATE the accrual fields + re-activate (entry_status='active', clear
// cancelled_*), PRESERVING is_paid/paid_at/paid_by. Else INSERT (is_paid=0,
// entry_status='active'). Tenant-safe: tenantSelect to find the row id, then
// tenantUpdate/tenantInsert (the BEFORE INSERT trigger fills tenant_id).
async function upsertEntrySnapshot(
  slug: string,
  table: Awaited<ReturnType<typeof tenantTable>>,
  entry: ProducedEntry,
  existingId: number | null,
): Promise<void> {
  const values: Record<string, unknown> = {
    source_group: entry.sourceGroup,
    source_reference: entry.sourceReference || null,
    source_id: entry.sourceId > 0 ? entry.sourceId : null,
    location_id: entry.locationId > 0 ? entry.locationId : null,
    location_name: entry.locationName ? entry.locationName.slice(0, 190) : null,
    movement_datetime: entry.datetime || null,
    client_name: entry.clientName ? entry.clientName.slice(0, 190) : null,
    item_label: entry.itemLabel ? entry.itemLabel.slice(0, 190) : null,
    base_amount: entry.baseAmount,
    percent_value: entry.percent,
    operator_name: entry.operatorName ? entry.operatorName.slice(0, 190) : null,
    source_label: entry.sourceLabel ? entry.sourceLabel.slice(0, 60) : null,
    commission_amount: entry.commissionAmount,
    entry_status: "active",
  };

  if (existingId && existingId > 0) {
    // Re-activate: refresh accrual fields, clear cancellation, PRESERVE is_paid/paid_at/paid_by.
    await tenantUpdate({
      slug,
      table: table.name,
      id: existingId,
      values: {
        ...values,
        // Only set note when producing one (POS produces a note only for pos_other);
        // otherwise leave any existing note untouched to match the legacy COALESCE-on-empty rule.
        ...(entry.note ? { note: entry.note.slice(0, 255) } : {}),
        cancelled_at: null,
        cancelled_by: null,
        cancellation_reason: null,
        updated_at: new Date(),
      },
    });
  } else {
    await tenantInsert(table, {
      ...values,
      entry_key: entry.entryKey,
      staff_id: entry.staffId,
      note: entry.note ? entry.note.slice(0, 255) : null,
      is_paid: 0,
      paid_at: null,
      paid_by: null,
      cancelled_at: null,
      cancelled_by: null,
      cancellation_reason: null,
    });
  }
}

// syncEntrySnapshots + reconcile: UPSERT every produced entry, then mark any
// EXISTING snapshot of THIS sourceGroup in [from,to] (respecting the location
// filter) whose entry_key is NOT in the produced set as 'cancelled' (a
// voided/deleted sale's or a cancelled appointment's commission stays as
// "Annullato" — never deleted). Faithful to syncEntrySnapshots. The reconcile is
// scoped to a SINGLE source_group so a POS recompute never cancels appointment
// entries and vice versa. is_paid is never touched by the reconcile.
async function syncEntrySnapshots(
  slug: string,
  params: { from: string; to: string; locationId: number },
  produced: ProducedEntry[],
  sourceGroup: "pos" | "appointments",
): Promise<void> {
  const table = await tenantTable(slug, "staff_commission_payments");

  // Load existing snapshots of this source_group in scope keyed by entry_key
  // (id + status), so we can decide UPDATE vs INSERT and detect stale rows to cancel.
  const scopeClauses = ["source_group=?", "DATE(COALESCE(movement_datetime, created_at)) BETWEEN ? AND ?"];
  const scopeParams: unknown[] = [sourceGroup, params.from, params.to];
  if (params.locationId > 0 && (await columnExists(table.name, "location_id"))) {
    scopeClauses.push("(location_id=? OR location_id IS NULL)");
    scopeParams.push(params.locationId);
  }
  const existingRows = await tenantSelect<RowDataPacket>({
    slug,
    table: table.name,
    columns: "id, entry_key, entry_status",
    where: scopeClauses.join(" AND "),
    params: scopeParams,
  }).catch(() => [] as RowDataPacket[]);

  const existingByKey = new Map<string, { id: number; entryStatus: string }>();
  for (const r of existingRows) {
    const key = String(r.entry_key ?? "").trim();
    if (key) existingByKey.set(key, { id: Number(r.id ?? 0) || 0, entryStatus: String(r.entry_status ?? "active") });
  }

  const producedKeys = new Set<string>();
  for (const entry of produced) {
    producedKeys.add(entry.entryKey);
    // The producing scope may differ from the reconcile scope (e.g. staffId filter),
    // so resolve the row id by entry_key directly if not present in the scan.
    let existingId = existingByKey.get(entry.entryKey)?.id ?? null;
    if (existingId === null) {
      const found = await tenantSelect<RowDataPacket>({
        slug,
        table: table.name,
        columns: "id",
        where: "entry_key=?",
        params: [entry.entryKey],
        limit: 1,
      }).catch(() => [] as RowDataPacket[]);
      existingId = found[0] ? Number(found[0].id ?? 0) || 0 : null;
    }
    await upsertEntrySnapshot(slug, table, entry, existingId);
  }

  // Reconcile: any existing in-scope snapshot of this source_group not in the
  // produced set → cancel.
  const nowTs = nowDateTime();
  for (const [key, row] of existingByKey.entries()) {
    if (producedKeys.has(key)) continue;
    if (row.entryStatus === "cancelled") continue; // already cancelled — leave as-is
    await tenantUpdate({
      slug,
      table: table.name,
      id: row.id,
      values: { entry_status: "cancelled", cancelled_at: nowTs, updated_at: new Date() },
    });
  }
}

// Map a persisted staff_commission_payments row → CommissionEntry (entryFromPersistedRow).
function mapPersistedEntry(row: RowDataPacket, staffByName: Map<string, CommissionStaffSetting>): CommissionEntry {
  const staffId = Number(row.staff_id ?? 0) || 0;
  const sourceGroup = String(row.source_group ?? "") === "pos" ? "pos" : "appointments";
  let sourceLabel = String(row.source_label ?? "").trim();
  if (sourceLabel === "") sourceLabel = sourceGroup === "pos" ? "POS" : "Appuntamento";
  let operatorName = String(row.operator_name ?? "").trim();
  if (operatorName === "" && staffId > 0) {
    for (const s of staffByName.values()) {
      if (s.staffId === staffId) {
        operatorName = s.name;
        break;
      }
    }
  }
  const datetime = normalizeDateTimeValue(row.movement_datetime ?? row.created_at ?? "", "");
  const entryStatus = String(row.entry_status ?? "active").trim() || "active";
  return {
    entryKey: String(row.entry_key ?? "").trim(),
    staffId,
    operatorName,
    datetime,
    sourceGroup,
    sourceLabel,
    sourceReference: String(row.source_reference ?? "").trim(),
    clientName: String(row.client_name ?? "").trim(),
    itemLabel: String(row.item_label ?? "").trim(),
    baseAmount: roundMoney(Number(row.base_amount ?? 0) || 0),
    percent: roundMoney(Number(row.percent_value ?? 0) || 0),
    commissionAmount: roundMoney(Number(row.commission_amount ?? 0) || 0),
    entryStatus,
    isPaid: Number(row.is_paid ?? 0) === 1,
    paidAt: row.paid_at ? String(row.paid_at) : null,
    cancelledAt: row.cancelled_at ? String(row.cancelled_at) : null,
    locationId: Number(row.location_id ?? 0) || 0,
    locationName: String(row.location_name ?? "").trim(),
    note: String(row.note ?? "").trim(),
  };
}

// loadPersistedEntriesByStatus — read persisted entries in scope
// (DATE(movement_datetime|created_at) in [from,to]; staff/source/location filters;
// the requested entry_status). Faithful to loadPersistedEntriesByStatus.
async function loadPersistedEntries(
  slug: string,
  params: { from: string; to: string; staffId: number; source: string; locationId: number },
  staffByName: Map<string, CommissionStaffSetting>,
): Promise<CommissionEntry[]> {
  const table = await tenantTable(slug, "staff_commission_payments");
  const clauses = ["DATE(COALESCE(movement_datetime, created_at)) BETWEEN ? AND ?"];
  const queryParams: unknown[] = [params.from, params.to];
  if (params.staffId > 0) {
    clauses.push("staff_id=?");
    queryParams.push(params.staffId);
  }
  if (params.source === "appointments" || params.source === "pos") {
    clauses.push("source_group=?");
    queryParams.push(params.source);
  }
  if (params.locationId > 0 && (await columnExists(table.name, "location_id"))) {
    clauses.push("(location_id=? OR location_id IS NULL)");
    queryParams.push(params.locationId);
  }
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: table.name,
    where: clauses.join(" AND "),
    params: queryParams,
    orderBy: "COALESCE(movement_datetime, created_at) DESC, id DESC",
  }).catch(() => [] as RowDataPacket[]);
  return rows.map((row) => mapPersistedEntry(row, staffByName));
}

function emptySummary(): CommissionSummary {
  return {
    appointmentsBase: 0,
    appointmentsCommission: 0,
    posBase: 0,
    posCommission: 0,
    paidCommission: 0,
    unpaidCommission: 0,
    cancelledCommission: 0,
    totalBase: 0,
    totalCommission: 0,
    entriesCount: 0,
    paidEntriesCount: 0,
    unpaidEntriesCount: 0,
    cancelledEntriesCount: 0,
  };
}

// Upsert a produced set WITHOUT reconciling — the per-operator (staffId>0) path,
// where a filtered view must not cancel another operator's still-valid entries.
async function upsertProducedEntries(slug: string, produced: ProducedEntry[]): Promise<void> {
  if (!produced.length) return;
  const table = await tenantTable(slug, "staff_commission_payments");
  for (const entry of produced) {
    const found = await tenantSelect<RowDataPacket>({
      slug,
      table: table.name,
      columns: "id",
      where: "entry_key=?",
      params: [entry.entryKey],
      limit: 1,
    }).catch(() => [] as RowDataPacket[]);
    const existingId = found[0] ? Number(found[0].id ?? 0) || 0 : null;
    await upsertEntrySnapshot(slug, table, entry, existingId);
  }
}

// buildCommissionDashboard — the GET path. Accrue+persist the in-scope commission
// entries for the requested source(s) — POS (buildPosEntriesFromSales) and/or
// APPOINTMENTS (buildAppointmentEntries) — reconciling each source_group's stale
// snapshots independently, then load persisted entries (active + cancelled) and
// compute the per-operator + global summaries. When the module is disabled, NO
// accrual happens but any pre-existing snapshots are still loaded for display.
export async function buildCommissionDashboard(slug: string, rawParams: CommissionDashboardParams): Promise<CommissionDashboard> {
  const source = ["all", "appointments", "pos"].includes(String(rawParams.source ?? "all")) ? String(rawParams.source ?? "all") : "all";
  const staffId = Math.max(0, Number(rawParams.staffId ?? 0) || 0);
  const locationId = Math.max(0, Number(rawParams.locationId ?? 0) || 0);
  const from = String(rawParams.from ?? "").trim();
  const to = String(rawParams.to ?? "").trim();

  const settings = await getCommissionSettings(slug);
  const staffByName = new Map<string, CommissionStaffSetting>();
  const staffById = new Map<number, CommissionStaffSetting>();
  for (const s of settings.staff) {
    const key = s.name.trim().toLowerCase();
    if (key) staffByName.set(key, s);
    if (s.staffId > 0) staffById.set(s.staffId, s);
  }

  // Accrue only when the module is enabled and a date range is set. POS and
  // APPOINTMENTS are each produced + reconciled against their OWN source_group only
  // (a POS recompute must not cancel appointment entries and vice versa). The
  // reconcile-cancel is gated on a FULL accrual (staffId<=0), faithful to the legacy
  // $canCancelStaleAppointments = $staffId <= 0 gate — a per-operator view only
  // upserts its own entries (no reconcile).
  if (settings.moduleEnabled && from && to) {
    const resolveLocationName = await locationNameResolver(slug);

    if (source === "all" || source === "pos") {
      const producedPos = await buildPosEntriesFromSales(slug, { from, to, staffId, locationId }, staffByName, resolveLocationName);
      if (staffId <= 0) {
        await syncEntrySnapshots(slug, { from, to, locationId }, producedPos, "pos");
      } else {
        await upsertProducedEntries(slug, producedPos);
      }
    }

    if (source === "all" || source === "appointments") {
      const producedAppt = await buildAppointmentEntries(slug, { from, to, staffId, locationId }, staffById, resolveLocationName);
      if (staffId <= 0) {
        await syncEntrySnapshots(slug, { from, to, locationId }, producedAppt, "appointments");
      } else {
        await upsertProducedEntries(slug, producedAppt);
      }
    }
  }

  // Load persisted entries in scope (active + cancelled) for display.
  const entries = from && to ? await loadPersistedEntries(slug, { from, to, staffId, source, locationId }, staffByName) : [];

  // Sort: datetime DESC, operator ASC, item_label ASC (faithful to buildDashboard usort).
  entries.sort((a, b) => {
    const d = b.datetime.localeCompare(a.datetime);
    if (d !== 0) return d;
    const d2 = a.operatorName.localeCompare(b.operatorName);
    if (d2 !== 0) return d2;
    return a.itemLabel.localeCompare(b.itemLabel);
  });

  // Aggregate. Totals are over ACTIVE entries; cancelled tracked separately.
  const operatorSummaryMap = new Map<number, CommissionOperatorSummary>();
  const summary = emptySummary();

  for (const entry of entries) {
    const sid = entry.staffId;
    const isCancelled = entry.entryStatus === "cancelled";
    const group = entry.sourceGroup === "pos" ? "pos" : "appointments";
    const commission = entry.commissionAmount;
    const base = entry.baseAmount;

    if (sid > 0 && !operatorSummaryMap.has(sid)) {
      operatorSummaryMap.set(sid, {
        staffId: sid,
        operatorName: entry.operatorName,
        appointmentsBase: 0,
        appointmentsCommission: 0,
        posBase: 0,
        posCommission: 0,
        paidCommission: 0,
        unpaidCommission: 0,
        cancelledCommission: 0,
        totalBase: 0,
        totalCommission: 0,
        entriesCount: 0,
        paidEntriesCount: 0,
        unpaidEntriesCount: 0,
        cancelledEntriesCount: 0,
      });
    }
    const op = sid > 0 ? operatorSummaryMap.get(sid)! : null;

    if (isCancelled) {
      summary.cancelledCommission += commission;
      summary.cancelledEntriesCount += 1;
      if (op) {
        op.cancelledCommission += commission;
        op.cancelledEntriesCount += 1;
      }
      continue; // cancelled entries do not contribute to base/commission totals
    }

    // Active entry contributes to base/commission + paid/unpaid split.
    if (group === "pos") {
      summary.posBase += base;
      summary.posCommission += commission;
    } else {
      summary.appointmentsBase += base;
      summary.appointmentsCommission += commission;
    }
    summary.entriesCount += 1;
    if (entry.isPaid) {
      summary.paidCommission += commission;
      summary.paidEntriesCount += 1;
    } else {
      summary.unpaidCommission += commission;
      summary.unpaidEntriesCount += 1;
    }

    if (op) {
      if (group === "pos") {
        op.posBase += base;
        op.posCommission += commission;
      } else {
        op.appointmentsBase += base;
        op.appointmentsCommission += commission;
      }
      op.entriesCount += 1;
      if (entry.isPaid) {
        op.paidCommission += commission;
        op.paidEntriesCount += 1;
      } else {
        op.unpaidCommission += commission;
        op.unpaidEntriesCount += 1;
      }
    }
  }

  // If a specific staff was requested but produced no rows, still surface the operator
  // row (faithful to buildDashboard's staff-row backfill).
  if (staffId > 0 && !operatorSummaryMap.has(staffId)) {
    const staff = settings.staff.find((s) => s.staffId === staffId);
    if (staff) {
      operatorSummaryMap.set(staffId, {
        staffId,
        operatorName: staff.name,
        appointmentsBase: 0,
        appointmentsCommission: 0,
        posBase: 0,
        posCommission: 0,
        paidCommission: 0,
        unpaidCommission: 0,
        cancelledCommission: 0,
        totalBase: 0,
        totalCommission: 0,
        entriesCount: 0,
        paidEntriesCount: 0,
        unpaidEntriesCount: 0,
        cancelledEntriesCount: 0,
      });
    }
  }

  const operatorSummary = Array.from(operatorSummaryMap.values()).map((op) => {
    op.appointmentsBase = roundMoney(op.appointmentsBase);
    op.appointmentsCommission = roundMoney(op.appointmentsCommission);
    op.posBase = roundMoney(op.posBase);
    op.posCommission = roundMoney(op.posCommission);
    op.paidCommission = roundMoney(op.paidCommission);
    op.unpaidCommission = roundMoney(op.unpaidCommission);
    op.cancelledCommission = roundMoney(op.cancelledCommission);
    op.totalBase = roundMoney(op.appointmentsBase + op.posBase);
    op.totalCommission = roundMoney(op.appointmentsCommission + op.posCommission);
    return op;
  });
  operatorSummary.sort((a, b) => {
    const d = b.totalCommission - a.totalCommission;
    if (d !== 0) return d;
    return a.operatorName.localeCompare(b.operatorName);
  });

  summary.appointmentsBase = roundMoney(summary.appointmentsBase);
  summary.appointmentsCommission = roundMoney(summary.appointmentsCommission);
  summary.posBase = roundMoney(summary.posBase);
  summary.posCommission = roundMoney(summary.posCommission);
  summary.paidCommission = roundMoney(summary.paidCommission);
  summary.unpaidCommission = roundMoney(summary.unpaidCommission);
  summary.cancelledCommission = roundMoney(summary.cancelledCommission);
  summary.totalBase = roundMoney(summary.appointmentsBase + summary.posBase);
  summary.totalCommission = roundMoney(summary.appointmentsCommission + summary.posCommission);

  const [hasStoredHistory, hasSourceInScope] = await Promise.all([
    probeStoredHistory(slug, { from, to, source, locationId }).catch(() => entries.length > 0),
    probeSourceInScope(slug, { from, to, source, locationId }).catch(() => false),
  ]);

  return {
    moduleEnabled: settings.moduleEnabled,
    configuredRates: settings.configuredRates,
    entries,
    operatorSummary,
    summary,
    staffOptions: settings.staff.map((s) => ({ id: s.staffId, name: s.name || (s.email || `Operatore #${s.staffId}`), isActive: s.isActive })),
    hasStoredHistory,
    hasSourceInScope,
  };
}

// Port di $commissionHasStoredHistoryInScope (commissions.php ~198-214): COUNT su
// staff_commission_payments per DATE(COALESCE(movement_datetime, created_at)) nel range,
// con filtro source_group e sede (location_id=? OR NULL).
async function probeStoredHistory(slug: string, params: { from: string; to: string; source: string; locationId: number }): Promise<boolean> {
  const table = await tenantTable(slug, "staff_commission_payments");
  const clauses = ["DATE(COALESCE(movement_datetime, created_at)) BETWEEN ? AND ?"];
  const values: unknown[] = [params.from, params.to];
  if (table.mode === "shared" && (await columnExists(table.name, "tenant_id"))) {
    clauses.unshift("tenant_id=?");
    values.unshift(table.tenantId ?? 0);
  }
  if (params.source === "appointments" || params.source === "pos") {
    clauses.push("source_group=?");
    values.push(params.source);
  }
  if (params.locationId > 0 && (await columnExists(table.name, "location_id"))) {
    clauses.push("(location_id=? OR location_id IS NULL)");
    values.push(params.locationId);
  }
  const rows = await dbQuery<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)} WHERE ${clauses.join(" AND ")}`, values);
  return Number(rows[0]?.count ?? 0) > 0;
}

// Port di $commissionHasSourceInScope (commissions.php ~216-248): appuntamenti DONE
// per starts_at nel range, poi (se 0) vendite non annullate per sale_date nel range.
async function probeSourceInScope(slug: string, params: { from: string; to: string; source: string; locationId: number }): Promise<boolean> {
  if (params.source === "all" || params.source === "appointments") {
    try {
      const table = await tenantTable(slug, "appointments");
      const clauses = ["a.status='done'", "DATE(a.starts_at) BETWEEN ? AND ?"];
      const values: unknown[] = [params.from, params.to];
      if (table.mode === "shared" && (await columnExists(table.name, "tenant_id"))) {
        clauses.unshift("a.tenant_id=?");
        values.unshift(table.tenantId ?? 0);
      }
      if (params.locationId > 0 && (await columnExists(table.name, "location_id"))) {
        clauses.push("(a.location_id=? OR a.location_id IS NULL)");
        values.push(params.locationId);
      }
      const rows = await dbQuery<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)} a WHERE ${clauses.join(" AND ")}`, values);
      if (Number(rows[0]?.count ?? 0) > 0) return true;
    } catch {
      // best-effort, come il legacy
    }
  }
  if (params.source === "all" || params.source === "pos") {
    try {
      const salesTable = await tenantTable(slug, "sales");
      const itemsTable = await tenantTable(slug, "sale_items");
      const clauses = ["DATE(s.sale_date) BETWEEN ? AND ?"];
      const values: unknown[] = [params.from, params.to];
      if (salesTable.mode === "shared" && (await columnExists(salesTable.name, "tenant_id"))) {
        clauses.unshift("s.tenant_id=?");
        values.unshift(salesTable.tenantId ?? 0);
      }
      if (await columnExists(salesTable.name, "status")) {
        clauses.push("(s.status IS NULL OR s.status NOT IN ('cancelled','canceled'))");
      }
      if (params.locationId > 0 && (await columnExists(salesTable.name, "location_id"))) {
        clauses.push("(s.location_id=? OR s.location_id IS NULL)");
        values.push(params.locationId);
      }
      const join = itemsTable.mode === "shared" && (await columnExists(itemsTable.name, "tenant_id")) ? " AND si.tenant_id=s.tenant_id" : "";
      const rows = await dbQuery<RowDataPacket[]>(
        `SELECT COUNT(DISTINCT s.id) AS count FROM ${quoteIdentifier(salesTable.name)} s JOIN ${quoteIdentifier(itemsTable.name)} si ON si.sale_id=s.id${join} WHERE ${clauses.join(" AND ")}`,
        values,
      );
      if (Number(rows[0]?.count ?? 0) > 0) return true;
    } catch {
      // best-effort
    }
  }
  return false;
}

// markCommissionEntryPaid — set is_paid/paid_at/paid_by by entry_key. THROWS if the
// entry is cancelled (faithful to setEntryPaidStatus's entry_status='cancelled' guard).
// Tenant-safe: tenantSelect to find the row + validate, then tenantUpdate by id.
export async function markCommissionEntryPaid(
  slug: string,
  entryKey: string,
  isPaid: boolean,
  userId: number | null,
): Promise<void> {
  const key = String(entryKey ?? "").trim();
  if (key === "") throw new Error("Movimento commissione non valido.");

  const table = await tenantTable(slug, "staff_commission_payments");
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: table.name,
    columns: "id, entry_status",
    where: "entry_key=?",
    params: [key],
    limit: 1,
  });
  const row = rows[0];
  // Messaggio pagina legacy: l'entry viene cercata nel dataset del filtro POSTato.
  if (!row) throw new Error("Movimento commissione non trovato nel filtro selezionato.");
  if (String(row.entry_status ?? "active").trim() === "cancelled") {
    throw new Error("La commissione annullata non può essere modificata.");
  }

  await tenantUpdate({
    slug,
    table: table.name,
    id: Number(row.id ?? 0) || 0,
    values: {
      is_paid: isPaid ? 1 : 0,
      paid_at: isPaid ? nowDateTime() : null,
      paid_by: isPaid ? (userId && userId > 0 ? userId : null) : null,
      updated_at: new Date(),
    },
  });
}
