import "server-only";

// MOTORE OMAGGI (Gifts v2, F12 Blocco 1) — port of app/lib/Gifts.php (le parti
// motore: ~4137-4716 tracking, ~6150-6660 resets/finestre, ~7258-7996
// recalcClient, ~8151-8526 evaluateRulesForClient, ~10759-10883 scadenze):
//  - ogni vendita/appuntamento-eseguito scrive eventi idempotenti su `events`
//    (vincolo unico events_uq_fid_events_src); is_valid=0 solo via UPDATE
//    (storni/annulli);
//  - le regole (service_qty/product_qty/appointments_count/total_spend/
//    first_visit) si valutano sugli eventi nella FINESTRA anti-retroattiva:
//    from = max(valid_from, gifts.created_at, ultimo riscatto+1s, reset
//    persistiti+1s, created_at del set/regola); to = valid_to; doppio filtro
//    anche su events.created_at; service/product/appointments contano
//    DISTINCT source_type:source_id (NON SUM qty); total_spend somma amount;
//  - set di regole in OR tra loro, AND/OR dentro il set (set_operator);
//  - fidelity_only: cliente aderente ORA + contano solo gli eventi avvenuti
//    con una tessera che copriva quel momento;
//  - single-use per (gift, cliente): un'istanza disponibile/riscattata/
//    scaduta blocca nuovi accumuli;
//  - transizioni: accumulo->disponibile (unlock al MOMENTO del ricalcolo,
//    expires_at = fine giornata unlock+expires_after_days), accumulo->scaduto
//    a fine campagna, disponibile->scaduto oltre expires_at (con annullo
//    delle prenotazioni collegate), regressione disponibile->accumulo solo
//    con forceRecheckAvailable.
// Divergenze documentate (input-side filtering): il filtro righe residuali
// avviene alla REGISTRAZIONE (come filterAppointmentServiceItemsForAccumulo),
// quindi il filtro gemello in valutazione non serve sugli eventi Next; gli
// intervalli di sospensione campagna (campaign_disabled_start/end) non sono
// ancora esclusi dal conteggio (nota nel roadmap).

import { randomBytes } from "crypto";
import type { RowDataPacket } from "@/lib/tenant-db";
import { dbExecute, dbQuery, quoteIdentifier, tenantInsert, tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";

const clean = (v: unknown) => String(v ?? "").trim();

function toSql(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function tsOf(value: unknown): number | null {
  const s = clean(value).replace(" ", "T");
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function latestTs(...values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null);
  return nums.length ? Math.max(...nums) : null;
}

// ---------------------------------------------------------------------------
// TRACKING — upsertTrackingEvent / recordSale / recordAppointmentDone
// ---------------------------------------------------------------------------

export type GiftTrackingEvent = {
  clientId: number;
  eventType: "appointment_done" | "service_sold" | "product_sold";
  sourceType: "appointment" | "sale";
  sourceId: number;
  sourceLineId: number;
  occurredAt?: Date;
  serviceId?: number | null;
  productId?: number | null;
  qty?: number;
  amount?: number;
  locationId?: number | null;
};

// INSERT ... ON CONFLICT sull'indice unico events_uq_fid_events_src — l'upsert
// aggiorna i dati riga ma MAI la chiave; is_valid torna 1 (ri-registrazione).
export async function giftUpsertTrackingEvent(slug: string, data: GiftTrackingEvent): Promise<boolean> {
  if (data.clientId <= 0 || data.sourceId <= 0 || data.sourceLineId <= 0) return false;
  const table = await tenantTable(slug, "events").catch(() => null);
  if (!table) return false;
  const occurred = data.occurredAt ?? new Date();
  const qty = Math.max(1, Math.round(Number(data.qty ?? 1) || 1));
  const amount = Math.max(0, Math.round((Number(data.amount ?? 0) || 0) * 100) / 100);
  await dbExecute(
    `INSERT INTO ${quoteIdentifier(table.name)}
       (tenant_id, client_id, event_type, source_type, source_id, source_line_id, occurred_at, service_id, product_id, qty, amount, is_valid, location_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)
     ON CONFLICT (tenant_id, event_type, source_type, source_id, source_line_id)
     DO UPDATE SET client_id = EXCLUDED.client_id, occurred_at = EXCLUDED.occurred_at, service_id = EXCLUDED.service_id,
                   product_id = EXCLUDED.product_id, qty = EXCLUDED.qty, amount = EXCLUDED.amount, is_valid = 1,
                   location_id = EXCLUDED.location_id`,
    [
      table.tenantId ?? 0,
      data.clientId,
      data.eventType,
      data.sourceType,
      data.sourceId,
      data.sourceLineId,
      toSql(occurred),
      data.serviceId && data.serviceId > 0 ? data.serviceId : null,
      data.productId && data.productId > 0 ? data.productId : null,
      qty,
      amount,
      data.locationId && data.locationId > 0 ? data.locationId : null,
      toSql(new Date()),
    ],
  ).catch(() => ({ affectedRows: 0 }));
  return true;
}

type SaleLikeLine = { type: "service" | "product"; id: number; qty: number; line: number; lineId: number };

// Ripartizione proporzionale dello sconto sulle righe (allocateDiscountAcrossLines).
function allocateDiscount(lines: SaleLikeLine[], subtotal: number, discount: number): Array<SaleLikeLine & { net: number }> {
  const disc = Math.min(Math.max(0, discount), Math.max(0, subtotal));
  return lines.map((l) => {
    const share = subtotal > 0 ? disc * (l.line / subtotal) : 0;
    return { ...l, net: Math.max(0, Math.round((l.line - share) * 100) / 100) };
  });
}

// recordSale (Gifts.php ~4231): eventi service_sold/product_sold dalle righe
// pagate della vendita; source_line_id = sale_item_id.
export async function giftRecordSale(
  slug: string,
  saleId: number,
  clientId: number,
  items: Array<{ type: string; refId: number; qty: number; lineTotal: number; saleItemId: number }>,
  subtotal: number,
  discount: number,
  locationId?: number,
): Promise<void> {
  if (clientId <= 0 || saleId <= 0) return;
  const lines: SaleLikeLine[] = items
    .filter((it) => (it.type === "service" || it.type === "product") && it.refId > 0)
    .map((it) => ({
      type: it.type as "service" | "product",
      id: it.refId,
      qty: Math.max(1, Math.round(it.qty)),
      line: Math.max(0, it.lineTotal),
      lineId: it.saleItemId > 0 ? it.saleItemId : it.refId,
    }));
  if (!lines.length) return;
  for (const l of allocateDiscount(lines, subtotal, discount)) {
    await giftUpsertTrackingEvent(slug, {
      clientId,
      eventType: l.type === "product" ? "product_sold" : "service_sold",
      sourceType: "sale",
      sourceId: saleId,
      sourceLineId: l.lineId,
      serviceId: l.type === "service" ? l.id : null,
      productId: l.type === "product" ? l.id : null,
      qty: l.qty,
      amount: l.net,
      locationId: locationId ?? null,
    });
  }
  await giftRecalcClient(slug, clientId).catch(() => undefined);
}

// recordAppointmentDone (Gifts.php ~4137): eventi appointment_done dalle righe
// servizio NON residuali (le righe riscattate da omaggi/giftbox/pacchetti/
// prepagati non maturano nuovi omaggi); source_line_id = service_id.
export async function giftRecordAppointmentDone(slug: string, appointmentId: number, occurredAt?: Date): Promise<void> {
  if (appointmentId <= 0) return;
  const apptRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointments",
    columns: "client_id, discount_type, discount_value, starts_at, location_id",
    where: "id = ?",
    params: [appointmentId],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  const appt = apptRows[0];
  const clientId = Number(appt?.client_id ?? 0) || 0;
  if (!appt || clientId <= 0) return;
  const svcRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointment_services",
    columns: "service_id, COALESCE(price,0) AS price",
    where: "appointment_id = ?",
    params: [appointmentId],
  }).catch(() => [] as RowDataPacket[]);

  // Righe residuali (filterAppointmentServiceItemsForAccumulo): servizi coperti
  // dalle tabelle di riscatto collegate all'appuntamento.
  const residual = new Set<number>();
  for (const t of ["appointment_gift_items", "appointment_giftbox_items", "appointment_package_items", "appointment_prepaid_service_items"]) {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: t, columns: "service_id", where: "appointment_id = ?", params: [appointmentId] }).catch(() => [] as RowDataPacket[]);
    for (const r of rows) {
      const sid = Number(r.service_id ?? 0);
      if (sid > 0) residual.add(sid);
    }
  }

  // Raggruppa per service_id (groupAppointmentServiceItemsForTracking).
  const grouped = new Map<number, { qty: number; line: number }>();
  for (const r of svcRows) {
    const sid = Number(r.service_id ?? 0);
    if (sid <= 0 || residual.has(sid)) continue;
    const g = grouped.get(sid) ?? { qty: 0, line: 0 };
    g.qty += 1;
    g.line += Math.max(0, Number(r.price ?? 0) || 0);
    grouped.set(sid, g);
  }

  const eventsTable = await tenantTable(slug, "events").catch(() => null);
  if (grouped.size === 0) {
    // Nessuna riga utile: invalida gli eventi precedenti dell'appuntamento.
    if (eventsTable) {
      await dbExecute(
        `UPDATE ${quoteIdentifier(eventsTable.name)} SET is_valid = 0 WHERE tenant_id = ? AND source_type = 'appointment' AND source_id = ?`,
        [eventsTable.tenantId ?? 0, appointmentId],
      ).catch(() => ({ affectedRows: 0 }));
    }
    await giftRecalcClient(slug, clientId, undefined, true).catch(() => undefined);
    return;
  }

  // Sconti appuntamento (discount_type/value) ripartiti come nel legacy.
  const lines: SaleLikeLine[] = [...grouped.entries()].map(([sid, g]) => ({ type: "service", id: sid, qty: g.qty, line: g.line, lineId: sid }));
  const subtotal = lines.reduce((s, l) => s + l.line, 0);
  const dtype = clean(appt.discount_type).toLowerCase();
  const dval = Math.max(0, Number(appt.discount_value ?? 0) || 0);
  const discount = dtype === "percent" ? (subtotal * Math.min(100, dval)) / 100 : dtype === "fixed" || dtype === "amount" ? dval : 0;
  const occurred = occurredAt ?? (appt.starts_at ? new Date(String(appt.starts_at)) : new Date());

  for (const l of allocateDiscount(lines, subtotal, discount)) {
    await giftUpsertTrackingEvent(slug, {
      clientId,
      eventType: "appointment_done",
      sourceType: "appointment",
      sourceId: appointmentId,
      sourceLineId: l.lineId,
      serviceId: l.id,
      qty: l.qty,
      amount: l.net,
      occurredAt: Number.isNaN(occurred.getTime()) ? new Date() : occurred,
      locationId: Number(appt.location_id ?? 0) || null,
    });
  }
  await giftRecalcClient(slug, clientId).catch(() => undefined);
}

// Invalidazione su storno/annullo (previewSourceInvalidation ~9709): gli eventi
// della sorgente diventano is_valid=0 e il cliente viene ricalcolato (con
// forceRecheck: un disponibile non più maturato regredisce ad accumulo).
export async function giftInvalidateSource(slug: string, sourceType: "sale" | "appointment", sourceId: number): Promise<void> {
  const table = await tenantTable(slug, "events").catch(() => null);
  if (!table || sourceId <= 0) return;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "events", columns: "DISTINCT client_id", where: "source_type = ? AND source_id = ? AND is_valid = 1", params: [sourceType, sourceId] }).catch(() => [] as RowDataPacket[]);
  await dbExecute(
    `UPDATE ${quoteIdentifier(table.name)} SET is_valid = 0 WHERE tenant_id = ? AND source_type = ? AND source_id = ? AND is_valid = 1`,
    [table.tenantId ?? 0, sourceType, sourceId],
  ).catch(() => ({ affectedRows: 0 }));
  for (const r of rows) {
    await giftRecalcClient(slug, Number(r.client_id ?? 0), undefined, true).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// VALUTAZIONE REGOLE — evaluateRulesForClient
// ---------------------------------------------------------------------------

type GiftRuleRow = {
  setId: number;
  setOperator: "and" | "or";
  ruleType: string;
  comparator: string;
  threshold: number;
  targetServiceId: number;
  targetProductId: number;
  floorTs: number | null; // max(created_at set, created_at regola)
};

type RuleResult = { type: string; current: number; needed: number; comparator: string; ok: boolean };
export type GiftEvaluation = { ok: boolean; rules: RuleResult[] };

function compare(cur: number, cmp: string, thr: number): boolean {
  const e = 1e-7;
  switch (cmp) {
    case ">": return cur > thr + e;
    case "=": return Math.abs(cur - thr) <= e;
    case "<=": return cur <= thr + e;
    case "<": return cur < thr - e;
    default: return cur >= thr - e; // '>='
  }
}

// EXISTS tessera che copriva il momento dell'evento (fidelityCardExistsSqlForEvent):
// contano gli eventi avvenuti dentro la finestra di validità di una tessera del
// cliente (anche se la tessera è poi scaduta).
function cardCoversEventSql(cardsTable: string, tenantId: number): string {
  return `EXISTS (SELECT 1 FROM ${quoteIdentifier(cardsTable)} fc WHERE fc.tenant_id = ${tenantId} AND fc.client_id = fe.client_id
    AND (fc.issued_at IS NULL OR fc.issued_at <= fe.occurred_at::date)
    AND (fc.expires_at IS NULL OR fc.expires_at >= fe.occurred_at::date))`;
}

async function evaluateGiftRulesForClient(
  slug: string,
  clientId: number,
  rules: GiftRuleRow[],
  windowFromTs: number | null,
  windowToTs: number | null,
  requireFidelityAtEvent: boolean,
): Promise<GiftEvaluation> {
  if (windowFromTs === null || windowToTs === null || windowToTs <= windowFromTs) return { ok: false, rules: [] };
  const eventsTable = await tenantTable(slug, "events").catch(() => null);
  const cardsTable = await tenantTable(slug, "cards").catch(() => null);
  if (!eventsTable) return { ok: false, rules: [] };
  const tenantId = Number(eventsTable.tenantId ?? 0);
  const cardSql = requireFidelityAtEvent && cardsTable ? cardCoversEventSql(cardsTable.name, Number(cardsTable.tenantId ?? 0)) : "";

  const results: RuleResult[] = [];
  const bySet = new Map<number, { op: "and" | "or"; oks: boolean[] }>();

  for (const rule of rules) {
    // Finestra per-regola: il floor della regola può solo ALZARE il from.
    const from = latestTs(windowFromTs, rule.floorTs);
    const fromSql = toSql(new Date(from ?? windowFromTs));
    const toSqlStr = toSql(new Date(windowToTs));
    const base = `FROM ${quoteIdentifier(eventsTable.name)} fe WHERE fe.tenant_id = ${tenantId} AND fe.client_id = ? AND fe.is_valid = 1
      AND fe.occurred_at >= ? AND fe.occurred_at <= ?
      AND (fe.created_at IS NULL OR fe.created_at >= ?)${cardSql ? ` AND ${cardSql}` : ""}`;
    const params: unknown[] = [clientId, fromSql, toSqlStr, fromSql];

    let sql = "";
    let needed = rule.threshold;
    let cmp = rule.comparator || ">=";
    if (rule.ruleType === "service_qty") {
      sql = `SELECT COALESCE(COUNT(DISTINCT fe.source_type || ':' || fe.source_id),0) AS v ${base} AND fe.service_id = ${rule.targetServiceId} AND fe.event_type IN ('appointment_done','service_sold')`;
    } else if (rule.ruleType === "product_qty") {
      sql = `SELECT COALESCE(COUNT(DISTINCT fe.source_type || ':' || fe.source_id),0) AS v ${base} AND fe.product_id = ${rule.targetProductId} AND fe.event_type = 'product_sold'`;
    } else if (rule.ruleType === "appointments_count") {
      sql = `SELECT COALESCE(COUNT(DISTINCT fe.source_id),0) AS v ${base} AND fe.event_type = 'appointment_done'`;
    } else if (rule.ruleType === "total_spend") {
      sql = `SELECT COALESCE(SUM(fe.amount),0) AS v ${base}`;
    } else if (rule.ruleType === "first_visit") {
      sql = `SELECT COALESCE(COUNT(DISTINCT fe.source_id),0) AS v ${base} AND fe.event_type = 'appointment_done'`;
      needed = 1;
      cmp = ">=";
    } else {
      continue; // tipo regola sconosciuto: ignorata (come il legacy)
    }

    const data = await dbQuery<RowDataPacket[]>(sql, params).catch(() => [] as RowDataPacket[]);
    const current = Number(data[0]?.v ?? 0) || 0;
    const ok = compare(current, cmp, needed);
    results.push({ type: rule.ruleType, current, needed, comparator: cmp, ok });
    const set = bySet.get(rule.setId) ?? { op: rule.setOperator, oks: [] };
    set.oks.push(ok);
    bySet.set(rule.setId, set);
  }

  if (bySet.size === 0) return { ok: false, rules: results };
  // Set in OR tra loro; dentro il set and/or.
  let anySet = false;
  for (const set of bySet.values()) {
    const ok = set.op === "or" ? set.oks.some(Boolean) : set.oks.every(Boolean);
    if (ok) anySet = true;
  }
  return { ok: anySet, rules: results };
}

// ---------------------------------------------------------------------------
// RECALC — recalcClient
// ---------------------------------------------------------------------------

function endOfDayAfterDays(base: Date, days: number): string {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + Math.max(0, Math.round(days)), 23, 59, 59);
  return toSql(d);
}

async function giftAdhering(slug: string, clientId: number): Promise<boolean> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "cards",
    columns: "id",
    where: "client_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at >= CURRENT_DATE)",
    params: [clientId],
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  return rows.length > 0;
}

function parseIdList(raw: unknown): number[] {
  const s = clean(raw);
  if (!s) return [];
  try {
    const p = JSON.parse(s);
    return Array.isArray(p) ? p.map((x) => Number(x) || 0).filter((n) => n > 0) : [];
  } catch {
    return [];
  }
}

// recalcClient (Gifts.php ~7258): valuta le campagne attive per il cliente e
// fa avanzare/regredire le istanze. forceRecheckAvailable rivaluta anche le
// istanze già disponibili (storni).
export async function giftRecalcClient(slug: string, clientId: number, onlyGiftId?: number, forceRecheckAvailable = false): Promise<void> {
  if (clientId <= 0) return;
  const now = new Date();
  const nowTs = now.getTime();
  const nowSql = toSql(now);

  // Campagne da valutare: attive, non eliminate, con periodo valido non concluso
  // (+ quelle con istanza attiva del cliente, per congelarle/chiuderle).
  const giftWhere = `deleted_at IS NULL AND COALESCE(active,0) = 1 AND valid_from IS NOT NULL AND valid_to IS NOT NULL AND valid_to >= ?${onlyGiftId ? " AND id = ?" : ""}`;
  const giftParams: unknown[] = onlyGiftId ? [nowSql, onlyGiftId] : [nowSql];
  const gifts = await tenantSelect<RowDataPacket>({ slug, table: "gifts", where: giftWhere, params: giftParams }).catch(() => [] as RowDataPacket[]);

  const instRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "gift_instances",
    where: `client_id = ? AND is_active = 1${onlyGiftId ? " AND gift_id = ?" : ""}`,
    params: onlyGiftId ? [clientId, onlyGiftId] : [clientId],
    orderBy: "id DESC",
  }).catch(() => [] as RowDataPacket[]);
  const activeByGift = new Map<number, RowDataPacket>();
  for (const inst of instRows) {
    const gid = Number(inst.gift_id ?? 0);
    if (!activeByGift.has(gid)) activeByGift.set(gid, inst);
    else {
      // Duplicata attiva: chiusa (closeActiveInstancesForGift).
      await tenantUpdate({ slug, table: "gift_instances", id: Number(inst.id), values: { state: "annullato", is_active: 0, cancel_reason: "Duplicato riallineato", updated_at: now } }).catch(() => 0);
    }
  }

  // Scadenza istanze disponibili oltre expires_at.
  for (const inst of activeByGift.values()) {
    if (clean(inst.state) === "disponibile" && inst.expires_at && String(inst.expires_at) < nowSql) {
      await giftExpireInstance(slug, Number(inst.id)).catch(() => null);
    }
  }

  // Campagne con istanza attiva ma fuori dalla lista (disattivate): congelate.
  const giftIds = new Set(gifts.map((g) => Number(g.id)));
  for (const [gid] of activeByGift) {
    if (!giftIds.has(gid) && !onlyGiftId) {
      const extra = await tenantSelect<RowDataPacket>({ slug, table: "gifts", where: "id = ?", params: [gid], limit: 1 }).catch(() => [] as RowDataPacket[]);
      if (extra[0]) gifts.push(extra[0]);
    }
  }

  for (const gift of gifts) {
    const gid = Number(gift.id ?? 0);
    const instance = activeByGift.get(gid) ?? null;
    const state = clean(instance?.state);

    // Esclusioni esplicite.
    if (parseIdList(gift.excluded_client_ids).includes(clientId)) {
      if (instance && state === "accumulo") {
        await tenantUpdate({ slug, table: "gift_instances", id: Number(instance.id), values: { state: "annullato", is_active: 0, cancel_reason: "Cliente escluso dalla campagna", updated_at: now } }).catch(() => 0);
      }
      continue;
    }

    // Campagna non attiva ORA: congela (campaign paused), nessun avanzamento.
    const validFromTs = tsOf(gift.valid_from);
    const validToTs = tsOf(gift.valid_to);
    const activeNow = Number(gift.active ?? 0) === 1 && !gift.deleted_at && validFromTs !== null && validToTs !== null && validFromTs <= nowTs && validToTs >= nowTs;
    if (!activeNow) {
      // Accumulo oltre il termine campagna -> scaduto.
      if (instance && state === "accumulo" && validToTs !== null && validToTs < nowTs) {
        await tenantUpdate({ slug, table: "gift_instances", id: Number(instance.id), values: { state: "scaduto", is_active: 0, updated_at: now } }).catch(() => 0);
      }
      continue;
    }

    // fidelity_only: adesione attuale richiesta.
    if (clean(gift.eligibility) === "fidelity_only" && !(await giftAdhering(slug, clientId))) {
      if (instance && state === "accumulo") {
        await tenantUpdate({ slug, table: "gift_instances", id: Number(instance.id), values: { state: "annullato", is_active: 0, cancel_reason: "Cliente non aderente", updated_at: now } }).catch(() => 0);
      }
      continue;
    }

    // Single-use: un'istanza disponibile/riscattata/scaduta blocca nuovi cicli.
    const blockingRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "gift_instances",
      columns: "id",
      where: "gift_id = ? AND client_id = ? AND state IN ('disponibile','riscattato','scaduto')",
      params: [gid, clientId],
      limit: 1,
    }).catch(() => [] as RowDataPacket[]);
    const hasBlocking = blockingRows.length > 0;
    if (hasBlocking && !(instance && state === "disponibile")) {
      if (instance && state === "accumulo") {
        await tenantUpdate({ slug, table: "gift_instances", id: Number(instance.id), values: { state: "annullato", is_active: 0, cancel_reason: "Campagna gia maturata per questo cliente", updated_at: now } }).catch(() => 0);
      }
      continue;
    }

    // Finestra anti-retroattiva: from = max(valid_from, created_at campagna,
    // ultimo riscatto+1s, reset persistiti+1s).
    const redeemRows = await tenantSelect<RowDataPacket>({ slug, table: "gift_instances", columns: "MAX(redeemed_at) AS r", where: "gift_id = ? AND client_id = ? AND state = 'riscattato'", params: [gid, clientId] }).catch(() => [] as RowDataPacket[]);
    const lastRedeemedTs = tsOf(redeemRows[0]?.r);
    const resetRows = await tenantSelect<RowDataPacket>({
      slug,
      table: "gift_progress_resets",
      columns: "MAX(reset_at) AS r",
      where: "gift_id = ? AND client_id IN (0, ?) AND source_state NOT IN ('campaign_disabled_start','campaign_disabled_end','fidelity_disabled_start','fidelity_disabled_end','reactivated')",
      params: [gid, clientId],
    }).catch(() => [] as RowDataPacket[]);
    const resetTs = tsOf(resetRows[0]?.r);
    const windowFrom = latestTs(validFromTs, tsOf(gift.created_at), lastRedeemedTs !== null ? lastRedeemedTs + 1000 : null, resetTs !== null ? resetTs + 1000 : null);

    // Regole della campagna.
    const setRows = await tenantSelect<RowDataPacket>({ slug, table: "gift_rule_sets", where: "gift_id = ?", params: [gid], orderBy: "sort_order ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
    const rules: GiftRuleRow[] = [];
    for (const set of setRows) {
      const ruleRows = await tenantSelect<RowDataPacket>({ slug, table: "gift_rules", where: "rule_set_id = ?", params: [Number(set.id)], orderBy: "sort_order ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
      for (const r of ruleRows) {
        rules.push({
          setId: Number(set.id),
          setOperator: clean(set.set_operator).toLowerCase() === "or" ? "or" : "and",
          ruleType: clean(r.rule_type).toLowerCase(),
          comparator: clean(r.comparator) || ">=",
          threshold: Number(r.threshold ?? 0) || 0,
          targetServiceId: Number(r.target_service_id ?? 0) || 0,
          targetProductId: Number(r.target_product_id ?? 0) || 0,
          floorTs: latestTs(tsOf(set.created_at), tsOf(r.created_at)),
        });
      }
    }
    if (!rules.length) continue; // senza regole resta tutto in accumulo (mai unlock automatico)

    // Freeze storico per la rivalutazione dei disponibili: finestra fino a unlocked_at.
    const isAvailable = instance && state === "disponibile";
    if (isAvailable && !forceRecheckAvailable) continue;
    const windowTo = isAvailable && forceRecheckAvailable ? (tsOf(instance?.unlocked_at) ?? validToTs) : validToTs;

    const evaluation = await evaluateGiftRulesForClient(slug, clientId, rules, windowFrom, windowTo, clean(gift.eligibility) === "fidelity_only");

    // Regressione disponibile -> accumulo (solo forceRecheck).
    if (isAvailable && forceRecheckAvailable && !evaluation.ok) {
      await tenantUpdate({
        slug,
        table: "gift_instances",
        id: Number(instance!.id),
        values: { state: "accumulo", unlocked_at: null, expires_at: null, progress_json: JSON.stringify({ ...evaluation, state: "accumulo", evaluated_at: nowSql }), updated_at: now },
      }).catch(() => 0);
      continue;
    }
    if (isAvailable) continue;

    // Serve un'istanza in accumulo? Solo se qualche regola ha progresso o già esiste.
    const hasProgress = evaluation.rules.some((r) => r.current > 0);
    let instId = instance ? Number(instance.id) : 0;
    if (!instance) {
      if (!hasProgress) continue;
      const table = await tenantTable(slug, "gift_instances");
      instId = await tenantInsert(table, {
        gift_id: gid,
        client_id: clientId,
        state: "accumulo",
        is_active: 1,
        progress_json: JSON.stringify({ ...evaluation, state: "accumulo", evaluated_at: nowSql }),
        created_at: now,
        updated_at: now,
      });
    }

    if (evaluation.ok) {
      // accumulo -> disponibile: unlock ADESSO, scadenza da expires_after_days.
      const days = Math.max(0, Math.min(36500, Math.round(Number(gift.expires_after_days ?? 0) || 0)));
      await tenantUpdate({
        slug,
        table: "gift_instances",
        id: instId,
        values: {
          state: "disponibile",
          unlocked_at: now,
          expires_at: days > 0 ? endOfDayAfterDays(now, days) : null,
          progress_json: JSON.stringify({ ...evaluation, state: "disponibile", unlocked_at: nowSql, evaluated_at: nowSql }),
          updated_at: now,
        },
      }).catch(() => 0);
    } else if (instId > 0) {
      await tenantUpdate({
        slug,
        table: "gift_instances",
        id: instId,
        values: { progress_json: JSON.stringify({ ...evaluation, state: "accumulo", evaluated_at: nowSql }), updated_at: now },
      }).catch(() => 0);
    }
  }
}

// ---------------------------------------------------------------------------
// SCADENZE ISTANZE — expireInstance / expireDueInstancesBatch
// ---------------------------------------------------------------------------

// expireInstance (Gifts.php ~10759): disponibile+oltre scadenza -> 'scaduto',
// annullando le prenotazioni aperte collegate (appointment_gift_items).
export async function giftExpireInstance(slug: string, instanceId: number): Promise<{ expired: boolean; canceledAppointments: number }> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "gift_instances", where: "id = ?", params: [instanceId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  const inst = rows[0];
  if (!inst) return { expired: false, canceledAppointments: 0 };
  const state = clean(inst.state);
  if (state !== "disponibile") return { expired: false, canceledAppointments: 0 };
  const exp = clean(inst.expires_at);
  if (!exp || exp >= toSql(new Date())) return { expired: false, canceledAppointments: 0 };

  let canceled = 0;
  const linkRows = await tenantSelect<RowDataPacket>({ slug, table: "appointment_gift_items", columns: "DISTINCT appointment_id", where: "gift_instance_id = ?", params: [instanceId] }).catch(() => [] as RowDataPacket[]);
  for (const link of linkRows) {
    const apptId = Number(link.appointment_id ?? 0);
    if (apptId <= 0) continue;
    const appt = await tenantSelect<RowDataPacket>({ slug, table: "appointments", columns: "id, status", where: "id = ? AND status IN ('pending','scheduled')", params: [apptId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    if (appt[0]) {
      await tenantUpdate({ slug, table: "appointments", id: apptId, values: { status: "canceled", cancelled_at: new Date(), cancelled_reason: `Annullamento automatico: omaggio scaduto #${instanceId}` } }).catch(() => 0);
      canceled += 1;
    }
  }

  await tenantUpdate({ slug, table: "gift_instances", id: instanceId, values: { state: "scaduto", is_active: 0, updated_at: new Date() } }).catch(() => 0);
  return { expired: true, canceledAppointments: canceled };
}

// expireDueInstancesBatch (Gifts.php ~10839) — per il cron fidelity-expire.
export async function giftExpireDueInstancesBatch(slug: string, limit = 500): Promise<{ expired: number; canceledAppointments: number }> {
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "gift_instances",
    columns: "id",
    where: "state = 'disponibile' AND is_active = 1 AND expires_at IS NOT NULL AND expires_at < ?",
    params: [toSql(new Date())],
    orderBy: "expires_at ASC",
    limit: Math.max(1, Math.min(1000, limit)),
  }).catch(() => [] as RowDataPacket[]);
  let expired = 0;
  let canceled = 0;
  for (const r of rows) {
    const res = await giftExpireInstance(slug, Number(r.id ?? 0)).catch(() => ({ expired: false, canceledAppointments: 0 }));
    if (res.expired) expired += 1;
    canceled += res.canceledAppointments;
  }
  return { expired, canceledAppointments: canceled };
}

// ---------------------------------------------------------------------------
// ROLLBACK SELEZIONE APPUNTAMENTO — rollbackAppointmentSelection (~11698-11888)
// ---------------------------------------------------------------------------

// Ripristina i collegamenti omaggio di un appuntamento (annullo, no-show,
// cancel-done, rimozione/eliminazione): per ogni riga appointment_gift_items
// scrive la transazione di storno ('cancel' se il riscatto era avvenuto o se
// e' un rollback da annullamento, 'unlink' per un semplice scollegamento di
// una riga ancora in sospeso), cancella le righe, riapre a 'disponibile' le
// istanze chiuse DA QUESTO appuntamento (redeemed_source_type='appointment' e
// redeemed_source_id = appointmentId) e ricalcola il cliente con forceRecheck.
export async function giftRollbackAppointmentSelection(
  slug: string,
  appointmentId: number,
  createdBy: number | null,
  opts: { cancelHistory?: boolean; note?: string } = {},
): Promise<{ rolledBack: number }> {
  if (appointmentId <= 0) return { rolledBack: 0 };
  const linkTable = await tenantTable(slug, "appointment_gift_items").catch(() => null);
  if (!linkTable) return { rolledBack: 0 };
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointment_gift_items",
    where: "appointment_id = ?",
    params: [appointmentId],
  }).catch(() => [] as RowDataPacket[]);
  if (!rows.length) return { rolledBack: 0 };

  // Un rollback "da annullamento" scrive sempre 'cancel' (legacy ~11737-11782:
  // cancel_history esplicito, status canceled/no_show o nota di annullamento).
  let isCancelRollback = !!opts.cancelHistory;
  if (!isCancelRollback) {
    const apptRows = await tenantSelect<RowDataPacket>({ slug, table: "appointments", columns: "status", where: "id = ?", params: [appointmentId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    const status = clean(apptRows[0]?.status).toLowerCase();
    isCancelRollback = ["canceled", "cancelled", "no_show"].includes(status);
  }

  const now = new Date();
  const txTable = await tenantTable(slug, "gift_transactions").catch(() => null);
  const instanceIds = new Set<number>();
  const clientIds = new Set<number>();
  for (const row of rows) {
    const instanceId = Number(row.instance_id ?? 0);
    if (instanceId <= 0) continue;
    instanceIds.add(instanceId);
    const wasRedeemed = !!row.redeemed_at;
    const txType = isCancelRollback || wasRedeemed ? "cancel" : "unlink";
    const note = clean(opts.note) || (txType === "cancel" ? `Annullato su prenotazione #${appointmentId}` : `Rimosso da prenotazione #${appointmentId}`);
    if (txTable) {
      await tenantInsert(txTable, {
        instance_id: instanceId,
        appointment_id: appointmentId,
        reward_item_index: Number(row.reward_item_index ?? 0),
        service_id: Number(row.service_id ?? 0) > 0 ? Number(row.service_id) : null,
        type: txType,
        qty: Math.max(1, Number(row.qty ?? 1) || 1),
        note: note.slice(0, 255),
        created_by: createdBy && createdBy > 0 ? createdBy : null,
        created_at: now,
      }).catch(() => 0);
    }
  }

  await dbExecute(
    `DELETE FROM ${quoteIdentifier(linkTable.name)} WHERE tenant_id = ? AND appointment_id = ?`,
    [linkTable.tenantId ?? 0, appointmentId],
  ).catch(() => ({ affectedRows: 0 }));

  // Riapertura delle istanze chiuse da questo appuntamento (~11851-11856).
  const instTable = await tenantTable(slug, "gift_instances").catch(() => null);
  for (const instanceId of instanceIds) {
    if (instTable) {
      await dbExecute(
        `UPDATE ${quoteIdentifier(instTable.name)}
            SET state = 'disponibile', is_active = 1, redeemed_at = NULL, redeemed_source_type = NULL,
                redeemed_source_id = NULL, points_spent = 0, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND redeemed_source_type = 'appointment' AND redeemed_source_id = ?`,
        [toSql(now), instTable.tenantId ?? 0, instanceId, appointmentId],
      ).catch(() => ({ affectedRows: 0 }));
    }
    const cRows = await tenantSelect<RowDataPacket>({ slug, table: "gift_instances", columns: "client_id", where: "id = ?", params: [instanceId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    const cid = Number(cRows[0]?.client_id ?? 0);
    if (cid > 0) clientIds.add(cid);
  }
  for (const cid of clientIds) {
    await giftRecalcClient(slug, cid, undefined, true).catch(() => undefined);
  }
  return { rolledBack: rows.length };
}

// Token voucher lazy (ensureInstanceVoucherPublicToken ~12044).
export async function ensureGiftVoucherToken(slug: string, instanceId: number): Promise<string> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "gift_instances", columns: "voucher_public_token", where: "id = ?", params: [instanceId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  const existing = clean(rows[0]?.voucher_public_token);
  if (existing) return existing;
  const token = randomBytes(32).toString("hex");
  await tenantUpdate({ slug, table: "gift_instances", id: instanceId, values: { voucher_public_token: token, updated_at: new Date() } }).catch(() => 0);
  return token;
}
