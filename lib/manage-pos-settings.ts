import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { columnExists, dbExecute, dbQuery, quoteIdentifier, tenantInsert, tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";
import type { ConfigModuleState, ConfigRecord } from "@/lib/tenant-store";

type TenantTarget = Awaited<ReturnType<typeof tenantTable>>;
type ExpiryUnit = "days" | "months" | "years";

type PosSettings = {
  preorders_expiry_enabled: number;
  preorders_expiry_value: number;
  preorders_expiry_unit: ExpiryUnit;
  prepaids_expiry_enabled: number;
  prepaids_expiry_value: number;
  prepaids_expiry_unit: ExpiryUnit;
  updated_by: number | null;
  updated_at: string;
};

export async function getManagePosSettings(slug: string): Promise<ConfigModuleState> {
  const settings = await settingsRow(slug);
  const [preordersWithoutExpiry, prepaidsWithoutExpiry] = await Promise.all([
    countExistingPreordersWithoutExpiry(slug, settings),
    countExistingPrepaidsWithoutExpiry(slug, settings),
  ]);

  return {
    id: "pos_settings",
    title: "Impostazioni POS",
    records: [
      record(1, "Scadenza preordini", expiryDetail(settings.preorders_expiry_value, settings.preorders_expiry_unit), settings.preorders_expiry_enabled ? "Attiva" : "Disattiva", Boolean(settings.preorders_expiry_enabled), settings.updated_at),
      record(2, "Scadenza prepagati", expiryDetail(settings.prepaids_expiry_value, settings.prepaids_expiry_unit), settings.prepaids_expiry_enabled ? "Attiva" : "Disattiva", Boolean(settings.prepaids_expiry_enabled), settings.updated_at),
      record(3, "Preordini senza scadenza", `${preordersWithoutExpiry}`, "Applicabili", preordersWithoutExpiry > 0, settings.updated_at),
      record(4, "Prepagati senza scadenza", `${prepaidsWithoutExpiry}`, "Applicabili", prepaidsWithoutExpiry > 0, settings.updated_at),
    ],
    settings: {
      preorders_expiry_enabled: Boolean(settings.preorders_expiry_enabled),
      preorders_expiry_value: settings.preorders_expiry_value,
      preorders_expiry_unit: settings.preorders_expiry_unit,
      prepaids_expiry_enabled: Boolean(settings.prepaids_expiry_enabled),
      prepaids_expiry_value: settings.prepaids_expiry_value,
      prepaids_expiry_unit: settings.prepaids_expiry_unit,
      preorders_without_expiry: preordersWithoutExpiry,
      prepaids_without_expiry: prepaidsWithoutExpiry,
    },
    updatedAt: settings.updated_at,
  };
}

export async function saveManagePosSettings(slug: string, input: Record<string, unknown>, userId: number | null): Promise<ConfigModuleState> {
  await ensureSettingsRow(slug);
  await tenantUpdate({
    slug,
    table: "pos_settings",
    id: 1,
    values: {
      preorders_expiry_enabled: enabled(input.preorders_expiry_enabled),
      preorders_expiry_value: normalizeValue(input.preorders_expiry_value),
      preorders_expiry_unit: normalizeUnit(input.preorders_expiry_unit),
      prepaids_expiry_enabled: enabled(input.prepaids_expiry_enabled),
      prepaids_expiry_value: normalizeValue(input.prepaids_expiry_value),
      prepaids_expiry_unit: normalizeUnit(input.prepaids_expiry_unit),
      updated_by: userId,
      updated_at: new Date(),
    },
  });
  return getManagePosSettings(slug);
}

export async function applyExistingPreorders(slug: string): Promise<{ count: number; module: ConfigModuleState }> {
  const settings = await settingsRow(slug);
  if (!settings.preorders_expiry_enabled || settings.preorders_expiry_value <= 0 || !await columnExists((await tenantTable(slug, "sale_items")).name, "preorder_expires_at")) {
    return { count: 0, module: await getManagePosSettings(slug) };
  }

  const saleItemsTable = await tenantTable(slug, "sale_items");
  const salesTable = await tenantTable(slug, "sales");
  const clauses = [
    "si.item_type='product'",
    "LOWER(TRIM(COALESCE(si.item_status,''))) IN ('ordered','ordinato')",
    "si.preorder_expires_at IS NULL",
    "LOWER(TRIM(COALESCE(s.status,''))) NOT IN ('cancelled','canceled','annullata','annullato')",
  ];
  const params: unknown[] = [];
  await addTenantClause(saleItemsTable, "si", clauses, params);
  const salesTenantJoin = salesTable.mode === "shared" && await columnExists(salesTable.name, "tenant_id") ? " AND s.tenant_id=si.tenant_id" : "";
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT si.id, COALESCE(s.sale_date,s.created_at) AS purchase_dt
       FROM ${quoteIdentifier(saleItemsTable.name)} si
       JOIN ${quoteIdentifier(salesTable.name)} s ON s.id=si.sale_id${salesTenantJoin}
      WHERE ${clauses.join(" AND ")}
      ORDER BY si.id ASC`,
    params,
  );

  let count = 0;
  for (const row of rows) {
    const id = Number(row.id ?? 0);
    const expiresAt = computeExpiry(row.purchase_dt, settings.preorders_expiry_value, settings.preorders_expiry_unit);
    if (id <= 0 || !expiresAt) continue;
    const updateClauses = ["id=?", "preorder_expires_at IS NULL"];
    const updateParams: unknown[] = [id];
    await addTenantClause(saleItemsTable, "", updateClauses, updateParams);
    const result = await dbExecute(
      `UPDATE ${quoteIdentifier(saleItemsTable.name)} SET preorder_expires_at=? WHERE ${updateClauses.join(" AND ")}`,
      [expiresAt, ...updateParams],
    );
    count += result.affectedRows > 0 ? 1 : 0;
  }

  return { count, module: await getManagePosSettings(slug) };
}

export async function applyExistingPrepaids(slug: string): Promise<{ count: number; module: ConfigModuleState }> {
  const settings = await settingsRow(slug);
  const table = await tenantTable(slug, "client_prepaid_services");
  if (!settings.prepaids_expiry_enabled || settings.prepaids_expiry_value <= 0 || !await columnExists(table.name, "expires_at")) {
    return { count: 0, module: await getManagePosSettings(slug) };
  }

  const clauses = ["expires_at IS NULL", "LOWER(TRIM(COALESCE(status,'')))='active'", "COALESCE(remaining_qty,0)>0"];
  const params: unknown[] = [];
  await addTenantClause(table, "", clauses, params);
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT id, COALESCE(purchase_date,created_at) AS purchase_dt
       FROM ${quoteIdentifier(table.name)}
      WHERE ${clauses.join(" AND ")}
      ORDER BY id ASC`,
    params,
  );

  let count = 0;
  for (const row of rows) {
    const id = Number(row.id ?? 0);
    const expiresAt = computeExpiry(row.purchase_dt, settings.prepaids_expiry_value, settings.prepaids_expiry_unit);
    if (id <= 0 || !expiresAt) continue;
    const updateClauses = ["id=?", "expires_at IS NULL"];
    const updateParams: unknown[] = [id];
    await addTenantClause(table, "", updateClauses, updateParams);
    const result = await dbExecute(
      `UPDATE ${quoteIdentifier(table.name)} SET expires_at=?, updated_at=? WHERE ${updateClauses.join(" AND ")}`,
      [expiresAt, new Date(), ...updateParams],
    );
    count += result.affectedRows > 0 ? 1 : 0;
  }

  return { count, module: await getManagePosSettings(slug) };
}

async function countExistingPreordersWithoutExpiry(slug: string, settings: PosSettings): Promise<number> {
  if (!settings.preorders_expiry_enabled || settings.preorders_expiry_value <= 0) return 0;
  const saleItemsTable = await tenantTable(slug, "sale_items").catch(() => null);
  const salesTable = await tenantTable(slug, "sales").catch(() => null);
  if (!saleItemsTable || !salesTable || !await columnExists(saleItemsTable.name, "preorder_expires_at")) return 0;
  const clauses = [
    "si.item_type='product'",
    "LOWER(TRIM(COALESCE(si.item_status,''))) IN ('ordered','ordinato')",
    "si.preorder_expires_at IS NULL",
    "LOWER(TRIM(COALESCE(s.status,''))) NOT IN ('cancelled','canceled','annullata','annullato')",
  ];
  const params: unknown[] = [];
  await addTenantClause(saleItemsTable, "si", clauses, params);
  const salesTenantJoin = salesTable.mode === "shared" && await columnExists(salesTable.name, "tenant_id") ? " AND s.tenant_id=si.tenant_id" : "";
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT COUNT(*) AS count
       FROM ${quoteIdentifier(saleItemsTable.name)} si
       JOIN ${quoteIdentifier(salesTable.name)} s ON s.id=si.sale_id${salesTenantJoin}
      WHERE ${clauses.join(" AND ")}`,
    params,
  ).catch(() => []);
  return Number(rows[0]?.count ?? 0) || 0;
}

async function countExistingPrepaidsWithoutExpiry(slug: string, settings: PosSettings): Promise<number> {
  if (!settings.prepaids_expiry_enabled || settings.prepaids_expiry_value <= 0) return 0;
  const table = await tenantTable(slug, "client_prepaid_services").catch(() => null);
  if (!table || !await columnExists(table.name, "expires_at")) return 0;
  const clauses = ["expires_at IS NULL", "LOWER(TRIM(COALESCE(status,'')))='active'", "COALESCE(remaining_qty,0)>0"];
  const params: unknown[] = [];
  await addTenantClause(table, "", clauses, params);
  const rows = await dbQuery<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)} WHERE ${clauses.join(" AND ")}`, params).catch(() => []);
  return Number(rows[0]?.count ?? 0) || 0;
}

async function settingsRow(slug: string): Promise<PosSettings> {
  await ensureSettingsRow(slug);
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "pos_settings", where: "id=1", limit: 1 });
  return normalizeSettings(rows[0] ?? {});
}

async function ensureSettingsRow(slug: string): Promise<void> {
  const existing = await tenantSelect<RowDataPacket>({ slug, table: "pos_settings", columns: "id", where: "id=1", limit: 1 }).catch(() => []);
  if (existing[0]) return;
  await tenantInsert(await tenantTable(slug, "pos_settings"), {
    id: 1,
    preorders_expiry_enabled: 0,
    preorders_expiry_value: 0,
    preorders_expiry_unit: "days",
    prepaids_expiry_enabled: 0,
    prepaids_expiry_value: 0,
    prepaids_expiry_unit: "days",
    updated_at: new Date(),
  });
}

async function addTenantClause(target: TenantTarget, alias: string, clauses: string[], params: unknown[]): Promise<void> {
  const prefix = alias ? `${alias}.` : "";
  if (target.mode === "shared" && await columnExists(target.name, "tenant_id")) {
    clauses.unshift(`${prefix}tenant_id=?`);
    params.unshift(target.tenantId ?? 0);
  }
}

function normalizeSettings(row: RowDataPacket): PosSettings {
  return {
    preorders_expiry_enabled: enabled(row.preorders_expiry_enabled),
    preorders_expiry_value: normalizeValue(row.preorders_expiry_value),
    preorders_expiry_unit: normalizeUnit(row.preorders_expiry_unit),
    prepaids_expiry_enabled: enabled(row.prepaids_expiry_enabled),
    prepaids_expiry_value: normalizeValue(row.prepaids_expiry_value),
    prepaids_expiry_unit: normalizeUnit(row.prepaids_expiry_unit),
    updated_by: row.updated_by ? Number(row.updated_by) : null,
    updated_at: dateTimeString(row.updated_at),
  };
}

function record(id: number, title: string, detail: string, value: string, active: boolean, updatedAt: string): ConfigRecord {
  return { id, module: "pos_settings", title, detail, value, active, updatedAt };
}

function enabled(value: unknown): number {
  const raw = String(value ?? "").toLowerCase();
  return value === true || value === 1 || raw === "1" || raw === "true" || raw === "yes" || raw === "on" ? 1 : 0;
}

function normalizeValue(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(36500, parsed);
}

function normalizeUnit(value: unknown): ExpiryUnit {
  const unit = String(value ?? "").toLowerCase();
  if (unit === "months" || unit === "years") return unit;
  return "days";
}

function expiryDetail(value: number, unit: ExpiryUnit): string {
  const labels: Record<ExpiryUnit, string> = { days: "giorni", months: "mesi", years: "anni" };
  return value > 0 ? `${value} ${labels[unit]}` : "nessuna scadenza automatica";
}

function computeExpiry(value: unknown, amount: number, unit: ExpiryUnit): string | null {
  if (amount <= 0) return null;
  const raw = String(value ?? "").trim();
  const date = raw ? new Date(raw) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  if (unit === "years") date.setFullYear(date.getFullYear() + amount);
  else if (unit === "months") date.setMonth(date.getMonth() + amount);
  else date.setDate(date.getDate() + amount);
  date.setHours(23, 59, 59, 0);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

// Scadenza prepagati per una data d'acquisto (port di
// PosSettings::prepaidExpiryForPurchaseDate, PosSettings.php:247): purchaseDate +
// prepaids_expiry_value × unità alle 23:59:59, oppure null se la scadenza prepagati è
// disattiva o value<=0. Usata al checkout in issuePrepaidFromSale.
export async function prepaidExpiryForPurchaseDate(slug: string, purchaseDate: string): Promise<string | null> {
  const s = await settingsRow(slug).catch(() => null);
  if (!s || !s.prepaids_expiry_enabled) return null;
  const value = normalizeValue(s.prepaids_expiry_value);
  if (value <= 0) return null;
  return computeExpiry(purchaseDate, value, s.prepaids_expiry_unit);
}

function dateTimeString(value: unknown): string {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}
