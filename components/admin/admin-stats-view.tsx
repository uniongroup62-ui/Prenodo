"use client";

// Vista STATISTICHE del pannello SaaS Admin (2026-07-19): crescita, entrate,
// piani e utilizzo in 4 sottotab su un unico payload (section=stats).
// L'MRR e' contrattualizzato (tenant attivi x prezzo piano), non cassa: le
// etichette lo dicono. I trend storici arrivano dagli snapshot giornalieri.

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

function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

export function StatsView({ data, onRefresh, onOpenTenant }: { data: StatsPayload | null; onRefresh: () => void; onOpenTenant: (slug: string) => void }) {
  const [section, setSection] = useState<StatsSection>("growth");
  if (!data) {
    return <EmptyOperation icon={LineChart} title="Statistiche" detail="Carica crescita, entrate, piani e utilizzo della piattaforma." onRefresh={onRefresh} />;
  }
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
        <Button icon={RotateCcw} variant="outline" onClick={onRefresh}>Aggiorna</Button>
      </div>

      {section === "growth" ? (
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-4">
            <Metric label="Utenti marketplace" value={String(data.growth.marketplace.total)} detail="account clienti registrati" />
            <Metric label="Email verificate" value={percent(data.growth.marketplace.verified, data.growth.marketplace.total)} detail={`${data.growth.marketplace.verified} account`} />
            <Metric label="Attivi 30 giorni" value={String(data.growth.marketplace.active_30d)} detail="accesso nell'ultimo mese" />
            <Metric label="Registrazioni self-service" value={String(data.growth.signup_funnel.requests)} detail={`${percent(data.growth.signup_funnel.active, data.growth.signup_funnel.requests)} diventate tenant`} />
          </div>
          <section className="min-w-0 rounded-md border border-slate-200 bg-white shadow-sm">
            <SectionHead title="Nuovi tenant per mese" subtitle="Creati dal pannello vs registrazioni autonome (ultimi 12 mesi)." />
            <div className="p-4">
              <DualMonthBarChart data={data.growth.tenants_by_month.map((row) => ({ label: row.month, a: row.admin, b: row.self_signup }))} nameA="Creati dal pannello" nameB="Registrazioni autonome" />
            </div>
          </section>
          <section className="min-w-0 rounded-md border border-slate-200 bg-white shadow-sm">
            <SectionHead title="Nuovi utenti marketplace per mese" subtitle="Account clienti registrati sul marketplace (ultimi 12 mesi)." />
            <div className="p-4">
              <MonthBarChart data={data.growth.marketplace.new_by_month.map((row) => ({ label: row.month, value: row.value }))} />
            </div>
          </section>
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
            <Metric label="MRR contrattualizzato" value={formatEuro(data.revenue.mrr_total)} detail="tenant attivi x prezzo piano" />
            <Metric label="ARPU" value={formatEuro(data.revenue.arpu)} detail={`su ${data.revenue.tenants_active} tenant attivi`} />
            <Metric label="Ricavo SMS (12 mesi)" value={formatEuro(data.revenue.sms_by_month.reduce((sum, row) => sum + row.revenue, 0))} detail="ordini pagati" />
          </div>
          <section className="min-w-0 rounded-md border border-slate-200 bg-white shadow-sm">
            <SectionHead title="Andamento MRR" subtitle="Snapshot giornalieri (si costruisce dal monitoraggio: piu' giorni = piu' storia)." />
            <div className="p-4">
              <TrendLineChart formatValue={(v) => formatEuro(v)} points={data.revenue.mrr_trend.map((row) => ({ label: row.day, value: row.mrr }))} />
            </div>
          </section>
          <section className="min-w-0 rounded-md border border-slate-200 bg-white shadow-sm">
            <SectionHead title="Ricavo SMS per mese" subtitle="Ordini pagati (ultimi 12 mesi)." />
            <div className="p-4">
              <MonthBarChart data={data.revenue.sms_by_month.map((row) => ({ label: row.month, value: row.revenue }))} formatValue={(v) => formatEuro(v)} />
            </div>
          </section>
        </div>
      ) : null}

      {section === "plans" ? (
        <div className="grid gap-4">
          <div className="grid gap-3 md:grid-cols-3">
            <Metric label="Piano piu' venduto" value={data.plans.top_by_tenants} detail="per tenant attivi assegnati" />
            <Metric label="Piano che rende di piu'" value={data.plans.top_by_mrr} detail="per MRR generato" />
            <Metric label="Senza piano" value={String(data.plans.unassigned_active)} detail="tenant attivi da assegnare" />
          </div>
          <Table
            title="Distribuzione per piano"
            headers={["Piano", "Tenant attivi", "MRR"]}
            rows={data.plans.by_plan.length === 0 ? [["Nessun piano definito", "-", "-"]] : data.plans.by_plan.map((plan) => [
              <strong key={plan.id}>{plan.name}</strong>,
              String(plan.tenants),
              formatEuro(plan.mrr),
            ])}
          />
          <section className="min-w-0 rounded-md border border-slate-200 bg-white shadow-sm">
            <SectionHead title="Assegnazioni piani per mese" subtitle="Quante volte un piano e' stato collegato a un tenant (ultimi 12 mesi)." />
            <div className="p-4">
              <MonthBarChart data={data.plans.assignments_by_month.map((row) => ({ label: row.month, value: row.value }))} />
            </div>
          </section>
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
          <section className="min-w-0 rounded-md border border-slate-200 bg-white shadow-sm">
            <SectionHead title="Appuntamenti creati per mese" subtitle="Tutti i tenant (ultimi 12 mesi)." />
            <div className="p-4">
              <MonthBarChart data={data.usage.appointments_by_month.map((row) => ({ label: row.month, value: row.value }))} />
            </div>
          </section>
          <section className="min-w-0 rounded-md border border-slate-200 bg-white shadow-sm">
            <SectionHead title="Vendite registrate per mese" subtitle="Tutti i tenant (ultimi 12 mesi)." />
            <div className="p-4">
              <MonthBarChart data={data.usage.sales_by_month.map((row) => ({ label: row.month, value: row.value }))} />
            </div>
          </section>
          <Table
            title="Tenant piu' attivi (ultimi 30 giorni)"
            headers={["Tenant", "Appuntamenti", "Vendite", "Azioni"]}
            rows={data.usage.top_tenants.map((tenant) => [
              <span key={tenant.slug}><strong>{tenant.name}</strong><span className="ml-2 text-slate-500">{tenant.slug}</span></span>,
              String(tenant.appointments),
              String(tenant.sales),
              <button className="inline-flex h-8 items-center rounded-md border border-slate-200 px-3 text-xs font-semibold hover:bg-slate-50" key={`open-${tenant.slug}`} type="button" onClick={() => onOpenTenant(tenant.slug)}>
                Apri
              </button>,
            ])}
          />
        </div>
      ) : null}
    </div>
  );
}
