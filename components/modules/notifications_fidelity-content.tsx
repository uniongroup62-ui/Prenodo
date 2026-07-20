"use client";

import { useCallback, useEffect, useState } from "react";

// Pagina dedicata "Tessere Fidelity in scadenza / scadute" (deviazione
// approvata 20/07): la sezione esce dal hub notifiche e diventa una pagina
// del gruppo Fidelizzazione, sul modello di notifications_installments —
// card per GRUPPO (titolo + badge + testo + date_label + Anteprima fino a
// 25 righe + "…e altre N") via /api/manage/notifications?action=
// fidelity_groups; la finestra si configura in Impostazioni tessera Fidelity.

type PreviewRow = { clientName: string; cardCode: string; expiresLabel: string; statusLabel: string; clientEmail: string };
type Group = {
  key: string;
  kind: "danger" | "warning" | "info";
  title: string;
  text: string;
  link: string;
  count: number;
  badgeClass: string;
  dateLabel: string;
  previewRows: PreviewRow[];
  linesMore: number;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

export function NotificationsFidelityContent({ slug: slugProp }: { slug?: string } = {}) {
  const slug = slugProp || tenantSlug();
  const [groups, setGroups] = useState<Group[]>([]);
  const [canSee, setCanSee] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [schemaOk, setSchemaOk] = useState(true);
  const [sectionText, setSectionText] = useState("");
  const [emptyText, setEmptyText] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    fetch(`/api/manage/notifications?slug=${encodeURIComponent(slug)}&action=fidelity_groups`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j) => {
        if (!j?.ok) return;
        setGroups(Array.isArray(j.groups) ? j.groups : []);
        setCanSee(Boolean(j.canSee));
        setEnabled(Boolean(j.enabled));
        setSchemaOk(Boolean(j.schemaOk));
        setSectionText(String(j.sectionText ?? ""));
        setEmptyText(String(j.emptyText ?? ""));
      })
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  const membershipHref = `/${encodeURIComponent(slug)}/fidelity_membership`;
  const settingsHref = `/${encodeURIComponent(slug)}/fidelity_membership_settings`;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/notifications_cards.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Fidelity / Adesione</div>
          <h1 className="bs-page-title">Tessere Fidelity in scadenza / scadute</h1>
          <div className="bs-page-subtitle">{sectionText}</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex flex-wrap justify-content-end gap-2">
            <a className="btn btn-outline-secondary btn-sm" href={settingsHref}>
              <i className="bi bi-gear me-1" />
              Impostazioni tessera
            </a>
            <a className="btn btn-outline-primary btn-sm" href={membershipHref}>
              <i className="bi bi-person-check me-1" />
              Apri Fidelity / Adesione
            </a>
          </div>
        </div>
      </div>

      {!canSee ? (
        <div className="card p-4">
          <div className="fw-semibold">Permesso non disponibile.</div>
          <div className="text-muted small mt-1">Serve il permesso Fidelity / Adesione per vedere le tessere.</div>
        </div>
      ) : !schemaOk ? (
        <div className="card p-4">
          <div className="fw-semibold">Tessere Fidelity non disponibili.</div>
          <div className="text-muted small mt-1">Importa il dump SQL completo aggiornato per vedere le notifiche di scadenza.</div>
        </div>
      ) : !enabled ? (
        <div className="card p-4">
          <div className="fw-semibold">Notifiche tessere disattivate.</div>
          <div className="text-muted small mt-1">
            Attiva il rinnovo automatico oppure il promemoria di scadenza in{" "}
            <a href={settingsHref}>Impostazioni tessera Fidelity</a> per vedere qui le tessere in scadenza.
          </div>
        </div>
      ) : groups.length === 0 ? (
        <div className="card p-4">
          <div className="fw-semibold">{loading ? "Caricamento…" : "Nessuna tessera in scadenza o scaduta."}</div>
          <div className="text-muted small mt-1">{emptyText}</div>
        </div>
      ) : (
        groups.map((group) => (
          <div className="card mb-3 notification-card" key={group.key}>
            <div className="d-flex flex-wrap">
              <div className={`p-3 flex-grow-1 notification-main notification-main--${group.kind}`}>
                <div className="d-flex align-items-center justify-content-between gap-2">
                  <div className="fw-bold fs-5 mb-1">{group.title}</div>
                  <span className={`badge ${group.badgeClass || "text-bg-info"}`}>{group.count}</span>
                </div>
                <div className="text-muted small">{group.text}</div>
                <div className="text-muted small mt-1">{group.dateLabel}</div>
              </div>
              <div className="p-3 flex-grow-1 notification-detail">
                <div className="text-muted small mb-1">Tessere</div>
                {(group.previewRows ?? []).map((row, i) => (
                  <div className="mb-2" key={i}>
                    <div className="fw-semibold">{row.clientName || "Cliente"}</div>
                    <div className="text-muted small">
                      Tessera #{row.cardCode} • {row.expiresLabel || "—"}
                      {row.statusLabel ? <> • {row.statusLabel}</> : null}
                    </div>
                    {row.clientEmail ? <div className="text-muted small">{row.clientEmail}</div> : null}
                  </div>
                ))}
                {group.linesMore > 0 ? <div className="text-muted small">…e altre {group.linesMore}</div> : null}
              </div>
              <div className="p-3 notification-action">
                <div className="d-grid gap-2">
                  <a className="btn btn-outline-primary btn-sm" href={group.link || membershipHref}>
                    <i className="bi bi-box-arrow-up-right me-1" />
                    Apri in Fidelity / Adesione
                  </a>
                </div>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
