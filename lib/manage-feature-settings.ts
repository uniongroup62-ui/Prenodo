import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { tenantSelect, tenantUpdate } from "@/lib/tenant-db";
import type { ConfigModuleState, ConfigRecord } from "@/lib/tenant-store";

// Settings persistence for the five "manage" settings modules whose faithful
// components previously fell through to a generic touch (no real save):
//   giftcard_settings, giftbox_settings, package_settings, quote_settings,
//   fidelity_membership (card validity settings, page fidelity_membership_settings).
//
// Every module persists onto the single `businesses` row (the legacy PHP pages
// always target `SELECT id FROM businesses ORDER BY id ASC LIMIT 1`). All reads
// and writes are tenant-scoped through tenant-db's tenantSelect/tenantUpdate,
// which inject `tenant_id = ?` on the shared schema.

type ExpiryUnit = "days" | "months" | "years";

const MAX_TERMS = 12000;

// ---- shared helpers ----

async function firstBusinessRow(slug: string): Promise<RowDataPacket> {
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 });
  return rows[0] ?? ({} as RowDataPacket);
}

async function businessId(slug: string): Promise<number> {
  const row = await firstBusinessRow(slug);
  const id = Number(row.id ?? 0);
  if (id <= 0) throw new Error("Business non trovato.");
  return id;
}

function normalizeValidityValue(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(36500, parsed);
}

function normalizeUnit(value: unknown): ExpiryUnit {
  const unit = String(value ?? "").toLowerCase();
  if (unit === "months" || unit === "years") return unit;
  return "days";
}

function enabledFlag(value: unknown): number {
  const raw = String(value ?? "").toLowerCase();
  return value === true || value === 1 || raw === "1" || raw === "true" || raw === "yes" || raw === "on" ? 1 : 0;
}

// Normalize multiline text exactly like the PHP pages (CRLF/CR -> LF, trim, cap).
function normalizeTerms(value: unknown, max = MAX_TERMS): string {
  let text = String(value ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (text.length > max) text = text.slice(0, max);
  return text;
}

function created(row: RowDataPacket): unknown {
  return row.created_at ?? new Date();
}

function record(module: string, id: number, title: string, detail: string, value: string, active: boolean, updatedAt: unknown): ConfigRecord {
  return { id, module, title, detail, value, active, updatedAt: dateTimeString(updatedAt) };
}

function dateTimeString(value: unknown): string {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

// ========================================================================
// GiftCard settings  ->  businesses.giftcard_default_validity_value/_unit,
//                        businesses.giftcard_terms
// ========================================================================

export async function getGiftcardSettings(slug: string): Promise<ConfigModuleState> {
  const row = await firstBusinessRow(slug);
  const value = normalizeValidityValue(row.giftcard_default_validity_value);
  const unit = normalizeUnit(row.giftcard_default_validity_unit);
  const terms = String(row.giftcard_terms ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return {
    id: "giftcard_settings",
    title: "Impostazioni GiftCard",
    records: [
      record("giftcard_settings", 1, "Validita predefinita", `${value} ${unit}`, "Default emissione", true, created(row)),
      record("giftcard_settings", 2, "Termini GiftCard", terms, terms.trim() ? "Configurati" : "Da configurare", true, created(row)),
      record("giftcard_settings", 3, "Voucher pubblico", "Token pubblico, importo nascosto e invio email", "Gestito da giftcard.php", true, created(row)),
    ],
    settings: { giftcard_default_validity_value: value, giftcard_default_validity_unit: unit, giftcard_terms: terms },
    updatedAt: dateTimeString(created(row)),
  };
}

export async function saveGiftcardValidityDefault(slug: string, input: Record<string, unknown>): Promise<ConfigModuleState> {
  const id = await businessId(slug);
  await tenantUpdate({
    slug,
    table: "businesses",
    id,
    values: {
      giftcard_default_validity_value: normalizeValidityValue(input.giftcard_default_validity_value),
      giftcard_default_validity_unit: normalizeUnit(input.giftcard_default_validity_unit),
    },
  });
  return getGiftcardSettings(slug);
}

export async function saveGiftcardTerms(slug: string, input: Record<string, unknown>): Promise<ConfigModuleState> {
  const id = await businessId(slug);
  const terms = normalizeTerms(input.giftcard_terms);
  await tenantUpdate({ slug, table: "businesses", id, values: { giftcard_terms: terms !== "" ? terms : null } });
  return getGiftcardSettings(slug);
}

export async function resetGiftcardTerms(slug: string): Promise<ConfigModuleState> {
  const id = await businessId(slug);
  await tenantUpdate({ slug, table: "businesses", id, values: { giftcard_terms: null } });
  return getGiftcardSettings(slug);
}

// ========================================================================
// GiftBox settings  ->  businesses.giftbox_default_validity_value/_unit,
//                       businesses.giftbox_terms
// ========================================================================

export async function getGiftboxSettings(slug: string): Promise<ConfigModuleState> {
  const row = await firstBusinessRow(slug);
  const value = normalizeValidityValue(row.giftbox_default_validity_value);
  const unit = normalizeUnit(row.giftbox_default_validity_unit);
  const terms = String(row.giftbox_terms ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return {
    id: "giftbox_settings",
    title: "Impostazioni GiftBox",
    records: [
      record("giftbox_settings", 1, "Validita predefinita", `${value} ${unit}`, "Default emissione", true, created(row)),
      record("giftbox_settings", 2, "Termini GiftBox", terms, terms.trim() ? "Configurati" : "Da configurare", true, created(row)),
    ],
    settings: { giftbox_default_validity_value: value, giftbox_default_validity_unit: unit, giftbox_terms: terms },
    updatedAt: dateTimeString(created(row)),
  };
}

export async function saveGiftboxValidityDefault(slug: string, input: Record<string, unknown>): Promise<ConfigModuleState> {
  const id = await businessId(slug);
  await tenantUpdate({
    slug,
    table: "businesses",
    id,
    values: {
      giftbox_default_validity_value: normalizeValidityValue(input.giftbox_default_validity_value),
      giftbox_default_validity_unit: normalizeUnit(input.giftbox_default_validity_unit),
    },
  });
  return getGiftboxSettings(slug);
}

export async function saveGiftboxTerms(slug: string, input: Record<string, unknown>): Promise<ConfigModuleState> {
  const id = await businessId(slug);
  const terms = normalizeTerms(input.giftbox_terms);
  await tenantUpdate({ slug, table: "businesses", id, values: { giftbox_terms: terms !== "" ? terms : null } });
  return getGiftboxSettings(slug);
}

export async function resetGiftboxTerms(slug: string): Promise<ConfigModuleState> {
  const id = await businessId(slug);
  await tenantUpdate({ slug, table: "businesses", id, values: { giftbox_terms: null } });
  return getGiftboxSettings(slug);
}

// ========================================================================
// Package settings  ->  businesses.package_default_validity_value/_unit
// ========================================================================

export async function getPackageSettings(slug: string): Promise<ConfigModuleState> {
  const row = await firstBusinessRow(slug);
  const value = normalizeValidityValue(row.package_default_validity_value);
  const unit = normalizeUnit(row.package_default_validity_unit);
  return {
    id: "package_settings",
    title: "Impostazioni pacchetti",
    records: [
      record("package_settings", 1, "Validita predefinita", `${value} ${unit}`, "Default vendita", true, created(row)),
    ],
    settings: { package_default_validity_value: value, package_default_validity_unit: unit },
    updatedAt: dateTimeString(created(row)),
  };
}

export async function savePackageValidityDefault(slug: string, input: Record<string, unknown>): Promise<ConfigModuleState> {
  const id = await businessId(slug);
  await tenantUpdate({
    slug,
    table: "businesses",
    id,
    values: {
      package_default_validity_value: normalizeValidityValue(input.package_default_validity_value),
      package_default_validity_unit: normalizeUnit(input.package_default_validity_unit),
    },
  });
  return getPackageSettings(slug);
}

// ========================================================================
// Quote settings  ->  businesses.quote_* (fiscal/header), quote_terms,
//                     quote_footer, payment_methods
// ========================================================================

// Fiscal/header fields with their DB max length (mirrors the PHP validation map).
const QUOTE_PROFILE_FIELDS: Array<[string, number]> = [
  ["quote_company_name", 255],
  ["quote_vat_number", 40],
  ["quote_tax_code", 40],
  ["quote_sdi", 40],
  ["quote_pec", 190],
  ["quote_region", 190],
  ["quote_province", 190],
  ["quote_city", 190],
  ["quote_cap", 20],
  ["quote_address", 255],
  ["quote_phone", 40],
  ["quote_email", 190],
  ["quote_website", 190],
];

function normalizeQuoteUrl(value: string): string {
  const url = value.trim();
  if (!url) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.protocol && parsed.host);
  } catch {
    return false;
  }
}

// Split a stored "Nome: dettagli" line into structured name + details for the UI.
function splitPaymentLine(line: string): { name: string; details: string } {
  const trimmed = line.trim();
  if (!trimmed) return { name: "", details: "" };
  const pos = trimmed.indexOf(":");
  if (pos !== -1) {
    const left = trimmed.slice(0, pos).trim();
    const right = trimmed.slice(pos + 1).trim();
    if (left !== "" && left.length <= 80) return { name: left, details: right };
  }
  return { name: trimmed, details: "" };
}

function paymentMethodRowsFromRaw(raw: unknown): Array<{ name: string; details: string }> {
  const text = String(raw ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text) return [];
  // Compatibility with a possible future JSON encoding.
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const out: Array<{ name: string; details: string }> = [];
      for (const item of parsed) {
        if (item && typeof item === "object") {
          const name = String((item as Record<string, unknown>).name ?? "").trim();
          const details = String((item as Record<string, unknown>).details ?? "").trim();
          if (name) out.push({ name, details });
        } else {
          const line = String(item ?? "").trim();
          if (line) out.push(splitPaymentLine(line));
        }
        if (out.length >= 50) break;
      }
      return out;
    }
  } catch {
    /* not JSON: fall through to line parsing */
  }
  const out: Array<{ name: string; details: string }> = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(splitPaymentLine(trimmed));
    if (out.length >= 50) break;
  }
  return out;
}

// Build the raw `payment_methods` text from structured pm_name[]/pm_details[] arrays.
function paymentMethodsRawFromInput(input: Record<string, unknown>): string {
  const names = input.pm_name;
  const details = input.pm_details;
  if (Array.isArray(names)) {
    const detailsArr = Array.isArray(details) ? details : [];
    const lines: string[] = [];
    const max = Math.min(50, names.length);
    for (let i = 0; i < max; i += 1) {
      let name = String(names[i] ?? "").replace(/[\r\n]+/g, " ").trim();
      let detail = String(detailsArr[i] ?? "").replace(/[\r\n]+/g, " ").trim();
      if (!name) continue;
      if (name.length > 120) name = name.slice(0, 120);
      if (detail.length > 400) detail = detail.slice(0, 400);
      lines.push(detail !== "" ? `${name}: ${detail}` : name);
      if (lines.length >= 50) break;
    }
    return lines.join("\n").slice(0, 8000);
  }
  return String(input.payment_methods ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().slice(0, 8000);
}

export async function getQuoteSettings(slug: string): Promise<ConfigModuleState> {
  const row = await firstBusinessRow(slug);
  const profile: Record<string, string> = {};
  for (const [field] of QUOTE_PROFILE_FIELDS) profile[field] = String(row[field] ?? "").trim();
  const terms = String(row.quote_terms ?? "");
  const footer = String(row.quote_footer ?? "");
  const paymentMethodsRaw = String(row.payment_methods ?? "");

  return {
    id: "quote_settings",
    title: "Impostazioni preventivi",
    records: [
      record("quote_settings", 1, "Intestazione", profile.quote_company_name || String(row.name ?? "Attivita"), profile.quote_email || String(row.email ?? ""), true, created(row)),
      record("quote_settings", 2, "Dati fiscali", [profile.quote_vat_number, profile.quote_tax_code, profile.quote_sdi].filter(Boolean).join(" / ") || "-", profile.quote_city, true, created(row)),
      record("quote_settings", 3, "Footer preventivo", footer, terms, true, created(row)),
      record("quote_settings", 4, "Metodi pagamento", paymentMethodsRaw, "Configurazione preventivi", true, created(row)),
    ],
    settings: {
      ...profile,
      quote_terms: terms,
      quote_footer: footer,
      payment_methods: paymentMethodsRaw,
      payment_methods_rows: JSON.stringify(paymentMethodRowsFromRaw(paymentMethodsRaw)),
    },
    updatedAt: dateTimeString(created(row)),
  };
}

export async function saveQuoteProfile(slug: string, input: Record<string, unknown>): Promise<ConfigModuleState> {
  const id = await businessId(slug);
  const values: Record<string, unknown> = {};
  for (const [field, max] of QUOTE_PROFILE_FIELDS) {
    let value = String(input[field] ?? "").trim();
    if (field === "quote_website") value = normalizeQuoteUrl(value);
    if (value.length > max) throw new Error("Uno dei campi anagrafici supera la lunghezza massima consentita.");
    values[field] = value !== "" ? value : null;
  }
  for (const [field, label] of [["quote_email", "Email documenti"], ["quote_pec", "PEC"]] as const) {
    const value = String(input[field] ?? "").trim();
    if (value !== "" && !isEmail(value)) throw new Error(`${label} non valida.`);
  }
  const website = String(input.quote_website ?? "").trim();
  if (website !== "" && !isUrl(normalizeQuoteUrl(website))) throw new Error("Sito web non valido.");

  await tenantUpdate({ slug, table: "businesses", id, values });
  return getQuoteSettings(slug);
}

export async function saveQuoteConditions(slug: string, input: Record<string, unknown>): Promise<ConfigModuleState> {
  const id = await businessId(slug);
  const terms = String(input.quote_terms ?? "").trim().slice(0, MAX_TERMS);
  const footer = String(input.quote_footer ?? "").trim().slice(0, MAX_TERMS);
  await tenantUpdate({
    slug,
    table: "businesses",
    id,
    values: { quote_terms: terms !== "" ? terms : null, quote_footer: footer !== "" ? footer : null },
  });
  return getQuoteSettings(slug);
}

export async function savePaymentMethods(slug: string, input: Record<string, unknown>): Promise<ConfigModuleState> {
  const id = await businessId(slug);
  const raw = paymentMethodsRawFromInput(input);
  await tenantUpdate({ slug, table: "businesses", id, values: { payment_methods: raw !== "" ? raw : null } });
  return getQuoteSettings(slug);
}

// ========================================================================
// Fidelity card settings  ->  businesses.fidelity_adhesion_json (JSON blob).
// The Adesione module id is "fidelity_membership"; the card-validity form
// (page fidelity_membership_settings) persists card_* keys inside the JSON.
// ========================================================================

type FidelityAdhesion = Record<string, unknown>;

function parseAdhesion(raw: unknown): FidelityAdhesion {
  const text = String(raw ?? "").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as FidelityAdhesion) : {};
  } catch {
    return {};
  }
}

function cardExpiryEnabled(adhesion: FidelityAdhesion): boolean {
  if (Object.prototype.hasOwnProperty.call(adhesion, "card_expiry_enabled")) {
    return enabledFlag(adhesion.card_expiry_enabled) === 1;
  }
  return normalizeValidityValue(adhesion.card_default_validity_value) > 0;
}

function renewalStoredEnabled(adhesion: FidelityAdhesion): boolean {
  if (Object.prototype.hasOwnProperty.call(adhesion, "renewal_enabled")) {
    return enabledFlag(adhesion.renewal_enabled) === 1;
  }
  return normalizeValidityValue(adhesion.renewal_window_value) > 0;
}

function durationLabel(value: number, unit: ExpiryUnit): string {
  const labels: Record<ExpiryUnit, string> = { days: "giorni", months: "mesi", years: "anni" };
  return `${value} ${labels[unit]}`;
}

export async function getFidelityMembershipSettings(slug: string): Promise<ConfigModuleState> {
  const [businessRows, cardRows] = await Promise.all([
    tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 }),
    tenantSelect<RowDataPacket>({ slug, table: "cards", orderBy: "created_at DESC, id DESC", limit: 200 }).catch(() => []),
  ]);
  const row = businessRows[0] ?? ({} as RowDataPacket);
  const enabled = Number(row.fidelity_enabled ?? 0) === 1;
  const activeCards = cardRows.filter((item) => String(item.status ?? "active") === "active").length;

  const adhesion = parseAdhesion(row.fidelity_adhesion_json);
  const expiryEnabled = cardExpiryEnabled(adhesion);
  const validityValue = normalizeValidityValue(adhesion.card_default_validity_value);
  const validityUnit = normalizeUnit(adhesion.card_default_validity_unit);
  const renewalEnabled = renewalStoredEnabled(adhesion);
  const renewalValue = normalizeValidityValue(adhesion.renewal_window_value);
  const renewalUnit = normalizeUnit(adhesion.renewal_window_unit);
  const reminderDays = normalizeValidityValue(adhesion.expiry_reminder_days);
  const restoreValue = normalizeValidityValue(adhesion.card_existing_restore_value ?? adhesion.card_default_validity_value);
  const restoreUnit = normalizeUnit(adhesion.card_existing_restore_unit ?? adhesion.card_default_validity_unit);

  return {
    id: "fidelity_membership",
    title: "Adesione",
    records: [
      record("fidelity_membership", 1, "Programma fidelity", enabled ? "Fidelity abilitata" : "Fidelity disabilitata", enabled ? "Attivo" : "Disattivo", enabled, created(row)),
      record("fidelity_membership", 2, "Regole adesione", String(row.fidelity_adhesion_json ?? ""), row.fidelity_adhesion_json ? "Configurate" : "Da configurare", enabled, created(row)),
      record("fidelity_membership", 3, "Tessere clienti", `${cardRows.length} tessere emesse`, `${activeCards} attive`, activeCards > 0, created(row)),
    ],
    settings: {
      expiryEnabled: expiryEnabled ? 1 : 0,
      validityValue: validityValue || 1,
      validityUnit,
      renewalEnabled: renewalEnabled ? 1 : 0,
      renewalValue,
      renewalUnit,
      reminderDays,
      restoreValue,
      restoreUnit,
      restoreLabel: durationLabel(restoreValue, restoreUnit),
    },
    updatedAt: dateTimeString(created(row)),
  };
}

// Durata in giorni approssimata (solo per il CLAMP finestra<durata; le date reali
// usano l'aritmetica di calendario in addDurationYmd).
function durationDaysApprox(value: number, unit: ExpiryUnit): number {
  return unit === "years" ? value * 365 : unit === "months" ? value * 30 : value;
}

// Y-m-d + durata (giorni/mesi/anni con clamp del giorno — fidelity_card_add_duration_ymd).
function addDurationYmd(baseYmd: string, value: number, unit: ExpiryUnit): string {
  const [y, m, d] = baseYmd.split("-").map((p) => Number.parseInt(p, 10));
  if (unit === "days") {
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + value);
    return dt.toISOString().slice(0, 10);
  }
  const months = unit === "years" ? value * 12 : value;
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const dim = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, "0")}-${String(nm + 1).padStart(2, "0")}-${String(Math.min(d, dim)).padStart(2, "0")}`;
}

// F5b — port completo di fidelity_membership_settings.php save_fidelity_card_validity_default:
// applyMode preserve/disable_expiry(+snapshot)/restore_from_snapshot, conferma richiesta,
// "Nessuna modifica da salvare.", clamp finestra rinnovo, messaggi legacy per modalità.
export async function saveFidelityCardValidityDefault(slug: string, input: Record<string, unknown>): Promise<ConfigModuleState & { message?: string }> {
  const id = await businessId(slug);

  const expiryEnabled = enabledFlag(input.fidelity_card_expiry_enabled);
  const validityValue = normalizeValidityValue(input.fidelity_card_default_validity_value);
  const validityUnit = normalizeUnit(input.fidelity_card_default_validity_unit);
  let renewalEnabled = enabledFlag(input.fidelity_card_renewal_enabled);
  let renewalValue = normalizeValidityValue(input.fidelity_card_renewal_window_value);
  const renewalUnit = normalizeUnit(input.fidelity_card_renewal_window_unit);
  const reminderDays = normalizeValidityValue(input.fidelity_card_expiry_reminder_days);

  if (expiryEnabled && validityValue <= 0) {
    throw new Error("Imposta una durata tessera maggiore di 0 oppure disattiva la scadenza tessera.");
  }
  // Renewal/reminder only apply while expiry is enabled.
  if (!expiryEnabled) renewalEnabled = 0;

  // Clamp legacy: la finestra di rinnovo resta INFERIORE alla durata tessera.
  let windowClamped = false;
  if (renewalEnabled && expiryEnabled && renewalValue > 0 && durationDaysApprox(renewalValue, renewalUnit) >= durationDaysApprox(validityValue, validityUnit)) {
    renewalValue = Math.max(0, durationDaysApprox(validityValue, validityUnit) - 1);
    windowClamped = true;
  }

  // Read-modify-write the JSON blob so unrelated adhesion keys are preserved.
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "fidelity_adhesion_json", where: "id = ?", params: [id], limit: 1 });
  const current = parseAdhesion(rows[0]?.fidelity_adhesion_json);
  const prevExpiryEnabled = cardExpiryEnabled(current);

  // "Nessuna modifica da salvare." (fidelity_membership_settings.php ~209).
  const unchanged =
    prevExpiryEnabled === (expiryEnabled === 1) &&
    normalizeValidityValue(current.card_default_validity_value) === validityValue &&
    normalizeUnit(current.card_default_validity_unit) === validityUnit &&
    (renewalStoredEnabled(current) ? 1 : 0) === renewalEnabled &&
    normalizeValidityValue(current.renewal_window_value) === renewalValue &&
    normalizeUnit(current.renewal_window_unit) === renewalUnit &&
    normalizeValidityValue(current.expiry_reminder_days) === reminderDays;
  if (unchanged) {
    return { ...(await getFidelityMembershipSettings(slug)), message: "Nessuna modifica da salvare." };
  }

  // Conferma legacy prima di applicare alle tessere esistenti.
  const confirmed = ["1", "true", "on", "yes"].includes(String(input.fidelity_card_apply_to_existing_confirmed ?? "").toLowerCase());
  if (!confirmed) {
    throw new Error("Conferma il salvataggio delle impostazioni tessera Fidelity prima di continuare.");
  }

  // applyMode (fidelity_membership_settings.php ~229-257): scadenza ON->OFF salva
  // lo snapshot delle scadenze correnti; OFF->ON le ripristina dallo snapshot.
  const today = new Date().toISOString().slice(0, 10);
  let applyMode: "preserve_existing" | "disable_expiry" | "restore_existing_from_snapshot" = "preserve_existing";
  if (prevExpiryEnabled && !expiryEnabled) applyMode = "disable_expiry";
  else if (!prevExpiryEnabled && expiryEnabled) applyMode = "restore_existing_from_snapshot";

  const cardRows = await tenantSelect<RowDataPacket>({ slug, table: "cards", columns: "id, client_id, issued_at, expires_at, status", orderBy: "id ASC" }).catch(() => [] as RowDataPacket[]);
  let cardsReactivated = 0;
  let cardsDeactivated = 0;

  if (applyMode === "disable_expiry") {
    // Snapshot {cardId: 'Y-m-d'} + durata di ripristino nel JSON
    // (card_existing_restore_* — fidelity_card_store_existing_restore_expiry_map).
    const snapshot: Record<string, string> = {};
    for (const card of cardRows) {
      const exp = String(card.expires_at ?? "").slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(exp)) snapshot[String(card.id)] = exp;
    }
    current.card_existing_restore_value = validityValue > 0 ? validityValue : normalizeValidityValue(current.card_default_validity_value);
    current.card_existing_restore_unit = validityValue > 0 ? validityUnit : normalizeUnit(current.card_default_validity_unit);
    current.card_existing_restore_expiry_dates = snapshot;
    for (const card of cardRows) {
      const exp = String(card.expires_at ?? "").slice(0, 10);
      const expiredByDate = /^\d{4}-\d{2}-\d{2}$/.test(exp) && exp < today;
      const values: Record<string, unknown> = { expires_at: null };
      if (String(card.status ?? "active") === "inactive" && expiredByDate) {
        values.status = "active";
        cardsReactivated += 1;
      }
      await tenantUpdate({ slug, table: "cards", id: Number(card.id), values }).catch(() => 0);
    }
  } else if (applyMode === "restore_existing_from_snapshot") {
    const snapshot = current.card_existing_restore_expiry_dates && typeof current.card_existing_restore_expiry_dates === "object"
      ? (current.card_existing_restore_expiry_dates as Record<string, string>)
      : {};
    let restoreValue = normalizeValidityValue(current.card_existing_restore_value);
    let restoreUnit = normalizeUnit(current.card_existing_restore_unit);
    if (restoreValue <= 0) { restoreValue = validityValue; restoreUnit = validityUnit; }
    for (const card of cardRows) {
      const issued = String(card.issued_at ?? "").slice(0, 10);
      const snapExp = String(snapshot[String(card.id)] ?? "");
      const restored = /^\d{4}-\d{2}-\d{2}$/.test(snapExp)
        ? snapExp
        : addDurationYmd(/^\d{4}-\d{2}-\d{2}$/.test(issued) ? issued : today, restoreValue, restoreUnit);
      const values: Record<string, unknown> = { expires_at: restored };
      if (restored < today && String(card.status ?? "active") === "active") {
        values.status = "inactive";
        cardsDeactivated += 1;
      }
      await tenantUpdate({ slug, table: "cards", id: Number(card.id), values }).catch(() => 0);
    }
  }

  current.card_expiry_enabled = expiryEnabled;
  current.card_default_validity_value = validityValue;
  current.card_default_validity_unit = validityUnit;
  current.renewal_enabled = renewalEnabled;
  current.renewal_window_value = renewalValue;
  current.renewal_window_unit = renewalUnit;
  current.expiry_reminder_days = reminderDays;

  await tenantUpdate({ slug, table: "businesses", id, values: { fidelity_adhesion_json: JSON.stringify(current) } });

  // Messaggi legacy per modalità (fidelity_membership_settings.php ~288-333).
  let message = "Impostazioni tessera Fidelity salvate.";
  if (applyMode === "disable_expiry") {
    message = "Impostazioni tessera Fidelity salvate. Tutte le tessere Fidelity già presenti sono state rese senza scadenza.";
    if (cardsReactivated > 0) message += ` ${cardsReactivated} ${cardsReactivated === 1 ? "tessera precedentemente scaduta è tornata attiva" : "tessere precedentemente scadute sono tornate attive"}.`;
    message += " Rinnovo automatico e promemoria di scadenza non sono disponibili finché non riattivi la scadenza.";
  } else if (applyMode === "restore_existing_from_snapshot") {
    message = "Impostazioni tessera Fidelity salvate. Le tessere Fidelity già presenti hanno recuperato l'ultima data di scadenza memorizzata.";
    if (cardsDeactivated > 0) message += ` ${cardsDeactivated} ${cardsDeactivated === 1 ? "tessera con scadenza ripristinata già trascorsa resta non attiva" : "tessere con scadenza ripristinata già trascorsa restano non attive"} finché non usi Riattiva tessera.`;
    message += " La durata impostata ora si applicherà alle nuove tessere e alle tessere scadute che verranno riattivate.";
  } else if (prevExpiryEnabled && expiryEnabled && cardRows.length > 0) {
    message = "Impostazioni tessera Fidelity salvate. La nuova durata si applicherà solo alle nuove tessere Fidelity e alle tessere scadute che verranno riattivate; le tessere attive già esistenti non sono state modificate.";
  }
  if (windowClamped) message += " La finestra di rinnovo è stata adeguata per restare inferiore alla durata tessera.";

  return { ...(await getFidelityMembershipSettings(slug)), message };
}
