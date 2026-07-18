import pg from "pg";
import { normalizeTenantSlug, tenantPrefix } from "@/lib/tenant-runtime";

// Data layer: Supabase Postgres. Replaces the legacy MySQL/mysql2 layer.
// Native structural types stand in for the old mysql2 ones so the ~20 callers
// compile unchanged; nothing from mysql2 runs.
//
// A query row is a plain string-keyed bag of column values; dbExecute returns
// the insert id / affected-row count recovered from the Postgres result.
export type RowDataPacket = Record<string, unknown>;
export interface ResultSetHeader {
  insertId: number;
  affectedRows: number;
}
//
// dbQuery/dbExecute keep the legacy signatures but translate the SQL on the fly:
//  - `?` positional placeholders  -> `$1..$n`
//  - MySQL backtick identifiers    -> Postgres "double quotes"
//  - DATABASE()                    -> current_schema()
//  - INSERT (without RETURNING)    -> RETURNING id, to recover insertId
// The migrated schema carries BEFORE INSERT triggers that fill tenant_id from
// current_setting('app.tenant_id'); use withTenant() to set it per connection.

type TableMode = "prefixed" | "shared" | "base";

export type TenantTable = {
  name: string;
  mode: TableMode;
  tenantId: number | null;
};

const globalForTenantDb = globalThis as typeof globalThis & {
  __prenodoPgPool?: pg.Pool | null;
  __prenodoPgPoolError?: string | null;
  __prenodoPgParsers?: boolean;
};

let pool: pg.Pool | null = globalForTenantDb.__prenodoPgPool ?? null;
let poolError: string | null = globalForTenantDb.__prenodoPgPoolError ?? null;
const tableExistsCache = new Map<string, boolean>();
const columnExistsCache = new Map<string, boolean>();
let sharedTenantTablesCache: boolean | null = null;
const tenantIdCache = new Map<string, number | null>();

export type DatabaseStatus = {
  available: boolean;
  configured: boolean;
  error?: string;
  mode?: "shared" | "prefixed" | "base";
};

function connectionString(): string | null {
  return process.env.PRENODO_DATABASE_URL || process.env.SUPA_URL || process.env.DATABASE_URL || null;
}

export async function databaseStatus(slug = ""): Promise<DatabaseStatus> {
  if (!connectionString()) return { available: false, configured: false, error: "Database non configurato." };
  try {
    const table = await tenantTable(slug, "users");
    return { available: true, configured: true, mode: table.mode };
  } catch (error) {
    return { available: false, configured: true, error: error instanceof Error ? error.message : "Database non disponibile." };
  }
}

// ---- SQL dialect translation (MySQL -> Postgres) ----
export function toPostgresSql(sql: string): string {
  let out = "";
  let placeholder = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inSingle) {
      out += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") { inSingle = true; out += ch; continue; }
    if (ch === '"') { inDouble = true; out += ch; continue; }
    if (ch === "`") { out += '"'; continue; }
    if (ch === "?") { placeholder += 1; out += `$${placeholder}`; continue; }
    out += ch;
  }
  return out.replace(/\bDATABASE\(\)/gi, "current_schema()");
}

export async function dbQuery<T extends RowDataPacket[] = RowDataPacket[]>(sql: string, params: unknown[] = []): Promise<T> {
  const res = await getPool().query(toPostgresSql(sql), params as unknown[]);
  return res.rows as unknown as T;
}

export async function dbExecute(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const text = toPostgresSql(sql);
  const isInsert = /^\s*insert\s/i.test(text) && !/\breturning\b/i.test(text);
  try {
    const res = await getPool().query(isInsert ? `${text} RETURNING id` : text, params as unknown[]);
    const insertId = Number((res.rows?.[0] as { id?: number } | undefined)?.id ?? 0) || 0;
    return { affectedRows: res.rowCount ?? 0, insertId };
  } catch (error) {
    // Table without an `id` column: retry without RETURNING.
    if (isInsert && error instanceof Error && /column "id"|does not exist/i.test(error.message)) {
      const res = await getPool().query(text, params as unknown[]);
      return { affectedRows: res.rowCount ?? 0, insertId: 0 };
    }
    throw error;
  }
}

// Run a callback with app.tenant_id set on a dedicated connection, so the
// BEFORE INSERT triggers fill tenant_id for any write that omits it.
export async function withTenant<T>(tenantId: number | null, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [String(tenantId ?? 0)]);
    return await fn(client);
  } finally {
    await client.query("SELECT set_config('app.tenant_id', '0', false)").catch(() => {});
    client.release();
  }
}

// Tenant-aware query fn handed to a withTenantTransaction callback: translates
// the SQL (MySQL `?`/backticks -> Postgres $n/"quotes") and runs it on the
// dedicated transaction client, returning the result rows.
export type TenantTxQuery = <T extends RowDataPacket = RowDataPacket>(sql: string, params?: unknown[]) => Promise<T[]>;

// Run a multi-statement cascade ATOMICALLY on a single dedicated connection,
// mirroring the legacy $pdo->beginTransaction()/commit()/rollBack(). A dedicated
// pool client is checked out, app.tenant_id is set (so BEFORE-write triggers and
// any RLS behave like withTenant), BEGIN is issued, the callback runs against a
// tenant-aware query fn, then COMMIT on success or ROLLBACK + rethrow on ANY
// error — so a failure NEVER leaves partial deletes. The client is always
// released in finally.
export async function withTenantTransaction<T>(slug: string, fn: (q: TenantTxQuery) => Promise<T>): Promise<T> {
  const tenantId = await tenantIdForSlug(slug);
  const client = await getPool().connect();
  const q: TenantTxQuery = async <R extends RowDataPacket = RowDataPacket>(sql: string, params: unknown[] = []) => {
    const res = await client.query(toPostgresSql(sql), params as unknown[]);
    return res.rows as unknown as R[];
  };
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [String(tenantId ?? 0)]);
    await client.query("BEGIN");
    const result = await fn(q);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.query("SELECT set_config('app.tenant_id', '0', false)").catch(() => {});
    client.release();
  }
}

export async function tenantTable(slug: string, baseTable: string): Promise<TenantTable> {
  const normalizedSlug = normalizeTenantSlug(slug) ?? "";
  const safeBase = sanitizeIdentifier(baseTable);
  if (!safeBase) throw new Error("Tabella non valida.");

  if (await usesSharedTenantTables()) {
    return { name: safeBase, mode: "shared", tenantId: await tenantIdForSlug(normalizedSlug) };
  }

  const prefixed = `${tenantPrefix(normalizedSlug)}${safeBase}`;
  if (normalizedSlug && await tableExists(prefixed)) return { name: prefixed, mode: "prefixed", tenantId: null };
  if (await tableExists(safeBase)) return { name: safeBase, mode: "base", tenantId: null };

  throw new Error(`Tabella ${safeBase} non trovata.`);
}

export async function tenantSelect<T extends RowDataPacket = RowDataPacket>({
  slug,
  table,
  columns = "*",
  where = "",
  params = [],
  orderBy = "",
  limit,
  offset,
}: {
  slug: string;
  table: string;
  columns?: string;
  where?: string;
  params?: unknown[];
  orderBy?: string;
  limit?: number;
  offset?: number;
}): Promise<T[]> {
  const target = await tenantTable(slug, table);
  const clauses: string[] = [];
  const queryParams = [...params];

  if (where.trim()) clauses.push(`(${where})`);
  if (target.mode === "shared" && await columnExists(target.name, "tenant_id")) {
    clauses.unshift("tenant_id = ?");
    queryParams.unshift(target.tenantId ?? 0);
  }

  const sql = [
    `SELECT ${columns} FROM ${quoteIdentifier(target.name)}`,
    clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    orderBy.trim() ? `ORDER BY ${orderBy}` : "",
    limit && limit > 0 ? `LIMIT ${Math.floor(limit)}` : "",
    offset && offset > 0 ? `OFFSET ${Math.floor(offset)}` : "",
  ].filter(Boolean).join(" ");

  return dbQuery<T[]>(sql, queryParams);
}

// Variante tx-aware di tenantInsert: stesso schema-guard/tenant_id, ma esegue
// sull'executor della withTenantTransaction e ritorna l'id via RETURNING (gli
// errori NON vanno mai inghiottiti dentro una tx PG: abortirebbero il resto).
export async function tenantInsertTx(q: TenantTxQuery, table: TenantTable, values: Record<string, unknown>): Promise<number> {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (table.mode === "shared" && table.tenantId && !entries.some(([key]) => key === "tenant_id") && await columnExists(table.name, "tenant_id")) {
    entries.unshift(["tenant_id", table.tenantId]);
  }
  const columns = entries.map(([key]) => quoteIdentifier(key)).join(",");
  const placeholders = entries.map(() => "?").join(",");
  const params = entries.map(([, value]) => value);
  const rows = await q(`INSERT INTO ${quoteIdentifier(table.name)} (${columns}) VALUES (${placeholders}) RETURNING id`, params);
  return Number(rows[0]?.id ?? 0);
}

export async function tenantInsert(table: TenantTable, values: Record<string, unknown>): Promise<number> {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (table.mode === "shared" && table.tenantId && !entries.some(([key]) => key === "tenant_id") && await columnExists(table.name, "tenant_id")) {
    entries.unshift(["tenant_id", table.tenantId]);
  }

  const columns = entries.map(([key]) => quoteIdentifier(key)).join(",");
  const placeholders = entries.map(() => "?").join(",");
  const params = entries.map(([, value]) => value);
  const result = await dbExecute(`INSERT INTO ${quoteIdentifier(table.name)} (${columns}) VALUES (${placeholders})`, params);
  return result.insertId;
}

export async function tenantUpdate({
  slug,
  table,
  id,
  values,
}: {
  slug: string;
  table: string;
  id: number;
  values: Record<string, unknown>;
}): Promise<number> {
  const target = await tenantTable(slug, table);
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (!entries.length) return 0;

  const clauses = [`id = ?`];
  const params = [...entries.map(([, value]) => value), id];
  if (target.mode === "shared" && await columnExists(target.name, "tenant_id")) {
    clauses.push("tenant_id = ?");
    params.push(target.tenantId ?? 0);
  }

  const assignments = entries.map(([key]) => `${quoteIdentifier(key)} = ?`).join(",");
  const result = await dbExecute(`UPDATE ${quoteIdentifier(target.name)} SET ${assignments} WHERE ${clauses.join(" AND ")}`, params);
  return result.affectedRows;
}

export async function tenantDelete({ slug, table, id }: { slug: string; table: string; id: number }): Promise<number> {
  const target = await tenantTable(slug, table);
  const clauses = [`id = ?`];
  const params: unknown[] = [id];
  if (target.mode === "shared" && await columnExists(target.name, "tenant_id")) {
    clauses.push("tenant_id = ?");
    params.push(target.tenantId ?? 0);
  }

  const result = await dbExecute(`DELETE FROM ${quoteIdentifier(target.name)} WHERE ${clauses.join(" AND ")}`, params);
  return result.affectedRows;
}

export async function tableExists(table: string): Promise<boolean> {
  const safe = sanitizeIdentifier(table);
  if (!safe) return false;
  if (tableExistsCache.has(safe)) return tableExistsCache.get(safe) ?? false;

  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ? LIMIT 1",
    [safe],
  );
  const exists = rows.length > 0;
  tableExistsCache.set(safe, exists);
  return exists;
}

export async function columnExists(table: string, column: string): Promise<boolean> {
  const safeTable = sanitizeIdentifier(table);
  const safeColumn = sanitizeIdentifier(column);
  if (!safeTable || !safeColumn) return false;
  const key = `${safeTable}.${safeColumn}`;
  if (columnExistsCache.has(key)) return columnExistsCache.get(key) ?? false;

  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ? LIMIT 1",
    [safeTable, safeColumn],
  );
  const exists = rows.length > 0;
  columnExistsCache.set(key, exists);
  return exists;
}

export async function usesSharedTenantTables(): Promise<boolean> {
  if (sharedTenantTablesCache !== null) return sharedTenantTablesCache;
  sharedTenantTablesCache =
    await columnExists("users", "tenant_id") &&
    await columnExists("permissions", "tenant_id") &&
    await columnExists("role_permissions", "tenant_id");
  return sharedTenantTablesCache;
}

export async function tenantIdForSlug(slug: string): Promise<number | null> {
  const normalizedSlug = normalizeTenantSlug(slug);
  if (!normalizedSlug) return null;
  if (tenantIdCache.has(normalizedSlug)) return tenantIdCache.get(normalizedSlug) ?? null;

  if (!await tableExists("saas_tenants")) {
    tenantIdCache.set(normalizedSlug, null);
    return null;
  }

  const rows = await dbQuery<RowDataPacket[]>("SELECT id FROM saas_tenants WHERE slug = ? LIMIT 1", [normalizedSlug]);
  const id = Number(rows[0]?.id ?? 0) || null;
  tenantIdCache.set(normalizedSlug, id);
  return id;
}

export function quoteIdentifier(identifier: string): string {
  const safe = sanitizeIdentifier(identifier);
  if (!safe) throw new Error("Identificatore SQL non valido.");
  return `"${safe}"`;
}

export function sanitizeIdentifier(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9_]/g, "");
}

function getPool(): pg.Pool {
  if (pool) return pool;
  if (poolError) throw new Error(poolError);

  const cs = connectionString();
  if (!cs) {
    poolError = "Database non configurato.";
    globalForTenantDb.__prenodoPgPoolError = poolError;
    throw new Error(poolError);
  }

  if (!globalForTenantDb.__prenodoPgParsers) {
    // Return timestamp/date/time as raw strings (no tz shift), matching the
    // legacy mysql2 dateStrings behaviour the app code expects.
    const asString = (v: string) => v;
    pg.types.setTypeParser(1114, asString); // timestamp without time zone
    pg.types.setTypeParser(1082, asString); // date
    pg.types.setTypeParser(1083, asString); // time
    pg.types.setTypeParser(1184, asString); // timestamptz
    pg.types.setTypeParser(1700, asString); // numeric (keep precision as string)
    globalForTenantDb.__prenodoPgParsers = true;
  }

  pool = new pg.Pool({
    connectionString: cs,
    ssl: { rejectUnauthorized: false },
    max: 8,
    // Keep connections warm so we re-resolve/reconnect to the Supabase pooler
    // far less often — fewer new connections means fewer transient
    // getaddrinfo ENOTFOUND DNS hiccups that would otherwise surface as errors.
    idleTimeoutMillis: 60000,
    keepAlive: true,
    connectionTimeoutMillis: 15000,
  });
  globalForTenantDb.__prenodoPgPool = pool;

  return pool;
}
