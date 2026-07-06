import "server-only";

import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { RowDataPacket } from "@/lib/tenant-db";
import { dbExecute, dbQuery, tenantSelect, tenantTable, columnExists, tableExists, tenantIdForSlug } from "@/lib/tenant-db";
import { normalizeTenantSlug } from "@/lib/tenant-runtime";
import { buildModernEmailTemplate, emailConfigured, sendEmail } from "@/lib/email";

const TOKEN_TTL_MINUTES = 60;
const MIN_PASSWORD_ADMIN = 8;
const RESET_TYPE_ADMIN = "admin";
const GENERIC_RESET_MESSAGE = "Se l'email esiste, riceverai un link per reimpostare la password entro pochi minuti.";

export type PasswordResetRequestResult = {
  ok: true;
  sent: boolean;
  message: string;
  resetUrl?: string;
};

export type PasswordResetInfo = {
  resetId: number;
  userType: string;
  userId: number;
  email: string;
  expiresAt: string;
};

// Per-tenant business branding used to brand the staff reset email, mirroring the
// legacy PasswordReset::request() which read setting_get('name')/setting_get('email')
// (the businesses row). Like the cron routes, we resolve the tenant_id from the slug
// and read the first businesses row (ORDER BY id ASC LIMIT 1). All fields are
// best-effort: missing branding just means the template renders its default brand.
type ManageResetBranding = {
  name: string;
  email: string;
  logoUrl: string;
};

async function manageResetBranding(slug: string): Promise<ManageResetBranding> {
  const empty: ManageResetBranding = { name: "", email: "", logoUrl: "" };
  try {
    const tenantId = await tenantIdForSlug(slug);
    if (!tenantId || !(await tableExists("businesses"))) return empty;
    const hasLogo = await columnExists("businesses", "logo_path");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT name, email${hasLogo ? ", logo_path" : ""} FROM businesses WHERE tenant_id = ? ORDER BY id ASC LIMIT 1`,
      [tenantId],
    ).catch(() => [] as RowDataPacket[]);
    const row = rows[0];
    if (!row) return empty;
    return {
      name: String(row.name ?? ""),
      email: String(row.email ?? ""),
      logoUrl: hasLogo ? resolveLogoUrl(String(row.logo_path ?? "")) : "",
    };
  } catch {
    return empty;
  }
}

// Turn a stored logo_path into an absolute URL for the email. If it is already an
// absolute http(s) URL use it as-is; if it is a public path (e.g. /uploads/...)
// prefix it with PRENODO_PUBLIC_BASE_URL. Otherwise omit it — the email template
// falls back to rendering the brand name, identical to the no-logo PHP path.
function resolveLogoUrl(logoPath: string): string {
  const path = logoPath.trim();
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const base = String(process.env.PRENODO_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base || !path.startsWith("/")) return "";
  return `${base}${path}`;
}

// Port of PasswordReset::request()'s admin/"Gestionale" reset email body: an h3
// title, a short intro, the "Reimposta password" button, the expiry note and the
// "ignore if it wasn't you" line. Subject is "<biz> — Reimposta la password (Gestionale)".
function buildManageResetEmailBody(resetUrl: string): string {
  const title = "Reimposta la password — Gestionale";
  return (
    `<h3 style="margin:0 0 12px 0">${escapeHtml(title)}</h3>`
    + '<p style="margin:0 0 12px 0">Hai richiesto la reimpostazione della password. Premi il pulsante qui sotto:</p>'
    + `<p style="margin:16px 0"><a href="${escapeHtml(resetUrl)}" style="display:inline-block;background:#0d6efd;color:#fff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:800">Reimposta password</a></p>`
    + `<p style="margin:0 0 10px 0;color:#6b7280">Il link scade tra ${TOKEN_TTL_MINUTES} minuti.</p>`
    + '<p style="margin:12px 0 0 0;color:#6b7280">Se non sei stato tu, ignora questa email.</p>'
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Sends the staff/business-user reset email, branded per-tenant (from the businesses
// row), through SES. Gated on emailConfigured(): when SES is unconfigured this is a
// no-op so local dev keeps working (the caller still stored the token hash and may
// expose the reset URL via PRENODO_EXPOSE_RESET_LINK). Send errors are logged and
// swallowed — delivery is a best-effort side-effect that must never fail the
// (deliberately generic) forgot-password response; the user can re-request a link.
async function sendManageResetEmail(slug: string, recipient: string, resetUrl: string): Promise<void> {
  if (!emailConfigured()) return;
  const to = recipient.trim();
  if (!to) return;
  try {
    const branding = await manageResetBranding(slug);
    const bizName = branding.name.trim();
    const subject = `${bizName ? `${bizName} — ` : ""}Reimposta la password (Gestionale)`;
    const { html, text } = buildModernEmailTemplate(subject, buildManageResetEmailBody(resetUrl), {
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
      console.error(`[manage-password-reset] email send failed for ${to}: ${res.error}`);
    }
  } catch (error) {
    console.error("[manage-password-reset] email send error:", error);
  }
}

export async function requestManagePasswordReset({
  slug,
  email,
  ip,
  userAgent,
  origin,
}: {
  slug: string;
  email: string;
  ip?: string;
  userAgent?: string;
  origin?: string;
}): Promise<PasswordResetRequestResult> {
  const tenantSlug = normalizeTenantSlug(slug) ?? "";
  const normalizedEmail = email.trim().toLowerCase();
  if (!tenantSlug) throw new Error("URL attivita mancante.");
  if (!isValidEmail(normalizedEmail)) throw new Error("Email non valida.");

  await ensurePasswordResetsTable(tenantSlug);
  await cleanupPasswordResets(tenantSlug);

  const generic = genericResetResult();
  const users = await tenantSelect<RowDataPacket>({
    slug: tenantSlug,
    table: "users",
    columns: "id,email",
    where: "LOWER(email) = ?",
    params: [normalizedEmail],
    limit: 1,
  }).catch(() => []);
  const user = users[0];
  const userId = Number(user?.id ?? 0);
  if (userId <= 0) return generic;

  if (await hasRecentResetRequest(tenantSlug, userId)) {
    return { ...generic, sent: true };
  }

  await invalidatePendingResets(tenantSlug, userId);

  const token = randomBytes(32).toString("hex");
  const table = await ensurePasswordResetsTable(tenantSlug);
  await dbExecute(
    `INSERT INTO \`${table.name}\` (${[
      table.mode === "shared" && table.tenantId && await columnExists(table.name, "tenant_id") ? "`tenant_id`" : "",
      "`user_type`",
      "`user_id`",
      "`email`",
      "`token_hash`",
      "`expires_at`",
      "`request_ip`",
      "`user_agent`",
    ].filter(Boolean).join(",")}) VALUES (${[
      table.mode === "shared" && table.tenantId && await columnExists(table.name, "tenant_id") ? "?" : "",
      "?",
      "?",
      "?",
      "?",
      `NOW() + (${TOKEN_TTL_MINUTES} * interval '1 minute')`,
      "?",
      "?",
    ].filter(Boolean).join(",")})`,
    [
      ...(table.mode === "shared" && table.tenantId && await columnExists(table.name, "tenant_id") ? [table.tenantId] : []),
      RESET_TYPE_ADMIN,
      userId,
      normalizedEmail,
      tokenHash(token),
      truncate(ip ?? "", 64) || null,
      truncate(userAgent ?? "", 255) || null,
    ],
  );

  // Send the reset email AFTER the token hash is persisted so the link is valid even
  // on a transient send error. The link points at the same /manage/reset-password page
  // the legacy PasswordReset::buildResetLink() targets for the admin/"Gestionale" type.
  // Best-effort and tenant-scoped (see sendManageResetEmail); never fails this flow.
  const resetUrl = manageResetUrl(origin, tenantSlug, token);
  await sendManageResetEmail(tenantSlug, normalizedEmail, resetUrl);

  return {
    ...generic,
    sent: true,
    resetUrl: exposeResetUrl() ? resetUrl : undefined,
  };
}

export async function validateManagePasswordReset(slug: string, token: string): Promise<PasswordResetInfo | null> {
  const tenantSlug = normalizeTenantSlug(slug) ?? "";
  if (!tenantSlug || !isValidToken(token)) return null;
  await ensurePasswordResetsTable(tenantSlug);
  const table = await tenantTable(tenantSlug, "password_resets");
  const clauses = ["user_type = ?", "token_hash = ?", "used_at IS NULL", "expires_at > NOW()"];
  const params: unknown[] = [RESET_TYPE_ADMIN, tokenHash(token)];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.unshift("tenant_id = ?");
    params.unshift(table.tenantId ?? 0);
  }

  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT id,user_type,user_id,email,expires_at FROM \`${table.name}\` WHERE ${clauses.join(" AND ")} LIMIT 1`,
    params,
  ).catch(() => []);
  const row = rows[0];
  if (!row) return null;
  return {
    resetId: Number(row.id ?? 0),
    userType: String(row.user_type ?? RESET_TYPE_ADMIN),
    userId: Number(row.user_id ?? 0),
    email: String(row.email ?? ""),
    expiresAt: String(row.expires_at ?? ""),
  };
}

export async function resetManagePassword({
  slug,
  token,
  password,
}: {
  slug: string;
  token: string;
  password: string;
}): Promise<{ ok: true }> {
  if (password.length < MIN_PASSWORD_ADMIN) {
    throw new Error(`La password deve avere almeno ${MIN_PASSWORD_ADMIN} caratteri.`);
  }

  const tenantSlug = normalizeTenantSlug(slug) ?? "";
  const info = await validateManagePasswordReset(tenantSlug, token);
  if (!info) throw new Error("Link non valido o scaduto.");
  if (info.userId <= 0) throw new Error("Utente non valido.");

  const passwordHash = await bcrypt.hash(password, 10);
  const users = await tenantTable(tenantSlug, "users");
  const userClauses = ["id = ?"];
  const userParams: unknown[] = [passwordHash, info.userId];
  if (users.mode === "shared" && await columnExists(users.name, "tenant_id")) {
    userClauses.push("tenant_id = ?");
    userParams.push(users.tenantId ?? 0);
  }
  await dbExecute(`UPDATE \`${users.name}\` SET password_hash = ? WHERE ${userClauses.join(" AND ")}`, userParams);

  await markResetUsed(tenantSlug, info.resetId);
  await invalidatePendingResets(tenantSlug, info.userId);
  return { ok: true };
}

export async function changeManagePassword({
  slug,
  userId,
  currentPassword,
  newPassword,
}: {
  slug: string;
  userId: number;
  currentPassword: string;
  newPassword: string;
}): Promise<{ ok: true }> {
  const tenantSlug = normalizeTenantSlug(slug) ?? "";
  if (!tenantSlug) throw new Error("URL attivita mancante.");
  if (!currentPassword.trim()) throw new Error("Inserisci la password attuale.");
  if (newPassword.length < MIN_PASSWORD_ADMIN) {
    throw new Error(`La nuova password deve avere almeno ${MIN_PASSWORD_ADMIN} caratteri.`);
  }

  const users = await tenantSelect<RowDataPacket>({
    slug: tenantSlug,
    table: "users",
    columns: "id,password_hash",
    where: "id = ?",
    params: [userId],
    limit: 1,
  });
  const user = users[0];
  if (!user || !await verifyPhpPassword(currentPassword, String(user.password_hash ?? ""))) {
    // Flash legacy di accessibility.php (senza punto finale).
    throw new Error("Password attuale non corretta");
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const table = await tenantTable(tenantSlug, "users");
  const clauses = ["id = ?"];
  const params: unknown[] = [passwordHash, userId];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.push("tenant_id = ?");
    params.push(table.tenantId ?? 0);
  }
  await dbExecute(`UPDATE \`${table.name}\` SET password_hash = ? WHERE ${clauses.join(" AND ")}`, params);
  await invalidatePendingResets(tenantSlug, userId);
  return { ok: true };
}

export async function invalidateManagePasswordResets(slug: string, userId: number): Promise<void> {
  const tenantSlug = normalizeTenantSlug(slug) ?? "";
  if (!tenantSlug || userId <= 0) return;
  await invalidatePendingResets(tenantSlug, userId);
}

async function ensurePasswordResetsTable(slug: string): Promise<{ name: string; mode: string; tenantId: number | null }> {
  const table = await tenantTable(slug, "password_resets").catch(async () => {
    const users = await tenantTable(slug, "users");
    return {
      name: users.mode === "prefixed" ? `${users.name.replace(/users$/, "")}password_resets` : "password_resets",
      mode: users.mode,
      tenantId: users.tenantId,
    };
  });
  if (await tableExists(table.name)) return table;
  const tenantColumn = table.mode === "shared" ? "`tenant_id` INT(11) NULL DEFAULT NULL," : "";
  await dbExecute(
    `CREATE TABLE IF NOT EXISTS \`${table.name}\` (
      \`id\` INT(11) NOT NULL AUTO_INCREMENT,
      ${tenantColumn}
      \`user_type\` VARCHAR(20) NOT NULL,
      \`user_id\` INT(11) NOT NULL,
      \`email\` VARCHAR(190) NOT NULL,
      \`token_hash\` CHAR(64) NOT NULL,
      \`created_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      \`expires_at\` DATETIME NOT NULL,
      \`used_at\` DATETIME NULL DEFAULT NULL,
      \`request_ip\` VARCHAR(64) NULL DEFAULT NULL,
      \`user_agent\` VARCHAR(255) NULL DEFAULT NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_password_resets_token\` (\`token_hash\`),
      KEY \`idx_password_resets_lookup\` (\`user_type\`, \`token_hash\`),
      KEY \`idx_password_resets_user\` (\`user_type\`, \`user_id\`),
      KEY \`idx_password_resets_exp\` (\`expires_at\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`,
  );
  return table;
}

async function cleanupPasswordResets(slug: string): Promise<void> {
  const table = await ensurePasswordResetsTable(slug);
  const clauses = ["(used_at IS NOT NULL OR expires_at < NOW() - (7 * interval '1 day'))"];
  const params: unknown[] = [];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.unshift("tenant_id = ?");
    params.unshift(table.tenantId ?? 0);
  }
  await dbExecute(`DELETE FROM \`${table.name}\` WHERE ${clauses.join(" AND ")}`, params).catch(() => undefined);
}

async function hasRecentResetRequest(slug: string, userId: number): Promise<boolean> {
  const table = await ensurePasswordResetsTable(slug);
  const clauses = ["user_type = ?", "user_id = ?", "used_at IS NULL", "created_at > (NOW() - (2 * interval '1 minute'))"];
  const params: unknown[] = [RESET_TYPE_ADMIN, userId];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.unshift("tenant_id = ?");
    params.unshift(table.tenantId ?? 0);
  }
  const rows = await dbQuery<RowDataPacket[]>(`SELECT 1 FROM \`${table.name}\` WHERE ${clauses.join(" AND ")} LIMIT 1`, params).catch(() => []);
  return rows.length > 0;
}

async function invalidatePendingResets(slug: string, userId: number): Promise<void> {
  const table = await ensurePasswordResetsTable(slug);
  const clauses = ["user_type = ?", "user_id = ?", "used_at IS NULL"];
  const params: unknown[] = [RESET_TYPE_ADMIN, userId];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.unshift("tenant_id = ?");
    params.unshift(table.tenantId ?? 0);
  }
  await dbExecute(`UPDATE \`${table.name}\` SET used_at = NOW() WHERE ${clauses.join(" AND ")}`, params).catch(() => undefined);
}

async function markResetUsed(slug: string, resetId: number): Promise<void> {
  const table = await ensurePasswordResetsTable(slug);
  const clauses = ["id = ?"];
  const params: unknown[] = [resetId];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.push("tenant_id = ?");
    params.push(table.tenantId ?? 0);
  }
  await dbExecute(`UPDATE \`${table.name}\` SET used_at = NOW() WHERE ${clauses.join(" AND ")}`, params).catch(() => undefined);
}

function genericResetResult(): PasswordResetRequestResult {
  return { ok: true, sent: false, message: GENERIC_RESET_MESSAGE };
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isValidToken(token: string): boolean {
  return /^[a-f0-9]{64}$/i.test(token.trim());
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function verifyPhpPassword(password: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  if (hash.startsWith("$2y$")) return bcrypt.compare(password, `$2a$${hash.slice(4)}`);
  if (hash.startsWith("$2a$") || hash.startsWith("$2b$")) return bcrypt.compare(password, hash);
  return false;
}

function truncate(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function exposeResetUrl(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.PRENODO_EXPOSE_RESET_LINK === "1";
}

function manageResetUrl(origin: string | undefined, slug: string, token: string): string {
  const base = (origin || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
  return `${base}/manage/reset-password?slug=${encodeURIComponent(slug)}&token=${encodeURIComponent(token)}`;
}
