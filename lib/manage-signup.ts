import "server-only";

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { RowDataPacket } from "@/lib/tenant-db";
import { allAssignablePermissions, permissionDefinitions } from "@/lib/role-permissions";
import { dbExecute, dbQuery, quoteIdentifier, tableExists } from "@/lib/tenant-db";
import { tenantPrefix } from "@/lib/tenant-runtime";
import { buildModernEmailTemplate, emailButton, emailCodeBox, emailConfigured, sendEmail } from "@/lib/email";

const SIGNUPS_TABLE = "saas_professional_signups";
const CODE_TTL_MINUTES = 15;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_CODE_ATTEMPTS = 5;
const CODE_LOCK_MINUTES = 15;

const RESERVED_SLUGS = new Set(["admin", "assets", "uploads", "app", "database", "cron", "public", "attivita", "saloni", "account", "manage"]);
const TENANT_BOOTSTRAP_TABLES = [
  "automation_settings",
  "booking_users",
  "businesses",
  "business_hours",
  "locations",
  "permissions",
  "pos_settings",
  "role_permissions",
  "staff",
  "staff_locations",
  "user_locations",
  "users",
];

export type SignupAvailability = {
  available: boolean;
  reason: "available" | "empty" | "invalid" | "unavailable";
  slug: string;
  message: string;
  suggestions: string[];
};

export type RegisterSignupInput = {
  businessName: string;
  slug: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone?: string;
  password: string;
  passwordConfirm: string;
  terms: boolean;
  marketingOptIn?: boolean;
  ip?: string;
  userAgent?: string;
};

export type RegisterSignupResult = {
  ok: true;
  signup_id: number;
  email: string;
  slug: string;
  expires_in_minutes: number;
  verification_code?: string;
  message: string;
};

export type VerifySignupResult = {
  ok: true;
  slug: string;
  tenant_id: number;
  admin_user_id: number;
  admin_email: string;
  admin_name: string;
  current_location_id: number;
  redirectTo: string;
};

type SignupRow = RowDataPacket & {
  id: number;
  tenant_id?: number | null;
  business_name: string;
  slug: string;
  owner_name: string;
  owner_email: string;
  owner_phone?: string | null;
  password_hash: string;
  status: string;
  verification_hash?: string | null;
  verification_expires_at?: Date | string | null;
  verification_sent_at?: Date | string | null;
  verification_attempts?: number | null;
  verification_locked_until?: Date | string | null;
};

let signupSchemaEnsured = false;

export async function ensureManageSignupSchema(): Promise<void> {
  if (signupSchemaEnsured) return;

  if (!await tableExists("saas_tenants")) {
  await dbExecute(
    `CREATE TABLE IF NOT EXISTS \`saas_tenants\` (
      \`id\` INT(11) NOT NULL AUTO_INCREMENT,
      \`slug\` VARCHAR(80) NOT NULL,
      \`name\` VARCHAR(190) NOT NULL,
      \`db_prefix\` VARCHAR(90) NOT NULL,
      \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
      \`status\` ENUM('provisioning','active','suspended','failed','deleted') NOT NULL DEFAULT 'active',
      \`admin_email\` VARCHAR(190) NULL DEFAULT NULL,
      \`plan\` VARCHAR(80) NULL DEFAULT NULL,
      \`notes\` TEXT NULL DEFAULT NULL,
      \`provisioning_error\` TEXT NULL DEFAULT NULL,
      \`provisioned_at\` DATETIME NULL DEFAULT NULL,
      \`suspended_at\` DATETIME NULL DEFAULT NULL,
      \`suspended_reason\` TEXT NULL DEFAULT NULL,
      \`deleted_at\` DATETIME NULL DEFAULT NULL,
      \`deleted_reason\` TEXT NULL DEFAULT NULL,
      \`created_by_admin_id\` INT(11) NULL DEFAULT NULL,
      \`updated_by_admin_id\` INT(11) NULL DEFAULT NULL,
      \`health_level\` ENUM('ok','warning','error') NULL DEFAULT NULL,
      \`health_errors\` INT(11) NOT NULL DEFAULT 0,
      \`health_warnings\` INT(11) NOT NULL DEFAULT 0,
      \`health_checked_at\` DATETIME NULL DEFAULT NULL,
      \`health_source\` VARCHAR(30) NULL DEFAULT NULL,
      \`source\` ENUM('admin','self_signup') NOT NULL DEFAULT 'admin',
      \`signup_id\` INT(11) NULL DEFAULT NULL,
      \`owner_email_verified_at\` DATETIME NULL DEFAULT NULL,
      \`booking_public_allowed\` TINYINT(1) NOT NULL DEFAULT 1,
      \`marketplace_public_allowed\` TINYINT(1) NOT NULL DEFAULT 1,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_saas_tenants_slug\` (\`slug\`),
      KEY \`idx_saas_tenants_admin_email\` (\`admin_email\`),
      KEY \`idx_saas_tenants_status\` (\`status\`, \`is_active\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  );
  }

  if (!await tableExists(SIGNUPS_TABLE)) {
  await dbExecute(
    `CREATE TABLE IF NOT EXISTS \`${SIGNUPS_TABLE}\` (
      \`id\` INT(11) NOT NULL AUTO_INCREMENT,
      \`tenant_id\` INT(11) NULL DEFAULT NULL,
      \`business_name\` VARCHAR(190) NOT NULL,
      \`slug\` VARCHAR(80) NOT NULL,
      \`owner_name\` VARCHAR(190) NOT NULL,
      \`owner_email\` VARCHAR(190) NOT NULL,
      \`owner_phone\` VARCHAR(40) NULL DEFAULT NULL,
      \`password_hash\` VARCHAR(255) NOT NULL,
      \`status\` ENUM('pending_verification','verified','provisioning','active','failed','rejected') NOT NULL DEFAULT 'pending_verification',
      \`verification_hash\` CHAR(64) NULL DEFAULT NULL,
      \`verification_expires_at\` DATETIME NULL DEFAULT NULL,
      \`verification_sent_at\` DATETIME NULL DEFAULT NULL,
      \`verification_attempts\` INT(11) NOT NULL DEFAULT 0,
      \`verification_locked_until\` DATETIME NULL DEFAULT NULL,
      \`verified_at\` DATETIME NULL DEFAULT NULL,
      \`terms_accepted_at\` DATETIME NULL DEFAULT NULL,
      \`marketing_opt_in\` TINYINT(1) NOT NULL DEFAULT 0,
      \`request_ip\` VARCHAR(64) NULL DEFAULT NULL,
      \`user_agent\` VARCHAR(255) NULL DEFAULT NULL,
      \`provisioning_error\` TEXT NULL DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_prof_signup_email\` (\`owner_email\`),
      KEY \`idx_prof_signup_slug\` (\`slug\`),
      KEY \`idx_prof_signup_status\` (\`status\`, \`created_at\`),
      KEY \`idx_prof_signup_tenant\` (\`tenant_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  );
  }

  await ensureSaasTenantColumns();
  await ensureOnboardingTable();
  signupSchemaEnsured = true;
}

export function normalizeSignupSlugInput(value: string): string {
  let normalized = value.trim().toLowerCase();
  if (!normalized) return "";

  if (/^https?:\/\//i.test(normalized)) {
    try {
      const parsed = new URL(normalized);
      normalized = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    } catch {
      normalized = "";
    }
  }

  return normalized
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "")
    .slice(0, 62);
}

export function suggestSignupSlug(businessName: string): string {
  return businessName
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 60);
}

export function validateSignupSlug(slugInput: string): string {
  const slug = normalizeSignupSlugInput(slugInput);
  if (!slug) throw new Error("Slug obbligatorio.");
  if (!/^[a-z0-9][a-z0-9_-]{1,60}[a-z0-9]$/.test(slug)) {
    throw new Error("URL non valido. Usa almeno 3 caratteri tra lettere, numeri, trattino o underscore.");
  }
  if (RESERVED_SLUGS.has(slug)) throw new Error("URL riservato. Scegline un altro.");
  return slug;
}

export async function signupSlugAvailability(slugInput: string, businessName = "", limit = 4): Promise<SignupAvailability> {
  await ensureManageSignupSchema();

  const normalized = normalizeSignupSlugInput(slugInput) || suggestSignupSlug(businessName);
  const cappedLimit = Math.max(1, Math.min(8, limit));

  if (!normalized) {
    return {
      available: false,
      reason: "empty",
      slug: "",
      message: "Inserisci un URL attivita.",
      suggestions: [],
    };
  }

  let slug = normalized;
  try {
    slug = validateSignupSlug(normalized);
  } catch {
    return {
      available: false,
      reason: "invalid",
      slug: normalized,
      message: "URL non valido. Usa almeno 3 caratteri tra lettere, numeri, trattino o underscore.",
      suggestions: usefulSuggestionBase(normalized, businessName) ? await availableSlugSuggestions(normalized, businessName, cappedLimit) : [],
    };
  }

  const exists = await tenantExists(slug) || await pendingSlugExists(slug);
  return {
    available: !exists,
    reason: exists ? "unavailable" : "available",
    slug,
    message: exists ? "URL non disponibile. Prova uno di questi." : "URL disponibile.",
    suggestions: exists ? await availableSlugSuggestions(slug, businessName, cappedLimit) : [],
  };
}

export async function registerManageSignup(input: RegisterSignupInput): Promise<RegisterSignupResult> {
  await ensureManageSignupSchema();

  const businessName = input.businessName.trim();
  const slug = validateSignupSlug(input.slug || suggestSignupSlug(input.businessName));
  const ownerName = input.ownerName.trim();
  const ownerEmail = normalizeEmail(input.ownerEmail);
  const ownerPhone = input.ownerPhone?.trim() ?? "";
  const password = input.password;
  const passwordConfirm = input.passwordConfirm;

  if (!businessName) throw new Error("Inserisci il nome attivita.");
  if (!ownerName) throw new Error("Inserisci nome e cognome.");
  if (!validEmail(ownerEmail)) throw new Error("Email non valida.");
  if (password.length < 8) throw new Error("La password deve avere almeno 8 caratteri.");
  if (password !== passwordConfirm) throw new Error("Le password non coincidono.");
  if (!input.terms) throw new Error("Accetta termini e privacy per continuare.");
  if (await tenantExists(slug)) throw new Error("URL attivita gia in uso. Scegline un altro.");
  if (await pendingSlugExists(slug)) throw new Error("Esiste gia una richiesta in corso per questo URL attivita.");
  if (await adminEmailExists(ownerEmail)) throw new Error("Questa email e gia collegata a un gestionale. Usa il login.");

  const verificationCode = generateVerificationCode();
  const passwordHash = await bcrypt.hash(password, 10);
  const result = await dbExecute(
    `INSERT INTO \`${SIGNUPS_TABLE}\`
      (business_name,slug,owner_name,owner_email,owner_phone,password_hash,status,verification_hash,verification_expires_at,verification_sent_at,verification_attempts,verification_locked_until,terms_accepted_at,marketing_opt_in,request_ip,user_agent)
     VALUES(?,?,?,?,?,?,'pending_verification',?,NOW() + (? * interval '1 minute'),NOW(),0,NULL,NOW(),?,?,?)`,
    [
      businessName,
      slug,
      ownerName,
      ownerEmail,
      ownerPhone || null,
      passwordHash,
      hashVerificationCode(verificationCode),
      CODE_TTL_MINUTES,
      input.marketingOptIn ? 1 : 0,
      truncate(input.ip ?? "", 64) || null,
      truncate(input.userAgent ?? "", 255) || null,
    ],
  );

  // Send the verification code AFTER persisting its hash so the code is valid even on a
  // transient send error. Platform-branded, best-effort; never fails the registration.
  await sendSignupVerificationEmail(ownerEmail, ownerName, businessName, verificationCode);

  const localCode = exposeSignupCodes() ? verificationCode : undefined;
  return {
    ok: true,
    signup_id: result.insertId,
    email: ownerEmail,
    slug,
    expires_in_minutes: CODE_TTL_MINUTES,
    verification_code: localCode,
    message: localCode
      ? `Codice verifica locale: ${localCode}. In produzione verra inviato via email.`
      : "Codice di verifica inviato via email.",
  };
}

export async function resendManageSignupCode(signupId: number, email: string): Promise<RegisterSignupResult> {
  await ensureManageSignupSchema();

  const normalizedEmail = normalizeEmail(email);
  if (!validEmail(normalizedEmail)) throw new Error("Email non valida.");

  const signup = await pendingSignup(signupId, normalizedEmail);
  if (!signup) throw new Error("Registrazione non trovata o gia verificata.");

  const sentAt = dateValue(signup.verification_sent_at);
  if (sentAt && Date.now() - sentAt.getTime() < RESEND_COOLDOWN_SECONDS * 1000) {
    throw new Error("Attendi qualche secondo prima di richiedere un nuovo codice.");
  }

  const verificationCode = generateVerificationCode();
  await dbExecute(
    `UPDATE \`${SIGNUPS_TABLE}\`
        SET verification_hash=?,
            verification_expires_at=NOW() + (? * interval '1 minute'),
            verification_sent_at=NOW(),
            verification_attempts=0,
            verification_locked_until=NULL,
            provisioning_error=NULL
      WHERE id=?`,
    [hashVerificationCode(verificationCode), CODE_TTL_MINUTES, Number(signup.id)],
  );

  // Resend the new code AFTER persisting its hash; platform-branded, best-effort.
  await sendSignupVerificationEmail(String(signup.owner_email), String(signup.owner_name), String(signup.business_name), verificationCode);

  const localCode = exposeSignupCodes() ? verificationCode : undefined;
  return {
    ok: true,
    signup_id: Number(signup.id),
    email: String(signup.owner_email),
    slug: String(signup.slug),
    expires_in_minutes: CODE_TTL_MINUTES,
    verification_code: localCode,
    message: localCode
      ? `Nuovo codice verifica locale: ${localCode}.`
      : "Nuovo codice di verifica inviato via email.",
  };
}

export async function verifyManageSignupAndProvision(signupId: number, email: string, code: string): Promise<VerifySignupResult> {
  await ensureManageSignupSchema();

  const normalizedEmail = normalizeEmail(email);
  const normalizedCode = code.replace(/\s+/g, "").trim();
  if (!validEmail(normalizedEmail) || !/^\d{6}$/.test(normalizedCode)) {
    throw new Error("Codice di verifica non valido.");
  }

  const signup = await pendingSignup(signupId, normalizedEmail);
  if (!signup) throw new Error("Registrazione non trovata o gia verificata.");

  const lockedUntil = dateValue(signup.verification_locked_until);
  if (lockedUntil && lockedUntil.getTime() > Date.now()) {
    throw new Error("Troppi tentativi non corretti. Richiedi un nuovo codice tra qualche minuto.");
  }

  const expiresAt = dateValue(signup.verification_expires_at);
  if (!expiresAt || expiresAt.getTime() <= Date.now()) {
    throw new Error("Codice scaduto. Richiedi un nuovo codice.");
  }

  const expectedHash = String(signup.verification_hash ?? "");
  if (!expectedHash || !timingSafeEqual(expectedHash, hashVerificationCode(normalizedCode))) {
    const attempts = Number(signup.verification_attempts ?? 0) + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      await dbExecute(
        `UPDATE \`${SIGNUPS_TABLE}\`
            SET verification_attempts=?,
                verification_locked_until=NOW() + (? * interval '1 minute')
          WHERE id=?`,
        [attempts, CODE_LOCK_MINUTES, Number(signup.id)],
      );
      throw new Error("Codice non corretto. Hai superato i tentativi disponibili: richiedi un nuovo codice tra qualche minuto.");
    }

    await dbExecute(`UPDATE \`${SIGNUPS_TABLE}\` SET verification_attempts=? WHERE id=?`, [attempts, Number(signup.id)]);
    throw new Error("Codice non corretto.");
  }

  const verifiedAt = mysqlNow();
  await dbExecute(
    `UPDATE \`${SIGNUPS_TABLE}\`
        SET status='provisioning',
            verified_at=?,
            verification_hash=NULL,
            verification_expires_at=NULL,
            verification_attempts=0,
            verification_locked_until=NULL,
            provisioning_error=NULL
      WHERE id=?`,
    [verifiedAt, Number(signup.id)],
  );

  try {
    const provisioned = await provisionTenantFromSignup(signup, verifiedAt);
    await dbExecute(
      `UPDATE \`${SIGNUPS_TABLE}\` SET status='active', tenant_id=?, provisioning_error=NULL WHERE id=?`,
      [provisioned.tenant_id, Number(signup.id)],
    );
    return provisioned;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provisioning non riuscito.";
    await dbExecute(
      `UPDATE \`${SIGNUPS_TABLE}\` SET status='failed', provisioning_error=? WHERE id=?`,
      [message, Number(signup.id)],
    );
    throw error;
  }
}

export function signupSessionPayload(result: VerifySignupResult) {
  return {
    tenantSlug: result.slug,
    user: {
      id: result.admin_user_id,
      email: result.admin_email,
      name: result.admin_name,
      role: "admin",
      perms: allAssignablePermissions(),
      needsEmailVerification: false,
      currentLocationId: result.current_location_id,
      needsLocationSelection: false,
      locationIds: [],
    },
    issuedAt: Date.now(),
  };
}

async function provisionTenantFromSignup(signup: SignupRow, verifiedAt: string): Promise<VerifySignupResult> {
  const slug = String(signup.slug);
  const businessName = String(signup.business_name || slug);
  const ownerName = String(signup.owner_name || "Admin");
  const ownerEmail = normalizeEmail(String(signup.owner_email));
  const passwordHash = String(signup.password_hash);
  const signupId = Number(signup.id);

  if (await tenantExists(slug)) throw new Error("Tenant gia esistente.");
  if (!await usesSharedTenantSchema()) {
    throw new Error("Creazione tenant interrotta: lo schema deve usare tabelle condivise con tenant_id.");
  }

  const tenantId = await insertKnown("saas_tenants", {
    slug,
    name: businessName,
    db_prefix: tenantPrefix(slug),
    is_active: 0,
    status: "provisioning",
    admin_email: ownerEmail,
    source: "self_signup",
    signup_id: signupId,
    owner_email_verified_at: verifiedAt,
    booking_public_allowed: 1,
    marketplace_public_allowed: 1,
  });

  try {
    await seedTenantPermissions(tenantId);
    const adminUserId = await insertKnown("users", {
      tenant_id: tenantId,
      name: ownerName,
      full_name: ownerName,
      email: ownerEmail,
      password_hash: passwordHash,
      role: "admin",
      email_verified_at: verifiedAt,
    });

    const adminStaffId = await insertKnown("staff", {
      tenant_id: tenantId,
      full_name: ownerName,
      phone: null,
      email: ownerEmail,
      is_active: 1,
      calendar_color: null,
    });

    await insertKnown("businesses", {
      tenant_id: tenantId,
      name: businessName,
      email: ownerEmail,
      phone: signup.owner_phone ?? null,
      booking_choose_staff_enabled: 0,
      booking_products_enabled: 0,
    });

    const locationId = await insertKnown("locations", {
      tenant_id: tenantId,
      name: "Sede principale",
      address: null,
      is_active: 1,
      phone: signup.owner_phone ?? null,
      email: ownerEmail,
      booking_enabled: 1,
      marketplace_enabled: 1,
      sort_order: 0,
    });

    await seedDefaultHours(tenantId, locationId);
    await seedAutomationSettings(tenantId);
    await seedPosSettings(tenantId);
    await assignTenantLocation("user_locations", tenantId, "user_id", adminUserId, locationId);
    await assignTenantLocation("staff_locations", tenantId, "staff_id", adminStaffId, locationId);
    await initializeOnboarding(tenantId);

    await updateKnown("saas_tenants", { id: tenantId }, {
      is_active: 1,
      status: "active",
      provisioning_error: null,
      provisioned_at: verifiedAt,
      owner_email_verified_at: verifiedAt,
      admin_email: ownerEmail,
      source: "self_signup",
      signup_id: signupId,
    });

    return {
      ok: true,
      slug,
      tenant_id: tenantId,
      admin_user_id: adminUserId,
      admin_email: ownerEmail,
      admin_name: ownerName,
      current_location_id: locationId,
      redirectTo: `/${encodeURIComponent(slug)}/onboarding`,
    };
  } catch (error) {
    await cleanupFailedTenant(tenantId, slug, error instanceof Error ? error.message : "Provisioning fallito.");
    throw error;
  }
}

async function seedTenantPermissions(tenantId: number): Promise<void> {
  for (const definition of permissionDefinitions) {
    await insertKnown("permissions", {
      tenant_id: tenantId,
      perm: definition.perm,
      label: definition.label,
      group_name: definition.groupName,
      sort_order: definition.sortOrder,
    }, { ignore: true });
  }
}

async function seedDefaultHours(tenantId: number, locationId: number): Promise<void> {
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
    }, { ignore: true });
  }
}

async function seedAutomationSettings(tenantId: number): Promise<void> {
  if (!await tableExists("automation_settings")) return;
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
    sms_reminder_body: null,
    fidelity_expiry_reminder_enabled: 0,
    installment_alert_days: 7,
    client_birthday_alert_days: 7,
  }, { ignore: true });
}

async function seedPosSettings(tenantId: number): Promise<void> {
  if (!await tableExists("pos_settings")) return;
  await insertKnown("pos_settings", {
    tenant_id: tenantId,
    id: 1,
    preorders_expiry_enabled: 0,
    preorders_expiry_value: 0,
    preorders_expiry_unit: "days",
    prepaids_expiry_enabled: 0,
    prepaids_expiry_value: 0,
    prepaids_expiry_unit: "days",
  }, { ignore: true });
}

async function assignTenantLocation(table: string, tenantId: number, ownerColumn: string, ownerId: number, locationId: number): Promise<void> {
  if (ownerId <= 0 || locationId <= 0 || !await tableExists(table)) return;
  await insertKnown(table, {
    tenant_id: tenantId,
    [ownerColumn]: ownerId,
    location_id: locationId,
  }, { ignore: true });
}

async function initializeOnboarding(tenantId: number): Promise<void> {
  await ensureOnboardingTable();
  await insertKnown("tenant_onboarding_progress", {
    tenant_id: tenantId,
    status: "not_started",
    current_step: "business",
    completed_steps_json: "[]",
    skipped_steps_json: "[]",
    meta_json: null,
    started_at: null,
    completed_at: null,
    dismissed_at: null,
  }, { ignore: true });
}

async function cleanupFailedTenant(tenantId: number, slug: string, message: string): Promise<void> {
  try {
    for (const table of TENANT_BOOTSTRAP_TABLES) {
      if (!await tableExists(table) || !await freshColumnExists(table, "tenant_id")) continue;
      await dbExecute(`DELETE FROM ${quoteIdentifier(table)} WHERE tenant_id=?`, [tenantId]);
    }
    if (await tableExists("tenant_onboarding_progress")) {
      await dbExecute("DELETE FROM `tenant_onboarding_progress` WHERE tenant_id=?", [tenantId]);
    }
    await updateKnown("saas_tenants", { id: tenantId }, {
      is_active: 0,
      status: "failed",
      provisioning_error: message,
    });
    await dbExecute("DELETE FROM `saas_tenants` WHERE id=? AND slug=?", [tenantId, slug]);
  } finally {
    // FOREIGN_KEY_CHECKS is MySQL-only; Postgres has no per-session equivalent here.
  }
}

async function insertKnown(table: string, values: Record<string, unknown>, options: { ignore?: boolean } = {}): Promise<number> {
  if (!await tableExists(table)) throw new Error(`Tabella ${table} non trovata.`);

  const entries = [];
  for (const [column, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (await freshColumnExists(table, column)) entries.push([column, value] as const);
  }
  if (!entries.length) throw new Error(`Nessun campo compatibile per ${table}.`);

  const columns = entries.map(([column]) => quoteIdentifier(column)).join(",");
  const placeholders = entries.map(() => "?").join(",");
  const params = entries.map(([, value]) => value);
  const result = await dbExecute(
    `INSERT INTO ${quoteIdentifier(table)} (${columns}) VALUES (${placeholders})${options.ignore ? " ON CONFLICT DO NOTHING" : ""}`,
    params,
  );
  return Number(result.insertId ?? 0);
}

async function updateKnown(table: string, where: Record<string, unknown>, values: Record<string, unknown>): Promise<number> {
  const entries = [];
  for (const [column, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (await freshColumnExists(table, column)) entries.push([column, value] as const);
  }
  if (!entries.length) return 0;

  const whereEntries = Object.entries(where);
  const assignments = entries.map(([column]) => `${quoteIdentifier(column)}=?`).join(",");
  const whereSql = whereEntries.map(([column]) => `${quoteIdentifier(column)}=?`).join(" AND ");
  const params = [...entries.map(([, value]) => value), ...whereEntries.map(([, value]) => value)];
  const result = await dbExecute(`UPDATE ${quoteIdentifier(table)} SET ${assignments} WHERE ${whereSql}`, params);
  return result.affectedRows;
}

async function usesSharedTenantSchema(): Promise<boolean> {
  return await freshColumnExists("users", "tenant_id")
    && await freshColumnExists("permissions", "tenant_id")
    && await freshColumnExists("role_permissions", "tenant_id");
}

async function tenantExists(slug: string): Promise<boolean> {
  if (!slug) return false;
  if (await tableExists("saas_tenants")) {
    const rows = await dbQuery<RowDataPacket[]>("SELECT id FROM `saas_tenants` WHERE slug=? LIMIT 1", [slug]);
    if (rows.length > 0) return true;
  }
  if (await tableExists(`${tenantPrefix(slug)}users`)) return true;
  return false;
}

async function pendingSlugExists(slug: string): Promise<boolean> {
  if (!slug || !await tableExists(SIGNUPS_TABLE)) return false;
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT 1
       FROM \`${SIGNUPS_TABLE}\` s
       LEFT JOIN \`saas_tenants\` t
         ON t.slug=s.slug
         OR (s.tenant_id IS NOT NULL AND t.id=s.tenant_id)
      WHERE s.slug=?
        AND (
          (s.status='pending_verification' AND s.verification_expires_at > NOW())
          OR (s.status IN ('verified','provisioning') AND s.updated_at > NOW() - (30 * interval '1 minute'))
          OR (s.status='active' AND t.id IS NOT NULL)
        )
      LIMIT 1`,
    [slug],
  );
  return rows.length > 0;
}

async function adminEmailExists(email: string): Promise<boolean> {
  if (!email || !await tableExists("saas_tenants")) return false;
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT 1 FROM `saas_tenants` WHERE LOWER(admin_email)=? AND COALESCE(status,'active') <> 'deleted' LIMIT 1",
    [email],
  );
  if (rows.length > 0) return true;

  if (await tableExists("users") && await freshColumnExists("users", "tenant_id")) {
    // cross-tenant: verifica GLOBALE di piattaforma — l'email admin dev'essere unica fra tutti i tenant.
    const userRows = await dbQuery<RowDataPacket[]>(
      "SELECT 1 FROM `users` WHERE LOWER(email)=? AND role='admin' LIMIT 1",
      [email],
    );
    return userRows.length > 0;
  }
  return false;
}

async function pendingSignup(signupId: number, email: string): Promise<SignupRow | null> {
  if (signupId > 0) {
    const rows = await dbQuery<SignupRow[]>(
      `SELECT * FROM \`${SIGNUPS_TABLE}\` WHERE id=? AND owner_email=? AND status='pending_verification' LIMIT 1`,
      [signupId, email],
    );
    return rows[0] ?? null;
  }

  const rows = await dbQuery<SignupRow[]>(
    `SELECT * FROM \`${SIGNUPS_TABLE}\` WHERE owner_email=? AND status='pending_verification' ORDER BY id DESC LIMIT 1`,
    [email],
  );
  return rows[0] ?? null;
}

async function availableSlugSuggestions(slug: string, businessName: string, limit: number): Promise<string[]> {
  const suggestions: string[] = [];
  const seen = new Set([slug]);
  for (const candidateBase of slugSuggestionCandidates(slug, businessName)) {
    const candidate = normalizeSuggestionSlug(candidateBase);
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const validated = validateSignupSlug(candidate);
      if (!await tenantExists(validated) && !await pendingSlugExists(validated)) suggestions.push(validated);
    } catch {
      // Skip invalid suggestion.
    }
    if (suggestions.length >= limit) return suggestions;
  }

  const base = (normalizeSuggestionSlug(slug) || normalizeSuggestionSlug(suggestSignupSlug(businessName))).slice(0, 58).replace(/[-_]+$/g, "");
  for (let i = 2; i <= 99 && suggestions.length < limit; i += 1) {
    const candidate = `${base}${i}`;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      const validated = validateSignupSlug(candidate);
      if (!await tenantExists(validated) && !await pendingSlugExists(validated)) suggestions.push(validated);
    } catch {
      // Skip invalid suggestion.
    }
  }
  return suggestions;
}

function slugSuggestionCandidates(slug: string, businessName: string): string[] {
  const words = slugWords(businessName);
  const slugBasedWords = words.length > 0 ? words : slugWords(slug.replace(/[-_]/g, " "));
  const compact = normalizeSuggestionSlug(slug);
  const candidates = [compact];

  if (slugBasedWords.length > 0) {
    const all = slugBasedWords.join("");
    const dashed = slugBasedWords.join("-");
    candidates.push(all, dashed);

    if (slugBasedWords.length >= 2) {
      const lastTwo = slugBasedWords.slice(-2);
      const withoutFirst = slugBasedWords.slice(1);
      const firstAndLastTwo = [slugBasedWords[0], ...lastTwo];
      candidates.push(
        lastTwo.join(""),
        lastTwo.join("-"),
        withoutFirst.join(""),
        withoutFirst.join("-"),
        firstAndLastTwo.join(""),
        firstAndLastTwo.join("-"),
      );
    }

    if (slugBasedWords.length >= 3) candidates.push(slugBasedWords.map((word) => word[0]).join(""));
  }

  candidates.push(`${compact}-2`, `${compact}-3`);
  return Array.from(new Set(candidates.filter(Boolean)));
}

function usefulSuggestionBase(slug: string, businessName: string): boolean {
  const slugBase = slug.replace(/[^a-z0-9]+/g, "");
  return slugBase.length >= 3 || suggestSignupSlug(businessName).length >= 3;
}

function slugWords(value: string): string[] {
  const matches = value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .match(/[a-z0-9]+/g);
  return matches ?? [];
}

function normalizeSuggestionSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "")
    .replace(/[-_]{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 62);
}

async function ensureSaasTenantColumns(): Promise<void> {
  const columns: Array<[string, string]> = [
    ["status", "`status` ENUM('provisioning','active','suspended','failed','deleted') NOT NULL DEFAULT 'active' AFTER `is_active`"],
    ["admin_email", "`admin_email` VARCHAR(190) NULL DEFAULT NULL AFTER `status`"],
    ["plan", "`plan` VARCHAR(80) NULL DEFAULT NULL AFTER `admin_email`"],
    ["notes", "`notes` TEXT NULL DEFAULT NULL AFTER `plan`"],
    ["provisioning_error", "`provisioning_error` TEXT NULL DEFAULT NULL AFTER `notes`"],
    ["provisioned_at", "`provisioned_at` DATETIME NULL DEFAULT NULL AFTER `provisioning_error`"],
    ["source", "`source` ENUM('admin','self_signup') NOT NULL DEFAULT 'admin'"],
    ["signup_id", "`signup_id` INT(11) NULL DEFAULT NULL"],
    ["owner_email_verified_at", "`owner_email_verified_at` DATETIME NULL DEFAULT NULL"],
    ["booking_public_allowed", "`booking_public_allowed` TINYINT(1) NOT NULL DEFAULT 1"],
    ["marketplace_public_allowed", "`marketplace_public_allowed` TINYINT(1) NOT NULL DEFAULT 1"],
  ];

  for (const [column, definition] of columns) {
    if (!await freshColumnExists("saas_tenants", column)) {
      await dbExecute(`ALTER TABLE \`saas_tenants\` ADD COLUMN ${definition}`).catch(() => undefined);
    }
  }
}

async function ensureOnboardingTable(): Promise<void> {
  if (await tableExists("tenant_onboarding_progress")) return;
  await dbExecute(
    `CREATE TABLE IF NOT EXISTS \`tenant_onboarding_progress\` (
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

async function freshColumnExists(table: string, column: string): Promise<boolean> {
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1",
    [table, column],
  );
  return rows.length > 0;
}

function generateVerificationCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

function hashVerificationCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function timingSafeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && crypto.timingSafeEqual(aBuffer, bBuffer);
}

function exposeSignupCodes(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.PRENODO_EXPOSE_SIGNUP_CODE === "1";
}

// Platform brand for signup emails. At signup time no tenant/businesses row exists
// yet (it is created during provisioning), so — unlike the per-tenant reset email —
// these are PLATFORM emails sent from the default SES sender, branded with
// PRENODO_PUBLIC_BRAND (default "Prenodo"), mirroring the public-account model.
function signupBrandName(): string {
  return String(process.env.PRENODO_PUBLIC_BRAND ?? "").trim() || "Prenodo";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Builds the "Inserisci codice" button link to /manage/verify?email=... (the Next
// equivalent of the legacy manageUrl('/manage/verify', ...)). Needs an absolute base
// (PRENODO_PUBLIC_BASE_URL); when unset we omit the button and rely on the code text.
function signupVerifyLink(email: string): string {
  const base = String(process.env.PRENODO_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base) return "";
  return `${base}/manage/verify?email=${encodeURIComponent(email)}`;
}

// Port of SaasProfessionalSignup::sendVerificationCodeEmail(): greeting, the
// "use this code to verify and create the gestionale for <business>" line, the
// large 6-digit code, an optional "Inserisci codice" button and the expiry note.
function buildSignupVerificationBody(name: string, businessName: string, code: string, verifyUrl: string): string {
  let body = `<p>Ciao ${escapeHtml(name)},</p>`;
  body += `<p>usa questo codice per verificare la tua email e creare il gestionale di <strong>${escapeHtml(businessName)}</strong>.</p>`;
  body += `<p style="margin:18px 0">${emailCodeBox(code)}</p>`;
  if (verifyUrl) {
    body += `<p>${emailButton(verifyUrl, "Inserisci codice")}</p>`;
  }
  body += `<p>Il codice scade tra ${CODE_TTL_MINUTES} minuti. Se non hai richiesto tu questa registrazione, ignora questa email.</p>`;
  return body;
}

// Sends the signup email-verification code via SES, branded as the platform. Gated on
// emailConfigured(): a no-op when SES is unconfigured so local dev keeps working (the
// caller still stored the code hash and may expose the code via exposeSignupCodes()).
// Send errors are logged and swallowed — issuance must not fail just because delivery
// had a transient problem; the user can resend the code. (NOTE: this is more lenient
// than the legacy PHP, which marked the signup 'failed' on send failure; we keep the
// codebase's best-effort convention so a transient SES error doesn't strand the signup.)
async function sendSignupVerificationEmail(email: string, name: string, businessName: string, code: string): Promise<void> {
  if (!emailConfigured()) return;
  const to = email.trim();
  if (!to) return;
  try {
    const brand = signupBrandName();
    const subject = "Conferma email";
    const body = buildSignupVerificationBody(name, businessName, code, signupVerifyLink(to));
    const { html, text } = buildModernEmailTemplate(subject, body, { business_name: brand });
    const res = await sendEmail({ to, subject, html, text });
    if (!res.ok) {
      console.error(`[manage-signup] verification email send failed for ${to}: ${res.error}`);
    }
  } catch (error) {
    console.error("[manage-signup] verification email send error:", error);
  }
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function dateValue(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function mysqlNow(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
