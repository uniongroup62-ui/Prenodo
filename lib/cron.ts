import "server-only";

import crypto from "node:crypto";
import { businessNowDateTime } from "@/lib/business-datetime";
import type { RowDataPacket } from "@/lib/tenant-db";
import { dbExecute, dbQuery, tableExists } from "@/lib/tenant-db";

// Shared helpers for the Next cron routes that replace the legacy PHP
// cron/*.php scripts. Each job is an /api/cron/<job> route triggered by a
// scheduler (Vercel cron, Supabase pg_cron, or any external scheduler hitting
// the URL with the CRON_SECRET).

// Authorize a cron request. A scheduler must send `Authorization: Bearer
// <CRON_SECRET>` (Vercel cron does this automatically when CRON_SECRET is set)
// or `?key=<CRON_SECRET>`. If CRON_SECRET is unset in local dev requests are
// allowed so the jobs can be exercised manually; in PRODUZIONE la env mancante
// è fail-closed (i cron mutano dati e inviano email/SMS: senza secret non
// devono diventare endpoint pubblici in silenzio).
export function assertCronAuth(request: Request): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") throw new Error("unauthorized");
    return;
  }
  // Confronto timing-safe (come il webhook SMS); ?key= resta per compatibilità
  // con scheduler che non possono impostare header.
  const safeEq = (a: string, b: string): boolean => {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
  };
  const auth = request.headers.get("authorization") ?? "";
  const key = new URL(request.url).searchParams.get("key") ?? "";
  if (safeEq(auth, `Bearer ${secret}`) || safeEq(key, secret)) return;
  throw new Error("unauthorized");
}

// REGISTRO CRON (Fase C pannello, 2026-07-19): ogni job registra esito e
// durata in saas_cron_runs — il pannello mostra "ultima esecuzione/esito" e
// la work queue segnala i job in errore. Senza registro non si sa nemmeno se
// i cron girano. NB: DDL runtime in dialetto POSTGRES (toPostgresSql traduce
// solo backtick/placeholder).
let cronRunsEnsured = false;

export async function ensureCronRunsTable(): Promise<void> {
  if (cronRunsEnsured) return;
  if (!(await tableExists("saas_cron_runs"))) {
    await dbExecute(
      `CREATE TABLE IF NOT EXISTS "saas_cron_runs" (
      "id" SERIAL PRIMARY KEY,
      "job" VARCHAR(60) NOT NULL,
      "status" VARCHAR(10) NOT NULL,
      "started_at" TIMESTAMP NOT NULL,
      "duration_ms" INTEGER NOT NULL DEFAULT 0,
      "message" VARCHAR(500) NULL DEFAULT NULL
    )`,
    );
    await dbExecute(`CREATE INDEX IF NOT EXISTS "idx_saas_cron_runs_job" ON "saas_cron_runs" ("job", "id")`).catch(() => undefined);
  }
  cronRunsEnsured = true;
}

// Wrapper per i route cron: esegue l'handler originale, legge l'esito dalla
// Response (status HTTP + campo ok del payload) e registra la riga con
// durata e sintesi. Best-effort: un problema di INSERT non rompe il job.
// I 401 non arrivano qui (l'auth respinge PRIMA del tracking).
export async function trackCronResponse(job: string, work: () => Promise<Response>): Promise<Response> {
  const startedAt = localSqlNow();
  const t0 = Date.now();
  let response: Response;
  try {
    response = await work();
  } catch (error) {
    await recordRun(job, "error", startedAt, Date.now() - t0, error instanceof Error ? error.message : "Errore");
    throw error;
  }
  let status: "ok" | "error" = response.status === 200 ? "ok" : "error";
  let message = "";
  try {
    const data = await response.clone().json();
    message = summarize(data);
    if (data && typeof data === "object" && (data as { ok?: boolean }).ok === false) status = "error";
  } catch {
    // payload non-JSON: basta lo status HTTP
  }
  await recordRun(job, status, startedAt, Date.now() - t0, message);
  return response;
}

export async function listCronRuns(limit = 30): Promise<{ runs: RowDataPacket[]; jobs: RowDataPacket[] }> {
  await ensureCronRunsTable();
  const capped = Math.max(1, Math.min(100, limit));
  const runs = await dbQuery<RowDataPacket[]>(`SELECT * FROM \`saas_cron_runs\` ORDER BY id DESC LIMIT ${capped}`).catch(() => []);
  // Ultima esecuzione PER JOB (stato corrente di ogni cron).
  const jobs = await dbQuery<RowDataPacket[]>(
    `SELECT r.* FROM \`saas_cron_runs\` r
      WHERE r.id = (SELECT MAX(r2.id) FROM \`saas_cron_runs\` r2 WHERE r2.job = r.job)
      ORDER BY r.job ASC`,
  ).catch(() => []);
  return { runs, jobs };
}

async function recordRun(job: string, status: "ok" | "error", startedAt: string, durationMs: number, message: string): Promise<void> {
  try {
    await ensureCronRunsTable();
    await dbExecute(
      "INSERT INTO `saas_cron_runs`(job,status,started_at,duration_ms,message) VALUES(?,?,?,?,?)",
      [job.slice(0, 60), status, startedAt, Math.max(0, Math.round(durationMs)), message.slice(0, 500) || null],
    );
  } catch {
    // registro best-effort
  }
}

function summarize(result: unknown): string {
  if (result === undefined || result === null) return "";
  try {
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch {
    return "";
  }
}

function localSqlNow(): string {
  // Wall-time ROMA (audit 21/07): il registro cron va letto nel pannello con
  // la stessa convenzione oraria del resto dell'app, non con l'ora del server.
  return businessNowDateTime();
}

// The Next equivalent of the PHP cron_active_tenants(): every active tenant.
export async function activeTenantSlugs(): Promise<string[]> {
  const rows = await dbQuery<RowDataPacket[]>(
    "SELECT slug FROM saas_tenants WHERE COALESCE(is_active, 1) = 1 ORDER BY slug ASC",
  );
  return rows
    .map((row) => String(row.slug ?? "").trim().toLowerCase())
    .filter(Boolean);
}
