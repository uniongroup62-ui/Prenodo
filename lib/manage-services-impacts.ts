import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { columnExists, dbExecute, dbQuery, quoteIdentifier, tenantTable } from "@/lib/tenant-db";

// ============================================================================
// Port 1:1 della pipeline impatti/blocchi/snapshot di services.php (righe
// 732-3090): svc_fetch_impacted_appointments, svc_service_name_update_impacts,
// svc_delete_blockers, svc_service_deactivation_blockers,
// svc_apply_service_name_snapshot_updates, svc_service_price_update_impacts,
// svc_apply_service_price_catalog_updates, freeze degli snapshot storici.
// Tutte le query sono best-effort (tabella/colonna assente -> gruppo saltato),
// come i try/catch silenziosi del legacy.
// ============================================================================

export type ServiceImpactRow = { group: string; title: string; detail: string };

export type ImpactedAppointment = {
  id: number;
  publicCode: string;
  startsAt: string;
  status: string;
  clientName: string;
  serviceName: string;
};

type Table = Awaited<ReturnType<typeof tenantTable>>;

const APPT_OPEN_STATUSES = ["pending", "scheduled", "in sospeso", "prenotato"];

async function t(slug: string, name: string): Promise<Table | null> {
  return tenantTable(slug, name).catch(() => null);
}

function tenantClause(table: Table, alias = ""): { sql: string; params: unknown[] } {
  const prefix = alias ? `${alias}.` : "";
  if (table.mode === "shared") return { sql: ` AND ${prefix}tenant_id = ?`, params: [table.tenantId ?? 0] };
  return { sql: "", params: [] };
}

// svc_compact_label: spazi normalizzati, troncato con ellissi U+2026.
function compactLabel(value: unknown, max = 140): string {
  const v = String(value ?? "").replace(/\s+/g, " ").trim();
  if (v.length <= max) return v;
  return `${v.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

// svc_impact_add: default 'Associazione'/'Elemento collegato' + dedupe.
function impactAdd(out: ServiceImpactRow[], seen: Set<string>, group: string, title: string, detail = ""): void {
  const g = compactLabel(group, 90) || "Associazione";
  const ti = compactLabel(title, 180) || "Elemento collegato";
  const d = compactLabel(detail, 260);
  const key = `${g}|${ti}|${d}`.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ group: g, title: ti, detail: d });
}

// svc_generic_status_label.
export function genericStatusLabel(status: unknown): string {
  const s = String(status ?? "").trim().toLowerCase();
  if (["active", "attivo", "issued"].includes(s)) return "Attivo";
  if (["expired", "scaduto", "scaduta"].includes(s)) return "Scaduto";
  if (["draft", "bozza"].includes(s)) return "Bozza";
  if (["accepted", "accettato", "accettata"].includes(s)) return "Accettato";
  if (["rejected", "rifiutato", "rifiutata", "refused", "declined"].includes(s)) return "Rifiutato";
  if (["pending", "in sospeso"].includes(s)) return "In sospeso";
  if (["scheduled", "prenotato"].includes(s)) return "Prenotato";
  if (["done", "eseguito", "completed", "completato"].includes(s)) return "Eseguito";
  if (["canceled", "cancelled", "annullato", "annullata"].includes(s)) return "Annullato";
  if (s === "") return "—";
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");
}

// svc_status_meta: badge per gli appuntamenti nel pannello di conferma.
export function serviceStatusMeta(status: unknown): { class: string; label: string } {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "scheduled" || s === "prenotato") return { class: "primary", label: "Prenotato" };
  if (s === "pending" || s === "in sospeso") return { class: "warning", label: "In sospeso" };
  if (s === "done" || s === "eseguito") return { class: "success", label: "Eseguito" };
  if (s === "canceled" || s === "cancelled" || s === "annullato") return { class: "secondary", label: "Annullato" };
  return { class: "secondary", label: s ? s.charAt(0).toUpperCase() + s.slice(1) : "Sconosciuto" };
}

function dmyHm(value: unknown): string {
  const raw = value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")} ${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`
    : String(value ?? "");
  const s = raw.replace("T", " ");
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return "";
  const hm = s.length >= 16 ? s.slice(11, 16) : "00:00";
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)} ${hm}`;
}

function dmy(value: unknown): string {
  const full = dmyHm(value);
  return full ? full.slice(0, 10) : "";
}

// svc_fetch_impacted_appointments: appuntamenti aperti (4 stati, sinonimi IT
// compresi) collegati al servizio via appointment_services / service_id legacy
// / appointment_segments. Ordine starts_at ASC, id ASC, nessun LIMIT.
export async function fetchImpactedAppointments(slug: string, serviceId: number): Promise<ImpactedAppointment[]> {
  if (serviceId <= 0) return [];
  const appt = await t(slug, "appointments");
  if (!appt) return [];
  const clients = await t(slug, "clients");
  const aps = await t(slug, "appointment_services");
  const services = await t(slug, "services");
  const segments = await t(slug, "appointment_segments");
  const scope = tenantClause(appt, "a");

  const hasPublicCode = await columnExists(appt.name, "public_code");
  const clientExpr = clients ? "c.full_name" : "CONCAT('Cliente #', a.client_id)";
  const clientJoin = clients ? `LEFT JOIN ${quoteIdentifier(clients.name)} c ON c.id = a.client_id` : "";

  try {
    if (aps && services) {
      const segExists = segments
        ? ` OR EXISTS (SELECT 1 FROM ${quoteIdentifier(segments.name)} sg WHERE sg.appointment_id = a.id AND sg.service_id = ?)`
        : "";
      const rows = await dbQuery<RowDataPacket[]>(
        `SELECT DISTINCT a.id, ${hasPublicCode ? "a.public_code" : "NULL"} AS public_code, a.starts_at, a.status,
                ${clientExpr} AS client_name,
                COALESCE(s.name, s_legacy.name) AS service_name
           FROM ${quoteIdentifier(appt.name)} a
           ${clientJoin}
           LEFT JOIN ${quoteIdentifier(aps.name)} aps ON aps.appointment_id = a.id AND aps.service_id = ?
           LEFT JOIN ${quoteIdentifier(services.name)} s ON s.id = aps.service_id
           LEFT JOIN ${quoteIdentifier(services.name)} s_legacy ON s_legacy.id = a.service_id
          WHERE LOWER(TRIM(COALESCE(a.status,''))) IN (${APPT_OPEN_STATUSES.map(() => "?").join(",")})${scope.sql}
            AND (aps.service_id IS NOT NULL
                 OR (a.service_id = ? AND NOT EXISTS (SELECT 1 FROM ${quoteIdentifier(aps.name)} aps2 WHERE aps2.appointment_id = a.id))${segExists})
          ORDER BY a.starts_at ASC, a.id ASC`,
        [serviceId, ...APPT_OPEN_STATUSES, ...scope.params, serviceId, ...(segments ? [serviceId] : [])],
      );
      return rows.map(mapImpactedAppointment);
    }
  } catch { /* fallback sotto */ }

  try {
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT a.id, ${hasPublicCode ? "a.public_code" : "NULL"} AS public_code, a.starts_at, a.status,
              ${clientExpr} AS client_name,
              CONCAT('Servizio #', a.service_id) AS service_name
         FROM ${quoteIdentifier(appt.name)} a
         ${clientJoin}
        WHERE a.service_id = ? AND LOWER(TRIM(COALESCE(a.status,''))) IN (${APPT_OPEN_STATUSES.map(() => "?").join(",")})${scope.sql}
        ORDER BY a.starts_at ASC, a.id ASC`,
      [serviceId, ...APPT_OPEN_STATUSES, ...scope.params],
    );
    return rows.map(mapImpactedAppointment);
  } catch {
    return [];
  }
}

function mapImpactedAppointment(row: RowDataPacket): ImpactedAppointment {
  return {
    id: Number(row.id ?? 0),
    publicCode: String(row.public_code ?? "").trim(),
    startsAt: row.starts_at instanceof Date
      ? `${dmyHm(row.starts_at)}`.split("/").length > 1 ? isoFromDate(row.starts_at) : ""
      : String(row.starts_at ?? ""),
    status: String(row.status ?? ""),
    clientName: String(row.client_name ?? "").trim(),
    serviceName: String(row.service_name ?? "").trim(),
  };
}

function isoFromDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:00`;
}

function appointmentImpactDetail(appt: ImpactedAppointment): string {
  let detail = `Stato: ${genericStatusLabel(appt.status)}`;
  const when = dmyHm(appt.startsAt);
  if (when) detail += ` • ${when}`;
  if (appt.clientName) detail += ` • Cliente: ${appt.clientName}`;
  return detail;
}

function appointmentImpactTitle(appt: ImpactedAppointment): string {
  const code = appt.publicCode !== "" ? appt.publicCode : `#${appt.id}`;
  return `Prenotazione ${code}`;
}

// svc_json_has_service_ref: scan ricorsivo del JSON per riferimenti al servizio.
export function jsonHasServiceRef(json: unknown, serviceId: number): boolean {
  let parsed: unknown;
  try { parsed = typeof json === "string" ? JSON.parse(json) : json; } catch { return false; }
  const walk = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(walk);
    if (!node || typeof node !== "object") return false;
    const o = node as Record<string, unknown>;
    for (const key of ["service_id", "reward_service_id", "target_service_id"]) {
      if (Number(o[key] ?? 0) === serviceId) return true;
    }
    const type = String(o.type ?? o.item_type ?? o.reward_type ?? "").toLowerCase();
    if (type === "service" && (Number(o.item_id ?? 0) === serviceId || Number(o.id ?? 0) === serviceId)) return true;
    return Object.values(o).some(walk);
  };
  return walk(parsed);
}

// svc_json_update_service_name: sostituisce le etichette nei nodi "service".
export function jsonUpdateServiceName(json: unknown, serviceId: number, newName: string): string | null {
  let parsed: unknown;
  try { parsed = typeof json === "string" ? JSON.parse(json) : json; } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  let changed = false;
  const isServiceNode = (o: Record<string, unknown>): boolean => {
    for (const key of ["service_id", "reward_service_id", "target_service_id"]) {
      if (Number(o[key] ?? 0) === serviceId) return true;
    }
    const type = String(o.type ?? o.item_type ?? o.reward_type ?? "").toLowerCase();
    return type === "service" && (Number(o.item_id ?? 0) === serviceId || Number(o.id ?? 0) === serviceId);
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== "object") return;
    const o = node as Record<string, unknown>;
    if (isServiceNode(o)) {
      for (const key of ["service_name", "name", "label", "item_name", "title", "custom_label"]) {
        if (typeof o[key] === "string" && o[key] !== newName && String(o[key]).trim() !== "") {
          o[key] = newName;
          changed = true;
        }
      }
    }
    Object.values(o).forEach(walk);
  };
  walk(parsed);
  return changed ? JSON.stringify(parsed) : null;
}

// svc_snapshot_json_update_name: aggiorna 'name' se service_id combacia; version>=3.
function snapshotJsonUpdateName(json: unknown, serviceId: number, newName: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    const p = typeof json === "string" ? JSON.parse(json) : json;
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    parsed = p as Record<string, unknown>;
  } catch { return null; }
  if (Number(parsed.service_id ?? 0) !== serviceId) return null;
  if (String(parsed.name ?? "") === newName) return null;
  parsed.name = newName;
  parsed.version = Math.max(3, Number(parsed.version ?? 0) || 0);
  return JSON.stringify(parsed);
}

// ---------------------------------------------------------------------------
// IMPATTI CAMBIO NOME (svc_service_name_update_impacts, 9 gruppi)
// ---------------------------------------------------------------------------
export async function serviceNameUpdateImpacts(slug: string, serviceId: number): Promise<ServiceImpactRow[]> {
  const out: ServiceImpactRow[] = [];
  const seen = new Set<string>();
  if (serviceId <= 0) return out;

  // a) Prenotazioni aperte.
  for (const appt of await fetchImpactedAppointments(slug, serviceId)) {
    impactAdd(out, seen, "Prenotazioni in sospeso/prenotate", appointmentImpactTitle(appt), appointmentImpactDetail(appt));
  }

  // b) GiftBox attive/scadute con vendita collegata.
  await (async () => {
    const gbi = await t(slug, "giftbox_instances");
    const gii = await t(slug, "giftbox_instance_items");
    const gb = await t(slug, "giftboxes");
    const si = await t(slug, "sale_items");
    if (!gbi || !gii || !si) return;
    const scope = tenantClause(gbi, "gbi");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT DISTINCT gbi.id, gbi.code, gbi.status, ${gb ? "gb.name" : "NULL"} AS box_name, si.sale_id
         FROM ${quoteIdentifier(gbi.name)} gbi
         JOIN ${quoteIdentifier(gii.name)} gii ON gii.instance_id = gbi.id
         ${gb ? `LEFT JOIN ${quoteIdentifier(gb.name)} gb ON gb.id = gbi.giftbox_id` : ""}
         LEFT JOIN ${quoteIdentifier(si.name)} si ON si.item_name LIKE CONCAT('%', gbi.code, '%')
        WHERE LOWER(TRIM(COALESCE(gbi.status,''))) IN ('issued','active','expired','scaduto','scaduta')
          AND LOWER(TRIM(COALESCE(gii.item_type,''))) = 'service' AND gii.service_id = ?
          AND si.sale_id IS NOT NULL${scope.sql}
        LIMIT 40`,
      [serviceId, ...scope.params],
    ).catch(() => [] as RowDataPacket[]);
    for (const row of rows) {
      const code = String(row.code ?? "").trim() || `#${Number(row.id ?? 0)}`;
      const name = String(row.box_name ?? "").trim();
      impactAdd(out, seen, "GiftBox attive/scadute", `GiftBox ${code}${name ? ` • ${name}` : ""}`, `Stato: ${genericStatusLabel(row.status)} • Dettaglio vendita #${Number(row.sale_id ?? 0)}`);
    }
  })();

  // c) Preventivi bozza/accettati/rifiutati.
  await (async () => {
    const quotes = await t(slug, "quotes");
    const items = await t(slug, "quote_items");
    const clients = await t(slug, "clients");
    if (!quotes || !items) return;
    const scope = tenantClause(quotes, "q");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT DISTINCT q.id, q.number, q.status, ${clients ? "c.full_name" : "NULL"} AS client_name
         FROM ${quoteIdentifier(quotes.name)} q
         JOIN ${quoteIdentifier(items.name)} qi ON qi.quote_id = q.id
         ${clients ? `LEFT JOIN ${quoteIdentifier(clients.name)} c ON c.id = q.client_id` : ""}
        WHERE LOWER(TRIM(COALESCE(q.status,''))) IN ('draft','bozza','accepted','accettato','accettata','rejected','rifiutato','rifiutata','refused','declined')
          AND LOWER(TRIM(COALESCE(qi.item_type,''))) = 'service' AND qi.item_id = ?${scope.sql}
        LIMIT 40`,
      [serviceId, ...scope.params],
    ).catch(() => [] as RowDataPacket[]);
    for (const row of rows) {
      const number = String(row.number ?? "").trim() || `#${Number(row.id ?? 0)}`;
      const client = String(row.client_name ?? "").trim();
      impactAdd(out, seen, "Preventivi bozza/accettati/rifiutati", `Preventivo ${number}`, `Stato: ${genericStatusLabel(row.status)}${client ? ` • Cliente: ${client}` : ""}`);
    }
  })();

  // d) Pacchetti cliente attivi/scaduti.
  for (const row of await clientPackagesForService(slug, serviceId, ["active", "attivo", "expired", "scaduto", "scaduta"], 60)) {
    let statusLabel = genericStatusLabel(row.status);
    if (row.expired) statusLabel = "Scaduto";
    impactAdd(out, seen, "Pacchetti attivi/scaduti", `${row.name} (CP#${row.id})`, `Stato: ${statusLabel}${row.clientName ? ` • Cliente: ${row.clientName}` : ""}`);
  }

  // e) Catalogo pacchetti (tutti).
  await (async () => {
    const packages = await t(slug, "packages");
    const ps = await t(slug, "package_services");
    if (!packages || !ps) return;
    const scope = tenantClause(packages, "p");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT DISTINCT p.id, p.name, COALESCE(p.is_active,1) AS is_active
         FROM ${quoteIdentifier(packages.name)} p
         JOIN ${quoteIdentifier(ps.name)} ps ON ps.package_id = p.id
        WHERE ps.service_id = ?${scope.sql}
        LIMIT 40`,
      [serviceId, ...scope.params],
    ).catch(() => [] as RowDataPacket[]);
    for (const row of rows) {
      const name = String(row.name ?? "").trim() || `Pacchetto #${Number(row.id ?? 0)}`;
      impactAdd(out, seen, "Catalogo pacchetti", name, Number(row.is_active ?? 1) === 1 ? "Catalogo pacchetti attivo" : "Catalogo pacchetti disattivo");
    }
  })();

  // f) Prepagati attivi con vendita.
  for (const row of await prepaidsForService(slug, serviceId, true, 40)) {
    impactAdd(out, seen, "Servizi prepagati da eseguire", `Prepagato #${row.id}`, `Residuo: ${row.remainingQty}${row.clientName ? ` • Cliente: ${row.clientName}` : ""}${row.saleId ? ` • Vendita #${row.saleId}` : ""}`);
  }

  // g) Omaggi disponibili.
  for (const row of await availableGiftInstancesForService(slug, serviceId)) {
    impactAdd(out, seen, "Omaggi disponibili", `${row.giftName} (istanza #${row.id})`, `omaggio disponibile non ancora riscattato${row.clientName ? ` • Cliente: ${row.clientName}` : ""}`);
  }

  // h) Campagne gift attive/disattive (premio / regole / premi multipli).
  for (const row of await giftCampaignsForService(slug, serviceId, false)) {
    impactAdd(out, seen, "Campagne gift attive/disattive", row.name, `${row.active ? "Attiva" : "Disattiva"} • ${row.roleDetail}`);
  }

  // i) Campagne promozioni attive/disattive.
  for (const row of await promotionsForService(slug, serviceId, false, 60)) {
    impactAdd(out, seen, "Campagne promozioni attive/disattive", row.name, `${row.active ? "Attiva" : "Disattiva"} • ${row.scopeAll ? "Campagna su tutti i servizi" : "Servizio selezionato nella campagna"}`);
  }

  return out;
}

// ---------------------------------------------------------------------------
// BLOCCHI ELIMINAZIONE (svc_delete_blockers, elementi APERTI/ATTIVI)
// ---------------------------------------------------------------------------
export async function serviceDeleteBlockersLegacy(slug: string, serviceId: number): Promise<ServiceImpactRow[]> {
  const out: ServiceImpactRow[] = [];
  const seen = new Set<string>();
  if (serviceId <= 0) return out;

  // a) Prenotazioni aperte (primi 30).
  for (const appt of (await fetchImpactedAppointments(slug, serviceId)).slice(0, 30)) {
    impactAdd(out, seen, "Prenotazioni in sospeso/prenotate", appointmentImpactTitle(appt), appointmentImpactDetail(appt));
  }

  // b) Prepagati attivi (senza condizione vendita).
  for (const row of await prepaidsForService(slug, serviceId, false, 30)) {
    impactAdd(out, seen, "Servizi prepagati da eseguire", `Prepagato #${row.id}`, `Residuo: ${row.remainingQty}${row.clientName ? ` • Cliente: ${row.clientName}` : ""}${row.saleId ? ` • Vendita #${row.saleId}` : ""}`);
  }

  // c) Pacchetti cliente ATTIVI non scaduti.
  for (const row of await clientPackagesForService(slug, serviceId, ["active", "attivo"], 40, true)) {
    impactAdd(out, seen, "Pacchetti attivi", `${row.name} (CP#${row.id})`, `Pacchetto cliente attivo${row.clientName ? ` • Cliente: ${row.clientName}` : ""}`);
  }

  // d) Catalogo pacchetti ATTIVO.
  await (async () => {
    const packages = await t(slug, "packages");
    const ps = await t(slug, "package_services");
    if (!packages || !ps) return;
    const scope = tenantClause(packages, "p");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT DISTINCT p.id, p.name
         FROM ${quoteIdentifier(packages.name)} p
         JOIN ${quoteIdentifier(ps.name)} ps ON ps.package_id = p.id
        WHERE COALESCE(p.is_active,1) = 1 AND ps.service_id = ?${scope.sql}
        LIMIT 30`,
      [serviceId, ...scope.params],
    ).catch(() => [] as RowDataPacket[]);
    for (const row of rows) {
      impactAdd(out, seen, "Catalogo pacchetti", String(row.name ?? "").trim() || `Pacchetto #${Number(row.id ?? 0)}`, "Pacchetto del catalogo attivo");
    }
  })();

  // e) Preventivi ACCETTATI.
  await (async () => {
    const quotes = await t(slug, "quotes");
    const items = await t(slug, "quote_items");
    const clients = await t(slug, "clients");
    if (!quotes || !items) return;
    const scope = tenantClause(quotes, "q");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT DISTINCT q.id, q.number, ${clients ? "c.full_name" : "NULL"} AS client_name
         FROM ${quoteIdentifier(quotes.name)} q
         JOIN ${quoteIdentifier(items.name)} qi ON qi.quote_id = q.id
         ${clients ? `LEFT JOIN ${quoteIdentifier(clients.name)} c ON c.id = q.client_id` : ""}
        WHERE LOWER(TRIM(COALESCE(q.status,''))) IN ('accepted','accettato','accettata')
          AND LOWER(TRIM(COALESCE(qi.item_type,''))) = 'service' AND qi.item_id = ?${scope.sql}
        LIMIT 30`,
      [serviceId, ...scope.params],
    ).catch(() => [] as RowDataPacket[]);
    for (const row of rows) {
      const number = String(row.number ?? "").trim() || `#${Number(row.id ?? 0)}`;
      const client = String(row.client_name ?? "").trim();
      impactAdd(out, seen, "Preventivi accettati", `Preventivo ${number}`, `Preventivo in stato Accettato${client ? ` • Cliente: ${client}` : ""}`);
    }
  })();

  // f) GiftBox catalogo ATTIVO.
  await (async () => {
    const gb = await t(slug, "giftboxes");
    const gi = await t(slug, "giftbox_items");
    if (!gb || !gi) return;
    const scope = tenantClause(gb, "gb");
    const hasDeleted = await columnExists(gb.name, "deleted_at");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT DISTINCT gb.id, gb.name
         FROM ${quoteIdentifier(gb.name)} gb
         JOIN ${quoteIdentifier(gi.name)} gi ON gi.giftbox_id = gb.id
        WHERE COALESCE(gb.active,1) = 1${hasDeleted ? " AND gb.deleted_at IS NULL" : ""}
          AND LOWER(TRIM(COALESCE(gi.item_type,''))) = 'service' AND gi.service_id = ?${scope.sql}
        LIMIT 30`,
      [serviceId, ...scope.params],
    ).catch(() => [] as RowDataPacket[]);
    for (const row of rows) {
      impactAdd(out, seen, "GiftBox attive", String(row.name ?? "").trim() || `GiftBox #${Number(row.id ?? 0)}`, "Catalogo GiftBox attivo");
    }
  })();

  // g) GiftBox istanze ATTIVE.
  await (async () => {
    const gbi = await t(slug, "giftbox_instances");
    const gii = await t(slug, "giftbox_instance_items");
    const gb = await t(slug, "giftboxes");
    if (!gbi || !gii) return;
    const scope = tenantClause(gbi, "gbi");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT DISTINCT gbi.id, gbi.code, ${gb ? "gb.name" : "NULL"} AS box_name
         FROM ${quoteIdentifier(gbi.name)} gbi
         JOIN ${quoteIdentifier(gii.name)} gii ON gii.instance_id = gbi.id
         ${gb ? `LEFT JOIN ${quoteIdentifier(gb.name)} gb ON gb.id = gbi.giftbox_id` : ""}
        WHERE LOWER(TRIM(COALESCE(gbi.status,''))) IN ('issued','active')
          AND (gbi.expires_at IS NULL OR gbi.expires_at >= NOW())
          AND LOWER(TRIM(COALESCE(gii.item_type,''))) = 'service' AND gii.service_id = ?${scope.sql}
        LIMIT 30`,
      [serviceId, ...scope.params],
    ).catch(() => [] as RowDataPacket[]);
    for (const row of rows) {
      const code = String(row.code ?? "").trim() || `#${Number(row.id ?? 0)}`;
      const name = String(row.box_name ?? "").trim();
      impactAdd(out, seen, "GiftBox attive", `GiftBox ${code}`, `GiftBox assegnata attiva${name ? ` • ${name}` : ""}`);
    }
  })();

  // h) Omaggi disponibili.
  for (const row of await availableGiftInstancesForService(slug, serviceId)) {
    impactAdd(out, seen, "Omaggi disponibili", `${row.giftName} (istanza #${row.id})`, `omaggio disponibile non ancora riscattato${row.clientName ? ` • Cliente: ${row.clientName}` : ""}`);
  }

  // i) Promozioni ATTIVE in corso.
  for (const row of await promotionsForService(slug, serviceId, true, 30)) {
    impactAdd(out, seen, "Campagne promozioni attive", row.name, row.scopeAll ? "Campagna attiva su tutti i servizi" : "Campagna attiva con servizio selezionato");
  }

  // j) Campagne gift ATTIVE in corso.
  for (const row of await giftCampaignsForService(slug, serviceId, true)) {
    impactAdd(out, seen, "Campagne gift attive", row.name, row.roleDetail);
  }

  return out;
}

// ---------------------------------------------------------------------------
// BLOCCHI DISATTIVAZIONE (svc_service_deactivation_blockers)
// ---------------------------------------------------------------------------
export async function serviceDeactivationBlockers(slug: string, serviceId: number): Promise<ServiceImpactRow[]> {
  const out: ServiceImpactRow[] = [];
  const seen = new Set<string>();
  if (serviceId <= 0) return out;

  for (const row of await promotionsForService(slug, serviceId, true, 50)) {
    let detail = row.scopeAll ? "Campagna attiva su tutti i servizi" : "Campagna attiva con questo servizio selezionato";
    if (row.startsAt || row.endsAt) detail += ` • Validità: ${dmy(row.startsAt) || "—"} - ${dmy(row.endsAt) || "—"}`;
    impactAdd(out, seen, "Campagne Promozione attive", row.name, detail);
  }

  for (const row of await giftCampaignsForService(slug, serviceId, true)) {
    let detail = row.roleDetail;
    if (row.validFrom || row.validTo) detail += ` • Validità: ${dmy(row.validFrom) || "—"} - ${dmy(row.validTo) || "—"}`;
    impactAdd(out, seen, "Campagne gift attive", row.name, detail);
  }

  return out;
}

// ---------------------------------------------------------------------------
// IMPATTI CAMBIO PREZZO (svc_service_price_update_impacts)
// ---------------------------------------------------------------------------
export async function servicePriceUpdateImpacts(slug: string, serviceId: number): Promise<ServiceImpactRow[]> {
  const out: ServiceImpactRow[] = [];
  const seen = new Set<string>();
  if (serviceId <= 0) return out;

  const packages = await t(slug, "packages");
  if (packages) {
    const scope = tenantClause(packages, "p");
    const pi = await t(slug, "package_items");
    if (pi) {
      const rows = await dbQuery<RowDataPacket[]>(
        `SELECT DISTINCT p.id, p.name, COALESCE(p.is_active,1) AS is_active
           FROM ${quoteIdentifier(packages.name)} p
           JOIN ${quoteIdentifier(pi.name)} pi ON pi.package_id = p.id
          WHERE LOWER(TRIM(COALESCE(pi.item_type,''))) = 'service' AND pi.item_id = ?${scope.sql}
          LIMIT 60`,
        [serviceId, ...scope.params],
      ).catch(() => [] as RowDataPacket[]);
      for (const row of rows) {
        impactAdd(out, seen, "Catalogo pacchetti", String(row.name ?? "").trim() || `Pacchetto #${Number(row.id ?? 0)}`, `${Number(row.is_active ?? 1) === 1 ? "Catalogo attivo" : "Catalogo disattivo"} • Verrà aggiornato solo il prezzo nel catalogo`);
      }
    }
    const ps = await t(slug, "package_services");
    if (ps) {
      const rows = await dbQuery<RowDataPacket[]>(
        `SELECT DISTINCT p.id, p.name, COALESCE(p.is_active,1) AS is_active
           FROM ${quoteIdentifier(packages.name)} p
           JOIN ${quoteIdentifier(ps.name)} ps ON ps.package_id = p.id
          WHERE ps.service_id = ?${scope.sql}
          LIMIT 60`,
        [serviceId, ...scope.params],
      ).catch(() => [] as RowDataPacket[]);
      for (const row of rows) {
        impactAdd(out, seen, "Catalogo pacchetti", String(row.name ?? "").trim() || `Pacchetto #${Number(row.id ?? 0)}`, `${Number(row.is_active ?? 1) === 1 ? "Catalogo attivo" : "Catalogo disattivo"} • Servizio incluso nel catalogo`);
      }
    }
    if (await columnExists(packages.name, "service_id")) {
      const rows = await dbQuery<RowDataPacket[]>(
        `SELECT p.id, p.name, COALESCE(p.is_active,1) AS is_active
           FROM ${quoteIdentifier(packages.name)} p
          WHERE p.service_id = ?${scope.sql}
          LIMIT 60`,
        [serviceId, ...scope.params],
      ).catch(() => [] as RowDataPacket[]);
      for (const row of rows) {
        impactAdd(out, seen, "Catalogo pacchetti", String(row.name ?? "").trim() || `Pacchetto #${Number(row.id ?? 0)}`, `${Number(row.is_active ?? 1) === 1 ? "Catalogo attivo" : "Catalogo disattivo"} • Pacchetto legacy collegato al servizio`);
      }
    }
  }

  for (const row of await promotionsForService(slug, serviceId, false, 80)) {
    let detail = `${row.active ? "Attiva" : "Disattiva"} • ${row.scopeAll ? "Campagna su tutti i servizi" : "Servizio selezionato nella campagna"}`;
    if (row.legacyPriceMode) detail += " • Prezzo target legacy riallineato";
    impactAdd(out, seen, "Campagne promozioni", row.name, detail);
  }

  return out;
}

// ---------------------------------------------------------------------------
// APPLY CAMBIO NOME (svc_apply_service_name_snapshot_updates)
// ---------------------------------------------------------------------------
export async function applyServiceNameSnapshotUpdates(slug: string, serviceId: number, newName: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = { appointments: 0, appointment_segments: 0, quotes: 0, client_prepaids: 0, client_packages: 0, giftboxes: 0, gifts_json: 0 };
  if (serviceId <= 0 || newName.trim() === "") return counts;
  const name = newName.trim();

  const appt = await t(slug, "appointments");
  const aps = await t(slug, "appointment_services");
  if (appt && aps) {
    const scope = tenantClause(aps);
    // a) service_name delle righe di prenotazioni aperte.
    const res = await dbExecute(
      `UPDATE ${quoteIdentifier(aps.name)} SET service_name = ?
        WHERE service_id = ?${scope.sql}
          AND appointment_id IN (SELECT id FROM ${quoteIdentifier(appt.name)} WHERE LOWER(TRIM(COALESCE(status,''))) IN (${APPT_OPEN_STATUSES.map(() => "?").join(",")})${appt.mode === "shared" ? " AND tenant_id = ?" : ""})`,
      [name, serviceId, ...scope.params, ...APPT_OPEN_STATUSES, ...(appt.mode === "shared" ? [appt.tenantId ?? 0] : [])],
    ).catch(() => ({ affectedRows: 0, insertId: 0 }));
    counts.appointments += res.affectedRows;

    // b) service_snapshot_json (per riga, solo se combacia service_id).
    if (await columnExists(aps.name, "service_snapshot_json")) {
      const rows = await dbQuery<RowDataPacket[]>(
        `SELECT appointment_id, service_id, service_snapshot_json FROM ${quoteIdentifier(aps.name)}
          WHERE service_id = ? AND service_snapshot_json IS NOT NULL${scope.sql}
            AND appointment_id IN (SELECT id FROM ${quoteIdentifier(appt.name)} WHERE LOWER(TRIM(COALESCE(status,''))) IN (${APPT_OPEN_STATUSES.map(() => "?").join(",")})${appt.mode === "shared" ? " AND tenant_id = ?" : ""})`,
        [serviceId, ...scope.params, ...APPT_OPEN_STATUSES, ...(appt.mode === "shared" ? [appt.tenantId ?? 0] : [])],
      ).catch(() => [] as RowDataPacket[]);
      for (const row of rows) {
        const updated = snapshotJsonUpdateName(row.service_snapshot_json, serviceId, name);
        if (!updated) continue;
        await dbExecute(
          `UPDATE ${quoteIdentifier(aps.name)} SET service_snapshot_json = ? WHERE appointment_id = ? AND service_id = ?${scope.sql}`,
          [updated, Number(row.appointment_id ?? 0), serviceId, ...scope.params],
        ).catch(() => undefined);
      }
    }
  }

  // c) appointment_segments.service_name.
  const segments = await t(slug, "appointment_segments");
  if (appt && segments && await columnExists(segments.name, "service_name")) {
    const scope = tenantClause(segments);
    const res = await dbExecute(
      `UPDATE ${quoteIdentifier(segments.name)} SET service_name = ?
        WHERE service_id = ?${scope.sql}
          AND appointment_id IN (SELECT id FROM ${quoteIdentifier(appt.name)} WHERE LOWER(TRIM(COALESCE(status,''))) IN (${APPT_OPEN_STATUSES.map(() => "?").join(",")})${appt.mode === "shared" ? " AND tenant_id = ?" : ""})`,
      [name, serviceId, ...scope.params, ...APPT_OPEN_STATUSES, ...(appt.mode === "shared" ? [appt.tenantId ?? 0] : [])],
    ).catch(() => ({ affectedRows: 0, insertId: 0 }));
    counts.appointment_segments = res.affectedRows;
  }

  // d) quote_items.description dei preventivi bozza/accettati/rifiutati.
  const quotes = await t(slug, "quotes");
  const quoteItems = await t(slug, "quote_items");
  if (quotes && quoteItems) {
    const scope = tenantClause(quoteItems);
    const res = await dbExecute(
      `UPDATE ${quoteIdentifier(quoteItems.name)} SET description = ?
        WHERE LOWER(TRIM(COALESCE(item_type,''))) = 'service' AND item_id = ?${scope.sql}
          AND quote_id IN (SELECT id FROM ${quoteIdentifier(quotes.name)} WHERE LOWER(TRIM(COALESCE(status,''))) IN ('draft','bozza','accepted','accettato','accettata','rejected','rifiutato','rifiutata','refused','declined')${quotes.mode === "shared" ? " AND tenant_id = ?" : ""})`,
      [name, serviceId, ...scope.params, ...(quotes.mode === "shared" ? [quotes.tenantId ?? 0] : [])],
    ).catch(() => ({ affectedRows: 0, insertId: 0 }));
    counts.quotes = res.affectedRows;
  }

  // e/f) client_prepaid_services: service_name + snapshot json.
  const prepaid = await t(slug, "client_prepaid_services");
  if (prepaid) {
    const scope = tenantClause(prepaid);
    const saleClauses: string[] = [];
    if (await columnExists(prepaid.name, "sale_id")) saleClauses.push("sale_id IS NOT NULL");
    if (await columnExists(prepaid.name, "sale_item_id")) saleClauses.push("sale_item_id IS NOT NULL");
    const saleWhere = saleClauses.length ? ` AND (${saleClauses.join(" OR ")})` : "";
    const res = await dbExecute(
      `UPDATE ${quoteIdentifier(prepaid.name)} SET service_name = ?
        WHERE service_id = ? AND COALESCE(remaining_qty,0) > 0
          AND LOWER(TRIM(COALESCE(status,'active'))) IN ('active','attivo')${saleWhere}${scope.sql}`,
      [name, serviceId, ...scope.params],
    ).catch(() => ({ affectedRows: 0, insertId: 0 }));
    counts.client_prepaids += res.affectedRows;

    if (await columnExists(prepaid.name, "service_snapshot_json")) {
      const rows = await dbQuery<RowDataPacket[]>(
        `SELECT id, service_snapshot_json FROM ${quoteIdentifier(prepaid.name)}
          WHERE service_id = ? AND COALESCE(remaining_qty,0) > 0
            AND LOWER(TRIM(COALESCE(status,'active'))) IN ('active','attivo')${saleWhere}${scope.sql}`,
        [serviceId, ...scope.params],
      ).catch(() => [] as RowDataPacket[]);
      for (const row of rows) {
        const updated = snapshotJsonUpdateName(row.service_snapshot_json, serviceId, name);
        if (!updated) continue;
        await dbExecute(`UPDATE ${quoteIdentifier(prepaid.name)} SET service_snapshot_json = ? WHERE id = ?${scope.sql}`, [updated, Number(row.id ?? 0), ...scope.params]).catch(() => undefined);
      }
    }
  }

  // g) client_package_items.item_name_snapshot.
  const cp = await t(slug, "client_packages");
  const cpi = await t(slug, "client_package_items");
  if (cp && cpi && await columnExists(cpi.name, "item_name_snapshot")) {
    const scope = tenantClause(cpi);
    const res = await dbExecute(
      `UPDATE ${quoteIdentifier(cpi.name)} SET item_name_snapshot = ?
        WHERE LOWER(TRIM(COALESCE(item_type,''))) = 'service' AND item_id = ?${scope.sql}
          AND client_package_id IN (SELECT id FROM ${quoteIdentifier(cp.name)} WHERE LOWER(TRIM(COALESCE(status,'active'))) IN ('active','attivo','expired','scaduto','scaduta')${cp.mode === "shared" ? " AND tenant_id = ?" : ""})`,
      [name, serviceId, ...scope.params, ...(cp.mode === "shared" ? [cp.tenantId ?? 0] : [])],
    ).catch(() => ({ affectedRows: 0, insertId: 0 }));
    counts.client_packages += res.affectedRows;
  }

  // h) client_package_services.service_snapshot_json.
  const cps = await t(slug, "client_package_services");
  if (cp && cps && await columnExists(cps.name, "service_snapshot_json")) {
    const scope = tenantClause(cps);
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT id, service_snapshot_json FROM ${quoteIdentifier(cps.name)}
        WHERE service_id = ?${scope.sql}
          AND client_package_id IN (SELECT id FROM ${quoteIdentifier(cp.name)} WHERE LOWER(TRIM(COALESCE(status,'active'))) IN ('active','attivo','expired','scaduto','scaduta')${cp.mode === "shared" ? " AND tenant_id = ?" : ""})`,
      [serviceId, ...scope.params, ...(cp.mode === "shared" ? [cp.tenantId ?? 0] : [])],
    ).catch(() => [] as RowDataPacket[]);
    for (const row of rows) {
      const updated = snapshotJsonUpdateName(row.service_snapshot_json, serviceId, name);
      if (!updated) continue;
      const res = await dbExecute(`UPDATE ${quoteIdentifier(cps.name)} SET service_snapshot_json = ? WHERE id = ?${scope.sql}`, [updated, Number(row.id ?? 0), ...scope.params]).catch(() => ({ affectedRows: 0, insertId: 0 }));
      counts.client_packages += res.affectedRows;
    }
  }

  // i) giftbox_instance_items.service_snapshot_json (istanze con vendita).
  const gbi = await t(slug, "giftbox_instances");
  const gii = await t(slug, "giftbox_instance_items");
  const saleItems = await t(slug, "sale_items");
  if (gbi && gii && await columnExists(gii.name, "service_snapshot_json")) {
    const scope = tenantClause(gii, "gii");
    const saleJoin = saleItems ? `LEFT JOIN ${quoteIdentifier(saleItems.name)} si ON si.item_name LIKE CONCAT('%', gbi.code, '%')` : "";
    const saleWhere = saleItems ? " AND si.sale_id IS NOT NULL" : "";
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT DISTINCT gii.id, gii.service_snapshot_json
         FROM ${quoteIdentifier(gii.name)} gii
         JOIN ${quoteIdentifier(gbi.name)} gbi ON gbi.id = gii.instance_id
         ${saleJoin}
        WHERE LOWER(TRIM(COALESCE(gbi.status,''))) IN ('issued','active','expired','scaduto','scaduta')
          AND LOWER(TRIM(COALESCE(gii.item_type,''))) = 'service' AND gii.service_id = ?${saleWhere}${scope.sql}`,
      [serviceId, ...scope.params],
    ).catch(() => [] as RowDataPacket[]);
    for (const row of rows) {
      const updated = snapshotJsonUpdateName(row.service_snapshot_json, serviceId, name);
      if (!updated) continue;
      const res = await dbExecute(`UPDATE ${quoteIdentifier(gii.name)} SET service_snapshot_json = ? WHERE id = ?${tenantClause(gii).sql}`, [updated, Number(row.id ?? 0), ...tenantClause(gii).params]).catch(() => ({ affectedRows: 0, insertId: 0 }));
      counts.giftboxes += res.affectedRows;
    }
  }

  // j) gifts.reward_items_json.
  const gifts = await t(slug, "gifts");
  if (gifts && await columnExists(gifts.name, "reward_items_json")) {
    const scope = tenantClause(gifts);
    const hasDeleted = await columnExists(gifts.name, "deleted_at");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT id, reward_items_json FROM ${quoteIdentifier(gifts.name)}
        WHERE reward_items_json IS NOT NULL${hasDeleted ? " AND deleted_at IS NULL" : ""}${scope.sql}`,
      scope.params,
    ).catch(() => [] as RowDataPacket[]);
    for (const row of rows) {
      if (!jsonHasServiceRef(row.reward_items_json, serviceId)) continue;
      const updated = jsonUpdateServiceName(row.reward_items_json, serviceId, name);
      if (!updated) continue;
      const res = await dbExecute(`UPDATE ${quoteIdentifier(gifts.name)} SET reward_items_json = ? WHERE id = ?${scope.sql}`, [updated, Number(row.id ?? 0), ...scope.params]).catch(() => ({ affectedRows: 0, insertId: 0 }));
      counts.gifts_json += res.affectedRows;
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// APPLY CAMBIO PREZZO (svc_apply_service_price_catalog_updates)
// ---------------------------------------------------------------------------
export async function applyServicePriceCatalogUpdates(slug: string, serviceId: number, newPriceRaw: number, oldPriceRaw: number): Promise<Record<string, number>> {
  const counts: Record<string, number> = { package_items: 0, packages: 0, package_pricing: 0, promotion_services: 0 };
  if (serviceId <= 0) return counts;
  const newPrice = Math.round(Math.max(0, newPriceRaw) * 100) / 100;
  const oldPrice = Math.round(Math.max(0, oldPriceRaw) * 100) / 100;

  const lineTotal = (unitPrice: number, qty: number, discountType: string, discountValue: number): number => {
    const q = Math.max(1, qty || 1);
    const subtotal = unitPrice * q;
    let type = String(discountType ?? "percent").toLowerCase();
    if (!["percent", "amount", "fixed"].includes(type)) type = "percent";
    let discount = 0;
    if (type === "percent") discount = subtotal * Math.min(100, Math.max(0, discountValue)) / 100;
    else discount = Math.max(0, discountValue);
    return Math.round(Math.max(0, subtotal - Math.min(subtotal, discount)) * 100) / 100;
  };

  const packages = await t(slug, "packages");
  const pi = await t(slug, "package_items");
  const pricing = await t(slug, "package_pricing");
  const touchedPackageIds = new Set<number>();

  // 1) package_items: unit_price + line_total.
  if (pi) {
    const scope = tenantClause(pi);
    const hasLineTotal = await columnExists(pi.name, "line_total");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT id, package_id, qty, discount_type, discount_value FROM ${quoteIdentifier(pi.name)}
        WHERE LOWER(TRIM(COALESCE(item_type,''))) = 'service' AND item_id = ?${scope.sql}`,
      [serviceId, ...scope.params],
    ).catch(() => [] as RowDataPacket[]);
    for (const row of rows) {
      const total = lineTotal(newPrice, Number(row.qty ?? 1) || 1, String(row.discount_type ?? "percent"), Number(row.discount_value ?? 0) || 0);
      const res = await dbExecute(
        `UPDATE ${quoteIdentifier(pi.name)} SET unit_price = ?${hasLineTotal ? ", line_total = ?" : ""} WHERE id = ?${scope.sql}`,
        hasLineTotal ? [newPrice, total, Number(row.id ?? 0), ...scope.params] : [newPrice, Number(row.id ?? 0), ...scope.params],
      ).catch(() => ({ affectedRows: 0, insertId: 0 }));
      counts.package_items += res.affectedRows;
      const packageId = Number(row.package_id ?? 0);
      if (packageId > 0) touchedPackageIds.add(packageId);
    }
  }

  // 2) fallback legacy packages.service_id (senza righe package_items).
  if (packages && await columnExists(packages.name, "service_id")) {
    const scope = tenantClause(packages, "p");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT p.id, COALESCE(p.sessions_total, 1) AS sessions_total FROM ${quoteIdentifier(packages.name)} p
        WHERE p.service_id = ?${scope.sql}
          ${pi ? `AND NOT EXISTS (SELECT 1 FROM ${quoteIdentifier(pi.name)} x WHERE x.package_id = p.id)` : ""}`,
      [serviceId, ...scope.params],
    ).catch(() => [] as RowDataPacket[]);
    for (const row of rows) {
      const packageId = Number(row.id ?? 0);
      const price = Math.round(newPrice * Math.max(1, Number(row.sessions_total ?? 1) || 1) * 100) / 100;
      const res = await dbExecute(`UPDATE ${quoteIdentifier(packages.name)} SET price = ? WHERE id = ?${tenantClause(packages).sql}`, [price, packageId, ...tenantClause(packages).params]).catch(() => ({ affectedRows: 0, insertId: 0 }));
      counts.packages += res.affectedRows;
      if (pricing) {
        const upd = await dbExecute(`UPDATE ${quoteIdentifier(pricing.name)} SET subtotal = ?, total = ? WHERE package_id = ?${tenantClause(pricing).sql}`, [price, price, packageId, ...tenantClause(pricing).params]).catch(() => ({ affectedRows: 0, insertId: 0 }));
        if (upd.affectedRows > 0) counts.package_pricing += upd.affectedRows;
        else {
          const ins = await dbExecute(`INSERT INTO ${quoteIdentifier(pricing.name)} (${pricing.mode === "shared" ? "tenant_id, " : ""}package_id, subtotal, discount_type, discount_value, total) VALUES (${pricing.mode === "shared" ? "?, " : ""}?, ?, 'percent', 0, ?)`, pricing.mode === "shared" ? [pricing.tenantId ?? 0, packageId, price, price] : [packageId, price, price]).catch(() => ({ affectedRows: 0, insertId: 0 }));
          counts.package_pricing += ins.affectedRows;
        }
      }
    }
  }

  // 3) ricalcolo dei pacchetti toccati: subtotal da line_total, sconto da pricing.
  if (pi && packages && touchedPackageIds.size) {
    const piScope = tenantClause(pi);
    for (const packageId of touchedPackageIds) {
      const rows = await dbQuery<RowDataPacket[]>(
        `SELECT COALESCE(line_total, unit_price * GREATEST(1, COALESCE(qty,1))) AS line FROM ${quoteIdentifier(pi.name)} WHERE package_id = ?${piScope.sql}`,
        [packageId, ...piScope.params],
      ).catch(() => [] as RowDataPacket[]);
      const subtotal = Math.round(rows.reduce((sum, row) => sum + (Number(row.line ?? 0) || 0), 0) * 100) / 100;
      let total = subtotal;
      if (pricing) {
        const prScope = tenantClause(pricing);
        const pr = await dbQuery<RowDataPacket[]>(`SELECT discount_type, discount_value FROM ${quoteIdentifier(pricing.name)} WHERE package_id = ?${prScope.sql} LIMIT 1`, [packageId, ...prScope.params]).catch(() => [] as RowDataPacket[]);
        if (pr[0]) {
          const type = String(pr[0].discount_type ?? "percent").toLowerCase();
          const value = Number(pr[0].discount_value ?? 0) || 0;
          const discount = type === "percent" ? subtotal * Math.min(100, Math.max(0, value)) / 100 : Math.max(0, value);
          total = Math.round(Math.max(0, subtotal - Math.min(subtotal, discount)) * 100) / 100;
          const upd = await dbExecute(`UPDATE ${quoteIdentifier(pricing.name)} SET subtotal = ?, total = ? WHERE package_id = ?${prScope.sql}`, [subtotal, total, packageId, ...prScope.params]).catch(() => ({ affectedRows: 0, insertId: 0 }));
          counts.package_pricing += upd.affectedRows;
        } else {
          const ins = await dbExecute(`INSERT INTO ${quoteIdentifier(pricing.name)} (${pricing.mode === "shared" ? "tenant_id, " : ""}package_id, subtotal, discount_type, discount_value, total) VALUES (${pricing.mode === "shared" ? "?, " : ""}?, ?, 'percent', 0, ?)`, pricing.mode === "shared" ? [pricing.tenantId ?? 0, packageId, subtotal, total] : [packageId, subtotal, total]).catch(() => ({ affectedRows: 0, insertId: 0 }));
          counts.package_pricing += ins.affectedRows;
        }
      }
      const upd = await dbExecute(`UPDATE ${quoteIdentifier(packages.name)} SET price = ? WHERE id = ?${tenantClause(packages).sql}`, [total, packageId, ...tenantClause(packages).params]).catch(() => ({ affectedRows: 0, insertId: 0 }));
      counts.packages += upd.affectedRows;
    }
  }

  // 4) promotion_services legacy discount_mode='price': riallinea il target.
  const promoServices = await t(slug, "promotion_services");
  if (promoServices && await columnExists(promoServices.name, "discount_mode") && await columnExists(promoServices.name, "discount_value")) {
    const scope = tenantClause(promoServices);
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT id, discount_value FROM ${quoteIdentifier(promoServices.name)}
        WHERE service_id = ? AND LOWER(TRIM(COALESCE(discount_mode,''))) = 'price' AND discount_value IS NOT NULL${scope.sql}`,
      [serviceId, ...scope.params],
    ).catch(() => [] as RowDataPacket[]);
    for (const row of rows) {
      const oldTarget = Number(row.discount_value ?? 0) || 0;
      const newTarget = Math.round(Math.max(0, newPrice - (oldPrice - oldTarget)) * 100) / 100;
      const res = await dbExecute(`UPDATE ${quoteIdentifier(promoServices.name)} SET discount_value = ? WHERE id = ?${scope.sql}`, [newTarget, Number(row.id ?? 0), ...scope.params]).catch(() => ({ affectedRows: 0, insertId: 0 }));
      counts.promotion_services += res.affectedRows;
    }
  }

  return counts;
}

// ---------------------------------------------------------------------------
// FREEZE SNAPSHOT (svc_freeze_existing_*): congela nome/prezzo/durata storici
// sulle righe operative esistenti PRIMA di modificare/eliminare il servizio.
// ---------------------------------------------------------------------------
type ServiceSnapshotPayload = Record<string, unknown>;

async function buildServiceSnapshotPayload(slug: string, serviceId: number, lockedName?: string | null, lockedPrice?: number | null, capturedAt?: string | null): Promise<ServiceSnapshotPayload | null> {
  const services = await t(slug, "services");
  if (!services) return null;
  const cats = await t(slug, "service_categories");
  const scope = tenantClause(services, "s");
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT s.id, s.name, s.price, s.duration_min, s.category_id, s.is_active, ${await columnExists(services.name, "no_operator") ? "s.no_operator" : "0 AS no_operator"}${cats ? ", c.name AS category_name" : ", NULL AS category_name"}
       FROM ${quoteIdentifier(services.name)} s
       ${cats ? `LEFT JOIN ${quoteIdentifier(cats.name)} c ON c.id = s.category_id` : ""}
      WHERE s.id = ?${scope.sql} LIMIT 1`,
    [serviceId, ...scope.params],
  ).catch(() => [] as RowDataPacket[]);
  const svc = rows[0];
  if (!svc) return null;

  const linked = async (tableName: string, valueColumn: string): Promise<number[]> => {
    const table = await t(slug, tableName);
    if (!table) return [];
    const sc = tenantClause(table);
    const list = await dbQuery<RowDataPacket[]>(`SELECT ${quoteIdentifier(valueColumn)} AS v FROM ${quoteIdentifier(table.name)} WHERE service_id = ?${sc.sql} ORDER BY 1 ASC`, [serviceId, ...sc.params]).catch(() => [] as RowDataPacket[]);
    return list.map((row) => Number(row.v ?? 0)).filter((v) => v > 0);
  };
  const cabinIds = await linked("service_cabins", "cabin_id");
  const staffIds = await linked("staff_services", "staff_id");
  const resourceRows = await (async () => {
    const table = await t(slug, "service_resources");
    if (!table) return [] as Array<{ id: number; qty: number }>;
    const sc = tenantClause(table);
    const list = await dbQuery<RowDataPacket[]>(`SELECT resource_id, COALESCE(qty_required,1) AS qty FROM ${quoteIdentifier(table.name)} WHERE service_id = ?${sc.sql} ORDER BY resource_id ASC`, [serviceId, ...sc.params]).catch(() => [] as RowDataPacket[]);
    return list.map((row) => ({ id: Number(row.resource_id ?? 0), qty: Math.max(1, Number(row.qty ?? 1) || 1) }));
  })();

  const now = new Date();
  const nowStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
  return {
    version: 3,
    captured_at: capturedAt || nowStr,
    service_id: serviceId,
    name: lockedName ?? String(svc.name ?? ""),
    duration_min: Math.max(0, Number(svc.duration_min ?? 0) || 0),
    price: Math.round((lockedPrice ?? Number(svc.price ?? 0)) * 100) / 100,
    category: { id: svc.category_id != null ? Number(svc.category_id) : null, name: String(svc.category_name ?? "") },
    is_active: Number(svc.is_active ?? 1) === 1 ? 1 : 0,
    cabins: [],
    cabin_ids: cabinIds,
    staff: [],
    staff_ids: staffIds,
    resources: [],
    resource_qty_map: Object.fromEntries(resourceRows.map((row) => [String(row.id), row.qty])),
    no_operator: Number(svc.no_operator ?? 0) === 1,
  };
}

// svc_service_snapshot_payload_complete.
function snapshotPayloadComplete(payload: Record<string, unknown> | null): boolean {
  if (!payload) return false;
  if (!(Number(payload.service_id ?? 0) > 0)) return false;
  for (const key of ["name", "duration_min", "price", "is_active", "no_operator", "cabins", "cabin_ids", "staff", "staff_ids", "resources", "resource_qty_map"]) {
    if (!(key in payload)) return false;
  }
  const category = payload.category;
  if (!category || typeof category !== "object" || !("id" in (category as object)) || !("name" in (category as object))) return false;
  return true;
}

// svc_freeze_existing_appointment_snapshots_before_service_update (nucleo):
// riempie SOLO i campi vuoti delle righe appointment_services degli appuntamenti
// storici e ricostruisce i JSON incompleti; inserisce le righe mancanti per gli
// appuntamenti legacy con solo a.service_id.
export async function freezeAppointmentSnapshots(slug: string, serviceId: number): Promise<void> {
  if (serviceId <= 0) return;
  const appt = await t(slug, "appointments");
  const aps = await t(slug, "appointment_services");
  if (!appt || !aps) return;
  const snapshotStatuses = ["pending", "scheduled", "done", "canceled", "cancelled", "no_show", "no show", "no-show", "noshow", "non presentato", "in sospeso", "prenotato", "eseguito", "annullato", "rifiutato"];
  const apScope = tenantClause(appt, "a");
  const segments = await t(slug, "appointment_segments");

  const idRows = await dbQuery<RowDataPacket[]>(
    `SELECT DISTINCT a.id FROM ${quoteIdentifier(appt.name)} a
       LEFT JOIN ${quoteIdentifier(aps.name)} aps ON aps.appointment_id = a.id AND aps.service_id = ?
      WHERE LOWER(COALESCE(a.status,'')) IN (${snapshotStatuses.map(() => "?").join(",")})${apScope.sql}
        AND (a.service_id = ? OR aps.service_id IS NOT NULL${segments ? ` OR EXISTS (SELECT 1 FROM ${quoteIdentifier(segments.name)} sg WHERE sg.appointment_id = a.id AND sg.service_id = ?)` : ""})
      ORDER BY a.id ASC`,
    [serviceId, ...snapshotStatuses, ...apScope.params, serviceId, ...(segments ? [serviceId] : [])],
  ).catch(() => [] as RowDataPacket[]);
  const apptIds = [...new Set(idRows.map((row) => Number(row.id ?? 0)).filter((id) => id > 0))];
  if (!apptIds.length) return;

  const payload = await buildServiceSnapshotPayload(slug, serviceId);
  if (!payload) return;
  const serviceName = String(payload.name ?? "");
  const servicePrice = Number(payload.price ?? 0);
  const serviceDuration = Number(payload.duration_min ?? 0);
  const categoryId = (payload.category as { id: number | null }).id;
  const categoryName = (payload.category as { name: string }).name;
  const snapshotJson = JSON.stringify(payload);
  const scope = tenantClause(aps);
  const inList = apptIds.map(() => "?").join(",");

  const has = async (col: string) => columnExists(aps.name, col);
  if (serviceName && await has("service_name")) {
    await dbExecute(`UPDATE ${quoteIdentifier(aps.name)} SET service_name = ? WHERE appointment_id IN (${inList}) AND service_id = ? AND (service_name IS NULL OR service_name = '')${scope.sql}`, [serviceName, ...apptIds, serviceId, ...scope.params]).catch(() => undefined);
  }
  if (serviceDuration > 0 && await has("duration_min")) {
    await dbExecute(`UPDATE ${quoteIdentifier(aps.name)} SET duration_min = ? WHERE appointment_id IN (${inList}) AND service_id = ? AND (duration_min IS NULL OR duration_min <= 0)${scope.sql}`, [serviceDuration, ...apptIds, serviceId, ...scope.params]).catch(() => undefined);
  }
  if (categoryId != null && await has("service_category_id")) {
    await dbExecute(`UPDATE ${quoteIdentifier(aps.name)} SET service_category_id = ? WHERE appointment_id IN (${inList}) AND service_id = ? AND (service_category_id IS NULL OR service_category_id = 0)${scope.sql}`, [categoryId, ...apptIds, serviceId, ...scope.params]).catch(() => undefined);
  }
  if (categoryName && await has("service_category_name")) {
    await dbExecute(`UPDATE ${quoteIdentifier(aps.name)} SET service_category_name = ? WHERE appointment_id IN (${inList}) AND service_id = ? AND (service_category_name IS NULL OR service_category_name = '')${scope.sql}`, [categoryName, ...apptIds, serviceId, ...scope.params]).catch(() => undefined);
  }
  if (await has("service_snapshot_json")) {
    await dbExecute(`UPDATE ${quoteIdentifier(aps.name)} SET service_snapshot_json = ? WHERE appointment_id IN (${inList}) AND service_id = ? AND (service_snapshot_json IS NULL OR service_snapshot_json = '')${scope.sql}`, [snapshotJson, ...apptIds, serviceId, ...scope.params]).catch(() => undefined);

    // Refresh dei JSON incompleti (mancano cabins/staff/resources/category/is_active).
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT appointment_id, service_id, price, duration_min, service_snapshot_json${await has("service_name") ? ", service_name" : ""}${await has("list_price") ? ", list_price" : ""}
         FROM ${quoteIdentifier(aps.name)}
        WHERE appointment_id IN (${inList}) AND service_id = ?${scope.sql}`,
      [...apptIds, serviceId, ...scope.params],
    ).catch(() => [] as RowDataPacket[]);
    for (const row of rows) {
      const raw = String(row.service_snapshot_json ?? "");
      const needsRefresh = raw.trim() === "" || ["\"cabins\"", "\"staff\"", "\"resources\"", "\"category\"", "\"is_active\""].some((needle) => !raw.includes(needle));
      if (!needsRefresh) continue;
      const rowPayload: ServiceSnapshotPayload = { ...payload };
      const rowName = String(row.service_name ?? "").trim();
      if (rowName) rowPayload.name = rowName;
      const rowPrice = row.list_price != null ? Number(row.list_price) : (row.price != null ? Number(row.price) : servicePrice);
      rowPayload.price = Math.round(rowPrice * 100) / 100;
      const rowDuration = Number(row.duration_min ?? 0) || 0;
      if (rowDuration > 0) rowPayload.duration_min = rowDuration;
      rowPayload.version = Math.max(3, Number(rowPayload.version ?? 3) || 3);
      await dbExecute(
        `UPDATE ${quoteIdentifier(aps.name)} SET service_snapshot_json = ? WHERE appointment_id = ? AND service_id = ?${scope.sql}`,
        [JSON.stringify(rowPayload), Number(row.appointment_id ?? 0), serviceId, ...scope.params],
      ).catch(() => undefined);
    }
  }

  // Inserisce le righe mancanti per gli appuntamenti legacy (solo a.service_id).
  const missing = await dbQuery<RowDataPacket[]>(
    `SELECT a.id, a.starts_at, a.ends_at FROM ${quoteIdentifier(appt.name)} a
      WHERE a.id IN (${inList}) AND a.service_id = ?${apScope.sql}
        AND NOT EXISTS (SELECT 1 FROM ${quoteIdentifier(aps.name)} x WHERE x.appointment_id = a.id)`,
    [...apptIds, serviceId, ...apScope.params],
  ).catch(() => [] as RowDataPacket[]);
  for (const row of missing) {
    const starts = row.starts_at instanceof Date ? row.starts_at.getTime() : new Date(String(row.starts_at ?? "").replace(" ", "T")).getTime();
    const ends = row.ends_at instanceof Date ? row.ends_at.getTime() : new Date(String(row.ends_at ?? "").replace(" ", "T")).getTime();
    const diff = Number.isFinite(starts) && Number.isFinite(ends) && ends > starts ? Math.round((ends - starts) / 60000) : 0;
    const duration = diff > 0 ? diff : serviceDuration;
    const cols: string[] = ["appointment_id", "service_id", "qty", "price"];
    const vals: unknown[] = [Number(row.id ?? 0), serviceId, 1, servicePrice];
    if (await has("duration_min")) { cols.push("duration_min"); vals.push(duration); }
    if (serviceName && await has("service_name")) { cols.push("service_name"); vals.push(serviceName); }
    if (await has("list_price")) { cols.push("list_price"); vals.push(servicePrice); }
    if (categoryId != null && await has("service_category_id")) { cols.push("service_category_id"); vals.push(categoryId); }
    if (categoryName && await has("service_category_name")) { cols.push("service_category_name"); vals.push(categoryName); }
    if (await has("service_snapshot_json")) { cols.push("service_snapshot_json"); vals.push(snapshotJson); }
    if (aps.mode === "shared") { cols.unshift("tenant_id"); vals.unshift(aps.tenantId ?? 0); }
    await dbExecute(
      `INSERT INTO ${quoteIdentifier(aps.name)} (${cols.map((c) => quoteIdentifier(c)).join(",")}) VALUES (${cols.map(() => "?").join(",")}) ON CONFLICT DO NOTHING`,
      vals,
    ).catch(() => undefined);
  }

  // appointment_segments: service_name / duration_minutes vuoti.
  if (segments) {
    const segScope = tenantClause(segments);
    if (serviceName && await columnExists(segments.name, "service_name")) {
      await dbExecute(`UPDATE ${quoteIdentifier(segments.name)} SET service_name = ? WHERE appointment_id IN (${inList}) AND service_id = ? AND (service_name IS NULL OR service_name = '')${segScope.sql}`, [serviceName, ...apptIds, serviceId, ...segScope.params]).catch(() => undefined);
    }
    if (serviceDuration > 0 && await columnExists(segments.name, "duration_minutes")) {
      await dbExecute(`UPDATE ${quoteIdentifier(segments.name)} SET duration_minutes = ? WHERE appointment_id IN (${inList}) AND service_id = ? AND (duration_minutes IS NULL OR duration_minutes <= 0)${segScope.sql}`, [serviceDuration, ...apptIds, serviceId, ...segScope.params]).catch(() => undefined);
    }
  }
}

// svc_freeze_existing_sold_service_snapshots_before_service_update: congela il
// JSON storico (nome/prezzo bloccati) su prepagati, righe pacchetto e giftbox.
export async function freezeSoldServiceSnapshots(slug: string, serviceId: number): Promise<void> {
  if (serviceId <= 0) return;

  const freezeTable = async (tableName: string, opts: { lockName?: boolean; capturedColumns: string[] }) => {
    const table = await t(slug, tableName);
    if (!table || !await columnExists(table.name, "service_snapshot_json")) return;
    const scope = tenantClause(table);
    const nameCol = opts.lockName && await columnExists(table.name, "service_name") ? ", service_name" : "";
    const priceCol = opts.lockName && await columnExists(table.name, "unit_price") ? ", unit_price" : "";
    const capturedCols = [];
    for (const col of opts.capturedColumns) {
      if (await columnExists(table.name, col)) capturedCols.push(col);
    }
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT id, service_snapshot_json${nameCol}${priceCol}${capturedCols.length ? `, ${capturedCols.join(", ")}` : ""}
         FROM ${quoteIdentifier(table.name)} WHERE service_id = ?${scope.sql} ORDER BY id ASC`,
      [serviceId, ...scope.params],
    ).catch(() => [] as RowDataPacket[]);
    for (const row of rows) {
      let existing: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(String(row.service_snapshot_json ?? ""));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
      } catch { existing = null; }
      if (snapshotPayloadComplete(existing)) continue;

      const lockedName = opts.lockName ? (String(row.service_name ?? "").trim() || (existing ? String(existing.name ?? "") : "") || null) : (existing ? String(existing.name ?? "") || null : null);
      const lockedPrice = opts.lockName && row.unit_price != null ? Number(row.unit_price) : (existing && existing.price != null ? Number(existing.price) : null);
      let capturedAt: string | null = existing && existing.captured_at ? String(existing.captured_at) : null;
      if (!capturedAt) {
        for (const col of capturedCols) {
          if (row[col]) { capturedAt = row[col] instanceof Date ? isoFromDate(row[col] as Date) : String(row[col]); break; }
        }
      }
      const payload = await buildServiceSnapshotPayload(slug, serviceId, lockedName, lockedPrice, capturedAt);
      if (!payload) continue;
      const json = JSON.stringify(payload);
      if (json === String(row.service_snapshot_json ?? "")) continue;
      await dbExecute(`UPDATE ${quoteIdentifier(table.name)} SET service_snapshot_json = ? WHERE id = ?${scope.sql}`, [json, Number(row.id ?? 0), ...scope.params]).catch(() => undefined);
    }
  };

  await freezeTable("client_prepaid_services", { lockName: true, capturedColumns: ["purchase_date", "created_at"] });
  await freezeTable("client_package_services", { lockName: false, capturedColumns: ["created_at"] });
  await freezeTable("giftbox_instance_items", { lockName: false, capturedColumns: ["created_at"] });
}

// ---------------------------------------------------------------------------
// Query condivise dei gruppi.
// ---------------------------------------------------------------------------
async function prepaidsForService(slug: string, serviceId: number, requireSale: boolean, limit: number): Promise<Array<{ id: number; remainingQty: number; clientName: string; saleId: number }>> {
  const prepaid = await t(slug, "client_prepaid_services");
  if (!prepaid) return [];
  const clients = await t(slug, "clients");
  const scope = tenantClause(prepaid, "cps");
  let saleWhere = "";
  if (requireSale) {
    const clauses: string[] = [];
    if (await columnExists(prepaid.name, "sale_id")) clauses.push("cps.sale_id IS NOT NULL");
    if (await columnExists(prepaid.name, "sale_item_id")) clauses.push("cps.sale_item_id IS NOT NULL");
    if (clauses.length) saleWhere = ` AND (${clauses.join(" OR ")})`;
  }
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT cps.id, COALESCE(cps.remaining_qty,0) AS remaining_qty, ${await columnExists(prepaid.name, "sale_id") ? "cps.sale_id" : "NULL"} AS sale_id, ${clients ? "c.full_name" : "NULL"} AS client_name
       FROM ${quoteIdentifier(prepaid.name)} cps
       ${clients ? `LEFT JOIN ${quoteIdentifier(clients.name)} c ON c.id = cps.client_id` : ""}
      WHERE cps.service_id = ? AND COALESCE(cps.remaining_qty,0) > 0
        AND LOWER(TRIM(COALESCE(cps.status,'active'))) IN ('active','attivo')${saleWhere}${scope.sql}
      LIMIT ${Math.max(1, limit)}`,
    [serviceId, ...scope.params],
  ).catch(() => [] as RowDataPacket[]);
  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    remainingQty: Number(row.remaining_qty ?? 0),
    clientName: String(row.client_name ?? "").trim(),
    saleId: Number(row.sale_id ?? 0) || 0,
  }));
}

async function clientPackagesForService(slug: string, serviceId: number, statuses: string[], limit: number, requireNotExpired = false): Promise<Array<{ id: number; name: string; status: string; expired: boolean; clientName: string }>> {
  const cp = await t(slug, "client_packages");
  if (!cp) return [];
  const clients = await t(slug, "clients");
  const cps = await t(slug, "client_package_services");
  const cpi = await t(slug, "client_package_items");
  if (!cps && !cpi) return [];
  const scope = tenantClause(cp, "cp");
  const unions: string[] = [];
  const params: unknown[] = [];
  if (cps) { unions.push(`SELECT client_package_id FROM ${quoteIdentifier(cps.name)} WHERE service_id = ?`); params.push(serviceId); }
  if (cpi) { unions.push(`SELECT client_package_id FROM ${quoteIdentifier(cpi.name)} WHERE LOWER(TRIM(COALESCE(item_type,''))) = 'service' AND item_id = ?`); params.push(serviceId); }
  const expiredClause = requireNotExpired ? " AND (cp.expires_at IS NULL OR cp.expires_at >= CURRENT_DATE)" : "";
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT cp.id, cp.name, cp.status, cp.expires_at, ${clients ? "c.full_name" : "NULL"} AS client_name
       FROM ${quoteIdentifier(cp.name)} cp
       ${clients ? `LEFT JOIN ${quoteIdentifier(clients.name)} c ON c.id = cp.client_id` : ""}
      WHERE LOWER(TRIM(COALESCE(cp.status,'active'))) IN (${statuses.map(() => "?").join(",")})${expiredClause}
        AND cp.id IN (${unions.join(" UNION ")})${scope.sql}
      LIMIT ${Math.max(1, limit)}`,
    [...statuses, ...params, ...scope.params],
  ).catch(() => [] as RowDataPacket[]);
  const today = new Date();
  return rows.map((row) => {
    const expiresAt = row.expires_at instanceof Date ? row.expires_at : (row.expires_at ? new Date(String(row.expires_at)) : null);
    return {
      id: Number(row.id ?? 0),
      name: String(row.name ?? "").trim() || `Pacchetto #${Number(row.id ?? 0)}`,
      status: String(row.status ?? "active"),
      expired: Boolean(expiresAt && Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() < today.setHours(0, 0, 0, 0)),
      clientName: String(row.client_name ?? "").trim(),
    };
  });
}

async function availableGiftInstancesForService(slug: string, serviceId: number): Promise<Array<{ id: number; giftName: string; clientName: string }>> {
  const gi = await t(slug, "gift_instances");
  const gifts = await t(slug, "gifts");
  if (!gi || !gifts) return [];
  const clients = await t(slug, "clients");
  const scope = tenantClause(gi, "gi");
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT gi.id, g.id AS gift_id, g.name AS gift_name, g.reward_service_id, g.reward_items_json, ${clients ? "c.full_name" : "NULL"} AS client_name
       FROM ${quoteIdentifier(gi.name)} gi
       JOIN ${quoteIdentifier(gifts.name)} g ON g.id = gi.gift_id
       ${clients ? `LEFT JOIN ${quoteIdentifier(clients.name)} c ON c.id = gi.client_id` : ""}
      WHERE LOWER(TRIM(COALESCE(gi.state,''))) = 'disponibile' AND COALESCE(gi.is_active,1) = 1
        AND (gi.expires_at IS NULL OR gi.expires_at >= NOW())
        AND (g.reward_service_id = ? OR g.reward_items_json IS NOT NULL)${scope.sql}
      LIMIT 100`,
    [serviceId, ...scope.params],
  ).catch(() => [] as RowDataPacket[]);
  return rows
    .filter((row) => Number(row.reward_service_id ?? 0) === serviceId || jsonHasServiceRef(row.reward_items_json, serviceId))
    .map((row) => ({
      id: Number(row.id ?? 0),
      giftName: String(row.gift_name ?? "").trim() || `omaggio #${Number(row.gift_id ?? 0)}`,
      clientName: String(row.client_name ?? "").trim(),
    }));
}

async function giftCampaignsForService(slug: string, serviceId: number, activeOnly: boolean): Promise<Array<{ id: number; name: string; active: boolean; roleDetail: string; validFrom: unknown; validTo: unknown }>> {
  const gifts = await t(slug, "gifts");
  if (!gifts) return [];
  const scope = tenantClause(gifts, "g");
  const hasDeleted = await columnExists(gifts.name, "deleted_at");
  const baseWhere = `${hasDeleted ? "g.deleted_at IS NULL AND " : ""}${activeOnly ? "COALESCE(g.active,0) = 1 AND (g.valid_from IS NULL OR g.valid_from <= NOW()) AND (g.valid_to IS NULL OR g.valid_to >= NOW()) AND " : ""}`;
  const out: Array<{ id: number; name: string; active: boolean; roleDetail: string; validFrom: unknown; validTo: unknown }> = [];
  const push = (row: RowDataPacket, roleDetail: string) => {
    out.push({
      id: Number(row.id ?? 0),
      name: String(row.name ?? "").trim() || `Campagna omaggio #${Number(row.id ?? 0)}`,
      active: Number(row.active ?? 0) === 1,
      roleDetail,
      validFrom: row.valid_from,
      validTo: row.valid_to,
    });
  };

  const rows1 = await dbQuery<RowDataPacket[]>(
    `SELECT g.id, g.name, g.active, g.valid_from, g.valid_to FROM ${quoteIdentifier(gifts.name)} g WHERE ${baseWhere}g.reward_service_id = ?${scope.sql} LIMIT ${activeOnly ? 50 : 40}`,
    [serviceId, ...scope.params],
  ).catch(() => [] as RowDataPacket[]);
  rows1.forEach((row) => push(row, "Servizio impostato come premio"));

  const sets = await t(slug, "gift_rule_sets");
  const rules = await t(slug, "gift_rules");
  if (sets && rules) {
    const rows2 = await dbQuery<RowDataPacket[]>(
      `SELECT DISTINCT g.id, g.name, g.active, g.valid_from, g.valid_to
         FROM ${quoteIdentifier(gifts.name)} g
         JOIN ${quoteIdentifier(sets.name)} grs ON grs.gift_id = g.id
         JOIN ${quoteIdentifier(rules.name)} gr ON gr.rule_set_id = grs.id
        WHERE ${baseWhere}gr.target_service_id = ?${scope.sql} LIMIT ${activeOnly ? 50 : 40}`,
      [serviceId, ...scope.params],
    ).catch(() => [] as RowDataPacket[]);
    rows2.forEach((row) => push(row, "Servizio usato nelle regole di sblocco"));
  }

  if (await columnExists(gifts.name, "reward_items_json")) {
    const rows3 = await dbQuery<RowDataPacket[]>(
      `SELECT g.id, g.name, g.active, g.valid_from, g.valid_to, g.reward_items_json FROM ${quoteIdentifier(gifts.name)} g WHERE ${baseWhere}g.reward_items_json IS NOT NULL${scope.sql} LIMIT ${activeOnly ? 200 : 240}`,
      scope.params,
    ).catch(() => [] as RowDataPacket[]);
    rows3.filter((row) => jsonHasServiceRef(row.reward_items_json, serviceId)).forEach((row) => push(row, "Servizio impostato nei premi multipli"));
  }

  return out;
}

async function promotionsForService(slug: string, serviceId: number, activeOnly: boolean, limit: number): Promise<Array<{ id: number; name: string; active: boolean; scopeAll: boolean; startsAt: unknown; endsAt: unknown; legacyPriceMode: boolean }>> {
  const promotions = await t(slug, "promotions");
  if (!promotions) return [];
  const ps = await t(slug, "promotion_services");
  const scope = tenantClause(promotions, "p");
  const psScope = ps ? tenantClause(ps) : { sql: "", params: [] as unknown[] };
  const selectedExists = ps
    ? `EXISTS (SELECT 1 FROM ${quoteIdentifier(ps.name)} x WHERE x.promotion_id = p.id AND x.service_id = ?${psScope.sql.replace(" AND ", " AND x.")})`
    : "FALSE";
  const activeWhere = activeOnly
    ? "COALESCE(p.is_active,0) = 1 AND (p.starts_at IS NULL OR p.starts_at <= CURRENT_DATE) AND (p.ends_at IS NULL OR p.ends_at >= CURRENT_DATE) AND "
    : "";
  const hasPriceMode = ps ? await columnExists(ps.name, "discount_mode") : false;
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT p.id, COALESCE(p.title, '') AS name, COALESCE(p.is_active,0) AS is_active, p.starts_at, p.ends_at, LOWER(TRIM(COALESCE(p.apply_services_mode,''))) AS services_mode
       FROM ${quoteIdentifier(promotions.name)} p
      WHERE ${activeWhere}(LOWER(TRIM(COALESCE(p.apply_services_mode,''))) = 'all' OR (LOWER(TRIM(COALESCE(p.apply_services_mode,''))) = 'selected' AND ${selectedExists}))${scope.sql}
      LIMIT ${Math.max(1, limit)}`,
    [...(ps ? [serviceId, ...psScope.params] : []), ...scope.params],
  ).catch(() => [] as RowDataPacket[]);

  const out: Array<{ id: number; name: string; active: boolean; scopeAll: boolean; startsAt: unknown; endsAt: unknown; legacyPriceMode: boolean }> = [];
  for (const row of rows) {
    let legacyPriceMode = false;
    if (hasPriceMode && ps) {
      const pr = await dbQuery<RowDataPacket[]>(
        `SELECT 1 FROM ${quoteIdentifier(ps.name)} WHERE promotion_id = ? AND service_id = ? AND LOWER(TRIM(COALESCE(discount_mode,''))) = 'price'${psScope.sql} LIMIT 1`,
        [Number(row.id ?? 0), serviceId, ...psScope.params],
      ).catch(() => [] as RowDataPacket[]);
      legacyPriceMode = Boolean(pr[0]);
    }
    out.push({
      id: Number(row.id ?? 0),
      name: String(row.name ?? "").trim() || `Promozione #${Number(row.id ?? 0)}`,
      active: Number(row.is_active ?? 0) === 1,
      scopeAll: String(row.services_mode ?? "") === "all",
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      legacyPriceMode,
    });
  }
  return out;
}
