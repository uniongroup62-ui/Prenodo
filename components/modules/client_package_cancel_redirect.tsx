"use client";

import { useEffect } from "react";
import { stashFlash } from "./flash";

// Port di packages.php action=client_cancel|client_delete: l'annullamento e
// l'eliminazione dei pacchetti cliente avvengono SOLO dal dettaglio vendita.
// Con una vendita collegata il redirect va a pos_sale_detail, altrimenti al
// dettaglio pacchetto (o alla lista), sempre con il messaggio verbatim.
export function ClientPackageCancelRedirect({ slug, action, id }: { slug: string; action?: string; id?: string }) {
  useEffect(() => {
    const cpId = Number.parseInt(String(id ?? ""), 10) || 0;
    const errMsg =
      action === "client_delete"
        ? "Il pacchetto non si elimina da Pacchetti. Usa il dettaglio vendita."
        : "Il pacchetto si annulla solo dal dettaglio vendita.";
    const base = `/${encodeURIComponent(slug)}`;
    // location.replace (non href): questa pagina-ponte non deve restare nella
    // history. Il flash viaggia in sessionStorage, URL puliti.
    const go = (url: string) => {
      stashFlash({ err: errMsg });
      window.location.replace(url);
    };
    if (cpId <= 0) {
      go(`${base}/packages?tab=clients`);
      return;
    }
    fetch(`/api/manage/packages?slug=${encodeURIComponent(slug)}&action=client_cancel_info&id=${cpId}`, { headers: { "x-tenant-slug": slug } })
      .then((r) => r.json())
      .then((j) => {
        const saleId = Number(j?.saleId ?? 0);
        if (saleId > 0) go(`${base}/pos_sale_detail?id=${saleId}`);
        else go(`${base}/packages?tab=clients&action=client_view&id=${cpId}`);
      })
      .catch(() => go(`${base}/packages?tab=clients`));
  }, [slug, action, id]);

  return <div className="card p-3 text-muted small m-3">Reindirizzamento…</div>;
}
