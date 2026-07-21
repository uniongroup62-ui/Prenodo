import type { RowDataPacket } from "@/lib/tenant-db";
import { jsonError, parseInteger, parseNumber, parseRequestBody } from "@/lib/api-utils";
import { businessNowDateTime } from "@/lib/business-datetime";
import { logActivity } from "@/lib/activity-log";
import { currentManageSession } from "@/lib/manage-auth";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { cancelDbInstallmentPlan, createDbInstallmentPlan, listDbInstallmentPlans, saveDbInstallmentAlertDays, searchDbInstallmentPlans } from "@/lib/db-repositories";
import { automationAlertDays } from "@/lib/manage-shell-context";
import { getManageLocationContext, resolveManageLocationId } from "@/lib/manage-locations";
import { can } from "@/lib/role-permissions";
import { columnExists, quoteIdentifier, tenantSelect, tenantTable, tenantUpdate } from "@/lib/tenant-db";
import type { InstallmentPlan } from "@/lib/tenant-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "installments.manage")) return jsonError("Permesso rate mancante.", 403);

  // Filters (faithful to installments_manage.php searchPlans query params): status / client_id /
  // sale_id / q / due_from / due_to. Empty/absent → the full list (searchDbInstallmentPlans with {}).
  const url = new URL(request.url);
  // Filtro "Tutte le sedi" legacy (app_all_locations_filter_enabled): scope 0 per
  // l'admin, lista delle sedi ASSEGNATE per l'utente ristretto (location_ids).
  const allLocations = ALL_LOCATIONS_TRUTHY.includes(String(url.searchParams.get("all_locations") ?? "").trim().toLowerCase());
  // #2 scope sede: la sede corrente dell'utente (0 = tutte, per admin/all-locations) — come le
  // altre route manage. Filtra la lista ai piani delle vendite di questa sede.
  const scopeLocationId = allLocations
    ? 0
    : await resolveManageLocationId({ slug: tenantSlug, raw: url.searchParams.get("location_id"), fallbackCurrent: true });
  // FAIL-CLOSED sedi revocate (classe 18/07, come list/context/report): senza
  // all_locations e senza sede risolta in un tenant CON sedi, la lista non deve
  // servire l'unione tenant-wide (sessione stantia/sede revocata).
  if (!allLocations && scopeLocationId <= 0) {
    const locationContext = await getManageLocationContext(tenantSlug);
    if (locationContext.allLocations.length > 0) {
      return Response.json({ ok: true, sourceMode: "database", plans: [], clients: [], alertDays: await automationAlertDays(tenantSlug, "installment_alert_days") });
    }
  }
  // FAIL-CLOSED anche in Tutte-le-sedi per il NON-admin con lista sedi VUOTA
  // (audit giro 3: sessione degradata — la sentinella []=admin apriva la
  // lista tenant-wide senza scope).
  if (allLocations && String(session.user.role ?? "").toLowerCase() !== "admin" && restrictedLocationIds(session.user).length === 0) {
    const locationContext = await getManageLocationContext(tenantSlug);
    if (locationContext.allLocations.length > 0) {
      return Response.json({ ok: true, sourceMode: "database", plans: [], clients: [], alertDays: await automationAlertDays(tenantSlug, "installment_alert_days") });
    }
  }
  const filters = {
    status: url.searchParams.get("status") || undefined,
    clientId: parseInteger(url.searchParams.get("client_id"), 0) || undefined,
    saleId: parseInteger(url.searchParams.get("sale_id"), 0) || undefined,
    q: url.searchParams.get("q") || undefined,
    dueFrom: url.searchParams.get("due_from") || undefined,
    dueTo: url.searchParams.get("due_to") || undefined,
    locationId: scopeLocationId,
    locationIds: allLocations ? restrictedLocationIds(session.user) : undefined,
  };

  try {
    // Full client list for the page filter combobox — faithful to the legacy page, which
    // SELECTs every client (ORDER BY full_name ASC, id ASC) for $clientFilterItems.
    const clientRows = await tenantSelect<RowDataPacket>({
      slug: tenantSlug,
      table: "clients",
      columns: "id, full_name",
      orderBy: "full_name ASC, id ASC",
    }).catch(() => [] as RowDataPacket[]);
    const clients = clientRows
      .map((row) => ({ id: Number(row.id ?? 0), label: String(row.full_name ?? "").trim() || `Cliente #${Number(row.id ?? 0)}` }))
      .filter((c) => c.id > 0);

    return Response.json({
      ok: true,
      sourceMode: "database",
      plans: await searchDbInstallmentPlans(tenantSlug, filters),
      clients,
      // The persisted due-alert window (automation_settings.installment_alert_days) — drives the
      // notifications_installments page default + the "Impostazioni avviso rate" modal.
      alertDays: await automationAlertDays(tenantSlug, "installment_alert_days"),
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore rate.");
  }
}

export async function POST(request: Request) {
  const tenantSlug = manageTenantSlugFromRequest(request);
  const session = await currentManageSession(tenantSlug);
  if (!session) return jsonError("Sessione scaduta o non valida.", 401);
  if (!can(session.user.perms, "installments.manage")) return jsonError("Permesso rate mancante.", 403);

  const body = await parseRequestBody(request);
  const action = body.action ?? body.do ?? "create";
  // Sede postata NON autorizzata: il legacy blocca l'azione con l'errore verbatim
  // (installments_manage.php 83-85) invece di degradare a scope-0.
  const postedLocationId = parseInteger(body.location_id, 0);
  const allLocations = ALL_LOCATIONS_TRUTHY.includes(String(body.all_locations ?? "").trim().toLowerCase());
  // #2 scope sede per le mutazioni: mark_paid/mark_pending su una rata di un'altra sede
  // falliscono con "Rata non trovata" (come il legacy locationScopeSql). Col filtro
  // "Tutte le sedi" lo scope diventa la lista delle sedi assegnate (0 = admin).
  const scopeLocationId = allLocations
    ? 0
    : await resolveManageLocationId({ slug: tenantSlug, raw: body.location_id, fallbackCurrent: true });
  if (!allLocations && postedLocationId > 0 && scopeLocationId !== postedLocationId) {
    return jsonError("Sede non autorizzata per questa operazione.");
  }
  // FAIL-CLOSED sedi revocate (classe 18/07): senza all_locations e senza sede
  // risolta in un tenant CON sedi, nessuna mutazione senza scope (una sessione
  // stantia/revocata poteva incassare rate di qualunque sede).
  if (!allLocations && scopeLocationId <= 0) {
    const locationContext = await getManageLocationContext(tenantSlug);
    if (locationContext.allLocations.length > 0) {
      return jsonError("Sede non autorizzata per questa operazione.");
    }
  }
  const scopeLocationIds = allLocations ? restrictedLocationIds(session.user) : undefined;
  // FAIL-CLOSED anche in modalità Tutte-le-sedi (audit giro 3, come costs):
  // la sentinella []=admin confondeva l'admin con un NON-admin dalla lista
  // sedi vuota (sessione degradata al login) — che con all_locations poteva
  // listare e incassare rate di QUALUNQUE sede senza scope.
  if (allLocations && scopeLocationIds !== undefined && scopeLocationIds.length === 0 && String(session.user.role ?? "").toLowerCase() !== "admin") {
    const locationContext = await getManageLocationContext(tenantSlug);
    if (locationContext.allLocations.length > 0) {
      return jsonError("Sede non autorizzata per questa operazione.");
    }
  }

  try {
    if (action === "create") {
      const plan = await createDbInstallmentPlan({
        saleId: parseInteger(body.sale_id, 0),
        clientId: parseInteger(body.client_id, 0),
        clientName: body.client_name,
        total: parseNumber(body.total, 0),
        count: parseInteger(body.count, 3),
      }, tenantSlug, scopeLocationId);
      return Response.json({ ok: true, source: "installments?action=create", sourceMode: "database", plan, plans: await listDbInstallmentPlans(tenantSlug) });
    }

    if (action === "pay" || action === "mark_paid") {
      const plan = await markInstallmentPaid(tenantSlug, {
        installmentId: parseInteger(body.installment_id ?? body.id),
        paidAmount: body.paid_amount,
        paidAt: body.paid_at,
        paymentType: body.payment_type,
        note: body.note,
        userId: session.user.id,
        locationId: scopeLocationId,
        locationIds: scopeLocationIds,
      });
      void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "rate", action: "paga", entityType: "installment", entityId: parseInteger(body.installment_id ?? body.id), label: `Rata #${parseInteger(body.installment_id ?? body.id)} segnata pagata` });
      return Response.json({ ok: true, source: "installments?action=pay", sourceMode: "database", plan, plans: await listDbInstallmentPlans(tenantSlug) });
    }

    if (action === "pending" || action === "reopen" || action === "mark_pending") {
      const plan = await markInstallmentPending(tenantSlug, parseInteger(body.installment_id ?? body.id), session.user.id, scopeLocationId, scopeLocationIds);
      void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "rate", action: "modifica", entityType: "installment", entityId: parseInteger(body.installment_id ?? body.id), label: `Rata #${parseInteger(body.installment_id ?? body.id)} riaperta (non pagata)` });
      return Response.json({ ok: true, source: "installments?action=mark_pending", sourceMode: "database", plan, plans: await listDbInstallmentPlans(tenantSlug) });
    }

    // CANCEL the whole plan (faithful to SaleInstallments::cancelPlanBySaleId): blocks on already-paid
    // installments unless allow_paid is set. Requires plan_id.
    if (action === "cancel" || action === "cancel_plan") {
      const plan = await cancelDbInstallmentPlan(
        tenantSlug,
        parseInteger(body.plan_id ?? body.id, 0),
        body.reason ?? "",
        session.user.id,
        ["1", "true", "yes"].includes(String(body.allow_paid ?? "").toLowerCase()),
        scopeLocationId,
      );
      void logActivity(tenantSlug, { user: session.user, locationId: session.user.currentLocationId, module: "rate", action: "annulla", entityType: "installment_plan", entityId: parseInteger(body.plan_id ?? body.id, 0), label: `Annullato piano rateale #${parseInteger(body.plan_id ?? body.id, 0)}` });
      return Response.json({ ok: true, source: "installments?action=cancel", sourceMode: "database", plan, plans: await listDbInstallmentPlans(tenantSlug) });
    }

    // Persist the due-alert window (faithful to the "Impostazioni avviso rate" modal → save_settings).
    if (action === "save_alert_days" || action === "save_settings") {
      const alertDays = await saveDbInstallmentAlertDays(tenantSlug, parseInteger(body.alert_days ?? body.installment_alert_days ?? body.days, 7));
      return Response.json({ ok: true, source: "installments?action=save_alert_days", sourceMode: "database", alertDays });
    }

    return jsonError("Azione rate non supportata.");
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "Errore rate.");
  }
}

async function markInstallmentPaid(
  slug: string,
  options: { installmentId: number; paidAmount?: string; paidAt?: string; paymentType?: string; note?: string; userId: number; locationId?: number; locationIds?: number[] },
): Promise<InstallmentPlan> {
  const row = await installmentRow(slug, options.installmentId, options.locationId ?? 0, options.locationIds);
  // NB parità legacy: NESSUNA guardia "già pagata" — markInstallmentPaid ri-esegue
  // l'UPDATE anche su una rata paid (aggiorna paid_at/tipo, idempotente).
  // Rata o piano annullati non incassabili (SaleInstallments::markInstallmentPaid ~554-557).
  if (String(row.status ?? "") === "cancelled" || (await planStatus(slug, Number(row.plan_id ?? 0))) === "cancelled") {
    throw new Error("Non puoi incassare una rata annullata.");
  }

  // Validazioni legacy (SaleInstallments.php ~558-578): l'importo incassato DEVE
  // corrispondere all'importo della rata (tolleranza 0.005; vuoto o 0 = importo pieno),
  // la data deve essere valida, il tipo pagamento nel set canonico cash/card/check/bank
  // (dal POST, fallback rata -> piano).
  const amount = Math.round((Number(row.amount ?? 0) || 0) * 100) / 100;
  const paidRaw = String(options.paidAmount ?? "").trim();
  let paidAmount = amount;
  if (paidRaw !== "") {
    const parsed = parseMoneyValueLegacy(paidRaw);
    if (parsed === null) throw new Error("L'importo incassato non e valido.");
    paidAmount = Math.round(Math.max(0, parsed) * 100) / 100;
    if (paidAmount <= 0.00001) paidAmount = amount;
  }
  if (Math.abs(paidAmount - amount) > 0.005) {
    throw new Error("L'importo incassato deve corrispondere all'importo della rata.");
  }

  const paidAt = parsePaidAt(options.paidAt);
  if (paidAt === null) throw new Error("La data di incasso non e valida.");

  const paymentType = normalizeInstallmentPaymentType(
    clean(options.paymentType, 20) || String(row.payment_type ?? "") || (await planPaymentType(slug, Number(row.plan_id ?? 0))),
  );
  if (!paymentType) throw new Error("Seleziona un tipo di pagamento valido.");

  await tenantUpdate({
    slug,
    table: "sale_installments",
    id: options.installmentId,
    values: {
      status: "paid",
      paid_at: paidAt,
      paid_amount: paidAmount,
      payment_type: paymentType,
      // Legacy: la pagina posta sempre note (vuota) e la lib scrive NULL quando è vuota —
      // il valore precedente viene sovrascritto, non conservato.
      note: clean(options.note, 1000) || null,
      updated_by: options.userId,
    },
  });

  const planId = Number(row.plan_id ?? 0);
  // Minore: il legacy passa $userId a syncPlanStatus anche su incasso -> aggiorna plan.updated_by.
  await refreshInstallmentPlanStatus(slug, planId, options.userId);
  return installmentPlan(slug, planId);
}

async function markInstallmentPending(slug: string, installmentId: number, userId: number, locationId = 0, locationIds?: number[]): Promise<InstallmentPlan> {
  const row = await installmentRow(slug, installmentId, locationId, locationIds);
  // Guard legacy markInstallmentPending: rata o piano annullati non riapribili.
  if (String(row.status ?? "") === "cancelled" || (await planStatus(slug, Number(row.plan_id ?? 0))) === "cancelled") {
    throw new Error("Non puoi riaprire una rata annullata.");
  }
  await tenantUpdate({
    slug,
    table: "sale_installments",
    id: installmentId,
    values: {
      status: "pending",
      paid_at: null,
      paid_amount: null,
      updated_by: userId,
    },
  });

  const planId = Number(row.plan_id ?? 0);
  // Recompute the plan status from ALL installments (not a blind 'active'): reopening the last
  // paid installment of an otherwise-complete plan flips it back to active, but reopening one of
  // many keeps the correct state. Faithful to SaleInstallments::syncPlanStatus.
  await refreshInstallmentPlanStatus(slug, planId, userId);
  return installmentPlan(slug, planId);
}

async function installmentRow(slug: string, installmentId: number, locationId = 0, locationIds?: number[]): Promise<RowDataPacket> {
  // Il legacy ritorna null dalla lib (id non valido O rata inesistente) e la pagina
  // presenta lo stesso messaggio per entrambi i casi.
  if (installmentId <= 0) throw new Error("Rata non trovata o non aggiornata.");
  // #2 SCOPE SEDE (port di locationScopeSql usato in markInstallmentPaid/Pending): la rata deve
  // appartenere a una vendita della sede corrente (o NULL). Se locationId>0 e la vendita e' di
  // un'altra sede, la row e' assente -> stesso messaggio del legacy ("Rata non trovata").
  // Col filtro "Tutte le sedi" l'utente RISTRETTO resta vincolato alla lista delle
  // sue sedi (legacy location_ids, senza NULL).
  let where = "id = ?";
  const params: unknown[] = [installmentId];
  const listIds = (locationIds ?? []).map((n) => Math.trunc(Number(n)) || 0).filter((n) => n > 0);
  if (locationId > 0) {
    const salesT = await tenantTable(slug, "sales");
    const salesScoped = salesT.mode === "shared" && (await columnExists(salesT.name, "tenant_id"));
    const salesTenant = salesScoped ? "tenant_id = ? AND " : "";
    where += ` AND sale_id IN (SELECT id FROM ${quoteIdentifier(salesT.name)} WHERE ${salesTenant}(location_id = ? OR location_id IS NULL))`;
    if (salesScoped) params.push(salesT.tenantId ?? 0);
    params.push(locationId);
  } else if (listIds.length > 0) {
    const salesT = await tenantTable(slug, "sales");
    const salesScoped = salesT.mode === "shared" && (await columnExists(salesT.name, "tenant_id"));
    const salesTenant = salesScoped ? "tenant_id = ? AND " : "";
    where += ` AND sale_id IN (SELECT id FROM ${quoteIdentifier(salesT.name)} WHERE ${salesTenant}location_id IN (${listIds.map(() => "?").join(",")}))`;
    if (salesScoped) params.push(salesT.tenantId ?? 0);
    params.push(...listIds);
  }
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "sale_installments", where, params, limit: 1 });
  if (!rows[0]) throw new Error("Rata non trovata o non aggiornata.");
  return rows[0];
}

// Set truthy del filtro "Tutte le sedi" (app_all_locations_filter_enabled).
const ALL_LOCATIONS_TRUTHY = ["1", "true", "on", "yes", "all"];

// Sedi assegnate dell'utente per lo scope "Tutte le sedi": lista vuota per
// l'admin (= nessuno scope, vede tutto come il legacy allowed=tutte+NULL).
function restrictedLocationIds(user: { role?: string; locationIds?: number[] }): number[] {
  if (String(user.role ?? "").toLowerCase() === "admin") return [];
  return (user.locationIds ?? []).map((n) => Math.trunc(Number(n)) || 0).filter((n) => n > 0);
}

// Port ESATTO di SaleInstallments::parseMoneyValue (199-210): strip nbsp/spazi/€,
// con virgola E punto insieme i punti sono migliaia, poi virgola -> punto e
// REGEX di validazione (niente parseFloat permissivo: '20abc' è invalido).
function parseMoneyValueLegacy(value: string): number | null {
  let raw = String(value ?? "").trim();
  if (raw === "") return null;
  raw = raw.replace(/[  €]/g, "");
  if (raw.includes(",") && raw.includes(".")) raw = raw.replace(/\./g, "");
  raw = raw.replace(",", ".");
  if (!/^-?\d+(?:\.\d{1,6})?$/.test(raw)) return null;
  return Math.round(Number.parseFloat(raw) * 100) / 100;
}

async function refreshInstallmentPlanStatus(slug: string, planId: number, userId?: number): Promise<void> {
  if (planId <= 0) return;
  // Never re-open a cancelled plan (faithful to syncPlanStatus: a cancelled plan is terminal).
  const planRows = await tenantSelect<RowDataPacket>({ slug, table: "sale_installment_plans", columns: "status", where: "id = ?", params: [planId], limit: 1 });
  if (String(planRows[0]?.status ?? "").toLowerCase() === "cancelled") return;
  const open = await tenantSelect<RowDataPacket>({
    slug,
    table: "sale_installments",
    columns: "id",
    where: "plan_id = ? AND status NOT IN ('paid','cancelled','canceled')",
    params: [planId],
    limit: 1,
  });
  await tenantUpdate({
    slug,
    table: "sale_installment_plans",
    id: planId,
    values: { status: open[0] ? "active" : "completed", ...(userId ? { updated_by: userId } : {}) },
  });
}

async function installmentPlan(slug: string, planId: number): Promise<InstallmentPlan> {
  const plan = (await listDbInstallmentPlans(slug)).find((item) => item.id === planId);
  if (!plan) throw new Error("Piano rateale non trovato.");
  return plan;
}

// null = data non valida (il chiamante risponde con l'errore legacy). Port di
// normalizeDateTime (SaleInstallments.php 228-243): checkdate + range ESPLICITI —
// Date.parse V8 accetta '2026-02-30T10:00' (rollover locale) e l'errore
// esploderebbe dal DB invece che col messaggio legacy.
function parsePaidAt(value: string | undefined): Date | string | null {
  const raw = clean(value, 40);
  // Default "adesso" in ORA DI ROMA esplicita (classe TZ server-safe: un Date
  // al driver scrive il wall del SERVER — UTC su Amplify — e paid_at guida
  // l'Incasso dei Report, come sale_date).
  if (!raw) return businessNowDateTime();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  if (h > 23 || mi > 59 || s > 59) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${m[1]}-${m[2]}-${m[3]} ${pad(h)}:${pad(mi)}:${pad(s)}`;
}

// normalizePaymentType legacy (SaleInstallments.php ~245-269): set canonico
// cash/card/check/bank con gli alias italiani; fuori dal set -> null.
function normalizeInstallmentPaymentType(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (["cash", "contanti", "contante"].includes(v)) return "cash";
  if (["card", "carta", "credit_card", "carta_credito", "carta di credito", "carta-di-credito"].includes(v)) return "card";
  if (["check", "assegno"].includes(v)) return "check";
  if (["bank", "bank_transfer", "bank transfer", "bonifico", "bonifico bancario", "wire", "transfer"].includes(v)) return "bank";
  return null;
}

async function planStatus(slug: string, planId: number): Promise<string> {
  if (planId <= 0) return "";
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "sale_installment_plans", columns: "status", where: "id = ?", params: [planId], limit: 1 }).catch(() => []);
  return String(rows[0]?.status ?? "").toLowerCase();
}

async function planPaymentType(slug: string, planId: number): Promise<string> {
  if (planId <= 0) return "";
  const rows = await tenantSelect<RowDataPacket>({ slug, table: "sale_installment_plans", columns: "payment_type", where: "id = ?", params: [planId], limit: 1 }).catch(() => []);
  return String(rows[0]?.payment_type ?? "");
}

function clean(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}
