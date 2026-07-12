import "server-only";

// DASHBOARD (V1 campagna di verifica) — port fedele dei calcoli di
// app/pages/dashboard.php (737 righe) + api_dashboard_performance.php (281):
//  - KPI top: Clienti (con sede: COUNT DISTINCT client_id dall'UNION di
//    clients/appointments/sales della sede; senza sede: COUNT(*) clients),
//    Appuntamenti oggi (blacklist stati annullati), Vendite ultimi 30gg
//    (SUM(total) con sale_date >= NOW()-30gg, stati attivi);
//  - Statistica settimanale (api_dashboard_performance): SOLO status
//    'scheduled', ricavi = SUM(appointment_services.price*qty) con fallback
//    services.price (NON le vendite POS), ore = SUM(ends_at-starts_at),
//    nuovi clienti su created_at; delta % vs settimana precedente (null
//    quando prev=0 e current>0, reso "—" muted); serie = ricavi appuntamenti
//    per giorno lun->dom;
//  - Prossimi appuntamenti: starts_at in [NOW(), NOW()+7gg), SOLO
//    pending/scheduled, LIMIT 10, servizi aggregati, formato d/m H:i —
//    gated calendar.view;
//  - Scadenziario e Costi: is_paid=0 con residuo GREATEST(amount-paid_amount,
//    0), Scaduti (due_date < oggi) e Questo mese (BETWEEN 1..fine mese) —
//    gated costs.manage|costs.items;
//  - filtro SEDE permissivo come il legacy (location_id = ? OR IS NULL).

import type { RowDataPacket } from "@/lib/tenant-db";
import { columnExists, dbQuery, quoteIdentifier, tableExists, tenantTable } from "@/lib/tenant-db";

const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function isoLocal(d: Date): string {
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
}
function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return isoLocal(d);
}
function mondayOf(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  return isoLocal(d);
}

// Stati appuntamento ESCLUSI dai KPI (dashboard.php:34, blacklist).
const CANCELLED_APPT = ["canceled", "cancelled", "no_show", "no show", "no-show", "noshow", "non presentato", "rejected", "annullato", "annullata", "rifiutato", "rifiutata"];
// Stati vendita ESCLUSI (dashboard.php:35).
const CANCELLED_SALE = ["cancelled", "canceled", "annullata", "annullato"];

const apptActiveSql = (alias: string) => `LOWER(TRIM(COALESCE(${alias}.status,''))) NOT IN (${CANCELLED_APPT.map((s) => `'${s}'`).join(",")})`;
const saleActiveSql = (alias: string) => `LOWER(TRIM(COALESCE(${alias}.status,''))) NOT IN (${CANCELLED_SALE.map((s) => `'${s}'`).join(",")})`;
// Filtro sede PERMISSIVO legacy (dashboard.php:41-56): include location NULL —
// usato SOLO per gli appuntamenti (dashboardApptLocationFilter).
const locFilter = (alias: string, locationId: number) => (locationId > 0 ? ` AND (${alias}.location_id = ${locationId} OR ${alias}.location_id IS NULL)` : "");
// Filtro sede STRETTO legacy: il ramo clients/sales del KPI Clienti e la Vendite
// 30gg usano `location_id=?` (dashboard.php:66,75,110) — NIENTE OR IS NULL.
const locStrict = (alias: string, locationId: number) => (locationId > 0 ? ` AND ${alias}.location_id = ${locationId}` : "");

// _pct_change (api_dashboard_performance:16-22): confronti con <= 0 come il
// PHP — prev<=0 e cur<=0 -> 0.0; prev<=0 e cur>0 -> null (reso "—" muted).
// Restituisce la percentuale GREZZA (l'arrotondamento a 1 decimale è fatto in
// fase di rendering, come setDelta in dashboard.js).
function pctChange(current: number, previous: number): number | null {
  if (previous <= 0) return current <= 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

export type DashboardWeeklyMetric = { label: string; value: string; deltaPct: number | null };

export type ManageDashboardPayload = {
  stats: Array<{ label: string; value: string; detail: string }>;
  weekly: { range: string; metrics: DashboardWeeklyMetric[]; series: Array<{ date: string; label: string; revenue: number }> };
  // null quando manca calendar.view (la card non viene resa, come il legacy).
  upcoming: Array<{ date: string; clientName: string; serviceName: string }> | null;
  // null quando mancano costs.manage/costs.items.
  costs: {
    overdueAmount: number;
    overdueCount: number;
    overdueFrom: string;
    overdueTo: string;
    monthAmount: number;
    monthCount: number;
    monthFrom: string;
    monthTo: string;
  } | null;
};

export async function getManageDashboard(
  slug: string,
  opts: { locationId: number; canSeeCalendar: boolean; canSeeCosts: boolean; needsLocationSelection?: boolean },
): Promise<ManageDashboardPayload> {
  const locationId = Math.max(0, opts.locationId || 0);
  const failClosed = opts.needsLocationSelection === true;
  const today = isoLocal(new Date());

  // Settimana corrente lun->dom + settimana precedente (per i delta) — servono
  // anche in fail-closed per costruire il range e la serie a zero.
  const weekStart = mondayOf(today);
  const weekEnd = addDaysIso(weekStart, 6);
  const prevStart = addDaysIso(weekStart, -7);
  const prevEnd = addDaysIso(weekStart, -1);

  // Formattatori it-IT con raggruppamento MANUALE: Node non raggruppa 1000-9999
  // con toLocaleString('it-IT'), mentre number_format PHP / Intl browser sì.
  const groupThousands = (intDigits: string) => intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  const money = (n: number) => {
    const v = round2(n);
    const [ip, dp] = Math.abs(v).toFixed(2).split(".");
    return `${v < 0 ? "-" : ""}${groupThousands(ip)},${dp}`;
  };
  // KPI "Vendite 30gg": simbolo PRIMA come il legacy `€ fmt_money()` (dashboard.php:508).
  const fmtEuroBefore = (n: number) => `€ ${money(n)}`;
  // KPI settimanale "Ricavi": simbolo DOPO come dashboard.js fmtEUR (Intl currency
  // it-IT = "1.234,56 €").
  const fmtEuroAfter = (n: number) => `${money(n)} €`;
  // fmtNum (Intl it-IT intero): conteggi settimanali raggruppati.
  const fmtCount = (n: number) => `${n < 0 ? "-" : ""}${groupThousands(String(Math.trunc(Math.abs(n))))}`;
  // fmtHours (dashboard.js): 1 decimale, virgola, NESSUNA unità ("3,5").
  const fmtHours = (n: number) => String(Math.round(n * 10) / 10).replace(".", ",");

  const weekRange = `${weekStart.slice(8, 10)}/${weekStart.slice(5, 7)}/${weekStart.slice(0, 4)} - ${weekEnd.slice(8, 10)}/${weekEnd.slice(5, 7)}/${weekEnd.slice(0, 4)}`;
  const zeroSeries = Array.from({ length: 7 }, (_, i) => {
    const date = addDaysIso(weekStart, i);
    return { date, label: `${date.slice(8, 10)}/${date.slice(5, 7)}`, revenue: 0 };
  });

  // Fail-closed (tenant multi-sede senza sede selezionata): come dashboard.php
  // azzera i KPI, restituisce l'empty response settimanale (delta 0.0, serie a
  // zero) e nasconde le card "Prossimi appuntamenti" e "Scadenziario e Costi".
  if (failClosed) {
    return {
      stats: [
        { label: "Clienti", value: "0", detail: "anagrafiche attive" },
        { label: "Appuntamenti oggi", value: "0", detail: "agenda operativa" },
        { label: "Vendite ultimi 30gg", value: fmtEuroBefore(0), detail: "vendite attive" },
      ],
      weekly: {
        range: weekRange,
        metrics: [
          { label: "Appuntamenti", value: "0", deltaPct: 0 },
          { label: "Ricavi", value: fmtEuroAfter(0), deltaPct: 0 },
          { label: "Ore lavorate", value: fmtHours(0), deltaPct: 0 },
          { label: "Nuovi clienti", value: "0", deltaPct: 0 },
        ],
        series: zeroSeries,
      },
      // Legacy (dashboard.php:214-215,594): in fail-closed la card "Prossimi
      // appuntamenti" resta VISIBILE ma VUOTA se calendar.view; i Costi restano
      // nascosti (il widget è dentro !failClosed && canAny(costs)).
      upcoming: opts.canSeeCalendar ? [] : null,
      costs: null,
    };
  }

  // Preflight metadati in PARALLELO (stesse risoluzioni di prima, senza il
  // costo di ~10 round trip sequenziali): i calcoli sono letture indipendenti,
  // l'ordine non cambia i risultati.
  const [apptTable, clientsTable, salesTable, asTable, svcTable, bridgeTable] = await Promise.all([
    tenantTable(slug, "appointments"),
    tenantTable(slug, "clients"),
    tenantTable(slug, "sales"),
    tenantTable(slug, "appointment_services"),
    tenantTable(slug, "services"),
    tenantTable(slug, "appointment_locations").catch(() => null),
  ]);
  const T = apptTable.tenantId ?? 0;
  const [hasBridge, hasAsQty, hasApptServiceId, hasClientLoc, hasApptLoc, hasSalesLoc, hasAsServiceName] = await Promise.all([
    bridgeTable ? tableExists(bridgeTable.name).catch(() => false) : Promise.resolve(false),
    columnExists(asTable.name, "qty"),
    columnExists(apptTable.name, "service_id"),
    columnExists(clientsTable.name, "location_id"),
    columnExists(apptTable.name, "location_id"),
    columnExists(salesTable.name, "location_id"),
    columnExists(asTable.name, "service_name"),
  ]);

  // Filtro sede appuntamenti col ramo BRIDGE legacy (dashboard.php 42-47):
  // location diretta OPPURE NULL con riga appointment_locations della sede
  // oppure NESSUNA riga bridge (non assegnato). Senza il ramo bridge un
  // appuntamento NULL con bridge verso un'ALTRA sede verrebbe incluso a torto.
  const apptLoc = (alias: string): string => {
    if (locationId <= 0) return "";
    if (hasBridge && bridgeTable) {
      const bn = quoteIdentifier(bridgeTable.name);
      return ` AND (${alias}.location_id = ${locationId} OR (${alias}.location_id IS NULL AND (EXISTS (SELECT 1 FROM ${bn} al WHERE al.appointment_id = ${alias}.id AND al.location_id = ${locationId} AND al.tenant_id = ${alias}.tenant_id) OR NOT EXISTS (SELECT 1 FROM ${bn} al2 WHERE al2.appointment_id = ${alias}.id AND al2.tenant_id = ${alias}.tenant_id))))`;
    }
    return locFilter(alias, locationId);
  };

  // --- KPI Clienti (dashboard.php:59-95) ---
  const kpiClientsP = (async () => {
    if (locationId > 0) {
      const rows = await dbQuery<RowDataPacket[]>(
        // Rami clients/sales STRETTI (location_id=?), ramo appointments PERMISSIVO
        // (location_id=? OR NULL) — esattamente come dashboard.php:66/71/75, con
        // i filtri COALESCE(id,0)>0 / COALESCE(client_id,0)>0 del legacy.
        `SELECT COUNT(DISTINCT client_id) AS c FROM (
           SELECT id AS client_id FROM ${quoteIdentifier(clientsTable.name)} WHERE tenant_id = ${T} AND location_id = ${locationId} AND COALESCE(id, 0) > 0
           UNION SELECT a.client_id FROM ${quoteIdentifier(apptTable.name)} a WHERE a.tenant_id = ${T} AND COALESCE(a.client_id, 0) > 0${apptLoc("a")}
           UNION SELECT s.client_id FROM ${quoteIdentifier(salesTable.name)} s WHERE s.tenant_id = ${T} AND COALESCE(s.client_id, 0) > 0${locStrict("s", locationId)}
         ) u WHERE client_id IS NOT NULL`,
        [],
      ).catch(() => [] as RowDataPacket[]);
      return num(rows[0]?.c);
    }
    const rows = await dbQuery<RowDataPacket[]>(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(clientsTable.name)} WHERE tenant_id = ${T}`, []).catch(() => [] as RowDataPacket[]);
    return num(rows[0]?.c);
  })();

  // --- KPI Appuntamenti oggi (dashboard.php:97-104) ---
  const kpiApptTodayP = dbQuery<RowDataPacket[]>(
    `SELECT COUNT(*) AS c FROM ${quoteIdentifier(apptTable.name)} a
      WHERE a.tenant_id = ${T} AND a.starts_at::date = ? AND ${apptActiveSql("a")}${apptLoc("a")}`,
    [today],
  ).catch(() => [] as RowDataPacket[]).then((rows) => num(rows[0]?.c));

  // --- KPI Vendite ultimi 30gg (dashboard.php:105-130) ---
  const kpiSales30P = dbQuery<RowDataPacket[]>(
    `SELECT COALESCE(SUM(s.total),0) AS s FROM ${quoteIdentifier(salesTable.name)} s
      WHERE s.tenant_id = ${T} AND s.sale_date >= NOW() - interval '30 days' AND ${saleActiveSql("s")}${locStrict("s", locationId)}`,
    [],
  ).catch(() => [] as RowDataPacket[]).then((rows) => round2(num(rows[0]?.s)));

  // --- Statistica settimanale (api_dashboard_performance.php:82-245) ---
  // Conta SOLO status='scheduled' ("Prenotato"); ricavi dai servizi degli
  // appuntamenti. (weekStart/weekEnd/prevStart/prevEnd calcolati sopra;
  // asTable/svcTable e i flag colonna dal preflight.)

  // Ricavi: LEFT JOIN sui servizi dell'appuntamento; se l'appuntamento NON ha
  // righe servizio, fallback sul prezzo del servizio legacy (a.service_id) —
  // port fedele del CASE di api_dashboard_performance. qty: NULLIF(qty,0)->1.
  const qtyExpr = hasAsQty ? "COALESCE(NULLIF(sv.qty, 0), 1)" : "1";
  const revExpr = `CASE WHEN sv.appointment_id IS NOT NULL THEN COALESCE(sv.price, 0) * ${qtyExpr} ELSE ${hasApptServiceId ? "COALESCE(s.price, 0)" : "0"} END`;
  const revJoin = `LEFT JOIN ${quoteIdentifier(asTable.name)} sv ON sv.appointment_id = a.id AND sv.tenant_id = a.tenant_id${hasApptServiceId ? `\n         LEFT JOIN ${quoteIdentifier(svcTable.name)} s ON s.id = a.service_id AND s.tenant_id = a.tenant_id` : ""}`;

  // Nuovi clienti per sede: come _dashboard_perf (client_location_sql) il legacy
  // considera il cliente "della sede" se ha la sua location OPPURE un
  // appuntamento (location o NULL) o una vendita in quella sede.
  let clientLocSql = "";
  if (locationId > 0) {
    const parts: string[] = [];
    if (hasClientLoc) parts.push(`c.location_id = ${locationId}`);
    // Ramo appuntamenti col filtro bridge annidato (api_dashboard_performance
    // client_location_sql): apptLoc restituisce ' AND (...)'.
    if (hasApptLoc) parts.push(`EXISTS (SELECT 1 FROM ${quoteIdentifier(apptTable.name)} a WHERE a.client_id = c.id AND a.tenant_id = c.tenant_id${apptLoc("a")})`);
    if (hasSalesLoc) parts.push(`EXISTS (SELECT 1 FROM ${quoteIdentifier(salesTable.name)} s WHERE s.client_id = c.id AND s.tenant_id = c.tenant_id AND s.location_id = ${locationId})`);
    if (parts.length) clientLocSql = ` AND (${parts.join(" OR ")})`;
  }

  const weekAgg = async (from: string, to: string) => {
    const where = `a.tenant_id = ${T} AND LOWER(TRIM(COALESCE(a.status,''))) = 'scheduled' AND a.starts_at >= ? AND a.starts_at < ?${apptLoc("a")}`;
    const params = [`${from} 00:00:00`, `${addDaysIso(to, 1)} 00:00:00`];
    const clientWhere = `c.tenant_id = ${T} AND c.created_at::date >= ? AND c.created_at::date <= ?${clientLocSql}`;
    const [cntRows, revRows, hourRows, newRows] = await Promise.all([
      dbQuery<RowDataPacket[]>(`SELECT COUNT(DISTINCT a.id) AS c FROM ${quoteIdentifier(apptTable.name)} a WHERE ${where}`, params).catch(() => [] as RowDataPacket[]),
      dbQuery<RowDataPacket[]>(
        `SELECT COALESCE(SUM(${revExpr}),0) AS r
           FROM ${quoteIdentifier(apptTable.name)} a
           ${revJoin}
          WHERE ${where}`,
        params,
      ).catch(() => [] as RowDataPacket[]),
      dbQuery<RowDataPacket[]>(
        `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (a.ends_at - a.starts_at)) / 60), 0) AS m FROM ${quoteIdentifier(apptTable.name)} a WHERE ${where} AND a.ends_at IS NOT NULL`,
        params,
      ).catch(() => [] as RowDataPacket[]),
      dbQuery<RowDataPacket[]>(`SELECT COUNT(*) AS c FROM ${quoteIdentifier(clientsTable.name)} c WHERE ${clientWhere}`, [from, to]).catch(() => [] as RowDataPacket[]),
    ]);
    return {
      appointments: num(cntRows[0]?.c),
      revenue: round2(num(revRows[0]?.r)),
      // Ore GREZZE (no round2): il legacy calcola il delta sul valore non
      // arrotondato (api_dashboard_performance.php:208-209,262); il rendering
      // arrotonda a 1 decimale (fmtHours).
      hours: num(hourRows[0]?.m) / 60,
      newClients: num(newRows[0]?.c),
    };
  };
  const weeklyP = Promise.all([weekAgg(weekStart, weekEnd), weekAgg(prevStart, prevEnd)]);

  // Serie ricavi giornalieri (api_dashboard_performance.php:216-245): stesso
  // LEFT JOIN + CASE fallback della statistica settimanale.
  const dailyP = dbQuery<RowDataPacket[]>(
    `SELECT a.starts_at::date AS d, COALESCE(SUM(${revExpr}),0) AS r
       FROM ${quoteIdentifier(apptTable.name)} a
       ${revJoin}
      WHERE a.tenant_id = ${T} AND LOWER(TRIM(COALESCE(a.status,''))) = 'scheduled'
        AND a.starts_at >= ? AND a.starts_at < ?${apptLoc("a")}
      GROUP BY a.starts_at::date`,
    [`${weekStart} 00:00:00`, `${addDaysIso(weekEnd, 1)} 00:00:00`],
  ).catch(() => [] as RowDataPacket[]);

  // --- Prossimi appuntamenti (dashboard.php:214-237) ---
  const upcomingP = (async (): Promise<ManageDashboardPayload["upcoming"]> => {
    if (!opts.canSeeCalendar) return null;
    // Nome servizio come il legacy COALESCE(sv.services_name, s.name): usa lo
    // SNAPSHOT appointment_services.service_name (fallback al nome corrente del
    // servizio), e se l'appuntamento non ha righe servizio ricade su a.service_id.
    const svcNameExpr = hasAsServiceName ? "COALESCE(NULLIF(TRIM(sv.service_name), ''), s.name)" : "s.name";
    const fallbackJoin = hasApptServiceId ? `\n         LEFT JOIN ${quoteIdentifier(svcTable.name)} s2 ON s2.id = a.service_id AND s2.tenant_id = a.tenant_id` : "";
    const fallbackCoalesce = hasApptServiceId ? ", s2.name" : "";
    const fallbackGroupBy = hasApptServiceId ? ", s2.name" : "";
    const rows = await dbQuery<RowDataPacket[]>(
      // JOIN clients INNER come il legacy (dashboard.php 221): un appuntamento
      // con cliente mancante NON compare. services può restare NULL (nessuna
      // riga snapshot e nessun servizio primario) → '—' solo in quel caso,
      // come il `?? '—'` PHP (riga 618).
      `SELECT a.starts_at, c.full_name AS client_name,
              COALESCE(NULLIF(STRING_AGG(DISTINCT ${svcNameExpr}, ', ' ORDER BY ${svcNameExpr}), '')${fallbackCoalesce}) AS services
         FROM ${quoteIdentifier(apptTable.name)} a
         JOIN ${quoteIdentifier(clientsTable.name)} c ON c.id = a.client_id AND c.tenant_id = a.tenant_id
         LEFT JOIN ${quoteIdentifier(asTable.name)} sv ON sv.appointment_id = a.id AND sv.tenant_id = a.tenant_id
         LEFT JOIN ${quoteIdentifier(svcTable.name)} s ON s.id = sv.service_id AND s.tenant_id = a.tenant_id${fallbackJoin}
        WHERE a.tenant_id = ${T} AND a.starts_at >= NOW() AND a.starts_at < NOW() + interval '7 days'
          AND LOWER(TRIM(COALESCE(a.status,''))) IN ('pending','scheduled')${apptLoc("a")}
        GROUP BY a.id, a.starts_at, c.full_name${fallbackGroupBy}
        ORDER BY a.starts_at ASC
        LIMIT 10`,
      [],
    ).catch(() => [] as RowDataPacket[]);
    return rows.map((r) => {
      const dt = String(r.starts_at ?? "");
      const d = new Date(dt.includes("T") ? dt : dt.replace(" ", "T"));
      const p = (n2: number) => String(n2).padStart(2, "0");
      const label = Number.isNaN(d.getTime()) ? dt.slice(0, 16) : `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
      // client_name RAW (il legacy non ha fallback '—' sul cliente); servizio
      // '—' SOLO quando NULL (`?? '—'`), '' resta ''.
      return {
        date: label,
        clientName: String(r.client_name ?? ""),
        serviceName: r.services === null || r.services === undefined ? "—" : String(r.services),
      };
    });
  })();

  // --- Scadenziario e Costi (dashboard.php:132-206) ---
  const costsP = (async (): Promise<ManageDashboardPayload["costs"]> => {
    if (!opts.canSeeCosts) return null;
    const costsTable = await tenantTable(slug, "costs").catch(() => null);
    if (!costsTable) return null;
    const hasPaidAmount = await columnExists(costsTable.name, "paid_amount");
    const residual = hasPaidAmount ? "GREATEST(COALESCE(amount,0) - COALESCE(paid_amount,0), 0)" : "COALESCE(amount,0)";
    // dashboard.php:159/170: con paid_amount conta solo residui > 0.00001.
    const residualFilter = hasPaidAmount ? ` AND ${residual} > 0.00001` : "";
    const monthStart = `${today.slice(0, 7)}-01`;
    const nextMonth = new Date(`${monthStart}T12:00:00`);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const monthEnd = addDaysIso(isoLocal(nextMonth), -1);
    // Filtro sede STRETTO come il legacy (dashboard.php:148 'AND location_id=?').
    const locSql = locationId > 0 && (await columnExists(costsTable.name, "location_id")) ? ` AND location_id = ${locationId}` : "";
    // Su ERRORE SQL il legacy azzera l'intero widget (catch -> $costsWidget
    // = null, card NASCOSTA, dashboard.php 202-204) — niente card a zero.
    try {
      const [overdueRows, monthRows] = await Promise.all([
        dbQuery<RowDataPacket[]>(
          `SELECT COALESCE(SUM(${residual}),0) AS s, COUNT(*) AS c, MIN(due_date) AS min_due FROM ${quoteIdentifier(costsTable.name)}
            WHERE tenant_id = ${costsTable.tenantId ?? 0} AND COALESCE(is_paid,0) = 0 AND due_date < ?${locSql}${residualFilter}`,
          [today],
        ),
        dbQuery<RowDataPacket[]>(
          `SELECT COALESCE(SUM(${residual}),0) AS s, COUNT(*) AS c FROM ${quoteIdentifier(costsTable.name)}
            WHERE tenant_id = ${costsTable.tenantId ?? 0} AND COALESCE(is_paid,0) = 0 AND due_date >= ? AND due_date <= ?${locSql}${residualFilter}`,
          [monthStart, monthEnd],
        ),
      ]);
      const minDue = String(overdueRows[0]?.min_due ?? "").slice(0, 10);
      return {
        overdueAmount: round2(num(overdueRows[0]?.s)),
        overdueCount: num(overdueRows[0]?.c),
        // Link "Vedi scaduti": from = MIN(due_date) (fallback inizio mese), to = oggi.
        overdueFrom: /^\d{4}-\d{2}-\d{2}$/.test(minDue) ? minDue : monthStart,
        overdueTo: today,
        monthAmount: round2(num(monthRows[0]?.s)),
        monthCount: num(monthRows[0]?.c),
        monthFrom: monthStart,
        monthTo: monthEnd,
      };
    } catch (e) {
      // La card resta nascosta come nel legacy, ma l'errore va almeno loggato
      // per non silenziare regressioni SQL vere.
      console.error("[manage-dashboard] widget costi nascosto per errore SQL:", e);
      return null;
    }
  })();

  // Tutti i blocchi sono letture indipendenti: attesa in parallelo (prima
  // erano ~29 round trip sequenziali, 650-730ms misurati).
  const [kpiClients, kpiApptToday, kpiSales30, [cur, prev], dailyRows, upcoming, costs] = await Promise.all([
    kpiClientsP, kpiApptTodayP, kpiSales30P, weeklyP, dailyP, upcomingP, costsP,
  ]);
  const revenueByDate = new Map(dailyRows.map((r) => [String(r.d).slice(0, 10), round2(num(r.r))]));
  const series = Array.from({ length: 7 }, (_, i) => {
    const date = addDaysIso(weekStart, i);
    return { date, label: `${date.slice(8, 10)}/${date.slice(5, 7)}`, revenue: revenueByDate.get(date) ?? 0 };
  });

  return {
    stats: [
      { label: "Clienti", value: String(kpiClients), detail: "anagrafiche attive" },
      { label: "Appuntamenti oggi", value: String(kpiApptToday), detail: "agenda operativa" },
      { label: "Vendite ultimi 30gg", value: fmtEuroBefore(kpiSales30), detail: "vendite attive" },
    ],
    weekly: {
      range: weekRange,
      metrics: [
        { label: "Appuntamenti", value: fmtCount(cur.appointments), deltaPct: pctChange(cur.appointments, prev.appointments) },
        { label: "Ricavi", value: fmtEuroAfter(cur.revenue), deltaPct: pctChange(cur.revenue, prev.revenue) },
        { label: "Ore lavorate", value: fmtHours(cur.hours), deltaPct: pctChange(cur.hours, prev.hours) },
        { label: "Nuovi clienti", value: fmtCount(cur.newClients), deltaPct: pctChange(cur.newClients, prev.newClients) },
      ],
      series,
    },
    upcoming,
    costs,
  };
}
