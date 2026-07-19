import "server-only";

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import type { RowDataPacket } from "@/lib/tenant-db";
import { allAssignablePermissions } from "@/lib/role-permissions";
import { normalizeTenantSlug, tenantSessionSuffix } from "@/lib/tenant-runtime";
import { dbExecute, dbQuery, tenantSelect, tenantTable, columnExists, tableExists } from "@/lib/tenant-db";

export type ManageUser = {
  id: number;
  email: string;
  name: string;
  role: string;
  perms: string[];
  needsEmailVerification: boolean;
  currentLocationId: number;
  needsLocationSelection: boolean;
  locationIds: number[];
};

export type ManageSession = {
  tenantSlug: string;
  user: ManageUser;
  issuedAt: number;
  // Epoca di revoca: il logout incrementa users.session_epoch e invalida
  // tutte le sessioni firmate emesse prima (parita' con session_destroy legacy).
  epoch?: number;
  // Marker accesso SUPPORTO (Fase 4 SaaS Admin, 2026-07-19): la sessione
  // creata da un support token porta l'id del token — la shell mostra il
  // banner di trasparenza al tenant finché il token non scade/viene revocato.
  support?: { tokenId: number };
};

type LoginResult =
  | { ok: true; session: ManageSession; redirectTo: string; source: "database" | "demo" }
  | { ok: false; error: string };

const SESSION_TTL_SECONDS = 60 * 60 * 12;
const LOGIN_RATE_LIMIT_WINDOW_SECONDS = 15 * 60;
const LOGIN_RATE_LIMIT_MAX_FAILURES = 10;

export async function loginManageUser({
  slug,
  email,
  password,
  ip,
}: {
  slug: string;
  email: string;
  password: string;
  ip: string;
}): Promise<LoginResult> {
  const tenantSlug = normalizeTenantSlug(slug) ?? "";
  const normalizedEmail = normalizeEmail(email);
  if (!tenantSlug) return { ok: false, error: "URL attivita mancante." };
  if (!normalizedEmail || !password) return { ok: false, error: "Email e password obbligatorie." };

  try {
    if (await isRateLimited(tenantSlug, normalizedEmail, ip)) {
      return { ok: false, error: "Troppi tentativi di login. Riprova tra qualche minuto." };
    }

    // Tenant inesistente o sospeso: messaggio legacy dedicato
    // (SaasProfessionalSignup::login ~467-470, non distingue i due casi).
    const tenantRows = await dbQuery<RowDataPacket[]>(
      "SELECT id FROM saas_tenants WHERE slug = ? AND COALESCE(is_active,1) = 1 AND COALESCE(status,'active') = 'active' AND deleted_at IS NULL LIMIT 1",
      [tenantSlug],
    ).catch(() => [] as RowDataPacket[]);
    if (!tenantRows[0]) {
      return { ok: false, error: "Gestionale non trovato o non attivo." };
    }

    const users = await tenantSelect<RowDataPacket>({
      slug: tenantSlug,
      table: "users",
      where: "LOWER(email) = ?",
      params: [normalizedEmail],
      limit: 1,
    });
    const dbUser = users[0];
    if (!dbUser || !await verifyPhpPassword(password, String(dbUser.password_hash ?? ""))) {
      await recordLoginAttempt(tenantSlug, normalizedEmail, ip, false);
      return { ok: false, error: "Credenziali non valide." };
    }

    const staffActive = await activeStaffAllowed(tenantSlug, normalizedEmail, dbUser);
    if (!staffActive) {
      await recordLoginAttempt(tenantSlug, normalizedEmail, ip, false);
      return { ok: false, error: "Account operatore disattivato." };
    }

    await recordLoginAttempt(tenantSlug, normalizedEmail, ip, true);
    const user = await buildManageUser(tenantSlug, dbUser);
    const session: ManageSession = {
      tenantSlug,
      user,
      issuedAt: Date.now(),
      epoch: Number(dbUser.session_epoch ?? 0) || 0,
    };
    return { ok: true, session, redirectTo: `/${encodeURIComponent(tenantSlug)}/dashboard`, source: "database" };
  } catch {
    // SECURITY: no hardcoded/demo credential fallback. Auth is DB-only — a DB
    // failure is an error, never an admin grant for a specific tenant.
    await recordLoginAttempt(tenantSlug, normalizedEmail, ip, false).catch(() => undefined);
    return { ok: false, error: "Servizio di autenticazione non disponibile. Riprova tra poco." };
  }
}

export async function setManageSessionCookie(session: ManageSession): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(sessionCookieName(session.tenantSlug), signSession(session), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

// Variante per i Route Handler che devono settare il cookie DIRETTAMENTE
// sulla risposta di redirect (Fase 4: consumo support token) — il cookie
// store asincrono non viene propagato su una Response costruita a mano.
export function manageSessionCookiePayload(session: ManageSession): { name: string; value: string; maxAge: number } {
  return {
    name: sessionCookieName(session.tenantSlug),
    value: signSession(session),
    maxAge: SESSION_TTL_SECONDS,
  };
}

export async function clearManageSessionCookie(slug: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(sessionCookieName(slug));
}

export async function currentManageSession(slug: string): Promise<ManageSession | null> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(sessionCookieName(slug))?.value;
  if (!raw) return null;
  const session = verifySession(raw);
  if (!session) return null;
  if (session.tenantSlug !== normalizeTenantSlug(slug)) return null;
  if (Date.now() - session.issuedAt > SESSION_TTL_SECONDS * 1000) return null;
  if (!(await sessionEpochValid(session))) return null;
  if (!(await supportTokenStillValid(session))) return null;
  return session;
}

// Le sessioni SUPPORTO (Fase 4 SaaS Admin) sono vincolate al loro token: se
// viene revocato o scade, la sessione muore SUBITO — non sopravvive per le
// 12 ore del cookie. Le sessioni normali (senza marker) non pagano la query.
async function supportTokenStillValid(session: ManageSession): Promise<boolean> {
  const tokenId = Number(session.support?.tokenId ?? 0);
  if (!tokenId) return true;
  try {
    const rows = await dbQuery<RowDataPacket[]>(
      "SELECT revoked_at, expires_at FROM `saas_support_access_tokens` WHERE id = ? LIMIT 1",
      [tokenId],
    );
    const row = rows[0];
    if (!row || row.revoked_at) return false;
    const expiresMs = new Date(String(row.expires_at ?? "").replace(" ", "T")).getTime();
    if (Number.isFinite(expiresMs) && Date.now() > expiresMs) return false;
    return true;
  } catch {
    // Errore DB transitorio: fail-open come sessionEpochValid.
    return true;
  }
}

// Confronta l'epoca della sessione con users.session_epoch: il logout
// incrementa il contatore e rende non valide le sessioni gia' emesse
// (equivalente della session_destroy() server-side legacy).
async function sessionEpochValid(session: ManageSession): Promise<boolean> {
  const userId = Number(session.user?.id ?? 0);
  if (!userId) return true;
  try {
    if (!(await columnExists("users", "session_epoch"))) return true;
    const rows = await tenantSelect<RowDataPacket>({
      slug: session.tenantSlug,
      table: "users",
      where: "id = ?",
      params: [userId],
      limit: 1,
    });
    if (!rows[0]) return false;
    return (Number(session.epoch ?? 0) || 0) >= (Number(rows[0].session_epoch ?? 0) || 0);
  } catch {
    // Errore DB transitorio: non buttare fuori l'utente per un blip di rete.
    return true;
  }
}

// Invalida tutte le sessioni firmate dell'utente (chiamata dal logout).
export async function revokeManageSessions(slug: string, userId: number): Promise<void> {
  const tenantSlug = normalizeTenantSlug(slug) ?? "";
  if (!tenantSlug || !userId) return;
  try {
    if (!(await columnExists("users", "session_epoch"))) return;
    const table = await tenantTable(tenantSlug, "users");
    const clauses = ["id = ?"];
    const params: unknown[] = [userId];
    if (table.mode === "shared" && table.tenantId && await columnExists(table.name, "tenant_id")) {
      clauses.push("tenant_id = ?");
      params.push(table.tenantId);
    }
    await dbExecute(
      `UPDATE \`${table.name}\` SET session_epoch = COALESCE(session_epoch, 0) + 1 WHERE ${clauses.join(" AND ")}`,
      params,
    );
  } catch {
    // best-effort: il cookie viene comunque cancellato dal chiamante
  }
}

export function sessionCookieName(slug: string): string {
  return `beautysuite_session_${tenantSessionSuffix(slug)}`;
}

async function buildManageUser(slug: string, dbUser: RowDataPacket): Promise<ManageUser> {
  const role = String(dbUser.role ?? "");
  const isAdmin = role.toLowerCase() === "admin";
  const perms = isAdmin ? allAssignablePermissions() : await rolePermissions(slug, role);
  const locationState = await loginLocationState(slug, Number(dbUser.id ?? 0), isAdmin, String(dbUser.email ?? ""));

  return {
    id: Number(dbUser.id ?? 0),
    email: String(dbUser.email ?? ""),
    name: String(dbUser.full_name ?? dbUser.name ?? dbUser.email ?? "Utente"),
    role,
    perms,
    needsEmailVerification: Object.prototype.hasOwnProperty.call(dbUser, "email_verified_at") && !dbUser.email_verified_at,
    currentLocationId: locationState.currentLocationId,
    needsLocationSelection: locationState.needsLocationSelection,
    locationIds: locationState.locationIds,
  };
}

async function rolePermissions(slug: string, role: string): Promise<string[]> {
  if (!role.trim()) return [];
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "role_permissions",
      columns: "perm",
      where: "role = ?",
      params: [role.toLowerCase()],
    });
    return rows.map((row) => String(row.perm ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}

async function activeStaffAllowed(slug: string, email: string, dbUser: RowDataPacket): Promise<boolean> {
  try {
    const rows = await tenantSelect<RowDataPacket>({
      slug,
      table: "staff",
      columns: "id,is_active,full_name",
      where: "LOWER(email) = ? AND full_name <> 'SSO'",
      params: [email],
    });
    if (!rows.length) return true;
    if (rows.some((row) => Number(row.is_active ?? 1) === 1)) return true;
    return Number(dbUser.id ?? 0) === 1 && String(dbUser.role ?? "").toLowerCase() === "admin";
  } catch {
    return true;
  }
}

// Sedi assegnate all'operatore al login (port di app_user_location_options del PHP):
// l'operatore vede/agisce solo sulle sedi assegnate; admin = tutte.
// FONTE PRIMARIA = staff_locations (utente->staff via email, come il legacy), con
// fallback compat su user_locations (popolata dal provisioning admin) e ultimo
// fallback = tutte le sedi attive. Il fallback "tutte" quando NON c'e' assegnazione
// e' una scelta PRUDENTE (evita di chiudere fuori un operatore senza sedi, a
// differenza del PHP che lo bloccherebbe): l'isolamento per-sede si ATTIVA appena
// l'admin assegna >=1 sede all'operatore nell'editor Operatori.
async function loginLocationState(slug: string, userId: number, isAdmin: boolean, email: string): Promise<{ currentLocationId: number; needsLocationSelection: boolean; locationIds: number[] }> {
  try {
    const locations = await tenantSelect<RowDataPacket>({
      slug,
      table: "locations",
      columns: "id",
      where: await columnExists((await tenantTable(slug, "locations")).name, "is_active") ? "is_active = 1" : "",
    });
    const activeLocationIds = locations.map((row) => Number(row.id ?? 0)).filter((id) => id > 0);

    if (!locations.length || isAdmin) {
      return { currentLocationId: locations.length === 1 ? Number(locations[0]?.id ?? 0) : 0, needsLocationSelection: locations.length > 1, locationIds: isAdmin ? [] : activeLocationIds };
    }

    // 1) staff_locations (fonte legacy): utente -> staff per email -> sedi assegnate.
    let assigned: number[] = [];
    const normEmail = String(email ?? "").trim().toLowerCase();
    if (normEmail) {
      const staffRows = await tenantSelect<RowDataPacket>({
        slug,
        table: "staff",
        columns: "id",
        where: "LOWER(email) = ? AND full_name <> 'SSO'",
        params: [normEmail],
        orderBy: "id ASC",
        limit: 1,
      }).catch(() => [] as RowDataPacket[]);
      const staffId = Number(staffRows[0]?.id ?? 0);
      if (staffId > 0) {
        const slRows = await tenantSelect<RowDataPacket>({
          slug,
          table: "staff_locations",
          columns: "location_id",
          where: "staff_id = ?",
          params: [staffId],
        }).catch(() => [] as RowDataPacket[]);
        assigned = slRows.map((r) => Number(r.location_id ?? 0)).filter((n) => n > 0);
      }
    }

    // 2) fallback compat: user_locations.
    if (assigned.length === 0) {
      const userLocations = await tenantSelect<RowDataPacket>({
        slug,
        table: "user_locations",
        columns: "location_id",
        where: "user_id = ?",
        params: [userId],
      }).catch(() => [] as RowDataPacket[]);
      assigned = userLocations.map((row) => Number(row.location_id ?? 0)).filter((id) => id > 0);
    }

    // 3) intersezione con le sedi attive; se vuota -> tutte le attive (no lockout).
    const activeSet = new Set(activeLocationIds);
    let allowedIds = assigned.filter((id) => activeSet.has(id));
    if (allowedIds.length === 0) allowedIds = activeLocationIds;

    if (allowedIds.length === 1) return { currentLocationId: allowedIds[0], needsLocationSelection: false, locationIds: allowedIds };
    return { currentLocationId: 0, needsLocationSelection: allowedIds.length > 1, locationIds: allowedIds };
  } catch {
    return { currentLocationId: 0, needsLocationSelection: false, locationIds: [] };
  }
}

async function isRateLimited(slug: string, email: string, ip: string): Promise<boolean> {
  try {
    await ensureLoginAttemptsTable(slug);
    const table = await tenantTable(slug, "login_attempts");
    const clauses = ["success = 0", "attempted_at >= NOW() - (? * interval '1 second')"];
    const params: unknown[] = [LOGIN_RATE_LIMIT_WINDOW_SECONDS];
    if (table.mode === "shared" && table.tenantId && await columnExists(table.name, "tenant_id")) {
      clauses.unshift("tenant_id = ?");
      params.unshift(table.tenantId);
    }
    const identityClauses = [];
    if (email) {
      identityClauses.push("email = ?");
      params.push(email);
    }
    if (ip) {
      identityClauses.push("ip = ?");
      params.push(ip);
    }
    if (!identityClauses.length) return false;
    clauses.push(`(${identityClauses.join(" OR ")})`);
    const rows = await dbQuery<RowDataPacket[]>(`SELECT COUNT(*) AS count FROM \`${table.name}\` WHERE ${clauses.join(" AND ")}`, params);
    return Number(rows[0]?.count ?? 0) >= LOGIN_RATE_LIMIT_MAX_FAILURES;
  } catch {
    return false;
  }
}

async function recordLoginAttempt(slug: string, email: string, ip: string, success: boolean): Promise<void> {
  try {
    await ensureLoginAttemptsTable(slug);
    const table = await tenantTable(slug, "login_attempts");
    const values: Record<string, unknown> = { email, ip: ip || null, success: success ? 1 : 0 };
    if (table.mode === "shared" && table.tenantId && await columnExists(table.name, "tenant_id")) {
      values.tenant_id = table.tenantId;
    }
    const columns = Object.keys(values);
    const params = Object.values(values);
    await dbExecute(
      `INSERT INTO \`${table.name}\` (${columns.map((column) => `\`${column}\``).join(",")}, attempted_at) VALUES (${columns.map(() => "?").join(",")}, NOW())`,
      params,
    );
  } catch {
    // best effort like the PHP original
  }
}

async function ensureLoginAttemptsTable(_slug: string): Promise<void> {
  // The migrated Postgres schema already provides login_attempts. Only create
  // it (Postgres syntax) as a best-effort fallback if it is somehow missing.
  try {
    if (await tableExists("login_attempts")) return;
    await dbExecute(
      `CREATE TABLE IF NOT EXISTS "login_attempts" (
        "id" integer GENERATED BY DEFAULT AS IDENTITY,
        "tenant_id" integer,
        "email" varchar(190),
        "ip" varchar(45),
        "attempted_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "success" smallint NOT NULL DEFAULT 0,
        PRIMARY KEY ("id")
      )`,
    );
  } catch {
    // best effort like the PHP original
  }
}

async function verifyPhpPassword(password: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  if (hash.startsWith("$2y$")) return bcrypt.compare(password, `$2a$${hash.slice(4)}`);
  if (hash.startsWith("$2a$") || hash.startsWith("$2b$")) return bcrypt.compare(password, hash);
  return false;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function signSession(session: ManageSession): string {
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifySession(value: string): ManageSession | null {
  const [payload, signature] = value.split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ManageSession;
  } catch {
    return null;
  }
}

function sessionSecret(): string {
  return process.env.PRENODO_SESSION_SECRET || process.env.NEXTAUTH_SECRET || "prenodo-local-session-secret";
}
