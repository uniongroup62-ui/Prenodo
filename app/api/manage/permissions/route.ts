import {
  can,
  canAny,
  landingPageForPermissions,
  manageableRoles,
  moduleAccessRules,
  normalizeSelectedPerms,
  permissionDefinitions,
  permissionsByGroup,
  isAssignable,
  validateSelectedPerms,
} from "@/lib/role-permissions";
import {
  tenantPrefix,
  tenantSessionSuffix,
} from "@/lib/tenant-runtime";
import { currentManageSession } from "@/lib/manage-auth";
import { getManageLocationContext } from "@/lib/manage-locations";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { jsonError, parseRequestBody } from "@/lib/api-utils";
import { logActivity } from "@/lib/activity-log";
import { columnExists, dbExecute, quoteIdentifier, tableExists, tenantInsert, tenantSelect, tenantTable, withTenantTransaction } from "@/lib/tenant-db";
import type { RowDataPacket } from "@/lib/tenant-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Auth::can legacy (Auth.php 356-374): i permessi NON assegnabili restano
// riservati all'Admin anche se una vecchia riga di ruolo li contenesse.
// roles.manage è assignable:false → la pagina Ruoli è di fatto solo-Admin.
function legacyCan(role: string, perms: string[], perm: string): boolean {
  if (String(role ?? "").toLowerCase() === "admin") return true;
  if (!isAssignable(perm)) return false;
  return can(perms, perm);
}

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  const activeUser = session.user;
  // Auth::requirePerm('roles.manage') in testa a roles.php: 403 con la card
  // 'Accesso negato' (il componente la rende col testo verbatim).
  if (!legacyCan(activeUser.role, activeUser.perms, "roles.manage")) {
    return jsonError("Non hai i permessi per accedere a questa sezione.", 403);
  }
  // RolePermissions::ensureDb(true) a ogni accesso (roles.php 10, best-effort).
  await ensureDbCatalog(tenantSlug).catch(() => undefined);
  const normalizedPerms = normalizeSelectedPerms(activeUser.perms);
  const locationContext = await getManageLocationContext(tenantSlug);
  const url = new URL(request.url);
  const selectedRole = normalizeRole(url.searchParams.get("role") ?? "staff");
  const roles = await roleAssignments(tenantSlug);

  return Response.json({
    ok: true,
    tenant: {
      slug: tenantSlug,
      prefix: tenantPrefix(tenantSlug),
      sessionSuffix: tenantSessionSuffix(tenantSlug),
      sourceMode: locationContext.sourceMode,
      locations: locationContext.locations,
      currentLocationId: locationContext.currentLocationId,
      needsLocationSelection: locationContext.needsLocationSelection,
    },
    user: {
      ...activeUser,
      perms: normalizedPerms,
    },
    rolePermissions: {
      definitions: permissionDefinitions,
      groups: permissionsByGroup(),
      manageableRoles,
      selectedRole,
      assignments: roles,
      selectedPerms: roles[selectedRole] ?? [],
      validationError: validateSelectedPerms(normalizedPerms),
      canUseAppointments: canAny(normalizedPerms, ["appointments.manage", "appointments.quick_booking"]),
      landingPage: landingPageForPermissions(normalizedPerms),
    },
  });
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  const activeUser = session.user;
  if (!legacyCan(activeUser.role, activeUser.perms, "roles.manage")) {
    return jsonError("Non hai i permessi per accedere a questa sezione.", 403);
  }
  // ensureDb gira anche sul POST (roles.php 10 precede il blocco POST):
  // l'eventuale migrazione legacy avviene PRIMA della lettura dei precedenti.
  await ensureDbCatalog(tenantSlug).catch(() => undefined);

  const body = await parseRequestBody(request);
  const action = String(body.action ?? "save_role_perms");
  if (action !== "save_role_perms" && action !== "save_staff_perms") return jsonError("Azione ruoli non valida.", 400);

  const role = normalizeRole(body.role ?? "staff");
  const selected = normalizeSelectedPerms(parsePerms(body.perms ?? body.permissions ?? "").filter(isAssignable));
  const validationError = validateSelectedPerms(selected);
  if (validationError) return jsonError(validationError, 400);

  try {
    // L'audit legacy fotografa i permessi PRECEDENTI così come sono nel DB
    // (roles.php 111-116: lettura RAW, inclusi alias legacy non assegnabili),
    // non la vista normalizzata mostrata in pagina.
    const previous = await rawRolePerms(tenantSlug, role);
    await replaceRolePermissions(tenantSlug, role, selected);
    await auditRoleChange(tenantSlug, {
      role,
      oldPerms: previous,
      newPerms: selected,
      actor: {
        id: activeUser.id,
        name: activeUser.name,
        email: activeUser.email,
      },
    });
    void logActivity(tenantSlug, { user: activeUser, locationId: activeUser.currentLocationId, module: "impostazioni", action: "modifica", entityType: "role", entityId: 0, label: `Salvati permessi ruolo "${role}"` });
    const assignments = await roleAssignments(tenantSlug);
    return Response.json({
      ok: true,
      role,
      perms: assignments[role] ?? [],
      assignments,
      landingPage: landingPageForPermissions(assignments[role] ?? []),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Impossibile aggiornare i permessi.", 400);
  }
}

// Port di RolePermissions::ensureDb (RolePermissions.php 394-473): sincronizza
// la tabella `permissions` col catalogo (label/gruppo/ordine), assegna UNA
// volta allo staff i sotto-permessi NUOVI se il ruolo aveva già il padre, e
// migra i permessi legacy full-access (packages.manage → access+figli).
// Adattamento: la sync confronta le righe lette e scrive solo le differenze
// (stato DB finale identico all'upsert per-riga del PHP, senza 61 upsert a
// ogni accesso sulla connessione pooled).
async function ensureDbCatalog(slug: string): Promise<void> {
  const permsTable = await tenantTable(slug, "permissions");
  const permClauses: string[] = [];
  const permParams: unknown[] = [];
  if (permsTable.mode === "shared" && await columnExists(permsTable.name, "tenant_id")) {
    permClauses.push("tenant_id = ?");
    permParams.push(permsTable.tenantId ?? 0);
  }
  const whereSql = permClauses.length ? ` WHERE ${permClauses.join(" AND ")}` : "";
  const existingRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "permissions",
    columns: "perm,label,group_name,sort_order",
  }).catch(() => [] as RowDataPacket[]);
  const existing = new Map<string, RowDataPacket>();
  for (const row of existingRows) {
    const perm = String(row.perm ?? "").trim();
    if (perm) existing.set(perm, row);
  }

  const staffRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "role_permissions",
    columns: "perm",
    where: "role = ?",
    params: ["staff"],
  }).catch(() => [] as RowDataPacket[]);
  const staffPerms = new Set(staffRows.map((row) => String(row.perm ?? "").trim()).filter(Boolean));

  for (const definition of permissionDefinitions) {
    const perm = definition.perm;
    const row = existing.get(perm);
    const wasMissing = !row;
    try {
      if (!row) {
        await tenantInsert(permsTable, {
          perm,
          label: definition.label,
          group_name: definition.groupName,
          sort_order: definition.sortOrder,
        });
      } else if (
        String(row.label ?? "") !== definition.label
        || String(row.group_name ?? "") !== definition.groupName
        || Number(row.sort_order ?? 0) !== definition.sortOrder
      ) {
        await dbExecute(
          `UPDATE ${quoteIdentifier(permsTable.name)} SET \`label\` = ?, \`group_name\` = ?, \`sort_order\` = ? WHERE \`perm\` = ?${whereSql ? ` AND ${permClauses.join(" AND ")}` : ""}`,
          [definition.label, definition.groupName, definition.sortOrder, perm, ...permParams],
        );
      }
    } catch {
      continue; // come i catch per-permesso del PHP
    }

    // Migrazione una-tantum: nuovo sotto-permesso + lo staff aveva il padre.
    if (wasMissing && isAssignable(perm)) {
      const parents = Array.from(new Set([definition.parent, ...(definition.parents ?? [])].filter((v): v is string => Boolean(v))));
      if (parents.some((parent) => staffPerms.has(parent))) {
        await insertRolePermIfMissing(slug, "staff", perm).catch(() => undefined);
      }
    }
  }

  await migrateLegacyFullAccessPerms(slug).catch(() => undefined);
}

// Port di migrateLegacyFullAccessPerms (RolePermissions.php 349-387): un ruolo
// col vecchio permesso full (packages.manage) riceve access+figli e la riga
// legacy viene rimossa.
async function migrateLegacyFullAccessPerms(slug: string): Promise<void> {
  for (const [accessPerm, rule] of Object.entries(moduleAccessRules())) {
    const grantPerms = Array.from(new Set([accessPerm, ...rule.children])).filter((perm) => isAssignable(perm));
    if (!rule.children.length || !rule.legacyFull.length || !grantPerms.length) continue;
    for (const role of Object.keys(manageableRoles)) {
      for (const legacyPerm of rule.legacyFull) {
        const rows = await tenantSelect<RowDataPacket>({
          slug,
          table: "role_permissions",
          columns: "perm",
          where: "role = ? AND perm = ?",
          params: [role, legacyPerm],
          limit: 1,
        }).catch(() => [] as RowDataPacket[]);
        if (!rows.length) continue;
        for (const perm of grantPerms) {
          await insertRolePermIfMissing(slug, role, perm).catch(() => undefined);
        }
        const table = await tenantTable(slug, "role_permissions");
        const clauses = ["role = ?", "perm = ?"];
        const params: unknown[] = [role, legacyPerm];
        if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
          clauses.unshift("tenant_id = ?");
          params.unshift(table.tenantId ?? 0);
        }
        await dbExecute(`DELETE FROM ${quoteIdentifier(table.name)} WHERE ${clauses.join(" AND ")}`, params).catch(() => undefined);
      }
    }
  }
}

async function insertRolePermIfMissing(slug: string, role: string, perm: string): Promise<void> {
  const exists = await tenantSelect<RowDataPacket>({
    slug,
    table: "role_permissions",
    columns: "perm",
    where: "role = ? AND perm = ?",
    params: [role, perm],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  if (exists.length) return;
  const table = await tenantTable(slug, "role_permissions");
  await tenantInsert(table, { role, perm });
}

// Lettura RAW dei permessi del ruolo (roles.php 111-116): senza filtro
// isAssignable né normalizzazione — è la base dell'old_perms nell'audit.
async function rawRolePerms(slug: string, role: string): Promise<string[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "role_permissions",
    columns: "perm",
    where: "role = ?",
    params: [role],
  }).catch(() => [] as RowDataPacket[]);
  return rows.map((row) => String(row.perm ?? "")).filter(Boolean);
}

async function roleAssignments(slug: string): Promise<Record<string, string[]>> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "role_permissions", columns: "role,perm", orderBy: "role ASC, perm ASC" }).catch(() => []);
  const out: Record<string, string[]> = {};
  for (const role of Object.keys(manageableRoles)) out[role] = [];
  for (const row of rows) {
    const role = normalizeRole(row.role);
    const perm = String(row.perm ?? "").trim();
    if (!perm || !isAssignable(perm)) continue;
    out[role] = out[role] ?? [];
    out[role].push(perm);
  }
  for (const role of Object.keys(out)) out[role] = normalizeSelectedPerms(out[role]);
  return out;
}

async function replaceRolePermissions(slug: string, role: string, perms: string[]): Promise<void> {
  try {
    // TRANSAZIONE come il legacy (roles.php 119-128: beginTransaction ->
    // DELETE + INSERT per permesso -> commit, rollback su errore): un errore a
    // metà non deve MAI lasciare il ruolo con un set parziale (o vuoto) di
    // permessi. Il tenant_id sulle insert lo mette il trigger BEFORE INSERT.
    const table = await tenantTable(slug, "role_permissions");
    const clauses = ["role = ?"];
    const params: unknown[] = [role];
    if (table.mode === "shared" && await columnExists(table.name, "tenant_id")) {
      clauses.unshift("tenant_id = ?");
      params.unshift(table.tenantId ?? 0);
    }
    await withTenantTransaction(slug, async (q) => {
      await q(`DELETE FROM ${quoteIdentifier(table.name)} WHERE ${clauses.join(" AND ")}`, params);
      for (const perm of perms) {
        await q(`INSERT INTO ${quoteIdentifier(table.name)} (\`role\`, \`perm\`) VALUES (?, ?)`, [role, perm]);
      }
    });
  } catch {
    // Flash verbatim del rollback legacy (roles.php 129-134).
    throw new Error("Impossibile aggiornare i permessi: verifica schema DB e riprova.");
  }
}

async function auditRoleChange(slug: string, input: {
  role: string;
  oldPerms: string[];
  newPerms: string[];
  actor: { id: number; name: string; email: string };
}): Promise<void> {
  const oldPerms = normalizedAuditPerms(input.oldPerms);
  const newPerms = normalizedAuditPerms(input.newPerms);
  if (oldPerms.join("|") === newPerms.join("|")) return;

  try {
    const roleTable = await tenantTable(slug, "role_permissions");
    const table = roleTable.mode === "prefixed"
      ? { ...roleTable, name: roleTable.name.replace(/role_permissions$/, "role_permission_audit_log") }
      : { ...roleTable, name: "role_permission_audit_log" };
    if (!(await tableExists(table.name))) {
      const tenantColumn = table.mode === "shared" ? `\`tenant_id\` INT NULL DEFAULT NULL,` : "";
      await dbExecute(
        `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table.name)} (
          \`id\` INT GENERATED BY DEFAULT AS IDENTITY,
          ${tenantColumn}
          \`actor_user_id\` INT NULL DEFAULT NULL,
          \`actor_name\` VARCHAR(190) NULL DEFAULT NULL,
          \`actor_email\` VARCHAR(190) NULL DEFAULT NULL,
          \`role\` VARCHAR(20) NOT NULL,
          \`old_perms\` TEXT NOT NULL,
          \`new_perms\` TEXT NOT NULL,
          \`created_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (\`id\`)
        )`,
      );
      if (table.mode === "shared") {
        await dbExecute(
          `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`idx_role_perm_audit_tenant_role`)} ON ${quoteIdentifier(table.name)} (\`tenant_id\`, \`role\`, \`created_at\`)`,
        );
      }
      await dbExecute(
        `CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`idx_role_created`)} ON ${quoteIdentifier(table.name)} (\`role\`, \`created_at\`)`,
      );
    }
    // created_at ESPLICITO in ora app-locale (classe TZ: il DEFAULT
    // CURRENT_TIMESTAMP di PG è UTC, il legacy MySQL timbrava in ora locale).
    await tenantInsert(table, {
      actor_user_id: input.actor.id || null,
      actor_name: input.actor.name || null,
      actor_email: input.actor.email || null,
      role: input.role,
      old_perms: JSON.stringify(oldPerms),
      new_perms: JSON.stringify(newPerms),
      created_at: auditSqlNow(),
    });
  } catch {
    // Audit best-effort, come nel PHP.
  }
}

function normalizeRole(value: unknown): "staff" | "altro" {
  const role = String(value ?? "staff").trim().toLowerCase();
  return role === "altro" ? "altro" : "staff";
}

function parsePerms(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // fallback to comma-separated payload.
  }
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function auditSqlNow(): string {
  const date = new Date();
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function normalizedAuditPerms(perms: string[]): string[] {
  // sort() di default = confronto per code unit, come SORT_STRING del PHP.
  return Array.from(new Set(perms.map((perm) => perm.trim()).filter(Boolean))).sort();
}
