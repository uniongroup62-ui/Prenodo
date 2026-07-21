import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { emptyToNull, parseInteger, parseNumber } from "@/lib/api-utils";
import { dbExecute, dbQuery, quoteIdentifier, tableExists, tenantIdForSlug, tenantInsert, tenantSelect, tenantTable } from "@/lib/tenant-db";

const ONBOARDING_TABLE = "tenant_onboarding_progress";

export const onboardingSteps = [
  { key: "business", label: "Attivita", title: "Qual e il nome della tua attivita?" },
  { key: "location", label: "Sede", title: "Dove ricevi i clienti?" },
  { key: "activity_categories", label: "Attivita", title: "Seleziona le categorie che descrivono la tua attivita" },
  { key: "hours", label: "Orari", title: "Quando sei aperto?" },
  { key: "staff", label: "Operatori", title: "Aggiungi operatori" },
  { key: "cabins", label: "Cabine", title: "Aggiungi cabine" },
  { key: "service_categories", label: "Categorie", title: "Organizza il catalogo" },
  { key: "services", label: "Servizi", title: "Aggiungi i primi servizi" },
  { key: "booking", label: "Booking", title: "Vuoi pubblicare il booking?" },
] as const;

export type OnboardingStepKey = typeof onboardingSteps[number]["key"];

export type OnboardingState = {
  ok: true;
  source?: string;
  sourceMode: "database";
  tenantId: number;
  status: string;
  currentStep: OnboardingStepKey;
  completedSteps: string[];
  skippedSteps: string[];
  percent: number;
  steps: typeof onboardingSteps;
  data: {
    business: Record<string, unknown> | null;
    location: Record<string, unknown> | null;
    hours: Array<Record<string, unknown>>;
    staff: Array<Record<string, unknown>>;
    cabins: Array<Record<string, unknown>>;
    categories: Array<Record<string, unknown>>;
    services: Array<Record<string, unknown>>;
    booking: Record<string, unknown>;
  };
};

type ProgressRow = RowDataPacket & {
  tenant_id: number;
  status: string;
  current_step: string;
  completed_steps_json?: string | null;
  skipped_steps_json?: string | null;
};

export async function shouldPromptOnboarding(slug: string, isAdmin: boolean): Promise<boolean> {
  if (!isAdmin) return false;
  try {
    const state = await getManageOnboardingState(slug);
    return state.status !== "completed";
  } catch {
    return false;
  }
}

export async function getManageOnboardingState(slug: string): Promise<OnboardingState> {
  const tenantId = await requireTenantId(slug);
  await initializeOnboarding(tenantId, false);
  const progress = await progressForTenant(tenantId);
  if (!progress) throw new Error("Stato onboarding non disponibile.");
  const completed = jsonStepList(progress.completed_steps_json ?? "[]");
  const skipped = jsonStepList(progress.skipped_steps_json ?? "[]");
  const currentStep = validStep(progress.current_step) ?? firstIncompleteStep(completed, skipped) ?? "booking";
  const percent = Math.floor((completed.length / onboardingSteps.length) * 100);

  return {
    ok: true,
    sourceMode: "database",
    tenantId,
    status: String(progress.status ?? "not_started"),
    currentStep,
    completedSteps: completed,
    skippedSteps: skipped,
    percent,
    steps: onboardingSteps,
    data: await onboardingFormData(slug),
  };
}

export async function saveManageOnboardingStep(slug: string, step: string, body: Record<string, string>): Promise<OnboardingState> {
  const tenantId = await requireTenantId(slug);
  const stepKey = validStep(step);
  if (!stepKey) throw new Error("Step onboarding non valido.");

  if (stepKey === "business") await saveBusiness(slug, body);
  if (stepKey === "location") await saveLocation(slug, body);
  if (stepKey === "activity_categories") await saveActivityCategories(slug, body);
  if (stepKey === "hours") await saveHours(slug, body);
  if (stepKey === "staff") await saveStaff(slug, body);
  if (stepKey === "cabins") await saveCabin(slug, body);
  if (stepKey === "service_categories") await saveServiceCategory(slug, body);
  if (stepKey === "services") await saveService(slug, body);
  if (stepKey === "booking") await saveBooking(slug, body);

  await markStep(tenantId, stepKey, "complete");
  return getManageOnboardingState(slug);
}

export async function skipManageOnboardingStep(slug: string, step: string): Promise<OnboardingState> {
  const tenantId = await requireTenantId(slug);
  const stepKey = validStep(step);
  if (!stepKey) throw new Error("Step onboarding non valido.");
  await markStep(tenantId, stepKey, "skip");
  return getManageOnboardingState(slug);
}

export async function completeManageOnboarding(slug: string): Promise<OnboardingState> {
  const tenantId = await requireTenantId(slug);
  const progress = await progressForTenant(tenantId);
  const completed = jsonStepList(progress?.completed_steps_json ?? "[]");
  const skipped = jsonStepList(progress?.skipped_steps_json ?? "[]");
  const covered = new Set([...completed, ...skipped]);
  for (const step of onboardingSteps) covered.add(step.key);
  await updateProgress(tenantId, {
    status: "completed",
    current_step: "booking",
    completed_steps_json: JSON.stringify(Array.from(covered)),
    skipped_steps_json: JSON.stringify(skipped),
    completed_at: mysqlNow(),
    dismissed_at: null,
    started_at: mysqlNow(),
  });
  return getManageOnboardingState(slug);
}

async function onboardingFormData(slug: string): Promise<OnboardingState["data"]> {
  const business = await tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 }).catch(() => []);
  const locations = await tenantSelect<RowDataPacket>({ slug, table: "locations", orderBy: "is_active DESC, id ASC", limit: 1 }).catch(() => []);
  const locationId = Number(locations[0]?.id ?? 0) || null;
  const hours = await tenantSelect<RowDataPacket>({ slug, table: "business_hours", where: locationId ? "location_id = ?" : "", params: locationId ? [locationId] : [], orderBy: "dow ASC" }).catch(() => []);
  const staff = await tenantSelect<RowDataPacket>({ slug, table: "staff", orderBy: "id ASC" }).catch(() => []);
  const cabins = await tenantSelect<RowDataPacket>({ slug, table: "cabins", orderBy: "id ASC" }).catch(() => []);
  const categories = await tenantSelect<RowDataPacket>({ slug, table: "service_categories", orderBy: "sort_order ASC, id ASC" }).catch(() => []);
  const services = await tenantSelect<RowDataPacket>({ slug, table: "services", orderBy: "sort_order ASC, id ASC" }).catch(() => []);
  const tenant = await dbQuery<RowDataPacket[]>("SELECT booking_public_allowed,marketplace_public_allowed FROM `saas_tenants` WHERE id=? LIMIT 1", [await requireTenantId(slug)]).catch(() => []);

  return {
    business: business[0] ?? null,
    location: locations[0] ?? null,
    hours,
    staff,
    cabins,
    categories,
    services,
    booking: tenant[0] ?? { booking_public_allowed: 1, marketplace_public_allowed: 1 },
  };
}

async function saveBusiness(slug: string, body: Record<string, string>): Promise<void> {
  const name = body.business_name?.trim() || body.name?.trim();
  if (!name) throw new Error("Inserisci il nome dell'attivita.");
  const table = await tenantTable(slug, "businesses");
  const existing = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "id", orderBy: "id ASC", limit: 1 }).catch(() => []);
  const values = {
    name,
    website: emptyToNull(body.website),
    quote_website: emptyToNull(body.website),
    booking_about_text: emptyToNull(body.booking_about_text ?? body.description),
    email: emptyToNull(body.email),
    phone: emptyToNull(body.phone),
  };
  if (existing[0]?.id) await updateTenantRow(table.name, Number(existing[0].id), values);
  else await tenantInsert(table, await filterColumns(table.name, values));
  await updateCentralTenant(await requireTenantId(slug), { name });
}

async function saveLocation(slug: string, body: Record<string, string>): Promise<void> {
  const name = body.location_name?.trim() || body.name?.trim();
  if (!name) throw new Error("Inserisci il nome della sede.");
  const table = await tenantTable(slug, "locations");
  const existing = await tenantSelect<RowDataPacket>({ slug, table: "locations", columns: "id", orderBy: "is_active DESC, id ASC", limit: 1 }).catch(() => []);
  const values = {
    name,
    address: emptyToNull(body.address),
    is_active: 1,
    phone: emptyToNull(body.phone),
    email: emptyToNull(body.email),
    whatsapp: emptyToNull(body.whatsapp),
    legal_region: emptyToNull(body.legal_region),
    legal_province: emptyToNull(body.legal_province),
    legal_city: emptyToNull(body.legal_city),
    legal_cap: emptyToNull(body.legal_cap),
    booking_enabled: 1,
    marketplace_enabled: 1,
    sort_order: 0,
  };
  if (existing[0]?.id) await updateTenantRow(table.name, Number(existing[0].id), values);
  else await tenantInsert(table, await filterColumns(table.name, values));
}

async function saveActivityCategories(slug: string, body: Record<string, string>): Promise<void> {
  if (!await tableExists("marketplace_location_activity_categories")) return;
  const tenantId = await requireTenantId(slug);
  const values = (body.activity_categories ?? body.categories ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (!values.length) throw new Error("Inserisci almeno una categoria attivita.");
  const location = await tenantSelect<RowDataPacket>({ slug, table: "locations", columns: "id", orderBy: "is_active DESC, id ASC", limit: 1 }).catch(() => []);
  const locationId = Number(location[0]?.id ?? 0) || null;
  for (const name of values) {
    // Audit giro 3: la tabella è GLOBALE ed esposta dal marketplace pubblico —
    // le categorie NUOVE inserite dall'onboarding di un tenant nascono
    // DISATTIVATE (is_active=0, visibili solo dopo approvazione admin);
    // l'abbinamento tenant/sede sotto resta e funziona comunque.
    await insertKnown("marketplace_activity_categories", { name, slug: slugify(name), is_active: 0 }, true).catch(() => 0);
    const categoryRows = await dbQuery<RowDataPacket[]>("SELECT id FROM `marketplace_activity_categories` WHERE LOWER(name)=LOWER(?) ORDER BY id ASC LIMIT 1", [name]).catch(() => []);
    const categoryId = Number(categoryRows[0]?.id ?? 0);
    if (categoryId > 0 && locationId) {
      await insertKnown("marketplace_location_activity_categories", {
        tenant_id: tenantId,
        tenant_slug: slug,
        location_id: locationId,
        category_id: categoryId,
      }, true).catch(() => 0);
    }
  }
}

async function saveHours(slug: string, body: Record<string, string>): Promise<void> {
  const locationId = await primaryLocationId(slug);
  if (!locationId) throw new Error("Crea prima una sede.");
  const rows = parseHours(body);
  const table = await tenantTable(slug, "business_hours");
  for (const row of rows) {
    const existing = await tenantSelect<RowDataPacket>({
      slug,
      table: "business_hours",
      columns: "id",
      where: "location_id = ? AND dow = ?",
      params: [locationId, row.dow],
      limit: 1,
    }).catch(() => []);
    const values = { location_id: locationId, ...row };
    if (existing[0]?.id) await updateTenantRow(table.name, Number(existing[0].id), values);
    else await tenantInsert(table, await filterColumns(table.name, values));
  }
}

async function saveStaff(slug: string, body: Record<string, string>): Promise<void> {
  if (truthy(body.work_alone)) return;
  const fullName = body.staff_name?.trim() || body.full_name?.trim();
  if (!fullName) throw new Error("Inserisci il nome operatore oppure indica che lavori da solo.");
  const table = await tenantTable(slug, "staff");
  const staffId = await tenantInsert(table, await filterColumns(table.name, {
    full_name: fullName,
    email: emptyToNull(body.staff_email ?? body.email),
    phone: emptyToNull(body.staff_phone ?? body.phone),
    is_active: 1,
    calendar_color: emptyToNull(body.calendar_color),
  }));
  await assignToPrimaryLocation(slug, "staff_locations", "staff_id", staffId);
}

async function saveCabin(slug: string, body: Record<string, string>): Promise<void> {
  if (truthy(body.no_cabins)) return;
  const name = body.cabin_name?.trim() || body.name?.trim();
  if (!name) throw new Error("Inserisci il nome della cabina oppure salta lo step.");
  const table = await tenantTable(slug, "cabins");
  await tenantInsert(table, await filterColumns(table.name, {
    name,
    location_id: await primaryLocationId(slug),
    is_active: 1,
    position: 1,
  }));
}

async function saveServiceCategory(slug: string, body: Record<string, string>): Promise<void> {
  const name = body.category_name?.trim() || body.name?.trim();
  if (!name) throw new Error("Inserisci una categoria servizi.");
  const table = await tenantTable(slug, "service_categories");
  await tenantInsert(table, await filterColumns(table.name, {
    name,
    sort_order: await nextSortOrder(slug, "service_categories"),
    image_url: "",
  }));
}

async function saveService(slug: string, body: Record<string, string>): Promise<void> {
  const name = body.service_name?.trim() || body.name?.trim();
  if (!name) throw new Error("Inserisci il nome del servizio.");
  const categoryId = parseInteger(body.category_id, 0) || await firstId(slug, "service_categories");
  const table = await tenantTable(slug, "services");
  const serviceId = await tenantInsert(table, await filterColumns(table.name, {
    category_id: categoryId || null,
    name,
    duration_min: parseInteger(body.duration_min ?? body.duration, 60),
    price: parseNumber(body.price, 0),
    is_active: 1,
    booking_enabled: 1,
    sort_order: await nextSortOrder(slug, "services"),
  }));
  await assignToPrimaryLocation(slug, "service_locations", "service_id", serviceId);
}

async function saveBooking(slug: string, body: Record<string, string>): Promise<void> {
  const tenantId = await requireTenantId(slug);
  const bookingAllowed = truthy(body.booking_public_allowed ?? "1") ? 1 : 0;
  const marketplaceAllowed = truthy(body.marketplace_public_allowed ?? "1") ? 1 : 0;
  await updateCentralTenant(tenantId, {
    booking_public_allowed: bookingAllowed,
    marketplace_public_allowed: marketplaceAllowed,
  });
  const locations = await tenantTable(slug, "locations").catch(() => null);
  if (locations) {
    const filtered = await filterColumns(locations.name, { booking_enabled: bookingAllowed, marketplace_enabled: marketplaceAllowed });
    const entries = Object.entries(filtered);
    if (entries.length > 0) {
      await dbExecute(
        `UPDATE ${quoteIdentifier(locations.name)} SET ${entries.map(([key]) => `${quoteIdentifier(key)}=?`).join(",")} WHERE ${locations.mode === "shared" ? "tenant_id=?" : "1=1"}`,
        [...entries.map(([, value]) => value), ...(locations.mode === "shared" ? [locations.tenantId] : [])],
      ).catch(() => undefined);
    }
  }
}

async function markStep(tenantId: number, step: OnboardingStepKey, mode: "complete" | "skip"): Promise<void> {
  await initializeOnboarding(tenantId, false);
  const progress = await progressForTenant(tenantId);
  const completed = jsonStepList(progress?.completed_steps_json ?? "[]");
  const skipped = jsonStepList(progress?.skipped_steps_json ?? "[]");
  const target = mode === "complete" ? completed : skipped;
  if (!target.includes(step)) target.push(step);
  const next = firstIncompleteStep(completed, skipped);
  const done = !next;
  await updateProgress(tenantId, {
    status: done ? "completed" : "in_progress",
    current_step: next ?? step,
    completed_steps_json: JSON.stringify(completed),
    skipped_steps_json: JSON.stringify(skipped),
    started_at: mysqlNow(),
    completed_at: done ? mysqlNow() : null,
  });
}

async function initializeOnboarding(tenantId: number, reset: boolean): Promise<void> {
  await ensureOnboardingTable();
  if (reset) {
    await dbExecute(
      `INSERT INTO \`${ONBOARDING_TABLE}\`(tenant_id,status,current_step,completed_steps_json,skipped_steps_json,meta_json,started_at,completed_at,dismissed_at)
       VALUES(?,?,?,?,?,NULL,NULL,NULL,NULL)
       ON CONFLICT (tenant_id) DO UPDATE SET status=EXCLUDED.status, current_step=EXCLUDED.current_step, completed_steps_json=EXCLUDED.completed_steps_json, skipped_steps_json=EXCLUDED.skipped_steps_json, meta_json=NULL, started_at=NULL, completed_at=NULL, dismissed_at=NULL, updated_at=NOW()`,
      [tenantId, "not_started", "business", "[]", "[]"],
    );
    return;
  }
  await dbExecute(
    `INSERT INTO \`${ONBOARDING_TABLE}\`(tenant_id,status,current_step,completed_steps_json,skipped_steps_json) VALUES(?,?,?,?,?) ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, "not_started", "business", "[]", "[]"],
  );
}

async function ensureOnboardingTable(): Promise<void> {
  if (await tableExists(ONBOARDING_TABLE)) return;
  await dbExecute(
    `CREATE TABLE IF NOT EXISTS \`${ONBOARDING_TABLE}\` (
      \`id\` INT(11) NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT(11) NOT NULL,
      \`status\` ENUM('not_started','in_progress','completed','dismissed') NOT NULL DEFAULT 'not_started',
      \`current_step\` VARCHAR(50) NOT NULL DEFAULT 'business',
      \`completed_steps_json\` LONGTEXT NULL DEFAULT NULL,
      \`skipped_steps_json\` LONGTEXT NULL DEFAULT NULL,
      \`meta_json\` LONGTEXT NULL DEFAULT NULL,
      \`started_at\` DATETIME NULL DEFAULT NULL,
      \`completed_at\` DATETIME NULL DEFAULT NULL,
      \`dismissed_at\` DATETIME NULL DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_tenant_onboarding_progress_tenant\` (\`tenant_id\`),
      KEY \`idx_tenant_onboarding_progress_status\` (\`status\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  );
}

async function progressForTenant(tenantId: number): Promise<ProgressRow | null> {
  const rows = await dbQuery<ProgressRow[]>(`SELECT * FROM \`${ONBOARDING_TABLE}\` WHERE tenant_id=? LIMIT 1`, [tenantId]);
  return rows[0] ?? null;
}

async function updateProgress(tenantId: number, values: Record<string, unknown>): Promise<void> {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  const assignments = entries.map(([key]) => `${quoteIdentifier(key)}=?`).join(",");
  await dbExecute(`UPDATE \`${ONBOARDING_TABLE}\` SET ${assignments}, updated_at=NOW() WHERE tenant_id=?`, [...entries.map(([, value]) => value), tenantId]);
}

async function updateTenantRow(table: string, id: number, values: Record<string, unknown>): Promise<void> {
  const filtered = await filterColumns(table, values);
  const entries = Object.entries(filtered);
  if (!entries.length) return;
  const assignments = entries.map(([key]) => `${quoteIdentifier(key)}=?`).join(",");
  await dbExecute(`UPDATE ${quoteIdentifier(table)} SET ${assignments} WHERE id=?`, [...entries.map(([, value]) => value), id]);
}

async function updateCentralTenant(tenantId: number, values: Record<string, unknown>): Promise<void> {
  const filtered = await filterColumns("saas_tenants", values);
  const entries = Object.entries(filtered);
  if (!entries.length) return;
  const assignments = entries.map(([key]) => `${quoteIdentifier(key)}=?`).join(",");
  await dbExecute(`UPDATE \`saas_tenants\` SET ${assignments}, updated_at=NOW() WHERE id=?`, [...entries.map(([, value]) => value), tenantId]);
}

async function filterColumns(table: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
    [table],
  );
  const columns = new Set(rows.map((row) => String(row.column_name ?? row.COLUMN_NAME)));
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => columns.has(key) && value !== undefined));
}

async function insertKnown(table: string, values: Record<string, unknown>, ignore = false): Promise<number> {
  if (!await tableExists(table)) return 0;
  const filtered = await filterColumns(table, values);
  const entries = Object.entries(filtered);
  if (!entries.length) return 0;
  const result = await dbExecute(
    `INSERT INTO ${quoteIdentifier(table)} (${entries.map(([key]) => quoteIdentifier(key)).join(",")}) VALUES (${entries.map(() => "?").join(",")})${ignore ? " ON CONFLICT DO NOTHING" : ""}`,
    entries.map(([, value]) => value),
  );
  return result.insertId;
}

async function primaryLocationId(slug: string): Promise<number> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "locations", columns: "id", orderBy: "is_active DESC, id ASC", limit: 1 }).catch(() => []);
  return Number(rows[0]?.id ?? 0) || 0;
}

async function assignToPrimaryLocation(slug: string, tableName: string, ownerColumn: string, ownerId: number): Promise<void> {
  const locationId = await primaryLocationId(slug);
  if (!locationId || !ownerId) return;
  const table = await tenantTable(slug, tableName).catch(() => null);
  if (!table) return;
  await tenantInsert(table, await filterColumns(table.name, { [ownerColumn]: ownerId, location_id: locationId })).catch(() => undefined);
}

async function firstId(slug: string, table: string): Promise<number> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table, columns: "id", orderBy: "id ASC", limit: 1 }).catch(() => []);
  return Number(rows[0]?.id ?? 0) || 0;
}

async function nextSortOrder(slug: string, table: string): Promise<number> {
  const target = await tenantTable(slug, table).catch(() => null);
  if (!target) return 0;
  const rows = await dbQuery<RowDataPacket[]>(`SELECT COALESCE(MAX(sort_order),-1)+1 AS next_order FROM ${quoteIdentifier(target.name)} ${target.mode === "shared" ? "WHERE tenant_id=?" : ""}`, target.mode === "shared" ? [target.tenantId] : []).catch(() => []);
  return Number(rows[0]?.next_order ?? 0) || 0;
}

async function requireTenantId(slug: string): Promise<number> {
  const tenantId = await tenantIdForSlug(slug);
  if (!tenantId) throw new Error("Tenant non disponibile.");
  return tenantId;
}

function parseHours(body: Record<string, string>): Array<{ dow: number; opens: string | null; closes: string | null; opens2: string | null; closes2: string | null; is_closed: number }> {
  if (body.hours_json) {
    try {
      const rows = JSON.parse(body.hours_json) as Array<{ dow: number; opens?: string; closes?: string; opens2?: string; closes2?: string; is_closed?: boolean | number }>;
      if (Array.isArray(rows) && rows.length > 0) {
        return rows.slice(0, 7).map((row) => ({
          dow: Number(row.dow),
          opens: normalizeTime(row.opens ?? ""),
          closes: normalizeTime(row.closes ?? ""),
          opens2: normalizeTime(row.opens2 ?? ""),
          closes2: normalizeTime(row.closes2 ?? ""),
          is_closed: row.is_closed ? 1 : 0,
        }));
      }
    } catch {
      // fallback to default rows
    }
  }

  return Array.from({ length: 7 }, (_, dow) => {
    const open = dow >= 1 && dow <= 6;
    return {
      dow,
      opens: open ? normalizeTime(body.opens ?? "09:00") : null,
      closes: open ? normalizeTime(body.closes ?? "19:00") : null,
      opens2: null,
      closes2: null,
      is_closed: open ? 0 : 1,
    };
  });
}

function normalizeTime(value: string): string | null {
  const match = value.trim().match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  return match ? `${match[1]}:${match[2]}:00` : null;
}

function jsonStepList(json: string): string[] {
  try {
    const value = JSON.parse(json || "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value.map(String).filter((step) => Boolean(validStep(step)));
  } catch {
    return [];
  }
}

function firstIncompleteStep(completed: string[], skipped: string[]): OnboardingStepKey | null {
  const covered = new Set([...completed, ...skipped]);
  return onboardingSteps.find((step) => !covered.has(step.key))?.key ?? null;
}

function validStep(value: string | null | undefined): OnboardingStepKey | null {
  const normalized = String(value ?? "");
  return onboardingSteps.some((step) => step.key === normalized) ? normalized as OnboardingStepKey : null;
}

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function slugify(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function mysqlNow(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
