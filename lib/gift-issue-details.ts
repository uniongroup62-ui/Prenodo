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
import { dbExecute, dbQuery, tenantInsert, tenantSelect, tenantTable, tenantUpdate, columnExists } from "@/lib/tenant-db";
import { buildModernEmailTemplate, emailConfigured, sendEmail } from "@/lib/email";

const clean = (v: unknown): string => String(v ?? "").trim();
const todayIso = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
// I timestamp Supabase sono "without time zone" (wall clock locale): mai
// toISOString() sulle Date di node-pg (shifta a UTC) — formatter locali.
const localDate = (v: unknown): string => {
  if (!v) return "";
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  return String(v).slice(0, 10);
};
const localDateTime = (v: unknown): string => {
  if (!v) return "";
  if (v instanceof Date) {
    return `${localDate(v)} ${String(v.getHours()).padStart(2, "0")}:${String(v.getMinutes()).padStart(2, "0")}:${String(v.getSeconds()).padStart(2, "0")}`;
  }
  return String(v).replace("T", " ").slice(0, 19);
};
const isoDate = localDate;
const isoDateTime = (v: unknown): string => {
  const s = localDateTime(v);
  return s === "" ? "" : s.replace(" ", "T");
};
// giftbox_page_dt_display: d/m/Y H:i (o solo data).
const displayDmyHm = (v: unknown): string => {
  const s = localDateTime(v);
  if (s === "") return "";
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)} ${s.slice(11, 16)}`;
};
const displayDmy = (v: unknown): string => {
  const s = localDate(v);
  if (s === "") return "";
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
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

// Eventi GiftBox (GiftBox::eventMap, ordine e testi verbatim): label per il
// select, title/subject/emoji/image per l'email.
export const GIFTBOX_EVENT_MAP: Array<{ key: string; label: string; title: string; subject: string; emoji: string; image: string }> = [
  { key: "giftbox", label: "GiftBox (generica)", title: "Hai ricevuto una GiftBox!", subject: "Hai ricevuto una GiftBox", emoji: "🎁", image: "/assets/img/giftcard-events/giftcard.png" },
  { key: "compleanno", label: "Compleanno", title: "Buon compleanno!", subject: "Buon compleanno! Hai ricevuto una GiftBox", emoji: "🎂", image: "/assets/img/giftcard-events/birthday.png" },
  { key: "anniversario", label: "Anniversario", title: "Buon anniversario!", subject: "Buon anniversario! Hai ricevuto una GiftBox", emoji: "💍", image: "/assets/img/giftcard-events/anniversary.png" },
  { key: "san_valentino", label: "San Valentino", title: "Buon San Valentino!", subject: "Buon San Valentino! Hai ricevuto una GiftBox", emoji: "❤️", image: "/assets/img/giftcard-events/valentines_day.png" },
  { key: "natale", label: "Natale", title: "Buon Natale!", subject: "Buon Natale! Hai ricevuto una GiftBox", emoji: "🎄", image: "/assets/img/giftcard-events/christmas.png" },
  { key: "capodanno", label: "Capodanno", title: "Buon Capodanno!", subject: "Buon Capodanno! Hai ricevuto una GiftBox", emoji: "✨", image: "/assets/img/giftcard-events/new_year.png" },
  { key: "epifania", label: "Epifania", title: "Buona Epifania!", subject: "Buona Epifania! Hai ricevuto una GiftBox", emoji: "🧹", image: "/assets/img/giftcard-events/epiphany.png" },
  { key: "festa_donna", label: "Festa della Donna", title: "Buona Festa della Donna!", subject: "Buona Festa della Donna! Hai ricevuto una GiftBox", emoji: "🌼", image: "/assets/img/giftcard-events/womens_day.png" },
  { key: "pasqua", label: "Pasqua", title: "Buona Pasqua!", subject: "Buona Pasqua! Hai ricevuto una GiftBox", emoji: "🐣", image: "/assets/img/giftcard-events/easter.png" },
  { key: "pasquetta", label: "Pasquetta", title: "Buona Pasquetta!", subject: "Buona Pasquetta! Hai ricevuto una GiftBox", emoji: "🧺", image: "/assets/img/giftcard-events/easter_monday.png" },
  { key: "festa_mamma", label: "Festa della Mamma", title: "Buona Festa della Mamma!", subject: "Buona Festa della Mamma! Hai ricevuto una GiftBox", emoji: "🌷", image: "/assets/img/giftcard-events/mothers_day.png" },
  { key: "festa_papa", label: "Festa del Papà", title: "Buona Festa del Papà!", subject: "Buona Festa del Papà! Hai ricevuto una GiftBox", emoji: "👔", image: "/assets/img/giftcard-events/fathers_day.png" },
];
export const GIFTBOX_EVENT_OPTIONS: Array<{ key: string; label: string }> = GIFTBOX_EVENT_MAP.map((e) => ({ key: e.key, label: e.label }));

// GiftBox::normalizeEventType: lowercase, spazi/trattini -> underscore,
// default 'giftbox' se sconosciuto.
export function normalizeGiftBoxEventType(raw: unknown): string {
  let k = clean(raw).toLowerCase().replace(/[\s-]+/g, "_");
  if (k === "" || !GIFTBOX_EVENT_MAP.some((e) => e.key === k)) k = "giftbox";
  return k;
}
export function giftBoxEventLabel(key: unknown): string {
  const k = normalizeGiftBoxEventType(key);
  return GIFTBOX_EVENT_MAP.find((e) => e.key === k)?.label ?? "GiftBox (generica)";
}

// giftbox_page_location_label(): nome sede, altrimenti fallback, altrimenti
// 'Sede #N', altrimenti '-'.
async function giftLocationLabel(slug: string, locationId: number, fallback = ""): Promise<string> {
  const locId = Math.max(0, Math.trunc(Number(locationId) || 0));
  if (locId > 0) {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "locations", columns: "name", where: "id = ?", params: [locId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    const label = clean(rows[0]?.name);
    if (label !== "" && label.toLowerCase() !== "sede") return label;
  }
  const fb = clean(fallback);
  if (fb !== "" && fb !== "-") return fb;
  if (locId > 0) return `Sede #${locId}`;
  return "-";
}

async function userLabel(slug: string, id: number): Promise<string> {
  if (!id || id <= 0) return "";
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "users", columns: "name, email", where: "id = ?", params: [id], limit: 1 }).catch(() => [] as RowDataPacket[]);
  if (!rows[0]) return `#${id}`;
  return clean(rows[0].name) || clean(rows[0].email) || `#${id}`;
}

// Token voucher pubblico: backfill lazy quando manca (le istanze emesse da
// vecchi flussi possono non averlo — il bottone Voucher deve sempre funzionare).
// Token voucher per la variante MANAGE dei viewer (?id=N — i link "Voucher" di
// Movimenti/dettagli; legacy giftbox_voucher.php / giftcard_voucher.php con
// login): legge l'istanza tenant-scoped e riusa il backfill lazy del token.
export async function giftboxVoucherTokenById(slug: string, id: number): Promise<string> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftbox_instances", columns: "id, voucher_public_token", where: "id = ?", params: [id], limit: 1 }).catch(() => [] as RowDataPacket[]);
  if (!rows[0]) return "";
  return ensureVoucherToken(slug, "giftbox_instances", id, String(rows[0].voucher_public_token ?? ""));
}
export async function giftcardVoucherTokenById(slug: string, id: number): Promise<string> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftcards", columns: "id, voucher_public_token", where: "id = ?", params: [id], limit: 1 }).catch(() => [] as RowDataPacket[]);
  if (!rows[0]) return "";
  return ensureVoucherToken(slug, "giftcards", id, String(rows[0].voucher_public_token ?? ""));
}

export async function ensureVoucherToken(slug: string, table: "giftcards" | "giftbox_instances", id: number, current: string): Promise<string> {
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

export type GiftBoxAvailabilityIssue = { type: string; label: string; message: string; context: string | null };

// GiftBox::expireDueInstances(): stampa 'expired' sulle istanze issued con
// scadenza passata (eseguito a ogni load pagina come il legacy).
export async function expireDueGiftBoxInstances(slug: string): Promise<void> {
  try {
    const t = await tenantTable(slug, "giftbox_instances");
    const scoped = t.mode === "shared" && (await columnExists(t.name, "tenant_id"));
    await dbExecute(
      `UPDATE \`${t.name}\` SET status='expired' WHERE status='issued' AND expires_at IS NOT NULL AND expires_at > '1000-01-01 00:00:00' AND expires_at < NOW()${scoped ? " AND tenant_id = ?" : ""}`,
      scoped ? [t.tenantId ?? 0] : [],
    );
  } catch { /* best-effort come il legacy */ }
}

// ---- GiftBoxAvailability.php (port) ------------------------------------------
function gbAvailCompact(value: string, max = 180): string {
  const v = clean(value).replace(/\s+/g, " ");
  if (v === "") return "";
  return v.length > max ? `${v.slice(0, Math.max(1, max - 1))}…` : v;
}
function gbAvailTypeLabel(type: string): string {
  const t = clean(type).toLowerCase();
  if (t === "service") return "Servizio";
  if (t === "product") return "Prodotto";
  if (t === "package") return "Pacchetto";
  return "Voce";
}
type GbAvailOut = { errors: GiftBoxAvailabilityIssue[]; warnings: GiftBoxAvailabilityIssue[] };
function gbAvailAddIssue(out: GbAvailOut, seen: Set<string>, bucket: "errors" | "warnings", type: string, label: string, message: string, context: string | null): void {
  const typeLabel = gbAvailTypeLabel(type);
  const lbl = gbAvailCompact(label);
  const msg = gbAvailCompact(message, 280);
  const ctx = context !== null ? gbAvailCompact(context, 220) : null;
  const key = `${bucket}|${typeLabel.toLowerCase()}|${lbl.toLowerCase()}|${(ctx ?? "").toLowerCase()}|${msg.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  out[bucket].push({ type: typeLabel, label: lbl, message: msg, context: ctx });
}

// giftbox_availability_check_single_reference(): eliminato -> error,
// disattivato -> warning (testi verbatim con accenti).
async function gbAvailCheckSingleReference(
  slug: string, type: string, itemId: number, snapshotLabel: string,
  out: GbAvailOut, seen: Set<string>, context: string | null,
): Promise<RowDataPacket | null> {
  const t = clean(type).toLowerCase();
  if (itemId <= 0) return null;
  const table = t === "service" ? "services" : t === "product" ? "products" : t === "package" ? "packages" : null;
  if (!table) return null;
  const hasDeleted = await columnExists(table, "deleted_at").catch(() => false);
  const columns = `id, name${t === "product" ? ", sku" : ""}, COALESCE(is_active,1) AS ia${hasDeleted ? ", deleted_at" : ""}`;
  const rows = await tenantSelect<RowDataPacket>({ slug, table, columns, where: "id = ?", params: [itemId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  const typeLabel = gbAvailTypeLabel(t);
  const row = rows[0] ?? null;
  const deleted = !row || (hasDeleted && row.deleted_at !== null && row.deleted_at !== undefined && clean(row.deleted_at) !== "");
  if (deleted) {
    const label = snapshotLabel !== "" ? snapshotLabel : `${typeLabel} #${itemId}`;
    gbAvailAddIssue(out, seen, "errors", t, label, `${typeLabel} "${label}" è stato eliminato.`, context);
    return null;
  }
  let label = "";
  if (t === "product") {
    let name = clean(row.name) || (snapshotLabel || `Prodotto #${itemId}`);
    const sku = clean(row.sku);
    if (sku !== "" && !name.includes(`(${sku})`)) name += ` (${sku})`;
    label = gbAvailCompact(name);
  } else {
    label = gbAvailCompact(clean(row.name) || (snapshotLabel || `${typeLabel} #${itemId}`));
  }
  if (label === "") label = snapshotLabel || `${typeLabel} #${itemId}`;
  if (Number(row.ia ?? 1) !== 1) {
    gbAvailAddIssue(out, seen, "warnings", t, label, `${typeLabel} "${label}" è stato disattivato.`, context);
  }
  return row;
}

// giftbox_availability_check_package_components().
async function gbAvailCheckPackageComponents(slug: string, packageId: number, packageLabel: string, out: GbAvailOut, seen: Set<string>): Promise<void> {
  if (packageId <= 0) return;
  const context = `Pacchetto "${gbAvailCompact(packageLabel)}"`;
  const seenComponents = new Set<string>();
  const items = await tenantSelect<RowDataPacket>({
    slug, table: "package_items", columns: "item_type, item_id",
    where: "package_id = ? AND LOWER(TRIM(COALESCE(item_type,''))) IN ('service','product')",
    params: [packageId], orderBy: "sort_order ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  for (const r of items) {
    const type = clean(r.item_type).toLowerCase();
    const iid = Number(r.item_id ?? 0);
    if (!["service", "product"].includes(type) || iid <= 0) continue;
    const key = `${type}:${iid}`;
    if (seenComponents.has(key)) continue;
    seenComponents.add(key);
    await gbAvailCheckSingleReference(slug, type, iid, `${gbAvailTypeLabel(type)} #${iid}`, out, seen, context);
  }
  const svcRows = await tenantSelect<RowDataPacket>({ slug, table: "package_services", columns: "service_id", where: "package_id = ?", params: [packageId], orderBy: "sort_order ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  for (const r of svcRows) {
    const sid = Number(r.service_id ?? 0);
    if (sid <= 0) continue;
    const key = `service:${sid}`;
    if (seenComponents.has(key)) continue;
    seenComponents.add(key);
    await gbAvailCheckSingleReference(slug, "service", sid, `Servizio #${sid}`, out, seen, context);
  }
  const pkgRows = await tenantSelect<RowDataPacket>({ slug, table: "packages", columns: "COALESCE(service_id,0) AS sid", where: "id = ?", params: [packageId], limit: 1 }).catch(() => [] as RowDataPacket[]);
  const sid = Number(pkgRows[0]?.sid ?? 0);
  if (sid > 0 && !seenComponents.has(`service:${sid}`)) {
    await gbAvailCheckSingleReference(slug, "service", sid, `Servizio #${sid}`, out, seen, context);
  }
}

// giftbox_availability_check_instance(): righe raw dell'istanza (snapshot);
// custom "Pacchetto: NOME" controlla il pacchetto per nome (compat legacy).
export async function giftBoxAvailabilityCheckInstance(slug: string, instanceId: number): Promise<GbAvailOut> {
  const out: GbAvailOut = { errors: [], warnings: [] };
  const seen = new Set<string>();
  if (instanceId <= 0) return out;
  const items = await tenantSelect<RowDataPacket>({
    slug, table: "giftbox_instance_items",
    where: "instance_id = ?", params: [instanceId], orderBy: "COALESCE(sort_order,0) ASC, giftbox_item_id ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  for (const item of items) {
    const type = clean(item.item_type).toLowerCase() || "custom";
    if (type === "service") {
      const sid = Number(item.service_id ?? 0);
      if (sid <= 0) continue;
      let label = "";
      try {
        const snap = JSON.parse(String(item.service_snapshot_json ?? "null")) as { name?: unknown } | null;
        label = clean(snap?.name);
      } catch { label = ""; }
      if (label === "") label = `Servizio #${sid}`;
      await gbAvailCheckSingleReference(slug, "service", sid, gbAvailCompact(label), out, seen, null);
      continue;
    }
    if (type === "product") {
      const pid = Number(item.product_id ?? 0);
      if (pid <= 0) continue;
      await gbAvailCheckSingleReference(slug, "product", pid, `Prodotto #${pid}`, out, seen, null);
      continue;
    }
    if (type === "custom") {
      const label = clean(item.custom_label);
      const m = /^\s*pacchetto\s*:\s*(.+)$/iu.exec(label);
      if (!m) continue;
      const pkgName = gbAvailCompact(clean(m[1]));
      if (pkgName === "") continue;
      const hasDeleted = await columnExists("packages", "deleted_at").catch(() => false);
      const rows = await tenantSelect<RowDataPacket>({
        slug, table: "packages",
        columns: `id, name, COALESCE(is_active,1) AS ia${hasDeleted ? ", deleted_at" : ""}, COALESCE(service_id,0) AS sid`,
        where: "LOWER(TRIM(name)) = LOWER(TRIM(?))", params: [pkgName], orderBy: "id DESC", limit: 1,
      }).catch(() => [] as RowDataPacket[]);
      const row = rows[0] ?? null;
      const deleted = !row || (hasDeleted && row.deleted_at !== null && row.deleted_at !== undefined && clean(row.deleted_at) !== "");
      if (deleted) {
        gbAvailAddIssue(out, seen, "errors", "package", pkgName, `Pacchetto "${pkgName}" è stato eliminato.`, null);
        continue;
      }
      const pkgId = Number(row.id ?? 0);
      const pkgLabel = clean(row.name) || pkgName;
      if (Number(row.ia ?? 1) !== 1) {
        gbAvailAddIssue(out, seen, "warnings", "package", pkgLabel, `Pacchetto "${pkgLabel}" è stato disattivato.`, null);
      }
      if (pkgId > 0) await gbAvailCheckPackageComponents(slug, pkgId, pkgLabel, out, seen);
    }
  }
  return out;
}

// giftbox_availability_reactivation_block_message().
export function giftBoxReactivationBlockMessage(availability: GbAvailOut): string {
  const parts: string[] = [];
  let i = 0;
  for (const issue of availability.errors ?? []) {
    let msg = clean(issue.message);
    if (msg === "") continue;
    const ctx = clean(issue.context ?? "");
    if (ctx !== "") msg += ` (${ctx})`;
    parts.push(msg);
    i++;
    if (i >= 5) break;
  }
  if ((availability.errors ?? []).length > 5) parts.push(`altri ${availability.errors.length - 5} elementi`);
  const txt = parts.length > 0 ? parts.join("; ") : "uno o più contenuti della GiftBox sono stati eliminati";
  return `Non sarà possibile riattivare la GiftBox perché ${txt}. Elimina o sostituisci gli elementi indicati prima di riattivarla.`;
}

// Ricerca clienti destinatario (api_clients.php action=search): LIKE ESCAPE '!'
// su full_name/email/phone(+phone_home/phone2) + variante solo-cifre, ORDER
// full_name ASC LIMIT 50.
export async function searchGiftRecipientClients(slug: string, qRaw: string): Promise<Array<{ id: number; full_name: string; email: string; phone: string }>> {
  const q = clean(qRaw);
  if (q === "") return [];
  const like = `%${q.replace(/!/g, "!!").replace(/%/g, "!%").replace(/_/g, "!_")}%`;
  const digits = q.replace(/\D+/g, "");
  const where: string[] = ["full_name ILIKE ? ESCAPE '!'", "email ILIKE ? ESCAPE '!'", "phone ILIKE ? ESCAPE '!'"];
  const params: unknown[] = [like, like, like];
  for (const col of ["phone_home", "phone2"]) {
    if (await columnExists("clients", col).catch(() => false)) {
      where.push(`${col} ILIKE ? ESCAPE '!'`);
      params.push(like);
    }
  }
  if (digits !== "") {
    where.push("phone LIKE ?");
    params.push(`%${digits}%`);
  }
  const rows = await tenantSelect<RowDataPacket>({
    slug, table: "clients", columns: "id, full_name, email, phone",
    where: `(${where.join(" OR ")})`, params, orderBy: "full_name ASC", limit: 50,
  }).catch(() => [] as RowDataPacket[]);
  return rows.map((r) => ({ id: Number(r.id ?? 0), full_name: clean(r.full_name), email: clean(r.email), phone: clean(r.phone) }));
}

export type GiftBoxMovementRow = {
  at: string;
  atLabel: string;
  type: string;
  amount: number;
  serviceProduct: string;
  locationLabel: string;
  note: string;
  operatorName: string;
};

export type GiftBoxInstanceFull = {
  id: number;
  code: string;
  publicToken: string;
  giftboxName: string;
  status: string;
  statusLabel: string;
  statusBadge: string;
  eventKey: string;
  eventLabel: string;
  senderClientId: number;
  senderName: string;
  recipientClientId: number;
  recipientName: string;
  recipientEmail: string;
  recipientClient: { id: number; name: string; email: string; phone: string } | null;
  recipientLocked: boolean;
  recipientLockMessage: string;
  locationLabel: string;
  voucherHideAmount: boolean;
  note: string;
  giftMessage: string;
  internalNote: string;
  pointsCost: number;
  issuedAtLabel: string;
  validStartLabel: string;
  expiresLabel: string;
  expiresDate: string;
  redeemedAtRaw: string;
  lastEmailSentAtRaw: string;
  lastEmailSentTo: string;
  lastEmailShowDetails: boolean;
  emailSendDisabled: boolean;
  linkedSaleId: number;
  items: GiftBoxDetailItem[];
  totalUnits: number;
  redeemedUnits: number;
  pendingUnits: number;
  availableUnits: number;
  partial: boolean;
  movements: GiftBoxMovementRow[];
  canRedeem: boolean;
  expiryEditable: boolean;
  expiryMinDate: string;
  expiryModalValue: string;
  expiryMinBeyondToday: boolean;
  expiryEditLocked: boolean;
  expiryEditLockMessage: string;
  availabilityErrors: GiftBoxAvailabilityIssue[];
  availabilityWarnings: GiftBoxAvailabilityIssue[];
};

// giftbox_page_instance_status_meta(): badge name (bg-<badge>) + label.
export function giftBoxStatusMeta(status: string): { code: string; label: string; badge: string } {
  const code = clean(status).toLowerCase();
  switch (code) {
    case "issued":
    case "active":
      return { code, label: "Attiva", badge: "success" };
    case "redeemed":
      return { code, label: "Riscattata", badge: "info" };
    case "expired":
      return { code, label: "Scaduta", badge: "warning" };
    case "cancelled":
    case "canceled":
      return { code, label: "Annullata", badge: "danger" };
    default:
      return { code, label: code !== "" ? code.charAt(0).toUpperCase() + code.slice(1) : "—", badge: "secondary" };
  }
}

async function giftBoxInstanceRow(slug: string, id: number): Promise<RowDataPacket | null> {
  if (id <= 0) return null;
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "giftbox_instances", where: "id = ?", params: [id], limit: 1 });
  return rows[0] ?? null;
}

// appointment_status_normalize_code (subset usato qui).
function gbApptStatusCode(raw: unknown): string {
  const s = clean(raw).toLowerCase();
  if (["cancelled", "canceled", "annullato", "annullata", "rejected", "rifiutato"].includes(s)) return "canceled";
  if (["no_show", "no-show", "noshow", "no show", "non presentato"].includes(s)) return "no_show";
  return s;
}

// Item label legacy (service_name / product_name / custom "label — details").
function gbItemLabel(itemType: string, serviceName: string, productName: string, customLabel: string, customDetails: string): string {
  const t = clean(itemType).toLowerCase();
  let label = "";
  if (t === "service") label = serviceName || "Servizio";
  else if (t === "product") label = productName || "Prodotto";
  else {
    label = customLabel || "Voce";
    if (clean(customDetails) !== "") label += ` — ${clean(customDetails)}`;
  }
  label = clean(label);
  return label !== "" ? label : "Elemento";
}

// Collegamenti a prenotazioni APERTE per il riscatto manuale
// (giftbox_page_collect_active_reservation_stats).
type GbAgiRow = {
  linkId: number;
  appointmentId: number;
  giftboxItemId: number;
  qty: number;
  redeemed: boolean;
  hasRedemption: boolean;
  statusCode: string;
  startsAt: string;
  apptCreatedAt: string;
  linkCreatedAt: string;
  cancelledAt: string;
  code: string;
  locationId: number;
};
async function gbAppointmentLinks(slug: string, instanceId: number): Promise<GbAgiRow[]> {
  const agiT = await tenantTable(slug, "appointment_giftbox_items");
  const apT = await tenantTable(slug, "appointments");
  const scoped = agiT.mode === "shared" && (await columnExists(agiT.name, "tenant_id"));
  const hasPublicCode = await columnExists(apT.name, "public_code").catch(() => false);
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT agi.id AS link_id, agi.appointment_id, agi.giftbox_item_id, agi.qty, agi.redeemed_at, agi.redemption_id, agi.created_at AS link_created_at,
            a.status AS appointment_status, a.starts_at, a.created_at AS appointment_created_at, a.cancelled_at AS appointment_cancelled_at,
            ${hasPublicCode ? "a.public_code" : "NULL AS public_code"}, a.location_id AS appointment_location_id
       FROM \`${agiT.name}\` agi
       JOIN \`${apT.name}\` a ON a.id = agi.appointment_id${scoped ? " AND a.tenant_id = agi.tenant_id" : ""}
      WHERE agi.instance_id = ?${scoped ? " AND agi.tenant_id = ?" : ""}
      ORDER BY a.starts_at ASC, a.id ASC, agi.id ASC`,
    scoped ? [instanceId, agiT.tenantId ?? 0] : [instanceId],
  ).catch(() => [] as RowDataPacket[]);
  return rows.map((r) => ({
    linkId: Number(r.link_id ?? 0),
    appointmentId: Number(r.appointment_id ?? 0),
    giftboxItemId: Number(r.giftbox_item_id ?? 0),
    qty: Math.max(1, Number(r.qty ?? 1)),
    redeemed: r.redeemed_at !== null && r.redeemed_at !== undefined,
    hasRedemption: Number(r.redemption_id ?? 0) > 0,
    statusCode: gbApptStatusCode(r.appointment_status),
    startsAt: localDateTime(r.starts_at),
    apptCreatedAt: localDateTime(r.appointment_created_at),
    linkCreatedAt: localDateTime(r.link_created_at),
    cancelledAt: localDateTime(r.appointment_cancelled_at),
    code: clean(r.public_code) || String(Number(r.appointment_id ?? 0)),
    locationId: Number(r.appointment_location_id ?? 0),
  }));
}

// Righe contenuto istanza con fallback template (GiftBox::getInstanceItemRows).
async function gbInstanceItemRows(slug: string, instanceId: number, giftboxId: number): Promise<RowDataPacket[]> {
  const rows = await tenantSelect<RowDataPacket>({
    slug, table: "giftbox_instance_items", where: "instance_id = ?", params: [instanceId],
    orderBy: "COALESCE(sort_order,0) ASC, giftbox_item_id ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  if (rows.length > 0) return rows;
  if (giftboxId <= 0) return [];
  const tpl = await tenantSelect<RowDataPacket>({
    slug, table: "giftbox_items", where: "giftbox_id = ?", params: [giftboxId],
    orderBy: "COALESCE(sort_order,0) ASC, id ASC",
  }).catch(() => [] as RowDataPacket[]);
  // Nel fallback template l'id riga È il giftbox_item_id.
  return tpl.map((r) => ({ ...r, giftbox_item_id: r.id }));
}

// Link "Dettagli vendita": ricerca best-effort del sale_id dalla riga
// sale_items che contiene il codice GiftBox (come giftbox.php).
async function gbFindSaleByCode(slug: string, code: string): Promise<{ saleId: number; cancelLine: string }> {
  const out = { saleId: 0, cancelLine: "" };
  if (clean(code) === "") return out;
  const rows = await tenantSelect<RowDataPacket>({
    slug, table: "sale_items", columns: "sale_id",
    where: "item_name LIKE ? AND item_name LIKE ?", params: ["GiftBox%", `%${code}%`],
    orderBy: "id DESC", limit: 1,
  }).catch(() => [] as RowDataPacket[]);
  out.saleId = Number(rows[0]?.sale_id ?? 0);
  if (out.saleId > 0) {
    const sale = await tenantSelect<RowDataPacket>({ slug, table: "sales", columns: "status, cancelled_at, cancelled_reason, notes", where: "id = ?", params: [out.saleId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    if (sale[0]) {
      const notes = String(sale[0].notes ?? "");
      const m = /^\s*\[ANNULLATA[^\]]*\].*$/im.exec(notes);
      if (m) {
        out.cancelLine = clean(m[0]);
      } else {
        const st = clean(sale[0].status).toLowerCase();
        const ca = localDateTime(sale[0].cancelled_at);
        const cr = clean(sale[0].cancelled_reason);
        if (st === "cancelled" || ca !== "" || cr !== "") {
          out.cancelLine = `[ANNULLATA ${ca !== "" ? ca : localDateTime(new Date())}] ${cr !== "" ? cr : "Annullamento vendita"}`;
        }
      }
    }
  }
  return out;
}

// GiftBox::recipientEditLockInfo (port): messaggi verbatim (senza accenti).
function gbRecipientLockInfo(status: string, expiresDate: string, redeemedUnits: number, activeApptLinks: number): { locked: boolean; message: string } {
  const st = clean(status).toLowerCase();
  if (st === "cancelled" || st === "canceled") {
    return { locked: true, message: "Non e possibile modificare il destinatario di questa GiftBox perche e annullata." };
  }
  if (st === "redeemed") {
    return { locked: true, message: "Non e piu possibile modificare il destinatario di questa GiftBox perche risulta gia riscattata." };
  }
  if (activeApptLinks > 0 || redeemedUnits > 0) {
    return { locked: true, message: "Non e piu possibile modificare il destinatario di questa GiftBox perche risulta gia riscattata, anche solo parzialmente." };
  }
  const expired = st === "expired" || (expiresDate !== "" && expiresDate < todayIso());
  if (expired) {
    return { locked: true, message: "Non e possibile modificare il destinatario di questa GiftBox perche e scaduta." };
  }
  return { locked: false, message: "" };
}

// Note cliente: rimuove le righe tecniche [ANNULLATA ...] / [INFO ...].
function gbCleanClientNote(raw: string): { note: string; cancelLine: string } {
  const noteRaw = clean(raw);
  let cancelLine = "";
  const m = /^\s*\[ANNULLATA[^\]]*\].*$/im.exec(noteRaw);
  if (m) cancelLine = clean(m[0]);
  let note = noteRaw;
  if (note !== "") {
    note = note.replace(/^\s*\[(ANNULLATA|INFO)[^\]]*\].*$/gim, "");
    note = note.replace(/\n{3,}/g, "\n\n").trim();
  }
  return { note, cancelLine };
}

export async function getGiftBoxInstanceFull(slug: string, id: number): Promise<GiftBoxInstanceFull | null> {
  const inst = await giftBoxInstanceRow(slug, id);
  if (!inst) return null;

  const giftboxId = Number(inst.giftbox_id ?? 0);
  let giftboxName = "";
  let giftboxValidFrom = "";
  if (giftboxId > 0) {
    const gb = await tenantSelect<RowDataPacket>({ slug, table: "giftboxes", columns: "name, valid_from", where: "id = ?", params: [giftboxId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    giftboxName = clean(gb[0]?.name);
    giftboxValidFrom = localDate(gb[0]?.valid_from);
  }

  const statusMeta = giftBoxStatusMeta(String(inst.status ?? ""));
  const status = statusMeta.code === "canceled" ? "cancelled" : statusMeta.code;
  const isCancelled = status === "cancelled";
  const isRedeemed = status === "redeemed";

  // Contenuti (snapshot istanza, fallback template).
  const itemRows = await gbInstanceItemRows(slug, id, giftboxId);

  // Riscattato = giftbox_redemption_items per giftbox_item_id (redeemed_map).
  const redemptionRows = await tenantSelect<RowDataPacket>({ slug, table: "giftbox_redemptions", where: "instance_id = ?", params: [id], orderBy: "redeemed_at ASC, id ASC" }).catch(() => [] as RowDataPacket[]);
  const redemptionIds = redemptionRows.map((r) => Number(r.id ?? 0)).filter((n) => n > 0);
  const redItemRows = redemptionIds.length
    ? await tenantSelect<RowDataPacket>({ slug, table: "giftbox_redemption_items", where: `redemption_id IN (${redemptionIds.map(() => "?").join(",")})`, params: redemptionIds, orderBy: "id ASC" }).catch(() => [] as RowDataPacket[])
    : [];
  const redeemedByGiftboxItem = new Map<number, number>();
  const redItemsByRedemption = new Map<number, Array<{ giftboxItemId: number; qty: number }>>();
  for (const r of redItemRows) {
    const gid = Number(r.giftbox_item_id ?? 0);
    const qty = Math.max(0, Number(r.qty ?? 0));
    if (gid <= 0 || qty <= 0) continue;
    redeemedByGiftboxItem.set(gid, (redeemedByGiftboxItem.get(gid) ?? 0) + qty);
    const rid = Number(r.redemption_id ?? 0);
    const arr = redItemsByRedemption.get(rid) ?? [];
    arr.push({ giftboxItemId: gid, qty });
    redItemsByRedemption.set(rid, arr);
  }

  // Collegamenti prenotazioni: riscatti senza redemption collegata contano
  // come usati; le prenotazioni APERTE (pending/scheduled) riservano quantità.
  const agiRows = await gbAppointmentLinks(slug, id);
  const pendingByGiftboxItem = new Map<number, number>();
  const pendingCodesByItem = new Map<number, string[]>();
  let activeApptLinks = 0;
  for (const r of agiRows) {
    if (r.redeemed) {
      if (!r.hasRedemption) redeemedByGiftboxItem.set(r.giftboxItemId, (redeemedByGiftboxItem.get(r.giftboxItemId) ?? 0) + r.qty);
      continue;
    }
    if (!["pending", "scheduled"].includes(r.statusCode)) continue;
    activeApptLinks += 1;
    pendingByGiftboxItem.set(r.giftboxItemId, (pendingByGiftboxItem.get(r.giftboxItemId) ?? 0) + r.qty);
    const codes = pendingCodesByItem.get(r.giftboxItemId) ?? [];
    if (!codes.includes(r.code)) codes.push(r.code);
    pendingCodesByItem.set(r.giftboxItemId, codes);
  }

  // Nomi correnti servizi/prodotti per label (snapshot json come priorità).
  const items: GiftBoxDetailItem[] = [];
  let totalUnits = 0;
  for (const r of itemRows) {
    const rowId = Number(r.id ?? 0);
    const giftboxItemId = Number(r.giftbox_item_id ?? 0);
    const itemType = clean(r.item_type).toLowerCase() || "custom";
    const qty = Math.max(1, Number(r.qty ?? 1));
    totalUnits += qty;

    let serviceName = "";
    let productName = "";
    if (itemType === "service") {
      try {
        const snap = JSON.parse(String(r.service_snapshot_json ?? "null")) as { name?: unknown } | null;
        serviceName = clean(snap?.name);
      } catch { serviceName = ""; }
      if (serviceName === "") {
        const sv = await tenantSelect<RowDataPacket>({ slug, table: "services", columns: "name", where: "id = ?", params: [Number(r.service_id ?? 0)], limit: 1 }).catch(() => [] as RowDataPacket[]);
        serviceName = clean(sv[0]?.name);
      }
    } else if (itemType === "product") {
      const pr = await tenantSelect<RowDataPacket>({ slug, table: "products", columns: "name", where: "id = ?", params: [Number(r.product_id ?? 0)], limit: 1 }).catch(() => [] as RowDataPacket[]);
      productName = clean(pr[0]?.name);
    }
    const name = gbItemLabel(itemType, serviceName, productName, clean(r.custom_label), clean(r.custom_details));

    const redeemedUnits = Math.max(0, Math.min(qty, redeemedByGiftboxItem.get(giftboxItemId) ?? 0));
    const remBase = Math.max(0, qty - redeemedUnits);
    const pendingUnits = Math.max(0, Math.min(remBase, pendingByGiftboxItem.get(giftboxItemId) ?? 0));
    items.push({
      rowId,
      giftboxItemId,
      itemType,
      name,
      qty,
      redeemedUnits,
      pendingUnits,
      availableUnits: Math.max(0, remBase - pendingUnits),
      pendingAppointments: pendingCodesByItem.get(giftboxItemId) ?? [],
    });
  }

  const redeemedUnits = items.reduce((s, it) => s + it.redeemedUnits, 0);
  const remainingUnits = Math.max(0, totalUnits - redeemedUnits);
  const pendingUnits = items.reduce((s, it) => s + it.pendingUnits, 0);
  const availableUnits = Math.max(0, remainingUnits - pendingUnits);
  const partial = status === "issued" && redeemedUnits > 0 && remainingUnits > 0;

  const senderClientId = Number(inst.client_id ?? 0) || 0;
  const sender = await clientRow(slug, senderClientId);
  const recipientClientId = Number(inst.recipient_client_id ?? 0) || 0;
  const recipientClient = recipientClientId > 0 ? await clientRow(slug, recipientClientId) : null;

  const code = clean(inst.code);
  const { saleId: linkedSaleId, cancelLine: saleCancelLine } = await gbFindSaleByCode(slug, code);

  const expiresDate = localDate(inst.expires_at);
  const { note: cleanNote, cancelLine: noteCancelLine } = gbCleanClientNote(String(inst.note ?? ""));

  const locationLabel = await giftLocationLabel(slug, Number(inst.location_id ?? 0), clean(inst.location_name));

  // Date header: "Emessa il" = created_at (fallback issued_at); "Inizio
  // validità" = issued_at (fallback valid_from template, poi created_at).
  const createdAtLocal = localDateTime(inst.created_at);
  const issuedAtLocal = localDateTime(inst.issued_at);
  const issuedDisplaySource = createdAtLocal !== "" ? createdAtLocal : issuedAtLocal;
  let validStart = issuedAtLocal;
  if (validStart === "") validStart = giftboxValidFrom;
  if (validStart === "") validStart = createdAtLocal;
  const validStartDate = validStart.slice(0, 10);

  // Scadenza: editabile se non annullata e non "riscattata" (anche parziale).
  const redeemedForExpiry = isRedeemed || redeemedUnits > 0;
  const expiryEditable = !isCancelled && !redeemedForExpiry;
  const today = todayIso();
  let expiryMinDate = today;
  if (validStartDate !== "" && validStartDate > expiryMinDate) expiryMinDate = validStartDate;
  let expiryModalValue = expiresDate;
  if (expiryModalValue === "" || expiryModalValue < expiryMinDate) expiryModalValue = expiryMinDate;

  // Disponibilità contenuti: alert + blocco riattivazione SOLO su Scaduta.
  let availability: GbAvailOut = { errors: [], warnings: [] };
  if (status === "expired") {
    availability = await giftBoxAvailabilityCheckInstance(slug, id).catch(() => ({ errors: [], warnings: [] }));
  }
  const expiryEditLocked = status === "expired" && availability.errors.length > 0;
  const expiryEditLockMessage = expiryEditLocked ? giftBoxReactivationBlockMessage(availability) : "";

  const recipientLock = gbRecipientLockInfo(status, expiresDate, redeemedUnits, activeApptLinks);

  // ------------------------------------------------------------------
  // MOVIMENTI (reali giftbox_transactions + virtuali legacy).
  // ------------------------------------------------------------------
  type Mov = { at: string; type: string; amount: number; serviceProduct: string; locationId: number; locationName: string; note: string; userId: number; userName: string; idx: number };
  const movs: Mov[] = [];
  let movIdx = 0;
  const push = (m: Omit<Mov, "idx">) => { movs.push({ ...m, idx: ++movIdx }); };

  const itemNameByGiftboxItem = new Map<number, string>();
  for (const it of items) itemNameByGiftboxItem.set(it.giftboxItemId, it.name);
  const labelFor = (gid: number): string => clean(itemNameByGiftboxItem.get(gid) ?? "") || "—";

  // 1) Emissione: nota = nota cliente (se presente e non annullata).
  const issueNote = !isCancelled && cleanNote !== "" ? cleanNote : "Emissione GiftBox";
  const issueAt = createdAtLocal !== "" ? createdAtLocal : (issuedAtLocal !== "" ? issuedAtLocal : localDateTime(new Date()));
  push({ at: issueAt, type: "issue", amount: totalUnits, serviceProduct: "—", locationId: Number(inst.location_id ?? 0), locationName: locationLabel, note: issueNote, userId: Number(inst.created_by ?? 0), userName: "" });

  // 2) Transazioni reali (adjust: cambio destinatario / modifica scadenza, ...).
  const txRows = await tenantSelect<RowDataPacket>({ slug, table: "giftbox_transactions", where: "instance_id = ?", params: [id], orderBy: "created_at DESC, id DESC", limit: 500 }).catch(() => [] as RowDataPacket[]);
  const realHistoryKeys = new Set<string>();
  for (const tx of txRows) {
    let txType = clean(tx.type) || "adjust";
    let txNote = clean(tx.note);
    let meta: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(String(tx.meta_json ?? "null"));
      if (parsed && typeof parsed === "object") meta = parsed as Record<string, unknown>;
    } catch { meta = {}; }
    const txApptId = Number(meta.appointment_id ?? 0);
    const txItemId = Number(meta.giftbox_item_id ?? 0);
    let txCode = clean(meta.appointment_code);
    if (txCode === "" && txNote !== "") {
      const m = /prenotazione\s+#\s*(.+)$/iu.exec(txNote);
      if (m) txCode = clean(m[1]).replace(/\s*\[.*$/u, "");
    }
    if (txCode === "" && txApptId > 0) txCode = String(txApptId);
    if (txApptId > 0 && txItemId > 0 && ["redeem", "cancel"].includes(txType)) {
      realHistoryKeys.add(`${txApptId}:${txItemId}`);
      if (txCode !== "") {
        txNote = txType === "redeem" ? `Riscatto su prenotazione #${txCode}` : `Annullato su prenotazione #${txCode}`;
      }
    }
    if (txType === "") txType = "adjust";
    push({
      at: localDateTime(tx.created_at),
      type: txType,
      amount: Math.trunc(Number(tx.amount ?? 0)),
      serviceProduct: txItemId > 0 ? labelFor(txItemId) : "—",
      locationId: Number(tx.location_id ?? 0),
      locationName: clean(tx.location_name),
      note: txNote,
      userId: Number(tx.created_by ?? 0),
      userName: "",
    });
  }
  for (const rx of redemptionRows) {
    const srcType = clean(rx.source_type).toLowerCase();
    const srcId = Number(rx.source_id ?? 0);
    if (srcType === "appointment" && srcId > 0) {
      for (const ri of redItemsByRedemption.get(Number(rx.id ?? 0)) ?? []) realHistoryKeys.add(`${srcId}:${ri.giftboxItemId}`);
    }
  }

  // 3) Prenotazioni collegate non riscattate: "In sospeso" (aperte) oppure
  //    coppia sospeso+annullato/no-show per quelle chiuse senza storico reale.
  for (const r of agiRows) {
    if (r.redeemed) continue;
    if (!["pending", "scheduled", "canceled", "no_show"].includes(r.statusCode)) continue;
    if (r.appointmentId <= 0 || r.giftboxItemId <= 0) continue;
    let pendingAt = r.apptCreatedAt;
    if (pendingAt === "") pendingAt = r.linkCreatedAt;
    if (pendingAt === "") pendingAt = r.startsAt;
    if (pendingAt === "") pendingAt = localDateTime(new Date());
    const svcProd = labelFor(r.giftboxItemId);
    if (["pending", "scheduled"].includes(r.statusCode)) {
      push({ at: pendingAt, type: "pending", amount: -r.qty, serviceProduct: svcProd, locationId: r.locationId, locationName: "", note: `In sospeso su prenotazione #${r.code}`, userId: 0, userName: "" });
      continue;
    }
    if (realHistoryKeys.has(`${r.appointmentId}:${r.giftboxItemId}`)) continue;
    let cancelAt = r.cancelledAt;
    if (cancelAt === "") cancelAt = r.startsAt;
    if (cancelAt === "") cancelAt = pendingAt;
    push({ at: pendingAt, type: "pending", amount: -r.qty, serviceProduct: svcProd, locationId: 0, locationName: "", note: `In sospeso su prenotazione #${r.code}`, userId: 0, userName: "" });
    push({
      at: cancelAt,
      type: "cancel",
      amount: Math.abs(r.qty),
      serviceProduct: svcProd,
      locationId: r.locationId,
      locationName: "",
      note: `${r.statusCode === "no_show" ? "No show su prenotazione #" : "Annullato su prenotazione #"}${r.code}`,
      userId: 0,
      userName: "",
    });
  }

  // 4) Storico riscatti (anche parziali).
  if (redemptionRows.length > 0) {
    const apptCodes = new Map<number, string>();
    const apptIds = [...new Set(redemptionRows.filter((r) => clean(r.source_type).toLowerCase() === "appointment").map((r) => Number(r.source_id ?? 0)).filter((n) => n > 0))];
    if (apptIds.length > 0) {
      const rows = await tenantSelect<RowDataPacket>({ slug, table: "appointments", columns: "id, public_code", where: `id IN (${apptIds.map(() => "?").join(",")})`, params: apptIds }).catch(() => [] as RowDataPacket[]);
      for (const r of rows) {
        const c = clean(r.public_code);
        if (c !== "") apptCodes.set(Number(r.id ?? 0), c);
      }
    }
    for (const rx of redemptionRows) {
      const at = localDateTime(rx.redeemed_at);
      if (at === "") continue;
      const rid = Number(rx.id ?? 0);
      const parts: string[] = [];
      let qtyTot = 0;
      for (const ri of redItemsByRedemption.get(rid) ?? []) {
        qtyTot += ri.qty;
        let lab = clean(itemNameByGiftboxItem.get(ri.giftboxItemId) ?? "");
        if (lab === "") lab = `Elemento #${ri.giftboxItemId}`;
        if (ri.qty > 1) lab += ` × ${ri.qty}`;
        parts.push(lab);
      }
      const svcProd = parts.length > 0 ? parts.join(", ") : "—";

      const rxNote = clean(rx.note);
      let rxCode = "";
      let m = /^\s*Riscatto\s+su\s+prenotazione\s+#\s*(.+)\s*$/iu.exec(rxNote);
      if (m) rxCode = clean(m[1]).replace(/\s*\[.*$/u, "");
      if (rxCode === "") {
        const srcType = clean(rx.source_type).toLowerCase();
        const srcId = Number(rx.source_id ?? 0);
        if (srcType === "appointment" && srcId > 0) rxCode = apptCodes.get(srcId) ?? "";
      }
      if (rxCode === "") {
        m = /\[appt_deleted:#([^\]]+)\]/u.exec(rxNote);
        if (m) {
          rxCode = clean(m[1]);
          if (rxCode !== "" && /^\d+$/.test(rxCode)) {
            const fromMap = apptCodes.get(Number(rxCode));
            if (fromMap) rxCode = fromMap;
          }
        }
      }
      const noteR = rxCode !== "" ? `Riscatto su prenotazione #${rxCode}` : (rxNote !== "" ? rxNote : "Riscatto GiftBox");
      push({
        at,
        type: "redeem",
        amount: -qtyTot,
        serviceProduct: svcProd,
        locationId: Number(rx.location_id ?? 0),
        locationName: clean(rx.location_name),
        note: noteR,
        userId: Number(rx.redeemed_by ?? 0),
        userName: "",
      });
    }
  } else if (status === "redeemed" && localDateTime(inst.redeemed_at) !== "") {
    // fallback legacy: riscatto completo senza dettaglio per-item.
    push({ at: localDateTime(inst.redeemed_at), type: "redeem", amount: -totalUnits, serviceProduct: "—", locationId: Number(inst.location_id ?? 0), locationName: locationLabel, note: "Riscatto GiftBox", userId: Number(inst.redeemed_by ?? 0), userName: "" });
  }

  // 5) Annullamento istanza (nota dalla vendita, poi dalla nota legacy).
  const cancelledAtLocal = localDateTime(inst.cancelled_at);
  if (status === "cancelled" && cancelledAtLocal !== "") {
    let cancelMovNote = "Annullamento GiftBox";
    if (saleCancelLine !== "") cancelMovNote = saleCancelLine;
    else if (noteCancelLine !== "") cancelMovNote = noteCancelLine;
    else cancelMovNote = `[ANNULLATA ${cancelledAtLocal}] Annullamento GiftBox`;
    push({ at: cancelledAtLocal, type: "cancel", amount: 0, serviceProduct: "—", locationId: 0, locationName: "", note: cancelMovNote, userId: Number(inst.cancelled_by ?? 0), userName: "" });
  }

  // 6) Scadenza.
  if (status === "expired") {
    const dt = localDateTime(inst.expires_at) !== "" ? localDateTime(inst.expires_at) : localDateTime(inst.updated_at);
    if (dt !== "") push({ at: dt, type: "expire", amount: 0, serviceProduct: "—", locationId: 0, locationName: "", note: "Scadenza GiftBox", userId: 0, userName: "" });
  }

  // Ordina dal più recente; a parità di data vince l'inserimento più tardo.
  movs.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    return b.idx - a.idx;
  });

  // Operatori + label sede per riga.
  const userIds = [...new Set(movs.map((m) => m.userId).filter((n) => n > 0))];
  const userNames = new Map<number, string>();
  if (userIds.length > 0) {
    const rows = await tenantSelect<RowDataPacket>({ slug, table: "users", columns: "id, name", where: `id IN (${userIds.map(() => "?").join(",")})`, params: userIds }).catch(() => [] as RowDataPacket[]);
    for (const r of rows) userNames.set(Number(r.id ?? 0), clean(r.name));
  }
  const movements: GiftBoxMovementRow[] = [];
  for (const m of movs) {
    let uname = clean(m.userName);
    if (uname === "") uname = m.userId > 0 ? (userNames.get(m.userId) ?? "—") : "—";
    const locLabel = await giftLocationLabel(slug, m.locationId, m.locationName);
    movements.push({
      at: m.at,
      atLabel: displayDmyHm(m.at) || "—",
      type: m.type,
      amount: m.amount,
      serviceProduct: clean(m.serviceProduct) || "—",
      locationLabel: locLabel !== "" ? locLabel : "—",
      note: clean(m.note) || "—",
      operatorName: uname !== "" ? uname : "—",
    });
  }

  const publicToken = await ensureVoucherToken(slug, "giftbox_instances", id, String(inst.voucher_public_token ?? ""));
  const eventKey = normalizeGiftBoxEventType(inst.event_type);

  return {
    id,
    code,
    publicToken,
    giftboxName,
    status,
    statusLabel: statusMeta.label,
    statusBadge: statusMeta.badge,
    eventKey,
    eventLabel: giftBoxEventLabel(eventKey),
    senderClientId,
    senderName: sender?.name ?? (senderClientId > 0 ? `Cliente #${senderClientId}` : "—"),
    recipientClientId,
    recipientName: clean(inst.recipient_name),
    recipientEmail: clean(inst.recipient_email),
    recipientClient: recipientClient ? { id: recipientClientId, ...recipientClient } : null,
    recipientLocked: recipientLock.locked,
    recipientLockMessage: recipientLock.locked && recipientLock.message === "" ? "Destinatario non modificabile." : recipientLock.message,
    locationLabel,
    voucherHideAmount: Number(inst.voucher_hide_amount ?? 0) === 1,
    note: cleanNote,
    giftMessage: clean(inst.gift_message),
    internalNote: clean(inst.internal_note),
    pointsCost: Number(inst.points_cost ?? 0) || 0,
    issuedAtLabel: issuedDisplaySource !== "" ? (displayDmy(issuedDisplaySource) || issuedDisplaySource) : "—",
    validStartLabel: validStart !== "" ? (displayDmy(validStart) || validStart) : "—",
    expiresLabel: expiresDate !== "" ? (displayDmy(expiresDate) || expiresDate) : "—",
    expiresDate,
    redeemedAtRaw: localDateTime(inst.redeemed_at),
    lastEmailSentAtRaw: localDateTime(inst.last_email_sent_at),
    lastEmailSentTo: clean(inst.last_email_sent_to),
    lastEmailShowDetails: Number(inst.last_email_hide_details ?? 0) !== 1,
    emailSendDisabled: ["cancelled", "expired"].includes(status),
    linkedSaleId,
    items,
    totalUnits,
    redeemedUnits,
    pendingUnits,
    availableUnits,
    partial,
    movements,
    canRedeem: status === "issued" && availableUnits > 0,
    expiryEditable,
    expiryMinDate,
    expiryModalValue,
    expiryMinBeyondToday: expiryMinDate > today,
    expiryEditLocked,
    expiryEditLockMessage,
    availabilityErrors: availability.errors,
    availabilityWarnings: availability.warnings,
  };
}

// Snapshot destinatario (GiftBox::recipientSnapshot/normalizeRecipientSnapshot).
type GbRecipientSnapshot = { recipient_name: string; recipient_email: string; recipient_client_id: number };
function gbNormalizeRecipientSnapshot(s: { recipient_name?: unknown; recipient_email?: unknown; recipient_client_id?: unknown }): GbRecipientSnapshot {
  let name = clean(s.recipient_name);
  if (name.length > 120) name = name.slice(0, 120);
  let email = clean(s.recipient_email);
  if (email.length > 190) email = email.slice(0, 190);
  email = email.toLowerCase();
  const clientId = Math.max(0, Math.trunc(Number(s.recipient_client_id ?? 0)) || 0);
  return { recipient_name: name, recipient_email: email, recipient_client_id: clientId };
}
function gbRecipientSnapshotLabel(sRaw: GbRecipientSnapshot): string {
  const s = gbNormalizeRecipientSnapshot(sRaw);
  let label = "";
  if (s.recipient_name !== "") label = s.recipient_name;
  if (s.recipient_email !== "") label += `${label !== "" ? " " : ""}(${s.recipient_email})`;
  if (s.recipient_client_id > 0) label += `${label !== "" ? " " : ""}[Cliente #${s.recipient_client_id}]`;
  if (label === "") label = "-";
  if (label.length > 120) label = `${label.slice(0, 117)}...`;
  return label;
}

async function gbInsertTransaction(slug: string, instanceId: number, type: string, amount: number, note: string, meta: Record<string, unknown> | null, by: number): Promise<void> {
  let noteTrimmed = note;
  if (noteTrimmed.length > 255) noteTrimmed = `${noteTrimmed.slice(0, 252)}...`;
  await tenantInsert(await tenantTable(slug, "giftbox_transactions"), {
    instance_id: instanceId,
    type,
    amount,
    note: noteTrimmed,
    meta_json: meta ? JSON.stringify(meta) : null,
    created_at: new Date(),
    created_by: by > 0 ? by : null,
  }).catch(() => 0);
}

// Nota movimento modifica scadenza (GiftBox::buildExpiryChangeNote).
function gbExpiryDateLabel(raw: string): string {
  const s = clean(raw);
  if (s === "") return "nessuna scadenza";
  return displayDmy(s.slice(0, 10)) || s.slice(0, 10);
}

// Aggiorna i "Dati GiftBox" (giftbox.php _mode=update_instance): mittente,
// evento, nascondi importo, destinatario (+cliente con lock server-side),
// nota, messaggio di dedica + movimento "Cambio destinatario".
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
  by = 0,
): Promise<{ ok: true; message: string }> {
  const inst = await giftBoxInstanceRow(slug, id);
  if (!inst) throw new Error("Istanza non trovata");

  const senderClientId = Math.max(0, Math.trunc(Number(input.senderClientId ?? 0)));
  if (senderClientId <= 0) throw new Error("Seleziona un cliente");
  const sender = await clientRow(slug, senderClientId);
  if (!sender) throw new Error("Seleziona un cliente");

  // Lock destinatario come il POST legacy: se bloccato, i campi restano quelli
  // correnti (lo snapshot NON viene toccato).
  const detail = await getGiftBoxInstanceFull(slug, id);
  const recipientLocked = detail?.recipientLocked ?? false;
  const before = gbNormalizeRecipientSnapshot({
    recipient_name: inst.recipient_name,
    recipient_email: inst.recipient_email,
    recipient_client_id: inst.recipient_client_id,
  });

  let recipientName = clean(input.recipientName);
  let recipientEmail = clean(input.recipientEmail);
  let recipientClientId = Math.max(0, Math.trunc(Number(input.recipientClientId ?? 0)));
  if (recipientLocked) {
    recipientName = before.recipient_name;
    recipientEmail = clean(inst.recipient_email);
    recipientClientId = before.recipient_client_id;
  } else if (recipientClientId > 0) {
    const c = await clientRow(slug, recipientClientId);
    if (!c) throw new Error("Cliente destinatario non trovato.");
    if (c.name !== "") recipientName = c.name;
    if (c.email !== "" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) recipientEmail = c.email;
  }
  if (recipientName.length > 120) recipientName = recipientName.slice(0, 120);
  if (recipientEmail.length > 190) recipientEmail = recipientEmail.slice(0, 190);

  let note = input.note !== undefined ? clean(input.note) : clean(inst.note);
  if (note.length > 255) note = note.slice(0, 255);
  let giftMessage = input.giftMessage !== undefined ? clean(input.giftMessage) : clean(inst.gift_message);
  if (giftMessage.length > 2000) giftMessage = giftMessage.slice(0, 2000);

  const values: Record<string, unknown> = {
    client_id: senderClientId,
    event_type: input.eventType !== undefined ? normalizeGiftBoxEventType(input.eventType) : normalizeGiftBoxEventType(inst.event_type),
    voucher_hide_amount: input.voucherHideAmount !== undefined ? (input.voucherHideAmount ? 1 : 0) : Number(inst.voucher_hide_amount ?? 0),
    recipient_client_id: recipientClientId > 0 ? recipientClientId : null,
    recipient_name: recipientName !== "" ? recipientName : null,
    recipient_email: recipientEmail !== "" ? recipientEmail : null,
    note: note !== "" ? note : null,
    gift_message: giftMessage !== "" ? giftMessage : null,
    updated_at: new Date(),
  };
  await tenantUpdate({ slug, table: "giftbox_instances", id, values });

  // Movimento "Cambio destinatario: X -> Y" (GiftBox::logRecipientChange).
  if (!recipientLocked) {
    const after = gbNormalizeRecipientSnapshot({ recipient_name: recipientName, recipient_email: recipientEmail, recipient_client_id: recipientClientId });
    const changed = before.recipient_name !== after.recipient_name || before.recipient_email !== after.recipient_email || before.recipient_client_id !== after.recipient_client_id;
    if (changed) {
      await gbInsertTransaction(
        slug, id, "adjust", 0,
        `Cambio destinatario: ${gbRecipientSnapshotLabel(before)} -> ${gbRecipientSnapshotLabel(after)}`,
        { action: "recipient_change", before, after },
        by,
      );
    }
  }
  return { ok: true, message: "Istanza aggiornata" };
}

// Modale "Modifica scadenza GiftBox" (giftbox.php _mode=update_instance_expiry
// / GiftBox::updateInstanceExpiry): guardie e messaggi verbatim, blocco
// riattivazione da disponibilità contenuti, movimento "Modifica scadenza".
export async function updateGiftBoxInstanceExpiry(slug: string, id: number, expiresAtRaw: string, by = 0): Promise<{ ok: true; message: string }> {
  const inst = await giftBoxInstanceRow(slug, id);
  if (!inst) throw new Error("Istanza non trovata");

  const rawDate = clean(expiresAtRaw);
  if (rawDate === "") throw new Error("Seleziona una nuova data di scadenza valida.");
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(rawDate);
  if (!m || Number.isNaN(Date.parse(m[1]))) throw new Error("Seleziona una nuova data di scadenza valida.");
  const next = m[1];
  const today = todayIso();
  if (next < today) throw new Error("La nuova data di scadenza non può essere precedente a oggi.");

  let st = clean(inst.status).toLowerCase();
  if (st === "canceled") st = "cancelled";
  if (st === "cancelled") throw new Error("Non è possibile modificare la scadenza di una GiftBox annullata.");

  // "Riscattata" anche parziale (GiftBox::isInstanceRedeemedForExpiry).
  let redeemedQty = 0;
  {
    const redRows = await tenantSelect<RowDataPacket>({ slug, table: "giftbox_redemptions", columns: "id", where: "instance_id = ?", params: [id] }).catch(() => [] as RowDataPacket[]);
    const rids = redRows.map((r) => Number(r.id ?? 0)).filter((n) => n > 0);
    if (rids.length > 0) {
      const items = await tenantSelect<RowDataPacket>({ slug, table: "giftbox_redemption_items", columns: "qty", where: `redemption_id IN (${rids.map(() => "?").join(",")})`, params: rids }).catch(() => [] as RowDataPacket[]);
      redeemedQty = items.reduce((s, r) => s + Math.max(0, Number(r.qty ?? 0)), 0);
    }
  }
  if (st === "redeemed" || redeemedQty > 0) throw new Error("Non e possibile modificare la scadenza di una GiftBox riscattata.");

  // Inizio validità: issued_at, poi valid_from del template, poi created_at.
  let validStart = localDate(inst.issued_at);
  if (validStart === "") {
    const gb = await tenantSelect<RowDataPacket>({ slug, table: "giftboxes", columns: "valid_from", where: "id = ?", params: [Number(inst.giftbox_id ?? 0)], limit: 1 }).catch(() => [] as RowDataPacket[]);
    validStart = localDate(gb[0]?.valid_from);
  }
  if (validStart === "") validStart = localDate(inst.created_at);
  if (validStart !== "" && next < validStart) throw new Error("La nuova data di scadenza non può essere precedente all'inizio validità della GiftBox.");

  // Riattivazione da Scaduta: bloccata se contenuti eliminati.
  const willReactivate = st === "expired";
  if (willReactivate) {
    const availability = await giftBoxAvailabilityCheckInstance(slug, id);
    if (availability.errors.length > 0) throw new Error(giftBoxReactivationBlockMessage(availability));
  }

  const oldExpires = localDateTime(inst.expires_at);
  const values: Record<string, unknown> = { expires_at: `${next} 23:59:59`, updated_at: new Date() };
  if (st === "expired") values.status = "issued";
  await tenantUpdate({ slug, table: "giftbox_instances", id, values });

  // Movimento (GiftBox::logExpiryChangeTransaction) se la data è cambiata.
  const oldYmd = oldExpires.slice(0, 10);
  if (oldYmd !== next) {
    const reactivated = willReactivate;
    let note = `Modifica scadenza GiftBox: ${gbExpiryDateLabel(oldExpires)} -> ${gbExpiryDateLabel(next)}`;
    if (reactivated) note += " (GiftBox riattivata)";
    await gbInsertTransaction(slug, id, "adjust", 0, note, {
      action: "expiry_change",
      old_expires_at: oldExpires !== "" ? oldExpires : null,
      new_expires_at: `${next} 23:59:59`,
      old_status: st,
      new_status: st === "expired" ? "issued" : st,
      reactivated,
    }, by);
  }
  return { ok: true, message: "Scadenza GiftBox aggiornata" };
}

// Riscatto PARZIALE per-item (giftbox.php _mode=redeem_instance_partial):
// qtyByRowId = { <giftbox_instance_items.id>: qty }. Registra una
// giftbox_redemptions + giftbox_redemption_items e marca 'redeemed' quando
// tutti gli elementi risultano utilizzati.
export async function redeemGiftBoxInstancePartial(
  slug: string,
  id: number,
  qtyByItemId: Record<number, number>,
  note: string,
  by: number,
  location: { id: number; name: string } | null,
): Promise<{ ok: true; message: string }> {
  if (id <= 0) throw new Error("Istanza non valida.");

  // Normalizza quantità richieste (chiavi = giftbox_item_id come il legacy).
  const toRedeem = new Map<number, number>();
  for (const [k, v] of Object.entries(qtyByItemId ?? {})) {
    const itId = Math.trunc(Number(k)) || 0;
    const qty = Math.trunc(Number(v)) || 0;
    if (itId <= 0 || qty <= 0) continue;
    toRedeem.set(itId, (toRedeem.get(itId) ?? 0) + qty);
  }
  if (toRedeem.size === 0) throw new Error("Seleziona almeno un elemento da riscattare.");

  const detail = await getGiftBoxInstanceFull(slug, id);
  if (!detail) throw new Error("GiftBox non trovata.");

  // Guardia pagina legacy (giftbox_page_validate_manual_redeem_request):
  // niente doppio riscatto sulle quantità già in sospeso su prenotazioni.
  for (const it of detail.items) {
    const req = toRedeem.get(it.giftboxItemId) ?? 0;
    if (req <= 0) continue;
    if (req > it.availableUnits) {
      let msg = `Quantità non disponibile per "${it.name}".`;
      if (it.pendingUnits > 0) msg += ` ${it.pendingUnits} già in sospeso su prenotazioni.`;
      throw new Error(msg);
    }
  }

  const inst = await giftBoxInstanceRow(slug, id);
  if (!inst) throw new Error("Istanza non trovata");
  const st = clean(inst.status).toLowerCase();
  if (!["issued", "active"].includes(st)) throw new Error("Istanza non riscattabile");

  // Validità "dal" (issued_at) e scadenza (GiftBox::redeemInstanceItems).
  const issuedAt = localDateTime(inst.issued_at);
  if (issuedAt !== "" && issuedAt > localDateTime(new Date())) throw new Error("GiftBox non ancora valida");
  const expires = localDateTime(inst.expires_at);
  if (expires !== "" && expires < localDateTime(new Date())) {
    await tenantUpdate({ slug, table: "giftbox_instances", id, values: { status: "expired", updated_at: new Date() } }).catch(() => 0);
    throw new Error("GiftBox scaduta");
  }

  if (detail.items.length === 0) throw new Error("GiftBox senza contenuti: impossibile riscattare.");
  const itemById = new Map(detail.items.map((it) => [it.giftboxItemId, it]));
  for (const [itId, qReq] of toRedeem) {
    const it = itemById.get(itId);
    if (!it) throw new Error(`Elemento non valido (id=${itId}).`);
    const rem = Math.max(0, it.qty - it.redeemedUnits);
    if (qReq > rem) throw new Error(`Quantità non disponibile per un elemento selezionato (id=${itId}).`);
  }

  // Sede: quella corrente; per gli item servizio deve essere abilitata; per i
  // prodotti scala lo stock della sede (applyProductStockForRedemption).
  const locationId = location && location.id > 0 ? location.id : 0;
  const rawRows = await gbInstanceItemRows(slug, id, Number(inst.giftbox_id ?? 0));
  const rawById = new Map(rawRows.map((r) => [Number(r.giftbox_item_id ?? 0), r]));
  if (locationId > 0) {
    for (const [itId] of toRedeem) {
      const raw = rawById.get(itId);
      const serviceId = Number(raw?.service_id ?? 0);
      if (serviceId <= 0) continue;
      const anyRows = await tenantSelect<RowDataPacket>({ slug, table: "service_locations", columns: "location_id", where: "service_id = ?", params: [serviceId], limit: 1 }).catch(() => [] as RowDataPacket[]);
      if (anyRows.length === 0) continue;
      const allowed = await tenantSelect<RowDataPacket>({ slug, table: "service_locations", columns: "location_id", where: "service_id = ? AND location_id = ?", params: [serviceId, locationId], limit: 1 }).catch(() => [] as RowDataPacket[]);
      if (allowed.length === 0) throw new Error("Servizio GiftBox non disponibile nella sede selezionata.");
    }
    for (const [itId, qReq] of toRedeem) {
      const raw = rawById.get(itId);
      if (clean(raw?.item_type).toLowerCase() !== "product") continue;
      const productId = Number(raw?.product_id ?? 0);
      if (productId <= 0) continue;
      const label = itemById.get(itId)?.name ?? `Prodotto #${productId}`;
      // app_product_location_enabled: senza righe stock vale ovunque.
      const anyStock = await tenantSelect<RowDataPacket>({ slug, table: "product_stocks", columns: "location_id", where: "product_id = ?", params: [productId], limit: 1 }).catch(() => [] as RowDataPacket[]);
      if (anyStock.length > 0) {
        const enabled = await tenantSelect<RowDataPacket>({ slug, table: "product_stocks", columns: "location_id", where: "product_id = ? AND location_id = ? AND COALESCE(is_enabled,1) = 1", params: [productId, locationId], limit: 1 }).catch(() => [] as RowDataPacket[]);
        if (enabled.length === 0) throw new Error(`Prodotto non abbinato alla sede selezionata: ${label}.`);
        const psT = await tenantTable(slug, "product_stocks");
        const scoped = psT.mode === "shared" && (await columnExists(psT.name, "tenant_id"));
        const res = await dbExecute(
          `UPDATE \`${psT.name}\` SET stock = stock - ? WHERE product_id = ? AND location_id = ? AND stock >= ?${scoped ? " AND tenant_id = ?" : ""}`,
          scoped ? [qReq, productId, locationId, qReq, psT.tenantId ?? 0] : [qReq, productId, locationId, qReq],
        ).catch(() => ({ affectedRows: 0 }));
        if (Number((res as { affectedRows?: number }).affectedRows ?? 0) <= 0) {
          throw new Error(`Stock insufficiente per il prodotto "${label}" nella sede selezionata.`);
        }
      } else {
        const pT = await tenantTable(slug, "products");
        const scoped = pT.mode === "shared" && (await columnExists(pT.name, "tenant_id"));
        const res = await dbExecute(
          `UPDATE \`${pT.name}\` SET stock = stock - ? WHERE id = ? AND stock >= ?${scoped ? " AND tenant_id = ?" : ""}`,
          scoped ? [qReq, productId, qReq, pT.tenantId ?? 0] : [qReq, productId, qReq],
        ).catch(() => ({ affectedRows: 0 }));
        if (Number((res as { affectedRows?: number }).affectedRows ?? 0) <= 0) {
          throw new Error(`Stock insufficiente per il prodotto "${label}" nella sede selezionata.`);
        }
      }
    }
  }

  let redeemNote = clean(note);
  if (redeemNote.length > 255) redeemNote = redeemNote.slice(0, 255);

  const now = new Date();
  const redemptionId = await tenantInsert(await tenantTable(slug, "giftbox_redemptions"), {
    instance_id: id,
    redeemed_at: now,
    redeemed_by: by > 0 ? by : null,
    source_type: "manual",
    source_id: null,
    note: redeemNote || null,
    location_id: locationId > 0 ? locationId : null,
    location_name: location ? clean(location.name) || null : null,
    created_at: now,
  });
  const itemTable = await tenantTable(slug, "giftbox_redemption_items");
  for (const [itId, qReq] of toRedeem) {
    await tenantInsert(itemTable, { redemption_id: redemptionId, giftbox_item_id: itId, qty: qReq }).catch(() => 0);
  }

  // Riscattata quando TUTTI gli elementi risultano utilizzati.
  let allDone = true;
  for (const it of detail.items) {
    const used = it.redeemedUnits + (toRedeem.get(it.giftboxItemId) ?? 0);
    if (used < it.qty) { allDone = false; break; }
  }
  if (allDone) {
    await tenantUpdate({ slug, table: "giftbox_instances", id, values: { status: "redeemed", redeemed_at: now, redeemed_by: by > 0 ? by : null, redeemed_source_type: "manual", redeemed_source_id: null, updated_at: now } });
  } else {
    await tenantUpdate({ slug, table: "giftbox_instances", id, values: { updated_at: now } }).catch(() => 0);
  }
  return { ok: true, message: allDone ? "GiftBox riscattata completamente" : "Riscatto registrato (parziale)" };
}

export async function updateGiftBoxInstanceInternalNote(slug: string, id: number, noteRaw: string): Promise<{ ok: true; message: string }> {
  const inst = await giftBoxInstanceRow(slug, id);
  if (!inst) throw new Error("Istanza non trovata");
  await tenantUpdate({ slug, table: "giftbox_instances", id, values: { internal_note: clean(noteRaw) || null, updated_at: new Date() } });
  return { ok: true, message: "Nota interna salvata" };
}

// "Invio email al destinatario" (GiftBox::sendGiftBoxEmail): guardie e corpo
// email verbatim (hero evento, Dettagli GiftBox, Contenuto, Codice di
// riscatto, Vedi Voucher, Condizioni con default legacy).
export async function sendGiftBoxInstanceEmail(slug: string, id: number, toRaw: string, showDetails: boolean, giftMessageRaw: string): Promise<{ ok: true; message: string }> {
  if (id <= 0) throw new Error("Istanza non valida.");

  // normEmail legacy (FILTER_VALIDATE_EMAIL semplificato).
  let to = clean(toRaw);
  if (to.length > 190) to = to.slice(0, 190);
  if (to === "" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error("Email destinatario non valida.");
  if (!emailConfigured()) throw new Error("Invio email non disponibile (mail_send_html mancante).");

  const inst = await giftBoxInstanceRow(slug, id);
  if (!inst) throw new Error("GiftBox non trovata.");
  const detail = await getGiftBoxInstanceFull(slug, id);
  if (!detail) throw new Error("GiftBox non trovata.");

  const st = clean(inst.status).toLowerCase();
  if (!["issued", "active"].includes(st)) throw new Error("GiftBox non inviabile: stato non valido.");
  const expires = localDateTime(inst.expires_at);
  if (expires !== "" && expires < localDateTime(new Date())) {
    await tenantUpdate({ slug, table: "giftbox_instances", id, values: { status: "expired", updated_at: new Date() } }).catch(() => 0);
    throw new Error("GiftBox scaduta: email non inviata.");
  }

  let giftMessage = clean(giftMessageRaw) !== "" ? clean(giftMessageRaw) : detail.giftMessage;
  if (giftMessage.length > 2000) giftMessage = giftMessage.slice(0, 2000);

  // Nome GiftBox: i template tecnici POS non vanno mostrati.
  let giftboxName = detail.giftboxName !== "" ? detail.giftboxName : "GiftBox";
  if (/^POS\s*•\s*GiftBox/i.test(giftboxName) || /\bCliente\s+\d+\b/i.test(giftboxName)) giftboxName = "GiftBox";

  const ev = GIFTBOX_EVENT_MAP.find((e) => e.key === detail.eventKey) ?? GIFTBOX_EVENT_MAP[0];
  const bizRows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "name, email, giftbox_terms", orderBy: "id ASC", limit: 1 }).catch(() => [] as RowDataPacket[]);
  const biz = bizRows[0] ?? null;
  const bizName = clean(biz?.name) || "BeautySuite";

  let subject = ev.subject;
  if (detail.code !== "") subject += ` ${detail.code}`;
  subject += ` - ${bizName}`;
  if (subject.length > 160) subject = subject.slice(0, 160);

  const h = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  const fmtDate = (dt: string) => {
    const s = clean(dt);
    if (s === "") return "—";
    return displayDmy(s.slice(0, 10)) || s;
  };
  const validFrom = fmtDate(localDateTime(inst.issued_at));
  const validTo = expires !== "" ? fmtDate(expires) : "—";

  let itemsHtml = "";
  if (showDetails) {
    if (detail.items.length > 0) {
      itemsHtml += '<ul style="margin:8px 0 0 18px; padding:0;">';
      for (const it of detail.items) {
        itemsHtml += `<li>${h(it.name)}${it.qty > 1 ? ` × ${it.qty}` : ""}</li>`;
      }
      itemsHtml += "</ul>";
    } else {
      itemsHtml = '<div style="color:#666;">(Nessun elemento)</div>';
    }
  } else {
    itemsHtml = '<div style="color:#666;">(Contenuto non mostrato. Per scoprirlo, mostra il codice in cassa.)</div>';
  }

  const base = String(process.env.PRENODO_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  const evImgAbs = base !== "" ? `${base}${ev.image}` : "";
  const voucherUrl = base !== "" ? `${base}/${slug}/giftbox_voucher?public=1&embed=1&token=${encodeURIComponent(detail.publicToken)}` : "";

  const recipientName = detail.recipientName;
  const clientName = clean(detail.senderName) !== "—" ? detail.senderName : "";
  const fromLine = clientName !== ""
    ? `Hai ricevuto una GiftBox acquistata da <strong>${h(clientName)}</strong>.`
    : "Hai ricevuto una GiftBox.";

  // Condizioni: setting giftbox_terms, righe di default legacy se vuoto.
  const termsRaw = clean(biz?.giftbox_terms).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  let termsLines: string[];
  if (termsRaw === "") {
    termsLines = [
      "Voucher utilizzabile in più appuntamenti fino ad esaurimento del contenuto.",
      "Ad ogni utilizzo verranno scalati i singoli servizi/prodotti (riscatto parziale).",
      "Non convertibile in denaro e non rimborsabile.",
      "Presentare il codice (QR) o il codice alfanumerico in cassa per il riscatto.",
    ];
  } else {
    termsLines = termsRaw.split(/\n+/);
  }
  let termsHtml = '<div style="border-top:1px solid #e5e7eb;padding-top:12px;margin-top:6px">';
  termsHtml += '<div style="font-weight:800;margin:0 0 8px 0">Condizioni</div>';
  termsHtml += '<ul style="margin:0 0 0 18px;padding:0;color:#374151">';
  for (let ln of termsLines) {
    ln = clean(ln).replace(/^[-•\t\s]+/u, "");
    if (ln === "") continue;
    ln = ln.replace(/\{BUSINESS_NAME\}|\{\{BUSINESS_NAME\}\}|%BUSINESS_NAME%/g, bizName);
    termsHtml += `<li>${h(ln)}</li>`;
  }
  termsHtml += "</ul></div>";

  let greet = "Ciao";
  if (recipientName !== "") greet += ` ${recipientName}`;
  greet += "!";

  const evHead = clean(`${ev.emoji} ${ev.title}`);
  let html = "";
  html += `<p style="margin:0 0 10px 0">${h(greet)}</p>`;
  html += '<div style="border:1px solid #e5e7eb; border-radius:14px; overflow:hidden; margin:0 0 14px 0;">'
    + `<div style="padding:12px 14px; background:#0f766e; color:#fff; font-weight:600; font-size:16px;">${h(evHead)}</div>`
    + (evImgAbs !== "" ? `<img src="${h(evImgAbs)}" alt="${h(ev.label)}" style="width:100%; height:auto; display:block;">` : "")
    + "</div>";
  html += `<p style="margin:0 0 12px 0">${fromLine}</p>`;
  if (giftMessage !== "") {
    html += '<div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;margin:0 0 16px 0;background:#ffffff">';
    html += '<div style="font-weight:800;margin-bottom:6px">Messaggio di dedica</div>';
    html += `<div style="white-space:pre-wrap">${h(giftMessage)}</div>`;
    html += "</div>";
  }
  const owner = clientName !== "" ? clientName : "—";
  const recipient = recipientName !== "" ? recipientName : to;
  const row = (label: string, value: string): string =>
    `<tr><td style="padding:6px 0;color:#6b7280;font-size:12px">${h(label)}</td><td align="right" style="padding:6px 0;font-weight:600">${h(value)}</td></tr>`;
  html += '<div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;margin:0 0 16px 0;background:#ffffff">';
  html += '<div style="font-weight:800;margin:0 0 8px 0">Dettagli GiftBox</div>';
  html += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">';
  html += row("GiftBox", giftboxName);
  html += row("Mittente", owner);
  html += row("Destinatario", recipient);
  html += row("Valida dal", validFrom);
  html += row("Valida fino al", validTo);
  html += "</table></div>";
  html += '<div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px;margin:0 0 16px 0;background:#ffffff">';
  html += '<div style="font-weight:800;margin:0 0 8px 0">Contenuto GiftBox</div>';
  html += itemsHtml;
  html += "</div>";
  html += '<div style="border:1px solid #e5e7eb;border-radius:14px;padding:14px 16px;margin:0 0 12px 0;background:#ffffff">';
  html += '<div style="color:#6b7280;font-size:12px">Codice di riscatto</div>';
  html += `<div style="font-size:28px;font-weight:600;letter-spacing:1px;margin-top:2px">${h(detail.code || "—")}</div>`;
  html += '<div style="color:#6b7280;font-size:12px;margin-top:6px">MOSTRA QUESTO CODICE IN CASSA</div>';
  html += "</div>";
  if (voucherUrl !== "") {
    html += '<div style="text-align:center;margin:0 0 18px 0;">'
      + `<a href="${h(voucherUrl)}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:12px;font-weight:600;letter-spacing:.2px">Vedi Voucher</a>`
      + "</div>";
  }
  html += termsHtml;
  html += `<p style="margin:14px 0 0 0;color:#666;font-size:12px">Messaggio automatico da ${h(bizName)}.</p>`;

  const tpl = buildModernEmailTemplate(subject, html, { business_name: bizName, business_email: clean(biz?.email) });
  const result = await sendEmail({ to, subject, html: tpl.html, text: tpl.text, fromName: bizName, replyTo: clean(biz?.email) || undefined });
  if (!result.ok) throw new Error("Invio email fallito.");

  await tenantUpdate({
    slug, table: "giftbox_instances", id,
    values: {
      last_email_sent_at: new Date(),
      last_email_sent_to: to,
      last_email_hide_details: showDetails ? 0 : 1,
      gift_message: giftMessage !== "" ? giftMessage : null,
      email_send_claimed_at: null,
      updated_at: new Date(),
    },
  }).catch(() => 0);
  return { ok: true, message: `Email inviata a ${to}` };
}

// ---- LISTA istanze (GiftBox::listInstances + colonne pagina) ------------------
export type GiftBoxManageListRow = {
  id: number;
  code: string;
  senderName: string;
  recipientLabel: string;
  locationLabel: string;
  status: string;
  statusLabel: string;
  statusBadge: string;
  issuedDate: string;
  expiresDate: string;
  redeemedDate: string;
};

export async function listGiftBoxInstancesManage(
  slug: string,
  filters: { q?: string; status?: string; clientId?: number; locationId?: number } = {},
  limit = 200,
): Promise<GiftBoxManageListRow[]> {
  const giT = await tenantTable(slug, "giftbox_instances");
  const gbT = await tenantTable(slug, "giftboxes");
  const cT = await tenantTable(slug, "clients");
  const lT = await tenantTable(slug, "locations");
  const scoped = giT.mode === "shared" && (await columnExists(giT.name, "tenant_id"));

  const where: string[] = ["gb.deleted_at IS NULL"];
  const params: unknown[] = [];
  if (scoped) { where.push("gi.tenant_id = ?"); params.push(giT.tenantId ?? 0); }
  const q = clean(filters.q);
  if (q !== "") {
    where.push("(gi.code ILIKE ? OR gi.recipient_name ILIKE ? OR gi.recipient_email ILIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const status = clean(filters.status).toLowerCase();
  if (status !== "" && ["issued", "redeemed", "cancelled", "expired"].includes(status)) {
    where.push("gi.status = ?");
    params.push(status);
  }
  const clientId = Math.max(0, Math.trunc(Number(filters.clientId ?? 0)));
  if (clientId > 0) { where.push("gi.client_id = ?"); params.push(clientId); }
  const locationId = Math.max(0, Math.trunc(Number(filters.locationId ?? 0)));
  if (locationId > 0) { where.push("gi.location_id = ?"); params.push(locationId); }

  const lim = Math.max(1, Math.min(500, Math.trunc(limit) || 200));
  const rows = await dbQuery<RowDataPacket[]>(
    `SELECT gi.*, gb.name AS giftbox_name, c.full_name AS client_name,
            COALESCE(NULLIF(gi.location_name,''), l.name) AS location_display_name
       FROM \`${giT.name}\` gi
       JOIN \`${gbT.name}\` gb ON gb.id = gi.giftbox_id${scoped ? " AND gb.tenant_id = gi.tenant_id" : ""}
       LEFT JOIN \`${cT.name}\` c ON c.id = gi.client_id${scoped ? " AND c.tenant_id = gi.tenant_id" : ""}
       LEFT JOIN \`${lT.name}\` l ON l.id = gi.location_id${scoped ? " AND l.tenant_id = gi.tenant_id" : ""}
      WHERE ${where.join(" AND ")}
      ORDER BY gi.id DESC
      LIMIT ${lim}`,
    params,
  ).catch(() => [] as RowDataPacket[]);

  const out: GiftBoxManageListRow[] = [];
  for (const r of rows) {
    const meta = giftBoxStatusMeta(String(r.status ?? ""));
    const rec = clean(r.recipient_name);
    const recE = clean(r.recipient_email);
    let issued = localDate(r.created_at);
    if (issued === "") issued = localDate(r.issued_at);
    out.push({
      id: Number(r.id ?? 0),
      code: clean(r.code),
      senderName: clean(r.client_name) || "—",
      recipientLabel: rec !== "" ? rec : recE !== "" ? recE : "—",
      locationLabel: await giftLocationLabel(slug, Number(r.location_id ?? 0), clean(r.location_display_name)),
      status: meta.code,
      statusLabel: meta.label,
      statusBadge: meta.badge,
      issuedDate: issued !== "" ? issued : "—",
      expiresDate: localDate(r.expires_at) || "—",
      redeemedDate: localDate(r.redeemed_at) || "—",
    });
  }
  return out;
}

// hasAnyGiftboxInstances (empty state legacy: nessuna istanza in assoluto,
// solo su template non eliminati).
export async function hasAnyGiftBoxInstances(slug: string): Promise<boolean> {
  const rows = await listGiftBoxInstancesManage(slug, {}, 1);
  return rows.length > 0;
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
