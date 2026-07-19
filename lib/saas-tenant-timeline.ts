import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { dbQuery } from "@/lib/tenant-db";

// TIMELINE unificata del tenant (Fase D pannello, 2026-07-19): fonde in un
// unico feed cronologico audit, diagnostiche, backup, supporto e ordini SMS.
// Tutte le created_at sono CURRENT_TIMESTAMP del DB (stesso frame), quindi
// l'ordinamento per stringa e' coerente; la UI mostra i valori cosi' come
// sono, come le altre tab del pannello.

export type TenantTimelineEvent = {
  at: string;
  kind: "audit" | "health" | "backup" | "support" | "sms";
  title: string;
  detail: string;
  actor: string;
};

const PER_SOURCE_LIMIT = 40;

export async function buildTenantTimeline(tenantId: number, limit = 60): Promise<TenantTimelineEvent[]> {
  if (tenantId <= 0) return [];
  const events: TenantTimelineEvent[] = [];
  const at = (value: unknown) => String(value ?? "").replace("T", " ").slice(0, 19);

  const [audit, health, backups, support, orders] = await Promise.all([
    dbQuery<RowDataPacket[]>(
      `SELECT action, message, actor_email, actor_name, created_at FROM \`saas_tenant_audit_logs\`
        WHERE tenant_id=? ORDER BY id DESC LIMIT ${PER_SOURCE_LIMIT}`,
      [tenantId],
    ).catch(() => []),
    dbQuery<RowDataPacket[]>(
      `SELECT level, errors_count, warnings_count, source, created_at FROM \`saas_tenant_health_checks\`
        WHERE tenant_id=? ORDER BY id DESC LIMIT ${PER_SOURCE_LIMIT}`,
      [tenantId],
    ).catch(() => []),
    dbQuery<RowDataPacket[]>(
      `SELECT reason, backup_size, created_by_email, created_at FROM \`saas_tenant_backups\`
        WHERE tenant_id=? ORDER BY id DESC LIMIT ${PER_SOURCE_LIMIT}`,
      [tenantId],
    ).catch(() => []),
    dbQuery<RowDataPacket[]>(
      `SELECT reason, created_by_email, created_at, used_at, revoked_at FROM \`saas_support_access_tokens\`
        WHERE tenant_id=? ORDER BY id DESC LIMIT ${PER_SOURCE_LIMIT}`,
      [tenantId],
    ).catch(() => []),
    dbQuery<RowDataPacket[]>(
      `SELECT status, credits, amount_gross, note, created_at FROM \`saas_sms_orders\`
        WHERE tenant_id=? ORDER BY id DESC LIMIT ${PER_SOURCE_LIMIT}`,
      [tenantId],
    ).catch(() => []),
  ]);

  for (const row of audit) {
    events.push({
      at: at(row.created_at),
      kind: "audit",
      title: String(row.action ?? ""),
      detail: String(row.message ?? ""),
      actor: String(row.actor_email ?? row.actor_name ?? ""),
    });
  }

  for (const row of health) {
    const level = String(row.level ?? "");
    events.push({
      at: at(row.created_at),
      kind: "health",
      title: `Diagnostica: ${level}`,
      detail: `${Number(row.errors_count ?? 0)} errori, ${Number(row.warnings_count ?? 0)} avvisi (${String(row.source ?? "-")})`,
      actor: "",
    });
  }

  for (const row of backups) {
    events.push({
      at: at(row.created_at),
      kind: "backup",
      title: "Backup creato",
      detail: `${String(row.reason ?? "") || "manuale"} · ${Math.round(Number(row.backup_size ?? 0) / 1024)} KB`,
      actor: String(row.created_by_email ?? ""),
    });
  }

  for (const row of support) {
    const reason = String(row.reason ?? "");
    const actor = String(row.created_by_email ?? "");
    events.push({ at: at(row.created_at), kind: "support", title: "Token supporto creato", detail: reason, actor });
    if (row.used_at) events.push({ at: at(row.used_at), kind: "support", title: "Accesso supporto usato", detail: reason, actor });
    if (row.revoked_at) events.push({ at: at(row.revoked_at), kind: "support", title: "Token supporto revocato", detail: reason, actor });
  }

  for (const row of orders) {
    events.push({
      at: at(row.created_at),
      kind: "sms",
      title: `Ordine SMS ${String(row.status ?? "")}`,
      detail: `${Number(row.credits ?? 0)} crediti · ${String(row.amount_gross ?? "0")} EUR${row.note ? ` · ${String(row.note)}` : ""}`,
      actor: "",
    });
  }

  return events
    .filter((event) => event.at)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, Math.max(1, Math.min(200, limit)));
}
