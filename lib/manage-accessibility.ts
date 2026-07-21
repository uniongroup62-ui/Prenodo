import "server-only";

import { createHash, randomInt } from "node:crypto";
import bcrypt from "bcryptjs";
import type { RowDataPacket } from "@/lib/tenant-db";
import { columnExists, dbExecute, dbQuery, tableExists, tenantIdForSlug, tenantSelect, tenantTable, withTenantTransaction } from "@/lib/tenant-db";
import { invalidateManagePasswordResets } from "@/lib/manage-password-reset";
import { normalizeTenantSlug } from "@/lib/tenant-runtime";
import { buildModernEmailTemplate, emailCodeBox, emailConfigured, maskEmail, sendEmail } from "@/lib/email";

const EMAIL_CODE_TTL_SECONDS = 15 * 60;
const EMAIL_CODE_RESEND_SECONDS = 60;
const EMAIL_CODE_MAX_ATTEMPTS = 5;

export type EmailVerificationPending = {
  id: number;
  email: string;
  expiresAt: string;
  createdAt: string;
  attemptCount: number;
  resendWaitSeconds: number;
};

export type EmailCodeResult = {
  ok: true;
  message: string;
  pending: EmailVerificationPending | null;
  verificationCode?: string;
};

export async function getEmailVerificationPending(
  slug: string,
  userId: number,
  cleanupExpired = true,
): Promise<EmailVerificationPending | null> {
  const tenantSlug = normalizeTenantSlug(slug) ?? "";
  if (!tenantSlug || userId <= 0) return null;
  const table = await ensureEmailVerificationTable(tenantSlug);
  const clauses = ["user_id = ?"];
  const params: unknown[] = [userId];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.unshift("tenant_id = ?");
    params.unshift(table.tenantId ?? 0);
  }
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT id,new_email,code_hash,expires_at,created_at,attempt_count,last_attempt_at FROM \`${table.name}\` WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT 1`,
    params,
  ).catch(() => []);
  const row = rows[0];
  if (!row) return null;
  if (cleanupExpired && isExpired(row.expires_at)) {
    await deletePendingEmailVerification(tenantSlug, userId);
    return null;
  }
  return mapPending(row);
}

// Ordine guardie e messaggi verbatim di accessibility.php: il cooldown viene
// controllato PRIMA delle validazioni (come accessibility_enforce_code_cooldown
// in testa alle action) e i flash legacy sono SENZA punto finale.
export async function requestCurrentEmailVerification({
  slug,
  userId,
  email,
}: {
  slug: string;
  userId: number;
  email: string;
}): Promise<EmailCodeResult> {
  await ensureEmailCodeCooldown(slug, userId);
  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) throw new Error("Email non valida");
  return storeAndReturnCode({
    slug,
    userId,
    email: normalizedEmail,
    message: "Codice inviato alla tua email",
    subject: "Conferma email account",
    intro: "per completare l'attivazione del tuo account inserisci questo codice:",
  });
}

export async function requestEmailChange({
  slug,
  userId,
  currentEmail,
  newEmail,
  currentPassword,
}: {
  slug: string;
  userId: number;
  currentEmail: string;
  newEmail: string;
  currentPassword: string;
}): Promise<EmailCodeResult> {
  await ensureEmailCodeCooldown(slug, userId);
  const normalizedCurrent = normalizeEmail(currentEmail);
  const normalizedNew = normalizeEmail(newEmail);
  if (!isValidEmail(normalizedNew)) throw new Error("Email non valida");
  if (normalizedCurrent === normalizedNew) throw new Error("L email e gia questa");
  await assertCurrentPassword(slug, userId, currentPassword, "Inserisci la password attuale per cambiare email.");
  await ensureEmailAvailable(slug, userId, normalizedNew, normalizedCurrent);
  return storeAndReturnCode({
    slug,
    userId,
    email: normalizedNew,
    message: "Codice inviato alla nuova email",
    subject: "Conferma cambio email",
    intro: "hai richiesto di cambiare l'email di accesso.<br>Il tuo codice di conferma e:",
  });
}

export async function resendEmailCode({
  slug,
  userId,
  currentEmail,
}: {
  slug: string;
  userId: number;
  currentEmail: string;
}): Promise<EmailCodeResult> {
  const pending = await getEmailVerificationPending(slug, userId, false);
  if (!pending) throw new Error("Nessuna verifica email in corso.");
  if (pending.resendWaitSeconds > 0) {
    throw new Error(`Attendi ${pending.resendWaitSeconds} secondi prima di richiedere un nuovo codice.`);
  }

  const targetEmail = normalizeEmail(pending.email);
  if (!isValidEmail(targetEmail)) {
    await deletePendingEmailVerification(slug, userId);
    throw new Error("Email non valida: richiedi un nuovo codice.");
  }

  const normalizedCurrent = normalizeEmail(currentEmail);
  const isEmailChange = targetEmail !== normalizedCurrent;
  if (isEmailChange) {
    await ensureEmailAvailable(slug, userId, targetEmail, normalizedCurrent);
  }

  return storeAndReturnCode({
    slug,
    userId,
    email: targetEmail,
    message: "Codice reinviato",
    subject: isEmailChange ? "Conferma cambio email" : "Conferma email account",
    intro: isEmailChange
      ? "hai richiesto di cambiare l'email di accesso.<br>Il tuo nuovo codice di conferma e:"
      : "per completare l'attivazione del tuo account inserisci questo nuovo codice:",
  });
}

export async function confirmEmailCode({
  slug,
  userId,
  currentEmail,
  code,
}: {
  slug: string;
  userId: number;
  currentEmail: string;
  code: string;
}): Promise<{ ok: true; email: string; verifiedAt: string; message: string }> {
  const tenantSlug = normalizeTenantSlug(slug) ?? "";
  const normalizedCode = code.trim();
  if (!normalizedCode) throw new Error("Inserisci il codice");
  const pending = await rawPendingRow(tenantSlug, userId);
  if (!pending) throw new Error("Nessuna richiesta di cambio email attiva");
  if (isExpired(pending.expires_at)) {
    await deletePendingEmailVerification(tenantSlug, userId);
    throw new Error("Codice scaduto: richiedi un nuovo codice");
  }
  if (Number(pending.attempt_count ?? 0) >= EMAIL_CODE_MAX_ATTEMPTS) {
    await deletePendingEmailVerification(tenantSlug, userId);
    throw new Error("Troppi tentativi non validi. Richiedi un nuovo codice.");
  }
  if (String(pending.code_hash ?? "") !== codeHash(normalizedCode)) {
    // accessibility_bad_code_attempt: al raggiungimento del limite la pending
    // viene rimossa e il flash è quello dei troppi tentativi.
    const maxReached = await badEmailCodeAttempt(tenantSlug, userId, pending);
    throw new Error(maxReached ? "Troppi tentativi non validi. Richiedi un nuovo codice." : "Codice non valido");
  }

  const newEmail = normalizeEmail(String(pending.new_email ?? ""));
  const normalizedCurrent = normalizeEmail(currentEmail);
  if (!isValidEmail(newEmail)) {
    await deletePendingEmailVerification(tenantSlug, userId);
    // Nel confirm il flash legacy è SENZA punto (316), nel resend CON (264).
    throw new Error("Email non valida: richiedi un nuovo codice");
  }
  if (newEmail !== normalizedCurrent) await ensureEmailAvailable(tenantSlug, userId, newEmail, normalizedCurrent);

  const verifiedAt = sqlNow();
  // Blocco TRANSAZIONALE legacy (accessibility.php 326-344: beginTransaction ->
  // update users + sync email staff + delete pending -> commit, rollback su
  // errore): mai un'email cambiata a metà (users aggiornata ma staff no, o
  // pending rimasta). Qualsiasi errore DB → flash catch-all 'Errore verifica
  // email' (i flash specifici sopra escono dal try legacy via redirect).
  try {
    const users = await tenantTable(tenantSlug, "users");
    const verifications = await ensureEmailVerificationTable(tenantSlug);
    const staff = newEmail !== normalizedCurrent ? await tenantTable(tenantSlug, "staff").catch(() => null) : null;
    const staffHasEmail = staff ? await columnExists(staff.name, "email") : false;
    const staffHasFullName = staff && staffHasEmail ? await columnExists(staff.name, "full_name") : false;
    await withTenantTransaction(tenantSlug, async (q) => {
      const userClauses = ["id = ?"];
      const userScopeParams: unknown[] = [userId];
      if (users.mode === "shared") {
        userClauses.push("tenant_id = ?");
        userScopeParams.push(users.tenantId ?? 0);
      }
      if (newEmail === normalizedCurrent) {
        await q(`UPDATE \`${users.name}\` SET email_verified_at = ? WHERE ${userClauses.join(" AND ")}`, [verifiedAt, ...userScopeParams]);
      } else {
        await q(`UPDATE \`${users.name}\` SET email = ?, email_verified_at = ? WHERE ${userClauses.join(" AND ")}`, [newEmail, verifiedAt, ...userScopeParams]);
        if (staff && staffHasEmail) {
          const staffClauses = ["LOWER(email) = ?"];
          const staffParams: unknown[] = [newEmail, normalizedCurrent];
          if (staffHasFullName) staffClauses.push("COALESCE(full_name,'') <> 'SSO'");
          if (staff.mode === "shared") {
            staffClauses.push("tenant_id = ?");
            staffParams.push(staff.tenantId ?? 0);
          }
          await q(`UPDATE \`${staff.name}\` SET email = ? WHERE ${staffClauses.join(" AND ")}`, staffParams);
        }
      }
      const pendClauses = ["user_id = ?"];
      const pendParams: unknown[] = [userId];
      if (verifications.mode === "shared" && await columnExists(verifications.name, "tenant_id")) {
        pendClauses.unshift("tenant_id = ?");
        pendParams.unshift(verifications.tenantId ?? 0);
      }
      await q(`DELETE FROM \`${verifications.name}\` WHERE ${pendClauses.join(" AND ")}`, pendParams);
    });
  } catch {
    throw new Error("Errore verifica email");
  }
  await invalidateManagePasswordResets(tenantSlug, userId);
  return { ok: true, email: newEmail, verifiedAt, message: "Email verificata" };
}

async function storeAndReturnCode({
  slug,
  userId,
  email,
  message,
  subject,
  intro,
}: {
  slug: string;
  userId: number;
  email: string;
  message: string;
  subject: string;
  intro: string;
}): Promise<EmailCodeResult> {
  const tenantSlug = normalizeTenantSlug(slug) ?? "";
  const code = String(randomInt(100000, 1000000));
  const table = await ensureEmailVerificationTable(tenantSlug);
  await deletePendingEmailVerification(tenantSlug, userId);
  const includeTenant = table.mode === "shared" && await columnExists(table.name, "tenant_id");
  // TZ trap: expires_at/created_at ESPLICITI in ora locale del server Node
  // (come date() in PHP). Con NOW() del DB (UTC su Supabase) la rilettura
  // locale vedeva i codici già scaduti e il cooldown non scattava mai.
  await dbExecute(
    `INSERT INTO \`${table.name}\` (${[
      includeTenant ? "`tenant_id`" : "",
      "`user_id`",
      "`new_email`",
      "`code_hash`",
      "`expires_at`",
      "`created_at`",
      "`attempt_count`",
    ].filter(Boolean).join(",")}) VALUES (${[
      includeTenant ? "?" : "",
      "?",
      "?",
      "?",
      "?",
      "?",
      "0",
    ].filter(Boolean).join(",")})`,
    [
      ...(includeTenant ? [table.tenantId ?? 0] : []),
      userId,
      email,
      codeHash(code),
      sqlDateTimeFromMs(Date.now() + EMAIL_CODE_TTL_SECONDS * 1000),
      sqlDateTimeFromMs(Date.now()),
    ],
  );

  // accessibility_send_email_code: il codice viene EMAILATO col template
  // legacy (mittente = businesses name/email); se l'invio fallisce la pending
  // viene rimossa e l'errore è il flash legacy. Con SES non configurato (dev)
  // il codice resta consultabile nel payload (verificationCode) per i test.
  if (emailConfigured()) {
    const branding = await staffInviteBranding(tenantSlug);
    const bizName = branding.name.trim() || "La mia attivita";
    const body =
      "Ciao,<br><br>" + intro + "<br><br>"
      + emailCodeBox(code)
      + "<br><br>Il codice scade tra 15 minuti.<br><br>Se non sei stato tu, ignora questa email.";
    const { html, text } = buildModernEmailTemplate(subject, body, {
      business_name: bizName,
      business_email: branding.email,
      business_logo_url: branding.logoUrl,
    });
    // Pattern SES: From = identità verificata della piattaforma; il mittente
    // "visivo" è il fromName dell'attività e le risposte vanno alla sua email
    // (un fromEmail tenant non verificato viene RIFIUTATO da SES).
    const sent = await sendEmail({
      to: email,
      subject,
      html,
      text,
      fromName: bizName || undefined,
      replyTo: branding.email.trim() || undefined,
    }).catch(() => ({ ok: false as const, error: "send" }));
    if (!sent.ok) {
      await deletePendingEmailVerification(tenantSlug, userId);
      throw new Error("Invio codice fallito (controlla mail() del server)");
    }
  }

  return {
    ok: true,
    message,
    pending: await getEmailVerificationPending(tenantSlug, userId, false),
    verificationCode: exposeVerificationCode() ? code : undefined,
  };
}

async function ensureEmailCodeCooldown(slug: string, userId: number): Promise<void> {
  const pending = await getEmailVerificationPending(slug, userId, true);
  if (!pending || pending.resendWaitSeconds <= 0) return;
  throw new Error(`Attendi ${pending.resendWaitSeconds} secondi prima di richiedere un nuovo codice.`);
}

// --- Staff invite (email-verification code) email --------------------------
//
// Port of the staff-create / email-change "Conferma email account" mail in
// app/pages/staff.php (staff_prepare_email_verification / the inline blocks in the
// new/edit handler). The legacy app inserts a 6-digit code into
// user_email_verifications and mails it via mail_send_html; the operator must
// enter the code (in Accessibilita) to activate/confirm the login email.
//
// In Next the staff create/update path (lib/manage-resources.ts) was creating the
// login user but never issuing/sending that code, so the invite was silent. This
// helper reproduces storeAndReturnCode()'s INSERT (so the code is a real,
// verifiable code reused by confirmEmailCode) AND sends the branded email through
// SES. It is tenant-scoped, gated on emailConfigured() (no-op when SES is off, so
// behaviour is unchanged locally / when unconfigured), runs AFTER the user row is
// written, and swallows every error — staff creation must never fail because of a
// best-effort invite mail.

type StaffInviteBranding = { name: string; email: string; logoUrl: string };

// Per-tenant branding for the invite email, mirroring the cron / password-reset
// readers: first businesses row (ORDER BY id ASC LIMIT 1), best-effort.
async function staffInviteBranding(slug: string): Promise<StaffInviteBranding> {
  const empty: StaffInviteBranding = { name: "", email: "", logoUrl: "" };
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
      logoUrl: hasLogo ? resolveStaffInviteLogoUrl(String(row.logo_path ?? "")) : "",
    };
  } catch {
    return empty;
  }
}

// Turn a stored logo_path into an absolute URL (same rule as the password-reset
// reader). Absolute http(s) URL -> as-is; public path -> prefixed with
// PRENODO_PUBLIC_BASE_URL; otherwise omit (template falls back to the brand name).
function resolveStaffInviteLogoUrl(logoPath: string): string {
  const path = logoPath.trim();
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const base = String(process.env.PRENODO_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  if (!base || !path.startsWith("/")) return "";
  return `${base}${path}`;
}

// Port of the legacy "Conferma email account" body (h() the code; HTML body fed to
// email_build_modern_template). `updated` toggles the new-account vs email-changed
// intro. I path INLINE di staff.php (nuovo operatore 927-929, cambio email
// 991-993) usano le frasi ACCENTATE; il helper staff_prepare_email_verification
// (147-148, usato solo dal path edit-crea-account-tardivo) quelle SENZA accenti
// -> `plain` seleziona la variante.
function buildStaffInviteEmailBody(code: string, updated: boolean, plain: boolean): string {
  const intro = plain
    ? (updated
      ? "la tua email di accesso e stata aggiornata. Confermala con questo codice:"
      : "il tuo account e stato creato. Per completare l'attivazione inserisci questo codice:")
    : (updated
      ? "la tua email di accesso è stata aggiornata. Confermala con questo codice:"
      : "il tuo account è stato creato. Per completare l'attivazione inserisci questo codice:");
  return (
    "Ciao,<br><br>" + escapeInviteHtml(intro) + "<br><br>"
    + emailCodeBox(code)
    + "<br><br>Il codice scade tra 15 minuti.<br><br>Se non sei stato tu, ignora questa email."
  );
}

function escapeInviteHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Issue a fresh email-verification code for `userId` (replacing any pending one,
// like storeAndReturnCode) and email it to `email`, branded per tenant. Returns
// silently on any failure: the login user is already persisted by the caller, and
// the operator can re-trigger a code from the Accessibilita screen. When SES is
// not configured this is a no-op (the code row is NOT written either, so we don't
// leave an unconfirmable pending row that the caller can't surface).
export async function sendStaffInviteEmailCode(args: {
  slug: string;
  userId: number;
  email: string;
  updated: boolean;
  plain?: boolean;
}): Promise<void> {
  if (!emailConfigured()) return;
  const tenantSlug = normalizeTenantSlug(args.slug) ?? "";
  const to = normalizeEmail(args.email);
  if (!tenantSlug || args.userId <= 0 || !isValidEmail(to)) return;
  try {
    const code = String(randomInt(100000, 1000000));
    const table = await ensureEmailVerificationTable(tenantSlug);
    await deletePendingEmailVerification(tenantSlug, args.userId);
    const includeTenant = table.mode === "shared" && await columnExists(table.name, "tenant_id");
    // Stessa TZ trap di storeAndReturnCode: timestamp espliciti locali.
    await dbExecute(
      `INSERT INTO \`${table.name}\` (${[
        includeTenant ? "`tenant_id`" : "",
        "`user_id`",
        "`new_email`",
        "`code_hash`",
        "`expires_at`",
        "`created_at`",
        "`attempt_count`",
      ].filter(Boolean).join(",")}) VALUES (${[
        includeTenant ? "?" : "",
        "?",
        "?",
        "?",
        "?",
        "?",
        "0",
      ].filter(Boolean).join(",")})`,
      [
        ...(includeTenant ? [table.tenantId ?? 0] : []),
        args.userId,
        to,
        codeHash(code),
        sqlDateTimeFromMs(Date.now() + EMAIL_CODE_TTL_SECONDS * 1000),
        sqlDateTimeFromMs(Date.now()),
      ],
    );

    const branding = await staffInviteBranding(tenantSlug);
    const bizName = branding.name.trim();
    const subject = "Conferma email account";
    const { html, text } = buildModernEmailTemplate(subject, buildStaffInviteEmailBody(code, args.updated, args.plain === true), {
      business_name: bizName,
      business_email: branding.email,
      business_logo_url: branding.logoUrl,
    });
    // Pattern SES: From verificato + fromName attività + replyTo attività.
    const res = await sendEmail({
      to,
      subject,
      html,
      text,
      fromName: bizName || undefined,
      replyTo: branding.email.trim() || undefined,
    });
    if (!res.ok) {
      console.error(`[manage-accessibility] staff invite email send failed for ${maskEmail(to)}: ${res.error}`);
    }
  } catch (error) {
    console.error("[manage-accessibility] staff invite email send error:", error);
  }
}

async function ensureEmailVerificationTable(slug: string): Promise<{ name: string; mode: string; tenantId: number | null }> {
  const table = await tenantTable(slug, "user_email_verifications").catch(async () => {
    const users = await tenantTable(slug, "users");
    return {
      name: users.mode === "prefixed" ? `${users.name.replace(/users$/, "")}user_email_verifications` : "user_email_verifications",
      mode: users.mode,
      tenantId: users.tenantId,
    };
  });
  // The target table already exists in Postgres; skip the legacy MySQL DDL.
  if (await tableExists(table.name)) return table;
  const tenantColumn = table.mode === "shared" ? '"tenant_id" integer NULL DEFAULT NULL,' : "";
  await dbExecute(
    `CREATE TABLE IF NOT EXISTS \`${table.name}\` (
      "id" integer GENERATED BY DEFAULT AS IDENTITY,
      ${tenantColumn}
      "user_id" integer NOT NULL,
      "new_email" varchar(190) NOT NULL,
      "code_hash" char(64) NOT NULL,
      "expires_at" timestamp NOT NULL,
      "created_at" timestamp NULL DEFAULT CURRENT_TIMESTAMP,
      "attempt_count" integer NOT NULL DEFAULT 0,
      "last_attempt_at" timestamp NULL DEFAULT NULL,
      PRIMARY KEY ("id")
    )`,
  );
  await dbExecute(`CREATE INDEX IF NOT EXISTS "idx_user_email_verifications_user" ON \`${table.name}\` ("user_id")`).catch(() => undefined);
  await dbExecute(`CREATE INDEX IF NOT EXISTS "idx_user_email_verifications_exp" ON \`${table.name}\` ("expires_at")`).catch(() => undefined);
  return table;
}

async function rawPendingRow(slug: string, userId: number): Promise<RowDataPacket | null> {
  const table = await ensureEmailVerificationTable(slug);
  const clauses = ["user_id = ?"];
  const params: unknown[] = [userId];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.unshift("tenant_id = ?");
    params.unshift(table.tenantId ?? 0);
  }
  // accessibility_get_pending: catch interno → null (il confirm mostra
  // 'Nessuna richiesta di cambio email attiva' anche su errore DB, come il PHP).
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT id,new_email,code_hash,expires_at,created_at,attempt_count,last_attempt_at FROM \`${table.name}\` WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT 1`,
    params,
  ).catch(() => [] as RowDataPacket[]);
  return rows[0] ?? null;
}

async function deletePendingEmailVerification(slug: string, userId: number): Promise<void> {
  const table = await ensureEmailVerificationTable(slug);
  const clauses = ["user_id = ?"];
  const params: unknown[] = [userId];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.unshift("tenant_id = ?");
    params.unshift(table.tenantId ?? 0);
  }
  await dbExecute(`DELETE FROM \`${table.name}\` WHERE ${clauses.join(" AND ")}`, params).catch(() => undefined);
}

// Ritorna true se col tentativo si raggiunge il limite (pending rimossa).
async function badEmailCodeAttempt(slug: string, userId: number, row: RowDataPacket): Promise<boolean> {
  const table = await ensureEmailVerificationTable(slug);
  const rowId = Number(row.id ?? 0);
  const clauses = ["id = ?", "user_id = ?"];
  const params: unknown[] = [rowId, userId];
  if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
    clauses.push("tenant_id = ?");
    params.push(table.tenantId ?? 0);
  }
  // last_attempt_at in ORA LOCALE dell'app (classe TZ: NOW() del DB è UTC su
  // Supabase mentre expires_at/created_at sono app-locali).
  await dbExecute(
    `UPDATE \`${table.name}\` SET attempt_count = attempt_count + 1, last_attempt_at = ? WHERE ${clauses.join(" AND ")}`,
    [sqlNow(), ...params],
  ).catch(() => undefined);
  if (Number(row.attempt_count ?? 0) + 1 >= EMAIL_CODE_MAX_ATTEMPTS) {
    await deletePendingEmailVerification(slug, userId);
    return true;
  }
  return false;
}

async function assertCurrentPassword(slug: string, userId: number, password: string, emptyMessage: string): Promise<void> {
  if (!password.trim()) throw new Error(emptyMessage);
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "users",
    columns: "id,password_hash",
    where: "id = ?",
    params: [userId],
    limit: 1,
  });
  const user = rows[0];
  if (!user || !await verifyPhpPassword(password, String(user.password_hash ?? ""))) {
    throw new Error("Password attuale non corretta");
  }
}

async function ensureEmailAvailable(slug: string, userId: number, email: string, currentEmail: string): Promise<void> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "users",
    columns: "id",
    where: "LOWER(email) = ? AND id <> ?",
    params: [email, userId],
    limit: 1,
  }).catch(() => []);
  if (rows.length > 0 || await staffEmailInUse(slug, email, currentEmail)) {
    throw new Error("Email gia utilizzata da un altro account o operatore");
  }
}

async function staffEmailInUse(slug: string, email: string, currentEmail: string): Promise<boolean> {
  if (!await tableExists("staff").catch(() => false)) return false;
  const staff = await tenantTable(slug, "staff").catch(() => null);
  if (!staff || !await columnExists(staff.name, "email")) return false;
  const hasFullName = await columnExists(staff.name, "full_name");
  const clauses = ["LOWER(email) = ?", "LOWER(COALESCE(email,'')) <> ?"];
  const params: unknown[] = [email, currentEmail];
  if (hasFullName) clauses.push("COALESCE(full_name,'') <> 'SSO'");
  if (staff.mode === "shared" && await columnExists(staff.name, "tenant_id")) {
    clauses.unshift("tenant_id = ?");
    params.unshift(staff.tenantId ?? 0);
  }
  const rows = await dbQuery<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM \`${staff.name}\` WHERE ${clauses.join(" AND ")}`, params).catch(() => []);
  return Number(rows[0]?.count ?? 0) > 0;
}

// NB: il sync email staff (accessibility_sync_staff_email) ora vive DENTRO la
// transazione di confirmEmailCode, come nel beginTransaction legacy.

function mapPending(row: RowDataPacket): EmailVerificationPending {
  // I timestamp del driver pg sono Date: resi in ORA LOCALE (mai toISOString,
  // che scala di -2h) così il display d/m/Y H:i del client resta corretto.
  const createdAt = sqlDateTime(row.created_at);
  return {
    id: Number(row.id ?? 0),
    email: String(row.new_email ?? ""),
    expiresAt: sqlDateTime(row.expires_at),
    createdAt,
    attemptCount: Number(row.attempt_count ?? 0),
    resendWaitSeconds: resendWaitSeconds(createdAt),
  };
}

function sqlDateTime(value: unknown): string {
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  }
  return String(value ?? "");
}

function sqlDateTimeFromMs(ms: number): string {
  return sqlDateTime(new Date(ms));
}

function resendWaitSeconds(createdAt: string): number {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return 0;
  const elapsed = Math.floor((Date.now() - createdMs) / 1000);
  return Math.max(0, EMAIL_CODE_RESEND_SECONDS - elapsed);
}

function isExpired(value: unknown): boolean {
  const expiresMs = Date.parse(String(value ?? ""));
  return Number.isFinite(expiresMs) && expiresMs < Date.now();
}

function codeHash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
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

function exposeVerificationCode(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.PRENODO_EXPOSE_EMAIL_CODE === "1";
}

function sqlNow(): string {
  const date = new Date();
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
