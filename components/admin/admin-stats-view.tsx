"use client";

// Vista STATISTICHE del pannello SaaS Admin (2026-07-19; ristrutturata 20/07):
// crescita, entrate, piani e utilizzo in 4 sottotab su un unico payload
// (section=stats), con FILTRO PERIODO (3/6/12 mesi, client-side sulle serie
// continue) e grafici affiancati a coppie. L'MRR è contrattualizzato (tenant
// attivi x prezzo piano), non cassa: le etichette lo dicono.

import { useState } from "react";
import { BarChart3, LineChart, RotateCcw, TrendingUp, Users, Wallet, type LucideIcon } from "lucide-react";
import { Button, EmptyOperation, Metric, SectionHead, Table, formatEuro } from "@/components/admin/admin-shared";
import { DualMonthBarChart, MonthBarChart, TrendLineChart } from "@/components/admin/admin-charts";

export type StatsPayload = {
  growth: {
    tenants_by_month: Array<{ month: string; admin: number; self_signup: number }>;
    signup_funnel: { requests: number; verified: number; active: number };
    marketplace: { total: number; verified: number; active_30d: number; new_by_month: Array<{ month: string; value: number }> };
  };
  revenue: {
    mrr_total: number;
    arpu: number;
    tenants_active: number;
    sms_by_month: Array<{ month: string; revenue: number; orders: number }>;
    mrr_trend: Array<{ day: string; mrr: number }>;
  };
  plans: {
    by_plan: Array<{ id: number; name: string; tenants: number; mrr: number }>;
    unassigned_active: number;
    top_by_tenants: string;
    top_by_mrr: string;
    assignments_by_month: Array<{ month: string; value: number }>;
  };
  usage: {
    totals: { gestionale_users: number; clients: number; appointments: number; sales: number };
    appointments_by_month: Array<{ month: string; value: number }>;
    sales_by_month: Array<{ month: string; value: number }>;
    top_tenants: Array<{ slug: string; name: string; appointments: number; sales: number }>;
  };
};

type StatsSection = "growth" | "revenue" | "plans" | "usage";

const sections: Array<{ key: StatsSection; label: string; icon: LucideIcon }> = [
  { key: "growth", label: "Crescita", icon: TrendingUp },
  { key: "revenue", label: "Entrate", icon: Wallet },
  { key: "plans", label: "Piani", icon: BarChart3 },
  { key: "usage", label: "Utilizzo", icon: Users },
];

const PERIODS = [3, 6, 12] as const;

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-md border border-slate-200 bg-white shadow-sm">
      <SectionHead title={title} subtitle={subtitle} />
      <div className="p-4">{children}</div>
    </section>
  );
}

export function StatsView({ data, onRefresh, onOpenTenant }: { data: StatsPayload | null; onRefresh: () => void; onOpenTenant: (slug: string) => void }) {
  const [section, setSection] = useState<StatsSection>("growth");
  // Filtro periodo CLIENT-SIDE: le serie dal server sono continue (fillMonths),
  // quindi tagliare gli ultimi N mesi resta corretto.
  const [months, setMonths] = useState<(typeof PERIODS)[number]>(12);
  if (!data) {
    return <EmptyOperation icon={LineChart} title="Statistiche" detail="Carica crescita, entrate, piani e utilizzo della piattaforma." onRefresh={onRefresh} />;
  }
  const lastMonths = <T,>(rows: T[]): T[] => rows.slice(-months);
  const periodLabel = `ultimi ${months} mesi`;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1 rounded-md border border-slate-200 bg-white p-2 shadow-sm">
          {sections.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={`inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-semibold ${section === item.key ? "bg-[#182238] text-white" : "text-slate-600 hover:bg-slate-100"}`}
                key={item.key}
                type="button"
                onClick={() => setSection(item.key)}
              >
                <Icon size={15} aria-hidden />
                {item.label}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Periodo dei grafici: taglia le serie mensili (e il trend MRR). */}
          <div className="flex rounded-md border border-slate-200 bg-white p-1 shadow-sm" role="group" aria-label="Periodo dei grafici">
            {PERIODS.map((p) => (
              <button
                className={`h-8 rounded px-3 text-xs font-semibold ${months === p ? "bg-[#182238] text-white" : "text-slate-600 hover:bg-slate-100"}`}
                key={p}
                type="button"
                onClick={() => setMonths(p)}
              >
                {p} mesi
              </button>
            ))}
          </div>
          <Button icon={RotateCcw} variant="outline" onClick={onRefresh}>Aggiorna</Button>
        </div>
      </div>

      {section === "growth" ? (
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-4">
            <Metric label="Utenti marketplace" value={String(data.growth.marketplace.total)} detail="account clienti registrati" />
            <Metric label="Registrazioni completate" value={percent(data.growth.marketplace.verified, data.growth.marketplace.total)} detail="chi ha confermato l'email; il resto si è fermato al codice" />
            <Metric label="Attivi 30 giorni" value={String(data.growth.marketplace.active_30d)} detail="accesso nell'ultimo mese" />
            <Metric label="Registrazioni self-service" value={String(data.growth.signup_funnel.requests)} detail={`${percent(data.growth.signup_funnel.active, data.growth.signup_funnel.requests)} diventate tenant`} />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <ChartCard title="Nuovi tenant per mese" subtitle={`Creati dal pannello vs registrazioni autonome (${periodLabel}).`}>
              <DualMonthBarChart data={lastMonths(data.growth.tenants_by_month).map((row) => ({ label: row.month, a: row.admin, b: row.self_signup }))} nameA="Creati dal pannello" nameB="Registrazioni autonome" />
            </ChartCard>
            <ChartCard title="Nuovi utenti marketplace per mese" subtitle={`Account clienti registrati sul marketplace (${periodLabel}).`}>
              <MonthBarChart data={lastMonths(data.growth.marketplace.new_by_month).map((row) => ({ label: row.month, value: row.value }))} />
            </ChartCard>
          </div>
          <Table
            title="Funnel registrazioni self-service"
            headers={["Passo", "Quante", "Conversione"]}
            rows={[
              ["Richieste ricevute", String(data.growth.signup_funnel.requests), "100%"],
              ["Email verificate", String(data.growth.signup_funnel.verified), percent(data.growth.signup_funnel.verified, data.growth.signup_funnel.requests)],
              ["Tenant attivi", String(data.growth.signup_funnel.active), percent(data.growth.signup_funnel.active, data.growth.signup_funnel.requests)],
            ]}
          />
        </div>
      ) : null}

      {section === "revenue" ? (
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-3">
            <Metric label="Ricavo mensile da abbonamenti (MRR)" value={formatEuro(data.revenue.mrr_total)} detail="somma dei piani dei tenant attivi — non ancora incassato" />
            <Metric label="Ricavo medio per tenant (ARPU)" value={formatEuro(data.revenue.arpu)} detail={`MRR diviso ${data.revenue.tenants_active} tenant attivi`} />
            <Metric label="Ricavo SMS (12 mesi)" value={formatEuro(data.revenue.sms_by_month.reduce((sum, row) => sum + row.revenue, 0))} detail="ordini pagati" />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <ChartCard title="Andamento MRR" subtitle="Snapshot giornalieri (si costruisce dal monitoraggio: più giorni = più storia).">
              <TrendLineChart formatValue={(v) => formatEuro(v)} points={data.revenue.mrr_trend.slice(-months * 30).map((row) => ({ label: row.day, value: row.mrr }))} zeroText="Ancora nessun ricavo registrato: i piani assegnati ai tenant compariranno qui." />
            </ChartCard>
            <ChartCard title="Ricavo SMS per mese" subtitle={`Ordini pagati (${periodLabel}).`}>
              <MonthBarChart data={lastMonths(data.revenue.sms_by_month).map((row) => ({ label: row.month, value: row.revenue }))} formatValue={(v) => formatEuro(v)} />
            </ChartCard>
          </div>
        </div>
      ) : null}

      {section === "plans" ? (
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-3">
            <Metric label="Piano più venduto" value={data.plans.top_by_tenants === "-" ? "Nessuno assegnato" : data.plans.top_by_tenants} detail="per tenant attivi assegnati" />
            <Metric label="Piano che rende di più" value={data.plans.top_by_mrr === "-" ? "Nessuno assegnato" : data.plans.top_by_mrr} detail="per MRR generato" />
            <Metric label="Senza piano" value={String(data.plans.unassigned_active)} detail="tenant attivi da assegnare" />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <Table
              title="Distribuzione per piano"
              headers={["Piano", "Tenant attivi", "MRR"]}
              empty="Nessun piano definito: creali in Fatturazione."
              rows={data.plans.by_plan.map((plan) => [
                <strong key={plan.id}>{plan.name}</strong>,
                String(plan.tenants),
                formatEuro(plan.mrr),
              ])}
            />
            <ChartCard title="Assegnazioni piani per mese" subtitle={`Quante volte un piano è stato collegato a un tenant (${periodLabel}).`}>
              <MonthBarChart data={lastMonths(data.plans.assignments_by_month).map((row) => ({ label: row.month, value: row.value }))} />
            </ChartCard>
          </div>
        </div>
      ) : null}

      {section === "usage" ? (
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-4">
            <Metric label="Utenti gestionale" value={String(data.usage.totals.gestionale_users)} detail="operatori e admin dei tenant" />
            <Metric label="Clienti censiti" value={String(data.usage.totals.clients)} detail="anagrafiche nei gestionali" />
            <Metric label="Appuntamenti totali" value={String(data.usage.totals.appointments)} detail="su tutta la piattaforma" />
            <Metric label="Vendite totali" value={String(data.usage.totals.sales)} detail="documenti di cassa" />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <ChartCard title="Appuntamenti creati per mese" subtitle={`Tutti i tenant (${periodLabel}).`}>
              <MonthBarChart data={lastMonths(data.usage.appointments_by_month).map((row) => ({ label: row.month, value: row.value }))} />
            </ChartCard>
            <ChartCard title="Vendite registrate per mese" subtitle={`Tutti i tenant (${periodLabel}).`}>
              <MonthBarChart data={lastMonths(data.usage.sales_by_month).map((row) => ({ label: row.month, value: row.value }))} />
            </ChartCard>
          </div>
          <Table
            title="Tenant più attivi (ultimi 30 giorni)"
            headers={["Tenant", "Appuntamenti", "Vendite", "Azioni"]}
            empty="Nessuna attività negli ultimi 30 giorni."
            onRowClick={(index) => { const tenant = data.usage.top_tenants[index]; if (tenant) onOpenTenant(tenant.slug); }}
            rows={data.usage.top_tenants.map((tenant) => [
              <span key={tenant.slug}><strong>{tenant.name}</strong><span className="ml-2 text-slate-500">{tenant.slug}</span></span>,
              String(tenant.appointments),
              String(tenant.sales),
              <button className="inline-flex h-8 items-center rounded-md border border-slate-200 px-3 text-xs font-semibold hover:bg-slate-50" key={`open-${tenant.slug}`} type="button" onClick={(event) => { event.stopPropagation(); onOpenTenant(tenant.slug); }}>
                Apri
              </button>,
            ])}
          />
        </div>
      ) : null}
    </div>
  );
}
