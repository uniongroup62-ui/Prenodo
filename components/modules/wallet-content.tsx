"use client";

import { useEffect, useState } from "react";

// Faithful port of the PHP wallet hub (app/pages/wallet.php): two nav tiles
// (Portafoglio Punti + Movimenti Credito). The Points tile follows the Fidelity
// state — hidden when the general Fidelity flag is off (with an info alert),
// shown disabled when Fidelity is on but points are off.
function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

export function WalletContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();
  const [globalEnabled, setGlobalEnabled] = useState(true);
  const [pointsEnabled, setPointsEnabled] = useState(true);

  useEffect(() => {
    fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}&action=points_settings`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        if (j?.settings) {
          setGlobalEnabled(j.settings.globalEnabled !== false);
          setPointsEnabled(j.settings.pointsEnabled !== false);
        }
      })
      .catch(() => undefined);
  }, [slug]);

  return (
    <div className="container-fluid">
      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Fidelizzazione</div>
          <h1 className="bs-page-title">Portafoglio</h1>
          <div className="bs-page-subtitle">Accedi ai portafogli credito e punti disponibili.</div>
        </div>
      </div>

      {!globalEnabled ? (
        <div className="alert alert-info">
          <div className="fw-semibold mb-1">
            <i className="bi bi-info-circle me-1" />
            Fidelity disattivata
          </div>
          <div className="small">
            Il programma Fidelity è disattivato nelle impostazioni generali. In questo riepilogo la sezione <strong>Portafoglio Punti</strong> non è disponibile. Puoi comunque usare <strong>Movimenti Credito</strong> e <strong>Ricariche</strong>. Vai su <a href={`/${encodeURIComponent(slug)}/fidelity`}>Fidelity → Impostazione generale</a> per attivare la funzione.
          </div>
        </div>
      ) : null}

      <div className="wallet-grid">
        {globalEnabled ? (
          pointsEnabled ? (
            <a className="wallet-tile tile-points" href={`/${encodeURIComponent(slug)}/fidelity_wallet`} aria-label="Apri Portafoglio Punti">
              <div className="chev" aria-hidden="true"><i className="bi bi-chevron-right" /></div>
              <div className="icon" aria-hidden="true"><i className="bi bi-award" /></div>
              <div className="title">Portafoglio Punti</div>
              <div className="desc">Saldo punti, movimenti e punti in sospeso.</div>
            </a>
          ) : (
            <div className="wallet-tile tile-points opacity-75" aria-label="Portafoglio Punti disattivato">
              <div className="icon" aria-hidden="true"><i className="bi bi-award" /></div>
              <div className="title">Portafoglio Punti</div>
              <div className="desc">Punti Fidelity disattivati. Riattivali da Fidelity → Punti.</div>
            </div>
          )
        ) : null}

        <a className="wallet-tile tile-credit" href={`/${encodeURIComponent(slug)}/credit_movements`} aria-label="Apri Movimenti Credito">
          <div className="chev" aria-hidden="true"><i className="bi bi-chevron-right" /></div>
          <div className="icon" aria-hidden="true"><i className="bi bi-wallet2" /></div>
          <div className="title">Movimenti Credito</div>
          <div className="desc">Ricariche, utilizzi, storni e credito in sospeso.</div>
        </a>
      </div>
    </div>
  );
}
