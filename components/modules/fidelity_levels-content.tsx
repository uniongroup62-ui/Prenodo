"use client";

import { useEffect, useState } from "react";

// Faithful port of the PHP "Livelli Card" section (app/pages/fidelity_points.php#livelli-card,
// posting to index.php?page=fidelity_levels with _mode=save_levels). In the legacy app this card
// lives inside fidelity_points.php; the inline <form id="fidLevelsInlineForm"> hardcodes both
// fidelity_levels_enabled=1 and fidelity_levels_points_enabled=1 (saving from this card always
// keeps the levels + points families on). This component reproduces that markup VERBATIM
// (Bootstrap, bi bi-* icons, template) and wires it to the real endpoints:
//   - GET  /api/manage/fidelity?action=levels   -> { enabled, pointsEnabled, levels:[{key,name,minPoints}] }
//   - POST /api/manage/fidelity  action=save_levels + fidelity_levels_enabled/points_enabled + levels_json
// The base level (key 'base') is non-removable and locked to 0 points; only its name is editable.

type ApiLevel = { key: string; name: string; minPoints: number };
type LevelsResponse = {
  ok: boolean;
  levels?: { enabled: boolean; pointsEnabled: boolean; levels: ApiLevel[] };
  error?: string;
};

type Level = {
  key: string;
  name: string;
  points: string; // base level keeps "0" (locked); other levels show numeric points
  baseLevel: boolean;
};

function tenantSlug(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[1] || "";
}

// Levels shown until the API responds / for a never-configured tenant.
const DEFAULT_LEVELS: Level[] = [
  { key: "base", name: "Base", points: "0", baseLevel: true },
  { key: "silver", name: "Silver", points: "200", baseLevel: false },
  { key: "gold", name: "Gold", points: "500", baseLevel: false },
];

// Map the canonical persisted levels payload back to editable rows.
function toRows(apiLevels: ApiLevel[]): Level[] {
  return apiLevels.map((l) => ({
    key: l.key,
    name: l.name,
    points: l.key === "base" ? "0" : String(l.minPoints ?? 0),
    baseLevel: l.key === "base",
  }));
}

export function FidelityLevelsContent({ slug: slugProp, embedded = false }: { slug?: string; embedded?: boolean } = {}) {
  // Prop dal server preferita: il fallback window-only rende slug="" in SSR
  // e i link assoluti diventano protocol-relative rotti (//pagina).
  // embedded: renderizza SOLO il card Livelli Card (usato inline nella pagina
  // Punti come nel legacy, dove l'editor vive dentro fidelity_points.php).
  const slug = slugProp || tenantSlug();

  const [levels, setLevels] = useState<Level[]>(DEFAULT_LEVELS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  // Le key salvate sul server: servono per rilevare le eliminazioni e chiedere
  // la conferma legacy prima della cascata.
  const [savedKeys, setSavedKeys] = useState<string[]>([]);

  useEffect(() => {
    fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}&action=levels`, {
      headers: { "x-tenant-slug": slug },
    })
      .then((r) => r.json())
      .then((j: LevelsResponse) => {
        const apiLevels = j.levels?.levels ?? [];
        setLevels(apiLevels.length === 0 ? DEFAULT_LEVELS : toRows(apiLevels));
        setSavedKeys(apiLevels.map((l) => l.key));
      })
      .catch(() => setLevels(DEFAULT_LEVELS));
  }, [slug]);

  function pageHref(page: string, suffix = ""): string {
    return `/${encodeURIComponent(slug)}/${`${page}${suffix}`.replace("&", "?")}`;
  }

  function updateLevel(idx: number, patch: Partial<Level>) {
    setSaved(false);
    setLevels((prev) => prev.map((lvl, i) => (i === idx ? { ...lvl, ...patch } : lvl)));
  }

  function removeLevel(idx: number) {
    setSaved(false);
    setLevels((prev) => prev.filter((_, i) => i !== idx));
  }

  function addLevel() {
    setSaved(false);
    setLevels((prev) => [...prev, { key: "", name: "", points: "", baseLevel: false }]);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaved(false);

    // Conferma legacy: eliminare un livello aggiorna/disattiva a cascata le
    // campagne punti, le promozioni target-Fidelity e gli omaggi che lo usano.
    const currentKeys = new Set(levels.map((l) => l.key).filter(Boolean));
    const removed = savedKeys.filter((k) => !currentKeys.has(k));
    let deleteConfirmed = false;
    if (removed.length > 0) {
      deleteConfirmed = window.confirm(
        `Eliminare ${removed.length === 1 ? "il livello" : "i livelli"} "${removed.join('", "')}"? Le campagne punti, le promozioni e gli omaggi che lo usano verranno aggiornati o disattivati e i livelli dei clienti ricalcolati.`,
      );
      if (!deleteConfirmed) return;
    }

    setSaving(true);
    try {
      const levelsJson = JSON.stringify(
        levels.map((l) => ({
          key: l.key,
          name: l.name,
          minPoints: l.baseLevel ? 0 : Number(String(l.points).replace(",", ".")) || 0,
        })),
      );
      const res = await fetch(`/api/manage/fidelity?slug=${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: JSON.stringify({
          action: "save_levels",
          fidelity_levels_enabled: "1",
          fidelity_levels_points_enabled: "1",
          levels_json: levelsJson,
          ...(deleteConfirmed ? { fidelity_delete_confirmed: "1" } : {}),
        }),
      });
      const j: LevelsResponse = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !j.ok || !j.levels) {
        throw new Error(j.error || "Impossibile salvare i livelli.");
      }
      // Re-hydrate from the canonical persisted result (base ensured, sorted, deduped).
      setLevels(toRows(j.levels.levels));
      setSavedKeys(j.levels.levels.map((l) => l.key));
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Impossibile salvare i livelli.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={embedded ? "" : "container-fluid"}>
      {!embedded ? (
        <>
          <link rel="stylesheet" href="/assets/css/pages/fidelity_points.css" />

          <div className="bs-page-header">
            <div className="bs-page-heading">
              <div className="bs-page-kicker">Fidelity</div>
              <h1 className="bs-page-title">Livelli Card</h1>
              <div className="bs-page-subtitle">Definisci i livelli usati dalle campagne punti e dai vantaggi Fidelity.</div>
            </div>
            <div className="bs-page-actions">
              <a className="btn btn-light" href={`${pageHref("fidelity_points")}#livelli-card`}>
                <i className="bi bi-arrow-left" /> Punti
              </a>
            </div>
          </div>
        </>
      ) : null}

      <div className="card p-4 mt-3 fidCampaignsCard " id="livelli-card" data-levels-card="1">
        <form method="post" className="row g-3" id="fidLevelsInlineForm" onSubmit={handleSubmit}>
          <input type="hidden" name="_mode" value="save_levels" />
          <input type="hidden" name="return_page" value="fidelity_points" />
          <input type="hidden" name="fidelity_levels_enabled" value="1" />
          <input type="hidden" name="fidelity_levels_points_enabled" value="1" />

          <div className="col-12 d-flex flex-column flex-md-row justify-content-between align-items-md-center gap-3">
            <div>
              <div className="h5 fw-bold m-0">Livelli Card</div>
              <div className="text-muted small">Definisci i livelli usati dalle campagne punti e dai vantaggi Fidelity.</div>
            </div>
          </div>

          <div className="col-12">
            <div className={`alert alert-danger mb-0 ${error ? "" : "d-none"}`} id="fidLevelsInlineError" role="alert">
              {error}
            </div>
            {saved ? (
              <div className="alert alert-success mb-0 mt-2" role="alert">
                Livelli Card salvati
              </div>
            ) : null}
          </div>

          <div className="col-12">
            <div id="fidPointsLevelsList" className="d-flex flex-column gap-2">
              {levels.map((lvl, idx) => (
                <div
                  className="row g-2 align-items-end fidPointsLevelRow"
                  key={`${lvl.key}-${idx}`}
                  data-level-family="points"
                  data-level-key={lvl.key}
                  data-level-name={lvl.name}
                  data-base-level={lvl.baseLevel ? "1" : "0"}
                >
                  <input type="hidden" name="fidelity_points_level_keys[]" value={lvl.key} />

                  <div className="col-md-5">
                    <label className="form-label">Nome livello</label>
                    <input
                      className="form-control"
                      name="fidelity_points_level_names[]"
                      value={lvl.name}
                      placeholder="Es. Base"
                      onChange={(e) => updateLevel(idx, { name: e.target.value })}
                    />
                  </div>

                  {lvl.baseLevel ? (
                    <>
                      <input type="hidden" name="fidelity_points_level_points[]" value="0" />
                      <div className="col-md-7">
                        <div className="form-text text-muted mb-2">
                          Livello base predefinito: non eliminabile, punti bloccati a 0. Puoi modificare solo il nome.
                        </div>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="col-md-6">
                        <label className="form-label">Punti necessari</label>
                        <div className="input-group">
                          <input
                            className="form-control"
                            type="number"
                            min="0"
                            step="1"
                            name="fidelity_points_level_points[]"
                            value={lvl.points}
                            onChange={(e) => updateLevel(idx, { points: e.target.value })}
                          />
                          <span className="input-group-text">Punti</span>
                        </div>
                      </div>

                      <div className="col-md-1 d-grid">
                        <button
                          type="button"
                          className="btn btn-outline-danger btn-sm fidPointsLevelRemove"
                          title="Rimuovi"
                          onClick={() => removeLevel(idx)}
                        >
                          <i className="bi bi-x-lg" />
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>

            <template id="fidPointsLevelTpl">
              <div className="row g-2 align-items-end fidPointsLevelRow mt-2" data-level-family="points" data-level-key="" data-level-name="">
                <input type="hidden" name="fidelity_points_level_keys[]" value="" />
                <div className="col-md-5">
                  <label className="form-label">Nome livello</label>
                  <input className="form-control" name="fidelity_points_level_names[]" defaultValue="" placeholder="Es. Gold" />
                </div>
                <div className="col-md-6">
                  <label className="form-label">Punti necessari</label>
                  <div className="input-group">
                    <input
                      className="form-control"
                      type="number"
                      min="0"
                      step="1"
                      name="fidelity_points_level_points[]"
                      defaultValue=""
                      placeholder="Es. 200"
                    />
                    <span className="input-group-text">Punti</span>
                  </div>
                </div>
                <div className="col-md-1 d-grid">
                  <button type="button" className="btn btn-outline-danger btn-sm fidPointsLevelRemove" title="Rimuovi">
                    <i className="bi bi-x-lg" />
                  </button>
                </div>
              </div>
            </template>
          </div>

          <div className="col-12 d-flex flex-wrap gap-2">
            <button type="button" className="btn btn-outline-primary btn-sm" id="fidPointsLevelAdd" onClick={addLevel}>
              <i className="bi bi-plus-lg me-1" />
              Aggiungi livello
            </button>
            <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>
              <i className="bi bi-check2-circle me-1" />
              {saving ? "Salvataggio…" : "Salva livelli"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
