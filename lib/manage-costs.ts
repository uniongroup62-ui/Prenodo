import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { emptyToNull, parseInteger } from "@/lib/api-utils";
import { businessNowDateTime, businessTodayIso } from "@/lib/business-datetime";
import { getManageLocationContext } from "@/lib/manage-locations";
import {
  columnExists,
  dbQuery,
  quoteIdentifier,
  tenantDelete,
  tenantInsert,
  tenantSelect,
  tenantTable,
  tenantUpdate,
} from "@/lib/tenant-db";

type TenantTarget = Awaited<ReturnType<typeof tenantTable>>;

export type CostStatus = "open" | "overdue" | "paid";
export type RecurrenceUnit = "day" | "week" | "month" | "year";

export type ManageCostsContext = {
  ok: true;
  sourceMode: "database";
  activeLocationId: number;
  filters: {
    from: string;
    to: string;
    status: "open" | "overdue" | "paid" | "all";
    query: string;
    categoryId: number;
  };
  summary: {
    open: number;
    overdue: number;
    paid: number;
    dueAmount: number;
    overdueAmount: number;
    paidAmount: number;
    remainingAmount: number;
  };
  costs: CostRow[];
  categories: CostCategoryRow[];
  suppliers: CostSupplierRow[];
  locations: CostLocationRow[];
  // COUNT dei costi nello scope sede, INDIPENDENTE dai filtri — è il gate legacy
  // $hasAnyCostsInScope per l'empty-state e per il bottone "Nuovo costo" in header.
  hasAnyCosts: boolean;
};

export type CostRow = {
  id: number;
  title: string;
  categoryId: number | null;
  categoryName: string;
  categoryColor: string;
  supplierId: number | null;
  supplierName: string;
  amount: number;
  paidAmount: number;
  remainingAmount: number;
  vatPercent: number | null;
  dueDate: string;
  status: CostStatus;
  isPaid: boolean;
  isPartial: boolean;
  paidAt: string;
  paymentMethod: string;
  docNumber: string;
  docDate: string;
  notes: string;
  isRecurring: boolean;
  recurrenceInterval: number;
  recurrenceUnit: RecurrenceUnit;
  recurrenceEndDate: string;
  locationId: number | null;
  locationName: string;
  attachmentName: string;
  attachmentSize: number;
  createdAt: string;
};

export type CostCategoryRow = {
  id: number;
  name: string;
  color: string;
  isActive: boolean;
  costCount: number;
};

export type CostSupplierRow = {
  id: number;
  name: string;
  isActive: boolean;
  isActiveCosts: boolean;
  costLocationIds: number[];
};

export type CostLocationRow = {
  id: number;
  name: string;
  isActive: boolean;
};


export async function getManageCostsContext(
  slug: string,
  options: {
    from?: string;
    to?: string;
    status?: string;
    query?: string;
    categoryId?: number;
    locationId?: number;
    allLocations?: boolean;
  } = {},
): Promise<ManageCostsContext> {
  const locations = await listCostLocations(slug);
  // "Tutte le sedi" (all_locations): locationId=0 -> buildLocationScope scopa a IN(sedi permesse)
  // OR NULL. Altrimenti forza la sede corrente (normalizeLocationId).
  const activeLocationId = options.allLocations ? 0 : normalizeLocationId(options.locationId ?? 0, locations);
  const filters = normalizeCostFilters(options);
  const [costs, categories, suppliers, hasAnyCosts] = await Promise.all([
    listCosts(slug, { ...filters, locationId: activeLocationId, locations }),
    listCostCategories(slug),
    listCostSuppliers(slug),
    hasAnyCostsInScope(slug, activeLocationId, locations),
  ]);

  return {
    ok: true,
    sourceMode: "database",
    activeLocationId,
    filters,
    summary: summarizeCosts(costs),
    costs,
    categories,
    suppliers,
    locations,
    hasAnyCosts,
  };
}

// Port di $hasAnyCostsInScope (costs.php ~1393-1405): COUNT nello scope sede,
// senza filtri di periodo/stato.
async function hasAnyCostsInScope(slug: string, locationId: number, locations: CostLocationRow[]): Promise<boolean> {
  try {
    const table = await tenantTable(slug, "costs");
    const clauses: string[] = ["1=1"];
    const params: unknown[] = [];
    if (await columnExists(table.name, "location_id")) {
      const scope = buildLocationScope("location_id", locationId, locations);
      if (scope.sql) {
        clauses.push(scope.sql);
        params.push(...scope.params);
      }
    }
    const scoped = await tenantScope(table, clauses, params);
    const rows = await dbQuery<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)}${scoped.where}`, scoped.params);
    return Number(rows[0]?.count ?? 0) > 0;
  } catch {
    return true;
  }
}

// Edit-form prefill: return ONE cost's editable fields for one id. Port of
// costs.php action=edit ($editCost). Mirrors the CostRow shape used by the list
// so the faithful cost_form-content.tsx can hydrate every field.
export async function getManageCost(slug: string, costId: number, locationId = 0, allowedIds: number[] | null = null): Promise<CostRow | null> {
  if (costId <= 0) return null;
  // SCOPE SEDE: un costo di un'altra sede non e' recuperabile (come il legacy loadCost scoped).
  const row = await getCostById(slug, costId, locationId, allowedIds).catch(() => null);
  if (!row) return null;
  // getCostById fa SELECT * (nessun JOIN): recupera il NOME del fornitore per il prefill di modifica
  // (serve al form per mostrare/preservare un fornitore inattivo con "(non attivo o non abilitato)").
  if (row.supplier_id && !row.supplier_name) {
    const sup = await tenantSelect<RowDataPacket>({ slug, table: "suppliers", columns: "name", where: "id=?", params: [Number(row.supplier_id)], limit: 1 }).catch(() => [] as RowDataPacket[]);
    if (sup[0]) row.supplier_name = sup[0].name;
  }
  return mapCost(row);
}

export async function saveCost(slug: string, body: Record<string, string>, scopeLocationId = 0, allowedIds: number[] | null = null): Promise<ManageCostsContext> {
  const table = await tenantTable(slug, "costs");
  const id = parseInteger(body.id ?? body.cost_id, 0);
  // In modifica, il costo esistente deve appartenere alla sede dell'utente (scope) -> altrimenti
  // "Costo non trovato" (impedisce a un utente di una sede di modificare/spostare costi di altre).
  const existing = id > 0 ? await getCostById(slug, id, scopeLocationId, allowedIds) : null;
  const input = await normalizeCostInput(slug, body, existing);
  const values = await filterColumns(table.name, {
    title: input.title,
    category_id: input.categoryId,
    supplier_id: input.supplierId,
    location_id: input.locationId || null,
    amount: input.amount,
    paid_amount: input.paidAmount,
    vat_percent: input.vatPercent,
    due_date: input.dueDate,
    is_paid: input.isPaid ? 1 : 0,
    // Ora di ROMA esplicita (classe TZ server-safe: Date al driver = wall del server).
    paid_at: input.isPaid ? (existing?.paid_at ?? businessNowDateTime()) : null,
    payment_method: emptyToNull(input.paymentMethod),
    doc_number: emptyToNull(input.docNumber),
    doc_date: input.docDate,
    notes: emptyToNull(input.notes),
    is_recurring: input.isRecurring ? 1 : 0,
    recurrence_interval: input.recurrenceInterval,
    recurrence_unit: input.recurrenceUnit,
    recurrence_end_date: input.recurrenceEndDate,
  });

  if (id > 0) {
    await tenantUpdate({ slug, table: "costs", id, values });
  } else {
    await tenantInsert(table, values);
  }

  return getManageCostsContext(slug, { locationId: input.locationId, status: "open" });
}

export async function deleteCost(slug: string, costId: number, locationId = 0, allowedIds: number[] | null = null): Promise<ManageCostsContext> {
  // Messaggio pagina legacy (redirect ?err=Costo non trovato) per id invalido o mancante.
  if (costId <= 0) throw new Error("Costo non trovato");
  const row = await getCostById(slug, costId, locationId, allowedIds);
  await tenantDelete({ slug, table: "costs", id: costId });
  await deleteCostAttachmentObject(row).catch(() => undefined);
  return getManageCostsContext(slug, { locationId, status: "open" });
}

// Bulk-delete costs (faithful to costs.php bulk_delete_costs ~686-715): delete every selected cost
// that exists + is accessible; missing/foreign ids are silently skipped (the legacy tolerance), and
// if NONE are deletable it errors like the legacy "Nessuna voce autorizzata da eliminare". Like the
// legacy file cleanup, each deleted cost's R2 attachment object is removed best-effort.
export async function deleteCostsBulk(slug: string, costIds: number[], locationId = 0, allowedIds: number[] | null = null): Promise<ManageCostsContext> {
  const ids = [...new Set(costIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) throw new Error("Seleziona almeno una voce");
  let deleted = 0;
  for (const id of ids) {
    const row = await getCostById(slug, id, locationId, allowedIds).catch(() => null);
    if (row) {
      await tenantDelete({ slug, table: "costs", id }).catch(() => 0);
      await deleteCostAttachmentObject(row).catch(() => undefined);
      deleted += 1;
    }
  }
  if (deleted === 0) throw new Error("Nessuna voce autorizzata da eliminare");
  return getManageCostsContext(slug, { locationId, status: "open" });
}

// Best-effort cleanup of the R2 private object referenced by a deleted cost
// (legacy $deleteCostAttachments unlink). Legacy /uploads paths are skipped.
async function deleteCostAttachmentObject(row: RowDataPacket): Promise<void> {
  const path = String(row.attachment_path ?? "").trim();
  if (!/^t\d+\//.test(path)) return;
  const { deletePrivateObject } = await import("@/lib/storage");
  await deletePrivateObject(path);
}

export async function toggleCostPaid(slug: string, costId: number, locationId = 0, allowedIds: number[] | null = null): Promise<ManageCostsContext> {
  const row = await getCostById(slug, costId, locationId, allowedIds);
  const isPaid = Number(row.is_paid ?? 0) === 1;

  if (isPaid) {
    await tenantUpdate({ slug, table: "costs", id: costId, values: { is_paid: 0, paid_amount: 0, paid_at: null } });
    return getManageCostsContext(slug, { locationId: locationId || Number(row.location_id ?? 0), status: "open" });
  }

  const amount = roundMoney(Number(row.amount ?? 0) || 0);
  // Legacy: paid_at=COALESCE(paid_at, NOW()) — un paid_at preesistente viene conservato.
  await tenantUpdate({ slug, table: "costs", id: costId, values: { is_paid: 1, paid_amount: amount, paid_at: row.paid_at ?? businessNowDateTime() } });
  if (Number(row.is_recurring ?? 0) === 1) await createNextRecurringCost(slug, row);

  return getManageCostsContext(slug, { locationId: locationId || Number(row.location_id ?? 0), status: "open" });
}

// Bulk categorie (costs.php bulk_deactivate_categories / bulk_delete_categories).
export async function deactivateCostCategoriesBulk(slug: string, categoryIds: number[]): Promise<ManageCostsContext> {
  const ids = [...new Set(categoryIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) throw new Error("Seleziona almeno una categoria");
  for (const id of ids) {
    await tenantUpdate({ slug, table: "cost_categories", id, values: { is_active: 0 } }).catch(() => 0);
  }
  return getManageCostsContext(slug, { status: "open" });
}

export async function deleteCostCategoriesBulk(slug: string, categoryIds: number[]): Promise<ManageCostsContext> {
  const ids = [...new Set(categoryIds.filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) throw new Error("Seleziona almeno una categoria");
  let blockedTotal = 0;
  for (const id of ids) {
    blockedTotal += await countRowsByColumn(slug, "costs", "category_id", id);
  }
  if (blockedTotal > 0) {
    throw new Error(`Una o piu categorie sono associate a ${blockedTotal} costi e non possono essere eliminate. Disattivale per non usarle nei nuovi costi.`);
  }
  for (const id of ids) {
    await tenantDelete({ slug, table: "cost_categories", id }).catch(() => 0);
  }
  return getManageCostsContext(slug, { status: "open" });
}

export async function saveCostCategory(slug: string, body: Record<string, string>): Promise<ManageCostsContext> {
  const table = await tenantTable(slug, "cost_categories");
  const id = parseInteger(body.id ?? body.category_id, 0);
  const name = clean(body.name, 80);
  const color = clean(body.color, 20);
  if (!name) throw new Error("Nome categoria obbligatorio");
  if (color && !/^#[0-9A-Fa-f]{6}$/.test(color)) throw new Error("Colore categoria non valido");
  await ensureCostCategoryNameAvailable(slug, name, id);

  const values = await filterColumns(table.name, {
    name,
    color: emptyToNull(color),
    is_active: truthy(body.is_active ?? "1") ? 1 : 0,
  });
  if (id > 0) {
    await tenantUpdate({ slug, table: "cost_categories", id, values });
  } else {
    await tenantInsert(table, values);
  }
  return getManageCostsContext(slug, { status: "open" });
}

export async function deleteCostCategory(slug: string, categoryId: number): Promise<ManageCostsContext> {
  if (categoryId <= 0) throw new Error("Categoria non trovata");
  const linked = await countRowsByColumn(slug, "costs", "category_id", categoryId);
  // Verbatim legacy (costs.php ~1026).
  if (linked > 0) throw new Error(`Categoria associata a ${linked} costi: non puo essere eliminata. Disattivala per non usarla nei nuovi costi.`);
  await tenantDelete({ slug, table: "cost_categories", id: categoryId });
  return getManageCostsContext(slug, { status: "open" });
}

export async function toggleCostCategory(slug: string, categoryId: number): Promise<ManageCostsContext> {
  if (categoryId <= 0) throw new Error("Categoria non trovata");
  const row = await getCostCategoryById(slug, categoryId);
  await tenantUpdate({ slug, table: "cost_categories", id: categoryId, values: { is_active: Number(row.is_active ?? 1) === 1 ? 0 : 1 } });
  return getManageCostsContext(slug, { status: "open" });
}

async function listCosts(
  slug: string,
  options: {
    from: string;
    to: string;
    status: "open" | "overdue" | "paid" | "all";
    query: string;
    categoryId: number;
    locationId: number;
    locations: CostLocationRow[];
  },
): Promise<CostRow[]> {
  const table = await tenantTable(slug, "costs");
  const categoryTable = await tenantTable(slug, "cost_categories").catch(() => null);
  const supplierTable = await tenantTable(slug, "suppliers").catch(() => null);
  const locationTable = await tenantTable(slug, "locations").catch(() => null);
  const hasLocation = await columnExists(table.name, "location_id");
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.push("c.tenant_id=?");
    params.push(table.tenantId ?? 0);
  }

  if (options.status === "open") {
    clauses.push("c.due_date <= ? AND (c.due_date >= ? OR c.due_date < ?) AND COALESCE(c.is_paid,0)=0");
    params.push(options.to, options.from, todayIso());
  } else if (options.status === "overdue") {
    clauses.push("c.due_date < ? AND COALESCE(c.is_paid,0)=0");
    params.push(todayIso());
  } else if (options.status === "paid") {
    clauses.push("c.due_date BETWEEN ? AND ? AND COALESCE(c.is_paid,0)=1");
    params.push(options.from, options.to);
  } else {
    clauses.push("c.due_date BETWEEN ? AND ?");
    params.push(options.from, options.to);
  }

  if (options.categoryId > 0) {
    clauses.push("c.category_id=?");
    params.push(options.categoryId);
  }

  // Legacy: la ricerca copre SOLO titolo e numero documento (non il fornitore). Accent-insensitive
  // via translate() (folding) su colonna e termine, come utf8_general_ci del legacy.
  if (options.query) {
    const q = `%${foldCostAccents(options.query)}%`;
    clauses.push(`(${foldCostAccentsSql("c.title")} LIKE ? OR ${foldCostAccentsSql("COALESCE(c.doc_number,'')")} LIKE ?)`);
    params.push(q, q);
  }

  if (hasLocation) {
    const locationScope = buildLocationScope("c.location_id", options.locationId, options.locations);
    if (locationScope.sql) {
      clauses.push(locationScope.sql);
      params.push(...locationScope.params);
    }
  }

  const categoryJoin = categoryTable
    ? `LEFT JOIN ${quoteIdentifier(categoryTable.name)} cat ON cat.id=c.category_id${categoryTable.mode === "shared" && await columnExists(categoryTable.name, "tenant_id") ? " AND cat.tenant_id=c.tenant_id" : ""}`
    : "";
  const supplierJoin = supplierTable
    ? `LEFT JOIN ${quoteIdentifier(supplierTable.name)} s ON s.id=c.supplier_id${supplierTable.mode === "shared" && await columnExists(supplierTable.name, "tenant_id") ? " AND s.tenant_id=c.tenant_id" : ""}`
    : "";
  const locationJoin = locationTable && hasLocation
    ? `LEFT JOIN ${quoteIdentifier(locationTable.name)} l ON l.id=c.location_id${locationTable.mode === "shared" && await columnExists(locationTable.name, "tenant_id") ? " AND l.tenant_id=c.tenant_id" : ""}`
    : "";

  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT c.*, cat.name AS category_name, cat.color AS category_color, s.name AS supplier_name, l.name AS location_name
       FROM ${quoteIdentifier(table.name)} c
       ${categoryJoin}
       ${supplierJoin}
       ${locationJoin}
      WHERE ${clauses.join(" AND ")}
      ORDER BY c.due_date ASC, COALESCE(c.is_paid,0) ASC, c.id ASC`,
    params,
  );
  return rows.map(mapCost);
}

async function listCostCategories(slug: string): Promise<CostCategoryRow[]> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "cost_categories", columns: "*", orderBy: "name ASC, id ASC" }).catch(() => []);
  const counts = await costCategoryCounts(slug, rows.map((row) => Number(row.id ?? 0)));
  return rows.map((row) => {
    const id = Number(row.id ?? 0);
    return {
      id,
      name: String(row.name ?? ""),
      // Colore GREZZO (vuoto se NULL) come il legacy: la UI mostra "—" nel badge e usa #6c757d
      // come default nell'edit. Prima iniettava "#0f766e" -> badge colorato invece di "—".
      color: row.color ? String(row.color) : "",
      isActive: Number(row.is_active ?? 1) === 1,
      costCount: counts.get(id) ?? 0,
    };
  });
}

async function listCostSuppliers(slug: string): Promise<CostSupplierRow[]> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "suppliers", columns: "id,name,is_active,is_active_costs", orderBy: "name ASC, id ASC" }).catch(() => []);
  const locationMaps = await supplierCostLocationMaps(slug, rows.map((row) => Number(row.id ?? 0)));
  return rows.map((row) => {
    const id = Number(row.id ?? 0);
    return {
      id,
      name: String(row.name ?? ""),
      isActive: Number(row.is_active ?? 1) === 1,
      isActiveCosts: Number(row.is_active_costs ?? row.is_active ?? 1) === 1,
      costLocationIds: locationMaps.get(id) ?? [],
    };
  });
}

async function listCostLocations(slug: string): Promise<CostLocationRow[]> {
  const context = await getManageLocationContext(slug);
  return context.locations.map((location) => ({ id: location.id, name: location.name, isActive: true }));
}

function mapCost(row: RowDataPacket): CostRow {
  const amount = roundMoney(Number(row.amount ?? 0) || 0);
  const paidAmount = roundMoney(Number(row.paid_amount ?? (Number(row.is_paid ?? 0) === 1 ? amount : 0)) || 0);
  const dueDate = dateString(row.due_date) || todayIso();
  // Legacy: lo stato dipende SOLO da is_paid (un totale 0 non-pagato resta "Da pagare").
  const isPaid = Number(row.is_paid ?? 0) === 1;
  const remainingAmount = roundMoney(Math.max(0, amount - paidAmount));
  const status: CostStatus = isPaid ? "paid" : dueDate < todayIso() ? "overdue" : "open";
  return {
    id: Number(row.id ?? 0),
    title: String(row.title ?? ""),
    categoryId: nullableNumber(row.category_id),
    // Vuote come il legacy (la cella rende "—"): NIENTE default inventati.
    categoryName: String(row.category_name ?? ""),
    categoryColor: String(row.category_color ?? ""),
    supplierId: nullableNumber(row.supplier_id),
    supplierName: String(row.supplier_name ?? ""),
    amount,
    paidAmount,
    remainingAmount,
    vatPercent: nullableNumber(row.vat_percent),
    dueDate,
    status,
    isPaid,
    isPartial: !isPaid && paidAmount > 0,
    paidAt: dateTimeString(row.paid_at),
    paymentMethod: String(row.payment_method ?? ""),
    docNumber: String(row.doc_number ?? ""),
    docDate: dateString(row.doc_date),
    notes: String(row.notes ?? ""),
    isRecurring: Number(row.is_recurring ?? 0) === 1,
    recurrenceInterval: Math.max(1, Number(row.recurrence_interval ?? 1) || 1),
    recurrenceUnit: normalizeRecurrenceUnit(row.recurrence_unit),
    recurrenceEndDate: dateString(row.recurrence_end_date),
    locationId: nullableNumber(row.location_id),
    locationName: row.location_id ? String(row.location_name ?? `Sede #${row.location_id}`) : "Tutte le sedi",
    attachmentName: String(row.attachment_name ?? ""),
    attachmentSize: Number(row.attachment_size ?? 0) || 0,
    createdAt: dateTimeString(row.created_at),
  };
}

async function normalizeCostInput(slug: string, body: Record<string, string>, existing: RowDataPacket | null) {
  // Messaggi VERBATIM legacy (querystring ?err=..., senza punto finale).
  const title = clean(body.title, 190);
  if (!title) throw new Error("Titolo obbligatorio");
  const amount = parseMoneyOrNull(body.amount);
  if (amount === null || amount < 0) throw new Error("Totale non valido");
  const vatRaw = clean(body.vat_percent, 20);
  const vatPercent = vatRaw ? parsePercent(vatRaw) : null;
  if (vatRaw && vatPercent === null) throw new Error("IVA non valida");
  if (vatPercent !== null && (vatPercent < 0 || vatPercent > 100)) throw new Error("IVA non valida");
  const dueDate = normalizeDate(body.due_date);
  if (!dueDate) throw new Error("Data scadenza non valida");
  const docDate = normalizeDate(body.doc_date);
  if (body.doc_date && !docDate) throw new Error("Data documento non valida");
  const locationId = await normalizeCostLocationId(slug, body.location_id);
  const categoryId = parseInteger(body.category_id, 0) || null;
  if (categoryId) await ensureCostCategoryUsable(slug, categoryId, existing);
  const supplierId = parseInteger(body.supplier_id, 0) || null;
  if (supplierId) await ensureSupplierUsable(slug, supplierId, locationId, existing);

  const trackPayments = truthy(body.track_payments);
  let paidAmount = 0;
  let isPaid = truthy(body.is_paid);
  if (trackPayments) {
    const rawPaid = parseMoneyOrNull(body.paid_amount, true);
    if (rawPaid === null || rawPaid < 0) throw new Error("Importo gia pagato non valido");
    paidAmount = Math.min(amount, rawPaid);
    isPaid = paidAmount + 0.00001 >= amount;
    if (isPaid) paidAmount = amount;
  } else {
    paidAmount = isPaid ? amount : 0;
  }

  const isRecurring = truthy(body.is_recurring);
  const recurrenceInterval = Math.max(1, parseInteger(body.recurrence_interval, 1));
  const recurrenceUnit = normalizeRecurrenceUnit(body.recurrence_unit);
  const recurrenceEndDate = truthy(body.recurrence_end_never) ? null : normalizeDate(body.recurrence_end_date);
  if (body.recurrence_end_date && !recurrenceEndDate && !truthy(body.recurrence_end_never)) throw new Error("Fine ricorrenza non valida");
  if (recurrenceEndDate && recurrenceEndDate < dueDate) throw new Error("Fine ricorrenza precedente alla scadenza");

  return {
    title,
    amount,
    paidAmount,
    vatPercent,
    dueDate,
    paymentMethod: clean(body.payment_method, 60),
    docNumber: clean(body.doc_number, 80),
    docDate,
    notes: cleanLong(body.notes, 5000),
    isPaid,
    isRecurring,
    recurrenceInterval,
    recurrenceUnit,
    recurrenceEndDate,
    categoryId,
    supplierId,
    locationId,
  };
}

async function normalizeCostLocationId(slug: string, value: unknown): Promise<number> {
  const locations = await listCostLocations(slug);
  const id = parseInteger(value, 0) || normalizeLocationId(0, locations);
  if (id <= 0 || !locations.some((location) => location.id === id)) throw new Error("Sede non valida o non autorizzata");
  return id;
}

async function ensureCostCategoryUsable(slug: string, categoryId: number, existing: RowDataPacket | null): Promise<void> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "cost_categories", where: "id=?", params: [categoryId], limit: 1 }).catch(() => []);
  // Verbatim pagina legacy: categoria inesistente sul salvataggio costo.
  if (!rows[0]) throw new Error("Categoria non valida");
  const keepsExisting = existing && Number(existing.category_id ?? 0) === categoryId;
  if (Number(rows[0].is_active ?? 1) !== 1 && !keepsExisting) {
    throw new Error("Categoria disattivata: non puo essere usata su nuovi costi");
  }
}

async function ensureSupplierUsable(slug: string, supplierId: number, locationId: number, existing: RowDataPacket | null): Promise<void> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "suppliers", where: "id=?", params: [supplierId], limit: 1 }).catch(() => []);
  const supplier = rows[0];
  if (!supplier) throw new Error("Fornitore non valido");
  const keepsExisting = existing && Number(existing.supplier_id ?? 0) === supplierId && Number(existing.location_id ?? 0) === locationId;
  if (!keepsExisting && Number(supplier.is_active_costs ?? supplier.is_active ?? 1) !== 1) {
    throw new Error("Fornitore disattivato per Scadenziario e Costi");
  }
  const maps = await supplierCostLocationMaps(slug, [supplierId]);
  const allowed = maps.get(supplierId) ?? [];
  if (!keepsExisting && allowed.length && locationId > 0 && !allowed.includes(locationId)) {
    throw new Error("Fornitore non abilitato per questa sede");
  }
}

async function getCostById(slug: string, id: number, locationId = 0, allowedIds: number[] | null = null): Promise<RowDataPacket> {
  // SCOPE SEDE (port del $costBuildLocationScope legacy applicato a ogni fetch-by-id): un costo
  // di un'altra sede -> row assente -> "Costo non trovato" (come il legacy). NULL-permissiva.
  // - modalita "Tutte le sedi" (allowedIds != null): scope alle sedi PERMESSE dell'utente.
  // - modalita singola sede (allowedIds == null): scope alla sede corrente.
  let where = "id=?";
  const params: unknown[] = [id];
  const table = await tenantTable(slug, "costs");
  if (await columnExists(table.name, "location_id")) {
    if (allowedIds !== null) {
      if (allowedIds.length > 0) {
        where += ` AND (location_id IN (${allowedIds.map(() => "?").join(",")}) OR location_id IS NULL)`;
        params.push(...allowedIds);
      }
    } else if (locationId > 0) {
      where += " AND (location_id = ? OR location_id IS NULL)";
      params.push(locationId);
    }
  }
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "costs", where, params, limit: 1 });
  if (!rows[0]) throw new Error("Costo non trovato");
  return rows[0];
}

async function getCostCategoryById(slug: string, id: number): Promise<RowDataPacket> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "cost_categories", where: "id=?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Categoria non trovata");
  return rows[0];
}

async function createNextRecurringCost(slug: string, row: RowDataPacket): Promise<void> {
  const dueDate = dateString(row.due_date);
  if (!dueDate) return;
  const next = nextDueDate(dueDate, Math.max(1, Number(row.recurrence_interval ?? 1) || 1), normalizeRecurrenceUnit(row.recurrence_unit));
  const endDate = dateString(row.recurrence_end_date);
  if (endDate && next > endDate) return;
  if (await recurringCostExists(slug, row, next)) return;

  const table = await tenantTable(slug, "costs");
  await tenantInsert(table, await filterColumns(table.name, {
    title: row.title,
    category_id: row.category_id ?? null,
    supplier_id: row.supplier_id ?? null,
    location_id: row.location_id ?? null,
    amount: row.amount,
    paid_amount: 0,
    vat_percent: row.vat_percent ?? null,
    due_date: next,
    is_paid: 0,
    paid_at: null,
    payment_method: row.payment_method ?? null,
    doc_number: null,
    doc_date: null,
    notes: row.notes ?? null,
    is_recurring: 1,
    recurrence_interval: Math.max(1, Number(row.recurrence_interval ?? 1) || 1),
    recurrence_unit: normalizeRecurrenceUnit(row.recurrence_unit),
    recurrence_end_date: row.recurrence_end_date ?? null,
  }));
}

async function recurringCostExists(slug: string, row: RowDataPacket, dueDate: string): Promise<boolean> {
  const table = await tenantTable(slug, "costs");
  const clauses = [
    "title=?",
    "due_date=?",
    "COALESCE(is_recurring,0)=1",
    "recurrence_interval=?",
    "recurrence_unit=?",
    "ABS(amount - ?) < 0.005",
  ];
  const params: unknown[] = [
    String(row.title ?? ""),
    dueDate,
    Math.max(1, Number(row.recurrence_interval ?? 1) || 1),
    normalizeRecurrenceUnit(row.recurrence_unit),
    Number(row.amount ?? 0) || 0,
  ];
  addNullableClause(clauses, params, "category_id", row.category_id);
  addNullableClause(clauses, params, "supplier_id", row.supplier_id);
  if (await columnExists(table.name, "location_id")) addNullableClause(clauses, params, "location_id", row.location_id);
  const scope = await tenantScope(table, clauses, params);
  const rows = await dbQuery<RowDataPacket[]>(`SELECT 1 FROM ${quoteIdentifier(table.name)}${scope.where} LIMIT 1`, scope.params);
  return rows.length > 0;
}

function addNullableClause(clauses: string[], params: unknown[], column: string, value: unknown): void {
  const numeric = nullableNumber(value);
  if (numeric === null) {
    clauses.push(`${quoteIdentifier(column)} IS NULL`);
  } else {
    clauses.push(`${quoteIdentifier(column)}=?`);
    params.push(numeric);
  }
}

async function ensureCostCategoryNameAvailable(slug: string, name: string, id: number): Promise<void> {
  const clauses = ["LOWER(name)=LOWER(?)"];
  const params: unknown[] = [name];
  if (id > 0) {
    clauses.push("id<>?");
    params.push(id);
  }
  const target = await tenantTable(slug, "cost_categories");
  const scope = await tenantScope(target, clauses, params);
  const rows = await dbQuery<RowDataPacket[]>(`SELECT id FROM ${quoteIdentifier(target.name)}${scope.where} LIMIT 1`, scope.params);
  if (rows[0]) throw new Error("Esiste gia una categoria con questo nome.");
}

async function costCategoryCounts(slug: string, ids: number[]): Promise<Map<number, number>> {
  const uniqueIds = ids.filter((id) => id > 0);
  const out = new Map<number, number>();
  if (!uniqueIds.length) return out;
  const table = await tenantTable(slug, "costs");
  const scope = await tenantScope(table, [`category_id IN (${uniqueIds.map(() => "?").join(",")})`], uniqueIds);
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT category_id, COUNT(*) AS count FROM ${quoteIdentifier(table.name)}${scope.where} GROUP BY category_id`,
    scope.params,
  ).catch(() => []);
  for (const row of rows) out.set(Number(row.category_id ?? 0), Number(row.count ?? 0) || 0);
  return out;
}

async function supplierCostLocationMaps(slug: string, supplierIds: number[]): Promise<Map<number, number[]>> {
  const ids = supplierIds.filter((id) => id > 0);
  const map = new Map<number, number[]>();
  if (!ids.length) return map;
  const table = await tenantTable(slug, "supplier_locations").catch(() => null);
  if (!table) return map;
  const scope = await tenantScope(table, [`supplier_id IN (${ids.map(() => "?").join(",")})`, "COALESCE(costs_enabled,1)=1"], ids);
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT supplier_id, location_id FROM ${quoteIdentifier(table.name)}${scope.where}`,
    scope.params,
  ).catch(() => []);
  for (const row of rows) {
    const supplierId = Number(row.supplier_id ?? 0);
    const locationId = Number(row.location_id ?? 0);
    if (supplierId <= 0 || locationId <= 0) continue;
    const list = map.get(supplierId) ?? [];
    list.push(locationId);
    map.set(supplierId, list);
  }
  return map;
}

async function countRowsByColumn(slug: string, tableName: string, column: string, value: number): Promise<number> {
  const table = await tenantTable(slug, tableName);
  const scope = await tenantScope(table, [`${quoteIdentifier(column)}=?`], [value]);
  const rows = await dbQuery<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)}${scope.where}`, scope.params).catch(() => []);
  return Number(rows[0]?.count ?? 0) || 0;
}

async function filterColumns(table: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const entries = await Promise.all(
    Object.entries(values).map(async ([key, value]) => [key, value, await columnExists(table, key)] as const),
  );
  return Object.fromEntries(entries.filter(([, value, exists]) => exists && value !== undefined).map(([key, value]) => [key, value]));
}

async function tenantScope(target: TenantTarget, clauses: string[], params: unknown[]) {
  const scopedClauses = [...clauses];
  const scopedParams = [...params];
  if (target.mode === "shared" && await columnExists(target.name, "tenant_id")) {
    scopedClauses.unshift("tenant_id=?");
    scopedParams.unshift(target.tenantId ?? 0);
  }
  return {
    where: scopedClauses.length ? ` WHERE ${scopedClauses.join(" AND ")}` : "",
    params: scopedParams,
  };
}

function buildLocationScope(columnSql: string, locationId: number, locations: CostLocationRow[]): { sql: string; params: unknown[] } {
  const allowedIds = locations.map((location) => location.id).filter((id) => id > 0);
  if (locationId > 0) return { sql: `${columnSql}=?`, params: [locationId] };
  if (!allowedIds.length) return { sql: "", params: [] };
  return {
    sql: `(${columnSql} IN (${allowedIds.map(() => "?").join(",")}) OR ${columnSql} IS NULL)`,
    params: allowedIds,
  };
}

function normalizeCostFilters(options: { from?: string; to?: string; status?: string; query?: string; categoryId?: number }) {
  // Periodo di default = mese CORRENTE nel fuso Europe/Rome (come il legacy), non del server.
  const today = businessTodayIso(); // YYYY-MM-DD (Rome)
  const ty = Number(today.slice(0, 4));
  const tm = Number(today.slice(5, 7)); // 1-based
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = dateString(new Date(ty, tm, 0)); // giorno 0 del mese successivo = ultimo del mese corrente
  const status = ["open", "overdue", "paid", "all"].includes(String(options.status ?? "")) ? String(options.status) as "open" | "overdue" | "paid" | "all" : "open";
  return {
    from: normalizeDate(options.from) ?? monthStart,
    to: normalizeDate(options.to) ?? monthEnd,
    status,
    query: clean(options.query, 120).toLowerCase(),
    categoryId: Math.max(0, Math.round(options.categoryId ?? 0)),
  };
}

function summarizeCosts(costs: CostRow[]): ManageCostsContext["summary"] {
  return {
    open: costs.filter((cost) => cost.status === "open").length,
    overdue: costs.filter((cost) => cost.status === "overdue").length,
    paid: costs.filter((cost) => cost.status === "paid").length,
    // Legacy $summary: 'due' è il residuo dei NON pagati NON scaduti (gli scaduti
    // stanno solo in 'overdue'); 'paid' somma il TOTALE dei pagati.
    dueAmount: roundMoney(costs.filter((cost) => cost.status === "open").reduce((sum, cost) => sum + cost.remainingAmount, 0)),
    overdueAmount: roundMoney(costs.filter((cost) => cost.status === "overdue").reduce((sum, cost) => sum + cost.remainingAmount, 0)),
    paidAmount: roundMoney(costs.filter((cost) => cost.status === "paid").reduce((sum, cost) => sum + cost.amount, 0)),
    remainingAmount: roundMoney(costs.filter((cost) => cost.status !== "paid").reduce((sum, cost) => sum + cost.remainingAmount, 0)),
  };
}

function normalizeLocationId(value: number, locations: CostLocationRow[]): number {
  if (value > 0 && locations.some((location) => location.id === value)) return value;
  return locations.length === 1 ? locations[0]?.id ?? 0 : locations[0]?.id ?? 0;
}

function nextDueDate(value: string, interval: number, unit: RecurrenceUnit): string {
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (unit === "day" || unit === "week") {
    const date = new Date(year, month - 1, day);
    date.setDate(date.getDate() + interval * (unit === "week" ? 7 : 1));
    return dateString(date);
  }
  // month/year: aggiungi i mesi e CLAMPA il giorno all'ultimo del mese risultante (port del
  // $addMonthsSafe legacy: $td = min($d, cal_days_in_month)). Date.setMonth/setFullYear farebbe
  // OVERFLOW (es. 31 gen +1 mese -> 3 mar invece di 28 feb; 29 feb +1 anno -> 1 mar invece di 28 feb).
  const monthsToAdd = unit === "year" ? interval * 12 : interval;
  const total = (month - 1) + monthsToAdd;
  const ny = year + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12; // mese 0-based risultante
  const lastDay = new Date(ny, nm + 1, 0).getDate(); // giorno 0 del mese successivo = ultimo giorno di nm
  const nd = Math.min(day, lastDay);
  return dateString(new Date(ny, nm, nd));
}

function normalizeRecurrenceUnit(value: unknown): RecurrenceUnit {
  const unit = String(value ?? "month").toLowerCase();
  if (unit === "day" || unit === "week" || unit === "month" || unit === "year") return unit;
  if (unit === "monthly") return "month";
  if (unit === "yearly") return "year";
  return "month";
}

function normalizeDate(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [year, month, day] = raw.split("-").map((part) => Number.parseInt(part, 10));
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return raw;
}

function dateString(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  return String(value).slice(0, 10);
}

function dateTimeString(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function todayIso(): string {
  // Data "oggi" nel fuso dell'attivita' (Europe/Rome), come il legacy date('Y-m-d'). Prima usava
  // il fuso del server (UTC su Amplify) -> lo stato scaduto/da-pagare e i filtri open/overdue erano
  // mis-etichettati attorno a mezzanotte italiana.
  return businessTodayIso();
}

// Ricerca ACCENT-INSENSITIVE (come MySQL utf8_general_ci del legacy): l'estensione Postgres
// `unaccent` non e' disponibile, quindi pieghiamo le vocali/consonanti accentate italiane con
// translate() lato SQL e la stessa piega lato JS sul termine di ricerca ("societa" trova "società").
const COST_ACCENT_FROM = "àáâãäèéêëìíîïòóôõöùúûüçñ";
const COST_ACCENT_TO = "aaaaaeeeeiiiiooooouuuucn";
function foldCostAccents(value: string): string {
  let out = "";
  for (const ch of value) {
    const i = COST_ACCENT_FROM.indexOf(ch);
    out += i >= 0 ? COST_ACCENT_TO[i] : ch;
  }
  return out;
}
function foldCostAccentsSql(columnSql: string): string {
  return `translate(LOWER(${columnSql}), '${COST_ACCENT_FROM}', '${COST_ACCENT_TO}')`;
}

// Port di $parseMoney (costs.php ~47-98): accetta SOLO cifre e separatori
// ("1.234,56" IT o "1,234.56" EN); null per formato invalido — il chiamante
// decide il messaggio contestuale (Totale / Importo gia pagato).
function parseMoneyOrNull(value: unknown, allowBlank = false): number | null {
  let raw = String(value ?? "").trim().replace(/[ \s]/g, "");
  if (!raw) return allowBlank ? 0 : null;
  if (!/^[+-]?[0-9.,]+$/.test(raw)) return null;
  // Port FEDELE di $parseMoney (costs.php:47-90) inclusa l'euristica MIGLIAIA a separatore singolo:
  // un separatore seguito da ESATTAMENTE 3 cifre con parte intera 1-3 cifre e' un raggruppamento
  // migliaia ("1.234"/"1,234" = 1234), non un decimale. Prima mancava -> "1.234" veniva letto 1,23.
  const commaCount = (raw.match(/,/g) ?? []).length;
  const dotCount = (raw.match(/\./g) ?? []).length;
  if (commaCount > 0 && dotCount > 0) {
    // L'ultimo separatore e' il decimale; l'altro sono le migliaia.
    raw = raw.lastIndexOf(",") > raw.lastIndexOf(".") ? raw.replace(/\./g, "").replace(/,/g, ".") : raw.replace(/,/g, "");
  } else if (commaCount > 0) {
    if (commaCount > 1) {
      if (!/^[+-]?\d{1,3}(,\d{3})+$/.test(raw)) return null; // migliaia malformate -> invalido
      raw = raw.replace(/,/g, "");
    } else {
      const [left, right] = raw.split(",");
      raw = right.length === 3 && /^[+-]?\d{1,3}$/.test(left) ? left + right : `${left}.${right}`;
    }
  } else if (dotCount > 0) {
    if (dotCount > 1) {
      if (!/^[+-]?\d{1,3}(\.\d{3})+$/.test(raw)) return null;
      raw = raw.replace(/\./g, "");
    } else {
      const [left, right] = raw.split(".");
      raw = right.length === 3 && /^[+-]?\d{1,3}$/.test(left) ? left + right : raw;
    }
  }
  // Deve restare un numero con al massimo 2 decimali, altrimenti invalido (come il legacy).
  if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return null;
  return roundMoney(parsed);
}

// Port di $parsePercent (costs.php ~103-110): regex stretta, virgola o punto,
// max 2 decimali; null per input invalido (il chiamante mostra "IVA non valida").
function parsePercent(value: unknown): number | null {
  const raw = String(value ?? "").trim().replace(/[ \s]/g, "");
  if (!raw) return null;
  if (!/^[+]?\d+(?:[,.]\d{1,2})?$/.test(raw)) return null;
  const parsed = Number.parseFloat(raw.replace(",", "."));
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100) / 100;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function nullableNumber(value: unknown): number | null {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function clean(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function cleanLong(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on", "si"].includes(String(value ?? "").toLowerCase());
}
