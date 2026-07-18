import { businessTodayIso } from "@/lib/business-datetime";
import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { dbExecute, quoteIdentifier, tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";
import type { ConfigModuleState, ConfigRecord } from "@/lib/tenant-store";
import { getFidelityEnabled, recalcClientFidelityLevel, releasePendingAppointmentFidelityForClient, syncExpiredFidelityCardStatuses } from "@/lib/db-repositories";

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
  // La pagina legacy interpola il nome attività nell'ultima riga del testo
  // condizioni predefinito ("In caso di smarrimento, contatta X ...").
  const businessName = String(row.name ?? "").trim() || "La mia attività";
  return {
    id: "giftcard_settings",
    title: "Impostazioni GiftCard",
    records: [
      record("giftcard_settings", 1, "Validita predefinita", `${value} ${unit}`, "Default emissione", true, created(row)),
      record("giftcard_settings", 2, "Termini GiftCard", terms, terms.trim() ? "Configurati" : "Da configurare", true, created(row)),
      record("giftcard_settings", 3, "Voucher pubblico", "Token pubblico, importo nascosto e invio email", "Gestito da giftcard.php", true, created(row)),
    ],
    settings: { giftcard_default_validity_value: value, giftcard_default_validity_unit: unit, giftcard_terms: terms, business_name: businessName },
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
    // FILTER_VALIDATE_URL rifiuta host con caratteri fuori da RFC (es. "!"),
    // che il WHATWG URL di Node invece accetta: valida anche l'hostname.
    return Boolean(parsed.protocol && parsed.host) && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(parsed.hostname);
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

// Il body JSON della route appiattisce gli array: accetta anche pm_name /
// pm_details come stringhe JSON (["Bonifico",...]) oltre agli array nativi.
function pmArrayFromInput(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not JSON */ }
  }
  return null;
}

// Build the raw `payment_methods` text from structured pm_name[]/pm_details[] arrays.
function paymentMethodsRawFromInput(input: Record<string, unknown>): string {
  const names = pmArrayFromInput(input.pm_name);
  const details = pmArrayFromInput(input.pm_details);
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

// Etichetta legacy fidelity_card_duration_label: '0 giorni' quando <= 0,
// singolare/plurale per unità.
function durationLabel(value: number, unit: ExpiryUnit): string {
  if (value <= 0) return "0 giorni";
  if (unit === "years") return `${value} ${value === 1 ? "anno" : "anni"}`;
  if (unit === "months") return `${value} ${value === 1 ? "mese" : "mesi"}`;
  return `${value} ${value === 1 ? "giorno" : "giorni"}`;
}

// Data locale Y-m-d in ORA DI ROMA (legacy app_date_sql girava su un server
// Rome; i componenti locali qui sarebbero UTC su Amplify — classe TZ).
function localTodayYmd(): string {
  return businessTodayIso();
}

// Config effettiva del promemoria scadenza tessera per la pagina Automazione
// (fidelity_card_default_validity_config + fidelity_card_renewal_window_config
// legacy): value effettivo 0 quando l'interruttore è spento; il toggle in
// Automazione si abilita solo con durata E finestra > 0.
export async function fidelityCardExpiryReminderConfig(slug: string): Promise<{
  configOk: boolean;
  validityLabel: string;
  windowLabel: string;
}> {
  const businessRows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "fidelity_adhesion_json", orderBy: "id ASC", limit: 1 }).catch(() => [] as RowDataPacket[]);
  const adhesion = parseAdhesion(businessRows[0]?.fidelity_adhesion_json);
  const expiryEnabled = cardExpiryEnabled(adhesion);
  const validityUnit = normalizeUnit(adhesion.card_default_validity_unit);
  const validityValue = expiryEnabled ? normalizeValidityValue(adhesion.card_default_validity_value) : 0;
  const renewalEnabled = renewalStoredEnabled(adhesion);
  const clamp = clampRenewalWindow(
    normalizeValidityValue(adhesion.renewal_window_value),
    normalizeUnit(adhesion.renewal_window_unit),
    normalizeValidityValue(adhesion.card_default_validity_value),
    validityUnit,
  );
  const windowValue = renewalEnabled ? clamp.value : 0;
  return {
    configOk: validityValue > 0 && windowValue > 0,
    validityLabel: durationLabel(validityValue, validityUnit),
    windowLabel: durationLabel(windowValue, clamp.unit),
  };
}

export async function getFidelityMembershipSettings(slug: string): Promise<ConfigModuleState> {
  const businessRows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", orderBy: "id ASC", limit: 1 });
  const row = businessRows[0] ?? ({} as RowDataPacket);
  const enabled = Number(row.fidelity_enabled ?? 0) === 1;

  // Sync legacy al load della pagina (fidelity_card_sync_expired_statuses):
  // solo con Fidelity globale attiva; il gate sulla scadenza è nell'helper.
  if (enabled) await syncExpiredFidelityCardStatuses(slug).catch(() => 0);

  const cardRows = await tenantSelect<RowDataPacket>({ slug, table: "cards", orderBy: "created_at DESC, id DESC", limit: 200 }).catch(() => [] as RowDataPacket[]);
  const activeCards = cardRows.filter((item) => String(item.status ?? "active") === "active").length;

  const adhesion = parseAdhesion(row.fidelity_adhesion_json);
  const expiryEnabled = cardExpiryEnabled(adhesion);
  const validityValue = normalizeValidityValue(adhesion.card_default_validity_value);
  const validityUnit = normalizeUnit(adhesion.card_default_validity_unit);
  const renewalEnabled = renewalStoredEnabled(adhesion);
  // Display legacy: la finestra memorizzata è mostrata già clampata rispetto
  // alla durata (fidelity_card_renewal_window_config → clamp + flag warning).
  const renewalClamp = clampRenewalWindow(
    normalizeValidityValue(adhesion.renewal_window_value),
    normalizeUnit(adhesion.renewal_window_unit),
    validityValue,
    validityUnit,
  );
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
      globalEnabled: enabled ? 1 : 0,
      expiryEnabled: expiryEnabled ? 1 : 0,
      validityValue: validityValue || 1,
      validityUnit,
      renewalEnabled: renewalEnabled ? 1 : 0,
      renewalValue: renewalClamp.value,
      renewalUnit: renewalClamp.unit,
      renewalClamped: renewalClamp.clamped ? 1 : 0,
      reminderDays,
      restoreValue,
      restoreUnit,
      restoreLabel: durationLabel(restoreValue, restoreUnit),
    },
    updatedAt: dateTimeString(created(row)),
  };
}

// Confronto Y-m-d numerico, robusto con anni oltre le 4 cifre
// (fidelity_card_compare_ymd).
function compareYmd(a: string, b: string): number {
  const pa = a.split("-").map((p) => Number.parseInt(p, 10));
  const pb = b.split("-").map((p) => Number.parseInt(p, 10));
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

// Confronto tra durate sulla stessa data base (fidelity_card_duration_compare).
function cardDurationCompare(aValue: number, aUnit: ExpiryUnit, bValue: number, bUnit: ExpiryUnit): number {
  const base = "2001-01-01";
  return compareYmd(addDurationYmd(base, aValue, aUnit), addDurationYmd(base, bValue, bUnit));
}

// Durata massima strettamente inferiore al riferimento: prova la stessa unità
// richiesta e scala verso unità più fini (fidelity_card_max_strictly_smaller_duration_config).
function maxStrictlySmallerDuration(refValue: number, refUnit: ExpiryUnit, preferredUnit: ExpiryUnit): { value: number; unit: ExpiryUnit } {
  if (refValue <= 0) return { value: 0, unit: "days" };
  const base = "2001-01-01";
  const targetEnd = addDurationYmd(addDurationYmd(base, refValue, refUnit), -1, "days");
  const unitOrder: ExpiryUnit[] = preferredUnit === "years" ? ["years", "months", "days"] : preferredUnit === "months" ? ["months", "days"] : ["days"];
  for (const candUnit of unitOrder) {
    let lo = 0;
    let hi = 36500;
    let best = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (compareYmd(addDurationYmd(base, mid, candUnit), targetEnd) <= 0) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best > 0) return { value: best, unit: candUnit };
  }
  return { value: 0, unit: "days" };
}

// Clamp legacy: la finestra di rinnovo resta STRETTAMENTE inferiore alla durata
// tessera, con aritmetica di calendario (fidelity_card_clamp_renewal_window_config).
function clampRenewalWindow(value: number, unit: ExpiryUnit, validityValue: number, validityUnit: ExpiryUnit): { value: number; unit: ExpiryUnit; clamped: boolean } {
  if (value <= 0) return { value, unit, clamped: false };
  if (validityValue <= 0) return { value: 0, unit: "days", clamped: true };
  if (cardDurationCompare(value, unit, validityValue, validityUnit) >= 0) {
    return { ...maxStrictlySmallerDuration(validityValue, validityUnit, unit), clamped: true };
  }
  return { value, unit, clamped: false };
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

// Data Y-m-d da un valore DB (string/Date), null se non valida.
function dbYmd(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  const s = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// Port completo di fidelity_membership_settings.php save_fidelity_card_validity_default:
// guardia durata, clamp finestra con aritmetica di calendario, "Nessuna modifica da
// salvare." PRIMA della conferma, applyMode preserve / disable_expiry (snapshot
// scadenze) / restore_existing_from_snapshot con contatori sui flip di USABILITÀ,
// release delle agevolazioni prenotate (punti solo lockati: nessun riaccredito),
// refresh livello+credito tessere dei clienti coinvolti, pulizia reminder pending
// e messaggi legacy composti per modalità.
export async function saveFidelityCardValidityDefault(slug: string, input: Record<string, unknown>): Promise<ConfigModuleState & { message?: string }> {
  const id = await businessId(slug);

  // Il legacy ignora il POST con Fidelity globale off (early-return della pagina
  // prima del blocco POST): qui guardia esplicita — residuo deliberato.
  if (!(await getFidelityEnabled(slug))) {
    throw new Error("Attiva prima la Fidelity per gestire le tessere.");
  }

  // Il legacy esegue la sync scadute di pagina anche sulla richiesta POST,
  // prima del blocco _mode (fidelity_membership_settings.php ~126-128).
  await syncExpiredFidelityCardStatuses(slug).catch(() => 0);

  const expiryEnabled = enabledFlag(input.fidelity_card_expiry_enabled);
  const validityValue = normalizeValidityValue(input.fidelity_card_default_validity_value);
  const validityUnit = normalizeUnit(input.fidelity_card_default_validity_unit);
  const renewalEnabled = enabledFlag(input.fidelity_card_renewal_enabled);
  let renewalValue = normalizeValidityValue(input.fidelity_card_renewal_window_value);
  let renewalUnit = normalizeUnit(input.fidelity_card_renewal_window_unit);
  const reminderDays = normalizeValidityValue(input.fidelity_card_expiry_reminder_days);

  if (expiryEnabled === 1 && validityValue <= 0) {
    throw new Error("Imposta una durata tessera maggiore di 0 oppure disattiva la scadenza tessera.");
  }

  // Clamp legacy SOLO con scadenza+rinnovo attivi (fidelity_membership_settings.php ~163).
  let windowClamped = false;
  if (expiryEnabled === 1 && renewalEnabled === 1) {
    const clamp = clampRenewalWindow(renewalValue, renewalUnit, validityValue, validityUnit);
    renewalValue = clamp.value;
    renewalUnit = clamp.unit;
    windowClamped = clamp.clamped;
  }

  // Read-modify-write the JSON blob so unrelated adhesion keys are preserved.
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "businesses", columns: "fidelity_adhesion_json", where: "id = ?", params: [id], limit: 1 });
  const current = parseAdhesion(rows[0]?.fidelity_adhesion_json);

  const prevDurationValue = normalizeValidityValue(current.card_default_validity_value);
  const prevDurationUnit = normalizeUnit(current.card_default_validity_unit);
  const prevExpiryEnabled = cardExpiryEnabled(current);
  const prevRenewStoredEnabled = renewalStoredEnabled(current);
  // Il confronto legacy usa la finestra precedente CLAMPATA sulla durata precedente.
  const prevRenewClamp = clampRenewalWindow(
    normalizeValidityValue(current.renewal_window_value),
    normalizeUnit(current.renewal_window_unit),
    prevDurationValue,
    prevDurationUnit,
  );
  const prevReminderDays = normalizeValidityValue(current.expiry_reminder_days);

  const durationChanged = prevDurationValue !== validityValue || prevDurationUnit !== validityUnit;
  const renewalChanged =
    (prevRenewStoredEnabled ? 1 : 0) !== renewalEnabled ||
    prevRenewClamp.value !== renewalValue ||
    prevRenewClamp.unit !== renewalUnit ||
    prevReminderDays !== reminderDays;
  const expiryEnabledChanged = (prevExpiryEnabled ? 1 : 0) !== expiryEnabled;

  // "Nessuna modifica da salvare." (fidelity_membership_settings.php ~208) —
  // valutato PRIMA della conferma, come flash di successo.
  if (!expiryEnabledChanged && !durationChanged && !renewalChanged) {
    return { ...(await getFidelityMembershipSettings(slug)), message: "Nessuna modifica da salvare." };
  }

  // Conferma legacy prima di applicare alle tessere esistenti.
  const confirmed = ["1", "true", "on", "yes"].includes(String(input.fidelity_card_apply_to_existing_confirmed ?? "").toLowerCase());
  if (!confirmed) {
    throw new Error("Conferma il salvataggio delle impostazioni tessera Fidelity prima di continuare.");
  }

  // applyMode (fidelity_membership_settings.php ~229-256): scadenza ON->OFF salva
  // lo snapshot delle scadenze correnti; OFF->ON le ripristina dallo snapshot.
  const today = localTodayYmd();
  const applyMode: "preserve_existing" | "disable_expiry" | "restore_existing_from_snapshot" =
    prevExpiryEnabled && expiryEnabled === 0
      ? "disable_expiry"
      : !prevExpiryEnabled && expiryEnabled === 1
        ? "restore_existing_from_snapshot"
        : "preserve_existing";

  const cardRows = await tenantSelect<RowDataPacket>({ slug, table: "cards", columns: "id, client_id, issued_at, expires_at, status", orderBy: "id ASC" }).catch(() => [] as RowDataPacket[]);

  // Durata di ripristino per il messaggio/snapshot (handler legacy ~222-256).
  let restoreValue = normalizeValidityValue(current.card_existing_restore_value ?? current.card_default_validity_value);
  let restoreUnit = normalizeUnit(current.card_existing_restore_unit ?? current.card_default_validity_unit);

  // Il legacy conta anche cards_deactivated nelle stats, ma i messaggi usano
  // solo cards_reactivated e points_appointments_released.
  let cardsReactivated = 0;
  const clientsToRefresh = new Set<number>();
  const clientsExpiredNow = new Set<number>();
  type CardPlan = { cardId: number; values: Record<string, unknown> };
  const plans: CardPlan[] = [];

  if (applyMode === "disable_expiry") {
    // Durata memorizzata al momento della disattivazione: la durata postata,
    // oppure quella precedente se il form ne aveva una vuota/azzerata.
    restoreValue = validityValue > 0 ? validityValue : prevDurationValue;
    restoreUnit = validityValue > 0 ? validityUnit : prevDurationUnit;
    current.card_existing_restore_value = restoreValue;
    current.card_existing_restore_unit = restoreUnit;
    // Snapshot {cardId: 'Y-m-d'} (fidelity_card_capture_current_restore_expiry_map).
    const snapshot: Record<string, string> = {};
    for (const card of cardRows) {
      const exp = dbYmd(card.expires_at);
      if (exp) snapshot[String(card.id)] = exp;
    }
    current.card_existing_restore_expiry_dates = snapshot;

    for (const card of cardRows) {
      const exp = dbYmd(card.expires_at);
      const status = String(card.status ?? "active") || "active";
      const expiredByDate = exp !== null && exp < today;
      const newStatus = status === "inactive" && expiredByDate ? "active" : status;
      const values: Record<string, unknown> = {};
      if (exp !== null) values.expires_at = null;
      if (newStatus !== status) values.status = newStatus;
      if (Object.keys(values).length > 0) plans.push({ cardId: Number(card.id), values });

      const wasUsable = status !== "inactive" && (exp === null || exp >= today);
      const nowUsable = newStatus !== "inactive";
      if (wasUsable !== nowUsable) {
        clientsToRefresh.add(Number(card.client_id ?? 0));
        if (!wasUsable && nowUsable) cardsReactivated += 1;
      }
    }
  } else if (applyMode === "restore_existing_from_snapshot") {
    if (restoreValue <= 0) {
      restoreValue = validityValue;
      restoreUnit = validityUnit;
    }
    // Snapshot normalizzato (fidelity_card_normalize_restore_expiry_map).
    const rawSnap = current.card_existing_restore_expiry_dates;
    const snapshot: Record<string, string> = {};
    if (rawSnap && typeof rawSnap === "object" && !Array.isArray(rawSnap)) {
      for (const [key, value] of Object.entries(rawSnap as Record<string, unknown>)) {
        const cardId = Math.trunc(Number(key)) || 0;
        if (cardId <= 0) continue;
        const exp = dbYmd(value);
        if (exp) snapshot[String(cardId)] = exp;
      }
    }

    for (const card of cardRows) {
      const exp = dbYmd(card.expires_at);
      const status = String(card.status ?? "active") || "active";
      const issued = dbYmd(card.issued_at) ?? today;
      const snapExp = snapshot[String(card.id)] ?? null;
      const newExp = snapExp ?? (restoreValue > 0 ? addDurationYmd(issued, restoreValue, restoreUnit) : null);
      const willBeExpired = newExp !== null && newExp < today;
      // Una tessera resa manualmente non attiva durante il periodo senza
      // scadenza mantiene quello stato (apply legacy ~4850-4859).
      const manualInactive = status === "inactive";
      const newStatus = willBeExpired || manualInactive ? "inactive" : "active";
      const values: Record<string, unknown> = {};
      if ((exp ?? "") !== (newExp ?? "")) values.expires_at = newExp;
      if (newStatus !== status) values.status = newStatus;
      if (Object.keys(values).length > 0) plans.push({ cardId: Number(card.id), values });

      const wasUsable = status !== "inactive" && (exp === null || exp >= today);
      const nowUsable = newStatus !== "inactive" && (newExp === null || newExp >= today);
      if (wasUsable && !nowUsable) clientsExpiredNow.add(Number(card.client_id ?? 0));
      if (wasUsable !== nowUsable) {
        clientsToRefresh.add(Number(card.client_id ?? 0));
        if (!wasUsable && nowUsable) cardsReactivated += 1;
      }
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

  for (const plan of plans) {
    await tenantUpdate({ slug, table: "cards", id: plan.cardId, values: plan.values }).catch(() => 0);
  }

  // Refresh legacy per i clienti con flip di usabilità: livello Fidelity +
  // credito wallet sincronizzato sulle tessere attive (credit_wallet_sync_active_cards).
  for (const clientId of clientsToRefresh) {
    if (clientId <= 0) continue;
    await recalcClientFidelityLevel(slug, clientId).catch(() => "");
    const wallet = await tenantSelect<RowDataPacket>({ slug, table: "clients", columns: "credit_balance", where: "id = ?", params: [clientId], limit: 1 }).catch(() => [] as RowDataPacket[]);
    const credit = Math.round(Number(wallet[0]?.credit_balance ?? 0) * 100) / 100;
    const activeCards = await tenantSelect<RowDataPacket>({ slug, table: "cards", columns: "id", where: "client_id = ? AND status = 'active'", params: [clientId] }).catch(() => [] as RowDataPacket[]);
    for (const card of activeCards) {
      await tenantUpdate({ slug, table: "cards", id: Number(card.id), values: { credit } }).catch(() => 0);
    }
  }

  // Release legacy: le tessere risultate scadute tolgono le agevolazioni
  // prenotate sugli appuntamenti In sospeso/Prenotato dei loro clienti.
  // I punti erano solo lockati virtualmente — NESSUN riaccredito.
  let releasedAppointments = 0;
  for (const clientId of clientsExpiredNow) {
    if (clientId <= 0) continue;
    releasedAppointments += await releasePendingAppointmentFidelityForClient(slug, clientId).catch(() => 0);
  }

  // Pulizia reminder pending sulla vecchia configurazione (tutte le modalità).
  const remindersT = await tenantTable(slug, "card_reminders").catch(() => null);
  if (remindersT) {
    const scoped = remindersT.mode === "shared";
    await dbExecute(
      `DELETE FROM ${quoteIdentifier(remindersT.name)} WHERE ${scoped ? "tenant_id = ? AND " : ""}reminder_kind = 'expiry_window' AND status = 'pending'`,
      scoped ? [remindersT.tenantId ?? 0] : [],
    ).catch(() => undefined);
  }

  // Messaggi legacy per modalità (fidelity_membership_settings.php ~288-332).
  let message = "Impostazioni tessera Fidelity salvate.";
  if (applyMode === "disable_expiry") {
    message = "Impostazioni tessera Fidelity salvate. Tutte le tessere Fidelity già presenti sono state rese senza scadenza.";
    if (cardsReactivated > 0) {
      message += ` ${cardsReactivated} ${cardsReactivated === 1 ? "tessera precedentemente scaduta è tornata attiva." : "tessere precedentemente scadute sono tornate attive."}`;
    }
    if (restoreValue > 0) {
      message += ` Se riattiverai in futuro la scadenza automatica, le tessere già presenti recupereranno prima l'ultima data di scadenza memorizzata al momento della disattivazione; se una tessera non aveva una scadenza specifica, useremo la durata memorizzata in quel momento (${durationLabel(restoreValue, restoreUnit)}).`;
    }
    message += " Rinnovo automatico e promemoria di scadenza non sono disponibili finché non riattivi la scadenza.";
  } else if (applyMode === "restore_existing_from_snapshot") {
    message = `Impostazioni tessera Fidelity salvate. Le tessere Fidelity già presenti hanno recuperato prima l'ultima data di scadenza memorizzata quando la scadenza automatica era stata disattivata; per le tessere che non avevano una scadenza specifica è stata riusata la durata memorizzata in quel momento (${durationLabel(restoreValue, restoreUnit)}).`;
    if (cardsReactivated > 0) {
      message += ` ${cardsReactivated} ${cardsReactivated === 1 ? "tessera ancora valida è tornata attiva automaticamente." : "tessere ancora valide sono tornate attive automaticamente."}`;
    }
    message += " Le tessere la cui scadenza ripristinata è già trascorsa restano scadute / non attive finché non usi Riattiva tessera.";
    message += " La durata impostata ora si applicherà alle nuove tessere e alle tessere scadute che verranno riattivate.";
  } else {
    if (durationChanged && expiryEnabled === 1) {
      message = "Impostazioni tessera Fidelity salvate. La nuova durata si applicherà solo alle nuove tessere Fidelity e alle tessere scadute che verranno riattivate; le tessere attive già esistenti non sono state modificate.";
    }
    if (renewalChanged) {
      message += " Rinnovo automatico e promemoria di scadenza sono stati aggiornati anche per le tessere già presenti.";
    }
  }
  if (releasedAppointments > 0) {
    message += ` Alcune tessere sono risultate scadute e ${releasedAppointments} ${releasedAppointments === 1 ? "prenotazione con agevolazioni Fidelity" : "prenotazioni con agevolazioni Fidelity"} hanno perso le agevolazioni prenotate su appuntamenti in stato In sospeso / Prenotato.`;
  }
  if (windowClamped) {
    message += " La finestra di rinnovo è stata adeguata per restare inferiore alla durata tessera.";
  }

  return { ...(await getFidelityMembershipSettings(slug)), message };
}
