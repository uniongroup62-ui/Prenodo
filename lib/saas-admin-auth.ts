import "server-only";

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import type { RowDataPacket } from "@/lib/tenant-db";
import { dbExecute, dbQuery, quoteIdentifier, tableExists, columnExists } from "@/lib/tenant-db";
import { consumeBackupCode, sha256, verifyTotp } from "@/lib/saas-admin-security";

export type SaasAdminRole = "owner" | "admin" | "viewer";

export type SaasAdminUser = {
  id: number;
  name: string;
  email: string;
  role: SaasAdminRole;
  isActive: boolean;
  lastLoginAt: string | null;
};

export type SaasAdminSession = {
  user: SaasAdminUser;
  issuedAt: number;
};

type SaasAdminRow = RowDataPacket & {
  id: number;
  name: string;
  email: string;
  password_hash?: string;
  role?: string;
  is_active?: number;
  last_login_at?: string | Date | null;
};

type LoginResult =
  | { ok: true; session: SaasAdminSession }
  | { ok: true; needsTotp: true; challenge: string }
  | { ok: false; error: string };

const SESSION_TTL_SECONDS = 60 * 60 * 12;
const LOGIN_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const LOGIN_RATE_LIMIT_MAX_FAILURES = 10;

// Memo per processo (Fase A pannello, 2026-07-19): stesse ragioni di
// ensureSaasTenantSchema — l'ensure non deve ripetersi a ogni richiesta.
let authSchemaEnsured = false;

export async function ensureSaasAuthSchema(): Promise<void> {
  if (authSchemaEnsured) return;
  if (!(await tableExists("saas_admins"))) {
    await dbExecute(
      `CREATE TABLE IF NOT EXISTS \`saas_admins\` (
      \`id\` INT(11) NOT NULL AUTO_INCREMENT,
      \`name\` VARCHAR(120) NOT NULL,
      \`email\` VARCHAR(190) NOT NULL,
      \`password_hash\` VARCHAR(255) NOT NULL,
      \`role\` ENUM('owner','admin','viewer') NOT NULL DEFAULT 'admin',
      \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
      \`last_login_at\` DATETIME NULL DEFAULT NULL,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_saas_admins_email\` (\`email\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    );
  }

  if (!(await tableExists("saas_tenants"))) {
    await dbExecute(
      `CREATE TABLE IF NOT EXISTS \`saas_tenants\` (
      \`id\` INT(11) NOT NULL AUTO_INCREMENT,
      \`slug\` VARCHAR(80) NOT NULL,
      \`name\` VARCHAR(190) NOT NULL,
      \`db_prefix\` VARCHAR(90) NOT NULL,
      \`is_active\` TINYINT(1) NOT NULL DEFAULT 1,
      \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_saas_tenants_slug\` (\`slug\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    );
  }

  if (!(await tableExists("saas_admin_login_attempts"))) {
    await dbExecute(
      `CREATE TABLE IF NOT EXISTS \`saas_admin_login_attempts\` (
      \`id\` INT(11) NOT NULL AUTO_INCREMENT,
      \`email\` VARCHAR(190) NULL DEFAULT NULL,
      \`ip\` VARCHAR(45) NULL DEFAULT NULL,
      \`attempted_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`success\` TINYINT(1) NOT NULL DEFAULT 0,
      PRIMARY KEY (\`id\`),
      KEY \`idx_email_time\` (\`email\`, \`attempted_at\`),
      KEY \`idx_ip_time\` (\`ip\`, \`attempted_at\`),
      KEY \`idx_success_time\` (\`success\`, \`attempted_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
    );
  }

  // Sessioni admin SERVER-SIDE (Fase 1 blindatura): revoca vera al logout,
  // lista sessioni attive, revoca remota. NB: DDL in dialetto POSTGRES —
  // toPostgresSql traduce solo backtick/placeholder, non il DDL MySQL.
  if (!(await tableExists("saas_admin_sessions"))) {
    await dbExecute(
      `CREATE TABLE IF NOT EXISTS "saas_admin_sessions" (
      "id" SERIAL PRIMARY KEY,
      "admin_id" INTEGER NOT NULL,
      "token_hash" CHAR(64) NOT NULL,
      "ip" VARCHAR(45) NULL DEFAULT NULL,
      "user_agent" VARCHAR(255) NULL DEFAULT NULL,
      "created_at" TIMESTAMP NOT NULL,
      "last_seen_at" TIMESTAMP NULL DEFAULT NULL,
      "expires_at" TIMESTAMP NOT NULL,
      "revoked_at" TIMESTAMP NULL DEFAULT NULL,
      CONSTRAINT "uq_saas_admin_sessions_token" UNIQUE ("token_hash")
    )`,
    );
    await dbExecute(`CREATE INDEX IF NOT EXISTS "idx_saas_admin_sessions_admin" ON "saas_admin_sessions" ("admin_id", "expires_at")`).catch(() => undefined);
  }

  // Audit delle AZIONI mutative admin (chi/cosa/quando/IP, wall-time Roma).
  if (!(await tableExists("saas_admin_audit"))) {
    await dbExecute(
      `CREATE TABLE IF NOT EXISTS "saas_admin_audit" (
      "id" SERIAL PRIMARY KEY,
      "admin_id" INTEGER NOT NULL,
      "admin_email" VARCHAR(190) NOT NULL,
      "action" VARCHAR(80) NOT NULL,
      "target" VARCHAR(190) NULL DEFAULT NULL,
      "details" VARCHAR(500) NULL DEFAULT NULL,
      "ip" VARCHAR(45) NULL DEFAULT NULL,
      "created_at" TIMESTAMP NOT NULL
    )`,
    );
    await dbExecute(`CREATE INDEX IF NOT EXISTS "idx_saas_admin_audit_admin" ON "saas_admin_audit" ("admin_id", "created_at")`).catch(() => undefined);
  }

  await addColumnIfMissing("saas_admins", "role", "`role` ENUM('owner','admin','viewer') NOT NULL DEFAULT 'admin' AFTER `password_hash`");
  await addColumnIfMissing("saas_admins", "is_active", "`is_active` TINYINT(1) NOT NULL DEFAULT 1 AFTER `role`");
  await addColumnIfMissing("saas_admins", "last_login_at", "`last_login_at` DATETIME NULL DEFAULT NULL AFTER `is_active`");
  await addColumnIfMissing("saas_admins", "updated_at", "`updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`");
  // 2FA TOTP (Fase 1): secret confermato, secret in attesa di conferma,
  // codici di backup one-time (sha256 JSON).
  await addColumnIfMissing("saas_admins", "totp_secret", "`totp_secret` VARCHAR(64) NULL DEFAULT NULL");
  await addColumnIfMissing("saas_admins", "totp_pending_secret", "`totp_pending_secret` VARCHAR(64) NULL DEFAULT NULL");
  await addColumnIfMissing("saas_admins", "totp_backup_codes", "`totp_backup_codes` TEXT NULL DEFAULT NULL");
  authSchemaEnsured = true;
}

export async function isSaasBootstrapped(): Promise<boolean> {
  await ensureSaasAuthSchema();
  const rows = await dbQuery<RowDataPacket[]>("SELECT COUNT(*) AS count FROM `saas_admins`");
  return Number(rows[0]?.count ?? 0) > 0;
}

export async function bootstrapSaasAdmin(input: { name: string; email: string; password: string }): Promise<SaasAdminSession> {
  await ensureSaasAuthSchema();
  if (await isSaasBootstrapped()) throw new Error("Admin SaaS gia configurato.");

  const name = input.name.trim() || "Admin";
  const email = normalizeEmail(input.email);
  const password = input.password;
  if (!email || !password) throw new Error("Email e password obbligatorie.");

  const hash = await bcrypt.hash(password, 10);
  const result = await dbExecute(
    "INSERT INTO `saas_admins`(name,email,password_hash,role,is_active) VALUES(?,?,?,?,1)",
    [name, email, hash, "owner"],
  );
  const user = await requireSaasAdminById(result.insertId);
  return { user, issuedAt: Date.now() };
}

export async function loginSaasAdmin(input: { email: string; password: string; ip: string }): Promise<LoginResult> {
  await ensureSaasAuthSchema();
  const email = normalizeEmail(input.email);
  const password = input.password;
  if (!email || !password) return { ok: false, error: "Email e password obbligatorie." };

  if (await isRateLimited(email, input.ip)) {
    return { ok: false, error: "Troppi tentativi di login. Riprova tra qualche minuto." };
  }

  const rows = await dbQuery<SaasAdminRow[]>("SELECT * FROM `saas_admins` WHERE email=? LIMIT 1", [email]);
  const row = rows[0];
  if (!row) {
    await recordLoginAttempt(email, input.ip, false);
    return { ok: false, error: "Credenziali non valide." };
  }
  if (Number(row.is_active ?? 1) !== 1) {
    await recordLoginAttempt(email, input.ip, false);
    return { ok: false, error: "Account admin disattivato." };
  }
  if (!await verifyPhpPassword(password, String(row.password_hash ?? ""))) {
    await recordLoginAttempt(email, input.ip, false);
    return { ok: false, error: "Credenziali non valide." };
  }

  // 2FA attivo: la password da sola NON basta — si emette una challenge
  // firmata a vita breve (5 min) e il login si completa col codice TOTP
  // (o un codice di backup) in verifyTotpLogin.
  if (String((row as SaasAdminRow & { totp_secret?: string | null }).totp_secret ?? "").trim() !== "") {
    return { ok: true, needsTotp: true, challenge: signTotpChallenge(Number(row.id)) };
  }

  await recordLoginAttempt(email, input.ip, true);
  await dbExecute("UPDATE `saas_admins` SET last_login_at=NOW() WHERE id=? LIMIT 1", [Number(row.id)]).catch(() => undefined);
  return { ok: true, session: { user: adminRowToUser(row), issuedAt: Date.now() } };
}

// Completa il login 2FA: challenge firmata + codice TOTP (finestra ±1) o un
// codice di BACKUP one-time.
export async function verifyTotpLogin(input: { challenge: string; code: string; ip: string }): Promise<LoginResult> {
  const adminId = readTotpChallenge(input.challenge);
  if (!adminId) return { ok: false, error: "Verifica scaduta. Ripeti il login." };
  const rows = await dbQuery<SaasAdminRow[]>("SELECT * FROM `saas_admins` WHERE id=? LIMIT 1", [adminId]);
  const row = rows[0] as (SaasAdminRow & { totp_secret?: string | null; totp_backup_codes?: string | null }) | undefined;
  if (!row || Number(row.is_active ?? 1) !== 1) return { ok: false, error: "Account admin non valido." };
  const secret = String(row.totp_secret ?? "").trim();
  if (!secret) return { ok: false, error: "2FA non attiva per questo account." };

  const email = String(row.email ?? "");
  if (await isRateLimited(email, input.ip)) {
    return { ok: false, error: "Troppi tentativi di login. Riprova tra qualche minuto." };
  }

  let valid = verifyTotp(secret, input.code);
  if (!valid) {
    const backup = consumeBackupCode(String(row.totp_backup_codes ?? "[]"), input.code);
    if (backup.ok) {
      valid = true;
      await dbExecute("UPDATE `saas_admins` SET totp_backup_codes=? WHERE id=?", [backup.remaining, adminId]).catch(() => undefined);
    }
  }
  if (!valid) {
    await recordLoginAttempt(email, input.ip, false);
    return { ok: false, error: "Codice 2FA non valido." };
  }

  await recordLoginAttempt(email, input.ip, true);
  await dbExecute("UPDATE `saas_admins` SET last_login_at=NOW() WHERE id=? LIMIT 1", [adminId]).catch(() => undefined);
  return { ok: true, session: { user: adminRowToUser(row), issuedAt: Date.now() } };
}

// Sessione SERVER-SIDE (Fase 1 blindatura): il cookie porta un token OPACO,
// la verità sta in saas_admin_sessions — logout/revoca invalidano davvero.
export async function setSaasAdminSessionCookie(
  session: SaasAdminSession,
  request?: Request,
): Promise<void> {
  const token = crypto.randomBytes(32).toString("hex");
  const fwd = request?.headers.get("x-forwarded-for") ?? "";
  const ip = fwd.split(",")[0]?.trim() || request?.headers.get("x-real-ip") || "";
  const userAgent = (request?.headers.get("user-agent") ?? "").slice(0, 255);
  await dbExecute(
    "INSERT INTO `saas_admin_sessions`(admin_id,token_hash,ip,user_agent,created_at,last_seen_at,expires_at) VALUES(?,?,?,?,?,?,?)",
    [
      session.user.id,
      sha256(token),
      ip || null,
      userAgent || null,
      mysqlDate(new Date()),
      mysqlDate(new Date()),
      mysqlDate(new Date(Date.now() + SESSION_TTL_SECONDS * 1000)),
    ],
  );
  // Pulizia opportunistica delle sessioni scadute.
  await dbExecute("DELETE FROM `saas_admin_sessions` WHERE expires_at < ?", [mysqlDate(new Date())]).catch(() => undefined);

  const cookieStore = await cookies();
  cookieStore.set(saasSessionCookieName(), token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function clearSaasAdminSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(saasSessionCookieName())?.value ?? "";
  if (token) {
    // Revoca SERVER-SIDE: il token smette di valere anche se il cookie
    // sopravvive altrove (furto/copia).
    await dbExecute("UPDATE `saas_admin_sessions` SET revoked_at=? WHERE token_hash=?", [mysqlDate(new Date()), sha256(token)]).catch(() => undefined);
  }
  cookieStore.delete(saasSessionCookieName());
}

export async function currentSaasAdminSession(): Promise<SaasAdminSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(saasSessionCookieName())?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;

  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT s.admin_id, s.created_at
       FROM \`saas_admin_sessions\` s
      WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at >= ?
      LIMIT 1`,
    [sha256(token), mysqlDate(new Date())],
  ).catch(() => []);
  const sessionRow = rows[0];
  if (!sessionRow) return null;

  try {
    const user = await requireSaasAdminById(Number(sessionRow.admin_id));
    if (!user.isActive) return null;
    await dbExecute("UPDATE `saas_admin_sessions` SET last_seen_at=? WHERE token_hash=?", [mysqlDate(new Date()), sha256(token)]).catch(() => undefined);
    const created = sessionRow.created_at instanceof Date ? sessionRow.created_at.getTime() : new Date(String(sessionRow.created_at).replace(" ", "T")).getTime();
    return { user, issuedAt: Number.isFinite(created) ? created : Date.now() };
  } catch {
    return null;
  }
}

// Lista sessioni attive (proprie; l'owner vede tutte) + revoca puntuale.
export async function listSaasAdminSessions(user: SaasAdminUser): Promise<Array<Record<string, unknown>>> {
  const all = user.role === "owner";
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT s.id, s.admin_id, a.email AS admin_email, s.ip, s.user_agent, s.created_at, s.last_seen_at, s.expires_at
       FROM \`saas_admin_sessions\` s
       JOIN \`saas_admins\` a ON a.id = s.admin_id
      WHERE s.revoked_at IS NULL AND s.expires_at >= ?${all ? "" : " AND s.admin_id = ?"}
      ORDER BY s.last_seen_at DESC NULLS LAST
      LIMIT 50`,
    all ? [mysqlDate(new Date())] : [mysqlDate(new Date()), user.id],
  ).catch(() => []);
  return rows.map((row) => ({
    id: Number(row.id),
    adminId: Number(row.admin_id),
    adminEmail: String(row.admin_email ?? ""),
    ip: String(row.ip ?? ""),
    userAgent: String(row.user_agent ?? ""),
    createdAt: dateString(row.created_at as string | Date | null),
    lastSeenAt: dateString(row.last_seen_at as string | Date | null),
  }));
}

export async function revokeSaasAdminSessionById(user: SaasAdminUser, sessionId: number): Promise<boolean> {
  if (sessionId <= 0) return false;
  const clause = user.role === "owner" ? "" : " AND admin_id = ?";
  const params: unknown[] = [mysqlDate(new Date()), sessionId];
  if (user.role !== "owner") params.push(user.id);
  const result = await dbExecute(
    `UPDATE \`saas_admin_sessions\` SET revoked_at=? WHERE id=? AND revoked_at IS NULL${clause}`,
    params,
  );
  return Number(result.affectedRows ?? 0) > 0;
}

export async function requireSaasAdminSession(): Promise<SaasAdminSession> {
  const session = await currentSaasAdminSession();
  if (!session) throw new Error("Accesso admin richiesto.");
  return session;
}

export function canManageSaasTenants(user: SaasAdminUser | null | undefined): boolean {
  return user?.role === "owner" || user?.role === "admin";
}

export function canManageSaasAdmins(user: SaasAdminUser | null | undefined): boolean {
  return user?.role === "owner";
}

// Cookie dedicato: __Host- in produzione (Secure, path=/, niente Domain =
// legato SOLO all'host del pannello), nome semplice in dev (http).
export function saasSessionCookieName(): string {
  return process.env.NODE_ENV === "production" ? "__Host-prenodo_admin" : "prenodo_admin_session";
}

// --- 2FA TOTP: setup/conferma/disattivazione -------------------------------

export async function startTotpSetup(adminId: number): Promise<{ secret: string }> {
  const { generateTotpSecret } = await import("@/lib/saas-admin-security");
  const secret = generateTotpSecret();
  await dbExecute("UPDATE `saas_admins` SET totp_pending_secret=? WHERE id=?", [secret, adminId]);
  return { secret };
}

export async function confirmTotpSetup(adminId: number, code: string): Promise<{ ok: true; backupCodes: string[] } | { ok: false; error: string }> {
  const rows = await dbQuery<RowDataPacket[]>("SELECT totp_pending_secret FROM `saas_admins` WHERE id=? LIMIT 1", [adminId]);
  const pending = String(rows[0]?.totp_pending_secret ?? "").trim();
  if (!pending) return { ok: false, error: "Nessuna configurazione 2FA in corso." };
  if (!verifyTotp(pending, code)) return { ok: false, error: "Codice non valido: controlla l'app authenticator." };
  const { generateBackupCodes } = await import("@/lib/saas-admin-security");
  const codes = generateBackupCodes();
  await dbExecute(
    "UPDATE `saas_admins` SET totp_secret=?, totp_pending_secret=NULL, totp_backup_codes=? WHERE id=?",
    [pending, JSON.stringify(codes.hashed), adminId],
  );
  return { ok: true, backupCodes: codes.plain };
}

export async function disableTotp(adminId: number, password: string, code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const rows = await dbQuery<SaasAdminRow[]>("SELECT * FROM `saas_admins` WHERE id=? LIMIT 1", [adminId]);
  const row = rows[0] as (SaasAdminRow & { totp_secret?: string | null; totp_backup_codes?: string | null }) | undefined;
  if (!row) return { ok: false, error: "Admin non trovato." };
  if (!await verifyPhpPassword(password, String(row.password_hash ?? ""))) return { ok: false, error: "Password non corretta." };
  const secret = String(row.totp_secret ?? "").trim();
  if (!secret) return { ok: false, error: "2FA non attiva." };
  let valid = verifyTotp(secret, code);
  if (!valid) {
    const backup = consumeBackupCode(String(row.totp_backup_codes ?? "[]"), code);
    valid = backup.ok;
  }
  if (!valid) return { ok: false, error: "Codice 2FA non valido." };
  await dbExecute("UPDATE `saas_admins` SET totp_secret=NULL, totp_pending_secret=NULL, totp_backup_codes=NULL WHERE id=?", [adminId]);
  return { ok: true };
}

export async function saasAdminTotpEnabled(adminId: number): Promise<boolean> {
  const rows = await dbQuery<RowDataPacket[]>("SELECT totp_secret FROM `saas_admins` WHERE id=? LIMIT 1", [adminId]);
  return String(rows[0]?.totp_secret ?? "").trim() !== "";
}

async function requireSaasAdminById(id: number): Promise<SaasAdminUser> {
  if (id <= 0) throw new Error("Admin SaaS non valido.");
  const rows = await dbQuery<SaasAdminRow[]>("SELECT * FROM `saas_admins` WHERE id=? LIMIT 1", [id]);
  const row = rows[0];
  if (!row) throw new Error("Admin SaaS non trovato.");
  return adminRowToUser(row);
}

async function isRateLimited(email: string, ip: string): Promise<boolean> {
  const identityClauses = [];
  const params: unknown[] = [LOGIN_RATE_LIMIT_WINDOW_SECONDS];
  if (email) {
    identityClauses.push("email = ?");
    params.push(email);
  }
  if (ip) {
    identityClauses.push("ip = ?");
    params.push(ip);
  }
  if (!identityClauses.length) return false;

  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT COUNT(*) AS count
       FROM \`saas_admin_login_attempts\`
      WHERE success=0
        AND attempted_at >= (NOW() - (? * interval '1 second'))
        AND (${identityClauses.join(" OR ")})`,
    params,
  ).catch(() => []);
  return Number(rows[0]?.count ?? 0) >= LOGIN_RATE_LIMIT_MAX_FAILURES;
}

async function recordLoginAttempt(email: string, ip: string, success: boolean): Promise<void> {
  await dbExecute(
    "INSERT INTO `saas_admin_login_attempts`(email,ip,attempted_at,success) VALUES(?,?,NOW(),?)",
    [email || null, ip || null, success ? 1 : 0],
  ).catch(() => undefined);
}

async function addColumnIfMissing(table: string, column: string, definition: string): Promise<void> {
  if (await columnExists(table, column)) return;
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1",
    [table, column],
  );
  if (rows.length > 0) return;
  await dbExecute(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${definition}`).catch(() => undefined);
}

async function verifyPhpPassword(password: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  if (hash.startsWith("$2y$")) return bcrypt.compare(password, `$2a$${hash.slice(4)}`);
  if (hash.startsWith("$2a$") || hash.startsWith("$2b$")) return bcrypt.compare(password, hash);
  return false;
}

function adminRowToUser(row: SaasAdminRow): SaasAdminUser {
  const role = normalizeRole(String(row.role ?? "admin"));
  return {
    id: Number(row.id ?? 0),
    name: String(row.name ?? ""),
    email: String(row.email ?? ""),
    role,
    isActive: Number(row.is_active ?? 1) === 1,
    lastLoginAt: dateString(row.last_login_at),
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeRole(role: string): SaasAdminRole {
  return role === "owner" || role === "viewer" ? role : "admin";
}

function dateString(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return mysqlDate(value);
  return String(value);
}

// Challenge 2FA firmata (vita 5 min): tiene l'adminId fra il passo password e
// il passo codice senza stato server.
function signTotpChallenge(adminId: number): string {
  const payload = Buffer.from(JSON.stringify({ adminId, exp: Date.now() + 5 * 60000 }), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", sessionSecret()).update(`totp:${payload}`).digest("base64url");
  return `${payload}.${signature}`;
}

function readTotpChallenge(value: string): number {
  const [payload, signature] = String(value ?? "").split(".");
  if (!payload || !signature) return 0;
  const expected = crypto.createHmac("sha256", sessionSecret()).update(`totp:${payload}`).digest("base64url");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return 0;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { adminId?: number; exp?: number };
    if (!parsed.exp || Date.now() > parsed.exp) return 0;
    return Number(parsed.adminId ?? 0);
  } catch {
    return 0;
  }
}

// Segreto DEDICATO del pannello (Fase 1 blindatura 2026-07-18): mai condiviso
// col gestionale/tenant e MAI un fallback hardcoded in produzione — chi
// compromette il segreto dei tenant non deve poter forgiare sessioni admin.
function sessionSecret(): string {
  const dedicated = String(process.env.ADMIN_SESSION_SECRET ?? "").trim();
  if (dedicated) return dedicated;
  if (process.env.NODE_ENV === "production") {
    throw new Error("ADMIN_SESSION_SECRET mancante: configura un segreto dedicato per il pannello admin.");
  }
  return `${process.env.PRENODO_SESSION_SECRET || "prenodo-local-session-secret"}::admin-dev`;
}

function mysqlDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
