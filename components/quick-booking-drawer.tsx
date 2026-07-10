"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

// Faithful port of the GLOBAL "Nuova prenotazione" quick-booking offcanvas drawer
// from the legacy PHP gestionale (app/lib/View.php lines ~1094-1620: the
// `#quickBooking` `offcanvas offcanvas-end` + the `#qbClientCreateModal`). The
// markup is reproduced VERBATIM as JSX — same classes/ids/structure — so the
// existing qb-* / .qb-multiselect / .qb-ms-* styles in /assets/css/app.css
// (already loaded by manage-shell.tsx) make it look identical to the legacy.
//
// Opening: ANY [data-qb-new] click (the topbar "+ Prenotazione" button carries
// data-qb-new="1") opens THIS offcanvas IN PLACE via
// bootstrap.Offcanvas.getOrCreateInstance(#quickBooking).show() — no navigation.
//
// Wired CORE flow (port of assets/js/app.js):
//   - data-qb-new open -> reset form, default date = today, default start time
//     rounded to the next 5-min step, open offcanvas.
//   - SERVICES multiselect (#qb_ms_*): open/close dropdown, search filter by
//     data-name, location filter by data-location-ids, pills add/remove on
//     checkbox toggle, total-duration -> auto end time (syncEnd).
//   - CLIENT find (#qbLinkFindClient) and new (#qbLinkNewClient): the find UI
//     searches /api/manage/clients?q=, the new UI posts /api/manage/clients
//     action=create; the chosen/created client fills #qbSelectedClientBox and
//     #qb_client_id.
//   - Availability ([Disponibilita]) -> POST /api/manage/appointments
//     action=hold_availability; fills start/end + hold token.
//   - Submit ("Crea prenotazione") -> POST /api/manage/appointments action=save.
//
// MULTI-SERVICE: submit now sends ALL selected services (service_ids +
// service_names, ordered) so the save route persists them as sequential
// segments (each with the chosen operator/cabin). The per-service staff AND
// cabin PICKER UI (#qbMultiStaffPicker) is wired: #qb_staff_map / #qb_cabin_map
// are filled as {serviceId: id} JSON when 2+ services are selected (cleared
// otherwise), so each segment gets its own operator + cabin; for a single
// service the single operator + #qb_cabin_id select drive the booking.
// TODO(cabin availability): the legacy lists only the FREE cabins after an
// availability check (refreshCabinsForServices); no such engine is ported, so
// the cabin lists here fall back to the cabins at the selected location.
//
// CLIENT HISTORY + RESIDUALS: when a client is selected, #qbClientHistoryBox and
// #qbClientResidualsBox are populated from the new
// /api/manage/clients?action=quickbook_client_context endpoint (port of the
// legacy api_clients.php action=history + action=residuals summaries). The
// history line and the soft residual badges reproduce the legacy display
// verbatim; a req-id guard discards stale responses (qbHistoryReqId pattern).
//
// TODO (deep wiring left out, matches the SCOPE note): the redeem flows
// (giftbox/gift/package/prepaid/giftcard), the client card popup
// (the residuals-detail "Apri scheda" popup is now ported — see
// openResidualsDetail + #qbClientResidualsModal),
// the per-service staff/cabin picker + the multi-service summary, the
// price-details / coupon / fidelity / discount block, hold countdown/renewal,
// and edit/delete of an existing appointment. Their markup is present but the
// deep logic depends on many sub-APIs that do not yet exist in the Next manage app.

type QbCategory = { id: number; name: string };
type QbService = {
  id: number;
  name: string;
  categoryId: number | null;
  duration: number;
  price: number;
  noOperator: boolean;
  locationIds: number[];
};
type QbStaff = { id: number; name: string; serviceIds: number[]; active: boolean };
type QbLocation = { id: number; name: string };
type QbCabin = { id: number; name: string; locationId: number | null };

type QbContext = {
  ok?: boolean;
  currentLocationId?: number;
  categories?: QbCategory[];
  services?: QbService[];
  staff?: QbStaff[];
  locations?: QbLocation[];
  cabins?: QbCabin[];
};

type QbClient = { id: string; full_name: string; email: string; phone: string };

// EDIT-mode payload (GET /api/manage/appointments?action=get) used to PREFILL the
// drawer for an existing appointment. Mirrors getDbAppointmentForEdit in
// lib/db-repositories.ts: client (id+name/email/phone), location, ordered services,
// per-service operator/cabin maps (serviceId -> id), the explicit primary cabin,
// date/time, php-normalized status, notes and the booking code (public_code).
type AppointmentEditPayload = {
  id: number;
  publicCode: string | null;
  clientId: number;
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  locationId: number | null;
  // Item D: each line carries its BOOKED per-service price (appointment_services.price) so the
  // price panel restores the price as booked, not the current catalog price (which may have
  // changed since). `price` is optional for backward-compat (older payloads omitted it).
  services: Array<{ serviceId: number; name: string; price?: number }>;
  staffMap: Record<number, number>;
  cabinMap: Record<number, number>;
  primaryCabinId: number | null;
  date: string;
  time: string;
  status: string;
  staffNotes: string;
  customerNotes: string;
  // Persisted manual sconto (discount_type/discount_value) to prefill the price panel.
  discountType?: string;
  discountValue?: number;
  // Block 4: the persisted price-panel deductions, to prefill on edit. fidelityPointsUsed =
  // the reserved points; creditUsed = the spent credit; coupon = the code+discount read back
  // from notes (or null when none).
  fidelityPointsUsed?: number;
  creditUsed?: number;
  coupon?: { code: string; discount: number } | null;
  // Item 3: warning when the edited appointment links a now-EXPIRED redeem source
  // (package/prepaid/giftbox/gift/giftcard). "" / absent when nothing is expired.
  expiredLinkWarning?: string;
  // Cancellation metadata for the locked-mode alert (#qbCancellationAlert): the
  // cancelled_at datetime + the operator's reason (with the notes fallback server-side).
  cancelledAt?: string;
  cancelledReason?: string;
  // REDEEM esistenti della prenotazione (port del get legacy che restituisce
  // giftbox/package/prepaid/gift/giftcard_redeem) — il drawer li prefilla in edit.
  packageRedeem?: Array<{ client_package_id: number; service_id: number; client_package_service_id: number | null }>;
  prepaidServiceRedeem?: Array<{ client_prepaid_service_id: number; service_id: number }>;
  giftboxRedeem?: Array<{ instance_id: number; giftbox_item_id: number; service_id: number }>;
  giftRedeem?: Array<{ service_id: number; instance_id: number; reward_item_index: number }>;
  giftcardRedeem?: Array<{ giftcard_id: number; amount: number }>;
  // Booster opzioni: le istanze consumate da QUESTA prenotazione (assenti dai
  // residui correnti del cliente) da fondere nelle liste opzioni.
  redeemBoost?: {
    packages?: QbClientPackage[];
    prepaids?: QbClientPrepaid[];
    giftboxes?: QbClientGiftbox[];
    gifts?: QbClientGift[];
    giftcards?: QbClientGiftcard[];
  };
};

// Minimal Bootstrap offcanvas/modal surface used here (the bundle is loaded by
// manage-shell.tsx). Degrades to a no-op when bootstrap is not yet present.
type BootstrapInstance = { show: () => void; hide: () => void };
type BootstrapApi = { getOrCreateInstance: (el: Element) => BootstrapInstance };
function bootstrap(): { Offcanvas?: BootstrapApi; Modal?: BootstrapApi } | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { bootstrap?: { Offcanvas?: BootstrapApi; Modal?: BootstrapApi } }).bootstrap ?? null;
}

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// Shape of the cancel_done_preview payload (mirrors CancelDonePreview in db-repositories).
// Only the fields the modal renders are typed here.
type DoneCancelPreview = {
  ok: boolean;
  error: string;
  status: string;
  targetStatus: "canceled" | "no_show";
  summary: string[];
  warnings: string[];
  blockers: string[];
  points: { used: number; earned: number };
  restores: { credit: number; giftcard: number };
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Round "now" up to the next 5-minute step, like app.js's default start time.
function nextStepTime(): string {
  const d = new Date();
  let min = d.getHours() * 60 + d.getMinutes();
  min = Math.ceil(min / 5) * 5;
  if (min >= 24 * 60) min = 24 * 60 - 5;
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

function timeToMin(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(value || "");
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function minToTime(min: number): string {
  const clamped = Math.max(0, Math.min(min, 24 * 60 - 1));
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
}

// Helper data PURI del modale disponibilità (scope di modulo: identità stabile,
// niente dipendenze fantasma nelle useCallback che li usano).
function fmtDMY(ymd: string): string {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ymd;
}
function addDaysYMD(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function startOfWeekYMD(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00`);
  if (Number.isNaN(d.getTime())) return ymd;
  return addDaysYMD(ymd, -((d.getDay() + 6) % 7)); // Monday start (legacy)
}
function firstOfMonthYMD(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}
function addMonthsYMD(ymd: string, months: number): string {
  const d = new Date(`${firstOfMonthYMD(ymd)}T00:00:00`);
  d.setMonth(d.getMonth() + months);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

// Item C: normalize + map an appointment status to a Bootstrap badge (port of
// qbNormStatus, app.js 4933-4943: sinonimi italiani inclusi — 'in attesa' sì
// ma NON 'attesa'/'in sospeso', bug-fedele al client legacy). Same colour
// classes (warning/primary/success/secondary/dark) + Italian labels.
function normalizeApptStatus(status: string): string {
  const s = lower(status);
  if (s === "cancelled" || s === "annullato" || s === "annullata") return "canceled";
  if (s === "rejected" || s === "rifiutato" || s === "rifiutata") return "canceled";
  if (s === "no show" || s === "no-show" || s === "noshow" || s === "non presentato" || s === "non presentata") return "no_show";
  if (s === "eseguito" || s === "executed") return "done";
  if (s === "prenotato") return "scheduled";
  if (s === "in attesa") return "pending";
  return s;
}
function badgeForStatus(status: string): { cls: string; label: string } {
  switch (normalizeApptStatus(status)) {
    case "pending":
      return { cls: "warning", label: "In attesa" };
    case "scheduled":
      return { cls: "primary", label: "Prenotato" };
    case "done":
      return { cls: "success", label: "Eseguito" };
    case "canceled":
      return { cls: "secondary", label: "Annullato" };
    case "no_show":
      return { cls: "dark", label: "No show" };
    default:
      return { cls: "secondary", label: status || "—" };
  }
}

// EUR formatting, faithful to app.js fmtEUR ("€ 1.234,56", it-IT).
// "GG/MM/AAAA HH:MM" from a SQL datetime (legacy qbFmtDateTime).
function fmtQbDateTime(value: string | null | undefined): string {
  const m = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`;
  const d = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return d ? `${d[3]}/${d[2]}/${d[1]}` : String(value ?? "");
}

function fmtEUR(value: number): string {
  const num = Number(value || 0);
  try {
    return "€ " + num.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return "€ " + (Math.round(num * 100) / 100).toFixed(2).replace(".", ",");
  }
}

// Toast globale: window.notify è il port fedele del notify() legacy (montato da
// manage-shell su #appToastContainer). Il legacy usa i toast per TUTTI gli esiti
// del quick booking (validazioni warning, errori danger, esiti success) — non
// alert inline. No-op silenzioso se il portale non è ancora montato.
function qbNotify(message: string, variant: "success" | "danger" | "warning" | "info" = "info"): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as { notify?: (m: string, v?: string) => void };
  if (typeof w.notify === "function") w.notify(message, variant);
}

// Refresh in-place dopo save/delete (port di window.calendar.refetchEvents(): il
// legacy NON ricarica la pagina). Il calendario ascolta questo evento e ricarica
// i propri dati; sulle altre pagine — come nel legacy — non succede nulla.
function qbRefetchCalendar(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("qb:appointments-changed"));
}

// ---- MODALE RESIDUI interattiva: costanti messaggi legacy (app.js 2845-3236) ----
type ResidualKind = "package" | "prepaid" | "giftbox" | "gift";
const RESIDUAL_CHECK_FIELD: Record<ResidualKind, string> = {
  package: "package_redeem",
  prepaid: "prepaid_service_redeem",
  giftbox: "giftbox_redeem",
  gift: "gift_redeem",
};
const RESIDUAL_CHECK_COLLECTION: Record<ResidualKind, string> = {
  package: "packages",
  prepaid: "services",
  giftbox: "giftboxes",
  gift: "gifts",
};
const RESIDUAL_CONFLICT_DEFAULT: Record<ResidualKind, string> = {
  package: "Questa seduta del pacchetto è già presente in un'altra prenotazione.",
  prepaid: "Questo servizio prepagato è già presente in un'altra prenotazione.",
  giftbox: "Questo residuo GiftBox è già presente in un'altra prenotazione.",
  gift: "Questo servizio omaggio è già presente in un'altra prenotazione.",
};
const RESIDUAL_TOAST: Record<ResidualKind, { linked: string; added: string }> = {
  package: { linked: "Seduta pacchetto collegata: ", added: "Servizio aggiunto dal pacchetto: " },
  prepaid: { linked: "Servizio prepagato collegato: ", added: "Servizio aggiunto dai residui: " },
  giftbox: { linked: "Residuo GiftBox collegato: ", added: "Servizio aggiunto dalla GiftBox: " },
  gift: { linked: "omaggio collegato: ", added: "Servizio aggiunto da omaggio: " },
};

// Fonde le istanze "booster" (i residui consumati dalla prenotazione in EDIT,
// assenti dalle liste residui correnti del cliente) nelle liste opzioni, senza
// duplicare le voci già presenti.
function qbMergeBoost<T>(base: T[], extra: T[] | undefined | null, key: (item: T) => string): T[] {
  if (!extra || extra.length === 0) return base;
  const seen = new Set(base.map(key));
  const out = [...base];
  for (const item of extra) {
    const k = key(item);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(item);
    }
  }
  return out;
}

// SQL date/datetime -> "dd/mm/yyyy hh:mm" (it-IT), port of app.js
// fmtDateTimeFromSql (local-time parse to avoid timezone shifts).
function fmtDateTimeFromSql(value: string): string {
  const s = String(value || "").trim();
  if (!s) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  let d: Date;
  if (m) {
    d = new Date(
      Number(m[1]),
      Math.max(0, Number(m[2]) - 1),
      Number(m[3]),
      m[4] !== undefined ? Number(m[4]) : 0,
      m[5] !== undefined ? Number(m[5]) : 0,
      m[6] !== undefined ? Number(m[6]) : 0,
    );
  } else {
    d = new Date(s.includes("T") ? s : s.replace(" ", "T"));
  }
  if (!(d instanceof Date) || String(d) === "Invalid Date") return s;
  try {
    return d.toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return s;
  }
}

// SQL date (YYYY-MM-DD) -> "dd/mm/yyyy", port of qbRenderClientResiduals' fmtYMD
// (app.js ~991). Empty / unparseable -> "—" (the residuals detail expiry display).
function fmtYMD(value: string | null | undefined): string {
  const s = String(value ?? "").trim();
  if (!s) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

// Quick-booking client-context payload (port of api_clients.php history +
// residuals summaries; see /api/manage/clients?action=quickbook_client_context).
type QbHistorySummary = { total?: number; last_visit?: string | null; next_visit?: string | null; sales_total?: number };
type QbResidualsSummary = {
  services_count?: number;
  gifts_count?: number;
  giftboxes_count?: number;
  giftcards_count?: number;
  packages_count?: number;
  credit_count?: number;
  credit_available?: number;
};
// One available (redeemable) package for the per-service "Usa pacchetto" control
// (port of api_clients.php action=residuals package block; returned by
// quickbook_client_context). `service_ids` are the services this package COVERS;
// `serviceItemIds` maps covered service_id -> its client_package_services.id (the
// client_package_service_id used to pin the redeem), absent for legacy packages.
type QbClientPackage = {
  id: number;
  name: string;
  sessions_remaining: number;
  expires_at?: string | null;
  service_ids: number[];
  serviceItemIds?: Record<number, number>;
};
// One available (redeemable) prepaid-service balance for the per-service "Usa
// prepagato" control (port of api_clients.php action=residuals prepaid block;
// returned by quickbook_client_context). A prepaid is tied to ONE service directly
// (`service_id`), so it covers exactly that one service; `remaining_qty` is the
// consumable balance.
type QbClientPrepaid = {
  id: number;
  service_id: number;
  name: string;
  remaining_qty: number;
};
// One available (redeemable) GiftCard for the APPOINTMENT-LEVEL "GiftCard" control
// (port of api_clients.php action=residuals giftcard block; returned by
// quickbook_client_context). A GiftCard is MONETARY (a spendable `balance`, not a
// per-service unit) and applies to the WHOLE appointment — one per appointment, an
// amount. `balance` is the consumable monetary balance.
type QbClientGiftcard = {
  id: number;
  code: string;
  balance: number;
};
// One available (redeemable) GiftBox ITEM for the per-service "Usa GiftBox" control
// (returned by quickbook_client_context). GiftBox is per-service + ITEM-based (like a
// package): each entry covers exactly its `service_id`, consuming one unit of that item.
// `instance_id` + `giftbox_item_id` pin the redeem; `name` is the item/service label.
type QbClientGiftbox = {
  instance_id: number;
  giftbox_item_id: number;
  service_id: number;
  name: string;
};
// One available (redeemable) GIFT (omaggio) SERVICE REWARD for the per-service "Usa Omaggio"
// control (returned by quickbook_client_context). A gift instance holds reward items; each
// entry covers exactly its `service_id`, consuming one unit of that reward. `instance_id` +
// `reward_item_index` (the reward's array index in reward_items_json) pin the redeem; `name`
// is the service label.
type QbClientGift = {
  instance_id: number;
  reward_item_index: number;
  service_id: number;
  name: string;
};
// Block 4: fidelity redeem settings + the client's available points (from
// quickbook_client_context). Drives #qbFidelityBox: the points-use input is bounded by
// [0, min(pointsAvailable, floor(remainingTotal/euroPerPoint))] respecting minPoints, and the
// € discount = pointsUsed x euroPerPoint. Only offered when redeemEnabled.
type QbClientFidelity = {
  redeemEnabled?: boolean;
  euroPerPoint?: number;
  minPoints?: number;
  pointsAvailable?: number;
};

type QbClientContextResponse = {
  ok?: boolean;
  summary?: QbHistorySummary;
  residuals?: QbResidualsSummary;
  packages?: QbClientPackage[];
  prepaids?: QbClientPrepaid[];
  giftcards?: QbClientGiftcard[];
  giftboxes?: QbClientGiftbox[];
  gifts?: QbClientGift[];
  // Block 4: fidelity redeem settings + the client's points; the client's spendable credit.
  fidelity?: QbClientFidelity;
  creditAvailable?: number;
};

// Read-only residuals DETAIL (for the "Apri scheda" #qbClientResidualsModal). Shape
// of /api/manage/clients?action=residuals (quickBookClientResidualsDetail): the five
// sections + a credit line, each with per-item display detail. DISPLAY-ONLY — no
// redeem controls (the drawer form does the inline redeem SELECTION).
type QbResidualServiceDetail = {
  id: number;
  service_id: number;
  service_name: string;
  remaining_qty: number;
  purchased_qty: number;
  unit_price: number;
  sale_id: number | null;
  expires_at: string | null;
};
type QbResidualGiftDetail = {
  instance_id: number;
  reward_item_index: number;
  service_id: number;
  gift_name: string;
  service_name: string;
  qty_remaining: number;
  qty_total: number;
  expires_at: string | null;
};
type QbResidualGiftboxItem = { giftbox_item_id: number; service_id: number; service_name: string; qty_remaining: number; qty_total: number };
type QbResidualGiftboxDetail = {
  instance_id: number;
  giftbox_name: string;
  code: string;
  remaining_qty: number;
  total_qty: number;
  expires_at: string | null;
  items: QbResidualGiftboxItem[];
};
type QbResidualGiftcardDetail = { id: number; code: string; balance: number; expires_at: string | null };
type QbResidualPackageItem = { service_id: number; service_name: string; sessions_remaining: number; sessions_total: number };
type QbResidualPackageDetail = {
  id: number;
  package_name: string;
  sessions_remaining: number;
  sessions_total: number;
  expires_at: string | null;
  sale_id: number | null;
  breakdown: string;
  items: QbResidualPackageItem[];
};
type QbResidualsDetail = {
  services: QbResidualServiceDetail[];
  gifts: QbResidualGiftDetail[];
  giftboxes: QbResidualGiftboxDetail[];
  giftcards: QbResidualGiftcardDetail[];
  packages: QbResidualPackageDetail[];
  credit: { available: number; count: number };
};
type QbResidualsDetailResponse = { ok?: boolean; error?: string } & Partial<QbResidualsDetail>;

// One entry written to #qb_package_redeem (assets/js/app.js qbReadPackageRedeem):
// a per-service request to cover that service with the client's prepaid package.
type QbPackageRedeem = { client_package_id: number; service_id: number; client_package_service_id: number | null };

// One entry written to #qb_prepaid_service_redeem (assets/js/app.js
// qbReadPrepaidServiceRedeem): a per-service request to cover that service with the
// client's prepaid-service balance.
type QbPrepaidRedeem = { client_prepaid_service_id: number; service_id: number };

// The single entry written to #qb_giftcard_redeem (assets/js/app.js): an
// APPOINTMENT-LEVEL request to apply a giftcard BALANCE (a monetary amount) toward the
// whole appointment (NOT per-service). One giftcard, one amount.
type QbGiftcardRedeem = { giftcard_id: number; amount: number };

// One entry written to #qb_giftbox_redeem (assets/js/app.js): a per-service request to
// cover that service with ONE ITEM from the client's giftbox (instance_id +
// giftbox_item_id pin the item; the service is zero-charged on save).
type QbGiftboxRedeem = { instance_id: number; giftbox_item_id: number; service_id: number };

// One entry written to #qb_gift_redeem (assets/js/app.js): a per-service request to cover
// that service with ONE REWARD from the client's gift (instance_id + reward_item_index pin
// the reward; the service is zero-charged on save).
type QbGiftRedeem = { service_id: number; instance_id: number; reward_item_index: number };

// History summary line, EXACT port of qbLoadClientHistory: "Appuntamenti: N •
// Ultimo: … • Prossimo: …" (+ " • Vendite: €…" when sales_total > 0).
function buildHistoryLine(summary: QbHistorySummary): string {
  const total = Number(summary.total || 0);
  const last = summary.last_visit ? fmtDateTimeFromSql(String(summary.last_visit)) : "—";
  const next = summary.next_visit ? fmtDateTimeFromSql(String(summary.next_visit)) : "—";
  const parts = [`Appuntamenti: ${total}`, `Ultimo: ${last}`, `Prossimo: ${next}`];
  const salesTot = Number(summary.sales_total || 0);
  if (Number.isFinite(salesTot) && salesTot > 0) parts.push(`Vendite: ${fmtEUR(salesTot)}`);
  return parts.join(" • ");
}

// Residuals soft badges, EXACT port of qbLoadClientResiduals: "Servizi (n)",
// "Omaggi (n)", "GiftBox (n)", "GiftCard (n)", "Pacchetti (n)", "Credito (€…)".
type QbResidualBadge = { key: string; label: string };
function buildResidualBadges(residuals: QbResidualsSummary): QbResidualBadge[] {
  const ps = Number(residuals.services_count ?? 0);
  const og = Number(residuals.gifts_count ?? 0);
  const gb = Number(residuals.giftboxes_count ?? 0);
  const gc = Number(residuals.giftcards_count ?? 0);
  const pk = Number(residuals.packages_count ?? 0);
  const cr = Number(residuals.credit_count ?? 0);
  const crAvail = Number(residuals.credit_available ?? 0);
  const badges: QbResidualBadge[] = [];
  if (ps > 0) badges.push({ key: "services", label: `Servizi (${ps})` });
  if (og > 0) badges.push({ key: "gifts", label: `Omaggi (${og})` });
  if (gb > 0) badges.push({ key: "giftboxes", label: `GiftBox (${gb})` });
  if (gc > 0) badges.push({ key: "giftcards", label: `GiftCard (${gc})` });
  if (pk > 0) badges.push({ key: "packages", label: `Pacchetti (${pk})` });
  if (cr > 0) badges.push({ key: "credit", label: `Credito (${fmtEUR(crAvail)})` });
  return badges;
}

export function QuickBookingDrawer() {
  const slug = useMemo(() => tenantSlug(), []);

  // ---- Context data (services grouped by category, staff, locations, cabins) ----
  const [ctx, setCtx] = useState<QbContext>({});
  const ctxLoadedRef = useRef(false);

  // ---- Selected client (#qb_client_id + #qbSelectedClientBox) ----
  const [client, setClient] = useState<QbClient | null>(null);

  // ---- Client HISTORY + RESIDUALS panels (#qbClientHistoryBox / #qbClientResidualsBox) ----
  // Populated when a client is selected, from the new
  // /api/manage/clients?action=quickbook_client_context endpoint (port of the
  // legacy api_clients.php action=history + action=residuals summaries). A
  // monotonically increasing req-id guards against stale responses, matching the
  // legacy qbHistoryReqId / qbResidualsReqId pattern. `null` while loading/errored.
  const [historySummary, setHistorySummary] = useState<QbHistorySummary | null>(null);
  const [historyError, setHistoryError] = useState<string>("");
  const [residualsSummary, setResidualsSummary] = useState<QbResidualsSummary | null>(null);
  const [residualsError, setResidualsError] = useState<string>("");
  const [contextLoading, setContextLoading] = useState(false);
  const contextReqRef = useRef(0);

  // ---- "Apri scheda" residuals DETAIL modal (#qbClientResidualsModal) ----
  // The read-only detail view of the selected client's residuals (five sections +
  // a Credito line), fetched from /api/manage/clients?action=residuals on open.
  // `residualsDetail` holds the fetched payload (null while loading / on error);
  // `residualsDetailLoading` shows the spinner; `residualsDetailError` the error line.
  // A monotonic req-id discards stale responses (legacy qbClientResidualsReqId).
  // The inline redeem SELECTION stays on the drawer form — this is DISPLAY-ONLY.
  const [residualsDetail, setResidualsDetail] = useState<QbResidualsDetail | null>(null);
  const [residualsDetailLoading, setResidualsDetailLoading] = useState(false);
  const [residualsDetailError, setResidualsDetailError] = useState<string>("");
  const residualsDetailReqRef = useRef(0);

  // ---- PACKAGE redeem (#qb_package_redeem) ----
  // The selected client's AVAILABLE packages (covering >=1 service, with sessions
  // left), and the per-service redeem selection the staff applies in the drawer.
  // `packageRedeems` is keyed by service_id (one package covers a service at most
  // once); it is serialized to #qb_package_redeem and sent on save. Both are
  // cleared on client change (clearClientContext) and pruned on service change.
  const [clientPackages, setClientPackages] = useState<QbClientPackage[]>([]);
  const [packageRedeems, setPackageRedeems] = useState<Record<number, QbPackageRedeem>>({});

  // ---- PREPAID-SERVICE redeem (#qb_prepaid_service_redeem) ----
  // The selected client's AVAILABLE prepaid-service balances (each tied to ONE
  // service, with remaining_qty left), and the per-service redeem selection the staff
  // applies in the drawer. `prepaidRedeems` is keyed by service_id (one prepaid
  // covers a service at most once); it is serialized to #qb_prepaid_service_redeem
  // and sent on save. Both are cleared on client change and pruned on service change.
  // A service already covered by a PACKAGE redeem hides its prepaid control (one
  // service is covered once; the server also dedupes).
  const [clientPrepaids, setClientPrepaids] = useState<QbClientPrepaid[]>([]);
  const [prepaidRedeems, setPrepaidRedeems] = useState<Record<number, QbPrepaidRedeem>>({});

  // ---- GIFTCARD redeem (#qb_giftcard_redeem) ----
  // The selected client's AVAILABLE giftcards (active, not expired, balance > 0), and
  // the APPOINTMENT-LEVEL redeem the staff applies in the drawer. Unlike package/
  // prepaid (per-service), a giftcard is MONETARY and covers the WHOLE appointment:
  // ONE giftcard + an AMOUNT. `giftcardPick` is the chosen giftcard id (or null), and
  // `giftcardAmountInput` is the raw amount text the staff may lower (clamped on
  // serialize). Both are cleared on client change and pruned when the pick is no longer
  // available. The amount DEFAULTS to min(balance, payable total) on selection.
  const [clientGiftcards, setClientGiftcards] = useState<QbClientGiftcard[]>([]);
  const [giftcardPick, setGiftcardPick] = useState<number | null>(null);
  const [giftcardAmountInput, setGiftcardAmountInput] = useState<string>("");

  // ---- Manual SCONTO (#qb_discount_type / #qb_discount_value) ----
  // The staff's manual discount, faithful to app.js renderPriceDetails: `discountType` is
  // "" (none) | "percent" | "fixed"; `discountValue` is the raw text the staff types
  // (parsed/clamped in the priceDetails recompute). Both controlled so editing recomputes
  // the panel live. Reset by resetForm; prefilled on edit from the persisted columns.
  const [discountType, setDiscountType] = useState<string>("");
  const [discountValue, setDiscountValue] = useState<string>("");

  // ---- Item D: BOOKED per-service prices (port of qbApplyServiceSnapshotLine ~6466) ----
  // On edit, the price panel recomputes each line from the CURRENT catalog price. To show the
  // prices AS BOOKED (which diverge only when a service price changed since booking), this maps
  // serviceId -> the booked price snapshot (appointment_services.price) from the action=get
  // payload. The recompute prefers this over the catalog price for lines that were part of the
  // original booking; a service ADDED during the edit has no entry and uses its current price.
  // Reset by resetForm / on a new open; populated only from the edit-load payload.
  const [bookedPriceByService, setBookedPriceByService] = useState<Record<number, number>>({});

  // ---- PROMOZIONE automatica (port of app.js qbPromo / action=promotion_preview) ----
  // The legacy drawer auto-detects the best applicable promotion for the selected
  // services + client + slot and shows the discounted prices in the price panel
  // (struck list price + booked price + "-10%"/"-€ x" badge). serviceId -> the
  // promo line from action=promotion_preview; the save re-evaluates SERVER-SIDE
  // (never trusting this preview). A monotonic req-id discards stale responses;
  // a cache key skips refetching for an unchanged context (legacy qbPromoKey).
  const [promoByService, setPromoByService] = useState<Record<number, { list: number; booked: number; badge: string }>>({});
  const promoReqRef = useRef(0);
  const promoKeyRef = useRef<string>("");

  // ---- COUPON (#qbCouponToggle / #qbCouponBox / #qb_coupon_code / #qb_coupon_discount) ----
  // Port of app.js qbApplyCouponPreview + the coupon Apply/Remove buttons. `couponBoxOpen`
  // reveals #qbCouponBox; `couponInput` is the text the staff types; `couponCode` +
  // `couponDiscount` mirror the hidden inputs (#qb_coupon_code / #qb_coupon_discount) that
  // SAVE posts; `couponMsg` is the #qbCouponMsg feedback ({text, ok}); `couponApplying`
  // disables the buttons during the preview fetch. A monotonic req-id discards stale
  // responses (legacy qbCouponReqId). All reset by resetForm.
  const [couponBoxOpen, setCouponBoxOpen] = useState(false);
  const [couponInput, setCouponInput] = useState<string>("");
  const [couponCode, setCouponCode] = useState<string>("");
  const [couponDiscount, setCouponDiscount] = useState<number>(0);
  const [couponMsg, setCouponMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [couponApplying, setCouponApplying] = useState(false);
  const couponReqRef = useRef(0);
  // The payable-service signature the currently applied coupon was validated against, so the
  // revalidation effect (port of qbRevalidateCouponIfNeeded) only re-runs the preview when the
  // service selection ACTUALLY changes — never on every render (guards against a re-render loop).
  const couponValidatedSigRef = useRef<string>("");

  // ---- FIDELITY points use (#qbFidelityBox / #qb_fidelity_points_use) — Block 4 ----
  // The client's redeem context (from quickbook_client_context): whether redeem is enabled,
  // euro-per-point, the minimum redeemable, and the client's available points. `fidelityInput`
  // is the raw points text the staff types (parsed/clamped in the recompute -> the € discount
  // = pointsUsed x euroPerPoint feeds the Totale + #qb_fidelity_points_use on save). Reset by
  // resetForm; the settings are loaded on client select (cleared on client change).
  const [fidelityRedeemEnabled, setFidelityRedeemEnabled] = useState(false);
  const [fidelityEuroPerPoint, setFidelityEuroPerPoint] = useState<number>(0.1);
  const [fidelityMinPoints, setFidelityMinPoints] = useState<number>(0);
  const [fidelityPointsAvailable, setFidelityPointsAvailable] = useState<number>(0);
  const [fidelityInput, setFidelityInput] = useState<string>("");
  // Item E: the "Usa sconto Punti Fidelity" toggle (#qbFidelityToggle / View.php:1433). When OFF
  // (the default) the points input is collapsed and NO fidelity discount is applied, regardless
  // of a stale points figure; turning it ON reveals the input. Reset OFF by resetForm / on client
  // change; turned ON automatically on edit when the loaded appointment already used points.
  // TODO(fidelity choice): the legacy also has the advanced "Scelta cliente" radios
  // (qbApplyFidelityChoice — discount vs GIFT-reward vs redeem-later, gated by the business
  // conflict_policy='choice') + the separate gift-points-use field. That fidelity-gift redeem is
  // an advanced feature and is intentionally NOT ported here — only the simple on/off toggle is.
  const [fidelityUseOn, setFidelityUseOn] = useState<boolean>(false);

  // ---- CREDIT use (#qbCreditRow / #qb_credit_use) — Block 4 ----
  // The client's spendable credit balance (clients.credit_balance) + the raw amount text the
  // staff types (parsed/clamped [0, min(clientCredit, remainingTotal)] in the recompute -> the
  // Totale drops + #qb_credit_use on save). A minimal inline input (the full residuals-modal
  // port is out of scope — see the TODO on the credit control). Reset by resetForm.
  const [clientCredit, setClientCredit] = useState<number>(0);
  const [creditInput, setCreditInput] = useState<string>("");

  // ---- GIFTBOX redeem (#qb_giftbox_redeem) ----
  // The selected client's AVAILABLE giftbox ITEMS (issued, not expired, residual unit
  // left), and the per-service redeem selection the staff applies in the drawer. GiftBox
  // is per-service + ITEM-based (like a package): one item covers one service.
  // `giftboxRedeems` is keyed by service_id (one item covers a service at most once); it
  // is serialized to #qb_giftbox_redeem (a JSON STRING) and sent on save. Both are cleared
  // on client change and pruned on service change. A service already covered by a PACKAGE
  // or PREPAID redeem hides its giftbox control (one service is covered once; the server
  // also dedupes).
  const [clientGiftboxes, setClientGiftboxes] = useState<QbClientGiftbox[]>([]);
  const [giftboxRedeems, setGiftboxRedeems] = useState<Record<number, QbGiftboxRedeem>>({});

  // ---- GIFT (omaggio) redeem (#qb_gift_redeem) ----
  // The selected client's AVAILABLE gift SERVICE REWARDS (available instance, residual reward
  // left), and the per-service redeem selection the staff applies in the drawer. A gift is
  // per-service + REWARD-based (like a giftbox item): one reward covers one service.
  // `giftRedeems` is keyed by service_id (one reward covers a service at most once); it is
  // serialized to #qb_gift_redeem (a JSON STRING) and sent on save. Both are cleared on client
  // change and pruned on service change. A service already covered by a PACKAGE, PREPAID or
  // GIFTBOX redeem hides its gift control (one service is covered once; the server also dedupes).
  const [clientGifts, setClientGifts] = useState<QbClientGift[]>([]);
  const [giftRedeems, setGiftRedeems] = useState<Record<number, QbGiftRedeem>>({});

  // ---- Services multiselect state ----
  const [selectedServiceIds, setSelectedServiceIds] = useState<number[]>([]);
  const [msOpen, setMsOpen] = useState(false);
  const [serviceSearch, setServiceSearch] = useState("");

  // ---- Per-service operator assignment (multi-service #qbMultiStaffPicker) ----
  // Explicit user picks only (serviceId -> staffId string). The EFFECTIVE map
  // shown in the picker / written to #qb_staff_map is DERIVED from these picks
  // plus eligibility + auto-select (see staffMap memo below), so there is no
  // effect reconciling state-from-state (avoids cascading-render setState, like
  // the rest of this file). Only meaningful when 2+ services are selected.
  const [staffPicks, setStaffPicks] = useState<Record<number, string>>({});

  // ---- Per-service cabin assignment (multi-service #qb_cabin_map) ----
  // Explicit user picks only (serviceId -> cabinId string). The EFFECTIVE map
  // written to #qb_cabin_map is DERIVED from these picks plus the cabins
  // available at the chosen location + auto-select (see cabinMap memo below),
  // mirroring the operator picker so there is no effect reconciling
  // state-from-state. Only meaningful when 2+ services are selected.
  const [cabinPicks, setCabinPicks] = useState<Record<number, string>>({});

  // ---- Date / time / location / cabin / status / notes ----
  const [date, setDate] = useState<string>(() => todayIso());
  const [startTime, setStartTime] = useState<string>("");
  // Explicit END time prefilled from a calendar DRAG-SELECT (data-qb-endtime, HH:MM).
  // "" = no override -> the end is DERIVED from the selected services' total duration
  // (the normal behavior). When set and no service has yet been chosen, it seeds the
  // visible end / ends_at so the dragged DURATION is honored. It is cleared on reset,
  // once any service is selected (services then drive the end), and when the start time
  // is edited (so a stale fixed end can't outlive the start that defined it).
  const [prefillEndTime, setPrefillEndTime] = useState<string>("");
  const [locationId, setLocationId] = useState<string>("");
  const [cabinId, setCabinId] = useState<string>("");
  const [status, setStatus] = useState<string>("scheduled");
  // The appointment's status AS LOADDED in edit mode (php code). The status <select>
  // mutates `status` freely; on save we compare against this to detect a status
  // TRANSITION and route it: a normal transition -> action=status, but a DONE
  // appointment moved to canceled/no_show -> the dedicated action=cancel_done flow
  // (action=status BLOCKS done->canceled/no_show). Empty -> a CREATE (no transition).
  const [originalStatus, setOriginalStatus] = useState<string>("");
  const [staffId, setStaffId] = useState<string>("");
  const [staffNotes, setStaffNotes] = useState<string>("");
  const [customerNotes, setCustomerNotes] = useState<string>("");
  const [holdToken, setHoldToken] = useState<string>("");
  // Item 3: the expired-linked warning shown in #qbExpiredLinkedAlert (from action=get).
  const [expiredLinkWarning, setExpiredLinkWarning] = useState<string>("");
  // Cancellation metadata (from action=get) for the locked-mode alert
  // (#qbCancellationAlert, port of qbRenderCancellationAlert).
  const [cancelledAt, setCancelledAt] = useState<string>("");
  const [cancelledReason, setCancelledReason] = useState<string>("");
  // Item 4: the edit-load lifecycle. `editLoading` drives #qbLoadingState (spinner) around
  // the action=get fetch; `editLoadError` (already present) drives #qbLoadErrorState. Both
  // block the form while set. A separate #qbLoadErrorState (with a working Riprova button)
  // replaces the ad-hoc header alert for edit-load failures.
  const [editLoading, setEditLoading] = useState<boolean>(false);

  // ---- CANCEL-DONE PREVIEW MODAL (#qbDoneCancelModal) ----
  // The rich preview-lock flow replacing the bare window.confirm on a done->canceled/
  // no_show transition (port of app.js qbOpenDoneCancelPreview / qbBuildDoneCancelPreviewHtml
  // / qbSubmitDoneCancel). Before applying, we fetch action=cancel_done_preview and show a
  // Bootstrap modal (branched title, "Riepilogo:" list, warnings, a reason textarea, and a
  // Confirm disabled when the preview has an error/blockers). The save() flow AWAITS the
  // operator's decision via a pending-resolver promise: Confirm resolves { confirmed, reason },
  // Cancel/close resolves null (abort — status stays Eseguito, no reload).
  const [doneCancelTarget, setDoneCancelTarget] = useState<"canceled" | "no_show">("canceled");
  const [doneCancelPreview, setDoneCancelPreview] = useState<DoneCancelPreview | null>(null);
  const [doneCancelLoading, setDoneCancelLoading] = useState(false);
  const [doneCancelError, setDoneCancelError] = useState<string>("");
  const [doneCancelReason, setDoneCancelReason] = useState<string>("");
  // Resolver for the in-flight save() awaiting the operator's modal decision. Set when the
  // modal opens; called with { confirmed, reason } on Confirm or null on abort, then cleared.
  const doneCancelResolveRef = useRef<((v: { reason: string } | null) => void) | null>(null);

  // ---- EDIT MODE (#qb_appt_id + header title + #qbBookingCodeRow/#qbBookingCode) ----
  // When a [data-qb-edit] click loads an existing appointment, `apptId` carries its
  // id (sent as `id` on save so the route routes to updateDbAppointment) and
  // `bookingCode` the public_code shown in the header. Both are reset on drawer close
  // / [data-qb-new] open (resetForm), so the next create is clean. A monotonic
  // req-id guards against a stale edit-load response (the user re-opening quickly).
  const [apptId, setApptId] = useState<string>("");
  const [bookingCode, setBookingCode] = useState<string>("");
  const [editLoadError, setEditLoadError] = useState<string>("");
  const editReqRef = useRef(0);
  // Item 4: the last edit-load id, so #qbLoadErrorState's "Riprova" button can retry
  // (port of qbLastOpenEditArgs). Empty -> the retry button hides.
  const lastEditIdRef = useRef<string>("");

  // ---- Find-client modal state ----
  const [findQuery, setFindQuery] = useState("");
  const [findResults, setFindResults] = useState<QbClient[]>([]);
  const findTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- New-client modal state ----
  const [createError, setCreateError] = useState("");
  const [createSaving, setCreateSaving] = useState(false);
  const createFormRef = useRef<HTMLFormElement | null>(null);

  // ---- Submit / availability feedback ----
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [availLoading, setAvailLoading] = useState(false);

  // Memoized derived context arrays (stable references for the hooks below).
  const services = useMemo(() => ctx.services ?? [], [ctx.services]);
  const categories = useMemo(() => ctx.categories ?? [], [ctx.categories]);
  const staff = useMemo(() => (ctx.staff ?? []).filter((s) => s.name.trim().toUpperCase() !== "SSO"), [ctx.staff]);
  const locations = useMemo(() => ctx.locations ?? [], [ctx.locations]);
  const cabins = useMemo(() => ctx.cabins ?? [], [ctx.cabins]);

  // Load the quick-booking context once (lazily, the first time the drawer is
  // opened) from the manage GET. Tenant-scoped via slug query + header. While the
  // FIRST load is in flight on a NEW booking, the drawer shows the legacy loading
  // panel with "Preparo nuova prenotazione..." (app.js:9910) — masterLoading
  // drives that state (nome distinto dal contextLoading dello storico cliente).
  const [masterLoading, setMasterLoading] = useState(false);
  const loadContext = useCallback(() => {
    if (ctxLoadedRef.current || !slug) return;
    ctxLoadedRef.current = true;
    setMasterLoading(true);
    const params = new URLSearchParams({ slug, action: "context" });
    fetch(`/api/manage/appointments?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: QbContext) => {
        setCtx(j ?? {});
        if (j?.currentLocationId && j.currentLocationId > 0) setLocationId(String(j.currentLocationId));
      })
      .catch(() => {
        ctxLoadedRef.current = false; // allow a retry on next open
        setCtx({});
      })
      .finally(() => setMasterLoading(false));
  }, [slug]);

  // Item 1: release an availability hold on the server (port of qbReleaseAvailabilityHold,
  // app.js ~3404-3421). Best-effort, fire-and-forget: POSTs {action:"release_hold", token}
  // with keepalive:true so it survives a drawer close / page unload; never blocks the UI and
  // swallows errors. No-op on an empty token. Called right BEFORE every place a non-empty
  // held token is dropped (close/reset, operator/cabin/location/service/date/time change) and
  // on pagehide/beforeunload, so an abandoned technical hold is freed instead of lingering.
  const releaseHold = useCallback(
    (token: string) => {
      const tok = String(token || "").trim();
      if (!tok || typeof fetch === "undefined") return;
      try {
        void fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          keepalive: true,
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({ action: "release_hold", token: tok }),
        }).catch(() => undefined);
      } catch {
        // best-effort: a failed release just lets the technical hold expire on its own.
      }
    },
    [slug],
  );

  // Latest held token, kept in a ref so the pagehide/beforeunload listeners (bound once)
  // always release the CURRENT hold without re-binding, and dropAndReleaseHold can read it
  // without threading the token through every setter.
  const holdTokenRef = useRef<string>("");
  // Scadenza CLIENT-side dell'hold (port di qbHoldIsExpired): il backend usa
  // TTL 300s; il timestamp si rinfresca alla creazione e a ogni renew riuscito.
  const HOLD_TTL_MS = 300_000;
  const holdExpiresRef = useRef<number>(0);
  // Booster redeem per l'EDIT: le istanze residuo consumate dalla prenotazione in
  // modifica (dal payload action=get), fuse nelle liste opzioni del cliente quando
  // il contesto arriva — le liste correnti non elencano più le unità già scalate.
  const redeemBoostRef = useRef<NonNullable<AppointmentEditPayload["redeemBoost"]> | null>(null);
  useEffect(() => {
    holdTokenRef.current = holdToken;
  }, [holdToken]);

  // Item B (port of qbApplyPendingCalendarSlot ~9841): when the drawer is opened from a
  // calendar empty-cell (data-qb-date/time seeded), the availability hold should auto-run once
  // a service + operator are resolvable — the operator no longer has to click "Disponibilità".
  // This ref is armed in the open handler for a valid calendar-slot prefill and CONSUMED (set
  // false) the moment the auto-hold effect fires, so it runs at most once per calendar open.
  const pendingCalendarSlotRef = useRef<boolean>(false);

  // Item 1: drop the local held token AND release it on the server in one place, so every
  // caller that invalidates a held slot (close/reset, operator/cabin/location/service/date/
  // time change) both clears the input and frees the technical hold. Reads the latest token
  // from the ref (avoids threading it through every setter). No-op when there is no hold.
  const dropAndReleaseHold = useCallback(() => {
    const tok = holdTokenRef.current;
    if (tok) releaseHold(tok);
    holdTokenRef.current = "";
    setHoldToken("");
  }, [releaseHold]);

  // AUTO-RENEW the technical hold (port of qbScheduleHoldRenew / qbRenewAvailabilityHold,
  // app.js ~3305-3344): the backend-channel TTL is 300s and the legacy renew delay is
  // clamp(ttl/2, 30s..60s) = 60s, so the hold survives while the operator keeps the
  // drawer open past the TTL. A failed renew retries in 30s (the legacy reschedules
  // with ttl_seconds:60 -> 30s) and leaves the token/form intact — the final save
  // validation decides. Like the legacy qbCanRenewHold, no renew fires while the tab
  // is hidden (the chain stops). Dropping/replacing the token cancels the chain.
  useEffect(() => {
    if (!holdToken) return;
    let stopped = false;
    let timer = 0;
    const schedule = (delayMs: number) => {
      if (stopped) return;
      timer = window.setTimeout(() => void renew(), delayMs);
    };
    const renew = async () => {
      if (stopped) return;
      // Scheda nascosta: il legacy SALTA il rinnovo ma continua a schedulare
      // (qbCanRenewHold false → il timer resta vivo e riparte al ritorno in
      // primo piano); prima il loop moriva al primo tick nascosto.
      if (typeof document !== "undefined" && document.hidden) {
        schedule(30000);
        return;
      }
      try {
        const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({ action: "renew_hold", appointment_hold_token: holdToken }),
        });
        const data: { ok?: boolean; token?: string } = await res.json().catch(() => ({}));
        if (res.ok && data.ok && String(data.token ?? "") === holdToken) {
          holdExpiresRef.current = Date.now() + HOLD_TTL_MS;
          schedule(60000);
          return;
        }
      } catch {
        // network problem: keep the token and retry sooner (legacy behaviour).
      }
      schedule(30000);
    };
    schedule(60000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [holdToken, slug]);

  // Reset the whole form to "new appointment" defaults (port of qbResetForm).
  const resetForm = useCallback(() => {
    pendingCalendarSlotRef.current = false; // disarm any calendar-slot auto-hold (Item B)
    redeemBoostRef.current = null; // disarma il booster redeem dell'edit precedente
    setClient(null);
    // Hide + reset the client history/residuals boxes and drop any in-flight
    // context fetch (port: the boxes only show for a selected client).
    contextReqRef.current += 1;
    setHistorySummary(null);
    setHistoryError("");
    setResidualsSummary(null);
    setResidualsError("");
    setContextLoading(false);
    setClientPackages([]);
    setPackageRedeems({});
    setClientPrepaids([]);
    setPrepaidRedeems({});
    setSelectedServiceIds([]);
    setBookedPriceByService({}); // Item D: drop the edit-only booked-price snapshot
    setPromoByService({}); // drop the auto-detected promo lines (re-fetched on next context)
    promoKeyRef.current = "";
    setStaffPicks({});
    setCabinPicks({});
    setMsOpen(false);
    setServiceSearch("");
    setDate(todayIso());
    setStartTime(nextStepTime());
    setPrefillEndTime(""); // drop any drag-select end override (services drive the end)
    setCabinId("");
    setStatus("scheduled");
    setOriginalStatus(""); // no transition baseline on a fresh CREATE
    setStaffId("");
    setStaffNotes("");
    setCustomerNotes("");
    // Item 1: reset drops any technical hold — release it on the server too (not just locally).
    dropAndReleaseHold();
    // Item 3/4: a fresh form carries no expired-linked alert and no edit-load lifecycle.
    setExpiredLinkWarning("");
    // No cancellation alert on a fresh CREATE (port of qbApplyCancellationState(null)).
    setCancelledAt("");
    setCancelledReason("");
    setEditLoading(false);
    // Manual sconto + coupon belong to the booking; reset to "none" (port of qbResetForm).
    setDiscountType("");
    setDiscountValue("");
    couponReqRef.current += 1; // drop any in-flight coupon preview
    setCouponBoxOpen(false);
    setCouponInput("");
    setCouponCode("");
    setCouponDiscount(0);
    setCouponMsg(null);
    setCouponApplying(false);
    // Block 4: drop the price-panel deduction context + the staff's points/credit inputs.
    setFidelityRedeemEnabled(false);
    setFidelityUseOn(false); // Item E: the fidelity toggle defaults OFF on a fresh form
    setFidelityEuroPerPoint(0.1);
    setFidelityMinPoints(0);
    setFidelityPointsAvailable(0);
    setFidelityInput("");
    setClientCredit(0);
    setCreditInput("");
    setFormError("");
    setFindQuery("");
    setFindResults([]);
    // Back to CREATE mode: drop the edited id + booking code + any edit-load error,
    // and invalidate any in-flight edit-load so a late response can't re-fill this.
    editReqRef.current += 1;
    setApptId("");
    setBookingCode("");
    setEditLoadError("");
    setLocationId((prev) => prev || (ctx.currentLocationId ? String(ctx.currentLocationId) : ""));
  }, [ctx.currentLocationId, dropAndReleaseHold]);

  // GLOBAL open wiring: ANY [data-qb-new] click opens THIS offcanvas in place.
  // Listener is delegated on document so it works for buttons rendered anywhere
  // (the topbar "+ Prenotazione" button carries data-qb-new="1"). The
  // hidden.bs.offcanvas listener resets the form on close (port of app.js).
  //
  // OPTIONAL PREFILL (calendar empty-cell quick-book): the opener MAY carry
  // data-qb-date (YYYY-MM-DD), data-qb-time (HH:MM) and data-qb-staff (a staff id)
  // to pre-seed the drawer's date / start time / single operator after the reset.
  // Absent attributes keep the resetForm defaults (today + next 5-min step).
  useEffect(() => {
    if (typeof document === "undefined") return;

    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest("[data-qb-new]");
      if (!btn) return;
      e.preventDefault();
      loadContext();
      resetForm();
      // Apply any cell prefill AFTER the reset so it wins over the defaults.
      const prefDate = btn.getAttribute("data-qb-date") ?? "";
      const prefTime = btn.getAttribute("data-qb-time") ?? "";
      const prefStaff = btn.getAttribute("data-qb-staff") ?? "";
      // Calendar DRAG-SELECT end (data-qb-endtime, HH:MM): seeds the end time so the
      // dragged DURATION is honored until a service is picked (services then drive it).
      const prefEnd = btn.getAttribute("data-qb-endtime") ?? "";
      const hasCalDate = /^\d{4}-\d{2}-\d{2}$/.test(prefDate);
      const hasCalTime = /^\d{1,2}:\d{2}$/.test(prefTime);
      if (hasCalDate) setDate(prefDate);
      if (hasCalTime) setStartTime(prefTime);
      setPrefillEndTime(/^\d{1,2}:\d{2}$/.test(prefEnd) ? prefEnd : "");
      if (prefStaff && Number.parseInt(prefStaff, 10) > 0) setStaffId(prefStaff);
      // Item B: arm the calendar-slot auto-hold ONLY when the cell seeded a concrete date+time
      // (the empty-cell quick-book case). The auto-hold effect fires it once a service+operator
      // are set; a plain "+ Prenotazione" open (no date/time) leaves it disarmed.
      pendingCalendarSlotRef.current = hasCalDate && hasCalTime;
      const el = document.getElementById("quickBooking");
      const api = bootstrap()?.Offcanvas;
      if (el && api) api.getOrCreateInstance(el).show();
    };

    const el = document.getElementById("quickBooking");
    const onHidden = () => {
      // Item 1: closing the drawer releases the technical hold on the server (resetForm's
      // dropAndReleaseHold does this) — not just a local clear (port of qbReleaseAvailabilityHold
      // fired on drawer close).
      resetForm();
    };

    document.addEventListener("click", onDocClick);
    el?.addEventListener("hidden.bs.offcanvas", onHidden);
    return () => {
      document.removeEventListener("click", onDocClick);
      el?.removeEventListener("hidden.bs.offcanvas", onHidden);
    };
  }, [loadContext, resetForm]);

  const closeOffcanvas = useCallback(() => {
    if (typeof document === "undefined") return;
    const el = document.getElementById("quickBooking");
    const api = bootstrap()?.Offcanvas;
    if (el && api) api.getOrCreateInstance(el).hide();
  }, []);

  // Item 1: release the hold on page unload (port of app.js ~3613 pagehide listener + a
  // beforeunload for reliability). keepalive:true (inside releaseHold) lets the POST finish.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onUnload = () => {
      const tok = holdTokenRef.current;
      if (tok) {
        releaseHold(tok);
        holdTokenRef.current = "";
      }
    };
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [releaseHold]);

  // ---- Services: derived selected set + total duration -> end time (syncEnd) ----
  const totalDuration = useMemo(
    () => selectedServiceIds.reduce((sum, id) => sum + (services.find((s) => s.id === id)?.duration ?? 0), 0),
    [selectedServiceIds, services],
  );

  // syncEnd: the visible end time is DERIVED from start + total duration (no
  // effect/state needed). Mirrors app.js syncEnd(). FALLBACK: when no service is
  // selected yet (totalDuration <= 0) but a calendar drag-select prefilled an explicit
  // end (prefillEndTime, HH:MM, after the start), use that so the dragged DURATION is
  // honored; selecting a service then takes over the end (services drive it).
  const endTime = useMemo(() => {
    const startMin = timeToMin(startTime);
    if (startMin === null) return "";
    if (totalDuration > 0) return minToTime(startMin + totalDuration);
    const prefMin = timeToMin(prefillEndTime);
    if (prefMin !== null && prefMin > startMin) return minToTime(prefMin);
    return "";
  }, [startTime, totalDuration, prefillEndTime]);

  // ---- Multi-service operator picker (port of renderMultiStaffPicker) ----
  // The legacy fetches eligible staff per service from the
  // `staff_for_services` API; here the eligibility is computed client-side from
  // the context staff exactly as the SCOPE note specifies: a service's eligible
  // operators are the staff whose serviceIds include that service id. Services
  // flagged noOperator have no eligible staff (skipped — no select to fill).
  const eligibleStaffForService = useCallback(
    (svc: QbService): QbStaff[] => {
      if (svc.noOperator) return [];
      return staff.filter((st) => st.active !== false && st.serviceIds.includes(svc.id));
    },
    [staff],
  );

  // Multi-service mode is on when 2+ services are selected (setMultiStaffMode).
  const isMultiService = selectedServiceIds.length >= 2;

  // The rows rendered into #qbMultiStaffPicker: one per selected service, in the
  // selection order, each with its eligible operators (port of the html build).
  const staffPickerRows = useMemo(
    () =>
      selectedServiceIds.map((id) => {
        const svc = services.find((s) => s.id === id);
        const eligible = svc ? eligibleStaffForService(svc) : [];
        return {
          id,
          name: svc?.name ?? `Servizio #${id}`,
          eligible,
          onlyOne: eligible.length === 1,
          noOperator: !svc || svc.noOperator,
        };
      }),
    [selectedServiceIds, services, eligibleStaffForService],
  );

  // EFFECTIVE per-service operator map (serviceId -> staffId string, "" = none):
  // derived from the rows + explicit user picks. Auto-selects when a service has
  // exactly one eligible operator; otherwise keeps the user's pick when it is
  // still eligible, else leaves it unselected. noOperator / no-eligible rows are
  // skipped. Port of renderMultiStaffPicker's per-row value resolution. Empty
  // (single/zero service) so the single select drives the assignment.
  const staffMap = useMemo<Record<number, string>>(() => {
    if (!isMultiService) return {};
    const out: Record<number, string> = {};
    for (const row of staffPickerRows) {
      if (row.noOperator || row.eligible.length === 0) continue;
      if (row.onlyOne) {
        out[row.id] = String(row.eligible[0].id);
      } else {
        const pick = staffPicks[row.id];
        out[row.id] = pick && row.eligible.some((st) => String(st.id) === pick) ? pick : "";
      }
    }
    return out;
  }, [isMultiService, staffPickerRows, staffPicks]);

  // Serialize staffMap -> #qb_staff_map JSON {serviceId: staffId}. Only the
  // chosen (non-empty) entries are emitted, matching syncStaffMapFromPicker.
  const staffMapJson = useMemo(() => {
    const out: Record<string, number | string> = {};
    for (const [sid, val] of Object.entries(staffMap)) {
      const v = String(val ?? "").trim();
      if (v) out[sid] = Number.parseInt(v, 10) || v;
    }
    return Object.keys(out).length ? JSON.stringify(out) : "";
  }, [staffMap]);

  // Item B: whether the operator selection is complete enough to hold the slot (port of
  // qbIsOperatorSelectionComplete). Multi-service: every non-noOperator row that has eligible
  // staff must have a chosen operator. Single-service: either an operator is picked (staffId) or
  // the (single) service has eligible operators (the "(qualsiasi)" case — the hold auto-assigns
  // the first free one). Used only to gate the calendar-slot auto-hold; the manual button stays.
  const operatorSelectionComplete = useMemo(() => {
    if (!selectedServiceIds.length) return false;
    if (isMultiService) {
      for (const row of staffPickerRows) {
        if (row.noOperator || row.eligible.length === 0) continue;
        const v = String(staffMap[row.id] ?? "").trim();
        if (!v) return false;
      }
      return true;
    }
    if (staffId.trim()) return true;
    const row = staffPickerRows[0];
    return !!row && !row.noOperator && row.eligible.length > 0;
  }, [selectedServiceIds, isMultiService, staffPickerRows, staffMap, staffId]);

  // Summary box text: the distinct chosen operator names (port: names.join(', ')).
  const staffSummaryText = useMemo(() => {
    if (!isMultiService) return "";
    const names: string[] = [];
    const seen = new Set<string>();
    for (const row of staffPickerRows) {
      const chosen = staffMap[row.id];
      if (!chosen) continue;
      const nm = row.eligible.find((st) => String(st.id) === chosen)?.name?.trim();
      if (nm && !seen.has(nm)) {
        seen.add(nm);
        names.push(nm);
      }
    }
    return names.length ? names.join(", ") : "(seleziona operatori)";
  }, [isMultiService, staffPickerRows, staffMap]);

  const setStaffForService = useCallback((serviceId: number, value: string) => {
    // Cambio operatore in CREATE (port di app.js:8806-8817): lo slot selezionato
    // non vale più — azzera gli orari, rilascia l'hold e avvisa col toast legacy
    // (solo se c'era davvero uno slot e l'operatore è cambiato tra due valori pieni).
    dropAndReleaseHold();
    if (!apptId) {
      const prevStaff = String(staffPicks[serviceId] ?? "").trim();
      const hadSlot = Boolean(startTime);
      if (hadSlot) {
        setStartTime("");
        setPrefillEndTime("");
      }
      if (hadSlot && prevStaff && value.trim() && prevStaff !== value.trim()) {
        qbNotify("Hai cambiato operatore: seleziona di nuovo una disponibilità", "warning");
      }
    }
    setStaffPicks((prev) => ({ ...prev, [serviceId]: value }));
  }, [dropAndReleaseHold, apptId, staffPicks, startTime]);

  // The date/availability/operator controls (and now the cabin select) stay
  // gated until at least one service is selected (port of the start gate).
  const startGateDisabled = selectedServiceIds.length === 0;

  // ---- Operatori per il servizio (port di refreshStaffForService ->
  // action=staff_for_service, app.js:8510-8619): la select SINGOLA carica gli
  // ELEGGIBILI dal server; in EDIT passa la finestra oraria + exclude_id così gli
  // occupati arrivano marcati e l'opzione è disabilitata con l'etichetta legacy
  // "nome — motivo" ("Occupato" fallback). Stati: "Verifico operatori
  // disponibili..." durante il fetch, "Nessun operatore disponibile" (+hint) a 0
  // eleggibili, auto-selezione+disabled con 1 solo, "(qualsiasi)" con 2+.
  const [staffSvcList, setStaffSvcList] = useState<Array<{ id: number; name: string; available: boolean; unavailable_reason: string }> | null>(null);
  const [staffChecking, setStaffChecking] = useState(false);
  const [staffLoadFailed, setStaffLoadFailed] = useState(false);
  const staffSvcReqRef = useRef(0);
  useEffect(() => {
    const single = selectedServiceIds.length === 1 ? selectedServiceIds[0] : 0;
    if (!single || !slug) {
      // Reset in microtask col nonce: niente setState sincroni nell'effect.
      const clearReq = ++staffSvcReqRef.current;
      Promise.resolve().then(() => {
        if (clearReq !== staffSvcReqRef.current) return;
        setStaffSvcList(null);
        setStaffChecking(false);
        setStaffLoadFailed(false);
      });
      return;
    }
    const myReq = ++staffSvcReqRef.current;
    Promise.resolve().then(() => {
      if (myReq !== staffSvcReqRef.current) return;
      setStaffChecking(true);
      setStaffLoadFailed(false);
    });
    const params = new URLSearchParams({ slug, action: "staff_for_service", service_id: String(single) });
    if (apptId && date && startTime && endTime) {
      params.set("date", date);
      params.set("start_time", startTime);
      params.set("end_time", endTime);
      params.set("exclude_id", apptId);
    }
    if (locationId) params.set("location_id", locationId);
    fetch(`/api/manage/appointments?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j: { ok?: boolean; staff?: Array<{ id: number; name: string; available: boolean; unavailable_reason: string }> }) => {
        if (myReq !== staffSvcReqRef.current) return;
        if (!j || j.ok === false || !Array.isArray(j.staff)) {
          setStaffSvcList(null);
          setStaffLoadFailed(true);
          return;
        }
        setStaffSvcList(j.staff);
      })
      .catch(() => {
        if (myReq !== staffSvcReqRef.current) return;
        setStaffSvcList(null);
        setStaffLoadFailed(true);
      })
      .finally(() => {
        if (myReq === staffSvcReqRef.current) setStaffChecking(false);
      });
  }, [selectedServiceIds, apptId, date, startTime, endTime, locationId, slug]);
  // 1 solo eleggibile -> auto-selezionato con select disabled (legacy 8590-8599).
  useEffect(() => {
    if (isMultiService || staffChecking) return;
    const list = staffSvcList;
    if (list && list.length === 1 && String(list[0].id) !== staffId) {
      // setState in microtask (niente cascata sincrona nell'effect).
      const want = String(list[0].id);
      Promise.resolve().then(() => setStaffId(want));
    }
  }, [staffSvcList, staffChecking, isMultiService, staffId]);

  // ---- Cabin: cabins available at the selected location (#qb_cabin_id list) ----
  // Location fallback list (cabins with no locationId are always allowed; no
  // location filter => all cabins) — used until the free-cabin check resolves.
  const availableCabins = useMemo(
    () => {
      const locId = Number(locationId) || 0;
      return cabins.filter((c) => !c.locationId || !locId || c.locationId === locId);
    },
    [cabins, locationId],
  );

  // FREE-cabin availability (port of refreshCabinsForServices -> the legacy
  // action=cabins_for_services): when service + date + time are chosen, fetch
  // the ALLOWED cabins with their occupied state for the selected window; the
  // select shows occupied ones disabled with the "(occupata)" suffix and
  // auto-selects when exactly ONE is free. null => context incomplete/failed,
  // fall back to the location list (all considered free).
  const [cabinAvailability, setCabinAvailability] = useState<Array<{ id: number; name: string; occupied: boolean }> | null>(null);
  const cabinAvailReqRef = useRef(0);
  useEffect(() => {
    const time = /^\d{1,2}:\d{2}/.test(startTime.trim()) ? startTime.trim().slice(0, 5) : "";
    if (!selectedServiceIds.length || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !time) {
      // Reset in microtask col nonce (niente setState sincrono nell'effect).
      const clearReq = ++cabinAvailReqRef.current;
      Promise.resolve().then(() => {
        if (clearReq === cabinAvailReqRef.current) setCabinAvailability(null);
      });
      return;
    }
    const reqId = ++cabinAvailReqRef.current;
    const params = new URLSearchParams();
    params.set("slug", slug);
    params.set("action", "cabins_for_services");
    params.set("service_ids", selectedServiceIds.join(","));
    params.set("starts_at", `${date} ${time}`);
    if (locationId) params.set("location_id", String(locationId));
    if (apptId.trim()) params.set("exclude_id", apptId.trim());
    if (holdToken) params.set("appointment_hold_token", holdToken);
    void fetch(`/api/manage/appointments?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((res) => res.json().catch(() => null))
      .then((data: { ok?: boolean; cabins?: Array<{ id: number; name: string; occupied: boolean }> } | null) => {
        if (reqId !== cabinAvailReqRef.current) return;
        if (!data || !data.ok || !Array.isArray(data.cabins)) {
          setCabinAvailability(null);
          return;
        }
        setCabinAvailability(
          data.cabins
            .map((c) => ({ id: Number(c.id) || 0, name: String(c.name ?? ""), occupied: !!c.occupied }))
            .filter((c) => c.id > 0),
        );
      })
      .catch(() => {
        if (reqId === cabinAvailReqRef.current) setCabinAvailability(null);
      });
  }, [selectedServiceIds, date, startTime, locationId, slug, apptId, holdToken]);

  // Options for the cabin selects: the fetched allowed+occupied list when the
  // free-cabin check resolved, else the location fallback (all free).
  const cabinOptions = useMemo(
    () => cabinAvailability ?? availableCabins.map((c) => ({ id: c.id, name: c.name, occupied: false })),
    [cabinAvailability, availableCabins],
  );
  const freeCabinOptions = useMemo(() => cabinOptions.filter((c) => !c.occupied), [cabinOptions]);

  // The cabin select is usable once a service + (when relevant) location are
  // chosen and there are cabins to pick (port: enabled after availability).
  const cabinGateOpen = !startGateDisabled && cabinOptions.length > 0;

  // EFFECTIVE single cabin value for #qb_cabin_id (and the save's `cabin_id`),
  // DERIVED from the explicit user pick (`cabinId`) + the FREE cabins,
  // exactly like staffMap derives operators — no effect reconciling
  // state-from-state (the file deliberately avoids cascading-render setState).
  // Auto-selects when exactly one cabin is FREE (legacy auto_select / the hint
  // "se è libera solo una verrà selezionata automaticamente"); otherwise keeps
  // the user's pick while it is still free, else "".
  const effectiveCabinId = useMemo(() => {
    if (freeCabinOptions.length === 1) return String(freeCabinOptions[0].id);
    if (cabinId && freeCabinOptions.some((c) => String(c.id) === cabinId)) return cabinId;
    return "";
  }, [freeCabinOptions, cabinId]);

  // EFFECTIVE per-service cabin map (serviceId -> cabinId string, "" = none),
  // mirroring staffMap: derived from the selected services + the cabins
  // available at the location + explicit user picks. Auto-selects when exactly
  // one cabin is available (per the hint); otherwise keeps the user's pick when
  // it is still available, else leaves it unselected. Empty (single/zero
  // service) so the single #qb_cabin_id drives the assignment. Only emitted for
  // 2+ services.
  const cabinMap = useMemo<Record<number, string>>(() => {
    if (!isMultiService || freeCabinOptions.length === 0) return {};
    const out: Record<number, string> = {};
    for (const id of selectedServiceIds) {
      if (freeCabinOptions.length === 1) {
        out[id] = String(freeCabinOptions[0].id);
      } else {
        const pick = cabinPicks[id];
        out[id] = pick && freeCabinOptions.some((c) => String(c.id) === pick) ? pick : "";
      }
    }
    return out;
  }, [isMultiService, freeCabinOptions, selectedServiceIds, cabinPicks]);

  // Serialize cabinMap -> #qb_cabin_map JSON {serviceId: cabinId}. Only the
  // chosen (non-empty) entries are emitted, matching staffMapJson. Empty string
  // when <2 services or nothing chosen, so the input is cleared.
  const cabinMapJson = useMemo(() => {
    const out: Record<string, number | string> = {};
    for (const [sid, val] of Object.entries(cabinMap)) {
      const v = String(val ?? "").trim();
      if (v) out[sid] = Number.parseInt(v, 10) || v;
    }
    return Object.keys(out).length ? JSON.stringify(out) : "";
  }, [cabinMap]);

  const setCabinForService = useCallback((serviceId: number, value: string) => {
    // Changing any cabin invalidates a previously held slot: drop + release (port of
    // qbReleaseAvailabilityHold on a cabin change).
    dropAndReleaseHold();
    setCabinPicks((prev) => ({ ...prev, [serviceId]: value }));
  }, [dropAndReleaseHold]);

  // Changing services / location / date / start time invalidates any held slot
  // (port of qbReleaseAvailabilityHold). We drop the token locally inside the
  // setters rather than in an effect (avoids a cascading-render setState).
  const toggleService = useCallback((id: number) => {
    dropAndReleaseHold();
    setSelectedServiceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, [dropAndReleaseHold]);
  const changeDate = useCallback((value: string) => {
    dropAndReleaseHold();
    setDate(value);
  }, [dropAndReleaseHold]);
  const changeStartTime = useCallback((value: string) => {
    dropAndReleaseHold();
    setStartTime(value);
    // A manually edited start invalidates a drag-select end override (the fixed end was
    // chosen relative to the original start) — fall back to the services-derived end.
    setPrefillEndTime("");
  }, [dropAndReleaseHold]);
  const changeLocation = useCallback((value: string) => {
    dropAndReleaseHold();
    setLocationId(value);
  }, [dropAndReleaseHold]);

  // Location filter for a service item (port of qbServiceItemAllowedForLocation).
  const serviceAllowedForLocation = useCallback(
    (svc: QbService): boolean => {
      const locId = Number(locationId) || 0;
      if (!locId) return true;
      if (!svc.locationIds.length) return true;
      return svc.locationIds.includes(locId);
    },
    [locationId],
  );

  // Group services by category for the dropdown (port of the PHP $byCat grouping:
  // categories first, "Senza categoria" last).
  const groupedServices = useMemo(() => {
    const byCat = new Map<number, QbService[]>();
    for (const svc of services) {
      const cid = svc.categoryId ?? 0;
      if (!byCat.has(cid)) byCat.set(cid, []);
      byCat.get(cid)!.push(svc);
    }
    const catName = new Map<number, string>([[0, "Senza categoria"]]);
    for (const c of categories) catName.set(c.id, c.name);
    const order = Array.from(catName.keys()).filter((id) => id !== 0);
    order.push(0);
    return order
      .map((cid) => ({ cid, name: catName.get(cid) ?? "Categoria", items: byCat.get(cid) ?? [] }))
      .filter((g) => g.items.length > 0);
  }, [services, categories]);

  const needle = lower(serviceSearch);

  // ---- PACKAGE redeem derivation (per-service "Usa pacchetto") ----
  // For each SELECTED service, the client's available packages that COVER it (and
  // still have sessions). Drives the per-service control; a service with no
  // covering package shows nothing. Recomputed from the loaded packages + the
  // current selection (no effect/state — like the rest of this file).
  const packageOptionsByService = useMemo<Record<number, QbClientPackage[]>>(() => {
    const out: Record<number, QbClientPackage[]> = {};
    for (const serviceId of selectedServiceIds) {
      const covering = clientPackages.filter(
        (pkg) => pkg.sessions_remaining > 0 && pkg.service_ids.includes(serviceId),
      );
      if (covering.length) out[serviceId] = covering;
    }
    return out;
  }, [selectedServiceIds, clientPackages]);

  // Effective per-service redeem selection: keep only entries whose service is
  // still selected AND whose package still covers it (prunes on service/client
  // change). This DERIVED map (not raw `packageRedeems`) drives the UI + the
  // serialized payload, so a stale pick can never leak into the save.
  const effectivePackageRedeems = useMemo<Record<number, QbPackageRedeem>>(() => {
    const out: Record<number, QbPackageRedeem> = {};
    for (const serviceId of selectedServiceIds) {
      const pick = packageRedeems[serviceId];
      if (!pick) continue;
      const options = packageOptionsByService[serviceId] ?? [];
      if (options.some((pkg) => pkg.id === pick.client_package_id)) out[serviceId] = pick;
    }
    return out;
  }, [selectedServiceIds, packageRedeems, packageOptionsByService]);

  // Serialize the effective redeem -> #qb_package_redeem JSON array (the shape
  // assets/js/app.js qbReadPackageRedeem produces and the save route parses).
  const packageRedeemJson = useMemo(() => {
    const arr = Object.values(effectivePackageRedeems);
    return arr.length ? JSON.stringify(arr) : "";
  }, [effectivePackageRedeems]);

  // ---- PREPAID-SERVICE redeem derivation (per-service "Usa prepagato") ----
  // For each SELECTED service that is NOT already covered by a package redeem, the
  // client's available prepaids that COVER it (a prepaid covers exactly its own
  // service_id, with remaining_qty left). Drives the per-service control; a service
  // covered by a package, or with no covering prepaid, shows nothing. Recomputed
  // from the loaded prepaids + the current selection + the effective package redeems
  // (no effect/state — like the rest of this file). This is the UI-side half of the
  // dedupe; the server also re-dedupes when consuming.
  const prepaidOptionsByService = useMemo<Record<number, QbClientPrepaid[]>>(() => {
    const out: Record<number, QbClientPrepaid[]> = {};
    for (const serviceId of selectedServiceIds) {
      if (effectivePackageRedeems[serviceId]) continue; // a package already covers it
      const covering = clientPrepaids.filter(
        (prepaid) => prepaid.remaining_qty > 0 && prepaid.service_id === serviceId,
      );
      if (covering.length) out[serviceId] = covering;
    }
    return out;
  }, [selectedServiceIds, clientPrepaids, effectivePackageRedeems]);

  // Effective per-service prepaid redeem selection: keep only entries whose service
  // is still selected, NOT package-covered, AND whose prepaid still covers it (prunes
  // on service/client/package change). This DERIVED map (not raw `prepaidRedeems`)
  // drives the UI + the serialized payload, so a stale pick can never leak into save.
  const effectivePrepaidRedeems = useMemo<Record<number, QbPrepaidRedeem>>(() => {
    const out: Record<number, QbPrepaidRedeem> = {};
    for (const serviceId of selectedServiceIds) {
      const pick = prepaidRedeems[serviceId];
      if (!pick) continue;
      const options = prepaidOptionsByService[serviceId] ?? [];
      if (options.some((prepaid) => prepaid.id === pick.client_prepaid_service_id)) out[serviceId] = pick;
    }
    return out;
  }, [selectedServiceIds, prepaidRedeems, prepaidOptionsByService]);

  // Serialize the effective redeem -> #qb_prepaid_service_redeem JSON STRING (the
  // shape assets/js/app.js qbReadPrepaidServiceRedeem produces and the save route
  // parses). IMPORTANT: sent as a JSON STRING (parseRequestBody stringifies body
  // values), mirroring the package payload.
  const prepaidRedeemJson = useMemo(() => {
    const arr = Object.values(effectivePrepaidRedeems);
    return arr.length ? JSON.stringify(arr) : "";
  }, [effectivePrepaidRedeems]);

  // ---- GIFTBOX redeem derivation (per-service "Usa GiftBox") ----
  // For each SELECTED service that is NOT already covered by a package OR prepaid redeem,
  // the client's available giftbox ITEMS that COVER it (an item covers exactly its own
  // service_id, with a residual unit left). Drives the per-service control; a service
  // covered by a package/prepaid, or with no covering item, shows nothing. Recomputed
  // from the loaded giftboxes + the current selection + the effective package/prepaid
  // redeems (no effect/state — like the rest of this file). This is the UI-side half of
  // the dedupe; the server also re-dedupes (against package + prepaid) when recording.
  const giftboxOptionsByService = useMemo<Record<number, QbClientGiftbox[]>>(() => {
    const out: Record<number, QbClientGiftbox[]> = {};
    for (const serviceId of selectedServiceIds) {
      if (effectivePackageRedeems[serviceId]) continue; // a package already covers it
      if (effectivePrepaidRedeems[serviceId]) continue; // a prepaid already covers it
      const covering = clientGiftboxes.filter((gb) => gb.service_id === serviceId);
      if (covering.length) out[serviceId] = covering;
    }
    return out;
  }, [selectedServiceIds, clientGiftboxes, effectivePackageRedeems, effectivePrepaidRedeems]);

  // Effective per-service giftbox redeem selection: keep only entries whose service is
  // still selected, NOT package/prepaid-covered, AND whose giftbox item still covers it
  // (prunes on service/client/package/prepaid change). This DERIVED map (not raw
  // `giftboxRedeems`) drives the UI + the serialized payload, so a stale pick can never
  // leak into the save.
  const effectiveGiftboxRedeems = useMemo<Record<number, QbGiftboxRedeem>>(() => {
    const out: Record<number, QbGiftboxRedeem> = {};
    for (const serviceId of selectedServiceIds) {
      const pick = giftboxRedeems[serviceId];
      if (!pick) continue;
      const options = giftboxOptionsByService[serviceId] ?? [];
      if (options.some((gb) => gb.instance_id === pick.instance_id && gb.giftbox_item_id === pick.giftbox_item_id)) {
        out[serviceId] = pick;
      }
    }
    return out;
  }, [selectedServiceIds, giftboxRedeems, giftboxOptionsByService]);

  // Serialize the effective redeem -> #qb_giftbox_redeem JSON STRING array of
  // {service_id, instance_id, giftbox_item_id} (the shape assets/js/app.js produces and
  // the save route parses). IMPORTANT: sent as a JSON STRING (parseRequestBody stringifies
  // body values), mirroring the package/prepaid payload.
  const giftboxRedeemJson = useMemo(() => {
    const arr = Object.values(effectiveGiftboxRedeems);
    return arr.length ? JSON.stringify(arr) : "";
  }, [effectiveGiftboxRedeems]);

  // ---- GIFT (omaggio) redeem derivation (per-service "Usa Omaggio") ----
  // For each SELECTED service that is NOT already covered by a package, prepaid OR giftbox
  // redeem, the client's available gift SERVICE REWARDS that COVER it (a reward covers exactly
  // its own service_id, with a residual unit left). Drives the per-service control; a service
  // covered by a package/prepaid/giftbox, or with no covering reward, shows nothing. Recomputed
  // from the loaded gifts + the current selection + the effective package/prepaid/giftbox
  // redeems (no effect/state — like the rest of this file). This is the UI-side half of the
  // dedupe; the server also re-dedupes (against package + prepaid + giftbox) when recording.
  const giftOptionsByService = useMemo<Record<number, QbClientGift[]>>(() => {
    const out: Record<number, QbClientGift[]> = {};
    for (const serviceId of selectedServiceIds) {
      if (effectivePackageRedeems[serviceId]) continue; // a package already covers it
      if (effectivePrepaidRedeems[serviceId]) continue; // a prepaid already covers it
      if (effectiveGiftboxRedeems[serviceId]) continue; // a giftbox already covers it
      const covering = clientGifts.filter((g) => g.service_id === serviceId);
      if (covering.length) out[serviceId] = covering;
    }
    return out;
  }, [selectedServiceIds, clientGifts, effectivePackageRedeems, effectivePrepaidRedeems, effectiveGiftboxRedeems]);

  // Effective per-service gift redeem selection: keep only entries whose service is still
  // selected, NOT package/prepaid/giftbox-covered, AND whose reward still covers it (prunes on
  // service/client/package/prepaid/giftbox change). This DERIVED map (not raw `giftRedeems`)
  // drives the UI + the serialized payload, so a stale pick can never leak into the save.
  const effectiveGiftRedeems = useMemo<Record<number, QbGiftRedeem>>(() => {
    const out: Record<number, QbGiftRedeem> = {};
    for (const serviceId of selectedServiceIds) {
      const pick = giftRedeems[serviceId];
      if (!pick) continue;
      const options = giftOptionsByService[serviceId] ?? [];
      if (options.some((g) => g.instance_id === pick.instance_id && g.reward_item_index === pick.reward_item_index)) {
        out[serviceId] = pick;
      }
    }
    return out;
  }, [selectedServiceIds, giftRedeems, giftOptionsByService]);

  // Serialize the effective redeem -> #qb_gift_redeem JSON STRING array of {service_id,
  // instance_id, reward_item_index} (the shape assets/js/app.js produces and the save route
  // parses). IMPORTANT: sent as a JSON STRING (parseRequestBody stringifies body values),
  // mirroring the package/prepaid/giftbox payload.
  const giftRedeemJson = useMemo(() => {
    const arr = Object.values(effectiveGiftRedeems);
    return arr.length ? JSON.stringify(arr) : "";
  }, [effectiveGiftRedeems]);

  // ---- GIFTCARD redeem derivation (appointment-level "GiftCard") ----
  // The appointment's PAYABLE TOTAL: sum of the SELECTED services' prices MINUS any
  // service zero-charged by an applied package, prepaid OR giftbox redeem (those services
  // are not addebitati, so they don't count toward the giftcard cap). This MIRRORS the
  // server's payable total (SUM of appointment_services.price after package/prepaid/giftbox
  // zeroing), so the default + clamp the staff sees match what the server applies.
  const appointmentPayableTotal = useMemo(() => {
    let total = 0;
    for (const serviceId of selectedServiceIds) {
      if (effectivePackageRedeems[serviceId]) continue; // zero-charged by a package
      if (effectivePrepaidRedeems[serviceId]) continue; // zero-charged by a prepaid
      if (effectiveGiftboxRedeems[serviceId]) continue; // zero-charged by a giftbox
      if (effectiveGiftRedeems[serviceId]) continue; // zero-charged by a gift (omaggio)
      const svc = services.find((s) => s.id === serviceId);
      total += Math.max(0, Number(svc?.price ?? 0));
    }
    return Math.round((total + Number.EPSILON) * 100) / 100;
  }, [selectedServiceIds, services, effectivePackageRedeems, effectivePrepaidRedeems, effectiveGiftboxRedeems, effectiveGiftRedeems]);

  // The effective giftcard pick: keep the chosen giftcard only while it is still in
  // the client's available list (prunes on client change / balance exhaustion). This
  // DERIVED value (not raw `giftcardPick`) drives the UI + serialized payload, so a
  // stale pick can never leak into the save.
  const effectiveGiftcard = useMemo<QbClientGiftcard | null>(() => {
    if (giftcardPick === null) return null;
    return clientGiftcards.find((gc) => gc.id === giftcardPick) ?? null;
  }, [giftcardPick, clientGiftcards]);

  // The maximum applicable amount = min(giftcard balance, appointment payable total).
  // The amount picker is clamped to [0, max]; the default (on selection) is `max`.
  const giftcardMaxAmount = useMemo(() => {
    if (!effectiveGiftcard) return 0;
    return Math.round((Math.min(effectiveGiftcard.balance, appointmentPayableTotal) + Number.EPSILON) * 100) / 100;
  }, [effectiveGiftcard, appointmentPayableTotal]);

  // The effective AMOUNT to apply: parse the staff's input, clamp to [0, max]. An
  // empty/invalid input falls back to the full `max` (the sensible default), matching
  // "default the amount to min(balance, payable total)".
  const giftcardAmount = useMemo(() => {
    if (!effectiveGiftcard || giftcardMaxAmount <= 0) return 0;
    const raw = giftcardAmountInput.trim();
    if (raw === "") return giftcardMaxAmount;
    const parsed = Number.parseFloat(raw.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    const clamped = Math.min(parsed, giftcardMaxAmount);
    return Math.round((Math.max(0, clamped) + Number.EPSILON) * 100) / 100;
  }, [effectiveGiftcard, giftcardMaxAmount, giftcardAmountInput]);

  // Serialize the effective giftcard redeem -> #qb_giftcard_redeem JSON STRING array
  // [{giftcard_id, amount}] (one giftcard per appointment). IMPORTANT: sent as a JSON
  // STRING (parseRequestBody stringifies body values), mirroring package/prepaid. Empty
  // when nothing is applicable (no pick / amount clamps to 0), so the save is unchanged.
  const giftcardRedeemJson = useMemo(() => {
    if (!effectiveGiftcard || giftcardAmount <= 0) return "";
    const entry: QbGiftcardRedeem = { giftcard_id: effectiveGiftcard.id, amount: giftcardAmount };
    return JSON.stringify([entry]);
  }, [effectiveGiftcard, giftcardAmount]);

  // ---- PER-SERVICE redeem badge map (port of qbGetPrepaidServiceBadgeMap) ----
  // serviceId -> the redeem badge shown on a zero-charged line ("gift" | "Servizio" |
  // "GiftBox" | "Pacchetto"). Priority (first wins): gift > prepaid > giftbox > package,
  // exactly like the legacy map's `if(!map.has(key))`. A giftcard is appointment-level
  // (monetary), not a per-line badge, so it is not here. Drives the per-line €0 + badge.
  const redeemBadgeByService = useMemo<Record<number, string>>(() => {
    const out: Record<number, string> = {};
    for (const [sid] of Object.entries(effectiveGiftRedeems)) out[Number(sid)] ??= "gift";
    for (const [sid] of Object.entries(effectivePrepaidRedeems)) out[Number(sid)] ??= "Servizio";
    for (const [sid] of Object.entries(effectiveGiftboxRedeems)) out[Number(sid)] ??= "GiftBox";
    for (const [sid] of Object.entries(effectivePackageRedeems)) out[Number(sid)] ??= "Pacchetto";
    return out;
  }, [effectiveGiftRedeems, effectivePrepaidRedeems, effectiveGiftboxRedeems, effectivePackageRedeems]);

  // ===================== PROMO PREVIEW (port of app.js qbRefreshPromoPreview) =====================
  // Auto-detect the best applicable promotion whenever the promo context changes
  // (client, services, date, time, location). The response's per-service lines
  // land in promoByService and flow into the price panel below (struck list price
  // + discounted price + badge). Fail-soft: any error just clears the promo.
  useEffect(() => {
    const ids = selectedServiceIds;
    if (!ids.length) {
      promoKeyRef.current = "";
      // Reset in microtask col nonce (niente setState sincrono nell'effect).
      const clearReq = ++promoReqRef.current;
      Promise.resolve().then(() => {
        if (clearReq === promoReqRef.current) setPromoByService({});
      });
      return;
    }
    const cid = client?.id ? String(client.id) : "0";
    const time = startTime && /^\d{2}:\d{2}/.test(startTime) ? startTime.slice(0, 5) : "";
    const key = [cid, ids.join(","), date || "", time, locationId ?? ""].join("|");
    if (key === promoKeyRef.current) return;
    promoKeyRef.current = key;
    const reqId = ++promoReqRef.current;
    const params = new URLSearchParams();
    params.set("slug", slug);
    params.set("action", "promotion_preview");
    params.set("client_id", cid);
    params.set("service_ids", ids.join(","));
    if (locationId) params.set("location_id", String(locationId));
    if (date) params.set("appt_date", date);
    if (time) params.set("appt_time", time);
    void fetch(`/api/manage/appointments?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((res) => res.json().catch(() => null))
      .then((data: { ok?: boolean; applied?: number; services?: Array<{ service_id: number; list_price: number; booked_price: number; discount_badge: string }> } | null) => {
        if (reqId !== promoReqRef.current) return;
        if (!data || !data.ok || !data.applied || !Array.isArray(data.services)) {
          setPromoByService({});
          return;
        }
        const map: Record<number, { list: number; booked: number; badge: string }> = {};
        for (const line of data.services) {
          const sid = Number(line.service_id ?? 0);
          const list = Number(line.list_price ?? 0);
          const booked = Number(line.booked_price ?? 0);
          if (sid > 0 && Number.isFinite(list) && Number.isFinite(booked) && list > 0 && booked >= 0 && list > booked) {
            map[sid] = { list, booked, badge: String(line.discount_badge ?? "") };
          }
        }
        setPromoByService(map);
      })
      .catch(() => {
        if (reqId === promoReqRef.current) setPromoByService({});
      });
  }, [client, selectedServiceIds, date, startTime, locationId, slug]);

  // ===================== PRICE RECOMPUTE (port of app.js renderPriceDetails) =====================
  // React-driven price detail: per-line list (service name + price, or struck list price +
  // €0 + a redeem badge when the service is covered by a package/prepaid/giftbox/gift), the
  // Subtotale, the manual Sconto (percent/€, clamped >=0 and <= subtotal), the Coupon
  // discount, and the Totale = subtotal - sconto - coupon - fidelity - giftcard - credito
  // (clamped >= 0). Mirrors the legacy math + which rows reveal (an amount > 0). Fidelity/
  // Credito are not yet wired here (see the TODO on the rows below) so they contribute 0.
  const priceDetails = useMemo(() => {
    // Per-line: a covered service is zero-charged (price 0) but shows its list price
    // struck through + the redeem badge; an uncovered service shows its plain price.
    const lines = selectedServiceIds.map((id) => {
      const svc = services.find((s) => s.id === id);
      // Item D: prefer the BOOKED price snapshot for a line that was part of the original booking
      // (port of qbApplyServiceSnapshotLine restoring dataset.bookedPrice), so an edited
      // appointment shows the price as booked; a newly-added service has no snapshot and falls
      // back to the current catalog price.
      const booked = bookedPriceByService[id];
      const basePrice = Number.isFinite(booked) ? Math.max(0, Number(booked)) : Math.max(0, Number(svc?.price ?? 0));
      const redeemBadge = redeemBadgeByService[id] ?? "";
      const covered = redeemBadge !== "";
      // PROMOZIONE: an auto-detected promo line replaces the plain price with the
      // discounted one (struck list + booked + badge, legacy dataset.bookedPrice /
      // listPrice / discountBadge). A redeem-covered service stays zero-charged
      // (the redeem wins over the promo, same as the legacy save priority).
      const promo = !covered ? promoByService[id] : undefined;
      const listPrice = promo ? Math.max(promo.list, promo.booked) : basePrice;
      return {
        id,
        name: svc?.name ?? `Servizio #${id}`,
        price: covered ? 0 : promo ? promo.booked : basePrice,
        listPrice,
        badge: covered ? redeemBadge : promo?.badge ?? "",
        covered,
      };
    });

    // Subtotale: sum of the PAYABLE line prices (covered lines contribute 0), matching
    // the legacy subtotal (which sums it.price, already 0 for prepaid/redeemed lines).
    let subtotal = 0;
    for (const line of lines) subtotal += line.price;
    subtotal = Math.round((subtotal + Number.EPSILON) * 100) / 100;

    // Manual Sconto: percent of subtotal (capped 100) or fixed €, clamped [0, subtotal].
    const dtype = discountType === "percent" || discountType === "fixed" ? discountType : "";
    let dval = Number.parseFloat(String(discountValue).replace(",", "."));
    if (!Number.isFinite(dval) || dval < 0) dval = 0;
    let discount = 0;
    if (dtype && dval > 0) {
      if (dtype === "percent") {
        if (dval > 100) dval = 100;
        discount = subtotal * (dval / 100);
      } else {
        discount = Math.min(dval, subtotal);
      }
    }
    if (!Number.isFinite(discount) || discount < 0) discount = 0;
    if (discount > subtotal) discount = subtotal;
    discount = Math.round((discount + Number.EPSILON) * 100) / 100;

    // Coupon discount (already validated by the preview), clamped to subtotal.
    let coupon = Number.isFinite(couponDiscount) && couponDiscount > 0 ? couponDiscount : 0;
    if (coupon > subtotal) coupon = subtotal;
    coupon = Math.round((coupon + Number.EPSILON) * 100) / 100;
    const couponApplied = couponCode.trim() !== "" && coupon > 0.000001;

    // ===== Block 4 deductions, applied AFTER the base cascade (subtotal - sconto - coupon),
    // in the LEGACY ORDER (app.js renderPriceDetails ~7572-7599): fidelity discount is part of
    // the cascade, then giftcard, then credit. Each is clamped to what remains so the Totale
    // can never go negative and no deduction exceeds the running total.
    const afterCoupon = Math.max(0, Math.round((subtotal - discount - coupon + Number.EPSILON) * 100) / 100);

    // FIDELITY (points -> €): only when redeem is enabled. The staff types a POINTS count; it is
    // bounded by [0, min(pointsAvailable, floor(afterCoupon / euroPerPoint))] and — respecting
    // the business minPoints — a non-zero use must be >= minPoints (else it contributes 0, like
    // the legacy which refuses a sub-minimum redeem). The € discount = pointsUsed x euroPerPoint.
    const euroPerPoint = Number.isFinite(fidelityEuroPerPoint) && fidelityEuroPerPoint > 0 ? fidelityEuroPerPoint : 0.1;
    let fidelityPointsUsed = 0;
    let fidelity = 0;
    // Item E: the discount only applies when the tenant enables redeem AND the operator flipped
    // the "Usa sconto Punti Fidelity" toggle on (off -> the points input is collapsed, no discount).
    if (fidelityRedeemEnabled && fidelityUseOn) {
      const maxByTotal = Math.floor((afterCoupon + 1e-9) / euroPerPoint);
      const maxPoints = Math.max(0, Math.min(Math.max(0, Math.floor(fidelityPointsAvailable)), maxByTotal));
      let pts = Number.parseInt(String(fidelityInput).replace(/[^0-9]/g, ""), 10);
      if (!Number.isFinite(pts) || pts < 0) pts = 0;
      pts = Math.min(pts, maxPoints);
      // Respect the minimum: a positive use below minPoints is refused (contributes 0).
      if (pts > 0 && fidelityMinPoints > 0 && pts < fidelityMinPoints) pts = 0;
      fidelityPointsUsed = pts;
      fidelity = Math.round((pts * euroPerPoint + Number.EPSILON) * 100) / 100;
      if (fidelity > afterCoupon) fidelity = afterCoupon;
    }
    const afterFidelity = Math.max(0, Math.round((afterCoupon - fidelity + Number.EPSILON) * 100) / 100);

    // GIFTCARD (monetary): the already-computed giftcardAmount (min(card balance, payable total),
    // possibly lowered by the staff), clamped to the running total after fidelity. #3 simply
    // reveals this deduction; the redeem itself is already posted/persisted server-side.
    let giftcardMonetary = Number.isFinite(giftcardAmount) && giftcardAmount > 0 ? giftcardAmount : 0;
    if (giftcardMonetary > afterFidelity) giftcardMonetary = afterFidelity;
    giftcardMonetary = Math.round((giftcardMonetary + Number.EPSILON) * 100) / 100;
    const afterGiftcard = Math.max(0, Math.round((afterFidelity - giftcardMonetary + Number.EPSILON) * 100) / 100);

    // CREDITO (customer credit): the staff types an amount, bounded by [0, min(clientCredit,
    // running total after giftcard)]. Feeds the Totale + #qb_credit_use on save.
    let creditRequested = Number.parseFloat(String(creditInput).replace(",", "."));
    if (!Number.isFinite(creditRequested) || creditRequested < 0) creditRequested = 0;
    let credito = Math.min(creditRequested, Math.max(0, clientCredit), afterGiftcard);
    if (!Number.isFinite(credito) || credito < 0) credito = 0;
    credito = Math.round((credito + Number.EPSILON) * 100) / 100;

    let total = subtotal - discount - coupon - fidelity - giftcardMonetary - credito;
    if (!Number.isFinite(total) || total < 0) total = 0;
    total = Math.round((total + Number.EPSILON) * 100) / 100;

    return { lines, subtotal, discount, coupon, couponApplied, fidelity, fidelityPointsUsed, giftcardMonetary, credito, total };
  }, [
    selectedServiceIds,
    services,
    bookedPriceByService,
    redeemBadgeByService,
    promoByService,
    discountType,
    discountValue,
    couponDiscount,
    couponCode,
    fidelityRedeemEnabled,
    fidelityUseOn,
    fidelityEuroPerPoint,
    fidelityMinPoints,
    fidelityPointsAvailable,
    fidelityInput,
    giftcardAmount,
    clientCredit,
    creditInput,
  ]);

  // The panel (#qbPriceDetailsBox) reveals whenever >=1 service is selected (legacy).
  const showPriceDetails = selectedServiceIds.length > 0;

  // Block 4 "Max" affordances: the maximum points the client could redeem given the total
  // BEFORE fidelity (subtotal - sconto - coupon) and their balance, and the maximum credit
  // usable given the total AFTER fidelity+giftcard and their balance. These drive the "Max"
  // buttons + the availability hints; they mirror the recompute clamps exactly.
  const fidelityMaxUsablePoints = useMemo(() => {
    if (!fidelityRedeemEnabled) return 0;
    const euroPerPoint = Number.isFinite(fidelityEuroPerPoint) && fidelityEuroPerPoint > 0 ? fidelityEuroPerPoint : 0.1;
    const beforeFidelity = Math.max(0, priceDetails.subtotal - priceDetails.discount - priceDetails.coupon);
    const maxByTotal = Math.floor((beforeFidelity + 1e-9) / euroPerPoint);
    return Math.max(0, Math.min(Math.floor(fidelityPointsAvailable), maxByTotal));
  }, [fidelityRedeemEnabled, fidelityEuroPerPoint, fidelityPointsAvailable, priceDetails.subtotal, priceDetails.discount, priceDetails.coupon]);

  const creditMaxUsable = useMemo(() => {
    const afterGiftcard = Math.max(0, priceDetails.subtotal - priceDetails.discount - priceDetails.coupon - priceDetails.fidelity - priceDetails.giftcardMonetary);
    return Math.round((Math.min(Math.max(0, clientCredit), afterGiftcard) + Number.EPSILON) * 100) / 100;
  }, [clientCredit, priceDetails.subtotal, priceDetails.discount, priceDetails.coupon, priceDetails.fidelity, priceDetails.giftcardMonetary]);

  // ---- COUPON handlers (port of qbApplyCouponPreview + Apply/Remove buttons) ----
  // The IDs of the services the coupon applies to: only the PAYABLE (non-redeemed)
  // services count toward the coupon (port of getSelectedPayableServiceIds), and the
  // subtotal sent to the preview is their summed price.
  const payableServiceIds = useMemo(
    () => selectedServiceIds.filter((id) => !redeemBadgeByService[id]),
    [selectedServiceIds, redeemBadgeByService],
  );

  const clearCouponState = useCallback(() => {
    couponReqRef.current += 1; // invalidate any in-flight preview
    couponValidatedSigRef.current = ""; // no coupon applied -> nothing to revalidate
    setCouponCode("");
    setCouponDiscount(0);
  }, []);

  // Toggle #qbCouponBox (port of the qbCouponToggle click handler).
  const onCouponToggle = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCouponBoxOpen((prev) => !prev);
  }, []);

  // Apply: validate the typed code against the DB coupons preview endpoint
  // (/api/manage/coupons action=preview -> {ok, preview:{valid, discount, reason}}),
  // faithful to qbApplyCouponPreview. On success set #qb_coupon_code + #qb_coupon_discount
  // (so the recompute reveals #qbCouponRow and SAVE posts them); on failure show the reason.
  const applyCoupon = useCallback(async (opts?: { codeOverride?: string }) => {
    // codeOverride (port of qbApplyCouponPreview's codeOverride): re-validate a specific applied
    // code (the revalidation effect passes the currently applied couponCode, not the raw input).
    const rawCode = opts?.codeOverride !== undefined ? opts.codeOverride : couponInput;
    const code = rawCode.trim().toUpperCase();
    setCouponBoxOpen(true);
    if (!code) {
      clearCouponState();
      setCouponInput("");
      setCouponMsg({ text: "Inserisci un codice coupon.", ok: false });
      return;
    }
    // One coupon per booking: refuse a different code while one is applied.
    const currentApplied = couponCode.trim().toUpperCase();
    if (currentApplied && currentApplied !== code) {
      setCouponInput(currentApplied);
      setCouponMsg({
        text: "Puoi applicare un solo coupon per prenotazione. Rimuovi quello attuale prima di inserirne un altro.",
        ok: false,
      });
      return;
    }
    if (!payableServiceIds.length) {
      setCouponMsg({ text: "Seleziona almeno un servizio.", ok: false });
      return;
    }
    const subtotal = priceDetails.subtotal;
    const myReq = ++couponReqRef.current;
    setCouponApplying(true);
    try {
      // Full server context (port of qbApplyCouponPreview ~4080): the payable service ids, the
      // location, the appointment date/time, the selected client and — on edit — the editing
      // appointment id, so the server validates the coupon against the SAME context the booking
      // will use (e.g. the active-window is checked as of the booked day). All are optional and
      // ignored server-side when empty, so the preview is backward-compatible.
      const t0 = startTime.trim();
      const previewBody: Record<string, string> = { action: "preview", code, subtotal: String(subtotal) };
      if (payableServiceIds.length) previewBody.service_ids = payableServiceIds.join(",");
      if (locationId && Number(locationId) > 0) previewBody.location_id = String(locationId);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) previewBody.appt_date = date;
      if (/^\d{1,2}:\d{2}/.test(t0)) previewBody.appt_time = t0.substring(0, 5);
      if (client?.id) previewBody.client_id = String(client.id);
      if (apptId.trim()) previewBody.appointment_id = apptId.trim();
      const res = await fetch(`/api/manage/coupons?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify(previewBody),
      });
      const data: { ok?: boolean; error?: string; preview?: { valid?: boolean; discount?: number; reason?: string } } =
        await res.json().catch(() => ({}));
      if (myReq !== couponReqRef.current) return; // stale
      const preview = data?.preview;
      if (res.ok && data?.ok !== false && preview?.valid) {
        const disc = Math.round((Math.max(0, Number(preview.discount ?? 0)) + Number.EPSILON) * 100) / 100;
        setCouponCode(code);
        setCouponDiscount(disc);
        setCouponInput(code);
        setCouponMsg({ text: "Coupon applicato.", ok: true });
        // Record the payable-service signature this validation covers, so the revalidation
        // effect won't re-fire until the selection actually changes again.
        couponValidatedSigRef.current = payableServiceIds.join(",");
      } else {
        clearCouponState();
        setCouponInput(code);
        setCouponMsg({ text: String(preview?.reason || data?.error || "Coupon non applicabile."), ok: false });
      }
    } catch {
      if (myReq !== couponReqRef.current) return;
      clearCouponState();
      setCouponInput(code);
      setCouponMsg({ text: "Errore durante la verifica del coupon.", ok: false });
    } finally {
      if (myReq === couponReqRef.current) setCouponApplying(false);
    }
  }, [couponInput, couponCode, payableServiceIds, priceDetails.subtotal, slug, clearCouponState, date, startTime, locationId, client, apptId]);

  // Remove: clear the applied coupon + collapse the box (port of qbCouponRemoveBtn).
  const removeCoupon = useCallback(() => {
    clearCouponState();
    setCouponInput("");
    setCouponMsg(null);
    setCouponBoxOpen(false);
  }, [clearCouponState]);

  // Revalidate the applied coupon when the service selection changes (port of
  // qbRevalidateCouponIfNeeded, called after every service toggle). Only runs while a coupon is
  // applied AND the payable-service set actually differs from what it was validated against (the
  // signature ref guards against a re-render loop). If no payable service remains, the coupon is
  // cleared with a notice; otherwise the preview is re-run so the discount/eligibility reflect
  // the new selection (a coupon that no longer qualifies is cleared inside applyCoupon).
  useEffect(() => {
    if (!couponCode.trim()) return; // nothing applied -> nothing to revalidate
    const sig = payableServiceIds.join(",");
    if (sig === couponValidatedSigRef.current) return; // selection unchanged since validation
    // Adopt the new signature immediately so this effect fires once per real change, not per
    // render (applyCoupon overwrites it on success; clearCouponState resets it on clear).
    couponValidatedSigRef.current = sig;
    const emptied = !payableServiceIds.length;
    const appliedCode = couponCode;
    // Defer the state-mutating revalidation to a macrotask so no setState runs synchronously in
    // this effect's render (the file deliberately avoids cascading-render setState).
    const t = setTimeout(() => {
      if (emptied) {
        clearCouponState();
        setCouponMsg({ text: "Coupon rimosso: nessun servizio selezionato.", ok: false });
        return;
      }
      void applyCoupon({ codeOverride: appliedCode });
    }, 0);
    return () => clearTimeout(t);
  }, [payableServiceIds, couponCode, applyCoupon, clearCouponState]);

  // ---- Client HISTORY + RESIDUALS fetch (port of qbLoadClientHistory + qbLoadClientResiduals) ----
  // Driven from the client select/clear flow (NOT an effect) so it never calls
  // setState synchronously inside an effect body — matching this file's
  // deliberate avoidance of cascading-render setState. A monotonically
  // increasing req-id discards stale responses (the legacy qbHistoryReqId /
  // qbResidualsReqId pattern). The current sede is captured in the callback's
  // closure, like the legacy reads locationSel.value when a client is chosen.
  const clientId = client?.id ?? "";

  const clearClientContext = useCallback(() => {
    contextReqRef.current += 1; // invalidate any in-flight request
    setHistorySummary(null);
    setHistoryError("");
    setResidualsSummary(null);
    setResidualsError("");
    setContextLoading(false);
    // The packages + per-service redeem belong to the client; clear on client change.
    setClientPackages([]);
    setPackageRedeems({});
    // The prepaids + per-service redeem also belong to the client; clear on change.
    setClientPrepaids([]);
    setPrepaidRedeems({});
    // The giftcards + appointment-level redeem also belong to the client; clear too.
    setClientGiftcards([]);
    setGiftcardPick(null);
    setGiftcardAmountInput("");
    // The giftboxes + per-service redeem also belong to the client; clear on change.
    setClientGiftboxes([]);
    setGiftboxRedeems({});
    // The gift rewards + per-service redeem also belong to the client; clear on change.
    setClientGifts([]);
    setGiftRedeems({});
    // Block 4: the fidelity-redeem context + credit balance belong to the client; reset the
    // settings/availability AND the staff's points/credit inputs so they don't leak.
    setFidelityRedeemEnabled(false);
    setFidelityUseOn(false); // Item E: reset the fidelity toggle OFF on client change
    setFidelityEuroPerPoint(0.1);
    setFidelityMinPoints(0);
    setFidelityPointsAvailable(0);
    setFidelityInput("");
    setClientCredit(0);
    setCreditInput("");
  }, []);

  const loadClientContext = useCallback(
    (id: string) => {
      const myReq = ++contextReqRef.current;
      setContextLoading(true);
      setHistorySummary(null);
      setHistoryError("");
      setResidualsSummary(null);
      setResidualsError("");
      // New client -> drop any previous packages + per-service redeem selection.
      setClientPackages([]);
      setPackageRedeems({});
      // ...and any previous prepaids + per-service redeem selection.
      setClientPrepaids([]);
      setPrepaidRedeems({});
      // ...and any previous giftcards + appointment-level redeem selection.
      setClientGiftcards([]);
      setGiftcardPick(null);
      setGiftcardAmountInput("");
      // ...and any previous giftboxes + per-service redeem selection.
      setClientGiftboxes([]);
      setGiftboxRedeems({});
      // ...and any previous gift rewards + per-service redeem selection.
      setClientGifts([]);
      setGiftRedeems({});
      // ...and any previous Block 4 fidelity/credit context + the staff's points/credit inputs.
      setFidelityRedeemEnabled(false);
      setFidelityUseOn(false); // Item E: reset the fidelity toggle OFF on client change
      setFidelityEuroPerPoint(0.1);
      setFidelityMinPoints(0);
      setFidelityPointsAvailable(0);
      setFidelityInput("");
      setClientCredit(0);
      setCreditInput("");

      const params = new URLSearchParams({ slug, action: "quickbook_client_context", client_id: id });
      const locId = String(locationId || "").trim();
      if (locId) params.set("location_id", locId);

      fetch(`/api/manage/clients?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
        .then((r) => r.json())
        .then((data: QbClientContextResponse) => {
          if (myReq !== contextReqRef.current) return; // stale
          if (!data || data.ok === false) {
            setHistoryError("Storico non disponibile.");
            setResidualsError("Residui non disponibili.");
            return;
          }
          setHistorySummary(data.summary ?? {});
          setResidualsSummary(data.residuals ?? {});
          // EDIT: fondi il booster (istanze consumate dalla prenotazione in
          // modifica) nelle liste — i residui correnti non le elencano più.
          const boost = redeemBoostRef.current;
          setClientPackages(qbMergeBoost(Array.isArray(data.packages) ? data.packages : [], boost?.packages, (p) => String(p.id)));
          setClientPrepaids(qbMergeBoost(Array.isArray(data.prepaids) ? data.prepaids : [], boost?.prepaids, (p) => String(p.id)));
          setClientGiftcards(qbMergeBoost(Array.isArray(data.giftcards) ? data.giftcards : [], boost?.giftcards, (g) => String(g.id)));
          setClientGiftboxes(qbMergeBoost(Array.isArray(data.giftboxes) ? data.giftboxes : [], boost?.giftboxes, (g) => `${g.instance_id}:${g.giftbox_item_id}:${g.service_id}`));
          setClientGifts(qbMergeBoost(Array.isArray(data.gifts) ? data.gifts : [], boost?.gifts, (g) => `${g.instance_id}:${g.reward_item_index}:${g.service_id}`));
          // Block 4: fidelity redeem settings + available points, and the spendable credit.
          const fid = data.fidelity ?? {};
          setFidelityRedeemEnabled(Boolean(fid.redeemEnabled));
          setFidelityEuroPerPoint(Number.isFinite(fid.euroPerPoint) && Number(fid.euroPerPoint) > 0 ? Number(fid.euroPerPoint) : 0.1);
          setFidelityMinPoints(Math.max(0, Math.round(Number(fid.minPoints ?? 0) || 0)));
          setFidelityPointsAvailable(Math.max(0, Math.round(Number(fid.pointsAvailable ?? 0) || 0)));
          setClientCredit(Math.max(0, Number(data.creditAvailable ?? data.residuals?.credit_available ?? 0) || 0));
        })
        .catch(() => {
          if (myReq !== contextReqRef.current) return;
          setHistoryError("Errore nel caricamento storico.");
          setResidualsError("Errore nel caricamento residui.");
        })
        .finally(() => {
          if (myReq !== contextReqRef.current) return;
          setContextLoading(false);
        });
    },
    [slug, locationId],
  );

  // ---- Find client (debounced search of /api/manage/clients?q=) ----
  // Driven from the search input's onChange (not an effect) so it doesn't call
  // setState synchronously inside an effect body. 200ms debounce (port of app.js).
  const onFindQueryChange = useCallback(
    (value: string) => {
      setFindQuery(value);
      if (findTimerRef.current) clearTimeout(findTimerRef.current);
      const q = value.trim();
      if (!q) {
        setFindResults([]);
        return;
      }
      findTimerRef.current = setTimeout(() => {
        const params = new URLSearchParams({ slug, q });
        fetch(`/api/manage/clients?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
          .then((r) => r.json())
          .then((j: { clients?: Array<{ id: number; name: string; email?: string; phone?: string }> }) => {
            setFindResults(
              (j.clients ?? []).slice(0, 20).map((c) => ({
                id: String(c.id),
                full_name: c.name ?? "",
                email: c.email ?? "",
                phone: c.phone ?? "",
              })),
            );
          })
          .catch(() => setFindResults([]));
      }, 200);
    },
    [slug],
  );

  const selectClient = useCallback(
    (c: QbClient) => {
      setClient(c);
      // Load + show the history/residuals boxes for the chosen client.
      loadClientContext(c.id);
      const el = document.getElementById("qbClientFindModal");
      const api = bootstrap()?.Modal;
      if (el && api) api.getOrCreateInstance(el).hide();
    },
    [loadClientContext],
  );

  // ---- EDIT MODE load (port of assets/js/app.js openEditAppointment/loadAppointment) ----
  // Fetch the appointment's editable payload (GET action=get) and PREFILL the drawer:
  // select the client (so the history/residuals/context boxes load just like picking a
  // client), select each service in the multiselect, set the per-service operator +
  // cabin picks from the staff/cabin maps, set the explicit primary cabin, date, time,
  // status and notes, set #qb_appt_id (so SAVE routes to updateDbAppointment), set the
  // header title to "Modifica prenotazione" and show the booking code. The form is reset
  // FIRST (create defaults) so a previous edit/create never leaks. A monotonic req-id
  // discards a stale response (the user re-opening quickly). Errors surface in the form.
  // TODO(redeem-on-edit): the redeem selections are intentionally NOT prefilled — the
  // save's update path does not re-apply/restore redeems (see getDbAppointmentForEdit),
  // so the per-service redeem controls start empty; the read-only residual badges still
  // load via the client context when the client is selected below.
  const openEditAppointment = useCallback(
    (id: string) => {
      const editId = String(id || "").trim();
      const numericId = Number.parseInt(editId, 10);
      if (!Number.isFinite(numericId) || numericId <= 0) return;

      // Item 4: remember the id so the #qbLoadErrorState "Riprova" button can re-invoke
      // this load (port of qbLastOpenEditArgs / qbLoadRetryBtn).
      lastEditIdRef.current = editId;

      loadContext();
      resetForm();
      const myReq = ++editReqRef.current;
      setEditLoadError("");
      // Item 4: enter the loading state (spinner #qbLoadingState, form blocked) for the
      // duration of the action=get fetch (port of qbSetLoading). Cleared to ready on
      // success (qbSetLoadReady) or to the error state on failure (qbSetLoadError).
      setEditLoading(true);

      // Open the offcanvas immediately (the legacy shows a loading state while the
      // GET resolves); the prefill applies as soon as the payload arrives.
      const el = document.getElementById("quickBooking");
      const api = bootstrap()?.Offcanvas;
      if (el && api) api.getOrCreateInstance(el).show();

      const params = new URLSearchParams({ slug, action: "get", id: String(numericId) });
      fetch(`/api/manage/appointments?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
        .then((r) => r.json())
        .then((data: { ok?: boolean; error?: string; appointment?: AppointmentEditPayload }) => {
          if (myReq !== editReqRef.current) return; // stale (drawer re-opened meanwhile)
          if (!data || data.ok === false || !data.appointment) {
            // Item 4: load FAILED -> leave the loading state and show #qbLoadErrorState
            // (with a working Riprova button) instead of an ad-hoc header alert.
            setEditLoading(false);
            setEditLoadError(String(data?.error || "Impossibile caricare la prenotazione."));
            // Il legacy oltre allo stato d'errore fa ANCHE il toast (app.js
            // 9707-9714, fallback verbatim).
            qbNotify(String(data?.error || "Errore caricamento appuntamento"), "danger");
            return;
          }
          const a = data.appointment;

          // EDIT MODE markers: id (-> updateDbAppointment on save) + booking code header.
          setApptId(String(a.id));
          setBookingCode(a.publicCode ? String(a.publicCode) : "");

          // Client: reuse selectClient so the history/residuals/context boxes load
          // exactly like picking a client from the find modal.
          if (a.clientId && a.clientId > 0) {
            selectClient({
              id: String(a.clientId),
              full_name: a.clientName ?? "",
              email: a.clientEmail ?? "",
              phone: a.clientPhone ?? "",
            });
          }

          // Location FIRST (the cabin/service-location filters derive from it).
          if (a.locationId && a.locationId > 0) setLocationId(String(a.locationId));

          // Services multiselect: select each service in the payload's order.
          setSelectedServiceIds(Array.isArray(a.services) ? a.services.map((s) => s.serviceId) : []);

          // Item D: capture the BOOKED per-service price snapshot so the price panel restores each
          // existing line at the price it was booked at (only entries with a defined price count).
          const bookedPrices: Record<number, number> = {};
          if (Array.isArray(a.services)) {
            for (const s of a.services) {
              if (s.serviceId > 0 && typeof s.price === "number" && Number.isFinite(s.price)) {
                bookedPrices[s.serviceId] = Math.max(0, Number(s.price));
              }
            }
          }
          setBookedPriceByService(bookedPrices);

          // Per-service operator + cabin picks from the maps (serviceId -> id). These
          // feed the same staffPicks/cabinPicks the multi-service picker uses; for a
          // single service the derived single operator/cabin select reads them too via
          // the effective maps. Stored as strings to match the picker's value type.
          const staffPickMap: Record<number, string> = {};
          for (const [sid, stid] of Object.entries(a.staffMap ?? {})) {
            if (Number(stid) > 0) staffPickMap[Number(sid)] = String(stid);
          }
          setStaffPicks(staffPickMap);
          const cabinPickMap: Record<number, string> = {};
          for (const [sid, cid] of Object.entries(a.cabinMap ?? {})) {
            if (Number(cid) > 0) cabinPickMap[Number(sid)] = String(cid);
          }
          setCabinPicks(cabinPickMap);

          // Single-service operator/cabin: prefill the whole-appointment selects from
          // the first service's map entry (the multi-service picker drives 2+ services).
          const firstServiceId = a.services?.[0]?.serviceId;
          if (firstServiceId !== undefined && a.staffMap?.[firstServiceId] && a.staffMap[firstServiceId] > 0) {
            setStaffId(String(a.staffMap[firstServiceId]));
          }
          // Primary cabin (appointments.cabin_id) drives the single #qb_cabin_id select.
          if (a.primaryCabinId && a.primaryCabinId > 0) {
            setCabinId(String(a.primaryCabinId));
          } else if (firstServiceId !== undefined && a.cabinMap?.[firstServiceId] && a.cabinMap[firstServiceId] > 0) {
            setCabinId(String(a.cabinMap[firstServiceId]));
          }

          // Date / time / status / notes.
          if (a.date) setDate(a.date);
          if (a.time) setStartTime(a.time);
          setStatus(a.status || "scheduled");
          // Baseline for the save-time transition detection (php code as loaded).
          setOriginalStatus(a.status || "scheduled");
          setStaffNotes(a.staffNotes ?? "");
          setCustomerNotes(a.customerNotes ?? "");
          // Manual sconto: prefill the price panel from the persisted discount columns.
          const editDiscountType = a.discountType === "percent" || a.discountType === "fixed" ? a.discountType : "";
          setDiscountType(editDiscountType);
          setDiscountValue(editDiscountType && Number(a.discountValue ?? 0) > 0 ? String(a.discountValue) : "");
          // Block 4: prefill the persisted fidelity points + credit use, and the coupon (read
          // back from notes). fidelity/credit inputs prefill only the STAFF-visible figure; the
          // fidelity box + credit box only render once the client context loads (redeem enabled /
          // credit balance > 0), so a stale figure without context simply shows no row.
          const editPoints = Math.max(0, Math.round(Number(a.fidelityPointsUsed ?? 0) || 0));
          setFidelityInput(editPoints > 0 ? String(editPoints) : "");
          // Item E: if the loaded appointment already redeemed points, flip the toggle ON so the
          // restored figure applies (and the input reveals once the client context confirms redeem).
          setFidelityUseOn(editPoints > 0);
          const editCredit = Math.max(0, Number(a.creditUsed ?? 0) || 0);
          setCreditInput(editCredit > 0 ? String(editCredit) : "");
          if (a.coupon && a.coupon.code) {
            // Prefill legacy (app.js 9482-9493): codice SEMPRE ripristinato;
            // con sconto > 0 'Coupon applicato.', con solo codice storico
            // 'Coupon storico preservato.'.
            const cCode = String(a.coupon.code).toUpperCase();
            const cDisc = Math.round((Math.max(0, Number(a.coupon.discount ?? 0)) + Number.EPSILON) * 100) / 100;
            setCouponCode(cCode);
            setCouponInput(cCode);
            setCouponDiscount(cDisc);
            setCouponBoxOpen(true);
            setCouponMsg(cDisc > 0 ? { text: "Coupon applicato.", ok: true } : { text: "Coupon storico preservato.", ok: true });
          }
          // An existing slot is already booked: no hold needed (the update reuses it).
          setHoldToken("");
          // REDEEM esistenti (port del prefill legacy app.js:9310-9396): arma il
          // booster PRIMA che il contesto cliente arrivi (il loader lo fonde nelle
          // liste opzioni) e fondilo subito nelle liste correnti, poi prefilla le
          // selezioni per-servizio + la GiftCard a livello appuntamento.
          redeemBoostRef.current = a.redeemBoost ?? null;
          if (a.redeemBoost) {
            const boost = a.redeemBoost;
            setClientPackages((prev) => qbMergeBoost(prev, boost.packages, (p) => String(p.id)));
            setClientPrepaids((prev) => qbMergeBoost(prev, boost.prepaids, (p) => String(p.id)));
            setClientGiftcards((prev) => qbMergeBoost(prev, boost.giftcards, (g) => String(g.id)));
            setClientGiftboxes((prev) => qbMergeBoost(prev, boost.giftboxes, (g) => `${g.instance_id}:${g.giftbox_item_id}:${g.service_id}`));
            setClientGifts((prev) => qbMergeBoost(prev, boost.gifts, (g) => `${g.instance_id}:${g.reward_item_index}:${g.service_id}`));
          }
          const pkgPrefill: Record<number, QbPackageRedeem> = {};
          for (const r of a.packageRedeem ?? []) {
            if (r.client_package_id > 0 && r.service_id > 0) {
              pkgPrefill[r.service_id] = { client_package_id: r.client_package_id, service_id: r.service_id, client_package_service_id: r.client_package_service_id ?? null };
            }
          }
          setPackageRedeems(pkgPrefill);
          const prePrefill: Record<number, QbPrepaidRedeem> = {};
          for (const r of a.prepaidServiceRedeem ?? []) {
            if (r.client_prepaid_service_id > 0 && r.service_id > 0) {
              prePrefill[r.service_id] = { client_prepaid_service_id: r.client_prepaid_service_id, service_id: r.service_id };
            }
          }
          setPrepaidRedeems(prePrefill);
          const gbPrefill: Record<number, QbGiftboxRedeem> = {};
          for (const r of a.giftboxRedeem ?? []) {
            if (r.instance_id > 0 && r.service_id > 0) {
              gbPrefill[r.service_id] = { instance_id: r.instance_id, giftbox_item_id: r.giftbox_item_id, service_id: r.service_id };
            }
          }
          setGiftboxRedeems(gbPrefill);
          const gPrefill: Record<number, QbGiftRedeem> = {};
          for (const r of a.giftRedeem ?? []) {
            if (r.instance_id > 0 && r.service_id > 0) {
              gPrefill[r.service_id] = { service_id: r.service_id, instance_id: r.instance_id, reward_item_index: r.reward_item_index };
            }
          }
          setGiftRedeems(gPrefill);
          const gcPrefill = (a.giftcardRedeem ?? [])[0];
          if (gcPrefill && gcPrefill.giftcard_id > 0 && gcPrefill.amount > 0) {
            setGiftcardPick(gcPrefill.giftcard_id);
            setGiftcardAmountInput(String(gcPrefill.amount));
          }
          // Item 3: surface the expired-linked-residual warning in #qbExpiredLinkedAlert
          // (port of qbSetExpiredLinkedAlert(a.expired_link_warning)). "" hides it.
          setExpiredLinkWarning(String(a.expiredLinkWarning ?? "").trim());
          // Cancellation metadata for the locked-mode alert (qbApplyCancellationState):
          // only rendered when the loaded status is canceled/no_show.
          setCancelledAt(String(a.cancelledAt ?? "").trim());
          setCancelledReason(String(a.cancelledReason ?? "").trim());
          // Item 4: prefill done -> ready (spinner hidden, form unblocked; qbSetLoadReady).
          setEditLoading(false);
        })
        .catch(() => {
          if (myReq !== editReqRef.current) return;
          // Item 4: a network failure shows #qbLoadErrorState with the Riprova button.
          setEditLoading(false);
          setEditLoadError("Errore di rete durante il caricamento della prenotazione.");
        });
    },
    [slug, loadContext, resetForm, selectClient],
  );

  // GLOBAL edit wiring: ANY [data-qb-edit] click loads + prefills THIS offcanvas in
  // EDIT MODE (the per-row "Modifica" buttons carry data-qb-edit="<id>"). Delegated on
  // document so it works for buttons rendered anywhere. Distinct from the [data-qb-new]
  // listener above (which opens a clean CREATE form).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest("[data-qb-edit]");
      if (!btn) return;
      e.preventDefault();
      const id = btn.getAttribute("data-qb-edit") ?? "";
      openEditAppointment(id);
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [openEditAppointment]);

  const openFindClient = useCallback(() => {
    setFindQuery("");
    setFindResults([]);
    const el = document.getElementById("qbClientFindModal");
    const api = bootstrap()?.Modal;
    if (el && api) api.getOrCreateInstance(el).show();
  }, []);

  const openNewClient = useCallback(() => {
    setCreateError("");
    setCreateSaving(false);
    createFormRef.current?.reset();
    const el = document.getElementById("qbClientCreateModal");
    const api = bootstrap()?.Modal;
    if (el && api) api.getOrCreateInstance(el).show();
  }, []);

  // The history "Apri scheda" opens the CLIENT CARD modal (port of
  // qbOpenClientCard -> api_clients action=card -> #qbClientCardModal); the
  // href stays as the clean client view URL for the modal's "Apri in nuova
  // scheda" footer link (and middle-click). The residuals "Apri scheda" link
  // opens the DETAIL modal below (openResidualsDetail).
  const historyOpenHref = clientId
    ? `/${encodeURIComponent(slug)}/clients?action=view&id=${encodeURIComponent(clientId)}`
    : "#";

  // ---- "Scheda semplificata" cliente (#qbClientCardModal) ----
  type QbClientCard = {
    client: { id: number; full_name: string; phone: string; email: string; points: number };
    summary: { last_visit: string | null; next_visit: string | null; sales_total: number };
    appointments: Array<{ id: number; starts_at: string; status: string; services: string; staff: string; total: number }>;
    sales: Array<{ id: number; sale_date: string; total: number; notes: string }>;
    tags: Array<{ id: number; name: string }>;
    docs: Array<{ id: number; title: string; url: string; created_at: string }>;
  };
  const [clientCard, setClientCard] = useState<{ loading: boolean; error: string; data: QbClientCard | null }>({ loading: false, error: "", data: null });
  const clientCardReqRef = useRef(0);

  const openClientCard = useCallback((e?: React.MouseEvent) => {
    if (e) e.preventDefault();
    const id = String(clientId || "").trim();
    if (!id) return;
    const el = document.getElementById("qbClientCardModal");
    const api = bootstrap()?.Modal;
    if (el && api) api.getOrCreateInstance(el).show();
    setClientCard({ loading: true, error: "", data: null });
    const reqId = ++clientCardReqRef.current;
    void fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}&action=card&client_id=${encodeURIComponent(id)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((res) => res.json().catch(() => null))
      .then((data: ({ ok?: boolean; error?: string } & Partial<QbClientCard>) | null) => {
        if (reqId !== clientCardReqRef.current) return;
        if (!data || !data.ok || !data.client) {
          setClientCard({ loading: false, error: String(data?.error || "Impossibile caricare la scheda cliente."), data: null });
          return;
        }
        setClientCard({ loading: false, error: "", data: data as QbClientCard });
      })
      .catch(() => {
        if (reqId === clientCardReqRef.current) setClientCard({ loading: false, error: "Errore di rete durante il caricamento.", data: null });
      });
  }, [clientId, slug]);

  // Open the "Apri scheda" residuals DETAIL modal for the selected client (port of
  // app.js qbOpenClientResiduals): show the modal, then fetch action=residuals and
  // render the sections. A monotonic req-id discards stale responses. The modal is a
  // read-only VIEWER — the inline redeem SELECTION lives on the drawer form.
  // Fetch-only part of the residuals detail (shared by the residuals modal and the
  // per-item info modals below): loads /api/manage/clients?action=residuals into
  // residualsDetail with the loading/error lifecycle.
  const fetchResidualsDetail = useCallback((id: string) => {
    const myReq = ++residualsDetailReqRef.current;
    setResidualsDetail(null);
    setResidualsDetailError("");
    setResidualsDetailLoading(true);

    const params = new URLSearchParams({ slug, action: "residuals", client_id: id });
    fetch(`/api/manage/clients?${params.toString()}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((data: QbResidualsDetailResponse) => {
        if (myReq !== residualsDetailReqRef.current) return; // stale
        if (!data || data.ok === false) {
          setResidualsDetailError(data?.error || "Impossibile caricare i residui.");
          return;
        }
        setResidualsDetail({
          services: Array.isArray(data.services) ? data.services : [],
          gifts: Array.isArray(data.gifts) ? data.gifts : [],
          giftboxes: Array.isArray(data.giftboxes) ? data.giftboxes : [],
          giftcards: Array.isArray(data.giftcards) ? data.giftcards : [],
          packages: Array.isArray(data.packages) ? data.packages : [],
          credit: data.credit && typeof data.credit === "object"
            ? { available: Number(data.credit.available ?? 0) || 0, count: Number(data.credit.count ?? 0) || 0 }
            : { available: 0, count: 0 },
        });
      })
      .catch(() => {
        if (myReq !== residualsDetailReqRef.current) return;
        setResidualsDetailError("Errore di rete durante il caricamento.");
      })
      .finally(() => {
        if (myReq !== residualsDetailReqRef.current) return;
        setResidualsDetailLoading(false);
      });
  }, [slug]);

  // ---- MODALE RESIDUI INTERATTIVA: stati locali (radio GiftCard + importo,
  // lock durante la verifica conflitti) ----
  const [gcSelId, setGcSelId] = useState<number | null>(null);
  const [gcAmountInput, setGcAmountInput] = useState<string>("");
  const [residualBusyKey, setResidualBusyKey] = useState<string>("");

  const openResidualsDetail = useCallback(() => {
    const id = String(clientId || "").trim();
    if (!id) return;
    // Sincronizza i controlli GiftCard della modale con lo stato applicato
    // (come il render legacy che rilegge #qb_giftcard_redeem all'apertura).
    setGcSelId(giftcardPick);
    setGcAmountInput(giftcardPick && giftcardAmount > 0 ? String(giftcardAmount) : "");
    // Show the modal immediately with a loading state (like the legacy).
    const el = document.getElementById("qbClientResidualsModal");
    const api = bootstrap()?.Modal;
    if (el && api) api.getOrCreateInstance(el).show();
    fetchResidualsDetail(id);
  }, [clientId, fetchResidualsDetail, giftcardPick, giftcardAmount, setGcSelId, setGcAmountInput]);

  // Dovuto PRIMA dei pagamenti (port di qbLastDueBeforePayments): base del clamp
  // GiftCard nella modale Residui. Il clamp credito riusa il memo creditMaxUsable
  // già definito sopra (min(saldo, dovuto dopo la GiftCard), come il recompute).
  const dueBeforePayments = Math.max(0, Math.round((priceDetails.subtotal - priceDetails.discount - priceDetails.coupon - priceDetails.fidelity) * 100) / 100);
  const currentCreditUse = priceDetails.credito;

  // Collega il servizio del residuo alla prenotazione (port di
  // qbEnsureServiceSelectedFromResidualCheckbox): se non è a listino, warning.
  const ensureServiceForResidual = useCallback((serviceId: number, label: string): boolean => {
    if (selectedServiceIds.includes(serviceId)) return true;
    if (!services.some((s) => s.id === serviceId)) {
      qbNotify(`Il servizio non è disponibile nel listino e non può essere aggiunto: ${label}`, "warning");
      return false;
    }
    toggleService(serviceId);
    return true;
  }, [selectedServiceIds, services, toggleService]);

  // Un servizio = UN solo residuo (port di qbResidualsRemoveServiceFromMaps +
  // qbResidualsUncheckOthersForService): pulisce le 4 mappe per quel servizio.
  const clearResidualMapsForService = useCallback((serviceId: number) => {
    setPackageRedeems((prev) => { const n = { ...prev }; delete n[serviceId]; return n; });
    setPrepaidRedeems((prev) => { const n = { ...prev }; delete n[serviceId]; return n; });
    setGiftboxRedeems((prev) => { const n = { ...prev }; delete n[serviceId]; return n; });
    setGiftRedeems((prev) => { const n = { ...prev }; delete n[serviceId]; return n; });
  }, [setPackageRedeems, setPrepaidRedeems, setGiftboxRedeems, setGiftRedeems]);

  // Handler unico spunte residui (port dell'handler change app.js:2845-3236):
  // check -> verifica conflitti (qb_residui_check) -> aggiunge il servizio ->
  // scrive la mappa del tipo (togliendo gli altri) -> toast success
  // "collegato/aggiunto"; uncheck -> rimuove servizio+mappe -> toast info.
  const onResidualToggle = useCallback(async (opts: {
    kind: ResidualKind;
    busyKey: string;
    serviceId: number;
    label: string;
    checked: boolean;
    checkItem: Record<string, unknown>;
    apply: () => void;
  }) => {
    const { kind, busyKey, serviceId, label, checked } = opts;
    if (!checked) {
      clearResidualMapsForService(serviceId);
      if (selectedServiceIds.includes(serviceId)) toggleService(serviceId);
      qbNotify(`Servizio rimosso dalla prenotazione: ${label}`, "info");
      return;
    }
    setResidualBusyKey(busyKey);
    try {
      try {
        const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({
            action: "qb_residui_check",
            appointment_id: Number(apptId) || 0,
            [RESIDUAL_CHECK_FIELD[kind]]: JSON.stringify([opts.checkItem]),
          }),
        });
        const chk: { ok?: boolean; error?: string; messages?: string[] } & Record<string, unknown> = await res.json().catch(() => ({}));
        if (!chk || chk.ok === false) {
          // Testi legacy GENERICI (app.js 810/815), non per-tipo.
          qbNotify(String(chk?.error || "Errore durante la verifica dei residui."), "danger");
          return;
        }
        const conflicts = chk[RESIDUAL_CHECK_COLLECTION[kind]];
        if (Array.isArray(conflicts) && conflicts.length > 0) {
          const msgs = Array.isArray(chk.messages) ? chk.messages.filter(Boolean) : [];
          qbNotify(msgs.length ? msgs.join(" | ") : RESIDUAL_CONFLICT_DEFAULT[kind], "warning");
          return;
        }
      } catch {
        qbNotify("Errore di rete durante la verifica dei residui.", "danger");
        return;
      }
      const wasSelected = selectedServiceIds.includes(serviceId);
      if (!ensureServiceForResidual(serviceId, label)) return;
      clearResidualMapsForService(serviceId);
      opts.apply();
      qbNotify(`${wasSelected ? RESIDUAL_TOAST[kind].linked : RESIDUAL_TOAST[kind].added}${label}`, "success");
    } finally {
      setResidualBusyKey("");
    }
  }, [slug, apptId, selectedServiceIds, ensureServiceForResidual, clearResidualMapsForService, toggleService, setResidualBusyKey]);

  // GiftCard in modale (port dei bottoni .qb-gc-apply / .qb-gc-remove / .qb-gc-max,
  // app.js:2348-2422): single-select + importo, con i toast verbatim.
  const applyModalGiftcard = useCallback(() => {
    if (!gcSelId) {
      qbNotify("Seleziona una GiftCard.", "warning");
      return;
    }
    const card = clientGiftcards.find((g) => g.id === gcSelId)
      ?? (residualsDetail?.giftcards ?? []).find((g) => g.id === gcSelId)
      ?? null;
    const bal = Math.max(0, Number(card?.balance ?? 0));
    if (!(dueBeforePayments > 0)) {
      qbNotify("Non c'è importo da applicare: il totale prenotazione è 0. Aggiungi prima i servizi.", "warning");
      return;
    }
    const maxUse = Math.min(bal, dueBeforePayments);
    const raw = Number(String(gcAmountInput).replace(",", "."));
    const amt = Math.min(Math.max(gcAmountInput.trim() !== "" && Number.isFinite(raw) ? raw : maxUse, 0), maxUse);
    if (!(amt > 0)) {
      qbNotify("Inserisci un importo valido.", "warning");
      return;
    }
    setGiftcardPick(gcSelId);
    setGiftcardAmountInput(String(Math.round(amt * 100) / 100));
    qbNotify("GiftCard applicata alla prenotazione.", "success");
  }, [gcSelId, gcAmountInput, clientGiftcards, residualsDetail, dueBeforePayments, setGiftcardPick, setGiftcardAmountInput]);

  const removeModalGiftcard = useCallback(() => {
    setGiftcardPick(null);
    setGiftcardAmountInput("");
    setGcSelId(null);
    setGcAmountInput("");
    qbNotify("GiftCard rimossa dalla prenotazione.", "info");
  }, [setGiftcardPick, setGiftcardAmountInput, setGcSelId, setGcAmountInput]);

  // ---- Per-item residual INFO modals (port of #qbPackageInfoModal /
  // #qbPrepaidServiceInfoModal / #qbGiftboxInfoModal / #qbGiftInfoModal /
  // #qbGiftcardInfoModal, View.php 1741-1896 + qbOpen*Info app.js 1584-2302).
  // Opened by clicking a service PILL linked to a redeem (or the GiftCard row
  // label); rendered React-driven from the residuals detail payload. ----
  type QbInfoModalState = {
    kind: "package" | "prepaid" | "giftbox" | "gift" | "giftcard";
    refId: number;
    serviceId: number;
    itemId?: number;
    usedAmount?: number;
  };
  const [infoModal, setInfoModal] = useState<QbInfoModalState | null>(null);
  // Funzione semplice (usata solo dalla JSX): il React Compiler la memoizza da
  // sé; la useCallback manuale confliggeva con l'inferenza delle dipendenze.
  const openResidualInfo = (state: QbInfoModalState) => {
    setInfoModal(state);
    // Load the detail payload if not already fetched for this client.
    const id = String(clientId || "").trim();
    if (id && !residualsDetail && !residualsDetailLoading) fetchResidualsDetail(id);
  };

  // Whether the fetched residuals detail has ANY content (drives the empty-state).
  const residualsDetailHasAny = !!(
    residualsDetail &&
    (residualsDetail.services.length ||
      residualsDetail.gifts.length ||
      residualsDetail.giftboxes.length ||
      residualsDetail.giftcards.length ||
      residualsDetail.packages.length ||
      residualsDetail.credit.count > 0)
  );

  // Derived display state for the two boxes (no extra render-state).
  const historyLine = historySummary ? buildHistoryLine(historySummary) : "";
  const residualBadges = residualsSummary ? buildResidualBadges(residualsSummary) : [];
  const hasResiduals = residualBadges.length > 0;

  // EDIT MODE flag: a non-empty #qb_appt_id means the drawer is editing an existing
  // appointment (loaded via [data-qb-edit]); it drives the header title, the booking
  // code row and the submit label. Empty -> CREATE mode (the default).
  const isEditMode = apptId.trim() !== "";

  // Create a new client (port of qbSubmitClientCreate). Posts to the existing
  // manage clients route (action=create); on success it becomes the selected
  // client. We send name (first+last), email, phone and location_id.
  const submitNewClient = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const form = e.currentTarget;
      const fd = new FormData(form);
      const first = String(fd.get("first_name") ?? "").trim();
      const last = String(fd.get("last_name") ?? "").trim();
      const name = `${first} ${last}`.trim();
      if (!first || !last) {
        setCreateError("Nome e cognome obbligatori.");
        return;
      }
      // Email / PEC client-side validation, mirroring the legacy create_quick guards.
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      const emailVal = String(fd.get("email") ?? "").trim();
      const pecVal = String(fd.get("pec") ?? "").trim();
      if (emailVal && !emailRe.test(emailVal)) {
        setCreateError("Email non valida.");
        return;
      }
      if (pecVal && !emailRe.test(pecVal)) {
        setCreateError("PEC non valida.");
        return;
      }
      setCreateError("");
      setCreateSaving(true);
      try {
        // Send EVERY named field the form collects (the backend clientInputFromBody accepts
        // all 22 anagrafica fields — first_name/last_name/gender/birth_date/address/fiscal/…),
        // instead of hand-picking 5. Faithful port of the legacy qbSubmitClientCreate, which
        // serializes the whole form. `name` (first+last joined) is added for the backend's
        // name field alongside the individual first_name/last_name.
        const body: Record<string, string> = { action: "create", name };
        for (const [key, value] of fd.entries()) {
          if (typeof value === "string" && key !== "action") body[key] = value;
        }
        const res = await fetch(`/api/manage/clients?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify(body),
        });
        const data: { ok?: boolean; error?: string; client?: { id: number; name: string; email?: string; phone?: string } } =
          await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false || !data.client) {
          setCreateError(String(data.error || "Errore creazione cliente."));
          return;
        }
        selectClient({
          id: String(data.client.id),
          full_name: data.client.name ?? name,
          email: data.client.email ?? String(fd.get("email") ?? ""),
          phone: data.client.phone ?? String(fd.get("phone") ?? ""),
        });
        qbNotify("Cliente creato", "success");
        const el = document.getElementById("qbClientCreateModal");
        const api = bootstrap()?.Modal;
        if (el && api) api.getOrCreateInstance(el).hide();
      } catch {
        setCreateError("Errore di rete durante la creazione del cliente.");
      } finally {
        setCreateSaving(false);
      }
    },
    [slug, selectClient],
  );

  // ---- Availability ([Disponibilita] -> action=hold_availability) ----
  const selectedServiceNames = useCallback(
    () => selectedServiceIds.map((id) => services.find((s) => s.id === id)?.name ?? "").filter(Boolean),
    [selectedServiceIds, services],
  );

  const runAvailability = useCallback(async () => {
    setFormError("");
    const names = selectedServiceNames();
    if (!names.length || !date || !startTime) {
      setFormError("Seleziona prima servizio, data e ora.");
      return;
    }
    setAvailLoading(true);
    try {
      const staffName = staffId ? staff.find((s) => String(s.id) === staffId)?.name ?? "" : "";
      const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({
          action: "hold_availability",
          date,
          time: startTime,
          service_names: names.join(","),
          staff_name: staffName,
          location_id: locationId,
        }),
      });
      const data: { ok?: boolean; error?: string; token?: string; time?: string; staffName?: string; staffId?: number | null } =
        await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false || !data.token) {
        setFormError(String(data.error || "Orario non piu disponibile. Ricarica e scegli un altro slot."));
        return;
      }
      holdExpiresRef.current = Date.now() + HOLD_TTL_MS;
      setHoldToken(data.token);
      if (data.time) setStartTime(data.time);
      // Auto-assign the operator the hold resolved (when none was chosen).
      if (!staffId && data.staffId && data.staffId > 0) setStaffId(String(data.staffId));
      // TODO(cabin/staff maps): the hold also returns cabin/segment allocations
      // (#qb_cabin_id / #qb_staff_map / #qb_cabin_map). The manage save route does
      // not yet consume per-service maps, so they are left unwired here.
    } catch {
      setFormError("Errore di rete durante il controllo disponibilita.");
    } finally {
      setAvailLoading(false);
    }
  }, [selectedServiceNames, date, startTime, staffId, staff, slug, locationId]);

  // ---- "Disponibilità" MODAL (port of #qbAvailabilityModal, app.js ~9979-11360) ----
  // The button opens an XL modal that browses availability per period: Giorno =
  // full-day 5-min timeline (blue available, orange fuori-orario selezionabile,
  // red booked), Settimana/Mese = per-day summary list (counts + primo orario +
  // hours) whose day click drills into the day view. Clicking a selectable bar
  // creates the hold and fills date/time (legacy applyAvailabilitySlot). Data
  // from action=availability with range/summary (manageAvailabilityBrowser),
  // verified live identical to the legacy payload.
  type QbAvailDay = {
    date: string;
    label: string;
    label_full: string;
    slots: string[];
    override_slots: string[];
    regular_slot_count: number;
    first_regular_slot: string | null;
    booked: string[];
    booked_outside: string[];
    dst_gap: string[];
    dst_fold: string[];
    is_closed: 0 | 1;
    opens: string | null;
    closes: string | null;
    opens2: string | null;
    closes2: string | null;
  };
  type QbAvailMonth = { label: string; days: QbAvailDay[] };
  const [availModalOpen, setAvailModalOpen] = useState(false);
  const [availMode, setAvailMode] = useState<"day" | "week" | "month">("week");
  const [availAnchor, setAvailAnchor] = useState<string>("");
  const [availMonths, setAvailMonths] = useState<QbAvailMonth[] | null>(null);
  const [availRangeLabel, setAvailRangeLabel] = useState<string>("");
  const [availBrowserLoading, setAvailBrowserLoading] = useState(false);
  const [availModalError, setAvailModalError] = useState<string>("");
  // Hover tooltip on the day-view bars (port of the legacy lazy Bootstrap
  // tooltips, app.js ensureAvailTooltip: dark top tooltip shown IMMEDIATELY
  // with "3 Luglio" + bold HH:MM + the state line). Rendered as a fixed
  // Bootstrap-styled tooltip driven by React state (no bootstrap.Tooltip
  // instances to dispose across re-renders).
  const [availHoverTip, setAvailHoverTip] = useState<{ left: number; top: number; day: string; time: string; state: string | null; muted: boolean } | null>(null);
  const [availApplying, setAvailApplying] = useState(false);
  const availSeqRef = useRef(0);

  const loadAvailabilityPeriod = useCallback(async (anchorDate: string, mode: "day" | "week" | "month") => {
    const safeDate = mode === "month" ? firstOfMonthYMD(anchorDate) : mode === "week" ? startOfWeekYMD(anchorDate) : anchorDate;
    setAvailAnchor(safeDate);
    setAvailMode(mode);
    setAvailModalError("");
    setAvailHoverTip(null); // the bars re-render: never leave a stale tooltip
    setAvailBrowserLoading(true);
    const seq = ++availSeqRef.current;
    try {
      const params = new URLSearchParams();
      params.set("slug", slug);
      params.set("action", "availability");
      params.set("date", safeDate);
      params.set("range", mode);
      if (mode === "month") params.set("months", "1");
      if (mode !== "day") params.set("summary", "1");
      params.set("service_ids", selectedServiceIds.join(","));
      if (staffId) params.set("staff_id", staffId);
      if (locationId) params.set("location_id", String(locationId));
      if (apptId.trim()) params.set("exclude_id", apptId.trim());
      const res = await fetch(`/api/manage/appointments?${params.toString()}`, { headers: { "x-tenant-slug": slug } });
      const data: { ok?: boolean; error?: string; months?: QbAvailMonth[]; range_start?: string; range_end?: string } =
        await res.json().catch(() => ({}));
      if (seq !== availSeqRef.current) return;
      if (!res.ok || !data.ok || !Array.isArray(data.months)) {
        setAvailMonths(null);
        setAvailModalError(String(data.error || "Errore caricamento disponibilità."));
        return;
      }
      setAvailMonths(data.months);
      // Range label (legacy formatAvailRangeLabel): the month label in month
      // mode, else "GG/MM/AAAA - GG/MM/AAAA" (single date when one day).
      const rs = String(data.range_start ?? safeDate);
      const re = String(data.range_end ?? rs);
      if (mode === "month" && data.months.length === 1 && data.months[0]?.label) setAvailRangeLabel(data.months[0].label);
      else setAvailRangeLabel(!re || re === rs ? fmtDMY(rs) : `${fmtDMY(rs)} - ${fmtDMY(re)}`);
    } catch {
      if (seq === availSeqRef.current) {
        setAvailMonths(null);
        setAvailModalError("Errore caricamento disponibilità.");
      }
    } finally {
      if (seq === availSeqRef.current) setAvailBrowserLoading(false);
    }
    // I setter (stabili) sono elencati per riconciliare l'inferenza del React
    // Compiler con la memoizzazione manuale, come closeAvailabilityModal.
  }, [slug, selectedServiceIds, staffId, locationId, apptId, setAvailAnchor, setAvailMode, setAvailModalError, setAvailHoverTip, setAvailBrowserLoading, setAvailMonths, setAvailRangeLabel]);

  // Open (port of openAvailability, app.js:11088-11103): pre-check legacy come
  // TOAST warning (non alert inline), poi apertura in vista settimana.
  const openAvailabilityModal = useCallback(() => {
    setFormError("");
    if (!date) {
      qbNotify("Seleziona una data di inizio", "warning");
      return;
    }
    if (!selectedServiceIds.length) {
      qbNotify("Seleziona almeno un servizio", "warning");
      return;
    }
    if (!operatorSelectionComplete) {
      qbNotify(isMultiService ? "Seleziona gli operatori per i servizi" : "Nessun operatore disponibile per il servizio selezionato", "warning");
      return;
    }
    setAvailModalOpen(true);
    void loadAvailabilityPeriod(date, "week");
  }, [date, selectedServiceIds, operatorSelectionComplete, isMultiService, loadAvailabilityPeriod]);

  const closeAvailabilityModal = useCallback(() => {
    availSeqRef.current++;
    setAvailModalOpen(false);
    setAvailHoverTip(null);
    // I setter sono stabili: elencarli riconcilia l'inferenza del compiler
    // con la memoizzazione manuale (identità stabile per le deps a valle).
  }, [setAvailModalOpen, setAvailHoverTip]);

  // Slot click (port of applyAvailabilitySlot): create the hold for the chosen
  // date/time, then fill the form via the RAW setters (changeDate/changeStartTime
  // would drop the hold just created) and close. On failure show the error and
  // reload the period so the grid reflects the real state.
  const applyAvailabilitySlot = useCallback(async (slotDate: string, slotTime: string) => {
    if (availApplying || !slotDate || !slotTime) return;
    setAvailApplying(true);
    try {
      const names = selectedServiceNames();
      const staffName = staffId ? staff.find((s) => String(s.id) === staffId)?.name ?? "" : "";
      const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({
          action: "hold_availability",
          date: slotDate,
          time: slotTime,
          service_names: names.join(","),
          staff_name: staffName,
          location_id: locationId,
        }),
      });
      const data: { ok?: boolean; error?: string; token?: string; time?: string; staffId?: number | null } =
        await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false || !data.token) {
        setAvailModalError(String(data.error || "Orario non piu disponibile. Ricarica e scegli un altro slot."));
        void loadAvailabilityPeriod(slotDate, availMode);
        return;
      }
      holdExpiresRef.current = Date.now() + HOLD_TTL_MS;
      setHoldToken(data.token);
      setDate(slotDate);
      setStartTime(data.time || slotTime);
      setPrefillEndTime("");
      if (!staffId && data.staffId && data.staffId > 0) setStaffId(String(data.staffId));
      closeAvailabilityModal();
    } catch {
      setAvailModalError("Errore di rete durante il controllo disponibilita.");
    } finally {
      setAvailApplying(false);
    }
  }, [availApplying, selectedServiceNames, staffId, staff, slug, locationId, availMode, loadAvailabilityPeriod, closeAvailabilityModal]);

  // Prev / Oggi / Next (legacy period navigation per mode).
  const availNavigate = useCallback((direction: -1 | 0 | 1) => {
    const anchor = availAnchor || date || todayIso();
    let next = anchor;
    if (direction === 0) next = todayIso();
    else if (availMode === "day") next = addDaysYMD(anchor, direction);
    else if (availMode === "week") next = addDaysYMD(anchor, direction * 7);
    else next = addMonthsYMD(anchor, direction);
    void loadAvailabilityPeriod(next, availMode);
  }, [availAnchor, availMode, date, loadAvailabilityPeriod]);

  // Item B: calendar-slot auto-hold (port of qbApplyPendingCalendarSlot ~9841). When the drawer
  // was opened from a calendar empty-cell (date+time seeded — pendingCalendarSlotRef armed), fire
  // the availability hold ONCE as soon as a service is selected AND the operator selection is
  // resolvable — so the operator no longer has to click "Disponibilità". Guards: only while the
  // ref is armed, no hold yet, not already checking; the ref is CONSUMED before firing so it runs
  // at most once. If the cell had no service (the common empty-cell case), nothing happens until a
  // service is picked — the effect just waits (the ref stays armed).
  useEffect(() => {
    if (!pendingCalendarSlotRef.current) return;
    if (holdToken || availLoading) return;
    if (!selectedServiceIds.length || !date || !startTime) return;
    if (!operatorSelectionComplete) return;
    // Defer the hold to a macrotask (like the legacy qbSchedulePendingCalendarSlotApply) so the
    // setState inside runAvailability runs outside this effect's render (no cascading-render). The
    // pending ref is CONSUMED inside the timeout (not synchronously), so if the effect re-runs and
    // its cleanup cancels this timer before it fires, the still-armed ref lets it reschedule.
    const t = setTimeout(() => {
      pendingCalendarSlotRef.current = false; // consume: auto-hold fires once per calendar open
      void runAvailability();
    }, 0);
    return () => clearTimeout(t);
  }, [selectedServiceIds, date, startTime, operatorSelectionComplete, holdToken, availLoading, runAvailability]);

  // ---- Submit ("Crea prenotazione" -> action=save) ----
  // Close/abort the cancel-done modal. Resolves the pending save() promise with `result`
  // (null = abort, { reason } = confirmed) then hides the Bootstrap modal + resets state.
  const closeDoneCancelModal = useCallback((result: { reason: string } | null) => {
    const resolve = doneCancelResolveRef.current;
    doneCancelResolveRef.current = null;
    const el = document.getElementById("qbDoneCancelModal");
    const api = bootstrap()?.Modal;
    if (el && api) {
      try {
        api.getOrCreateInstance(el).hide();
      } catch {
        /* no-op */
      }
    }
    if (resolve) resolve(result);
  }, []);

  // Open the cancel-done preview modal for a done->target transition and return a promise
  // that resolves to { reason } on Confirm or null on abort (port of app.js
  // qbOpenDoneCancelPreview + qbSubmitDoneCancel decision gate). Fetches
  // action=cancel_done_preview (compute-only), renders the preview, and gates Confirm on
  // the preview being ok with no blockers.
  const openDoneCancelModal = useCallback(
    (id: string, target: "canceled" | "no_show", opts?: { pendingOnly?: boolean }): Promise<{ reason: string } | null> => {
      return new Promise((resolve) => {
        doneCancelResolveRef.current = resolve;
        setDoneCancelTarget(target);
        setDoneCancelReason("");
        setDoneCancelError("");
        setDoneCancelPreview(null);
        setDoneCancelLoading(true);
        // Show the Bootstrap modal.
        const el = document.getElementById("qbDoneCancelModal");
        const api = bootstrap()?.Modal;
        if (el && api) {
          try {
            api.getOrCreateInstance(el).show();
          } catch {
            /* no-op */
          }
        }
        // Fetch the compute-only preview (GET, gated appointments.manage).
        void (async () => {
          try {
            const res = await fetch(
              `/api/manage/appointments?slug=${encodeURIComponent(slug)}&action=cancel_done_preview&id=${encodeURIComponent(
                id,
              )}&target_status=${encodeURIComponent(target)}`,
              { headers: { "x-tenant-slug": slug } },
            );
            const data: { ok?: boolean; error?: string; preview?: DoneCancelPreview } = await res
              .json()
              .catch(() => ({}));
            // Gate pendingOnly della pagina Notifiche (app.js 5431-5433): se la
            // richiesta non risulta più in attesa il popup si CHIUDE con il
            // toast danger legacy, senza mostrare l'anteprima.
            if (opts?.pendingOnly && normalizeApptStatus(String(data.preview?.status ?? "")) !== "pending") {
              qbNotify("La richiesta non e piu in attesa: aggiorna la pagina Notifiche.", "danger");
              const pendingResolve = doneCancelResolveRef.current;
              doneCancelResolveRef.current = null;
              const modalEl = document.getElementById("qbDoneCancelModal");
              const modalApi = bootstrap()?.Modal;
              if (modalEl && modalApi) {
                try {
                  modalApi.getOrCreateInstance(modalEl).hide();
                } catch {
                  /* no-op */
                }
              }
              if (pendingResolve) pendingResolve(null);
              return;
            }
            if (data.preview) setDoneCancelPreview(data.preview);
            // Error surfaces inline in the modal AND disables Confirm (matches the legacy
            // "Annullamento non disponibile" gate).
            if (!data.ok || data.error || data.preview?.error) {
              setDoneCancelError(String(data.error || data.preview?.error || "Annullamento non disponibile."));
            }
          } catch {
            setDoneCancelError("Errore caricamento annullamento.");
          } finally {
            setDoneCancelLoading(false);
          }
        })();
      });
    },
    [slug],
  );

  // Ponte esterno legacy (app.js 11325-11332 + notifications_quotes.js): la
  // pagina Notifiche apre il popup di annullamento SENZA aprire l'offcanvas,
  // con pendingOnly; alla conferma applica action=cancel_done con
  // pending_only=1 e richiama onSuccess (toast 'Prenotazione annullata' +
  // warnings + refetch calendario come qbSubmitDoneCancel 5500-5520).
  useEffect(() => {
    type ExternalCancelOpts = {
      external?: boolean;
      pendingOnly?: boolean;
      originalStatus?: string;
      targetStatus?: string;
      onSuccess?: (data: unknown) => void;
    };
    const open = (rawId: unknown, rawOpts?: ExternalCancelOpts) => {
      const id = Number.parseInt(String(rawId ?? "").trim(), 10) || 0;
      if (!(id > 0)) return;
      const opts = rawOpts && typeof rawOpts === "object" ? rawOpts : {};
      const target = normalizeApptStatus(String(opts.targetStatus ?? "canceled")) === "no_show" ? ("no_show" as const) : ("canceled" as const);
      void (async () => {
        const decision = await openDoneCancelModal(String(id), target, { pendingOnly: Boolean(opts.pendingOnly) });
        if (!decision) return;
        try {
          const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
            body: JSON.stringify({
              action: "cancel_done",
              id: String(id),
              status: target,
              reason: decision.reason,
              ...(opts.pendingOnly ? { pending_only: "1" } : {}),
            }),
          });
          const data: { ok?: boolean; error?: string; warnings?: string[] } = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false || data.error) {
            qbNotify(String(data.error || "Errore annullamento"), "danger");
            return;
          }
          qbNotify(target === "no_show" ? "Prenotazione marcata No show" : "Prenotazione annullata", "success");
          for (const w of Array.isArray(data.warnings) ? data.warnings : []) {
            if (w) qbNotify(String(w), "warning");
          }
          qbRefetchCalendar();
          if (typeof opts.onSuccess === "function") {
            try {
              opts.onSuccess(data);
            } catch {
              /* noop */
            }
          }
        } catch {
          qbNotify("Errore annullamento", "danger");
        }
      })();
    };
    const api = { open, close: () => closeDoneCancelModal(null) };
    (window as unknown as { qbAppointmentCancelDialog?: typeof api }).qbAppointmentCancelDialog = api;
    return () => {
      delete (window as unknown as { qbAppointmentCancelDialog?: typeof api }).qbAppointmentCancelDialog;
    };
  }, [slug, openDoneCancelModal, closeDoneCancelModal]);

  const submitBooking = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setFormError("");
      // GUARDIA HOLD SCADUTO (app.js 11337 qbHoldIsExpired → qbHandleHoldExpired):
      // PRIMA di ogni altra cosa, con un hold attivo oltre il TTL si puliscono
      // token/orari/cabina e si mostra il messaggio default verbatim.
      if (holdTokenRef.current && holdExpiresRef.current > 0 && Date.now() > holdExpiresRef.current) {
        setHoldToken("");
        holdTokenRef.current = "";
        holdExpiresRef.current = 0;
        setStartTime("");
        setPrefillEndTime("");
        setCabinId("");
        setCabinPicks({});
        qbNotify("La disponibilita selezionata e scaduta. Scegli di nuovo uno slot.", "warning");
        return;
      }
      // Locked-appointment guard (port of the legacy submit check on
      // qbIsCanceledLockedMode, app.js:11337): toast warning, non alert inline.
      if (apptId && (originalStatus === "canceled" || originalStatus === "no_show")) {
        qbNotify("La prenotazione annullata non è modificabile.", "warning");
        return;
      }
      // ROUTING ANNULLAMENTO (port di app.js ~11340): il submit che chiede
      // canceled/no_show da pending/scheduled/done NON salva — apre il popup
      // dedicato; alla conferma è cancel_done ad applicare lo stato (gli altri
      // campi del form NON vengono persistiti, come nel legacy). Popup chiuso
      // senza conferma = nessuna azione e nessun messaggio.
      const requestedStatus = status.trim();
      if (
        apptId
        && (originalStatus === "pending" || originalStatus === "scheduled" || originalStatus === "done")
        && (requestedStatus === "canceled" || requestedStatus === "no_show")
      ) {
        const decision = await openDoneCancelModal(apptId, requestedStatus === "no_show" ? "no_show" : "canceled");
        if (!decision) return;
        setSubmitting(true);
        try {
          const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
            body: JSON.stringify({ action: "cancel_done", id: apptId, status: requestedStatus, reason: decision.reason }),
          });
          const data: { ok?: boolean; error?: string; warnings?: string[] } = await res.json().catch(() => ({}));
          if (!res.ok || data.ok === false || data.error) {
            qbNotify(String(data.error || "Errore annullamento"), "danger");
            return;
          }
          qbNotify(requestedStatus === "no_show" ? "Prenotazione marcata No show" : "Prenotazione annullata", "success");
          for (const w of Array.isArray(data.warnings) ? data.warnings : []) {
            if (w) qbNotify(String(w), "warning");
          }
          closeOffcanvas();
          qbRefetchCalendar();
        } catch {
          qbNotify("Errore annullamento", "danger");
        } finally {
          setSubmitting(false);
        }
        return;
      }
      const names = selectedServiceNames();
      // Validazioni client-side legacy (app.js:11374-11378): SOLO cliente e
      // data/orario, come toast warning senza punto finale. Il controllo servizi
      // è lato server ("Seleziona almeno un servizio.", mostrato come toast danger).
      if (!client) {
        qbNotify("Seleziona o crea un cliente", "warning");
        return;
      }
      if (!date || !startTime) {
        qbNotify("Inserisci data e orario", "warning");
        return;
      }
      setSubmitting(true);
      try {
        const staffName = staffId ? staff.find((s) => String(s.id) === staffId)?.name ?? "" : "";
        // MULTI-SERVICE: send ALL selected service names (ordered) so the save
        // route lays them out as sequential segments. For 2+ services the
        // per-service operator picker (#qbMultiStaffPicker) fills `staff_map`
        // ({serviceId: staffId} JSON) so each segment gets its own operator; for
        // a single service the whole-appointment operator (`staff_name`) drives
        // it and the map is empty. The explicit cabin (`cabin_id`) is the
        // primary cabin; for 2+ services the per-service cabin picker fills
        // `cabin_map` ({serviceId: cabinId} JSON) so each segment gets its cabin.
        // TODO(cabin availability): the legacy populates the per-service cabin
        // selects with only the FREE cabins from the availability check
        // (refreshCabinsForServices) which needs the availability/cabin API not
        // yet wired in the Next manage app; here we offer the location's cabins.
        const staffMapRaw = staffMapJson;
        const cabinMapRaw = cabinMapJson;
        const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({
            action: "save",
            // EDIT MODE: a non-empty id routes the save to updateDbAppointment
            // (in-place update); empty -> createDbAppointment (new booking). The
            // route reads `id` as the edit discriminator (Number.parseInt > 0).
            id: apptId,
            // client_id ESPLICITO (#qb_client_id legacy): la route lo preferisce
            // al nome — la sola client_name mis-lega i clienti OMONIMI.
            client_id: client.id ? String(client.id) : "",
            client_name: client.full_name,
            // Send ids (robust, ordered) AND names (the route prefers ids).
            service_ids: selectedServiceIds.join(","),
            service_names: names,
            staff_name: staffName,
            staff_map: staffMapRaw,
            cabin_map: cabinMapRaw,
            cabin_id: effectiveCabinId,
            // PACKAGE redeem: per-service requests to cover a service with the
            // client's prepaid package (re-validated + consumed server-side).
            package_redeem: packageRedeemJson,
            // PREPAID-SERVICE redeem: per-service requests to cover a service with the
            // client's prepaid-service balance (re-validated + consumed server-side).
            // Sent as a JSON STRING (parseRequestBody stringifies body values).
            prepaid_service_redeem: prepaidRedeemJson,
            // GIFTCARD redeem: an APPOINTMENT-LEVEL request to apply the client's
            // giftcard balance (a monetary amount) toward the appointment (re-validated
            // + clamped + decremented server-side). Sent as a JSON STRING [{giftcard_id,
            // amount}] (parseRequestBody stringifies body values).
            giftcard_redeem: giftcardRedeemJson,
            // GIFTBOX redeem: per-service requests to cover a service with ONE ITEM from
            // the client's giftbox (re-validated + the redemption recorded server-side).
            // Sent as a JSON STRING [{service_id, instance_id, giftbox_item_id}]
            // (parseRequestBody stringifies body values).
            giftbox_redeem: giftboxRedeemJson,
            // GIFT (omaggio) redeem: per-service requests to cover a service with ONE REWARD
            // from the client's gift (re-validated + the redemption recorded server-side).
            // Sent as a JSON STRING [{service_id, instance_id, reward_item_index}]
            // (parseRequestBody stringifies body values).
            gift_redeem: giftRedeemJson,
            // Manual SCONTO: the staff's discount type/value shown in the price panel.
            // discount_value is persisted on the appointment (discount_type/discount_value
            // columns); the route threads it into create/updateDbAppointment. Sent as the
            // raw value the recompute used (the server clamps it the same way).
            discount_type: discountType,
            discount_value: discountValue,
            // COUPON: the applied code + its preview discount (only when actually applied),
            // mirroring the hidden #qb_coupon_code / #qb_coupon_discount inputs. Persisted by the
            // save route into appointments.notes (coupon_apply_meta_to_notes) — the table has no
            // coupon columns — and read back on action=get for the edit prefill (Block 4).
            coupon_code: priceDetails.couponApplied ? couponCode : "",
            coupon_discount: priceDetails.couponApplied ? String(priceDetails.coupon) : "0",
            // Block 4 FIDELITY: the points the staff chose to redeem (0 when none / redeem off).
            // Persisted on appointments.fidelity_points_used; settled (-points_redeem) on done by
            // awardAppointmentFidelityOnDone; refunded on cancel. Derived by the recompute so the
            // posted value always matches the displayed "Sconto Fidelity".
            fidelity_points_use: String(priceDetails.fidelityPointsUsed || 0),
            // Block 4 CREDIT: the customer credit applied (0 when none). Persisted on
            // appointments.credit_used + debited from the wallet at create; refunded on cancel.
            credit_use: String(priceDetails.credito || 0),
            date,
            time: startTime,
            location_id: locationId,
            // STATO selezionato nel drawer (In attesa/Prenotato/...): senza questo campo
            // il CREATE ignorava la select e salvava sempre il default backend
            // ("Prenotato" selezionato -> salvato "In attesa"). In EDIT
            // updateDbAppointment lo ignora (le transizioni passano dal blocco
            // action=status più sotto), quindi inviarlo sempre è innocuo e rende il
            // payload identico al form PHP (che invia sempre `status`).
            status,
            staff_notes: staffNotes,
            customer_notes: customerNotes,
            appointment_hold_token: holdToken,
          }),
        });
        const data: { ok?: boolean; error?: string; warnings?: string[]; packageWarnings?: string[]; prepaidWarnings?: string[]; giftcardWarnings?: string[]; giftboxWarnings?: string[]; giftWarnings?: string[] } = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false || data.error) {
          const msg = String(data.error || "Errore salvataggio");
          // EXPIRED-HOLD recovery (port fedele di app.js:11386-11392 +
          // qbHandleHoldExpired ~3374-3393): SOLO con un hold attivo, se l'errore
          // matcha la famiglia riserva/disponibilità/orario/cabina si puliscono
          // token, orari e cabina e si mostra il messaggio del server come toast
          // WARNING. La regex include anche i messaggi hold del server Next
          // ("Hold appuntamento scaduto o non valido." / "Hold non coerente con
          // ...") così il recovery scatta pure su quelli. Ogni altro errore è un
          // toast DANGER (il legacy non ha alert inline sul submit).
          if (holdTokenRef.current && /riserva|disponibilit|orario non piu disponibile|orario non più disponibile|cabina|\bhold\b|coerente|scadut/i.test(msg)) {
            setHoldToken("");
            holdTokenRef.current = "";
            setStartTime("");
            setPrefillEndTime("");
            setCabinId("");
            setCabinPicks({});
            qbNotify(msg, "warning");
            return;
          }
          qbNotify(msg, "danger");
          return;
        }
        // STATUS TRANSITION non-cancel (solo edit): action=save non persiste lo
        // status (updateDbAppointment lo ignora); il legacy lo persiste nel save,
        // qui la transizione equivalente passa da action=status DOPO il save.
        // (Gli annullamenti sono già stati instradati sul popup PRIMA del save.)
        const newStatus = status.trim();
        if (apptId && originalStatus && newStatus && newStatus !== originalStatus) {
          const transitionRes = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
            body: JSON.stringify({ action: "status", id: apptId, status: newStatus }),
          });
          const transitionData: { ok?: boolean; error?: string } = await transitionRes.json().catch(() => ({}));
          if (!transitionRes.ok || transitionData.ok === false || transitionData.error) {
            qbNotify(String(transitionData.error || "Errore cambio stato."), "danger");
            return;
          }
        }

        // Esito legacy (app.js:11394-11413): chiudi, toast success, ogni warning
        // come toast warning, refresh SOLO del calendario. Nessun reload.
        closeOffcanvas();
        qbNotify("Appuntamento salvato", "success");
        const allWarnings = [
          ...(Array.isArray(data.warnings) ? data.warnings : []),
          ...(Array.isArray(data.packageWarnings) ? data.packageWarnings : []),
          ...(Array.isArray(data.prepaidWarnings) ? data.prepaidWarnings : []),
          ...(Array.isArray(data.giftcardWarnings) ? data.giftcardWarnings : []),
          ...(Array.isArray(data.giftboxWarnings) ? data.giftboxWarnings : []),
          ...(Array.isArray(data.giftWarnings) ? data.giftWarnings : []),
        ];
        for (const w of allWarnings) {
          if (w) qbNotify(String(w), "warning");
        }
        qbRefetchCalendar();
      } catch {
        qbNotify("Errore salvataggio", "danger");
      } finally {
        setSubmitting(false);
      }
    },
    [apptId, client, selectedServiceIds, selectedServiceNames, date, startTime, staffId, staff, slug, locationId, effectiveCabinId, staffNotes, customerNotes, holdToken, staffMapJson, cabinMapJson, packageRedeemJson, prepaidRedeemJson, giftcardRedeemJson, giftboxRedeemJson, giftRedeemJson, discountType, discountValue, couponCode, priceDetails, status, originalStatus, closeOffcanvas, openDoneCancelModal],
  );

  // ---- Delete (#qbDeleteBtn, edit mode only -> action=delete) ----
  // Port fedele di app.js:11416-11447: guardia client-side sullo stato Annullato
  // (toast warning), confirm nativa "Eliminare questo appuntamento?", errori come
  // toast danger, esito "Appuntamento eliminato" + refresh del solo calendario
  // (nessun reload di pagina).
  const deleteBooking = useCallback(async () => {
    if (!apptId) return;
    if (originalStatus !== "canceled") {
      qbNotify("La prenotazione deve essere in stato Annullato. Annullala prima per poterla eliminare.", "warning");
      return;
    }
    if (typeof window !== "undefined" && !window.confirm("Eliminare questo appuntamento?")) return;
    setSubmitting(true);
    setFormError("");
    try {
      const res = await fetch(`/api/manage/appointments?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "delete", id: apptId }),
      });
      const data: { ok?: boolean; error?: string } = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false || data.error) {
        qbNotify(String(data.error || "Errore eliminazione"), "danger");
        return;
      }
      closeOffcanvas();
      qbNotify("Appuntamento eliminato", "success");
      qbRefetchCalendar();
    } catch {
      qbNotify("Errore eliminazione", "danger");
    } finally {
      setSubmitting(false);
    }
  }, [apptId, originalStatus, slug, closeOffcanvas]);

  const canQuickCreateClient = true; // Quick-create is always offered (legacy gates on a permission).

  // STATUS <select> constraints (port of app.js qbApplyStatusSelectConstraints): the
  // options the status select offers depend on the appointment's ORIGINAL (as-loaded)
  // status, so the operator can only make valid transitions from the drawer:
  //   - originalStatus canceled|no_show : terminal — a single locked, disabled option.
  //   - originalStatus done             : only Eseguito / Annulla / No show (the done
  //     booking can stay done or go through the dedicated cancel-done flow).
  //   - otherwise (create / pending / scheduled) : the full list.
  const statusLocked = originalStatus === "canceled" || originalStatus === "no_show";
  const statusOptions: { value: string; label: string }[] = statusLocked
    ? [{ value: originalStatus, label: originalStatus === "no_show" ? "No show" : "Annullato" }]
    : originalStatus === "done"
      ? [
          { value: "done", label: "Eseguito" },
          { value: "canceled", label: "Annulla" },
          { value: "no_show", label: "No show" },
        ]
      : [
          { value: "pending", label: "In attesa" },
          { value: "scheduled", label: "Prenotato" },
          { value: "done", label: "Eseguito" },
          { value: "canceled", label: "Annullato" },
          { value: "no_show", label: "No show" },
        ];

  // LOCKED-appointment mode (port of qbIsCanceledLockedMode + qbSetLockedAppointmentMode):
  // editing an appointment whose ORIGINAL status is canceled/no_show freezes the whole
  // form — every field disabled, the client links inert, the submit disabled with the
  // status as its label — and shows the #qbCancellationAlert. The delete button stays
  // usable ONLY for canceled (legacy keepDeleteEnabled); no_show disables it too.
  const formLocked = Boolean(apptId) && statusLocked;

  return (
    <>
      {/* ===================== OFFCANVAS (verbatim from View.php) ===================== */}
      <div className="offcanvas offcanvas-end" tabIndex={-1} id="quickBooking" aria-labelledby="quickBookingLabel">
        <div className="offcanvas-header">
          <div>
            <div className="small-muted">Agenda</div>
            <h5 className="offcanvas-title fw-bold" id="quickBookingLabel">
              {isEditMode ? "Modifica prenotazione" : "Nuova prenotazione"}
            </h5>
            <div id="qbBookingCodeRow" className="small text-muted mt-1" style={{ display: isEditMode && bookingCode ? "block" : "none" }}>
              Codice prenotazione: <code id="qbBookingCode">{bookingCode ? `#${bookingCode}` : ""}</code>
            </div>
            {/* Item 3: expired-linked residual warning (React-driven, was hardcoded display:none). */}
            <div
              id="qbExpiredLinkedAlert"
              className="alert alert-warning small py-2 px-2 mt-2 mb-0"
              style={{ display: expiredLinkWarning ? "block" : "none" }}
            >
              {expiredLinkWarning}
            </div>
          </div>
          <button type="button" className="btn-close" data-bs-dismiss="offcanvas" aria-label="Chiudi" />
        </div>
        <div className="offcanvas-body">
          {/* Item 4: loading state (port of qbSetLoading) — durante l'edit-load
              (action=get) mostra "Caricamento prenotazione..."; sul PRIMO open in
              NEW, mentre carica i master data, il testo legacy è "Preparo nuova
              prenotazione..." (app.js:9910). */}
          <div id="qbLoadingState" className="qb-loading-state" role="status" aria-live="polite" hidden={!(editLoading || (masterLoading && !isEditMode))}>
            <div className="spinner-border text-primary" aria-hidden="true" />
            <div className="fw-semibold mt-3" id="qbLoadingText">{editLoading ? "Caricamento prenotazione..." : "Preparo nuova prenotazione..."}</div>
            <div className="small text-muted mt-1">Preparo dati, orari e prezzi.</div>
          </div>

          {/* Item 4: load-error state (port of qbSetLoadError) — shown when the edit-load
              failed; the Riprova button re-invokes openEditAppointment for the last id. */}
          <div id="qbLoadErrorState" className="alert alert-danger qb-load-error" role="alert" hidden={!editLoadError}>
            <div className="fw-semibold mb-1">Prenotazione non caricata</div>
            <div className="small" id="qbLoadErrorText">{editLoadError || "Impossibile caricare la prenotazione."}</div>
            {/* This block is only visible when editLoadError is set, which only happens after an
                edit-load attempt (which stores lastEditIdRef), so the Riprova button can always
                render here; the ref is read in the click handler (allowed), not during render. */}
            <button
              type="button"
              className="btn btn-sm btn-outline-danger mt-2"
              id="qbLoadRetryBtn"
              onClick={() => {
                const retryId = lastEditIdRef.current;
                if (retryId) openEditAppointment(retryId);
              }}
            >
              Riprova
            </button>
          </div>

          {/* Item 4: hide the form while loading or on a load error (qbSetFormHydrationBlocked). */}
          <form id="quickBookingForm" onSubmit={submitBooking} style={editLoading || editLoadError || (masterLoading && !isEditMode) ? { display: "none" } : undefined}>
            <div id="qbSegmentViewAlert" className="alert alert-warning small" style={{ display: "none" }} />
            {/* Cancellation alert (port of qbRenderCancellationAlert): shown only for a
                canceled/no_show appointment — bold title, the operator's reason (or the
                terminal-state fallback line) and the cancellation timestamp. */}
            <div id="qbCancellationAlert" className="alert alert-warning small" style={{ display: formLocked ? "block" : "none" }}>
              {formLocked ? (
                <>
                  <div className="fw-semibold mb-1">{originalStatus === "no_show" ? "Prenotazione No show" : "Prenotazione annullata"}</div>
                  <div>{cancelledReason || "Questa prenotazione è in stato finale e non può più essere modificata."}</div>
                  {cancelledAt ? (
                    <div className="small text-muted mt-1">
                      {(originalStatus === "no_show" ? "Segnata il " : "Annullata il ") + fmtDateTimeFromSql(cancelledAt)}
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>

            {/* Locked-mode field freeze (port of qbSetLockedAppointmentMode): a disabled
                fieldset covers every input/select/textarea/button of the form body; the
                qb-locked class also inerts the client links + the services multiselect
                (pointer-events none, opacity .65, like qbSetClickableLocked). The submit
                and delete buttons live OUTSIDE this fieldset (their lock is per-button). */}
            <fieldset disabled={formLocked} className={formLocked ? "qb-locked" : undefined}>

            {/* Cliente (spostato sopra a "Servizi") */}
            <label className="form-label">Cliente</label>

            <input type="hidden" name="client_id" id="qb_client_id" value={client?.id ?? ""} readOnly />
            <input type="hidden" name="id" id="qb_appt_id" value={apptId} readOnly />
            <input type="hidden" name="giftbox_redeem" id="qb_giftbox_redeem" value={giftboxRedeemJson} readOnly />
            <input type="hidden" name="gift_redeem" id="qb_gift_redeem" value={giftRedeemJson} readOnly />
            <input type="hidden" name="package_redeem" id="qb_package_redeem" value={packageRedeemJson} readOnly />
            <input type="hidden" name="prepaid_service_redeem" id="qb_prepaid_service_redeem" value={prepaidRedeemJson} readOnly />
            <input type="hidden" name="giftcard_redeem" id="qb_giftcard_redeem" value={giftcardRedeemJson} readOnly />

            <div id="qbSelectedClientBox" className="card p-2 mb-2" style={{ display: client ? "block" : "none" }}>
              <div className="d-flex justify-content-between align-items-start">
                <div>
                  <div className="fw-semibold" id="qbSelName">{client?.full_name ?? ""}</div>
                  <div className="small text-muted">Email: <span id="qbSelEmail">{client?.email || "—"}</span></div>
                  <div className="small text-muted">Telefono: <span id="qbSelPhone">{client?.phone || "—"}</span></div>
                </div>
                <a
                  href="#"
                  id="qbClearSelectedClient"
                  className="small text-decoration-none text-danger"
                  onClick={(e) => {
                    e.preventDefault();
                    setClient(null);
                    // Hide + reset the history/residuals boxes (port: client cleared).
                    clearClientContext();
                  }}
                >
                  annulla
                </a>
              </div>
            </div>

            {/* Storico cliente (quick booking) — wired to quickbook_client_context.
                Shows the "•"-joined history line (port of qbLoadClientHistory). */}
            <div id="qbClientHistoryBox" className="card p-2 mb-2" style={{ display: client ? "block" : "none" }}>
              <div className="d-flex justify-content-between align-items-center">
                <div className="fw-semibold">Storico cliente</div>
                <a
                  href={historyOpenHref}
                  id="qbClientHistoryOpen"
                  className="small text-decoration-none"
                  data-client-id={clientId || undefined}
                  onClick={openClientCard}
                >
                  Apri scheda
                </a>
              </div>
              <div className="small text-muted mt-1" id="qbClientHistorySummary">
                {contextLoading && !historySummary && !historyError
                  ? "Caricamento..."
                  : historyError
                    ? historyError
                    : historyLine}
              </div>
            </div>

            {/* Residui (quick booking) — wired to quickbook_client_context. Shows
                the soft badges or the empty/error states (port of qbLoadClientResiduals). */}
            <div id="qbClientResidualsBox" className="card p-2 mb-2" style={{ display: client ? "block" : "none" }}>
              <div className="d-flex justify-content-between align-items-center">
                <div className="fw-semibold">Residui</div>
                <a
                  href="#"
                  id="qbClientResidualsOpen"
                  className="small text-decoration-none"
                  data-client-id={clientId || undefined}
                  style={{ display: hasResiduals ? "" : "none" }}
                  onClick={(e) => {
                    e.preventDefault();
                    openResidualsDetail();
                  }}
                >
                  Apri scheda
                </a>
              </div>
              <div className="small mt-2" id="qbClientResidualsList">
                {contextLoading && !residualsSummary && !residualsError ? (
                  "Caricamento..."
                ) : residualsError ? (
                  <div className="text-danger small">{residualsError}</div>
                ) : !hasResiduals ? (
                  <div className="text-muted">Nessun residuo disponibile.</div>
                ) : (
                  <>
                    <div className="text-muted small">Questo cliente ha residui:</div>
                    <div className="d-flex flex-wrap gap-2 mt-1">
                      {residualBadges.map((b) => (
                        <span className="badge badge-soft" key={b.key}>{b.label}</span>
                      ))}
                    </div>
                    <div className="text-muted small mt-2">Apri la scheda per vedere i dettagli.</div>
                  </>
                )}
              </div>
            </div>

            {/* Trova/Nuovo are visible ONLY while NO client is selected (legacy
                qbShowSelected hides #qbNewClientBox; "annulla" re-shows it). */}
            <div id="qbNewClientBox" className="qb-client-actions mb-3" style={{ display: client ? "none" : "block" }}>
              <div className="row g-2">
                <div className={canQuickCreateClient ? "col-6" : "col-12"}>
                  <button type="button" className="btn btn-outline-primary w-100" id="qbLinkFindClient" onClick={openFindClient}>
                    <i className="bi bi-search me-1" />Trova
                  </button>
                </div>
                {canQuickCreateClient ? (
                  <div className="col-6">
                    <button type="button" className="btn btn-primary w-100" id="qbLinkNewClient" onClick={openNewClient}>
                      <i className="bi bi-plus-lg me-1" />Nuovo
                    </button>
                  </div>
                ) : null}
              </div>
            </div>

            <hr className="my-3" />

            <div className="mb-3">
              <label className="form-label">Servizi</label>

              <div className="qb-multiselect" id="qb_services_ms">
                <div
                  className="qb-ms-control form-control"
                  id="qb_ms_control"
                  role="button"
                  tabIndex={0}
                  aria-haspopup="listbox"
                  aria-expanded={msOpen}
                  onClick={() => setMsOpen((v) => !v)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setMsOpen((v) => !v);
                    }
                  }}
                >
                  <div className="qb-ms-pills" id="qb_ms_pills">
                    {selectedServiceIds.map((id) => {
                      const svc = services.find((s) => s.id === id);
                      if (!svc) return null;
                      // Redeem traceability on the pill (legacy pill click -> info modal,
                      // app.js 8925-8963, priority giftbox > gift > package > prepaid).
                      const gb = giftboxRedeems[id];
                      const og = giftRedeems[id];
                      const pk = packageRedeems[id];
                      const ps = prepaidRedeems[id];
                      const infoTarget: QbInfoModalState | null = gb
                        ? { kind: "giftbox", refId: gb.instance_id, serviceId: id, itemId: gb.giftbox_item_id }
                        : og
                          ? { kind: "gift", refId: og.instance_id, serviceId: id, itemId: og.reward_item_index }
                          : pk
                            ? { kind: "package", refId: pk.client_package_id, serviceId: id }
                            : ps
                              ? { kind: "prepaid", refId: ps.client_prepaid_service_id, serviceId: id }
                              : null;
                      return (
                        <span
                          key={id}
                          className="badge bg-primary d-inline-flex align-items-center me-1 mb-1 qb-ms-pill"
                          data-service-id={id}
                          data-gb-instance-id={gb ? gb.instance_id : undefined}
                          data-og-instance-id={og ? og.instance_id : undefined}
                          data-cp-id={pk ? pk.client_package_id : undefined}
                          data-prepaid-service-id={ps ? ps.client_prepaid_service_id : undefined}
                          style={infoTarget ? { cursor: "pointer" } : undefined}
                          title={infoTarget ? "Apri i dettagli del residuo collegato" : undefined}
                          onClick={
                            infoTarget
                              ? (e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  openResidualInfo(infoTarget);
                                }
                              : undefined
                          }
                        >
                          {svc.name}
                          <button
                            type="button"
                            className="btn-close btn-close-white ms-2"
                            aria-label="Rimuovi"
                            data-remove-id={id}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              toggleService(id);
                              // Toast legacy sulla rimozione dalla pill (app.js:3232).
                              qbNotify(`Servizio rimosso dalla prenotazione: ${svc.name}`, "info");
                            }}
                          />
                        </span>
                      );
                    })}
                  </div>
                  <div
                    className="qb-ms-placeholder text-muted"
                    id="qb_ms_placeholder"
                    hidden={selectedServiceIds.length > 0}
                  >
                    Seleziona uno o più servizi…
                  </div>
                  <div className="qb-ms-caret"><i className="bi bi-chevron-down" /></div>
                </div>

                <div className="qb-ms-dropdown shadow-sm" id="qb_ms_dropdown" hidden={!msOpen}>
                  <div className="p-2 border-bottom">
                    <input
                      className="form-control"
                      id="qb_service_search"
                      type="text"
                      placeholder="Inizia a digitare per filtrare..."
                      value={serviceSearch}
                      onChange={(e) => setServiceSearch(e.target.value)}
                    />
                  </div>
                  <div className="qb-ms-list" id="qb_ms_list" role="listbox">
                    {groupedServices.map((group) => {
                      const visibleItems = group.items.filter((svc) => {
                        const checked = selectedServiceIds.includes(svc.id);
                        const locationOk = serviceAllowedForLocation(svc);
                        const matchesSearch = needle ? lower(svc.name).includes(needle) : true;
                        return !((!locationOk && !checked) || !matchesSearch);
                      });
                      if (!visibleItems.length) return null;
                      return (
                        <div className="qb-ms-group" data-group={String(group.cid)} key={group.cid}>
                          <div className="qb-ms-group-title">{group.name}</div>
                          {visibleItems.map((svc) => (
                            <label
                              className="qb-ms-item"
                              key={svc.id}
                              data-name={lower(svc.name)}
                              data-location-ids={svc.locationIds.join(",")}
                            >
                              <input
                                className="form-check-input qb-ms-check qb_service_check me-2"
                                type="checkbox"
                                value={svc.id}
                                data-id={svc.id}
                                data-dur={svc.duration}
                                data-price={svc.price}
                                data-noop={svc.noOperator ? 1 : 0}
                                data-location-ids={svc.locationIds.join(",")}
                                data-name={svc.name}
                                checked={selectedServiceIds.includes(svc.id)}
                                onChange={() => toggleService(svc.id)}
                              />
                              <span className="qb-ms-item-name">{svc.name}</span>
                              <span className="qb-ms-item-meta text-muted small ms-1">• {svc.duration} min</span>
                            </label>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              <div id="qb_service_ids_container" />
              <div className="form-text">Seleziona i servizi dal menu: puoi cercare, scegliere più servizi e la durata verrà calcolata automaticamente.</div>
            </div>

            {/* I controlli di selezione RESIDUI (Pacchetti/Prepagati/GiftBox/Omaggi/
                GiftCard) vivono DENTRO la modale Residui (#qbClientResidualsModal),
                come nel legacy: il form ha solo gli hidden input (View.php:1128-1132).
                Le pill dei servizi collegati mostrano il badge e aprono i dettagli. */}

            <div className="row g-2">
              <div className="col-12">
                <label className="form-label">Operatore</label>
                {/* Multi-servizio: la select non rappresenta univocamente l'assegnazione.
                    Quando sono selezionati 2+ servizi mostriamo un operatore per ogni
                    servizio (#qbMultiStaffPicker) e un riepilogo, e disabilitiamo la
                    select singola. Port di setMultiStaffMode/renderMultiStaffPicker. */}
                <div
                  id="qbStaffSummaryBox"
                  className="form-control"
                  style={{ display: isMultiService ? "block" : "none", background: "#f8fafc" }}
                >
                  {isMultiService ? staffSummaryText : ""}
                </div>
                <div id="qbStaffSummaryHint" className="form-text" style={{ display: isMultiService ? "block" : "none" }}>
                  Prenotazione multi-servizio: seleziona un operatore per ogni servizio (se un servizio ha un solo operatore verrà selezionato automaticamente).
                </div>
                <input type="hidden" name="staff_map" id="qb_staff_map" value={staffMapJson} readOnly />
                <input type="hidden" name="cabin_map" id="qb_cabin_map" value={cabinMapJson} readOnly />
                <input type="hidden" name="appointment_hold_token" id="qb_appointment_hold_token" value={holdToken} readOnly />
                <div id="qbMultiStaffPicker" className="mt-2" style={{ display: isMultiService ? "block" : "none" }}>
                  {isMultiService
                    ? staffPickerRows.map((row) => (
                        <div className="mb-3" key={row.id}>
                          <label className="form-label small mb-1">{row.name}</label>
                          {row.noOperator ? (
                            // noOperator service: no operator to assign (port: skipped/disabled).
                            <select className="form-select qb-staff-for-service qb-field-muted" data-service-id={row.id} disabled>
                              <option value="">Senza operatore</option>
                            </select>
                          ) : row.eligible.length === 0 ? (
                            <select className="form-select qb-staff-for-service qb-field-muted" data-service-id={row.id} disabled>
                              <option value="">Nessun operatore disponibile</option>
                            </select>
                          ) : (
                            <select
                              className={`form-select qb-staff-for-service${row.onlyOne ? " qb-field-muted" : ""}`}
                              data-service-id={row.id}
                              // Exactly one eligible operator -> auto-selected + locked.
                              disabled={row.onlyOne}
                              value={staffMap[row.id] ?? ""}
                              onChange={(e) => setStaffForService(row.id, e.target.value)}
                            >
                              {row.onlyOne ? null : <option value="">(seleziona)</option>}
                              {row.eligible.map((st) => (
                                <option value={st.id} key={st.id}>{st.name}</option>
                              ))}
                            </select>
                          )}
                          {/* Per-service CABIN select, mirroring the operator
                              select above. Populated with the ALLOWED cabins and
                              their FREE state from cabins_for_services (occupied
                              ones "(occupata)" + disabled); auto-selected + locked
                              when only one is free (per the hint). The chosen
                              values are serialized to #qb_cabin_map as
                              {serviceId: cabinId}. */}
                          {cabinOptions.length === 0 ? (
                            <select className="form-select qb-cabin-for-service mt-1 qb-field-muted" data-service-id={row.id} disabled>
                              <option value="">Nessuna cabina</option>
                            </select>
                          ) : (
                            <select
                              className={`form-select qb-cabin-for-service mt-1${freeCabinOptions.length === 1 ? " qb-field-muted" : ""}`}
                              data-service-id={row.id}
                              // Exactly one FREE cabin -> auto-selected + locked.
                              disabled={freeCabinOptions.length === 1}
                              value={cabinMap[row.id] ?? ""}
                              onChange={(e) => setCabinForService(row.id, e.target.value)}
                            >
                              {freeCabinOptions.length === 1 ? null : <option value="">Seleziona cabina</option>}
                              {cabinOptions.map((c) => (
                                <option value={c.id} key={c.id} disabled={c.occupied}>
                                  {c.name}{c.occupied ? " (occupata)" : ""}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      ))
                    : null}
                </div>
                {(() => {
                  // Stati select legacy (refreshStaffForService): fetch / 0 eleggibili /
                  // 1 auto / 2+ "(qualsiasi)"; occupati disabilitati "nome — motivo";
                  // in edit l'operatore salvato fuori lista resta come opzione dedicata.
                  const zeroEligible = !staffChecking && !staffLoadFailed && staffSvcList !== null && staffSvcList.length === 0;
                  const singleEligible = !staffChecking && staffSvcList !== null && staffSvcList.length === 1;
                  const opts = staffSvcList ?? staff.map((st) => ({ id: st.id, name: st.name, available: true, unavailable_reason: "" }));
                  const savedMissing = Boolean(staffId) && !opts.some((o) => String(o.id) === staffId);
                  const hint = zeroEligible
                    ? "Nessun operatore disponibile per il servizio selezionato."
                    : staffLoadFailed
                      ? "Impossibile caricare gli operatori disponibili."
                      : "";
                  return (
                    <>
                      <select
                        className={`form-select${staffChecking ? " qb-field-loading" : (startGateDisabled || staffLoadFailed || zeroEligible || singleEligible) ? " qb-field-muted" : ""}`}
                        name="staff_id"
                        value={staffId}
                        onChange={(e) => {
                          // Cambio operatore singolo in CREATE (port di app.js:9010-9020):
                          // slot invalidato — azzera orari, rilascia hold, toast legacy.
                          const next = e.target.value;
                          const prev = staffId.trim();
                          dropAndReleaseHold();
                          if (!apptId && startTime) {
                            setStartTime("");
                            setPrefillEndTime("");
                            if (prev && next.trim() && prev !== next.trim()) {
                              qbNotify("Hai cambiato operatore: seleziona di nuovo una disponibilità", "warning");
                            }
                          }
                          setStaffId(next);
                        }}
                        disabled={startGateDisabled || isMultiService || staffChecking || staffLoadFailed || zeroEligible || singleEligible}
                        style={isMultiService ? { display: "none" } : undefined}
                      >
                        {staffChecking ? (
                          <option value="">Verifico operatori disponibili...</option>
                        ) : staffLoadFailed ? (
                          <option value="">Impossibile caricare operatori</option>
                        ) : zeroEligible ? (
                          <option value="">Nessun operatore disponibile</option>
                        ) : (
                          <option value="">{startGateDisabled ? "Seleziona prima un servizio" : "(qualsiasi)"}</option>
                        )}
                        {!staffChecking && savedMissing ? (
                          <option value={staffId}>{`Operatore assegnato (ID ${staffId})`}</option>
                        ) : null}
                        {!staffChecking && !staffLoadFailed && !zeroEligible
                          ? opts.map((st) => (
                              <option value={st.id} key={st.id} disabled={!st.available}>
                                {st.available ? st.name : `${st.name} — ${st.unavailable_reason || "Occupato"}`}
                              </option>
                            ))
                          : null}
                      </select>
                      <div id="qb_staff_hint" className="form-text" style={hint && !isMultiService ? undefined : { display: "none" }}>{hint}</div>
                    </>
                  );
                })()}
              </div>
            </div>

            {locations.length > 1 ? (
              <div className="row g-2 mt-1">
                <div className="col-12">
                  <label className="form-label">Sede</label>
                  <select
                    className="form-select"
                    name="location_id"
                    id="qb_location_id"
                    required
                    value={locationId}
                    onChange={(e) => changeLocation(e.target.value)}
                  >
                    <option value="">Seleziona sede</option>
                    {locations.map((loc) => (
                      <option value={loc.id} key={loc.id}>{loc.name || `Sede #${loc.id}`}</option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <input type="hidden" name="location_id" value={locationId} readOnly />
            )}

            <div className="row g-2 mt-1">
              <div className="col-12 d-flex gap-2 align-items-end">
                <div className="flex-grow-1">
                  <label className="form-label">Data di inizio</label>
                  <input
                    className="form-control"
                    type="date"
                    id="qb_date"
                    autoComplete="off"
                    required
                    disabled={startGateDisabled}
                    value={date}
                    onChange={(e) => changeDate(e.target.value)}
                  />
                </div>
                <div>
                  <label className="form-label">&nbsp;</label>
                  {/* Opens the availability BROWSER modal (legacy #qbAvailabilityModal);
                      the direct hold (runAvailability) stays for the calendar auto-hold. */}
                  <button
                    className="btn btn-outline-primary w-100"
                    type="button"
                    id="qbAvailabilityBtn"
                    disabled={startGateDisabled || availLoading}
                    onClick={openAvailabilityModal}
                  >
                    {availLoading ? "..." : <>Disponibilità <i className="bi bi-arrow-right ms-1" /></>}
                  </button>
                </div>
              </div>

              <div className="col-6">
                <label className="form-label">Ora di Inizio</label>
                <input
                  className="form-control"
                  type="time"
                  id="qb_start_time"
                  step={300}
                  autoComplete="off"
                  required
                  value={startTime}
                  onChange={(e) => changeStartTime(e.target.value)}
                />
              </div>
              <div className="col-6">
                <label className="form-label">Ora di Fine</label>
                <input className="form-control" type="time" id="qb_end_time" step={300} autoComplete="off" readOnly value={endTime} />
              </div>

              <div className="col-12">
                <div id="qbHoldCountdown" className="alert alert-info d-none py-2 px-3 mb-0 small" role="status" aria-live="polite" />
              </div>

              {/* Hidden datetime-local fields used by backend/API (keep names) */}
              <input type="hidden" name="starts_at" id="qb_starts" value={startTime ? `${date}T${startTime}` : ""} readOnly />
              <input type="hidden" name="ends_at" id="qb_ends" value={endTime ? `${date}T${endTime}` : ""} readOnly />

              {/* Segment view (multi-servizio) */}
              <input type="hidden" name="segment_id" id="qb_segment_id" value="" readOnly />
              <input type="hidden" name="segment_old_starts_at" id="qb_segment_old_starts" value="" readOnly />
              <input type="hidden" name="segment_old_ends_at" id="qb_segment_old_ends" value="" readOnly />
            </div>

            <div className="row g-2 mt-1">
              <div className="col-12">
                <label className="form-label">Cabina</label>
                {/* #qb_cabin_id: usable once a service (+ location) is chosen and
                    cabins exist (port of the select enabled after availability).
                    Lists the cabins ALLOWED for the services with their FREE state
                    from cabins_for_services (legacy refreshCabinsForServices): an
                    occupied one shows "(occupata)" and is disabled; when only one
                    is free it is auto-selected and the select is locked, per the
                    hint. The chosen value flows to the save as `cabin_id`. */}
                <select
                  className={`form-select${(!cabinGateOpen || freeCabinOptions.length === 1) ? " qb-field-muted" : ""}`}
                  name="cabin_id"
                  id="qb_cabin_id"
                  value={effectiveCabinId}
                  onChange={(e) => {
                    // Item 1: a cabin change invalidates the held slot — drop + release it.
                    dropAndReleaseHold();
                    setCabinId(e.target.value);
                  }}
                  disabled={!cabinGateOpen || freeCabinOptions.length === 1}
                >
                  <option value="">
                    {!cabinGateOpen
                      ? startGateDisabled
                        ? "Seleziona prima un servizio"
                        : "Nessuna cabina disponibile"
                      : "Seleziona cabina"}
                  </option>
                  {cabinOptions.map((c) => (
                    <option value={c.id} key={c.id} disabled={c.occupied}>
                      {c.name}{c.occupied ? " (occupata)" : ""}
                    </option>
                  ))}
                </select>
                <div className="form-text" id="qb_cabin_hint">Se sono libere più cabine potrai scegliere; se è libera solo una verrà selezionata automaticamente.</div>
              </div>
            </div>

            <div className="row g-2 mt-1">
              <div className="col-6">
                <label className="form-label d-flex align-items-center gap-2">
                  <span>Stato</span>
                  {/* Item C: read-only status badge reflecting the loaded originalStatus
                      (port of qbBadgeForStatus). Only shown in EDIT mode once a status is loaded. */}
                  {isEditMode && originalStatus ? (
                    <span className={`badge text-bg-${badgeForStatus(originalStatus).cls}`} id="qbStatusBadge">
                      {badgeForStatus(originalStatus).label}
                    </span>
                  ) : null}
                </label>
                <select
                  className="form-select"
                  name="status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  disabled={statusLocked}
                >
                  {statusOptions.map((o) => (
                    <option value={o.value} key={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-6">
                <label className="form-label">Note per lo staff</label>
                <input
                  className="form-control"
                  name="staff_notes"
                  placeholder="(opz.)"
                  value={staffNotes}
                  onChange={(e) => setStaffNotes(e.target.value)}
                />
              </div>
            </div>

            <div className="mb-3">
              <label className="form-label">Note del cliente</label>
              <textarea
                className="form-control"
                name="customer_notes"
                rows={3}
                placeholder="(opz.)"
                value={customerNotes}
                onChange={(e) => setCustomerNotes(e.target.value)}
              />
            </div>

            {/* Dettaglio prezzi — React-driven (port of app.js renderPriceDetails). The
                per-line list / subtotale / sconto / coupon / totale are bound to the
                `priceDetails` recompute; the box reveals when >=1 service is selected. */}
            <div className="mt-3" id="qbPriceDetailsBox" style={{ display: showPriceDetails ? "block" : "none" }}>
              <div className="fw-bold mb-2">Dettaglio prezzi</div>
              <div className="card p-2" style={{ borderRadius: 12 }}>
                <div id="qbPriceDetailsList" className="small">
                  {priceDetails.lines.map((line) => (
                    <div key={line.id} className="d-flex justify-content-between align-items-center mb-1">
                      <div className="text-truncate" style={{ maxWidth: "70%" }}>{line.name}</div>
                      {line.listPrice > line.price + 0.0000001 ? (
                        // Redeem-covered (price 0 + badge) OR promo-discounted line:
                        // struck list price + effective price + badge (legacy
                        // renderPriceDetails hasItemDiscount branch).
                        <div className="text-end">
                          <div className="small text-muted text-decoration-line-through">{fmtEUR(line.listPrice)}</div>
                          <div className="fw-semibold">
                            {fmtEUR(line.price)}
                            {line.badge ? <span className="badge bg-success ms-1">{line.badge}</span> : null}
                          </div>
                        </div>
                      ) : (
                        <div className="fw-semibold">{fmtEUR(line.price)}</div>
                      )}
                    </div>
                  ))}
                </div>

                <div className="d-flex justify-content-between align-items-center mt-2 pt-2 border-top">
                  <div className="text-muted small">Subtotale</div>
                  <div className="text-muted small" id="qbPriceSubtotal">{fmtEUR(priceDetails.subtotal)}</div>
                </div>

                <input type="hidden" name="coupon_code" id="qb_coupon_code" value={priceDetails.couponApplied ? couponCode : ""} readOnly />
                <input type="hidden" name="coupon_discount" id="qb_coupon_discount" value={priceDetails.couponApplied ? String(priceDetails.coupon) : "0"} readOnly />
                <div className="mt-2">
                  <div className="d-flex justify-content-between align-items-center mb-1">
                    <label className="form-label small mb-0">Coupon</label>
                    <a href="#" className="small text-success text-decoration-underline" id="qbCouponToggle" onClick={onCouponToggle}>Hai un codice coupon?</a>
                  </div>
                  <div className={`card border-0 bg-light p-2${couponBoxOpen ? "" : " d-none"}`} id="qbCouponBox">
                    <div className="input-group input-group-sm">
                      <input
                        className="form-control"
                        type="text"
                        id="qbCouponInput"
                        placeholder="Inserisci codice coupon"
                        value={couponInput}
                        onChange={(e) => setCouponInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void applyCoupon();
                          }
                        }}
                      />
                      <button type="button" className="btn btn-outline-success" id="qbCouponApplyBtn" disabled={couponApplying} onClick={() => void applyCoupon()}>Applica</button>
                      <button type="button" className="btn btn-outline-secondary" id="qbCouponRemoveBtn" disabled={couponApplying} onClick={removeCoupon}>Rimuovi</button>
                    </div>
                    <div className={`form-text${couponMsg ? (couponMsg.ok ? " text-success" : " text-danger") : ""}`} id="qbCouponMsg">
                      {couponMsg?.text ?? ""}
                    </div>
                  </div>
                </div>

                <div className={`d-flex justify-content-between align-items-center mt-2 pt-2 border-top${priceDetails.couponApplied ? "" : " d-none"}`} id="qbCouponRow" style={{ color: "#047857" }}>
                  <div className="small fw-semibold" id="qbCouponLabel">{priceDetails.couponApplied ? `Coupon (${couponCode})` : "Coupon"}</div>
                  <div className="small fw-semibold" id="qbCouponAmount">- {fmtEUR(priceDetails.couponApplied ? priceDetails.coupon : 0)}</div>
                </div>

                <div className="mt-2">
                  <label className="form-label small mb-1">Sconto</label>
                  <div className="d-flex gap-2 align-items-center flex-wrap">
                    <select className="form-select form-select-sm" name="discount_type" id="qb_discount_type" style={{ maxWidth: 120 }} value={discountType} onChange={(e) => setDiscountType(e.target.value)}>
                      <option value="">Nessuno</option>
                      <option value="percent">%</option>
                      <option value="fixed">€</option>
                    </select>
                    <input className="form-control form-control-sm" type="number" step="0.01" min="0" inputMode="decimal" name="discount_value" id="qb_discount_value" placeholder="0" style={{ maxWidth: 140 }} value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} />
                    <div className="small text-muted ms-auto" id="qbPriceDiscountAmount">- {fmtEUR(priceDetails.discount)}</div>
                  </div>
                </div>

                <input type="hidden" name="fidelity_points_use" id="qb_fidelity_points_use" value={String(priceDetails.fidelityPointsUsed || 0)} readOnly />
                <div className="alert alert-info p-2 mt-2 d-none" id="qbFidelityNote" style={{ borderRadius: 10 }} />

                {/* GiftCard (monetary) row (Block 4) — reveals when a giftcard amount > 0 is
                    applied. priceDetails.giftcardMonetary = the effective giftcardAmount (already
                    posted via #qb_giftcard_redeem + decremented server-side by the redeem),
                    clamped to the running total; it now feeds the recompute so the Totale drops. */}
                <div className={`d-flex justify-content-between align-items-center mt-2 pt-2 border-top${priceDetails.giftcardMonetary > 0 ? "" : " d-none"}`} id="qbGiftcardRow" style={{ color: "#047857" }}>
                  <button
                    type="button"
                    className="btn btn-link btn-sm p-0 fw-semibold qb-giftcard-open"
                    id="qbGiftcardLabel"
                    style={{ color: "inherit", textDecoration: "none" }}
                    title="Dettagli GiftCard"
                    // Port of qbOpenGiftcardInfo (app.js 2302): the row label opens the
                    // GiftCard detail modal with the applied amount.
                    onClick={() => {
                      if (!effectiveGiftcard) return;
                      openResidualInfo({
                        kind: "giftcard",
                        refId: effectiveGiftcard.id,
                        serviceId: 0,
                        usedAmount: priceDetails.giftcardMonetary,
                      });
                    }}
                  >
                    {effectiveGiftcard ? `GiftCard (${effectiveGiftcard.code})` : "GiftCard"}
                  </button>
                  <div className="d-flex align-items-center gap-2">
                    <div className="small fw-semibold" id="qbGiftcardAmount">- {fmtEUR(priceDetails.giftcardMonetary)}</div>
                    <button type="button" className="btn btn-sm btn-link text-danger p-0 d-none" id="qbGiftcardRemoveBtn" title="Rimuovi GiftCard"><i className="bi bi-x-circle" /></button>
                  </div>
                </div>
                <input type="hidden" name="credit_use" id="qb_credit_use" value={String(priceDetails.credito || 0)} readOnly />
                <input type="hidden" name="credit_use_from_booking" id="qb_credit_use_from_booking" value="0" readOnly />

                {/* Il CREDITO si gestisce dalla modale Residui (card #qbResidualCreditCard),
                    come nel legacy: qui resta solo la riga riepilogo qbCreditRow. */}
                {/* Credito row — reveals when a customer credit amount > 0 is applied. */}
                <div className={`d-flex justify-content-between align-items-center mt-2 pt-2 border-top${priceDetails.credito > 0 ? "" : " d-none"}`} id="qbCreditRow" style={{ color: "#047857" }}>
                  <div className="small fw-semibold">Credito</div>
                  <div className="small fw-semibold" id="qbCreditAmount">- {fmtEUR(priceDetails.credito)}</div>
                </div>

                {/* Punti Fidelity box (Block 4) — shown only when redeem is enabled for the tenant
                    AND the selected client has points. The staff enters a POINTS count (bounded by
                    the recompute to [0, min(available, floor(total/euroPerPoint))] respecting the
                    business minimum); the € discount = pointsUsed x euroPerPoint feeds the Totale +
                    #qb_fidelity_points_use. Wired via `fidelityInput`. */}
                {fidelityRedeemEnabled && fidelityPointsAvailable > 0 ? (
                  <div className="card border-0 bg-light p-2 mt-2" id="qbFidelityBox">
                    <div className="d-flex justify-content-between align-items-center">
                      <div className="fw-semibold"><i className="bi bi-percent me-1" /> Punti Fidelity</div>
                      <div className="small text-muted" id="qbFidelityAvail">Disponibili: {fidelityPointsAvailable} Punti</div>
                    </div>

                    <div className="mt-2">
                      {/* Item E: "Usa sconto Punti Fidelity" toggle (#qbFidelityToggle). OFF collapses
                          the points input + applies no discount; ON reveals the input. Turning it off
                          clears the typed points so no stale figure lingers. */}
                      <div className="d-flex align-items-center" id="qbFidelityToggleRow">
                        <div className="form-check form-switch m-0">
                          <input
                            className="form-check-input"
                            type="checkbox"
                            id="qbFidelityToggle"
                            checked={fidelityUseOn}
                            onChange={(e) => {
                              const on = e.target.checked;
                              setFidelityUseOn(on);
                              if (!on) setFidelityInput("");
                            }}
                          />
                          <label className="form-check-label" htmlFor="qbFidelityToggle">Usa sconto Punti Fidelity</label>
                        </div>
                      </div>

                      {fidelityUseOn ? (
                        <div className="mt-2" id="qbFidelityAmountWrap">
                          <div className="d-flex align-items-center gap-2">
                            <div className="input-group input-group-sm" style={{ maxWidth: 220 }}>
                              <input
                                className="form-control"
                                type="number"
                                step="1"
                                min="0"
                                inputMode="numeric"
                                id="qbFidelityAmountInput"
                                placeholder="0"
                                value={fidelityInput}
                                onChange={(e) => setFidelityInput(e.target.value)}
                              />
                              <span className="input-group-text" id="qbFidelityAmountSuffix">Punti</span>
                            </div>
                            <button type="button" className="btn btn-sm btn-outline-secondary" id="qbFidelityMaxBtn" onClick={() => setFidelityInput(String(fidelityMaxUsablePoints))}>Max</button>
                            {fidelityInput.trim() !== "" ? (
                              <button type="button" className="btn btn-sm btn-link text-danger p-0" id="qbFidelityClearBtn" onClick={() => setFidelityInput("")} title="Rimuovi punti"><i className="bi bi-x-circle" /></button>
                            ) : null}
                          </div>

                          <div className="small text-muted mt-2" id="qbFidelityHint">
                            {/* Hint verbatim legacy (app.js:7504-7511): "Max utilizzabili: N Punti (- € X)[. Minimo: N Punti.]" */}
                            {fidelityMaxUsablePoints > 0
                              ? `Max utilizzabili: ${fidelityMaxUsablePoints} Punti (- ${fmtEUR(fidelityMaxUsablePoints * fidelityEuroPerPoint)})${fidelityMinPoints > 0 ? `. Minimo: ${fidelityMinPoints} Punti.` : ""}`
                              : fidelityMinPoints > 0
                                ? `Minimo: ${fidelityMinPoints} Punti.`
                                : ""}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {/* Sconto Fidelity row — reveals when a fidelity points discount > 0 is applied
                    (priceDetails.fidelity = pointsUsed x euroPerPoint, fed by #qbFidelityBox). */}
                <div className={`d-flex justify-content-between align-items-center mt-2 pt-2 border-top${priceDetails.fidelity > 0 ? "" : " d-none"}`} id="qbFidelityRow" style={{ color: "#047857" }}>
                  <div className="small fw-semibold" id="qbFidelityLabel">Sconto Fidelity</div>
                  <div className="small fw-semibold" id="qbFidelityAmount">- {fmtEUR(priceDetails.fidelity)}</div>
                </div>

                <div className="d-flex justify-content-between align-items-center mt-2 pt-2 border-top">
                  <div className="fw-semibold">Totale</div>
                  <div className="fw-semibold" id="qbPriceTotal">{fmtEUR(priceDetails.total)}</div>
                </div>
              </div>
            </div>

            </fieldset>

            {formError ? <div className="alert alert-danger small mt-3 mb-0">{formError}</div> : null}

            {/* Locked mode: submit disabled with the terminal status as label (port of
                qbSetLockedAppointmentMode, app.js:5084 — keyed sullo stato TERMINALE
                caricato, non sulla select). Edit normale = "Modifica prenotazione"
                (app.js:5562), create = "Crea prenotazione". */}
            <button className="btn btn-primary btn-pill w-100 mt-3" type="submit" id="qbSubmitBtn" disabled={submitting || formLocked}>
              <span id="qbSubmitText">
                {formLocked
                  ? (originalStatus === "no_show" ? "Prenotazione No show" : "Prenotazione annullata")
                  : isEditMode
                    ? "Modifica prenotazione"
                    : "Crea prenotazione"}
              </span>
            </button>

            {/* Locked mode: delete stays enabled ONLY for canceled (legacy
                keepDeleteEnabled) — a no_show cannot be deleted from the drawer. */}
            <button
              className="btn btn-outline-danger btn-pill w-100 mt-2"
              type="button"
              id="qbDeleteBtn"
              style={{ display: isEditMode ? "block" : "none" }}
              onClick={deleteBooking}
              disabled={submitting || (formLocked && originalStatus !== "canceled")}
            >
              Elimina appuntamento
            </button>
          </form>
        </div>
      </div>

      {/* ===================== FIND CLIENT MODAL (port of qbLinkFindClient flow) ===================== */}
      {/* ===== Modal Disponibilità (port of #qbAvailabilityModal, View.php:1924) =====
          React-driven (open state + backdrop) instead of bootstrap.Modal; same
          markup/classes so the legacy qb-avail-* CSS applies unchanged. */}
      {availModalOpen ? (
        <>
          <div className="modal fade show d-block" id="qbAvailabilityModal" tabIndex={-1} role="dialog" aria-modal="true">
            <div className="modal-dialog modal-xl modal-dialog-scrollable">
              <div className="modal-content">
                <div className="modal-header">
                  <div>
                    <div className="small-muted">Disponibilità</div>
                    <h5 className="modal-title fw-bold m-0">Orari disponibili</h5>
                  </div>
                  <button type="button" className="btn-close" aria-label="Chiudi" onClick={closeAvailabilityModal} />
                </div>
                <div className="modal-body">
                  <div className="d-flex justify-content-between align-items-center mb-2">
                    <div className="text-muted small" id="qbAvailHint">Seleziona un orario disponibile per aggiornare la prenotazione.</div>
                    <div className="small text-muted" id="qbAvailRange">{availRangeLabel}</div>
                  </div>
                  <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-2">
                    <div className="btn-group btn-group-sm" role="group" aria-label="Naviga disponibilita">
                      <button type="button" className="btn btn-outline-secondary" id="qbAvailPrevPeriod" title="Periodo precedente" onClick={() => availNavigate(-1)}>
                        <i className="bi bi-chevron-left" />
                      </button>
                      <button type="button" className="btn btn-outline-secondary" id="qbAvailToday" onClick={() => availNavigate(0)}>Oggi</button>
                      <button type="button" className="btn btn-outline-secondary" id="qbAvailNextPeriod" title="Periodo successivo" onClick={() => availNavigate(1)}>
                        <i className="bi bi-chevron-right" />
                      </button>
                    </div>
                    <div className="d-flex flex-wrap align-items-center gap-2">
                      <div className="btn-group btn-group-sm qb-avail-mode-group" role="group" aria-label="Vista disponibilita">
                        {(["day", "week", "month"] as const).map((mode) => (
                          <button
                            type="button"
                            key={mode}
                            className={`btn btn-outline-primary${availMode === mode ? " active" : ""}`}
                            data-qb-avail-mode={mode}
                            onClick={() => void loadAvailabilityPeriod(availAnchor || date, mode)}
                          >
                            {mode === "day" ? "Giorno" : mode === "week" ? "Settimana" : "Mese"}
                          </button>
                        ))}
                      </div>
                      {/* Period picker (the legacy popover calendar) as a native date input. */}
                      <input
                        type="date"
                        className="form-control form-control-sm"
                        style={{ width: "auto" }}
                        aria-label="Seleziona periodo"
                        value={availAnchor}
                        onChange={(e) => { if (e.target.value) void loadAvailabilityPeriod(e.target.value, availMode); }}
                      />
                    </div>
                  </div>
                  {availModalError ? <div className="alert alert-warning py-2 small mb-2">{availModalError}</div> : null}
                  <div className="qb-avail-wrap" id="qbAvailWrap">
                    {availBrowserLoading ? (
                      <div className="qb-avail-loading-state text-muted small p-3" role="status" aria-live="polite">
                        <span className="spinner-border spinner-border-sm text-primary qb-inline-loader" aria-hidden="true" />
                        <span>Caricamento...</span>
                      </div>
                    ) : !availMonths || availMonths.length === 0 ? (
                      <div className="text-muted small p-2">Nessun dato.</div>
                    ) : availMode === "day" ? (
                      /* DAY: full 00:00-24:00 timeline of 5-min bars (legacy renderAvailability). */
                      <>
                        <div className="qb-avail-head">
                          <div className="qb-avail-day">&nbsp;</div>
                          <div className="qb-avail-hours">
                            {Array.from({ length: 24 }, (_, h) => (
                              <div key={h} className="qb-avail-hour">{String(h).padStart(2, "0")}</div>
                            ))}
                          </div>
                        </div>
                        {availMonths.map((m) => (
                          <Fragment key={m.label}>
                            <div className="qb-avail-month">{m.label}</div>
                            {m.days.map((d) => {
                              const slotSet = new Set(d.slots);
                              const overrideSet = new Set(d.override_slots);
                              const bookedSet = new Set(d.booked);
                              const bookedOutsideSet = new Set(d.booked_outside);
                              const toMin = (v: string | null) => {
                                const mm = String(v ?? "").match(/^(\d{2}):(\d{2})/);
                                return mm ? Number(mm[1]) * 60 + Number(mm[2]) : null;
                              };
                              const intervals: Array<[number, number]> = [];
                              const o1 = toMin(d.opens), c1 = toMin(d.closes);
                              if (o1 !== null && c1 !== null && c1 > o1) intervals.push([o1, c1]);
                              const o2 = toMin(d.opens2), c2 = toMin(d.closes2);
                              if (o2 !== null && c2 !== null && c2 > o2) intervals.push([o2, c2]);
                              const ticks = Array.from({ length: (24 * 60) / 5 }, (_, i) => i * 5);
                              // Tooltip day line (legacy formatItDayMonth): "3 Luglio".
                              const monthsIt = ["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"];
                              const dayMonthLabel = (() => {
                                const mm = d.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
                                return mm ? `${Number(mm[3])} ${monthsIt[Number(mm[2]) - 1] ?? ""}` : d.date;
                              })();
                              return (
                                <div className="qb-avail-row" data-date={d.date} key={d.date}>
                                  <div className="qb-avail-day"><div className="fw-semibold">{d.label}</div></div>
                                  <div className="qb-avail-bars">
                                    {ticks.map((tMin) => {
                                      const t = `${String(Math.floor(tMin / 60)).padStart(2, "0")}:${String(tMin % 60).padStart(2, "0")}`;
                                      const inside = intervals.some(([s, e]) => tMin >= s && tMin < e);
                                      const isOutside = intervals.length ? !inside : true;
                                      // Legacy correction: an "available" tick inside a
                                      // closed range renders as override (orange).
                                      let on = slotSet.has(t);
                                      let alt = !on && overrideSet.has(t);
                                      if (on && isOutside) { on = false; alt = true; }
                                      const isBookedOutside = bookedOutsideSet.has(t);
                                      const isBooked = bookedSet.has(t);
                                      const boundaryStart = intervals.some(([s]) => tMin === s);
                                      const boundaryEnd = intervals.some(([, e]) => tMin === e - 5);
                                      const cls = `qb-avail-bar${isBookedOutside ? " is-booked-outside" : isBooked ? " is-booked" : on ? " is-on" : alt ? " is-alt" : " is-off"}${isOutside ? " is-outside-hours" : ""}${boundaryStart ? " bh-start" : ""}${boundaryEnd ? " bh-end" : ""}`;
                                      // Legacy state line: a PLAIN available slot has NO
                                      // extra line (day + bold time only); the others
                                      // carry their status (booked-outside is muted).
                                      const state = isBookedOutside
                                        ? "Prenotazione fuori orario / in chiusura"
                                        : isBooked
                                          ? "Slot occupato"
                                          : on
                                            ? d.dst_gap.includes(t) ? "Ora non esistente (cambio ora legale)" : null
                                            : alt
                                              ? "Fuori orario / Chiusura (selezionabile)"
                                              : "Non disponibile";
                                      const selectable = !isBooked && !isBookedOutside && (on || alt);
                                      return (
                                        <div
                                          key={t}
                                          className={cls}
                                          data-time={t}
                                          onMouseEnter={(e) => {
                                            const rect = e.currentTarget.getBoundingClientRect();
                                            setAvailHoverTip({
                                              left: rect.left + rect.width / 2,
                                              top: rect.top - 6,
                                              day: dayMonthLabel,
                                              time: t,
                                              state,
                                              muted: isBookedOutside,
                                            });
                                          }}
                                          onMouseLeave={() => setAvailHoverTip(null)}
                                          onClick={selectable && !availApplying ? () => void applyAvailabilitySlot(d.date, t) : undefined}
                                        />
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })}
                          </Fragment>
                        ))}
                      </>
                    ) : (
                      /* WEEK/MONTH: per-day summary list (legacy renderAvailabilityMonthSummary). */
                      availMonths.map((m) => (
                        <Fragment key={m.label}>
                          <div className="qb-avail-month">{m.label}</div>
                          <div className="list-group list-group-flush">
                            {m.days.map((d) => {
                              const total = Math.max(0, Number(d.regular_slot_count) || 0);
                              const first = d.first_regular_slot || d.slots[0] || "";
                              const hoursLabel = d.is_closed || (!d.opens && !d.opens2)
                                ? "Chiuso"
                                : `Orari: ${[d.opens && d.closes ? `${d.opens}-${d.closes}` : "", d.opens2 && d.closes2 ? `${d.opens2}-${d.closes2}` : ""].filter(Boolean).join(" / ")}`;
                              return (
                                <button
                                  type="button"
                                  key={d.date}
                                  className="list-group-item list-group-item-action d-flex justify-content-between align-items-center gap-3"
                                  data-qb-avail-day={d.date}
                                  onClick={() => void loadAvailabilityPeriod(d.date, "day")}
                                >
                                  <span>
                                    <span className="fw-semibold d-block">{d.label_full || d.label || d.date}</span>
                                    <span className="small text-muted d-block">{first ? `Primo orario: ${first}` : "Nessun orario disponibile"}</span>
                                    <span className="small text-muted d-block">{hoursLabel}</span>
                                  </span>
                                  <span className="d-flex align-items-center gap-2">
                                    {total > 0
                                      ? <span className="badge text-bg-light border">{total} slot</span>
                                      : <span className="badge text-bg-light border text-muted">Nessuno slot</span>}
                                    <i className="bi bi-chevron-right text-muted" />
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </Fragment>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" onClick={closeAvailabilityModal} />
          {/* Slot hover tooltip (port of the legacy Bootstrap tooltip on the
              bars): dark top tooltip with "3 Luglio" + bold HH:MM + state. */}
          {availHoverTip ? (
            <div
              className="tooltip bs-tooltip-top show"
              role="tooltip"
              style={{
                position: "fixed",
                left: availHoverTip.left,
                top: availHoverTip.top,
                transform: "translate(-50%, -100%)",
                zIndex: 1090,
                pointerEvents: "none",
              }}
            >
              <div className="tooltip-arrow" style={{ position: "absolute", left: "50%", bottom: 0, transform: "translateX(-50%)" }} />
              <div className="tooltip-inner">
                {availHoverTip.day}
                <div className="fw-semibold">{availHoverTip.time}</div>
                {availHoverTip.state ? (
                  <div className={`small mt-1 ${availHoverTip.muted ? "text-muted" : "text-white"}`}>{availHoverTip.state}</div>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      ) : null}

      <div className="modal fade" id="qbClientFindModal" tabIndex={-1} aria-hidden="true">
        <div className="modal-dialog modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <div>
                <div className="small-muted">Cliente</div>
                <h5 className="modal-title fw-bold m-0">Trova</h5>
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              <div className="input-group mb-3">
                <span className="input-group-text"><i className="bi bi-search" /></span>
                <input
                  type="text"
                  className="form-control"
                  id="qbClientFindQuery"
                  placeholder="Inizia a digitare per cercare..."
                  value={findQuery}
                  onChange={(e) => onFindQueryChange(e.target.value)}
                />
                <button className="btn btn-outline-secondary" type="button" id="qbClientFindClear" onClick={() => onFindQueryChange("")}>
                  Annulla
                </button>
              </div>
              <div id="qbClientFindHint" className="text-muted small mb-2">Cerca per nome, cognome, email o telefono.</div>
              <div className="list-group" id="qbClientFindResults">
                {findResults.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    className="list-group-item list-group-item-action"
                    data-id={c.id}
                    data-name={c.full_name}
                    data-email={c.email}
                    data-phone={c.phone}
                    onClick={() => selectClient(c)}
                  >
                    {/* Righe verbatim legacy (app.js:6047-6051): nome + "Email: x" + "Telefono: y" con "—". */}
                    <div className="fw-semibold">{c.full_name}</div>
                    <div className="small text-muted">Email: {c.email || "—"}</div>
                    <div className="small text-muted">Telefono: {c.phone || "—"}</div>
                  </button>
                ))}
                {findQuery.trim() && findResults.length === 0 ? (
                  <div className="text-muted small py-2 px-1">Nessun risultato.</div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ===================== NEW CLIENT MODAL (verbatim from View.php) ===================== */}
      <div className="modal fade" id="qbClientCreateModal" tabIndex={-1} aria-hidden="true">
        <div className="modal-dialog modal-lg modal-dialog-scrollable">
          <form className="modal-content" id="qbClientCreateForm" ref={createFormRef} onSubmit={submitNewClient}>
            <div className="modal-header align-items-start">
              <div>
                <div className="small-muted">Cliente</div>
                <h5 className="modal-title fw-bold m-0">Nuovo cliente</h5>
              </div>
              <button type="button" className="btn-close" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              <div className={`alert alert-danger small ${createError ? "" : "d-none"}`} id="qbClientCreateAlert" role="alert">
                {createError}
              </div>

              <div className="qb-create-section-title">Informazioni principali</div>
              <div className="row g-3">
                <div className="col-md-6">
                  <label className="form-label">Nome <span className="text-danger">*</span></label>
                  <input className="form-control" name="first_name" required autoComplete="given-name" />
                </div>
                <div className="col-md-6">
                  <label className="form-label">Cognome <span className="text-danger">*</span></label>
                  <input className="form-control" name="last_name" required autoComplete="family-name" />
                </div>
                <div className="col-md-6">
                  <label className="form-label">Cellulare</label>
                  <input className="form-control" name="phone" autoComplete="tel" />
                </div>
                <div className="col-md-6">
                  <label className="form-label">Email</label>
                  <input className="form-control" type="email" name="email" autoComplete="email" />
                </div>
                <div className="col-md-6">
                  <label className="form-label d-block">Sesso</label>
                  <div className="d-flex gap-4 pt-1">
                    <div className="form-check">
                      <input className="form-check-input" type="radio" name="gender" id="qbClientGenderM" value="M" />
                      <label className="form-check-label" htmlFor="qbClientGenderM">Maschio</label>
                    </div>
                    <div className="form-check">
                      <input className="form-check-input" type="radio" name="gender" id="qbClientGenderF" value="F" />
                      <label className="form-check-label" htmlFor="qbClientGenderF">Femmina</label>
                    </div>
                  </div>
                </div>
                <div className="col-md-6">
                  <label className="form-label">Data di nascita</label>
                  <input className="form-control" type="date" name="birth_date" />
                </div>
                <div className="col-md-6">
                  <label className="form-label">Luogo di nascita</label>
                  <input className="form-control" name="birth_place" />
                </div>
                <div className="col-md-6">
                  <label className="form-label">Data iscrizione</label>
                  <input className="form-control" type="date" name="registration_date" defaultValue={todayIso()} />
                </div>
                {locations.length > 1 ? (
                  <div className="col-md-6">
                    <label className="form-label">Sede di riferimento <span className="text-danger">*</span></label>
                    <select className="form-select" name="location_id" required defaultValue={locationId}>
                      <option value="">Seleziona sede</option>
                      {locations.map((loc) => (
                        <option value={loc.id} key={loc.id}>{loc.name || `Sede #${loc.id}`}</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <input type="hidden" name="location_id" value={locationId} readOnly />
                )}
                <div className="col-12">
                  <label className="form-label">Note</label>
                  <textarea className="form-control" name="notes" rows={2} />
                </div>
              </div>

              <div className="qb-create-section-title mt-4">Indirizzo / Contatti</div>
              <div className="row g-3">
                <div className="col-md-6">
                  <label className="form-label">Regione</label>
                  <input className="form-control" name="region" />
                </div>
                <div className="col-md-6">
                  <label className="form-label">Provincia</label>
                  <input className="form-control" name="province" />
                </div>
                <div className="col-md-6">
                  <label className="form-label">Citta</label>
                  <input className="form-control" name="city" />
                </div>
                <div className="col-md-6">
                  <label className="form-label">CAP</label>
                  <input className="form-control" name="cap" />
                </div>
                <div className="col-12">
                  <label className="form-label">Indirizzo</label>
                  <input className="form-control" name="address" />
                </div>
                <div className="col-md-6">
                  <label className="form-label">Titolo / Lavoro</label>
                  <input className="form-control" name="job_title" />
                </div>
                <div className="col-md-6">
                  <label className="form-label">Telefono fisso</label>
                  <input className="form-control" name="phone_home" />
                </div>
                <div className="col-md-6">
                  <label className="form-label">Cellulare 2</label>
                  <input className="form-control" name="phone2" />
                </div>
              </div>

              <div className="qb-create-section-title mt-4">Info fiscali</div>
              <div className="row g-3">
                <div className="col-md-6">
                  <label className="form-label">Codice Fiscale</label>
                  <input className="form-control" name="tax_code" />
                </div>
                <div className="col-md-6">
                  <label className="form-label">Partita IVA</label>
                  <input className="form-control" name="vat_number" />
                </div>
                <div className="col-md-6">
                  <label className="form-label">SDI</label>
                  <input className="form-control" name="sdi" />
                </div>
                <div className="col-md-6">
                  <label className="form-label">Azienda</label>
                  <input className="form-control" name="company_name" />
                </div>
                <div className="col-12">
                  <label className="form-label">PEC</label>
                  <input className="form-control" type="email" name="pec" placeholder="pec@dominio.it" />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-outline-secondary" data-bs-dismiss="modal">Annulla</button>
              <button type="submit" className="btn btn-primary" id="qbClientCreateSubmit" disabled={createSaving}>
                <span className={`spinner-border spinner-border-sm me-1 ${createSaving ? "" : "d-none"}`} id="qbClientCreateSpinner" aria-hidden="true" />
                <span id="qbClientCreateSubmitText">Salva cliente</span>
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* ===================== RESIDUAL INFO MODALS (port of #qbPackageInfoModal /
          #qbPrepaidServiceInfoModal / #qbGiftboxInfoModal / #qbGiftInfoModal /
          #qbGiftcardInfoModal, View.php 1741-1896). One React-driven modal that takes
          the per-kind id/labels; body rendered from the residuals detail payload
          (qbRender*Info equivalents: head name/stato/scadenza + residuo, the
          "Servizio selezionato" line and the items card with the selected row
          highlighted). ===================== */}
      {infoModal ? (
        <>
          <div
            className="modal fade show d-block"
            id={
              infoModal.kind === "package"
                ? "qbPackageInfoModal"
                : infoModal.kind === "prepaid"
                  ? "qbPrepaidServiceInfoModal"
                  : infoModal.kind === "giftbox"
                    ? "qbGiftboxInfoModal"
                    : infoModal.kind === "gift"
                      ? "qbGiftInfoModal"
                      : "qbGiftcardInfoModal"
            }
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
          >
            <div className="modal-dialog modal-lg modal-dialog-scrollable">
              <div className="modal-content">
                {(() => {
                  const kind = infoModal.kind;
                  const detail = residualsDetail;
                  const pkg = kind === "package" ? detail?.packages.find((p) => p.id === infoModal.refId) ?? null : null;
                  const pre = kind === "prepaid" ? detail?.services.find((p) => p.id === infoModal.refId) ?? null : null;
                  const gbx = kind === "giftbox" ? detail?.giftboxes.find((g) => g.instance_id === infoModal.refId) ?? null : null;
                  const gft =
                    kind === "gift"
                      ? detail?.gifts.find(
                          (g) => g.instance_id === infoModal.refId && (infoModal.itemId === undefined || g.reward_item_index === infoModal.itemId),
                        ) ?? null
                      : null;
                  const gcd = kind === "giftcard" ? detail?.giftcards.find((g) => g.id === infoModal.refId) ?? null : null;
                  const kindLabel =
                    kind === "package" ? "Pacchetto" : kind === "prepaid" ? "Servizio prepagato" : kind === "giftbox" ? "GiftBox" : kind === "gift" ? "gift" : "GiftCard";
                  const subtitle =
                    kind === "package"
                      ? "Dettagli pacchetto associato al servizio selezionato."
                      : kind === "prepaid"
                        ? "Dettagli del servizio acquistato associato al servizio selezionato."
                        : kind === "giftbox"
                          ? "Dettagli GiftBox associata al servizio selezionato."
                          : kind === "gift"
                            ? "Dettagli dell'omaggio associato al servizio selezionato."
                            : "Dettagli GiftCard applicata alla prenotazione.";
                  const title =
                    pkg?.package_name || pre?.service_name || (gbx ? `${gbx.giftbox_name}${gbx.code ? ` (${gbx.code})` : ""}` : "") || gft?.gift_name || (gcd ? `GiftCard ${gcd.code}` : "") || "Dettagli";
                  const openNewHref =
                    kind === "package"
                      ? `/${encodeURIComponent(slug)}/packages?action=client_view&id=${encodeURIComponent(infoModal.refId)}`
                      : kind === "giftbox"
                        ? `/${encodeURIComponent(slug)}/giftbox?tab=instances&action=edit_instance&id=${encodeURIComponent(infoModal.refId)}`
                        : kind === "gift"
                          ? `/${encodeURIComponent(slug)}/gift_instance?id=${encodeURIComponent(infoModal.refId)}`
                          : kind === "giftcard"
                            ? `/${encodeURIComponent(slug)}/giftcard?action=edit&id=${encodeURIComponent(infoModal.refId)}`
                            : pre?.sale_id
                              ? `/${encodeURIComponent(slug)}/sales?action=view&id=${encodeURIComponent(pre.sale_id)}`
                              : "#";
                  const selServiceName = infoModal.serviceId > 0 ? services.find((s) => s.id === infoModal.serviceId)?.name ?? "" : "";
                  const expiry = pkg?.expires_at ?? pre?.expires_at ?? gbx?.expires_at ?? gft?.expires_at ?? gcd?.expires_at ?? null;
                  // Legacy fmtDateTimeFromSql(exp, {endOfDay:true}): a date-only expiry
                  // renders as end-of-day.
                  const expiryLabel = expiry ? `${fmtQbDateTime(expiry)} 23:59` : "—";
                  const found = pkg || pre || gbx || gft || gcd;
                  const activeBadge = <span className="badge text-bg-success">{kind === "gift" ? "Disponibile" : "Attivo"}</span>;
                  const itemRows =
                    kind === "package" && pkg
                      ? pkg.items.map((it) => ({ key: `${it.service_id}`, name: it.service_name, rem: it.sessions_remaining, tot: it.sessions_total, selected: it.service_id === infoModal.serviceId }))
                      : kind === "giftbox" && gbx
                        ? gbx.items.map((it) => ({ key: `${it.giftbox_item_id}`, name: it.service_name, rem: it.qty_remaining, tot: it.qty_total, selected: infoModal.itemId !== undefined && it.giftbox_item_id === infoModal.itemId }))
                        : [];
                  return (
                    <>
                      <div className="modal-header align-items-start">
                        <div className="d-flex align-items-start w-100">
                          <div>
                            <div className="small-muted">{kindLabel}</div>
                            <h5 className="modal-title fw-bold m-0">{title}</h5>
                          </div>
                          <div className="ms-auto d-flex flex-column align-items-end text-end">
                            <a className="btn btn-sm btn-outline-secondary" href={openNewHref} target="_blank" rel="noopener">
                              <i className="bi bi-box-arrow-up-right me-1" />Apri in nuova scheda
                            </a>
                            <div className="small text-muted mt-1">{subtitle}</div>
                          </div>
                        </div>
                        <button type="button" className="btn-close ms-2" aria-label="Chiudi" onClick={() => setInfoModal(null)} />
                      </div>
                      <div className="modal-body">
                        <div className="p-1">
                          {residualsDetailLoading ? (
                            <div className="app-inline-loading text-muted small p-2" role="status" aria-live="polite">
                              <span className="spinner-border spinner-border-sm text-primary qb-inline-loader" aria-hidden="true" />
                              <span>Caricamento...</span>
                            </div>
                          ) : residualsDetailError ? (
                            <div className="text-danger small p-2">{residualsDetailError}</div>
                          ) : !found ? (
                            <div className="text-muted small p-2">Nessun dettaglio disponibile.</div>
                          ) : (
                            <>
                              <div className="mb-2">
                                <div className="fw-bold">{title}</div>
                                <div className="text-muted small">Stato: {activeBadge} • Scade: {expiryLabel}</div>
                                {pkg ? (
                                  <div className="text-muted small">Residuo complessivo: {Math.max(0, pkg.sessions_remaining)}{pkg.sessions_total > 0 ? ` / ${pkg.sessions_total}` : ""}</div>
                                ) : null}
                                {pre ? (
                                  <>
                                    <div className="text-muted small">Quantità residua: {pre.remaining_qty}{pre.purchased_qty > 0 ? ` / ${pre.purchased_qty}` : ""}</div>
                                    {pre.unit_price > 0 ? <div className="text-muted small">Prezzo unitario: {fmtEUR(pre.unit_price)}</div> : null}
                                  </>
                                ) : null}
                                {gbx ? (
                                  <div className="text-muted small">Residuo complessivo: {Math.max(0, gbx.remaining_qty)}{gbx.total_qty > 0 ? ` / ${gbx.total_qty}` : ""}</div>
                                ) : null}
                                {gft ? <div className="text-muted small">Premio: {gft.service_name}</div> : null}
                                {gcd ? (
                                  <>
                                    <div className="text-muted small">Saldo: {fmtEUR(gcd.balance)}</div>
                                    {infoModal.usedAmount && infoModal.usedAmount > 0 ? (
                                      <div className="text-muted small">Applicata a questa prenotazione: {fmtEUR(infoModal.usedAmount)}</div>
                                    ) : null}
                                  </>
                                ) : null}
                              </div>
                              {selServiceName ? (
                                <div className="alert alert-light border small py-2 px-2 mb-3">
                                  Servizio selezionato: <span className="fw-semibold">{selServiceName}</span>
                                </div>
                              ) : null}
                              {itemRows.length > 0 ? (
                                <div className="card">
                                  <div className="card-header py-2">
                                    <div className="small text-muted">{kind === "package" ? "Dettaglio sedute" : "Contenuto GiftBox"}</div>
                                  </div>
                                  <div className="list-group list-group-flush">
                                    {itemRows.map((row) => (
                                      <div
                                        key={row.key}
                                        className={`list-group-item d-flex justify-content-between align-items-start${row.selected ? " list-group-item-warning" : ""}`}
                                        title={row.tot > 0 ? `Residuo ${row.rem}/${row.tot}` : undefined}
                                      >
                                        <div className="me-2">
                                          <div className="fw-semibold">{row.name}</div>
                                          {row.selected ? <div className="small text-muted">Selezionato in questa prenotazione</div> : null}
                                        </div>
                                        <div className="text-end ms-auto" style={{ whiteSpace: "nowrap" }}>
                                          {row.tot > 0 ? (
                                            <>
                                              <span className="badge text-bg-secondary">{row.rem}</span>
                                              <span className="text-muted small ms-1">/{row.tot}</span>
                                            </>
                                          ) : (
                                            <span className="text-muted small">—</span>
                                          )}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                            </>
                          )}
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
          <div className="modal-backdrop fade show" onClick={() => setInfoModal(null)} />
        </>
      ) : null}

      {/* ===================== CANCEL-DONE PREVIEW MODAL (port of #qbDoneCancelModal) ===================== */}
      {/* Preview-lock for the done->canceled/no_show storno: shows what will be restored/
          reversed + a reason field BEFORE applying. Title branches on the target
          ("Conferma annullamento" vs "Conferma No show"). Confirm is DISABLED while loading
          or when the preview carries an error/blockers (legacy qbBuildDoneCancelPreviewHtml
          + the qbSubmitDoneCancel blockers gate). Cancel/close aborts (status stays Eseguito). */}
      <div
        className="modal fade"
        id="qbDoneCancelModal"
        tabIndex={-1}
        aria-hidden="true"
        data-bs-backdrop="static"
        data-bs-keyboard="false"
      >
        <div className="modal-dialog modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header">
              <h5 className="modal-title fw-bold m-0">
                {doneCancelTarget === "no_show" ? "Marca No show" : "Annulla prenotazione"}
              </h5>
              <button
                type="button"
                className="btn-close"
                aria-label="Chiudi"
                onClick={() => closeDoneCancelModal(null)}
              />
            </div>
            <div className="modal-body">
              {doneCancelLoading ? (
                <div className="text-muted small py-2">Caricamento del riepilogo annullamento...</div>
              ) : (
                <>
                  <div className="alert alert-warning mb-3">
                    <div className="fw-semibold mb-1">
                      {doneCancelTarget === "no_show" ? "Conferma No show" : "Conferma annullamento"}
                    </div>
                    <div className="small">
                      {doneCancelTarget === "no_show"
                        ? "Questa operazione marcherà come No show la prenotazione."
                        : "Questa operazione annullerà la prenotazione."}
                    </div>
                    <div className="small mt-2 fw-semibold">
                      {doneCancelTarget === "no_show"
                        ? "Dopo il No show la prenotazione non sarà più modificabile."
                        : "Dopo l'annullamento la prenotazione non sarà più modificabile."}
                    </div>
                  </div>

                  {doneCancelPreview && doneCancelPreview.summary.length > 0 ? (
                    <>
                      <div className="small text-muted mb-1">Riepilogo:</div>
                      <ul className="small mb-3">
                        {doneCancelPreview.summary.map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}

                  {/* Blockers (or a load error) gate the storno — Confirm stays disabled. */}
                  {doneCancelError || (doneCancelPreview && doneCancelPreview.blockers.length > 0) ? (
                    <div className="alert alert-danger mb-3">
                      <div className="fw-semibold mb-1">
                        {doneCancelTarget === "no_show" ? "No show non disponibile" : "Annullamento non disponibile"}
                      </div>
                      <ul className="mb-0">
                        {doneCancelError ? <li>{doneCancelError}</li> : null}
                        {(doneCancelPreview?.blockers ?? []).map((b, i) => (
                          <li key={i}>{b}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {doneCancelPreview && doneCancelPreview.warnings.length > 0 ? (
                    <div className="alert alert-info mb-3">
                      <div className="fw-semibold mb-1">Attenzione</div>
                      <ul className="mb-0">
                        {doneCancelPreview.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <div className="mb-2">
                    <label className="form-label">Motivazione (opzionale)</label>
                    <textarea
                      className="form-control"
                      id="qbDoneCancelReason"
                      rows={3}
                      maxLength={255}
                      placeholder="Es. errore operatore / cliente ha cambiato idea..."
                      value={doneCancelReason}
                      onChange={(e) => setDoneCancelReason(e.target.value)}
                    />
                    <div className="form-text">Massimo 255 caratteri.</div>
                  </div>
                </>
              )}
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-outline-secondary"
                onClick={() => closeDoneCancelModal(null)}
              >
                Annulla
              </button>
              <button
                type="button"
                className="btn btn-danger"
                id="qbDoneCancelConfirm"
                disabled={
                  doneCancelLoading ||
                  !!doneCancelError ||
                  !doneCancelPreview ||
                  !doneCancelPreview.ok ||
                  doneCancelPreview.blockers.length > 0
                }
                onClick={() => closeDoneCancelModal({ reason: doneCancelReason.trim().slice(0, 255) })}
              >
                {doneCancelTarget === "no_show" ? "Conferma No show" : "Conferma annullamento"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ===================== RESIDUALS DETAIL MODAL (port of #qbClientResidualsModal) =====================
          Read-only "Apri scheda" viewer of the selected client's residuals: the five
          sections (Servizi/Omaggi/GiftBox/GiftCard/Pacchetti) + a Credito line, each with
          per-item detail (name, remaining/total, expiry, source sale #). Opened by
          openResidualsDetail (which fetches action=residuals). INTENTIONAL DIVERGENCE from
          the legacy modal: this is DISPLAY-ONLY — it does NOT reproduce the legacy modal's
          checkbox-driven service-add or its in-modal credit/giftcard entry controls; the
          drawer form already does the redeem SELECTION inline (per-service "Usa …" controls
          + the giftcard/credit price rows), which supersedes them. Bootstrap classes/markup
          kept close to app/lib/View.php:1683 + qbRenderClientResiduals. */}
      {/* ===== Modal Scheda cliente (port of #qbClientCardModal, View.php:1650 +
          qbRenderClientCard): anagrafica + punti Fidelity, Tag, Documenti,
          Storico appuntamenti e Storico vendite del cliente selezionato. ===== */}
      <div className="modal fade" id="qbClientCardModal" tabIndex={-1} aria-hidden="true">
        <div className="modal-dialog modal-xl modal-dialog-scrollable">
          <div className="modal-content" style={{ height: "calc(100vh - 3rem)" }}>
            <div className="modal-header align-items-start">
              <div className="d-flex align-items-start w-100">
                <div>
                  <div className="small-muted">Cliente</div>
                  <h5 className="modal-title fw-bold m-0">Scheda semplificata</h5>
                </div>
                <div className="ms-auto d-flex flex-column align-items-end text-end">
                  <a className="btn btn-sm btn-outline-secondary" id="qbClientCardOpenNew" href={historyOpenHref} target="_blank" rel="noopener">
                    <i className="bi bi-box-arrow-up-right me-1" />Apri in nuova scheda
                  </a>
                  <div className="small text-muted mt-1">Per vedere più dettagli, apri la scheda cliente in una nuova scheda.</div>
                </div>
              </div>
              <button type="button" className="btn-close ms-2" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              <div id="qbClientCardBody" className="p-1">
                {clientCard.loading ? (
                  <div className="app-inline-loading text-muted small p-2" role="status" aria-live="polite">
                    <span className="spinner-border spinner-border-sm text-primary qb-inline-loader" aria-hidden="true" /> Caricamento...
                  </div>
                ) : clientCard.error ? (
                  <div className="text-danger small p-2">{clientCard.error}</div>
                ) : clientCard.data ? (
                  <div className="px-2 pb-2">
                    <div className="d-flex justify-content-between align-items-center mb-3">
                      <div>
                        <div className="text-muted small">Scheda cliente</div>
                        <div className="h5 fw-bold m-0">{clientCard.data.client.full_name || "Cliente"}</div>
                        <div className="text-muted small">{clientCard.data.client.phone || "—"} • {clientCard.data.client.email || "—"}</div>
                      </div>
                    </div>
                    <div className="row g-3">
                      <div className="col-lg-4">
                        <div className="card p-3">
                          <div className="fw-semibold mb-2"><i className="bi bi-award me-1" />Fidelity</div>
                          <div className="display-6 fw-bold">{clientCard.data.client.points}</div>
                          <div className="text-muted small">Punti accumulati</div>
                        </div>
                        <div className="card p-3 mt-3">
                          <div className="fw-semibold mb-2"><i className="bi bi-tags me-1" />Tag</div>
                          <div className="d-flex flex-wrap gap-2">
                            {clientCard.data.tags.length
                              ? clientCard.data.tags.map((tag) => <span className="badge badge-soft me-1 mb-1" key={tag.id}>{tag.name}</span>)
                              : <span className="text-muted small">Nessun tag.</span>}
                          </div>
                        </div>
                        <div className="card p-3 mt-3">
                          <div className="fw-semibold mb-2"><i className="bi bi-file-earmark-arrow-up me-1" />Documenti</div>
                          <div>
                            {clientCard.data.docs.length ? clientCard.data.docs.map((doc) => (
                              <div className="d-flex justify-content-between align-items-center border rounded-3 p-2 mb-2" key={doc.id}>
                                <div>
                                  <div className="fw-semibold">{doc.title || "Documento"}</div>
                                  <div className="text-muted small">{fmtQbDateTime(doc.created_at) || "—"}</div>
                                </div>
                                <div className="d-flex gap-2">
                                  {doc.url
                                    ? <a className="btn btn-sm btn-outline-secondary" target="_blank" rel="noopener" href={doc.url}>Apri</a>
                                    : <span className="text-muted small">Non disponibile</span>}
                                </div>
                              </div>
                            )) : <div className="text-muted small">Nessun documento.</div>}
                          </div>
                        </div>
                      </div>
                      <div className="col-lg-8">
                        <div className="card">
                          <div className="card-header fw-semibold">
                            <i className="bi bi-calendar-check me-2" />Storico appuntamenti
                            <span className="text-muted small ms-2">
                              Ultima: {clientCard.data.summary.last_visit ? fmtQbDateTime(clientCard.data.summary.last_visit) : "—"} • Prossima: {clientCard.data.summary.next_visit ? fmtQbDateTime(clientCard.data.summary.next_visit) : "—"}
                              {clientCard.data.summary.sales_total > 0 ? <> • Vendite: <span className="fw-semibold">{fmtEUR(clientCard.data.summary.sales_total)}</span></> : null}
                            </span>
                          </div>
                          <div className="table-responsive">
                            <table className="table mb-0">
                              <thead><tr><th>Data</th><th>Servizi</th><th>Operatore</th><th className="text-end">Totale</th><th>Stato</th></tr></thead>
                              <tbody>
                                {clientCard.data.appointments.length ? clientCard.data.appointments.map((appt) => {
                                  const badge = badgeForStatus(appt.status);
                                  return (
                                    <tr key={appt.id}>
                                      <td>{fmtQbDateTime(appt.starts_at)}</td>
                                      <td className="text-muted">{appt.services || "—"}</td>
                                      <td className="text-muted">{appt.staff || "—"}</td>
                                      <td className="text-end fw-semibold">{fmtEUR(appt.total)}</td>
                                      <td><span className={`badge text-bg-${badge.cls}`}>{badge.label}</span></td>
                                    </tr>
                                  );
                                }) : <tr><td colSpan={5} className="text-muted p-3">Nessun appuntamento.</td></tr>}
                              </tbody>
                            </table>
                          </div>
                        </div>
                        <div className="card mt-3">
                          <div className="card-header fw-semibold"><i className="bi bi-receipt me-2" />Storico vendite</div>
                          <div className="table-responsive">
                            <table className="table mb-0">
                              <thead><tr><th>Data</th><th>Totale</th><th>Note</th></tr></thead>
                              <tbody>
                                {clientCard.data.sales.length ? clientCard.data.sales.map((sale) => (
                                  <tr key={sale.id}>
                                    <td>{fmtQbDateTime(sale.sale_date)}</td>
                                    <td className="fw-semibold">{fmtEUR(sale.total)}</td>
                                    <td className="text-muted">{sale.notes || "—"}</td>
                                  </tr>
                                )) : <tr><td colSpan={3} className="text-muted p-3">Nessuna vendita.</td></tr>}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="modal fade" id="qbClientResidualsModal" tabIndex={-1} aria-hidden="true">
        <div className="modal-dialog modal-lg modal-dialog-scrollable">
          <div className="modal-content">
            <div className="modal-header align-items-start">
              <div>
                <div className="small text-muted">Cliente</div>
                <h5 className="modal-title fw-bold m-0">Residui</h5>
              </div>
              <div className="ms-auto d-flex flex-column align-items-end text-end">
                {clientId ? (
                  <a
                    className="btn btn-sm btn-outline-secondary"
                    id="qbClientResidualsOpenNew"
                    href={`/${encodeURIComponent(slug)}/clients?action=view&id=${encodeURIComponent(clientId)}`}
                    target="_blank"
                    rel="noopener"
                  >
                    <i className="bi bi-box-arrow-up-right me-1" />Apri in nuova scheda
                  </a>
                ) : null}
                <div className="small text-muted mt-1">Mostra solo residui attivi e non scaduti.</div>
              </div>
              <button type="button" className="btn-close ms-2" data-bs-dismiss="modal" aria-label="Chiudi" />
            </div>
            <div className="modal-body">
              <div className="small text-muted mb-3">
                Cliente: <strong id="qbClientResidualsClientLabel">{client?.full_name || "—"}</strong>
              </div>

              {residualsDetailLoading ? (
                <div className="app-inline-loading text-muted small p-2" role="status" aria-live="polite">
                  <span className="spinner-border spinner-border-sm text-primary qb-inline-loader" aria-hidden="true" />
                  <span> Caricamento...</span>
                </div>
              ) : residualsDetailError ? (
                <div className="text-danger small p-2">{residualsDetailError}</div>
              ) : (
                <>
                  {/* Empty state verbatim (View.php:1706). Visibile solo senza credito e senza liste. */}
                  {!residualsDetailHasAny && !(clientCredit > 0 || currentCreditUse > 0) ? (
                    <div className="alert alert-light border small" id="qbClientResidualsEmptyState">
                      Nessun residuo disponibile per il cliente selezionato.
                    </div>
                  ) : null}

                  {/* CREDITO (card statica legacy #qbResidualCreditCard, View.php:1710-1727):
                      toggle "Disponibile", importo con clamp [0, min(saldo, dovuto)], Usa max,
                      hint "Saldo tessera • Max utilizzabile" / "Credito non disponibile.". */}
                  {clientCredit > 0 || currentCreditUse > 0 ? (
                    <div className="card p-3 mb-3" id="qbResidualCreditCard">
                      <div className="fw-semibold mb-1">Credito</div>
                      <div className="small text-muted mb-3">Utilizza il credito disponibile del cliente per questa prenotazione.</div>
                      <div className="form-check form-switch mb-2">
                        <input
                          className="form-check-input"
                          type="checkbox"
                          id="qbResidualCreditToggle"
                          checked={currentCreditUse > 0}
                          disabled={!(clientCredit > 0)}
                          onChange={(e) => {
                            if (!e.target.checked) {
                              setCreditInput("");
                            } else {
                              const next = currentCreditUse > 0 ? Math.min(currentCreditUse, creditMaxUsable) : creditMaxUsable;
                              setCreditInput(next > 0 ? String(Math.round(next * 100) / 100) : "");
                            }
                          }}
                        />
                        <label className="form-check-label" htmlFor="qbResidualCreditToggle">
                          Disponibile: <strong id="qbResidualCreditAvail">{fmtEUR(clientCredit)}</strong>
                        </label>
                      </div>
                      <label className="form-label small text-muted mb-1">Importo da usare</label>
                      <div className="input-group input-group-sm" style={{ maxWidth: 260 }}>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          className="form-control"
                          id="qbResidualCreditAmount"
                          value={currentCreditUse > 0 ? creditInput : "0"}
                          disabled={!(currentCreditUse > 0)}
                          onChange={(e) => {
                            const raw = Number(String(e.target.value).replace(",", "."));
                            const val = Math.min(Math.max(Number.isFinite(raw) ? raw : 0, 0), creditMaxUsable);
                            setCreditInput(val > 0 ? String(Math.round(val * 100) / 100) : "");
                          }}
                        />
                        <button
                          type="button"
                          className="btn btn-outline-secondary"
                          id="qbResidualCreditMaxBtn"
                          disabled={!(clientCredit > 0) || !(creditMaxUsable > 0)}
                          onClick={() => setCreditInput(creditMaxUsable > 0 ? String(Math.round(creditMaxUsable * 100) / 100) : "")}
                        >
                          Usa max
                        </button>
                      </div>
                      <div className="form-text" id="qbResidualCreditHint">
                        {clientCredit > 0
                          ? `Saldo tessera: ${fmtEUR(clientCredit)} • Max utilizzabile: ${fmtEUR(creditMaxUsable)}${creditMaxUsable <= 0 ? " • Aggiungi prima i servizi per usare il credito." : ""}`
                          : "Credito non disponibile."}
                      </div>
                    </div>
                  ) : null}

                  <div id="qbClientResidualsBody" className="p-1">
                  {/* SERVIZI (prepagati) — spunte che collegano il residuo (app.js:1004-1063). */}
                  {residualsDetail && residualsDetail.services.length > 0 ? (
                    <div className="card p-3 mb-3">
                      <div className="fw-bold mb-2">Servizi</div>
                      <div className="text-muted small mb-2">Seleziona o deseleziona i servizi acquistati: verranno aggiunti o rimossi automaticamente dalla prenotazione.</div>
                      {residualsDetail.services.map((s, i) => {
                        const busyKey = `ps-${s.id}-${s.service_id}`;
                        const isChecked = prepaidRedeems[s.service_id]?.client_prepaid_service_id === s.id;
                        return (
                          <div className="border-top pt-2 mt-2" key={`svc-${i}`}>
                            <div className="d-flex justify-content-between align-items-start">
                              <div className="me-3 form-check">
                                <input
                                  className="form-check-input qb-ps-svc-check"
                                  type="checkbox"
                                  id={`qb_ps_${s.id}_${s.service_id}`}
                                  checked={Boolean(isChecked)}
                                  disabled={residualBusyKey === busyKey}
                                  onChange={(e) => void onResidualToggle({
                                    kind: "prepaid",
                                    busyKey,
                                    serviceId: s.service_id,
                                    label: s.service_name,
                                    checked: e.target.checked,
                                    checkItem: { client_prepaid_service_id: s.id, prepaid_service_id: s.id, service_id: s.service_id, qty: 1 },
                                    apply: () => setPrepaidRedeems((prev) => ({ ...prev, [s.service_id]: { client_prepaid_service_id: s.id, service_id: s.service_id } })),
                                  })}
                                />
                                <label className="form-check-label" htmlFor={`qb_ps_${s.id}_${s.service_id}`}>
                                  <span className="fw-semibold">{s.service_name}</span>
                                  {s.remaining_qty > 0 ? <span className="badge text-bg-secondary ms-2">{s.remaining_qty}</span> : null}
                                  {s.purchased_qty > 0 ? <span className="text-muted small ms-1">/{s.purchased_qty}</span> : null}
                                </label>
                                <div className="text-muted small">
                                  Acquistato{s.sale_id ? ` con vendita #${s.sale_id}` : ""} • Scade: {fmtYMD(s.expires_at)}
                                </div>
                              </div>
                              <div className="text-end">
                                <div className="fw-semibold">{fmtEUR(s.unit_price)}</div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}

                  {/* OMAGGI (app.js:1066-1135). */}
                  {residualsDetail && residualsDetail.gifts.length > 0 ? (
                    <div className="card p-3 mb-3">
                      <div className="fw-bold mb-2">Omaggi</div>
                      <div className="text-muted small mb-2">Seleziona o deseleziona i servizi omaggio: verranno aggiunti o rimossi automaticamente dalla prenotazione.</div>
                      {residualsDetail.gifts.map((g, i) => {
                        const busyKey = `og-${g.instance_id}-${g.reward_item_index}-${g.service_id}`;
                        const pick = giftRedeems[g.service_id];
                        const isChecked = Boolean(pick && pick.instance_id === g.instance_id && pick.reward_item_index === g.reward_item_index);
                        return (
                          <div className="border-top pt-2 mt-2" key={`gift-${i}`}>
                            <div className="small text-muted mb-1">{g.gift_name}</div>
                            <div className="form-check">
                              <input
                                className="form-check-input qb-og-svc-check"
                                type="checkbox"
                                id={`qb_og_${g.instance_id}_${g.reward_item_index}_${g.service_id}`}
                                checked={isChecked}
                                disabled={residualBusyKey === busyKey}
                                onChange={(e) => void onResidualToggle({
                                  kind: "gift",
                                  busyKey,
                                  serviceId: g.service_id,
                                  label: g.service_name,
                                  checked: e.target.checked,
                                  checkItem: { instance_id: g.instance_id, reward_item_index: g.reward_item_index, service_id: g.service_id, qty: 1 },
                                  apply: () => setGiftRedeems((prev) => ({ ...prev, [g.service_id]: { service_id: g.service_id, instance_id: g.instance_id, reward_item_index: g.reward_item_index } })),
                                })}
                              />
                              <label className="form-check-label" htmlFor={`qb_og_${g.instance_id}_${g.reward_item_index}_${g.service_id}`}>
                                <span className="fw-semibold">{g.service_name}</span>
                                {g.qty_remaining > 0 ? <span className="badge text-bg-secondary ms-2">{g.qty_remaining}</span> : null}
                                {g.qty_total > 0 ? <span className="text-muted small ms-1">/{g.qty_total}</span> : null}
                              </label>
                              <div className="text-muted small">Scade: {fmtYMD(g.expires_at)}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}

                  {/* GIFTBOX (app.js:1137-1208). */}
                  {residualsDetail && residualsDetail.giftboxes.length > 0 ? (
                    <div className="card p-3 mb-3">
                      <div className="fw-bold mb-2">GiftBox</div>
                      <div className="text-muted small mb-2">Seleziona o deseleziona i servizi: verranno aggiunti o rimossi automaticamente dalla prenotazione.</div>
                      {residualsDetail.giftboxes.map((gb, i) => (
                        <div className="border-top pt-2 mt-2" key={`gb-${i}`}>
                          <div className="fw-semibold">
                            {gb.giftbox_name}{" "}
                            {gb.code ? (
                              <span className="text-muted small">
                                <code>{gb.code}</code>
                              </span>
                            ) : null}
                          </div>
                          <div className="text-muted small">
                            Residuo: {gb.remaining_qty}
                            {gb.total_qty ? ` / ${gb.total_qty}` : ""} • Scade: {fmtYMD(gb.expires_at)}
                          </div>
                          <div className="mt-2">
                            <div className="small text-muted mb-1">Servizi residui:</div>
                            {gb.items.length > 0 ? gb.items.map((it, j) => {
                              const busyKey = `gb-${gb.instance_id}-${it.giftbox_item_id}`;
                              const pick = giftboxRedeems[it.service_id];
                              const isChecked = Boolean(pick && pick.instance_id === gb.instance_id && pick.giftbox_item_id === it.giftbox_item_id);
                              return (
                                <div className="form-check" key={`gb-${i}-it-${j}`}>
                                  <input
                                    className="form-check-input qb-gb-svc-check"
                                    type="checkbox"
                                    id={`qb_gb_${gb.instance_id}_${it.giftbox_item_id}`}
                                    checked={isChecked}
                                    disabled={residualBusyKey === busyKey}
                                    onChange={(e) => void onResidualToggle({
                                      kind: "giftbox",
                                      busyKey,
                                      serviceId: it.service_id,
                                      label: it.service_name,
                                      checked: e.target.checked,
                                      checkItem: { instance_id: gb.instance_id, giftbox_item_id: it.giftbox_item_id, service_id: it.service_id, qty: 1 },
                                      apply: () => setGiftboxRedeems((prev) => ({ ...prev, [it.service_id]: { instance_id: gb.instance_id, giftbox_item_id: it.giftbox_item_id, service_id: it.service_id } })),
                                    })}
                                  />
                                  <label className="form-check-label small" htmlFor={`qb_gb_${gb.instance_id}_${it.giftbox_item_id}`}>
                                    {it.service_name}
                                    {it.qty_remaining > 0 ? <span className="badge text-bg-secondary ms-2">{it.qty_remaining}</span> : null}
                                    {it.qty_total ? <span className="text-muted small ms-1">/{it.qty_total}</span> : null}
                                  </label>
                                </div>
                              );
                            }) : (
                              <div className="text-muted small">Nessun servizio residuo selezionabile.</div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {/* GIFTCARD single-select + importo + Applica/Rimuovi (app.js:1209-1269 + 2348-2422). */}
                  {residualsDetail && residualsDetail.giftcards.length > 0 ? (
                    <div className="card p-3 mb-3">
                      <div className="fw-bold mb-2">GiftCard</div>
                      <div className="text-muted small mb-2">
                        Seleziona una GiftCard, scegli l&apos;importo e premi <span className="fw-semibold">Applica</span>.
                      </div>
                      {residualsDetail.giftcards.map((gc, i) => {
                        const isDisabled = !(Number(gc.balance) > 0.0000001);
                        const isSel = gcSelId === gc.id;
                        return (
                          <div className="border-top pt-2 mt-2" key={`gc-${i}`}>
                            <div className="d-flex justify-content-between align-items-start">
                              <div className="me-3 form-check">
                                <input
                                  className="form-check-input qb-gc-radio"
                                  type="radio"
                                  name="qb_gc_sel"
                                  id={`qb_gc_${gc.id}`}
                                  checked={isSel}
                                  disabled={isDisabled}
                                  onChange={() => {
                                    setGcSelId(gc.id);
                                    if (!gcAmountInput.trim()) {
                                      const maxUse = dueBeforePayments > 0 ? Math.min(gc.balance, dueBeforePayments) : gc.balance;
                                      setGcAmountInput(maxUse > 0 ? String(Math.round(maxUse * 100) / 100) : "");
                                    }
                                  }}
                                />
                                <label className="form-check-label" htmlFor={`qb_gc_${gc.id}`}>
                                  <span className="fw-semibold"><code>{gc.code}</code></span>
                                </label>
                                <div className="text-muted small">Scade: {fmtYMD(gc.expires_at)}</div>
                              </div>
                              <div className="text-end">
                                <div className="fw-semibold">{fmtEUR(gc.balance)}</div>
                                {isDisabled ? <div className="text-muted small">Saldo non disponibile</div> : null}
                              </div>
                            </div>
                            <div className={`mt-2 qb-gc-controls${isSel ? "" : " d-none"}`}>
                              <label className="form-label small text-muted mb-1">Importo da usare</label>
                              <div className="input-group input-group-sm" style={{ maxWidth: 300 }}>
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  max={gc.balance}
                                  className="form-control qb-gc-amount"
                                  placeholder="0,00"
                                  value={isSel ? gcAmountInput : ""}
                                  disabled={isDisabled}
                                  onChange={(e) => setGcAmountInput(e.target.value)}
                                />
                                <button
                                  type="button"
                                  className="btn btn-outline-secondary qb-gc-max"
                                  disabled={isDisabled}
                                  onClick={() => {
                                    const maxUse = dueBeforePayments > 0 ? Math.min(gc.balance, dueBeforePayments) : gc.balance;
                                    setGcAmountInput(maxUse > 0 ? String(Math.round(maxUse * 100) / 100) : "");
                                  }}
                                >
                                  Usa max
                                </button>
                                <button type="button" className="btn btn-outline-success qb-gc-apply" disabled={isDisabled} onClick={applyModalGiftcard}>
                                  Applica
                                </button>
                              </div>
                              <div className="form-text">Max: {fmtEUR(gc.balance)}</div>
                            </div>
                          </div>
                        );
                      })}
                      {giftcardPick && priceDetails.giftcardMonetary > 0 ? (
                        <div className="mt-3">
                          <button type="button" className="btn btn-sm btn-outline-danger qb-gc-remove" onClick={removeModalGiftcard}>
                            Rimuovi GiftCard applicata
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {/* PACCHETTI (app.js:1271-1346). */}
                  {residualsDetail && residualsDetail.packages.length > 0 ? (
                    <div className="card p-3 mb-3">
                      <div className="fw-bold mb-2">Pacchetti</div>
                      <div className="text-muted small mb-2">Seleziona o deseleziona le sedute: verranno aggiunte o rimosse automaticamente dalla prenotazione.</div>
                      {residualsDetail.packages.map((p, i) => (
                        <div className="border-top pt-2 mt-2" key={`pkg-${i}`}>
                          <div className="fw-semibold">{p.package_name}</div>
                          <div className="text-muted small">
                            Residuo: {p.sessions_remaining}
                            {p.sessions_total ? ` / ${p.sessions_total}` : ""} • Scade: {fmtYMD(p.expires_at)}
                            {p.sale_id ? ` • Vendita #${p.sale_id}` : ""}
                          </div>
                          <div className="mt-2">
                            <div className="small text-muted mb-1">Sedute residue:</div>
                            {p.items.length > 0 ? p.items.map((it, j) => {
                              const busyKey = `cp-${p.id}-${it.service_id}`;
                              const isChecked = packageRedeems[it.service_id]?.client_package_id === p.id;
                              return (
                                <div className="form-check" key={`pkg-${i}-it-${j}`}>
                                  <input
                                    className="form-check-input qb-cp-svc-check"
                                    type="checkbox"
                                    id={`qb_cp_${p.id}_${it.service_id}`}
                                    checked={Boolean(isChecked)}
                                    disabled={residualBusyKey === busyKey}
                                    onChange={(e) => void onResidualToggle({
                                      kind: "package",
                                      busyKey,
                                      serviceId: it.service_id,
                                      label: it.service_name,
                                      checked: e.target.checked,
                                      checkItem: { client_package_id: p.id, client_package_service_id: null, service_id: it.service_id, qty: 1 },
                                      apply: () => setPackageRedeems((prev) => ({ ...prev, [it.service_id]: { client_package_id: p.id, service_id: it.service_id, client_package_service_id: null } })),
                                    })}
                                  />
                                  <label className="form-check-label small" htmlFor={`qb_cp_${p.id}_${it.service_id}`}>
                                    {it.service_name}
                                    {it.sessions_remaining > 0 ? <span className="badge text-bg-secondary ms-2">{it.sessions_remaining}</span> : null}
                                    {it.sessions_total ? <span className="text-muted small ms-1">/{it.sessions_total}</span> : null}
                                  </label>
                                </div>
                              );
                            }) : p.breakdown ? (
                              <div className="text-muted small">{p.breakdown}</div>
                            ) : (
                              <div className="text-muted small">Nessuna seduta residua selezionabile.</div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
