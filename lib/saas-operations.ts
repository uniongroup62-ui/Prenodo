import "server-only";

import fs from "node:fs";
import path from "node:path";
import type { RowDataPacket } from "@/lib/tenant-db";
import { currentSaasAdminSession } from "@/lib/saas-admin-auth";
import { dbExecute, dbQuery, quoteIdentifier, tableExists, tenantTable, usesSharedTenantTables } from "@/lib/tenant-db";
import { logSaasTenantAudit, listSaasTenants, requireSaasTenant, tenantStatus, type SaasTenantRow } from "@/lib/saas-tenant-manager";
import { getPrivateObject, putPrivateObject, storagePrivateConfigured } from "@/lib/storage";
import { tenantPrefix } from "@/lib/tenant-runtime";

// Prefisso dei backup_path su R2 (Fase C pannello, 2026-07-19): il filesystem
// di Amplify e' EFFIMERO — un backup su disco sparisce al primo redeploy. Con
// R2 configurato il JSON va nel bucket PRIVATO; il disco resta solo come
// fallback dev/emergenza. Il prefisso 'r2:' nel path distingue i due mondi.
export const BACKUP_R2_PREFIX = "r2:";

export function saasBackupR2Key(slug: string, filename: string): string {
  return `saas-backups/${slug}/${filename}`;
}

type TenantTableMode = "prefixed" | "shared" | "base";

export type SaasBackupRow = RowDataPacket & {
  id: number;
  tenant_id: number;
  tenant_slug: string;
  reason?: string | null;
  backup_path: string;
  backup_size: number;
  status: "completed" | "failed";
  created_at?: string | Date | null;
};

export type SaasSmsPricingSettings = RowDataPacket & {
  id?: number;
  provider_cost_per_segment: number | string;
  target_margin_percent: number | string;
  payment_fee_percent: number | string;
  payment_fee_fixed: number | string;
  suggested_credit_price: number | string;
  currency: string;
};

export type SaasSmsPlanRow = RowDataPacket & {
  id: number;
  name: string;
  credits: number;
  price_gross: number | string;
  currency: string;
  description?: string | null;
  is_active: number;
  is_featured: number;
  sort_order: number;
};

export type SaasSmsOrderRow = RowDataPacket & {
  id: number;
  tenant_id: number;
  tenant_slug: string;
  plan_id?: number | null;
  plan_name?: string | null;
  source: "manual" | "payment";
  status: "pending" | "paid" | "failed" | "refunded" | "cancelled";
  credits: number;
  amount_gross: number | string;
  currency: string;
  note?: string | null;
  paid_at?: string | Date | null;
  created_at?: string | Date | null;
};

export type SmsPlanEconomics = {
  price_per_credit: number;
  provider_cost: number;
  payment_fee: number;
  margin_value: number;
  margin_percent: number;
};

type SmsPricingLike = {
  provider_cost_per_segment?: number | string;
  target_margin_percent?: number | string;
  payment_fee_percent?: number | string;
  payment_fee_fixed?: number | string;
};

export type SmsProviderDiagnostics = {
  level: "ok" | "warning" | "error";
  available: boolean;
  configured: boolean;
  token_present: boolean;
  environment: string;
  base_url: string;
  sender: string;
  callback_configured: boolean;
  callback_url_configured: boolean;
  timeout: number;
  endpoint: { checked: boolean; ok: boolean; status_code: number; message: string };
  warnings: string[];
  errors: string[];
};

export type TenantSmsDiagnostics = {
  tenant_id: number;
  tenant_slug: string;
  tenant_name: string;
  level: "ok" | "warning" | "error";
  message: string;
  provider: Partial<SmsProviderDiagnostics>;
  endpoint: SmsProviderDiagnostics["endpoint"];
  settings: Record<string, unknown>;
  stats: Record<string, unknown>;
  latest: RowDataPacket[];
  warnings: string[];
  errors: string[];
};

export type CommunicationMovementRow = {
  tenant_id: number;
  tenant_slug: string;
  tenant_name: string;
  channel: "SMS" | "Email";
  kind: string;
  source: string;
  source_id: number;
  status: string;
  recipient: string;
  client_name: string;
  reference: string;
  subject?: string;
  scheduled_at?: string;
  sent_at?: string;
  delivered_at?: string;
  event_at: string;
  sort_at: string;
  segments?: number | null;
  credits?: number | null;
  provider?: string;
  provider_state?: string;
  provider_message_id?: string;
  last_error?: string;
};

const BACKUP_TABLE = "saas_tenant_backups";
const HISTORY_DAYS = 30;
const CENTRAL_BACKUP_EXCLUDES = new Set([
  "saas_admins",
  "saas_admin_login_attempts",
  "saas_professional_signups",
  "saas_support_access_tokens",
  "saas_tenant_audit_logs",
  "saas_tenant_backups",
  "saas_tenant_health_checks",
  "saas_tenants",
  "saas_sms_order_events",
  "saas_sms_orders",
  "saas_sms_plans",
  "saas_sms_pricing_settings",
]);

export async function ensureSaasBackupSchema(): Promise<void> {
  if (await tableExists(BACKUP_TABLE)) return;
  await dbExecute(
    `CREATE TABLE IF NOT EXISTS \`${BACKUP_TABLE}\` (
      \`id\` INT(11) NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT(11) NOT NULL,
      \`tenant_slug\` VARCHAR(80) NOT NULL,
      \`created_by_admin_id\` INT(11) NULL DEFAULT NULL,
      \`created_by_name\` VARCHAR(120) NULL DEFAULT NULL,
      \`created_by_email\` VARCHAR(190) NULL DEFAULT NULL,
      \`reason\` VARCHAR(255) NULL DEFAULT NULL,
      \`backup_path\` VARCHAR(500) NOT NULL,
      \`backup_size\` BIGINT(20) NOT NULL DEFAULT 0,
      \`status\` ENUM('completed','failed') NOT NULL DEFAULT 'completed',
      \`meta_json\` LONGTEXT NULL DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_saas_tenant_backups_tenant\` (\`tenant_id\`, \`created_at\`),
      KEY \`idx_saas_tenant_backups_status\` (\`status\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  );
}

export async function createSaasTenantBackup(slug: string, reason = ""): Promise<{ id: number; path: string; size: number; filename: string }> {
  await ensureSaasBackupSchema();
  const tenant = await requireSaasTenant(slug);

  const stamp = timestampForFilename();
  const baseName = `${stamp}_${String(tenant.slug).replace(/[^a-z0-9_-]/gi, "_")}`;
  const filename = `${baseName}.json`;
  const payload = await buildBackupPayload(tenant, reason.trim());
  const bytes = Buffer.from(JSON.stringify(payload, null, 2), "utf8");

  // R2 PRIMARIO quando configurato (durabile), disco solo come fallback.
  let storedPath = "";
  let storage: "r2" | "local" | "local_fallback" = "local";
  if (storagePrivateConfigured()) {
    const key = saasBackupR2Key(String(tenant.slug), filename);
    try {
      await putPrivateObject(key, new Uint8Array(bytes), "application/json");
      storedPath = `${BACKUP_R2_PREFIX}${key}`;
      storage = "r2";
    } catch {
      storage = "local_fallback";
    }
  }
  if (!storedPath) {
    const dir = path.join(/*turbopackIgnore: true*/ backupRoot(), String(tenant.slug));
    await fs.promises.mkdir(dir, { recursive: true });
    const jsonPath = path.join(/*turbopackIgnore: true*/ dir, filename);
    await fs.promises.writeFile(jsonPath, bytes);
    storedPath = relativeToProjectRoot(jsonPath);
  }

  const actor = await currentSaasAdminSession().catch(() => null);
  const meta = { tables: Object.keys(payload.tables).length, upload_files: payload.uploads.files.length, storage };
  const result = await dbExecute(
    `INSERT INTO \`${BACKUP_TABLE}\`(tenant_id,tenant_slug,created_by_admin_id,created_by_name,created_by_email,reason,backup_path,backup_size,status,meta_json)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [
      Number(tenant.id),
      String(tenant.slug),
      actor?.user.id ?? null,
      actor?.user.name || null,
      actor?.user.email || null,
      reason.trim() || null,
      storedPath,
      bytes.byteLength,
      "completed",
      JSON.stringify(meta),
    ],
  );

  const id = Number(result.insertId ?? 0);
  await logSaasTenantAudit("tenant.backup_create", tenant, "Backup tenant creato", { backup_id: id, path: storedPath, size: bytes.byteLength, storage });
  return { id, path: storedPath, size: bytes.byteLength, filename };
}

export function isR2BackupPath(backupPath: string): boolean {
  return backupPath.startsWith(BACKUP_R2_PREFIX);
}

export function r2BackupKey(backupPath: string): string {
  return backupPath.slice(BACKUP_R2_PREFIX.length);
}

export async function listSaasTenantBackups(tenantId: number, limit = 30): Promise<SaasBackupRow[]> {
  await ensureSaasBackupSchema();
  const capped = Math.max(1, Math.min(100, limit));
  if (tenantId <= 0) return [];
  return dbQuery<SaasBackupRow[]>(`SELECT * FROM \`${BACKUP_TABLE}\` WHERE tenant_id=? ORDER BY id DESC LIMIT ${capped}`, [tenantId]);
}

export async function saasBackupById(id: number, tenantId: number): Promise<SaasBackupRow | null> {
  await ensureSaasBackupSchema();
  if (id <= 0 || tenantId <= 0) return null;
  const rows = await dbQuery<SaasBackupRow[]>(`SELECT * FROM \`${BACKUP_TABLE}\` WHERE id=? AND tenant_id=? LIMIT 1`, [id, tenantId]);
  return rows[0] ?? null;
}

// Candidati al RIPRISTINO (feature restore, 2026-07-19): l'ultimo backup di
// ogni slug che NON esiste piu' in saas_tenants — il caso disaster-recovery
// post-eliminazione. La riga backup sopravvive alla delete (registro KEEP).
export async function restorableSaasBackups(limit = 20): Promise<SaasBackupRow[]> {
  await ensureSaasBackupSchema();
  const capped = Math.max(1, Math.min(50, limit));
  return dbQuery<SaasBackupRow[]>(
    `SELECT b.* FROM \`${BACKUP_TABLE}\` b
      WHERE b.status='completed'
        AND b.id = (SELECT MAX(b2.id) FROM \`${BACKUP_TABLE}\` b2 WHERE b2.tenant_slug = b.tenant_slug AND b2.status='completed')
        AND NOT EXISTS (SELECT 1 FROM \`saas_tenants\` t WHERE t.slug = b.tenant_slug)
      ORDER BY b.id DESC LIMIT ${capped}`,
  );
}

// RIPRISTINO GUIDATO da backup: ricrea il tenant eliminato con gli ID
// ORIGINALI (le righe condivise del payload li referenziano tra loro; gli id
// liberati dalla delete non vengono riusati dalle sequence, quindi il
// reinserimento verbatim e' sicuro). Solo per slug NON esistenti: mai
// sovrascrivere un tenant vivo.
export async function restoreSaasTenantBackup(backupId: number, confirmSlug: string): Promise<{ slug: string; tables_restored: number; rows_restored: number; warnings: string[] }> {
  await ensureSaasBackupSchema();
  const rows = await dbQuery<SaasBackupRow[]>(`SELECT * FROM \`${BACKUP_TABLE}\` WHERE id=? LIMIT 1`, [backupId]);
  const backup = rows[0];
  if (!backup) throw new Error("Backup non trovato.");
  const slug = String(backup.tenant_slug);
  if (confirmSlug.trim() !== slug) throw new Error("Conferma ripristino non valida: digita lo slug esatto.");

  const { saasTenantBySlug } = await import("@/lib/saas-tenant-manager");
  if (await saasTenantBySlug(slug)) throw new Error("Esiste gia un tenant con questo slug: il ripristino sovrascriverebbe dati vivi.");

  // Payload da R2 o dal disco (fallback dev), con le stesse guardie del download.
  const storedPath = String(backup.backup_path ?? "");
  let payloadRaw: string;
  if (isR2BackupPath(storedPath)) {
    payloadRaw = (await getPrivateObject(r2BackupKey(storedPath))).toString("utf8");
  } else {
    payloadRaw = await fs.promises.readFile(await absoluteSaasBackupPath(backup), "utf8");
  }
  const payload = JSON.parse(payloadRaw) as { tenant?: Record<string, unknown>; tables?: Record<string, { mode: string; rows: Record<string, unknown>[] }> };
  const tenantRow = payload.tenant;
  if (!tenantRow || Number(tenantRow.id) !== Number(backup.tenant_id)) throw new Error("Payload backup non valido o non coerente col registro.");

  const warnings: string[] = [];
  let tablesRestored = 0;
  let rowsRestored = 0;

  try {
    await dbExecute("SET session_replication_role = 'replica'").catch(() => undefined);

    // 1) riga saas_tenants con id ORIGINALE; stato riportato ad active e
    //    campi di eliminazione azzerati.
    const tenantValues = await filterColumns("saas_tenants", {
      ...tenantRow,
      is_active: 1,
      status: "active",
      deleted_at: null,
      deleted_reason: null,
      notes: `${String(tenantRow.notes ?? "")}`.trim() || null,
    });
    const columns = Object.keys(tenantValues);
    await dbExecute(
      `INSERT INTO \`saas_tenants\`(${columns.map((c) => quoteIdentifier(c)).join(",")}) VALUES(${columns.map(() => "?").join(",")})`,
      columns.map((c) => tenantValues[c] as unknown),
    );

    // 2) tabelle condivise: reinserimento verbatim filtrato sulle colonne
    //    ESISTENTI (lo schema puo' essere evoluto dopo il backup).
    for (const [table, data] of Object.entries(payload.tables ?? {})) {
      if (data.mode !== "shared" || !Array.isArray(data.rows) || data.rows.length === 0) continue;
      if (!await freshTableExists(table)) { warnings.push(`${table}: tabella assente, ${data.rows.length} righe saltate`); continue; }
      let restored = 0;
      for (const row of data.rows) {
        const values = await filterColumns(table, row);
        const keys = Object.keys(values);
        if (!keys.length) continue;
        const ok = await dbExecute(
          `INSERT INTO ${quoteIdentifier(table)}(${keys.map((k) => quoteIdentifier(k)).join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
          keys.map((k) => values[k] as unknown),
        ).then(() => true).catch((error) => {
          if (warnings.length < 30) warnings.push(`${table}: ${error instanceof Error ? error.message.slice(0, 120) : "insert fallita"}`);
          return false;
        });
        if (ok) restored += 1;
      }
      if (restored > 0) tablesRestored += 1;
      rowsRestored += restored;
    }
  } finally {
    await dbExecute("SET session_replication_role = 'origin'").catch(() => undefined);
  }

  await logSaasTenantAudit("tenant.restore_from_backup", { id: Number(backup.tenant_id), slug }, "Tenant ripristinato da backup", {
    backup_id: backupId,
    tables_restored: tablesRestored,
    rows_restored: rowsRestored,
    warnings: warnings.slice(0, 10),
  });
  return { slug, tables_restored: tablesRestored, rows_restored: rowsRestored, warnings };
}

// REGISTRAZIONI SELF-SERVICE (feature signups, 2026-07-19): lettura CENSURATA
// (mai hash password/verifica verso il client) + eliminazione delle richieste
// morte, con guardia sui tenant vivi.
export async function listSaasSignups(limit = 50): Promise<Array<Record<string, unknown>>> {
  if (!await tableExists("saas_professional_signups")) return [];
  const capped = Math.max(1, Math.min(100, limit));
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT s.id, s.business_name, s.slug, s.owner_name, s.owner_email, s.owner_phone, s.status,
            s.verified_at, s.provisioning_error, s.tenant_id, s.created_at,
            (SELECT COUNT(*) FROM \`saas_tenants\` t WHERE t.slug = s.slug) AS tenant_exists
       FROM \`saas_professional_signups\` s
      ORDER BY s.id DESC LIMIT ${capped}`,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    business_name: String(row.business_name ?? ""),
    slug: String(row.slug ?? ""),
    owner_name: String(row.owner_name ?? ""),
    owner_email: String(row.owner_email ?? ""),
    owner_phone: String(row.owner_phone ?? "") || null,
    status: String(row.status ?? ""),
    verified_at: dateString(row.verified_at) ?? null,
    provisioning_error: String(row.provisioning_error ?? "") || null,
    tenant_id: row.tenant_id === null || row.tenant_id === undefined ? null : Number(row.tenant_id),
    tenant_exists: Number(row.tenant_exists ?? 0) > 0,
    created_at: dateString(row.created_at) ?? null,
  }));
}

export async function deleteSaasSignup(id: number): Promise<void> {
  if (id <= 0) throw new Error("Registrazione non trovata.");
  const rows = await dbQuery<RowDataPacket[]>("SELECT id, slug, status, owner_email FROM `saas_professional_signups` WHERE id=? LIMIT 1", [id]);
  const row = rows[0];
  if (!row) throw new Error("Registrazione non trovata.");
  // Guardia: mai cancellare la richiesta di un tenant VIVO (storico del
  // provisioning); prima si elimina il tenant, poi la richiesta.
  const alive = await dbQuery<RowDataPacket[]>("SELECT 1 FROM `saas_tenants` WHERE slug=? LIMIT 1", [String(row.slug)]);
  if (alive.length) throw new Error("Il tenant di questa registrazione esiste ancora: elimina prima il tenant.");
  await dbExecute("DELETE FROM `saas_professional_signups` WHERE id=?", [id]);
  await logSaasTenantAudit("signup.delete", null, "Registrazione self-service eliminata", { signup_id: id, slug: String(row.slug), owner_email: String(row.owner_email ?? ""), status: String(row.status ?? "") });
}

export async function absoluteSaasBackupPath(backup: SaasBackupRow): Promise<string> {
  if (isR2BackupPath(String(backup.backup_path ?? ""))) throw new Error("Backup su R2: usa il download presigned.");
  const rawPath = String(backup.backup_path ?? "").replace(/[\\/]+/g, path.sep);
  const absolute = path.isAbsolute(rawPath) ? rawPath : path.join(/*turbopackIgnore: true*/ projectRootForBackups(), rawPath);
  const real = await fs.promises.realpath(absolute);
  const allowed = await fs.promises.realpath(backupRoot());
  const relative = path.relative(allowed, real);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Percorso backup non valido.");
  return real;
}

export async function ensureSaasSmsSchema(): Promise<void> {
  if (!await tableExists("saas_sms_pricing_settings")) await dbExecute(
    `CREATE TABLE IF NOT EXISTS \`saas_sms_pricing_settings\` (
      \`id\` INT(11) NOT NULL AUTO_INCREMENT,
      \`provider_cost_per_segment\` DECIMAL(10,4) NOT NULL DEFAULT 0.0490,
      \`target_margin_percent\` DECIMAL(6,2) NOT NULL DEFAULT 25.00,
      \`payment_fee_percent\` DECIMAL(6,2) NOT NULL DEFAULT 2.00,
      \`payment_fee_fixed\` DECIMAL(10,2) NOT NULL DEFAULT 0.30,
      \`suggested_credit_price\` DECIMAL(10,4) NOT NULL DEFAULT 0.0700,
      \`currency\` VARCHAR(3) NOT NULL DEFAULT 'EUR',
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  );

  if (!await tableExists("saas_sms_plans")) await dbExecute(
    `CREATE TABLE IF NOT EXISTS \`saas_sms_plans\` (
      \`id\` INT(11) NOT NULL AUTO_INCREMENT,
      \`name\` VARCHAR(120) NOT NULL,
      \`credits\` INT(11) NOT NULL DEFAULT 0,
      \`price_gross\` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      \`currency\` VARCHAR(3) NOT NULL DEFAULT 'EUR',
      \`description\` VARCHAR(255) NULL DEFAULT NULL,
      \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
      \`is_featured\` TINYINT(1) NOT NULL DEFAULT 0,
      \`sort_order\` INT(11) NOT NULL DEFAULT 0,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_saas_sms_plans_active\` (\`is_active\`, \`sort_order\`),
      KEY \`idx_saas_sms_plans_sort\` (\`sort_order\`, \`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  );

  if (!await tableExists("saas_sms_orders")) await dbExecute(
    `CREATE TABLE IF NOT EXISTS \`saas_sms_orders\` (
      \`id\` INT(11) NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT(11) NOT NULL,
      \`tenant_slug\` VARCHAR(80) NOT NULL,
      \`plan_id\` INT(11) NULL DEFAULT NULL,
      \`source\` ENUM('manual','payment') NOT NULL DEFAULT 'manual',
      \`status\` ENUM('pending','paid','failed','refunded','cancelled') NOT NULL DEFAULT 'pending',
      \`credits\` INT(11) NOT NULL DEFAULT 0,
      \`amount_gross\` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      \`currency\` VARCHAR(3) NOT NULL DEFAULT 'EUR',
      \`payment_provider\` VARCHAR(60) NULL DEFAULT NULL,
      \`payment_id\` VARCHAR(120) NULL DEFAULT NULL,
      \`note\` VARCHAR(255) NULL DEFAULT NULL,
      \`created_by_admin_id\` INT(11) NULL DEFAULT NULL,
      \`paid_at\` DATETIME NULL DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_saas_sms_orders_tenant\` (\`tenant_id\`, \`created_at\`),
      KEY \`idx_saas_sms_orders_status\` (\`status\`, \`created_at\`),
      KEY \`idx_saas_sms_orders_plan\` (\`plan_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  );

  if (!await tableExists("saas_sms_order_events")) await dbExecute(
    `CREATE TABLE IF NOT EXISTS \`saas_sms_order_events\` (
      \`id\` INT(11) NOT NULL AUTO_INCREMENT,
      \`order_id\` INT(11) NOT NULL,
      \`event_type\` VARCHAR(60) NOT NULL,
      \`message\` VARCHAR(255) NULL DEFAULT NULL,
      \`meta_json\` LONGTEXT NULL DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_saas_sms_order_events_order\` (\`order_id\`, \`created_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  );

  await ensureDefaultSmsSettings();
  await ensureDefaultSmsPlans();
}

export async function smsPricingSettings(): Promise<SaasSmsPricingSettings> {
  await ensureSaasSmsSchema();
  const rows = await dbQuery<SaasSmsPricingSettings[]>("SELECT * FROM `saas_sms_pricing_settings` ORDER BY id ASC LIMIT 1");
  return rows[0] ?? defaultSmsSettings();
}

export async function saveSmsPricingSettings(input: Record<string, string>): Promise<void> {
  await ensureSaasSmsSchema();
  const current = await smsPricingSettings();
  const id = Number(current.id ?? 0);
  const providerCost = money4(input.provider_cost_per_segment ?? "0.0490");
  const margin = percent(input.target_margin_percent ?? "25");
  const feePercent = percent(input.payment_fee_percent ?? "2");
  const feeFixed = money2(input.payment_fee_fixed ?? "0.30");
  let suggested = money4(input.suggested_credit_price ?? "0");
  if (suggested <= 0) suggested = suggestedCreditPrice({ provider_cost_per_segment: providerCost, target_margin_percent: margin, payment_fee_percent: feePercent });

  await dbExecute(
    `UPDATE \`saas_sms_pricing_settings\`
        SET provider_cost_per_segment=?, target_margin_percent=?, payment_fee_percent=?, payment_fee_fixed=?, suggested_credit_price=?, currency='EUR'
      WHERE id=?`,
    [providerCost, margin, feePercent, feeFixed, suggested, id],
  );
  await logSaasTenantAudit("sms_pricing.update", null, "Impostazioni prezzo SMS aggiornate", {
    provider_cost_per_segment: providerCost,
    target_margin_percent: margin,
    payment_fee_percent: feePercent,
    suggested_credit_price: suggested,
  });
}

export async function smsPlans(includeInactive = true): Promise<SaasSmsPlanRow[]> {
  await ensureSaasSmsSchema();
  const where = includeInactive ? "" : "WHERE is_active=1";
  return dbQuery<SaasSmsPlanRow[]>(`SELECT * FROM \`saas_sms_plans\` ${where} ORDER BY sort_order ASC, credits ASC, id ASC`);
}

export async function smsPlanById(id: number): Promise<SaasSmsPlanRow | null> {
  await ensureSaasSmsSchema();
  if (id <= 0) return null;
  const rows = await dbQuery<SaasSmsPlanRow[]>("SELECT * FROM `saas_sms_plans` WHERE id=? LIMIT 1", [id]);
  return rows[0] ?? null;
}

export async function saveSmsPlan(input: Record<string, string>): Promise<number> {
  await ensureSaasSmsSchema();
  const id = parseInteger(input.plan_id, 0);
  const existing = id > 0 ? await smsPlanById(id) : null;
  const name = (input.name ?? "").trim();
  const credits = Math.max(1, parseInteger(input.credits, 0));
  const price = money2(input.price_gross ?? "0");
  const description = (input.description ?? "").trim();
  const active = truthy(input.is_active) ? 1 : 0;
  const featured = truthy(input.is_featured) ? 1 : 0;
  const sortOrder = input.sort_order !== undefined ? Math.max(0, parseInteger(input.sort_order, 0)) : Number(existing?.sort_order ?? await nextSmsPlanSortOrder());

  if (!name) throw new Error("Nome piano obbligatorio.");
  if (price <= 0) throw new Error("Prezzo piano obbligatorio.");

  if (existing) {
    await dbExecute(
      `UPDATE \`saas_sms_plans\`
          SET name=?, credits=?, price_gross=?, currency='EUR', description=?, is_active=?, is_featured=?, sort_order=?
        WHERE id=?`,
      [name, credits, price, description || null, active, featured, sortOrder, id],
    );
    await logSaasTenantAudit("sms_plan.update", null, "Piano SMS aggiornato", { plan_id: id, name });
    return id;
  }

  const result = await dbExecute(
    "INSERT INTO `saas_sms_plans`(name,credits,price_gross,currency,description,is_active,is_featured,sort_order) VALUES(?,?,?,?,?,?,?,?)",
    [name, credits, price, "EUR", description || null, active, featured, sortOrder],
  );
  const newId = Number(result.insertId ?? 0);
  await logSaasTenantAudit("sms_plan.create", null, "Piano SMS creato", { plan_id: newId, name });
  return newId;
}

export async function moveSmsPlan(id: number, direction: number): Promise<void> {
  await ensureSaasSmsSchema();
  if (id <= 0) throw new Error("Piano SMS non trovato.");
  const plans = await smsPlans(true);
  const currentIndex = plans.findIndex((plan) => Number(plan.id) === id);
  if (currentIndex < 0) throw new Error("Piano SMS non trovato.");
  const targetIndex = currentIndex + (direction < 0 ? -1 : 1);
  if (targetIndex < 0 || targetIndex >= plans.length) return;
  const reordered = [...plans];
  [reordered[currentIndex], reordered[targetIndex]] = [reordered[targetIndex], reordered[currentIndex]];
  for (const [index, plan] of reordered.entries()) {
    await dbExecute("UPDATE `saas_sms_plans` SET sort_order=? WHERE id=?", [(index + 1) * 10, Number(plan.id)]);
  }
  await logSaasTenantAudit("sms_plan.reorder", null, "Ordine piani SMS aggiornato", { plan_id: id, direction: direction < 0 ? -1 : 1 });
}

export async function setSmsPlanActive(id: number, active: boolean): Promise<void> {
  const plan = await smsPlanById(id);
  if (!plan) throw new Error("Piano SMS non trovato.");
  await dbExecute("UPDATE `saas_sms_plans` SET is_active=? WHERE id=?", [active ? 1 : 0, id]);
  await logSaasTenantAudit(active ? "sms_plan.activate" : "sms_plan.deactivate", null, active ? "Piano SMS attivato" : "Piano SMS disattivato", { plan_id: id });
}

export async function createManualSmsTopUp(tenantSlug: string, creditsInput: number, planId: number | null, amountGrossInput: number, note = ""): Promise<number> {
  await ensureSaasSmsSchema();
  const tenant = await requireSaasTenant(tenantSlug);
  const plan = planId && planId > 0 ? await smsPlanById(planId) : null;
  const credits = Math.max(1, creditsInput > 0 ? creditsInput : Number(plan?.credits ?? 0));
  const amountGross = Math.max(0, money2(amountGrossInput > 0 ? String(amountGrossInput) : String(plan?.price_gross ?? 0)));
  const actor = await currentSaasAdminSession().catch(() => null);

  const result = await dbExecute(
    `INSERT INTO \`saas_sms_orders\`(tenant_id,tenant_slug,plan_id,source,status,credits,amount_gross,currency,note,created_by_admin_id)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [Number(tenant.id), String(tenant.slug), plan ? Number(plan.id) : null, "manual", "pending", credits, amountGross, "EUR", note.trim() || null, actor?.user.id ?? null],
  );
  const orderId = Number(result.insertId ?? 0);
  await recordSmsOrderEvent(orderId, "created", "Ricarica manuale creata");

  try {
    await addCreditsToTenantWallet(tenant, credits, orderId, note);
    await dbExecute("UPDATE `saas_sms_orders` SET status='paid', paid_at=NOW() WHERE id=?", [orderId]);
    await recordSmsOrderEvent(orderId, "paid", "Crediti accreditati manualmente");
    await logSaasTenantAudit("sms_credit.manual_topup", tenant, "Crediti SMS accreditati manualmente", { order_id: orderId, credits, amount_gross: amountGross });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Errore accredito.";
    await dbExecute("UPDATE `saas_sms_orders` SET status='failed', note=CONCAT(COALESCE(note,''), ?) WHERE id=?", [` Errore accredito: ${message}`, orderId]).catch(() => undefined);
    await recordSmsOrderEvent(orderId, "failed", message);
    throw error;
  }

  return orderId;
}

export async function smsOrders(limit = 30): Promise<SaasSmsOrderRow[]> {
  await ensureSaasSmsSchema();
  const capped = Math.max(1, Math.min(100, limit));
  return dbQuery<SaasSmsOrderRow[]>(
    `SELECT o.*, p.name AS plan_name
       FROM \`saas_sms_orders\` o
       LEFT JOIN \`saas_sms_plans\` p ON p.id=o.plan_id
      ORDER BY o.id DESC
      LIMIT ${capped}`,
  );
}

export async function smsSummary(): Promise<{ credits_sold: number; revenue_gross: number; orders_total: number; orders_pending: number }> {
  await ensureSaasSmsSchema();
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT
        COALESCE(SUM(CASE WHEN status='paid' THEN credits ELSE 0 END),0) AS credits_sold,
        COALESCE(SUM(CASE WHEN status='paid' THEN amount_gross ELSE 0 END),0) AS revenue_gross,
        COUNT(*) AS orders_total,
        COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS orders_pending
       FROM \`saas_sms_orders\``,
  );
  const row = rows[0] ?? {};
  return {
    credits_sold: Number(row.credits_sold ?? 0),
    revenue_gross: Number(row.revenue_gross ?? 0),
    orders_total: Number(row.orders_total ?? 0),
    orders_pending: Number(row.orders_pending ?? 0),
  };
}

export function smsPlanEconomics(plan: Partial<SaasSmsPlanRow>, settings: SmsPricingLike): SmsPlanEconomics {
  const credits = Math.max(1, Number(plan.credits ?? 0));
  const price = Math.max(0, Number(plan.price_gross ?? 0));
  const providerCost = credits * Math.max(0, Number(settings.provider_cost_per_segment ?? 0));
  const paymentFee = (price * (Math.max(0, Number(settings.payment_fee_percent ?? 0)) / 100)) + Math.max(0, Number(settings.payment_fee_fixed ?? 0));
  const margin = price - providerCost - paymentFee;
  return {
    price_per_credit: price > 0 ? price / credits : 0,
    provider_cost: providerCost,
    payment_fee: paymentFee,
    margin_value: margin,
    margin_percent: price > 0 ? (margin / price) * 100 : 0,
  };
}

export function suggestedCreditPrice(settings: SmsPricingLike): number {
  const cost = Math.max(0, Number(settings.provider_cost_per_segment ?? 0.049));
  const margin = Math.min(90, Math.max(0, Number(settings.target_margin_percent ?? 25))) / 100;
  const fee = Math.min(50, Math.max(0, Number(settings.payment_fee_percent ?? 2))) / 100;
  return round(cost / Math.max(0.1, 1 - margin - fee), 4);
}

export async function tenantWalletBalance(tenant: Pick<SaasTenantRow, "id" | "slug">): Promise<number> {
  await ensureTenantSmsCreditTables(tenant);
  const row = await tenantSmsCreditWalletRow(tenant);
  return Math.max(0, Number(row.balance_credits ?? 0));
}

export async function smsProviderDiagnostics(checkEndpoint = false): Promise<SmsProviderDiagnostics> {
  const config = openApiSmsConfig();
  const tokenPresent = config.token.trim() !== "";
  const configured = Boolean(config.enabled && tokenPresent);
  const endpoint = checkEndpoint && config.base_url
    ? await smsEndpointReachability(config.base_url)
    : { checked: false, ok: false, status_code: 0, message: configured ? "Non verificato." : "Provider non configurato." };
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!configured) errors.push("Token OpenAPI SMS mancante o provider disattivato.");
  if (checkEndpoint && configured && !endpoint.ok) warnings.push(endpoint.message || "Endpoint SMS non raggiungibile.");
  return {
    level: errors.length ? "error" : warnings.length ? "warning" : "ok",
    available: true,
    configured,
    token_present: tokenPresent,
    environment: config.environment,
    base_url: config.base_url,
    sender: config.sender,
    callback_configured: config.callback_secret.trim() !== "",
    callback_url_configured: config.callback_url.trim() !== "",
    timeout: config.timeout,
    endpoint,
    warnings,
    errors,
  };
}

export async function allTenantSmsDiagnostics(checkEndpoint = false): Promise<TenantSmsDiagnostics[]> {
  const tenants = await listSaasTenants();
  const rows: TenantSmsDiagnostics[] = [];
  for (const tenant of tenants) {
    if (tenantStatus(tenant) === "deleted") continue;
    rows.push(await tenantSmsDiagnostics(tenant, checkEndpoint));
  }
  return rows;
}

export async function tenantSmsDiagnostics(tenant: SaasTenantRow, checkEndpoint = false): Promise<TenantSmsDiagnostics> {
  const provider = await smsProviderDiagnostics(checkEndpoint);
  const warnings = [...provider.warnings];
  const errors = [...provider.errors];
  const settings: Record<string, unknown> = { available: false, enabled: false, hours: null, sender: "" };
  const stats: Record<string, unknown> = {
    total: 0,
    pending: 0,
    sent: 0,
    failed: 0,
    delivered: 0,
    last_sent_at: "",
    last_failed_at: "",
    last_error: "",
  };
  let latest: RowDataPacket[] = [];

  try {
    const automation = await tenantPhysicalTable(tenant, "automation_settings");
    if (automation.exists) {
      const scope = await tenantScopeClause(automation, "a", Number(tenant.id));
      const rows = await dbQuery<RowDataPacket[]>(
        `SELECT sms_reminder_enabled, sms_reminder_hours, sms_reminder_sender
           FROM ${quoteIdentifier(automation.name)} a
          ${scope ? `WHERE ${scope}` : ""}
          ORDER BY id ASC LIMIT 1`,
      );
      if (rows[0]) {
        settings.available = true;
        settings.enabled = Number(rows[0].sms_reminder_enabled ?? 0) === 1;
        settings.mode = settings.enabled ? "active" : "disabled";
        settings.hours = rows[0].sms_reminder_hours ?? null;
        settings.sender = String(rows[0].sms_reminder_sender ?? "");
      } else {
        warnings.push("Impostazioni automazioni non trovate.");
      }
    }
  } catch (error) {
    warnings.push(`Impostazioni SMS non leggibili: ${error instanceof Error ? error.message : "errore"}`);
  }

  try {
    const reminders = await tenantPhysicalTable(tenant, "reminders");
    if (reminders.exists) {
      const scope = await tenantScopeClause(reminders, "r", Number(tenant.id));
      const where = `r.channel='sms'${scope ? ` AND ${scope}` : ""}`;
      const rows = await dbQuery<RowDataPacket[]>(
        `SELECT r.status, COUNT(*) AS total
           FROM ${quoteIdentifier(reminders.name)} r
          WHERE ${where}
          GROUP BY r.status`,
      );
      for (const row of rows) {
        const status = String(row.status ?? "").toLowerCase();
        const count = Number(row.total ?? 0);
        stats.total = Number(stats.total ?? 0) + count;
        if (["pending", "sent", "failed"].includes(status)) stats[status] = count;
      }
      stats.delivered = await countRows(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(reminders.name)} r WHERE ${where} AND r.delivered_at IS NOT NULL`);
      const sentRows = await dbQuery<RowDataPacket[]>(`SELECT MAX(r.sent_at) AS value FROM ${quoteIdentifier(reminders.name)} r WHERE ${where} AND r.sent_at IS NOT NULL`);
      const failedRows = await dbQuery<RowDataPacket[]>(`SELECT MAX(r.last_checked_at) AS value FROM ${quoteIdentifier(reminders.name)} r WHERE ${where} AND r.status='failed'`);
      stats.last_sent_at = dateString(sentRows[0]?.value) ?? "";
      stats.last_failed_at = dateString(failedRows[0]?.value) ?? "";
      const errorRows = await dbQuery<RowDataPacket[]>(
        `SELECT r.last_error
           FROM ${quoteIdentifier(reminders.name)} r
          WHERE ${where} AND r.status='failed' AND COALESCE(r.last_error,'')<>''
          ORDER BY COALESCE(r.last_checked_at, r.created_at) DESC LIMIT 1`,
      );
      stats.last_error = String(errorRows[0]?.last_error ?? "");
      latest = await dbQuery<RowDataPacket[]>(
        `SELECT r.id, r.appointment_id, r.scheduled_at, r.sent_at, r.status, r.last_error, r.provider_state, r.provider_message_id, r.delivered_at, r.last_checked_at
           FROM ${quoteIdentifier(reminders.name)} r
          WHERE ${where}
          ORDER BY COALESCE(r.last_checked_at, r.sent_at, r.scheduled_at, r.created_at) DESC, r.id DESC
          LIMIT 8`,
      );
    }
  } catch (error) {
    warnings.push(`Storico invii SMS non leggibile: ${error instanceof Error ? error.message : "errore"}`);
  }

  if (Number(stats.failed ?? 0) > 0) warnings.push(`${Number(stats.failed)} invii SMS falliti nello storico.`);
  const level = errors.length ? "error" : warnings.length ? "warning" : "ok";
  const message = [
    provider.configured ? "Provider configurato" : "Provider non configurato",
    checkEndpoint ? provider.endpoint.ok ? "endpoint raggiungibile" : "endpoint da verificare" : "",
    settings.enabled ? "SMS attivi" : "SMS disattivi",
    `${Number(stats.sent ?? 0)} inviati`,
    Number(stats.failed ?? 0) > 0 ? `${Number(stats.failed)} falliti` : "",
  ].filter(Boolean).join(" - ");

  return {
    tenant_id: Number(tenant.id),
    tenant_slug: String(tenant.slug),
    tenant_name: String(tenant.name ?? tenant.slug),
    level,
    message,
    provider: {
      available: provider.available,
      configured: provider.configured,
      token_present: provider.token_present,
      environment: provider.environment,
      base_url: provider.base_url,
      sender: provider.sender,
      callback_configured: provider.callback_configured,
    },
    endpoint: provider.endpoint,
    settings,
    stats,
    latest,
    warnings,
    errors,
  };
}

export async function latestSmsMovements(limitPerTenant = 25, totalLimit = 120): Promise<CommunicationMovementRow[]> {
  return collectCommunicationMovements("sms", limitPerTenant, totalLimit);
}

export async function latestEmailMovements(limitPerTenant = 25, totalLimit = 120): Promise<CommunicationMovementRow[]> {
  return collectCommunicationMovements("email", limitPerTenant, totalLimit);
}

async function buildBackupPayload(tenant: SaasTenantRow, reason: string) {
  const tables: Record<string, { mode: string; physical_table?: string; rows: RowDataPacket[] }> = {};
  if (await usesSharedTenantTables()) {
    for (const table of await tenantTablesWithTenantId()) {
      const rows = await dbQuery<RowDataPacket[]>(`SELECT * FROM ${quoteIdentifier(table)} WHERE tenant_id=?`, [Number(tenant.id)]).catch(() => []);
      tables[table] = { mode: "shared", rows };
    }
  } else {
    const prefix = tenantPrefix(String(tenant.slug));
    for (const physical of await prefixedTenantTables(prefix)) {
      const logical = physical.startsWith(prefix) ? physical.slice(prefix.length) : physical;
      const rows = await dbQuery<RowDataPacket[]>(`SELECT * FROM ${quoteIdentifier(physical)}`).catch(() => []);
      tables[logical] = { mode: "prefixed", physical_table: physical, rows };
    }
  }

  return {
    created_at: new Date().toISOString(),
    reason,
    tenant,
    tables,
    uploads: await uploadsManifest(String(tenant.slug)),
  };
}

async function tenantTablesWithTenantId(): Promise<string[]> {
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT DISTINCT c.TABLE_NAME AS table_name
       FROM INFORMATION_SCHEMA.COLUMNS c
       JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME
      WHERE c.TABLE_SCHEMA=DATABASE()
        AND c.COLUMN_NAME='tenant_id'
        AND t.TABLE_TYPE='BASE TABLE'
      ORDER BY c.TABLE_NAME`,
  );
  return rows.map((row) => String(row.table_name ?? "")).filter((table) => table && !CENTRAL_BACKUP_EXCLUDES.has(table));
}

async function prefixedTenantTables(prefix: string): Promise<string[]> {
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT TABLE_NAME AS table_name
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA=DATABASE()
        AND TABLE_TYPE='BASE TABLE'
        AND TABLE_NAME LIKE ?
      ORDER BY TABLE_NAME`,
    [`${prefix}%`],
  );
  return rows.map((row) => String(row.table_name ?? "")).filter(Boolean);
}

async function uploadsManifest(slug: string): Promise<{ files: Array<{ relative_path: string; size: number; mtime: string }> }> {
  const files: Array<{ relative_path: string; size: number; mtime: string }> = [];
  const legacyRoot = projectRootForBackups();
  const appRoot = process.cwd();
  const candidates = [
    path.join(/*turbopackIgnore: true*/ legacyRoot, "uploads", "tenants", slug),
    path.join(/*turbopackIgnore: true*/ legacyRoot, "public", "uploads", "tenants", slug),
    path.join(/*turbopackIgnore: true*/ process.cwd(), "uploads", "tenants", slug),
    path.join(/*turbopackIgnore: true*/ process.cwd(), "public", "uploads", "tenants", slug),
  ];

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const root = dir.startsWith(appRoot) ? appRoot : legacyRoot;
    await walkFiles(dir, async (filePath) => {
      const stat = await fs.promises.stat(filePath);
      files.push({
        relative_path: path.relative(root, filePath).replace(/\\/g, "/"),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    });
  }
  return { files };
}

async function walkFiles(dir: string, visitor: (filePath: string) => Promise<void>): Promise<void> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(/*turbopackIgnore: true*/ dir, entry.name);
    if (entry.isDirectory()) await walkFiles(fullPath, visitor);
    else if (entry.isFile()) await visitor(fullPath);
  }
}

async function ensureDefaultSmsSettings(): Promise<void> {
  const count = await countRows("SELECT COUNT(*) AS count FROM `saas_sms_pricing_settings`");
  if (count > 0) return;
  await dbExecute(
    `INSERT INTO \`saas_sms_pricing_settings\`(provider_cost_per_segment,target_margin_percent,payment_fee_percent,payment_fee_fixed,suggested_credit_price,currency)
     VALUES(0.0490,25.00,2.00,0.30,0.0700,'EUR')`,
  );
}

async function ensureDefaultSmsPlans(): Promise<void> {
  const count = await countRows("SELECT COUNT(*) AS count FROM `saas_sms_plans`");
  if (count > 0) return;
  const plans = [
    ["Base", 100, 7.00, "Per iniziare con i promemoria SMS.", 10],
    ["Standard", 250, 17.50, "Per attivita con invii regolari.", 20],
    ["Pro", 500, 35.00, "Per volumi mensili piu alti.", 30],
    ["Business", 1000, 70.00, "Per tenant con molti appuntamenti.", 40],
  ] as const;
  for (const plan of plans) {
    await dbExecute(
      "INSERT INTO `saas_sms_plans`(name,credits,price_gross,currency,description,is_active,is_featured,sort_order) VALUES(?,?,?,?,?,?,?,?)",
      [plan[0], plan[1], plan[2], "EUR", plan[3], 1, plan[0] === "Standard" ? 1 : 0, plan[4]],
    );
  }
}

async function nextSmsPlanSortOrder(): Promise<number> {
  const rows = await dbQuery<RowDataPacket[]>("SELECT COALESCE(MAX(sort_order), 0) AS value FROM `saas_sms_plans`");
  return Number(rows[0]?.value ?? 0) + 10;
}

async function recordSmsOrderEvent(orderId: number, type: string, message = "", meta: Record<string, unknown> = {}): Promise<void> {
  if (orderId <= 0) return;
  await dbExecute(
    "INSERT INTO `saas_sms_order_events`(order_id,event_type,message,meta_json) VALUES(?,?,?,?)",
    [orderId, type.trim().slice(0, 60) || "event", message.trim() || null, Object.keys(meta).length ? JSON.stringify(meta) : null],
  ).catch(() => undefined);
}

async function addCreditsToTenantWallet(tenant: Pick<SaasTenantRow, "id" | "slug">, creditsInput: number, orderId: number, note: string): Promise<void> {
  const credits = Math.max(1, creditsInput);
  await ensureTenantSmsCreditTables(tenant);
  const wallet = await tenantSmsCreditWalletRow(tenant);
  const id = Number(wallet.id ?? 0);
  const before = Math.max(0, Number(wallet.balance_credits ?? 0));
  if (id <= 0) throw new Error("Wallet crediti SMS non disponibile.");
  const walletTable = await tenantPhysicalTable(tenant, "sms_credit_wallet");
  const scope = await tenantScopeClause(walletTable, "w", Number(tenant.id));
  // SET senza alias: Postgres rifiuta la colonna qualificata (w.balance_...)
  // nella SET list — "column w of relation ... does not exist".
  await dbExecute(
    `UPDATE ${quoteIdentifier(walletTable.name)} w SET balance_credits=balance_credits+? WHERE w.id=?${scope ? ` AND ${scope}` : ""}`,
    [credits, id],
  );
  const movementsTable = await tenantPhysicalTable(tenant, "sms_credit_movements");
  await insertFiltered(movementsTable.name, {
    tenant_id: movementsTable.mode === "shared" ? Number(tenant.id) : undefined,
    type: "purchase",
    credits,
    balance_before: before,
    balance_after: before + credits,
    reference_type: "saas_sms_order",
    reference_id: orderId,
    note: note.trim() || "Ricarica manuale SaaS",
  });
}

async function tenantSmsCreditWalletRow(tenant: Pick<SaasTenantRow, "id" | "slug">): Promise<RowDataPacket> {
  const table = await tenantPhysicalTable(tenant, "sms_credit_wallet");
  if (!table.exists) throw new Error("Wallet crediti SMS non disponibile.");
  const scope = await tenantScopeClause(table, "w", Number(tenant.id));
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT w.id, w.balance_credits FROM ${quoteIdentifier(table.name)} w ${scope ? `WHERE ${scope}` : ""} ORDER BY w.id ASC LIMIT 1`,
  );
  if (rows[0]) return rows[0];
  await insertFiltered(table.name, { tenant_id: table.mode === "shared" ? Number(tenant.id) : undefined, balance_credits: 0 });
  const created = await dbQuery<RowDataPacket[]>(
    `SELECT w.id, w.balance_credits FROM ${quoteIdentifier(table.name)} w ${scope ? `WHERE ${scope}` : ""} ORDER BY w.id ASC LIMIT 1`,
  );
  return created[0] ?? ({ id: 0, balance_credits: 0 } as RowDataPacket);
}

async function ensureTenantSmsCreditTables(tenant: Pick<SaasTenantRow, "id" | "slug">): Promise<void> {
  const shared = await usesSharedTenantTables();
  const walletTable = shared ? "sms_credit_wallet" : `${tenantPrefix(String(tenant.slug))}sms_credit_wallet`;
  const movementsTable = shared ? "sms_credit_movements" : `${tenantPrefix(String(tenant.slug))}sms_credit_movements`;
  const tenantColumn = shared ? "`tenant_id` INT(11) NULL DEFAULT NULL," : "";
  const tenantIndex = shared ? "KEY `idx_sms_credit_wallet_tenant` (`tenant_id`)," : "";
  if (!await tableExists(walletTable)) await dbExecute(
    `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(walletTable)} (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      ${tenantColumn}
      \`balance_credits\` INT NOT NULL DEFAULT 0,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      ${tenantIndex}
      KEY \`idx_sms_credit_wallet_updated\` (\`updated_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
  if (!await tableExists(movementsTable)) await dbExecute(
    `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(movementsTable)} (
      \`id\` INT AUTO_INCREMENT PRIMARY KEY,
      ${tenantColumn}
      \`type\` VARCHAR(30) NOT NULL,
      \`credits\` INT NOT NULL DEFAULT 0,
      \`balance_before\` INT NOT NULL DEFAULT 0,
      \`balance_after\` INT NOT NULL DEFAULT 0,
      \`reference_type\` VARCHAR(60) DEFAULT NULL,
      \`reference_id\` INT DEFAULT NULL,
      \`note\` VARCHAR(255) DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ${shared ? "KEY `idx_sms_credit_movements_tenant` (`tenant_id`)," : ""}
      KEY \`idx_sms_credit_created\` (\`created_at\`),
      KEY \`idx_sms_credit_reference\` (\`reference_type\`, \`reference_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
  if (shared) {
    await addColumnIfMissing(walletTable, "tenant_id", "`tenant_id` INT(11) NULL DEFAULT NULL AFTER `id`");
    await addColumnIfMissing(movementsTable, "tenant_id", "`tenant_id` INT(11) NULL DEFAULT NULL AFTER `id`");
  }
}

async function collectCommunicationMovements(channel: "sms" | "email", limitPerTenantInput: number, totalLimitInput: number): Promise<CommunicationMovementRow[]> {
  const limitPerTenant = Math.max(1, Math.min(100, limitPerTenantInput));
  const totalLimit = Math.max(1, Math.min(300, totalLimitInput));
  const tenants = await listSaasTenants();
  const rows: CommunicationMovementRow[] = [];
  for (const tenant of tenants) {
    if (tenantStatus(tenant) === "deleted") continue;
    try {
      rows.push(...(channel === "sms" ? await tenantSmsRows(tenant, limitPerTenant) : await tenantEmailRows(tenant, limitPerTenant)));
    } catch (error) {
      rows.push(errorMovementRow(tenant, channel, error instanceof Error ? error.message : "Errore lettura tenant"));
    }
  }
  rows.sort((a, b) => b.sort_at.localeCompare(a.sort_at));
  return rows.slice(0, totalLimit);
}

async function tenantSmsRows(tenant: SaasTenantRow, limit: number): Promise<CommunicationMovementRow[]> {
  const reminders = await tenantPhysicalTable(tenant, "reminders");
  if (!reminders.exists) return [];
  const appointments = await tenantPhysicalTable(tenant, "appointments");
  const clients = await tenantPhysicalTable(tenant, "clients");
  const tenantId = Number(tenant.id);
  const scope = await tenantScopeClause(reminders, "r", tenantId);
  const appointmentJoin = appointments.exists ? `LEFT JOIN ${quoteIdentifier(appointments.name)} a ON a.id=r.appointment_id${await tenantJoinClause(appointments, "a", tenantId)}` : "";
  const clientJoin = clients.exists && appointments.exists ? `LEFT JOIN ${quoteIdentifier(clients.name)} c ON c.id=a.client_id${await tenantJoinClause(clients, "c", tenantId)}` : "";
  const clientSelect = clientJoin ? "c.full_name AS client_name, c.phone AS recipient" : "'' AS client_name, '' AS recipient";
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT r.id, r.appointment_id, r.scheduled_at, r.sent_at, r.status, r.last_error, r.provider, r.provider_message_id, r.provider_state,
            r.delivered_at, r.last_checked_at, r.sms_segments, r.sms_credits_used, r.created_at, ${clientSelect}
       FROM ${quoteIdentifier(reminders.name)} r
       ${appointmentJoin}
       ${clientJoin}
      WHERE r.channel='sms'
        ${scope ? `AND ${scope}` : ""}
        AND COALESCE(r.delivered_at, r.last_checked_at, r.sent_at, r.scheduled_at, r.created_at) >= ?
      ORDER BY COALESCE(r.delivered_at, r.last_checked_at, r.sent_at, r.scheduled_at, r.created_at) DESC, r.id DESC
      LIMIT ${limit}`,
    [historyCutoff()],
  );

  return rows.map((row) => normalizeMovementRow(tenant, {
    channel: "SMS",
    kind: "Promemoria appuntamento",
    source: "reminders",
    source_id: Number(row.id ?? 0),
    status: String(row.status ?? ""),
    recipient: String(row.recipient ?? ""),
    client_name: String(row.client_name ?? ""),
    reference: `Appuntamento #${Number(row.appointment_id ?? 0)}`,
    scheduled_at: dateString(row.scheduled_at) ?? "",
    sent_at: dateString(row.sent_at) ?? "",
    delivered_at: dateString(row.delivered_at) ?? "",
    event_at: firstDate(row, ["delivered_at", "last_checked_at", "sent_at", "scheduled_at", "created_at"]),
    segments: row.sms_segments === null || row.sms_segments === undefined ? null : Number(row.sms_segments),
    credits: row.sms_credits_used === null || row.sms_credits_used === undefined ? null : Number(row.sms_credits_used),
    provider: String(row.provider ?? ""),
    provider_state: String(row.provider_state ?? ""),
    provider_message_id: String(row.provider_message_id ?? ""),
    last_error: String(row.last_error ?? ""),
  }));
}

async function tenantEmailRows(tenant: SaasTenantRow, limit: number): Promise<CommunicationMovementRow[]> {
  const out: CommunicationMovementRow[] = [];
  const reminders = await tenantPhysicalTable(tenant, "reminders");
  const appointments = await tenantPhysicalTable(tenant, "appointments");
  const clients = await tenantPhysicalTable(tenant, "clients");
  const tenantId = Number(tenant.id);
  if (reminders.exists) {
    const scope = await tenantScopeClause(reminders, "r", tenantId);
    const appointmentJoin = appointments.exists ? `LEFT JOIN ${quoteIdentifier(appointments.name)} a ON a.id=r.appointment_id${await tenantJoinClause(appointments, "a", tenantId)}` : "";
    const clientJoin = clients.exists && appointments.exists ? `LEFT JOIN ${quoteIdentifier(clients.name)} c ON c.id=a.client_id${await tenantJoinClause(clients, "c", tenantId)}` : "";
    const clientSelect = clientJoin ? "c.full_name AS client_name, c.email AS recipient" : "'' AS client_name, '' AS recipient";
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT r.id, r.appointment_id, r.scheduled_at, r.sent_at, r.status, r.last_error, r.created_at, ${clientSelect}
         FROM ${quoteIdentifier(reminders.name)} r
         ${appointmentJoin}
         ${clientJoin}
        WHERE r.channel='email'
          ${scope ? `AND ${scope}` : ""}
          AND COALESCE(r.sent_at, r.scheduled_at, r.created_at) >= ?
        ORDER BY COALESCE(r.sent_at, r.scheduled_at, r.created_at) DESC, r.id DESC
        LIMIT ${limit}`,
      [historyCutoff()],
    );
    out.push(...rows.map((row) => normalizeMovementRow(tenant, {
      channel: "Email",
      kind: "Promemoria appuntamento",
      source: "reminders",
      source_id: Number(row.id ?? 0),
      status: String(row.status ?? ""),
      recipient: String(row.recipient ?? ""),
      client_name: String(row.client_name ?? ""),
      reference: `Appuntamento #${Number(row.appointment_id ?? 0)}`,
      scheduled_at: dateString(row.scheduled_at) ?? "",
      sent_at: dateString(row.sent_at) ?? "",
      event_at: firstDate(row, ["sent_at", "scheduled_at", "created_at"]),
      last_error: String(row.last_error ?? ""),
    })));
  }

  const cardReminders = await tenantPhysicalTable(tenant, "card_reminders");
  if (cardReminders.exists) {
    const scope = await tenantScopeClause(cardReminders, "cr", tenantId);
    const clientJoin = clients.exists ? `LEFT JOIN ${quoteIdentifier(clients.name)} c ON c.id=cr.client_id${await tenantJoinClause(clients, "c", tenantId)}` : "";
    const clientSelect = clientJoin ? "c.full_name AS client_name, c.email AS recipient" : "'' AS client_name, '' AS recipient";
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT cr.id, cr.card_id, cr.client_id, cr.reminder_kind, cr.card_expires_at, cr.scheduled_at, cr.sent_at, cr.status, cr.last_error, cr.created_at, ${clientSelect}
         FROM ${quoteIdentifier(cardReminders.name)} cr
         ${clientJoin}
        WHERE COALESCE(cr.sent_at, cr.scheduled_at, cr.created_at) >= ?
          ${scope ? `AND ${scope}` : ""}
        ORDER BY COALESCE(cr.sent_at, cr.scheduled_at, cr.created_at) DESC, cr.id DESC
        LIMIT ${limit}`,
      [historyCutoff()],
    );
    out.push(...rows.map((row) => normalizeMovementRow(tenant, {
      channel: "Email",
      kind: "Scadenza Fidelity",
      source: "card_reminders",
      source_id: Number(row.id ?? 0),
      status: String(row.status ?? ""),
      recipient: String(row.recipient ?? ""),
      client_name: String(row.client_name ?? ""),
      reference: `Tessera #${Number(row.card_id ?? 0)}`,
      scheduled_at: dateString(row.scheduled_at) ?? "",
      sent_at: dateString(row.sent_at) ?? "",
      event_at: firstDate(row, ["sent_at", "scheduled_at", "created_at"]),
      last_error: String(row.last_error ?? ""),
    })));
  }

  const logs = await tenantPhysicalTable(tenant, "communication_logs");
  if (logs.exists) {
    const scope = await tenantScopeClause(logs, "l", tenantId);
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT l.id, l.kind, l.status, l.reference_type, l.reference_id, l.recipient, l.subject, l.last_error, l.sent_at, l.created_at
         FROM ${quoteIdentifier(logs.name)} l
        WHERE l.channel='email'
          ${scope ? `AND ${scope}` : ""}
          AND COALESCE(l.sent_at, l.created_at) >= ?
        ORDER BY COALESCE(l.sent_at, l.created_at) DESC, l.id DESC
        LIMIT ${limit}`,
      [historyCutoff()],
    );
    out.push(...rows.map((row) => {
      const referenceType = String(row.reference_type ?? "").trim();
      const referenceId = Number(row.reference_id ?? 0);
      return normalizeMovementRow(tenant, {
        channel: "Email",
        kind: emailKindLabel(String(row.kind ?? "")),
        source: "communication_logs",
        source_id: Number(row.id ?? 0),
        status: String(row.status ?? ""),
        recipient: String(row.recipient ?? ""),
        client_name: "",
        reference: referenceType && referenceId > 0 ? `${ucFirst(referenceType)} #${referenceId}` : "",
        subject: String(row.subject ?? ""),
        sent_at: dateString(row.sent_at) ?? "",
        event_at: firstDate(row, ["sent_at", "created_at"]),
        last_error: String(row.last_error ?? ""),
      });
    }));
  }

  return out;
}

function normalizeMovementRow(tenant: SaasTenantRow, row: Omit<CommunicationMovementRow, "tenant_id" | "tenant_slug" | "tenant_name" | "sort_at">): CommunicationMovementRow {
  return {
    ...row,
    tenant_id: Number(tenant.id),
    tenant_slug: String(tenant.slug),
    tenant_name: String(tenant.name ?? tenant.slug),
    sort_at: row.event_at || row.sent_at || row.scheduled_at || "",
  };
}

function errorMovementRow(tenant: SaasTenantRow, channel: "sms" | "email", message: string): CommunicationMovementRow {
  return normalizeMovementRow(tenant, {
    channel: channel === "sms" ? "SMS" : "Email",
    kind: "Errore lettura tenant",
    source: "tenant_error",
    source_id: 0,
    status: "failed",
    recipient: "",
    client_name: "",
    reference: "",
    event_at: mysqlNow(),
    last_error: message,
  });
}

async function tenantPhysicalTable(tenant: Pick<SaasTenantRow, "id" | "slug">, table: string): Promise<{ name: string; mode: TenantTableMode; tenantId: number | null; exists: boolean }> {
  const target = await tenantTable(String(tenant.slug), table).catch(() => null);
  const name = target?.name ?? ((await usesSharedTenantTables()) ? table : `${tenantPrefix(String(tenant.slug))}${table}`);
  const mode = (target?.mode ?? ((await usesSharedTenantTables()) ? "shared" : "prefixed")) as TenantTableMode;
  const tenantId = target?.tenantId ?? Number(tenant.id);
  return { name, mode, tenantId, exists: await freshTableExists(name) };
}

async function tenantScopeClause(table: { name: string; mode: TenantTableMode }, alias: string, tenantId: number): Promise<string> {
  if (table.mode !== "shared" || !await freshColumnExists(table.name, "tenant_id")) return "";
  return `${alias}.tenant_id=${Number(tenantId)}`;
}

async function tenantJoinClause(table: { name: string; mode: TenantTableMode }, alias: string, tenantId: number): Promise<string> {
  const scope = await tenantScopeClause(table, alias, tenantId);
  return scope ? ` AND ${scope}` : "";
}

async function insertFiltered(table: string, values: Record<string, unknown>): Promise<number> {
  const filtered = await filterColumns(table, values);
  const entries = Object.entries(filtered).filter(([, value]) => value !== undefined);
  if (!entries.length) return 0;
  const result = await dbExecute(
    `INSERT INTO ${quoteIdentifier(table)} (${entries.map(([key]) => quoteIdentifier(key)).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
    entries.map(([, value]) => value),
  );
  return Number(result.insertId ?? 0);
}

async function filterColumns(table: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?",
    [table],
  ).catch(() => []);
  const columns = new Set(rows.map((row) => String(row.column_name ?? row.COLUMN_NAME)));
  return Object.fromEntries(Object.entries(values).filter(([key, value]) => columns.has(key) && value !== undefined));
}

async function addColumnIfMissing(table: string, column: string, definition: string): Promise<void> {
  if (await freshColumnExists(table, column)) return;
  await dbExecute(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${definition}`).catch(() => undefined);
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

async function countRows(sql: string, params: unknown[] = []): Promise<number> {
  const rows = await dbQuery<RowDataPacket[]>(sql, params).catch(() => []);
  return Number(rows[0]?.count ?? rows[0]?.["COUNT(*)"] ?? 0);
}

function defaultSmsSettings(): SaasSmsPricingSettings {
  return {
    provider_cost_per_segment: 0.049,
    target_margin_percent: 25,
    payment_fee_percent: 2,
    payment_fee_fixed: 0.3,
    suggested_credit_price: 0.07,
    currency: "EUR",
  } as SaasSmsPricingSettings;
}

function openApiSmsConfig() {
  const source = readConfigPhp();
  const block = source.match(/['"]openapi_sms['"]\s*=>\s*\[([\s\S]*?)\]\s*,/)?.[1] ?? "";
  let environment = (phpBlockValue(block, "environment") || process.env.OPENAPI_SMS_ENV || "sandbox").trim().toLowerCase();
  if (environment !== "sandbox" && environment !== "production") environment = "sandbox";
  const baseUrl = (phpBlockValue(block, "base_url") || (environment === "production" ? "https://sms.openapi.com" : "https://test.sms.openapi.com")).replace(/\/+$/, "");
  const token = (phpBlockValue(block, "token") || phpBlockValue(block, "bearer_token") || process.env.OPENAPI_SMS_TOKEN || "").trim();
  return {
    enabled: phpBlockBool(block, "enabled", token !== ""),
    environment,
    base_url: baseUrl,
    token,
    sender: phpBlockValue(block, "sender") || "Prenodo",
    callback_secret: phpBlockValue(block, "callback_secret") || "",
    callback_url: phpBlockValue(block, "callback_url") || "",
    timeout: Math.max(3, Math.min(60, parseInteger(phpBlockRaw(block, "timeout"), 20))),
  };
}

async function smsEndpointReachability(baseUrl: string): Promise<SmsProviderDiagnostics["endpoint"]> {
  const url = baseUrl.trim().replace(/\/+$/, "");
  if (!url) return { checked: true, ok: false, status_code: 0, message: "Endpoint SMS non configurato." };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { method: "HEAD", redirect: "manual", signal: controller.signal });
    return { checked: true, ok: true, status_code: response.status, message: "Endpoint raggiungibile." };
  } catch (error) {
    return { checked: true, ok: false, status_code: 0, message: error instanceof Error ? error.message : "Connessione endpoint SMS fallita." };
  } finally {
    clearTimeout(timeout);
  }
}

function readConfigPhp(): string {
  // Legacy SMS/provider settings used to live in the PHP config.php. The Next
  // app no longer depends on PHP/XAMPP: read it only if an explicit path is
  // configured, otherwise rely on environment variables (returns "").
  const file = process.env.PRENODO_CONFIG_PHP;
  if (!file) return "";
  try {
    return fs.readFileSync(/*turbopackIgnore: true*/ file, "utf8");
  } catch {
    return "";
  }
}

function phpBlockValue(block: string, key: string): string {
  const value = phpBlockRaw(block, key);
  const match = value.match(/^['"]([^'"]*)['"]$/);
  return match?.[1] ?? "";
}

function phpBlockBool(block: string, key: string, fallback: boolean): boolean {
  const value = phpBlockRaw(block, key).toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return fallback;
}

function phpBlockRaw(block: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return block.match(new RegExp(`['"]${escapedKey}['"]\\s*=>\\s*([^,\\n\\]]+)`))?.[1]?.trim() ?? "";
}

function projectRootForBackups(): string {
  // Default backups to the Next project root, not the legacy XAMPP htdocs.
  return process.env.PRENODO_BACKUP_PROJECT_ROOT || process.cwd();
}

function backupRoot(): string {
  return process.env.PRENODO_BACKUP_ROOT || path.join(/*turbopackIgnore: true*/ projectRootForBackups(), "storage", "saas_backups");
}

function relativeToProjectRoot(filePath: string): string {
  const root = projectRootForBackups();
  const relative = path.relative(root, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.replace(/\\/g, "/") : filePath.replace(/\\/g, "/");
}

function timestampForFilename(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function historyCutoff(): string {
  return mysqlDate(new Date(Date.now() - HISTORY_DAYS * 86400 * 1000));
}

function firstDate(row: RowDataPacket, keys: string[]): string {
  for (const key of keys) {
    const value = dateString(row[key]);
    if (value && value !== "0000-00-00 00:00:00") return value;
  }
  return "";
}

function emailKindLabel(kindInput: string): string {
  const kind = kindInput.trim();
  if (kind === "approved") return "Approvazione appuntamento";
  if (kind === "modified") return "Modifica appuntamento";
  if (kind === "rejected") return "Rifiuto appuntamento";
  if (kind === "reminder") return "Promemoria appuntamento";
  if (kind === "fidelity_expiry_reminder") return "Scadenza Fidelity";
  return ucFirst(kind.replace(/_/g, " ") || "Email");
}

function ucFirst(value: string): string {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function parseInteger(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function money2(value: string): number {
  return round(Math.max(0, Number.parseFloat(value.replace(",", ".")) || 0), 2);
}

function money4(value: string): number {
  return round(Math.max(0, Number.parseFloat(value.replace(",", ".")) || 0), 4);
}

function percent(value: string): number {
  return round(Math.min(100, Math.max(0, Number.parseFloat(value.replace(",", ".")) || 0)), 2);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function truthy(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function mysqlNow(): string {
  return mysqlDate(new Date());
}

function mysqlDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function dateString(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return mysqlDate(value);
  return String(value);
}
