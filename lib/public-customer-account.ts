import "server-only";

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import type { RowDataPacket } from "@/lib/tenant-db";
import {
  columnExists,
  dbExecute,
  dbQuery,
  quoteIdentifier,
  tableExists,
  tenantSelect,
  tenantTable,
  tenantUpdate,
} from "@/lib/tenant-db";
import { buildModernEmailTemplate, emailButton, emailCodeBox, emailConfigured, maskEmail, sendEmail } from "@/lib/email";

// public_customer_accounts is a GLOBAL marketplace account (unique by email, not
// tenant-scoped). These emails therefore come from the PLATFORM, not a tenant
// business: we use the default SES sender (no per-tenant `businesses` lookup) and
// brand them with PRENODO_PUBLIC_BRAND (default "Prenodo"). Subjects/bodies are
// faithful ports of the legacy global-account mailers in app/lib/Marketplace.php
// (sendVerificationEmail / sendPasswordResetEmail / sendEmailChangeVerificationEmail).
function publicBrandName(): string {
  const brand = String(process.env.PRENODO_PUBLIC_BRAND ?? "").trim();
  return brand || "Prenodo";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Sends an email through the default SES sender, branded as the public platform.
// Gated on emailConfigured(): when SES is not configured this is a no-op so local
// dev keeps working (the caller still stored the hash and returns a devCode).
// Errors are logged and swallowed — these are best-effort side-effects on flows
// that must not fail just because mail delivery had a transient problem; the user
// can always re-request the code/link.
async function sendPublicAccountEmail(to: string, subject: string, bodyHtml: string): Promise<void> {
  if (!emailConfigured()) return;
  const recipient = normalizeEmail(to);
  if (!recipient) return;
  try {
    const brand = publicBrandName();
    const { html, text } = buildModernEmailTemplate(subject, bodyHtml, { business_name: brand });
    const res = await sendEmail({ to: recipient, subject, html, text });
    if (!res.ok) {
      console.error(`[public-customer-account] email send failed for ${maskEmail(recipient)}: ${res.error}`);
    }
  } catch (error) {
    console.error("[public-customer-account] email send error:", error);
  }
}

// Port of Marketplace::sendVerificationEmail() — account email verification code.
function buildVerificationEmailBody(code: string): string {
  return (
    '<h3 style="margin:0 0 12px 0">Verifica il tuo indirizzo email</h3>'
    + `<p style="margin:0 0 10px 0">Inserisci questo codice per completare il tuo account cliente ${escapeHtml(publicBrandName())}:</p>`
    + emailCodeBox(code)
    + '<p style="margin:12px 0 0 0">Il codice scade tra 15 minuti.</p>'
  );
}

// Port of Marketplace::sendEmailChangeVerificationEmail() — new-email confirmation code.
function buildEmailChangeVerificationBody(code: string): string {
  return (
    '<h3 style="margin:0 0 12px 0">Conferma la nuova email</h3>'
    + `<p style="margin:0 0 10px 0">Inserisci questo codice per confermare il nuovo indirizzo email del tuo account cliente ${escapeHtml(publicBrandName())}:</p>`
    + emailCodeBox(code)
    + '<p style="margin:12px 0 0 0">Il codice scade tra 15 minuti.</p>'
  );
}

// Port of Marketplace::sendPasswordResetEmail() — reset link (button) email.
function buildPasswordResetEmailBody(url: string): string {
  return (
    '<h3 style="margin:0 0 12px 0">Reimposta la password</h3>'
    + `<p style="margin:0 0 14px 0">Abbiamo ricevuto una richiesta di reset password per il tuo account cliente ${escapeHtml(publicBrandName())}.</p>`
    + `<p style="margin:0 0 14px 0">${emailButton(url, "Reimposta password")}</p>`
    + '<p style="margin:0;color:#64748b">Il link scade tra 30 minuti. Se non hai richiesto tu il reset, puoi ignorare questa email.</p>'
  );
}

// Builds the public reset link the emailed button points at. The reset page at
// /account/reset reads BOTH ?token= and ?email= (and resetPublicCustomerPassword
// looks the account up by email), so we carry the email alongside the raw token —
// matching the legacy Marketplace::requestGlobalPasswordReset() which appended both.
function buildPublicResetLink(rawToken: string, email: string): string {
  const base = String(process.env.PRENODO_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  const query = `token=${encodeURIComponent(rawToken)}&email=${encodeURIComponent(email)}`;
  return `${base}/account/reset?${query}`;
}

export type PublicCustomer = {
  id: number;
  email: string;
  fullName: string;
  firstName: string;
  lastName: string;
  phone: string;
  pendingEmail: string;
  emailVerifiedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastLoginAt: string | null;
};

export type PublicCustomerFavorite = {
  id: number;
  key: string;
  tenantSlug: string;
  locationId: number;
  locationSlug: string;
  title: string;
  subtitle: string;
  locationName: string;
  city: string;
  province: string;
  address: string;
  phone: string;
  email: string;
  bookingUrl: string;
  profileUrl: string;
  favoritedAt: string | null;
  bookingEnabled: boolean;
};

export type PublicCustomerActivity = {
  tenantSlug: string;
  tenantName: string;
  title: string;
  subtitle: string;
  city: string;
  province: string;
  address: string;
  phone: string;
  email: string;
  bookingUrl: string;
  linkedAt: string | null;
  lastSeenAt: string | null;
  clientId: number;
  // Sede di riferimento del cliente collegato (clients.location_id) — legacy
  // customer_update_reference_location.
  referenceLocationId: number;
  locations: Array<{
    locationId: number;
    locationSlug: string;
    locationName: string;
    city: string;
    address: string;
    bookingUrl: string;
  }>;
};

type PublicCustomerRow = RowDataPacket & {
  id: number;
  email: string;
  pending_email?: string | null;
  password_hash?: string | null;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  email_verified_at?: string | Date | null;
  email_verification_hash?: string | null;
  email_verification_expires_at?: string | Date | null;
  password_reset_hash?: string | null;
  password_reset_expires_at?: string | Date | null;
  created_at?: string | Date | null;
  updated_at?: string | Date | null;
  last_login_at?: string | Date | null;
};

type TenantRow = RowDataPacket & {
  id: number;
  slug: string;
  name?: string | null;
  booking_public_allowed?: number | null;
};

type ProfileSummary = {
  tenantId: number;
  tenantSlug: string;
  tenantName: string;
  title: string;
  subtitle: string;
  city: string;
  province: string;
  address: string;
  phone: string;
  email: string;
  bookingUrl: string;
  bookingAllowed: boolean;
};

type LocationSummary = {
  locationId: number;
  locationSlug: string;
  locationName: string;
  city: string;
  province: string;
  address: string;
  phone: string;
  email: string;
  bookingUrl: string;
  bookingEnabled: boolean;
};

type FavoriteTarget = {
  tenantId: number;
  tenantSlug: string;
  locationId: number;
  locationSlug: string;
};

export const PUBLIC_CUSTOMER_SESSION_COOKIE = "beautysuite_customer_session";

const CUSTOMER_SESSION_DAYS = 60;
// Hardening 2026-07-18: cap tentativi sui codici 6 cifre + cooldown fra due
// invii email (resend/cambio email/reset) — anti brute-force e anti
// email-bombing (il legacy non aveva né l'uno né l'altro).
const MAX_CODE_ATTEMPTS = 5;
const EMAIL_SEND_COOLDOWN_MS = 60_000;

function withinSendCooldown(sentAt: unknown): boolean {
  if (!sentAt) return false;
  const t = sentAt instanceof Date ? sentAt.getTime() : new Date(String(sentAt).replace(" ", "T")).getTime();
  return Number.isFinite(t) && Date.now() - t < EMAIL_SEND_COOLDOWN_MS;
}

export async function ensurePublicCustomerSchema(): Promise<void> {
  if (!(await tableExists("public_customer_accounts"))) {
  await dbExecute(
    `CREATE TABLE IF NOT EXISTS \`public_customer_accounts\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`email\` VARCHAR(190) NOT NULL,
      \`pending_email\` VARCHAR(190) NULL DEFAULT NULL,
      \`pending_email_verification_hash\` CHAR(64) NULL DEFAULT NULL,
      \`pending_email_verification_expires_at\` DATETIME NULL DEFAULT NULL,
      \`pending_email_verification_sent_at\` DATETIME NULL DEFAULT NULL,
      \`password_hash\` VARCHAR(255) NULL DEFAULT NULL,
      \`full_name\` VARCHAR(190) NULL DEFAULT NULL,
      \`first_name\` VARCHAR(120) NULL DEFAULT NULL,
      \`last_name\` VARCHAR(120) NULL DEFAULT NULL,
      \`phone\` VARCHAR(50) NULL DEFAULT NULL,
      \`email_verified_at\` DATETIME NULL DEFAULT NULL,
      \`email_verification_hash\` CHAR(64) NULL DEFAULT NULL,
      \`email_verification_expires_at\` DATETIME NULL DEFAULT NULL,
      \`email_verification_sent_at\` DATETIME NULL DEFAULT NULL,
      \`password_reset_hash\` CHAR(64) NULL DEFAULT NULL,
      \`password_reset_expires_at\` DATETIME NULL DEFAULT NULL,
      \`password_reset_sent_at\` DATETIME NULL DEFAULT NULL,
      \`privacy_accepted_at\` DATETIME NULL DEFAULT NULL,
      \`privacy_accept_ip\` VARCHAR(64) NULL DEFAULT NULL,
      \`marketing_opt_in\` TINYINT(1) NOT NULL DEFAULT 0,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      \`last_login_at\` DATETIME NULL DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_public_customer_accounts_email\` (\`email\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  );
  }

  if (!(await tableExists("public_customer_tenant_links"))) {
  await dbExecute(
    `CREATE TABLE IF NOT EXISTS \`public_customer_tenant_links\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`account_id\` BIGINT UNSIGNED NOT NULL,
      \`tenant_id\` INT NOT NULL,
      \`tenant_slug\` VARCHAR(80) NOT NULL,
      \`client_id\` INT NOT NULL,
      \`booking_user_id\` INT NULL DEFAULT NULL,
      \`linked_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`last_seen_at\` DATETIME NULL DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_public_customer_tenant\` (\`account_id\`, \`tenant_id\`),
      UNIQUE KEY \`uq_public_customer_tenant_client\` (\`tenant_id\`, \`client_id\`),
      KEY \`idx_public_customer_tenant_slug\` (\`tenant_slug\`),
      KEY \`idx_public_customer_account\` (\`account_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  );
  }

  if (!(await tableExists("public_customer_favorites"))) {
  await dbExecute(
    `CREATE TABLE IF NOT EXISTS \`public_customer_favorites\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`account_id\` BIGINT UNSIGNED NOT NULL,
      \`tenant_id\` INT NOT NULL,
      \`tenant_slug\` VARCHAR(80) NOT NULL,
      \`location_id\` INT NOT NULL DEFAULT 0,
      \`location_slug\` VARCHAR(120) NULL DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_public_customer_favorite\` (\`account_id\`, \`tenant_slug\`, \`location_id\`),
      KEY \`idx_public_customer_favorites_account\` (\`account_id\`, \`created_at\`),
      KEY \`idx_public_customer_favorites_tenant\` (\`tenant_slug\`, \`location_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  );
  }

  if (!(await tableExists("public_customer_sessions"))) {
  await dbExecute(
    `CREATE TABLE IF NOT EXISTS \`public_customer_sessions\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`account_id\` BIGINT UNSIGNED NOT NULL,
      \`token_hash\` CHAR(64) NOT NULL,
      \`user_agent\` VARCHAR(255) NULL DEFAULT NULL,
      \`ip_address\` VARCHAR(64) NULL DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`last_seen_at\` DATETIME NULL DEFAULT NULL,
      \`expires_at\` DATETIME NOT NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_public_customer_sessions_token\` (\`token_hash\`),
      KEY \`idx_public_customer_sessions_account\` (\`account_id\`),
      KEY \`idx_public_customer_sessions_expires\` (\`expires_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  );
  }

  const accountColumns: Array<[string, string]> = [
    ["pending_email", "`pending_email` VARCHAR(190) NULL DEFAULT NULL"],
    ["pending_email_verification_hash", "`pending_email_verification_hash` CHAR(64) NULL DEFAULT NULL"],
    ["pending_email_verification_expires_at", "`pending_email_verification_expires_at` DATETIME NULL DEFAULT NULL"],
    ["pending_email_verification_sent_at", "`pending_email_verification_sent_at` DATETIME NULL DEFAULT NULL"],
    ["password_hash", "`password_hash` VARCHAR(255) NULL DEFAULT NULL"],
    ["full_name", "`full_name` VARCHAR(190) NULL DEFAULT NULL"],
    ["first_name", "`first_name` VARCHAR(120) NULL DEFAULT NULL"],
    ["last_name", "`last_name` VARCHAR(120) NULL DEFAULT NULL"],
    ["phone", "`phone` VARCHAR(50) NULL DEFAULT NULL"],
    ["email_verified_at", "`email_verified_at` DATETIME NULL DEFAULT NULL"],
    ["email_verification_hash", "`email_verification_hash` CHAR(64) NULL DEFAULT NULL"],
    ["email_verification_expires_at", "`email_verification_expires_at` DATETIME NULL DEFAULT NULL"],
    ["email_verification_sent_at", "`email_verification_sent_at` DATETIME NULL DEFAULT NULL"],
    ["password_reset_hash", "`password_reset_hash` CHAR(64) NULL DEFAULT NULL"],
    ["password_reset_expires_at", "`password_reset_expires_at` DATETIME NULL DEFAULT NULL"],
    ["password_reset_sent_at", "`password_reset_sent_at` DATETIME NULL DEFAULT NULL"],
    ["last_login_at", "`last_login_at` DATETIME NULL DEFAULT NULL"],
    // Hardening 2026-07-18: contatori tentativi sui codici 6 cifre (cap
    // anti brute-force; il legacy non li aveva).
    ["email_verification_attempts", "`email_verification_attempts` INT NOT NULL DEFAULT 0"],
    ["pending_email_verification_attempts", "`pending_email_verification_attempts` INT NOT NULL DEFAULT 0"],
    // Audit GDPR 2026-07-21 (migrazioni 0003/0004; qui solo per gli ambienti
    // freschi creati dall'ensure): prova consenso + throttle login password.
    ["privacy_accepted_at", "`privacy_accepted_at` DATETIME NULL DEFAULT NULL"],
    ["privacy_accept_ip", "`privacy_accept_ip` VARCHAR(64) NULL DEFAULT NULL"],
    ["marketing_opt_in", "`marketing_opt_in` TINYINT(1) NOT NULL DEFAULT 0"],
    ["password_login_attempts", "`password_login_attempts` INT NOT NULL DEFAULT 0"],
    ["password_login_last_attempt_at", "`password_login_last_attempt_at` DATETIME NULL DEFAULT NULL"],
  ];

  for (const [column, definition] of accountColumns) {
    await addColumnIfMissing("public_customer_accounts", column, definition);
  }
  await addColumnIfMissing("public_customer_tenant_links", "booking_user_id", "`booking_user_id` INT NULL DEFAULT NULL");
  await addColumnIfMissing("public_customer_tenant_links", "last_seen_at", "`last_seen_at` DATETIME NULL DEFAULT NULL");
  await addColumnIfMissing("public_customer_favorites", "location_slug", "`location_slug` VARCHAR(120) NULL DEFAULT NULL");
}

export async function registerPublicCustomer(input: {
  firstName: string;
  lastName: string;
  phone?: string;
  email: string;
  password: string;
  privacyAccepted?: boolean;
  marketingOptIn?: boolean;
  requestIp?: string;
}): Promise<{ ok: true; accountId: number; email: string; requiresVerification: true; devCode?: string } | { ok: false; error: string }> {
  await ensurePublicCustomerSchema();

  const firstName = clean(input.firstName, 120);
  const lastName = clean(input.lastName, 120);
  const phone = clean(input.phone ?? "", 50);
  const email = normalizeEmail(input.email);
  const password = input.password;
  // GDPR (audit 2026-07-21): accettazione informativa obbligatoria, con prova
  // timestamp+IP (stesso modello della registrazione tenant su saas_tenants).
  const privacyAccepted = input.privacyAccepted === true;
  const marketingOptIn = input.marketingOptIn === true;
  const requestIp = clean(input.requestIp ?? "", 64);

  if (!firstName || !lastName || !email || !password) return { ok: false, error: "Compila nome, cognome, email e password." };
  if (!isValidEmail(email)) return { ok: false, error: "Email non valida." };
  if (password.length < 8) return { ok: false, error: "La password deve avere almeno 8 caratteri." };
  if (!privacyAccepted) return { ok: false, error: "Devi accettare l'informativa sulla privacy per registrarti." };

  const existing = await dbQuery<PublicCustomerRow[]>(
    "SELECT id,email_verified_at FROM `public_customer_accounts` WHERE email=? LIMIT 1",
    [email],
  );
  if (existing[0]?.email_verified_at) return { ok: false, error: "Esiste gia un account cliente con questa email." };

  const fullName = clean(`${firstName} ${lastName}`, 190);
  const passwordHash = await bcrypt.hash(password, 10);
  let accountId = Number(existing[0]?.id ?? 0);

  if (accountId > 0) {
    await dbExecute(
      `UPDATE \`public_customer_accounts\`
          SET password_hash=?,
              full_name=?,
              first_name=?,
              last_name=?,
              phone=?,
              email_verified_at=NULL,
              privacy_accepted_at=NOW(),
              privacy_accept_ip=?,
              marketing_opt_in=?,
              updated_at=NOW()
        WHERE id=?`,
      [passwordHash, fullName, firstName, lastName, phone || null, requestIp || null, marketingOptIn ? 1 : 0, accountId],
    );
  } else {
    const result = await dbExecute(
      `INSERT INTO \`public_customer_accounts\`
        (email,password_hash,full_name,first_name,last_name,phone,email_verified_at,privacy_accepted_at,privacy_accept_ip,marketing_opt_in)
       VALUES(?,?,?,?,?,?,NULL,NOW(),?,?)`,
      [email, passwordHash, fullName, firstName, lastName, phone || null, requestIp || null, marketingOptIn ? 1 : 0],
    );
    accountId = result.insertId;
  }

  const issued = await issuePublicCustomerVerificationCode(accountId, true);
  if (!issued.ok) return issued;
  return {
    ok: true,
    accountId,
    email,
    requiresVerification: true,
    ...(issued.devCode ? { devCode: issued.devCode } : {}),
  };
}

export async function loginPublicCustomer(input: { email: string; password: string }): Promise<
  | { ok: true; account: PublicCustomer }
  | { ok: true; requiresVerification: true; accountId: number; email: string; devCode?: string }
  | { ok: false; error: string }
> {
  await ensurePublicCustomerSchema();

  const email = normalizeEmail(input.email);
  const password = input.password;
  if (!email || !password) return { ok: false, error: "Email e password obbligatorie." };

  // Finestra di throttle calcolata dal DB contro il SUO stesso NOW() (trappola
  // TZ: il timestamp riletto in JS arriva come stringa wall e il confronto con
  // Date.now() sballa dell'offset del server).
  const rows = await dbQuery<PublicCustomerRow[]>(
    "SELECT *, (password_login_last_attempt_at IS NOT NULL AND password_login_last_attempt_at > NOW() - INTERVAL '15 minutes') AS pw_throttle_in_window FROM `public_customer_accounts` WHERE email=? LIMIT 1",
    [email],
  );
  const row = rows[0];

  // Art. 32 (audit GDPR 2026-07-21): throttle per-account sul login password —
  // 10 fallimenti in 15 minuti bloccano temporaneamente, con lo STESSO
  // messaggio generico (niente enumeration). I codici OTP erano già protetti.
  const THROTTLE_MAX = 10;
  if (row) {
    const inWindow = row.pw_throttle_in_window === true || row.pw_throttle_in_window === "t" || row.pw_throttle_in_window === 1;
    if (inWindow && Number(row.password_login_attempts ?? 0) >= THROTTLE_MAX) {
      return { ok: false, error: "Troppi tentativi. Riprova tra qualche minuto." };
    }
    if (!await verifyPhpPassword(password, String(row.password_hash ?? ""))) {
      await dbExecute(
        "UPDATE `public_customer_accounts` SET password_login_attempts=?, password_login_last_attempt_at=NOW() WHERE id=?",
        [inWindow ? Number(row.password_login_attempts ?? 0) + 1 : 1, Number(row.id)],
      ).catch(() => undefined);
      return { ok: false, error: "Credenziali non valide." };
    }
  }
  if (!row) {
    return { ok: false, error: "Credenziali non valide." };
  }

  await dbExecute(
    "UPDATE `public_customer_accounts` SET last_login_at=NOW(), password_login_attempts=0, password_login_last_attempt_at=NULL WHERE id=?",
    [Number(row.id)],
  ).catch(() => undefined);

  if (!row.email_verified_at) {
    const issued = await issuePublicCustomerVerificationCode(Number(row.id), false);
    return {
      ok: true,
      requiresVerification: true,
      accountId: Number(row.id),
      email: String(row.email ?? email),
      ...(issued.ok && issued.devCode ? { devCode: issued.devCode } : {}),
    };
  }

  const updated = await accountById(Number(row.id));
  return { ok: true, account: updated ?? publicCustomerFromRow(row) };
}

export async function issuePublicCustomerVerificationCode(
  accountId: number,
  forceNew = false,
): Promise<{ ok: true; requiresVerification: true; email: string; alreadySent?: boolean; devCode?: string } | { ok: false; error: string }> {
  await ensurePublicCustomerSchema();
  if (accountId <= 0) return { ok: false, error: "Account non valido." };

  const rows = await dbQuery<PublicCustomerRow[]>(
    "SELECT id,email,email_verification_hash,email_verification_expires_at,email_verification_sent_at FROM `public_customer_accounts` WHERE id=?",
    [accountId],
  );
  const row = rows[0];
  if (!row) return { ok: false, error: "Account non trovato." };

  if (!forceNew && row.email_verification_hash && futureDate(row.email_verification_expires_at)) {
    return { ok: true, requiresVerification: true, email: String(row.email), alreadySent: true };
  }
  // Cooldown fra due invii (anche col force del resend): senza, un loop di
  // resend bombarda la casella della vittima.
  if (withinSendCooldown(row.email_verification_sent_at)) {
    return { ok: false, error: "Attendi un minuto prima di richiedere un nuovo codice." };
  }

  const code = generateCode();
  // Expiry written from JS local time (mysqlDate), NOT SQL NOW(): the DB session
  // runs in UTC while the driver reads naive timestamps as LOCAL time, so a
  // NOW()-based expiry lands 2h in the past on CET/CEST and every code reads
  // as already expired (live bug found 2026-07-02).
  await dbExecute(
    `UPDATE \`public_customer_accounts\`
        SET email_verification_hash=?,
            email_verification_sent_at=?,
            email_verification_expires_at=?,
            email_verification_attempts=0
      WHERE id=?`,
    [codeHash(code), mysqlDate(new Date()), mysqlDate(new Date(Date.now() + 15 * 60000)), accountId],
  );

  // Send AFTER the DB write so the code is valid even if delivery has a transient
  // error; send is best-effort and never fails the issuance (see helper comment).
  await sendPublicAccountEmail(String(row.email), "Codice verifica email", buildVerificationEmailBody(code));

  return {
    ok: true,
    requiresVerification: true,
    email: String(row.email),
    ...(exposeLocalDebug() ? { devCode: code } : {}),
  };
}

export async function verifyPublicCustomerCode(
  accountId: number,
  code: string,
): Promise<{ ok: true; account: PublicCustomer } | { ok: false; error: string }> {
  await ensurePublicCustomerSchema();
  const normalizedCode = code.replace(/\s+/g, "").trim();
  if (accountId <= 0) return { ok: false, error: "Account non valido." };
  if (!/^\d{6}$/.test(normalizedCode)) return { ok: false, error: "Inserisci un codice valido di 6 cifre." };

  const rows = await dbQuery<PublicCustomerRow[]>("SELECT * FROM `public_customer_accounts` WHERE id=?", [accountId]);
  const row = rows[0];
  if (!row) return { ok: false, error: "Account non trovato." };
  if (row.email_verified_at) return { ok: true, account: publicCustomerFromRow(row) };

  if (row.email_verification_expires_at && !futureDate(row.email_verification_expires_at)) {
    return { ok: false, error: "Codice scaduto. Richiedi un nuovo codice." };
  }
  if (!row.email_verification_hash || !safeEqual(String(row.email_verification_hash), codeHash(normalizedCode))) {
    // Cap anti brute-force (hardening 2026-07-18): al 5° tentativo errato il
    // codice viene INVALIDATO — 6 cifre in 15 minuti senza cap sarebbero
    // enumerabili da un client automatico.
    const attempts = Number(row.email_verification_attempts ?? 0) + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      await dbExecute(
        `UPDATE \`public_customer_accounts\`
            SET email_verification_hash=NULL,
                email_verification_expires_at=NULL,
                email_verification_attempts=0
          WHERE id=?`,
        [accountId],
      );
      return { ok: false, error: "Troppi tentativi. Richiedi un nuovo codice." };
    }
    await dbExecute("UPDATE `public_customer_accounts` SET email_verification_attempts=? WHERE id=?", [attempts, accountId]);
    return { ok: false, error: "Codice non valido." };
  }

  await dbExecute(
    `UPDATE \`public_customer_accounts\`
        SET email_verified_at=NOW(),
            email_verification_hash=NULL,
            email_verification_expires_at=NULL,
            email_verification_sent_at=NULL,
            last_login_at=NOW()
      WHERE id=?`,
    [accountId],
  );
  const account = await accountById(accountId);
  if (!account) return { ok: false, error: "Account non trovato." };
  return { ok: true, account };
}

export async function requestPublicCustomerPasswordReset(
  emailInput: string,
): Promise<{ ok: true; message: string; devToken?: string } | { ok: false; error: string }> {
  await ensurePublicCustomerSchema();
  const email = normalizeEmail(emailInput);
  if (!isValidEmail(email)) return { ok: false, error: "Email non valida." };

  const token = crypto.randomBytes(32).toString("hex");
  const rows = await dbQuery<PublicCustomerRow[]>("SELECT id,email,password_reset_sent_at FROM `public_customer_accounts` WHERE email=? LIMIT 1", [email]);
  // Cooldown SILENZIOSO (hardening 2026-07-18): entro 60s dall'ultimo invio
  // NON si rigenera/spedisce, ma la risposta resta la stessa frase generica —
  // un errore dedicato solo per gli account esistenti sarebbe enumeration.
  const canSend = Boolean(rows[0]) && !withinSendCooldown(rows[0]?.password_reset_sent_at);
  if (canSend) {
    // JS-side expiry (see issuePublicCustomerVerificationCode): SQL NOW() is UTC
    // but naive timestamps read back as local, so a NOW()-based expiry is ~2h
    // in the past on CET/CEST.
    await dbExecute(
      `UPDATE \`public_customer_accounts\`
          SET password_reset_hash=?,
              password_reset_sent_at=?,
              password_reset_expires_at=?
        WHERE id=?`,
      [sha256(token), mysqlDate(new Date()), mysqlDate(new Date(Date.now() + 30 * 60000)), Number(rows[0].id)],
    );

    // Send AFTER the DB write so the token is valid even on a transient send error;
    // best-effort, never fails the (deliberately generic) forgot-password response.
    const recipient = String(rows[0].email ?? email);
    const resetLink = buildPublicResetLink(token, recipient);
    await sendPublicAccountEmail(recipient, "Reset password", buildPasswordResetEmailBody(resetLink));
  }

  return {
    ok: true,
    message: "Se l'email e registrata, riceverai un link per reimpostare la password.",
    // devToken solo se il token è stato DAVVERO emesso (in cooldown non lo è).
    ...(canSend && exposeLocalDebug() ? { devToken: token } : {}),
  };
}

export async function resetPublicCustomerPassword(input: {
  email: string;
  token: string;
  password: string;
}): Promise<{ ok: true; account: PublicCustomer } | { ok: false; error: string }> {
  await ensurePublicCustomerSchema();
  const email = normalizeEmail(input.email);
  const token = input.token.trim().toLowerCase();
  const password = input.password;
  if (!isValidEmail(email) || !/^[a-f0-9]{64}$/.test(token)) return { ok: false, error: "Link di reset non valido." };
  if (password.length < 8) return { ok: false, error: "La password deve avere almeno 8 caratteri." };

  const rows = await dbQuery<PublicCustomerRow[]>(
    "SELECT id,password_reset_hash,password_reset_expires_at FROM `public_customer_accounts` WHERE email=? LIMIT 1",
    [email],
  );
  const row = rows[0];
  if (!row || !row.password_reset_hash || !safeEqual(String(row.password_reset_hash), sha256(token))) {
    return { ok: false, error: "Link di reset non valido." };
  }
  if (row.password_reset_expires_at && !futureDate(row.password_reset_expires_at)) {
    return { ok: false, error: "Link di reset scaduto o non valido." };
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await dbExecute(
    `UPDATE \`public_customer_accounts\`
        SET password_hash=?,
            password_reset_hash=NULL,
            password_reset_expires_at=NULL,
            password_reset_sent_at=NULL,
            email_verified_at=COALESCE(email_verified_at,NOW()),
            updated_at=NOW()
      WHERE id=?`,
    [passwordHash, Number(row.id)],
  );
  await syncPublicCustomerPasswordToTenantUsers(Number(row.id), passwordHash);
  // Art. 32 (audit GDPR 2026-07-21): il reset password revoca TUTTE le sessioni
  // esistenti (il chiamante ne apre una nuova per l'utente appena resettato).
  await dbExecute("DELETE FROM `public_customer_sessions` WHERE account_id=?", [Number(row.id)]).catch(() => undefined);
  const account = await accountById(Number(row.id));
  if (!account) return { ok: false, error: "Account non trovato." };
  return { ok: true, account };
}

export async function startPublicCustomerSession(accountId: number, request?: Request): Promise<PublicCustomer | null> {
  await ensurePublicCustomerSchema();
  if (accountId <= 0) return null;

  const account = await accountById(accountId);
  if (!account) return null;

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = mysqlDate(new Date(Date.now() + CUSTOMER_SESSION_DAYS * 86400 * 1000));
  const userAgent = truncate(request?.headers.get("user-agent") ?? "", 255);
  const ip = truncate(request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? request?.headers.get("x-real-ip") ?? "", 64);

  await dbExecute("DELETE FROM `public_customer_sessions` WHERE expires_at < NOW()").catch(() => undefined);
  await dbExecute(
    `INSERT INTO \`public_customer_sessions\`(account_id,token_hash,user_agent,ip_address,last_seen_at,expires_at)
     VALUES(?,?,?,?,NOW(),?)`,
    [accountId, sha256(token), userAgent || null, ip || null, expiresAt],
  );

  const cookieStore = await cookies();
  cookieStore.set(PUBLIC_CUSTOMER_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: CUSTOMER_SESSION_DAYS * 86400,
  });

  return account;
}

export async function currentPublicCustomerSession(): Promise<PublicCustomer | null> {
  await ensurePublicCustomerSchema();
  const cookieStore = await cookies();
  const token = (cookieStore.get(PUBLIC_CUSTOMER_SESSION_COOKIE)?.value ?? "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(token)) return null;

  const hash = sha256(token);
  const rows = await dbQuery<PublicCustomerRow[]>(
    `SELECT a.*
       FROM \`public_customer_sessions\` s
       JOIN \`public_customer_accounts\` a ON a.id=s.account_id
      WHERE s.token_hash=? AND s.expires_at > NOW()
      LIMIT 1`,
    [hash],
  );
  const row = rows[0];
  if (!row) return null;
  await dbExecute("UPDATE `public_customer_sessions` SET last_seen_at=NOW() WHERE token_hash=?", [hash]).catch(() => undefined);
  return publicCustomerFromRow(row);
}

export async function clearPublicCustomerSession(): Promise<void> {
  await ensurePublicCustomerSchema();
  const cookieStore = await cookies();
  const token = (cookieStore.get(PUBLIC_CUSTOMER_SESSION_COOKIE)?.value ?? "").trim().toLowerCase();
  if (/^[a-f0-9]{64}$/.test(token)) {
    await dbExecute("DELETE FROM `public_customer_sessions` WHERE token_hash=?", [sha256(token)]).catch(() => undefined);
  }
  cookieStore.set(PUBLIC_CUSTOMER_SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

export async function updatePublicCustomerProfile(
  accountId: number,
  input: { firstName: string; lastName: string; phone?: string },
): Promise<{ ok: true; account: PublicCustomer } | { ok: false; error: string }> {
  await ensurePublicCustomerSchema();
  const firstName = clean(input.firstName, 120);
  const lastName = clean(input.lastName, 120);
  const phone = clean(input.phone ?? "", 50);
  if (accountId <= 0) return { ok: false, error: "Account non valido." };
  if (!firstName || !lastName) return { ok: false, error: "Inserisci nome e cognome." };

  await dbExecute(
    `UPDATE \`public_customer_accounts\`
        SET first_name=?,
            last_name=?,
            full_name=?,
            phone=?,
            updated_at=NOW()
      WHERE id=?`,
    [firstName, lastName, clean(`${firstName} ${lastName}`, 190), phone || null, accountId],
  );
  const account = await accountById(accountId);
  if (!account) return { ok: false, error: "Account non trovato." };
  return { ok: true, account };
}

export async function changePublicCustomerPassword(
  accountId: number,
  input: { currentPassword: string; newPassword: string; confirmPassword: string },
): Promise<{ ok: true; account: PublicCustomer } | { ok: false; error: string }> {
  await ensurePublicCustomerSchema();
  if (accountId <= 0) return { ok: false, error: "Account non valido." };
  if (!input.currentPassword || !input.newPassword || !input.confirmPassword) return { ok: false, error: "Compila tutti i campi password." };
  if (input.newPassword.length < 8) return { ok: false, error: "La nuova password deve avere almeno 8 caratteri." };
  if (input.newPassword !== input.confirmPassword) return { ok: false, error: "Le nuove password non coincidono." };

  const rows = await dbQuery<PublicCustomerRow[]>("SELECT * FROM `public_customer_accounts` WHERE id=?", [accountId]);
  const row = rows[0];
  if (!row) return { ok: false, error: "Account non trovato." };
  if (!await verifyPhpPassword(input.currentPassword, String(row.password_hash ?? ""))) {
    return { ok: false, error: "La password attuale non e corretta." };
  }

  const passwordHash = await bcrypt.hash(input.newPassword, 10);
  await dbExecute(
    `UPDATE \`public_customer_accounts\`
        SET password_hash=?,
            password_reset_hash=NULL,
            password_reset_expires_at=NULL,
            password_reset_sent_at=NULL,
            updated_at=NOW()
      WHERE id=?`,
    [passwordHash, accountId],
  );
  await syncPublicCustomerPasswordToTenantUsers(accountId, passwordHash);
  // Art. 32 (audit GDPR 2026-07-21): il cambio password revoca le ALTRE
  // sessioni (es. dispositivo rubato); quella corrente resta valida.
  try {
    const cookieStore = await cookies();
    const currentToken = (cookieStore.get(PUBLIC_CUSTOMER_SESSION_COOKIE)?.value ?? "").trim().toLowerCase();
    if (/^[a-f0-9]{64}$/.test(currentToken)) {
      await dbExecute("DELETE FROM `public_customer_sessions` WHERE account_id=? AND token_hash<>?", [accountId, sha256(currentToken)]);
    } else {
      await dbExecute("DELETE FROM `public_customer_sessions` WHERE account_id=?", [accountId]);
    }
  } catch {
    // best-effort: il cambio password è comunque riuscito
  }
  const account = await accountById(accountId);
  return account ? { ok: true, account } : { ok: false, error: "Account non trovato." };
}

export async function requestPublicCustomerEmailChange(
  accountId: number,
  input: { newEmail: string; currentPassword: string },
): Promise<{ ok: true; account: PublicCustomer; devCode?: string } | { ok: false; error: string }> {
  await ensurePublicCustomerSchema();
  const newEmail = normalizeEmail(input.newEmail);
  if (accountId <= 0) return { ok: false, error: "Account non valido." };
  if (!newEmail || !input.currentPassword) return { ok: false, error: "Inserisci nuova email e password attuale." };
  if (!isValidEmail(newEmail)) return { ok: false, error: "Email non valida." };

  const rows = await dbQuery<PublicCustomerRow[]>("SELECT * FROM `public_customer_accounts` WHERE id=?", [accountId]);
  const row = rows[0];
  if (!row) return { ok: false, error: "Account non trovato." };
  if (!await verifyPhpPassword(input.currentPassword, String(row.password_hash ?? ""))) {
    return { ok: false, error: "La password attuale non e corretta." };
  }
  if (normalizeEmail(row.email) === newEmail) return { ok: false, error: "La nuova email coincide con quella attuale." };

  const duplicate = await dbQuery<RowDataPacket[]>(
    "SELECT id FROM `public_customer_accounts` WHERE id<>? AND (LOWER(email)=? OR LOWER(COALESCE(pending_email,''))=?) LIMIT 1",
    [accountId, newEmail, newEmail],
  );
  if (duplicate[0]) return { ok: false, error: "Questa email e gia collegata a un altro account." };

  // Cooldown fra due richieste (hardening 2026-07-18): senza, un loop di
  // request bombarda la casella della nuova email.
  if (withinSendCooldown(row.pending_email_verification_sent_at)) {
    return { ok: false, error: "Attendi un minuto prima di richiedere un nuovo codice." };
  }

  const code = generateCode();
  // JS-side expiry (see issuePublicCustomerVerificationCode): NOW() is UTC vs
  // naive-local reads — a SQL expiry lands in the past on CET/CEST.
  await dbExecute(
    `UPDATE \`public_customer_accounts\`
        SET pending_email=?,
            pending_email_verification_hash=?,
            pending_email_verification_expires_at=?,
            pending_email_verification_sent_at=?,
            pending_email_verification_attempts=0,
            updated_at=NOW()
      WHERE id=?`,
    [newEmail, codeHash(code), mysqlDate(new Date(Date.now() + 15 * 60000)), mysqlDate(new Date()), accountId],
  );

  // Send the confirmation code to the NEW pending_email, AFTER the DB write so the
  // code stays valid on a transient send error; best-effort, never fails the change.
  await sendPublicAccountEmail(newEmail, "Conferma nuova email", buildEmailChangeVerificationBody(code));

  const account = await accountById(accountId);
  if (!account) return { ok: false, error: "Account non trovato." };
  return { ok: true, account, ...(exposeLocalDebug() ? { devCode: code } : {}) };
}

export async function confirmPublicCustomerEmailChange(
  accountId: number,
  codeInput: string,
): Promise<{ ok: true; account: PublicCustomer } | { ok: false; error: string; account?: PublicCustomer }> {
  await ensurePublicCustomerSchema();
  const code = codeInput.replace(/\s+/g, "").trim();
  if (accountId <= 0) return { ok: false, error: "Account non valido." };
  if (!code) return { ok: false, error: "Inserisci il codice ricevuto via email." };

  const rows = await dbQuery<PublicCustomerRow[]>("SELECT * FROM `public_customer_accounts` WHERE id=?", [accountId]);
  const row = rows[0];
  if (!row) return { ok: false, error: "Account non trovato." };

  const pendingEmail = normalizeEmail(row.pending_email ?? "");
  const storedHash = String(row.pending_email_verification_hash ?? "");
  if (!pendingEmail || !storedHash) return { ok: false, error: "Nessun cambio email in attesa." };
  if (row.pending_email_verification_expires_at && !futureDate(row.pending_email_verification_expires_at as string | Date | null | undefined)) {
    await cancelPublicCustomerEmailChange(accountId);
    return { ok: false, error: "Il codice e scaduto. Richiedi un nuovo codice.", account: await accountById(accountId) ?? undefined };
  }
  if (!safeEqual(storedHash, codeHash(code))) {
    // Cap anti brute-force come la verify di registrazione: al 5° errato la
    // richiesta di cambio email viene ANNULLATA.
    const attempts = Number(row.pending_email_verification_attempts ?? 0) + 1;
    if (attempts >= MAX_CODE_ATTEMPTS) {
      await cancelPublicCustomerEmailChange(accountId);
      return { ok: false, error: "Troppi tentativi. Richiedi un nuovo codice.", account: await accountById(accountId) ?? undefined };
    }
    await dbExecute("UPDATE `public_customer_accounts` SET pending_email_verification_attempts=? WHERE id=?", [attempts, accountId]);
    return { ok: false, error: "Codice non valido." };
  }

  const duplicate = await dbQuery<RowDataPacket[]>(
    "SELECT id FROM `public_customer_accounts` WHERE id<>? AND LOWER(email)=? LIMIT 1",
    [accountId, pendingEmail],
  );
  if (duplicate[0]) return { ok: false, error: "Questa email e gia collegata a un altro account." };

  const oldEmail = normalizeEmail(row.email);
  await dbExecute(
    `UPDATE \`public_customer_accounts\`
        SET email=?,
            email_verified_at=NOW(),
            pending_email=NULL,
            pending_email_verification_hash=NULL,
            pending_email_verification_expires_at=NULL,
            pending_email_verification_sent_at=NULL,
            updated_at=NOW()
      WHERE id=?`,
    [pendingEmail, accountId],
  );
  await syncPublicCustomerEmailToTenantRecords(accountId, oldEmail, pendingEmail);
  const account = await accountById(accountId);
  return account ? { ok: true, account } : { ok: false, error: "Account non trovato." };
}

export async function cancelPublicCustomerEmailChange(
  accountId: number,
): Promise<{ ok: true; account: PublicCustomer } | { ok: false; error: string }> {
  await ensurePublicCustomerSchema();
  if (accountId <= 0) return { ok: false, error: "Account non valido." };
  await dbExecute(
    `UPDATE \`public_customer_accounts\`
        SET pending_email=NULL,
            pending_email_verification_hash=NULL,
            pending_email_verification_expires_at=NULL,
            pending_email_verification_sent_at=NULL,
            pending_email_verification_attempts=0,
            updated_at=NOW()
      WHERE id=?`,
    [accountId],
  );
  const account = await accountById(accountId);
  return account ? { ok: true, account } : { ok: false, error: "Account non trovato." };
}

export async function publicCustomerFavoriteKeys(accountId: number): Promise<Record<string, true>> {
  await ensurePublicCustomerSchema();
  if (accountId <= 0) return {};
  // cross-tenant: dati dell'ACCOUNT marketplace (chiave account_id) — il cliente attraversa i tenant per design.
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT tenant_slug,location_id,location_slug FROM `public_customer_favorites` WHERE account_id=?",
    [accountId],
  );
  const keys: Record<string, true> = {};
  for (const row of rows) {
    const target = await favoriteTarget(String(row.tenant_slug ?? ""), Number(row.location_id ?? 0), String(row.location_slug ?? ""));
    if (target) keys[globalFavoriteKey(target.tenantSlug, target.locationId)] = true;
  }
  return keys;
}

export async function togglePublicCustomerFavorite(
  accountId: number,
  input: { tenantSlug: string; locationId?: number; locationSlug?: string },
): Promise<{ ok: true; active: boolean; key: string } | { ok: false; error: string }> {
  await ensurePublicCustomerSchema();
  if (accountId <= 0) return { ok: false, error: "Account non valido." };

  const account = await accountById(accountId);
  if (!account) return { ok: false, error: "Account non trovato." };

  const target = await favoriteTarget(input.tenantSlug, input.locationId ?? 0, input.locationSlug ?? "");
  if (!target) return { ok: false, error: "Scheda non disponibile per i preferiti." };

  const key = globalFavoriteKey(target.tenantSlug, target.locationId);
  // cross-tenant: dati dell'ACCOUNT marketplace (chiave account_id) — il cliente attraversa i tenant per design.
  const existing = await dbQuery<RowDataPacket[]>(
    "SELECT id FROM `public_customer_favorites` WHERE account_id=? AND tenant_slug=? AND location_id=? LIMIT 1",
    [accountId, target.tenantSlug, target.locationId],
  );
  if (existing[0]) {
    // Niente LIMIT su DELETE: Postgres non lo supporta (id è comunque PK).
    // cross-tenant: delete per id gia' selezionato con filtro account_id (riga sopra).
    await dbExecute("DELETE FROM `public_customer_favorites` WHERE id=?", [Number(existing[0].id)]);
    return { ok: true, active: false, key };
  }

  await dbExecute(
    `INSERT INTO \`public_customer_favorites\`
      (account_id,tenant_id,tenant_slug,location_id,location_slug)
     VALUES(?,?,?,?,?)
     ON CONFLICT (account_id,tenant_slug,location_id) DO UPDATE SET location_slug=EXCLUDED.location_slug`,
    [accountId, target.tenantId, target.tenantSlug, target.locationId, target.locationSlug || null],
  );
  return { ok: true, active: true, key };
}

export async function removePublicCustomerFavorite(
  accountId: number,
  tenantSlug: string,
  locationId: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  await ensurePublicCustomerSchema();
  const normalizedSlug = normalizeSlug(tenantSlug);
  const normalizedLocationId = Math.max(0, Number(locationId) || 0);
  if (accountId <= 0) return { ok: false, error: "Account non valido." };
  if (!normalizedSlug || normalizedLocationId <= 0) return { ok: false, error: "Preferito non valido." };

  // cross-tenant: dati dell'ACCOUNT marketplace (chiave account_id) — il cliente attraversa i tenant per design.
  await dbExecute(
    "DELETE FROM `public_customer_favorites` WHERE account_id=? AND tenant_slug=? AND location_id=?",
    [accountId, normalizedSlug, normalizedLocationId],
  );
  return { ok: true };
}

export async function publicCustomerFavorites(accountId: number): Promise<PublicCustomerFavorite[]> {
  await ensurePublicCustomerSchema();
  if (accountId <= 0) return [];

  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT id,tenant_id,tenant_slug,location_id,location_slug,created_at
       FROM \`public_customer_favorites\`
      WHERE account_id=?
   ORDER BY created_at DESC, id DESC`,
    [accountId],
  );

  const favorites: PublicCustomerFavorite[] = [];
  for (const row of rows) {
    const item = await favoriteFromRow(row);
    if (item) favorites.push(item);
  }
  return favorites;
}

export async function publicCustomerActivities(accountId: number): Promise<PublicCustomerActivity[]> {
  await ensurePublicCustomerSchema();
  if (accountId <= 0) return [];

  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT l.id AS link_id,
            l.tenant_id,
            l.tenant_slug,
            l.client_id,
            l.booking_user_id,
            l.linked_at,
            l.last_seen_at,
            t.slug AS slug,
            t.name AS tenant_name,
            t.booking_public_allowed
       FROM \`public_customer_tenant_links\` l
       JOIN \`saas_tenants\` t ON t.id=l.tenant_id
      WHERE l.account_id=?
        AND COALESCE(t.is_active,1)=1
   ORDER BY COALESCE(l.last_seen_at,l.linked_at) DESC, l.id DESC`,
    [accountId],
  ).catch(() => [] as RowDataPacket[]);

  const activities: PublicCustomerActivity[] = [];
  const staleIds: number[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const tenantSlug = normalizeSlug(row.slug ?? row.tenant_slug);
    const clientId = Number(row.client_id ?? 0);
    const linkId = Number(row.link_id ?? 0);
    if (!tenantSlug || clientId <= 0) continue;

    const exists = await tenantClientExists(tenantSlug, clientId);
    if (exists !== true) {
      if (exists === false && linkId > 0) staleIds.push(linkId);
      continue;
    }

    const tenantId = Number(row.tenant_id ?? 0);
    const key = tenantId > 0 ? `id:${tenantId}` : `slug:${tenantSlug}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const profile = await publicProfileSummary(tenantId, tenantSlug, String(row.tenant_name ?? ""));
    const locations = await publicLocationsForTenant(tenantId, tenantSlug);
    // Sede di riferimento corrente del cliente collegato (best-effort).
    const clientRows = await tenantSelect<RowDataPacket>({
      slug: tenantSlug,
      table: "clients",
      columns: "location_id",
      where: "id = ?",
      params: [clientId],
      limit: 1,
    }).catch(() => [] as RowDataPacket[]);
    activities.push({
      tenantSlug,
      tenantName: profile.tenantName,
      title: profile.title,
      subtitle: profile.subtitle,
      city: profile.city,
      province: profile.province,
      address: profile.address,
      phone: profile.phone,
      email: profile.email,
      bookingUrl: profile.bookingUrl,
      linkedAt: dateString(row.linked_at as string | Date | null | undefined),
      lastSeenAt: dateString(row.last_seen_at as string | Date | null | undefined),
      clientId,
      referenceLocationId: Number(clientRows[0]?.location_id ?? 0) || 0,
      locations: locations.map((location) => ({
        locationId: location.locationId,
        locationSlug: location.locationSlug,
        locationName: location.locationName,
        city: location.city,
        address: location.address,
        bookingUrl: location.bookingUrl,
      })),
    });
  }

  if (staleIds.length) {
    const placeholders = staleIds.map(() => "?").join(",");
    // cross-tenant: dati dell'ACCOUNT marketplace (chiave account_id) — il cliente attraversa i tenant per design.
    await dbExecute(`DELETE FROM \`public_customer_tenant_links\` WHERE id IN (${placeholders})`, staleIds).catch(() => undefined);
  }

  return activities;
}

export async function upsertPublicCustomerFromBooking(input: {
  tenantSlug: string;
  clientId: number;
  bookingUserId?: number | null;
  email?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  passwordHash?: string | null;
}): Promise<PublicCustomer | null> {
  await ensurePublicCustomerSchema();
  const tenantSlug = normalizeSlug(input.tenantSlug);
  const email = normalizeEmail(input.email ?? "");
  const clientId = Number(input.clientId ?? 0);
  if (!tenantSlug || !isValidEmail(email) || clientId <= 0) return null;

  const tenant = await tenantBySlug(tenantSlug);
  if (!tenant) return null;

  const firstName = clean(input.firstName ?? firstNameFromFullName(input.fullName ?? ""), 120);
  const lastName = clean(input.lastName ?? lastNameFromFullName(input.fullName ?? ""), 120);
  const fullName = clean(input.fullName ?? `${firstName} ${lastName}`, 190);
  const phone = clean(input.phone ?? "", 50);
  const passwordHash = clean(input.passwordHash ?? "", 255);
  const bookingUserId = Number(input.bookingUserId ?? 0) || null;

  const existing = await dbQuery<PublicCustomerRow[]>("SELECT * FROM `public_customer_accounts` WHERE email=? LIMIT 1", [email]);
  let accountId = Number(existing[0]?.id ?? 0);

  if (accountId > 0) {
    const sets = [
      "last_login_at=NOW()",
      "email_verified_at=COALESCE(email_verified_at,NOW())",
    ];
    const params: unknown[] = [];
    if (passwordHash) {
      sets.push("password_hash=?");
      params.push(passwordHash);
    }
    if (fullName) {
      sets.push("full_name=?");
      params.push(fullName);
    }
    if (firstName) {
      sets.push("first_name=?");
      params.push(firstName);
    }
    if (lastName) {
      sets.push("last_name=?");
      params.push(lastName);
    }
    if (phone) {
      sets.push("phone=?");
      params.push(phone);
    }
    params.push(accountId);
    await dbExecute(`UPDATE \`public_customer_accounts\` SET ${sets.join(",")} WHERE id=?`, params);
  } else {
    const result = await dbExecute(
      `INSERT INTO \`public_customer_accounts\`
        (email,password_hash,full_name,first_name,last_name,phone,email_verified_at,last_login_at)
       VALUES(?,?,?,?,?,?,NOW(),NOW())`,
      [email, passwordHash || null, fullName || null, firstName || null, lastName || null, phone || null],
    );
    accountId = result.insertId;
  }

  await dbExecute(
    `INSERT INTO \`public_customer_tenant_links\`
      (account_id,tenant_id,tenant_slug,client_id,booking_user_id,last_seen_at)
     VALUES(?,?,?,?,?,NOW())
     ON CONFLICT (tenant_id,client_id) DO UPDATE SET
       account_id=EXCLUDED.account_id,
       tenant_slug=EXCLUDED.tenant_slug,
       client_id=EXCLUDED.client_id,
       booking_user_id=EXCLUDED.booking_user_id,
       last_seen_at=NOW()`,
    [accountId, Number(tenant.id), String(tenant.slug), clientId, bookingUserId],
  );

  return accountById(accountId);
}

async function accountById(accountId: number): Promise<PublicCustomer | null> {
  if (accountId <= 0) return null;
  const rows = await dbQuery<PublicCustomerRow[]>("SELECT * FROM `public_customer_accounts` WHERE id=?", [accountId]);
  return rows[0] ? publicCustomerFromRow(rows[0]) : null;
}

function publicCustomerFromRow(row: PublicCustomerRow): PublicCustomer {
  const firstName = String(row.first_name ?? "").trim();
  const lastName = String(row.last_name ?? "").trim();
  const fullName = String(row.full_name ?? "").trim() || [firstName, lastName].filter(Boolean).join(" ") || String(row.email ?? "");
  return {
    id: Number(row.id ?? 0),
    email: String(row.email ?? ""),
    fullName,
    firstName,
    lastName,
    phone: String(row.phone ?? ""),
    pendingEmail: String(row.pending_email ?? ""),
    emailVerifiedAt: dateString(row.email_verified_at),
    createdAt: dateString(row.created_at),
    updatedAt: dateString(row.updated_at),
    lastLoginAt: dateString(row.last_login_at),
  };
}

async function favoriteFromRow(row: RowDataPacket): Promise<PublicCustomerFavorite | null> {
  const target = await favoriteTarget(String(row.tenant_slug ?? ""), Number(row.location_id ?? 0), String(row.location_slug ?? ""));
  if (!target) return null;

  const profile = await publicProfileSummary(target.tenantId, target.tenantSlug, "");
  const location = await publicLocationSummary(target.tenantId, target.tenantSlug, target.locationId, target.locationSlug);
  if (!location) return null;

  const bookingUrl = location.bookingUrl || profile.bookingUrl || `/${target.tenantSlug}/booking?start=1&location_id=${target.locationId}`;
  return {
    id: Number(row.id ?? 0),
    key: globalFavoriteKey(target.tenantSlug, target.locationId),
    tenantSlug: target.tenantSlug,
    locationId: target.locationId,
    locationSlug: target.locationSlug,
    title: profile.title,
    subtitle: profile.subtitle,
    locationName: location.locationName,
    city: location.city || profile.city,
    province: location.province || profile.province,
    address: location.address || profile.address,
    phone: location.phone || profile.phone,
    email: location.email || profile.email,
    bookingUrl,
    profileUrl: `/attivita/${target.tenantSlug}`,
    favoritedAt: dateString(row.created_at as string | Date | null | undefined),
    bookingEnabled: profile.bookingAllowed && location.bookingEnabled,
  };
}

async function favoriteTarget(tenantSlugInput: string, locationIdInput = 0, locationSlugInput = ""): Promise<FavoriteTarget | null> {
  const tenantSlug = normalizeSlug(tenantSlugInput);
  const locationId = Math.max(0, Number(locationIdInput) || 0);
  const locationSlug = clean(locationSlugInput, 120);
  if (!tenantSlug || (!locationId && !locationSlug)) return null;

  const tenant = await tenantBySlug(tenantSlug);
  if (!tenant) return null;

  const location = await publicLocationSummary(Number(tenant.id), String(tenant.slug), locationId, locationSlug);
  if (!location || location.locationId <= 0) return null;

  return {
    tenantId: Number(tenant.id),
    tenantSlug: String(tenant.slug),
    locationId: location.locationId,
    locationSlug: location.locationSlug,
  };
}

async function tenantBySlug(slugInput: string): Promise<TenantRow | null> {
  const slug = normalizeSlug(slugInput);
  if (!slug) return null;
  const rows = await dbQuery<TenantRow[]>(
    `SELECT id,slug,name,booking_public_allowed
       FROM \`saas_tenants\`
      WHERE slug=?
        AND COALESCE(is_active,1)=1
        AND COALESCE(marketplace_public_allowed,1)=1
        AND deleted_at IS NULL
      LIMIT 1`,
    [slug],
  ).catch(() => [] as TenantRow[]);
  return rows[0] ?? null;
}

async function publicProfileSummary(tenantId: number, tenantSlug: string, tenantName: string): Promise<ProfileSummary> {
  const fallbackName = tenantName || tenantSlug;
  const base: ProfileSummary = {
    tenantId,
    tenantSlug,
    tenantName: fallbackName,
    title: fallbackName,
    subtitle: "",
    city: "",
    province: "",
    address: "",
    phone: "",
    email: "",
    bookingUrl: `/${tenantSlug}/booking?start=1`,
    bookingAllowed: true,
  };

  if (tenantId > 0 && await tableExists("tenant_directory_profiles")) {
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT title,subtitle,city,province,address,phone,email,booking_url,status
         FROM \`tenant_directory_profiles\`
        WHERE tenant_id=? AND COALESCE(status,'published')='published'
        LIMIT 1`,
      [tenantId],
    ).catch(() => [] as RowDataPacket[]);
    const row = rows[0];
    if (row) {
      return {
        ...base,
        title: clean(row.title ?? "", 190) || fallbackName,
        subtitle: clean(row.subtitle ?? "", 255),
        city: clean(row.city ?? "", 120),
        province: clean(row.province ?? "", 80),
        address: clean(row.address ?? "", 255),
        phone: clean(row.phone ?? "", 50),
        email: clean(row.email ?? "", 190),
        bookingUrl: clean(row.booking_url ?? "", 255) || base.bookingUrl,
      };
    }
  }

  const businessRows = tenantId > 0
    ? await dbQuery<RowDataPacket[]>(
      `SELECT name,booking_about_text,site_city,quote_city,site_province,quote_province,site_address,address,phone,email,website
         FROM \`businesses\`
        WHERE tenant_id=?
        LIMIT 1`,
      [tenantId],
    ).catch(() => [] as RowDataPacket[])
    : [];
  const business = businessRows[0];
  if (!business) return base;

  return {
    ...base,
    title: clean(business.name ?? "", 190) || fallbackName,
    subtitle: clean(business.booking_about_text ?? "", 255),
    city: clean(business.site_city ?? business.quote_city ?? "", 120),
    province: clean(business.site_province ?? business.quote_province ?? "", 80),
    address: clean(business.site_address ?? business.address ?? "", 255),
    phone: clean(business.phone ?? "", 50),
    email: clean(business.email ?? "", 190),
  };
}

async function publicLocationsForTenant(tenantId: number, tenantSlug: string): Promise<LocationSummary[]> {
  if (tenantId > 0 && await tableExists("tenant_directory_locations")) {
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT location_id,location_slug,location_name,city,province,address,phone,email,booking_url,booking_enabled
         FROM \`tenant_directory_locations\`
        WHERE tenant_id=?
          AND COALESCE(is_visible,1)=1
          AND COALESCE(status,'published')='published'
          AND COALESCE(marketplace_enabled,1)=1
     ORDER BY sort_order ASC, location_name ASC, city ASC`,
      [tenantId],
    ).catch(() => [] as RowDataPacket[]);
    if (rows.length) {
      return rows.map((row) => locationSummaryFromDirectory(row, tenantSlug));
    }
  }

  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT id,name,address,legal_city,legal_province,phone,email,booking_enabled
       FROM \`locations\`
      WHERE tenant_id=?
        AND COALESCE(is_active,1)=1
        AND COALESCE(marketplace_enabled,1)=1
   ORDER BY sort_order ASC, name ASC
      LIMIT 12`,
    [tenantId],
  ).catch(() => [] as RowDataPacket[]);
  return rows.map((row) => locationSummaryFromLocation(row, tenantSlug));
}

async function publicLocationSummary(
  tenantId: number,
  tenantSlug: string,
  locationId: number,
  locationSlug = "",
): Promise<LocationSummary | null> {
  if (tenantId <= 0) return null;

  if (await tableExists("tenant_directory_locations")) {
    const where = locationId > 0 ? "location_id=?" : "location_slug=?";
    const value = locationId > 0 ? locationId : locationSlug;
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT location_id,location_slug,location_name,city,province,address,phone,email,booking_url,booking_enabled
         FROM \`tenant_directory_locations\`
        WHERE tenant_id=?
          AND ${where}
          AND COALESCE(is_visible,1)=1
          AND COALESCE(status,'published')='published'
          AND COALESCE(marketplace_enabled,1)=1
     ORDER BY sort_order ASC, location_name ASC
        LIMIT 1`,
      [tenantId, value],
    ).catch(() => [] as RowDataPacket[]);
    if (rows[0]) return locationSummaryFromDirectory(rows[0], tenantSlug);
  }

  const where = locationId > 0 ? "id=?" : "LOWER(REPLACE(COALESCE(name,''),' ','-'))=?";
  const value = locationId > 0 ? locationId : normalizeSlug(locationSlug);
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT id,name,address,legal_city,legal_province,phone,email,booking_enabled
       FROM \`locations\`
      WHERE tenant_id=?
        AND ${where}
        AND COALESCE(is_active,1)=1
        AND COALESCE(marketplace_enabled,1)=1
      LIMIT 1`,
    [tenantId, value],
  ).catch(() => [] as RowDataPacket[]);
  return rows[0] ? locationSummaryFromLocation(rows[0], tenantSlug) : null;
}

function locationSummaryFromDirectory(row: RowDataPacket, tenantSlug: string): LocationSummary {
  const locationId = Number(row.location_id ?? 0);
  return {
    locationId,
    locationSlug: clean(row.location_slug ?? "", 120),
    locationName: clean(row.location_name ?? "", 190) || "Sede principale",
    city: clean(row.city ?? "", 120),
    province: clean(row.province ?? "", 80),
    address: clean(row.address ?? "", 255),
    phone: clean(row.phone ?? "", 50),
    email: clean(row.email ?? "", 190),
    bookingUrl: clean(row.booking_url ?? "", 255) || `/${tenantSlug}/booking?start=1&location_id=${locationId}`,
    bookingEnabled: Number(row.booking_enabled ?? 1) === 1,
  };
}

function locationSummaryFromLocation(row: RowDataPacket, tenantSlug: string): LocationSummary {
  const locationId = Number(row.id ?? 0);
  const locationName = clean(row.name ?? "", 190) || "Sede principale";
  return {
    locationId,
    locationSlug: normalizeSlug(locationName),
    locationName,
    city: clean(row.legal_city ?? "", 120),
    province: clean(row.legal_province ?? "", 80),
    address: clean(row.address ?? "", 255),
    phone: clean(row.phone ?? "", 50),
    email: clean(row.email ?? "", 190),
    bookingUrl: `/${tenantSlug}/booking?start=1&location_id=${locationId}`,
    bookingEnabled: Number(row.booking_enabled ?? 1) === 1,
  };
}

async function tenantClientExists(tenantSlug: string, clientId: number): Promise<boolean | null> {
  if (!tenantSlug || clientId <= 0) return false;
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug: tenantSlug,
      table: "clients",
      columns: "id",
      where: "id = ?",
      params: [clientId],
      limit: 1,
    });
    return rows.length > 0;
  } catch {
    return null;
  }
}

async function syncPublicCustomerPasswordToTenantUsers(accountId: number, passwordHash: string): Promise<void> {
  if (accountId <= 0 || !passwordHash) return;
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT l.booking_user_id, t.slug
       FROM \`public_customer_tenant_links\` l
       JOIN \`saas_tenants\` t ON t.id=l.tenant_id
      WHERE l.account_id=? AND l.booking_user_id IS NOT NULL AND l.booking_user_id > 0`,
    [accountId],
  ).catch(() => [] as RowDataPacket[]);

  for (const row of rows) {
    const slug = normalizeSlug(row.slug);
    const id = Number(row.booking_user_id ?? 0);
    if (!slug || id <= 0) continue;
    await tenantUpdate({ slug, table: "booking_users", id, values: { password_hash: passwordHash } }).catch(() => 0);
  }
}

async function syncPublicCustomerEmailToTenantRecords(accountId: number, oldEmail: string, newEmail: string): Promise<void> {
  if (accountId <= 0 || !newEmail) return;
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT l.client_id,l.booking_user_id,t.slug
       FROM \`public_customer_tenant_links\` l
       JOIN \`saas_tenants\` t ON t.id=l.tenant_id
      WHERE l.account_id=?`,
    [accountId],
  ).catch(() => [] as RowDataPacket[]);

  for (const row of rows) {
    const slug = normalizeSlug(row.slug);
    if (!slug) continue;

    const bookingUserId = Number(row.booking_user_id ?? 0);
    if (bookingUserId > 0) {
      await tenantUpdate({ slug, table: "booking_users", id: bookingUserId, values: { email: newEmail } }).catch(() => 0);
    }

    const clientId = Number(row.client_id ?? 0);
    if (clientId > 0) {
      await updateTenantClientEmail(slug, clientId, oldEmail, newEmail);
    }
  }
}

async function updateTenantClientEmail(slug: string, clientId: number, oldEmail: string, newEmail: string): Promise<void> {
  try {
    const table = await tenantTable(slug, "clients");
    const clauses = ["id = ?"];
    const params: unknown[] = [newEmail, clientId];
    if (oldEmail) {
      clauses.push("(email IS NULL OR email = '' OR LOWER(email) = ?)");
      params.push(oldEmail);
    } else {
      clauses.push("(email IS NULL OR email = '')");
    }
    if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
      clauses.push("tenant_id = ?");
      params.push(table.tenantId ?? 0);
    }
    await dbExecute(`UPDATE ${quoteIdentifier(table.name)} SET email=? WHERE ${clauses.join(" AND ")}`, params);
  } catch {
  }
}

async function addColumnIfMissing(table: string, column: string, definition: string): Promise<void> {
  if (await columnExists(table, column)) return;
  await dbExecute(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${definition}`).catch(() => undefined);
}

async function verifyPhpPassword(password: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  if (hash.startsWith("$2y$")) return bcrypt.compare(password, `$2a$${hash.slice(4)}`);
  if (hash.startsWith("$2a$") || hash.startsWith("$2b$")) return bcrypt.compare(password, hash);
  return false;
}

function globalFavoriteKey(tenantSlug: string, locationId: number): string {
  return `${normalizeSlug(tenantSlug)}:${Math.max(0, Number(locationId) || 0)}`;
}

function normalizeEmail(email: unknown): string {
  return String(email ?? "").trim().toLowerCase();
}

function normalizeSlug(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function clean(value: unknown, max = 0): string {
  const normalized = String(value ?? "").trim().replace(/\s+/g, " ");
  return max > 0 ? normalized.slice(0, max) : normalized;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateCode(): string {
  return String(crypto.randomInt(100000, 1000000));
}

function codeHash(code: string): string {
  return sha256(code.replace(/\s+/g, "").trim());
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function futureDate(value: string | Date | null | undefined): boolean {
  if (!value) return false;
  const date = value instanceof Date ? value : new Date(String(value).replace(" ", "T"));
  return Number.isFinite(date.getTime()) && date.getTime() > Date.now();
}

function dateString(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return mysqlDate(value);
  return String(value);
}

function mysqlDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function exposeLocalDebug(): boolean {
  // HARD-GUARD: in produzione MAI, nemmeno via env — devCode/devToken nelle
  // risposte JSON permetterebbero il takeover degli account cliente.
  if (process.env.NODE_ENV === "production") return false;
  return true;
}

function firstNameFromFullName(fullName: string): string {
  return clean(fullName, 190).split(" ")[0] ?? "";
}

function lastNameFromFullName(fullName: string): string {
  const parts = clean(fullName, 190).split(" ");
  return parts.slice(1).join(" ");
}
