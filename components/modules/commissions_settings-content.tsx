"use client";

import { useCallback, useEffect, useState } from "react";

// Faithful port of the PHP commissions page (app/pages/commissions.php), SETTINGS tab
// ("Impostazioni operatori", ~611-739): the global module ENABLE/DISABLE card + the
// per-operator commission-rate table. Fed by the existing DB-backed
// /api/manage/commissions?action=settings route (getCommissionSettings); the module toggle
// posts action=save_module_settings and the rate table posts action=save_commission_settings
// with `rows` as a JSON STRING (the server flattens top-level body values, so a nested object
// would become "[object Object]" — see route.ts parseCommissionRows).

type CommissionCalculationMode = "paid_amount" | "list_price";

type CommissionStaffSetting = {
  staffId: number;
  name: string;
  email: string;
  isActive: boolean;
  isEnabled: boolean;
  calculationMode: CommissionCalculationMode;
  appointmentPercent: number;
  posProductPercent: number;
  posServicePercent: number;
  posOtherPercent: number;
  notes: string;
};

type CommissionSettings = {
  moduleEnabled: boolean;
  configuredRates: number;
  staff: CommissionStaffSetting[];
};

type SettingsResponse = {
  ok?: boolean;
  error?: string;
  settings?: CommissionSettings;
};

// The editable per-row fields (a subset of CommissionStaffSetting, all as strings for the inputs).
type RowState = {
  isEnabled: boolean;
  calculationMode: CommissionCalculationMode;
  appointmentPercent: string;
  posProductPercent: string;
  posServicePercent: string;
  posOtherPercent: string;
  notes: string;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// Seed the editable table state (a map keyed by staffId) from the API staff list.
function seedRows(staff: CommissionStaffSetting[]): Record<number, RowState> {
  const map: Record<number, RowState> = {};
  for (const s of staff) {
    map[s.staffId] = {
      isEnabled: s.isEnabled,
      calculationMode: s.calculationMode,
      appointmentPercent: String(s.appointmentPercent),
      posProductPercent: String(s.posProductPercent),
      posServicePercent: String(s.posServicePercent),
      posOtherPercent: String(s.posOtherPercent),
      notes: s.notes,
    };
  }
  return map;
}

export function CommissionsSettingsContent({ slug: slugProp }: { slug?: string } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  const slug = slugProp || tenantSlug();

  const [settings, setSettings] = useState<CommissionSettings>({ moduleEnabled: false, configuredRates: 0, staff: [] });
  const [rows, setRows] = useState<Record<number, RowState>>({});
  const [loading, setLoading] = useState(true);

  const [savingModule, setSavingModule] = useState(false);
  const [savingRates, setSavingRates] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  // Apply a fresh settings snapshot: store it and re-seed the editable table state.
  const applySettings = useCallback((s: CommissionSettings) => {
    setSettings(s);
    setRows(seedRows(s.staff));
  }, []);

  // Fetch puro (setState nei callback della Promise; loading è già true di default).
  const load = useCallback(() => {
    fetch(`/api/manage/commissions?slug=${encodeURIComponent(slug)}&action=settings`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: SettingsResponse) => {
        if (j.settings) applySettings(j.settings);
      })
      .catch(() => {
        /* keep defaults */
      })
      .finally(() => setLoading(false));
  }, [slug, applySettings]);

  useEffect(() => {
    load();
  }, [load]);

  function href(suffix: string): string {
    return `/${encodeURIComponent(slug)}/${`commissions${suffix}`.replace("&", "?")}`;
  }

  // POST a settings action; on success re-apply the returned settings snapshot.
  const postAction = useCallback(
    async (payload: Record<string, unknown>): Promise<SettingsResponse> => {
      try {
        const res = await fetch(`/api/manage/commissions?slug=${encodeURIComponent(slug)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify(payload),
        });
        const j = await res.json();
        return { ok: res.ok && j.ok !== false, error: j.error, settings: j.settings };
      } catch {
        return { ok: false, error: "Errore di rete." };
      }
    },
    [slug],
  );

  async function onSaveModule() {
    setError("");
    setSuccess("");
    setSavingModule(true);
    const enabled = settings.moduleEnabled;
    const j = await postAction({ action: "save_module_settings", module_enabled: enabled ? "1" : "0" });
    setSavingModule(false);
    if (!j.ok || !j.settings) {
      setError(String(j.error ?? "Errore nel salvataggio dello stato del modulo."));
      return;
    }
    applySettings(j.settings);
    // Flash verbatim legacy (redirect ?msg=..., dipende dallo stato salvato).
    setSuccess(enabled ? "Funzione Commissioni attivata" : "Funzione Commissioni disattivata");
  }

  async function onSaveRates() {
    setError("");
    setSuccess("");
    setSavingRates(true);
    // Build the rows map keyed by staffId with the editable fields (camelCase to match the
    // server's CommissionStaffSettingInput), then send it as a JSON STRING — the API flattens
    // top-level body values, so a nested object would arrive as "[object Object]".
    const map: Record<
      number,
      {
        isEnabled: boolean;
        calculationMode: string;
        appointmentPercent: string;
        posProductPercent: string;
        posServicePercent: string;
        posOtherPercent: string;
        notes: string;
      }
    > = {};
    for (const s of settings.staff) {
      const r = rows[s.staffId];
      if (!r) continue;
      map[s.staffId] = {
        isEnabled: r.isEnabled,
        calculationMode: r.calculationMode,
        appointmentPercent: r.appointmentPercent,
        posProductPercent: r.posProductPercent,
        posServicePercent: r.posServicePercent,
        posOtherPercent: r.posOtherPercent,
        notes: r.notes,
      };
    }
    const j = await postAction({ action: "save_commission_settings", rows: JSON.stringify(map) });
    setSavingRates(false);
    if (!j.ok || !j.settings) {
      setError(String(j.error ?? "Errore nel salvataggio delle impostazioni."));
      return;
    }
    applySettings(j.settings);
    // Flash verbatim legacy (redirect ?msg=...).
    setSuccess("Impostazioni commissioni salvate");
  }

  function updateRow(staffId: number, patch: Partial<RowState>) {
    setRows((prev) => ({ ...prev, [staffId]: { ...prev[staffId], ...patch } }));
  }

  const hasStaff = settings.staff.length > 0;

  return (
    <div className="container-fluid">
      <link rel="stylesheet" href="/assets/css/pages/commissions.css" />

      <div className="bs-page-header">
        <div className="bs-page-heading">
          <div className="bs-page-kicker">Operatori</div>
          <h1 className="bs-page-title">Commissioni</h1>
          <div className="bs-page-subtitle">
            Collegato a Pagamenti, Quick Booking e Booking. Gli appuntamenti entrano in commissione quando risultano Eseguiti.
          </div>
        </div>
        <div className="bs-page-actions">
          {settings.moduleEnabled ? (
            <span className="badge text-bg-success">Commissioni attive</span>
          ) : (
            <span className="badge text-bg-secondary">Commissioni disattivate</span>
          )}
        </div>
      </div>

      {/* Flash legacy (?msg/?err): subito dopo l'header, PRIMA dei tab. */}
      {success ? <div className="alert alert-success">{success}</div> : null}
      {error ? <div className="alert alert-danger">{error}</div> : null}

      <ul className="nav nav-tabs commissions-tabs mb-3">
        <li className="nav-item">
          <a className="nav-link " href={href("&tab=overview")}>
            <i className="bi bi-graph-up me-1" />
            Riepilogo
          </a>
        </li>
        <li className="nav-item">
          <a className="nav-link active" href={href("&tab=settings")}>
            <i className="bi bi-sliders me-1" />
            Impostazioni operatori
          </a>
        </li>
      </ul>

      <div className="card mb-3">
        <div className="card-body d-flex justify-content-between align-items-center gap-3 flex-wrap">
          <div>
            <div className="small text-muted mb-1">Impostazione generale</div>
            <div className="fw-semibold">Funzione Commissioni</div>
            <div className="small text-muted mt-1">
              Se disattivata, vendite e appuntamenti non generano nuovi movimenti commissione. Percentuali e storico restano
              invariati.
            </div>
          </div>
          <div className="d-flex align-items-center gap-3 flex-wrap">
            <div className="form-check form-switch m-0">
              <input
                className="form-check-input"
                type="checkbox"
                role="switch"
                id="commissionModuleEnabled"
                checked={settings.moduleEnabled}
                onChange={(e) => setSettings((prev) => ({ ...prev, moduleEnabled: e.target.checked }))}
              />
              <label className="form-check-label fw-semibold" htmlFor="commissionModuleEnabled">
                {settings.moduleEnabled ? "Attiva" : "Disattivata"}
              </label>
            </div>
            <button className="btn btn-primary" type="button" disabled={savingModule} onClick={onSaveModule}>
              <i className="bi bi-check2-circle me-1" />
              Salva stato
            </button>
          </div>
        </div>
      </div>

      <div className="card mb-3">
        <div className="card-body">
          <div className="small text-muted mb-2">Configurazione</div>
          <div className="fw-semibold">Commissioni per operatore</div>
          <div className="small text-muted mt-2">
            <strong>Appuntamenti</strong>: leggono automaticamente le prestazioni concluse da Quick Booking e Booking pubblico,
            in base all&rsquo;operatore assegnato.
            <br />
            <strong>Pagamenti</strong>: leggono l&rsquo;operatore che registra la vendita in cassa. Le righe POS vengono separate
            in <em>Prodotti</em>, <em>Servizi</em> e <em>Altre vendite</em>. Per ogni operatore puoi scegliere se calcolare la
            percentuale sull&rsquo;importo realmente pagato oppure sul prezzo di listino.
            <br />
            <strong>Riscatti</strong>: pacchetti, prepagati, GiftBox, GiftCard e omaggi non generano commissioni in fase di
            utilizzo su prenotazione.
          </div>
        </div>
      </div>

      <div className="card">
        <div className="table-responsive">
          <table className="table align-middle mb-0">
            <thead>
              <tr>
                <th>Operatore</th>
                <th className="text-center">Attiva</th>
                <th>Calcolo %</th>
                <th className="text-end">Appunt. %</th>
                <th className="text-end">POS Prod. %</th>
                <th className="text-end">POS Serv. %</th>
                <th className="text-end">POS Altre %</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {!hasStaff ? (
                <tr>
                  <td colSpan={8} className="text-muted p-3">
                    {loading ? "Caricamento…" : "Nessun operatore disponibile."}
                  </td>
                </tr>
              ) : (
                settings.staff.map((s) => {
                  const r = rows[s.staffId];
                  if (!r) return null;
                  return (
                    <tr key={s.staffId}>
                      <td>
                        <div className="fw-semibold">{s.name}</div>
                        <div className="text-muted small">
                          {s.email ? s.email : "Nessuna email"}
                          {!s.isActive ? " • Inattivo" : ""}
                        </div>
                      </td>
                      <td className="text-center">
                        <input
                          className="form-check-input"
                          type="checkbox"
                          checked={r.isEnabled}
                          onChange={(e) => updateRow(s.staffId, { isEnabled: e.target.checked })}
                        />
                      </td>
                      <td className="commissions-settings-mode-cell">
                        <select
                          className="form-select form-select-sm"
                          value={r.calculationMode}
                          onChange={(e) => updateRow(s.staffId, { calculationMode: e.target.value as CommissionCalculationMode })}
                        >
                          <option value="paid_amount">Importo pagato</option>
                          <option value="list_price">Prezzo di listino</option>
                        </select>
                      </td>
                      <td className="text-end commissions-settings-percent-cell">
                        <div className="input-group input-group-sm">
                          <input
                            className="form-control text-end"
                            type="number"
                            step="0.01"
                            min="0"
                            max="100"
                            value={r.appointmentPercent}
                            onChange={(e) => updateRow(s.staffId, { appointmentPercent: e.target.value })}
                          />
                          <span className="input-group-text">%</span>
                        </div>
                      </td>
                      <td className="text-end commissions-settings-percent-cell">
                        <div className="input-group input-group-sm">
                          <input
                            className="form-control text-end"
                            type="number"
                            step="0.01"
                            min="0"
                            max="100"
                            value={r.posProductPercent}
                            onChange={(e) => updateRow(s.staffId, { posProductPercent: e.target.value })}
                          />
                          <span className="input-group-text">%</span>
                        </div>
                      </td>
                      <td className="text-end commissions-settings-percent-cell">
                        <div className="input-group input-group-sm">
                          <input
                            className="form-control text-end"
                            type="number"
                            step="0.01"
                            min="0"
                            max="100"
                            value={r.posServicePercent}
                            onChange={(e) => updateRow(s.staffId, { posServicePercent: e.target.value })}
                          />
                          <span className="input-group-text">%</span>
                        </div>
                      </td>
                      <td className="text-end commissions-settings-percent-cell">
                        <div className="input-group input-group-sm">
                          <input
                            className="form-control text-end"
                            type="number"
                            step="0.01"
                            min="0"
                            max="100"
                            value={r.posOtherPercent}
                            onChange={(e) => updateRow(s.staffId, { posOtherPercent: e.target.value })}
                          />
                          <span className="input-group-text">%</span>
                        </div>
                      </td>
                      <td className="commissions-settings-notes-cell">
                        <input
                          className="form-control form-control-sm"
                          type="text"
                          maxLength={255}
                          value={r.notes}
                          placeholder="Es. senior, vendita retail..."
                          onChange={(e) => updateRow(s.staffId, { notes: e.target.value })}
                        />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="card-body d-flex gap-2 flex-wrap">
          <button className="btn btn-primary" type="button" disabled={savingRates || !hasStaff} onClick={onSaveRates}>
            <i className="bi bi-check2-circle me-1" />
            Salva impostazioni
          </button>
          {/* Ricarica legacy: anchor alla pagina settings (ricarica pulita). */}
          <a className="btn btn-outline-secondary" href={href("&tab=settings")}>
            Ricarica
          </a>
        </div>
      </div>
    </div>
  );
}
