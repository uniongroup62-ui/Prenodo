import "server-only";

// ISTANZE OMAGGIO (Gifts v2, F12 Blocco 2) — port della pagina di dettaglio
// app/pages/gift_instance.php (1188 righe) + le funzioni istanza di
// app/lib/Gifts.php: instanceDetails (~4931), redeemInstanceItems (~5152),
// cancelInstance (~5395), deleteClosedInstance (~5529), updateInstanceNote /
// updateInstanceInternalNote (~2190-2244), sendGiftVoucherEmail (~12200),
// assignGiftManual (~5883), redeemedRewardQtyByInstance (~10127),
// applyDerivedInstanceState (~2095-2171), listTransactions (~12406).
//
// Meccaniche chiave (parità legacy):
//  - i "Tot/Usati/Da riscattare" per reward item derivano da gift_transactions
//    (SUM redeem - cancel per chiave reward_item_index:service_id) con fallback
//    appointment_gift_items.redeemed_at per le chiavi non coperte;
//  - il riscatto PARZIALE lascia l'istanza 'disponibile'; la chiusura a
//    'riscattato' avviene solo a residuo 0 (points_spent SEMPRE 0);
//  - lo stato è DERIVATO: un 'riscattato' che torna ad avere residuo riapre a
//    'disponibile' (redeemed_* azzerati), un residuo 0 chiude, un accumulo con
//    valid_to passata scade, un disponibile oltre expires_at scade (engine);
//  - annullo solo da 'disponibile', con conferma popup se esistono prenotazioni
//    collegate In attesa/Prenotata (annullate automaticamente);
//  - eliminazione definitiva solo per accumulo/annullato/scaduto, con marker in
//    gift_progress_resets (source_state = stato al momento della delete) e
//    eliminazione delle prenotazioni collegate.

import { randomBytes } from "crypto";
import type { RowDataPacket } from "@/lib/tenant-db";
import { columnExists, dbExecute, dbQuery, quoteIdentifier, tenantInsert, tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";
import { giftClientLevelKey, giftExpireInstance, giftRecalcClient, parseGiftEligibleLevels } from "@/lib/gifts-engine";
import { brandedSubject, buildModernEmailTemplate, EMAIL_ACCENT, emailButton, emailCodeBox, emailConfigured, sendEmail } from "@/lib/email";
import { deleteDbAppointment } from "@/lib/db-repositories";

const clean = (v: unknown) => String(v ?? "").trim();
const intOf = (v: unknown) => { const n = Number.parseInt(String(v ?? "0"), 10); return Number.isFinite(n) ? n : 0; };

function toIsoDt(value: unknown): string {
  if (!value) return "";
  if (value instanceof Date) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())} ${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}`;
  }
  return clean(value).replace("T", " ").slice(0, 19);
}

// Codice voucher legacy: OM-000000 (Gifts::giftVoucherCode).
export function giftVoucherCode(instanceId: number): string {
  return `OM-${String(Math.max(0, instanceId)).padStart(6, "0")}`;
}

// ---------------------------------------------------------------------------
// REWARD ITEMS — parsing + consumato per item
// ---------------------------------------------------------------------------

export type GiftRewardItemState = {
  index: number;
  type: "service" | "product" | "custom";
  label: string;
  serviceId: number;
  productId: number;
  qtyTotal: number;
  qtyRedeemed: number;
  qtyRemaining: number;
  pendingQty: number; // unità riservate a prenotazioni In attesa/Prenotata
};

type ParsedRewardItem = { type: "service" | "product" | "custom"; serviceId: number; productId: number; qty: number; label: string };

function parseRewardItems(rawJson: unknown, gift: RowDataPacket | null): ParsedRewardItem[] {
  let decoded: unknown = null;
  const s = typeof rawJson === "string" ? rawJson.trim() : "";
  if (s) { try { decoded = JSON.parse(s); } catch { decoded = null; } }
  const out: ParsedRewardItem[] = [];
  if (Array.isArray(decoded)) {
    for (const raw of decoded) {
      const entry = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
      let type = clean(entry.type ?? entry.reward_type ?? "custom").toLowerCase();
      if (type !== "service" && type !== "product" && type !== "custom") type = "custom";
      let qty = intOf(entry.qty ?? entry.reward_qty ?? entry.quantity ?? 1);
      if (qty <= 0) qty = 1;
      out.push({
        type: type as ParsedRewardItem["type"],
        serviceId: type === "service" ? intOf(entry.service_id ?? entry.reward_service_id) : 0,
        productId: type === "product" ? intOf(entry.product_id ?? entry.reward_product_id) : 0,
        qty,
        label: clean(entry.label ?? entry.custom_label ?? entry.name),
      });
    }
  }
  // Fallback legacy senza reward_items_json: il premio singolo del gift.
  if (!out.length && gift) {
    const rtype = clean(gift.reward_type).toLowerCase();
    if (rtype === "service" || rtype === "product" || rtype === "custom") {
      out.push({
        type: rtype as ParsedRewardItem["type"],
        serviceId: rtype === "service" ? intOf(gift.reward_service_id) : 0,
        productId: rtype === "product" ? intOf(gift.reward_product_id) : 0,
        qty: 1,
        label: clean(gift.reward_custom_label),
      });
    }
  }
  return out;
}

// Port di Gifts::redeemedRewardQtyByInstance: consumato per chiave
// "reward_item_index:service_id" da gift_transactions (redeem - cancel), più il
// fallback appointment_gift_items.redeemed_at per le chiavi non coperte.
async function redeemedRewardQtyMap(slug: string, instanceId: number): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const coveredKeys = new Set<string>();
  try {
    const txTable = await tenantTable(slug, "gift_transactions");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT COALESCE(reward_item_index, -1) AS idx, COALESCE(service_id, 0) AS sid,
              COALESCE(SUM(CASE WHEN type = 'redeem' THEN qty WHEN type = 'cancel' THEN -qty ELSE 0 END), 0) AS net,
              COALESCE(appointment_id, 0) AS appt
         FROM ${quoteIdentifier(txTable.name)}
        WHERE tenant_id = ? AND instance_id = ?
        GROUP BY COALESCE(appointment_id, 0), COALESCE(reward_item_index, -1), COALESCE(service_id, 0)`,
      [txTable.tenantId ?? 0, instanceId],
    );
    for (const r of rows) {
      const key = `${Number(r.idx)}:${Number(r.sid)}`;
      coveredKeys.add(`${Number(r.appt)}|${key}`);
      map.set(key, Math.max(0, (map.get(key) ?? 0) + Math.max(0, Number(r.net) || 0)));
    }
  } catch { /* tabella assente: solo fallback */ }
  try {
    const linkTable = await tenantTable(slug, "appointment_gift_items");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT COALESCE(appointment_id, 0) AS appt, COALESCE(reward_item_index, -1) AS idx, COALESCE(service_id, 0) AS sid, COALESCE(SUM(qty), 0) AS c
         FROM ${quoteIdentifier(linkTable.name)}
        WHERE tenant_id = ? AND instance_id = ? AND redeemed_at IS NOT NULL
        GROUP BY COALESCE(appointment_id, 0), COALESCE(reward_item_index, -1), COALESCE(service_id, 0)`,
      [linkTable.tenantId ?? 0, instanceId],
    );
    for (const r of rows) {
      const key = `${Number(r.idx)}:${Number(r.sid)}`;
      // Evita il doppio conteggio delle chiavi già coperte dalle transazioni
      // per lo stesso appuntamento (legacy ~10169-10175).
      if (coveredKeys.has(`${Number(r.appt)}|${key}`)) continue;
      map.set(key, Math.max(0, (map.get(key) ?? 0) + Math.max(0, Number(r.c) || 0)));
    }
  } catch { /* tabella assente */ }
  return map;
}

// Unità RISERVATE a prenotazioni aperte (In attesa/Prenotata) — port di
// gift_instance_page_collect_active_reservation_stats (~73-140).
async function pendingReservationMap(slug: string, instanceId: number): Promise<{ byKey: Map<string, number>; total: number }> {
  const byKey = new Map<string, number>();
  let total = 0;
  try {
    const linkTable = await tenantTable(slug, "appointment_gift_items");
    const apptTable = await tenantTable(slug, "appointments");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT COALESCE(agi.reward_item_index, -1) AS idx, COALESCE(agi.service_id, 0) AS sid, COALESCE(SUM(agi.qty), 0) AS c
         FROM ${quoteIdentifier(linkTable.name)} agi
         JOIN ${quoteIdentifier(apptTable.name)} a ON a.id = agi.appointment_id AND a.tenant_id = agi.tenant_id
        WHERE agi.tenant_id = ? AND agi.instance_id = ? AND agi.redeemed_at IS NULL
          AND LOWER(COALESCE(a.status, '')) IN ('pending', 'scheduled')
        GROUP BY COALESCE(agi.reward_item_index, -1), COALESCE(agi.service_id, 0)`,
      [linkTable.tenantId ?? 0, instanceId],
    );
    for (const r of rows) {
      const c = Math.max(0, Number(r.c) || 0);
      byKey.set(`${Number(r.idx)}:${Number(r.sid)}`, c);
      total += c;
    }
  } catch { /* tabelle assenti */ }
  return { byKey, total };
}

// Stato "Tot/Usati/Da riscattare" per ogni reward item (instanceRewardItemsState).
export async function giftInstanceRewardItemsState(slug: string, instanceId: number, gift: RowDataPacket): Promise<GiftRewardItemState[]> {
  const parsed = parseRewardItems(gift.reward_items_json, gift);
  if (!parsed.length) return [];
  const redeemed = await redeemedRewardQtyMap(slug, instanceId);
  const pending = await pendingReservationMap(slug, instanceId);

  // Label reali da servizi/prodotti.
  const svcIds = parsed.filter((p) => p.serviceId > 0).map((p) => p.serviceId);
  const prodIds = parsed.filter((p) => p.productId > 0).map((p) => p.productId);
  const svcNames = new Map<number, string>();
  const prodNames = new Map<number, string>();
  if (svcIds.length) {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "id, name", where: `id IN (${svcIds.map(() => "?").join(",")})`, params: svcIds }).catch(() => [] as RowDataPacket[]);
    for (const r of rows) svcNames.set(Number(r.id), clean(r.name));
  }
  if (prodIds.length) {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "products", columns: "id, name", where: `id IN (${prodIds.map(() => "?").join(",")})`, params: prodIds }).catch(() => [] as RowDataPacket[]);
    for (const r of rows) prodNames.set(Number(r.id), clean(r.name));
  }

  return parsed.map((p, index) => {
    const key = `${index}:${p.serviceId}`;
    const qtyRedeemed = Math.min(p.qty, Math.max(0, redeemed.get(key) ?? 0));
    let label = p.label;
    if (!label) {
      if (p.type === "service") label = svcNames.get(p.serviceId) ?? `Servizio #${p.serviceId}`;
      else if (p.type === "product") label = prodNames.get(p.productId) ?? `Prodotto #${p.productId}`;
      else label = clean(gift.reward_custom_label) || "Premio";
    }
    return {
      index,
      type: p.type,
      label,
      serviceId: p.serviceId,
      productId: p.productId,
      qtyTotal: p.qty,
      qtyRedeemed,
      qtyRemaining: Math.max(0, p.qty - qtyRedeemed),
      pendingQty: Math.max(0, pending.byKey.get(key) ?? 0),
    };
  });
}

// ---------------------------------------------------------------------------
// STATO DERIVATO — applyDerivedInstanceState (~2095-2171)
// ---------------------------------------------------------------------------

// Riallinea lo stato persistito alle unità residue: chiude a 'riscattato' se
// residuo 0, riapre a 'disponibile' un riscattato con residuo tornato > 0,
// scade un accumulo a campagna conclusa, scade un disponibile oltre expires_at.
async function applyDerivedState(slug: string, inst: RowDataPacket, gift: RowDataPacket): Promise<RowDataPacket> {
  const id = Number(inst.id ?? 0);
  const state = clean(inst.state).toLowerCase();
  const now = new Date();
  const nowIso = toIsoDt(now);

  if (state === "disponibile" && inst.expires_at && toIsoDt(inst.expires_at) < nowIso) {
    await giftExpireInstance(slug, id).catch(() => null);
    return (await reloadInstance(slug, id)) ?? inst;
  }
  if (state === "accumulo" && gift.valid_to && toIsoDt(gift.valid_to) < nowIso) {
    await tenantUpdate({ slug, table: "gift_instances", id, values: { state: "scaduto", is_active: 0, updated_at: now } }).catch(() => 0);
    return (await reloadInstance(slug, id)) ?? inst;
  }
  if (state === "disponibile" || state === "riscattato") {
    const items = await giftInstanceRewardItemsState(slug, id, gift);
    if (items.length) {
      const remaining = items.reduce((s, it) => s + it.qtyRemaining, 0);
      if (state === "disponibile" && remaining <= 0) {
        // fully_redeemed -> chiusura derivata.
        await tenantUpdate({ slug, table: "gift_instances", id, values: { state: "riscattato", is_active: 0, redeemed_at: inst.redeemed_at ?? now, updated_at: now } }).catch(() => 0);
        return (await reloadInstance(slug, id)) ?? inst;
      }
      if (state === "riscattato" && remaining > 0 && !inst.cancelled_at) {
        // shouldReopen: torna disponibile, redeemed_* azzerati (~2152-2171).
        await tenantUpdate({
          slug,
          table: "gift_instances",
          id,
          values: { state: "disponibile", is_active: 1, redeemed_at: null, redeemed_source_type: null, redeemed_source_id: null, updated_at: now },
        }).catch(() => 0);
        return (await reloadInstance(slug, id)) ?? inst;
      }
    }
  }
  return inst;
}

async function reloadInstance(slug: string, id: number): Promise<RowDataPacket | null> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "gift_instances", where: "id = ?", params: [id], limit: 1 }).catch(() => [] as RowDataPacket[]);
  return rows[0] ?? null;
}

async function loadGiftRow(slug: string, giftId: number): Promise<RowDataPacket | null> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "gifts", where: "id = ?", params: [giftId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// LISTA ISTANZE — gifts.php ~1155-1591 (25/pagina)
// ---------------------------------------------------------------------------

export type GiftInstanceListRow = {
  id: number;
  createdAt: string;
  clientId: number;
  clientName: string;
  giftId: number;
  giftName: string;
  locationName: string;
  state: string;
  expiresAt: string;
  manual: boolean;
};

export async function listGiftInstances(
  slug: string,
  filters: { clientId?: number; giftId?: number; state?: string; page?: number },
): Promise<{ rows: GiftInstanceListRow[]; page: number; perPage: number; totalPages: number; total: number }> {
  const perPage = 25;
  const page = Math.max(1, intOf(filters.page ?? 1) || 1);
  const instTable = await tenantTable(slug, "gift_instances");
  const giftsTable = await tenantTable(slug, "gifts");
  const clientsTable = await tenantTable(slug, "clients");

  const where: string[] = ["gi.tenant_id = ?"];
  const params: unknown[] = [instTable.tenantId ?? 0];
  if (filters.clientId && filters.clientId > 0) { where.push("gi.client_id = ?"); params.push(filters.clientId); }
  if (filters.giftId && filters.giftId > 0) { where.push("gi.gift_id = ?"); params.push(filters.giftId); }
  const state = clean(filters.state).toLowerCase();
  if (["accumulo", "disponibile", "riscattato", "scaduto", "annullato"].includes(state)) { where.push("LOWER(COALESCE(gi.state,'')) = ?"); params.push(state); }

  const countRows = await dbQuery<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM ${quoteIdentifier(instTable.name)} gi WHERE ${where.join(" AND ")}`,
    params,
  ).catch(() => [{ c: 0 }] as RowDataPacket[]);
  const total = Number(countRows[0]?.c ?? 0) || 0;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(page, totalPages);

  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT gi.id, gi.created_at, gi.client_id, gi.gift_id, gi.state, gi.expires_at, gi.location_name, gi.progress_json,
            g.name AS gift_name, c.full_name AS client_name
       FROM ${quoteIdentifier(instTable.name)} gi
       LEFT JOIN ${quoteIdentifier(giftsTable.name)} g ON g.id = gi.gift_id AND g.tenant_id = gi.tenant_id
       LEFT JOIN ${quoteIdentifier(clientsTable.name)} c ON c.id = gi.client_id AND c.tenant_id = gi.tenant_id
      WHERE ${where.join(" AND ")}
      ORDER BY gi.created_at DESC, gi.id DESC
      LIMIT ${perPage} OFFSET ${(safePage - 1) * perPage}`,
    params,
  ).catch(() => [] as RowDataPacket[]);

  return {
    rows: rows.map((r) => {
      let manual = false;
      try { manual = !!JSON.parse(String(r.progress_json ?? "{}"))?.manual; } catch { manual = false; }
      return {
        id: Number(r.id ?? 0),
        createdAt: toIsoDt(r.created_at),
        clientId: Number(r.client_id ?? 0),
        clientName: clean(r.client_name) || `#${Number(r.client_id ?? 0)}`,
        giftId: Number(r.gift_id ?? 0),
        giftName: clean(r.gift_name) || `Campagna #${Number(r.gift_id ?? 0)}`,
        locationName: clean(r.location_name),
        state: clean(r.state).toLowerCase(),
        expiresAt: toIsoDt(r.expires_at),
        manual,
      };
    }),
    page: safePage,
    perPage,
    totalPages,
    total,
  };
}

// ---------------------------------------------------------------------------
// DETTAGLIO ISTANZA — instanceDetails + pagina
// ---------------------------------------------------------------------------

const TX_TYPE_LABELS: Record<string, string> = {
  issue: "Emissione",
  pending: "In sospeso",
  redeem: "Riscatto",
  cancel: "Annullato",
  gift_cancel: "Omaggio annullato",
  expire: "Scadenza",
  gift_expire: "Omaggio scaduto",
  unlink: "Scollegato",
  adjust: "Modifica",
};

export type GiftInstanceTransaction = {
  id: number;
  createdAt: string;
  type: string;
  typeLabel: string;
  qty: number;
  serviceName: string;
  appointmentId: number;
  locationName: string;
  note: string;
  operatorName: string;
};

export type GiftLinkedAppointment = {
  id: number;
  status: string;
  startsAt: string;
  publicCode: string;
  itemsCount: number;
};

export type GiftInstanceDetail = {
  id: number;
  code: string;
  state: string;
  isActive: boolean;
  manual: boolean;
  giftId: number;
  giftName: string;
  giftDescription: string;
  termsEnabled: boolean;
  termsText: string;
  client: { id: number; name: string; phone: string; email: string };
  createdAt: string;
  unlockedAt: string;
  expiresAt: string;
  redeemedAt: string;
  cancelledAt: string;
  cancelReason: string;
  locationName: string;
  note: string;
  internalNote: string;
  lastEmailSentAt: string;
  lastEmailSentTo: string;
  progressRules: Array<{ label: string; current: number; needed: number; ok: boolean }>;
  rewardItems: GiftRewardItemState[];
  pendingTotal: number;
  transactions: GiftInstanceTransaction[];
  linkedAppointments: GiftLinkedAppointment[];
  canCancel: boolean;
  canDelete: boolean;
  deletePerformsReset: boolean;
  voucherToken: string;
};

// Prenotazioni collegate aperte (loadLinkedAppointmentsForInstance ~10576).
async function loadLinkedAppointments(slug: string, instanceId: number): Promise<GiftLinkedAppointment[]> {
  try {
    const linkTable = await tenantTable(slug, "appointment_gift_items");
    const apptTable = await tenantTable(slug, "appointments");
    const hasCode = await columnExists(apptTable.name, "public_code");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT a.id, a.status, a.starts_at, ${hasCode ? "a.public_code" : "'' AS public_code"}, COUNT(agi.id) AS items
         FROM ${quoteIdentifier(linkTable.name)} agi
         JOIN ${quoteIdentifier(apptTable.name)} a ON a.id = agi.appointment_id AND a.tenant_id = agi.tenant_id
        WHERE agi.tenant_id = ? AND agi.instance_id = ? AND agi.redeemed_at IS NULL
          AND LOWER(COALESCE(a.status, '')) IN ('pending', 'scheduled')
        GROUP BY a.id, a.status, a.starts_at${hasCode ? ", a.public_code" : ""}
        ORDER BY a.starts_at ASC`,
      [linkTable.tenantId ?? 0, instanceId],
    );
    return rows.map((r) => ({
      id: Number(r.id ?? 0),
      status: clean(r.status).toLowerCase(),
      startsAt: toIsoDt(r.starts_at),
      publicCode: clean(r.public_code),
      itemsCount: Number(r.items ?? 0) || 0,
    }));
  } catch {
    return [];
  }
}

// Token voucher lazy (ensureInstanceVoucherPublicToken ~12044).
// Token voucher per la variante MANAGE del viewer omaggi (?id=N — legacy
// gift_voucher.php con login): legge l'istanza e riusa il backfill lazy.
export async function giftVoucherTokenById(slug: string, instanceId: number): Promise<string> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "gift_instances", columns: "id, voucher_public_token", where: "id = ?", params: [instanceId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  if (!rows[0]) return "";
  return ensureVoucherToken(slug, instanceId, rows[0].voucher_public_token);
}

export async function ensureVoucherToken(slug: string, instanceId: number, current: unknown): Promise<string> {
  const existing = clean(current);
  if (/^[a-f0-9]{64}$/i.test(existing)) return existing.toLowerCase();
  const token = randomBytes(32).toString("hex");
  await tenantUpdate({ slug, table: "gift_instances", id: instanceId, values: { voucher_public_token: token, updated_at: new Date() } }).catch(() => 0);
  return token;
}

export async function getGiftInstanceDetail(slug: string, instanceId: number): Promise<GiftInstanceDetail | null> {
  if (instanceId <= 0) return null;
  let inst = await reloadInstance(slug, instanceId);
  if (!inst) return null;
  const gift = await loadGiftRow(slug, Number(inst.gift_id ?? 0));
  if (!gift) return null;

  // Stato derivato + auto-scadenza alla lettura (gift_instance.php ~394-413).
  inst = await applyDerivedState(slug, inst, gift);

  const clientId = Number(inst.client_id ?? 0);
  const clientRows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "id, full_name, phone, email", where: "id = ?", params: [clientId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  const client = clientRows[0] ?? null;

  let progress: Record<string, unknown> = {};
  try { progress = JSON.parse(String(inst.progress_json ?? "{}")) ?? {}; } catch { progress = {}; }
  const rawRules = Array.isArray(progress.rules) ? (progress.rules as Array<Record<string, unknown>>) : [];
  const RULE_LABELS: Record<string, string> = {
    service_qty: "Quantità servizio",
    product_qty: "Quantità prodotto",
    appointments_count: "Appuntamenti eseguiti",
    total_spend: "Spesa totale",
    first_visit: "Prima visita",
  };
  const progressRules = rawRules.map((r) => ({
    label: clean(r.label) || RULE_LABELS[clean(r.type)] || clean(r.type) || "Regola",
    current: Number(r.display_current ?? r.current ?? 0) || 0,
    needed: Number(r.needed ?? 0) || 0,
    ok: !!r.ok,
  }));

  const rewardItems = await giftInstanceRewardItemsState(slug, instanceId, gift);
  const pending = await pendingReservationMap(slug, instanceId);
  const linkedAppointments = await loadLinkedAppointments(slug, instanceId);

  // Movimenti (listTransactions ~12406, con riga virtuale 'issue' in coda).
  const txTable = await tenantTable(slug, "gift_transactions");
  const usersTable = await tenantTable(slug, "users").catch(() => null);
  const svcTable = await tenantTable(slug, "services");
  const txRows = await dbQuery<RowDataPacket[]>(
    `SELECT t.id, t.created_at, t.type, t.qty, t.note, t.appointment_id, t.location_name, s.name AS service_name${usersTable ? ", u.name AS operator_name" : ", '' AS operator_name"}
       FROM ${quoteIdentifier(txTable.name)} t
       LEFT JOIN ${quoteIdentifier(svcTable.name)} s ON s.id = t.service_id AND s.tenant_id = t.tenant_id
       ${usersTable ? `LEFT JOIN ${quoteIdentifier(usersTable.name)} u ON u.id = t.created_by AND u.tenant_id = t.tenant_id` : ""}
      WHERE t.tenant_id = ? AND t.instance_id = ?
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT 500`,
    [txTable.tenantId ?? 0, instanceId],
  ).catch(() => [] as RowDataPacket[]);
  const transactions: GiftInstanceTransaction[] = txRows.map((r) => ({
    id: Number(r.id ?? 0),
    createdAt: toIsoDt(r.created_at),
    type: clean(r.type).toLowerCase(),
    typeLabel: TX_TYPE_LABELS[clean(r.type).toLowerCase()] ?? clean(r.type),
    qty: Number(r.qty ?? 0) || 0,
    serviceName: clean(r.service_name),
    appointmentId: Number(r.appointment_id ?? 0) || 0,
    locationName: clean(r.location_name),
    note: clean(r.note),
    operatorName: clean(r.operator_name),
  }));
  // Riga virtuale "Emissione" alla creazione (in coda, come il legacy).
  transactions.push({
    id: 0,
    createdAt: toIsoDt(inst.created_at),
    type: "issue",
    typeLabel: TX_TYPE_LABELS.issue,
    qty: 1,
    serviceName: "",
    appointmentId: 0,
    locationName: clean(inst.location_name),
    note: "Creazione istanza",
    operatorName: "",
  });

  const state = clean(inst.state).toLowerCase();
  return {
    id: instanceId,
    code: giftVoucherCode(instanceId),
    state,
    isActive: Number(inst.is_active ?? 0) === 1,
    manual: !!progress.manual,
    giftId: Number(inst.gift_id ?? 0),
    giftName: clean(gift.name) || `Campagna #${Number(inst.gift_id ?? 0)}`,
    giftDescription: clean(gift.description),
    termsEnabled: Number(gift.terms_enabled ?? 0) === 1,
    termsText: clean(gift.terms_text),
    client: {
      id: clientId,
      name: clean(client?.full_name) || `#${clientId}`,
      phone: clean(client?.phone),
      email: clean(client?.email),
    },
    createdAt: toIsoDt(inst.created_at),
    unlockedAt: toIsoDt(inst.unlocked_at),
    expiresAt: toIsoDt(inst.expires_at),
    redeemedAt: toIsoDt(inst.redeemed_at),
    cancelledAt: toIsoDt(inst.cancelled_at),
    cancelReason: clean(inst.cancel_reason),
    locationName: clean(inst.location_name),
    note: clean(inst.note),
    internalNote: clean(inst.internal_note),
    lastEmailSentAt: toIsoDt(inst.last_email_sent_at),
    lastEmailSentTo: clean(inst.last_email_sent_to),
    progressRules,
    rewardItems,
    pendingTotal: pending.total,
    transactions,
    linkedAppointments,
    canCancel: state === "disponibile",
    canDelete: ["accumulo", "annullato", "scaduto"].includes(state),
    deletePerformsReset: state === "accumulo",
    voucherToken: await ensureVoucherToken(slug, instanceId, inst.voucher_public_token),
  };
}

// ---------------------------------------------------------------------------
// RISCATTO MANUALE/PARZIALE — redeemInstanceItems (~5152-5382)
// ---------------------------------------------------------------------------

async function clientAdhering(slug: string, clientId: number): Promise<boolean> {
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

export async function redeemGiftInstanceItems(
  slug: string,
  input: {
    instanceId: number;
    qtyByItem: Record<number, number>;
    by: number | null;
    sourceType?: "manual" | "appointment";
    sourceId?: number | null;
    note?: string;
    location?: { id: number; name: string } | null;
  },
): Promise<{ ok: true; message: string; redeemedAll: boolean; redeemedQty: number; remainingQty: number }> {
  const instanceId = Math.max(0, input.instanceId);
  if (instanceId <= 0) throw new Error("Omaggio non valido");
  const requested = Object.entries(input.qtyByItem ?? {})
    .map(([idx, qty]) => ({ index: intOf(idx), qty: Math.max(0, intOf(qty)) }))
    .filter((e) => e.index >= 0 && e.qty > 0);
  if (!requested.length) throw new Error("Seleziona almeno un elemento da riscattare");

  let inst = await reloadInstance(slug, instanceId);
  if (!inst) throw new Error("Omaggio non valido");
  const gift = await loadGiftRow(slug, Number(inst.gift_id ?? 0));
  if (!gift) throw new Error("Omaggio non valido");
  inst = await applyDerivedState(slug, inst, gift);

  if (Number(inst.is_active ?? 0) !== 1) throw new Error("Omaggio non attivo");
  const state = clean(inst.state).toLowerCase();
  if (state !== "disponibile") throw new Error("Omaggio non disponibile");
  const nowIso = toIsoDt(new Date());
  if (inst.expires_at && toIsoDt(inst.expires_at) < nowIso) {
    await giftExpireInstance(slug, instanceId).catch(() => null);
    throw new Error("Omaggio scaduto");
  }

  // Idoneità Fidelity (salvo assegnazione manuale con override).
  let progress: Record<string, unknown> = {};
  try { progress = JSON.parse(String(inst.progress_json ?? "{}")) ?? {}; } catch { progress = {}; }
  const manualOverride = !!progress.manual || !!progress.eligibility_override;
  if (clean(gift.eligibility).toLowerCase() === "fidelity_only" && !manualOverride) {
    if (!(await clientAdhering(slug, Number(inst.client_id ?? 0)))) throw new Error("Cliente non aderisce alla Fidelity");
    // Livelli idonei (redeemInstanceItems ~5267): il livello ATTUALE del cliente
    // deve rientrare nella lista della campagna (vuota = nessun filtro).
    const eligibleLevels = parseGiftEligibleLevels(gift.eligible_levels_points);
    if (eligibleLevels.length > 0) {
      const levelKey = await giftClientLevelKey(slug, Number(inst.client_id ?? 0));
      if (!levelKey || !eligibleLevels.includes(levelKey)) throw new Error("Livello cliente non idoneo per questo gift");
    }
  }

  const items = await giftInstanceRewardItemsState(slug, instanceId, gift);
  const byIndex = new Map(items.map((it) => [it.index, it]));

  // Pre-validazione pagina: la quantità richiesta non può superare il residuo
  // MENO le unità già in sospeso su prenotazioni (validate_manual_redeem_request).
  if (input.sourceType !== "appointment") {
    for (const req of requested) {
      const it = byIndex.get(req.index);
      if (!it) throw new Error("Istanza non valida.");
      const usable = Math.max(0, it.qtyRemaining - it.pendingQty);
      if (req.qty > usable && it.pendingQty > 0) {
        throw new Error(`Quantità non disponibile per "${it.label}". ${it.pendingQty} già in sospeso su prenotazioni.`);
      }
    }
  }

  // Selezione effettiva troncata al residuo.
  const remainingBefore = items.reduce((s, it) => s + it.qtyRemaining, 0);
  const selection = requested
    .map((req) => {
      const it = byIndex.get(req.index);
      if (!it) return null;
      const qty = Math.min(req.qty, it.qtyRemaining);
      return qty > 0 ? { item: it, qty } : null;
    })
    .filter((x): x is { item: GiftRewardItemState; qty: number } => x !== null);
  if (!selection.length) throw new Error("Nessun elemento riscattabile selezionato");

  const noteDefault = input.sourceType === "appointment" && input.sourceId ? `Riscatto su prenotazione #${input.sourceId}` : "Riscatto manuale";
  const note = (clean(input.note) || noteDefault).slice(0, 255);
  const now = new Date();
  const txTable = await tenantTable(slug, "gift_transactions");
  let redeemedNow = 0;
  for (const sel of selection) {
    // INSERT GUARDATO (il legacy serializzava con SELECT ... FOR UPDATE,
    // Gifts.php ~5034): il residuo viene ricontrollato ATOMICAMENTE nel WHERE
    // (net redeem-cancel della stessa chiave + qty richiesta <= qty totale),
    // così due riscatti concorrenti non superano mai il premio.
    const guard = await dbExecute(
      `INSERT INTO ${quoteIdentifier(txTable.name)} (tenant_id, instance_id, appointment_id, reward_item_index, service_id, type, qty, note, created_by, created_at, location_id, location_name)
       SELECT ?, ?, ?, ?, ?, 'redeem', ?, ?, ?, ?, ?, ?
        WHERE (SELECT COALESCE(SUM(CASE WHEN type = 'redeem' THEN qty WHEN type = 'cancel' THEN -qty ELSE 0 END), 0)
                 FROM ${quoteIdentifier(txTable.name)}
                WHERE tenant_id = ? AND instance_id = ? AND COALESCE(reward_item_index, -1) = ? AND COALESCE(service_id, 0) = ?) + ? <= ?`,
      [
        txTable.tenantId ?? 0, instanceId,
        input.sourceType === "appointment" && input.sourceId ? input.sourceId : null,
        sel.item.index, sel.item.serviceId > 0 ? sel.item.serviceId : null,
        sel.qty, note, input.by && input.by > 0 ? input.by : null, now,
        input.location?.id && input.location.id > 0 ? input.location.id : null,
        clean(input.location?.name) || null,
        txTable.tenantId ?? 0, instanceId, sel.item.index, sel.item.serviceId > 0 ? sel.item.serviceId : 0,
        sel.qty, sel.item.qtyTotal,
      ],
    );
    if (Number((guard as { affectedRows?: number }).affectedRows ?? 0) <= 0) {
      throw new Error(`Quantità non disponibile per "${sel.item.label}".`);
    }
    redeemedNow += sel.qty;
    // Stock premio prodotto (decrementRedeemedProductStock, best-effort).
    if (sel.item.productId > 0) {
      const prodTable = await tenantTable(slug, "products").catch(() => null);
      if (prodTable && (await columnExists(prodTable.name, "stock"))) {
        await dbQuery(`UPDATE ${quoteIdentifier(prodTable.name)} SET stock = GREATEST(COALESCE(stock,0) - ?, 0) WHERE tenant_id = ? AND id = ?`, [sel.qty, prodTable.tenantId ?? 0, sel.item.productId]).catch(() => []);
      }
    }
  }

  const redeemedAll = remainingBefore - redeemedNow <= 0;
  if (redeemedAll) {
    // Chiusura: points_spent SEMPRE 0 (gli omaggi non scalano punti).
    await tenantUpdate({
      slug,
      table: "gift_instances",
      id: instanceId,
      values: {
        state: "riscattato",
        is_active: 0,
        redeemed_at: now,
        redeemed_source_type: input.sourceType === "appointment" ? "appointment" : "manual",
        redeemed_source_id: input.sourceType === "appointment" && input.sourceId ? input.sourceId : null,
        points_spent: 0,
        updated_at: now,
      },
    });
    // Ricalcolo per i ripetibili (recalcClient ~5362).
    await giftRecalcClient(slug, Number(inst.client_id ?? 0), Number(inst.gift_id ?? 0)).catch(() => undefined);
  }

  return {
    ok: true,
    message: redeemedAll ? "Omaggio riscattato completamente" : "Riscatto registrato",
    redeemedAll,
    redeemedQty: redeemedNow,
    remainingQty: Math.max(0, remainingBefore - redeemedNow),
  };
}

// ---------------------------------------------------------------------------
// ANNULLO — cancelInstance (~5395-5526)
// ---------------------------------------------------------------------------

export async function cancelGiftInstance(
  slug: string,
  instanceId: number,
  by: number | null,
  reasonRaw: string,
  confirmLinkedAppointments: boolean,
): Promise<{ ok: true; message: string }> {
  let inst = await reloadInstance(slug, instanceId);
  if (!inst) throw new Error("Omaggio non valido");
  const gift = await loadGiftRow(slug, Number(inst.gift_id ?? 0));
  if (!gift) throw new Error("Omaggio non valido");
  inst = await applyDerivedState(slug, inst, gift);

  const state = clean(inst.state).toLowerCase();
  if (Number(inst.is_active ?? 0) !== 1) throw new Error("Omaggio non attivo");
  if (state !== "disponibile") throw new Error("Solo un omaggio disponibile può essere annullato");
  const now = new Date();
  if (inst.expires_at && toIsoDt(inst.expires_at) < toIsoDt(now)) {
    await giftExpireInstance(slug, instanceId).catch(() => null);
    throw new Error("Omaggio scaduto");
  }

  // Prenotazioni collegate aperte: senza conferma dal popup, blocco legacy.
  const linked = await loadLinkedAppointments(slug, instanceId);
  if (linked.length && !confirmLinkedAppointments) {
    throw new Error("Sono presenti prenotazioni collegate in stato In attesa/Prenotata. Conferma l'annullamento dal popup per procedere.");
  }
  let canceledCount = 0;
  for (const appt of linked) {
    await tenantUpdate({
      slug,
      table: "appointments",
      id: appt.id,
      values: { status: "canceled", cancelled_at: now, cancelled_reason: `Annullamento automatico: omaggio annullato #${instanceId}` },
    }).catch(() => 0);
    canceledCount += 1;
  }

  const reason = (clean(reasonRaw) || "Annullato da operatore").slice(0, 255);
  // Marcatori reset dentro progress_json (~5470-5488): il ricalcolo riparte
  // solo dagli eventi successivi a reset_window_from.
  let progress: Record<string, unknown> = {};
  try { progress = JSON.parse(String(inst.progress_json ?? "{}")) ?? {}; } catch { progress = {}; }
  const resetFrom = toIsoDt(new Date(now.getTime() + 1000));
  const newProgress = {
    ...progress,
    state: "annullato",
    manual_cancelled: true,
    manual_cancelled_at: toIsoDt(now),
    reset_window_from: resetFrom,
    cancelled_by_operator: true,
    cancelled_from_state: state,
    cancel_reason: reason,
    cancelled_reason: reason,
  };
  await tenantUpdate({
    slug,
    table: "gift_instances",
    id: instanceId,
    values: { state: "annullato", is_active: 0, cancel_reason: reason, cancelled_at: now, progress_json: JSON.stringify(newProgress), updated_at: now },
  });
  await tenantInsert(await tenantTable(slug, "gift_transactions"), {
    instance_id: instanceId,
    type: "gift_cancel",
    qty: 1,
    note: reason,
    created_by: by && by > 0 ? by : null,
    created_at: now,
  }).catch(() => 0);

  // Chiudi eventuali altre istanze attive dello stesso gift/cliente (~5503).
  const others = await tenantSelect<RowDataPacket>({
    slug,
    table: "gift_instances",
    columns: "id",
    where: "gift_id = ? AND client_id = ? AND is_active = 1 AND id <> ?",
    params: [Number(inst.gift_id ?? 0), Number(inst.client_id ?? 0), instanceId],
  }).catch(() => [] as RowDataPacket[]);
  for (const o of others) {
    await tenantUpdate({ slug, table: "gift_instances", id: Number(o.id), values: { state: "annullato", is_active: 0, cancel_reason: reason, cancelled_at: now, updated_at: now } }).catch(() => 0);
  }

  const suffix = canceledCount > 0 ? `: annullate automaticamente ${canceledCount} prenotazioni collegate` : "";
  return { ok: true, message: `Omaggio annullato${suffix}` };
}

// ---------------------------------------------------------------------------
// ELIMINAZIONE — deleteClosedInstance (~5529-5690)
// ---------------------------------------------------------------------------

export async function deleteClosedGiftInstance(slug: string, instanceId: number, by: number | null): Promise<{ ok: true; message: string; clientId: number }> {
  const inst = await reloadInstance(slug, instanceId);
  if (!inst) throw new Error("Omaggio non valido");
  const state = clean(inst.state).toLowerCase();
  if (!["accumulo", "annullato", "scaduto"].includes(state)) {
    throw new Error("È possibile eliminare solo omaggi in accumulo, annullati o scaduti");
  }
  const clientId = Number(inst.client_id ?? 0);
  const giftId = Number(inst.gift_id ?? 0);
  const now = new Date();

  // Elimina le prenotazioni collegate (legacy appt_lifecycle_cancel_and_delete):
  // deleteDbAppointment ripristina i riscatti/redeem prima della rimozione.
  const linkRows = await tenantSelect<RowDataPacket>({ slug, table: "appointment_gift_items", columns: "DISTINCT appointment_id", where: "instance_id = ?", params: [instanceId] }).catch(() => [] as RowDataPacket[]);
  let deletedAppointments = 0;
  for (const r of linkRows) {
    const apptId = Number(r.appointment_id ?? 0);
    if (apptId <= 0) continue;
    const ok = await deleteDbAppointment(slug, apptId).catch(() => false);
    if (ok) deletedAppointments += 1;
  }

  const linkTable = await tenantTable(slug, "appointment_gift_items");
  await dbQuery(`DELETE FROM ${quoteIdentifier(linkTable.name)} WHERE tenant_id = ? AND instance_id = ?`, [linkTable.tenantId ?? 0, instanceId]).catch(() => []);
  const txTable = await tenantTable(slug, "gift_transactions");
  await dbQuery(`DELETE FROM ${quoteIdentifier(txTable.name)} WHERE tenant_id = ? AND instance_id = ?`, [txTable.tenantId ?? 0, instanceId]).catch(() => []);

  // Marker reset in gift_progress_resets (persistProgressResetMarker ~6217):
  // source_state = stato dell'istanza al momento della delete. Per l'accumulo
  // il reset fa ripartire il cliente dagli eventi successivi (skip progressi
  // già conteggiati); annullato/scaduto preservano l'esclusione storica.
  const suffixes: string[] = [];
  try {
    await tenantInsert(await tenantTable(slug, "gift_progress_resets"), {
      gift_id: giftId,
      client_id: clientId,
      source_instance_id: instanceId,
      source_state: state,
      reset_at: now,
      reason: `Eliminazione istanza #${instanceId} (${state})`,
      created_by: by && by > 0 ? by : null,
      created_at: now,
    });
    if (state === "accumulo") {
      suffixes.push("I progressi già conteggiati non verranno riutilizzati: il cliente ripartirà solo da eventuali eventi successivi.");
    }
    suffixes.push("Reset progressione cliente/campagna salvato.");
  } catch { /* tabella assente: nessun marker */ }
  if (deletedAppointments > 0) suffixes.push(`Prenotazioni eliminate: ${deletedAppointments}.`);

  const instTable = await tenantTable(slug, "gift_instances");
  await dbQuery(`DELETE FROM ${quoteIdentifier(instTable.name)} WHERE tenant_id = ? AND id = ?`, [instTable.tenantId ?? 0, instanceId]);

  await giftRecalcClient(slug, clientId, giftId).catch(() => undefined);
  return { ok: true, message: ["Gift eliminato definitivamente", ...suffixes].join(" "), clientId };
}

// ---------------------------------------------------------------------------
// NOTE — updateInstanceNote / updateInstanceInternalNote (~2190-2244)
// ---------------------------------------------------------------------------

export async function updateGiftInstanceNote(slug: string, instanceId: number, note: string): Promise<{ ok: true; message: string }> {
  const inst = await reloadInstance(slug, instanceId);
  if (!inst) throw new Error("Omaggio non valido");
  await tenantUpdate({ slug, table: "gift_instances", id: instanceId, values: { note: clean(note).slice(0, 2000) || null, updated_at: new Date() } });
  return { ok: true, message: "Nota cliente salvata" };
}

export async function updateGiftInstanceInternalNote(slug: string, instanceId: number, note: string): Promise<{ ok: true; message: string }> {
  const inst = await reloadInstance(slug, instanceId);
  if (!inst) throw new Error("Omaggio non valido");
  await tenantUpdate({ slug, table: "gift_instances", id: instanceId, values: { internal_note: clean(note).slice(0, 2000) || null, updated_at: new Date() } });
  return { ok: true, message: "Nota interna salvata" };
}

// ---------------------------------------------------------------------------
// EMAIL VOUCHER — sendGiftVoucherEmail (~12200-12404)
// ---------------------------------------------------------------------------

export async function sendGiftVoucherEmailManage(slug: string, instanceId: number, toRaw: string): Promise<{ ok: true; message: string }> {
  const detail = await getGiftInstanceDetail(slug, instanceId);
  if (!detail) throw new Error("Omaggio non valido");
  if (detail.state === "annullato") throw new Error("L'omaggio è annullato e non può essere inviato");
  if (detail.state === "scaduto") throw new Error("L'omaggio è scaduto e non può essere inviato");
  if (detail.state === "riscattato") throw new Error("L'omaggio è già riscattato");
  if (detail.state !== "disponibile") throw new Error("L'omaggio non è ancora disponibile");
  const to = clean(toRaw);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error("Email destinatario non valida");
  if (!emailConfigured()) throw new Error("Invio email non disponibile");

  const bizRows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "name, email, phone", orderBy: "id ASC", limit: 1 }).catch(() => [] as RowDataPacket[]);
  const biz = bizRows[0] ?? null;
  const bizName = clean(biz?.name) || "BeautySuite";

  const base = String(process.env.PRENODO_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  const voucherUrl = `${base}/${slug}/gift_voucher?public=1&embed=1&token=${encodeURIComponent(detail.voucherToken)}`;
  const h = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const fmtIt = (iso: string) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
  let html = `<div style="background:${EMAIL_ACCENT};color:#ffffff;padding:16px 20px;border-radius:12px 12px 0 0;font-size:18px;font-weight:700">Voucher omaggio</div>`;
  html += `<div style="border:1px solid #e5e7eb;border-top:0;padding:20px;border-radius:0 0 12px 12px">`;
  html += `<p style="margin:0 0 6px">Ciao ${h(detail.client.name)},</p>`;
  html += `<p style="margin:0 0 14px">il tuo omaggio <strong>${h(detail.giftName)}</strong> è disponibile!</p>`;
  html += `<div style="text-align:center;margin:14px 0">${emailCodeBox(detail.code)}<div style="font-size:12px;color:#6b7280;margin-top:6px">MOSTRA QUESTO CODICE IN CASSA</div></div>`;
  html += `<div style="text-align:center;margin:14px 0">${emailButton(voucherUrl, "Vedi Voucher")}</div>`;
  html += `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:10px 0">`;
  const row = (k: string, v: string) => `<tr><td style="padding:6px 0;color:#6b7280">${h(k)}</td><td style="padding:6px 0;text-align:right;font-weight:600">${h(v)}</td></tr>`;
  html += row("Cliente", detail.client.name);
  html += row("Gift", detail.giftName);
  html += row("Disponibile dal", fmtIt(detail.unlockedAt.slice(0, 10)));
  html += row("Scadenza", detail.expiresAt ? fmtIt(detail.expiresAt.slice(0, 10)) : "Nessuna scadenza");
  html += `</table>`;
  if (detail.rewardItems.length) {
    html += `<p style="margin:12px 0 4px;font-weight:700">Contenuto omaggio</p><ul style="margin:0 0 10px;padding-left:18px">`;
    for (const it of detail.rewardItems) html += `<li>${h(it.label)}${it.qtyTotal > 1 ? ` × ${it.qtyTotal}` : ""}</li>`;
    html += `</ul>`;
  }
  if (detail.note) html += `<p style="margin:12px 0 4px;font-weight:700">Nota per il cliente</p><p style="margin:0 0 10px">${h(detail.note)}</p>`;
  if (detail.termsEnabled && detail.termsText) {
    html += `<p style="margin:12px 0 4px;font-weight:700">Condizioni</p><p style="margin:0;color:#6b7280;font-size:12px">${h(detail.termsText)}</p>`;
  }
  html += `</div>`;

  const subject = brandedSubject(bizName, `Il tuo voucher omaggio è disponibile - ${detail.giftName}`);
  const tpl = buildModernEmailTemplate(subject, html, { business_name: bizName, business_email: clean(biz?.email) });
  const sent = await sendEmail({ to, subject, html: tpl.html, text: tpl.text, fromName: bizName || undefined, replyTo: clean(biz?.email) || undefined });
  if (!sent.ok) throw new Error("Invio email fallito");

  await tenantUpdate({ slug, table: "gift_instances", id: instanceId, values: { last_email_sent_at: new Date(), last_email_sent_to: to, updated_at: new Date() } }).catch(() => 0);
  return { ok: true, message: `Voucher inviato a ${to}` };
}

// ---------------------------------------------------------------------------
// ASSEGNAZIONE MANUALE — assignGiftManual (~5883-6076)
// ---------------------------------------------------------------------------

function endOfDayAfterDays(base: Date, days: number): string {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + Math.max(0, Math.round(days)), 23, 59, 59);
  return toIsoDt(d);
}

export async function checkGiftManualAssignmentEligibility(slug: string, giftId: number, clientId: number): Promise<{ eligible: boolean; canForce: boolean; reason: string }> {
  const gift = await loadGiftRow(slug, giftId);
  if (!gift || gift.deleted_at) return { eligible: false, canForce: false, reason: "Omaggio non trovato" };
  if (clean(gift.eligibility).toLowerCase() === "fidelity_only" && !(await clientAdhering(slug, clientId))) {
    return { eligible: false, canForce: true, reason: "Cliente non aderisce alla Fidelity" };
  }
  return { eligible: true, canForce: false, reason: "" };
}

export async function assignGiftManual(
  slug: string,
  input: { giftId: number; clientId: number; expiresDays?: number | null; by: number | null; forceIneligible?: boolean; location?: { id: number; name: string } | null },
): Promise<{ ok: true; message: string; instanceId: number } | { ok: false; ineligible: true; canForce: boolean; error: string }> {
  const giftId = Math.max(0, input.giftId);
  const clientId = Math.max(0, input.clientId);
  if (giftId <= 0 || clientId <= 0) throw new Error("Dati non validi");
  const gift = await loadGiftRow(slug, giftId);
  if (!gift || gift.deleted_at) throw new Error("Omaggio non trovato");
  if (Number(gift.active ?? 0) !== 1) throw new Error("Omaggio non attivo");
  const clientRows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "id", where: "id = ?", params: [clientId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  if (!clientRows[0]) throw new Error("Cliente non trovato");

  // Validità obbligatoria (assignGiftManual ~5910-5930).
  const now = new Date();
  const nowIso = toIsoDt(now);
  const validFrom = toIsoDt(gift.valid_from);
  const validTo = toIsoDt(gift.valid_to);
  if (!validFrom || !validTo) throw new Error("Validità omaggio non configurata");
  if (validFrom > nowIso) throw new Error("Omaggio non ancora valido");
  if (validTo < nowIso) throw new Error("Omaggio scaduto");

  // Idoneità (forzabile con conferma dall'UI).
  const eligibility = await checkGiftManualAssignmentEligibility(slug, giftId, clientId);
  if (!eligibility.eligible && !input.forceIneligible) {
    if (eligibility.canForce) return { ok: false, ineligible: true, canForce: true, error: eligibility.reason };
    throw new Error(eligibility.reason);
  }

  // Doppioni: già disponibile attiva non scaduta / campagna single già maturata.
  const dupRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "gift_instances",
    columns: "id, state, is_active, expires_at",
    where: "gift_id = ? AND client_id = ?",
    params: [giftId, clientId],
  }).catch(() => [] as RowDataPacket[]);
  for (const d of dupRows) {
    const s = clean(d.state).toLowerCase();
    if (s === "disponibile" && Number(d.is_active ?? 0) === 1 && (!d.expires_at || toIsoDt(d.expires_at) >= nowIso)) {
      throw new Error("Omaggio già disponibile per questo cliente");
    }
  }
  if (Number(gift.repeatable ?? 0) !== 1 && dupRows.some((d) => ["disponibile", "riscattato", "scaduto"].includes(clean(d.state).toLowerCase()))) {
    throw new Error("Campagna già maturata per questo cliente");
  }

  // Scadenza: override giorni oppure expires_after_days del gift; fine giornata.
  const daysOverride = input.expiresDays !== undefined && input.expiresDays !== null && input.expiresDays > 0 ? Math.round(input.expiresDays) : 0;
  const days = daysOverride > 0 ? daysOverride : Math.max(0, Math.round(Number(gift.expires_after_days ?? 0) || 0));
  const expiresAt = days > 0 ? endOfDayAfterDays(now, days) : null;

  const progress = {
    state: "disponibile",
    ok: true,
    manual: true,
    manual_assignment: true,
    reason: "Assegnato manualmente",
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(input.forceIneligible ? { eligibility_override: true } : {}),
  };
  // Riusa un'istanza in accumulo se presente, altrimenti INSERT.
  const accumulo = dupRows.find((d) => clean(d.state).toLowerCase() === "accumulo" && Number(d.is_active ?? 0) === 1);
  let instanceId: number;
  const values = {
    state: "disponibile",
    is_active: 1,
    unlocked_at: now,
    expires_at: expiresAt,
    progress_json: JSON.stringify(progress),
    location_id: input.location?.id && input.location.id > 0 ? input.location.id : null,
    location_name: clean(input.location?.name) || null,
    updated_at: now,
  };
  if (accumulo) {
    instanceId = Number(accumulo.id);
    await tenantUpdate({ slug, table: "gift_instances", id: instanceId, values });
  } else {
    instanceId = await tenantInsert(await tenantTable(slug, "gift_instances"), {
      gift_id: giftId,
      client_id: clientId,
      ...values,
      created_at: now,
    });
  }
  return { ok: true, message: "Gift assegnato", instanceId };
}

// ---------------------------------------------------------------------------
// RISCATTO AL 'DONE' — redeemAppointmentSelectionIfAny (~11565-11696)
// ---------------------------------------------------------------------------

// Al passaggio a 'eseguito' riscatta la selezione omaggi IN SOSPESO della
// prenotazione: legge le righe appointment_gift_items con redeemed_at NULL,
// raggruppa per istanza (qty per reward_item_index) e chiama il riscatto con
// sourceType 'appointment' (transazioni 'redeem' con appointment_id, nota
// "Riscatto su prenotazione #N", chiusura istanza solo a residuo 0). Su
// successo marca redeemed_at sulle righe collegate. Best-effort per istanza:
// un'istanza non piu' riscattabile genera solo warning, mai un blocco del done.
export async function giftRedeemAppointmentSelectionIfAny(
  slug: string,
  appointmentId: number,
  by: number | null,
): Promise<{ redeemedInstances: number; warnings: string[] }> {
  const warnings: string[] = [];
  if (appointmentId <= 0) return { redeemedInstances: 0, warnings };
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "appointment_gift_items",
    where: "appointment_id = ? AND redeemed_at IS NULL",
    params: [appointmentId],
  }).catch(() => [] as RowDataPacket[]);
  if (!rows.length) return { redeemedInstances: 0, warnings };

  // Raggruppa per istanza: { reward_item_index: qty }.
  const byInstance = new Map<number, Record<number, number>>();
  for (const row of rows) {
    const instanceId = Number(row.instance_id ?? 0);
    const idx = Math.max(0, Number(row.reward_item_index ?? 0));
    const qty = Math.max(1, Number(row.qty ?? 1) || 1);
    if (instanceId <= 0) continue;
    const m = byInstance.get(instanceId) ?? {};
    m[idx] = (m[idx] ?? 0) + qty;
    byInstance.set(instanceId, m);
  }

  const now = new Date();
  let redeemedInstances = 0;
  const linkTable = await tenantTable(slug, "appointment_gift_items").catch(() => null);
  for (const [instanceId, qtyByItem] of byInstance) {
    try {
      await redeemGiftInstanceItems(slug, {
        instanceId,
        qtyByItem,
        by,
        sourceType: "appointment",
        sourceId: appointmentId,
      });
      redeemedInstances += 1;
      if (linkTable) {
        await dbQuery(
          `UPDATE ${quoteIdentifier(linkTable.name)} SET redeemed_at = ?, updated_at = ? WHERE tenant_id = ? AND appointment_id = ? AND instance_id = ? AND redeemed_at IS NULL`,
          [now, now, linkTable.tenantId ?? 0, appointmentId, instanceId],
        ).catch(() => []);
      }
    } catch (error) {
      warnings.push(`Omaggi: ${error instanceof Error ? error.message : "riscatto non riuscito"} (istanza #${instanceId}).`);
    }
  }
  return { redeemedInstances, warnings };
}

// ---------------------------------------------------------------------------
// VOUCHER PUBBLICO — gift_voucher.php + instanceDetailsByVoucherPublicToken
// ---------------------------------------------------------------------------

export async function getGiftVoucherByToken(slug: string, tokenRaw: string): Promise<{
  detail: GiftInstanceDetail;
  business: { name: string; phone: string; email: string; addrLine1: string; addrLine2: string; addrLine3: string };
} | null> {
  const token = clean(tokenRaw).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "gift_instances", columns: "id", where: "voucher_public_token = ?", params: [token], limit: 1 }).catch(() => [] as RowDataPacket[]);
  const id = Number(rows[0]?.id ?? 0);
  if (id <= 0) return null;
  const detail = await getGiftInstanceDetail(slug, id);
  if (!detail) return null;

  const bizRows = await tenantSelect<RowDataPacket>({
    slug,
    table: "businesses",
    columns: "name, address, phone, email, site_region, site_province, site_city, site_cap, site_address",
    orderBy: "id ASC",
    limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  const biz = bizRows[0] ?? null;
  const siteAddress = clean(biz?.site_address) || clean(biz?.address);
  const siteCap = clean(biz?.site_cap);
  const siteCity = clean(biz?.site_city);
  const siteProvince = clean(biz?.site_province);
  let cityLine = ((siteCap ? siteCap + " " : "") + siteCity).trim();
  if (siteProvince) cityLine = cityLine ? `${cityLine} (${siteProvince})` : `(${siteProvince})`;

  return {
    detail,
    business: {
      name: clean(biz?.name) || "BeautySuite",
      phone: clean(biz?.phone),
      email: clean(biz?.email),
      addrLine1: siteAddress,
      addrLine2: cityLine,
      addrLine3: clean(biz?.site_region),
    },
  };
}

// Statistiche campagna per il modale "Riepilogo" legacy (gifts.php card
// "Statistiche"): clienti coinvolti, istanze totali e per stato, ultime
// attivita' (sblocco/riscatto/annullamento/ultima attivita').
export type GiftCampaignSummaryStats = {
  clients: number;
  total: number;
  accumulo: number;
  disponibile: number;
  riscattato: number;
  scaduto: number;
  annullato: number;
  lastUnlock: string;
  lastRedeem: string;
  lastCancel: string;
  lastActivity: string;
};

export async function giftCampaignSummaryStats(slug: string, giftId: number): Promise<GiftCampaignSummaryStats> {
  const empty: GiftCampaignSummaryStats = { clients: 0, total: 0, accumulo: 0, disponibile: 0, riscattato: 0, scaduto: 0, annullato: 0, lastUnlock: "", lastRedeem: "", lastCancel: "", lastActivity: "" };
  if (giftId <= 0) return empty;
  try {
    const table = await tenantTable(slug, "gift_instances");
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT COUNT(*) total,
              COUNT(DISTINCT client_id) clients,
              COUNT(*) FILTER (WHERE LOWER(COALESCE(state,'')) = 'accumulo') accumulo,
              COUNT(*) FILTER (WHERE LOWER(COALESCE(state,'')) = 'disponibile') disponibile,
              COUNT(*) FILTER (WHERE LOWER(COALESCE(state,'')) = 'riscattato') riscattato,
              COUNT(*) FILTER (WHERE LOWER(COALESCE(state,'')) = 'scaduto') scaduto,
              COUNT(*) FILTER (WHERE LOWER(COALESCE(state,'')) = 'annullato') annullato,
              MAX(unlocked_at) last_unlock,
              MAX(redeemed_at) last_redeem,
              MAX(cancelled_at) last_cancel,
              GREATEST(COALESCE(MAX(created_at), '1970-01-01'), COALESCE(MAX(updated_at), '1970-01-01')) last_activity
         FROM ${quoteIdentifier(table.name)}
        WHERE tenant_id = ? AND gift_id = ?`,
      [table.tenantId ?? 0, giftId],
    );
    const r = rows[0] ?? {};
    const dt = (v: unknown): string => {
      const s = v ? String(v instanceof Date ? v.toISOString() : v) : "";
      return s && !s.startsWith("1970-") ? s.slice(0, 16).replace("T", " ") : "";
    };
    return {
      clients: Number(r.clients ?? 0),
      total: Number(r.total ?? 0),
      accumulo: Number(r.accumulo ?? 0),
      disponibile: Number(r.disponibile ?? 0),
      riscattato: Number(r.riscattato ?? 0),
      scaduto: Number(r.scaduto ?? 0),
      annullato: Number(r.annullato ?? 0),
      lastUnlock: dt(r.last_unlock),
      lastRedeem: dt(r.last_redeem),
      lastCancel: dt(r.last_cancel),
      lastActivity: dt(r.last_activity),
    };
  } catch {
    return empty;
  }
}
