"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP package_settings page (app/pages/package_settings.php,
// reached via index.php?page=packages&tab=settings -> page=package_settings):
// Packages default validity. Current values are pre-filled from the existing
// DB-backed /api/manage/configuration?module=package_settings route, which
// exposes them via the module records (record 1 "Validita predefinita"
// detail = "<value> <unit>", e.g. "0 days").

type ConfigRecord = {
  id: number;
  module: string;
  title: string;
  detail: string;
  value: string;
  active: boolean;
  updatedAt?: string;
};

type ConfigResponse = {
  ok?: boolean;
  records?: ConfigRecord[];
  module?: { records?: ConfigRecord[] };
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

export function PackageSettingsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [validityValue, setValidityValue] = useState("0");
  const [validityUnit, setValidityUnit] = useState("days");
  const [feedback, setFeedback] = useState<{ type: "success" | "danger"; text: string } | null>(null);

  const load = useCallback(() => {
    fetch(`/api/manage/configuration?module=package_settings&slug=${encodeURIComponent(slug)}`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: ConfigResponse) => {
        const records = j.records ?? j.module?.records ?? [];
        const validity = records.find((rec) => rec.id === 1);

        if (validity && typeof validity.detail === "string") {
          // detail is "<value> <unit>" e.g. "0 days".
          const parts = validity.detail.trim().split(/\s+/);
          const rawValue = parts[0] ?? "0";
          const rawUnit = parts[1] ?? "days";
          if (/^\d+$/.test(rawValue)) setValidityValue(rawValue);
          if (rawUnit === "days" || rawUnit === "months" || rawUnit === "years") {
            setValidityUnit(rawUnit);
          }
        }
      })
      .catch(() => {});
  }, [slug]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveValidity(): Promise<void> {
    setFeedback(null);
    try {
      const res = await fetch(`/api/manage/configuration?module=package_settings&slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({
          slug,
          module: "package_settings",
          action: "save_package_validity_default",
          package_default_validity_value: validityValue,
          package_default_validity_unit: validityUnit,
        }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j?.ok === false) {
        setFeedback({ type: "danger", text: String(j?.error ?? j?.message ?? "Errore.") });
        return;
      }
      setFeedback({ type: "success", text: String(j?.message ?? "Impostazioni scadenza Pacchetti salvate. I pacchetti gia presenti rimarranno invariati.") });
      if (typeof window !== "undefined") window.scrollTo(0, 0);
      load();
    } catch {
      setFeedback({ type: "danger", text: "Errore di rete." });
    }
  }

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/package_settings.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Gestione pacchetti e sedute</div>
          <h1 className="bs-page-title">Pacchetti / Impostazioni</h1>
          <div className="bs-page-subtitle">Configura validita e impostazioni predefinite dei pacchetti.</div>
        </div>
        <div className="bs-page-actions">
          <a className="btn btn-outline-secondary btn-pill" href={`/${encodeURIComponent(slug)}/packages`}>
            <i className="bi bi-arrow-left me-1" />
            Pacchetti
          </a>
        </div>
      </div>

      {feedback ? (
        <div className={`alert alert-${feedback.type} d-flex align-items-start gap-2`} role="alert">
          <div>
            <i className="bi bi-info-circle" />
          </div>
          <div>{feedback.text}</div>
        </div>
      ) : null}

      <div className="row g-3">
        <div className="col-lg-8">
          <div className="card p-4">
            <div className="h5 fw-bold mb-3">Pacchetti - Scadenza predefinita</div>
            <div className="text-muted small mb-3">
              Quando vendi o assegni un <strong>pacchetto</strong> e lasci vuoto il campo <em>&quot;Valido al&quot;</em>,
              la scadenza viene calcolata automaticamente partendo da <em>&quot;Valido dal&quot;</em>. La validita impostata
              nel singolo pacchetto catalogo ha sempre priorita. Imposta qui la durata predefinita: <strong>0</strong>{" "}
              significa nessuna scadenza automatica.
            </div>

            <form
              method="post"
              className="border rounded-3 p-3 bg-light"
              onSubmit={(e) => {
                e.preventDefault();
                saveValidity();
              }}
            >
              <input type="hidden" name="action" value="save_package_validity_default" />

              <div className="row g-3 package-settings-validity-row">
                <div className="col-md-6">
                  <label className="form-label">Durata</label>
                  <input
                    className="form-control"
                    type="number"
                    min={0}
                    max={36500}
                    name="package_default_validity_value"
                    placeholder="0"
                    value={validityValue}
                    onChange={(e) => setValidityValue(e.target.value)}
                  />
                  <div className="form-text">0 = nessuna scadenza automatica</div>
                </div>
                <div className="col-md-6">
                  <label className="form-label">Unita</label>
                  <select
                    className="form-select"
                    name="package_default_validity_unit"
                    value={validityUnit}
                    onChange={(e) => setValidityUnit(e.target.value)}
                  >
                    <option value="days">Giorni</option>
                    <option value="months">Mesi</option>
                    <option value="years">Anni</option>
                  </select>
                </div>
              </div>

              <div className="mt-3 d-flex gap-2">
                <button className="btn btn-primary btn-pill" type="submit">
                  <i className="bi bi-check2-circle me-1" />
                  Salva Pacchetti
                </button>
              </div>
            </form>
          </div>
        </div>

        <div className="col-lg-4">
          <div className="package-settings-info-box">
            <div className="package-settings-info-box__icon" aria-hidden="true">
              <i className="bi bi-info-circle" />
            </div>
            <div className="package-settings-info-box__body">
              <div className="package-settings-info-box__title">Come funziona</div>
              <ul className="package-settings-info-box__list mb-0">
                <li>
                  <strong>Valido dal</strong> resta modificabile in vendita o assegnazione.
                </li>
                <li>
                  Se <strong>Valido al</strong> e vuoto, viene calcolato usando questa durata.
                </li>
                <li>La validita del catalogo pacchetti, se presente, ha priorita.</li>
                <li>I pacchetti gia venduti o assegnati non vengono modificati.</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
