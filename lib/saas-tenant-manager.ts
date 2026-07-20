import "server-only";

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { RowDataPacket } from "@/lib/tenant-db";
import { allAssignablePermissions, permissionDefinitions } from "@/lib/role-permissions";
import {
  canManageSaasAdmins,
  currentSaasAdminSession,
  ensureSaasAuthSchema,
  type SaasAdminRole,
  type SaasAdminUser,
} from "@/lib/saas-admin-auth";
import { onboardingSteps } from "@/lib/manage-onboarding";
import type { ManageSession } from "@/lib/manage-auth";
import { dbExecute, dbQuery, quoteIdentifier, tableExists } from "@/lib/tenant-db";
import { normalizeTenantSlug, tenantPrefix } from "@/lib/tenant-runtime";

export type SaasTenantStatus = "provisioning" | "active" | "suspended" | "failed" | "deleted";
export type SaasHealthLevel = "ok" | "warning" | "error";

export type SaasHealthCheck = {
  key: string;
  label: string;
  level: SaasHealthLevel;
  message: string;
};

export type SaasTenantHealth = {
  level: SaasHealthLevel;
  warnings: number;
  errors: number;
  checks: SaasHealthCheck[];
  missing_schema: string[];
  checked_at?: string;
  source?: string;
};

export type SaasTenantRow = RowDataPacket & {
  id: number;
  slug: string;
  name: string;
  db_prefix?: string;
  is_active?: number;
  status?: SaasTenantStatus;
  admin_email?: string | null;
  plan?: string | null;
  notes?: string | null;
  source?: string | null;
  booking_public_allowed?: number;
  marketplace_public_allowed?: number;
  health_level?: SaasHealthLevel | null;
  health_errors?: number | null;
  health_warnings?: number | null;
  health_checked_at?: string | Date | null;
  health_source?: string | null;
  onboarding_status?: string | null;
  onboarding_step?: string | null;
  completed_steps_json?: string | null;
  skipped_steps_json?: string | null;
  onboarding_started_at?: string | Date | null;
  onboarding_completed_at?: string | Date | null;
  onboarding_dismissed_at?: string | Date | null;
  health?: SaasTenantHealth;
  onboarding_percent?: number;
};

export type SaasAdminRecord = {
  id: number;
  name: string;
  email: string;
  role: SaasAdminRole;
  is_active: number;
  last_login_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type AuditTenant = {
  id?: number | string | null;
  slug?: string | null;
};

const KNOWN_STATUSES: SaasTenantStatus[] = ["provisioning", "active", "suspended", "failed", "deleted"];
const ADMIN_ROLES: SaasAdminRole[] = ["owner", "admin", "viewer"];
const SUPPORT_TABLE = "saas_support_access_tokens";
const AUDIT_TABLE = "saas_tenant_audit_logs";
const HEALTH_TABLE = "saas_tenant_health_checks";
const ONBOARDING_TABLE = "tenant_onboarding_progress";
const RESERVED_SLUGS = new Set(["admin", "assets", "uploads", "app", "database", "cron", "public", "attivita", "saloni", "account", "manage", "api"]);

const TENANT_BASE_TABLES = [
  "automation_settings",
  "booking_users",
  "business_hours",
  "businesses",
  "cabins",
  "clients",
  "cost_categories",
  "costs",
  "locations",
  "permissions",
  "pos_settings",
  "products",
  "role_permissions",
  "services",
  "service_categories",
  "staff",
  "staff_locations",
  "user_locations",
  "users",
];

// Memo per processo (Fase A pannello, 2026-07-19): l'ensure fa decine di
// query INFORMATION_SCHEMA — ripeterlo a OGNI lista costava ~1s a chiamata
// su DB remoto. Prima riuscita = basta, fino al prossimo deploy/riavvio.
let tenantSchemaEnsured = false;

export async function ensureSaasTenantSchema(): Promise<void> {
  if (tenantSchemaEnsured) return;
  await ensureSaasAuthSchema();

  const columns: Array<[string, string]> = [
    ["status", "`status` ENUM('provisioning','active','suspended','failed','deleted') NOT NULL DEFAULT 'active' AFTER `is_active`"],
    ["admin_email", "`admin_email` VARCHAR(190) NULL DEFAULT NULL AFTER `status`"],
    ["plan", "`plan` VARCHAR(80) NULL DEFAULT NULL AFTER `admin_email`"],
    ["notes", "`notes` TEXT NULL DEFAULT NULL AFTER `plan`"],
    ["provisioning_error", "`provisioning_error` TEXT NULL DEFAULT NULL AFTER `notes`"],
    ["provisioned_at", "`provisioned_at` DATETIME NULL DEFAULT NULL AFTER `provisioning_error`"],
    ["suspended_at", "`suspended_at` DATETIME NULL DEFAULT NULL AFTER `provisioned_at`"],
    ["suspended_reason", "`suspended_reason` TEXT NULL DEFAULT NULL AFTER `suspended_at`"],
    ["deleted_at", "`deleted_at` DATETIME NULL DEFAULT NULL AFTER `suspended_reason`"],
    ["deleted_reason", "`deleted_reason` TEXT NULL DEFAULT NULL AFTER `deleted_at`"],
    ["created_by_admin_id", "`created_by_admin_id` INT(11) NULL DEFAULT NULL AFTER `deleted_reason`"],
    ["updated_by_admin_id", "`updated_by_admin_id` INT(11) NULL DEFAULT NULL AFTER `created_by_admin_id`"],
    ["health_level", "`health_level` ENUM('ok','warning','error') NULL DEFAULT NULL AFTER `updated_by_admin_id`"],
    ["health_errors", "`health_errors` INT(11) NOT NULL DEFAULT 0 AFTER `health_level`"],
    ["health_warnings", "`health_warnings` INT(11) NOT NULL DEFAULT 0 AFTER `health_errors`"],
    ["health_checked_at", "`health_checked_at` DATETIME NULL DEFAULT NULL AFTER `health_warnings`"],
    ["health_source", "`health_source` VARCHAR(30) NULL DEFAULT NULL AFTER `health_checked_at`"],
    ["source", "`source` ENUM('admin','self_signup') NOT NULL DEFAULT 'admin' AFTER `health_source`"],
    ["signup_id", "`signup_id` INT(11) NULL DEFAULT NULL AFTER `source`"],
    ["owner_email_verified_at", "`owner_email_verified_at` DATETIME NULL DEFAULT NULL AFTER `signup_id`"],
    ["booking_public_allowed", "`booking_public_allowed` TINYINT(1) NOT NULL DEFAULT 1 AFTER `owner_email_verified_at`"],
    ["marketplace_public_allowed", "`marketplace_public_allowed` TINYINT(1) NOT NULL DEFAULT 1 AFTER `booking_public_allowed`"],
  ];

  for (const [column, definition] of columns) {
    await addColumnIfMissing("saas_tenants", column, definition);
  }

  await ensureOnboardingTable();
  await ensureAuditTable();
  await ensureHealthCheckTable();
  await ensureSupportAccessSchema();
  await addIndexIfMissing("saas_tenants", "idx_saas_tenants_status", "`status`, `is_active`");
  await addIndexIfMissing("saas_tenants", "idx_saas_tenants_admin_email", "`admin_email`");
  await addIndexIfMissing("saas_tenants", "idx_saas_tenants_health", "`health_level`, `health_checked_at`");
  await addIndexIfMissing("saas_tenants", "idx_saas_tenants_source", "`source`, `created_at`");

  await dbExecute("UPDATE `saas_tenants` SET status='suspended', suspended_at=COALESCE(suspended_at, updated_at) WHERE is_active=0 AND COALESCE(status,'active')='active'").catch(() => undefined);
  await dbExecute("UPDATE `saas_tenants` SET status='active', provisioned_at=COALESCE(provisioned_at, created_at) WHERE is_active=1 AND COALESCE(status,'active')='active'").catch(() => undefined);
  tenantSchemaEnsured = true;
}

export async function listSaasTenants(filters: { q?: string; status?: string } = {}): Promise<SaasTenantRow[]> {
  await ensureSaasTenantSchema();
  const where: string[] = [];
  const params: unknown[] = [];
  const q = (filters.q ?? "").trim();
  if (q) {
    where.push("(t.slug LIKE ? OR t.name LIKE ? OR COALESCE(t.admin_email,'') LIKE ?)");
    const needle = `%${q}%`;
    params.push(needle, needle, needle);
  }

  const status = normalizeTenantStatus(filters.status ?? "");
  if (status) {
    where.push("t.status = ?");
    params.push(status);
  }

  const hasProgress = await freshTableExists(ONBOARDING_TABLE);
  const progressSelect = hasProgress
    ? "p.status AS onboarding_status, p.current_step AS onboarding_step, p.completed_steps_json, p.skipped_steps_json, p.started_at AS onboarding_started_at, p.completed_at AS onboarding_completed_at, p.dismissed_at AS onboarding_dismissed_at"
    : "NULL AS onboarding_status, NULL AS onboarding_step, NULL AS completed_steps_json, NULL AS skipped_steps_json, NULL AS onboarding_started_at, NULL AS onboarding_completed_at, NULL AS onboarding_dismissed_at";
  const join = hasProgress ? `LEFT JOIN \`${ONBOARDING_TABLE}\` p ON p.tenant_id=t.id` : "";

  const rows = await dbQuery<SaasTenantRow[]>(
    `SELECT t.*, ${progressSelect}
       FROM \`saas_tenants\` t
       ${join}
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY t.id DESC`,
    params,
  );

  return Promise.all(rows.map(async (row) => decorateTenant(row)));
}

export async function saasTenantBySlug(slugInput: string): Promise<SaasTenantRow | null> {
  await ensureSaasTenantSchema();
  const slug = validateTenantSlug(slugInput);
  // STESSA join onboarding della lista (walkthrough UX 19/07: il dettaglio
  // mostrava 0%/not_started mentre la lista diceva 100% completed).
  const hasProgress = await freshTableExists(ONBOARDING_TABLE);
  const progressSelect = hasProgress
    ? "p.status AS onboarding_status, p.current_step AS onboarding_step, p.completed_steps_json, p.skipped_steps_json, p.started_at AS onboarding_started_at, p.completed_at AS onboarding_completed_at, p.dismissed_at AS onboarding_dismissed_at"
    : "NULL AS onboarding_status, NULL AS onboarding_step, NULL AS completed_steps_json, NULL AS skipped_steps_json, NULL AS onboarding_started_at, NULL AS onboarding_completed_at, NULL AS onboarding_dismissed_at";
  const join = hasProgress ? `LEFT JOIN \`${ONBOARDING_TABLE}\` p ON p.tenant_id=t.id` : "";
  const rows = await dbQuery<SaasTenantRow[]>(
    `SELECT t.*, ${progressSelect} FROM \`saas_tenants\` t ${join} WHERE t.slug=? LIMIT 1`,
    [slug],
  );
  return rows[0] ? decorateTenant(rows[0]) : null;
}

export async function requireSaasTenant(slug: string): Promise<SaasTenantRow> {
  const tenant = await saasTenantBySlug(slug);
  if (!tenant) throw new Error("Tenant non trovato.");
  return tenant;
}

export async function createSaasTenant(input: Record<string, string>): Promise<string> {
  await ensureSaasTenantSchema();
  const slug = validateTenantSlug(input.slug ?? "");
  const tenantName = (input.tenant_name ?? input.name ?? "").trim() || slug;
  const adminName = (input.admin_name ?? "Admin").trim() || "Admin";
  const adminEmail = normalizeEmail(input.admin_email ?? "");
  const adminPass = input.admin_pass ?? input.password ?? "";
  const plan = (input.plan ?? "").trim();
  const notes = (input.notes ?? "").trim();

  if (!adminEmail) throw new Error("Email admin tenant obbligatoria.");
  if (!adminPass) throw new Error("Password admin tenant obbligatoria.");
  if (await saasTenantBySlug(slug)) throw new Error("Tenant gia esistente.");
  if (!await usesSharedTenantSchema()) throw new Error("Creazione tenant interrotta: lo schema deve usare tabelle condivise con tenant_id.");

  const actorId = await currentActorId();
  const now = mysqlNow();
  const tenantId = await insertKnown("saas_tenants", {
    slug,
    name: tenantName,
    db_prefix: tenantPrefix(slug),
    is_active: 0,
    status: "provisioning",
    admin_email: adminEmail,
    plan: plan || null,
    notes: notes || null,
    created_by_admin_id: actorId,
    updated_by_admin_id: actorId,
    source: "admin",
    booking_public_allowed: 1,
    marketplace_public_allowed: 1,
  });

  try {
    await seedTenantDefaults({ tenantId, slug, tenantName, adminName, adminEmail, adminPass });
    await updateKnown("saas_tenants", { id: tenantId }, {
      is_active: 1,
      status: "active",
      provisioning_error: null,
      provisioned_at: now,
      updated_by_admin_id: actorId,
    });
    const tenant = await saasTenantBySlug(slug);
    await logSaasTenantAudit("tenant.create", tenant, "Tenant creato", { admin_email: adminEmail, plan });
    return slug;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Creazione tenant fallita.";
    await updateKnown("saas_tenants", { id: tenantId }, {
      is_active: 0,
      status: "failed",
      provisioning_error: message,
      updated_by_admin_id: actorId,
    }).catch(() => undefined);
    await logSaasTenantAudit("tenant.create_failed", { id: tenantId, slug }, "Creazione tenant fallita", { error: message });
    throw error;
  }
}

export async function updateSaasTenant(slug: string, input: Record<string, string>): Promise<void> {
  const tenant = await requireSaasTenant(slug);
  const name = (input.name ?? "").trim();
  if (!name) throw new Error("Nome tenant obbligatorio.");
  await updateTenantMeta(Number(tenant.id), {
    name,
    admin_email: normalizeEmail(input.admin_email ?? "") || null,
    plan: (input.plan ?? "").trim() || null,
    notes: (input.notes ?? "").trim() || null,
    updated_by_admin_id: await currentActorId(),
  });
  await logSaasTenantAudit("tenant.update", tenant, "Dati tenant aggiornati");
}

export async function updateSaasPublicVisibility(slug: string, input: Record<string, string>): Promise<void> {
  const tenant = await requireSaasTenant(slug);
  const before = publicVisibility(tenant);
  const bookingAllowed = truthy(input.booking_public_allowed) ? 1 : 0;
  const marketplaceAllowed = truthy(input.marketplace_public_allowed) ? 1 : 0;
  await updateTenantMeta(Number(tenant.id), {
    booking_public_allowed: bookingAllowed,
    marketplace_public_allowed: marketplaceAllowed,
    updated_by_admin_id: await currentActorId(),
  });

  await syncLocationVisibility(slug, bookingAllowed, marketplaceAllowed);
  await logSaasTenantAudit("tenant.public_visibility_update", tenant, "Visibilita pubblica tenant aggiornata", {
    before,
    after: { booking_public_allowed: Boolean(bookingAllowed), marketplace_public_allowed: Boolean(marketplaceAllowed) },
  });
}

export async function setSaasTenantStatus(slug: string, statusInput: string, reason = ""): Promise<void> {
  const tenant = await requireSaasTenant(slug);
  const status = statusInput === "suspended" ? "suspended" : statusInput === "active" ? "active" : null;
  if (!status) throw new Error("Stato tenant non valido.");

  const patch: Record<string, unknown> = {
    status,
    is_active: status === "active" ? 1 : 0,
    updated_by_admin_id: await currentActorId(),
  };
  if (status === "active") {
    patch.suspended_at = null;
    patch.suspended_reason = null;
    patch.deleted_at = null;
    patch.deleted_reason = null;
  } else {
    patch.suspended_at = mysqlNow();
    patch.suspended_reason = reason.trim() || null;
  }
  await updateTenantMeta(Number(tenant.id), patch);
  await logSaasTenantAudit(status === "active" ? "tenant.activate" : "tenant.suspend", tenant, status === "active" ? "Tenant riattivato" : "Tenant sospeso", { reason });
}

export async function archiveSaasTenant(slug: string, reason = ""): Promise<void> {
  const tenant = await requireSaasTenant(slug);
  await updateTenantMeta(Number(tenant.id), {
    status: "deleted",
    is_active: 0,
    deleted_at: mysqlNow(),
    deleted_reason: reason.trim() || null,
    updated_by_admin_id: await currentActorId(),
  });
  await logSaasTenantAudit("tenant.archive", tenant, "Tenant archiviato", { reason });
}

export async function restoreArchivedSaasTenant(slug: string): Promise<void> {
  const tenant = await requireSaasTenant(slug);
  await updateTenantMeta(Number(tenant.id), {
    status: "active",
    is_active: 1,
    deleted_at: null,
    deleted_reason: null,
    suspended_at: null,
    suspended_reason: null,
    updated_by_admin_id: await currentActorId(),
  });
  await logSaasTenantAudit("tenant.restore_archive", tenant, "Tenant ripristinato da archivio");
}

export async function resetSaasTenantOnboarding(slug: string): Promise<void> {
  const tenant = await requireSaasTenant(slug);
  await initializeOnboarding(Number(tenant.id), true);
  await logSaasTenantAudit("tenant.onboarding_reset", tenant, "Onboarding resettato");
}

export async function repairSaasTenantSchema(slug: string): Promise<SaasTenantHealth> {
  const tenant = await requireSaasTenant(slug);
  await ensureOnboardingTable();
  await initializeOnboarding(Number(tenant.id), false);
  await seedTenantPermissions(Number(tenant.id));
  const health = await saasTenantHealth(tenant, true);
  await recordSaasTenantHealth(tenant, health, "repair");
  await logSaasTenantAudit("tenant.schema_repair", tenant, "Dati tenant riparati (onboarding e permessi)");
  return health;
}

// Auto-riparazione dal cron admin-health: SOLO i buchi additivi che non
// richiedono decisioni umane (riga onboarding mancante, voci permessi di
// catalogo assenti). Admin mancante e schema restano alert per l'umano.
const AUTO_REPAIRABLE_CHECKS = new Set(["onboarding_state", "permissions"]);

export async function autoRepairSaasTenant(slug: string): Promise<{ repaired: string[]; level: SaasHealthLevel }> {
  const tenant = await requireSaasTenant(slug);
  const before = await saasTenantHealth(tenant, true);
  const targets = before.checks.filter((check) => check.level !== "ok" && AUTO_REPAIRABLE_CHECKS.has(check.key));
  if (!targets.length) return { repaired: [], level: before.level };

  await ensureOnboardingTable();
  await initializeOnboarding(Number(tenant.id), false);
  await seedTenantPermissions(Number(tenant.id));

  const after = await saasTenantHealth(tenant, true);
  await recordSaasTenantHealth(tenant, after, "auto_repair");
  await logSaasTenantAudit("tenant.auto_repair", tenant, `Riparazione automatica: ${targets.map((t) => t.label).join(", ")}`);
  return { repaired: targets.map((t) => t.key), level: after.level };
}

export async function repairSaasTenantAdmin(slug: string, input: Record<string, string>): Promise<{ user_id: number; staff_id: number }> {
  const tenant = await requireSaasTenant(slug);
  const adminName = (input.admin_name ?? "Admin").trim() || "Admin";
  const adminEmail = normalizeEmail(input.admin_email ?? "");
  const adminPass = input.admin_pass ?? "";
  if (!adminEmail) throw new Error("Email admin obbligatoria.");

  const tenantId = Number(tenant.id);
  const passwordHash = adminPass ? await bcrypt.hash(adminPass, 10) : null;

  let userId = 0;
  const adminRows = await dbQuery<RowDataPacket[]>("SELECT id FROM `users` WHERE tenant_id=? AND role='admin' ORDER BY id ASC LIMIT 1", [tenantId]).catch(() => []);
  if (adminRows[0]) {
    userId = Number(adminRows[0].id ?? 0);
    const values = await filterColumns("users", {
      name: adminName,
      full_name: adminName,
      email: adminEmail,
      password_hash: passwordHash ?? undefined,
      role: "admin",
    });
    await updateKnown("users", { id: userId, tenant_id: tenantId }, values);
  } else {
    userId = await insertKnown("users", {
      tenant_id: tenantId,
      name: adminName,
      full_name: adminName,
      email: adminEmail,
      password_hash: passwordHash ?? await bcrypt.hash(crypto.randomBytes(12).toString("hex"), 10),
      role: "admin",
      email_verified_at: mysqlNow(),
    });
  }

  let staffId = 0;
  const staffRows = await dbQuery<RowDataPacket[]>(
    "SELECT id FROM `staff` WHERE tenant_id=? AND (LOWER(email)=? OR id=1) ORDER BY (LOWER(email)=?) DESC, id ASC LIMIT 1",
    [tenantId, adminEmail, adminEmail],
  ).catch(() => []);
  if (staffRows[0]) {
    staffId = Number(staffRows[0].id ?? 0);
    await updateKnown("staff", { id: staffId, tenant_id: tenantId }, {
      full_name: adminName,
      email: adminEmail,
      is_active: 1,
    });
  } else {
    staffId = await insertKnown("staff", {
      tenant_id: tenantId,
      full_name: adminName,
      phone: null,
      email: adminEmail,
      is_active: 1,
      calendar_color: null,
    });
  }

  await assignAllActiveLocations(tenantId, userId, staffId);
  await updateTenantMeta(tenantId, { admin_email: adminEmail, updated_by_admin_id: await currentActorId() });
  await logSaasTenantAudit("tenant.admin_repair", tenant, "Admin tenant verificato/riparato", { admin_email: adminEmail, password_changed: Boolean(adminPass) });
  return { user_id: userId, staff_id: staffId };
}

export async function deleteSaasTenant(slug: string, confirmation: string): Promise<{ shared_rows_deleted: number; tenant_deleted: boolean; warnings: string[] }> {
  const tenant = await requireSaasTenant(slug);
  if (confirmation.trim() !== String(tenant.slug)) {
    throw new Error("Conferma eliminazione non valida: digita lo slug esatto.");
  }

  await logSaasTenantAudit("tenant.delete_start", tenant, "Eliminazione tenant avviata");
  const warnings: string[] = [];
  let sharedRowsDeleted = 0;
  const tenantId = Number(tenant.id);

  // Tabelle da CANCELLARE: enumerazione DINAMICA di tutte quelle con colonna
  // tenant_id (giro verifica 2026-07-19: la lista fissa copriva 34 tabelle su
  // ~148 — vendite, carte, pacchetti, promozioni, directory ecc. restavano
  // orfane). Si CONSERVANO solo i registri di piattaforma: audit, backup e
  // ordini SMS (storico fatturazione).
  const KEEP_ON_DELETE = new Set(["saas_tenants", AUDIT_TABLE, "saas_tenant_backups", "saas_sms_orders"]);
  const tableRows = await dbQuery<RowDataPacket[]>(
    `SELECT DISTINCT c.TABLE_NAME AS table_name
       FROM INFORMATION_SCHEMA.COLUMNS c
       JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME
      WHERE c.TABLE_SCHEMA=DATABASE()
        AND c.COLUMN_NAME='tenant_id'
        AND t.TABLE_TYPE='BASE TABLE'
      ORDER BY c.TABLE_NAME`,
  );
  const tablesToPurge = tableRows
    .map((row) => String(row.table_name ?? ""))
    .filter((table) => table && !KEEP_ON_DELETE.has(table));

  try {
    await dbExecute("SET session_replication_role = 'replica'").catch(() => undefined);
    for (const table of tablesToPurge) {
      const result = await dbExecute(`DELETE FROM ${quoteIdentifier(table)} WHERE tenant_id=?`, [tenantId]).catch((error) => {
        warnings.push(`${table}: ${error instanceof Error ? error.message : "delete fallita"}`);
        return null;
      });
      if (result) sharedRowsDeleted += Number(result.affectedRows ?? 0);
    }
    await dbExecute("DELETE FROM `saas_professional_signups` WHERE slug=? OR tenant_id=?", [slug, tenantId]).catch(() => undefined);
    await dbExecute("DELETE FROM `saas_tenants` WHERE id=? AND slug=?", [tenantId, slug]);
  } finally {
    await dbExecute("SET session_replication_role = 'origin'").catch(() => undefined);
  }

  await logSaasTenantAudit("tenant.delete_complete", tenant, "Tenant eliminato definitivamente", { shared_rows_deleted: sharedRowsDeleted, warnings });
  return { shared_rows_deleted: sharedRowsDeleted, tenant_deleted: true, warnings };
}

export async function saasTenantHealth(tenant: SaasTenantRow, deep = true): Promise<SaasTenantHealth> {
  await ensureSaasTenantSchema();
  const checks: SaasHealthCheck[] = [];
  let warnings = 0;
  let errors = 0;
  const add = (key: string, label: string, level: SaasHealthLevel, message = "") => {
    checks.push({ key, label, level, message });
    if (level === "warning") warnings += 1;
    if (level === "error") errors += 1;
  };

  const status = tenantStatus(tenant);
  // Etichette dei controlli in ITALIANO (bonifica 20/07): mai enum grezzi.
  const statusIt: Record<string, string> = { active: "Attivo", suspended: "Sospeso", provisioning: "Provisioning", failed: "Errore", deleted: "Eliminato" };
  add("status", "Stato tenant", status === "active" ? "ok" : "warning", statusIt[status] ?? status);

  if (!await freshTableExists(ONBOARDING_TABLE)) {
    add("onboarding_table", "Tabella onboarding", "warning", "Tabella non disponibile");
  } else {
    const progress = await dbQuery<RowDataPacket[]>("SELECT status,current_step FROM `tenant_onboarding_progress` WHERE tenant_id=? LIMIT 1", [Number(tenant.id)]).catch(() => []);
    if (!progress[0]) add("onboarding_state", "Onboarding", "warning", "Stato onboarding mancante");
    else {
      const onboardingIt: Record<string, string> = { not_started: "Non iniziato", in_progress: "In corso", completed: "Completato", dismissed: "Nascosto" };
      const state = String(progress[0].status ?? "");
      const step = String(progress[0].current_step ?? "");
      add("onboarding_state", "Onboarding", "ok", `${onboardingIt[state] ?? state}${step ? ` · passo ${step}` : ""}`);
    }
  }

  // Schema pooled: il controllo e' sul database CONDIVISO (stesso esito per
  // ogni tenant) — un errore qui significa deploy/migrazione rotti, non un
  // problema del singolo cliente.
  const schema = await schemaDiagnostics(String(tenant.slug));
  if (schema.missing.length > 0) add("schema", "Schema database", "error", `${schema.missing.length} tabelle/campi mancanti nel database condiviso`);
  else add("schema", "Schema database", "ok", "OK (condiviso, non dipende dal tenant)");

  if (deep) {
    try {
      const tenantId = Number(tenant.id);
      const adminCount = await countQuery("SELECT COUNT(*) FROM `users` WHERE tenant_id=? AND role='admin'", [tenantId]);
      const staffCount = await countQuery("SELECT COUNT(*) FROM `staff` WHERE tenant_id=? AND COALESCE(is_active,1)=1", [tenantId]);
      const locationCount = await countQuery("SELECT COUNT(*) FROM `locations` WHERE tenant_id=? AND COALESCE(is_active,1)=1", [tenantId]);
      const businessCount = await countQuery("SELECT COUNT(*) FROM `businesses` WHERE tenant_id=?", [tenantId]);
      add("admin_user", "Admin tenant", adminCount > 0 ? "ok" : "error", adminCount > 0 ? `${adminCount} admin` : "Admin mancante");
      add("staff", "Operatori", staffCount > 0 ? "ok" : "warning", `${staffCount} attivi`);
      add("locations", "Sedi", locationCount > 0 ? "ok" : "warning", `${locationCount} attive`);
      add("business_profile", "Profilo attività", businessCount > 0 ? "ok" : "warning", businessCount > 0 ? "Presente" : "Mancante");
      // Voci di catalogo permessi assenti (tenant nati con un catalogo piu'
      // vecchio, migrati o ripristinati): buco ADDITIVO auto-riparabile.
      if (await freshTableExists("permissions")) {
        const catalog = permissionDefinitions.map((definition) => definition.perm);
        const present = catalog.length
          ? await countQuery(`SELECT COUNT(*) FROM \`permissions\` WHERE tenant_id=? AND perm IN (${catalog.map(() => "?").join(",")})`, [tenantId, ...catalog])
          : 0;
        const missingPerms = Math.max(0, catalog.length - present);
        add("permissions", "Permessi ruoli", missingPerms > 0 ? "warning" : "ok", missingPerms > 0 ? `${missingPerms} voci di catalogo mancanti` : `Catalogo completo (${catalog.length} voci)`);
      }
    } catch (error) {
      add("tenant_probe", "Diagnostica tenant", "warning", error instanceof Error ? error.message : "Verifica non riuscita");
    }
  }

  return {
    level: errors > 0 ? "error" : warnings > 0 ? "warning" : "ok",
    warnings,
    errors,
    checks,
    missing_schema: schema.missing,
  };
}

export async function recordSaasTenantHealthForSlug(slug: string, source = "manual", deep = true): Promise<SaasTenantHealth> {
  const tenant = await requireSaasTenant(slug);
  const health = await saasTenantHealth(tenant, deep);
  await recordSaasTenantHealth(tenant, health, source);
  return health;
}

export async function recordSaasTenantHealth(tenant: SaasTenantRow, health: SaasTenantHealth, source = "manual"): Promise<void> {
  await ensureHealthCheckTable();
  const level = normalizeHealthLevel(health.level);
  const cleanSource = cleanHealthSource(source);
  await updateTenantMeta(Number(tenant.id), {
    health_level: level,
    health_errors: health.errors,
    health_warnings: health.warnings,
    health_checked_at: mysqlNow(),
    health_source: cleanSource,
  });
  await dbExecute(
    `INSERT INTO \`${HEALTH_TABLE}\`(tenant_id,tenant_slug,level,errors_count,warnings_count,source,checks_json,missing_schema_json)
     VALUES(?,?,?,?,?,?,?,?)`,
    [
      Number(tenant.id),
      String(tenant.slug),
      level,
      Number(health.errors ?? 0),
      Number(health.warnings ?? 0),
      cleanSource,
      JSON.stringify(health.checks ?? []),
      JSON.stringify(health.missing_schema ?? []),
    ],
  );
  // Retention (rilievo utente 20/07: "a cosa serve accumulare?"): lo storico
  // diagnostiche serve solo recente — restano le ultime 30 righe per tenant.
  await dbExecute(
    `DELETE FROM \`${HEALTH_TABLE}\` WHERE tenant_id=? AND id NOT IN (
       SELECT id FROM \`${HEALTH_TABLE}\` WHERE tenant_id=? ORDER BY id DESC LIMIT 30)`,
    [Number(tenant.id), Number(tenant.id)],
  ).catch(() => undefined);
}

export async function latestSaasHealthChecks(tenantId: number, limit = 10): Promise<RowDataPacket[]> {
  await ensureHealthCheckTable();
  const capped = Math.max(1, Math.min(50, limit));
  if (tenantId <= 0) return [];
  return dbQuery<RowDataPacket[]>(`SELECT * FROM \`${HEALTH_TABLE}\` WHERE tenant_id=? ORDER BY id DESC LIMIT ${capped}`, [tenantId]);
}

export async function healthAllSaasTenants(deep = true, record = false, source = "manual_all"): Promise<Array<{ slug: string; ok: boolean; level: SaasHealthLevel; message: string }>> {
  const tenants = await listSaasTenants();
  const results = [];
  for (const tenant of tenants) {
    try {
      const health = await saasTenantHealth(tenant, deep);
      if (record) await recordSaasTenantHealth(tenant, health, source);
      results.push({ slug: String(tenant.slug), ok: health.level === "ok", level: health.level, message: `${health.checks.length} controlli` });
    } catch (error) {
      results.push({ slug: String(tenant.slug), ok: false, level: "error" as SaasHealthLevel, message: error instanceof Error ? error.message : "Errore" });
    }
  }
  return results;
}

export async function repairAllSaasTenants(includeInactive = false): Promise<Array<{ slug: string; ok: boolean; message: string }>> {
  const tenants = await listSaasTenants();
  const results = [];
  for (const tenant of tenants) {
    const status = tenantStatus(tenant);
    if (!includeInactive && status !== "active") continue;
    try {
      const health = await repairSaasTenantSchema(String(tenant.slug));
      results.push({ slug: String(tenant.slug), ok: true, message: health.level });
    } catch (error) {
      results.push({ slug: String(tenant.slug), ok: false, message: error instanceof Error ? error.message : "Errore" });
    }
  }
  return results;
}

export function tenantStatus(tenant: Partial<SaasTenantRow>): SaasTenantStatus {
  const status = normalizeTenantStatus(String(tenant.status ?? ""));
  if (status) return status;
  return Number(tenant.is_active ?? 1) === 1 ? "active" : "suspended";
}

export function saasTenantSummary(tenants: SaasTenantRow[]) {
  return tenants.reduce((out, tenant) => {
    out.total += 1;
    const status = tenantStatus(tenant);
    if (status === "active") out.active += 1;
    if (status === "suspended") out.suspended += 1;
    if (status === "failed") out.failed += 1;
    if ((tenant.health?.level ?? "ok") !== "ok" || !tenant.health_checked_at) out.needs_attention += 1;
    return out;
  }, { total: 0, active: 0, suspended: 0, failed: 0, needs_attention: 0 });
}

export function saasOperationalSummary(tenants: SaasTenantRow[]) {
  return tenants.reduce((out, tenant) => {
    const status = tenantStatus(tenant);
    const health = tenant.health?.level ?? "ok";
    if (health === "error") out.health_errors += 1;
    if (health === "warning") out.health_warnings += 1;
    if (!tenant.health_checked_at) out.health_missing += 1;
    if ((tenant.onboarding_status ?? "") !== "completed") out.onboarding_open += 1;
    if (status === "deleted") out.archived += 1;
    if (status === "suspended") out.suspended += 1;
    return out;
  }, { health_errors: 0, health_warnings: 0, health_missing: 0, onboarding_open: 0, archived: 0, suspended: 0 });
}

export async function auditRows(tenantId?: number | null, limit = 80): Promise<RowDataPacket[]> {
  await ensureAuditTable();
  const capped = Math.max(1, Math.min(100, limit));
  if (tenantId && tenantId > 0) {
    return dbQuery<RowDataPacket[]>(`SELECT * FROM \`${AUDIT_TABLE}\` WHERE tenant_id=? ORDER BY id DESC LIMIT ${capped}`, [tenantId]);
  }
  return dbQuery<RowDataPacket[]>(`SELECT * FROM \`${AUDIT_TABLE}\` ORDER BY id DESC LIMIT ${capped}`);
}

// Ricerca AUDIT con filtri e paginazione (2026-07-19: la vista mostrava solo
// gli ultimi 20 senza filtri). Match case-insensitive via LOWER (trappola PG).
export async function searchSaasAudit(filters: { q?: string; action?: string; tenant?: string; page?: number; perPage?: number } = {}): Promise<{ rows: RowDataPacket[]; total: number; page: number; perPage: number }> {
  await ensureAuditTable();
  const where: string[] = [];
  const params: unknown[] = [];
  const q = (filters.q ?? "").trim();
  if (q) {
    where.push("(LOWER(COALESCE(message,'')) LIKE LOWER(?) OR LOWER(COALESCE(actor_email,'')) LIKE LOWER(?) OR LOWER(action) LIKE LOWER(?))");
    const needle = `%${q}%`;
    params.push(needle, needle, needle);
  }
  const action = (filters.action ?? "").trim();
  if (action) {
    where.push("LOWER(action) LIKE LOWER(?)");
    params.push(`${action}%`);
  }
  const tenant = (filters.tenant ?? "").trim();
  if (tenant) {
    where.push("LOWER(COALESCE(tenant_slug,'')) LIKE LOWER(?)");
    params.push(`%${tenant}%`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const totalRows = await dbQuery<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM \`${AUDIT_TABLE}\` ${clause}`, params);
  const total = Number(totalRows[0]?.count ?? 0);
  const perPage = Math.min(100, Math.max(10, Number(filters.perPage ?? 30)));
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(pageCount, Math.max(1, Number(filters.page ?? 1)));
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT * FROM \`${AUDIT_TABLE}\` ${clause} ORDER BY id DESC LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`,
    params,
  );
  return { rows, total, page, perPage };
}

export async function logSaasTenantAudit(action: string, tenant: AuditTenant | null, message = "", meta: Record<string, unknown> = {}): Promise<void> {
  try {
    await ensureAuditTable();
    const session = await currentSaasAdminSession().catch(() => null);
    const actor = session?.user;
    await dbExecute(
      `INSERT INTO \`${AUDIT_TABLE}\`(actor_admin_id,actor_name,actor_email,tenant_id,tenant_slug,action,message,meta_json,ip,user_agent)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      [
        actor?.id ?? null,
        actor?.name || null,
        actor?.email || null,
        tenant?.id ? Number(tenant.id) : null,
        tenant?.slug ? String(tenant.slug) : null,
        action.trim(),
        message.trim() || null,
        Object.keys(meta).length ? JSON.stringify(meta) : null,
        null,
        null,
      ],
    );
  } catch {
    // Audit best effort, come nel PHP.
  }
}

export async function ensureSupportAccessSchema(): Promise<void> {
  if (await tableExists(SUPPORT_TABLE)) return;
  await dbExecute(
    `CREATE TABLE IF NOT EXISTS \`${SUPPORT_TABLE}\` (
      \`id\` INT(11) NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT(11) NOT NULL,
      \`tenant_slug\` VARCHAR(80) NOT NULL,
      \`token_hash\` CHAR(64) NOT NULL,
      \`reason\` VARCHAR(255) NULL DEFAULT NULL,
      \`created_by_admin_id\` INT(11) NULL DEFAULT NULL,
      \`created_by_name\` VARCHAR(120) NULL DEFAULT NULL,
      \`created_by_email\` VARCHAR(190) NULL DEFAULT NULL,
      \`expires_at\` DATETIME NOT NULL,
      \`used_at\` DATETIME NULL DEFAULT NULL,
      \`used_ip\` VARCHAR(45) NULL DEFAULT NULL,
      \`used_user_agent\` VARCHAR(255) NULL DEFAULT NULL,
      \`revoked_at\` DATETIME NULL DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_saas_support_access_token_hash\` (\`token_hash\`),
      KEY \`idx_saas_support_access_tenant\` (\`tenant_id\`, \`created_at\`),
      KEY \`idx_saas_support_access_active\` (\`tenant_slug\`, \`expires_at\`, \`used_at\`, \`revoked_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  );
}

export async function createSupportAccessToken(slug: string, reasonInput: string, minutesInput: number, origin = "http://localhost:3000") {
  await ensureSupportAccessSchema();
  const tenant = await requireSaasTenant(slug);
  const reason = reasonInput.trim();
  if (!reason) throw new Error("Inserisci il motivo dell accesso supporto.");
  const minutes = Math.max(5, Math.min(240, minutesInput || 30));
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = addMinutes(minutes);
  const session = await currentSaasAdminSession().catch(() => null);
  const actor = session?.user;

  const result = await dbExecute(
    `INSERT INTO \`${SUPPORT_TABLE}\`(tenant_id,tenant_slug,token_hash,reason,created_by_admin_id,created_by_name,created_by_email,expires_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    [Number(tenant.id), String(tenant.slug), hash, reason, actor?.id ?? null, actor?.name || null, actor?.email || null, expiresAt],
  );
  await logSaasTenantAudit("support.token_create", tenant, "Token accesso supporto creato", { support_token_id: result.insertId, expires_at: expiresAt, reason });
  return {
    id: result.insertId,
    token,
    expires_at: expiresAt,
    link: `${origin.replace(/\/$/, "")}/${encodeURIComponent(String(tenant.slug))}?support_token=${encodeURIComponent(token)}`,
  };
}

export async function activeSupportTokens(tenantId: number): Promise<RowDataPacket[]> {
  await ensureSupportAccessSchema();
  return dbQuery<RowDataPacket[]>(
    `SELECT id,tenant_slug,reason,created_by_name,created_by_email,expires_at,created_at
       FROM \`${SUPPORT_TABLE}\`
      WHERE tenant_id=?
        AND used_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > ?
      ORDER BY id DESC`,
    [tenantId, mysqlNow()],
  );
}

export async function recentSupportTokens(tenantId: number, limit = 20): Promise<RowDataPacket[]> {
  await ensureSupportAccessSchema();
  const capped = Math.max(1, Math.min(80, limit));
  return dbQuery<RowDataPacket[]>(
    `SELECT id,tenant_slug,reason,created_by_name,created_by_email,expires_at,used_at,revoked_at,created_at
       FROM \`${SUPPORT_TABLE}\`
      WHERE tenant_id=?
      ORDER BY id DESC
      LIMIT ${capped}`,
    [tenantId],
  );
}

export async function revokeSupportToken(tokenId: number, slug: string): Promise<void> {
  const tenant = await requireSaasTenant(slug);
  if (tokenId <= 0) throw new Error("Token supporto non valido.");
  // Revocabile anche DOPO l'uso (Fase 4): la sessione supporto attiva e'
  // vincolata al token — revocarlo la termina immediatamente.
  await dbExecute(
    `UPDATE \`${SUPPORT_TABLE}\`
        SET revoked_at=NOW()
      WHERE id=?
        AND tenant_id=?
        AND revoked_at IS NULL`,
    [tokenId, Number(tenant.id)],
  );
  await logSaasTenantAudit("support.token_revoke", tenant, "Token accesso supporto revocato", { support_token_id: tokenId });
}

export async function consumeSupportAccessToken({
  slug,
  token,
  ip,
  userAgent,
}: {
  slug: string;
  token: string;
  ip?: string;
  userAgent?: string;
}): Promise<{ ok: true; session: ManageSession; reason: string } | { ok: false; error: string }> {
  await ensureSupportAccessSchema();
  const tenantSlug = validateTenantSlug(slug);
  const tokenHash = crypto.createHash("sha256").update(token.trim()).digest("hex");
  const rows = await dbQuery<(RowDataPacket & { id: number; tenant_id: number; tenant_slug: string; expires_at: string; reason?: string; created_by_email?: string })[]>(
    `SELECT * FROM \`${SUPPORT_TABLE}\` WHERE tenant_slug=? AND token_hash=? LIMIT 1`,
    [tenantSlug, tokenHash],
  );
  const row = rows[0];
  if (!row) return { ok: false, error: "Token supporto non valido." };
  if (String(row.tenant_slug) !== tenantSlug) return { ok: false, error: "Token supporto non valido per questo tenant." };
  if (row.revoked_at) return { ok: false, error: "Token supporto revocato. Genera un nuovo accesso supporto." };
  if (row.used_at) return { ok: false, error: "Token supporto gia utilizzato. Genera un nuovo accesso supporto." };
  if (dateExpired(row.expires_at)) return { ok: false, error: "Token supporto scaduto. Genera un nuovo accesso supporto." };

  const tenant = await saasTenantBySlug(tenantSlug);
  if (!tenant || Number(tenant.is_active ?? 0) !== 1 || tenantStatus(tenant) !== "active") {
    return { ok: false, error: "Tenant non attivo per accesso supporto." };
  }

  const users = await dbQuery<RowDataPacket[]>(
    "SELECT * FROM `users` WHERE tenant_id=? AND role='admin' ORDER BY id ASC LIMIT 1",
    [Number(tenant.id)],
  ).catch(() => []);
  const user = users[0];
  if (!user) return { ok: false, error: "Admin tenant non disponibile per accesso supporto." };

  const locationId = await firstTenantLocationId(Number(tenant.id));
  const session: ManageSession = {
    tenantSlug,
    user: {
      id: Number(user.id ?? 0),
      email: String(user.email ?? ""),
      name: String(user.full_name ?? user.name ?? user.email ?? "Supporto"),
      role: "admin",
      perms: allAssignablePermissions(),
      needsEmailVerification: false,
      currentLocationId: locationId,
      needsLocationSelection: false,
      locationIds: [],
    },
    issuedAt: Date.now(),
    // Epoca di revoca corrente dell'utente: senza, la sessione viene
    // rifiutata appena users.session_epoch > 0 (logout precedenti).
    epoch: Number((user as { session_epoch?: number }).session_epoch ?? 0) || 0,
    // Marker per il banner di trasparenza nel gestionale (Fase 4).
    support: { tokenId: Number(row.id) },
  };

  await dbExecute(
    `UPDATE \`${SUPPORT_TABLE}\`
        SET used_at=NOW(), used_ip=?, used_user_agent=?
      WHERE id=?`,
    [truncate(ip ?? "", 45) || null, truncate(userAgent ?? "", 255) || null, Number(row.id)],
  );
  await logSaasTenantAudit("support.token_consume", tenant, "Accesso supporto usato", {
    support_token_id: Number(row.id),
    created_by_email: String(row.created_by_email ?? ""),
    reason: String(row.reason ?? ""),
  });
  return { ok: true, session, reason: String(row.reason ?? "") };
}

export async function listSaasAdmins(): Promise<SaasAdminRecord[]> {
  await ensureSaasAuthSchema();
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT id,name,email,role,is_active,last_login_at,created_at,updated_at FROM `saas_admins` ORDER BY id ASC",
  );
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    name: String(row.name ?? ""),
    email: String(row.email ?? ""),
    role: normalizeAdminRole(String(row.role ?? "admin")),
    is_active: Number(row.is_active ?? 1),
    last_login_at: dateString(row.last_login_at),
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  }));
}

export async function createSaasAdmin(input: Record<string, string>): Promise<number> {
  await ensureSaasAuthSchema();
  const name = (input.name ?? "").trim();
  const email = normalizeEmail(input.email ?? "");
  const password = input.password ?? "";
  const role = normalizeAdminRole(input.role ?? "admin");
  if (!name) throw new Error("Nome admin obbligatorio.");
  if (!email) throw new Error("Email admin obbligatoria.");
  if (!password) throw new Error("Password admin obbligatoria.");
  const existing = await dbQuery<RowDataPacket[]>("SELECT id FROM `saas_admins` WHERE email=? LIMIT 1", [email]);
  if (existing.length) throw new Error("Esiste gia un admin SaaS con questa email.");
  const result = await dbExecute(
    "INSERT INTO `saas_admins`(name,email,password_hash,role,is_active) VALUES(?,?,?,?,1)",
    [name, email, await bcrypt.hash(password, 10), role],
  );
  await logSaasTenantAudit("saas_admin.create", null, "Admin SaaS creato", { admin_id: result.insertId, email, role });
  return result.insertId;
}

export async function updateSaasAdmin(id: number, input: Record<string, string>, currentUser: SaasAdminUser): Promise<void> {
  await ensureSaasAuthSchema();
  const admin = await requireAdminRecord(id);
  const name = (input.name ?? "").trim();
  const email = normalizeEmail(input.email ?? "");
  const role = normalizeAdminRole(input.role ?? "admin");
  const active = truthy(input.is_active) ? 1 : 0;
  if (!name) throw new Error("Nome admin obbligatorio.");
  if (!email) throw new Error("Email admin obbligatoria.");
  if (id === currentUser.id && active !== 1) throw new Error("Non puoi disattivare il tuo account corrente.");
  if (admin.role === "owner" && role !== "owner" && await ownerCount() <= 1) throw new Error("Deve esistere almeno un owner SaaS.");
  if (admin.role === "owner" && active !== 1 && await ownerCount() <= 1) throw new Error("Non puoi disattivare l ultimo owner SaaS.");

  const duplicate = await dbQuery<RowDataPacket[]>("SELECT id FROM `saas_admins` WHERE email=? AND id<>? LIMIT 1", [email, id]);
  if (duplicate.length) throw new Error("Email gia assegnata a un altro admin SaaS.");
  await dbExecute("UPDATE `saas_admins` SET name=?, email=?, role=?, is_active=? WHERE id=?", [name, email, role, active, id]);
  await logSaasTenantAudit("saas_admin.update", null, "Admin SaaS aggiornato", { admin_id: id, email, role, is_active: active });
}

export async function resetSaasAdminPassword(id: number, password: string): Promise<void> {
  await ensureSaasAuthSchema();
  const admin = await requireAdminRecord(id);
  if (!password.trim()) throw new Error("Password obbligatoria.");
  await dbExecute("UPDATE `saas_admins` SET password_hash=? WHERE id=?", [await bcrypt.hash(password, 10), id]);
  await logSaasTenantAudit("saas_admin.password_reset", null, "Password admin SaaS aggiornata", { admin_id: id, email: admin.email });
}

export function roleLabel(role: string): string {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  if (role === "viewer") return "Viewer";
  return role;
}

export function adminRoles(): SaasAdminRole[] {
  return ADMIN_ROLES;
}

export async function ensureCanManageAdmins(user: SaasAdminUser): Promise<void> {
  if (!canManageSaasAdmins(user)) throw new Error("Solo un owner SaaS puo gestire gli admin.");
}

async function decorateTenant(row: SaasTenantRow): Promise<SaasTenantRow> {
  // Fase A pannello (2026-07-19): la salute in lista viene dallo SNAPSHOT
  // denormalizzato (health_* su saas_tenants, aggiornato da cron/verifica
  // manuale/repair) — MAI diagnostica live per riga: con N tenant erano
  // N x schemaDiagnostics a ogni lista (3-4s gia' con 2 tenant).
  const stored = storedHealth(row);
  return {
    ...row,
    health: stored ?? {
      level: "warning" as SaasHealthLevel,
      warnings: 1,
      errors: 0,
      checks: [],
      missing_schema: [],
      source: "mai_verificata",
    },
    onboarding_percent: onboardingPercent(row),
    health_checked_at: dateString(row.health_checked_at),
    onboarding_started_at: dateString(row.onboarding_started_at),
    onboarding_completed_at: dateString(row.onboarding_completed_at),
    onboarding_dismissed_at: dateString(row.onboarding_dismissed_at),
  };
}

async function seedTenantDefaults({
  tenantId,
  tenantName,
  adminName,
  adminEmail,
  adminPass,
}: {
  tenantId: number;
  slug: string;
  tenantName: string;
  adminName: string;
  adminEmail: string;
  adminPass: string;
}): Promise<void> {
  await seedTenantPermissions(tenantId);
  const adminUserId = await insertKnown("users", {
    tenant_id: tenantId,
    name: adminName,
    full_name: adminName,
    email: adminEmail,
    password_hash: await bcrypt.hash(adminPass, 10),
    role: "admin",
    email_verified_at: mysqlNow(),
  });
  const adminStaffId = await insertKnown("staff", {
    tenant_id: tenantId,
    full_name: adminName,
    phone: null,
    email: adminEmail,
    is_active: 1,
    calendar_color: null,
  });
  await insertKnown("businesses", {
    tenant_id: tenantId,
    name: tenantName,
    email: adminEmail,
    phone: null,
    booking_choose_staff_enabled: 0,
    booking_products_enabled: 0,
  });
  const locationId = await insertKnown("locations", {
    tenant_id: tenantId,
    name: "Sede principale",
    address: null,
    is_active: 1,
    phone: null,
    email: adminEmail,
    booking_enabled: 1,
    marketplace_enabled: 1,
    sort_order: 0,
  });
  await seedDefaultHours(tenantId, locationId);
  await seedAutomationSettings(tenantId);
  await seedPosSettings(tenantId);
  await insertKnown("user_locations", { tenant_id: tenantId, user_id: adminUserId, location_id: locationId }, true);
  await insertKnown("staff_locations", { tenant_id: tenantId, staff_id: adminStaffId, location_id: locationId }, true);
  await initializeOnboarding(tenantId, true);
}

async function seedTenantPermissions(tenantId: number): Promise<void> {
  if (!await freshTableExists("permissions")) return;
  for (const definition of permissionDefinitions) {
    await insertKnown("permissions", {
      tenant_id: tenantId,
      perm: definition.perm,
      label: definition.label,
      group_name: definition.groupName,
      sort_order: definition.sortOrder,
    }, true).catch(() => undefined);
  }
}

async function seedDefaultHours(tenantId: number, locationId: number): Promise<void> {
  if (!locationId || !await freshTableExists("business_hours")) return;
  const openDays = new Set([1, 2, 3, 4, 5, 6]);
  for (let dow = 0; dow <= 6; dow += 1) {
    await insertKnown("business_hours", {
      tenant_id: tenantId,
      location_id: locationId,
      dow,
      opens: openDays.has(dow) ? "09:00:00" : null,
      closes: openDays.has(dow) ? "19:00:00" : null,
      opens2: null,
      closes2: null,
      is_closed: openDays.has(dow) ? 0 : 1,
    }, true).catch(() => undefined);
  }
}

async function seedAutomationSettings(tenantId: number): Promise<void> {
  await insertKnown("automation_settings", {
    tenant_id: tenantId,
    reminder_enabled: 1,
    reminder_hours: 24,
    approved_enabled: 1,
    approved_subject: "Appuntamento confermato",
    approved_body: "Il tuo appuntamento e stato confermato.",
    modified_enabled: 1,
    modified_subject: "Appuntamento modificato",
    modified_body: "Il tuo appuntamento e stato modificato.",
    rejected_enabled: 1,
    rejected_subject: "Appuntamento rifiutato",
    rejected_body: "La tua richiesta di appuntamento non e stata accettata.",
    reminder_subject: "Promemoria appuntamento",
    reminder_body: "Ti ricordiamo il tuo appuntamento.",
    sms_reminder_enabled: 0,
    sms_reminder_hours: 24,
    sms_reminder_sender: "Prenodo",
  }, true).catch(() => undefined);
}

async function seedPosSettings(tenantId: number): Promise<void> {
  await insertKnown("pos_settings", {
    tenant_id: tenantId,
    id: 1,
    preorders_expiry_enabled: 0,
    preorders_expiry_value: 0,
    preorders_expiry_unit: "days",
    prepaids_expiry_enabled: 0,
    prepaids_expiry_value: 0,
    prepaids_expiry_unit: "days",
  }, true).catch(() => undefined);
}

async function assignAllActiveLocations(tenantId: number, userId: number, staffId: number): Promise<void> {
  const rows = await dbQuery<RowDataPacket[]>("SELECT id FROM `locations` WHERE tenant_id=? AND COALESCE(is_active,1)=1 ORDER BY id ASC", [tenantId]).catch(() => []);
  for (const row of rows) {
    const locationId = Number(row.id ?? 0);
    if (locationId <= 0) continue;
    if (userId > 0) await insertKnown("user_locations", { tenant_id: tenantId, user_id: userId, location_id: locationId }, true).catch(() => undefined);
    if (staffId > 0) await insertKnown("staff_locations", { tenant_id: tenantId, staff_id: staffId, location_id: locationId }, true).catch(() => undefined);
  }
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
    `INSERT INTO \`${ONBOARDING_TABLE}\`(tenant_id,status,current_step,completed_steps_json,skipped_steps_json) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`,
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

async function ensureAuditTable(): Promise<void> {
  if (await tableExists(AUDIT_TABLE)) return;
  await dbExecute(
    `CREATE TABLE IF NOT EXISTS \`${AUDIT_TABLE}\` (
      \`id\` INT(11) NOT NULL AUTO_INCREMENT,
      \`actor_admin_id\` INT(11) NULL DEFAULT NULL,
      \`actor_name\` VARCHAR(120) NULL DEFAULT NULL,
      \`actor_email\` VARCHAR(190) NULL DEFAULT NULL,
      \`tenant_id\` INT(11) NULL DEFAULT NULL,
      \`tenant_slug\` VARCHAR(80) NULL DEFAULT NULL,
      \`action\` VARCHAR(80) NOT NULL,
      \`message\` VARCHAR(255) NULL DEFAULT NULL,
      \`meta_json\` LONGTEXT NULL DEFAULT NULL,
      \`ip\` VARCHAR(45) NULL DEFAULT NULL,
      \`user_agent\` VARCHAR(255) NULL DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_saas_tenant_audit_tenant\` (\`tenant_id\`, \`created_at\`),
      KEY \`idx_saas_tenant_audit_action\` (\`action\`, \`created_at\`),
      KEY \`idx_saas_tenant_audit_actor\` (\`actor_admin_id\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  );
}

async function ensureHealthCheckTable(): Promise<void> {
  if (await tableExists(HEALTH_TABLE)) return;
  await dbExecute(
    `CREATE TABLE IF NOT EXISTS \`${HEALTH_TABLE}\` (
      \`id\` INT(11) NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT(11) NOT NULL,
      \`tenant_slug\` VARCHAR(80) NOT NULL,
      \`level\` ENUM('ok','warning','error') NOT NULL DEFAULT 'ok',
      \`errors_count\` INT(11) NOT NULL DEFAULT 0,
      \`warnings_count\` INT(11) NOT NULL DEFAULT 0,
      \`source\` VARCHAR(30) NULL DEFAULT NULL,
      \`checks_json\` LONGTEXT NULL DEFAULT NULL,
      \`missing_schema_json\` LONGTEXT NULL DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_saas_health_tenant\` (\`tenant_id\`, \`created_at\`),
      KEY \`idx_saas_health_level\` (\`level\`, \`created_at\`),
      KEY \`idx_saas_health_source\` (\`source\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  );
}

async function schemaDiagnostics(slug: string): Promise<{ missing: string[] }> {
  const missing: string[] = [];
  const shared = await usesSharedTenantSchema();
  const prefix = tenantPrefix(slug);
  for (const table of TENANT_BASE_TABLES) {
    if (shared) {
      if (!await freshTableExists(table)) missing.push(table);
      else if (!await freshColumnExists(table, "tenant_id")) missing.push(`${table}.tenant_id`);
    } else {
      const physical = `${prefix}${table}`;
      if (!await freshTableExists(physical)) missing.push(physical);
    }
  }
  return { missing };
}

async function syncLocationVisibility(slug: string, bookingAllowed: number, marketplaceAllowed: number): Promise<void> {
  const tenant = await saasTenantBySlug(slug);
  if (!tenant || !await freshTableExists("locations")) return;
  const values = await filterColumns("locations", { booking_enabled: bookingAllowed, marketplace_enabled: marketplaceAllowed });
  const entries = Object.entries(values);
  if (!entries.length) return;
  await dbExecute(
    `UPDATE \`locations\` SET ${entries.map(([key]) => `${quoteIdentifier(key)}=?`).join(",")} WHERE tenant_id=?`,
    [...entries.map(([, value]) => value), Number(tenant.id)],
  ).catch(() => undefined);
}

async function firstTenantLocationId(tenantId: number): Promise<number> {
  const rows = await dbQuery<RowDataPacket[]>("SELECT id FROM `locations` WHERE tenant_id=? ORDER BY COALESCE(is_active,1) DESC, id ASC LIMIT 1", [tenantId]).catch(() => []);
  return Number(rows[0]?.id ?? 0) || 0;
}

async function countQuery(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await dbQuery<RowDataPacket[]>(sql, params).catch(() => []);
  return Number(rows[0]?.["COUNT(*)"] ?? rows[0]?.count ?? 0);
}

async function updateTenantMeta(tenantId: number, values: Record<string, unknown>): Promise<void> {
  await updateKnown("saas_tenants", { id: tenantId }, values);
}

async function insertKnown(table: string, values: Record<string, unknown>, ignore = false): Promise<number> {
  if (!await freshTableExists(table)) throw new Error(`Tabella ${table} non trovata.`);
  const filtered = await filterColumns(table, values);
  const entries = Object.entries(filtered).filter(([, value]) => value !== undefined);
  if (!entries.length) throw new Error(`Nessun campo compatibile per ${table}.`);
  const result = await dbExecute(
    `INSERT INTO ${quoteIdentifier(table)} (${entries.map(([key]) => quoteIdentifier(key)).join(",")}) VALUES (${entries.map(() => "?").join(",")})${ignore ? " ON CONFLICT DO NOTHING" : ""}`,
    entries.map(([, value]) => value),
  );
  return Number(result.insertId ?? 0);
}

async function updateKnown(table: string, where: Record<string, unknown>, values: Record<string, unknown>): Promise<number> {
  if (!await freshTableExists(table)) return 0;
  const filtered = await filterColumns(table, values);
  const entries = Object.entries(filtered).filter(([, value]) => value !== undefined);
  if (!entries.length) return 0;
  const whereEntries = Object.entries(where);
  const assignments = entries.map(([key]) => `${quoteIdentifier(key)}=?`).join(",");
  const whereSql = whereEntries.map(([key]) => `${quoteIdentifier(key)}=?`).join(" AND ");
  const params = [...entries.map(([, value]) => value), ...whereEntries.map(([, value]) => value)];
  const result = await dbExecute(`UPDATE ${quoteIdentifier(table)} SET ${assignments} WHERE ${whereSql}`, params);
  return Number(result.affectedRows ?? 0);
}

async function filterColumns(table: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT COLUMN_NAME AS column_name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
    [table],
  );
  const columns = new Set(rows.map((row) => String(row.column_name ?? row.COLUMN_NAME)));
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => columns.has(key) && value !== undefined));
}

async function freshTableExists(table: string): Promise<boolean> {
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? LIMIT 1",
    [table],
  ).catch(() => []);
  return rows.length > 0;
}

async function freshColumnExists(table: string, column: string): Promise<boolean> {
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1",
    [table, column],
  ).catch(() => []);
  return rows.length > 0;
}

async function addColumnIfMissing(table: string, column: string, definition: string): Promise<void> {
  if (await freshColumnExists(table, column)) return;
  await dbExecute(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${definition}`).catch(() => undefined);
}

async function addIndexIfMissing(table: string, index: string, columns: string): Promise<void> {
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND tablename=? AND indexname=? LIMIT 1",
    [table, index],
  ).catch(() => []);
  if (rows.length > 0) return;
  await dbExecute(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(index)} ON ${quoteIdentifier(table)} (${columns})`).catch(() => undefined);
}

async function usesSharedTenantSchema(): Promise<boolean> {
  return await freshColumnExists("users", "tenant_id")
    && await freshColumnExists("permissions", "tenant_id")
    && await freshColumnExists("role_permissions", "tenant_id");
}

async function currentActorId(): Promise<number | null> {
  const session = await currentSaasAdminSession().catch(() => null);
  return session?.user.id && session.user.id > 0 ? session.user.id : null;
}

async function requireAdminRecord(id: number): Promise<SaasAdminRecord> {
  if (id <= 0) throw new Error("Admin SaaS non valido.");
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT id,name,email,role,is_active,last_login_at,created_at,updated_at FROM `saas_admins` WHERE id=? LIMIT 1",
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error("Admin SaaS non trovato.");
  return {
    id: Number(row.id ?? 0),
    name: String(row.name ?? ""),
    email: String(row.email ?? ""),
    role: normalizeAdminRole(String(row.role ?? "admin")),
    is_active: Number(row.is_active ?? 1),
    last_login_at: dateString(row.last_login_at),
    created_at: dateString(row.created_at),
    updated_at: dateString(row.updated_at),
  };
}

async function ownerCount(): Promise<number> {
  const rows = await dbQuery<RowDataPacket[]>("SELECT COUNT(*) AS count FROM `saas_admins` WHERE role='owner' AND is_active=1").catch(() => []);
  return Number(rows[0]?.count ?? 0);
}

function validateTenantSlug(value: string): string {
  const slug = normalizeTenantSlug(value)?.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_-]+/g, "").slice(0, 62) ?? "";
  if (!slug) throw new Error("Slug tenant obbligatorio.");
  if (!/^[a-z0-9][a-z0-9_-]{1,60}[a-z0-9]$/.test(slug)) throw new Error("Slug tenant non valido.");
  if (RESERVED_SLUGS.has(slug)) throw new Error("Slug riservato.");
  return slug;
}

function normalizeTenantStatus(value: string): SaasTenantStatus | null {
  return KNOWN_STATUSES.includes(value as SaasTenantStatus) ? value as SaasTenantStatus : null;
}

function normalizeHealthLevel(value: string): SaasHealthLevel {
  return value === "error" || value === "warning" ? value : "ok";
}

function normalizeAdminRole(role: string): SaasAdminRole {
  return role === "owner" || role === "viewer" ? role : "admin";
}

function storedHealth(row: SaasTenantRow): SaasTenantHealth | null {
  const level = normalizeHealthLevel(String(row.health_level ?? ""));
  if (!row.health_level) return null;
  return {
    level,
    warnings: Number(row.health_warnings ?? 0),
    errors: Number(row.health_errors ?? 0),
    checked_at: dateString(row.health_checked_at) ?? "",
    source: String(row.health_source ?? ""),
    checks: [],
    missing_schema: [],
  };
}

function onboardingPercent(row: SaasTenantRow): number {
  if ((row.onboarding_status ?? "") === "completed") return 100;
  const completed = jsonList(row.completed_steps_json ?? "[]");
  const skipped = jsonList(row.skipped_steps_json ?? "[]");
  const covered = new Set([...completed, ...skipped].filter((step) => onboardingSteps.some((candidate) => candidate.key === step)));
  return Math.min(100, Math.round((covered.size / Math.max(1, onboardingSteps.length)) * 100));
}

function jsonList(json: string): string[] {
  try {
    const parsed = JSON.parse(json || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function publicVisibility(tenant: SaasTenantRow) {
  return {
    booking_public_allowed: Number(tenant.booking_public_allowed ?? 1) === 1,
    marketplace_public_allowed: Number(tenant.marketplace_public_allowed ?? 1) === 1,
  };
}

function cleanHealthSource(value: string): string {
  return (value.trim().replace(/[^a-z0-9_-]/gi, "") || "manual").slice(0, 30);
}

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function dateString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return mysqlDate(value);
  return String(value);
}

function addMinutes(minutes: number): string {
  return mysqlDate(new Date(Date.now() + minutes * 60 * 1000));
}

function dateExpired(value: string): boolean {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.getTime() <= Date.now();
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function mysqlNow(): string {
  return mysqlDate(new Date());
}

function mysqlDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
