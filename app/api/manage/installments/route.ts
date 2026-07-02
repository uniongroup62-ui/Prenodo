import type { RowDataPacket } from "@/lib/tenant-db";
import { jsonError, parseInteger, parseNumber, parseRequestBody } from "@/lib/api-utils";
import { currentManageSession } from "@/lib/manage-auth";
import { manageTenantSlugFromRequest } from "@/lib/manage-request";
import { cancelDbInstallmentPlan, createDbInstallmentPlan, listDbInstallmentPlans, saveDbInstallmentAlertDays, searchDbInstallmentPlans } from "@/lib/db-repositories";
import { automationAlertDays } from "@/lib/manage-shell-context";
import { can } from "@/lib/role-permissions";
import { tenantSelect, tenantUpdate } from "@/lib/tenant-db";
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
  const filters = {
    status: url.searchParams.get("status") || undefined,
    clientId: parseInteger(url.searchParams.get("client_id"), 0) || undefined,
    saleId: parseInteger(url.searchParams.get("sale_id"), 0) || undefined,
    q: url.searchParams.get("q") || undefined,
    dueFrom: url.searchParams.get("due_from") || undefined,
    dueTo: url.searchParams.get("due_to") || undefined,
  };

  try {
    return Response.json({
      ok: true,
      sourceMode: "database",
      plans: await searchDbInstallmentPlans(tenantSlug, filters),
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

  try {
    if (action === "create") {
      const plan = await createDbInstallmentPlan({
        saleId: parseInteger(body.sale_id, 0),
        clientId: parseInteger(body.client_id, 0),
        clientName: body.client_name,
        total: parseNumber(body.total, 0),
        count: parseInteger(body.count, 3),
      }, tenantSlug);
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
      });
      return Response.json({ ok: true, source: "installments?action=pay", sourceMode: "database", plan, plans: await listDbInstallmentPlans(tenantSlug) });
    }

    if (action === "pending" || action === "reopen" || action === "mark_pending") {
      const plan = await markInstallmentPending(tenantSlug, parseInteger(body.installment_id ?? body.id), session.user.id);
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
      );
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
  options: { installmentId: number; paidAmount?: string; paidAt?: string; paymentType?: string; note?: string; userId: number },
): Promise<InstallmentPlan> {
  const row = await installmentRow(slug, options.installmentId);
  if (String(row.status ?? "") === "paid") throw new Error("Rata gia pagata.");
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
    // parseMoneyValue legacy: "1.234,56" (virgola decimale, punti migliaia) o "1234.56".
    const normalized = paidRaw.includes(",") ? paidRaw.replace(/\./g, "").replace(",", ".") : paidRaw;
    const parsed = Number.parseFloat(normalized);
    if (!Number.isFinite(parsed)) throw new Error("L'importo incassato non e valido.");
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
      note: clean(options.note, 1000) || undefined,
      updated_by: options.userId,
    },
  });

  const planId = Number(row.plan_id ?? 0);
  await refreshInstallmentPlanStatus(slug, planId);
  return installmentPlan(slug, planId);
}

async function markInstallmentPending(slug: string, installmentId: number, userId: number): Promise<InstallmentPlan> {
  const row = await installmentRow(slug, installmentId);
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

async function installmentRow(slug: string, installmentId: number): Promise<RowDataPacket> {
  if (installmentId <= 0) throw new Error("Rata non valida.");
  const rows = await tenantSelect<RowDataPacket>({
    slug,
    table: "sale_installments",
    where: "id = ?",
    params: [installmentId],
    limit: 1,
  });
  if (!rows[0]) throw new Error("Rata non trovata.");
  return rows[0];
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

// null = data non valida (il chiamante risponde con l'errore legacy).
function parsePaidAt(value: string | undefined): Date | string | null {
  const raw = clean(value, 40);
  if (!raw) return new Date();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return Number.isNaN(Date.parse(raw)) ? null : `${raw} 00:00:00`;
  }
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(raw)) {
    return Number.isNaN(Date.parse(raw.replace(" ", "T"))) ? null : raw.replace("T", " ");
  }
  return null;
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
