import "server-only";

import type { RowDataPacket } from "@/lib/tenant-db";
import { dbQuery, quoteIdentifier, tableExists, tenantTable } from "@/lib/tenant-db";

// Port DB-backed di app/pages/reports.php (Report / Analisi). Punti chiave di
// parita' col legacy:
// - "Incasso" NON e' SUM(sales.total): e' il modello a EVENTI DI INCASSO
//   (reports.php fetchCollectionEvents 585-765) = vendite senza piano rate
//   (per sale_date) + acconti dei piani (per sale_date) + rate PAGATE (per
//   paid_at), con ripartizione per metodo di pagamento (colonna payment_method
//   o regex "Tipo pagamento: X" nelle note).
// - Vendite/Venduto/Lordo/sconti vengono dal riepilogo vendite (771-796).
// - Prenotazioni: bucket pending/scheduled/done/canceled/no_show con i set di
//   stati legacy (914-918) + trend delle attive.
// - Archivio clienti: genere, eta' media (>=1900-01-01, <= oggi), fasce eta'.
// - Costi (due_date BETWEEN, inclusivo) e Commissioni (movement_datetime,
//   entry_status <> cancelled) sono perm-gated dal chiamante.
// - Operatori: vendite per operator_name + ore lavorate dai segmenti degli
//   appuntamenti eseguiti (1080-1144), fusi per nome normalizzato.
// Tutte le query sono tenant-scoped; finestra a limite superiore ESCLUSIVO
// [from 00:00, to+1g 00:00) come il legacy (108-114), tranne i costi
// (BETWEEN inclusivo su due_date, 1211-1266).

const CANCELLED_SALE_STATES = ["cancelled", "canceled", "annullata", "annullato"];
const ACTIVE_APPT_EXCLUDED = ["canceled", "cancelled", "no_show", "no show", "no-show", "noshow", "non presentato", "rejected", "annullato", "annullata", "rifiutato", "rifiutata"];
const APPT_PENDING = ["pending", "in attesa"];
const APPT_SCHEDULED = ["scheduled", "confirmed", "prenotato", "prenotata"];
const APPT_DONE = ["done", "executed", "completed", "eseguito", "eseguita", "completato", "completata"];
const APPT_CANCELED = ["canceled", "cancelled", "rejected", "annullato", "annullata", "rifiutato", "rifiutata"];
const APPT_NO_SHOW = ["no_show", "no show", "no-show", "noshow", "non presentato", "non presentata"];

// Ordine legacy dei metodi di pagamento (reports.php:750).
const PAYMENT_ORDER = ["Contanti", "Carte", "Assegno", "Bonifico", "Non indicato"];

export type ReportRow = { name: string; type?: string; revenue: number; qty?: number; saleCount?: number };
export type ManageReports = {
  from: string;
  to: string;
  summary: {
    // Incasso reale (eventi di incasso) + numero movimenti.
    totalRevenue: number;
    collectionMovements: number;
    soldRevenue: number;
    grossRevenue: number;
    discountTotal: number;
    saleCount: number;
    servedClients: number;
    averageTicket: number;
    appointmentCount: number;
  };
  appointments: {
    total: number;
    active: number;
    pending: number;
    scheduled: number;
    done: number;
    canceled: number;
    noShow: number;
    activeClients: number;
    trend: { day: string; count: number }[];
  };
  paymentMethods: { label: string; amount: number; count: number; sharePct: number }[];
  clientsArchive: {
    total: number;
    male: number;
    female: number;
    unknownGender: number;
    prevalence: string;
    prevalenceSub: string;
    birthKnown: number;
    birthUnknown: number;
    avgAge: number | null;
    ageBuckets: { label: string; count: number }[];
  };
  costs: { total: number; paid: number; open: number } | null;
  commissions: { count: number; total: number; paid: number; open: number } | null;
  composition: { label: string; revenue: number }[];
  comparison: {
    from: string;
    to: string;
    totalRevenue: number;
    soldRevenue: number;
    saleCount: number;
    servedClients: number;
    averageTicket: number;
    appointmentCount: number;
    deltaPct: number;
  } | null;
  daily: { day: string; revenue: number; saleCount: number }[];
  topClients: { clientId: number; name: string; revenue: number; saleCount: number }[];
  topServices: ReportRow[];
  topProducts: ReportRow[];
  topItems: ReportRow[];
  operators: { name: string; revenue: number; saleCount: number; avgTicket: number; hoursWorked: number; apptCount: number }[];
};

function money(v: unknown): number {
  return Math.round((Number(v ?? 0) + Number.EPSILON) * 100) / 100;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysYmd(iso: string, days: number): string {
  return ymd(new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000));
}

function dayOf(raw: unknown): string {
  if (raw instanceof Date) return ymd(raw);
  return String(raw ?? "").slice(0, 10);
}

// Metodo di pagamento legacy (reports.php paymentMethodFromSale ~524): colonna
// payment_method se esiste, altrimenti regex "Tipo pagamento: X" nelle note.
function paymentLabelFromNotes(notes: unknown, paymentMethod: unknown): string {
  let raw = String(paymentMethod ?? "").trim();
  if (!raw) {
    const m = /Tipo pagamento\s*:\s*([^\r\n]+)/i.exec(String(notes ?? ""));
    raw = m ? m[1].trim() : "";
  }
  const low = raw.toLowerCase();
  if (!low) return "Non indicato";
  if (low.includes("contant")) return "Contanti";
  if (low.includes("cart") || low.includes("pos")) return "Carte";
  if (low.includes("assegno")) return "Assegno";
  if (low.includes("bonific")) return "Bonifico";
  return "Non indicato";
}

type CollectionTotals = {
  totalRevenue: number;
  movements: number;
  byDay: Map<string, { revenue: number; movements: number }>;
  byMethod: Map<string, { amount: number; count: number }>;
};

export async function getManageReports(
  slug: string,
  fromRaw: string,
  toRaw: string,
  locationId = 0,
  compare = false,
  options: { includeCosts?: boolean; includeCommissions?: boolean; compareFrom?: string; compareTo?: string } = {},
): Promise<ManageReports> {
  const today = new Date();
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const from = /^\d{4}-\d{2}-\d{2}$/.test(fromRaw) ? fromRaw : ymd(monthStart);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(toRaw) ? toRaw : ymd(today);
  const toExclusive = addDaysYmd(to, 1);

  const sales = await tenantTable(slug, "sales");
  const tid = sales.tenantId ?? 0;
  const locClause = locationId > 0 ? " AND s.location_id = ?" : "";
  const locParams: unknown[] = locationId > 0 ? [locationId] : [];
  const cph = CANCELLED_SALE_STATES.map(() => "?").join(",");
  const scopeSql = `s.tenant_id = ? AND LOWER(TRIM(COALESCE(s.status,''))) NOT IN (${cph})${locClause}`;
  const scopeParams = [tid, ...CANCELLED_SALE_STATES, ...locParams];
  const baseWhere = `${scopeSql} AND s.sale_date >= ? AND s.sale_date < ?`;
  const baseParams = [...scopeParams, from, toExclusive];

  const hasPlans = await tableExists("sale_installment_plans");
  const hasInstallments = await tableExists("sale_installments");

  // --- Eventi di incasso (fetchCollectionEvents) -------------------------
  const collect = async (winFrom: string, winToExclusive: string): Promise<CollectionTotals> => {
    const totals: CollectionTotals = { totalRevenue: 0, movements: 0, byDay: new Map(), byMethod: new Map() };
    const push = (day: string, amountRaw: unknown, label: string) => {
      const amount = money(Math.max(0, Number(amountRaw ?? 0)));
      if (amount <= 0.00001) return;
      totals.totalRevenue = money(totals.totalRevenue + amount);
      totals.movements += 1;
      const d = totals.byDay.get(day) ?? { revenue: 0, movements: 0 };
      d.revenue = money(d.revenue + amount);
      d.movements += 1;
      totals.byDay.set(day, d);
      const m = totals.byMethod.get(label) ?? { amount: 0, count: 0 };
      m.amount = money(m.amount + amount);
      m.count += 1;
      totals.byMethod.set(label, m);
    };
    const winWhere = `${scopeSql} AND s.sale_date >= ? AND s.sale_date < ?`;
    const winParams = [...scopeParams, winFrom, winToExclusive];

    // 1) Vendite senza piano rate: incasso immediato per sale_date.
    const noPlan = hasPlans
      ? ` AND NOT EXISTS (SELECT 1 FROM ${quoteIdentifier((await tenantTable(slug, "sale_installment_plans")).name)} p WHERE p.sale_id = s.id AND p.tenant_id = s.tenant_id)`
      : "";
    const instant = await dbQuery<RowDataPacket[]>(
      `SELECT s.sale_date::date d, s.total amt, s.notes FROM ${quoteIdentifier(sales.name)} s WHERE ${winWhere} AND COALESCE(s.total,0) > 0${noPlan}`,
      winParams,
    ).catch(() => [] as RowDataPacket[]);
    for (const row of instant) push(dayOf(row.d), row.amt, paymentLabelFromNotes(row.notes, row.payment_method));

    if (hasPlans) {
      // 2) Acconti dei piani rate (per sale_date della vendita).
      const plansTable = await tenantTable(slug, "sale_installment_plans");
      const downs = await dbQuery<RowDataPacket[]>(
        `SELECT s.sale_date::date d, p.down_payment_amount amt, s.notes
           FROM ${quoteIdentifier(plansTable.name)} p
           JOIN ${quoteIdentifier(sales.name)} s ON s.id = p.sale_id AND s.tenant_id = p.tenant_id
          WHERE ${winWhere} AND COALESCE(p.down_payment_amount,0) > 0`,
        winParams,
      ).catch(() => [] as RowDataPacket[]);
      for (const row of downs) push(dayOf(row.d), row.amt, paymentLabelFromNotes(row.notes, row.payment_method));
    }

    if (hasInstallments) {
      // 3) Rate PAGATE nel periodo (per paid_at, cash-basis).
      const instTable = await tenantTable(slug, "sale_installments");
      const paid = await dbQuery<RowDataPacket[]>(
        `SELECT i.paid_at::date d, COALESCE(NULLIF(i.paid_amount,0), i.amount, 0) amt, s.notes
           FROM ${quoteIdentifier(instTable.name)} i
           JOIN ${quoteIdentifier(sales.name)} s ON s.id = i.sale_id AND s.tenant_id = i.tenant_id
          WHERE ${scopeSql} AND i.paid_at >= ? AND i.paid_at < ? AND LOWER(TRIM(COALESCE(i.status,''))) = 'paid'`,
        [...scopeParams, winFrom, winToExclusive],
      ).catch(() => [] as RowDataPacket[]);
      for (const row of paid) push(dayOf(row.d), row.amt, paymentLabelFromNotes(row.notes, row.payment_method));
    }
    return totals;
  };

  // --- Riepilogo vendite (reports.php 771-796) ---------------------------
  const salesSummary = async (winFrom: string, winToExclusive: string) => {
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT COUNT(*) cnt, COALESCE(SUM(s.total),0) sold, COALESCE(SUM(s.subtotal),0) gross,
              COALESCE(SUM(s.discount),0) discount_total, COALESCE(SUM(s.fidelity_discount),0) fidelity_discount,
              COALESCE(AVG(s.total),0) avg_ticket,
              COUNT(DISTINCT CASE WHEN COALESCE(s.client_id,0) > 0 THEN s.client_id END) served
         FROM ${quoteIdentifier(sales.name)} s WHERE ${scopeSql} AND s.sale_date >= ? AND s.sale_date < ?`,
      [...scopeParams, winFrom, winToExclusive],
    ).catch(() => [] as RowDataPacket[]);
    const r = rows[0] ?? {};
    return {
      cnt: Number(r.cnt ?? 0),
      sold: money(r.sold),
      gross: money(r.gross),
      discountTotal: money(Number(r.discount_total ?? 0) + Number(r.fidelity_discount ?? 0)),
      avgTicket: money(r.avg_ticket),
      served: Number(r.served ?? 0),
    };
  };

  // --- Prenotazioni: filtro sede (diretto + bridge, come reports.php 392-430)
  const appt = await tenantTable(slug, "appointments");
  const hasApptBridge = await tableExists("appointment_locations");
  let apptLocClause = "";
  const apptLocParams: unknown[] = [];
  if (locationId > 0) {
    if (hasApptBridge) {
      const bridge = await tenantTable(slug, "appointment_locations");
      apptLocClause = ` AND (a.location_id = ? OR (a.location_id IS NULL AND (EXISTS (SELECT 1 FROM ${quoteIdentifier(bridge.name)} al WHERE al.appointment_id = a.id AND al.location_id = ? AND al.tenant_id = a.tenant_id) OR NOT EXISTS (SELECT 1 FROM ${quoteIdentifier(bridge.name)} al2 WHERE al2.appointment_id = a.id AND al2.tenant_id = a.tenant_id))))`;
      apptLocParams.push(locationId, locationId);
    } else {
      apptLocClause = " AND (a.location_id = ? OR a.location_id IS NULL)";
      apptLocParams.push(locationId);
    }
  }
  const bucket = (states: string[]) => `SUM(CASE WHEN LOWER(TRIM(COALESCE(a.status,''))) IN (${states.map((s) => `'${s}'`).join(",")}) THEN 1 ELSE 0 END)`;
  const activeCond = `LOWER(TRIM(COALESCE(a.status,''))) NOT IN (${ACTIVE_APPT_EXCLUDED.map((s) => `'${s}'`).join(",")})`;
  const apptCount = async (winFrom: string, winToExclusive: string): Promise<number> => {
    const rows = await dbQuery<RowDataPacket[]>(
      `SELECT COUNT(*) cnt FROM ${quoteIdentifier(appt.name)} a WHERE a.tenant_id = ? AND a.starts_at >= ? AND a.starts_at < ? AND ${activeCond}${apptLocClause}`,
      [appt.tenantId ?? 0, winFrom, winToExclusive, ...apptLocParams],
    ).catch(() => [] as RowDataPacket[]);
    return Number(rows[0]?.cnt ?? 0);
  };

  const [collections, summaryRow, appointmentCount] = await Promise.all([
    collect(from, toExclusive),
    salesSummary(from, toExclusive),
    apptCount(from, toExclusive),
  ]);

  // Bucket prenotazioni (reports.php 928-951, su TUTTI gli appuntamenti in range).
  const apptSummaryRows = await dbQuery<RowDataPacket[]>(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN ${activeCond} THEN 1 ELSE 0 END) active,
            ${bucket(APPT_PENDING)} pending, ${bucket(APPT_SCHEDULED)} scheduled, ${bucket(APPT_DONE)} done,
            ${bucket(APPT_CANCELED)} canceled, ${bucket(APPT_NO_SHOW)} no_show,
            COUNT(DISTINCT CASE WHEN ${activeCond} AND COALESCE(a.client_id,0) > 0 THEN a.client_id END) active_clients
       FROM ${quoteIdentifier(appt.name)} a
      WHERE a.tenant_id = ? AND a.starts_at >= ? AND a.starts_at < ?${apptLocClause}`,
    [appt.tenantId ?? 0, from, toExclusive, ...apptLocParams],
  ).catch(() => [] as RowDataPacket[]);
  const ar = apptSummaryRows[0] ?? {};

  const apptTrendRows = await dbQuery<RowDataPacket[]>(
    `SELECT a.starts_at::date d, COUNT(*) cnt FROM ${quoteIdentifier(appt.name)} a
      WHERE a.tenant_id = ? AND a.starts_at >= ? AND a.starts_at < ? AND ${activeCond}${apptLocClause}
      GROUP BY d ORDER BY d ASC`,
    [appt.tenantId ?? 0, from, toExclusive, ...apptLocParams],
  ).catch(() => [] as RowDataPacket[]);

  // --- Top clienti (reports.php 841-852, etichette fallback legacy) ------
  const clientsTable = await tenantTable(slug, "clients");
  const topClientRows = await dbQuery<RowDataPacket[]>(
    `SELECT s.client_id,
            COALESCE(NULLIF(TRIM(c.full_name),''), CASE WHEN COALESCE(s.client_id,0) > 0 THEN CONCAT('Cliente #', s.client_id) ELSE 'Cliente non associato' END) name,
            COUNT(*) cnt, COALESCE(SUM(s.total),0) rev
       FROM ${quoteIdentifier(sales.name)} s
       LEFT JOIN ${quoteIdentifier(clientsTable.name)} c ON c.id = s.client_id AND c.tenant_id = s.tenant_id
      WHERE ${baseWhere}
      GROUP BY s.client_id, c.full_name ORDER BY rev DESC, cnt DESC LIMIT 100`,
    baseParams,
  ).catch(() => [] as RowDataPacket[]);

  // --- Top servizi e prodotti (esclusioni nome legacy, reports.php 855-875)
  const itemsTable = await tenantTable(slug, "sale_items");
  const nameExclusions = ["%giftcard%", "%gift card%", "%giftbox%", "%gift box%", "%ricarica%", "%pacchetto%"];
  const exclSql = nameExclusions.map(() => "LOWER(si.item_name) NOT LIKE ?").join(" AND ");
  const itemRows = await dbQuery<RowDataPacket[]>(
    `SELECT COALESCE(NULLIF(TRIM(si.item_type),''),'altro') type, si.item_name name,
            COALESCE(SUM(si.qty),0) qty, COALESCE(SUM(si.line_total),0) rev, COUNT(DISTINCT s.id) cnt
       FROM ${quoteIdentifier(itemsTable.name)} si
       JOIN ${quoteIdentifier(sales.name)} s ON s.id = si.sale_id AND s.tenant_id = si.tenant_id
      WHERE si.tenant_id = ? AND ${baseWhere}
        AND LOWER(TRIM(COALESCE(si.item_type,''))) IN ('service','product') AND ${exclSql}
      GROUP BY si.item_type, si.item_name ORDER BY rev DESC, qty DESC LIMIT 100`,
    [tid, ...baseParams, ...nameExclusions],
  ).catch(() => [] as RowDataPacket[]);

  // Composizione per tipologia (donut "Tipologie di vendita", tutti i tipi).
  const compRows = await dbQuery<RowDataPacket[]>(
    `SELECT COALESCE(NULLIF(TRIM(si.item_type),''),'altro') type, COALESCE(SUM(si.line_total),0) rev
       FROM ${quoteIdentifier(itemsTable.name)} si
       JOIN ${quoteIdentifier(sales.name)} s ON s.id = si.sale_id AND s.tenant_id = si.tenant_id
      WHERE si.tenant_id = ? AND ${baseWhere}
      GROUP BY type`,
    [tid, ...baseParams],
  ).catch(() => [] as RowDataPacket[]);
  const typeLabel = (t: string): string => {
    const low = t.toLowerCase();
    if (low === "service") return "Servizio";
    if (low === "product") return "Prodotto";
    if (low.includes("package") || low.includes("pacchetto")) return "Pacchetto";
    if (low.includes("giftcard")) return "GiftCard";
    if (low.includes("giftbox")) return "GiftBox";
    if (low.includes("recharge") || low.includes("ricarica")) return "Ricarica";
    return "Voce";
  };
  const compMap = new Map<string, number>();
  for (const row of compRows) {
    const label = typeLabel(String(row.type ?? "altro"));
    compMap.set(label, money((compMap.get(label) ?? 0) + Number(row.rev ?? 0)));
  }
  if (!compMap.has("Prodotto")) compMap.set("Prodotto", 0); // legacy: Prodotto sempre mostrato
  const compOrder = ["Servizio", "Prodotto", "Pacchetto", "GiftCard", "GiftBox", "Ricarica", "Voce"];
  const composition = compOrder.filter((label) => compMap.has(label)).map((label) => ({ label, revenue: compMap.get(label) ?? 0 }));

  // --- Operatori: vendite + ore lavorate (fusione legacy 1146-1189) ------
  const opRows = await dbQuery<RowDataPacket[]>(
    `SELECT COALESCE(NULLIF(TRIM(s.operator_name),''),'Non indicato') op, COUNT(*) cnt,
            COALESCE(SUM(s.total),0) rev, COALESCE(AVG(s.total),0) avg_ticket
       FROM ${quoteIdentifier(sales.name)} s WHERE ${baseWhere} GROUP BY op ORDER BY rev DESC, cnt DESC LIMIT 50`,
    baseParams,
  ).catch(() => [] as RowDataPacket[]);

  const doneSet = APPT_DONE.map((s) => `'${s}'`).join(",");
  let hoursRows: RowDataPacket[] = [];
  if (await tableExists("appointment_segments")) {
    const segTable = await tenantTable(slug, "appointment_segments");
    const staffTable = await tenantTable(slug, "staff");
    hoursRows = await dbQuery<RowDataPacket[]>(
      `SELECT COALESCE(NULLIF(TRIM(st.full_name),''), CONCAT('Operatore #', seg.staff_id)) name,
              SUM(CASE WHEN COALESCE(seg.duration_minutes,0) > 0 THEN seg.duration_minutes
                       ELSE GREATEST(0, EXTRACT(EPOCH FROM (seg.ends_at - seg.starts_at)) / 60) END) minutes,
              COUNT(DISTINCT a.id) appts
         FROM ${quoteIdentifier(segTable.name)} seg
         JOIN ${quoteIdentifier(appt.name)} a ON a.id = seg.appointment_id AND a.tenant_id = seg.tenant_id
         LEFT JOIN ${quoteIdentifier(staffTable.name)} st ON st.id = seg.staff_id AND st.tenant_id = seg.tenant_id
        WHERE seg.tenant_id = ? AND a.starts_at >= ? AND a.starts_at < ?
          AND LOWER(TRIM(COALESCE(a.status,''))) IN (${doneSet})${apptLocClause}
        GROUP BY name`,
      [appt.tenantId ?? 0, from, toExclusive, ...apptLocParams],
    ).catch(() => [] as RowDataPacket[]);
  }
  const opMap = new Map<string, { name: string; revenue: number; saleCount: number; avgTicket: number; hoursWorked: number; apptCount: number }>();
  for (const row of opRows) {
    const name = String(row.op ?? "Non indicato");
    opMap.set(name.toLowerCase(), { name, revenue: money(row.rev), saleCount: Number(row.cnt ?? 0), avgTicket: money(row.avg_ticket), hoursWorked: 0, apptCount: 0 });
  }
  for (const row of hoursRows) {
    const name = String(row.name ?? "");
    const key = name.toLowerCase();
    const hours = Math.round((Number(row.minutes ?? 0) / 60) * 10) / 10;
    const entry = opMap.get(key);
    if (entry) {
      entry.hoursWorked = hours;
      entry.apptCount = Number(row.appts ?? 0);
    } else {
      opMap.set(key, { name, revenue: 0, saleCount: 0, avgTicket: 0, hoursWorked: hours, apptCount: Number(row.appts ?? 0) });
    }
  }
  const operators = Array.from(opMap.values()).sort((a, b) => b.revenue - a.revenue || b.saleCount - a.saleCount);

  // --- Archivio clienti (reports.php 1013-1077) ---------------------------
  let clientLocClause = "";
  const clientLocParams: unknown[] = [];
  if (locationId > 0) {
    // Il cliente "appartiene" alla sede se location_id coincide O ha una
    // vendita/appuntamento in quella sede (buildClientScopeCondition 450-497).
    clientLocClause = ` AND (c.location_id = ? OR EXISTS (SELECT 1 FROM ${quoteIdentifier(sales.name)} sx WHERE sx.client_id = c.id AND sx.tenant_id = c.tenant_id AND sx.location_id = ?) OR EXISTS (SELECT 1 FROM ${quoteIdentifier(appt.name)} ax WHERE ax.client_id = c.id AND ax.tenant_id = c.tenant_id AND ax.location_id = ?))`;
    clientLocParams.push(locationId, locationId, locationId);
  }
  const birthValid = "c.birth_date IS NOT NULL AND c.birth_date >= '1900-01-01' AND c.birth_date <= CURRENT_DATE";
  const ageExpr = "DATE_PART('year', AGE(CURRENT_DATE, c.birth_date))";
  const archRows = await dbQuery<RowDataPacket[]>(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN UPPER(TRIM(COALESCE(c.gender,''))) = 'M' THEN 1 ELSE 0 END) male,
            SUM(CASE WHEN UPPER(TRIM(COALESCE(c.gender,''))) = 'F' THEN 1 ELSE 0 END) female,
            SUM(CASE WHEN ${birthValid} THEN 1 ELSE 0 END) birth_known,
            AVG(CASE WHEN ${birthValid} THEN ${ageExpr} END) avg_age,
            SUM(CASE WHEN ${birthValid} AND ${ageExpr} < 18 THEN 1 ELSE 0 END) a17,
            SUM(CASE WHEN ${birthValid} AND ${ageExpr} BETWEEN 18 AND 24 THEN 1 ELSE 0 END) a24,
            SUM(CASE WHEN ${birthValid} AND ${ageExpr} BETWEEN 25 AND 34 THEN 1 ELSE 0 END) a34,
            SUM(CASE WHEN ${birthValid} AND ${ageExpr} BETWEEN 35 AND 44 THEN 1 ELSE 0 END) a44,
            SUM(CASE WHEN ${birthValid} AND ${ageExpr} BETWEEN 45 AND 54 THEN 1 ELSE 0 END) a54,
            SUM(CASE WHEN ${birthValid} AND ${ageExpr} BETWEEN 55 AND 64 THEN 1 ELSE 0 END) a64,
            SUM(CASE WHEN ${birthValid} AND ${ageExpr} >= 65 THEN 1 ELSE 0 END) a65
       FROM ${quoteIdentifier(clientsTable.name)} c WHERE c.tenant_id = ?${clientLocClause}`,
    [clientsTable.tenantId ?? 0, ...clientLocParams],
  ).catch(() => [] as RowDataPacket[]);
  const cr = archRows[0] ?? {};
  const male = Number(cr.male ?? 0);
  const female = Number(cr.female ?? 0);
  const totalClients = Number(cr.total ?? 0);
  const genderKnown = male + female;
  // Prevalenza legacy (reports.php 1067-1077).
  const prevalence = genderKnown === 0 ? "Non indicato" : male === female ? "Equilibrato" : female > male ? "Donne" : "Uomini";
  const prevalenceSub = genderKnown > 0 ? `${genderKnown} con genere indicato` : "Nessun genere indicato";
  const birthKnown = Number(cr.birth_known ?? 0);
  const clientsArchive: ManageReports["clientsArchive"] = {
    total: totalClients,
    male,
    female,
    unknownGender: Math.max(0, totalClients - genderKnown),
    prevalence,
    prevalenceSub,
    birthKnown,
    birthUnknown: Math.max(0, totalClients - birthKnown),
    avgAge: cr.avg_age === null || cr.avg_age === undefined || birthKnown === 0 ? null : Math.round(Number(cr.avg_age)),
    ageBuckets: [
      { label: "<18", count: Number(cr.a17 ?? 0) },
      { label: "18-24", count: Number(cr.a24 ?? 0) },
      { label: "25-34", count: Number(cr.a34 ?? 0) },
      { label: "35-44", count: Number(cr.a44 ?? 0) },
      { label: "45-54", count: Number(cr.a54 ?? 0) },
      { label: "55-64", count: Number(cr.a64 ?? 0) },
      { label: "65+", count: Number(cr.a65 ?? 0) },
    ],
  };

  // --- Costi (reports.php 1211-1266): due_date BETWEEN inclusivo ----------
  let costs: ManageReports["costs"] = null;
  if (options.includeCosts && await tableExists("costs")) {
    const costsTable = await tenantTable(slug, "costs");
    const costLoc = locationId > 0 ? " AND c.location_id = ?" : "";
    const costRows = await dbQuery<RowDataPacket[]>(
      `SELECT COALESCE(SUM(c.amount),0) total,
              COALESCE(SUM(CASE WHEN COALESCE(c.is_paid,0) = 1 AND COALESCE(c.paid_amount,0) <= 0 THEN c.amount
                               WHEN COALESCE(c.is_paid,0) = 1 THEN c.paid_amount
                               ELSE COALESCE(c.paid_amount,0) END),0) paid,
              COALESCE(SUM(CASE WHEN COALESCE(c.is_paid,0) = 1 THEN 0 ELSE GREATEST(COALESCE(c.amount,0) - COALESCE(c.paid_amount,0), 0) END),0) open
         FROM ${quoteIdentifier(costsTable.name)} c
        WHERE c.tenant_id = ? AND c.due_date BETWEEN ? AND ?${costLoc}`,
      [costsTable.tenantId ?? 0, from, to, ...(locationId > 0 ? [locationId] : [])],
    ).catch(() => [] as RowDataPacket[]);
    const row = costRows[0] ?? {};
    costs = { total: money(row.total), paid: money(row.paid), open: money(row.open) };
  }

  // --- Commissioni (reports.php 1276-1327) --------------------------------
  let commissions: ManageReports["commissions"] = null;
  if (options.includeCommissions && await tableExists("staff_commission_payments")) {
    const commTable = await tenantTable(slug, "staff_commission_payments");
    const commLoc = locationId > 0 ? " AND p.location_id = ?" : "";
    const commRows = await dbQuery<RowDataPacket[]>(
      `SELECT COUNT(*) cnt, COALESCE(SUM(COALESCE(p.commission_amount,0)),0) total,
              COALESCE(SUM(CASE WHEN COALESCE(p.is_paid,0) = 1 THEN COALESCE(p.commission_amount,0) ELSE 0 END),0) paid,
              COALESCE(SUM(CASE WHEN COALESCE(p.is_paid,0) = 1 THEN 0 ELSE COALESCE(p.commission_amount,0) END),0) open
         FROM ${quoteIdentifier(commTable.name)} p
        WHERE p.tenant_id = ? AND COALESCE(p.movement_datetime, p.created_at) >= ? AND COALESCE(p.movement_datetime, p.created_at) < ?
          AND LOWER(TRIM(COALESCE(p.entry_status,''))) <> 'cancelled'${commLoc}`,
      [commTable.tenantId ?? 0, from, toExclusive, ...(locationId > 0 ? [locationId] : [])],
    ).catch(() => [] as RowDataPacket[]);
    const row = commRows[0] ?? {};
    commissions = { count: Number(row.cnt ?? 0), total: money(row.total), paid: money(row.paid), open: money(row.open) };
  }

  // --- Confronto (finestra esplicita o periodo precedente di pari durata) --
  let comparison: ManageReports["comparison"] = null;
  if (compare) {
    let prevFrom: string;
    let prevTo: string;
    if (options.compareFrom && /^\d{4}-\d{2}-\d{2}$/.test(options.compareFrom) && options.compareTo && /^\d{4}-\d{2}-\d{2}$/.test(options.compareTo)) {
      prevFrom = options.compareFrom;
      prevTo = options.compareTo;
      if (prevFrom > prevTo) [prevFrom, prevTo] = [prevTo, prevFrom];
    } else {
      const lenDays = Math.max(1, Math.round((Date.parse(`${toExclusive}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000));
      prevTo = addDaysYmd(from, -1);
      prevFrom = addDaysYmd(from, -lenDays);
    }
    const prevToExclusive = addDaysYmd(prevTo, 1);
    const [prevCollections, prevSummary, prevApptCount] = await Promise.all([
      collect(prevFrom, prevToExclusive),
      salesSummary(prevFrom, prevToExclusive),
      apptCount(prevFrom, prevToExclusive),
    ]);
    const deltaPct = prevSummary.sold > 0
      ? Math.round(((summaryRow.sold - prevSummary.sold) / prevSummary.sold) * 1000) / 10
      : summaryRow.sold > 0 ? 100 : 0;
    comparison = {
      from: prevFrom,
      to: prevTo,
      totalRevenue: prevCollections.totalRevenue,
      soldRevenue: prevSummary.sold,
      saleCount: prevSummary.cnt,
      servedClients: prevSummary.served,
      averageTicket: prevSummary.avgTicket,
      appointmentCount: prevApptCount,
      deltaPct,
    };
  }

  // Metodi di pagamento nell'ordine legacy, share % a 1 decimale.
  const methodsTotal = Array.from(collections.byMethod.values()).reduce((sum, m) => sum + m.amount, 0);
  const paymentMethods = PAYMENT_ORDER.filter((label) => collections.byMethod.has(label)).map((label) => {
    const m = collections.byMethod.get(label)!;
    return {
      label,
      amount: m.amount,
      count: m.count,
      sharePct: methodsTotal > 0.00001 ? Math.round((m.amount / methodsTotal) * 1000) / 10 : 0,
    };
  });

  const dailyDays = Array.from(collections.byDay.keys()).sort();

  return {
    from,
    to,
    summary: {
      totalRevenue: collections.totalRevenue,
      collectionMovements: collections.movements,
      soldRevenue: summaryRow.sold,
      grossRevenue: summaryRow.gross,
      discountTotal: summaryRow.discountTotal,
      saleCount: summaryRow.cnt,
      servedClients: summaryRow.served,
      averageTicket: summaryRow.avgTicket,
      appointmentCount,
    },
    appointments: {
      total: Number(ar.total ?? 0),
      active: Number(ar.active ?? 0),
      pending: Number(ar.pending ?? 0),
      scheduled: Number(ar.scheduled ?? 0),
      done: Number(ar.done ?? 0),
      canceled: Number(ar.canceled ?? 0),
      noShow: Number(ar.no_show ?? 0),
      activeClients: Number(ar.active_clients ?? 0),
      trend: apptTrendRows.map((r) => ({ day: dayOf(r.d), count: Number(r.cnt ?? 0) })),
    },
    paymentMethods,
    clientsArchive,
    costs,
    commissions,
    composition,
    comparison,
    daily: dailyDays.map((day) => ({ day, revenue: collections.byDay.get(day)!.revenue, saleCount: collections.byDay.get(day)!.movements })),
    topClients: topClientRows.map((r) => ({ clientId: Number(r.client_id ?? 0), name: String(r.name ?? "—"), revenue: money(r.rev), saleCount: Number(r.cnt ?? 0) })),
    topServices: itemRows.filter((r) => String(r.type).toLowerCase() === "service").slice(0, 10).map((r) => ({ name: String(r.name ?? ""), revenue: money(r.rev), qty: Number(r.qty ?? 0), saleCount: Number(r.cnt ?? 0) })),
    topProducts: itemRows.filter((r) => String(r.type).toLowerCase() === "product").slice(0, 10).map((r) => ({ name: String(r.name ?? ""), revenue: money(r.rev), qty: Number(r.qty ?? 0), saleCount: Number(r.cnt ?? 0) })),
    topItems: itemRows.map((r) => ({ name: String(r.name ?? ""), type: typeLabel(String(r.type ?? "altro")), revenue: money(r.rev), qty: Number(r.qty ?? 0), saleCount: Number(r.cnt ?? 0) })),
    operators,
  };
}
