"use client";

// Dettaglio TENANT del pannello SaaS Admin (Fase F, 2026-07-19): pannello a
// tab (panoramica, timeline, configurazione, supporto, backup, danger zone)
// estratto dal monolite saas-admin-app.tsx.

import {
  Activity,
  Archive,
  Building2,
  CheckCircle2,
  ClipboardCheck,
  Eye,
  History,
  LayoutDashboard,
  LifeBuoy,
  Lock,
  RotateCcw,
  Settings,
  ShieldAlert,
  Trash2,
  UserCog,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import {
  AuditList,
  Badge,
  Button,
  Detail,
  HealthChecks,
  Input,
  Metric,
  SectionHead,
  Table,
  Toggle,
  formPayload,
  formatEuro,
  formatKb,
  healthLabel,
  onboardingLabel,
  statusLabel,
  statusTone,
  submitAction,
  submitOperation,
  tenantStatus,
  timelineKindStyle,
  type BackupRow,
  type PlanOption,
  type Tenant,
  type TenantDetailPayload,
  type TenantTab,
  type TimelineEvent,
} from "@/components/admin/admin-shared";

export const tenantTabs: Array<{ key: TenantTab; label: string; icon: LucideIcon }> = [
  { key: "overview", label: "Panoramica", icon: LayoutDashboard },
  { key: "timeline", label: "Timeline", icon: History },
  { key: "settings", label: "Dati", icon: Settings },
  { key: "admin", label: "Admin", icon: UserCog },
  { key: "onboarding", label: "Onboarding", icon: ClipboardCheck },
  { key: "health", label: "Diagnostica", icon: Activity },
  { key: "support", label: "Supporto", icon: LifeBuoy },
  { key: "backups", label: "Backup", icon: Archive },
  { key: "danger", label: "Azioni critiche", icon: ShieldAlert },
];

export function TenantDetailPanel(props: {
  detail: TenantDetailPayload | null;
  plans: PlanOption[];
  activeTab: TenantTab;
  supportLink: string;
  backups: BackupRow[];
  canManage: boolean;
  onTabChange: (tab: TenantTab) => void;
  onAction: (action: string, payload?: Record<string, string>) => void;
  onOperationAction: (payload: Record<string, string>) => void;
}) {
  if (!props.detail) {
    return (
      <section className="min-w-0 rounded-md border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-3 text-slate-500">
          <Building2 size={20} aria-hidden />
          Seleziona un tenant per aprire la gestione completa.
        </div>
      </section>
    );
  }

  const tenant = props.detail.tenant;
  const status = tenantStatus(tenant);
  return (
    <section className="min-w-0 rounded-md border border-slate-200 bg-white shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 p-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#365a96]">Tenant</p>
          <h2 className="text-2xl font-semibold">{tenant.name}</h2>
          <div className="mt-1 flex flex-wrap gap-2 text-sm text-slate-500">
            <code>{tenant.slug}</code>
            <span>ID {tenant.id}</span>
          </div>
        </div>
        <Badge tone={statusTone(status)}>{statusLabel[status]}</Badge>
      </div>
      {/* flex-wrap: con 10 tab lo scroll orizzontale nascondeva Supporto/
          Backup/Azioni critiche senza alcun indizio (walkthrough UX 19/07). */}
      <div className="flex flex-wrap gap-1 border-b border-slate-100 p-2">
        {tenantTabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button className={`inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-semibold ${props.activeTab === tab.key ? "bg-[#182238] text-white" : "text-slate-600 hover:bg-slate-100"}`} key={tab.key} type="button" onClick={() => props.onTabChange(tab.key)}>
              <Icon size={15} aria-hidden />
              {tab.label}
            </button>
          );
        })}
      </div>
      <div className="p-4">
        {props.activeTab === "overview" ? <TenantOverview detail={props.detail} /> : null}
        {props.activeTab === "timeline" ? <TenantTimeline events={props.detail.timeline ?? []} /> : null}
        {/* Visibilità fusa dentro Dati (analisi organizzazione 19/07): due
            form impilati — dati anagrafici + visibilità pubblica. */}
        {props.activeTab === "settings" ? (
          <div className="grid gap-6">
            <TenantSettings plans={props.plans} tenant={tenant} canManage={props.canManage} onAction={props.onAction} />
            <div>
              <p className="mb-2 text-sm font-semibold text-slate-700">Visibilità pubblica</p>
              <TenantVisibility tenant={tenant} canManage={props.canManage} onAction={props.onAction} />
            </div>
          </div>
        ) : null}
        {props.activeTab === "admin" ? <TenantAdmin tenant={tenant} canManage={props.canManage} onAction={props.onAction} /> : null}
        {props.activeTab === "onboarding" ? <TenantOnboarding tenant={tenant} canManage={props.canManage} onAction={props.onAction} /> : null}
        {props.activeTab === "health" ? <TenantHealth detail={props.detail} canManage={props.canManage} onAction={props.onAction} /> : null}
        {props.activeTab === "support" ? <TenantSupport detail={props.detail} supportLink={props.supportLink} canManage={props.canManage} onAction={props.onAction} /> : null}
        {props.activeTab === "backups" ? <TenantBackups tenant={tenant} backups={props.backups} canManage={props.canManage} onAction={props.onOperationAction} /> : null}
        {props.activeTab === "danger" ? <TenantDanger tenant={tenant} canManage={props.canManage} onAction={props.onAction} /> : null}
      </div>
    </section>
  );
}

function TenantOverview({ detail }: { detail: TenantDetailPayload }) {
  const tenant = detail.tenant;
  const health = tenant.health?.level ?? "warning";
  // I controlli di dettaglio vivono nell'ULTIMA diagnostica registrata: lo
  // snapshot sul tenant porta solo il livello (walkthrough UX 19/07 —
  // "Salute OK" con "Nessun controllo disponibile" era fuorviante).
  let checks = tenant.health?.checks ?? [];
  if (!checks.length && detail.healthChecks[0]?.checks_json) {
    try {
      checks = JSON.parse(String(detail.healthChecks[0].checks_json));
    } catch {
      checks = [];
    }
  }
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-3">
        <Metric label="Stato" value={statusLabel[tenantStatus(tenant)]} detail="tenant" />
        <Metric label="Salute" value={healthLabel[health]} detail={tenant.health_checked_at || "mai salvata"} />
        <Metric label="Onboarding" value={`${tenant.onboarding_percent ?? 0}%`} detail={onboardingLabel(tenant.onboarding_status)} />
      </div>
      <div className="grid gap-2 text-sm">
        <Detail label="URL" value={`/${tenant.slug}/`} />
        <Detail label="Email admin" value={tenant.admin_email || "-"} />
        <Detail label="Piano" value={tenant.plan || "-"} />
        <Detail label="Crediti SMS" value={String(detail.smsCredits ?? 0)} />
        <Detail label="Origine" value={tenant.source === "self_signup" ? "Registrazione autonoma" : "Creazione admin"} />
        <Detail label="Creato il" value={tenant.created_at || "-"} />
      </div>
      <HealthChecks checks={checks} />
    </div>
  );
}

function TenantTimeline({ events }: { events: TimelineEvent[] }) {
  if (!events.length) {
    return <p className="p-2 text-sm text-slate-500">Nessun evento registrato per questo tenant.</p>;
  }
  return (
    <ol className="relative grid gap-0 border-l border-slate-200 pl-4">
      {events.map((event, index) => {
        const kind = timelineKindStyle[event.kind] ?? timelineKindStyle.audit;
        return (
          <li className="relative pb-4" key={`${event.at}-${event.kind}-${index}`}>
            <span aria-hidden className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-slate-400" />
            <div className="flex flex-wrap items-baseline gap-2">
              <Badge tone={kind.tone}>{kind.label}</Badge>
              <span className="text-sm font-semibold">{event.title}</span>
              <span className="text-xs text-slate-500">{event.at}</span>
              {event.actor ? <span className="text-xs text-slate-500">· {event.actor}</span> : null}
            </div>
            {event.detail ? <p className="mt-0.5 text-sm text-slate-600">{event.detail}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}

function TenantSettings({ tenant, plans, canManage, onAction }: { tenant: Tenant; plans: PlanOption[]; canManage: boolean; onAction: (action: string, payload?: Record<string, string>) => void }) {
  return (
    <form className="grid gap-3 md:grid-cols-2" key={`settings-${tenant.slug}-${tenant.plan_id ?? 0}`} onSubmit={(event) => submitAction(event, "update", onAction)}>
      <input name="slug" type="hidden" value={tenant.slug} />
      <Input name="name" label="Nome" defaultValue={tenant.name} required />
      <Input name="admin_email" label="Email admin" type="email" defaultValue={tenant.admin_email ?? ""} />
      {/* Piano come ENTITA' (select dei piani veri): l'assegnazione governa i
          gate del gestionale, mai testo libero. */}
      <label>
        <span className="mb-1 block text-sm font-medium text-slate-600">Piano</span>
        <select className="h-10 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-[#365a96]" defaultValue={String(tenant.plan_id ?? 0)} name="plan_id">
          <option value="0">Nessun piano (illimitato)</option>
          {plans.map((plan) => <option key={plan.id} value={String(plan.id)}>{plan.name} — {formatEuro(plan.price_month)}/mese</option>)}
        </select>
      </label>
      <Input name="tenant_url" label="URL tenant" defaultValue={`/${tenant.slug}/`} disabled />
      <label className="md:col-span-2">
        <span className="mb-1 block text-sm font-medium text-slate-600">Note interne</span>
        <textarea className="min-h-24 w-full rounded-md border border-slate-200 p-3 outline-none focus:border-[#365a96]" name="notes" defaultValue={tenant.notes ?? ""} />
      </label>
      <Button disabled={!canManage} icon={Settings}>Salva dati</Button>
    </form>
  );
}

function TenantVisibility({ tenant, canManage, onAction }: { tenant: Tenant; canManage: boolean; onAction: (action: string, payload?: Record<string, string>) => void }) {
  return (
    <form className="grid gap-4" onSubmit={(event) => submitAction(event, "visibility", onAction)}>
      <input name="slug" type="hidden" value={tenant.slug} />
      <Toggle name="booking_public_allowed" label="Consenti visibilità booking" detail="Abilita prenotazioni online pubbliche e pulsanti Prenota." defaultChecked={Number(tenant.booking_public_allowed ?? 1) === 1} />
      <Toggle name="marketplace_public_allowed" label="Consenti visibilità marketplace" detail="Abilita scheda pubblica, sedi, ricerca e preferiti marketplace." defaultChecked={Number(tenant.marketplace_public_allowed ?? 1) === 1} />
      <Button disabled={!canManage} icon={Eye}>Salva visibilità</Button>
    </form>
  );
}

function TenantAdmin({ tenant, canManage, onAction }: { tenant: Tenant; canManage: boolean; onAction: (action: string, payload?: Record<string, string>) => void }) {
  return (
    <form className="grid gap-3 md:grid-cols-2" onSubmit={(event) => submitAction(event, "repair_admin", onAction)}>
      <input name="slug" type="hidden" value={tenant.slug} />
      <Input name="admin_name" label="Nome admin" defaultValue="Admin" />
      <Input name="admin_email" label="Email admin" type="email" defaultValue={tenant.admin_email ?? ""} required />
      <Input name="admin_pass" label="Nuova password" type="text" placeholder="Lascia vuoto per non cambiarla" />
      <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">Verifica o ricrea utente admin, operatore collegato e sedi abilitate.</div>
      <Button disabled={!canManage} icon={UserCog}>Verifica admin tenant</Button>
    </form>
  );
}

function TenantOnboarding({ tenant, canManage, onAction }: { tenant: Tenant; canManage: boolean; onAction: (action: string, payload?: Record<string, string>) => void }) {
  return (
    <div className="grid gap-4">
      <div className="h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="h-full bg-[#365a96]" style={{ width: `${tenant.onboarding_percent ?? 0}%` }} />
      </div>
      <div className="grid gap-2 text-sm">
        <Detail label="Avanzamento" value={`${tenant.onboarding_percent ?? 0}%`} />
        <Detail label="Stato" value={tenant.onboarding_status || "not_started"} />
        <Detail label="Step corrente" value={tenant.onboarding_step || "-"} />
        <Detail label="Iniziato il" value={tenant.onboarding_started_at || "-"} />
        <Detail label="Completato il" value={tenant.onboarding_completed_at || "-"} />
      </div>
      <Button disabled={!canManage} icon={RotateCcw} onClick={() => onAction("reset_onboarding", { slug: tenant.slug })}>Reset onboarding</Button>
    </div>
  );
}

function TenantHealth({ detail, canManage, onAction }: { detail: TenantDetailPayload; canManage: boolean; onAction: (action: string, payload?: Record<string, string>) => void }) {
  const tenant = detail.tenant;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        <Button disabled={!canManage} icon={Activity} onClick={() => onAction("record_health", { slug: tenant.slug })}>Verifica diagnostica</Button>
        <Button variant="outline" disabled={!canManage} icon={Wrench} onClick={() => onAction("repair_schema", { slug: tenant.slug })}>Ripara schema</Button>
      </div>
      <HealthChecks checks={tenant.health?.checks ?? []} />
      {tenant.health?.missing_schema?.length ? <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Elementi schema mancanti: {tenant.health.missing_schema.slice(0, 20).join(", ")}</div> : null}
      <Table title="Storico diagnostica" headers={["Data", "Origine", "Esito", "Errori"]} rows={detail.healthChecks.map((row) => [row.created_at || "-", row.source || "-", healthLabel[row.level] || row.level, String(row.errors_count ?? 0)])} />
    </div>
  );
}

function TenantSupport({ detail, supportLink, canManage, onAction }: { detail: TenantDetailPayload; supportLink: string; canManage: boolean; onAction: (action: string, payload?: Record<string, string>) => void }) {
  const tenant = detail.tenant;
  return (
    <div className="grid gap-4">
      {supportLink ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
          <p className="text-sm font-semibold text-emerald-800">Link monouso generato. Dopo il primo accesso non sara riutilizzabile.</p>
          <input className="mt-2 h-10 w-full rounded-md border border-emerald-200 bg-white px-3 text-sm" readOnly value={supportLink} onFocus={(event) => event.currentTarget.select()} />
        </div>
      ) : null}
      <form className="grid gap-3 md:grid-cols-[1fr_150px]" onSubmit={(event) => submitAction(event, "support_create", onAction)}>
        <input name="slug" type="hidden" value={tenant.slug} />
        <Input name="reason" label="Motivo" placeholder="Es. verifica problema calendario" required />
        <label>
          <span className="mb-1 block text-sm font-medium text-slate-600">Durata</span>
          <select className="h-10 w-full rounded-md border border-slate-200 px-3 outline-none focus:border-[#365a96]" name="minutes" defaultValue="30">
            <option value="15">15 minuti</option>
            <option value="30">30 minuti</option>
            <option value="60">1 ora</option>
            <option value="120">2 ore</option>
          </select>
        </label>
        <Button disabled={!canManage} icon={LifeBuoy}>Genera accesso supporto</Button>
      </form>
      <Table
        title="Token disponibili"
        headers={["Motivo", "Creato da", "Scadenza", "Azioni"]}
        rows={detail.activeTokens.map((token) => [
          token.reason || "-",
          token.created_by_email || "-",
          token.expires_at || "-",
          <button className="rounded-md border border-red-200 px-2 py-1 text-xs font-semibold text-red-700" key={token.id} disabled={!canManage} type="button" onClick={() => onAction("support_revoke", { slug: tenant.slug, token_id: String(token.id) })}>Revoca</button>,
        ])}
      />
      <Table title="Storico accessi supporto" headers={["Motivo", "Creato da", "Scadenza", "Uso", "Revoca"]} rows={detail.recentTokens.map((token) => [token.reason || "-", token.created_by_email || "-", token.expires_at || "-", token.used_at || "-", token.revoked_at || "-"])} />
    </div>
  );
}

function TenantBackups({ tenant, backups, canManage, onAction }: { tenant: Tenant; backups: BackupRow[]; canManage: boolean; onAction: (payload: Record<string, string>) => void }) {
  return (
    <div className="grid gap-4">
      <form className="grid gap-3 md:grid-cols-[1fr_auto]" onSubmit={(event) => submitOperation(event, "backup_create", onAction)}>
        <input name="slug" type="hidden" value={tenant.slug} />
        <Input name="reason" label="Motivo backup" placeholder="Es. prima di intervento tecnico" />
        <Button disabled={!canManage} icon={Archive}>Crea backup</Button>
      </form>
      <Table
        title="Backup disponibili"
        headers={["Data", "Motivo", "Dimensione", "Percorso", "Azioni"]}
        rows={backups.map((backup) => [
          backup.created_at || "-",
          backup.reason || "-",
          formatKb(backup.backup_size),
          <code className="text-xs" key={`path-${backup.id}`}>{backup.backup_path}</code>,
          <a className={`rounded-md border border-slate-200 px-2 py-1 text-xs font-semibold ${canManage ? "" : "pointer-events-none opacity-50"}`} href={`/api/admin/operations?section=backup_download&slug=${encodeURIComponent(tenant.slug)}&id=${backup.id}`} key={`download-${backup.id}`}>Scarica</a>,
        ])}
      />
    </div>
  );
}

function TenantDanger({ tenant, canManage, onAction }: { tenant: Tenant; canManage: boolean; onAction: (action: string, payload?: Record<string, string>) => void }) {
  const status = tenantStatus(tenant);
  return (
    <div className="grid gap-4">
      {/* Conferma esplicita su sospensione/archiviazione (walkthrough UX
          19/07): bloccano l'accesso del tenant, non devono partire per sbaglio. */}
      <form className="grid gap-3 md:grid-cols-[1fr_auto]" onSubmit={(event) => {
        event.preventDefault();
        const payload = formPayload(event.currentTarget);
        if (status === "active" && !window.confirm(`Sospendere "${tenant.slug}"? Il tenant non potra' piu' accedere.`)) return;
        onAction(status === "active" ? "suspend" : "activate", { ...payload, slug: tenant.slug });
      }}>
        <Input name="reason" label={status === "active" ? "Motivo sospensione" : "Riattivazione"} placeholder="Es. pagamento scaduto" disabled={status !== "active"} />
        <Button disabled={!canManage || status === "deleted"} icon={status === "active" ? Lock : CheckCircle2}>{status === "active" ? "Sospendi" : "Riattiva"}</Button>
      </form>
      <form className="grid gap-3 md:grid-cols-[1fr_auto]" onSubmit={(event) => {
        event.preventDefault();
        const payload = formPayload(event.currentTarget);
        if (status !== "deleted" && !window.confirm(`Archiviare "${tenant.slug}"? Restera' recuperabile da questa pagina.`)) return;
        onAction(status === "deleted" ? "restore" : "archive", { ...payload, slug: tenant.slug });
      }}>
        <Input name="reason" label={status === "deleted" ? "Archivio" : "Motivo archiviazione"} placeholder="Es. cliente cessato" disabled={status === "deleted"} />
        <Button variant="outline" disabled={!canManage} icon={RotateCcw}>{status === "deleted" ? "Ripristina" : "Archivia"}</Button>
      </form>
      <form className="rounded-md border border-red-200 bg-red-50 p-4" onSubmit={(event) => submitAction(event, "delete", onAction)}>
        <input name="slug" type="hidden" value={tenant.slug} />
        <p className="font-semibold text-red-800">Eliminazione definitiva</p>
        <p className="mt-1 text-sm text-red-700">Rimuove registro tenant e dati condivisi collegati; prima viene creato un backup automatico. Digita lo slug esatto.</p>
        <div className="mt-3 flex gap-2">
          <input className="h-10 min-w-0 flex-1 rounded-md border border-red-200 bg-white px-3 outline-none" name="confirm_slug" placeholder={tenant.slug} />
          <button className="inline-flex h-10 items-center gap-2 rounded-md border border-red-300 px-4 text-sm font-semibold text-red-800 disabled:opacity-50" disabled={!canManage}>
            <Trash2 size={16} aria-hidden />
            Elimina
          </button>
        </div>
      </form>
    </div>
  );
}
