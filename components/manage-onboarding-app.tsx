"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, Loader2 } from "lucide-react";

type Step = {
  key: string;
  label: string;
  title: string;
};

type OnboardingState = {
  ok?: boolean;
  status: string;
  currentStep: string;
  completedSteps: string[];
  skippedSteps: string[];
  percent: number;
  steps: Step[];
  data: {
    business: Record<string, unknown> | null;
    location: Record<string, unknown> | null;
    hours: Array<Record<string, unknown>>;
    staff: Array<Record<string, unknown>>;
    cabins: Array<Record<string, unknown>>;
    categories: Array<Record<string, unknown>>;
    services: Array<Record<string, unknown>>;
    booking: Record<string, unknown>;
  };
  error?: string;
};

export function ManageOnboardingApp({ tenantSlug }: { tenantSlug: string }) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [activeStep, setActiveStep] = useState("business");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const response = await fetch(`/api/manage/onboarding?slug=${encodeURIComponent(tenantSlug)}`);
        const data = await response.json() as OnboardingState;
        if (cancelled) return;
        if (!response.ok || data.error) {
          setMessage(data.error ?? "Onboarding non disponibile.");
          return;
        }
        setState(data);
        setActiveStep(data.currentStep);
      } catch {
        if (!cancelled) setMessage("Onboarding non disponibile ora.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [tenantSlug]);

  const currentStep = useMemo(() => state?.steps.find((step) => step.key === activeStep) ?? state?.steps[0], [activeStep, state?.steps]);
  const isCompleted = state?.status === "completed";

  async function submit(action: "save_step" | "skip_step" | "complete", payload: Record<string, string>) {
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch(`/api/manage/onboarding?slug=${encodeURIComponent(tenantSlug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": tenantSlug },
        body: JSON.stringify({ action, step: activeStep, ...payload }),
      });
      const data = await response.json() as OnboardingState;
      if (!response.ok || data.error) {
        setMessage(data.error ?? "Onboarding non aggiornato.");
        return;
      }
      setState(data);
      setActiveStep(data.currentStep);
      setMessage(action === "complete" ? "Onboarding completato." : "Configurazione salvata.");
    } catch {
      setMessage("Onboarding non aggiornato ora.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#eef3fb] text-[#09111f]">
        <div className="inline-flex items-center gap-2 rounded-md border border-zinc-200 bg-white px-4 py-3 text-sm font-semibold">
          <Loader2 className="animate-spin" size={17} aria-hidden />
          Caricamento onboarding
        </div>
      </main>
    );
  }

  if (!state || !currentStep) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#eef3fb] text-[#09111f]">
        <div className="max-w-md rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
          <p className="font-semibold">Onboarding non disponibile.</p>
          {message ? <p className="mt-2 text-sm text-zinc-600">{message}</p> : null}
          <Link className="mt-4 inline-flex h-10 items-center rounded-md bg-emerald-700 px-4 text-sm font-semibold text-white" href={`/${tenantSlug}/dashboard`}>
            Dashboard
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#eef3fb] text-[#09111f]">
      <div className="mx-auto grid min-h-screen max-w-7xl gap-4 px-4 py-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="rounded-md border border-zinc-200 bg-white p-4 shadow-sm">
          <Link className="text-lg font-semibold" href={`/${tenantSlug}/dashboard`}>Prenodo</Link>
          <p className="mt-1 text-sm text-zinc-600">{tenantSlug}</p>
          <div className="mt-5">
            <div className="flex items-center justify-between text-sm font-semibold">
              <span>Avanzamento</span>
              <span>{state.percent}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-100">
              <div className="h-full bg-emerald-600" style={{ width: `${state.percent}%` }} />
            </div>
          </div>
          <nav className="mt-5 space-y-1">
            {state.steps.map((step) => {
              const done = state.completedSteps.includes(step.key);
              const skipped = state.skippedSteps.includes(step.key);
              const active = step.key === activeStep;
              return (
                <button
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-semibold ${active ? "bg-[#123c33] text-white" : "text-zinc-700 hover:bg-zinc-100"}`}
                  key={step.key}
                  type="button"
                  onClick={() => setActiveStep(step.key)}
                >
                  <span className={`flex h-5 w-5 items-center justify-center rounded border ${done ? "border-emerald-600 bg-emerald-600 text-white" : skipped ? "border-amber-400 bg-amber-50 text-amber-800" : "border-zinc-300"}`}>
                    {done ? <Check size={13} aria-hidden /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{step.label}</span>
                  {active ? <ChevronRight size={15} aria-hidden /> : null}
                </button>
              );
            })}
          </nav>
        </aside>

        <section className="rounded-md border border-zinc-200 bg-white shadow-sm">
          <div className="border-b border-zinc-200 p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-700">Onboarding gestionale</p>
            <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h1 className="text-2xl font-semibold">{currentStep.title}</h1>
                <p className="mt-1 text-sm text-zinc-600">{isCompleted ? "Configurazione iniziale completata." : "Completa i dati iniziali del gestionale."}</p>
              </div>
              <Link className="inline-flex h-10 items-center justify-center rounded-md border border-zinc-200 px-4 text-sm font-semibold" href={`/${tenantSlug}/dashboard`}>
                Dashboard
              </Link>
            </div>
            {message ? (
              <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800">
                {message}
              </div>
            ) : null}
          </div>

          <StepForm
            data={state.data}
            saving={saving}
            step={activeStep}
            onComplete={() => submit("complete", {})}
            onSave={(payload) => submit("save_step", payload)}
            onSkip={() => submit("skip_step", {})}
          />
        </section>
      </div>
    </main>
  );
}

function StepForm({
  data,
  saving,
  step,
  onSave,
  onSkip,
  onComplete,
}: {
  data: OnboardingState["data"];
  saving: boolean;
  step: string;
  onSave: (payload: Record<string, string>) => void;
  onSkip: () => void;
  onComplete: () => void;
}) {
  const business = data.business ?? {};
  const location = data.location ?? {};
  const firstCategory = data.categories[0] ?? {};

  function submitForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const payload = Object.fromEntries(Array.from(form.entries()).map(([key, value]) => [key, String(value)]));
    onSave(payload);
  }

  return (
    <form className="p-5" onSubmit={submitForm}>
      <div className="grid gap-4 lg:grid-cols-2">
        {step === "business" ? (
          <>
            <Field label="Nome attivita" name="business_name" defaultValue={textValue(business.name)} required />
            <Field label="Sito web" name="website" defaultValue={textValue(business.website ?? business.quote_website)} />
            <Field label="Email pubblica" name="email" defaultValue={textValue(business.email)} />
            <Field label="Telefono pubblico" name="phone" defaultValue={textValue(business.phone)} />
            <TextArea label="Descrizione booking" name="booking_about_text" defaultValue={textValue(business.booking_about_text)} />
          </>
        ) : null}

        {step === "location" ? (
          <>
            <Field label="Nome sede" name="location_name" defaultValue={textValue(location.name)} required />
            <Field label="Indirizzo" name="address" defaultValue={textValue(location.address)} />
            <Field label="Citta" name="legal_city" defaultValue={textValue(location.legal_city)} />
            <Field label="Provincia" name="legal_province" defaultValue={textValue(location.legal_province)} />
            <Field label="CAP" name="legal_cap" defaultValue={textValue(location.legal_cap)} />
            <Field label="Telefono" name="phone" defaultValue={textValue(location.phone)} />
            <Field label="Email sede" name="email" defaultValue={textValue(location.email)} />
            <Field label="WhatsApp" name="whatsapp" defaultValue={textValue(location.whatsapp)} />
          </>
        ) : null}

        {step === "activity_categories" ? (
          <Field className="lg:col-span-2" label="Categorie attivita" name="activity_categories" defaultValue="centro estetico, beauty, benessere" required />
        ) : null}

        {step === "hours" ? (
          <>
            <Field label="Apertura lun-sab" name="opens" defaultValue="09:00" required />
            <Field label="Chiusura lun-sab" name="closes" defaultValue="19:00" required />
          </>
        ) : null}

        {step === "staff" ? (
          <>
            <Checkbox label="Lavoro da solo per ora" name="work_alone" />
            <Field label="Nome operatore" name="staff_name" defaultValue="" />
            <Field label="Email operatore" name="staff_email" defaultValue="" />
            <Field label="Telefono operatore" name="staff_phone" defaultValue="" />
          </>
        ) : null}

        {step === "cabins" ? (
          <>
            <Checkbox label="Non uso cabine" name="no_cabins" />
            <Field label="Nome cabina" name="cabin_name" defaultValue="Cabina 1" />
          </>
        ) : null}

        {step === "service_categories" ? (
          <Field label="Categoria servizi" name="category_name" defaultValue={textValue(firstCategory.name) || "Trattamenti viso"} required />
        ) : null}

        {step === "services" ? (
          <>
            <Field label="Nome servizio" name="service_name" defaultValue="Pulizia viso" required />
            <Field label="Durata minuti" name="duration_min" defaultValue="60" required />
            <Field label="Prezzo" name="price" defaultValue="50" required />
            {data.categories.length ? (
              <label className="block">
                <span className="mb-1 block text-sm font-semibold text-zinc-700">Categoria</span>
                <select className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none focus:border-[#123c33]" name="category_id" defaultValue={String(firstCategory.id ?? "")}>
                  {data.categories.map((category) => (
                    <option key={String(category.id)} value={String(category.id)}>{textValue(category.name)}</option>
                  ))}
                </select>
              </label>
            ) : null}
          </>
        ) : null}

        {step === "booking" ? (
          <>
            <Checkbox defaultChecked label="Booking pubblico attivo" name="booking_public_allowed" />
            <Checkbox defaultChecked label="Marketplace pubblico attivo" name="marketplace_public_allowed" />
          </>
        ) : null}
      </div>

      <div className="mt-6 flex flex-col gap-2 border-t border-zinc-200 pt-5 sm:flex-row sm:justify-between">
        <button className="h-10 rounded-md border border-zinc-200 px-4 text-sm font-semibold disabled:opacity-60" disabled={saving} type="button" onClick={onSkip}>
          Salta step
        </button>
        <div className="flex flex-col gap-2 sm:flex-row">
          <button className="h-10 rounded-md border border-zinc-200 px-4 text-sm font-semibold disabled:opacity-60" disabled={saving} type="button" onClick={onComplete}>
            Completa onboarding
          </button>
          <button className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#123c33] px-4 text-sm font-semibold text-white disabled:opacity-60" disabled={saving}>
            {saving ? <Loader2 className="animate-spin" size={16} aria-hidden /> : <Check size={16} aria-hidden />}
            Salva e continua
          </button>
        </div>
      </div>
    </form>
  );
}

function Field({
  className = "",
  defaultValue,
  label,
  name,
  required = false,
}: {
  className?: string;
  defaultValue: string;
  label: string;
  name: string;
  required?: boolean;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="mb-1 block text-sm font-semibold text-zinc-700">{label}</span>
      <input
        className="h-11 w-full rounded-md border border-zinc-200 px-3 text-sm outline-none focus:border-[#123c33]"
        defaultValue={defaultValue}
        name={name}
        required={required}
      />
    </label>
  );
}

function TextArea({ defaultValue, label, name }: { defaultValue: string; label: string; name: string }) {
  return (
    <label className="block lg:col-span-2">
      <span className="mb-1 block text-sm font-semibold text-zinc-700">{label}</span>
      <textarea
        className="min-h-28 w-full rounded-md border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-[#123c33]"
        defaultValue={defaultValue}
        name={name}
      />
    </label>
  );
}

function Checkbox({ defaultChecked = false, label, name }: { defaultChecked?: boolean; label: string; name: string }) {
  return (
    <label className="flex min-h-11 items-center gap-2 rounded-md border border-zinc-200 px-3 text-sm font-semibold text-zinc-700">
      <input name={name} type="hidden" value="0" />
      <input className="h-4 w-4" defaultChecked={defaultChecked} name={name} type="checkbox" value="1" />
      <span>{label}</span>
    </label>
  );
}

function textValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}
