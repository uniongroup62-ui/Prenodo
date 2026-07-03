import "server-only";

// ============================================================================
// DETTAGLI MANAGE GiftBox (giftbox.php tab=instances action=edit_instance) e
// GiftCard (giftcard.php action=edit) — port completo delle viste legacy:
//   - riepilogo (evento, sede emissione, riscatto X/Y, contenuto regalo)
//   - modale "Modifica scadenza" (update_instance_expiry / update_expiry)
//   - form "Dati GiftBox/GiftCard" (mittente, evento, nascondi importo,
//     destinatario + cliente, nota cliente, messaggio di dedica)
//   - "Invio email al destinatario" (send_email con show_details/show_amount)
//   - "Operazioni": riscatto PARZIALE per-item GiftBox / riscatto credito e
//     per-item GiftCard
//   - "Nota interna" (update_instance_internal_note / update_internal_note)
//   - "Movimenti" con colonne Sede e Operatore (virtuali per GiftBox:
//     giftbox_page_prepare_movement_display; ledger per GiftCard).
// Messaggi italiani VERBATIM dal sorgente legacy (GiftBox.php / GiftCard.php).
// ============================================================================

import { randomBytes } from "crypto";
import type { RowDataPacket } from "@/lib/tenant-db";
import { tenantInsert, tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";
import { buildModernEmailTemplate, emailConfigured, sendEmail } from "@/lib/email";

const clean = (v: unknown): string => String(v ?? "").trim();
const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const isoDate = (v: unknown): string => {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const isoDateTime = (v: unknown): string => {
  if (!v) return "";
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return s.includes("T") ? s : s.replace(" ", "T");
};
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// Eventi legacy (GiftCard::eventMap, riusata da GiftBox::eventTypeOptions).
export const GIFT_EVENT_OPTIONS: Array<{ key: string; label: string }> = [
  { key: "giftcard", label: "GiftCard (generica)" },
  { key: "compleanno", label: "Compleanno" },
  { key: "anniversario", label: "Anniversario" },
  { key: "capodanno", label: "Capodanno" },
  { key: "natale", label: "Natale" },
  { key: "epifania", label: "Epifania" },
  { key: "san_valentino", label: "San Valentino" },
  { key: "festa_donna", label: "Festa della Donna" },
  { key: "pasqua", label: "Pasqua" },
  { key: "pasquetta", label: "Pasquetta" },
  { key: "festa_mamma", label: "Festa della Mamma" },
  { key: "festa_papa", label: "Festa del Papà" },
];
export function giftEventLabel(key: string, fallback = "GiftBox (generica)"): string {
  const k = clean(key).toLowerCase();
  if (k === "" || k === "giftbox") return fallback;
  return GIFT_EVENT_OPTIONS.find((e) => e.key === k)?.label ?? fallback;
}

async function userLabel(slug: string, id: number): Promise<string> {
  if (!id || id <= 0) return "";
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "users", columns: "name, email", where: "id = ?", params: [id], limit: 1 }).catch(() => [] as RowDataPacket[]);
  if (!rows[0]) return `#${id}`;
  return clean(rows[0].name) || clean(rows[0].email) || `#${id}`;
}

// Token voucher pubblico: backfill lazy quando manca (le istanze emesse da
// vecchi flussi possono non averlo — il bottone Voucher deve sempre funzionare).
async function ensureVoucherToken(slug: string, table: "giftcards" | "giftbox_instances", id: number, current: string): Promise<string> {
  const token = clean(current);
  if (/^[0-9a-fA-F]{64}$/.test(token)) return token;
  const fresh = randomBytes(32).toString("hex");
  await tenantUpdate({ slug, table, id, values: { voucher_public_token: fresh } }).catch(() => 0);
  return fresh;
}

async function clientRow(slug: string, id: number): Promise<{ name: string; email: string; phone: string } | null> {
  if (id <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "full_name, email, phone", where: "id = ?", params: [id], limit: 1 }).catch(() => [] as RowDataPacket[]);
  if (!rows[0]) return null;
  return { name: clean(rows[0].full_name), email: clean(rows[0].email), phone: clean(rows[0].phone) };
}

export type GiftIssueMovement = {
  at: string;
  type: string;
  qty: number | null;
  amount: number | null;
  itemLabel: string;
  locationName: string;
  note: string;
  operatorName: string;
};

// ============================================================================
// GIFTBOX — dettaglio istanza completo
// ============================================================================

export type GiftBoxDetailItem = {
  rowId: number;
  giftboxItemId: number;
  itemType: string;
  name: string;
  qty: number;
  redeemedUnits: number;
  pendingUnits: number;
  availableUnits: number;
  pendingAppointments: string[];
};

export type GiftBoxInstanceFull = {
  id: number;
  code: string;
  publicToken: string;
  giftboxName: string;
  status: string;
  statusLabel: string;
  statusBadge: string;
  eventType: string;
  eventLabel: string;
  senderClientId: number;
  senderName: string;
  recipientClientId: number;
  recipientName: string;
  recipientEmail: string;
  recipientClient: { id: number; name: string; email: string; phone: string } | null;
  locationName: string;
  voucherHideAmount: boolean;
  note: string;
  giftMessage: string;
  internalNote: string;
  pointsCost: number;
  issuedAt: string;
  validFrom: string;
  expiresAt: string;
  redeemedAt: string;
  cancelledAt: string;
  scheduledSendOn: string;
  lastEmailSentAt: string;
  lastEmailSentTo: string;
  lastEmailShowDetails: boolean;
  linkedSaleId: number | null;
  items: GiftBoxDetailItem[];
  totalUnits: number;
  redeemedUnits: number;
  pendingUnits: number;
  availableUnits: number;
  partial: boolean;
  movements: GiftIssueMovement[];
  canEdit: boolean;
  canRedeem: boolean;
  canCancel: boolean;
  expiryEditable: boolean;
  expiryLockedReason: string;
};

const GB_STATUS_META: Record<string, { label: string; badge: string }> = {
  issued: { label: "Attiva", badge: "bg-success" },
  redeemed: { label: "Riscattata", badge: "bg-info" },
  expired: { label: "Scaduta", badge: "bg-warning" },
  cancelled: { label: "Annullata", badge: "bg-danger" },
};

async function giftBoxInstanceRow(slug: string, id: number): Promise<RowDataPacket | null> {
  if (id <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftbox_instances", where: "id = ?", params: [id], limit: 1 });
  return rows[0] ?? null;
}

function gbEffectiveStatus(raw: string, expiresAt: string): string {
  let st = clean(raw).toLowerCase();
  if (st === "canceled") st = "cancelled";
  if (st === "active") st = "issued";
  if (st === "issued" && expiresAt !== "" && expiresAt < todayIso()) st = "expired";
  return st;
}

export async function getGiftBoxInstanceFull(slug: string, id: number): Promise<GiftBoxInstanceFull | null> {
  const inst = await giftBoxInstanceRow(slug, id);
  if (!inst) return null;

  const giftboxId = Number(inst.giftbox_id ?? 0);
  let giftboxName = "";
  if (giftboxId > 0) {
    const gb = await tenantSelect<RowDataPacket>({ slug, table: "giftboxes", columns: "name", where: "id = ?", params: [giftboxId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    giftboxName = clean(gb[0]?.name);
  }

  // Contenuti + contatori per-item: riscattato = giftbox_redemption_items.qty
  // (per giftbox_item_id) + appointment_giftbox_items GIÀ riscattati senza
  // redemption collegata; in sospeso = appointment_giftbox_items pendenti.
  const itemRows = await tenantSelect<RowDataPacket>({ slug, table: "giftbox_instance_items", where: "instance_id = ?", params: [id], orderBy: "sort_order ASC, id ASC" }).catch(() => [] as RowDataPacket[]);

  const redemptionRows = await tenantSelect<RowDataPacket>({ slug, table: "giftbox_redemptions", where: "instance_id = ?", params: [id], orderBy: "redeemed_at ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  const redemptionIds = redemptionRows.map((r) => Number(r.id ?? 0)).filter((n) => n > 0);
  const redItemRows = redemptionIds.length
    ? await tenantSelect<RowDataPacket>({ slug, table: "giftbox_redemption_items", where: `redemption_id IN (${redemptionIds.map(() => "?").join(",")})`, params: redemptionIds }).catch(() => [] as RowDataPacket[])
    : [];
  const redeemedByGiftboxItem = new Map<number, number>();
  const redItemsByRedemption = new Map<number, Array<{ giftboxItemId: number; qty: number }>>();
  for (const r of redItemRows) {
    const gid = Number(r.giftbox_item_id ?? 0);
    const qty = Math.max(1, Number(r.qty ?? 1));
    redeemedByGiftboxItem.set(gid, (redeemedByGiftboxItem.get(gid) ?? 0) + qty);
    const rid = Number(r.redemption_id ?? 0);
    const arr = redItemsByRedemption.get(rid) ?? [];
    arr.push({ giftboxItemId: gid, qty });
    redItemsByRedemption.set(rid, arr);
  }

  const apptRows = await tenantSelect<RowDataPacket>({ slug, table: "appointment_giftbox_items", where: "instance_id = ?", params: [id] }).catch(() => [] as RowDataPacket[]);
  const pendingByGiftboxItem = new Map<number, number>();
  const pendingApptsByItem = new Map<number, string[]>();
  for (const r of apptRows) {
    const gid = Number(r.giftbox_item_id ?? 0);
    const qty = Math.max(1, Number(r.qty ?? 1));
    if (r.redeemed_at) {
      // Riscattato via prenotazione: conta SOLO se non ha già una redemption
      // collegata (redemption_id), altrimenti sarebbe doppio conteggio.
      if (!r.redemption_id) redeemedByGiftboxItem.set(gid, (redeemedByGiftboxItem.get(gid) ?? 0) + qty);
    } else {
      pendingByGiftboxItem.set(gid, (pendingByGiftboxItem.get(gid) ?? 0) + qty);
      const appts = pendingApptsByItem.get(gid) ?? [];
      appts.push(`#${Number(r.appointment_id ?? 0)}`);
      pendingApptsByItem.set(gid, appts);
    }
  }

  const items: GiftBoxDetailItem[] = [];
  let totalUnits = 0;
  for (const r of itemRows) {
    const rowId = Number(r.id ?? 0);
    const giftboxItemId = Number(r.giftbox_item_id ?? 0);
    const itemType = clean(r.item_type) || "service";
    const qty = Math.max(1, Number(r.qty ?? 1));
    totalUnits += qty;
    let name = clean(r.custom_label);
    if (name === "") {
      try {
        const snap = JSON.parse(String(r.service_snapshot_json ?? "null")) as { name?: unknown } | null;
        name = clean(snap?.name);
      } catch { /* snapshot assente */ }
    }
    if (name === "") {
      if (itemType === "product") {
        const pr = await tenantSelect<RowDataPacket>({ slug, table: "products", columns: "name", where: "id = ?", params: [Number(r.product_id ?? 0)], limit: 1 }).catch(() => [] as RowDataPacket[]);
        name = clean(pr[0]?.name) || `Prodotto #${r.product_id}`;
      } else {
        const sv = await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "name", where: "id = ?", params: [Number(r.service_id ?? 0)], limit: 1 }).catch(() => [] as RowDataPacket[]);
        name = clean(sv[0]?.name) || `Servizio #${r.service_id}`;
      }
    }
    const redeemedUnits = Math.min(qty, redeemedByGiftboxItem.get(giftboxItemId) ?? 0);
    const pendingUnits = Math.min(qty - redeemedUnits, pendingByGiftboxItem.get(giftboxItemId) ?? 0);
    items.push({
      rowId,
      giftboxItemId,
      itemType,
      name,
      qty,
      redeemedUnits,
      pendingUnits,
      availableUnits: Math.max(0, qty - redeemedUnits - pendingUnits),
      pendingAppointments: pendingApptsByItem.get(giftboxItemId) ?? [],
    });
  }

  const expiresAt = isoDate(inst.expires_at);
  const rawStatus = clean(inst.status).toLowerCase();
  const isCancelled = rawStatus === "cancelled" || rawStatus === "canceled";
  const isRedeemed = rawStatus === "redeemed";
  let redeemedUnits = items.reduce((s, it) => s + it.redeemedUnits, 0);
  if (isRedeemed) redeemedUnits = totalUnits;
  const pendingUnits = items.reduce((s, it) => s + it.pendingUnits, 0);
  const availableUnits = isCancelled || isRedeemed ? 0 : Math.max(0, totalUnits - redeemedUnits - pendingUnits);
  const status = isCancelled ? "cancelled" : isRedeemed ? "redeemed" : gbEffectiveStatus("issued", expiresAt);
  const meta = GB_STATUS_META[status] ?? { label: status, badge: "bg-secondary" };

  const senderClientId = Number(inst.client_id ?? 0) || 0;
  const sender = await clientRow(slug, senderClientId);
  const recipientClientId = Number(inst.recipient_client_id ?? 0) || 0;
  const recipientClient = recipientClientId > 0 ? await clientRow(slug, recipientClientId) : null;

  let linkedSaleId: number | null = null;
  const noteMatch = clean(inst.note).match(/Vendita\s+#(\d+)/i);
  if (noteMatch) linkedSaleId = Number(noteMatch[1]) || null;

  // MOVIMENTI virtuali (giftbox_page_prepare_movement_display): emissione,
  // riscatti (manuali/prenotazione), in sospeso, annullamento, scadenza.
  const movements: GiftIssueMovement[] = [];
  if (inst.issued_at) {
    movements.push({
      at: isoDateTime(inst.issued_at),
      type: "issue",
      qty: totalUnits,
      amount: null,
      itemLabel: "—",
      locationName: clean(inst.location_name),
      note: "Emissione GiftBox",
      operatorName: await userLabel(slug, Number(inst.created_by ?? 0)),
    });
  }
  const itemNameByGiftboxItem = new Map<number, string>();
  for (const it of items) itemNameByGiftboxItem.set(it.giftboxItemId, it.name);
  for (const r of redemptionRows) {
    const rid = Number(r.id ?? 0);
    const redItems = redItemsByRedemption.get(rid) ?? [];
    const qty = redItems.length ? redItems.reduce((s, x) => s + x.qty, 0) : 1;
    const label = redItems.length ? redItems.map((x) => itemNameByGiftboxItem.get(x.giftboxItemId) ?? `Item #${x.giftboxItemId}`).join(", ") : "—";
    const srcType = clean(r.source_type).toLowerCase();
    const srcId = Number(r.source_id ?? 0);
    movements.push({
      at: isoDateTime(r.redeemed_at ?? r.created_at),
      type: "redeem",
      qty,
      amount: null,
      itemLabel: label,
      locationName: clean(r.location_name),
      note: clean(r.note) || (srcType === "appointment" && srcId > 0 ? `Riscatto su prenotazione #${srcId}` : "Riscatto GiftBox"),
      operatorName: await userLabel(slug, Number(r.redeemed_by ?? 0)),
    });
  }
  for (const r of apptRows) {
    if (r.redeemed_at) continue;
    const gid = Number(r.giftbox_item_id ?? 0);
    movements.push({
      at: isoDateTime(r.created_at),
      type: "pending",
      qty: Math.max(1, Number(r.qty ?? 1)),
      amount: null,
      itemLabel: itemNameByGiftboxItem.get(gid) ?? "—",
      locationName: "",
      note: `In sospeso su prenotazione #${Number(r.appointment_id ?? 0)}`,
      operatorName: "",
    });
  }
  if (inst.cancelled_at) {
    movements.push({
      at: isoDateTime(inst.cancelled_at),
      type: "cancel",
      qty: null,
      amount: null,
      itemLabel: "—",
      locationName: "",
      note: "Annullamento GiftBox",
      operatorName: await userLabel(slug, Number(inst.cancelled_by ?? 0)),
    });
  }
  if (status === "expired" && expiresAt !== "") {
    movements.push({ at: `${expiresAt}T00:00:00`, type: "expire", qty: null, amount: null, itemLabel: "—", locationName: "", note: "Scadenza GiftBox", operatorName: "" });
  }
  movements.sort((a, b) => (a.at < b.at ? 1 : -1));

  // Editabilità scadenza (legacy $eiExpiryEditLocked): non annullata e non riscattata.
  let expiryLockedReason = "";
  if (isCancelled) expiryLockedReason = "Non è possibile modificare la scadenza di una GiftBox annullata.";
  else if (isRedeemed) expiryLockedReason = "Non e possibile modificare la scadenza di una GiftBox riscattata.";

  const publicToken = await ensureVoucherToken(slug, "giftbox_instances", id, String(inst.voucher_public_token ?? ""));

  return {
    id,
    code: clean(inst.code),
    publicToken,
    giftboxName,
    status,
    statusLabel: meta.label,
    statusBadge: meta.badge,
    eventType: clean(inst.event_type) || "giftcard",
    eventLabel: giftEventLabel(String(inst.event_type ?? ""), "GiftBox (generica)"),
    senderClientId,
    senderName: sender?.name ?? (senderClientId > 0 ? `Cliente #${senderClientId}` : "—"),
    recipientClientId,
    recipientName: clean(inst.recipient_name),
    recipientEmail: clean(inst.recipient_email),
    recipientClient: recipientClient ? { id: recipientClientId, ...recipientClient } : null,
    locationName: clean(inst.location_name),
    voucherHideAmount: Number(inst.voucher_hide_amount ?? 0) === 1,
    note: clean(inst.note),
    giftMessage: clean(inst.gift_message),
    internalNote: clean(inst.internal_note),
    pointsCost: Number(inst.points_cost ?? 0) || 0,
    issuedAt: isoDateTime(inst.issued_at),
    validFrom: isoDate(inst.issued_at),
    expiresAt,
    redeemedAt: isoDateTime(inst.redeemed_at),
    cancelledAt: isoDateTime(inst.cancelled_at),
    scheduledSendOn: isoDate(inst.scheduled_send_on),
    lastEmailSentAt: isoDateTime(inst.last_email_sent_at),
    lastEmailSentTo: clean(inst.last_email_sent_to),
    lastEmailShowDetails: Number(inst.last_email_hide_details ?? 0) !== 1,
    linkedSaleId,
    items,
    totalUnits,
    redeemedUnits,
    pendingUnits,
    availableUnits,
    partial: redeemedUnits > 0 && redeemedUnits < totalUnits,
    movements,
    canEdit: !isCancelled,
    canRedeem: status === "issued" && availableUnits > 0,
    canCancel: status === "issued",
    expiryEditable: expiryLockedReason === "",
    expiryLockedReason,
  };
}

// Aggiorna i "Dati GiftBox" (giftbox.php _mode=update_instance): mittente,
// evento, nascondi importo, destinatario (+cliente), nota, messaggio di dedica.
export async function updateGiftBoxInstanceData(
  slug: string,
  id: number,
  input: {
    senderClientId: number;
    eventType?: string;
    voucherHideAmount?: boolean;
    recipientClientId?: number;
    recipientName?: string;
    recipientEmail?: string;
    note?: string;
    giftMessage?: string;
  },
): Promise<{ ok: true; message: string }> {
  const inst = await giftBoxInstanceRow(slug, id);
  if (!inst) throw new Error("Istanza non trovata");
  const st = clean(inst.status).toLowerCase();
  if (st === "cancelled" || st === "canceled") throw new Error("GiftBox annullata: non modificabile.");

  const senderClientId = Math.max(0, Math.trunc(Number(input.senderClientId ?? 0)));
  if (senderClientId <= 0) throw new Error("Seleziona un cliente");
  const sender = await clientRow(slug, senderClientId);
  if (!sender) throw new Error("Mittente selezionato non valido.");

  let recipientName = clean(input.recipientName);
  let recipientEmail = clean(input.recipientEmail);
  const recipientClientId = Math.max(0, Math.trunc(Number(input.recipientClientId ?? 0)));
  if (recipientClientId > 0) {
    const c = await clientRow(slug, recipientClientId);
    if (!c) throw new Error("Cliente destinatario non trovato.");
    if (c.name !== "") recipientName = c.name;
    if (c.email !== "" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) recipientEmail = c.email;
  }

  const eventKey = clean(input.eventType).toLowerCase();
  const values = {
    client_id: senderClientId,
    event_type: GIFT_EVENT_OPTIONS.some((e) => e.key === eventKey) ? eventKey : clean(inst.event_type) || "giftcard",
    voucher_hide_amount: input.voucherHideAmount ? 1 : 0,
    recipient_client_id: recipientClientId > 0 ? recipientClientId : null,
    recipient_name: recipientName !== "" ? recipientName : null,
    recipient_email: recipientEmail !== "" ? recipientEmail : null,
    note: input.note !== undefined ? (clean(input.note) || null) : undefined,
    gift_message: input.giftMessage !== undefined ? (clean(input.giftMessage) || null) : undefined,
    updated_at: new Date(),
  };
  await tenantUpdate({ slug, table: "giftbox_instances", id, values: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) });
  return { ok: true, message: "Istanza aggiornata" };
}

// Modale "Modifica scadenza GiftBox" (giftbox.php _mode=update_instance_expiry).
export async function updateGiftBoxInstanceExpiry(slug: string, id: number, expiresAtRaw: string): Promise<{ ok: true; message: string }> {
  const inst = await giftBoxInstanceRow(slug, id);
  if (!inst) throw new Error("Istanza non trovata");
  const st = clean(inst.status).toLowerCase();
  if (st === "cancelled" || st === "canceled") throw new Error("Non è possibile modificare la scadenza di una GiftBox annullata.");
  if (st === "redeemed") throw new Error("Non e possibile modificare la scadenza di una GiftBox riscattata.");

  const next = clean(expiresAtRaw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || Number.isNaN(Date.parse(next))) throw new Error("Seleziona una nuova data di scadenza valida.");
  if (next < todayIso()) throw new Error("La nuova data di scadenza non può essere precedente a oggi.");
  const validFrom = isoDate(inst.issued_at);
  if (validFrom !== "" && next < validFrom) throw new Error("La nuova data di scadenza non può essere precedente all'inizio validità della GiftBox.");

  // Riattivazione automatica: una GiftBox scaduta torna 'issued' con data futura.
  const values: Record<string, unknown> = { expires_at: `${next} 23:59:59`, updated_at: new Date() };
  if (st === "expired") values.status = "issued";
  await tenantUpdate({ slug, table: "giftbox_instances", id, values });
  return { ok: true, message: "Scadenza GiftBox aggiornata" };
}

// Riscatto PARZIALE per-item (giftbox.php _mode=redeem_instance_partial):
// qtyByRowId = { <giftbox_instance_items.id>: qty }. Registra una
// giftbox_redemptions + giftbox_redemption_items e marca 'redeemed' quando
// tutti gli elementi risultano utilizzati.
export async function redeemGiftBoxInstancePartial(
  slug: string,
  id: number,
  qtyByRowId: Record<number, number>,
  note: string,
  by: number,
  location: { id: number; name: string } | null,
): Promise<{ ok: true; message: string }> {
  const detail = await getGiftBoxInstanceFull(slug, id);
  if (!detail) throw new Error("Istanza non valida.");
  if (detail.status === "cancelled") throw new Error("GiftBox annullata: non riscattabile.");
  if (detail.status === "redeemed") throw new Error("GiftBox già riscattata.");
  if (detail.status === "expired") throw new Error("GiftBox scaduta");

  const picks: Array<{ giftboxItemId: number; qty: number; label: string }> = [];
  for (const it of detail.items) {
    const req = Math.max(0, Math.trunc(Number(qtyByRowId[it.rowId] ?? 0)));
    if (req <= 0) continue;
    if (req > it.availableUnits) throw new Error(`Quantità non disponibile per "${it.name}".${it.pendingUnits > 0 ? ` ${it.pendingUnits} già in sospeso su prenotazioni.` : ""}`);
    picks.push({ giftboxItemId: it.giftboxItemId, qty: req, label: it.name });
  }
  if (picks.length === 0) throw new Error("Seleziona almeno un elemento da riscattare.");

  const now = new Date();
  const redemptionId = await tenantInsert(await tenantTable(slug, "giftbox_redemptions"), {
    instance_id: id,
    redeemed_at: now,
    redeemed_by: by > 0 ? by : null,
    source_type: "manual",
    source_id: null,
    note: clean(note) || null,
    location_id: location && location.id > 0 ? location.id : null,
    location_name: location ? clean(location.name) || null : null,
  });
  const itemTable = await tenantTable(slug, "giftbox_redemption_items");
  for (const p of picks) await tenantInsert(itemTable, { redemption_id: redemptionId, giftbox_item_id: p.giftboxItemId, qty: p.qty }).catch(() => 0);

  const redeemedNow = picks.reduce((s, p) => s + p.qty, 0);
  const fully = detail.redeemedUnits + redeemedNow >= detail.totalUnits;
  if (fully) {
    await tenantUpdate({ slug, table: "giftbox_instances", id, values: { status: "redeemed", redeemed_at: now, redeemed_by: by > 0 ? by : null, redeemed_source_type: "manual", updated_at: now } });
  } else {
    await tenantUpdate({ slug, table: "giftbox_instances", id, values: { updated_at: now } }).catch(() => 0);
  }
  return { ok: true, message: fully ? "GiftBox riscattata completamente" : "Riscatto registrato (parziale)" };
}

export async function updateGiftBoxInstanceInternalNote(slug: string, id: number, noteRaw: string): Promise<{ ok: true; message: string }> {
  const inst = await giftBoxInstanceRow(slug, id);
  if (!inst) throw new Error("Istanza non trovata");
  await tenantUpdate({ slug, table: "giftbox_instances", id, values: { internal_note: clean(noteRaw) || null, updated_at: new Date() } });
  return { ok: true, message: "Nota interna salvata" };
}

// "Invio email al destinatario" (giftbox.php _mode=send_email). showDetails
// replica il checkbox "Mostra contenuto nella mail".
export async function sendGiftBoxInstanceEmail(slug: string, id: number, toRaw: string, showDetails: boolean, giftMessageRaw: string): Promise<{ ok: true; message: string }> {
  const detail = await getGiftBoxInstanceFull(slug, id);
  if (!detail) throw new Error("Istanza non trovata");
  if (detail.status === "cancelled") throw new Error("Non è possibile inviare una GiftBox annullata.");
  if (detail.status === "expired") throw new Error("Non e possibile inviare una GiftBox scaduta.");
  const to = clean(toRaw);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error("Email destinatario non valida.");
  if (!emailConfigured()) throw new Error("Invio email non disponibile");

  const bizRows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "name, email, giftbox_terms", orderBy: "id ASC", limit: 1 }).catch(() => [] as RowDataPacket[]);
  const biz = bizRows[0] ?? null;
  const bizName = clean(biz?.name) || "BeautySuite";
  const terms = clean(biz?.giftbox_terms);

  const base = String(process.env.PRENODO_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  const voucherUrl = base !== "" ? `${base}/${slug}/giftbox_voucher?public=1&embed=1&token=${encodeURIComponent(detail.publicToken)}` : "";
  const h = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fmtIt = (iso: string) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
  const giftMessage = clean(giftMessageRaw) || detail.giftMessage;

  let html = `<div style="background:#0f766e;color:#ffffff;padding:16px 20px;border-radius:12px 12px 0 0;font-size:18px;font-weight:700">La tua GiftBox</div>`;
  html += `<div style="border:1px solid #e5e7eb;border-top:0;padding:20px;border-radius:0 0 12px 12px">`;
  html += `<p style="margin:0 0 6px">Ciao ${h(detail.recipientName || "")},</p>`;
  html += `<p style="margin:0 0 14px">hai ricevuto una <strong>GiftBox</strong> da ${h(detail.senderName)}!</p>`;
  if (giftMessage) html += `<p style="margin:0 0 14px;font-style:italic;white-space:pre-line">&ldquo;${h(giftMessage)}&rdquo;</p>`;
  html += `<div style="text-align:center;margin:14px 0"><div style="display:inline-block;background:#f0fdfa;border:2px dashed #0f766e;border-radius:12px;padding:14px 26px;font-size:24px;font-weight:800;letter-spacing:2px">${h(detail.code)}</div><div style="font-size:12px;color:#6b7280;margin-top:6px">MOSTRA QUESTO CODICE IN CASSA</div></div>`;
  if (voucherUrl) html += `<div style="text-align:center;margin:14px 0"><a href="${h(voucherUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:600;letter-spacing:.2px">Vedi Voucher</a></div>`;
  html += `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:10px 0">`;
  const row = (k: string, v: string) => `<tr><td style="padding:6px 0;color:#6b7280">${h(k)}</td><td style="padding:6px 0;text-align:right;font-weight:600">${h(v)}</td></tr>`;
  html += row("Evento", detail.eventLabel);
  html += row("Emessa il", fmtIt(detail.issuedAt.slice(0, 10)));
  html += row("Scadenza", detail.expiresAt ? fmtIt(detail.expiresAt) : "Nessuna scadenza");
  html += `</table>`;
  if (showDetails && detail.items.length) {
    html += `<p style="margin:12px 0 4px;font-weight:700">Contenuto GiftBox</p><ul style="margin:0 0 10px;padding-left:18px">`;
    for (const it of detail.items) html += `<li>${h(it.name)}${it.qty > 1 ? ` × ${it.qty}` : ""}</li>`;
    html += `</ul>`;
  }
  if (terms) html += `<p style="margin:12px 0 4px;font-weight:700">Condizioni</p><p style="margin:0;color:#6b7280;font-size:12px;white-space:pre-line">${h(terms)}</p>`;
  html += `</div>`;

  const subject = `Hai ricevuto una GiftBox - ${bizName}`;
  const tpl = buildModernEmailTemplate(subject, html, { business_name: bizName, business_email: clean(biz?.email) });
  const result = await sendEmail({ to, subject, html: tpl.html, text: tpl.text, fromName: bizName, replyTo: clean(biz?.email) || undefined });
  if (!result.ok) throw new Error(result.error || "Invio email non riuscito");

  await tenantUpdate({ slug, table: "giftbox_instances", id, values: { last_email_sent_at: new Date(), last_email_sent_to: to, last_email_hide_details: showDetails ? 0 : 1, updated_at: new Date() } }).catch(() => 0);
  return { ok: true, message: `Email inviata a ${to}` };
}

// ============================================================================
// GIFTCARD — dettaglio card completo
// ============================================================================

export type GiftCardDetailItem = { rowId: number; itemType: string; name: string; qty: number; redeemedQty: number; remainingQty: number };

export type GiftCardFull = {
  id: number;
  code: string;
  publicToken: string;
  status: string;
  statusLabel: string;
  statusBadge: string;
  eventType: string;
  eventLabel: string;
  senderClientId: number;
  senderName: string;
  recipientClientId: number;
  recipientName: string;
  recipientEmail: string;
  recipientClient: { id: number; name: string; email: string; phone: string } | null;
  locationName: string;
  voucherHideAmount: boolean;
  initialAmount: number;
  balance: number;
  note: string;
  giftMessage: string;
  internalNote: string;
  issuedAt: string;
  expiresAt: string;
  redeemedAt: string;
  cancelledAt: string;
  scheduledSendOn: string;
  lastEmailSentAt: string;
  lastEmailSentTo: string;
  lastEmailShowAmount: boolean;
  linkedSaleId: number | null;
  items: GiftCardDetailItem[];
  hasMoney: boolean;
  movements: GiftIssueMovement[];
  canEdit: boolean;
  canRedeem: boolean;
  expiryEditable: boolean;
  expiryLockedReason: string;
};

const GC_STATUS_META: Record<string, { label: string; badge: string }> = {
  active: { label: "Attiva", badge: "bg-success" },
  redeemed: { label: "Riscattata", badge: "bg-info" },
  expired: { label: "Scaduta", badge: "bg-warning" },
  cancelled: { label: "Annullata", badge: "bg-danger" },
};

async function giftCardRow(slug: string, id: number): Promise<RowDataPacket | null> {
  if (id <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftcards", where: "id = ?", params: [id], limit: 1 });
  return rows[0] ?? null;
}

function gcEffectiveStatus(raw: string, expiresAt: string): string {
  let st = clean(raw).toLowerCase();
  if (st === "canceled") st = "cancelled";
  if (st === "active" && expiresAt !== "" && expiresAt < todayIso()) st = "expired";
  return st;
}

export async function getGiftCardFull(slug: string, id: number): Promise<GiftCardFull | null> {
  const card = await giftCardRow(slug, id);
  if (!card) return null;

  const expiresAt = isoDate(card.expires_at);
  const status = gcEffectiveStatus(String(card.status ?? "active"), expiresAt);
  const meta = GC_STATUS_META[status] ?? { label: status, badge: "bg-secondary" };

  const senderClientId = Number(card.client_id ?? 0) || 0;
  const sender = await clientRow(slug, senderClientId);
  const recipientClientId = Number(card.recipient_client_id ?? 0) || 0;
  const recipientClient = recipientClientId > 0 ? await clientRow(slug, recipientClientId) : null;

  // Voucher per servizi/prodotti (giftcard_items) — spesso assenti (card monetarie).
  const itemRows = await tenantSelect<RowDataPacket>({ slug, table: "giftcard_items", where: "giftcard_id = ?", params: [id], orderBy: "id ASC" }).catch(() => [] as RowDataPacket[]);
  const items: GiftCardDetailItem[] = itemRows.map((r) => {
    const qty = Math.max(1, Number(r.qty ?? 1));
    const redeemed = Math.max(0, Math.min(qty, Number(r.redeemed_qty ?? 0)));
    return {
      rowId: Number(r.id ?? 0),
      itemType: clean(r.item_type) || "service",
      name: clean(r.item_name) || `Item #${r.id}`,
      qty,
      redeemedQty: redeemed,
      remainingQty: Math.max(0, qty - redeemed),
    };
  });

  const txRows = await tenantSelect<RowDataPacket>({ slug, table: "giftcard_transactions", where: "giftcard_id = ?", params: [id], orderBy: "created_at DESC, id DESC", limit: 200 }).catch(() => [] as RowDataPacket[]);
  const movements: GiftIssueMovement[] = [];
  for (const r of txRows) {
    movements.push({
      at: isoDateTime(r.created_at),
      type: clean(r.type) || "adjust",
      qty: null,
      amount: round2(Number(r.amount ?? 0)),
      itemLabel: "—",
      locationName: clean(r.location_name),
      note: clean(r.note),
      operatorName: await userLabel(slug, Number(r.created_by ?? 0)),
    });
  }

  let linkedSaleId: number | null = null;
  const noteMatch = clean(card.note).match(/Vendita\s+#(\d+)/i);
  if (noteMatch) linkedSaleId = Number(noteMatch[1]) || null;

  let expiryLockedReason = "";
  if (status === "cancelled") expiryLockedReason = "Scadenza non modificabile perche la GiftCard e annullata.";
  else if (status === "redeemed") expiryLockedReason = "Scadenza non modificabile perche la GiftCard risulta gia riscattata.";

  const publicToken = await ensureVoucherToken(slug, "giftcards", id, String(card.voucher_public_token ?? ""));
  const balance = round2(Number(card.balance ?? 0));

  return {
    id,
    code: clean(card.code),
    publicToken,
    status,
    statusLabel: meta.label,
    statusBadge: meta.badge,
    eventType: clean(card.event_type) || "giftcard",
    eventLabel: giftEventLabel(String(card.event_type ?? ""), "GiftCard (generica)"),
    senderClientId,
    senderName: sender?.name ?? (senderClientId > 0 ? `Cliente #${senderClientId}` : "—"),
    recipientClientId,
    recipientName: clean(card.recipient_name),
    recipientEmail: clean(card.recipient_email),
    recipientClient: recipientClient ? { id: recipientClientId, ...recipientClient } : null,
    locationName: clean(card.location_name),
    voucherHideAmount: Number(card.voucher_hide_amount ?? 0) === 1,
    initialAmount: round2(Number(card.initial_amount ?? 0)),
    balance,
    note: clean(card.note),
    giftMessage: clean(card.gift_message),
    internalNote: clean(card.internal_note),
    issuedAt: isoDateTime(card.issued_at),
    expiresAt,
    redeemedAt: isoDateTime(card.redeemed_at),
    cancelledAt: isoDateTime(card.cancelled_at),
    scheduledSendOn: isoDate(card.scheduled_send_on),
    lastEmailSentAt: isoDateTime(card.last_email_sent_at),
    lastEmailSentTo: clean(card.last_email_sent_to),
    lastEmailShowAmount: Number(card.last_email_hide_amount ?? 0) !== 1,
    linkedSaleId,
    items,
    hasMoney: round2(Number(card.initial_amount ?? 0)) > 0,
    movements,
    canEdit: status !== "cancelled",
    canRedeem: status === "active" && balance > 0,
    expiryEditable: expiryLockedReason === "",
    expiryLockedReason,
  };
}

// "Dati GiftCard" (giftcard.php _mode=update): mittente obbligatorio, evento,
// nascondi importo, destinatario (+cliente), nota cliente, messaggio di dedica.
export async function updateGiftCardData(
  slug: string,
  id: number,
  input: {
    senderClientId: number;
    eventType?: string;
    voucherHideAmount?: boolean;
    recipientClientId?: number;
    recipientName?: string;
    recipientEmail?: string;
    note?: string;
    giftMessage?: string;
  },
): Promise<{ ok: true; message: string }> {
  const card = await giftCardRow(slug, id);
  if (!card) throw new Error("GiftCard non trovata.");
  const st = clean(card.status).toLowerCase();
  if (st === "cancelled" || st === "canceled") throw new Error("Non è possibile modificare una GiftCard annullata.");

  const senderClientId = Math.max(0, Math.trunc(Number(input.senderClientId ?? 0)));
  if (senderClientId <= 0) throw new Error("Seleziona un mittente.");
  const sender = await clientRow(slug, senderClientId);
  if (!sender) throw new Error("Mittente selezionato non valido.");

  let recipientName = clean(input.recipientName);
  let recipientEmail = clean(input.recipientEmail);
  const recipientClientId = Math.max(0, Math.trunc(Number(input.recipientClientId ?? 0)));
  if (recipientClientId > 0) {
    const c = await clientRow(slug, recipientClientId);
    if (!c) throw new Error("Cliente destinatario non trovato.");
    if (c.name !== "") recipientName = c.name;
    if (c.email !== "" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) recipientEmail = c.email;
  }

  const eventKey = clean(input.eventType).toLowerCase();
  const values = {
    client_id: senderClientId,
    event_type: GIFT_EVENT_OPTIONS.some((e) => e.key === eventKey) ? eventKey : clean(card.event_type) || "giftcard",
    voucher_hide_amount: input.voucherHideAmount ? 1 : 0,
    recipient_client_id: recipientClientId > 0 ? recipientClientId : null,
    recipient_name: recipientName !== "" ? recipientName : null,
    recipient_email: recipientEmail !== "" ? recipientEmail : null,
    note: input.note !== undefined ? (clean(input.note) || null) : undefined,
    gift_message: input.giftMessage !== undefined ? (clean(input.giftMessage) || null) : undefined,
    updated_at: new Date(),
  };
  await tenantUpdate({ slug, table: "giftcards", id, values: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) });
  return { ok: true, message: "GiftCard aggiornata" };
}

// Modale "Modifica scadenza GiftCard" (giftcard.php _mode=update_expiry).
export async function updateGiftCardExpiry(slug: string, id: number, expiresAtRaw: string): Promise<{ ok: true; message: string }> {
  const card = await giftCardRow(slug, id);
  if (!card) throw new Error("GiftCard non trovata.");
  const st = clean(card.status).toLowerCase();
  if (st === "cancelled" || st === "canceled") throw new Error("Non è possibile modificare la scadenza di una GiftCard annullata.");
  if (st === "redeemed") throw new Error("Non e possibile modificare la scadenza di una GiftCard riscattata.");

  const next = clean(expiresAtRaw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(next) || Number.isNaN(Date.parse(next))) throw new Error("Seleziona una nuova data di scadenza valida.");
  if (next < todayIso()) throw new Error("La nuova data di scadenza non può essere precedente a oggi.");
  const issued = isoDate(card.issued_at);
  if (issued !== "" && next <= issued) throw new Error('La data "Valida al" deve essere almeno il giorno successivo a "Valida dal".');

  const values: Record<string, unknown> = { expires_at: `${next} 23:59:59`, updated_at: new Date() };
  if (st === "expired") values.status = "active";
  await tenantUpdate({ slug, table: "giftcards", id, values });
  // Ledger legacy (type expiry_change).
  await tenantInsert(await tenantTable(slug, "giftcard_transactions"), { giftcard_id: id, type: "expiry_change", amount: 0, note: `Nuova scadenza: ${next}`, created_at: new Date() }).catch(() => 0);
  return { ok: true, message: "Scadenza GiftCard aggiornata" };
}

export async function updateGiftCardInternalNote(slug: string, id: number, noteRaw: string): Promise<{ ok: true; message: string }> {
  const card = await giftCardRow(slug, id);
  if (!card) throw new Error("GiftCard non trovata.");
  await tenantUpdate({ slug, table: "giftcards", id, values: { internal_note: clean(noteRaw) || null, updated_at: new Date() } });
  return { ok: true, message: "Nota interna salvata" };
}

// Riscatto per-item (giftcard.php _mode=redeem_item / GiftCard::redeemGiftCardItem):
// scala redeemed_qty sulla voce; la card diventa 'redeemed' quando credito e
// voci sono esauriti.
export async function redeemGiftCardItemManage(slug: string, id: number, itemRowId: number, qtyRaw: number, note: string, by: number, location: { id: number; name: string } | null): Promise<{ ok: true; message: string }> {
  const card = await giftCardRow(slug, id);
  if (!card) throw new Error("GiftCard non trovata.");
  const st = gcEffectiveStatus(String(card.status ?? "active"), isoDate(card.expires_at));
  if (st === "expired") throw new Error("GiftCard scaduta.");
  if (st !== "active") throw new Error(`GiftCard non utilizzabile (stato: ${st}).`);

  const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftcard_items", where: "id = ? AND giftcard_id = ?", params: [itemRowId, id], limit: 1 }).catch(() => [] as RowDataPacket[]);
  if (!rows[0]) throw new Error("Voce non trovata.");
  const qtyTotal = Math.max(1, Number(rows[0].qty ?? 1));
  const redeemed = Math.max(0, Number(rows[0].redeemed_qty ?? 0));
  const residual = Math.max(0, qtyTotal - redeemed);
  if (residual <= 0) throw new Error("Nessun residuo da riscattare per questa voce.");
  const qty = Math.max(1, Math.trunc(Number(qtyRaw) || 1));
  if (qty > residual) throw new Error(`Quantità eccede il residuo (residuo: ${residual}).`);

  await tenantUpdate({ slug, table: "giftcard_items", id: itemRowId, values: { redeemed_qty: redeemed + qty } });
  await tenantInsert(await tenantTable(slug, "giftcard_transactions"), {
    giftcard_id: id,
    type: "redeem",
    amount: 0,
    note: clean(note) || `Riscatto item: ${clean(rows[0].item_name)} × ${qty}`,
    created_at: new Date(),
    created_by: by > 0 ? by : null,
    location_id: location && location.id > 0 ? location.id : null,
    location_name: location ? clean(location.name) || null : null,
  }).catch(() => 0);

  // Flip a 'redeemed' quando saldo 0 e nessun residuo item (GiftCard.php ~2301).
  const balance = round2(Number(card.balance ?? 0));
  const itemRows = await tenantSelect<RowDataPacket>({ slug, table: "giftcard_items", columns: "qty, redeemed_qty", where: "giftcard_id = ?", params: [id] }).catch(() => [] as RowDataPacket[]);
  const anyResidual = itemRows.some((r) => Math.max(0, Number(r.qty ?? 1)) - Math.max(0, Number(r.redeemed_qty ?? 0)) > 0);
  if (balance <= 0.00001 && !anyResidual) {
    await tenantUpdate({ slug, table: "giftcards", id, values: { status: "redeemed", redeemed_at: new Date(), updated_at: new Date() } }).catch(() => 0);
  }
  return { ok: true, message: "Riscatto item registrato" };
}

// "Invio email al destinatario" (giftcard.php _mode=send_email). showAmount
// replica "Mostra importo e contenuto nella mail".
export async function sendGiftCardEmailManage(slug: string, id: number, toRaw: string, showAmount: boolean, giftMessageRaw: string): Promise<{ ok: true; message: string }> {
  const detail = await getGiftCardFull(slug, id);
  if (!detail) throw new Error("GiftCard non trovata.");
  if (detail.status === "cancelled") throw new Error("Non è possibile inviare una GiftCard annullata.");
  if (detail.status === "expired") throw new Error("Non e possibile inviare una GiftCard scaduta.");
  const to = clean(toRaw);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error("Email destinatario non valida.");
  if (!emailConfigured()) throw new Error("Invio email non disponibile");

  const bizRows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "name, email, giftcard_terms", orderBy: "id ASC", limit: 1 }).catch(() => [] as RowDataPacket[]);
  const biz = bizRows[0] ?? null;
  const bizName = clean(biz?.name) || "BeautySuite";
  const terms = clean(biz?.giftcard_terms);

  const base = String(process.env.PRENODO_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  const voucherUrl = base !== "" ? `${base}/${slug}/giftcard_voucher?public=1&embed=1&token=${encodeURIComponent(detail.publicToken)}` : "";
  const h = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fmtIt = (iso: string) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "—");
  const money = (n: number) => `€ ${n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const giftMessage = clean(giftMessageRaw) || detail.giftMessage;

  let html = `<div style="background:#0f766e;color:#ffffff;padding:16px 20px;border-radius:12px 12px 0 0;font-size:18px;font-weight:700">La tua GiftCard</div>`;
  html += `<div style="border:1px solid #e5e7eb;border-top:0;padding:20px;border-radius:0 0 12px 12px">`;
  html += `<p style="margin:0 0 6px">Ciao ${h(detail.recipientName || "")},</p>`;
  html += `<p style="margin:0 0 14px">hai ricevuto una <strong>GiftCard</strong> da ${h(detail.senderName)}!</p>`;
  if (giftMessage) html += `<p style="margin:0 0 14px;font-style:italic;white-space:pre-line">&ldquo;${h(giftMessage)}&rdquo;</p>`;
  html += `<div style="text-align:center;margin:14px 0"><div style="display:inline-block;background:#f0fdfa;border:2px dashed #0f766e;border-radius:12px;padding:14px 26px;font-size:24px;font-weight:800;letter-spacing:2px">${h(detail.code)}</div><div style="font-size:12px;color:#6b7280;margin-top:6px">MOSTRA QUESTO CODICE IN CASSA</div></div>`;
  if (voucherUrl) html += `<div style="text-align:center;margin:14px 0"><a href="${h(voucherUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:600;letter-spacing:.2px">Vedi Voucher</a></div>`;
  html += `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:10px 0">`;
  const row = (k: string, v: string) => `<tr><td style="padding:6px 0;color:#6b7280">${h(k)}</td><td style="padding:6px 0;text-align:right;font-weight:600">${h(v)}</td></tr>`;
  html += row("Evento", detail.eventLabel);
  if (showAmount && detail.hasMoney) {
    html += row("Importo", money(detail.initialAmount));
    html += row("Saldo", money(detail.balance));
  }
  html += row("Emessa il", fmtIt(detail.issuedAt.slice(0, 10)));
  html += row("Scadenza", detail.expiresAt ? fmtIt(detail.expiresAt) : "Nessuna scadenza");
  html += `</table>`;
  if (showAmount && detail.items.length) {
    html += `<p style="margin:12px 0 4px;font-weight:700">Contenuto regalo</p><ul style="margin:0 0 10px;padding-left:18px">`;
    for (const it of detail.items) html += `<li>${h(it.name)}${it.qty > 1 ? ` × ${it.qty}` : ""}</li>`;
    html += `</ul>`;
  }
  if (!showAmount) html += `<p style="margin:12px 0;color:#6b7280">Recati in negozio per scoprire il contenuto della tua GiftCard.</p>`;
  if (terms) html += `<p style="margin:12px 0 4px;font-weight:700">Condizioni</p><p style="margin:0;color:#6b7280;font-size:12px;white-space:pre-line">${h(terms)}</p>`;
  html += `</div>`;

  const subject = `Hai ricevuto una GiftCard - ${bizName}`;
  const tpl = buildModernEmailTemplate(subject, html, { business_name: bizName, business_email: clean(biz?.email) });
  const result = await sendEmail({ to, subject, html: tpl.html, text: tpl.text, fromName: bizName, replyTo: clean(biz?.email) || undefined });
  if (!result.ok) throw new Error(result.error || "Invio email non riuscito");

  await tenantUpdate({ slug, table: "giftcards", id, values: { last_email_sent_at: new Date(), last_email_sent_to: to, last_email_hide_amount: showAmount ? 0 : 1, updated_at: new Date() } }).catch(() => 0);
  return { ok: true, message: `Email inviata a ${to}` };
}
