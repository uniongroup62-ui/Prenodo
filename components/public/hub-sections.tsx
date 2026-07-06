"use client";

import Link from "next/link";
import {
  CalendarDays,
  CreditCard,
  FileText,
  Gift,
  Heart,
  Loader2,
  Package,
  ShoppingBag,
  Star,
  Ticket,
  Wallet,
} from "lucide-react";

// Renderer fedeli delle sezioni "residui" dell'area cliente per-tenant legacy
// (booking.php public=1&<sezione>=1): Prenotazioni, Pacchetti, Prepagati,
// Credito, GiftCard, Omaggi, Fidelity, Preordini, Preventivi. Ogni item porta
// tenantSlug/tenantName perché la sorgente /api/account aggrega tutte le
// attività collegate; l'hub per-sede filtra sul singolo tenant. Estratti dal
// vecchio PublicAccountPage centralizzato (rimosso) per essere riusati dentro
// la shell booking-public-account (PerTenantHub).

// Port of booking.php mode=my_packages payload (+ tenant fields).
export type CustomerPackage = {
  id: number;
  tenantSlug: string;
  tenantName: string;
  packageName: string;
  serviceName: string;
  purchaseDate: string | null;
  expiresAt: string | null;
  sessionsTotal: number;
  sessionsRemaining: number;
  status: string;
  statusLabel: string;
  services: Array<{ serviceName: string; sessionsTotal: number; sessionsRemaining: number }>;
};

// Port of booking.php mode=my_quotes payload (+ tenant fields).
export type CustomerQuote = {
  id: number;
  tenantSlug: string;
  tenantName: string;
  number: string;
  quoteDate: string | null;
  validUntil: string | null;
  status: string;
  statusLabel: string;
  total: number;
  canRespond: boolean;
  customerDecisionAt: string | null;
};

// Port of booking.php mode=my_appointments payload (area cliente prenotazioni),
// plus tenantSlug/tenantName since the global account aggregates every linked
// activity. can_cancel/cancel_reason follow the tenant's cancel policy.
export type CustomerAppointment = {
  id: number;
  tenantSlug: string;
  tenantName: string;
  publicCode: string;
  startsAt: string;
  endsAt: string;
  status: string;
  statusLabel: string;
  services: string[];
  operators: string[];
  locationName: string;
  totalPrice: number;
  canCancel: boolean;
  cancelReason: string | null;
};

// Sezioni P3 (port of the tenant-panel views): Credito / GiftCard / Prepagati /
// Omaggi / Fidelity / Preordini — read-only, per linked activity.
export type CustomerCreditSection = {
  tenantSlug: string;
  tenantName: string;
  balance: number;
  movements: Array<{ date: string | null; amount: number; note: string }>;
};
export type CustomerGiftcard = {
  tenantSlug: string;
  tenantName: string;
  id: number;
  code: string;
  balance: number;
  expiresAt: string | null;
  statusLabel: string;
};
export type CustomerPrepaid = {
  tenantSlug: string;
  tenantName: string;
  id: number;
  serviceId: number;
  serviceName: string;
  remainingQty: number;
  purchasedQty: number;
  unitPrice: number;
  totalPaid: number;
  purchaseDate: string | null;
  expiresAt: string | null;
  statusLabel: string;
};
export type CustomerGiftBookableService = { serviceId: number; serviceName: string; rewardItemIndex: number };
export type CustomerGift = {
  tenantSlug: string;
  tenantName: string;
  id: number;
  name: string;
  stateLabel: string;
  expiresAt: string | null;
  // Reward servizio ancora prenotabili: pulsante "Prenota" (deep-link book_omaggio).
  bookableServices?: CustomerGiftBookableService[];
};
export type CustomerFidelitySection = {
  tenantSlug: string;
  tenantName: string;
  points: number;
  cardCode: string;
  cardActive: boolean;
  movements: Array<{ date: string | null; kind: string; deltaPoints: number; note: string }>;
};
export type CustomerPreorder = {
  tenantSlug: string;
  tenantName: string;
  itemName: string;
  qty: number;
  lineTotal: number;
  statusLabel: string;
  saleDate: string | null;
  expiresAt: string | null;
};
export type SectionData = {
  credit: CustomerCreditSection[];
  giftcards: CustomerGiftcard[];
  prepaids: CustomerPrepaid[];
  gifts: CustomerGift[];
  fidelity: CustomerFidelitySection[];
  preorders: CustomerPreorder[];
};

// dd/mm/yyyy from a Y-m-d.
export function fmtYmdShared(v: string | null): string {
  const m = String(v ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}
export const fmtEuro = (n: number) => `€ ${n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const SECTION_BADGE: Record<string, string> = {
  Attivo: "bg-emerald-100 text-emerald-800",
  Attiva: "bg-emerald-100 text-emerald-800",
  Disponibile: "bg-emerald-100 text-emerald-800",
  Ordinato: "bg-sky-100 text-sky-800",
  Ritirato: "bg-zinc-200 text-zinc-600",
  Scaduto: "bg-amber-100 text-amber-800",
  Scaduta: "bg-amber-100 text-amber-800",
  Esaurito: "bg-zinc-200 text-zinc-600",
  Esaurita: "bg-zinc-200 text-zinc-600",
  Riscattato: "bg-zinc-200 text-zinc-600",
  Utilizzata: "bg-zinc-200 text-zinc-600",
  "In accumulo": "bg-sky-100 text-sky-800",
  Annullato: "bg-zinc-200 text-zinc-600",
  Annullata: "bg-zinc-200 text-zinc-600",
};
function SectionBadge({ label }: { label: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${SECTION_BADGE[label] ?? "bg-zinc-200 text-zinc-600"}`}>{label}</span>;
}
function SectionLoading({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-zinc-500">
      <Loader2 className="h-4 w-4 animate-spin" /> {text}
    </p>
  );
}
export function EmptyState({ icon: Icon, text, title }: { icon: typeof Heart; text: string; title: string }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center md:col-span-2">
      <Icon className="mx-auto text-zinc-400" size={26} aria-hidden />
      <h3 className="mt-3 font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-zinc-600">{text}</p>
    </div>
  );
}

export function AppointmentsView({
  appointments,
  loaded,
  busy,
  onCancel,
}: {
  appointments: CustomerAppointment[];
  loaded: boolean;
  busy: boolean;
  onCancel: (appt: CustomerAppointment) => void;
}) {
  const fmtDate = (sql: string) => {
    const m = sql.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}` : sql;
  };
  const fmtTime = (sql: string) => {
    const m = sql.match(/[T ](\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}` : "";
  };
  const money = (n: number) => n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const badgeClass = (status: string) =>
    status === "done"
      ? "bg-emerald-100 text-emerald-800"
      : status === "scheduled"
        ? "bg-sky-100 text-sky-800"
        : status === "pending"
          ? "bg-amber-100 text-amber-800"
          : "bg-zinc-200 text-zinc-600";

  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="text-2xl font-semibold">Le mie prenotazioni</h2>
      <div className="mt-4 grid gap-3">
        {!loaded ? (
          <p className="flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Caricamento prenotazioni...
          </p>
        ) : null}
        {loaded && appointments.map((appt) => (
          <article className="rounded-lg border border-zinc-200 p-4" key={`${appt.tenantSlug}:${appt.id}`}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold">{fmtDate(appt.startsAt)}{appt.endsAt ? ` - ${fmtTime(appt.endsAt)}` : ""}</h3>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${badgeClass(appt.status)}`}>{appt.statusLabel}</span>
                </div>
                <p className="mt-1 text-sm font-medium text-zinc-800">{appt.services.length ? appt.services.join(", ") : "Appuntamento"}</p>
                <p className="mt-1 text-sm text-zinc-600">
                  {appt.tenantName}
                  {appt.locationName ? ` • ${appt.locationName}` : ""}
                  {appt.operators.length ? ` • ${appt.operators.join(", ")}` : ""}
                </p>
                <p className="mt-1 text-sm text-zinc-500">
                  Totale: € {money(appt.totalPrice)}
                  {appt.publicCode ? ` • Codice: ${appt.publicCode}` : ""}
                </p>
                {!appt.canCancel && appt.cancelReason && (appt.status === "pending" || appt.status === "scheduled") ? (
                  <p className="mt-1 text-xs text-zinc-400">{appt.cancelReason}</p>
                ) : null}
              </div>
              <div className="flex flex-col gap-2 sm:items-end">
                {appt.publicCode ? (
                  <a
                    className="inline-flex h-9 items-center rounded-md border border-zinc-200 px-3 text-sm font-semibold"
                    href={`/api/account/ics?code=${encodeURIComponent(appt.publicCode)}`}
                  >
                    Aggiungi al calendario
                  </a>
                ) : null}
                {appt.canCancel ? (
                  <button
                    className="inline-flex h-9 items-center rounded-md border border-red-200 px-3 text-sm font-semibold text-red-700 disabled:opacity-60"
                    disabled={busy}
                    onClick={() => onCancel(appt)}
                    type="button"
                  >
                    Annulla
                  </button>
                ) : null}
              </div>
            </div>
          </article>
        ))}
        {loaded && !appointments.length ? (
          <EmptyState icon={CalendarDays} title="Nessuna prenotazione" text="Le prenotazioni effettuate nei centri collegati appariranno qui." />
        ) : null}
      </div>
    </section>
  );
}

// "I miei pacchetti" (port of the legacy customer-area packages list): package
// name, sessions remaining/total, expiry, status badge and the per-service rows
// of multi-service packages.
export function PackagesView({ packages, loaded }: { packages: CustomerPackage[]; loaded: boolean }) {
  const badgeClass = (status: string) =>
    status === "active"
      ? "bg-emerald-100 text-emerald-800"
      : status === "completed"
        ? "bg-zinc-200 text-zinc-600"
        : status === "expired"
          ? "bg-amber-100 text-amber-800"
          : "bg-zinc-200 text-zinc-600";
  const fmtYmd = (v: string | null) => {
    const m = String(v ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
  };
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="text-2xl font-semibold">I miei pacchetti</h2>
      <div className="mt-4 grid gap-3">
        {!loaded ? (
          <p className="flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Caricamento pacchetti...
          </p>
        ) : null}
        {loaded && packages.map((pkg) => (
          <article className="rounded-lg border border-zinc-200 p-4" key={`${pkg.tenantSlug}:${pkg.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold">{pkg.packageName || pkg.serviceName || `Pacchetto #${pkg.id}`}</h3>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${badgeClass(pkg.status)}`}>{pkg.statusLabel}</span>
            </div>
            <p className="mt-1 text-sm text-zinc-600">
              {pkg.tenantName}
              {pkg.purchaseDate ? ` • Acquistato il ${fmtYmd(pkg.purchaseDate)}` : ""}
              {pkg.expiresAt ? ` • Scade il ${fmtYmd(pkg.expiresAt)}` : ""}
            </p>
            <p className="mt-1 text-sm font-medium text-zinc-800">
              Sedute residue: {pkg.sessionsRemaining} / {pkg.sessionsTotal}
            </p>
            {pkg.services.length ? (
              <div className="mt-2 grid gap-1">
                {pkg.services.map((svc, index) => (
                  <p className="text-sm text-zinc-600" key={index}>
                    {svc.serviceName}: {svc.sessionsRemaining} / {svc.sessionsTotal}
                  </p>
                ))}
              </div>
            ) : null}
          </article>
        ))}
        {loaded && !packages.length ? (
          <EmptyState icon={Package} title="Nessun pacchetto" text="I pacchetti acquistati nei centri collegati appariranno qui." />
        ) : null}
      </div>
    </section>
  );
}

// "Prepagati" (port of the tenant-panel prepaids view) + the P2 deep-link
// "Prenota" (book_prepaid + service_id -> the booking wizard prefill).
export function PrepaidsView({ items }: { items?: CustomerPrepaid[] }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="text-2xl font-semibold">I miei prepagati</h2>
      <div className="mt-4 grid gap-3">
        {items === undefined ? <SectionLoading text="Caricamento prepagati..." /> : null}
        {(items ?? []).map((item) => {
          // Meta come il legacy (booking.php 10503-10510): Acquisto • Scadenza •
          // Totale pagato. Barra "Servizi utilizzati" used/purchased.
          const used = Math.max(0, item.purchasedQty - item.remainingQty);
          const meta = [
            item.purchaseDate ? `Acquisto: ${fmtYmdShared(item.purchaseDate)}` : "",
            item.expiresAt ? `Scadenza: ${fmtYmdShared(item.expiresAt)}` : "",
            `Totale pagato: ${fmtEuro(item.totalPaid)}`,
          ].filter(Boolean).join(" • ");
          return (
            <article className="rounded-lg border border-zinc-200 p-4" key={`${item.tenantSlug}:${item.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-semibold">{item.serviceName}</h3>
                <SectionBadge label={item.statusLabel} />
              </div>
              <p className="mt-1 text-sm text-zinc-600">{meta}</p>
              <p className="mt-1 text-sm font-medium text-zinc-800">
                Servizi utilizzati: {used} / {item.purchasedQty}
              </p>
              {item.statusLabel === "Attivo" && item.serviceId > 0 ? (
                <Link
                  className="mt-2 inline-flex items-center gap-1 rounded-full bg-emerald-600 px-3 py-1 text-sm font-semibold text-white hover:bg-emerald-700"
                  href={`/${encodeURIComponent(item.tenantSlug)}/booking?book_prepaid=${item.id}&service_id=${item.serviceId}`}
                >
                  <CalendarDays className="h-4 w-4" /> Prenota
                </Link>
              ) : null}
            </article>
          );
        })}
        {items !== undefined && !items.length ? (
          <EmptyState icon={Ticket} title="Nessun servizio prepagato" text="I servizi prepagati acquistati nei centri collegati appariranno qui." />
        ) : null}
      </div>
    </section>
  );
}

// "Credito" (port of the tenant-panel credit view): balance + wallet ledger.
export function CreditView({ items }: { items?: CustomerCreditSection[] }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="text-2xl font-semibold">Il mio credito</h2>
      <div className="mt-4 grid gap-3">
        {items === undefined ? <SectionLoading text="Caricamento credito..." /> : null}
        {(items ?? []).map((item) => (
          <article className="rounded-lg border border-zinc-200 p-4" key={item.tenantSlug}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-lg font-semibold">{item.tenantName}</h3>
              <span className="text-lg font-semibold text-emerald-700">{fmtEuro(item.balance)}</span>
            </div>
            {item.movements.length ? (
              <div className="mt-2 grid gap-1">
                {item.movements.map((movement, index) => (
                  <p className="text-sm text-zinc-600" key={index}>
                    {movement.date ? `${fmtYmdShared(movement.date)} • ` : ""}
                    <span className={movement.amount >= 0 ? "text-emerald-700" : "text-red-700"}>
                      {movement.amount >= 0 ? "+" : "-"} {fmtEuro(Math.abs(movement.amount))}
                    </span>
                    {movement.note ? ` • ${movement.note}` : ""}
                  </p>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-sm text-zinc-500">Nessun movimento registrato.</p>
            )}
          </article>
        ))}
        {items !== undefined && !items.length ? (
          <EmptyState icon={Wallet} title="Nessun credito" text="Il credito disponibile nei centri collegati apparirà qui." />
        ) : null}
      </div>
    </section>
  );
}

// "GiftCard" (port of the tenant-panel giftcards view).
export function GiftcardsView({ items }: { items?: CustomerGiftcard[] }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="text-2xl font-semibold">Le mie GiftCard</h2>
      <div className="mt-4 grid gap-3">
        {items === undefined ? <SectionLoading text="Caricamento GiftCard..." /> : null}
        {(items ?? []).map((item) => (
          <article className="rounded-lg border border-zinc-200 p-4" key={`${item.tenantSlug}:${item.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-lg font-semibold">GiftCard {item.code}</h3>
              <SectionBadge label={item.statusLabel} />
            </div>
            <p className="mt-1 text-sm text-zinc-600">
              {item.tenantName}
              {item.expiresAt ? ` • Scade il ${fmtYmdShared(item.expiresAt)}` : ""}
            </p>
            <p className="mt-1 text-sm font-medium text-zinc-800">Saldo: {fmtEuro(item.balance)}</p>
          </article>
        ))}
        {items !== undefined && !items.length ? (
          <EmptyState icon={CreditCard} title="Nessuna GiftCard" text="Le GiftCard a te intestate nei centri collegati appariranno qui." />
        ) : null}
      </div>
    </section>
  );
}

// "Omaggi" (port of the tenant-panel gifts view): gift instances + legacy state.
export function GiftsView({ items }: { items?: CustomerGift[] }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="text-2xl font-semibold">I miei omaggi</h2>
      <div className="mt-4 grid gap-3">
        {items === undefined ? <SectionLoading text="Caricamento omaggi..." /> : null}
        {(items ?? []).map((item) => {
          const bookable = item.bookableServices ?? [];
          return (
            <article className="rounded-lg border border-zinc-200 p-4" key={`${item.tenantSlug}:${item.id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-semibold">{item.name}</h3>
                <SectionBadge label={item.stateLabel} />
              </div>
              <p className="mt-1 text-sm text-zinc-600">
                {item.tenantName}
                {item.expiresAt ? ` • Scade il ${fmtYmdShared(item.expiresAt)}` : ""}
              </p>
              {bookable.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {bookable.map((svc) => (
                    <Link
                      key={`${svc.rewardItemIndex}:${svc.serviceId}`}
                      className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-3 py-1 text-sm font-semibold text-white hover:bg-emerald-700"
                      href={`/${encodeURIComponent(item.tenantSlug)}/booking?book_omaggio=${item.id}&service_id=${svc.serviceId}&reward_item_index=${svc.rewardItemIndex}`}
                    >
                      <CalendarDays className="h-4 w-4" /> {bookable.length === 1 ? "Prenota" : `Prenota ${svc.serviceName}`}
                    </Link>
                  ))}
                </div>
              ) : null}
            </article>
          );
        })}
        {items !== undefined && !items.length ? (
          <EmptyState icon={Gift} title="Nessun omaggio" text="Gli omaggi maturati nei centri collegati appariranno qui." />
        ) : null}
      </div>
    </section>
  );
}

// "Fidelity" (port of the tenant-panel fidelity view): points, card, movements.
export function FidelityView({ items }: { items?: CustomerFidelitySection[] }) {
  const kindLabel = (kind: string) =>
    kind === "earn" ? "Accumulo" : kind === "redeem" ? "Utilizzo" : kind === "adjust" ? "Rettifica" : "Movimento";
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="text-2xl font-semibold">Fidelity</h2>
      <div className="mt-4 grid gap-3">
        {items === undefined ? <SectionLoading text="Caricamento Fidelity..." /> : null}
        {(items ?? []).map((item) => (
          <article className="rounded-lg border border-zinc-200 p-4" key={item.tenantSlug}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-lg font-semibold">{item.tenantName}</h3>
              <span className="text-lg font-semibold text-emerald-700">{item.points} Punti</span>
            </div>
            {item.cardCode ? (
              <p className="mt-1 text-sm text-zinc-600">
                Tessera {item.cardCode} {item.cardActive ? "• attiva" : "• non attiva"}
              </p>
            ) : (
              <p className="mt-1 text-sm text-zinc-500">Nessuna tessera attiva.</p>
            )}
            {item.movements.length ? (
              <div className="mt-2 grid gap-1">
                {item.movements.map((movement, index) => (
                  <p className="text-sm text-zinc-600" key={index}>
                    {movement.date ? `${fmtYmdShared(movement.date)} • ` : ""}
                    {kindLabel(movement.kind)} •{" "}
                    <span className={movement.deltaPoints >= 0 ? "text-emerald-700" : "text-red-700"}>
                      {movement.deltaPoints >= 0 ? "+" : ""}
                      {movement.deltaPoints} punti
                    </span>
                    {movement.note ? ` • ${movement.note}` : ""}
                  </p>
                ))}
              </div>
            ) : null}
          </article>
        ))}
        {items !== undefined && !items.length ? (
          <EmptyState icon={Star} title="Nessun programma Fidelity" text="I punti Fidelity maturati nei centri collegati appariranno qui." />
        ) : null}
      </div>
    </section>
  );
}

// "Preordini" (port of booking.php 10548-10620): product preorders from sales.
export function PreordersView({ items }: { items?: CustomerPreorder[] }) {
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="text-2xl font-semibold">I miei preordini</h2>
      <div className="mt-4 grid gap-3">
        {items === undefined ? <SectionLoading text="Caricamento preordini..." /> : null}
        {(items ?? []).map((item, index) => (
          <article className="rounded-lg border border-zinc-200 p-4" key={`${item.tenantSlug}:${index}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-semibold">{item.itemName}</h3>
                <SectionBadge label={item.statusLabel} />
              </div>
              {item.lineTotal > 0 ? <span className="text-sm font-semibold text-zinc-800">{fmtEuro(item.lineTotal)} totale</span> : null}
            </div>
            <p className="mt-1 text-sm text-zinc-600">
              {item.tenantName}
              {item.saleDate ? ` • Ordinato il ${fmtYmdShared(item.saleDate)}` : ""}
              {item.expiresAt ? ` • Ritiro entro il ${fmtYmdShared(item.expiresAt)}` : ""}
            </p>
            {/* Quantità come il legacy (fmt_money): 2 decimali it-IT. */}
            <p className="mt-1 text-sm font-medium text-zinc-800">Quantità: {item.qty.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
          </article>
        ))}
        {items !== undefined && !items.length ? (
          <EmptyState icon={ShoppingBag} title="Nessun preordine" text="I prodotti ordinati nei centri collegati appariranno qui." />
        ) : null}
      </div>
    </section>
  );
}

// "I miei preventivi" (port of the legacy customer-area quotes list): number,
// dates, total, status badge and Accetta/Rifiuta while the quote is 'sent'.
export function QuotesView({
  quotes,
  loaded,
  busy,
  onDecision,
}: {
  quotes: CustomerQuote[];
  loaded: boolean;
  busy: boolean;
  onDecision: (quote: CustomerQuote, decision: "accept" | "reject") => void;
}) {
  const badgeClass = (status: string) =>
    status === "accepted" || status === "paid"
      ? "bg-emerald-100 text-emerald-800"
      : status === "sent"
        ? "bg-sky-100 text-sky-800"
        : status === "expired"
          ? "bg-amber-100 text-amber-800"
          : "bg-zinc-200 text-zinc-600";
  const fmtYmd = (v: string | null) => {
    const m = String(v ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
  };
  const money = (n: number) => n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <section className="rounded-lg border border-zinc-200 bg-white p-5">
      <h2 className="text-2xl font-semibold">I miei preventivi</h2>
      <div className="mt-4 grid gap-3">
        {!loaded ? (
          <p className="flex items-center gap-2 text-sm text-zinc-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Caricamento preventivi...
          </p>
        ) : null}
        {loaded && quotes.map((quote) => (
          <article className="rounded-lg border border-zinc-200 p-4" key={`${quote.tenantSlug}:${quote.id}`}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold">Preventivo {quote.number || `#${quote.id}`}</h3>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${badgeClass(quote.status)}`}>{quote.statusLabel}</span>
                </div>
                <p className="mt-1 text-sm text-zinc-600">
                  {quote.tenantName}
                  {quote.quoteDate ? ` • Data: ${fmtYmd(quote.quoteDate)}` : ""}
                  {quote.validUntil ? ` • Valido fino al ${fmtYmd(quote.validUntil)}` : ""}
                </p>
                <p className="mt-1 text-sm font-medium text-zinc-800">Totale: € {money(quote.total)}</p>
                {quote.customerDecisionAt ? (
                  <p className="mt-1 text-xs text-zinc-400">Risposto il {fmtYmd(quote.customerDecisionAt)}</p>
                ) : null}
              </div>
              {quote.canRespond ? (
                <div className="flex flex-col gap-2 sm:items-end">
                  <button
                    className="inline-flex h-9 items-center rounded-md bg-emerald-600 px-3 text-sm font-semibold text-white disabled:opacity-60"
                    disabled={busy}
                    onClick={() => onDecision(quote, "accept")}
                    type="button"
                  >
                    Accetta
                  </button>
                  <button
                    className="inline-flex h-9 items-center rounded-md border border-red-200 px-3 text-sm font-semibold text-red-700 disabled:opacity-60"
                    disabled={busy}
                    onClick={() => onDecision(quote, "reject")}
                    type="button"
                  >
                    Rifiuta
                  </button>
                </div>
              ) : null}
            </div>
          </article>
        ))}
        {loaded && !quotes.length ? (
          <EmptyState icon={FileText} title="Nessun preventivo" text="I preventivi ricevuti dai centri collegati appariranno qui." />
        ) : null}
      </div>
    </section>
  );
}
