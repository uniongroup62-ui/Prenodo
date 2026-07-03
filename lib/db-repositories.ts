import "server-only";

import { randomBytes } from "crypto";
import type { RowDataPacket } from "@/lib/tenant-db";
import type { Location } from "@/lib/demo-data";
import type { AppointmentStatus, AppointmentWithMeta } from "@/lib/appointment-engine";
import type {
  AutomationRule,
  ClientPackage,
  ClientPackageStatus,
  ClientPrepaid,
  ClientPrepaidStatus,
  CommissionEntry,
  CommissionStatus,
  ConfigModuleState,
  ConfigRecord,
  CouponRule,
  CouponType,
  GiftBoxInstance,
  GiftBoxStatus,
  GiftCard,
  GiftCardStatus,
  GiftReward,
  Installment,
  InstallmentPlan,
  InstallmentPlanStatus,
  InstallmentStatus,
  ManagedClient,
  ManagedProduct,
  ManagedService,
  NotificationItem,
  PackageCatalog,
  PackageCatalogItem,
  CostItem,
  PosPaymentMethod,
  PosCheckoutInput,
  PosSaleItemInput,
  Preorder,
  PreorderStockStatus,
  PosSale,
  PosSaleItem,
  PosSummary,
  PromotionRule,
  Quote,
  QuoteLine,
  QuoteStatus,
  StockMovement,
  WalletMovement,
  WalletMovementType,
} from "@/lib/tenant-store";
import { tenantDelete, tenantInsert, tenantSelect, tenantTable, tenantUpdate, columnExists, dbExecute, dbQuery, quoteIdentifier, tableExists, tenantIdForSlug, withTenantTransaction, type TenantTable } from "@/lib/tenant-db";
import {
  applyExpirySettingsToOpenLots,
  applyLotsDelta,
  ensureLotsInitialized,
  expireClientLots,
  expiringSoonPoints,
  fidelityLotsSettings,
  pointLotsSchedule,
  reconcilePointLots,
  type PointLotScheduleRow,
} from "@/lib/fidelity-lots";
import { buildModernEmailTemplate, emailConfigured, sendEmail } from "@/lib/email";
import { giftRecalcClient, giftRollbackAppointmentSelection } from "@/lib/gifts-engine";
import { assertAppointmentSlotAvailable, busyCabinRangesForDate, busyRangesForDate, staffTimeoffReasonForRange, type AppointmentSlotSegment, type CabinBusyRange } from "@/lib/public-booking-db";

export async function listDbLocations(slug: string): Promise<Location[]> {
  const table = await tenantTable(slug, "locations");
  const where = await columnExists(table.name, "is_active") ? "COALESCE(is_active, 1) = 1" : "";
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "locations",
    where,
    orderBy: "sort_order ASC, name ASC, id ASC",
  });

  return rows.map((row) => mapLocation(slug, row));
}

export async function listDbClients({
  slug,
  query = "",
  locationId = 0,
  includeArchived = false,
}: {
  slug: string;
  query?: string;
  locationId?: number;
  includeArchived?: boolean;
}): Promise<ManagedClient[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const normalizedQuery = query.trim().toLowerCase();

  if (normalizedQuery) {
    clauses.push("(LOWER(full_name) LIKE ? OR LOWER(email) LIKE ? OR phone LIKE ?)");
    params.push(`%${normalizedQuery}%`, `%${normalizedQuery}%`, `%${normalizedQuery}%`);
  }
  if (locationId > 0) {
    clauses.push("(location_id IS NULL OR location_id = ?)");
    params.push(locationId);
  }
  if (!includeArchived) clauses.push("COALESCE(is_blocked, 0) = 0");

  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "clients",
    where: clauses.join(" AND "),
    params,
    orderBy: "full_name ASC, id DESC",
  });

  return rows.map(mapClient);
}

// Read a single client mapped to the full ManagedClient anagrafica. Used to
// prefill the edit form (route action=get). Port of clients.php
// client_load_accessible + client_profile_defaults.
export async function getDbClient(id: number, slug: string): Promise<ManagedClient | null> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) return null;
  return mapClient(rows[0]);
}

// Build the column -> value map for the full anagrafica, faithful to
// clients.php client_save(). Each extended column is only written when it
// exists in this install (older databases may lack a column). full_name is
// kept coherent: if first/last are provided use "first last", else the provided
// name. registration_date defaults to today (only on create).
async function clientAnagraficaValues(
  table: TenantTable,
  input: Partial<ManagedClient>,
  { isCreate }: { isCreate: boolean },
): Promise<Record<string, unknown>> {
  const first = String(input.firstName ?? "").trim();
  const last = String(input.lastName ?? "").trim();
  const composed = `${first} ${last}`.trim();
  const providedName = String(input.name ?? "").trim();
  const fullName = composed !== "" ? composed : providedName;

  const values: Record<string, unknown> = {
    // Base columns (always present on the clients table).
    full_name: fullName !== "" ? fullName : normalizeName(input.name, "Nuovo cliente"),
    phone: trimOrNull(input.phone),
    email: trimOrNull(input.email),
    notes: trimOrNull(input.note),
    location_id: input.locationId && input.locationId > 0 ? input.locationId : null,
  };

  // Extended columns: only written if the column exists in this install.
  const gender = String(input.gender ?? "").trim().toUpperCase();
  const extended: Record<string, unknown> = {
    first_name: first !== "" ? first : null,
    last_name: last !== "" ? last : null,
    company_name: trimOrNull(input.companyName),
    vat_number: trimOrNull(input.vatNumber),
    tax_code: trimOrNull(input.taxCode),
    sdi: trimOrNull(input.sdi),
    pec: trimOrNull(input.pec),
    phone_home: trimOrNull(input.phoneHome),
    phone2: trimOrNull(input.phone2),
    gender: gender === "M" || gender === "F" ? gender : null,
    birth_date: normalizeClientDate(input.birthDate),
    birth_place: trimOrNull(input.birthPlace),
    region: trimOrNull(input.region),
    province: trimOrNull(input.province),
    city: trimOrNull(input.city),
    address: trimOrNull(input.address),
    cap: trimOrNull(input.cap),
    job_title: trimOrNull(input.jobTitle),
  };

  // registration_date: faithful default = today when not a valid date.
  // On create we always set it; on update we only touch it when a value is sent.
  const reg = normalizeClientDate(input.registrationDate);
  if (isCreate) {
    extended.registration_date = reg ?? todayIso();
  } else if (input.registrationDate !== undefined) {
    extended.registration_date = reg ?? todayIso();
  }

  for (const [col, val] of Object.entries(extended)) {
    if (await columnExists(table.name, col)) values[col] = val;
  }

  return values;
}

export async function createDbClient(input: Partial<ManagedClient>, slug: string): Promise<ManagedClient> {
  const table = await tenantTable(slug, "clients");
  const values = await clientAnagraficaValues(table, input, { isCreate: true });
  values.points = 0;
  values.credit_balance = 0;
  values.is_blocked = 0;
  const id = await tenantInsert(table, values);
  return getSingleClient(slug, id);
}

export async function updateDbClient(id: number, input: Partial<ManagedClient>, slug: string): Promise<ManagedClient> {
  const table = await tenantTable(slug, "clients");
  const values = await clientAnagraficaValues(table, input, { isCreate: false });
  await tenantUpdate({ slug, table: "clients", id, values });
  return getSingleClient(slug, id);
}

export async function archiveDbClient(id: number, slug: string): Promise<ManagedClient> {
  await tenantUpdate({ slug, table: "clients", id, values: { is_blocked: 1, blocked_at: new Date(), blocked_internal_note: "Archiviato da replica Next" } });
  return getSingleClient(slug, id);
}

export type StockRestoreMode = "restore_stock" | "no_restore";

export type DeleteDbClientCascadeResult = {
  deleted: boolean;
  client: ManagedClient;
  reason: string;
  counts: Record<string, number>;
  restoredStockQty: number;
};

// FAITHFUL, ATOMIC cascade port of clients.php client_delete_execute (~1315-1521).
// Replaces the old shallow deleteDbClient (which removed ONLY the clients row and
// orphaned ~40 child tables). Collects every related id list (tenant-scoped),
// then deletes in the EXACT legacy order inside ONE transaction (BEGIN/COMMIT,
// ROLLBACK + rethrow on any error — no partial deletes). Every statement is
// tenant-scoped; every table/column is guarded so a missing one is skipped and
// an empty id-list is a no-op. `reason` is required (legacy guard) and recorded
// best-effort in client_deletion_logs OUTSIDE the critical path. stockRestoreMode
// 'restore_stock' restores product stock from the sales' ordered product items
// (client_delete_restore_product_stock); 'no_restore' (default) leaves stock.
export async function deleteDbClientCascade(
  slug: string,
  clientId: number,
  options: { reason?: string; stockRestoreMode?: StockRestoreMode } = {},
): Promise<DeleteDbClientCascadeResult> {
  if (clientId <= 0) throw new Error("ID cliente mancante.");
  const reason = String(options.reason ?? "").trim();
  if (reason === "") throw new Error("La motivazione è obbligatoria.");
  const stockRestoreMode: StockRestoreMode = options.stockRestoreMode === "restore_stock" ? "restore_stock" : "no_restore";

  // Snapshot the client row before the cascade (used for the return value + log).
  const client = await getSingleClient(slug, clientId);
  const clientIds = [clientId];

  // Resolve each table's PHYSICAL name + the tenant clause ONCE (cached). In
  // shared-tenant mode every row carries tenant_id and we scope every statement
  // with `tenant_id = <id>` (like tenantDelete/tenantSelect); in prefixed/base
  // mode the physical table name itself is the tenant boundary.
  type Resolved = { name: string; tenantClause: string; tenantParams: number[] } | null;
  const resolvedCache = new Map<string, Resolved>();
  const resolve = async (base: string): Promise<Resolved> => {
    if (resolvedCache.has(base)) return resolvedCache.get(base) ?? null;
    let out: Resolved = null;
    try {
      const t = await tenantTable(slug, base);
      if (await tableExists(t.name)) {
        const scoped = t.mode === "shared" && (await columnExists(t.name, "tenant_id"));
        out = {
          name: t.name,
          tenantClause: scoped ? "tenant_id = ?" : "",
          tenantParams: scoped ? [t.tenantId ?? 0] : [],
        };
      }
    } catch {
      out = null;
    }
    resolvedCache.set(base, out);
    return out;
  };

  const cleanIds = (ids: Array<number | string | null | undefined>): number[] =>
    Array.from(new Set(ids.map((v) => Math.trunc(Number(v)) || 0).filter((n) => n > 0)));

  const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(",");

  // Build the OR'd "col IN (...)" WHERE fragment for the columns that exist on a
  // resolved table and have a non-empty id list (mirrors client_delete_where_any).
  // Returns null when nothing applies (so callers no-op).
  const whereAny = async (
    res: NonNullable<Resolved>,
    columnIds: Record<string, number[]>,
  ): Promise<{ where: string; params: number[] } | null> => {
    const parts: string[] = [];
    const params: number[] = [];
    for (const [column, rawIds] of Object.entries(columnIds)) {
      const ids = cleanIds(rawIds);
      if (ids.length === 0) continue;
      if (!(await columnExists(res.name, column))) continue;
      parts.push(`${quoteIdentifier(column)} IN (${placeholders(ids.length)})`);
      params.push(...ids);
    }
    if (parts.length === 0) return null;
    return { where: `(${parts.join(" OR ")})`, params };
  };

  // COLLECT distinct ids from `idColumn` of `base` where any of columnIds match.
  const collectIds = async (base: string, idColumn: string, columnIds: Record<string, number[]>): Promise<number[]> => {
    const res = await resolve(base);
    if (!res || !(await columnExists(res.name, idColumn))) return [];
    const clause = await whereAny(res, columnIds);
    if (!clause) return [];
    const where = [clause.where, res.tenantClause].filter(Boolean).join(" AND ");
    const params = [...clause.params, ...res.tenantParams];
    const rows = await q(`SELECT DISTINCT ${quoteIdentifier(idColumn)} FROM ${quoteIdentifier(res.name)} WHERE ${where}`, params);
    return cleanIds(rows.map((r) => (r as RowDataPacket)[idColumn] as number));
  };

  // The single tenant-aware query fn for the whole cascade (set inside the tx).
  let q!: <T extends RowDataPacket = RowDataPacket>(sql: string, params?: unknown[]) => Promise<T[]>;
  const counts: Record<string, number> = {};
  const bump = (label: string, n: number) => {
    if (n > 0) counts[label] = (counts[label] ?? 0) + n;
  };

  // DELETE FROM base WHERE (any of columnIds) [AND tenant]. Tenant-scoped + guarded;
  // a missing table / no applicable column / empty id-list is a no-op.
  const deleteWhereAny = async (base: string, columnIds: Record<string, number[]>, label: string): Promise<number> => {
    const res = await resolve(base);
    if (!res) return 0;
    const clause = await whereAny(res, columnIds);
    if (!clause) return 0;
    const where = [clause.where, res.tenantClause].filter(Boolean).join(" AND ");
    const params = [...clause.params, ...res.tenantParams];
    const rows = await q(`DELETE FROM ${quoteIdentifier(res.name)} WHERE ${where}`, params);
    const n = rows.length; // RETURNING * rows -> affected count
    bump(label, n);
    return n;
  };

  let restoredStockQty = 0;

  await withTenantTransaction(slug, async (txq) => {
    // Wrap txq so DELETEs return the affected rows (Postgres needs RETURNING to
    // expose them as rows; SELECT/UPDATE/INSERT pass through unchanged).
    q = async <T extends RowDataPacket = RowDataPacket>(sql: string, params: unknown[] = []): Promise<T[]> => {
      const isDelete = /^\s*delete\s/i.test(sql) && !/\breturning\b/i.test(sql);
      return txq<T>(isDelete ? `${sql} RETURNING *` : sql, params);
    };

    // --- COLLECT related id lists (tenant-scoped), in the legacy order ---
    const saleIds = await collectIds("sales", "id", { client_id: clientIds });
    const appointmentIds = await collectIds("appointments", "id", { client_id: clientIds });
    const giftcardIds = await collectIds("giftcards", "id", { client_id: clientIds, recipient_client_id: clientIds });
    const giftboxInstanceIds = await collectIds("giftbox_instances", "id", { client_id: clientIds, recipient_client_id: clientIds });
    const giftInstanceIds = await collectIds("gift_instances", "id", { client_id: clientIds });
    const clientPackageIds = await collectIds("client_packages", "id", { client_id: clientIds });
    const clientPrepaidIds = await collectIds("client_prepaid_services", "id", { client_id: clientIds });
    const cardIds = await collectIds("cards", "id", { client_id: clientIds });
    const quoteIds = await collectIds("quotes", "id", { client_id: clientIds });
    const giftboxRedemptionIds = await collectIds("giftbox_redemptions", "id", { instance_id: giftboxInstanceIds });
    const installmentPlanIds = await collectIds("sale_installment_plans", "id", { client_id: clientIds, sale_id: saleIds });
    const installmentIds = await collectIds("sale_installments", "id", { client_id: clientIds, sale_id: saleIds, plan_id: installmentPlanIds });

    // stock_docs linked to the sales via the "Vendita #<id>" note marker
    // (port of the legacy notes REGEXP collection; Postgres ~ regex).
    const stockDocIds = await collectStockDocIdsForSales(slug, saleIds, q);

    // staff_commission_payments string refs (legacy stores 'VEN#<id>' / 'APP#<id>'
    // in source_reference, NOT bare ids — match those, faithful to client_delete_execute).
    const saleRefs = saleIds.map((id) => `VEN#${id}`);
    const appointmentRefs = appointmentIds.map((id) => `APP#${id}`);

    // (a) restore product stock from the sales' ordered product items.
    if (stockRestoreMode === "restore_stock") {
      restoredStockQty = await restoreProductStockForSales(slug, saleIds, q, resolve, columnExists);
    }

    // (b) appointment ITEM links
    await deleteWhereAny("appointment_giftbox_items", { appointment_id: appointmentIds, instance_id: giftboxInstanceIds, redemption_id: giftboxRedemptionIds }, "collegamenti_prenotazioni");
    await deleteWhereAny("appointment_package_items", { appointment_id: appointmentIds, client_package_id: clientPackageIds }, "collegamenti_prenotazioni");
    await deleteWhereAny("appointment_prepaid_service_items", { appointment_id: appointmentIds, client_prepaid_service_id: clientPrepaidIds }, "collegamenti_prenotazioni");
    await deleteWhereAny("appointment_gift_items", { appointment_id: appointmentIds, instance_id: giftInstanceIds }, "collegamenti_prenotazioni");

    // (c) appointment detail rows
    await deleteWhereAny("appointment_services", { appointment_id: appointmentIds }, "prenotazioni_dettagli");
    await deleteWhereAny("appointment_segments", { appointment_id: appointmentIds }, "prenotazioni_dettagli");

    // (d) promotion redemptions
    await deleteWhereAny("promotion_redemptions", { client_id: clientIds, appointment_id: appointmentIds, sale_id: saleIds }, "promozioni");

    // (e) giftbox redemptions
    await deleteWhereAny("giftbox_redemption_items", { redemption_id: giftboxRedemptionIds }, "giftbox");
    await deleteWhereAny("giftbox_redemptions", { instance_id: giftboxInstanceIds }, "giftbox");

    // (f) packages / prepaids
    await deleteWhereAny("client_prepaid_service_usages", { client_prepaid_service_id: clientPrepaidIds, appointment_id: appointmentIds }, "prepagati");
    await deleteWhereAny("client_package_usages", { client_package_id: clientPackageIds, appointment_id: appointmentIds }, "pacchetti");
    await deleteWhereAny("client_package_transactions", { client_package_id: clientPackageIds, appointment_id: appointmentIds }, "pacchetti");
    await deleteWhereAny("client_package_services", { client_package_id: clientPackageIds }, "pacchetti");
    await deleteWhereAny("client_package_items", { client_package_id: clientPackageIds }, "pacchetti");
    await deleteWhereAny("client_prepaid_services", { id: clientPrepaidIds, client_id: clientIds }, "prepagati");
    await deleteWhereAny("client_packages", { id: clientPackageIds, client_id: clientIds }, "pacchetti");

    // (g) gifts (omaggi)
    await deleteWhereAny("gift_transactions", { client_id: clientIds, instance_id: giftInstanceIds, appointment_id: appointmentIds }, "omaggi");
    await deleteWhereAny("gift_progress_resets", { client_id: clientIds }, "omaggi");
    await deleteWhereAny("gift_instances", { id: giftInstanceIds, client_id: clientIds }, "omaggi");

    // (h) giftcards: child rows, then NULL the giftcard refs on sales/appointments, then the giftcards
    await deleteWhereAny("giftcard_transactions", { giftcard_id: giftcardIds }, "giftcard");
    await deleteWhereAny("giftcard_items", { giftcard_id: giftcardIds }, "giftcard");
    await nullGiftcardRefs("sales", giftcardIds, clientIds);
    await nullGiftcardRefs("appointments", giftcardIds, clientIds);
    await deleteWhereAny("giftcards", { id: giftcardIds, client_id: clientIds, recipient_client_id: clientIds }, "giftcard");

    // (i) giftbox instances
    await deleteWhereAny("giftbox_transactions", { instance_id: giftboxInstanceIds }, "giftbox");
    await deleteWhereAny("giftbox_instance_items", { instance_id: giftboxInstanceIds }, "giftbox");
    await deleteWhereAny("giftbox_instances", { id: giftboxInstanceIds, client_id: clientIds, recipient_client_id: clientIds }, "giftbox");

    // (j) quotes
    await deleteWhereAny("quote_items", { quote_id: quoteIds }, "preventivi");
    await deleteWhereAny("quotes", { id: quoteIds, client_id: clientIds }, "preventivi");

    // (k) stock docs linked to the deleted sales
    await deleteWhereAny("stock_doc_items", { stock_doc_id: stockDocIds }, "magazzino");
    await deleteWhereAny("stock_docs", { id: stockDocIds }, "magazzino");

    // (l) POS stock-cancel actions + installments
    await deleteWhereAny("pos_sale_stock_cancel_actions", { sale_id: saleIds }, "vendite");
    await deleteWhereAny("sale_installments", { id: installmentIds, plan_id: installmentPlanIds, sale_id: saleIds, client_id: clientIds }, "rate");
    await deleteWhereAny("sale_installment_plans", { id: installmentPlanIds, sale_id: saleIds, client_id: clientIds }, "rate");

    // (m) staff commission payments (string source_reference, by source_group)
    await deleteCommissionRefs("pos", saleRefs);
    await deleteCommissionRefs("appointments", appointmentRefs);

    // (n) sales
    await deleteWhereAny("sale_items", { sale_id: saleIds }, "vendite");
    await deleteWhereAny("sales", { id: saleIds, client_id: clientIds }, "vendite");

    // (o) fidelity
    await deleteWhereAny("point_lots", { client_id: clientIds }, "fidelity");
    await deleteWhereAny("transactions", { client_id: clientIds }, "fidelity");
    await deleteWhereAny("events", { client_id: clientIds }, "fidelity");

    // (p) recharges + credit adjustments
    await deleteWhereAny("recharges", { client_id: clientIds }, "ricariche");
    await deleteWhereAny("credit_adjustments", { client_id: clientIds }, "rettifiche_credito");

    // (q) cards
    await deleteWhereAny("card_reminders", { client_id: clientIds, card_id: cardIds }, "tessere");
    await deleteWhereAny("card_code_registry", { client_id: clientIds, card_id: cardIds }, "tessere");
    await deleteWhereAny("cards", { id: cardIds, client_id: clientIds }, "tessere");

    // (r) sheets / consents / documents / tags / booking accounts
    await deleteWhereAny("client_sheet_records", { client_id: clientIds }, "schede_cliente");
    await deleteWhereAny("client_sheet_templates", { client_id: clientIds }, "schede_cliente");
    await deleteWhereAny("client_consent_records", { client_id: clientIds }, "consensi");
    await deleteWhereAny("customer_documents", { client_id: clientIds }, "documenti");
    await deleteWhereAny("customer_tag_map", { client_id: clientIds }, "tag");
    await deleteWhereAny("booking_users", { client_id: clientIds }, "account_booking");

    // (s) appointments
    await deleteWhereAny("appointments", { id: appointmentIds, client_id: clientIds }, "prenotazioni");

    // (t) the clients row itself
    await deleteWhereAny("clients", { id: clientIds }, "clienti");
  });

  // --- helpers that close over q/resolve/whereAny (defined here so they share
  //     the tenant-aware q set inside the transaction) ---

  // UPDATE <table> SET giftcard_id=NULL WHERE giftcard_id IN (...) AND (client_id
  // IS NULL OR client_id NOT IN (clientIds)) — port of client_delete_null_giftcard_refs.
  async function nullGiftcardRefs(base: string, giftcardIdList: number[], clientIdList: number[]): Promise<void> {
    const ids = cleanIds(giftcardIdList);
    if (ids.length === 0) return;
    const res = await resolve(base);
    if (!res || !(await columnExists(res.name, "giftcard_id"))) return;
    const clauses = [`giftcard_id IN (${placeholders(ids.length)})`];
    const params: number[] = [...ids];
    if (clientIdList.length > 0 && (await columnExists(res.name, "client_id"))) {
      clauses.push(`(client_id IS NULL OR client_id NOT IN (${placeholders(clientIdList.length)}))`);
      params.push(...clientIdList);
    }
    if (res.tenantClause) {
      clauses.push(res.tenantClause);
      params.push(...res.tenantParams);
    }
    const rows = await q(`UPDATE ${quoteIdentifier(res.name)} SET giftcard_id=NULL WHERE ${clauses.join(" AND ")} RETURNING id`, params);
    bump("giftcard_riferimenti_scollegati", rows.length);
  }

  // DELETE FROM staff_commission_payments WHERE source_group=? AND source_reference
  // IN (refs) — port of the legacy commission deletes (refs are 'VEN#<id>'/'APP#<id>').
  async function deleteCommissionRefs(group: string, refs: string[]): Promise<void> {
    if (refs.length === 0) return;
    const res = await resolve("staff_commission_payments");
    if (!res) return;
    if (!(await columnExists(res.name, "source_reference")) || !(await columnExists(res.name, "source_group"))) return;
    const clauses = ["source_group = ?", `source_reference IN (${placeholders(refs.length)})`];
    const params: unknown[] = [group, ...refs];
    if (res.tenantClause) {
      clauses.push(res.tenantClause);
      params.push(...res.tenantParams);
    }
    const rows = await q(`DELETE FROM ${quoteIdentifier(res.name)} WHERE ${clauses.join(" AND ")} RETURNING id`, params);
    bump("commissioni", rows.length);
  }

  // Record the deletion best-effort, OUTSIDE the critical path (a failure here
  // must NOT roll back the cascade — the rows are already gone).
  try {
    await recordClientDeletionLog(slug, clientIds, [client.name], counts, reason, stockRestoreMode, restoredStockQty);
  } catch {
    // TODO: surface log failures to an ops channel; the delete itself succeeded.
  }

  const deletedClients = counts["clienti"] ?? 0;
  return {
    deleted: deletedClients > 0,
    client,
    reason: deletedClients > 0 ? "Cliente eliminato." : "Cliente non eliminato.",
    counts,
    restoredStockQty,
  };
}

// Backwards-compatible thin wrapper kept for any existing callers: delegates to
// the faithful cascade (reason required; default no stock restore).
export async function deleteDbClient(
  id: number,
  slug: string,
  deleteReason = "",
): Promise<{ deleted: boolean; client: ManagedClient; reason: string }> {
  const result = await deleteDbClientCascade(slug, id, { reason: deleteReason, stockRestoreMode: "no_restore" });
  return { deleted: result.deleted, client: result.client, reason: result.reason };
}

// Collect stock_docs ids linked to the given sales via the "Vendita #<id>" note
// marker (port of the legacy notes REGEXP block, Postgres `~` regex). Tenant-scoped.
async function collectStockDocIdsForSales(
  slug: string,
  saleIds: number[],
  q: <T extends RowDataPacket = RowDataPacket>(sql: string, params?: unknown[]) => Promise<T[]>,
): Promise<number[]> {
  if (saleIds.length === 0) return [];
  try {
    const t = await tenantTable(slug, "stock_docs");
    if (!(await tableExists(t.name)) || !(await columnExists(t.name, "notes"))) return [];
    const scoped = t.mode === "shared" && (await columnExists(t.name, "tenant_id"));
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const sid of saleIds) {
      // Match "vendita #<id>" with optional spaces, not part of a larger number.
      clauses.push("LOWER(COALESCE(notes,'')) ~ ?");
      params.push(`(^|[^0-9])vendita #[[:space:]]*${sid}([^0-9]|$)`);
    }
    const where = scoped ? `(${clauses.join(" OR ")}) AND tenant_id = ?` : `(${clauses.join(" OR ")})`;
    if (scoped) params.push(t.tenantId ?? 0);
    const rows = await q(`SELECT id FROM ${quoteIdentifier(t.name)} WHERE ${where}`, params);
    return Array.from(new Set(rows.map((r) => Math.trunc(Number((r as RowDataPacket).id)) || 0).filter((n) => n > 0)));
  } catch {
    return [];
  }
}

// Restore product stock from the sales' ordered product sale_items (port of
// client_delete_restore_product_stock + client_delete_product_stock_rows). For
// each non-"ordered" product line, restore qty minus any already-restored qty
// (pos_sale_stock_cancel_actions action='restored'), then products.stock += qty.
// Tenant-scoped via the shared tenant clause. Returns total restored qty.
async function restoreProductStockForSales(
  slug: string,
  saleIds: number[],
  q: <T extends RowDataPacket = RowDataPacket>(sql: string, params?: unknown[]) => Promise<T[]>,
  resolve: (base: string) => Promise<{ name: string; tenantClause: string; tenantParams: number[] } | null>,
  colExists: (table: string, column: string) => Promise<boolean>,
): Promise<number> {
  if (saleIds.length === 0) return 0;
  const saleItemsRes = await resolve("sale_items");
  const productsRes = await resolve("products");
  if (!saleItemsRes || !productsRes) return 0;
  if (!(await colExists(productsRes.name, "stock"))) return 0;
  for (const col of ["item_type", "item_id", "qty"]) {
    if (!(await colExists(saleItemsRes.name, col))) return 0;
  }

  const ph = saleIds.map(() => "?").join(",");
  const hasStatus = await colExists(saleItemsRes.name, "item_status");
  const statusExpr = hasStatus ? "LOWER(TRIM(COALESCE(item_status,'')))" : "''";
  const siWhere = [`sale_id IN (${ph})`, "LOWER(TRIM(COALESCE(item_type,''))) = 'product'", "item_id IS NOT NULL", saleItemsRes.tenantClause].filter(Boolean).join(" AND ");
  const siParams = [...saleIds, ...saleItemsRes.tenantParams];
  const items = await q(
    `SELECT id AS sale_item_id, item_id AS product_id, qty, ${statusExpr} AS st FROM ${quoteIdentifier(saleItemsRes.name)} WHERE ${siWhere}`,
    siParams,
  );
  if (items.length === 0) return 0;

  // Already-restored qty per sale_item from pos_sale_stock_cancel_actions.
  const restoredBySaleItem = new Map<number, number>();
  const cancelRes = await resolve("pos_sale_stock_cancel_actions");
  if (
    cancelRes &&
    (await colExists(cancelRes.name, "sale_id")) &&
    (await colExists(cancelRes.name, "sale_item_id")) &&
    (await colExists(cancelRes.name, "qty")) &&
    (await colExists(cancelRes.name, "action"))
  ) {
    const cWhere = [`sale_id IN (${ph})`, "LOWER(TRIM(COALESCE(action,''))) = 'restored'", "sale_item_id IS NOT NULL", "sale_item_id > 0", cancelRes.tenantClause].filter(Boolean).join(" AND ");
    const cParams = [...saleIds, ...cancelRes.tenantParams];
    const actions = await q(`SELECT sale_item_id, COALESCE(SUM(qty),0) AS qty FROM ${quoteIdentifier(cancelRes.name)} WHERE ${cWhere} GROUP BY sale_item_id`, cParams);
    for (const a of actions) {
      const sid = Math.trunc(Number((a as RowDataPacket).sale_item_id)) || 0;
      restoredBySaleItem.set(sid, Math.max(0, Number((a as RowDataPacket).qty) || 0));
    }
  }

  // Sum the qty to restore per product.
  const qtyByProduct = new Map<number, number>();
  for (const row of items) {
    const r = row as RowDataPacket;
    const saleItemId = Math.trunc(Number(r.sale_item_id)) || 0;
    const productId = Math.trunc(Number(r.product_id)) || 0;
    const qty = Math.max(0, Number(r.qty) || 0);
    const status = String(r.st ?? "").trim().toLowerCase();
    const isOrdered = status === "ordered" || status === "ordinato";
    if (isOrdered || productId <= 0) continue;
    const alreadyRestored = restoredBySaleItem.get(saleItemId) ?? 0;
    const qtyToRestore = Math.max(0, qty - alreadyRestored);
    if (qtyToRestore <= 0.00001) continue;
    qtyByProduct.set(productId, (qtyByProduct.get(productId) ?? 0) + qtyToRestore);
  }

  let restored = 0;
  for (const [productId, rawQty] of qtyByProduct) {
    const qty = Math.max(0, Math.round(rawQty));
    if (qty <= 0) continue;
    const where = ["id = ?", productsRes.tenantClause].filter(Boolean).join(" AND ");
    const params = [qty, productId, ...productsRes.tenantParams];
    await q(`UPDATE ${quoteIdentifier(productsRes.name)} SET stock = stock + ? WHERE ${where}`, params);
    restored += qty;
  }
  return restored;
}

// Best-effort audit row in client_deletion_logs (port of client_delete_insert_log).
// Runs on the pool OUTSIDE the delete transaction; a failure is swallowed by the
// caller (the cascade already committed). Skips silently if the table is absent.
async function recordClientDeletionLog(
  slug: string,
  clientIds: number[],
  clientNames: string[],
  counts: Record<string, number>,
  reason: string,
  stockMode: StockRestoreMode,
  restoredStockQty: number,
): Promise<void> {
  if (!(await tableExists((await tenantTable(slug, "client_deletion_logs")).name))) return;
  const table = await tenantTable(slug, "client_deletion_logs");
  await tenantInsert(table, {
    client_ids: clientIds.join(","),
    client_names: clientNames.join(" | "),
    deleted_count: counts["clienti"] ?? clientIds.length,
    stock_restore_mode: stockMode,
    reason,
    summary_json: JSON.stringify({ deleted_rows: counts, restored_stock_qty: restoredStockQty }),
    deleted_by: null,
  });
}

// Block / unblock a client — faithful port of clients.php (~lines 1775-1813,
// the _mode=block_client / unblock_client POST). Block sets is_blocked=1,
// blocked_at=NOW(), blocked_internal_note=<reason> (the reason is REQUIRED, like
// the legacy "Inserisci una nota interna" guard). Unblock sets is_blocked=0 and
// clears the timestamp + note. Nothing else is deleted (the legacy stresses "Nessun
// dato associato e stato eliminato"). listDbClients hides is_blocked=1 unless
// include_archived, so a blocked client drops out of the default list.
export async function blockDbClient(id: number, slug: string, internalNote: string): Promise<ManagedClient> {
  const note = String(internalNote ?? "").trim();
  if (note === "") throw new Error("Inserisci una nota interna con il motivo della disattivazione.");
  await tenantUpdate({
    slug,
    table: "clients",
    id,
    values: { is_blocked: 1, blocked_at: new Date(), blocked_internal_note: note },
  });
  return getSingleClient(slug, id);
}

export async function unblockDbClient(id: number, slug: string): Promise<ManagedClient> {
  await tenantUpdate({
    slug,
    table: "clients",
    id,
    values: { is_blocked: 0, blocked_at: null, blocked_internal_note: null },
  });
  return getSingleClient(slug, id);
}

// Count rows in a tenant table matching client_id = ? — guarded so a missing
// table/column degrades to 0 (mirrors the legacy client_delete_count_any +
// table_exists/column_exists checks). Used by the delete summary.
async function clientRowCount(slug: string, table: string, column: string, clientId: number): Promise<number> {
  try {
    if (!(await tableExists((await tenantTable(slug, table)).name))) return 0;
    if (!(await columnExists((await tenantTable(slug, table)).name, column))) return 0;
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table,
      columns: "COUNT(*) AS c",
      where: `${quoteIdentifier(column)} = ?`,
      params: [clientId],
    });
    return Math.max(0, Number(rows[0]?.c ?? 0) || 0);
  } catch {
    return 0;
  }
}

export type ManageClientDeleteSummary = {
  vendite: number;
  appuntamenti: number;
  pacchetti: number;
  prepagati: number;
  giftcard: number;
  giftbox: number;
  documenti: number;
  consensi: number;
  schede_cliente: number;
  movimenti_fidelity: number;
  rettifiche_credito: number;
  ricariche: number;
  credito_cliente: number;
  punti: number;
  saldo_giftcard: number;
};

// Delete-cascade SUMMARY — faithful port of the clients.php delete-confirm summary
// (~lines 1215-1248): the counts of what WILL be deleted / affected if this client
// is removed, so the UI can render a "Cosa verra eliminato" confirm panel before
// the actual POST action=delete. Every count is guarded (missing table -> 0). This
// is read-only (it never deletes). Tenant-scoped via tenantSelect; tenant + clients
// permission gated by the route.
export async function getManageClientDeleteSummary(slug: string, clientId: number): Promise<ManageClientDeleteSummary> {
  if (clientId <= 0) throw new Error("ID cliente mancante.");

  const [vendite, appuntamenti, pacchetti, prepagati, documenti, consensi, schedeRecords, txCount, eventCount, rettifiche, ricariche] =
    await Promise.all([
      clientRowCount(slug, "sales", "client_id", clientId),
      clientRowCount(slug, "appointments", "client_id", clientId),
      clientRowCount(slug, "client_packages", "client_id", clientId),
      clientRowCount(slug, "client_prepaid_services", "client_id", clientId),
      clientRowCount(slug, "customer_documents", "client_id", clientId),
      clientRowCount(slug, "client_consent_records", "client_id", clientId),
      clientRowCount(slug, "client_sheet_records", "client_id", clientId),
      clientRowCount(slug, "transactions", "client_id", clientId),
      clientRowCount(slug, "events", "client_id", clientId),
      clientRowCount(slug, "credit_adjustments", "client_id", clientId),
      clientRowCount(slug, "recharges", "client_id", clientId),
    ]);

  // GiftCard / GiftBox counts: count instances where the client is the recipient
  // (the legacy collects both sent + received via client_delete_collect_ids; the
  // detail view + this summary use the recipient relation, which is the rows a
  // delete would remove for the holder). Guarded.
  let giftcard = 0;
  let saldoGiftcard = 0;
  try {
    const gcTable = await tenantTable(slug, "giftcards");
    if (await tableExists(gcTable.name)) {
      const hasRecipient = await columnExists(gcTable.name, "recipient_client_id");
      const target = hasRecipient ? "recipient_client_id = ?" : "client_id = ?";
      const rows = await tenantSelect<RowDataPacket>({
        slug,
        table: "giftcards",
        columns: "COUNT(*) AS c, COALESCE(SUM(balance), 0) AS bal",
        where: target,
        params: [clientId],
      });
      giftcard = Math.max(0, Number(rows[0]?.c ?? 0) || 0);
      saldoGiftcard = roundMoney(Number(rows[0]?.bal ?? 0));
    }
  } catch {
    giftcard = 0;
    saldoGiftcard = 0;
  }

  let giftbox = 0;
  try {
    const gbTable = await tenantTable(slug, "giftbox_instances");
    if (await tableExists(gbTable.name)) {
      const hasRecipient = await columnExists(gbTable.name, "recipient_client_id");
      const target = hasRecipient ? "recipient_client_id = ?" : "client_id = ?";
      const rows = await tenantSelect<RowDataPacket>({
        slug,
        table: "giftbox_instances",
        columns: "COUNT(*) AS c",
        where: target,
        params: [clientId],
      });
      giftbox = Math.max(0, Number(rows[0]?.c ?? 0) || 0);
    }
  } catch {
    giftbox = 0;
  }

  // Credito / punti — the client-row balances that would be wiped.
  let credito = 0;
  let punti = 0;
  try {
    const bal = await dbWalletBalance(clientId, slug);
    credito = roundMoney(bal.credit);
    punti = bal.points;
  } catch {
    credito = 0;
    punti = 0;
  }

  return {
    vendite,
    appuntamenti,
    pacchetti,
    prepagati,
    giftcard,
    giftbox,
    documenti,
    consensi,
    schede_cliente: schedeRecords,
    movimenti_fidelity: txCount + eventCount,
    rettifiche_credito: rettifiche,
    ricariche,
    credito_cliente: credito,
    punti,
    saldo_giftcard: saldoGiftcard,
  };
}

// Client TAGS — port of clients.php client_tags(): the customer_tags joined via
// customer_tag_map for this client. Guarded so missing tables degrade to []. Used
// by the detail view header. (The list mapper leaves tags=[] for performance.)
export async function getDbClientTags(slug: string, clientId: number): Promise<Array<{ id: number; name: string }>> {
  if (clientId <= 0) return [];
  try {
    const mapTable = await tenantTable(slug, "customer_tag_map");
    const tagTable = await tenantTable(slug, "customer_tags");
    if (!(await tableExists(mapTable.name)) || !(await tableExists(tagTable.name))) return [];
    // The tenant filter lives on each table; tenantSelect scopes customer_tag_map,
    // and we join customer_tags by name lookup per mapped id (avoids a cross-table
    // raw join that tenantSelect doesn't model). Read the mapped tag ids first.
    const mapRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "customer_tag_map",
      columns: "tag_id",
      where: "client_id = ?",
      params: [clientId],
    });
    const ids = mapRows.map((r) => Number(r.tag_id ?? 0)).filter((n) => n > 0);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const tagRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "customer_tags",
      columns: "id, name",
      where: `id IN (${placeholders})`,
      params: ids,
      orderBy: "name ASC",
    });
    return tagRows.map((r) => ({ id: Number(r.id ?? 0), name: String(r.name ?? "") })).filter((t) => t.id > 0);
  } catch {
    return [];
  }
}

// Add a tag to a client (port of clients.php _mode=add_tag): find-or-create the
// tenant-scoped customer_tags row by name, then map it to the client (idempotent
// — the legacy INSERT IGNORE). Returns the client's refreshed tag list.
export async function addManageClientTag(slug: string, clientId: number, tagName: string): Promise<Array<{ id: number; name: string }>> {
  if (clientId <= 0) throw new Error("Cliente non valido.");
  const name = String(tagName ?? "").trim();
  if (name === "") return getDbClientTags(slug, clientId);
  const existing = await tenantSelect<RowDataPacket>({ slug, table: "customer_tags", columns: "id", where: "name = ?", params: [name], limit: 1 });
  let tagId = existing[0] ? Number(existing[0].id ?? 0) : 0;
  if (tagId <= 0) tagId = await tenantInsert(await tenantTable(slug, "customer_tags"), { name });
  if (tagId <= 0) throw new Error("Impossibile creare il tag.");
  const mapped = await tenantSelect<RowDataPacket>({ slug, table: "customer_tag_map", columns: "tag_id", where: "client_id = ? AND tag_id = ?", params: [clientId, tagId], limit: 1 });
  if (!mapped[0]) await tenantInsert(await tenantTable(slug, "customer_tag_map"), { client_id: clientId, tag_id: tagId }).catch(() => 0);
  return getDbClientTags(slug, clientId);
}

// Remove a tag from a client (port of clients.php do=remove_tag): delete the
// customer_tag_map row (the customer_tags row is left for reuse). Returns the
// client's refreshed tag list.
export async function removeManageClientTag(slug: string, clientId: number, tagId: number): Promise<Array<{ id: number; name: string }>> {
  if (clientId <= 0 || tagId <= 0) return getDbClientTags(slug, clientId);
  const table = await tenantTable(slug, "customer_tag_map");
  const scoped = table.mode === "shared" && (await columnExists(table.name, "tenant_id"));
  await dbExecute(
    `DELETE FROM ${quoteIdentifier(table.name)} WHERE client_id = ? AND tag_id = ?${scoped ? " AND tenant_id = ?" : ""}`,
    scoped ? [clientId, tagId, table.tenantId ?? 0] : [clientId, tagId],
  ).catch(() => undefined);
  return getDbClientTags(slug, clientId);
}

// ---- Client STORICO (action=history) — the deep per-table drilldown ----------
export type ClientHistoryAppt = {
  id: number;
  startsAt: string;
  statusKey: string;
  statusLabel: string;
  statusBadge: string;
  serviceNames: string;
  staffNames: string;
  subtotal: number;
  discountAmount: number;
  totalNet: number;
};
export type ClientHistorySale = { id: number; saleDate: string; total: number; purchasedItem: string };
export type ClientHistoryQuote = { id: number; number: string; quoteDate: string; validUntil: string; total: number; status: string };
export type ManageClientHistory = {
  client: ManagedClient;
  summary: { total: number; done: number; scheduled: number; pending: number; canceled: number; lastVisit: string | null; nextVisit: string | null };
  scheduledAppts: ClientHistoryAppt[];
  doneAppts: ClientHistoryAppt[];
  canceledAppts: ClientHistoryAppt[];
  packages: QuickBookResidualPackageDetail[];
  giftboxes: QuickBookResidualGiftboxDetail[];
  giftcards: QuickBookResidualGiftcardDetail[];
  quotes: ClientHistoryQuote[];
  sales: ClientHistorySale[];
  salesTotal: number;
};

// Normalize an appointment status to the legacy history buckets (client_history_appt_status_sql).
function clientHistoryStatusKey(raw: unknown): "done" | "scheduled" | "pending" | "canceled" | "no_show" {
  const s = String(raw ?? "").trim().toLowerCase();
  if (["done", "completato", "completed", "concluso"].includes(s)) return "done";
  if (["canceled", "cancelled", "annullato"].includes(s)) return "canceled";
  if (["no_show", "no show", "noshow"].includes(s)) return "no_show";
  if (["scheduled", "confermato", "confirmed", "prenotato"].includes(s)) return "scheduled";
  return "pending";
}
function clientHistoryStatusMeta(key: string): { label: string; badge: string } {
  switch (key) {
    case "done": return { label: "Completato", badge: "bg-success" };
    case "scheduled": return { label: "Confermato", badge: "bg-primary" };
    case "canceled": return { label: "Annullato", badge: "bg-danger" };
    case "no_show": return { label: "No show", badge: "bg-secondary" };
    default: return { label: "In attesa", badge: "bg-warning text-dark" };
  }
}

// Full client STORICO (port of clients.php action=history): per-status appointment
// lists (scheduled/done/canceled, ≤10 each with service + staff names, subtotal,
// discount, net), active packages/giftboxes/giftcards (reused from the residuals
// detail), the last 10 quotes + sales, and the summary counts. All reads are
// tenant-scoped + client-filtered; the appointment service/staff names are joined
// in memory (no cross-tenant raw joins).
export async function getManageClientHistory(slug: string, clientId: number): Promise<ManageClientHistory | null> {
  if (clientId <= 0) return null;
  const client = await getDbClient(clientId, slug);
  if (!client) return null;

  const SECTION_LIMIT = 10;

  // --- Appointments (all for the client) + in-memory service/staff resolution ---
  const apptRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointments",
    columns: "id, starts_at, status, discount_type, discount_value, service_id",
    where: "client_id = ?",
    params: [clientId],
    orderBy: "starts_at DESC, id DESC",
    limit: 500,
  }).catch(() => [] as RowDataPacket[]);
  const apptIds = apptRows.map((r) => Number(r.id ?? 0)).filter((n) => n > 0);

  const svcByAppt = new Map<number, { names: string[]; subtotal: number }>();
  const staffIdByAppt = new Map<number, Set<number>>();
  const staffIds = new Set<number>();
  if (apptIds.length > 0) {
    const ph = apptIds.map(() => "?").join(",");
    const svcRows = await tenantSelect<RowDataPacket>({ slug, table: "appointment_services", columns: "appointment_id, service_name, price, qty", where: `appointment_id IN (${ph})`, params: apptIds }).catch(() => [] as RowDataPacket[]);
    for (const r of svcRows) {
      const aid = Number(r.appointment_id ?? 0);
      if (aid <= 0) continue;
      const entry = svcByAppt.get(aid) ?? { names: [], subtotal: 0 };
      const nm = String(r.service_name ?? "").trim();
      if (nm !== "" && !entry.names.includes(nm)) entry.names.push(nm);
      entry.subtotal += Math.max(0, Number(r.price ?? 0)) * Math.max(1, Number(r.qty ?? 1));
      svcByAppt.set(aid, entry);
    }
    const staffRows = await tenantSelect<RowDataPacket>({ slug, table: "appointment_staff", columns: "appointment_id, staff_id", where: `appointment_id IN (${ph})`, params: apptIds }).catch(() => [] as RowDataPacket[]);
    for (const r of staffRows) {
      const aid = Number(r.appointment_id ?? 0);
      const sid = Number(r.staff_id ?? 0);
      if (aid <= 0 || sid <= 0) continue;
      const set = staffIdByAppt.get(aid) ?? new Set<number>();
      set.add(sid);
      staffIdByAppt.set(aid, set);
      staffIds.add(sid);
    }
  }
  const staffName = new Map<number, string>();
  if (staffIds.size > 0) {
    const ids = Array.from(staffIds);
    const ph = ids.map(() => "?").join(",");
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "staff", columns: "id, full_name", where: `id IN (${ph})`, params: ids }).catch(() => [] as RowDataPacket[]);
    for (const r of rows) staffName.set(Number(r.id ?? 0), String(r.full_name ?? ""));
  }

  const now = Date.now();
  let done = 0, scheduled = 0, pending = 0, canceled = 0;
  let lastVisit: string | null = null;
  let nextVisit: string | null = null;
  const scheduledAppts: ClientHistoryAppt[] = [];
  const doneAppts: ClientHistoryAppt[] = [];
  const canceledAppts: ClientHistoryAppt[] = [];

  for (const r of apptRows) {
    const id = Number(r.id ?? 0);
    const startsAt = toIso(r.starts_at);
    const key = clientHistoryStatusKey(r.status);
    if (key === "done") done++;
    else if (key === "scheduled") scheduled++;
    else if (key === "pending") pending++;
    else if (key === "canceled" || key === "no_show") canceled++;

    const startMs = new Date(startsAt).getTime();
    if (Number.isFinite(startMs)) {
      if (startMs < now && (lastVisit === null || startMs > new Date(lastVisit).getTime())) lastVisit = startsAt;
      if (startMs >= now && (key === "pending" || key === "scheduled") && (nextVisit === null || startMs < new Date(nextVisit).getTime())) nextVisit = startsAt;
    }

    const svc = svcByAppt.get(id) ?? { names: [], subtotal: 0 };
    const subtotal = roundMoney(svc.subtotal);
    let discountAmount = 0;
    const dtype = String(r.discount_type ?? "");
    const dval = Number(r.discount_value ?? 0);
    if (dval > 0) {
      if (dtype === "percent") discountAmount = subtotal * (dval / 100);
      else if (dtype === "fixed") discountAmount = dval;
      discountAmount = Math.min(Math.max(0, discountAmount), subtotal);
    }
    const staffNames = Array.from(staffIdByAppt.get(id) ?? []).map((sid) => staffName.get(sid) ?? "").filter((n) => n !== "").join(", ");
    const meta = clientHistoryStatusMeta(key);
    const row: ClientHistoryAppt = {
      id,
      startsAt,
      statusKey: key,
      statusLabel: meta.label,
      statusBadge: meta.badge,
      serviceNames: svc.names.length > 0 ? svc.names.join(", ") : "(nessun servizio)",
      staffNames,
      subtotal,
      discountAmount: roundMoney(discountAmount),
      totalNet: roundMoney(Math.max(0, subtotal - discountAmount)),
    };
    if (key === "done" && doneAppts.length < SECTION_LIMIT) doneAppts.push(row);
    else if ((key === "pending" || key === "scheduled") && scheduledAppts.length < SECTION_LIMIT) scheduledAppts.push(row);
    else if ((key === "canceled" || key === "no_show") && canceledAppts.length < SECTION_LIMIT) canceledAppts.push(row);
  }

  // --- Active packages/giftboxes/giftcards (reuse the residuals detail) ---
  const residuals = await quickBookClientResidualsDetail(slug, clientId).catch(() => null);

  // --- Sales (last 10, non-cancelled) + purchased-item summary + total ---
  const saleRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "sales",
    columns: "id, sale_date, total, notes, status",
    where: "client_id = ? AND (status IS NULL OR status NOT IN ('cancelled','canceled'))",
    params: [clientId],
    orderBy: "sale_date DESC, id DESC",
    limit: SECTION_LIMIT,
  }).catch(() => [] as RowDataPacket[]);
  const saleIds = saleRows.map((r) => Number(r.id ?? 0)).filter((n) => n > 0);
  const itemsBySale = new Map<number, string[]>();
  if (saleIds.length > 0) {
    const ph = saleIds.map(() => "?").join(",");
    const itemRows = await tenantSelect<RowDataPacket>({ slug, table: "sale_items", columns: "sale_id, item_name, qty, id", where: `sale_id IN (${ph})`, params: saleIds, orderBy: "id ASC" }).catch(() => [] as RowDataPacket[]);
    for (const r of itemRows) {
      const sid = Number(r.sale_id ?? 0);
      if (sid <= 0) continue;
      const arr = itemsBySale.get(sid) ?? [];
      const qty = Number(r.qty ?? 0);
      const nm = String(r.item_name ?? "").trim();
      if (nm !== "") arr.push(qty > 1 ? `${qty}x ${nm}` : nm);
      itemsBySale.set(sid, arr);
    }
  }
  const sales: ClientHistorySale[] = saleRows.map((r) => {
    const id = Number(r.id ?? 0);
    const items = itemsBySale.get(id) ?? [];
    const fallback = String(r.notes ?? "").trim();
    return { id, saleDate: toIso(r.sale_date), total: roundMoney(Number(r.total ?? 0)), purchasedItem: items.length > 0 ? items.join(", ") : fallback !== "" ? fallback : "—" };
  });
  const salesTotalRows = await tenantSelect<RowDataPacket>({ slug, table: "sales", columns: "total", where: "client_id = ? AND (status IS NULL OR status NOT IN ('cancelled','canceled'))", params: [clientId] }).catch(() => [] as RowDataPacket[]);
  const salesTotal = roundMoney(salesTotalRows.reduce((sum, r) => sum + Number(r.total ?? 0), 0));

  // --- Quotes (last 10) ---
  const quoteRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "quotes",
    columns: "id, number, quote_date, valid_until, total, status",
    where: "client_id = ?",
    params: [clientId],
    orderBy: "quote_date DESC, id DESC",
    limit: SECTION_LIMIT,
  }).catch(() => [] as RowDataPacket[]);
  const quotes: ClientHistoryQuote[] = quoteRows.map((r) => ({
    id: Number(r.id ?? 0),
    number: String(r.number ?? ""),
    quoteDate: r.quote_date ? toIso(r.quote_date) : "",
    validUntil: r.valid_until ? toIso(r.valid_until) : "",
    total: roundMoney(Number(r.total ?? 0)),
    status: String(r.status ?? ""),
  }));

  return {
    client,
    summary: { total: apptRows.length, done, scheduled, pending, canceled, lastVisit, nextVisit },
    scheduledAppts,
    doneAppts,
    canceledAppts,
    packages: residuals?.packages ?? [],
    giftboxes: residuals?.giftboxes ?? [],
    giftcards: residuals?.giftcards ?? [],
    quotes,
    sales,
    salesTotal,
  };
}

export type ManageClientDetail = {
  client: ManagedClient;
  fidelity: { points: number; creditBalance: number };
  tags: Array<{ id: number; name: string }>;
  block: { isBlocked: boolean; blockedAt: string | null; blockedInternalNote: string };
  history: QuickBookClientHistorySummary;
  residuals: QuickBookClientResidualsSummary;
};

// Full client DETAIL payload for the faithful "Apri" (action=view) page. Port of
// clients.php action=view (client_load_accessible + client_profile_defaults + the
// fidelity/credit cards + tags + the history summary). Bundles:
//   - client    : the full anagrafica (mapClient)
//   - fidelity  : points + credit_balance (clients row, via dbWalletBalance)
//   - tags      : customer_tags joined via customer_tag_map
//   - block     : is_blocked / blocked_at / blocked_internal_note (the "Disattivato" badge)
//   - history   : appointments total + last/next visit + sales total
//                 (quickBookClientHistorySummary)
//   - residuals : active packages/prepaids/giftcards/giftbox/gifts + credit counts
//                 (quickBookClientResidualsSummary) for the history-section badges
// Tenant-scoped + clients-permission gated by the route. Deep per-table history
// drilldowns (the legacy Storico page's per-status appointment tables, per-package
// snapshots, per-giftcard/giftbox/quote/sale rows) are NOT included here — the UI
// links to the existing dedicated pages for those (TODO: a richer history reader).
export async function getManageClientDetail(slug: string, clientId: number): Promise<ManageClientDetail | null> {
  if (clientId <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", where: "id = ?", params: [clientId], limit: 1 });
  if (!rows[0]) return null;
  const row = rows[0];
  const client = mapClient(row);

  const [bal, tags, history, residuals] = await Promise.all([
    dbWalletBalance(clientId, slug).catch(() => ({ credit: 0, points: 0 })),
    getDbClientTags(slug, clientId),
    quickBookClientHistorySummary(slug, clientId),
    quickBookClientResidualsSummary(slug, clientId),
  ]);

  return {
    client,
    fidelity: { points: bal.points, creditBalance: bal.credit },
    tags,
    block: {
      isBlocked: Number(row.is_blocked ?? 0) === 1,
      blockedAt: row.blocked_at ? String(row.blocked_at) : null,
      blockedInternalNote: String(row.blocked_internal_note ?? ""),
    },
    history,
    residuals,
  };
}

export async function listDbServices({
  slug,
  query = "",
  locationId = 0,
  includeInactive = false,
}: {
  slug: string;
  query?: string;
  locationId?: number;
  includeInactive?: boolean;
}): Promise<ManagedService[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery) {
    clauses.push("LOWER(name) LIKE ?");
    params.push(`%${normalizedQuery}%`);
  }
  if (!includeInactive) clauses.push("COALESCE(is_active, 1) = 1");

  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "services",
    where: clauses.join(" AND "),
    params,
    orderBy: "sort_order ASC, name ASC",
  });

  const mapped = rows.map(mapService);
  if (locationId <= 0) return mapped;
  return mapped.filter((service) => service.locationIds.length === 0 || service.locationIds.includes(locationId));
}

export async function createDbService(input: Partial<ManagedService>, slug: string): Promise<ManagedService> {
  const table = await tenantTable(slug, "services");
  const id = await tenantInsert(table, {
    name: normalizeName(input.name, "Nuovo servizio"),
    duration_min: parseDuration(input.duration, 30),
    price: parseMoney(input.price, 0),
    sort_order: 0,
    is_active: input.active === false ? 0 : 1,
    booking_enabled: input.bookingEnabled === false ? 0 : 1,
    no_operator: 0,
  });

  return getSingleService(slug, id);
}

export async function updateDbService(id: number, input: Partial<ManagedService>, slug: string): Promise<ManagedService> {
  await tenantUpdate({
    slug,
    table: "services",
    id,
    values: {
      name: input.name,
      duration_min: input.duration ? parseDuration(input.duration, 30) : undefined,
      price: input.price ? parseMoney(input.price, 0) : undefined,
      is_active: input.active === undefined ? undefined : input.active ? 1 : 0,
      booking_enabled: input.bookingEnabled === undefined ? undefined : input.bookingEnabled ? 1 : 0,
    },
  });
  return getSingleService(slug, id);
}

export async function deleteDbService(id: number, slug: string): Promise<{ deleted: boolean; deactivated: boolean; service: ManagedService; reason: string }> {
  await tenantUpdate({ slug, table: "services", id, values: { is_active: 0, booking_enabled: 0 } });
  return { deleted: false, deactivated: true, service: await getSingleService(slug, id), reason: "Servizio disattivato come nel gestionale quando ha storico collegato." };
}

export type QuickBookingCabin = {
  id: number;
  name: string;
  locationId: number | null;
};

// Active cabins for the quick-booking offcanvas cabin select (tenant-scoped).
// The cabins table is optional per tenant; a missing table yields an empty list
// rather than an error so the drawer still works without cabins configured.
export async function listQuickBookingCabins(slug: string): Promise<QuickBookingCabin[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "cabins",
    where: "COALESCE(is_active, 1) = 1",
    orderBy: "position ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  return rows
    .map((row) => ({
      id: Number(row.id ?? 0),
      name: String(row.name ?? ""),
      locationId: row.location_id === null || row.location_id === undefined || row.location_id === ""
        ? null
        : Number(row.location_id) || null,
    }))
    .filter((cabin) => cabin.id > 0);
}

export async function listDbProducts({
  slug,
  query = "",
  locationId = 0,
}: {
  slug: string;
  query?: string;
  locationId?: number;
}): Promise<ManagedProduct[]> {
  const clauses: string[] = ["COALESCE(is_active, 1) = 1"];
  const params: unknown[] = [];
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery) {
    clauses.push("(LOWER(name) LIKE ? OR LOWER(COALESCE(sku,'')) LIKE ? OR LOWER(COALESCE(brand,'')) LIKE ?)");
    params.push(`%${normalizedQuery}%`, `%${normalizedQuery}%`, `%${normalizedQuery}%`);
  }

  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "products",
    where: clauses.join(" AND "),
    params,
    orderBy: "name ASC",
  });

  const products = rows.map(mapProduct);
  if (locationId <= 0) return products;
  return products.filter((product) => product.locationId === locationId || product.locationId === 0);
}

export async function createDbProduct(input: Partial<ManagedProduct>, slug: string): Promise<ManagedProduct> {
  const table = await tenantTable(slug, "products");
  const id = await tenantInsert(table, {
    name: normalizeName(input.name, "Nuovo prodotto"),
    brand: input.brand ?? null,
    sku: input.sku ?? null,
    price: parseMoney(input.price, 0),
    stock: Math.max(0, Math.round(input.stock ?? 0)),
    min_stock: Math.max(0, Math.round(input.minStock ?? 0)),
    purchase_price: 0,
    incoming_qty: 0,
    reorder_qty: 0,
    is_active: 1,
    sell_online: input.publicVisible ? 1 : 0,
  });
  return getSingleProduct(slug, id);
}

export async function updateDbProduct(id: number, input: Partial<ManagedProduct>, slug: string): Promise<ManagedProduct> {
  await tenantUpdate({
    slug,
    table: "products",
    id,
    values: {
      name: input.name,
      brand: input.brand,
      sku: input.sku,
      price: input.price ? parseMoney(input.price, 0) : undefined,
      stock: input.stock === undefined ? undefined : Math.max(0, Math.round(input.stock)),
      min_stock: input.minStock === undefined ? undefined : Math.max(0, Math.round(input.minStock)),
      sell_online: input.publicVisible === undefined ? undefined : input.publicVisible ? 1 : 0,
    },
  });
  return getSingleProduct(slug, id);
}

export async function moveDbProductStock({
  productId,
  type,
  quantity,
  reason,
  slug,
}: {
  productId: number;
  type: StockMovement["type"];
  quantity: number;
  reason: string;
  slug: string;
}): Promise<ManagedProduct> {
  const product = await getSingleProduct(slug, productId);
  const amount = Math.max(0, Math.round(quantity));
  if (amount <= 0) throw new Error("Quantita non valida.");
  const nextStock = type === "rettifica" ? amount : product.stock + (type === "scarico" ? -amount : amount);
  if (nextStock < 0) throw new Error("Giacenza insufficiente.");

  await tenantUpdate({ slug, table: "products", id: productId, values: { stock: nextStock } });
  await tryInsertStockMove({ slug, productId, type, quantity: amount, reason });
  return getSingleProduct(slug, productId);
}

export async function deleteDbProduct(id: number, slug: string): Promise<{ deleted: boolean; product: ManagedProduct; reason: string }> {
  const product = await getSingleProduct(slug, id);
  await tenantUpdate({ slug, table: "products", id, values: { is_active: 0 } });
  return { deleted: false, product: { ...product, publicVisible: false }, reason: "Prodotto disattivato per conservare storico e movimenti." };
}

export async function listDbAppointments({
  slug,
  date,
  start,
  end,
}: {
  slug: string;
  date?: string;
  start?: string;
  end?: string;
}): Promise<AppointmentWithMeta[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (date) {
    clauses.push("DATE(starts_at) = ?");
    params.push(date);
  } else {
    if (start) {
      clauses.push("starts_at >= ?");
      params.push(`${start} 00:00:00`);
    }
    if (end) {
      clauses.push("starts_at < ?");
      params.push(`${end} 00:00:00`);
    }
  }

  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointments",
    where: clauses.join(" AND "),
    params,
    orderBy: "starts_at ASC",
  });

  return Promise.all(rows.map((row) => mapAppointment(slug, row)));
}

// Optional MULTI-SERVICE inputs shared by create/update. When `serviceNames`
// is non-empty the appointment is laid out as SEQUENTIAL segments (port of the
// legacy api_appointments.php save action). `staffMap`/`cabinMap` are keyed by
// service id (serviceId -> staffId / serviceId -> cabinId), `cabinId` is the
// explicit drawer cabin (appointments.cabin_id primary). When `serviceNames` is
// empty everything falls back to the single `serviceName` path unchanged.
export type MultiServiceAppointmentInput = {
  serviceNames?: string[];
  cabinId?: number | null;
  staffMap?: Record<number, number>;
  cabinMap?: Record<number, number>;
  // Quick-booking PACKAGE redeem (assets/js/app.js #qb_package_redeem): per-service
  // requests to cover a service with a client's prepaid package. Re-validated +
  // consumed server-side as part of the save (see applyAppointmentPackageRedeems).
  // Optional/empty -> the non-redeem save path is unchanged.
  packageRedeems?: AppointmentPackageRedeem[];
  // Mutable collector the save pushes per-redeem skip warnings into (so the route
  // can surface them without changing AppointmentWithMeta). Optional.
  packageWarnings?: string[];
  // Quick-booking PREPAID-SERVICE redeem (assets/js/app.js #qb_prepaid_service_redeem):
  // per-service requests to cover a service with a client's prepaid-service balance
  // (a prepaid is tied to ONE service directly). Re-validated + consumed server-side
  // as part of the save (see applyAppointmentPrepaidRedeems). Optional/empty -> the
  // non-redeem save path is unchanged. A service already covered by a package redeem
  // is NOT also prepaid-redeemed (the prepaid apply dedupes against it).
  prepaidRedeems?: AppointmentPrepaidRedeem[];
  // Mutable collector the save pushes per-prepaid-redeem skip warnings into. Optional.
  prepaidWarnings?: string[];
  // Quick-booking GIFTCARD redeem (assets/js/app.js #qb_giftcard_redeem): an
  // APPOINTMENT-LEVEL request to apply a client's giftcard BALANCE (a monetary amount)
  // toward the whole appointment (NOT per-service). Re-validated + the giftcard
  // decremented server-side as part of the save (see applyAppointmentGiftcardRedeem).
  // Only ONE giftcard per appointment (first valid). Optional/empty -> unchanged.
  giftcardRedeems?: AppointmentGiftcardRedeem[];
  // Mutable collector the save pushes giftcard-redeem skip warnings into. Optional.
  giftcardWarnings?: string[];
  // Quick-booking GIFTBOX redeem (assets/js/app.js #qb_giftbox_redeem): per-service
  // requests to cover a service with ONE ITEM from a client's giftbox (a per-service
  // item is consumed, the service is zero-charged). Re-validated + the redemption
  // recorded server-side as part of the save (see applyAppointmentGiftboxRedeems).
  // Optional/empty -> the non-redeem save path is unchanged. A service already covered
  // by a package OR prepaid redeem is NOT also giftbox-redeemed (the apply dedupes).
  giftboxRedeems?: AppointmentGiftboxRedeem[];
  // Mutable collector the save pushes per-giftbox-redeem skip warnings into. Optional.
  giftboxWarnings?: string[];
  // Quick-booking GIFT (omaggio) redeem (assets/js/app.js #qb_gift_redeem): per-service
  // requests to cover a service with ONE REWARD from the client's gift (a service reward is
  // a free service; one reward unit is consumed, the service is zero-charged). Re-validated +
  // the redemption recorded server-side as part of the save (see applyAppointmentGiftRedeems).
  // Optional/empty -> the non-redeem save path is unchanged. A service already covered by a
  // package, prepaid OR giftbox redeem is NOT also gift-redeemed (the apply dedupes).
  giftRedeems?: AppointmentGiftRedeem[];
  // Mutable collector the save pushes per-gift-redeem skip warnings into. Optional.
  giftWarnings?: string[];
};

// Resolved multi-service plan: the ordered services, the per-position segment
// layout (sequential in time, each with its own service/staff/cabin), the
// primary service/cabin, total duration, and the distinct staff ids to write to
// appointment_staff. Mirrors calc_total_duration_and_primary + rebuild_segments_for_appointment.
type AppointmentServicePlan = {
  services: RowDataPacket[];
  segments: Array<{
    service: RowDataPacket;
    staffId: number | null;
    cabinId: number | null;
    startsAt: string;
    endsAt: string;
    durationMinutes: number;
  }>;
  primaryService: RowDataPacket;
  primaryCabinId: number | null;
  totalDuration: number;
  end: string;
  staffIds: number[];
};

// Resolve the ordered service list (multi when serviceNames is given, else the
// single serviceName). Then build the sequential segment layout: segment k runs
// from the cumulative cursor to cursor + that service's duration, carrying its
// own staff (staffMap[serviceId], else the single operator) and cabin
// (cabinMap[serviceId], else the explicit cabinId, else the service's cabin).
// The primary service is the FIRST one; the primary cabin is the explicit
// cabinId when provided, else the first service's cabin. Tenant-scoped via the
// resolve* helpers.
// Port of the legacy save guard (api_appointments.php ~3790-3830, live-parity fix
// 2026-07-02): an operator can be assigned to a service only when ENABLED for it.
// staff_services rows pointing at ACTIVE staff form the explicit allow-list for the
// service; a service with NO (active) rows allows ALL active staff (the legacy
// fallback). The special 'SSO' operator is exempt. Throws the exact legacy message.
async function assertStaffAllowedForServices(
  slug: string,
  segments: Array<{ service: RowDataPacket; staffId: number | null }>,
): Promise<void> {
  const checked = new Set<string>();
  for (const seg of segments) {
    const staffId = Math.max(0, Number(seg.staffId ?? 0) || 0);
    const serviceId = Math.max(0, Number(seg.service?.id ?? 0) || 0);
    if (staffId <= 0 || serviceId <= 0) continue;
    const key = `${serviceId}:${staffId}`;
    if (checked.has(key)) continue;
    checked.add(key);

    // SSO exemption (the legacy skips its placeholder operator).
    const staffRows = await tenantSelect<RowDataPacket>({ slug, table: "staff", columns: "id, full_name", where: "id = ?", params: [staffId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    if (String(staffRows[0]?.full_name ?? "").trim() === "SSO") continue;

    // Explicit allow-list: staff_services rows whose staff is ACTIVE (legacy JOIN
    // st.is_active=1 AND full_name<>'SSO'). Empty => no explicit rules => all allowed.
    const ss = await tenantTable(slug, "staff_services").catch(() => null);
    if (!ss) continue;
    const staffTable = await tenantTable(slug, "staff");
    const mapped = await dbQuery<RowDataPacket[]>(
      `SELECT ss.staff_id FROM ${quoteIdentifier(ss.name)} ss JOIN ${quoteIdentifier(staffTable.name)} st ON st.id = ss.staff_id AND st.tenant_id = ss.tenant_id WHERE ss.tenant_id = ? AND ss.service_id = ? AND COALESCE(st.is_active,1) = 1 AND st.full_name <> 'SSO'`,
      [ss.tenantId ?? 0, serviceId],
    ).catch(() => [] as RowDataPacket[]);
    const allowed = mapped.map((r) => Number(r.staff_id ?? 0)).filter((n) => n > 0);
    if (allowed.length > 0 && !allowed.includes(staffId)) {
      const serviceName = String(seg.service?.name ?? `#${serviceId}`);
      throw new Error(`Operatore non abilitato per il servizio "${serviceName}".`);
    }
  }
}

async function planAppointmentServices({
  slug,
  serviceName,
  serviceNames,
  operatorStaffId,
  cabinId,
  staffMap,
  cabinMap,
  start,
}: {
  slug: string;
  serviceName: string;
  serviceNames: string[];
  operatorStaffId: number | null;
  cabinId: number | null;
  staffMap: Record<number, number>;
  cabinMap: Record<number, number>;
  start: string;
}): Promise<AppointmentServicePlan> {
  // Resolve services in order. Backward compatible: when serviceNames is empty
  // fall back to the single serviceName (single-service path unchanged).
  const orderedNames = serviceNames.length > 0 ? serviceNames : [serviceName];
  const services: RowDataPacket[] = [];
  for (const name of orderedNames) {
    services.push(await resolveServiceForAppointment(slug, name));
  }

  const primaryService = services[0];
  const primaryCabinId = cabinId ?? (primaryService.cabin_id === null || primaryService.cabin_id === undefined ? null : Number(primaryService.cabin_id) || null);

  const segments: AppointmentServicePlan["segments"] = [];
  const staffIdSet = new Set<number>();
  let cursor = start;
  let totalDuration = 0;
  for (const service of services) {
    const serviceId = Number(service.id ?? 0);
    const duration = Number(service.duration_min ?? 30);
    // Per-service staff: the explicit staffMap entry wins, else the single
    // operator (single-service path). 0 means "unassigned" → null segment staff.
    const mappedStaff = Number(staffMap[serviceId] ?? 0) || 0;
    const segStaffId = mappedStaff > 0 ? mappedStaff : operatorStaffId;
    // Per-service cabin: cabinMap entry, else the explicit drawer cabin, else
    // the service's own cabin (mirrors the legacy candidate fallback chain).
    const mappedCabin = Number(cabinMap[serviceId] ?? 0) || 0;
    const serviceCabin = service.cabin_id === null || service.cabin_id === undefined ? null : Number(service.cabin_id) || null;
    const segCabinId = mappedCabin > 0 ? mappedCabin : (cabinId ?? serviceCabin);
    const segEnd = addMinutesSqlDate(cursor, duration);
    segments.push({ service, staffId: segStaffId, cabinId: segCabinId, startsAt: cursor, endsAt: segEnd, durationMinutes: duration });
    if (segStaffId && segStaffId > 0) staffIdSet.add(segStaffId);
    cursor = segEnd;
    totalDuration += duration;
  }

  return {
    services,
    segments,
    primaryService,
    primaryCabinId,
    totalDuration,
    end: cursor,
    staffIds: Array.from(staffIdSet),
  };
}

// ---------------------------------------------------------------------------
// CABINA al save — port of resolve_cabin_id_for_range (api_appointments.php:3117)
// and its helpers fetch_active_cabins (:2660), allowed_cabin_ids_for_services
// (:2679) and occupied_cabin_ids_for_range (:2770), applied the way the legacy
// save does: per-segment for multi-servizio (:4426), appointment-level for
// single-service (:11162). Without this, an appointment whose cabin the drawer
// left on AUTO would be stored with a NULL/service-default cabin: it would never
// consume cabin capacity (bookings the legacy refuses with "Nessuna cabina
// disponibile" would silently succeed) and a busy service-default cabin would
// make the H2 occupancy guard refuse bookings the legacy accepts by auto-picking
// the next free cabin.

// Minutes-of-day from a "YYYY-MM-DD HH:MM[:SS]" SQL datetime (occupancy math is
// per-day in minutes, same as busyCabinRangesForDate).
function minutesOfDayFromSqlDate(sqlDate: string): number {
  const m = String(sqlDate ?? "").match(/\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})/);
  if (!m) return Number.NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Active cabin ids usable at a location, in the legacy pick order: cabins bound
// to the location first, then location-less ones, by position then id
// (fetch_active_cabins + order_cabin_ids_by_position).
async function activeCabinIdsForLocation(slug: string, locationId: number | null): Promise<number[]> {
  const hasLocation = typeof locationId === "number" && locationId > 0;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "cabins",
    columns: "id",
    where: hasLocation
      ? "COALESCE(is_active, 1) = 1 AND (location_id = ? OR location_id IS NULL)"
      : "COALESCE(is_active, 1) = 1",
    params: hasLocation ? [locationId] : [],
    orderBy: hasLocation ? "(location_id IS NULL) ASC, position ASC, id ASC" : "position ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  return rows.map((row) => Number(row.id ?? 0)).filter((id) => id > 0);
}

// Allowed cabins for a service set: per service, the service_cabins rows (map
// table), else the service's own services.cabin_id, else ALL active cabins; the
// result is the INTERSECTION across services, restricted to active cabins at the
// location and returned in the active-cabin pick order.
async function allowedCabinIdsForServices(slug: string, serviceIds: number[], locationId: number | null): Promise<number[]> {
  const ids = Array.from(new Set(serviceIds.map((id) => Number(id) || 0).filter((id) => id > 0)));
  if (ids.length === 0) return [];
  const activeIds = await activeCabinIdsForLocation(slug, locationId);
  if (activeIds.length === 0) return [];
  const activeSet = new Set(activeIds);

  const byService = new Map<number, Set<number>>();
  const placeholders = ids.map(() => "?").join(", ");
  const mapRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "service_cabins",
    columns: "service_id, cabin_id",
    where: `service_id IN (${placeholders})`,
    params: ids,
  }).catch(() => [] as RowDataPacket[]);
  for (const row of mapRows) {
    const sid = Number(row.service_id ?? 0);
    const cid = Number(row.cabin_id ?? 0);
    if (sid <= 0 || cid <= 0 || !activeSet.has(cid)) continue;
    if (!byService.has(sid)) byService.set(sid, new Set());
    byService.get(sid)!.add(cid);
  }

  const missing = ids.filter((sid) => !(byService.get(sid)?.size ?? 0));
  if (missing.length > 0) {
    const ph = missing.map(() => "?").join(", ");
    const svcRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "services",
      columns: "id, cabin_id",
      where: `id IN (${ph})`,
      params: missing,
    }).catch(() => [] as RowDataPacket[]);
    for (const row of svcRows) {
      const sid = Number(row.id ?? 0);
      const cid = Number(row.cabin_id ?? 0);
      if (sid > 0 && cid > 0 && activeSet.has(cid)) byService.set(sid, new Set([cid]));
    }
  }
  for (const sid of ids) {
    if (!(byService.get(sid)?.size ?? 0)) byService.set(sid, new Set(activeIds));
  }

  let allowed: Set<number> | null = null;
  for (const sid of ids) {
    const own = byService.get(sid) ?? new Set<number>();
    if (allowed === null) {
      allowed = new Set<number>(own);
    } else {
      const kept = new Set<number>();
      for (const cid of allowed) if (own.has(cid)) kept.add(cid);
      allowed = kept;
    }
  }
  const allowedSet: Set<number> = allowed ?? new Set<number>();
  return activeIds.filter((cid) => allowedSet.has(cid));
}

// Port of action=cabins_for_services (api_appointments.php): the cabins ALLOWED
// for the selected services at the location, each with its FREE/occupied state
// in the chosen window (the drawer select shows occupied ones disabled with the
// "(occupata)" suffix). ends_at defaults to starts_at + the services' total
// duration; auto_select is set when exactly ONE cabin is free (legacy shape).
export async function cabinsForServicesContext({
  slug,
  serviceIds,
  startsAt,
  endsAt,
  excludeAppointmentId = null,
  excludeHoldToken = null,
  locationId = null,
}: {
  slug: string;
  serviceIds: number[];
  startsAt: string;
  endsAt?: string | null;
  excludeAppointmentId?: number | null;
  excludeHoldToken?: string | null;
  locationId?: number | null;
}): Promise<{ cabins: Array<{ id: number; name: string; occupied: boolean }>; freeIds: number[]; autoSelect: number; startsAt: string; endsAt: string }> {
  const ids = Array.from(new Set(serviceIds.map((id) => Math.trunc(Number(id)) || 0).filter((id) => id > 0)));
  let end = String(endsAt ?? "").trim();
  const start = String(startsAt ?? "").trim();
  if (start && (!end || end === start) && ids.length > 0) {
    // Total duration from the services (legacy calc_total_duration_and_primary).
    const ph = ids.map(() => "?").join(", ");
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "id, duration_min", where: `id IN (${ph})`, params: ids }).catch(() => [] as RowDataPacket[]);
    const durById = new Map<number, number>(rows.map((r) => [Number(r.id ?? 0), Math.max(10, Number(r.duration_min ?? 0) || 0)]));
    const totalMin = serviceIds.reduce((sum, id) => sum + (durById.get(Math.trunc(Number(id)) || 0) ?? 0), 0);
    if (totalMin > 0) end = addMinutesSqlDate(start.length === 16 ? `${start}:00` : start, totalMin);
  }

  const allowed = await allowedCabinIdsForServices(slug, ids, locationId ?? null);
  const hasLocation = typeof locationId === "number" && locationId > 0;
  const activeRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "cabins",
    columns: "id, name",
    where: hasLocation
      ? "COALESCE(is_active, 1) = 1 AND (location_id = ? OR location_id IS NULL)"
      : "COALESCE(is_active, 1) = 1",
    params: hasLocation ? [locationId] : [],
    orderBy: hasLocation ? "(location_id IS NULL) ASC, position ASC, id ASC" : "position ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  const allowedSet = new Set(allowed);

  const occupied = new Set<number>();
  if (start && end && allowed.length > 0) {
    const date = start.slice(0, 10);
    const startMin = minutesOfDayFromSqlDate(start.length === 16 ? `${start}:00` : start);
    const endMin = minutesOfDayFromSqlDate(end.length === 16 ? `${end}:00` : end);
    if (Number.isFinite(startMin) && Number.isFinite(endMin)) {
      const ranges = await busyCabinRangesForDate(slug, date, { excludeAppointmentId, excludeHoldToken }).catch(() => [] as CabinBusyRange[]);
      for (const range of ranges) {
        if (!allowedSet.has(range.cabinId)) continue;
        if (range.locationId !== null && hasLocation && range.locationId !== locationId) continue;
        if (range.end > startMin && range.start < endMin) occupied.add(range.cabinId);
      }
    }
  }

  const cabins = activeRows
    .map((row) => ({ id: Number(row.id ?? 0), name: String(row.name ?? "") }))
    .filter((cabin) => cabin.id > 0 && allowedSet.has(cabin.id))
    .map((cabin) => ({ ...cabin, occupied: occupied.has(cabin.id) }));
  const freeIds = cabins.filter((cabin) => !cabin.occupied).map((cabin) => cabin.id);
  return {
    cabins,
    freeIds,
    autoSelect: freeIds.length === 1 ? freeIds[0] : 0,
    // Echo the window normalized to full "YYYY-MM-DD HH:MM:SS" like the legacy.
    startsAt: start.length === 16 ? `${start}:00` : start,
    endsAt: end,
  };
}

// resolve_cabin_id_for_range: validate the requested cabin (allowed + free) or
// auto-pick the first free allowed cabin. Throws the exact legacy messages.
async function resolveCabinIdForRange({
  slug,
  requestedCabinId,
  serviceIds,
  startsAt,
  endsAt,
  locationId,
  excludeAppointmentId = null,
  excludeHoldToken = null,
}: {
  slug: string;
  requestedCabinId: number;
  serviceIds: number[];
  startsAt: string;
  endsAt: string;
  locationId: number | null;
  excludeAppointmentId?: number | null;
  excludeHoldToken?: string | null;
}): Promise<number> {
  const allowed = await allowedCabinIdsForServices(slug, serviceIds, locationId);
  if (allowed.length === 0) throw new Error("Nessuna cabina configurata per i servizi selezionati.");

  const date = String(startsAt).slice(0, 10);
  const startMin = minutesOfDayFromSqlDate(startsAt);
  const endMin = minutesOfDayFromSqlDate(endsAt);
  const ranges = await busyCabinRangesForDate(slug, date, { excludeAppointmentId, excludeHoldToken }).catch(() => [] as CabinBusyRange[]);
  const occupied = new Set<number>();
  if (Number.isFinite(startMin) && Number.isFinite(endMin)) {
    for (const range of ranges) {
      if (!allowed.includes(range.cabinId)) continue;
      // Legacy location filter: a range bound to ANOTHER location never blocks;
      // a location-less range blocks everywhere (a.location_id=? OR IS NULL).
      if (range.locationId !== null && locationId !== null && locationId > 0 && range.locationId !== locationId) continue;
      if (range.end > startMin && range.start < endMin) occupied.add(range.cabinId);
    }
  }

  const requested = Math.max(0, Number(requestedCabinId) || 0);
  if (requested > 0) {
    if (!allowed.includes(requested)) throw new Error("La cabina selezionata non è abilitata per i servizi scelti.");
    if (occupied.has(requested)) throw new Error("Cabina selezionata occupata nell'orario selezionato.");
    return requested;
  }
  for (const cid of allowed) {
    if (!occupied.has(cid)) return cid;
  }
  throw new Error("Nessuna cabina disponibile nell'orario selezionato.");
}

// Apply the legacy cabin resolution to a service plan (mutates plan segments +
// primaryCabinId). Feature gate: a tenant with ZERO cabins skips resolution
// entirely — the shared-schema equivalent of the legacy per-tenant
// table_exists('cabins') gate, so cabin-less tenants keep saving with NULL cabins.
//  * single service: appointment-level resolve on the FULL range — requested
//    cabin, else keep the current one (edit), else auto-pick; if keeping the
//    current fails and nothing was requested, retry with auto-pick (:11173-11180).
//  * multi-servizio: cabins are per SEGMENT (:4426) — an explicit per-service
//    choice (cabin_map) is validated strictly (no fallback); otherwise try the
//    old segment cabin at the same position, then the appointment's cabin, then
//    auto-pick. appointments.cabin_id stays NULL in this mode (legacy
//    $use_segment_cabins_multi).
async function resolvePlanCabins({
  slug,
  plan,
  requestedCabinId,
  cabinMap,
  locationId,
  excludeAppointmentId = null,
  excludeHoldToken = null,
  currentCabinId = null,
  currentSegmentCabins = [],
}: {
  slug: string;
  plan: AppointmentServicePlan;
  requestedCabinId: number | null;
  cabinMap: Record<number, number>;
  locationId: number | null;
  excludeAppointmentId?: number | null;
  excludeHoldToken?: string | null;
  currentCabinId?: number | null;
  currentSegmentCabins?: number[];
}): Promise<void> {
  const anyCabins = await tenantSelect<RowDataPacket>({ slug, table: "cabins", columns: "id", limit: 1 }).catch(() => [] as RowDataPacket[]);
  if (anyCabins.length === 0) return;

  const common = { slug, locationId, excludeAppointmentId, excludeHoldToken };
  const current = Math.max(0, Number(currentCabinId ?? 0) || 0);

  if (plan.segments.length <= 1) {
    const requested = Math.max(0, Number(requestedCabinId ?? 0) || 0);
    const req = requested > 0 ? requested : current;
    const serviceIds = plan.services.map((service) => Number(service.id ?? 0)).filter((id) => id > 0);
    const startsAt = plan.segments[0]?.startsAt ?? "";
    let resolved: number;
    try {
      resolved = await resolveCabinIdForRange({ ...common, requestedCabinId: req, serviceIds, startsAt, endsAt: plan.end });
    } catch (error) {
      if (requested <= 0 && current > 0 && req === current) {
        resolved = await resolveCabinIdForRange({ ...common, requestedCabinId: 0, serviceIds, startsAt, endsAt: plan.end });
      } else {
        throw error;
      }
    }
    plan.primaryCabinId = resolved;
    for (const seg of plan.segments) seg.cabinId = resolved;
    return;
  }

  plan.primaryCabinId = null;
  for (const [position, seg] of plan.segments.entries()) {
    const serviceId = Number(seg.service.id ?? 0);
    const explicit = Math.max(0, Number(cabinMap[serviceId] ?? 0) || 0);
    if (explicit > 0) {
      seg.cabinId = await resolveCabinIdForRange({ ...common, requestedCabinId: explicit, serviceIds: [serviceId], startsAt: seg.startsAt, endsAt: seg.endsAt });
      continue;
    }
    const candidates: number[] = [];
    const posCabin = Math.max(0, Number(currentSegmentCabins[position] ?? 0) || 0);
    if (posCabin > 0) candidates.push(posCabin);
    if (current > 0 && !candidates.includes(current)) candidates.push(current);
    candidates.push(0);
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        seg.cabinId = await resolveCabinIdForRange({ ...common, requestedCabinId: candidate, serviceIds: [serviceId], startsAt: seg.startsAt, endsAt: seg.endsAt });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
  }
}

// FIDELITY points at save — the exact legacy guard chain (each step verified
// LIVE against the PHP save, 2026-07-02):
//  1. redeem disabled (or fidelity off) => the request is silently ZEROED and
//     the save proceeds with fidelity_points_used=0;
//  2. redeem enabled but the client has NO active card => hard error
//     "Cliente non aderisce alla Fidelity" (no trailing period);
//  3. the non-stackable-promotion conflict fires on the RAW request (before any
//     balance check — a request conflicts even with zero balance): the CALLER
//     runs it on the returned points;
//  4. only then the balance: none => "Punti non disponibili.", short =>
//     "Punti insufficienti.", below minimum => "Minimo punti utilizzabile: X.".
type FidelitySaveGate = { points: number; settings: FidelityPointsSettings | null };

async function fidelityPointsGateForSave(slug: string, clientId: number, requestedPoints: number): Promise<FidelitySaveGate> {
  const requested = Math.max(0, Math.round(Number(requestedPoints) || 0));
  if (requested <= 0 || clientId <= 0) return { points: 0, settings: null };
  const settings = await getFidelityPointsSettings(slug).catch(() => null);
  if (!settings || !settings.globalEnabled || !settings.redeemEnabled) return { points: 0, settings: null };
  if (!(await fidelityIsClientAdhering(slug, clientId))) throw new Error("Cliente non aderisce alla Fidelity");
  return { points: requested, settings };
}

async function assertFidelityPointsBalanceForSave(slug: string, clientId: number, gate: FidelitySaveGate): Promise<void> {
  if (gate.points <= 0 || !gate.settings) return;
  const { points } = await dbWalletBalance(clientId, slug);
  const available = Math.max(0, Math.floor(points));
  if (available <= 0) throw new Error("Punti non disponibili.");
  if (gate.points > available) throw new Error("Punti insufficienti.");
  if (gate.settings.redeemMinPoints > 0 && gate.points < gate.settings.redeemMinPoints) {
    throw new Error(`Minimo punti utilizzabile: ${gate.settings.redeemMinPoints}.`);
  }
}

// Legacy blocked-client guard at save (api_appointments.php:9995): a client with
// is_blocked=1 cannot be booked from Quick Booking. EXCEPTION (edit): an
// appointment that ALREADY belongs to that blocked client can still be edited —
// only assigning a blocked client anew is refused ($sameExistingBlockedClient).
// Throws the exact legacy operational message (client_block_operational_message).
async function assertClientNotBlockedForSave(slug: string, clientId: number, currentAppointmentClientId: number | null = null): Promise<void> {
  if (!clientId || clientId <= 0) return;
  if (currentAppointmentClientId && currentAppointmentClientId === clientId) return;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "clients",
    columns: "COALESCE(is_blocked, 0) AS is_blocked",
    where: "id = ?",
    params: [clientId],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  if (Number(rows[0]?.is_blocked ?? 0) === 1) {
    throw new Error("Questo cliente è disattivato e non può essere utilizzato in Pagamenti o Quick Booking finché non viene riattivato.");
  }
}

// Generate a unique 5-digit booking code (port of the legacy ensure_unique_public_code).
async function generateUniqueAppointmentPublicCode(slug: string): Promise<string | null> {
  try {
    const table = await tenantTable(slug, "appointments");
    if (!(await columnExists(table.name, "public_code"))) return null;
    for (let attempt = 0; attempt < 25; attempt++) {
      const code = String(Math.floor(10000 + Math.random() * 90000));
      const rows = await tenantSelect<RowDataPacket>({
        slug,
        table: "appointments",
        columns: "id",
        where: "public_code = ?",
        params: [code],
        limit: 1,
      });
      if (rows.length === 0) return code;
    }
  } catch {
    // best-effort: a missing public_code column just means no booking code
  }
  return null;
}

// Normalize the quick-booking manual SCONTO (port of the drawer recompute / the legacy
// renderPriceDetails math): type is "" (none) | "percent" | "fixed"; value is the raw
// text the staff typed. Returns the DB column pair {discount_type, discount_value}.
// A percent is clamped to [0, 100]; a fixed amount is clamped >= 0 (the per-line cap to
// subtotal is a display concern — the stored value is the staff's chosen figure, matching
// the legacy which persists discount_value as entered). An empty/invalid input => 0.
function normalizeAppointmentDiscount(
  type: string | undefined,
  value: string | undefined,
): { discount_type: string | null; discount_value: number } {
  const dtype = type === "percent" || type === "fixed" ? type : "";
  let dval = Number.parseFloat(String(value ?? "").replace(",", "."));
  if (!Number.isFinite(dval) || dval < 0) dval = 0;
  if (!dtype || dval <= 0) return { discount_type: null, discount_value: 0 };
  if (dtype === "percent" && dval > 100) dval = 100;
  return { discount_type: dtype, discount_value: roundMoney(dval) };
}

// COUPON persistence via appointments.notes (Block 4). The Next appointments table has no
// coupon_code/coupon_discount columns (unlike the legacy sales/appointments), so — mirroring
// the legacy coupon_apply_meta_to_notes (Helpers.php:3329) — the applied coupon is embedded
// as two marker lines appended to notes: "Coupon: <CODE>" and "Sconto coupon: - € <AMT>".
// extract_coupon_meta_from_notes reads them back on action=get so an edited appointment
// re-shows the coupon. The markers are stripped before re-embedding so a re-save can't stack.
const COUPON_CODE_MARKER = "Coupon:";
const COUPON_DISCOUNT_MARKER = "Sconto coupon: - €"; // "Sconto coupon: - €"

// Format an amount the legacy way for the notes marker: 2 decimals, dot-decimal (the legacy
// stores the raw figure; the drawer re-parses it tolerating comma/dot). e.g. 5 -> "5.00".
function formatCouponAmount(amount: number): string {
  return (Math.round((Math.max(0, amount) + Number.EPSILON) * 100) / 100).toFixed(2);
}

// Strip any previously-embedded coupon marker lines from a notes string (idempotent), so
// re-embedding never duplicates them. Trims trailing blank lines the strip may leave.
function stripCouponMetaFromNotes(notes: unknown): string {
  const raw = String(notes ?? "");
  if (!raw) return "";
  const kept = raw
    .split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith(COUPON_CODE_MARKER) || t.startsWith(COUPON_DISCOUNT_MARKER));
    });
  return kept.join("\n").replace(/\n+$/g, "").trim();
}

// Embed the applied coupon (code + discount) into notes as the two marker lines, after
// stripping any prior markers. Empty code / non-positive discount => the markers are removed
// (a coupon was cleared). Returns the new notes string (may be ""), for the notes column.
function couponApplyMetaToNotes(
  notes: unknown,
  couponCode: string | undefined,
  couponDiscount: number | undefined,
): string {
  const base = stripCouponMetaFromNotes(notes);
  const code = String(couponCode ?? "").trim().toUpperCase();
  const amount = roundMoney(Math.max(0, Number(couponDiscount ?? 0) || 0));
  if (!code || amount <= 0) return base;
  const markers = `${COUPON_CODE_MARKER} ${code}\n${COUPON_DISCOUNT_MARKER} ${formatCouponAmount(amount)}`;
  return base ? `${base}\n${markers}` : markers;
}

// Read the embedded coupon back out of a notes string (port of extract_coupon_meta_from_notes,
// api_appointments.php:8950). Returns the code + discount when both markers are present, else
// an empty code + 0 (no coupon). Tolerates comma/dot in the amount.
function extractCouponMetaFromNotes(notes: unknown): { code: string; discount: number } {
  const raw = String(notes ?? "");
  if (!raw) return { code: "", discount: 0 };
  let code = "";
  let discount = 0;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith(COUPON_CODE_MARKER)) {
      code = t.slice(COUPON_CODE_MARKER.length).trim().toUpperCase();
    } else if (t.startsWith(COUPON_DISCOUNT_MARKER)) {
      discount = roundMoney(Math.max(0, parseMoney(t.slice(COUPON_DISCOUNT_MARKER.length), 0)));
    }
  }
  if (!code || discount <= 0) return { code: "", discount: 0 };
  return { code, discount };
}

export async function createDbAppointment({
  slug,
  clientId,
  clientName,
  serviceName,
  operator,
  time,
  date,
  locationId,
  holdToken,
  staffNotes,
  customerNotes,
  serviceNames = [],
  cabinId = null,
  staffMap = {},
  cabinMap = {},
  packageRedeems = [],
  packageWarnings,
  prepaidRedeems = [],
  prepaidWarnings,
  giftcardRedeems = [],
  giftcardWarnings,
  giftboxRedeems = [],
  giftboxWarnings,
  giftRedeems = [],
  giftWarnings,
  // Default 'scheduled' faithful to the legacy save ($_POST['status'] ?? 'scheduled').
  // Callers that need 'pending' (the public booking confirm) pass it explicitly.
  status: statusInput = "scheduled",
  discountType,
  discountValue,
  fidelityPointsUsed,
  creditUsed,
  couponCode,
  couponDiscount,
}: {
  slug: string;
  // The SELECTED client id (#qb_client_id from the drawer). Preferred over clientName so a
  // save binds to the exact client chosen, not the first name match (clients can share a name).
  clientId?: number | null;
  clientName: string;
  serviceName: string;
  operator: string;
  time: string;
  date: string;
  locationId: number | null;
  holdToken?: string | null;
  staffNotes?: string | null;
  customerNotes?: string | null;
  status?: string;
  discountType?: string;
  discountValue?: string;
  // Block 4 deductions from the drawer price panel: fidelity points RESERVED at booking
  // (settled on done by awardAppointmentFidelityOnDone), the customer CREDIT spent (debited
  // from the wallet at create), and the applied COUPON (embedded into notes).
  fidelityPointsUsed?: number;
  creditUsed?: number;
  couponCode?: string;
  couponDiscount?: number;
} & MultiServiceAppointmentInput): Promise<AppointmentWithMeta> {
  const client = await resolveClientForAppointment(slug, clientName, locationId, clientId);
  // Legacy blocked-client guard: a disabled client cannot be booked (create has
  // no "same existing client" exception — that only applies to edits).
  await assertClientNotBlockedForSave(slug, Number(client.id ?? 0));
  const staff = operator ? await resolveStaffForAppointment(slug, operator) : null;
  const operatorStaffId = staff ? Number(staff.id ?? 0) : null;
  const normalizedTime = normalizeTime(time);
  const start = `${date} ${normalizedTime}:00`;
  const plan = await planAppointmentServices({
    slug,
    serviceName,
    serviceNames,
    operatorStaffId,
    cabinId,
    staffMap,
    cabinMap,
    start,
  });
  const end = plan.end;
  const token = (holdToken ?? "").trim();
  if (token) {
    await assertDbAppointmentHold({
      slug,
      token,
      ownerKey: "manage",
      startsAt: start,
      serviceId: Number(plan.primaryService.id ?? 0),
      staffId: operatorStaffId,
      locationId,
    });
  }
  // Double-booking guard: refuse to book an operator already busy at this time.
  // Legacy staff-service guard: each segment's operator must be enabled for its
  // service (see assertStaffAllowedForServices).
  await assertStaffAllowedForServices(slug, plan.segments);
  // Cabina: validate the drawer choice / auto-pick the first free allowed cabin
  // per segment, exactly like the legacy save (resolve_cabin_id_for_range).
  await resolvePlanCabins({
    slug,
    plan,
    requestedCabinId: cabinId,
    cabinMap,
    locationId,
    excludeHoldToken: token || null,
  });
  // Exclude this booking's own active hold (its [Disponibilità] reservation), so
  // the slot it reserved doesn't count against itself. Best-effort: only a real
  // detected overlap throws (the route turns it into { ok:false, error }).
  await assertAppointmentSlotAvailable({
    slug,
    date,
    segments: plan.segments.map((seg) => ({ staffId: seg.staffId, startsAt: seg.startsAt, endsAt: seg.endsAt, locationId, cabinId: seg.cabinId })),
    excludeHoldToken: token || null,
  });
  const appointments = await tenantTable(slug, "appointments");
  // Respect the requested status (normalized to the legacy code), default pending,
  // and generate a unique 5-digit booking code like the legacy ensure_unique_public_code.
  const normalizedStatus = appointmentPhpStatus(statusInput);
  const publicCode = await generateUniqueAppointmentPublicCode(slug);
  // Manual sconto from the quick-booking price panel (#qb_discount_type/#qb_discount_value),
  // normalized to the discount_type/discount_value columns (was hardcoded to 0 before).
  const discount = normalizeAppointmentDiscount(discountType, discountValue);
  // Block 4: fidelity points RESERVED (settled on done) + CREDIT spent, persisted on the row
  // so the lifecycle (awardAppointmentFidelityOnDone earn/redeem, cancelDone/restore refunds)
  // can settle/reverse them. Both clamped >= 0; fidelity points are whole.
  // Fidelity gate steps 1-2 (zeroed when redeem off; adhesion error otherwise).
  const fidelityGate = await fidelityPointsGateForSave(slug, Number(client.id ?? 0) || 0, Number(fidelityPointsUsed ?? 0));
  const fidelityPointsUse = fidelityGate.points;
  const creditUse = roundMoney(Math.max(0, Number(creditUsed ?? 0) || 0));
  // PROMOZIONE automatica (port of the legacy quick-booking promo flow): the best
  // eligible automatic promotion is re-evaluated SERVER-SIDE (the drawer preview
  // is never trusted) and its per-service prices land on the appointment_services
  // snapshot below. Legacy stacking guard: fidelity points cannot be combined
  // with a promo that is not stackable-with-fidelity (hard error, :12379); a
  // non-stackable coupon instead restricts its own base in the drawer preview.
  const promoCtx = await evalBestPromotionForAppointment({
    slug,
    serviceIds: plan.services.map((service) => Number(service.id ?? 0)),
    date,
    time: normalizedTime,
    clientId: Number(client.id ?? 0) || null,
    locationId,
  });
  if (promoCtx.applied && promoCtx.promotion && fidelityPointsUse > 0 && !promoCtx.promotion.stackable_with_fidelity) {
    throw new Error(
      promoCtx.promotion.title
        ? `Sconto punti Fidelity non cumulabile con la promozione "${promoCtx.promotion.title}".`
        : "Sconto punti Fidelity non cumulabile con la promozione attiva.",
    );
  }
  // Fidelity gate step 4 (balance/minimum) — AFTER the promo conflict, like the legacy.
  await assertFidelityPointsBalanceForSave(slug, Number(client.id ?? 0) || 0, fidelityGate);
  const promoByService = new Map(promoCtx.services.map((line) => [line.service_id, line]));
  // Block 4: embed the applied coupon into the general `notes` column (the appointments table
  // has no coupon columns), mirroring the legacy coupon_apply_meta_to_notes.
  const notesWithCoupon = couponApplyMetaToNotes(null, couponCode, couponDiscount);
  const appointmentValues: Record<string, unknown> = {
    client_id: client.id,
    service_id: plan.primaryService.id,
    cabin_id: plan.primaryCabinId,
    starts_at: start,
    ends_at: end,
    status: normalizedStatus,
    discount_type: discount.discount_type,
    discount_value: discount.discount_value,
    fidelity_points_used: fidelityPointsUse,
    credit_used: creditUse,
    promotion_id: promoCtx.applied && promoCtx.promotion ? promoCtx.promotion.id : null,
    notes: notesWithCoupon || null,
    location_id: locationId,
    staff_notes: staffNotes || null,
    customer_notes: customerNotes || null,
  };
  if (publicCode) appointmentValues.public_code = publicCode;
  const id = await tenantInsert(appointments, appointmentValues);

  // One appointment_services snapshot row per selected service (ordered), with
  // the promo pricing when this service is discounted (price/list_price/badge).
  for (const service of plan.services) {
    const promoLine = promoByService.get(Number(service.id ?? 0));
    await insertAppointmentService(slug, id, service, promoLine ? { price: promoLine.booked_price, listPrice: promoLine.list_price, badge: promoLine.discount_badge } : null);
  }
  // RECORD the promotion redemption (port of Promotions recordRedemption at
  // apply): one promotion_redemptions row linked to the appointment, removed by
  // the delete/cancel cleanup (deleteWhereAny promotion_redemptions).
  if (promoCtx.applied && promoCtx.promotion && promoCtx.discount > 0) {
    const redTable = await tenantTable(slug, "promotion_redemptions").catch(() => null);
    if (redTable) {
      await tenantInsert(redTable, {
        promotion_id: promoCtx.promotion.id,
        client_id: Number(client.id ?? 0) > 0 ? Number(client.id) : null,
        appointment_id: id,
        discount_amount: roundMoney(promoCtx.discount),
        location_id: locationId,
        redeemed_at: new Date(),
      }).catch(() => 0);
    }
  }
  // Distinct staff across all services (single operator + per-service staff).
  for (const staffId of plan.staffIds) await insertAppointmentStaff(slug, id, staffId);
  if (locationId) await insertAppointmentLocation(slug, id, locationId);
  // Sequential segments: position 0..n, each from cursor to cursor+duration.
  for (const [position, seg] of plan.segments.entries()) {
    await insertAppointmentSegment(slug, id, seg.service, seg.staffId, seg.startsAt, seg.endsAt, seg.durationMinutes, position, seg.cabinId);
  }
  // PACKAGE redeem: re-validate + consume + link AFTER the appointment_services
  // rows exist (the link/zero-charge targets those rows). Skipped entries become
  // warnings; the booking itself is never failed (legacy best-effort parity).
  // Services already covered by a package redeem MUST NOT also be prepaid-redeemed
  // (a service is covered once). We collect the package-covered service_ids and pass
  // them to the prepaid apply so it skips them (dedupe across the two redeem types).
  const packageCoveredServiceIds = new Set<number>();
  if (packageRedeems.length > 0) {
    const { applied, warnings } = await applyAppointmentPackageRedeems({
      slug,
      appointmentId: id,
      clientId: client.id,
      serviceIds: plan.services.map((service) => Number(service.id ?? 0)),
      redeems: packageRedeems,
    });
    for (const entry of applied) packageCoveredServiceIds.add(Number(entry.serviceId ?? 0));
    if (packageWarnings) packageWarnings.push(...warnings);
  }
  // PREPAID-SERVICE redeem: re-validate + consume + link AFTER the
  // appointment_services rows exist, and AFTER the package redeems so a service the
  // package already covered is skipped (dedupe via packageCoveredServiceIds). Skipped
  // entries become warnings; the booking itself is never failed (legacy parity).
  // A service covered by a package OR prepaid must not also be giftbox-redeemed. We
  // collect the prepaid-covered service_ids alongside the package ones into a single
  // `redeemCoveredServiceIds` set passed to the giftbox apply (dedupe across all three).
  const redeemCoveredServiceIds = new Set<number>(packageCoveredServiceIds);
  if (prepaidRedeems.length > 0) {
    const { applied, warnings } = await applyAppointmentPrepaidRedeems({
      slug,
      appointmentId: id,
      clientId: client.id,
      serviceIds: plan.services.map((service) => Number(service.id ?? 0)),
      redeems: prepaidRedeems,
      coveredServiceIds: packageCoveredServiceIds,
    });
    for (const entry of applied) redeemCoveredServiceIds.add(Number(entry.serviceId ?? 0));
    if (prepaidWarnings) prepaidWarnings.push(...warnings);
  }
  // GIFTBOX redeem: re-validate + RECORD (giftbox_redemptions + _items, qty 1) + link
  // AFTER the appointment_services rows exist, and AFTER package + prepaid so a service
  // already covered is skipped (dedupe via redeemCoveredServiceIds). GiftBox is
  // per-service + ITEM-based (one item covers one service); a covered service is
  // zero-charged. Skipped entries become warnings; the booking is never failed.
  if (giftboxRedeems.length > 0) {
    const { applied, warnings } = await applyAppointmentGiftboxRedeems({
      slug,
      appointmentId: id,
      clientId: client.id,
      serviceIds: plan.services.map((service) => Number(service.id ?? 0)),
      redeems: giftboxRedeems,
      coveredServiceIds: redeemCoveredServiceIds,
    });
    for (const entry of applied) redeemCoveredServiceIds.add(Number(entry.serviceId ?? 0));
    if (giftboxWarnings) giftboxWarnings.push(...warnings);
  }
  // GIFT (omaggio) redeem: re-validate + RECORD (appointment_gift_items, redeemed_at set,
  // qty 1) + link AFTER the appointment_services rows exist, and AFTER package + prepaid +
  // giftbox so a service already covered is skipped (dedupe via redeemCoveredServiceIds). A
  // gift instance holds reward items; a service reward applied to a service zero-charges it.
  // Skipped entries become warnings; the booking is never failed (legacy best-effort parity).
  if (giftRedeems.length > 0) {
    const { warnings } = await applyAppointmentGiftRedeems({
      slug,
      appointmentId: id,
      clientId: client.id,
      serviceIds: plan.services.map((service) => Number(service.id ?? 0)),
      redeems: giftRedeems,
      coveredServiceIds: redeemCoveredServiceIds,
    });
    if (giftWarnings) giftWarnings.push(...warnings);
  }
  // GIFTCARD redeem: re-validate + decrement + link AFTER the appointment_services
  // rows (and any package/prepaid zeroing) exist, because the payable total is
  // computed server-side from those rows (so a service zero-charged by a package/
  // prepaid never counts toward the giftcard cap). Appointment-level + monetary:
  // ONE giftcard per appointment (first valid), capped at min(balance, payableTotal).
  // Invalid -> warning, never fails the booking (legacy best-effort parity).
  if (giftcardRedeems.length > 0) {
    const { warnings } = await applyAppointmentGiftcardRedeem({
      slug,
      appointmentId: id,
      clientId: client.id,
      redeems: giftcardRedeems,
    });
    if (giftcardWarnings) giftcardWarnings.push(...warnings);
  }
  // CREDIT debit (Block 4): when the drawer applied customer credit (credit_used>0), DEBIT the
  // client wallet at booking (mirroring the giftcard decrement) so the balance drops immediately.
  // A cancel (pending->canceled via restoreAppointmentRedeems) or cancel-done (cancelDoneAppointment)
  // re-credits it. Best-effort: a credit debit failure never fails the booking; on failure we zero
  // the persisted credit_used so a later restore can't refund credit that was never debited.
  if (creditUse > 0 && Number(client.id ?? 0) > 0) {
    try {
      await addDbWalletMovement(
        {
          clientId: Number(client.id),
          type: "debit",
          amount: -creditUse,
          source_type: "appointment",
          source_id: id,
          note: `Utilizzo credito prenotazione #${id}`,
        },
        slug,
      );
    } catch {
      await tenantUpdate({ slug, table: "appointments", id, values: { credit_used: 0 } }).catch(() => 0);
    }
  }
  if (token) await markDbAppointmentHoldConverted(slug, token, "manage", id);

  const rows = await tenantSelect<RowDataPacket>({ slug, table: "appointments", where: "id = ?", params: [id], limit: 1 });
  return mapAppointment(slug, rows[0]);
}

// Update an EXISTING appointment (by id, tenant-scoped). Mirrors
// createDbAppointment's resolution logic — client, service, operator/staff,
// date/time (+ recomputed end), location and notes — but replaces the snapshot
// child rows (appointment_services / appointment_staff / appointment_locations /
// appointment_segments) rather than appending. Guards that the appointment
// belongs to the tenant before writing; throws "Appuntamento non trovato." when
// it does not. Hold handling is unchanged from create: when a hold token is
// supplied it is validated against the new slot and marked converted.
export async function updateDbAppointment({
  slug,
  id,
  clientId,
  clientName,
  serviceName,
  operator,
  time,
  date,
  locationId,
  holdToken,
  staffNotes,
  customerNotes,
  serviceNames = [],
  cabinId = null,
  staffMap = {},
  cabinMap = {},
  discountType,
  discountValue,
  fidelityPointsUsed,
  creditUsed,
  couponCode,
  couponDiscount,
}: {
  slug: string;
  id: number;
  clientId?: number | null;
  clientName: string;
  serviceName: string;
  operator: string;
  time: string;
  date: string;
  locationId: number | null;
  holdToken?: string | null;
  staffNotes?: string | null;
  customerNotes?: string | null;
  discountType?: string;
  discountValue?: string;
  // Block 4: mirrors createDbAppointment. Persisted so the price panel round-trips on edit and
  // the lifecycle can settle/reverse. NOTE: updateDbAppointment does NOT re-debit the wallet
  // credit (the debit happened at create; re-saving must not double-charge) and does NOT
  // re-apply redeems (see the redeem-on-edit TODO) — it only persists the columns + coupon
  // notes so a re-open shows them. The drawer today only sends these on CREATE.
  fidelityPointsUsed?: number;
  creditUsed?: number;
  couponCode?: string;
  couponDiscount?: number;
} & MultiServiceAppointmentInput): Promise<AppointmentWithMeta> {
  // Tenant-scoped existence guard: the SELECT only returns rows for this tenant,
  // so a row from another tenant (or a missing id) yields no match. cabin_id is
  // the "keep the current cabin" candidate of the legacy cabin resolution;
  // client_id feeds the blocked-client same-client exception.
  const existingRows = await tenantSelect<RowDataPacket>({ slug, table: "appointments", columns: "id, cabin_id, client_id, status", where: "id = ?", params: [id], limit: 1 });
  if (!existingRows[0]) throw new Error("Appuntamento non trovato.");
  const currentCabinId = Number(existingRows[0].cabin_id ?? 0) || 0;
  const currentClientId = Number(existingRows[0].client_id ?? 0) || 0;
  // Legacy terminal-status save guard (api_appointments.php ~10222-10227): once an
  // appointment is canceled/no_show the WHOLE edit-save is refused — the row is in
  // a final state and only delete (canceled) remains possible from the drawer.
  const originalPhpStatus = appointmentPhpStatus(String(existingRows[0].status ?? ""));
  if (originalPhpStatus === "canceled" || originalPhpStatus === "no_show") {
    throw new Error("La prenotazione annullata non è più modificabile.");
  }
  // Legacy promo gate (appt_promotion_update_allowed_for_old_status): a re-save
  // re-applies the automatic promotion unless the appointment is already done.
  const promoUpdateAllowed = originalPhpStatus !== "done";
  // Old per-segment cabins by position ("mantieni la cabina del segmento" candidate).
  const currentSegmentRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointment_segments",
    columns: "position, cabin_id",
    where: "appointment_id = ?",
    params: [id],
    orderBy: "position ASC",
  }).catch(() => [] as RowDataPacket[]);
  const currentSegmentCabins: number[] = [];
  for (const row of currentSegmentRows) {
    currentSegmentCabins[Number(row.position ?? 0)] = Number(row.cabin_id ?? 0) || 0;
  }

  const client = await resolveClientForAppointment(slug, clientName, locationId, clientId);
  // Legacy blocked-client guard, edit variant: keeping the appointment's OWN
  // blocked client is allowed; re-assigning to a (different) blocked one is not.
  await assertClientNotBlockedForSave(slug, Number(client.id ?? 0), currentClientId);
  const staff = operator ? await resolveStaffForAppointment(slug, operator) : null;
  const operatorStaffId = staff ? Number(staff.id ?? 0) : null;
  const normalizedTime = normalizeTime(time);
  const start = `${date} ${normalizedTime}:00`;
  const plan = await planAppointmentServices({
    slug,
    serviceName,
    serviceNames,
    operatorStaffId,
    cabinId,
    staffMap,
    cabinMap,
    start,
  });
  const end = plan.end;
  const token = (holdToken ?? "").trim();
  if (token) {
    await assertDbAppointmentHold({
      slug,
      token,
      ownerKey: "manage",
      startsAt: start,
      serviceId: Number(plan.primaryService.id ?? 0),
      staffId: operatorStaffId,
      locationId,
    });
  }
  // Double-booking guard: refuse to move/edit onto a slot where an operator is
  // Legacy staff-service guard (same as create): each segment's operator must be
  // enabled for its service.
  await assertStaffAllowedForServices(slug, plan.segments);
  // Cabina (legacy resolve_cabin_id_for_range on edit): requested cabin, else
  // keep the current appointment/segment cabin when still free, else auto-pick.
  await resolvePlanCabins({
    slug,
    plan,
    requestedCabinId: cabinId,
    cabinMap,
    locationId,
    excludeAppointmentId: id,
    excludeHoldToken: token || null,
    currentCabinId,
    currentSegmentCabins,
  });
  // already busy. Exclude THIS appointment (so it doesn't conflict with its own
  // existing row/staff) and its own active hold. Best-effort: only a real detected
  // overlap throws (the route turns it into { ok:false, error }).
  await assertAppointmentSlotAvailable({
    slug,
    date,
    segments: plan.segments.map((seg) => ({ staffId: seg.staffId, startsAt: seg.startsAt, endsAt: seg.endsAt, locationId, cabinId: seg.cabinId })),
    excludeAppointmentId: id,
    excludeHoldToken: token || null,
  });

  // Manual sconto from the quick-booking price panel (#qb_discount_type/#qb_discount_value),
  // normalized to the discount_type/discount_value columns (mirrors createDbAppointment).
  const discount = normalizeAppointmentDiscount(discountType, discountValue);
  // PROMOZIONE automatica su edit (mirrors createDbAppointment), gated on the
  // legacy old-status rule: a done appointment keeps its frozen promo pricing.
  const promoCtx = promoUpdateAllowed
    ? await evalBestPromotionForAppointment({
        slug,
        serviceIds: plan.services.map((service) => Number(service.id ?? 0)),
        date,
        time: normalizedTime,
        clientId: Number(client.id ?? 0) || null,
        locationId,
      })
    : { applied: false, promotion: null, services: [], discount: 0, reason: "" } satisfies AppointmentPromoContext;
  // Fidelity gate (same legacy chain as create): steps 1-2 here, the promo
  // conflict on the RAW request, then the balance assert after the guard.
  const fidelityGate = fidelityPointsUsed !== undefined
    ? await fidelityPointsGateForSave(slug, Number(client.id ?? 0) || 0, Number(fidelityPointsUsed) || 0)
    : { points: 0, settings: null } satisfies FidelitySaveGate;
  if (promoCtx.applied && promoCtx.promotion && fidelityGate.points > 0 && !promoCtx.promotion.stackable_with_fidelity) {
    throw new Error(
      promoCtx.promotion.title
        ? `Sconto punti Fidelity non cumulabile con la promozione "${promoCtx.promotion.title}".`
        : "Sconto punti Fidelity non cumulabile con la promozione attiva.",
    );
  }
  await assertFidelityPointsBalanceForSave(slug, Number(client.id ?? 0) || 0, fidelityGate);
  const promoByService = new Map(promoCtx.services.map((line) => [line.service_id, line]));
  const updateValues: Record<string, unknown> = {
    client_id: client.id,
    service_id: plan.primaryService.id,
    cabin_id: plan.primaryCabinId,
    starts_at: start,
    ends_at: end,
    location_id: locationId,
    staff_notes: staffNotes || null,
    customer_notes: customerNotes || null,
    discount_type: discount.discount_type,
    discount_value: discount.discount_value,
  };
  if (promoUpdateAllowed) {
    updateValues.promotion_id = promoCtx.applied && promoCtx.promotion ? promoCtx.promotion.id : null;
  }
  // Block 4: persist the price-panel deductions ONLY when the caller sent them (the drawer
  // sends them on CREATE; a plain edit/move leaves them undefined and must not clobber the
  // existing reservation). fidelity/credit are persisted as-is (NO wallet re-debit here — the
  // create-time debit stands; re-saving must not double-charge). Coupon is re-embedded into
  // `notes` (preserving any non-coupon note text), matching coupon_apply_meta_to_notes.
  if (fidelityPointsUsed !== undefined) {
    updateValues.fidelity_points_used = fidelityGate.points;
  }
  if (creditUsed !== undefined) {
    updateValues.credit_used = roundMoney(Math.max(0, Number(creditUsed) || 0));
  }
  if (couponCode !== undefined || couponDiscount !== undefined) {
    const currentRows = await tenantSelect<RowDataPacket>({ slug, table: "appointments", columns: "notes", where: "id = ?", params: [id], limit: 1 }).catch(() => [] as RowDataPacket[]);
    const currentNotes = currentRows[0] ? String(currentRows[0].notes ?? "") : "";
    const merged = couponApplyMetaToNotes(currentNotes, couponCode, couponDiscount);
    updateValues.notes = merged || null;
  }
  await tenantUpdate({
    slug,
    table: "appointments",
    id,
    values: updateValues,
  });

  // Replace the snapshot child rows so the edit reflects the new
  // service/staff/location/segment rather than stacking on the originals.
  await deleteAppointmentChildren(slug, "appointment_services", id);
  await deleteAppointmentChildren(slug, "appointment_staff", id);
  await deleteAppointmentChildren(slug, "appointment_locations", id);
  await deleteAppointmentChildren(slug, "appointment_segments", id);

  // One appointment_services snapshot row per selected service (ordered), with
  // the re-evaluated promo pricing (price/list_price/badge) when applicable.
  for (const service of plan.services) {
    const promoLine = promoUpdateAllowed ? promoByService.get(Number(service.id ?? 0)) : undefined;
    await insertAppointmentService(slug, id, service, promoLine ? { price: promoLine.booked_price, listPrice: promoLine.list_price, badge: promoLine.discount_badge } : null);
  }
  // Refresh the promotion redemption record: the edit re-evaluated the promo, so
  // the old appointment-linked row is replaced (or removed when no longer applied).
  if (promoUpdateAllowed) {
    const redTable = await tenantTable(slug, "promotion_redemptions").catch(() => null);
    if (redTable) {
      await dbExecute(`DELETE FROM ${quoteIdentifier(redTable.name)} WHERE tenant_id = ? AND appointment_id = ?`, [redTable.tenantId ?? 0, id]).catch(() => undefined);
      if (promoCtx.applied && promoCtx.promotion && promoCtx.discount > 0) {
        await tenantInsert(redTable, {
          promotion_id: promoCtx.promotion.id,
          client_id: Number(client.id ?? 0) > 0 ? Number(client.id) : null,
          appointment_id: id,
          discount_amount: roundMoney(promoCtx.discount),
          location_id: locationId,
          redeemed_at: new Date(),
        }).catch(() => 0);
      }
    }
  }
  // Distinct staff across all services (single operator + per-service staff).
  for (const staffId of plan.staffIds) await insertAppointmentStaff(slug, id, staffId);
  if (locationId) await insertAppointmentLocation(slug, id, locationId);
  // Sequential segments: position 0..n, each from cursor to cursor+duration.
  for (const [position, seg] of plan.segments.entries()) {
    await insertAppointmentSegment(slug, id, seg.service, seg.staffId, seg.startsAt, seg.endsAt, seg.durationMinutes, position, seg.cabinId);
  }
  // PACKAGE redeem is intentionally NOT applied on edit: this update DELETES and
  // re-inserts appointment_services on every save, so re-applying a redeem here
  // would consume the package session AGAIN on each edit (over-consumption). The
  // quick-booking drawer only ever CREATES appointments (it never sends
  // package_redeem with an edit id), so `packageRedeems` is accepted for signature
  // parity but ignored here. TODO(edit redeem): port the legacy
  // reserve-on-save/consume-on-done + redeemed_at idempotency before consuming on
  // edit, so re-saves don't double-decrement.
  if (token) await markDbAppointmentHoldConverted(slug, token, "manage", id);

  const rows = await tenantSelect<RowDataPacket>({ slug, table: "appointments", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Appuntamento non trovato.");
  return mapAppointment(slug, rows[0]);
}

// Snapshot of the customer-visible fields used to decide whether the legacy
// 'modified' email should fire. The PHP signature is far richer, but the Next
// edit path only touches date/time/services, so the route compares this compact
// shape before/after the update (appointment_customer_change_signature subset).
export type AppointmentCustomerVisibleSnapshot = {
  date: string;
  time: string;
  serviceNames: string[];
};

// Build the customer-visible snapshot (date/time + the appointment's service
// names) for an appointment, tenant-scoped. Returns null when the appointment
// does not belong to the tenant / does not exist, so the route can skip the
// 'modified' comparison entirely. Service names come from the appointment_services
// snapshot table, sorted so ordering never produces a false-positive change.
export async function getDbAppointmentCustomerVisibleSnapshot(slug: string, id: number): Promise<AppointmentCustomerVisibleSnapshot | null> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "appointments", columns: "starts_at", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) return null;
  const startsAt = toDate(rows[0].starts_at);
  let serviceNames: string[] = [];
  try {
    const serviceRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointment_services",
      columns: "service_name",
      where: "appointment_id = ?",
      params: [id],
      orderBy: "service_name ASC, id ASC",
    });
    serviceNames = serviceRows.map((row) => String(row.service_name ?? "").trim()).filter(Boolean).sort();
  } catch {
    // Older installs without the snapshot table: fall back to an empty list so
    // the comparison still works (only date/time changes will trigger the email).
  }
  return { date: dateIsoLocal(startsAt), time: timeLocal(startsAt), serviceNames };
}

// Move-snapshot: the fields a calendar drag/move needs to PRESERVE while only the
// slot (date/time/staff/location) changes. The calendar move action does not touch
// client/service/notes, so it re-feeds these existing values to updateDbAppointment
// (which keeps notes and recomputes the end from the service duration). Returns null
// when the appointment is not the tenant's / does not exist, plus the current PHP
// status so the route can mirror the legacy guard (only pending/scheduled movable).
export type AppointmentMoveSnapshot = {
  clientName: string;
  serviceName: string;
  operator: string;
  locationId: number | null;
  staffNotes: string | null;
  customerNotes: string | null;
  phpStatus: string;
};

export async function getDbAppointmentMoveSnapshot(slug: string, id: number): Promise<AppointmentMoveSnapshot | null> {
  // Tenant-scoped read: only returns the row when it belongs to this tenant.
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointments",
    columns: "id, client_id, service_id, location_id, status, staff_notes, customer_notes",
    where: "id = ?",
    params: [id],
    limit: 1,
  });
  const row = rows[0];
  if (!row) return null;

  const clientName = await appointmentClientName(slug, Number(row.client_id ?? 0));
  const service = await appointmentService(slug, row);
  const operator = await appointmentStaffName(slug, Number(row.id ?? 0));

  return {
    clientName,
    serviceName: service.name,
    operator,
    locationId: row.location_id === null || row.location_id === undefined ? null : Number(row.location_id),
    staffNotes: row.staff_notes === null || row.staff_notes === undefined ? null : String(row.staff_notes),
    customerNotes: row.customer_notes === null || row.customer_notes === undefined ? null : String(row.customer_notes),
    phpStatus: phpStatus(String(row.status ?? "")),
  };
}

// RESIZE (duration change): persist a CUSTOM appointment duration by writing the
// dragged end time DIRECTLY, WITHOUT recomputing from the service duration (unlike
// updateDbAppointment, which always derives ends_at from the service plan). The
// calendar's bottom-edge resize handle sends the new end HH:MM (snapped to the grid
// step); we keep the appointment's start fixed and only move its end forward/back.
//
// What is written:
//   - appointments.ends_at -> the new end (same calendar day as starts_at).
//   - the LAST appointment_segments row's ends_at + duration_minutes -> so the
//     persisted segment chain ends at the same custom time (single-service: that is
//     the only segment; multi-service: only the trailing segment is stretched, the
//     earlier sequential segments keep their service durations).
//
// Guards (mirroring the move action): tenant-scoped existence, pending/scheduled
// only, end strictly after start. The operator-overlap conflict check is REUSED
// (assertAppointmentSlotAvailable) against the appointment's own staffed segments
// with the trailing segment extended to the new end, excluding THIS appointment.
// Returns null when the appointment is not the tenant's / does not exist or is not
// resizable; throws (caught by the route) on a real overlap.
// Number of appointment_segments rows for an appointment (tenant-scoped). >1 means a
// multi-service (segmented) booking, which the legacy forbids operator-changing via drag or
// resizing from the calendar (calendar.js:4961 / :5016). Best-effort: a missing table -> 0.
export async function getDbAppointmentSegmentCount(slug: string, id: number): Promise<number> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointment_segments",
    columns: "id",
    where: "appointment_id = ?",
    params: [id],
  }).catch(() => [] as RowDataPacket[]);
  return rows.length;
}

// Swap two ADJACENT segments of a multi-servizio booking (port of the legacy
// action=swap_segment, api_appointments.php:9386). Semantics:
//  * only pending/scheduled bookings are editable;
//  * the two segments exchange POSITION and TIME WINDOWS — the earlier slot is
//    taken by whichever segment moves first, keeping the whole appointment
//    window unchanged (base = min(start), sequential by duration);
//  * each moved segment's staff is re-validated on its NEW range: time-off and
//    double-booking throw the exact legacy messages;
//  * each moved segment's cabin is re-resolved (keep current -> appointment's
//    -> auto-pick, via resolveCabinIdForRange);
//  * appointments.starts_at/ends_at are re-aligned to MIN/MAX of the segments.
export async function swapDbAppointmentSegment(slug: string, appointmentId: number, segmentId: number, direction: "up" | "down"): Promise<void> {
  const apptRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointments",
    columns: "id, starts_at, status, cabin_id, location_id",
    where: "id = ?",
    params: [appointmentId],
    limit: 1,
  });
  const appt = apptRows[0];
  if (!appt) throw new Error("Prenotazione non trovata");
  const curStatus = appointmentPhpStatus(String(appt.status ?? ""));
  if (curStatus !== "pending" && curStatus !== "scheduled") {
    throw new Error("Impossibile cambiare l'ordine: la prenotazione non è modificabile.");
  }
  const locationId = Number(appt.location_id ?? 0) || null;

  const segs = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointment_segments",
    where: "appointment_id = ?",
    params: [appointmentId],
    orderBy: "position ASC, starts_at ASC, id ASC",
  });
  if (segs.length === 0) throw new Error("Questa prenotazione non è multi-servizio.");
  if (segs.length < 2) throw new Error("Multi-servizio non valido");

  const idx = segs.findIndex((seg) => Number(seg.id ?? 0) === segmentId);
  if (idx < 0) throw new Error("Segmento non trovato");
  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= segs.length) throw new Error("Spostamento non disponibile");

  const segCur = segs[idx];
  const segSwap = segs[swapIdx];
  const tsCur = toDate(segCur.starts_at).getTime();
  const teCur = toDate(segCur.ends_at).getTime();
  const tsSwap = toDate(segSwap.starts_at).getTime();
  const teSwap = toDate(segSwap.ends_at).getTime();
  if (!Number.isFinite(tsCur) || !Number.isFinite(tsSwap)) throw new Error("Orari non validi");

  // Durations from the stored windows, falling back to duration_minutes (>=10'),
  // then to the legacy 10' floor.
  const durCurMs = teCur > tsCur ? teCur - tsCur : Math.max(10, Number(segCur.duration_minutes ?? 0) || 0) * 60000;
  const durSwapMs = teSwap > tsSwap ? teSwap - tsSwap : Math.max(10, Number(segSwap.duration_minutes ?? 0) || 0) * 60000;

  const baseMs = Math.min(tsCur, tsSwap);
  const firstSeg = direction === "up" ? segCur : segSwap;
  const secondSeg = direction === "up" ? segSwap : segCur;
  const durFirstMs = direction === "up" ? durCurMs : durSwapMs;
  const durSecondMs = direction === "up" ? durSwapMs : durCurMs;

  const fmtSql = (ms: number) => {
    const d = new Date(ms);
    return `${dateIsoLocal(d)} ${timeLocal(d)}:00`;
  };
  const firstStart = fmtSql(baseMs);
  const firstEnd = fmtSql(baseMs + durFirstMs);
  const secondStart = firstEnd;
  const secondEnd = fmtSql(baseMs + durFirstMs + durSecondMs);

  const checks = [
    { seg: firstSeg, starts: firstStart, ends: firstEnd },
    { seg: secondSeg, starts: secondStart, ends: secondEnd },
  ];

  // Staff guards on the NEW ranges: HARD time-off, then double-booking (both with
  // the exact legacy messages, naming the operator).
  const date = firstStart.slice(0, 10);
  const busy = await busyRangesForDate(slug, date, { excludeAppointmentId: appointmentId }).catch(() => []);
  for (const check of checks) {
    const staffId = Number(check.seg.staff_id ?? 0) || 0;
    if (staffId <= 0) continue;
    const startMin = minutesOfDayFromSqlDate(check.starts);
    const endMin = minutesOfDayFromSqlDate(check.ends);
    const staffName = async () => {
      const rows = await tenantSelect<RowDataPacket>({ slug, table: "staff", columns: "full_name", where: "id = ?", params: [staffId], limit: 1 }).catch(() => [] as RowDataPacket[]);
      return String(rows[0]?.full_name ?? "").trim() || "Operatore";
    };
    const reason = await staffTimeoffReasonForRange(slug, staffId, date, startMin, endMin);
    if (reason) {
      throw new Error(`Impossibile cambiare ordine: ${await staffName()} risulta non disponibile (${reason}) nel periodo selezionato.`);
    }
    const conflict = busy.some((range) =>
      (range.staffIds.length === 0 || range.staffIds.includes(staffId))
      && (range.locationId === null || locationId === null || range.locationId === locationId)
      && range.end > startMin && range.start < endMin,
    );
    if (conflict) {
      throw new Error(`Impossibile cambiare ordine: ${await staffName()} ha già un altro appuntamento in quell'orario.`);
    }
  }

  // Cabin re-resolution per moved segment (keep current -> appointment's -> auto),
  // exactly like the legacy candidate chain. Skipped for cabin-less tenants by
  // resolveCabinIdForRange's caller gate — here we mirror the legacy inline gate.
  const anyCabins = await tenantSelect<RowDataPacket>({ slug, table: "cabins", columns: "id", limit: 1 }).catch(() => [] as RowDataPacket[]);
  const cabinUpdates = new Map<number, number>();
  if (anyCabins.length > 0) {
    const apptCabin = Number(appt.cabin_id ?? 0) || 0;
    for (const check of checks) {
      const segId = Number(check.seg.id ?? 0);
      const serviceId = Number(check.seg.service_id ?? 0);
      if (segId <= 0 || serviceId <= 0) continue;
      const currentCabin = Number(check.seg.cabin_id ?? 0) || 0;
      const candidates: number[] = [];
      if (currentCabin > 0) candidates.push(currentCabin);
      if (apptCabin > 0 && !candidates.includes(apptCabin)) candidates.push(apptCabin);
      candidates.push(0);
      let lastError: unknown = null;
      for (const candidate of candidates) {
        try {
          cabinUpdates.set(segId, await resolveCabinIdForRange({ slug, requestedCabinId: candidate, serviceIds: [serviceId], startsAt: check.starts, endsAt: check.ends, locationId, excludeAppointmentId: appointmentId }));
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
    }
  }

  // Apply: new time windows, swapped positions, re-resolved cabins, then the
  // appointment window re-aligned to MIN/MAX of its segments.
  const segTable = await tenantTable(slug, "appointment_segments");
  const segName = quoteIdentifier(segTable.name);
  const tenantId = segTable.tenantId ?? 0;
  await dbExecute(`UPDATE ${segName} SET starts_at = ?, ends_at = ? WHERE tenant_id = ? AND id = ? AND appointment_id = ?`, [firstStart, firstEnd, tenantId, Number(firstSeg.id), appointmentId]);
  await dbExecute(`UPDATE ${segName} SET starts_at = ?, ends_at = ? WHERE tenant_id = ? AND id = ? AND appointment_id = ?`, [secondStart, secondEnd, tenantId, Number(secondSeg.id), appointmentId]);
  const posCur = Number(segCur.position ?? idx);
  const posSwap = Number(segSwap.position ?? swapIdx);
  await dbExecute(`UPDATE ${segName} SET position = ? WHERE tenant_id = ? AND id = ? AND appointment_id = ?`, [posSwap, tenantId, Number(segCur.id), appointmentId]);
  await dbExecute(`UPDATE ${segName} SET position = ? WHERE tenant_id = ? AND id = ? AND appointment_id = ?`, [posCur, tenantId, Number(segSwap.id), appointmentId]);
  for (const [segId, cabId] of cabinUpdates) {
    await dbExecute(`UPDATE ${segName} SET cabin_id = ? WHERE tenant_id = ? AND id = ? AND appointment_id = ?`, [cabId > 0 ? cabId : null, tenantId, segId, appointmentId]).catch(() => undefined);
  }
  const apptTable = await tenantTable(slug, "appointments");
  const apptName = quoteIdentifier(apptTable.name);
  await dbExecute(
    `UPDATE ${apptName} SET starts_at = (SELECT MIN(starts_at) FROM ${segName} WHERE tenant_id = ? AND appointment_id = ?), ends_at = (SELECT MAX(ends_at) FROM ${segName} WHERE tenant_id = ? AND appointment_id = ?) WHERE tenant_id = ? AND id = ?`,
    [tenantId, appointmentId, tenantId, appointmentId, tenantId, appointmentId],
  );
}

export async function resizeDbAppointmentEnd(slug: string, id: number, newEndTime: string): Promise<AppointmentWithMeta | null> {
  // Tenant-scoped read: only returns the row when it belongs to this tenant.
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointments",
    columns: "id, starts_at, status, location_id, cabin_id",
    where: "id = ?",
    params: [id],
    limit: 1,
  });
  const row = rows[0];
  if (!row) return null;

  // Legacy guard: only pending/scheduled appointments are editable from the calendar.
  const status = phpStatus(String(row.status ?? ""));
  if (status !== "pending" && status !== "scheduled") {
    throw new Error("La prenotazione non e modificabile da calendario.");
  }

  // Resolve the start (kept fixed) and build the new end on the SAME calendar day.
  const start = toDate(row.starts_at);
  const startDateIso = dateIsoLocal(start);
  const endHHMM = normalizeTime(newEndTime);
  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = (() => {
    const m = /^(\d{2}):(\d{2})$/.exec(endHHMM);
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  })();
  if (!Number.isFinite(endMin) || endMin <= startMin) {
    throw new Error("La fine deve essere successiva all'inizio.");
  }
  const endSql = `${startDateIso} ${endHHMM}:00`;
  const locationId = row.location_id === null || row.location_id === undefined ? null : Number(row.location_id);
  // Appointment-level cabin (single-service bookings keep the cabin on appointments,
  // not necessarily on the segment row) — used as the trailing segment's cabin
  // fallback so the resize cabin check still applies.
  const appointmentCabinId = row.cabin_id === null || row.cabin_id === undefined ? 0 : Number(row.cabin_id) || 0;

  // Read the appointment's segments (ordered) so we can (a) re-run the overlap
  // check with the trailing segment stretched and (b) know which segment row to
  // update. Best-effort: an install without the segment table degrades to checking
  // only the appointment-level span (a single staffless range, which never blocks).
  let segments: RowDataPacket[] = [];
  try {
    segments = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointment_segments",
      columns: "id, staff_id, cabin_id, starts_at, ends_at, position",
      where: "appointment_id = ?",
      params: [id],
      orderBy: "position ASC, id ASC",
    });
  } catch {
    segments = [];
  }

  // Conflict check: re-use assertAppointmentSlotAvailable against this appointment's
  // own staffed segments, with the LAST segment extended to the new end (the only
  // one whose window grows). Earlier segments are unchanged. Excludes THIS appointment.
  const checkSegments: AppointmentSlotSegment[] = segments.length
    ? segments.map((seg, idx) => {
        const segCabin = seg.cabin_id === null || seg.cabin_id === undefined ? 0 : Number(seg.cabin_id) || 0;
        return {
          staffId: seg.staff_id === null || seg.staff_id === undefined ? null : Number(seg.staff_id),
          // Only the trailing (extended) segment can newly collide with a cabin; for
          // it, fall back to the appointment-level cabin when the segment has none.
          cabinId: segCabin > 0 ? segCabin : (idx === segments.length - 1 ? appointmentCabinId : 0) || null,
          startsAt: sqlDateTimePrefix(seg.starts_at),
          endsAt: idx === segments.length - 1 ? `${startDateIso} ${endHHMM}` : sqlDateTimePrefix(seg.ends_at),
          locationId,
        };
      })
    : [{ staffId: null, cabinId: appointmentCabinId || null, startsAt: `${startDateIso} ${normalizeTime(timeLocal(start))}`, endsAt: `${startDateIso} ${endHHMM}`, locationId }];
  await assertAppointmentSlotAvailable({
    slug,
    date: startDateIso,
    segments: checkSegments,
    excludeAppointmentId: id,
  });

  // Persist: appointment end first, then the trailing segment's end + duration. The
  // segment update is best-effort (older installs without the table just skip it).
  await tenantUpdate({ slug, table: "appointments", id, values: { ends_at: endSql } });
  if (segments.length) {
    const lastSegment = segments[segments.length - 1];
    const lastSegmentId = Number(lastSegment.id ?? 0);
    if (lastSegmentId > 0) {
      // Recompute the trailing segment's own duration from its (unchanged) start to
      // the new end, so duration_minutes stays consistent with its window.
      const segStart = toDate(lastSegment.starts_at);
      const segStartMin = segStart.getHours() * 60 + segStart.getMinutes();
      const segDuration = Math.max(1, endMin - segStartMin);
      await tenantUpdate({
        slug,
        table: "appointment_segments",
        id: lastSegmentId,
        values: { ends_at: endSql, duration_minutes: segDuration },
      });
    }
  }

  const updated = await tenantSelect<RowDataPacket>({ slug, table: "appointments", where: "id = ?", params: [id], limit: 1 });
  if (!updated[0]) return null;
  return mapAppointment(slug, updated[0]);
}

// EDIT payload for the global quick-booking drawer (port of api_appointments.php
// action='get', ~8594). Returns everything the drawer needs to PREFILL an existing
// appointment in EDIT MODE: the selected client (id + name/email/phone), the
// location, the ordered service list, the per-service operator + cabin maps (read
// from appointment_segments, the only place the per-service staff/cabin assignment
// is persisted), the explicit primary cabin, the date/time, the (php-normalized)
// status and the notes — plus the booking code (public_code) for the header.
// Tenant-scoped: returns null when the appointment is not the tenant's / missing.
//
// TODO(redeem-on-edit): the legacy `get` ALSO returns the applied redeems
// (package/prepaid/giftbox/gift/giftcard) so the drawer can re-show + re-apply them.
// This port intentionally OMITS them because updateDbAppointment does NOT re-apply
// or restore redeems on edit (it re-inserts the appointment_services snapshot from
// scratch without the linkage), so surfacing them would be misleading. The redeem
// badges remain visible read-only via the client-context panel; the per-service
// redeem controls simply start empty in edit mode.
export type AppointmentEditPayload = {
  id: number;
  publicCode: string | null;
  clientId: number;
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  locationId: number | null;
  // Item D: `price` is the BOOKED per-service price (appointment_services.price snapshot), so the
  // drawer's price panel restores each existing line at the price it was booked at instead of the
  // current catalog price. Optional (older single-service rows without a snapshot omit it).
  services: Array<{ serviceId: number; name: string; price?: number }>;
  staffMap: Record<number, number>;
  cabinMap: Record<number, number>;
  primaryCabinId: number | null;
  date: string;
  time: string;
  status: string;
  staffNotes: string;
  customerNotes: string;
  // Persisted manual sconto (discount_type/discount_value columns) so the drawer's price
  // panel prefills it on edit (round-trips with createDbAppointment/updateDbAppointment).
  discountType: string;
  discountValue: number;
  // Block 4: the persisted price-panel deductions, so the drawer prefills them on edit.
  // fidelityPointsUsed = appointments.fidelity_points_used (points reserved); creditUsed =
  // appointments.credit_used; coupon = { code, discount } extracted from notes (or null).
  fidelityPointsUsed: number;
  creditUsed: number;
  coupon: { code: string; discount: number } | null;
  // Port of api_appointments.php `get` -> a.expired_link_warning (rendered in the
  // drawer's #qbExpiredLinkedAlert). Non-empty when the edited appointment references
  // a redeem source (package/prepaid/giftbox/gift/giftcard) that is now EXPIRED — a
  // heads-up so the operator knows a linked residual can't be re-applied. "" when none.
  expiredLinkWarning: string;
  // Cancellation metadata for the drawer's locked-mode alert (#qbCancellationAlert):
  // cancelled_at ("YYYY-MM-DD HH:MM:SS", local) + cancelled_reason (with the legacy
  // notes fallback: a "[ANNULLATA ...] reason" line when the column is empty on a
  // canceled row). "" when absent — the alert only renders on canceled/no_show.
  cancelledAt: string;
  cancelledReason: string;
};

// Compute the expired-linked warning for an appointment being edited (Item 3, port of
// the legacy a.expired_link_warning filled by qbSetExpiredLinkedAlert). Walks the
// appointment's redeem links — appointment_services.{client_package_id,
// client_prepaid_service_id, giftbox_instance_id, gift_instance_id} + the
// appointment-level appointments.giftcard_id — and, for any that reference a source
// row that is now EXPIRED (expires_at in the past, or a 'expired'/'scaduto' status),
// builds a short "Attenzione: ..." warning. Best-effort per source (a missing table /
// column / row just skips that check); returns "" when nothing is expired.
async function computeExpiredLinkWarning(slug: string, appointmentId: number, giftcardId: number): Promise<string> {
  const today = todayIso();
  // True when a source row is expired: an explicit expired/scaduto status, OR an
  // expires_at/valid_to date strictly before today (date-only compare, like the redeem
  // eligibility checks). NULL/empty expiry = no expiry (never expired by date).
  const isExpired = (statusRaw: unknown, expiryRaw: unknown): boolean => {
    const status = String(statusRaw ?? "").trim().toLowerCase();
    if (status === "expired" || status === "scaduto" || status === "scaduta") return true;
    const expiry = expiryRaw ? String(expiryRaw).slice(0, 10) : "";
    return expiry !== "" && expiry < today;
  };
  const expired: string[] = [];

  // Per-service redeem links from appointment_services (best-effort; a missing table or
  // the redeem columns absent on older installs just yields no per-service warnings).
  let serviceRows: RowDataPacket[] = [];
  try {
    serviceRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointment_services",
      where: "appointment_id = ?",
      params: [appointmentId],
    });
  } catch {
    serviceRows = [];
  }

  // Collect the distinct source ids per redeem type (dedup so one expired package tied
  // to several services warns once).
  const packageIds = new Set<number>();
  const prepaidIds = new Set<number>();
  const giftboxIds = new Set<number>();
  const giftIds = new Set<number>();
  for (const row of serviceRows) {
    const pkg = Number(row.client_package_id ?? 0);
    if (pkg > 0) packageIds.add(pkg);
    const prepaid = Number(row.client_prepaid_service_id ?? 0);
    if (prepaid > 0) prepaidIds.add(prepaid);
    const giftbox = Number(row.giftbox_instance_id ?? 0);
    if (giftbox > 0) giftboxIds.add(giftbox);
    const gift = Number(row.gift_instance_id ?? 0);
    if (gift > 0) giftIds.add(gift);
  }

  // Helper: read one source row (id) and push a label when it is expired. `col` names the
  // expiry column (expires_at for the residual pools, expires_at for giftbox/gift too).
  const checkSource = async (table: string, ids: Set<number>, expiryCol: string, label: string) => {
    for (const id of ids) {
      try {
        const rows = await tenantSelect<RowDataPacket>({
          slug,
          table,
          columns: `id, status, ${expiryCol}`,
          where: "id = ?",
          params: [id],
          limit: 1,
        });
        if (rows[0] && isExpired(rows[0].status, rows[0][expiryCol])) expired.push(label);
      } catch {
        // tolerate a missing table/column (older installs) — skip this source.
      }
    }
  };

  await checkSource("client_packages", packageIds, "expires_at", "un pacchetto");
  await checkSource("client_prepaid_services", prepaidIds, "expires_at", "un prepagato");
  await checkSource("giftbox_instances", giftboxIds, "expires_at", "una GiftBox");
  await checkSource("gift_instances", giftIds, "expires_at", "un omaggio");

  // Appointment-level giftcard (appointments.giftcard_id).
  if (giftcardId > 0) {
    try {
      const rows = await tenantSelect<RowDataPacket>({
        slug,
        table: "giftcards",
        columns: "id, status, expires_at",
        where: "id = ?",
        params: [giftcardId],
        limit: 1,
      });
      if (rows[0] && isExpired(rows[0].status, rows[0].expires_at)) expired.push("una GiftCard");
    } catch {
      // tolerate a missing table/column.
    }
  }

  if (expired.length === 0) return "";
  // Dedup labels while preserving order (e.g. two expired packages -> "un pacchetto" once).
  const distinct = Array.from(new Set(expired));
  return `Attenzione: questa prenotazione è collegata a ${distinct.join(", ")} ormai scaduta/o. Il residuo collegato non può più essere applicato.`;
}

export async function getDbAppointmentForEdit(slug: string, id: number): Promise<AppointmentEditPayload | null> {
  // Tenant-scoped read of the appointments row (tenantSelect '*' so public_code /
  // staff_notes / customer_notes / cabin_id are available when the columns exist).
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "appointments", where: "id = ?", params: [id], limit: 1 });
  const row = rows[0];
  if (!row) return null;

  // Client (id + name/email/phone) — mirrors the legacy JOIN clients c ON c.id=a.client_id.
  const clientId = Number(row.client_id ?? 0);
  let clientName = "";
  let clientEmail = "";
  let clientPhone = "";
  if (clientId > 0) {
    try {
      const clientRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "clients",
        columns: "full_name, email, phone",
        where: "id = ?",
        params: [clientId],
        limit: 1,
      });
      if (clientRows[0]) {
        clientName = String(clientRows[0].full_name ?? "").trim();
        clientEmail = String(clientRows[0].email ?? "").trim();
        clientPhone = String(clientRows[0].phone ?? "").trim();
      }
    } catch {
      // tolerate a missing column; the drawer still selects the client by id+name.
    }
  }

  // Ordered service list (one per appointment_services row; falls back to the single
  // services-table lookup for legacy single-service rows without snapshot rows).
  const serviceLines = await appointmentServiceLines(slug, row);
  const services = serviceLines
    .filter((line) => line.serviceId > 0)
    // Item D: carry the BOOKED price snapshot so the drawer restores it (see the type note).
    .map((line) => ({ serviceId: line.serviceId, name: line.name, price: roundMoney(Number(line.price ?? 0)) }));

  // Per-service operator + cabin maps from appointment_segments (the only place the
  // per-service staff/cabin assignment is persisted; rebuilt on every save). Keyed by
  // service_id -> staff_id / cabin_id; only positive values are emitted (0 = unassigned).
  const staffMap: Record<number, number> = {};
  const cabinMap: Record<number, number> = {};
  try {
    const segRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointment_segments",
      columns: "service_id, staff_id, cabin_id",
      where: "appointment_id = ?",
      params: [id],
      orderBy: "position ASC, starts_at ASC",
    });
    for (const seg of segRows) {
      const serviceId = Number(seg.service_id ?? 0);
      if (serviceId <= 0) continue;
      const staffId = Number(seg.staff_id ?? 0);
      if (staffId > 0 && staffMap[serviceId] === undefined) staffMap[serviceId] = staffId;
      const cabinId = seg.cabin_id === null || seg.cabin_id === undefined ? 0 : Number(seg.cabin_id) || 0;
      if (cabinId > 0 && cabinMap[serviceId] === undefined) cabinMap[serviceId] = cabinId;
    }
  } catch {
    // older installs without appointment_segments: fall back to the single operator
    // (appointment_staff) so at least the whole-appointment operator can prefill.
  }
  // Single-service / no-segment fallback: pin the whole-appointment operator to the
  // (one) service so the single operator select prefills even without segment rows.
  if (Object.keys(staffMap).length === 0 && services.length > 0) {
    try {
      const staffRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "appointment_staff",
        columns: "staff_id",
        where: "appointment_id = ?",
        params: [id],
        limit: 1,
      });
      const staffId = Number(staffRows[0]?.staff_id ?? 0);
      if (staffId > 0) staffMap[services[0].serviceId] = staffId;
    } catch {
      // tolerate a missing table.
    }
  }

  const startsAt = toDate(row.starts_at);
  const primaryCabinId = row.cabin_id === null || row.cabin_id === undefined || Number(row.cabin_id) <= 0 ? null : Number(row.cabin_id);

  // Item 3: the expired-linked warning (checks the redeem sources this appointment links).
  const expiredLinkWarning = await computeExpiredLinkWarning(slug, Number(row.id ?? id), Number(row.giftcard_id ?? 0) || 0);

  // Cancellation metadata (api_appointments.php `get` ~8683-8694): the cancelled_at/
  // cancelled_reason columns, plus the legacy fallback that extracts the reason from a
  // "[ANNULLATA ...] reason" notes line when a canceled row has no explicit reason.
  const rowPhpStatus = phpStatus(String(row.status ?? ""));
  let cancelledReason = String(row.cancelled_reason ?? "").trim();
  if (rowPhpStatus === "canceled" && cancelledReason === "" && row.notes) {
    const reasonMatch = /^\s*\[ANNULLATA[^\]]*\]\s*(.+)$/im.exec(String(row.notes));
    if (reasonMatch) cancelledReason = String(reasonMatch[1] ?? "").trim();
  }
  const cancelledAtDate = row.cancelled_at ? toDate(row.cancelled_at) : null;
  const cancelledAt =
    cancelledAtDate && !Number.isNaN(cancelledAtDate.getTime())
      ? `${dateIsoLocal(cancelledAtDate)} ${timeLocal(cancelledAtDate)}:00`
      : "";

  return {
    id: Number(row.id ?? id),
    publicCode:
      row.public_code === null || row.public_code === undefined || String(row.public_code).trim() === ""
        ? null
        : String(row.public_code).trim(),
    clientId,
    clientName,
    clientEmail,
    clientPhone,
    locationId: row.location_id === null || row.location_id === undefined ? null : Number(row.location_id) || null,
    services,
    staffMap,
    cabinMap,
    primaryCabinId,
    date: dateIsoLocal(startsAt),
    time: timeLocal(startsAt),
    // php-normalized status code (scheduled/pending/done/canceled/no_show) — the
    // drawer's status select uses exactly these codes.
    status: phpStatus(String(row.status ?? "")),
    staffNotes: row.staff_notes === null || row.staff_notes === undefined ? "" : String(row.staff_notes),
    customerNotes: row.customer_notes === null || row.customer_notes === undefined ? "" : String(row.customer_notes),
    // Manual sconto: "" (none) | "percent" | "fixed" + its value (0 when no discount).
    discountType: String(row.discount_type ?? "") === "percent" || String(row.discount_type ?? "") === "fixed" ? String(row.discount_type) : "",
    discountValue: roundMoney(Number(row.discount_value ?? 0)),
    // Block 4 deductions: the reserved fidelity points + spent credit + the coupon (read back
    // from the notes markers via extract_coupon_meta_from_notes) for the price-panel prefill.
    fidelityPointsUsed: Math.max(0, Math.round(Number(row.fidelity_points_used ?? 0) || 0)),
    creditUsed: roundMoney(Math.max(0, parseMoney(row.credit_used, 0))),
    coupon: (() => {
      const meta = extractCouponMetaFromNotes(row.notes);
      return meta.code && meta.discount > 0 ? meta : null;
    })(),
    expiredLinkWarning,
    cancelledAt,
    cancelledReason,
  };
}

// True when any customer-visible field differs between the before/after
// snapshots — i.e. the date, the time, or the set of service names changed.
// Mirrors automation_handle_customer_visible_change's "$after !== $before" gate,
// restricted to the fields the Next edit path can touch.
export function appointmentCustomerVisibleChanged(
  before: AppointmentCustomerVisibleSnapshot,
  after: AppointmentCustomerVisibleSnapshot,
): boolean {
  if (before.date !== after.date) return true;
  if (before.time !== after.time) return true;
  if (before.serviceNames.length !== after.serviceNames.length) return true;
  return before.serviceNames.some((name, index) => name !== after.serviceNames[index]);
}

// Delete every child row for an appointment (by appointment_id, tenant-scoped),
// used by updateDbAppointment to replace the service/staff/location/segment
// snapshots. Errors are swallowed for compatibility with older installs that may
// not have a given child table (matching the insertAppointment* helpers).
async function deleteAppointmentChildren(slug: string, baseTable: string, appointmentId: number): Promise<void> {
  try {
    const target = await tenantTable(slug, baseTable);
    const clauses = ["appointment_id = ?"];
    const params: unknown[] = [appointmentId];
    if (target.mode === "shared" && await columnExists(target.name, "tenant_id")) {
      clauses.push("tenant_id = ?");
      params.push(target.tenantId ?? 0);
    }
    await dbExecute(`DELETE FROM ${quoteIdentifier(target.name)} WHERE ${clauses.join(" AND ")}`, params);
  } catch {
    // compatibility: table may not exist in older installs.
  }
}

export async function updateDbAppointmentStatus(slug: string, id: number, status: AppointmentStatus | string): Promise<AppointmentWithMeta> {
  await tenantUpdate({ slug, table: "appointments", id, values: { status: phpStatus(status) } });
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "appointments", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Appuntamento non trovato.");
  return mapAppointment(slug, rows[0]);
}

// Returns the appointment's current PHP-normalized status code ('pending',
// 'scheduled', 'canceled', 'done', 'no_show', ...) or null when not found. Used
// by the manage route to detect the status transition that triggers the
// approved/rejected lifecycle email, before updateDbAppointmentStatus writes the
// new status.
export async function getDbAppointmentPhpStatus(slug: string, id: number): Promise<string | null> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "appointments", columns: "status", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) return null;
  return phpStatus(String(rows[0].status ?? ""));
}

// Restore EVERY redeem an appointment consumed at save time (PACKAGE + PREPAID +
// GIFTBOX + GIFT sessions per appointment_services row, plus the appointment-level
// GIFTCARD refund). Extracted from deleteDbAppointment so it can be reused by the
// status path: this app consumes redeems at CREATE time, so an appointment that is
// CANCELED (or marked no_show) — not just deleted — must give those redeems back or
// they leak. Tenant-scoped, idempotent/best-effort (each helper re-reads the live
// row and only re-activates when this redemption had closed it, and the per-pool
// updates are guarded), so a double call would re-add sessions; the caller must
// therefore only invoke it on the FIRST transition into a canceled/no_show state.
// It does NOT delete any rows — the appointment + its child snapshot rows survive
// (legacy keeps canceled appointments); only deleteDbAppointment removes them after.
export async function restoreAppointmentRedeems(slug: string, appointmentId: number): Promise<void> {
  const id = Number(appointmentId);
  if (!Number.isFinite(id) || id <= 0) return;

  // Appointment-level giftcard linkage (refund amount + which card) + the Block 4
  // credit/fidelity reservations (credit debited at create, fidelity points reserved).
  const existing = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointments",
    columns: "id, client_id, giftcard_id, giftcard_used, credit_used, fidelity_points_used",
    where: "id = ?",
    params: [id],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  if (!existing[0]) return;

  // Read the appointment_services linkage snapshot, the same columns the apply
  // helpers set. Best-effort: a missing table -> no per-service restores.
  let serviceRows: RowDataPacket[] = [];
  try {
    serviceRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointment_services",
      where: "appointment_id = ?",
      params: [id],
    });
  } catch {
    serviceRows = [];
  }

  // Restore PACKAGE + PREPAID + GIFTBOX + GIFT redeems per appointment_services row.
  // After each restore the linkage column is CLEARED so the helper is IDEMPOTENT:
  // the cancel-on-status path restores first, and a later delete of that cancelled
  // appointment re-runs this helper — without the clear, package/prepaid pools would
  // be credited TWICE (blind +1 in the restore helpers).
  for (const row of serviceRows) {
    // appointment_services has NO id column (PK = tenant_id + appointment_id +
    // service_id) — the clear below targets the row by that composite key.
    const rowServiceId = Number(row.service_id ?? 0);
    const clearCols: Record<string, unknown> = {};
    // PACKAGE: give the session back (package pool + the per-service pool when linked).
    const clientPackageId = Number(row.client_package_id ?? 0);
    if (clientPackageId > 0) {
      await restoreClientPackageSession(slug, clientPackageId, Number(row.client_package_service_id ?? 0) || null);
      clearCols.client_package_id = null;
      clearCols.client_package_service_id = null;
    }
    // PREPAID: give the unit back.
    const clientPrepaidServiceId = Number(row.client_prepaid_service_id ?? 0);
    if (clientPrepaidServiceId > 0) {
      await restoreClientPrepaidUnit(slug, clientPrepaidServiceId);
      clearCols.client_prepaid_service_id = null;
    }
    // GIFTBOX: remove this appointment's redemption rows + reactivate the instance
    // (already self-clearing — keyed on this appointment's redemption rows — but the
    // linkage is dropped too for consistency).
    const giftboxInstanceId = Number(row.giftbox_instance_id ?? 0);
    if (giftboxInstanceId > 0) {
      await restoreGiftboxRedemption(slug, giftboxInstanceId, id);
      clearCols.giftbox_instance_id = null;
    }
    // GIFT: il rollback vero (transazioni 'cancel'/'unlink' + DELETE righe +
    // riapertura istanza) avviene UNA volta a livello appuntamento dopo questo
    // loop (giftRollbackAppointmentSelection, port di Gifts::rollback...);
    // qui si azzera solo il link sulla riga servizio.
    const giftInstanceId = Number(row.gift_instance_id ?? 0);
    if (giftInstanceId > 0) {
      clearCols.gift_instance_id = null;
    }
    if (rowServiceId > 0 && Object.keys(clearCols).length > 0) {
      const asTable = await tenantTable(slug, "appointment_services");
      const sets = Object.keys(clearCols).map((col) => `${quoteIdentifier(col)} = NULL`).join(", ");
      await dbExecute(
        `UPDATE ${quoteIdentifier(asTable.name)} SET ${sets} WHERE tenant_id = ? AND appointment_id = ? AND service_id = ?`,
        [asTable.tenantId ?? 0, id, rowServiceId],
      ).catch(() => undefined);
    }
  }

  // GIFT (omaggio) rollback a livello appuntamento (Gifts::rollbackAppointmentSelection):
  // transazioni 'cancel' (riscattate o rollback da annullo) / 'unlink' (in sospeso),
  // DELETE appointment_gift_items, riapertura a 'disponibile' delle istanze chiuse da
  // QUESTO appuntamento + ricalcolo forceRecheck. Idempotente: senza righe è un no-op.
  await giftRollbackAppointmentSelection(slug, id, null, { cancelHistory: true }).catch(() => undefined);

  // Restore the appointment-level GIFTCARD redeem (refund the used amount), then ZERO
  // giftcard_used so a re-run cannot double-refund (cancel -> delete runs this twice).
  // cancelDoneAppointment captures the figures BEFORE calling this helper (same pattern
  // as the credit/fidelity notes below), so zeroing here loses nothing.
  const giftcardId = Number(existing[0].giftcard_id ?? 0);
  const giftcardUsed = roundMoney(Math.max(0, parseMoney(existing[0].giftcard_used, 0)));
  if (giftcardId > 0 && giftcardUsed > 0) {
    await restoreGiftcardBalance(slug, giftcardId, giftcardUsed);
    await tenantUpdate({ slug, table: "appointments", id, values: { giftcard_used: 0 } }).catch(() => 0);
  }

  // Block 4 CREDIT restore: the drawer DEBITED the client wallet at create (credit_used>0),
  // so a cancel/no_show (pending/scheduled -> canceled, this path) or the cancel-done flow
  // must re-credit it. Re-credit the wallet then ZERO credit_used so a re-run can't double
  // refund. This is the single source of truth for the credit refund — cancelDoneAppointment
  // calls this helper first (step 2), so its own step 4 no longer re-refunds credit.
  const clientId = Math.max(0, Number(existing[0].client_id ?? 0) || 0);
  const creditUsed = roundMoney(Math.max(0, parseMoney(existing[0].credit_used, 0)));
  if (creditUsed > 0 && clientId > 0) {
    await addDbWalletMovement(
      { clientId, type: "recharge", amount: creditUsed, source_type: "appointment", source_id: id, note: `Storno credito prenotazione #${id}` },
      slug,
    ).catch(() => undefined);
    await tenantUpdate({ slug, table: "appointments", id, values: { credit_used: 0 } }).catch(() => 0);
  }

  // Block 4 FIDELITY reservation drop: for a pending/scheduled cancel the points were only
  // RESERVED (fidelity_points_used>0) — never redeemed from the wallet (the redeem settles on
  // done via awardAppointmentFidelityOnDone). So there is nothing to refund to the wallet; we
  // just ZERO the reservation so the canceled booking holds none. When this runs as step 2 of
  // cancelDoneAppointment (a DONE booking whose redeem WAS settled), the redeem refund is done
  // by that flow's step 3 (points_earn +pointsUsed) using the value it captured BEFORE calling
  // this helper, so zeroing here does not lose it. Best-effort.
  const fidelityPointsUsed = Math.max(0, Math.round(Number(existing[0].fidelity_points_used ?? 0) || 0));
  if (fidelityPointsUsed > 0) {
    await tenantUpdate({ slug, table: "appointments", id, values: { fidelity_points_used: 0 } }).catch(() => 0);
  }
}

// ===================== CANCEL-DONE PREVIEW (COMPUTE-ONLY) =====================
// Shape of the preview payload the drawer's cancel-done modal renders, mirroring the
// legacy appt_lifecycle_load_cancel_done_preview return (a compute-only projection of
// what cancelDoneAppointment WILL restore/reverse). `error` is set (and summary/points
// stay empty) when the transition is not applicable; `blockers` gate the Confirm button.
export type CancelDonePreview = {
  ok: boolean;
  error: string;
  status: string;
  targetStatus: "canceled" | "no_show";
  // 'executed' = the booking was DONE (settled redeems + awarded points get reversed);
  // 'reserved' = pending/scheduled (holds only get UNLOCKED, no accounting reversal).
  cancelMode: "executed" | "reserved";
  summary: string[];
  warnings: string[];
  blockers: string[];
  // `locked` = the reserved (not yet debited) points on a pending/scheduled booking.
  points: { used: number; locked: number; earned: number };
  restores: { credit: number; giftcard: number };
};

// Italian integer/point formatting (number_format($n, 0, ',', '.')): dot thousands,
// no decimals — matches the legacy summary lines ("Verranno stornati 1.234 punti...").
function formatPointsIt(value: number): string {
  return Math.round(value).toLocaleString("it-IT", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// Italian money formatting (number_format($n, 2, ',', '.')): dot thousands, comma
// decimals, always 2 fraction digits — matches "€ 1.234,50".
function formatMoneyIt(value: number): string {
  return value.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// COMPUTE-ONLY preview for the cancel flow (port of
// appt_lifecycle_load_cancel_done_preview, ~576-720). Reads the appointment's settled
// fidelity/credit/giftcard figures and projects — WITHOUT mutating anything — what the
// APPLY (cancelDoneAppointment) will restore/reverse, plus the faithful Italian summary
// lines + the un-accrued-points warning. TWO modes, like the legacy: 'executed' for a
// DONE booking (settled amounts reversed) and 'reserved' for pending/scheduled (holds
// only unlocked — "Verranno sbloccati ..."). Any other status returns { ok:false, error }
// (already canceled/no_show/not applicable) so the modal shows the message and disables
// Confirm.
export async function cancelDonePreview(
  slug: string,
  appointmentId: number,
  targetStatus: AppointmentStatus | string = "canceled",
): Promise<CancelDonePreview> {
  const target = phpStatus(targetStatus) === "no_show" ? "no_show" : "canceled";
  const preview: CancelDonePreview = {
    ok: false,
    error: "",
    status: "",
    targetStatus: target,
    cancelMode: "reserved",
    summary: [],
    warnings: [],
    blockers: [],
    points: { used: 0, locked: 0, earned: 0 },
    restores: { credit: 0, giftcard: 0 },
  };

  const id = Number.parseInt(String(appointmentId), 10);
  if (!Number.isFinite(id) || id <= 0) {
    preview.error = "Prenotazione non valida.";
    return preview;
  }

  // Load the appointment fidelity/credit/giftcard fields (tenant-scoped). Mirrors the
  // SAME reads cancelDoneAppointment uses, plus giftcard_used for the recharge line.
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointments",
    columns: "id, status, fidelity_points_earned, fidelity_points_used, credit_used, giftcard_used",
    where: "id = ?",
    params: [id],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  const appointment = rows[0];
  if (!appointment) {
    preview.error = "Prenotazione non trovata.";
    return preview;
  }

  const status = phpStatus(String(appointment.status ?? ""));
  preview.status = status;

  // Mode by status (AppointmentLifecycle.php ~615-630): DONE -> 'executed';
  // pending/scheduled -> 'reserved'; anything else is not applicable (terminal or
  // unknown) — error with the exact legacy strings + early return (compute-only:
  // no summary computed for a non-applicable transition).
  if (status === "done") {
    preview.cancelMode = "executed";
  } else if (status === "pending" || status === "scheduled") {
    preview.cancelMode = "reserved";
  } else {
    if (status === "canceled") {
      preview.error = "La prenotazione risulta già annullata.";
    } else if (status === "no_show") {
      preview.error = "La prenotazione risulta già marcata No show.";
    } else {
      preview.error =
        target === "no_show"
          ? "Solo le prenotazioni in attesa, prenotate o eseguite possono essere marcate No show da questa schermata."
          : "Solo le prenotazioni in attesa, prenotate o eseguite possono essere annullate da questa schermata.";
    }
    return preview;
  }
  const executed = preview.cancelMode === "executed";

  // The amounts the APPLY will restore/reverse (mirrors cancelDoneAppointment's reads):
  //  - fidelity_points_used  : on 'executed' a real redeem was debited -> RESTORED; on
  //                            'reserved' the points are only LOCKED -> just unlocked.
  //  - fidelity_points_earned: REVERSED (storno) — only awarded on done ('executed').
  //  - credit_used           : RESTORED — re-credited to the client wallet.
  //  - giftcard_used         : RECHARGED — refunded to the giftcard balance.
  const pointsLocked = Math.max(0, Math.round(Number(appointment.fidelity_points_used ?? 0) || 0));
  const pointsUsed = executed ? pointsLocked : 0;
  const pointsEarned = executed ? Math.max(0, Math.round(Number(appointment.fidelity_points_earned ?? 0) || 0)) : 0;
  const creditUsed = roundMoney(Math.max(0, parseMoney(appointment.credit_used, 0)));
  const giftcardUsed = roundMoney(Math.max(0, parseMoney(appointment.giftcard_used, 0)));

  preview.points = { used: pointsUsed, locked: pointsLocked, earned: pointsEarned };
  preview.restores = { credit: creditUsed, giftcard: giftcardUsed };

  // Faithful Italian summary lines (AppointmentLifecycle.php ~695-705) built from the
  // amounts, branched on the mode. Guarded on the same >0.00001 epsilon so a zero
  // figure adds no line.
  if (executed) {
    if (pointsUsed > 0.00001) {
      preview.summary.push(`Verranno ripristinati ${formatPointsIt(pointsUsed)} punti Fidelity usati.`);
    }
    if (pointsEarned > 0.00001) {
      preview.summary.push(`Verranno stornati ${formatPointsIt(pointsEarned)} punti Fidelity guadagnati.`);
    }
    if (creditUsed > 0.00001) {
      preview.summary.push(`Verrà ripristinato credito cliente per € ${formatMoneyIt(creditUsed)}`);
    }
    if (giftcardUsed > 0.00001) {
      preview.summary.push(`Verrà ricaricata la GiftCard usata per € ${formatMoneyIt(giftcardUsed)}`);
    }
    // The un-accrued-points warning (legacy ~704, reserved branch) is also shown on the
    // executed branch in the JS modal build; keep it when there were earned points, since
    // the storno reverses points that "would have" stayed accrued.
    if (pointsEarned > 0.00001) {
      preview.warnings.push("I punti Fidelity che sarebbero stati maturati con questa prenotazione non verranno accreditati.");
    }
  } else {
    // RESERVED branch (legacy ~700-705): pending/scheduled holds are only UNLOCKED.
    if (pointsLocked > 0.00001) {
      preview.summary.push(`Verranno sbloccati ${formatPointsIt(pointsLocked)} punti Fidelity usati.`);
    }
    if (creditUsed > 0.00001) {
      preview.summary.push(`Verrà sbloccato credito cliente usato per € ${formatMoneyIt(creditUsed)}`);
    }
    if (giftcardUsed > 0.00001) {
      preview.summary.push(`Verrà sbloccato il saldo GiftCard usato per € ${formatMoneyIt(giftcardUsed)}`);
    }
  }

  // TODO (deep per-resource blockers, legacy ~707-865): the fidelity loyalty-card guard
  // (fidelity_loyalty_guard_source_card), the points-shortage/points_storno_mode gate
  // (would-be-negative disponibile), and the giftbox-fully-redeemed-elsewhere /
  // giftcard-already-spent blockers are NOT computed here yet. cancelDoneAppointment
  // applies the core restores best-effort regardless, so no blocker is emitted; when those
  // deep checks are ported, push their messages into preview.blockers (which disables the
  // modal's Confirm) and, for points_storno_mode, surface the radio choice.

  preview.ok = true;
  return preview;
}

// CANCEL an appointment via the dedicated flow (the popup). Tenant-scoped port of
// app/lib/AppointmentLifecycle.php appt_lifecycle_cancel_done_apply (~867). In the
// legacy EVERY drawer cancel goes through this apply, in one of two modes:
//   - 'executed' (done): settling consumed redeems AND awarded fidelity points — a
//     bare status flip would leak both, so everything is RESTORED/REVERSED first.
//   - 'reserved' (pending/scheduled): the holds were only reserved — they are
//     UNLOCKED (columns zeroed, redeems given back) without accounting reversals.
// Both stamp cancelled_at/cancelled_by/cancelled_reason (default reason when empty),
// then flip the status. Best-effort PER PIECE (a single restore failing must not abort
// the others or the status flip), but the status change itself always happens.
//
// Restore order (mirrors the legacy apply + the POS-void reverse model):
//   1) VALIDATE the appointment is pending/scheduled/done (idempotency: a terminal
//      canceled/no_show row can't be cancelled again — no double-restore).
//   2) restoreAppointmentRedeems — package/prepaid/giftbox/gift sessions + the
//      appointment-level GIFTCARD refund (reused, same as delete/cancel-on-status).
//   3) FIDELITY reverse (the POS-void pattern, manage-pos.ts ~1896-1924):
//        - reverse the EARNED points: a points_redeem of -fidelity_points_earned
//          (source_type='appointment') + zero appointments.fidelity_points_earned.
//        - refund the USED/redeemed points: a points_earn of +fidelity_points_used
//          (source_type='appointment') + zero appointments.fidelity_points_used.
//          (fidelity_points_used is currently always 0 — the drawer fidelity row is
//          inert/Block 4 — so this branch is dormant but ported faithfully.)
//   4) CREDIT restore: if credit_used>0, re-credit the wallet (+credit_used) + zero
//      appointments.credit_used. (Also dormant: the drawer credit row is inert/Block 4.)
//   5) Set appointments.status = the php target (canceled|no_show) and return the
//      refreshed mapped appointment so the caller can refresh the calendar.
//
// Each zero-the-column step doubles as the idempotency guard for that piece (a re-run
// sees 0 and skips), but the status validation in step 1 is the real gate: after a
// successful cancel-done the row is no longer 'done', so a second call is rejected.
export async function cancelDoneAppointment(
  slug: string,
  appointmentId: number,
  targetStatus: AppointmentStatus | string,
  createdBy?: number,
  reason?: string,
): Promise<AppointmentWithMeta> {
  const id = Number.parseInt(String(appointmentId), 10);
  if (!Number.isFinite(id) || id <= 0) throw new Error("Appuntamento non trovato.");

  // The target must normalize to canceled or no_show — this flow only ANNULS a done
  // booking, it never moves it to another live state.
  const target = phpStatus(targetStatus);
  if (target !== "canceled" && target !== "no_show") {
    throw new Error("Stato di annullamento non valido.");
  }

  // Load the appointment fidelity/credit fields (tenant-scoped). No row -> not found.
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointments",
    columns: "id, client_id, status, fidelity_points_earned, fidelity_points_used, credit_used",
    where: "id = ?",
    params: [id],
    limit: 1,
  });
  const appointment = rows[0];
  if (!appointment) throw new Error("Appuntamento non trovato.");

  // IDEMPOTENCY / GUARD (AppointmentLifecycle.php ~921-931): pending/scheduled/done are
  // cancellable via this flow ('reserved' vs 'executed' mode); an already canceled/
  // no_show row is terminal (exact legacy strings). Rejecting a terminal row also
  // prevents a second cancel from double-restoring.
  const oldStatus = phpStatus(String(appointment.status ?? ""));
  if (oldStatus !== "pending" && oldStatus !== "scheduled" && oldStatus !== "done") {
    if (oldStatus === "canceled") throw new Error("La prenotazione risulta già annullata.");
    if (oldStatus === "no_show") throw new Error("La prenotazione risulta già marcata No show.");
    throw new Error(
      target === "no_show"
        ? "La prenotazione non può essere marcata No show da questa schermata."
        : "La prenotazione non è annullabile da questa schermata.",
    );
  }
  // 'executed' = the done settlement debited real points/credit -> reverse them below;
  // 'reserved' (pending/scheduled) = the holds are only unlocked (restoreAppointmentRedeems
  // zeroes the reservation columns), no accounting reversal (legacy ~649, ~972-975).
  const isExecutedCancel = oldStatus === "done";

  const clientId = Math.max(0, Number(appointment.client_id ?? 0) || 0);
  const pointsEarned = isExecutedCancel ? Math.max(0, Math.round(Number(appointment.fidelity_points_earned ?? 0) || 0)) : 0;
  const pointsUsed = isExecutedCancel ? Math.max(0, Math.round(Number(appointment.fidelity_points_used ?? 0) || 0)) : 0;
  const creditUsed = roundMoney(Math.max(0, parseMoney(appointment.credit_used, 0)));
  const by = createdBy && createdBy > 0 ? createdBy : undefined;

  // 2) Restore package/prepaid/giftbox/gift sessions + the appointment-level giftcard.
  await restoreAppointmentRedeems(slug, id).catch(() => undefined);

  // 3) FIDELITY reverse (mirrors the POS-void reverse). Wrapped so a fidelity error
  //    never blocks the credit restore or the status flip below.
  try {
    // REVERSE the EARNED points: a negative points_redeem removes the loyalty points
    // awarded when the appointment was completed, so a canceled booking leaves none.
    // IMPORTANT: the reversal movements DO NOT tag source_type/source_id — the settlement
    // rows (awardAppointmentFidelityOnDone) already occupy the unique key (tenant_id, client_id,
    // kind, source_type, source_id) = (..,'earn'|'redeem','appointment',id), so a same-kind
    // reversal tagged the same way would violate `transactions_uq_fid_src`. We mirror the POS
    // void (manage-pos.ts cancelLinkedSaleResidues), which leaves source_type/source_id NULL on
    // its reversal movements (NULLs are distinct in the unique index) — so the storno always
    // inserts. Idempotency here is the step-1 status guard (a canceled row can't be re-cancelled).
    if (pointsEarned > 0 && clientId > 0) {
      await addDbWalletMovement(
        {
          clientId,
          type: "points_redeem",
          points: -pointsEarned,
          createdBy: by,
          note: `Storno punti guadagnati prenotazione #${id}`,
        },
        slug,
      ).catch(() => undefined);
    }
    // Zero the stamp regardless (idempotency guard: a re-run can't double-reverse).
    if (pointsEarned > 0) {
      await tenantUpdate({ slug, table: "appointments", id, values: { fidelity_points_earned: 0 } }).catch(() => 0);
    }
    // REFUND the USED/redeemed points: a positive points_earn re-credits clients.points
    // (the inverse of the points_redeem SETTLED on done by awardAppointmentFidelityOnDone).
    // We use `pointsUsed` captured BEFORE restoreAppointmentRedeems (step 2) zeroed the
    // reservation column, so the refund is not lost. Block 4: fires when the done booking
    // actually redeemed points (fidelity_points_used>0). Untagged (see the note above) so it
    // does not collide with the settlement redeem row under the unique index.
    if (pointsUsed > 0 && clientId > 0) {
      await addDbWalletMovement(
        {
          clientId,
          type: "points_earn",
          points: pointsUsed,
          createdBy: by,
          note: `Storno punti usati prenotazione #${id}`,
        },
        slug,
      ).catch(() => undefined);
    }
    // fidelity_points_used is already zeroed by restoreAppointmentRedeems (step 2); no re-zero
    // needed here (a re-run is guarded by the status validation in step 1 anyway).
  } catch {
    // best-effort: fidelity reverse must never block the status flip.
  }

  // 4) CREDIT restore is now handled inside restoreAppointmentRedeems (step 2 above) — the
  //    single source of truth for the credit refund (re-credits the wallet + zeroes
  //    credit_used). We keep `creditUsed` captured above only for the log note below; no
  //    second refund happens here (that would double-credit).
  void creditUsed;

  // 5) Flip the status to the php target (canceled|no_show). The ROW is KEPT (legacy
  //    keeps canceled appointments). This is the one step that must always run.
  //    Alongside the status, persist the cancel metadata the legacy apply writes
  //    (AppointmentLifecycle.php ~1051-1058): cancelled_at (now), cancelled_by (the
  //    acting user) and cancelled_reason (the operator's motivation, max 255 chars). The
  //    appointments schema has all three columns, so this is the clean persistence spot
  //    for the reason — no notes fallback needed. Each is column-guarded so an older
  //    schema without the column simply skips it (the status flip still happens).
  const statusValues: Record<string, unknown> = { status: target };
  const nowSql = `${sqlDateTimePrefix(new Date())}:00`; // "YYYY-MM-DD HH:MM:SS"
  if (await columnExists("appointments", "cancelled_at")) statusValues.cancelled_at = nowSql;
  if (by !== undefined && (await columnExists("appointments", "cancelled_by"))) statusValues.cancelled_by = by;
  if (await columnExists("appointments", "cancelled_reason")) {
    // Legacy default reason (AppointmentLifecycle.php ~880): an empty motivation is
    // replaced by the backend-cancel default, never left NULL.
    const cleanReason = String(reason ?? "").trim().slice(0, 255);
    statusValues.cancelled_reason =
      cleanReason !== ""
        ? cleanReason
        : target === "no_show"
          ? "No show prenotazione da backend"
          : "Annullamento prenotazione da backend";
  }
  await tenantUpdate({ slug, table: "appointments", id, values: statusValues });
  const updated = await tenantSelect<RowDataPacket>({ slug, table: "appointments", where: "id = ?", params: [id], limit: 1 });
  if (!updated[0]) throw new Error("Appuntamento non trovato.");
  return mapAppointment(slug, updated[0]);
}

// DELETE an appointment (single-row "Elimina" + bulk_delete). Tenant-scoped port of
// app/pages/appointments.php (single delete ~79-130 + bulk_delete ~292-520) and the
// api_appointments.php delete rollback (~9665). This app CONSUMES redeems at SAVE
// time (see applyAppointment*Redeems), so deleting must RESTORE everything the
// appointment consumed before removing the row. The restore is driven off the
// appointment_services linkage snapshot (the same columns the apply helpers set):
//
//   - PACKAGE (client_package_id / client_package_service_id): +1 session back on
//     client_packages.sessions_remaining (re-activating a 'completed' package) and,
//     when a per-service row id is linked, +1 on its client_package_services row.
//   - PREPAID (client_prepaid_service_id): +1 remaining_qty on client_prepaid_services
//     (re-activating a 'completed' prepaid).
//   - GIFTBOX (giftbox_instance_id / giftbox_item_id): delete this appointment's
//     giftbox_redemptions rows (source_type='appointment', source_id=id) + their
//     giftbox_redemption_items, and reactivate the instance ('issued') if it had been
//     flipped to 'redeemed' by this redemption.
//   - GIFT (gift_instance_id / reward_item_index): the appointment_gift_items rows are
//     deleted (below), so reactivate the gift instance to 'disponibile' if 'riscattato'.
//   - GIFTCARD (appointments.giftcard_id / giftcard_used): refund giftcard_used to
//     giftcards.balance, re-activating a 'redeemed' card.
//
// Then the child snapshot rows (appointment_segments / _services / _staff / _locations
// and the appointment_gift_items redeem links) are removed, and finally the
// appointments row itself. Every step is best-effort per table (wrapped in try/catch,
// columnExists-guarded) so a missing column/table on an older install never aborts the
// delete — the row still goes away. Returns true when the appointment row was removed.
export async function deleteDbAppointment(slug: string, id: number): Promise<boolean> {
  const appointmentId = Number(id);
  if (!Number.isFinite(appointmentId) || appointmentId <= 0) return false;

  // 1) Tenant-scoped existence guard: only the tenant's own row is deletable. A row
  //    from another tenant (or a missing id) yields no match -> nothing to do.
  const existing = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointments",
    columns: "id, status, giftcard_id, giftcard_used",
    where: "id = ?",
    params: [appointmentId],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  if (!existing[0]) return false;

  // 1b) Legacy delete guard (api_appointments.php action=delete): only a CANCELLED
  //     appointment can be deleted — cancel first ("Annullala prima"). The cancel
  //     path has already restored the redeems by then (and restoreAppointmentRedeems
  //     below is idempotent, so the delete-time re-run is a no-op).
  const currentStatus = String(existing[0].status ?? "").trim().toLowerCase();
  if (currentStatus !== "canceled" && currentStatus !== "cancelled") {
    throw new Error("La prenotazione deve essere in stato Annullato. Annullala prima per poterla eliminare.");
  }

  // 2) Restore every redeem this appointment consumed (package/prepaid/giftbox/gift
  //    sessions + the appointment-level giftcard refund) BEFORE deleting any child
  //    rows, so the linkage snapshot the restore reads is still intact. Extracted
  //    into restoreAppointmentRedeems so the cancel-on-status path can reuse it.
  await restoreAppointmentRedeems(slug, appointmentId);

  // 3) Delete the child snapshot rows + redeem links (best-effort per table). The
  //    appointment_gift_items rows are the gift redeem links; deleting them (paired
  //    with the gift-instance reactivation above) fully rolls back the gift redeem.
  await deleteAppointmentChildren(slug, "appointment_segments", appointmentId);
  await deleteAppointmentChildren(slug, "appointment_services", appointmentId);
  await deleteAppointmentChildren(slug, "appointment_staff", appointmentId);
  await deleteAppointmentChildren(slug, "appointment_locations", appointmentId);
  await deleteAppointmentChildren(slug, "appointment_gift_items", appointmentId);

  // 4) Finally remove the appointment row itself (tenant-scoped).
  const removed = await tenantDelete({ slug, table: "appointments", id: appointmentId }).catch(() => 0);
  return removed > 0;
}

// Inverse of the PACKAGE redeem consume (applyAppointmentPackageRedeems step 5):
// +1 session on the package-level pool (re-activating a 'completed' package) and,
// when a per-service client_package_services row is linked, +1 on that pool too,
// keeping package.remaining == SUM(cps.remaining). Best-effort + columnExists-guarded.
async function restoreClientPackageSession(slug: string, clientPackageId: number, clientPackageServiceId: number | null): Promise<void> {
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "client_packages",
      columns: "id, sessions_remaining, status",
      where: "id = ?",
      params: [clientPackageId],
      limit: 1,
    });
    if (!rows[0]) return;
    const remaining = Math.max(0, Number(rows[0].sessions_remaining ?? 0)) + 1;
    const values: Record<string, unknown> = { sessions_remaining: remaining };
    // A package the redeem flipped to 'completed' becomes usable again.
    if (String(rows[0].status ?? "") === "completed") values.status = "active";
    await tenantUpdate({ slug, table: "client_packages", id: clientPackageId, values });
    // Write the inverse usage ledger entry (+1), mirroring the -1 the consume wrote.
    await tryInsertPackageUsage(slug, clientPackageId, 1, "Ripristino eliminazione appuntamento").catch(() => {});
  } catch {
    // best-effort: a missing column/table must not abort the delete.
  }
  if (clientPackageServiceId && clientPackageServiceId > 0) {
    try {
      const cps = await tenantSelect<RowDataPacket>({
        slug,
        table: "client_package_services",
        columns: "id, sessions_remaining",
        where: "id = ?",
        params: [clientPackageServiceId],
        limit: 1,
      });
      if (cps[0]) {
        await tenantUpdate({
          slug,
          table: "client_package_services",
          id: clientPackageServiceId,
          values: { sessions_remaining: Math.max(0, Number(cps[0].sessions_remaining ?? 0)) + 1 },
        });
      }
    } catch {
      // best-effort
    }
  }
}

// Inverse of the PREPAID redeem consume (applyAppointmentPrepaidRedeems step 5):
// +1 remaining_qty on the client_prepaid_services row (re-activating a 'completed'
// prepaid). Best-effort + columnExists-guarded.
async function restoreClientPrepaidUnit(slug: string, clientPrepaidServiceId: number): Promise<void> {
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "client_prepaid_services",
      columns: "id, remaining_qty, status",
      where: "id = ?",
      params: [clientPrepaidServiceId],
      limit: 1,
    });
    if (!rows[0]) return;
    const remaining = Math.max(0, Number(rows[0].remaining_qty ?? 0)) + 1;
    const values: Record<string, unknown> = { remaining_qty: remaining };
    if (String(rows[0].status ?? "") === "completed") values.status = "active";
    await tenantUpdate({ slug, table: "client_prepaid_services", id: clientPrepaidServiceId, values });
  } catch {
    // best-effort
  }
}

// Inverse of the GIFTBOX redeem record (applyAppointmentGiftboxRedeems steps 6-7):
// delete THIS appointment's giftbox_redemptions rows (source_type='appointment',
// source_id=appointmentId) and their giftbox_redemption_items child rows, then
// reactivate the instance ('issued') if this redemption had flipped it to 'redeemed'.
// Best-effort + columnExists/tableExists-guarded.
async function restoreGiftboxRedemption(slug: string, instanceId: number, appointmentId: number): Promise<void> {
  try {
    // Find this appointment's redemption headers for the instance.
    const redemptions = await tenantSelect<RowDataPacket>({
      slug,
      table: "giftbox_redemptions",
      columns: "id",
      where: "instance_id = ? AND source_type = 'appointment' AND source_id = ?",
      params: [instanceId, appointmentId],
    });
    for (const redemption of redemptions) {
      const redemptionId = Number(redemption.id ?? 0);
      if (redemptionId <= 0) continue;
      // Delete the redemption-item rows first (tenant-scoped raw delete).
      try {
        const itemsTable = await tenantTable(slug, "giftbox_redemption_items");
        const clauses = ["redemption_id = ?"];
        const params: unknown[] = [redemptionId];
        if (itemsTable.mode === "shared" && (await columnExists(itemsTable.name, "tenant_id"))) {
          clauses.push("tenant_id = ?");
          params.push(itemsTable.tenantId ?? 0);
        }
        await dbExecute(`DELETE FROM ${quoteIdentifier(itemsTable.name)} WHERE ${clauses.join(" AND ")}`, params);
      } catch {
        // best-effort
      }
      await tenantDelete({ slug, table: "giftbox_redemptions", id: redemptionId }).catch(() => 0);
    }
  } catch {
    // best-effort: redemption tables may be absent on older installs.
  }
  // Reactivate the instance if THIS appointment's redemption had auto-closed it.
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "giftbox_instances",
      columns: "id, status, redeemed_source_type, redeemed_source_id",
      where: "id = ?",
      params: [instanceId],
      limit: 1,
    });
    const inst = rows[0];
    if (!inst) return;
    const closedByThis =
      String(inst.status ?? "") === "redeemed" &&
      String(inst.redeemed_source_type ?? "") === "appointment" &&
      Number(inst.redeemed_source_id ?? 0) === appointmentId;
    if (closedByThis) {
      await tenantUpdate({
        slug,
        table: "giftbox_instances",
        id: instanceId,
        values: { status: "issued", redeemed_at: null, redeemed_source_type: null, redeemed_source_id: null },
      });
    }
  } catch {
    // best-effort
  }
}

// Inverse of the GIFTCARD redeem (applyAppointmentGiftcardRedeem step 5): refund the
// used amount back to giftcards.balance and re-activate a 'redeemed' card. A reversal
// giftcard_transactions movement is written to mirror the redeem ledger entry.
// Best-effort + columnExists/tableExists-guarded.
async function restoreGiftcardBalance(slug: string, giftcardId: number, amount: number): Promise<void> {
  const refund = roundMoney(Math.max(0, amount));
  if (refund <= 0) return;
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "giftcards",
      columns: "id, balance, status",
      where: "id = ?",
      params: [giftcardId],
      limit: 1,
    });
    if (!rows[0]) return;
    const balance = roundMoney(Math.max(0, parseMoney(rows[0].balance, 0)) + refund);
    const values: Record<string, unknown> = { balance };
    // A card the redeem flipped to 'redeemed' (balance hit 0) becomes usable again.
    if (String(rows[0].status ?? "") === "redeemed") {
      values.status = "active";
      values.redeemed_at = null;
    }
    await tenantUpdate({ slug, table: "giftcards", id: giftcardId, values });
    await tenantInsert(await tenantTable(slug, "giftcard_transactions"), {
      giftcard_id: giftcardId,
      type: "refund",
      amount: refund,
      note: "Storno eliminazione appuntamento",
      created_at: new Date(),
    }).catch(() => 0);
  } catch {
    // best-effort
  }
}

// Exported so the manage route can normalize the incoming target status to the
// same PHP code the DB write uses, then map old->new to a lifecycle email kind.
export function appointmentPhpStatus(status: AppointmentStatus | string): string {
  return phpStatus(status);
}

export async function listDbSales({
  slug,
  locationId = 0,
  includeCancelled = true,
}: {
  slug: string;
  locationId?: number;
  includeCancelled?: boolean;
}): Promise<PosSale[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (locationId > 0) {
    clauses.push("(location_id IS NULL OR location_id = ?)");
    params.push(locationId);
  }
  if (!includeCancelled) clauses.push("status <> 'cancelled'");

  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "sales",
    where: clauses.join(" AND "),
    params,
    orderBy: "sale_date DESC, id DESC",
  });

  return Promise.all(rows.map((row) => mapSale(slug, row)));
}

export async function posDbSummary(slug: string): Promise<PosSummary> {
  const sales = await listDbSales({ slug });
  const activeSales = sales.filter((sale) => sale.status !== "cancelled");
  const cancelledSales = sales.filter((sale) => sale.status === "cancelled");
  const paymentTotals: Record<PosPaymentMethod, number> = {
    cash: 0,
    card: 0,
    check: 0,
    transfer: 0,
    giftcard: 0,
    wallet: 0,
  };
  let serviceTotal = 0;
  let productTotal = 0;

  for (const sale of activeSales) {
    paymentTotals.card = roundMoney(paymentTotals.card + sale.total);
    for (const item of sale.items) {
      if (item.type === "service") serviceTotal = roundMoney(serviceTotal + item.total);
      if (item.type === "product") productTotal = roundMoney(productTotal + item.total);
    }
  }

  return {
    saleCount: activeSales.length,
    grossTotal: roundMoney(sales.reduce((total, sale) => total + sale.total, 0)),
    activeTotal: roundMoney(activeSales.reduce((total, sale) => total + sale.total, 0)),
    cancelledTotal: roundMoney(cancelledSales.reduce((total, sale) => total + sale.total, 0)),
    paymentTotals,
    serviceTotal,
    productTotal,
  };
}

export async function checkoutDbSale(input: PosCheckoutInput, slug: string): Promise<PosSale> {
  if (!input.items.length) throw new Error("Carrello vuoto.");
  const client = await resolveSaleClientForDb(slug, input.clientId ?? 0, input.clientName);
  const items = await Promise.all(input.items.map((item, index) => buildDbSaleItem(slug, item, index + 1)));
  const subtotal = roundMoney(items.reduce((total, item) => total + item.total, 0));
  const discount = roundMoney(Math.max(0, input.discount ?? 0));
  const total = roundMoney(Math.max(0, subtotal - discount));
  const paidAmount = roundMoney(input.payments.reduce((sum, payment) => sum + Math.max(0, payment.amount), 0));
  if (paidAmount + 0.00001 < total) throw new Error("Pagamento insufficiente.");

  for (const item of items) {
    if (item.type === "product" && item.refId > 0) {
      const product = await getSingleProduct(slug, item.refId);
      if (product.stock < item.quantity) throw new Error(`Giacenza insufficiente per ${product.name}.`);
    }
  }

  const saleTable = await tenantTable(slug, "sales");
  const saleId = await tenantInsert(saleTable, {
    client_id: client.id > 0 ? client.id : null,
    sale_date: new Date(),
    subtotal,
    discount,
    total,
    coupon_code: input.couponCode || null,
    notes: input.appointmentId ? `Appuntamento #${input.appointmentId}` : null,
    status: "done",
    location_id: input.locationId && input.locationId > 0 ? input.locationId : null,
    promotion_applied_id: input.promotionId && input.promotionId > 0 ? input.promotionId : null,
  });

  for (const item of items) {
    const saleItemId = await tenantInsert(await tenantTable(slug, "sale_items"), {
      sale_id: saleId,
      item_type: item.type === "product" ? "product" : "service",
      item_id: item.refId > 0 ? item.refId : null,
      item_name: item.name,
      qty: item.quantity,
      unit_price: item.unitPrice,
      line_total: item.total,
      item_status: item.status,
    });

    if (item.type === "product" && item.refId > 0 && item.status !== "ordered") {
      await decrementProductStock(slug, item.refId, item.quantity);
    }
    if (item.type === "prepaid" && client.id > 0) {
      await issueDbPrepaidFromSale({ slug, saleId, saleItemId, clientId: client.id, item });
    }
    if (item.type === "package" && client.id > 0) {
      await issueDbPackageFromSale({ slug, saleId, clientId: client.id, item });
    }
    if (item.type === "giftcard" && client.id > 0) {
      await issueDbGiftCardFromSale({ slug, clientId: client.id, recipientName: client.name, amount: item.total, locationId: input.locationId ?? null });
    }
  }

  if (input.appointmentId && input.appointmentId > 0) {
    await tenantUpdate({ slug, table: "appointments", id: input.appointmentId, values: { status: "done" } }).catch(() => 0);
  }
  if (input.installments && input.installments > 1 && client.id > 0) {
    await createDbInstallmentPlanFromSale({ slug, saleId, clientId: client.id, total, count: input.installments });
  }

  const sales = await listDbSales({ slug });
  const sale = sales.find((item) => item.id === saleId);
  if (!sale) throw new Error("Vendita creata ma non riletta.");
  return sale;
}

export async function cancelDbSale({
  saleId,
  reason,
  stockCancelMode = "restore",
  slug,
}: {
  saleId: number;
  reason: string;
  stockCancelMode?: "restore" | "no_restore" | "none";
  slug: string;
}): Promise<PosSale> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "sales", where: "id = ?", params: [saleId], limit: 1 });
  const saleRow = rows[0];
  if (!saleRow) throw new Error("Vendita non trovata.");
  if (String(saleRow.status ?? "") === "cancelled") throw new Error("Vendita gia annullata.");
  const items = await saleItems(slug, saleId);

  if (stockCancelMode === "restore") {
    for (const item of items) {
      if (item.type === "product" && item.refId > 0) await incrementProductStock(slug, item.refId, item.quantity);
    }
  }

  await tenantUpdate({
    slug,
    table: "sales",
    id: saleId,
    values: { status: "cancelled", cancelled_at: new Date(), cancelled_reason: reason || "Annullamento vendita" },
  });
  await cancelDbSaleResidues(slug, saleId);

  const sales = await listDbSales({ slug });
  const sale = sales.find((item) => item.id === saleId);
  if (!sale) throw new Error("Vendita annullata ma non riletta.");
  return sale;
}

export async function listDbCosts(slug: string): Promise<CostItem[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "costs",
    orderBy: "due_date ASC, id DESC",
  });
  return Promise.all(rows.map((row) => mapCost(slug, row)));
}

export async function costDbSummary(slug: string): Promise<{ open: number; overdue: number; paid: number; dueAmount: number }> {
  const costs = await listDbCosts(slug);
  return {
    open: costs.filter((cost) => cost.status === "open").length,
    overdue: costs.filter((cost) => cost.status === "overdue").length,
    paid: costs.filter((cost) => cost.status === "paid").length,
    dueAmount: roundMoney(costs.filter((cost) => cost.status !== "paid").reduce((total, cost) => total + cost.amount, 0)),
  };
}

export async function markDbCostPaid(id: number, slug: string): Promise<CostItem> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "costs", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Costo non trovato.");
  await tenantUpdate({ slug, table: "costs", id, values: { is_paid: 1, paid_amount: Number(rows[0].amount ?? 0), paid_at: new Date() } });
  const updatedRows = await tenantSelect<RowDataPacket>({ slug, table: "costs", where: "id = ?", params: [id], limit: 1 });
  if (!updatedRows[0]) throw new Error("Costo non trovato.");
  return mapCost(slug, updatedRows[0]);
}

export async function listDbQuotes(slug: string): Promise<Quote[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "quotes",
    orderBy: "created_at DESC, id DESC",
  });
  return Promise.all(rows.map((row) => mapQuote(slug, row)));
}

// Drop values whose column doesn't exist on the physical table (schema-guarded
// writes) — one INFORMATION_SCHEMA query, matching the helper used across the
// manage-* modules.
async function filterColumns(table: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
    [table],
  );
  const columns = new Set(rows.map((row) => String(row.column_name ?? row.COLUMN_NAME)));
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => columns.has(key) && value !== undefined));
}

// Rich quote-editor input (port of the quotes.php new/edit fields): client +
// optional anagrafica snapshot + dates + notes/terms/public note + the content
// lines (each with per-line IVA + discount%).
export type QuoteLineInput = { type: "service" | "product" | "package" | "custom"; refId: number; name: string; sku?: string; quantity: number; unitPrice: number; taxRate?: number; discountPercent?: number };
export type QuoteSaveInput = {
  clientId?: number;
  clientName?: string;
  client?: { companyName?: string; vatNumber?: string; taxCode?: string; sdi?: string; pec?: string; email?: string; phone?: string; address?: string; cap?: string; city?: string; province?: string };
  quoteDate?: string;
  validUntil?: string;
  notes?: string;
  terms?: string;
  publicNote?: string;
  lines: QuoteLineInput[];
};

// Per-line + total computation, faithful to quotes.php save: for each line
// gross=qty*unit, lineSub=gross*(1-disc%), lineTax=lineSub*iva%, lineTot=lineSub+lineTax;
// the quote subtotal is NET of line discounts, tax_total = Σ line tax, total = net+tax.
function computeQuoteLines(lines: QuoteLineInput[]): {
  items: Array<Record<string, unknown>>;
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
} {
  let subtotal = 0;
  let discountTotal = 0;
  let taxTotal = 0;
  let total = 0;
  const items: Array<Record<string, unknown>> = [];
  let pos = 0;
  for (const l of lines) {
    const desc = String(l.name ?? "").trim();
    if (desc === "" && !(l.refId > 0)) continue;
    const qty = l.quantity > 0 ? l.quantity : 1;
    const unit = Math.max(0, Number(l.unitPrice) || 0);
    const taxRate = Math.min(100, Math.max(0, Number(l.taxRate) || 0));
    const disc = Math.min(100, Math.max(0, Number(l.discountPercent) || 0));
    const type = ["service", "product", "package", "custom"].includes(l.type) ? l.type : "custom";
    const gross = qty * unit;
    const lineSub = roundMoney(gross * (1 - disc / 100));
    const lineDisc = roundMoney(gross - lineSub);
    const lineTax = roundMoney(lineSub * (taxRate / 100));
    const lineTot = roundMoney(lineSub + lineTax);
    subtotal += lineSub;
    discountTotal += lineDisc;
    taxTotal += lineTax;
    total += lineTot;
    items.push({
      position: pos,
      item_type: type,
      item_id: l.refId > 0 ? l.refId : null,
      description: desc || `${type} #${l.refId}`,
      sku: String(l.sku ?? "").trim() || null,
      qty,
      unit_price: unit,
      tax_rate: taxRate,
      discount_percent: disc,
      line_subtotal: lineSub,
      line_tax: lineTax,
      line_total: lineTot,
    });
    pos++;
  }
  return { items, subtotal: roundMoney(subtotal), discountTotal: roundMoney(discountTotal), taxTotal: roundMoney(taxTotal), total: roundMoney(total) };
}

// The quotes-row client anagrafica snapshot columns from a save input + resolved client.
function quoteClientValues(input: QuoteSaveInput, client: { id: number; name: string }): Record<string, unknown> {
  const s = input.client ?? {};
  const clean = (v: unknown) => { const t = String(v ?? "").trim(); return t !== "" ? t : null; };
  return {
    client_id: client.id > 0 ? client.id : null,
    client_name: client.name,
    client_email: clean(s.email),
    client_phone: clean(s.phone),
    client_company_name: clean(s.companyName),
    client_vat_number: clean(s.vatNumber),
    client_tax_code: clean(s.taxCode),
    client_sdi: clean(s.sdi),
    client_pec: clean(s.pec),
    client_address: clean(s.address),
    client_cap: clean(s.cap),
    client_city: clean(s.city),
    client_province: clean(s.province),
  };
}

export async function createDbQuote(input: QuoteSaveInput, slug: string): Promise<Quote> {
  if (!input.lines.length) throw new Error("Aggiungi almeno una voce al preventivo.");
  const client = await resolveSaleClientForDb(slug, input.clientId ?? 0, input.clientName);
  const { items, subtotal, discountTotal, taxTotal, total } = computeQuoteLines(input.lines);
  if (items.length === 0) throw new Error("Aggiungi almeno una riga al preventivo.");
  const validFrom = normalizeClientDate(input.quoteDate) || todayIso();
  const validUntil = normalizeClientDate(input.validUntil) || addDaysDate(30);
  const tempNumber = `Q-${Date.now().toString(36).toUpperCase()}`;
  const values = await filterColumns((await tenantTable(slug, "quotes")).name, {
    number: tempNumber,
    ...quoteClientValues(input, client),
    subtotal,
    discount_total: discountTotal,
    tax_total: taxTotal,
    total,
    status: "draft",
    public_token: randomHex(32),
    quote_date: validFrom,
    valid_until: validUntil,
    notes: String(input.notes ?? "").trim() || null,
    terms: String(input.terms ?? "").trim() || null,
    public_note: String(input.publicNote ?? "").trim() || null,
    created_at: new Date(),
    updated_at: new Date(),
  });
  const id = await tenantInsert(await tenantTable(slug, "quotes"), values);

  await tenantUpdate({ slug, table: "quotes", id, values: { number: `Q-${String(id).padStart(5, "0")}` } }).catch(() => undefined);
  await insertQuoteItems(slug, id, items);

  const rows = await tenantSelect<RowDataPacket>({ slug, table: "quotes", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Preventivo creato ma non riletta.");
  return mapQuote(slug, rows[0]);
}

// Insert quote_items rows (schema-filtered so a missing line_subtotal/line_tax
// column degrades gracefully).
async function insertQuoteItems(slug: string, quoteId: number, items: Array<Record<string, unknown>>): Promise<void> {
  const table = await tenantTable(slug, "quote_items");
  for (const item of items) {
    const values = await filterColumns(table.name, { quote_id: quoteId, ...item });
    await tenantInsert(table, values);
  }
}

// Edit-form prefill: return an existing quote in the CORE editor's shape
// (client + discount + lines) so QuoteFormContent can prefill it. Port of
// quotes.php action=edit load.
export type ManageQuoteEditLine = { type: "service" | "product" | "package" | "custom"; refId: number; name: string; sku: string; quantity: number; unitPrice: number; taxRate: number; discountPercent: number };
export type ManageQuoteEdit = {
  id: number;
  clientId: number;
  clientName: string;
  quoteDate: string;
  validUntil: string;
  notes: string;
  terms: string;
  publicNote: string;
  client: { companyName: string; vatNumber: string; taxCode: string; sdi: string; pec: string; email: string; phone: string; address: string; cap: string; city: string; province: string };
  lines: ManageQuoteEditLine[];
};
export async function getManageQuoteForEdit(slug: string, id: number): Promise<ManageQuoteEdit | null> {
  if (id <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "quotes", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) return null;
  const qrow = rows[0];
  const itemRows = await tenantSelect<RowDataPacket>({ slug, table: "quote_items", where: "quote_id = ?", params: [id], orderBy: "position ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  const lineType = (t: string): "service" | "product" | "package" | "custom" => (["service", "product", "package", "custom"].includes(t) ? (t as "service" | "product" | "package" | "custom") : "custom");
  return {
    id,
    clientId: Number(qrow.client_id ?? 0) || 0,
    clientName: String(qrow.client_name ?? ""),
    quoteDate: qrow.quote_date ? String(qrow.quote_date).slice(0, 10) : "",
    validUntil: qrow.valid_until ? String(qrow.valid_until).slice(0, 10) : "",
    notes: String(qrow.notes ?? ""),
    terms: String(qrow.terms ?? ""),
    publicNote: String(qrow.public_note ?? ""),
    client: {
      companyName: String(qrow.client_company_name ?? ""),
      vatNumber: String(qrow.client_vat_number ?? ""),
      taxCode: String(qrow.client_tax_code ?? ""),
      sdi: String(qrow.client_sdi ?? ""),
      pec: String(qrow.client_pec ?? ""),
      email: String(qrow.client_email ?? ""),
      phone: String(qrow.client_phone ?? ""),
      address: String(qrow.client_address ?? ""),
      cap: String(qrow.client_cap ?? ""),
      city: String(qrow.client_city ?? ""),
      province: String(qrow.client_province ?? ""),
    },
    lines: itemRows.map((r) => ({
      type: lineType(String(r.item_type ?? "")),
      refId: Number(r.item_id ?? 0) || 0,
      name: String(r.description ?? ""),
      sku: String(r.sku ?? ""),
      quantity: Math.max(1, Number(r.qty ?? 1)),
      unitPrice: roundMoney(Number(r.unit_price ?? 0)),
      taxRate: Number(r.tax_rate ?? 0),
      discountPercent: Number(r.discount_percent ?? 0),
    })),
  };
}

// Update an existing quote (port of quotes.php action=edit save). Only DRAFT/SENT
// quotes are editable (converted/accepted ones are locked). Recomputes the
// client + lines + subtotal/discount/total, keeps the number/status/dates, and
// rebuilds quote_items.
export async function updateDbQuote(id: number, input: QuoteSaveInput, slug: string): Promise<Quote> {
  if (id <= 0) throw new Error("ID preventivo mancante.");
  if (!input.lines.length) throw new Error("Aggiungi almeno una voce al preventivo.");
  const existing = await tenantSelect<RowDataPacket>({ slug, table: "quotes", columns: "id, status", where: "id = ?", params: [id], limit: 1 });
  if (!existing[0]) throw new Error("Preventivo non trovato.");
  const status = quoteStatus(String(existing[0].status ?? "draft"));
  if (status !== "draft" && status !== "sent") throw new Error("Questo preventivo non è modificabile.");

  const client = await resolveSaleClientForDb(slug, input.clientId ?? 0, input.clientName);
  const { items, subtotal, discountTotal, taxTotal, total } = computeQuoteLines(input.lines);
  if (items.length === 0) throw new Error("Aggiungi almeno una riga al preventivo.");
  const validFrom = normalizeClientDate(input.quoteDate);
  const validUntil = normalizeClientDate(input.validUntil);

  const values = await filterColumns((await tenantTable(slug, "quotes")).name, {
    ...quoteClientValues(input, client),
    subtotal,
    discount_total: discountTotal,
    tax_total: taxTotal,
    total,
    quote_date: validFrom ?? undefined,
    valid_until: validUntil ?? undefined,
    notes: String(input.notes ?? "").trim() || null,
    terms: String(input.terms ?? "").trim() || null,
    public_note: String(input.publicNote ?? "").trim() || null,
    updated_at: new Date(),
  });
  await tenantUpdate({ slug, table: "quotes", id, values });

  // Rebuild quote_items.
  const itemTable = await tenantTable(slug, "quote_items");
  const scoped = itemTable.mode === "shared" && (await columnExists(itemTable.name, "tenant_id"));
  await dbExecute(
    `DELETE FROM ${quoteIdentifier(itemTable.name)} WHERE quote_id = ?${scoped ? " AND tenant_id = ?" : ""}`,
    scoped ? [id, itemTable.tenantId ?? 0] : [id],
  ).catch(() => undefined);
  await insertQuoteItems(slug, id, items);

  const rows = await tenantSelect<RowDataPacket>({ slug, table: "quotes", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Preventivo non trovato.");
  return mapQuote(slug, rows[0]);
}

export async function updateDbQuoteStatus(id: number, status: QuoteStatus, slug: string): Promise<Quote> {
  const values: Record<string, unknown> = { status };
  if (status === "sent") values.sent_at = new Date();
  if (status === "accepted") {
    values.customer_decision_at = new Date();
    values.customer_decision_source = "next";
  }
  await tenantUpdate({ slug, table: "quotes", id, values });
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "quotes", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Preventivo non trovato.");
  return mapQuote(slug, rows[0]);
}

// Delete a quote (port of quotes.php action=delete): only DRAFT quotes can be
// deleted — sent/converted/etc. must be kept for history (use the
// Annullato/Rifiutato status instead). Drops quote_items + the quotes row.
export async function deleteDbQuote(slug: string, id: number): Promise<{ ok: true }> {
  if (id <= 0) throw new Error("Preventivo non valido.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "quotes", columns: "id, status", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Preventivo non trovato.");
  if (quoteStatus(String(rows[0].status ?? "draft")) !== "draft") {
    throw new Error("Puoi eliminare solo preventivi in bozza. Per preventivi inviati o storicizzati usa lo stato Annullato/Rifiutato.");
  }
  const itemTable = await tenantTable(slug, "quote_items").catch(() => null);
  if (itemTable) {
    const scoped = itemTable.mode === "shared" && (await columnExists(itemTable.name, "tenant_id"));
    await dbExecute(
      `DELETE FROM ${quoteIdentifier(itemTable.name)} WHERE quote_id = ?${scoped ? " AND tenant_id = ?" : ""}`,
      scoped ? [id, itemTable.tenantId ?? 0] : [id],
    ).catch(() => undefined);
  }
  await tenantDelete({ slug, table: "quotes", id });
  return { ok: true };
}

// ---- Quote DETAIL (quotes.php action=view) -----------------------------------
export type QuoteDetailItem = { description: string; sku: string; itemType: string; qty: number; unitPrice: number; taxRate: number; discountPercent: number; lineTotal: number };
export type ManageQuoteDetail = {
  id: number;
  number: string;
  quoteDate: string;
  validUntil: string;
  status: string;
  statusLabel: string;
  statusBadge: string;
  locationName: string;
  client: {
    name: string;
    companyName: string;
    vatNumber: string;
    taxCode: string;
    sdi: string;
    pec: string;
    phone: string;
    email: string;
    address: string;
    cap: string;
    city: string;
    province: string;
  };
  items: QuoteDetailItem[];
  subtotal: number;
  discountTotal: number;
  taxTotal: number;
  total: number;
  notes: string;
  terms: string;
  publicNote: string;
  linkedSaleId: number | null;
  linkedSaleCancelled: boolean;
  canEdit: boolean;
  canSendEmail: boolean;
};

const QUOTE_STATUS_META: Record<string, { label: string; badge: string }> = {
  draft: { label: "Bozza", badge: "bg-secondary" },
  sent: { label: "Inviato", badge: "bg-info text-dark" },
  accepted: { label: "Accettato", badge: "bg-success" },
  converted: { label: "Pagato", badge: "bg-success" },
  rejected: { label: "Rifiutato", badge: "bg-danger" },
};

// Full quote DETAIL (port of quotes.php action=view): the header + client card +
// line items + totals + notes/terms + the linked sale (sales.source_quote_id) and
// the edit/send-email eligibility flags. Read-only.
export async function getManageQuoteDetail(slug: string, id: number): Promise<ManageQuoteDetail | null> {
  if (id <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "quotes", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) return null;
  const qrow = rows[0];
  const status = quoteStatus(String(qrow.status ?? "draft"));

  const itemRows = await tenantSelect<RowDataPacket>({ slug, table: "quote_items", where: "quote_id = ?", params: [id], orderBy: "position ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  const items: QuoteDetailItem[] = itemRows.map((r) => ({
    description: String(r.description ?? ""),
    sku: String(r.sku ?? ""),
    itemType: String(r.item_type ?? ""),
    qty: Number(r.qty ?? 1),
    unitPrice: roundMoney(Number(r.unit_price ?? 0)),
    taxRate: Number(r.tax_rate ?? 0),
    discountPercent: Number(r.discount_percent ?? 0),
    lineTotal: roundMoney(Number(r.line_total ?? 0)),
  }));

  // Linked sale (the reverse link is sales.source_quote_id; prefer a non-cancelled one).
  let linkedSaleId: number | null = null;
  let linkedSaleCancelled = false;
  const saleRows = await tenantSelect<RowDataPacket>({ slug, table: "sales", columns: "id, status", where: "source_quote_id = ?", params: [id], orderBy: "id DESC" }).catch(() => [] as RowDataPacket[]);
  if (saleRows.length > 0) {
    const active = saleRows.find((r) => !["cancelled", "canceled"].includes(String(r.status ?? "").trim().toLowerCase()));
    const chosen = active ?? saleRows[0];
    linkedSaleId = Number(chosen.id ?? 0) || null;
    linkedSaleCancelled = !active;
  }

  const meta = QUOTE_STATUS_META[status] ?? { label: status || "—", badge: "bg-secondary" };
  const validUntil = qrow.valid_until ? String(qrow.valid_until).slice(0, 10) : "";
  const notExpired = validUntil === "" || validUntil >= todayIso();
  const canEdit = status === "draft" || status === "sent";
  const canSendEmail = (status === "draft" || status === "sent") && notExpired;

  return {
    id,
    number: String(qrow.number ?? ""),
    quoteDate: qrow.quote_date ? String(qrow.quote_date).slice(0, 10) : "",
    validUntil,
    status,
    statusLabel: meta.label,
    statusBadge: meta.badge,
    locationName: String(qrow.location_name ?? ""),
    client: {
      name: String(qrow.client_name ?? ""),
      companyName: String(qrow.client_company_name ?? ""),
      vatNumber: String(qrow.client_vat_number ?? ""),
      taxCode: String(qrow.client_tax_code ?? ""),
      sdi: String(qrow.client_sdi ?? ""),
      pec: String(qrow.client_pec ?? ""),
      phone: String(qrow.client_phone ?? ""),
      email: String(qrow.client_email ?? ""),
      address: String(qrow.client_address ?? ""),
      cap: String(qrow.client_cap ?? ""),
      city: String(qrow.client_city ?? ""),
      province: String(qrow.client_province ?? ""),
    },
    items,
    subtotal: roundMoney(Number(qrow.subtotal ?? 0)),
    discountTotal: roundMoney(Number(qrow.discount_total ?? 0)),
    taxTotal: roundMoney(Number(qrow.tax_total ?? 0)),
    total: roundMoney(Number(qrow.total ?? 0)),
    notes: String(qrow.notes ?? ""),
    terms: String(qrow.terms ?? ""),
    publicNote: String(qrow.public_note ?? ""),
    linkedSaleId,
    linkedSaleCancelled,
    canEdit,
    canSendEmail,
  };
}

// Port of the quotes.php manual "Invia email" action (action=email): emails the
// quote to the client with the public-page link and a PDF link, then marks the
// quote sent. The Next quotes route previously only flipped the status via
// updateDbQuoteStatus(), so the email was silent. This sends it for real.
//
// Tenant-scoped, gated on emailConfigured() (no-op when SES is off so the existing
// status-only behaviour is preserved), runs AFTER the status write, and swallows
// every error — a failed send must never fail the quotes flow (the legacy redirects
// with an error but the row stays; here the caller already updated the status).
//
// Recipient resolution mirrors the PHP: explicit `toEmail` (the form's to_email),
// else the quote's stored client_email, else the linked client's email.
//
// TODO (PDF): the legacy links a server-rendered PDF (QuotePdf.php) at
// ?page=quote_public&token=...&format=pdf. There is no PDF renderer in Next yet, so
// we keep the legacy public/PDF link shapes built against PRENODO_PUBLIC_BASE_URL
// (the tenant's legacy public site still serves quote_public). Replace these with
// the native public quote page + PDF once they exist in Next.
type QuoteBranding = { name: string; email: string; logoUrl: string };

async function quoteEmailBranding(slug: string): Promise<QuoteBranding> {
  const empty: QuoteBranding = { name: "", email: "", logoUrl: "" };
  try {
    const tenantId = await tenantIdForSlug(slug);
    if (!tenantId || !(await tableExists("businesses"))) return empty;
    const hasLogo = await columnExists("businesses", "logo_path");
    const hasQuoteName = await columnExists("businesses", "quote_company_name");
    const hasQuoteEmail = await columnExists("businesses", "quote_email");
    const cols = ["name", "email"];
    if (hasQuoteName) cols.push("quote_company_name");
    if (hasQuoteEmail) cols.push("quote_email");
    if (hasLogo) cols.push("logo_path");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT ${cols.join(", ")} FROM businesses WHERE tenant_id = ? ORDER BY id ASC LIMIT 1`,
      [tenantId],
    ).catch(() => [] as RowDataPacket[]);
    const row = rows[0];
    if (!row) return empty;
    // The legacy quote header uses the quote-specific company name/email when set
    // (quote_apply_location_snapshot_to_header), falling back to the business ones.
    const name = String(row.quote_company_name ?? "").trim() || String(row.name ?? "");
    const fromEmail = String(row.quote_email ?? "").trim() || String(row.email ?? "");
    return {
      name,
      email: fromEmail,
      logoUrl: hasLogo ? resolveQuoteLogoUrl(String(row.logo_path ?? "")) : "",
    };
  } catch {
    return empty;
  }
}

function resolveQuoteLogoUrl(logoPath: string): string {
  const path = logoPath.trim();
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const base = String(process.env.PRENODO_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base || !path.startsWith("/")) return "";
  return `${base}${path}`;
}

// quote_public_url() / quote_public_pdf_url(): the legacy tenant public links.
function quotePublicUrl(slug: string, token: string): string {
  const base = String(process.env.PRENODO_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base || !token) return "";
  return `${base}/${encodeURIComponent(slug)}/quote_public?token=${encodeURIComponent(token)}&embed=1`;
}
function quotePublicPdfUrl(slug: string, token: string): string {
  const base = String(process.env.PRENODO_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base || !token) return "";
  return `${base}/${encodeURIComponent(slug)}/quote_public?token=${encodeURIComponent(token)}&format=pdf`;
}

function escapeQuoteHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// date('d/m/Y', strtotime($valid_until)) over a stored Y-m-d (or Y-m-d HH:MM:SS).
function formatQuoteValidUntil(raw: unknown): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw ?? "").trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

export async function sendQuoteEmail(
  id: number,
  slug: string,
  opts: { toEmail?: string; message?: string } = {},
): Promise<void> {
  if (!emailConfigured()) return;
  if (!Number.isFinite(id) || id <= 0) return;
  try {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "quotes", where: "id = ?", params: [id], limit: 1 }).catch(() => []);
    const quote = rows[0];
    if (!quote) return;

    // Recipient: explicit to_email -> quote.client_email -> linked client email.
    let to = String(opts.toEmail ?? "").trim();
    if (!to) to = String(quote.client_email ?? "").trim();
    if (!to) {
      const clientId = Number(quote.client_id ?? 0);
      if (clientId > 0) {
        const clientRows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "email", where: "id = ?", params: [clientId], limit: 1 }).catch(() => []);
        to = String(clientRows[0]?.email ?? "").trim();
      }
    }
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return;

    const token = String(quote.public_token ?? "").trim();
    const publicUrl = quotePublicUrl(slug, token);
    const pdfUrl = quotePublicPdfUrl(slug, token);

    const branding = await quoteEmailBranding(slug);
    const bizName = branding.name.trim();
    const number = String(quote.number ?? "");
    const clientName = String(quote.client_name ?? "").trim();
    const customMsg = String(opts.message ?? "").trim();

    // Subject: 'Preventivo <number>' + ' - <bizName>' when present.
    let subject = `Preventivo ${number}`.trim();
    if (bizName !== "") subject += ` - ${bizName}`;

    // Body: faithful HTML port of the quotes.php block (greeting, number, validity,
    // optional custom message box, "Apri preventivo" button, PDF link).
    let body = "";
    body += clientName !== ""
      ? `Ciao <strong>${escapeQuoteHtml(clientName)}</strong>,<br><br>`
      : "Ciao,<br><br>";
    body += `ti inviamo il tuo preventivo <strong>#${escapeQuoteHtml(number)}</strong>.`;
    const validUntil = formatQuoteValidUntil(quote.valid_until);
    if (validUntil !== "") {
      body += `<br>Valido fino al: <strong>${escapeQuoteHtml(validUntil)}</strong>.`;
    }
    body += "<br><br>";
    if (customMsg !== "") {
      const safeMsg = escapeQuoteHtml(customMsg).replace(/(\r\n|\n\r|\n|\r)/g, "<br>$1");
      body += `<div style="padding:10px 12px;border:1px solid #e5e7eb;border-radius:12px;background:#f9fafb;margin:10px 0;white-space:pre-wrap;">${safeMsg}</div>`;
    }
    if (publicUrl !== "") {
      body += `<a href="${escapeQuoteHtml(publicUrl)}" style="display:inline-block;background:#4e6da5;color:#fff;text-decoration:none;padding:10px 14px;border-radius:10px;font-weight:600">Apri preventivo</a>`;
      body += "<br><br>";
    }
    if (pdfUrl !== "") {
      body += `Scarica PDF: <a href="${escapeQuoteHtml(pdfUrl)}">${escapeQuoteHtml(pdfUrl)}</a><br>`;
    }

    const { html, text } = buildModernEmailTemplate(subject, body, {
      business_name: bizName,
      business_email: branding.email,
      business_logo_url: branding.logoUrl,
    });
    const res = await sendEmail({
      to,
      subject,
      html,
      text,
      fromEmail: branding.email.trim() || undefined,
      fromName: bizName || undefined,
    });
    if (!res.ok) {
      console.error(`[db-repositories] quote email send failed for quote ${id} -> ${to}: ${res.error}`);
      return;
    }

    // Legacy best-effort "mark sent": draft -> sent, stamp sent_at + sent_to_email.
    const quoteTable = await tenantTable(slug, "quotes");
    const values: Record<string, unknown> = {};
    if (String(quote.status ?? "") === "draft") values.status = "sent";
    if (await columnExists(quoteTable.name, "sent_at")) values.sent_at = new Date();
    if (await columnExists(quoteTable.name, "sent_to_email")) values.sent_to_email = to;
    if (await columnExists(quoteTable.name, "updated_at")) values.updated_at = new Date();
    if (Object.keys(values).length > 0) {
      await tenantUpdate({ slug, table: "quotes", id, values }).catch(() => undefined);
    }
  } catch (error) {
    console.error("[db-repositories] quote email send error:", error);
  }
}

export async function convertDbQuoteToSale(id: number, slug: string, locationId = 0): Promise<{ quote: Quote; sale: PosSale }> {
  const quote = (await listDbQuotes(slug)).find((item) => item.id === id);
  if (!quote) throw new Error("Preventivo non trovato.");
  if (quote.status === "converted") throw new Error("Preventivo gia convertito.");

  const sale = await checkoutDbSale({
    clientId: quote.clientId,
    clientName: quote.clientName,
    locationId,
    discount: quote.discount,
    items: quote.lines.map((line) => ({
      type: line.type,
      refId: line.refId,
      name: line.name,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
    })),
    payments: quote.total > 0 ? [{ method: "card", amount: quote.total }] : [],
  }, slug);

  const quoteTable = await tenantTable(slug, "quotes");
  const values: Record<string, unknown> = { status: "converted" };
  if (await columnExists(quoteTable.name, "converted_sale_id")) values.converted_sale_id = sale.id;
  if (await columnExists(quoteTable.name, "converted_at")) values.converted_at = new Date();
  if (await columnExists(quoteTable.name, "updated_at")) values.updated_at = new Date();
  await tenantUpdate({ slug, table: "quotes", id, values });

  const updated = (await listDbQuotes(slug)).find((item) => item.id === id);
  if (!updated) throw new Error("Preventivo convertito ma non riletta.");
  return { quote: updated, sale };
}

export async function listDbWalletMovements(slug: string): Promise<WalletMovement[]> {
  const movements: WalletMovement[] = [];

  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "transactions",
      orderBy: "created_at DESC, id DESC",
      limit: 400,
    });
    movements.push(...rows.map(mapTransactionMovement));
  } catch {
    // Fidelity can be disabled in older installs.
  }

  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "credit_adjustments",
      orderBy: "created_at DESC, id DESC",
      limit: 400,
    });
    movements.push(...rows.map(mapCreditAdjustmentMovement));
  } catch {
    // Wallet can be disabled in older installs.
  }

  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "recharges",
      where: "COALESCE(is_void, 0) = 0",
      orderBy: "created_at DESC, id DESC",
      limit: 400,
    });
    movements.push(...rows.map(mapRechargeMovement));
  } catch {
    // Recharge table is optional.
  }

  return movements.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 500);
}

export async function dbWalletBalance(clientId: number, slug: string): Promise<{ credit: number; points: number }> {
  if (clientId <= 0) return { credit: 0, points: 0 };
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "clients",
    columns: "credit_balance,points",
    where: "id = ?",
    params: [clientId],
    limit: 1,
  });
  return {
    credit: roundMoney(Number(rows[0]?.credit_balance ?? 0)),
    points: Math.round(Number(rows[0]?.points ?? 0)),
  };
}

export async function addDbWalletMovement(
  input: Partial<WalletMovement> & {
    // Optional EXPLICIT ledger linkage for the `transactions` row (points movements):
    // source_type/source_id make the movement traceable so a later reversal (e.g. the
    // appointment cancel-done storno) can find + reverse exactly this entry. When
    // source_type is omitted the legacy behaviour stands (input.source ?? "manual"),
    // so existing callers are unaffected. createdBy stamps transactions.created_by.
    source_type?: string;
    source_id?: number;
    createdBy?: number;
  },
  slug: string,
): Promise<WalletMovement> {
  const clientId = Math.max(0, Number(input.clientId ?? 0));
  if (clientId <= 0) throw new Error("Cliente mancante.");
  const type = normalizeWalletMovementType(input.type);
  const amount = roundMoney(Number(input.amount ?? 0));
  const points = Math.round(Number(input.points ?? 0));
  if (amount === 0 && points === 0) throw new Error("Movimento vuoto.");

  const note = normalizeName(input.note, "Movimento wallet");
  const before = await dbWalletBalance(clientId, slug);
  let source = "manual";
  let id = 0;

  if (amount !== 0) {
    const balanceAfter = roundMoney(before.credit + amount);
    id = await tenantInsert(await tenantTable(slug, "credit_adjustments"), {
      client_id: clientId,
      direction: amount >= 0 ? "credit" : "debit",
      amount: Math.abs(amount),
      delta_amount: amount,
      balance_before: before.credit,
      balance_after: balanceAfter,
      note,
      created_at: new Date(),
    });
    await tenantUpdate({ slug, table: "clients", id: clientId, values: { credit_balance: balanceAfter } });
    source = "credit_adjustments";
  }

  if (points !== 0) {
    // POINT_LOTS (port of Fidelity::addTransaction, F1): prima di un movimento
    // negativo con scadenza attiva i lotti scaduti vengono processati (il saldo
    // può ridursi), poi il saldo viene riletto; il movimento crea/consuma lotti
    // e il reconcile riallinea. Best-effort sui lotti: un guasto non blocca il
    // movimento (il cron reconcile ripara).
    const lotsSettings = await fidelityLotsSettings(slug).catch(() => ({ expireEnabled: false, expireDays: 0, expireWarnDays: 0 }));
    if (points < 0 && lotsSettings.expireEnabled) {
      await expireClientLots(slug, clientId).catch(() => 0);
    }
    await ensureLotsInitialized(slug, clientId, lotsSettings).catch(() => undefined);
    const currentPoints = normalizeFidelityPoints(
      (await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "points", where: "id = ?", params: [clientId], limit: 1 }).catch(() => []))[0]?.points ?? before.points,
    );
    const nextPoints = currentPoints + points;
    const txKind = type === "points_redeem" ? "redeem" : type === "points_earn" ? "earn" : "manual";
    const txSourceType = input.source_type ?? input.source ?? source;
    const transactionId = await tenantInsert(await tenantTable(slug, "transactions"), {
      client_id: clientId,
      kind: txKind,
      // Prefer the EXPLICIT source_type (e.g. 'appointment'); fall back to the legacy
      // input.source string, then the credit-side source. source_id/created_by are
      // schema-guarded by tenantInsert (undefined values are dropped before the INSERT).
      source_type: txSourceType,
      source_id: input.source_id !== undefined && input.source_id > 0 ? input.source_id : undefined,
      delta_points: points,
      amount: amount || null,
      note,
      created_by: input.createdBy !== undefined && input.createdBy > 0 ? input.createdBy : undefined,
      created_at: new Date(),
    });
    if (!id) id = transactionId;
    await tenantUpdate({ slug, table: "clients", id: clientId, values: { points: nextPoints } });
    await applyLotsDelta(
      slug,
      { clientId, transactionId, kind: txKind, sourceType: String(txSourceType ?? "manual"), sourceId: input.source_id, delta: points },
      lotsSettings,
    ).catch(() => undefined);
    await reconcilePointLots(slug, clientId).catch(() => false);
    // Rinnovo automatico tessera su earn da attività (port of Fidelity::addTransaction
    // ~1662-1667: earn>0 con source sale/appointment -> fidelity_card_try_auto_renew).
    if (txKind === "earn" && points > 0 && ["sale", "appointment"].includes(String(txSourceType ?? ""))) {
      await fidelityCardTryAutoRenewByActivity(slug, clientId).catch(() => false);
    }
    // F4: ricalcolo del livello card dai punti maturati (recalcClientLevelLocked
    // su ogni transazione punti, Fidelity.php ~1706).
    await recalcClientFidelityLevel(slug, clientId).catch(() => "");
    source = "transactions";
  }

  return {
    id,
    clientId,
    type,
    amount,
    points,
    note,
    source,
    createdAt: new Date().toISOString(),
  };
}

export async function listDbGiftCards(slug: string): Promise<GiftCard[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "giftcards",
    orderBy: "issued_at DESC, id DESC",
  });
  return rows.map(mapGiftCard);
}

export async function issueDbGiftCard(input: Partial<GiftCard>, slug: string): Promise<GiftCard> {
  const amount = roundMoney(Math.max(0, Number(input.initialAmount ?? input.balance ?? 0)));
  if (amount <= 0) throw new Error("Importo GiftCard non valido.");

  const id = await tenantInsert(await tenantTable(slug, "giftcards"), {
    voucher_public_token: randomHex(64),
    code: normalizeName(input.code, `GC${Date.now().toString(36).toUpperCase().slice(-8)}`).toUpperCase().slice(0, 24),
    client_id: input.clientId && input.clientId > 0 ? input.clientId : null,
    recipient_name: normalizeName(input.recipientName, "Destinatario"),
    initial_amount: amount,
    balance: amount,
    currency: "EUR",
    status: "active",
    issued_at: new Date(),
    expires_at: input.expiresAt ?? addDaysDate(365),
    note: input.sourceSaleId ? `Vendita #${input.sourceSaleId}` : null,
  });

  await tenantInsert(await tenantTable(slug, "giftcard_transactions"), {
    giftcard_id: id,
    type: "issue",
    amount,
    note: "Emissione GiftCard",
    created_at: new Date(),
  });

  return getSingleGiftCard(slug, id);
}

export async function redeemDbGiftCard(id: number, amount: number, slug: string, note?: string): Promise<GiftCard> {
  const giftCard = await getSingleGiftCard(slug, id);
  if (giftCard.status !== "active") throw new Error("GiftCard non utilizzabile.");
  const value = roundMoney(Math.max(0, amount));
  if (value <= 0 || value > giftCard.balance) throw new Error("Importo riscatto non valido.");

  const balance = roundMoney(giftCard.balance - value);
  await tenantUpdate({
    slug,
    table: "giftcards",
    id,
    values: {
      balance,
      status: balance <= 0 ? "redeemed" : "active",
      redeemed_at: balance <= 0 ? new Date() : undefined,
    },
  });
  await tenantInsert(await tenantTable(slug, "giftcard_transactions"), {
    giftcard_id: id,
    type: "redeem",
    amount: value,
    note: String(note ?? "").trim() || "Riscatto GiftCard",
    created_at: new Date(),
  });

  return getSingleGiftCard(slug, id);
}

// ---- GiftCard DETAIL + manage (giftcard.php action=edit) ---------------------
export type GiftCardTransaction = { id: number; type: string; amount: number; note: string; createdAt: string };
export type ManageGiftCard = {
  id: number;
  code: string;
  recipientName: string;
  recipientEmail: string;
  clientId: number;
  initialAmount: number;
  balance: number;
  currency: string;
  status: string;
  statusLabel: string;
  statusBadge: string;
  issuedAt: string;
  expiresAt: string;
  redeemedAt: string;
  cancelledAt: string;
  note: string;
  giftMessage: string;
  internalNote: string;
  eventType: string;
  linkedSaleId: number | null;
  transactions: GiftCardTransaction[];
  canRedeem: boolean;
  canEdit: boolean;
};

const GIFTCARD_STATUS_META: Record<string, { label: string; badge: string }> = {
  active: { label: "Attiva", badge: "bg-success" },
  used: { label: "Utilizzata", badge: "bg-secondary" },
  expired: { label: "Scaduta", badge: "bg-warning text-dark" },
  cancelled: { label: "Annullata", badge: "bg-danger" },
};

// Full giftcard DETAIL (port of giftcard.php action=edit): the header (code /
// recipient / balance / status / dates / messages) + the transactions ledger
// (giftcard_transactions) + the linked sale (from the "Vendita #N" note) and the
// redeem/edit eligibility.
export async function getManageGiftCard(slug: string, id: number): Promise<ManageGiftCard | null> {
  if (id <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftcards", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) return null;
  const card = rows[0];
  const base = mapGiftCard(card);

  const txRows = await tenantSelect<RowDataPacket>({ slug, table: "giftcard_transactions", where: "giftcard_id = ?", params: [id], orderBy: "created_at DESC, id DESC", limit: 100 }).catch(() => [] as RowDataPacket[]);
  const transactions: GiftCardTransaction[] = txRows.map((r) => ({
    id: Number(r.id ?? 0),
    type: String(r.type ?? ""),
    amount: roundMoney(Number(r.amount ?? 0)),
    note: String(r.note ?? ""),
    createdAt: toIso(r.created_at),
  }));

  let linkedSaleId: number | null = null;
  const noteMatch = String(card.note ?? "").match(/Vendita\s+#(\d+)/i);
  if (noteMatch) linkedSaleId = Number(noteMatch[1]) || null;

  const meta = GIFTCARD_STATUS_META[base.status] ?? { label: base.status, badge: "bg-secondary" };
  return {
    id,
    code: base.code,
    recipientName: String(card.recipient_name ?? ""),
    recipientEmail: String(card.recipient_email ?? ""),
    clientId: Number(card.recipient_client_id ?? card.client_id ?? 0) || 0,
    initialAmount: base.initialAmount,
    balance: base.balance,
    currency: String(card.currency ?? "EUR"),
    status: base.status,
    statusLabel: meta.label,
    statusBadge: meta.badge,
    issuedAt: card.issued_at ? toIso(card.issued_at) : "",
    expiresAt: card.expires_at ? String(card.expires_at).slice(0, 10) : "",
    redeemedAt: card.redeemed_at ? toIso(card.redeemed_at) : "",
    cancelledAt: card.cancelled_at ? toIso(card.cancelled_at) : "",
    note: String(card.note ?? ""),
    giftMessage: String(card.gift_message ?? ""),
    internalNote: String(card.internal_note ?? ""),
    eventType: String(card.event_type ?? ""),
    linkedSaleId,
    transactions,
    canRedeem: base.status === "active" && base.balance > 0,
    canEdit: base.status !== "cancelled",
  };
}

// Update a giftcard's recipient + note + expiry (port of giftcard.php update /
// update_expiry / update_note / update_internal_note). Assigning a
// recipient_client_id links the card to that client and forces the recipient
// name/email from the anagrafica. A cancelled card is not editable.
export async function updateManageGiftCard(
  slug: string,
  id: number,
  input: { recipientClientId?: number; recipientName?: string; recipientEmail?: string; giftMessage?: string; internalNote?: string; expiresAt?: string },
): Promise<{ ok: true }> {
  if (id <= 0) throw new Error("GiftCard non valida.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftcards", columns: "id, status", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("GiftCard non trovata.");
  const st = String(rows[0].status ?? "").trim().toLowerCase();
  if (st === "cancelled" || st === "canceled") throw new Error("GiftCard annullata: non modificabile.");

  let recipientName = String(input.recipientName ?? "").trim();
  let recipientEmail = String(input.recipientEmail ?? "").trim();
  const recipientClientId = Math.max(0, Math.trunc(Number(input.recipientClientId ?? 0)));
  if (recipientClientId > 0) {
    const cRows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "full_name, email", where: "id = ?", params: [recipientClientId], limit: 1 });
    if (!cRows[0]) throw new Error("Cliente destinatario non trovato.");
    const cName = String(cRows[0].full_name ?? "").trim();
    if (cName !== "") recipientName = cName;
    const cEmail = String(cRows[0].email ?? "").trim();
    if (cEmail !== "" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cEmail)) recipientEmail = cEmail;
  }

  const values = await filterColumns((await tenantTable(slug, "giftcards")).name, {
    recipient_client_id: recipientClientId > 0 ? recipientClientId : null,
    recipient_name: recipientName !== "" ? recipientName : null,
    recipient_email: recipientEmail !== "" ? recipientEmail : null,
    gift_message: input.giftMessage !== undefined ? (String(input.giftMessage).trim() || null) : undefined,
    internal_note: input.internalNote !== undefined ? (String(input.internalNote).trim() || null) : undefined,
    expires_at: input.expiresAt !== undefined && normalizeClientDate(input.expiresAt) ? normalizeClientDate(input.expiresAt) : undefined,
    updated_at: new Date(),
  });
  await tenantUpdate({ slug, table: "giftcards", id, values });
  return { ok: true };
}

// Inverse of redeemDbGiftCard, exported for the POS void flow: refund `amount` back
// to giftcards.balance, re-activating a card the redeem flipped to 'redeemed' when its
// balance hit 0, and write a 'refund' giftcard_transactions ledger entry. Mirrors the
// private restoreGiftcardBalance (used by the appointment delete flow) but as a clean
// public primitive so cancelLinkedSaleResidues can reverse a POS giftcard tender.
export async function refundDbGiftCard(id: number, amount: number, slug: string, note = "Storno vendita"): Promise<void> {
  const refund = roundMoney(Math.max(0, amount));
  if (id <= 0 || refund <= 0) return;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "giftcards",
    columns: "id, balance, status",
    where: "id = ?",
    params: [id],
    limit: 1,
  });
  if (!rows[0]) return;
  const balance = roundMoney(Math.max(0, parseMoney(rows[0].balance, 0)) + refund);
  const values: Record<string, unknown> = { balance };
  if (String(rows[0].status ?? "") === "redeemed") {
    values.status = "active";
    values.redeemed_at = null;
  }
  await tenantUpdate({ slug, table: "giftcards", id, values });
  await tenantInsert(await tenantTable(slug, "giftcard_transactions"), {
    giftcard_id: id,
    type: "refund",
    amount: refund,
    note,
    created_at: new Date(),
  }).catch(() => 0);
}

// Available (redeemable) GiftCards for a client — used by the POS "Residui" panel.
// Same rule as quickBookClientGiftcards / quickBookClientResidualsSummary: a giftcard
// the client OWNS (recipient_client_id when the column exists, else client_id),
// status='active', balance > 0, not expired. Tenant-scoped + every read guarded.
export async function dbClientGiftcards(slug: string, clientId: number): Promise<Array<{ id: number; code: string; balance: number }>> {
  if (clientId <= 0) return [];
  try {
    const giftcardTable = await tenantTable(slug, "giftcards");
    const hasRecipient = await columnExists(giftcardTable.name, "recipient_client_id");
    const hasExpiry = await columnExists(giftcardTable.name, "expires_at");
    const target = hasRecipient ? "recipient_client_id = ?" : "client_id = ?";
    const expiry = hasExpiry ? " AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)" : "";
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "giftcards",
      columns: "id, code, balance",
      where: `${target} AND status = 'active' AND balance > 0${expiry}`,
      params: [clientId],
      orderBy: "(expires_at IS NULL) DESC, expires_at ASC, id DESC",
      limit: 50,
    });
    const out: Array<{ id: number; code: string; balance: number }> = [];
    for (const row of rows) {
      const id = Number(row.id ?? 0);
      const balance = roundMoney(Math.max(0, parseMoney(row.balance, 0)));
      if (id <= 0 || balance <= 0) continue;
      out.push({ id, code: String(row.code ?? ""), balance });
    }
    return out;
  } catch {
    return [];
  }
}

export async function listDbPackageState(slug: string): Promise<{ catalog: PackageCatalog[]; clientPackages: ClientPackage[] }> {
  const catalogRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "packages",
    where: "COALESCE(is_active, 1) = 1",
    orderBy: "name ASC, id DESC",
  });
  const clientRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "client_packages",
    orderBy: "created_at DESC, id DESC",
  });

  return {
    catalog: await Promise.all(catalogRows.map((row) => mapPackageCatalog(slug, row))),
    clientPackages: await Promise.all(clientRows.map((row) => mapClientPackage(slug, row))),
  };
}

// ---- Package CATALOG management (packages.php tab=catalog) --------------------
export type ManagePackageCatalogRow = {
  id: number;
  name: string;
  isActive: boolean;
  contentsSummary: string;
  locationLabel: string;
  sessionsTotal: number;
  price: number;
  validityDays: number | null;
  soldCount: number;
};

// Faithful catalog LIST (port of the packages.php tab=catalog table): one row per
// template with the contents summary (package_items "name ×qty", falling back to
// package_services / packages.service_id), the enabled-sedi label, total sedute,
// price, validity + the sold count (client_packages referencing the template).
export async function listManagePackageCatalog(slug: string): Promise<ManagePackageCatalogRow[]> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "packages", orderBy: "name ASC, id DESC" });
  const ids = rows.map((r) => Number(r.id ?? 0)).filter((n) => n > 0);
  if (ids.length === 0) return [];
  const ph = ids.map(() => "?").join(",");

  // package_items (rich contents) + package_services (fallback) for all templates.
  const itemRows = await tenantSelect<RowDataPacket>({ slug, table: "package_items", columns: "package_id, item_type, item_id, qty, sort_order", where: `package_id IN (${ph})`, params: ids, orderBy: "sort_order ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  const svcRows = await tenantSelect<RowDataPacket>({ slug, table: "package_services", columns: "package_id, service_id, sessions_total, sort_order", where: `package_id IN (${ph})`, params: ids, orderBy: "sort_order ASC, id ASC" }).catch(() => [] as RowDataPacket[]);

  // Resolve service + product names in batch.
  const serviceIds = new Set<number>();
  const productIds = new Set<number>();
  for (const r of itemRows) {
    const iid = Number(r.item_id ?? 0);
    if (iid <= 0) continue;
    if (String(r.item_type ?? "") === "product") productIds.add(iid);
    else serviceIds.add(iid);
  }
  for (const r of svcRows) { const sid = Number(r.service_id ?? 0); if (sid > 0) serviceIds.add(sid); }
  for (const r of rows) { const sid = Number(r.service_id ?? 0); if (sid > 0) serviceIds.add(sid); }
  const serviceName = new Map<number, string>();
  const productName = new Map<number, string>();
  if (serviceIds.size > 0) {
    const sids = Array.from(serviceIds);
    const sp = sids.map(() => "?").join(",");
    for (const r of await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "id, name", where: `id IN (${sp})`, params: sids }).catch(() => [] as RowDataPacket[])) serviceName.set(Number(r.id ?? 0), String(r.name ?? ""));
  }
  if (productIds.size > 0) {
    const pids = Array.from(productIds);
    const pp = pids.map(() => "?").join(",");
    for (const r of await tenantSelect<RowDataPacket>({ slug, table: "products", columns: "id, name", where: `id IN (${pp})`, params: pids }).catch(() => [] as RowDataPacket[])) productName.set(Number(r.id ?? 0), String(r.name ?? ""));
  }

  const itemsByPkg = new Map<number, string[]>();
  for (const r of itemRows) {
    const pid = Number(r.package_id ?? 0);
    const iid = Number(r.item_id ?? 0);
    const qty = Math.max(1, Number(r.qty ?? 1));
    const isProduct = String(r.item_type ?? "") === "product";
    const nm = (isProduct ? productName.get(iid) : serviceName.get(iid)) || `${isProduct ? "Prodotto" : "Servizio"} #${iid}`;
    const arr = itemsByPkg.get(pid) ?? [];
    arr.push(`${nm} ×${qty}`);
    itemsByPkg.set(pid, arr);
  }
  const svcByPkg = new Map<number, string[]>();
  for (const r of svcRows) {
    const pid = Number(r.package_id ?? 0);
    const sid = Number(r.service_id ?? 0);
    const sessions = Math.max(1, Number(r.sessions_total ?? 1));
    const nm = serviceName.get(sid) || `Servizio #${sid}`;
    const arr = svcByPkg.get(pid) ?? [];
    arr.push(`${nm} ×${sessions}`);
    svcByPkg.set(pid, arr);
  }

  // Enabled sedi label (package_locations join) + location names.
  const locRows = await tenantSelect<RowDataPacket>({ slug, table: "package_locations", columns: "package_id, location_id", where: `package_id IN (${ph})`, params: ids }).catch(() => [] as RowDataPacket[]);
  const locByPkg = new Map<number, number[]>();
  for (const r of locRows) {
    const pid = Number(r.package_id ?? 0);
    const lid = Number(r.location_id ?? 0);
    if (pid > 0 && lid > 0) { const arr = locByPkg.get(pid) ?? []; arr.push(lid); locByPkg.set(pid, arr); }
  }
  const locName = new Map<number, string>();
  for (const r of await tenantSelect<RowDataPacket>({ slug, table: "locations", columns: "id, name" }).catch(() => [] as RowDataPacket[])) locName.set(Number(r.id ?? 0), String(r.name ?? `Sede #${r.id}`));

  // Sold counts (client_packages per template).
  const soldRows = await tenantSelect<RowDataPacket>({ slug, table: "client_packages", columns: "package_id", where: `package_id IN (${ph})`, params: ids }).catch(() => [] as RowDataPacket[]);
  const soldByPkg = new Map<number, number>();
  for (const r of soldRows) { const pid = Number(r.package_id ?? 0); if (pid > 0) soldByPkg.set(pid, (soldByPkg.get(pid) ?? 0) + 1); }

  return rows.map((row) => {
    const id = Number(row.id ?? 0);
    const items = itemsByPkg.get(id);
    const svcs = svcByPkg.get(id);
    let contentsSummary = "—";
    if (items && items.length > 0) contentsSummary = items.join(", ");
    else if (svcs && svcs.length > 0) contentsSummary = svcs.join(", ");
    else { const sid = Number(row.service_id ?? 0); if (sid > 0) contentsSummary = serviceName.get(sid) || `Servizio #${sid}`; }
    const locIds = locByPkg.get(id) ?? [];
    const locationLabel = locIds.length === 0 ? "Tutte" : locIds.map((lid) => locName.get(lid) ?? `Sede #${lid}`).join(", ");
    const validity = Number(row.validity_days ?? 0);
    return {
      id,
      name: String(row.name ?? "Pacchetto"),
      isActive: Number(row.is_active ?? 1) === 1,
      contentsSummary,
      locationLabel,
      sessionsTotal: Math.max(0, Number(row.sessions_total ?? 0)),
      price: roundMoney(Number(row.price ?? 0)),
      validityDays: validity > 0 ? validity : null,
      soldCount: soldByPkg.get(id) ?? 0,
    };
  });
}

// Delete a catalog template (port of packages.php action=catalog_delete): detach
// referencing client_packages (SET package_id=NULL, keeping the package_name
// snapshot so the history survives), drop the template's package_services /
// package_items / package_pricing / package_locations, then the packages row.
export async function deleteManagePackageCatalog(slug: string, id: number): Promise<{ ok: true }> {
  if (id <= 0) throw new Error("Pacchetto catalogo non valido.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "packages", columns: "id", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Pacchetto catalogo non trovato.");
  await tenantExecuteByColumn(slug, "client_packages", "package_id", id, { package_id: null }).catch(() => undefined);
  for (const child of ["package_services", "package_items", "package_pricing", "package_locations"]) {
    await deletePackageChildRows(slug, child, id).catch(() => undefined);
  }
  await tenantDelete({ slug, table: "packages", id });
  return { ok: true };
}

// UPDATE <table> SET <values> WHERE <column>=<value> [AND tenant] — tenant-scoped.
async function tenantExecuteByColumn(slug: string, table: string, column: string, value: number, values: Record<string, unknown>): Promise<void> {
  const target = await tenantTable(slug, table).catch(() => null);
  if (!target) return;
  const entries = Object.entries(values);
  if (entries.length === 0) return;
  const assignments = entries.map(([k]) => `${quoteIdentifier(k)} = ?`).join(", ");
  const params: unknown[] = [...entries.map(([, v]) => v), value];
  const scoped = target.mode === "shared" && (await columnExists(target.name, "tenant_id"));
  let sql = `UPDATE ${quoteIdentifier(target.name)} SET ${assignments} WHERE ${quoteIdentifier(column)} = ?`;
  if (scoped) { sql += " AND tenant_id = ?"; params.push(target.tenantId ?? 0); }
  await dbExecute(sql, params);
}

// DELETE FROM <table> WHERE package_id=<id> [AND tenant] — tenant-scoped, guarded.
async function deletePackageChildRows(slug: string, table: string, packageId: number): Promise<void> {
  const target = await tenantTable(slug, table).catch(() => null);
  if (!target) return;
  const scoped = target.mode === "shared" && (await columnExists(target.name, "tenant_id"));
  await dbExecute(
    `DELETE FROM ${quoteIdentifier(target.name)} WHERE package_id = ?${scoped ? " AND tenant_id = ?" : ""}`,
    scoped ? [packageId, target.tenantId ?? 0] : [packageId],
  );
}

// ---- Package CATALOG editor (catalog_new / catalog_edit) ---------------------
export type PackageCatalogFormContext = {
  services: { id: number; name: string; price: number }[];
  products: { id: number; name: string; price: number; sku: string }[];
  locations: { id: number; name: string }[];
};

// Catalog editor context: the active services (+ list price) + active products
// (+ price/sku) selectable as package contents, and the active sedi.
export async function getPackageCatalogFormContext(slug: string): Promise<PackageCatalogFormContext> {
  const svcRows = await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "id, name, price", where: "COALESCE(is_active,1) = 1", orderBy: "name ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  const prodRows = await tenantSelect<RowDataPacket>({ slug, table: "products", columns: "id, name, price, sku", where: "COALESCE(is_active,1) = 1", orderBy: "name ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  const locRows = await tenantSelect<RowDataPacket>({ slug, table: "locations", columns: "id, name", where: "COALESCE(is_active,1) = 1", orderBy: "COALESCE(sort_order,999999) ASC, name ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  return {
    services: svcRows.map((r) => ({ id: Number(r.id ?? 0), name: String(r.name ?? ""), price: roundMoney(Number(r.price ?? 0)) })).filter((s) => s.id > 0),
    products: prodRows.map((r) => ({ id: Number(r.id ?? 0), name: String(r.name ?? ""), price: roundMoney(Number(r.price ?? 0)), sku: String(r.sku ?? "") })).filter((p) => p.id > 0),
    locations: locRows.map((r) => ({ id: Number(r.id ?? 0), name: String(r.name ?? `Sede #${r.id}`) })).filter((l) => l.id > 0),
  };
}

export type PackageCatalogEditItem = { itemType: "service" | "product"; itemId: number; qty: number; unitPrice: number; discountType: "percent" | "amount"; discountValue: number; lineTotal: number };
export type ManagePackageCatalogEdit = {
  id: number;
  name: string;
  description: string;
  validityDays: number | null;
  isActive: boolean;
  items: PackageCatalogEditItem[];
  totalDiscountType: "percent" | "amount";
  totalDiscountValue: number;
  locationIds: number[];
};

// Edit-form prefill (port of catalog_edit load): the template header + its
// package_items lines + package_pricing total discount + enabled sedi.
export async function getManagePackageCatalog(slug: string, id: number): Promise<ManagePackageCatalogEdit | null> {
  if (id <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "packages", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) return null;
  const row = rows[0];
  const itemRows = await tenantSelect<RowDataPacket>({ slug, table: "package_items", where: "package_id = ?", params: [id], orderBy: "sort_order ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  const items: PackageCatalogEditItem[] = itemRows
    .map((r) => {
      const itemType = String(r.item_type ?? "") === "product" ? "product" : "service";
      const dt = String(r.discount_type ?? "percent") === "amount" ? "amount" : "percent";
      return {
        itemType: itemType as "service" | "product",
        itemId: Number(r.item_id ?? 0),
        qty: Math.max(1, Number(r.qty ?? 1)),
        unitPrice: roundMoney(Number(r.unit_price ?? 0)),
        discountType: dt as "percent" | "amount",
        discountValue: roundMoney(Math.max(0, Number(r.discount_value ?? 0))),
        lineTotal: roundMoney(Number(r.line_total ?? 0)),
      };
    })
    .filter((it) => it.itemId > 0);
  const pricingRows = await tenantSelect<RowDataPacket>({ slug, table: "package_pricing", where: "package_id = ?", params: [id], limit: 1 }).catch(() => [] as RowDataPacket[]);
  const totalDiscountType = String(pricingRows[0]?.discount_type ?? "percent") === "amount" ? "amount" : "percent";
  const totalDiscountValue = roundMoney(Math.max(0, Number(pricingRows[0]?.discount_value ?? 0)));
  const locRows = await tenantSelect<RowDataPacket>({ slug, table: "package_locations", columns: "location_id", where: "package_id = ?", params: [id] }).catch(() => [] as RowDataPacket[]);
  const locationIds = locRows.map((r) => Number(r.location_id ?? 0)).filter((n) => n > 0);
  const validity = Number(row.validity_days ?? 0);
  return {
    id,
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    validityDays: validity > 0 ? validity : null,
    isActive: Number(row.is_active ?? 1) === 1,
    items,
    totalDiscountType,
    totalDiscountValue,
    locationIds,
  };
}

// Replace a package's enabled sedi (package_locations): clear then re-insert.
async function syncPackageLocations(slug: string, packageId: number, locationIds: number[]): Promise<void> {
  const table = await tenantTable(slug, "package_locations").catch(() => null);
  if (!table) return;
  await deletePackageChildRows(slug, "package_locations", packageId);
  for (const lid of locationIds) await tenantInsert(table, { package_id: packageId, location_id: lid }).catch(() => 0);
}

// Create / update a catalog template (port of packages.php catalog_new/catalog_edit).
// Parses the content lines (service/product with qty + list price + per-line
// discount) + the total discount, computes each line_total + the subtotal/total
// (the template price IS the computed total), aggregates services into
// package_services (sessions), and persists packages + package_services +
// package_items + package_pricing + package_locations. Requires a name, >=1 line,
// >=1 service, and (when sedi exist) >=1 sede.
export async function saveManagePackageCatalog(slug: string, body: Record<string, string>, id: number): Promise<{ id: number }> {
  const name = String(body.name ?? "").trim();
  if (name === "") throw new Error("Nome obbligatorio.");
  const description = String(body.description ?? "").trim();
  const validityRaw = Math.trunc(Number(body.validity_days ?? 0));
  const validityDays = validityRaw > 0 ? validityRaw : null;
  const isActive = String(body.is_active ?? "1") === "1" || String(body.is_active ?? "") === "true";

  // Content lines (nested → sent as a JSON string to survive parseRequestBody).
  let rawLines: unknown = body.items;
  if (typeof rawLines === "string") { try { rawLines = JSON.parse(rawLines); } catch { rawLines = []; } }
  const lineInputs = Array.isArray(rawLines) ? rawLines : [];
  const locationIds = parseCouponIdList(body.location_ids);

  let totalDiscountType = String(body.total_discount_type ?? "percent").toLowerCase();
  if (totalDiscountType !== "percent" && totalDiscountType !== "amount") totalDiscountType = "percent";
  const totalDiscountValue = Math.max(0, Number(String(body.total_discount_value ?? "0").replace(",", ".")) || 0);

  // Sede gate (when the tenant has active sedi).
  const activeLocs = await activeLocationIds(slug);
  if (activeLocs.length > 0 && locationIds.length === 0) throw new Error("Seleziona almeno una sede per il pacchetto.");

  // Resolve list prices for lines whose unit price is 0 (legacy $catalogItemPrice).
  const svcIds = new Set<number>();
  const prodIds = new Set<number>();
  for (const raw of lineInputs) {
    const it = raw as Record<string, unknown>;
    const iid = Math.trunc(Number(it.item_id ?? it.itemId ?? 0));
    if (iid <= 0) continue;
    if (String(it.item_type ?? it.itemType ?? "service") === "product") prodIds.add(iid);
    else svcIds.add(iid);
  }
  const svcPrice = new Map<number, number>();
  const prodPrice = new Map<number, number>();
  if (svcIds.size > 0) {
    const ids = Array.from(svcIds);
    const ph = ids.map(() => "?").join(",");
    for (const r of await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "id, price", where: `id IN (${ph})`, params: ids }).catch(() => [] as RowDataPacket[])) svcPrice.set(Number(r.id ?? 0), Number(r.price ?? 0));
  }
  if (prodIds.size > 0) {
    const ids = Array.from(prodIds);
    const ph = ids.map(() => "?").join(",");
    for (const r of await tenantSelect<RowDataPacket>({ slug, table: "products", columns: "id, price", where: `id IN (${ph})`, params: ids }).catch(() => [] as RowDataPacket[])) prodPrice.set(Number(r.id ?? 0), Number(r.price ?? 0));
  }

  const lines: Array<{ item_type: string; item_id: number; qty: number; unit_price: number; discount_type: string; discount_value: number; line_total: number; sort_order: number }> = [];
  const byService = new Map<number, { sessions: number; order: number }>();
  let hasService = false;
  for (const raw of lineInputs) {
    const it = raw as Record<string, unknown>;
    const type = String(it.item_type ?? it.itemType ?? "service") === "product" ? "product" : "service";
    const itemId = Math.trunc(Number(it.item_id ?? it.itemId ?? 0));
    if (itemId <= 0) continue;
    let qty = Math.trunc(Number(it.qty ?? 1));
    if (qty <= 0) qty = 1;
    let unitPrice = Number(it.unit_price ?? it.unitPrice ?? 0);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) unitPrice = 0;
    if (unitPrice === 0) unitPrice = type === "product" ? (prodPrice.get(itemId) ?? 0) : (svcPrice.get(itemId) ?? 0);
    let discType = String(it.discount_type ?? it.discountType ?? "percent").toLowerCase();
    if (discType !== "percent" && discType !== "amount") discType = "percent";
    let discValue = Number(it.discount_value ?? it.discountValue ?? 0);
    if (!Number.isFinite(discValue) || discValue < 0) discValue = 0;
    const lineSubtotal = qty * unitPrice;
    let discountAmt = discType === "percent" ? lineSubtotal * (discValue / 100) : discValue;
    discountAmt = Math.min(Math.max(0, discountAmt), lineSubtotal);
    const lineTotal = roundMoney(lineSubtotal - discountAmt);
    lines.push({ item_type: type, item_id: itemId, qty, unit_price: roundMoney(unitPrice), discount_type: discType, discount_value: roundMoney(discValue), line_total: lineTotal, sort_order: lines.length });
    if (type === "service") {
      hasService = true;
      const entry = byService.get(itemId) ?? { sessions: 0, order: lines.length };
      entry.sessions += qty;
      byService.set(itemId, entry);
    }
  }
  if (lines.length === 0) throw new Error("Aggiungi almeno un servizio/prodotto al pacchetto.");
  if (!hasService) throw new Error("Per creare un pacchetto è necessario almeno un servizio (sedute).");

  const svcItems = Array.from(byService.entries())
    .sort((a, b) => a[1].order - b[1].order)
    .map(([serviceId, v], idx) => ({ serviceId, sessions: Math.max(1, v.sessions), sortOrder: idx }));
  const serviceId = svcItems.length === 1 ? svcItems[0].serviceId : null;
  const sessionsTotal = Math.max(1, svcItems.reduce((sum, s) => sum + s.sessions, 0));

  const subtotal = roundMoney(lines.reduce((sum, l) => sum + l.line_total, 0));
  let totalDiscountAmt = totalDiscountType === "percent" ? subtotal * (totalDiscountValue / 100) : totalDiscountValue;
  totalDiscountAmt = Math.min(Math.max(0, totalDiscountAmt), subtotal);
  const total = roundMoney(subtotal - totalDiscountAmt);
  const price = total;

  const header = { name, description: description !== "" ? description : null, service_id: serviceId, sessions_total: sessionsTotal, price, validity_days: validityDays, is_active: isActive ? 1 : 0 };

  let packageId = id;
  if (packageId > 0) {
    const existing = await tenantSelect<RowDataPacket>({ slug, table: "packages", columns: "id", where: "id = ?", params: [packageId], limit: 1 });
    if (!existing[0]) throw new Error("Pacchetto catalogo non trovato.");
    await tenantUpdate({ slug, table: "packages", id: packageId, values: header });
  } else {
    packageId = await tenantInsert(await tenantTable(slug, "packages"), header);
  }

  // Rebuild package_services + package_items + package_pricing + package_locations.
  await deletePackageChildRows(slug, "package_services", packageId).catch(() => undefined);
  const svcTable = await tenantTable(slug, "package_services");
  for (const s of svcItems) await tenantInsert(svcTable, { package_id: packageId, service_id: s.serviceId, sessions_total: s.sessions, sort_order: s.sortOrder }).catch(() => 0);

  await deletePackageChildRows(slug, "package_items", packageId).catch(() => undefined);
  const itemTable = await tenantTable(slug, "package_items");
  for (const l of lines) await tenantInsert(itemTable, { package_id: packageId, item_type: l.item_type, item_id: l.item_id, qty: l.qty, unit_price: l.unit_price, discount_type: l.discount_type, discount_value: l.discount_value, line_total: l.line_total, sort_order: l.sort_order }).catch(() => 0);

  await deletePackageChildRows(slug, "package_pricing", packageId).catch(() => undefined);
  await tenantInsert(await tenantTable(slug, "package_pricing"), { package_id: packageId, subtotal, discount_type: totalDiscountType, discount_value: roundMoney(totalDiscountValue), total }).catch(() => 0);

  await syncPackageLocations(slug, packageId, locationIds);

  return { id: packageId };
}

// ---- Client package DETAIL (packages.php action=client_view) ------------------
export type ClientPackageContent = { id: number; serviceId: number; serviceName: string; sessionsTotal: number; sessionsRemaining: number };
export type ClientPackageUsage = { id: number; usedAt: string; delta: number; note: string; itemType: string; itemName: string; appointmentCode: string };
export type ManageClientPackageDetail = {
  id: number;
  clientId: number;
  clientName: string;
  packageName: string;
  serviceName: string;
  sessionsTotal: number;
  sessionsRemaining: number;
  status: string;
  statusLabel: string;
  statusBadge: string;
  purchaseDate: string;
  startDate: string;
  expiresAt: string;
  saleId: number | null;
  contents: ClientPackageContent[];
  usages: ClientPackageUsage[];
  canEditExpiry: boolean;
};

function clientPackageStatusMeta(stored: string, remaining: number, expiresAt: string): { key: string; label: string; badge: string } {
  const s = String(stored ?? "").trim().toLowerCase();
  if (s === "canceled" || s === "cancelled") return { key: "cancelled", label: "Annullato", badge: "bg-danger" };
  if (remaining <= 0) return { key: "completed", label: "Completato", badge: "bg-secondary" };
  const exp = String(expiresAt ?? "").slice(0, 10);
  if (exp !== "" && exp < todayIso()) return { key: "expired", label: "Scaduto", badge: "bg-warning text-dark" };
  return { key: "active", label: "Attivo", badge: "bg-success" };
}

// Full client-package DETAIL (port of packages.php action=client_view): the
// header (client/package/sessions/expiry/status/sale link), the per-service
// contents (client_package_services, sessions total/remaining — the aggregate
// sessions are re-derived from these), and the usage history
// (client_package_usages). Read-only; expiry edit is a separate action.
export async function getManageClientPackage(slug: string, id: number): Promise<ManageClientPackageDetail | null> {
  if (id <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "client_packages", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) return null;
  const cp = rows[0];

  const clientId = Number(cp.client_id ?? 0);
  let clientName = "";
  if (clientId > 0) {
    const cRows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "full_name", where: "id = ?", params: [clientId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    clientName = String(cRows[0]?.full_name ?? "");
  }
  const serviceName = await serviceNameById(slug, Number(cp.service_id ?? 0), "");

  // Per-service contents.
  const cpsRows = await tenantSelect<RowDataPacket>({ slug, table: "client_package_services", where: "client_package_id = ?", params: [id], orderBy: "sort_order ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  const contents: ClientPackageContent[] = [];
  let sumTotal = 0;
  let sumRemaining = 0;
  for (const r of cpsRows) {
    const sid = Number(r.service_id ?? 0);
    const total = Math.max(0, Number(r.sessions_total ?? 0));
    const remaining = Math.max(0, Number(r.sessions_remaining ?? 0));
    sumTotal += total;
    sumRemaining += remaining;
    contents.push({ id: Number(r.id ?? 0), serviceId: sid, serviceName: snapshotServiceName(r.service_snapshot_json) || (await serviceNameById(slug, sid, `Servizio #${sid}`)), sessionsTotal: total, sessionsRemaining: remaining });
  }
  const sessionsTotal = sumTotal > 0 ? sumTotal : Math.max(0, Number(cp.sessions_total ?? 0));
  const sessionsRemaining = sumTotal > 0 ? sumRemaining : Math.max(0, Number(cp.sessions_remaining ?? 0));

  // Usage history (client_package_usages), newest first.
  const usageRows = await tenantSelect<RowDataPacket>({ slug, table: "client_package_usages", where: "client_package_id = ?", params: [id], orderBy: "used_at DESC, id DESC", limit: 100 }).catch(() => [] as RowDataPacket[]);
  const usages: ClientPackageUsage[] = [];
  for (const r of usageRows) {
    const itemType = String(r.item_type ?? "") || (r.service_id ? "service" : "");
    const itemId = Number(r.item_id ?? r.service_id ?? 0);
    let itemName = "";
    if (itemType === "product" && itemId > 0) {
      const pr = await tenantSelect<RowDataPacket>({ slug, table: "products", columns: "name", where: "id = ?", params: [itemId], limit: 1 }).catch(() => [] as RowDataPacket[]);
      itemName = String(pr[0]?.name ?? `Prodotto #${itemId}`);
    } else if (itemId > 0) {
      itemName = await serviceNameById(slug, itemId, `Servizio #${itemId}`);
    }
    let appointmentCode = "";
    const apptId = Number(r.appointment_id ?? 0);
    if (apptId > 0) {
      const ap = await tenantSelect<RowDataPacket>({ slug, table: "appointments", columns: "public_code", where: "id = ?", params: [apptId], limit: 1 }).catch(() => [] as RowDataPacket[]);
      appointmentCode = String(ap[0]?.public_code ?? "");
    }
    usages.push({ id: Number(r.id ?? 0), usedAt: toIso(r.used_at ?? r.created_at), delta: Number(r.delta ?? 0), note: String(r.note ?? ""), itemType, itemName, appointmentCode });
  }

  const meta = clientPackageStatusMeta(String(cp.status ?? "active"), sessionsRemaining, String(cp.expires_at ?? ""));
  // Expiry is editable only when the package is not cancelled and untouched
  // (no consumption yet), mirroring updateClientPackageExpiry's guards.
  const canEditExpiry = meta.key !== "cancelled" && sessionsRemaining === sessionsTotal && usages.length === 0;

  return {
    id,
    clientId,
    clientName,
    packageName: String(cp.package_name ?? ""),
    serviceName,
    sessionsTotal,
    sessionsRemaining,
    status: meta.key,
    statusLabel: meta.label,
    statusBadge: meta.badge,
    purchaseDate: cp.purchase_date ? toIso(cp.purchase_date) : "",
    startDate: cp.start_date ? toIso(cp.start_date) : "",
    expiresAt: cp.expires_at ? String(cp.expires_at).slice(0, 10) : "",
    saleId: Number(cp.sale_id ?? 0) || null,
    contents,
    usages,
    canEditExpiry,
  };
}

// Update a client package's expiry (port of ClientPackages::updateClientPackageExpiry):
// requires a valid date not before today / the package start, refuses a cancelled or
// already-used package, then writes expires_at + recomputes status.
export async function updateManageClientPackageExpiry(slug: string, id: number, expiresAt: string): Promise<{ ok: true }> {
  if (id <= 0) throw new Error("Pacchetto non valido.");
  const requested = String(expiresAt ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) throw new Error("Seleziona una nuova data di scadenza valida.");
  const today = todayIso();
  if (requested < today) throw new Error("La nuova data di scadenza non può essere precedente a oggi.");

  const rows = await tenantSelect<RowDataPacket>({ slug, table: "client_packages", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Pacchetto cliente non trovato.");
  const cp = rows[0];
  const stored = String(cp.status ?? "active").trim().toLowerCase();
  if (stored === "canceled" || stored === "cancelled") throw new Error("Non è possibile modificare la scadenza di un pacchetto annullato.");

  // Already-used guard: any consumption (remaining < total) or a usage row.
  const sumRows = await tenantSelect<RowDataPacket>({ slug, table: "client_package_services", columns: "sessions_total, sessions_remaining", where: "client_package_id = ?", params: [id] }).catch(() => [] as RowDataPacket[]);
  let sumTotal = 0;
  let sumRemaining = 0;
  for (const r of sumRows) { sumTotal += Number(r.sessions_total ?? 0); sumRemaining += Number(r.sessions_remaining ?? 0); }
  const total = sumTotal > 0 ? sumTotal : Number(cp.sessions_total ?? 0);
  const remaining = sumTotal > 0 ? sumRemaining : Number(cp.sessions_remaining ?? 0);
  const usageCount = (await tenantSelect<RowDataPacket>({ slug, table: "client_package_usages", columns: "id", where: "client_package_id = ?", params: [id], limit: 1 }).catch(() => [] as RowDataPacket[])).length;
  if (remaining !== total || usageCount > 0) throw new Error("Non è possibile modificare la scadenza di un pacchetto già utilizzato.");

  const startYmd = cp.start_date ? String(cp.start_date).slice(0, 10) : "";
  if (startYmd !== "" && requested < startYmd) throw new Error("La nuova data di scadenza non può essere precedente all'inizio del pacchetto.");

  // Recompute status from the new expiry (active/expired), preserving cancelled/completed.
  let newStatus = stored;
  if (stored !== "completed" && remaining > 0) newStatus = requested < today ? "expired" : "active";
  await tenantUpdate({ slug, table: "client_packages", id, values: { expires_at: requested, status: newStatus } });
  return { ok: true };
}

// Recompute a client package's stored status from remaining + expiry (port of
// pkg_status_calc), preserving cancelled/completed.
function recomputeClientPackageStatus(stored: string, remaining: number, expiresAt: string): string {
  const s = String(stored ?? "").trim().toLowerCase();
  if (s === "canceled" || s === "cancelled") return s;
  if (remaining <= 0) return "completed";
  const exp = String(expiresAt ?? "").slice(0, 10);
  if (exp !== "" && exp < todayIso()) return "expired";
  return "active";
}

// Register a manual usage movement on a client package (port of packages.php
// action=usage_add, SERVICE path): op 'consume'|'restore' × qty, on a specific
// service (required when the package is multi-service, else the first/only one).
// Consume can't exceed the remaining sedute; restore can't exceed the total.
// Refuses on a cancelled package, and consume on an expired one. Writes the
// client_package_usages row (delta<0 consume / >0 restore) + syncs
// client_package_services + the client_packages aggregate + status. The
// product ritira/ripristina (stock-linked) path is intentionally not ported
// here — it belongs with the warehouse stock-doc subsystem.
export async function addManageClientPackageUsage(
  slug: string,
  id: number,
  op: string,
  qty: number,
  serviceId: number,
  note: string,
  by: number,
): Promise<{ ok: true }> {
  if (id <= 0) throw new Error("Pacchetto non valido.");
  const mode = String(op ?? "").trim().toLowerCase();
  if (mode !== "consume" && mode !== "restore") throw new Error("Operazione non valida.");
  const q = Math.trunc(Number(qty));
  if (!Number.isFinite(q) || q <= 0 || q > 10000) throw new Error("Quantità non valida.");
  const delta = mode === "restore" ? Math.abs(q) : -Math.abs(q);

  const rows = await tenantSelect<RowDataPacket>({ slug, table: "client_packages", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Pacchetto non trovato.");
  const cp = rows[0];
  const stored = String(cp.status ?? "active").trim().toLowerCase();
  if (stored === "canceled" || stored === "cancelled") throw new Error("Pacchetto annullato: non puoi registrare sedute o ritiri.");
  const expiresAt = String(cp.expires_at ?? "");
  const isExpired = recomputeClientPackageStatus(stored, Math.max(0, Number(cp.sessions_remaining ?? 0)), expiresAt) === "expired";
  if (isExpired && delta < 0) throw new Error("Pacchetto scaduto: non puoi scalare sedute o ritiri. Puoi aggiornare la scadenza o registrare un ripristino.");

  const usageTable = await tenantTable(slug, "client_package_usages");
  const cpsRows = await tenantSelect<RowDataPacket>({ slug, table: "client_package_services", where: "client_package_id = ?", params: [id], orderBy: "sort_order ASC, id ASC" }).catch(() => [] as RowDataPacket[]);

  if (cpsRows.length > 0) {
    const isMulti = cpsRows.length > 1;
    let targetServiceId = serviceId;
    if (isMulti && targetServiceId <= 0) throw new Error("Seleziona il servizio da scalare.");
    if (targetServiceId <= 0) targetServiceId = Number(cpsRows[0].service_id ?? 0);
    const target = cpsRows.find((r) => Number(r.service_id ?? 0) === targetServiceId);
    if (!target) throw new Error("Servizio non incluso in questo pacchetto.");

    const remaining = Math.max(0, Number(target.sessions_remaining ?? 0));
    const total = Math.max(0, Number(target.sessions_total ?? 0));
    const newRemaining = remaining + delta;
    if (delta < 0 && Math.abs(delta) > remaining) throw new Error("Sedute insufficienti per il servizio selezionato.");
    if (newRemaining > total) throw new Error("Superi le sedute totali del servizio selezionato.");

    await tenantUpdate({ slug, table: "client_package_services", id: Number(target.id ?? 0), values: { sessions_remaining: newRemaining } });

    let sumTotal = 0;
    let sumRemaining = 0;
    for (const r of cpsRows) {
      sumTotal += Number(r.sessions_total ?? 0);
      sumRemaining += Number(r.id ?? 0) === Number(target.id ?? 0) ? newRemaining : Number(r.sessions_remaining ?? 0);
    }
    if (sumTotal <= 0) sumTotal = Math.max(1, Number(cp.sessions_total ?? 1));

    await tenantInsert(usageTable, { client_package_id: id, service_id: targetServiceId, item_type: "service", item_id: targetServiceId, used_at: new Date(), delta, note: note.trim() !== "" ? note.trim() : null, created_by: by > 0 ? by : null }).catch(() => 0);
    const newStatus = recomputeClientPackageStatus(stored, sumRemaining, expiresAt);
    await tenantUpdate({ slug, table: "client_packages", id, values: { sessions_total: sumTotal, sessions_remaining: sumRemaining, status: newStatus } });
    return { ok: true };
  }

  // Fallback: no per-service rows — operate on the client_packages aggregate.
  const remaining = Math.max(0, Number(cp.sessions_remaining ?? 0));
  const total = Math.max(0, Number(cp.sessions_total ?? 0));
  const newRemaining = remaining + delta;
  if (delta < 0 && Math.abs(delta) > remaining) throw new Error("Sedute insufficienti.");
  if (newRemaining > total) throw new Error("Superi le sedute totali: aumenta prima le sedute totali.");
  const sid = Number(cp.service_id ?? 0);
  await tenantInsert(usageTable, { client_package_id: id, service_id: sid > 0 ? sid : null, item_type: sid > 0 ? "service" : null, item_id: sid > 0 ? sid : null, used_at: new Date(), delta, note: note.trim() !== "" ? note.trim() : null, created_by: by > 0 ? by : null }).catch(() => 0);
  const newStatus = recomputeClientPackageStatus(stored, newRemaining, expiresAt);
  await tenantUpdate({ slug, table: "client_packages", id, values: { sessions_remaining: newRemaining, status: newStatus } });
  return { ok: true };
}

export async function issueDbClientPackage(
  input: { packageId?: number; clientId?: number; clientName?: string; expiresAt?: string; sourceSaleId?: number },
  slug: string,
): Promise<ClientPackage> {
  const catalogRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "packages",
    where: input.packageId && input.packageId > 0 ? "id = ? AND COALESCE(is_active, 1) = 1" : "COALESCE(is_active, 1) = 1",
    params: input.packageId && input.packageId > 0 ? [input.packageId] : [],
    orderBy: "id ASC",
    limit: 1,
  });
  if (!catalogRows[0]) throw new Error("Pacchetto non trovato.");

  const catalog = await mapPackageCatalog(slug, catalogRows[0]);
  const client = await resolveSaleClientForDb(slug, input.clientId ?? 0, input.clientName);
  const totalSessions = Math.max(1, catalog.items.reduce((total, item) => total + item.sessions, 0) || Number(catalogRows[0].sessions_total ?? 1));
  const expiresAt = input.expiresAt ?? addDaysDate(Number(catalogRows[0].validity_days ?? 180) || 180);
  const id = await tenantInsert(await tenantTable(slug, "client_packages"), {
    client_id: client.id,
    package_id: catalog.id,
    package_name: catalog.name,
    service_id: Number(catalogRows[0].service_id ?? 0) || null,
    purchase_date: todayIso(),
    start_date: todayIso(),
    expires_at: expiresAt,
    sessions_total: totalSessions,
    sessions_remaining: totalSessions,
    status: "active",
    sale_id: input.sourceSaleId && input.sourceSaleId > 0 ? input.sourceSaleId : null,
  });
  await insertClientPackageItemsFromCatalog(slug, id, catalog);

  return getSingleClientPackage(slug, id);
}

export async function consumeDbClientPackage(id: number, sessions: number, slug: string): Promise<ClientPackage> {
  const current = await getSingleClientPackage(slug, id);
  if (current.status !== "active") throw new Error("Pacchetto non utilizzabile.");
  const quantity = Math.max(1, Math.round(sessions));
  if (current.remainingSessions < quantity) throw new Error("Sedute pacchetto insufficienti.");
  const remaining = current.remainingSessions - quantity;
  await tenantUpdate({
    slug,
    table: "client_packages",
    id,
    values: { sessions_remaining: remaining, status: remaining <= 0 ? "completed" : "active" },
  });
  await tryInsertPackageUsage(slug, id, -quantity, "Consumo manuale pacchetto");
  return getSingleClientPackage(slug, id);
}

// One entry from the quick-booking `package_redeem` JSON array (assets/js/app.js
// qbReadPackageRedeem): apply a client's prepaid package to a service so that
// service is covered (a session is consumed, no charge). `clientPackageServiceId`
// is optional — it pins the exact `client_package_services` row when sent.
export type AppointmentPackageRedeem = {
  clientPackageId: number;
  serviceId: number;
  clientPackageServiceId?: number | null;
};

// Apply the quick-booking PACKAGE redeems for an appointment AS PART of the save.
// For each requested redeem this RE-VALIDATES server-side (never trusting the
// client): the package belongs to the appointment's client, is active + not
// expired, has sessions_remaining > 0, and COVERS the service (a
// client_package_services row for that service with its own sessions_remaining,
// or the legacy single client_packages.service_id). On success it consumes ONE
// session — decrementing the per-service `client_package_services` pool (when
// present) AND the package-level `client_packages` pool via consumeDbClientPackage
// (which flips status to 'completed' at 0 and writes the usage ledger) — and links
// the matching appointment_services row (client_package_id /
// client_package_service_id) while zeroing its charge (price 0, list_price kept,
// 'Pacchetto' badge). A redeem that fails validation is SKIPPED (collected as a
// warning) and never fails the whole booking; the non-redeem path is untouched.
//
// Faithful to api_appointments.php + ClientPackages.php (saveAppointmentSelection
// validation + redeemAppointmentSelectionIfAny consumption), adapted to the Next
// port's instruction to link on the appointment_services row and consume at save
// time. TODO(parity): the legacy RESERVES on save and only consumes on status
// 'done' (with reservation conflict checks across other active bookings) and
// rolls back on cancel; here we consume immediately on save and do not reconcile
// on later status changes.
export async function applyAppointmentPackageRedeems({
  slug,
  appointmentId,
  clientId,
  serviceIds,
  redeems,
}: {
  slug: string;
  appointmentId: number;
  clientId: number;
  serviceIds: number[]; // service_ids actually on this appointment (the redeem is filtered to these)
  redeems: AppointmentPackageRedeem[];
}): Promise<{ applied: AppointmentPackageRedeem[]; warnings: string[] }> {
  const applied: AppointmentPackageRedeem[] = [];
  const warnings: string[] = [];
  if (!redeems.length) return { applied, warnings };

  // Only the appointment_services snapshot table can carry the linkage; if it
  // lacks the package columns (older installs) we still consume + log a warning.
  const servicesTable = await tenantTable(slug, "appointment_services").catch(() => null);
  const hasLinkColumns = servicesTable
    ? (await columnExists(servicesTable.name, "client_package_id")) &&
      (await columnExists(servicesTable.name, "client_package_service_id"))
    : false;

  // Drop redeems for services not on this appointment, and dedupe so a service is
  // covered by at most ONE package (first wins) — mirrors the legacy per-service
  // selection map (qb_filter_selection_by_current_services + bySvc map).
  const onAppointment = new Set(serviceIds.filter((id) => id > 0));
  const seenService = new Set<number>();

  for (const redeem of redeems) {
    const clientPackageId = Number(redeem.clientPackageId ?? 0);
    const serviceId = Number(redeem.serviceId ?? 0);
    if (clientPackageId <= 0 || serviceId <= 0) continue;
    if (!onAppointment.has(serviceId)) continue; // service not on the appointment
    if (seenService.has(serviceId)) continue; // already covered by another package
    seenService.add(serviceId);

    try {
      // 1) Load the package, tenant-scoped (tenantSelect scopes to the tenant).
      const packageRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "client_packages",
        columns: "id, client_id, package_name, status, expires_at, sessions_remaining, service_id",
        where: "id = ?",
        params: [clientPackageId],
        limit: 1,
      });
      const pkg = packageRows[0];
      if (!pkg) {
        warnings.push("Pacchetto non trovato.");
        continue;
      }

      // 2) Ownership: the package must belong to the appointment's client.
      if (Number(pkg.client_id ?? 0) !== clientId) {
        warnings.push("Il pacchetto selezionato non appartiene al cliente.");
        continue;
      }

      // 3) Active + not expired + remaining > 0 (effective status, like pkgStatusCalc).
      const remaining = Math.max(0, Number(pkg.sessions_remaining ?? 0));
      const expiresYmd = pkg.expires_at ? String(pkg.expires_at).slice(0, 10) : "";
      const effectiveStatus = clientPackageStatus(String(pkg.status ?? "active"), remaining, expiresYmd);
      if (effectiveStatus !== "active") {
        warnings.push(`Pacchetto ${String(pkg.package_name ?? "")} non utilizzabile (${effectiveStatus}).`.trim());
        continue;
      }
      if (remaining <= 0) {
        warnings.push("Sedute pacchetto esaurite.");
        continue;
      }

      // 4) Coverage: prefer a per-service client_package_services row (with its own
      //    sessions_remaining > 0); fall back to the legacy single service_id.
      let coverageRowId: number | null = null;
      let coverageRemaining: number | null = null;
      let hasAnyCoverageRows = false;
      try {
        const coverageRows = await tenantSelect<RowDataPacket>({
          slug,
          table: "client_package_services",
          columns: "id, sessions_remaining",
          where: "client_package_id = ? AND service_id = ?",
          params: [clientPackageId, serviceId],
          orderBy: "sort_order ASC, id ASC",
          limit: 1,
        });
        if (coverageRows[0]) {
          coverageRowId = Number(coverageRows[0].id ?? 0) || null;
          coverageRemaining = Math.max(0, Number(coverageRows[0].sessions_remaining ?? 0));
        }
        // Does this package have ANY per-service rows at all?
        const anyRows = await tenantSelect<RowDataPacket>({
          slug,
          table: "client_package_services",
          columns: "id",
          where: "client_package_id = ?",
          params: [clientPackageId],
          limit: 1,
        });
        hasAnyCoverageRows = anyRows.length > 0;
      } catch {
        // table absent -> treat as legacy single-service package
      }

      if (coverageRowId === null) {
        if (hasAnyCoverageRows) {
          // Package is multi-service but does not include this service -> not covered.
          warnings.push("Servizio non incluso nel pacchetto selezionato.");
          continue;
        }
        // Legacy single-service package: the cp.service_id must match (when set).
        const legacyServiceId = Number(pkg.service_id ?? 0);
        if (legacyServiceId > 0 && legacyServiceId !== serviceId) {
          warnings.push("Servizio non incluso nel pacchetto selezionato.");
          continue;
        }
      } else if (coverageRemaining !== null && coverageRemaining <= 0) {
        // Per-service pool exhausted even though the package-level pool is not.
        warnings.push("Sedute pacchetto esaurite per il servizio selezionato.");
        continue;
      }

      // 5) Consume ONE session. Decrement the AUTHORITATIVE package-level pool FIRST
      //    via consumeDbClientPackage (it re-reads remaining and THROWS on
      //    insufficient sessions + flips status to 'completed' at 0 + writes the
      //    usage ledger) — so we never over-consume, and a failure here leaves the
      //    per-service pool untouched. Then mirror the decrement on the per-service
      //    client_package_services row, keeping package.remaining == SUM(cps.remaining)
      //    (the legacy recomputes the package total from the cps rows after redeem).
      await consumeDbClientPackage(clientPackageId, 1, slug);
      if (coverageRowId !== null && coverageRemaining !== null) {
        await tenantUpdate({
          slug,
          table: "client_package_services",
          id: coverageRowId,
          values: { sessions_remaining: Math.max(0, coverageRemaining - 1) },
        });
      }

      // 6) Link the appointment_services row + zero its charge (keep list_price).
      if (hasLinkColumns && servicesTable) {
        await updateAppointmentServicePackageLink(slug, servicesTable, appointmentId, serviceId, {
          clientPackageId,
          clientPackageServiceId: coverageRowId ?? redeem.clientPackageServiceId ?? null,
        });
      } else {
        warnings.push("Sessione pacchetto consumata, ma il collegamento al servizio non è disponibile su questo archivio.");
      }

      applied.push({ clientPackageId, serviceId, clientPackageServiceId: coverageRowId ?? null });
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Errore riscatto pacchetto.");
    }
  }

  return { applied, warnings };
}

// Set the package linkage on a single appointment_services row (keyed by the
// composite appointment_id + service_id — the table has no surrogate id) and zero
// its charge: price 0, list_price preserved as the catalog reference, and a
// 'Pacchetto' discount_badge (faithful to the legacy zero-charge presentation).
async function updateAppointmentServicePackageLink(
  slug: string,
  table: TenantTable,
  appointmentId: number,
  serviceId: number,
  link: { clientPackageId: number; clientPackageServiceId: number | null },
): Promise<void> {
  const assignments: string[] = [
    "client_package_id = ?",
    "client_package_service_id = ?",
    "price = 0",
  ];
  const params: unknown[] = [link.clientPackageId, link.clientPackageServiceId];
  if (await columnExists(table.name, "discount_badge")) assignments.push("discount_badge = 'Pacchetto'");
  const clauses = ["appointment_id = ?", "service_id = ?"];
  params.push(appointmentId, serviceId);
  if (table.mode === "shared" && (await columnExists(table.name, "tenant_id"))) {
    clauses.push("tenant_id = ?");
    params.push(table.tenantId ?? 0);
  }
  await dbExecute(
    `UPDATE ${quoteIdentifier(table.name)} SET ${assignments.join(", ")} WHERE ${clauses.join(" AND ")}`,
    params,
  );
}

// One entry from the quick-booking `prepaid_service_redeem` JSON array (assets/js/
// app.js qbReadPrepaidServiceRedeem): apply a client's prepaid-service balance to a
// service so that service is covered (one unit is consumed, no charge). A prepaid is
// tied to ONE service directly (client_prepaid_services.service_id), so there is no
// separate coverage row — the prepaid's service_id must equal the redeemed service.
export type AppointmentPrepaidRedeem = {
  clientPrepaidServiceId: number;
  serviceId: number;
};

// Apply the quick-booking PREPAID-SERVICE redeems for an appointment AS PART of the
// save. For each requested redeem this RE-VALIDATES server-side (never trusting the
// client): the prepaid exists, belongs to the appointment's client, is active + not
// expired, has remaining_qty > 0, and its service_id == the redeemed service (which
// must be on the appointment). On success it consumes ONE unit via consumeDbPrepaid
// (which re-reads remaining and THROWS on insufficient balance + flips status to
// 'completed' at 0 + writes the client_prepaid_service_usages ledger) and links the
// matching appointment_services row (client_prepaid_service_id) while zeroing its
// charge (price 0, list_price kept, 'Prepagato' badge). A redeem that fails
// validation is SKIPPED (collected as a warning) and never fails the whole booking.
//
// `coveredServiceIds` are the services already covered by a PACKAGE redeem in this
// same save — those are skipped so a service is covered at most once (dedupe). Like
// the package apply, we additionally dedupe so a service is prepaid-covered by at
// most one prepaid (first wins). Faithful to api_appointments.php +
// ClientPrepaidServices.php (saveAppointmentSelection validation +
// consume-on-save), adapted to the Next port's link-on-appointment_services_row.
export async function applyAppointmentPrepaidRedeems({
  slug,
  appointmentId,
  clientId,
  serviceIds,
  redeems,
  coveredServiceIds,
}: {
  slug: string;
  appointmentId: number;
  clientId: number;
  serviceIds: number[]; // service_ids actually on this appointment (the redeem is filtered to these)
  redeems: AppointmentPrepaidRedeem[];
  coveredServiceIds?: Set<number>; // services already covered by a package redeem (skip)
}): Promise<{ applied: AppointmentPrepaidRedeem[]; warnings: string[] }> {
  const applied: AppointmentPrepaidRedeem[] = [];
  const warnings: string[] = [];
  if (!redeems.length) return { applied, warnings };

  // Only the appointment_services snapshot table can carry the linkage; if it lacks
  // the prepaid column (older installs) we still consume + log a warning.
  const servicesTable = await tenantTable(slug, "appointment_services").catch(() => null);
  const hasLinkColumn = servicesTable
    ? await columnExists(servicesTable.name, "client_prepaid_service_id")
    : false;

  // Drop redeems for services not on this appointment, those a package already
  // covers, and dedupe so a service is covered by at most ONE prepaid (first wins).
  const onAppointment = new Set(serviceIds.filter((id) => id > 0));
  const seenService = new Set<number>();

  for (const redeem of redeems) {
    const clientPrepaidServiceId = Number(redeem.clientPrepaidServiceId ?? 0);
    const serviceId = Number(redeem.serviceId ?? 0);
    if (clientPrepaidServiceId <= 0 || serviceId <= 0) continue;
    if (!onAppointment.has(serviceId)) continue; // service not on the appointment
    if (coveredServiceIds?.has(serviceId)) continue; // already covered by a package
    if (seenService.has(serviceId)) continue; // already covered by another prepaid
    seenService.add(serviceId);

    try {
      // 1) Load the prepaid, tenant-scoped (tenantSelect scopes to the tenant).
      const prepaidRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "client_prepaid_services",
        columns: "id, client_id, service_id, service_name, status, expires_at, remaining_qty",
        where: "id = ?",
        params: [clientPrepaidServiceId],
        limit: 1,
      });
      const prepaid = prepaidRows[0];
      if (!prepaid) {
        warnings.push("Prepagato non trovato.");
        continue;
      }

      // 2) Ownership: the prepaid must belong to the appointment's client.
      if (Number(prepaid.client_id ?? 0) !== clientId) {
        warnings.push("Il prepagato selezionato non appartiene al cliente.");
        continue;
      }

      // 3) Coverage: a prepaid covers exactly its own service_id (no coverage table).
      if (Number(prepaid.service_id ?? 0) !== serviceId) {
        warnings.push("Il prepagato selezionato non copre il servizio.");
        continue;
      }

      // 4) Active + not expired + remaining > 0 (effective status, like the legacy
      //    availability rule status='active' AND remaining_qty>0 AND not expired).
      const remaining = Math.max(0, Number(prepaid.remaining_qty ?? 0));
      const expiresYmd = prepaid.expires_at ? String(prepaid.expires_at).slice(0, 10) : "";
      const effectiveStatus = clientPrepaidStatus(String(prepaid.status ?? "active"), remaining, expiresYmd);
      if (effectiveStatus !== "active") {
        warnings.push(`Prepagato ${String(prepaid.service_name ?? "")} non utilizzabile (${effectiveStatus}).`.trim());
        continue;
      }
      if (remaining <= 0) {
        warnings.push("Residuo prepagato esaurito.");
        continue;
      }

      // 5) Consume ONE unit via the authoritative primitive (re-reads remaining and
      //    THROWS on insufficient balance, so we never over-consume; flips status to
      //    'completed' at 0 and writes the usage ledger).
      await consumeDbPrepaid(clientPrepaidServiceId, 1, slug);

      // 6) Link the appointment_services row + zero its charge (keep list_price).
      if (hasLinkColumn && servicesTable) {
        await updateAppointmentServicePrepaidLink(slug, servicesTable, appointmentId, serviceId, clientPrepaidServiceId);
      } else {
        warnings.push("Unità prepagato consumata, ma il collegamento al servizio non è disponibile su questo archivio.");
      }

      applied.push({ clientPrepaidServiceId, serviceId });
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Errore riscatto prepagato.");
    }
  }

  return { applied, warnings };
}

// Set the prepaid linkage on a single appointment_services row (keyed by the
// composite appointment_id + service_id — the table has no surrogate id) and zero
// its charge: price 0, list_price preserved as the catalog reference, and a
// 'Prepagato' discount_badge (faithful to the legacy zero-charge presentation).
async function updateAppointmentServicePrepaidLink(
  slug: string,
  table: TenantTable,
  appointmentId: number,
  serviceId: number,
  clientPrepaidServiceId: number,
): Promise<void> {
  const assignments: string[] = [
    "client_prepaid_service_id = ?",
    "price = 0",
  ];
  const params: unknown[] = [clientPrepaidServiceId];
  if (await columnExists(table.name, "discount_badge")) assignments.push("discount_badge = 'Prepagato'");
  const clauses = ["appointment_id = ?", "service_id = ?"];
  params.push(appointmentId, serviceId);
  if (table.mode === "shared" && (await columnExists(table.name, "tenant_id"))) {
    clauses.push("tenant_id = ?");
    params.push(table.tenantId ?? 0);
  }
  await dbExecute(
    `UPDATE ${quoteIdentifier(table.name)} SET ${assignments.join(", ")} WHERE ${clauses.join(" AND ")}`,
    params,
  );
}

// One entry from the quick-booking `giftbox_redeem` JSON array (assets/js/app.js
// #qb_giftbox_redeem): cover a service with ONE ITEM from a client's giftbox. GiftBox
// is per-service + ITEM-based (like a package): a single giftbox item (identified by
// instance_id + giftbox_item_id, the giftbox_instance_items.giftbox_item_id value)
// covers one service, consuming one unit of that item. `serviceId` must be on the
// appointment. The redemption is recorded in giftbox_redemptions + giftbox_redemption_items.
export type AppointmentGiftboxRedeem = {
  instanceId: number;
  giftboxItemId: number; // = giftbox_instance_items.giftbox_item_id (NOT the row's surrogate id)
  serviceId: number;
};

// Apply the quick-booking GIFTBOX redeems for an appointment AS PART of the save. For
// each requested redeem this RE-VALIDATES server-side (never trusting the client): the
// giftbox instance exists, belongs to the appointment's client (recipient_client_id,
// else client_id), is 'issued' + not expired; the item exists ON that instance for the
// redeemed service (giftbox_instance_items WHERE instance_id + giftbox_item_id +
// service_id), and the item's residual (qty - already-redeemed via giftBoxItemRedeemedUnits)
// is > 0. On success it RECORDS the redemption — a giftbox_redemptions row (instance_id,
// redeemed_at, source_type='appointment', source_id=appointmentId) + a
// giftbox_redemption_items row (redemption_id, giftbox_item_id, qty 1), exactly the
// tables the legacy GiftBox::redeemInstanceItems writes — so giftBoxItemRedeemedUnits
// immediately reflects the consumption and the unit can never be double-redeemed. It
// then links the matching appointment_services row (giftbox_instance_id + giftbox_item_id)
// and zeroes its charge (price 0, list_price kept, 'GiftBox' badge). When the item is the
// instance's LAST residual unit the instance is flipped to status='redeemed' (parity with
// redeemInstanceItems). A redeem that fails validation is SKIPPED (collected as a warning)
// and never fails the whole booking (legacy best-effort parity).
//
// `coveredServiceIds` are the services already covered by a PACKAGE or PREPAID redeem in
// this same save — those are skipped so a service is covered at most once (dedupe). Like
// the package/prepaid apply we additionally dedupe so a service is giftbox-covered by at
// most one item (first wins). Faithful to api_appointments.php +
// GiftBox::redeemInstanceItems, adapted to the Next port's consume-on-save + link.
export async function applyAppointmentGiftboxRedeems({
  slug,
  appointmentId,
  clientId,
  serviceIds,
  redeems,
  coveredServiceIds,
}: {
  slug: string;
  appointmentId: number;
  clientId: number;
  serviceIds: number[]; // service_ids actually on this appointment (the redeem is filtered to these)
  redeems: AppointmentGiftboxRedeem[];
  coveredServiceIds?: Set<number>; // services already covered by a package/prepaid redeem (skip)
}): Promise<{ applied: AppointmentGiftboxRedeem[]; warnings: string[] }> {
  const applied: AppointmentGiftboxRedeem[] = [];
  const warnings: string[] = [];
  if (!redeems.length) return { applied, warnings };

  // The redemption recording tables must exist; without them we cannot consume a unit
  // safely (the residual maths reads them), so we skip with a warning (best-effort).
  const hasRedemptionTables =
    (await tableExists((await tenantTable(slug, "giftbox_redemptions").catch(() => ({ name: "" } as TenantTable))).name)) &&
    (await tableExists((await tenantTable(slug, "giftbox_redemption_items").catch(() => ({ name: "" } as TenantTable))).name));

  // Only the appointment_services snapshot table can carry the linkage; if it lacks the
  // giftbox columns (older installs) we still record + consume + log a warning.
  const servicesTable = await tenantTable(slug, "appointment_services").catch(() => null);
  const hasLinkColumns = servicesTable
    ? (await columnExists(servicesTable.name, "giftbox_instance_id")) &&
      (await columnExists(servicesTable.name, "giftbox_item_id"))
    : false;

  // Drop redeems for services not on this appointment, those a package/prepaid already
  // covers, and dedupe so a service is covered by at most ONE giftbox item (first wins).
  const onAppointment = new Set(serviceIds.filter((id) => id > 0));
  const seenService = new Set<number>();

  for (const redeem of redeems) {
    const instanceId = Number(redeem.instanceId ?? 0);
    const giftboxItemId = Number(redeem.giftboxItemId ?? 0);
    const serviceId = Number(redeem.serviceId ?? 0);
    if (instanceId <= 0 || giftboxItemId <= 0 || serviceId <= 0) continue;
    if (!onAppointment.has(serviceId)) continue; // service not on the appointment
    if (coveredServiceIds?.has(serviceId)) continue; // already covered by a package/prepaid
    if (seenService.has(serviceId)) continue; // already covered by another giftbox item
    seenService.add(serviceId);

    if (!hasRedemptionTables) {
      warnings.push("GiftBox: schema riscatti non disponibile su questo archivio.");
      continue;
    }

    try {
      // 1) Load the giftbox instance, tenant-scoped (tenantSelect scopes to the tenant).
      const instanceRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "giftbox_instances",
        columns: "id, client_id, recipient_client_id, status, issued_at, expires_at",
        where: "id = ?",
        params: [instanceId],
        limit: 1,
      });
      const instance = instanceRows[0];
      if (!instance) {
        warnings.push("GiftBox non trovata.");
        continue;
      }

      // 2) Ownership: the instance must belong to the appointment's client. The target
      //    is recipient_client_id when set, else client_id (same rule the residuals block
      //    + GiftBox::instanceBelongsToClient use).
      const recipientId = Number(instance.recipient_client_id ?? 0);
      const ownerId = Number(instance.client_id ?? 0);
      const belongs = recipientId > 0 ? recipientId === clientId : ownerId === clientId;
      if (!belongs) {
        warnings.push("La GiftBox selezionata non appartiene al cliente.");
        continue;
      }

      // 3) Status 'issued' + not yet valid? + not expired (parity with redeemInstanceItems).
      const status = String(instance.status ?? "").toLowerCase();
      if (status !== "issued" && status !== "active") {
        warnings.push("GiftBox non riscattabile.");
        continue;
      }
      const issuedYmd = instance.issued_at ? String(instance.issued_at).slice(0, 10) : "";
      if (issuedYmd && issuedYmd > todayIso()) {
        warnings.push("GiftBox non ancora valida.");
        continue;
      }
      const expiresYmd = instance.expires_at ? String(instance.expires_at).slice(0, 10) : "";
      if (expiresYmd && expiresYmd < todayIso()) {
        warnings.push("GiftBox scaduta.");
        continue;
      }

      // 4) Coverage: the item must exist ON this instance for the redeemed service, keyed
      //    by the giftbox_instance_items.giftbox_item_id column (the threaded identifier,
      //    NOT the row's surrogate id — faithful to qb_giftbox_item_remaining).
      const itemRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "giftbox_instance_items",
        columns: "giftbox_item_id, service_id, qty",
        where: "instance_id = ? AND giftbox_item_id = ?",
        params: [instanceId, giftboxItemId],
        limit: 1,
      });
      const item = itemRows[0];
      if (!item) {
        warnings.push("Elemento GiftBox non valido.");
        continue;
      }
      if (Number(item.service_id ?? 0) !== serviceId) {
        warnings.push("La GiftBox selezionata non copre il servizio.");
        continue;
      }

      // 5) Residual: item qty - already-redeemed (per item) must be > 0. Reading the
      //    redemption tables means a unit recorded earlier in THIS save (an earlier
      //    redeem of the same item) is already counted, so we never over-redeem.
      const totalQty = Math.max(0, Number(item.qty ?? 0));
      const redeemedQty = await giftBoxItemRedeemedUnits(slug, instanceId, giftboxItemId);
      if (totalQty - redeemedQty <= 0) {
        warnings.push("Unità GiftBox esaurite per l'elemento selezionato.");
        continue;
      }

      // 6) RECORD the redemption: a header row + a single redemption-item row (qty 1).
      //    This is the consume — it makes giftBoxItemRedeemedUnits reflect the unit.
      const redemptionId = await tenantInsert(await tenantTable(slug, "giftbox_redemptions"), {
        instance_id: instanceId,
        redeemed_at: new Date(),
        source_type: "appointment",
        source_id: appointmentId,
      });
      if (redemptionId <= 0) {
        warnings.push("GiftBox: impossibile registrare il riscatto.");
        continue;
      }
      await tenantInsert(await tenantTable(slug, "giftbox_redemption_items"), {
        redemption_id: redemptionId,
        giftbox_item_id: giftboxItemId,
        qty: 1,
      });

      // 7) If this item was the instance's LAST residual unit across ALL its items,
      //    flip the instance to 'redeemed' (parity with redeemInstanceItems' allDone).
      try {
        const allItems = await tenantSelect<RowDataPacket>({
          slug,
          table: "giftbox_instance_items",
          columns: "giftbox_item_id, qty",
          where: "instance_id = ?",
          params: [instanceId],
        });
        let anyRemaining = false;
        for (const it of allItems) {
          const itId = Number(it.giftbox_item_id ?? 0);
          if (itId <= 0) continue;
          const used = await giftBoxItemRedeemedUnits(slug, instanceId, itId);
          if (Math.max(0, Number(it.qty ?? 0)) - used > 0) {
            anyRemaining = true;
            break;
          }
        }
        if (!anyRemaining) {
          await tenantUpdate({
            slug,
            table: "giftbox_instances",
            id: instanceId,
            values: { status: "redeemed", redeemed_at: new Date(), redeemed_source_type: "appointment", redeemed_source_id: appointmentId },
          });
        }
      } catch {
        // best-effort: a status-flip failure must not fail the booking (unit is recorded).
      }

      // 8) Link the appointment_services row + zero its charge (keep list_price).
      if (hasLinkColumns && servicesTable) {
        await updateAppointmentServiceGiftboxLink(slug, servicesTable, appointmentId, serviceId, {
          instanceId,
          giftboxItemId,
        });
      } else {
        warnings.push("Unità GiftBox consumata, ma il collegamento al servizio non è disponibile su questo archivio.");
      }

      applied.push({ instanceId, giftboxItemId, serviceId });
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Errore riscatto GiftBox.");
    }
  }

  return { applied, warnings };
}

// Set the giftbox linkage on a single appointment_services row (keyed by the composite
// appointment_id + service_id — the table has no surrogate id) and zero its charge:
// price 0, list_price preserved as the catalog reference, and a 'GiftBox' discount_badge
// (faithful to the legacy zero-charge presentation, mirroring the package/prepaid links).
async function updateAppointmentServiceGiftboxLink(
  slug: string,
  table: TenantTable,
  appointmentId: number,
  serviceId: number,
  link: { instanceId: number; giftboxItemId: number },
): Promise<void> {
  const assignments: string[] = [
    "giftbox_instance_id = ?",
    "giftbox_item_id = ?",
    "price = 0",
  ];
  const params: unknown[] = [link.instanceId, link.giftboxItemId];
  if (await columnExists(table.name, "discount_badge")) assignments.push("discount_badge = 'GiftBox'");
  const clauses = ["appointment_id = ?", "service_id = ?"];
  params.push(appointmentId, serviceId);
  if (table.mode === "shared" && (await columnExists(table.name, "tenant_id"))) {
    clauses.push("tenant_id = ?");
    params.push(table.tenantId ?? 0);
  }
  await dbExecute(
    `UPDATE ${quoteIdentifier(table.name)} SET ${assignments.join(", ")} WHERE ${clauses.join(" AND ")}`,
    params,
  );
}

// One entry from the quick-booking `gift_redeem` JSON array (assets/js/app.js
// #qb_gift_redeem): cover a service with ONE REWARD from a client's GIFT (omaggio). A gift
// INSTANCE holds REWARD ITEMS (gifts.reward_items_json); a SERVICE reward (type='service')
// is a free service. A redeem applies ONE reward — identified by instance_id +
// reward_item_index (the reward's ARRAY INDEX in reward_items_json) — to a booked service
// (zero-charge), consuming one unit of that reward. `serviceId` must be on the appointment
// and must match the reward's service. The redemption is recorded in appointment_gift_items
// (redeemed_at set), keyed by the legacy composite (instance + reward_item_index + service).
export type AppointmentGiftRedeem = {
  instanceId: number;
  rewardItemIndex: number; // = array index in gifts.reward_items_json
  serviceId: number;
};

// Apply the quick-booking GIFT (omaggio) redeems for an appointment AS PART of the save.
// For each requested redeem this RE-VALIDATES server-side (never trusting the client): the
// gift instance exists, belongs to the appointment's client (gift_instances.client_id), is
// state='disponibile' + active + not expired; the reward at `reward_item_index` (from the
// instance's gift.reward_items_json) is a SERVICE reward for exactly `serviceId`; and that
// reward's residual (reward qty MINUS already-redeemed via giftRewardRedeemedQty) is > 0. On
// success it RECORDS the redemption — an appointment_gift_items row (appointment_id,
// instance_id, gift_id, reward_item_index, service_id, qty 1, redeemed_at=NOW) — the same
// table the legacy Gifts redemption writes — so giftRewardRedeemedQty immediately reflects
// the consumption and the reward can never be double-redeemed within or across saves. It then
// links the matching appointment_services row (gift_instance_id + reward_item_index,
// columnExists-guarded) and zeroes its charge (price 0, list_price kept, 'Omaggio' badge).
// When the reward is the instance's LAST residual SERVICE reward the instance is flipped to
// state='riscattato' (parity with the legacy auto-redeem). A redeem that fails validation is
// SKIPPED (collected as a warning) and never fails the whole booking (legacy best-effort
// parity).
//
// `coveredServiceIds` are the services already covered by a PACKAGE, PREPAID or GIFTBOX
// redeem in this same save — those are skipped so a service is covered at most once (dedupe).
// Like the other applies we additionally dedupe so a service is gift-covered by at most one
// reward (first wins). Faithful to api_appointments.php + Gifts (reward-item redemption),
// adapted to the Next port's consume-on-save + columnExists-guarded link.
export async function applyAppointmentGiftRedeems({
  slug,
  appointmentId,
  clientId,
  serviceIds,
  redeems,
  coveredServiceIds,
}: {
  slug: string;
  appointmentId: number;
  clientId: number;
  serviceIds: number[]; // service_ids actually on this appointment (the redeem is filtered to these)
  redeems: AppointmentGiftRedeem[];
  coveredServiceIds?: Set<number>; // services already covered by a package/prepaid/giftbox redeem (skip)
}): Promise<{ applied: AppointmentGiftRedeem[]; warnings: string[] }> {
  const applied: AppointmentGiftRedeem[] = [];
  const warnings: string[] = [];
  if (!redeems.length) return { applied, warnings };

  // The tracking table must exist; without it we cannot consume a reward safely (the
  // residual maths reads it), so we skip with a warning (best-effort).
  const giftItemsTable = await tenantTable(slug, "appointment_gift_items").catch(() => null);
  const hasTrackingTable = giftItemsTable ? await tableExists(giftItemsTable.name) : false;

  // Only the appointment_services snapshot table can carry the linkage; if it lacks the
  // gift columns (older installs) we still record + consume + log a warning.
  const servicesTable = await tenantTable(slug, "appointment_services").catch(() => null);
  const hasLinkColumns = servicesTable
    ? (await columnExists(servicesTable.name, "gift_instance_id")) &&
      (await columnExists(servicesTable.name, "reward_item_index"))
    : false;

  // Drop redeems for services not on this appointment, those a package/prepaid/giftbox
  // already covers, and dedupe so a service is covered by at most ONE gift reward (first wins).
  const onAppointment = new Set(serviceIds.filter((id) => id > 0));
  const seenService = new Set<number>();

  for (const redeem of redeems) {
    const instanceId = Number(redeem.instanceId ?? 0);
    const rewardItemIndex = Number(redeem.rewardItemIndex ?? 0);
    const serviceId = Number(redeem.serviceId ?? 0);
    if (instanceId <= 0 || serviceId <= 0 || rewardItemIndex < 0) continue;
    if (!onAppointment.has(serviceId)) continue; // service not on the appointment
    if (coveredServiceIds?.has(serviceId)) continue; // already covered by a package/prepaid/giftbox
    if (seenService.has(serviceId)) continue; // already covered by another gift reward
    seenService.add(serviceId);

    if (!hasTrackingTable) {
      warnings.push("Omaggio: schema riscatti non disponibile su questo archivio.");
      continue;
    }

    try {
      // 1) Load the gift instance, tenant-scoped (tenantSelect scopes to the tenant).
      const instanceRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "gift_instances",
        columns: "id, gift_id, client_id, state, is_active, expires_at",
        where: "id = ?",
        params: [instanceId],
        limit: 1,
      });
      const instance = instanceRows[0];
      if (!instance) {
        warnings.push("Omaggio non trovato.");
        continue;
      }

      // 2) Ownership: the instance must belong to the appointment's client.
      if (Number(instance.client_id ?? 0) !== clientId) {
        warnings.push("L'omaggio selezionato non appartiene al cliente.");
        continue;
      }

      // 3) Availability: state='disponibile' + (is_active OR state in disponibile/riscattato)
      //    + not expired (by calendar day) — parity with Gifts::clientAvailableInstances.
      const state = String(instance.state ?? "").trim().toLowerCase();
      const isActive = Number(instance.is_active ?? 0);
      if (state !== "disponibile") {
        warnings.push("Omaggio non riscattabile.");
        continue;
      }
      if (!(isActive === 1 || state === "disponibile" || state === "riscattato")) {
        warnings.push("Omaggio non attivo.");
        continue;
      }
      const expiresYmd = instance.expires_at ? String(instance.expires_at).slice(0, 10) : "";
      if (expiresYmd && expiresYmd < todayIso()) {
        warnings.push("Omaggio scaduto.");
        continue;
      }

      // 4) Coverage: the reward at reward_item_index (from the instance's gift) must be a
      //    SERVICE reward for exactly this service. Read reward_items_json off the gift def.
      const giftId = Number(instance.gift_id ?? 0);
      const giftRows = giftId > 0
        ? await tenantSelect<RowDataPacket>({ slug, table: "gifts", columns: "reward_items_json", where: "id = ?", params: [giftId], limit: 1 })
        : [];
      const rewardItems = parseGiftRewardItems(giftRows[0]?.reward_items_json);
      const reward = rewardItems[rewardItemIndex];
      if (!reward || reward.type !== "service" || reward.serviceId <= 0) {
        warnings.push("Omaggio non valido per il servizio.");
        continue;
      }
      if (reward.serviceId !== serviceId) {
        warnings.push("L'omaggio selezionato non copre il servizio.");
        continue;
      }

      // 5) Residual: reward qty - already-redeemed - already-PENDING must be > 0. Il
      //    modello legacy è pending-until-done (Gifts::saveAppointmentSelection ~11270):
      //    le righe in sospeso su prenotazioni aperte riservano l'unità e la doppia
      //    prenotazione dello stesso premio viene rifiutata qui.
      const redeemedQty = await giftRewardRedeemedQty(slug, instanceId, rewardItemIndex, serviceId);
      const pendingQty = await giftRewardPendingQty(slug, instanceId, rewardItemIndex, serviceId);
      if (reward.qty - redeemedQty - pendingQty <= 0) {
        warnings.push("Omaggio esaurito per la ricompensa selezionata.");
        continue;
      }

      // 6) RECORD the reservation: an appointment_gift_items row with redeemed_at NULL
      //    (PENDING — legacy parity: il riscatto vero avviene al 'done' via
      //    giftRedeemAppointmentSelectionIfAny) + una transazione 'pending' nel ledger.
      const insertId = await tenantInsert(await tenantTable(slug, "appointment_gift_items"), {
        appointment_id: appointmentId,
        instance_id: instanceId,
        gift_id: giftId,
        reward_item_index: rewardItemIndex,
        service_id: serviceId,
        qty: 1,
        redeemed_at: null,
      });
      if (insertId <= 0) {
        warnings.push("Omaggio: impossibile registrare il riscatto.");
        continue;
      }
      await tenantInsert(await tenantTable(slug, "gift_transactions"), {
        instance_id: instanceId,
        appointment_id: appointmentId,
        reward_item_index: rewardItemIndex,
        service_id: serviceId,
        type: "pending",
        qty: 1,
        note: `In sospeso su prenotazione #${appointmentId}`,
        created_at: new Date(),
      }).catch(() => 0);

      // 7) NIENTE chiusura istanza qui: nel legacy l'istanza passa a 'riscattato'
      //    solo al 'done' (redeemInstanceItems, residuo 0) — il pending non chiude.

      // 8) Link the appointment_services row + zero its charge (keep list_price).
      if (hasLinkColumns && servicesTable) {
        await updateAppointmentServiceGiftLink(slug, servicesTable, appointmentId, serviceId, {
          instanceId,
          rewardItemIndex,
        });
      } else {
        warnings.push("Omaggio consumato, ma il collegamento al servizio non è disponibile su questo archivio.");
      }

      applied.push({ instanceId, rewardItemIndex, serviceId });
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Errore riscatto Omaggio.");
    }
  }

  return { applied, warnings };
}

// Set the gift linkage on a single appointment_services row (keyed by the composite
// appointment_id + service_id — the table has no surrogate id) and zero its charge:
// price 0, list_price preserved as the catalog reference, and an 'Omaggio' discount_badge
// (faithful to the legacy zero-charge presentation, mirroring the package/prepaid/giftbox links).
async function updateAppointmentServiceGiftLink(
  slug: string,
  table: TenantTable,
  appointmentId: number,
  serviceId: number,
  link: { instanceId: number; rewardItemIndex: number },
): Promise<void> {
  const assignments: string[] = [
    "gift_instance_id = ?",
    "reward_item_index = ?",
    "price = 0",
  ];
  const params: unknown[] = [link.instanceId, link.rewardItemIndex];
  if (await columnExists(table.name, "discount_badge")) assignments.push("discount_badge = 'Omaggio'");
  const clauses = ["appointment_id = ?", "service_id = ?"];
  params.push(appointmentId, serviceId);
  if (table.mode === "shared" && (await columnExists(table.name, "tenant_id"))) {
    clauses.push("tenant_id = ?");
    params.push(table.tenantId ?? 0);
  }
  await dbExecute(
    `UPDATE ${quoteIdentifier(table.name)} SET ${assignments.join(", ")} WHERE ${clauses.join(" AND ")}`,
    params,
  );
}

// One entry from the quick-booking `giftcard_redeem` JSON array (assets/js/app.js
// #qb_giftcard_redeem): apply a client's GiftCard BALANCE (a monetary amount) toward
// the WHOLE appointment. Unlike package/prepaid (per-service units), this is
// APPOINTMENT-LEVEL + MONETARY: one giftcard, one amount. `amount` is the requested
// amount to apply; it is re-clamped server-side to min(amount, balance, payableTotal).
export type AppointmentGiftcardRedeem = {
  giftcardId: number;
  amount: number;
};

// Apply the quick-booking GIFTCARD redeem for an appointment AS PART of the save.
// GiftCard is APPOINTMENT-LEVEL + MONETARY (not per-service like package/prepaid):
// ONE giftcard per appointment, an AMOUNT applied toward the appointment's payable
// total. For the FIRST requested redeem that passes validation this RE-VALIDATES
// server-side (never trusting the client): the giftcard exists, belongs to the
// appointment's client (recipient_client_id, else client_id), is active + not expired
// + has balance > 0. It then computes the appointment's PAYABLE TOTAL server-side as
// SUM(appointment_services.price) over the rows just inserted (a service zero-charged
// by a package/prepaid redeem already has price 0, so it never inflates the cap),
// CLAMPS the requested amount to min(requestedAmount, balance, payableTotal), and —
// when the clamped amount is > 0 — decrements the giftcard via redeemDbGiftCard
// (which re-reads the balance and THROWS on over-redeem, flips status to 'redeemed'
// at 0, and writes a giftcard_transactions movement) and links the appointment
// (appointments.giftcard_id + giftcard_used = clamped amount, columnExists-guarded).
// A redeem that fails validation / clamps to 0 is SKIPPED (collected as a warning)
// and never fails the whole booking (legacy best-effort parity).
//
// Faithful to api_appointments.php qb_apply_giftcard_redeem_to_appointment (+
// qb_giftcard_appointment_schema_available), adapted to the Next port's
// consume-on-save + columnExists-guarded appointment link.
export async function applyAppointmentGiftcardRedeem({
  slug,
  appointmentId,
  clientId,
  redeems,
}: {
  slug: string;
  appointmentId: number;
  clientId: number;
  redeems: AppointmentGiftcardRedeem[];
}): Promise<{ applied: AppointmentGiftcardRedeem | null; warnings: string[] }> {
  const warnings: string[] = [];
  if (!redeems.length) return { applied: null, warnings };

  // Only the appointments table can carry the linkage; if it lacks the giftcard
  // columns (older installs) we still decrement the balance + log a warning. This
  // mirrors qb_giftcard_appointment_schema_available.
  const appointmentsTable = await tenantTable(slug, "appointments").catch(() => null);
  const hasLinkColumns = appointmentsTable
    ? (await columnExists(appointmentsTable.name, "giftcard_id")) &&
      (await columnExists(appointmentsTable.name, "giftcard_used"))
    : false;

  // The appointment's PAYABLE TOTAL: SUM(appointment_services.price) AFTER any
  // package/prepaid zeroing (those rows already have price 0). Computed once, used as
  // the upper cap so we never redeem more than the appointment can absorb. If the
  // snapshot table is absent we fall back to 0 (nothing payable -> nothing to apply).
  let payableTotal = 0;
  try {
    const serviceRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointment_services",
      columns: "price",
      where: "appointment_id = ?",
      params: [appointmentId],
    });
    payableTotal = roundMoney(
      serviceRows.reduce((sum, row) => sum + Math.max(0, parseMoney(row.price, 0)), 0),
    );
  } catch {
    payableTotal = 0;
  }

  // ONE giftcard per appointment: take the FIRST entry that validates + clamps > 0.
  for (const redeem of redeems) {
    const giftcardId = Number(redeem.giftcardId ?? 0);
    const requestedAmount = roundMoney(Math.max(0, Number(redeem.amount ?? 0)));
    if (giftcardId <= 0) continue;

    try {
      // 1) Load the giftcard, tenant-scoped (tenantSelect scopes to the tenant).
      const giftcardTable = await tenantTable(slug, "giftcards");
      const hasRecipient = await columnExists(giftcardTable.name, "recipient_client_id");
      const giftcardRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "giftcards",
        columns: hasRecipient
          ? "id, client_id, recipient_client_id, code, status, expires_at, balance"
          : "id, client_id, code, status, expires_at, balance",
        where: "id = ?",
        params: [giftcardId],
        limit: 1,
      });
      const giftcard = giftcardRows[0];
      if (!giftcard) {
        warnings.push("GiftCard non trovata.");
        continue;
      }

      // 2) Ownership: the giftcard must belong to the appointment's client. The
      //    recipient_client_id (when present) is the target client; older installs
      //    fall back to client_id (mirrors the residuals availability rule).
      const ownerId = hasRecipient
        ? Number(giftcard.recipient_client_id ?? 0)
        : Number(giftcard.client_id ?? 0);
      if (ownerId !== clientId) {
        warnings.push("La GiftCard selezionata non appartiene al cliente.");
        continue;
      }

      // 3) Active + not expired + balance > 0 (effective status, like giftCardStatus).
      const balance = roundMoney(Math.max(0, parseMoney(giftcard.balance, 0)));
      const expiresYmd = giftcard.expires_at ? String(giftcard.expires_at).slice(0, 10) : "";
      const effectiveStatus = giftCardStatus(String(giftcard.status ?? "active"), expiresYmd);
      if (effectiveStatus !== "active") {
        warnings.push(`GiftCard ${String(giftcard.code ?? "")} non utilizzabile (${effectiveStatus}).`.trim());
        continue;
      }
      if (balance <= 0) {
        warnings.push("Saldo GiftCard esaurito.");
        continue;
      }

      // 4) Clamp the requested amount to [0, min(balance, payableTotal)]. We never
      //    redeem more than the giftcard balance NOR more than the appointment's
      //    payable total (financial correctness). A 0 clamp -> nothing to apply.
      const clamped = roundMoney(Math.min(requestedAmount, balance, payableTotal));
      if (clamped <= 0) {
        if (payableTotal <= 0) warnings.push("Nessun importo da coprire con la GiftCard.");
        else warnings.push("Importo GiftCard non valido.");
        continue;
      }

      // 5) Decrement the giftcard via the authoritative primitive (re-reads the
      //    balance and THROWS on over-redeem, so we never over-decrement; flips status
      //    to 'redeemed' at 0 and writes the giftcard_transactions movement).
      await redeemDbGiftCard(giftcardId, clamped, slug);

      // 6) Link the appointment: giftcard_id + giftcard_used = clamped amount.
      if (hasLinkColumns && appointmentsTable) {
        await tenantUpdate({
          slug,
          table: "appointments",
          id: appointmentId,
          values: { giftcard_id: giftcardId, giftcard_used: clamped },
        });
      } else {
        warnings.push("Saldo GiftCard scalato, ma il collegamento all'appuntamento non è disponibile su questo archivio.");
      }

      return { applied: { giftcardId, amount: clamped }, warnings };
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : "Errore riscatto GiftCard.");
    }
  }

  return { applied: null, warnings };
}

// POS Prepaids list — faithful port of pos_prepaids.php's three-source merge.
// Sources: (1) client_prepaid_services -> kind "prepaid"; (2) the services inside
// client_packages (client_package_services) -> kind "package"; (3) the service
// items inside giftbox_instances (giftbox_instance_items) -> kind "giftbox".
//
// Residual split (the load-bearing correctness fix): bookedQty = sessions tied to
// an OPEN appointment (pending/scheduled, redeemed_at IS NULL) via the per-source
// appointment_*_items table; bookableQty = remaining - bookedQty. Each source also
// carries lastUsedAt (MAX used_at / redeemed_at) and sourceSaleId.
//
// Tenant-safe: every read is a tenant-scoped tenantSelect; cross-table linkage is
// resolved in memory (no cross-tenant raw joins). Missing tables degrade to 0/skip.
export async function listDbPrepaids(slug: string): Promise<ClientPrepaid[]> {
  const [prepaids, packages, giftboxes] = await Promise.all([
    listPrepaidSourceRows(slug),
    listPackageSourceRows(slug),
    listGiftboxSourceRows(slug),
  ]);
  return [...prepaids, ...packages, ...giftboxes];
}

// ---- Source 1: standalone prepaids (client_prepaid_services) ----
async function listPrepaidSourceRows(slug: string): Promise<ClientPrepaid[]> {
  const table = await tenantTable(slug, "client_prepaid_services").catch(() => null);
  if (!table || !(await tableExists(table.name))) return [];
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "client_prepaid_services",
    orderBy: "created_at DESC, id DESC",
  });
  if (rows.length === 0) return [];

  const ids = rows.map((r) => Number(r.id ?? 0)).filter((n) => n > 0);
  const [bookedMap, lastUsedMap] = await Promise.all([
    prepaidBookedMap(slug, ids),
    prepaidLastUsedMap(slug, ids),
  ]);

  return Promise.all(
    rows.map(async (row) => {
      const id = Number(row.id ?? 0);
      const remaining = Math.max(0, Number(row.remaining_qty ?? 0));
      const bookedQty = Math.min(remaining, bookedMap.get(id) ?? 0);
      return {
        id,
        kind: "prepaid" as const,
        clientId: Number(row.client_id ?? 0),
        clientName: await appointmentClientName(slug, Number(row.client_id ?? 0)),
        serviceId: Number(row.service_id ?? 0),
        serviceName: String(row.service_name ?? "Servizio"),
        totalQuantity: Math.max(0, Number(row.purchased_qty ?? remaining)),
        remainingQuantity: remaining,
        bookedQty,
        bookableQty: Math.max(0, remaining - bookedQty),
        lastUsedAt: lastUsedMap.get(id) || undefined,
        expiresAt: row.expires_at ? String(row.expires_at).slice(0, 10) : undefined,
        status: clientPrepaidStatus(String(row.status ?? "active"), remaining, String(row.expires_at ?? "")),
        sourceSaleId: row.sale_id ? Number(row.sale_id) : undefined,
        createdAt: toIso(row.created_at ?? row.purchase_date),
      };
    }),
  );
}

// Batched booked-qty for many prepaids: link rows (redeemed_at IS NULL) grouped by
// client_prepaid_service_id, kept only when their appointment is OPEN. Missing
// linkage/appointments tables -> empty map (0 booked for all).
async function prepaidBookedMap(slug: string, prepaidServiceIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const ids = prepaidServiceIds.filter((n) => n > 0);
  if (ids.length === 0) return out;
  try {
    const linkTable = await tenantTable(slug, "appointment_prepaid_service_items");
    if (!(await tableExists(linkTable.name))) return out;
    const placeholders = ids.map(() => "?").join(",");
    const linkRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointment_prepaid_service_items",
      columns: "client_prepaid_service_id, appointment_id, qty",
      where: `client_prepaid_service_id IN (${placeholders}) AND redeemed_at IS NULL`,
      params: ids,
    });
    if (linkRows.length === 0) return out;
    const openIds = await openAppointmentIds(slug, linkRows.map((r) => Number(r.appointment_id ?? 0)));
    for (const r of linkRows) {
      if (!openIds.has(Number(r.appointment_id ?? 0))) continue;
      const key = Number(r.client_prepaid_service_id ?? 0);
      out.set(key, (out.get(key) ?? 0) + Math.max(0, Number(r.qty ?? 0)));
    }
  } catch {
    return out;
  }
  return out;
}

// Batched last-usage (MAX used_at) per prepaid. Missing table -> empty map.
async function prepaidLastUsedMap(slug: string, prepaidServiceIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const ids = prepaidServiceIds.filter((n) => n > 0);
  if (ids.length === 0) return out;
  try {
    const usageTable = await tenantTable(slug, "client_prepaid_service_usages");
    if (!(await tableExists(usageTable.name))) return out;
    const placeholders = ids.map(() => "?").join(",");
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "client_prepaid_service_usages",
      columns: "client_prepaid_service_id, used_at",
      where: `client_prepaid_service_id IN (${placeholders})`,
      params: ids,
    });
    for (const r of rows) {
      const key = Number(r.client_prepaid_service_id ?? 0);
      const at = r.used_at ? toIso(r.used_at) : "";
      if (!at) continue;
      const prev = out.get(key);
      if (!prev || at > prev) out.set(key, at);
    }
  } catch {
    return out;
  }
  return out;
}

// ---- Source 2: package services (client_packages + client_package_services) ----
async function listPackageSourceRows(slug: string): Promise<ClientPrepaid[]> {
  const pkgTable = await tenantTable(slug, "client_packages").catch(() => null);
  const svcTable = await tenantTable(slug, "client_package_services").catch(() => null);
  if (!pkgTable || !(await tableExists(pkgTable.name))) return [];
  if (!svcTable || !(await tableExists(svcTable.name))) return [];

  const packages = await tenantSelect<RowDataPacket>({
    slug,
    table: "client_packages",
    columns: "id, client_id, package_name, expires_at, status, sale_id, purchase_date, start_date, created_at",
    orderBy: "created_at DESC, id DESC",
  });
  if (packages.length === 0) return [];
  const pkgById = new Map<number, RowDataPacket>();
  for (const p of packages) pkgById.set(Number(p.id ?? 0), p);

  const pkgIds = Array.from(pkgById.keys());
  const placeholders = pkgIds.map(() => "?").join(",");
  const serviceRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "client_package_services",
    columns: "id, client_package_id, service_id, sessions_total, sessions_remaining, service_snapshot_json",
    where: `client_package_id IN (${placeholders}) AND COALESCE(service_id, 0) > 0`,
    params: pkgIds,
  });
  if (serviceRows.length === 0) return [];

  const [bookedMap, lastUsedMap] = await Promise.all([
    packageBookedMap(slug),
    packageLastUsedMap(slug),
  ]);

  return Promise.all(
    serviceRows.map(async (row) => {
      const cpsId = Number(row.id ?? 0);
      const pkgId = Number(row.client_package_id ?? 0);
      const serviceId = Number(row.service_id ?? 0);
      const pkg = pkgById.get(pkgId) ?? {};
      const total = Math.max(0, Number(row.sessions_total ?? 0));
      const remaining = Math.max(0, Number(row.sessions_remaining ?? 0));
      const booked = Math.min(
        remaining,
        bookedMap.get(`${pkgId}:${cpsId}:${serviceId}`) ?? bookedMap.get(`${pkgId}:0:${serviceId}`) ?? 0,
      );
      const snapshotName = snapshotServiceName(row.service_snapshot_json);
      const serviceName = snapshotName || (await serviceNameById(slug, serviceId, `Servizio #${serviceId}`));
      const status = packageDisplayStatus(String(pkg.status ?? "active"), remaining, pkg.expires_at ? String(pkg.expires_at) : "");
      const lastUsedAt = lastUsedMap.get(`${pkgId}:${serviceId}`) ?? lastUsedMap.get(`${pkgId}:0`) ?? "";
      const saleId = Number(pkg.sale_id ?? 0);
      return {
        // Encode source in the id so the merged list keys stay unique across kinds.
        id: cpsId > 0 ? 2_000_000_000 + cpsId : 2_000_000_000 + pkgId,
        kind: "package" as const,
        clientId: Number(pkg.client_id ?? 0),
        clientName: await appointmentClientName(slug, Number(pkg.client_id ?? 0)),
        serviceId,
        serviceName,
        totalQuantity: total,
        remainingQuantity: remaining,
        bookedQty: booked,
        bookableQty: Math.max(0, remaining - booked),
        lastUsedAt: lastUsedAt || undefined,
        expiresAt: pkg.expires_at ? String(pkg.expires_at).slice(0, 10) : undefined,
        status,
        sourceSaleId: saleId > 0 ? saleId : undefined,
        createdAt: toIso(pkg.purchase_date ?? pkg.start_date ?? pkg.created_at),
      };
    }),
  );
}

// Booked-qty per package service: appointment_package_items (redeemed_at IS NULL)
// keyed by client_package_id:client_package_service_id:service_id, kept only when
// the appointment is OPEN. Missing tables -> empty map.
async function packageBookedMap(slug: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const linkTable = await tenantTable(slug, "appointment_package_items");
    if (!(await tableExists(linkTable.name))) return out;
    const hasRedeemed = await columnExists(linkTable.name, "redeemed_at");
    const linkRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointment_package_items",
      columns: "appointment_id, client_package_id, client_package_service_id, service_id, qty",
      where: hasRedeemed ? "redeemed_at IS NULL" : "",
    });
    if (linkRows.length === 0) return out;
    const openIds = await openAppointmentIds(slug, linkRows.map((r) => Number(r.appointment_id ?? 0)));
    for (const r of linkRows) {
      if (!openIds.has(Number(r.appointment_id ?? 0))) continue;
      const cpId = Number(r.client_package_id ?? 0);
      const cpsId = Number(r.client_package_service_id ?? 0);
      const sid = Number(r.service_id ?? 0);
      const qty = Math.max(0, Number(r.qty ?? 0));
      out.set(`${cpId}:${cpsId}:${sid}`, (out.get(`${cpId}:${cpsId}:${sid}`) ?? 0) + qty);
      // Fallback key for links that don't carry the per-service row id.
      if (cpsId <= 0) out.set(`${cpId}:0:${sid}`, (out.get(`${cpId}:0:${sid}`) ?? 0) + 0);
    }
  } catch {
    return out;
  }
  return out;
}

// Last-usage per package service: MAX(used_at) over decrements (delta < 0), keyed by
// client_package_id:service_id (plus a :0 fallback). Missing table -> empty map.
async function packageLastUsedMap(slug: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const usageTable = await tenantTable(slug, "client_package_usages");
    if (!(await tableExists(usageTable.name))) return out;
    const hasService = await columnExists(usageTable.name, "service_id");
    const hasDelta = await columnExists(usageTable.name, "delta");
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "client_package_usages",
      columns: hasService
        ? "client_package_id, service_id, used_at"
        : "client_package_id, used_at",
      where: hasDelta ? "delta < 0" : "",
    });
    for (const r of rows) {
      const cpId = Number(r.client_package_id ?? 0);
      const sid = hasService ? Number(r.service_id ?? 0) : 0;
      const at = r.used_at ? toIso(r.used_at) : "";
      if (!at) continue;
      for (const key of [`${cpId}:${sid}`, `${cpId}:0`]) {
        const prev = out.get(key);
        if (!prev || at > prev) out.set(key, at);
      }
    }
  } catch {
    return out;
  }
  return out;
}

// ---- Source 3: giftbox services (giftbox_instances + giftbox_instance_items) ----
async function listGiftboxSourceRows(slug: string): Promise<ClientPrepaid[]> {
  const instTable = await tenantTable(slug, "giftbox_instances").catch(() => null);
  const itemTable = await tenantTable(slug, "giftbox_instance_items").catch(() => null);
  if (!instTable || !(await tableExists(instTable.name))) return [];
  if (!itemTable || !(await tableExists(itemTable.name))) return [];

  const hasRecipient = await columnExists(instTable.name, "recipient_client_id");
  const instances = await tenantSelect<RowDataPacket>({
    slug,
    table: "giftbox_instances",
    columns: hasRecipient
      ? "id, client_id, recipient_client_id, code, status, issued_at, expires_at, created_at"
      : "id, client_id, code, status, issued_at, expires_at, created_at",
    orderBy: "created_at DESC, id DESC",
  });
  if (instances.length === 0) return [];
  const instById = new Map<number, RowDataPacket>();
  for (const i of instances) instById.set(Number(i.id ?? 0), i);

  const instIds = Array.from(instById.keys());
  const placeholders = instIds.map(() => "?").join(",");
  const items = await tenantSelect<RowDataPacket>({
    slug,
    table: "giftbox_instance_items",
    columns: "id, instance_id, giftbox_item_id, service_id, qty, service_snapshot_json",
    where: `instance_id IN (${placeholders}) AND item_type = 'service' AND COALESCE(service_id, 0) > 0`,
    params: instIds,
  });
  if (items.length === 0) return [];

  const [redeemMap, bookedMap] = await Promise.all([
    giftboxRedeemMap(slug),
    giftboxBookedMap(slug),
  ]);

  return Promise.all(
    items.map(async (row) => {
      const itemRowId = Number(row.id ?? 0);
      const instanceId = Number(row.instance_id ?? 0);
      const giftboxItemId = Number(row.giftbox_item_id ?? 0);
      const serviceId = Number(row.service_id ?? 0);
      const inst = instById.get(instanceId) ?? {};
      const total = Math.max(0, Number(row.qty ?? 0));
      const redeem = redeemMap.get(`${instanceId}:${giftboxItemId}`);
      const usedQty = Math.max(0, redeem?.qty ?? 0);
      const remaining = Math.max(0, total - usedQty);
      const booked = Math.min(remaining, bookedMap.get(`${instanceId}:${giftboxItemId}:${serviceId}`) ?? 0);
      const snapshotName = snapshotServiceName(row.service_snapshot_json);
      const serviceName = snapshotName || (await serviceNameById(slug, serviceId, `Servizio #${serviceId}`));
      const ownerId = hasRecipient && Number(inst.recipient_client_id ?? 0) > 0
        ? Number(inst.recipient_client_id ?? 0)
        : Number(inst.client_id ?? 0);
      const status = giftboxDisplayStatus(String(inst.status ?? "issued"), remaining, inst.expires_at ? String(inst.expires_at) : "");
      return {
        id: itemRowId > 0 ? 3_000_000_000 + itemRowId : 3_000_000_000 + instanceId,
        kind: "giftbox" as const,
        clientId: ownerId,
        clientName: await appointmentClientName(slug, ownerId),
        serviceId,
        serviceName,
        totalQuantity: total,
        remainingQuantity: remaining,
        bookedQty: booked,
        bookableQty: Math.max(0, remaining - booked),
        lastUsedAt: redeem?.lastRedeemedAt || undefined,
        expiresAt: inst.expires_at ? String(inst.expires_at).slice(0, 10) : undefined,
        status,
        // The GiftBox source sale isn't directly linked by a column; leave undefined
        // (legacy resolves it heuristically by matching the code in sale_items —
        // TODO if the source-sale link is required for GiftBox rows too).
        sourceSaleId: undefined,
        createdAt: toIso(inst.issued_at ?? inst.created_at),
      };
    }),
  );
}

// Redeemed qty + last redemption per giftbox item: giftbox_redemptions joined with
// giftbox_redemption_items, keyed by instance_id:giftbox_item_id. Missing tables -> map.
async function giftboxRedeemMap(slug: string): Promise<Map<string, { qty: number; lastRedeemedAt: string }>> {
  const out = new Map<string, { qty: number; lastRedeemedAt: string }>();
  try {
    const redTable = await tenantTable(slug, "giftbox_redemptions");
    const redItemTable = await tenantTable(slug, "giftbox_redemption_items");
    if (!(await tableExists(redTable.name)) || !(await tableExists(redItemTable.name))) return out;
    const redemptions = await tenantSelect<RowDataPacket>({
      slug,
      table: "giftbox_redemptions",
      columns: "id, instance_id, redeemed_at",
    });
    if (redemptions.length === 0) return out;
    const redById = new Map<number, RowDataPacket>();
    for (const r of redemptions) redById.set(Number(r.id ?? 0), r);
    const redIds = Array.from(redById.keys());
    const placeholders = redIds.map(() => "?").join(",");
    const redItems = await tenantSelect<RowDataPacket>({
      slug,
      table: "giftbox_redemption_items",
      columns: "redemption_id, giftbox_item_id, qty",
      where: `redemption_id IN (${placeholders})`,
      params: redIds,
    });
    for (const ri of redItems) {
      const red = redById.get(Number(ri.redemption_id ?? 0));
      if (!red) continue;
      const instanceId = Number(red.instance_id ?? 0);
      const itemId = Number(ri.giftbox_item_id ?? 0);
      const key = `${instanceId}:${itemId}`;
      const at = red.redeemed_at ? toIso(red.redeemed_at) : "";
      const prev = out.get(key) ?? { qty: 0, lastRedeemedAt: "" };
      out.set(key, {
        qty: prev.qty + Math.max(0, Number(ri.qty ?? 0)),
        lastRedeemedAt: at && at > prev.lastRedeemedAt ? at : prev.lastRedeemedAt,
      });
    }
  } catch {
    return out;
  }
  return out;
}

// Booked-qty per giftbox item: appointment_giftbox_items (redeemed_at IS NULL) tied
// to an OPEN appointment, keyed by instance_id:giftbox_item_id:service_id.
async function giftboxBookedMap(slug: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const linkTable = await tenantTable(slug, "appointment_giftbox_items");
    if (!(await tableExists(linkTable.name))) return out;
    const hasRedeemed = await columnExists(linkTable.name, "redeemed_at");
    const linkRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointment_giftbox_items",
      columns: "appointment_id, instance_id, giftbox_item_id, service_id, qty",
      where: hasRedeemed ? "redeemed_at IS NULL" : "",
    });
    if (linkRows.length === 0) return out;
    const openIds = await openAppointmentIds(slug, linkRows.map((r) => Number(r.appointment_id ?? 0)));
    for (const r of linkRows) {
      if (!openIds.has(Number(r.appointment_id ?? 0))) continue;
      const key = `${Number(r.instance_id ?? 0)}:${Number(r.giftbox_item_id ?? 0)}:${Number(r.service_id ?? 0)}`;
      out.set(key, (out.get(key) ?? 0) + Math.max(0, Number(r.qty ?? 0)));
    }
  } catch {
    return out;
  }
  return out;
}

// Decode a service snapshot JSON blob (package/giftbox) and return its stored name.
function snapshotServiceName(json: unknown): string {
  if (!json) return "";
  try {
    const data = JSON.parse(String(json));
    if (data && typeof data === "object" && typeof (data as { name?: unknown }).name === "string") {
      return String((data as { name: string }).name).trim();
    }
  } catch {
    return "";
  }
  return "";
}

// Package display status (port of _pos_pp_package_display_status).
function packageDisplayStatus(status: string, remaining: number, expiresAt: string): ClientPrepaidStatus {
  const s = status.trim().toLowerCase();
  if (s === "canceled" || s === "cancelled") return "cancelled";
  if (remaining <= 0 || s === "completed") return "completed";
  if (s === "expired") return "expired";
  if (expiresAt && /^\d{4}-\d{2}-\d{2}/.test(expiresAt) && expiresAt.slice(0, 10) < todayIso()) return "expired";
  return "active";
}

// GiftBox display status (port of _pos_pp_giftbox_display_status).
function giftboxDisplayStatus(status: string, remaining: number, expiresAt: string): ClientPrepaidStatus {
  const s = status.trim().toLowerCase();
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (remaining <= 0 || s === "redeemed") return "completed";
  if (s === "expired") return "expired";
  if (expiresAt && /^\d{4}-\d{2}-\d{2}/.test(expiresAt) && expiresAt.slice(0, 10) < todayIso()) return "expired";
  return "active";
}

export async function issueDbPrepaid(
  input: { clientId?: number; clientName?: string; serviceId?: number; quantity?: number; expiresAt?: string; sourceSaleId?: number },
  slug: string,
): Promise<ClientPrepaid> {
  const client = await resolveSaleClientForDb(slug, input.clientId ?? 0, input.clientName);
  const service = input.serviceId && input.serviceId > 0
    ? await getSingleService(slug, input.serviceId)
    : (await listDbServices({ slug, includeInactive: false }))[0];
  if (!service) throw new Error("Servizio prepagato non trovato.");
  const quantity = Math.max(1, Math.round(input.quantity ?? 1));
  const unitPrice = parseMoney(service.price, 0);
  const id = await tenantInsert(await tenantTable(slug, "client_prepaid_services"), {
    client_id: client.id,
    sale_id: input.sourceSaleId && input.sourceSaleId > 0 ? input.sourceSaleId : null,
    service_id: service.id,
    service_name: service.name,
    purchased_qty: quantity,
    remaining_qty: quantity,
    unit_price: unitPrice,
    total_paid: roundMoney(unitPrice * quantity),
    status: "active",
    purchase_date: new Date(),
    expires_at: input.expiresAt ?? addDaysDate(120),
  });
  return getSinglePrepaid(slug, id);
}

export async function consumeDbPrepaid(id: number, quantity: number, slug: string): Promise<ClientPrepaid> {
  const current = await getSinglePrepaid(slug, id);
  if (current.status !== "active") throw new Error("Prepagato non utilizzabile.");
  const usedQuantity = Math.max(1, Math.round(quantity));
  if (current.remainingQuantity < usedQuantity) throw new Error("Residuo prepagato insufficiente.");
  const remaining = current.remainingQuantity - usedQuantity;
  await tenantUpdate({
    slug,
    table: "client_prepaid_services",
    id,
    values: { remaining_qty: remaining, status: remaining <= 0 ? "completed" : "active" },
  });
  await tenantInsert(await tenantTable(slug, "client_prepaid_service_usages"), {
    client_prepaid_service_id: id,
    qty: usedQuantity,
    used_at: new Date(),
    note: "Esecuzione manuale",
  }).catch(() => 0);
  return getSinglePrepaid(slug, id);
}

// Faithful port of app/pages/pos_preorders.php: the preorders list merges THREE
// sources into one set of rows — sale_items with item_status='ordered'
// (kind 'sale'), PRODUCT lines inside active client_packages (kind 'package'),
// and PRODUCT lines inside issued/active giftbox instances (kind 'giftbox').
// Each row carries the source SALE id (for the "Dettaglio vendita" link), a
// location-aware product stock, and a computed stock status badge. All reads are
// tenant-scoped (tenantSelect), schema-guarded, and cross-table linkage (sale id
// for packages/giftboxes) is joined in memory to avoid cross-tenant raw joins.
export async function listDbPreorders(slug: string, options: { locationId?: number } = {}): Promise<Preorder[]> {
  const locationFilterId = Math.max(0, Number(options.locationId ?? 0));
  const rows: Preorder[] = [];

  // Whether preorder expiry actually applies to sale rows (PHP: PosSettings::preordersExpiryEnabled()).
  let preordersExpiryEnabled = false;
  try {
    const settingsTable = await tenantTable(slug, "pos_settings").catch(() => null);
    if (settingsTable) {
      const settingRows = await tenantSelect<RowDataPacket>({ slug, table: "pos_settings", columns: "preorders_expiry_enabled", where: "id=1", limit: 1 }).catch(() => [] as RowDataPacket[]);
      preordersExpiryEnabled = Number(settingRows[0]?.preorders_expiry_enabled ?? 0) === 1;
    }
  } catch {
    preordersExpiryEnabled = false;
  }

  // Location-aware stock reader (mirrors app_product_stock_row): when a location
  // is selected AND product_stocks exists, read that location's row; otherwise
  // fall back to products.stock. Cached per (productId, locationId) within the call.
  const stockCache = new Map<string, number>();
  const hasProductStocks = locationFilterId > 0 && (await tenantTable(slug, "product_stocks").then(() => true).catch(() => false));
  const productStockFor = async (productId: number, fallbackStock: number): Promise<number> => {
    if (productId <= 0) return Math.max(0, fallbackStock);
    if (locationFilterId <= 0 || !hasProductStocks) return Math.max(0, fallbackStock);
    const key = `${productId}:${locationFilterId}`;
    const cached = stockCache.get(key);
    if (cached !== undefined) return cached;
    const psRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "product_stocks",
      columns: "stock",
      where: "product_id=? AND location_id=?",
      params: [productId, locationFilterId],
      limit: 1,
    }).catch(() => [] as RowDataPacket[]);
    const value = Math.max(0, Number(psRows[0]?.stock ?? fallbackStock));
    stockCache.set(key, value);
    return value;
  };

  // Product metadata (name + base stock) for a set of product ids, tenant-scoped.
  const productMetaFor = async (productIds: number[]): Promise<Map<number, { name: string; stock: number }>> => {
    const map = new Map<number, { name: string; stock: number }>();
    const ids = Array.from(new Set(productIds.filter((id) => id > 0)));
    if (ids.length === 0) return map;
    const metaRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "products",
      columns: "id, name, stock",
      where: `id IN (${ids.map(() => "?").join(",")})`,
      params: ids,
    }).catch(() => [] as RowDataPacket[]);
    for (const meta of metaRows) {
      const pid = Number(meta.id ?? 0);
      if (pid > 0) map.set(pid, { name: String(meta.name ?? ""), stock: Number(meta.stock ?? 0) });
    }
    return map;
  };

  // Sales metadata: map sale id -> { date, locationId, cancelled }. Read for the
  // sale ids referenced by any source so links/dates/location filters resolve in
  // memory (no cross-tenant raw joins).
  const saleMetaFor = async (saleIds: number[]): Promise<Map<number, { date: string; locationId: number; cancelled: boolean }>> => {
    const map = new Map<number, { date: string; locationId: number; cancelled: boolean }>();
    const ids = Array.from(new Set(saleIds.filter((id) => id > 0)));
    if (ids.length === 0) return map;
    const salesRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "sales",
      columns: "id, sale_date, created_at, location_id, status",
      where: `id IN (${ids.map(() => "?").join(",")})`,
      params: ids,
    }).catch(() => [] as RowDataPacket[]);
    for (const s of salesRows) {
      const sid = Number(s.id ?? 0);
      if (sid <= 0) continue;
      const cancelled = ["cancelled", "canceled", "annullata", "annullato"].includes(String(s.status ?? "").trim().toLowerCase());
      map.set(sid, {
        date: toIso(s.sale_date ?? s.created_at),
        locationId: Number(s.location_id ?? 0),
        cancelled,
      });
    }
    return map;
  };

  const clientNameCache = new Map<number, string>();
  const clientNameFor = async (clientId: number): Promise<string> => {
    if (clientId <= 0) return "";
    const cached = clientNameCache.get(clientId);
    if (cached !== undefined) return cached;
    const name = await appointmentClientName(slug, clientId);
    const resolved = name === "Cliente" ? "" : name;
    clientNameCache.set(clientId, resolved);
    return resolved;
  };

  const stockStatusFor = (qty: number, stock: number, isExpired: boolean): PreorderStockStatus => {
    if (isExpired) return "expired";
    if (stock >= qty) return "ready";
    if (stock > 0) return "partial";
    return "insufficient";
  };

  const isRowExpired = (expiryApplies: boolean, expiresAt: string): boolean => {
    if (!expiryApplies) return false;
    const raw = String(expiresAt ?? "").trim();
    if (raw === "") return false;
    const ts = new Date(raw).getTime();
    return !Number.isNaN(ts) && ts < Date.now();
  };

  // ---- Source 1: sale_items with item_status = 'ordered' ----
  const saleItemsTable = await tenantTable(slug, "sale_items").catch(() => null);
  const salesTable = await tenantTable(slug, "sales").catch(() => null);
  const productsTable = await tenantTable(slug, "products").catch(() => null);
  if (saleItemsTable && salesTable && productsTable) {
    const hasItemStatus = await columnExists(saleItemsTable.name, "item_status");
    if (hasItemStatus) {
      const siRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "sale_items",
        columns: "id, sale_id, item_id, item_name, qty, item_status, preorder_expires_at",
        where: "item_type='product' AND COALESCE(item_id,0) > 0 AND LOWER(TRIM(COALESCE(item_status,''))) IN ('ordered','ordinato')",
        orderBy: "id DESC",
      }).catch(() => [] as RowDataPacket[]);

      const saleMeta = await saleMetaFor(siRows.map((r) => Number(r.sale_id ?? 0)));
      const productMeta = await productMetaFor(siRows.map((r) => Number(r.item_id ?? 0)));
      // Client id comes from the sale (PHP joins sales.client_id); resolve in memory.
      const saleClientMap = new Map<number, number>();
      const saleIdsForClients = Array.from(new Set(siRows.map((r) => Number(r.sale_id ?? 0)).filter((id) => id > 0)));
      if (saleIdsForClients.length > 0) {
        const saleClientRows = await tenantSelect<RowDataPacket>({
          slug,
          table: "sales",
          columns: "id, client_id",
          where: `id IN (${saleIdsForClients.map(() => "?").join(",")})`,
          params: saleIdsForClients,
        }).catch(() => [] as RowDataPacket[]);
        for (const s of saleClientRows) saleClientMap.set(Number(s.id ?? 0), Number(s.client_id ?? 0));
      }

      for (const row of siRows) {
        const saleId = Number(row.sale_id ?? 0);
        const productId = Number(row.item_id ?? 0);
        if (productId <= 0) continue;
        const meta = saleMeta.get(saleId);
        if (meta?.cancelled) continue;
        if (locationFilterId > 0 && (meta?.locationId ?? 0) !== locationFilterId) continue;
        const pMeta = productMeta.get(productId);
        const productName = (pMeta?.name || String(row.item_name ?? "")).trim() || `Prodotto #${productId}`;
        const qty = Math.max(1, Number(row.qty ?? 1));
        const stock = await productStockFor(productId, Number(pMeta?.stock ?? 0));
        const clientId = saleClientMap.get(saleId) ?? 0;
        const expiresAt = String(row.preorder_expires_at ?? "").slice(0, 10);
        const isExpired = isRowExpired(preordersExpiryEnabled, String(row.preorder_expires_at ?? ""));
        rows.push({
          id: Number(row.id ?? 0),
          clientId,
          clientName: await clientNameFor(clientId),
          productId,
          productName,
          quantity: qty,
          deposit: 0,
          dueDate: expiresAt || "",
          status: String(row.item_status ?? "") === "collected" ? "collected" : "open",
          createdAt: meta?.date ?? toIso(null),
          kind: "sale",
          saleId: saleId > 0 ? saleId : undefined,
          stock,
          stockStatus: stockStatusFor(qty, stock, isExpired),
          sourceRef: `Vendita #${saleId}`,
          sourceName: "",
          sourceCode: "",
          saleDate: meta?.date ?? "",
          expiresAt: expiresAt || undefined,
          expiryApplies: preordersExpiryEnabled,
          isExpired,
        });
      }
    }
  }

  // ---- Source 2: PRODUCT lines inside active client packages ----
  const cpTable = await tenantTable(slug, "client_packages").catch(() => null);
  const cpItemsTable = await tenantTable(slug, "client_package_items").catch(() => null);
  if (cpTable && cpItemsTable && productsTable) {
    const cpRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "client_packages",
      columns: "id, client_id, package_id, package_name, purchase_date, start_date, created_at, expires_at, status, location_id, sale_id",
      orderBy: "id DESC",
    }).catch(() => [] as RowDataPacket[]);

    const activeCps = cpRows.filter((cp) => {
      const status = String(cp.status ?? "active").trim().toLowerCase();
      if (status !== "active") return false;
      const expiresAt = String(cp.expires_at ?? "").trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(expiresAt) && expiresAt.slice(0, 10) < todayIso()) return false;
      return true;
    });

    if (activeCps.length > 0) {
      const cpById = new Map<number, RowDataPacket>();
      for (const cp of activeCps) cpById.set(Number(cp.id ?? 0), cp);
      const cpIds = Array.from(cpById.keys());
      const cpItemRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "client_package_items",
        columns: "id, client_package_id, item_type, item_id, qty, item_name_snapshot",
        where: `client_package_id IN (${cpIds.map(() => "?").join(",")}) AND item_type='product' AND COALESCE(item_id,0) > 0`,
        params: cpIds,
      }).catch(() => [] as RowDataPacket[]);

      const productMeta = await productMetaFor(cpItemRows.map((r) => Number(r.item_id ?? 0)));
      const saleMeta = await saleMetaFor(activeCps.map((cp) => Number(cp.sale_id ?? 0)));

      for (const item of cpItemRows) {
        const cp = cpById.get(Number(item.client_package_id ?? 0));
        if (!cp) continue;
        const productId = Number(item.item_id ?? 0);
        if (productId <= 0) continue;
        // Package location gate (PHP _pos_pre_client_package_allowed_for_location).
        if (locationFilterId > 0) {
          const pkgLocationId = Number(cp.location_id ?? 0);
          const saleId0 = Number(cp.sale_id ?? 0);
          const saleLocationId = saleId0 > 0 ? saleMeta.get(saleId0)?.locationId ?? 0 : 0;
          const effectiveLoc = pkgLocationId > 0 ? pkgLocationId : saleLocationId;
          if (effectiveLoc > 0 && effectiveLoc !== locationFilterId) continue;
        }
        const pMeta = productMeta.get(productId);
        const productName = (String(item.item_name_snapshot ?? "").trim() || pMeta?.name || "").trim() || `Prodotto #${productId}`;
        const qty = Math.max(1, Number(item.qty ?? 1));
        const stock = await productStockFor(productId, Number(pMeta?.stock ?? 0));
        const clientId = Number(cp.client_id ?? 0);
        const pkgId = Number(cp.id ?? 0);
        const saleId = Number(cp.sale_id ?? 0);
        const expiresAt = String(cp.expires_at ?? "").slice(0, 10);
        const isExpired = isRowExpired(true, String(cp.expires_at ?? ""));
        const saleDt = toIso(cp.purchase_date ?? cp.start_date ?? cp.created_at);
        rows.push({
          // Encode source in the id so merged keys stay unique across kinds.
          id: 2_000_000_000 + pkgId * 1000 + Number(item.id ?? 0) % 1000,
          clientId,
          clientName: await clientNameFor(clientId),
          productId,
          productName,
          quantity: qty,
          deposit: 0,
          dueDate: expiresAt || "",
          status: "open",
          createdAt: saleDt,
          kind: "package",
          saleId: saleId > 0 ? saleId : undefined,
          stock,
          stockStatus: stockStatusFor(qty, stock, isExpired),
          sourceRef: `Pacchetto CP#${pkgId}`,
          sourceName: String(cp.package_name ?? ""),
          sourceCode: `CP#${pkgId}`,
          saleDate: saleDt,
          expiresAt: expiresAt || undefined,
          expiryApplies: true,
          isExpired,
        });
      }
    }
  }

  // ---- Source 3: PRODUCT lines inside issued/active giftbox instances ----
  const gbInstTable = await tenantTable(slug, "giftbox_instances").catch(() => null);
  const gbItemsTable = await tenantTable(slug, "giftbox_instance_items").catch(() => null);
  if (gbInstTable && gbItemsTable && productsTable) {
    const gbRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "giftbox_instances",
      columns: "id, giftbox_id, code, client_id, recipient_client_id, status, issued_at, expires_at, updated_at",
      orderBy: "id DESC",
    }).catch(() => [] as RowDataPacket[]);

    const activeInstances = gbRows.filter((gi) => {
      const status = String(gi.status ?? "issued").trim().toLowerCase();
      if (!["issued", "active"].includes(status)) return false;
      const expiresAt = String(gi.expires_at ?? "").trim();
      if (expiresAt !== "") {
        const ts = new Date(expiresAt).getTime();
        if (!Number.isNaN(ts) && ts < Date.now()) return false;
      }
      return true;
    });

    if (activeInstances.length > 0) {
      const instById = new Map<number, RowDataPacket>();
      for (const gi of activeInstances) instById.set(Number(gi.id ?? 0), gi);
      const instIds = Array.from(instById.keys());
      const gbItemRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "giftbox_instance_items",
        columns: "id, instance_id, giftbox_item_id, item_type, product_id, qty",
        where: `instance_id IN (${instIds.map(() => "?").join(",")}) AND item_type='product' AND COALESCE(product_id,0) > 0`,
        params: instIds,
      }).catch(() => [] as RowDataPacket[]);

      // Redeemed qty per (instance, giftbox_item), tenant-scoped, joined in memory.
      const redeemMap = new Map<string, number>();
      const gbRedTable = await tenantTable(slug, "giftbox_redemptions").catch(() => null);
      const gbRedItemsTable = await tenantTable(slug, "giftbox_redemption_items").catch(() => null);
      if (gbRedTable && gbRedItemsTable && instIds.length > 0) {
        const redRows = await tenantSelect<RowDataPacket>({
          slug,
          table: "giftbox_redemptions",
          columns: "id, instance_id",
          where: `instance_id IN (${instIds.map(() => "?").join(",")})`,
          params: instIds,
        }).catch(() => [] as RowDataPacket[]);
        const redIdToInstance = new Map<number, number>();
        for (const rr of redRows) redIdToInstance.set(Number(rr.id ?? 0), Number(rr.instance_id ?? 0));
        const redIds = Array.from(redIdToInstance.keys());
        if (redIds.length > 0) {
          const redItemRows = await tenantSelect<RowDataPacket>({
            slug,
            table: "giftbox_redemption_items",
            columns: "redemption_id, giftbox_item_id, qty",
            where: `redemption_id IN (${redIds.map(() => "?").join(",")})`,
            params: redIds,
          }).catch(() => [] as RowDataPacket[]);
          for (const ri of redItemRows) {
            const instanceId = redIdToInstance.get(Number(ri.redemption_id ?? 0)) ?? 0;
            const gbItemId = Number(ri.giftbox_item_id ?? 0);
            if (instanceId <= 0 || gbItemId <= 0) continue;
            const key = `${instanceId}:${gbItemId}`;
            redeemMap.set(key, (redeemMap.get(key) ?? 0) + Math.max(0, Number(ri.qty ?? 0)));
          }
        }
      }

      const productMeta = await productMetaFor(gbItemRows.map((r) => Number(r.product_id ?? 0)));
      // Resolve source sale ids for giftboxes by code (notes/item_name LIKE '%CODE%'), in memory.
      const codeToSaleId = new Map<string, number>();
      const codes = Array.from(new Set(activeInstances.map((gi) => String(gi.code ?? "").trim().toUpperCase()).filter((c) => c !== "")));
      if (codes.length > 0 && saleItemsTable) {
        const gbSaleItemRows = await tenantSelect<RowDataPacket>({
          slug,
          table: "sale_items",
          columns: "sale_id, item_name",
          where: `(${codes.map(() => "UPPER(item_name) LIKE ?").join(" OR ")})`,
          params: codes.map((code) => `%${code}%`),
          orderBy: "sale_id DESC",
        }).catch(() => [] as RowDataPacket[]);
        for (const gsi of gbSaleItemRows) {
          const name = String(gsi.item_name ?? "").toUpperCase();
          const saleId = Number(gsi.sale_id ?? 0);
          if (saleId <= 0) continue;
          for (const code of codes) {
            if (!codeToSaleId.has(code) && name.includes(code)) codeToSaleId.set(code, saleId);
          }
        }
      }

      for (const item of gbItemRows) {
        const gi = instById.get(Number(item.instance_id ?? 0));
        if (!gi) continue;
        const productId = Number(item.product_id ?? 0);
        const instanceId = Number(item.instance_id ?? 0);
        const gbItemId = Number(item.giftbox_item_id ?? 0);
        if (productId <= 0 || instanceId <= 0 || gbItemId <= 0) continue;
        const qtyTotal = Math.max(1, Number(item.qty ?? 1));
        const qtyRedeemed = Math.max(0, redeemMap.get(`${instanceId}:${gbItemId}`) ?? 0);
        const qtyRemaining = Math.max(0, qtyTotal - qtyRedeemed);
        if (qtyRemaining <= 0) continue;
        const pMeta = productMeta.get(productId);
        const productName = (pMeta?.name || "").trim() || `Prodotto #${productId}`;
        const stock = await productStockFor(productId, Number(pMeta?.stock ?? 0));
        const clientId = Math.max(0, Number(gi.recipient_client_id ?? 0)) || Math.max(0, Number(gi.client_id ?? 0));
        const code = String(gi.code ?? "").trim();
        const saleId = codeToSaleId.get(code.toUpperCase()) ?? 0;
        // Giftbox location filter: gate by the resolved source-sale's location.
        if (locationFilterId > 0) {
          const saleLoc = saleId > 0 ? (await saleMetaFor([saleId])).get(saleId)?.locationId ?? 0 : 0;
          if (saleLoc > 0 && saleLoc !== locationFilterId) continue;
        }
        const expiresAt = String(gi.expires_at ?? "").slice(0, 10);
        const isExpired = isRowExpired(true, String(gi.expires_at ?? ""));
        const saleDt = toIso(gi.issued_at ?? gi.updated_at);
        rows.push({
          id: 3_000_000_000 + instanceId * 1000 + Number(item.id ?? 0) % 1000,
          clientId,
          clientName: await clientNameFor(clientId),
          productId,
          productName,
          quantity: qtyRemaining,
          deposit: 0,
          dueDate: expiresAt || "",
          status: "open",
          createdAt: saleDt,
          kind: "giftbox",
          saleId: saleId > 0 ? saleId : undefined,
          stock,
          stockStatus: stockStatusFor(qtyRemaining, stock, isExpired),
          sourceRef: `GiftBox ${code !== "" ? code : `#${instanceId}`}`,
          sourceName: "",
          sourceCode: code,
          saleDate: saleDt,
          expiresAt: expiresAt || undefined,
          expiryApplies: true,
          isExpired,
        });
      }
    }
  }

  // Sort by sale date ASC, then kind, then sale id, then id (PHP _pos_pre_sort_rows).
  const kindRank = (k?: string): number => (k === "sale" ? 0 : k === "package" ? 1 : k === "giftbox" ? 2 : 3);
  rows.sort((a, b) => {
    const ta = a.saleDate ? new Date(a.saleDate).getTime() : Number.MAX_SAFE_INTEGER;
    const tb = b.saleDate ? new Date(b.saleDate).getTime() : Number.MAX_SAFE_INTEGER;
    if (ta !== tb) return ta - tb;
    const ra = kindRank(a.kind);
    const rb = kindRank(b.kind);
    if (ra !== rb) return ra - rb;
    const sa = a.saleId ?? 0;
    const sb = b.saleId ?? 0;
    if (sa !== sb) return sa - sb;
    return a.id - b.id;
  });

  return rows;
}

export async function createDbPreorder(
  input: { clientId?: number; clientName?: string; productId?: number; quantity?: number; deposit?: number; dueDate?: string },
  slug: string,
): Promise<Preorder> {
  const client = await resolveSaleClientForDb(slug, input.clientId ?? 0, input.clientName);
  const product = input.productId && input.productId > 0
    ? await getSingleProduct(slug, input.productId)
    : (await listDbProducts({ slug }))[0];
  if (!product) throw new Error("Prodotto preordine non trovato.");
  const quantity = Math.max(1, Math.round(input.quantity ?? 1));
  const deposit = roundMoney(Math.max(0, Number(input.deposit ?? 0)));
  const saleId = await tenantInsert(await tenantTable(slug, "sales"), {
    client_id: client.id > 0 ? client.id : null,
    sale_date: new Date(),
    subtotal: deposit,
    discount: 0,
    total: deposit,
    notes: `Preordine ${product.name}`,
    status: "done",
  });
  const itemId = await tenantInsert(await tenantTable(slug, "sale_items"), {
    sale_id: saleId,
    item_type: "product",
    item_id: product.id,
    item_name: product.name,
    qty: quantity,
    unit_price: parseMoney(product.price, 0),
    line_total: roundMoney(parseMoney(product.price, 0) * quantity),
    item_status: "ordered",
    preorder_expires_at: input.dueDate ?? addDaysDate(14),
  });
  return getSinglePreorder(slug, itemId);
}

export async function collectDbPreorder(id: number, slug: string): Promise<Preorder> {
  const preorder = await getSinglePreorder(slug, id);
  if (preorder.status !== "open") throw new Error("Preordine non ritirabile.");
  const product = await getSingleProduct(slug, preorder.productId);
  if (product.stock < preorder.quantity) throw new Error("Giacenza insufficiente per ritiro preordine.");
  await decrementProductStock(slug, product.id, preorder.quantity);
  await tenantUpdate({ slug, table: "sale_items", id, values: { item_status: "collected" } });
  return getSinglePreorder(slug, id);
}

export async function listDbCoupons(slug: string): Promise<CouponRule[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "coupons",
    where: "deleted_at IS NULL",
    orderBy: "code ASC",
  });
  return Promise.all(rows.map((row) => mapCoupon(slug, row)));
}

export async function createDbCoupon(input: Partial<CouponRule>, slug: string): Promise<CouponRule> {
  const code = normalizeCouponCode(String(input.code ?? ""));
  if (!code) throw new Error("Codice coupon mancante.");
  const existing = await tenantSelect<RowDataPacket>({ slug, table: "coupons", columns: "id", where: "code = ? AND deleted_at IS NULL", params: [code], limit: 1 });
  if (existing[0]) throw new Error("Coupon gia esistente.");
  const id = await tenantInsert(await tenantTable(slug, "coupons"), {
    code,
    description: code,
    discount_type: input.type === "fixed" ? "fixed" : "percent",
    discount_value: roundMoney(Math.max(0, Number(input.value ?? 0))),
    min_subtotal: roundMoney(Math.max(0, Number(input.minSubtotal ?? 0))),
    valid_from: input.startsAt ?? todayIso(),
    valid_to: input.endsAt ?? addDaysDate(30),
    is_active: input.active === false ? 0 : 1,
    usage_limit: Math.max(0, Math.round(Number(input.usageLimit ?? 0))),
    apply_scope: "all",
  });
  return getSingleCoupon(slug, id);
}

// Optional booking context forwarded from the quick-booking drawer's coupon preview
// (port of the legacy api_appointments action=coupon_preview inputs). Every field is
// optional so the plain (code, subtotal, slug) call from the POS still works unchanged.
// Currently only `apptDate` affects the outcome — the coupon active-window is validated
// AS OF the appointment date (like the legacy coupon_validate_row($appt_date)) instead of
// today, so a coupon that is valid on the booked day previews correctly. The remaining
// fields (serviceIds, locationId, clientId, appointmentId) are accepted for forward-compat
// (the migrated Postgres coupons have no per-scope / per-client / per-location restriction
// columns, so they do not yet change the result — see the TODO).
export type CouponPreviewContext = {
  serviceIds?: number[];
  locationId?: number | null;
  clientId?: number | null;
  appointmentId?: number | null;
  apptDate?: string | null;
  apptTime?: string | null;
};

export async function previewDbCoupon(
  code: string,
  subtotal: number,
  slug: string,
  context?: CouponPreviewContext,
): Promise<{ valid: boolean; discount: number; reason: string; coupon?: CouponRule }> {
  const coupon = await getCouponByCode(slug, code);
  if (!coupon) return { valid: false, discount: 0, reason: "Coupon non trovato." };
  // Validate the active window AS OF the appointment date when supplied (legacy parity);
  // fall back to today otherwise. A malformed date is ignored (uses today).
  const rawDate = String(context?.apptDate ?? "").trim();
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : undefined;
  if (!coupon.active || !activeWindow(coupon.startsAt, coupon.endsAt, asOf)) return { valid: false, discount: 0, reason: "Coupon non attivo.", coupon };
  if (coupon.usageLimit > 0 && coupon.usedCount >= coupon.usageLimit) return { valid: false, discount: 0, reason: "Coupon esaurito.", coupon };
  if (subtotal < coupon.minSubtotal) return { valid: false, discount: 0, reason: "Minimo carrello non raggiunto.", coupon };
  // TODO(coupon apply_scope): the legacy also honours the coupon's apply_scope (restricting
  // the eligible subtotal to a service/product allow-list) and per-location/per-client rules.
  // The migrated coupons table has no such columns yet, so the whole payable subtotal is used.
  return { valid: true, discount: discountValue(coupon.type, coupon.value, subtotal), reason: "Coupon valido.", coupon };
}

export async function redeemDbCoupon(code: string, subtotal: number, slug: string): Promise<{ coupon: CouponRule; discount: number }> {
  const preview = await previewDbCoupon(code, subtotal, slug);
  if (!preview.valid || !preview.coupon) throw new Error(preview.reason);
  return { coupon: preview.coupon, discount: preview.discount };
}

// Editable coupon record for the NEW / EDIT form. Extends the list CouponRule
// with the description + apply_scope columns that the coupons.php editor posts
// but the dashboard list does not surface, plus the edit-view audit fields
// (created/cancelled by/at/reason + active usage + can-cancel) shown in the
// legacy status card above the form.
export type ManageCouponRecord = CouponRule & {
  description: string;
  applyScope: string;
  createdAt: string;
  createdByLabel: string;
  cancelledAt: string;
  cancelledByLabel: string;
  cancelledReason: string;
  activeUsedCount: number;
  canCancel: boolean;
  serviceCategoryIds: number[];
  serviceIds: number[];
  productCategoryIds: number[];
  productIds: number[];
  locationIds: number[];
};

// Resolve a user id to a display label (name || email || #id), like the legacy
// audit-field lookup. Returns "—" for a missing/zero id.
async function couponUserLabel(slug: string, id: number): Promise<string> {
  if (!id || id <= 0) return "—";
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "users", columns: "name, email", where: "id = ?", params: [id], limit: 1 }).catch(() => [] as RowDataPacket[]);
  if (!rows[0]) return `#${id}`;
  const name = String(rows[0].name ?? "").trim();
  if (name !== "") return name;
  const email = String(rows[0].email ?? "").trim();
  return email !== "" ? email : `#${id}`;
}

// Edit-form prefill: return ONE coupon's editable fields for one id. Port of
// coupons.php action=edit (loads the coupons row + the audit status card).
// Reuses mapCoupon (the list pipeline) and reads the extra
// description/apply_scope + audit columns directly.
export async function getManageCoupon(slug: string, id: number): Promise<ManageCouponRecord | null> {
  if (id <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "coupons", where: "id = ? AND deleted_at IS NULL", params: [id], limit: 1 });
  if (!rows[0]) return null;
  const row = rows[0];
  const base = await mapCoupon(slug, row);
  const stats = await couponUsageStats(slug, base);
  // toIso() substitutes "now" for null, so guard the nullable audit timestamps.
  const isoOrEmpty = (v: unknown): string => (v ? toIso(v) : "");
  return {
    ...base,
    description: String(row.description ?? ""),
    applyScope: String(row.apply_scope ?? "all"),
    createdAt: isoOrEmpty(row.created_at),
    createdByLabel: await couponUserLabel(slug, Number(row.created_by ?? 0)),
    cancelledAt: isoOrEmpty(row.cancelled_at),
    cancelledByLabel: await couponUserLabel(slug, Number(row.cancelled_by ?? 0)),
    cancelledReason: String(row.cancelled_reason ?? ""),
    activeUsedCount: stats.activeUsedCount,
    canCancel: Number(row.is_active ?? 0) === 1 && !row.deleted_at,
    serviceCategoryIds: decodeCouponIdsJson(row.service_category_ids_json),
    serviceIds: decodeCouponIdsJson(row.service_ids_json),
    productCategoryIds: decodeCouponIdsJson(row.product_category_ids_json),
    productIds: decodeCouponIdsJson(row.product_ids_json),
    // Edit default (legacy): the coupon's saved sedi, or ALL active sedi when none saved.
    locationIds: await couponSelectedLocationIds(slug, id),
  };
}

// The coupon's enabled sedi (coupon_locations); when none are saved the legacy
// edit form pre-checks ALL active sedi, so mirror that default here.
async function couponSelectedLocationIds(slug: string, couponId: number): Promise<number[]> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "coupon_locations", columns: "location_id", where: "coupon_id = ?", params: [couponId] }).catch(() => [] as RowDataPacket[]);
  const ids = rows.map((r) => Number(r.location_id ?? 0)).filter((n) => n > 0);
  return ids.length > 0 ? ids : activeLocationIds(slug);
}

// Catalog options + active sedi for the coupon NEW/EDIT form (port of the legacy
// $serviceCategoryOptions/$serviceOptions/$productCategoryOptions/$productOptions
// + $couponActiveLocations). Categories are limited to those that actually have
// services/products (like the legacy EXISTS filter).
export type CouponFormContext = {
  locations: { id: number; name: string }[];
  serviceCategories: { id: number; name: string }[];
  services: { id: number; name: string; categoryName: string }[];
  productCategories: { id: number; name: string }[];
  products: { id: number; name: string; sku: string }[];
  defaultLocationIds: number[];
};

export async function getCouponFormContext(slug: string): Promise<CouponFormContext> {
  const locRows = await tenantSelect<RowDataPacket>({ slug, table: "locations", columns: "id, name", where: "COALESCE(is_active,1) = 1", orderBy: "COALESCE(sort_order,999999) ASC, name ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  const locations = locRows.map((r) => ({ id: Number(r.id ?? 0), name: String(r.name ?? `Sede #${r.id}`) })).filter((l) => l.id > 0);

  const svcCatRows = await tenantSelect<RowDataPacket>({ slug, table: "service_categories", columns: "id, name", orderBy: "name ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  const svcRows = await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "id, name, category_id", orderBy: "name ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  const svcCatName = new Map<number, string>();
  for (const r of svcCatRows) svcCatName.set(Number(r.id ?? 0), String(r.name ?? ""));
  const svcCatUsed = new Set<number>();
  for (const r of svcRows) { const cid = Number(r.category_id ?? 0); if (cid > 0) svcCatUsed.add(cid); }
  const serviceCategories = svcCatRows.map((r) => ({ id: Number(r.id ?? 0), name: String(r.name ?? "") })).filter((c) => c.id > 0 && svcCatUsed.has(c.id));
  const services = svcRows.map((r) => ({ id: Number(r.id ?? 0), name: String(r.name ?? ""), categoryName: svcCatName.get(Number(r.category_id ?? 0)) ?? "" })).filter((s) => s.id > 0);

  const prodCatRows = await tenantSelect<RowDataPacket>({ slug, table: "product_categories", columns: "id, name", orderBy: "name ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  const prodRows = await tenantSelect<RowDataPacket>({ slug, table: "products", columns: "id, name, sku, category_id", orderBy: "name ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  const prodCatUsed = new Set<number>();
  for (const r of prodRows) { const cid = Number(r.category_id ?? 0); if (cid > 0) prodCatUsed.add(cid); }
  const productCategories = prodCatRows.map((r) => ({ id: Number(r.id ?? 0), name: String(r.name ?? "") })).filter((c) => c.id > 0 && prodCatUsed.has(c.id));
  const products = prodRows.map((r) => ({ id: Number(r.id ?? 0), name: String(r.name ?? ""), sku: String(r.sku ?? "") })).filter((p) => p.id > 0);

  return { locations, serviceCategories, services, productCategories, products, defaultLocationIds: locations.map((l) => l.id) };
}

// Parse a coupon scope / location id-list from a body field. Accepts a
// JSON-array string (the form sends the nested arrays as JSON so they survive
// parseRequestBody's top-level flatten — the [object Object] trap) or a plain
// comma-separated list. Returns unique positive ids.
function parseCouponIdList(raw: unknown): number[] {
  let src: unknown = raw;
  if (typeof src === "string") {
    const s = src.trim();
    if (s === "") return [];
    if (s.startsWith("[")) {
      try { src = JSON.parse(s); } catch { src = s.split(","); }
    } else {
      src = s.split(",");
    }
  }
  if (!Array.isArray(src)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const v of src) {
    const n = Math.trunc(Number(v));
    if (n > 0 && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

// Serialize an id-list to the JSON stored in the *_ids_json columns (null when empty).
function couponJsonIds(ids: number[]): string | null {
  return ids.length ? JSON.stringify(ids) : null;
}

// Decode a coupon *_ids_json column back to an id-list (tolerant of JSON or CSV).
function decodeCouponIdsJson(raw: unknown): number[] {
  return parseCouponIdList(raw);
}

// True when a Promotion already owns this coupon_code (port of coupons_promo_code_exists).
async function couponPromoCodeExists(slug: string, code: string): Promise<boolean> {
  const norm = normalizeCouponCode(code);
  if (norm === "") return false;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "promotions", columns: "id", where: "UPPER(COALESCE(coupon_code,'')) = ?", params: [norm], limit: 1 }).catch(() => [] as RowDataPacket[]);
  return rows.length > 0;
}

// Active location ids for the tenant (for the "almeno una sede" gate + form defaults).
async function activeLocationIds(slug: string): Promise<number[]> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "locations", columns: "id", where: "COALESCE(is_active,1) = 1", orderBy: "COALESCE(sort_order,999999) ASC, name ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  return rows.map((r) => Number(r.id ?? 0)).filter((n) => n > 0);
}

// Replace a coupon's enabled sedi (coupon_locations): clear then re-insert.
async function syncCouponLocations(slug: string, couponId: number, locationIds: number[]): Promise<void> {
  const table = await tenantTable(slug, "coupon_locations").catch(() => null);
  if (!table) return;
  await deleteCouponLocations(slug, couponId);
  for (const lid of locationIds) {
    await tenantInsert(table, { coupon_id: couponId, location_id: lid }).catch(() => 0);
  }
}

// Create / update a coupon rule, faithful to coupons.php POST(action=new|edit).
// On create the code is required + validated, must be unique and must not clash
// with a Promotion code; on edit the code is immutable (the legacy form renders
// it readonly). Persists the scope-restricted catalogs (service/product id
// lists) as the *_ids_json columns and syncs coupon_locations, with the legacy
// scope + "almeno una sede" validation.
export async function saveManageCoupon(slug: string, body: Record<string, string>, id: number): Promise<ManageCouponRecord> {
  let type = String(body.discount_type ?? "percent").trim().toLowerCase();
  if (type === "amount") type = "fixed";
  if (type !== "percent" && type !== "fixed") type = "percent";

  let value = roundMoney(Math.max(0, Number(String(body.discount_value ?? "0").replace(",", ".")) || 0));
  if (type === "percent" && value > 100) value = 100;
  if (value <= 0) throw new Error("Inserisci un valore valido.");

  const minSubtotal = roundMoney(Math.max(0, Number(String(body.min_subtotal ?? "0").replace(",", ".")) || 0));
  const usageLimit = Math.max(0, Math.round(Number(body.usage_limit ?? 0) || 0));
  let scope = normalizeCouponScope(String(body.apply_scope ?? "all_services_products"));
  if (scope === "all" && id <= 0) scope = "all_services_products";
  const description = String(body.description ?? "").trim();
  const from = normalizeClientDate(body.valid_from);
  const to = normalizeClientDate(body.valid_to);
  if ((String(body.valid_from ?? "").trim() !== "" && !from) || (String(body.valid_to ?? "").trim() !== "" && !to)) {
    throw new Error("Formato data non valido.");
  }
  if (from && to && from > to) throw new Error('La data "Valido al" deve essere successiva o uguale a "Valido dal".');

  // Scope-restricted catalogs (persisted as *_ids_json) + the enabled sedi.
  const serviceCategoryIds = parseCouponIdList(body.service_category_ids);
  const serviceIds = parseCouponIdList(body.service_ids);
  const productCategoryIds = parseCouponIdList(body.product_category_ids);
  const productIds = parseCouponIdList(body.product_ids);
  const couponLocationIds = parseCouponIdList(body.coupon_location_ids);

  // Scope validation (port of coupons.php $scopeError).
  if (scope === "service_categories" && serviceCategoryIds.length === 0) throw new Error("Seleziona almeno una categoria di servizi.");
  if (scope === "services" && serviceIds.length === 0) throw new Error("Seleziona almeno un servizio.");
  if (scope === "product_categories" && productCategoryIds.length === 0) throw new Error("Seleziona almeno una categoria di prodotti.");
  if (scope === "products" && productIds.length === 0) throw new Error("Seleziona almeno un prodotto.");
  // "Seleziona almeno una sede abilitata" when the tenant has active sedi.
  const activeLocs = await activeLocationIds(slug);
  if (activeLocs.length > 0 && couponLocationIds.length === 0) throw new Error("Seleziona almeno una sede abilitata.");

  const values: Record<string, unknown> = {
    description: description !== "" ? description : null,
    discount_type: type,
    discount_value: value,
    min_subtotal: minSubtotal,
    usage_limit: usageLimit,
    apply_scope: scope,
    service_category_ids_json: couponJsonIds(serviceCategoryIds),
    service_ids_json: couponJsonIds(serviceIds),
    product_category_ids_json: couponJsonIds(productCategoryIds),
    product_ids_json: couponJsonIds(productIds),
    valid_from: from,
    valid_to: to,
  };

  let couponId = id;
  if (couponId > 0) {
    const existing = await tenantSelect<RowDataPacket>({ slug, table: "coupons", where: "id = ? AND deleted_at IS NULL", params: [couponId], limit: 1 });
    if (!existing[0]) throw new Error("Coupon non trovato.");
    await tenantUpdate({ slug, table: "coupons", id: couponId, values });
  } else {
    const code = normalizeCouponCode(String(body.code ?? ""));
    if (!code) throw new Error("Inserisci un codice.");
    if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(code)) throw new Error("Codice non valido. Usa solo lettere, numeri, - e _. (Max 40)");
    const dup = await tenantSelect<RowDataPacket>({ slug, table: "coupons", columns: "id", where: "code = ? AND deleted_at IS NULL", params: [code], limit: 1 });
    if (dup[0]) throw new Error("Esiste gia un coupon con questo codice.");
    if (await couponPromoCodeExists(slug, code)) throw new Error("Questo codice è già utilizzato da una Promozione. Scegli un codice diverso.");
    couponId = await tenantInsert(await tenantTable(slug, "coupons"), { ...values, code, is_active: 1 });
  }

  await syncCouponLocations(slug, couponId, couponLocationIds);

  const saved = await getManageCoupon(slug, couponId);
  if (!saved) throw new Error("Coupon non salvato.");
  return saved;
}

function normalizeCouponScope(value: string): string {
  const scope = value.trim().toLowerCase();
  const allowed = ["all", "service_categories", "services", "product_categories", "products", "all_services_products"];
  return allowed.includes(scope) ? scope : "all_services_products";
}

// Usage stats for a coupon code (port of coupons.php coupons_usage_stats). Counts
// sales (matched by coupon_code OR the "Coupon: CODE" notes marker) + appointments
// (matched by the notes marker only — the migrated appointments table has no
// coupon_code column), how many of those appointments are still OPEN
// (pending/scheduled), and for a fixed-amount coupon the consumed amount + residual.
// Drives the delete guard (open appts block deletion; any usage forces a
// history-preserving soft-delete) and the list/edit "Utilizzi" display.
export type CouponUsageStats = {
  salesCount: number;
  appointmentsCount: number;
  openAppointmentsCount: number;
  usedCount: number;
  activeUsedCount: number;
  hasUsage: boolean;
  usedAmount: number;
  residual: number | null;
  fullyUsed: boolean;
  partial: boolean;
};

async function couponUsageStats(
  slug: string,
  coupon: { code: string; type: "fixed" | "percent"; value: number },
): Promise<CouponUsageStats> {
  const code = normalizeCouponCode(coupon.code);
  const residualBase = coupon.type === "fixed" ? roundMoney(Math.max(0, coupon.value)) : null;
  if (code === "") {
    return { salesCount: 0, appointmentsCount: 0, openAppointmentsCount: 0, usedCount: 0, activeUsedCount: 0, hasUsage: false, usedAmount: 0, residual: residualBase, fullyUsed: false, partial: false };
  }
  const likeNeedle = `%${`Coupon: ${code}`.toUpperCase()}%`;

  let salesCount = 0;
  let appointmentsCount = 0;
  let openAppointmentsCount = 0;
  let activeSales = 0;
  let activeAppts = 0;
  let usedAmount = 0;

  // Sales history: prefer coupon_code, fall back to the notes marker (like the legacy).
  const salesRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "sales",
    columns: "id, subtotal, discount, coupon_code, notes, status",
    where: "UPPER(COALESCE(coupon_code,'')) = ? OR UPPER(COALESCE(notes,'')) LIKE ?",
    params: [code, likeNeedle],
  }).catch(() => [] as RowDataPacket[]);
  for (const r of salesRows) {
    const meta = extractCouponMetaFromNotes(r.notes);
    const storedCode = normalizeCouponCode(String(r.coupon_code ?? ""));
    const rowCode = storedCode !== "" ? storedCode : normalizeCouponCode(meta.code);
    if (rowCode !== code) continue;
    salesCount++;
    const isCancelled = String(r.status ?? "").trim().toLowerCase() === "cancelled";
    if (!isCancelled) activeSales++;
    const subtotal = Math.max(0, Number(r.subtotal ?? 0));
    let disc: number | null = null;
    if (meta.discount > 0) disc = meta.discount;
    else if (r.discount !== null && r.discount !== undefined && String(r.discount) !== "") disc = Number(r.discount);
    if (disc !== null && !isCancelled) {
      disc = Math.max(0, disc);
      if (disc > subtotal && subtotal > 0) disc = subtotal;
      usedAmount += disc;
    }
  }

  // Appointment history: the coupon snapshot lives in the notes marker only.
  const apptRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointments",
    columns: "id, notes, status",
    where: "UPPER(COALESCE(notes,'')) LIKE ?",
    params: [likeNeedle],
  }).catch(() => [] as RowDataPacket[]);
  for (const r of apptRows) {
    const meta = extractCouponMetaFromNotes(r.notes);
    if (normalizeCouponCode(meta.code) !== code) continue;
    appointmentsCount++;
    const st = String(r.status ?? "").trim().toLowerCase();
    if (st === "pending" || st === "scheduled") openAppointmentsCount++;
    const isCancelled = st === "canceled" || st === "cancelled" || st === "no_show";
    if (!isCancelled) activeAppts++;
    if (meta.discount > 0 && !isCancelled) usedAmount += Math.max(0, meta.discount);
  }

  usedAmount = roundMoney(Math.max(0, usedAmount));
  const usedCount = salesCount + appointmentsCount;
  const hasUsage = usedCount > 0;
  let residual = residualBase;
  let fullyUsed = false;
  let partial = false;
  if (coupon.type === "fixed") {
    const total = Math.max(0, coupon.value);
    residual = roundMoney(Math.max(0, total - usedAmount));
    fullyUsed = hasUsage && residual <= 0.00001;
    partial = hasUsage && usedAmount > 0.00001 && residual > 0.00001;
  } else {
    partial = hasUsage;
  }
  return { salesCount, appointmentsCount, openAppointmentsCount, usedCount, activeUsedCount: activeSales + activeAppts, hasUsage, usedAmount, residual, fullyUsed, partial };
}

// Remove a coupon's coupon_locations rows (tenant-scoped), before a hard delete.
async function deleteCouponLocations(slug: string, couponId: number): Promise<void> {
  const table = await tenantTable(slug, "coupon_locations").catch(() => null);
  if (!table) return;
  const scoped = table.mode === "shared" && (await columnExists(table.name, "tenant_id"));
  await dbExecute(
    `DELETE FROM ${quoteIdentifier(table.name)} WHERE coupon_id = ?${scoped ? " AND tenant_id = ?" : ""}`,
    scoped ? [couponId, table.tenantId ?? 0] : [couponId],
  ).catch(() => undefined);
}

// Delete a coupon (port of coupons.php action=delete). Refuses while OPEN
// appointments still reference it; soft-deletes (deleted_at + is_active=0, so the
// sales/appointment history is preserved) when it has any usage; hard-deletes
// (with its coupon_locations) only when entirely unused.
export async function deleteManageCoupon(
  slug: string,
  id: number,
  by: number,
): Promise<{ ok: true; mode: "hard" | "soft"; message: string }> {
  if (id <= 0) throw new Error("ID coupon mancante.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "coupons", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Coupon non trovato.");
  if (rows[0].deleted_at) throw new Error("Coupon gia eliminato dalla gestione.");
  const coupon = await mapCoupon(slug, rows[0]);
  const stats = await couponUsageStats(slug, coupon);
  if (stats.openAppointmentsCount > 0) {
    throw new Error("Coupon associato a prenotazioni in sospeso/prenotate: non puo essere eliminato finche restano aperte.");
  }
  const byId = by > 0 ? by : null;
  if (stats.hasUsage) {
    const note = "Eliminato dalla gestione: storico vendite/prenotazioni conservato.";
    await tenantUpdate({
      slug,
      table: "coupons",
      id,
      values: {
        is_active: 0,
        deleted_at: new Date(),
        deleted_by: byId,
        deleted_reason: note,
        cancelled_at: rows[0].cancelled_at ?? new Date(),
        cancelled_by: rows[0].cancelled_by ?? byId,
        cancelled_reason: (rows[0].cancelled_reason as string) || note,
      },
    });
    return { ok: true, mode: "soft", message: "Coupon eliminato dalla gestione. Lo storico vendite/prenotazioni resta invariato." };
  }
  await deleteCouponLocations(slug, id);
  await tenantDelete({ slug, table: "coupons", id });
  return { ok: true, mode: "hard", message: "Coupon eliminato." };
}

// Disable a coupon (port of coupons.php action=cancel): is_active=0 + audit
// (cancelled_at/by/reason). Already-associated sales/appointments keep the
// historical coupon snapshot. Refuses when the coupon is already disabled.
export async function cancelManageCoupon(
  slug: string,
  id: number,
  reason: string,
  by: number,
): Promise<{ ok: true }> {
  if (id <= 0) throw new Error("ID coupon mancante.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "coupons", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Coupon non trovato.");
  if (rows[0].deleted_at) throw new Error("Coupon gia eliminato dalla gestione.");
  if (Number(rows[0].is_active ?? 0) !== 1) throw new Error("Coupon gia disattivato.");
  let clean = String(reason ?? "").trim();
  if (clean.length > 255) clean = clean.slice(0, 255);
  const byId = by > 0 ? by : null;
  await tenantUpdate({
    slug,
    table: "coupons",
    id,
    values: {
      is_active: 0,
      cancelled_at: rows[0].cancelled_at ?? new Date(),
      cancelled_by: rows[0].cancelled_by ?? byId,
      cancelled_reason: (rows[0].cancelled_reason as string) || (clean !== "" ? clean : null),
    },
  });
  return { ok: true };
}

// Human label for a coupon apply_scope (port of coupons_scope_label).
function couponScopeLabel(scope: string): string {
  const s = normalizeCouponScope(scope);
  if (s === "service_categories") return "Categorie servizi";
  if (s === "services") return "Servizi";
  if (s === "product_categories") return "Categorie prodotti";
  if (s === "products") return "Prodotti";
  if (s === "all_services_products") return "Tutti servizi + prodotti";
  return "Tutto il carrello";
}

// Enriched coupon row for the faithful management LIST (port of the coupons.php
// list table): the base CouponRule plus the description, the apply_scope + its
// human label (Ambito column), the enabled-sedi label (Sedi column) and the
// active usage count (the list "Totali attivi" line). Kept separate from
// listDbCoupons (consumed by POS/booking) so those lighter callers don't pay
// for the per-row usage-stats + location joins.
export type ManageCouponListRow = CouponRule & {
  description: string;
  applyScope: string;
  scopeLabel: string;
  locationLabel: string;
  activeUsedCount: number;
};

export async function listManageCoupons(slug: string): Promise<ManageCouponListRow[]> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "coupons", where: "deleted_at IS NULL", orderBy: "code ASC" });

  // coupon_id -> [location_id] (the enabled sedi per coupon) + location names.
  const locRows = await tenantSelect<RowDataPacket>({ slug, table: "coupon_locations", columns: "coupon_id, location_id" }).catch(() => [] as RowDataPacket[]);
  const locByCoupon = new Map<number, number[]>();
  for (const r of locRows) {
    const cid = Number(r.coupon_id ?? 0);
    const lid = Number(r.location_id ?? 0);
    if (cid > 0 && lid > 0) {
      const arr = locByCoupon.get(cid) ?? [];
      arr.push(lid);
      locByCoupon.set(cid, arr);
    }
  }
  const locNameRows = await tenantSelect<RowDataPacket>({ slug, table: "locations", columns: "id, name" }).catch(() => [] as RowDataPacket[]);
  const locName = new Map<number, string>();
  for (const r of locNameRows) locName.set(Number(r.id ?? 0), String(r.name ?? `Sede #${r.id}`));

  const out: ManageCouponListRow[] = [];
  for (const row of rows) {
    const base = await mapCoupon(slug, row);
    const stats = await couponUsageStats(slug, base);
    const ids = locByCoupon.get(base.id) ?? [];
    const locationLabel = ids.length === 0 ? "Tutte" : ids.map((lid) => locName.get(lid) ?? `Sede #${lid}`).join(", ");
    out.push({
      ...base,
      description: String(row.description ?? ""),
      applyScope: String(row.apply_scope ?? "all"),
      scopeLabel: couponScopeLabel(String(row.apply_scope ?? "all")),
      locationLabel,
      activeUsedCount: stats.activeUsedCount,
    });
  }
  return out;
}

export async function listDbPromotions(slug: string): Promise<PromotionRule[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "promotions",
    orderBy: "priority DESC, title ASC",
  });
  return rows.map(mapPromotion);
}

export async function toggleDbPromotion(id: number, active: boolean, slug: string): Promise<PromotionRule> {
  await tenantUpdate({ slug, table: "promotions", id, values: { is_active: active ? 1 : 0 } });
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "promotions", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Promozione non trovata.");
  return mapPromotion(rows[0]);
}

export async function previewDbPromotion(id: number, subtotal: number, slug: string): Promise<{ valid: boolean; discount: number; reason: string; promotion?: PromotionRule }> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "promotions", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) return { valid: false, discount: 0, reason: "Promozione non trovata." };
  const promotion = mapPromotion(rows[0]);
  if (!promotion.active || !activeWindow(promotion.startsAt, promotion.endsAt)) return { valid: false, discount: 0, reason: "Promozione non attiva.", promotion };
  return { valid: true, discount: discountValue(promotion.discountType, promotion.discountValue, subtotal), reason: "Promozione valida.", promotion };
}

// Editable promotion record for the NEW / EDIT form. Extends the list
// PromotionRule with the extra columns the promotions.php editor posts
// (description, target windows, apply modes, conditions) that the dashboard list
// does not surface.
export type PromoItemRow = { id: number; discountType: "percent" | "fixed"; discountValue: number; minQty: number };
export type ManagePromotionRecord = PromotionRule & {
  description: string;
  applyServicesMode: "none" | "all" | "selected";
  applyProductsMode: "none" | "all" | "selected";
  minQty: string;
  productsDiscountType: "percent" | "fixed";
  productsDiscountValue: string;
  newWithinDays: string;
  inactiveDays: string;
  birthdayWindowDays: string;
  perCustomerLimit: string;
  promoConditionsEnabled: boolean;
  promoConditions: string;
  marketplaceVisibility: "auto" | "hidden";
  stackableFidelity: boolean;
  stackableCoupon: boolean;
  selectedServices: PromoItemRow[];
  selectedProducts: PromoItemRow[];
  locationIds: number[];
  timeWindows: { day: number; start: string; end: string }[];
  blackoutDates: string[];
  targetFidelityLevels: string[];
  excludedClientIds: number[];
};

// Edit-form prefill: return ONE promotion's editable fields for one id. Port of
// promotions.php action=edit (Promotions::get). Reuses mapPromotion (the list
// pipeline) and reads the extra editable columns directly from the row.
export async function getManagePromotion(slug: string, id: number): Promise<ManagePromotionRecord | null> {
  if (id <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "promotions", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) return null;
  const row = rows[0];

  const mapItems = (childRows: RowDataPacket[], refCol: string): PromoItemRow[] =>
    childRows.map((r) => {
      let dt = String(r.discount_type ?? "").toLowerCase();
      if (dt !== "percent" && dt !== "fixed") dt = "percent";
      return { id: Number(r[refCol] ?? 0), discountType: dt as "percent" | "fixed", discountValue: roundMoney(Number(r.discount_value ?? 0)), minQty: Math.max(1, Number(r.min_qty ?? 1) || 1) };
    });
  const [svcRows, prdRows, locRows, twRows, boRows] = await Promise.all([
    tenantSelect<RowDataPacket>({ slug, table: "promotion_services", columns: "service_id, discount_type, discount_value, min_qty", where: "promotion_id = ?", params: [id], orderBy: "service_id ASC" }).catch(() => [] as RowDataPacket[]),
    tenantSelect<RowDataPacket>({ slug, table: "promotion_products", columns: "product_id, discount_type, discount_value, min_qty", where: "promotion_id = ?", params: [id], orderBy: "product_id ASC" }).catch(() => [] as RowDataPacket[]),
    tenantSelect<RowDataPacket>({ slug, table: "promotion_locations", columns: "location_id", where: "promotion_id = ?", params: [id] }).catch(() => [] as RowDataPacket[]),
    tenantSelect<RowDataPacket>({ slug, table: "promotion_time_windows", columns: "day_of_week, start_time, end_time", where: "promotion_id = ?", params: [id], orderBy: "day_of_week ASC, start_time ASC" }).catch(() => [] as RowDataPacket[]),
    tenantSelect<RowDataPacket>({ slug, table: "promotion_blackout_dates", columns: "blackout_date", where: "promotion_id = ?", params: [id], orderBy: "blackout_date ASC" }).catch(() => [] as RowDataPacket[]),
  ]);

  const parseJsonList = (raw: unknown): unknown[] => { try { const p = JSON.parse(String(raw ?? "[]")); return Array.isArray(p) ? p : []; } catch { return []; } };
  const stackable = Number(row.stackable ?? 0);

  return {
    ...mapPromotion(row),
    description: String(row.description ?? ""),
    applyServicesMode: normalizePromoMode(String(row.apply_services_mode ?? "all"), "all"),
    applyProductsMode: normalizePromoMode(String(row.apply_products_mode ?? "none"), "none"),
    minQty: row.min_qty == null ? "1" : String(row.min_qty),
    productsDiscountType: String(row.products_discount_type ?? "percent").toLowerCase() === "fixed" ? "fixed" : "percent",
    productsDiscountValue: row.products_discount_value == null ? "" : String(roundMoney(Number(row.products_discount_value))),
    newWithinDays: row.new_within_days == null ? "" : String(row.new_within_days),
    inactiveDays: row.inactive_days == null ? "" : String(row.inactive_days),
    birthdayWindowDays: row.birthday_window_days == null ? "" : String(row.birthday_window_days),
    perCustomerLimit: row.per_customer_limit == null ? "" : String(row.per_customer_limit),
    promoConditionsEnabled: Number(row.promo_conditions_enabled ?? 0) === 1,
    promoConditions: String(row.promo_conditions ?? ""),
    marketplaceVisibility: String(row.marketplace_visibility ?? "auto").toLowerCase() === "hidden" ? "hidden" : "auto",
    stackableFidelity: (stackable & 4) === 4,
    stackableCoupon: (stackable & 8) === 8,
    selectedServices: mapItems(svcRows, "service_id"),
    selectedProducts: mapItems(prdRows, "product_id"),
    locationIds: locRows.map((r) => Number(r.location_id ?? 0)).filter((n) => n > 0),
    timeWindows: twRows.map((r) => ({ day: Number(r.day_of_week ?? 0), start: String(r.start_time ?? "").slice(0, 5), end: String(r.end_time ?? "").slice(0, 5) })),
    blackoutDates: boRows.map((r) => (typeof r.blackout_date === "string" ? r.blackout_date.slice(0, 10) : r.blackout_date ? dateIsoLocal(new Date(String(r.blackout_date))) : "")).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)),
    targetFidelityLevels: parseJsonList(row.target_fidelity_levels).map((v) => String(v ?? "").trim()).filter((s) => s !== ""),
    excludedClientIds: parseJsonList(row.excluded_client_ids).map((v) => Math.trunc(Number(v)) || 0).filter((n) => n > 0),
  };
}

// Per-item promotion discount row parsed from the editor payload.
type PromoDiscountItem = { id: number; discountType: "percent" | "fixed"; discountValue: number; minQty: number };

function parsePromoDiscountItems(raw: unknown): PromoDiscountItem[] {
  let arr: unknown = raw;
  if (typeof raw === "string") { try { arr = JSON.parse(raw); } catch { arr = []; } }
  if (!Array.isArray(arr)) return [];
  const seen = new Set<number>();
  const out: PromoDiscountItem[] = [];
  for (const it of arr) {
    const o = it as Record<string, unknown>;
    const idv = Math.trunc(Number(o.id ?? o.service_id ?? o.product_id ?? 0)) || 0;
    if (idv <= 0 || seen.has(idv)) continue;
    seen.add(idv);
    let dt = String(o.discountType ?? o.discount_type ?? "percent").toLowerCase();
    if (dt !== "percent" && dt !== "fixed") dt = "percent";
    let dv = Math.max(0, Number(String(o.discountValue ?? o.discount_value ?? 0).replace(",", ".")) || 0);
    if (dt === "percent" && dv > 100) dv = 100;
    const mq = Math.max(1, Math.trunc(Number(o.minQty ?? o.min_qty ?? 1)) || 1);
    out.push({ id: idv, discountType: dt as "percent" | "fixed", discountValue: roundMoney(dv), minQty: mq });
  }
  return out;
}

function parsePromoIdList(raw: unknown): number[] {
  let arr: unknown = raw;
  if (typeof raw === "string") { try { arr = JSON.parse(raw); } catch { arr = []; } }
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((v) => Math.trunc(Number(v)) || 0).filter((n) => n > 0))];
}

function parsePromoStringList(raw: unknown): string[] {
  let arr: unknown = raw;
  if (typeof raw === "string") { try { arr = JSON.parse(raw); } catch { arr = []; } }
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((v) => String(v ?? "").trim()).filter((s) => s !== ""))];
}

type PromoTimeWindow = { day: number; start: string; end: string };
function parsePromoTimeWindows(raw: unknown): PromoTimeWindow[] {
  let arr: unknown = raw;
  if (typeof raw === "string") { try { arr = JSON.parse(raw); } catch { arr = []; } }
  if (!Array.isArray(arr)) return [];
  const out: PromoTimeWindow[] = [];
  for (const it of arr) {
    const o = it as Record<string, unknown>;
    const day = Math.trunc(Number(o.day ?? o.day_of_week ?? 0)) || 0;
    const start = String(o.start ?? o.start_time ?? "").trim();
    const end = String(o.end ?? o.end_time ?? "").trim();
    if (day < 1 || day > 7 || !/^\d{2}:\d{2}/.test(start) || !/^\d{2}:\d{2}/.test(end)) continue;
    out.push({ day, start: start.slice(0, 5), end: end.slice(0, 5) });
  }
  return out;
}

function parsePromoBlackoutDates(raw: unknown): string[] {
  return parsePromoStringList(raw).filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s));
}

// Rebuild a promotion child mapping table (delete existing rows for the promotion,
// then re-insert). Used for services/products/locations/time-windows/blackouts.
async function rebuildPromoChild(slug: string, table: string, promotionId: number, rows: Record<string, unknown>[]): Promise<void> {
  if (!(await tableExists((await tenantTable(slug, table)).name))) return;
  const t = await tenantTable(slug, table);
  await dbExecute(`DELETE FROM ${quoteIdentifier(t.name)} WHERE tenant_id = ? AND promotion_id = ?`, [t.tenantId ?? 0, promotionId]).catch(() => undefined);
  for (const row of rows) await tenantInsert(t, { promotion_id: promotionId, ...row }).catch(() => 0);
}

// Create / update a promotion, faithful to promotions.php POST (action=new|edit) /
// Promotions::saveAdvanced. Writes the main promotions row (core + advanced fields:
// stackable mask, target_fidelity_levels, excluded_client_ids, products global
// discount, marketplace_visibility) AND rebuilds the sub-tables: promotion_services
// / promotion_products (selected scope + per-item discount), promotion_locations,
// promotion_time_windows, promotion_blackout_dates. Nested lists arrive as JSON
// strings (parseRequestBody flattens objects). NB: the discount APPLICATION engine
// (matching + discount at checkout) is still deferred — this persists the config.
export async function saveManagePromotion(slug: string, body: Record<string, string>, id: number): Promise<ManagePromotionRecord> {
  const title = String(body.title ?? "").trim();
  if (title === "") throw new Error("Inserisci il nome della promozione.");

  const startsAt = String(body.starts_at ?? "").trim();
  const endsAt = String(body.ends_at ?? "").trim();
  if (startsAt !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(startsAt)) throw new Error("La data di inizio non e valida.");
  if (endsAt !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(endsAt)) throw new Error("La data di fine non e valida.");
  if (startsAt !== "" && endsAt !== "" && startsAt > endsAt) throw new Error("La data di fine deve essere uguale o successiva alla data di inizio.");

  let discountType = String(body.discount_type ?? "percent").trim().toLowerCase();
  if (discountType !== "percent" && discountType !== "fixed") discountType = "percent";
  const discountValue = roundMoney(Math.max(0, Number(String(body.discount_value ?? "0").replace(",", ".")) || 0));

  const svcMode = normalizePromoMode(String(body.apply_services_mode ?? "all"), "all");
  const prdMode = normalizePromoMode(String(body.apply_products_mode ?? "none"), "none");
  if (svcMode === "none" && prdMode === "none") throw new Error("Seleziona almeno servizi o prodotti da includere nella promozione.");
  if (svcMode === "all") {
    if (discountValue <= 0) throw new Error("Inserisci uno sconto maggiore di 0 per tutti i servizi.");
    if (discountType === "percent" && discountValue > 100) throw new Error("Lo sconto percentuale servizi non puo superare 100%.");
  }

  const serviceItems = svcMode === "selected" ? parsePromoDiscountItems(body.service_ids_json ?? body.services_json) : [];
  const productItems = prdMode === "selected" ? parsePromoDiscountItems(body.product_ids_json ?? body.products_json) : [];
  if (svcMode === "selected" && serviceItems.length === 0) throw new Error("Seleziona almeno un servizio per la promozione.");
  if (prdMode === "selected" && productItems.length === 0) throw new Error("Seleziona almeno un prodotto per la promozione.");

  let target = String(body.target_type ?? "all").trim().toLowerCase();
  if (!["all", "new", "inactive", "birthday", "fidelity"].includes(target)) target = "all";

  // Products global discount (apply_products_mode=all): defaults inherit the service discount.
  let prdDiscType = String(body.products_discount_type ?? "").trim().toLowerCase();
  if (prdDiscType !== "percent" && prdDiscType !== "fixed") prdDiscType = discountType;
  const prdValRaw = String(body.products_discount_value ?? "").trim();
  let prdDiscValue = prdValRaw === "" ? discountValue : roundMoney(Math.max(0, Number(prdValRaw.replace(",", ".")) || 0));
  if (prdDiscType === "percent" && prdDiscValue > 100) prdDiscValue = 100;

  // Stackable bitmask (4 = fidelity points, 8 = coupon).
  const truthy = (v: unknown) => ["1", "true", "yes", "on"].includes(String(v ?? "").toLowerCase());
  const stackable = (truthy(body.stackable_fidelity) ? 4 : 0) | (truthy(body.stackable_coupon) ? 8 : 0);

  let marketplaceVisibility = String(body.marketplace_visibility ?? "auto").trim().toLowerCase();
  if (marketplaceVisibility !== "auto" && marketplaceVisibility !== "hidden") marketplaceVisibility = "auto";

  const fidLevels = target === "fidelity" ? parsePromoStringList(body.target_fidelity_levels_json) : [];
  const excludedClients = parsePromoIdList(body.excluded_client_ids_json);
  const minQty = Math.max(1, Math.trunc(Number(body.min_qty ?? 1)) || 1);

  const values: Record<string, unknown> = {
    title,
    description: String(body.description ?? "").trim() || null,
    starts_at: startsAt !== "" ? startsAt : null,
    ends_at: endsAt !== "" ? endsAt : null,
    is_active: truthy(body.is_active) ? 1 : 0,
    discount_type: discountType,
    discount_value: discountValue,
    min_qty: minQty,
    apply_services_mode: svcMode,
    apply_products_mode: prdMode,
    products_discount_type: prdMode === "all" ? prdDiscType : null,
    products_discount_value: prdMode === "all" ? prdDiscValue : null,
    products_min_qty: prdMode === "all" ? minQty : null,
    target_type: target,
    new_within_days: nullableInt(body.new_within_days),
    inactive_days: nullableInt(body.inactive_days),
    birthday_window_days: nullableInt(body.birthday_window_days),
    per_customer_limit: nullableInt(body.per_customer_limit),
    stackable,
    marketplace_visibility: marketplaceVisibility,
    target_fidelity_levels: fidLevels.length > 0 ? JSON.stringify(fidLevels) : null,
    excluded_client_ids: excludedClients.length > 0 ? JSON.stringify(excludedClients) : null,
    promo_conditions_enabled: truthy(body.promo_conditions_enabled) ? 1 : 0,
    promo_conditions: String(body.promo_conditions ?? "").trim() || null,
    updated_at: new Date(),
  };

  let promotionId = id;
  if (promotionId > 0) {
    const existing = await tenantSelect<RowDataPacket>({ slug, table: "promotions", columns: "id", where: "id = ?", params: [promotionId], limit: 1 });
    if (!existing[0]) throw new Error("Promozione non trovata.");
    await tenantUpdate({ slug, table: "promotions", id: promotionId, values });
  } else {
    promotionId = await tenantInsert(await tenantTable(slug, "promotions"), { ...values, created_at: new Date() });
  }

  // Rebuild the sub-tables.
  await rebuildPromoChild(slug, "promotion_services", promotionId, serviceItems.map((s) => ({ service_id: s.id, discount_type: s.discountType, discount_value: s.discountValue, min_subtotal: null, min_qty: s.minQty, discounted_qty: null })));
  await rebuildPromoChild(slug, "promotion_products", promotionId, productItems.map((p) => ({ product_id: p.id, discount_type: p.discountType, discount_value: p.discountValue, min_subtotal: null, min_qty: p.minQty, discounted_qty: null })));
  await rebuildPromoChild(slug, "promotion_locations", promotionId, parsePromoIdList(body.location_ids_json).map((lid) => ({ location_id: lid })));
  await rebuildPromoChild(slug, "promotion_time_windows", promotionId, parsePromoTimeWindows(body.time_windows_json).map((w) => ({ day_of_week: w.day, start_time: w.start, end_time: w.end })));
  await rebuildPromoChild(slug, "promotion_blackout_dates", promotionId, parsePromoBlackoutDates(body.blackout_dates_json).map((d) => ({ blackout_date: d })));

  const saved = await getManagePromotion(slug, promotionId);
  if (!saved) throw new Error("Promozione non salvata.");
  return saved;
}

// Editor form catalogs: active services + products (with price) + locations +
// fidelity card levels + clients (for exclusions). Port of the SELECTs in
// promotions.php action=new|edit.
export async function promotionFormContext(slug: string): Promise<{
  services: { id: number; name: string; price: number }[];
  products: { id: number; name: string; price: number; sku: string }[];
  locations: { id: number; name: string }[];
  fidelityLevels: { key: string; name: string }[];
  clients: { id: number; name: string }[];
}> {
  const [svc, prd, loc, clients] = await Promise.all([
    tenantSelect<RowDataPacket>({ slug, table: "services", columns: "id, name, price", where: "COALESCE(is_active,1) = 1", orderBy: "name ASC" }).catch(() => [] as RowDataPacket[]),
    tenantSelect<RowDataPacket>({ slug, table: "products", columns: "id, name, price, sku", where: "COALESCE(is_active,1) = 1", orderBy: "name ASC" }).catch(() => [] as RowDataPacket[]),
    tenantSelect<RowDataPacket>({ slug, table: "locations", columns: "id, name", orderBy: "name ASC" }).catch(() => [] as RowDataPacket[]),
    tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "id, full_name", orderBy: "full_name ASC", limit: 1000 }).catch(() => [] as RowDataPacket[]),
  ]);
  const levels = await getFidelityLevelsSettings(slug).catch(() => ({ levels: [] as { key: string; name: string }[] }));
  return {
    services: svc.map((r) => ({ id: Number(r.id), name: String(r.name ?? ""), price: roundMoney(Number(r.price ?? 0)) })),
    products: prd.map((r) => ({ id: Number(r.id), name: String(r.name ?? ""), price: roundMoney(Number(r.price ?? 0)), sku: String(r.sku ?? "") })),
    locations: loc.map((r) => ({ id: Number(r.id), name: String(r.name ?? "") })),
    fidelityLevels: (levels.levels ?? []).map((l) => ({ key: l.key, name: l.name })),
    clients: clients.map((r) => ({ id: Number(r.id), name: String(r.full_name ?? "") })),
  };
}

// ---- Promotion APPLICATION engine (Block 3, port of Promotions::evaluatePromotion) ----
export type PromoCartLine = { type: "service" | "product"; id: number; qty: number; unitPrice: number };
// Per-service price breakdown of an applied promotion (unit prices, port of the
// legacy eval breakdown_services): old = list, now = discounted, badge = "-10%" /
// "-€ 5,00" (Italian money format, fmt_money).
export type PromoServiceBreakdown = { old: number; now: number; discount: number; badge: string };
export type PromoEvalResult = { promotionId: number; title: string; eligible: boolean; discount: number; reason: string; eligibleQty: number; eligibleAmount: number; breakdownServices: Record<number, PromoServiceBreakdown> };

const PROMO_CANCELLED_STATES = ["canceled", "cancelled", "annullato", "annullata", "rejected", "rifiutato", "rifiutata", "deleted", "eliminato", "eliminata"];

type PromoChildren = {
  blackouts: Set<string>;
  windows: { day: number; start: string; end: string }[];
  serviceDefs: Map<number, { type: "percent" | "fixed"; value: number; minQty: number }>;
  productDefs: Map<number, { type: "percent" | "fixed"; value: number; minQty: number }>;
  locationIds: Set<number>;
};

// Per-client target context (computed once): previous non-cancelled appointment
// count + last appointment date before the cutoff, plus the client anagrafica used
// by the new/inactive/birthday/fidelity target rules.
type PromoClientCtx = {
  clientId: number;
  registrationDate: string;
  birthDate: string;
  createdAt: string;
  fidelityLevel: string;
  prevApptCount: number;
  lastApptDate: string;
  adhering: boolean;
};

function promoNormTime(time: string | null): string {
  const s = String(time ?? "").trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return "";
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

async function loadPromoClientCtx(slug: string, clientId: number, date: string, time: string): Promise<PromoClientCtx | null> {
  if (clientId <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "id, registration_date, birth_date, created_at, fidelity_level", where: "id = ?", params: [clientId], limit: 1 });
  if (!rows[0]) return null;
  const today = todayIso();
  const cutoff = date === today ? `${date} 00:00:00` : time ? `${date} ${time}:00` : `${date} 23:59:59`;
  const appt = await tenantTable(slug, "appointments");
  const notIn = PROMO_CANCELLED_STATES.map(() => "?").join(",");
  const agg = await dbQuery<RowDataPacket[]>(
    `SELECT COUNT(*) c, MAX(starts_at) m FROM ${quoteIdentifier(appt.name)} WHERE tenant_id = ? AND client_id = ? AND status NOT IN (${notIn}) AND starts_at < ?`,
    [appt.tenantId ?? 0, clientId, ...PROMO_CANCELLED_STATES, cutoff],
  ).catch(() => [] as RowDataPacket[]);
  return {
    clientId,
    registrationDate: rows[0].registration_date ? toIso(rows[0].registration_date).slice(0, 10) : "",
    birthDate: rows[0].birth_date ? toIso(rows[0].birth_date).slice(0, 10) : "",
    createdAt: rows[0].created_at ? toIso(rows[0].created_at).slice(0, 10) : "",
    fidelityLevel: String(rows[0].fidelity_level ?? "").trim().toLowerCase(),
    prevApptCount: Number(agg[0]?.c ?? 0),
    lastApptDate: agg[0]?.m ? toIso(agg[0].m).slice(0, 10) : "",
    adhering: await fidelityIsClientAdhering(slug, clientId),
  };
}

// Port of Promotions::checkClientTarget (new/inactive/birthday/fidelity). Returns
// true when eligible, otherwise the Italian reason string.
function checkPromoTarget(target: string, promo: RowDataPacket, ctx: PromoClientCtx | null, date: string): true | string {
  if (target === "all") return true;
  if (!ctx) return "Richiede un cliente selezionato.";

  if (target === "new") {
    const within = Math.max(0, Number(promo.new_within_days ?? 0) || 0);
    if (within <= 0) return ctx.prevApptCount <= 0 ? true : "Valida solo per nuovi clienti.";
    const reg = ctx.registrationDate || ctx.createdAt;
    if (!reg) return `Valida solo per clienti registrati negli ultimi ${within} giorni.`;
    const minDate = addDaysToIso(date, -within);
    if (reg < minDate) return `Valida solo per clienti registrati negli ultimi ${within} giorni.`;
    return ctx.prevApptCount <= 0 ? true : "Valida solo per nuovi clienti.";
  }

  if (target === "inactive") {
    const days = Math.max(1, Number(promo.inactive_days ?? 0) || 30);
    if (!ctx.lastApptDate) return true;
    const threshold = addDaysToIso(date, -days);
    return ctx.lastApptDate <= threshold ? true : `Valida per clienti inattivi da almeno ${days} giorni.`;
  }

  if (target === "birthday") {
    if (!ctx.birthDate) return "Valida solo per clienti con data di nascita.";
    const mday = ctx.birthDate.slice(5, 10);
    const window = Math.max(0, Number(promo.birthday_window_days ?? 0) || 0);
    if (window <= 0) return date.slice(5, 10) === mday ? true : "Valida solo il giorno del compleanno.";
    const y = Number(date.slice(0, 4));
    const dts = Date.parse(`${date}T00:00:00Z`);
    const dist = (yy: number) => Math.abs(Math.round((Date.parse(`${yy}-${mday}T00:00:00Z`) - dts) / 86400000));
    const min = Math.min(dist(y - 1), dist(y), dist(y + 1));
    return min <= window ? true : `Valida entro ±${window} giorni dal compleanno.`;
  }

  if (target === "fidelity") {
    if (!ctx.adhering) return "Valida solo per clienti aderenti alla Fidelity.";
    const levels = ((): string[] => { try { const p = JSON.parse(String(promo.target_fidelity_levels ?? "[]")); return Array.isArray(p) ? p.map((v) => String(v ?? "").trim().toLowerCase()).filter(Boolean) : []; } catch { return []; } })();
    if (levels.length > 0) {
      const cur = ctx.fidelityLevel !== "" ? `points:${ctx.fidelityLevel}` : "";
      if (cur === "" || !levels.includes(cur)) return "Valida solo per alcuni livelli Fidelity.";
    }
    return true;
  }
  return true;
}

function addDaysToIso(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map((p) => Number.parseInt(p, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// Compute the total discount a promotion grants on a cart (port of the scope/qty
// discount computation in evaluatePromotion — per-line total; the legacy's unit-by-
// unit pro-rata only changes rounding distribution, not the total). Returns cents.
// Italian money for the badge text (legacy fmt_money: "1.234,56").
function promoBadgeMoney(value: number): string {
  return value.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Trim trailing zeros off a percent for the "-10%" badge (legacy rtrim of
// number_format($p, 2)).
function promoBadgePercent(value: number): string {
  return String(Number(value.toFixed(2)));
}

// Discount computation with the legacy PER-UNIT allocation (Promotions.php
// ~4380): percent => round(unitCents * p / 100) on each unit; fixed on a
// selected line => min(unitCents, valueCents) per unit; fixed on the global
// scope=all group => largest-remainder pro-rata across the group's units.
// Besides the total it now returns the per-service breakdown (unit old/now/
// discount + badge) the drawer/booking price panels render.
function computePromoDiscountCents(promo: RowDataPacket, ch: PromoChildren, cart: PromoCartLine[]): { discountC: number; eligibleQty: number; eligibleAmountC: number; breakdownServices: Record<number, PromoServiceBreakdown> } {
  const svcMode = String(promo.apply_services_mode ?? "all").toLowerCase();
  const prdMode = String(promo.apply_products_mode ?? "none").toLowerCase();
  const cents = (v: number) => Math.round(v * 100);

  const svcType = String(promo.discount_type ?? "percent").toLowerCase() === "fixed" ? "fixed" : "percent";
  let svcVal = Math.max(0, Number(promo.discount_value ?? 0) || 0);
  if (svcType === "percent" && svcVal > 100) svcVal = 100;
  const svcMinQty = Math.max(1, Number(promo.min_qty ?? 1) || 1);

  const prdValRaw = promo.products_discount_value;
  let prdType: string;
  let prdVal: number;
  if (prdValRaw === null || prdValRaw === undefined || prdValRaw === "") { prdType = svcType; prdVal = svcVal; }
  else { prdType = String(promo.products_discount_type ?? "").toLowerCase(); if (prdType !== "percent" && prdType !== "fixed") prdType = svcType; prdVal = Math.max(0, Number(prdValRaw) || 0); if (prdType === "percent" && prdVal > 100) prdVal = 100; }
  const prdMinQty = Math.max(1, Number(promo.products_min_qty ?? promo.min_qty ?? 1) || 1);

  // One expanded unit per qty (line index kept for the per-line aggregation).
  type PromoUnit = { line: number; unitC: number; discC: number };
  type PromoLine = { type: "service" | "product"; id: number; qty: number; unitC: number; units: PromoUnit[]; discType: string; discValue: number };
  const units: PromoUnit[] = [];
  const lines: PromoLine[] = [];
  let eligibleQty = 0;
  let eligibleAmountC = 0;
  const globalSvcUnits: PromoUnit[] = [];
  const globalPrdUnits: PromoUnit[] = [];

  const addLine = (line: PromoCartLine, id: number, qty: number, unitC: number, discType: string, discValue: number): PromoLine => {
    const entry: PromoLine = { type: line.type, id, qty, unitC, units: [], discType, discValue };
    for (let i = 0; i < qty; i++) {
      const u: PromoUnit = { line: lines.length, unitC, discC: 0 };
      units.push(u);
      entry.units.push(u);
    }
    lines.push(entry);
    return entry;
  };

  // Legacy percent alloc: per-unit rounding.
  const allocPercent = (us: PromoUnit[], pct: number) => {
    for (const u of us) u.discC = Math.min(u.unitC, Math.round((u.unitC * pct) / 100));
  };
  // Legacy fixed pro-rata with largest-remainder distribution of the leftover cents.
  const allocFixedProRata = (us: PromoUnit[], fixedTotC: number) => {
    const sum = us.reduce((s, u) => s + u.unitC, 0);
    if (sum <= 0) return;
    let tot = Math.min(fixedTotC, sum);
    const rema: number[] = [];
    let sumBase = 0;
    us.forEach((u, i) => {
      const exact = tot * (u.unitC / sum);
      let b = Math.floor(exact);
      if (b < 0) b = 0;
      if (b > u.unitC) b = u.unitC;
      u.discC = b;
      rema[i] = exact - b;
      sumBase += b;
    });
    let left = tot - sumBase;
    if (left > 0) {
      const order = us.map((_, i) => i).sort((a, b) => {
        const d = rema[b] - rema[a];
        if (Math.abs(d) > 1e-9) return d > 0 ? 1 : -1;
        return us[b].unitC - us[a].unitC;
      });
      for (const i of order) {
        if (left <= 0) break;
        if (us[i].discC < us[i].unitC) { us[i].discC++; left--; }
      }
    }
  };

  for (const line of cart) {
    const id = Math.trunc(Number(line.id)) || 0;
    const qty = Math.max(1, Math.trunc(Number(line.qty)) || 1);
    const unitC = cents(Math.max(0, Number(line.unitPrice) || 0));
    if (id <= 0 || unitC <= 0) continue;
    const lineTotC = unitC * qty;

    if (line.type === "service") {
      if (svcMode === "all") {
        eligibleQty += qty; eligibleAmountC += lineTotC;
        const entry = addLine(line, id, qty, unitC, svcType, svcVal);
        globalSvcUnits.push(...entry.units);
      } else if (svcMode === "selected" && ch.serviceDefs.has(id)) {
        eligibleQty += qty; eligibleAmountC += lineTotC;
        const def = ch.serviceDefs.get(id)!;
        const entry = addLine(line, id, qty, unitC, def.type, def.value);
        if (qty >= def.minQty) {
          if (def.type === "percent") allocPercent(entry.units, def.value);
          else for (const u of entry.units) u.discC = Math.min(u.unitC, cents(def.value));
        }
      }
    } else if (line.type === "product") {
      if (prdMode === "all") {
        eligibleQty += qty; eligibleAmountC += lineTotC;
        const entry = addLine(line, id, qty, unitC, prdType, prdVal);
        globalPrdUnits.push(...entry.units);
      } else if (prdMode === "selected" && ch.productDefs.has(id)) {
        eligibleQty += qty; eligibleAmountC += lineTotC;
        const def = ch.productDefs.get(id)!;
        const entry = addLine(line, id, qty, unitC, def.type, def.value);
        if (qty >= def.minQty) {
          if (def.type === "percent") allocPercent(entry.units, def.value);
          else for (const u of entry.units) u.discC = Math.min(u.unitC, cents(def.value));
        }
      }
    }
  }

  // Global groups (scope=all): gate on the group qty >= the group min_qty.
  if (globalSvcUnits.length >= svcMinQty && globalSvcUnits.length > 0) {
    if (svcType === "percent") allocPercent(globalSvcUnits, svcVal);
    else allocFixedProRata(globalSvcUnits, cents(svcVal));
  }
  if (globalPrdUnits.length >= prdMinQty && globalPrdUnits.length > 0) {
    if (prdType === "percent") allocPercent(globalPrdUnits, prdVal);
    else allocFixedProRata(globalPrdUnits, cents(prdVal));
  }

  let discountC = 0;
  for (const u of units) discountC += Math.max(0, Math.min(u.unitC, u.discC));
  if (discountC > eligibleAmountC) discountC = eligibleAmountC;

  // Per-service breakdown (aggregate lines by service id; legacy svcAgg): unit
  // old/now/discount + badge ("-p%" when the whole line is percent-discounted,
  // else "-€ <avg unit>"; conflicting badges across lines fall back to money).
  const agg = new Map<number, { oldTotC: number; newTotC: number; qty: number; badge: string; badgeSet: boolean }>();
  for (const line of lines) {
    if (line.type !== "service") continue;
    const lineDiscC = line.units.reduce((s, u) => s + Math.max(0, Math.min(u.unitC, u.discC)), 0);
    const oldTotC = line.unitC * line.qty;
    const newTotC = oldTotC - Math.min(lineDiscC, oldTotC);
    let badge = "";
    if (lineDiscC > 0) {
      const discUnits = line.units.filter((u) => u.discC > 0).length;
      if (discUnits >= line.qty && line.discType === "percent" && line.discValue > 0) {
        badge = `-${promoBadgePercent(line.discValue)}%`;
      } else {
        badge = `-€ ${promoBadgeMoney(Math.round(lineDiscC / line.qty) / 100)}`;
      }
    }
    const cur = agg.get(line.id);
    if (!cur) agg.set(line.id, { oldTotC, newTotC, qty: line.qty, badge, badgeSet: true });
    else {
      cur.oldTotC += oldTotC; cur.newTotC += newTotC; cur.qty += line.qty;
      if (badge && cur.badge !== badge) cur.badge = "";
    }
  }
  const breakdownServices: Record<number, PromoServiceBreakdown> = {};
  for (const [sid, a] of agg) {
    const qty = Math.max(1, a.qty);
    const discTotC = Math.max(0, a.oldTotC - a.newTotC);
    const oldUnit = Math.round(a.oldTotC / qty) / 100;
    const nowUnit = Math.round(a.newTotC / qty) / 100;
    const discUnit = Math.round(discTotC / qty) / 100;
    let badge = a.badge;
    if (!badge && discTotC > 0) badge = `-€ ${promoBadgeMoney(discUnit)}`;
    breakdownServices[sid] = { old: oldUnit, now: nowUnit, discount: discUnit, badge };
  }

  return { discountC: Math.max(0, discountC), eligibleQty, eligibleAmountC, breakdownServices };
}

// Evaluate one active promotion against a cart + context (port of the guard chain
// in evaluatePromotion: active/date/blackout/time-window/location/excluded/target,
// then the discount). date=YYYY-MM-DD, time=HH:MM (optional), locationId optional.
function evaluateOnePromotion(promo: RowDataPacket, ch: PromoChildren, cart: PromoCartLine[], date: string, time: string, clientId: number, locationId: number, ctx: PromoClientCtx | null): PromoEvalResult {
  const base: PromoEvalResult = { promotionId: Number(promo.id ?? 0), title: String(promo.title ?? ""), eligible: false, discount: 0, reason: "", eligibleQty: 0, eligibleAmount: 0, breakdownServices: {} };

  if (Number(promo.is_active ?? 0) !== 1) return { ...base, reason: "Promozione non attiva." };
  const start = String(promo.starts_at ?? "").slice(0, 10);
  const end = String(promo.ends_at ?? "").slice(0, 10);
  if (start && /^\d{4}-\d{2}-\d{2}$/.test(start) && date < start) return { ...base, reason: "Promozione non ancora valida." };
  if (end && /^\d{4}-\d{2}-\d{2}$/.test(end) && date > end) return { ...base, reason: "Promozione scaduta." };
  if (ch.blackouts.has(date)) return { ...base, reason: "Non valida in questa data." };

  if (ch.windows.length > 0) {
    const dow = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1; // 1=Mon..7=Sun
    const dayWindows = ch.windows.filter((w) => w.day === dow);
    if (dayWindows.length === 0) return { ...base, reason: "Non valida in questo giorno." };
    if (time && !dayWindows.some((w) => w.start && w.end && time >= w.start && time <= w.end)) return { ...base, reason: "Non valida in questo orario." };
  }

  if (locationId > 0 && ch.locationIds.size > 0 && !ch.locationIds.has(locationId)) return { ...base, reason: "Promozione non valida per questa sede." };

  const excluded = ((): number[] => { try { const p = JSON.parse(String(promo.excluded_client_ids ?? "[]")); return Array.isArray(p) ? p.map((v) => Math.trunc(Number(v)) || 0) : []; } catch { return []; } })();
  if (clientId > 0 && excluded.includes(clientId)) return { ...base, reason: "Cliente escluso da questa promozione." };

  let target = String(promo.target_type ?? "all").toLowerCase();
  if (!["all", "new", "inactive", "birthday", "fidelity"].includes(target)) target = "all";
  const targetOk = checkPromoTarget(target, promo, ctx, date);
  if (targetOk !== true) return { ...base, reason: targetOk };

  const { discountC, eligibleQty, eligibleAmountC, breakdownServices } = computePromoDiscountCents(promo, ch, cart);
  if (eligibleQty <= 0) return { ...base, reason: "Nessun servizio/prodotto nel carrello rientra nello scope della promozione." };
  const discount = roundMoney(discountC / 100);
  return { promotionId: base.promotionId, title: base.title, eligible: discount > 0, discount, reason: discount > 0 ? "Promozione valida." : "Nessuno sconto applicabile.", eligibleQty, eligibleAmount: roundMoney(eligibleAmountC / 100), breakdownServices };
}

// Evaluate ALL active promotions against a cart; return the eligible ones (discount
// desc) + the best. Loads each promotion's child mappings in batch (tenant-safe).
export async function evaluatePromotionsForCart(slug: string, cart: PromoCartLine[], date: string, time: string, clientId: number, locationId: number): Promise<{ promotions: PromoEvalResult[]; best: PromoEvalResult | null }> {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayIso();
  const t = promoNormTime(time);
  const promos = await tenantSelect<RowDataPacket>({ slug, table: "promotions", where: "COALESCE(is_active,0) = 1", orderBy: "priority DESC, id ASC" }).catch(() => [] as RowDataPacket[]);
  if (promos.length === 0) return { promotions: [], best: null };
  const ids = promos.map((p) => Number(p.id));
  const inList = ids.map(() => "?").join(",");

  const grab = async (table: string): Promise<Map<number, RowDataPacket[]>> => {
    const rows = await tenantSelect<RowDataPacket>({ slug, table, where: `promotion_id IN (${inList})`, params: ids }).catch(() => [] as RowDataPacket[]);
    const map = new Map<number, RowDataPacket[]>();
    for (const r of rows) { const pid = Number(r.promotion_id ?? 0); if (!map.has(pid)) map.set(pid, []); map.get(pid)!.push(r); }
    return map;
  };
  const [boMap, twMap, svcMap, prdMap, locMap] = await Promise.all([grab("promotion_blackout_dates"), grab("promotion_time_windows"), grab("promotion_services"), grab("promotion_products"), grab("promotion_locations")]);
  const ctx = clientId > 0 ? await loadPromoClientCtx(slug, clientId, day, t) : null;

  const results: PromoEvalResult[] = [];
  for (const promo of promos) {
    const pid = Number(promo.id);
    const defMap = (rows: RowDataPacket[] | undefined, refCol: string) => {
      const m = new Map<number, { type: "percent" | "fixed"; value: number; minQty: number }>();
      for (const r of rows ?? []) { const t2 = String(r.discount_type ?? "percent").toLowerCase() === "fixed" ? "fixed" : "percent"; m.set(Number(r[refCol] ?? 0), { type: t2 as "percent" | "fixed", value: Math.max(0, Number(r.discount_value ?? 0) || 0), minQty: Math.max(1, Number(r.min_qty ?? 1) || 1) }); }
      return m;
    };
    const ch: PromoChildren = {
      blackouts: new Set((boMap.get(pid) ?? []).map((r) => (typeof r.blackout_date === "string" ? r.blackout_date.slice(0, 10) : r.blackout_date ? toIso(r.blackout_date).slice(0, 10) : "")).filter(Boolean)),
      windows: (twMap.get(pid) ?? []).map((r) => ({ day: Number(r.day_of_week ?? 0), start: String(r.start_time ?? "").slice(0, 5), end: String(r.end_time ?? "").slice(0, 5) })),
      serviceDefs: defMap(svcMap.get(pid), "service_id"),
      productDefs: defMap(prdMap.get(pid), "product_id"),
      locationIds: new Set((locMap.get(pid) ?? []).map((r) => Number(r.location_id ?? 0)).filter((n) => n > 0)),
    };
    results.push(evaluateOnePromotion(promo, ch, cart, day, t, clientId, locationId, ctx));
  }

  const eligible = results.filter((r) => r.eligible).sort((a, b) => b.discount - a.discount);
  return { promotions: eligible, best: eligible[0] ?? null };
}

// ---------------------------------------------------------------------------
// PROMOZIONI nel quick booking — port of the legacy drawer auto-detection
// (api_appointments.php action=promotion_preview -> appt_eval_best_promotion_
// for_context) and its save-side application. The best ELIGIBLE automatic
// promotion (coupon-code promotions excluded) is evaluated against the selected
// services; the per-service breakdown drives both the drawer price panel
// (list_price barrato + booked_price + badge) and the appointment_services
// snapshot at save.

// Stackability flags from the promotions.stackable bitmask (port of
// Promotions::normalizeStackable): raw 1 => stackable with everything (4|8);
// otherwise bit 4 = fidelity, bit 8 = coupon.
function promoStackMeta(promoRow: RowDataPacket | null): { hasPromotion: boolean; id: number; title: string; stackable: number; stackableWithFidelity: boolean; stackableWithCoupon: boolean } {
  const id = Number(promoRow?.id ?? 0) || 0;
  const raw = Math.trunc(Number(promoRow?.stackable ?? 0)) || 0;
  const mask = id > 0 ? (raw === 1 ? (4 | 8) : (raw & (4 | 8))) : 0;
  return {
    hasPromotion: id > 0,
    id,
    title: id > 0 ? String(promoRow?.title ?? "") : "",
    stackable: mask,
    stackableWithFidelity: (mask & 4) !== 0,
    stackableWithCoupon: (mask & 8) !== 0,
  };
}

export type AppointmentPromoContext = {
  applied: boolean;
  promotion: { id: number; title: string; stackable: number; stackable_with_fidelity: boolean; stackable_with_coupon: boolean } | null;
  // Only services with a REAL discount (old - now > 0), like the legacy preview.
  services: Array<{ service_id: number; list_price: number; booked_price: number; discount_badge: string }>;
  discount: number;
  reason: string;
};

// Best automatic promotion for a quick-booking services context (unit qty 1 per
// service occurrence, price from the catalog). Excludes coupon-code promotions
// (the legacy preview skips them — they go through the coupon flow). Returns a
// non-applied context (never throws) so the preview/save degrade gracefully.
export async function evalBestPromotionForAppointment({
  slug,
  serviceIds,
  date,
  time,
  clientId,
  locationId,
  preferredPromotionId = null,
}: {
  slug: string;
  serviceIds: number[];
  date: string;
  time: string | null;
  clientId: number | null;
  locationId: number | null;
  // Legacy preferred-promo support (booking_pick_best_promotion_for_booking):
  // when the caller pre-selected a promotion and it is ELIGIBLE, it wins over
  // the best automatic one; otherwise the best eligible applies as usual.
  preferredPromotionId?: number | null;
}): Promise<AppointmentPromoContext> {
  const none = (reason: string): AppointmentPromoContext => ({ applied: false, promotion: null, services: [], discount: 0, reason });
  const ids = serviceIds.map((id) => Math.trunc(Number(id)) || 0).filter((id) => id > 0);
  if (ids.length === 0) return none("Nessun servizio selezionato.");

  try {
    // Cart from the catalog prices (legacy appt_cart_from_service_ids).
    const ph = Array.from(new Set(ids)).map(() => "?").join(", ");
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "id, name, price", where: `id IN (${ph})`, params: Array.from(new Set(ids)) }).catch(() => [] as RowDataPacket[]);
    const priceById = new Map<number, number>(rows.map((r) => [Number(r.id ?? 0), Math.max(0, Number(r.price ?? 0) || 0)]));
    const cart: PromoCartLine[] = ids
      .map((id) => ({ type: "service" as const, id, qty: 1, unitPrice: priceById.get(id) ?? 0 }))
      .filter((line) => line.unitPrice > 0);
    if (cart.length === 0) return none("Nessun servizio valido nel carrello.");

    const { promotions } = await evaluatePromotionsForCart(slug, cart, date, time ?? "", clientId ?? 0, locationId ?? 0);
    if (promotions.length === 0) return none("Nessuna promozione automatica applicabile.");

    // Skip coupon-code promotions (redeemed via coupon, not auto-applied).
    const promoRows = await tenantSelect<RowDataPacket>({ slug, table: "promotions", where: `id IN (${promotions.map(() => "?").join(", ")})`, params: promotions.map((p) => p.promotionId) }).catch(() => [] as RowDataPacket[]);
    const rowById = new Map<number, RowDataPacket>(promoRows.map((r) => [Number(r.id ?? 0), r]));
    // Preferred promo first (legacy): an eligible pre-selected promotion wins.
    const preferred = Math.max(0, Number(preferredPromotionId ?? 0) || 0);
    const ordered = preferred > 0
      ? [...promotions.filter((p) => p.promotionId === preferred), ...promotions.filter((p) => p.promotionId !== preferred)]
      : promotions;
    for (const evalResult of ordered) {
      const row = rowById.get(evalResult.promotionId);
      if (!row) continue;
      if (String(row.coupon_code ?? "").trim() !== "") continue;
      const meta = promoStackMeta(row);
      const services = Object.entries(evalResult.breakdownServices)
        .map(([sid, b]) => ({ service_id: Number(sid), list_price: roundMoney(b.old), booked_price: roundMoney(b.now), discount_badge: b.badge }))
        .filter((line) => line.list_price > 0 && line.booked_price >= 0 && line.list_price - line.booked_price > 0.000001);
      if (services.length === 0) {
        return {
          applied: false,
          promotion: { id: meta.id, title: meta.title, stackable: meta.stackable, stackable_with_fidelity: meta.stackableWithFidelity, stackable_with_coupon: meta.stackableWithCoupon },
          services: [],
          discount: 0,
          reason: "La promozione non produce righe servizio scontate per il dettaglio prezzi.",
        };
      }
      return {
        applied: true,
        promotion: { id: meta.id, title: meta.title, stackable: meta.stackable, stackable_with_fidelity: meta.stackableWithFidelity, stackable_with_coupon: meta.stackableWithCoupon },
        services,
        discount: evalResult.discount,
        reason: "",
      };
    }
    return none("Nessuna promozione automatica applicabile.");
  } catch {
    return none("Impossibile valutare le promozioni.");
  }
}

// PROMO-CON-CODICE per il booking (port of Promotions::discountForCode via the
// legacy public mode=coupon/confirm): a promotion whose coupon_code matches the
// typed code is treated as a PROMOTION (per-service prices), never as a coupon.
// found=false when no active promotion carries that code; ok=false with the
// eligibility reason when it exists but does not apply to this cart/context.
export async function evalPromotionCodeForAppointment({
  slug,
  code,
  serviceIds,
  date,
  time,
  clientId,
  locationId,
}: {
  slug: string;
  code: string;
  serviceIds: number[];
  date: string;
  time: string | null;
  clientId: number | null;
  locationId: number | null;
}): Promise<{ found: boolean; ok: boolean; reason: string; context: AppointmentPromoContext }> {
  const none: AppointmentPromoContext = { applied: false, promotion: null, services: [], discount: 0, reason: "" };
  const normalized = String(code ?? "").trim().toUpperCase();
  if (!normalized) return { found: false, ok: false, reason: "", context: none };
  const promoRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "promotions",
    where: "UPPER(TRIM(COALESCE(coupon_code,''))) = ? AND COALESCE(is_active,0) = 1",
    params: [normalized],
    orderBy: "priority DESC, id ASC",
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  const row = promoRows[0];
  if (!row) return { found: false, ok: false, reason: "", context: none };

  const ids = serviceIds.map((id) => Math.trunc(Number(id)) || 0).filter((id) => id > 0);
  const ph = Array.from(new Set(ids)).map(() => "?").join(", ");
  const svcRows = ids.length
    ? await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "id, price", where: `id IN (${ph})`, params: Array.from(new Set(ids)) }).catch(() => [] as RowDataPacket[])
    : [];
  const priceById = new Map<number, number>(svcRows.map((r) => [Number(r.id ?? 0), Math.max(0, Number(r.price ?? 0) || 0)]));
  const cart: PromoCartLine[] = ids
    .map((id) => ({ type: "service" as const, id, qty: 1, unitPrice: priceById.get(id) ?? 0 }))
    .filter((line) => line.unitPrice > 0);
  if (!cart.length) return { found: true, ok: false, reason: "Nessun servizio valido nel carrello.", context: none };

  // Evaluate JUST this promotion with its child mappings (the shared per-cart
  // evaluator only returns eligible rows without reasons).
  const promotionId = Number(row.id ?? 0);
  const result = await evaluateSinglePromotionForCart(slug, row, cart, date, time ?? "", clientId ?? 0, locationId ?? 0);
  if (!result.eligible || result.discount <= 0) {
    return { found: true, ok: false, reason: result.reason || "Promozione non applicabile.", context: none };
  }
  const meta = promoStackMeta(row);
  const services = Object.entries(result.breakdownServices)
    .map(([sid, b]) => ({ service_id: Number(sid), list_price: roundMoney(b.old), booked_price: roundMoney(b.now), discount_badge: b.badge }))
    .filter((line) => line.list_price > 0 && line.booked_price >= 0 && line.list_price - line.booked_price > 0.000001);
  return {
    found: true,
    ok: true,
    reason: "",
    context: {
      applied: true,
      promotion: { id: promotionId, title: meta.title, stackable: meta.stackable, stackable_with_fidelity: meta.stackableWithFidelity, stackable_with_coupon: meta.stackableWithCoupon },
      services,
      discount: result.discount,
      reason: "",
    },
  };
}

// Evaluate ONE promotion row against a cart, loading its child mappings (the
// same shape evaluatePromotionsForCart builds per row).
async function evaluateSinglePromotionForCart(
  slug: string,
  promo: RowDataPacket,
  cart: PromoCartLine[],
  date: string,
  time: string,
  clientId: number,
  locationId: number,
): Promise<PromoEvalResult> {
  const promotionId = Number(promo.id ?? 0);
  const grab = async (table: string): Promise<RowDataPacket[]> =>
    tenantSelect<RowDataPacket>({ slug, table, where: "promotion_id = ?", params: [promotionId] }).catch(() => [] as RowDataPacket[]);
  const [bo, tw, svc, prd, loc] = await Promise.all([
    grab("promotion_blackout_dates"),
    grab("promotion_time_windows"),
    grab("promotion_services"),
    grab("promotion_products"),
    grab("promotion_locations"),
  ]);
  const defMap = (rows: RowDataPacket[], refCol: string) => {
    const m = new Map<number, { type: "percent" | "fixed"; value: number; minQty: number }>();
    for (const r of rows) {
      const t2 = String(r.discount_type ?? "percent").toLowerCase() === "fixed" ? "fixed" : "percent";
      m.set(Number(r[refCol] ?? 0), { type: t2 as "percent" | "fixed", value: Math.max(0, Number(r.discount_value ?? 0) || 0), minQty: Math.max(1, Number(r.min_qty ?? 1) || 1) });
    }
    return m;
  };
  const ch: PromoChildren = {
    blackouts: new Set(bo.map((r) => (typeof r.blackout_date === "string" ? r.blackout_date.slice(0, 10) : r.blackout_date ? toIso(r.blackout_date).slice(0, 10) : "")).filter(Boolean)),
    windows: tw.map((r) => ({ day: Number(r.day_of_week ?? 0), start: String(r.start_time ?? "").slice(0, 5), end: String(r.end_time ?? "").slice(0, 5) })),
    serviceDefs: defMap(svc, "service_id"),
    productDefs: defMap(prd, "product_id"),
    locationIds: new Set(loc.map((r) => Number(r.location_id ?? 0)).filter((n) => n > 0)),
  };
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayIso();
  const ctx = clientId > 0 ? await loadPromoClientCtx(slug, clientId, day, promoNormTime(time)) : null;
  return evaluateOnePromotion(promo, ch, cart, day, promoNormTime(time), clientId, locationId, ctx);
}

// Selected-scope services/products that must still resolve to a live, active
// catalog item before an inactive promotion can be re-activated (port of
// Promotions::activationContentIssues). Returns human-readable blocker strings.
async function promotionActivationContentIssues(slug: string, id: number): Promise<string[]> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "promotions", columns: "apply_services_mode, apply_products_mode", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) return [];
  const issues: string[] = [];

  const check = async (childTable: string, refCol: string, catalog: string, typeLabel: string) => {
    const refs = await tenantSelect<RowDataPacket>({ slug, table: childTable, columns: `${refCol} AS ref`, where: "promotion_id = ?", params: [id], orderBy: `${refCol} ASC` }).catch(() => [] as RowDataPacket[]);
    for (const r of refs) {
      const refId = Number(r.ref ?? 0);
      if (refId <= 0) continue;
      const cat = await tenantSelect<RowDataPacket>({ slug, table: catalog, columns: "id, name, is_active", where: "id = ?", params: [refId], limit: 1 }).catch(() => [] as RowDataPacket[]);
      if (!cat[0]) issues.push(`${typeLabel} "${typeLabel} #${refId}" è stato eliminato`);
      else if (Number(cat[0].is_active ?? 1) !== 1) issues.push(`${typeLabel} "${String(cat[0].name ?? `#${refId}`)}" è stato disattivato`);
    }
  };

  if (String(rows[0].apply_services_mode ?? "all").toLowerCase() === "selected") await check("promotion_services", "service_id", "services", "Servizio");
  if (String(rows[0].apply_products_mode ?? "none").toLowerCase() === "selected") await check("promotion_products", "product_id", "products", "Prodotto");
  return issues;
}

// Detach a promotion from still-open appointments so a delete/deactivate does not
// leave a dangling reference (port of Promotions::clearPendingAppointmentsForPromotion).
// Done + historical rows keep their promotion for the record.
async function clearPendingAppointmentsForPromotion(slug: string, id: number): Promise<void> {
  const appt = await tenantTable(slug, "appointments");
  if (!(await columnExists(appt.name, "promotion_id"))) return;
  const setConds = (await columnExists(appt.name, "promotion_conditions")) ? ", promotion_conditions = NULL" : "";
  await dbExecute(`UPDATE ${quoteIdentifier(appt.name)} SET promotion_id = NULL${setConds} WHERE tenant_id = ? AND promotion_id = ? AND status IN ('pending','scheduled')`, [appt.tenantId ?? 0, id]).catch(() => undefined);
}

// Activate/deactivate a promotion (port of promotions.php toggle / Promotions::
// setActive): activating is refused while a selected service/product is deleted or
// disabled; deactivating detaches the promo from open appointments.
export async function toggleManagePromotion(slug: string, id: number, active: boolean, by: number): Promise<PromotionRule> {
  if (id <= 0) throw new Error("Promozione non valida.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "promotions", columns: "id", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Promozione non trovata.");
  if (active) {
    const issues = await promotionActivationContentIssues(slug, id);
    if (issues.length > 0) {
      throw new Error(`Non è possibile riattivare la promozione perché ${issues.join("; ")}. Attiva o ripristina gli elementi indicati per continuare.`);
    }
  }
  await tenantUpdate({ slug, table: "promotions", id, values: { is_active: active ? 1 : 0, updated_by: by > 0 ? by : null, updated_at: new Date() } });
  if (!active) await clearPendingAppointmentsForPromotion(slug, id);
  const updated = await tenantSelect<RowDataPacket>({ slug, table: "promotions", where: "id = ?", params: [id], limit: 1 });
  return mapPromotion(updated[0]);
}

// Delete a promotion (port of Promotions::delete): detach open appointments, drop
// the mapping children (services/products/time windows/blackouts/locations), then
// the promotions row.
export async function deleteManagePromotion(slug: string, id: number): Promise<{ ok: true }> {
  if (id <= 0) throw new Error("Promozione non valida.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "promotions", columns: "id", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) return { ok: true };

  await clearPendingAppointmentsForPromotion(slug, id);
  for (const child of ["promotion_services", "promotion_products", "promotion_time_windows", "promotion_blackout_dates", "promotion_locations"]) {
    if (!(await tableExists((await tenantTable(slug, child)).name))) continue;
    const t = await tenantTable(slug, child);
    await dbExecute(`DELETE FROM ${quoteIdentifier(t.name)} WHERE tenant_id = ? AND promotion_id = ?`, [t.tenantId ?? 0, id]).catch(() => undefined);
  }
  await tenantDelete({ slug, table: "promotions", id });
  return { ok: true };
}

function normalizePromoMode(value: string, fallback: "all" | "none"): "none" | "all" | "selected" {
  const mode = value.trim().toLowerCase();
  return mode === "none" || mode === "all" || mode === "selected" ? mode : fallback;
}

function nullableInt(value: unknown): number | null {
  const s = String(value ?? "").trim();
  if (s === "") return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function listDbGiftBoxes(slug: string): Promise<GiftBoxInstance[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "giftbox_instances",
    orderBy: "created_at DESC, id DESC",
  });
  return Promise.all(rows.map((row) => mapGiftBox(slug, row)));
}

export async function issueDbGiftBox(
  input: { clientId?: number; recipientName?: string; serviceId?: number; sessions?: number; expiresAt?: string; sourceSaleId?: number },
  slug: string,
): Promise<GiftBoxInstance> {
  const giftboxRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "giftboxes",
    where: "COALESCE(active, 1) = 1 AND deleted_at IS NULL",
    orderBy: "sort_order ASC, id ASC",
    limit: 1,
  });
  const service = input.serviceId && input.serviceId > 0 ? await getSingleService(slug, input.serviceId) : (await listDbServices({ slug }))[0];
  if (!service) throw new Error("Servizio GiftBox non trovato.");
  const giftboxId = Number(giftboxRows[0]?.id ?? 0);
  if (giftboxId <= 0) throw new Error("Catalogo GiftBox non trovato.");
  const id = await tenantInsert(await tenantTable(slug, "giftbox_instances"), {
    voucher_public_token: randomHex(64),
    giftbox_id: giftboxId,
    code: `GB${Date.now().toString(36).toUpperCase().slice(-8)}`,
    client_id: input.clientId && input.clientId > 0 ? input.clientId : null,
    recipient_name: normalizeName(input.recipientName, "Destinatario"),
    status: "issued",
    issued_at: new Date(),
    expires_at: input.expiresAt ?? addDaysDate(180),
    note: input.sourceSaleId ? `Vendita #${input.sourceSaleId}` : null,
  });
  await tenantInsert(await tenantTable(slug, "giftbox_instance_items"), {
    instance_id: id,
    giftbox_item_id: 0,
    item_type: "service",
    service_id: service.id,
    qty: Math.max(1, Math.round(input.sessions ?? 1)),
    custom_label: service.name,
  }).catch(() => 0);
  return getSingleGiftBox(slug, id);
}

export async function redeemDbGiftBox(id: number, quantity: number, slug: string): Promise<GiftBoxInstance> {
  const giftBox = await getSingleGiftBox(slug, id);
  if (giftBox.status !== "active") throw new Error("GiftBox non utilizzabile.");
  const qty = Math.max(1, Math.round(quantity));
  if (giftBox.remainingItems < qty) throw new Error("Residuo GiftBox insufficiente.");
  for (let index = 0; index < qty; index += 1) {
    await tenantInsert(await tenantTable(slug, "giftbox_redemptions"), {
      instance_id: id,
      redeemed_at: new Date(),
      source_type: "manual",
      note: "Riscatto manuale GiftBox",
    }).catch(() => 0);
  }
  if (giftBox.remainingItems - qty <= 0) {
    await tenantUpdate({ slug, table: "giftbox_instances", id, values: { status: "redeemed", redeemed_at: new Date() } });
  }
  return getSingleGiftBox(slug, id);
}

// ---- GiftBox INSTANCE detail + manage (giftbox.php tab=instances) ------------
export type ManageGiftBoxInstanceItem = { id: number; itemType: string; name: string; qty: number };
export type ManageGiftBoxInstance = {
  id: number;
  code: string;
  giftboxName: string;
  recipientName: string;
  recipientEmail: string;
  clientId: number;
  status: string;
  statusLabel: string;
  statusBadge: string;
  issuedAt: string;
  expiresAt: string;
  redeemedAt: string;
  cancelledAt: string;
  pointsCost: number;
  note: string;
  items: ManageGiftBoxInstanceItem[];
  totalUnits: number;
  redeemedUnits: number;
  remainingUnits: number;
  linkedSaleId: number | null;
  canRedeem: boolean;
  canCancel: boolean;
};

const GIFTBOX_STATUS_META: Record<string, { label: string; badge: string }> = {
  active: { label: "Attiva", badge: "bg-success" },
  issued: { label: "Attiva", badge: "bg-success" },
  redeemed: { label: "Riscattata", badge: "bg-secondary" },
  expired: { label: "Scaduta", badge: "bg-warning text-dark" },
  cancelled: { label: "Annullata", badge: "bg-danger" },
};

// Full giftbox INSTANCE detail (port of giftbox.php action=edit_instance): the
// header (code / template name / recipient / status / dates / points) + the
// instance items (giftbox_instance_items with resolved names) + redeemed/residual
// units + the linked sale (parsed from the "Vendita #N" note). Read-only.
export async function getManageGiftBoxInstance(slug: string, id: number): Promise<ManageGiftBoxInstance | null> {
  if (id <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftbox_instances", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) return null;
  const inst = rows[0];

  const giftboxId = Number(inst.giftbox_id ?? 0);
  let giftboxName = "";
  if (giftboxId > 0) {
    const gb = await tenantSelect<RowDataPacket>({ slug, table: "giftboxes", columns: "name", where: "id = ?", params: [giftboxId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    giftboxName = String(gb[0]?.name ?? "");
  }

  const itemRows = await tenantSelect<RowDataPacket>({ slug, table: "giftbox_instance_items", where: "instance_id = ?", params: [id], orderBy: "sort_order ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  const items: ManageGiftBoxInstanceItem[] = [];
  let totalUnits = 0;
  for (const r of itemRows) {
    const itemType = String(r.item_type ?? "service");
    const qty = Math.max(1, Number(r.qty ?? 1));
    totalUnits += qty;
    let name = String(r.custom_label ?? "").trim() || snapshotServiceName(r.service_snapshot_json);
    if (name === "") {
      if (itemType === "product") {
        const pr = await tenantSelect<RowDataPacket>({ slug, table: "products", columns: "name", where: "id = ?", params: [Number(r.product_id ?? 0)], limit: 1 }).catch(() => [] as RowDataPacket[]);
        name = String(pr[0]?.name ?? `Prodotto #${r.product_id}`);
      } else {
        name = await serviceNameById(slug, Number(r.service_id ?? 0), `Servizio #${r.service_id}`);
      }
    }
    items.push({ id: Number(r.id ?? 0), itemType, name, qty });
  }

  const rawStatus = String(inst.status ?? "issued").trim().toLowerCase();
  const trackedRedeemed = await giftBoxRedeemedUnits(slug, id);
  const isCancelled = rawStatus === "cancelled" || rawStatus === "canceled";
  const isRedeemed = rawStatus === "redeemed";
  // A fully redeemed/cancelled instance has no residual (matches the legacy).
  const redeemedUnits = isRedeemed ? totalUnits : Math.min(totalUnits, trackedRedeemed);
  const remainingUnits = isCancelled || isRedeemed ? 0 : Math.max(0, totalUnits - redeemedUnits);
  // Status with cancelled taking priority (giftBoxStatus would map a 0-residual
  // cancelled instance to "redeemed").
  const exp = String(inst.expires_at ?? "").slice(0, 10);
  const status = isCancelled
    ? "cancelled"
    : isRedeemed || remainingUnits <= 0
      ? "redeemed"
      : exp !== "" && exp < todayIso()
        ? "expired"
        : "active";
  const meta = GIFTBOX_STATUS_META[status] ?? { label: status, badge: "bg-secondary" };

  // Linked sale from the "Vendita #N" note marker (issueGiftboxFromSale).
  let linkedSaleId: number | null = null;
  const noteMatch = String(inst.note ?? "").match(/Vendita\s+#(\d+)/i);
  if (noteMatch) linkedSaleId = Number(noteMatch[1]) || null;

  return {
    id,
    code: String(inst.code ?? ""),
    giftboxName,
    recipientName: String(inst.recipient_name ?? ""),
    recipientEmail: String(inst.recipient_email ?? ""),
    clientId: Number(inst.recipient_client_id ?? inst.client_id ?? 0) || 0,
    status,
    statusLabel: meta.label,
    statusBadge: meta.badge,
    issuedAt: inst.issued_at ? toIso(inst.issued_at) : "",
    expiresAt: inst.expires_at ? String(inst.expires_at).slice(0, 10) : "",
    redeemedAt: inst.redeemed_at ? toIso(inst.redeemed_at) : "",
    cancelledAt: inst.cancelled_at ? toIso(inst.cancelled_at) : "",
    pointsCost: Number(inst.points_cost ?? 0) || 0,
    note: String(inst.note ?? ""),
    items,
    totalUnits,
    redeemedUnits,
    remainingUnits,
    linkedSaleId,
    canRedeem: (status === "active") && remainingUnits > 0,
    canCancel: status === "active",
  };
}

// Cancel a giftbox instance (port of giftbox.php cancel / GiftBox::cancelInstance):
// status='cancelled' + cancelled_at/by. Refuses an already redeemed/cancelled one.
export async function cancelManageGiftBoxInstance(slug: string, id: number, by: number): Promise<{ ok: true }> {
  if (id <= 0) throw new Error("Istanza non valida.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftbox_instances", columns: "id, status", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Istanza non trovata.");
  const st = String(rows[0].status ?? "").trim().toLowerCase();
  if (st === "cancelled" || st === "canceled") throw new Error("GiftBox già annullata.");
  if (st === "redeemed") throw new Error("GiftBox già riscattata: non annullabile.");
  await tenantUpdate({ slug, table: "giftbox_instances", id, values: { status: "cancelled", cancelled_at: new Date(), cancelled_by: by > 0 ? by : null } });
  return { ok: true };
}

// Update a giftbox instance's recipient + note + expiry (port of giftbox.php
// update_instance / GiftBox::updateInstance). Assigning a recipient_client_id
// links the giftbox to that client (so it shows in their residuals) and forces
// the recipient name/email from the client's anagrafica (like the legacy). A
// cancelled instance is not editable.
export async function updateManageGiftBoxInstance(
  slug: string,
  id: number,
  input: { recipientClientId?: number; recipientName?: string; recipientEmail?: string; note?: string; expiresAt?: string },
): Promise<{ ok: true }> {
  if (id <= 0) throw new Error("Istanza non valida.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftbox_instances", columns: "id, status", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Istanza non trovata.");
  const st = String(rows[0].status ?? "").trim().toLowerCase();
  if (st === "cancelled" || st === "canceled") throw new Error("GiftBox annullata: non modificabile.");

  let recipientName = String(input.recipientName ?? "").trim();
  let recipientEmail = String(input.recipientEmail ?? "").trim();
  const recipientClientId = Math.max(0, Math.trunc(Number(input.recipientClientId ?? 0)));
  if (recipientClientId > 0) {
    const cRows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "full_name, email", where: "id = ?", params: [recipientClientId], limit: 1 });
    if (!cRows[0]) throw new Error("Cliente destinatario non trovato.");
    const cName = String(cRows[0].full_name ?? "").trim();
    if (cName !== "") recipientName = cName;
    const cEmail = String(cRows[0].email ?? "").trim();
    if (cEmail !== "" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cEmail)) recipientEmail = cEmail;
  }

  const values = await filterColumns((await tenantTable(slug, "giftbox_instances")).name, {
    recipient_client_id: recipientClientId > 0 ? recipientClientId : null,
    recipient_name: recipientName !== "" ? recipientName : null,
    recipient_email: recipientEmail !== "" ? recipientEmail : null,
    note: input.note !== undefined ? (String(input.note).trim() || null) : undefined,
    expires_at: input.expiresAt !== undefined && normalizeClientDate(input.expiresAt) ? normalizeClientDate(input.expiresAt) : undefined,
    updated_at: new Date(),
  });
  await tenantUpdate({ slug, table: "giftbox_instances", id, values });
  return { ok: true };
}

// Redeem an ENTIRE giftbox instance (port of giftbox.php redeem_instance /
// GiftBox::redeemInstance): mark all remaining units redeemed → status='redeemed'.
export async function redeemManageGiftBoxInstanceFull(slug: string, id: number, by: number): Promise<{ ok: true }> {
  if (id <= 0) throw new Error("Istanza non valida.");
  const detail = await getManageGiftBoxInstance(slug, id);
  if (!detail) throw new Error("Istanza non trovata.");
  if (detail.status === "cancelled") throw new Error("GiftBox annullata: non riscattabile.");
  if (detail.status === "redeemed" || detail.remainingUnits <= 0) throw new Error("GiftBox già riscattata.");
  if (detail.status === "expired") throw new Error("GiftBox scaduta: non riscattabile.");
  // Log a manual redemption for the residual, then flip the instance to redeemed.
  await tenantInsert(await tenantTable(slug, "giftbox_redemptions"), {
    instance_id: id,
    redeemed_at: new Date(),
    source_type: "manual",
    note: "Riscatto manuale GiftBox",
    redeemed_by: by > 0 ? by : null,
  }).catch(() => 0);
  await tenantUpdate({ slug, table: "giftbox_instances", id, values: { status: "redeemed", redeemed_at: new Date(), redeemed_by: by > 0 ? by : null, redeemed_source_type: "manual" } });
  return { ok: true };
}

export async function listDbGifts(slug: string): Promise<GiftReward[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "gift_instances",
    orderBy: "created_at DESC, id DESC",
  });
  return Promise.all(rows.map((row) => mapGiftReward(slug, row)));
}

export async function issueDbGift(
  input: { clientId?: number; clientName?: string; title?: string; rewardType?: GiftReward["rewardType"]; value?: number; expiresAt?: string },
  slug: string,
): Promise<GiftReward> {
  const client = await resolveSaleClientForDb(slug, input.clientId ?? 0, input.clientName);
  const giftId = await ensureDbGiftTemplate(slug, input);
  const id = await tenantInsert(await tenantTable(slug, "gift_instances"), {
    voucher_public_token: randomHex(64),
    gift_id: giftId,
    client_id: client.id,
    state: "disponibile",
    is_active: 1,
    unlocked_at: new Date(),
    expires_at: input.expiresAt ?? addDaysDate(60),
    progress_json: JSON.stringify({ source: "next", value: input.value ?? 0 }),
  });
  return getSingleGift(slug, id);
}

// Port of action=fidelity_gift_redeem (api_appointments.php:7886) — the calendar
// edit modal's "Registra gift": redeem a whole GIFT INSTANCE against an existing
// appointment. gift_idx is optional: the legacy auto-picks the first available
// instance (Omaggi v2 instances cost 0 points, so the first eligible one wins).
// The instance is marked 'riscattato' with source appointment, a gift_transactions
// row records it, and the appointment's reserved fidelity-gift fields are cleared.
// Throws the legacy messages ('Nessun omaggio riscattabile', 'omaggio non
// trovato/attivo/disponibile/scaduto', 'Appuntamento non coerente...').
export async function fidelityGiftRedeemForAppointment({
  slug,
  clientId,
  appointmentId,
  giftIdx = null,
  createdBy = null,
}: {
  slug: string;
  clientId: number;
  appointmentId: number;
  giftIdx?: number | null;
  createdBy?: number | null;
}): Promise<{ pointsUsed: number; availablePoints: number }> {
  const apptRows = await tenantSelect<RowDataPacket>({ slug, table: "appointments", columns: "id, client_id", where: "id = ?", params: [appointmentId], limit: 1 });
  const appt = apptRows[0];
  const apptClientId = Number(appt?.client_id ?? 0) || 0;
  if (!appt || apptClientId <= 0 || apptClientId !== clientId) {
    throw new Error("Appuntamento non coerente con il cliente selezionato.");
  }

  // Auto-pick: first AVAILABLE instance of the client (state disponibile, active,
  // not expired by calendar day), assignment order.
  let instanceId = Math.max(0, Number(giftIdx ?? 0) || 0);
  if (instanceId <= 0) {
    const candidates = await tenantSelect<RowDataPacket>({
      slug,
      table: "gift_instances",
      columns: "id",
      where: "client_id = ? AND LOWER(COALESCE(state,'')) = 'disponibile' AND COALESCE(is_active,0) = 1 AND (expires_at IS NULL OR expires_at::date >= ?)",
      params: [clientId, todayIso()],
      orderBy: "id ASC",
      limit: 1,
    }).catch(() => [] as RowDataPacket[]);
    instanceId = Number(candidates[0]?.id ?? 0) || 0;
  }
  if (instanceId <= 0) throw new Error("Nessun omaggio riscattabile");

  // Validate the instance with the legacy redeemInstance guard chain.
  const instRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "gift_instances",
    columns: "id, client_id, state, is_active, expires_at",
    where: "id = ?",
    params: [instanceId],
    limit: 1,
  });
  const instance = instRows[0];
  if (!instance || Number(instance.client_id ?? 0) !== clientId) throw new Error("omaggio non trovato");
  if (Number(instance.is_active ?? 0) !== 1) throw new Error("omaggio non attivo");
  if (String(instance.state ?? "").trim().toLowerCase() !== "disponibile") throw new Error("omaggio non disponibile");
  const expiresYmd = instance.expires_at ? toIso(instance.expires_at).slice(0, 10) : "";
  if (expiresYmd && expiresYmd < todayIso()) throw new Error("omaggio scaduto");

  await tenantUpdate({
    slug,
    table: "gift_instances",
    id: instanceId,
    values: {
      state: "riscattato",
      is_active: 0,
      redeemed_at: new Date(),
      redeemed_source_type: "appointment",
      redeemed_source_id: appointmentId,
    },
  });
  await tenantInsert(await tenantTable(slug, "gift_transactions"), {
    instance_id: instanceId,
    appointment_id: appointmentId,
    type: "redeem",
    qty: 1,
    note: "Riscatto omaggio da appuntamento",
    created_by: createdBy && createdBy > 0 ? createdBy : null,
    created_at: new Date(),
  }).catch(() => 0);

  // Clear the reservation fields IF this exact gift was the reserved one (legacy
  // UPDATE ... WHERE fidelity_gift_idx=?; a different reservation stays intact).
  const apptTable = await tenantTable(slug, "appointments");
  await dbExecute(
    `UPDATE ${quoteIdentifier(apptTable.name)} SET fidelity_gift_points_used = 0, fidelity_gift_idx = NULL WHERE tenant_id = ? AND id = ? AND client_id = ? AND fidelity_gift_idx = ?`,
    [apptTable.tenantId ?? 0, appointmentId, clientId, instanceId],
  ).catch(() => undefined);

  // Omaggi v2: instances never cost points — points_used is always 0.
  const { points } = await dbWalletBalance(clientId, slug).catch(() => ({ credit: 0, points: 0 }));
  return { pointsUsed: 0, availablePoints: Math.max(0, Math.round(Number(points) || 0)) };
}

export async function redeemDbGift(id: number, slug: string): Promise<GiftReward> {
  const gift = await getSingleGift(slug, id);
  if (gift.status !== "available") throw new Error("Omaggi non riscattabile.");
  await tenantUpdate({
    slug,
    table: "gift_instances",
    id,
    values: { state: "riscattato", is_active: 0, redeemed_at: new Date(), redeemed_source_type: "manual" },
  });
  await tenantInsert(await tenantTable(slug, "gift_transactions"), {
    instance_id: id,
    type: "redeem",
    qty: 1,
    note: "Riscatto manuale omaggio",
    created_at: new Date(),
  }).catch(() => 0);
  return getSingleGift(slug, id);
}

export type InstallmentPlanSearchFilters = {
  status?: string;
  clientId?: number;
  saleId?: number;
  q?: string;
  dueFrom?: string;
  dueTo?: string;
};

export async function listDbInstallmentPlans(slug: string): Promise<InstallmentPlan[]> {
  return searchDbInstallmentPlans(slug, {});
}

// Faithful port of SaleInstallments::searchPlans() (~lines 889-964).
export async function searchDbInstallmentPlans(
  slug: string,
  filters: InstallmentPlanSearchFilters = {},
): Promise<InstallmentPlan[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const clientId = Number(filters.clientId ?? 0);
  if (clientId > 0) {
    clauses.push("client_id = ?");
    params.push(clientId);
  }

  // Base status filter (only the three stored values are pushed to SQL; the
  // synthetic statuses overdue/open/paid/all are handled below).
  const status = String(filters.status ?? "").trim().toLowerCase();
  if (["active", "completed", "cancelled"].includes(status)) {
    clauses.push("status = ?");
    params.push(status);
  }

  const saleId = Number(filters.saleId ?? 0);
  if (saleId > 0) {
    clauses.push("sale_id = ?");
    params.push(saleId);
  }

  const q = String(filters.q ?? "").trim();
  if (q !== "") {
    // PHP joins clients for c.full_name LIKE ?; tenantSelect can't join, so we
    // resolve matching client ids first (tenant-scoped) and fold them in.
    const like = `%${q}%`;
    const clientRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "clients",
      columns: "id",
      where: "full_name LIKE ?",
      params: [like],
    }).catch(() => [] as RowDataPacket[]);
    const nameClientIds = clientRows.map((r) => Number(r.id ?? 0)).filter((n) => n > 0);
    const qInt = Number.parseInt(q, 10);
    const qId = Number.isNaN(qInt) ? 0 : qInt;
    const orParts: string[] = ["notes LIKE ?", "sale_id = ?", "client_id = ?"];
    params.push(like, qId, qId);
    if (nameClientIds.length > 0) {
      orParts.push(`client_id IN (${nameClientIds.map(() => "?").join(",")})`);
      params.push(...nameClientIds);
    }
    clauses.push(`(${orParts.join(" OR ")})`);
  }

  const dueFrom = normalizeClientDate(filters.dueFrom);
  const dueTo = normalizeClientDate(filters.dueTo);
  if (dueFrom || dueTo) {
    // Faithful EXISTS on sale_installments.due_date; scope the subquery to the
    // resolved tenant table + tenant_id so it never leaks cross-tenant.
    const instTable = await tenantTable(slug, "sale_installments");
    const scoped = instTable.mode === "shared" && (await columnExists(instTable.name, "tenant_id"));
    const subClauses: string[] = ["i.plan_id = p.id"];
    const subParams: unknown[] = [];
    if (scoped) {
      subClauses.push("i.tenant_id = ?");
      subParams.push(instTable.tenantId ?? 0);
    }
    if (dueFrom) {
      subClauses.push("i.due_date >= ?");
      subParams.push(dueFrom);
    }
    if (dueTo) {
      subClauses.push("i.due_date <= ?");
      subParams.push(dueTo);
    }
    clauses.push(`EXISTS (SELECT 1 FROM ${quoteIdentifier(instTable.name)} i WHERE ${subClauses.join(" AND ")})`);
    // EXISTS params must precede the other where params: rebuild ordering.
    params.push(...subParams);
  }

  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "sale_installment_plans",
    where: clauses.length ? clauses.map((c) => `(${c})`).join(" AND ") : "",
    params,
    // status precedence (active=0, completed=1, else=2), then first_due_date, then id DESC.
    orderBy:
      "CASE WHEN status = 'active' THEN 0 WHEN status = 'completed' THEN 1 ELSE 2 END ASC, COALESCE(first_due_date, '9999-12-31') ASC, id DESC",
  });

  const hydrated = await Promise.all(
    rows.map(async (row) => ({
      // Raw stored status ('active'|'completed'|'cancelled'), matching PHP's p.status.
      rawStatus: String(row.status ?? "active").trim().toLowerCase(),
      plan: await mapInstallmentPlan(slug, row),
    })),
  );

  // Synthetic status overrides (applied post-hydration, exactly as PHP searchPlans).
  let filtered = hydrated;
  if (status === "overdue") {
    filtered = hydrated.filter((h) => h.plan.overdueCount > 0 && h.rawStatus !== "cancelled");
  } else if (status === "paid") {
    filtered = hydrated.filter((h) => h.rawStatus === "completed");
  } else if (status === "open") {
    filtered = hydrated.filter((h) => h.rawStatus !== "cancelled" && h.plan.remaining > 0.00001);
  }
  // "all" and unrecognized statuses apply no additional filter.

  return filtered.map((h) => h.plan);
}

export async function createDbInstallmentPlan(
  input: { saleId?: number; clientId?: number; clientName?: string; total?: number; count?: number },
  slug: string,
): Promise<InstallmentPlan> {
  const sale = input.saleId && input.saleId > 0 ? await getSaleRow(slug, input.saleId) : null;
  const client = await resolveSaleClientForDb(slug, input.clientId ?? Number(sale?.client_id ?? 0), input.clientName);
  const total = roundMoney(Math.max(1, Number(input.total ?? sale?.total ?? 0)));
  const count = Math.max(1, Math.round(Number(input.count ?? 3)));
  const amount = roundMoney(total / count);
  const planId = await tenantInsert(await tenantTable(slug, "sale_installment_plans"), {
    sale_id: input.saleId ?? Number(sale?.id ?? 0) ?? 0,
    client_id: client.id > 0 ? client.id : null,
    payment_type: "card",
    status: "active",
    sale_total: total,
    down_payment_amount: 0,
    financed_amount: total,
    installments_count: count,
    interval_value: 1,
    interval_unit: "month",
    first_due_date: addDaysDate(30),
    last_due_date: addDaysDate(30 * count),
    config_json: JSON.stringify({ source: "next" }),
  });
  for (let index = 0; index < count; index += 1) {
    await tenantInsert(await tenantTable(slug, "sale_installments"), {
      plan_id: planId,
      sale_id: input.saleId ?? Number(sale?.id ?? 0) ?? 0,
      client_id: client.id > 0 ? client.id : null,
      installment_no: index + 1,
      due_date: addDaysDate(30 * (index + 1)),
      amount: index === count - 1 ? roundMoney(total - amount * (count - 1)) : amount,
      status: "pending",
      payment_type: "card",
    });
  }
  return getSingleInstallmentPlan(slug, planId);
}

// CANCEL an entire installment plan (faithful port of SaleInstallments::cancelPlanBySaleId
// ~640-686, keyed by plan id here): flip the plan to 'cancelled' (+ cancelled_at/reason), flip every
// installment to 'cancelled' and append a "[ANNULLATA <ts>] <reason>" marker to its note. Blocks when
// any installment is already PAID unless allowPaid is set (the legacy "Esistono rate già incassate…"
// guard) so an operator does not silently void collected money. Returns the re-hydrated plan.
export async function cancelDbInstallmentPlan(
  slug: string,
  planId: number,
  reason: string,
  userId: number | null = null,
  allowPaid = false,
): Promise<InstallmentPlan> {
  if (planId <= 0) throw new Error("Piano rateale non valido.");
  const planTable = await tenantTable(slug, "sale_installment_plans");
  const planRows = await tenantSelect<RowDataPacket>({ slug, table: planTable.name, where: "id = ?", params: [planId], limit: 1 });
  const plan = planRows[0];
  if (!plan) throw new Error("Piano rateale non trovato.");
  if (String(plan.status ?? "").toLowerCase() === "cancelled") throw new Error("Piano rateale gia annullato.");

  const installmentRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "sale_installments",
    columns: "id, status, note",
    where: "plan_id = ?",
    params: [planId],
  });
  const paidCount = installmentRows.filter((r) => String(r.status ?? "").toLowerCase() === "paid").length;
  if (paidCount > 0 && !allowPaid) {
    throw new Error("Esistono rate gia incassate: non e possibile annullare il piano.");
  }

  const cleanReason = String(reason ?? "").trim().slice(0, 255) || "Annullamento piano rateale";
  const now = new Date();
  const tsLabel = now.toISOString().slice(0, 16).replace("T", " ");

  const planValues: Record<string, unknown> = { status: "cancelled", updated_by: userId };
  if (await columnExists(planTable.name, "cancelled_at")) planValues.cancelled_at = now;
  if (await columnExists(planTable.name, "cancelled_reason")) planValues.cancelled_reason = cleanReason;
  await tenantUpdate({ slug, table: "sale_installment_plans", id: planId, values: planValues });

  for (const r of installmentRows) {
    const prevNote = String(r.note ?? "");
    const nextNote = `${prevNote}${prevNote ? "\n" : ""}[ANNULLATA ${tsLabel}] ${cleanReason}`.slice(0, 1000);
    await tenantUpdate({
      slug,
      table: "sale_installments",
      id: Number(r.id ?? 0),
      values: { status: "cancelled", note: nextNote, updated_by: userId },
    }).catch(() => 0);
  }

  return getSingleInstallmentPlan(slug, planId);
}

export async function payDbInstallment(planId: number, installmentId: number, slug: string): Promise<InstallmentPlan> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "sale_installments", where: "plan_id = ? AND id = ?", params: [planId, installmentId], limit: 1 });
  if (!rows[0]) throw new Error("Rata non trovata.");
  if (String(rows[0].status ?? "") === "paid") throw new Error("Rata gia pagata.");
  const amount = Number(rows[0].amount ?? 0);
  await tenantUpdate({ slug, table: "sale_installments", id: installmentId, values: { status: "paid", paid_at: new Date(), paid_amount: amount } });
  const pending = await tenantSelect<RowDataPacket>({ slug, table: "sale_installments", columns: "id", where: "plan_id = ? AND status = 'pending'", params: [planId], limit: 1 });
  if (!pending[0]) await tenantUpdate({ slug, table: "sale_installment_plans", id: planId, values: { status: "completed" } });
  return getSingleInstallmentPlan(slug, planId);
}

export async function listDbCommissions(slug: string): Promise<CommissionEntry[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff_commission_payments",
    orderBy: "movement_datetime DESC, id DESC",
  });
  return rows.map(mapCommission);
}

export async function commissionDbSummary(slug: string): Promise<{ open: number; paid: number; reversed: number; dueAmount: number }> {
  const commissions = await listDbCommissions(slug);
  return {
    open: commissions.filter((commission) => commission.status === "open").length,
    paid: commissions.filter((commission) => commission.status === "paid").length,
    reversed: commissions.filter((commission) => commission.status === "reversed").length,
    dueAmount: roundMoney(commissions.filter((commission) => commission.status === "open").reduce((total, commission) => total + commission.amount, 0)),
  };
}

export async function markDbCommissionPaid(id: number, slug: string): Promise<CommissionEntry> {
  await tenantUpdate({ slug, table: "staff_commission_payments", id, values: { is_paid: 1, paid_at: new Date() } });
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "staff_commission_payments", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Commissione non trovata.");
  return mapCommission(rows[0]);
}

export async function listDbAutomationRules(slug: string): Promise<AutomationRule[]> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "automation_settings", orderBy: "id ASC", limit: 1 });
  const row = rows[0] ?? {};
  const createdAt = toIso(row.created_at);
  return [
    { id: 1, name: "Promemoria appuntamento email", channel: "email", trigger: "appointment_reminder", enabled: Number(row.reminder_enabled ?? 1) === 1, createdAt },
    { id: 2, name: "Promemoria appuntamento SMS", channel: "sms", trigger: "appointment_reminder", enabled: Number(row.sms_reminder_enabled ?? 0) === 1, createdAt },
    { id: 3, name: "Appuntamento approvato", channel: "email", trigger: "appointment_reminder", enabled: Number(row.approved_enabled ?? 1) === 1, createdAt },
    { id: 4, name: "Scadenza fidelity", channel: "email", trigger: "fidelity_expiry", enabled: Number(row.fidelity_expiry_reminder_enabled ?? 0) === 1, createdAt },
    { id: 5, name: "Scadenza rata", channel: "browser", trigger: "quote_followup", enabled: Number(row.installment_alert_days ?? 0) > 0, createdAt },
  ];
}

export async function toggleDbAutomationRule(id: number, enabled: boolean, slug: string): Promise<AutomationRule> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "automation_settings", orderBy: "id ASC", limit: 1 });
  if (!rows[0]) throw new Error("Automazione non configurata.");
  const field = automationFieldForId(id);
  if (field) await tenantUpdate({ slug, table: "automation_settings", id: Number(rows[0].id ?? 0), values: { [field]: enabled ? 1 : 0 } });
  const rules = await listDbAutomationRules(slug);
  const rule = rules.find((item) => item.id === id);
  if (!rule) throw new Error("Automazione non trovata.");
  return rule;
}

// Persist the installment due-alert window (automation_settings.installment_alert_days), clamped to
// 0..365 — faithful to Helpers::installment_notification_days save. Updates the single settings row,
// inserting one if the tenant has none yet. Returns the stored value.
export async function saveDbInstallmentAlertDays(slug: string, days: number): Promise<number> {
  const clamped = Math.max(0, Math.min(365, Math.round(Number(days) || 0)));
  const table = await tenantTable(slug, "automation_settings");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: table.name, columns: "id", orderBy: "id ASC", limit: 1 });
  if (rows[0]) {
    await tenantUpdate({ slug, table: "automation_settings", id: Number(rows[0].id ?? 0), values: { installment_alert_days: clamped } });
  } else {
    await tenantInsert(table, { installment_alert_days: clamped });
  }
  return clamped;
}

export async function runDbAutomationRule(id: number, slug: string): Promise<{ rule: AutomationRule; notifications: NotificationItem[] }> {
  const rules = await listDbAutomationRules(slug);
  const rule = rules.find((item) => item.id === id);
  if (!rule) throw new Error("Automazione non trovata.");
  if (!rule.enabled) throw new Error("Automazione disattivata.");
  return {
    rule: { ...rule, lastRunAt: new Date().toISOString() },
    notifications: [{
      id: Date.now(),
      type: "system",
      title: "Automazione eseguita",
      message: rule.name,
      read: false,
      link: "automation",
      createdAt: new Date().toISOString(),
    }],
  };
}

export async function listDbNotifications(slug: string): Promise<NotificationItem[]> {
  const notifications: NotificationItem[] = [];
  const today = todayIso();
  const upcoming = addDaysDate(7);

  try {
    const appointments = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointments",
      where: "DATE(starts_at) BETWEEN ? AND ? AND status IN ('pending','scheduled')",
      params: [today, upcoming],
      orderBy: "starts_at ASC",
      limit: 20,
    });
    appointments.forEach((row) => notifications.push({
      id: 100000 + Number(row.id ?? 0),
      type: "appointment",
      title: "Appuntamento in arrivo",
      message: `Appuntamento #${row.id} del ${String(row.starts_at ?? "").slice(0, 16)}`,
      read: false,
      link: "appointments",
      createdAt: toIso(row.starts_at),
    }));
  } catch {}

  try {
    const costs = await tenantSelect<RowDataPacket>({
      slug,
      table: "costs",
      where: "COALESCE(is_paid, 0) = 0 AND due_date <= ?",
      params: [upcoming],
      orderBy: "due_date ASC",
      limit: 20,
    });
    costs.forEach((row) => notifications.push({
      id: 200000 + Number(row.id ?? 0),
      type: "cost",
      title: "Costo in scadenza",
      message: `${String(row.title ?? "Costo")} - ${roundMoney(Number(row.amount ?? 0))} euro`,
      read: false,
      link: "costs",
      createdAt: toIso(row.due_date),
    }));
  } catch {}

  try {
    const installments = await tenantSelect<RowDataPacket>({
      slug,
      table: "sale_installments",
      where: "status = 'pending' AND due_date <= ?",
      params: [upcoming],
      orderBy: "due_date ASC",
      limit: 20,
    });
    installments.forEach((row) => notifications.push({
      id: 300000 + Number(row.id ?? 0),
      type: "system",
      title: "Rata in scadenza",
      message: `Rata #${row.installment_no} - ${roundMoney(Number(row.amount ?? 0))} euro`,
      read: false,
      link: "installments_manage",
      createdAt: toIso(row.due_date),
    }));
  } catch {}

  return notifications.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function markDbNotificationRead(id: number, slug: string): Promise<NotificationItem> {
  const notification = (await listDbNotifications(slug)).find((item) => item.id === id);
  if (!notification) throw new Error("Notifica non trovata.");
  return { ...notification, read: true };
}

export async function listDbConfigModule(moduleId: string, slug: string): Promise<ConfigModuleState> {
  const normalized = normalizeConfigModuleId(moduleId);

  if (normalized === "quote_settings") return quoteSettingsConfig(slug);
  if (normalized === "pos_settings") return posSettingsConfig(slug);
  if (normalized === "business_profile") return businessProfileConfig(slug);
  if (normalized === "package_settings") return packageSettingsConfig(slug);
  if (normalized === "fidelity_membership") return fidelityMembershipConfig(slug);
  if (normalized === "fidelity_levels") return fidelityLevelsConfig(slug);
  if (normalized === "giftbox_settings") return giftboxSettingsConfig(slug);
  if (normalized === "giftcard_settings") return giftcardSettingsConfig(slug);
  if (normalized === "hours") return hoursConfig(slug);
  if (normalized === "roles") return rolesConfig(slug);
  if (normalized === "accessibility") return accessibilityConfig(slug);

  const def = configDefinitions[normalized];
  if (!def) throw new Error("Modulo configurazione non mappato su DB.");
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: def.table,
    where: def.where ?? "",
    orderBy: def.orderBy ?? "id DESC",
    limit: def.limit ?? 200,
  });

  return configStateFromRows(normalized, def.title, def.source, rows.map((row, index) => configRecordFromRow(normalized, row, def, index)));
}

export async function toggleDbConfigRecord(moduleId: string, recordId: number, active: boolean, slug: string): Promise<ConfigModuleState> {
  const normalized = normalizeConfigModuleId(moduleId);
  const def = configDefinitions[normalized];
  if (!def?.activeColumn) throw new Error("Toggle DB non disponibile per questo modulo.");
  await tenantUpdate({ slug, table: def.table, id: recordId, values: { [def.activeColumn]: active ? 1 : 0 } });
  return listDbConfigModule(normalized, slug);
}

export async function touchDbConfigModule(moduleId: string, slug: string): Promise<ConfigModuleState> {
  return listDbConfigModule(moduleId, slug);
}

// ---- Global Fidelity toggle (fidelity.php _mode=toggle_fidelity) --------------
export type FidelityDisableImpact = {
  blockingPromotions: Array<{ id: number; name: string }>;
  blockingGifts: Array<{ id: number; name: string }>;
  linkedAppointmentCount: number;
};

export async function getFidelityEnabled(slug: string): Promise<boolean> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "fidelity_enabled", orderBy: "id ASC", limit: 1 });
  return Number(rows[0]?.fidelity_enabled ?? 0) === 1;
}

// Pending/scheduled appointments still carrying Fidelity benefits (the disable
// would strip them). Returns the rows (id + client + reserved points) for the strip.
async function fidelityLinkedAppointments(slug: string): Promise<RowDataPacket[]> {
  return tenantSelect<RowDataPacket>({
    slug,
    table: "appointments",
    columns: "id, client_id, fidelity_points_used, fidelity_gift_points_used",
    where: "status IN ('pending','scheduled') AND (COALESCE(fidelity_points_used,0) > 0 OR COALESCE(fidelity_discount,0) > 0 OR COALESCE(fidelity_gift_points_used,0) > 0 OR COALESCE(fidelity_gift_idx,0) > 0 OR COALESCE(fidelity_conflict_choice,'') <> '')",
  }).catch(() => [] as RowDataPacket[]);
}

// Fidelity-linked campaigns that block disabling (port of the two collect_*
// helpers): active promotions targeting fidelity + active fidelity-only gifts.
async function fidelityDisableImpact(slug: string): Promise<FidelityDisableImpact> {
  const promoRows = await tenantSelect<RowDataPacket>({ slug, table: "promotions", columns: "id, title", where: "target_type = 'fidelity' AND COALESCE(is_active,0) = 1", orderBy: "title ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  const giftRows = await tenantSelect<RowDataPacket>({ slug, table: "gifts", columns: "id, name", where: "deleted_at IS NULL AND eligibility = 'fidelity_only' AND COALESCE(active,0) = 1", orderBy: "name ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  const linked = await fidelityLinkedAppointments(slug);
  return {
    blockingPromotions: promoRows.map((r) => ({ id: Number(r.id ?? 0), name: String(r.title || `Promozione #${r.id}`) })),
    blockingGifts: giftRows.map((r) => ({ id: Number(r.id ?? 0), name: String(r.name || `Omaggio #${r.id}`) })),
    linkedAppointmentCount: linked.length,
  };
}

// Enable/disable the whole Fidelity program (port of fidelity.php toggle_fidelity).
// Enabling is a plain flag write. Disabling: refuse while fidelity-targeted
// Promozioni/Omaggi campaigns are active; when pending/scheduled appointments
// still carry Fidelity benefits, require `confirmed` (returns needsConfirm), then
// strip those benefits (restore the reserved points to the client + clear the
// fidelity columns), flip the flag, and deactivate active fidelity_campaigns.
export async function setFidelityEnabled(
  slug: string,
  enabled: boolean,
  confirmed: boolean,
): Promise<{ ok: boolean; enabled: boolean; needsConfirm?: boolean; impact?: FidelityDisableImpact; strippedAppointments?: number; deactivatedCampaigns?: number; restoredPromotions?: number; restoredGifts?: number; message?: string }> {
  const bizRows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "id, fidelity_enabled", orderBy: "id ASC", limit: 1 });
  if (!bizRows[0]) throw new Error("Business non trovato.");
  const bizId = Number(bizRows[0].id ?? 0);
  const currentlyEnabled = Number(bizRows[0].fidelity_enabled ?? 0) === 1;

  if (enabled) {
    await tenantUpdate({ slug, table: "businesses", id: bizId, values: { fidelity_enabled: 1 } });
    // F3 — riattivazione (fidelity.php ~900-950): ripristina le promozioni e gli
    // omaggi che erano stati auto-disattivati dalla disattivazione Fidelity
    // (auto_disabled_by_fidelity=1 -> attivi, flag azzerato).
    let restoredPromotions = 0;
    let restoredGifts = 0;
    if (!currentlyEnabled) {
      const promoTable = await tenantTable(slug, "promotions").catch(() => null);
      if (promoTable && (await columnExists(promoTable.name, "auto_disabled_by_fidelity"))) {
        const res = await dbExecute(
          `UPDATE ${quoteIdentifier(promoTable.name)} SET is_active = 1, auto_disabled_by_fidelity = 0 WHERE tenant_id = ? AND COALESCE(auto_disabled_by_fidelity,0) = 1`,
          [promoTable.tenantId ?? 0],
        ).catch(() => ({ affectedRows: 0 }));
        restoredPromotions = Number(res.affectedRows ?? 0) || 0;
      }
      const giftsTable = await tenantTable(slug, "gifts").catch(() => null);
      if (giftsTable && (await columnExists(giftsTable.name, "auto_disabled_by_fidelity"))) {
        const res = await dbExecute(
          `UPDATE ${quoteIdentifier(giftsTable.name)} SET active = 1, auto_disabled_by_fidelity = 0 WHERE tenant_id = ? AND COALESCE(auto_disabled_by_fidelity,0) = 1${(await columnExists(giftsTable.name, "deleted_at")) ? " AND deleted_at IS NULL" : ""}`,
          [giftsTable.tenantId ?? 0],
        ).catch(() => ({ affectedRows: 0 }));
        restoredGifts = Number(res.affectedRows ?? 0) || 0;
      }
    }
    let message = "Fidelity attivata";
    if (restoredPromotions > 0) message += `. ${restoredPromotions} ${restoredPromotions === 1 ? "campagna Promozioni target Fidelity riattivata" : "campagne Promozioni target Fidelity riattivate"}`;
    if (restoredGifts > 0) message += `. ${restoredGifts} ${restoredGifts === 1 ? "campagna Omaggi Solo clienti con Fidelity riattivata" : "campagne Omaggi Solo clienti con Fidelity riattivate"}`;
    return { ok: true, enabled: true, restoredPromotions, restoredGifts, message };
  }

  if (!currentlyEnabled) {
    await tenantUpdate({ slug, table: "businesses", id: bizId, values: { fidelity_enabled: 0 } });
    return { ok: true, enabled: false, message: "Fidelity disattivata" };
  }

  const impact = await fidelityDisableImpact(slug);
  if (impact.blockingPromotions.length > 0 || impact.blockingGifts.length > 0) {
    const parts: string[] = [];
    if (impact.blockingPromotions.length > 0) parts.push(`${impact.blockingPromotions.length} ${impact.blockingPromotions.length === 1 ? "campagna Promozioni collegata alla Fidelity" : "campagne Promozioni collegate alla Fidelity"}`);
    if (impact.blockingGifts.length > 0) parts.push(`${impact.blockingGifts.length} ${impact.blockingGifts.length === 1 ? "campagna Omaggi collegata alla Fidelity" : "campagne Omaggi collegate alla Fidelity"}`);
    throw new Error(`Per disattivare l'impostazione generale Fidelity devi prima disattivare le campagne collegate: ${parts.join(" e ")}.`);
  }

  const linked = await fidelityLinkedAppointments(slug);
  if (linked.length > 0 && !confirmed) {
    return { ok: false, enabled: true, needsConfirm: true, impact };
  }

  // Strip the fidelity benefits from the linked appointments + restore points.
  for (const appt of linked) {
    const apptId = Number(appt.id ?? 0);
    const clientId = Number(appt.client_id ?? 0);
    const restore = Math.max(0, Math.round(Number(appt.fidelity_points_used ?? 0))) + Math.max(0, Math.round(Number(appt.fidelity_gift_points_used ?? 0)));
    if (restore > 0 && clientId > 0) {
      await dbExecute(
        `UPDATE ${quoteIdentifier((await tenantTable(slug, "clients")).name)} SET points = COALESCE(points,0) + ? WHERE id = ?${(await columnExists((await tenantTable(slug, "clients")).name, "tenant_id")) ? " AND tenant_id = ?" : ""}`,
        (await columnExists((await tenantTable(slug, "clients")).name, "tenant_id")) ? [restore, clientId, (await tenantTable(slug, "clients")).tenantId ?? 0] : [restore, clientId],
      ).catch(() => undefined);
    }
    await tenantUpdate({ slug, table: "appointments", id: apptId, values: { fidelity_points_used: 0, fidelity_discount: 0, fidelity_gift_points_used: 0, fidelity_gift_idx: null, fidelity_conflict_choice: "", fidelity_campaign_id: null } }).catch(() => undefined);
  }

  await tenantUpdate({ slug, table: "businesses", id: bizId, values: { fidelity_enabled: 0 } });

  // Deactivate active points campaigns.
  let deactivatedCampaigns = 0;
  const campTable = await tenantTable(slug, "fidelity_campaigns").catch(() => null);
  if (campTable) {
    const scoped = campTable.mode === "shared" && (await columnExists(campTable.name, "tenant_id"));
    const hasDeleted = await columnExists(campTable.name, "deleted_at");
    // auto_disabled_by_points=1 (fidelity_page_deactivate_active_campaigns):
    // il badge UI "Disattivata da Punti" e il toggle campagna lo azzerano.
    const hasAutoFlag = await columnExists(campTable.name, "auto_disabled_by_points");
    const res = await dbExecute(
      `UPDATE ${quoteIdentifier(campTable.name)} SET active = 0${hasAutoFlag ? ", auto_disabled_by_points = 1" : ""} WHERE COALESCE(active,0) = 1${hasDeleted ? " AND deleted_at IS NULL" : ""}${scoped ? " AND tenant_id = ?" : ""}`,
      scoped ? [campTable.tenantId ?? 0] : [],
    ).catch(() => ({ affectedRows: 0, insertId: 0 }));
    deactivatedCampaigns = res.affectedRows ?? 0;
  }

  // Messaggio composto legacy (fidelity.php ~881-897).
  let message = "Fidelity disattivata";
  if (deactivatedCampaigns > 0) message += `. ${deactivatedCampaigns} ${deactivatedCampaigns === 1 ? "campagna punti attiva disattivata" : "campagne punti attive disattivate"}`;
  if (linked.length > 0) message += `. Rimosse automaticamente le agevolazioni Fidelity da ${linked.length} ${linked.length === 1 ? "prenotazione" : "prenotazioni"}`;

  return { ok: true, enabled: false, strippedAppointments: linked.length, deactivatedCampaigns, message };
}

// ---- Fidelity POINTS settings (fidelity_points.php save_settings) ------------
export type FidelityPointsSettings = {
  globalEnabled: boolean;
  pointsEnabled: boolean;
  earnStepEuro: number;
  redeemEnabled: boolean;
  redeemEuroPerPoint: number;
  redeemMinPoints: number;
  expireEnabled: boolean;
  expireDays: number;
  expireWarnDays: number;
};

function clampNum(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n) || n <= min) return fallback;
  return Math.min(max, n);
}

export async function getFidelityPointsSettings(slug: string): Promise<FidelityPointsSettings> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 });
  const r = rows[0] ?? ({} as RowDataPacket);
  let epp = Number(r.fidelity_redeem_euro_per_point ?? 0.1);
  if (!Number.isFinite(epp) || epp <= 0) epp = 0.1;
  let step = Number(r.fidelity_earn_step_euro ?? 10);
  if (!Number.isFinite(step) || step <= 0) step = 10;
  return {
    globalEnabled: Number(r.fidelity_enabled ?? 0) === 1,
    pointsEnabled: Number(r.fidelity_points_enabled ?? 0) === 1,
    earnStepEuro: Math.min(100000, step),
    redeemEnabled: Number(r.fidelity_redeem_enabled ?? 0) === 1,
    redeemEuroPerPoint: roundMoney(Math.min(100000, epp)),
    redeemMinPoints: Math.max(0, Math.round(Number(r.fidelity_redeem_min_points ?? 0))),
    expireEnabled: Number(r.fidelity_expire_enabled ?? 0) === 1,
    expireDays: Math.max(0, Math.min(36500, Math.round(Number(r.fidelity_expire_days ?? 365)))),
    expireWarnDays: Math.max(0, Math.min(36500, Math.round(Number(r.fidelity_expire_warn_days ?? 30)))),
  };
}

// F7 — statistiche reali della pagina Punti (colonna destra legacy): punti
// emessi/usati/scaduti dal ledger transactions + campagne attive + campagna
// attiva oggi (per il banner).
export type FidelityPointsStats = { emitted: number; used: number; expired: number; activeCampaigns: number; activeCampaignToday: string };
export async function getFidelityPointsStats(slug: string): Promise<FidelityPointsStats> {
  const sum = async (where: string): Promise<number> => {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "transactions", columns: "COALESCE(SUM(delta_points),0) AS s", where }).catch(() => [] as RowDataPacket[]);
    return Math.abs(normalizeFidelityPoints(rows[0]?.s ?? 0));
  };
  const emitted = await sum("delta_points > 0");
  const used = await sum("kind = 'redeem'");
  const expired = await sum("kind = 'expire'");

  let activeCampaigns = 0;
  let activeCampaignToday = "";
  const campRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "fidelity_campaigns",
    columns: "name, starts_at, ends_at",
    where: "COALESCE(active,0) = 1 AND deleted_at IS NULL",
  }).catch(() => [] as RowDataPacket[]);
  activeCampaigns = campRows.length;
  const today = new Date().toISOString().slice(0, 10);
  for (const c of campRows) {
    const starts = String(c.starts_at ?? "").slice(0, 10);
    const ends = String(c.ends_at ?? "").slice(0, 10);
    if ((starts === "" || starts <= today) && (ends === "" || ends >= today)) {
      activeCampaignToday = String(c.name ?? "");
      break;
    }
  }
  return { emitted, used, expired, activeCampaigns, activeCampaignToday };
}

// Save the fidelity points earn/redeem/expire settings (port of fidelity_points.php
// save_settings): the earn step (€/point), redeem toggle + rate + min points, and
// the points-expiry window. When the Points module is OFF the redeem/expiry prefs
// are PRESERVED (not zeroed) for reactivation. Enabling expiry needs days > 0 when
// the program is operational. earn_mode is fixed to 'amount' and earn-on-done is
// always on (legacy: those toggles were removed).
export async function saveFidelityPointsSettings(slug: string, body: Record<string, string>): Promise<FidelityPointsSettings> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 });
  if (!rows[0]) throw new Error("Business non trovato.");
  const existing = rows[0];
  const bizId = Number(existing.id ?? 0);
  const truthy = (v: unknown) => ["1", "true", "on", "yes"].includes(String(v ?? "").toLowerCase());

  const pointsEnabled = truthy(body.fidelity_points_enabled);
  // Earn step lives in the campaign editor, not the main settings form: fall back
  // to the existing value (legacy: $_POST[...] ?? $settings['earn_step_euro'] ?? 10).
  const earnStepFallback = clampNum(Number(existing.fidelity_earn_step_euro ?? 10), 0, 100000, 10);
  const earnStep = String(body.fidelity_earn_step_euro ?? "").trim() !== ""
    ? clampNum(Number(String(body.fidelity_earn_step_euro).replace(",", ".")), 0, 100000, 10)
    : earnStepFallback;
  let redeemEnabled = truthy(body.fidelity_redeem_enabled);
  let epp = clampNum(Number(String(body.fidelity_redeem_euro_per_point ?? "").replace(",", ".")), 0, 100000, 0.1);
  let minPts = Math.max(0, Math.min(100000000, Math.round(Number(String(body.fidelity_redeem_min_points ?? "0").replace(",", ".")) || 0)));
  // Parse an int, keeping 0 (a plain `Number(x)||def` would turn 0 into def).
  const intOr = (v: unknown, def: number): number => { const s = String(v ?? "").trim(); if (s === "") return def; const n = Number(s.replace(",", ".")); return Number.isFinite(n) ? Math.round(n) : def; };
  let expireEnabled = truthy(body.fidelity_expire_enabled);
  let expireDays = Math.max(0, Math.min(36500, intOr(body.fidelity_expire_days, 365)));
  let warnDays = Math.max(0, Math.min(36500, intOr(body.fidelity_expire_warn_days, 30)));

  // Points OFF → preserve the stored redeem/expiry preferences.
  if (!pointsEnabled) {
    redeemEnabled = Number(existing.fidelity_redeem_enabled ?? 0) === 1;
    expireEnabled = Number(existing.fidelity_expire_enabled ?? 0) === 1;
    expireDays = Math.max(0, Math.min(36500, Math.round(Number(existing.fidelity_expire_days ?? expireDays))));
    warnDays = Math.max(0, Math.min(36500, Math.round(Number(existing.fidelity_expire_warn_days ?? warnDays))));
    epp = clampNum(Number(existing.fidelity_redeem_euro_per_point ?? epp), 0, 100000, 0.1);
    minPts = Math.max(0, Math.min(100000000, Math.round(Number(existing.fidelity_redeem_min_points ?? minPts))));
  }

  const globalEnabled = Number(existing.fidelity_enabled ?? 0) === 1;
  if (globalEnabled && pointsEnabled && expireEnabled && expireDays <= 0) {
    throw new Error('Per abilitare la scadenza punti inserisci un valore maggiore di 0 in "Scadenza dopo".');
  }

  // F6 — conferme popup legacy (fidelity_points.php ~2014-2025) + rimozione
  // agevolazioni + disattivazione campagne quando si spengono punti/redeem.
  const truthyConfirm = (v: unknown) => ["1", "true", "on", "yes"].includes(String(v ?? "").toLowerCase());
  const pointsWasEnabled = Number(existing.fidelity_points_enabled ?? 0) === 1;
  const redeemWasEnabled = Number(existing.fidelity_redeem_enabled ?? 0) === 1;
  const disablingPoints = pointsWasEnabled && !pointsEnabled;
  const disablingRedeem = pointsEnabled && redeemWasEnabled && !redeemEnabled;

  let strippedAppointments = 0;
  if (globalEnabled && (disablingPoints || disablingRedeem)) {
    const impacted = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointments",
      columns: "id, client_id, COALESCE(fidelity_points_used,0) AS pts, COALESCE(fidelity_gift_points_used,0) AS gpts",
      where: "status IN ('pending','scheduled') AND (COALESCE(fidelity_points_used,0) > 0 OR COALESCE(fidelity_discount,0) > 0)",
    }).catch(() => [] as RowDataPacket[]);
    if (impacted.length > 0 && !truthyConfirm(body.fidelity_disable_confirmed)) {
      const targetLabel = disablingPoints ? "Punti Fidelity" : "sconto tramite punti";
      throw new Error(
        `Prima di disattivare "${targetLabel}" conferma dal popup la rimozione degli sconti/scelte punti da ${impacted.length} ${impacted.length === 1 ? "prenotazione aperta" : "prenotazioni aperte"}. Saldo punti, movimenti e storico resteranno salvati.`,
      );
    }
    // Strip confermato: le prenotazioni aperte perdono lo sconto punti; i punti
    // riservati tornano al saldo (nel modello Next la riserva è una detrazione).
    for (const appt of impacted) {
      const clientId = Number(appt.client_id ?? 0);
      const restore = Math.max(0, Math.round(Number(appt.pts ?? 0))) + (disablingPoints ? Math.max(0, Math.round(Number(appt.gpts ?? 0))) : 0);
      if (restore > 0 && clientId > 0) {
        const clientsTable = await tenantTable(slug, "clients");
        await dbExecute(
          `UPDATE ${quoteIdentifier(clientsTable.name)} SET points = COALESCE(points,0) + ? WHERE tenant_id = ? AND id = ?`,
          [restore, clientsTable.tenantId ?? 0, clientId],
        ).catch(() => undefined);
      }
      await tenantUpdate({
        slug,
        table: "appointments",
        id: Number(appt.id),
        values: disablingPoints
          ? { fidelity_points_used: 0, fidelity_discount: 0, fidelity_gift_points_used: 0, fidelity_gift_idx: null, fidelity_conflict_choice: "" }
          : { fidelity_points_used: 0, fidelity_discount: 0 },
      }).catch(() => undefined);
    }
    strippedAppointments = impacted.length;
  }

  // Conferma cambio scadenza (fidelity_points.php ~2022-2025).
  const prevExpireEnabledGuard = Number(existing.fidelity_expire_enabled ?? 0) === 1;
  const prevExpireDaysGuard = Math.max(0, Math.round(Number(existing.fidelity_expire_days ?? 0)));
  const expiryChanged = prevExpireEnabledGuard !== expireEnabled || (expireEnabled && prevExpireDaysGuard !== expireDays);
  if (globalEnabled && pointsEnabled && expiryChanged && !truthyConfirm(body.fidelity_expiry_confirmed)) {
    throw new Error("Prima di modificare la scadenza punti conferma dal popup: i punti residui aperti verranno riallineati alla nuova impostazione.");
  }

  // Punti disattivati -> campagne punti attive disattivate (auto_disabled_by_points).
  let deactivatedCampaigns = 0;
  if (disablingPoints) {
    const campTable = await tenantTable(slug, "fidelity_campaigns").catch(() => null);
    if (campTable) {
      const hasAutoFlag = await columnExists(campTable.name, "auto_disabled_by_points");
      const hasDeleted = await columnExists(campTable.name, "deleted_at");
      const res = await dbExecute(
        `UPDATE ${quoteIdentifier(campTable.name)} SET active = 0${hasAutoFlag ? ", auto_disabled_by_points = 1" : ""} WHERE tenant_id = ? AND COALESCE(active,0) = 1${hasDeleted ? " AND deleted_at IS NULL" : ""}`,
        [campTable.tenantId ?? 0],
      ).catch(() => ({ affectedRows: 0 }));
      deactivatedCampaigns = Number(res.affectedRows ?? 0) || 0;
    }
  }

  const values = await filterColumns((await tenantTable(slug, "businesses")).name, {
    fidelity_points_enabled: pointsEnabled ? 1 : 0,
    fidelity_points_label: "Punti",
    fidelity_earn_mode: "amount",
    fidelity_earn_step_euro: roundMoney(earnStep),
    fidelity_earn_points_per_appointment: 0,
    fidelity_earn_on_appointment_done: 1,
    fidelity_redeem_enabled: redeemEnabled ? 1 : 0,
    fidelity_redeem_euro_per_point: roundMoney(epp),
    fidelity_redeem_min_points: minPts,
    fidelity_redeem_auto_discount_enabled: 0,
    fidelity_expire_enabled: expireEnabled ? 1 : 0,
    fidelity_expire_days: expireDays,
    fidelity_expire_warn_days: warnDays,
    updated_at: new Date(),
  });
  await tenantUpdate({ slug, table: "businesses", id: bizId, values });

  // Scadenza cambiata -> riallinea i lotti aperti alla nuova impostazione
  // (port of fidelity_points.php ~2135-2143: Fidelity::applyExpirySettingsToOpenLots
  // dopo il commit). Best-effort: il cron reconcile ripara eventuali code.
  if (expiryChanged) {
    await applyExpirySettingsToOpenLots(slug, expireEnabled, expireDays).catch(() => null);
  }

  // Messaggio composto legacy (fidelity_points.php ~2145-2162).
  let message = "Impostazioni Fidelity salvate";
  if (expiryChanged) message += ". Scadenze punti aggiornate sui saldi residui";
  if (disablingPoints) message += ". Punti Fidelity disattivati";
  if (!pointsWasEnabled && pointsEnabled) message += ". Punti Fidelity attivati";
  if (deactivatedCampaigns > 0) message += `. ${deactivatedCampaigns} ${deactivatedCampaigns === 1 ? "campagna punti attiva disattivata" : "campagne punti attive disattivate"}`;
  if (strippedAppointments > 0) message += `. Rimosse automaticamente le agevolazioni punti da ${strippedAppointments} ${strippedAppointments === 1 ? "prenotazione" : "prenotazioni"}`;

  const settings = await getFidelityPointsSettings(slug);
  return { ...settings, message } as FidelityPointsSettings & { message: string };
}

// ---- Fidelity CAMPAIGNS (fidelity_points.php save/toggle/delete campaign) -----
export type FidelityCampaignTier = { minSpend: number; points: number };
export type FidelityCampaign = {
  id: number;
  name: string;
  active: boolean;
  startsAt: string;
  endsAt: string;
  earnMode: "amount" | "tiers";
  earnStepEuro: number;
  tiers: FidelityCampaignTier[];
  eligibleLevels: string[];
  minSpend: number;
};

function parseCampaignTiers(raw: unknown): FidelityCampaignTier[] {
  let src: unknown = raw;
  if (typeof src === "string") { try { src = JSON.parse(src); } catch { return []; } }
  const arr = Array.isArray(src) ? src : Array.isArray((src as { tiers?: unknown })?.tiers) ? (src as { tiers: unknown[] }).tiers : [];
  const seen = new Map<number, number>();
  for (const t of arr) {
    const o = t as Record<string, unknown>;
    const minSpend = roundMoney(Math.max(0, Number(o.minSpend ?? o.min_spend ?? 0) || 0));
    const points = Math.max(0, Math.min(100000000, Math.round(Number(o.points ?? 0) || 0)));
    if (points <= 0) continue;
    if (!seen.has(minSpend) || points > (seen.get(minSpend) ?? 0)) seen.set(minSpend, points);
  }
  return Array.from(seen.entries()).sort((a, b) => a[0] - b[0]).map(([minSpend, points]) => ({ minSpend, points }));
}

function parseCampaignLevels(raw: unknown): string[] {
  let src: unknown = raw;
  if (typeof src === "string") {
    const s = src.trim();
    if (s === "") return [];
    if (s.startsWith("[")) { try { src = JSON.parse(s); } catch { src = s.split(","); } }
    else src = s.split(",");
  }
  if (!Array.isArray(src)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of src) { const k = String(v ?? "").trim().toLowerCase(); if (k !== "" && !seen.has(k)) { seen.add(k); out.push(k); } }
  return out;
}

function mapFidelityCampaign(row: RowDataPacket): FidelityCampaign {
  const earnMode = String(row.earn_mode ?? "amount") === "tiers" ? "tiers" : "amount";
  return {
    id: Number(row.id ?? 0),
    name: String(row.name ?? "Campagna punti"),
    active: Number(row.active ?? 0) === 1,
    startsAt: row.starts_at ? String(row.starts_at).slice(0, 10) : "",
    endsAt: row.ends_at ? String(row.ends_at).slice(0, 10) : "",
    earnMode,
    earnStepEuro: roundMoney(Number(row.earn_step_euro ?? 10) || 10),
    tiers: earnMode === "tiers" ? parseCampaignTiers(row.earn_tiers) : [],
    eligibleLevels: parseCampaignLevels(row.eligible_points_levels),
    minSpend: roundMoney(Number(row.min_spend ?? 0) || 0),
  };
}

export async function listFidelityCampaigns(slug: string): Promise<FidelityCampaign[]> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "fidelity_campaigns", where: "deleted_at IS NULL", orderBy: "id DESC" }).catch(() => [] as RowDataPacket[]);
  return rows.map(mapFidelityCampaign);
}

// The set of valid point-level keys (businesses.fidelity_card_levels_json + the
// always-present 'base'). Used to validate a campaign's eligible levels.
async function fidelityPointLevelKeys(slug: string): Promise<Set<string>> {
  const keys = new Set<string>(["base"]);
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "fidelity_card_levels_json", orderBy: "id ASC", limit: 1 }).catch(() => [] as RowDataPacket[]);
  for (const l of parseFidelityCardLevels(rows[0]?.fidelity_card_levels_json).levels) keys.add(l.key);
  return keys;
}

// ---- Fidelity LEVELS (fidelity_levels.php save_levels) ------------------------
export type FidelityLevel = { key: string; name: string; minPoints: number };
export type FidelityLevelsSettings = { enabled: boolean; pointsEnabled: boolean; levels: FidelityLevel[] };

// Parse businesses.fidelity_card_levels_json ({format:'split', points_enabled,
// points_levels:[{key,name,min_points}]}; tolerates a bare array / {levels:[]}).
function parseFidelityCardLevels(raw: unknown): { pointsEnabled: boolean; levels: FidelityLevel[] } {
  const s = String(raw ?? "").trim();
  if (s === "") return { pointsEnabled: false, levels: [] };
  try {
    const data = JSON.parse(s) as Record<string, unknown>;
    const arr = Array.isArray(data) ? data : Array.isArray(data.points_levels) ? data.points_levels : Array.isArray((data as { levels?: unknown }).levels) ? (data as { levels: unknown[] }).levels : [];
    const levels: FidelityLevel[] = [];
    for (const l of arr) {
      const o = l as Record<string, unknown>;
      const key = String(o.key ?? o.level ?? "").trim().toLowerCase();
      const name = String(o.name ?? "").trim();
      if (key === "" || name === "") continue;
      levels.push({ key, name, minPoints: Math.max(0, Number(o.min_points ?? o.minPoints ?? 0) || 0) });
    }
    return { pointsEnabled: Number(data.points_enabled ?? 0) === 1, levels };
  } catch {
    return { pointsEnabled: false, levels: [] };
  }
}

export async function getFidelityLevelsSettings(slug: string): Promise<FidelityLevelsSettings> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "fidelity_levels_enabled, fidelity_card_levels_json", orderBy: "id ASC", limit: 1 });
  const r = rows[0] ?? ({} as RowDataPacket);
  const parsed = parseFidelityCardLevels(r.fidelity_card_levels_json);
  return { enabled: Number(r.fidelity_levels_enabled ?? 0) === 1, pointsEnabled: parsed.pointsEnabled, levels: parsed.levels };
}

function normalizeLevelKey(v: string): string {
  let k = String(v ?? "").trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_-]/g, "").replace(/^[_-]+|[_-]+$/g, "");
  if (k === "") k = "level";
  if (k.length > 64) k = k.slice(0, 64);
  return k;
}

// Save the card levels (port of fidelity_levels.php save_levels): normalize + dedup
// keys, sort by min_points, ensure the always-present 'base' (min 0) level, refuse
// two levels with the same min points. When disabled the existing levels are
// preserved (only the toggle flips). Persists fidelity_levels_enabled +
// fidelity_card_levels_json ({format:'split', points_enabled, points_levels}).
// F4 — livello cliente dai punti maturati (port of Fidelity::calcClientLevelPoints
// ~2774 + earnedPointsInLastDays ~2821): somma dei delta POSITIVI in transactions
// nel periodo fidelity_level_period_days (0 = da sempre); il livello è quello con
// min_points più alto <= maturati. '' per non aderenti o sezione disattivata.
export async function calcClientFidelityLevelKey(slug: string, clientId: number): Promise<string> {
  if (clientId <= 0) return "";
  const points = await getFidelityPointsSettings(slug);
  const levelsCfg = await getFidelityLevelsSettings(slug);
  if (!points.globalEnabled || !levelsCfg.enabled || !levelsCfg.pointsEnabled || levelsCfg.levels.length === 0) return "";
  if (!(await fidelityIsClientAdhering(slug, clientId))) return "";

  const bizRows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "fidelity_level_period_days", orderBy: "id ASC", limit: 1 }).catch(() => [] as RowDataPacket[]);
  const periodDays = Math.max(0, Math.min(36500, Math.round(Number(bizRows[0]?.fidelity_level_period_days ?? 365))));

  const where = periodDays > 0 ? "client_id = ? AND delta_points > 0 AND created_at >= ?" : "client_id = ? AND delta_points > 0";
  const params: unknown[] = periodDays > 0 ? [clientId, new Date(Date.now() - periodDays * 86400000)] : [clientId];
  const sumRows = await tenantSelect<RowDataPacket>({ slug, table: "transactions", columns: "COALESCE(SUM(delta_points),0) AS s", where, params }).catch(() => [] as RowDataPacket[]);
  const earned = Math.max(0, normalizeFidelityPoints(sumRows[0]?.s ?? 0));

  let best = "";
  let bestMin = -1;
  for (const level of levelsCfg.levels) {
    if (level.minPoints <= earned && level.minPoints > bestMin) {
      best = level.key;
      bestMin = level.minPoints;
    }
  }
  return best;
}

// recalcClientLevelLocked (Fidelity.php ~3596): scrive clients.fidelity_level solo
// quando programma e livelli sono attivi. Best-effort, mai bloccante.
export async function recalcClientFidelityLevel(slug: string, clientId: number): Promise<string> {
  if (clientId <= 0) return "";
  const points = await getFidelityPointsSettings(slug);
  const levelsCfg = await getFidelityLevelsSettings(slug);
  if (!points.globalEnabled || !levelsCfg.enabled) return "";
  const key = await calcClientFidelityLevelKey(slug, clientId);
  await tenantUpdate({ slug, table: "clients", id: clientId, values: { fidelity_level: key } }).catch(() => 0);
  return key;
}

// Ricalcolo di massa (save_levels legacy ~1074-1086): titolari tessera + chi ha
// ancora un livello assegnato (per azzerare i residui).
async function recalcAllClientFidelityLevels(slug: string, cap = 2000): Promise<number> {
  const cardRows = await tenantSelect<RowDataPacket>({ slug, table: "cards", columns: "DISTINCT client_id", where: "client_id > 0", limit: cap }).catch(() => [] as RowDataPacket[]);
  const levelRows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "id", where: "COALESCE(fidelity_level,'') <> ''", limit: cap }).catch(() => [] as RowDataPacket[]);
  const ids = [...new Set([...cardRows.map((r) => Number(r.client_id ?? 0)), ...levelRows.map((r) => Number(r.id ?? 0))])].filter((n) => n > 0).slice(0, cap);
  for (const clientId of ids) await recalcClientFidelityLevel(slug, clientId).catch(() => "");
  return ids.length;
}

// Rimuove una key di livello da una colonna JSON-array e disattiva la riga quando
// la lista resta vuota (cascata legacy fidelity_levels_cleanup_deleted_levels).
function stripLevelKeys(raw: unknown, removed: Set<string>): { changed: boolean; empty: boolean; next: string } {
  let list: string[] = [];
  const s = String(raw ?? "").trim();
  if (s !== "") { try { const p = JSON.parse(s); if (Array.isArray(p)) list = p.map((x) => String(x)); } catch { list = []; } }
  if (list.length === 0) return { changed: false, empty: false, next: s };
  const next = list.filter((k) => !removed.has(k));
  return { changed: next.length !== list.length, empty: next.length === 0, next: JSON.stringify(next) };
}

export async function saveFidelityLevels(slug: string, body: Record<string, string>): Promise<FidelityLevelsSettings> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "id, fidelity_card_levels_json", orderBy: "id ASC", limit: 1 });
  if (!rows[0]) throw new Error("Business non trovato.");
  const bizId = Number(rows[0].id ?? 0);
  const existing = parseFidelityCardLevels(rows[0].fidelity_card_levels_json);
  const truthy = (v: unknown) => ["1", "true", "on", "yes"].includes(String(v ?? "").toLowerCase());

  const enabled = truthy(body.fidelity_levels_enabled);
  const pointsEnabled = enabled && truthy(body.fidelity_levels_points_enabled);

  let levels: FidelityLevel[] = existing.levels;
  if (pointsEnabled) {
    let raw: unknown = body.levels_json;
    if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { raw = []; } }
    const inputs = Array.isArray(raw) ? raw : [];
    const seen = new Set<string>();
    const uniqKey = (base: string): string => {
      let k = normalizeLevelKey(base);
      if (seen.has(k)) { let n = 2; while (seen.has(`${k}_${n}`)) n++; k = `${k}_${n}`; }
      seen.add(k);
      return k;
    };
    const parsed: FidelityLevel[] = [];
    for (const l of inputs) {
      const o = l as Record<string, unknown>;
      let name = String(o.name ?? "").trim();
      if (name === "") continue;
      if (name.length > 50) name = name.slice(0, 50);
      const key = uniqKey(String(o.key ?? "").trim() !== "" ? String(o.key) : name);
      parsed.push({ key, name, minPoints: Math.max(0, Number(String(o.minPoints ?? o.min_points ?? 0).replace(",", ".")) || 0) });
    }
    parsed.sort((a, b) => a.minPoints - b.minPoints);
    // Ensure the base level (key 'base', min 0).
    if (!parsed.some((l) => l.key === "base")) {
      const baseName = existing.levels.find((l) => l.key === "base")?.name ?? "Base";
      parsed.unshift({ key: "base", name: baseName, minPoints: 0 });
    }
    // No two levels with the same min points.
    const seenPts = new Set<string>();
    for (const l of parsed) {
      const k = l.minPoints.toFixed(2);
      if (seenPts.has(k)) throw new Error("Non puoi salvare due livelli card con gli stessi punti necessari.");
      seenPts.add(k);
    }
    levels = parsed;
  }

  // F4 — cascata legacy sui livelli RIMOSSI (o sull'intera sezione disattivata):
  // le key spariscono da campagne punti / promozioni target-fidelity / omaggi;
  // le righe rimaste senza livelli target vengono disattivate; le prenotazioni
  // aperte delle promozioni disattivate perdono la promozione.
  const prevKeys = existing.pointsEnabled ? existing.levels.map((l) => l.key) : [];
  const nextKeys = pointsEnabled ? levels.map((l) => l.key) : [];
  const removedKeys = new Set(prevKeys.filter((k) => !nextKeys.includes(k)));
  const truthyFlagLocal = (v: unknown) => ["1", "true", "on", "yes"].includes(String(v ?? "").toLowerCase());

  const cascade = { campUpd: 0, campOff: 0, promoUpd: 0, promoOff: 0, giftUpd: 0, giftOff: 0, apptCleared: 0 };
  if (removedKeys.size > 0) {
    // Conferma legacy: eliminare livelli richiede la conferma dal popup.
    if (!truthyFlagLocal(body.fidelity_delete_confirmed) && !truthyFlagLocal(body.fidelity_disable_confirmed)) {
      const removedNames = existing.levels.filter((l) => removedKeys.has(l.key)).map((l) => l.name);
      throw new Error(`Conferma prima l'eliminazione del livello a punti "${removedNames[0] ?? ""}".`);
    }

    // Campagne punti (fidelity_campaigns.eligible_points_levels).
    const campRows = await tenantSelect<RowDataPacket>({ slug, table: "fidelity_campaigns", columns: "id, active, eligible_points_levels", where: "deleted_at IS NULL" }).catch(() => [] as RowDataPacket[]);
    for (const row of campRows) {
      const res = stripLevelKeys(row.eligible_points_levels, removedKeys);
      if (!res.changed) continue;
      const deactivate = res.empty && Number(row.active ?? 0) === 1;
      await tenantUpdate({ slug, table: "fidelity_campaigns", id: Number(row.id), values: { eligible_points_levels: res.next, ...(deactivate ? { active: 0 } : {}), updated_at: new Date() } }).catch(() => 0);
      if (deactivate) cascade.campOff += 1; else cascade.campUpd += 1;
    }

    // Promozioni target Fidelity (promotions.target_fidelity_levels).
    const promoTable = await tenantTable(slug, "promotions").catch(() => null);
    if (promoTable && (await columnExists(promoTable.name, "target_fidelity_levels"))) {
      const promoRows = await tenantSelect<RowDataPacket>({ slug, table: "promotions", columns: "id, is_active, target_fidelity_levels", where: "target_type = 'fidelity'" }).catch(() => [] as RowDataPacket[]);
      const deactivatedPromoIds: number[] = [];
      for (const row of promoRows) {
        const res = stripLevelKeys(row.target_fidelity_levels, removedKeys);
        if (!res.changed) continue;
        const deactivate = res.empty && Number(row.is_active ?? 0) === 1;
        await tenantUpdate({ slug, table: "promotions", id: Number(row.id), values: { target_fidelity_levels: res.next, ...(deactivate ? { is_active: 0 } : {}) } }).catch(() => 0);
        if (deactivate) { cascade.promoOff += 1; deactivatedPromoIds.push(Number(row.id)); } else cascade.promoUpd += 1;
      }
      // Prenotazioni aperte collegate alle promozioni disattivate (clearPendingAppointments).
      const apptTable = await tenantTable(slug, "appointments").catch(() => null);
      if (deactivatedPromoIds.length > 0 && apptTable && (await columnExists(apptTable.name, "promotion_id"))) {
        const ph = deactivatedPromoIds.map(() => "?").join(",");
        cascade.apptCleared = Number((await dbExecute(
          `UPDATE ${quoteIdentifier(apptTable.name)} SET promotion_id = NULL, discount_type = NULL, discount_value = NULL WHERE tenant_id = ? AND status IN ('pending','scheduled') AND promotion_id IN (${ph})`,
          [apptTable.tenantId ?? 0, ...deactivatedPromoIds],
        ).catch(() => ({ affectedRows: 0 }))).affectedRows ?? 0) || 0;
      }
    }

    // Omaggi (gifts.eligible_levels_points).
    const giftsTable = await tenantTable(slug, "gifts").catch(() => null);
    if (giftsTable && (await columnExists(giftsTable.name, "eligible_levels_points"))) {
      const giftRows = await tenantSelect<RowDataPacket>({ slug, table: "gifts", columns: "id, active, eligible_levels_points", where: "deleted_at IS NULL" }).catch(() => [] as RowDataPacket[]);
      for (const row of giftRows) {
        const res = stripLevelKeys(row.eligible_levels_points, removedKeys);
        if (!res.changed) continue;
        const deactivate = res.empty && Number(row.active ?? 0) === 1;
        await tenantUpdate({ slug, table: "gifts", id: Number(row.id), values: { eligible_levels_points: res.next, ...(deactivate ? { active: 0 } : {}), updated_at: new Date() } }).catch(() => 0);
        if (deactivate) cascade.giftOff += 1; else cascade.giftUpd += 1;
      }
    }
  }

  const json = JSON.stringify({ format: "split", points_enabled: pointsEnabled ? 1 : 0, points_levels: levels.map((l) => ({ key: l.key, name: l.name, min_points: l.minPoints })) });
  const values = await filterColumns((await tenantTable(slug, "businesses")).name, {
    fidelity_levels_enabled: enabled ? 1 : 0,
    fidelity_card_levels_json: json,
    updated_at: new Date(),
  });
  await tenantUpdate({ slug, table: "businesses", id: bizId, values });

  // Ricalcolo livelli clienti (legacy save_levels ~1074-1086).
  await recalcAllClientFidelityLevels(slug).catch(() => 0);

  const settings = await getFidelityLevelsSettings(slug);
  // Messaggio composto legacy "Livelli Card salvati" + dettaglio cascata.
  const parts: string[] = [];
  if (cascade.promoUpd) parts.push(`${cascade.promoUpd} promozioni aggiornate`);
  if (cascade.promoOff) parts.push(`${cascade.promoOff} promozioni disattivate`);
  if (cascade.giftUpd) parts.push(`${cascade.giftUpd} campagne omaggio aggiornate`);
  if (cascade.giftOff) parts.push(`${cascade.giftOff} campagne omaggio disattivate`);
  if (cascade.campUpd) parts.push(`${cascade.campUpd} campagne punti aggiornate`);
  if (cascade.campOff) parts.push(`${cascade.campOff} campagne punti disattivate`);
  if (cascade.apptCleared) parts.push(`${cascade.apptCleared} prenotazioni aggiornate`);
  return { ...settings, message: `Livelli Card salvati${parts.length ? `. ${parts.join(", ")}.` : ""}` } as FidelityLevelsSettings & { message: string };
}

// Two campaign periods overlap (null start = -inf, null end = +inf).
function campaignPeriodsOverlap(s1: string, e1: string, s2: string, e2: string): boolean {
  const S1 = s1 || "0000-01-01";
  const E1 = e1 || "9999-12-31";
  const S2 = s2 || "0000-01-01";
  const E2 = e2 || "9999-12-31";
  return S1 <= E2 && S2 <= E1;
}

async function assertNoActiveCampaignOverlap(slug: string, campaignId: number, startsAt: string, endsAt: string): Promise<void> {
  const actives = (await listFidelityCampaigns(slug)).filter((c) => c.active && c.id !== campaignId);
  const clash = actives.find((c) => campaignPeriodsOverlap(startsAt, endsAt, c.startsAt, c.endsAt));
  if (clash) throw new Error(`Periodo sovrapposto a un'altra campagna punti attiva ("${clash.name}"). Modifica le date o disattiva l'altra campagna.`);
}

// Create / update a points campaign (port of save_fidelity_campaign): amount or
// tiers earn mode, level eligibility, min spend, active window; activating needs
// Fidelity on + a non-overlapping active period + valid levels.
export async function saveFidelityCampaign(slug: string, body: Record<string, string>, id: number): Promise<FidelityCampaign> {
  let name = String(body.name ?? body.fid_campaign_name ?? "").trim();
  if (name === "") name = "Campagna punti";
  if (name.length > 120) name = name.slice(0, 120);
  const active = ["1", "true", "on", "yes"].includes(String(body.active ?? body.fid_campaign_active ?? "").toLowerCase());
  if (active && !(await getFidelityEnabled(slug))) throw new Error("Attiva prima Punti Fidelity per attivare le campagne punti.");

  const startsAt = normalizeClientDate(body.starts_at ?? body.fid_campaign_starts_at) ?? "";
  const endsNever = ["1", "true", "on", "yes"].includes(String(body.ends_never ?? body.fid_campaign_ends_never ?? "").toLowerCase());
  const endsAt = endsNever ? "" : (normalizeClientDate(body.ends_at ?? body.fid_campaign_ends_at) ?? "");
  if (startsAt !== "" && endsAt !== "" && endsAt < startsAt) throw new Error("La data di scadenza non puo essere precedente alla data di attivazione.");

  let earnMode = String(body.earn_mode ?? body.fid_campaign_earn_mode ?? "amount").toLowerCase();
  if (earnMode !== "amount" && earnMode !== "tiers") earnMode = "amount";
  const settings = await getFidelityPointsSettings(slug);
  const earnStep = clampNum(Number(String(body.earn_step_euro ?? body.fid_campaign_earn_step_euro ?? "").replace(",", ".")), 0, 100000, settings.earnStepEuro || 10);

  let tiers: FidelityCampaignTier[] = [];
  if (earnMode === "tiers") {
    tiers = parseCampaignTiers(body.tiers_json ?? body.tiers);
    if (tiers.length === 0) throw new Error("Aggiungi almeno uno scaglione punti valido.");
  }

  const levels = parseCampaignLevels(body.eligible_levels ?? body.fid_campaign_level);
  if (levels.length > 0) {
    const available = await fidelityPointLevelKeys(slug);
    for (const k of levels) if (!available.has(k)) throw new Error("Il livello card selezionato non esiste piu. Aggiorna la campagna e scegli un livello valido.");
  }

  let minSpend = roundMoney(Math.max(0, Math.min(100000000, Number(String(body.min_spend ?? body.fid_campaign_min_spend ?? "0").replace(",", ".")) || 0)));
  if (earnMode === "tiers") minSpend = 0;

  if (active) await assertNoActiveCampaignOverlap(slug, id, startsAt, endsAt);

  const values = await filterColumns((await tenantTable(slug, "fidelity_campaigns")).name, {
    name,
    active: active ? 1 : 0,
    starts_at: startsAt || null,
    ends_at: endsAt || null,
    earn_mode: earnMode,
    earn_step_euro: roundMoney(earnStep),
    earn_tiers: earnMode === "tiers" ? JSON.stringify({ tiers }) : null,
    item_rules: JSON.stringify({ rules: [] }),
    eligible_points_levels: JSON.stringify(levels),
    min_spend: minSpend,
    auto_disabled_by_points: 0,
    updated_at: new Date(),
  });

  let campaignId = id;
  if (campaignId > 0) {
    const existing = await tenantSelect<RowDataPacket>({ slug, table: "fidelity_campaigns", columns: "id, deleted_at", where: "id = ?", params: [campaignId], limit: 1 });
    if (!existing[0]) throw new Error("Campagna punti non trovata.");
    if (existing[0].deleted_at) throw new Error("Questa campagna punti e stata rimossa e non puo essere modificata.");
    await tenantUpdate({ slug, table: "fidelity_campaigns", id: campaignId, values });
  } else {
    campaignId = await tenantInsert(await tenantTable(slug, "fidelity_campaigns"), { ...values, created_at: new Date() });
  }
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "fidelity_campaigns", where: "id = ?", params: [campaignId], limit: 1 });
  if (!rows[0]) throw new Error("Campagna non salvata.");
  return mapFidelityCampaign(rows[0]);
}

// Activate/deactivate a campaign (port of toggle_fidelity_campaign): activating
// needs Fidelity on, valid levels, and a non-overlapping active period.
export async function toggleFidelityCampaign(slug: string, id: number, active: boolean): Promise<FidelityCampaign> {
  if (id <= 0) throw new Error("Campagna non valida.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "fidelity_campaigns", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Campagna non trovata.");
  if (rows[0].deleted_at) throw new Error("Questa campagna punti e stata rimossa e non puo essere riattivata.");
  if (active) {
    if (!(await getFidelityEnabled(slug))) throw new Error("Attiva prima Punti Fidelity per riattivare le campagne punti.");
    const camp = mapFidelityCampaign(rows[0]);
    if (camp.eligibleLevels.length > 0) {
      const available = await fidelityPointLevelKeys(slug);
      for (const k of camp.eligibleLevels) if (!available.has(k)) throw new Error("Questa campagna usa un livello card non piu disponibile. Modifica la campagna prima di riattivarla.");
    }
    await assertNoActiveCampaignOverlap(slug, id, camp.startsAt, camp.endsAt);
  }
  await tenantUpdate({ slug, table: "fidelity_campaigns", id, values: { active: active ? 1 : 0, auto_disabled_by_points: 0, updated_at: new Date() } });
  const out = await tenantSelect<RowDataPacket>({ slug, table: "fidelity_campaigns", where: "id = ?", params: [id], limit: 1 });
  return mapFidelityCampaign(out[0]);
}

// Delete a campaign (port of delete_fidelity_campaign): hard-delete when nothing
// references it, else soft-delete (deleted_at + active=0) to preserve history.
export async function deleteFidelityCampaign(slug: string, id: number, by: number): Promise<{ ok: true; mode: "hard" | "soft" }> {
  if (id <= 0) throw new Error("Campagna non valida.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "fidelity_campaigns", columns: "id, deleted_at", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Campagna non trovata.");
  if (rows[0].deleted_at) return { ok: true, mode: "soft" };
  const refs = (await tenantSelect<RowDataPacket>({ slug, table: "appointments", columns: "id", where: "fidelity_campaign_id = ?", params: [id], limit: 1 }).catch(() => [] as RowDataPacket[])).length;
  if (refs === 0) {
    await tenantDelete({ slug, table: "fidelity_campaigns", id });
    return { ok: true, mode: "hard" };
  }
  await tenantUpdate({ slug, table: "fidelity_campaigns", id, values: { active: 0, deleted_at: new Date(), deleted_by: by > 0 ? by : null, updated_at: new Date() } });
  return { ok: true, mode: "soft" };
}

// ---- Fidelity MEMBERSHIP / cards (fidelity_membership.php) ---------------------
export type FidelityCard = {
  id: number;
  code: string;
  clientId: number;
  clientName: string;
  clientEmail: string;
  issuedAt: string;
  expiresAt: string;
  status: string;
  expired: boolean;
};
export type FidelityCardValidity = { enabled: boolean; value: number; unit: string; defaultExpiresAt: string };
export type FidelityMembershipData = {
  fidelityEnabled: boolean;
  cards: FidelityCard[];
  total: number;
  expiredCount: number;
  validity: FidelityCardValidity;
};

// Card validity config from businesses.fidelity_adhesion_json (port of
// fidelity_card_default_validity_config). enabled = card_expiry_enabled (or value>0).
function parseCardValidityConfig(raw: unknown): { enabled: boolean; value: number; unit: string } {
  const s = String(raw ?? "").trim();
  let data: Record<string, unknown> = {};
  if (s !== "") { try { const p = JSON.parse(s); if (p && typeof p === "object" && !Array.isArray(p)) data = p as Record<string, unknown>; } catch { data = {}; } }
  let value = Math.max(0, Math.trunc(Number(data.card_default_validity_value ?? 0) || 0));
  if (value > 36500) value = 36500;
  let unit = String(data.card_default_validity_unit ?? "days").toLowerCase();
  if (!["days", "months", "years"].includes(unit)) unit = "days";
  const enabled = Object.prototype.hasOwnProperty.call(data, "card_expiry_enabled") ? truthyFlag(data.card_expiry_enabled) : value > 0;
  return { enabled, value: enabled ? value : 0, unit };
}

function truthyFlag(v: unknown): boolean {
  return ["1", "true", "on", "yes"].includes(String(v ?? "").toLowerCase());
}

// Add a card duration to a Y-m-d date (port of fidelity_card_add_duration_ymd:
// months/years clamp the day-of-month, days is a plain calendar add).
function addMonthsClampedYmd(baseYmd: string, months: number): string {
  const [y, m, d] = baseYmd.split("-").map((p) => Number.parseInt(p, 10));
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12; // 0-11
  const daysInMonth = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, daysInMonth);
  return `${String(ny).padStart(4, "0")}-${String(nm + 1).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

function addCardDuration(baseYmd: string, value: number, unit: string): string {
  if (unit === "months") return addMonthsClampedYmd(baseYmd, value);
  if (unit === "years") return addMonthsClampedYmd(baseYmd, value * 12);
  const [y, m, d] = baseYmd.split("-").map((p) => Number.parseInt(p, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + value);
  return dt.toISOString().slice(0, 10);
}

// Default card expiry from an issue date (port of fidelity_card_default_expires_at):
// null when expiry is disabled / no validity configured.
function cardDefaultExpiresAt(cfg: { enabled: boolean; value: number; unit: string }, baseYmd: string): string | null {
  if (!cfg.enabled || cfg.value <= 0) return null;
  const base = normalizeClientDate(baseYmd) ?? todayIso();
  return addCardDuration(base, cfg.value, cfg.unit);
}

// Finestra di rinnovo automatico tessera (port of fidelity_card_renewal_window_config):
// attiva solo se la scadenza tessera è configurata (validity > 0), il rinnovo è
// abilitato e la finestra è > 0 (clampata sotto la durata).
function parseCardRenewalWindowConfig(raw: unknown): { enabled: boolean; value: number; unit: string } {
  const s = String(raw ?? "").trim();
  let data: Record<string, unknown> = {};
  if (s !== "") { try { const p = JSON.parse(s); if (p && typeof p === "object" && !Array.isArray(p)) data = p as Record<string, unknown>; } catch { data = {}; } }
  const validity = parseCardValidityConfig(raw);
  const storedEnabled = Object.prototype.hasOwnProperty.call(data, "renewal_enabled")
    ? truthyFlag(data.renewal_enabled)
    : Math.trunc(Number(data.renewal_window_value ?? 0) || 0) > 0;
  let value = Math.max(0, Math.trunc(Number(data.renewal_window_value ?? 0) || 0));
  if (value > 36500) value = 36500;
  let unit = String(data.renewal_window_unit ?? "days").toLowerCase();
  if (!["days", "months", "years"].includes(unit)) unit = "days";
  const enabled = validity.enabled && validity.value > 0 && storedEnabled && value > 0;
  return { enabled, value: enabled ? value : 0, unit };
}

// Rinnovo automatico tessera su attività (port of fidelity_card_try_auto_renew_by_activity,
// Helpers.php ~4975): quando un earn da vendita/appuntamento cade nella finestra di
// rinnovo (tra scadenza-finestra e scadenza), la tessera ATTIVA del cliente viene
// estesa di una durata piena (expires_at + validity). Best-effort: mai bloccante.
export async function fidelityCardTryAutoRenewByActivity(slug: string, clientId: number): Promise<boolean> {
  if (clientId <= 0) return false;
  const bizRows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "fidelity_adhesion_json", orderBy: "id ASC", limit: 1 }).catch(() => [] as RowDataPacket[]);
  const rawCfg = bizRows[0]?.fidelity_adhesion_json;
  const validity = parseCardValidityConfig(rawCfg);
  if (!validity.enabled || validity.value <= 0) return false;
  const renewal = parseCardRenewalWindowConfig(rawCfg);
  if (!renewal.enabled) return false;

  const cardRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "cards",
    columns: "id, expires_at",
    where: "client_id = ? AND status = 'active'",
    params: [clientId],
    orderBy: "CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END ASC, expires_at DESC, id DESC",
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  const card = cardRows[0];
  if (!card) return false;
  const expiresAt = normalizeClientDate(String(card.expires_at ?? "").slice(0, 10));
  if (!expiresAt) return false; // tessera senza scadenza: nulla da rinnovare

  const activityDate = todayIso();
  const windowStart = addCardDuration(expiresAt, -Math.abs(renewal.value), renewal.unit);
  if (activityDate < windowStart) return false; // fuori finestra
  if (activityDate > expiresAt) return false; // già scaduta: serve Riattiva tessera

  const newExpiresAt = addCardDuration(expiresAt, validity.value, validity.unit);
  if (!newExpiresAt || newExpiresAt <= expiresAt) return false;
  await tenantUpdate({ slug, table: "cards", id: Number(card.id), values: { expires_at: newExpiresAt } }).catch(() => 0);
  return true;
}

// Port of fidelity_card_code_normalize: strip whitespace, cut to 20 chars.
function normalizeCardCode(raw: unknown): string {
  return String(raw ?? "").trim().replace(/\s+/g, "").slice(0, 20);
}

// Permanent anti-reuse check (port of fidelity_card_code_ever_used): the code is
// "used" if a live card carries it OR it sits in the tenant's card_code_registry.
async function cardCodeEverUsed(slug: string, normalizedCode: string): Promise<boolean> {
  if (normalizedCode === "") return true;
  const norm = normalizedCode.toUpperCase();
  const inCards = await tenantSelect<RowDataPacket>({ slug, table: "cards", columns: "id", where: "code = ?", params: [normalizedCode], limit: 1 }).catch(() => [] as RowDataPacket[]);
  if (inCards.length > 0) return true;
  const inReg = await tenantSelect<RowDataPacket>({ slug, table: "card_code_registry", columns: "id", where: "normalized_code = ?", params: [norm], limit: 1 }).catch(() => [] as RowDataPacket[]);
  return inReg.length > 0;
}

// Highest numeric code across live cards + the registry (port of fidelity_card_code_max_numeric).
async function cardCodeMaxNumeric(slug: string): Promise<number> {
  const cards = await tenantTable(slug, "cards");
  const reg = await tenantTable(slug, "card_code_registry");
  const tid = cards.tenantId ?? 0;
  let max = 0;
  const r1 = await dbQuery<RowDataPacket[]>(`SELECT COALESCE(MAX(code::bigint),0) m FROM ${quoteIdentifier(cards.name)} WHERE tenant_id = ? AND code ~ '^[0-9]+$'`, [tid]).catch(() => [] as RowDataPacket[]);
  max = Math.max(max, Number(r1[0]?.m ?? 0));
  const r2 = await dbQuery<RowDataPacket[]>(`SELECT COALESCE(MAX(normalized_code::bigint),0) m FROM ${quoteIdentifier(reg.name)} WHERE tenant_id = ? AND normalized_code ~ '^[0-9]+$'`, [tid]).catch(() => [] as RowDataPacket[]);
  max = Math.max(max, Number(r2[0]?.m ?? 0));
  return max;
}

// Reserve/remember a code in the permanent registry so it can never be reused,
// even after the card is deleted (port of the registry reserve/remember helpers).
async function rememberCardCode(slug: string, normalizedCode: string, cardId: number, clientId: number, source: string, note: string): Promise<void> {
  if (normalizedCode === "") return;
  const norm = normalizedCode.toUpperCase();
  const existing = await tenantSelect<RowDataPacket>({ slug, table: "card_code_registry", columns: "id", where: "normalized_code = ?", params: [norm], limit: 1 }).catch(() => [] as RowDataPacket[]);
  if (existing.length > 0) {
    await tenantUpdate({ slug, table: "card_code_registry", id: Number(existing[0].id), values: { last_seen_at: new Date(), card_id: cardId > 0 ? cardId : null, client_id: clientId > 0 ? clientId : null } }).catch(() => 0);
    return;
  }
  await tenantInsert(await tenantTable(slug, "card_code_registry"), {
    code: normalizedCode,
    normalized_code: norm,
    card_id: cardId > 0 ? cardId : null,
    client_id: clientId > 0 ? clientId : null,
    first_seen_at: new Date(),
    last_seen_at: new Date(),
    source,
    note: note || null,
  });
}

// Restore + clear the Fidelity benefits reserved on a single client's pending/
// scheduled appointments (per-client port of fidelity_card_release_pending_
// appointment_discounts_for_clients). Returns the number of appointments touched.
async function releasePendingAppointmentFidelityForClient(slug: string, clientId: number): Promise<number> {
  if (clientId <= 0) return 0;
  const linked = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointments",
    columns: "id, fidelity_points_used, fidelity_gift_points_used",
    where: "client_id = ? AND status IN ('pending','scheduled') AND (COALESCE(fidelity_points_used,0) > 0 OR COALESCE(fidelity_discount,0) > 0 OR COALESCE(fidelity_gift_points_used,0) > 0 OR COALESCE(fidelity_gift_idx,0) > 0 OR COALESCE(fidelity_conflict_choice,'') <> '')",
    params: [clientId],
  }).catch(() => [] as RowDataPacket[]);
  for (const appt of linked) {
    const restore = Math.max(0, Math.round(Number(appt.fidelity_points_used ?? 0))) + Math.max(0, Math.round(Number(appt.fidelity_gift_points_used ?? 0)));
    if (restore > 0) {
      const clients = await tenantTable(slug, "clients");
      await dbExecute(`UPDATE ${quoteIdentifier(clients.name)} SET points = COALESCE(points,0) + ? WHERE id = ? AND tenant_id = ?`, [restore, clientId, clients.tenantId ?? 0]).catch(() => undefined);
    }
    await tenantUpdate({ slug, table: "appointments", id: Number(appt.id), values: { fidelity_points_used: 0, fidelity_discount: 0, fidelity_gift_points_used: 0, fidelity_gift_idx: null, fidelity_conflict_choice: "", fidelity_campaign_id: null } }).catch(() => 0);
  }
  return linked.length;
}

// List the Fidelity cards + validity config (port of the fidelity_membership.php list).
export async function getFidelityMembership(slug: string, q: string): Promise<FidelityMembershipData> {
  const fidelityEnabled = await getFidelityEnabled(slug);
  const bizRows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "fidelity_adhesion_json", orderBy: "id ASC", limit: 1 });
  const cfg = parseCardValidityConfig(bizRows[0]?.fidelity_adhesion_json);
  const today = todayIso();

  const cardRows = await tenantSelect<RowDataPacket>({ slug, table: "cards", columns: "id, code, client_id, issued_at, expires_at, status", orderBy: "id DESC", limit: 500 }).catch(() => [] as RowDataPacket[]);
  const clientIds = [...new Set(cardRows.map((r) => Number(r.client_id ?? 0)).filter((n) => n > 0))];
  const clientMap = new Map<number, { name: string; email: string }>();
  if (clientIds.length > 0) {
    const placeholders = clientIds.map(() => "?").join(",");
    const clientRows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "id, full_name, email", where: `id IN (${placeholders})`, params: clientIds }).catch(() => [] as RowDataPacket[]);
    for (const c of clientRows) clientMap.set(Number(c.id), { name: String(c.full_name ?? ""), email: String(c.email ?? "") });
  }

  const term = q.trim().toLowerCase();
  let cards: FidelityCard[] = cardRows.map((r) => {
    const clientId = Number(r.client_id ?? 0);
    const client = clientMap.get(clientId) ?? { name: "", email: "" };
    const expiresAt = normalizeClientDate(typeof r.expires_at === "string" ? r.expires_at : r.expires_at ? dateIsoLocal(new Date(String(r.expires_at))) : "") ?? "";
    const issuedAt = normalizeClientDate(typeof r.issued_at === "string" ? r.issued_at : r.issued_at ? dateIsoLocal(new Date(String(r.issued_at))) : "") ?? "";
    return {
      id: Number(r.id ?? 0),
      code: String(r.code ?? ""),
      clientId,
      clientName: client.name,
      clientEmail: client.email,
      issuedAt,
      expiresAt,
      status: String(r.status ?? "active"),
      expired: expiresAt !== "" && expiresAt < today,
    };
  });
  if (term !== "") {
    cards = cards.filter((c) => c.code.toLowerCase().includes(term) || c.clientName.toLowerCase().includes(term) || c.clientEmail.toLowerCase().includes(term));
  }

  return {
    fidelityEnabled,
    cards,
    total: cards.length,
    expiredCount: cards.filter((c) => c.expired).length,
    validity: { enabled: cfg.enabled, value: cfg.value, unit: cfg.unit, defaultExpiresAt: cardDefaultExpiresAt(cfg, today) ?? "" },
  };
}

// Issue a card (port of fidelity_membership.php create_card).
export async function issueFidelityCard(slug: string, body: Record<string, string>): Promise<{ ok: true; code: string; cardId: number }> {
  if (!(await getFidelityEnabled(slug))) throw new Error("Attiva prima la Fidelity per gestire le tessere.");
  const clientId = Math.trunc(Number(String(body.client_id ?? "").trim())) || 0;
  if (clientId <= 0) throw new Error("Seleziona un cliente.");

  const clientRows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "id, credit_balance", where: "id = ?", params: [clientId], limit: 1 });
  if (!clientRows[0]) throw new Error("Cliente non trovato.");

  const already = await tenantSelect<RowDataPacket>({ slug, table: "cards", columns: "id", where: "client_id = ?", params: [clientId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  if (already.length > 0) throw new Error("Questo cliente ha già una tessera.");

  const rawCode = String(body.code ?? "");
  let code = normalizeCardCode(rawCode);
  if (rawCode.trim() !== "" && code === "") throw new Error("Codice tessera non valido.");
  if (code !== "" && (await cardCodeEverUsed(slug, code))) {
    throw new Error("Codice tessera gia utilizzato in passato. Anche se la tessera e stata eliminata, il codice non puo essere riutilizzato.");
  }

  const cfg = parseCardValidityConfig((await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "fidelity_adhesion_json", orderBy: "id ASC", limit: 1 }))[0]?.fidelity_adhesion_json);
  const today = todayIso();
  const issuedAt = normalizeClientDate(body.issued_at) ?? today;
  const expiresAt = cardDefaultExpiresAt(cfg, issuedAt);

  let status = String(body.status ?? "active").trim().toLowerCase();
  if (!["active", "inactive"].includes(status)) status = "active";
  if (status === "active" && expiresAt !== null && expiresAt < today) {
    const [y, m, d] = expiresAt.split("-");
    throw new Error(`Con la Data emissione selezionata la tessera risulta già scaduta (${d}/${m}/${y}). Scegli una data più recente oppure crea la tessera come Disattiva.`);
  }

  // Generate a numeric progressive code when left blank.
  if (code === "") {
    let next = Math.max(0, await cardCodeMaxNumeric(slug)) + 1;
    let tries = 0;
    for (;;) {
      code = String(next).padStart(6, "0");
      if (!(await cardCodeEverUsed(slug, code))) break;
      next += 1;
      tries += 1;
      if (tries >= 10000) throw new Error("Impossibile generare un codice tessera univoco. Inserisci un codice manuale mai usato.");
    }
  }

  const credit = roundMoney(Number(clientRows[0].credit_balance ?? 0) || 0);
  // Reserve the code in the permanent registry BEFORE creating the card, then attach.
  await rememberCardCode(slug, code, 0, clientId, "card_create", "");
  const cardId = await tenantInsert(await tenantTable(slug, "cards"), {
    code,
    client_id: clientId,
    issued_at: issuedAt,
    expires_at: expiresAt,
    status,
    credit: credit > 0 ? credit : 0,
  });
  await rememberCardCode(slug, code, cardId, clientId, "card_create", "");
  // F4: la nuova tessera rende il cliente aderente -> ricalcolo livello.
  await recalcClientFidelityLevel(slug, clientId).catch(() => "");

  return { ok: true, code, cardId };
}

// Update a card's status (port of fidelity_membership.php update_card).
export async function updateFidelityCardStatus(slug: string, cardId: number, statusRaw: string): Promise<{ ok: true; status: string; releasedAppointments: number }> {
  if (cardId <= 0) throw new Error("Tessera non valida.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "cards", columns: "id, client_id, expires_at, status", where: "id = ?", params: [cardId], limit: 1 });
  if (!rows[0]) throw new Error("Tessera non trovata.");

  const today = todayIso();
  const currentExpires = normalizeClientDate(typeof rows[0].expires_at === "string" ? rows[0].expires_at : rows[0].expires_at ? dateIsoLocal(new Date(String(rows[0].expires_at))) : "");
  let status = String(statusRaw ?? "active").trim().toLowerCase();
  if (!["active", "inactive"].includes(status)) status = "active";
  if (status === "active" && currentExpires !== null && currentExpires < today) {
    throw new Error("La tessera è scaduta: usa il pulsante Riattiva tessera per ricalcolare la nuova scadenza.");
  }

  const clientId = Number(rows[0].client_id ?? 0);
  await tenantUpdate({ slug, table: "cards", id: cardId, values: { status } });
  let releasedAppointments = 0;
  if (status === "inactive" && clientId > 0) {
    releasedAppointments = await releasePendingAppointmentFidelityForClient(slug, clientId);
  }
  // F4: lo stato tessera cambia l'adesione -> ricalcolo livello.
  if (clientId > 0) await recalcClientFidelityLevel(slug, clientId).catch(() => "");
  return { ok: true, status, releasedAppointments };
}

// Reactivate an expired card, recomputing the expiry from today (port of reactivate_card).
export async function reactivateFidelityCard(slug: string, cardId: number): Promise<{ ok: true; expiresAt: string }> {
  if (cardId <= 0) throw new Error("Tessera non valida.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "cards", columns: "id, expires_at, status", where: "id = ?", params: [cardId], limit: 1 });
  if (!rows[0]) throw new Error("Tessera non trovata.");
  const today = todayIso();
  const currentExpires = normalizeClientDate(typeof rows[0].expires_at === "string" ? rows[0].expires_at : rows[0].expires_at ? dateIsoLocal(new Date(String(rows[0].expires_at))) : "");
  if (currentExpires === null || currentExpires >= today) throw new Error("La tessera non è scaduta.");

  const cfg = parseCardValidityConfig((await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "fidelity_adhesion_json", orderBy: "id ASC", limit: 1 }))[0]?.fidelity_adhesion_json);
  const newExpires = cardDefaultExpiresAt(cfg, today);
  if (newExpires === null) throw new Error("Imposta prima una durata tessera in Fidelity → Adesione → Impostazioni tessera Fidelity per poter riattivare la tessera.");

  await tenantUpdate({ slug, table: "cards", id: cardId, values: { expires_at: newExpires, status: "active" } });
  // F4: la riattivazione ripristina l'adesione -> ricalcolo livello.
  const reactClientId = Number((await tenantSelect<RowDataPacket>({ slug, table: "cards", columns: "client_id", where: "id = ?", params: [cardId], limit: 1 }).catch(() => []))[0]?.client_id ?? 0);
  if (reactClientId > 0) await recalcClientFidelityLevel(slug, reactClientId).catch(() => "");
  return { ok: true, expiresAt: newExpires };
}

// Delete a card + reset the client's Fidelity state (port of delete_card): keep the
// code permanently reserved, release pending-appointment Fidelity benefits, remove
// fidelity-only accumulating gifts, wipe points/lots/transactions + fidelity_level.
export async function deleteFidelityCard(slug: string, cardId: number): Promise<{ ok: true; removedGifts: number; releasedAppointments: number }> {
  if (cardId <= 0) throw new Error("Tessera non valida.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "cards", columns: "id, client_id, code", where: "id = ?", params: [cardId], limit: 1 });
  if (!rows[0]) throw new Error("Tessera non trovata.");
  const clientId = Number(rows[0].client_id ?? 0);
  const code = normalizeCardCode(rows[0].code);

  let removedGifts = 0;
  let releasedAppointments = 0;
  if (code !== "") await rememberCardCode(slug, code, cardId, clientId, "card_delete", "Codice tessera eliminata: non riutilizzabile");

  if (clientId > 0) {
    releasedAppointments = await releasePendingAppointmentFidelityForClient(slug, clientId);

    // Remove fidelity-only gifts still in accumulation for this client.
    const giftInstances = await dbQuery<RowDataPacket[]>(
      `SELECT gi.id FROM ${quoteIdentifier((await tenantTable(slug, "gift_instances")).name)} gi JOIN ${quoteIdentifier((await tenantTable(slug, "gifts")).name)} g ON g.id = gi.gift_id AND g.tenant_id = gi.tenant_id WHERE gi.tenant_id = ? AND gi.client_id = ? AND LOWER(TRIM(COALESCE(gi.state,'accumulo'))) = 'accumulo' AND LOWER(TRIM(COALESCE(g.eligibility,'fidelity_only'))) = 'fidelity_only'`,
      [(await tenantTable(slug, "gift_instances")).tenantId ?? 0, clientId],
    ).catch(() => [] as RowDataPacket[]);
    for (const gi of giftInstances) {
      await tenantDelete({ slug, table: "gift_instances", id: Number(gi.id) }).catch(() => 0);
      removedGifts += 1;
    }

    const clients = await tenantTable(slug, "clients");
    const tx = await tenantTable(slug, "transactions");
    const lots = await tenantTable(slug, "point_lots");
    await dbExecute(`DELETE FROM ${quoteIdentifier(tx.name)} WHERE tenant_id = ? AND client_id = ?`, [tx.tenantId ?? 0, clientId]).catch(() => undefined);
    await dbExecute(`DELETE FROM ${quoteIdentifier(lots.name)} WHERE tenant_id = ? AND client_id = ?`, [lots.tenantId ?? 0, clientId]).catch(() => undefined);
    await dbExecute(`UPDATE ${quoteIdentifier(clients.name)} SET points = 0, fidelity_level = '' WHERE tenant_id = ? AND id = ?`, [clients.tenantId ?? 0, clientId]).catch(async () => {
      await dbExecute(`UPDATE ${quoteIdentifier(clients.name)} SET points = 0 WHERE tenant_id = ? AND id = ?`, [clients.tenantId ?? 0, clientId]).catch(() => undefined);
    });
  }

  await tenantDelete({ slug, table: "cards", id: cardId });

  return { ok: true, removedGifts, releasedAppointments };
}

// ---- Fidelity WALLET / points ledger (fidelity_wallet.php) --------------------
export type FidelityWalletMovement = { id: number; kind: string; deltaPoints: number; note: string; sourceType: string; createdAt: string };
export type FidelityWalletPending = { id: number; publicCode: string; startsAt: string; status: string; discountPoints: number; giftPoints: number };
export type FidelityWalletDetail = {
  clientId: number;
  clientName: string;
  clientEmail: string;
  adhering: boolean;
  pointsBalance: number;
  reserved: number;
  available: number;
  movements: FidelityWalletMovement[];
  pending: FidelityWalletPending[];
  // F1 — scadenze punti (point_lots): punti in scadenza entro expire_warn_days,
  // calendario lotti residui, avvisi lock-lots e disponibile negativo.
  expireEnabled: boolean;
  expireWarnDays: number;
  expiringSoon: number;
  lockedPoints: number;
  availableNegative: boolean;
  schedule: PointLotScheduleRow[];
};
export type FidelityWalletClient = { id: number; name: string; email: string; points: number };
export type FidelityWalletData = {
  fidelityEnabled: boolean;
  pointsEnabled: boolean;
  clients: FidelityWalletClient[];
  detail: FidelityWalletDetail | null;
};

// Fidelity points are always integers (port of Fidelity::normalizePoints).
function normalizeFidelityPoints(n: unknown): number {
  const v = Number(String(n ?? "").toString().replace(",", "."));
  return Number.isFinite(v) ? Math.round(v) : 0;
}

// A client "adheres" to Fidelity when they hold an active, non-expired card
// (port of Fidelity::isClientAdhering — cards.status='active' + expires_at NULL/>=today).
export async function fidelityIsClientAdhering(slug: string, clientId: number): Promise<boolean> {
  if (clientId <= 0) return false;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "cards", columns: "id", where: "client_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at >= ?)", params: [clientId, todayIso()], limit: 1 }).catch(() => [] as RowDataPacket[]);
  return rows.length > 0;
}

// Points reserved on a client's still-open appointments (port of Fidelity::reservedPoints:
// SUM(fidelity_points_used + fidelity_gift_points_used) over pending/scheduled appts).
async function fidelityReservedPoints(slug: string, clientId: number): Promise<number> {
  if (clientId <= 0) return 0;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointments",
    columns: "COALESCE(SUM(COALESCE(fidelity_points_used,0) + COALESCE(fidelity_gift_points_used,0)),0) AS s",
    where: "client_id = ? AND status IN ('pending','scheduled')",
    params: [clientId],
  }).catch(() => [] as RowDataPacket[]);
  return Math.max(0, normalizeFidelityPoints(rows[0]?.s ?? 0));
}

async function getFidelityWalletDetail(slug: string, clientId: number): Promise<FidelityWalletDetail | null> {
  // Expire-on-read (port of Fidelity::availablePoints ~2154): con scadenza attiva
  // i lotti scaduti vengono processati prima di leggere il saldo.
  const lotsSettings = await fidelityLotsSettings(slug).catch(() => ({ expireEnabled: false, expireDays: 0, expireWarnDays: 30 }));
  if (lotsSettings.expireEnabled) await expireClientLots(slug, clientId).catch(() => 0);

  const clientRows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "id, full_name, email, points", where: "id = ?", params: [clientId], limit: 1 });
  if (!clientRows[0]) return null;
  const pointsBalance = normalizeFidelityPoints(clientRows[0].points ?? 0);
  const reservedRaw = await fidelityReservedPoints(slug, clientId);
  const reserved = Math.min(reservedRaw, Math.max(0, pointsBalance));
  const available = normalizeFidelityPoints(pointsBalance - reserved);

  const txRows = await tenantSelect<RowDataPacket>({ slug, table: "transactions", columns: "id, kind, source_type, delta_points, note, created_at", where: "client_id = ?", params: [clientId], orderBy: "id DESC", limit: 100 }).catch(() => [] as RowDataPacket[]);
  const movements: FidelityWalletMovement[] = txRows.map((r) => ({
    id: Number(r.id ?? 0),
    kind: String(r.kind ?? "manual"),
    deltaPoints: normalizeFidelityPoints(r.delta_points ?? 0),
    note: String(r.note ?? ""),
    sourceType: String(r.source_type ?? ""),
    createdAt: toIso(r.created_at),
  }));

  const pendRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointments",
    columns: "id, public_code, starts_at, status, COALESCE(fidelity_points_used,0) AS discount_points, COALESCE(fidelity_gift_points_used,0) AS gift_points",
    where: "client_id = ? AND status IN ('pending','scheduled') AND (COALESCE(fidelity_points_used,0) > 0 OR COALESCE(fidelity_gift_points_used,0) > 0)",
    params: [clientId],
    orderBy: "starts_at ASC, id ASC",
    limit: 200,
  }).catch(() => [] as RowDataPacket[]);
  const pending: FidelityWalletPending[] = pendRows.map((r) => ({
    id: Number(r.id ?? 0),
    publicCode: String(r.public_code ?? ""),
    startsAt: r.starts_at ? toIso(r.starts_at) : "",
    status: String(r.status ?? ""),
    discountPoints: normalizeFidelityPoints(r.discount_points ?? 0),
    giftPoints: normalizeFidelityPoints(r.gift_points ?? 0),
  }));

  // F1 — dettaglio scadenze dal calendario lotti.
  const schedule = await pointLotsSchedule(slug, clientId).catch(() => [] as PointLotScheduleRow[]);
  const lockedPoints = schedule.filter((l) => l.isLock).reduce((s, l) => s + l.remaining, 0);
  const expiringSoon = lotsSettings.expireEnabled ? await expiringSoonPoints(slug, clientId).catch(() => 0) : 0;

  return {
    clientId,
    clientName: String(clientRows[0].full_name ?? ""),
    clientEmail: String(clientRows[0].email ?? ""),
    adhering: await fidelityIsClientAdhering(slug, clientId),
    pointsBalance,
    reserved,
    available,
    movements,
    pending,
    expireEnabled: lotsSettings.expireEnabled,
    expireWarnDays: lotsSettings.expireWarnDays,
    expiringSoon,
    lockedPoints,
    availableNegative: pointsBalance - reservedRaw < 0,
    schedule,
  };
}

// List the Fidelity points wallet (port of fidelity_wallet.php): the client list is
// scoped to CARD HOLDERS (clients with a tessera, active or not), plus the optional
// per-client detail (balance / reserved / available / movements / pending appts).
// NB: the legacy point_lots expiry schedule is omitted — the Next never writes lots.
export async function getFidelityWallet(slug: string, clientId: number): Promise<FidelityWalletData> {
  const settings = await getFidelityPointsSettings(slug);
  const cardRows = await tenantSelect<RowDataPacket>({ slug, table: "cards", columns: "DISTINCT client_id", where: "client_id > 0" }).catch(() => [] as RowDataPacket[]);
  const clientIds = [...new Set(cardRows.map((r) => Number(r.client_id ?? 0)).filter((n) => n > 0))];
  let clients: FidelityWalletClient[] = [];
  if (clientIds.length > 0) {
    const placeholders = clientIds.map(() => "?").join(",");
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "id, full_name, email, points", where: `id IN (${placeholders})`, params: clientIds, orderBy: "full_name ASC" }).catch(() => [] as RowDataPacket[]);
    clients = rows.map((r) => ({ id: Number(r.id ?? 0), name: String(r.full_name ?? ""), email: String(r.email ?? ""), points: normalizeFidelityPoints(r.points ?? 0) }));
  }

  return {
    fidelityEnabled: settings.globalEnabled,
    pointsEnabled: settings.pointsEnabled,
    clients,
    detail: clientId > 0 ? await getFidelityWalletDetail(slug, clientId) : null,
  };
}

// Manual points movement (port of fidelity_wallet.php manual_move_points): integer
// points, adhesion-gated, and on REMOVE it protects points already reserved on
// pending/scheduled appointments (removes only the free balance; reports the locked
// reserved + missing remainder). kind 'manual' for add, 'adjust' for remove.
export async function fidelityWalletManualMove(
  slug: string,
  clientId: number,
  opRaw: string,
  pointsRaw: unknown,
  note: string,
  by: number,
): Promise<{ ok: true; message: string; removed: number; lockedReserved: number; missing: number; detail: FidelityWalletDetail | null }> {
  const settings = await getFidelityPointsSettings(slug);
  if (!settings.globalEnabled) throw new Error('Fidelity è disattivata. Attiva la funzione in "Impostazione generale" per utilizzare il Portafoglio.');
  if (!settings.pointsEnabled) throw new Error('Punti Fidelity sono disattivati. Attiva "Abilita Punti Fidelity" per utilizzare il Portafoglio punti.');

  let op = String(opRaw ?? "add").trim().toLowerCase();
  if (!["add", "remove"].includes(op)) op = "add";

  let pts = normalizeFidelityPoints(pointsRaw);
  if (pts < 1) throw new Error("Inserisci un numero intero di punti valido.");
  if (pts > 100000000) pts = 100000000;

  const cleanNote = String(note ?? "").trim().slice(0, 255);
  if (clientId <= 0) throw new Error("Seleziona un cliente.");
  if (!(await fidelityIsClientAdhering(slug, clientId))) throw new Error("Cliente non aderisce alla Fidelity (tessera non attiva/scaduta).");

  const clientRows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "id, points", where: "id = ?", params: [clientId], limit: 1 });
  if (!clientRows[0]) throw new Error("Cliente non trovato.");
  const curPts = normalizeFidelityPoints(clientRows[0].points ?? 0);

  let lockedReserved = 0;
  let missing = 0;
  const reqPts = pts;
  if (op === "remove") {
    let reserved = await fidelityReservedPoints(slug, clientId);
    if (reserved < 0) reserved = 0;
    const maxReservable = Math.max(0, curPts);
    if (reserved > maxReservable) reserved = maxReservable;

    const free = Math.max(0, normalizeFidelityPoints(curPts - reserved));
    const removable = Math.max(0, normalizeFidelityPoints(Math.min(reqPts, free)));
    const remainder = Math.max(0, normalizeFidelityPoints(reqPts - removable));
    lockedReserved = Math.max(0, normalizeFidelityPoints(Math.min(reserved, remainder)));
    missing = Math.max(0, normalizeFidelityPoints(remainder - lockedReserved));
    pts = removable;

    if (pts <= 0) {
      if (curPts <= 0) throw new Error(`Impossibile rimuovere ${reqPts} Punti: saldo insufficiente (disponibili 0).`);
      if (free <= 0 && reserved > 0) throw new Error(`Impossibile rimuovere ${reqPts} Punti: i punti disponibili sono già prenotati su appuntamenti in sospeso/prenotati.`);
      throw new Error(`Impossibile rimuovere ${reqPts} Punti: saldo insufficiente (disponibili ${free}).`);
    }
  }

  const delta = op === "remove" ? -pts : pts;
  const nextPoints = normalizeFidelityPoints(curPts + delta);
  if (delta < 0 && nextPoints < 0) throw new Error("Operazione non riuscita (punti insufficienti).");

  const manualKind = delta < 0 ? "adjust" : "manual";
  // POINT_LOTS (F1): init dei lotti sul saldo PRE-movimento, poi il movimento
  // crea/consuma lotti come ogni transazione punti (Fidelity::addTransaction).
  await ensureLotsInitialized(slug, clientId).catch(() => undefined);
  const manualTxId = await tenantInsert(await tenantTable(slug, "transactions"), {
    client_id: clientId,
    kind: manualKind,
    source_type: "manual",
    delta_points: delta,
    note: cleanNote === "" ? null : cleanNote,
    created_by: by > 0 ? by : null,
    created_at: new Date(),
  });
  await tenantUpdate({ slug, table: "clients", id: clientId, values: { points: nextPoints } });
  await applyLotsDelta(slug, { clientId, transactionId: manualTxId, kind: manualKind, sourceType: "manual", delta }).catch(() => undefined);
  await reconcilePointLots(slug, clientId).catch(() => false);

  let message = delta > 0 ? `Aggiunti ${pts} Punti` : `Rimossi ${pts} Punti`;
  if (op === "remove") {
    const parts: string[] = [];
    if (lockedReserved > 0) parts.push(`${lockedReserved} Punti non rimossi perché prenotati su appuntamenti in sospeso/prenotati.`);
    if (missing > 0) parts.push(`${missing} Punti non rimossi per saldo insufficiente.`);
    if (parts.length > 0) message += `. ${parts.join(" ")}`;
  }

  return { ok: true, message, removed: op === "remove" ? pts : 0, lockedReserved, missing, detail: await getFidelityWalletDetail(slug, clientId) };
}

// ---- Credit MOVEMENTS ledger (credit_movements.php "Movimenti Credito") -------
export type CreditMovement = {
  createdAt: string;
  clientId: number;
  clientName: string;
  kind: "recharge" | "void" | "redeem" | "manual_debit" | "manual_credit";
  sourceType: string;
  sourceId: number;
  locationName: string;
  rechargeAmount: number | null;
  bonusAmount: number | null;
  totalAmount: number; // signed euro delta
  note: string;
};
export type CreditPending = { id: number; publicCode: string; clientId: number; clientName: string; startsAt: string; status: string; creditUsed: number };
export type CreditMovementsData = {
  clients: { id: number; name: string; email: string; credit: number }[];
  movements: CreditMovement[];
  pending: CreditPending[];
  total: number;
  // Paginazione server 20/pagina (legacy $crPerPage=20, credit_movements.php:44).
  page: number;
  perPage: number;
  totalPages: number;
};

// Full credit ledger (port of credit_movements.php's UNION): recharges (+ their
// storno), appointment + sale credit usage, and manual credit_adjustments — merged,
// newest first, paginato 20/pagina come il legacy. Plus the pending-credit list
// (open appointments holding credit).
export async function getManageCreditMovements(slug: string, clientId: number, pageRaw = 1): Promise<CreditMovementsData> {
  const scoped = clientId > 0;
  const cw = (col: string): { where: string; params: unknown[] } => (scoped ? { where: `${col} = ?`, params: [clientId] } : { where: "", params: [] });

  const clientRows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "id, full_name, email, credit_balance", orderBy: "full_name ASC" }).catch(() => [] as RowDataPacket[]);
  const clientMap = new Map<number, string>();
  for (const c of clientRows) clientMap.set(Number(c.id), String(c.full_name ?? ""));
  const clients = clientRows.map((c) => ({ id: Number(c.id), name: String(c.full_name ?? ""), email: String(c.email ?? ""), credit: roundMoney(Number(c.credit_balance ?? 0)) }));

  // Location id -> name (for appointment/sale rows; recharges/adjustments carry their own name).
  const locRows = await tenantSelect<RowDataPacket>({ slug, table: "locations", columns: "id, name" }).catch(() => [] as RowDataPacket[]);
  const locMap = new Map<number, string>();
  for (const l of locRows) locMap.set(Number(l.id), String(l.name ?? ""));
  const nameOf = (id: number) => (id > 0 ? locMap.get(id) ?? "" : "");

  const movements: CreditMovement[] = [];

  // Recharges (+ storno rows for voided recharges).
  const rc = cw("client_id");
  const rechRows = await tenantSelect<RowDataPacket>({ slug, table: "recharges", columns: "id, client_id, base_amount, bonus_amount, total_amount, note, is_void, voided_at, created_at, location_id, location_name", where: rc.where, params: rc.params }).catch(() => [] as RowDataPacket[]);
  for (const r of rechRows) {
    const id = Number(r.id ?? 0);
    const voided = Number(r.is_void ?? 0) === 1;
    const locName = String(r.location_name ?? "") || nameOf(Number(r.location_id ?? 0));
    movements.push({
      createdAt: toIso(r.created_at),
      clientId: Number(r.client_id ?? 0),
      clientName: clientMap.get(Number(r.client_id ?? 0)) ?? "",
      kind: "recharge",
      sourceType: "credit_recharge",
      sourceId: id,
      locationName: locName,
      rechargeAmount: roundMoney(Number(r.base_amount ?? 0)),
      bonusAmount: roundMoney(Number(r.bonus_amount ?? 0)),
      totalAmount: roundMoney(Number(r.total_amount ?? 0)),
      note: `${String(r.note ?? "") || `Ricarica credito #${id}`}${voided ? " (stornata)" : ""}`,
    });
    if (voided) {
      movements.push({
        createdAt: toIso(r.voided_at ?? r.created_at),
        clientId: Number(r.client_id ?? 0),
        clientName: clientMap.get(Number(r.client_id ?? 0)) ?? "",
        kind: "void",
        sourceType: "credit_recharge",
        sourceId: id,
        locationName: locName,
        rechargeAmount: -roundMoney(Number(r.base_amount ?? 0)),
        bonusAmount: -roundMoney(Number(r.bonus_amount ?? 0)),
        totalAmount: -roundMoney(Number(r.total_amount ?? 0)),
        note: `Storno ricarica credito #${id}`,
      });
    }
  }

  // Appointment credit usage.
  const ac = cw("client_id");
  const apptRows = await tenantSelect<RowDataPacket>({ slug, table: "appointments", columns: "id, public_code, client_id, credit_used, status, created_at, location_id", where: `COALESCE(credit_used,0) > 0${ac.where ? ` AND ${ac.where}` : ""}`, params: ac.params }).catch(() => [] as RowDataPacket[]);
  for (const a of apptRows) {
    const open = ["pending", "scheduled"].includes(String(a.status ?? ""));
    const code = String(a.public_code ?? "") || `#${a.id}`;
    movements.push({
      createdAt: toIso(a.created_at),
      clientId: Number(a.client_id ?? 0),
      clientName: clientMap.get(Number(a.client_id ?? 0)) ?? "",
      kind: "redeem",
      sourceType: "appointment",
      sourceId: Number(a.id ?? 0),
      locationName: nameOf(Number(a.location_id ?? 0)),
      rechargeAmount: null,
      bonusAmount: null,
      totalAmount: -roundMoney(Number(a.credit_used ?? 0)),
      note: `Credito usato su prenotazione ${code}${open ? " (in sospeso)" : ""}`,
    });
  }

  // Sale credit usage (excluding cancelled sales).
  const sc = cw("client_id");
  const saleRows = await tenantSelect<RowDataPacket>({ slug, table: "sales", columns: "id, client_id, credit_used, sale_date, status, location_id", where: `COALESCE(credit_used,0) > 0 AND (status IS NULL OR LOWER(status) NOT IN ('cancelled','canceled','annullata','annullato'))${sc.where ? ` AND ${sc.where}` : ""}`, params: sc.params }).catch(() => [] as RowDataPacket[]);
  for (const s of saleRows) {
    movements.push({
      createdAt: toIso(s.sale_date ?? s.created_at),
      clientId: Number(s.client_id ?? 0),
      clientName: clientMap.get(Number(s.client_id ?? 0)) ?? "",
      kind: "redeem",
      sourceType: "sale",
      sourceId: Number(s.id ?? 0),
      locationName: nameOf(Number(s.location_id ?? 0)),
      rechargeAmount: null,
      bonusAmount: null,
      totalAmount: -roundMoney(Number(s.credit_used ?? 0)),
      note: `Credito usato in vendita #${s.id}`,
    });
  }

  // Manual credit adjustments.
  const dc = cw("client_id");
  const adjRows = await tenantSelect<RowDataPacket>({ slug, table: "credit_adjustments", columns: "id, client_id, delta_amount, note, created_at, location_id, location_name", where: dc.where, params: dc.params }).catch(() => [] as RowDataPacket[]);
  for (const d of adjRows) {
    const delta = roundMoney(Number(d.delta_amount ?? 0));
    movements.push({
      createdAt: toIso(d.created_at),
      clientId: Number(d.client_id ?? 0),
      clientName: clientMap.get(Number(d.client_id ?? 0)) ?? "",
      kind: delta < 0 ? "manual_debit" : "manual_credit",
      sourceType: "credit_adjustment",
      sourceId: Number(d.id ?? 0),
      locationName: String(d.location_name ?? "") || nameOf(Number(d.location_id ?? 0)),
      rechargeAmount: null,
      bonusAmount: null,
      totalAmount: delta,
      note: String(d.note ?? "") || `Rettifica credito #${d.id}`,
    });
  }

  movements.sort((a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    if (tb !== ta) return tb - ta;
    return b.sourceId - a.sourceId;
  });
  const total = movements.length;
  const perPage = 20;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(1, Math.trunc(Number(pageRaw) || 1)), totalPages);
  const capped = movements.slice((page - 1) * perPage, page * perPage);

  // Pending credit: open appointments still holding credit.
  const pc = cw("client_id");
  const pendRows = await tenantSelect<RowDataPacket>({ slug, table: "appointments", columns: "id, public_code, client_id, starts_at, status, credit_used, location_id", where: `status IN ('pending','scheduled') AND COALESCE(credit_used,0) > 0${pc.where ? ` AND ${pc.where}` : ""}`, params: pc.params, orderBy: "starts_at ASC, id ASC", limit: 200 }).catch(() => [] as RowDataPacket[]);
  const pending: CreditPending[] = pendRows.map((a) => ({
    id: Number(a.id ?? 0),
    publicCode: String(a.public_code ?? "") || `#${a.id}`,
    clientId: Number(a.client_id ?? 0),
    clientName: clientMap.get(Number(a.client_id ?? 0)) ?? "",
    startsAt: a.starts_at ? toIso(a.starts_at) : "",
    status: String(a.status ?? ""),
    creditUsed: roundMoney(Number(a.credit_used ?? 0)),
  }));

  return { clients, movements: capped, pending, total, page, perPage, totalPages };
}

// La tessera ATTIVA del cliente per il tracciamento card_id/card_code sulle
// rettifiche credito (port of credit_wallet_active_card, Helpers.php ~9917):
// status='active', non scaduta, la più recente.
async function creditWalletActiveCard(slug: string, clientId: number): Promise<{ id: number; code: string } | null> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "cards",
    columns: "id, code",
    where: "client_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)",
    params: [clientId],
    orderBy: "id DESC",
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  if (!rows[0]) return null;
  return { id: Number(rows[0].id ?? 0), code: String(rows[0].code ?? "") };
}

// Manually scale (debit) a client's credit wallet (port of credit_movements.php
// manual_credit_debit): blocked-client + note-required + sufficient-balance +
// SEDE-obbligatoria guards (messaggi legacy con fmt_money), writes a
// credit_adjustments debit row (card_id/card_code della tessera attiva +
// location_id/location_name) and decrements clients.credit_balance.
export async function manualCreditDebit(
  slug: string,
  clientId: number,
  amountRaw: unknown,
  noteRaw: string,
  by: number,
  location: { id: number; name: string },
): Promise<{ ok: true; message: string; movements: CreditMovementsData }> {
  if (clientId <= 0) throw new Error("Seleziona un cliente.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "id, full_name, credit_balance, is_blocked", where: "id = ?", params: [clientId], limit: 1 });
  if (!rows[0]) throw new Error("Cliente non trovato.");
  if (Number(rows[0].is_blocked ?? 0) === 1) {
    // client_block_operational_message() legacy.
    throw new Error("Questo cliente è disattivato e non può essere utilizzato in Pagamenti o Quick Booking finché non viene riattivato.");
  }

  const amount = roundMoney(Number(String(amountRaw ?? "").replace(",", ".")));
  if (!Number.isFinite(amount) || amount <= 0.00001) throw new Error("Inserisci un importo valido.");
  if (amount > 99999999.99) throw new Error(`Importo troppo alto. Massimo ${formatMoneyIt(99999999.99)}.`);

  const note = String(noteRaw ?? "").trim().slice(0, 255);
  if (note === "") throw new Error("Inserisci una nota per motivare lo scalo manuale.");

  // Sede obbligatoria (credit_movements.php ~160-161).
  if (!location || location.id <= 0) {
    throw new Error("Seleziona una sede dalla barra superiore prima di scalare il credito.");
  }

  const balanceBefore = roundMoney(Number(rows[0].credit_balance ?? 0));
  if (balanceBefore + 0.00001 < amount) throw new Error(`Credito insufficiente. Saldo attuale € ${formatMoneyIt(balanceBefore)}.`);
  const balanceAfter = roundMoney(balanceBefore - amount);

  const activeCard = await creditWalletActiveCard(slug, clientId);
  await tenantInsert(await tenantTable(slug, "credit_adjustments"), {
    client_id: clientId,
    card_id: activeCard?.id ?? null,
    card_code: activeCard?.code || null,
    direction: "debit",
    amount,
    delta_amount: -amount,
    balance_before: balanceBefore,
    balance_after: balanceAfter,
    note,
    location_id: location.id,
    location_name: String(location.name ?? "").slice(0, 190) || null,
    created_by: by > 0 ? by : null,
    created_at: new Date(),
  });
  await tenantUpdate({ slug, table: "clients", id: clientId, values: { credit_balance: balanceAfter } });

  return { ok: true, message: `Credito scalato manualmente: -€ ${formatMoneyIt(amount)}.`, movements: await getManageCreditMovements(slug, clientId) };
}

async function getSingleClient(slug: string, id: number): Promise<ManagedClient> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Cliente non trovato.");
  return mapClient(rows[0]);
}

function mapTransactionMovement(row: RowDataPacket): WalletMovement {
  const points = Math.round(Number(row.delta_points ?? 0));
  return {
    id: Number(row.id ?? 0),
    clientId: Number(row.client_id ?? 0),
    type: points < 0 ? "points_redeem" : points > 0 ? "points_earn" : "adjustment",
    amount: roundMoney(Number(row.amount ?? 0)),
    points,
    note: String(row.note ?? "Movimento punti"),
    source: String(row.source_type ?? row.kind ?? "transactions"),
    createdAt: toIso(row.created_at),
  };
}

function mapCreditAdjustmentMovement(row: RowDataPacket): WalletMovement {
  const amount = roundMoney(Number(row.delta_amount ?? (String(row.direction ?? "") === "debit" ? -Number(row.amount ?? 0) : Number(row.amount ?? 0))));
  return {
    id: Number(row.id ?? 0),
    clientId: Number(row.client_id ?? 0),
    type: amount >= 0 ? "recharge" : "debit",
    amount,
    points: 0,
    note: String(row.note ?? "Movimento credito"),
    source: "credit_adjustments",
    createdAt: toIso(row.created_at),
  };
}

function mapRechargeMovement(row: RowDataPacket): WalletMovement {
  return {
    id: Number(row.id ?? 0),
    clientId: Number(row.client_id ?? 0),
    type: "recharge",
    amount: roundMoney(Number(row.total_amount ?? row.base_amount ?? 0)),
    points: Math.round(Number(row.points_earned ?? 0)),
    note: String(row.note ?? "Ricarica"),
    source: "recharges",
    createdAt: toIso(row.created_at),
  };
}

function normalizeWalletMovementType(type: WalletMovementType | undefined): WalletMovementType {
  if (type === "recharge" || type === "debit" || type === "points_earn" || type === "points_redeem") return type;
  return "adjustment";
}

async function getSingleGiftCard(slug: string, id: number): Promise<GiftCard> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftcards", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("GiftCard non trovata.");
  return mapGiftCard(rows[0]);
}

function mapGiftCard(row: RowDataPacket): GiftCard {
  const status = giftCardStatus(String(row.status ?? "active"), String(row.expires_at ?? ""));
  return {
    id: Number(row.id ?? 0),
    code: String(row.code ?? ""),
    clientId: Number(row.client_id ?? 0),
    recipientName: String(row.recipient_name ?? "Destinatario"),
    initialAmount: roundMoney(Number(row.initial_amount ?? 0)),
    balance: roundMoney(Number(row.balance ?? 0)),
    status,
    expiresAt: String(row.expires_at ?? "").slice(0, 10) || addDaysDate(365),
    sourceSaleId: undefined,
    createdAt: toIso(row.issued_at ?? row.created_at),
  };
}

function giftCardStatus(status: string, expiresAt: string): GiftCardStatus {
  if (status === "redeemed") return "used";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "expired" || (expiresAt && expiresAt.slice(0, 10) < todayIso())) return "expired";
  return "active";
}

async function mapPackageCatalog(slug: string, row: RowDataPacket): Promise<PackageCatalog> {
  const id = Number(row.id ?? 0);
  const itemRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "package_items",
    where: "package_id = ?",
    params: [id],
    orderBy: "sort_order ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  const items = itemRows.length > 0
    ? await Promise.all(itemRows.map((item) => mapPackageCatalogItem(slug, item)))
    : [await packageCatalogItemFromPackage(slug, row)];

  return {
    id,
    name: String(row.name ?? "Pacchetto"),
    price: roundMoney(Number(row.price ?? 0)),
    items,
    active: Number(row.is_active ?? 1) === 1,
    locationIds: [],
    createdAt: toIso(row.created_at),
  };
}

async function mapPackageCatalogItem(slug: string, row: RowDataPacket): Promise<PackageCatalogItem> {
  const serviceId = Number(row.item_type === "service" ? row.item_id ?? 0 : row.service_id ?? row.item_id ?? 0);
  return {
    serviceId,
    serviceName: await serviceNameById(slug, serviceId, String(row.item_name_snapshot ?? "Servizio")),
    sessions: Math.max(1, Math.round(Number(row.qty ?? 1))),
  };
}

async function packageCatalogItemFromPackage(slug: string, row: RowDataPacket): Promise<PackageCatalogItem> {
  const serviceId = Number(row.service_id ?? 0);
  return {
    serviceId,
    serviceName: await serviceNameById(slug, serviceId, String(row.name ?? "Servizio")),
    sessions: Math.max(1, Math.round(Number(row.sessions_total ?? 1))),
  };
}

async function getSingleClientPackage(slug: string, id: number): Promise<ClientPackage> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "client_packages", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Pacchetto cliente non trovato.");
  return mapClientPackage(slug, rows[0]);
}

async function mapClientPackage(slug: string, row: RowDataPacket): Promise<ClientPackage> {
  const remaining = Math.max(0, Number(row.sessions_remaining ?? 0));
  return {
    id: Number(row.id ?? 0),
    packageId: Number(row.package_id ?? 0),
    clientId: Number(row.client_id ?? 0),
    clientName: await appointmentClientName(slug, Number(row.client_id ?? 0)),
    name: String(row.package_name ?? "Pacchetto"),
    totalSessions: Math.max(0, Number(row.sessions_total ?? remaining)),
    remainingSessions: remaining,
    expiresAt: row.expires_at ? String(row.expires_at).slice(0, 10) : undefined,
    status: clientPackageStatus(String(row.status ?? "active"), remaining, String(row.expires_at ?? "")),
    sourceSaleId: row.sale_id ? Number(row.sale_id) : undefined,
    createdAt: toIso(row.created_at ?? row.purchase_date),
  };
}

function clientPackageStatus(status: string, remaining: number, expiresAt: string): ClientPackageStatus {
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "expired" || (expiresAt && expiresAt.slice(0, 10) < todayIso() && remaining > 0)) return "expired";
  if (status === "completed" || remaining <= 0) return "completed";
  return "active";
}

async function insertClientPackageItemsFromCatalog(slug: string, clientPackageId: number, catalog: PackageCatalog): Promise<void> {
  for (const [index, item] of catalog.items.entries()) {
    await tenantInsert(await tenantTable(slug, "client_package_items"), {
      client_package_id: clientPackageId,
      item_type: "service",
      item_id: item.serviceId,
      qty: item.sessions,
      unit_price: 0,
      line_total: 0,
      sort_order: index,
      item_name_snapshot: item.serviceName,
    }).catch(() => 0);
    await tenantInsert(await tenantTable(slug, "client_package_services"), {
      client_package_id: clientPackageId,
      service_id: item.serviceId,
      sessions_total: item.sessions,
      sessions_remaining: item.sessions,
      sort_order: index,
    }).catch(() => 0);
  }
}

async function tryInsertPackageUsage(slug: string, clientPackageId: number, delta: number, note: string): Promise<void> {
  await tenantInsert(await tenantTable(slug, "client_package_usages"), {
    client_package_id: clientPackageId,
    used_at: new Date(),
    delta,
    note,
  }).catch(() => 0);
}

async function getSinglePrepaid(slug: string, id: number): Promise<ClientPrepaid> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "client_prepaid_services", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Prepagato non trovato.");
  return mapClientPrepaid(slug, rows[0]);
}

async function mapClientPrepaid(slug: string, row: RowDataPacket): Promise<ClientPrepaid> {
  const remaining = Math.max(0, Number(row.remaining_qty ?? 0));
  const prepaidId = Number(row.id ?? 0);
  // Single-row path (issue/consume result): compute the same booked/lastUsed split
  // the list uses, scoped to this one prepaid. listDbPrepaids batches these instead.
  const [booked, lastUsedAt] = await Promise.all([
    prepaidBookedQty(slug, prepaidId),
    prepaidLastUsedAt(slug, prepaidId),
  ]);
  const bookedQty = Math.min(remaining, booked);
  return {
    id: prepaidId,
    kind: "prepaid",
    clientId: Number(row.client_id ?? 0),
    clientName: await appointmentClientName(slug, Number(row.client_id ?? 0)),
    serviceId: Number(row.service_id ?? 0),
    serviceName: String(row.service_name ?? "Servizio"),
    totalQuantity: Math.max(0, Number(row.purchased_qty ?? remaining)),
    remainingQuantity: remaining,
    bookedQty,
    bookableQty: Math.max(0, remaining - bookedQty),
    lastUsedAt: lastUsedAt || undefined,
    expiresAt: row.expires_at ? String(row.expires_at).slice(0, 10) : undefined,
    status: clientPrepaidStatus(String(row.status ?? "active"), remaining, String(row.expires_at ?? "")),
    sourceSaleId: row.sale_id ? Number(row.sale_id) : undefined,
    createdAt: toIso(row.created_at ?? row.purchase_date),
  };
}

// Booked sessions for ONE standalone prepaid: qty on appointment_prepaid_service_items
// tied to an OPEN appointment (pending/scheduled) and not yet redeemed (redeemed_at IS
// NULL) — the legacy linked_qty. Tenant-scoped per table + in-memory join (no
// cross-tenant raw join). Missing tables -> 0.
async function prepaidBookedQty(slug: string, prepaidServiceId: number): Promise<number> {
  if (prepaidServiceId <= 0) return 0;
  try {
    const linkTable = await tenantTable(slug, "appointment_prepaid_service_items");
    if (!(await tableExists(linkTable.name))) return 0;
    const linkRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointment_prepaid_service_items",
      columns: "appointment_id, qty",
      where: "client_prepaid_service_id = ? AND redeemed_at IS NULL",
      params: [prepaidServiceId],
    });
    if (linkRows.length === 0) return 0;
    const openIds = await openAppointmentIds(slug, linkRows.map((r) => Number(r.appointment_id ?? 0)));
    return linkRows.reduce(
      (acc, r) => acc + (openIds.has(Number(r.appointment_id ?? 0)) ? Math.max(0, Number(r.qty ?? 0)) : 0),
      0,
    );
  } catch {
    return 0;
  }
}

// Last-usage timestamp for ONE prepaid: MAX(used_at) over its usages. Missing table -> "".
async function prepaidLastUsedAt(slug: string, prepaidServiceId: number): Promise<string> {
  if (prepaidServiceId <= 0) return "";
  try {
    const usageTable = await tenantTable(slug, "client_prepaid_service_usages");
    if (!(await tableExists(usageTable.name))) return "";
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "client_prepaid_service_usages",
      columns: "used_at",
      where: "client_prepaid_service_id = ?",
      params: [prepaidServiceId],
    });
    let last = "";
    for (const r of rows) {
      const at = r.used_at ? toIso(r.used_at) : "";
      if (at && at > last) last = at;
    }
    return last;
  } catch {
    return "";
  }
}

// Given a set of appointment ids, return the subset whose status is OPEN
// (pending/scheduled) for this tenant. One tenant-scoped query, in-memory filter.
async function openAppointmentIds(slug: string, ids: number[]): Promise<Set<number>> {
  const unique = Array.from(new Set(ids.filter((n) => n > 0)));
  if (unique.length === 0) return new Set();
  try {
    const apptTable = await tenantTable(slug, "appointments");
    if (!(await tableExists(apptTable.name))) {
      // No appointments table: legacy treats not-yet-redeemed links as booked.
      return new Set(unique);
    }
    const placeholders = unique.map(() => "?").join(",");
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointments",
      columns: "id",
      where: `id IN (${placeholders}) AND LOWER(TRIM(COALESCE(status, ''))) IN ('pending', 'scheduled')`,
      params: unique,
    });
    return new Set(rows.map((r) => Number(r.id ?? 0)));
  } catch {
    return new Set(unique);
  }
}

function clientPrepaidStatus(status: string, remaining: number, expiresAt: string): ClientPrepaidStatus {
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "expired" || (expiresAt && expiresAt.slice(0, 10) < todayIso() && remaining > 0)) return "expired";
  if (status === "completed" || remaining <= 0) return "completed";
  return "active";
}

async function getSinglePreorder(slug: string, id: number): Promise<Preorder> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "sale_items", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Preordine non trovato.");
  return mapPreorder(slug, rows[0]);
}

async function mapPreorder(slug: string, row: RowDataPacket): Promise<Preorder> {
  const sale = await getSaleRow(slug, Number(row.sale_id ?? 0));
  return {
    id: Number(row.id ?? 0),
    clientId: Number(sale?.client_id ?? 0),
    clientName: await appointmentClientName(slug, Number(sale?.client_id ?? 0)),
    productId: Number(row.item_id ?? 0),
    productName: String(row.item_name ?? "Prodotto"),
    quantity: Math.max(1, Number(row.qty ?? 1)),
    deposit: roundMoney(Number(sale?.total ?? 0)),
    dueDate: String(row.preorder_expires_at ?? addDaysDate(14)).slice(0, 10),
    status: String(row.item_status ?? "") === "collected" ? "collected" : "open",
    createdAt: toIso(sale?.sale_date ?? sale?.created_at),
    collectedAt: String(row.item_status ?? "") === "collected" ? toIso(sale?.created_at) : undefined,
  };
}

async function getSingleCoupon(slug: string, id: number): Promise<CouponRule> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "coupons", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Coupon non trovato.");
  return mapCoupon(slug, rows[0]);
}

async function getCouponByCode(slug: string, code: string): Promise<CouponRule | null> {
  const normalized = normalizeCouponCode(code);
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "coupons",
    where: "code = ? AND deleted_at IS NULL",
    params: [normalized],
    limit: 1,
  });
  return rows[0] ? mapCoupon(slug, rows[0]) : null;
}

async function mapCoupon(slug: string, row: RowDataPacket): Promise<CouponRule> {
  const code = normalizeCouponCode(String(row.code ?? ""));
  return {
    id: Number(row.id ?? 0),
    code,
    type: String(row.discount_type ?? "") === "fixed" ? "fixed" : "percent",
    value: roundMoney(Number(row.discount_value ?? 0)),
    minSubtotal: roundMoney(Number(row.min_subtotal ?? 0)),
    active: Number(row.is_active ?? 1) === 1 && !row.cancelled_at,
    // NULL validity bounds stay EMPTY (unbounded, like the legacy): activeWindow()
    // treats "" as no limit. The previous today/+30d fallbacks invented a rolling
    // fake window — display-wrong AND a real bug: a no-expiry coupon previewed
    // as-of an appointment date >30 days ahead was wrongly judged expired.
    startsAt: row.valid_from ? String(row.valid_from).slice(0, 10) : "",
    endsAt: row.valid_to ? String(row.valid_to).slice(0, 10) : "",
    usageLimit: Math.max(0, Math.round(Number(row.usage_limit ?? 0))),
    usedCount: await couponUsageCount(slug, code),
    createdAt: toIso(row.created_at),
  };
}

async function couponUsageCount(slug: string, code: string): Promise<number> {
  let count = 0;
  const params = [code];
  try {
    count += (await tenantSelect<RowDataPacket>({
      slug,
      table: "sales",
      columns: "id",
      where: "coupon_code = ? AND status <> 'cancelled'",
      params,
    })).length;
  } catch {}
  try {
    count += (await tenantSelect<RowDataPacket>({
      slug,
      table: "appointments",
      columns: "id",
      where: "coupon_code = ? AND status <> 'canceled'",
      params,
    })).length;
  } catch {}
  return count;
}

function mapPromotion(row: RowDataPacket): PromotionRule {
  return {
    id: Number(row.id ?? 0),
    name: String(row.title ?? "Promozione"),
    target: promotionTarget(String(row.target_type ?? "all")),
    discountType: String(row.discount_type ?? "") === "fixed" ? "fixed" : "percent",
    discountValue: roundMoney(Number(row.discount_value ?? 0)),
    active: Number(row.is_active ?? 1) === 1,
    startsAt: String(row.starts_at ?? todayIso()).slice(0, 10),
    endsAt: String(row.ends_at ?? addDaysDate(30)).slice(0, 10),
    channel: Number(row.show_in_booking ?? 1) === 1 ? "booking" : String(row.marketplace_visibility ?? "") === "hidden" ? "pos" : "marketplace",
    createdAt: toIso(row.created_at),
  };
}

function promotionTarget(value: string): PromotionRule["target"] {
  if (value === "new") return "new_clients";
  if (value === "inactive" || value === "birthday" || value === "fidelity") return value;
  return "all";
}

async function getSingleGiftBox(slug: string, id: number): Promise<GiftBoxInstance> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftbox_instances", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("GiftBox non trovata.");
  return mapGiftBox(slug, rows[0]);
}

async function mapGiftBox(slug: string, row: RowDataPacket): Promise<GiftBoxInstance> {
  const id = Number(row.id ?? 0);
  const items = await giftBoxItems(slug, id);
  const total = items.reduce((sum, item) => sum + item.sessions, 0);
  const redeemed = await giftBoxRedeemedUnits(slug, id);
  return {
    id,
    code: String(row.code ?? ""),
    clientId: Number(row.client_id ?? 0),
    recipientName: String(row.recipient_name ?? "Destinatario"),
    items,
    remainingItems: Math.max(0, total - redeemed),
    status: giftBoxStatus(String(row.status ?? "issued"), String(row.expires_at ?? ""), total - redeemed),
    expiresAt: String(row.expires_at ?? addDaysDate(180)).slice(0, 10),
    sourceSaleId: undefined,
    createdAt: toIso(row.created_at ?? row.issued_at),
  };
}

async function giftBoxItems(slug: string, instanceId: number): Promise<PackageCatalogItem[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "giftbox_instance_items",
    where: "instance_id = ?",
    params: [instanceId],
    orderBy: "sort_order ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  return Promise.all(rows.map(async (row) => {
    const serviceId = Number(row.service_id ?? 0);
    return {
      serviceId,
      serviceName: String(row.custom_label ?? "") || await serviceNameById(slug, serviceId, "Servizio"),
      sessions: Math.max(1, Number(row.qty ?? 1)),
    };
  }));
}

async function giftBoxRedeemedUnits(slug: string, instanceId: number): Promise<number> {
  try {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "appointment_giftbox_items", columns: "qty", where: "instance_id = ? AND redeemed_at IS NOT NULL", params: [instanceId] });
    const appointmentUnits = rows.reduce((sum, row) => sum + Math.max(1, Number(row.qty ?? 1)), 0);
    const manual = await tenantSelect<RowDataPacket>({ slug, table: "giftbox_redemptions", columns: "id", where: "instance_id = ?", params: [instanceId] });
    return appointmentUnits + manual.length;
  } catch {
    return 0;
  }
}

// Units already REDEEMED for a SINGLE giftbox item (instance_id + the item's
// giftbox_instance_items.giftbox_item_id value, NOT the row surrogate id). This is the
// authoritative per-item redeemed count used to compute residual availability, exactly
// like the legacy qb_giftbox_item_remaining: it sums giftbox_redemption_items.qty for
// redemptions of that instance whose redemption-item targets that giftbox_item_id.
//   SUM(ri.qty) FROM giftbox_redemptions r JOIN giftbox_redemption_items ri
//     ON ri.redemption_id = r.id WHERE r.instance_id = ? AND ri.giftbox_item_id = ?
// Recording one redeem (a giftbox_redemptions row + a giftbox_redemption_items row with
// qty 1 for that giftbox_item_id) therefore makes this reflect the consumption — so we
// never double-redeem a unit. Tolerates the redemption tables being absent (-> 0).
async function giftBoxItemRedeemedUnits(slug: string, instanceId: number, giftboxItemId: number): Promise<number> {
  if (instanceId <= 0 || giftboxItemId <= 0) return 0;
  try {
    const headerTable = await tenantTable(slug, "giftbox_redemptions");
    const itemTable = await tenantTable(slug, "giftbox_redemption_items");
    const clauses: string[] = ["r.instance_id = ?", "ri.giftbox_item_id = ?"];
    const params: unknown[] = [instanceId, giftboxItemId];
    // tenantSelect can only scope a single table; this is a JOIN, so scope BOTH
    // shared-mode tables to the tenant explicitly (mirrors tenantSelect's guard).
    if (headerTable.mode === "shared" && (await columnExists(headerTable.name, "tenant_id"))) {
      clauses.push("r.tenant_id = ?");
      params.push(headerTable.tenantId ?? 0);
    }
    if (itemTable.mode === "shared" && (await columnExists(itemTable.name, "tenant_id"))) {
      clauses.push("ri.tenant_id = ?");
      params.push(itemTable.tenantId ?? 0);
    }
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT COALESCE(SUM(ri.qty), 0) AS c
         FROM ${quoteIdentifier(itemTable.name)} ri
         JOIN ${quoteIdentifier(headerTable.name)} r ON r.id = ri.redemption_id
        WHERE ${clauses.join(" AND ")}`,
      params,
    );
    return Math.max(0, Number(rows[0]?.c ?? 0) || 0);
  } catch {
    return 0;
  }
}

function giftBoxStatus(status: string, expiresAt: string, remaining: number): GiftBoxStatus {
  if (status === "redeemed" || remaining <= 0) return "redeemed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "expired" || (expiresAt && expiresAt.slice(0, 10) < todayIso())) return "expired";
  return "active";
}

async function getSingleGift(slug: string, id: number): Promise<GiftReward> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "gift_instances", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Omaggi non trovato.");
  return mapGiftReward(slug, rows[0]);
}

async function mapGiftReward(slug: string, row: RowDataPacket): Promise<GiftReward> {
  const giftId = Number(row.gift_id ?? 0);
  const giftRows = giftId > 0
    ? await tenantSelect<RowDataPacket>({ slug, table: "gifts", where: "id = ?", params: [giftId], limit: 1 }).catch(() => [] as RowDataPacket[])
    : [];
  const gift = giftRows[0] ?? {};
  return {
    id: Number(row.id ?? 0),
    clientId: Number(row.client_id ?? 0),
    clientName: await appointmentClientName(slug, Number(row.client_id ?? 0)),
    title: String(gift.name ?? gift.reward_custom_label ?? "Omaggi"),
    rewardType: giftRewardType(String(gift.reward_type ?? "")),
    value: roundMoney(Number(gift.redeem_points_cost ?? row.points_spent ?? 0)),
    status: giftRewardStatus(String(row.state ?? ""), String(row.expires_at ?? "")),
    expiresAt: String(row.expires_at ?? addDaysDate(60)).slice(0, 10),
    createdAt: toIso(row.created_at),
    redeemedAt: row.redeemed_at ? toIso(row.redeemed_at) : undefined,
  };
}

function giftRewardType(value: string): GiftReward["rewardType"] {
  if (value === "service") return "service";
  if (value === "product") return "product";
  return "discount";
}

function giftRewardStatus(state: string, expiresAt: string): GiftReward["status"] {
  if (state === "riscattato" || state === "redeemed") return "redeemed";
  if (state === "scaduto" || state === "expired" || (expiresAt && expiresAt.slice(0, 10) < todayIso())) return "expired";
  if (state === "annullato" || state === "cancelled" || state === "canceled") return "cancelled";
  return "available";
}

async function ensureDbGiftTemplate(slug: string, input: { title?: string; rewardType?: GiftReward["rewardType"]; value?: number }): Promise<number> {
  const title = normalizeName(input.title, "Omaggi manuale");
  const existing = await tenantSelect<RowDataPacket>({
    slug,
    table: "gifts",
    columns: "id",
    where: "name = ? AND deleted_at IS NULL",
    params: [title],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  if (existing[0]) return Number(existing[0].id ?? 0);
  return tenantInsert(await tenantTable(slug, "gifts"), {
    name: title,
    description: title,
    eligibility: "all_clients",
    reward_type: input.rewardType === "service" || input.rewardType === "product" ? input.rewardType : "custom",
    reward_custom_label: title,
    redeem_points_enabled: 0,
    redeem_points_cost: roundMoney(Number(input.value ?? 0)),
    active: 1,
  });
}

// ---------------------------------------------------------------------------
// Gift CAMPAIGN editor (gifts.php action=new|edit) — the "Nuova/Modifica
// campagna" form, distinct from the issued gift INSTANCES list. It writes the
// `gifts` template row (+ a single unlock rule via gift_rule_sets/gift_rules and
// the enabled sedi via gift_locations) so the POS/booking gift engine can issue
// instances from it. Reward items are stored in gifts.reward_items_json, exactly
// like the legacy Gifts::saveGift.
// ---------------------------------------------------------------------------

export type GiftFormCatalogItem = { id: number; name: string };

// Shared catalog used by the gift + giftbox template editors: active services,
// active products (label = name + sku), and locations. Mirrors the SELECTs the
// legacy gifts.php/giftbox.php run to populate their item dropdowns.
export async function giftFormCatalog(slug: string): Promise<{
  services: GiftFormCatalogItem[];
  products: GiftFormCatalogItem[];
  locations: GiftFormCatalogItem[];
}> {
  const serviceRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "services",
    columns: "id, name",
    where: "is_active = 1",
    orderBy: "COALESCE(category_id, 999999) ASC, COALESCE(sort_order, 0) ASC, name ASC",
  }).catch(() => [] as RowDataPacket[]);
  const productRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "products",
    columns: "id, name, sku",
    where: "is_active = 1",
    orderBy: "name ASC",
  }).catch(() => [] as RowDataPacket[]);
  const locationRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "locations",
    columns: "id, name",
    orderBy: "sort_order ASC, name ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);

  return {
    services: serviceRows.map((row) => ({ id: Number(row.id ?? 0), name: String(row.name ?? "") })),
    products: productRows.map((row) => {
      const name = String(row.name ?? "");
      const sku = String(row.sku ?? "").trim();
      return { id: Number(row.id ?? 0), name: sku ? `${name} (${sku})` : name };
    }),
    locations: locationRows.map((row) => ({ id: Number(row.id ?? 0), name: String(row.name ?? "") })),
  };
}

export type GiftCampaignRewardItem = {
  type: "service" | "product" | "custom";
  serviceId: number;
  productId: number;
  customLabel: string;
  customDetails: string;
  qty: number;
};

export type GiftRuleRecord = {
  ruleType: string;
  targetServiceId: number;
  targetProductId: number;
  threshold: string;
};

export type ManageGiftRecord = {
  id: number;
  name: string;
  description: string;
  fidelityOnly: boolean;
  active: boolean;
  termsEnabled: boolean;
  termsText: string;
  validFrom: string;
  validTo: string;
  expiresAfterDays: string;
  locationIds: number[];
  rewardItems: GiftCampaignRewardItem[];
  rule: GiftRuleRecord;
};

function normalizeGiftRewardType(value: unknown): GiftCampaignRewardItem["type"] {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "service" || v === "product" || v === "custom" ? v : "service";
}

function normalizeGiftRuleType(value: unknown): string {
  const v = String(value ?? "").trim().toLowerCase();
  const allowed = ["service_qty", "product_qty", "appointments_count", "total_spend", "first_visit"];
  return allowed.includes(v) ? v : "appointments_count";
}

// Edit-form prefill: ONE gift campaign's editable fields. Port of gifts.php
// action=edit, reading the gifts row, its reward_items_json, its enabled sedi
// (gift_locations) and its single unlock rule (gift_rule_sets -> gift_rules).
export async function getManageGift(slug: string, id: number): Promise<ManageGiftRecord | null> {
  if (id <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "gifts",
    where: "id = ? AND deleted_at IS NULL",
    params: [id],
    limit: 1,
  });
  const g = rows[0];
  if (!g) return null;

  // reward_items_json -> list (fallback to the legacy single reward_* columns).
  let rewardItems: GiftCampaignRewardItem[] = [];
  try {
    const parsed = JSON.parse(String(g.reward_items_json ?? "[]"));
    if (Array.isArray(parsed)) {
      rewardItems = parsed.map((it: Record<string, unknown>) => ({
        type: normalizeGiftRewardType(it.type),
        serviceId: Number(it.service_id ?? 0) || 0,
        productId: Number(it.product_id ?? 0) || 0,
        customLabel: String(it.custom_label ?? ""),
        customDetails: String(it.custom_details ?? ""),
        qty: Math.max(1, Number(it.qty ?? 1) || 1),
      }));
    }
  } catch {
    rewardItems = [];
  }
  if (rewardItems.length === 0) {
    rewardItems = [{
      type: normalizeGiftRewardType(g.reward_type),
      serviceId: Number(g.reward_service_id ?? 0) || 0,
      productId: Number(g.reward_product_id ?? 0) || 0,
      customLabel: String(g.reward_custom_label ?? ""),
      customDetails: String(g.reward_custom_details ?? ""),
      qty: 1,
    }];
  }

  const locationRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "gift_locations",
    columns: "location_id",
    where: "gift_id = ?",
    params: [id],
  }).catch(() => [] as RowDataPacket[]);
  const locationIds = locationRows.map((row) => Number(row.location_id ?? 0)).filter((n) => n > 0);

  // Single unlock rule via the first rule set.
  let rule: GiftRuleRecord = { ruleType: "appointments_count", targetServiceId: 0, targetProductId: 0, threshold: "1" };
  const ruleSets = await tenantSelect<RowDataPacket>({
    slug,
    table: "gift_rule_sets",
    columns: "id",
    where: "gift_id = ?",
    params: [id],
    orderBy: "sort_order ASC, id ASC",
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  if (ruleSets[0]) {
    const ruleRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "gift_rules",
      where: "rule_set_id = ?",
      params: [Number(ruleSets[0].id ?? 0)],
      orderBy: "sort_order ASC, id ASC",
      limit: 1,
    }).catch(() => [] as RowDataPacket[]);
    if (ruleRows[0]) {
      rule = {
        ruleType: normalizeGiftRuleType(ruleRows[0].rule_type),
        targetServiceId: Number(ruleRows[0].target_service_id ?? 0) || 0,
        targetProductId: Number(ruleRows[0].target_product_id ?? 0) || 0,
        threshold: String(ruleRows[0].threshold ?? "1"),
      };
    }
  }

  return {
    id,
    name: String(g.name ?? ""),
    description: String(g.description ?? ""),
    fidelityOnly: String(g.eligibility ?? "all_clients") === "fidelity_only",
    active: Number(g.active ?? 0) === 1,
    termsEnabled: Number(g.terms_enabled ?? 0) === 1,
    termsText: String(g.terms_text ?? ""),
    validFrom: g.valid_from ? toIso(g.valid_from).slice(0, 10) : "",
    validTo: g.valid_to ? toIso(g.valid_to).slice(0, 10) : "",
    expiresAfterDays: g.expires_after_days != null ? String(g.expires_after_days) : "",
    locationIds,
    rewardItems,
    rule,
  };
}

// Create / update a gift campaign, faithful to gifts.php POST(action=new|edit) /
// Gifts::saveGift. Writes the gifts row, replaces the gift_locations rows, and
// rebuilds the single unlock rule (gift_rule_sets + gift_rules). Reward items are
// posted as a JSON string (reward_items_json) because parseRequestBody flattens
// arrays. The advanced Fidelity targeting (eligible_levels_points) and the
// excluded-clients list are NOT written here — see the form TODO.
export async function saveManageGift(slug: string, body: Record<string, string>, id: number): Promise<ManageGiftRecord> {
  const name = String(body.name ?? "").trim();
  if (name === "") throw new Error("Nome campagna obbligatorio.");

  const fidelityOnly = String(body.fidelity_only ?? "") === "1";
  const active = String(body.active ?? "") === "1";
  const termsEnabled = String(body.terms_enabled ?? "") === "1";
  const termsText = String(body.terms_text ?? "");

  const from = normalizeClientDate(body.valid_from);
  const to = normalizeClientDate(body.valid_to);
  if (!from) throw new Error('Inserisci una data "Valido dal" valida.');
  if (!to) throw new Error('Inserisci una data "Valido al" valida.');
  if (from > to) throw new Error('La data "Valido al" deve essere successiva a "Valido dal".');

  const expiresAfterRaw = String(body.expires_after_days ?? "").trim();
  const expiresAfterDays = expiresAfterRaw === "" ? null : Math.max(0, parseInt(expiresAfterRaw, 10) || 0);

  // reward_items_json -> persisted JSON (mirror of Gifts::saveGift items).
  let rewardItems: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(String(body.reward_items_json ?? "[]"));
    if (Array.isArray(parsed)) {
      rewardItems = parsed
        .map((it: Record<string, unknown>) => {
          const type = normalizeGiftRewardType(it.type);
          return {
            type,
            service_id: type === "service" ? Number(it.service_id ?? 0) || 0 : 0,
            product_id: type === "product" ? Number(it.product_id ?? 0) || 0 : 0,
            custom_label: type === "custom" ? String(it.custom_label ?? "") : "",
            custom_details: type === "custom" ? String(it.custom_details ?? "") : "",
            qty: Math.max(1, Number(it.qty ?? 1) || 1),
          };
        })
        .filter((it) => it.type === "custom" ? String(it.custom_label).trim() !== "" : (it.service_id > 0 || it.product_id > 0));
    }
  } catch {
    rewardItems = [];
  }
  if (rewardItems.length === 0) throw new Error("Aggiungi almeno un elemento da regalare.");
  const firstReward = rewardItems[0];

  const locationIds = String(body.location_ids ?? "")
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  const values: Record<string, unknown> = {
    name,
    description: String(body.description ?? "").trim() || null,
    eligibility: fidelityOnly ? "fidelity_only" : "all_clients",
    reward_type: String(firstReward.type ?? "custom"),
    reward_service_id: Number(firstReward.service_id ?? 0) || null,
    reward_product_id: Number(firstReward.product_id ?? 0) || null,
    reward_custom_label: String(firstReward.custom_label ?? "") || null,
    reward_custom_details: String(firstReward.custom_details ?? "") || null,
    reward_items_json: JSON.stringify(rewardItems),
    active: active ? 1 : 0,
    valid_from: from,
    valid_to: to,
    expires_after_days: expiresAfterDays,
    terms_enabled: termsEnabled ? 1 : 0,
    terms_text: termsText,
  };

  let giftId = id;
  if (giftId > 0) {
    const existing = await tenantSelect<RowDataPacket>({ slug, table: "gifts", columns: "id", where: "id = ? AND deleted_at IS NULL", params: [giftId], limit: 1 });
    if (!existing[0]) throw new Error("Campagna non trovata.");
    await tenantUpdate({ slug, table: "gifts", id: giftId, values });
  } else {
    giftId = await tenantInsert(await tenantTable(slug, "gifts"), values);
  }

  // Replace enabled sedi (gift_locations): remove existing rows for this gift,
  // then re-insert the selection.
  const locTable = await tenantTable(slug, "gift_locations");
  await dbExecute(
    `DELETE FROM ${quoteIdentifier(locTable.name)} WHERE gift_id = ?${locTable.mode === "shared" && (await columnExists(locTable.name, "tenant_id")) ? " AND tenant_id = ?" : ""}`,
    locTable.mode === "shared" && (await columnExists(locTable.name, "tenant_id")) ? [giftId, locTable.tenantId ?? 0] : [giftId],
  ).catch(() => undefined);
  for (const locationId of locationIds) {
    await tenantInsert(locTable, { gift_id: giftId, location_id: locationId }).catch(() => 0);
  }

  // Rebuild the single unlock rule (gift_rule_sets + gift_rules).
  const ruleType = normalizeGiftRuleType(body.rule_type);
  const ruleThresholdRaw = String(body.rule_threshold ?? "1").replace(",", ".");
  const ruleThreshold = Math.max(0, Number.parseFloat(ruleThresholdRaw) || 0);
  const ruleServiceId = Number.parseInt(String(body.rule_service_id ?? "0"), 10) || 0;
  const ruleProductId = Number.parseInt(String(body.rule_product_id ?? "0"), 10) || 0;

  const setTable = await tenantTable(slug, "gift_rule_sets");
  const ruleTable = await tenantTable(slug, "gift_rules");
  const existingSets = await tenantSelect<RowDataPacket>({ slug, table: "gift_rule_sets", columns: "id", where: "gift_id = ?", params: [giftId] }).catch(() => [] as RowDataPacket[]);
  for (const set of existingSets) {
    const setId = Number(set.id ?? 0);
    await dbExecute(
      `DELETE FROM ${quoteIdentifier(ruleTable.name)} WHERE rule_set_id = ?${ruleTable.mode === "shared" && (await columnExists(ruleTable.name, "tenant_id")) ? " AND tenant_id = ?" : ""}`,
      ruleTable.mode === "shared" && (await columnExists(ruleTable.name, "tenant_id")) ? [setId, ruleTable.tenantId ?? 0] : [setId],
    ).catch(() => undefined);
  }
  await dbExecute(
    `DELETE FROM ${quoteIdentifier(setTable.name)} WHERE gift_id = ?${setTable.mode === "shared" && (await columnExists(setTable.name, "tenant_id")) ? " AND tenant_id = ?" : ""}`,
    setTable.mode === "shared" && (await columnExists(setTable.name, "tenant_id")) ? [giftId, setTable.tenantId ?? 0] : [giftId],
  ).catch(() => undefined);
  const ruleSetId = await tenantInsert(setTable, { gift_id: giftId, set_operator: "and", sort_order: 0 });
  await tenantInsert(ruleTable, {
    rule_set_id: ruleSetId,
    rule_type: ruleType,
    comparator: ">=",
    threshold: ruleThreshold,
    target_service_id: ruleType === "service_qty" ? (ruleServiceId || null) : null,
    target_product_id: ruleType === "product_qty" ? (ruleProductId || null) : null,
    window_type: "all_time",
    sort_order: 0,
  }).catch(() => 0);

  const saved = await getManageGift(slug, giftId);
  if (!saved) throw new Error("Campagna non salvata.");
  return saved;
}

// ---- Gift CAMPAIGN list / toggle / delete (gifts.php) -------------------------
export type ManageGiftListRow = {
  id: number;
  name: string;
  description: string;
  active: boolean;
  isCurrentlyActive: boolean;
  autoDisabled: boolean;
  fidelityOnly: boolean;
  validFrom: string;
  validTo: string;
  instancesCount: number;
  rewardSummary: string;
  locationIds: number[];
};

// Parse a gift row's reward items (reward_items_json, fallback to reward_* columns).
function giftRewardRefsFromRow(row: RowDataPacket): { type: "service" | "product" | "custom"; serviceId: number; productId: number; label: string; qty: number }[] {
  const out: { type: "service" | "product" | "custom"; serviceId: number; productId: number; label: string; qty: number }[] = [];
  let parsed: unknown[] = [];
  try { const p = JSON.parse(String(row.reward_items_json ?? "[]")); if (Array.isArray(p)) parsed = p; } catch { parsed = []; }
  if (parsed.length > 0) {
    for (const it of parsed) {
      const o = it as Record<string, unknown>;
      out.push({ type: normalizeGiftRewardType(o.type), serviceId: Number(o.service_id ?? 0) || 0, productId: Number(o.product_id ?? 0) || 0, label: String(o.custom_label ?? ""), qty: Math.max(1, Number(o.qty ?? 1) || 1) });
    }
  } else {
    out.push({ type: normalizeGiftRewardType(row.reward_type), serviceId: Number(row.reward_service_id ?? 0) || 0, productId: Number(row.reward_product_id ?? 0) || 0, label: String(row.reward_custom_label ?? ""), qty: 1 });
  }
  return out;
}

export async function listManageGifts(slug: string): Promise<ManageGiftListRow[]> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "gifts", where: "deleted_at IS NULL", orderBy: "id DESC" }).catch(() => [] as RowDataPacket[]);
  if (rows.length === 0) return [];

  // Instance counts (grouped) + locations (grouped) + reward item names (batched).
  const instTable = await tenantTable(slug, "gift_instances");
  const instRows = await dbQuery<RowDataPacket[]>(`SELECT gift_id, COUNT(*) c FROM ${quoteIdentifier(instTable.name)} WHERE tenant_id = ? GROUP BY gift_id`, [instTable.tenantId ?? 0]).catch(() => [] as RowDataPacket[]);
  const instMap = new Map<number, number>(instRows.map((r) => [Number(r.gift_id), Number(r.c)]));

  const locRows = await tenantSelect<RowDataPacket>({ slug, table: "gift_locations", columns: "gift_id, location_id" }).catch(() => [] as RowDataPacket[]);
  const locMap = new Map<number, number[]>();
  for (const r of locRows) {
    const gid = Number(r.gift_id ?? 0);
    if (!locMap.has(gid)) locMap.set(gid, []);
    const lid = Number(r.location_id ?? 0);
    if (lid > 0) locMap.get(gid)!.push(lid);
  }

  const refsByGift = new Map<number, ReturnType<typeof giftRewardRefsFromRow>>();
  const serviceIds = new Set<number>();
  const productIds = new Set<number>();
  for (const g of rows) {
    const refs = giftRewardRefsFromRow(g);
    refsByGift.set(Number(g.id), refs);
    for (const r of refs) { if (r.serviceId > 0) serviceIds.add(r.serviceId); if (r.productId > 0) productIds.add(r.productId); }
  }
  const svcNames = new Map<number, string>();
  const prdNames = new Map<number, string>();
  if (serviceIds.size > 0) {
    const ids = [...serviceIds];
    const sr = await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "id, name", where: `id IN (${ids.map(() => "?").join(",")})`, params: ids }).catch(() => [] as RowDataPacket[]);
    for (const r of sr) svcNames.set(Number(r.id), String(r.name ?? ""));
  }
  if (productIds.size > 0) {
    const ids = [...productIds];
    const pr = await tenantSelect<RowDataPacket>({ slug, table: "products", columns: "id, name", where: `id IN (${ids.map(() => "?").join(",")})`, params: ids }).catch(() => [] as RowDataPacket[]);
    for (const r of pr) prdNames.set(Number(r.id), String(r.name ?? ""));
  }

  const now = Date.now();
  return rows.map((g) => {
    const id = Number(g.id ?? 0);
    const active = Number(g.active ?? 0) === 1;
    const validFrom = g.valid_from ? toIso(g.valid_from) : "";
    const validTo = g.valid_to ? toIso(g.valid_to) : "";
    const withinWindow = validFrom !== "" && validTo !== "" && new Date(validFrom).getTime() <= now && new Date(validTo).getTime() >= now;
    const refs = refsByGift.get(id) ?? [];
    const rewardSummary = refs
      .map((r) => {
        const base = r.type === "service" ? svcNames.get(r.serviceId) || `Servizio #${r.serviceId}` : r.type === "product" ? prdNames.get(r.productId) || `Prodotto #${r.productId}` : r.label || "Premio personalizzato";
        return r.qty > 1 ? `${base} ×${r.qty}` : base;
      })
      .join(", ");
    return {
      id,
      name: String(g.name ?? ""),
      description: String(g.description ?? ""),
      active,
      isCurrentlyActive: active && withinWindow,
      autoDisabled: Number(g.auto_disabled_by_fidelity ?? 0) === 1,
      fidelityOnly: String(g.eligibility ?? "fidelity_only") === "fidelity_only",
      validFrom: validFrom ? validFrom.slice(0, 10) : "",
      validTo: validTo ? validTo.slice(0, 10) : "",
      instancesCount: instMap.get(id) ?? 0,
      rewardSummary: rewardSummary || "—",
      locationIds: locMap.get(id) ?? [],
    };
  });
}

// Reward/rule references that must resolve to a live service/product before a gift
// campaign can be (re)activated (port of Gifts::activationContentIssues).
async function giftActivationContentIssues(slug: string, id: number): Promise<string[]> {
  const gift = await getManageGift(slug, id);
  if (!gift) return [];
  const refs: { type: "service" | "product"; refId: number; context: string }[] = [];
  for (const item of gift.rewardItems) {
    if (item.type === "service" && item.serviceId > 0) refs.push({ type: "service", refId: item.serviceId, context: "Premio" });
    else if (item.type === "product" && item.productId > 0) refs.push({ type: "product", refId: item.productId, context: "Premio" });
  }
  if (gift.rule.targetServiceId > 0) refs.push({ type: "service", refId: gift.rule.targetServiceId, context: "Regola di sblocco" });
  if (gift.rule.targetProductId > 0) refs.push({ type: "product", refId: gift.rule.targetProductId, context: "Regola di sblocco" });

  const seen = new Set<string>();
  const issues: string[] = [];
  for (const ref of refs) {
    const key = `${ref.type}:${ref.refId}:${ref.context}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const table = ref.type === "service" ? "services" : "products";
    const typeLabel = ref.type === "service" ? "Servizio" : "Prodotto";
    const rows = await tenantSelect<RowDataPacket>({ slug, table, columns: "id, name, is_active", where: "id = ?", params: [ref.refId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    if (!rows[0]) {
      issues.push(`[${ref.context}] ${typeLabel} #${ref.refId} eliminato`);
    } else if (Number(rows[0].is_active ?? 1) === 0) {
      issues.push(`[${ref.context}] ${typeLabel} "${String(rows[0].name ?? `#${ref.refId}`)}" disattivato`);
    }
  }
  return issues;
}

// Activate/deactivate a gift campaign (port of gifts.php toggle_active + Gifts::
// setGiftActive): activating is refused while the reward/unlock references a
// deleted/disabled service or product; a manual toggle clears auto_disabled.
export async function toggleManageGift(slug: string, id: number, active: boolean, by: number): Promise<{ ok: true; active: boolean }> {
  if (id <= 0) throw new Error("Campagna non valida.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "gifts", columns: "id, deleted_at", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Campagna omaggio non trovata.");
  if (rows[0].deleted_at) throw new Error("Campagna omaggio eliminata.");
  if (active) {
    const issues = await giftActivationContentIssues(slug, id);
    if (issues.length > 0) {
      throw new Error(`Non è possibile riattivare la campagna omaggio: contiene servizi o prodotti eliminati/disattivati. ${issues.join("; ")}.`);
    }
  }
  await tenantUpdate({ slug, table: "gifts", id, values: { active: active ? 1 : 0, auto_disabled_by_fidelity: 0, updated_by: by > 0 ? by : null, updated_at: new Date() } });
  return { ok: true, active };
}

// Delete a gift campaign (port of Gifts::softDeleteGift): detach the reward from any
// still-open appointments, then hard-delete the campaign + all children, falling back
// to a soft-delete (deleted_at + active=0) if a foreign key blocks the hard delete.
export async function deleteManageGift(slug: string, id: number, by: number): Promise<{ ok: true; mode: "hard" | "soft" }> {
  if (id <= 0) throw new Error("Campagna non valida.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "gifts", columns: "id", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) return { ok: true, mode: "hard" };

  // Detach the campaign's issued instances from any pending/scheduled appointments,
  // clearing the reserved gift benefit so no dangling redemption remains.
  const instTable = await tenantTable(slug, "gift_instances");
  const instRows = await tenantSelect<RowDataPacket>({ slug, table: "gift_instances", columns: "id", where: "gift_id = ?", params: [id] }).catch(() => [] as RowDataPacket[]);
  const instIds = instRows.map((r) => Number(r.id ?? 0)).filter((n) => n > 0);
  if (instIds.length > 0 && (await tableExists((await tenantTable(slug, "appointment_gift_items")).name))) {
    const agiTable = await tenantTable(slug, "appointment_gift_items");
    const placeholders = instIds.map(() => "?").join(",");
    const apptRows = await dbQuery<RowDataPacket[]>(`SELECT DISTINCT appointment_id FROM ${quoteIdentifier(agiTable.name)} WHERE tenant_id = ? AND instance_id IN (${placeholders})`, [agiTable.tenantId ?? 0, ...instIds]).catch(() => [] as RowDataPacket[]);
    for (const ar of apptRows) {
      const apptId = Number(ar.appointment_id ?? 0);
      if (apptId <= 0) continue;
      const appt = await tenantSelect<RowDataPacket>({ slug, table: "appointments", columns: "id, status", where: "id = ?", params: [apptId], limit: 1 }).catch(() => [] as RowDataPacket[]);
      if (appt[0] && ["pending", "scheduled"].includes(String(appt[0].status ?? ""))) {
        await tenantUpdate({ slug, table: "appointments", id: apptId, values: { fidelity_gift_points_used: 0, fidelity_gift_idx: null } }).catch(() => 0);
      }
    }
    await dbExecute(`DELETE FROM ${quoteIdentifier(agiTable.name)} WHERE tenant_id = ? AND instance_id IN (${placeholders})`, [agiTable.tenantId ?? 0, ...instIds]).catch(() => undefined);
  }

  const tid = instTable.tenantId ?? 0;
  const delChild = async (table: string, whereSql: string, params: unknown[]) => {
    if (!(await tableExists((await tenantTable(slug, table)).name))) return;
    const t = await tenantTable(slug, table);
    await dbExecute(`DELETE FROM ${quoteIdentifier(t.name)} WHERE tenant_id = ? AND ${whereSql}`, [t.tenantId ?? 0, ...params]).catch(() => undefined);
  };
  await delChild("gift_transactions", `instance_id IN (SELECT id FROM ${quoteIdentifier(instTable.name)} WHERE gift_id = ?)`, [id]);
  await delChild("gift_progress_resets", "gift_id = ?", [id]);
  await delChild("gift_locations", "gift_id = ?", [id]);
  await delChild("gift_instances", "gift_id = ?", [id]);
  const rsTable = await tenantTable(slug, "gift_rule_sets");
  await delChild("gift_rules", `rule_set_id IN (SELECT id FROM ${quoteIdentifier(rsTable.name)} WHERE gift_id = ?)`, [id]);
  await delChild("gift_rule_sets", "gift_id = ?", [id]);

  try {
    const giftsTable = await tenantTable(slug, "gifts");
    await dbExecute(`DELETE FROM ${quoteIdentifier(giftsTable.name)} WHERE tenant_id = ? AND id = ?`, [tid, id]);
    return { ok: true, mode: "hard" };
  } catch {
    await tenantUpdate({ slug, table: "gifts", id, values: { deleted_at: new Date(), deleted_by: by > 0 ? by : null, active: 0 } }).catch(() => 0);
    return { ok: true, mode: "soft" };
  }
}

// ---------------------------------------------------------------------------
// GiftBox TEMPLATE editor (giftbox.php tab=boxes action=new|edit) — the box
// catalog the POS giftbox-sale issues instances from. A template is a `giftboxes`
// row plus its `giftbox_items` (services / products / custom voices with qty).
// Distinct from giftbox_instances (the issued GiftBoxes shown in the list).
// ---------------------------------------------------------------------------

export type GiftBoxTemplateItem = {
  itemType: "service" | "product" | "custom";
  serviceId: number;
  productId: number;
  qty: number;
  customLabel: string;
  customDetails: string;
};

export type GiftBoxTemplateRecord = {
  id: number;
  name: string;
  description: string;
  fidelityOnly: boolean;
  pointsCost: string;
  active: boolean;
  sortOrder: string;
  validFrom: string;
  validTo: string;
  items: GiftBoxTemplateItem[];
};

function normalizeGiftBoxItemType(value: unknown): GiftBoxTemplateItem["itemType"] {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "service" || v === "product" || v === "custom" ? v : "custom";
}

// Lightweight list of giftbox TEMPLATES (for the template grid). Port of
// GiftBox::listGiftBoxes(false): non-deleted boxes ordered by sort_order.
export async function listManageGiftBoxTemplates(slug: string): Promise<Array<{ id: number; name: string; active: boolean; pointsCost: number; itemsCount: number }>> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "giftboxes",
    where: "deleted_at IS NULL",
    orderBy: "sort_order ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  return Promise.all(rows.map(async (row) => {
    const id = Number(row.id ?? 0);
    const itemRows = await tenantSelect<RowDataPacket>({ slug, table: "giftbox_items", columns: "id", where: "giftbox_id = ?", params: [id] }).catch(() => [] as RowDataPacket[]);
    return {
      id,
      name: String(row.name ?? ""),
      active: Number(row.active ?? 0) === 1,
      pointsCost: roundMoney(Number(row.points_cost ?? 0)),
      itemsCount: itemRows.length,
    };
  }));
}

// Edit-form prefill: ONE giftbox template + its items. Port of GiftBox::getGiftBox.
export async function getManageGiftBoxTemplate(slug: string, id: number): Promise<GiftBoxTemplateRecord | null> {
  if (id <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftboxes", where: "id = ? AND deleted_at IS NULL", params: [id], limit: 1 });
  const gb = rows[0];
  if (!gb) return null;

  const itemRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "giftbox_items",
    where: "giftbox_id = ?",
    params: [id],
    orderBy: "sort_order ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);

  const items: GiftBoxTemplateItem[] = itemRows.map((row) => ({
    itemType: normalizeGiftBoxItemType(row.item_type),
    serviceId: Number(row.service_id ?? 0) || 0,
    productId: Number(row.product_id ?? 0) || 0,
    qty: Math.max(1, Number(row.qty ?? 1) || 1),
    customLabel: String(row.custom_label ?? ""),
    customDetails: String(row.custom_details ?? ""),
  }));

  return {
    id,
    name: String(gb.name ?? ""),
    description: String(gb.description ?? ""),
    fidelityOnly: String(gb.eligibility ?? "fidelity_only") === "fidelity_only",
    pointsCost: gb.points_cost != null ? String(roundMoney(Number(gb.points_cost ?? 0))) : "0",
    active: Number(gb.active ?? 0) === 1,
    sortOrder: gb.sort_order != null ? String(gb.sort_order) : "0",
    validFrom: gb.valid_from ? toIso(gb.valid_from).slice(0, 10) : "",
    validTo: gb.valid_to ? toIso(gb.valid_to).slice(0, 10) : "",
    items,
  };
}

// Create / update a giftbox template, faithful to giftbox.php POST(action=new|
// edit) / GiftBox::saveGiftBox: writes the giftboxes row and rebuilds its
// giftbox_items. Items are posted as a JSON string (items_json) because
// parseRequestBody flattens arrays. The advanced Fidelity targeting
// (eligible_levels_points) is NOT written here — see the form TODO.
export async function saveManageGiftBoxTemplate(slug: string, body: Record<string, string>, id: number): Promise<GiftBoxTemplateRecord> {
  const name = String(body.name ?? "").trim();
  if (name === "") throw new Error("Nome GiftBox obbligatorio.");

  const fidelityOnly = String(body.fidelity_only ?? "") === "1";
  const active = String(body.active ?? "") === "1";
  const pointsCost = roundMoney(Math.max(0, Number(String(body.points_cost ?? "0").replace(",", ".")) || 0));
  const sortOrder = Number.parseInt(String(body.sort_order ?? "0"), 10) || 0;
  const from = normalizeClientDate(body.valid_from);
  const to = normalizeClientDate(body.valid_to);
  if (String(body.valid_from ?? "").trim() !== "" && !from) throw new Error('Formato "Validità dal" non valido.');
  if (String(body.valid_to ?? "").trim() !== "" && !to) throw new Error('Formato "Validità al" non valido.');
  if (from && to && from > to) throw new Error('La data "Validità al" deve essere successiva a "Validità dal".');

  let items: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(String(body.items_json ?? "[]"));
    if (Array.isArray(parsed)) {
      items = parsed
        .map((it: Record<string, unknown>) => {
          const itemType = normalizeGiftBoxItemType(it.item_type);
          return {
            item_type: itemType,
            service_id: itemType === "service" ? Number(it.service_id ?? 0) || 0 : 0,
            product_id: itemType === "product" ? Number(it.product_id ?? 0) || 0 : 0,
            qty: Math.max(1, Number(it.qty ?? 1) || 1),
            custom_label: String(it.custom_label ?? ""),
            custom_details: String(it.custom_details ?? ""),
          };
        })
        .filter((it) =>
          it.item_type === "service" ? it.service_id > 0 :
          it.item_type === "product" ? it.product_id > 0 :
          String(it.custom_label).trim() !== "",
        );
    }
  } catch {
    items = [];
  }
  if (items.length === 0) throw new Error("Aggiungi almeno un contenuto alla GiftBox.");

  const values: Record<string, unknown> = {
    name,
    description: String(body.description ?? "").trim() || null,
    eligibility: fidelityOnly ? "fidelity_only" : "all_clients",
    points_cost: pointsCost,
    active: active ? 1 : 0,
    sort_order: sortOrder,
    valid_from: from,
    valid_to: to,
  };

  let giftboxId = id;
  if (giftboxId > 0) {
    const existing = await tenantSelect<RowDataPacket>({ slug, table: "giftboxes", columns: "id", where: "id = ? AND deleted_at IS NULL", params: [giftboxId], limit: 1 });
    if (!existing[0]) throw new Error("GiftBox non trovata.");
    await tenantUpdate({ slug, table: "giftboxes", id: giftboxId, values });
  } else {
    giftboxId = await tenantInsert(await tenantTable(slug, "giftboxes"), values);
  }

  // Rebuild giftbox_items.
  const itemTable = await tenantTable(slug, "giftbox_items");
  await dbExecute(
    `DELETE FROM ${quoteIdentifier(itemTable.name)} WHERE giftbox_id = ?${itemTable.mode === "shared" && (await columnExists(itemTable.name, "tenant_id")) ? " AND tenant_id = ?" : ""}`,
    itemTable.mode === "shared" && (await columnExists(itemTable.name, "tenant_id")) ? [giftboxId, itemTable.tenantId ?? 0] : [giftboxId],
  ).catch(() => undefined);
  let sort = 0;
  for (const item of items) {
    await tenantInsert(itemTable, {
      giftbox_id: giftboxId,
      item_type: String(item.item_type),
      service_id: Number(item.service_id ?? 0) || null,
      product_id: Number(item.product_id ?? 0) || null,
      qty: Number(item.qty ?? 1),
      custom_label: String(item.custom_label ?? "") || null,
      custom_details: String(item.custom_details ?? "") || null,
      sort_order: sort,
    }).catch(() => 0);
    sort += 1;
  }

  const saved = await getManageGiftBoxTemplate(slug, giftboxId);
  if (!saved) throw new Error("GiftBox non salvata.");
  return saved;
}

// Soft-delete a giftbox TEMPLATE (port of GiftBox::softDeleteGiftBox): set
// deleted_at + deleted_by + active=0 so it drops out of the catalog but any
// already-issued instances keep their snapshot. Idempotent.
export async function deleteManageGiftBoxTemplate(slug: string, id: number, by: number): Promise<{ ok: true }> {
  if (id <= 0) throw new Error("ID GiftBox mancante.");
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftboxes", columns: "id", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("GiftBox non trovata.");
  await tenantUpdate({ slug, table: "giftboxes", id, values: { deleted_at: new Date(), deleted_by: by > 0 ? by : null, active: 0 } });
  return { ok: true };
}

async function getSingleInstallmentPlan(slug: string, id: number): Promise<InstallmentPlan> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "sale_installment_plans", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Piano rateale non trovato.");
  return mapInstallmentPlan(slug, rows[0]);
}

async function mapInstallmentPlan(slug: string, row: RowDataPacket): Promise<InstallmentPlan> {
  const id = Number(row.id ?? 0);
  const installmentRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "sale_installments",
    where: "plan_id = ?",
    params: [id],
    orderBy: "installment_no ASC, id ASC",
  });
  const installments = installmentRows.map(mapInstallment);
  const today = todayIso();

  // Faithful port of SaleInstallments::hydratePlan() aggregates.
  const downPayment = roundMoney(Number(row.down_payment_amount ?? 0));
  let paidAmountTotal = 0;
  let cancelledPaidAmount = 0;
  let pendingAmount = 0;
  let paidCount = 0;
  let pendingCount = 0;
  let overdueCount = 0;
  let nextDueDate: string | undefined;
  let nextDueAmount = 0;

  for (const rowItem of installmentRows) {
    const rawStatus = String(rowItem.status ?? "pending").trim().toLowerCase();
    const dueDate = String(rowItem.due_date ?? "").slice(0, 10);
    const amount = roundMoney(Number(rowItem.amount ?? 0));
    const paidAmountRow = roundMoney(Number(rowItem.paid_amount ?? 0));
    const effectiveOverdue = rawStatus === "pending" && dueDate !== "" && dueDate < today;

    if (rawStatus === "paid") {
      paidCount += 1;
      paidAmountTotal += paidAmountRow > 0.00001 ? paidAmountRow : amount;
      continue;
    }
    if (rawStatus === "cancelled" || rawStatus === "canceled") {
      const paidAt = String(rowItem.paid_at ?? "").trim();
      if (paidAmountRow > 0.00001 || paidAt !== "") {
        cancelledPaidAmount += paidAmountRow > 0.00001 ? paidAmountRow : amount;
      }
      continue;
    }

    pendingCount += 1;
    pendingAmount += amount;
    if (effectiveOverdue) {
      overdueCount += 1;
    }
    if (nextDueDate === undefined || (dueDate !== "" && dueDate < nextDueDate)) {
      nextDueDate = dueDate;
      nextDueAmount = amount;
    }
  }

  const pendingAmountTotal = roundMoney(pendingAmount);
  const remaining = roundMoney(pendingAmountTotal);
  const collected = roundMoney(downPayment + roundMoney(paidAmountTotal) + roundMoney(cancelledPaidAmount));
  const total = roundMoney(Number(row.sale_total ?? row.financed_amount ?? 0));
  const paid = roundMoney(installments.filter((item) => item.status === "paid").reduce((sum, item) => sum + item.amount, 0));

  const rawPlanStatus = String(row.status ?? "active");
  const planMeta = planStatusMeta(rawPlanStatus, overdueCount, remaining);
  const intervalValue = Math.max(1, Number(row.interval_value ?? 1));
  const intervalUnit = String(row.interval_unit ?? "month").trim().toLowerCase();

  const sale = Number(row.sale_id ?? 0) > 0 ? await getSaleRow(slug, Number(row.sale_id ?? 0)) : null;
  const saleDate = sale?.sale_date ? String(sale.sale_date).slice(0, 10) : undefined;

  return {
    id,
    saleId: Number(row.sale_id ?? 0),
    saleDate,
    clientId: Number(row.client_id ?? 0),
    clientName: await appointmentClientName(slug, Number(row.client_id ?? 0)),
    total,
    paid,
    status: installmentPlanStatus(rawPlanStatus, total, paid, installments),
    statusLabel: planMeta.label,
    statusBadge: planMeta.badge,
    installments,
    paidCount,
    pendingCount,
    overdueCount,
    remaining,
    collected,
    nextDueDate: nextDueDate && nextDueDate !== "" ? nextDueDate : undefined,
    nextDueAmount: roundMoney(nextDueAmount),
    downPayment,
    paymentType: installmentPaymentTypeLabel(String(row.payment_type ?? "")),
    intervalLabel: installmentIntervalLabel(intervalUnit, intervalValue),
    notes: trimOrNull(row.notes) ?? undefined,
    cancelledReason: trimOrNull(row.cancelled_reason) ?? undefined,
    cancelledAt: row.cancelled_at ? toIso(row.cancelled_at) : undefined,
    createdAt: toIso(row.created_at),
  };
}

function mapInstallment(row: RowDataPacket): Installment {
  const rawStatus = String(row.status ?? "pending");
  const dueDate = String(row.due_date ?? todayIso()).slice(0, 10);
  const paidAmount = roundMoney(Number(row.paid_amount ?? 0));
  const meta = installmentStatusMeta(rawStatus, dueDate);
  return {
    id: Number(row.id ?? 0),
    installmentNo: Number(row.installment_no ?? 0),
    dueDate,
    amount: roundMoney(Number(row.amount ?? 0)),
    paidAmount: paidAmount > 0.00001 ? paidAmount : undefined,
    paymentType: trimOrNull(row.payment_type) ?? undefined,
    note: trimOrNull(row.note) ?? undefined,
    status: installmentStatus(rawStatus, dueDate),
    statusLabel: meta.label,
    statusBadge: meta.badge,
    paidAt: row.paid_at ? toIso(row.paid_at) : undefined,
  };
}

function installmentStatus(status: string, dueDate: string): InstallmentStatus {
  if (status === "paid") return "paid";
  if (status === "pending" && dueDate < todayIso()) return "overdue";
  return "due";
}

type StatusMeta = { key: string; label: string; badge: string };

// Faithful port of SaleInstallments::planStatusMeta() (~lines 1220-1226).
function planStatusMeta(status: string, overdueCount = 0, remainingAmount = 0): StatusMeta {
  const normalized = String(status ?? "").trim().toLowerCase();
  if (normalized === "cancelled" || normalized === "canceled") return { key: "cancelled", label: "Annullato", badge: "text-bg-secondary" };
  if (remainingAmount <= 0.00001) return { key: "completed", label: "Completato", badge: "text-bg-success" };
  if (overdueCount > 0) return { key: "overdue", label: "Scaduto", badge: "text-bg-danger" };
  return { key: "active", label: "Attivo", badge: "text-bg-primary" };
}

// Faithful port of SaleInstallments::installmentStatusMeta() (~lines 1228-1235),
// using the effective overdue rule (pending + due_date < today -> overdue).
function installmentStatusMeta(status: string, dueDate: string): StatusMeta {
  const normalized = String(status ?? "pending").trim().toLowerCase();
  if (normalized === "paid") return { key: "paid", label: "Pagata", badge: "text-bg-success" };
  if (normalized === "cancelled" || normalized === "canceled") return { key: "cancelled", label: "Annullata", badge: "text-bg-secondary" };
  const due = String(dueDate ?? "").slice(0, 10);
  if (due !== "" && due < todayIso()) return { key: "overdue", label: "Scaduta", badge: "text-bg-danger" };
  return { key: "pending", label: "Da incassare", badge: "text-bg-warning" };
}

// Port of SaleInstallments::paymentTypeLabel() + normalizePaymentType() (~lines 240-278).
function installmentPaymentTypeLabel(raw: string): string {
  const v = String(raw ?? "").trim().toLowerCase();
  if (["cash", "contanti"].includes(v)) return "Contanti";
  if (["card", "carta", "carta_credito", "carta di credito", "carta-di-credito"].includes(v)) return "Carta di Credito";
  if (["check", "assegno"].includes(v)) return "Assegno";
  if (["bank", "bank_transfer", "bank transfer", "bonifico", "bonifico bancario", "wire", "transfer"].includes(v)) return "Bonifico";
  return "";
}

// Port of SaleInstallments::intervalLabel() (~lines 288-294).
function installmentIntervalLabel(unit: string, value: number): string {
  const u = String(unit ?? "").trim().toLowerCase();
  const v = Math.max(1, Number(value ?? 1));
  if (u === "day") return `${v} ${v === 1 ? "giorno" : "giorni"}`;
  if (u === "week") return `${v} ${v === 1 ? "settimana" : "settimane"}`;
  return `${v} ${v === 1 ? "mese" : "mesi"}`;
}

function installmentPlanStatus(status: string, total: number, paid: number, installments: Installment[]): InstallmentPlanStatus {
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "completed" || paid + 0.00001 >= total || installments.every((item) => item.status === "paid")) return "completed";
  return "active";
}

function mapCommission(row: RowDataPacket): CommissionEntry {
  return {
    id: Number(row.id ?? 0),
    staffName: String(row.operator_name ?? row.staff_name ?? `Operatore #${row.staff_id ?? 0}`),
    saleId: String(row.source_group ?? "") === "sale" || String(row.source_reference ?? "").includes("sale") ? Number(row.source_id ?? 0) || undefined : undefined,
    appointmentId: String(row.source_group ?? "") === "appointment" ? Number(row.source_id ?? 0) || undefined : undefined,
    baseAmount: roundMoney(Number(row.base_amount ?? 0)),
    rate: roundMoney(Number(row.percent_value ?? 0)),
    amount: roundMoney(Number(row.commission_amount ?? 0)),
    status: commissionStatus(row),
    createdAt: toIso(row.movement_datetime ?? row.created_at),
    paidAt: row.paid_at ? toIso(row.paid_at) : undefined,
  };
}

function commissionStatus(row: RowDataPacket): CommissionStatus {
  const entryStatus = String(row.entry_status ?? "active");
  if (entryStatus === "cancelled" || entryStatus === "reversed") return "reversed";
  if (Number(row.is_paid ?? 0) === 1) return "paid";
  return "open";
}

function automationFieldForId(id: number): string | null {
  if (id === 1) return "reminder_enabled";
  if (id === 2) return "sms_reminder_enabled";
  if (id === 3) return "approved_enabled";
  if (id === 4) return "fidelity_expiry_reminder_enabled";
  return null;
}

async function getSaleRow(slug: string, saleId: number): Promise<RowDataPacket | null> {
  if (saleId <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "sales", where: "id = ?", params: [saleId], limit: 1 });
  return rows[0] ?? null;
}

async function serviceNameById(slug: string, serviceId: number, fallback: string): Promise<string> {
  if (serviceId <= 0) return fallback;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "name", where: "id = ?", params: [serviceId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  return String(rows[0]?.name ?? fallback);
}

type ConfigDef = {
  title: string;
  source?: string;
  table: string;
  titleColumn: string;
  detailColumns?: string[];
  valueColumn?: string;
  activeColumn?: string;
  where?: string;
  orderBy?: string;
  limit?: number;
};

const configDefinitions: Record<string, ConfigDef> = {
  cost_categories: {
    title: "Categorie costi",
    table: "cost_categories",
    titleColumn: "name",
    valueColumn: "color",
    activeColumn: "is_active",
    orderBy: "name ASC",
  },
  product_categories: {
    title: "Categorie prodotti",
    table: "product_categories",
    titleColumn: "name",
    valueColumn: "created_at",
    orderBy: "name ASC",
  },
  stock_moves: {
    title: "Carico / Scarico",
    table: "stock_moves",
    titleColumn: "cause",
    detailColumns: ["document_type", "document_number", "operator_name"],
    valueColumn: "qty",
    orderBy: "move_date DESC, id DESC",
  },
  suppliers: {
    title: "Fornitori",
    table: "suppliers",
    titleColumn: "name",
    detailColumns: ["business_name", "email", "city"],
    valueColumn: "phone",
    activeColumn: "is_active",
    orderBy: "name ASC",
  },
  client_sheets: {
    title: "Schede cliente",
    table: "client_sheet_templates",
    titleColumn: "title",
    detailColumns: ["description", "slug"],
    valueColumn: "fields_json",
    activeColumn: "is_active",
    where: "deleted_at IS NULL",
    orderBy: "title ASC",
  },
  client_sheet_templates: {
    title: "Template schede",
    table: "client_sheet_presets",
    titleColumn: "name",
    detailColumns: ["category", "slug"],
    valueColumn: "fields_json",
    activeColumn: "is_active",
    orderBy: "sort_order ASC, name ASC",
  },
  client_consents: {
    title: "Consensi cliente",
    table: "consent_modules",
    titleColumn: "name",
    detailColumns: ["type", "slug"],
    valueColumn: "footer_mode",
    activeColumn: "is_active",
    orderBy: "sort_order ASC, name ASC",
  },
  consent_modules: {
    title: "Moduli consenso",
    table: "consent_modules",
    titleColumn: "name",
    detailColumns: ["type", "slug"],
    valueColumn: "footer_mode",
    activeColumn: "is_active",
    orderBy: "sort_order ASC, name ASC",
  },
  resources: {
    title: "Risorse",
    table: "resources",
    titleColumn: "name",
    detailColumns: ["description"],
    valueColumn: "qty_total",
    orderBy: "name ASC",
  },
  service_categories: {
    title: "Categorie servizi",
    table: "service_categories",
    titleColumn: "name",
    detailColumns: ["image_url"],
    valueColumn: "sort_order",
    orderBy: "sort_order ASC, name ASC",
  },
  service_recommendations: {
    title: "Servizi consigliati",
    table: "service_recommendations",
    titleColumn: "service_id",
    detailColumns: ["recommended_service_id"],
    valueColumn: "sort_order",
    orderBy: "sort_order ASC",
  },
  cabins: {
    title: "Cabine",
    table: "cabins",
    titleColumn: "name",
    detailColumns: ["location_id"],
    valueColumn: "position",
    activeColumn: "is_active",
    orderBy: "position ASC, name ASC",
  },
  staff: {
    title: "Operatori",
    table: "staff",
    titleColumn: "full_name",
    detailColumns: ["email", "phone"],
    valueColumn: "calendar_color",
    activeColumn: "is_active",
    orderBy: "full_name ASC",
  },
  staff_availability: {
    title: "Disponibilita",
    table: "staff_availability",
    titleColumn: "kind",
    detailColumns: ["staff_id", "starts_at", "ends_at"],
    valueColumn: "location_id",
    orderBy: "starts_at DESC, id DESC",
  },
  locations: {
    title: "Sedi",
    table: "locations",
    titleColumn: "name",
    detailColumns: ["address", "email", "phone"],
    valueColumn: "booking_enabled",
    activeColumn: "is_active",
    orderBy: "sort_order ASC, name ASC",
  },
  marketplace: {
    title: "Marketplace",
    table: "marketplace_activity_categories",
    titleColumn: "name",
    detailColumns: ["slug", "icon_key"],
    valueColumn: "sort_order",
    activeColumn: "is_active",
    orderBy: "sort_order ASC, name ASC",
  },
};

async function quoteSettingsConfig(slug: string): Promise<ConfigModuleState> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 });
  const row = rows[0] ?? {};
  return configStateFromRows("quote_settings", "Impostazioni preventivi", "quote_settings.php", [
    configRecord("quote_settings", 1, "Intestazione", String(row.quote_company_name ?? row.name ?? "Attivita"), String(row.quote_email ?? row.email ?? ""), true, row.created_at),
    configRecord("quote_settings", 2, "Dati fiscali", [row.quote_vat_number, row.quote_tax_code, row.quote_sdi].filter(Boolean).join(" / ") || "-", String(row.quote_city ?? ""), true, row.created_at),
    configRecord("quote_settings", 3, "Footer preventivo", String(row.quote_footer ?? ""), String(row.quote_terms ?? ""), true, row.created_at),
    configRecord("quote_settings", 4, "Metodi pagamento", String(row.payment_methods ?? ""), "Configurazione preventivi", true, row.created_at),
  ]);
}

async function posSettingsConfig(slug: string): Promise<ConfigModuleState> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "pos_settings", orderBy: "id ASC", limit: 1 });
  const row = rows[0] ?? {};
  return configStateFromRows("pos_settings", "Impostazioni POS", "pos_settings.php", [
    configRecord("pos_settings", 1, "Scadenza preordini", `${row.preorders_expiry_value ?? 0} ${row.preorders_expiry_unit ?? "days"}`, Number(row.preorders_expiry_enabled ?? 0) === 1 ? "Attiva" : "Disattiva", Number(row.preorders_expiry_enabled ?? 0) === 1, row.updated_at),
    configRecord("pos_settings", 2, "Scadenza prepagati", `${row.prepaids_expiry_value ?? 0} ${row.prepaids_expiry_unit ?? "days"}`, Number(row.prepaids_expiry_enabled ?? 0) === 1 ? "Attiva" : "Disattiva", Number(row.prepaids_expiry_enabled ?? 0) === 1, row.updated_at),
  ]);
}

async function businessProfileConfig(slug: string): Promise<ConfigModuleState> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 });
  const row = rows[0] ?? {};
  return configStateFromRows("business_profile", "Profilo attivita", "business_profile.php", [
    configRecord("business_profile", 1, String(row.name ?? "Attivita"), String(row.booking_about_text ?? ""), String(row.website ?? ""), true, row.created_at),
    configRecord("business_profile", 2, "Contatti", [row.email, row.phone].filter(Boolean).join(" / "), String(row.address ?? ""), true, row.created_at),
    configRecord("business_profile", 3, "Booking staff", "Scelta operatore nel booking", Number(row.booking_choose_staff_enabled ?? 0) === 1 ? "Attiva" : "Disattiva", Number(row.booking_choose_staff_enabled ?? 0) === 1, row.created_at),
    configRecord("business_profile", 4, "Prodotti booking", "Prodotti vendibili nel booking", Number(row.booking_products_enabled ?? 0) === 1 ? "Attivi" : "Disattivi", Number(row.booking_products_enabled ?? 0) === 1, row.created_at),
  ]);
}

async function packageSettingsConfig(slug: string): Promise<ConfigModuleState> {
  const [businessRows, packageRows] = await Promise.all([
    tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 }),
    tenantSelect<RowDataPacket>({ slug, table: "packages", orderBy: "name ASC", limit: 200 }),
  ]);
  const row = businessRows[0] ?? {};
  const activePackages = packageRows.filter((item) => Number(item.is_active ?? 1) === 1).length;
  return configStateFromRows("package_settings", "Impostazioni pacchetti", "packages.php?tab=settings", [
    configRecord("package_settings", 1, "Validita predefinita", `${row.package_default_validity_value ?? 0} ${row.package_default_validity_unit ?? "days"}`, "Default vendita", true, row.created_at),
    configRecord("package_settings", 2, "Catalogo pacchetti", `${packageRows.length} pacchetti configurati`, `${activePackages} attivi`, activePackages > 0, row.created_at),
  ]);
}

async function fidelityMembershipConfig(slug: string): Promise<ConfigModuleState> {
  const [businessRows, cardRows] = await Promise.all([
    tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 }),
    tenantSelect<RowDataPacket>({ slug, table: "cards", orderBy: "created_at DESC, id DESC", limit: 200 }),
  ]);
  const row = businessRows[0] ?? {};
  const enabled = Number(row.fidelity_enabled ?? 0) === 1;
  const activeCards = cardRows.filter((item) => String(item.status ?? "active") === "active").length;
  return configStateFromRows("fidelity_membership", "Adesione", "fidelity_membership.php", [
    configRecord("fidelity_membership", 1, "Programma fidelity", enabled ? "Fidelity abilitata" : "Fidelity disabilitata", enabled ? "Attivo" : "Disattivo", enabled, row.created_at),
    configRecord("fidelity_membership", 2, "Regole adesione", String(row.fidelity_adhesion_json ?? ""), row.fidelity_adhesion_json ? "Configurate" : "Da configurare", enabled, row.created_at),
    configRecord("fidelity_membership", 3, "Tessere clienti", `${cardRows.length} tessere emesse`, `${activeCards} attive`, activeCards > 0, row.created_at),
  ]);
}

async function fidelityLevelsConfig(slug: string): Promise<ConfigModuleState> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 });
  const row = rows[0] ?? {};
  const enabled = Number(row.fidelity_levels_enabled ?? 0) === 1;
  return configStateFromRows("fidelity_levels", "Livelli Card", "fidelity_points.php#livelli-card", [
    configRecord("fidelity_levels", 1, "Livelli card", String(row.fidelity_card_levels_json ?? ""), enabled ? "Attivi" : "Disattivi", enabled, row.created_at),
    configRecord("fidelity_levels", 2, "Soglia Silver", `${row.fidelity_silver_threshold ?? 0} punti`, "Silver", enabled, row.created_at),
    configRecord("fidelity_levels", 3, "Soglia Gold", `${row.fidelity_gold_threshold ?? 0} punti`, "Gold", enabled, row.created_at),
    configRecord("fidelity_levels", 4, "Periodo livello", `${row.fidelity_level_period_days ?? 365} giorni`, "Validita calcolo", enabled, row.created_at),
  ]);
}

async function giftboxSettingsConfig(slug: string): Promise<ConfigModuleState> {
  const [businessRows, giftboxRows] = await Promise.all([
    tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 }),
    tenantSelect<RowDataPacket>({ slug, table: "giftboxes", where: "deleted_at IS NULL", orderBy: "sort_order ASC, name ASC", limit: 200 }),
  ]);
  const row = businessRows[0] ?? {};
  const activeGiftboxes = giftboxRows.filter((item) => Number(item.active ?? 1) === 1).length;
  return configStateFromRows("giftbox_settings", "Impostazioni GiftBox", "giftbox_settings.php", [
    configRecord("giftbox_settings", 1, "Validita predefinita", `${row.giftbox_default_validity_value ?? 0} ${row.giftbox_default_validity_unit ?? "days"}`, "Default emissione", true, row.created_at),
    configRecord("giftbox_settings", 2, "Termini GiftBox", String(row.giftbox_terms ?? ""), row.giftbox_terms ? "Configurati" : "Da configurare", true, row.created_at),
    configRecord("giftbox_settings", 3, "Catalogo GiftBox", `${giftboxRows.length} template`, `${activeGiftboxes} attivi`, activeGiftboxes > 0, row.created_at),
  ]);
}

async function giftcardSettingsConfig(slug: string): Promise<ConfigModuleState> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 });
  const row = rows[0] ?? {};
  return configStateFromRows("giftcard_settings", "Impostazioni GiftCard", "giftcard_settings.php", [
    configRecord("giftcard_settings", 1, "Validita predefinita", `${row.giftcard_default_validity_value ?? 0} ${row.giftcard_default_validity_unit ?? "days"}`, "Default emissione", true, row.created_at),
    configRecord("giftcard_settings", 2, "Termini GiftCard", String(row.giftcard_terms ?? ""), row.giftcard_terms ? "Configurati" : "Da configurare", true, row.created_at),
    configRecord("giftcard_settings", 3, "Voucher pubblico", "Token pubblico, importo nascosto e invio email", "Gestito da giftcard.php", true, row.created_at),
  ]);
}

async function hoursConfig(slug: string): Promise<ConfigModuleState> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "business_hours", orderBy: "location_id ASC, dow ASC, id ASC" });
  const records = rows.map((row, index) => configRecord(
    "hours",
    Number(row.id ?? index + 1),
    `Giorno ${row.dow ?? ""} - sede ${row.location_id ?? "default"}`,
    Number(row.is_closed ?? 0) === 1 ? "Chiuso" : [row.opens, row.closes, row.opens2, row.closes2].filter(Boolean).join(" / "),
    Number(row.is_closed ?? 0) === 1 ? "Chiuso" : "Aperto",
    Number(row.is_closed ?? 0) !== 1,
    new Date(),
  ));
  return configStateFromRows("hours", "Orari", "hours.php", records);
}

async function rolesConfig(slug: string): Promise<ConfigModuleState> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "role_permissions", orderBy: "role ASC, perm ASC" });
  const grouped = new Map<string, number>();
  rows.forEach((row) => grouped.set(String(row.role ?? "ruolo"), (grouped.get(String(row.role ?? "ruolo")) ?? 0) + 1));
  const records = Array.from(grouped.entries()).map(([role, count], index) => configRecord("roles", index + 1, role, `${count} permessi`, "Configurato", true, new Date()));
  return configStateFromRows("roles", "Ruoli", "roles.php", records);
}

async function accessibilityConfig(slug: string): Promise<ConfigModuleState> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "users", orderBy: "email ASC" });
  const records = rows.map((row, index) => configRecord(
    "accessibility",
    Number(row.id ?? index + 1),
    String(row.email ?? "Utente"),
    String(row.role ?? ""),
    row.email_verified_at ? "Verificata" : "Da verificare",
    Boolean(row.email_verified_at),
    row.created_at,
  ));
  return configStateFromRows("accessibility", "Accessibilita", "accessibility.php", records);
}

function configStateFromRows(id: string, title: string, source: string | undefined, records: ConfigRecord[]): ConfigModuleState {
  return {
    id,
    title,
    source,
    records,
    settings: { sourceMode: "database" },
    updatedAt: new Date().toISOString(),
  };
}

function configRecordFromRow(moduleId: string, row: RowDataPacket, def: ConfigDef, index: number): ConfigRecord {
  const id = Number(row.id ?? index + 1);
  const detail = (def.detailColumns ?? [])
    .map((column) => String(row[column] ?? "").trim())
    .filter(Boolean)
    .join(" / ");
  const active = def.activeColumn ? Number(row[def.activeColumn] ?? 1) === 1 : true;
  return configRecord(
    moduleId,
    id,
    String(row[def.titleColumn] ?? `${def.title} #${id}`),
    detail || def.title,
    def.valueColumn ? String(row[def.valueColumn] ?? "") : active ? "Attivo" : "Disattivo",
    active,
    row.updated_at ?? row.created_at,
  );
}

function configRecord(moduleId: string, id: number, title: string, detail: string, value: string, active: boolean, updatedAt: unknown): ConfigRecord {
  return {
    id,
    module: moduleId,
    title: title || `${moduleId} #${id}`,
    detail,
    value,
    active,
    updatedAt: toIso(updatedAt),
  };
}

function normalizeConfigModuleId(moduleId: string): string {
  return (moduleId || "custom").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function mapLocation(slug: string, row: RowDataPacket): Location {
  const id = Number(row.id ?? 0);
  const name = String(row.name ?? `Sede ${id}`);
  return {
    id,
    tenantSlug: slug,
    slug: `${slug}-${slugSegment(name)}-${id}`,
    name,
    address: String(row.address ?? row.legal_address ?? ""),
    city: String(row.legal_city ?? ""),
    area: String(row.legal_province ?? row.legal_region ?? ""),
    phone: String(row.phone ?? row.legal_phone ?? ""),
    hoursToday: "Orari configurati",
    bookingEnabled: Number(row.booking_enabled ?? 0) === 1,
    marketplaceEnabled: Number(row.marketplace_enabled ?? 0) === 1,
  };
}

async function mapSale(slug: string, row: RowDataPacket): Promise<PosSale> {
  const id = Number(row.id ?? 0);
  const items = await saleItems(slug, id);
  const total = Number(row.total ?? 0);
  const clientName = await appointmentClientName(slug, Number(row.client_id ?? 0));
  const status = String(row.status ?? "active") === "cancelled" ? "cancelled" : "active";

  return {
    id,
    code: `S-${String(id).padStart(5, "0")}`,
    clientId: Number(row.client_id ?? 0),
    clientName,
    appointmentId: undefined,
    locationId: Number(row.location_id ?? 0),
    operatorName: String(row.operator_name ?? "").trim(),
    items,
    payments: [{ id: 1, method: "card", amount: total }],
    subtotal: Number(row.subtotal ?? total),
    discount: Number(row.discount ?? 0),
    total,
    paidAmount: total,
    changeDue: 0,
    status,
    createdAt: toIso(row.sale_date ?? row.created_at),
    cancelledAt: row.cancelled_at ? toIso(row.cancelled_at) : undefined,
    cancelReason: row.cancelled_reason ? String(row.cancelled_reason) : undefined,
  };
}

async function saleItems(slug: string, saleId: number): Promise<PosSaleItem[]> {
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "sale_items",
      where: "sale_id = ?",
      params: [saleId],
      orderBy: "id ASC",
    });
    return rows.map((row) => {
      const itemType = String(row.item_type ?? "");
      return {
        id: Number(row.id ?? 0),
        type: itemType === "product" ? "product" : itemType === "giftcard" ? "giftcard" : itemType === "prepaid" ? "prepaid" : "service",
        refId: Number(row.item_id ?? 0),
        name: String(row.item_name ?? "Voce"),
        quantity: Number(row.qty ?? 1),
        unitPrice: Number(row.unit_price ?? 0),
        total: Number(row.line_total ?? 0),
        status: String(row.item_status ?? "") === "ordered" ? "ordered" : itemType === "product" ? "collected" : "executed",
      } satisfies PosSaleItem;
    });
  } catch {
    return [];
  }
}

async function resolveSaleClientForDb(slug: string, clientId: number, clientName?: string): Promise<{ id: number; name: string }> {
  if (clientId > 0) {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "id,full_name", where: "id = ?", params: [clientId], limit: 1 });
    if (rows[0]) return { id: Number(rows[0].id), name: String(rows[0].full_name ?? "Cliente") };
  }
  const name = normalizeName(clientName, "Cliente banco");
  if (name === "Cliente banco") return { id: 0, name };
  const created = await createDbClient({ name }, slug);
  return { id: created.id, name: created.name };
}

async function buildDbSaleItem(slug: string, input: PosCheckoutInput["items"][number], id: number): Promise<PosSaleItem> {
  const quantity = Math.max(1, Math.round(input.quantity ?? 1));
  const refId = input.refId && input.refId > 0 ? input.refId : 0;
  if (input.type === "service") {
    const service = refId > 0 ? await getSingleService(slug, refId) : null;
    const unitPrice = roundMoney(input.unitPrice ?? parseMoney(service?.price ?? "0", 0));
    return {
      id,
      type: "service",
      refId: service?.id ?? refId,
      name: input.name?.trim() || service?.name || "Servizio",
      quantity,
      unitPrice,
      total: roundMoney(unitPrice * quantity),
      status: input.status ?? "executed",
    };
  }
  if (input.type === "product") {
    const product = refId > 0 ? await getSingleProduct(slug, refId) : null;
    const unitPrice = roundMoney(input.unitPrice ?? parseMoney(product?.price ?? "0", 0));
    return {
      id,
      type: "product",
      refId: product?.id ?? refId,
      name: input.name?.trim() || product?.name || "Prodotto",
      quantity,
      unitPrice,
      total: roundMoney(unitPrice * quantity),
      status: input.status ?? "collected",
    };
  }
  const unitPrice = roundMoney(input.unitPrice ?? 0);
  return {
    id,
    type: input.type,
    refId,
    name: input.name?.trim() || (input.type === "giftcard" ? "GiftCard" : input.type === "package" ? "Pacchetto" : input.type === "giftbox" ? "GiftBox" : "Prepagato"),
    quantity,
    unitPrice,
    total: roundMoney(unitPrice * quantity),
    status: input.status ?? "prepaid",
  };
}

async function decrementProductStock(slug: string, productId: number, quantity: number): Promise<void> {
  const product = await getSingleProduct(slug, productId);
  const nextStock = product.stock - quantity;
  if (nextStock < 0) throw new Error(`Giacenza insufficiente per ${product.name}.`);
  await tenantUpdate({ slug, table: "products", id: productId, values: { stock: nextStock } });
}

async function incrementProductStock(slug: string, productId: number, quantity: number): Promise<void> {
  const product = await getSingleProduct(slug, productId);
  await tenantUpdate({ slug, table: "products", id: productId, values: { stock: product.stock + quantity } });
}

async function issueDbPrepaidFromSale({ slug, saleId, saleItemId, clientId, item }: { slug: string; saleId: number; saleItemId: number; clientId: number; item: PosSaleItem }): Promise<void> {
  try {
    const service = item.refId > 0 ? await getSingleService(slug, item.refId) : null;
    await tenantInsert(await tenantTable(slug, "client_prepaid_services"), {
      client_id: clientId,
      sale_id: saleId,
      sale_item_id: saleItemId,
      service_id: service?.id ?? item.refId,
      service_name: service?.name ?? item.name,
      purchased_qty: item.quantity,
      remaining_qty: item.quantity,
      unit_price: item.unitPrice,
      total_paid: item.total,
      status: "active",
    });
  } catch {
    // Optional module/table can be absent in older installs.
  }
}

async function issueDbPackageFromSale({ slug, saleId, clientId, item }: { slug: string; saleId: number; clientId: number; item: PosSaleItem }): Promise<void> {
  try {
    await tenantInsert(await tenantTable(slug, "client_packages"), {
      client_id: clientId,
      package_id: item.refId > 0 ? item.refId : null,
      package_name: item.name,
      purchase_date: todayIso(),
      start_date: todayIso(),
      sessions_total: item.quantity,
      sessions_remaining: item.quantity,
      status: "active",
      sale_id: saleId,
    });
  } catch {
    // Optional module/table can be absent in older installs.
  }
}

async function issueDbGiftCardFromSale({ slug, clientId, recipientName, amount, locationId }: { slug: string; clientId: number; recipientName: string; amount: number; locationId: number | null }): Promise<void> {
  try {
    const code = `GC${Date.now().toString(36).toUpperCase().slice(-8)}`;
    const giftCardId = await tenantInsert(await tenantTable(slug, "giftcards"), {
      code,
      client_id: clientId,
      recipient_name: recipientName,
      initial_amount: amount,
      balance: amount,
      status: "active",
      issued_at: new Date(),
      expires_at: addDaysDate(365),
      location_id: locationId,
    });
    await tenantInsert(await tenantTable(slug, "giftcard_transactions"), {
      giftcard_id: giftCardId,
      type: "issue",
      amount,
      note: "Emissione da vendita Next",
      created_at: new Date(),
      location_id: locationId,
    });
  } catch {
    // Optional module/table can be absent in older installs.
  }
}

async function createDbInstallmentPlanFromSale({ slug, saleId, clientId, total, count }: { slug: string; saleId: number; clientId: number; total: number; count: number }): Promise<void> {
  try {
    const installmentCount = Math.max(1, Math.round(count));
    const amount = roundMoney(total / installmentCount);
    const planId = await tenantInsert(await tenantTable(slug, "sale_installment_plans"), {
      sale_id: saleId,
      client_id: clientId,
      payment_type: "card",
      status: "active",
      sale_total: total,
      down_payment_amount: 0,
      financed_amount: total,
      installments_count: installmentCount,
      interval_value: 1,
      interval_unit: "month",
      first_due_date: addDaysDate(30),
      last_due_date: addDaysDate(30 * installmentCount),
      config_json: JSON.stringify({ source: "next" }),
    });
    for (let index = 0; index < installmentCount; index += 1) {
      await tenantInsert(await tenantTable(slug, "sale_installments"), {
        plan_id: planId,
        sale_id: saleId,
        client_id: clientId,
        installment_no: index + 1,
        due_date: addDaysDate(30 * (index + 1)),
        amount: index === installmentCount - 1 ? roundMoney(total - amount * (installmentCount - 1)) : amount,
        status: "pending",
        payment_type: "card",
      });
    }
  } catch {
    // Optional module/table can be absent in older installs.
  }
}

async function cancelDbSaleResidues(slug: string, saleId: number): Promise<void> {
  await tenantUpdateBySaleId(slug, "client_prepaid_services", saleId, { status: "cancelled", canceled_at: new Date() });
  await tenantUpdateBySaleId(slug, "client_packages", saleId, { status: "cancelled" });
  await tenantUpdateBySaleId(slug, "sale_installment_plans", saleId, { status: "cancelled", cancelled_at: new Date(), cancelled_reason: "Vendita annullata" });
  await tenantUpdateBySaleId(slug, "sale_installments", saleId, { status: "cancelled", note: "Vendita annullata" });
}

async function tenantUpdateBySaleId(slug: string, table: string, saleId: number, values: Record<string, unknown>): Promise<void> {
  try {
    const rows = await tenantSelect<RowDataPacket>({ slug, table, columns: "id", where: "sale_id = ?", params: [saleId] });
    for (const row of rows) {
      await tenantUpdate({ slug, table, id: Number(row.id), values });
    }
  } catch {
    // Optional module/table can be absent in older installs.
  }
}

async function mapCost(slug: string, row: RowDataPacket): Promise<CostItem> {
  const paid = Number(row.is_paid ?? 0) === 1;
  const dueDate = String(row.due_date ?? todayIso()).slice(0, 10);
  return {
    id: Number(row.id ?? 0),
    title: String(row.title ?? "Costo"),
    category: await costCategoryName(slug, Number(row.category_id ?? 0)),
    supplier: row.supplier_id ? `Fornitore #${row.supplier_id}` : "-",
    amount: Number(row.amount ?? 0),
    dueDate,
    recurrence: Number(row.is_recurring ?? 0) === 1 ? recurrenceFromDb(String(row.recurrence_unit ?? "")) : "none",
    locationId: Number(row.location_id ?? 0),
    status: paid ? "paid" : dueDate < todayIso() ? "overdue" : "open",
    paidAt: row.paid_at ? toIso(row.paid_at) : undefined,
    createdAt: toIso(row.created_at),
  };
}

async function costCategoryName(slug: string, categoryId: number): Promise<string> {
  if (categoryId <= 0) return "Generale";
  try {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "cost_categories", columns: "name", where: "id = ?", params: [categoryId], limit: 1 });
    return String(rows[0]?.name ?? "Generale");
  } catch {
    return "Generale";
  }
}

function recurrenceFromDb(unit: string): CostItem["recurrence"] {
  if (unit === "month" || unit === "months" || unit === "monthly") return "monthly";
  if (unit === "year" || unit === "years" || unit === "yearly") return "yearly";
  return "none";
}

async function mapQuote(slug: string, row: RowDataPacket): Promise<Quote> {
  const id = Number(row.id ?? 0);
  const lines = await quoteLines(slug, id);
  const status = quoteStatus(String(row.status ?? "draft"));
  return {
    id,
    code: String(row.number ?? `Q-${String(id).padStart(5, "0")}`),
    clientId: Number(row.client_id ?? 0),
    clientName: String(row.client_name ?? row.client_company_name ?? "Cliente"),
    lines,
    subtotal: Number(row.subtotal ?? 0),
    discount: Number(row.discount_total ?? 0),
    total: Number(row.total ?? 0),
    status,
    publicToken: String(row.public_token ?? ""),
    expiresAt: String(row.valid_until ?? "").slice(0, 10) || todayIso(),
    acceptedAt: row.customer_decision_at ? toIso(row.customer_decision_at) : undefined,
    convertedSaleId: Number(row.converted_sale_id ?? 0) || undefined,
    createdAt: toIso(row.created_at),
  };
}

async function quoteLines(slug: string, quoteId: number): Promise<QuoteLine[]> {
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "quote_items",
      where: "quote_id = ?",
      params: [quoteId],
      orderBy: "position ASC, id ASC",
    });
    return rows.map((row) => ({
      id: Number(row.id ?? 0),
      type: String(row.item_type ?? "") === "product" ? "product" : "service",
      refId: Number(row.item_id ?? 0),
      name: String(row.description ?? "Voce"),
      quantity: Number(row.qty ?? 1),
      unitPrice: Number(row.unit_price ?? 0),
      total: Number(row.line_total ?? 0),
    }));
  } catch {
    return [];
  }
}

function quoteStatus(status: string): QuoteStatus {
  if (status === "sent") return "sent";
  if (status === "accepted") return "accepted";
  if (status === "converted") return "converted";
  if (status === "rejected" || status === "declined") return "rejected";
  return "draft";
}

async function mapAppointment(slug: string, row: RowDataPacket): Promise<AppointmentWithMeta> {
  const appointmentId = Number(row.id ?? 0);
  const clientName = await appointmentClientName(slug, Number(row.client_id ?? 0));
  // Full ordered service list (one per appointment_services row) for the multi-service
  // parent/child rendering. The primary (first) line drives the existing single-line
  // `service`/`price` summary so the row is unchanged for single-service appointments.
  const serviceLines = await appointmentServiceLines(slug, row);
  const primary = serviceLines[0] ?? { serviceId: 0, name: "Servizio", price: 0 };
  const staffName = await appointmentStaffName(slug, appointmentId);
  const startsAt = toDate(row.starts_at);
  // End time HH:MM (additive) so the calendar can render a block at its real
  // persisted duration; null/missing ends_at leaves it undefined (the grid then
  // falls back to its default block height).
  const endsAt = row.ends_at === null || row.ends_at === undefined ? null : toDate(row.ends_at);

  return {
    id: appointmentId,
    date: dateIsoLocal(startsAt),
    locationId: row.location_id === null || row.location_id === undefined ? null : Number(row.location_id),
    time: timeLocal(startsAt),
    endTime: endsAt ? timeLocal(endsAt) : undefined,
    client: clientName,
    service: primary.name,
    operator: staffName,
    room: row.cabin_id ? `Cabina #${row.cabin_id}` : "-",
    price: `${roundMoney(primary.price)} euro`,
    status: uiStatus(String(row.status ?? "")),
    // The true 5-state status code (the calendar uses it for the canceled/no_show pill;
    // `status` above is the collapsed 3-state UI label).
    statusCode: phpStatus(String(row.status ?? "")),
    // Real booking code when the column exists + is populated; null -> the list falls
    // back to #id. The column is read straight off the appointments row (selected by
    // tenantSelect '*'), so no extra query is needed; guarded via the row property.
    publicCode: row.public_code === null || row.public_code === undefined || String(row.public_code).trim() === ""
      ? null
      : String(row.public_code).trim(),
    // Ordered service lines for the multi-service grouping (parent + child rows).
    services: serviceLines.map((line) => ({ serviceId: line.serviceId, name: line.name, price: `${roundMoney(line.price)} euro`, segmentId: line.segmentId ?? null })),
    // Per-operator segments for the Day calendar (only when >1 distinct operator).
    segments: await appointmentSegmentsForCalendar(slug, appointmentId),
  };
}

// Per-service segments (appointment_segments) with resolved staff names, exposed on
// the calendar payload ONLY when the appointment spans MORE THAN ONE operator — the
// Day view then renders one block per segment in the right staff column (legacy
// per-segment events). Single-operator appointments return undefined (one block).
async function appointmentSegmentsForCalendar(
  slug: string,
  appointmentId: number,
): Promise<AppointmentWithMeta["segments"]> {
  if (appointmentId <= 0) return undefined;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointment_segments",
    columns: "service_id, service_name, staff_id, starts_at, ends_at, position",
    where: "appointment_id = ?",
    params: [appointmentId],
    orderBy: "position ASC, starts_at ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  if (rows.length < 2) return undefined;
  const staffIds = [...new Set(rows.map((r) => Number(r.staff_id ?? 0)).filter((n) => n > 0))];
  if (staffIds.length < 2) return undefined;

  const staffRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff",
    columns: "id, full_name",
    where: `id IN (${staffIds.map(() => "?").join(",")})`,
    params: staffIds,
  }).catch(() => [] as RowDataPacket[]);
  const nameById = new Map<number, string>(staffRows.map((r) => [Number(r.id), String(r.full_name ?? "")]));

  return rows.map((r) => ({
    serviceId: Number(r.service_id ?? 0),
    serviceName: String(r.service_name ?? "Servizio"),
    staffId: Number(r.staff_id ?? 0),
    staffName: nameById.get(Number(r.staff_id ?? 0)) ?? "",
    time: timeLocal(toDate(r.starts_at)),
    endTime: timeLocal(toDate(r.ends_at)),
  }));
}

// Read the appointment's ORDERED service list from appointment_services (one entry
// per row, preserving sort order). Falls back to the single services-table lookup
// (legacy single-service appointments without snapshot rows) so the list always has
// at least one entry. Mirrors appointmentService but returns ALL services, not just
// the primary, for the multi-service parent/child rendering.
async function appointmentServiceLines(
  slug: string,
  appointment: RowDataPacket,
): Promise<Array<{ serviceId: number; name: string; price: number; segmentId?: number | null }>> {
  const appointmentId = Number(appointment.id ?? 0);
  try {
    const serviceRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointment_services",
      columns: "service_id, service_name, price",
      where: "appointment_id = ?",
      params: [appointmentId],
      orderBy: "service_id ASC",
    });
    if (serviceRows.length > 0) {
      // Segment ids + POSITION order (the legacy child rows follow the segment
      // sequence and carry data-seg for the ↑/↓ reorder buttons).
      const segRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "appointment_segments",
        columns: "id, service_id, position",
        where: "appointment_id = ?",
        params: [appointmentId],
        orderBy: "position ASC, id ASC",
      }).catch(() => [] as RowDataPacket[]);
      const segByService = new Map<number, { id: number; position: number }>();
      for (const seg of segRows) {
        const sid = Number(seg.service_id ?? 0);
        if (sid > 0 && !segByService.has(sid)) segByService.set(sid, { id: Number(seg.id ?? 0), position: Number(seg.position ?? 0) });
      }
      const lines = serviceRows.map((row) => {
        const serviceId = Number(row.service_id ?? 0);
        const seg = segByService.get(serviceId);
        return {
          serviceId,
          name: String(row.service_name ?? "Servizio"),
          price: Number(row.price ?? 0),
          segmentId: seg ? seg.id : null,
          _position: seg ? seg.position : Number.MAX_SAFE_INTEGER,
        };
      });
      lines.sort((a, b) => a._position - b._position || a.serviceId - b.serviceId);
      return lines.map(({ _position, ...line }) => line);
    }
  } catch {
    // fallback below
  }

  const serviceId = Number(appointment.service_id ?? 0);
  if (serviceId > 0) {
    try {
      const rows = await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "id, name, price", where: "id = ?", params: [serviceId], limit: 1 });
      if (rows[0]) return [{ serviceId, name: String(rows[0].name ?? "Servizio"), price: Number(rows[0].price ?? 0) }];
    } catch {
      // fallback below
    }
  }

  return [{ serviceId: 0, name: "Servizio", price: 0 }];
}

async function appointmentClientName(slug: string, clientId: number): Promise<string> {
  if (clientId <= 0) return "Cliente";
  try {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "full_name,email", where: "id = ?", params: [clientId], limit: 1 });
    return String(rows[0]?.full_name ?? rows[0]?.email ?? "Cliente");
  } catch {
    return "Cliente";
  }
}

async function appointmentService(slug: string, appointment: RowDataPacket): Promise<{ name: string; price: number }> {
  const appointmentId = Number(appointment.id ?? 0);
  try {
    const serviceRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointment_services",
      columns: "service_name,price",
      where: "appointment_id = ?",
      params: [appointmentId],
      limit: 1,
    });
    if (serviceRows[0]) return { name: String(serviceRows[0].service_name ?? "Servizio"), price: Number(serviceRows[0].price ?? 0) };
  } catch {
    // fallback below
  }

  const serviceId = Number(appointment.service_id ?? 0);
  if (serviceId > 0) {
    try {
      const rows = await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "name,price", where: "id = ?", params: [serviceId], limit: 1 });
      if (rows[0]) return { name: String(rows[0].name ?? "Servizio"), price: Number(rows[0].price ?? 0) };
    } catch {
      // fallback below
    }
  }

  return { name: "Servizio", price: 0 };
}

async function appointmentStaffName(slug: string, appointmentId: number): Promise<string> {
  try {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "appointment_staff", columns: "staff_id", where: "appointment_id = ?", params: [appointmentId], limit: 1 });
    const staffId = Number(rows[0]?.staff_id ?? 0);
    if (staffId <= 0) return "";
    const staff = await tenantSelect<RowDataPacket>({ slug, table: "staff", columns: "full_name", where: "id = ?", params: [staffId], limit: 1 });
    return String(staff[0]?.full_name ?? "");
  } catch {
    return "";
  }
}

async function resolveClientForAppointment(slug: string, clientName: string, locationId: number | null, clientId?: number | null): Promise<{ id: number; name: string }> {
  // Prefer the SELECTED client id (the drawer posts #qb_client_id) so the save binds to the
  // exact client chosen — resolving by name alone binds to the FIRST match, which is wrong
  // when clients share a name (and would also create a duplicate when the name doesn't exist).
  if (clientId && clientId > 0) {
    const byId = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "id,full_name", where: "id = ?", params: [clientId], limit: 1 });
    if (byId[0]) return { id: Number(byId[0].id), name: String(byId[0].full_name) };
  }
  const normalized = normalizeName(clientName, "Cliente");
  const existing = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "id,full_name", where: "LOWER(full_name) = ?", params: [normalized.toLowerCase()], limit: 1 });
  if (existing[0]) return { id: Number(existing[0].id), name: String(existing[0].full_name) };
  const created = await createDbClient({ name: normalized, locationId: locationId ?? 0 }, slug);
  return { id: created.id, name: created.name };
}

async function resolveServiceForAppointment(slug: string, serviceName: string): Promise<RowDataPacket> {
  const normalized = serviceName.trim();
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "services",
    where: normalized ? "LOWER(name) = ?" : "COALESCE(is_active, 1) = 1",
    params: normalized ? [normalized.toLowerCase()] : [],
    orderBy: "sort_order ASC, id ASC",
    limit: 1,
  });
  if (!rows[0]) throw new Error("Servizio non trovato.");
  return rows[0];
}

async function resolveStaffForAppointment(slug: string, staffName: string): Promise<RowDataPacket | null> {
  const normalized = staffName.trim();
  if (!normalized) return null;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "staff",
    columns: "id,full_name",
    where: "LOWER(full_name) = ? AND COALESCE(is_active, 1) = 1",
    params: [normalized.toLowerCase()],
    limit: 1,
  });
  return rows[0] ?? null;
}

// One snapshot row per selected service. `promo` (when the save detected an
// applicable promotion for this service) writes the legacy promo pricing:
// price = discounted, list_price = original, discount_badge = "-10%"/"-€ x"
// (redeem zero-charging runs AFTER and overrides these, same as the legacy).
async function insertAppointmentService(
  slug: string,
  appointmentId: number,
  service: RowDataPacket,
  promo?: { price: number; listPrice: number; badge: string } | null,
): Promise<void> {
  try {
    await tenantInsert(await tenantTable(slug, "appointment_services"), {
      appointment_id: appointmentId,
      service_id: Number(service.id ?? 0),
      service_name: String(service.name ?? ""),
      qty: 1,
      price: promo ? roundMoney(promo.price) : Number(service.price ?? 0),
      list_price: promo ? roundMoney(promo.listPrice) : Number(service.price ?? 0),
      discount_badge: promo && promo.badge ? promo.badge : null,
      duration_min: Number(service.duration_min ?? 30),
    });
  } catch {
    // compatibility: older installs may not have the snapshot table
  }
}

async function insertAppointmentStaff(slug: string, appointmentId: number, staffId: number): Promise<void> {
  try {
    await tenantInsert(await tenantTable(slug, "appointment_staff"), { appointment_id: appointmentId, staff_id: staffId });
  } catch {
    // compatibility
  }
}

async function insertAppointmentLocation(slug: string, appointmentId: number, locationId: number): Promise<void> {
  try {
    await tenantInsert(await tenantTable(slug, "appointment_locations"), { appointment_id: appointmentId, location_id: locationId });
  } catch {
    // compatibility
  }
}

// Insert one appointment_segments row. `position` is the 0-based sequential index
// (legacy rebuild_segments_for_appointment uses a 0-based cursor); `cabinId`, when
// provided, overrides the service's own cabin (per-service cabin map / explicit
// drawer cabin). Both default to the single-service behaviour (position 0, service
// cabin) for backward compatibility.
async function insertAppointmentSegment(
  slug: string,
  appointmentId: number,
  service: RowDataPacket,
  staffId: number | null,
  startsAt: string,
  endsAt: string,
  durationMinutes: number,
  position = 0,
  cabinId?: number | null,
): Promise<void> {
  try {
    await tenantInsert(await tenantTable(slug, "appointment_segments"), {
      appointment_id: appointmentId,
      service_id: Number(service.id ?? 0),
      service_name: String(service.name ?? ""),
      staff_id: staffId ?? 0,
      position,
      starts_at: startsAt,
      ends_at: endsAt,
      duration_minutes: durationMinutes,
      cabin_id: cabinId === undefined ? (service.cabin_id ?? null) : cabinId,
    });
  } catch {
    // compatibility
  }
}

async function assertDbAppointmentHold({
  slug,
  token,
  ownerKey,
  startsAt,
  serviceId,
  staffId,
  locationId,
}: {
  slug: string;
  token: string;
  ownerKey: string;
  startsAt: string;
  serviceId: number;
  staffId: number | null;
  locationId: number | null;
}): Promise<void> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointment_holds",
    where: "token = ? AND owner_key = ? AND status = 'active' AND expires_at > NOW()",
    params: [token, ownerKey],
    limit: 1,
  });
  const hold = rows[0];
  if (!hold) throw new Error("Hold appuntamento scaduto o non valido.");
  if (sqlDateTimePrefix(hold.starts_at) !== startsAt.slice(0, 16)) throw new Error("Hold non coerente con orario selezionato.");

  const heldServices = parseDbNumberArray(hold.service_ids_json);
  if (serviceId > 0 && heldServices.length > 0 && !heldServices.includes(serviceId)) throw new Error("Hold non coerente con servizio selezionato.");

  const heldStaff = parseDbNumberArray(hold.staff_ids_json);
  if (staffId && heldStaff.length > 0 && !heldStaff.includes(staffId)) throw new Error("Hold non coerente con operatore selezionato.");

  const heldLocationId = hold.location_id === null || hold.location_id === undefined ? null : Number(hold.location_id);
  if (locationId && heldLocationId && heldLocationId !== locationId) throw new Error("Hold non coerente con sede selezionata.");
}

async function markDbAppointmentHoldConverted(slug: string, token: string, ownerKey: string, appointmentId: number): Promise<void> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointment_holds",
    columns: "id",
    where: "token = ? AND owner_key = ?",
    params: [token, ownerKey],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  const id = Number(rows[0]?.id ?? 0);
  if (id > 0) await tenantUpdate({ slug, table: "appointment_holds", id, values: { status: "converted", appointment_id: appointmentId } });
}

async function getSingleService(slug: string, id: number): Promise<ManagedService> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "services", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Servizio non trovato.");
  return mapService(rows[0]);
}

async function getSingleProduct(slug: string, id: number): Promise<ManagedProduct> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "products", where: "id = ?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Prodotto non trovato.");
  return mapProduct(rows[0]);
}

function mapClient(row: RowDataPacket): ManagedClient {
  const value = Number(row.credit_balance ?? 0);
  return {
    id: Number(row.id ?? 0),
    name: String(row.full_name ?? ([row.first_name, row.last_name].filter(Boolean).join(" ") || row.email || "Cliente")),
    email: String(row.email ?? ""),
    phone: String(row.phone ?? ""),
    locationId: Number(row.location_id ?? 0),
    tags: [],
    archived: Number(row.is_blocked ?? 0) === 1,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.created_at),
    lastVisit: row.registration_date ? String(row.registration_date).slice(0, 10) : "-",
    value: `${roundMoney(value)} euro`,
    next: "-",
    note: String(row.notes ?? ""),
    // Full anagrafica (port of clients.php client_profile_defaults + the columns
    // edited by the new/edit form). Empty strings keep the edit-form prefill simple.
    firstName: String(row.first_name ?? ""),
    lastName: String(row.last_name ?? ""),
    companyName: String(row.company_name ?? ""),
    vatNumber: String(row.vat_number ?? ""),
    taxCode: String(row.tax_code ?? ""),
    sdi: String(row.sdi ?? ""),
    pec: String(row.pec ?? ""),
    phoneHome: String(row.phone_home ?? ""),
    phone2: String(row.phone2 ?? ""),
    gender: String(row.gender ?? ""),
    birthDate: row.birth_date ? String(row.birth_date).slice(0, 10) : "",
    birthPlace: String(row.birth_place ?? ""),
    registrationDate: row.registration_date ? String(row.registration_date).slice(0, 10) : "",
    region: String(row.region ?? ""),
    province: String(row.province ?? ""),
    city: String(row.city ?? ""),
    address: String(row.address ?? ""),
    cap: String(row.cap ?? ""),
    jobTitle: String(row.job_title ?? ""),
  };
}

function mapService(row: RowDataPacket): ManagedService {
  const active = Number(row.is_active ?? 1) === 1;
  return {
    id: Number(row.id ?? 0),
    name: String(row.name ?? "Servizio"),
    duration: `${Number(row.duration_min ?? 0)} min`,
    price: `${roundMoney(Number(row.price ?? 0))} euro`,
    category: row.category_id ? `Categoria #${row.category_id}` : "Servizi",
    demand: active ? "Attivo" : "Disattivo",
    color: "#007c72",
    description: "",
    locationIds: [],
    active,
    bookingEnabled: Number(row.booking_enabled ?? 1) === 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function mapProduct(row: RowDataPacket): ManagedProduct {
  return {
    id: Number(row.id ?? 0),
    name: String(row.name ?? "Prodotto"),
    category: row.category_id ? `Categoria #${row.category_id}` : "Prodotti",
    brand: String(row.brand ?? ""),
    price: `${roundMoney(Number(row.price ?? 0))} euro`,
    image: "/window.svg",
    sku: String(row.sku ?? row.internal_code ?? ""),
    stock: Number(row.stock ?? 0),
    minStock: Number(row.min_stock ?? 0),
    locationId: 0,
    publicVisible: Number(row.sell_online ?? 0) === 1,
    movements: [],
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.created_at),
  };
}

async function tryInsertStockMove({
  slug,
  productId,
  type,
  quantity,
  reason,
}: {
  slug: string;
  productId: number;
  type: StockMovement["type"];
  quantity: number;
  reason: string;
}): Promise<void> {
  try {
    const table = await tenantTable(slug, "stock_moves");
    const values: Record<string, unknown> = {
      product_id: productId,
      type,
      quantity,
      reason: reason || "Movimento stock",
      created_at: new Date(),
    };
    if (await columnExists(table.name, "movement_type")) {
      values.movement_type = values.type;
      delete values.type;
    }
    await tenantInsert(table, values);
  } catch {
    // Stock moves are best-effort because older installs may not have this table yet.
  }
}

function normalizeName(value: unknown, fallback: string): string {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

function slugSegment(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "sede";
}

function parseDbNumberArray(value: unknown): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return parsed.map((item) => Number(item)).filter((item) => Number.isFinite(item) && item > 0);
  } catch {
    // fallback below
  }
  return String(value)
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function normalizeCouponCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "");
}

function activeWindow(startsAt: string, endsAt: string, asOf?: string): boolean {
  const day = asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : todayIso();
  return (!startsAt || startsAt <= day) && (!endsAt || endsAt >= day);
}

function discountValue(type: CouponType, value: number, subtotal: number): number {
  const amount = type === "percent" ? subtotal * (value / 100) : value;
  return roundMoney(Math.max(0, Math.min(subtotal, amount)));
}

function randomHex(length: number): string {
  return randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}

function parseDuration(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? "").replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseMoney(value: unknown, fallback: number): number {
  const parsed = Number.parseFloat(String(value ?? "").replace(",", ".").replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// Port of clients.php normalize_date(): accepts a strict YYYY-MM-DD string and
// returns it, otherwise null (invalid/empty -> not persisted).
function normalizeClientDate(value: unknown): string | null {
  const s = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map((part) => Number.parseInt(part, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return s;
}

function trimOrNull(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return s === "" ? null : s;
}

function addDaysDate(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return dateIsoLocal(date);
}

function toIso(value: unknown): string {
  if (!value) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function sqlDateTimePrefix(value: unknown): string {
  if (value instanceof Date) {
    return `${dateIsoLocal(value)} ${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
  }
  return String(value ?? "").slice(0, 16);
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function normalizeTime(value: string): string {
  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return "09:00";
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function addMinutesSqlDate(sqlDate: string, minutes: number): string {
  const date = new Date(sqlDate.replace(" ", "T"));
  date.setMinutes(date.getMinutes() + minutes);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-") + " " + [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    "00",
  ].join(":");
}

function dateIsoLocal(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function timeLocal(date: Date): string {
  return [String(date.getHours()).padStart(2, "0"), String(date.getMinutes()).padStart(2, "0")].join(":");
}

// UI label from the raw status. BUG FIX (2026-07-02): canceled/no_show used to
// collapse into "Confermato" — an annullato appointment showed a "Confermato"
// badge wherever the label (not statusCode) was rendered, e.g. the
// appointments list.
function uiStatus(status: string): AppointmentStatus {
  const code = phpStatus(status);
  if (code === "done") return "Completato";
  if (code === "pending") return "In attesa";
  if (code === "canceled") return "Annullato";
  if (code === "no_show") return "No show";
  return "Confermato";
}

function phpStatus(status: AppointmentStatus | string): string {
  const normalized = String(status).trim().toLowerCase();
  if (normalized === "completato" || normalized === "done" || normalized === "completed") return "done";
  if (normalized === "in attesa" || normalized === "pending" || normalized === "waiting") return "pending";
  if (normalized === "canceled" || normalized === "cancelled" || normalized === "annullato") return "canceled";
  if (normalized === "no_show" || normalized === "no show") return "no_show";
  return "scheduled";
}

// ===================== QUICK-BOOKING CLIENT CONTEXT =====================
// Faithful port of `api_clients.php` action=history (summary) + action=residuals
// (summary=1), the two payloads the quick-booking drawer's CLIENT HISTORY and
// RESIDUALS panels consume (assets/js/app.js qbLoadClientHistory /
// qbLoadClientResiduals). Both are tenant-scoped via `tenantSelect`, and every
// residual block is guarded so a missing table/column simply yields count 0
// (mirrors the legacy `try/catch` + `table_exists()`/`column_exists()` checks).

export type QuickBookClientHistorySummary = {
  total: number;
  last_visit: string | null;
  next_visit: string | null;
  sales_total: number;
};

export type QuickBookClientResidualsSummary = {
  services_count: number;
  gifts_count: number;
  giftboxes_count: number;
  giftcards_count: number;
  packages_count: number;
  credit_count: number;
  credit_available: number;
  total: number;
};

// One available (redeemable) package for the quick-booking drawer's per-service
// "Usa pacchetto" control. `service_ids` are the services this package COVERS and
// still has sessions for (the per-service `client_package_services` rows with
// sessions_remaining > 0, or the legacy single `client_packages.service_id`).
// `serviceItemIds` maps a covered service_id -> its `client_package_services.id`
// (the legacy `client_package_service_id`) so the redeem can pin the exact row;
// absent for legacy single-service packages (the package-level pool is used).
export type QuickBookClientPackage = {
  id: number;
  name: string;
  sessions_remaining: number;
  expires_at: string | null;
  service_ids: number[];
  serviceItemIds: Record<number, number>;
};

// One available (redeemable) prepaid-service balance for the per-service "Usa
// prepagato" control (port of api_clients.php action=residuals prepaid block +
// ClientPrepaidServices::listAvailableForClient; returned by quickbook_client_context).
// A prepaid is tied to ONE service directly (`service_id`), so coverage is a single
// service — no separate coverage table. `remaining_qty` is the consumable balance.
export type QuickBookClientPrepaid = {
  id: number;
  service_id: number;
  name: string;
  remaining_qty: number;
};

// One available (redeemable) GiftCard for the APPOINTMENT-LEVEL "GiftCard" control
// (port of api_clients.php action=residuals giftcard block; returned by
// quickbook_client_context). A GiftCard is MONETARY (a spendable `balance`, not a
// per-service unit) and applies to the WHOLE appointment — one giftcard per
// appointment, an amount. `balance` is the consumable monetary balance.
export type QuickBookClientGiftcard = {
  id: number;
  code: string;
  balance: number;
};

// One available (redeemable) GiftBox ITEM for the per-service "Usa GiftBox" control
// (returned by quickbook_client_context). GiftBox is per-service + ITEM-based (like a
// package): each entry is a single item from an issued, non-expired instance that still
// has a residual unit and covers exactly `service_id`. `instance_id` + `giftbox_item_id`
// (the giftbox_instance_items.giftbox_item_id value) pin the redeem; `name` is the item /
// service label for the option. The drawer offers it on the service it covers.
export type QuickBookClientGiftbox = {
  instance_id: number;
  giftbox_item_id: number;
  service_id: number;
  name: string;
};

// One available (redeemable) GIFT (omaggio) SERVICE REWARD for the per-service "Usa
// Omaggio" control (returned by quickbook_client_context). A gift INSTANCE holds REWARD
// ITEMS (gifts.reward_items_json, an array); a SERVICE reward is one whose type='service'
// with a positive service_id. Each entry here is a single still-available service reward
// (qty_remaining > 0) from an available (state='disponibile', active, non-expired) instance
// owned by the client. `instance_id` + `reward_item_index` (the reward's ARRAY INDEX in the
// gift's reward_items_json) pin the redeem; `service_id` is the covered service; `name` is
// the service label for the option. The drawer offers it on the service it covers.
export type QuickBookClientGift = {
  instance_id: number;
  reward_item_index: number;
  service_id: number;
  name: string;
};

// FIDELITY REDEEM context for the quick-booking drawer's "Punti Fidelity" box (Block 4).
// `pointsAvailable` is the client's spendable clients.points balance (the same source the
// POS residuals + wallet use); the settings mirror Fidelity::settings() redeem block
// (euroPerPoint for points->€, minPoints the minimum redeemable, redeemEnabled the global
// gate). The drawer converts pointsUsed*euroPerPoint into the "Sconto Fidelity" deduction.
export type QuickBookClientFidelity = {
  redeemEnabled: boolean;
  euroPerPoint: number;
  minPoints: number;
  pointsAvailable: number;
};

export type QuickBookClientContext = {
  history: QuickBookClientHistorySummary;
  residuals: QuickBookClientResidualsSummary;
  packages: QuickBookClientPackage[];
  prepaids: QuickBookClientPrepaid[];
  giftcards: QuickBookClientGiftcard[];
  giftboxes: QuickBookClientGiftbox[];
  gifts: QuickBookClientGift[];
  // Block 4: fidelity redeem settings + the client's available points, so the drawer's
  // #qbFidelityBox can offer a bounded points-use input and compute the € discount.
  fidelity: QuickBookClientFidelity;
};

// ---------------------------------------------------------------------------
// Quick-booking "Apri scheda" residuals DETAIL (read-only view).
//
// Port of api_clients.php action=residuals's per-item payload, but DISPLAY-ONLY:
// the quick-booking drawer already does the redeem SELECTION inline (per-service
// "Usa pacchetto/prepagato/GiftBox/Omaggio" controls + the giftcard/credit price
// rows), so this feeds the `#qbClientResidualsModal` detail viewer only. It does
// NOT carry the legacy modal's checkbox/data-* redeem attributes, nor its in-modal
// credit/giftcard entry controls — the inline UX supersedes those (intentional
// divergence). Each section carries the fields the modal renders: name, remaining
// (+ total where meaningful), expiry, and the source sale # where available.
// Each row also carries its SOURCE ids (prepaid id / instance id / package id /
// giftcard id + the covered service ids) so the drawer's per-item info modals
// (#qbPackageInfoModal & co.) can look the clicked residual up by id.
export type QuickBookResidualServiceDetail = {
  id: number;
  service_id: number;
  service_name: string;
  remaining_qty: number;
  purchased_qty: number;
  unit_price: number;
  sale_id: number | null;
  expires_at: string | null;
};
export type QuickBookResidualGiftDetail = {
  instance_id: number;
  reward_item_index: number;
  service_id: number;
  gift_name: string;
  service_name: string;
  qty_remaining: number;
  qty_total: number;
  expires_at: string | null;
};
export type QuickBookResidualGiftboxItem = {
  giftbox_item_id: number;
  service_id: number;
  service_name: string;
  qty_remaining: number;
  qty_total: number;
};
export type QuickBookResidualGiftboxDetail = {
  instance_id: number;
  giftbox_name: string;
  code: string;
  remaining_qty: number;
  total_qty: number;
  expires_at: string | null;
  items: QuickBookResidualGiftboxItem[];
};
export type QuickBookResidualGiftcardDetail = {
  id: number;
  code: string;
  balance: number;
  expires_at: string | null;
};
export type QuickBookResidualPackageItem = {
  service_id: number;
  service_name: string;
  sessions_remaining: number;
  sessions_total: number;
};
export type QuickBookResidualPackageDetail = {
  id: number;
  package_name: string;
  sessions_remaining: number;
  sessions_total: number;
  expires_at: string | null;
  sale_id: number | null;
  breakdown: string;
  items: QuickBookResidualPackageItem[];
};
export type QuickBookClientResidualsDetail = {
  services: QuickBookResidualServiceDetail[];
  gifts: QuickBookResidualGiftDetail[];
  giftboxes: QuickBookResidualGiftboxDetail[];
  giftcards: QuickBookResidualGiftcardDetail[];
  packages: QuickBookResidualPackageDetail[];
  // Credit line (clients.credit_balance): available > 0 -> shown as a "Credito" row.
  credit: { available: number; count: number };
};

// Port of Fidelity::settings() redeem block (app/lib/Fidelity.php ~610-620): the redeem
// config off the single `businesses` row, with the legacy defaults + clamps. Duplicated
// here (rather than imported from manage-pos) to avoid a manage-pos -> db-repositories
// import cycle. euroPerPoint defaults 0.10 (>0, <=100000); minPoints defaults 0 (whole,
// [0, 100000000]); redeemEnabled = fidelity_enabled AND fidelity_redeem_enabled. Schema-
// guarded: a missing column falls back to the defaults (redeem disabled).
async function quickBookFidelityRedeemSettings(
  slug: string,
): Promise<{ redeemEnabled: boolean; euroPerPoint: number; minPoints: number }> {
  const defaults = { redeemEnabled: false, euroPerPoint: 0.1, minPoints: 0 };
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "businesses",
      columns: "fidelity_enabled,fidelity_redeem_enabled,fidelity_redeem_euro_per_point,fidelity_redeem_min_points",
      orderBy: "id ASC",
      limit: 1,
    });
    const row = rows[0];
    if (!row) return defaults;
    const enabled = Number(row.fidelity_enabled ?? 0) === 1 && Number(row.fidelity_redeem_enabled ?? 0) === 1;
    let euroPerPoint = Number(row.fidelity_redeem_euro_per_point ?? 0.1);
    if (!Number.isFinite(euroPerPoint) || euroPerPoint <= 0) euroPerPoint = 0.1;
    if (euroPerPoint > 100000) euroPerPoint = 100000;
    let minPoints = Number(row.fidelity_redeem_min_points ?? 0);
    if (!Number.isFinite(minPoints) || minPoints < 0) minPoints = 0;
    if (minPoints > 100000000) minPoints = 100000000;
    minPoints = Math.max(0, Math.round(minPoints));
    return { redeemEnabled: enabled, euroPerPoint: roundMoney(euroPerPoint), minPoints };
  } catch {
    return defaults;
  }
}

// History summary — port of api_clients.php lines ~3926-3958:
//   total      = COUNT(*) of ALL appointments for the client (no status filter)
//   last_visit = MAX(starts_at) where starts_at < NOW() (any status)
//   next_visit = MIN(starts_at) where starts_at >= NOW() AND status IN ('pending','scheduled')
//   sales_total= SUM(total) of the client's sales, excluding cancelled when a
//                sales.status column exists (legacy $salesWhereStatus).
async function quickBookClientHistorySummary(slug: string, clientId: number): Promise<QuickBookClientHistorySummary> {
  const out: QuickBookClientHistorySummary = { total: 0, last_visit: null, next_visit: null, sales_total: 0 };

  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointments",
      columns:
        "COUNT(*) AS total, " +
        "MAX(CASE WHEN starts_at < NOW() THEN starts_at ELSE NULL END) AS last_visit, " +
        "MIN(CASE WHEN starts_at >= NOW() AND status IN ('pending','scheduled') THEN starts_at ELSE NULL END) AS next_visit",
      where: "client_id = ?",
      params: [clientId],
    });
    const row = rows[0] ?? {};
    out.total = Number(row.total ?? 0) || 0;
    out.last_visit = row.last_visit ? String(row.last_visit) : null;
    out.next_visit = row.next_visit ? String(row.next_visit) : null;
  } catch {
    // tolerate missing appointments table
  }

  try {
    const salesTable = await tenantTable(slug, "sales");
    const hasStatus = await columnExists(salesTable.name, "status");
    const where = hasStatus
      ? "client_id = ? AND (status IS NULL OR status NOT IN ('cancelled','canceled'))"
      : "client_id = ?";
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "sales",
      columns: "COALESCE(SUM(total), 0) AS t",
      where,
      params: [clientId],
    });
    out.sales_total = roundMoney(Number(rows[0]?.t ?? 0));
  } catch {
    out.sales_total = 0;
  }

  return out;
}

// Residuals summary — port of api_clients.php lines ~1800-1973 (the summary=1
// branch). Each ACTIVE/unconsumed item type is counted independently and any
// missing table/column degrades to 0. `locationId` only narrows the count when
// > 0 (the legacy applies the per-location service-allow filter only then; the
// Next manage app has no ported per-location service map, so the location is
// accepted but does not further filter — documented as a TODO).
async function quickBookClientResidualsSummary(
  slug: string,
  clientId: number,
): Promise<QuickBookClientResidualsSummary> {
  const out: QuickBookClientResidualsSummary = {
    services_count: 0,
    gifts_count: 0,
    giftboxes_count: 0,
    giftcards_count: 0,
    packages_count: 0,
    credit_count: 0,
    credit_available: 0,
    total: 0,
  };

  // Credito cliente — clients.credit_balance (legacy api_clients_credit_residual_data:
  // credit_count = 1 when available > 0, credit_available = the balance).
  try {
    const { credit } = await dbWalletBalance(clientId, slug);
    out.credit_available = roundMoney(Math.max(0, credit));
    out.credit_count = out.credit_available > 0.00001 ? 1 : 0;
  } catch {
    out.credit_available = 0;
    out.credit_count = 0;
  }

  // Servizi prepagati — ClientPrepaidServices::listAvailableForClient:
  //   client_prepaid_services WHERE client_id=? AND status='active' AND remaining_qty > 0
  //   (+ expires_at IS NULL OR expires_at >= CURDATE() when the column exists).
  try {
    const prepaidTable = await tenantTable(slug, "client_prepaid_services");
    const hasExpiry = await columnExists(prepaidTable.name, "expires_at");
    const where = hasExpiry
      ? "client_id = ? AND status = 'active' AND remaining_qty > 0 AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)"
      : "client_id = ? AND status = 'active' AND remaining_qty > 0";
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "client_prepaid_services",
      columns: "COUNT(*) AS c",
      where,
      params: [clientId],
    });
    out.services_count = Math.max(0, Number(rows[0]?.c ?? 0) || 0);
  } catch {
    out.services_count = 0;
  }

  // GiftCard — legacy giftcards WHERE (recipient_client_id | client_id)
  //   AND status='active' AND balance > 0 AND (expires_at IS NULL OR expires_at >= CURDATE()).
  try {
    const giftcardTable = await tenantTable(slug, "giftcards");
    const hasRecipient = await columnExists(giftcardTable.name, "recipient_client_id");
    const hasExpiry = await columnExists(giftcardTable.name, "expires_at");
    const target = hasRecipient ? "recipient_client_id = ?" : "client_id = ?";
    const expiry = hasExpiry ? " AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)" : "";
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "giftcards",
      columns: "COUNT(*) AS c",
      where: `${target} AND status = 'active' AND balance > 0${expiry}`,
      params: [clientId],
    });
    out.giftcards_count = Math.max(0, Number(rows[0]?.c ?? 0) || 0);
  } catch {
    out.giftcards_count = 0;
  }

  // Pacchetti — legacy client_packages WHERE client_id=? AND status='active'
  //   AND sessions_remaining > 0 AND (expires_at IS NULL OR expires_at >= CURDATE()).
  try {
    const packageTable = await tenantTable(slug, "client_packages");
    const hasExpiry = await columnExists(packageTable.name, "expires_at");
    const expiry = hasExpiry ? " AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)" : "";
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "client_packages",
      columns: "COUNT(*) AS c",
      where: `client_id = ? AND status = 'active' AND sessions_remaining > 0${expiry}`,
      params: [clientId],
    });
    out.packages_count = Math.max(0, Number(rows[0]?.c ?? 0) || 0);
  } catch {
    out.packages_count = 0;
  }

  // GiftBox — legacy counts issued, not-expired instances whose
  //   (total_qty - redeemed_qty) > 0. We reuse the same residual maths the
  //   Next giftbox mapper uses (giftbox_instance_items qty - redemptions) per
  //   instance, counting instances with a positive remainder. Tolerates the
  //   giftbox tables being absent (count 0).
  try {
    const hasInstances = await tableExists((await tenantTable(slug, "giftbox_instances")).name);
    if (hasInstances) {
      const instanceTable = await tenantTable(slug, "giftbox_instances");
      const hasRecipient = await columnExists(instanceTable.name, "recipient_client_id");
      const hasExpiry = await columnExists(instanceTable.name, "expires_at");
      const target = hasRecipient
        ? "(recipient_client_id = ? OR (recipient_client_id IS NULL AND client_id = ?))"
        : "client_id = ?";
      const params = hasRecipient ? [clientId, clientId] : [clientId];
      const expiry = hasExpiry ? " AND (expires_at IS NULL OR expires_at >= NOW())" : "";
      const instances = await tenantSelect<RowDataPacket>({
        slug,
        table: "giftbox_instances",
        columns: "id",
        where: `${target} AND status = 'issued'${expiry}`,
        params,
      });
      let count = 0;
      for (const inst of instances) {
        const instanceId = Number(inst.id ?? 0);
        if (instanceId <= 0) continue;
        try {
          const items = await tenantSelect<RowDataPacket>({
            slug,
            table: "giftbox_instance_items",
            columns: "qty",
            where: "instance_id = ?",
            params: [instanceId],
          });
          const totalQty = items.reduce((sum, item) => sum + Math.max(0, Number(item.qty ?? 0)), 0);
          const redeemed = await giftBoxRedeemedUnits(slug, instanceId);
          if (totalQty - redeemed > 0) count += 1;
        } catch {
          // tolerate giftbox item/redemption tables being absent
        }
      }
      out.giftboxes_count = Math.max(0, count);
    }
  } catch {
    out.giftboxes_count = 0;
  }

  // Omaggi (gifts) — the legacy sums qty_remaining of SERVICE reward items
  //   (Gifts::countAvailableServiceRewardsForClient). We now port the reward-item
  //   maths via quickBookClientGifts (the same available-instance + per-reward
  //   residual rule the drawer's "Usa Omaggio" control uses), so the badge count
  //   matches the redeemable rewards exactly (one count per available service reward).
  try {
    const gifts = await quickBookClientGifts(slug, clientId);
    out.gifts_count = Math.max(0, gifts.length);
  } catch {
    out.gifts_count = 0;
  }

  out.total =
    out.services_count +
    out.gifts_count +
    out.giftboxes_count +
    out.giftcards_count +
    out.packages_count +
    out.credit_count;
  return out;
}

// "Scheda semplificata" cliente per il quick booking (port of api_clients.php
// action=card :3921, rendered by the legacy #qbClientCardModal): anagrafica +
// punti, riepilogo appuntamenti (contatori + ultima/prossima visita) e totale
// vendite, ultimi appuntamenti (servizi/operatori/totale con lo sconto manuale
// applicato come nel legacy), ultime 10 vendite, tag e documenti (best-effort:
// le tabelle sono opzionali). limit clampato 0..50 come il legacy.
export type QuickBookClientCard = {
  client: { id: number; full_name: string; phone: string; email: string; points: number };
  summary: {
    total: number;
    done: number;
    scheduled: number;
    pending: number;
    canceled: number;
    no_show: number;
    last_visit: string | null;
    next_visit: string | null;
    sales_total: number;
  };
  appointments: Array<{ id: number; starts_at: string; status: string; services: string; staff: string; total: number }>;
  sales: Array<{ id: number; sale_date: string; total: number; notes: string }>;
  tags: Array<{ id: number; name: string }>;
  docs: Array<{ id: number; title: string; url: string; created_at: string }>;
};

export async function quickBookClientCard(slug: string, clientId: number, limitInput = 10): Promise<QuickBookClientCard> {
  const clientRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "clients",
    columns: "id, full_name, phone, email, points",
    where: "id = ?",
    params: [clientId],
    limit: 1,
  });
  const clientRow = clientRows[0];
  if (!clientRow) throw new Error("Cliente non trovato");

  const sqlLocalStr = (value: unknown): string | null => {
    if (!value) return null;
    if (value instanceof Date) {
      const p = (n: number) => String(n).padStart(2, "0");
      return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())} ${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}`;
    }
    return String(value).replace("T", " ").slice(0, 19);
  };

  // Summary (legacy aggregate: counts per stato + ultima/prossima visita).
  const appts = await tenantTable(slug, "appointments");
  const sumRows = await dbQuery<RowDataPacket[]>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status = 'done') AS done,
            COUNT(*) FILTER (WHERE status = 'scheduled') AS scheduled,
            COUNT(*) FILTER (WHERE status = 'pending') AS pending,
            COUNT(*) FILTER (WHERE LOWER(TRIM(COALESCE(status,''))) IN ('canceled','cancelled','rejected','annullato','rifiutato')) AS canceled,
            COUNT(*) FILTER (WHERE LOWER(TRIM(COALESCE(status,''))) IN ('no_show','no show','no-show','noshow','non presentato','non presentata')) AS no_show,
            MAX(CASE WHEN starts_at < NOW() THEN starts_at ELSE NULL END) AS last_visit,
            MIN(CASE WHEN starts_at >= NOW() AND status IN ('pending','scheduled') THEN starts_at ELSE NULL END) AS next_visit
       FROM ${quoteIdentifier(appts.name)}
      WHERE tenant_id = ? AND client_id = ?`,
    [appts.tenantId ?? 0, clientId],
  ).catch(() => [] as RowDataPacket[]);
  const sum = sumRows[0] ?? ({} as RowDataPacket);

  const salesTable = await tenantTable(slug, "sales");
  const salesTotalRows = await dbQuery<RowDataPacket[]>(
    `SELECT COALESCE(SUM(total),0) AS t FROM ${quoteIdentifier(salesTable.name)} WHERE tenant_id = ? AND client_id = ? AND (status IS NULL OR status NOT IN ('cancelled','canceled'))`,
    [salesTable.tenantId ?? 0, clientId],
  ).catch(() => [] as RowDataPacket[]);

  // Ultimi appuntamenti: nomi servizi (snapshot) + operatori + totale con lo
  // sconto manuale (percent/fixed clampato) applicato al subtotale, come il
  // legacy card. limit=0 => solo riepilogo.
  let limit = Math.trunc(Number(limitInput) || 0);
  if (limit < 0) limit = 10;
  if (limit > 50) limit = 50;
  const appointments: QuickBookClientCard["appointments"] = [];
  if (limit > 0) {
    const apsTable = await tenantTable(slug, "appointment_services");
    const astTable = await tenantTable(slug, "appointment_staff");
    const staffTable = await tenantTable(slug, "staff");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT a.id, a.starts_at, a.status, a.discount_type, a.discount_value,
              COALESCE(NULLIF((SELECT string_agg(DISTINCT aps.service_name, ', ' ORDER BY aps.service_name) FROM ${quoteIdentifier(apsTable.name)} aps WHERE aps.tenant_id = a.tenant_id AND aps.appointment_id = a.id), ''), '(nessun servizio)') AS service_names,
              COALESCE((SELECT string_agg(DISTINCT st.full_name, ', ' ORDER BY st.full_name) FROM ${quoteIdentifier(astTable.name)} ast JOIN ${quoteIdentifier(staffTable.name)} st ON st.id = ast.staff_id AND st.tenant_id = ast.tenant_id WHERE ast.tenant_id = a.tenant_id AND ast.appointment_id = a.id), '') AS staff_names,
              COALESCE((SELECT SUM(aps2.price) FROM ${quoteIdentifier(apsTable.name)} aps2 WHERE aps2.tenant_id = a.tenant_id AND aps2.appointment_id = a.id), 0) AS subtotal
         FROM ${quoteIdentifier(appts.name)} a
        WHERE a.tenant_id = ? AND a.client_id = ?
        ORDER BY a.starts_at DESC
        LIMIT ${limit}`,
      [appts.tenantId ?? 0, clientId],
    ).catch(() => [] as RowDataPacket[]);
    for (const row of rows) {
      const subtotal = Math.max(0, Number(row.subtotal ?? 0) || 0);
      const dtype = String(row.discount_type ?? "").toLowerCase();
      const dval = Math.max(0, Number(row.discount_value ?? 0) || 0);
      let discount = 0;
      if (dval > 0) {
        if (dtype === "percent") discount = (subtotal * dval) / 100;
        else if (dtype === "fixed") discount = dval;
        if (discount > subtotal) discount = subtotal;
      }
      appointments.push({
        id: Number(row.id ?? 0),
        starts_at: sqlLocalStr(row.starts_at) ?? "",
        status: appointmentPhpStatus(String(row.status ?? "")),
        services: String(row.service_names ?? ""),
        staff: String(row.staff_names ?? ""),
        total: roundMoney(Math.max(0, subtotal - discount)),
      });
    }
  }

  const salesRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "sales",
    columns: "id, sale_date, total, notes",
    where: "client_id = ? AND (status IS NULL OR status NOT IN ('cancelled','canceled'))",
    params: [clientId],
    orderBy: "sale_date DESC",
    limit: 10,
  }).catch(() => [] as RowDataPacket[]);

  const tagRows = await dbQuery<RowDataPacket[]>(
    `SELECT t.id, t.name FROM ${quoteIdentifier((await tenantTable(slug, "customer_tags")).name)} t JOIN ${quoteIdentifier((await tenantTable(slug, "customer_tag_map")).name)} m ON m.tag_id = t.id AND m.tenant_id = t.tenant_id WHERE t.tenant_id = ? AND m.client_id = ? ORDER BY t.name ASC`,
    [appts.tenantId ?? 0, clientId],
  ).catch(() => [] as RowDataPacket[]);

  const docRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "customer_documents",
    columns: "id, title, file_path, created_at",
    where: "client_id = ?",
    params: [clientId],
    orderBy: "created_at DESC",
    limit: 25,
  }).catch(() => [] as RowDataPacket[]);

  return {
    client: {
      id: Number(clientRow.id ?? 0),
      full_name: String(clientRow.full_name ?? ""),
      phone: String(clientRow.phone ?? ""),
      email: String(clientRow.email ?? ""),
      points: Math.max(0, Math.round(Number(clientRow.points ?? 0) || 0)),
    },
    summary: {
      total: Number(sum.total ?? 0) || 0,
      done: Number(sum.done ?? 0) || 0,
      scheduled: Number(sum.scheduled ?? 0) || 0,
      pending: Number(sum.pending ?? 0) || 0,
      canceled: Number(sum.canceled ?? 0) || 0,
      no_show: Number(sum.no_show ?? 0) || 0,
      last_visit: sqlLocalStr(sum.last_visit),
      next_visit: sqlLocalStr(sum.next_visit),
      sales_total: roundMoney(Number(salesTotalRows[0]?.t ?? 0) || 0),
    },
    appointments,
    sales: salesRows.map((row) => ({
      id: Number(row.id ?? 0),
      sale_date: sqlLocalStr(row.sale_date) ?? "",
      total: roundMoney(Number(row.total ?? 0) || 0),
      notes: String(row.notes ?? ""),
    })),
    tags: tagRows.map((row) => ({ id: Number(row.id ?? 0), name: String(row.name ?? "") })),
    // Documenti su R2 privato: l'URL punta alla route che verifica sessione+
    // tenant e redirige al presigned (i path legacy non migrati restano senza
    // href e il modal mostra "Non disponibile" come prima).
    docs: docRows.map((row) => {
      const path = String(row.file_path ?? "").trim();
      const downloadable = /^t\d+\//.test(path);
      return {
        id: Number(row.id ?? 0),
        title: String(row.title ?? "Documento"),
        url: downloadable ? `/api/manage/client-document?slug=${encodeURIComponent(slug)}&id=${Number(row.id ?? 0)}` : "",
        created_at: sqlLocalStr(row.created_at) ?? "",
      };
    }),
  };
}

// Combined quick-booking client context (history + residuals summaries),
// tenant-scoped + session-gated by the API route. Mirrors the two legacy
// endpoints the drawer calls when a client is selected.
export async function quickBookClientContext({
  slug,
  clientId,
}: {
  slug: string;
  clientId: number;
  // location_id is accepted by the route for parity with the legacy residuals
  // endpoint, but the Next manage app has no ported per-location service map, so
  // it does not further narrow the counts (TODO: port the per-location filter).
  locationId?: number;
}): Promise<QuickBookClientContext> {
  if (clientId <= 0) throw new Error("client_id mancante");
  const [history, residuals, packages, prepaids, giftcards, giftboxes, gifts, fidelitySettings, wallet] =
    await Promise.all([
      quickBookClientHistorySummary(slug, clientId),
      quickBookClientResidualsSummary(slug, clientId),
      quickBookClientPackages(slug, clientId),
      quickBookClientPrepaids(slug, clientId),
      quickBookClientGiftcards(slug, clientId),
      quickBookClientGiftboxes(slug, clientId),
      quickBookClientGifts(slug, clientId),
      quickBookFidelityRedeemSettings(slug),
      dbWalletBalance(clientId, slug).catch(() => ({ credit: 0, points: 0 })),
    ]);
  const fidelity: QuickBookClientFidelity = {
    redeemEnabled: fidelitySettings.redeemEnabled,
    euroPerPoint: fidelitySettings.euroPerPoint,
    minPoints: fidelitySettings.minPoints,
    pointsAvailable: Math.max(0, Math.round(Number(wallet.points ?? 0) || 0)),
  };
  return { history, residuals, packages, prepaids, giftcards, giftboxes, gifts, fidelity };
}

// Available (redeemable) packages for a client, with the services each package
// covers — drives the drawer's per-service "Usa pacchetto" control. Port of the
// api_clients.php action=residuals PACKAGE block (the "available" filter +
// per-service `client_package_services` breakdown), narrowed to what the redeem
// UI needs. Tenant-scoped via `tenantSelect`; every read is guarded so a missing
// table/column degrades to an empty list (mirrors the legacy table_exists guards).
//
// "Available" mirrors the legacy WHERE exactly: status='active' AND
// sessions_remaining > 0 AND (expires_at IS NULL OR expires_at >= CURRENT_DATE),
// client-scoped. Coverage is the per-service `client_package_services` rows with
// their own sessions_remaining > 0; when a package has no such rows we fall back
// to the legacy single `client_packages.service_id` (package-level pool).
async function quickBookClientPackages(slug: string, clientId: number): Promise<QuickBookClientPackage[]> {
  if (clientId <= 0) return [];
  let packageRows: RowDataPacket[] = [];
  try {
    const packageTable = await tenantTable(slug, "client_packages");
    const hasExpiry = await columnExists(packageTable.name, "expires_at");
    const expiry = hasExpiry ? " AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)" : "";
    packageRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "client_packages",
      columns: "id, package_name, sessions_remaining, service_id, expires_at",
      where: `client_id = ? AND status = 'active' AND sessions_remaining > 0${expiry}`,
      params: [clientId],
      orderBy: "(expires_at IS NULL) DESC, expires_at ASC, id DESC",
      limit: 50,
    });
  } catch {
    return [];
  }
  if (packageRows.length === 0) return [];

  // Per-service coverage rows (own sessions_remaining > 0) for all packages at once.
  const ids = packageRows.map((row) => Number(row.id ?? 0)).filter((id) => id > 0);
  const coverageByPackage = new Map<number, Array<{ serviceId: number; itemId: number }>>();
  if (ids.length > 0) {
    try {
      const placeholders = ids.map(() => "?").join(",");
      const coverageRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "client_package_services",
        columns: "id, client_package_id, service_id, sessions_remaining",
        where: `client_package_id IN (${placeholders}) AND sessions_remaining > 0`,
        params: ids,
        orderBy: "client_package_id ASC, sort_order ASC, id ASC",
      });
      for (const row of coverageRows) {
        const packageId = Number(row.client_package_id ?? 0);
        const serviceId = Number(row.service_id ?? 0);
        const itemId = Number(row.id ?? 0);
        if (packageId <= 0 || serviceId <= 0) continue;
        const list = coverageByPackage.get(packageId) ?? [];
        list.push({ serviceId, itemId });
        coverageByPackage.set(packageId, list);
      }
    } catch {
      // client_package_services may be absent (legacy single-service packages only).
    }
  }

  const out: QuickBookClientPackage[] = [];
  for (const row of packageRows) {
    const id = Number(row.id ?? 0);
    if (id <= 0) continue;
    const coverage = coverageByPackage.get(id) ?? [];
    const serviceIds: number[] = [];
    const serviceItemIds: Record<number, number> = {};
    if (coverage.length > 0) {
      for (const { serviceId, itemId } of coverage) {
        if (!serviceIds.includes(serviceId)) serviceIds.push(serviceId);
        // First (lowest sort_order) covering row wins for the pin id.
        if (serviceItemIds[serviceId] === undefined) serviceItemIds[serviceId] = itemId;
      }
    } else {
      // Legacy single-service package: cover only client_packages.service_id.
      const legacyServiceId = Number(row.service_id ?? 0);
      if (legacyServiceId > 0) serviceIds.push(legacyServiceId);
    }
    if (serviceIds.length === 0) continue; // nothing this package can cover -> not offerable
    out.push({
      id,
      name: String(row.package_name ?? "Pacchetto"),
      sessions_remaining: Math.max(0, Number(row.sessions_remaining ?? 0)),
      expires_at: row.expires_at ? String(row.expires_at).slice(0, 10) : null,
      service_ids: serviceIds,
      serviceItemIds,
    });
  }
  return out;
}

// Available (redeemable) prepaid-service balances for a client — drives the drawer's
// per-service "Usa prepagato" control. Port of api_clients.php action=residuals
// PREPAID block + ClientPrepaidServices::listAvailableForClient. Tenant-scoped via
// `tenantSelect`; every read is guarded so a missing table/column degrades to an
// empty list. "Available" mirrors the legacy WHERE exactly: status='active' AND
// remaining_qty > 0 AND (expires_at IS NULL OR expires_at >= CURRENT_DATE),
// client-scoped. A prepaid is tied to ONE service directly (service_id), so each
// returned entry covers exactly that one service (no per-service coverage table).
async function quickBookClientPrepaids(slug: string, clientId: number): Promise<QuickBookClientPrepaid[]> {
  if (clientId <= 0) return [];
  let prepaidRows: RowDataPacket[] = [];
  try {
    const prepaidTable = await tenantTable(slug, "client_prepaid_services");
    const hasExpiry = await columnExists(prepaidTable.name, "expires_at");
    const expiry = hasExpiry ? " AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)" : "";
    prepaidRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "client_prepaid_services",
      columns: "id, service_id, service_name, remaining_qty",
      where: `client_id = ? AND status = 'active' AND remaining_qty > 0${expiry}`,
      params: [clientId],
      orderBy: "(expires_at IS NULL) DESC, expires_at ASC, id DESC",
      limit: 100,
    });
  } catch {
    return [];
  }
  if (prepaidRows.length === 0) return [];

  const out: QuickBookClientPrepaid[] = [];
  for (const row of prepaidRows) {
    const id = Number(row.id ?? 0);
    const serviceId = Number(row.service_id ?? 0);
    if (id <= 0 || serviceId <= 0) continue; // a prepaid with no service can cover nothing
    out.push({
      id,
      service_id: serviceId,
      name: String(row.service_name ?? "Prepagato"),
      remaining_qty: Math.max(0, Number(row.remaining_qty ?? 0)),
    });
  }
  return out;
}

// Available (redeemable) GiftCards for a client — drives the drawer's APPOINTMENT-LEVEL
// "GiftCard" control. Port of api_clients.php action=residuals GIFTCARD block (the same
// availability rule the residuals summary counts at quickBookClientResidualsSummary).
// Tenant-scoped via `tenantSelect`; every read is guarded so a missing table/column
// degrades to an empty list. "Available" mirrors the legacy WHERE exactly:
//   (recipient_client_id | client_id) = ? AND status='active' AND balance > 0
//   AND (expires_at IS NULL OR expires_at >= CURRENT_DATE),
// client-scoped. A GiftCard is MONETARY (a spendable `balance`) and applies to the
// WHOLE appointment (one per appointment, an amount) — NOT per-service like package/
// prepaid. The recipient_client_id column (when present) is the target client; older
// installs fall back to client_id (the same column the residuals block chooses).
async function quickBookClientGiftcards(slug: string, clientId: number): Promise<QuickBookClientGiftcard[]> {
  if (clientId <= 0) return [];
  let giftcardRows: RowDataPacket[] = [];
  try {
    const giftcardTable = await tenantTable(slug, "giftcards");
    const hasRecipient = await columnExists(giftcardTable.name, "recipient_client_id");
    const hasExpiry = await columnExists(giftcardTable.name, "expires_at");
    const target = hasRecipient ? "recipient_client_id = ?" : "client_id = ?";
    const expiry = hasExpiry ? " AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)" : "";
    giftcardRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "giftcards",
      columns: "id, code, balance",
      where: `${target} AND status = 'active' AND balance > 0${expiry}`,
      params: [clientId],
      orderBy: "(expires_at IS NULL) DESC, expires_at ASC, id DESC",
      limit: 50,
    });
  } catch {
    return [];
  }
  if (giftcardRows.length === 0) return [];

  const out: QuickBookClientGiftcard[] = [];
  for (const row of giftcardRows) {
    const id = Number(row.id ?? 0);
    const balance = roundMoney(Math.max(0, Number(row.balance ?? 0)));
    if (id <= 0 || balance <= 0) continue; // a giftcard with no balance covers nothing
    out.push({
      id,
      code: String(row.code ?? ""),
      balance,
    });
  }
  return out;
}

// Available (redeemable) GiftBox ITEMS for a client — drives the drawer's per-service
// "Usa GiftBox" control. GiftBox is per-service + ITEM-based (like a package): a single
// giftbox item covers ONE service, consuming one unit. This adapts the residuals giftbox
// block (quickBookClientResidualsSummary), but exposes one entry PER ITEM (with its
// service_id) so the drawer can offer a giftbox on the service it covers. Tenant-scoped
// via tenantSelect; every read is guarded so a missing table/column degrades to an empty
// list. "Available" mirrors the legacy rule exactly: the instance is status='issued' and
// not expired and belongs to the client (recipient_client_id when set, else client_id),
// and the item's residual (giftbox_instance_items.qty MINUS giftBoxItemRedeemedUnits for
// that item) is > 0. Only SERVICE items (item_type='service' with a positive service_id)
// are offerable. Mirrors qb_giftbox_item_remaining + the residuals giftbox computation.
async function quickBookClientGiftboxes(slug: string, clientId: number): Promise<QuickBookClientGiftbox[]> {
  if (clientId <= 0) return [];
  let instances: RowDataPacket[] = [];
  try {
    if (!(await tableExists((await tenantTable(slug, "giftbox_instances")).name))) return [];
    const instanceTable = await tenantTable(slug, "giftbox_instances");
    const hasRecipient = await columnExists(instanceTable.name, "recipient_client_id");
    const hasExpiry = await columnExists(instanceTable.name, "expires_at");
    const target = hasRecipient
      ? "(recipient_client_id = ? OR (recipient_client_id IS NULL AND client_id = ?))"
      : "client_id = ?";
    const params = hasRecipient ? [clientId, clientId] : [clientId];
    const expiry = hasExpiry ? " AND (expires_at IS NULL OR expires_at >= NOW())" : "";
    instances = await tenantSelect<RowDataPacket>({
      slug,
      table: "giftbox_instances",
      columns: "id",
      where: `${target} AND status = 'issued'${expiry}`,
      params,
      orderBy: "(expires_at IS NULL) DESC, expires_at ASC, id DESC",
      limit: 100,
    });
  } catch {
    return [];
  }
  if (instances.length === 0) return [];

  const out: QuickBookClientGiftbox[] = [];
  for (const inst of instances) {
    const instanceId = Number(inst.id ?? 0);
    if (instanceId <= 0) continue;
    try {
      const items = await tenantSelect<RowDataPacket>({
        slug,
        table: "giftbox_instance_items",
        columns: "giftbox_item_id, item_type, service_id, qty, custom_label",
        where: "instance_id = ?",
        params: [instanceId],
        orderBy: "sort_order ASC, giftbox_item_id ASC",
      });
      for (const item of items) {
        const itemType = String(item.item_type ?? "service");
        if (itemType !== "service") continue; // only service items can cover a service
        const giftboxItemId = Number(item.giftbox_item_id ?? 0);
        const serviceId = Number(item.service_id ?? 0);
        if (giftboxItemId <= 0 || serviceId <= 0) continue;
        const totalQty = Math.max(0, Number(item.qty ?? 0));
        const redeemed = await giftBoxItemRedeemedUnits(slug, instanceId, giftboxItemId);
        if (totalQty - redeemed <= 0) continue; // exhausted -> not offerable
        const label = String(item.custom_label ?? "") || (await serviceNameById(slug, serviceId, "Servizio"));
        out.push({ instance_id: instanceId, giftbox_item_id: giftboxItemId, service_id: serviceId, name: label });
      }
    } catch {
      // tolerate giftbox item/redemption tables being absent for this instance
    }
  }
  return out;
}

// One normalized GIFT reward item (parity with Gifts::normalizeRewardItems): a reward
// has a `type` ('service' | 'product' | 'custom'), a positive `qty` (>= 1), and — for a
// SERVICE reward — a `service_id`. The reward's identity in a redeem is its ARRAY INDEX
// (`reward_item_index`) in the gift's reward_items_json, NOT a surrogate id. Only service
// rewards are redeemable into a booked service here (a free service is a reward).
type GiftRewardItem = { type: string; serviceId: number; qty: number };

// Parse a gift's reward_items_json (a JSON array on the `gifts` row) into normalized
// reward items, preserving ARRAY ORDER (the index is the reward_item_index). Mirrors
// Gifts::normalizeRewardItems: each item carries a type (defaulting to 'custom') and a
// qty (>= 1, defaulting to 1); a service reward additionally needs a positive service_id
// (service_id | reward_service_id). Non-array / unparseable JSON -> empty list. IMPORTANT:
// items are NOT filtered here (so a non-service reward still consumes an index) — the
// caller filters to service rewards by `type === 'service' && serviceId > 0`.
function parseGiftRewardItems(rawJson: unknown): GiftRewardItem[] {
  if (typeof rawJson !== "string") return [];
  const trimmed = rawJson.trim();
  if (!trimmed) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(decoded)) return [];
  const out: GiftRewardItem[] = [];
  for (const raw of decoded) {
    if (!raw || typeof raw !== "object") {
      out.push({ type: "custom", serviceId: 0, qty: 1 }); // keep the index stable
      continue;
    }
    const entry = raw as Record<string, unknown>;
    let type = String(entry.type ?? entry.reward_type ?? "custom").trim().toLowerCase();
    if (type !== "service" && type !== "product" && type !== "custom") type = "custom";
    let qty = Number.parseInt(String(entry.qty ?? entry.reward_qty ?? entry.quantity ?? 1), 10);
    if (!Number.isFinite(qty) || qty <= 0) qty = 1;
    if (qty > 1000000) qty = 1000000;
    const serviceId =
      type === "service" ? Number.parseInt(String(entry.service_id ?? entry.reward_service_id ?? 0), 10) || 0 : 0;
    out.push({ type, serviceId, qty });
  }
  return out;
}

// Units already REDEEMED for a SINGLE gift reward, keyed by the legacy composite
// (reward_item_index + service_id) — exactly Gifts::redeemedRewardQtyByInstance's key.
// The authoritative consumed count is SUM(qty) of appointment_gift_items rows for this
// instance whose redeemed_at IS NOT NULL and that target this reward_item_index +
// service_id. Recording a redeem (an appointment_gift_items row with redeemed_at set and
// qty 1 for that index/service) therefore makes this reflect the consumption, so a reward
// can never be double-redeemed within or across saves. Tolerates the tracking table being
// absent (-> 0). (The legacy also reads gift_transactions; the Next port does not write
// those, so appointment_gift_items is the single source of truth here.)
async function giftRewardRedeemedQty(
  slug: string,
  instanceId: number,
  rewardItemIndex: number,
  serviceId: number,
): Promise<number> {
  if (instanceId <= 0) return 0;
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "appointment_gift_items",
      columns: "COALESCE(SUM(qty), 0) AS c",
      where: "instance_id = ? AND reward_item_index = ? AND service_id = ? AND redeemed_at IS NOT NULL",
      params: [instanceId, rewardItemIndex, serviceId],
    });
    return Math.max(0, Number(rows[0]?.c ?? 0) || 0);
  } catch {
    return 0;
  }
}

// Unità PENDING per un reward (modello legacy pending-until-done): righe
// appointment_gift_items con redeemed_at NULL collegate a prenotazioni ancora
// aperte (In attesa/Prenotata). Riservano l'unità: una nuova prenotazione dello
// stesso premio oltre il residuo va rifiutata (Gifts ~11270-11279).
async function giftRewardPendingQty(
  slug: string,
  instanceId: number,
  rewardItemIndex: number,
  serviceId: number,
): Promise<number> {
  if (instanceId <= 0) return 0;
  try {
    const linkTable = await tenantTable(slug, "appointment_gift_items");
    const apptTable = await tenantTable(slug, "appointments");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT COALESCE(SUM(agi.qty), 0) AS c
         FROM ${quoteIdentifier(linkTable.name)} agi
         JOIN ${quoteIdentifier(apptTable.name)} a ON a.id = agi.appointment_id AND a.tenant_id = agi.tenant_id
        WHERE agi.tenant_id = ? AND agi.instance_id = ? AND agi.reward_item_index = ? AND agi.service_id = ?
          AND agi.redeemed_at IS NULL
          AND LOWER(COALESCE(a.status, '')) IN ('pending', 'scheduled')`,
      [linkTable.tenantId ?? 0, instanceId, rewardItemIndex, serviceId],
    );
    return Math.max(0, Number(rows[0]?.c ?? 0) || 0);
  } catch {
    return 0;
  }
}

// Available (redeemable) GIFT (omaggio) SERVICE REWARDS for a client — drives the drawer's
// per-service "Usa Omaggio" control. A gift INSTANCE holds REWARD ITEMS (the reward set
// lives in gifts.reward_items_json, joined from the instance's gift_id); a SERVICE reward
// (type='service', positive service_id) can be applied to a booked service (zero-charge).
// This exposes one entry PER still-available service reward (qty_remaining > 0) so the
// drawer can offer it on the service it covers. Tenant-scoped via tenantSelect; every read
// is guarded so a missing table/column degrades to an empty list.
//
// "Available" mirrors Gifts::clientAvailableInstances + listAvailableServiceRewardsForClient
// exactly: the instance belongs to the client (gift_instances.client_id), is state =
// 'disponibile' (the legacy normalizes derived state to this), (is_active = 1 OR state IN
// ('disponibile','riscattato')), and not expired (expires_at IS NULL OR by calendar day);
// then for each reward item of type 'service' with a positive service_id, qty_remaining =
// reward qty MINUS giftRewardRedeemedQty(index, service_id) must be > 0. `reward_item_index`
// is the reward's ARRAY INDEX in reward_items_json (parity with the legacy index).
async function quickBookClientGifts(slug: string, clientId: number): Promise<QuickBookClientGift[]> {
  if (clientId <= 0) return [];
  // SYNC-ON-READ (Gifts::syncClientProgressOnRead): riallinea la maturazione del
  // cliente PRIMA di elencare i disponibili (unlock maturati nel frattempo, scadenze).
  await giftRecalcClient(slug, clientId).catch(() => undefined);
  let instances: RowDataPacket[] = [];
  try {
    const giftTable = await tenantTable(slug, "gift_instances");
    if (!(await tableExists(giftTable.name))) return [];
    const hasState = await columnExists(giftTable.name, "state");
    const hasActive = await columnExists(giftTable.name, "is_active");
    const hasExpiry = await columnExists(giftTable.name, "expires_at");
    const clauses = ["client_id = ?"];
    if (hasState) clauses.push("state = 'disponibile'");
    if (hasActive && hasState) clauses.push("(is_active = 1 OR state IN ('disponibile','riscattato'))");
    else if (hasActive) clauses.push("is_active = 1");
    if (hasExpiry) clauses.push("(expires_at IS NULL OR expires_at >= CURRENT_DATE)");
    instances = await tenantSelect<RowDataPacket>({
      slug,
      table: "gift_instances",
      columns: "id, gift_id",
      where: clauses.join(" AND "),
      params: [clientId],
      orderBy: hasExpiry ? "(expires_at IS NULL) DESC, expires_at ASC, id DESC" : "id DESC",
      limit: 100,
    });
  } catch {
    return [];
  }
  if (instances.length === 0) return [];

  const out: QuickBookClientGift[] = [];
  for (const inst of instances) {
    const instanceId = Number(inst.id ?? 0);
    const giftId = Number(inst.gift_id ?? 0);
    if (instanceId <= 0 || giftId <= 0) continue;
    try {
      // The reward set lives on the gift definition (gifts.reward_items_json), joined by
      // the instance's gift_id (parity with Gifts::clientAvailableInstances' JOIN gifts).
      const giftRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "gifts",
        columns: "reward_items_json",
        where: "id = ?",
        params: [giftId],
        limit: 1,
      });
      const rewardItems = parseGiftRewardItems(giftRows[0]?.reward_items_json);
      for (let index = 0; index < rewardItems.length; index += 1) {
        const item = rewardItems[index];
        if (item.type !== "service" || item.serviceId <= 0) continue; // only service rewards cover a service
        // Residuo offribile = qty - riscattate - IN SOSPESO su prenotazioni aperte
        // (modello pending-until-done: una prenotazione aperta riserva l'unità).
        const redeemed = await giftRewardRedeemedQty(slug, instanceId, index, item.serviceId);
        const pending = await giftRewardPendingQty(slug, instanceId, index, item.serviceId);
        if (item.qty - redeemed - pending <= 0) continue; // exhausted -> not offerable
        const name = await serviceNameById(slug, item.serviceId, "Servizio");
        out.push({ instance_id: instanceId, reward_item_index: index, service_id: item.serviceId, name });
      }
    } catch {
      // tolerate the gifts row / tracking table being absent for this instance
    }
  }
  return out;
}

// Read-only residuals DETAIL for the quick-booking "Apri scheda" modal
// (#qbClientResidualsModal). Port of api_clients.php action=residuals's per-item
// payload, DISPLAY-ONLY (see QuickBookClientResidualsDetail): it returns the five
// sections (Servizi/Omaggi/GiftBox/GiftCard/Pacchetti) with per-item detail (name,
// remaining, total, expiry, source sale #) plus a Credito line. Every "available"
// WHERE mirrors the corresponding summary/helper EXACTLY so the modal's items line
// up 1:1 with the drawer's soft badges. Tenant-scoped via tenantSelect; each read
// is guarded so a missing table/column degrades to an empty section (never throws).
export async function quickBookClientResidualsDetail(
  slug: string,
  clientId: number,
): Promise<QuickBookClientResidualsDetail> {
  const out: QuickBookClientResidualsDetail = {
    services: [],
    gifts: [],
    giftboxes: [],
    giftcards: [],
    packages: [],
    credit: { available: 0, count: 0 },
  };
  if (clientId <= 0) return out;

  // --- Credito (clients.credit_balance) — same source as the summary badge. ---
  try {
    const { credit } = await dbWalletBalance(clientId, slug);
    const available = roundMoney(Math.max(0, credit));
    out.credit = { available, count: available > 0.00001 ? 1 : 0 };
  } catch {
    out.credit = { available: 0, count: 0 };
  }

  // --- Servizi prepagati (client_prepaid_services) — same WHERE as
  //     quickBookClientPrepaids / the summary, with the display columns. ---
  try {
    const prepaidTable = await tenantTable(slug, "client_prepaid_services");
    const hasExpiry = await columnExists(prepaidTable.name, "expires_at");
    const expiry = hasExpiry ? " AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)" : "";
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "client_prepaid_services",
      columns: "id, service_id, service_name, purchased_qty, remaining_qty, unit_price, sale_id, expires_at",
      where: `client_id = ? AND status = 'active' AND remaining_qty > 0${expiry}`,
      params: [clientId],
      orderBy: "(expires_at IS NULL) DESC, expires_at ASC, id DESC",
      limit: 100,
    });
    for (const row of rows) {
      const serviceId = Number(row.service_id ?? 0);
      const saleId = Number(row.sale_id ?? 0);
      out.services.push({
        id: Number(row.id ?? 0),
        service_id: serviceId,
        service_name: String(row.service_name ?? "") || (serviceId > 0 ? `Servizio #${serviceId}` : "Servizio"),
        remaining_qty: Math.max(0, Number(row.remaining_qty ?? 0)),
        purchased_qty: Math.max(0, Number(row.purchased_qty ?? 0)),
        unit_price: roundMoney(Math.max(0, Number(row.unit_price ?? 0))),
        sale_id: saleId > 0 ? saleId : null,
        expires_at: row.expires_at ? String(row.expires_at).slice(0, 10) : null,
      });
    }
  } catch {
    out.services = [];
  }

  // --- GiftCard (giftcards) — same WHERE as quickBookClientGiftcards / the summary. ---
  try {
    const giftcardTable = await tenantTable(slug, "giftcards");
    const hasRecipient = await columnExists(giftcardTable.name, "recipient_client_id");
    const hasExpiry = await columnExists(giftcardTable.name, "expires_at");
    const target = hasRecipient ? "recipient_client_id = ?" : "client_id = ?";
    const expiryClause = hasExpiry ? " AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)" : "";
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "giftcards",
      columns: "id, code, balance, expires_at",
      where: `${target} AND status = 'active' AND balance > 0${expiryClause}`,
      params: [clientId],
      orderBy: "(expires_at IS NULL) DESC, expires_at ASC, id DESC",
      limit: 50,
    });
    for (const row of rows) {
      const balance = roundMoney(Math.max(0, Number(row.balance ?? 0)));
      if (balance <= 0) continue;
      out.giftcards.push({
        id: Number(row.id ?? 0),
        code: String(row.code ?? ""),
        balance,
        expires_at: row.expires_at ? String(row.expires_at).slice(0, 10) : null,
      });
    }
  } catch {
    out.giftcards = [];
  }

  // --- Pacchetti (client_packages) — same WHERE as quickBookClientPackages / the
  //     summary; breakdown built from client_package_services (name: rem/tot). ---
  try {
    const packageTable = await tenantTable(slug, "client_packages");
    const hasExpiry = await columnExists(packageTable.name, "expires_at");
    const expiry = hasExpiry ? " AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)" : "";
    const packageRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "client_packages",
      columns: "id, package_name, sessions_total, sessions_remaining, sale_id, expires_at",
      where: `client_id = ? AND status = 'active' AND sessions_remaining > 0${expiry}`,
      params: [clientId],
      orderBy: "(expires_at IS NULL) DESC, expires_at ASC, id DESC",
      limit: 50,
    });
    const ids = packageRows.map((row) => Number(row.id ?? 0)).filter((id) => id > 0);
    const itemsByPackage = new Map<number, QuickBookResidualPackageItem[]>();
    if (ids.length > 0) {
      try {
        const placeholders = ids.map(() => "?").join(",");
        const itemRows = await tenantSelect<RowDataPacket>({
          slug,
          table: "client_package_services",
          columns: "client_package_id, service_id, sessions_total, sessions_remaining",
          where: `client_package_id IN (${placeholders})`,
          params: ids,
          orderBy: "client_package_id ASC, sort_order ASC, id ASC",
        });
        for (const row of itemRows) {
          const packageId = Number(row.client_package_id ?? 0);
          const serviceId = Number(row.service_id ?? 0);
          if (packageId <= 0) continue;
          const list = itemsByPackage.get(packageId) ?? [];
          list.push({
            service_id: serviceId,
            service_name: await serviceNameById(slug, serviceId, serviceId > 0 ? `Servizio #${serviceId}` : "Servizio"),
            sessions_remaining: Math.max(0, Number(row.sessions_remaining ?? 0)),
            sessions_total: Math.max(0, Number(row.sessions_total ?? 0)),
          });
          itemsByPackage.set(packageId, list);
        }
      } catch {
        // client_package_services may be absent (legacy single-service packages).
      }
    }
    for (const row of packageRows) {
      const id = Number(row.id ?? 0);
      if (id <= 0) continue;
      const items = itemsByPackage.get(id) ?? [];
      const saleId = Number(row.sale_id ?? 0);
      const breakdown = items
        .map((it) => `${it.service_name}: ${it.sessions_remaining}/${it.sessions_total}`)
        .join(" • ");
      out.packages.push({
        id,
        package_name: String(row.package_name ?? "") || "Pacchetto",
        sessions_remaining: Math.max(0, Number(row.sessions_remaining ?? 0)),
        sessions_total: Math.max(0, Number(row.sessions_total ?? 0)),
        expires_at: row.expires_at ? String(row.expires_at).slice(0, 10) : null,
        sale_id: saleId > 0 ? saleId : null,
        breakdown,
        items,
      });
    }
  } catch {
    out.packages = [];
  }

  // --- GiftBox (giftbox_instances + items) — same availability rule as the summary
  //     (issued, not expired, residual (qty - redeemed) > 0), one entry per instance
  //     with its non-exhausted SERVICE items. ---
  try {
    if (await tableExists((await tenantTable(slug, "giftbox_instances")).name)) {
      const instanceTable = await tenantTable(slug, "giftbox_instances");
      const hasRecipient = await columnExists(instanceTable.name, "recipient_client_id");
      const hasExpiry = await columnExists(instanceTable.name, "expires_at");
      const target = hasRecipient
        ? "(recipient_client_id = ? OR (recipient_client_id IS NULL AND client_id = ?))"
        : "client_id = ?";
      const params = hasRecipient ? [clientId, clientId] : [clientId];
      const expiry = hasExpiry ? " AND (expires_at IS NULL OR expires_at >= NOW())" : "";
      const instances = await tenantSelect<RowDataPacket>({
        slug,
        table: "giftbox_instances",
        columns: "id, giftbox_id, code, expires_at",
        where: `${target} AND status = 'issued'${expiry}`,
        params,
        orderBy: "(expires_at IS NULL) DESC, expires_at ASC, id DESC",
        limit: 100,
      });
      for (const inst of instances) {
        const instanceId = Number(inst.id ?? 0);
        if (instanceId <= 0) continue;
        try {
          const itemRows = await tenantSelect<RowDataPacket>({
            slug,
            table: "giftbox_instance_items",
            columns: "giftbox_item_id, item_type, service_id, qty, custom_label",
            where: "instance_id = ?",
            params: [instanceId],
            orderBy: "sort_order ASC, giftbox_item_id ASC",
          });
          const totalQty = itemRows.reduce((sum, it) => sum + Math.max(0, Number(it.qty ?? 0)), 0);
          const redeemedTotal = await giftBoxRedeemedUnits(slug, instanceId);
          const remaining = totalQty - redeemedTotal;
          if (remaining <= 0) continue; // not offerable / exhausted -> skip (parity with summary)

          const items: QuickBookResidualGiftboxItem[] = [];
          for (const it of itemRows) {
            if (String(it.item_type ?? "service") !== "service") continue;
            const giftboxItemId = Number(it.giftbox_item_id ?? 0);
            const serviceId = Number(it.service_id ?? 0);
            if (giftboxItemId <= 0 || serviceId <= 0) continue;
            const itemTotal = Math.max(0, Number(it.qty ?? 0));
            const itemRedeemed = await giftBoxItemRedeemedUnits(slug, instanceId, giftboxItemId);
            const itemRemaining = itemTotal - itemRedeemed;
            if (itemRemaining <= 0) continue;
            const label = String(it.custom_label ?? "") || (await serviceNameById(slug, serviceId, "Servizio"));
            items.push({ giftbox_item_id: giftboxItemId, service_id: serviceId, service_name: label, qty_remaining: itemRemaining, qty_total: itemTotal });
          }

          const giftboxId = Number(inst.giftbox_id ?? 0);
          const giftboxName = giftboxId > 0 ? await giftboxNameById(slug, giftboxId, "GiftBox") : "GiftBox";
          out.giftboxes.push({
            instance_id: instanceId,
            giftbox_name: giftboxName,
            code: String(inst.code ?? ""),
            remaining_qty: Math.max(0, remaining),
            total_qty: Math.max(0, totalQty),
            expires_at: inst.expires_at ? String(inst.expires_at).slice(0, 10) : null,
            items,
          });
        } catch {
          // tolerate the item/redemption tables being absent for this instance
        }
      }
    }
  } catch {
    out.giftboxes = [];
  }

  // --- Omaggi (gift service rewards) — reuse quickBookClientGifts (the exact
  //     available-instance + per-reward residual rule the summary counts), then
  //     enrich each entry with the gift name + a per-reward remaining/total. ---
  try {
    const gifts = await quickBookClientGifts(slug, clientId);
    for (const g of gifts) {
      const giftName = await giftNameByInstanceId(slug, g.instance_id, "Omaggio");
      out.gifts.push({
        instance_id: g.instance_id,
        reward_item_index: g.reward_item_index,
        service_id: g.service_id,
        gift_name: giftName,
        service_name: g.name,
        // quickBookClientGifts only returns still-available rewards; expose the
        // residual as >= 1 (the modal shows it as a soft badge). A precise
        // qty_total per reward isn't threaded by the redeem helper — 0 hides the "/n".
        qty_remaining: 1,
        qty_total: 0,
        expires_at: null,
      });
    }
  } catch {
    out.gifts = [];
  }

  return out;
}

// GiftBox definition name by id (giftboxes.name), tenant-scoped + schema-guarded.
async function giftboxNameById(slug: string, giftboxId: number, fallback: string): Promise<string> {
  if (giftboxId <= 0) return fallback;
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "giftboxes",
      columns: "name",
      where: "id = ?",
      params: [giftboxId],
      limit: 1,
    });
    const name = String(rows[0]?.name ?? "").trim();
    return name || fallback;
  } catch {
    return fallback;
  }
}

// Gift definition name for a gift INSTANCE (gift_instances.gift_id -> gifts.name),
// tenant-scoped + schema-guarded. Used to label the "Omaggi" residuals section.
async function giftNameByInstanceId(slug: string, instanceId: number, fallback: string): Promise<string> {
  if (instanceId <= 0) return fallback;
  try {
    const instRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "gift_instances",
      columns: "gift_id",
      where: "id = ?",
      params: [instanceId],
      limit: 1,
    });
    const giftId = Number(instRows[0]?.gift_id ?? 0);
    if (giftId <= 0) return fallback;
    const giftRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "gifts",
      columns: "name",
      where: "id = ?",
      params: [giftId],
      limit: 1,
    });
    const name = String(giftRows[0]?.name ?? "").trim();
    return name || fallback;
  } catch {
    return fallback;
  }
}
