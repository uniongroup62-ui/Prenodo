"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP giftbox page (app/pages/giftbox.php).
type Row = Record<string, unknown>;

// Giftbox TEMPLATE row (giftbox.php tab=boxes). The box catalog the POS issues
// instances from. Surfaced as the "Template GiftBox" grid when ?tab=boxes.
type Template = { id: number; name: string; active: boolean; pointsCost: number; itemsCount: number };

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

function currentTab(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("tab") ?? "";
}

export function GiftboxContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [tab] = useState<string>(currentTab);
  const [items, setItems] = useState<Row[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [busyId, setBusyId] = useState(0);

  const loadTemplates = useCallback(() => {
    fetch(`/api/manage/giftboxes?slug=${encodeURIComponent(slug)}&action=templates`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => setTemplates(Array.isArray(j.templates) ? j.templates : []))
      .catch(() => setTemplates([]))
      .finally(() => setLoadingTemplates(false));
  }, [slug]);

  // Soft-delete a giftbox template via POST (issued instances keep their snapshot).
  async function deleteTemplate(t: Template) {
    if (busyId) return;
    if (typeof window !== "undefined" && !window.confirm("Eliminare questa GiftBox dal catalogo? Le GiftBox già emesse restano valide.")) return;
    setBusyId(t.id);
    try {
      const res = await fetch(`/api/manage/giftboxes?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({ action: "delete", id: t.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.error) {
        if (typeof window !== "undefined") window.alert(j?.error || "Impossibile eliminare la GiftBox.");
      } else {
        loadTemplates();
      }
    } finally {
      setBusyId(0);
    }
  }

  useEffect(() => {
    if (tab === "boxes") {
      loadTemplates();
      return;
    }
    fetch(`/api/manage/giftboxes?slug=${encodeURIComponent(slug)}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const list = j.giftboxes ?? j.instances ?? j.records ?? j.items ?? [];
        setItems(Array.isArray(list) ? list : []);
      })
      .catch(() => {});
  }, [slug, tab, loadTemplates]);

  const settingsHref = `/${encodeURIComponent(slug)}/giftbox_settings`;
  const boxesHref = `/${encodeURIComponent(slug)}/giftbox?tab=boxes`;

  // Template grid (giftbox.php tab=boxes): the box catalog + the editor entry
  // points (Nuova GiftBox / Modifica), wired to the faithful template editor.
  if (tab === "boxes") {
    return (
      <div className="container-fluid">
        <link rel="stylesheet" href="/assets/css/pages/giftbox.css" />

        <div className="bs-page-header">
          <div className="bs-page-heading">
            <div className="bs-page-kicker">Programma fedelta</div>
            <h1 className="bs-page-title">Fidelity / GiftBox</h1>
            <div className="bs-page-subtitle">Template GiftBox (contenuti + regole base).</div>
          </div>
          <div className="bs-page-actions">
            <div className="d-flex gap-2">
              <a className="btn btn-outline-secondary btn-pill" href={`/${encodeURIComponent(slug)}/giftbox`}>
                <i className="bi bi-arrow-left me-1" />
                GiftBox emesse
              </a>
              <a className="btn btn-primary btn-pill" href={`/${encodeURIComponent(slug)}/giftbox?action=new`}>
                <i className="bi bi-plus-circle me-1" />
                Nuova GiftBox
              </a>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="table-responsive">
            <table className="table mb-0 align-middle">
              <thead>
                <tr>
                  <th>Nome</th>
                  <th>Contenuti</th>
                  <th>Costo punti</th>
                  <th>Stato</th>
                  <th className="text-end">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {templates.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-muted small p-3">
                      {loadingTemplates ? "Caricamento…" : "Nessun template GiftBox."}
                    </td>
                  </tr>
                ) : (
                  templates.map((t) => (
                    <tr key={t.id}>
                      <td className="fw-semibold">{t.name || "—"}</td>
                      <td className="text-muted small">{t.itemsCount} elementi</td>
                      <td className="text-muted small">{t.pointsCost > 0 ? `${t.pointsCost} punti` : "—"}</td>
                      <td>
                        <span className={`badge ${t.active ? "text-bg-success" : "text-bg-secondary"}`}>
                          {t.active ? "Abilitata" : "Disabilitata"}
                        </span>
                      </td>
                      <td className="text-end">
                        <a
                          className="btn btn-sm btn-outline-primary"
                          href={`/${encodeURIComponent(slug)}/giftbox?action=edit&id=${t.id}`}
                        >
                          Modifica
                        </a>{" "}
                        <button
                          type="button"
                          className="btn btn-sm btn-outline-danger"
                          disabled={busyId === t.id}
                          onClick={() => deleteTemplate(t)}
                        >
                          Elimina
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/giftbox.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Programma fedelta</div>
          <h1 className="bs-page-title">Fidelity / GiftBox</h1>
          <div className="bs-page-subtitle">Gestisci template, voucher e GiftBox emesse.</div>
        </div>
        <div className="bs-page-actions">
          <div className="d-flex gap-2">
            <a className="btn btn-outline-secondary btn-pill" href={`/${encodeURIComponent(slug)}/fidelity`}>
              <i className="bi bi-arrow-left me-1" />
              Fidelity
            </a>
            <a className="btn btn-outline-secondary btn-pill" href={boxesHref}>
              <i className="bi bi-box-seam me-1" />
              Template GiftBox
            </a>
            <a className="btn btn-outline-secondary btn-pill" href={settingsHref}>
              <i className="bi bi-gear me-1" />
              Impostazioni
            </a>
          </div>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="card border-0 shadow-sm giftbox-empty-card">
          <div className="giftbox-empty-state">
            <div className="giftbox-empty-icon" aria-hidden="true">
              <i className="bi bi-gift" />
            </div>
            <h2>Nessuna GiftBox presente</h2>
            <p>
              Le GiftBox emesse da Pagamenti compariranno qui. Potrai monitorare mittente, destinatario,
              scadenze, riscatti e sede di emissione.
            </p>
            <div className="d-flex justify-content-center gap-2 flex-wrap">
              <a className="btn btn-primary" href={`/${encodeURIComponent(slug)}/pos`}>
                <i className="bi bi-plus-lg me-1" />
                Crea GiftBox
              </a>
              <a className="btn btn-outline-secondary" href={settingsHref}>
                <i className="bi bi-gear me-1" />
                Impostazioni
              </a>
            </div>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="table-responsive">
            <table className="table mb-0 align-middle">
              <thead>
                <tr>
                  <th>Codice</th>
                  <th>Destinatario</th>
                  <th>Stato</th>
                  <th>Scadenza</th>
                  <th className="text-end">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r, i) => (
                  <tr key={String(r.id ?? r.code ?? i)}>
                    <td className="fw-semibold">{String(r.code ?? r.id ?? "")}</td>
                    <td>{String(r.recipientName ?? r.recipient ?? "—")}</td>
                    <td>{String(r.status ?? "")}</td>
                    <td className="text-muted small">{String(r.expiresAt ?? r.expiry ?? "—")}</td>
                    <td className="text-end">
                      <a
                        className="btn btn-sm btn-outline-secondary"
                        href={`/${encodeURIComponent(slug)}/giftbox?action=view&id=${String(r.id ?? "")}`}
                      >
                        Apri
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
