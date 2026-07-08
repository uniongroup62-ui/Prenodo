import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { emptyToNull, parseInteger, parseNumber } from "@/lib/api-utils";
import {
  columnExists,
  dbExecute,
  dbQuery,
  quoteIdentifier,
  tenantDelete,
  tenantInsert,
  tenantSelect,
  tenantTable,
  tenantUpdate,
} from "@/lib/tenant-db";

type TenantTarget = Awaited<ReturnType<typeof tenantTable>>;

export type ManageProductsContext = {
  ok: true;
  sourceMode: "database";
  activeLocationId: number;
  stats: {
    products: number;
    activeProducts: number;
    lowStock: number;
    categories: number;
    suppliers: number;
    stockDocuments: number;
  };
  products: ProductRow[];
  categories: ProductCategoryRow[];
  locations: ProductLocationRow[];
  suppliers: SupplierRow[];
  stockDocuments: StockDocumentRow[];
};

export type ProductRow = {
  id: number;
  name: string;
  brand: string;
  internalCode: string;
  sku: string;
  categoryId: number | null;
  categoryName: string;
  priceValue: number;
  price: string;
  purchasePrice: number;
  supplierName: string;
  stock: number;
  minStock: number;
  reorderQty: number;
  incomingQty: number;
  incomingEta: string;
  isActive: boolean;
  publicVisible: boolean;
  sellOnline: boolean;
  locationIds: number[];
  lowStock: boolean;
  description: string;
  ingredients: string;
  warnings: string;
};

export type ProductCategoryRow = {
  id: number;
  name: string;
  productCount: number;
};

export type ProductLocationRow = {
  id: number;
  name: string;
  isActive: boolean;
};

export type SupplierRow = {
  id: number;
  name: string;
  businessName: string;
  email: string;
  phone: string;
  mobile: string;
  city: string;
  province: string;
  vatNumber: string;
  isActive: boolean;
  isActiveCosts: boolean;
  warehouseLocationIds: number[];
  costLocationIds: number[];
  hasLocationRows: boolean;
  // Usage counts — products linked by supplier_name, costs by supplier_id (the legacy "Uso" column
  // + the delete-when-unused gate). productCount+costCount>0 blocks deletion.
  productCount: number;
  costCount: number;
};

// Full editable supplier record for the NEW / EDIT form. The list SupplierRow
// only surfaces a subset; the editor (suppliers.php) reads/writes every column.
export type ManageSupplierRecord = {
  id: number;
  name: string;
  businessName: string;
  address1: string;
  address2: string;
  cap: string;
  city: string;
  province: string;
  country: string;
  countryIso: string;
  vatNumber: string;
  taxCode: string;
  sdiCode: string;
  phone: string;
  fax: string;
  mobile: string;
  email: string;
  pec: string;
  website: string;
  isActive: boolean;
  isActiveCosts: boolean;
  warehouseLocationIds: number[];
  costLocationIds: number[];
  // false = nessuna riga supplier_locations: il legacy tratta il fornitore come
  // abilitato per TUTTE le sedi ('Tutte' in lista, tutte checked nel form).
  hasLocationRows: boolean;
  createdAt: string;
};

export type StockDocumentRow = {
  id: number;
  moveDate: string;
  cause: "carico" | "scarico";
  operatorName: string;
  documentType: string;
  documentNumber: string;
  documentDate: string;
  notes: string;
  locationId: number | null;
  isCanceled: boolean;
  createdAt: string;
  canceledAt: string;
  canceledByName: string;
  attachmentName: string;
  items: Array<{
    id: number;
    productId: number;
    productName: string;
    productSku: string;
    qty: number;
    incomingFlag: boolean;
    incomingQty: number;
    incomingEta: string;
  }>;
};


export async function getManageProductsContext(slug: string, options: { query?: string; locationId?: number; includeInactive?: boolean } = {}): Promise<ManageProductsContext> {
  const [locations, categories, suppliers] = await Promise.all([
    listProductLocations(slug),
    listProductCategories(slug),
    listSuppliers(slug),
  ]);
  const activeLocationId = normalizeLocationId(options.locationId ?? 0, locations);
  const [products, stockDocuments] = await Promise.all([
    listProducts(slug, {
      query: options.query ?? "",
      locationId: activeLocationId,
      includeInactive: options.includeInactive ?? true,
    }),
    listStockDocuments(slug, activeLocationId),
  ]);
  const categoriesWithCounts = categories.map((category) => ({
    ...category,
    productCount: products.filter((product) => product.categoryId === category.id).length,
  }));

  return {
    ok: true,
    sourceMode: "database",
    activeLocationId,
    stats: {
      products: products.length,
      activeProducts: products.filter((product) => product.isActive).length,
      lowStock: products.filter((product) => product.lowStock).length,
      categories: categoriesWithCounts.length,
      suppliers: suppliers.length,
      stockDocuments: stockDocuments.length,
    },
    products,
    categories: categoriesWithCounts,
    locations,
    suppliers,
    stockDocuments,
  };
}

// Edit-form prefill: return ONE product's editable fields for one id. Port of
// products.php action=edit (loads the products row + its enabled locations). The
// list pipeline (listProducts) already exposes every editable field as a
// ProductRow, so we reuse it and narrow by id. locationId 0 keeps min_stock /
// reorder_qty at the product-level values (faithful to the form defaults).
export async function getManageProduct(slug: string, productId: number): Promise<ProductRow | null> {
  if (productId <= 0) return null;
  const products = await listProducts(slug, { query: "", locationId: 0, includeInactive: true });
  return products.find((product) => product.id === productId) ?? null;
}

// Edit-form prefill: return ONE supplier's editable fields for one id. Port of
// suppliers.php action=edit (loads the suppliers row + its supplier_locations
// warehouse/costs flags). Reads the full row (the list SupplierRow drops most
// header/fiscal/contact columns) and reuses supplierLocationMaps.
export async function getManageSupplier(slug: string, id: number): Promise<ManageSupplierRecord | null> {
  if (id <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "suppliers", where: "id=?", params: [id], limit: 1 }).catch(() => []);
  const row = rows[0];
  if (!row) return null;
  const maps = (await supplierLocationMaps(slug, [id])).get(id) ?? { warehouse: [], costs: [], hasRows: false };
  return {
    id,
    name: String(row.name ?? ""),
    businessName: String(row.business_name ?? ""),
    address1: String(row.address1 ?? ""),
    address2: String(row.address2 ?? ""),
    cap: String(row.cap ?? ""),
    city: String(row.city ?? ""),
    province: String(row.province ?? ""),
    country: String(row.country ?? ""),
    countryIso: String(row.country_iso ?? ""),
    vatNumber: String(row.vat_number ?? ""),
    taxCode: String(row.tax_code ?? ""),
    sdiCode: String(row.sdi_code ?? ""),
    phone: String(row.phone ?? ""),
    fax: String(row.fax ?? ""),
    mobile: String(row.mobile ?? ""),
    email: String(row.email ?? ""),
    pec: String(row.pec ?? ""),
    website: String(row.website ?? ""),
    isActive: Number(row.is_active ?? 1) === 1,
    isActiveCosts: Number(row.is_active_costs ?? 1) === 1,
    warehouseLocationIds: maps.warehouse,
    costLocationIds: maps.costs,
    hasLocationRows: maps.hasRows,
    createdAt: row.created_at ? String(row.created_at) : "",
  };
}

export async function saveProduct(slug: string, body: Record<string, string>): Promise<ManageProductsContext> {
  const table = await tenantTable(slug, "products");
  const id = parseInteger(body.id ?? body.product_id, 0);
  const input = await normalizeProductInput(slug, body, id);
  const values = await filterColumns(table.name, {
    name: input.name,
    brand: emptyToNull(input.brand),
    internal_code: emptyToNull(input.internalCode),
    description: emptyToNull(input.description),
    ingredients: emptyToNull(input.ingredients),
    warnings: emptyToNull(input.warnings),
    sell_online: input.sellOnline ? 1 : 0,
    sku: emptyToNull(input.sku),
    category_id: input.categoryId,
    price: input.price,
    min_stock: input.minStock,
    reorder_qty: input.reorderQty,
    supplier_name: emptyToNull(input.supplierName),
    purchase_price: input.purchasePrice,
    is_active: input.isActive ? 1 : 0,
  });

  let productId = id;
  if (productId > 0) {
    const existing = await getProductById(slug, productId);
    await ensureProductLocationRemovalAllowed(slug, productId, input.locationIds);
    await tenantUpdate({ slug, table: "products", id: productId, values });
    await updateProductSnapshots(slug, productId, existing, input);
  } else {
    productId = await tenantInsert(table, {
      ...values,
      stock: 0,
      incoming_qty: 0,
      incoming_eta: null,
    });
  }

  await syncProductLocations(slug, productId, input.locationIds, input.minStock, input.reorderQty);
  return getManageProductsContext(slug, { includeInactive: true, locationId: parseInteger(body.location_id, 0) });
}

export async function deleteProduct(slug: string, productId: number): Promise<ManageProductsContext> {
  if (productId <= 0) throw new Error("Prodotto non valido.");
  await getProductById(slug, productId);
  const blockers = await productDeleteBlockers(slug, productId);
  if (blockers.length) throw new Error("Prodotto non eliminato: associazioni attive presenti.");
  await deleteByOwner(slug, "product_images", "product_id", productId);
  await deleteByOwner(slug, "product_stocks", "product_id", productId);
  await tenantDelete({ slug, table: "products", id: productId });
  return getManageProductsContext(slug, { includeInactive: true });
}

export async function saveProductCategory(slug: string, body: Record<string, string>): Promise<ManageProductsContext> {
  const table = await tenantTable(slug, "product_categories");
  const id = parseInteger(body.id ?? body.cat_id ?? body.category_id, 0);
  const name = clean(body.name ?? body.cat_name, 190);
  if (!name) throw new Error("Nome categoria obbligatorio");
  const dup = await tenantSelect<RowDataPacket>({ slug, table: "product_categories", columns: "id", where: "LOWER(name)=LOWER(?) AND id<>?", params: [name, id], limit: 1 }).catch(() => [] as RowDataPacket[]);
  if (dup[0]) throw new Error("Errore: categoria gia esistente o non valida");
  if (id > 0) {
    await tenantUpdate({ slug, table: "product_categories", id, values: { name } });
  } else {
    await tenantInsert(table, await filterColumns(table.name, { name }));
  }
  return getManageProductsContext(slug, { includeInactive: true });
}

export async function deleteProductCategory(slug: string, categoryId: number): Promise<ManageProductsContext> {
  if (categoryId <= 0) throw new Error("Categoria non valida.");
  const linked = await countRowsByColumn(slug, "products", "category_id", categoryId);
  if (linked > 0) throw new Error("Categoria non eliminabile: sono associati prodotti.");
  await tenantDelete({ slug, table: "product_categories", id: categoryId });
  return getManageProductsContext(slug, { includeInactive: true });
}

export async function saveSupplier(slug: string, body: Record<string, string>): Promise<ManageProductsContext> {
  const table = await tenantTable(slug, "suppliers");
  const id = parseInteger(body.id ?? body.supplier_id, 0);
  const name = clean(body.name, 190);
  if (!name) throw new Error("Nome fornitore obbligatorio");
  await ensureSupplierNameAvailable(slug, name, id);
  const warehouseLocationIds = parseIdList(body.warehouse_location_ids ?? body.location_ids);
  const costLocationIds = parseIdList(body.cost_location_ids);
  const isActive = truthy(body.is_active ?? "1");
  const isActiveCosts = truthy(body.is_active_costs ?? "1");
  // Faithful to suppliers.php saveSupplier: when the tenant has active sedi, an active
  // context (Magazzino / Scadenziario e Costi) must have at least one sede selected.
  const activeLocationCount = (await listProductLocations(slug).catch(() => [])).filter((l) => l.isActive).length;
  if (activeLocationCount > 0 && isActive && warehouseLocationIds.length === 0) {
    throw new Error("Seleziona almeno una sede per il magazzino del fornitore.");
  }
  if (activeLocationCount > 0 && isActiveCosts && costLocationIds.length === 0) {
    throw new Error("Seleziona almeno una sede per costi e scadenziario del fornitore.");
  }
  const values = await filterColumns(table.name, {
    name,
    business_name: emptyToNull(clean(body.business_name, 255)),
    address1: emptyToNull(clean(body.address1, 255)),
    address2: emptyToNull(clean(body.address2, 255)),
    cap: emptyToNull(clean(body.cap, 20)),
    city: emptyToNull(clean(body.city, 190)),
    province: emptyToNull(clean(body.province, 80)),
    country: emptyToNull(clean(body.country || "Italia", 190)),
    country_iso: emptyToNull(clean(body.country_iso || "IT", 10)),
    vat_number: emptyToNull(clean(body.vat_number, 40)),
    tax_code: emptyToNull(clean(body.tax_code, 40)),
    sdi_code: emptyToNull(clean(body.sdi_code, 30)),
    phone: emptyToNull(clean(body.phone, 40)),
    fax: emptyToNull(clean(body.fax, 40)),
    mobile: emptyToNull(clean(body.mobile, 40)),
    email: emptyToNull(clean(body.email, 190)),
    pec: emptyToNull(clean(body.pec, 190)),
    website: emptyToNull(clean(body.website, 190)),
    is_active: isActive ? 1 : 0,
    is_active_costs: isActiveCosts ? 1 : 0,
  });

  let supplierId = id;
  if (supplierId > 0) {
    const old = await getSupplierById(slug, supplierId);
    await tenantUpdate({ slug, table: "suppliers", id: supplierId, values });
    const oldName = String(old.name ?? "");
    if (oldName && oldName !== name) await updateRowsByColumn(slug, "products", "supplier_name", oldName, { supplier_name: name }).catch(() => undefined);
  } else {
    supplierId = await tenantInsert(table, values);
  }
  await syncSupplierLocations(slug, supplierId, warehouseLocationIds, costLocationIds);
  return getManageProductsContext(slug, { includeInactive: true });
}

export async function deleteSupplier(slug: string, supplierId: number): Promise<ManageProductsContext> {
  const supplier = await getSupplierById(slug, supplierId);
  const productCount = await countRowsByColumn(slug, "products", "supplier_name", String(supplier.name ?? "")).catch(() => 0);
  const costCount = await countRowsByColumn(slug, "costs", "supplier_id", supplierId).catch(() => 0);
  if (productCount + costCount > 0) throw new Error("Fornitore usato in prodotti o costi: non puo essere eliminato, disattivalo dai moduli.");
  await deleteByOwner(slug, "supplier_locations", "supplier_id", supplierId);
  await tenantDelete({ slug, table: "suppliers", id: supplierId });
  return getManageProductsContext(slug, { includeInactive: true });
}

export async function saveStockMovement(slug: string, body: Record<string, string>, userName = "Operatore", userId: number | null = null): Promise<ManageProductsContext> {
  const locationId = parseInteger(body.location_id, 0) || (await listProductLocations(slug))[0]?.id || 0;
  const rawCause = String(body.cause ?? body.type ?? "").trim().toLowerCase();
  if (rawCause && !["carico", "scarico", "rettifica"].includes(rawCause)) throw new Error("Causale non valida");
  const rawDocType = String(body.document_type ?? "").trim();
  if (rawDocType !== "" && !["DDT", "Fattura"].includes(rawDocType)) throw new Error("Tipo documento non valido");
  const type = normalizeStockCause(body.cause ?? body.type);
  const items = await normalizeStockItems(body);
  if (!items.length) throw new Error("Aggiungi almeno un prodotto");
  const notes = clean(body.notes ?? body.reason, 2000);

  const adjustedItems: Array<{ productId: number; qty: number; cause: "carico" | "scarico"; incomingFlag: boolean; incomingQty: number; incomingEta: string | null }> = [];
  for (const item of items) {
    const product = await getProductById(slug, item.productId);
    let cause = type;
    let qty = item.qty;
    if ((body.type ?? "").toLowerCase() === "rettifica") {
      const current = await currentProductStock(slug, item.productId, locationId, product);
      const delta = item.qty - current;
      cause = delta >= 0 ? "carico" : "scarico";
      qty = Math.abs(delta);
      if (qty === 0) continue;
    }
    // Guardia sede legacy: il prodotto deve essere abbinato alla sede del documento.
    if (locationId > 0 && !(await productEnabledForLocation(slug, item.productId, locationId))) {
      throw new Error("Prodotto non abbinato alla sede selezionata");
    }
    try {
      await adjustProductStock(slug, item.productId, locationId, cause === "carico" ? qty : -qty);
    } catch {
      throw new Error("Scarico superiore alla giacenza attuale per un prodotto");
    }
    adjustedItems.push({ ...item, qty, cause, incomingFlag: cause === "carico" && item.incomingFlag });
  }
  if (!adjustedItems.length) return getManageProductsContext(slug, { locationId, includeInactive: true });

  const effectiveCauses = [...new Set(adjustedItems.map((item) => item.cause))];
  if (effectiveCauses.length > 1) throw new Error("Rettifica multi-prodotto con carichi e scarichi misti non supportata in un unico documento.");
  const effectiveCause = effectiveCauses[0] ?? type;
  const docId = await insertStockDocument(slug, {
    locationId,
    cause: effectiveCause,
    operatorName: clean(userName, 190) || "Operatore",
    operatorUserId: userId,
    documentType: normalizeDocumentType(body.document_type),
    documentNumber: clean(body.document_number, 80),
    documentDate: normalizeDate(body.document_date),
    notes,
  });
  for (const item of adjustedItems) {
    await insertStockDocumentItem(slug, docId, item);
    if (effectiveCause === "carico") await setProductIncoming(slug, item.productId, locationId, item.incomingFlag ? item.incomingQty : 0, item.incomingFlag ? item.incomingEta : null);
  }
  // stockDocId in risposta: serve al form per caricare l'allegato del
  // documento appena creato (stock-doc-attachment, port di stock_moves.php).
  const context = await getManageProductsContext(slug, { locationId, includeInactive: true });
  return { ...context, stockDocId: docId } as typeof context & { stockDocId: number };
}

// recomputeIncoming — faithful port of stock_moves.php recomputeIncoming (~212-243): a product's
// incoming_qty/eta is whatever the LAST still-active carico with incoming_flag=1 declares (else 0/null).
// Called after a doc is canceled so a stale incoming falls back to the previous pending carico instead
// of being blindly zeroed. Tenant-safe (two scoped tenantSelects, no raw cross-tenant join); the just-
// canceled doc is excluded because each candidate's stock_docs row is checked for is_canceled here.
async function recomputeIncoming(slug: string, productId: number, locationId: number): Promise<{ qty: number; eta: string | null }> {
  if (productId <= 0) return { qty: 0, eta: null };
  const items = await tenantSelect<RowDataPacket>({
    slug,
    table: "stock_doc_items",
    columns: "stock_doc_id, incoming_qty, incoming_eta",
    where: "product_id=? AND incoming_flag=1",
    params: [productId],
    orderBy: "stock_doc_id DESC, id DESC",
  }).catch(() => [] as RowDataPacket[]);
  for (const it of items) {
    const docId = Number(it.stock_doc_id ?? 0) || 0;
    if (docId <= 0) continue;
    const docs = await tenantSelect<RowDataPacket>({
      slug,
      table: "stock_docs",
      columns: "id, cause, is_canceled, location_id",
      where: "id=?",
      params: [docId],
      limit: 1,
    }).catch(() => [] as RowDataPacket[]);
    const d = docs[0];
    if (!d || Number(d.is_canceled ?? 0) === 1) continue;
    if (normalizeStockCause(d.cause) !== "carico") continue;
    if (locationId > 0 && Number(d.location_id ?? 0) > 0 && Number(d.location_id) !== locationId) continue;
    return { qty: Math.max(0, Number(it.incoming_qty ?? 0) || 0), eta: it.incoming_eta ? String(it.incoming_eta).slice(0, 10) : null };
  }
  return { qty: 0, eta: null };
}

export async function cancelStockDocument(slug: string, documentId: number, userName = "Operatore", userId: number | null = null): Promise<ManageProductsContext> {
  const doc = await getStockDocumentById(slug, documentId);
  if (Number(doc.is_canceled ?? 0) === 1) return getManageProductsContext(slug, { locationId: Number(doc.location_id ?? 0), includeInactive: true });
  const rawCancelCause = String(doc.cause ?? "").trim().toLowerCase();
  if (!["carico", "scarico"].includes(rawCancelCause)) throw new Error("Causale non valida");
  const cause = normalizeStockCause(doc.cause);
  const locationId = Number(doc.location_id ?? 0) || 0;
  const items = await tenantSelect<RowDataPacket>({ slug, table: "stock_doc_items", where: "stock_doc_id=?", params: [documentId] }).catch(() => []);
  if (!items.length) throw new Error("Nessuna riga prodotto");
  // Reverse the stock delta for each line.
  const touchedProducts = new Set<number>();
  for (const item of items) {
    const productId = Number(item.product_id ?? 0);
    const qty = Number(item.qty ?? 0);
    if (productId <= 0 || qty <= 0) continue;
    try {
      await adjustProductStock(slug, productId, locationId, cause === "carico" ? -qty : qty);
    } catch {
      throw new Error("Impossibile annullare: storno porta giacenza negativa");
    }
    touchedProducts.add(productId);
  }
  // Mark canceled FIRST so this doc is excluded from the incoming recompute below.
  await tenantUpdate({
    slug,
    table: "stock_docs",
    id: documentId,
    values: {
      is_canceled: 1,
      canceled_at: new Date(),
      canceled_by_user_id: userId,
      canceled_by_name: clean(userName, 190) || "Operatore",
    },
  });
  // Recompute each touched product's incoming from the previous still-active carico (else 0) —
  // faithful to recomputeIncoming, instead of blindly zeroing.
  for (const productId of touchedProducts) {
    const incoming = await recomputeIncoming(slug, productId, locationId);
    await setProductIncoming(slug, productId, locationId, incoming.qty, incoming.eta);
  }
  return getManageProductsContext(slug, { locationId, includeInactive: true });
}

async function listProducts(slug: string, options: { query: string; locationId: number; includeInactive: boolean }): Promise<ProductRow[]> {
  const table = await tenantTable(slug, "products");
  const categoryTable = await tenantTable(slug, "product_categories").catch(() => null);
  const stockTable = options.locationId > 0 ? await tenantTable(slug, "product_stocks").catch(() => null) : null;
  const clauses: string[] = [];
  const joinParams: unknown[] = [];
  const params: unknown[] = [];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.push("p.tenant_id=?");
    params.push(table.tenantId ?? 0);
  }
  if (!options.includeInactive) clauses.push("COALESCE(p.is_active,1)=1");
  const query = clean(options.query, 120).toLowerCase();
  if (query) {
    clauses.push("(LOWER(p.name) LIKE ? OR LOWER(COALESCE(p.sku,'')) LIKE ? OR LOWER(COALESCE(p.brand,'')) LIKE ?)");
    params.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }
  let stockJoin = "";
  let stockColumns = "p.stock AS scoped_stock,p.min_stock AS scoped_min_stock,p.reorder_qty AS scoped_reorder_qty,p.incoming_qty AS scoped_incoming_qty,p.incoming_eta AS scoped_incoming_eta";
  if (stockTable && options.locationId > 0) {
    const stockTenantJoin = stockTable.mode === "shared" && await columnExists(stockTable.name, "tenant_id") ? " AND ps.tenant_id=p.tenant_id" : "";
    stockJoin = `LEFT JOIN ${quoteIdentifier(stockTable.name)} ps ON ps.product_id=p.id AND ps.location_id=?${stockTenantJoin}`;
    joinParams.push(options.locationId);
    stockColumns = "COALESCE(ps.stock,p.stock) AS scoped_stock,COALESCE(ps.min_stock,p.min_stock) AS scoped_min_stock,COALESCE(ps.reorder_qty,p.reorder_qty) AS scoped_reorder_qty,COALESCE(ps.incoming_qty,p.incoming_qty) AS scoped_incoming_qty,COALESCE(ps.incoming_eta,p.incoming_eta) AS scoped_incoming_eta";
    clauses.push("(COALESCE(ps.is_enabled,0)=1 OR NOT EXISTS(SELECT 1 FROM " + quoteIdentifier(stockTable.name) + " ps_any WHERE ps_any.product_id=p.id" + stockTenantJoin.replace("ps.", "ps_any.") + "))");
  }
  const categoryJoin = categoryTable ? `LEFT JOIN ${quoteIdentifier(categoryTable.name)} c ON c.id=p.category_id${categoryTable.mode === "shared" && await columnExists(categoryTable.name, "tenant_id") ? " AND c.tenant_id=p.tenant_id" : ""}` : "";
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT p.*, c.name AS category_name, ${stockColumns}
       FROM ${quoteIdentifier(table.name)} p
       ${categoryJoin}
       ${stockJoin}
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY p.id DESC`,
    [...joinParams, ...params],
  );
  const locationMap = await productLocationMap(slug, rows.map((row) => Number(row.id ?? 0)));
  return rows.map((row) => mapProduct(row, locationMap.get(Number(row.id ?? 0)) ?? []));
}

function mapProduct(row: RowDataPacket, locationIds: number[]): ProductRow {
  const stock = Number(row.scoped_stock ?? row.stock ?? 0) || 0;
  const minStock = Number(row.scoped_min_stock ?? row.min_stock ?? 0) || 0;
  const priceValue = roundMoney(Number(row.price ?? 0) || 0);
  return {
    id: Number(row.id ?? 0),
    name: String(row.name ?? "Prodotto"),
    brand: String(row.brand ?? ""),
    internalCode: String(row.internal_code ?? ""),
    sku: String(row.sku ?? ""),
    categoryId: nullableNumber(row.category_id),
    categoryName: String(row.category_name ?? "Prodotti"),
    priceValue,
    price: `${formatMoney(priceValue)} euro`,
    purchasePrice: roundMoney(Number(row.purchase_price ?? 0) || 0),
    supplierName: String(row.supplier_name ?? ""),
    stock,
    minStock,
    reorderQty: Number(row.scoped_reorder_qty ?? row.reorder_qty ?? 0) || 0,
    incomingQty: Number(row.scoped_incoming_qty ?? row.incoming_qty ?? 0) || 0,
    incomingEta: dateString(row.scoped_incoming_eta ?? row.incoming_eta),
    isActive: Number(row.is_active ?? 1) === 1,
    publicVisible: Number(row.sell_online ?? 0) === 1,
    sellOnline: Number(row.sell_online ?? 0) === 1,
    locationIds,
    lowStock: minStock > 0 && stock < minStock,
    description: String(row.description ?? ""),
    ingredients: String(row.ingredients ?? ""),
    warnings: String(row.warnings ?? ""),
  };
}

async function listProductCategories(slug: string): Promise<ProductCategoryRow[]> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "product_categories", columns: "id,name", orderBy: "name ASC, id ASC" }).catch(() => []);
  return rows.map((row) => ({ id: Number(row.id ?? 0), name: String(row.name ?? ""), productCount: 0 }));
}

async function listProductLocations(slug: string): Promise<ProductLocationRow[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "locations",
    columns: "id,name,is_active",
    orderBy: "COALESCE(sort_order,999999) ASC, name ASC, id ASC",
  }).catch(() => []);
  return rows.map((row) => ({ id: Number(row.id ?? 0), name: String(row.name ?? `Sede #${row.id}`), isActive: Number(row.is_active ?? 1) === 1 }));
}

async function listSuppliers(slug: string): Promise<SupplierRow[]> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "suppliers", columns: "*", orderBy: "name ASC, id ASC" }).catch(() => []);
  const locationMaps = await supplierLocationMaps(slug, rows.map((row) => Number(row.id ?? 0)));
  // Usage counts (faithful to the legacy "Uso" column): products link by supplier_name (string),
  // costs by supplier_id. Counted in memory from tenant-scoped reads (guarded — the costs table may
  // be absent). Drives the "Prodotti/Costi: N" display + the delete-when-unused gate.
  const [prodRows, costRows] = await Promise.all([
    tenantSelect<RowDataPacket>({ slug, table: "products", columns: "supplier_name" }).catch(() => [] as RowDataPacket[]),
    tenantSelect<RowDataPacket>({ slug, table: "costs", columns: "supplier_id" }).catch(() => [] as RowDataPacket[]),
  ]);
  const productCountByName = new Map<string, number>();
  for (const r of prodRows) { const n = String(r.supplier_name ?? "").trim(); if (n) productCountByName.set(n, (productCountByName.get(n) ?? 0) + 1); }
  const costCountBySupplierId = new Map<number, number>();
  for (const r of costRows) { const sid = Number(r.supplier_id ?? 0) || 0; if (sid > 0) costCountBySupplierId.set(sid, (costCountBySupplierId.get(sid) ?? 0) + 1); }
  return rows.map((row) => {
    const id = Number(row.id ?? 0);
    const name = String(row.name ?? "");
    const maps = locationMaps.get(id) ?? { warehouse: [], costs: [], hasRows: false };
    return {
      id,
      name,
      businessName: String(row.business_name ?? ""),
      email: String(row.email ?? ""),
      phone: String(row.phone ?? ""),
      mobile: String(row.mobile ?? ""),
      city: String(row.city ?? ""),
      province: String(row.province ?? ""),
      vatNumber: String(row.vat_number ?? ""),
      isActive: Number(row.is_active ?? 1) === 1,
      isActiveCosts: Number(row.is_active_costs ?? 1) === 1,
      warehouseLocationIds: maps.warehouse,
      hasLocationRows: maps.hasRows,
      costLocationIds: maps.costs,
      productCount: productCountByName.get(name.trim()) ?? 0,
      costCount: costCountBySupplierId.get(id) ?? 0,
    };
  });
}

async function listStockDocuments(slug: string, locationId: number): Promise<StockDocumentRow[]> {
  const docsTable = await tenantTable(slug, "stock_docs").catch(() => null);
  if (!docsTable) return [];
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (docsTable.mode === "shared" && await columnExists(docsTable.name, "tenant_id")) {
    clauses.push("tenant_id=?");
    params.push(docsTable.tenantId ?? 0);
  }
  if (locationId > 0 && await columnExists(docsTable.name, "location_id")) {
    clauses.push("(location_id=? OR location_id IS NULL)");
    params.push(locationId);
  }
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT * FROM ${quoteIdentifier(docsTable.name)} ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY id DESC LIMIT 50`,
    params,
  ).catch(() => []);
  const itemMap = await stockDocumentItems(slug, rows.map((row) => Number(row.id ?? 0)));
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    moveDate: dateString(row.move_date),
    cause: normalizeStockCause(row.cause),
    operatorName: String(row.operator_name ?? ""),
    documentType: String(row.document_type ?? ""),
    documentNumber: String(row.document_number ?? ""),
    documentDate: dateString(row.document_date),
    notes: String(row.notes ?? ""),
    locationId: nullableNumber(row.location_id),
    isCanceled: Number(row.is_canceled ?? 0) === 1,
    createdAt: row.created_at ? String(row.created_at) : "",
    canceledAt: row.canceled_at ? String(row.canceled_at) : "",
    canceledByName: String(row.canceled_by_name ?? ""),
    attachmentName: String(row.attachment_name ?? ""),
    items: itemMap.get(Number(row.id ?? 0)) ?? [],
  }));
}

async function stockDocumentItems(slug: string, docIds: number[]): Promise<Map<number, StockDocumentRow["items"]>> {
  const ids = uniquePositive(docIds);
  const map = new Map<number, StockDocumentRow["items"]>();
  if (!ids.length) return map;
  const itemsTable = await tenantTable(slug, "stock_doc_items").catch(() => null);
  const productsTable = await tenantTable(slug, "products").catch(() => null);
  if (!itemsTable || !productsTable) return map;
  const clauses = [`i.stock_doc_id IN (${ids.map(() => "?").join(",")})`];
  const params: unknown[] = [...ids];
  if (itemsTable.mode === "shared" && await columnExists(itemsTable.name, "tenant_id")) {
    clauses.unshift("i.tenant_id=?");
    params.unshift(itemsTable.tenantId ?? 0);
  }
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT i.*, p.name AS product_name, p.sku AS product_sku
       FROM ${quoteIdentifier(itemsTable.name)} i
       LEFT JOIN ${quoteIdentifier(productsTable.name)} p ON p.id=i.product_id${productsTable.mode === "shared" && await columnExists(productsTable.name, "tenant_id") ? " AND p.tenant_id=i.tenant_id" : ""}
      WHERE ${clauses.join(" AND ")}
      ORDER BY i.stock_doc_id DESC, i.id ASC`,
    params,
  ).catch(() => []);
  for (const row of rows) {
    const stockDocId = Number(row.stock_doc_id ?? 0);
    const list = map.get(stockDocId) ?? [];
    list.push({
      id: Number(row.id ?? 0),
      productId: Number(row.product_id ?? 0),
      productName: String(row.product_name ?? `Prodotto #${row.product_id}`),
      productSku: String(row.product_sku ?? ""),
      qty: Number(row.qty ?? 0) || 0,
      incomingFlag: Number(row.incoming_flag ?? 0) === 1,
      incomingQty: Number(row.incoming_qty ?? 0) || 0,
      incomingEta: dateString(row.incoming_eta),
    });
    map.set(stockDocId, list);
  }
  return map;
}

async function normalizeProductInput(slug: string, body: Record<string, string>, productId: number) {
  const name = clean(body.name, 190);
  if (!name) throw new Error("Nome prodotto obbligatorio.");
  const price = parseMoney(body.price);
  const purchasePrice = parseMoney(body.purchase_price);
  if (price < 0) throw new Error("Il prezzo di vendita non puo essere negativo.");
  if (purchasePrice < 0) throw new Error("Il prezzo di acquisto non puo essere negativo.");
  const categoryId = parseInteger(body.category_id, 0) || null;
  if (categoryId && !await categoryExists(slug, categoryId)) throw new Error("Categoria prodotto non valida.");
  const locationIds = await normalizeProductLocationIds(slug, parseIdList(body.location_ids));
  if (await tableExistsForTenant(slug, "product_stocks") && (await listProductLocations(slug)).some((loc) => loc.isActive) && !locationIds.length) {
    throw new Error("Seleziona almeno una sede per il prodotto");
  }
  const supplierName = clean(body.supplier_name, 190);
  if (supplierName) await ensureSupplierAllowedForProduct(slug, supplierName, locationIds, productId);
  return {
    name,
    brand: clean(body.brand, 120),
    internalCode: clean(body.internal_code, 120),
    description: cleanLong(body.description, 5000),
    ingredients: cleanLong(body.ingredients, 5000),
    warnings: cleanLong(body.warnings, 5000),
    sku: clean(body.sku ?? body.product_code, 80),
    categoryId,
    price,
    purchasePrice,
    supplierName,
    minStock: Math.max(0, parseInteger(body.min_stock, 10)),
    reorderQty: Math.max(0, parseInteger(body.reorder_qty, 0)),
    sellOnline: truthy(body.sell_online ?? body.public_visible ?? "1"),
    isActive: truthy(body.is_active ?? "1"),
    locationIds,
  };
}

async function normalizeProductLocationIds(slug: string, ids: number[]): Promise<number[]> {
  const locations = await listProductLocations(slug);
  const allowed = new Set(locations.filter((location) => location.isActive).map((location) => location.id));
  return uniquePositive(ids.filter((id) => allowed.has(id)));
}

async function ensureSupplierAllowedForProduct(slug: string, supplierName: string, locationIds: number[], productId: number): Promise<void> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "suppliers", where: "name=?", params: [supplierName], limit: 1 }).catch(() => []);
  const supplier = rows[0];
  if (!supplier) throw new Error("Fornitore non valido: seleziona un fornitore esistente.");
  const existingProduct = productId > 0 ? await getProductById(slug, productId).catch(() => null) : null;
  const existingSupplier = existingProduct ? String(existingProduct.supplier_name ?? "") : "";
  if (existingSupplier !== supplierName && Number(supplier.is_active ?? 1) !== 1) throw new Error("Fornitore disattivato per il Magazzino.");
  const maps = await supplierLocationMaps(slug, [Number(supplier.id ?? 0)]);
  const allowedWarehouse = maps.get(Number(supplier.id ?? 0))?.warehouse ?? [];
  if (allowedWarehouse.length && locationIds.some((id) => !allowedWarehouse.includes(id))) {
    throw new Error("Fornitore non abilitato per una delle sedi del prodotto.");
  }
}

async function syncProductLocations(slug: string, productId: number, selectedLocationIds: number[], minStock: number, reorderQty: number): Promise<void> {
  const table = await tenantTable(slug, "product_stocks").catch(() => null);
  if (!table || productId <= 0) return;
  const selected = new Set(uniquePositive(selectedLocationIds));
  const existing = await tenantSelect<RowDataPacket>({ slug, table: "product_stocks", where: "product_id=?", params: [productId] }).catch(() => []);
  const existingByLocation = new Map(existing.map((row) => [Number(row.location_id ?? 0), row]));
  for (const locationId of selected) {
    const current = existingByLocation.get(locationId);
    if (current) {
      await updateProductStockRow(slug, productId, locationId, { min_stock: minStock, reorder_qty: reorderQty, is_enabled: 1 });
    } else {
      await tenantInsert(table, await filterColumns(table.name, {
        product_id: productId,
        location_id: locationId,
        stock: 0,
        min_stock: minStock,
        reorder_qty: reorderQty,
        incoming_qty: 0,
        incoming_eta: null,
        is_enabled: 1,
      }));
    }
  }
  for (const row of existing) {
    const locationId = Number(row.location_id ?? 0);
    if (selected.has(locationId)) continue;
    const stock = Number(row.stock ?? 0) || 0;
    const incoming = Number(row.incoming_qty ?? 0) || 0;
    if (stock > 0 || incoming > 0) throw new Error(`Impossibile rimuovere il prodotto da queste sedi finche hanno giacenza o prodotti in arrivo: ${await locationNameById(slug, locationId)}`);
    await updateProductStockRow(slug, productId, locationId, { is_enabled: 0 });
  }
  await refreshProductAggregateStock(slug, productId);
}

async function ensureProductLocationRemovalAllowed(slug: string, productId: number, selectedLocationIds: number[]): Promise<void> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "product_stocks", where: "product_id=?", params: [productId] }).catch(() => []);
  const selected = new Set(selectedLocationIds);
  const blockers = rows.filter((row) => !selected.has(Number(row.location_id ?? 0)) && Number(row.is_enabled ?? 1) === 1 && ((Number(row.stock ?? 0) || 0) > 0 || (Number(row.incoming_qty ?? 0) || 0) > 0));
  if (blockers.length) {
    const names = await Promise.all(blockers.map((row) => locationNameById(slug, Number(row.location_id ?? 0))));
    throw new Error(`Impossibile rimuovere il prodotto da queste sedi finche hanno giacenza o prodotti in arrivo: ${names.join(", ")}`);
  }
}

// Blockers STRUTTURATI per il modal legacy (group/title/detail).
export async function listProductDeleteBlockers(slug: string, productId: number): Promise<Array<{ group: string; title: string; detail: string }>> {
  const flat = await productDeleteBlockers(slug, productId);
  return flat.map((entry) => {
    const [label, count] = entry.split(": ");
    return {
      group: "Associazione attiva",
      title: label ?? entry,
      detail: count ? `${count} element${count === "1" ? "o" : "i"}` : "",
    };
  });
}

// productDeleteBlockers — port di products_delete_blockers (ProductPageHelpers.php:333-777).
// Il DELETE prodotto e' FISICO (hard-delete): va bloccato quando il prodotto e' ancora
// referenziato da elementi attivi, altrimenti si orfanizzano cataloghi/pacchetti/campagne.
// NB precedente implementazione: `sale_items/product_id` usava una colonna INESISTENTE
// (sale_items ha item_id + item_type, non product_id) e `preorders` non esiste in questo
// schema -> entrambi i blocchi erano MORTI (catch->0). Inoltre mancavano pacchetti/giftbox/
// gift e il controllo giacenza. Qui i blocchi usano le colonne reali dello schema Next.
async function productDeleteBlockers(slug: string, productId: number): Promise<string[]> {
  if (productId <= 0) return [];

  const base = await tenantTable(slug, "products").catch(() => null);
  const shared = base?.mode === "shared";
  const tenantId = base?.tenantId ?? 0;

  // Nome fisico della tabella per il tenant (null se assente -> blocco saltato, come il try/catch legacy).
  const nameOf = async (t: string): Promise<string | null> => {
    try {
      return (await tenantTable(slug, t)).name;
    } catch {
      return null;
    }
  };

  // COUNT tenant-scoped. `scopeAliases` = alias le cui tenant_id vanno fissate (shared mode). Errore -> 0.
  const runCount = async (fromJoin: string, where: string, valueParams: unknown[], scopeAliases: string[]): Promise<number> => {
    let sql = `SELECT COUNT(*) AS count FROM ${fromJoin} WHERE ${where}`;
    const params = [...valueParams];
    if (shared && scopeAliases.length) {
      sql += " AND " + scopeAliases.map((a) => `${a}.tenant_id=?`).join(" AND ");
      for (let i = 0; i < scopeAliases.length; i += 1) params.push(tenantId);
    }
    const rows = await dbQuery<RowDataPacket[]>(sql, params).catch(() => [] as RowDataPacket[]);
    return Number(rows[0]?.count ?? 0) || 0;
  };

  const blockers: string[] = [];
  const push = (label: string, count: number) => {
    if (count > 0) blockers.push(`${label}: ${count}`);
  };

  // 1. Giacenza / in arrivo (products.stock e' il rollup SUM(product_stocks); incoming riflesso).
  const products = await nameOf("products");
  if (products) {
    push("giacenza a magazzino", await runCount(`${quoteIdentifier(products)} p`,
      `p.id=? AND (ABS(COALESCE(p.stock,0))>0.0001 OR COALESCE(p.incoming_qty,0)>0)`, [productId], ["p"]));
  }
  // 2. Movimenti di magazzino (documenti) + 3. movimenti storici legacy.
  const sdi = await nameOf("stock_doc_items");
  if (sdi) push("movimenti di magazzino", await runCount(`${quoteIdentifier(sdi)} x`, `x.product_id=?`, [productId], ["x"]));
  const sm = await nameOf("stock_moves");
  if (sm) push("movimenti storici", await runCount(`${quoteIdentifier(sm)} x`, `x.product_id=?`, [productId], ["x"]));
  // 4. Preordini da ritirare — sale_items(item_type=product, item_status ordered) di vendite non annullate.
  const si = await nameOf("sale_items");
  const sales = await nameOf("sales");
  if (si && sales) push("preordini da ritirare", await runCount(
    `${quoteIdentifier(si)} si JOIN ${quoteIdentifier(sales)} s ON s.id=si.sale_id`,
    `si.item_type='product' AND si.item_id=? AND LOWER(COALESCE(si.item_status,'')) IN ('ordered','ordinato') AND LOWER(COALESCE(s.status,'')) NOT IN ('cancelled','canceled','annullata','annullato')`,
    [productId], ["si", "s"]));
  // 5. Pacchetti cliente attivi.
  const cpi = await nameOf("client_package_items");
  const cp = await nameOf("client_packages");
  if (cpi && cp) push("pacchetti cliente attivi", await runCount(
    `${quoteIdentifier(cpi)} cpi JOIN ${quoteIdentifier(cp)} cp ON cp.id=cpi.client_package_id`,
    `cpi.item_type='product' AND cpi.item_id=? AND LOWER(COALESCE(cp.status,''))='active'`, [productId], ["cpi", "cp"]));
  // 6. Preventivi accettati.
  const qi = await nameOf("quote_items");
  const quotes = await nameOf("quotes");
  if (qi && quotes) push("preventivi accettati", await runCount(
    `${quoteIdentifier(qi)} qi JOIN ${quoteIdentifier(quotes)} q ON q.id=qi.quote_id`,
    `qi.item_type='product' AND qi.item_id=? AND LOWER(COALESCE(q.status,'')) IN ('accepted','accettato')`, [productId], ["qi", "q"]));
  // 7. Catalogo pacchetti attivi.
  const pki = await nameOf("package_items");
  const pk = await nameOf("packages");
  if (pki && pk) push("catalogo pacchetti", await runCount(
    `${quoteIdentifier(pki)} pki JOIN ${quoteIdentifier(pk)} pk ON pk.id=pki.package_id`,
    `pki.item_type='product' AND pki.item_id=? AND COALESCE(pk.is_active,1)=1`, [productId], ["pki", "pk"]));
  // 8. GiftBox attive.
  const gbi = await nameOf("giftbox_items");
  const gb = await nameOf("giftboxes");
  if (gbi && gb) push("giftbox attive", await runCount(
    `${quoteIdentifier(gbi)} gbi JOIN ${quoteIdentifier(gb)} gb ON gb.id=gbi.giftbox_id`,
    `gbi.product_id=? AND COALESCE(gb.active,1)=1 AND gb.deleted_at IS NULL`, [productId], ["gbi", "gb"]));
  // 9. Promozioni attive.
  const pp = await nameOf("promotion_products");
  const pr = await nameOf("promotions");
  if (pp && pr) push("promozioni attive", await runCount(
    `${quoteIdentifier(pp)} pp JOIN ${quoteIdentifier(pr)} pr ON pr.id=pp.promotion_id`,
    `pp.product_id=? AND COALESCE(pr.is_active,1)=1`, [productId], ["pp", "pr"]));
  // 10. Campagne omaggio attive (gift che premia il prodotto).
  const gifts = await nameOf("gifts");
  if (gifts) push("campagne omaggio attive", await runCount(`${quoteIdentifier(gifts)} g`,
    `g.reward_product_id=? AND COALESCE(g.active,1)=1 AND g.deleted_at IS NULL`, [productId], ["g"]));
  // 11. Omaggi emessi non riscattati (istanze di un gift che premia il prodotto).
  const giInst = await nameOf("gift_instances");
  if (giInst && gifts) push("omaggi emessi", await runCount(
    `${quoteIdentifier(giInst)} gi JOIN ${quoteIdentifier(gifts)} g ON g.id=gi.gift_id`,
    `g.reward_product_id=? AND gi.redeemed_at IS NULL AND COALESCE(gi.is_active,1)=1`, [productId], ["gi", "g"]));

  return blockers;
}

async function adjustProductStock(slug: string, productId: number, locationId: number, delta: number): Promise<void> {
  const product = await getProductById(slug, productId);
  const stocksTable = await tenantTable(slug, "product_stocks").catch(() => null);
  if (stocksTable && locationId > 0) {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "product_stocks", where: "product_id=? AND location_id=?", params: [productId, locationId], limit: 1 }).catch(() => []);
    if (!rows[0]) {
      await tenantInsert(stocksTable, await filterColumns(stocksTable.name, {
        product_id: productId,
        location_id: locationId,
        stock: 0,
        min_stock: Number(product.min_stock ?? 0) || 0,
        reorder_qty: Number(product.reorder_qty ?? 0) || 0,
        incoming_qty: 0,
        incoming_eta: null,
        is_enabled: 1,
      }));
    }
    const current = await currentProductStock(slug, productId, locationId, product);
    const next = current + delta;
    if (next < 0) throw new Error("Giacenza insufficiente.");
    await updateProductStockRow(slug, productId, locationId, { stock: next, is_enabled: 1 });
    await refreshProductAggregateStock(slug, productId);
    return;
  }
  const next = Number(product.stock ?? 0) + delta;
  if (next < 0) throw new Error("Giacenza insufficiente.");
  await tenantUpdate({ slug, table: "products", id: productId, values: { stock: next } });
}

async function currentProductStock(slug: string, productId: number, locationId: number, product?: RowDataPacket): Promise<number> {
  if (locationId > 0 && await tableExistsForTenant(slug, "product_stocks")) {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "product_stocks", columns: "stock", where: "product_id=? AND location_id=?", params: [productId, locationId], limit: 1 }).catch(() => []);
    if (rows[0]) return Number(rows[0].stock ?? 0) || 0;
  }
  const row = product ?? await getProductById(slug, productId);
  return Number(row.stock ?? 0) || 0;
}

async function refreshProductAggregateStock(slug: string, productId: number): Promise<void> {
  if (!await tableExistsForTenant(slug, "product_stocks")) return;
  const table = await tenantTable(slug, "product_stocks");
  const scope = await tenantScope(table, ["product_id=?", "COALESCE(is_enabled,1)=1"], [productId]);
  const rows = await dbQuery<RowDataPacket[]>(`SELECT COALESCE(SUM(stock),0) AS stock FROM ${quoteIdentifier(table.name)}${scope.where}`, scope.params).catch(() => []);
  await tenantUpdate({ slug, table: "products", id: productId, values: { stock: Number(rows[0]?.stock ?? 0) || 0 } });
}

async function setProductIncoming(slug: string, productId: number, locationId: number, incomingQty: number, incomingEta: string | null): Promise<void> {
  if (await tableExistsForTenant(slug, "product_stocks") && locationId > 0) {
    await updateProductStockRow(slug, productId, locationId, { incoming_qty: Math.max(0, incomingQty), incoming_eta: incomingEta });
  }
  await tenantUpdate({ slug, table: "products", id: productId, values: { incoming_qty: Math.max(0, incomingQty), incoming_eta: incomingEta } }).catch(() => undefined);
}

async function updateProductStockRow(slug: string, productId: number, locationId: number, values: Record<string, unknown>): Promise<void> {
  const table = await tenantTable(slug, "product_stocks");
  const filtered = await filterColumns(table.name, values);
  const entries = Object.entries(filtered);
  if (!entries.length) return;
  const scope = await tenantScope(table, ["product_id=?", "location_id=?"], [productId, locationId]);
  await dbExecute(
    `UPDATE ${quoteIdentifier(table.name)} SET ${entries.map(([key]) => `${quoteIdentifier(key)}=?`).join(",")} ${scope.where}`,
    [...entries.map(([, value]) => value), ...scope.params],
  );
}

async function insertStockDocument(slug: string, input: { locationId: number; cause: "carico" | "scarico"; operatorName: string; operatorUserId: number | null; documentType: string | null; documentNumber: string; documentDate: string | null; notes: string }): Promise<number> {
  const table = await tenantTable(slug, "stock_docs").catch(() => null);
  if (!table) return 0;
  return tenantInsert(table, await filterColumns(table.name, {
    move_date: todayIso(),
    location_id: input.locationId || null,
    operator_user_id: input.operatorUserId,
    operator_name: input.operatorName,
    cause: input.cause,
    document_type: input.documentType,
    document_number: emptyToNull(input.documentNumber),
    document_date: input.documentDate,
    notes: emptyToNull(input.notes),
    attachment_path: null,
    attachment_mime: null,
    attachment_name: null,
    attachment_size: null,
    is_canceled: 0,
  }));
}

async function insertStockDocumentItem(slug: string, stockDocId: number, item: { productId: number; qty: number; cause: "carico" | "scarico"; incomingFlag: boolean; incomingQty: number; incomingEta: string | null }): Promise<void> {
  if (stockDocId <= 0) {
    await insertLegacyStockMove(slug, item);
    return;
  }
  const table = await tenantTable(slug, "stock_doc_items");
  await tenantInsert(table, await filterColumns(table.name, {
    stock_doc_id: stockDocId,
    product_id: item.productId,
    qty: item.qty,
    incoming_flag: item.incomingFlag ? 1 : 0,
    incoming_qty: item.incomingQty,
    incoming_eta: item.incomingEta,
  }));
}

async function insertLegacyStockMove(slug: string, item: { productId: number; qty: number; cause: "carico" | "scarico" }): Promise<void> {
  const table = await tenantTable(slug, "stock_moves").catch(() => null);
  if (!table) return;
  await tenantInsert(table, await filterColumns(table.name, {
    move_date: todayIso(),
    product_id: item.productId,
    qty: item.qty,
    cause: item.cause,
    operator_name: "Operatore",
  })).catch(() => undefined);
}

async function normalizeStockItems(body: Record<string, string>): Promise<Array<{ productId: number; qty: number; incomingFlag: boolean; incomingQty: number; incomingEta: string | null }>> {
  const jsonItems = parseJsonArray<Record<string, unknown>>(body.items_json ?? body.items);
  const rawItems = jsonItems.length ? jsonItems : [{
    product_id: body.product_id,
    qty: body.quantity ?? body.qty,
    incoming_flag: body.incoming_flag,
    incoming_qty: body.incoming_qty,
    incoming_eta: body.incoming_eta,
  }];
  const byProduct = new Map<number, { productId: number; qty: number; incomingFlag: boolean; incomingQty: number; incomingEta: string | null }>();
  for (const item of rawItems) {
    const productId = Number(item.product_id ?? item.productId ?? 0);
    const qty = Math.max(0, Math.round(Number(item.qty ?? item.quantity ?? 0) || 0));
    if (productId <= 0) continue;
    const current = byProduct.get(productId);
    byProduct.set(productId, {
      productId,
      qty: (current?.qty ?? 0) + qty,
      incomingFlag: truthy(item.incoming_flag ?? item.incomingFlag),
      incomingQty: Math.max(0, Math.round(Number(item.incoming_qty ?? item.incomingQty ?? 0) || 0)),
      incomingEta: normalizeDate(item.incoming_eta ?? item.incomingEta),
    });
  }
  // NB parità legacy: una riga qty=0 senza "in arrivo" è un ERRORE bloccante,
  // non viene scartata in silenzio.
  const items = Array.from(byProduct.values());
  for (const item of items) {
    if (item.qty <= 0 && !item.incomingFlag) throw new Error("Inserisci la quantita per tutte le righe");
    if (item.incomingFlag && item.incomingQty <= 0) throw new Error("Inserisci la quantita in arrivo per tutte le righe se spuntato");
    if (item.incomingFlag && !item.incomingEta) throw new Error("Inserisci la data stimata di arrivo per tutte le righe se spuntato");
  }
  return items;
}

async function productLocationMap(slug: string, productIds: number[]): Promise<Map<number, number[]>> {
  const ids = uniquePositive(productIds);
  const map = new Map<number, number[]>();
  if (!ids.length || !await tableExistsForTenant(slug, "product_stocks")) return map;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "product_stocks",
    columns: "product_id,location_id,is_enabled",
    where: `product_id IN (${ids.map(() => "?").join(",")}) AND COALESCE(is_enabled,1)=1`,
    params: ids,
  }).catch(() => []);
  for (const row of rows) {
    const productId = Number(row.product_id ?? 0);
    const locationId = Number(row.location_id ?? 0);
    if (productId <= 0 || locationId <= 0) continue;
    const list = map.get(productId) ?? [];
    list.push(locationId);
    map.set(productId, list);
  }
  return map;
}

async function supplierLocationMaps(slug: string, supplierIds: number[]): Promise<Map<number, { warehouse: number[]; costs: number[]; hasRows: boolean }>> {
  const ids = uniquePositive(supplierIds);
  const map = new Map<number, { warehouse: number[]; costs: number[]; hasRows: boolean }>();
  if (!ids.length || !await tableExistsForTenant(slug, "supplier_locations")) return map;
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "supplier_locations",
    columns: "supplier_id,location_id,warehouse_enabled,costs_enabled",
    where: `supplier_id IN (${ids.map(() => "?").join(",")})`,
    params: ids,
  }).catch(() => []);
  for (const row of rows) {
    const supplierId = Number(row.supplier_id ?? 0);
    const locationId = Number(row.location_id ?? 0);
    if (supplierId <= 0 || locationId <= 0) continue;
    const current = map.get(supplierId) ?? { warehouse: [], costs: [], hasRows: false };
    current.hasRows = true;
    if (Number(row.warehouse_enabled ?? 1) === 1) current.warehouse.push(locationId);
    if (Number(row.costs_enabled ?? 1) === 1) current.costs.push(locationId);
    map.set(supplierId, current);
  }
  return map;
}

async function syncSupplierLocations(slug: string, supplierId: number, warehouseIds: number[], costIds: number[]): Promise<void> {
  const table = await tenantTable(slug, "supplier_locations").catch(() => null);
  if (!table || supplierId <= 0) return;
  await deleteByOwner(slug, "supplier_locations", "supplier_id", supplierId);
  const allIds = uniquePositive([...warehouseIds, ...costIds]);
  for (const locationId of allIds) {
    await tenantInsert(table, await filterColumns(table.name, {
      supplier_id: supplierId,
      location_id: locationId,
      warehouse_enabled: warehouseIds.includes(locationId) ? 1 : 0,
      costs_enabled: costIds.includes(locationId) ? 1 : 0,
    }));
  }
}

async function updateProductSnapshots(slug: string, productId: number, previous: RowDataPacket, input: Awaited<ReturnType<typeof normalizeProductInput>>): Promise<void> {
  const nameChanged = String(previous.name ?? "") !== input.name || String(previous.sku ?? "") !== input.sku;
  const priceChanged = Math.round((Number(previous.price ?? 0) || 0) * 100) !== Math.round(input.price * 100);
  if (nameChanged) {
    await updateRowsByColumn(slug, "quote_items", "item_id", productId, { item_name: input.name, name: input.name, sku: input.sku }).catch(() => undefined);
    await updateRowsByColumn(slug, "preorders", "product_id", productId, { product_name: input.name, product_sku: input.sku }).catch(() => undefined);
  }
  if (priceChanged) {
    await updateRowsByColumn(slug, "package_items", "item_id", productId, { price: input.price }).catch(() => undefined);
    await updateRowsByColumn(slug, "promotion_products", "product_id", productId, { product_price: input.price, price: input.price }).catch(() => undefined);
  }
}

// Port di app_product_location_enabled: il prodotto è abbinato alla sede quando la sua
// riga product_stocks è is_enabled=1, oppure quando non ha NESSUNA riga product_stocks.
async function productEnabledForLocation(slug: string, productId: number, locationId: number): Promise<boolean> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "product_stocks", columns: "location_id, is_enabled", where: "product_id=?", params: [productId] }).catch(() => [] as RowDataPacket[]);
  if (!rows.length) return true;
  return rows.some((row) => Number(row.location_id ?? 0) === locationId && Number(row.is_enabled ?? 0) === 1);
}

async function locationNameById(slug: string, locationId: number): Promise<string> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "locations", columns: "name", where: "id=?", params: [locationId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  return String(rows[0]?.name ?? `Sede #${locationId}`);
}

async function getProductById(slug: string, id: number): Promise<RowDataPacket> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "products", where: "id=?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Prodotto non trovato");
  return rows[0];
}

async function getSupplierById(slug: string, id: number): Promise<RowDataPacket> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "suppliers", where: "id=?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Fornitore non trovato");
  return rows[0];
}

async function getStockDocumentById(slug: string, id: number): Promise<RowDataPacket> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "stock_docs", where: "id=?", params: [id], limit: 1 });
  if (!rows[0]) throw new Error("Documento non trovato");
  return rows[0];
}

async function categoryExists(slug: string, id: number): Promise<boolean> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "product_categories", columns: "id", where: "id=?", params: [id], limit: 1 }).catch(() => []);
  return Boolean(rows[0]);
}

async function ensureSupplierNameAvailable(slug: string, name: string, id: number): Promise<void> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "suppliers", columns: "id", where: "name=? AND id<>?", params: [name, id], limit: 1 }).catch(() => []);
  if (rows[0]) throw new Error("Esiste gia un fornitore con questo nome.");
}

async function updateRowsByColumn(slug: string, tableName: string, column: string, value: unknown, values: Record<string, unknown>): Promise<void> {
  const table = await tenantTable(slug, tableName);
  const filtered = await filterColumns(table.name, values);
  const entries = Object.entries(filtered).filter(([, entryValue]) => entryValue !== undefined);
  if (!entries.length || !await columnExists(table.name, column)) return;
  const clauses = [`${quoteIdentifier(column)}=?`];
  const params = [...entries.map(([, entryValue]) => entryValue), value];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.push("tenant_id=?");
    params.push(table.tenantId ?? 0);
  }
  await dbExecute(`UPDATE ${quoteIdentifier(table.name)} SET ${entries.map(([key]) => `${quoteIdentifier(key)}=?`).join(",")} WHERE ${clauses.join(" AND ")}`, params);
}

async function countRowsByColumn(slug: string, tableName: string, column: string, value: unknown): Promise<number> {
  if (!await tableExistsForTenant(slug, tableName)) return 0;
  const table = await tenantTable(slug, tableName);
  if (!await columnExists(table.name, column)) return 0;
  const clauses = [`${quoteIdentifier(column)}=?`];
  const params: unknown[] = [value];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.unshift("tenant_id=?");
    params.unshift(table.tenantId ?? 0);
  }
  const rows = await dbQuery<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table.name)} WHERE ${clauses.join(" AND ")}`, params).catch(() => []);
  return Number(rows[0]?.count ?? 0) || 0;
}

async function deleteByOwner(slug: string, tableName: string, ownerColumn: string, ownerId: number): Promise<void> {
  const table = await tenantTable(slug, tableName).catch(() => null);
  if (!table || ownerId <= 0 || !await columnExists(table.name, ownerColumn)) return;
  const scope = await tenantScope(table, [`${quoteIdentifier(ownerColumn)}=?`], [ownerId]);
  await dbExecute(`DELETE FROM ${quoteIdentifier(table.name)}${scope.where}`, scope.params).catch(() => undefined);
}

async function filterColumns(table: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
    [table],
  );
  const columns = new Set(rows.map((row) => String(row.column_name ?? row.COLUMN_NAME)));
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => columns.has(key) && value !== undefined));
}

async function tableExistsForTenant(slug: string, table: string): Promise<boolean> {
  try {
    await tenantTable(slug, table);
    return true;
  } catch {
    return false;
  }
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

function normalizeLocationId(locationId: number, locations: ProductLocationRow[]): number {
  if (locationId > 0 && locations.some((location) => location.id === locationId)) return locationId;
  return locations.find((location) => location.isActive)?.id ?? locations[0]?.id ?? 0;
}

function normalizeStockCause(value: unknown): "carico" | "scarico" {
  return String(value ?? "").trim().toLowerCase() === "scarico" ? "scarico" : "carico";
}

function normalizeDocumentType(value: unknown): "DDT" | "Fattura" | null {
  const type = String(value ?? "").trim();
  return type === "DDT" || type === "Fattura" ? type : null;
}

function parseIdList(value: unknown): number[] {
  if (Array.isArray(value)) return uniquePositive(value.map(Number));
  const raw = String(value ?? "");
  if (!raw) return [];
  return uniquePositive(raw.split(/[,\s]+/).map((item) => Number.parseInt(item, 10)));
}

function parseJsonArray<T>(value: unknown): T[] {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function uniquePositive(values: number[]): number[] {
  return Array.from(new Set(values.filter((value) => Number.isFinite(value) && value > 0).map((value) => Math.floor(value))));
}

function clean(value: unknown, max: number): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
}

function cleanLong(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  return ["1", "true", "yes", "on", "si", "sì"].includes(String(value ?? "").trim().toLowerCase());
}

function parseMoney(value: unknown): number {
  const parsed = parseNumber(String(value ?? "0").replace(/\s*euro\s*/i, ""), 0);
  return roundMoney(parsed);
}

function roundMoney(value: number): number {
  return Math.round((Number.isFinite(value) ? value : 0) * 100) / 100;
}

function formatMoney(value: number): string {
  return roundMoney(value).toFixed(2).replace(".", ",");
}

function nullableNumber(value: unknown): number | null {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

function normalizeDate(value: unknown): string | null {
  const raw = String(value ?? "").trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T12:00:00`);
  return Number.isFinite(date.getTime()) ? raw : null;
}

function dateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return normalizeDate(value) ?? "";
}

function todayIso(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
